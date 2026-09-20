// Beep / vibrate / notification / Web Push. Audio must be unlocked by a user gesture (Android Chrome policy).
let ctx = null;
export function unlockAudio() {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx.state;
  } catch { return 'unavailable'; }
}
const tone = (freq, start, dur, vol, type = 'square') => {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.value = freq; o.connect(g); g.connect(ctx.destination);
  const t0 = ctx.currentTime + start;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.001, vol), t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.start(t0); o.stop(t0 + dur + 0.02);
};
/** READY = two short beeps. ENTRY = three longer tones: rising for CALL, falling for PUT. */
export function beep(kind, side, volume = 0.8) {
  if (!ctx || ctx.state !== 'running') return false;
  const v = Math.min(1, Math.max(0.05, volume)) * 0.5;
  if (kind === 'READY') { tone(880, 0, 0.16, v); tone(880, 0.24, 0.16, v); }
  else {
    const f = side === 'CALL' ? [660, 880, 1175] : [1175, 880, 660];
    f.forEach((x, i) => tone(x, i * 0.28, 0.24, v));
  }
  return true;
}
export function vibrate(kind) { try { navigator.vibrate?.(kind === 'ENTRY' ? [300, 120, 300, 120, 600] : [200, 100, 200]); } catch { /* ignore */ } }

export const notifyState = () => ('Notification' in window ? Notification.permission : 'unsupported');
export async function requestNotifications() { if (!('Notification' in window)) return 'unsupported'; return Notification.requestPermission(); }

/** Local notification through the service worker (works on Android; `new Notification()` does not). */
export async function localNotify(title, body, { tag, kind } = {}) {
  if (notifyState() !== 'granted') return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, { body, tag, renotify: false, requireInteraction: kind === 'ENTRY', vibrate: kind === 'ENTRY' ? [300, 120, 300, 120, 600] : [200, 100, 200], icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: './' } });
    return true;
  } catch { return false; }
}

const b64ToU8 = (b64) => { const p = '='.repeat((4 - (b64.length % 4)) % 4); const r = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, (c) => c.charCodeAt(0)); };
/** Fetches the VAPID public key from the backend automatically (nothing to paste) and registers the subscription. */
export async function enablePush(api) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Push is not supported in this browser');
  const perm = await requestNotifications();
  if (perm !== 'granted') throw new Error('Notification permission was not granted');
  const { publicKey } = await api.get('/api/vapid-public-key');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(publicKey) });
  const { id } = await api.post('/api/subscribe-push', { subscription: sub.toJSON() });
  localStorage.setItem('idxalert.pushId', id);
  return id;
}
export const pushId = () => localStorage.getItem('idxalert.pushId');
export async function resubscribeIfGranted(api) { if (notifyState() === 'granted' && pushId()) { try { return await enablePush(api); } catch { return null; } } return null; }

export async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) { keepAwake.lock = await navigator.wakeLock.request('screen'); }
    else if (keepAwake.lock) { await keepAwake.lock.release(); keepAwake.lock = null; }
  } catch { /* not allowed (battery saver / hidden) */ }
}
