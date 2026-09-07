import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {convertCalendar,ImportError} from '../convert.mjs';
import {runCLI} from '../cli.mjs';
const NOW='2026-09-06T12:00:00Z';
const calendar = (...events) => ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Synthetic tests//EN',...events,'END:VCALENDAR',''].join('\r\n');
const event = (uid,lines) => ['BEGIN:VEVENT',`UID:${uid}`,...lines,'END:VEVENT'].join('\r\n');
const run = source => convertCalendar(source,{now:NOW});

test('only exact reviewed labels leave conversion; all private metadata is discarded from both formats',()=>{
 const text=calendar(
  event('source-private-uid',['DTSTART:20260907T150000Z','DTEND:20260907T160000Z','SUMMARY:  prayer   MEETING ','LOCATION:Private location','DESCRIPTION:Private care note','ORGANIZER:mailto:private@example.invalid','ATTENDEE:mailto:person@example.invalid','URL:https://secret.example.invalid/calendar','ATTACH:https://secret.example.invalid/file','BEGIN:VALARM','TRIGGER:-PT15M','ACTION:DISPLAY','DESCRIPTION:Private alarm','END:VALARM']),
  event('not-reviewed',['DTSTART:20260907T150000Z','SUMMARY:Personal reminder']),
  event('restricted',['DTSTART:20260907T150000Z','SUMMARY:Youth','CLASS:PRIVATE']),
  event('confidential',['DTSTART:20260907T150000Z','SUMMARY:WMU Meeting','CLASS:CONFIDENTIAL']),
  event('cancelled-name',['DTSTART:20260907T150000Z','SUMMARY:Youth cancelled'])
 );
 const {feed,ics}=run(text);assert.equal(feed.events.length,1);assert.equal(feed.events[0].title,'Prayer meeting');
 assert.equal(feed.events[0].where,'Check with the church for location');assert.deepEqual(feed.recurring,[]);assert.equal(feed.source,'icloud');
 const output=JSON.stringify(feed)+ics;
 for(const token of ['source-private-uid','private@example.invalid','Private care','Private location','secret.example.invalid','Personal reminder','ATTENDEE','ORGANIZER','VALARM','ATTACH','DESCRIPTION','URL:'])assert.equal(output.includes(token),false,token);
 assert.match(ics,/UID:[a-f0-9]{16}@public\.bluffcreek\.church/);assert.match(ics,/DTSTART:20260907T150000Z/);
});

test('all-day end dates are exclusive, ongoing multi-day spans retained, and omitted end means one day',()=>{
 const {feed,ics}=run(calendar(
  event('span',['DTSTART;VALUE=DATE:20260905','DTEND;VALUE=DATE:20260908','SUMMARY:Youth YEC']),
  event('one',['DTSTART;VALUE=DATE:20260907','SUMMARY:Business Meeting']),
  event('expired',['DTSTART;VALUE=DATE:20260904','DTEND;VALUE=DATE:20260906','SUMMARY:Youth'])
 ));
 assert.equal(feed.events.length,2);assert.deepEqual(feed.events.map(e=>[e.when,e.endsAt,e.allDay,e.time]),[['2026-09-05','2026-09-08',true,'All day'],['2026-09-07','2026-09-08',true,'All day']]);
 assert.match(ics,/DTSTART;VALUE=DATE:20260905\r\nDTEND;VALUE=DATE:20260908/);
 assert.equal(feed.valid_until,'2026-12-04');
});

test('stable deduplication and all-day-first ordering do not depend on source component order',()=>{
 const rows=[event('timed',['DTSTART:20260907T150000Z','SUMMARY:Prayer Meeting']),event('a',['DTSTART;VALUE=DATE:20260907','SUMMARY:Youth']),event('b',['DTSTART;VALUE=DATE:20260907','SUMMARY:Business Meeting']),event('duplicate',['DTSTART:20260907T150000Z','SUMMARY:Prayer Meeting'])];
 const one=run(calendar(...rows)),two=run(calendar(...rows.reverse()));
 assert.deepEqual(one.feed,two.feed);assert.deepEqual(one.feed.events.map(e=>e.title),['Business meeting','Youth @ the Creek','Prayer meeting']);assert.equal(one.counts.deduplicated,1);assert.equal(one.ics,two.ics);
});

test('unknown and private overrides suppress their original slots without inheriting a reviewed label',()=>{
 const source=calendar(event('series',['DTSTART:20260907T150000Z','RRULE:FREQ=DAILY;COUNT=3','SUMMARY:Youth']),event('series',['RECURRENCE-ID:20260908T150000Z','DTSTART:20260908T150000Z','SUMMARY:Personal appointment']),event('series',['RECURRENCE-ID:20260909T150000Z','DTSTART:20260909T150000Z','SUMMARY:Youth','CLASS:CONFIDENTIAL']));
 assert.deepEqual(run(source).feed.events.map(e=>e.when),['2026-09-07']);
});

test('floating wall time uses Chicago rather than machine timezone; expired events stay absent',()=>{
 const source=calendar(event('floating',['DTSTART:20260907T180000','DTEND:20260907T190000','SUMMARY:WMU Meeting']),event('old',['DTSTART:20200101T100000Z','SUMMARY:Youth']));
 const {feed,ics}=run(source);assert.equal(feed.events.length,1);assert.equal(feed.events[0].time,'6:00p');assert.equal(feed.events[0].endsAt,'2026-09-08T00:00:00.000Z');assert.match(ics,/DTSTART:20260907T230000Z/);
});

test('malformed dates, unresolved zones, unbounded high-frequency rules, and huge historical iteration fail closed',()=>{
 for(const source of [
  'this is not an iCalendar file',
  calendar(event('bad-date',['DTSTART:20260230T100000Z','SUMMARY:Youth'])),
  calendar(event('bad-zone',['DTSTART;TZID=Unresolved/Zone:20260907T100000','SUMMARY:Youth'])),
  calendar(event('fast',['DTSTART:20260907T100000Z','RRULE:FREQ=SECONDLY','SUMMARY:Youth'])),
  calendar(event('ancient',['DTSTART:19000101T100000Z','RRULE:FREQ=DAILY','SUMMARY:Youth']))
 ])assert.throws(()=>run(source),error=>error instanceof ImportError&&!error.message.includes('Unresolved'));
});

test('CLI validates before atomic replacement, preserves both prior outputs on parser failure and never logs input details',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'creek-import-'));
 try{
  const input=join(dir,'source.ics'),output=join(dir,'public.json'),ics=join(dir,'public.ics');
  await writeFile(output,'previous json');await writeFile(ics,'previous ics');await writeFile(input,'malformed confidential@example.invalid');
  await assert.rejects(runCLI(['--input',input,'--output',output,'--ics-output',ics,'--now',NOW]),ImportError);
  assert.equal(await readFile(output,'utf8'),'previous json');assert.equal(await readFile(ics,'utf8'),'previous ics');
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),'--input',input,'--output',output],{encoding:'utf8'});
  assert.equal(child.status,1);assert.equal(child.stdout,'');assert.equal(child.stderr.includes('confidential@example.invalid'),false);assert.equal(child.stderr.includes(input),false);
  await writeFile(input,calendar(event('safe',['DTSTART:20260907T150000Z','SUMMARY:Prayer Meeting'])));
  const counts=await runCLI(['--input',input,'--output',output,'--ics-output',ics,'--now',NOW]);assert.equal(counts.published,1);assert.equal(JSON.parse(await readFile(output,'utf8')).events.length,1);assert.match(await readFile(ics,'utf8'),/BEGIN:VCALENDAR/);assert.equal((await readdir(dir)).some(name=>name.endsWith('.tmp')),false);
  await assert.rejects(runCLI(['--input',input,'--output',input]),error=>error.code==='OUTPUT_CONFLICT');
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('location output uses only approved church markers; off-site and missing locations stay unconfirmed',()=>{
 const locations=['Bluff Creek Baptist Church','1706 Highway 63, Clinton, LA 70722','Sanctuary','Fellowship Building','Fellowship Hall','Off-site private conference address',''];
 const rows=locations.map((location,i)=>event('location-'+i,[`DTSTART:202609${String(7+i).padStart(2,'0')}T150000Z`,'SUMMARY:Youth YEC',`LOCATION:${location}`]));
 const {feed,ics}=run(calendar(...rows));
 assert.deepEqual(feed.events.map(e=>e.where),[...Array(5).fill('Bluff Creek Baptist Church'),...Array(2).fill('Check with the church for location')]);
 assert.equal(ics.includes('Off-site private'),false);assert.match(ics,/LOCATION:Check with the church for location/);
});

test('nonexistent floating recurrence wall times fail closed instead of shifting or miscounting COUNT',()=>{
 const source=calendar(event('gap',['DTSTART:20260307T023000','RRULE:FREQ=DAILY;COUNT=3','SUMMARY:Prayer Meeting']));
 assert.throws(()=>convertCalendar(source,{now:'2026-03-06T12:00:00Z'}),error=>error.code==='NONEXISTENT_WALL_TIME');
});


test('RDATE-only series includes DTSTART and respects excluded dates',()=>{
 const source=calendar(event('rdate',['DTSTART:20260907T150000Z','RDATE:20260908T150000Z,20260909T150000Z','EXDATE:20260909T150000Z','SUMMARY:Youth']));
 assert.deepEqual(run(source).feed.events.map(e=>e.when),['2026-09-07','2026-09-08']);
});

test('blank venues may use existing verified weekly rooms, while unknown explicit venues and specials never do',()=>{
 const source=calendar(event('weekly',['DTSTART:20260907T150000Z','SUMMARY:Prayer Meeting']),event('different',['DTSTART:20260908T150000Z','SUMMARY:Prayer Meeting','LOCATION:Unknown off-site venue']),event('special',['DTSTART:20260909T150000Z','SUMMARY:Youth YEC']));
 assert.deepEqual(run(source).feed.events.map(e=>e.where),['Sanctuary','Check with the church for location','Check with the church for location']);
});
