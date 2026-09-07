const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const workerSource = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

function harness(scope = 'https://app.example.test/') {
  const handlers = {};
  const stores = new Map();
  const calls = [];
  const state = {
    scope, calls, stores, installed: [], skipWaiting: 0, claimed: 0,
    fetch: async () => { throw new Error('Network offline'); },
    beforePut: async () => {}
  };
  const key = request => new URL(typeof request === 'string' ? request : request.url, scope).href;
  async function open(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      match: async request => store.get(key(request))?.clone(),
      put: async (request, response) => {
        await state.beforePut();
        store.set(key(request), response.clone());
      },
      addAll: async urls => { state.installed.push(...urls); }
    };
  }
  const context = {
    URL, Headers, Request, Response,
    importScripts: url => {
      assert.equal(url, new URL('js/calendar-feed.js', scope).href);
      vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'calendar-feed.js'), 'utf8'), context);
    },
    self: {
      registration: { scope },
      addEventListener: (name, handler) => { handlers[name] = handler; },
      skipWaiting: async () => { state.skipWaiting++; },
      clients: { claim: async () => { state.claimed++; } }
    },
    caches: {
      open,
      keys: async () => [...stores.keys()],
      delete: async name => stores.delete(name)
    },
    fetch: async (...args) => { calls.push(args); return state.fetch(...args); }
  };
  vm.runInNewContext(workerSource, context, { filename: 'sw.js' });
  state.cacheName = vm.runInNewContext('CACHE', context);
  state.calendarURL = vm.runInNewContext('PUBLIC_CALENDAR_URL', context);
  state.seed = async (url, response, name = state.cacheName) => (await open(name)).put(url, response);
  state.read = async url => (await open(state.cacheName)).match(url);
  state.dispatch = (pathname, options = {}) => {
    const request = { method: 'GET', mode: 'cors', url: key(pathname), ...options };
    let promise;
    handlers.fetch({ request, respondWith: value => { promise = value; } });
    return { handled: promise !== undefined, response: promise };
  };
  state.lifecycle = async name => {
    let promise;
    handlers[name]({ waitUntil: value => { promise = value; } });
    await promise;
  };
  return state;
}

const html = text => new Response(text, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const feed = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const csv = value => new Response(value, { headers: { 'Content-Type': 'text/csv' } });

for (const scope of ['https://app.example.test/', 'http://localhost:8080/church/']) {
  test(`route isolation and installation paths: ${scope}`, async () => {
    const worker = harness(scope);
    for (const pathname of [
      'admin', 'admin/', 'admin/index.html', 'admin/events.json', 'brand/',
      'unrelated', 'other/events.json', 'events.json.bak',
      'https://api.example.test/events.json', 'https://fonts.googleapis.com/css2?family=Bitter'
    ]) {
      assert.equal(worker.dispatch(pathname).handled, false, pathname);
      assert.equal(worker.dispatch(pathname, { mode: 'navigate' }).handled, false, `navigation: ${pathname}`);
    }
    assert.equal(worker.dispatch('?next=events.json').handled, false);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      assert.equal(worker.dispatch('events.json', { method }).handled, false);
      assert.equal(worker.dispatch(worker.calendarURL, { method }).handled, false);
    }
    await worker.lifecycle('install');
    assert(worker.installed.includes(new URL('index.html', scope).href));
    assert(worker.installed.includes(new URL('js/calendar-feed.js', scope).href));
    assert(worker.installed.includes(new URL('js/app-forms.js', scope).href));
    assert(worker.installed.includes(new URL('css/fonts.css', scope).href));
    assert(!worker.installed.some(url => url.includes('events.json') || url.includes('/admin')));
    assert.equal(worker.skipWaiting, 0);
  });

  test(`valid events replace the feed, including an explicit empty array: ${scope}`, async () => {
    const worker = harness(scope);
    await worker.seed('events.json', feed({ events: [{ title: 'Old' }] }));
    for (const value of [
      { events: [{ title: 'Current' }], recurring: [{ weekday: 0 }] },
      { events: [] }
    ]) {
      worker.fetch = async () => feed(value);
      const response = await worker.dispatch('events.json?refresh=1').response;
      assert.deepEqual(await response.json(), value);
      assert.deepEqual(await (await worker.read('events.json')).json(), value);
      assert.equal(response.headers.get('X-Creek-Cache'), null);
    }
    assert.equal(worker.calls.length, 2);
    assert.equal(worker.calls[0][1].cache, 'no-cache');
  });

  test(`last good feed survives HTTP, JSON and network failures: ${scope}`, async () => {
    const worker = harness(scope);
    const value = { events: [{ title: 'Last good' }] };
    await worker.seed('events.json', feed(value));
    for (const failure of [
      () => new Response('Missing', { status: 404 }),
      () => new Response('Outage', { status: 503 }),
      () => new Response('not JSON'),
      () => feed({ events: null }),
      () => feed([]),
      () => { throw new Error('offline'); }
    ]) {
      worker.fetch = failure;
      const response = await worker.dispatch('events.json').response;
      assert.deepEqual(await response.json(), value);
      assert.equal(response.headers.get('X-Creek-Cache'), 'offline');
      const saved = await worker.read('events.json');
      assert.deepEqual(await saved.json(), value);
      assert.equal(saved.headers.get('X-Creek-Cache'), null);
    }
  });

  test(`only successful app HTML replaces the offline page: ${scope}`, async () => {
    const worker = harness(scope);
    await worker.seed('index.html', html('Initial app'));
    worker.fetch = async () => html('Current app');
    assert.equal(await (await worker.dispatch('./', { mode: 'navigate' }).response).text(), 'Current app');
    assert.equal(await (await worker.read('index.html')).text(), 'Current app');
    for (const failure of [
      () => new Response('Missing', { status: 404 }),
      () => new Response('Outage', { status: 503 }),
      () => feed({ different: 'resource' }),
      () => { throw new Error('offline'); }
    ]) {
      worker.fetch = failure;
      const response = await worker.dispatch('index.html', { mode: 'navigate' }).response;
      assert.equal(await response.text(), 'Current app');
      assert.equal(response.headers.get('X-Creek-Cache'), 'offline');
      assert.equal(await (await worker.read('index.html')).text(), 'Current app');
    }
    const redirected = html('Unrelated landing page');
    Object.defineProperty(redirected, 'url', { value: new URL('brand/', scope).href });
    worker.fetch = async () => redirected;
    assert.equal(await (await worker.dispatch('./', { mode: 'navigate' }).response).text(), 'Current app');
  });
}

test('only the approved public CSV uses the network-first calendar cache', async () => {
  const worker = harness();
  const initial = 'title,date,start,location,type\n"Sunday School, all ages",2026-09-06,9:00a,Church,Add a new event';
  worker.fetch = async () => csv(initial);
  assert.equal(await (await worker.dispatch(worker.calendarURL).response).text(), initial);
  for (const failure of [
    () => new Response('Down', { status: 503 }),
    () => html('<html>Sign in, please</html>'),
    () => csv(''),
    () => csv('<html>Error, retry</html>'),
    () => csv('error,try again'),
    () => csv('"title,date,start,location,type'),
    () => { throw new Error('offline'); }
  ]) {
    worker.fetch = failure;
    const response = await worker.dispatch(worker.calendarURL).response;
    assert.equal(await response.text(), initial);
    assert.equal(response.headers.get('X-Creek-Cache'), 'offline');
  }
  worker.fetch = async () => csv('title,date,start,location,type');
  assert.equal(await (await worker.dispatch(worker.calendarURL).response).text(), 'title,date,start,location,type');
  assert.equal(await (await worker.read(worker.calendarURL)).text(), 'title,date,start,location,type');
  for (const url of [worker.calendarURL + '&extra=1', worker.calendarURL.replace('gid=0', 'gid=1'), 'https://docs.google.com/private']) {
    assert.equal(worker.dispatch(url).handled, false, url);
  }
  assert.equal(worker.dispatch(worker.calendarURL, { mode: 'navigate' }).handled, false);
});

test('without a cached fallback, preserve real responses and reject network failure', async () => {
  const calendarURL = harness().calendarURL;
  for (const [url, options] of [['events.json', {}], [calendarURL, {}], ['index.html', { mode: 'navigate' }], ['assets/logo.png', {}]]) {
    const worker = harness();
    worker.fetch = async () => new Response('Unavailable', { status: 503 });
    const response = await worker.dispatch(url, options).response;
    assert.equal(response.status, 503);
    assert.equal(await response.text(), 'Unavailable');
    worker.fetch = async () => { throw new Error('Network offline'); };
    await assert.rejects(worker.dispatch(url, options).response, /Network offline/);
  }
});

test('every precached shell asset exists in the public build', async () => {
  const worker = harness();
  await worker.lifecycle('install');
  for (const url of worker.installed) {
    const file = path.join(__dirname, '..', decodeURIComponent(new URL(url).pathname));
    assert(fs.statSync(file).isFile(), `Missing shell asset: ${url}`);
  }
});

test('the response lifetime awaits cache writes, and storage failure preserves fresh data', async () => {
  const worker = harness();
  let release;
  let started;
  const writing = new Promise(resolve => { started = resolve; });
  worker.beforePut = () => { started(); return new Promise(resolve => { release = resolve; }); };
  worker.fetch = async () => feed({ events: [{ title: 'Current' }] });
  let settled = false;
  const response = worker.dispatch('events.json').response.then(result => { settled = true; return result; });
  await writing;
  assert.equal(settled, false);
  release();
  await response;
  assert.deepEqual(await (await worker.read('events.json')).json(), { events: [{ title: 'Current' }] });
  worker.beforePut = async () => { throw new Error('Quota exceeded'); };
  worker.fetch = async () => feed({ events: [] });
  assert.deepEqual(await (await worker.dispatch('events.json').response).json(), { events: [] });
});

test('activation only deletes old Creek caches and does not claim open clients', async () => {
  const worker = harness();
  await worker.seed('index.html', html('Old'), 'creek-v3');
  await worker.seed('index.html', html('New'));
  await worker.seed('unrelated', new Response('Keep'), 'other-application');
  await worker.lifecycle('activate');
  assert.deepEqual([...worker.stores.keys()].sort(), ['creek-v4', 'other-application']);
  assert.equal(worker.claimed, 0);
});

test('cached assets are isolated to the current app cache and exact allowlist', async () => {
  const worker = harness();
  await worker.seed('assets/logo.png', new Response('Other app logo'), 'other-application');
  worker.fetch = async () => new Response('Current logo');
  assert.equal(await (await worker.dispatch('assets/logo.png').response).text(), 'Current logo');
  assert.equal(worker.calls.length, 1);
  worker.fetch = async () => { throw new Error('offline'); };
  assert.equal(await (await worker.dispatch('assets/logo.png').response).text(), 'Current logo');
  assert.equal(worker.calls.length, 1);
  assert.equal(worker.dispatch('assets/not-public.json').handled, false);
  assert.equal(worker.dispatch('assets/logo.png?different=1').handled, false);
});
