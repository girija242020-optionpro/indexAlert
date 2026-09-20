import { SequenceEngine } from './engine.js';
import { CandleBuilder } from './candles.js';
import { Api } from './api.js';
import { loadSettings, saveSettings, engineCfg, DEFAULT_SETTINGS } from './settings.js';
import * as alerts from './alerts.js';
import * as logdb from './logdb.js';
import { analyzeChain, analyzeDepth, VolumeTracker } from './context.js';
import * as ui from './ui.js';
import { fmtDate, fmtTime, num, TF_LABEL } from './util.js';

const S = {
  cfg: loadSettings(), api: null, status: 'OFFLINE', serverStatus: null, tick: null, tickAt: 0, now: Date.now(), skew: 0, error: '',
  engine: null, builder: null, view: null, events: [], signal: { cls: 'WAIT', label: 'WAIT', sub: '' }, bestSide: { name: 'CALL', stage: 'IDLE' },
  ws: null, wsOpen: false, lastMsgAt: 0, paused: false,
  ctx: { chain: null, chainRaw: null, chainError: '', depth: null, depthId: null, depthError: '', fut: null, vol: new VolumeTracker(), ivHist: [], ivDelta: null },
  logs: [], ui: { tab: 'signal', open: { CALL: true, PUT: false }, depthSel: 'FUT', filters: { date: '', q: '', side: '', market: '', tf: '' } },
};
const nowMs = () => Date.now() + S.skew;
const tfSec = () => S.cfg.tf * 60;
const tfName = () => TF_LABEL[tfSec()];
let wsGen = 0, retry = 0, syncing = false, resyncAgain = false, renderQueued = 0;

// ---------- alert de-duplication (survives refresh) ----------
const FIRED_KEY = 'idxalert.fired';
const firedSet = () => { try { return new Set(JSON.parse(localStorage.getItem(FIRED_KEY) || '[]')); } catch { return new Set(); } };
const markFired = (id) => { const a = [...firedSet(), id].slice(-300); localStorage.setItem(FIRED_KEY, JSON.stringify(a)); };

// ---------- signal derivation ----------
function bestSide() {
  const v = S.view; if (!v) return { name: 'CALL', stage: 'IDLE' };
  return v.PUT.progress > v.CALL.progress ? v.PUT : v.CALL;
}
function computeSignal() {
  const v = S.view;
  const hold = Math.max(3 * tfSec() * 1000, 90000);
  const en = S.events.find((e) => e.kind === 'ENTRY' && !e.historical && nowMs() - e.closeTs * 1000 < hold);
  if (en) return { cls: `${en.side}_ENTRY`, label: `${en.side} ENTRY`, sub: `RSI2 confirmation completed · candle closed ${fmtTime(en.closeTs * 1000)} · CMP ${num(S.tick?.ltp ?? en.close)}` };
  if (v) {
    const rd = [v.CALL, v.PUT].filter((x) => x.ready).sort((a, b) => b.readyTs - a.readyTs)[0];
    if (rd) return { cls: `${rd.name}_READY`, label: `${rd.name} READY`, sub: `RSI1 sequence completed · waiting for RSI2: ${rd.r2.next || 'done'}` };
  }
  const b = S.bestSide;
  let sub = S.paused ? 'Feed not live: signals paused until data resumes' : !v?.ready ? 'Loading candle history...' : b.progress > 0 ? `${b.name} building: ${(b.ready ? b.r2 : b.r1).next || ''}` : 'No setup in progress';
  return { cls: 'WAIT', label: 'WAIT', sub };
}
function refreshView() {
  S.view = S.engine ? S.engine.view() : null;
  S.bestSide = bestSide();
  S.signal = computeSignal();
}

// ---------- events / alerts ----------
function processEvents(evs, replay) {
  const recentMs = Math.max(2 * tfSec() * 1000, 120000);
  const fired = firedSet();
  const fresh = [];
  for (const ev of evs) {
    ev.historical = nowMs() - ev.closeTs * 1000 > recentMs;
    if (!S.events.some((e) => e.id === ev.id)) S.events.push(ev);
    else { const i = S.events.findIndex((e) => e.id === ev.id); S.events[i] = ev; }
    if (!ev.historical && !fired.has(ev.id)) fresh.push(ev);
  }
  S.events.sort((a, b) => b.closeTs - a.closeTs || (a.kind === 'ENTRY' ? -1 : 1));
  S.events = S.events.slice(0, 60);
  // READY first, then ENTRY a moment later, so two alerts in one candle are both heard
  fresh.sort((a, b) => (a.kind === 'READY' ? -1 : 1) - (b.kind === 'READY' ? -1 : 1)).forEach((ev, i) => { markFired(ev.id); setTimeout(() => fireAlert(ev), i * 1000); });
  void replay;
}
async function fireAlert(ev) {
  const a = S.cfg.alerts;
  const title = `${ev.side} ${ev.kind}`;
  const body = `${S.cfg.market} ${tfName()} | CMP ${num(S.tick?.ltp ?? ev.close)} | ${ev.kind === 'READY' ? 'RSI1 sequence completed' : 'RSI2 confirmation completed'}`;
  if (a.sound) alerts.beep(ev.kind, ev.side, a.volume);
  if (a.vibrate) alerts.vibrate(ev.kind);
  ui.toast(`${title}  ${num(S.tick?.ltp ?? ev.close)}`, 4000);
  if (a.notify) alerts.localNotify(title, body, { tag: ev.id, kind: ev.kind });
  if (a.push && alerts.pushId()) S.api.post('/api/notify', { id: alerts.pushId(), title, body, eventId: ev.id, tag: ev.id, kind: ev.kind, side: ev.side }).catch(() => {});
  if (ev.kind === 'ENTRY') await logEntry(ev);
  scheduleRender();
}
async function logEntry(ev) {
  const fut = S.ctx.fut, ch = S.ctx.chain, dp = S.ctx.depth, ms = ev.closeTs * 1000;
  const seq = (arr) => arr.filter((s) => s.done).map((s) => `${s.label}${s.ts ? ' ' + fmtTime(s.ts * 1000).slice(0, 5) : ''}`).join(' > ');
  const r = (x) => (Number.isFinite(x) ? +x.toFixed(2) : null);
  const entry = {
    id: ev.id, date: fmtDate(ms), time: fmtTime(ms), market: S.cfg.market, timeframe: tfName(), side: ev.side,
    cmp: r(S.tick?.ltp ?? ev.close), candleClose: r(ev.close), dema: r(ev.dema), rsi1: r(ev.rsi1), rsi2: r(ev.rsi2), sma1: r(ev.sma1), sma2: r(ev.sma2),
    sequence: `RSI1: ${seq(ev.why.rsi1)} | RSI2: ${seq(ev.why.rsi2)}${ev.retained ? ' | RSI2 completed before READY (retained)' : ''}`,
    oi: fut?.oi ?? null, changeOi: fut?.changeOi ?? null, volume: fut?.volume ?? null, iv: ch?.iv ? r(ch.iv) : null,
    l20Bid: dp?.totalBid ?? null, l20Ask: dp?.totalAsk ?? null, l20Imbalance: dp ? r(dp.imbalance) : null, ts: ms,
  };
  if (await logdb.addLog(entry)) { S.logs = await logdb.allLogs(); }
}

// ---------- candles + engine ----------
function onCandleClosed(c) {
  if (S.paused || !S.engine) return; // never evaluate a candle built while the feed was not live
  processEvents(S.engine.onClose(c), false);
  refreshView(); scheduleRender();
}
async function resync() {
  if (!S.api.ok) return;
  if (syncing) { resyncAgain = true; return; }
  syncing = true;
  try {
    const d = await S.api.get(`/api/candles?symbol=${S.cfg.market}&tf=${S.cfg.tf}&limit=800`, 30000);
    if (d.serverTime) S.skew = d.serverTime - Date.now();
    if (!d.candles || d.candles.length < 30) { S.error = 'Backend is still loading Dhan candle history. Retrying...'; setTimeout(resync, 8000); return; }
    const eng = new SequenceEngine(engineCfg(S.cfg), { market: S.cfg.market, tf: tfSec() });
    const evs = eng.warmup(d.candles);
    S.engine = eng; S.events = [];
    const b = new CandleBuilder(tfSec()); b.seed(d.forming, d.candles[d.candles.length - 1].t); S.builder = b;
    S.error = ''; S.paused = !(S.status === 'LIVE' || S.status === 'CLOSED');
    processEvents(evs, true);
    refreshView();
  } catch (e) { S.error = 'Cannot load candles: ' + e.message; setTimeout(resync, 10000); }
  finally { syncing = false; if (resyncAgain) { resyncAgain = false; resync(); } scheduleRender(); }
}

// ---------- websocket ----------
function setStatus() {
  const prev = S.status;
  const sym = S.serverStatus?.symbols?.[S.cfg.market];
  S.status = !S.wsOpen ? 'OFFLINE' : sym ? sym.state : 'OFFLINE';
  const nowPaused = S.status === 'STALE' || S.status === 'OFFLINE';
  if (S.paused && !nowPaused && S.engine && prev !== S.status) { S.paused = false; resync(); } // data is back: rebuild from the server so nothing is missed
  S.paused = nowPaused;
}
function connect() {
  wsGen++; try { S.ws?.close(); } catch { /* ignore */ }
  if (!S.api.ok) { S.wsOpen = false; setStatus(); return; }
  const gen = wsGen;
  let ws;
  try { ws = new WebSocket(S.api.wsUrl()); } catch (e) { S.error = 'Bad backend URL'; return; }
  S.ws = ws;
  ws.onopen = () => { retry = 0; S.wsOpen = true; S.lastMsgAt = Date.now(); };
  ws.onmessage = (m) => { if (gen !== wsGen) return; S.lastMsgAt = Date.now(); try { onMsg(JSON.parse(m.data)); } catch { /* ignore */ } };
  ws.onclose = () => { if (gen !== wsGen) return; S.wsOpen = false; setStatus(); scheduleRender(); setTimeout(() => gen === wsGen && connect(), Math.min(15000, 1000 * 2 ** retry++)); };
  ws.onerror = () => { S.error = S.error || ''; };
}
function onMsg(m) {
  if (m.type === 'hello') {
    S.skew = m.serverTime - Date.now(); S.serverStatus = m.status; S.error = '';
    for (const t of m.ticks || []) handleTick(t, true);
    setStatus(); resync(); refreshCtx();
  } else if (m.type === 'status') { S.skew = m.serverTime - Date.now(); S.serverStatus = m; setStatus(); }
  else if (m.type === 'tick') handleTick(m, false);
  else if (m.type === 'depth') { if (S.ctx.depthId && m.securityId === S.ctx.depthId) { S.ctx.depth = analyzeDepth(m); S.ctx.depthError = ''; } }
  scheduleRender();
}
function handleTick(t, snapshot) {
  if (t.role === 'spot' && t.symbol === S.cfg.market) {
    S.tick = t; S.tickAt = t.ts;
    if (!snapshot && S.builder) { const c = S.builder.ingest(t.ts, t.ltp); if (c) onCandleClosed(c); }
  } else if (t.role === 'future' && t.underlying === S.cfg.market) {
    S.ctx.fut = t; S.ctx.vol.push(t.ts, t.volume);
  }
}

// ---------- market context ----------
async function refreshCtx() {
  if (!S.api.ok || S.status === 'OFFLINE') return;
  const m = S.cfg.market, c = S.ctx;
  try {
    const ch = await S.api.get(`/api/option-chain?symbol=${m}`, 30000);
    c.chainRaw = ch; c.chain = analyzeChain(ch, S.tick?.ltp); c.chainError = '';
    if (c.chain?.iv) {
      c.ivHist.push({ ts: Date.now(), iv: c.chain.iv }); c.ivHist = c.ivHist.filter((x) => Date.now() - x.ts < 600000);
      const old = [...c.ivHist].reverse().find((x) => Date.now() - x.ts >= 55000);
      c.ivDelta = old ? c.chain.iv - old.iv : null;
    }
  } catch (e) { c.chainError = e.message; }
  try {
    let path = null;
    if (S.ui.depthSel === 'FUT') path = `/api/depth20/${m}`;
    else {
      const row = c.chainRaw?.strikes?.find((s) => s.strike === c.chainRaw.atmStrike);
      const id = row?.[S.ui.depthSel === 'CE' ? 'ce' : 'pe']?.securityId;
      if (id) path = `/api/depth20/${id}?segment=${m === 'NIFTY' ? 'NSE_FNO' : 'BSE_FNO'}`; else c.depthError = 'Option security id not available yet';
    }
    if (path) {
      const d = await S.api.get(path);
      if (d.pending) { c.depthId = d.securityId; c.depthError = 'Subscribing to depth, updates in a few seconds...'; }
      else { c.depthId = d.securityId; c.depth = analyzeDepth(d); c.depthError = ''; }
    }
  } catch (e) { c.depthError = e.message; }
  scheduleRender();
}

// ---------- rendering ----------
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = setTimeout(() => { renderQueued = 0; requestAnimationFrame(render); }, 200);
}
function render() {
  S.now = nowMs(); refreshView();
  ui.renderTop(S);
  const t = S.ui.tab;
  if (t === 'signal') ui.renderSignal(S);
  else if (t === 'market') ui.renderMarket(S);
}
// tab switches must repaint even if the HTML is unchanged (view was hidden and rebuilt elsewhere)
const invalidate = () => { ui.renderSignal.last = null; ui.renderMarket.last = null; };
function showTab(t) {
  S.ui.tab = t;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  for (const v of ['signal', 'market', 'logs', 'settings']) document.getElementById('view-' + v).hidden = v !== t;
  if (t === 'settings') ui.renderSettings(S);
  if (t === 'logs') ui.renderLogs(S);
  invalidate();
  if (t === 'market') refreshCtx();
  render();
}

// ---------- actions ----------
async function restart() {
  S.api = new Api(S.cfg.backendUrl, S.cfg.apiKey);
  S.tick = null; S.tickAt = 0; S.engine = null; S.builder = null; S.events = []; S.error = '';
  S.ctx = { ...S.ctx, chain: null, chainRaw: null, depth: null, depthId: null, fut: null, vol: new VolumeTracker(), ivHist: [] };
  connect(); render();
  alerts.keepAwake(S.cfg.alerts.keepAwake);
  if (S.api.ok) alerts.resubscribeIfGranted(S.api);
}
async function diag() {
  const el = document.getElementById('diag'); el.textContent = 'Checking...';
  try {
    const h = await new Api(document.querySelector('[data-path="backendUrl"]').value, document.querySelector('[data-path="apiKey"]').value).get('/api/health');
    el.textContent = [
      `state: ${h.state}  (server ${h.server ? 'ok' : 'down'})`, `dhan authenticated: ${h.dhanAuthenticated}`, `market feed live: ${h.marketFeed}   depth feed live: ${h.depthFeed}`,
      `last tick: ${h.lastTick ? fmtTime(Date.parse(h.lastTick)) : 'none'}`, `subscriptions confirmed: ${h.feed.subscriptions.filter((s) => s.confirmed).length}/${h.feed.subscriptions.length}`,
      `push: ${h.push.configured ? 'configured' : 'NOT configured'} (${h.push.subscribers} device(s))`, ...(h.notes || []).map((n) => '! ' + n), ...(h.recentErrors || []).slice(0, 3).map((e) => '- ' + e.message),
    ].join('\n');
  } catch (e) { el.textContent = 'Failed: ' + e.message; }
}
async function enableAlerts() {
  const st = alerts.unlockAudio(); alerts.beep('READY', 'CALL', S.cfg.alerts.volume);
  const out = [`sound: ${st}`];
  const perm = await alerts.requestNotifications(); out.push(`notifications: ${perm}`);
  if (perm === 'granted' && S.api.ok) {
    try { await alerts.enablePush(S.api); out.push('push: registered'); } catch (e) { out.push('push: ' + e.message); }
  }
  const el = document.getElementById('alert-state'); if (el) el.textContent = out.join(' · ');
  alerts.keepAwake(S.cfg.alerts.keepAwake);
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-tab],[data-acc],[data-act],[data-del],[data-depth]');
  if (!el) return;
  alerts.unlockAudio(); // any tap unlocks WebAudio
  if (el.dataset.tab) return showTab(el.dataset.tab);
  if (el.dataset.acc) { S.ui.open[el.dataset.acc] = !S.ui.open[el.dataset.acc]; return render(); }
  if (el.dataset.depth) { S.ui.depthSel = el.dataset.depth; S.ctx.depth = null; S.ctx.depthId = null; render(); return refreshCtx(); }
  if (el.dataset.del) { if (confirm('Delete this log entry?')) { await logdb.deleteLog(el.dataset.del); S.logs = await logdb.allLogs(); ui.renderLogs(S); } return; }
  switch (el.dataset.act) {
    case 'save': {
      S.cfg = ui.readSettings(S.cfg); saveSettings(S.cfg); ui.toast('Saved. Rebuilding signals...'); await restart(); showTab('signal'); break;
    }
    case 'reset': if (confirm('Reset all settings to defaults? (Logs are kept)')) { S.cfg = { ...structuredClone(DEFAULT_SETTINGS), backendUrl: S.cfg.backendUrl, apiKey: S.cfg.apiKey }; saveSettings(S.cfg); ui.renderSettings(S); ui.toast('Defaults restored. Tap Save and apply.'); } break;
    case 'diag': diag(); break;
    case 'enable-alerts': enableAlerts(); break;
    case 'test-ready': alerts.unlockAudio(); alerts.beep('READY', 'CALL', S.cfg.alerts.volume); alerts.vibrate('READY'); break;
    case 'test-entry-call': alerts.unlockAudio(); alerts.beep('ENTRY', 'CALL', S.cfg.alerts.volume); alerts.vibrate('ENTRY'); break;
    case 'test-entry-put': alerts.unlockAudio(); alerts.beep('ENTRY', 'PUT', S.cfg.alerts.volume); alerts.vibrate('ENTRY'); break;
    case 'test-push': try { const r = await S.api.post('/api/test-push', { id: alerts.pushId() }); ui.toast(r.targets ? `Push sent to ${r.targets} device(s)` : 'No device registered: tap Enable first'); } catch (err) { ui.toast('Push failed: ' + err.message, 4000); } break;
    case 'refresh-ctx': ui.toast('Refreshing...'); refreshCtx(); break;
    case 'clear-filters': S.ui.filters = { date: '', q: '', side: '', market: '', tf: '' }; ui.renderLogs(S); break;
    case 'export-csv': {
      const F = S.ui.filters;
      const rows = S.logs.filter((r) => (!F.date || r.date === F.date) && (!F.side || r.side === F.side) && (!F.market || r.market === F.market) && (!F.tf || r.timeframe === F.tf) && (!F.q || JSON.stringify(r).toLowerCase().includes(F.q.toLowerCase())));
      logdb.downloadCsv(rows, `entries-${F.date || 'all'}.csv`); break;
    }
    default:
  }
});
document.addEventListener('input', (e) => { const f = e.target.dataset?.f; if (f && e.target.tagName === 'INPUT') { S.ui.filters[f] = e.target.value; ui.renderLogs(S); } });
document.addEventListener('change', (e) => { const f = e.target.dataset?.f; if (f) { S.ui.filters[f] = e.target.value; ui.renderLogs(S); } });

// ---------- timers / lifecycle ----------
setInterval(() => {
  S.now = nowMs();
  if (S.builder && !S.paused) { const c = S.builder.flush(S.now); if (c) onCandleClosed(c); }
  if (S.wsOpen && Date.now() - S.lastMsgAt > 15000) { try { S.ws.close(); } catch { /* ignore */ } } // frozen socket: reconnect
  ui.renderTop(S);
  if (S.ui.tab === 'signal') { refreshView(); ui.renderSignal(S); }
}, 1000);
setInterval(() => { if (S.wsOpen) try { S.ws.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ } }, 25000);
setInterval(() => { if (document.visibilityState === 'visible' && S.status === 'LIVE') refreshCtx(); }, 20000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  alerts.keepAwake(S.cfg.alerts.keepAwake);
  if (S.wsOpen) resync(); else connect();
});

(async function boot() {
  if (!S.cfg.backendUrl) { // served by the backend itself (single-repo deploy)? then no URL needs to be typed
    try { const r = await fetch('healthz', { cache: 'no-store' }); if (r.ok && (await r.text()).trim() === 'ok') { S.cfg.backendUrl = location.origin; saveSettings(S.cfg); } } catch { /* static host only */ }
  }
  S.api = new Api(S.cfg.backendUrl, S.cfg.apiKey);
  S.logs = await logdb.allLogs();
  document.getElementById('logcount').textContent = S.logs.length ? String(S.logs.length) : '';
  navigator.storage?.persist?.();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  showTab(S.api.ok ? 'signal' : 'settings');
  if (S.api.ok) { connect(); alerts.keepAwake(S.cfg.alerts.keepAwake); alerts.resubscribeIfGranted(S.api); }
})();
