import { config } from './config.js';
import { bs, impliedVol } from './bs.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Option chain + expiry list from Dhan (rate limit: 1 request / 3 s per underlying), normalised for the PWA. */
export class ChainService {
  constructor(auth, markets, instruments, store) {
    Object.assign(this, { auth, markets, instruments, store });
    this.cache = new Map();   // key -> {at, data}
    this.expCache = new Map(); // symbol -> {at, list}
    this.last = new Map();    // symbol -> ts of last request
    this.inflight = new Map();
  }

  async _post(path, body) {
    const r = await fetch(`${config.dhan.apiBase}${path}`, { method: 'POST', headers: this.auth.headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.status === 'failure') {
      const msg = d?.data ? JSON.stringify(d.data) : d.errorMessage || d.message || r.status;
      if (r.status === 401) this.auth.invalidate('option chain 401');
      throw new Error(`Dhan ${path}: ${msg}`);
    }
    return d;
  }

  async expiries(symbol) {
    const m = this.markets[symbol];
    if (!m) throw new Error('unknown symbol');
    const c = this.expCache.get(symbol);
    if (c && Date.now() - c.at < 30 * 60000) return c.list;
    const d = await this._post('/optionchain/expirylist', { UnderlyingScrip: +m.securityId, UnderlyingSeg: m.segment });
    const list = (d.data || []).slice().sort();
    this.expCache.set(symbol, { at: Date.now(), list });
    return list;
  }

  async chain(symbol, expiry) {
    const m = this.markets[symbol];
    if (!m) throw new Error('unknown symbol');
    if (!expiry) {
      const list = await this.expiries(symbol);
      const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
      expiry = list.find((x) => x >= today) || list[0];
      if (!expiry) throw new Error('no expiry available');
    }
    const key = `${symbol}|${expiry}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 4000) return hit.data;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      const wait = 3100 - (Date.now() - (this.last.get(symbol) || 0));
      if (wait > 0) await sleep(wait);
      this.last.set(symbol, Date.now());
      const d = await this._post('/optionchain', { UnderlyingScrip: +m.securityId, UnderlyingSeg: m.segment, Expiry: expiry });
      const data = this._normalise(symbol, expiry, d.data || {});
      this.cache.set(key, { at: Date.now(), data });
      return data;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  _normalise(symbol, expiry, raw) {
    const spot = raw.last_price || this.store.latest.get(symbol)?.ltp || 0;
    const expMs = Date.parse(expiry + 'T15:30:00+05:30');
    const T = Math.max((expMs - Date.now()) / (365 * 86400000), 1 / (365 * 24 * 60));
    const r = config.riskFreeRate;
    const side = (o, strike, type) => {
      if (!o) return null;
      const ltp = +o.last_price || 0;
      let iv = +o.implied_volatility || 0; // percent
      let g = o.greeks || {};
      let delta = +g.delta || 0, gamma = +g.gamma || 0, theta = +g.theta || 0, vega = +g.vega || 0;
      let src = 'dhan';
      if (!(iv > 0) && ltp > 0) { const v = impliedVol(ltp, spot, strike, T, r, type); if (v) { iv = v * 100; src = 'calc'; } }
      if (!(gamma > 0) && iv > 0 && spot > 0) {
        const c = bs(spot, strike, T, r, iv / 100, type);
        if (c) { delta = c.delta; gamma = c.gamma; theta = c.theta; vega = c.vega; src = 'calc'; }
      }
      const oi = +o.oi || 0, prevOi = +o.previous_oi || 0;
      return {
        securityId: o.security_id != null ? String(o.security_id) : this.instruments.option(symbol, expiry, strike, type),
        ltp, oi, changeOi: oi - prevOi, volume: +o.volume || 0, prevVolume: +o.previous_volume || 0,
        iv, delta, gamma, theta, vega, greeksSource: src,
        bid: +o.top_bid_price || 0, ask: +o.top_ask_price || 0, bidQty: +o.top_bid_quantity || 0, askQty: +o.top_ask_quantity || 0,
      };
    };
    const strikes = Object.entries(raw.oc || {})
      .map(([k, row]) => [Number(k), row])
      .filter(([k]) => Number.isFinite(k))
      .sort((a, b) => a[0] - b[0])
      .map(([k, row]) => ({ strike: k, ce: side(row.ce, k, 'CE'), pe: side(row.pe, k, 'PE') }));
    let atm = null;
    if (strikes.length && spot) atm = strikes.reduce((b, s) => (Math.abs(s.strike - spot) < Math.abs(b - spot) ? s.strike : b), strikes[0].strike);
    return { symbol, expiry, underlyingLtp: spot, atmStrike: atm, fetchedAt: new Date().toISOString(), strikes };
  }
}
