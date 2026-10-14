'use strict';
/* 服务生命周期判定（纯函数，便于单测）。
 *
 * 来源：server.js 里那段「控制台页面心跳 → 关闭网页后自动退出」的看门狗。
 * 背景见 AI_PROJECT_CONTEXT.md §8 第 3 条：打包走「薄 GUI 启动器」后，
 * 生命周期由启动器的托盘接管（托盘退出才关服务），服务不再靠心跳自杀。
 * 启动器启动服务时会带上 CNAL_MANAGED=1，本模块据此直接判定「不自退」。
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
 * @param {{managed?:boolean}} [opts] managed=true 表示生命周期由启动器接管
 * @returns {{lastAliveAt:number, exit:boolean, reason:string}}
 */
function planHeartbeatTick(state, now, tickGap, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const lastAliveAt0 = state.lastAliveAt || 0;

  // 启动器托管：永不因页面关闭而自退（退出由托盘的「退出」负责）
  if (o.managed) return { lastAliveAt: lastAliveAt0, exit: false, reason: 'managed' };

  let lastAliveAt = lastAliveAt0;
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