// Offline shell only. API responses are never cached here; durable counter
// state and exact pending requests are owned by IndexedDB in the foreground UI.
const CACHE = 'displayapp-shell-v19.0';
const FILES = ['/', '/counter-core-v19.js', '/counter-browser-v19.js', '/history-v18.js'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('displayapp-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.mode !== 'navigate' && !FILES.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request.mode === 'navigate' ? '/' : url.pathname, copy))); }
    return response;
  }).catch(async () => (await caches.match(event.request.mode === 'navigate' ? '/' : url.pathname)) || Response.error()));
});
