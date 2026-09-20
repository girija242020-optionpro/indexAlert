// Entry log in IndexedDB (survives refresh / browser + PWA restarts). Falls back to localStorage if IDB is unavailable.
const DB = 'idxalert', STORE = 'entries';
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    if (!('indexedDB' in window)) return rej(new Error('no indexedDB'));
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => { const s = rq.result.createObjectStore(STORE, { keyPath: 'id' }); s.createIndex('date', 'date'); s.createIndex('ts', 'ts'); };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  return dbp;
}
const LS = 'idxalert.logs';
const lsRead = () => { try { return JSON.parse(localStorage.getItem(LS) || '[]'); } catch { return []; } };

export async function addLog(entry) {
  try {
    const db = await open();
    return await new Promise((res) => {
      const tx = db.transaction(STORE, 'readwrite');
      const rq = tx.objectStore(STORE).add(entry);
      rq.onsuccess = () => res(true);
      rq.onerror = (e) => { e.preventDefault(); res(false); }; // duplicate id => already logged
    });
  } catch {
    const a = lsRead(); if (a.some((x) => x.id === entry.id)) return false;
    a.push(entry); localStorage.setItem(LS, JSON.stringify(a)); return true;
  }
}
export async function allLogs() {
  try {
    const db = await open();
    const rows = await new Promise((res, rej) => { const rq = db.transaction(STORE).objectStore(STORE).getAll(); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    return rows.sort((a, b) => b.ts - a.ts);
  } catch { return lsRead().sort((a, b) => b.ts - a.ts); }
}
export async function deleteLog(id) {
  try {
    const db = await open();
    await new Promise((res) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(id); tx.oncomplete = res; tx.onerror = res; });
  } catch { localStorage.setItem(LS, JSON.stringify(lsRead().filter((x) => x.id !== id))); }
}

const COLS = ['id', 'date', 'time', 'market', 'timeframe', 'side', 'cmp', 'candleClose', 'dema', 'rsi1', 'rsi2', 'sma1', 'sma2', 'sequence', 'oi', 'changeOi', 'volume', 'iv', 'l20Bid', 'l20Ask', 'l20Imbalance', 'ts'];
export function toCsv(rows) {
  const q = (v) => { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '\ufeff' + [COLS.join(','), ...rows.map((r) => COLS.map((c) => q(r[c])).join(','))].join('\n');
}
export function downloadCsv(rows, name) {
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
