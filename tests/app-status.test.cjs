const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initialize } = require('../js/app-status.js');

function emitter(extra = {}) {
  const handlers = {};
  return Object.assign({
    addEventListener(name, fn) { (handlers[name] ||= []).push(fn); },
    emit(name) { (handlers[name] || []).forEach(fn => fn()); },
    handlers
  }, extra);
}
function worker(state = 'installing') { return emitter({ state }); }
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  const nodes = Object.fromEntries(['appStatus', 'appOffline', 'appUpdate', 'appSaveStatus'].map(id => [id, {hidden:true, textContent:'', dataset:{}}]));
  const registration = emitter({ installing:null, waiting:null, ...options.registration });
  const calls = [];
  const navigator = { onLine: options.online ?? true };
  if (options.supported !== false) navigator.serviceWorker = {
    controller: options.controller === false ? null : {},
    register(...args) { calls.push(args); if(options.failure)throw Error('Unavailable'); return Promise.resolve(registration); }
  };
  const win = emitter({navigator});
  for(const name of ['location','localStorage','sessionStorage']) Object.defineProperty(win,name,{get(){throw Error(`Status must not access ${name}`);}});
  const doc = emitter({ defaultView:win, readyState:options.readyState || 'complete', getElementById(id) { assert(id in nodes, `Unexpected document read: ${id}`); return nodes[id]; } });
  initialize(doc);
  return { nodes, registration, navigator, win, doc, calls };
}

test('initial offline state is visible without service workers and reconnect clears only connection guidance', async () => {
  const f = fixture({ online:false, supported:false });
  assert.equal(f.nodes.appStatus.hidden,false);
  assert.match(f.nodes.appOffline.textContent,/Previously saved pages may/);
  assert.match(f.nodes.appOffline.textContent,/Keep any unsent entries open/);
  f.navigator.onLine=true;f.win.emit('online');
  assert.equal(f.nodes.appStatus.hidden,true);
  f.navigator.onLine=false;f.doc.emit('visibilitychange');
  assert.equal(f.nodes.appOffline.hidden,false);
  await flush();assert.equal(f.calls.length,0);
});

test('a waiting replacement gets persistent instructions and survives offline/reconnect without a reload', async () => {
  const next = worker('installed');
  const f = fixture({ registration:{waiting:next} });
  await flush();
  assert.equal(f.nodes.appUpdate.hidden,false);
  assert.match(f.nodes.appUpdate.textContent,/Finish with any unsent entries first/);
  assert.match(f.nodes.appUpdate.textContent,/close all Creek app windows/);
  f.navigator.onLine=false;f.win.emit('offline');
  assert.equal(f.nodes.appUpdate.hidden,false);
  assert.equal(f.nodes.appOffline.hidden,false);
  f.navigator.onLine=true;f.win.emit('online');
  assert.equal(f.nodes.appUpdate.hidden,false);
  assert.equal(f.nodes.appOffline.hidden,true);
  next.state='activated';next.emit('statechange');
  assert.equal(f.nodes.appUpdate.hidden,true);
  assert.deepEqual(f.calls,[['sw.js',{updateViaCache:'none'}]]);
});

test('an installation already underway at registration is observed, including the waiting-property transition', async () => {
  const next=worker();
  const f=fixture({registration:{installing:next}});
  await flush();assert.equal(f.nodes.appUpdate.hidden,true);
  next.state='installed';next.emit('statechange');
  assert.equal(f.nodes.appUpdate.hidden,false);
  f.registration.waiting=next;f.registration.installing=null;
  next.emit('statechange');
  assert.equal(f.nodes.appUpdate.hidden,false);
});

test('a later update is observed once; failed or superseded workers never remain ready', async () => {
  const f=fixture();await flush();
  const next=worker();f.registration.installing=next;f.registration.emit('updatefound');f.registration.emit('updatefound');
  assert.equal(next.handlers.statechange.length,1);
  next.state='redundant';next.emit('statechange');
  assert.equal(f.nodes.appUpdate.hidden,true);
  const newer=worker();f.registration.installing=newer;f.registration.emit('updatefound');
  newer.state='installed';newer.emit('statechange');
  assert.equal(f.nodes.appUpdate.hidden,false);
  newer.state='redundant';newer.emit('statechange');
  assert.equal(f.nodes.appUpdate.hidden,true);
});

test('first installation is not called an update and unsupported browsers do not claim offline storage', async () => {
  const first=worker('installed');
  const f=fixture({controller:false,registration:{waiting:first}});await flush();
  assert.equal(f.nodes.appStatus.hidden,true);
  const other=fixture({supported:false});await flush();
  assert.equal(other.nodes.appStatus.hidden,true);
  assert.equal(other.calls.length,0);
});

test('registration failure remains an honest persistent limitation without hiding offline guidance', async () => {
  const f=fixture({failure:true});await flush();
  assert.equal(f.nodes.appSaveStatus.hidden,false);
  assert.match(f.nodes.appSaveStatus.textContent,/couldn’t confirm offline access on this visit/);
  assert.equal(f.nodes.appUpdate.hidden,true);
  f.navigator.onLine=false;f.win.emit('offline');
  assert.equal(f.nodes.appSaveStatus.hidden,true);
  assert.equal(f.nodes.appOffline.hidden,false);
  f.navigator.onLine=true;f.win.emit('online');
  assert.equal(f.nodes.appSaveStatus.hidden,false);
});

test('registration waits for load when needed and repeated initialization does not create duplicate handlers', async () => {
  const f=fixture({readyState:'loading'});initialize(f.doc);await flush();
  assert.equal(f.calls.length,0);
  assert.equal(f.win.handlers.load.length,1);
  assert.equal(f.win.handlers.offline.length,1);
  f.win.emit('load');await flush();
  assert.equal(f.calls.length,1);
});

test('public status is outside tab panels, watch has native live and channel links, and giving has no statement guarantee', () => {
  const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
  assert(html.indexOf('id="appStatus"')<html.indexOf('data-screen="home"'));
  assert.match(html,/<aside[^>]*id="appStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html,/<a[^>]*id="watchBtn"[^>]*href="https:\/\/www.youtube.com\/channel\/UC75FUMm1TckzTRpfYHd_ILQ\/live"[^>]*target="_blank"[^>]*rel="noopener"/);
  assert.match(html,/<a[^>]*id="watchArchive"[^>]*href="https:\/\/www.youtube.com\/channel\/UC75FUMm1TckzTRpfYHd_ILQ"/);
  assert.doesNotMatch(html,/Every gift is recorded|year.end statement/);
});
