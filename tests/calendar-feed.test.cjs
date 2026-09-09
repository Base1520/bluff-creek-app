const test = require('node:test');
const assert = require('node:assert/strict');
const calendar = require('../js/calendar-feed.js');
const legacy = {events:[],recurring:[{weekday:0,time:'9:00a',title:'Sunday School',where:'Fellowship Building',tag:'Weekly'},{weekday:0,time:'10:15a',title:'Sunday Worship',where:'Sanctuary',tag:'Weekly'},{weekday:2,ordinal:3,time:'5:00p',title:'WMU',where:'Fellowship Hall',tag:'Monthly'}]};
const loadLegacy = options => calendar.load({fallback:legacy,...options});
const head = 'Title,Date,Start,End,Location,Details,Type,Note\r\n';
const row = overrides => ({when:'2026-09-13',title:'Sunday Worship',time:'10:15a',where:'Sanctuary',tag:'Weekly',...overrides});
const now = new Date('2026-09-13T13:00:00Z'); // Sunday 8am in Clinton.
const response = (value, cached = false) => ({ok:true,json:async()=>value,text:async()=>value,headers:{get:()=>cached?'offline':null}});

test('quoted comma, newline, escaped quote, BOM and CRLF survive without private columns', () => {
  const changes = calendar.communityRows('\uFEFF'+head+'"Welcome, neighbors",9/13/2026,6:00:00 PM,,"Fellowship, hall","Line one\nSay ""hello""",Add a new event,DO NOT DISPLAY');
  assert.deepEqual(changes[0],{action:'upsert',event:{when:'2026-09-13',title:'Welcome, neighbors',time:'6:00p',where:'Fellowship, hall',details:'Line one\nSay "hello"',tag:'Special'}});
  assert.equal(JSON.stringify(changes).includes('DO NOT DISPLAY'),false);
});

test('invalid dates/times and actions are rejected; blank optional schedule data is honest', () => {
  const changes = calendar.communityRows(head+
    'Invalid date,2/30/2026,6:00 PM,,Room,,Add a new event,\n'+
    'Invalid time,9/13/2026,25:00,,Room,,Add a new event,\n'+
    'Not approved,9/13/2026,6:00 PM,,Room,,Pending,\n'+
    'Time pending,9/13/2026,,,,,Add a new event,\n');
  assert.equal(changes.length,1);
  assert.equal(changes[0].event.time,'Time to be confirmed');
  assert.equal(changes[0].event.where,'Location to be confirmed');
  assert.throws(()=>calendar.communityRows('<html>Sign in</html>'));
  assert.throws(()=>calendar.parseCSV('"Unclosed'));
  assert.throws(()=>calendar.parseCSV('a,"closed"unexpected'));
});

test('approved changes replace exact date/title and cancellations remove matching rhythm only', () => {
  const changes = calendar.communityRows(head+
    'Sunday Worship,9/13/2026,11:00 AM,,Sanctuary,,Change an existing event,\n'+
    'Yoga @ the Creek,9/15/2026,,,,,Cancel an event,\n');
  const base=[row(),row({when:'2026-09-15',title:'Yoga @ the Creek'}),row({when:'2026-09-17',title:'Yoga @ the Creek'})];
  const result=calendar.mergeCommunity(base,changes,'2026-09-13');
  assert.equal(result.length,2);
  assert.equal(result[0].time,'11:00a');
  assert.equal(result[1].when,'2026-09-17');
});

test('later approved action wins and hostile values stay literal data', () => {
  const title='<img src=x onerror=alert(1)>';
  const changes=calendar.communityRows(head+`${title},9/13/2026,12:00 PM,,Room,,Add a new event,\n${title},9/13/2026,,,,,Cancel an event,\n${title},9/13/2026,1:00 PM,,Room,,Add a new event,`);
  const result=calendar.mergeCommunity([],changes,'2026-09-13');
  assert.equal(result.length,1);assert.equal(result[0].title,title);assert.equal(result[0].time,'1:00p');
});

test('verified recurring rhythm stays current beyond seed dates and respects monthly ordinal', () => {
  const events=calendar.expandFeed(legacy,'2026-11-01');
  assert.ok(events.some(e=>e.when==='2026-11-01'&&e.title==='Sunday Worship'));
  assert.deepEqual(events.filter(e=>e.title==='WMU').map(e=>e.when),['2026-11-17']);
  assert.ok(events.every(e=>e.when>='2026-11-01'&&e.when<'2026-12-13'));
  const sep=calendar.expandFeed(legacy,'2026-09-13');
  assert.equal(sep.filter(e=>e.when==='2026-09-13'&&e.title==='Sunday Worship').length,1);
});

test('church day/minute follow Chicago at UTC midnight and across DST', () => {
  assert.equal(calendar.churchToday(new Date('2026-09-07T01:00:00Z')),'2026-09-06');
  assert.equal(calendar.churchMinutes(new Date('2026-09-07T01:00:00Z')),1200);
  assert.equal(calendar.churchMinutes(new Date('2026-11-01T07:30:00Z')),90);
  assert.equal(calendar.churchMinutes(new Date('2026-12-07T06:15:00Z')),15);
});

test('sources fail independently and expired fallback dates never reappear', async () => {
  const fallback={events:[row({when:'2026-09-01'})]};
  const fetcher=async url=>{if(url==='base')throw Error('offline');return response(head+'Special gathering,9/13/2026,6:00 PM,,Room,,Add a new event,');};
  const result=await loadLegacy({jsonUrl:'base',csvUrl:'csv',fetcher,now,fallback});
  assert.deepEqual(result.events.map(e=>e.title),['Special gathering']);
  assert.deepEqual(result.sources,{weekly:'fallback',community:'network'});
});

test('valid empty data clears events; malformed data retains only verified fallback', async () => {
  const empty=await loadLegacy({jsonUrl:'base',csvUrl:'csv',now,fetcher:async url=>response(url==='base'?{events:[]}:head)});
  assert.deepEqual(empty.events,[]);
  const failed=await loadLegacy({jsonUrl:'base',csvUrl:'csv',now,fetcher:async url=>response(url==='base'?{unknown:[]}: '<html>Error</html>')});
  assert.equal(failed.events[0].title,'Sunday School');
  assert.deepEqual(failed.sources,{weekly:'fallback',community:'unavailable'});
});

test('elapsed starts leave upcoming list, unspecified times remain, and cache provenance is retained', async () => {
  const result=await loadLegacy({jsonUrl:'base',csvUrl:'csv',now:new Date('2026-09-13T17:00:00Z'),
    fetcher:async url=>response(url==='base'?{events:[row(),row({time:'6:00p'}),row({title:'Time pending',time:'Time to be confirmed'})]}:head,true)});
  assert.deepEqual(result.events.map(e=>e.time),['6:00p','Time to be confirmed']);
  assert.deepEqual(result.sources,{weekly:'cache',community:'cache'});
});

test('hung sources time out to the verified rhythm', async () => {
  const result=await loadLegacy({now,fetcher:()=>new Promise(()=>{}),timeoutMs:10});
  assert.equal(result.events[0].title,'Sunday School');
  assert.deepEqual(result.sources,{weekly:'fallback',community:'unavailable'});
});
