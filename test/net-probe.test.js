'use strict';
/* TCP 探测单测：在项目根目录运行  node --test  */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { tcpProbe } = require('../lib/net-probe');

function listen() {
  return new Promise(resolve => {
    const srv = net.createServer(() => {});
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function close(srv) {
  return new Promise(resolve => srv.close(resolve));
}

test('探测有监听的端口 → ok:true', async () => {
  const srv = await listen();
  try {
    const r = await tcpProbe('127.0.0.1', srv.address().port, 1000);
    assert.equal(r.ok, true);
    assert.equal(typeof r.ms, 'number');
  } finally {
    await close(srv);
  }
});

test('探测没人监听的端口 → ok:false，且不抛异常', async () => {
  const srv = await listen();
  const port = srv.address().port;
  await close(srv);
  const r = await tcpProbe('127.0.0.1', port, 1000);
  assert.equal(r.ok, false);
});

test('不可达地址在超时附近返回 ok:false，而不是挂住', async () => {
  const t0 = Date.now();
  const r = await tcpProbe('192.0.2.1', 8080, 300);
  const cost = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.ok(cost < 5000, '应在超时附近返回，实际 ' + cost + 'ms');
});

test('非法主机名立即返回 ok:false', async () => {
  const r = await tcpProbe('this-host-should-not-exist.invalid', 80, 500);
  assert.equal(r.ok, false);
});

test('探测耗时字段是数字且非负', async () => {
  const srv = await listen();
  try {
    const r = await tcpProbe('127.0.0.1', srv.address().port, 1000);
    assert.ok(Number.isFinite(r.ms) && r.ms >= 0);
  } finally {
    await close(srv);
  }
});
