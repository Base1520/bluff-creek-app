const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { JSDOM } = createRequire(path.join(__dirname, '../admin/tests/package.json'))('jsdom');
const calendar = require('../js/calendar-feed.js');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const endpoint = 'https://calendar.example.invalid/functions/v1/public-calendar';
const event = {when:'2026-09-13',time:'6:00p',title:'Fictional gathering',where:'Church',tag:'Special'};
const snapshot = (events, synced_at) => ({source:'icloud',updated:synced_at.slice(0,10),synced_at,valid_until:'2026-12-10',recurring:[],events});
const old = snapshot([event], '2026-09-12T14:00:00.000Z');
const removed = snapshot([], '2026-09-13T14:00:00.000Z');
const reply = data => new Response(JSON.stringify(data), {headers:{'Content-Type':'application/json'}});
const unavailable = () => new Response('{"error":"calendar_unavailable"}',{status:503,headers:{'Cache-Control':'no-store'}});
async function settle() { for(let i=0;i<4;i++) await new Promise(resolve=>setImmediate(resolve)); }
function deferred() { let resolve; return {promise:new Promise(yes=>{resolve=yes;}),resolve}; }
function fixture(t, fetcher) {
  const dom = new JSDOM(html,{url:'https://app.example.invalid/#home',runScripts:'outside-only'});
  t.after(()=>dom.window.close());
  const win=dom.window, doc=win.document;
  win.CREEK_PUBLIC_CALENDAR={endpoint};
  win.CreekCalendar={...calendar,DEFAULT_FEED:old};
  win.CreekAppStatus={initialize(){}};
  win.fetch=fetcher;
  win.scrollTo=()=>{};
  win.matchMedia=()=>({matches:false});
  win.Date=class extends Date {constructor(...args){super(...(args.length?args:['2026-09-13T15:00:00.000Z']));}};
  for(const name of ['localStorage','sessionStorage']) Object.defineProperty(win,name,{get(){throw Error('Calendar must not persist browser state');}});
  const appScript=[...doc.querySelectorAll('script:not([src])')].find(script=>script.textContent.includes('var CONFIG ='));
  assert(appScript, 'Exercise the actual public app router and calendar refresh.');
  win.eval(appScript.textContent);
  return {doc,refresh:()=>doc.querySelector('nav.tabs [data-tab="calendar"]').click(),titles:()=>[...doc.querySelectorAll('#calendarList .m > b')].map(node=>node.textContent)};
}

test('the actual app keeps a cancelled event removed after a no-store 503 and static fallback', async t => {
  let mode='live';
  const f=fixture(t,async url=>url===endpoint?(mode==='live'?reply(removed):mode==='invalid'?reply({events:[]}):unavailable()):reply(old));
  await settle();
  assert.deepEqual(f.titles(),[]);
  for(const failure of ['outage','invalid']) {
    mode=failure;f.refresh();await settle();
    assert.deepEqual(f.titles(),[]);
    assert.equal(f.doc.querySelectorAll('#thisweek .m').length,0);
    assert.match(f.doc.getElementById('calendarStatus').textContent,/Saved church calendar from Sep 13/);
    assert.match(f.doc.getElementById('homeCalendarStatus').textContent,/Recent changes may be missing/);
  }
});

test('an older overlapping refresh cannot overwrite the current page snapshot or restore a cancellation later', async t => {
  const reads=[];
  let outage=false;
  const f=fixture(t,url=>{
    if(url!==endpoint)return Promise.resolve(reply(old));
    if(outage)return Promise.resolve(unavailable());
    const read=deferred();reads.push(read);return read.promise;
  });
  await settle();
  f.refresh();await settle();
  assert.equal(reads.length,2);
  reads[1].resolve(reply(removed));await settle();
  assert.deepEqual(f.titles(),[]);
  reads[0].resolve(reply(old));await settle();
  assert.deepEqual(f.titles(),[]);
  outage=true;f.refresh();await settle();
  assert.deepEqual(f.titles(),[]);
  assert.match(f.doc.getElementById('calendarStatus').textContent,/Saved church calendar from Sep 13/);
});

test('the retained calendar is scoped to its page and a later successful source still replaces it', async t => {
  let current=removed;
  const f=fixture(t,async url=>url===endpoint?reply(current):reply(old));
  await settle();assert.deepEqual(f.titles(),[]);
  current=snapshot([{...event,title:'New fictional gathering'}],'2026-09-13T14:30:00.000Z');
  f.refresh();await settle();assert.deepEqual(f.titles(),['New fictional gathering']);
  const independent=fixture(t,async url=>url===endpoint?unavailable():reply(old));
  await settle();assert.deepEqual(independent.titles(),['Fictional gathering']);
  assert.match(independent.doc.getElementById('calendarStatus').textContent,/Sep 12/);
});
