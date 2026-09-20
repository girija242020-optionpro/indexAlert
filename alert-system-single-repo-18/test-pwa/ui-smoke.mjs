// Renders every view with realistic state through a fake DOM to catch template/runtime errors.
const els = {};
globalThis.Notification = { permission: 'default' }; globalThis.window = { Notification: globalThis.Notification };
globalThis.document = { getElementById: (id) => (els[id] ||= { innerHTML: '', textContent: '', hidden: false, classList: { add() {}, remove() {}, toggle() {} } }), activeElement: null, querySelectorAll: () => [] };
globalThis.localStorage = { getItem: () => null, setItem() {} };
const { SequenceEngine } = await import('../public/js/engine.js');
const ui = await import('../public/js/ui.js');
const { analyzeChain, analyzeDepth } = await import('../public/js/context.js');
const { DEFAULT_SETTINGS, engineCfg } = await import('../public/js/settings.js');

const closes = Array.from({ length: 500 }, (_, i) => 23300 + 60 * Math.sin(i / 7) + 25 * Math.sin(i / 2.1));
const candles = closes.map((c, i) => ({ t: 1758000000 + i * 60, o: c, h: c + 2, l: c - 2, c }));
const eng = new SequenceEngine(engineCfg(DEFAULT_SETTINGS), { market: 'NIFTY', tf: 60 });
const evs = eng.warmup(candles);
console.log('replay events:', evs.length, evs.slice(-3).map((e) => `${e.side}:${e.kind}`).join(' '));
evs.forEach((e) => { e.historical = false; });
const strikes = Array.from({ length: 21 }, (_, i) => { const k = 23000 + i * 50; return { strike: k, ce: { securityId: '1' + i, ltp: Math.max(1, 23350 - k) + 20, oi: 100000 + i * 5000, changeOi: (i - 10) * 1000, volume: 5000, iv: 13, gamma: 0.0005, greeksSource: 'dhan' }, pe: { securityId: '2' + i, ltp: Math.max(1, k - 23350) + 20, oi: 90000 + i * 4000, changeOi: (10 - i) * 900, volume: 4000, iv: 14, gamma: 0.0005 } }; });
const chain = analyzeChain({ expiry: '2026-09-22', atmStrike: 23350, fetchedAt: new Date().toISOString(), underlyingLtp: 23346.4, strikes }, 23346.4);
const depth = analyzeDepth({ symbol: 'NIFTY-FUT', levels: 20, source: '20-level', ts: Date.now(), bids: [{ price: 23345, quantity: 900, orders: 3 }], asks: [{ price: 23346, quantity: 400, orders: 2 }] });
const S = { cfg: structuredClone(DEFAULT_SETTINGS), api: { ok: true }, status: 'LIVE', tick: { ltp: 23346.4, dayHigh: 23389, dayLow: 23300 }, tickAt: Date.now(), now: Date.now(), error: '',
  view: eng.view(), events: evs.slice(-8).reverse(), signal: { cls: 'CALL_READY', label: 'CALL READY', sub: 'waiting' }, bestSide: eng.view().CALL,
  ctx: { chain, depth, fut: { ltp: 23350, volume: 123456, oi: 9000000, changeOi: 12345 }, vol: { }, ivDelta: 0.12, chainError: '', depthError: '' },
  logs: [{ id: 'a', date: '2026-09-18', time: '14:47:00', market: 'NIFTY', timeframe: '1m', side: 'CALL', cmp: 23346.4, dema: 23340, rsi1: 55, rsi2: 52, sma1: 44, sma2: 47, sequence: 'x', oi: 1, changeOi: 2, volume: 3, iv: 13, l20Imbalance: 0.2 }],
  ui: { tab: 'signal', open: { CALL: true, PUT: true }, depthSel: 'FUT', filters: { date: '', q: '', side: '', market: '', tf: '' } } };
S.ctx.vol.stats = () => ({ last1m: 100, avgPrev: 50, ratio: 2 });
ui.renderTop(S); ui.renderSignal(S); ui.renderMarket(S); ui.renderLogs(S); ui.renderSettings(S);
for (const k of ['top', 'view-signal', 'view-market', 'view-logs', 'view-settings']) { const h = els[k].innerHTML; if (!h || /undefined|NaN(?!<)/.test(h.replace(/–/g, ''))) console.log('CHECK', k, (h.match(/.{0,30}(undefined|NaN).{0,30}/) || [''])[0]); }
console.log('rendered sizes', Object.fromEntries(['top', 'view-signal', 'view-market', 'view-logs', 'view-settings'].map((k) => [k, els[k].innerHTML.length])));
