import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup } from './server-test-support.mjs';

const NOW='2026-09-12T14:00:00Z', TOMORROW='2026-09-13T14:00:00Z';
const rejected=(fn,code)=>assert.rejects(fn,e=>e.code===code);

// Queue unit tests inject the authoritative normalized projection inside an
// isolated PGlite fixture. Binding/date/lifecycle projection tests exercise the
// real helper separately; no production function or hosted database is touched.
async function queueFixture(t,{due='2026-09-09',seed=true}={}) {
 const f=await setup(t,{queue:true});
 await f.db.exec(`create table private.queue_test_sources(source_type text,source_id uuid primary key,cycle_id uuid,due_on date,state text,owner_user_id uuid,source_fingerprint text);
 create or replace function private.care_reminder_source_rows(p_today date)
 returns table(source_type text,source_id uuid,cycle_id uuid,due_on date,state text,owner_user_id uuid,source_fingerprint text)
 language sql stable security definer set search_path='' as $$select * from private.queue_test_sources order by source_type,source_id$$;`);
 await f.db.query('update private.care_reminder_settings set enabled=true,pastor_user_ids=$1',[ [f.ids.admin] ]);
 const at=async(fn,args)=>(await f.rows('select private.'+fn+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') result',args))[0].result;
 const addSource=async({owner=f.ids.editor,due_on=due,state='open',type='care_plan'}={})=>{
  const id=randomUUID();await f.db.query('insert into private.queue_test_sources values($1,$2,$3,$4,$5,$6,$7)',[type,id,randomUUID(),due_on,state,owner,'a'.repeat(64)]);return id;
 };
 const sourceId=seed?await addSource():null;
 return {...f,at,addSource,sourceId,
  enqueue:(now=NOW)=>at('enqueue_care_reminders_at',[now]),
  claim:(limit=10,now=NOW)=>at('claim_care_reminder_jobs_at',[limit,now]),
  finish:(job,status='accepted',error=null,now='2026-09-12T14:00:01Z')=>at('finish_care_reminder_job_at',[job.id,job.lease_token,status,status==='accepted'?'fixture-provider-'+job.id:null,error,now]),
  jobs:()=>f.rows('select * from private.care_reminder_jobs order by destination_key,id'),
  occurrences:()=>f.rows('select * from private.care_reminder_occurrences order by occurrence_key'),
 };
}

test('private queue tables and synthetic clocks are inaccessible to clients; service wrappers are the only send surface',async t=>{
 const f=await queueFixture(t);
 const tables=['care_reminder_jobs','care_reminder_occurrences','care_reminder_destination_holds','care_reminder_daily_quota','care_reminder_resolution_receipts'];
 const states=await f.rows("select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname=any($1::text[])",[tables]);
 assert.equal(states.length,5);assert.ok(states.every(x=>x.relrowsecurity));
 for(const actor of ['anon','admin','editor','viewer','service_role']) {
  for(const table of tables) await rejected(()=>f.as(actor,'select * from private.'+table),'42501');
  await rejected(()=>f.as(actor,"select private.enqueue_care_reminders_at('2026-09-12T14:00Z')"),'42501');
  await rejected(()=>f.as(actor,"select private.claim_care_reminder_jobs_at(1,'2026-09-12T14:00Z')"),'42501');
 }
 for(const actor of ['anon','admin','editor','viewer']) {
  await rejected(()=>f.rpc(actor,'enqueue_care_reminders'),'42501');
  await rejected(()=>f.rpc(actor,'claim_care_reminder_jobs',[1]),'42501');
  await rejected(()=>f.rpc(actor,'finish_care_reminder_job',[randomUUID(),randomUUID(),'accepted','fixture-provider',null]),'42501');
 }
 await f.db.exec('update private.care_reminder_settings set enabled=false');
 assert.equal((await f.rpc('service_role','enqueue_care_reminders')).status,'paused');
 assert.deepEqual(await f.rpc('service_role','claim_care_reminder_jobs',[1]),[]);
});

test('disabled settings and Central business-hour boundaries suppress enqueue and claim, including DST changes',async t=>{
 const f=await queueFixture(t,{due:'2026-01-01'});
 await f.db.exec('update private.care_reminder_settings set enabled=false');
 assert.deepEqual(await f.enqueue(),{status:'paused',enqueued:0});assert.deepEqual(await f.claim(),[]);
 await f.db.exec('update private.care_reminder_settings set enabled=true');
 for(const now of ['2026-03-07T14:59:59Z','2026-03-08T13:59:59Z','2026-10-31T22:00:00Z','2026-11-01T23:00:00Z']) {
  assert.equal((await f.enqueue(now)).status,'waiting',now);assert.deepEqual(await f.claim(1,now),[]);
 }
 assert.equal((await f.enqueue('2026-03-08T14:00:00Z')).enqueued,2);
 const jobs=await f.claim(2,'2026-03-08T14:00:00Z');assert.equal(jobs.length,2);
 await f.db.exec('update private.care_reminder_settings set enabled=false');
 assert.deepEqual(await f.claim(1,'2026-03-08T14:00:01Z'),[]);
 assert.equal((await f.finish(jobs[0],'accepted',null,'2026-03-08T14:00:01Z')).status,'accepted','a final receipt can be recorded after pause');
});

test('one daily digest and one three-calendar-day occurrence combine per destination; repeated enqueue is inert',async t=>{
 const f=await queueFixture(t);
 const old=await f.rows('select * from private.app_staff_notice_outbox order by id');
 assert.equal((await f.enqueue()).enqueued,2);
 const jobs=await f.jobs(),occurrences=await f.occurrences();assert.equal(occurrences.length,4);
 assert.deepEqual(occurrences.map(x=>x.kind).sort(),['daily','daily','escalation','escalation']);
 assert.equal((await f.enqueue()).enqueued,0);assert.equal((await f.enqueue(TOMORROW)).enqueued,0,'pending work blocks next day');
 assert.deepEqual(await f.jobs(),jobs);assert.deepEqual(await f.occurrences(),occurrences);
 assert.deepEqual(await f.rows('select * from private.app_staff_notice_outbox order by id'),old);
 await rejected(()=>f.db.exec("update private.care_reminder_occurrences set kind='daily'"),'55000');
 const claimed=await f.claim();for(const job of claimed)await f.finish(job);
 assert.equal((await f.enqueue()).enqueued,0);
 assert.equal((await f.enqueue(TOMORROW)).enqueued,2);
 assert.equal((await f.occurrences()).filter(x=>x.kind==='escalation').length,2,'same occurrence does not escalate daily');
});

test('due today, two days overdue and three days overdue have distinct routing and escalation',async t=>{
 for(const [due,count,escalation] of [['2026-09-12',1,0],['2026-09-10',2,0],['2026-09-09',2,2]]) await t.test(due,async t=>{
  const f=await queueFixture(t,{due});assert.equal((await f.enqueue()).enqueued,count);
  assert.equal((await f.occurrences()).filter(x=>x.kind==='escalation').length,escalation);
 });
});

test('a shared pastor/deacon address is deduplicated and claim returns only a stable minimal worker envelope',async t=>{
 const f=await queueFixture(t);
 await f.db.query('update auth.users set email=$1 where id=any($2::uuid[])',['SHARED@example.invalid',[f.ids.admin,f.ids.editor]]);
 assert.equal((await f.enqueue()).enqueued,1);
 const [job]=await f.claim();assert.equal(job.recipient,'shared@example.invalid');assert.equal(job.provider_key,'care-'+job.id);
 assert.deepEqual(Object.keys(job).sort(),['attempts','first_attempt_at','id','lease_token','provider_key','recipient','template_version']);
 assert.equal(job.template_version,'creek-care-digest-v1');assert.equal(job.attempts,1);
 const stored=(await f.jobs())[0];assert.equal(stored.recipient_user_ids.length,2);assert.equal(stored.source_refs.length,1);
 assert.doesNotMatch(JSON.stringify(stored),/@|PRIVATE_FIXTURE|prayer|notes/);
 await f.finish(job,'retry','provider_rate_limited');
 await f.db.query('update auth.users set email=$1 where id=any($2::uuid[])',['shared@example.invalid',[f.ids.admin,f.ids.editor]]);
 const [retry]=await f.claim(1,'2026-09-12T14:02:00Z');
 assert.equal(retry.id,job.id);assert.equal(retry.provider_key,job.provider_key);assert.equal(retry.recipient,job.recipient);
 assert.notEqual(retry.lease_token,job.lease_token);assert.equal(retry.attempts,2);
 await rejected(()=>f.finish(job,'accepted',null,'2026-09-12T14:02:01Z'),'40001');
});

test('source completion, new visits, new sources, changed assignment and recipient revocation invalidate queued plans before claim',async t=>{
 const cases=[
  async f=>f.db.exec("update private.queue_test_sources set state='completed'"),
  async f=>f.db.exec("update private.queue_test_sources set source_fingerprint=repeat('b',64)"),
  async f=>f.addSource({}),
  async f=>f.db.query('update private.queue_test_sources set owner_user_id=$1',[f.ids.admin]),
  async f=>f.db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1",[f.ids.editor]),
  async f=>f.db.query('update auth.users set email=$1 where id=$2',['changed@example.invalid',f.ids.editor]),
 ];
 for(const [i,mutate] of cases.entries()) await t.test(String(i+1),async t=>{
  const f=await queueFixture(t);await f.enqueue();await mutate(f);
  const claimed=await f.claim();
  assert.ok(claimed.every(j=>j.recipient!=='editor@example.invalid'));
  const jobs=await f.jobs();assert.ok(jobs.some(j=>j.status==='cancelled'&&j.error_code==='source_changed'));
  assert.equal(jobs.filter(j=>j.status==='accepted').length,0);
 });
});

test('closed or removed sources and unavailable identities are excluded; missing reads raise without consuming a lease',async t=>{
 const f=await queueFixture(t,{seed:false});
 for(const state of ['completed','paused','removed','inactive'])await f.addSource({state});
 assert.equal((await f.enqueue()).enqueued,0);
 await f.addSource({owner:null});assert.equal((await f.enqueue()).enqueued,1,'explicit pastor receives unassigned issue');
 const before=await f.jobs();
 await f.db.exec(`create or replace function private.care_reminder_source_rows(p_today date)
 returns table(source_type text,source_id uuid,cycle_id uuid,due_on date,state text,owner_user_id uuid,source_fingerprint text)
 language plpgsql stable security definer set search_path='' as $$begin raise exception 'FIXTURE_SOURCE_UNAVAILABLE' using errcode='55000';end$$;`);
 await rejected(()=>f.claim(),'55000');assert.deepEqual(await f.jobs(),before);
 await rejected(()=>f.enqueue(),'55000');
});

test('malformed and oversized authoritative source projections fail closed without partially enqueuing',async t=>{
 const f=await queueFixture(t);
 await f.db.exec("update private.queue_test_sources set source_fingerprint='malformed'");
 await rejected(()=>f.enqueue(),'55000');assert.deepEqual(await f.jobs(),[]);
 await f.db.exec("update private.queue_test_sources set source_fingerprint=repeat('a',64)");
 await f.db.query("insert into private.queue_test_sources select 'care_plan',gen_random_uuid(),gen_random_uuid(),'2026-09-09','open',$1,repeat('a',64) from generate_series(1,5000)",[f.ids.editor]);
 await rejected(()=>f.enqueue(),'54000');assert.deepEqual(await f.jobs(),[]);
});

test('expired sending leases become uncertain holds and never return a second delivery attempt',async t=>{
 const f=await queueFixture(t);await f.enqueue();const claimed=await f.claim(2);
 assert.deepEqual(await f.claim(2,'2026-09-12T14:01:59Z'),[]);
 assert.deepEqual(await f.claim(2,'2026-09-12T14:02:00Z'),[]);
 const jobs=await f.jobs();assert.ok(jobs.every(j=>j.status==='uncertain'&&j.attempts===1&&j.lease_token===null));
 const holds=await f.rows('select * from private.care_reminder_destination_holds');assert.equal(holds.length,2);assert.ok(holds.every(h=>h.active));
 assert.equal((await f.enqueue(TOMORROW)).enqueued,0);
 await rejected(()=>f.finish(claimed[0],'accepted',null,'2026-09-12T14:02:01Z'),'40001');
});

test('failed and uncertain finishes hold a destination across later days and require versioned idempotent admin resolution',async t=>{
 const f=await queueFixture(t);await f.enqueue();const jobs=await f.claim(2);
 await f.finish(jobs[0],'failed','provider_rejected');await f.finish(jobs[1],'uncertain','provider_timeout');
 assert.equal((await f.enqueue(TOMORROW)).enqueued,0);
 const stored=await f.jobs(),job=stored[0],request=randomUUID();
 for(const actor of ['anon','editor','viewer','service_role'])await rejected(()=>f.rpc(actor,'resolve_care_reminder_job',[request,job.id,job.version,'cancel_no_resend']),'42501');
 await rejected(()=>f.rpc('admin','resolve_care_reminder_job',[request,job.id,job.version-1,'cancel_no_resend']),'40001');
 await rejected(()=>f.rpc('admin','resolve_care_reminder_job',[request,job.id,job.version,'resend']),'22023');
 const result=await f.rpc('admin','resolve_care_reminder_job',[request,job.id,job.version,'cancel_no_resend']);
 assert.equal(result.status,'cancelled');
 assert.deepEqual(await f.rpc('admin','resolve_care_reminder_job',[request,job.id,job.version,'cancel_no_resend']),result);
 await rejected(()=>f.rpc('admin','resolve_care_reminder_job',[request,job.id,job.version+1,'cancel_no_resend']),'40001');
 assert.equal((await f.enqueue()).enqueued,0,'resolution preserves consumed occurrence keys');
 assert.equal((await f.enqueue(TOMORROW)).enqueued,1,'only an explicitly resolved destination can get a new daily job');
 const audit=await f.rows("select entity_type,entity_id from public.audit_log where entity_type='care_reminder_jobs'");
 assert.equal(audit.length,1);assert.doesNotMatch(JSON.stringify(audit),/@|provider|PRIVATE_FIXTURE/);
});

test('known retries respect backoff, eight-attempt limit and the 23-hour provider idempotency window',async t=>{
 const f=await queueFixture(t,{due:'2026-09-12'});await f.enqueue();let [job]=await f.claim(1);
 assert.equal((await f.finish(job,'retry','provider_unavailable')).status,'retry');
 assert.deepEqual(await f.claim(1,'2026-09-12T14:00:59Z'),[]);
 [job]=await f.claim(1,'2026-09-12T14:01:01Z');assert.equal(job.attempts,2);
 await rejected(()=>f.finish(job,'retry','provider_timeout','2026-09-12T14:01:02Z'),'22023');
 await f.db.query('update private.care_reminder_jobs set attempts=8 where id=$1',[job.id]);
 assert.equal((await f.finish(job,'retry','provider_unavailable','2026-09-12T14:01:02Z')).status,'failed');
 assert.equal((await f.jobs())[0].error_code,'attempt_limit');
 await f.db.exec("update private.care_reminder_jobs set status='queued',attempts=2,first_attempt_at='2026-09-11T15:00:00Z',next_attempt_at='2026-09-12T14:00:00Z';update private.care_reminder_destination_holds set active=false,resolved_at=now(),resolved_by=(select user_id from public.staff_roles where role='admin' limit 1)");
 assert.deepEqual(await f.claim(1,NOW),[]);
 assert.equal((await f.jobs())[0].error_code,'retry_window_expired');
});

test('care has its own 20-first-attempt daily cap and retries do not consume another first attempt',async t=>{
 const f=await queueFixture(t,{seed:false,due:'2026-09-12'});
 for(let i=0;i<21;i++) {
  const id=randomUUID();await f.db.query('insert into auth.users(id,email,email_confirmed_at,is_anonymous) values($1,$2,$3,false)',[id,`queue-${i}@example.invalid`,NOW]);
  await f.db.query("insert into public.staff_roles(user_id,role) values($1,'editor')",[id]);await f.addSource({owner:id});
 }
 const initial=await f.rows('select * from private.app_welcome_daily_quota order by utc_day');
 assert.equal((await f.enqueue()).enqueued,21);
 const first=await f.claim(10),second=await f.claim(10);assert.equal(first.length,10);assert.equal(second.length,10);assert.deepEqual(await f.claim(10),[]);
 assert.equal((await f.rows('select first_attempts from private.care_reminder_daily_quota'))[0].first_attempts,20);
 await f.finish(first[0],'retry','provider_rate_limited');
 const retry=await f.claim(1,'2026-09-12T14:01:01Z');assert.equal(retry.length,1);assert.equal(retry[0].id,first[0].id);
 assert.equal((await f.rows('select first_attempts from private.care_reminder_daily_quota'))[0].first_attempts,20);
 assert.deepEqual(await f.rows('select * from private.app_welcome_daily_quota order by utc_day'),initial);
});

test('a failed owner delivery due today creates a pastor delivery-attention digest without retrying the owner',async t=>{
 const f=await queueFixture(t,{due:'2026-09-12'});await f.enqueue();const [owner]=await f.claim(1);
 assert.equal(owner.recipient,'editor@example.invalid');await f.finish(owner,'failed','provider_rejected');
 assert.equal((await f.enqueue()).enqueued,1);
 const [pastor]=await f.claim(1);assert.equal(pastor.recipient,'admin@example.invalid');
 assert.equal((await f.jobs()).find(j=>j.id===owner.id).status,'failed');
});

test('real care bindings and newly inserted visits change the authoritative fingerprint and invalidate queued claims',async t=>{
 const f=await setup(t,{queue:true});
 const care=await f.makeCare({plan:{first_due_on:'2026-09-09',notes:'PRIVATE_FIXTURE_CARE_NOTE'}});
 await f.bind('care_plan',care.plan.id);await f.configure();
 const enqueue=now=>f.rows('select private.enqueue_care_reminders_at($1) result',[now]).then(r=>r[0].result);
 const claim=now=>f.rows('select private.claim_care_reminder_jobs_at(10,$1) result',[now]).then(r=>r[0].result);
 assert.equal((await enqueue(NOW)).enqueued,2);
 const before=(await f.sourceRows())[0];await f.addVisit(care,{outcome:'attempted',contacted_on:'2026-09-11',notes:'PRIVATE_FIXTURE_VISIT_NOTE'});
 const after=(await f.sourceRows())[0];assert.equal(after.due_on,before.due_on);assert.notEqual(after.source_fingerprint,before.source_fingerprint);
 assert.deepEqual(await claim(NOW),[]);
 assert.ok((await f.rows('select status from private.care_reminder_jobs')).every(j=>j.status==='cancelled'));
 assert.equal((await enqueue(TOMORROW)).enqueued,2);
 await f.addVisit(care,{contacted_on:'2026-09-12',outcome:'contacted'});
 assert.deepEqual(await claim(TOMORROW),[]);
 assert.doesNotMatch(JSON.stringify(await f.rows('select * from private.care_reminder_jobs')),/PRIVATE_FIXTURE|@/);
});

test('real guest removal cancels queued reminders and restoration remains quiet until lifecycle consent is rebound',async t=>{
 const f=await setup(t,{queue:true});const registration=await f.reg();let task=await f.taskFor(registration.id);
 await f.rpc('editor','update_intake_task',[task.id,task.version,{due_on:'2026-09-09',assigned_staff_user_id:f.ids.editor}]);
 task=await f.taskFor(registration.id);await f.bind('guest_task',task.id);await f.configure();
 const enqueue=now=>f.rows('select private.enqueue_care_reminders_at($1) result',[now]).then(r=>r[0].result);
 const claim=now=>f.rows('select private.claim_care_reminder_jobs_at(10,$1) result',[now]).then(r=>r[0].result);
 assert.equal((await enqueue(NOW)).enqueued,2);
 await f.change(registration.id,true);assert.deepEqual(await claim(NOW),[]);
 await f.change(registration.id,false);assert.deepEqual(await f.sourceRows(),[]);
 assert.equal((await enqueue(TOMORROW)).enqueued,0);
 await rejected(()=>f.bind('guest_task',task.id),'40001');
 await f.bind('guest_task',task.id,{restart_cycle:true});
 assert.equal((await enqueue(TOMORROW)).enqueued,2);
});
