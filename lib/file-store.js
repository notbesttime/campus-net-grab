'use strict';
/* 文件读写的可靠性工具（无第三方依赖）
 *
 * writeFileAtomic：先写同目录临时文件再 rename，避免进程被强杀时留下「半个文件」。
 *   Windows 上 rename 可能因目标被占用而失败，此时退回直接写——不比改动前更差。
 * parseVaultText：把保险库文本判成 空 / 正常 / 损坏 三种，让调用方能区分
 *   「首次运行没有文件」和「文件坏了」。后者绝不能静默吞掉。
 */
const fs = require('fs');
const path = require('path');

function writeFileAtomic(file, data, encoding) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, '.' + path.basename(file) + '.tmp-' + process.pid + '-' + Date.now().toString(36));
  try {
    fs.writeFileSync(tmp, data, encoding);
    fs.renameSync(tmp, file);
    return { ok: true, via: 'rename' };
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* 临时文件清不掉也不影响主流程 */ }
    try {
      fs.writeFileSync(file, data, encoding);
      return { ok: true, via: 'direct', fallbackReason: e.message };
    } catch (e3) {
      return { ok: false, via: 'failed', error: e3.message };
    }
  }
}

/** @returns {{kind:'empty'}|{kind:'ok',vault:Object}|{kind:'bad',error:string}} */
function parseVaultText(raw) {
  if (!String(raw || '').trim()) return { kind: 'empty' };
  let v;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    return { kind: 'bad', error: 'JSON 解析失败：' + e.message };
  }
  if (!v || typeof v !== 'object' || !Array.isArray(v.accounts)) {
    return { kind: 'bad', error: '结构不正确（缺少 accounts 数组）' };
  }
  return { kind: 'ok', vault: v };
}

module.exports = { writeFileAtomic, parseVaultText };
