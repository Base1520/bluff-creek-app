const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const workerSource = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

function harness(scope = 'https://app.example.test/', endpoint = '') {
  const handlers = {};
  const stores = new Map();
  const calls = [];
  const state = {
    scope, calls, stores, installed: [], installedRequests: [], skipWaiting: 0, claimed: 0,
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
      addAll: async requests => { state.installedRequests.push(...requests); state.installed.push(...requests.map(key)); }
    };
  }
  const context = {
    URL, Headers, Request, Response,
    importScripts: url => {
      const file = url === new URL('js/calendar-config.js', scope).href ? 'calendar-config.js' : 'calendar-feed.js';
      assert.equal(url, new URL('js/' + file, scope).href);
      vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8'), context);
      if (file === 'calendar-config.js') context.CREEK_PUBLIC_CALENDAR.endpoint = endpoint;
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

test('only the exact configured public iCloud adapter is cached, preserving the last valid sanitized feed', async () => {
  const endpoint='https://church.example.test/functions/v1/public-calendar';
  const worker=harness('https://app.example.test/',endpoint);
  for (const url of ['https://church.example.test/rest/v1/contacts','https://church.example.test/auth/v1/user',endpoint+'?url=private',endpoint+'/extra']) assert.equal(worker.dispatch(url).handled,false);
  const current={source:'icloud',updated:'2026-09-13',synced_at:'2026-09-13T14:00:00.000Z',valid_until:'2026-12-11',events:[],recurring:[]};
  worker.fetch=async()=>feed(current);
  assert.deepEqual(await(await worker.dispatch(endpoint).response).json(),current);
  worker.fetch=async()=>feed({events:[]});
  const cached=await worker.dispatch(endpoint).response;
  assert.equal(cached.headers.get('X-Creek-Cache'),'offline');
  assert.deepEqual(await cached.json(),current);
  assert.equal(worker.dispatch(endpoint,{mode:'navigate'}).handled,false);
});

for (const scope of ['https://app.example.test/', 'http://localhost:8080/church/']) {
  test(`route isolation and installation paths: ${scope}`, async () => {
    const worker = harness(scope);
    for (const pathname of [
      'admin', 'admin/', 'admin/index.html', 'admin/events.json', 'brand/',
      'connection.html', 'connection.html?code=sample', 'js/connection.js', 'js/connection-config.js',
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
    assert(worker.installed.includes(new URL('css/connection.css', scope).href));
    assert(!worker.installed.includes(new URL('js/connection.js', scope).href));
    assert(worker.installed.includes(new URL('css/fonts.css', scope).href));
    assert(worker.installed.includes(new URL('js/app-status.js', scope).href));
    assert(worker.installed.includes(new URL('css/app-status.css', scope).href));
    assert(!worker.installed.some(url => url.includes('events.json') || url.includes('/admin')));
    assert.equal(worker.installed.length, 21);
    for (const request of worker.installedRequests) {
      assert(request instanceof Request, 'Installation must use worker-owned Requests.');
      assert.equal(new URL(request.url).origin, new URL(scope).origin);
      assert.equal(request.cache, 'reload', 'A fresh older home in HTTP cache must not seed the new shell.');
      assert.equal(request.redirect, 'error', 'Unexpected redirects must fail shell installation.');
      assert.equal(request.credentials, 'omit', 'Public shell requests must not carry account credentials.');
    }
    assert.equal(worker.skipWaiting, 0);
    assert.equal(worker.claimed, 0);
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
  await worker.seed('js/grow.js', new Response('Previous Grow script'), 'creek-v14');
  await worker.seed('index.html', html('New'));
  await worker.seed('unrelated', new Response('Keep'), 'other-application');
  await worker.lifecycle('activate');
  assert.deepEqual([...worker.stores.keys()].sort(), [worker.cacheName, 'other-application'].sort());
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


test('authenticated requests and sensitive URL credentials bypass every public cache route', async () => {
  const endpoint='https://church.example.test/functions/v1/public-calendar';
  const worker=harness('https://app.example.test/',endpoint);
  for(const pathname of ['index.html','events.json','js/grow.js',endpoint,worker.calendarURL]){
    for(const name of ['Authorization','apikey'])assert.equal(worker.dispatch(pathname,{headers:new Headers({[name]:'synthetic'})}).handled,false);
  }
  for(const key of ['access_token','refresh_token','token_hash','code'])assert.equal(worker.dispatch('index.html?'+key+'=synthetic',{mode:'navigate'}).handled,false);
  for(const path of ['connection.html','js/connection.js','js/connection-config.js','https://sample.supabase.co/rest/v1/rpc/register_app_guest','https://sample.supabase.co/functions/v1/welcome-dispatch'])assert.equal(worker.dispatch(path).handled,false);
});
test('private or no-store network responses are returned without public-cache writes', async () => {
  for(const control of ['private, max-age=0','no-store']){
    const worker=harness();worker.fetch=async()=>new Response('Private synthetic HTML',{headers:{'Content-Type':'text/html','Cache-Control':control}});
    const response=await worker.dispatch('index.html',{mode:'navigate'}).response;assert.equal(await response.text(),'Private synthetic HTML');assert.equal(await worker.read('index.html'),undefined);
    worker.fetch=async()=>new Response('Private synthetic script',{headers:{'Cache-Control':control}});await worker.dispatch('js/grow.js').response;assert.equal(await worker.read('js/grow.js'),undefined);
  }
});
