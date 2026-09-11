import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../admin/tests/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite');const {pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
const digest=x=>createHash('sha256').update(x).digest('hex');
const sql=await readFile(new URL('./migrations/20260911210428_guest_sheet_snapshot.sql',import.meta.url),'utf8');
const frozen=await readFile(new URL('../office-preflight/history/manifest-eight-2026-09-09.json',import.meta.url));
assert.equal(digest(frozen),'572c8a631c293c1c2d322670b8f295de95e3baeb2fa59a82f2ae641e28812c68');
const ids=Object.fromEntries(['admin','editor','viewer','guest','guest2'].map((n,i)=>[n,`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
const deny=(fn,code='42501',message)=>assert.rejects(fn,e=>e.code===code&&(!message||e.message===message));
async function setup(t,{deacon=false}={}){
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
 create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean,deleted_at timestamptz,banned_until timestamptz);
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to anon,authenticated,service_role;
 create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));alter table storage.objects enable row level security;
 grant usage on schema public,storage to anon,authenticated,service_role;grant select,insert,update,delete on storage.objects to anon,authenticated;`);
 for(const row of JSON.parse(frozen).sql_files){const bytes=await readFile(new URL('../../'+row.path,import.meta.url));assert.equal(digest(bytes),row.sha256);await db.exec(bytes.toString());}
 const intake=await readFile(new URL('../../supabase/migrations/20260910152017_direct_app_intake.sql',import.meta.url));assert.equal(digest(intake),'2d4a268bb6bb2c0d87ae7f4d2b238ee79180e862ea5ba026a9f625498955b405');await db.exec(intake.toString());
 const infra=await readFile(new URL('../../supabase/migrations/20260910152030_direct_intake_dispatch_extensions.sql',import.meta.url));assert.equal(digest(infra),'bfbd4b7e1410a2e80508866e0fbd2029130dce435e5cb7f9ca0c1d9ad0bce6d0');
 // pg_cron/pg_net infrastructure is byte-verified; unsupported in PGlite.
 if(deacon){const bytes=await readFile(new URL('../deacon-rotation/migrations/20260910213024_deacon_guest_rotation.sql',import.meta.url));assert.equal(digest(bytes),'679530d6e25194c61a3b5e0fa165ce7c47d91db58e67f99d5f2f5453eca94f1a');await db.exec(bytes.toString());}
 for(const[n,id]of Object.entries(ids)){await db.query('insert into auth.users(id,email,email_confirmed_at,is_anonymous)values($1,$2,now(),false)',[id,n+'@example.invalid']);if(['admin','editor','viewer'].includes(n))await db.query('insert into public.staff_roles(user_id,role)values($1,$2)',[id,n]);}
 const rows=async(q,args=[])=>(await db.query(q,args)).rows;
 const old=await rows("select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)args,pg_get_functiondef(p.oid)body,p.proacl::text,p.proconfig,p.proowner from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private') order by 1,2,3");
 const policies=await rows('select * from pg_policies order by schemaname,tablename,policyname');
 await db.exec(sql);
 async function as(actor,q,args=[]){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[actor]||'']);await db.exec('set role '+(['anon','service_role'].includes(actor)?actor:'authenticated'));try{return await rows(q,args);}finally{await db.exec('reset role');}}
 const rpc=(actor,name,args=[])=>as(actor,'select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') result',args).then(r=>r[0].result);
 const guest=(actor='guest')=>rpc(actor,'register_app_guest',[randomUUID(),{first_name:'Fictional',last_name:'Guest',phone:null,preferred_contact:'email',contact_permission:true,sunday_school:null,visit_status:'not_yet',first_visit_on:null,birth_date:'2000-01-01',address_line1:'PRIVATE_ADDRESS_CANARY',family_members:[{first_name:'PRIVATE_CHILD_CANARY',relationship:'child'}]}]);
 const snapshot=()=>rpc('service_role','get_guest_sheet_snapshot');
 return{db,rows,as,rpc,guest,snapshot,old,policies};
}

test('snapshot and private settings preserve baseline and privilege boundaries',async t=>{
 const f=await setup(t);
 await t.test('empty complete snapshot is service-only; staff and guests cannot export through it',async()=>{const empty=await f.snapshot();assert.equal(empty.total,0);assert.deepEqual(empty.rows,[]);assert.equal(empty.headers.length,18);for(const actor of ['admin','editor','viewer','guest','anon'])await deny(()=>f.rpc(actor,'get_guest_sheet_snapshot'));await deny(()=>f.db.query('select private.get_guest_sheet_snapshot()'),'42501','SERVICE_REQUIRED');});
 await t.test('original functions/policies/roles remain unchanged and table is private RLS',async()=>{for(const row of f.old){const now=(await f.rows("select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)args,pg_get_functiondef(p.oid)body,p.proacl::text,p.proconfig,p.proowner from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.proname=$2 and pg_get_function_identity_arguments(p.oid)=$3",[row.nspname,row.proname,row.args]))[0];assert.deepEqual(now,row);}assert.deepEqual(await f.rows('select * from pg_policies order by schemaname,tablename,policyname'),f.policies);assert.equal((await f.rows("select relrowsecurity from pg_class where oid='private.app_guest_sheet_settings'::regclass"))[0].relrowsecurity,true);for(const a of ['anon','guest','admin','editor','service_role'])await deny(()=>f.as(a,'select * from private.app_guest_sheet_settings'));});
 await t.test('only eligible staff read URL; only admin updates optimistic settings',async()=>{assert.deepEqual(await f.rpc('editor','get_guest_sheet_settings'),{version:1,settings_version:1,sheet_url:null});for(const a of ['anon','guest','viewer','service_role'])await deny(()=>f.rpc(a,'get_guest_sheet_settings'));for(const a of ['editor','viewer','guest','service_role'])await deny(()=>f.rpc(a,'set_guest_sheet_settings',[1,null]));const url='https://docs.google.com/spreadsheets/d/'+'a'.repeat(40)+'/edit';assert.equal((await f.rpc('admin','set_guest_sheet_settings',[1,url])).settings_version,2);await deny(()=>f.rpc('admin','set_guest_sheet_settings',[1,null]),'40001','GUEST_SHEET_VERSION_CONFLICT');assert.equal((await f.rpc('admin','get_guest_sheet_settings')).sheet_url,url);});
 await t.test('unsafe URL variants fail without altering settings',async()=>{for(const url of ['http://docs.google.com/spreadsheets/d/'+ 'a'.repeat(40)+'/edit','https://docs.google.com.evil.invalid/spreadsheets/d/'+ 'a'.repeat(40)+'/edit','https://docs.google.com/spreadsheets/d/'+ 'a'.repeat(40)+'/edit?share=true','javascript:alert(1)',''])await deny(()=>f.rpc('admin','set_guest_sheet_settings',[2,url]),'22023');assert.equal((await f.rpc('admin','get_guest_sheet_settings')).settings_version,2);});
 await t.test('one guest projection excludes household, notes, Auth ID, and all prayer data',async()=>{await f.guest();await f.rpc('guest','submit_app_prayer',[randomUUID(),{display_name:'PRIVATE_PRAYER_NAME',request_text:'PRIVATE_PRAYER_BODY',contact_text:'PRIVATE_PRAYER_CONTACT'}]);const out=await f.snapshot();assert.equal(out.total,1);assert.equal(out.rows[0].length,18);assert.equal(out.rows[0][13],'Office queue');assert.equal(out.rows[0][12],'new');assert.equal(out.rows[0][14],'Queued');assert.doesNotMatch(JSON.stringify(out),/PRIVATE_|00000000-0000-4000-8000-000000000004/);});
 await t.test('task assignment/due/completion overrides legacy followup fields; sent means provider accepted',async()=>{const task=(await f.rows("select id from public.app_submission_tasks where kind='guest_followup'"))[0].id;await f.rpc('editor','update_intake_task',[task,1,{due_on:'2026-12-01',status:'completed',assigned_staff_user_id:ids.admin}]);await f.db.exec("update public.app_connections set welcome_email_status='sent'");const r=(await f.snapshot()).rows[0];assert.equal(r[11],'2026-12-01');assert.equal(r[12],'completed');assert.equal(r[13],'admin@example.invalid');assert.equal(r[14],'Provider accepted');await f.db.query('update auth.users set banned_until=now()+interval \'1 day\' where id=$1',[ids.admin]);assert.equal((await f.snapshot()).rows[0][13],'Assigned staff — unavailable');});
 await t.test('archived and removed rows disappear; fresh full snapshot can become empty',async()=>{await f.db.exec("update public.app_connections set status='archived'");assert.equal((await f.snapshot()).total,0);await f.db.exec("alter table public.app_connections add column guest_removed_at timestamptz;alter table public.app_submission_tasks add column guest_removed_at timestamptz;update public.app_connections set status='pending',guest_removed_at=now()");assert.equal((await f.snapshot()).total,0);await f.db.exec('update public.app_connections set guest_removed_at=null');assert.equal((await f.snapshot()).total,1);});
});

test('optional deacon slots and complete snapshot bounds',async t=>{
 const f=await setup(t,{deacon:true});
 await t.test('deacon extension projects current slot label without requiring a new mirror migration',async()=>{await f.rpc('admin','set_deacon_slot',[1,1,'Fictional Deacon',ids.editor]);await f.guest();assert.equal((await f.snapshot()).rows[0][13],'Deacon 1 — Fictional Deacon');await f.rpc('admin','set_deacon_slot',[1,2,'Renamed Deacon',ids.editor]);assert.equal((await f.snapshot()).rows[0][13],'Deacon 1 — Renamed Deacon');});
 await t.test('5000 is complete; 5001 fails explicitly instead of truncating',async()=>{await f.db.exec("insert into auth.users(id,email,is_anonymous)select gen_random_uuid(),'batch-'||n||'@example.invalid',false from generate_series(1,5000)n;insert into public.app_connections(auth_user_id,first_name,email,preferred_contact,contact_permission)select id,'Fictional',email,'email',true from auth.users where email like 'batch-%'");await deny(()=>f.snapshot(),'54000','GUEST_SHEET_LIMIT_EXCEEDED');await f.db.exec("update public.app_connections set status='archived' where auth_user_id='00000000-0000-4000-8000-000000000004'");const out=await f.snapshot();assert.equal(out.total,5000);assert.equal(new Set(out.rows.map(r=>r[16])).size,5000);});
});
