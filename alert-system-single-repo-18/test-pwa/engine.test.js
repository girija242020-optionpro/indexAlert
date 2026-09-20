import test from 'node:test';
import assert from 'node:assert/strict';
import { rsi, ema, sma, dema, SequenceEngine } from '../public/js/engine.js';

const near = (a, b, e = 0.05) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);

test('Wilder RSI(14) matches the classic StockCharts worked example', () => {
  const c = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.6140, 46.2820, 46.2820, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515, 45.7835, 45.3548, 44.0288, 44.1783, 44.2219, 44.5805, 43.4231, 42.6555, 43.1307];
  const r = rsi(c, 14);
  assert.ok(Number.isNaN(r[13]));
  near(r[14], 70.53); near(r[15], 66.32);
});

test('EMA seeds with SMA; DEMA has no lag on a ramp and equals constant on flat data', () => {
  const ramp = Array.from({ length: 200 }, (_, i) => 100 + i);
  const e = ema(ramp, 14); near(e[13], sma(ramp, 14)[13], 1e-9);
  near(dema(ramp, 14)[199], ramp[199], 1e-6);
  near(dema(new Array(100).fill(50), 14)[99], 50, 1e-9);
});

// Engine driven by injected indicator series so each FSM rule is tested in isolation.
class Inj extends SequenceEngine {
  constructor(cfg, S) { super(cfg, { market: 'NIFTY', tf: 60 }); this.inj = S; }
  _recompute() { this.series = this.inj; }
}
const run = (cfg, rows) => {
  const S = { rsi1: rows.map((r) => r[0]), sma1: rows.map((r) => r[1]), rsi2: rows.map((r) => r[2]), sma2: rows.map((r) => r[3]), dema: rows.map(() => 100) };
  const e = new Inj(cfg, S); const out = [];
  rows.forEach((r, i) => { for (const ev of e.onClose({ t: i * 60, o: r[4], h: r[4], l: r[4], c: r[4] })) out.push([i, ev.side, ev.kind, ev.retained]); });
  return { out, e };
};
// [rsi1, sma1, rsi2, sma2, close]  (DEMA fixed at 100)
const CALL_FLOW = [
  [40, 45, 40, 45, 99],
  [28, 45, 35, 45, 99],   // RSI1 below 30
  [32, 45, 27, 45, 99],   // RSI1 cross 30 ; RSI2 below 30
  [44, 45, 33, 45, 99],   // RSI2 cross 30
  [46, 45, 41, 45, 99],   // RSI1 cross SMA
  [51, 45, 46, 45, 99],   // RSI1 cross 50, but close < DEMA ; RSI2 cross SMA
  [53, 45, 48, 45, 101],  // close > DEMA -> CALL READY
  [55, 45, 52, 45, 102],  // RSI2 cross 50 + close > DEMA -> CALL ENTRY
  [56, 45, 55, 45, 103],
];

test('CALL: READY on RSI1 sequence, ENTRY when RSI2 completes, no duplicates', () => {
  const { out } = run({}, CALL_FLOW);
  assert.deepEqual(out, [[6, 'CALL', 'READY', false], [7, 'CALL', 'ENTRY', false]]);
});

test('DEMA gate: RSI1 waits at step 5 until a candle closes above DEMA', () => {
  const rows = CALL_FLOW.map((r) => [...r]); rows[6][4] = 99; rows[7][4] = 99;
  const { out } = run({}, rows);
  // nothing fires while closes stay below DEMA (idx 6,7); it completes on the first close above it (idx 8)
  assert.deepEqual(out, [[8, 'CALL', 'READY', false], [8, 'CALL', 'ENTRY', false]]);
});

test('PUT is the exact mirror', () => {
  const m = CALL_FLOW.map(([a, b, c, d, e]) => [100 - a, 100 - b, 100 - c, 100 - d, 200 - e]);
  const { out } = run({}, m);
  assert.deepEqual(out, [[6, 'PUT', 'READY', false], [7, 'PUT', 'ENTRY', false]]);
});

test('retain: RSI2 finishing first is kept; READY + ENTRY fire together when RSI1 completes', () => {
  const rows = [
    [40, 45, 40, 45, 99], [40, 45, 28, 45, 99], [40, 45, 32, 45, 99], [40, 45, 46, 45, 99], [40, 45, 51, 45, 101], // RSI2 completes at idx 4
    [28, 45, 55, 45, 101], [32, 45, 55, 45, 101], [46, 45, 55, 45, 101], [51, 45, 55, 45, 101],                  // RSI1 completes at idx 8
  ];
  const { out } = run({}, rows);
  assert.deepEqual(out, [[8, 'CALL', 'READY', false], [8, 'CALL', 'ENTRY', true]]);
});

test('strict: RSI2 progress before READY is discarded, so no ENTRY', () => {
  const rows = [
    [40, 45, 40, 45, 99], [40, 45, 28, 45, 99], [40, 45, 32, 45, 99], [40, 45, 46, 45, 99], [40, 45, 51, 45, 101],
    [28, 45, 55, 45, 101], [32, 45, 55, 45, 101], [46, 45, 55, 45, 101], [51, 45, 55, 45, 101],
  ];
  const { out } = run({ sync: 'strict' }, rows);
  assert.deepEqual(out, [[8, 'CALL', 'READY', false]]);
});

test('readyTimeout: an old READY expires instead of living forever', () => {
  const rows = CALL_FLOW.slice(0, 7);
  for (let k = 0; k < 30; k++) rows.push([55, 45, 40, 45, 102]); // RSI2 never completes
  rows.push([55, 45, 52, 45, 102]);
  const { out } = run({ readyTimeout: 20 }, rows);
  assert.deepEqual(out, [[6, 'CALL', 'READY', false]]); // no late ENTRY
});

test('sequenceTimeout resets a stalled RSI1 track', () => {
  const rows = [[40, 45, 40, 45, 99], [28, 45, 40, 45, 99]];
  for (let k = 0; k < 10; k++) rows.push([31, 45, 40, 45, 99]);
  rows.push([46, 45, 40, 45, 99], [51, 45, 40, 45, 101]);
  const { e } = run({ sequenceTimeout: 5 }, rows);
  assert.equal(e.view().CALL.r1.n <= 1, true);
});

test('single candle can complete several steps in order (fast RSI jump)', () => {
  const rows = [[40, 45, 40, 45, 99], [28, 45, 40, 45, 99], [60, 45, 40, 45, 101]]; // 28 -> 60 crosses 30, SMA, 50 at once
  const { e } = run({}, rows);
  assert.equal(e.view().CALL.ready, true);
});

test('relaxedOrder: RSI already above SMA when crossing 50 first does not stall', () => {
  const rows = [[40, 55, 40, 45, 99], [28, 55, 40, 45, 99], [32, 55, 40, 45, 99], [52, 55, 40, 45, 101], [58, 55, 40, 45, 101]];
  // strict: 50 is crossed before the SMA, so step 4 can never fire after the SMA cross -> stalls
  assert.equal(run({}, rows).e.view().CALL.ready, false);
  assert.equal(run({ relaxedOrder: true }, rows).e.view().CALL.ready, true);
});

test('duplicate / out-of-order candles are ignored', () => {
  const { e } = run({}, CALL_FLOW);
  assert.deepEqual(e.onClose({ t: 7 * 60, o: 1, h: 1, l: 1, c: 1 }), []);
});

test('warmup replays history to the same state a live run holds', () => {
  const closes = Array.from({ length: 400 }, (_, i) => 100 + 8 * Math.sin(i / 6) + 3 * Math.sin(i / 2.3));
  const candles = closes.map((c, i) => ({ t: i * 60, o: c, h: c, l: c, c }));
  const a = new SequenceEngine({}, { market: 'NIFTY', tf: 60 }); const evA = a.warmup(candles.slice(0, 250));
  const live = []; for (const c of candles.slice(250)) live.push(...a.onClose(c));
  const b = new SequenceEngine({}, { market: 'NIFTY', tf: 60 }); const evB = b.warmup(candles);
  assert.deepEqual([...evA, ...live].map((e) => e.id), evB.map((e) => e.id));
  assert.ok(evB.length > 0);
});
