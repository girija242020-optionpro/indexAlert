// Service worker: app-shell cache (offline start) + Web Push display. API traffic is never cached.
const VERSION = 'v1.1.0';
const CACHE = 'idxalert-' + VERSION;
const SHELL = ['./', 'index.html', 'manifest.json', 'css/app.css', 'js/app.js', 'js/ui.js', 'js/engine.js', 'js/candles.js', 'js/api.js', 'js/alerts.js', 'js/logdb.js', 'js/context.js', 'js/settings.js', 'js/util.js', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('idxalert-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // backend / third-party: straight to network
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz' || url.pathname === '/ws') return; // same-origin backend: never cache
  // network-first so a new deploy is picked up immediately; cache is the offline fallback
  e.respondWith(fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; }).catch(() => caches.match(req).then((m) => m || caches.match('index.html'))));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Alert', body: e.data ? e.data.text() : '' }; }
  const entry = d.kind === 'ENTRY';
  e.waitUntil(self.registration.showNotification(d.title || 'Alert', {
    body: d.body || '', tag: d.tag || 'alert', renotify: false, requireInteraction: entry,
    vibrate: entry ? [300, 120, 300, 120, 600] : [200, 100, 200],
    icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: './' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    const c = cs.find((x) => 'focus' in x);
    return c ? c.focus() : self.clients.openWindow(self.registration.scope);
  }));
});
