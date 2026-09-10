import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../admin/tests/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite');
const {pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
const hash=x=>createHash('sha256').update(x).digest('hex');
const baselineBytes=await readFile(new URL('../office-preflight/history/manifest-eight-2026-09-09.json',import.meta.url));
assert.equal(hash(baselineBytes),'572c8a631c293c1c2d322670b8f295de95e3baeb2fa59a82f2ae641e28812c68');
const intake=await readFile(new URL('../../supabase/migrations/20260910152017_direct_app_intake.sql',import.meta.url));
assert.equal(hash(intake),'2d4a268bb6bb2c0d87ae7f4d2b238ee79180e862ea5ba026a9f625498955b405');
// The tenth migration enables pg_cron/pg_net only; PGlite cannot load those
// infrastructure extensions. Pin its unchanged bytes without claiming to run it.
assert.equal(hash(await readFile(new URL('../../supabase/migrations/20260910152030_direct_intake_dispatch_extensions.sql',import.meta.url))),'bfbd4b7e1410a2e80508866e0fbd2029130dce435e5cb7f9ca0c1d9ad0bce6d0');
const sql=await readFile(new URL('./migrations/20260910213024_deacon_guest_rotation.sql',import.meta.url),'utf8');
const names=['admin','editor','viewer','unconfirmed','banned','deleted','anonymous','missing',...Array.from({length:14},(_,i)=>'g'+(i+1))];
const ids=Object.fromEntries(names.map((n,i)=>[n,`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
const profile=(extra={})=>({first_name:'Fictional',last_name:'Guest',phone:null,preferred_contact:'email',contact_permission:true,sunday_school:null,visit_status:'not_yet',first_visit_on:null,...extra});
const denied=(fn,code='42501',message)=>assert.rejects(fn,e=>e.code===code&&(!message||e.message===message));
async function setup(t,{historical=false}={}){
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create role unrelated nologin;
 create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean,deleted_at timestamptz,banned_until timestamptz);
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to anon,authenticated,service_role,unrelated;
 create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));alter table storage.objects enable row level security;
 grant usage on schema public,storage to anon,authenticated,service_role,unrelated;grant select,insert,update,delete on storage.objects to anon,authenticated;`);
 for(const row of JSON.parse(baselineBytes).sql_files){const bytes=await readFile(new URL('../../'+row.path,import.meta.url));assert.equal(hash(bytes),row.sha256);await db.exec(bytes.toString());}
 await db.exec(intake.toString());
 const rows=async(q,args=[])=>(await db.query(q,args)).rows;
 for(const[name,id]of Object.entries(ids).filter(([name])=>name!=='missing')){
  await db.query('insert into auth.users(id,email,email_confirmed_at,is_anonymous)values($1,$2,$3,$4)',[id,`${name}@example.invalid`,['admin','editor','viewer','banned','deleted'].includes(name)?'2026-09-01T00:00:00Z':null,name==='anonymous']);
  if(['admin','editor','viewer','unconfirmed','banned','deleted'].includes(name))await db.query('insert into public.staff_roles(user_id,role)values($1,$2)',[id,['unconfirmed','banned','deleted'].includes(name)?'admin':name]);
 }
 await db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1",[ids.banned]);
 await db.query('update auth.users set deleted_at=now() where id=$1',[ids.deleted]);
 async function as(name,q,args=[]){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[name]||'']);await db.exec('set role '+(['anon','service_role','unrelated'].includes(name)?name:'authenticated'));try{return await rows(q,args);}finally{await db.exec('reset role');}}
 const rpc=(name,fn,args=[])=>as(name,'select public.'+fn+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') result',args).then(r=>r[0].result);
 const guest=(name,key=randomUUID(),p=profile())=>rpc(name,'register_app_guest',[key,p]);
 const task=async registration=>(await rows('select * from public.app_submission_tasks where registration_id=$1',[registration.id]))[0];
 const functionState=()=>rows("select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)args,pg_get_functiondef(p.oid)definition,p.proowner,p.proacl::text,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private') order by 1,2,3");
 const oldFunctions=await functionState(),oldPolicies=await rows('select * from pg_policies order by schemaname,tablename,policyname'),oldRoles=await rows('select * from public.staff_roles order by user_id'),oldBucket=await rows('select * from storage.buckets');
 let oldTask;if(historical)oldTask=await task(await guest('g14'));
 await db.exec(sql);
 const cursor=async()=>(await rows('select next_slot from private.app_deacon_rotation'))[0].next_slot;
 const settings=()=>rpc('admin','get_intake_settings');
 const setSlot=async(slot,name,recipient=null,actor='admin',version)=>{if(version===undefined)version=(await settings()).deacons.find(x=>x.slot===slot).version;return rpc(actor,'set_deacon_slot',[slot,version,name,recipient]);};
 const edit=(record,changes,actor='editor')=>rpc(actor,'update_intake_task',[record.id,record.version,changes]);
 const notices=id=>rows('select * from private.app_staff_notice_outbox where task_id=$1 order by recipient_key',[id]);
 return{db,rows,as,rpc,guest,task,cursor,settings,setSlot,edit,notices,functionState,oldFunctions,oldPolicies,oldRoles,oldBucket,oldTask};
}

test('rotation migration preserves existing data and security while adding only protected empty slots',async t=>{
 const f=await setup(t,{historical:true});
 await t.test('five fixed empty slots and cursor start at one without backfilling historical tasks',async()=>{
  const s=await f.settings();assert.equal(s.version,1);assert.deepEqual(s.deacon_rotation,{enabled:true,next_slot:1});assert.equal(s.routes.length,2);assert.equal(s.staff.length,2);
  assert.deepEqual(s.deacons,[1,2,3,4,5].map(slot=>({slot,display_name:null,assigned_staff_user_id:null,version:1})));
  const old=(await f.rows('select * from public.app_submission_tasks where id=$1',[f.oldTask.id]))[0];assert.deepEqual(old,{...f.oldTask,deacon_slot:null});
  assert.deepEqual(await f.rows('select * from public.staff_roles order by user_id'),f.oldRoles);assert.deepEqual(await f.rows('select * from storage.buckets'),f.oldBucket);
 });
 await t.test('only the four intended private function bodies change; existing ACLs and all policies remain',async()=>{
  const changed=new Set(['create_intake_task','get_intake_settings','set_intake_route','update_intake_task']),current=await f.functionState();
  for(const old of f.oldFunctions){const fresh=current.find(x=>x.nspname===old.nspname&&x.proname===old.proname&&x.args===old.args);assert.ok(fresh);if(old.nspname==='private'&&changed.has(old.proname)){const{definition:a,...rest}=old,{definition:b,...now}=fresh;assert.notEqual(a,b);assert.deepEqual(now,rest);}else assert.deepEqual(fresh,old);}
  assert.deepEqual(await f.rows('select * from pg_policies order by schemaname,tablename,policyname'),f.oldPolicies);
  for(const name of ['admin','editor','viewer'])assert.equal((await f.as(name,'select private.current_staff_role() role'))[0].role,name);
  for(const name of ['unconfirmed','banned','deleted','g1'])assert.equal((await f.as(name,'select private.current_staff_role() role'))[0].role,null);
 });
 await t.test('new tables have RLS and no direct client/service privileges; settings and updates require actual staff',async()=>{
  assert.equal((await f.rows("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname in('app_deacon_slots','app_deacon_rotation') and c.relrowsecurity"))[0].n,2);
  for(const actor of ['anon','g1','admin','editor','viewer','service_role','unrelated'])for(const table of ['app_deacon_slots','app_deacon_rotation']){await denied(()=>f.as(actor,'select * from private.'+table));await denied(()=>f.as(actor,'delete from private.'+table));}
  for(const actor of ['anon','g1','viewer','unconfirmed','banned','deleted','service_role','unrelated'])await denied(()=>f.rpc(actor,'get_intake_settings'));
  assert.equal((await f.rpc('editor','get_intake_settings')).deacons.length,5);
  for(const actor of ['anon','g1','editor','viewer','unconfirmed','banned','deleted','service_role','unrelated'])await denied(()=>f.rpc(actor,'set_deacon_slot',[1,1,'Fictional',null]));
  for(const schema of ['public','private'])await denied(()=>f.as('g1',`select ${schema}.save_app_connection('Old','Path',null,'email',true,null)`));
 });
 await t.test('invalid slots, unsafe names, invalid recipients and stale versions fail without changes',async()=>{
  const before=await f.settings();
  for(const args of [[0,1,null,null],[6,1,null,null],[null,1,null,null],[1,1,'x'.repeat(101),null],[1,1,'Line\nbreak',null],[1,1,'<b>Name</b>',null],...[ids.viewer,ids.g1,ids.missing,ids.banned,ids.deleted,ids.unconfirmed].map(id=>[1,1,'Fictional',id])])await denied(()=>f.rpc('admin','set_deacon_slot',args),'22023');
  await denied(()=>f.rpc('admin','set_deacon_slot',[1,null,null,null]),'40001');assert.deepEqual(await f.settings(),before);
  assert.deepEqual(await f.setSlot(1,'  Fictional One  ',ids.editor),{slot:1,version:2});assert.equal((await f.settings()).deacons[0].display_name,'Fictional One');
  await denied(()=>f.rpc('admin','set_deacon_slot',[1,1,'Stale',null]),'40001');assert.equal((await f.settings()).deacons[0].assigned_staff_user_id,ids.editor);
  await f.setSlot(1,'   ',null);assert.equal((await f.settings()).deacons[0].display_name,null);
 });
 await t.test('slot configuration records only its actor, slot and version in the audit entry',async()=>{
  const audit=await f.rows("select actor_id,action,entity_type,entity_id from public.audit_log where entity_type='app_deacon_slots' order by id");
  assert.deepEqual(audit,[{actor_id:ids.admin,action:'update',entity_type:'app_deacon_slots',entity_id:'1/v2'},{actor_id:ids.admin,action:'update',entity_type:'app_deacon_slots',entity_id:'1/v3'}]);
  assert.equal(JSON.stringify(audit).includes('Fictional'),false);assert.equal(JSON.stringify(audit).includes('@'),false);
 });
});

test('first guest submissions rotate transactionally, while retries, profile edits and prayers preserve the cursor',async t=>{
 const f=await setup(t);let first,key;
 await t.test('twelve registrations fairly wrap slots 1–5 even while recipients are not configured',async()=>{
  const assigned=[];for(let i=1;i<=12;i++){const request=randomUUID(),reg=await f.guest('g'+i,request),task=await f.task(reg);assigned.push(task.deacon_slot);assert.equal(task.routing,'office');assert.equal(task.assigned_staff_user_id,null);assert.equal((await f.notices(task.id)).length,1);if(i===1){first=reg;key=request;}}
  assert.deepEqual(assigned,[1,2,3,4,5,1,2,3,4,5,1,2]);assert.equal(await f.cursor(),3);
 });
 await t.test('identical receipt replay, changed-key profile update and rejected payload do not consume rotation',async()=>{
  const n=await f.cursor(),before=await f.task(first);assert.deepEqual(await f.guest('g1',key),first);
  await f.guest('g1',randomUUID(),profile({first_name:'Updated fictional'}));assert.deepEqual(await f.task(first),before);
  await denied(()=>f.guest('g1',key,profile({first_name:'Changed replay'})),'40001');await denied(()=>f.guest('g13',randomUUID(),profile({contact_permission:false})),'22023');assert.equal(await f.cursor(),n);
 });
 await t.test('an explicit transaction rollback restores cursor, profile, task, receipt and outboxes together',async()=>{
  const before=await f.rows("select (select count(*) from public.app_connections)::int profiles,(select count(*) from public.app_submission_tasks)::int tasks,(select count(*) from private.app_welcome_outbox)::int welcomes,(select count(*) from private.app_staff_notice_outbox)::int notices,(select count(*) from private.app_intake_receipts)::int receipts"),cursor=await f.cursor();
  await f.db.exec('begin');const reg=await f.guest('g13');assert.equal((await f.task(reg)).deacon_slot,cursor);assert.notEqual(await f.cursor(),cursor);await f.db.exec('rollback');
  assert.equal(await f.cursor(),cursor);assert.deepEqual(await f.rows("select (select count(*) from public.app_connections)::int profiles,(select count(*) from public.app_submission_tasks)::int tasks,(select count(*) from private.app_welcome_outbox)::int welcomes,(select count(*) from private.app_staff_notice_outbox)::int notices,(select count(*) from private.app_intake_receipts)::int receipts"),before);
 });
 await t.test('an error after slot consumption rolls back all effects, and the next success receives that slot',async()=>{
  await f.db.exec("create function private.fixture_reject_task()returns trigger language plpgsql as $$begin raise exception 'FICTIONAL_FAILURE' using errcode='55000';end$$;create trigger fixture_reject_task before insert on public.app_submission_tasks for each row execute function private.fixture_reject_task();");
  const cursor=await f.cursor();await denied(()=>f.guest('g13'),'55000');assert.equal(await f.cursor(),cursor);assert.equal((await f.rows('select count(*)::int n from public.app_connections where auth_user_id=$1',[ids.g13]))[0].n,0);
  await f.db.exec('drop trigger fixture_reject_task on public.app_submission_tasks;drop function private.fixture_reject_task();');assert.equal((await f.task(await f.guest('g13'))).deacon_slot,cursor);
 });
 await t.test('prayer route and task remain independent; the old guest route cannot bypass rotation',async()=>{
  const cursor=await f.cursor();await f.rpc('admin','set_intake_route',['prayer_care',1,ids.editor]);const reg=await f.rpc('g14','submit_app_prayer',[randomUUID(),{request_text:'Fictional private prayer.'}]);const task=(await f.rows('select * from public.app_submission_tasks where prayer_request_id=$1',[reg.id]))[0];assert.equal(task.deacon_slot,null);assert.equal(task.assigned_staff_user_id,ids.editor);assert.equal(await f.cursor(),cursor);
  await denied(()=>f.rpc('admin','set_intake_route',['guest_followup',1,ids.editor]),'22023','GUEST_DEACON_ROTATION_REQUIRED');await denied(()=>f.edit(task,{deacon_slot:1}),'22023');assert.equal(await f.cursor(),cursor);
 });
});

test('slot configuration propagates only real destination changes to open actions and preserves immutable notices',async t=>{
 const f=await setup(t);let a,b;
 await t.test('configured recipient receives the rotated action; an ineligible slot falls back to Office',async()=>{
  await f.setSlot(1,'Fictional One',ids.editor);await f.setSlot(2,'Fictional Two',ids.editor);
  a=await f.task(await f.guest('g1'));assert.equal(a.deacon_slot,1);assert.equal(a.assigned_staff_user_id,ids.editor);assert.equal(a.routing,'staff');assert.deepEqual((await f.notices(a.id)).map(x=>x.recipient_staff_user_id),[ids.editor]);
  await f.db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1",[ids.editor]);b=await f.task(await f.guest('g2'));assert.equal(b.deacon_slot,2);assert.equal(b.assigned_staff_user_id,null);assert.equal(b.routing,'office');assert.equal((await f.notices(b.id))[0].recipient_staff_user_id,ids.admin);
  await f.db.query('update auth.users set banned_until=null where id=$1',[ids.editor]);
 });
 await t.test('name-only change preserves task version and all queued job bytes',async()=>{
  const before=(await f.rows('select * from public.app_submission_tasks where id=$1',[a.id]))[0],jobs=await f.notices(a.id);await f.setSlot(1,'Renamed fictional',ids.editor);assert.deepEqual((await f.rows('select * from public.app_submission_tasks where id=$1',[a.id]))[0],before);assert.deepEqual(await f.notices(a.id),jobs);
 });
 await t.test('recipient replacement increments open task versions, leaves old jobs intact and queues the new target once',async()=>{
  const oldJobs=await f.notices(a.id);await f.setSlot(1,'Renamed fictional',ids.admin);const changed=(await f.rows('select * from public.app_submission_tasks where id=$1',[a.id]))[0];assert.equal(changed.assigned_staff_user_id,ids.admin);assert.equal(changed.version,a.version+1);
  const jobs=await f.notices(a.id);assert.equal(jobs.length,2);assert.deepEqual(jobs.find(j=>j.id===oldJobs[0].id),oldJobs[0]);await f.setSlot(1,'Same destination',ids.admin);assert.deepEqual(await f.notices(a.id),jobs);a=changed;
 });
 await t.test('claim excludes the old recipient and uses the unchanged notice contract/template',async()=>{
  const jobs=await f.rpc('service_role','claim_app_staff_notice_jobs',[ids.g1,3]);assert.equal(jobs.length,1);assert.equal(jobs[0].recipient,'admin@example.invalid');assert.equal(jobs[0].template_version,'creek-office-notice-v1');assert.equal(jobs[0].task_id,a.id);
  const stored=await f.notices(a.id);assert.equal(stored.find(j=>j.recipient_staff_user_id===ids.editor).status,'attention');
  await f.rpc('service_role','finish_app_staff_notice_job',[jobs[0].id,jobs[0].lease_token,'sent',randomUUID(),null]);
 });
 await t.test('completed tasks are untouched by later slot recipient changes',async()=>{
  const current=(await f.rows('select * from public.app_submission_tasks where id=$1',[a.id]))[0];await f.edit(current,{status:'completed'});const before=(await f.rows('select * from public.app_submission_tasks where id=$1',[a.id]))[0],jobs=await f.notices(a.id);await f.setSlot(1,'Future owner',ids.editor);assert.deepEqual((await f.rows('select * from public.app_submission_tasks where id=$1',[a.id]))[0],before);assert.deepEqual(await f.notices(a.id),jobs);
 });
 await t.test('editing a completed due date preserves its historical recipient; deliberate reopening uses the current slot',async()=>{
  const before=(await f.rows('select * from public.app_submission_tasks where id=$1',[a.id]))[0],jobs=await f.notices(a.id);
  await f.edit(before,{due_on:'2026-12-01',status:'completed',assigned_staff_user_id:before.assigned_staff_user_id});
  const edited=(await f.rows('select * from public.app_submission_tasks where id=$1',[a.id]))[0];assert.equal(edited.assigned_staff_user_id,ids.admin);assert.equal(edited.deacon_slot,1);assert.deepEqual(edited.completed_at,before.completed_at);assert.deepEqual(await f.notices(a.id),jobs);
  await f.edit(edited,{status:'in_progress'});const reopened=(await f.rows('select * from public.app_submission_tasks where id=$1',[a.id]))[0];assert.equal(reopened.assigned_staff_user_id,ids.editor);assert.equal(reopened.completed_at,null);assert.equal(reopened.completed_by,null);assert.deepEqual(await f.notices(a.id),jobs);
 });
 await t.test('clearing a slot recipient routes open tasks to Office without resetting an earlier notice',async()=>{
  await f.setSlot(2,'Fictional Two',ids.editor);let current=(await f.rows('select * from public.app_submission_tasks where id=$1',[b.id]))[0];assert.equal(current.assigned_staff_user_id,ids.editor);const before=await f.notices(b.id);await f.setSlot(2,'Fictional Two',null);current=(await f.rows('select * from public.app_submission_tasks where id=$1',[b.id]))[0];assert.equal(current.routing,'office');assert.equal(current.assigned_staff_user_id,null);assert.deepEqual(await f.notices(b.id),before);
 });
});

test('manual task overrides keep slot ownership authoritative and never consume the rotation cursor',async t=>{
 const f=await setup(t);await f.setSlot(1,'Fictional One',ids.editor);await f.setSlot(2,'Fictional Two',ids.admin);const reg=await f.guest('g1');let task=await f.task(reg);const cursor=await f.cursor();
 await t.test('legacy UI can update status with the same owner but cannot change a slot-bound destination',async()=>{
  await denied(()=>f.edit(task,{assigned_staff_user_id:ids.admin}),'22023','DEACON_SLOT_OWNER_REQUIRED');await denied(()=>f.edit(task,{assigned_staff_user_id:null}),'22023');assert.deepEqual(await f.task(reg),task);
  await f.edit(task,{assigned_staff_user_id:ids.editor,status:'in_progress'});task=await f.task(reg);assert.equal(task.deacon_slot,1);assert.equal(task.status,'in_progress');
 });
 await t.test('explicit slot selection resolves its recipient, rejects contradictory UUIDs and detects stale task versions',async()=>{
  const old=task;await f.edit(task,{deacon_slot:2,assigned_staff_user_id:null});task=await f.task(reg);assert.equal(task.deacon_slot,2);assert.equal(task.assigned_staff_user_id,ids.admin);assert.equal(task.version,old.version+1);
  await denied(()=>f.edit(old,{deacon_slot:1}),'40001');await denied(()=>f.edit(task,{deacon_slot:1,assigned_staff_user_id:ids.admin}),'22023');assert.deepEqual(await f.task(reg),task);
  await f.edit(task,{deacon_slot:2});task=await f.task(reg);assert.equal(task.version,old.version+2);
 });
 await t.test('explicit null slot enables manual Office or eligible-staff assignment and leaves default slots alone',async()=>{
  const settings=await f.settings();await f.edit(task,{deacon_slot:null,assigned_staff_user_id:ids.editor});task=await f.task(reg);assert.equal(task.deacon_slot,null);assert.equal(task.assigned_staff_user_id,ids.editor);
  await f.edit(task,{assigned_staff_user_id:null});task=await f.task(reg);assert.equal(task.routing,'office');assert.deepEqual(await f.settings(),settings);assert.equal(await f.cursor(),cursor);
 });
 await t.test('new task fields remain strict and never permit client-selected arbitrary or ineligible access',async()=>{
  for(const changes of [{deacon_slot:0},{deacon_slot:6},{deacon_slot:1.5},{deacon_slot:'1'},{deacon_slot:[]},{deacon_slot:true},{deacon_slot:1,unknown:true},{assigned_staff_user_id:ids.g1},{assigned_staff_user_id:ids.banned}])await denied(()=>f.edit(task,changes),'22023');
  for(const actor of ['g1','viewer','unconfirmed','banned','deleted','anon','service_role'])await denied(()=>f.edit(task,{deacon_slot:1},actor));assert.deepEqual(await f.task(reg),task);assert.equal(await f.cursor(),cursor);
 });
});
