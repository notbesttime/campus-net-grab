'use strict';
/* 校园网抢抢抢 · 控制台逻辑
   完整模式：请求交给本地服务 server.js
   轻量模式：直接 file:// 打开时，仅门户功能走 JSONP，后台解绑需手动 */

const $ = id => document.getElementById(id);

const state = {
  mode: null,            // 'server' | 'lite'
  token: '',
  config: { portal: 'https://auth.hnist.edu.cn', self: 'http://172.31.8.43:8080/Self/', ncsi: '' },
  accounts: [],
  running: false,
  es: null,
  masked: false,         // 账号信息隐藏（截图防护）
  litePw: {},            // 轻量模式：仅本次运行内保留的密码
  statusKey: '',         // 门户状态快照：''|offline|walled|online-ok（用于事件触发面板刷新）
  panelsAt: 0,           // 右侧面板上次自动拉取时间戳（防抖）
  panelsBusy: false,     // 防并发重复拉取
  statusHideTimer: null, // 离开控制台后的 20s 计时器（只计一次，不跨次累计）
  statusPendingRefresh: false, // 离开满 20s：切回时立刻刷一次状态
  _lifeOn: false,        // 控制台心跳是否已启动
  termOpen: false,
  termSeq: 0,
  termTimer: null,
  wifiSsid: '',          // 最近一次 status 返回的当前 SSID
  restoreFrom: '',       // 可切回的原网络（只由用户点击触发切换）
  lastPauseMsg: '',      // 最近一次暂停条文案（用于补挂切回按钮）
  ipNotes: {},           // IP 备注（服务端 ip-notes.json，键为纯 IPv4）
  usageOpen: true,       // 用量卡展开状态（localStorage 记忆）
  lastUsage: null,       // 最近一次用量结果（改备注后原地重渲染）
  lastDevices: null,     // 最近一次设备列表（同上）
  lastEndpoints: null,
  netcheckOn: false,     // 网络检测总开关（localStorage 记忆，默认关）
  netBusy: false,        // 正在跑一次检测
  netTimer: null,        // 自动重测定时器
  netRetryTimer: null,   // 撞上重型请求时的延后重试
  netRetryCount: 0,      // 本轮已延后次数（防止无限推迟）
  heavyBusy: 0,          // 自助后台重型请求在途计数（见 api()）
  netHistory: [],        // 会话内检测历史（每 60s 一个点，仅内存，刷新即清零）
};

const STATUS_INTERVAL_MS = 60000;      // 前台自动探测门户状态
const HIDE_REFRESH_DELAY_MS = 20000;   // 连续离开多久后，切回视为需要立即刷新

function clearStatusHideTimer() {
  if (state.statusHideTimer) {
    clearTimeout(state.statusHideTimer);
    state.statusHideTimer = null;
  }
}

/**
 * 切回/离开控制台：
 * - 连续离开 <20s：回来不强刷（前台 60s 定时会管）
 * - 连续离开 ≥20s：到点停表并标记，切回立刻刷一次
 * - 再次离开：清掉标记并重新起 20s 计时（不累计多次短切）
 */
function onVisibilityChange() {
  if (document.hidden) {
    state.statusPendingRefresh = false;
    clearStatusHideTimer();
    state.statusHideTimer = setTimeout(() => {
      state.statusHideTimer = null;
      if (document.hidden) state.statusPendingRefresh = true;
    }, HIDE_REFRESH_DELAY_MS);
  } else {
    clearStatusHideTimer();
    if (state.statusPendingRefresh) {
      state.statusPendingRefresh = false;
      if (!state.running) refreshStatus(true);
    }
    // 离开期间定时器空转（runNetcheck 会跳过隐藏页），切回来补一次新的
    if (state.netcheckOn) runNetcheck();
  }
}

/* ---------------- 通用小工具 ---------------- */
function toast(msg, kind) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast ' + (kind || '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

function log(msg, cls) {
  const box = $('log');
  const line = document.createElement('div');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = new Date().toTimeString().slice(0, 8) + ' ';
  line.appendChild(t);
  const s = document.createElement('span');
  if (cls) s.className = cls;
  s.textContent = msg;
  line.appendChild(s);
  box.appendChild(line);
  while (box.children.length > 300) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function classifyStatus(portal, ncsi) {
  if (!portal || portal.error || !portal.online) return 'offline';
  const ncsiOk = !ncsi || ncsi.ok === true;
  const flow = Number(portal.flowKB) || 0;
  if (ncsiOk || flow >= 1) return 'online-ok';
  return 'walled';
}

/** 校园网 SSID（自助后台可达）；纯 HNIST 热点不算 */
function isCampusSsid(name) {
  const s = String(name || '').trim();
  if (!s) return false;
  if (/HNIST-student/i.test(s)) return true;
  if (/student|校园|campus/i.test(s)) return true;
  return false;
}

/**
 * 门户状态变好时的面板刷新时机：
 * 只静默刷「绑定设备」（绑定可能刚变化、请求较轻）；
 * 「IP 用量」历史变化慢，留给抢网结束 / 手动加载，避免每次状态跳变都翻账单页。
 */
function maybeRefreshPanelsAfterStatus(key) {
  const prev = state.statusKey;
  if (!prev || prev === key) return;
  if (key === 'online-ok' || (prev === 'offline' && key !== 'offline')) {
    setTimeout(() => refreshSelfPanels(true, { which: 'devices' }), 600);
  }
}

function fmtDur(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function fmtFlow(kb) {
  kb = Number(kb) || 0;
  if (kb < 1024) return kb + ' KB';
  return (kb / 1024).toFixed(1) + ' MB';
}

/* ---------------- 终端日志面板（本地服务 console 输出镜像） ---------------- */
function fmtTermTime(ms) {
  const d = new Date(ms || Date.now());
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function appendTermLines(lines, reset) {
  const box = $('termLogBody');
  if (!box) return;
  if (reset) box.innerHTML = '';
  for (const line of (lines || [])) {
    const row = document.createElement('div');
    row.className = line.level === 'err' ? 'err' : 'log';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = fmtTermTime(line.t) + ' ';
    const m = document.createElement('span');
    m.textContent = line.msg;
    row.appendChild(t);
    row.appendChild(m);
    box.appendChild(row);
  }
  while (box.children.length > 400) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

async function pollTermLog(reset) {
  if (!state.termOpen || state.mode !== 'server') return;
  try {
    const q = reset || !state.termSeq ? '' : ('?since=' + state.termSeq);
    const r = await api('/api/termlog' + q);
    if (!state.termOpen) return;
    if (reset || !state.termSeq) {
      appendTermLines(r.lines || [], true);
    } else if (r.lines && r.lines.length) {
      appendTermLines(r.lines, false);
    }
    if (r.lastSeq) state.termSeq = r.lastSeq;
  } catch (e) {
    if (!reset && !state.termSeq) {
      const box = $('termLogBody');
      if (box && !box.dataset.err) {
        box.dataset.err = '1';
        box.textContent = '终端日志获取失败：' + e.message;
      }
    }
  }
}

function setTermLogOpen(open) {
  const panel = $('termLogPanel');
  const btn = $('btnTermLog');
  state.termOpen = !!open;
  if (panel) panel.classList.toggle('hidden', !state.termOpen);
  if (btn) btn.classList.toggle('active', state.termOpen);
  if (state.termTimer) { clearInterval(state.termTimer); state.termTimer = null; }
  if (state.termOpen) {
    state.termSeq = 0;
    pollTermLog(true);
    state.termTimer = setInterval(() => { pollTermLog(false); }, 2000);
  }
}

function bindTermLogUI() {
  const btn = $('btnTermLog');
  if (btn) btn.onclick = () => setTermLogOpen(!state.termOpen);
  const close = $('btnTermLogClose');
  if (close) close.onclick = () => setTermLogOpen(false);
  const clear = $('btnTermLogClear');
  if (clear) clear.onclick = () => {
    const box = $('termLogBody');
    if (box) { box.innerHTML = ''; delete box.dataset.err; }
    state.termSeq = 0;
    pollTermLog(true);
  };
}

async function api(path, body, method) {
  // 自助后台的请求（会话/登录/设备/用量/解绑）都是「重型」的：网络检测必须避开它们，
  // 否则自家请求会把延迟与抖动一起顶上去。实测同一台机器同一时刻：
  // 与用量查询并发时国内延迟 158ms、抖动 337ms；错开后 37ms、8ms。
  const heavy = String(path).startsWith('/api/self/');
  if (heavy) state.heavyBusy++;
  try {
    const opt = {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'x-token': state.token || '' },
    };
    if (body) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const r = await fetch(path, opt);
    let data = null;
    try { data = await r.json(); } catch {}
    if (!r.ok) {
      const e = new Error((data && data.error) || 'HTTP ' + r.status);
      e.status = r.status;
      e.data = data;
      throw e;
    }
    return data;
  } finally {
    if (heavy) {
      state.heavyBusy--;
      if (state.heavyBusy === 0) netcheckAfterHeavy();
    }
  }
}

function jsonp(url) {
  return new Promise((resolve, reject) => {
    const cb = 'dr_cb_' + Math.random().toString(36).slice(2);
    const script = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new Error('门户请求超时')); }, 12000);
    function cleanup() {
      clearTimeout(timer);
      delete window[cb];
      script.remove();
    }
    window[cb] = data => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error('门户请求失败')); };
    script.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
    document.head.appendChild(script);
  });
}

async function portalLite(apiPath, params) {
  const q = new URLSearchParams({
    jsVersion: '4.X',
    v: String(Math.floor(Math.random() * 10000 + 500)),
    lang: 'zh',
    ...(params || {}),
  });
  return jsonp(`${state.config.portal}/drcom/${apiPath}?${q}`);
}

/* ---------------- 状态渲染 ---------------- */
function renderStatus(portal, ncsi) {
  const on = portal && portal.online;
  const badge = $('netBadge');
  badge.textContent = on ? '在线' : '离线';
  badge.className = 'badge net ' + (on ? 'online' : 'offline');

  const elOn = $('stOnline');
  elOn.textContent = on ? '在线' : '离线';
  elOn.className = 'v ' + (on ? 'on' : 'off');
  $('stUid').textContent = (portal && portal.uid) || '—';
  $('stIp').textContent = (portal && portal.ip) || '—';
  $('stTime').textContent = on ? fmtDur(portal.onlineSeconds) : '—';
  $('stFlow').textContent = on ? fmtFlow(portal.flowKB) : '—';
  const n = $('stNcsi');
  if (!ncsi) { n.textContent = state.mode === 'lite' ? '—' : '—'; n.className = 'v'; }
  else if (ncsi.ok) { n.textContent = '通过'; n.className = 'v on'; }
  else { n.textContent = '未通过'; n.className = 'v off'; }
  $('stRefresh').textContent = '上次刷新 ' + new Date().toTimeString().slice(0, 8);
}

async function refreshStatus(silent) {
  try {
    if (state.mode === 'server') {
      const s = await api('/api/status');
      renderStatus(s.portal && !s.portal.error ? s.portal : { online: false }, s.ncsi);
      if (s.portal && s.portal.error) log('状态检测：' + s.portal.error, 'warn');
      applyWifi(s.wifi);
      $('ckDiag').checked = !!s.diag;
      state.running = !!s.running;
      syncConnectBtn();
      $('globalBanner').classList.add('hidden');
      const key = classifyStatus(s.portal, s.ncsi);
      maybeRefreshPanelsAfterStatus(key);
      state.statusKey = key;
      if (!silent && s.portal && s.portal.uid) log(`状态已刷新：${s.portal.online ? '在线' : '离线'} ${s.portal.uid || ''}`);
    } else {
      const st = await portalLite('chkstatus');
      const online = String(st.result) === '1';
      renderStatus({
        online, uid: st.uid || '', ip: st.v4ip || '',
        onlineSeconds: st.time, flowKB: st.flow,
      }, null);
      if (!silent) log('状态已刷新：' + (online ? '在线 ' + (st.uid || '') : '离线'));
    }
  } catch (e) {
    if (e.status === 403) {
      const b = $('globalBanner');
      b.textContent = '本地服务已重启，令牌失效：请关闭本页面，重新双击“启动校园网助手.bat”打开。';
      b.className = 'banner warn';
      b.classList.remove('hidden');
    } else if (state.mode === 'server') {
      const b = $('globalBanner');
      b.textContent = '本地服务未连接：请确认启动脚本的黑色窗口还开着；若已关闭，重新双击“启动校园网助手.bat”。';
      b.className = 'banner warn';
      b.classList.remove('hidden');
      if (!silent) log('状态检测失败：' + e.message, 'err');
    } else if (!silent) {
      log('状态检测失败：' + e.message, 'err');
    }
  }
}

function applyWifi(w) {
  if (!w) return;
  state.wifiSsid = w.ssid || '';
  const sel = $('wifiProfiles');
  const cur = sel.value;
  sel.innerHTML = '';
  for (const p of (w.profiles || [])) {
    const o = document.createElement('option');
    o.value = p;
    o.textContent = p;
    sel.appendChild(o);
  }
  // 一键抢网默认优先校园网
  if ((w.profiles || []).includes('HNIST-student')) sel.value = 'HNIST-student';
  else if (w.ssid && (w.profiles || []).includes(w.ssid)) sel.value = w.ssid;
  else if (cur && (w.profiles || []).includes(cur)) sel.value = cur;
  else if ((w.profiles || []).includes('HNIST')) sel.value = 'HNIST';
  $('wifiHint').textContent = w.ssid ? `当前已连接：${w.ssid}` : (w.error ? w.error : '当前未连接已保存的 WiFi（有线网络不受影响）');
  state.restoreFrom = w.restoreFrom || '';
  const rb = $('btnWifiRestore');
  if (rb) {
    // 「切回原网络」只在本次抢网确实切走过 WiFi 时才显示，且必须用户自己点
    rb.classList.toggle('hidden', !w.canRestore);
    rb.title = w.canRestore ? ('切回抢网前所在的网络：' + w.restoreFrom) : '';
  }
  // 暂停条已经开着时，把刚拿到的切回按钮补上去（用户正看着那里）
  if (w.canRestore && state.lastPauseMsg && !$('pauseBanner').classList.contains('hidden')) {
    showPause(state.lastPauseMsg);
  }
}

/* ---------------- 步骤流水线 ---------------- */
function resetPipeline() {
  for (const el of document.querySelectorAll('#pipeline .step')) {
    el.className = 'step';
    el.querySelector('.snote').textContent = '';
  }
}

function setStep(name, status, note) {
  const el = document.querySelector(`#pipeline .step[data-step="${name}"]`);
  if (!el) return;
  el.className = 'step is-' + status;
  if (note) el.querySelector('.snote').textContent = note;
}

function showPause(msg) {
  const b = $('pauseBanner');
  state.lastPauseMsg = msg;
  b.textContent = msg;
  b.classList.remove('hidden');
  // 数据未打通时，在暂停条上直接给出「打开门户登录页」
  if (/数据未打通|围墙|门户登录页|绑定本机/.test(String(msg || ''))) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn primary';
    btn.textContent = '打开门户登录页';
    btn.style.marginLeft = '8px';
    btn.onclick = () => $('btnOpenPortal').click();
    b.appendChild(btn);
  }
  // 本次抢网切走过 WiFi 时，把「切回原网络」放在用户正看着的地方
  if (state.restoreFrom) {
    const rb = document.createElement('button');
    rb.type = 'button';
    rb.className = 'btn ghost';
    rb.textContent = '切回 ' + state.restoreFrom;
    rb.style.marginLeft = '8px';
    rb.onclick = () => $('btnWifiRestore').click();
    b.appendChild(rb);
  }
}
function hidePause() { $('pauseBanner').classList.add('hidden'); }

function syncConnectBtn() {
  $('btnConnect').disabled = state.running;
  $('btnConnect').textContent = state.running ? '抢网中…' : '一键抢网';
}

/* ---------------- 弹窗 ---------------- */
function askPassword(title, allowRemember) {
  return new Promise(resolve => {
    $('pwTitle').textContent = title || '输入密码';
    $('pwInput').value = '';
    $('pwRemember').checked = allowRemember !== false;
    $('pwRemember').parentNode.style.display = allowRemember === false ? 'none' : '';
    $('modalPassword').classList.remove('hidden');
    $('pwInput').focus();
    state.pwResolve = resolve;
  });
}
function closePassword(val) {
  $('modalPassword').classList.add('hidden');
  if (state.pwResolve) { state.pwResolve(val); state.pwResolve = null; }
}

function askCaptcha(img) {
  return new Promise(resolve => {
    $('capImg').src = img || '';
    $('capInput').value = '';
    $('modalCaptcha').classList.remove('hidden');
    $('capInput').focus();
    state.capResolve = resolve;
  });
}
function closeCaptcha(val) {
  $('modalCaptcha').classList.add('hidden');
  if (state.capResolve) { state.capResolve(val); state.capResolve = null; }
}

function showDecision(ev) {
  const box = $('decList');
  box.innerHTML = '';
  const kind = ev.kind || 'unbind';
  if (kind === 'self_logout') {
    $('decTitle').textContent = ev.hint || '自助后台会话被占用，是否注销后继续抢网？';
    const tip = document.createElement('div');
    tip.className = 'dim';
    tip.style.marginBottom = '8px';
    tip.textContent = ev.detail || '同意后将注销自助后台登录占用，并继续一键抢网。';
    box.appendChild(tip);
  } else {
    $('decTitle').textContent = ev.hint || '该账号当前有其他设备在使用';
    if (ev.detail) {
      const tip = document.createElement('div');
      tip.className = 'dim';
      tip.style.marginBottom = '8px';
      tip.textContent = ev.detail;
      box.appendChild(tip);
    }
    for (const d of (ev.devices || [])) {
      const row = document.createElement('div');
      row.className = 'dec-item';
      const a = document.createElement('div');
      a.textContent = d.text || d.ip || d.mac || '未知设备';
      const b = document.createElement('div');
      b.className = 'dim';
      b.textContent = `类型：${d.type || '未知'}${d.ip ? ' · IP：' + d.ip : ''}${d.mac ? ' · MAC：' + d.mac : ''}`;
      row.appendChild(a);
      row.appendChild(b);
      box.appendChild(row);
    }
  }
  const btnC = $('btnDecContinue');
  const btnP = $('btnDecPause');
  if (kind === 'self_logout') {
    btnC.textContent = '同意注销并继续';
    btnP.textContent = '暂不注销';
  } else {
    btnC.textContent = '解绑并继续';
    btnP.textContent = '暂不解绑';
  }
  $('modalDecision').classList.remove('hidden');
}

/* ---------------- 账号簿 ---------------- */
function loadLiteAccounts() {
  try { return JSON.parse(localStorage.getItem('cnal_accounts') || '[]'); } catch { return []; }
}
function saveLiteAccounts(list) { localStorage.setItem('cnal_accounts', JSON.stringify(list)); }

async function refreshAccounts() {
  try {
    if (state.mode === 'server') {
      const r = await api('/api/vault');
      state.accounts = r.accounts || [];
    } else {
      state.accounts = loadLiteAccounts();
    }
  } catch (e) {
    log('读取账号簿失败：' + e.message, 'err');
  }
  renderAccounts();
}

function renderAccounts() {
  const list = $('acctList');
  list.innerHTML = '';
  $('acctEmpty').classList.toggle('hidden', state.accounts.length > 0);

  const sel = $('accountSelect');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const a of state.accounts) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = `${a.remark ? a.remark + ' · ' : ''}${a.username}${a.suffix || ''}${a.hasPassword ? '（已存密码）' : ''}`;
    sel.appendChild(opt);
  }
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;

  for (const a of state.accounts) {
    const li = document.createElement('li');
    li.className = 'acct-item';

    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = a.username;
    if (a.suffix) {
      const s = document.createElement('span');
      s.className = 'suffix';
      s.textContent = a.suffix;
      name.appendChild(s);
    }
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = a.remark || (a.lastUsed ? '上次使用 ' + new Date(a.lastUsed).toLocaleString() : '未备注');
    info.appendChild(name);
    info.appendChild(meta);

    const pw = document.createElement('span');
    pw.className = 'pwstate' + (a.hasPassword ? ' has' : '');
    pw.textContent = a.hasPassword ? '已存密码' : '未存密码';

    const edit = document.createElement('button');
    edit.className = 'btn ghost mini';
    edit.type = 'button';
    edit.textContent = '编辑';
    edit.onclick = () => fillAcctForm(a);

    const del = document.createElement('button');
    del.className = 'btn ghost mini danger';
    del.type = 'button';
    del.textContent = '删除';
    del.onclick = async () => {
      if (!confirm(`删除账号 ${a.username}${a.suffix || ''}？\n本机保存的该账号密码会一并删除，下次使用需重新输入并保存。`)) return;
      const wasSelected = $('accountSelect').value === a.id;
      if (state.mode === 'server') await api('/api/vault/delete', { id: a.id });
      else {
        saveLiteAccounts(loadLiteAccounts().filter(x => x.id !== a.id));
        delete state.litePw[a.id];
      }
      await refreshAccounts();
      toast('已删除（含本机保存的密码）', 'ok');
      if (wasSelected) {
        $('devBody').innerHTML = '<tr><td colspan="4" class="hintcell">账号已删除：请选择账号后点“刷新”。</td></tr>';
        $('usageGrid').innerHTML = '';
        $('usageHint').textContent = '账号已删除。重新添加并登录后，可查看该账号的各 IP 用量。';
        $('devHint').textContent = '';
        autoLoadForAccount();
      }
    };

    li.appendChild(info);
    li.appendChild(pw);
    li.appendChild(edit);
    li.appendChild(del);
    list.appendChild(li);
  }
}

function setAcctFormOpen(open) {
  $('acctForm').classList.toggle('hidden', !open);
  // 表单打开期间禁用“添加账号”，避免误触后以为是保存
  $('btnAddAcct').disabled = open;
}

function fillAcctForm(a) {
  setAcctFormOpen(true);
  $('fId').value = a ? a.id : '';
  $('fUsername').value = a ? a.username : '';
  $('fSuffix').value = a ? (a.suffix || '') : '';
  $('fRemark').value = a ? (a.remark || '') : '';
  $('fPassword').value = '';
  $('fPassword').placeholder = a && a.hasPassword ? '留空 = 不修改' : '输入密码';
  if (!a) $('fUsername').focus();
}

async function saveAcctForm(ev) {
  ev.preventDefault();
  const username = $('fUsername').value.trim();
  if (!username) return toast('请填写账号', 'err');
  const payload = {
    id: $('fId').value || undefined,
    username,
    suffix: $('fSuffix').value.trim(),
    remark: $('fRemark').value.trim(),
    password: $('fPassword').value,
    remember: $('fRemember').checked,
  };
  try {
    if (state.mode === 'server') {
      await api('/api/vault', payload);
    } else {
      const list = loadLiteAccounts();
      let acc = payload.id ? list.find(x => x.id === payload.id) : null;
      if (!acc) {
        acc = { id: 'a' + Math.random().toString(36).slice(2, 10), username, hasPassword: false };
        list.push(acc);
      }
      acc.username = username;
      acc.suffix = payload.suffix;
      acc.remark = payload.remark;
      saveLiteAccounts(list);
      if (payload.password) toast('轻量模式不保存密码，仅本次运行可用', '');
    }
    setAcctFormOpen(false);
    await refreshAccounts();
    toast('已保存', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ---------------- 设备面板 ---------------- */
function renderDevices(devices, endpoints) {
  const body = $('devBody');
  body.innerHTML = '';
  state.lastDevices = devices || [];
  state.lastEndpoints = endpoints || [];
  if (!devices || !devices.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'hintcell';
    td.textContent = state.mode === 'server'
      ? '未识别到设备（可能为 JS 动态加载，或该账号确实无绑定）。页面已自动存入 diag/，请把该文件夹交给开发者分析。'
      : '未发现绑定设备（或页面结构未识别）。';
    tr.appendChild(td);
    body.appendChild(tr);
  }
  let unactionable = 0;
  devices.forEach((d, idx) => {
    const tr = document.createElement('tr');

    const td1 = document.createElement('td');
    if (d.online === true || d.online === false) {
      const st = document.createElement('span');
      st.className = 'tag ' + (d.online ? 'on' : 'off');
      st.textContent = d.online ? '在线' : '离线';
      st.style.marginRight = '4px';
      td1.appendChild(st);
    }
    const tag = document.createElement('span');
    tag.className = 'tag ' + (d.type === 'PC' ? 'pc' : d.type === '手机' ? 'phone' : '');
    tag.textContent = d.type || '未知';
    td1.appendChild(tag);
    if (d.isSelf) {
      const t2 = document.createElement('span');
      t2.className = 'tag self';
      t2.textContent = '本机';
      t2.style.marginLeft = '4px';
      td1.appendChild(t2);
    }

    const td2 = document.createElement('td');
    const dv = document.createElement('div');
    dv.className = 'devtext';
    dv.textContent = d.text || '—';
    dv.title = d.text || '';
    td2.appendChild(dv);

    const td3 = document.createElement('td');
    td3.className = 'mono';
    td3.textContent = d.ip || '—';
    // 该 IP 有备注时，在设备表里同步显示（方便认出是哪台设备）
    const noteEl = ipNoteEl(d.ip);
    if (noteEl && state.ipNotes[d.ip]) td3.appendChild(noteEl);

    const td4 = document.createElement('td');
    if (d.isSelf) {
      td4.innerHTML = '';
      td4.textContent = '—';
    } else if (d.hasAction) {
      const b = document.createElement('button');
      b.className = 'btn ghost mini';
      b.type = 'button';
      b.textContent = '解绑';
      b.onclick = () => unbindAt(d, idx);
      td4.appendChild(b);
    } else {
      unactionable++;
      td4.textContent = '—';
    }

    tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3); tr.appendChild(td4);
    body.appendChild(tr);
  });

  const hint = $('devHint');
  const notes = [];
  if (state.mode === 'lite') notes.push('轻量模式无法自动读取后台，请点“打开后台”手动操作。');
  else if (unactionable && devices.length) notes.push('部分设备未能识别解绑操作，可在右上角齿轮「设置」里开启诊断模式后刷新，把 diag 报告交给我分析。');
  if (endpoints && endpoints.length) notes.push('识别到的后台接口：' + endpoints.join('、'));
  hint.textContent = notes.join(' ');
}

async function ensureSelfLoginInteractive(opts) {
  const silent = !!(opts && opts.silent);
  try {
    const s = await api('/api/self/session');
    if (s.loggedIn) {
      // 自助后台是单会话排他：会话账号 ≠ 所选账号时，绝不能把它的设备/用量当成本账号的
      const sel = state.accounts.find(a => a.id === $('accountSelect').value);
      if (!sel || !s.account || s.account === sel.username) return true;
      if (!silent) {
        toast(`自助后台当前登录的是 ${s.account}，与所选账号 ${sel.username} 不一致：`
          + `请先到右上角齿轮「设置」里点“注销自助后台”，再加载 ${sel.username} 的设备与用量。`, 'err');
      }
      return false;
    }
  } catch (e) {
    if (!silent) toast(e.message, 'err');
    return false;
  }
  // 静默自动刷新：后台未登录时不弹验证码/密码，只跳过
  if (silent) return false;
  const acc = state.accounts.find(a => a.id === $('accountSelect').value) || state.accounts[0];
  if (!acc) { toast('请先在账号簿添加账号', 'err'); return false; }
  try {
    // 密码已保存 → 直接用 accountId 让服务端解密，不再弹密码框；只弹验证码
    let base;
    let pending = null;
    if (acc.hasPassword) {
      base = { accountId: acc.id };
    } else {
      const pw = await askPassword(`登录自助服务（${acc.username}）`, true);
      if (!pw) return false;
      base = { accountId: acc.id, password: pw.password };
      pending = pw;
    }
    let lr = await api('/api/self/login', base);
    if (lr.needCaptcha) {
      const code = await askCaptcha(lr.captchaB64);
      if (!code) return false;
      lr = await api('/api/self/login', { ...base, code });
    }
    if (!lr.ok) { toast('自助登录失败：' + (lr.tip || '登录失败'), 'err'); return false; }
    if (pending && pending.remember) {
      await api('/api/vault', {
        id: acc.id, username: acc.username, suffix: acc.suffix,
        remark: acc.remark, password: pending.password, remember: true,
      });
      await refreshAccounts();
    }
    toast('自助服务已登录', 'ok');
    return true;
  } catch (e) {
    toast(e.message, 'err');
    return false;
  }
}

/* 进入控制台 / 切换账号时：若该账号后台会话已就绪则加载设备与用量（事件触发，非定时）；
   未登录后台时不弹验证码/密码，只提示手动刷新 */
async function autoLoadForAccount() {
  if (state.mode !== 'server') return;
  const acc = state.accounts.find(a => a.id === $('accountSelect').value);
  if (!acc) return;
  try {
    const s = await api('/api/self/session');
    if (s.loggedIn && s.account === acc.username) {
      state.panelsAt = Date.now();
      refreshDevices({ silent: true });
      loadUsage({ silent: true });
    } else {
      $('devHint').textContent = '当前账号未登录后台：点“刷新”加载（密码已保存，只需输一次验证码）。';
      $('usageHint').textContent = '当前账号未登录后台：点“加载”获取该账号的各 IP 用量。';
    }
  } catch {}
}

/** 自动刷新用：仅当后台已登录时拉数据，不弹验证码/密码框 */
async function selfSessionReady() {
  if (state.mode !== 'server') return false;
  try {
    const s = await api('/api/self/session');
    if (!s || !s.loggedIn) return false;
    const acc = state.accounts.find(a => a.id === $('accountSelect').value);
    if (!acc) return true;
    return !s.account || s.account === acc.username;
  } catch { return false; }
}

/**
 * 事件触发：静默刷新右侧「绑定设备」/「IP 用量」（无固定间隔定时）
 * opts.which: 'both'（默认，进入控制台/抢网结束）| 'devices'（状态变好）| 'usage'
 */
async function refreshSelfPanels(silent, opts) {
  if (state.mode !== 'server' || state.running) return;
  if (document.hidden) return;
  if (state.panelsBusy) return;
  const which = (opts && opts.which) || 'both';
  // 抢网结束 / 状态变好可能在 1s 内连续触发，避免同一时刻打两次自助接口
  const now = Date.now();
  if (now - (state.panelsAt || 0) < 2000) return;
  if (!(await selfSessionReady())) return;
  state.panelsAt = now;
  state.panelsBusy = true;
  const t = new Date().toTimeString().slice(0, 8);
  try {
    if (which === 'both' || which === 'devices') {
      await refreshDevices({ silent: true, quietTime: t });
    }
    if (which === 'both' || which === 'usage') {
      await loadUsage({ silent: true, quietTime: t });
    }
  } finally {
    state.panelsBusy = false;
  }
}

async function refreshDevices(opts) {
  const silent = !!(opts && opts.silent);
  const quietTime = (opts && opts.quietTime) || '';
  if (state.mode !== 'server') { renderDevices([], []); return; }
  try {
    if (!(await ensureSelfLoginInteractive({ silent }))) return;
    const r = await api('/api/self/devices');
    renderDevices(r.devices || [], r.endpoints || []);
    if (quietTime) {
      const h = $('devHint');
      const base = (h && h.textContent) ? h.textContent.replace(/\s*·\s*自动刷新\s*\d{2}:\d{2}:\d{2}/, '') : '';
      if (h) h.textContent = (base ? base + ' · ' : '') + '自动刷新 ' + quietTime;
    }
  } catch (e) {
    if (!silent) toast(e.message, 'err');
  }
}

/* ---------------- 各 IP 用量 ---------------- */
function fmtDT(ms, text) {
  if (text) return text;
  if (!ms) return '—';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderUsage(r) {
  const grid = $('usageGrid');
  grid.innerHTML = '';
  const hint = $('usageHint');
  state.lastUsage = r;
  if (!r.ips || !r.ips.length) {
    const d = document.createElement('div');
    d.className = 'hint usage-empty';
    d.textContent = r.note || '暂无记录';
    grid.appendChild(d);
    hint.textContent = (r.candidates && r.candidates.length)
      ? '发现的候选查询页：' + r.candidates.join('、')
      : '仪表盘菜单里未发现查询页链接。';
    return;
  }
  for (const ip of r.ips) {
    const card = document.createElement('div');
    card.className = 'usage-item';

    const head = document.createElement('div');
    head.className = 'usage-head';
    const ipEl = document.createElement('span');
    ipEl.className = 'usage-ip';
    ipEl.textContent = ip.ip;
    head.appendChild(ipEl);
    const tag = document.createElement('span');
    tag.className = 'tag ' + (ip.type === 'PC' ? 'pc' : ip.type === '手机' ? 'phone' : '');
    tag.textContent = ip.type || '未知';
    head.appendChild(tag);
    if (ip.isSelf) {
      const s = document.createElement('span');
      s.className = 'tag self';
      s.textContent = '本机';
      head.appendChild(s);
    }
    const noteEl2 = ipNoteEl(ip.ip);
    if (noteEl2) head.appendChild(noteEl2);
    card.appendChild(head);

    const mk = (k, v) => {
      const row = document.createElement('div');
      row.className = 'usage-row';
      const kk = document.createElement('span');
      kk.className = 'k';
      kk.textContent = k;
      const vv = document.createElement('span');
      vv.className = 'v';
      vv.textContent = v;
      row.appendChild(kk);
      row.appendChild(vv);
      return row;
    };
    card.appendChild(mk('上次使用', r.hasTime === false ? '—' : fmtDT(ip.lastUsedMs, ip.lastUsedText)));
    card.appendChild(mk('上次会话', r.hasFlow ? fmtFlow(ip.lastKb) : '—'));
    card.appendChild(mk('累计', (r.hasFlow ? fmtFlow(ip.totalKb) : '—') + `（${ip.sessions} 次）`));
    grid.appendChild(card);
  }
  const bits = [];
  if (r.source) bits.push(`来源 ${r.source}${r.pages > 1 ? `（${r.pages} 页）` : ''}`);
  bits.push(`共 ${r.ips.length} 个 IP`);
  if (r.hasTime === false) bits.push('记录无时间列');
  bits.push('统计范围以查询页为准');
  hint.textContent = bits.join(' · ');
}

async function loadUsage(opts) {
  const silent = !!(opts && opts.silent);
  const quietTime = (opts && opts.quietTime) || '';
  if (state.mode !== 'server') {
    if (!silent) toast('需启动本地服务', 'err');
    return;
  }
  const btn = $('btnUsageRefresh');
  if (btn && btn.disabled) return;
  if (btn && !silent) { btn.disabled = true; btn.textContent = '加载中…'; }
  try {
    if (!(await ensureSelfLoginInteractive({ silent }))) return;
    const r = await api('/api/self/usage');
    renderUsage(r);
    if (quietTime) {
      const h = $('usageHint');
      const base = (h && h.textContent) ? h.textContent.replace(/\s*·\s*自动刷新\s*\d{2}:\d{2}:\d{2}/, '') : '';
      if (h) h.textContent = (base ? base + ' · ' : '') + '自动刷新 ' + quietTime;
    }
    if (!silent && (!r.ok || !(r.ips || []).length)) toast(r.note || '未取到用量数据', 'err');
  } catch (e) {
    if (!silent) {
      $('usageHint').textContent = '加载失败：' + e.message;
      toast(e.message, 'err');
    }
  } finally {
    if (btn && !silent) {
      btn.disabled = false;
      btn.textContent = '加载';
    }
  }
}

async function unbindAt(dev, index) {
  if (!dev) return;
  try {
    const acc = state.accounts.find(a => a.id === $('accountSelect').value);
    // 优先按 MAC 解绑：服务端列表与界面不同步时，索引会解绑到相邻的另一台设备
    const payload = { account: acc ? acc.username : '' };
    if (dev.mac) payload.mac = dev.mac;
    else payload.index = index;
    await api('/api/self/unbind', payload);
    toast('已提交解绑', 'ok');
    setTimeout(() => refreshDevices({ silent: true }), 700);
  } catch (e) {
    toast(e.message, 'err');
    log('解绑失败：' + e.message, 'err');
  }
}

/* ---------------- 一键抢网 ---------------- */
function ensureSSE() {
  if (state.es || state.mode !== 'server') return;
  const es = new EventSource('/api/connect/stream?token=' + encodeURIComponent(state.token));
  es.onmessage = ev => {
    try { handleEvent(JSON.parse(ev.data)); } catch {}
  };
  es.onerror = () => { /* 浏览器会自动重连 */ };
  state.es = es;
}

/** 完整模式：控制台页心跳；关闭页面后本地服务自动退出 */
function startClientLifecycle() {
  if (state.mode !== 'server' || state._lifeOn) return;
  state._lifeOn = true;
  const beat = () => {
    api('/api/alive').catch(() => {});
  };
  beat();
  setInterval(beat, 10000);
  const goodbye = () => {
    try {
      const u = '/api/goodbye?t=' + encodeURIComponent(state.token || '');
      if (navigator.sendBeacon) navigator.sendBeacon(u);
      else fetch(u, { method: 'GET' }).catch(() => {});
    } catch {}
  };
  window.addEventListener('pagehide', goodbye);
  window.addEventListener('beforeunload', goodbye);
}

function handleEvent(e) {
  switch (e.type) {
    case 'start':
      state.running = true;
      syncConnectBtn();
      resetPipeline();
      hidePause();
      log('—— 开始抢网 ——', 'hi');
      break;
    case 'step':
      setStep(e.step, e.status, e.note);
      break;
    case 'log':
      log(e.msg);
      break;
    case 'warn':
      log(e.msg, 'warn');
      break;
    case 'error':
      log(e.msg, 'err');
      toast(e.msg, 'err');
      break;
    case 'captcha':
      askCaptcha(e.img).then(code => {
        if (code) api('/api/connect/captcha', { code }).catch(err => toast(err.message, 'err'));
      });
      break;
    case 'decision':
      showDecision(e);
      break;
    case 'devices':
      renderDevices(e.devices || [], e.endpoints || []);
      break;
    case 'done':
      if (/未打通|围墙|请完成浏览器|门户登录页/.test(String(e.msg || ''))) {
        log(e.msg, 'warn');
        toast(e.msg, 'err');
      } else {
        log(e.msg, 'ok');
        toast(e.msg, 'ok');
      }
      refreshStatus(true);
      setTimeout(() => refreshSelfPanels(true), 800);
      break;
    case 'paused':
      log(e.msg, 'warn');
      showPause(e.msg);
      if (/数据未打通|围墙|门户登录页/.test(String(e.msg || ''))) {
        toast('门户在线但数据未打通：点「门户登录页」完成浏览器登录', 'err');
      }
      setTimeout(() => refreshSelfPanels(true), 800);
      break;
    case 'end':
      state.running = false;
      syncConnectBtn();
      refreshStatus(true);
      // 抢网结束后：即便过程里连过校园网，也刷一次设备/用量
      setTimeout(() => refreshSelfPanels(true), 1000);
      break;
  }
}

async function doConnect() {
  if (state.running) return;
  const id = $('accountSelect').value;
  const acc = state.accounts.find(a => a.id === id);
  if (!acc) { toast('请先添加并选择账号', 'err'); $('btnAddAcct').click(); return; }

  if (state.mode === 'server') {
    // 点击一键：若已在校园网，先静默刷一次设备/用量（热点上不刷，避免对自助系统超时）
    if (isCampusSsid(state.wifiSsid)) refreshSelfPanels(true);
    // 一键抢网：服务端也会 ensureCampusWifi；前端默认带上校园网配置
    const prof = ($('wifiProfiles') && $('wifiProfiles').value) || 'HNIST-student';
    let payload = {
      accountId: acc.id,
      autoWifi: $('ckAutoWifi') ? !!$('ckAutoWifi').checked : true,
      wifiProfile: /student/i.test(prof) ? prof : 'HNIST-student',
    };
    if (!acc.hasPassword) {
      const pw = await askPassword(`输入密码（${acc.username}${acc.suffix || ''}）`, true);
      if (!pw) return;
      payload.password = pw.password;
      if (pw.remember) {
        try {
          await api('/api/vault', {
            id: acc.id, username: acc.username, suffix: acc.suffix,
            remark: acc.remark, password: pw.password, remember: true,
          });
          await refreshAccounts();
        } catch (e) { toast('保存密码失败：' + e.message, 'err'); }
      }
    }
    try {
      await api('/api/connect', payload);
      ensureSSE();
    } catch (e) {
      toast(e.message, 'err');
      log('启动任务失败：' + e.message, 'err');
    }
  } else {
    let password = state.litePw[acc.id];
    if (!password) {
      const pw = await askPassword(`输入密码（${acc.username}）`, false);
      if (!pw) return;
      password = pw.password;
    }
    await liteConnect(acc, password);
  }
}

async function liteConnect(acc, password) {
  state.running = true;
  syncConnectBtn();
  resetPipeline();
  hidePause();
  log('—— 开始抢网（轻量模式） ——', 'hi');
  try {
    setStep('detect', 'running');
    let st = await portalLite('chkstatus');
    const online = String(st.result) === '1';
    setStep('detect', 'ok', online ? '已在线' : '未在线');
    if (online) {
      setStep('precheck', 'skip', '已在线');
      setStep('unbind', 'skip');
      setStep('portal', 'skip');
      setStep('verify', 'ok', st.uid || '');
      log('网络已在线：' + (st.uid || ''), 'ok');
      renderStatus({ online: true, uid: st.uid, ip: st.v4ip, onlineSeconds: st.time, flowKB: st.flow }, null);
      return;
    }
    setStep('precheck', 'skip', '轻量模式不支持');
    setStep('unbind', 'skip', '请手动进后台解绑');
    setStep('portal', 'running');
    const r = await portalLite('login', {
      DDDDD: acc.username + (acc.suffix || ''),
      upass: password,
      '0MKKey': '123456',
      R1: '', R2: '', R3: '', R6: '0', para: '', v6ip: '',
      terminal_type: '1',
    });
    const ok = String(r.result) === '1' || r.result === 'ok';
    if (!ok) {
      setStep('portal', 'fail', r.msg || '失败');
      throw new Error(r.msg || '门户登录失败');
    }
    setStep('portal', 'ok', '登录成功');
    state.litePw[acc.id] = password;
    setStep('verify', 'running');
    await new Promise(res => setTimeout(res, 900));
    st = await portalLite('chkstatus');
    if (String(st.result) !== '1') {
      setStep('verify', 'fail', '仍未在线');
      throw new Error('登录后验证未通过');
    }
    setStep('verify', 'ok', st.uid || '');
    log('连接成功：' + (st.uid || ''), 'ok');
    toast('连接成功', 'ok');
    renderStatus({ online: true, uid: st.uid, ip: st.v4ip, onlineSeconds: st.time, flowKB: st.flow }, null);
  } catch (e) {
    log(e.message, 'err');
    toast(e.message, 'err');
  } finally {
    state.running = false;
    syncConnectBtn();
  }
}

/* ---------------- 主题外观 ---------------- */
const THEMES = ['dark', 'light', 'paper', 'mica'];
function setTheme(name, persist) {
  if (!THEMES.includes(name)) name = 'dark';
  document.documentElement.setAttribute('data-theme', name);
  if (persist) {
    try { localStorage.setItem('cnal_theme', name); } catch {}
  }
  document.querySelectorAll('#themeSwatches .theme-swatch').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.theme === name));
  });
}

/* ---------------- IP 备注 ---------------- */
async function loadIpNotes() {
  if (state.mode !== 'server') return;
  try {
    const r = await api('/api/ipnotes');
    state.ipNotes = (r && r.notes) || {};
    if (state.lastUsage) renderUsage(state.lastUsage);
    if (state.lastDevices) renderDevices(state.lastDevices, state.lastEndpoints || []);
  } catch { /* 备注读取失败不影响主流程 */ }
}

async function editIpNote(ip) {
  const cur = state.ipNotes[ip] || '';
  const val = prompt('为 ' + ip + ' 设置备注（留空表示删除）：', cur);
  if (val === null) return;
  try {
    const r = await api('/api/ipnotes', { ip, note: val });
    state.ipNotes = (r && r.notes) || state.ipNotes;
    if (state.lastUsage) renderUsage(state.lastUsage);
    if (state.lastDevices) renderDevices(state.lastDevices, state.lastEndpoints || []);
    toast(val.trim() ? '备注已保存：' + val.trim() : '备注已删除', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

/** 生成备注胶囊或「＋备注」按钮（usage 卡与设备表共用） */
function ipNoteEl(ip) {
  if (state.mode !== 'server') return null; // 备注存在服务端文件，轻量模式没有可写的地方
  if (!ip || ip === '—') return null;
  const note = state.ipNotes[ip];
  const el = document.createElement('button');
  el.type = 'button';
  if (note) {
    el.className = 'ip-note';
    el.textContent = note;
    el.title = '点击修改“' + ip + '”的备注';
  } else {
    el.className = 'ip-note-add';
    el.textContent = '＋备注';
    el.title = '为 ' + ip + ' 添加备注';
  }
  el.onclick = () => editIpNote(ip);
  return el;
}

/* ---------------- 用量卡折叠 ---------------- */
function setUsageOpen(open, persist) {
  state.usageOpen = !!open;
  const body = $('usageBody');
  const btn = $('btnUsageToggle');
  if (body) body.classList.toggle('hidden', !state.usageOpen);
  if (btn) {
    btn.textContent = state.usageOpen ? '收起' : '展开';
    btn.setAttribute('aria-expanded', String(state.usageOpen));
  }
  if (persist) localStorage.setItem('cnal_usageOpen', state.usageOpen ? '1' : '0');
}

/* ---------------- 网络检测（P2：延迟 / 抖动 / DNS / 首字节） ----------------
 * 默认关闭，打开后才产生探测。间隔与状态探测同量级（60s），但单次检测本身要跑 5~8 秒
 * （国外链路慢时更久），所以三条刹车：页面隐藏不跑、抢网运行中不跑、上一次没跑完不叠加。
 * 结果只留在内存与页面，不落盘。
 */
const NETCHECK_INTERVAL_MS = 60000;
const NET_GRADE_TEXT = { excellent: '优秀', good: '良好', fair: '一般', poor: '较差' };
const NET_GRADE_RANK = { excellent: 3, good: 2, fair: 1, poor: 0, unknown: -1 };
const NET_HISTORY_MAX = 60; // 只留最近 60 个点（60s 一点 ≈ 最近 1 小时），防止无限增长

function setNetcheck(on, persist) {
  state.netcheckOn = !!on;
  if ($('ckNetcheck')) $('ckNetcheck').checked = state.netcheckOn;
  if ($('netBody')) $('netBody').classList.toggle('hidden', !state.netcheckOn);
  if ($('netIdle')) $('netIdle').classList.toggle('hidden', state.netcheckOn);
  stopNetTimer();
  if (state.netcheckOn) {
    renderNetTrend();  // 先把空态占位画出来，别让人以为卡片坏了
    loadNetIdentity(); // 先把「当前检测的是哪个网络」显示出来，别让用户盯着「—」等好几秒
    runNetcheck();     // 打开就立刻跑一次，别让用户干等一个间隔
    state.netTimer = setInterval(() => runNetcheck(), NETCHECK_INTERVAL_MS);
  }
  if (persist) localStorage.setItem('cnal_netcheck', state.netcheckOn ? '1' : '0');
}

/** 只读接口：拿网络身份与上次结果，不触发任何探测 */
async function loadNetIdentity() {
  if (state.mode !== 'server') return;
  try {
    const r = await api('/api/netcheck');
    if (r && r.result) renderNetcheck(r);
    else if (r && r.network) renderNetWho(r.network);
  } catch { /* 身份取不到不影响检测本身 */ }
}

function stopNetTimer() {
  if (state.netTimer) { clearInterval(state.netTimer); state.netTimer = null; }
  if (state.netRetryTimer) { clearTimeout(state.netRetryTimer); state.netRetryTimer = null; }
  state.netRetryCount = 0;
}

/** 撞上重型请求就稍后再试，而不是直接丢掉这一轮 */
function scheduleNetRetry() {
  if (state.netRetryTimer) return;
  // 避让上限约 13 次（~40s）：超过就强行测。 reason：自助后台请求挂住时（比如
  // 在校园热点/信号差的地方根本连不上 172.31.8.43），heavyBusy 会一直 >0，
  // 无限避让 = 第一次检测永远不来。等了 40s 还在避让，宁可测一个可能被
  // 轻微污染的数，也不要让用户干等几分钟。
  state.netRetryCount++;
  state.netRetryTimer = setTimeout(() => {
    state.netRetryTimer = null;
    runNetcheck({ force: state.netRetryCount > 13 });
  }, 3000);
}

/** 重型请求刚收尾：若有网络检测正排队避开它，立刻补跑，别让第一次检测白等一个间隔 */
function netcheckAfterHeavy() {
  if (state.heavyBusy > 0 || !state.netRetryTimer) return;
  clearTimeout(state.netRetryTimer);
  state.netRetryTimer = null;
  if (state.netBusy) return; // 已有一次检测在跑，排队的那次不用再来
  runNetcheck();
}

async function runNetcheck(opts) {
  if (!state.netcheckOn || state.mode !== 'server') return;
  if (state.netBusy || state.running || document.hidden) return;
  // 自助后台正在跑（会话/登录/设备/用量）时先不测：这时候测出来的延迟和抖动
  // 是自家请求挤出来的假数字，宁可延后几秒也不要给一个误导的结论。
  // 但避让不是无限的：scheduleNetRetry 排到 ~40s 还在避让会带 force 来，
  // 因为自助后台挂住时（连不上）heavyBusy 可能几分钟都降不下来。
  if (state.heavyBusy > 0 && !(opts && opts.force)) { scheduleNetRetry(); return; }
  state.netRetryCount = 0;
  state.netBusy = true;
  const btn = $('btnNetRun');
  if (btn) { btn.disabled = true; btn.textContent = '检测中…'; }
  try {
    renderNetcheck(await api('/api/netcheck', {}));
  } catch (e) {
    toast('网络检测失败：' + e.message, 'err');
  } finally {
    state.netBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = '立即检测'; }
  }
}

/** 一格数据：数值 + 档位；拿不到数值时显示传入的失败文案 */
function netCell(el, ms, g, failText) {
  if (!el) return;
  el.innerHTML = '';
  const v = document.createElement('span');
  v.className = 'nv';
  if (typeof ms === 'number' && isFinite(ms)) {
    v.textContent = ms + 'ms';
  } else {
    v.textContent = failText || '—';
    v.classList.add('bad');
  }
  el.appendChild(v);
  if (g && g !== 'unknown' && NET_GRADE_TEXT[g]) {
    const s = document.createElement('span');
    s.className = 'ng ' + g;
    s.textContent = NET_GRADE_TEXT[g];
    el.appendChild(s);
  }
}

/** 小字：当前检测的是哪个网络 —— 这就是「不止检测校园网」的落点 */
function renderNetWho(n) {
  const el = $('netWho');
  if (!el) return;
  el.innerHTML = '';
  if (!n) { el.textContent = '当前检测：—'; return; }
  const name = n.ssid || (n.type === '未连接' ? '未连接网络' : n.type);
  const l1 = document.createElement('div');
  l1.appendChild(document.createTextNode('当前检测：'));
  const b = document.createElement('b');
  b.textContent = name;
  l1.appendChild(b);
  l1.appendChild(document.createTextNode('（' + n.kind + ' · ' + n.type + '）'));
  el.appendChild(l1);
  if (n.ip) {
    const l2 = document.createElement('div');
    l2.className = 'nw-sub';
    l2.textContent = '本机 ' + n.ip + (n.iface ? ' · 网卡 ' + n.iface : '');
    el.appendChild(l2);
  }
}

/* ---- 会话内趋势（只存内存，不落盘；刷新即清零） ----
 * 每个 60s 检测成功就入账一个点，最多留 60 个。绘图不引任何第三方库，
 * 手写内联 SVG——和图无关的地方一个字节都没多。
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  return el;
}

/** 把数值抬到刻度友好的上限（50/100/200…），y 轴才不会出现 137ms 这种怪刻度 */
function niceCeil(v) {
  if (!isFinite(v) || v <= 0) return 50;
  for (const s of [50, 100, 200, 300, 400, 500, 600, 700, 800, 1000, 1500, 2000, 3000, 5000]) {
    if (v <= s) return s;
  }
  return Math.ceil(v / 1000) * 1000;
}

/** 把一次检测结果记进会话内历史；按 r.at 去重，晚到的旧结果不会重复入账 */
function recordNetPoint(r) {
  if (!r || !r.at) return;
  const hist = state.netHistory;
  if (hist.length && hist[hist.length - 1].t === r.at) return;
  const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
  const lat = k => (((r.groups || {})[k] || {}).latency || {});
  // 只记延迟：抖动数量级比延迟小一个量级，同轴画会被压成一条贴底直线（实测过），
  // 数值在表格里有，图上不重复。
  hist.push({
    t: r.at,
    dom: num(lat('domestic').avg),
    frn: num(lat('foreign').avg),
  });
  while (hist.length > NET_HISTORY_MAX) hist.shift();
}

/** 延迟走势：横轴是检测次序（不是真实时间刻度），够看趋势就行 */
function renderNetTrend() {
  const box = $('netTrend');
  if (!box) return;
  const hint = $('netTrendHint');
  const hist = state.netHistory || [];
  box.innerHTML = '';

  if (!hist.length) {
    const d = document.createElement('div');
    d.className = 'net-trend-empty';
    d.textContent = '趋势收集中…打开后每 60 秒记一个点';
    box.appendChild(d);
    if (hint) hint.textContent = '';
    return;
  }

  const W = 320, H = 104, padL = 36, padR = 10, padT = 10, padB = 18;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = hist.length;

  let peak = 0;
  for (const p of hist) {
    for (const v of [p.dom, p.frn]) {
      if (v != null && v > peak) peak = v;
    }
  }
  if (peak <= 0) peak = 50; // 全是超时（null）时给个假刻度，别让坐标轴塌成一条线
  const yMax = niceCeil(peak * 1.15);
  const xAt = i => padL + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const yAt = v => padT + plotH - (Math.max(0, v) / yMax) * plotH;

  const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': '延迟趋势' });

  // 网格与刻度（0 / 半程 / 上限）
  for (const frac of [0, 0.5, 1]) {
    const v = yMax * frac, y = yAt(v);
    svg.appendChild(svgEl('line', { class: 'grid', x1: padL, x2: W - padR, y1: y, y2: y }));
    const tx = svgEl('text', { class: 'axis-txt', x: padL - 5, y: y + 3, 'text-anchor': 'end' });
    tx.textContent = String(Math.round(v));
    svg.appendChild(tx);
  }
  const unit = svgEl('text', { class: 'axis-txt', x: 2, y: padT + 4, 'text-anchor': 'start' });
  unit.textContent = 'ms';
  svg.appendChild(unit);

  // 折线：值为 null（超时）时断开当前点，不连出误导的斜线
  const drawLine = (key, cls) => {
    let d = '', pen = false, has = false;
    hist.forEach((p, i) => {
      const v = p[key];
      if (v == null) { pen = false; return; }
      has = true;
      d += (pen ? ' L' : ' M') + xAt(i).toFixed(1) + ' ' + yAt(v).toFixed(1);
      pen = true;
    });
    if (!has) return;
    svg.appendChild(svgEl('path', { class: cls, d: d }));
  };

  drawLine('dom', 'ln-dom');
  drawLine('frn', 'ln-frn');

  // 点：点多的时候只标最新一个，免得糊成一片
  const dot = (i, v, cls, last) => {
    if (v == null) return;
    const c = svgEl('circle', {
      class: cls + (last ? ' dot-last' : ''), cx: xAt(i).toFixed(1), cy: yAt(v).toFixed(1),
      r: last ? 3.2 : 2,
    });
    svg.appendChild(c);
  };
  const showAllDots = n <= 20;
  hist.forEach((p, i) => {
    const last = i === n - 1;
    if (showAllDots || last) { dot(i, p.dom, 'dot-dom', last); dot(i, p.frn, 'dot-frn', last); }
  });

  box.appendChild(svg);

  const lg = document.createElement('div');
  lg.className = 'net-trend-legend';
  const items = [
    ['dom', '国内延迟'], ['frn', '国外延迟'],
  ];
  for (const [k, label] of items) {
    const s = document.createElement('span');
    const i = document.createElement('i');
    i.className = k;
    s.appendChild(i);
    s.appendChild(document.createTextNode(label));
    lg.appendChild(s);
  }
  box.appendChild(lg);

  if (hint) {
    const t0 = new Date(hist[0].t), t1 = new Date(hist[n - 1].t);
    const p = x => String(x).padStart(2, '0');
    if (n === 1) hint.textContent = '已收集 1/2 个点，再来一次才成线';
    else {
      const mins = Math.max(1, Math.round((t1 - t0) / 60000));
      hint.textContent = '共 ' + n + ' 点 · ' + p(t0.getHours()) + ':' + p(t0.getMinutes())
        + '→' + p(t1.getHours()) + ':' + p(t1.getMinutes()) + '（近 ' + mins + ' 分钟）';
    }
  }
}

function renderNetcheck(payload) {
  const r = (payload && payload.result) || null;
  renderNetWho((payload && payload.network) || (r && r.network) || null);
  if (!r || !r.groups) return;
  recordNetPoint(r);   // 每次都入账，靠 r.at 去重（GET 拿回的旧结果不会重复计入）
  const dom = r.groups.domestic || {};
  const frn = r.groups.foreign || {};
  const lat = g => (g.latency || {});
  const failOf = (latency) => (latency.timeout ? '超时' : '—');

  netCell($('netLatDom'), lat(dom).avg, lat(dom).grade, failOf(lat(dom)));
  netCell($('netLatFor'), lat(frn).avg, lat(frn).grade, failOf(lat(frn)));
  netCell($('netJitDom'), lat(dom).jitter, null, '—');
  netCell($('netJitFor'), lat(frn).jitter, null, '—');
  const dnsFail = d => ((d || {}).skipped ? '—' : '失败');
  netCell($('netDnsDom'), (dom.dns || {}).avg, (dom.dns || {}).grade, dnsFail(dom.dns));
  netCell($('netDnsFor'), (frn.dns || {}).avg, (frn.dns || {}).grade, dnsFail(frn.dns));
  const ttf = (g) => {
    const t = g.ttfb || {};
    return {
      ms: t.ms,
      grade: t.error ? 'unknown' : t.grade,
      fail: t.skipped ? '—' : (t.error === '超时' ? '超时' : '失败'),
    };
  };
  const td = ttf(dom), tf = ttf(frn);
  netCell($('netTtfbDom'), td.ms, td.grade, td.fail);
  netCell($('netTtfbFor'), tf.ms, tf.grade, tf.fail);

  // 综合结论：报出最弱的那一项，光给个总评看不出该查什么
  const verdict = $('netVerdict');
  if (verdict) {
    verdict.className = 'net-verdict ' + (r.grade || 'unknown');
    const items = [];
    for (const [key, label] of [['domestic', '国内'], ['foreign', '国外']]) {
      const g = r.groups[key] || {};
      items.push([label + '延迟', lat(g).grade]);
      items.push([label + '首字节', (g.ttfb || {}).grade]);
    }
    const worst = items
      .filter(([, g]) => g && g !== 'unknown')
      .reduce((a, b) => (NET_GRADE_RANK[b[1]] < NET_GRADE_RANK[a[1]] ? b : a), ['', 'excellent']);
    verdict.textContent = '综合：' + (NET_GRADE_TEXT[r.grade] || '—')
      + (worst[0] ? '（最弱：' + worst[0] + ' ' + (NET_GRADE_TEXT[worst[1]] || '') + '）' : '');
  }

  const at = $('netAt');
  if (at && r.at) {
    const d = new Date(r.at);
    const p = n => String(n).padStart(2, '0');
    at.textContent = '上次：' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  const detail = $('netDetail');
  if (detail) {
    const names = k => (lat(r.groups[k]).targets || []).map(t => t.name).join('/') || '—';
    detail.textContent = '测点：国内 ' + names('domestic') + ' · 国外 ' + names('foreign')
      + ' · 用时 ' + (r.durationMs / 1000).toFixed(1) + 's'
      + (r.truncated ? '（网络太慢，本次提前结束，带「—」的项没测）' : '');
  }
  renderNetTrend();
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  const sw = $('themeSwatches');
  if (sw) {
    sw.querySelectorAll('.theme-swatch').forEach((b) => {
      b.onclick = () => {
        setTheme(b.dataset.theme, true);
        toast('外观已切换：' + b.textContent.trim(), 'ok');
      };
    });
    // head 内联脚本已提前上主题，这里只同步色卡选中态
    setTheme(document.documentElement.getAttribute('data-theme') || 'dark', false);
  }
  const modalSettings = $('modalSettings');
  $('btnSettings').onclick = () => modalSettings.classList.remove('hidden');
  $('btnSettingsClose').onclick = () => modalSettings.classList.add('hidden');
  // 点弹窗外的背景关闭（只关设置面板）
  modalSettings.onclick = (e) => { if (e.target === modalSettings) modalSettings.classList.add('hidden'); };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modalSettings.classList.contains('hidden')) modalSettings.classList.add('hidden');
  });
  $('btnMask').onclick = () => {
    state.masked = !state.masked;
    document.body.classList.toggle('masked', state.masked);
    localStorage.setItem('cnal_masked', state.masked ? '1' : '0');
    toast(state.masked ? '账号信息已隐藏，可安全截图' : '账号信息已显示', 'ok');
  };
  $('btnRefresh').onclick = () => refreshStatus(false);
  $('btnConnect').onclick = doConnect;
  $('btnOpenPortal').onclick = async () => {
    try {
      const r = await api('/api/portal/open', {});
      toast('已打开门户登录页（MAC ' + (r.mac || '') + '）', 'ok');
      log('已打开门户登录页：' + (r.url || 'https://auth.hnist.edu.cn/') + ' —— 推荐改用「一键抢网」自动填密；此按钮仅手动兜底。');
    } catch (e) {
      // 轻量模式兜底：直接开默认门户页
      window.open('https://auth.hnist.edu.cn/', '_blank');
      toast('已打开门户登录页（请手动登录）', 'ok');
    }
  };
  $('btnAddAcct').onclick = () => fillAcctForm(null);
  $('btnAcctCancel').onclick = () => setAcctFormOpen(false);
  $('acctForm').onsubmit = saveAcctForm;
  $('btnDevRefresh').onclick = refreshDevices;
  $('btnUsageRefresh').onclick = loadUsage;
  $('btnUsageToggle').onclick = () => setUsageOpen(!state.usageOpen, true);
  if ($('ckNetcheck')) $('ckNetcheck').onchange = () => setNetcheck($('ckNetcheck').checked, true);
  if ($('btnNetRun')) $('btnNetRun').onclick = () => runNetcheck();
  // 设置里的长简介默认收起，点标题展开；每个板块独立记忆（cnal_set_<key>）
  document.querySelectorAll('.set-group-title[data-key]').forEach((t) => {
    const key = 'cnal_set_' + t.dataset.key;
    setGroupOpen(t, localStorage.getItem(key) === '1');
    t.onclick = () => {
      const next = t.getAttribute('aria-expanded') !== 'true';
      setGroupOpen(t, next);
      localStorage.setItem(key, next ? '1' : '0');
    };
  });
  if ($('btnHotspotOpen')) $('btnHotspotOpen').onclick = async () => {
    // 只负责把人带到 Windows 的热点设置页，开关让用户自己动手
    try {
      await api('/api/hotspot/open', {});
      toast('已打开 Windows 热点设置', 'ok');
    } catch (e) {
      toast('打不开（' + e.message + '），请手动进：系统设置 → 网络和 Internet → 移动热点', 'err');
    }
  };
  $('accountSelect').onchange = () => autoLoadForAccount();
  $('btnSelfLogout').onclick = async () => {
    if (!confirm(
      '注销“自助后台”的登录占用？\n\n' +
      '· 作用：解除该账号在后台的登录占用，让本控制台可以登录它，查看/解绑设备、显示各 IP 用量统计\n' +
      '· 不影响正常上网：不会注销网络认证、不会断网\n' +
      '（本工具只能注销自己保存的会话；浏览器里登过的需在那边点注销）'
    )) return;
    try {
      const r = await api('/api/self/logout', {});
      toast(r.note || '已注销', 'ok');
      $('devHint').textContent = '已注销后台占用：点“刷新”重新加载设备。';
      $('usageHint').textContent = '已注销后台占用：点“加载”重新获取用量统计。';
    } catch (e) { toast(e.message, 'err'); }
  };

  $('btnPwOk').onclick = () => {
    const v = $('pwInput').value;
    if (!v) return toast('请输入密码', 'err');
    closePassword({ password: v, remember: $('pwRemember').checked });
  };
  $('btnPwCancel').onclick = () => closePassword(null);
  $('pwInput').onkeydown = e => { if (e.key === 'Enter') $('btnPwOk').click(); };

  $('btnCapOk').onclick = () => {
    const v = $('capInput').value.trim();
    if (!v) return toast('请输入验证码', 'err');
    closeCaptcha(v);
  };
  $('capInput').onkeydown = e => { if (e.key === 'Enter') $('btnCapOk').click(); };
  $('btnCapCancel').onclick = () => {
    // 本地的等待 promise 用 null 结束（不会走 /api/connect/captcha，避免把「取消」当成提交空验证码）；
    // 再单独通知服务端立刻唤醒等待中的任务，让它走「暂停」而不是干等 3 分钟超时。
    closeCaptcha(null);
    api('/api/connect/cancel', {}).catch(() => {});
    log('用户选择：取消（等待验证码）', 'warn');
  };

  $('btnDecContinue').onclick = () => {
    $('modalDecision').classList.add('hidden');
    api('/api/connect/decision', { action: 'continue' }).catch(e => toast(e.message, 'err'));
    log('用户选择：同意，继续抢网', 'hi');
  };
  $('btnDecPause').onclick = () => {
    $('modalDecision').classList.add('hidden');
    api('/api/connect/decision', { action: 'pause' }).catch(e => toast(e.message, 'err'));
    log('用户选择：暂不处理，任务暂停', 'warn');
  };

  $('btnWifiConnect').onclick = async () => {
    const name = $('wifiProfiles').value;
    if (!name) return toast('请先选择 WiFi 配置', 'err');
    try {
      const r = await api('/api/wifi/connect', { name });
      toast(r.msg, r.ok ? 'ok' : 'err');
      setTimeout(async () => {
        await refreshStatus(true);
        // 仅「连接」按钮连上校园网时刷设备/用量；一键抢网内部的自动连网不在此触发
        if (r.ok && isCampusSsid(name)) {
          log('已连接校园网，正在加载绑定设备与 IP 用量…', 'hi');
          setTimeout(() => refreshSelfPanels(true), 2000);
        }
      }, 1500);
    } catch (e) { toast(e.message, 'err'); }
  };

  // 「切回原网络」：只由用户点击触发，不做任何自动恢复
  $('btnWifiRestore').onclick = async () => {
    const btn = $('btnWifiRestore');
    btn.disabled = true;
    try {
      const r = await api('/api/wifi/restore', {});
      toast(r.ok ? r.msg : (r.msg || '切回失败'), r.ok ? 'ok' : 'err');
      if (r.ok) log('已请求切回原网络：' + r.from, 'hi');
      setTimeout(() => refreshStatus(true), 1500);
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  };

  $('ckAutoWifi').onchange = () => localStorage.setItem('cnal_autoWifi', $('ckAutoWifi').checked ? '1' : '0');
  $('ckDiag').onchange = async () => {
    try {
      await api('/api/diag', { on: $('ckDiag').checked });
      toast($('ckDiag').checked ? '诊断模式已开启（抓取页面存入 diag 目录）' : '诊断模式已关闭', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  $('btnDiagClear').onclick = async () => {
    if (!confirm('清除所有诊断信息（diag 文件夹中的后台页面快照）？\n不影响账号和已保存的密码。')) return;
    try {
      const r = await api('/api/diag/clear', {});
      toast(`已清除 ${r.removed || 0} 个诊断文件`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  $('btnClearPw').onclick = async () => {
    if (!confirm('清除所有已保存的密码？（账号和备注会保留）')) return;
    try { await api('/api/vault/clear-passwords'); await refreshAccounts(); toast('已清除', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };

  $('btnLogout').onclick = async () => {
    if (!confirm('注销当前在线会话？（本机将断开认证，可稍后重新抢网）')) return;
    try {
      const r = await api('/api/portal/logout');
      toast(r.ok ? '已请求注销' : '注销请求已发送', 'ok');
      setTimeout(() => refreshStatus(true), 1200);
    } catch (e) { toast(e.message, 'err'); }
  };

  $('lnkSelf').href = state.config.self;

  // 顶栏用 position:sticky 常驻；贴着窗口上沿时不投影，滚下去才加（否则显得很脏）
  const topbar = document.querySelector('.topbar');
  if (topbar) {
    const onScroll = () => topbar.classList.toggle('stuck', window.scrollY > 4);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
}

/* ---------------- 初始化 ---------------- */

/** 设置里「长简介」板块的开合：标题是按钮，内容在 .set-body 里 */
function setGroupOpen(title, open) {
  title.setAttribute('aria-expanded', String(open));
  const body = title.parentElement.querySelector('.set-body');
  if (body) body.classList.toggle('hidden', !open);
}

async function init() {
  const q = new URLSearchParams(location.search);
  const t = q.get('t');
  if (t) {
    state.token = t;
    sessionStorage.setItem('cnal_token', t);
    // 立刻把令牌从地址栏抹掉，避免留在浏览器历史里；sessionStorage 已持有副本
    const u = new URL(location.href);
    u.searchParams.delete('t');
    u.searchParams.delete('token');
    const qs = u.searchParams.toString();
    history.replaceState(null, '', u.pathname + (qs ? '?' + qs : '') + u.hash);
  }
  else state.token = sessionStorage.getItem('cnal_token') || '';

  // 一键抢网默认：已勾选自动连校园网，并优先 HNIST-student
  if ($('ckAutoWifi')) $('ckAutoWifi').checked = localStorage.getItem('cnal_autoWifi') !== '0';
  if ($('wifiProfiles') && !$('wifiProfiles').value) {
    const opts = [...$('wifiProfiles').options].map(o => o.value);
    if (opts.includes('HNIST-student')) $('wifiProfiles').value = 'HNIST-student';
    else if (opts.includes('HNIST')) $('wifiProfiles').value = 'HNIST';
  }
  state.masked = localStorage.getItem('cnal_masked') === '1';
  document.body.classList.toggle('masked', state.masked);
  // 用量卡折叠状态：默认收起（保证一屏装下），用户选择会被记住
  setUsageOpen(localStorage.getItem('cnal_usageOpen') === '1', false);
  // 网络检测：默认关闭，只有用户点开才会产生探测；开关状态被记住
  setNetcheck(localStorage.getItem('cnal_netcheck') === '1', false);
  bindEvents();
  bindTermLogUI();

  // 运行模式判定
  let serverUp = false;
  try {
    const ping = await fetch('/api/ping').then(r => r.json());
    if (ping && ping.ok) {
      serverUp = true;
      state.config = ping.config || state.config;
      state.mode = 'server';
    }
  } catch {}

  if (state.mode === 'server') {
    $('modeBadge').textContent = '完整模式 · 本地服务';
    startClientLifecycle();
    try {
      await api('/api/status');
      $('globalBanner').classList.add('hidden');
      ensureSSE();
    } catch (e) {
      if (e.status === 403) {
        const b = $('globalBanner');
        b.textContent = '访问令牌无效或缺失：请关闭本页面，重新双击“启动校园网助手.bat”打开。';
        b.className = 'banner warn';
      } else {
        const b = $('globalBanner');
        b.textContent = '本地服务异常：' + e.message;
        b.className = 'banner warn';
      }
    }
  } else {
    state.mode = 'lite';
    $('modeBadge').textContent = '轻量模式 · 纯页面（解绑需手动）';
    const b = $('globalBanner');
    b.textContent = '当前为轻量模式：双击启动本地服务（启动校园网助手.bat）可解锁自动解绑、设备管理与密码加密保存。';
    b.className = 'banner';
    b.classList.remove('hidden');
    for (const id of ['btnDevRefresh', 'btnUsageRefresh', 'btnWifiConnect', 'btnWifiRestore', 'ckDiag', 'btnDiagClear', 'btnClearPw', 'btnLogout', 'btnSelfLogout', 'btnTermLog', 'ckNetcheck', 'btnNetRun', 'btnHotspotOpen']) {
      const el = $(id);
      if (el) { el.disabled = true; el.title = '需要启动本地服务'; }
    }
  }

  await refreshAccounts();
  await refreshStatus(true);
  log(state.mode === 'server' ? '控制台已就绪（完整模式）' : '控制台已就绪（轻量模式）', 'hi');
  if (state.mode === 'server') {
    autoLoadForAccount();
    loadIpNotes();
    // 上一次已把网络检测开着的话，现在才真正跑第一次（init 早期 mode 还没定，会被守卫拦掉）
    if (state.netcheckOn) runNetcheck();
  }
  // 状态：前台每 60s 轻量探测（门户+NCSI，仅 2 次请求）
  // 离开控制台连续 ≥20s → 切回立刻刷一次；<20s 的短切不强刷、不累计
  // 右侧设备/用量：无固定间隔，按时机事件触发——
  //   进入控制台/切账号 → 设备+用量
  //   抢网 done/paused/end → 设备+用量
  //   手动按钮 → 对应面板
  //   门户状态变好 → 仅设备
  document.addEventListener('visibilitychange', onVisibilityChange);
  setInterval(() => { if (!document.hidden && !state.running) refreshStatus(true); }, STATUS_INTERVAL_MS);
}

init();
