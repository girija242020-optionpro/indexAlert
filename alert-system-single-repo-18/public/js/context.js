// Market confirmation layer. Purely informational: it never feeds the RSI/DEMA state machine.
const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);

export function analyzeChain(chain, spot) {
  if (!chain?.strikes?.length) return null;
  const S = chain.strikes;
  const px = spot || chain.underlyingLtp;
  const atm = chain.atmStrike ?? S.reduce((b, s) => (Math.abs(s.strike - px) < Math.abs(b - px) ? s.strike : b), S[0].strike);
  const ai = S.findIndex((s) => s.strike === atm);
  const row = S[ai] || S[0];
  const top = (side, n = 3) => [...S].filter((s) => s[side]?.oi > 0).sort((a, b) => b[side].oi - a[side].oi).slice(0, n).map((s) => ({ strike: s.strike, oi: s[side].oi, dOi: s[side].changeOi }));
  const callWalls = top('ce'), putWalls = top('pe');
  const totCe = sum(S, (s) => s.ce?.oi), totPe = sum(S, (s) => s.pe?.oi);
  const dCe = sum(S, (s) => s.ce?.changeOi), dPe = sum(S, (s) => s.pe?.changeOi);
  const volCe = sum(S, (s) => s.ce?.volume), volPe = sum(S, (s) => s.pe?.volume);
  const conc = (side, tot) => (tot ? sum(top(side), (x) => x.oi) / tot : 0);
  // Gamma exposure (relative units; assumes dealers long calls / short puts, so it is indicative only)
  const gex = S.map((s) => ({ strike: s.strike, v: ((s.ce?.gamma || 0) * (s.ce?.oi || 0) - (s.pe?.gamma || 0) * (s.pe?.oi || 0)) * px * px * 0.01 }));
  const netGex = sum(gex, (g) => g.v);
  const topG = [...gex].sort((a, b) => Math.abs(b.v) - Math.abs(a.v))[0];
  const ce = row.ce, pe = row.pe;
  const near = S.slice(Math.max(0, ai - 3), ai + 4);
  return {
    expiry: chain.expiry, atm, fetchedAt: chain.fetchedAt, spot: px,
    straddle: ce && pe ? ce.ltp + pe.ltp : null, ceLtp: ce?.ltp ?? null, peLtp: pe?.ltp ?? null,
    ivCe: ce?.iv || null, ivPe: pe?.iv || null, iv: ce?.iv && pe?.iv ? (ce.iv + pe.iv) / 2 : ce?.iv || pe?.iv || null,
    atmGamma: ce && pe ? (ce.gamma + pe.gamma) / 2 : null, greeksSource: ce?.greeksSource || null,
    totCe, totPe, dCe, dPe, pcrOi: totCe ? totPe / totCe : null, pcrVol: volCe ? volPe / volCe : null, volCe, volPe,
    callWalls, putWalls, callConc: conc('ce', totCe), putConc: conc('pe', totPe),
    netGex, gexBias: netGex > 0 ? 'positive (dampening)' : netGex < 0 ? 'negative (amplifying)' : 'flat', gexStrike: topG?.strike ?? null,
    near: near.map((s) => ({ strike: s.strike, ceOi: s.ce?.oi, cePrice: s.ce?.ltp, ceD: s.ce?.changeOi, peOi: s.pe?.oi, pePrice: s.pe?.ltp, peD: s.pe?.changeOi, isAtm: s.strike === atm })),
  };
}

export function analyzeDepth(d) {
  if (!d) return null;
  const totalBid = d.totalBid ?? sum(d.bids, (x) => x.quantity), totalAsk = d.totalAsk ?? sum(d.asks, (x) => x.quantity);
  const tot = totalBid + totalAsk;
  const imbalance = tot ? (totalBid - totalAsk) / tot : 0;
  const top = (a) => [...a].sort((x, y) => y.quantity - x.quantity).slice(0, 3);
  return {
    symbol: d.symbol, levels: d.levels, source: d.source, ts: d.ts, totalBid, totalAsk, imbalance,
    bidPct: tot ? (totalBid / tot) * 100 : 50, askPct: tot ? (totalAsk / tot) * 100 : 50,
    pressure: imbalance > 0.15 ? 'BID' : imbalance < -0.15 ? 'ASK' : 'BALANCED',
    topBids: top(d.bids), topAsks: top(d.asks),
  };
}

/** Per-minute traded volume from the future's cumulative volume; compares the last minute with the prior 4-minute average. */
export class VolumeTracker {
  constructor() { this.pts = []; }
  push(ts, cumVol) {
    if (!Number.isFinite(cumVol)) return;
    const last = this.pts[this.pts.length - 1];
    if (last && cumVol < last.v) this.pts = []; // session reset
    this.pts.push({ ts, v: cumVol });
    const cut = ts - 10 * 60000;
    while (this.pts.length > 2 && this.pts[0].ts < cut) this.pts.shift();
  }
  at(ts) { let r = null; for (const p of this.pts) { if (p.ts <= ts) r = p; else break; } return r; }
  stats(now = Date.now()) {
    const n = this.at(now), a = this.at(now - 60000), b = this.at(now - 300000);
    if (!n || !a || !b || a === n) return null;
    const last1 = n.v - a.v, prev4 = (a.v - b.v) / 4;
    return { last1m: last1, avgPrev: prev4, ratio: prev4 > 0 ? last1 / prev4 : null };
  }
}
