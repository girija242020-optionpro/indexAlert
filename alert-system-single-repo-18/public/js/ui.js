import { esc, num, int, compact, fmtTime, fmtHM, TF_LABEL } from './util.js';
import { notifyState } from './alerts.js';

const $ = (id) => document.getElementById(id);
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '–');

export function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), ms);
}

export function renderTop(S) {
  const st = S.status;
  const label = { LIVE: 'LIVE', STALE: 'STALE', OFFLINE: 'OFFLINE', CLOSED: 'MARKET CLOSED' }[st] || st;
  const price = S.tick?.ltp;
  const age = S.tickAt ? Math.max(0, Math.round((S.now - S.tickAt) / 1000)) : null;
  $('top').innerHTML = `
    <div><span class="pill st-${st}"><span class="dot"></span>${label}</span></div>
    <div class="cmp" id="cmp">${num(price)}<small>${S.tickAt ? fmtTime(S.tickAt) + (age > 3 ? ` (${age}s ago)` : '') : 'no tick yet'}</small></div>
    <div class="mk">${esc(S.cfg.market)} | ${TF_LABEL[S.cfg.tf * 60]}${S.tick?.dayHigh ? ` | H ${num(S.tick.dayHigh)} L ${num(S.tick.dayLow)}` : ''}</div><div></div>`;
  const b = $('banner');
  let msg = '';
  if (!S.api.ok) msg = 'Set your backend URL in Settings to start.';
  else if (S.error) msg = S.error;
  else if (st === 'STALE') msg = 'Feed is connected but no fresh ticks. Signals are paused until data resumes.';
  else if (st === 'OFFLINE') msg = 'Cannot reach live market data. Retrying automatically.';
  b.hidden = !msg; b.textContent = msg;
}

const stepList = (steps, nextIdx) => steps.map((s, k) => `<li class="${s.done ? 'done' : k === nextIdx ? 'next' : ''}"><i>${s.done ? '✓' : k === nextIdx ? '→' : '○'}</i>${esc(s.label)}${s.done && s.ts ? `<time>${fmtTime(s.ts * 1000)}</time>` : ''}</li>`).join('');

function track(name, len, tr, rc, r, s) {
  return `<div class="track"><div class="track-h"><div>${name} (${len})</div><span>RSI ${f2(r)} · ${rc.smaType} ${rc.smaLen}: ${f2(s)}</span></div>
    <ul class="steps">${stepList(tr.steps, tr.n < 5 ? tr.n : -1)}</ul></div>`;
}

function sidePanel(S, side) {
  const v = S.view[side], cfg = S.cfg, ind = S.view.ind || {};
  const open = S.ui.open[side];
  const cls = side === 'CALL' ? 'call' : 'put';
  const prog = `RSI1 ${v.r1.n}/5 · RSI2 ${v.r2.n}/5`;
  return `<div class="acc ${open ? 'open' : ''} ${cls}-side"><button data-acc="${side}"><b class="${cls}">${side}</b><span class="grow">${esc(v.stage.replaceAll('_', ' '))} | ${prog}</span>${v.ready ? '<span class="badge ready">READY</span>' : ''}<span>${open ? '▾' : '▸'}</span></button>
    ${open ? `<div class="body ${cls}">${track('RSI1', cfg.rsi1.len, v.r1, cfg.rsi1, ind.rsi1, ind.sma1)}${track('RSI2', cfg.rsi2.len, v.r2, cfg.rsi2, ind.rsi2, ind.sma2)}
      ${v.ready ? `<div class="note" style="margin-top:8px">RSI1 is READY since ${fmtTime(v.readyTs * 1000 + S.cfg.tf * 60000)}. Waiting for RSI2 to complete.</div>` : ''}</div>` : ''}</div>`;
}

const whyList = (arr) => arr.map((s) => `<li class="${s.done ? '' : 'no'}">${esc(s.label)}${s.done && s.ts ? ` <span class="note mono">${fmtHM(s.ts * 1000)}</span>` : ''}</li>`).join('');

export function renderSignal(S) {
  const sg = S.signal, ind = S.view.ind || {};
  const ev = S.events[0];
  const why = ev ? `<div class="card why core"><h3 class="${ev.side === 'CALL' ? 'call' : 'put'}">Why ${ev.side} ${ev.kind}?</h3>
      <div class="note mono">Candle closed ${fmtTime(ev.closeTs * 1000)} · close ${num(ev.close)} · DEMA ${num(ev.dema)}${ev.historical ? ' · earlier signal (not alerted)' : ''}</div>
      <div class="grp">RSI1 (${S.cfg.rsi1.len}) ${ev.kind === 'ENTRY' ? '· already READY' : ''}</div><ul>${whyList(ev.why.rsi1)}</ul>
      ${ev.kind === 'ENTRY' ? `<div class="grp">RSI2 (${S.cfg.rsi2.len})${ev.retained ? ' · completed earlier, kept until RSI1 was READY' : ''}</div><ul>${whyList(ev.why.rsi2)}</ul>` : ''}
      <div class="therefore ${ev.side === 'CALL' ? 'call' : 'put'}">Therefore: ${ev.side} ${ev.kind}</div></div>` : '';
  const recent = S.events.slice(0, 8).map((e) => `<div class="ev"><span class="t">${fmtTime(e.closeTs * 1000)}</span><span class="k ${e.side === 'CALL' ? 'call' : 'put'}">${e.side} ${e.kind}${e.historical ? '<span class="tagh">history</span>' : ''}</span><span class="p">${num(e.close)}</span></div>`).join('');
  const html = `
    <div class="sig ${sg.cls}">
      <div class="sig-row"><span>Core signal (RSI + DEMA)</span><span class="mono">${ind.t ? 'candle ' + fmtHM(ind.t * 1000) : 'warming up'}</span></div>
      <div class="sig-label">${esc(sg.label)}</div>
      <div class="sig-sub">${esc(sg.sub)}</div>
      <dl class="kv">
        <div><dt>CMP</dt><dd id="k-cmp"></dd></div><div><dt>DEMA ${S.cfg.dema.len}</dt><dd>${num(ind.dema)}</dd></div><div><dt>Close</dt><dd>${num(ind.close)}</dd></div>
        <div><dt>RSI1</dt><dd>${f2(ind.rsi1)}</dd></div><div><dt>RSI2</dt><dd>${f2(ind.rsi2)}</dd></div><div><dt>Tick time</dt><dd id="k-time"></dd></div>
        <div><dt>SMA1</dt><dd>${f2(ind.sma1)}</dd></div><div><dt>${S.cfg.rsi2.smaType}2</dt><dd>${f2(ind.sma2)}</dd></div><div><dt>Stage</dt><dd style="font-size:12px">${esc(S.bestSide.stage.replaceAll('_', ' '))}</dd></div>
      </dl>
    </div>
    ${sidePanel(S, S.bestSide.name)}${sidePanel(S, S.bestSide.name === 'CALL' ? 'PUT' : 'CALL')}
    ${why}
    ${recent ? `<div class="card"><h2>Recent signals</h2>${recent}</div>` : `<div class="card note">No READY / ENTRY yet for ${esc(S.cfg.market)} ${TF_LABEL[S.cfg.tf * 60]}. Alerts fire once per closed candle, never per tick.</div>`}`;
  const el = $('view-signal');
  if (renderSignal.last !== html || !el.innerHTML) { el.innerHTML = html; renderSignal.last = html; } // skip identical renders so taps are never lost
  const c = $('k-cmp'), t = $('k-time');
  if (c) c.textContent = num(S.tick?.ltp);
  if (t) t.textContent = fmtTime(S.tickAt);
}

export function renderMarket(S) {
  const c = S.ctx, ch = c.chain, d = c.depth, fut = c.fut, vs = c.vol;
  const stat = (k, v, cls = '') => `<div class="stat"><small>${k}</small><b class="${cls}">${v}</b></div>`;
  const dcls = (v) => (v > 0 ? 'call' : v < 0 ? 'put' : '');
  const futBlock = fut ? `<div class="grid2">${stat('Future ' + esc(S.cfg.market), num(fut.ltp))}${stat('Volume', compact(fut.volume))}${stat('Open interest', compact(fut.oi))}${stat('Change in OI', (fut.changeOi > 0 ? '+' : '') + compact(fut.changeOi), dcls(fut.changeOi))}
      ${stat('Volume, last 1m', vs ? compact(vs.last1m) : '–')}${stat('vs prior 4m avg', vs?.ratio ? vs.ratio.toFixed(2) + 'x' : '–', vs?.ratio > 1.5 ? 'ready' : '')}</div>` : '<div class="note">Waiting for the index future feed (needed for OI and volume).</div>';
  const chBlock = ch ? `<div class="grid2">${stat('ATM strike', int(ch.atm))}${stat('ATM straddle', num(ch.straddle))}${stat('ATM IV', ch.iv ? ch.iv.toFixed(1) + '%' : '–')}${stat('IV change (~1m)', c.ivDelta == null ? '–' : (c.ivDelta > 0 ? '+' : '') + c.ivDelta.toFixed(2), dcls(c.ivDelta))}
      ${stat('PCR (OI)', ch.pcrOi ? ch.pcrOi.toFixed(2) : '–')}${stat('PCR (volume)', ch.pcrVol ? ch.pcrVol.toFixed(2) : '–')}
      ${stat('Call OI wall', ch.callWalls[0] ? int(ch.callWalls[0].strike) + ' · ' + compact(ch.callWalls[0].oi) : '–', 'put')}${stat('Put OI wall', ch.putWalls[0] ? int(ch.putWalls[0].strike) + ' · ' + compact(ch.putWalls[0].oi) : '–', 'call')}
      ${stat('Total call OI · Δ', compact(ch.totCe) + ' · ' + (ch.dCe > 0 ? '+' : '') + compact(ch.dCe))}${stat('Total put OI · Δ', compact(ch.totPe) + ' · ' + (ch.dPe > 0 ? '+' : '') + compact(ch.dPe))}
      ${stat('Call OI concentration', (ch.callConc * 100).toFixed(0) + '% in top 3')}${stat('Put OI concentration', (ch.putConc * 100).toFixed(0) + '% in top 3')}
      ${stat('ATM gamma', ch.atmGamma ? ch.atmGamma.toExponential(2) : '–')}${stat('Net gamma exposure', esc(ch.gexBias))}</div>
      <div class="note" style="margin-top:6px">Expiry ${esc(ch.expiry)} · updated ${fmtTime(Date.parse(ch.fetchedAt))} · Greeks ${esc(ch.greeksSource || '–')}. Gamma exposure is an assumption-based estimate.</div>
      <div class="tbl" style="margin-top:8px"><table><thead><tr><th>CE Δ OI</th><th>CE OI</th><th>CE</th><th>Strike</th><th>PE</th><th>PE OI</th><th>PE Δ OI</th></tr></thead><tbody>${ch.near.map((r) => `<tr class="${r.isAtm ? 'atm' : ''}"><td class="${dcls(r.ceD)}">${compact(r.ceD)}</td><td>${compact(r.ceOi)}</td><td>${num(r.cePrice)}</td><td>${int(r.strike)}</td><td>${num(r.pePrice)}</td><td>${compact(r.peOi)}</td><td class="${dcls(r.peD)}">${compact(r.peD)}</td></tr>`).join('')}</tbody></table></div>`
    : `<div class="note">${esc(c.chainError || 'Loading option chain...')}</div>`;
  const dpBlock = d ? `<div class="btns" style="margin-bottom:8px">${['FUT', 'CE', 'PE'].map((k) => `<button class="btn sm ${S.ui.depthSel === k ? 'primary' : ''}" data-depth="${k}">${k === 'FUT' ? 'Future' : 'ATM ' + k}</button>`).join('')}</div>
      <div class="bar"><i class="b" style="width:${d.bidPct}%"></i><i class="a" style="width:${d.askPct}%"></i></div>
      <div class="grid2">${stat('Bid quantity', compact(d.totalBid), 'call')}${stat('Ask quantity', compact(d.totalAsk), 'put')}${stat('Imbalance', (d.imbalance * 100).toFixed(0) + '%', dcls(d.imbalance))}${stat('Pressure', d.pressure + ' (' + d.levels + ' levels)', d.pressure === 'BID' ? 'call' : d.pressure === 'ASK' ? 'put' : '')}
      ${stat('Strongest bids', d.topBids.map((x) => num(x.price) + ' × ' + compact(x.quantity)).join('<br>'), 'call')}${stat('Strongest asks', d.topAsks.map((x) => num(x.price) + ' × ' + compact(x.quantity)).join('<br>'), 'put')}</div>
      <div class="note" style="margin-top:6px">${d.source === '20-level' ? '20-level depth' : '5-level depth (20-level is NSE-only)'} · ${esc(d.symbol || '')} · ${fmtTime(d.ts)}</div>`
    : `<div class="btns" style="margin-bottom:8px">${['FUT', 'CE', 'PE'].map((k) => `<button class="btn sm ${S.ui.depthSel === k ? 'primary' : ''}" data-depth="${k}">${k === 'FUT' ? 'Future' : 'ATM ' + k}</button>`).join('')}</div><div class="note">${esc(c.depthError || 'Waiting for depth data...')}</div>`;
  const mhtml = `
    <div class="note">Market confirmation. Evidence only: none of this changes the RSI/DEMA signal.</div>
    <div class="card conf"><h2>Futures: OI and volume</h2>${futBlock}</div>
    <div class="card conf"><h2>Options context</h2>${chBlock}</div>
    <div class="card conf"><h2>Market depth</h2>${dpBlock}</div>
    <div class="btns"><button class="btn" data-act="refresh-ctx">Refresh now</button></div>`;
  if (renderMarket.last !== mhtml) { $('view-market').innerHTML = mhtml; renderMarket.last = mhtml; }
}

export function renderLogs(S) {
  const L = S.logs, F = S.ui.filters;
  const rows = L.filter((r) => (!F.date || r.date === F.date) && (!F.side || r.side === F.side) && (!F.market || r.market === F.market) && (!F.tf || r.timeframe === F.tf)
    && (!F.q || JSON.stringify(r).toLowerCase().includes(F.q.toLowerCase())));
  const opt = (v, cur, l) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`;
  const el = $('view-logs');
  const keepFocus = document.activeElement?.dataset?.f;
  el.innerHTML = `
    <div class="filters card">
      <label class="f"><span>Date</span><input type="date" data-f="date" value="${esc(F.date)}"></label>
      <label class="f"><span>Search</span><input type="search" data-f="q" placeholder="price, RSI, note..." value="${esc(F.q)}"></label>
      <label class="f"><span>Side</span><select data-f="side">${opt('', F.side, 'All')}${opt('CALL', F.side, 'CALL')}${opt('PUT', F.side, 'PUT')}</select></label>
      <label class="f"><span>Market</span><select data-f="market">${opt('', F.market, 'All')}${opt('NIFTY', F.market, 'NIFTY')}${opt('SENSEX', F.market, 'SENSEX')}</select></label>
      <label class="f"><span>Timeframe</span><select data-f="tf">${opt('', F.tf, 'All')}${['1m', '3m', '5m', '15m'].map((x) => opt(x, F.tf, x)).join('')}</select></label>
      <div style="display:flex;align-items:end;gap:8px"><button class="btn" data-act="clear-filters" style="flex:1">Clear</button></div>
      <button class="btn primary wide" data-act="export-csv" ${rows.length ? '' : 'disabled'}>Export CSV (${rows.length})</button>
    </div>
    ${rows.length ? rows.map((r) => `<div class="log ${r.side}"><div class="h"><span class="${r.side === 'CALL' ? 'call' : 'put'}">${r.side} ENTRY</span><span class="mono">${esc(r.time)}</span></div>
      <div class="m">${esc(r.date)} · ${esc(r.market)} ${esc(r.timeframe)} · CMP ${num(r.cmp)} · DEMA ${num(r.dema)}</div>
      <div class="m">RSI1 ${f2(r.rsi1)} / SMA1 ${f2(r.sma1)} · RSI2 ${f2(r.rsi2)} / SMA2 ${f2(r.sma2)}</div>
      <div class="m">${esc(r.sequence || '')}</div>
      ${r.oi != null || r.iv != null || r.l20Imbalance != null ? `<div class="m">OI ${compact(r.oi)} (Δ ${compact(r.changeOi)}) · Vol ${compact(r.volume)} · IV ${r.iv ? r.iv.toFixed(1) : '–'} · L20 ${r.l20Imbalance != null ? (r.l20Imbalance * 100).toFixed(0) + '%' : '–'}</div>` : ''}
      <button class="btn sm warn" data-del="${esc(r.id)}">Delete</button></div>`).join('')
      : `<div class="card note">${L.length ? 'No entries match these filters.' : 'No entries yet. Every CALL/PUT ENTRY is saved here on this device.'}</div>`}`;
  $('logcount').textContent = L.length ? String(L.length) : '';
  if (keepFocus) { const n = el.querySelector(`[data-f="${keepFocus}"]`); if (n && n.tagName === 'INPUT') { n.focus(); const l = n.value.length; try { n.setSelectionRange(l, l); } catch { /* date input */ } } }
}

// ---------- settings ----------
const fld = (path, label, type, val, extra = '') => `<label class="f"><span>${label}</span><input data-path="${path}" type="${type}" value="${esc(val)}" ${type === 'number' ? 'inputmode="decimal" step="any"' : ''} ${extra}></label>`;
const sel = (path, label, val, opts) => `<label class="f"><span>${label}</span><select data-path="${path}">${opts.map(([v, l]) => `<option value="${v}" ${String(val) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
const chk = (path, label, val) => `<label class="chk"><input type="checkbox" data-path="${path}" ${val ? 'checked' : ''}>${label}</label>`;
const rsiBlock = (k, s, title) => `<div class="card"><h2>${title}</h2><div class="fields"><div class="row">${fld(k + '.len', 'Length', 'number', s[k].len)}${sel(k + '.smaType', 'Smoothing', s[k].smaType, [['SMA', 'SMA'], ['EMA', 'EMA']])}${fld(k + '.smaLen', 'Smooth length', 'number', s[k].smaLen)}</div>
  <div class="row">${fld(k + '.oversold', 'Oversold', 'number', s[k].oversold)}${fld(k + '.middle', 'Middle', 'number', s[k].middle)}${fld(k + '.overbought', 'Overbought', 'number', s[k].overbought)}</div></div></div>`;

export function renderSettings(S) {
  const s = S.cfg;
  $('view-settings').innerHTML = `
    <div class="card"><h2>Backend</h2><div class="fields">
      ${fld('backendUrl', 'Render backend URL (only one)', 'url', s.backendUrl, 'placeholder="https://your-backend.onrender.com" autocapitalize="off" autocomplete="off"')}
      ${fld('apiKey', 'Access key (only if API_KEY is set on the server)', 'password', s.apiKey, 'autocomplete="off"')}
      <div class="btns"><button class="btn sm" data-act="diag">Check backend health</button></div><pre class="diag" id="diag"></pre></div></div>
    <div class="card"><h2>Market</h2><div class="row two">${sel('market', 'Index', s.market, [['NIFTY', 'NIFTY'], ['SENSEX', 'SENSEX']])}${sel('tf', 'Timeframe', s.tf, [[1, '1 minute'], [3, '3 minutes'], [5, '5 minutes'], [15, '15 minutes']])}</div></div>
    ${rsiBlock('rsi1', s, 'RSI 1 (setup stage → READY)')}${rsiBlock('rsi2', s, 'RSI 2 (confirmation stage → ENTRY)')}
    <div class="card"><h2>DEMA</h2>${fld('dema.len', 'Length', 'number', s.dema.len)}</div>
    <div class="card"><h2>Sequence rules</h2><div class="fields">
      ${sel('sync', 'If RSI2 finishes before RSI1 is READY', s.sync, [['retain', 'Keep it (ENTRY fires when RSI1 completes)'], ['strict', 'Discard it (RSI2 must start after READY)']])}
      <div class="row two">${fld('sequenceTimeout', 'Max candles per stage (0 = off)', 'number', s.sequenceTimeout)}${fld('readyTimeout', 'Max candles READY waits (0 = off)', 'number', s.readyTimeout)}</div>
      ${chk('restartOnNewExtreme', 'Restart a half-done stage on a new dip / spike', s.restartOnNewExtreme)}
      ${chk('relaxedOrder', 'Accept “already above SMA / 50” for those two steps', s.relaxedOrder)}
      <div class="note">Defaults follow the spec exactly: a fresh cross is required for each step.</div></div></div>
    <div class="card"><h2>Alerts</h2><div class="fields">
      ${chk('alerts.sound', 'Beep', s.alerts.sound)}${chk('alerts.vibrate', 'Vibrate', s.alerts.vibrate)}${chk('alerts.notify', 'Notification', s.alerts.notify)}${chk('alerts.push', 'Web Push (via backend)', s.alerts.push)}${chk('alerts.keepAwake', 'Keep screen awake while open', s.alerts.keepAwake)}
      ${fld('alerts.volume', 'Beep volume (0.1 to 1)', 'number', s.alerts.volume)}
      <button class="btn primary" data-act="enable-alerts">Enable sound, notifications and push</button>
      <div class="btns"><button class="btn sm" data-act="test-ready">Test READY</button><button class="btn sm" data-act="test-entry-call">Test CALL ENTRY</button><button class="btn sm" data-act="test-entry-put">Test PUT ENTRY</button><button class="btn sm" data-act="test-push">Send test push</button></div>
      <div class="note" id="alert-state">Notifications: ${notifyState()}</div></div></div>
    <div class="btns"><button class="btn primary" data-act="save">Save and apply</button><button class="btn warn" data-act="reset">Reset to defaults</button></div>
    <div class="note">Strategy runs in this app, so alerts need it open (screen on or app in the background). Version 1.0.0</div>`;
}

export function readSettings(base) {
  const s = structuredClone(base);
  document.querySelectorAll('#view-settings [data-path]').forEach((el) => {
    const path = el.dataset.path.split('.');
    let o = s; for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
    const k = path[path.length - 1];
    if (el.type === 'checkbox') o[k] = el.checked;
    else if (el.type === 'number') { const v = parseFloat(el.value); o[k] = Number.isFinite(v) ? v : base_get(base, path); }
    else if (k === 'tf') o[k] = parseInt(el.value, 10);
    else o[k] = el.value.trim();
  });
  s.rsi1.len = Math.max(2, Math.round(s.rsi1.len)); s.rsi2.len = Math.max(2, Math.round(s.rsi2.len));
  s.rsi1.smaLen = Math.max(2, Math.round(s.rsi1.smaLen)); s.rsi2.smaLen = Math.max(2, Math.round(s.rsi2.smaLen)); s.dema.len = Math.max(2, Math.round(s.dema.len));
  s.sequenceTimeout = Math.max(0, Math.round(s.sequenceTimeout)); s.readyTimeout = Math.max(0, Math.round(s.readyTimeout));
  s.alerts.volume = Math.min(1, Math.max(0.1, s.alerts.volume));
  return s;
}
function base_get(base, path) { return path.reduce((o, k) => o?.[k], base); }
