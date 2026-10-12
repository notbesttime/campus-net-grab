'use strict';
/* 自助登录互斥租约单测：在项目根目录运行  node --test
 *
 * 为什么需要这把锁：`self` 的 checkcode/cookie 是所有登录流程共享的，并发登录会互相
 * 覆盖 checkcode → 服务端静默弹回登录页（2026-10-11 实测）。这里用**假时钟**验证
 * 互斥、过期释放、以及「非持有者不能释放别人的租约」。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLease } = require('../lib/lease');

function fakeClock(t0 = 1000) {
  let t = t0;
  return { now: () => t, tick: ms => { t += ms; } };
}

test('acquire 成功后 occupied：第二次 acquire 在被占用期内失败', () => {
  const c = fakeClock();
  const L = createLease(c.now);
  assert.equal(L.acquire('connect', 1000), true);
  assert.equal(L.acquire('api', 1000), false, '租约期内别人拿不到');
  assert.equal(L.heldBy(), 'connect');
  assert.equal(L.remaining(), 1000);
});

test('租约到期后自动失效（不会死锁）', () => {
  const c = fakeClock();
  const L = createLease(c.now);
  L.acquire('connect', 1000);
  c.tick(999);
  assert.equal(L.acquire('api', 1000), false, '还差 1ms 仍被占');
  c.tick(1);
  assert.equal(L.heldBy(), '', '到期后无人持有');
  assert.equal(L.acquire('api', 1000), true, '过期后可被接管');
  assert.equal(L.heldBy(), 'api');
});

test('release 只有持有者本人有效，非持有者放不掉别人的租约', () => {
  const c = fakeClock();
  const L = createLease(c.now);
  L.acquire('connect', 1000);
  assert.equal(L.release('api'), false, 'api 不能释放 connect 的租约');
  assert.equal(L.heldBy(), 'connect', '租约仍在');
  assert.equal(L.release('connect'), true);
  assert.equal(L.heldBy(), '');
  assert.equal(L.remaining(), 0);
});

test('release 之后立即可被重新获取（连续两次登录不互相阻塞）', () => {
  const c = fakeClock();
  const L = createLease(c.now);
  assert.equal(L.acquire('connect', 5000), true);
  L.release('connect');
  assert.equal(L.acquire('connect', 5000), true, '释放后立刻可再拿');
});

test('ms 非法（NaN/负数/未传）视为 0：不占别人时间', () => {
  const c = fakeClock();
  const L = createLease(c.now);
  assert.equal(L.acquire('a', NaN), true);
  assert.equal(L.remaining(), 0);
  assert.equal(L.heldBy(), '', '0 租期等于没占：立即失效');
  assert.equal(L.acquire('b', -5), true, '仍可被别人拿到');
  assert.equal(L.heldBy(), '', '-5 也是 0 租期');
  assert.equal(L.acquire('c', 100), true);
  assert.equal(L.heldBy(), 'c', '正租期才真正占住');
});

test('不传时钟也能工作（默认 Date.now，只要能拿到/释放）', () => {
  const L = createLease();
  assert.equal(L.acquire('x', 60000), true);
  assert.equal(L.acquire('y', 60000), false);
  assert.equal(L.release('x'), true);
});
