'use strict';
/* 解绑目标解析（纯函数，无副作用，便于单测）
 *
 * 为什么按 MAC 而不是按索引定位：
 *   前端展示的设备列表来自服务端的 self.lastDevices。两者一旦不同步
 *   （期间列表被刷新、排序变化、或界面仍停在另一个账号的列表上），
 *   用「界面行号」当索引就会解绑到相邻的另一台设备。
 *   MAC 是设备自身的标识，能保证看到哪台就解绑哪台。
 */

/** 归一化 MAC：只保留十六进制字符，忽略大小写与 - : 等分隔符 */
function normMac(m) {
  return String(m || '').toLowerCase().replace(/[^0-9a-f]/g, '');
}

/**
 * 解析本次解绑请求应该作用于哪台设备。
 * @param {Array} list 服务端缓存的设备列表（self.lastDevices）
 * @param {Object} req 前端请求体：{ mac?, index?, account? }
 * @param {string} sessionAccount 自助后台当前登录账号（self.account，未知时为空串）
 * @returns {{ok: true, dev: Object}|{ok: false, code: number, error: string}}
 */
function resolveUnbindTarget(list, req, sessionAccount) {
  const devices = Array.isArray(list) ? list : [];
  const body = req || {};
  const account = String(body.account || '');
  const session = String(sessionAccount || '');

  // 自助后台单会话排他：请求账号与后台会话账号不符时直接拒绝，
  // 否则界面停在另一个账号的列表上时会解绑到那个账号的设备。
  if (account && session && account !== session) {
    return {
      ok: false,
      code: 409,
      error: '自助后台当前登录的是 ' + session + '，与请求账号 ' + account + ' 不一致：请刷新列表后重试',
    };
  }

  const want = normMac(body.mac);
  if (want) {
    const dev = devices.find(d => normMac(d && d.mac) === want) || null;
    if (!dev) return { ok: false, code: 404, error: '设备列表已变化，请先刷新列表再解绑' };
    return { ok: true, dev };
  }

  // 兼容旧路径：只有「无 MAC 可定位」的设备才允许按索引解绑
  const raw = body.index;
  const idx = (typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== ''))
    ? Number(raw) : NaN;
  const cand = Number.isInteger(idx) && idx >= 0 ? devices[idx] : null;
  if (!cand) return { ok: false, code: 404, error: '设备不存在，请先刷新列表' };
  if (normMac(cand.mac)) return { ok: false, code: 400, error: '设备信息已更新，请刷新列表后重试' };
  return { ok: true, dev: cand };
}

module.exports = { normMac, resolveUnbindTarget };
