import { config, log } from './config.js';
import { istDateStr } from './time.js';

const pickIdx = (h, names) => { for (const n of names) { const i = h.indexOf(n); if (i >= 0) return i; } return -1; };

function splitCsv(line) {
  if (!line.includes('"')) return line.split(',');
  const out = []; let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Streams Dhan's scrip master and keeps only NIFTY/SENSEX index futures + options (memory-friendly). */
export class Instruments {
  constructor() { this.futs = { NIFTY: [], SENSEX: [] }; this.opts = new Map(); this.loadedAt = 0; this.error = null; this.H = null; }

  async load() {
    const res = await fetch(config.dhan.scripMasterUrl, { signal: AbortSignal.timeout(120000) });
    if (!res.ok || !res.body) throw new Error('scrip master HTTP ' + res.status);
    this.futs = { NIFTY: [], SENSEX: [] };
    this.opts = new Map();
    this.H = null;
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { this._line(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
    }
    if (buf) this._line(buf);
    this.loadedAt = Date.now();
    this.error = null;
    log(`instruments: NIFTY fut ${this.futs.NIFTY.length}, SENSEX fut ${this.futs.SENSEX.length}, options ${this.opts.size}`);
  }

  _line(line) {
    if (!line) return;
    const c = splitCsv(line);
    if (!this.H) {
      const h = c.map((x) => x.replace(/^\uFEFF/, '').trim());
      this.H = {
        exch: pickIdx(h, ['SEM_EXM_EXCH_ID', 'EXCH_ID']), sid: pickIdx(h, ['SEM_SMST_SECURITY_ID', 'SECURITY_ID']),
        inst: pickIdx(h, ['SEM_INSTRUMENT_NAME', 'INSTRUMENT']), tsym: pickIdx(h, ['SEM_TRADING_SYMBOL', 'TRADING_SYMBOL']),
        lot: pickIdx(h, ['SEM_LOT_UNITS', 'LOT_SIZE']), exp: pickIdx(h, ['SEM_EXPIRY_DATE', 'SM_EXPIRY_DATE']),
        strike: pickIdx(h, ['SEM_STRIKE_PRICE', 'STRIKE_PRICE']), otype: pickIdx(h, ['SEM_OPTION_TYPE', 'OPTION_TYPE']),
      };
      if (this.H.sid < 0 || this.H.inst < 0 || this.H.tsym < 0) throw new Error('unexpected scrip master header');
      return;
    }
    const H = this.H;
    const inst = c[H.inst];
    if (inst !== 'FUTIDX' && inst !== 'OPTIDX') return;
    const tsym = c[H.tsym] || '';
    const m = /^(NIFTY|SENSEX)-/.exec(tsym);
    if (!m) return;
    const u = m[1];
    const exch = c[H.exch];
    if ((u === 'NIFTY' && exch !== 'NSE') || (u === 'SENSEX' && exch !== 'BSE')) return;
    const expiry = (c[H.exp] || '').slice(0, 10);
    const rec = { securityId: String(parseInt(c[H.sid], 10)), symbol: tsym, expiry, lot: +c[H.lot] || null, segment: exch === 'NSE' ? 'NSE_FNO' : 'BSE_FNO' };
    if (inst === 'FUTIDX') this.futs[u].push(rec);
    else {
      const type = (c[H.otype] || '').trim().toUpperCase();
      const strike = Math.round(+c[H.strike]);
      if (type === 'CE' || type === 'PE') this.opts.set(`${u}|${expiry}|${strike}|${type}`, rec.securityId);
    }
  }

  nearFuture(u, ms = Date.now()) {
    const today = istDateStr(ms);
    const f = (this.futs[u] || []).filter((x) => x.expiry >= today).sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
    return f[0] || null;
  }
  option(u, expiry, strike, type) { return this.opts.get(`${u}|${expiry}|${Math.round(strike)}|${type}`) || null; }
}
