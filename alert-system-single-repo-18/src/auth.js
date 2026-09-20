import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { log, warn } from './config.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Decode(s) {
  s = s.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0, val = 0;
  const out = [];
  for (const ch of s) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('TOTP secret is not valid base32');
    val = ((val << 5) | i) & 0xfff;
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function totp(secret, ms = Date.now(), digits = 6, step = 30) {
  const key = base32Decode(secret);
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(Math.floor(ms / 1000 / step)));
  const h = crypto.createHmac('sha1', key).update(b).digest();
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}
function jwtExp(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return p.exp ? p.exp * 1000 : 0;
  } catch { return 0; }
}

/** Holds the Dhan access token server-side; generates / renews it. Nothing here is ever sent to the browser. */
export class DhanAuth extends EventEmitter {
  constructor(c) {
    super();
    this.c = c;
    this.clientId = c.clientId;
    this.token = c.accessToken || '';
    this.expMs = jwtExp(this.token);
    this.lastError = null;
    this.lastRefreshAt = 0;
    this.lastGenerateAt = 0;
    this.timer = null;
    this.inflight = null;
    this.profileInfo = null;
    this.profileAt = 0;
  }
  get ok() { return !!this.token && !!this.clientId && (!this.expMs || this.expMs > Date.now() + 15000); }
  get canGenerate() { return !!(this.clientId && this.c.pin && this.c.totpSecret); }

  async init() {
    if (!this.clientId) { this.lastError = 'DHAN_CLIENT_ID missing'; warn(this.lastError); return; }
    if (!this.ok) await this.refresh('startup');
    else this.schedule();
    if (this.ok) this.profile().catch(() => {});
  }

  schedule() {
    clearTimeout(this.timer);
    const until = this.expMs ? this.expMs - Date.now() - 30 * 60 * 1000 : 20 * 3600 * 1000;
    this.timer = setTimeout(() => this.refresh('scheduled'), Math.max(60000, until));
    this.timer.unref?.();
  }

  invalidate(reason) {
    warn('token invalidated:', reason);
    if (this.token && Date.now() - this.lastRefreshAt > 60000) this.refresh('invalidated: ' + reason).catch(() => {});
  }

  refresh(reason = '') {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        if (this.canGenerate && Date.now() - this.lastGenerateAt > 125000) {
          await this._generate();
        } else if (this.token && this.expMs > Date.now()) {
          await this._renew();
        } else if (!this.canGenerate) {
          throw new Error('Token expired and no PIN/TOTP configured. Set DHAN_ACCESS_TOKEN or DHAN_PIN + DHAN_TOTP_SECRET.');
        }
        this.lastError = null;
        log('Dhan token refreshed (' + reason + '), valid until', new Date(this.expMs).toISOString());
        this.emit('token', this.token);
      } catch (e) {
        this.lastError = e.message;
        warn('token refresh failed:', e.message);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.refresh('retry'), 5 * 60 * 1000);
        this.timer.unref?.();
        return;
      } finally {
        this.lastRefreshAt = Date.now();
        this.inflight = null;
      }
      this.schedule();
    })();
    return this.inflight;
  }

  async _generate() {
    this.lastGenerateAt = Date.now();
    const url = `${this.c.authBase}/app/generateAccessToken?dhanClientId=${encodeURIComponent(this.clientId)}&pin=${encodeURIComponent(this.c.pin)}&totp=${totp(this.c.totpSecret)}`;
    const r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(15000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.accessToken) throw new Error('generateAccessToken failed: ' + (d.message || d.errorMessage || d.status || r.status));
    this._set(d);
  }

  async _renew() {
    const r = await fetch(`${this.c.apiBase}/RenewToken`, {
      headers: { 'access-token': this.token, dhanClientId: this.clientId },
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.accessToken) throw new Error('RenewToken failed: ' + (d.message || d.errorMessage || r.status));
    this._set(d);
  }

  _set(d) {
    this.token = d.accessToken;
    const exp = d.expiryTime ? Date.parse(d.expiryTime.length === 19 ? d.expiryTime.replace(' ', 'T') + '+05:30' : d.expiryTime) : 0;
    this.expMs = jwtExp(this.token) || (Number.isFinite(exp) ? exp : 0) || Date.now() + 23 * 3600 * 1000;
  }

  /** GET /v2/profile: tells us whether the Data API plan is active (feed error 806 otherwise). Best-effort. */
  async profile() {
    if (this.profileInfo && Date.now() - this.profileAt < 600000) return this.profileInfo;
    try {
      const r = await fetch(`${this.c.apiBase}/profile`, { headers: { 'access-token': this.token }, signal: AbortSignal.timeout(10000) });
      const d = await r.json();
      this.profileInfo = { dataPlan: d.dataPlan ?? null, dataValidity: d.dataValidity ?? null, tokenValidity: d.tokenValidity ?? null, activeSegment: d.activeSegment ?? null };
      this.profileAt = Date.now();
    } catch { /* ignore */ }
    return this.profileInfo;
  }

  headers() {
    return { 'access-token': this.token, 'client-id': this.clientId, 'Content-Type': 'application/json', Accept: 'application/json' };
  }
  status() {
    return { authenticated: this.ok, expiresAt: this.expMs ? new Date(this.expMs).toISOString() : null, autoRenew: this.canGenerate ? 'totp' : 'renew-token', lastError: this.lastError, profile: this.profileInfo };
  }
}
