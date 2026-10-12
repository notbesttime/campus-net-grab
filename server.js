'use strict';
/* ============================================================
 * 校园网抢抢抢 · 本地服务
 * Node.js >= 18，零第三方依赖，仅监听 127.0.0.1。
 * 职责：门户状态/登录、自助服务(解绑/预检)、DPAPI 密码保险库、
 *       连接任务编排(SSE 日志)、WiFi(netsh)、诊断抓取。
 * ============================================================ */
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { resolveUnbindTarget } = require('./lib/unbind-target');
const { createUserWaiter, CANCELLED } = require('./lib/user-waiter');
const { writeFileAtomic, parseVaultText } = require('./lib/file-store');
const { tcpProbe } = require('./lib/net-probe');
const { applyNote, parseNotesText } = require('./lib/ip-notes');
const { runCheck: runNetCheck } = require('./lib/net-quality');
const { normMac, rememberMacs, macsFromHistoryRows, selfKind, shouldAutoUnbind } = require('./lib/self-id');
const { createLease } = require('./lib/lease');
const { occupancyPrompt } = require('./lib/occupancy-prompt');

const PORT_START = 8787;
const ROOT = __dirname;
const VAULT_FILE = path.join(ROOT, 'vault.json');
const IP_NOTES_FILE = path.join(ROOT, 'ip-notes.json');
const SESSION_FILE = path.join(ROOT, '.selfsession');
const DIAG_DIR = path.join(ROOT, 'diag');
const CONSOLE_URL_FILE = path.join(ROOT, 'console.url');
// 本机历史上用过的 MAC（见 lib/self-id.js）。含真实 MAC，已进 .gitignore 与公开仓库排除清单。
const MAC_HISTORY_FILE = path.join(ROOT, 'seen-macs.json');
const MAC_HISTORY_MAX = 60;
const OPEN_BROWSER = !process.env.NO_OPEN;
const TOKEN = crypto.randomBytes(16).toString('hex');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CampusNetAssistant/1.0';

/* 控制台页面心跳：关闭网页后本地服务自动退出 */
const CLIENT_ALIVE_INTERVAL_MS = 10000;
const GOODBYE_GRACE_MS = 10000;      // pagehide 后仍允许刷新/短中断
// 页面心跳 10s 一次，但浏览器对后台标签页会做定时器节流（隐藏约 5 分钟后强化节流，
// 最长 ~1 次/分钟）。45s 的门槛会被这种节流误杀：页面还开着，服务却自杀了。
// 放宽到 120s，真正的关闭仍由 pagehide 的 goodbye 信标即时兜底。
const HEARTBEAT_TIMEOUT_MS = 120000;
const NO_CLIENT_EXIT_MS = 180000;    // 启动后一直没人打开控制台则退出（浏览器可能没弹出）
const life = {
  startedAt: Date.now(),
  lastAliveAt: 0,
  goodbyeAt: 0,
  everAlive: false,
};

/* 终端日志镜像：隐藏窗口后仍可在网页查看 */
const termLog = [];
let termSeq = 0;
const TERM_LOG_MAX = 400;
function termLogPush(level, msg) {
  const line = { seq: ++termSeq, t: Date.now(), level, msg: String(msg) };
  termLog.push(line);
  if (termLog.length > TERM_LOG_MAX) termLog.splice(0, termLog.length - TERM_LOG_MAX);
}
const _consoleLog = console.log.bind(console);
const _consoleError = console.error.bind(console);
console.log = (...a) => { termLogPush('log', a.map(x => String(x)).join(' ')); _consoleLog(...a); };
console.error = (...a) => { termLogPush('err', a.map(x => String(x)).join(' ')); _consoleError(...a); };
function termLogLines(sinceSeq) {
  const s = Number(sinceSeq) || 0;
  return s ? termLog.filter(l => l.seq > s) : termLog.slice();
}

const CFG = {
  portal: 'https://auth.hnist.edu.cn',
  self: 'http://172.31.8.43:8080',
  ncsi: 'http://www.msftconnecttest.com/connecttest.txt',
};
// 校园网 SSID：单一来源，抢网切网与「网络检测」的网络身份判定共用同一个值
const CAMPUS_SSID = 'HNIST-student';

/* ---------------- 基础工具 ---------------- */
const now = () => Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = () => String(Math.floor(Math.random() * 10000 + 500));
const md5 = s => crypto.createHash('md5').update(s, 'utf8').digest('hex');

function pickJson(text) {
  const i = text.indexOf('{'), j = text.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('响应中未找到 JSON');
  return JSON.parse(text.slice(i, j + 1));
}

function decodeBody(buf, contentType) {
  let enc = 'utf8';
  const m = /charset=([\w-]+)/i.exec(contentType || '');
  if (m) enc = m[1].toLowerCase();
  if (enc === 'gb2312' || enc === 'gbk') enc = 'gbk';
  let s;
  try { s = new TextDecoder(enc).decode(buf); } catch { s = buf.toString('utf8'); }
  if (s.includes('\uFFFD')) {
    try { const g = new TextDecoder('gbk').decode(buf); if (!g.includes('\uFFFD')) s = g; } catch {}
  }
  return s;
}

/* ---------------- HTTP 客户端（cookie jar + 手动重定向） ---------------- */
class Http {
  constructor() { this.cookies = new Map(); }

  request(method, url, opts = {}) {
    const { form, headers = {}, timeout = 12000, redirects = 5 } = opts;
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(url); } catch (e) { return reject(e); }
      const lib = u.protocol === 'https:' ? https : http;
      let body = null;
      if (form) body = new URLSearchParams(form).toString();
      const hdr = {
        'User-Agent': UA,
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...headers,
      };
      const ck = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      if (ck) hdr.Cookie = ck;
      if (body) {
        hdr['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        hdr['Content-Length'] = Buffer.byteLength(body);
      }
      const req = lib.request(u, { method, headers: hdr, timeout }, res => {
        const set = res.headers['set-cookie'] || [];
        for (const s of set) {
          const m = /^([^=;]+)=([^;]*)/.exec(s);
          if (m) this.cookies.set(m[1].trim(), m[2].trim());
        }
        const status = res.statusCode || 0;
        const loc = res.headers.location;
        if (status >= 300 && status < 400 && loc && redirects > 0) {
          res.resume();
          const next = new URL(loc, u).toString();
          const nm = (status === 307 || status === 308) ? method : (method === 'POST' ? 'GET' : method);
          return resolve(this.request(nm, next, { ...opts, redirects: redirects - 1 }));
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status,
            headers: res.headers,
            buf,
            text: decodeBody(buf, res.headers['content-type']),
            finalUrl: u.toString(),
          });
        });
      });
      req.on('timeout', () => req.destroy(new Error('请求超时')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
}

/* ---------------- DPAPI（本机加密，Windows 当前用户） ---------------- */
const PS_PRELUDE = 'Add-Type -AssemblyName System.Security; ';

function decodePs(buf) {
  let s;
  try { s = new TextDecoder('gbk').decode(buf); } catch { s = buf.toString('utf8'); }
  if (s.includes('\uFFFD')) s = buf.toString('utf8');
  return s;
}

function psRun(script, envExtra) {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'buffer', windowsHide: true, timeout: 20000, env: { ...process.env, ...envExtra } }
  );
  const out = decodePs(r.stdout || Buffer.alloc(0));
  if (r.status !== 0) {
    const err = decodePs(r.stderr || Buffer.alloc(0));
    throw new Error('DPAPI 调用失败: ' + String(err || out || '').trim().slice(0, 300));
  }
  return out.trim();
}

function dpapiProtect(plain) {
  return psRun(
    PS_PRELUDE +
    "$b=[Text.Encoding]::UTF8.GetBytes($env:MIMO_PLAIN);" +
    "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);" +
    "[Convert]::ToBase64String($p)",
    { MIMO_PLAIN: plain }
  );
}

function dpapiUnprotect(b64) {
  return psRun(
    PS_PRELUDE +
    "$p=[Convert]::FromBase64String($env:MIMO_B64);" +
    "$b=[Security.Cryptography.ProtectedData]::Unprotect($p,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);" +
    "[Text.Encoding]::UTF8.GetString($b)",
    { MIMO_B64: b64 }
  );
}

/* ---------------- 密码保险库（只存密文） ---------------- */
let vault = { version: 1, accounts: [] };

function loadVault() {
  let raw;
  try {
    raw = fs.readFileSync(VAULT_FILE, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('读取保险库失败:', e.message);
    return; // 首次运行没有文件是正常的
  }
  const r = parseVaultText(raw);
  if (r.kind === 'ok') { vault = r.vault; return; }
  if (r.kind === 'empty') return;
  // 关键：不能静默吞掉。改名留证并报错，否则下一次 saveVault 会把唯一的证据覆盖掉。
  const bad = VAULT_FILE + '.bad-' + Date.now();
  try {
    fs.renameSync(VAULT_FILE, bad);
    console.error('保险库损坏，已备份为 ' + path.basename(bad) + '（' + r.error + '）；请在控制台重新添加账号');
  } catch (e2) {
    console.error('保险库损坏（' + r.error + '）且备份失败:', e2.message);
  }
}

function saveVault() {
  const wr = writeFileAtomic(VAULT_FILE, JSON.stringify(vault, null, 2), 'utf8');
  if (!wr.ok) console.error('保存保险库失败:', wr.error);
}

function vaultPublic() {
  return vault.accounts.map(a => ({
    id: a.id,
    username: a.username,
    suffix: a.suffix || '',
    remark: a.remark || '',
    hasPassword: !!a.enc,
    lastUsed: a.lastUsed || 0,
    created: a.created || 0,
  }));
}

const accountById = id => vault.accounts.find(a => a.id === id) || null;

/* ---------------- IP 备注（ip-notes.json） ----------------
 * 给「各 IP 用量」里的地址起名字，并同步显示到「绑定设备」表。
 * 不加密：不是敏感数据；但属于用户数据，所以放服务端文件而不是 localStorage——
 * 控制台 origin 含端口，8787 被占用换端口启动时 localStorage 会整体「看不见」。
 */
let ipNotes = {};

function loadIpNotes() {
  let raw;
  try {
    raw = fs.readFileSync(IP_NOTES_FILE, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('读取 IP 备注失败:', e.message);
    return; // 首次运行没有文件是正常的
  }
  if (!String(raw).trim()) return;
  const parsed = parseNotesText(raw);
  if (Object.keys(parsed).length) { ipNotes = parsed; return; }
  // 文件非空但解析不出任何有效条目 → 视为损坏：改名留证，别让下一次保存覆盖证据
  const bad = IP_NOTES_FILE + '.bad-' + Date.now();
  try {
    fs.renameSync(IP_NOTES_FILE, bad);
    console.error('IP 备注文件损坏，已备份为 ' + path.basename(bad) + '；备注已重置为空');
  } catch (e2) {
    console.error('IP 备注文件损坏且备份失败:', e2.message);
  }
}

function saveIpNotes() {
  const wr = writeFileAtomic(IP_NOTES_FILE, JSON.stringify(ipNotes, null, 2), 'utf8');
  if (!wr.ok) console.error('保存 IP 备注失败:', wr.error);
  return wr.ok;
}

function passwordOf(acc) {
  if (!acc || !acc.enc) return null;
  return dpapiUnprotect(acc.enc);
}

/* ---------------- Dr.COM 门户 ---------------- */
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const portalHttp = new Http(); // 门户 Cookie 需跨请求保留（先开登录页再登录）
async function portalStatus() {
  const url = `${CFG.portal}/drcom/chkstatus?callback=cb&jsVersion=4.X&v=${rnd()}&lang=zh`;
  let r;
  try {
    r = await new Http().request('GET', url, { timeout: 8000 });
  } catch (e) {
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|ETIMEDOUT|ECONNREFUSED|超时|timed? ?out/i.test(e.message)) {
      throw new Error('连不上校园认证服务器 auth.hnist.edu.cn（未连接校园网？请连接 HNIST-student 后重试）');
    }
    throw e;
  }
  let j;
  try { j = pickJson(r.text); }
  catch { throw new Error('认证服务器返回了非预期页面（可能未连接校园网或被拦截）'); }
  return {
    online: String(j.result) === '1',
    uid: j.uid || '',
    onlineSeconds: Number(j.time) || 0,
    flowKB: Number(j.flow) || 0,
    ip: j.v4ip || '',
  };
}

/* 围墙花园：门户显示在线，但网关未真正放行数据（flow≈0 / NCSI 仍被劫持） */
function isWalledGarden(st, nc) {
  if (!st || !st.online) return false;
  if (nc && nc.ok) return false;
  // flow 明显为 0，或始终无数据
  return !st.flowKB || Number(st.flowKB) < 1;
}

let lastRealMac = '';
function localMacHex() {
  // 必须取真实网卡（WLAN/有线），不能取到 VMware/虚拟网卡
  const ifs = os.networkInterfaces();
  const skip = /vmware|veth|virtual|loopback|bluetooth|tap|hyper-?v|vEthernet|vmnet/i;
  const prefer = /wlan|wi-?fi|无线|ethernet|以太网|local area/i;
  let fallback = '';
  for (const [name, list] of Object.entries(ifs)) {
    for (const ni of list || []) {
      if (!ni.mac || ni.mac === '00:00:00:00:00:00') continue;
      if (skip.test(name + ' ' + ni.mac)) continue;
      if (ni.family === 'IPv4' && String(ni.address || '').startsWith('169.254')) continue;
      const mac = String(ni.mac).replace(/:/g, '').toUpperCase();
      if (prefer.test(name)) { lastRealMac = mac; return mac; }
      if (!fallback && ni.family === 'IPv4' && !ni.internal) fallback = mac;
    }
  }
  if (fallback) { lastRealMac = fallback; return fallback; }
  return lastRealMac || '';
}

function captivePortalUrl(macHex) {
  return `${CFG.portal}/?usermac=${macHex || localMacHex() || '000000000000'}`;
}

/* 手动门户：无痕/隔离窗口；登录成功后自动关闭 */
let manualPortal = null;
let manualWatchTimer = null;

/* ---------- 自开浏览器进程管理 ----------
 * 三条纪律（2026-10-08 踩坑后固化）：
 * 1) 必须杀整棵进程树：Windows 上 process.kill(pid) 只杀一个进程，Chromium 的
 *    renderer/GPU 子进程会活下来——窗口还在、内容不画，就是我们看到的
 *    「半透明、点不动、X 关不掉」的僵尸窗口。
 * 2) 必须先确认进程退出、再删 profile 目录：反过来做（先删目录）会让还活着的
 *    浏览器丢掉配置目录，立刻变成僵尸窗口。
 * 3) 服务自己退出时也要收摊：否则窗口变孤儿，用户只能去任务管理器猜着杀。
 */
const spawnedBrowserPids = new Set();

function trackBrowser(pid) { if (pid) spawnedBrowserPids.add(Number(pid)); }
function untrackBrowser(pid) { if (pid) spawnedBrowserPids.delete(Number(pid)); }

function killTreeSync(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  } catch {}
}

function killTree(pid) {
  if (!pid) return Promise.resolve();
  return new Promise(resolve => {
    if (process.platform !== 'win32') { killTreeSync(pid); return resolve(); }
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    try {
      const p = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
      p.on('exit', fin);
      p.on('error', fin);
      setTimeout(fin, 4000); // 兜底，绝不无限等
    } catch { fin(); }
  });
}

const sleepMs = ms => new Promise(r => setTimeout(r, ms));

// 进程退出后再删 profile；删不掉（仍被占用）就留着，宁可留个临时目录也不要做僵尸窗口
async function removeProfileSafely(profile) {
  if (!profile) return;
  for (let i = 0; i < 6; i++) {
    try { fs.rmSync(profile, { recursive: true, force: true }); return; } catch { await sleepMs(300); }
  }
}

function closeBrowserHandle(handle) {
  if (!handle) return;
  const { pid, profile } = handle;
  killTree(pid).then(() => { untrackBrowser(pid); return removeProfileSafely(profile); }).catch(() => {});
}

function closeManualPortal() {
  if (manualWatchTimer) { clearInterval(manualWatchTimer); manualWatchTimer = null; }
  if (!manualPortal) return false;
  const p = manualPortal;
  manualPortal = null;
  closeBrowserHandle(p);
  return true;
}

function closeCapBrowser(handle) {
  if (!handle) return;
  closeBrowserHandle(handle);
}

function openCaptivePortal() {
  const url = captivePortalUrl(localMacHex());
  closeManualPortal();
  const exe = findBrowserExe();
  if (exe) {
    const profile = path.join(os.tmpdir(), 'cnal_manual_' + Date.now().toString(36));
    const child = spawn(exe, [
      '--incognito',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      url,
    ], { detached: true, stdio: 'ignore', windowsHide: false });
    try { child.unref(); } catch {}
    manualPortal = { pid: child.pid, profile, exe, url };
    trackBrowser(child.pid);
    log('已打开无痕门户窗口: ' + url + '（登录成功后会自动关闭）');
    watchManualPortal();
  } else {
    openBrowser(url);
    log('已打开门户登录页（未找到 Edge/Chrome，无法无痕控制）: ' + url);
  }
  return url;
}

function watchManualPortal() {
  if (manualWatchTimer) clearInterval(manualWatchTimer);
  const started = Date.now();
  manualWatchTimer = setInterval(async () => {
    if (!manualPortal) { clearInterval(manualWatchTimer); manualWatchTimer = null; return; }
    if (Date.now() - started > 180000) {
      clearInterval(manualWatchTimer);
      manualWatchTimer = null;
      return;
    }
    try {
      const st = await portalStatus();
      const nc = await ncsiCheck();
      if (st && st.online && nc && nc.ok) {
        if (closeManualPortal()) log('无痕门户窗口已自动关闭（检测到联网成功）');
      } else if (st && st.online && !isWalledGarden(st, null)) {
        if (closeManualPortal()) log('无痕门户窗口已自动关闭（门户在线）');
      }
    } catch {}
  }, 8000);
}

/* ---------------- Captive 浏览器自动填密登录（CDP，主路径） ---------------- */
function findBrowserExe() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

/* 只认「我们自己开的」浏览器：判据是命令行里带 --user-data-dir=<tmp>\cnal_cap_ / cnal_manual_。
 * 绝不按进程名全杀——那会连用户自己开着的浏览器一起杀掉。 */
function listLeftoverBrowsers() {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve([]);
    const ps = [
      "$ErrorActionPreference='SilentlyContinue';",
      'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\' or Name=\'chrome.exe\'" |',
      "Where-Object { $_.CommandLine -match 'cnal_(cap|manual)_' } |",
      'ForEach-Object { "$($_.ProcessId)|$($_.Name)" }',
    ].join(' ');
    let out = '';
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(parseOut(out)); } };
    const parseOut = s => String(s).split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
      const [pid, name] = l.split('|');
      return { pid: Number(pid) || 0, name: name || '' };
    }).filter(x => x.pid > 0);
    try {
      const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true });
      p.stdout.on('data', d => { out += d.toString(); });
      p.on('exit', fin);
      p.on('error', fin);
      setTimeout(fin, 8000);
    } catch { fin(); }
  });
}

class CdpSession {
  constructor() {
    this.id = 0;
    this.pending = new Map();
    this.ws = null;
    this.wsUrl = null;
    this.port = null;
  }
  async connect(wsUrl, port) {
    this.wsUrl = wsUrl;
    this.port = port || this.port;
    await this._open();
  }
  _open() {
    return new Promise((resolve, reject) => {
      if (!this.wsUrl) return reject(new Error('CDP wsUrl 为空'));
      try { if (this.ws) { this.ws.onmessage = null; this.ws.close(); } } catch {}
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'));
      this.ws.onclose = () => {
        for (const [, p] of this.pending) { try { p.reject(new Error('CDP 连接已关闭')); } catch {} }
        this.pending.clear();
      };
      this.ws.onmessage = ev => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (!msg || !this.pending.has(msg.id)) return;
        const { resolve: res, reject: rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || 'CDP error'));
        else res(msg.result);
      };
    });
  }
  async ensure() {
    if (this.ws && this.ws.readyState === 1) return;
    if (this.wsUrl) {
      try { await this._open(); return; } catch {}
    }
    if (this.port) {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/list`);
      const pages = await res.json();
      const page = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl && /hnist|msft|generate_204|msn\.cn|firefox|about:blank/i.test(p.url || ''))
        || pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl);
      if (!page) throw new Error('CDP 未连接且找不到可控制页面');
      this.wsUrl = page.webSocketDebuggerUrl;
      await this._open();
      return;
    }
    throw new Error('CDP 未连接且无法重连');
  }
  _send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('CDP 未连接'));
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async send(method, params = {}) {
    try {
      if (!this.ws || this.ws.readyState !== 1) await this.ensure();
      return await this._send(method, params);
    } catch (e) {
      try {
        await this.ensure();
        return await this._send(method, params);
      } catch (e2) {
        throw new Error('CDP 未连接: ' + (e2 && e2.message || e.message));
      }
    }
  }
  close() { try { if (this.ws) this.ws.close(); } catch {} }
}

async function cdpEval(cdp, expression, awaitPromise) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: !!awaitPromise,
    returnByValue: true,
  });
  return r && r.result ? r.result.value : undefined;
}

/** 导航：用就绪状态短轮询代替固定 3s sleep */
async function cdpNavigate(cdp, url, opts = {}) {
  const timeout = opts.timeout || 6500;
  const settle = opts.settle == null ? 500 : opts.settle;
  try { await cdp.send('Page.navigate', { url }); }
  catch (e) {
    try { await cdp.ensure(); await cdp.send('Page.navigate', { url }); }
    catch (e2) { throw new Error('CDP 导航失败: ' + (e2 && e2.message || e.message)); }
  }
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const href = await cdpEval(cdp, 'location.href');
      const ready = await cdpEval(cdp, 'document.readyState');
      if (href && /hnist|chrome-error|DNS_PROBE/i.test(href) && (ready === 'complete' || ready === 'interactive')) {
        if (settle > 0) await sleep(settle);
        return href;
      }
      if (href && ready === 'complete' && href !== 'about:blank') {
        if (settle > 0) await sleep(settle);
        return href;
      }
    } catch (e) {
      try { await cdp.ensure(); } catch { break; }
    }
    await sleep(120);
  }
  try { return await cdpEval(cdp, 'location.href'); } catch { return ''; }
}

/* 从配置里取出 host/port，供可达性探测用 */
function cfgEndpoint(url, defPort) {
  try {
    const u = new URL(url);
    const p = Number(u.port || (u.protocol === "https:" ? 443 : 80)) || defPort;
    return { host: u.hostname, port: p };
  } catch (e) {
    return { host: '', port: defPort };
  }
}

/* 校园网内网可达性快检（纯读取，不发送数据、不改变任何状态）。
 * 判定刻意保守：任一目标可达就认为「可能在校内网」，交给原流程继续判断——
 * 误判为「不在校园网」会把本来能用的场景拦住，代价比多等几秒大得多。 */
async function campusReachable(timeoutMs) {
  const s = cfgEndpoint(CFG.self, 8080);
  const p = cfgEndpoint(CFG.portal, 443);
  const ms = timeoutMs || 1500;
  const [sp, pp] = await Promise.all([
    s.host ? tcpProbe(s.host, s.port, ms) : Promise.resolve({ ok: false, ms: 0 }),
    p.host ? tcpProbe(p.host, p.port, ms) : Promise.resolve({ ok: false, ms: 0 }),
  ]);
  return {
    ok: sp.ok || pp.ok,
    note: '自助后台 ' + (s.host || '(未配置)') + (sp.ok ? ' 可达' : ' 不可达')
      + '、门户 ' + (p.host || '(未配置)') + (pp.ok ? ' 可达' : ' 不可达'),
  };
}

/* 只探「自助后台」本身的 TCP 可达性——取设备/用量的硬前提。
 * 与 campusReachable 的区别：那个把「门户可达」也算通过（用于判断是否在校园网），
 * 这里必须精确到自助后台，因为在「门户通但校内服务不通」的网络上取数照样失败。 */
async function selfReachable(timeoutMs) {
  const s = cfgEndpoint(CFG.self, 8080);
  if (!s.host) return { ok: false, ms: 0, host: '' };
  const p = await tcpProbe(s.host, s.port, timeoutMs || 2000);
  return { ok: !!p.ok, ms: p.ms, host: s.host };
}

/* ---------------- 借网查看：临时切校园网取一次数据 ----------------
 * 场景（用户提需求的原话）：不在校园网时点「刷新绑定设备/IP 用量」取不到实时数据，
 * 希望「问一次要不要切网，要就自动完成、自动切回，不影响后续一键抢网，
 * 也不要产生自助后台的留存」。
 *
 * 流程：问用户（前端 confirm）→ 切 HNIST-student → 等连上并探到自助后台
 *      → 登录（遇到会话冲突自动注销本机会话重试一次，不再问用户）
 *      → 取设备 + 用量 → **注销自助后台（不留存）** → 自动切回原网络。
 *
 * 三条纪律：
 *  1) 互斥：借网期间拒绝启动一键抢网（反之亦然），否则两个流程会互相切网；
 *  2) 注销必须在切回之前——logout 请求要发到校内服务器，切走了就发不出去；
 *  3) 一定切回：无论成功、失败还是取消，finally 里都要把原网络还回去。
 */
const borrow = { busy: false, startedAt: 0 };

async function loginForBorrow(username, password) {
  let lg = await self.ensureLogin(username, password, null);
  for (let round = 0; round < 3; round++) {
    if (lg.ok) return lg;
    if (lg.needCaptcha) {
      emit('log', { msg: '自助后台要验证码（借网查看每次都要：因为用完即注销，不留存会话）' });
      emit('captcha', { img: lg.captchaB64 });
      const code = await waitFor('captcha', 180000);
      if (code === CANCELLED) return { ok: false, cancelled: true, tip: '已取消借网查看' };
      if (!code) return { ok: false, tip: '验证码输入超时' };
      lg = await self.login(username, password, code);
      continue;
    }
    // 会话冲突：自动注销本机会话后重试一次，不再弹「是否注销」确认
    if (round === 0 && /别处|会话|占用|失效|活跃|注销自助后台|未给出原因|登录失败/i.test(String(lg.tip || ''))) {
      emit('log', { msg: '自助后台会话冲突：自动注销本机会话后重试一次' });
      await forceSelfSessionReset();
      lg = await self.ensureLogin(username, password, null);
      continue;
    }
    break;
  }
  return lg;
}

async function borrowAndFetch(username, password) {
  const wi0 = wifiInfo();
  const from = (wi0 && wi0.ssid) || '';
  borrow.busy = true;
  borrow.startedAt = Date.now();
  // C：借网期间独占自助登录（与抢网一致，避免 checkcode 被并发的「刷新」覆盖）
  selfLoginLease.acquire('borrow', 300000);
  // 结果先存下来，等 finally 收尾（注销 + 切回）全部做完再发 borrow_done。
  // 为什么不能就地发：前端一收到 borrow_done 就解除「一键抢网」禁用，若此时网络还没切回去，
  // 用户点抢网就会和「切回原网络」抢跑（2026-10-08 端到端测试暴露）。
  let result = null;
  try {
    if (classifyNetwork(from).campus) {
      emit('log', { msg: '当前已在校园网：直接取数，不需要切换' });
    } else {
      if (from && !(wi0.profiles || []).includes(CAMPUS_SSID)) {
        throw new Error(`本机没有 ${CAMPUS_SSID} 的 Wi-Fi 配置——先手动连一次校园网，再回来借网`);
      }
      emit('log', { msg: `借网查看：从「${from || '当前网络'}」临时切到 ${CAMPUS_SSID}…` });
      const c = wifiConnect(CAMPUS_SSID);
      if (!c.ok) throw new Error(`切换到 ${CAMPUS_SSID} 失败：${c.msg}（附近有校园网信号吗？）`);
    }

    let reach = null;
    for (let i = 0; i < 22; i++) {
      await sleep(700);
      const p = await selfReachable(2000);
      if (p.ok) { reach = p; break; }
    }
    if (!reach) {
      throw new Error(`切到 ${CAMPUS_SSID} 后仍够不着自助后台（多半需要先通过门户认证再去取数）`);
    }
    emit('log', { msg: `自助后台可达（${reach.ms}ms），登录中…` });

    const lg = await loginForBorrow(username, password);
    if (!lg.ok) throw new Error(lg.cancelled ? '已取消（用户点了取消）' : (lg.tip || '自助后台登录失败'));

    const dev = await buildDevicesPayload();
    emit('devices', { devices: dev.devices || [], endpoints: [], dashLines: [] });
    const usage = await buildUsagePayload();
    result = { ok: true, at: now(), from, devices: dev, usage };
  } catch (e) {
    result = { ok: false, at: now(), from, error: e.message || String(e) };
  } finally {
    // 不留存：先注销（此刻还在校园网内，注销请求才发得出去）
    try { await self.http.request('GET', `${CFG.self}/Self/login/logout`, { timeout: 8000 }); } catch {}
    // 清干净「本机不留存」：登录态、会话文件、缓存的设备列表、以及遗留的账号身份
    try { self.loggedIn = false; self.sessionUser = ''; self.account = ''; self.http = new Http(); self.clearSessionFile(); self.lastDevices = []; } catch {}
    emit('log', { msg: '已注销自助后台会话（不留存）' });
    // 一定切回原网络
    if (from && from !== CAMPUS_SSID) {
      await sleep(600);
      const r = wifiConnect(from);
      emit('log', { msg: r.ok ? `已自动切回「${from}」` : `切回「${from}」失败：${r.msg}（可点控制台里的「切回原网络」重试）` });
    }
    // 刻意不动 lastWifiSwitch：那是「一键抢网切走后，用户手动切回」的账本，借网自己已经把网络
    // 还回去了，两边各管各的。这里若顺手清掉，会在「校园 SSID 但自助后台恰好不通」时抹掉用户
    // 真正的切回点（少见但真实），代价大于收益。
    borrow.busy = false;
    selfLoginLease.release('borrow');
    // 最后一步才宣告结束：此时会话已注销、网络已还原，前端可以安全地重新启用一键抢网
    emit('borrow_done', result || { ok: false, at: now(), from, error: '借网查看异常结束' });
  }
}

/* 最近一次「为抢网而切走的网络」，只供用户手动切回，绝不自动恢复 */
let lastWifiSwitch = null;

async function ensureCampusWifi(log, opts) {
  const say = m => { try { log && log(m); } catch {} };
  const allowSwitch = !!(opts && opts.allowSwitch);
  const CAMPUS = CAMPUS_SSID;
  const portalProbe = async () => {
    const mac = localMacHex() || '000000000000';
    try {
      const res = await fetch(`http://auth.hnist.edu.cn/?usermac=${mac}`, {
        redirect: 'manual', signal: AbortSignal.timeout(2500),
      });
      return { ok: true, status: res.status };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };
  let info = wifiInfo();
  say(`当前 WiFi: ${info.ssid || '(无)'}`);
  if (info.ssid === CAMPUS) {
    const p = await portalProbe();
    if (p.ok) { say(`已在 ${CAMPUS}，门户可达 status=${p.status}`); return { ok: true, ssid: CAMPUS, already: true }; }
    say(`已在 ${CAMPUS}，门户暂不可达（${p.error}），尝试重连…`);
  }
  if (!allowSwitch) {
    // 用户关掉了「自动连接校园 WiFi」：不碰网卡，只说明现状
    return {
      ok: false,
      switched: false,
      ssid: info.ssid,
      msg: `未勾选「自动连接校园 WiFi」，也没有检测到已在 ${CAMPUS}（当前 ${info.ssid || "未连接"}）`,
    };
  }
  say(`一键抢网：自动切换 WiFi → ${CAMPUS}`);
  // 记录切走前的网络；连续抢网时保留最初的来源，别把 HNIST 丢了
  if (info.ssid && info.ssid !== CAMPUS) {
    const keepFrom = lastWifiSwitch && lastWifiSwitch.to === info.ssid && lastWifiSwitch.from
      ? lastWifiSwitch.from : info.ssid;
    lastWifiSwitch = { from: keepFrom, to: CAMPUS, at: Date.now() };
  }
  const cr = wifiConnect(CAMPUS);
  say(cr.msg || `已请求连接 ${CAMPUS}`);
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    info = wifiInfo();
    if (info.ssid === CAMPUS) {
      const p = await portalProbe();
      if (p.ok) {
        say(`已连上 ${CAMPUS}，门户可达 status=${p.status}`);
        return { ok: true, ssid: CAMPUS, portalStatus: p.status };
      }
      if (i % 5 === 4) say(`已连 ${CAMPUS}，等待门户可达… ${p.error || ''}`);
    } else if (i % 5 === 4) {
      say(`等待切换到 ${CAMPUS}… 当前 ${info.ssid || '(无)'}`);
    }
  }
  return { ok: false, ssid: info.ssid, msg: `未能自动连上 ${CAMPUS}（当前 ${info.ssid || '无'}）` };
}

async function forceSelfSessionReset() {
  try { await self.http.request('GET', `${CFG.self}/Self/login/logout`, { timeout: 8000 }); } catch {}
  try { self.loggedIn = false; self.sessionUser = ''; self.http = new Http(); self.clearSessionFile(); self.lastDevices = []; } catch {}
}

/**
 * 主路径：自动切校园网 → captive 填密登录（对齐 WLAN 跳转）→ 验证数据。
 * 门户已可达时跳过探测链；探测失败 2s 即换下一条；登录页确认后不再全量 dump。
 */
async function captiveAutoLogin(username, suffix, password, onLog) {
  const log = typeof onLog === 'function' ? onLog : () => {};
  const exe = findBrowserExe();
  if (!exe) throw new Error('未找到 Edge/Chrome，无法自动填门户登录（可手动点「门户登录页」）');
  const account = String(username) + String(suffix || '');
  const macHex = localMacHex() || '000000000000';
  const urls = [
    `http://auth.hnist.edu.cn/?usermac=${macHex}`,
    `https://auth.hnist.edu.cn/?usermac=${macHex}`,
  ];

  // 先探门户是否可达（热点上 DNS 常失败）——失败 2s 就下一条
  let portalReachable = false;
  for (const u of urls) {
    try {
      const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
      portalReachable = true;
      log('门户可达: ' + u + ' status=' + res.status);
      break;
    } catch (e) {
      log('门户探测失败(2s): ' + u + ' ' + e.message);
    }
  }
  if (!portalReachable) {
    throw new Error('无法解析/访问 auth.hnist.edu.cn：请连接校园 WiFi HNIST-student 后再一键抢网（热点 HNIST 上校内域名不通）');
  }

  // 门户已可达：跳过整条探测链，直接清 Cookie → HTTP 门户（与 WLAN 登录页一致）
  const useProbeChain = false; // 可达时关闭；若以后需要可改 true
  const captiveProbes = [
    'http://www.msftconnecttest.com/connecttest.txt',
    'http://connectivitycheck.gstatic.com/generate_204',
    'http://www.msn.cn/',
  ];

  const port = 9320 + Math.floor(Math.random() * 50);
  const profile = path.join(os.tmpdir(), 'cnal_cap_' + Date.now().toString(36));
  const capChild = spawn(exe, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--incognito',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    useProbeChain ? captiveProbes[0] : urls[0],
  ], { detached: true, stdio: 'ignore', windowsHide: false });
  try { capChild.unref(); } catch {}
  const capHandle = { pid: capChild.pid, profile, exe };
  trackBrowser(capChild.pid);

  let cdp = null;
  let captiveClosed = false;
  const closeCaptiveBrowser = async () => {
    if (captiveClosed) return;
    captiveClosed = true;
    try { if (cdp && cdp.ws) await cdp._send('Browser.close').catch(() => {}); } catch {}
    try { if (cdp && cdp.ws) { cdp.ws.onmessage = null; cdp.ws.close(); } } catch {}
    closeCapBrowser(capHandle);
    closeManualPortal();
  };

  let pages = null;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      pages = await res.json();
      if (Array.isArray(pages) && pages.some(p => p.type === 'page' && p.webSocketDebuggerUrl)) break;
      pages = null;
    } catch {}
    await sleep(150);
  }
  if (!pages || !pages.length) {
    await closeCaptiveBrowser();
    throw new Error('浏览器调试端口未就绪，无法自动填登录');
  }

  let page = pages.find(p => p.type === 'page' && /hnist|msftconnecttest|generate_204|msn\.cn|firefox|about:blank/i.test(p.url || ''))
    || pages.find(p => p.type === 'page' && !/chrome-extension|devtools|chrome-error/i.test(p.url || ''))
    || pages.find(p => p.type === 'page');
  if (!page) {
    await closeCaptiveBrowser();
    throw new Error('未找到可控制的浏览器页面');
  }

  cdp = new CdpSession();
  const safePickExpr = `
    const pick = (sel) => { try { return document.querySelector(sel); } catch (e) { return null; } };
    const pickAll = (sel) => { try { return [...document.querySelectorAll(sel)]; } catch (e) { return []; } };
    const vis = el => {
      if (!el) return false;
      if (el.type === 'hidden' || el.disabled) return false;
      try {
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
      } catch (e) { return false; }
      return true;
    };
    const pickVis = sel => pickAll(sel).find(vis) || null;
  `;

  // 诊断模式才全量 dump/截图；平时只打一行日志
  const dumpPage = async (tag) => {
    try {
      if (!diagOn) {
        const brief = await cdpEval(cdp, `(() => {
          ${safePickExpr}
          const u = pickVis('input[name="DDDDD"]') || pickVis('input[placeholder="账号"]');
          return { href: location.href, title: document.title || '', ready: !!u, kind: (typeof page!=='undefined'&&page&&page.kind)||'' };
        })()`);
        log('Captive[' + tag + ']: ' + (brief && brief.href) + ' title=' + (brief && brief.title) + ' loginBox=' + (brief && brief.ready));
        return brief;
      }
      const info = await cdpEval(cdp, `(() => {
        ${safePickExpr}
        const inputs = pickAll('input,select,textarea').slice(0, 40).map(el => ({
          tag: el.tagName, type: el.type||'', name: el.name||'', id: el.id||'',
          value: (el.value||'').slice(0,40), placeholder: el.placeholder||'', visible: vis(el),
        }));
        return {
          href: location.href, title: document.title || '', ready: document.readyState,
          hasJQ: typeof jQuery !== 'undefined', hasLogin: typeof login !== 'undefined',
          pageKind: (typeof page !== 'undefined' && page && page.kind) || '',
          loginMethod: (typeof page !== 'undefined' && page && page.login_method) || '',
          termSuffix: (typeof term !== 'undefined' && term && term.suffix) || '',
          termMac: (typeof term !== 'undefined' && term && term.mac) || '',
          termIp: (typeof term !== 'undefined' && term && term.ip) || '',
          bodyText: (document.body && document.body.innerText || '').slice(0, 500),
          inputs,
        };
      })()`);
      diagDump('captive_' + tag, JSON.stringify(info, null, 2), true);
      log('Captive 页面状态[' + tag + ']: ' + (info && info.href) + ' kind=' + (info && info.pageKind) + ' title=' + (info && info.title) + ' inputs=' + ((info && info.inputs && info.inputs.length) || 0));
      return info;
    } catch (e) {
      log('Captive 页面诊断失败: ' + e.message);
      return null;
    }
  };
  const shot = async (tag) => {
    if (!diagOn) return;
    try {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(DIAG_DIR, { recursive: true });
      fs.writeFileSync(path.join(DIAG_DIR, `${now()}_captive_${tag}.png`), Buffer.from(r.data, 'base64'));
    } catch {}
  };
  const clearBrowserState = async () => {
    try { await cdp.send('Network.enable'); } catch {}
    try { await cdp.send('Network.clearBrowserCookies'); } catch (e) { log('清 Cookie 失败: ' + e.message); }
    try { await cdp.send('Network.clearBrowserCache'); } catch {}
    try {
      await cdpEval(cdp, `(() => {
        try { document.cookie.split(';').forEach(c => {
          const name = c.split('=')[0].trim();
          document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
        }); } catch (e) {}
        try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}
        return 'cleared';
      })()`);
    } catch {}
  };

  try {
    await cdp.connect(page.webSocketDebuggerUrl, port);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable').catch(() => {});

    await clearBrowserState();
    if (useProbeChain) {
      log('Captive 按探测链进入…');
      for (const probe of captiveProbes) {
        try {
          log('Captive 探测(2s): ' + probe);
          const href = await cdpNavigate(cdp, probe, { timeout: 2500, settle: 200 });
          log('Captive 探测后: ' + href);
          if (/hnist/i.test(String(href || ''))) break;
        } catch (e) { log('Captive 探测失败: ' + probe + ' ' + e.message); }
      }
    } else {
      log('Captive 门户已可达：跳过探测链，清 Cookie 后直开 HTTP 登录页');
    }

    let cur = await cdpEval(cdp, 'location.href');
    if (!/hnist/i.test(String(cur || ''))) {
      log('Captive 打开门户 HTTP: ' + urls[0]);
      cur = await cdpNavigate(cdp, urls[0], { timeout: 6000, settle: 600 });
    }
    if (!/hnist/i.test(String(cur || ''))) {
      log('Captive 改用 HTTPS 门户: ' + urls[1]);
      cur = await cdpNavigate(cdp, urls[1], { timeout: 6000, settle: 600 });
    }
    log('CDP 导航结束 href=' + cur);
    if (/chrome-error|DNS_PROBE|无法访问/i.test(String(cur || ''))) {
      throw new Error('浏览器无法打开门户页（DNS/网络不可达）：请连接 HNIST-student 后重试');
    }

    // 若是注销/已在线页：清 Cookie 后强刷 HTTP（与 WLAN 登录页一致；注销接口本校常无效）
    let formInfo = await cdpEval(cdp, `(() => {
      ${safePickExpr}
      const u = pickVis('input[name="DDDDD"]') || pickVis('input[placeholder="账号"]');
      const p = pickVis('input[name="upass"]') || pickVis('input[placeholder="密码"]');
      const t = (document.body && document.body.innerText) || '';
      return {
        ready: !!(u && p),
        onlinePage: /您已经成功登录|已在线|注销登录|Dr\\.COMWebLoginID_1/.test(t + (document.title||'')),
        title: document.title || '',
        text: t.slice(0, 240),
      };
    })()`);
    if (formInfo && formInfo.onlinePage && !formInfo.ready) {
      log('Captive 是注销/已在线页：清 Cookie 强刷登录页…');
      await clearBrowserState();
      for (const u of [urls[0], `http://auth.hnist.edu.cn/?usermac=${macHex}`]) {
        cur = await cdpNavigate(cdp, u, { timeout: 5000, settle: 500 });
        formInfo = await cdpEval(cdp, `(() => {
          ${safePickExpr}
          const u = pickVis('input[name="DDDDD"]') || pickVis('input[placeholder="账号"]');
          const p = pickVis('input[name="upass"]') || pickVis('input[placeholder="密码"]');
          const t = (document.body && document.body.innerText) || '';
          return { ready: !!(u && p), onlinePage: /您已经成功登录|已在线|注销登录|Dr\\.COMWebLoginID_1/.test(t + (document.title||'')), title: document.title || '', href: location.href, text: t.slice(0,240) };
        })()`);
        log('Captive 刷新后: ' + (formInfo && formInfo.href) + ' ready=' + (formInfo && formInfo.ready));
        if (formInfo && formInfo.ready) break;
      }
    }

    let ready = !!(formInfo && formInfo.ready);
    for (let i = 0; i < 18 && !ready; i++) {
      formInfo = await cdpEval(cdp, `(() => {
        ${safePickExpr}
        const u = pickVis('input[name="DDDDD"]') || pickVis('input[name="user_account"]') || pickVis('input[placeholder="账号"]');
        const p = pickVis('input[name="upass"]') || pickVis('input[name="password"]') || pickVis('input[placeholder="密码"]');
        const btn = pickVis('input[name="0MKKey"]') || pickVis('input[type="button"][value="登录"]');
        const captcha = pickVis('input[name="captcha"]');
        const t = (document.body && document.body.innerText) || '';
        return {
          ready: !!(u && p), hasBtn: !!btn, hasCaptcha: !!captcha,
          bodySnippet: t.slice(0, 240), href: location.href, title: document.title || '',
          onlinePage: /您已经成功登录|已在线|注销登录|Dr\\.COMWebLoginID_1|Dr\\.COMWebLoginID_3/.test(t + (document.title||'')),
        };
      })()`);
      if (formInfo && formInfo.ready) { ready = true; break; }
      if (formInfo && formInfo.onlinePage && !formInfo.ready) {
        log('Captive 仍为注销页，清 Cookie 强刷…');
        await clearBrowserState();
        try { cur = await cdpNavigate(cdp, urls[0], { timeout: 4500, settle: 400 }); } catch {}
        continue;
      }
      await sleep(250);
    }
    await dumpPage(ready ? 'ready' : 'noready');
    await shot(ready ? 'ready' : 'noready');
    if (!ready) {
      const t = String((formInfo && formInfo.bodySnippet) || '');
      const title = String((formInfo && formInfo.title) || '');
      if (/账号|密码|运营商/.test(t) && /登录|校园网|Hello|上网登录/i.test(title + t)) {
        ready = true;
        log('Captive 诊断：页面已是登录页，继续填充');
      }
    }
    if (!ready) {
      throw new Error('门户登录页未出现账号密码框（多为「已登录/注销页」；请连 HNIST-student 后重试）');
    }
    if (formInfo && formInfo.hasCaptcha) {
      throw new Error('门户页出现验证码，无法全自动填密；请手动输入验证码后登录');
    }

    const realMac = localMacHex() || macHex;
    const fillResult = await cdpEval(cdp, `(() => {
      ${safePickExpr}
      const accountFull = ${JSON.stringify(account)};
      const usernameOnly = ${JSON.stringify(String(username))};
      const password = ${JSON.stringify(password)};
      const suffix = ${JSON.stringify(String(suffix || ''))};
      const realMac = ${JSON.stringify(realMac)};

      try {
        const c1 = pick('input[name="C1"]');
        if (c1 && !c1.checked) { c1.checked = true; c1.click(); }
      } catch (e) {}

      let ispInfo = { value: '', text: '', options: [] };
      try {
        const sel = pick('select[name="ISP_select"]');
        if (sel) {
          ispInfo.options = [...sel.options].map(o => ({ value: o.value, text: o.text }));
          let chosen = null;
          for (const opt of sel.options) {
            if (/中国移动|cmcc|移动/i.test(opt.text + ' ' + opt.value)) { chosen = opt; break; }
          }
          if (!chosen) {
            for (const opt of sel.options) {
              if (opt.value && opt.value !== '-1' && !/教工|联通|电信/i.test(opt.text)) { chosen = opt; break; }
            }
          }
          if (!chosen) {
            for (const opt of sel.options) {
              if (opt.value && opt.value !== '-1') { chosen = opt; break; }
            }
          }
          if (chosen) {
            sel.value = chosen.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            ispInfo.value = chosen.value;
            ispInfo.text = chosen.text;
          }
        }
      } catch (e) { ispInfo.error = String(e && e.message); }

      const u = pickVis('input[name="DDDDD"]') || pickVis('input[name="user_account"]') || pickVis('input[placeholder="账号"]');
      const p = pickVis('input[name="upass"]') || pickVis('input[name="password"]') || pickVis('input[placeholder="密码"]');

      const ispSuffix = String(ispInfo.value || '');
      let formAccount = usernameOnly;
      if (!ispSuffix) formAccount = suffix ? accountFull : usernameOnly;
      const fullAccount = formAccount.includes('@') ? formAccount : (formAccount + (ispSuffix || suffix || ''));

      const setNative = (el, v) => {
        if (!el) return false;
        try { el.focus && el.focus(); } catch (e) {}
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      try {
        if (typeof jQuery === 'function') {
          jQuery('input[name="DDDDD"]').filter((i, el) => vis(el)).val(formAccount);
          jQuery('input[name="user_account"]').filter((i, el) => vis(el)).val(formAccount);
          jQuery('input[name="upass"]').filter((i, el) => vis(el)).val(password);
          jQuery('input[name="password"]').filter((i, el) => vis(el)).val(password);
        }
      } catch (e) {}
      setNative(u, formAccount);
      setNative(p, password);

      if (typeof term !== 'undefined' && term) {
        term.mac = realMac;
        term.suffix = ispSuffix || suffix || '';
        term.accountPrefix = 0;
        try {
          if (!term.ip || term.ip === '000.000.000.000') {
            if (typeof v46ip !== 'undefined' && v46ip) term.ip = String(v46ip).trim();
            else if (typeof ss5 !== 'undefined' && ss5) term.ip = String(ss5).trim();
          }
        } catch (e) {}
      }
      if (typeof login !== 'undefined' && login) {
        let form = (u && u.form) || null;
        if (!form) {
          for (const f of document.forms) {
            const fe = f.querySelector && f.querySelector('input[name="DDDDD"]');
            if (fe && vis(fe)) { form = f; break; }
          }
        }
        if (!form) form = document.forms[0] || null;
        login.form = form;
        if (form) {
          if (form.DDDDD) form.DDDDD.value = formAccount;
          if (form.upass) form.upass.value = password;
        }
        login.tempAccountSuffix = formAccount.includes('@') ? '' : (ispSuffix || suffix || '');
        login.accountPrefix = '';
        login.getTempAccountSuffix = function () { return this.tempAccountSuffix || ''; };
        login.setISP = function () {
          this.tempAccountSuffix = formAccount.includes('@') ? '' : (ispSuffix || suffix || '');
          return false;
        };
        login.account = fullAccount;
        login.prefixAccount = fullAccount;
      }

      let via = 'none';
      try {
        const method = (typeof page !== 'undefined' && page && page.login_method != null) ? Number(page.login_method) : null;
        if (typeof login !== 'undefined' && login && typeof login.login === 'function') {
          if (typeof term !== 'undefined' && term) {
            if (!term.ip || term.ip === '000.000.000.000') {
              return { ok: false, reason: 'term.ip 缺失，无法走 eportal login_portal', method, isp: ispInfo, account: fullAccount };
            }
            term.mac = realMac;
            term.suffix = login.tempAccountSuffix;
          }
          login.tempAccountSuffix = formAccount.includes('@') ? '' : (ispSuffix || suffix || '');
          login.accountPrefix = '';
          login.account = fullAccount;
          login.prefixAccount = fullAccount;
          login.login();
          via = 'login(method=' + method + ',account=' + fullAccount + ')';
        } else if (typeof login !== 'undefined' && login && typeof login.default_login === 'function') {
          login.account = fullAccount;
          login.prefixAccount = fullAccount;
          login.default_login();
          via = 'default_login';
        } else {
          const btn = pickVis('input[name="0MKKey"]') || pickVis('input[type="button"][value="登录"]');
          if (btn) { btn.click(); via = 'click0MKKey'; }
        }
      } catch (e) {
        return { ok: false, reason: 'login-js: ' + (e && e.message), via, isp: ispInfo, account: fullAccount };
      }

      const u2 = pickVis('input[name="DDDDD"]') || pickVis('input[placeholder="账号"]');
      const p2 = pickVis('input[name="upass"]') || pickVis('input[placeholder="密码"]');
      return {
        ok: true, via, formAccount, fullAccount,
        account: (u2 && u2.value) || '',
        pwdLen: (p2 && String(p2.value || '').length) || 0,
        isp: ispInfo,
        termMac: (typeof term !== 'undefined' && term && term.mac) || '',
        termIp: (typeof term !== 'undefined' && term && term.ip) || '',
        loginAccount: (typeof login !== 'undefined' && login && login.account) || '',
        loginPrefix: (typeof login !== 'undefined' && login && login.prefixAccount) || '',
      };
    })()`);

    log('Captive 填表结果: ' + JSON.stringify(fillResult));
    if (!fillResult || fillResult.__exception) {
      throw new Error('自动填入/提交脚本异常: ' + JSON.stringify(fillResult && fillResult.__exception || fillResult));
    }
    if (!fillResult.ok) {
      throw new Error('自动填入/提交失败: ' + ((fillResult && fillResult.reason) || 'unknown') +
        (fillResult && fillResult.isp ? ' isp=' + JSON.stringify(fillResult.isp) : ''));
    }
    if (!fillResult.pwdLen) throw new Error('填表后密码为空');
    const ispVal = String((fillResult.isp && fillResult.isp.value) || '');
    const submitted = String(fillResult.loginAccount || fillResult.fullAccount || fillResult.account || '');
    log(`Captive 提交账号=${submitted} 运营商=${ispVal || '(无)'}`);

    let st = null, nc = null;
    let sawSuccessPage = false;
    for (let i = 0; i < 16; i++) {
      await sleep(1200);
      try { st = await portalStatus(); } catch (e) { if (i === 0 || i === 6) log('portalStatus: ' + e.message); }
      try { nc = await ncsiCheck(); } catch {}
      if (i === 1 || i === 6) {
        await dumpPage('poll' + i);
        await shot('poll' + i);
      }
      const pageState = await cdpEval(cdp, `(() => {
        const t = (document.body && document.body.innerText) || '';
        return {
          kind: (typeof page !== 'undefined' && page && page.kind) || '',
          title: document.title || '',
          text: t.slice(0, 300),
          success: /您已经成功登录|登录成功|pc_3/.test(t + (document.title||'') + ((typeof page!=='undefined'&&page&&page.kind)||'')),
          fail: /pc_2|信息页/.test((document.title||'') + ((typeof page!=='undefined'&&page&&page.kind)||'')) || /msga\\s*=/.test(document.documentElement.innerHTML),
        };
      })()`);
      if (pageState && pageState.success && !sawSuccessPage) {
        sawSuccessPage = true;
        log('Captive 检测到登录成功页，尝试完成放行…');
        await cdpEval(cdp, `(() => {
          try {
            const goback = document.querySelector('input[name="GobackButton"]') || document.querySelector('input[value*="返回"]');
            if (goback) { goback.click(); return 'goback'; }
          } catch (e) {}
          try {
            if (typeof login !== 'undefined' && login && typeof login.redirect === 'function') {
              login.redirect(window.m || 0, window.UL || '');
              return 'login.redirect';
            }
          } catch (e) {}
          return 'none';
        })()`);
        try {
          await cdpNavigate(cdp, 'http://www.msftconnecttest.com/connecttest.txt', { timeout: 4000, settle: 400 });
          await cdpNavigate(cdp, `https://auth.hnist.edu.cn/?usermac=${fillResult.termMac || realMac}`, { timeout: 4000, settle: 400 });
        } catch (e) { log('成功页跳转失败: ' + e.message); }
        await dumpPage('after_success');
      }
      if (st && st.online && nc && nc.ok) {
        await closeCaptiveBrowser();
        return { ok: true, msg: 'Captive 自动登录成功，测试网址通过', via: 'captive-browser', bound: true, st, nc, account: submitted };
      }
      const pageMsg = await cdpEval(cdp, `(() => {
        const html = document.documentElement ? document.documentElement.innerHTML : '';
        const t = (document.body && document.body.innerText) || '';
        const m = html.match(/msga\\s*=\\s*'([^']*)'/) || t.match(/(inuse[^\\n]{0,80}|OLno[^\\n]{0,40}|密码[^\\n]{0,40}|已满[^\\n]{0,20}|请选择运营商[^\\n]{0,20}|只能[^\\n]{0,20}|一台[^\\n]{0,20})/i);
        return (m && m[1]) || '';
      })()`);
      const failPage = /信息页|pc_2/.test(String((pageState && pageState.title) || '') + String((pageState && pageState.kind) || '')) ||
        String(pageState && pageState.text || '').includes('登录失败') ||
        (pageState && pageState.fail && !pageState.success);
      // 失败页/占用类：立即返回并触发解绑确认，不要空等 16 轮
      if (failPage || (pageMsg && /inuse|OLno|在线名额|已满|pwderror|密码错误|mac filter|请选择运营商|只能绑定|一台电脑|ip/i.test(String(pageMsg)))) {
        const kind = /inuse|OLno|已满|只能|一台|占用/i.test(String(pageMsg)) || failPage ? 'occupancy' : 'other';
        return {
          ok: false,
          msg: 'Captive 登录被拒：' + (String(pageMsg).slice(0, 180) || String((pageState && pageState.text) || '').slice(0, 160) || '门户信息页（可能是 PC 名额已满）'),
          via: 'captive-browser',
          raw: {
            msga: String(pageMsg || (pageState && pageState.text) || ''),
            kind,
            failPage,
          },
        };
      }
      if (st && st.online && !isWalledGarden(st, nc)) {
        await closeCaptiveBrowser();
        return { ok: true, msg: 'Captive 自动登录成功', via: 'captive-browser', bound: true, st, nc, account: submitted };
      }
      if (i % 4 === 3) log(`Captive 等待放行… ${i + 1}/16 online=${st && st.online} flow=${st && st.flowKB} ncsi=${nc && nc.ok} success=${sawSuccessPage}`);
    }
    if (st && st.online && isWalledGarden(st, nc)) {
      return {
        ok: false,
        msg: `Captive 已登录但数据未打通（围墙花园；提交账号=${submitted || '未知'}）`,
        via: 'captive-browser',
        raw: { kind: 'walled', account: submitted, isp: fillResult.isp },
      };
    }
    return { ok: false, msg: 'Captive 登录后仍未检测到在线（请检查是否连 HNIST-student）', via: 'captive-browser' };
  } finally {
    // 无论成功失败都要收摊：失败分支曾经直接 return，窗口留在桌面上没人管
    try { if (cdp) cdp.close(); } catch {}
    await closeCaptiveBrowser();
  }
}


function parseDrcomPage(text) {
  const body = String(text || '');
  const get = re => { const m = re.exec(body); return m ? (m[1] || '') : ''; };
  return {
    uid: get(/UID='([^']*)'/),
    mac1: get(/mac1='([^']*)'/),
    olmac: get(/olmac='([^']*)'/),
    ul: get(/UL='([^']*)'/),
    m: get(/\bm=(\d+)/),
    v46ip: get(/v46ip='([^']*)'/),
  };
}

async function portalLogin(username, suffix, password) {
  const macHex = localMacHex();
  const base = {
    DDDDD: String(username) + String(suffix || ''),
    upass: String(password),
    '0MKKey': '123456',
    R1: '', R2: '', R3: '', R6: '0', para: '', v6ip: '',
    terminal_type: '1',
    lang: 'zh',
    callback: 'cb',
    jsVersion: '4.X',
  };
  // 浏览器 captive 登录会带 usermac；裸 POST 往往不绑设备 → 门户成功但数据被拦
  base.usermac = macHex;
  base.mac = macHex;
  base.wlanusermac = macHex;

  // Captive 链暖页：复刻“连上WiFi→系统自动跳登录页”。
  // 实测该路径登录=自动绑定设备；裸接口登录则 mac1/olmac 为空。
  let captiveExtra = { usermac: macHex, mac: macHex, wlanusermac: macHex };
  let referer = `${CFG.portal}/`;
  try {
    for (const trigUrl of [
      'http://www.msn.cn/',
      'http://www.msftconnecttest.com/connecttest.txt',
      'http://connectivitycheck.gstatic.com/generate_204',
    ]) {
      let portalUrl = '';
      try {
        const trig = await portalHttp.request('GET', trigUrl, {
          timeout: 7000, redirects: 0, headers: { 'User-Agent': CHROME_UA },
        });
        diagDump('portal_captive_' + trigUrl.replace(/[^a-z0-9]+/gi, '_').slice(0, 40),
          '<!-- ' + trigUrl + ' -> ' + trig.status + ' loc=' + (trig.headers.location || '') + ' -->\n' + String(trig.text).slice(0, 3000), true);
        const loc = trig.headers.location || '';
        if (trig.status >= 300 && trig.status < 400 && loc) portalUrl = new URL(loc, trigUrl).toString();
        else {
          const jm = /location\.href\s*=\s*["']([^"']+)["']/.exec(String(trig.text));
          if (jm) portalUrl = jm[1];
        }
      } catch {}
      if (portalUrl && /hnist/i.test(portalUrl)) {
        const pu = new URL(portalUrl);
        for (const [k, v] of pu.searchParams.entries()) {
          if (!['callback', 'jsVersion', 'v', 'lang'].includes(k)) captiveExtra[k] = v;
        }
        if (!captiveExtra.usermac && macHex) captiveExtra.usermac = macHex;
        referer = portalUrl;
        await portalHttp.request('GET', portalUrl, {
          timeout: 8000,
          headers: { 'User-Agent': CHROME_UA, Referer: trigUrl },
        });
        diagDump('portal_captive_page', 'URL=' + portalUrl + ' params=' + JSON.stringify(captiveExtra), true);
        break;
      }
    }
    // 主动带 usermac 打开登录页（劫持链未给出时也要走一遍，拿 Cookie/会话上下文）
    const warm = captivePortalUrl(macHex);
    const wr = await portalHttp.request('GET', warm, {
      timeout: 7000, headers: { 'User-Agent': CHROME_UA },
    });
    diagDump('portal_warm_usermac',
      'URL=' + warm + ' status=' + wr.status + '\n' + String(wr.text).slice(0, 4000), true);
    const r1 = /name=["']R1["'][^>]*value=["']([^"']*)["']/i.exec(wr.text) || /\bR1\s*=\s*['"]([^'"]*)['"]/.exec(wr.text);
    const r3 = /name=["']R3["'][^>]*value=["']([^"']*)["']/i.exec(wr.text) || /\bR3\s*=\s*['"]([^'"]*)['"]/.exec(wr.text);
    if (r1 && r1[1]) captiveExtra.R1 = r1[1];
    if (r3 && r3[1]) captiveExtra.R3 = r3[1];
    await portalHttp.request('GET', `${CFG.portal}/`, {
      timeout: 6000, headers: { 'User-Agent': CHROME_UA },
    });
  } catch {}

  const chromeOpts = {
    timeout: 12000,
    headers: { 'User-Agent': CHROME_UA, Referer: referer },
  };

  // 优先复刻浏览器 JSONP：Cookie + usermac + Referer
  const targets = [];
  targets.push({ label: 'jsonp-captive', origin: 'http://auth.hnist.edu.cn', extra: captiveExtra });
  targets.push({ label: 'jsonp-https', origin: CFG.portal, extra: captiveExtra });
  // POST 兑底（实测未认证时 GET 404 / POST 200）
  targets.push({ label: 'post-http', method: 'POST', url: 'http://auth.hnist.edu.cn/drcom/login', extra: captiveExtra });
  targets.push({ label: 'post-https', method: 'POST', url: 'https://auth.hnist.edu.cn/drcom/login', extra: captiveExtra });
  targets.push({
    label: 'eportal801',
    full: 'http://auth.hnist.edu.cn:801/eportal/?c=ACSetting&a=Login',
    extra: { url: 'drappall', ...captiveExtra },
    alias: true,
  });
  for (const probe of [
    'http://auth.hnist.edu.cn/',
    'http://connectivitycheck.gstatic.com/generate_204',
    'http://www.msftconnecttest.com/connecttest.txt',
  ]) {
    try {
      const disc = await portalHttp.request('GET', probe, {
        timeout: 6000, redirects: 0, headers: { 'User-Agent': CHROME_UA },
      });
      diagDump('portal_probe_' + probe.replace(/[^a-z0-9]+/gi, '_').slice(0, 40),
        '<!-- ' + probe + ' -> ' + disc.status + ' loc=' + (disc.headers.location || '') + ' -->\n' + String(disc.text).slice(0, 12000), true);
      const loc = disc.headers.location || '';
      if (disc.status >= 300 && disc.status < 400 && loc) {
        try {
          const u = new URL(loc, probe);
          if (/hnist/i.test(u.host)) {
            const extra = { ...captiveExtra };
            for (const [k, v] of u.searchParams.entries()) {
              if (!['callback', 'jsVersion', 'v', 'lang'].includes(k)) extra[k] = v;
            }
            targets.push({ label: 'redirect', origin: u.origin, extra });
          }
        } catch {}
      }
    } catch {}
  }
  targets.push({ label: 'https', origin: CFG.portal, extra: captiveExtra });
  targets.push({ label: 'http', origin: 'http://auth.hnist.edu.cn', extra: captiveExtra });

  let lastErr = null;
  for (const t of targets) {
    try {
      const q = new URLSearchParams({ ...base, ...captiveExtra, ...(t.extra || {}), v: rnd() });
      if (t.alias) {
        q.set('user_account', base.DDDDD);
        q.set('username', base.DDDDD);
        q.set('user_password', base.upass);
        q.set('password', base.upass);
      }
      let r;
      if (t.method === 'POST') {
        r = await portalHttp.request('POST', t.url, { ...chromeOpts, form: q.toString() });
      } else {
        const full = t.full
          ? t.full + (t.full.includes('?') ? '&' : '?') + q
          : `${t.origin}/drcom/login?${q}`;
        r = await portalHttp.request('GET', full, chromeOpts);
      }
      if (r.status !== 200) {
        diagDump('portal_login_' + t.label + '_http' + r.status,
          `<!-- URL=${t.origin}/drcom/login FINAL=${r.finalUrl} -->\n` + String(r.text).slice(0, 8000), true);
        lastErr = new Error(`登录接口返回 HTTP ${r.status}（尝试入口 ${t.label}）`);
        continue;
      }
      // Dr.COM 页面标记：ID_3=成功，ID_2=失败，或状态页带 uid
      if (/Dr\.COMWebLoginID_3/.test(r.text)) {
        diagDump('portal_login_' + t.label + '_ok_page', String(r.text).slice(0, 4000), true);
        const info = parseDrcomPage(r.text);
        const bound = !!(info.mac1 || info.olmac);
        // 成功页 UL 若为可访问地址，尽量跟跳完成“登录后放行”闭环
        if (info.ul && /^https?:\/\//i.test(String(info.ul))) {
          try {
            await portalHttp.request('GET', String(info.ul).trim(), {
              timeout: 8000, headers: { 'User-Agent': CHROME_UA, Referer: referer },
            });
          } catch {}
        }
        return {
          ok: true,
          msg: bound ? '登录成功（已绑定设备）' : '登录成功（门户会话已建立；若测试网址仍不过，请用门户登录页完成绑定）',
          via: t.label,
          bound,
          raw: info,
        };
      }
      const uidM = /uid='([^']+)'/.exec(String(r.text));
      if (uidM && uidM[1] && /注销|Dr\.COMWebLoginID_1/.test(String(r.text))) {
        return { ok: true, msg: '登录成功（已在线）', bound: true, raw: { uid: uidM[1] } };
      }
      if (/Dr\.COMWebLoginID_2/.test(r.text)) {
        diagDump('portal_login_' + t.label + '_failpage', String(r.text).slice(0, 8000), true);
        const body = String(r.text);
        const msga = ((body.match(/msga='([^']*)'/) || [])[1]) || '';
        const msgNum = ((body.match(/\bMsg=([^;]+);/) || [])[1]) || '';
        // clientip online = 本机 IP 已有会话（往往就是自己刚成功的那次）→ 按已在线成功处理
        if (/clientip online/i.test(msga)) {
          return { ok: true, alreadyOnline: true, msg: '该 IP 已在线（本机当前会话），无需重复登录', bound: true, raw: { msga } };
        }
        const known = {
          pwderror: '账号或密码错误', 'password error': '账号或密码错误',
          maxonline: '在线数已达上限', 'mac filter': 'MAC 不在允许范围',
          'user disabled': '账号已停用',
          'clientip online': '该 IP 已在线（本机当前会话）',
        };
        const low = msga.toLowerCase();
        const isOccupied = /inuse|olno|pc\s*ol|max\s*online|already\s*online|login\s*again/.test(low) ||
          (/\bpp\s*ol\b/.test(low) && />=/.test(msga));
        if (isOccupied && !/clientip online/i.test(msga)) {
          return {
            ok: false,
            msg: `服务器拒绝：${msga}（PC 在线名额已满，需先解绑占用设备）`,
            raw: { msga, msgNum, kind: 'occupancy' },
          };
        }
        const msg = known[low] ||
          (msga ? `服务器拒绝：${msga}` : (msgNum ? `服务器拒绝（Msg=${msgNum.trim()}）` : '登录被拒绝（服务器未给说明）'));
        return { ok: false, msg, raw: { msga, msgNum } };
      }
      let j;
      try { j = pickJson(r.text); }
      catch {
        diagDump('portal_login_' + t.label + '_badjson',
          `<!-- URL=${t.origin}/drcom/login -->\n` + String(r.text).slice(0, 8000), true);
        lastErr = new Error('登录接口响应异常: ' + String(r.text).slice(0, 120));
        continue;
      }
      const ok = String(j.result) === '1' || j.result === 'ok';
      const msg = j.msg || j.message || j.error || (ok ? '登录成功' : '登录失败');
      diagDump('portal_login_' + t.label + (ok ? '_ok' : '_rejected'), JSON.stringify(j), true);
      return { ok, msg, via: t.label, raw: j };
    } catch (e) {
      if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(e.message)) {
        throw new Error('无法解析 auth.hnist.edu.cn：请连接校园 WiFi（HNIST-student）后重试');
      }
      lastErr = e;
    }
  }
  throw lastErr || new Error('门户登录失败');
}

async function portalLogout() {
  const url = `${CFG.portal}/drcom/logout?callback=cb&jsVersion=4.X&v=${rnd()}&lang=zh`;
  const r = await new Http().request('GET', url, { timeout: 8000 });
  try { return { ok: true, raw: pickJson(r.text) }; }
  catch { return { ok: r.status === 200, note: r.text.slice(0, 120) }; }
}

/* Windows NCSI 测试网址（网络列表里那个“测试网址”） */
async function ncsiCheck() {
  try {
    const r = await new Http().request('GET', CFG.ncsi, { timeout: 6000, redirects: 0 });
    const ok = r.status === 200 && /Microsoft Connect Test/i.test(r.text);
    return { ok, status: r.status, captive: r.status >= 300 && r.status < 400 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ---------------- 诊断 ---------------- */
let diagOn = false;

function diagDump(name, text, force) {
  if (!diagOn && !force) return;
  try {
    fs.mkdirSync(DIAG_DIR, { recursive: true });
    const safe = String(name).replace(/[^\w.-]+/g, '_').slice(0, 80);
    // 页面内嵌的 window.user 含 userPassword 明文，存档前必须打码
    const redacted = String(text)
      .replace(/("userPassword"\s*:\s*")[^"]*(")/gi, '$1***$2')
      .replace(/(upass["']?\s*[:=]\s*['"])[^'"]*/gi, '$1***')
      .replace(/([?&]upass=)[^&\s"']+/gi, '$1***');
    fs.writeFileSync(path.join(DIAG_DIR, `${now()}_${safe}.html`), redacted);
    // 自动保留最近 20 个（文件名以时间戳开头，字典序即时间序）
    const files = fs.readdirSync(DIAG_DIR).filter(f => /^\d{13}_/.test(f)).sort();
    for (const old of files.slice(0, Math.max(0, files.length - 20))) {
      try { fs.unlinkSync(path.join(DIAG_DIR, old)); } catch {}
    }
  } catch {}
}

/* ---------------- 自助服务（用户自助系统） ---------------- */
const SELF_LOGIN_TIP = /\}\)\(\s*'([^']*)'\s*\)/;

class SelfClient {
  constructor() {
    this.http = new Http();
    this.loggedIn = false;
    this.account = '';
    this.sessionUser = '';
    this.restored = false;
    this.checkcode = '';
    this.captchaVisible = false;
    this.captchaB64 = null;
    this.tips = [];
  }

  /* 会话持久化：登录成功后把 JSESSIONID 用 DPAPI 存本机，重启服务不丢登录态，
     也避免“重启留下孤儿会话、把自己锁在门外” */
  saveSession() {
    try {
      const jsid = this.http.cookies.get('JSESSIONID');
      if (!jsid || !this.loggedIn) return;
      fs.writeFileSync(SESSION_FILE, JSON.stringify({
        enc: dpapiProtect(jsid), account: this.account, at: now(),
      }));
    } catch {}
  }

  clearSessionFile() {
    try { fs.unlinkSync(SESSION_FILE); } catch {}
  }

  async restoreSession(username) {
    if (this.restored) return false;
    this.restored = true;
    try {
      if (!fs.existsSync(SESSION_FILE)) return false;
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      if (data.account && username && data.account !== username) return false;
      const jsid = dpapiUnprotect(data.enc);
      if (!jsid) return false;
      this.http = new Http();
      this.http.cookies.set('JSESSIONID', jsid);
      const r = await this.http.request('GET', CFG.self + '/Self/dashboard', { timeout: 10000 });
      if (/欢迎登录用户自助服务系统/.test(r.text)) { this.clearSessionFile(); return false; }
      this.loggedIn = true;
      this.account = data.account || username || '';
      this.sessionUser = this.account;
      diagDump('self_session_restore', r.text, true);
      return true;
    } catch { return false; }
  }

  async openLogin() {
    const r = await this.http.request('GET', `${CFG.self}/Self/login`, { timeout: 10000 });
    const m = /name="checkcode"\s+value="([^"]*)"/i.exec(r.text);
    this.checkcode = m ? m[1] : '';
    const tag = /<div[^>]*id="randomDiv"[^>]*>/i.exec(r.text);
    this.captchaVisible = !!tag && !/\bhide\b/.test(tag[0]);
    diagDump('self_login_page', r.text, true);
    return r;
  }

  async fetchCaptcha() {
    const r = await this.http.request('GET', `${CFG.self}/Self/login/randomCode?t=${now()}`, { timeout: 8000 });
    const ct = r.headers['content-type'] || 'image/png';
    this.captchaB64 = `data:${ct.split(';')[0]};base64,${r.buf.toString('base64')}`;
    return this.captchaB64;
  }

  async login(username, passwordPlain, code) {
    // 与浏览器完全一致的顺序：开登录页拿 checkcode → 取验证码图 → 带 code 提交。
    // （之前先发一次“无 code”的探测提交，会与服务端 checkcode/验证码会话错位）
    if (!code) {
      await this.openLogin();
      await this.fetchCaptcha();
      return { ok: false, tip: '需要验证码', needCaptcha: true, captchaB64: this.captchaB64 };
    }
    if (!this.checkcode) {
      await this.openLogin();
      await this.fetchCaptcha();
      return { ok: false, tip: '验证码已过期，请重试', needCaptcha: true, captchaB64: this.captchaB64 };
    }
    const form = {
      account: username,
      password: md5(passwordPlain),
      code: code,
      foo: '',
      bar: '',
      checkcode: this.checkcode,
      submit: '登 录',
    };
    const r = await this.http.request('POST', `${CFG.self}/Self/login/verify`, { form, timeout: 12000 });
    diagDump('self_login_verify', `<!-- STATUS=${r.status} FINAL=${r.finalUrl} CODE_SENT=yes CHECK=${this.checkcode} -->\n` + r.text, true);

    // 成功必须有“登录后页面”的正面证据（导航/视图特征），且没被踢回登录页。
    // 仅“不是登录页”不够——错误页会被误判成功，导致后续接口全部会话失效。
    const isLoginPage = /欢迎登录用户自助服务系统/.test(r.text);
    let finalPath = '';
    try { finalPath = new URL(r.finalUrl).pathname; } catch {}
    const backToLogin = /^\/Self\/login\/?$/.test(finalPath);
    const authed = !isLoginPage && /nav-bar-menu|view-main|我的设备|在线信息|账单/.test(r.text);
    const ok = authed && !backToLogin;
    let tip = '';
    if (!ok) {
      const m = SELF_LOGIN_TIP.exec(r.text);
      if (m) tip = m[1];
      const m2 = /<div[^>]*id="errorTip"[^>]*>([\s\S]*?)<\/div>/i.exec(r.text);
      if (!tip && m2) tip = m2[1].replace(/<[^>]+>/g, '').trim();
      // 验证码错误/过期 → 重开登录页换新码，等用户重新输入
      if (/验证码/.test(tip)) {
        await this.openLogin();
        await this.fetchCaptcha();
        return { ok: false, tip, needCaptcha: true, captchaB64: this.captchaB64 };
      }
    }

    if (ok) {
      this.loggedIn = true;
      this.account = username;
      this.sessionUser = username;
      this.saveSession();
      return { ok: true };
    }
    // D：失败文案不再一律「按顺序排查」——先探自助后台是否可达，据此给**具体**原因，
    //    用户一眼能判断该做什么（连校园网 / 重输验证码 / 注销后台）。
    let reach = null;
    try { reach = await selfReachable(1500); } catch {}
    let fallback;
    if (reach && !reach.ok) {
      fallback = '连不上自助后台（' + CFG.self + '）：当前多半不在校园网 ' + CAMPUS_SSID
        + ' 上——先连上校园网再登录。';
    } else {
      fallback = '自助后台可达，但登录被服务器退回（未给原因）。最可能是：'
        + '① 验证码过期/输错 → 再输一次即可；'
        + '② 浏览器或本机还留着旧的自助后台会话 → 到「设置」点「注销自助后台」后重试。';
    }
    // 静默退回：POST 后被弹回登录页，页面上却**没有任何原因**（`errorTip` 为空）。
    // 实测（diag/self_login_verify）这种形状来自「旧会话占用」或「checkcode 已被消费」，
    // 换一张新验证码重试通常就过。这里只如实标注，是否重试交给调用方决定（见 selfLoginOnce）。
    const bounced = backToLogin && !tip;
    return {
      ok: false,
      tip: tip || fallback,
      needCaptcha: false,
      bounced,
      captchaB64: this.captchaB64,
    };
  }

  async ensureLogin(username, passwordPlain, code) {
    if (this.loggedIn && this.sessionUser === username && !code) return { ok: true };
    if (!this.loggedIn && !code) {
      if (await this.restoreSession(username)) return { ok: true };
    }
    // 仅在切换账号时才重置会话；带验证码重试时必须沿用同一会话
    if (this.sessionUser && this.sessionUser !== username) {
      this.http = new Http();
      this.loggedIn = false;
      this.checkcode = '';
      this.captchaB64 = null;
      this.captchaVisible = false;
    }
    this.sessionUser = username;
    return this.login(username, passwordPlain, code);
  }

  async get(pagePath, forceDump) {
    if (!this.loggedIn) throw new Error('自助服务未登录');
    const r = await this.http.request('GET', CFG.self + pagePath, { timeout: 12000 });
    // 先存档再判定：会话失效的响应也要留下证据
    diagDump('self' + pagePath.replace(/[^\w]+/g, '_'), r.text, forceDump);
    if (/欢迎登录用户自助服务系统/.test(r.text)) {
      this.loggedIn = false;
      this.clearSessionFile();
      throw new Error('自助服务会话已失效');
    }
    return r.text;
  }

  async unbind(dev) {
    const act = dev && dev.action;
    // 新路径：getMacList 行 → /Self/service/unbindmac?mac=&ajaxCsrfToken=
    if (act && act.kind === 'unbindmac') {
      const token = act.token || this.ajaxCsrf || '';
      const url = `${CFG.self}/Self/service/unbindmac?mac=${encodeURIComponent(act.mac)}&ajaxCsrfToken=${encodeURIComponent(token)}`;
      const r = await this.http.request('GET', url, { timeout: 12000 });
      diagDump('self_unbindmac_' + r.status, '<!-- URL=' + url.replace(/ajaxCsrfToken=[^&]+/, 'ajaxCsrfToken=***') + ' -->\n' + String(r.text).slice(0, 12000), true);
      if (r.status >= 400) throw new Error('解绑请求 HTTP ' + r.status);
      const m = /\}\)\('([^']*)'\)/.exec(r.text);
      const msg = m ? m[1] : '';
      if (msg && /失败|不存在|错误|无权/.test(msg)) throw new Error(msg);
      return { ok: true, msg: msg || '已请求解除绑定' };
    }
    if (dev && dev.action && dev.action.url) {
      let url = dev.action.url;
      if (!/^https?:/i.test(url)) url = url.startsWith('/') ? CFG.self + url : CFG.self + '/Self/' + url;
      const r = await this.http.request(dev.action.method || 'POST', url, {
        form: dev.action.params || {}, timeout: 10000,
      });
      if (r.status >= 400) throw new Error('解绑请求 HTTP ' + r.status);
      return { ok: true, status: r.status };
    }
    const e = new Error('未能从页面识别解绑操作，请到右上角齿轮「设置」里开启诊断模式后重试一次，把 diag 报告交给我分析');
    e.needManual = true;
    throw e;
  }

  /* 设备列表：bootstrap-table AJAX 接口 getMacList（页面本身没有表格 HTML） */
  async loadMacList() {
    const html = await this.get('/Self/service/myMac', true);
    const tm = /ajaxCsrfToken["'\s=+]*['"]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(html);
    if (tm) this.ajaxCsrf = tm[1];
    const q = new URLSearchParams({
      pageNumber: '1', pageSize: '200', searchText: '', sortName: '2', sortOrder: 'DESC',
    });
    const r = await this.http.request('GET', `${CFG.self}/Self/service/getMacList?${q}`, { timeout: 12000 });
    let data;
    try { data = JSON.parse(r.text); } catch { throw new Error('getMacList 响应不是 JSON'); }
    const rows = Array.isArray(data) ? data : (data.rows || []);
    return rows.map(a => {
      if (!Array.isArray(a)) a = Object.values(a);
      const macRaw = String(a[1] != null ? a[1] : '').replace(/[^0-9A-Fa-f]/g, '');
      const term = String(a[2] || '').replace(/^#/, '');
      return {
        text: [a[0] == 0 ? '离线' : '在线', term || '未知', a[3] || ''].filter(Boolean).join(' · '),
        ip: String(a[4] || '').trim(),
        mac: fmtMac(macRaw),
        type: detectTermType(term),
        online: a[0] != 0,
        action: macRaw ? { kind: 'unbindmac', mac: macRaw, token: this.ajaxCsrf || '' } : null,
      };
    });
  }

  /* 当前在线会话（仪表盘 getOnlineList，对象行） */
  async getOnlineSessions() {
    const r = await this.http.request('GET', `${CFG.self}/Self/dashboard/getOnlineList`, { timeout: 10000 });
    diagDump('self_getOnlineList', r.text, true);
    let data;
    try { data = JSON.parse(r.text); } catch { return []; }
    const rows = Array.isArray(data) ? data : (data.rows || []);
    return rows.map(x => ({
      loginTime: x.loginTime, ip: x.ip || '', mac: fmtMac(x.mac || ''),
      term: String(x.terminalType || x.term || x.userAgent || x.terminal || ''),
    }));
  }

  /** 组装解绑候选：优先右侧「绑定设备」getMacList，再合并在线会话 */
  async loadUnbindCandidates() {
    let devList = [];
    try { devList = await this.loadMacList(); } catch (e) { emit('warn', { msg: 'getMacList 失败：' + e.message }); }
    let onlineSessions = [];
    try { onlineSessions = await this.getOnlineSessions(); } catch (e) { emit('warn', { msg: 'getOnlineList 失败：' + e.message }); }
    this.lastDevices = devList;
    return buildUnbindCandidates(devList, onlineSessions, this.ajaxCsrf || '');
  }

  /* 用量报表：getLoginHistory + 账单-上网记录页（结构自发现） */
  async fetchUsageReport() {
    const out = { sources: [], rows: [] };
    let rawLogRows = []; // P2③：原始上网记录行（对象，字段名 macAddress），用于补 MAC 历史

    /* 1) 仪表盘“近期上网记录”：0上线 1注销 2IP 3MAC 4时长(分) 5流量(M) 6终端 */
    try {
      const r = await this.http.request('GET', `${CFG.self}/Self/dashboard/getLoginHistory`, { timeout: 12000 });
      diagDump('self_getLoginHistory', r.text, true);
      const data = JSON.parse(r.text);
      const rows = Array.isArray(data) ? data : (data.rows || []);
      for (const a of rows) {
        const row = Array.isArray(a) ? a : Object.values(a);
        const ip = String(row[2] || '').trim();
        if (!/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(ip)) continue;
        const startMs = toMs(row[0]);
        const flow = row[5];
        out.rows.push({
          ip,
          startMs,
          startText: fmtTs(startMs),
          mac: String(row[3] || ''),
          flowKb: flow != null && flow !== '' && !isNaN(Number(flow)) ? Number(flow) * 1024 : null,
          type: detectTermType(row[10] || row[9] || row[6]),
          duration: row[4] != null ? String(row[4]) : '',
        });
      }
      if (rows.length) out.sources.push(`近期上网记录(${rows.length}条)`);
      else out.histEmpty = true;
    } catch (e) { out.histError = e.message; }

    /* 2) 账单 → 上网记录页：抓页面表格配置 → 直接调数据接口（含翻页） */
    try {
      const page = await this.get('/Self/bill/userOnlineLog', true);
      const cols = extractTableColumns(page);
      const um = /url:\s*["']([^"']+)["']/.exec(page);
      if (um && cols.length) {
        const base = new URL(um[1], CFG.self + '/Self/bill/userOnlineLog').toString();
        const sep = base.includes('?') ? '&' : '?';
        const ymd = dt => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
        const rangeStart = ymd(new Date(now() - 30 * 86400000));
        const rangeEnd = ymd(new Date());
        const fetchPage = async n => {
          const rr = await this.http.request('GET',
            `${base}${sep}pageNumber=${n}&pageSize=100&startTime=${rangeStart}&endTime=${rangeEnd}`,
            { timeout: 12000 });
          diagDump('self_getUserOnlineLog_p' + n, rr.text, true);
          return JSON.parse(rr.text);
        };
        let data = await fetchPage(1);
        let rows = Array.isArray(data) ? data : (data.rows || []);
        let all = rows.slice();
        const total = Array.isArray(data) ? 0 : Number(data.total) || 0;
        let pages = 1;
        while (total && all.length < total && pages < 10) {
          pages++;
          let d2;
          try { d2 = await fetchPage(pages); } catch { break; }
          const r2 = Array.isArray(d2) ? d2 : (d2.rows || []);
          if (!r2.length || JSON.stringify(r2[0]) === JSON.stringify(all[0])) break;
          all = all.concat(r2);
          rows = r2;
        }
        const norm = normalizeRowsByCols(cols, all);
        rawLogRows = all;
        out.rows = out.rows.concat(norm);
        if (norm.length) out.sources.push(`上网记录 userOnlineLog(${norm.length}条${pages > 1 ? `/${pages}页` : ''})`);
      }
    } catch (e) { out.logError = e.message; }

    // P2③：把本账号**上网历史里出现过的 MAC** 并入「本机历史」。
    // WHY：原历史只记「本机当前网卡 MAC」，换过随机 MAC 的自家旧会话认不出来，
    //      会被当成「别人的设备」反复要用户确认。上网记录只属于本账号，正是「本账号用过的设备」。
    try {
      const added = addToMacHistory(macsFromHistoryRows(out.rows.concat(rawLogRows)));
      if (added) out.macHistoryAdded = added;
    } catch { /* 采集失败不影响报表 */ }

    return out;
  }

  /** 只取本账号上网历史里的 MAC（供抢网预检「认出自家旧会话」用）；失败返回 [] */
  async fetchLoginHistoryMacs() {
    const r = await this.http.request('GET', `${CFG.self}/Self/dashboard/getLoginHistory`, { timeout: 12000 });
    diagDump('self_getLoginHistory', r.text, true);
    let data;
    try { data = JSON.parse(r.text); } catch { return []; }
    const rows = Array.isArray(data) ? data : (data.rows || []);
    return macsFromHistoryRows(rows);
  }
}

function buildUnbindCandidates(devList, onlineSessions, csrfToken) {
  const local = localInfo();
  const norm = m => String(m || '').toLowerCase().replace(/[:\-]/g, '');
  const localMac = norm(localMacHex());
  const isSelfMac = m => {
    const x = norm(m);
    return !!x && (x === localMac || local.macs.has(String(m).toLowerCase().replace(/-/g, ':')));
  };
  const mkAction = mac => {
    const raw = String(mac || '').replace(/[^0-9A-Fa-f]/g, '');
    return raw ? { kind: 'unbindmac', mac: raw, token: csrfToken || '' } : null;
  };
  // 右侧绑定设备 = getMacList（与控制台「绑定设备」一致）
  const bound = (devList || []).filter(d => d && d.mac && !isSelfMac(d.mac));
  const boundPcs = bound.filter(d => /pc|电脑|desktop|笔记本|station/i.test(String(d.type || '') + ' ' + String(d.text || '')));
  const boundUse = boundPcs.length ? boundPcs : bound;
  const candidates = boundUse.map(d => ({
    text: `绑定设备 · ${d.type || '未知'} · ${d.ip || d.mac}${d.online ? ' · 在线' : ''}`,
    ip: d.ip || '',
    mac: d.mac || '',
    type: d.type || 'PC',
    online: !!d.online,
    action: d.action || mkAction(d.mac),
    source: 'getMacList',
  }));
  for (const s of (onlineSessions || [])) {
    if ((!s.ip && !s.mac) || isSelfMac(s.mac) || (s.ip && local.ips.has(s.ip))) continue;
    if (!/PC/i.test(String(s.term || ''))) continue;
    const key = norm(s.mac);
    const exist = candidates.find(c => (s.ip && c.ip === s.ip) || (key && norm(c.mac) === key));
    if (exist) { exist.online = true; continue; }
    candidates.push({
      text: `在线中 · PC · ${s.ip}${s.loginTime ? ' · 上线 ' + s.loginTime : ''}`,
      ip: s.ip || '',
      mac: s.mac || '',
      type: 'PC',
      online: true,
      action: mkAction(s.mac),
      source: 'online',
    });
  }
  return candidates;
}

/* 解析 /Self/service/myMac 页面中的设备行（启发式，可随 diag 报告迭代） */
function parseDevices(html) {
  const devices = [];
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const text = row
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const ip = (text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/) || [''])[0];
    const mac = (text.match(/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/) || [''])[0];
    const actionable = /unbind|解绑|删除|下线|del/i.test(row);
    if (!ip && !mac) continue;
    if (/^(IP|地址|设备|类型|时间|序号)\b/i.test(text) && !mac) continue;

    let type = '未知';
    if (/手机|mobile|android|iphone|ios|phone/i.test(text)) type = '手机';
    else if (/电脑|PC|笔记|notebook|windows|台式/i.test(text)) type = 'PC';
    else if (/平板|pad|tablet|ipad/i.test(text)) type = '平板';
    else if (actionable) type = '未知';

    let action = null;
    const fm = /<form([^>]*)>([\s\S]*?)<\/form>/i.exec(row);
    if (fm && /action=/i.test(fm[1])) {
      const am = /action="([^"]+)"/i.exec(fm[1]);
      const params = {};
      for (const inp of fm[2].match(/<input[^>]*>/gi) || []) {
        const n = /name="([^"]+)"/i.exec(inp);
        const v = /value="([^"]*)"/i.exec(inp);
        if (n) params[n[1]] = v ? v[1].replace(/&amp;/g, '&') : '';
      }
      action = { url: am ? am[1] : '', params, method: 'POST' };
    } else {
      const oc = /onclick="([^"]+)"/i.exec(row) || /href="(javascript:[^"]+)"/i.exec(row);
      if (oc && /unbind|解绑|删除|下线|del/i.test(oc[1])) {
        action = { js: oc[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'") };
      }
    }
    devices.push({ text: text.slice(0, 200), ip, mac, type, action, hasAction: !!action });
  }
  const endpoints = [...new Set(
    (html.match(/["'](?:\/Self\/)?service\/[^"']+["']/gi) || []).map(s => s.slice(1, -1))
  )];

  // 兜底：设备列表若由 JS 渲染，尝试从 <script> 内嵌数据里抓 IP/MAC/类型
  if (!devices.length) {
    const scripts = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
    for (const sc of scripts) {
      const ipRe = /\b((?:\d{1,3}\.){3}\d{1,3})\b/g;
      let im;
      while ((im = ipRe.exec(sc))) {
        const ip = im[1];
        if (/^(127\.|0\.0\.0\.0|255\.)/.test(ip)) continue;
        const ctx = sc.slice(Math.max(0, im.index - 300), im.index + 300);
        if (/password|upass|passwd|pwd\s*[:=]/i.test(ctx)) continue;
        const macM = /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/.exec(ctx);
        const deviceHint = /device|term|client|host|mac|phone|computer|pc\b|mobile|android|iphone|终端|设备|手机|电脑/i.test(ctx);
        if (!macM && !deviceHint) continue;
        if (devices.some(d => d.ip === ip)) continue;
        let type = '未知';
        if (/手机|mobile|android|iphone|phone/i.test(ctx)) type = '手机';
        else if (/电脑|computer|notebook|windows|台式|\bpc\b/i.test(ctx)) type = 'PC';
        else if (/平板|tablet|ipad/i.test(ctx)) type = '平板';
        devices.push({
          text: (macM ? macM[0] : (type !== '未知' ? type : '脚本数据')) + ' · ' + ip,
          ip, mac: macM ? macM[0] : '', type, action: null, fromScript: true,
        });
      }
    }
  }

  return { devices, endpoints };
}

function summarizePage(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .split('\n')
    .map(s => s.trim())
    .filter(s => s && /[一-龥A-Za-z0-9]/.test(s));
  return text.slice(0, 60);
}

/* ---------------- 上网记录 / 各 IP 用量 ---------------- */
/* 流量字符串 → KB（无单位按学校口径“流量单位：M”视为 MB） */
function parseFlowKb(s) {
  if (s == null) return null;
  const m = /(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB|B|G|M|K)?/i.exec(String(s));
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (isNaN(v)) return null;
  const u = (m[2] || '').toUpperCase();
  if (u === 'TB') return v * 1073741824;
  if (u === 'GB' || u === 'G') return v * 1048576;
  if (u === 'MB' || u === 'M') return v * 1024;
  if (u === 'B') return v / 1024;
  return v * 1024;
}

function parseCnTime(s) {
  const m = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(s || ''));
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
}

/* ---------------- Dr.COM AJAX 接口（getMacList / getLoginHistory 等） ---------------- */
function detectTermType(term) {
  const s = String(term || '');
  if (/手机|移动终端|mobile|android|iphone|ios|phone|MicroMessenger|Harmony|MIUI/i.test(s)) return '手机';
  if (/平板|tablet|ipad/i.test(s)) return '平板';
  if (/windows|mac\b|linux|pc|desktop|台式|笔记|win/i.test(s)) return 'PC';
  return '未知';
}

function fmtMac(raw) {
  const h = String(raw || '').replace(/[^0-9A-Fa-f]/g, '');
  if (h.length !== 12) return String(raw || '');
  return (h.match(/.{2}/g) || []).join('-');
}

function toMs(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    let n = Number(v);
    if (n < 1e12) n *= 1000;
    return n > 0 ? n : 0;
  }
  return parseCnTime(v) || 0;
}

function fmtTs(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* 从页面脚本提取 bootstrap-table 的 field/title 列定义 */
function extractTableColumns(html) {
  const cols = [];
  const re = /field:\s*['"]?([A-Za-z0-9_]+)['"]?\s*,[\s\S]{0,240}?title:\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(html))) cols.push({ field: m[1], title: m[2] });
  return cols;
}

/* 按列定义把 bootstrap-table 行数组归一化为用量记录 */
function normalizeRowsByCols(cols, rows) {
  const find = re => cols.findIndex(c => re.test(c.title));
  const iStart = find(/上线|开始|登录时间|时间1/);
  const iIp = find(/IP|地址/i);
  const iMac = find(/MAC/i);
  const iFlow = find(/流量|字节|用量/);
  const iTerm = find(/终端|类型|设备/);
  const iDur = find(/时长/);
  const out = [];
  for (const row of rows) {
    const val = i => {
      if (i < 0) return '';
      const f = cols[i].field;
      return Array.isArray(row) ? row[Number(f) == f ? Number(f) : f] : row[f];
    };
    const ipRaw = String(val(iIp) || '');
    const ip = (ipRaw.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/) || [''])[0];
    if (!ip) continue;
    const startVal = val(iStart);
    const startMs = toMs(startVal);
    const flowVal = val(iFlow);
    out.push({
      ip,
      startMs,
      startText: fmtTs(startMs) || String(startVal || ''),
      mac: String(val(iMac) || ''),
      flowKb: flowVal != null && flowVal !== '' ? parseFlowKb(flowVal) : null,
      type: detectTermType(val(iTerm)),
      duration: val(iDur) != null ? String(val(iDur)) : '',
    });
  }
  return out;
}

/* ---------------- 本机标识（用于区分“自己的设备”） ---------------- */

/* MAC 历史（本机历史上用过的 MAC）。
 * 为什么需要：Windows 的 Wi-Fi「随机硬件地址」会换掉整个 MAC，只比对本机**当前**网卡
 * 认不出「本机自己的旧会话」，会把它误报成「其他设备在线」（见踩坑 §19.4 / lib/self-id.js）。
 * 只在真的有新 MAC 时才落盘，正常运行时几乎零写入。 */
let macHistory = null;

function loadMacHistory() {
  if (macHistory) return macHistory;
  macHistory = new Set();
  try {
    const j = JSON.parse(fs.readFileSync(MAC_HISTORY_FILE, 'utf8'));
    for (const m of (j && j.macs) || []) { const k = normMac(m); if (k) macHistory.add(k); }
  } catch { /* 首次运行 / 文件缺失或损坏：从空开始，不打断任何流程 */ }
  return macHistory;
}

/** 把一批 MAC 并入历史；有新条目才写盘。返回**新增条数**（0 = 无需落盘） */
function addToMacHistory(macs) {
  const h = loadMacHistory();
  const added = rememberMacs(h, macs, MAC_HISTORY_MAX);
  if (added) {
    try {
      writeFileAtomic(MAC_HISTORY_FILE, JSON.stringify({ at: new Date().toISOString(), macs: [...h] }, null, 2), 'utf8');
    } catch { /* 写不进去不影响功能，只是少一条历史 */ }
  }
  return added;
}

/** 把本机当前 MAC 并入历史；返回合并后的历史集合 */
function rememberLocalMacs(hexList) {
  addToMacHistory(hexList);
  return loadMacHistory();
}

function localInfo() {
  const macs = new Set(), macsHex = new Set(), ips = new Set();
  const skip = /vmware|veth|virtual|loopback|bluetooth|tap|hyper-?v|vEthernet|vmnet/i;
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (!ni.mac || ni.mac === '00:00:00:00:00:00') continue;
      // 虚拟网卡 MAC 不参与“是否本机”判定，避免误匹配 VMware
      if (skip.test(name + ' ' + ni.mac)) continue;
      macs.add(ni.mac.toLowerCase().replace(/-/g, ':'));
      const k = normMac(ni.mac);
      if (k) macsHex.add(k);
      if (ni.family === 'IPv4' && !String(ni.address || '').startsWith('169.254')) ips.add(ni.address);
    }
  }
  // 无论如何把真实 WLAN/有线 MAC 放进去
  const real = localMacHex();
  if (real) {
    macs.add(real.toLowerCase().replace(/(.{2})(?=.)/g, '$1:'));
    const k = normMac(real);
    if (k) macsHex.add(k);
  }
  // seen = 当前 + 历史。用于把「本机旧会话」标出来（弱证据：默认只标注；
  // 仅当占用**全部**为 maybeSelf 时，shouldAutoUnbind 才会自动解绑——见 lib/self-id.js）
  const seen = rememberLocalMacs(macsHex);
  return { macs, macsHex, ips, seen };
}

/** 一条设备/会话与本机的关系：'self' | 'maybe'（可能是本机旧会话）| '' */
function selfState(mac, ip, local) {
  return selfKind({ mac, ip }, local || localInfo());
}

function isSelfDevice(dev, local) {
  if (dev.mac) {
    const m = String(dev.mac).toLowerCase().replace(/[:-]/g, ':');
    if (local.macs.has(m)) return true;
  }
  if (dev.ip && local.ips.has(dev.ip)) return true;
  return false;
}

/* ---------------- WiFi (netsh) ---------------- */
function netsh(args) {
  return spawnSync('netsh', args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
}

function wifiInfo() {
  try {
    const r = netsh(['wlan', 'show', 'interfaces']);
    const out = r.stdout || '';
    const ssid = ((out.match(/^\s*SSID\s*:\s*(.+)$/m) || [])[1] ||
                  (out.match(/^\s*SSID\s*1\s*:\s*(.+)$/m) || [])[1] || '').trim() || null;
    const state = ((out.match(/^\s*(?:State|状态)\s*:\s*(.+)$/m) || [])[1] || '').trim();
    const pr = netsh(['wlan', 'show', 'profiles']);
    const profiles = (pr.stdout || '').split(/\r?\n/)
      .map(l => {
        const m = /^\s*所有用户配置文件\s*:\s*(.+)$/.exec(l) || /^\s*All User Profile\s*:\s*(.+)$/.exec(l);
        return m ? m[1].trim() : null;
      })
      .filter(Boolean);
    return { ssid, state, profiles };
  } catch (e) {
    return { ssid: null, state: '', profiles: [], error: e.message };
  }
}

/* ---------------- 当前网络身份（网络检测用） ----------------
 * 刻意**不依赖校园门户**：校外、有线、热点都要能准确说出「现在测的是哪个网络」。
 * 因此本机 IP 走系统网卡（os.networkInterfaces），而不是门户返回的 portal.ip
 * —— 后者只在校园网内可达，一离开校园网就永远是「—」。
 */
function classifyNetwork(ssid) {
  if (!ssid) return { campus: false, kind: '未连接 WiFi' };
  if (ssid === CAMPUS_SSID) return { campus: true, kind: '校园网' };
  // HNIST 热点 ≠ 校园网：它访问不了校内自助系统，必须区别于 CAMPUS_SSID
  if (/^HNIST/i.test(ssid)) return { campus: false, kind: '校园热点（不能访校内）' };
  return { campus: false, kind: '非校园网' };
}

// 虚拟网卡名字特征：取本机 IP 时要跳过，否则 VMware/WSL 的地址会顶掉真实网卡
const VIRTUAL_NIC_RE = /vmware|vmnet|virtual|hyper-?v|vethernet|loopback|bluetooth|wsl|tap|tun|zerotier|tailscale/i;

function currentNetwork() {
  const wifi = wifiInfo();
  const ssid = wifi.ssid || null;
  let ip = '', iface = '';
  try {
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      if (VIRTUAL_NIC_RE.test(name)) continue;
      for (const a of list || []) {
        if (a.family !== 'IPv4' || a.internal) continue;
        if (!ip) { ip = a.address; iface = name; }
      }
    }
  } catch (e) { /* 取不到网卡信息不影响检测本身 */ }
  const cls = classifyNetwork(ssid);
  return {
    ssid,
    kind: cls.kind,
    campus: cls.campus,
    // 有 SSID 就按 WiFi 说；没有 SSID 但拿到 IP，说明走的是有线或其它
    type: ssid ? 'WiFi' : (ip ? '有线/其它' : '未连接'),
    ip, iface,
  };
}

/* 网络检测（P2）：最近一次结果 + 并发保护。刻意不落盘（见 AI_PROJECT_CONTEXT「网络检测」） */
let netCheckRunning = false;
let lastNetCheck = null;

function wifiConnect(name) {
  const r = netsh(['wlan', 'connect', `name=${name}`]);
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  const ok = r.status === 0 && !/未找到|not find|找不到/i.test(out);
  return { ok, msg: ok ? `已请求连接 “${name}”` : out.slice(0, 200) || '连接失败' };
}

/* ---------------- 连接任务（SSE 日志流） ---------------- */
const self = new SelfClient();
// C：自助登录互斥租约。`self` 的 checkcode/cookie 是所有登录流程共享的，
//    并发登录会互相覆盖 checkcode（服务端静默弹回登录页）。租约保证同一时刻只有一方在登录。
const selfLoginLease = createLease();
const job = { running: false, events: [], sse: new Set() };

function emit(type, data = {}) {
  const ev = { seq: job.events.length + 1, t: now(), type, ...data };
  job.events.push(ev);
  if (job.events.length > 500) job.events.splice(0, job.events.length - 500);
  try { fs.appendFileSync(path.join(ROOT, 'job_last.log'), JSON.stringify(ev) + '\n'); } catch {}
  const line = 'data: ' + JSON.stringify(ev) + '\n\n';
  for (const res of job.sse) { try { res.write(line); } catch {} }
}

/* 等待用户输入：实现在 lib/user-waiter.js（纯逻辑，有单测）。
 * 保留原来的两个函数名，因此既有调用点无需改动。
 * 用户取消时 resolve 出来的是 CANCELLED（Symbol）：调用方必须先判它，再判空。 */
const userWaiter = createUserWaiter();

function waitFor(key, ms) {
  return userWaiter.wait(key, ms);
}

function resolveWaiter(key, val) {
  return userWaiter.submit(key, val);
}

/* 用户主动取消：包装成带标记的错误，由 runConnect 收尾成「暂停」而不是「出错」 */
function cancelledError(msg) {
  const e = new Error(msg);
  e.cancelled = true;
  return e;
}

async function runConnect(payload) {
  job.running = true;
  job.events = [];
  // C：整个抢网期间独占自助登录（含等待用户输验证码的那几十秒），期间「刷新」等入口会被 409。
  // 租约 10 分钟：占用自救流程里验证码最多提示 2 次（每次最长等 180s）+ 最多 3 次 captive 登录，
  // 300s 在极端路径会提前过期，让「刷新」按钮在任务进行中抢到 checkcode → 又回到静默退回（踩坑 §19.11）。
  selfLoginLease.acquire('connect', 600000);
  try { fs.writeFileSync(path.join(ROOT, 'job_last.log'), ''); } catch {}
  const state = { detect: 'pending', precheck: 'pending', unbind: 'pending', portal: 'pending', verify: 'pending' };
  emit('start', { state: { ...state } });
  const setStep = (k, status, note = '') => { state[k] = status; emit('step', { step: k, status, note, state: { ...state } }); };
  const finish = (ok, msg) => { emit(ok ? 'done' : 'paused', { msg }); };
  // P3：阶段耗时（排查/回归时一眼看出慢在哪一步）
  let __t = Date.now();
  const tick = (name) => { const d = Date.now() - __t; __t = Date.now(); emit('log', { msg: `[计时] ${name} ${d}ms` }); };

  try {
    /* 0. 一键抢网：优先自动切到校园网 HNIST-student */
    const capLog0 = msg => emit('log', { msg: String(msg) });
    const wifiAuto = await ensureCampusWifi(capLog0, { allowSwitch: payload.autoWifi === true });
    if (!wifiAuto.ok) {
      emit('warn', { msg: wifiAuto.msg + '；继续尝试（若已在校园网可忽略）' });
    } else if (wifiAuto.already) {
      emit('log', { msg: '已连接校园网 HNIST-student' });
    } else {
      emit('log', { msg: '已自动切换到校园网 HNIST-student' });
    }

    /* 0.1 校园网内网快检（纯读取）
     * 只在「没连上校园 WiFi」时才跑：可达就按原流程继续（有线校园网走这里），
     * 明显不可达才提前停下，省掉门户/自助后台各自 8~12 秒的超时。
     * 连上校园 WiFi 的正常路径完全不增加耗时。 */
    if (!wifiAuto.ok) {
      const reach = await campusReachable();
      if (!reach.ok) {
        setStep('detect', 'pause', '不在校园网');
        setStep('precheck', 'skip'); setStep('unbind', 'skip'); setStep('portal', 'skip'); setStep('verify', 'skip');
        emit('warn', { msg: '校园网内网不可达（' + reach.note + '）' });
        return finish(false, '已暂停：当前不在校园网内（' + reach.note + '）。请连接 HNIST-student，或勾选「一键抢网时自动连接校园 WiFi」后重试。');
      }
      emit('log', { msg: '校园网内网可达（' + reach.note + '），继续抢网' });
    }

    /* 1. 状态检测 */
    setStep('detect', 'running');
    let st = null, nc = null;
    // 两个探测相互独立（门户 HTTPS vs NCSI HTTP），并行发出，省掉一次串行等待；
    // 断网时 ncsiCheck 会走满 6s 超时，并行后不必再叠在 portalStatus 后面。
    {
      const [stR, ncR] = await Promise.allSettled([portalStatus(), ncsiCheck()]);
      if (stR.status === 'fulfilled') st = stR.value;
      else emit('warn', { msg: '门户状态检测失败：' + ((stR.reason && stR.reason.message) || stR.reason) });
      if (ncR.status === 'fulfilled') nc = ncR.value;
    }
    // 测试网址登录后有数秒滞后：在线状态下多等几轮再决定（避免“已在线还去重登”撞 clientip online）
    if (st && st.online && !(nc && nc.ok)) {
      // 先探后睡：刚登录的场景可能立刻就通，先 sleep 会白等 2s（verify 段的围墙花园轮询已是这样）
      for (let i = 0; i < 5 && !(nc && nc.ok); i++) {
        try { nc = await ncsiCheck(); } catch {}
        if (nc && nc.ok) break;
        await sleep(2000);
      }
    }
    if (st && st.online && nc && nc.ok) {
      setStep('detect', 'ok', '已在线 ' + st.uid);
      setStep('precheck', 'skip'); setStep('unbind', 'skip'); setStep('portal', 'skip');
      setStep('verify', 'ok', '测试网址通过');
      tick('检测在线');
      return finish(true, `网络已在线（${st.uid}），无需重新登录`);
    }
    // 门户在线但数据不通：不要在这里退出（否则会永远提示“请点一键抢网”却不自动填密）
    // 继续往下走凭据 + Captive 自动登录
    if (st && st.online) {
      setStep('detect', 'ok', '门户在线但数据未打通，将自动填密重登');
      emit('log', { msg: `检测到门户会话在线但测试网址不通（flow=${st && st.flowKB}）：进入 Captive 自动填密重登，避免死循环。` });
    } else {
      setStep('detect', 'ok', '当前未在线');
    }
    tick('检测在线');

    /* 取凭据 */
    const acc = payload.accountId ? accountById(payload.accountId) : null;
    if (payload.accountId && !acc) throw new Error('账号不存在');
    const username = acc ? acc.username : payload.username;
    const suffix = acc ? (acc.suffix || '') : (payload.suffix || '');
    let password = payload.password || '';
    if (!password && acc) {
      try { password = passwordOf(acc); } catch (e) { throw new Error('本机解密保存的密码失败：' + e.message); }
    }
    if (!username || !password) throw new Error('缺少账号或密码（请先在账号簿保存密码，或在弹窗中输入）');

    /* 2. 预检：自助服务查在线设备（失败先静默重试；占用/会话冲突的确认与自救全部合并到 handleOccupancy） */
    setStep('precheck', 'running');
    let others = [];
    /* 验证码提示全程最多两次：一次正常输入 + 一次「被后台静默退回」的换码重试。
     * 输错验证码仍然只弹一次（人工成本高，反复弹会让人以为验证码永远输不完）；
     * 但服务器**不说原因**地把登录弹回登录页时，让用户回去再点一次「一键抢网」代价更大。 */
    let captchaAsked = 0;
    let captchaRetriedBounce = false;
    const askCaptchaOnce = async (img, note, stepName) => {
      captchaAsked++;
      emit('captcha', { img });
      setStep(stepName || 'precheck', 'wait', note || '自助服务登录：请输入验证码');
      const code = await waitFor('captcha', 180000);
      if (code === CANCELLED) throw cancelledError('已取消：等待验证码时用户点了取消，本次抢网已停止');
      return code || '';
    };
    const selfLoginOnce = async (note, presetCaptcha, stepName) => {
      let lg = await self.ensureLogin(username, password, presetCaptcha || null);
      if (!lg.ok && lg.needCaptcha && captchaAsked === 0) {
        const code = await askCaptchaOnce(lg.captchaB64, note, stepName);
        if (!code) return { ok: false, tip: '验证码输入超时', needCaptcha: false };
        lg = await self.login(username, password, code);
      }
      // 被后台静默退回（回到登录页且没给任何原因）→ 换一张新验证码再给用户一次机会，只做一次。
      if (!lg.ok && lg.bounced && !captchaRetriedBounce) {
        captchaRetriedBounce = true;
        emit('log', { msg: '自助后台把登录静默退回登录页（未给原因）：换一张验证码再试一次…' });
        let freshImg = null;
        try { await self.openLogin(); await self.fetchCaptcha(); freshImg = self.captchaB64; } catch {}
        if (!freshImg) return lg; // 连新验证码图都拿不到 → 别弹空图让用户干等，直接返回原结果
        const code = await askCaptchaOnce(freshImg,
          '上一次自助登录被后台静默退回（旧会话没退干净 / 验证码已过期），请再输一次验证码', stepName);
        if (!code) return { ok: false, tip: '验证码输入超时', needCaptcha: false };
        lg = await self.login(username, password, code);
      }
      return lg;
    };
    const isSelfSessionConflict = tip => /别处|会话|占用|无提示|失效|活跃|注销自助后台|未给出原因|登录失败/i.test(String(tip || ''));
    // 预检专用：**静默**登录，绝不弹验证码。顺畅路径（绝大多数）根本不需要解绑，
    // 不该为了预检打断用户输验证码；真被名额挡住时，占用分支会再登录一次（那时才弹）。
    const selfLoginQuiet = async presetCaptcha => {
      const r = await self.ensureLogin(username, password, presetCaptcha || null);
      if (r.ok) return r;
      return { ok: false, needCaptcha: !!r.needCaptcha, tip: r.needCaptcha ? '需要验证码' : (r.tip || '') };
    };

    // 预检：只尝试「复用已有会话 / 静默登录」，成功就顺手拿设备列表；
    // 需要验证码就**安静跳过**（不弹窗、不阻塞），直接去门户登录——被拒时再回来处理。
    let lg = await selfLoginQuiet(payload.captcha);
    if (!lg.ok && isSelfSessionConflict(lg.tip)) {
      emit('log', { msg: '自助服务未登录（疑似会话冲突）：自动注销本机会话后静默重试一次…' });
      await forceSelfSessionReset();
      lg = await selfLoginQuiet();
    }
    if (!lg.ok) {
      emit('log', { msg: '自助服务暂未登录（需要验证码）：跳过预检，直接登录门户；只有在被名额挡住时才请你输一次验证码。' });
      setStep('precheck', 'skip', '跳过预检（未登录自助服务）');
      setStep('unbind', 'skip');
    } else {
      // P1-b：三个 GET 相互独立（dashboard / myMac+getMacList / getOnlineList），并发发出以省往返。
      // 并发若被服务端限制（任一硬失败），退回串行重走一遍，保证与旧行为一致、不丢结果。
      const grab = fn => (async () => { try { return { v: await fn() }; } catch (e) { return { e }; } })();
      const grabMac = async () => {
        try { return { v: await self.loadMacList() }; }
        catch (e) {
          try { return { v: parseDevices(await self.get('/Self/service/myMac', true)).devices, warn: 'getMacList 失败，回退页面解析：' + e.message }; }
          catch (e2) { return { e: e2, warn: 'getMacList 失败(' + e.message + ')，回退页面解析也失败：' + e2.message }; }
        }
      };
      const [dR, mR, sR] = await Promise.all([
        grab(() => self.get('/Self/dashboard', true).then(summarizePage)),
        grabMac(),
        grab(() => self.getOnlineSessions()),
      ]);
      let dashLines = [], devList = [], onlineSessions = [];
      if (dR.e || mR.e || sR.e) {
        // 并发疑似被服务端拒绝：退回串行（旧行为），逐项容错、照常出告警。
        emit('log', { msg: '预检并发请求未全部成功，改为串行重试一次…' });
        try { dashLines = summarizePage(await self.get('/Self/dashboard', true)); }
        catch (e) { emit('warn', { msg: '读取仪表盘失败：' + e.message }); }
        try { devList = await self.loadMacList(); }
        catch (e) {
          emit('warn', { msg: 'getMacList 失败，回退页面解析：' + e.message });
          try { devList = parseDevices(await self.get('/Self/service/myMac', true)).devices; }
          catch (e2) { emit('warn', { msg: '读取绑定列表失败：' + e2.message }); }
        }
        try { onlineSessions = await self.getOnlineSessions(); } catch {}
      } else {
        dashLines = dR.v;
        devList = mR.v;
        if (mR.warn) emit('warn', { msg: mR.warn });
        onlineSessions = sR.v;
      }

      let local = localInfo();
      self.lastDevices = devList;
      // P2③：出现「**不认识的 PC 占用**」时，才多拉一次本账号上网历史来补 MAC，然后重建判定。
      // WHY：seen-macs 只记「本机当前网卡 MAC」，换过随机 MAC 的自家旧会话（如 183d2d…）不在里面，
      //      会被当成「别人的设备」反复要用户确认。上网记录只属于本账号，正是「本账号用过的设备」。
      // 代价控制：顺畅路径（无占用 / 占用已能识别）**不产生任何额外请求**，只在真需要时才拉一次。
      try {
        const hasUnknownPc = onlineSessions.some(s =>
          s.ip && /PC/i.test(String(s.term || '')) && selfState(s.mac, s.ip, local) === '');
        if (hasUnknownPc) {
          const hist = await self.fetchLoginHistoryMacs();
          const added = addToMacHistory(hist);
          if (added) {
            local = localInfo(); // 重建 seen（含刚补充的历史 MAC）
            emit('log', { msg: `从上网历史补充 ${added} 条本机曾用 MAC，用于识别「自己的旧会话」` });
          }
        }
      } catch (e) { emit('warn', { msg: '读取上网历史补充 MAC 失败：' + e.message }); }
      // 占用判定以“真实在线会话(getOnlineList)”为准；绑定列表的在线标记会滞后，曾导致误弹
      const sessKind = s => selfState(s.mac, s.ip, local);
      const isSelfSess = s => sessKind(s) === 'self';
      // 学校配额 = 1台PC + 1台手机：我们是电脑，自动流程只盯 PC；
      // 手机在线不占 PC 名额 → 不检测、不解绑（设备表里仍可单独手动解绑）
      const isPCSess = s => /PC/i.test(String(s.term || ''));
      const nonPc = onlineSessions.filter(s => s.ip && !isSelfSess(s) && !isPCSess(s));
      if (nonPc.length) {
        emit('log', { msg: '其他非 PC 设备在线（不占 PC 名额，忽略）：' + nonPc.map(s => `${detectTermType(s.term) || '未知'} · ${s.ip}`).join('；') });
      }
      let onlineOthers = onlineSessions.filter(s => s.ip && !isSelfSess(s) && isPCSess(s));
      others = onlineOthers.map(s => {
        const mt = String(s.term || '');
        const match = devList.find(d =>
          (s.ip && d.ip === s.ip) ||
          (s.mac && d.mac && String(d.mac).toLowerCase().replace(/[:-]/g, ':') === String(s.mac).toLowerCase().replace(/[:-]/g, ':')));
        const type = detectTermType(mt) !== '未知' ? detectTermType(mt) : (match ? match.type : '未知');
        // MAC 不在本机当前网卡、但本机以前用过 → 大概率是自己（随机硬件地址换过 MAC），
        // 不是「别人在占」。只做标注与提示，不影响后面是否解绑的决策。
        const maybeSelf = sessKind(s) === 'maybe';
        return {
          text: `在线中 · ${type} · ${s.ip}${s.loginTime ? ' · 上线 ' + s.loginTime : ''}`
            + (maybeSelf ? '（可能是本机旧会话）' : ''),
          ip: s.ip,
          mac: s.mac || (match ? match.mac : ''),
          type,
          online: true,
          maybeSelf,
          action: match && match.action ? match.action : null,
        };
      });
      const maybeSelfCount = others.filter(d => d.maybeSelf).length;

      emit('devices', {
        devices: devList.map(d => ({
          text: d.text, ip: d.ip, mac: d.mac, type: d.type,
          online: typeof d.online === 'boolean' ? d.online : null, isSelf: isSelfDevice(d, local),
          maybeSelf: selfState(d.mac, d.ip, local) === 'maybe',
        })),
        endpoints: [],
        dashLines,
      });

      if (others.length) {
        setStep('precheck', 'ok', maybeSelfCount
          ? `有 ${others.length} 条其他 PC 会话（其中 ${maybeSelfCount} 条可能是本机旧会话）`
          : `有 ${others.length} 台其他设备在线（先直接登录，不影响就无需处理）`);
        emit('log', { msg: '其他在线设备：' + others.map(d => d.text).join('；') });
      } else {
        setStep('precheck', 'ok', '无其他设备在线');
      }
    }

    tick('预检');

    /* 3. 门户登录——主路径 = captive 浏览器自动填密；裸接口仅作兑底 */
    setStep('unbind', 'skip', others.length ? '登录受阻才会解绑' : '无需解绑');

    /* B：门户的「只允许一台设备」看的是**在线会话**（getOnlineList），不是解绑记录（getMacList）。
       解绑成功 ≠ 会话下线，所以解绑后要轮询到目标会话真的消失，再去登录门户——
       否则就是「解绑了还是被拒、要多点几次」。 */
    const waitOnlineSessionsGone = async (list, timeoutMs) => {
      const keys = (list || [])
        .map(d => String((d && d.mac) || '').replace(/[^0-9A-Fa-f]/g, '').toLowerCase())
        .filter(Boolean);
      if (!keys.length) return true;
      const t0 = Date.now();
      let waited = 0;
      while (Date.now() - t0 < timeoutMs) {
        await sleep(2000);
        waited = Date.now() - t0;
        let sess;
        try { sess = await self.getOnlineSessions(); }
        catch { continue; } // 读不到就继续等，别把「读失败」当成「已下线」
        const still = sess.filter(s => keys.includes(String((s && s.mac) || '').replace(/[^0-9A-Fa-f]/g, '').toLowerCase()));
        if (!still.length) {
          emit('log', { msg: `解绑后等待 ${Math.round(waited / 1000)}s：占用会话已下线` });
          return true;
        }
        setStep('unbind', 'running', `等待占用会话下线… ${Math.round(waited / 1000)}s`);
      }
      emit('warn', { msg: `解绑后已等 ${Math.round(timeoutMs / 1000)}s，占用会话仍在线：该设备可能仍在联网（会自动重连），或解绑生效有延迟` });
      return false;
    };

    const unbindOthers = async () => {
      setStep('unbind', 'running');
      let acted = 0, failed = 0;
      for (const d of others) {
        if (!d.action && d.mac) {
          d.action = { kind: 'unbindmac', mac: String(d.mac).replace(/[^0-9A-Fa-f]/g, ''), token: self.ajaxCsrf || '' };
        }
        if (!d.action) { failed++; emit('warn', { msg: `无法自动解绑（未识别其绑定记录）：${d.ip || d.mac}` }); continue; }
        try {
          await self.unbind(d);
          acted++;
          emit('log', { msg: `已解绑 ${d.text || d.ip || d.mac}` });
        } catch (e) {
          failed++;
          emit('warn', { msg: `解绑失败（${d.ip || d.mac}）：${e.message}` });
        }
      }
      setStep('unbind', acted && !failed ? 'ok' : 'warn',
        acted ? `已解绑 ${acted} 个${failed ? `，${failed} 个失败` : ''}` : '解绑未完成');
      await sleep(800);
      const gone = await waitOnlineSessionsGone(others, 12000);
      return { acted, failed, gone };
    };

    // 把服务端缓存的设备表推给右侧「绑定设备」（重拉列表后跟手更新，用户不用手动点刷新）
    const emitDevicesNow = () => {
      const devList = self.lastDevices || [];
      if (!devList.length) return;
      const lc = localInfo();
      emit('devices', {
        devices: devList.map(d => ({
          text: d.text, ip: d.ip, mac: d.mac, type: d.type,
          online: d.online, isSelf: isSelfDevice(d, lc), hasAction: !!d.action,
          maybeSelf: selfState(d.mac, d.ip, lc) === 'maybe',
        })),
        endpoints: [],
        dashLines: [],
      });
    };

    // 解绑只该动「正在占名额的 PC」：弹窗承诺的是「解绑本账号下**占用**的 PC 设备（手机不动）」，
    // 所以候选一律窄化到「在线 且 PC 型」——离线绑定记录、手机/平板都不该被自动解绑。
    // 用**这一次**在线会话/绑定表来判断，不采用上次会话残留的 `self.lastDevices`（那是 stale 数据，
    // 按它解绑可能解到已经不存在、或现在属于别人的设备）。
    const onlinePcOnly = list => (list || []).filter(o =>
      o && o.online && /PC|电脑|desktop|笔记本|station/i.test(String(o.type || '')));

    /* 登录真被名额挡住 → **一次**确认 + 一次完整自救：取设备列表 → 解绑 → 等会话下线，全部在同一次点击里走完。
     * 为什么合并：原来这里是两个弹窗——先「是否注销自助后台」、拿到列表后再「是否解绑」；
     * 而且拿不到列表时，「解绑并继续」点下去只会抛错让用户回右侧点刷新、再点一次一键抢网（空点击）。
     * 现在只有一次确认；确认后取列表要用验证码是**必要输入**，不再算第二次确认。 */
    const handleOccupancy = async (reasonMsg) => {
      // ① 先尽力拿列表（不打扰用户、不注销任何会话）：有自助会话就直接重拉（只信**这一次**的数据）。
      if (!others.length && self.loggedIn) {
        try { others = onlinePcOnly(await self.loadUnbindCandidates()); }
        catch (e) { emit('warn', { msg: '重拉绑定设备失败：' + e.message }); }
      }
      // ② 占用设备**全部**是本机旧会话（随机硬件地址换过 MAC 造成的自己那条）→ 直接自动解绑，不打扰用户。
      if (others.length) emit('log', { msg: '解绑候选：' + others.map(o => o.text).join('；') });
      if (shouldAutoUnbind(others)) {
        emit('log', { msg: `占用设备 ${others.length} 条全部是「可能本机旧会话」（随机硬件地址所致），自动解绑、不再确认` });
        const r = await unbindOthers();
        if (r.acted && !r.failed) return 'ok';
      }
      emitDevicesNow();

      // 已登录自助后台，但列表里没有「在线的 PC」可解绑：没东西可做，别再让用户确认。
      // 占名额的可能是未绑定/手机设备，或那个会话刚消失；硬去解绑只会动到不该动的设备。
      if (self.loggedIn && !others.length) {
        emit('log', { msg: '自助后台已登录，但没有可自动解绑的在线 PC 会话：不解绑、不弹窗，直接重登一次（' + reasonMsg + '）' });
        return 'ok';
      }

      // ③ 唯一一次确认：把「注销后台占用 / 取列表 / 解绑 / 重登」一次说清（文案组装见 lib/occupancy-prompt.js）。
      //    此刻列表为空 = 自助后台还没登录（取列表要输验证码），所以只会是「注销后台占用并自动解绑」这一种。
      emit('decision', occupancyPrompt(others));
      setStep('portal', 'wait', others.length ? '等待确认：是否解绑占用设备' : '等待确认：是否注销后台占用并自动解绑');
      const act = await waitFor('decision', 300000);
      if (act !== 'continue') {
        setStep('portal', 'pause'); setStep('unbind', 'skip'); setStep('verify', 'skip');
        finish(false, '已暂停：请先处理占用设备，或到「设置」里注销自助后台，之后再点“一键抢网”。');
        return 'paused';
      }

      // ④ 没有列表就先把列表取回来：注销自助后台占用（单会话排他，不注销就登不进去）→ 登录（必要时输验证码）。
      if (!others.length) {
        try { await forceSelfSessionReset(); } catch {}
        try {
          const lg2 = await selfLoginOnce('需要设备列表来自动解绑：请输入验证码', undefined, 'portal');
          if (lg2.ok) others = onlinePcOnly(await self.loadUnbindCandidates());
          else emit('warn', { msg: '未能登录自助服务（拿不到设备列表）：' + (lg2.tip || '未知原因') });
        } catch (e) {
          if (e && e.cancelled) throw e; // 用户点了「取消抢网」→ 交给外层收摊
          emit('warn', { msg: '登录自助服务失败：' + e.message });
        }
        if (others.length) emit('log', { msg: '解绑候选：' + others.map(o => o.text).join('；') });
        emitDevicesNow();
      }

      // ⑤ 解绑（含等在线会话真的消失）。真拿不到就不猜设备，直接去重登——
      //    「再点一次一键抢网就好了」这件事由外层在同一次任务里自动做掉。
      if (others.length) {
        const r = await unbindOthers();
        if (!r.acted) emit('warn', { msg: '没能解绑任何占用设备（原因见上），直接重试登录一次' });
      } else {
        emit('warn', { msg: '拿不到设备列表：本次不解绑也不猜设备，直接重试登录一次（' + reasonMsg + '）' });
      }
      return 'ok';
    };

    // A：预检发现占用时**不再弹窗**——顺畅路径不打扰用户。只有「占用全部是本机旧会话」才静默解绑，
    //    其余情况直接去登录门户；真被名额挡住时会在下面弹**唯一一次**确认（两处弹窗 → 一处）。
    if (others.length) {
      emit('log', { msg: '预检发现其他 PC 占用名额：' + others.map(d => d.text).join('；') });
      if (shouldAutoUnbind(others)) {
        emit('log', { msg: '这些占用全部是「可能本机旧会话」（随机硬件地址所致）：登录门户前先自动解绑' });
        await unbindOthers();
      } else {
        setStep('portal', 'wait', '有其他 PC 在线，先直接登录试试');
      }
    }

    setStep('portal', 'running', 'Captive 自动登录中…');
    const accLabel = username + (suffix || '');
    emit('log', { msg: `打开门户登录页并自动填入账号（${accLabel}）…` });
    const capLog = msg => emit('log', { msg: String(msg) });
    let pr;
    try {
      pr = await captiveAutoLogin(username, suffix, password, capLog);
    } catch (e) {
      const url = openCaptivePortal();
      setStep('portal', 'fail', e.message);
      emit('log', { msg: `Captive 自动登录异常：${e.message}。已打开 ${url} —— 可手动填写。` });
      return finish(false, '自动登录失败：' + e.message + '（已打开门户登录页，请手动登录后再试）');
    }
    if (!pr.ok && pr.raw && (pr.raw.kind === 'occupancy' || pr.raw.failPage)) {
      /* 登录真被名额挡住 → **一次**确认 + 一次完整自救（取列表 → 解绑 → 重登），不再有两连弹窗，
         也不再在确认之后把用户打发回去「点右侧刷新、再点一次一键抢网」。 */
      const handled = await handleOccupancy(pr.msg);
      if (handled === 'paused') return;
      /* 解绑后门户仍可能拒绝：在线会话下线有延迟、配额也可能要等下一次登录才放行。
         实测用户就是「再点一次一键抢网就连上了」——把这一次点击在同一次任务里自动做掉。
         次数按失败性质分档：**名额类**才多给一次（共 2 次，第二次前等 5s 给服务端同步时间）；
         密码错误之类的失败仍然只重试 1 次，避免反复提交同一份凭据。 */
      const quotaHit = /一台|占用|已满|OLno|inuse|名额|只能/i.test(
        String((pr.raw && pr.raw.msga) || '') + ' ' + String(pr.msg || ''));
      const maxTry = quotaHit ? 2 : 1;
      for (let i = 1; i <= maxTry && !pr.ok; i++) {
        if (i > 1) await sleep(5000);
        setStep('portal', 'running', i === 1 ? 'Captive 重试登录…' : `Captive 再重试一次登录（${i}/${maxTry}）…`);
        try { pr = await captiveAutoLogin(username, suffix, password, capLog); }
        catch (e) {
          const url = openCaptivePortal();
          setStep('portal', 'fail', e.message);
          return finish(false, '自动登录失败：' + e.message + '（已打开门户登录页）');
        }
        if (pr.ok || !(pr.raw && (pr.raw.kind === 'occupancy' || pr.raw.failPage))) break;
        emit('warn', { msg: `门户仍被名额挡住（重试 ${i}/${maxTry}）：${pr.msg}` });
      }
      if (!pr.ok && pr.raw && (pr.raw.kind === 'occupancy' || pr.raw.failPage)) {
        // unbind 的状态别动：解绑成功过就停在 ok，没解绑就保持原样——别再标成「暂停/失败」误导流水线。
        setStep('portal', 'pause');
        setStep('verify', 'skip');
        return finish(false, '已暂停：' + pr.msg
          + `。已自动重试 ${maxTry} 次仍未放行——占用设备多半是别人的电脑，或它自己又重连上了；`
          + '可在右侧「绑定设备」点「刷新」核对后再手动解绑，或稍后再点一次「一键抢网」。');
      }
    }
    if (!pr.ok && pr.raw && pr.raw.kind === 'walled') {
      const mac = localMacHex() || '';
      const url = `${CFG.portal}/${mac ? '?usermac=' + mac : ''}`;
      openCaptivePortal();
      setStep('portal', 'fail', pr.msg);
      setStep('verify', 'warn', '数据未打通');
      emit('log', {
        msg: `${pr.msg}。已打开无痕门户窗口 ${url} —— 若已在校园网，点页面上的登录/返回完成放行；请确认账号带服务商后缀（如 @cmcc）。`,
      });
      return finish(false, '门户已登录但数据未打通：请在校园网（HNIST-student）下于门户页确认登录，并确认账号为 学号@cmcc');
    }
    if (!pr.ok) {
      const url = openCaptivePortal();
      setStep('portal', 'fail', pr.msg);
      emit('log', { msg: `Captive 自动登录失败：${pr.msg}。已打开 ${url} —— 可手动填写登录。` });
      return finish(false, '自动登录失败：' + pr.msg + '（已打开门户登录页，请手动登录后再试）');
    }
    setStep('portal', 'ok', pr.msg);
    tick('门户登录');

    /* 5. 验证 */
    setStep('verify', 'running');
    st = await portalStatus();
    nc = null;
    for (let i = 0; i < 6; i++) {
      try { nc = await ncsiCheck(); } catch {}
      if (st.online && nc && nc.ok) break;
      await sleep(2000);
      st = await portalStatus().catch(() => st);
    }
    if (!st.online) { setStep('verify', 'fail', '仍未在线'); throw new Error('登录后状态检测仍显示离线'); }
    if (isWalledGarden(st, nc)) {
      emit('log', { msg: `验证：门户在线但流量=${st.flowKB || 0}，测试网址未过（围墙花园）。` });
      try {
        emit('log', { msg: '再尝试一次 Captive 自动登录以完成设备绑定…' });
        setStep('portal', 'running', 'Captive 补登…');
        pr = await captiveAutoLogin(username, suffix, password, capLog);
        if (pr.ok) {
          setStep('portal', 'ok', pr.msg);
          st = await portalStatus();
          nc = null;
          for (let i = 0; i < 6; i++) {
            try { nc = await ncsiCheck(); } catch {}
            if (st.online && nc && nc.ok) break;
            await sleep(2000);
            st = await portalStatus().catch(() => st);
          }
        }
      } catch (e) {
        emit('warn', { msg: 'Captive 补登失败：' + e.message });
      }
      if (!(st.online && nc && nc.ok) && isWalledGarden(st, nc)) {
        const url = openCaptivePortal();
        setStep('verify', 'warn', '门户在线但数据未打通（已打开门户登录页）');
        emit('log', {
          msg: `围墙花园：chkstatus 在线、流量=${st.flowKB || 0}。已打开 ${url} —— 请在浏览器完成登录（会绑定本机设备）。`,
        });
        if (acc) { acc.lastUsed = now(); saveVault(); }
        return finish(false, '门户登录成功但网络数据未打通：请完成浏览器门户登录（绑定本机设备）后再试');
      }
    }
    setStep('verify', nc && nc.ok ? 'ok' : 'warn',
      st.uid + (nc && nc.ok ? '，测试网址通过' : '（测试网址多次未过，可稍后再试）'));
    tick('验证放行');
    if (acc) { acc.lastUsed = now(); saveVault(); }

    // 联网成功：关掉手动/Captive 弹出的无痕门户窗口
    if (st && st.online && nc && nc.ok) {
      if (closeManualPortal()) emit('log', { msg: '已自动关闭门户无痕窗口' });
    }

    if (payload.autoWifi && payload.wifiProfile) {
      const w = wifiConnect(payload.wifiProfile);
      emit('log', { msg: w.msg });
    }
    return finish(true, `连接成功：${st.uid}`);
  } catch (e) {
    // 用户主动取消 → 明确的「暂停」，而不是弹一个红色错误
    if (e && e.cancelled) finish(false, e.message || '已取消');
    else emit('error', { msg: e.message || String(e) });
  } finally {
    job.running = false;
    selfLoginLease.release('connect');
    emit('end', {});
  }
}

/* ---------------- HTTP 服务 ---------------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    // 不发任何 CORS 头：控制台页面由本服务自己托管（同源），跨域一律不授权。
    // 令牌校验在 handleApi 内，外部网站即使能连上也拿不到数据。
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > 2 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const full = path.normalize(path.join(ROOT, p));
  if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

/* 设备/用量数据的组装（路由与「借网查看」共用，避免两处逻辑漂移） */
async function buildDevicesPayload() {
  const local = localInfo();
  let devices = [], via = 'macList';
  try { devices = await self.loadMacList(); }
  catch (e) {
    via = 'html-fallback';
    devices = parseDevices(await self.get('/Self/service/myMac', true)).devices;
  }
  self.lastDevices = devices;
  let onlineSessions = [];
  try { onlineSessions = await self.getOnlineSessions(); } catch {}
  return {
    devices: devices.map(d => ({
      text: d.text, ip: d.ip, mac: d.mac, type: d.type, online: typeof d.online === 'boolean' ? d.online : null,
      isSelf: isSelfDevice(d, local),
      // 「可能是本机旧会话」：MAC 不在本机当前网卡里，但本机以前用过（随机硬件地址换过 MAC）
      maybeSelf: selfState(d.mac, d.ip, local) === 'maybe',
      hasAction: !!d.action,
    })),
    endpoints: [],
    via,
    onlineSessions,
  };
}

async function buildUsagePayload() {
  const rep = await self.fetchUsageReport();
  // 设备类型映射来自 getMacList（按最近登录 IP 尽力匹配）
  const typeByIp = {}, macByIp = {};
  try {
    for (const d of await self.loadMacList()) {
      if (d.ip && d.type && d.type !== '未知') typeByIp[d.ip] = d.type;
      if (d.ip && d.mac) macByIp[d.ip] = d.mac;
    }
  } catch {}
  const local = localInfo();
  const rows = rep.rows || [];
  const agg = new Map();
  for (const r of rows) {
    if (!r.ip) continue;
    let a = agg.get(r.ip);
    if (!a) {
      a = {
        ip: r.ip, sessions: 0, totalKb: 0,
        lastUsedMs: 0, lastUsedText: '', lastKb: 0,
        type: typeByIp[r.ip] || (r.type !== '未知' ? r.type : '未知'),
      };
      agg.set(r.ip, a);
    }
    if (a.type === '未知') {
      const t = typeByIp[r.ip] || (r.type !== '未知' ? r.type : '');
      if (t) a.type = t;
    }
    a.sessions++;
    if (r.flowKb != null) a.totalKb += r.flowKb;
    if (r.startMs && r.startMs >= a.lastUsedMs) {
      a.lastUsedMs = r.startMs;
      a.lastUsedText = r.startText || '';
      if (r.flowKb != null) a.lastKb = r.flowKb;
    }
  }
  const ips = [...agg.values()]
    .map(a => ({
      ...a,
      isSelf: local.ips.has(a.ip),
      // 用量行只有 IP，靠「绑定设备」列表把 IP 映射回 MAC，再判断是不是本机旧会话
      maybeSelf: selfState(macByIp[a.ip], a.ip, local) === 'maybe',
    }))
    .sort((x, y) => (y.lastUsedMs - x.lastUsedMs) || (y.totalKb - x.totalKb));
  const err = rep.histError || rep.logError || '';
  return {
    ok: true,
    ips,
    source: (rep.sources || []).join(' + ') || null,
    pages: 0,
    rows: rows.length,
    hasFlow: rows.some(r => r.flowKb != null),
    hasTime: rows.some(r => r.startMs > 0),
    candidates: [],
    note: rows.length
      ? ''
      : ('未取到上网记录' + (err ? '：' + err : '（getLoginHistory 为空或结构未识别）——请开诊断模式后再点一次加载，把 diag/ 文件夹交给我分析')),
  };
}

async function handleApi(req, res, pathname, query) {
  const token = query.get('token') || query.get('t') || req.headers['x-token'];
  if (pathname === '/api/ping') {
    return json(res, 200, { ok: true, ver: '1.0.0', config: { portal: CFG.portal, self: CFG.self, ncsi: CFG.ncsi } });
  }
  if (pathname === '/api/alive') {
    if (token !== TOKEN) return json(res, 403, { error: '访问令牌无效' });
    const t = now();
    life.lastAliveAt = t;
    life.goodbyeAt = 0;
    life.everAlive = true;
    return json(res, 200, { ok: true, t });
  }
  if (pathname === '/api/goodbye') {
    if (token !== TOKEN) return json(res, 403, { error: '访问令牌无效' });
    life.goodbyeAt = now();
    return json(res, 200, { ok: true });
  }
  if (pathname === '/api/termlog') {
    if (token !== TOKEN) return json(res, 403, { error: '访问令牌无效' });
    const lines = termLogLines(query.get('since'));
    const last = lines.length ? lines[lines.length - 1].seq : (termLog.length ? termLog[termLog.length - 1].seq : 0);
    return json(res, 200, { ok: true, lines, lastSeq: last, total: termLog.length });
  }
  if (token !== TOKEN) return json(res, 403, { error: '访问令牌无效，请通过启动脚本打开页面' });
  if (req.method === 'OPTIONS') return json(res, 204, {});

  try {
    switch (pathname) {
      case '/api/ipnotes': {
        // GET：读取全部备注；POST：{ ip, note } 写入（note 为空 = 删除）
        if (req.method === 'GET') return json(res, 200, { ok: true, notes: ipNotes });
        const b = await readBody(req);
        const next = applyNote(ipNotes, b.ip, b.note);
        const prev = ipNotes;
        ipNotes = next;
        if (!saveIpNotes()) { ipNotes = prev; return json(res, 500, { error: '备注保存失败（磁盘写入错误）' }); }
        return json(res, 200, { ok: true, notes: ipNotes });
      }
      case '/api/netcheck': {
        const network = currentNetwork();
        // GET：只回网络身份与最近一次结果，不触发任何探测
        if (req.method === 'GET') {
          return json(res, 200, { ok: true, network, result: lastNetCheck, running: netCheckRunning });
        }
        if (netCheckRunning) return json(res, 429, { ok: false, error: '上一次检测还没跑完，稍等一下再点' });
        netCheckRunning = true;
        try {
          const r = await runNetCheck();
          // 连网络身份一起存：这份数字是在哪个网络上测出来的，必须跟着数字走
          lastNetCheck = { ...r, network };
          return json(res, 200, { ok: true, network, result: lastNetCheck });
        } finally {
          netCheckRunning = false;
        }
      }
      case '/api/status': {
        const [st, nc] = await Promise.all([
          portalStatus().catch(e => ({ online: false, error: e.message })),
          ncsiCheck(),
        ]);
        const wifi = wifiInfo();
        return json(res, 200, {
          portal: st, ncsi: nc, diag: diagOn, running: job.running,
          wifi: {
            ...wifi,
            // 「切回原网络」按钮的数据：只提供信息，切不切由用户点
            canRestore: !!(lastWifiSwitch && lastWifiSwitch.from),
            restoreFrom: (lastWifiSwitch && lastWifiSwitch.from) || '',
          },
        });
      }
      case '/api/portal/login': {
        const b = await readBody(req);
        let username = b.username, suffix = b.suffix || '', password = b.password || '';
        if (b.accountId) {
          const a = accountById(b.accountId);
          if (!a) return json(res, 404, { error: '账号不存在' });
          username = a.username;
          suffix = (typeof b.suffix === 'string') ? b.suffix : (a.suffix || '');
          if (!password) password = passwordOf(a) || '';
        } else if (typeof b.suffix === 'string') { suffix = b.suffix; }
        if (!username || !password) return json(res, 400, { error: '缺少账号或密码' });
        return json(res, 200, await portalLogin(username, suffix, password));
      }
      case '/api/portal/logout':
        return json(res, 200, await portalLogout());

      case '/api/portal/open': {
        const url = openCaptivePortal();
        return json(res, 200, { ok: true, url, mac: localMacHex() });
      }

      case '/api/browsers/leftovers': {
        const found = await listLeftoverBrowsers();
        return json(res, 200, { ok: true, count: found.length, pids: found.map(b => b.pid) });
      }

      case '/api/browsers/clean': {
        const found = await listLeftoverBrowsers();
        let killed = 0;
        for (const b of found) {
          try {
            spawnSync('taskkill', ['/F', '/T', '/PID', String(b.pid)], { stdio: 'ignore', windowsHide: true });
            untrackBrowser(b.pid);
            killed++;
          } catch {}
        }
        return json(res, 200, { ok: true, found: found.length, killed });
      }

      case '/api/hotspot/open':
        // 打开 Windows 的「移动热点」设置页。只跳固定 URI，不接任何用户输入，无注入面；
        // 真正的开关仍由用户在系统设置里自己动手，工具不代改系统配置。
        openBrowser('ms-settings:network-mobilehotspot');
        return json(res, 200, { ok: true, target: 'ms-settings:network-mobilehotspot' });

      case '/api/vault':
        if (req.method === 'GET') return json(res, 200, { accounts: vaultPublic() });
        else {
          const b = await readBody(req);
          if (!b.username) return json(res, 400, { error: '缺少账号' });
          let acc = b.id ? accountById(b.id) : null;
          if (!acc) acc = vault.accounts.find(a => a.username === b.username && (a.suffix || '') === (b.suffix || '')) || null;
          if (!acc) {
            acc = { id: 'a' + crypto.randomBytes(6).toString('hex'), username: b.username, created: now() };
            vault.accounts.push(acc);
          }
          acc.username = b.username;
          acc.suffix = b.suffix || '';
          acc.remark = b.remark || '';
          if (typeof b.password === 'string' && b.password) {
            if (b.remember) acc.enc = dpapiProtect(b.password);
            else delete acc.enc;
          }
          saveVault();
          return json(res, 200, { ok: true, accounts: vaultPublic() });
        }
      case '/api/vault/delete': {
        const b = await readBody(req);
        const removed = vault.accounts.filter(a => a.id === b.id);
        vault.accounts = vault.accounts.filter(a => a.id !== b.id);
        saveVault(); // 密码密文(enc)随账号条目一并删除，磁盘上不再保留
        // 若删掉的是当前已登录后台的账号：远程注销 + 清本地会话
        for (const r of removed) {
          if (self.sessionUser === r.username || self.account === r.username) {
            try {
              if (self.loggedIn) await self.http.request('GET', `${CFG.self}/Self/login/logout`, { timeout: 8000 });
            } catch {}
            self.loggedIn = false;
            self.sessionUser = '';
            self.account = '';
            self.http = new Http();
            self.clearSessionFile();
            self.lastDevices = [];
          }
        }
        return json(res, 200, { ok: true, accounts: vaultPublic() });
      }
      case '/api/vault/clear-passwords': {
        for (const a of vault.accounts) delete a.enc;
        saveVault();
        return json(res, 200, { ok: true, accounts: vaultPublic() });
      }

      case '/api/connect': {
        if (job.running) return json(res, 409, { error: '已有任务在运行' });
        if (borrow.busy) return json(res, 409, { error: '正在借网查看（临时切到校园网取数），等它自动切回原网络后再抢网' });
        const b = await readBody(req);
        job.events = [];
        setImmediate(() => runConnect(b));
        return json(res, 200, { ok: true });
      }
      case '/api/connect/state':
        return json(res, 200, { running: job.running, events: job.events });
      case '/api/connect/decision': {
        const b = await readBody(req);
        const ok = resolveWaiter('decision', b.action);
        return json(res, 200, { ok });
      }
      case '/api/connect/captcha': {
        const b = await readBody(req);
        const ok = resolveWaiter('captcha', b.code);
        return json(res, 200, { ok });
      }
      case '/api/connect/cancel': {
        // 用户在验证码弹窗点「取消」：立刻唤醒等待中的任务，让它走「暂停」分支而不是干等超时
        const n = userWaiter.cancelAll();
        return json(res, 200, { ok: n > 0, cancelled: n });
      }
      case '/api/connect/stream': {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write('retry: 3000\n\n');
        for (const ev of job.events) res.write('data: ' + JSON.stringify(ev) + '\n\n');
        job.sse.add(res);
        const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 15000);
        req.on('close', () => { clearInterval(hb); job.sse.delete(res); });
        return;
      }

      case '/api/self/login': {
        const b = await readBody(req);
        let username = b.username, password = b.password || '';
        if (b.accountId) {
          const a = accountById(b.accountId);
          if (!a) return json(res, 404, { error: '账号不存在' });
          username = a.username;
          if (!password) { try { password = passwordOf(a) || ''; } catch (e) { return json(res, 500, { error: e.message }); } }
        }
        if (!username || !password) return json(res, 400, { error: '缺少账号或密码' });
        // C：抢网/借网期间别人正在用 self 登录（且可能在等验证码），此时登录会覆盖 checkcode。
        //    直接 409，让前端提示「稍后再试」，而不是制造一次静默失败。
        if (!selfLoginLease.acquire('api', 60000)) {
          const who = selfLoginLease.heldBy();
          return json(res, 409, {
            error: '自助登录正忙（' + (who === 'connect' ? '正在一键抢网' : who === 'borrow' ? '正在借网查看' : '另一处正在登录') + '），请稍候再点刷新',
            busy: true,
          });
        }
        try {
          const r = await self.ensureLogin(username, password, b.code);
          return json(res, 200, r);
        } finally { selfLoginLease.release('api'); }
      }
      case '/api/self/session': {
        if (!self.loggedIn && !self.restored) {
          try { await self.restoreSession(undefined); } catch {}
        }
        return json(res, 200, { loggedIn: self.loggedIn, account: self.account || '' });
      }
      case '/api/self/reachable': {
        // 取设备/用量的硬前提：自助后台本身可达。不可达时前端会问用户要不要借网。
        const p = await selfReachable(2000);
        const wi = wifiInfo();
        const ks = classifyNetwork(wi.ssid);
        return json(res, 200, {
          reachable: !!p.ok, ms: p.ms, host: p.host,
          ssid: wi.ssid || '', kind: ks.kind, campus: ks.campus,
          campusSsid: CAMPUS_SSID,
          hasCampusProfile: (wi.profiles || []).includes(CAMPUS_SSID),
          borrowBusy: borrow.busy,
        });
      }
      case '/api/self/borrow': {
        // 借网查看：临时切 HNIST-student 取数 → 注销后台 → 自动切回。
        // 立刻返回，真实进度走 SSE（log / captcha / borrow_done）；别在这里等——用户输验证码就要几十秒。
        if (borrow.busy) return json(res, 409, { error: '上一次借网查看还没结束，请稍候' });
        if (job.running) return json(res, 409, { error: '正在一键抢网，不能同时借网查看' });
        const b = await readBody(req);
        let username = b.username || '', password = b.password || '';
        if (b.accountId) {
          const a = accountById(b.accountId);
          if (!a) return json(res, 404, { error: '账号不存在' });
          username = a.username;
          if (!password) {
            try { password = passwordOf(a) || ''; } catch (e) { return json(res, 500, { error: '本机解密保存的密码失败：' + e.message }); }
          }
        }
        if (!username || !password) return json(res, 400, { error: '缺少账号或密码（借网查看要登录一次自助后台）' });
        borrow.busy = true; // 先占位，防连点
        json(res, 200, { ok: true, started: true, from: wifiInfo().ssid || '' });
        setImmediate(() => { borrowAndFetch(username, password); });
        return;
      }
      case '/api/self/logout': {
        if (!self.loggedIn) {
          try { await self.restoreSession(undefined); } catch {}
        }
        const hadSession = self.loggedIn;
        let netOk = false;
        try {
          await self.http.request('GET', `${CFG.self}/Self/login/logout`, { timeout: 10000 });
          netOk = true;
        } catch {}
        self.loggedIn = false;
        self.clearSessionFile();
        return json(res, 200, {
          ok: true, attempted: hadSession && netOk,
          note: !netOk
            ? '注销请求发送失败（校内后台不可达？）'
            : hadSession
              ? '已注销自助后台会话，现在可重新登录（只需验证码）'
              : '本地本就没有有效会话（若仍提示被占用，是别处的会话，请稍等其过期）',
        });
      }
      case '/api/self/devices': {
        if (!self.loggedIn) return json(res, 200, { needLogin: true });
        try { return json(res, 200, await buildDevicesPayload()); }
        catch (e) { return json(res, 500, { error: e.message }); }
      }
      case '/api/self/dashboard': {
        if (!self.loggedIn) return json(res, 200, { needLogin: true });
        const lines = summarizePage(await self.get('/Self/dashboard', true));
        return json(res, 200, { lines });
      }
      case '/api/self/usage': {
        if (!self.loggedIn) return json(res, 200, { needLogin: true });
        return json(res, 200, await buildUsagePayload());
      }
      case '/api/self/unbind': {
        const b = await readBody(req);
        const target = resolveUnbindTarget(self.lastDevices, b, self.account);
        if (!target.ok) return json(res, target.code, { error: target.error });
        try {
          const r = await self.unbind(target.dev);
          return json(res, 200, r);
        } catch (e) {
          return json(res, 500, { error: e.message, needManual: !!e.needManual });
        }
      }

      case '/api/wifi':
        return json(res, 200, wifiInfo());
      case '/api/wifi/connect': {
        const b = await readBody(req);
        if (!b.name) return json(res, 400, { error: '缺少配置名称' });
        return json(res, 200, wifiConnect(b.name));
      }
      case '/api/wifi/restore': {
        // 只有用户点「切回原网络」才切；不自动恢复，
        // 否则「名额被占用」这类需要在校园网内处理的暂停会被切到不可达的环境。
        if (!lastWifiSwitch || !lastWifiSwitch.from) {
          return json(res, 200, { ok: false, msg: '没有可切回的网络记录（本次抢网未切换过 WiFi）' });
        }
        const from = lastWifiSwitch.from;
        const r = wifiConnect(from);
        if (r.ok) lastWifiSwitch = null; // 用完即弃，避免重复切
        return json(res, 200, { ok: r.ok, from, msg: r.ok ? `已请求切回 “${from}”` : r.msg });
      }

      case '/api/diag':
        if (req.method === 'GET') return json(res, 200, { on: diagOn });
        else {
          const b = await readBody(req);
          diagOn = !!b.on;
          return json(res, 200, { on: diagOn });
        }
      case '/api/diag/list': {
        let files = [];
        try { files = fs.readdirSync(DIAG_DIR).sort().reverse().slice(0, 50); } catch {}
        return json(res, 200, { files });
      }
      case '/api/diag/clear': {
        let removed = 0;
        try {
          for (const f of fs.readdirSync(DIAG_DIR)) {
            try { fs.unlinkSync(path.join(DIAG_DIR, f)); removed++; } catch {}
          }
        } catch {}
        return json(res, 200, { ok: true, removed });
      }
      case '/api/diag/read': {
        const name = path.basename(query.get('name') || '');
        if (!name) return json(res, 400, { error: '缺少文件名' });
        try {
          const text = fs.readFileSync(path.join(DIAG_DIR, name), 'utf8');
          return json(res, 200, { name, text: text.slice(0, 200000) });
        } catch { return json(res, 404, { error: '文件不存在' }); }
      }
      default:
        return json(res, 404, { error: '未知接口 ' + pathname });
    }
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname.startsWith('/api/')) return void handleApi(req, res, u.pathname, u.searchParams);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, u.pathname);
});

function openBrowser(url) {
  try {
    spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {}
}

function startServer(port) {
  server.once('error', e => {
    if (e.code === 'EADDRINUSE') startServer(port + 1);
    else { console.error('启动失败:', e.message); process.exit(1); }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/?t=${TOKEN}`;
    writeFileAtomic(CONSOLE_URL_FILE, url, 'utf8');
    console.log('');
    console.log('  校园网抢抢抢已启动: ' + url);
    console.log('  控制台地址已写入 console.url；关闭控制台网页后本服务会自动退出。');
    console.log('');
    if (OPEN_BROWSER) openBrowser(url);
  });
}

/* 关闭控制台网页（或页面崩溃/浏览器被结束）→ 自动退出本地服务 */
let lastTickAt = Date.now();
setInterval(() => {
  const t = Date.now();
  const tickGap = t - lastTickAt;
  lastTickAt = t;
  // 本进程刚从休眠/整机冻结里恢复：5s 的巡检跳了一大截。这个心跳空档是
  // 机器睡出来的，不是页面失联——给页面一个心跳周期（10s）自证还活着，
  // 别抢在它恢复心跳之前自杀（否则每次合盖/休眠回来都要重启服务）。
  if (tickGap > 30000) {
    life.lastAliveAt = Math.max(life.lastAliveAt, t - HEARTBEAT_TIMEOUT_MS + 20000);
  }
  if (life.everAlive) {
    const away = t - life.lastAliveAt > HEARTBEAT_TIMEOUT_MS;
    const bye = life.goodbyeAt && (t - life.goodbyeAt) > GOODBYE_GRACE_MS && (t - life.lastAliveAt) > GOODBYE_GRACE_MS;
    if (away || bye) {
      writeFileAtomic(CONSOLE_URL_FILE, '', 'utf8');
      process.exit(0);
    }
  } else if (t - life.startedAt > NO_CLIENT_EXIT_MS) {
    process.exit(0);
  }
}, 5000);

process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));

/* 服务退出时必须把自己开的浏览器一起带走（心跳自杀、正常退出、Ctrl+C 都算）。
 * 否则窗口变孤儿，用户只能去任务管理器猜 PID——猜错就杀掉自己的浏览器。 */
function reapSpawnedBrowsers() {
  for (const pid of [...spawnedBrowserPids]) killTreeSync(pid);
  spawnedBrowserPids.clear();
}
process.on('exit', reapSpawnedBrowsers);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, () => { reapSpawnedBrowsers(); process.exit(0); }); } catch {}
}

loadVault();
loadIpNotes();
startServer(PORT_START);
