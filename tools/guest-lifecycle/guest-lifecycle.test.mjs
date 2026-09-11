import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../admin/tests/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite');
const {pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
const baselineBytes=await readFile(new URL('../office-preflight/manifest.json',import.meta.url));
assert.equal(createHash('sha256').update(baselineBytes).digest('hex'),'0734cdc37022af4c946b2e4a8d93ad1b199093834f28373b1bf8c0c9497276ae');
const manifest=JSON.parse(baselineBytes);
const sql=await readFile(new URL('./migrations/20260911210521_guest_registration_lifecycle.sql',import.meta.url),'utf8');
const packageManifest=JSON.parse(await readFile(new URL('./manifest.json',import.meta.url),'utf8'));
assert.equal(createHash('sha256').update(sql).digest('hex'),packageManifest.sha256);
const ids=Object.fromEntries(['admin','editor','viewer','guest','other','prayer','unconfirmed','banned','deleted','anonymous'].map((name,i)=>[name,`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
const profile={first_name:'Fictional',last_name:'Guest',phone:null,preferred_contact:'email',contact_permission:true,sunday_school:null,visit_status:'not_yet',first_visit_on:null};
const denied=(fn,code='42501',message)=>assert.rejects(fn,e=>e.code===code&&(!message||e.message===message));
async function setup(t){
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
 create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean,deleted_at timestamptz,banned_until timestamptz);
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to anon,authenticated,service_role;
 create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));alter table storage.objects enable row level security;
 grant usage on schema public,storage to anon,authenticated,service_role;grant select,insert,update,delete on storage.objects to anon,authenticated;`);
 assert.equal(manifest.sql_files.length,10);
 for(const row of manifest.sql_files){const bytes=await readFile(new URL('../../'+row.path,import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),row.sha256);
  // The tenth file installs pg_cron/pg_net only; PGlite cannot load these native
  // extensions. Its exact bytes are checked, and no scheduling is exercised.
  if(row.path==='supabase/migrations/20260910152030_direct_intake_dispatch_extensions.sql')continue;
  await db.exec(bytes.toString());}
 const rows=async(q,args=[])=>(await db.query(q,args)).rows;
 for(const [name,id] of Object.entries(ids)){
  await db.query('insert into auth.users(id,email,email_confirmed_at,is_anonymous)values($1,$2,$3,$4)',[id,`${name}@example.invalid`,name==='guest'||name==='other'||name==='prayer'||name==='unconfirmed'?null:'2026-09-01T00:00:00Z',name==='anonymous']);
  if(!['guest','other','prayer'].includes(name))await db.query('insert into public.staff_roles(user_id,role)values($1,$2)',[id,['editor','viewer'].includes(name)?name:'admin']);
 }
 await db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1",[ids.banned]);
 await db.query('update auth.users set deleted_at=now() where id=$1',[ids.deleted]);
 async function as(name,q,args=[]){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[name]||'']);await db.exec('set role '+(['anon','service_role'].includes(name)?name:'authenticated'));try{return await rows(q,args);}finally{await db.exec('reset role');}}
 const rpc=(name,fn,args=[])=>as(name,'select public.'+fn+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') result',args).then(r=>r[0].result);
 const reg=(name='guest',key=randomUUID(),p=profile)=>rpc(name,'register_app_guest',[key,p]);
 const get=id=>rows('select * from public.app_connections where id=$1',[id]).then(r=>r[0]);
 const getTask=id=>rows('select * from public.app_submission_tasks where registration_id=$1',[id]).then(r=>r[0]);
 const change=async(id,removed=true,key=randomUUID(),actor='admin')=>{const r=await get(id);return rpc(actor,'set_guest_registration_removed',[key,id,r.version,r.staff_version,r.guest_lifecycle_version,removed]);};
 const functionState=()=>rows("select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args,pg_get_functiondef(p.oid) definition,p.proowner,p.prosecdef,p.provolatile,p.proconfig,p.proacl::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private') order by 1,2,3");
 const oldFunctions=await functionState(),oldPolicies=await rows('select * from pg_policies order by schemaname,tablename,policyname');
 await db.exec(sql);
 return{db,rows,as,rpc,reg,get,getTask,change,functionState,oldFunctions,oldPolicies};
}

test('removal is admin-only and all new private state, trigger functions and writes remain inaccessible',async t=>{
 const f=await setup(t),r=await f.reg();
 for(const name of ['editor','viewer','guest','unconfirmed','banned','deleted','anonymous','anon','service_role'])await denied(()=>f.change(r.id,true,randomUUID(),name));
 assert.deepEqual(await f.rpc('editor','get_guest_lifecycle_readiness'),{version:1,available:true});
 for(const name of ['viewer','guest','unconfirmed','banned','deleted','anonymous','anon'])await denied(()=>f.rpc(name,'get_guest_lifecycle_readiness'));
 for(const role of ['admin','guest','anon','service_role'])for(const table of ['guest_lifecycle_state','guest_lifecycle_receipts'])await denied(()=>f.as(role,'select * from private.'+table));
 await denied(()=>f.as('admin','update public.app_connections set guest_removed_at=now() where id=$1',[r.id]));
 assert.equal((await f.get(r.id)).guest_removed_at,null);
});

test('reviewed registration removal/restoration preserves all linked People, care, Auth and original intake receipts',async t=>{
 const f=await setup(t),key=randomUUID(),r=await f.reg('guest',key);
 await f.rpc('admin','review_app_connection',[r.id,r.version,null,true,'Fictional note','Fictional owner']);
 const before=await f.get(r.id),task=await f.getTask(r.id);
 const untouched=async()=>({people:await f.rows('select * from public.contacts order by id'),care:await f.rows('select * from public.care_assignments order by id'),auth:await f.rows('select * from auth.users order by id'),receipts:await f.rows('select * from private.app_intake_receipts order by auth_user_id,kind,request_id')});
 const original=await untouched(),removed=await f.change(r.id);
 assert.equal(removed.removed,true);assert.equal(removed.lifecycle_version,2);assert.equal(removed.staff_version,before.staff_version+1);assert.equal(removed.task_version,task.version+1);
 assert.equal((await f.get(r.id)).status,'archived');const hidden=await f.getTask(r.id);assert.ok(hidden.guest_removed_at);assert.equal(hidden.status,'completed');
 assert.deepEqual(await untouched(),original);
 const restored=await f.change(r.id,false);assert.equal(restored.removed,false);assert.equal(restored.lifecycle_version,3);
 const now=await f.get(r.id),nowTask=await f.getTask(r.id);assert.equal(now.status,'reviewed');assert.equal(now.version,before.version);assert.equal(now.contact_id,before.contact_id);assert.equal(nowTask.status,task.status);assert.equal(nowTask.completed_at,task.completed_at);assert.equal(nowTask.completed_by,task.completed_by);assert.deepEqual(nowTask.due_on,task.due_on);assert.deepEqual(await untouched(),original);
 assert.equal((await f.rpc('guest','get_my_app_connection')).guest_removed,false);
});

test('pending/completed task restoration keeps its exact prior completion and due values',async t=>{
 const f=await setup(t),r=await f.reg();let task=await f.getTask(r.id);
 await f.rpc('editor','update_intake_task',[task.id,task.version,{status:'completed'}]);task=await f.getTask(r.id);
 await f.change(r.id);await f.change(r.id,false);
 assert.equal((await f.get(r.id)).status,'pending');const restored=await f.getTask(r.id);
 for(const key of ['status','completed_at','completed_by','assigned_staff_user_id','routing','due_on'])assert.deepEqual(restored[key],task[key],key);
});

test('exact immutable lifecycle retry cannot repeat effects or undo a later restoration',async t=>{
 const f=await setup(t),r=await f.reg(),key=randomUUID(),row=await f.get(r.id),args=[key,r.id,row.version,row.staff_version,1,true];
 const receipt=await f.rpc('admin','set_guest_registration_removed',args),audit=await f.rows('select * from public.audit_log order by id');
 assert.deepEqual(await f.rpc('admin','set_guest_registration_removed',args),receipt);assert.deepEqual(await f.rows('select * from public.audit_log order by id'),audit);
 await denied(()=>f.rpc('admin','set_guest_registration_removed',[...args.slice(0,5),false]),'40001','GUEST_LIFECYCLE_REQUEST_CONFLICT');
 await f.change(r.id,false);assert.deepEqual(await f.rpc('admin','set_guest_registration_removed',args),receipt);assert.equal((await f.get(r.id)).guest_removed_at,null);
 await denied(()=>f.db.exec('delete from private.guest_lifecycle_receipts'),'55000');
});

test('stale lifecycle/profile/staff versions fail before any removal, task change or notice cancellation',async t=>{
 const f=await setup(t),r=await f.reg(),before=await f.get(r.id),task=await f.getTask(r.id),notices=await f.rows('select * from private.app_staff_notice_outbox order by id');
 for(const bad of [[2,1,1],[1,2,1],[1,1,2]])await denied(()=>f.rpc('admin','set_guest_registration_removed',[randomUUID(),r.id,...bad,true]),'40001');
 assert.deepEqual(await f.get(r.id),before);assert.deepEqual(await f.getTask(r.id),task);assert.deepEqual(await f.rows('select * from private.app_staff_notice_outbox order by id'),notices);
});

test('removed guest cannot silently reactivate through new registration, review, follow-up or task edit; old receipt is historical only',async t=>{
 const f=await setup(t),key=randomUUID(),r=await f.reg('guest',key);await f.change(r.id);const before=await f.get(r.id),task=await f.getTask(r.id);
 await denied(()=>f.reg('guest'),'55000','GUEST_REMOVED');
 await denied(()=>f.rpc('admin','review_app_connection',[r.id,r.version,null,true,null,null]),'55000','GUEST_REMOVED');
 await denied(()=>f.rpc('editor','update_guest_followup',[r.id,before.staff_version,{staff_visit_on:'2026-09-11'}]),'55000','GUEST_REMOVED');
 await denied(()=>f.rpc('editor','update_intake_task',[task.id,task.version,{status:'new'}]),'55000','GUEST_REMOVED');
 assert.deepEqual(await f.reg('guest',key),r);assert.deepEqual(await f.get(r.id),before);assert.equal((await f.rpc('guest','get_my_app_connection')).guest_removed,true);
 assert.equal((await f.rows('select count(*)::int n from public.contacts'))[0].n,0);assert.equal((await f.rows('select count(*)::int n from public.care_assignments'))[0].n,0);
});

test('queued welcome/staff notices stop, restoration does not send, prayer and other guest queues remain independent',async t=>{
 const f=await setup(t),r=await f.reg(),other=await f.reg('other');
 await f.rpc('prayer','submit_app_prayer',[randomUUID(),{request_text:'Fictional private prayer'}]);
 const task=await f.getTask(r.id);await f.change(r.id);
 assert.deepEqual(await f.rpc('service_role','claim_app_welcome_jobs',[ids.guest,10]),[]);assert.deepEqual(await f.rpc('service_role','claim_app_staff_notice_jobs',[ids.guest,10]),[]);
 await f.change(r.id,false);assert.deepEqual(await f.rpc('service_role','claim_app_welcome_jobs',[ids.guest,10]),[]);assert.deepEqual(await f.rpc('service_role','claim_app_staff_notice_jobs',[ids.guest,10]),[]);
 assert.equal((await f.rpc('service_role','claim_app_welcome_jobs',[ids.other,10])).length,1);assert.equal((await f.rpc('service_role','claim_app_staff_notice_jobs',[ids.prayer,10])).length,1);
 assert.equal((await f.rows('select count(*)::int n from private.app_staff_notice_outbox where task_id=$1 and status<>\'attention\'',[task.id]))[0].n,0);assert.ok(other.id);
});

test('sent notices remain immutable and active welcome/staff leases refuse removal atomically',async t=>{
 const f=await setup(t),r=await f.reg();const [job]=await f.rpc('service_role','claim_app_welcome_jobs',[ids.guest,10]),before=await f.get(r.id);
 await denied(()=>f.change(r.id),'55P03','GUEST_DISPATCH_BUSY');assert.deepEqual(await f.get(r.id),before);
 await f.rpc('service_role','finish_app_welcome_job',[job.id,job.lease_token,'sent',randomUUID(),null]);
 const [notice]=await f.rpc('service_role','claim_app_staff_notice_jobs',[ids.guest,10]);await denied(()=>f.change(r.id),'55P03');
 await f.rpc('service_role','finish_app_staff_notice_job',[notice.id,notice.lease_token,'sent',randomUUID(),null]);
 const sent=await f.rows('select * from private.app_welcome_outbox order by id'),sentNotice=await f.rows('select * from private.app_staff_notice_outbox order by id');
 await f.change(r.id);assert.deepEqual(await f.rows('select * from private.app_welcome_outbox order by id'),sent);assert.deepEqual(await f.rows('select * from private.app_staff_notice_outbox order by id'),sentNotice);await f.change(r.id,false);assert.equal((await f.getTask(r.id)).notification_status,'sent');assert.equal((await f.get(r.id)).welcome_email_status,'sent');
});

test('expired lease removal suppresses retry and stale finish, without claiming earlier provider acceptance was impossible',async t=>{
 const f=await setup(t),r=await f.reg(),[job]=await f.rpc('service_role','claim_app_welcome_jobs',[ids.guest,10]);
 await f.db.exec("update private.app_welcome_outbox set lease_until=now()-interval '1 second'");
 await f.change(r.id);await denied(()=>f.rpc('service_role','finish_app_welcome_job',[job.id,job.lease_token,'sent',randomUUID(),null]),'40001');
 assert.deepEqual(await f.rpc('service_role','claim_app_welcome_jobs',[null,10]),[]);const stored=(await f.rows('select * from private.app_welcome_outbox'))[0];assert.equal(stored.status,'attention');assert.equal(stored.error_code,'guest_removed');assert.equal(stored.attempts,1);
});

test('a deduplicated shared welcome stays available only for its other active registration',async t=>{
 const f=await setup(t);await f.db.query('update auth.users set email=$1 where id=$2',['guest@example.invalid',ids.other]);
 const r=await f.reg(),other=await f.reg('other');assert.equal((await f.rows('select count(*)::int n from private.app_welcome_outbox'))[0].n,1);
 await f.change(r.id);assert.deepEqual(await f.rpc('service_role','claim_app_welcome_jobs',[ids.guest,10]),[]);
 await f.change(r.id,false);assert.deepEqual(await f.rpc('service_role','claim_app_welcome_jobs',[ids.guest,10]),[]);
 const jobs=await f.rpc('service_role','claim_app_welcome_jobs',[ids.other,10]);assert.equal(jobs.length,1);assert.equal((await f.get(other.id)).guest_removed_at,null);
});

test('ordinary People care and limited own-profile/private access stay unchanged after removal',async t=>{
 const f=await setup(t),r=await f.reg();await f.change(r.id);
 for(const name of ['guest','other','viewer'])assert.equal((await f.as(name,'select * from public.app_connections')).length,0);
 await denied(()=>f.as('anon','select * from public.app_connections'));
 const own=await f.rpc('guest','get_my_app_connection');for(const key of ['guest_removed_by','guest_removed_at','guest_lifecycle_version','staff_notes','contact_id'])assert.equal(key in own,false);
 assert.equal(own.guest_removed,true);assert.equal(await f.rpc('other','get_my_app_connection'),null);
});

test('only the three reviewed helper definitions change, preserving existing function ACLs, ownership, security and all policies',async t=>{
 const f=await setup(t),now=await f.functionState(),changed=[];
 for(const old of f.oldFunctions){const fresh=now.find(x=>x.nspname===old.nspname&&x.proname===old.proname&&x.args===old.args);assert.ok(fresh);const {definition:a,...oa}=old,{definition:b,...nb}=fresh;assert.deepEqual(nb,oa);if(a!==b)changed.push(old.nspname+'.'+old.proname);}
 assert.deepEqual(changed.sort(),['private.claim_app_welcome_jobs','private.get_my_app_connection','private.intake_notice_targets']);
 assert.deepEqual(await f.rows('select * from pg_policies order by schemaname,tablename,policyname'),f.oldPolicies);
 const helpers=await f.rows("select p.proname,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in('guard_removed_guest_update','guard_removed_guest_task_update','keep_guest_lifecycle_receipt')");assert.equal(helpers.length,3);for(const h of helpers){assert.equal(h.anon,false);assert.equal(h.authenticated,false);}
 assert.equal((await f.rows("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname in('guest_lifecycle_state','guest_lifecycle_receipts') and c.relrowsecurity"))[0].n,2);
});

test('malformed identifiers/versions and nonexistent sources cannot consume a lifecycle receipt',async t=>{
 const f=await setup(t),r=await f.reg();
 for(const args of [[null,r.id,1,1,1,true],[randomUUID(),r.id,0,1,1,true],[randomUUID(),r.id,1,null,1,true],[randomUUID(),r.id,1,1,1,null]])await denied(()=>f.rpc('admin','set_guest_registration_removed',args),'22023');
 await denied(()=>f.rpc('admin','set_guest_registration_removed',[randomUUID(),randomUUID(),1,1,1,true]),'P0002');
 assert.equal((await f.rows('select count(*)::int n from private.guest_lifecycle_receipts'))[0].n,0);
 await f.db.query("update public.app_connections set status='archived' where id=$1",[r.id]);await denied(()=>f.change(r.id),'55000','GUEST_LIFECYCLE_STATE_UNAVAILABLE');
});

test('historical registration without a task can be removed/restored without manufacturing one',async t=>{
 const f=await setup(t);const [{id}]=await f.db.query("insert into public.app_connections(auth_user_id,first_name,email,preferred_contact,contact_permission)values($1,'Fictional','guest@example.invalid','email',true)returning id",[ids.guest]).then(r=>r.rows);
 const removed=await f.change(id);assert.equal(removed.task_id,null);assert.equal(removed.task_version,null);await f.change(id,false);
 assert.equal((await f.rows('select count(*)::int n from public.app_submission_tasks'))[0].n,0);assert.equal((await f.get(id)).status,'pending');
});

test('future unchanged deacon package skips removed tasks and restoration consumes no slot or notification',async t=>{
 const f=await setup(t),deacon=await readFile(new URL('../deacon-rotation/migrations/20260910213024_deacon_guest_rotation.sql',import.meta.url));
 assert.equal(createHash('sha256').update(deacon).digest('hex'),'679530d6e25194c61a3b5e0fa165ce7c47d91db58e67f99d5f2f5453eca94f1a');await f.db.exec(deacon.toString());
 const r=await f.reg();await f.change(r.id);const task=await f.getTask(r.id);assert.equal(task.deacon_slot,1);
 await f.rpc('admin','set_deacon_slot',[1,1,'Fictional slot',ids.editor]);assert.deepEqual(await f.getTask(r.id),task);
 const notices=await f.rows('select * from private.app_staff_notice_outbox order by id'),rotation=await f.rows('select * from private.app_deacon_rotation');
 await f.change(r.id,false);assert.deepEqual(await f.rows('select * from private.app_staff_notice_outbox order by id'),notices);assert.deepEqual(await f.rows('select * from private.app_deacon_rotation'),rotation);assert.equal((await f.getTask(r.id)).deacon_slot,1);
});

test('future atomic preference registration still rolls back for a removed source; separate withdrawal remains allowed',async t=>{
 const f=await setup(t),preferences=await readFile(new URL('../communication-preferences/migrations/20260911023920_communication_preferences.sql',import.meta.url));
 assert.equal(createHash('sha256').update(preferences).digest('hex'),'d45307bada93bc3f7258eeb41e372477b56f8085ba2fcb138cb520076e567362');await f.db.exec(preferences.toString());
 const r=await f.reg();await f.rpc('guest','set_my_communication_preferences',[randomUUID(),0,true]);await f.change(r.id);
 const before=await f.rpc('guest','get_my_communication_preferences');await denied(()=>f.rpc('guest','register_app_guest_with_preferences',[randomUUID(),profile,false,before.preference_version]),'55000','GUEST_REMOVED');assert.deepEqual(await f.rpc('guest','get_my_communication_preferences'),before);
 const withdrawn=await f.rpc('guest','set_my_communication_preferences',[randomUUID(),before.preference_version,false]);assert.equal(withdrawn.weekly_email,false);assert.equal((await f.get(r.id)).status,'archived');
});
