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
const extensions=await readFile(new URL('../../supabase/migrations/20260910152030_direct_intake_dispatch_extensions.sql',import.meta.url));
assert.equal(hash(extensions),'bfbd4b7e1410a2e80508866e0fbd2029130dce435e5cb7f9ca0c1d9ad0bce6d0');
// Infrastructure extension bytes are pinned, not executed by PGlite.
const sql=await readFile(new URL('./migrations/20260911132539_office_attention.sql',import.meta.url),'utf8');
const names=['admin','editor','viewer','unconfirmed_staff','anonymous','banned','deleted','missing',...Array.from({length:12},(_,i)=>'g'+(i+1))];
const ids=Object.fromEntries(names.map((n,i)=>[n,`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
const profile=(extra={})=>({first_name:'Fictional',last_name:'Guest',phone:null,preferred_contact:'email',contact_permission:true,sunday_school:null,visit_status:'not_yet',first_visit_on:null,...extra});
const absent={version:1,preference_version:0,weekly_email:false,email_matches:true,updated_at:null};
const denied=(fn,code='42501',message)=>assert.rejects(fn,e=>e.code===code&&(!message||e.message===message));
async function setup(t,{rotation=false,preferences=false}={}){
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create role unrelated nologin;
 create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean,deleted_at timestamptz,banned_until timestamptz);
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to anon,authenticated,service_role,unrelated;
 create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));alter table storage.objects enable row level security;
 grant usage on schema public,storage to anon,authenticated,service_role,unrelated;grant select,insert,update,delete on storage.objects to anon,authenticated;`);
 for(const row of JSON.parse(baselineBytes).sql_files){const bytes=await readFile(new URL('../../'+row.path,import.meta.url));assert.equal(hash(bytes),row.sha256);await db.exec(bytes.toString());}await db.exec(intake.toString());
 if(rotation){const bytes=await readFile(new URL('../deacon-rotation/migrations/20260910213024_deacon_guest_rotation.sql',import.meta.url));assert.equal(hash(bytes),'679530d6e25194c61a3b5e0fa165ce7c47d91db58e67f99d5f2f5453eca94f1a');await db.exec(bytes.toString());}
 if(preferences){const bytes=await readFile(new URL('../communication-preferences/migrations/20260911023920_communication_preferences.sql',import.meta.url));assert.equal(hash(bytes),'d45307bada93bc3f7258eeb41e372477b56f8085ba2fcb138cb520076e567362');await db.exec(bytes.toString());}
 const rows=async(q,args=[])=>(await db.query(q,args)).rows;
 for(const[name,id]of Object.entries(ids).filter(([name])=>name!=='missing')){
  await db.query('insert into auth.users(id,email,email_confirmed_at,is_anonymous)values($1,$2,$3,$4)',[id,`${name}@example.invalid`,['admin','editor','viewer'].includes(name)?'2026-09-01T00:00:00Z':null,name==='anonymous']);
  if(['admin','editor','viewer','unconfirmed_staff'].includes(name))await db.query('insert into public.staff_roles(user_id,role)values($1,$2)',[id,name==='unconfirmed_staff'?'admin':name]);
 }
 await db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1",[ids.banned]);await db.query('update auth.users set deleted_at=now() where id=$1',[ids.deleted]);
 async function as(name,q,args=[]){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[name]||'']);await db.exec('set role '+(['anon','service_role','unrelated'].includes(name)?name:'authenticated'));try{return await rows(q,args);}finally{await db.exec('reset role');}}
 const rpc=(name,fn,args=[])=>as(name,'select public.'+fn+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') result',args).then(r=>r[0].result);
 const functionState=()=>rows("select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)args,pg_get_functiondef(p.oid)definition,p.proowner,p.proacl::text,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private') order by 1,2,3");
 const oldFunctions=await functionState(),oldPolicies=await rows('select * from pg_policies order by schemaname,tablename,policyname'),oldRoles=await rows('select * from public.staff_roles order by user_id'),oldBucket=await rows('select * from storage.buckets'),oldPrivateAcl=await rows("select nspacl::text from pg_namespace where nspname='private'");
 await db.exec(sql);
 const attention=(actor='admin')=>rpc(actor,'get_office_attention');
 const guest=(name,key=randomUUID(),p=profile())=>rpc(name,'register_app_guest',[key,p]);
 const taskFor=async id=>(await rows('select * from public.app_submission_tasks where registration_id=$1 or prayer_request_id=$1',[id]))[0];
 const sent=()=>db.exec("update private.app_welcome_outbox set status='sent',provider_id=gen_random_uuid(),lease_token=null,lease_until=null;update private.app_staff_notice_outbox set status='sent',provider_id=gen_random_uuid(),lease_token=null,lease_until=null;");
 const state=()=>rows("select (select jsonb_agg(to_jsonb(t) order by id) from public.app_submission_tasks t)tasks,(select jsonb_agg(to_jsonb(j) order by id) from private.app_staff_notice_outbox j)notices,(select jsonb_agg(to_jsonb(j) order by id) from private.app_welcome_outbox j)welcomes,(select count(*) from public.audit_log)audit,(select jsonb_agg(q) from private.app_welcome_daily_quota q)quota");
return{db,rows,as,rpc,attention,guest,taskFor,sent,state,functionState,oldFunctions,oldPolicies,oldRoles,oldBucket,oldPrivateAcl};
}

test('attention preserves source/security and allows only eligible Office editors',async t=>{
 const f=await setup(t);
 await t.test('empty complete snapshot uses Central date and the explicit review threshold',async()=>{
  const a=await f.attention();assert.deepEqual(Object.keys(a).sort(),['generated_at','items','today','total','version','waiting_minutes']);assert.equal(a.version,1);assert.equal(a.waiting_minutes,30);assert.equal(a.total,0);assert.deepEqual(a.items,[]);
  assert.equal(a.today,new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(a.generated_at)));
  assert.equal((await f.attention('editor')).total,0);
 });
 await t.test('function privilege and live-account eligibility denials have positive controls',async()=>{
  for(const actor of ['anon','g1','viewer','unconfirmed_staff','anonymous','banned','deleted','missing','service_role','unrelated'])await denied(()=>f.attention(actor));
  await f.db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1",[ids.editor]);await denied(()=>f.attention('editor'));await f.db.query('update auth.users set banned_until=null where id=$1',[ids.editor]);assert.equal((await f.attention('editor')).total,0);
  const defs=await f.rows("select n.nspname,p.prosecdef,p.provolatile,p.proconfig,p.proacl::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname='get_office_attention' order by n.nspname");
  assert.equal(defs.length,2);assert.equal(defs[0].prosecdef,true);assert.equal(defs[1].prosecdef,false);assert(defs.every(x=>x.provolatile==='s'&&x.proconfig.includes('search_path=""')&&!x.proacl.includes('anon=')));
 });
 await t.test('all existing functions, roles, policies, bucket and private schema ACL stay exact',async()=>{
  const fs=await f.functionState();assert.equal(fs.length,f.oldFunctions.length+2);for(const old of f.oldFunctions)assert.deepEqual(fs.find(x=>x.nspname===old.nspname&&x.proname===old.proname&&x.args===old.args),old);
  assert.deepEqual(await f.rows('select * from pg_policies order by schemaname,tablename,policyname'),f.oldPolicies);assert.deepEqual(await f.rows('select * from public.staff_roles order by user_id'),f.oldRoles);assert.deepEqual(await f.rows('select * from storage.buckets'),f.oldBucket);assert.deepEqual(await f.rows("select nspacl::text from pg_namespace where nspname='private'"),f.oldPrivateAcl);
 });
});

test('intake reasons are grouped, privacy-minimal and based on current eligible notice targets',async t=>{
 const f=await setup(t);const g=await f.guest('g1');const task=await f.taskFor(g.id);await f.sent();
 const item=async()=>(await f.attention()).items.find(x=>x.source_id===task.id);
 await t.test('due and unassigned reasons group into one stable task without guest details',async()=>{
  await f.db.query("update public.app_submission_tasks set due_on=(now() at time zone 'America/Chicago')::date-1 where id=$1",[task.id]);
  const a=await f.attention(),r=await item();assert.equal(a.total,1);assert.equal(r.key,'intake:'+task.id);assert.equal(r.category,'intake');assert.deepEqual(r.reasons,['intake_overdue','intake_unassigned']);assert.equal(r.owner_label,'Office queue');assert.equal(r.title,'Guest follow-up');assert.equal(r.contact_id,null);assert.equal(r.care_role,null);
  assert.deepEqual(Object.keys(r).sort(),['care_role','category','contact_id','due_on','key','owner_label','reasons','source_id','source_type','title']);assert.equal(JSON.stringify(a).includes(ids.g1),false);assert.equal(JSON.stringify(a).includes('example.invalid'),false);
  await f.db.query("update public.app_submission_tasks set due_on=(now() at time zone 'America/Chicago')::date where id=$1",[task.id]);assert.deepEqual((await item()).reasons,['intake_due_today','intake_unassigned']);
 });
 await t.test('future assigned tasks clear, obsolete targets are suppressed, missing current job is actionable',async()=>{
  await f.db.query("update public.app_submission_tasks set assigned_staff_user_id=$1,routing='staff',due_on=(now() at time zone 'America/Chicago')::date+1 where id=$2",[ids.editor,task.id]);
  await f.db.query("update private.app_staff_notice_outbox set status='attention' where task_id=$1",[task.id]);assert.deepEqual((await item()).reasons,['notice_attention']);
  await f.db.query('select private.enqueue_intake_notices($1)',[task.id]);await f.db.query("update private.app_staff_notice_outbox set status='sent',provider_id=gen_random_uuid() where task_id=$1 and recipient_staff_user_id=$2",[task.id,ids.editor]);assert.equal(await item(),undefined);
  await f.db.query("update public.app_submission_tasks set notification_status='attention' where id=$1",[task.id]);assert.equal(await item(),undefined);
 });
 await t.test('current email is part of target identity, and revoked recipients show setup without exposing identity',async()=>{
  await f.db.query("update auth.users set email='changed-editor@example.invalid' where id=$1",[ids.editor]);assert.deepEqual((await item()).reasons,['notice_attention']);await f.db.query('select private.enqueue_intake_notices($1)',[task.id]);await f.sent();assert.equal(await item(),undefined);
  await f.db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1",[ids.editor]);const r=await item();assert.deepEqual(r.reasons,['recipient_setup','notice_attention']);assert.equal(r.owner_label,'Assigned staff');assert.equal(r.category,'intake');
  await f.db.query('update auth.users set banned_until=null where id=$1',[ids.editor]);assert.equal(await item(),undefined);
 });
 await t.test('zero Office targets are attention even though stale summary says sent',async()=>{
  await f.db.query("update public.app_submission_tasks set assigned_staff_user_id=null,routing='office' where id=$1",[task.id]);await f.db.query("update public.staff_roles set role='viewer' where user_id=$1",[ids.admin]);const a=await f.attention('editor'),r=a.items.find(x=>x.source_id===task.id);assert.deepEqual(r.reasons,['intake_unassigned','notice_attention']);await f.db.query("update public.staff_roles set role='admin' where user_id=$1",[ids.admin]);
 });
 await t.test('completed tasks hide due/assignment reasons but retain current notice issues with explicit completed label',async()=>{
  await f.db.query("update public.app_submission_tasks set due_on=(now() at time zone 'America/Chicago')::date-1,status='completed',completed_at=now(),completed_by=$1 where id=$2",[ids.admin,task.id]);await f.db.query("update private.app_staff_notice_outbox set status='attention',provider_id=null where task_id=$1 and recipient_staff_user_id=$2",[task.id,ids.admin]);
  const r=await item();assert.deepEqual(r.reasons,['notice_attention']);assert.equal(r.category,'mail');assert.equal(r.due_on,null);assert.equal(r.title,'Completed guest follow-up');await f.sent();assert.equal(await item(),undefined);
 });
 await t.test('prayer title and source only never reveal submitted name, body or contact text',async()=>{
  const p=await f.rpc('g2','submit_app_prayer',[randomUUID(),{display_name:'Secret fictional name',request_text:'Secret fictional prayer body',contact_text:'Secret fictional contact'}]);await f.sent();const pt=await f.taskFor(p.id);const a=await f.attention(),r=a.items.find(x=>x.source_id===pt.id);assert.equal(r.title,'Private prayer care');assert.equal(r.source_type,'intake');assert.deepEqual(r.reasons,['intake_due_today','intake_unassigned']);assert.equal(JSON.stringify(a).includes('Secret'),false);
 });
 await t.test('reviewing attention cannot update state, notices, audit rows or quota',async()=>{
  const before=await f.state();await f.attention();await f.attention('editor');assert.deepEqual(await f.state(),before);await f.as('admin','begin read only');try{await f.as('admin','select public.get_office_attention()');}finally{await f.db.exec('rollback');}
 });
});

test('mail waiting uses aged current jobs and expired leases without making delivery or scheduler claims',async t=>{
 const f=await setup(t);const g=await f.guest('g1');const task=await f.taskFor(g.id);await f.db.query("update public.app_submission_tasks set assigned_staff_user_id=$1,routing='staff',due_on=(now() at time zone 'America/Chicago')::date+1 where id=$2",[ids.admin,task.id]);
 await t.test('new queued mail is quiet, both thirty-minute queues appear with stable separate source keys',async()=>{
  assert.equal((await f.attention()).total,0);await f.db.exec("update private.app_staff_notice_outbox set created_at=now()-interval '31 minutes';update private.app_welcome_outbox set created_at=now()-interval '31 minutes';");const a=await f.attention();assert.equal(a.total,2);assert.deepEqual(a.items.map(x=>x.key),['intake:'+task.id,'welcome:'+g.id]);assert.deepEqual(a.items.map(x=>x.reasons),[['notice_waiting'],['welcome_waiting']]);assert(a.items.every(x=>x.category==='mail'));
 });
 await t.test('active sending leases are quiet; expired leases still require thirty-minute age',async()=>{
  for(const table of ['app_staff_notice_outbox','app_welcome_outbox'])await f.db.exec(`update private.${table} set status='sending',lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes';`);assert.equal((await f.attention()).total,0);
  for(const table of ['app_staff_notice_outbox','app_welcome_outbox'])await f.db.exec(`update private.${table} set lease_until=now()-interval '1 second',created_at=now()-interval '3 minutes';`);assert.equal((await f.attention()).total,0);
  for(const table of ['app_staff_notice_outbox','app_welcome_outbox'])await f.db.exec(`update private.${table} set created_at=now()-interval '31 minutes';`);assert.equal((await f.attention()).total,2);
 });
 await t.test('attention is immediate, sent disappears, retries scheduled later remain honestly aged waiting',async()=>{
  for(const table of ['app_staff_notice_outbox','app_welcome_outbox'])await f.db.exec(`update private.${table} set status='attention',lease_token=null,lease_until=null,created_at=now();`);assert.deepEqual((await f.attention()).items.map(x=>x.reasons),[['notice_attention'],['welcome_attention']]);await f.sent();assert.equal((await f.attention()).total,0);
  for(const table of ['app_staff_notice_outbox','app_welcome_outbox'])await f.db.exec(`update private.${table} set status='queued',created_at=now()-interval '31 minutes',next_attempt_at=now()+interval '1 hour';`);assert.equal((await f.attention()).total,2);
 });
 await t.test('deduplicated welcome jobs produce exactly one issue per linked registration',async()=>{
  await f.db.query('update auth.users set email=$1 where id=$2',['g1@example.invalid',ids.g2]);const second=await f.guest('g2');const a=await f.attention(),welcomes=a.items.filter(x=>x.source_type==='registration');assert.equal(welcomes.length,2);assert.deepEqual(new Set(welcomes.map(x=>x.source_id)),new Set([g.id,second.id]));assert.equal((await f.rows('select count(*)::int n from private.app_welcome_outbox'))[0].n,1);assert.equal(new Set(a.items.map(x=>x.key)).size,a.total);
 });
});

test('optional deacon and preference packages remain compatible without mandatory schema dependencies',async t=>{
 const f=await setup(t,{rotation:true,preferences:true});const g=await f.guest('g1');const task=await f.taskFor(g.id);await f.sent();
 await t.test('a slot retains its owner label while missing recipient is setup, not unassigned',async()=>{
  const r=(await f.attention()).items.find(x=>x.source_id===task.id);assert.equal(r.owner_label,'Deacon 1');assert.deepEqual(r.reasons,['recipient_setup']);
  await f.rpc('admin','set_deacon_slot',[1,1,'Fictional deacon',ids.editor]);await f.sent();assert.equal((await f.attention()).total,0);await f.db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1",[ids.editor]);const bad=(await f.attention()).items.find(x=>x.source_id===task.id);assert.equal(bad.owner_label,'Deacon 1');assert.deepEqual(bad.reasons,['recipient_setup','notice_attention']);
 });
 await t.test('existing optional function bodies and preference data stay exact',async()=>{
  const fs=await f.functionState();for(const old of f.oldFunctions)assert.deepEqual(fs.find(x=>x.nspname===old.nspname&&x.proname===old.proname&&x.args===old.args),old);assert.equal((await f.rows('select count(*)::int n from private.app_communication_preferences'))[0].n,0);assert.equal((await f.rows('select next_slot from private.app_deacon_rotation'))[0].next_slot,2);
 });
});

test('complete attention boundary returns 5000 items and refuses the 5001st without partial promotion',async t=>{
 const f=await setup(t);
 await f.db.exec(`insert into auth.users(id,email,email_confirmed_at,is_anonymous)select ('10000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'boundary'||i||'@example.invalid',null,false from generate_series(1,5001)i;
 insert into public.app_connections(id,auth_user_id,first_name,email,preferred_contact,contact_permission)select id,id,'Fictional',email,'email',true from auth.users where id::text like '10000000-%';
 insert into public.app_submission_tasks(registration_id,submitted_auth_user_id,kind,due_on)select id,id,'guest_followup',(now() at time zone 'America/Chicago')::date+1 from public.app_connections where id::text like '10000000-%' and id::text<>'10000000-0000-4000-8000-000000005001';`);
 const a=await f.attention();assert.equal(a.total,5000);assert.equal(a.items.length,5000);assert.equal(new Set(a.items.map(x=>x.key)).size,5000);
 await f.db.exec("insert into public.app_submission_tasks(registration_id,submitted_auth_user_id,kind,due_on)values('10000000-0000-4000-8000-000000005001','10000000-0000-4000-8000-000000005001','guest_followup',now()::date);");await denied(()=>f.attention(),'54000','OFFICE_ATTENTION_LIMIT_EXCEEDED');
});
