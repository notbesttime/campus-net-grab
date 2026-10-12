'use strict';
/* 占用确认弹窗内容组装（纯函数）——夹具一律用编造的 MAC（aa:bb:cc:dd:ee:xx 一族） */
const test = require('node:test');
const assert = require('node:assert');
const { occupancyPrompt } = require('../lib/occupancy-prompt.js');

const dev = (over = {}) => ({
  text: '在线中 · PC · 10.0.0.9', ip: '10.0.0.9', mac: 'aa:bb:cc:dd:ee:01', type: 'PC', maybeSelf: false, ...over,
});

test('有候选设备：只解绑列出来的，不需要先注销后台', () => {
  const p = occupancyPrompt([dev(), dev({ ip: '10.0.0.10', mac: 'aa:bb:cc:dd:ee:02' })]);
  assert.equal(p.kind, 'unbind');
  assert.equal(p.needList, false);
  assert.equal(p.selfLogout, false);
  assert.match(p.hint, /2 条会话占用/);
  assert.doesNotMatch(p.hint, /取不到设备列表/);
  assert.match(p.detail, /自动重新登录/);
  assert.equal(p.devices.length, 2);
  assert.equal(p.devices[0].mac, 'aa:bb:cc:dd:ee:01');
});

test('全部是「可能本机」：hint 与 detail 都要说清是随机硬件地址造成的', () => {
  const p = occupancyPrompt([dev({ maybeSelf: true }), dev({ ip: '10.0.0.10', maybeSelf: true })]);
  assert.match(p.hint, /2 条可能是你的旧会话/);
  assert.match(p.detail, /随机硬件地址/);
  assert.equal(p.selfLogout, false);
});

test('混有他人占用：只标注条数，不说成「都是你的旧会话」', () => {
  const p = occupancyPrompt([dev({ maybeSelf: true }), dev({ ip: '10.0.0.10' })]);
  assert.match(p.hint, /其中 1 条可能是你的旧会话/);
  assert.match(p.detail, /随机硬件地址/);
});

test('拿不到设备列表：selfLogout/needList 为真，并把后续动作一次说清', () => {
  for (const empty of [[], undefined, null, 'x']) {
    const p = occupancyPrompt(empty);
    assert.equal(p.needList, true, String(empty));
    assert.equal(p.selfLogout, true, String(empty));
    assert.deepEqual(p.devices, []);
    assert.match(p.hint, /取不到设备列表/);
    assert.match(p.detail, /注销后台占用/);
    assert.match(p.detail, /验证码/);
    assert.match(p.detail, /手机不动/);
    assert.match(p.detail, /同一次点击/);
  }
});

test('拿不到列表时不再说「请点右侧刷新」之类的空点击指令', () => {
  const p = occupancyPrompt([]);
  assert.doesNotMatch(p.detail, /刷新/);
  assert.doesNotMatch(p.detail, /设置/);
});

test('设备字段原样透传，maybeSelf 归一成布尔', () => {
  const p = occupancyPrompt([{ text: 't', ip: '1.2.3.4', mac: 'aa:bb:cc:dd:ee:03', type: 'PC' }]);
  assert.deepEqual(p.devices[0], { text: 't', ip: '1.2.3.4', mac: 'aa:bb:cc:dd:ee:03', type: 'PC', maybeSelf: false });
});

test('列表里的空元素被丢掉，不会渲染出「未知设备」行', () => {
  const p = occupancyPrompt([null, dev(), undefined]);
  assert.equal(p.devices.length, 1);
  assert.match(p.hint, /1 条会话占用/);
});

test('不改动传入的候选对象（纯函数）', () => {
  const raw = dev();
  const snapshot = JSON.stringify(raw);
  occupancyPrompt([raw]);
  assert.equal(JSON.stringify(raw), snapshot);
});