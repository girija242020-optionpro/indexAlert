import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config, MARKETS, log, warn } from './config.js';
import { DhanAuth } from './auth.js';
import { Registry, MarketFeed, DepthFeed } from './feed.js';
import { MarketStore } from './store.js';
import { Instruments } from './instruments.js';
import { ChainService } from './chain.js';
import { PushService } from './push.js';
import { fetchHistory } from './candles.js';
import { marketHours } from './time.js';

const startedAt = Date.now();
const auth = new DhanAuth(config.dhan);
const registry = new Registry();
const store = new MarketStore(config.feed);
const instruments = new Instruments();
const marketFeed = new MarketFeed(auth, config.feed, config.dhan, registry);
const depthFeed = new DepthFeed(auth, config.feed, config.dhan, registry);
const chain = new ChainService(auth, MARKETS, instruments, store);
const push = new PushService();
const futState = {}; // symbol -> {securityId, segment, expiry, symbol, lot}
const hist = Object.fromEntries(Object.keys(MARKETS).map((s) => [s, { at: 0, ok: false, error: null }]));
const errors = [];
const noteError = (m) => { errors.unshift({ at: new Date().toISOString(), message: String(m).slice(0, 300) }); errors.length = Math.min(errors.length, 15); };

// ---------- wiring ----------
for (const m of Object.values(MARKETS)) registry.add({ symbol: m.symbol, underlying: m.symbol, role: 'spot', securityId: m.securityId, segment: m.segment });
const modeFromCode = { 15: 'ticker', 17: 'quote', 21: 'full' };
marketFeed.subscribe(Object.values(MARKETS).map((m) => ({ segment: m.segment, securityId: m.securityId, mode: modeFromCode[config.feed.indexSubCode] || 'ticker' })));

marketFeed.on('tick', (t) => store.ingestTick(t));
marketFeed.on('depth5', ({ info, securityId, segment, depth }) => {
  const fresh = depthFeed.book(securityId);
  if (fresh && Date.now() - fresh.ts < 5000) return; // real 20-level data wins
  const bids = depth.filter((d) => d.bidPrice > 0).map((d) => ({ price: d.bidPrice, quantity: d.bidQty, orders: d.bidOrders }));
  const asks = depth.filter((d) => d.askPrice > 0).map((d) => ({ price: d.askPrice, quantity: d.askQty, orders: d.askOrders }));
  const totalBid = bids.reduce((s, x) => s + x.quantity, 0), totalAsk = asks.reduce((s, x) => s + x.quantity, 0);
  store.ingestDepth({ symbol: info?.symbol || null, underlying: info?.underlying || null, securityId, segment, levels: 5, bids, asks, totalBid, totalAsk, imbalance: totalBid + totalAsk ? (totalBid - totalAsk) / (totalBid + totalAsk) : 0, ts: Date.now(), timestamp: new Date().toISOString(), source: '5-level' });
});
depthFeed.on('depth', (b) => store.ingestDepth(b));
marketFeed.on('disconnect', (d) => noteError(`Dhan disconnect ${d.code}: ${d.reason}`));
marketFeed.on('open', () => { for (const s of Object.keys(MARKETS)) seedHistory(s).catch(() => {}); }); // back-fill any gap after (re)connects

async function seedHistory(sym, force = false) {
  const h = hist[sym];
  if (!auth.ok || Date.now() - h.at < (force ? 15000 : 60000)) return;
  h.at = Date.now();
  try {
    store.candles.seed(sym, await fetchHistory(auth, MARKETS[sym]));
    h.ok = true; h.error = null;
  } catch (e) { h.error = e.message; warn('history:', e.message); noteError(e.message); }
}
setInterval(() => { for (const s of Object.keys(MARKETS)) if (!hist[s].ok) seedHistory(s).catch(() => {}); }, 30000).unref();

async function refreshFutures() {
  for (const [sym, m] of Object.entries(MARKETS)) {
    let f = null;
    if (config.futOverride[sym]) f = { securityId: config.futOverride[sym], segment: m.futSegment, expiry: 'override', symbol: `${sym}-FUT` };
    else { const n = instruments.nearFuture(sym); if (n) f = n; }
    if (!f) continue;
    const prev = futState[sym];
    if (prev?.securityId === f.securityId) continue;
    if (prev) marketFeed.unsubscribe([{ segment: prev.segment, securityId: prev.securityId }]);
    futState[sym] = f;
    registry.add({ symbol: `${sym}-FUT`, underlying: sym, role: 'future', securityId: f.securityId, segment: f.segment });
    marketFeed.subscribe([{ segment: f.segment, securityId: f.securityId, mode: 'full' }]);
    if (config.depthMarkets.includes(sym) && f.segment === 'NSE_FNO') depthFeed.ensure({ segment: f.segment, securityId: f.securityId }, true);
    log(`future ${sym}: ${f.symbol} (${f.securityId}) exp ${f.expiry}`);
  }
}
async function loadInstruments() {
  try { await instruments.load(); await refreshFutures(); }
  catch (e) { instruments.error = e.message; noteError('instrument master: ' + e.message); warn('instrument master:', e.message); setTimeout(loadInstruments, 60000).unref(); }
}
setInterval(() => refreshFutures().catch(() => {}), 10 * 60000).unref();
setInterval(loadInstruments, 12 * 3600000).unref();
const resolveDepthId = (x) => (MARKETS[String(x).toUpperCase()] ? futState[String(x).toUpperCase()]?.securityId : String(x));

// ---------- status ----------
function summary() {
  const now = Date.now();
  const symbols = {};
  for (const s of Object.keys(MARKETS)) symbols[s] = store.symbolState(s, marketFeed.isOpen, now);
  const st = Object.values(symbols).map((x) => x.state);
  const state = st.includes('LIVE') ? 'LIVE' : st.includes('STALE') ? 'STALE' : st.includes('OFFLINE') ? 'OFFLINE' : 'CLOSED';
  const depthFresh = depthFeed.lastDepthAt && now - depthFeed.lastDepthAt <= Math.max(config.feed.staleMs, 20000);
  return { state, symbols, marketOpen: marketHours(now), depthFresh: !!depthFresh, now };
}

// ---------- http ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
const allowAll = config.allowedOrigins.includes('*');
const sameHost = (o, host) => { try { return !!host && new URL(o).host === host; } catch { return false; } };
const originOk = (o, host) => !o || allowAll || config.allowedOrigins.includes(o) || sameHost(o, host); // same-host = PWA served by this backend
const keyOk = (k) => {
  if (!config.apiKey) return true;
  const a = Buffer.from(String(k || '')), b = Buffer.from(config.apiKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && originOk(o, req.headers.host)) { res.setHeader('Access-Control-Allow-Origin', allowAll ? '*' : o); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.get('/healthz', (_q, r) => r.type('text/plain').send('ok')); // unauthenticated liveness probe for Render
// Single-repo mode: if ./public/index.html exists (the PWA), this same service serves it, so one URL does everything.
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
if (fs.existsSync(path.join(publicDir, 'index.html'))) {
  app.use(express.static(publicDir, { setHeaders: (res, p) => {
    if (p.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    if (p.endsWith('manifest.json')) res.setHeader('Content-Type', 'application/manifest+json');
  } }));
} else app.get('/', (_q, r) => r.type('text/plain').send('Dhan alert backend. Data provider + push bridge. See /api/health'));

const hits = new Map();
const limit = (n, windowMs = 60000) => (req, res, next) => {
  const k = `${req.ip}|${req.path}`, now = Date.now();
  const h = (hits.get(k) || []).filter((t) => now - t < windowMs);
  if (h.length >= n) return res.status(429).json({ error: 'rate limited' });
  h.push(now); hits.set(k, h); next();
};
app.use('/api', (req, res, next) => (keyOk(req.headers['x-api-key']) ? next() : res.status(401).json({ error: 'invalid or missing access key' })));

const symOf = (req) => { const s = String(req.query.symbol || 'NIFTY').toUpperCase(); return MARKETS[s] ? s : null; };
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { noteError(e.message); res.status(502).json({ error: e.message }); });

app.get('/api/health', (_q, res) => {
  const s = summary();
  const notes = [];
  if (!auth.ok) notes.push('Dhan token missing/expired: ' + (auth.lastError || 'not configured'));
  if (marketFeed.lastDisconnect && Date.now() - marketFeed.lastDisconnect.at < 3600000) notes.push(`Dhan said: ${marketFeed.lastDisconnect.code} ${marketFeed.lastDisconnect.reason}`);
  if (!push.enabled) notes.push('Web Push disabled: set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY');
  if (config.depthMarkets.length && !depthFeed.lastDepthAt && marketHours()) notes.push('No 20-level depth received yet');
  if (Object.keys(MARKETS).some((m) => !futState[m])) notes.push('Index future not resolved yet (needed for OI, volume, depth)');
  const newest = Math.max(0, ...Object.values(s.symbols).map((x) => x.lastTickAt || 0));
  res.json({
    server: true, dhanAuthenticated: auth.ok,
    marketFeed: s.state === 'LIVE',            // true only when a real tick arrived within STALE_MS
    depthFeed: s.depthFresh,
    lastTick: newest ? new Date(newest).toISOString() : null,
    stale: s.state === 'STALE',
    state: s.state, marketOpen: s.marketOpen, serverTime: Date.now(), uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    symbols: s.symbols,
    feed: { socket: marketFeed.state, packets: marketFeed.msgCount, reconnects: marketFeed.reconnects, lastError: marketFeed.lastError, subscriptions: marketFeed.subscriptions() },
    depth: { socket: depthFeed.state, packets: depthFeed.msgCount, lastDepthAt: depthFeed.lastDepthAt || null, subscribed: depthFeed.want.size, lastError: depthFeed.lastError },
    auth: auth.status(),
    futures: futState,
    history: hist,
    push: { configured: push.enabled, subscribers: push.count() },
    instruments: { loadedAt: instruments.loadedAt || null, error: instruments.error },
    recentErrors: errors, notes,
  });
});

app.get('/api/state', (_q, res) => {
  const s = summary();
  const ticks = {}; for (const [k, v] of store.latest) ticks[k] = v;
  const day = {}; for (const k of Object.keys(MARKETS)) day[k] = store.day.get(k) || null;
  res.json({ serverTime: Date.now(), status: s, ticks, day, futures: futState, markets: MARKETS });
});

app.get('/api/ticks', (req, res) => {
  const sym = String(req.query.symbol || 'NIFTY').toUpperCase();
  const n = Math.min(+req.query.limit || 200, 600);
  res.json({ symbol: sym, ticks: (store.rings.get(sym) || []).slice(-n) });
});

app.get('/api/candles', wrap(async (req, res) => {
  const sym = symOf(req); if (!sym) return res.status(400).json({ error: 'unknown symbol' });
  const tf = +req.query.tf || 1; if (![1, 3, 5, 15].includes(tf)) return res.status(400).json({ error: 'tf must be 1, 3, 5 or 15' });
  if (store.candles.count(sym) < 40) await seedHistory(sym, true);
  const { candles, forming } = store.candles.get(sym, tf, Math.min(+req.query.limit || 600, 3000));
  res.json({ symbol: sym, tf, serverTime: Date.now(), historyOk: hist[sym].ok, candles, forming });
}));

app.get('/api/depth20/:securityId', (req, res) => {
  const id = resolveDepthId(req.params.securityId);
  if (!id) return res.status(404).json({ error: 'future not resolved yet' });
  let book = depthFeed.book(id) ? depthFeed.normalise(id) : store.depth.get(id) || null;
  if (!book) {
    const seg = String(req.query.segment || 'NSE_FNO');
    try { depthFeed.ensure({ segment: seg, securityId: id }); } catch (e) { return res.status(400).json({ error: e.message }); }
    return res.status(202).json({ pending: true, securityId: id, message: 'subscribed; retry in a few seconds' });
  }
  res.json(book);
});

app.get('/api/expiry-list', wrap(async (req, res) => {
  const sym = symOf(req); if (!sym) return res.status(400).json({ error: 'unknown symbol' });
  res.json({ symbol: sym, expiries: await chain.expiries(sym) });
}));

app.get('/api/option-chain', wrap(async (req, res) => {
  const sym = symOf(req); if (!sym) return res.status(400).json({ error: 'unknown symbol' });
  const data = await chain.chain(sym, req.query.expiry ? String(req.query.expiry) : undefined);
  const w = +req.query.window;
  if (w > 0 && data.atmStrike != null) {
    const i = data.strikes.findIndex((s) => s.strike === data.atmStrike);
    return res.json({ ...data, strikes: data.strikes.slice(Math.max(0, i - w), i + w + 1) });
  }
  res.json(data);
}));

app.post('/api/subscribe', limit(30), (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [req.body];
  if (!items.length || items.length > 50) return res.status(400).json({ error: '1-50 items required' });
  if (marketFeed.want.size + items.length > 200) return res.status(400).json({ error: 'subscription limit reached' });
  try {
    for (const i of items) {
      if (!i?.securityId || !i?.segment) throw new Error('securityId and segment required');
      if (!registry.get(`${i.segment}:${i.securityId}`)) registry.add({ symbol: i.label || `${i.segment}:${i.securityId}`, underlying: null, role: 'other', securityId: String(i.securityId), segment: i.segment });
    }
    marketFeed.subscribe(items.map((i) => ({ segment: i.segment, securityId: i.securityId, mode: ['ticker', 'quote', 'full'].includes(i.mode) ? i.mode : 'quote' })));
    res.json({ ok: true, subscriptions: marketFeed.subscriptions().filter((s) => items.some((i) => s.key === `${i.segment}:${i.securityId}`)) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/vapid-public-key', (_q, res) => {
  if (!push.publicKey) return res.status(503).json({ error: 'VAPID keys not configured on the server' });
  res.json({ publicKey: push.publicKey });
});
app.post('/api/subscribe-push', limit(20), (req, res) => {
  try { res.json({ ok: true, id: push.add(req.body?.subscription, { ua: req.headers['user-agent'] }) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/unsubscribe-push', limit(20), (req, res) => { if (req.body?.id) push.remove(String(req.body.id)); res.json({ ok: true }); });
app.post('/api/test-push', limit(6), wrap(async (req, res) => {
  const r = await push.send({ title: 'Test alert', body: 'Web Push is working.', tag: 'test-' + Date.now(), kind: 'TEST' }, req.body?.id || null);
  res.json(r);
}));
app.post('/api/notify', limit(30), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: 'title required' });
  const payload = { title: String(b.title).slice(0, 80), body: String(b.body || '').slice(0, 300), tag: String(b.tag || b.eventId || 'alert').slice(0, 120), eventId: b.eventId ? String(b.eventId).slice(0, 160) : undefined, kind: b.kind === 'ENTRY' ? 'ENTRY' : 'READY', side: b.side === 'PUT' ? 'PUT' : 'CALL' };
  res.json(await push.notify(payload, b.id ? String(b.id) : null));
}));

// ---------- websocket to the PWA ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();
const bcast = (msg) => {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1 && c.bufferedAmount < 1e6) c.send(s);
};
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/ws') return socket.destroy();
  if (!originOk(req.headers.origin, req.headers.host) || !keyOk(u.searchParams.get('key'))) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});
wss.on('connection', (ws) => {
  ws.isAlive = true; clients.add(ws);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  ws.on('message', (m) => { try { if (JSON.parse(m).type === 'ping') ws.send(JSON.stringify({ type: 'pong', serverTime: Date.now() })); } catch { /* ignore */ } });
  const s = summary();
  ws.send(JSON.stringify({ type: 'hello', serverTime: Date.now(), markets: Object.keys(MARKETS), status: s, ticks: [...store.latest.values()] }));
});
store.on('tick', (t) => bcast({ type: 'tick', ...t }));
const lastDepthSent = new Map();
store.on('depth', (b) => {
  const now = Date.now();
  if (now - (lastDepthSent.get(b.securityId) || 0) < 500) return;
  lastDepthSent.set(b.securityId, now);
  bcast({ type: 'depth', ...b });
});
setInterval(() => { const s = summary(); bcast({ type: 'status', serverTime: s.now, state: s.state, marketOpen: s.marketOpen, symbols: s.symbols, depthFeed: s.depthFresh }); }, 2000).unref();
setInterval(() => { for (const c of clients) { if (!c.isAlive) { c.terminate(); clients.delete(c); continue; } c.isAlive = false; c.ping(); } }, 20000).unref();

// ---------- start ----------
server.listen(config.port, () => {
  log(`server listening on :${config.port}`);
  if (!config.apiKey) warn('API_KEY not set: anyone who finds this URL can read your market data. Set API_KEY.');
  if (allowAll) warn('ALLOWED_ORIGINS=*: restrict it to your Netlify URL once everything works.');
  auth.init().catch((e) => noteError(e.message)).finally(() => {
    marketFeed.start(); depthFeed.start();
    for (const s of Object.keys(MARKETS)) seedHistory(s, true).catch(() => {});
    loadInstruments();
  });
  auth.on('token', () => { for (const s of Object.keys(MARKETS)) if (!hist[s].ok) seedHistory(s, true).catch(() => {}); });
});

const shutdown = () => { log('shutting down'); marketFeed.stop(); depthFeed.stop(); wss.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => { warn('unhandledRejection', e?.message || e); noteError(e?.message || e); });
