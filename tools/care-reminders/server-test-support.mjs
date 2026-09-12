// Synthetic, local-only PostgreSQL fixture. Never calls Auth HTTP or a provider.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../admin/tests/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite');
const {pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
export const ids=Object.fromEntries(['admin','editor','viewer','guest','other','prayer','unconfirmed','banned','deleted','anonymous'].map((name,i)=>[name,`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
export const profile={first_name:'Fictional',last_name:'Guest',phone:null,preferred_contact:'email',contact_permission:true,sunday_school:null,visit_status:'not_yet',first_visit_on:null};
export const bootstrapSql=`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean,deleted_at timestamptz,banned_until timestamptz);
create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to anon,authenticated,service_role;
create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));alter table storage.objects enable row level security;
grant usage on schema public,storage to anon,authenticated,service_role;grant select,insert,update,delete on storage.objects to anon,authenticated;`;
const bytes=await readFile(new URL('../office-preflight/manifest.json',import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'),'ce29bd07a46ceab3698ee11f572e64d5f76b7c5a5f790f0a7e4eaf333a130ea7');
const manifest=JSON.parse(bytes);assert.equal(manifest.format_version,6);assert.equal(manifest.sql_files.length,12);
export const baselineSql=[];
for(const row of manifest.sql_files){
 const source=await readFile(new URL('../../'+row.path,import.meta.url));
 assert.equal(createHash('sha256').update(source).digest('hex'),row.sha256,row.path);
 baselineSql.push({...row,sql:source.toString(),execute:row.path!=='supabase/migrations/20260910152030_direct_intake_dispatch_extensions.sql'});
}
export const denied=(fn,code='42501',message)=>assert.rejects(fn,e=>e.code===code&&(!message||e.message===message));
export async function setup(t,{queue=false,controls=false}={}){
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 await db.exec(bootstrapSql);
 for(const row of baselineSql)if(row.execute)await db.exec(row.sql);
 const rows=async(q,args=[])=>(await db.query(q,args)).rows;
 for(const [name,id] of Object.entries(ids)){
  await db.query('insert into auth.users(id,email,email_confirmed_at,is_anonymous)values($1,$2,$3,$4)',[id,`${name}@example.invalid`,['guest','other','prayer','unconfirmed'].includes(name)?null:'2026-09-01T00:00:00Z',name==='anonymous']);
  if(!['guest','other','prayer'].includes(name))await db.query('insert into public.staff_roles(user_id,role)values($1,$2)',[id,['editor','viewer'].includes(name)?name:'admin']);
 }
 await db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1",[ids.banned]);
 await db.query('update auth.users set deleted_at=now() where id=$1',[ids.deleted]);
 async function as(name,q,args=[]){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[name]||'']);await db.exec('set role '+(['anon','service_role'].includes(name)?name:'authenticated'));try{return await rows(q,args);}finally{await db.exec('reset role');}}
 const rpc=(name,fn,args=[])=>as(name,'select public.'+fn+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') result',args).then(r=>r[0].result);
 const reg=(name='guest',key=randomUUID(),payload=profile)=>rpc(name,'register_app_guest',[key,payload]);
 const get=id=>rows('select * from public.app_connections where id=$1',[id]).then(r=>r[0]);
 const taskFor=id=>rows('select * from public.app_submission_tasks where registration_id=$1',[id]).then(r=>r[0]);
 const change=async(id,removed=true,key=randomUUID(),actor='admin')=>{const r=await get(id);return rpc(actor,'set_guest_registration_removed',[key,id,r.version,r.staff_version,r.guest_lifecycle_version,removed]);};
 const insert=async(table,values)=>{
  const keys=Object.keys(values);assert.match(table,/^[a-z_]+$/);for(const key of keys)assert.match(key,/^[a-z_]+$/);
  return (await as('admin',`insert into public.${table}(${keys.join(',')})values(${keys.map((_,i)=>'$'+(i+1)).join(',')})returning *`,keys.map(k=>values[k])))[0];
 };
 const makeCare=async({person={},plan={},visits=[]}={})=>{
  const contact=await insert('contacts',{first_name:'Fictional',last_name:'Care',status:'active',...person});
  const assignment=await insert('care_assignments',{contact_id:contact.id,assigned_to:'Display name only',care_role:'deacon',cadence_days:28,cadence_months:null,started_on:'2026-09-01',first_due_on:null,one_time:false,paused:false,...plan});
  const history=[];for(const visit of visits)history.push(await insert('care_visits',{contact_id:contact.id,care_role:assignment.care_role,visitor_name:'Fictional staff',method:'call',outcome:'contacted',contacted_on:'2026-09-02',...visit}));
  return {person:contact,plan:assignment,visits:history};
 };
 const addVisit=async(care,values={})=>insert('care_visits',{contact_id:care.person.id,care_role:care.plan.care_role,visitor_name:'Fictional staff',method:'call',outcome:'contacted',contacted_on:'2026-09-02',...values});
 const bindingFor=(type,id)=>rows('select * from private.care_reminder_bindings where source_type=$1 and source_id=$2',[type,id]).then(r=>r[0]);
 const bind=async(type,id,options={})=>{
  const source=(await rows('select * from public.'+(type==='guest_task'?'app_submission_tasks':'care_assignments')+' where id=$1',[id]))[0];
  const old=await bindingFor(type,id),guest=type==='guest_task'?await get(source.registration_id):null;
  const arg={request_id:randomUUID(),version:old?.version||0,source_version:source.version,owner_user_id:type==='guest_task'?source.assigned_staff_user_id:ids.editor,enabled:true,restart_cycle:false,lifecycle_version:guest?.guest_lifecycle_version||null,linked_guest_task_id:null,...options};
  return rpc(options.actor||'admin','set_care_reminder_binding',[arg.request_id,type,id,arg.version,arg.source_version,arg.owner_user_id,arg.enabled,arg.restart_cycle,arg.lifecycle_version,arg.linked_guest_task_id]);
 };
 const configure=async(options={})=>{const current=(await rows('select * from private.care_reminder_settings where id'))[0];const arg={request_id:randomUUID(),version:current.version,enabled:true,pastor_user_ids:[ids.admin],...options};return rpc(options.actor||'admin','set_care_reminder_settings',[arg.request_id,arg.version,arg.enabled,arg.pastor_user_ids]);};
 const sourceRows=(today='2026-09-12')=>rows('select source_type,source_id,cycle_id,due_on::text,state,owner_user_id,source_fingerprint from private.care_reminder_source_rows($1::date)',[today]);
 const functionState=()=>rows("select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args,pg_get_functiondef(p.oid) definition,p.proowner,p.prosecdef,p.provolatile,p.proconfig,p.proacl::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private') order by 1,2,3");
 const oldFunctions=await functionState(),oldPolicies=await rows('select * from pg_policies order by schemaname,tablename,policyname');
 await db.exec(await readFile(new URL('./migrations/20260912183930_care_reminder_bindings.sql',import.meta.url),'utf8'));
 if(queue||controls)await db.exec(await readFile(new URL('./migrations/20260912183934_care_reminder_queue.sql',import.meta.url),'utf8'));
 if(controls)await db.exec(await readFile(new URL('./migrations/20260912224640_care_reminder_controls.sql',import.meta.url),'utf8'));
 return {db,rows,as,rpc,ids,reg,get,taskFor,getTask:taskFor,change,makeCare,addVisit,insert,bind,bindingFor,configure,sourceRows,functionState,oldFunctions,oldPolicies};
}
