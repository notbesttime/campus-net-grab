'use strict';
/* 本机身份判定单测：在项目根目录运行  node --test
 *
 * ⚠️ 本文件会随公开仓库发布，**只能使用编造的 MAC/IP**
 * （统一用 aa:bb:cc:dd:ee:xx 这一族，一眼可辨是夹具）。
 * 真实 MAC 一旦写进来，发布前的敏感扫描会中止整个同步。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { normMac, rememberMacs, seenMac, macsFromHistoryRows, selfKind, shouldAutoUnbind, MAC_HEX_LEN } = require('../lib/self-id');

/* ---------------- normMac ---------------- */

test('normMac 归一化为 12 位小写十六进制', () => {
  assert.equal(normMac('AA-BB-CC-DD-EE-01'), 'aabbccddee01');
  assert.equal(normMac('aa:bb:cc:dd:ee:01'), 'aabbccddee01');
  assert.equal(normMac('aabbccddee01'), 'aabbccddee01');
  assert.equal(normMac('  aabbccddee01  '), 'aabbccddee01');
});

test('normMac 长度不对或含非十六进制一律返回空串（不当成 MAC 用）', () => {
  assert.equal(normMac(''), '');
  assert.equal(normMac(null), '');
  assert.equal(normMac(undefined), '');
  assert.equal(normMac('aabbccddee0'), '');       // 11 位
  assert.equal(normMac('aabbccddee011'), '');     // 13 位
  assert.equal(normMac('aabbccddee0z'), '');      // 含非十六进制
});

test('normMac 结果长度恒为 12', () => {
  assert.equal(normMac('aa:bb:cc:dd:ee:ff').length, MAC_HEX_LEN);
});

/* ---------------- rememberMacs ---------------- */

test('rememberMacs 并入新 MAC 并返回新增条数', () => {
  const s = new Set();
  assert.equal(rememberMacs(s, ['AABBCCDDEE01', 'AABBCCDDEE02']), 2);
  assert.equal(s.size, 2);
  assert.ok(s.has('aabbccddee01'));
  assert.ok(s.has('aabbccddee02'));
});

test('rememberMacs 去重：换个写法并入同一个 MAC 不算新增', () => {
  const s = new Set();
  rememberMacs(s, ['aabbccddee01']);
  assert.equal(rememberMacs(s, ['AA-BB-CC-DD-EE-01']), 0);
  assert.equal(s.size, 1);
});

test('rememberMacs 忽略非法条目（空串/长度不对/非十六进制）', () => {
  const s = new Set();
  assert.equal(rememberMacs(s, ['', null, undefined, 'abc', 'zzzzzzzzzzzz']), 0);
  assert.equal(s.size, 0);
});

test('rememberMacs 超过上限时丢弃最早加入的', () => {
  const s = new Set();
  const list = [];
  for (let i = 0; i < 5; i++) list.push('aabbccddee0' + i);
  rememberMacs(s, list, 3);
  assert.equal(s.size, 3);
  assert.ok(!s.has('aabbccddee00'), '最早的应被丢弃');
  assert.ok(!s.has('aabbccddee01'));
  assert.ok(s.has('aabbccddee04'), '最新的应保留');
});

test('seenMac 只读查询，不修改集合', () => {
  const s = new Set(['aabbccddee01']);
  assert.equal(seenMac(s, 'AA-BB-CC-DD-EE-01'), true);
  assert.equal(seenMac(s, 'aabbccddee02'), false);
  assert.equal(seenMac(s, ''), false);
  assert.equal(s.size, 1);
});

/* ---------------- selfKind：三态 ---------------- */

const mkLocal = (curMacs, ips, seenMacs) => ({
  macsHex: new Set(curMacs || []),
  ips: new Set(ips || []),
  seen: new Set(seenMacs || []),
});

test('当前网卡 MAC 命中 → self（确凿）', () => {
  const local = mkLocal(['aabbccddee01'], ['10.0.0.5'], ['aabbccddee01', 'aabbccddee02']);
  assert.equal(selfKind({ mac: 'AA:BB:CC:DD:EE:01', ip: '10.9.9.9' }, local), 'self');
});

test('当前 IP 命中 → self（即使 MAC 对不上）', () => {
  const local = mkLocal(['aabbccddee01'], ['10.0.0.5'], ['aabbccddee01']);
  assert.equal(selfKind({ mac: '', ip: '10.0.0.5' }, local), 'self');
});

test('MAC 只在本机历史里（不是当前网卡）→ maybe（可能是本机旧会话）', () => {
  // 这正是随机硬件地址造成的场景：同一台机器先后用过两个 MAC
  const local = mkLocal(['aabbccddee01'], ['10.0.0.5'], ['aabbccddee01', 'aabbccddee02']);
  assert.equal(selfKind({ mac: 'AA-BB-CC-DD-EE-02', ip: '10.0.0.99' }, local), 'maybe');
});

test('历史里也没有 → 空串（既不是本机，也不能说是本机旧会话）', () => {
  const local = mkLocal(['aabbccddee01'], ['10.0.0.5'], ['aabbccddee01']);
  assert.equal(selfKind({ mac: 'aabbccddeeff', ip: '10.9.9.9' }, local), '');
});

test('同时命中「当前」和「历史」时以 self 为准，不降级成 maybe', () => {
  const local = mkLocal(['aabbccddee01'], [], ['aabbccddee01']);
  assert.equal(selfKind({ mac: 'aabbccddee01' }, local), 'self');
});

test('local 缺字段或为空时不抛异常，一律返回空串', () => {
  assert.equal(selfKind({ mac: 'aabbccddee01' }, undefined), '');
  assert.equal(selfKind({ mac: 'aabbccddee01' }, {}), '');
  assert.equal(selfKind(null, mkLocal(['aabbccddee01'])), '');
  assert.equal(selfKind({}, mkLocal(['aabbccddee01'])), '');
});

test('历史集合缺省时回落到「当前集合」，不会凭空把陌生 MAC 判成本机', () => {
  const local = { macsHex: new Set(['aabbccddee01']), ips: new Set() };
  assert.equal(selfKind({ mac: 'aabbccddee02' }, local), '');
  assert.equal(selfKind({ mac: 'aabbccddee01' }, local), 'self');
});

test('maybe 判定必须「不在当前网卡里」：历史与当前都有 → self', () => {
  const local = mkLocal(['aabbccddee02'], [], ['aabbccddee02']);
  assert.equal(selfKind({ mac: 'aabbccddee02' }, local), 'self');
});

/* ---------------- shouldAutoUnbind：自动解绑策略 ---------------- */

test('占用设备全部是「可能本机旧会话」→ 自动解绑（不再打扰用户）', () => {
  assert.equal(shouldAutoUnbind([{ maybeSelf: true }, { maybeSelf: true }]), true);
});

test('只要混入一条非本机的占用 → 必须交回用户确认', () => {
  assert.equal(shouldAutoUnbind([{ maybeSelf: true }, { maybeSelf: false }]), false);
  assert.equal(shouldAutoUnbind([{ maybeSelf: true }, {}]), false);
});

test('没有任何占用设备 → 不触发自动解绑', () => {
  assert.equal(shouldAutoUnbind([]), false);
});

test('入参非法（null/undefined/非数组）→ 不触发，且不抛异常', () => {
  assert.equal(shouldAutoUnbind(null), false);
  assert.equal(shouldAutoUnbind(undefined), false);
  assert.equal(shouldAutoUnbind('x'), false);
});

test('单条「可能本机」也能自动解绑', () => {
  assert.equal(shouldAutoUnbind([{ maybeSelf: true }]), true);
});

/* ---------------- macsFromHistoryRows（P2③：从上网记录抽本账号用过的 MAC） ---------------- */

test('数组行：取第 4 位（索引 3）作为 MAC 并归一化', () => {
  // getLoginHistory 行格式：0 上线 1 注销 2 IP 3 MAC 4 时长 5 流量 …
  const rows = [
    ['2026-10-11 13:30:24', '2026-10-11 14:00:00', '10.0.0.1', 'AA-BB-CC-DD-EE-01', '30', '1'],
    ['2026-10-11 12:00:00', '', '10.0.0.2', 'aa:bb:cc:dd:ee:02', '5', '2'],
  ];
  assert.deepEqual(macsFromHistoryRows(rows).sort(), ['aabbccddee01', 'aabbccddee02']);
});

test('对象行：优先取 .mac 字段', () => {
  const rows = [{ ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:03', flowKb: 10 }];
  assert.deepEqual(macsFromHistoryRows(rows), ['aabbccddee03']);
});

test('对象行：getUserOnlineLog 的字段名是 macAddress（实测结构）', () => {
  const rows = [
    { area: 1, costId: 72409044, loginTime: 1789738448000, macAddress: 'AA-BB-CC-DD-EE-06', time: 1 },
    { area: 1, costId: 1, macAddress: '', time: 1 },
  ];
  assert.deepEqual(macsFromHistoryRows(rows), ['aabbccddee06']);
});

test('对象行若无 .mac：回退取第 4 个值', () => {
  const rows = [{ a: 'x', b: 'y', c: 'z', d: 'AABBCCDDEE04' }];
  assert.deepEqual(macsFromHistoryRows(rows), ['aabbccddee04']);
});

test('去重：同一 MAC 不同写法只算一条', () => {
  const rows = [
    ['t', 't', 'ip', 'AA-BB-CC-DD-EE-05'],
    ['t', 't', 'ip', 'aabbccddee05'],
    ['t', 't', 'ip', 'aa:bb:cc:dd:ee:05'],
  ];
  assert.deepEqual(macsFromHistoryRows(rows), ['aabbccddee05']);
});

test('剔除非 MAC：长度不对 / 缺位 / 非十六进制一律丢弃', () => {
  const rows = [
    ['t', 't', 'ip', 'not-a-mac'],
    ['t', 't', 'ip', ''],
    ['t', 't', 'ip'],
    ['t', 't', 'ip', 'aabbccddee', /* 只有 10 位 */],
    [null],
  ];
  assert.deepEqual(macsFromHistoryRows(rows), []);
});

test('入参非法（null/undefined/字符串/对象）→ 返回空数组且不抛异常', () => {
  assert.deepEqual(macsFromHistoryRows(null), []);
  assert.deepEqual(macsFromHistoryRows(undefined), []);
  assert.deepEqual(macsFromHistoryRows('x'), []);
  assert.deepEqual(macsFromHistoryRows({}), []);
});
