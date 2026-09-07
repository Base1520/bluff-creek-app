import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarHandler, validateSourceURL } from './handler.mjs';
import { convertCalendar } from '../../../tools/icloud-calendar/convert.mjs';

// Synthetic source and records only. All network requests are injected mocks.
const source = 'https://p12-caldav.icloud.com/published/2/SYNTHETIC-NOT-A-REAL-FEED';
const raw = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:synthetic-private-id\r\nDESCRIPTION:private-test-marker\r\nORGANIZER:mailto:synthetic@example.invalid\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const instant = new Date('2026-09-06T12:00:00.000Z');
function converted(now = instant) {
  return { counts: { privateDiagnostic: 'private-test-marker' }, feed: {
    source: 'icloud', updated: now.toISOString().slice(0, 10), synced_at: now.toISOString(), valid_until: '2026-12-04', recurring: [], raw,
    events: [{ when: '2026-09-07', time: '6:00p', title: 'Sample church gathering', where: 'Church', tag: 'Special', endsAt: '2026-09-08T00:00:00.000Z', description: 'private-test-marker', uid: 'synthetic-private-id' },
      { when: '2026-09-08', time: 'All day', title: 'Sample church day', where: 'Church', tag: 'Special', allDay: true, endsAt: '2026-09-09' }],
  }, ics: ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//BCBC//Public calendar//EN','CALSCALE:GREGORIAN','BEGIN:VEVENT','UID:generated-public-id@calendar.invalid','DTSTAMP:20260906T120000Z','DTSTART:20260907T230000Z','DTEND:20260908T000000Z','SUMMARY:Sample church gathering','LOCATION:Church','END:VEVENT','END:VCALENDAR',''].join('\r\n') };
}
function harness(overrides = {}) {
  const calls = [], conversions = [];
  const handler = createCalendarHandler({ sourceURL: source, now: () => instant,
    fetcher: async (url, options) => { calls.push({ url, options }); return new Response(raw); },
    convert: (value, options) => { conversions.push({ value, options }); return converted(options.now); }, ...overrides });
  return { handler, calls, conversions };
}
const request = (query = '', method = 'GET') => new Request('https://endpoint.example.invalid/public-calendar' + query, { method });
async function unavailable(response) {
  assert.equal(response.status, 503);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('Access-Control-Allow-Origin'),'*');
  const body = await response.text();assert.match(body,/calendar_unavailable/);assert.doesNotMatch(body,/private-test-marker|synthetic-private-id|BEGIN:VCALENDAR|icloud\.com|synthetic@example/);assert.equal(JSON.parse(body).events,undefined);
}

test('GET returns only public fields, correct all-day dates, CORS and bounded cache', async () => {
  const {handler,calls,conversions}=harness();const response=await handler(request());
  assert.equal(response.status,200);assert.match(response.headers.get('Content-Type'),/application\/json/);assert.equal(response.headers.get('Access-Control-Allow-Origin'),'*');assert.equal(response.headers.get('Cache-Control'),'public, max-age=60');
  const body=await response.json();assert.deepEqual(Object.keys(body),['source','updated','synced_at','valid_until','recurring','events']);assert.equal(body.events[1].allDay,true);assert.equal(body.events[1].endsAt,'2026-09-09');assert.equal(body.events[0].endsAt,'2026-09-08T00:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(body),/private-test-marker|synthetic-private-id|BEGIN:VCALENDAR|organizer|description/);
  assert.equal(calls[0].url,source);assert.equal(calls[0].options.redirect,'error');assert.deepEqual(calls[0].options.headers,{Accept:'text/calendar'});assert.equal(conversions[0].options.horizonDays,90);
});
test('fixed ICS format returns only sanitized generated calendar', async()=>{
  const {handler}=harness();const response=await handler(request('?format=ics'));assert.equal(response.status,200);assert.match(response.headers.get('Content-Type'),/text\/calendar/);assert.equal(response.headers.get('Content-Disposition'),'inline; filename="church-calendar.ics"');
  const body=await response.text();assert.match(body,/generated-public-id/);assert.doesNotMatch(body,/private-test-marker|synthetic-private-id|ORGANIZER|DESCRIPTION|VALARM/);
});
test('OPTIONS is anonymous and never reads configuration or fetches',async()=>{
  const {handler,calls}=harness({sourceURL:undefined});const response=await handler(request('', 'OPTIONS'));assert.equal(response.status,204);assert.equal(response.headers.get('Access-Control-Allow-Methods'),'GET, OPTIONS');assert.equal(await response.text(),'');assert.equal(calls.length,0);
});
test('write and unsupported methods are denied without a fetch',async()=>{
  const {handler,calls}=harness();for(const method of ['POST','PUT','PATCH','DELETE','HEAD']) {const response=await handler(request('',method));assert.equal(response.status,405);assert.equal(response.headers.get('Allow'),'GET, OPTIONS');}assert.equal(calls.length,0);
});
test('caller cannot provide a URL or arbitrary format',async()=>{
  const {handler,calls}=harness();for(const query of ['?url=https://internal.invalid/','?source=elsewhere','?format=html','?format=','?format=ics&format=json']) assert.equal((await handler(request(query))).status,400);assert.equal(calls.length,0);
});
test('only exact Apple calendar publication hosts and HTTPS/webcal config are accepted',async()=>{
  assert.equal(validateSourceURL(source.replace('https:','webcal:')),source);
  assert.equal(validateSourceURL(source.replace('caldav','calendars')),source.replace('caldav','calendars'));
  for(const url of [undefined,'', 'http://p12-caldav.icloud.com/published/2/test','https://localhost/published/2/test','https://127.0.0.1/published/2/test','https://169.254.169.254/published/2/test','https://icloud.com.evil.invalid/published/2/test','https://p12-caldav.icloud.com.evil.invalid/published/2/test','https://p12-caldav.icloud.com@evil.invalid/published/2/test','https://user:password@p12-caldav.icloud.com/published/2/test',source+'?url=elsewhere',source+'#private',source.replace('/published/','/private/'),source.replace('.com/', '.com:444/'),source+'\n']) {
    assert.equal(validateSourceURL(url),null);const {handler,calls}=harness({sourceURL:url});await unavailable(await handler(request()));assert.equal(calls.length,0);
  }
});
test('upstream errors, redirects and malformed conversion produce generic 503',async()=>{
  for(const fetcher of [async()=>{throw new Error(source+' '+raw);},async()=>new Response(raw,{status:500}),async()=>new Response(null,{status:302,headers:{Location:'https://internal.invalid/'}})]) await unavailable(await harness({fetcher}).handler(request()));
  for(const convert of [()=>{throw new Error(raw);},()=>({feed:{events:[]},ics:raw}),()=>({ ...converted(),ics:raw })]) await unavailable(await harness({convert}).handler(request('?format=ics')));
});
test('declared and streamed raw byte limits reject oversized source',async()=>{
  for(const fetcher of [async()=>new Response('small',{headers:{'Content-Length':'2097153'}}),async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(2097153));c.close();}}))]) {
    const {handler,conversions}=harness({fetcher});await unavailable(await handler(request()));assert.equal(conversions.length,0);
  }
});
test('timeout aborts a stalled fetch and does not expose details',async()=>{
  let signal;const {handler}=harness({timeoutMs:15,fetcher:(_url,options)=>{signal=options.signal;return new Promise(()=>{});}});await unavailable(await handler(request()));assert.equal(signal.aborted,true);
});
test('timeout cancels a stalled response stream',async()=>{
  let cancelled=false;const {handler}=harness({timeoutMs:15,fetcher:async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('BEGIN:VCALENDAR\r\n'));},cancel(){cancelled=true;}}))});await unavailable(await handler(request()));assert.equal(cancelled,true);
});
test('cache retains original sync time and expires before refetching',async()=>{
  let time=instant;const {handler,calls}=harness({now:()=>time});const first=await (await handler(request())).json();time=new Date(instant.getTime()+30000);
  const cached=await handler(request());assert.equal(cached.headers.get('Cache-Control'),'public, max-age=30');assert.equal((await cached.json()).synced_at,first.synced_at);assert.equal(calls.length,1);
  time=new Date(instant.getTime()+61000);const refreshed=await (await handler(request())).json();assert.equal(refreshed.synced_at,time.toISOString());assert.equal(calls.length,2);
});
test('concurrent requests share one fetch; failure never serves expired snapshot',async()=>{
  let resolve,time=instant;const deferred=new Promise(r=>{resolve=r;});let calls=0;
  const {handler}=harness({now:()=>time,fetcher:()=>{calls++;return calls===1?deferred:Promise.reject(new Error('synthetic unavailable'));}});
  const first=handler(request()),second=handler(request('?format=ics'));resolve(new Response(raw));assert.equal((await first).status,200);assert.equal((await second).status,200);assert.equal(calls,1);
  time=new Date(instant.getTime()+61000);await unavailable(await handler(request()));assert.equal(calls,2);
});
test('forged sync timestamp, personal ICS properties, and invalid all-day bounds fail closed',async()=>{
  for(const change of [r=>{r.feed.synced_at='2020-01-01T00:00:00.000Z';},r=>{r.ics=r.ics.replace('END:VEVENT','DESCRIPTION:private-test-marker\r\nEND:VEVENT');},r=>{r.ics=r.ics.replace('END:VEVENT','BEGIN:VALARM\r\nEND:VALARM\r\nEND:VEVENT');},r=>{r.feed.events[1].endsAt='2026-09-08';}]) {
    const {handler}=harness({convert:()=>{const value=converted();change(value);return value;}});await unavailable(await handler(request()));
  }
});
test('failures never log the raw calendar or source URL',async t=>{
  const original={error:console.error,warn:console.warn,log:console.log};const logged=[];for(const key of Object.keys(original))console[key]=(...args)=>logged.push(args);t.after(()=>Object.assign(console,original));
  await unavailable(await harness({fetcher:async()=>{throw new Error(source+raw);}}).handler(request()));assert.deepEqual(logged,[]);
});
test('real curated importer works through HTTP for JSON and ICS without leaking source fields',async()=>{
  const synthetic = [
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Synthetic fixture//EN',
    'BEGIN:VEVENT','UID:synthetic-source-point','DTSTART:20260907T230000Z','SUMMARY:Prayer Meeting','DESCRIPTION:private-test-marker','ORGANIZER:mailto:synthetic@example.invalid','END:VEVENT',
    'BEGIN:VEVENT','UID:synthetic-source-allday','DTSTART;VALUE=DATE:20260908','DTEND;VALUE=DATE:20260910','SUMMARY:Youth YEC','LOCATION:private-test-marker','END:VEVENT',
    'BEGIN:VEVENT','UID:synthetic-source-skipped','DTSTART:20260909T120000Z','SUMMARY:Unapproved personal reminder','END:VEVENT',
    'END:VCALENDAR','',
  ].join('\r\n');
  const {handler}=harness({convert:convertCalendar,fetcher:async()=>new Response(synthetic)});
  const response=await handler(request());assert.equal(response.status,200);const body=await response.json();
  assert.equal(body.valid_until,'2026-12-04');assert.equal(body.events.length,2);assert.equal(body.events[0].title,'Prayer meeting');assert.equal(body.events[0].endsAt,undefined);assert.equal(body.events[1].allDay,true);assert.equal(body.events[1].endsAt,'2026-09-10');
  const calendar=await handler(request('?format=ics'));assert.equal(calendar.status,200);const ics=await calendar.text();assert.match(ics,/CLASS:PUBLIC/);assert.match(ics,/UID:[a-f0-9]+@public\.bluffcreek\.church/);assert.match(ics,/DTEND;VALUE=DATE:20260910/);
  assert.doesNotMatch(JSON.stringify(body)+ics,/synthetic-source|private-test-marker|synthetic@example|Unapproved personal reminder|DESCRIPTION|ORGANIZER/);
});
