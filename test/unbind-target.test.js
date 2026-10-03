'use strict';
/* 解绑目标解析单测：在项目根目录运行  node --test test/  */
const test = require('node:test');
const assert = require('node:assert/strict');
const { normMac, resolveUnbindTarget } = require('../lib/unbind-target');

const mkDev = (mac, extra) => Object.assign({
  text: '设备 ' + mac,
  ip: '',
  mac,
  type: 'PC',
  action: { kind: 'unbindmac', mac: normMac(mac) },
}, extra || {});

/* ---------------- normMac ---------------- */

test('normMac 只保留十六进制字符，忽略大小写与分隔符', () => {
  assert.equal(normMac('AA-BB-CC-DD-EE-FF'), 'aabbccddeeff');
  assert.equal(normMac('aa:bb:cc:dd:ee:ff'), 'aabbccddeeff');
  assert.equal(normMac('aabbccddeeff'), 'aabbccddeeff');
  assert.equal(normMac(''), '');
  assert.equal(normMac(null), '');
  assert.equal(normMac(undefined), '');
});

/* ---------------- 按 MAC 定位（防串号核心） ---------------- */

test('按 MAC 命中：列表顺序变化后仍解绑同一台设备', () => {
  const target = mkDev('AA-BB-CC-DD-EE-01');
  // 用户看到的是 target 在列表首位时的界面；期间列表被刷新，顺序变了
  const list = [mkDev('AA-BB-CC-DD-EE-02'), target, mkDev('AA-BB-CC-DD-EE-03')];
  const r = resolveUnbindTarget(list, { mac: 'AA-BB-CC-DD-EE-01' }, '');
  assert.equal(r.ok, true);
  assert.equal(r.dev, target);
  // 对照：若按界面行号 0 解绑，会落到另一台设备
  assert.notEqual(list[0], target);
});

test('MAC 匹配忽略分隔符与大小写', () => {
  const dev = mkDev('aa:bb:cc:dd:ee:ff');
  const r = resolveUnbindTarget([dev], { mac: 'AA-BB-CC-DD-EE-FF' }, '');
  assert.equal(r.ok, true);
  assert.equal(r.dev, dev);
});

test('MAC 未命中 → 404，且不返回任何设备', () => {
  const r = resolveUnbindTarget([mkDev('AA-BB-CC-DD-EE-01')], { mac: 'AA-BB-CC-DD-EE-99' }, '');
  assert.equal(r.ok, false);
  assert.equal(r.code, 404);
  assert.equal(r.dev, undefined);
  assert.match(r.error, /刷新列表/);
});

/* ---------------- 账号一致性 ---------------- */

test('请求账号与后台会话不符 → 409，即使 MAC 命中也不放行', () => {
  const r = resolveUnbindTarget(
    [mkDev('AA-BB-CC-DD-EE-01')],
    { mac: 'AA-BB-CC-DD-EE-01', account: 'B' },
    'A'
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 409);
  assert.match(r.error, /A/);
  assert.match(r.error, /B/);
});

test('账号不符优先于 MAC 未命中返回', () => {
  const r = resolveUnbindTarget([], { mac: 'AA-BB-CC-DD-EE-01', account: 'B' }, 'A');
  assert.equal(r.code, 409);
});

test('后台会话账号未知（空串）时不拦，仍按 MAC 定位', () => {
  const dev = mkDev('AA-BB-CC-DD-EE-01');
  const r = resolveUnbindTarget([dev], { mac: 'AA-BB-CC-DD-EE-01', account: 'A' }, '');
  assert.equal(r.ok, true);
  assert.equal(r.dev, dev);
});

test('请求未带 account 时兼容放行', () => {
  const dev = mkDev('AA-BB-CC-DD-EE-01');
  const r = resolveUnbindTarget([dev], { mac: 'AA-BB-CC-DD-EE-01' }, 'A');
  assert.equal(r.ok, true);
  assert.equal(r.dev, dev);
});

/* ---------------- 无 MAC 时的索引回退 ---------------- */

test('设备无 MAC 时可回退按索引解绑（旧式页面设备）', () => {
  const legacy = { text: '旧式设备', ip: '10.0.0.9', mac: '', type: 'PC', action: { url: '/x' } };
  const r = resolveUnbindTarget([legacy], { index: 0 }, '');
  assert.equal(r.ok, true);
  assert.equal(r.dev, legacy);
});

test('索引命中的设备有 MAC → 400，要求刷新后再按 MAC 解绑', () => {
  const r = resolveUnbindTarget([mkDev('AA-BB-CC-DD-EE-01')], { index: 0 }, '');
  assert.equal(r.ok, false);
  assert.equal(r.code, 400);
});

test('索引为字符串数字时仍可解析', () => {
  const legacy = { text: 'x', mac: '' };
  const r = resolveUnbindTarget([legacy], { index: '0' }, '');
  assert.equal(r.ok, true);
  assert.equal(r.dev, legacy);
});

test('索引越界 → 404', () => {
  const r = resolveUnbindTarget([mkDev('AA-BB-CC-DD-EE-01')], { index: 5 }, '');
  assert.equal(r.ok, false);
  assert.equal(r.code, 404);
});

test('非法索引一律拒绝，不误伤第 0 台设备', () => {
  const legacy = { text: 'x', mac: '' };
  for (const index of [-1, 0.5, 'abc', '', null, undefined, {}]) {
    const r = resolveUnbindTarget([legacy], { index }, '');
    assert.equal(r.ok, false, 'index=' + String(index) + ' 不应放行');
    assert.equal(r.code, 404);
  }
});

/* ---------------- 健壮性 ---------------- */

test('列表为空或不是数组时不抛异常', () => {
  for (const list of [undefined, null, [], 'x', 42, {}]) {
    const r = resolveUnbindTarget(list, { mac: 'AA-BB-CC-DD-EE-01' }, '');
    assert.equal(r.ok, false);
    assert.equal(r.code, 404);
  }
});

test('空请求体 → 404 而不是抛异常', () => {
  const r = resolveUnbindTarget([mkDev('AA-BB-CC-DD-EE-01')], {}, '');
  assert.equal(r.ok, false);
  assert.equal(r.code, 404);
});

test('列表中存在 mac 缺失的条目时按 MAC 查找不会抛异常', () => {
  const list = [{ text: 'no-mac' }, null, mkDev('AA-BB-CC-DD-EE-01')];
  const r = resolveUnbindTarget(list, { mac: 'AA-BB-CC-DD-EE-01' }, '');
  assert.equal(r.ok, true);
  assert.equal(r.dev.mac, 'AA-BB-CC-DD-EE-01');
});
