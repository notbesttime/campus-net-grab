'use strict';
/* 等待用户输入单测：在项目根目录运行  node --test  */
const test = require('node:test');
const assert = require('node:assert/strict');
const { CANCELLED, createUserWaiter } = require('../lib/user-waiter');

test('用户提交 → resolve 出提交的值', async () => {
  const w = createUserWaiter();
  const p = w.wait('captcha', 10000);
  assert.equal(w.submit('captcha', '1234'), true);
  assert.equal(await p, '1234');
});

test('无人等待时提交返回 false，不抛异常', () => {
  const w = createUserWaiter();
  assert.equal(w.submit('captcha', '1234'), false);
  assert.equal(w.submit('decision', 'continue'), false);
});

test('超时 → resolve(null)', async () => {
  const w = createUserWaiter();
  assert.equal(await w.wait('captcha', 20), null);
});

test('取消 → resolve(CANCELLED)，与超时可区分', async () => {
  const w = createUserWaiter();
  const p = w.wait('captcha', 10000);
  assert.equal(w.cancel('captcha'), true);
  const v = await p;
  assert.equal(v, CANCELLED);
  assert.notEqual(v, null);
  assert.equal(Boolean(v), true); // CANCELLED 是 truthy：调用方必须先判它再判空
});

test('没有人等待时取消返回 false', () => {
  const w = createUserWaiter();
  assert.equal(w.cancel('captcha'), false);
});

test('提交后同一 key 不能被取消，也不会二次 settle', async () => {
  const w = createUserWaiter();
  const p = w.wait('captcha', 10000);
  assert.equal(w.submit('captcha', '9999'), true);
  assert.equal(w.cancel('captcha'), false);
  assert.equal(w.submit('captcha', '8888'), false);
  assert.equal(await p, '9999');
});

test('取消后同一 key 不能被提交', async () => {
  const w = createUserWaiter();
  const p = w.wait('captcha', 10000);
  assert.equal(w.cancel('captcha'), true);
  assert.equal(w.submit('captcha', '1234'), false);
  assert.equal(await p, CANCELLED);
});

test('超时后再提交返回 false', async () => {
  const w = createUserWaiter();
  assert.equal(await w.wait('captcha', 20), null);
  assert.equal(w.submit('captcha', '1234'), false);
});

test('cancelAll 一次取消所有等待', async () => {
  const w = createUserWaiter();
  const a = w.wait('captcha', 10000);
  const b = w.wait('decision', 10000);
  assert.equal(w.cancelAll(), 2);
  assert.equal(await a, CANCELLED);
  assert.equal(await b, CANCELLED);
  assert.deepEqual(w.pendingKeys(), []);
});

test('cancelAll 在没有等待时返回 0', () => {
  const w = createUserWaiter();
  assert.equal(w.cancelAll(), 0);
});

test('cancel 只影响指定 key，不误伤另一个等待', async () => {
  const w = createUserWaiter();
  const cap = w.wait('captcha', 10000);
  const dec = w.wait('decision', 10000);
  assert.equal(w.cancel('captcha'), true);
  assert.equal(await cap, CANCELLED);
  assert.deepEqual(w.pendingKeys(), ['decision']);
  assert.equal(w.submit('decision', 'pause'), true);
  assert.equal(await dec, 'pause');
});

test('settle 之后不再占用 key', async () => {
  const w = createUserWaiter();
  assert.deepEqual(w.pendingKeys(), []);
  const p = w.wait('captcha', 10000);
  assert.deepEqual(w.pendingKeys(), ['captcha']);
  w.submit('captcha', '1');
  assert.deepEqual(w.pendingKeys(), []);
  await p;
});

test('两个等待器实例互不影响', async () => {
  const w1 = createUserWaiter();
  const w2 = createUserWaiter();
  const p1 = w1.wait('captcha', 10000);
  assert.equal(w2.cancel('captcha'), false);
  assert.equal(w1.cancel('captcha'), true);
  assert.equal(await p1, CANCELLED);
});

test('decision 的取消值既不是 continue 也不是 pause', async () => {
  const w = createUserWaiter();
  const p = w.wait('decision', 10000);
  w.cancelAll();
  const act = await p;
  assert.notEqual(act, 'continue');
  assert.notEqual(act, 'pause');
});
