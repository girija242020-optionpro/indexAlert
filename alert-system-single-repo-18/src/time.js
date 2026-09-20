// IST helpers. NSE/BSE cash-index session: 09:15-15:30 IST, Mon-Fri.
export const SESSION_BASE = 13500; // 09:15 IST expressed as seconds-of-day in UTC (03:45)
const OFF = 19800;

export function istParts(ms = Date.now()) {
  const s = Math.floor(ms / 1000) + OFF;
  const day = Math.floor(s / 86400);
  return { dow: (day + 4) % 7, sod: s - day * 86400, day }; // dow: 0=Sun
}
export const istDateStr = (ms = Date.now()) => new Date(ms + OFF * 1000).toISOString().slice(0, 10);
export const istDateTimeStr = (ms) => new Date(ms + OFF * 1000).toISOString().slice(0, 19).replace('T', ' ');

// Wider than the session so pre-open / closing-auction ticks keep the feed "alive" logic sane.
export function marketHours(ms = Date.now()) {
  const { dow, sod } = istParts(ms);
  return dow >= 1 && dow <= 5 && sod >= 9 * 3600 && sod < 15 * 3600 + 35 * 60;
}
export function inSession(tsSec) {
  const sod = (((tsSec + OFF) % 86400) + 86400) % 86400;
  return sod >= 33300 && sod < 55800; // 09:15:00 <= t < 15:30:00
}
// Candle bucket open time (epoch seconds), aligned to 09:15 IST. Works for 60/180/300/900 s (all divide 86400).
export const bucketStart = (tsSec, tf) => Math.floor((tsSec - SESSION_BASE) / tf) * tf + SESSION_BASE;
