const test = require('node:test');
const assert = require('node:assert/strict');
const calendar = require('../js/calendar-feed.js');
const now = new Date('2026-09-13T15:00:00Z'); // 10am Central.
const row = extra => ({when:'2026-09-13',time:'9:00a',title:'Church gathering',where:'Bluff Creek Baptist Church',tag:'Special',...extra});
const snapshot = (events, extra = {}) => ({source:'icloud',updated:'2026-09-13',synced_at:'2026-09-13T14:00:00Z',valid_until:'2026-12-11',recurring:[],events,...extra});
const reply = (data,cached=false) => ({ok:true,json:async()=>data,headers:{get:()=>cached?'offline':null}});

test('iCloud is authoritative: Google approvals and old recurring JSON cannot restore cancelled events', async () => {
  const calls=[];
  const result=await calendar.load({now,fallback:snapshot([]),jsonUrl:'json',csvUrl:'csv',fetcher:async url=>{calls.push(url);return reply({events:[row()],recurring:[]});}});
  assert.deepEqual(result.events,[]);assert.deepEqual(calls,['json']);assert.equal(result.source,'icloud');
});

test('a valid newer empty iCloud feed clears events, and invalid data retains the last curated snapshot', async () => {
  const fallback=snapshot([row({time:'6:00p'})]);
  const empty=await calendar.load({now,fallback,fetcher:async()=>reply(snapshot([],{synced_at:'2026-09-13T14:30:00Z'}))});
  assert.deepEqual(empty.events,[]);
  const bad=await calendar.load({now,fallback,fetcher:async()=>reply(snapshot([{title:'Invalid'}]))});
  assert.equal(bad.events.length,1);
});

test('an older cached snapshot cannot resurrect an occurrence deleted from the newer embedded calendar', async () => {
  const result=await calendar.load({now,fallback:snapshot([]),fetcher:async()=>reply(snapshot([row({time:'6:00p'})],{synced_at:'2026-09-12T14:00:00Z'}),true)});
  assert.deepEqual(result.events,[]);assert.equal(result.updatedAt,'2026-09-13T14:00:00Z');
});

test('live endpoint and public JSON fail independently; freshest successful source wins', async () => {
  const fallback=snapshot([]);
  const result=await calendar.load({now,calendarUrl:'live',jsonUrl:'snapshot',fallback,fetcher:async url=>{
    if(url==='live')throw Error('Unavailable');return reply(snapshot([row({time:'6:00p'})],{synced_at:'2026-09-13T14:30:00Z'}));
  }});
  assert.equal(result.events.length,1);assert.equal(result.live,false);
  const active=await calendar.load({now,calendarUrl:'live',jsonUrl:'snapshot',fallback,fetcher:async url=>reply(snapshot(url==='live'?[row({time:'6:00p'})]:[],{synced_at:url==='live'?'2026-09-13T14:30:00Z':'2026-09-13T14:00:00Z'}))});
  assert.equal(active.live,true);assert.equal(active.events.length,1);
});

test('ongoing multi-day and timed events survive until their exclusive end, with accurate labels', async () => {
  const feed=snapshot([
    row({when:'2026-09-12',time:'All day',allDay:true,endsAt:'2026-09-14'}),
    row({title:'Expired all-day',when:'2026-09-12',time:'All day',allDay:true,endsAt:'2026-09-13'}),
    row({title:'Still gathering',endsAt:'2026-09-13T16:00:00Z'}),
    row({title:'Finished',endsAt:'2026-09-13T15:00:00Z'})
  ]);
  const result=await calendar.load({now,fallback:feed,fetcher:async()=>reply(feed)});
  assert.deepEqual(result.events.map(e=>e.title),['Church gathering','Still gathering']);
  assert.equal(calendar.eventTimeLabel(result.events[0]),'All day · through Sep 13');
  assert.equal(calendar.eventTimeLabel(result.events[1]),'9:00a–11:00a');
});

test('offline age and expired horizon are honest; private fields never enter normalized public rows', async () => {
  const feed=snapshot([row({time:'6:00p',organizer:'private@example.invalid',attendees:['private'],url:'https://private.invalid'})]);
  const result=await calendar.load({now:new Date('2026-09-15T15:00:00Z'),fallback:feed,fetcher:()=>Promise.reject(Error('offline'))});
  assert.equal(result.stale,true);assert.match(calendar.statusText(result),/Recent changes may be missing/);
  const current=calendar.upcomingEvents(feed.events,'2026-09-13');
  assert.equal(JSON.stringify(current).includes('private'),false);
  const expired=await calendar.load({now:new Date('2027-01-01T15:00:00Z'),fallback:feed,fetcher:()=>Promise.reject(Error('offline'))});
  assert.deepEqual(expired.events,[]);assert.match(calendar.statusText(expired),/expired/);
});


test('a newest in-memory cancellation survives an adapter outage and an older static snapshot', async () => {
  const old = snapshot([row({time:'6:00p'})], {synced_at:'2026-09-12T14:00:00Z'});
  const removed = snapshot([]);
  const first = await calendar.load({now,calendarUrl:'live',jsonUrl:'static',fallback:old,fetcher:async url=>reply(url==='live'?removed:old)});
  const second = await calendar.load({now,calendarUrl:'live',jsonUrl:'static',fallback:old,previousSnapshot:first.snapshot,fetcher:async url=>url==='live'?{ok:false,status:503}:reply(old)});
  assert.deepEqual(second.events,[]);
  assert.equal(second.updatedAt,removed.synced_at);
  assert.equal(second.live,false);
  assert.equal(second.sources.weekly,'memory');
  assert.match(calendar.statusText(second),/Saved church calendar/);
  assert.match(calendar.statusText(second),/Recent changes may be missing/);
});

test('retained snapshot contains the full allowlisted calendar and re-evaluates event age without restamping', async () => {
  const incoming = snapshot([row({title:'Ongoing',endsAt:'2026-09-13T16:00:00Z',organizer:'private@example.invalid',details:'Private diagnostic',url:'https://private.invalid'}),row({title:'Later',when:'2026-09-14',time:'6:00p'})], {private_source:'must not retain'});
  const first = await calendar.load({now,calendarUrl:'live',fallback:snapshot([],{synced_at:'2026-09-12T14:00:00Z'}),fetcher:async()=>reply(incoming)});
  assert.equal(first.snapshot.events.length,2);
  assert.equal(JSON.stringify(first.snapshot).includes('private'),false);
  assert.equal(JSON.stringify(first.snapshot).includes('Private'),false);
  incoming.events[0].title='External mutation';
  assert.equal(first.snapshot.events[0].title,'Ongoing');
  first.events[0].title='Displayed mutation';
  assert.equal(first.snapshot.events[0].title,'Ongoing');
  const later = await calendar.load({now:new Date('2026-09-13T17:00:00Z'),calendarUrl:'live',fallback:snapshot([],{synced_at:'2026-09-12T14:00:00Z'}),previousSnapshot:first.snapshot,fetcher:async()=>{throw Error('offline');}});
  assert.deepEqual(later.events.map(event=>event.title),['Later']);
  assert.equal(later.snapshot.events.length,2);
  assert.equal(later.updatedAt,first.updatedAt);
});

test('malformed or older retained snapshots cannot override a newer validated source', async () => {
  const current = snapshot([]);
  for (const previousSnapshot of [snapshot([{title:'Invalid'}],{synced_at:'2026-09-13T14:30:00Z'}),snapshot([row({time:'6:00p'})],{synced_at:'2026-09-12T14:00:00Z'})]) {
    const result = await calendar.load({now,fallback:current,previousSnapshot,fetcher:async()=>{throw Error('offline');}});
    assert.deepEqual(result.events,[]);
    assert.equal(result.updatedAt,current.synced_at);
  }
  const newer = snapshot([row({time:'6:00p'})],{synced_at:'2026-09-13T14:30:00Z'});
  const result = await calendar.load({now,calendarUrl:'live',fallback:current,previousSnapshot:current,fetcher:async()=>reply(newer)});
  assert.equal(result.events.length,1);assert.equal(result.live,true);assert.equal(result.updatedAt,newer.synced_at);
});
