export class Api {
  constructor(base, key) { this.base = (base || '').trim().replace(/\/+$/, ''); this.key = (key || '').trim(); }
  get ok() { return /^https?:\/\//i.test(this.base); }
  headers(extra = {}) { return this.key ? { 'x-api-key': this.key, ...extra } : extra; }
  async get(path, timeout = 20000) {
    const r = await fetch(this.base + path, { headers: this.headers(), cache: 'no-store', signal: AbortSignal.timeout(timeout) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 202) throw Object.assign(new Error(d.error || `HTTP ${r.status}`), { status: r.status });
    d._status = r.status;
    return d;
  }
  async post(path, body, timeout = 15000) {
    const r = await fetch(this.base + path, { method: 'POST', headers: this.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body || {}), signal: AbortSignal.timeout(timeout) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || `HTTP ${r.status}`), { status: r.status });
    return d;
  }
  wsUrl() {
    const u = new URL(this.base);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws'; u.search = '';
    if (this.key) u.searchParams.set('key', this.key);
    return u.toString();
  }
}
