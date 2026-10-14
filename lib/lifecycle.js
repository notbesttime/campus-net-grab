'use strict';
/* 服务生命周期判定（纯函数，便于单测）。
 *
 * 来源：server.js 里那段「控制台页面心跳 → 关闭网页后自动退出」的看门狗。
 * 抽出来是为了把阈值和取舍集中到一处（原来散在 server.js 的三个常量里），
 * 并且可以脱离进程/文件做单测。
 *
 * 行为就是一条：**关掉控制台网页 → 本地服务退出**；打不开页面（浏览器没弹出来）
 * 也不会留僵尸。§8 第 3 条曾计划由启动器托盘接管生命周期、让服务不再自退，
 * 2026-10-15 试过一版后按用户实测反馈**撤掉了**——托盘图标会被折叠进任务栏、
 * 用户看不到，关掉网页后进程却还占着文件夹删不掉（见踩坑记录 §19.16）。
 * 所以托管/非托管是同一套判定，没有开关。
 *
 * 这里只做判定，不碰进程、不碰文件——副作用留在 server.js。
 */

const DEFAULTS = {
  goodbyeGraceMs: 10000,     // pagehide 后仍允许刷新/短中断
  heartbeatTimeoutMs: 120000, // 页面心跳超时（后台标签页会被浏览器节流，故放宽）
  noClientExitMs: 180000,     // 启动后一直没人打开控制台则退出（浏览器可能没弹出）
  suspendGapMs: 30000,        // 单次巡检间隔超过它 → 判定刚从休眠/冻结恢复
  resumeSlackMs: 20000,       // 恢复后额外给的宽限（一个心跳周期再多一点）
};

/**
 * 计算一次心跳巡检该做什么。
 * @param {{startedAt:number,lastAliveAt:number,goodbyeAt:number,everAlive:boolean}} state
 * @param {number} now      当前时间戳（ms）
 * @param {number} tickGap  距上一次巡检的间隔（ms）
 * @returns {{lastAliveAt:number, exit:boolean, reason:string}}
 */
function planHeartbeatTick(state, now, tickGap) {
  const o = DEFAULTS;
  let lastAliveAt = state.lastAliveAt || 0;

  // 刚从休眠/整机冻结恢复：心跳空档是机器睡出来的，不是页面失联，
  // 把 lastAliveAt 往前推到「刚好超时之前」，给页面一个心跳周期自证还活着。
  if (tickGap > o.suspendGapMs) {
    lastAliveAt = Math.max(lastAliveAt, now - o.heartbeatTimeoutMs + o.resumeSlackMs);
  }

  if (state.everAlive) {
    const away = now - lastAliveAt > o.heartbeatTimeoutMs;
    const bye = !!state.goodbyeAt &&
      (now - state.goodbyeAt) > o.goodbyeGraceMs &&
      (now - lastAliveAt) > o.goodbyeGraceMs;
    if (away || bye) return { lastAliveAt, exit: true, reason: away ? 'away' : 'goodbye' };
    return { lastAliveAt, exit: false, reason: '' };
  }

  if (now - state.startedAt > o.noClientExitMs) {
    return { lastAliveAt, exit: true, reason: 'no-client' };
  }
  return { lastAliveAt, exit: false, reason: '' };
}

module.exports = { planHeartbeatTick, DEFAULTS };