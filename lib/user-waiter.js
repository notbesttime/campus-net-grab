'use strict';
/* 等待用户输入（验证码 / 占用确认）的可测试实现
 *
 * 语义：
 *   - 用户提交   → resolve(值)，值为字符串（验证码 / 'continue' / 'pause'）
 *   - 等待超时   → resolve(null)
 *   - 被主动取消 → resolve(CANCELLED)
 *
 * 注意：CANCELLED 是唯一的 Symbol，既不是 null 也不是字符串。
 * 调用方必须先判 CANCELLED，再判 !value，否则会把「取消」误当成「超时」。
 */

const CANCELLED = Symbol('user-waiter-cancelled');

function createUserWaiter() {
  // key -> { settle }；同一个 key 只保留最新一次等待（与原 job.waiters 行为一致）
  const pending = new Map();

  function wait(key, ms) {
    return new Promise(resolve => {
      let timer = null;
      const settle = value => {
        const cur = pending.get(key);
        if (!cur || cur.settle !== settle) return; // 已被同 key 的新等待取代
        pending.delete(key);
        clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => settle(null), ms || 120000);
      pending.set(key, { settle });
    });
  }

  function submit(key, value) {
    const cur = pending.get(key);
    if (!cur) return false;
    cur.settle(value);
    return true;
  }

  function cancel(key) {
    const cur = pending.get(key);
    if (!cur) return false;
    cur.settle(CANCELLED);
    return true;
  }

  function cancelAll() {
    let n = 0;
    for (const key of [...pending.keys()]) {
      if (cancel(key)) n++;
    }
    return n;
  }

  function pendingKeys() {
    return [...pending.keys()];
  }

  return { CANCELLED, wait, submit, cancel, cancelAll, pendingKeys };
}

module.exports = { CANCELLED, createUserWaiter };
