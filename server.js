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

const PORT_START = 8787;
const ROOT = __dirname;
const VAULT_FILE = path.join(ROOT, 'vault.json');
const SESSION_FILE = path.join(ROOT, '.selfsession');
const DIAG_DIR = path.join(ROOT, 'diag');
const CONSOLE_URL_FILE = path.join(ROOT, 'console.url');
const OPEN_BROWSER = !process.env.NO_OPEN;
const TOKEN = crypto.randomBytes(16).toString('hex');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CampusNetAssistant/1.0';

/* 控制台页面心跳：关闭网页后本地服务自动退出 */
const CLIENT_ALIVE_INTERVAL_MS = 10000;
const GOODBYE_GRACE_MS = 10000;     // pagehide 后仍允许刷新/短中断
const HEARTBEAT_TIMEOUT_MS = 45000; // 连续无心跳则退出
const NO_CLIENT_EXIT_MS = 180000;   // 启动后一直没人打开控制台则退出（浏览器可能没弹出）
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
  if (s.includes('�')) {
    try { const g = new TextDecoder('gbk').decode(buf); if (!g.includes('�')) s = g; } catch {}
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
  if (s.includes('�')) s = buf.toString('utf8');
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

function closeManualPortal() {
  if (manualWatchTimer) { clearInterval(manualWatchTimer); manualWatchTimer = null; }
  if (!manualPortal) return false;
  const p = manualPortal;
  manualPortal = null;
  try { if (p.pid) process.kill(p.pid); } catch {}
  try { if (p.profile) fs.rmSync(p.profile, { recursive: true, force: true }); } catch {}
  return true;
}

function closeCapBrowser(handle) {
  if (!handle) return;
  try { if (handle.pid) process.kill(handle.pid); } catch {}
  try { if (handle.profile) fs.rmSync(handle.profile, { recursive: true, force: true }); } catch {}
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

/* 最近一次「为抢网而切走的网络」，只供用户手动切回，绝不自动恢复 */
let lastWifiSwitch = null;

async function ensureCampusWifi(log, opts) {
  const say = m => { try { log && log(m); } catch {} };
  const allowSwitch = !!(opts && opts.allowSwitch);
  const CAMPUS = 'HNIST-student';
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

  const closeCaptiveBrowser = async () => {
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
  if (!pages || !pages.length) throw new Error('浏览器调试端口未就绪，无法自动填登录');

  let page = pages.find(p => p.type === 'page' && /hnist|msftconnecttest|generate_204|msn\.cn|firefox|about:blank/i.test(p.url || ''))
    || pages.find(p => p.type === 'page' && !/chrome-extension|devtools|chrome-error/i.test(p.url || ''))
    || pages.find(p => p.type === 'page');
  if (!page) throw new Error('未找到可控制的浏览器页面');

  const cdp = new CdpSession();
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
    cdp.close();
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
    return {
      ok: false,
      tip: tip || '登录失败（服务器无提示）：常见原因是该账号在别处仍有活跃的后台会话——请点设置里的“注销自助后台”再试，或等约半小时会话过期',
      needCaptcha: false,
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
    const e = new Error('未能从页面识别解绑操作，请开启诊断模式后重试一次，把 diag 报告交给我分析');
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
        out.rows = out.rows.concat(norm);
        if (norm.length) out.sources.push(`上网记录 userOnlineLog(${norm.length}条${pages > 1 ? `/${pages}页` : ''})`);
      }
    } catch (e) { out.logError = e.message; }

    return out;
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
function localInfo() {
  const macs = new Set(), ips = new Set();
  const skip = /vmware|veth|virtual|loopback|bluetooth|tap|hyper-?v|vEthernet|vmnet/i;
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (!ni.mac || ni.mac === '00:00:00:00:00:00') continue;
      // 虚拟网卡 MAC 不参与“是否本机”判定，避免误匹配 VMware
      if (skip.test(name + ' ' + ni.mac)) continue;
      macs.add(ni.mac.toLowerCase().replace(/-/g, ':'));
      if (ni.family === 'IPv4' && !String(ni.address || '').startsWith('169.254')) ips.add(ni.address);
    }
  }
  // 无论如何把真实 WLAN/有线 MAC 放进去
  const real = localMacHex();
  if (real) macs.add(real.toLowerCase().replace(/(.{2})(?=.)/g, '$1:'));
  return { macs, ips };
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

function wifiConnect(name) {
  const r = netsh(['wlan', 'connect', `name=${name}`]);
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  const ok = r.status === 0 && !/未找到|not find|找不到/i.test(out);
  return { ok, msg: ok ? `已请求连接 “${name}”` : out.slice(0, 200) || '连接失败' };
}

/* ---------------- 连接任务（SSE 日志流） ---------------- */
const self = new SelfClient();
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
  try { fs.writeFileSync(path.join(ROOT, 'job_last.log'), ''); } catch {}
  const state = { detect: 'pending', precheck: 'pending', unbind: 'pending', portal: 'pending', verify: 'pending' };
  emit('start', { state: { ...state } });
  const setStep = (k, status, note = '') => { state[k] = status; emit('step', { step: k, status, note, state: { ...state } }); };
  const finish = (ok, msg) => { emit(ok ? 'done' : 'paused', { msg }); };

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
    try { st = await portalStatus(); } catch (e) { emit('warn', { msg: '门户状态检测失败：' + e.message }); }
    try { nc = await ncsiCheck(); } catch {}
    // 测试网址登录后有数秒滞后：在线状态下多等几轮再决定（避免“已在线还去重登”撞 clientip online）
    if (st && st.online && !(nc && nc.ok)) {
      for (let i = 0; i < 5 && !(nc && nc.ok); i++) {
        await sleep(2000);
        try { nc = await ncsiCheck(); } catch {}
      }
    }
    if (st && st.online && nc && nc.ok) {
      setStep('detect', 'ok', '已在线 ' + st.uid);
      setStep('precheck', 'skip'); setStep('unbind', 'skip'); setStep('portal', 'skip');
      setStep('verify', 'ok', '测试网址通过');
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

    /* 2. 预检：自助服务查在线设备（会话冲突时弹窗确认注销后台） */
    setStep('precheck', 'running');
    let others = [];
    const askSelfLogout = async (reasonMsg) => {
      emit('decision', {
        kind: 'self_logout',
        hint: reasonMsg || '自助后台会话被占用（可能在别处登录）。是否注销自助后台会话后继续抢网？',
        detail: '同意后：注销后台登录占用 → 继续一键抢网。该操作不影响上网账号本身。',
        devices: [],
      });
      setStep('precheck', 'wait', '等待确认：是否注销自助后台');
      return await waitFor('decision', 180000);
    };
    const loginWithCaptchaLoop = async (roundNote) => {
      let lg = await self.ensureLogin(username, password, null);
      for (let i = 0; i < 4; i++) {
        if (lg.ok) return lg;
        if (lg.needCaptcha) {
          emit('captcha', { img: lg.captchaB64 });
          setStep('precheck', 'wait', roundNote + '：请输入验证码');
          const code = await waitFor('captcha', 180000);
          if (code === CANCELLED) throw cancelledError('已取消：等待验证码时用户点了取消，本次抢网已停止');
          if (!code) return { ok: false, tip: '验证码输入超时', needCaptcha: false };
          lg = await self.login(username, password, code);
          continue;
        }
        const conflict = /别处|会话|占用|无提示|失效|活跃|注销自助后台/i.test(String(lg.tip || ''));
        if (conflict) return lg;
        return lg;
      }
      return lg;
    };

    let lg = await self.ensureLogin(username, password, payload.captcha);
    if (!lg.ok && lg.needCaptcha) {
      emit('captcha', { img: lg.captchaB64 });
      setStep('precheck', 'wait', '需要输入验证码');
      const code = await waitFor('captcha', 180000);
      if (code === CANCELLED) throw cancelledError('已取消：等待验证码时用户点了取消，本次抢网已停止');
      if (!code) throw new Error('验证码输入超时');
      lg = await self.login(username, password, code);
    }
    // 会话冲突：先自动注销一次；仍失败/注销无效 → 弹窗问用户是否注销自助后台
    if (!lg.ok && /别处|会话|占用|无提示|失效|活跃|注销自助后台/i.test(String(lg.tip || ''))) {
      emit('log', { msg: '自助后台会话冲突：先尝试自动注销后台…' });
      await forceSelfSessionReset();
      lg = await loginWithCaptchaLoop('自动注销后重试');
      if (!lg.ok) {
        emit('log', { msg: '自动注销后仍无法预检：弹窗询问是否注销自助后台' });
        const act = await askSelfLogout(String(lg.tip || '') + '。是否注销自助后台会话后继续抢网？');
        if (act === 'continue') {
          emit('log', { msg: '用户同意：注销自助后台并继续抢网' });
          setStep('precheck', 'running', '注销自助后台中…');
          await forceSelfSessionReset();
          lg = await loginWithCaptchaLoop('用户确认注销后重试');
        } else {
          emit('log', { msg: '用户未确认注销后台：跳过预检，仍尝试门户 Captive 登录' });
          lg = { ok: false, tip: '用户未确认注销自助后台，已跳过预检' };
        }
      }
    }
    if (!lg.ok) {
      emit('warn', { msg: '自助服务登录失败，跳过预检直接尝试门户登录：' + (lg.tip || '未知原因') });
      setStep('precheck', 'warn', '预检跳过（可点设置「注销自助后台」后再试）');
      setStep('unbind', 'skip');
    } else {
      let dashLines = [], devList = [];
      try { dashLines = summarizePage(await self.get('/Self/dashboard', true)); }
      catch (e) { emit('warn', { msg: '读取仪表盘失败：' + e.message }); }
      try { devList = await self.loadMacList(); }
      catch (e) {
        emit('warn', { msg: 'getMacList 失败，回退页面解析：' + e.message });
        try { devList = parseDevices(await self.get('/Self/service/myMac', true)).devices; }
        catch (e2) { emit('warn', { msg: '读取绑定列表失败：' + e2.message }); }
      }
      let onlineSessions = [];
      try { onlineSessions = await self.getOnlineSessions(); } catch {}

      const local = localInfo();
      self.lastDevices = devList;
      // 占用判定以“真实在线会话(getOnlineList)”为准；绑定列表的在线标记会滞后，曾导致误弹
      const isSelfSess = s => (s.ip && local.ips.has(s.ip)) ||
        (s.mac && local.macs.has(String(s.mac).toLowerCase().replace(/[:-]/g, ':')));
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
        return {
          text: `在线中 · ${type} · ${s.ip}${s.loginTime ? ' · 上线 ' + s.loginTime : ''}`,
          ip: s.ip,
          mac: s.mac || (match ? match.mac : ''),
          type,
          online: true,
          action: match && match.action ? match.action : null,
        };
      });

      emit('devices', {
        devices: devList.map(d => ({
          text: d.text, ip: d.ip, mac: d.mac, type: d.type,
          online: typeof d.online === 'boolean' ? d.online : null, isSelf: isSelfDevice(d, local),
        })),
        endpoints: [],
        dashLines,
      });

      if (others.length) {
        setStep('precheck', 'ok', `有 ${others.length} 台其他设备在线（先直接登录，不影响就无需处理）`);
        emit('log', { msg: '其他在线设备：' + others.map(d => d.text).join('；') });
      } else {
        setStep('precheck', 'ok', '无其他设备在线');
      }
    }

    /* 3. 门户登录——主路径 = captive 浏览器自动填密；裸接口仅作兑底 */
    setStep('unbind', 'skip', others.length ? '登录受阻才会解绑' : '无需解绑');

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
      return { acted, failed };
    };

    const askUnbind = async (reasonMsg) => {
      setStep('portal', 'wait', '疑似被其他设备占用');
      emit('decision', {
        kind: 'unbind',
        hint: `登录被拒（${reasonMsg}）——账号 PC 名额可能已被占用，确认后解绑再登`,
        detail: others.length
          ? '同意后：解绑下列设备 → 重新 Captive 登录。'
          : '未能自动列出占用设备。若确认没有其他电脑在用本账号，可先点「注销自助后台」再试；同意后仍会尝试继续抢网。',
        devices: others.map(d => ({ text: d.text, ip: d.ip, mac: d.mac, type: d.type })),
      });
      const act = await waitFor('decision', 300000);
      if (act !== 'continue') {
        setStep('portal', 'pause'); setStep('unbind', 'skip'); setStep('verify', 'skip');
        finish(false, '已暂停：请先处理占用设备或注销自助后台，之后再点“一键抢网”继续。');
        return 'paused';
      }
      if (!others.length) {
        setStep('unbind', 'warn', '未能从绑定设备/在线列表解析到占用设备，请在右侧「绑定设备」手动解绑后再试');
        throw new Error('登录失败：' + reasonMsg + '（右侧「绑定设备」里可能仍有其他电脑；请手动解绑或注销自助后台后再一键）');
      }
      await unbindOthers();
      return null;
    };

    // 若预检已看到其他 PC，先确认再解绑（更稳，避免 captive 一上来就撞名额）
    if (others.length) {
      setStep('portal', 'wait', '有其他 PC 在线，先确认解绑');
      emit('log', { msg: '检测到其他 PC 占用名额：' + others.map(d => d.text).join('；') });
      const paused = await askUnbind('预检发现其他设备在线（PC 名额可能已满）');
      if (paused === 'paused') return;
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
      // 失败页/占用拒绝：用右侧「绑定设备」getMacList 组装解绑候选（与控制台刷新一致）
      if (!others.length) {
        emit('log', { msg: '登录被拒/信息页：按「绑定设备」列表加载解绑候选…' });
        try {
          if (!self.loggedIn) await forceSelfSessionReset();
          let lg2 = await self.ensureLogin(username, password, null);
          if (lg2.needCaptcha) {
            emit('captcha', { img: lg2.captchaB64 });
            setStep('precheck', 'wait', '加载设备需验证码');
            const code2 = await waitFor('captcha', 180000);
            if (code2 === CANCELLED) throw cancelledError('已取消：等待验证码时用户点了取消，本次抢网已停止');
            if (code2) lg2 = await self.login(username, password, code2);
          }
          if (!lg2.ok) {
            emit('log', { msg: '后台仍无法登录：弹窗确认是否注销自助后台后再继续' });
            const actS = await askSelfLogout(String(lg2.tip || '后台会话冲突') + '。是否注销自助后台后继续尝试解绑/抢网？');
            if (actS === 'continue') {
              await forceSelfSessionReset();
              let lg3 = await self.ensureLogin(username, password, null);
              if (lg3.needCaptcha) {
                emit('captcha', { img: lg3.captchaB64 });
                setStep('precheck', 'wait', '注销后加载设备需验证码');
                const code3 = await waitFor('captcha', 180000);
                if (code3 === CANCELLED) throw cancelledError('已取消：等待验证码时用户点了取消，本次抢网已停止');
                if (code3) lg3 = await self.login(username, password, code3);
              }
              lg2 = lg3;
            }
          }
          if (lg2.ok) {
            const cands = await self.loadUnbindCandidates();
            others = cands;
            const devList = self.lastDevices || [];
            emit('devices', {
              devices: devList.map(d => ({
                text: d.text, ip: d.ip, mac: d.mac, type: d.type,
                online: d.online, isSelf: isSelfDevice(d, localInfo()), hasAction: !!d.action,
              })),
              endpoints: [],
              dashLines: [],
            });
            if (others.length) {
              emit('log', { msg: '解绑候选（来自绑定设备/在线会话）：' + others.map(o => o.text).join('；') });
            } else {
              emit('warn', { msg: '绑定设备列表为空或均为本机，请在右侧「绑定设备」手动解绑后再一键' });
            }
          } else {
            // 后台仍登不上：若本机已有 lastDevices（用户刷新过右侧），直接用
            if (self.lastDevices && self.lastDevices.length) {
              others = buildUnbindCandidates(self.lastDevices, [], self.ajaxCsrf || '');
              emit('log', { msg: '使用已缓存的绑定设备列表：' + others.map(o => o.text).join('；') });
            }
          }
        } catch (e) {
          emit('warn', { msg: '重载设备列表失败：' + e.message });
          if (self.lastDevices && self.lastDevices.length) {
            others = buildUnbindCandidates(self.lastDevices, [], self.ajaxCsrf || '');
          }
        }
      }
      const paused = await askUnbind(pr.msg);
      if (paused === 'paused') return;
      setStep('portal', 'running', 'Captive 重试登录…');
      try { pr = await captiveAutoLogin(username, suffix, password, capLog); }
      catch (e) {
        const url = openCaptivePortal();
        setStep('portal', 'fail', e.message);
        return finish(false, '自动登录失败：' + e.message + '（已打开门户登录页）');
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
        const r = await self.ensureLogin(username, password, b.code);
        return json(res, 200, r);
      }
      case '/api/self/session': {
        if (!self.loggedIn && !self.restored) {
          try { await self.restoreSession(undefined); } catch {}
        }
        return json(res, 200, { loggedIn: self.loggedIn, account: self.account || '' });
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
        const local = localInfo();
        let devices = [], via = 'macList';
        try { devices = await self.loadMacList(); }
        catch (e) {
          via = 'html-fallback';
          try { devices = parseDevices(await self.get('/Self/service/myMac', true)).devices; }
          catch (e2) { return json(res, 500, { error: e2.message }); }
        }
        self.lastDevices = devices;
        let onlineSessions = [];
        try { onlineSessions = await self.getOnlineSessions(); } catch {}
        return json(res, 200, {
          devices: devices.map(d => ({
            text: d.text, ip: d.ip, mac: d.mac, type: d.type, online: typeof d.online === 'boolean' ? d.online : null,
            isSelf: isSelfDevice(d, local), hasAction: !!d.action,
          })),
          endpoints: [],
          via,
          onlineSessions,
        });
      }
      case '/api/self/dashboard': {
        if (!self.loggedIn) return json(res, 200, { needLogin: true });
        const lines = summarizePage(await self.get('/Self/dashboard', true));
        return json(res, 200, { lines });
      }
      case '/api/self/usage': {
        if (!self.loggedIn) return json(res, 200, { needLogin: true });
        const rep = await self.fetchUsageReport();
        // 设备类型映射来自 getMacList（按最近登录 IP 尽力匹配）
        const typeByIp = {};
        try {
          for (const d of await self.loadMacList()) {
            if (d.ip && d.type && d.type !== '未知') typeByIp[d.ip] = d.type;
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
          .map(a => ({ ...a, isSelf: local.ips.has(a.ip) }))
          .sort((x, y) => (y.lastUsedMs - x.lastUsedMs) || (y.totalKb - x.totalKb));
        const err = rep.histError || rep.logError || '';
        return json(res, 200, {
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
        });
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
setInterval(() => {
  const t = Date.now();
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
loadVault();
startServer(PORT_START);
