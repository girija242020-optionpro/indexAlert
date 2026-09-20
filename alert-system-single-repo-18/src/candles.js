import { bucketStart, inSession, istDateTimeStr } from './time.js';
import { config, log } from './config.js';

/** 1-minute candle store built from spot ticks (+ Dhan intraday history). Higher timeframes are aggregated on read. */
export class CandleStore {
  constructor(max = 6000) { this.max = max; this.m = new Map(); }
  arr(sym) { let a = this.m.get(sym); if (!a) { a = []; this.m.set(sym, a); } return a; }

  ingest(sym, tsMs, price) {
    const sec = Math.floor(tsMs / 1000);
    if (!inSession(sec) || !(price > 0)) return;
    const t = bucketStart(sec, 60);
    const a = this.arr(sym);
    const last = a[a.length - 1];
    if (last && last.t === t) {
      if (price > last.h) last.h = price;
      if (price < last.l) last.l = price;
      last.c = price;
    } else if (!last || t > last.t) {
      a.push({ t, o: price, h: price, l: price, c: price });
      if (a.length > this.max) a.splice(0, a.length - this.max);
    }
  }

  /** Merge history: history wins for finished minutes; the live (tick-built) current minute is kept. */
  seed(sym, hist, nowMs = Date.now()) {
    const curMin = bucketStart(Math.floor(nowMs / 1000), 60);
    const map = new Map(this.arr(sym).map((c) => [c.t, c]));
    for (const h of hist) {
      if (h.t < curMin || !map.has(h.t)) map.set(h.t, h);
    }
    const merged = [...map.values()].sort((x, y) => x.t - y.t);
    this.m.set(sym, merged.slice(-this.max));
  }

  count(sym) { return (this.m.get(sym) || []).length; }

  get(sym, tfMin, limit, nowMs = Date.now()) {
    const tf = tfMin * 60;
    const nowSec = Math.floor(nowMs / 1000);
    const groups = [];
    for (const c of this.m.get(sym) || []) {
      const b = bucketStart(c.t, tf);
      const g = groups[groups.length - 1];
      if (g && g.t === b) { if (c.h > g.h) g.h = c.h; if (c.l < g.l) g.l = c.l; g.c = c.c; }
      else groups.push({ t: b, o: c.o, h: c.h, l: c.l, c: c.c });
    }
    let forming = null;
    const last = groups[groups.length - 1];
    if (last && last.t + tf > nowSec) forming = groups.pop();
    return { candles: groups.slice(-limit), forming };
  }

  dayStats(sym, nowMs = Date.now()) {
    const today = istDateTimeStr(nowMs).slice(0, 10);
    const rows = (this.m.get(sym) || []).filter((c) => istDateTimeStr(c.t * 1000).slice(0, 10) === today);
    if (!rows.length) return null;
    return { open: rows[0].o, high: Math.max(...rows.map((r) => r.h)), low: Math.min(...rows.map((r) => r.l)) };
  }
}

/** Dhan timestamps have been seen both as UNIX epoch and as IST-shifted epoch. Detect which by session-hour fit. */
function detectOffset(ts) {
  let best = 0, bestScore = -1;
  for (const off of [0, -19800, 19800]) {
    let ok = 0;
    for (const t of ts) if (inSession(t + off)) ok++;
    if (ok > bestScore) { bestScore = ok; best = off; }
  }
  return best;
}

export async function fetchHistory(auth, market, days = 10) {
  const now = Date.now();
  const body = {
    securityId: market.securityId,
    exchangeSegment: market.segment,
    instrument: 'INDEX',
    interval: '1',
    fromDate: istDateTimeStr(now - days * 86400000).slice(0, 10) + ' 09:15:00',
    toDate: istDateTimeStr(now).slice(0, 19),
  };
  const r = await fetch(`${config.dhan.apiBase}/charts/intraday`, {
    method: 'POST', headers: auth.headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !Array.isArray(d.timestamp)) throw new Error(`intraday history ${market.symbol}: ${d.errorMessage || d.message || d.errorCode || r.status}`);
  const off = detectOffset(d.timestamp);
  const out = [];
  for (let i = 0; i < d.timestamp.length; i++) {
    const t = bucketStart(Math.round(d.timestamp[i]) + off, 60);
    if (!inSession(t)) continue;
    out.push({ t, o: +d.open[i], h: +d.high[i], l: +d.low[i], c: +d.close[i] });
  }
  log(`history ${market.symbol}: ${out.length} 1m candles (ts offset ${off}s)`);
  return out;
}
