/* Review proposal based on app main 3d001e53145cd04d0d2f249bd2f88f78570edbbd. */
/* Bluff Creek app — public shell only; staff/backend traffic stays on the network. */
const CACHE = 'creek-v4-office-safe';
const RETIRED = ['creek-v1', 'creek-v2', 'creek-v3'];
const SHELL = [
  './', './index.html', './events.json', './manifest.webmanifest',
  './assets/logo.png', './assets/creek.png', './assets/la63.svg',
  './assets/icon-192.png', './assets/icon-512.png', './assets/apple-touch-icon.png', './assets/favicon-32.png'
];
function home(url) {
  return url.origin === self.location.origin && !url.search && ['/', '/index.html'].includes(url.pathname);
}
async function put(cache, request, response) {
  // A cache/storage failure must not replace a successful network response.
  try { await cache.put(request, response.clone()); } catch (_) {}
}
self.addEventListener('install', e => {
  // Worker-owned network requests: never copy a controlled page or an older cache.
  // Reload bypasses HTTP cache; redirect:error rejects an unexpected route change.
  const requests = SHELL.map(path => new Request(new URL(path, self.location.href), {
    cache: 'reload', redirect: 'error', credentials: 'omit'
  }));
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(requests)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => RETIRED.includes(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  let path;
  try { path = decodeURIComponent(url.pathname); } catch (_) { return; }
  if (url.origin !== self.location.origin || path === '/admin' || path.startsWith('/admin/')) return;
  // Other pages and query-bearing navigation are never the public home fallback.
  if (req.mode === 'navigate' && !home(url)) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    if (req.mode === 'navigate') {
      try {
        const response = await fetch(req);
        if (response.ok && !response.redirected && home(new URL(response.url))
            && (response.headers.get('content-type') || '').toLowerCase().includes('text/html')) {
          await put(cache, './index.html', response);
        }
        return response;
      } catch (_) { return await cache.match('./index.html') || Response.error(); }
    }
    // Preserve the current public calendar's network-first behavior.
    if (url.pathname === '/events.json') {
      try {
        const response = await fetch(req);
        if (response.ok && !response.redirected) await put(cache, req, response);
        return response;
      } catch (_) { return await cache.match(req) || await cache.match('./events.json') || Response.error(); }
    }
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
      const response = await fetch(req);
      if (response.ok && !response.redirected && url.pathname.startsWith('/assets/')) await put(cache, req, response);
      return response;
    } catch (_) { return Response.error(); }
  }).catch(() => fetch(req)));
});
