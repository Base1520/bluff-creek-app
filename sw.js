/* Bluff Creek app — service worker: cache the shell so the app opens instantly and offline. */
const CACHE = 'creek-v3';
const SHELL = [
  './', './index.html', './events.json', './manifest.webmanifest',
  './assets/logo.png', './assets/creek.png', './assets/la63.svg',
  './assets/icon-192.png', './assets/icon-512.png', './assets/apple-touch-icon.png', './assets/favicon-32.png'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // Creek Office contains private data and must never enter the public app shell cache.
  if (new URL(req.url).pathname.includes('/admin/')) return;
  // network-first for the page (so updates land), cache-first for assets/fonts
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); return r; })
      .catch(() => caches.match('./index.html')));
    return;
  }
  // The events feed must never be served stale: it is how the calendar reaches
  // phones that already installed the app. Network first, cache only as a fallback.
  if (req.url.includes('events.json')) {
    e.respondWith(fetch(req).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return r;
    }).catch(() => caches.match(req).then(hit => hit || caches.match('./events.json'))));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
    if (r.ok && (req.url.includes('/assets/') || req.url.includes('fonts.gstatic.com') || req.url.includes('fonts.googleapis.com'))) {
      const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy));
    }
    return r;
  }).catch(() => hit)));
});
