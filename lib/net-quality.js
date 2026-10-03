'use strict';
/* 网络质量检测（P2 档）：延迟 / 抖动 / DNS 解析耗时 / 首字节响应（TTFB）
 *
 * 纪律（与项目一致）：
 *  1. 零第三方依赖，只用 Node 内置 net / dns / http / https。
 *  2. 延迟与抖动**只用 TCP 握手**（复用 ./net-probe 的 tcpProbe）：连上即断，不发一个字节，
 *     因此不依赖 ping.exe，也不受 ICMP 被拦的影响。
 *  3. TTFB 会发一次无标识的 HTTP GET（固定 UA、不带 Cookie、不发正文），
 *     收到响应首字节立即断流，绝不下载正文。
 *  4. 目标分「国内 / 国外」两组，全部是公共地址 —— 校外、有线、热点都能测，
 *     不依赖校园门户，也不依赖任何校内接口。
 *  5. 统计与评级是纯函数（stats / combineStats / grade / overallGrade），可直接单测。
 *
 * 选点纪律（2026-10-03 实测踩坑后固化，改动前务必先读）：
 *  - **延迟测点必须用 TCP 443，绝不能用 53**。实测本机网络下有中间设备对**任意目标**的
 *    TCP 53 代答 SYN（连保留网段 192.0.2.1:53 都是 2ms「连通」），用 53 测出来的延迟是假的。
 *    443 经保留网段对照验证为真实路径。
 *  - **测点用域名，不要用裸 IP**。实测 1.1.1.1:443 / 8.8.8.8:443 直连全部超时，
 *    而同机 cp.cloudflare.com:443 只有 210ms —— 裸 IP 直连与域名解析后的路径待遇不同。
 *    所以先解析成 IPv4 再握手：既走真实路径，也让「延迟」不含 DNS 时间（DNS 单独测）。
 *  - **DNS 用 dns.lookup（系统解析器），不要只用 resolve4**。实测本机 dns.getServers()
 *    返回 ['127.0.0.1'] 而本地 53 端口无监听，resolve4 必然 ECONNREFUSED；
 *    lookup 走 getaddrinfo，结果与用户真实体感一致（1~12ms）。
 *    为避免系统 DNS 缓存把结果压成 0ms，测点域名按轮次轮换。
 *
 * 术语：TTFB 取「收到响应首字节」的时刻，对 https 而言**包含 TLS 握手**，
 * 与浏览器第一次打开页面的体验一致。
 */
const dns = require('dns');
const http = require('http');
const https = require('https');
const { tcpProbe } = require('./net-probe');

/* ---------------- 可调参数 ---------------- */
const LATENCY_PORT = 443;         // 见上文「选点纪律」：必须 443，不能用 53
const LATENCY_SAMPLES = 4;        // 每个目标的采样次数（抖动需要 >= 2 次）
const SAMPLE_GAP_MS = 50;         // 同一目标两次采样之间的间隔
const LATENCY_TIMEOUT_MS = 3000;
const DNS_TIMEOUT_MS = 3000;
const DNS_PER_GROUP = 2;          // 每组测几个域名
const TTFB_TIMEOUT_MS = 2500;     // 2.5s 已属「较差」，再等不加信息量，只是白等
// 单次检测的总时间预算：网络不通时每个探测都要等到各自超时，不设上限的话
// 最坏情况会累到 45s 以上（页面还按 60s 间隔自动重测 → 等于连续探测）。
// 预算用尽就跳过剩余探测并标记 truncated，宁可给一份不完整的报告也别拖住。
// 是**软预算**：超时后不再开始新探测，但已经在跑的那个会等自己的超时结束，
// 所以实际用时最长约为 DEADLINE_MS + 单次探测超时（3s）。
const DEADLINE_MS = 15000;


/* ---------------- 探测目标（全部为公共地址，见实测备注） ---------------- */
const LATENCY_TARGETS = {
  domestic: [
    { name: '百度', host: 'www.baidu.com' },      // 实测 ~42ms
    { name: '腾讯', host: 'www.qq.com' },         // 实测 ~35ms
  ],
  foreign: [
    { name: 'GitHub', host: 'github.com' },       // 实测 ~105ms
    { name: 'Cloudflare', host: 'cp.cloudflare.com' }, // 实测 ~210ms
  ],
};

// DNS 测点池：按轮次轮换，避免总打同一个域名而被系统缓存命中（那样只会读到 0ms）
const DNS_POOL = {
  domestic: ['www.baidu.com', 'www.qq.com', 'www.taobao.com', 'www.bilibili.com'],
  foreign: ['www.cloudflare.com', 'www.microsoft.com', 'www.apple.com', 'www.github.com'],
};

const TTFB_TARGETS = {
  domestic: { name: '百度', url: 'https://www.baidu.com/' },         // 实测 ~142ms / 200
  foreign: { name: 'Cloudflare', url: 'https://cp.cloudflare.com/' }, // 实测 ~925ms / 204
};

const GROUP_LABELS = { domestic: '国内', foreign: '国外' };
const GROUP_ORDER = ['domestic', 'foreign'];

/* ---------------- 纯函数：统计与评级 ---------------- */

/**
 * 对一组毫秒样本做统计。
 * @param {number[]} values 成功的样本（毫秒）
 * @param {number} [attempted] 实际尝试次数；多于样本数的部分即为超时次数
 * @returns {{n:number,timeout:number,min:number|null,avg:number|null,max:number|null,jitter:number|null}}
 */
function stats(values, attempted) {
  const vs = (values || []).filter(v => typeof v === 'number' && isFinite(v) && v >= 0);
  const tried = Number.isInteger(attempted) ? attempted : vs.length;
  const out = {
    n: vs.length,
    timeout: Math.max(0, tried - vs.length),
    min: null, avg: null, max: null, jitter: null,
  };
  if (!vs.length) return out;
  out.min = Math.round(Math.min(...vs));
  out.max = Math.round(Math.max(...vs));
  out.avg = Math.round(vs.reduce((a, b) => a + b, 0) / vs.length);
  if (vs.length < 2) { out.jitter = 0; return out; }
  // 抖动 = 相邻样本差值绝对值的平均（比标准差更贴近「忽快忽慢」的体感）
  let sum = 0;
  for (let i = 1; i < vs.length; i++) sum += Math.abs(vs[i] - vs[i - 1]);
  out.jitter = Math.round(sum / (vs.length - 1));
  return out;
}

/**
 * 把多个测点的统计合并成「整组」视图。
 * 平均值取各测点平均值的平均；**抖动取最差的测点**——抖动衡量的是同一条路径稳不稳，
 * 不能被「另一个测点更稳」平均掉。
 * @param {object[]} list 各测点的 stats 结果
 */
function combineStats(list) {
  const arr = (list || []).filter(s => s && typeof s === 'object');
  const pick = key => arr.map(s => s[key]).filter(v => typeof v === 'number' && isFinite(v));
  const avgs = pick('avg');
  const mins = pick('min');
  const maxs = pick('max');
  const jits = pick('jitter');
  return {
    n: arr.reduce((a, s) => a + (s.n || 0), 0),
    timeout: arr.reduce((a, s) => a + (s.timeout || 0), 0),
    min: mins.length ? Math.min(...mins) : null,
    avg: avgs.length ? Math.round(avgs.reduce((a, b) => a + b, 0) / avgs.length) : null,
    max: maxs.length ? Math.max(...maxs) : null,
    jitter: jits.length ? Math.max(...jits) : null,
  };
}

// 阈值表：`< limit` 即命中该档，都不满足则为 poor（单位毫秒）
const THRESHOLDS = {
  latency: [[50, 'excellent'], [100, 'good'], [200, 'fair']],
  jitter: [[10, 'excellent'], [30, 'good'], [60, 'fair']],
  dns: [[50, 'excellent'], [150, 'good'], [400, 'fair']],
  ttfb: [[300, 'excellent'], [800, 'good'], [1500, 'fair']],
};
const GRADE_LABELS = { excellent: '优秀', good: '良好', fair: '一般', poor: '较差', unknown: '—' };
const GRADE_RANK = { excellent: 3, good: 2, fair: 1, poor: 0, unknown: -1 };

/** 按指标类型给单个数值定档；拿不到数值（null/超时）统一为 unknown */
function grade(kind, ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return 'unknown';
  const table = THRESHOLDS[kind];
  if (!table) return 'unknown';
  for (const [limit, g] of table) if (ms < limit) return g;
  return 'poor';
}

function gradeLabel(g) { return GRADE_LABELS[g] || GRADE_LABELS.unknown; }

/** 综合评级 = 各分项里最差的一档；unknown 不参与，全 unknown 则 overall 为 unknown */
function overallGrade(grades) {
  const valid = (grades || []).filter(g => g && g !== 'unknown');
  if (!valid.length) return 'unknown';
  return valid.reduce((worst, g) => (GRADE_RANK[g] < GRADE_RANK[worst] ? g : worst));
}

/* ---------------- IO：探测 ---------------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** 域名 → IPv4；已经是 IPv4 就原样返回。失败返回 error 字符串 */
async function resolveHost(host, timeoutMs) {
  if (IPV4_RE.test(host)) return { ip: host, error: null };
  const started = Date.now();
  try {
    const r = await withTimeout(
      dns.promises.lookup(host, { family: 4 }),
      timeoutMs, () => null);
    if (!r || !r.address) return { ip: null, error: '解析超时' };
    return { ip: r.address, error: null, dnsMs: Date.now() - started };
  } catch (e) {
    return { ip: null, error: (e && (e.code || e.message)) || '解析失败' };
  }
}

/** 给没有超时参数的 Promise 加一层超时，超时返回 fallback() */
function withTimeout(p, ms, fallback) {
  return new Promise(resolve => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(fallback()); } }, ms);
    const settle = v => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    p.then(settle, settle);
  });
}

/** 单个测点：先解析成 IP，再连 n 次（延迟里不含 DNS 时间）。deadline 到了就少采几次 */
async function sampleLatency(target, n, timeoutMs, expired) {
  const r = await resolveHost(target.host, timeoutMs);
  if (!r.ip) return { name: target.name, host: target.host, ip: null, ...stats([], n), error: r.error };
  const values = [];
  let tried = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0 && expired && expired()) break;
    tried++;
    const p = await tcpProbe(r.ip, LATENCY_PORT, timeoutMs);
    if (p.ok) values.push(p.ms);
    if (i < n - 1) await sleep(SAMPLE_GAP_MS);
  }
  const s = stats(values, tried);
  return {
    name: target.name, host: target.host, ip: r.ip, ...s,
    // 预算用尽导致没采满的，额外标一下，界面上能看出这份数字是「打折」的
    partial: tried < n ? true : undefined,
  };
}

/** 一组延迟：逐个测点采样，再合并成整组视图 */
async function measureLatency(targets, n, timeoutMs, expired) {
  const detail = [];
  for (const t of targets) {
    if (expired && expired() && detail.length) break;
    detail.push(await sampleLatency(t, n, timeoutMs, expired));
  }
  return { ...combineStats(detail), targets: detail, partial: expired && expired() ? true : undefined };
}

/** DNS 解析耗时（走系统解析器，与用户体感一致） */
function lookupTimed(name, timeoutMs) {
  const started = Date.now();
  return new Promise(resolve => {
    let done = false;
    const finish = (ms, error) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      resolve({ name, ms, error: error || null });
    };
    const killer = setTimeout(() => finish(null, '超时'), timeoutMs);
    dns.promises.lookup(name, { family: 4 })
      .then(r => finish(Date.now() - started, r && r.address ? null : '无解析结果'))
      .catch(e => finish(null, (e && (e.code || e.message)) || '解析失败'));
  });
}

// 轮换游标：让每一轮检测打到不同的域名，避免系统 DNS 缓存把耗时压成 0
let dnsTurn = 0;

/** 从池子里取 count 个域名（按轮次错开） */
function pickDnsNames(group, count) {
  const pool = DNS_POOL[group] || [];
  if (!pool.length) return [];
  const out = [];
  for (let i = 0; i < Math.min(count, pool.length); i++) out.push(pool[(dnsTurn + i) % pool.length]);
  dnsTurn = (dnsTurn + count) % pool.length;
  return out;
}

async function measureDns(group, count, timeoutMs) {
  const names = pickDnsNames(group, count);
  const detail = [];
  for (const n of names) detail.push(await lookupTimed(n, timeoutMs));
  const ok = detail.filter(d => typeof d.ms === 'number' && isFinite(d.ms));
  const avg = ok.length ? Math.round(ok.reduce((a, d) => a + d.ms, 0) / ok.length) : null;
  return {
    name: detail.map(d => d.name).join(' / '),
    avg,
    ms: detail.length ? detail[0].ms : null,
    error: ok.length ? null : ((detail[0] && detail[0].error) || '解析失败'),
    grade: grade('dns', avg),
    targets: detail,
  };
}

/**
 * TTFB：GET 目标 URL，收到响应首字节立刻断流。
 * @returns {Promise<{name:string,url:string,ms:number|null,status:number|null,error:string|null}>}
 */
function probeTtfb(target, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    let killer = null;
    const started = Date.now();
    const lib = target.url.startsWith('https:') ? https : http;
    const finish = (ms, status, error) => {
      if (done) return;
      done = true;
      if (killer) clearTimeout(killer);
      resolve({ name: target.name, url: target.url, ms, status, error: error || null });
    };
    let req;
    try {
      req = lib.get(target.url, {
        headers: { 'User-Agent': 'campus-net-grab-netcheck/1.0', Accept: '*/*' },
      }, res => {
        // 回调触发 = 已收到响应首字节（含 TLS 握手）
        const ms = Date.now() - started;
        const status = res.statusCode || 0;
        finish(ms, status, status >= 400 ? 'HTTP ' + status : null);
        try { res.destroy(); } catch (e) { /* 忽略 */ }
      });
    } catch (e) {
      return finish(null, null, e.message);
    }
    killer = setTimeout(() => {
      if (done) return;
      finish(null, null, '超时');
      try { req.destroy(); } catch (e) { /* 忽略 */ }
    }, timeoutMs);
    req.on('error', e => finish(null, null, (e && (e.code || e.message)) || '连接失败'));
  });
}

async function measureTtfb(target, timeoutMs) {
  if (!target) return { name: '', url: '', ms: null, status: null, error: '未配置目标', grade: 'unknown' };
  const r = await probeTtfb(target, timeoutMs);
  return { ...r, grade: r.error ? 'unknown' : grade('ttfb', r.ms) };
}

/* ---------------- 编排 ---------------- */

/* 预算用尽时的占位结果：形状与正常结果一致，界面不用为「跳过」写分支 */
const SKIP = '已跳过（时间预算用尽）';
function skippedLatency(targets) {
  return {
    ...combineStats([]),
    skipped: true,
    targets: (targets || []).map(t => ({ name: t.name, host: t.host, ip: null, ...stats([], 0), error: SKIP })),
  };
}
function skippedDns() {
  return { name: '—', avg: null, ms: null, error: SKIP, grade: 'unknown', targets: [], skipped: true };
}
function skippedTtfb(target) {
  const t = target || { name: '', url: '' };
  return { name: t.name, url: t.url, ms: null, status: null, error: SKIP, grade: 'unknown', skipped: true };
}

/**
 * 跑一次完整检测。
 * 组间串行、组内先延迟后 DNS 再 TTFB —— 避免并发探测互相挤占，把抖动数字打高。
 * 全程受 deadlineMs 约束，用尽即跳过剩余步骤并置 truncated，不拖住页面。
 * @returns {Promise<object>} 报告：{ at, durationMs, truncated, groups: { domestic, foreign }, grade }
 */
async function runCheck(opts) {
  const o = opts || {};
  const groups = (o.groups && o.groups.length ? o.groups : GROUP_ORDER)
    .filter(g => LATENCY_TARGETS[g] || DNS_POOL[g] || TTFB_TARGETS[g]);
  const samples = o.samples || LATENCY_SAMPLES;
  const startedAt = Date.now();
  const deadline = startedAt + (o.deadlineMs || DEADLINE_MS);
  const expired = () => Date.now() > deadline;
  const out = {
    at: startedAt, durationMs: 0, port: LATENCY_PORT,
    groups: {}, grade: 'unknown', truncated: false,
  };
  const groupGrades = [];

  for (const g of groups) {
    const latency = expired()
      ? skippedLatency(LATENCY_TARGETS[g])
      : await measureLatency(LATENCY_TARGETS[g] || [], samples,
        o.latencyTimeoutMs || LATENCY_TIMEOUT_MS, expired);
    const dns = expired() ? skippedDns()
      : await measureDns(g, o.dnsPerGroup || DNS_PER_GROUP, o.dnsTimeoutMs || DNS_TIMEOUT_MS);
    const ttfb = expired() ? skippedTtfb(TTFB_TARGETS[g])
      : await measureTtfb(TTFB_TARGETS[g], o.ttfbTimeoutMs || TTFB_TIMEOUT_MS);
    // 延迟定档取「平均延迟」与「抖动」里更差的那个：平均好但抖动大，体感一样差
    const latGrade = overallGrade([grade('latency', latency.avg), grade('jitter', latency.jitter)]);
    // 有整块被跳过时这一组不算「结论」：没测到的项不能当成达标，否则会得出「全项优秀」的假结论
    const complete = !latency.skipped && !dns.skipped && !ttfb.skipped;
    const gGrade = complete ? overallGrade([latGrade, dns.grade, ttfb.grade]) : 'unknown';
    out.groups[g] = {
      label: GROUP_LABELS[g] || g,
      latency: { ...latency, grade: latGrade },
      dns,
      ttfb,
      grade: gGrade,
    };
    groupGrades.push(gGrade);
  }

  out.truncated = expired();
  // 提前结束时不给综合结论：测了一半就说「优秀」比不给结论更误导
  out.grade = out.truncated ? 'unknown' : overallGrade(groupGrades);
  out.durationMs = Date.now() - startedAt;
  return out;
}

module.exports = {
  runCheck,
  // 纯函数（供单测）
  stats, combineStats, grade, gradeLabel, overallGrade,
  // 目标与常量（供文档 / 界面展示）
  LATENCY_TARGETS, DNS_POOL, TTFB_TARGETS,
  GROUP_LABELS, GROUP_ORDER, LATENCY_SAMPLES,
  LATENCY_PORT, SAMPLE_GAP_MS, DNS_PER_GROUP, DEADLINE_MS,
  LATENCY_TIMEOUT_MS, DNS_TIMEOUT_MS, TTFB_TIMEOUT_MS,
};
