'use strict';
/* 互斥租约（纯逻辑 + 可注入时钟，便于单测）
 *
 * 为什么需要它：
 *   自助后台客户端 `self` 是**单例**，它的 `checkcode` 与 cookie jar 被所有登录流程共享。
 *   两个登录流程并发时，`login()` 里 `if (!code)` 分支会 `openLogin()` **覆盖 checkcode**，
 *   让「在飞」的那次验证码提交带上旧码 → 服务端静默弹回登录页（不给任何原因）→
 *   用户看到兜底文案「按顺序排查」（实测 2026-10-11）。
 *   这里给登录加一把**带超时的租约**：谁先拿谁独占；超过租期自动失效，因此即使持有方
 *   异常退出也不会死锁（不需要人工解锁）。
 */

/**
 * @param {() => number} [nowFn] 时钟注入点（默认 Date.now），单测里传假时钟
 */
function createLease(nowFn) {
  const now = typeof nowFn === 'function' ? nowFn : Date.now;
  let until = 0;
  let owner = '';
  return {
    /** 尝试获取租约：成功 true；已被别人持有 false（**不等待**，由调用方决定重试还是放弃） */
    acquire(name, ms) {
      const t = now();
      if (t < until) return false;
      until = t + Math.max(0, Number(ms) || 0);
      owner = String(name == null ? '' : name);
      return true;
    },
    /** 释放：只有持有者本人能释放（避免 A 误放掉 B 的租约） */
    release(name) {
      if (until && owner === String(name == null ? '' : name)) {
        until = 0;
        owner = '';
        return true;
      }
      return false;
    },
    /** 当前持有者名（无人持有返回空串） */
    heldBy() {
      return now() < until ? owner : '';
    },
    /** 剩余毫秒（无人持有返回 0） */
    remaining() {
      const t = now();
      return t < until ? until - t : 0;
    },
  };
}

module.exports = { createLease };
