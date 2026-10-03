'use strict';
/* lib/net-quality.js 纯函数单测（不联网：只测统计与评级，不触发任何探测） */
const test = require('node:test');
const assert = require('node:assert');
const {
  stats, combineStats, grade, gradeLabel, overallGrade,
  LATENCY_TARGETS, DNS_POOL, TTFB_TARGETS, GROUP_ORDER, LATENCY_PORT,
} = require('../lib/net-quality');

test('stats：空样本返回全空且不报错', () => {
  const s = stats([]);
  assert.deepStrictEqual(s, { n: 0, timeout: 0, min: null, avg: null, max: null, jitter: null });
  assert.deepStrictEqual(stats(null), { n: 0, timeout: 0, min: null, avg: null, max: null, jitter: null });
});

test('stats：单样本抖动为 0，min/avg/max 相同', () => {
  const s = stats([42]);
  assert.strictEqual(s.n, 1);
  assert.strictEqual(s.min, 42);
  assert.strictEqual(s.avg, 42);
  assert.strictEqual(s.max, 42);
  assert.strictEqual(s.jitter, 0);
});

test('stats：min/avg/max 取整', () => {
  const s = stats([10, 20, 15]);
  assert.strictEqual(s.min, 10);
  assert.strictEqual(s.max, 20);
  assert.strictEqual(s.avg, 15);
});

test('stats：抖动 = 相邻差值绝对值的平均', () => {
  // |10-20| = 10，|15-20| = 5 → (10+5)/2 = 7.5 → 8
  assert.strictEqual(stats([10, 20, 15]).jitter, 8);
  // 匀速递增时抖动等于步长
  assert.strictEqual(stats([10, 20, 30, 40]).jitter, 10);
});

test('stats：attempted 多于样本数时记为超时次数', () => {
  const s = stats([30, 40], 4);
  assert.strictEqual(s.n, 2);
  assert.strictEqual(s.timeout, 2);
});

test('stats：attempted 缺省或非整数时按样本数算，超时为 0', () => {
  assert.strictEqual(stats([1, 2]).timeout, 0);
  assert.strictEqual(stats([1, 2], 2.5).timeout, 0);
});

test('stats：过滤掉非数值、负数与非有限值', () => {
  const s = stats([10, NaN, -5, Infinity, '20', 30]);
  assert.strictEqual(s.n, 2);
  assert.strictEqual(s.min, 10);
  assert.strictEqual(s.max, 30);
});

test('combineStats：平均值取各测点平均值的平均，min/max 取极值', () => {
  const a = stats([10, 20, 30], 3);   // avg 20 min 10 max 30 jitter 10
  const b = stats([40, 60], 2);       // avg 50 min 40 max 60 jitter 20
  const c = combineStats([a, b]);
  assert.strictEqual(c.avg, 35);
  assert.strictEqual(c.min, 10);
  assert.strictEqual(c.max, 60);
  assert.strictEqual(c.n, 5);
  assert.strictEqual(c.timeout, 0);
});

test('combineStats：抖动取最差的测点，不被更稳的测点平均掉', () => {
  const steady = stats([100, 100, 100], 3);      // jitter 0
  const jittery = stats([100, 300, 100], 3);     // jitter 200
  assert.strictEqual(combineStats([steady, jittery]).jitter, 200);
  assert.strictEqual(combineStats([steady]).jitter, 0);
});

test('combineStats：超时累加，全部无样本时平均值为 null', () => {
  const ok = stats([30, 40], 4);   // n 2 timeout 2
  const dead = stats([], 4);       // n 0 timeout 4
  const c = combineStats([ok, dead]);
  assert.strictEqual(c.timeout, 6);
  assert.strictEqual(c.n, 2);
  assert.strictEqual(c.avg, 35);
  assert.strictEqual(combineStats([dead, stats([], 4)]).avg, null);
});

test('combineStats：空输入与非法条目安全返回', () => {
  assert.deepStrictEqual(combineStats([]), { n: 0, timeout: 0, min: null, avg: null, max: null, jitter: null });
  assert.deepStrictEqual(combineStats(null), { n: 0, timeout: 0, min: null, avg: null, max: null, jitter: null });
  assert.strictEqual(combineStats([null, undefined, 7]).n, 0);
});

test('grade：延迟阈值分档正确', () => {
  assert.strictEqual(grade('latency', 0), 'excellent');
  assert.strictEqual(grade('latency', 49), 'excellent');
  assert.strictEqual(grade('latency', 50), 'good');
  assert.strictEqual(grade('latency', 99), 'good');
  assert.strictEqual(grade('latency', 100), 'fair');
  assert.strictEqual(grade('latency', 199), 'fair');
  assert.strictEqual(grade('latency', 200), 'poor');
  assert.strictEqual(grade('latency', 9999), 'poor');
});

test('grade：抖动 / DNS / TTFB 三张阈值表各自独立', () => {
  assert.strictEqual(grade('jitter', 9), 'excellent');
  assert.strictEqual(grade('jitter', 10), 'good');
  assert.strictEqual(grade('jitter', 60), 'poor');
  assert.strictEqual(grade('dns', 49), 'excellent');
  assert.strictEqual(grade('dns', 400), 'poor');
  assert.strictEqual(grade('ttfb', 299), 'excellent');
  assert.strictEqual(grade('ttfb', 1500), 'poor');
});

test('grade：拿不到数值或指标类型未知时为 unknown', () => {
  assert.strictEqual(grade('latency', null), 'unknown');
  assert.strictEqual(grade('latency', undefined), 'unknown');
  assert.strictEqual(grade('latency', NaN), 'unknown');
  assert.strictEqual(grade('latency', -1), 'unknown');
  assert.strictEqual(grade('latency', Infinity), 'unknown');
  assert.strictEqual(grade('没有这个指标', 10), 'unknown');
});

test('gradeLabel：返回中文档位，未知档位回落为破折号', () => {
  assert.strictEqual(gradeLabel('excellent'), '优秀');
  assert.strictEqual(gradeLabel('good'), '良好');
  assert.strictEqual(gradeLabel('fair'), '一般');
  assert.strictEqual(gradeLabel('poor'), '较差');
  assert.strictEqual(gradeLabel('unknown'), '—');
  assert.strictEqual(gradeLabel('乱写'), '—');
});

test('overallGrade：取最差的一档', () => {
  assert.strictEqual(overallGrade(['excellent', 'good', 'fair']), 'fair');
  assert.strictEqual(overallGrade(['excellent', 'poor']), 'poor');
  assert.strictEqual(overallGrade(['good', 'good']), 'good');
});

test('overallGrade：unknown 不参与，全 unknown 才是 unknown', () => {
  assert.strictEqual(overallGrade(['unknown', 'good']), 'good');
  assert.strictEqual(overallGrade(['unknown', 'unknown']), 'unknown');
  assert.strictEqual(overallGrade([]), 'unknown');
  assert.strictEqual(overallGrade(null), 'unknown');
});

test('目标配置：国内 / 国外两组都不为空，且每个延迟目标有名字与主机', () => {
  assert.deepStrictEqual(GROUP_ORDER, ['domestic', 'foreign']);
  for (const g of GROUP_ORDER) {
    assert.ok(LATENCY_TARGETS[g] && LATENCY_TARGETS[g].length, g + ' 缺少延迟目标');
    for (const t of LATENCY_TARGETS[g]) {
      assert.ok(t.name && t.host, g + ' 的延迟目标缺少 name/host');
    }
    assert.ok(DNS_POOL[g] && DNS_POOL[g].length, g + ' 缺少 DNS 测点池');
    assert.ok(TTFB_TARGETS[g] && TTFB_TARGETS[g].url, g + ' 缺少 TTFB 目标');
  }
});

test('选点纪律：延迟必须走 TCP 443，绝不能用 53', () => {
  // 实测：53 端口会被中间设备对任意目标代答（连保留网段都是 2ms「连通」），
  // 用 53 测出来的延迟是假的。这条断言是防回归的。
  assert.strictEqual(LATENCY_PORT, 443);
});

test('选点纪律：延迟测点用域名而不是裸 IP', () => {
  // 实测：1.1.1.1:443 / 8.8.8.8:443 裸 IP 直连全超时，而域名解析后可达
  for (const g of GROUP_ORDER) {
    for (const t of LATENCY_TARGETS[g]) {
      assert.ok(!/^\d{1,3}(\.\d{1,3}){3}$/.test(t.host),
        g + ' 的测点 ' + t.host + ' 是裸 IP，违反选点纪律');
    }
  }
});

test('选点纪律：DNS 测点池是域名，且池子足够大以避开系统缓存', () => {
  for (const g of GROUP_ORDER) {
    assert.ok(DNS_POOL[g].length >= 3, g + ' 的 DNS 测点池太小，轮换后仍容易被缓存命中');
    for (const n of DNS_POOL[g]) {
      assert.ok(/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(n), g + ' 的 DNS 测点不是域名：' + n);
    }
  }
});

test('目标配置：TTFB 目标是 http(s) 绝对地址', () => {
  for (const g of GROUP_ORDER) {
    assert.match(TTFB_TARGETS[g].url, /^https?:\/\//, g + ' 的 TTFB 地址不是绝对 URL');
  }
});
