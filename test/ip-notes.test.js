'use strict';
/* IP 备注纯逻辑单测：在项目根目录运行  node --test  */
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIp, normalizeNote, applyNote, parseNotesText, MAX_NOTE } = require('../lib/ip-notes');

/* ---------------- normalizeIp ---------------- */

test('正规 IPv4 原样通过', () => {
  assert.equal(normalizeIp('10.1.2.3'), '10.1.2.3');
  assert.equal(normalizeIp(' 172.31.8.43 '), '172.31.8.43');
});

test('前导零与多余点数被规范化', () => {
  assert.equal(normalizeIp('010.001.002.003'), '10.1.2.3');
});

test('非法 IP 返回空串', () => {
  assert.equal(normalizeIp('256.1.1.1'), '');
  assert.equal(normalizeIp('1.2.3'), '');
  assert.equal(normalizeIp('1.2.3.4.5'), '');
  assert.equal(normalizeIp('abc'), '');
  assert.equal(normalizeIp(''), '');
  assert.equal(normalizeIp(null), '');
  assert.equal(normalizeIp(undefined), '');
});

test('拒绝带端口或网段的写法（避免键重复）', () => {
  assert.equal(normalizeIp('10.1.2.3:8080'), '');
  assert.equal(normalizeIp('10.1.2.0/24'), '');
});

/* ---------------- normalizeNote ---------------- */

test('备注合并空白并去首尾', () => {
  assert.equal(normalizeNote('  我的   手机 '), '我的 手机');
  assert.equal(normalizeNote('a\n\tb'), 'a b');
});

test('备注超长被截断到上限', () => {
  const long = 'x'.repeat(MAX_NOTE + 20);
  assert.equal(normalizeNote(long).length, MAX_NOTE);
});

test('空备注规范化为空串', () => {
  assert.equal(normalizeNote(''), '');
  assert.equal(normalizeNote('   '), '');
  assert.equal(normalizeNote(null), '');
});

/* ---------------- applyNote ---------------- */

test('新增备注不修改入参对象', () => {
  const before = { '10.1.2.3': '手机' };
  const after = applyNote(before, '10.1.2.4', '电脑');
  assert.deepEqual(before, { '10.1.2.3': '手机' });
  assert.deepEqual(after, { '10.1.2.3': '手机', '10.1.2.4': '电脑' });
});

test('空备注 = 删除该条', () => {
  const r = applyNote({ '10.1.2.3': '手机' }, '10.1.2.3', '');
  assert.deepEqual(r, {});
});

test('非法 IP 不产生任何变化', () => {
  const r = applyNote({ '10.1.2.3': '手机' }, 'not-an-ip', 'x');
  assert.deepEqual(r, { '10.1.2.3': '手机' });
});

test('覆盖已有备注允许，即使已达上限', () => {
  const notes = {};
  for (let i = 1; i <= 200; i++) notes['10.0.0.' + i] = 'n' + i;
  const r = applyNote(notes, '10.0.0.5', '改名');
  assert.equal(r['10.0.0.5'], '改名');
  assert.equal(Object.keys(r).length, 200);
});

test('达到上限后不新增（未超出上限时不阻止）', () => {
  const notes = {};
  for (let i = 1; i <= 200; i++) notes['10.0.1.' + i] = 'n' + i;
  const r = applyNote(notes, '10.9.9.9', '新增');
  assert.equal(r['10.9.9.9'], undefined);
  assert.equal(Object.keys(r).length, 200);
});

test('入参不是对象时也能安全使用', () => {
  assert.deepEqual(applyNote(null, '10.1.2.3', '手机'), { '10.1.2.3': '手机' });
  assert.deepEqual(applyNote([], '10.1.2.3', '手机'), { '10.1.2.3': '手机' });
});

/* ---------------- parseNotesText ---------------- */

test('正常 JSON 解析并过滤非法条目', () => {
  const r = parseNotesText('{"10.1.2.3":"手机","bad":"x","10.1.2.4":"  "}');
  assert.deepEqual(r, { '10.1.2.3': '手机' });
});

test('损坏 JSON 返回空表且不抛错', () => {
  assert.deepEqual(parseNotesText('{oops'), {});
  assert.deepEqual(parseNotesText(''), {});
  assert.deepEqual(parseNotesText(null), {});
});

test('数组/标量一律视为空表', () => {
  assert.deepEqual(parseNotesText('[]'), {});
  assert.deepEqual(parseNotesText('123'), {});
  assert.deepEqual(parseNotesText('"str"'), {});
});

test('parse → apply → parse 往返稳定', () => {
  const a = parseNotesText('{"10.1.2.3":"我的手机"}');
  const b = applyNote(a, '10.1.2.4', '室友电脑');
  const c = parseNotesText(JSON.stringify(b));
  assert.deepEqual(c, { '10.1.2.3': '我的手机', '10.1.2.4': '室友电脑' });
});
