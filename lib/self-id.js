'use strict';
/* 本机身份判定（纯函数，无副作用，便于单测）
 *
 * 要解决的问题（踩坑 §19.4）：Windows 的 Wi-Fi「随机硬件地址」会让同一台笔记本在
 * 不同时间呈现不同的 MAC，门户于是把同一台机器算成多台设备，并把「本机自己的旧会话」
 * 列成「其他设备在线」，再劝用户解绑——做法没错，说法完全错了。
 *
 * 只拿「本机当前网卡快照」去比对认不出这种旧会话：实测两条 MAC 连厂商前缀都不同
 * （18-3D-2D vs 58-02-05），说明 Windows 是把**整个 MAC** 随机掉，所以 OUI 前缀
 * 匹配这条路也走不通。于是多记一份「本机历史上出现过的 MAC」。
 *
 * 历史 MAC 有两个来源（2026-10-11 起）：
 *   ① 本机**当前网卡**实测（`localInfo()` → 强）；
 *   ② 本账号**上网历史记录**里出现过的 MAC（`macsFromHistoryRows()` → 弱，见踩坑 §19.12）。
 *   加 ② 的原因：只记 ① 时，换过随机 MAC 的自家旧会话（如 `183d2d…`）不在历史里，
 *   会被当成「别人的设备」反复要用户确认——实测就是这样（§19.11）。
 *
 * ⚠️ 命中历史是**弱证据**（DHCP/网卡复用、账号在别人机器上登过都可能造成巧合）。
 * 因此：默认只用于「界面标注 + 提示去关随机硬件地址」；唯一会**影响决策**的地方是
 * `shouldAutoUnbind()`——仅当占用**全部**是「可能本机」时才自动解绑，混入任何一条非
 * 「可能本机」都必须交回用户确认。
 */

const MAC_HEX_LEN = 12;

/** 归一化 MAC 为 12 位小写十六进制（无分隔符）。不合法（长度不对）返回空串 */
function normMac(m) {
  const s = String(m || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  return s.length === MAC_HEX_LEN ? s : '';
}

/**
 * 把一组 MAC 并入历史集合（原地修改 set）。
 * @param {Set<string>} set 历史集合（元素为归一化 MAC）
 * @param {Iterable<string>} macs 待并入的 MAC（原始格式即可）
 * @param {number} [max] 上限，超出时从**最早加入**的开始丢弃
 * @returns {number} 本次新增条数（0 表示无需落盘）
 */
function rememberMacs(set, macs, max) {
  const cap = Number(max) > 0 ? Number(max) : 60;
  let added = 0;
  for (const m of macs || []) {
    const k = normMac(m);
    if (k && !set.has(k)) { set.add(k); added++; }
  }
  // Set 的迭代顺序 = 插入顺序，所以「从头删」就是丢最早的
  while (set.size > cap) set.delete(set.values().next().value);
  return added;
}

/** 历史集合里是否有这个 MAC（用于「以前见过吗」这类只读判断） */
function seenMac(set, mac) {
  const k = normMac(mac);
  return !!(k && set && set.has(k));
}

/**
 * 从自助后台上网记录里抽取「本账号用过的 MAC」（P2③）。
 *
 * 三种行结构都吃（实测见 `diag/`）：
 *   - **数组行**（`getLoginHistory`）：第 3 位 = MAC（0 上线 1 注销 2 IP 3 MAC 4 时长 5 流量 …）；
 *   - **对象行**（`getUserOnlineLog`）：字段名是 `macAddress`（实测 2026-10-11，
 *     `{"area":1,…,"macAddress":"AA:BB:CC:DD:EE:FF",…}`）；
 *   - 归一化后的对象行（`out.rows`）：字段名是 `mac`。
 *
 * @param {Array} rows 原始行数组（可为数组行或对象行）
 * @returns {string[]} 归一化后的 MAC（已去重、已剔除不合法项）
 */
const MAC_FIELD_KEYS = ['mac', 'macAddress', 'macAddr', 'userMac'];

function macsFromHistoryRows(rows) {
  const out = new Set();
  for (const a of Array.isArray(rows) ? rows : []) {
    let cand = '';
    if (Array.isArray(a)) {
      cand = a[3];
    } else if (a && typeof a === 'object') {
      for (const k of MAC_FIELD_KEYS) { if (a[k]) { cand = a[k]; break; } }
      if (!cand) cand = Object.values(a)[3]; // 有些接口把行当"按列索引的对象"返回
    }
    const k = normMac(cand);
    if (k) out.add(k);
  }
  return [...out];
}

/**
 * 判定一条设备 / 在线会话与本机的关系。
 * @param {{mac?: string, ip?: string}} item
 * @param {{macsHex?: Set<string>, ips?: Set<string>, seen?: Set<string>}} local
 *        本机信息：macsHex = **当前**网卡 MAC（归一化）、ips = 当前 IPv4、
 *        seen = 当前 + 历史上的 MAC
 * @returns {'self' | 'maybe' | ''} self = 确凿是本机；maybe = 可能是本机旧会话；'' = 都不是
 */
function selfKind(item, local) {
  const it = item || {};
  const lc = local || {};
  const k = normMac(it.mac);
  const cur = lc.macsHex instanceof Set ? lc.macsHex : new Set();
  const ips = lc.ips instanceof Set ? lc.ips : new Set();
  const seen = lc.seen instanceof Set ? lc.seen : cur;
  // 当前网卡 MAC 或当前 IP 命中 → 确凿是本机
  if (k && cur.has(k)) return 'self';
  if (it.ip && ips.has(it.ip)) return 'self';
  // 命中「本机以前用过的 MAC」→ 可能是本机旧会话
  if (k && seen.has(k) && !cur.has(k)) return 'maybe';
  return '';
}

/**
 * 是否可以对这批占用设备「自动解绑、不经用户确认」。
 * 规则：**全部**落在「可能本机旧会话」（maybeSelf）→ 判定为自己换过 MAC 造成的旧会话，自动处理。
 * 只要混入一条非 maybeSelf（可能是别人的设备），就必须交回用户确认。
 * @param {Array<{maybeSelf?: boolean}>} others
 * @returns {boolean}
 */
function shouldAutoUnbind(others) {
  const list = Array.isArray(others) ? others : [];
  return list.length > 0 && list.every(d => !!(d && d.maybeSelf));
}

module.exports = { normMac, rememberMacs, seenMac, macsFromHistoryRows, selfKind, shouldAutoUnbind, MAC_HEX_LEN };
