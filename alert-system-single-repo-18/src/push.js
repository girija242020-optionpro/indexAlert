import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import webpush from 'web-push';
import { config, warn } from './config.js';

/** Web Push (VAPID). Subscriptions live in memory + a JSON file; the PWA re-registers on every start, so an ephemeral disk is fine. */
export class PushService {
  constructor() {
    this.enabled = !!(config.vapid.publicKey && config.vapid.privateKey);
    this.subs = new Map();
    this.sent = new Map(); // eventId -> ts (dedupe)
    this.file = path.join(config.dataDir, 'subscriptions.json');
    if (this.enabled) {
      try { webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey); }
      catch (e) { this.enabled = false; warn('VAPID keys invalid:', e.message); }
    } else warn('VAPID keys not set: Web Push disabled');
    try { for (const s of JSON.parse(fs.readFileSync(this.file, 'utf8'))) this.subs.set(s.id, s); } catch { /* first run */ }
  }
  get publicKey() { return config.vapid.publicKey; }
  _save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => {
      try { fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(this.file, JSON.stringify([...this.subs.values()])); } catch { /* ignore */ }
    }, 500);
  }
  add(subscription, meta = {}) {
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) throw new Error('invalid subscription');
    const id = crypto.createHash('sha256').update(subscription.endpoint).digest('hex').slice(0, 16);
    this.subs.set(id, { id, subscription, createdAt: Date.now(), ua: String(meta.ua || '').slice(0, 120) });
    this._save();
    return id;
  }
  remove(id) { this.subs.delete(id); this._save(); }
  count() { return this.subs.size; }

  async send(payload, id = null) {
    if (!this.enabled) throw new Error('Web Push not configured (VAPID keys missing)');
    const targets = id ? [this.subs.get(id)].filter(Boolean) : [...this.subs.values()];
    const body = JSON.stringify(payload);
    let ok = 0, failed = 0;
    await Promise.all(targets.map(async (t) => {
      try { await webpush.sendNotification(t.subscription, body, { TTL: 120, urgency: 'high' }); ok++; }
      catch (e) {
        failed++;
        if (e.statusCode === 404 || e.statusCode === 410) this.remove(t.id);
        else warn('push failed:', e.statusCode || e.message);
      }
    }));
    return { ok, failed, targets: targets.length };
  }

  /** De-duplicated by eventId so a retry from the PWA never double-notifies. */
  async notify(payload, id = null) {
    if (payload.eventId) {
      const now = Date.now();
      for (const [k, v] of this.sent) if (now - v > 600000) this.sent.delete(k);
      const k = `${id || '*'}|${payload.eventId}`;
      if (this.sent.has(k)) return { ok: 0, failed: 0, targets: 0, duplicate: true };
      this.sent.set(k, now);
    }
    return this.send(payload, id);
  }
}
