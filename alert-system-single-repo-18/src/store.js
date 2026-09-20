import { EventEmitter } from 'node:events';
import { CandleStore } from './candles.js';
import { marketHours, inSession, istDateStr } from './time.js';

/** In-memory market state: latest ticks, short tick history, depth books, minute candles, day stats. */
export class MarketStore extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.latest = new Map();     // symbol -> tick
    this.rings = new Map();      // symbol -> tick[]
    this.depth = new Map();      // securityId -> depth book (20 or 5 levels)
    this.candles = new CandleStore();
    this.lastTickAt = new Map(); // spot symbol -> receive ts
    this.day = new Map();        // spot symbol -> {date, open, high, low}
    this.anyTickAt = 0;
  }

  ingestTick(t) {
    this.latest.set(t.symbol, t);
    let r = this.rings.get(t.symbol);
    if (!r) { r = []; this.rings.set(t.symbol, r); }
    r.push({ ts: t.ts, ltp: t.ltp, volume: t.volume, oi: t.oi });
    if (r.length > 600) r.splice(0, r.length - 600);
    if (t.role === 'spot') {
      this.lastTickAt.set(t.symbol, t.ts);
      this.anyTickAt = t.ts;
      this.candles.ingest(t.symbol, t.ts, t.ltp);
      if (inSession(Math.floor(t.ts / 1000))) {
        const date = istDateStr(t.ts);
        let d = this.day.get(t.symbol);
        if (!d || d.date !== date) { d = { date, open: t.ltp, high: t.ltp, low: t.ltp }; this.day.set(t.symbol, d); }
        d.high = Math.max(d.high, t.ltp); d.low = Math.min(d.low, t.ltp);
      }
      const d = this.day.get(t.symbol);
      if (d) { t.dayOpen ??= d.open; t.dayHigh = t.dayHigh > 0 ? t.dayHigh : d.high; t.dayLow = t.dayLow > 0 ? t.dayLow : d.low; }
    }
    this.emit('tick', t);
  }

  ingestDepth(book) {
    this.depth.set(book.securityId, book);
    this.emit('depth', book);
  }

  /** LIVE / STALE / OFFLINE / CLOSED for one spot symbol. LIVE only if a real tick arrived within staleMs. */
  symbolState(symbol, wsOpen, now = Date.now()) {
    const at = this.lastTickAt.get(symbol) || 0;
    const age = at ? now - at : null;
    let state;
    if (age !== null && age <= this.cfg.staleMs) state = 'LIVE';
    else if (!marketHours(now)) state = 'CLOSED';
    else if (!wsOpen) state = 'OFFLINE';
    else state = 'STALE';
    return { state, lastTickAt: at || null, lastTick: at ? new Date(at).toISOString() : null, ageMs: age };
  }
}
