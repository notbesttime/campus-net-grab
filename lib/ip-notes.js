'use strict';
/* IP 备注：纯逻辑（无 IO、无副作用），便于单测
 *
 * 用途：给「各 IP 用量」里的地址起个名字（如「我的手机」「室友电脑」），
 * 备注同时会显示在右侧「绑定设备」表里，方便一眼认出设备。
 *
 * 存放位置：项目根目录 ip-notes.json（不加密——不是敏感数据；已在 .gitignore 排除）。
 * 为什么不放浏览器 localStorage：控制台的 origin 含端口（127.0.0.1:8787），
 * 一旦 8787 被占用、服务换端口启动，localStorage 就整体「看不见」了；
 * 备注属于用户数据，放服务端文件才稳。
 */
const MAX_NOTE = 40;    // 单条备注最大长度（字符）
const MAX_NOTES = 200;  // 备注总条数上限

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 规范化 IPv4 字符串；非法返回 '' */
function normalizeIp(ip) {
  const s = String(ip == null ? '' : ip).trim();
  const m = IPV4_RE.exec(s);
  if (!m) return '';
  const parts = m.slice(1).map(n => Number(n));
  if (parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return '';
  return parts.join('.');
}

/** 规范化备注文本：合并空白、去首尾、截断到上限 */
function normalizeNote(note) {
  return String(note == null ? '' : note).replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);
}

/**
 * 写入/删除一条备注，返回**新的**对象（不修改入参）。
 * note 为空串 → 删除该条；ip 非法或已达条数上限（且非覆盖已有键）→ 原样返回。
 * @param {Object} notes 现有备注表
 * @param {string} ip
 * @param {string} note
 */
function applyNote(notes, ip, note) {
  const src = (notes && typeof notes === 'object' && !Array.isArray(notes)) ? notes : {};
  const out = Object.assign({}, src);
  const key = normalizeIp(ip);
  if (!key) return out;
  const val = normalizeNote(note);
  if (!val) {
    delete out[key];
    return out;
  }
  const isNew = !Object.prototype.hasOwnProperty.call(out, key);
  if (isNew && Object.keys(out).length >= MAX_NOTES) return out;
  out[key] = val;
  return out;
}

/** 解析备注文件文本：任何损坏/非对象内容都返回空表（不抛错），并过滤非法条目 */
function parseNotesText(text) {
  let obj;
  try {
    obj = JSON.parse(String(text == null ? '' : text));
  } catch (e) {
    return {};
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = normalizeIp(k);
    const val = normalizeNote(v);
    if (key && val) out[key] = val;
  }
  return out;
}

module.exports = { normalizeIp, normalizeNote, applyNote, parseNotesText, MAX_NOTE, MAX_NOTES };
