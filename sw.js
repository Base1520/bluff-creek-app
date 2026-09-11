/* Cache only the public Creek app. Private and unrelated routes use the network. */
const CACHE_PREFIX = 'creek-';
const CACHE = 'creek-v19';
const SCOPE = new URL(self.registration.scope);
importScripts(new URL('./js/calendar-feed.js', SCOPE).href);
importScripts(new URL('./js/calendar-config.js', SCOPE).href);
const APP_URL = new URL('./index.html', SCOPE).href;
const EVENTS_URL = new URL('./events.json', SCOPE).href;
const ADMIN_PATH = new URL('./admin', SCOPE).pathname;
const PUBLIC_CALENDAR_URL = CreekCalendar.CSV_URL;
const ICLOUD_ENDPOINT = CREEK_PUBLIC_CALENDAR.endpoint || '';
const SHELL = [
  './index.html', './manifest.webmanifest',
  './js/calendar-feed.js', './js/calendar-config.js', './css/fonts.css', './css/connection.css',
  './js/grow-content.js', './js/grow.js', './css/grow.css',
  './js/app-status.js', './css/app-status.css',
  './assets/fonts/bitter-latin-normal-v42.woff2',
  './assets/fonts/bitter-latin-italic-500-v42.woff2',
  './assets/fonts/nunito-sans-latin-normal-v19.woff2',
  './assets/logo.png', './assets/creek.png', './assets/la63.svg',
  './assets/icon-192.png', './assets/icon-512.png',
  './assets/apple-touch-icon.png', './assets/favicon-32.png'
].map(path => new URL(path, SCOPE).href);
const ASSET_URLS = new Set(SHELL.filter(url => url !== APP_URL));

self.addEventListener('install', event => {
  // Wait for existing app windows to close so unfinished forms survive an update.
  // The live feeds are optional and must not prevent the offline shell installing.
  // Fetch this version's shell without reusing earlier HTTP-cache responses.
  const requests = SHELL.map(url => new Request(url, {
    cache: 'reload', redirect: 'error', credentials: 'omit'
  }));
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(requests)));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE)
      .map(key => caches.delete(key))
  )));
});

function isAppURL(url) {
  return url.origin === SCOPE.origin &&
    (url.pathname === SCOPE.pathname || url.pathname === new URL(APP_URL).pathname);
}

function isHTML(response) {
  return response.ok &&
    (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() === 'text/html' &&
    (!response.url || isAppURL(new URL(response.url)));
}

async function remember(url, response) {
  try {
    const cache = await caches.open(CACHE);
    await cache.put(url, response.clone());
  } catch (_) {
    // Storage failure must not hide a successful network response.
  }
}

async function cached(url, offline = false) {
  try {
    const cache = await caches.open(CACHE);
    const response = await cache.match(url);
    if (!response || !offline) return response;
    const headers = new Headers(response.headers);
    headers.set('X-Creek-Cache', 'offline');
    return new Response(response.body, {
      status: response.status, statusText: response.statusText, headers
    });
  } catch (_) {
    return undefined;
  }
}

async function validEvents(response) {
  if (!response.ok) return false;
  try {
    const data = await response.clone().json();
    // Keep recurring definitions and all other metadata; an empty array is valid.
    return data !== null && typeof data === 'object' && Array.isArray(data.events);
  } catch (_) {
    return false;
  }
}

async function validCSV(response) {
  if (!response.ok || /text\/html/i.test(response.headers.get('content-type') || '')) return false;
  try {
    // Use the same required headers and quoted-field parser as the calendar UI.
    CreekCalendar.communityRows(await response.clone().text());
    return true;
  } catch (_) {
    return false;
  }
}

async function networkFirst(request, cacheURL, validate) {
  let response;
  let failure;
  try {
    response = await fetch(request, { cache: 'no-cache' });
    if (response.headers.get('cache-control')?.match(/(?:private|no-store)/i)) return response;
    if (await validate(response)) {
      // respondWith waits for this promise, including the cache write.
      await remember(cacheURL, response);
      return response;
    }
  } catch (error) {
    failure = error;
  }
  const fallback = await cached(cacheURL, true);
  if (fallback) return fallback;
  if (response) return response;
  throw failure || new Error('The app is offline and no saved response is available.');
}

async function shellAsset(request) {
  const hit = await cached(request.url);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && !response.headers.get('cache-control')?.match(/(?:private|no-store)/i)) await remember(request.url, response);
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || (request.headers && (request.headers.has('authorization') || request.headers.has('apikey')))) return;
  const url = new URL(request.url);
  if (['access_token','refresh_token','token_hash','code'].some(key => url.searchParams.has(key))) return;
  if (ICLOUD_ENDPOINT && url.href === ICLOUD_ENDPOINT && request.mode !== 'navigate') {
    event.respondWith(networkFirst(request, ICLOUD_ENDPOINT, async response => {
      if (!response.ok) return false;
      try { return CreekCalendar.validSnapshot(await response.clone().json()); } catch (_) { return false; }
    }));
    return;
  }
  if (url.href === PUBLIC_CALENDAR_URL && request.mode !== 'navigate') {
    event.respondWith(networkFirst(request, PUBLIC_CALENDAR_URL, validCSV));
    return;
  }
  if (url.origin !== SCOPE.origin) return;
  if (url.pathname === ADMIN_PATH || url.pathname.startsWith(ADMIN_PATH + '/')) return;

  if (request.mode === 'navigate') {
    if (isAppURL(url)) event.respondWith(networkFirst(request, APP_URL, isHTML));
    return;
  }
  if (url.pathname === new URL(EVENTS_URL).pathname) {
    event.respondWith(networkFirst(request, EVENTS_URL, validEvents));
    return;
  }
  if (ASSET_URLS.has(url.href)) event.respondWith(shellAsset(request));
});
