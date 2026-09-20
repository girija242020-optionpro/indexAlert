import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, parseDepth } from '../src/parser.js';
import { totp } from '../src/auth.js';
import { bs, impliedVol } from '../src/bs.js';
import { CandleStore } from '../src/candles.js';
import { bucketStart, inSession } from '../src/time.js';

const hdr = (b, code, len, seg, sid) => { b.writeUInt8(code, 0); b.writeUInt16LE(len, 1); b.writeUInt8(seg, 3); b.writeInt32LE(sid, 4); };

test('ticker packet', () => {
  const b = Buffer.alloc(16); hdr(b, 2, 16, 0, 13); b.writeFloatLE(23346.4, 8); b.writeInt32LE(1234567, 12);
  const [p] = parseFeed(b);
  assert.equal(p.segment, 'IDX_I'); assert.equal(p.securityId, '13'); assert.ok(Math.abs(p.ltp - 23346.4) < 0.01);
});

test('full packet with OI + 5-level depth, stacked with a ticker', () => {
  const f = Buffer.alloc(162); hdr(f, 8, 162, 2, 55555);
  f.writeFloatLE(23350.5, 8); f.writeInt32LE(987654, 22); f.writeInt32LE(4000, 26); f.writeInt32LE(5000, 30);
  f.writeInt32LE(1200000, 34); f.writeFloatLE(23300, 46); f.writeFloatLE(23400, 54); f.writeFloatLE(23250, 58);
  for (let k = 0; k < 5; k++) { const o = 62 + k * 20; f.writeInt32LE(100 + k, o); f.writeInt32LE(200 + k, o + 4); f.writeInt16LE(3, o + 8); f.writeInt16LE(4, o + 10); f.writeFloatLE(23350 - k * 0.05, o + 12); f.writeFloatLE(23350.5 + k * 0.05, o + 16); }
  const t = Buffer.alloc(16); hdr(t, 2, 16, 0, 51); t.writeFloatLE(77000, 8);
  const ps = parseFeed(Buffer.concat([f, t]));
  assert.equal(ps.length, 2);
  assert.equal(ps[0].oi, 1200000); assert.equal(ps[0].volume, 987654); assert.equal(ps[0].depth.length, 5);
  assert.equal(ps[0].depth[2].bidQty, 102); assert.equal(ps[1].securityId, '51');
});

test('disconnect packet', () => {
  const b = Buffer.alloc(10); hdr(b, 50, 10, 0, 0); b.writeInt16LE(807, 8);
  assert.equal(parseFeed(b)[0].disconnectCode, 807);
});

test('20-level depth: stacked bid+ask', () => {
  const mk = (code) => { const b = Buffer.alloc(332); b.writeUInt16LE(332, 0); b.writeUInt8(code, 2); b.writeUInt8(2, 3); b.writeInt32LE(4242, 4);
    for (let k = 0; k < 20; k++) { const o = 12 + k * 16; b.writeDoubleLE(100 + (code === 41 ? -k : k) * 0.05, o); b.writeUInt32LE(50 + k, o + 8); b.writeUInt32LE(2 + k, o + 12); } return b; };
  const ps = parseDepth(Buffer.concat([mk(41), mk(51)]));
  assert.equal(ps.length, 2); assert.equal(ps[0].side, 'bid'); assert.equal(ps[1].side, 'ask');
  assert.equal(ps[0].levels.length, 20); assert.equal(ps[1].levels[19].quantity, 69);
});

test('TOTP matches RFC 6238 vector (SHA1, T=59s)', () => {
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000, 6), '287082');
});

test('Black-Scholes / IV round trip', () => {
  const g = bs(23350, 23400, 7 / 365, 0.07, 0.14, 'CE');
  assert.ok(g.gamma > 0 && g.delta > 0 && g.delta < 1);
  const iv = impliedVol(g.price, 23350, 23400, 7 / 365, 0.07, 'CE');
  assert.ok(Math.abs(iv - 0.14) < 1e-3);
});

test('candles: session bucket + aggregation to 3m/5m, forming candle', () => {
  const day = Date.UTC(2026, 8, 18, 3, 45, 0); // 09:15 IST Fri 18 Sep 2026
  assert.ok(inSession(day / 1000)); assert.ok(!inSession(day / 1000 - 1));
  const cs = new CandleStore();
  for (let m = 0; m < 7; m++) { cs.ingest('NIFTY', day + m * 60000 + 1000, 100 + m); cs.ingest('NIFTY', day + m * 60000 + 30000, 100 + m + 0.5); }
  const now = day + 6 * 60000 + 40000;
  const r5 = cs.get('NIFTY', 5, 100, now);
  assert.equal(r5.candles.length, 1); assert.equal(r5.candles[0].t, day / 1000);
  assert.equal(r5.candles[0].o, 100); assert.equal(r5.candles[0].c, 104.5); assert.equal(r5.candles[0].h, 104.5);
  assert.ok(r5.forming && r5.forming.t === day / 1000 + 300);
  const r3 = cs.get('NIFTY', 3, 100, now);
  assert.equal(r3.candles.length, 2); assert.equal(bucketStart(day / 1000 + 200, 180), day / 1000 + 180);
  // outside session ignored
  cs.ingest('NIFTY', day - 3600000, 50); assert.equal(cs.count('NIFTY'), 7);
});
