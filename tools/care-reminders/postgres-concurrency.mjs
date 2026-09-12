// Run only in the deliberately created, network-disabled local test container.
// This harness never connects to a host TCP port, hosted DB or email provider.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {bootstrapSql,baselineSql,ids} from './server-test-support.mjs';
const container=process.env.CREEK_CARE_PG_CONTAINER || 'bcbc-care-queue-pg-20260912';
assert.match(container,/^bcbc-care-queue-pg-20260912(?:-[a-z0-9]+)?$/);
const socket=process.env.CREEK_CARE_DOCKER_HOST;
assert.match(socket||'',/^unix:\/\/\/(?:private\/tmp|tmp)\/[^\0\r\n]+\.sock$/,'An explicit local test Docker socket is required');
const env={...process.env,DOCKER_HOST:socket};delete env.DOCKER_CONTEXT;
function docker(args,input='') {return new Promise((resolve,reject)=>{
 const p=spawn('/opt/homebrew/bin/docker',args,{env,stdio:['pipe','pipe','pipe']});let out='',err='';
 const timer=setTimeout(()=>{p.kill();reject(new Error('Local PostgreSQL command timed out'));},20000);
 p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);
 p.on('close',code=>{clearTimeout(timer);code===0?resolve(out.trim()):reject(new Error(err.trim()||'Local PostgreSQL command failed'));});p.stdin.end(input);
});}
const info=JSON.parse(await docker(['inspect',container]))[0];
assert.equal(info.State.Running,true);assert.equal(info.HostConfig.NetworkMode,'none');assert.equal(Object.keys(info.HostConfig.PortBindings||{}).length,0);
assert(info.HostConfig.Tmpfs['/tmp']);
const sql=(q)=>docker(['exec','-i',container,'psql','-X','-h','/tmp','-U','postgres','-d','postgres','-qAt','-v','ON_ERROR_STOP=1'],q);
const value=async q=>JSON.parse((await sql(q)).split('\n').filter(Boolean).at(-1));
assert.equal(await sql("select count(*) from pg_namespace where nspname='auth';"),'0','Use a fresh dedicated container; this harness never resets a database');
await sql(bootstrapSql);
for(const row of baselineSql)if(row.execute)await sql(row.sql);
const draftFiles=['20260912183930_care_reminder_bindings.sql','20260912183934_care_reminder_queue.sql'];
const draftHashes={};
for(const name of draftFiles){const bytes=await readFile(new URL('./migrations/'+name,import.meta.url));draftHashes[name]=createHash('sha256').update(bytes).digest('hex');await sql(bytes.toString());}
const person=randomUUID(),plan=randomUUID();
const adminSQL=`do $$begin perform set_config('request.jwt.claim.sub','${ids.admin}',false);end$$;set role authenticated;`;
await sql(`insert into auth.users(id,email,email_confirmed_at,is_anonymous)values('${ids.admin}','admin@example.invalid',now(),false),('${ids.editor}','editor@example.invalid',now(),false);
insert into public.staff_roles(user_id,role)values('${ids.admin}','admin'),('${ids.editor}','editor');
${adminSQL}
insert into public.contacts(id,first_name,last_name,status)values('${person}','Fictional','Concurrency','active');
insert into public.care_assignments(id,contact_id,care_role,cadence_days,started_on,first_due_on)values('${plan}','${person}','deacon',1,'2026-09-08','2026-09-09');
do $$begin perform set_config('request.jwt.claim.sub','${ids.admin}',false);end$$;set role authenticated;
select public.set_care_reminder_binding('${randomUUID()}','care_plan','${plan}',0,1,'${ids.editor}',true,false,null,null);
select public.set_care_reminder_settings('${randomUUID()}',1,true,array['${ids.admin}']::uuid[]);`);
const enqueue=date=>value(`select private.enqueue_care_reminders_at('${date}T15:00Z');`);
const claim=(date='2026-09-12',time='15:00:00')=>value(`select private.claim_care_reminder_jobs_at(1,'${date}T${time}Z');`);
const counts=()=>value("select jsonb_build_object('jobs',(select count(*) from private.care_reminder_jobs),'occurrences',(select count(*) from private.care_reminder_occurrences),'holds',(select count(*) from private.care_reminder_destination_holds where active));");
const checks=[];
const enqueues=await Promise.all(Array.from({length:8},()=>enqueue('2026-09-12')));
assert.equal(enqueues.reduce((n,r)=>n+r.enqueued,0),2);assert.deepEqual(await counts(),{jobs:2,occurrences:4,holds:0});checks.push('eight concurrent enqueues create only two destination jobs and four unique occurrences');
const claims=(await Promise.all(Array.from({length:8},()=>claim()))).flat();assert.equal(claims.length,2);assert.equal(new Set(claims.map(j=>j.id)).size,2);checks.push('eight concurrent claimers return each eligible destination job exactly once');
const j=claims[0];
const finish=`select private.finish_care_reminder_job_at('${j.id}','${j.lease_token}','accepted','synthetic-provider',null,'2026-09-12T15:00:01Z');`;
const finishes=await Promise.allSettled([value(finish),value(finish)]);assert.equal(finishes.filter(r=>r.status==='fulfilled').length,1);assert.equal(finishes.filter(r=>r.status==='rejected'&&r.reason.message.includes('CARE_REMINDER_LEASE_CONFLICT')).length,1);checks.push('two finishers cannot consume the same active lease twice');
const k=claims[1];await value(`select private.finish_care_reminder_job_at('${k.id}','${k.lease_token}','accepted','synthetic-provider-other',null,'2026-09-12T15:00:01Z');`);
assert.deepEqual(await claim(),[]);
assert.equal((await enqueue('2026-09-13')).enqueued,2);
await sql(adminSQL+`insert into public.care_visits(contact_id,care_role,visitor_name,method,outcome,contacted_on)values('${person}','deacon','Fictional operator','call','contacted','2026-09-12');`);
assert.deepEqual((await Promise.all([claim('2026-09-13'),claim('2026-09-13')])).flat(),[]);
assert.equal(await sql("select count(*) from private.care_reminder_jobs where status='cancelled' and error_code='source_changed';"),'2');checks.push('a committed successful contact cancels both stale queued reminders before concurrent claims');
assert.equal((await enqueue('2026-09-14')).enqueued,2);
const expiring=(await Promise.all([claim('2026-09-14'),claim('2026-09-14')])).flat();assert.equal(expiring.length,2);
assert.deepEqual((await Promise.all([claim('2026-09-14','15:02:01'),claim('2026-09-14','15:02:01')])).flat(),[]);
assert.equal((await counts()).holds,2);assert.equal((await enqueue('2026-09-15')).enqueued,0);checks.push('expired leases become durable uncertainty holds; next-day enqueue cannot bypass them');
const originals=await value("select jsonb_build_object('welcome',(select count(*) from private.app_welcome_outbox),'notices',(select count(*) from private.app_staff_notice_outbox),'visits',(select count(*) from public.care_visits));");assert.deepEqual(originals,{welcome:0,notices:0,visits:1});checks.push('initial welcome/notice outboxes remain untouched and the contact record remains');
console.log(JSON.stringify({status:'passed',checks:checks.length,results:checks,postgres:await sql('show server_version;'),baseline_files_verified:baselineSql.length,native_extension_only_file_executed:false,draft_hashes:draftHashes,network:'none',ports:0,scope:'Local synthetic PostgreSQL concurrency; no real Auth service, email, scheduler or hosted changes.'},null,2));
