'use strict';
/* 文件读写可靠性单测：在项目根目录运行  node --test  */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic, parseVaultText } = require('../lib/file-store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cnal-test-'));
}

/* ---------------- writeFileAtomic ---------------- */

test('写入新文件并返回 ok', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'a.json');
  const r = writeFileAtomic(f, '{"x":1}', 'utf8');
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(f, 'utf8'), '{"x":1}');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('覆盖已有文件', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'vault.json');
  writeFileAtomic(f, '{"a":1}', 'utf8');
  const r = writeFileAtomic(f, '{"a":2}', 'utf8');
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(f, 'utf8'), '{"a":2}');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('写完之后不残留临时文件', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'vault.json');
  writeFileAtomic(f, '{"a":1}', 'utf8');
  writeFileAtomic(f, '{"a":2}', 'utf8');
  writeFileAtomic(f, '{"a":3}', 'utf8');
  const left = fs.readdirSync(dir).filter(n => n !== 'vault.json');
  assert.deepEqual(left, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('目录不存在时返回 ok:false，不抛异常', () => {
  const dir = tmpDir();
  const r = writeFileAtomic(path.join(dir, 'nope', 'a.json'), 'x', 'utf8');
  assert.equal(r.ok, false);
  assert.equal(typeof r.error, 'string');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('能写入空内容（用于清空 console.url）', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'console.url');
  writeFileAtomic(f, 'http://127.0.0.1:8787/?t=abc', 'utf8');
  const r = writeFileAtomic(f, '', 'utf8');
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(f, 'utf8'), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------- parseVaultText ---------------- */

test('正常结构判为 ok 并保留内容', () => {
  const r = parseVaultText(JSON.stringify({ version: 1, accounts: [{ id: 'a1', enc: 'x' }] }));
  assert.equal(r.kind, 'ok');
  assert.equal(r.vault.accounts[0].id, 'a1');
  assert.equal(r.vault.accounts[0].enc, 'x');
});

test('空内容视为尚无保险库，不算损坏', () => {
  for (const raw of ['', '   \n  ', null, undefined]) {
    assert.equal(parseVaultText(raw).kind, 'empty', String(raw));
  }
});

test('截断的 JSON 判为损坏', () => {
  const r = parseVaultText('{"version":1,"accounts":[{"id":"a"');
  assert.equal(r.kind, 'bad');
  assert.match(r.error, /JSON/);
});

test('结构不对判为损坏（改动前会被静默丢弃）', () => {
  for (const raw of ['{}', '[]', '{"version":1}', '{"accounts":null}', '"x"', '123', 'null']) {
    assert.equal(parseVaultText(raw).kind, 'bad', raw);
  }
});

test('accounts 为空数组也算正常', () => {
  const r = parseVaultText('{"version":1,"accounts":[]}');
  assert.equal(r.kind, 'ok');
  assert.deepEqual(r.vault.accounts, []);
});
