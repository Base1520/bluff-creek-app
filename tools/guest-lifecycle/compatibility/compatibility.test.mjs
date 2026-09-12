import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../../admin/tests/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite');
const {pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
const hash=x=>createHash('sha256').update(x).digest('hex');
const baselineBytes=await readFile(new URL('../../office-preflight/history/manifest-ten-2026-09-10.json',import.meta.url));
assert.equal(hash(baselineBytes),'0734cdc37022af4c946b2e4a8d93ad1b199093834f28373b1bf8c0c9497276ae');
const manifest=JSON.parse(await readFile(new URL('./manifest.json',import.meta.url),'utf8'));
const source=await readFile(new URL('../../../'+manifest.migration.path,import.meta.url),'utf8');
assert.equal(hash(source),manifest.migration.sha256);
const ids=Object.fromEntries(['admin','editor','viewer','guest','other','prayer'].map((x,i)=>[x,`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
const profile={first_name:'Fictional',last_name:'Guest',phone:null,preferred_contact:'email',contact_permission:true,sunday_school:null,visit_status:'not_yet',first_visit_on:null};
const denied=(fn,code='42501',message)=>assert.rejects(fn,e=>e.code===code&&(!message||e.message===message));
async function setup(t,{missing=null}={}){
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
 create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean,deleted_at timestamptz,banned_until timestamptz);
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to anon,authenticated,service_role;
 create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));alter table storage.objects enable row level security;
 grant usage on schema public,storage to anon,authenticated,service_role;grant select,insert,update,delete on storage.objects to anon,authenticated;`);
 const baseline=JSON.parse(baselineBytes);assert.equal(baseline.sql_files.length,10);
 for(const row of baseline.sql_files){const bytes=await readFile(new URL('../../../'+row.path,import.meta.url));assert.equal(hash(bytes),row.sha256);if(row.path==='supabase/migrations/20260910152030_direct_intake_dispatch_extensions.sql')continue;await db.exec(bytes.toString());}
 for(const row of manifest.requires){const bytes=await readFile(new URL('../../../'+row.path,import.meta.url));assert.equal(hash(bytes),row.sha256);if(row.path.includes('/'+missing+'/'))continue;await db.exec(bytes.toString());}
 for(const[name,id]of Object.entries(ids)){
  await db.query('insert into auth.users(id,email,email_confirmed_at,is_anonymous)values($1,$2,$3,false)',[id,`${name}@example.invalid`,['admin','editor','viewer'].includes(name)?'2026-09-01T00:00:00Z':null]);
  if(['admin','editor','viewer'].includes(name))await db.query('insert into public.staff_roles(user_id,role)values($1,$2)',[id,name]);
 }
 const rows=async(q,args=[])=>(await db.query(q,args)).rows;
 async function as(name,q,args=[]){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[name]||'']);await db.exec('set role '+(['anon','service_role'].includes(name)?name:'authenticated'));try{return await rows(q,args);}finally{await db.exec('reset role');}}
 const rpc=(name,fn,args=[])=>as(name,'select public.'+fn+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') result',args).then(r=>r[0].result);
 const apply=async(sql=source)=>{try{await db.exec(sql);}catch(error){await db.exec('rollback');throw error;}};
 const reg=(name='guest')=>rpc(name,'register_app_guest',[randomUUID(),profile]);
 const change=async(id,removed=true)=>{const[r]=await rows('select * from public.app_connections where id=$1',[id]);return rpc('admin','set_guest_registration_removed',[randomUUID(),id,r.version,r.staff_version,r.guest_lifecycle_version,removed]);};
 const attention=()=>rpc('admin','get_office_attention');
 const audience=()=>rpc('editor','get_office_communication_audience');
 const functionState=()=>rows("select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args,pg_get_functiondef(p.oid) definition,p.proowner,p.prosecdef,p.provolatile,p.proconfig,p.proacl::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private') order by 1,2,3");
 const records=async()=>{const result={};for(const table of ['public.app_connections','public.app_submission_tasks','private.app_welcome_outbox','private.app_welcome_links','private.app_staff_notice_outbox','private.app_communication_preferences','private.app_communication_receipts','private.app_intake_receipts','public.staff_roles'])result[table]=await rows('select to_jsonb(r) r from '+table+' r order by to_jsonb(r)::text');return result;};
 return{db,rows,rpc,as,apply,reg,change,attention,audience,functionState,records};
}

for(const missing of ['guest-lifecycle','office-attention','communication-preferences'])test('compatibility refuses absent '+missing+' prerequisite without creating partial functions',async t=>{
 const f=await setup(t,{missing}),before=await f.functionState();await denied(()=>f.apply(),'55000','GUEST_PROJECTION_PREREQUISITES_REQUIRED');assert.deepEqual(await f.functionState(),before);
});

test('source drift is refused; only the two private projection definitions change and reapplication is idempotent',async t=>{
 const f=await setup(t),original=await f.functionState(),policies=await f.rows('select * from pg_policies order by schemaname,tablename,policyname');await f.reg();
 const records=await f.records();await f.apply();const changed=[];
 for(const old of original){const now=(await f.functionState()).find(x=>x.nspname===old.nspname&&x.proname===old.proname&&x.args===old.args);assert.ok(now);const {definition:a,...before}=old,{definition:b,...after}=now;assert.deepEqual(after,before);if(a!==b)changed.push(old.nspname+'.'+old.proname);}
 assert.deepEqual(changed.sort(),['private.get_office_attention','private.get_office_communication_audience']);assert.deepEqual(await f.records(),records);assert.deepEqual(await f.rows('select * from pg_policies order by schemaname,tablename,policyname'),policies);
 const applied=await f.functionState();await f.apply();assert.deepEqual(await f.functionState(),applied);assert.deepEqual(await f.records(),records);
 await f.db.exec("create or replace function private.get_office_attention() returns jsonb language plpgsql stable security definer set search_path='' as $$begin return '{}'::jsonb;end $$");
 const drift=await f.functionState();await denied(()=>f.apply(),'55000','GUEST_PROJECTION_SOURCE_CHANGED');assert.deepEqual(await f.functionState(),drift);
});

test('removed registration, task and welcome issues disappear; restoration reappears without preference or outbox changes',async t=>{
 const f=await setup(t),r=await f.reg(),other=await f.reg('other');await f.rpc('guest','set_my_communication_preferences',[randomUUID(),0,true]);
 const [{id:taskId}]=await f.rows('select id from public.app_submission_tasks where registration_id=$1',[r.id]);
 await f.change(r.id);const before=await f.attention();assert.ok(before.items.some(x=>x.source_id===r.id));assert.ok(before.items.some(x=>x.source_id===taskId));assert.equal((await f.audience()).total,2);
 const records=await f.records();await f.apply();const attention=await f.attention();assert.ok(!attention.items.some(x=>[r.id,taskId].includes(x.source_id)));const audience=await f.audience();assert.equal(audience.total,1);assert.deepEqual(audience.rows.map(x=>x.id),[other.id]);assert.deepEqual(await f.records(),records);
 await f.change(r.id,false);const restoredRecords=await f.records(),restored=await f.attention();assert.ok(restored.items.some(x=>x.source_id===taskId));assert.ok(restored.items.some(x=>x.source_id===r.id));assert.equal((await f.audience()).total,2);assert.equal((await f.audience()).rows.find(x=>x.id===r.id).preference_status,'requested');assert.deepEqual(await f.records(),restoredRecords);
 for(const table of ['private.app_welcome_outbox','private.app_staff_notice_outbox','private.app_communication_preferences','private.app_communication_receipts'])assert.deepEqual(restoredRecords[table],records[table],table);
});

test('removed duplicate addresses are excluded before audience classification and rejoin on restore',async t=>{
 const f=await setup(t);await f.db.query('update auth.users set email=$1 where id=$2',['guest@example.invalid',ids.other]);const r=await f.reg(),other=await f.reg('other');
 await f.rpc('other','set_my_communication_preferences',[randomUUID(),0,true]);assert.ok((await f.audience()).rows.every(x=>x.preference_status==='duplicate_email'));
 await f.change(r.id);await f.apply();const audience=await f.audience();assert.equal(audience.total,1);assert.deepEqual(audience.rows.map(x=>[x.id,x.preference_status]),[[other.id,'requested']]);
 await f.change(r.id,false);assert.ok((await f.audience()).rows.every(x=>x.preference_status==='duplicate_email'));
});

test('legacy archived rows and their still-open task are excluded without lifecycle marker backfill',async t=>{
 const f=await setup(t),r=await f.reg();await f.db.query("update public.app_connections set status='archived' where id=$1",[r.id]);await f.db.query("update private.app_welcome_outbox set status='attention'");const records=await f.records();
 assert.ok((await f.attention()).total>0);await f.apply();assert.equal((await f.attention()).total,0);assert.equal((await f.audience()).total,0);assert.deepEqual(await f.records(),records);
});

test('active and truly completed guest/prayer attention and audience classifications retain original behavior',async t=>{
 const f=await setup(t),r=await f.reg();await f.reg('other');const prayer=await f.rpc('prayer','submit_app_prayer',[randomUUID(),{request_text:'Fictional private prayer'}]);
 const [task]=await f.rows('select * from public.app_submission_tasks where registration_id=$1',[r.id]);await f.rpc('editor','update_intake_task',[task.id,task.version,{status:'completed'}]);
 await f.db.query("update private.app_staff_notice_outbox set status='attention'");await f.db.query("update private.app_welcome_outbox set created_at=now()-interval '1 hour'");
 const before=await f.attention(),audience=await f.audience(),records=await f.records();assert.ok(before.items.some(x=>x.source_id===task.id&&x.reasons.includes('notice_attention')));assert.ok(prayer.id);
 await f.apply();const after=await f.attention(),afterAudience=await f.audience();const {generated_at:a,...oldAttention}=before,{generated_at:b,...newAttention}=after,{generated_at:c,...oldAudience}=audience,{generated_at:d,...newAudience}=afterAudience;assert.deepEqual(newAttention,oldAttention);assert.deepEqual(newAudience,oldAudience);assert.deepEqual(await f.records(),records);
 for(const role of ['guest','viewer','anon','service_role']){await denied(()=>f.rpc(role,'get_office_attention'));await denied(()=>f.rpc(role,'get_office_communication_audience'));}
});
