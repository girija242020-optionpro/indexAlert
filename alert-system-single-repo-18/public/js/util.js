const tzTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const tzDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
export const fmtTime = (ms) => (ms ? tzTime.format(new Date(ms)) : '--:--:--');
export const fmtHM = (ms) => (ms ? tzTime.format(new Date(ms)).slice(0, 5) : '--:--');
export const fmtDate = (ms) => tzDate.format(new Date(ms)); // YYYY-MM-DD in IST
export const num = (v, d = 2) => (Number.isFinite(v) ? v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
export const int = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-IN') : '–');
export const compact = (v) => {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a >= 1e7) return (v / 1e7).toFixed(2) + ' Cr';
  if (a >= 1e5) return (v / 1e5).toFixed(2) + ' L';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + ' K';
  return String(Math.round(v));
};
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const TF_LABEL = { 60: '1m', 180: '3m', 300: '5m', 900: '15m' };
