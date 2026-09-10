import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require=createRequire(new URL('../../admin/tests/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite');
const {pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
const baselineBytes=await readFile(new URL('../office-preflight/history/manifest-eight-2026-09-09.json',import.meta.url));
assert.equal(createHash('sha256').update(baselineBytes).digest('hex'),'572c8a631c293c1c2d322670b8f295de95e3baeb2fa59a82f2ae641e28812c68');
const baseline=JSON.parse(baselineBytes);
const sql=await readFile(new URL('./migrations/20260909212646_direct_app_intake.sql',import.meta.url),'utf8');
const hash=x=>createHash('sha256').update(x).digest('hex');
const ids=Object.fromEntries(['admin','editor','viewer','guest','other','prayer','unconfirmed_staff','banned','deleted','anonymous','blank','unknown','duplicate'].map((name,i)=>[name,`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
const profile=(x={})=>({first_name:'Fictional',last_name:'Guest',phone:null,preferred_contact:'email',contact_permission:true,sunday_school:null,visit_status:'not_yet',first_visit_on:null,...x});
const prayer=(x={})=>({display_name:'Fictional person',request_text:'Fictional private prayer.',contact_text:null,...x});
const denied=(fn,code='42501')=>assert.rejects(fn,e=>e.code===code);
async function setup(t,options={}){
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create role unrelated nologin;
 create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean,deleted_at timestamptz,banned_until timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to anon,authenticated,service_role,unrelated;
 create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));alter table storage.objects enable row level security;
 grant usage on schema public,storage to anon,authenticated,service_role,unrelated;grant select,insert,update,delete on storage.objects to anon,authenticated;`);
 assert.equal(baseline.sql_files.length,8);
 for(const row of baseline.sql_files){const b=await readFile(new URL('../../'+row.path,import.meta.url));assert.equal(hash(b),row.sha256);await db.exec(b.toString());}
 const rows=async(q,args=[])=>(await db.query(q,args)).rows;
 for(const[name,id]of Object.entries(ids).filter(([name])=>name!=='unknown')){
  await db.query('insert into auth.users(id,email,email_confirmed_at,is_anonymous)values($1,$2,$3,$4)',[id,`${name}@example.invalid`,['admin','editor','viewer'].includes(name)?'2026-09-01T00:00:00Z':null,name==='anonymous']);
  if(['admin','editor','viewer','unconfirmed_staff'].includes(name))await db.query('insert into public.staff_roles(user_id,role)values($1,$2)',[id,name==='unconfirmed_staff'?'admin':name]);
 }
 await db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1",[ids.banned]);
 await db.query('update auth.users set deleted_at=now() where id=$1',[ids.deleted]);
 await db.query("update auth.users set email=' ' where id=$1",[ids.blank]);
 const functionState=async()=>rows("select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)args,pg_get_functiondef(p.oid)definition,p.proowner,p.proconfig,p.proacl::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private') order by 1,2,3");
 if(options.legacy)await db.query("insert into public.app_connections(auth_user_id,first_name,last_name,email,preferred_contact,contact_permission,staff_notes)values($1,'Existing','Fictional','guest@example.invalid','email',true,'Prior private note')",[ids.guest]);
 const oldFunctions=await functionState(),oldPolicies=await rows('select * from pg_policies order by schemaname,tablename,policyname'),oldRoles=await rows('select * from public.staff_roles order by user_id');
 await db.exec(sql);
 async function as(name,q,args=[]){
  await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[name]||'']);
  await db.exec('set role '+(['anon','service_role','unrelated'].includes(name)?name:'authenticated'));
  try{return await rows(q,args);}finally{await db.exec('reset role');}
 }
 const rpc=(name,fn,args=[])=>as(name,'select public.'+fn+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') result',args).then(r=>r[0].result);
 return{db,rows,as,rpc,functionState,oldFunctions,oldPolicies,oldRoles};
}

test('direct intake on the frozen eight-migration baseline retains staff security and implements private receipts, quotas and welcome leases',async t=>{
 const f=await setup(t),{db,rows,as,rpc}=f;
 const guest=(name,req=randomUUID(),p=profile())=>rpc(name,'register_app_guest',[req,p]);
 const pray=(name,req=randomUUID(),p=prayer())=>rpc(name,'submit_app_prayer',[req,p]);
 const mine=name=>rpc(name,'get_my_app_connection');
 const claim=(uid=null,limit=3)=>rpc('service_role','claim_app_welcome_jobs',[uid,limit]);
 const finish=(job,status='sent',provider=randomUUID(),error=null)=>rpc('service_role','finish_app_welcome_job',[job.id,job.lease_token,status,provider,error]);
 let reg,firstRequest,prayerReceipt,firstJob;
 await t.test('all baseline functions except own-profile projection, all54 policies and staff roles are preserved',async()=>{
  const current=await f.functionState();
  for(const old of f.oldFunctions){const now=current.find(n=>n.nspname===old.nspname&&n.proname===old.proname&&n.args===old.args);assert.ok(now);
   if(old.nspname==='private'&&old.proname==='get_my_app_connection'){const{definition:a,...rest}=old;const{definition:b,...fresh}=now;assert.notEqual(a,b);assert.deepEqual(fresh,rest);}else assert.deepEqual(now,old);
  }
  const policies=await rows('select * from pg_policies order by schemaname,tablename,policyname');for(const old of f.oldPolicies)assert.deepEqual(policies.find(p=>p.schemaname===old.schemaname&&p.tablename===old.tablename&&p.policyname===old.policyname),old);assert.equal(policies.length,56);
  assert.equal(f.oldPolicies.length,54);assert.deepEqual(await rows('select * from public.staff_roles order by user_id'),f.oldRoles);
  assert.equal((await as('unconfirmed_staff','select private.current_staff_role() role'))[0].role,null);
  for(const name of ['admin','editor','viewer'])assert.deepEqual(await rpc(name,'direct_intake_readiness'),{available:true,version:1,tasks:true,routes:true});
  await denied(()=>rpc('guest','direct_intake_readiness'));
 });
 await t.test('private new tables have RLS and no browser/service direct privileges; wrappers expose only intended roles',async()=>{
  const tables=['app_intake_receipts','app_welcome_outbox','app_welcome_links','app_welcome_daily_quota'];
  assert.equal((await rows("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname=any($1) and c.relrowsecurity",[tables]))[0].n,4);
  for(const role of ['anon','guest','viewer','service_role','unrelated'])for(const table of tables)await denied(()=>as(role,'select * from private.'+table));
  for(const name of ['anon','unrelated']){await denied(()=>guest(name));await denied(()=>pray(name));await denied(()=>mine(name));}
  for(const name of ['guest','admin','viewer','anon','unrelated'])await denied(()=>rpc(name,'claim_app_welcome_jobs',[null,1]));
  for(const name of ['guest','admin','viewer','anon','unrelated'])await denied(()=>rpc(name,'finish_app_welcome_job',[randomUUID(),randomUUID(),'sent',randomUUID(),null]));
  for(const role of ['guest','admin','editor','viewer','anon'])for(const schema of ['public','private'])await denied(()=>as(role,`select ${schema}.save_app_connection('Old','Path',null,'email',true,null)`));
 });
 await t.test('unconfirmed normal accounts can register; anonymous/deleted/banned/missing accounts cannot write or read own profile',async()=>{
  for(const name of ['anonymous','deleted','banned','blank','unknown','missing']){await denied(()=>guest(name));await denied(()=>pray(name));await denied(()=>mine(name));}
  firstRequest=randomUUID();reg=await guest('guest',firstRequest,profile({first_name:'  Fictional  '}));
  assert.deepEqual(Object.keys(reg).sort(),['id','submitted_at','version','welcome_email_status']);assert.equal(reg.version,1);assert.equal(reg.welcome_email_status,'queued');
  const stored=(await rows('select * from public.app_connections where id=$1',[reg.id]))[0];
  assert.equal(stored.email,'guest@example.invalid');assert.equal(stored.auth_user_id,ids.guest);assert.equal(stored.contact_id,null);assert.equal(stored.status,'pending');assert.equal(stored.staff_version,1);
  const due=(await rows("select (submitted_at at time zone 'America/Chicago')::date+2 expected,follow_up_on from public.app_connections where id=$1",[reg.id]))[0];assert.deepEqual(due.expected,due.follow_up_on);
  assert.equal((await rows('select count(*)::int n from public.contacts'))[0].n,0);assert.equal((await rows('select count(*)::int n from private.app_welcome_outbox'))[0].n,1);
 });
 await t.test('same request and canonical payload return original receipt; changed payload conflicts without any audit/version/outbox change',async()=>{
  const before=await rows('select * from public.audit_log order by id');
  assert.deepEqual(await guest('guest',firstRequest,profile()),reg);
  await denied(()=>guest('guest',firstRequest,profile({first_name:'Changed'})),'40001');
  assert.deepEqual(await rows('select * from public.audit_log order by id'),before);
  assert.equal((await mine('guest')).version,1);
  const next=await guest('guest',randomUUID(),profile({first_name:'New name',visit_status:'first_visit',first_visit_on:'2026-09-06'}));assert.equal(next.id,reg.id);assert.equal(next.version,2);
  const job=(await rows('select * from private.app_welcome_outbox'))[0];assert.equal(job.first_name,'Fictional');assert.equal(job.template_version,'creek-welcome-v1');
  assert.equal((await mine('guest')).first_visit_on,'2026-09-06');
 });
 await t.test('invalid field types, extra identity/private fields, consent and dates fail atomically',async()=>{
  const n=(await rows('select count(*)::int n from private.app_intake_receipts'))[0].n;
  for(const p of [null,[],{},profile({first_name:4}),profile({contact_permission:'true'}),profile({contact_permission:false}),profile({phone:{}}),profile({first_visit_on:'2026-02-30',visit_status:'first_visit'}),profile({first_visit_on:'2026-09-01'}),profile({first_visit_on:true}),profile({first_name:' '}),profile({preferred_contact:'text'}),profile({email:'other@example.invalid'}),profile({staff_notes:'Not allowed'}),profile({first_name:'x'.repeat(101)})])await denied(()=>guest('guest',randomUUID(),p),'22023');
  for(const p of [null,[],{},prayer({share_scope:'church'}),prayer({submitted_auth_user_id:ids.other}),prayer({request_text:3}),prayer({request_text:' '}),prayer({request_text:'x'.repeat(10001)}),prayer({contact_text:'x'.repeat(321)}),prayer({display_name:[]})])await denied(()=>pray('prayer',randomUUID(),p),'22023');
  assert.equal((await rows('select count(*)::int n from private.app_intake_receipts'))[0].n,n);
 });
 await t.test('own projection and direct-table denials preserve other profiles, private notes, membership and staff roles',async()=>{
  const other=await guest('other',firstRequest,profile({first_name:'Other'}));assert.notEqual(other.id,reg.id);
  await db.query("update public.app_connections set staff_notes='Private fixture',welcome_owner='Staff fixture' where id=$1",[reg.id]);
  const own=await mine('guest');for(const k of ['auth_user_id','staff_notes','welcome_owner','staff_visit_on','follow_up_status','staff_version','contact_id','reviewed_by'])assert.equal(k in own,false,k);
  for(const name of ['guest','other']){assert.equal((await as(name,'select * from public.app_connections')).length,0);assert.equal((await as(name,'select * from public.contacts')).length,0);assert.equal((await as(name,'select * from public.office_prayer_requests')).length,0);
   await denied(()=>as(name,'insert into public.staff_roles(user_id,role)values($1,\'admin\')',[ids[name]]));await denied(()=>as(name,"insert into public.app_connections(auth_user_id,first_name,email,preferred_contact,contact_permission)values($1,'Bypass','other@example.invalid','email',true)",[ids[name]]));}
  assert.deepEqual(await rows('select * from public.staff_roles order by user_id'),f.oldRoles);
 });
 await t.test('prayer is private, separately idempotent, contains no mail job/person, and provenance cannot be rewritten',async()=>{
  const before=(await rows('select count(*)::int n from private.app_welcome_outbox'))[0].n;const key=randomUUID();
  prayerReceipt=await pray('prayer',key,{request_text:'  Fictional private prayer.  '});assert.deepEqual(Object.keys(prayerReceipt).sort(),['id','submitted_at']);
  assert.deepEqual(await pray('prayer',key,{request_text:'Fictional private prayer.',display_name:null,contact_text:''}),prayerReceipt);
  await denied(()=>pray('prayer',key,prayer({request_text:'Changed'})),'40001');
  const stored=(await rows('select * from public.office_prayer_requests where id=$1',[prayerReceipt.id]))[0];assert.equal(stored.source,'app');assert.equal(stored.submitted_auth_user_id,ids.prayer);assert.equal(stored.share_scope,'staff_only');assert.equal(stored.sharing_approved,false);assert.equal(stored.created_by,ids.prayer);assert.equal(stored.display_name,'Name not supplied');
  assert.equal(await mine('prayer'),null);assert.equal((await rows('select count(*)::int n from private.app_welcome_outbox'))[0].n,before);
  await denied(()=>as('editor',"update public.office_prayer_requests set source='office',submitted_auth_user_id=null where id=$1",[prayerReceipt.id]),'23514');
  await as('editor',"update public.office_prayer_requests set contact_text='Fictional update',care_notes='Private staff note' where id=$1",[prayerReceipt.id]);
  assert.equal((await as('guest','select * from public.audit_log')).length,0);
 });
 await t.test('follow-up edits use independent optimistic staff version and cannot overwrite profile/review fields',async()=>{
  for(const name of ['guest','viewer','unconfirmed_staff'])await denied(()=>rpc(name,'update_guest_followup',[reg.id,1,{follow_up_status:'contacted'}]));
  for(const p of [{},[],{version:3},{staff_notes:'Not allowed'},{follow_up_status:null},{follow_up_status:'bad'},{staff_visit_on:'2026-02-30'},{welcome_owner:4}])await denied(()=>rpc('editor','update_guest_followup',[reg.id,1,p]),'22023');
  const before=(await rows('select * from public.app_connections where id=$1',[reg.id]))[0];
  assert.deepEqual(await rpc('editor','update_guest_followup',[reg.id,1,{staff_visit_on:'2026-09-09',follow_up_on:'2026-09-11',follow_up_status:'contacted',welcome_owner:'  Fictional staff  '}]),{id:reg.id,staff_version:2});
  const after=(await rows('select * from public.app_connections where id=$1',[reg.id]))[0];for(const k of ['version','status','contact_id','reviewed_at','reviewed_by','reviewed_version','first_visit_on','updated_at','staff_notes'])assert.deepEqual(after[k],before[k],k);
  await denied(()=>rpc('admin','update_guest_followup',[reg.id,1,{follow_up_status:'closed'}]),'40001');
  await guest('guest',randomUUID(),profile());assert.equal((await rows('select staff_version from public.app_connections where id=$1',[reg.id]))[0].staff_version,2);
 });
 await t.test('existing staff review still creates exactly one visitor/welcome plan and re-review cannot overwrite that person',async()=>{
  const current=await mine('guest');const args=[reg.id,current.version,null,true,'Private review','Fictional owner'];const result=await rpc('editor','review_app_connection',args);
  const contact=(await rows('select * from public.contacts where id=$1',[result.contact_id]))[0];const plans=await rows("select * from public.care_assignments where contact_id=$1 and care_role='welcome'",[contact.id]);assert.equal(plans.length,1);
  const replay=await rpc('admin','review_app_connection',args);assert.equal(replay.already_reviewed,true);
  const updated=await guest('guest',randomUUID(),profile({first_name:'Later self report'}));
  await rpc('editor','review_app_connection',[reg.id,updated.version,contact.id,false,'Other note','Other owner']);
  assert.deepEqual((await rows('select * from public.contacts where id=$1',[contact.id]))[0],contact);assert.deepEqual(await rows("select * from public.care_assignments where contact_id=$1 and care_role='welcome'",[contact.id]),plans);
 });
 await t.test('per-user guest hourly quota leaves receipt replay usable and rejects additional version changes',async()=>{
  while((await rows("select count(*)::int n from private.app_intake_receipts where auth_user_id=$1 and kind='guest'",[ids.guest]))[0].n<10)await guest('guest');
  const before=await mine('guest');await denied(()=>guest('guest'),'P0001');assert.deepEqual(await mine('guest'),before);assert.deepEqual(await guest('guest',firstRequest,profile()),reg);
  await guest('other');
 });
 await t.test('prayer hourly and rolling-day caps enforce new requests only; rejected requests cannot consume receipts',async()=>{
  while((await rows("select count(*)::int n from private.app_intake_receipts where auth_user_id=$1 and kind='prayer'",[ids.prayer]))[0].n<10)await pray('prayer');
  await denied(()=>pray('prayer'),'P0001');
  for(let round=0;round<4;round++){
   await db.query("update private.app_intake_receipts set created_at=now()-interval '2 hours' where auth_user_id=$1 and kind='prayer'",[ids.prayer]);
   for(let i=0;i<10;i++)await pray('prayer');
  }
  await db.query("update private.app_intake_receipts set created_at=now()-interval '2 hours' where auth_user_id=$1 and kind='prayer'",[ids.prayer]);
  await denied(()=>pray('prayer'),'P0001');assert.equal((await rows("select count(*)::int n from private.app_intake_receipts where auth_user_id=$1 and kind='prayer'",[ids.prayer]))[0].n,50);
 });
 await t.test('welcome claim freezes payload/template and records lease/first attempt before caller sends anything',async()=>{
  const jobs=await claim(ids.guest,1);assert.equal(jobs.length,1);firstJob=jobs[0];assert.equal(firstJob.recipient,'guest@example.invalid');assert.equal(firstJob.first_name,'Fictional');assert.equal(firstJob.template_version,'creek-welcome-v1');assert.equal(firstJob.attempts,1);
  const stored=(await rows('select * from private.app_welcome_outbox where id=$1',[firstJob.id]))[0];assert.equal(stored.status,'sending');assert.equal(stored.lease_token,firstJob.lease_token);assert.equal(new Date(stored.lease_until)-new Date(stored.first_attempt_at),120000);
  assert.deepEqual(await claim(ids.guest,1),[]);assert.equal((await rows('select welcome_email_status from public.app_connections where id=$1',[reg.id]))[0].welcome_email_status,'sending');
  for(const limit of [null,0,-1,11])await denied(()=>claim(null,limit),'22023');
 });
 await t.test('lease token/expiry and fixed finish fields prevent overwrites, with bounded backoff and stable retry identity',async()=>{
  await denied(()=>finish({...firstJob,lease_token:randomUUID()}),'40001');
  await denied(()=>finish(firstJob,'sent','not-a-uuid'),'22023');await denied(()=>finish(firstJob,'retry',null,'raw secret details'),'22023');
  assert.deepEqual(await finish(firstJob,'retry',null,'provider_timeout'),{id:firstJob.id,status:'retry'});
  assert.deepEqual(await claim(ids.guest,1),[]);const waiting=(await rows('select * from private.app_welcome_outbox where id=$1',[firstJob.id]))[0];assert.equal(waiting.status,'queued');assert.ok(new Date(waiting.next_attempt_at)-Date.now()>55000);
  await db.query("update private.app_welcome_outbox set next_attempt_at=now()-interval '1 second' where id=$1",[firstJob.id]);
  const next=(await claim(ids.guest,1))[0];assert.equal(next.id,firstJob.id);assert.equal(next.first_attempt_at,firstJob.first_attempt_at);assert.equal(next.first_name,firstJob.first_name);assert.equal(next.template_version,firstJob.template_version);assert.equal(next.attempts,2);assert.notEqual(next.lease_token,firstJob.lease_token);
  await denied(()=>finish(firstJob),'40001');await finish(next);await denied(()=>finish(next,'attention',null,'delivery_uncertain'),'40001');assert.deepEqual(await claim(ids.guest,1),[]);
 });
 await t.test('normalized-email dedup links registrations to the original terminal job without a second email',async()=>{
  await db.query("update auth.users set email='GUEST@example.invalid' where id=$1",[ids.duplicate]);
  const r=await guest('duplicate');assert.equal(r.welcome_email_status,'sent');assert.notEqual(r.id,reg.id);
  assert.equal((await rows('select count(*)::int n from private.app_welcome_links where outbox_id=$1',[firstJob.id]))[0].n,2);assert.deepEqual(await claim(ids.duplicate,1),[]);
 });
 await t.test('expired leases recover, but 23-hour jobs and banned/deleted accounts go to manual attention without another attempt',async()=>{
  const job=(await claim(ids.other,1))[0];await db.query("update private.app_welcome_outbox set lease_until=now()-interval '1 second' where id=$1",[job.id]);
  await denied(()=>finish(job),'40001');const retry=(await claim(ids.other,1))[0];assert.equal(retry.id,job.id);assert.notEqual(retry.lease_token,job.lease_token);
  await db.query("update private.app_welcome_outbox set first_attempt_at=now()-interval '23 hours',lease_until=now()-interval '1 second' where id=$1",[job.id]);
  assert.deepEqual(await claim(ids.other,1),[]);const stopped=(await rows('select * from private.app_welcome_outbox where id=$1',[job.id]))[0];assert.equal(stopped.status,'attention');assert.equal(stopped.error_code,'retry_window_expired');assert.equal(stopped.attempts,2);
  await db.query('update auth.users set banned_until=null where id=$1',[ids.banned]);const banned=await guest('banned');await db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1",[ids.banned]);assert.deepEqual(await claim(ids.banned,1),[]);assert.equal((await rows('select welcome_email_status from public.app_connections where id=$1',[banned.id]))[0].welcome_email_status,'attention');
 });
});

test('80 first-attempt UTC-day slots cap jobs while a valid retry keeps its original slot',async t=>{
 const{db,rows,rpc}=await setup(t);let first;
 for(let i=0;i<84;i++){
  const id=randomUUID();if(i===0)first=id;
  await db.query('insert into auth.users(id,email,is_anonymous)values($1,$2,false)',[id,`quota-${i}@example.invalid`]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');
  try{await db.query('select public.register_app_guest($1,$2)',[randomUUID(),profile()]);}finally{await db.exec('reset role');}
 }
 const claims=[];for(let i=0;i<9;i++)claims.push(...await rpc('service_role','claim_app_welcome_jobs',[null,10]));assert.equal(claims.length,80);assert.equal(new Set(claims.map(x=>x.id)).size,80);
 assert.equal((await rows("select first_attempts from private.app_welcome_daily_quota where utc_day=(now() at time zone 'UTC')::date"))[0].first_attempts,80);
 assert.equal((await rows("select count(*)::int n from private.app_welcome_outbox where first_attempt_at is null and status='queued'"))[0].n,4);
 const job=claims[0],owner=(await rows('select c.auth_user_id from private.app_welcome_outbox j join public.app_connections c on c.id=j.registration_id where j.id=$1',[job.id]))[0].auth_user_id;
 await rpc('service_role','finish_app_welcome_job',[job.id,job.lease_token,'retry',null,'provider_unavailable']);await db.query("update private.app_welcome_outbox set next_attempt_at=now()-interval '1 second' where id=$1",[job.id]);
 const retry=await rpc('service_role','claim_app_welcome_jobs',[owner,1]);assert.equal(retry.length,1);assert.equal(retry[0].attempts,2);assert.equal(retry[0].first_attempt_at,job.first_attempt_at);
 assert.equal((await rows('select first_attempts from private.app_welcome_daily_quota'))[0].first_attempts,80);
});


test('legacy registrations are preserved without retroactive mail; account eligibility is rechecked after registration',async t=>{
 const{db,rows,rpc}=await setup(t,{legacy:true});
 const old=(await rows('select * from public.app_connections'))[0];assert.equal(old.welcome_email_status,'attention');
 const result=await rpc('guest','register_app_guest',[randomUUID(),profile()]);assert.equal(result.id,old.id);assert.equal(result.version,old.version+1);assert.equal(result.welcome_email_status,'attention');
 assert.equal((await rows('select count(*)::int n from private.app_welcome_outbox'))[0].n,0);assert.equal((await rows('select * from public.app_connections'))[0].staff_notes,'Prior private note');
 await db.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1",[ids.guest]);
 await denied(()=>rpc('guest','get_my_app_connection'));await denied(()=>rpc('guest','register_app_guest',[randomUUID(),profile()]));await denied(()=>rpc('guest','submit_app_prayer',[randomUUID(),prayer()]));
 await db.query("update auth.users set banned_until=now()-interval '1 second' where id=$1",[ids.guest]);assert.equal((await rpc('guest','get_my_app_connection')).id,old.id);
 const other=await rpc('other','register_app_guest',[randomUUID(),profile()]);await db.query('update auth.users set deleted_at=now() where id=$1',[ids.other]);assert.deepEqual(await rpc('service_role','claim_app_welcome_jobs',[ids.other,1]),[]);assert.equal((await rows('select welcome_email_status from public.app_connections where id=$1',[other.id]))[0].welcome_email_status,'attention');
});

test('durable intake tasks, approved routing and generic staff notices share the welcome safety contract',async t=>{
 const{db,rows,as,rpc}=await setup(t);
 await db.query('update auth.users set email_confirmed_at=now() where id=$1',[ids.unconfirmed_staff]);
 const submit=(who='guest',key=randomUUID())=>rpc(who,'register_app_guest',[key,profile()]);
 const pray=(who='prayer',key=randomUUID())=>rpc(who,'submit_app_prayer',[key,prayer()]);
 const taskFor=async(source)=> (await rows('select * from public.app_submission_tasks where registration_id=$1 or prayer_request_id=$1',[source]))[0];
 const claim=(who=null,n=10)=>rpc('service_role','claim_app_staff_notice_jobs',[who,n]);
 const finish=(j,status='sent',provider=randomUUID(),error=null)=>rpc('service_role','finish_app_staff_notice_job',[j.id,j.lease_token,status,provider,error]);
 let registration,task,prayerTask;
 await t.test('new guest and prayer each save one durable task atomically; replays and profile edits cannot duplicate them',async()=>{
  const key=randomUUID();registration=await submit('guest',key);task=await taskFor(registration.id);
  assert.equal(task.kind,'guest_followup');assert.equal(task.routing,'office');assert.equal(task.assigned_staff_user_id,null);assert.equal(task.status,'new');assert.equal(task.version,1);
  assert.deepEqual(task.due_on,(await rows("select (now() at time zone 'America/Chicago')::date+2 as expected_date"))[0].expected_date);
  assert.equal((await rows('select count(*)::int n from private.app_staff_notice_outbox where task_id=$1',[task.id]))[0].n,2);
  await submit('guest',key);await submit('guest');assert.equal((await rows('select count(*)::int n from public.app_submission_tasks'))[0].n,1);
  const pkey=randomUUID(),p=await pray('prayer',pkey);await pray('prayer',pkey);prayerTask=await taskFor(p.id);
  assert.equal(prayerTask.kind,'prayer_care');assert.equal(prayerTask.registration_id,null);assert.deepEqual(prayerTask.due_on,(await rows("select (now() at time zone 'America/Chicago')::date as expected_date"))[0].expected_date);
  assert.equal((await rows('select count(*)::int n from public.app_submission_tasks'))[0].n,2);assert.equal((await rows('select count(*)::int n from private.app_welcome_outbox'))[0].n,1);
  // A downstream failure rolls the entire submission and its receipt back.
  await db.exec("create function private.reject_task_fixture() returns trigger language plpgsql as $$begin raise exception 'FICTIONAL_TASK_FAILURE';end$$;create trigger fictional_task_failure before insert on public.app_submission_tasks for each row execute function private.reject_task_fixture();");
  await denied(()=>submit('other'),'P0001');
  assert.equal((await rows('select count(*)::int n from public.app_connections where auth_user_id=$1',[ids.other]))[0].n,0);
  assert.equal((await rows('select count(*)::int n from private.app_intake_receipts where auth_user_id=$1',[ids.other]))[0].n,0);
  await db.exec('drop trigger fictional_task_failure on public.app_submission_tasks;drop function private.reject_task_fixture();');
 });
 await t.test('task and audit reads require editor/admin; neither guests nor staff can bypass versioned task RPCs',async()=>{
  for(const who of ['guest','prayer','viewer']){assert.deepEqual(await as(who,'select * from public.app_submission_tasks'),[]);assert.deepEqual(await as(who,"select * from public.audit_log where entity_type='app_submission_tasks'"),[]);}
  for(const who of ['admin','editor'])assert.equal((await as(who,'select * from public.app_submission_tasks')).length,2);
  for(const who of ['anon','guest','admin','editor','viewer','service_role']){
   await denied(()=>as(who,"update public.app_submission_tasks set status='completed' where id=$1",[task.id]));
   for(const table of ['app_intake_routes','app_staff_notice_outbox'])await denied(()=>as(who,'select * from private.'+table));
   await denied(()=>as(who,"select private.create_intake_task('guest_followup',$1,$2)",[registration.id,ids.guest]));
  }
  for(const who of ['guest','viewer','anon']){await denied(()=>rpc(who,'get_intake_settings'));await denied(()=>rpc(who,'update_intake_task',[task.id,1,{status:'in_progress'}]));}
  for(const who of ['guest','admin','editor','viewer','anon']){await denied(()=>rpc(who,'claim_app_staff_notice_jobs',[null,1]));await denied(()=>rpc(who,'finish_app_staff_notice_job',[randomUUID(),randomUUID(),'sent',randomUUID(),null]));}
 });
 await t.test('route configuration offers only existing eligible staff, requires admin and expected version, and affects only future tasks',async()=>{
  const settings=await rpc('editor','get_intake_settings');assert.equal(settings.version,1);assert.equal(settings.routes.length,2);assert.deepEqual(new Set(settings.staff.map(s=>s.id)),new Set([ids.admin,ids.editor,ids.unconfirmed_staff]));
  assert.ok(settings.staff.every(s=>Object.keys(s).sort().join(',')==='id,label'&&s.label.endsWith('.invalid')));
  await denied(()=>rpc('editor','set_intake_route',['guest_followup',1,ids.editor]));
  for(const who of ['guest','viewer','anonymous','banned','deleted','missing'])await denied(()=>rpc('admin','set_intake_route',['guest_followup',1,ids[who]||randomUUID()]),'22023');
  assert.deepEqual(await rpc('admin','set_intake_route',['guest_followup',1,ids.editor]),{kind:'guest_followup',version:2});
  await denied(()=>rpc('admin','set_intake_route',['guest_followup',1,null]),'40001');assert.equal((await taskFor(registration.id)).assigned_staff_user_id,null);
  const r=await submit('other'),otherTask=await taskFor(r.id);assert.equal(otherTask.assigned_staff_user_id,ids.editor);assert.equal(otherTask.routing,'staff');
  const notices=await rows('select * from private.app_staff_notice_outbox where task_id=$1',[otherTask.id]);assert.equal(notices.length,1);assert.equal(notices[0].recipient_staff_user_id,ids.editor);
  await db.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1",[ids.editor]);
  const fallback=await taskFor((await submit('duplicate')).id);assert.equal(fallback.assigned_staff_user_id,null);assert.equal(fallback.routing,'office');
  assert.ok(!(await rpc('admin','get_intake_settings')).staff.some(s=>s.id===ids.editor));await db.query('update auth.users set banned_until=null where id=$1',[ids.editor]);
 });
 await t.test('task edits validate dates/assignment, preserve sources, own completion fields and detect stale writes',async()=>{
  for(const changes of [{due_on:null},{due_on:'2026-02-30'},{status:null},{assigned_staff_user_id:ids.viewer},{assigned_staff_user_id:'wrong'},{submitted_auth_user_id:ids.other},{completed_by:ids.admin},[],{}])await denied(()=>rpc('editor','update_intake_task',[task.id,1,changes]),'22023');
  assert.deepEqual(await rpc('editor','update_intake_task',[task.id,1,{due_on:'2026-12-31',status:'completed',assigned_staff_user_id:ids.editor}]),{id:task.id,version:2});
  let edited=await taskFor(registration.id);assert.equal(edited.completed_by,ids.editor);assert.ok(edited.completed_at);assert.equal(edited.registration_id,registration.id);assert.equal(edited.submitted_auth_user_id,ids.guest);
  await denied(()=>rpc('admin','update_intake_task',[task.id,1,{status:'new'}]),'40001');
  await rpc('admin','update_intake_task',[task.id,2,{status:'in_progress'}]);edited=await taskFor(registration.id);assert.equal(edited.completed_at,null);assert.equal(edited.completed_by,null);
  assert.equal((await rows('select count(*)::int n from private.app_staff_notice_outbox where task_id=$1',[task.id]))[0].n,3);
 });
 await t.test('notice claim scopes by submitter, excludes former targets, and freezes only generic private-item metadata',async()=>{
  assert.deepEqual(await claim(ids.unknown),[]);
  const jobs=await claim(ids.guest);assert.equal(jobs.length,1);const j=jobs[0];assert.equal(j.recipient,'editor@example.invalid');assert.equal(j.task_id,task.id);assert.equal(j.task_kind,'guest_followup');assert.equal(j.template_version,'creek-office-notice-v1');assert.equal(j.attempts,1);
  assert.deepEqual(Object.keys(j).sort(),['attempts','first_attempt_at','id','lease_token','recipient','task_id','task_kind','template_version']);
  const old=await rows('select status,error_code from private.app_staff_notice_outbox where task_id=$1 and recipient_staff_user_id<>$2',[task.id,ids.editor]);assert.ok(old.every(r=>r.status==='attention'&&r.error_code==='invalid_job'));
  assert.equal((await taskFor(registration.id)).notification_status,'sending');await finish(j);assert.equal((await taskFor(registration.id)).notification_status,'sent');
  await denied(()=>finish(j),'40001');assert.deepEqual(await claim(ids.guest),[]);
  await rpc('admin','update_intake_task',[task.id,3,{assigned_staff_user_id:null}]);await rpc('admin','update_intake_task',[task.id,4,{assigned_staff_user_id:ids.editor}]);
  assert.equal((await rows('select count(*)::int n from private.app_staff_notice_outbox where task_id=$1',[task.id]))[0].n,3);assert.equal((await taskFor(registration.id)).notification_status,'sent');
 });
 await t.test('notice status reflects all current Office recipients; stale/invalid finish cannot mark acceptance',async()=>{
  const jobs=await claim(ids.prayer);assert.equal(jobs.length,2);await denied(()=>finish({...jobs[0],lease_token:randomUUID()}),'40001');await denied(()=>finish(jobs[0],'sent','invalid'),'22023');await denied(()=>finish(jobs[0],'retry',null,'raw server body'),'22023');
  await finish(jobs[0]);assert.equal((await rows('select notification_status from public.app_submission_tasks where id=$1',[prayerTask.id]))[0].notification_status,'sending');
  await finish(jobs[1],'retry',null,'provider_timeout');assert.deepEqual(await claim(ids.prayer),[]);
  await db.query("update private.app_staff_notice_outbox set next_attempt_at=now()-interval '1 second' where id=$1",[jobs[1].id]);
  const retry=(await claim(ids.prayer))[0];assert.equal(retry.id,jobs[1].id);assert.equal(retry.first_attempt_at,jobs[1].first_attempt_at);assert.equal(retry.template_version,jobs[1].template_version);assert.equal(retry.attempts,2);assert.notEqual(retry.lease_token,jobs[1].lease_token);
  await finish(retry);assert.equal((await rows('select notification_status from public.app_submission_tasks where id=$1',[prayerTask.id]))[0].notification_status,'sent');
 });
 await t.test('23-hour, ineligible submitting accounts and revoked recipients stop notices without another claim',async()=>{
  const jobs=await claim(ids.other);assert.equal(jobs.length,1);const j=jobs[0];
  await db.query("update private.app_staff_notice_outbox set first_attempt_at=now()-interval '23 hours',lease_until=now()-interval '1 second' where id=$1",[j.id]);await denied(()=>finish(j),'40001');assert.deepEqual(await claim(ids.other),[]);
  const expired=(await rows('select * from private.app_staff_notice_outbox where id=$1',[j.id]))[0];assert.equal(expired.error_code,'retry_window_expired');assert.equal(expired.attempts,1);
  await db.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1",[ids.duplicate]);assert.deepEqual(await claim(ids.duplicate),[]);
  assert.ok((await rows('select j.* from private.app_staff_notice_outbox j join public.app_submission_tasks t on t.id=j.task_id where t.submitted_auth_user_id=$1',[ids.duplicate])).every(j=>j.status==='attention'&&j.attempts===0));
  const r=await pray('guest'),p=await taskFor(r.id);await rpc('admin','update_intake_task',[p.id,1,{assigned_staff_user_id:ids.editor}]);await db.query('delete from public.staff_roles where user_id=$1',[ids.editor]);assert.deepEqual(await claim(ids.guest),[]);
  assert.equal((await taskFor(r.id)).notification_status,'attention');
 });
});

test('welcome and Office notices consume one combined 80-slot budget; notice retries do not consume new slots',async t=>{
 const{db,rows,rpc}=await setup(t);const reg=await rpc('guest','register_app_guest',[randomUUID(),profile()]);
 await db.exec("insert into private.app_welcome_daily_quota(utc_day,first_attempts)values((now() at time zone 'UTC')::date,79)");
 const notices=await rpc('service_role','claim_app_staff_notice_jobs',[ids.guest,10]);assert.equal(notices.length,1);
 assert.deepEqual(await rpc('service_role','claim_app_welcome_jobs',[ids.guest,1]),[]);
 const j=notices[0];await rpc('service_role','finish_app_staff_notice_job',[j.id,j.lease_token,'retry',null,'provider_unavailable']);
 await db.query("update private.app_staff_notice_outbox set next_attempt_at=now()-interval '1 second' where id=$1",[j.id]);
 const retry=await rpc('service_role','claim_app_staff_notice_jobs',[ids.guest,1]);assert.equal(retry.length,1);assert.equal(retry[0].attempts,2);
 assert.equal((await rows('select first_attempts from private.app_welcome_daily_quota'))[0].first_attempts,80);
 assert.equal((await rows('select welcome_email_status from public.app_connections where id=$1',[reg.id]))[0].welcome_email_status,'queued');
});

test('optional self-reported household details remain private, canonical and backward compatible',async t=>{
 const{db,rows,as,rpc}=await setup(t);
 const details={birth_date:'1990-02-28',membership_status:'member',address_line1:'  100 Fictional Lane  ',address_line2:' ',city:' Example ',state_region:'LA',postal_code:'00000',family_members:[{first_name:' Fictional child ',relationship:'child',birth_date:'2020-02-29'},{first_name:'Fictional spouse',last_name:null,relationship:'spouse'}]};
 let receipt,originalKey,oldKey,oldReceipt;
 await t.test('new optional fields normalize without membership merges or expanded email payloads',async()=>{
  originalKey=randomUUID();receipt=await rpc('guest','register_app_guest',[originalKey,profile(details)]);
  const own=await rpc('guest','get_my_app_connection');assert.equal(own.birth_date,'1990-02-28');assert.equal(own.membership_status,'member');assert.equal(own.address_line1,'100 Fictional Lane');assert.equal(own.address_line2,null);assert.equal(own.city,'Example');
  assert.deepEqual(own.family_members,[{first_name:'Fictional child',last_name:'',relationship:'child',birth_date:'2020-02-29'},{first_name:'Fictional spouse',last_name:'',relationship:'spouse',birth_date:null}]);
  assert.equal((await rows('select count(*)::int n from public.contacts'))[0].n,0);assert.equal((await rows('select contact_id from public.app_connections'))[0].contact_id,null);
  const welcome=await rpc('service_role','claim_app_welcome_jobs',[ids.guest,1]);assert.equal(welcome.length,1);assert.deepEqual(Object.keys(welcome[0]).sort(),['attempts','first_attempt_at','first_name','id','lease_token','recipient','template_version']);assert.ok(!JSON.stringify(welcome).includes('Fictional child'));
  const notices=await rpc('service_role','claim_app_staff_notice_jobs',[ids.guest,1]);assert.ok(!JSON.stringify(notices).includes('Fictional child'));
 });
 await t.test('normalized nested receipt replay matches while changed household payload conflicts',async()=>{
  const normalized={...details,address_line1:'100 Fictional Lane',address_line2:null,city:'Example',family_members:[{first_name:'Fictional child',last_name:'',relationship:'child',birth_date:'2020-02-29'},{first_name:'Fictional spouse',relationship:'spouse',birth_date:null}]};
  assert.deepEqual(await rpc('guest','register_app_guest',[originalKey,profile(normalized)]),receipt);
  await denied(()=>rpc('guest','register_app_guest',[originalKey,profile({...normalized,family_members:[]})]),'40001');
 });
 await t.test('older-client omission preserves existing details and its receipt hash remains stable after a newer edit',async()=>{
  oldKey=randomUUID();oldReceipt=await rpc('guest','register_app_guest',[oldKey,profile({first_name:'Updated'})]);
  let own=await rpc('guest','get_my_app_connection');assert.equal(own.family_members.length,2);assert.equal(own.birth_date,details.birth_date);assert.equal(own.city,'Example');
  await rpc('guest','register_app_guest',[randomUUID(),profile({city:'Updated city'})]);
  assert.deepEqual(await rpc('guest','register_app_guest',[oldKey,profile({first_name:'Updated'})]),oldReceipt);
  own=await rpc('guest','get_my_app_connection');assert.equal(own.city,'Updated city');assert.equal(own.version,3);
 });
 await t.test('invalid detail types, future/impossible dates, hidden nested keys and excessive households fail without writes',async()=>{
  const invalid=[{birth_date:'2999-01-01'},{birth_date:'2025-02-29'},{birth_date:42},{membership_status:null},{membership_status:'verified_member'},
   {address_line1:'a'.repeat(161)},{address_line2:{}},{city:'a'.repeat(101)},{state_region:false},{postal_code:'a'.repeat(21)},
   {family_members:null},{family_members:{}},{family_members:Array.from({length:21},()=>({first_name:'Fictional',relationship:'child'}))},
   {family_members:[null]},{family_members:[{first_name:'',relationship:'child'}]},{family_members:[{first_name:'a'.repeat(101),relationship:'child'}]},
   {family_members:[{first_name:'Fictional',relationship:'child',last_name:'b'.repeat(101)}]},
   {family_members:[{first_name:'Fictional',relationship:'child',birth_date:'2999-01-01'}]},
   {family_members:[{first_name:'Fictional',relationship:'unapproved'}]},
   {family_members:[{first_name:'Fictional',relationship:'child',staff_role:'admin'}]},
   {family_members:[{first_name:'Fictional',relationship:'child',email:'hidden@example.invalid'}]}];
  const before=await rows('select version,family_members from public.app_connections');
  for(const fields of invalid)await denied(()=>rpc('guest','register_app_guest',[randomUUID(),profile(fields)]),'22023');
  assert.deepEqual(await rows('select version,family_members from public.app_connections'),before);
  assert.equal((await rows('select count(*)::int n from private.app_intake_receipts'))[0].n,3);
 });
 await t.test('only own profile and eligible Office editors can see household details; optional clears and new defaults are explicit',async()=>{
  assert.equal(await rpc('other','get_my_app_connection'),null);assert.deepEqual(await as('other','select birth_date,family_members from public.app_connections'),[]);assert.deepEqual(await as('viewer','select birth_date,family_members from public.app_connections'),[]);
  assert.equal((await as('editor','select family_members from public.app_connections'))[0].family_members.length,2);
  await rpc('guest','register_app_guest',[randomUUID(),profile({birth_date:null,membership_status:'unsure',address_line1:'',address_line2:null,city:null,state_region:null,postal_code:null,family_members:[]})]);
  const own=await rpc('guest','get_my_app_connection');assert.equal(own.birth_date,null);assert.equal(own.address_line1,null);assert.equal(own.membership_status,'unsure');assert.deepEqual(own.family_members,[]);
  await rpc('other','register_app_guest',[randomUUID(),profile()]);const fresh=await rpc('other','get_my_app_connection');assert.equal(fresh.birth_date,null);assert.equal(fresh.membership_status,'unsure');assert.deepEqual(fresh.family_members,[]);
 });
 await t.test('twenty valid household entries and today birthday are accepted without extra tasks or notices',async()=>{
  const today=(await rows("select to_char((now() at time zone 'America/Chicago')::date,'YYYY-MM-DD') today"))[0].today;
  await rpc('guest','register_app_guest',[randomUUID(),profile({birth_date:today,family_members:Array.from({length:20},(_,i)=>({first_name:'Fictional '+i,relationship:'other',birth_date:today}))})]);
  assert.equal((await rpc('guest','get_my_app_connection')).family_members.length,20);
  assert.equal((await rows('select count(*)::int n from public.app_submission_tasks'))[0].n,2);assert.equal((await rows('select count(*)::int n from private.app_welcome_outbox'))[0].n,2);
 });
});
