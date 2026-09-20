// Black-Scholes fallback so IV/Greeks are available even when Dhan omits them.
function erf(x) { // Abramowitz-Stegun 7.1.26
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const N = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
const n = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/** sigma as decimal (0.15). T in years. Returns theta per day, vega per 1 vol point. */
export function bs(S, K, T, r, sigma, type) {
  if (!(S > 0 && K > 0 && T > 0 && sigma > 0)) return null;
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / sq;
  const d2 = d1 - sq;
  const call = type === 'CE';
  const price = call ? S * N(d1) - K * Math.exp(-r * T) * N(d2) : K * Math.exp(-r * T) * N(-d2) - S * N(-d1);
  const delta = call ? N(d1) : N(d1) - 1;
  const gamma = n(d1) / (S * sq);
  const vega = (S * n(d1) * Math.sqrt(T)) / 100;
  const thetaYear = -(S * n(d1) * sigma) / (2 * Math.sqrt(T)) + (call ? -1 : 1) * r * K * Math.exp(-r * T) * N(call ? d2 : -d2);
  return { price, delta, gamma, vega, theta: thetaYear / 365 };
}

export function impliedVol(price, S, K, T, r, type) {
  if (!(price > 0 && S > 0 && K > 0 && T > 0)) return null;
  const intrinsic = Math.max(0, type === 'CE' ? S - K * Math.exp(-r * T) : K * Math.exp(-r * T) - S);
  if (price <= intrinsic + 1e-6) return null;
  let lo = 0.01, hi = 4;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const p = bs(S, K, T, r, mid, type)?.price;
    if (p == null) return null;
    if (p > price) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}
