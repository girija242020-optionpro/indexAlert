import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { parseFeed, parseDepth, SEG_CODE, DISCONNECT_REASON } from './parser.js';
import { marketHours } from './time.js';
import { log, warn } from './config.js';

export class Registry {
  constructor() { this.byKey = new Map(); }
  add(info) { this.byKey.set(`${info.segment}:${info.securityId}`, info); }
  get(key) { return this.byKey.get(key) || null; }
  bySymbol(sym) { for (const v of this.byKey.values()) if (v.symbol === sym) return v; return null; }
}

/** Shared reconnect / watchdog logic for both Dhan sockets. */
class BaseFeed extends EventEmitter {
  constructor(name, auth, cfg) {
    super();
    Object.assign(this, { name, auth, cfg });
    this.ws = null; this.state = 'IDLE'; this.lastPacketAt = 0; this.connectedAt = 0; this.lastError = null;
    this.attempts = 0; this.reconnects = 0; this.timer = null; this.watch = null; this.stopped = true; this.msgCount = 0; this.lastClose = null;
  }
  get isOpen() { return this.state === 'OPEN'; }
  url() { throw new Error('not implemented'); }
  hasWork() { return true; }
  onOpen() {}
  onMessage() {}
  start() {
    this.stopped = false;
    this.watch = setInterval(() => this._watch(), 5000);
    this._schedule(0);
  }
  stop() {
    this.stopped = true; clearTimeout(this.timer); clearInterval(this.watch);
    try { this.ws?.terminate(); } catch { /* ignore */ }
  }
  _schedule(ms) { clearTimeout(this.timer); this.timer = setTimeout(() => this._connect(), ms); }
  _backoff() { return Math.min(30000, 1000 * 2 ** Math.min(this.attempts, 5)) + Math.random() * 500; }

  _connect() {
    if (this.stopped) return;
    if (!this.hasWork()) { this.state = 'IDLE'; return this._schedule(5000); }
    if (!this.auth.ok) { this.state = 'AUTH_WAIT'; this.lastError = 'waiting for a valid Dhan access token'; return this._schedule(5000); }
    this.state = 'CONNECTING';
    let ws;
    try { ws = new WebSocket(this.url(), { handshakeTimeout: 10000 }); }
    catch (e) { this.lastError = e.message; this.attempts++; return this._schedule(this._backoff()); }
    this.ws = ws;
    ws.on('open', () => {
      this.state = 'OPEN'; this.connectedAt = Date.now(); this.lastPacketAt = Date.now(); this.attempts = 0; this.lastError = null;
      log(`${this.name} feed connected`);
      try { this.onOpen(); } catch (e) { this.lastError = 'onOpen: ' + e.message; }
      this.emit('open');
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return; // Dhan feeds are binary; text frames are ignored
      this.lastPacketAt = Date.now(); this.msgCount++;
      try { this.onMessage(Buffer.isBuffer(data) ? data : Buffer.concat(data)); } catch (e) { this.lastError = 'parse: ' + e.message; }
    });
    ws.on('unexpected-response', (_req, res) => {
      this.lastError = `HTTP ${res.statusCode} while connecting`;
      if ([400, 401, 403].includes(res.statusCode)) this.auth.invalidate(`${this.name} feed HTTP ${res.statusCode}`);
      res.resume(); ws.terminate();
    });
    ws.on('error', (e) => { this.lastError = e.message; });
    ws.on('close', (code) => {
      if (this.ws === ws) this.ws = null;
      this.state = 'CLOSED'; this.lastClose = { code, at: Date.now() };
      warn(`${this.name} feed closed (${code})`);
      this.emit('close', code);
      if (!this.stopped) { this.attempts++; this.reconnects++; this._schedule(this._backoff()); }
    });
  }

  _watch() {
    if (!this.isOpen || !this.ws || !this.hasWork()) return;
    const now = Date.now();
    if (marketHours(now) && now - this.lastPacketAt > this.cfg.packetTimeoutMs) {
      this.lastError = `no data packets for ${Math.round((now - this.lastPacketAt) / 1000)}s: reconnecting`;
      warn(this.name, this.lastError);
      this.ws.terminate();
    }
  }
  _sendJson(o) { if (this.isOpen && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o)); }
}

const SUB = { ticker: 15, quote: 17, full: 21 };
const UNSUB = { ticker: 16, quote: 18, full: 22 };

/** Dhan Live Market Feed v2: normalises binary packets into tick objects. */
export class MarketFeed extends BaseFeed {
  constructor(auth, cfg, dhanCfg, registry) {
    super('market', auth, cfg);
    this.dhan = dhanCfg; this.registry = registry;
    this.want = new Map();       // key -> {segment, securityId, mode}
    this.inst = new Map();       // key -> merged instrument state
    this.confirmed = new Map();  // key -> first packet ts (subscription confirmation)
    this.lastDisconnect = null;
  }
  url() {
    return `${this.dhan.feedUrl}?version=2&token=${encodeURIComponent(this.auth.token)}&clientId=${encodeURIComponent(this.auth.clientId)}&authType=2`;
  }
  hasWork() { return this.want.size > 0; }
  key(i) { return `${i.segment}:${i.securityId}`; }

  subscribe(items) {
    const fresh = [];
    for (const i of items) {
      const k = this.key(i);
      const rec = { segment: i.segment, securityId: String(i.securityId), mode: i.mode || 'ticker' };
      if (!SEG_CODE.hasOwnProperty(rec.segment)) throw new Error('unknown exchange segment ' + rec.segment);
      if (!this.want.has(k)) fresh.push(rec);
      this.want.set(k, rec);
    }
    this._send(fresh);
    if (this.state === 'IDLE') this._schedule(0);
  }
  unsubscribe(items) {
    for (const i of items) {
      const k = this.key(i); const rec = this.want.get(k);
      if (!rec) continue;
      this.want.delete(k); this.confirmed.delete(k); this.inst.delete(k);
      this._sendJson({ RequestCode: UNSUB[rec.mode], InstrumentCount: 1, InstrumentList: [{ ExchangeSegment: rec.segment, SecurityId: rec.securityId }] });
    }
  }
  _send(list) {
    if (!this.isOpen || !list.length) return;
    for (const mode of Object.keys(SUB)) {
      const g = list.filter((x) => x.mode === mode);
      for (let i = 0; i < g.length; i += 100) {
        const c = g.slice(i, i + 100);
        this._sendJson({ RequestCode: SUB[mode], InstrumentCount: c.length, InstrumentList: c.map((x) => ({ ExchangeSegment: x.segment, SecurityId: x.securityId })) });
      }
    }
  }
  onOpen() { this.confirmed.clear(); this._send([...this.want.values()]); }
  subscriptions() {
    return [...this.want.entries()].map(([k, v]) => ({ key: k, ...v, label: this.registry.get(k)?.symbol || null, confirmed: this.confirmed.has(k), firstPacketAt: this.confirmed.get(k) || null }));
  }

  onMessage(buf) { for (const p of parseFeed(buf)) this._packet(p); }

  _packet(p) {
    const key = `${p.segment}:${p.securityId}`;
    if (p.code === 50) {
      const reason = DISCONNECT_REASON[p.disconnectCode] || 'unknown reason';
      this.lastDisconnect = { code: p.disconnectCode, reason, at: Date.now() };
      this.lastError = `Dhan disconnect ${p.disconnectCode}: ${reason}`;
      warn(this.lastError);
      if ([807, 808, 809].includes(p.disconnectCode)) this.auth.invalidate('feed disconnect ' + p.disconnectCode);
      this.emit('disconnect', this.lastDisconnect);
      return;
    }
    if (p.code === 7) return; // market status packet
    const info = this.registry.get(key);
    let s = this.inst.get(key);
    if (!s) { s = {}; this.inst.set(key, s); }
    if (!this.confirmed.has(key)) { this.confirmed.set(key, Date.now()); this.emit('confirmed', key, info); }
    switch (p.code) {
      case 1: case 2: s.ltp = p.ltp; s.ltt = p.ltt; break;
      case 4: Object.assign(s, { ltp: p.ltp, ltt: p.ltt, atp: p.atp, volume: p.volume, sellQty: p.sellQty, buyQty: p.buyQty, dayOpen: p.dayOpen, dayClose: p.dayClose, dayHigh: p.dayHigh, dayLow: p.dayLow }); break;
      case 5: s.oi = p.oi; break;
      case 6: s.prevClose = p.prevClose; s.prevOi = p.prevOi; break;
      case 8: Object.assign(s, { ltp: p.ltp, ltt: p.ltt, atp: p.atp, volume: p.volume, sellQty: p.sellQty, buyQty: p.buyQty, oi: p.oi, dayOpen: p.dayOpen, dayClose: p.dayClose, dayHigh: p.dayHigh, dayLow: p.dayLow }); break;
      default: return;
    }
    if (p.code === 8 && p.depth) this.emit('depth5', { key, info, securityId: p.securityId, segment: p.segment, depth: p.depth });
    if (![1, 2, 4, 8].includes(p.code) && !(s.ltp > 0)) return;
    if (!(s.ltp > 0) || !Number.isFinite(s.ltp)) return;
    const now = Date.now();
    this.emit('tick', {
      symbol: info?.symbol || key, underlying: info?.underlying || null, role: info?.role || 'other',
      securityId: p.securityId, segment: p.segment,
      timestamp: new Date(now).toISOString(), ts: now, ltt: s.ltt ?? null,
      ltp: +s.ltp.toFixed(2), volume: s.volume ?? null, oi: s.oi ?? null,
      changeOi: s.oi != null && s.prevOi != null ? s.oi - s.prevOi : null,
      dayOpen: s.dayOpen > 0 ? s.dayOpen : null, dayHigh: s.dayHigh > 0 ? s.dayHigh : null, dayLow: s.dayLow > 0 ? s.dayLow : null,
      dayClose: s.dayClose > 0 ? s.dayClose : null, prevClose: s.prevClose ?? null,
      buyQuantity: s.buyQty ?? null, sellQuantity: s.sellQty ?? null, atp: s.atp ?? null,
    });
  }
}

/** Dhan Full Market Depth (20 levels). NSE equity/derivatives only, up to 50 instruments per connection. */
export class DepthFeed extends BaseFeed {
  constructor(auth, cfg, dhanCfg, registry) {
    super('depth', auth, cfg);
    this.dhan = dhanCfg; this.registry = registry;
    this.want = new Map(); this.books = new Map(); this.lastDepthAt = 0;
  }
  url() { return `${this.dhan.depthUrl}?token=${encodeURIComponent(this.auth.token)}&clientId=${encodeURIComponent(this.auth.clientId)}&authType=2`; }
  hasWork() { return this.want.size > 0; }

  ensure(item, pinned = false) {
    const key = `${item.segment}:${item.securityId}`;
    if (!['NSE_EQ', 'NSE_FNO'].includes(item.segment)) throw new Error('20-level depth is only offered for NSE_EQ / NSE_FNO');
    const ex = this.want.get(key);
    if (ex) { ex.touched = Date.now(); ex.pinned = ex.pinned || pinned; return; }
    if (this.want.size >= this.cfg.maxDepthInstruments) {
      const victim = [...this.want.entries()].filter(([, v]) => !v.pinned).sort((a, b) => a[1].touched - b[1].touched)[0];
      if (!victim) throw new Error('depth subscription limit reached');
      this.want.delete(victim[0]); this.books.delete(victim[1].securityId);
      this._sendJson({ RequestCode: 25, InstrumentCount: 1, InstrumentList: [{ ExchangeSegment: victim[1].segment, SecurityId: victim[1].securityId }] });
    }
    const rec = { segment: item.segment, securityId: String(item.securityId), pinned, touched: Date.now() };
    this.want.set(key, rec);
    this._sendJson({ RequestCode: 23, InstrumentCount: 1, InstrumentList: [{ ExchangeSegment: rec.segment, SecurityId: rec.securityId }] });
    if (this.state === 'IDLE') this._schedule(0);
  }
  onOpen() {
    const all = [...this.want.values()];
    for (let i = 0; i < all.length; i += 50) {
      const c = all.slice(i, i + 50);
      this._sendJson({ RequestCode: 23, InstrumentCount: c.length, InstrumentList: c.map((x) => ({ ExchangeSegment: x.segment, SecurityId: x.securityId })) });
    }
  }
  book(securityId) { return this.books.get(String(securityId)) || null; }

  onMessage(buf) {
    const touched = new Set();
    for (const p of parseDepth(buf)) {
      if (p.side === 'unknown') continue;
      const id = p.securityId;
      let b = this.books.get(id);
      if (!b) { b = { securityId: id, segment: p.segment, bids: [], asks: [], ts: 0 }; this.books.set(id, b); }
      if (p.side === 'bid') b.bids = p.levels; else b.asks = p.levels;
      b.ts = Date.now(); this.lastDepthAt = b.ts;
      touched.add(id);
    }
    for (const id of touched) this.emit('depth', this.normalise(id));
  }

  normalise(id) {
    const b = this.books.get(String(id));
    if (!b) return null;
    const info = this.registry.get(`${b.segment}:${b.securityId}`);
    const totalBid = b.bids.reduce((s, x) => s + x.quantity, 0);
    const totalAsk = b.asks.reduce((s, x) => s + x.quantity, 0);
    return {
      symbol: info?.symbol || null, underlying: info?.underlying || null, securityId: b.securityId, segment: b.segment, levels: Math.max(b.bids.length, b.asks.length),
      bids: b.bids, asks: b.asks, totalBid, totalAsk, imbalance: totalBid + totalAsk ? (totalBid - totalAsk) / (totalBid + totalAsk) : 0,
      ts: b.ts, timestamp: new Date(b.ts).toISOString(), source: '20-level',
    };
  }
}
