import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('./sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://app.bluffcreekbaptistchurch.org';
const CACHE = 'creek-v4-office-safe';
const MAIN_SHELL = ['/', '/index.html', '/events.json', '/manifest.webmanifest', '/assets/logo.png', '/assets/creek.png', '/assets/la63.svg', '/assets/icon-192.png', '/assets/icon-512.png', '/assets/apple-touch-icon.png', '/assets/favicon-32.png'];
const absolute = value => new URL(typeof value === 'string' ? value : value.url, ORIGIN + '/').href;
function response(body = 'public home', { url = ORIGIN + '/index.html', status = 200, type = 'text/html', redirected = false } = {}) {
  const result = new Response(body, { status, headers: { 'content-type': type } });
  Object.defineProperties(result, { url: { value: url }, redirected: { value: redirected } });
  return result;
}
function harness() {
  const stores = new Map(), events = {}, calls = { fetch: [], put: [], install: [], deleted: [], opened: [], skipped: 0, claimed: 0 };
  const h = { calls, stores, network: async req => response('fresh network', { url: absolute(req) }), installError: false, putError: false, openError: false };
  const store = name => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name); };
  const caches = {
    async open(name) {
      calls.opened.push(name);
      if (h.openError) throw new Error('cache storage unavailable');
      const data = store(name);
      return {
        async match(req) { return data.get(absolute(req))?.clone(); },
        async put(req, res) { if (h.putError) throw new Error('quota'); calls.put.push({ cache: name, url: absolute(req) }); data.set(absolute(req), res.clone()); },
        async addAll(requests) {
          calls.install.push(...requests);
          if (h.installError) throw new Error('network');
          // Native worker Cache.addAll uses its own network fetch, never a client response.
          const fetched = await Promise.all(requests.map(async req => [req, await h.network(req)]));
          for (const [req, res] of fetched) { if (!res.ok) throw new Error('failed shell'); data.set(absolute(req), res.clone()); }
        }
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { calls.deleted.push(name); return stores.delete(name); },
    async match() { throw new Error('Global cache matching could read retired private-contaminated data.'); }
  };
  const self = { location: new URL('/sw.js', ORIGIN), addEventListener: (name, callback) => { events[name] = callback; }, skipWaiting: async () => { calls.skipped++; }, clients: { claim: async () => { calls.claimed++; } } };
  vm.runInNewContext(source, { self, caches, URL, Request, Response, fetch: async req => { calls.fetch.push(absolute(req)); return h.network(req); } }, { filename: 'proposed-sw.js' });
  h.seed = (name, path, value) => store(name).set(absolute(path), response(value));
  h.read = async (name, path) => stores.get(name)?.get(absolute(path))?.clone().text();
  h.lifecycle = async name => { let pending; events[name]({ waitUntil(promise) { pending = promise; } }); await pending; };
  h.send = async (path, { mode = 'navigate', method = 'GET' } = {}) => {
    let pending;
    events.fetch({ request: { url: absolute(path), method, mode }, respondWith(promise) { assert.equal(pending, undefined); pending = promise; } });
    return pending === undefined ? undefined : await pending;
  };
  return h;
}

test('install seeds exactly the main public shell from fresh worker requests, not an old controlled-page cache', async () => {
  const h = harness(); h.seed('creek-v3', '/index.html', 'old office HTML');
  await h.lifecycle('install');
  assert.deepEqual(h.calls.install.map(req => new URL(req.url).pathname), MAIN_SHELL);
  for (const req of h.calls.install) { assert.equal(req.cache, 'reload'); assert.equal(req.redirect, 'error'); assert.equal(req.credentials, 'omit'); }
  assert.equal(await h.read(CACHE, '/index.html'), 'fresh network');
  assert.equal(await h.read('creek-v3', '/index.html'), 'old office HTML');
  assert.equal(h.calls.skipped, 1);
});

test('a failed install does not skip the old worker or claim update success', async () => {
  const h = harness(); h.installError = true;
  await assert.rejects(h.lifecycle('install')); assert.equal(h.calls.skipped, 0); assert.equal(h.calls.claimed, 0);
});

test('activation retires only previous public versions and claims clients after cleanup', async () => {
  const h = harness();
  for (const name of ['creek-v1', 'creek-v2', 'creek-v3', CACHE, 'unrelated-cache']) h.seed(name, '/', name);
  await h.lifecycle('activate');
  assert.deepEqual(h.calls.deleted, ['creek-v1', 'creek-v2', 'creek-v3']);
  assert.deepEqual([...h.stores.keys()], [CACHE, 'unrelated-cache']); assert.equal(h.calls.claimed, 1);
});

test('admin pages, resources and encoded admin paths bypass all worker cache/network handling', async () => {
  const h = harness();
  for (const path of ['/admin', '/admin/', '/admin/recovery.html?code=synthetic', '/admin/app.js', '/%61dmin/recovery.html', '/admin%2Frecovery.html']) {
    assert.equal(await h.send(path), undefined);
    assert.equal(await h.send(path, { mode: 'cors' }), undefined);
  }
  assert.deepEqual(h.calls.fetch, []); assert.deepEqual(h.calls.opened, []);
});

test('cross-origin backends, asset-looking URLs and CDN fonts bypass all worker handling', async () => {
  const h = harness();
  for (const url of ['https://fictional.supabase.co/storage/v1/object/assets/page.png', 'https://cdn.jsdelivr.net/assets/sdk.js', 'https://fonts.gstatic.com/font.woff2']) assert.equal(await h.send(url, { mode: 'cors' }), undefined);
  assert.deepEqual(h.calls.fetch, []); assert.deepEqual(h.calls.opened, []);
});

test('non-home and query-bearing navigation never receives public-home fallback', async () => {
  const h = harness(); h.seed(CACHE, '/index.html', 'cached public home'); h.network = async () => { throw new Error('offline'); };
  for (const path of ['/brand/', '/brand/social/index.html', '/other.html', '/?code=synthetic', '/index.html?preview=review']) assert.equal(await h.send(path), undefined);
  assert.deepEqual(h.calls.opened, []);
});

test('POST requests are never intercepted', async () => { const h = harness(); assert.equal(await h.send('/', { method: 'POST' }), undefined); assert.deepEqual(h.calls.opened, []); });

test('successful exact root and index HTML navigation updates only the new public home cache', async () => {
  for (const path of ['/', '/index.html']) {
    const h = harness(); h.network = async () => response('fresh home', { url: ORIGIN + path });
    assert.equal(await (await h.send(path)).text(), 'fresh home');
    assert.equal(await h.read(CACHE, '/index.html'), 'fresh home');
    assert.deepEqual(h.calls.put, [{ cache: CACHE, url: ORIGIN + '/index.html' }]);
  }
});

test('HTTP errors, redirects, wrong final routes and non-HTML responses never overwrite home', async () => {
  for (const config of [{ status: 404 }, { status: 503 }, { redirected: true, url: ORIGIN + '/admin/' }, { url: ORIGIN + '/other.html' }, { type: 'application/json' }]) {
    const h = harness(); h.seed(CACHE, '/index.html', 'safe home'); h.network = async () => response('not home', config);
    assert.equal(await (await h.send('/')).text(), 'not home'); assert.equal(await h.read(CACHE, '/index.html'), 'safe home'); assert.deepEqual(h.calls.put, []);
  }
});

test('offline home reads only the new cache even if an old in-flight worker recreates its retired cache', async () => {
  const h = harness(); h.seed('creek-v3', '/index.html', 'office HTML'); h.seed(CACHE, '/index.html', 'safe public home');
  await h.lifecycle('activate'); h.seed('creek-v3', '/index.html', 'late old-worker office HTML');
  h.network = async () => { throw new Error('offline'); };
  assert.equal(await (await h.send('/')).text(), 'safe public home');
});

test('a missing new-cache home never falls back to stale content from another cache', async () => {
  const h = harness(); h.seed('creek-v3', '/index.html', 'old office HTML'); h.network = async () => { throw new Error('offline'); };
  assert.equal((await h.send('/')).type, 'error');
});

test('events remain network first, do not cache HTTP errors, and use only the current offline feed', async () => {
  const h = harness(); h.seed(CACHE, '/events.json', 'old feed');
  h.network = async () => response('fresh feed', { url: ORIGIN + '/events.json', type: 'application/json' });
  assert.equal(await (await h.send('/events.json', { mode: 'cors' })).text(), 'fresh feed');
  h.network = async () => response('outage', { status: 503 }); await h.send('/events.json', { mode: 'cors' });
  assert.equal(await h.read(CACHE, '/events.json'), 'fresh feed');
  h.network = async () => { throw new Error('offline'); };
  assert.equal(await (await h.send('/events.json', { mode: 'cors' })).text(), 'fresh feed');
});

test('same-origin asset caching cannot be triggered by an asset-looking query on another path', async () => {
  const h = harness();
  await h.send('/other.json?path=/assets/private', { mode: 'cors' }); assert.deepEqual(h.calls.put, []);
  await h.send('/assets/logo.png', { mode: 'cors' }); assert.equal(h.calls.put.length, 1);
  const count = h.calls.fetch.length; await h.send('/assets/logo.png', { mode: 'cors' }); assert.equal(h.calls.fetch.length, count);
});

test('cache quota errors do not discard a successful homepage response', async () => {
  const h = harness(); h.putError = true; h.network = async () => response('available home');
  assert.equal(await (await h.send('/')).text(), 'available home');
});

test('unavailable CacheStorage still returns the successful public network response', async () => {
  const h = harness(); h.openError = true; h.network = async () => response('live public response');
  for (const [path, mode] of [['/', 'navigate'], ['/events.json', 'cors'], ['/assets/logo.png', 'cors']]) {
    assert.equal(await (await h.send(path, { mode })).text(), 'live public response');
  }
  assert.equal(h.calls.fetch.length, 3);
  assert.deepEqual(h.calls.put, []);
});
