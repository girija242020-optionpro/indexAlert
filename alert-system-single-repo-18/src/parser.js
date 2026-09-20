// Dhan Market Feed (v2) + 20-level depth binary parsers. All numbers are little-endian.
// The PWA never sees these packets; only normalized JSON leaves the backend.

export const SEG_NAME = { 0: 'IDX_I', 1: 'NSE_EQ', 2: 'NSE_FNO', 3: 'NSE_CURRENCY', 4: 'BSE_EQ', 5: 'MCX_COMM', 7: 'BSE_CURRENCY', 8: 'BSE_FNO' };
export const SEG_CODE = Object.fromEntries(Object.entries(SEG_NAME).map(([k, v]) => [v, +k]));

// Fixed packet sizes (header included) for the known response codes.
const SIZE = { 2: 16, 4: 50, 5: 12, 6: 16, 7: 8, 8: 162, 50: 10 };

export const DISCONNECT_REASON = {
  804: 'Requested instrument count exceeds limit',
  805: 'Too many connections/requests on this Dhan account',
  806: 'Data APIs not subscribed on this Dhan account',
  807: 'Access token expired',
  808: 'Authentication failed (client id / token invalid)',
  809: 'Access token invalid',
};

export function parseFeed(buf) {
  const out = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const code = buf.readUInt8(off);
    const declared = buf.readUInt16LE(off + 1);
    const size = SIZE[code] || declared || 16; // code 1 (index packet) has no fixed size in our table
    if (size < 8 || off + size > buf.length) break;
    const segCode = buf.readUInt8(off + 3);
    const p = { code, segCode, segment: SEG_NAME[segCode] || String(segCode), securityId: String(buf.readInt32LE(off + 4)) };
    const f32 = (o) => buf.readFloatLE(off + o);
    const i32 = (o) => buf.readInt32LE(off + o);
    switch (code) {
      case 1: // index packet: treated like ticker layout
      case 2:
        p.ltp = f32(8);
        p.ltt = size >= 16 ? i32(12) : null;
        break;
      case 4:
        p.ltp = f32(8); p.ltq = buf.readInt16LE(off + 12); p.ltt = i32(14); p.atp = f32(18);
        p.volume = i32(22); p.sellQty = i32(26); p.buyQty = i32(30);
        p.dayOpen = f32(34); p.dayClose = f32(38); p.dayHigh = f32(42); p.dayLow = f32(46);
        break;
      case 5:
        p.oi = i32(8);
        break;
      case 6:
        p.prevClose = f32(8); p.prevOi = i32(12);
        break;
      case 8: {
        p.ltp = f32(8); p.ltq = buf.readInt16LE(off + 12); p.ltt = i32(14); p.atp = f32(18);
        p.volume = i32(22); p.sellQty = i32(26); p.buyQty = i32(30);
        p.oi = i32(34); p.oiHigh = i32(38); p.oiLow = i32(42);
        p.dayOpen = f32(46); p.dayClose = f32(50); p.dayHigh = f32(54); p.dayLow = f32(58);
        p.depth = [];
        for (let k = 0; k < 5; k++) {
          const o = 62 + k * 20;
          p.depth.push({
            bidQty: i32(o), askQty: i32(o + 4),
            bidOrders: buf.readInt16LE(off + o + 8), askOrders: buf.readInt16LE(off + o + 10),
            bidPrice: f32(o + 12), askPrice: f32(o + 16),
          });
        }
        break;
      }
      case 50:
        p.disconnectCode = buf.readInt16LE(off + 8);
        break;
      default:
        break;
    }
    out.push(p);
    off += size;
  }
  return out;
}

// 20-level depth: header 12 bytes [len i16][code u8: 41 bid / 51 ask][segment u8][securityId i32][seq u32]
// followed by 20 x 16 bytes [price f64][qty u32][orders u32]. Bid and ask arrive as separate (possibly stacked) packets.
export function parseDepth(buf) {
  const out = [];
  let off = 0;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt16LE(off);
    const code = buf.readUInt8(off + 2);
    const segCode = buf.readUInt8(off + 3);
    const securityId = String(buf.readInt32LE(off + 4));
    // "length" may be the total (332) or the payload only (320): normalise.
    const size = len === 320 ? 332 : len >= 12 ? len : 332;
    if (off + size > buf.length) break;
    const n = Math.min(20, Math.floor((size - 12) / 16));
    const levels = [];
    for (let k = 0; k < n; k++) {
      const o = off + 12 + k * 16;
      const price = buf.readDoubleLE(o);
      const quantity = buf.readUInt32LE(o + 8);
      const orders = buf.readUInt32LE(o + 12);
      if (price > 0 || quantity > 0) levels.push({ price, quantity, orders });
    }
    out.push({ side: code === 41 ? 'bid' : code === 51 ? 'ask' : 'unknown', code, segment: SEG_NAME[segCode] || String(segCode), securityId, levels });
    off += size;
  }
  return out;
}
