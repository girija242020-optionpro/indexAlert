// Strategy engine: indicators + two-stage RSI/DEMA finite state machine.
// Pure functions, no DOM, no network. Runs in the browser and in Node (tests).

export const DEFAULTS = {
  rsi1: { len: 5, smaLen: 14, smaType: 'SMA', oversold: 30, middle: 50, overbought: 70 },
  rsi2: { len: 9, smaLen: 14, smaType: 'EMA', oversold: 30, middle: 50, overbought: 70 },
  dema: { len: 14 },
  sync: 'retain',            // 'retain': RSI2 tracked in parallel and kept until timeout | 'strict': RSI2 only counts after RSI1 is READY
  sequenceTimeout: 30,       // candles allowed from a track's first step to its completion (0 = off)
  readyTimeout: 20,          // candles READY (or a retained RSI2 result) may wait for the other stage (0 = off)
  restartOnNewExtreme: false,// a fresh dip below oversold / above overbought restarts a half-done track
  relaxedOrder: false,       // accept "already above SMA / already above 50" instead of requiring a fresh cross for those steps
};

const isNum = Number.isFinite;
const merge = (a, b) => {
  const o = { ...a };
  for (const k of Object.keys(b || {})) o[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) ? merge(a[k] || {}, b[k]) : b[k];
  return o;
};
export const mergeCfg = (c) => merge(DEFAULTS, c || {});

// ---------- indicators (TradingView-consistent) ----------
export function sma(src, len) {
  const out = new Array(src.length).fill(NaN);
  for (let i = len - 1; i < src.length; i++) {
    let s = 0, ok = true;
    for (let j = i - len + 1; j <= i; j++) { const v = src[j]; if (!isNum(v)) { ok = false; break; } s += v; }
    if (ok) out[i] = s / len;
  }
  return out;
}
// ta.ema: seeded with the SMA of the first `len` valid values, alpha = 2/(len+1)
export function ema(src, len) {
  const n = src.length, out = new Array(n).fill(NaN), a = 2 / (len + 1);
  let f = 0; while (f < n && !isNum(src[f])) f++;
  const seed = f + len - 1;
  if (seed >= n) return out;
  let s = 0; for (let j = f; j <= seed; j++) s += src[j];
  out[seed] = s / len;
  for (let i = seed + 1; i < n; i++) out[i] = a * src[i] + (1 - a) * out[i - 1];
  return out;
}
const rsCalc = (g, l) => (l === 0 ? 100 : g === 0 ? 0 : 100 - 100 / (1 + g / l));
// Wilder RSI = ta.rsi (RMA seeded with the SMA of the first `len` changes)
export function rsi(src, len) {
  const n = src.length, out = new Array(n).fill(NaN);
  if (n <= len) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= len; i++) { const d = src[i] - src[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= len; l /= len;
  out[len] = rsCalc(g, l);
  for (let i = len + 1; i < n; i++) {
    const d = src[i] - src[i - 1];
    g = (g * (len - 1) + (d > 0 ? d : 0)) / len;
    l = (l * (len - 1) + (d < 0 ? -d : 0)) / len;
    out[i] = rsCalc(g, l);
  }
  return out;
}
// DEMA = 2*EMA1 - EMA(EMA1)   (NOT an SMA)
export function dema(src, len) {
  const e1 = ema(src, len), e2 = ema(e1, len);
  return e1.map((v, i) => 2 * v - e2[i]);
}
const smooth = (arr, len, type) => (type === 'EMA' ? ema(arr, len) : sma(arr, len));

export function computeSeries(closes, cfg) {
  const r1 = rsi(closes, cfg.rsi1.len), r2 = rsi(closes, cfg.rsi2.len);
  return {
    rsi1: r1, sma1: smooth(r1, cfg.rsi1.smaLen, cfg.rsi1.smaType),
    rsi2: r2, sma2: smooth(r2, cfg.rsi2.smaLen, cfg.rsi2.smaType),
    dema: dema(closes, cfg.dema.len),
  };
}

// ---------- state machine ----------
export function stepLabels(dir, rc) {
  return dir > 0
    ? [`Below ${rc.oversold}`, `Cross ${rc.oversold} ↑`, `Cross ${rc.smaType} ↑`, `Cross ${rc.middle} ↑`, 'Close > DEMA']
    : [`Above ${rc.overbought}`, `Cross ${rc.overbought} ↓`, `Cross ${rc.smaType} ↓`, `Cross ${rc.middle} ↓`, 'Close < DEMA'];
}
const stageNames = (dir, rc) => (dir > 0
  ? ['OVERSOLD', `CROSS_${rc.oversold}`, 'CROSS_SMA', `CROSS_${rc.middle}`, 'DEMA_CONFIRM']
  : ['OVERBOUGHT', `CROSS_${rc.overbought}`, 'CROSS_SMA', `CROSS_${rc.middle}`, 'DEMA_CONFIRM']);

const newTrack = () => ({ n: 0, ts: [null, null, null, null, null], startTs: null, doneTs: null });
const newSide = (name) => ({ name, r1: newTrack(), r2: newTrack(), ready: false, readyTs: null });
const resetTrack = (t) => { t.n = 0; t.ts = [null, null, null, null, null]; t.startTs = null; t.doneTs = null; };
const resetSide = (s) => { resetTrack(s.r1); resetTrack(s.r2); s.ready = false; s.readyTs = null; };

export class SequenceEngine {
  /** cfg: strategy settings; meta: {market, tf (seconds)} */
  constructor(cfg, meta = {}) {
    this.cfg = mergeCfg(cfg);
    this.market = meta.market || 'NIFTY';
    this.tf = meta.tf || 60;
    this.reset();
  }
  reset() {
    this.candles = []; this.series = null; this.lastT = -Infinity; this.history = [];
    this.sides = { CALL: newSide('CALL'), PUT: newSide('PUT') };
  }
  _recompute() { this.series = computeSeries(this.candles.map((c) => c.c), this.cfg); }

  /** Replay closed candles silently to rebuild indicator + sequence state (identical to what a live run would hold). */
  warmup(candles) {
    this.reset();
    this.candles = candles.slice(-2500);
    this._recompute();
    const evs = [];
    for (let i = 1; i < this.candles.length; i++) evs.push(...this._evalAt(i, true));
    this.lastT = this.candles.length ? this.candles[this.candles.length - 1].t : -Infinity;
    this.history = evs;
    return evs;
  }

  /** Feed one CLOSED candle {t,o,h,l,c}; returns any READY / ENTRY events it completes. */
  onClose(candle) {
    if (!(candle.t > this.lastT)) return []; // duplicate / out-of-order: never double-fire
    this.candles.push(candle);
    if (this.candles.length > 2500) this.candles.shift();
    this.lastT = candle.t;
    this._recompute();
    return this._evalAt(this.candles.length - 1, false);
  }

  _evalAt(i, historical) {
    const out = [];
    for (const dir of [1, -1]) out.push(...this._evalSide(dir > 0 ? this.sides.CALL : this.sides.PUT, dir, i, historical));
    return out;
  }

  _evalSide(sd, dir, i, historical) {
    const { cfg, tf, series: S } = this;
    const c = this.candles[i], t = c.t;
    const cx = { t, close: c.c, dema: S.dema[i] };
    const evs = [];
    const age = (from) => (t - from) / tf;

    // expiry policy
    if (sd.ready && cfg.readyTimeout > 0 && age(sd.readyTs) > cfg.readyTimeout) resetSide(sd);
    if (!sd.ready && sd.r2.n === 5 && cfg.readyTimeout > 0 && age(sd.r2.doneTs) > cfg.readyTimeout) resetTrack(sd.r2);

    let readyNow = false;
    if (!sd.ready) {
      this._advance(sd.r1, dir, cfg.rsi1, { r: S.rsi1[i], rp: S.rsi1[i - 1], s: S.sma1[i], sp: S.sma1[i - 1] }, cx);
      if (sd.r1.n === 5) {
        sd.ready = true; sd.readyTs = t; readyNow = true;
        if (cfg.sync === 'strict') resetTrack(sd.r2); // RSI2 must start after READY
        evs.push(this._event('READY', sd, dir, i, historical, false));
      }
    }
    const r2Active = cfg.sync === 'retain' || (sd.ready && !readyNow);
    if (r2Active && sd.r2.n < 5) this._advance(sd.r2, dir, cfg.rsi2, { r: S.rsi2[i], rp: S.rsi2[i - 1], s: S.sma2[i], sp: S.sma2[i - 1] }, cx);

    if (sd.ready && sd.r2.n === 5) {
      evs.push(this._event('ENTRY', sd, dir, i, historical, sd.r2.doneTs < sd.readyTs));
      resetSide(sd); // no duplicate ENTRY from the same sequence; a brand-new sequence must form from scratch
    }
    return evs;
  }

  _advance(tr, dir, rc, x, cx) {
    const { cfg, tf } = this;
    const { r, rp, s, sp } = x;
    if (tr.n === 5) return;
    if (!isNum(r) || !isNum(rp)) return;
    if (tr.n > 0 && cfg.sequenceTimeout > 0 && (cx.t - tr.startTs) / tf > cfg.sequenceTimeout) resetTrack(tr);
    const inExtreme = dir > 0 ? r < rc.oversold : r > rc.overbought;
    if (cfg.restartOnNewExtreme && tr.n >= 2 && inExtreme) resetTrack(tr);
    const level = dir > 0 ? rc.oversold : rc.overbought;
    const crossLvl = (lv) => (dir > 0 ? rp <= lv && r > lv : rp >= lv && r < lv);
    const beyond = (a, b) => (dir > 0 ? a > b : a < b);
    for (;;) {
      let ok = false;
      switch (tr.n) {
        case 0: ok = inExtreme; break;
        case 1: ok = crossLvl(level); break;
        case 2: ok = isNum(s) && isNum(sp) && ((dir > 0 ? rp <= sp && r > s : rp >= sp && r < s) || (cfg.relaxedOrder && beyond(r, s))); break;
        case 3: ok = crossLvl(rc.middle) || (cfg.relaxedOrder && beyond(r, rc.middle)); break;
        case 4: ok = isNum(cx.dema) && (dir > 0 ? cx.close > cx.dema : cx.close < cx.dema); break;
        default: ok = false;
      }
      if (!ok) break;
      tr.ts[tr.n] = cx.t;
      if (tr.n === 0) tr.startTs = cx.t;
      tr.n++;
      if (tr.n === 5) { tr.doneTs = cx.t; break; }
    }
  }

  _event(kind, sd, dir, i, historical, retained) {
    const S = this.series, c = this.candles[i];
    const snap = (tr, rc) => stepLabels(dir, rc).map((label, k) => ({ label, done: k < tr.n, ts: tr.ts[k] }));
    const closeTs = c.t + this.tf;
    return {
      id: `${this.market}|${this.tf}|${sd.name}|${kind}|${closeTs}`,
      kind, side: sd.name, market: this.market, tf: this.tf,
      t: c.t, closeTs, close: c.c, dema: S.dema[i], rsi1: S.rsi1[i], rsi2: S.rsi2[i], sma1: S.sma1[i], sma2: S.sma2[i],
      retained, historical,
      readyTs: sd.readyTs,
      why: { rsi1: snap(sd.r1, this.cfg.rsi1), rsi2: snap(sd.r2, this.cfg.rsi2) },
    };
  }

  // ---------- read-only view for the UI ----------
  _sideView(sd, dir) {
    const { cfg } = this;
    const track = (tr, rc) => ({
      n: tr.n, steps: stepLabels(dir, rc).map((label, k) => ({ label, done: k < tr.n, ts: tr.ts[k] })),
      next: tr.n < 5 ? stepLabels(dir, rc)[tr.n] : null, startTs: tr.startTs, doneTs: tr.doneTs,
    });
    const r1 = track(sd.r1, cfg.rsi1), r2 = track(sd.r2, cfg.rsi2);
    let stage = 'IDLE';
    if (sd.ready) stage = sd.r2.n > 0 ? `RSI2_${stageNames(dir, cfg.rsi2)[sd.r2.n - 1]}` : `${sd.name}_READY`;
    else if (sd.r1.n > 0) stage = `RSI1_${stageNames(dir, cfg.rsi1)[sd.r1.n - 1]}`;
    const progress = sd.ready ? 5 + sd.r2.n : sd.r1.n;
    return { name: sd.name, stage, ready: sd.ready, readyTs: sd.readyTs, r1, r2, progress };
  }
  view() {
    const i = this.candles.length - 1;
    const S = this.series;
    const at = (a) => (S && i >= 0 && isNum(a[i]) ? a[i] : null);
    return {
      ready: i >= 0 && !!S,
      ind: i >= 0 && S ? { t: this.candles[i].t, close: this.candles[i].c, dema: at(S.dema), rsi1: at(S.rsi1), rsi2: at(S.rsi2), sma1: at(S.sma1), sma2: at(S.sma2) } : null,
      CALL: this._sideView(this.sides.CALL, 1),
      PUT: this._sideView(this.sides.PUT, -1),
    };
  }
}
