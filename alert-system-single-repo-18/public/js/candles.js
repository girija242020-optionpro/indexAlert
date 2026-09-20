// Tick -> candle aggregation for the selected timeframe. Buckets align to 09:15 IST (same maths as the backend).
const BASE = 13500, OFF = 19800;
export const bucketStart = (sec, tf) => Math.floor((sec - BASE) / tf) * tf + BASE;
export const inSession = (sec) => { const s = (((sec + OFF) % 86400) + 86400) % 86400; return s >= 33300 && s < 55800; };
const GRACE_MS = 1500; // wait briefly after the boundary for in-flight ticks before closing by clock

export class CandleBuilder {
  constructor(tfSec) { this.tf = tfSec; this.cur = null; this.lastClosedT = -Infinity; }
  /** Seed with the (partial) forming candle from the backend so a mid-candle start is still exact. */
  seed(c, lastClosedT) { this.cur = c ? { ...c } : null; if (lastClosedT != null) this.lastClosedT = lastClosedT; }
  /** Returns a CLOSED candle when the tick rolls into a new bucket. */
  ingest(tsMs, price) {
    const sec = Math.floor(tsMs / 1000);
    if (!inSession(sec) || !(price > 0)) return null;
    const t = bucketStart(sec, this.tf);
    if (t <= this.lastClosedT) return null; // late tick for a candle we already closed
    if (!this.cur) { this.cur = { t, o: price, h: price, l: price, c: price }; return null; }
    if (t === this.cur.t) { if (price > this.cur.h) this.cur.h = price; if (price < this.cur.l) this.cur.l = price; this.cur.c = price; return null; }
    if (t > this.cur.t) {
      const closed = this.cur; this.lastClosedT = closed.t;
      this.cur = { t, o: price, h: price, l: price, c: price };
      return closed;
    }
    return null;
  }
  /** Close by the clock when no tick arrives right after the boundary. */
  flush(nowMs) {
    if (this.cur && nowMs >= (this.cur.t + this.tf) * 1000 + GRACE_MS) {
      const c = this.cur; this.cur = null; this.lastClosedT = c.t; return c;
    }
    return null;
  }
}
