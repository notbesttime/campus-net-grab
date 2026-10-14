'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planHeartbeatTick, DEFAULTS } = require('../lib/lifecycle.js');

const T0 = 1_000_000_000_000; // 固定基准，避免依赖真实时钟

function st(over = {}) {
  return { startedAt: T0, lastAliveAt: 0, goodbyeAt: 0, everAlive: false, ...over };
}

test('启动器托管（managed）时永不因页面关闭而自退', () => {
  // 即使页面早就没心跳、且已经 goodbye 很久，也不退
  const r = planHeartbeatTick(
    st({ everAlive: true, lastAliveAt: T0, goodbyeAt: T0 }),
    T0 + 10 * 60 * 1000,
    5000,
    { managed: true }
  );
  assert.equal(r.exit, false);
  assert.equal(r.reason, 'managed');
});

test('托管时「一直没人打开控制台」也不退', () => {
  const r = planHeartbeatTick(st(), T0 + 10 * 60 * 1000, 5000, { managed: true });
  assert.equal(r.exit, false);
});

test('非托管：启动后一直没人来，超过 noClientExitMs 才退', () => {
  const before = planHeartbeatTick(st(), T0 + DEFAULTS.noClientExitMs - 1, 5000);
  assert.equal(before.exit, false);
  const after = planHeartbeatTick(st(), T0 + DEFAULTS.noClientExitMs + 1, 5000);
  assert.equal(after.exit, true);
  assert.equal(after.reason, 'no-client');
});

test('非托管：页面心跳超时（away）→ 退', () => {
  const alive = planHeartbeatTick(
    st({ everAlive: true, lastAliveAt: T0 }),
    T0 + DEFAULTS.heartbeatTimeoutMs - 1000, 5000
  );
  assert.equal(alive.exit, false, '还没超时不应退');
  const away = planHeartbeatTick(
    st({ everAlive: true, lastAliveAt: T0 }),
    T0 + DEFAULTS.heartbeatTimeoutMs + 1000, 5000
  );
  assert.equal(away.exit, true);
  assert.equal(away.reason, 'away');
});

test('非托管：goodbye 在宽限期内不退，过了宽限期才退', () => {
  const s = st({ everAlive: true, lastAliveAt: T0, goodbyeAt: T0 });
  const inGrace = planHeartbeatTick(s, T0 + DEFAULTS.goodbyeGraceMs - 1000, 5000);
  assert.equal(inGrace.exit, false, 'goodbye 宽限期内应容许刷新');
  const past = planHeartbeatTick(s, T0 + DEFAULTS.goodbyeGraceMs + 1000, 5000);
  assert.equal(past.exit, true);
  assert.equal(past.reason, 'goodbye');
});

test('休眠/冻结恢复：巡检间隔跳了一大截时给宽限，不误杀', () => {
  // 页面最后一次心跳已经"超时"，但本次巡检间隔 60s > suspendGapMs，说明机器睡过
  const s = st({ everAlive: true, lastAliveAt: T0 });
  const now = T0 + DEFAULTS.heartbeatTimeoutMs + 60 * 1000;
  const r = planHeartbeatTick(s, now, 60 * 1000);
  assert.equal(r.exit, false, '恢复后应先给一个心跳周期自证');
  // lastAliveAt 被前推到「刚好超时之前」
  assert.ok(now - r.lastAliveAt <= DEFAULTS.heartbeatTimeoutMs, 'lastAliveAt 已被前推');
});

test('休眠宽限不会无限续命：页面真的不在，下一轮仍会退', () => {
  const now1 = T0 + DEFAULTS.heartbeatTimeoutMs + 60 * 1000;
  const r1 = planHeartbeatTick(st({ everAlive: true, lastAliveAt: T0 }), now1, 60 * 1000);
  assert.equal(r1.exit, false);
  // 下一轮是正常 5s 间隔：宽限窗口已过，应判定 away
  const now2 = now1 + 5 * 1000 + DEFAULTS.heartbeatTimeoutMs;
  const r2 = planHeartbeatTick(
    st({ everAlive: true, lastAliveAt: r1.lastAliveAt }),
    now2, 5000
  );
  assert.equal(r2.exit, true);
  assert.equal(r2.reason, 'away');
});

test('纯函数：不改动入参 state', () => {
  const s = st({ everAlive: true, lastAliveAt: T0 });
  const snap = JSON.stringify(s);
  planHeartbeatTick(s, T0 + 10 * 60 * 1000, 60 * 1000);
  assert.equal(JSON.stringify(s), snap);
});

test('缺省字段容错：lastAliveAt/goodbyeAt 缺失按 0 处理', () => {
  const r = planHeartbeatTick(
    { startedAt: T0, everAlive: true },
    T0 + DEFAULTS.heartbeatTimeoutMs + 1, 5000
  );
  assert.equal(r.exit, true);
});