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
const sql=await readFile(new URL('./migrations/20260911023920_communication_preferences.sql',import.meta.url),'utf8');
const names=['admin','editor','viewer','unconfirmed_staff','anonymous','banned','deleted','missing',...Array.from({length:12},(_,i)=>'g'+(i+1))];
const ids=Object.fromEntries(names.map((n,i)=>[n,`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
const profile=(extra={})=>({first_name:'Fictional',last_name:'Guest',phone:null,preferred_contact:'email',contact_permission:true,sunday_school:null,visit_status:'not_yet',first_visit_on:null,...extra});
const absent={version:1,preference_version:0,weekly_email:false,email_matches:true,updated_at:null};
const denied=(fn,code='42501',message)=>assert.rejects(fn,e=>e.code===code&&(!message||e.message===message));
async function setup(t,{rotation=false}={}){
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
 const get=name=>rpc(name,'get_my_communication_preferences');
 const set=(name,expected,weekly,key=randomUUID())=>rpc(name,'set_my_communication_preferences',[key,expected,weekly]);
 const guest=(name,key=randomUUID(),p=profile())=>rpc(name,'register_app_guest',[key,p]);
 const register=(name,expected,weekly,key=randomUUID(),p=profile())=>rpc(name,'register_app_guest_with_preferences',[key,p,weekly,expected]);
 const audience=(actor='admin')=>rpc(actor,'get_office_communication_audience');
 const counts=()=>rows("select (select count(*) from public.app_connections)::int profiles,(select count(*) from public.app_submission_tasks)::int tasks,(select count(*) from private.app_welcome_outbox)::int welcomes,(select count(*) from private.app_staff_notice_outbox)::int notices,(select count(*) from private.app_intake_receipts)::int intake_receipts,(select count(*) from private.app_communication_preferences)::int preferences,(select count(*) from private.app_communication_receipts)::int preference_receipts,(select count(*) from public.audit_log)::int audit");
 return{db,rows,as,rpc,get,set,guest,register,audience,counts,functionState,oldFunctions,oldPolicies,oldRoles,oldBucket,oldPrivateAcl};
}

test('communication APIs retain the existing security boundary and default to no weekly email',async t=>{
 const f=await setup(t);
 await t.test('anonymous capability is a constant only; own preferences default absent without creating records',async()=>{
  for(const actor of ['anon','g1','admin'])assert.deepEqual(await f.rpc(actor,'get_app_communication_capabilities'),{version:1,weekly_email:true});
  assert.deepEqual(await f.get('g1'),absent);assert.deepEqual(await f.get('admin'),absent);assert.equal((await f.counts())[0].preferences,0);
  assert.equal((await f.audience()).total,0);assert.deepEqual((await f.audience()).rows,[]);
 });
 await t.test('all original function bodies, ACLs, roles, policies, bucket and private-schema privileges are preserved',async()=>{
  const functions=await f.functionState();for(const old of f.oldFunctions)assert.deepEqual(functions.find(x=>x.nspname===old.nspname&&x.proname===old.proname&&x.args===old.args),old);
  assert.deepEqual(await f.rows('select * from pg_policies order by schemaname,tablename,policyname'),f.oldPolicies);assert.deepEqual(await f.rows('select * from public.staff_roles order by user_id'),f.oldRoles);assert.deepEqual(await f.rows('select * from storage.buckets'),f.oldBucket);assert.deepEqual(await f.rows("select nspacl::text from pg_namespace where nspname='private'"),f.oldPrivateAcl);
 });
 await t.test('new private current/history tables have RLS and deny direct access even to staff and service',async()=>{
  assert.equal((await f.rows("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname in('app_communication_preferences','app_communication_receipts') and c.relrowsecurity"))[0].n,2);
  for(const actor of ['anon','g1','admin','editor','viewer','service_role','unrelated'])for(const table of ['app_communication_preferences','app_communication_receipts']){await denied(()=>f.as(actor,'select * from private.'+table));await denied(()=>f.as(actor,'delete from private.'+table));}
  for(const actor of ['g1','admin','service_role'])await denied(()=>f.as(actor,"select private.save_communication_preference($1,0,true,'preference',null,null)",[randomUUID()]));
 });
 await t.test('own RPCs reject missing/anonymous/banned/deleted accounts and Office audience rejects nonstaff/viewer',async()=>{
  for(const actor of ['anon','anonymous','banned','deleted','missing','service_role','unrelated']){await denied(()=>f.get(actor));await denied(()=>f.set(actor,0,true));await denied(()=>f.register(actor,0,true));}
  for(const actor of ['anon','g1','viewer','unconfirmed_staff','service_role','unrelated'])await denied(()=>f.audience(actor));assert.equal((await f.audience('editor')).total,0);
  for(const schema of ['public','private'])await denied(()=>f.as('g1',`select ${schema}.save_app_connection('Old','Path',null,'email',true,null)`));
 });
 await t.test('invalid request fields cannot alter any profile, preference or mail job',async()=>{
  const before=await f.counts();for(const args of [[null,0,true],[randomUUID(),null,true],[randomUUID(),-1,true],[randomUUID(),0,null]])await denied(()=>f.rpc('g1','set_my_communication_preferences',args),'22023');
  for(const args of [[randomUUID(),profile(),null,0],[randomUUID(),profile(),true,-1],[randomUUID(),{},true,0],[randomUUID(),profile({consent:true}),true,0]])await denied(()=>f.rpc('g1','register_app_guest_with_preferences',args),'22023');assert.deepEqual(await f.counts(),before);
 });
});

test('preferences keep immutable per-operation receipts and bind explicit choices to the current email',async t=>{
 const f=await setup(t);let key,first,off;
 await t.test('explicit opt-in writes version one without creating a guest, task or any email job',async()=>{
  key=randomUUID();first=await f.set('g1',0,true,key);assert.equal(first.preference_version,1);assert.equal(first.weekly_email,true);assert.equal(first.email_matches,true);assert.ok(!Number.isNaN(Date.parse(first.updated_at)));assert.deepEqual(Object.keys(first).sort(),Object.keys(absent).sort());
  const count=(await f.counts())[0];assert.equal(count.preferences,1);assert.equal(count.preference_receipts,1);assert.equal(count.profiles,0);assert.equal(count.welcomes,0);assert.equal(count.notices,0);assert.deepEqual(await f.get('g2'),absent);
 });
 await t.test('unsubscribe wins current state; retrying the old opt-in returns its historic receipt without resubscribing',async()=>{
  off=await f.set('g1',1,false);assert.equal(off.preference_version,2);assert.equal(off.weekly_email,false);const before=await f.counts();assert.deepEqual(await f.set('g1',0,true,key),first);assert.deepEqual(await f.get('g1'),off);assert.deepEqual(await f.counts(),before);
  await denied(()=>f.set('g1',0,false,key),'40001','COMMUNICATION_REQUEST_CONFLICT');await denied(()=>f.set('g1',1,true),'40001','COMMUNICATION_VERSION_CONFLICT');assert.deepEqual(await f.get('g1'),off);
 });
 await t.test('email change disables the old opt-in; replay does not bind it to the new address',async()=>{
  const choiceKey=randomUUID(),old=await f.set('g2',0,true,choiceKey);await f.db.query('update auth.users set email=$1 where id=$2',['new-address@example.invalid',ids.g2]);const changed=await f.get('g2');assert.equal(changed.weekly_email,false);assert.equal(changed.email_matches,false);assert.equal(changed.preference_version,1);
  assert.deepEqual(await f.set('g2',0,true,choiceKey),old);assert.deepEqual(await f.get('g2'),changed);const explicit=await f.set('g2',1,true);assert.equal(explicit.email_matches,true);assert.equal(explicit.preference_version,2);
  await f.db.query('update auth.users set email=$1 where id=$2',['NEW-ADDRESS@EXAMPLE.INVALID',ids.g2]);assert.equal((await f.get('g2')).weekly_email,true);
 });
 await t.test('receipt history retains original email choices and rejects update/delete/truncate',async()=>{
  const history=await f.rows('select email_key,weekly_email,expected_version,receipt from private.app_communication_receipts where auth_user_id=$1 order by created_at',[ids.g2]);assert.equal(history.length,2);assert.equal(history[0].email_key,'g2@example.invalid');assert.equal(history[1].email_key,'new-address@example.invalid');assert.equal(history[0].expected_version,0);assert.equal(history[1].expected_version,1);
  for(const q of ["update private.app_communication_receipts set weekly_email=false","delete from private.app_communication_receipts","truncate private.app_communication_receipts"])await denied(()=>f.db.exec(q),'55000','COMMUNICATION_HISTORY_IMMUTABLE');
 });
 await t.test('opt-in quota is bounded but withdrawal and exact retries remain available',async()=>{
  const firstKey=randomUUID(),saved=await f.set('g3',0,true,firstKey);for(let i=1;i<20;i++)await f.set('g3',i,true);await denied(()=>f.set('g3',20,true),'P0001','COMMUNICATION_RATE_LIMIT');const unsubscribed=await f.set('g3',20,false);assert.equal(unsubscribed.preference_version,21);assert.equal(unsubscribed.weekly_email,false);assert.deepEqual(await f.set('g3',0,true,firstKey),saved);assert.deepEqual(await f.get('g3'),unsubscribed);
 });
});

test('atomic registration preserves existing profile semantics and cannot partially commit a preference conflict',async t=>{
 const f=await setup(t,{rotation:true});let key,registered;
 await t.test('first registration commits guest, one rotation slot, mail jobs and explicit preference together',async()=>{
  key=randomUUID();registered=await f.register('g1',0,true,key,profile({first_name:'  Fictional  ',birth_date:'1990-01-01',family_members:[{first_name:'Child',relationship:'child'}]}));assert.deepEqual(Object.keys(registered).sort(),['communication_preferences','id','submitted_at','version','welcome_email_status']);assert.equal(registered.communication_preferences.weekly_email,true);
  const c=(await f.counts())[0];assert.equal(c.profiles,1);assert.equal(c.tasks,1);assert.equal(c.welcomes,1);assert.equal(c.preferences,1);assert.equal(c.preference_receipts,1);assert.equal((await f.rows('select next_slot from private.app_deacon_rotation'))[0].next_slot,2);
 });
 await t.test('canonical replay after later unsubscribe is historical and cannot duplicate or resubscribe',async()=>{
  const off=await f.set('g1',1,false);const before=await f.counts();assert.deepEqual(await f.register('g1',0,true,key,profile({birth_date:'1990-01-01',family_members:[{first_name:'Child',relationship:'child',last_name:'',birth_date:null}]})),registered);assert.deepEqual(await f.get('g1'),off);assert.deepEqual(await f.counts(),before);assert.equal((await f.rows('select next_slot from private.app_deacon_rotation'))[0].next_slot,2);
  await denied(()=>f.register('g1',0,false,key,profile({birth_date:'1990-01-01',family_members:[{first_name:'Child',relationship:'child'}]})),'40001','COMMUNICATION_REQUEST_CONFLICT');
 });
 await t.test('a stale preference version rolls back changed profile, new task, rotation and all outboxes',async()=>{
  const before=await f.counts(),saved=(await f.rows('select * from public.app_connections where id=$1',[registered.id]))[0];await denied(()=>f.register('g1',0,true,randomUUID(),profile({first_name:'Should roll back'})),'40001','COMMUNICATION_VERSION_CONFLICT');assert.deepEqual((await f.rows('select * from public.app_connections where id=$1',[registered.id]))[0],saved);
  await f.set('g2',0,false);const afterChoice=await f.counts();await denied(()=>f.register('g2',0,true),'40001','COMMUNICATION_VERSION_CONFLICT');assert.deepEqual(await f.counts(),afterChoice);assert.equal((await f.rows('select next_slot from private.app_deacon_rotation'))[0].next_slot,2);assert.equal((await f.counts())[0].profiles,before[0].profiles);
 });
 await t.test('old registration RPC still works and omitted optional profile fields retain household data',async()=>{
  const result=await f.guest('g1',randomUUID(),profile({first_name:'Later'}));assert.equal(result.id,registered.id);const own=await f.rpc('g1','get_my_app_connection');assert.equal(own.birth_date,'1990-01-01');assert.equal(own.family_members.length,1);assert.equal((await f.get('g1')).weekly_email,false);
  const old=await f.guest('g3');assert.ok(old.id);assert.deepEqual(await f.get('g3'),absent);const withChoice=await f.register('g3',0,false,randomUUID(),profile({first_name:'Updated'}));assert.equal(withChoice.id,old.id);assert.equal(withChoice.communication_preferences.weekly_email,false);
 });
 await t.test('request UUID scope includes account and mode without cross-account consent changes',async()=>{
  const shared=randomUUID();const pref=await f.set('g4',0,true,shared);const reg=await f.register('g4',1,false,shared);assert.equal(pref.preference_version,1);assert.equal(reg.communication_preferences.preference_version,2);await f.set('g5',0,true,shared);assert.equal((await f.get('g4')).weekly_email,false);assert.equal((await f.get('g5')).weekly_email,true);
 });
});

test('Office audience is complete, private, and holds duplicate/changed/unavailable recipients',async t=>{
 const f=await setup(t);const registrations={};
 for(let i=1;i<=11;i++)registrations['g'+i]=await f.guest('g'+i,randomUUID(),profile({first_name:'Fictional '+i,family_members:[{first_name:'Private child',relationship:'child'}]}));
 for(const name of ['g3','g4','g5','g6','g7','g8','g9','g10','g11'])await f.set(name,0,true);await f.set('g2',0,false);
 await f.db.query('update auth.users set email=$1 where id=$2',['changed@example.invalid',ids.g4]);await f.db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1",[ids.g5]);
 await f.db.query("update public.app_connections set email=case when auth_user_id=$1 then 'Shared@example.invalid' else 'SHARED@example.invalid' end where auth_user_id in($1,$2)",[ids.g6,ids.g7]);
 await f.db.query("update auth.users set email='invalid-address' where id=$1",[ids.g8]);await f.db.query("update public.app_connections set email='bad address' where auth_user_id=$1",[ids.g9]);await f.db.query("update auth.users set email='g10@example.invalid' where id=$1",[ids.g11]);
 await t.test('statuses distinguish explicit yes/no/absent, email change, unavailable accounts and both duplicate paths',async()=>{
  const a=await f.audience();assert.equal(a.version,1);assert.equal(a.total,11);assert.equal(a.rows.length,11);assert.ok(!Number.isNaN(Date.parse(a.generated_at)));const status=Object.fromEntries(Object.entries(registrations).map(([name,r])=>[name,a.rows.find(x=>x.id===r.id).preference_status]));
  assert.deepEqual(status,{g1:'not_set',g2:'not_requested',g3:'requested',g4:'email_changed',g5:'account_unavailable',g6:'duplicate_email',g7:'duplicate_email',g8:'account_unavailable',g9:'account_unavailable',g10:'duplicate_email',g11:'duplicate_email'});
 });
 await t.test('only the registration-safe projection is returned, including original profile email for held rows',async()=>{
  const a=await f.audience('editor');for(const row of a.rows)assert.deepEqual(Object.keys(row).sort(),['email','first_name','id','last_name','preference_status','preference_version','updated_at']);
  const changed=a.rows.find(r=>r.id===registrations.g4.id);assert.equal(changed.email,'g4@example.invalid');assert.equal(JSON.stringify(a).includes('Private child'),false);for(const id of Object.values(ids))assert.equal(JSON.stringify(a).includes(id),false);
  for(const actor of ['g1','viewer','anon','unconfirmed_staff'])await denied(()=>f.audience(actor));
 });
 await t.test('a new explicit email-bound opt-in alone does not approve a stale profile email',async()=>{
  await f.set('g4',1,true);assert.equal((await f.audience()).rows.find(r=>r.id===registrations.g4.id).preference_status,'email_changed');await f.guest('g4');assert.equal((await f.audience()).rows.find(r=>r.id===registrations.g4.id).preference_status,'requested');
 });
 await t.test('eligible collision with an unavailable account is still withheld from the audience',async()=>{
  await f.db.query("update public.app_connections set email='g3@example.invalid' where auth_user_id=$1",[ids.g5]);const rows=(await f.audience()).rows;assert.equal(rows.find(r=>r.id===registrations.g3.id).preference_status,'duplicate_email');assert.equal(rows.find(r=>r.id===registrations.g5.id).preference_status,'account_unavailable');
 });
});

test('Office audience enforces the full 5000-profile boundary without returning a partial list',async t=>{
 const f=await setup(t);
 await f.db.exec(`insert into auth.users(id,email,email_confirmed_at,is_anonymous)select ('10000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'fixture'||i||'@example.invalid',null,false from generate_series(1,5001)i;
 insert into public.app_connections(auth_user_id,first_name,last_name,email,preferred_contact,contact_permission)select id,'Fictional','Boundary',email,'email',true from auth.users where id::text like '10000000-%' and id::text<>'10000000-0000-4000-8000-000000005001';`);
 const result=await f.audience();assert.equal(result.total,5000);assert.equal(result.rows.length,5000);assert.equal(new Set(result.rows.map(r=>r.id)).size,5000);assert(result.rows.every(r=>r.preference_status==='not_set'));
 await f.db.exec("insert into public.app_connections(auth_user_id,first_name,email,preferred_contact,contact_permission)select id,'Last',email,'email',true from auth.users where id='10000000-0000-4000-8000-000000005001';");
 await denied(()=>f.audience(),'54000','COMMUNICATION_AUDIENCE_LIMIT_EXCEEDED');
});
