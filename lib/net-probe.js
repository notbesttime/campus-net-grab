'use strict';
/* TCP 可达性探测（纯读取：只做连接，不发送任何数据、不改变任何状态）
 *
 * 用途：一键抢网前判断「是否明显不在校园网内」，
 * 避免门户和自助后台各吃一次 8~12 秒超时才开始报错。
 */
const net = require('net');

/**
 * @returns {Promise<{ok:boolean, ms:number}>} ok=true 表示 TCP 连接建立成功
 */
function tcpProbe(host, port, ms) {
  return new Promise(resolve => {
    const started = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = ok => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (e) { /* 忽略 */ }
      resolve({ ok, ms: Date.now() - started });
    };
    sock.setTimeout(ms || 1500);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try {
      sock.connect(port, host);
    } catch (e) {
      finish(false);
    }
  });
}

module.exports = { tcpProbe };
