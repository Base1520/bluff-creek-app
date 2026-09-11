import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../admin/tests/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite');
const {pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
const hash=value=>createHash('sha256').update(value).digest('hex');
const frozen=await readFile(new URL('../office-preflight/history/manifest-eight-2026-09-09.json',import.meta.url));
assert.equal(hash(frozen),'572c8a631c293c1c2d322670b8f295de95e3baeb2fa59a82f2ae641e28812c68');
const source=await readFile(new URL('./migrations/20260911195705_weekly_email_drafts.sql',import.meta.url),'utf8');
const additions=[
 ['../../supabase/migrations/20260910152017_direct_app_intake.sql','2d4a268bb6bb2c0d87ae7f4d2b238ee79180e862ea5ba026a9f625498955b405'],
 ['../communication-preferences/migrations/20260911023920_communication_preferences.sql','d45307bada93bc3f7258eeb41e372477b56f8085ba2fcb138cb520076e567362']
];
const roles=['admin','editor','viewer','guest','unconfirmed','anonymous','banned','deleted','missing'];
const ids=Object.fromEntries(roles.map((name,i)=>[name,`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
const week='2026-09-14',otherWeek='2026-09-21';
const draft=(extra={})=>({week_start:week,subject:'Church news',intro:'A fictional introduction.',closing:'A fictional closing.',announcement_refs:[],...extra});
const failure=(fn,code='42501',message)=>assert.rejects(fn,error=>error.code===code&&(!message||error.message===message));
const ref=a=>({id:a.id,version:a.version});
async function setup(t,{allExtensions=false}={}){
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create role unrelated nologin;
 create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean,deleted_at timestamptz,banned_until timestamptz);
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to anon,authenticated,service_role,unrelated;
 create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));alter table storage.objects enable row level security;
 grant usage on schema public,storage to anon,authenticated,service_role,unrelated;grant select,insert,update,delete on storage.objects to anon,authenticated;`);
 for(const row of JSON.parse(frozen).sql_files){const bytes=await readFile(new URL('../../'+row.path,import.meta.url));assert.equal(hash(bytes),row.sha256);await db.exec(bytes.toString());}
 const applyReviewed=async(path,digest)=>{const bytes=await readFile(new URL(path,import.meta.url));assert.equal(hash(bytes),digest);await db.exec(bytes.toString());};
 for(const[path,digest]of additions){
  if(allExtensions&&path.includes('communication-preferences'))await applyReviewed('../deacon-rotation/migrations/20260910213024_deacon_guest_rotation.sql','679530d6e25194c61a3b5e0fa165ce7c47d91db58e67f99d5f2f5453eca94f1a');
  await applyReviewed(path,digest);
 }
 // pg_cron/pg_net are infrastructure-only: verify exact bytes, do not emulate.
 assert.equal(hash(await readFile(new URL('../../supabase/migrations/20260910152030_direct_intake_dispatch_extensions.sql',import.meta.url))),'bfbd4b7e1410a2e80508866e0fbd2029130dce435e5cb7f9ca0c1d9ad0bce6d0');
 if(allExtensions)await applyReviewed('../office-attention/migrations/20260911132539_office_attention.sql','94d578ad7e735f3de676422be869b73d3a255d9965039cde896e799af2be8054');
 const rows=async(query,args=[])=>(await db.query(query,args)).rows;
 for(const[name,id]of Object.entries(ids).filter(([name])=>name!=='missing')){
  await db.query('insert into auth.users(id,email,email_confirmed_at,is_anonymous)values($1,$2,$3,$4)',[id,name+'@example.invalid',['admin','editor','viewer','banned','deleted'].includes(name)?'2026-09-01T00:00:00Z':null,name==='anonymous']);
  if(['admin','editor','viewer','unconfirmed','banned','deleted'].includes(name))await db.query('insert into public.staff_roles(user_id,role)values($1,$2)',[id,['admin','editor','viewer'].includes(name)?name:'admin']);
 }
 await db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1",[ids.banned]);await db.query('update auth.users set deleted_at=now() where id=$1',[ids.deleted]);
 async function as(name,query,args=[]){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[name]||'']);await db.exec('set role '+(['anon','service_role','unrelated'].includes(name)?name:'authenticated'));try{return await rows(query,args);}finally{await db.exec('reset role');}}
 const rpc=(actor,fn,args=[])=>as(actor,'select public.'+fn+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') result',args).then(r=>r[0].result);
 const functions=()=>rows("select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)args,pg_get_functiondef(p.oid)definition,p.proowner,p.proacl::text,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private') order by 1,2,3");
 const before={functions:await functions(),policies:await rows('select * from pg_policies order by schemaname,tablename,policyname'),roles:await rows('select * from public.staff_roles order by user_id'),bucket:await rows('select * from storage.buckets'),schema:await rows("select nspacl::text from pg_namespace where nspname='private'")};
 await db.exec(source);
 const save=(body=draft(),{actor='editor',id=randomUUID(),expected=0,key=randomUUID()}={})=>rpc(actor,'save_weekly_email_draft',[key,id,expected,body]);
 const get=(id,actor='editor')=>rpc(actor,'get_weekly_email_draft',[id]);
 const workspace=(start=week,actor='editor')=>rpc(actor,'get_weekly_email_workspace',[start]);
 const review=(id,version,contentHash,{actor='admin',key=randomUUID()}={})=>rpc(actor,'review_weekly_email_draft',[key,id,version,contentHash]);
 const announcement=async(extra={})=>{const a={title:'Fictional announcement',body:'Fictional body',status:'ready',starts_on:null,ends_on:null,...extra};return(await as('admin','insert into public.office_announcements(title,body,status,starts_on,ends_on)values($1,$2,$3,$4,$5)returning *',[a.title,a.body,a.status,a.starts_on,a.ends_on]))[0];};
 const updateAnnouncement=async(id,field,value)=>(await as('admin','update public.office_announcements set '+field+'=$1 where id=$2 returning *',[value,id]))[0];
 const state=()=>rows("select (select jsonb_agg(to_jsonb(d) order by id) from private.app_weekly_email_drafts d)drafts,(select jsonb_agg(to_jsonb(r) order by draft_id,version) from private.app_weekly_email_revisions r)revisions,(select jsonb_agg(to_jsonb(r) order by actor_id,request_id) from private.app_weekly_email_receipts r)receipts,(select count(*) from public.audit_log where entity_type='app_weekly_email_drafts')audit");
 const outside=()=>rows("select (select jsonb_agg(to_jsonb(a) order by id) from public.office_announcements a)announcements,(select jsonb_agg(to_jsonb(c) order by id) from public.app_connections c)profiles,(select jsonb_agg(to_jsonb(t) order by id) from public.app_submission_tasks t)tasks,(select jsonb_agg(to_jsonb(w) order by id) from private.app_welcome_outbox w)welcomes,(select jsonb_agg(to_jsonb(n) order by id) from private.app_staff_notice_outbox n)notices,(select jsonb_agg(to_jsonb(q)) from private.app_welcome_daily_quota q)quota");
 return{db,rows,as,rpc,functions,before,save,get,workspace,review,announcement,updateAnnouncement,state,outside};
}

test('weekly drafting adds private-only state and preserves existing access and source functions',async t=>{
 const f=await setup(t,{allExtensions:true});
 await t.test('all prior functions roles policies bucket and private-schema ACL remain exact',async()=>{
  const current=await f.functions();assert.equal(current.length,f.before.functions.length+13);
  for(const old of f.before.functions)assert.deepEqual(current.find(row=>row.nspname===old.nspname&&row.proname===old.proname&&row.args===old.args),old);
  assert.deepEqual(await f.rows('select * from pg_policies order by schemaname,tablename,policyname'),f.before.policies);assert.deepEqual(await f.rows('select * from public.staff_roles order by user_id'),f.before.roles);assert.deepEqual(await f.rows('select * from storage.buckets'),f.before.bucket);assert.deepEqual(await f.rows("select nspacl::text from pg_namespace where nspname='private'"),f.before.schema);
 });
 await t.test('new state has RLS and no direct API-role or helper access',async()=>{
  const tables=['app_weekly_email_write_guard','app_weekly_email_drafts','app_weekly_email_revisions','app_weekly_email_receipts'];
  assert.equal((await f.rows("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname=any($1) and c.relrowsecurity",[tables]))[0].n,4);
  for(const actor of ['anon','guest','admin','editor','viewer','service_role','unrelated'])for(const table of tables){await failure(()=>f.as(actor,'select * from private.'+table));await failure(()=>f.as(actor,'delete from private.'+table));}
  for(const actor of ['admin','editor','service_role'])for(const expression of ["private.weekly_email_week('2026-09-14')","private.lock_weekly_email_actor(false)","private.weekly_email_source_snapshot('[]','2026-09-14')","private.weekly_email_sources_current('[]','2026-09-14')"])await failure(()=>f.as(actor,'select '+expression));
 });
 await t.test('both staff editors have positive reads and ineligible identities cannot use any endpoint',async()=>{
  for(const actor of ['admin','editor']){const result=await f.workspace(week,actor);assert.equal(result.version,1);assert.equal(result.week_start,week);assert.deepEqual(result.drafts,[]);assert.deepEqual(result.announcements,[]);assert.deepEqual(result.audience,{total:0,requested:0,held:0,not_requested:0});assert.ok(!Number.isNaN(Date.parse(result.generated_at)));}
  for(const actor of ['anon','guest','viewer','unconfirmed','anonymous','banned','deleted','missing','service_role','unrelated']){await failure(()=>f.workspace(week,actor));await failure(()=>f.get(randomUUID(),actor));await failure(()=>f.save(draft(),{actor}));await failure(()=>f.review(randomUUID(),1,'a'.repeat(64),{actor}));}
  await f.db.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1",[ids.editor]);await failure(()=>f.workspace());await failure(()=>f.save());await f.db.query('update auth.users set banned_until=null where id=$1',[ids.editor]);assert.equal((await f.workspace()).version,1);
 });
 await t.test('four wrappers are invokers, private API implementations definers, and all search paths are empty',async()=>{
  const definitions=await f.rows("select n.nspname,p.proname,p.prosecdef,p.proconfig,p.proacl::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname in('get_weekly_email_workspace','get_weekly_email_draft','save_weekly_email_draft','review_weekly_email_draft')");
  assert.equal(definitions.length,8);assert(definitions.every(row=>row.prosecdef===(row.nspname==='private')&&row.proconfig.includes('search_path=""')&&!row.proacl.includes('anon=')));
  const guard=(await f.rows("select pg_get_functiondef('private.lock_weekly_email_actor(boolean)'::regprocedure) definition"))[0].definition;
  assert.match(guard,/from auth\.users where id=auth\.uid\(\) for no key update/i);
 });
});

test('draft snapshots and historical receipts protect shared saves without touching live source or mail',async t=>{
 const f=await setup(t),a=await f.announcement({title:'  Exact title  ',body:'Line one\n  Line two\t'}),b=await f.announcement({starts_on:week,ends_on:'2026-09-20'});
 const id=randomUUID(),key=randomUUID(),body=draft({subject:'  Trim subject  ',intro:' \n  Exact introduction\t',closing:'',announcement_refs:[ref(b),ref(a)]});let first;
 const outside=await f.outside();
 await t.test('server captures only selected ready sources in presentation order and keeps plain text exact',async()=>{
  first=await f.save(body,{id,key});assert.deepEqual(first,{id,version:1,status:'draft'});
  const detail=await f.get(id);assert.deepEqual(Object.keys(detail).sort(),['draft','review_current','sending_enabled','sources_current','version']);assert.equal(detail.version,1);assert.equal(detail.sources_current,true);assert.equal(detail.review_current,false);assert.equal(detail.sending_enabled,false);
  assert.equal(detail.draft.subject,'Trim subject');assert.equal(detail.draft.intro,body.intro);assert.equal(detail.draft.closing,'');assert.deepEqual(detail.draft.sources.map(x=>x.id),[b.id,a.id]);assert.equal(detail.draft.sources[1].title,a.title);assert.equal(detail.draft.sources[1].body,a.body);
  assert.deepEqual(Object.keys(detail.draft).sort(),['closing','content_hash','id','intro','reviewed_at','sources','status','subject','updated_at','version','week_start']);assert.match(detail.draft.content_hash,/^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(detail.draft.sources[0]).sort(),['body','ends_on','id','starts_on','title','version']);assert.equal(JSON.stringify(detail).includes(ids.editor),false);
 });
 await t.test('same request returns exact historical receipt after another editor save without rewriting current state',async()=>{
  const next=await f.save(draft({subject:'Later edit'}),{actor:'admin',id,expected:1});assert.equal(next.version,2);const state=await f.state();
  assert.deepEqual(await f.save(body,{id,key}),first);assert.deepEqual(await f.state(),state);assert.equal((await f.get(id)).draft.subject,'Later edit');
  await failure(()=>f.save({...body,subject:'Changed request'},{id,key}),'40001','WEEKLY_EMAIL_REQUEST_CONFLICT');assert.deepEqual(await f.state(),state);
 });
 await t.test('stale update and concurrent-create loser cannot overwrite a saved draft',async()=>{
  const state=await f.state();await failure(()=>f.save(draft(),{id,expected:1}),'40001','WEEKLY_EMAIL_VERSION_CONFLICT');await failure(()=>f.save(draft(),{id,actor:'admin'}),'40001','WEEKLY_EMAIL_VERSION_CONFLICT');assert.deepEqual(await f.state(),state);
  await failure(()=>f.save(draft(),{expected:2}),'P0002','WEEKLY_EMAIL_NOT_FOUND');await failure(()=>f.get(randomUUID()),'P0002','WEEKLY_EMAIL_NOT_FOUND');
 });
 await t.test('snapshots are immutable, audit carries no content, and no source or outbox changes',async()=>{
  assert.deepEqual(await f.outside(),outside);const state=await f.state();assert.equal(state[0].revisions.length,2);assert.equal(state[0].receipts.length,2);assert.equal(state[0].audit,2);
  assert.equal(state[0].revisions[0].snapshot.subject,'Trim subject');
  for(const table of ['app_weekly_email_revisions','app_weekly_email_receipts'])for(const query of ['update private.'+table+' set created_at=now()','delete from private.'+table,'truncate private.'+table])await failure(()=>f.rows(query),'55000','WEEKLY_EMAIL_HISTORY_IMMUTABLE');
  const audit=await f.rows("select * from public.audit_log where entity_type='app_weekly_email_drafts'");assert.equal(JSON.stringify(audit).includes('Trim subject'),false);assert.equal(JSON.stringify(audit).includes(a.body),false);assert.deepEqual(await f.state(),state);
 });
});

test('content review is admin-only, exact-version, source-current and never sending approval',async t=>{
 const f=await setup(t),a=await f.announcement();const id=randomUUID();await f.save(draft({announcement_refs:[ref(a)]}),{id});let detail=await f.get(id),reviewed,key=randomUUID();
 await t.test('editor denial, stale version and wrong content hash have no partial effects',async()=>{
  const before=await f.state();await failure(()=>f.review(id,1,detail.draft.content_hash,{actor:'editor'}),'42501','ADMIN_REQUIRED');await failure(()=>f.review(id,2,detail.draft.content_hash),'40001','WEEKLY_EMAIL_VERSION_CONFLICT');await failure(()=>f.review(id,1,'f'.repeat(64)),'40001','WEEKLY_EMAIL_CONTENT_CHANGED');assert.deepEqual(await f.state(),before);
 });
 await t.test('admin review persists a new immutable revision but never freezes recipients or enables sending',async()=>{
  reviewed=await f.review(id,1,detail.draft.content_hash,{key});assert.deepEqual(reviewed,{id,version:2,status:'reviewed'});const current=await f.get(id);assert.equal(current.review_current,true);assert.equal(current.sources_current,true);assert.equal(current.sending_enabled,false);assert.ok(current.draft.reviewed_at);assert.equal(current.draft.content_hash,detail.draft.content_hash);
  const before=await f.state();assert.deepEqual(await f.review(id,1,detail.draft.content_hash,{key}),reviewed);assert.deepEqual(await f.state(),before);
 });
 await t.test('later save resets review; retrying the old review cannot restore it',async()=>{
  await f.save(draft({intro:'New wording'}),{id,expected:2});const current=await f.get(id);assert.equal(current.draft.version,3);assert.equal(current.draft.status,'draft');assert.equal(current.review_current,false);assert.equal(current.draft.reviewed_at,null);const before=await f.state();
  assert.deepEqual(await f.review(id,1,detail.draft.content_hash,{key}),reviewed);assert.deepEqual(await f.state(),before);assert.equal((await f.get(id)).draft.status,'draft');
  await failure(()=>f.review(id,3,current.draft.content_hash,{key}),'40001','WEEKLY_EMAIL_REQUEST_CONFLICT');
 });
 await t.test('one actor cannot reuse a save request as a review operation',async()=>{
  const shared=randomUUID(),other=randomUUID();await f.save(draft(),{actor:'admin',id:other,key:shared});const d=await f.get(other);const before=await f.state();await failure(()=>f.review(other,1,d.draft.content_hash,{key:shared}),'40001','WEEKLY_EMAIL_REQUEST_CONFLICT');assert.deepEqual(await f.state(),before);
 });
 await t.test('a subject-only draft is saveable but empty wording cannot be marked reviewed',async()=>{
  const empty=await f.save(draft({intro:' \n\t',closing:' '}));const d=await f.get(empty.id),before=await f.state();await failure(()=>f.review(empty.id,1,d.draft.content_hash),'22023','INVALID_WEEKLY_EMAIL_FIELDS');assert.deepEqual(await f.state(),before);
  const text=await f.save(draft({intro:'',closing:'A real closing.'}));const dd=await f.get(text.id);assert.equal((await f.review(text.id,1,dd.draft.content_hash)).status,'reviewed');
 });
});

test('saved source status content versions and dates must remain current for review',async t=>{
 const f=await setup(t);
 for(const[field,value]of[['title','Changed title'],['body','Changed body'],['status','archived'],['starts_on','2026-09-21'],['ends_on','2026-09-13']])await t.test('source '+field+' change invalidates fresh detail without rewriting historical review',async()=>{
  const a=await f.announcement(),r=await f.save(draft({announcement_refs:[ref(a)]}));const old=await f.get(r.id);await f.review(r.id,1,old.draft.content_hash);const state=await f.state();await f.updateAnnouncement(a.id,field,value);
  const detail=await f.get(r.id);assert.equal(detail.sources_current,false);assert.equal(detail.review_current,false);assert.equal(detail.draft.status,'reviewed');assert.deepEqual(detail.draft.sources,old.draft.sources);assert.deepEqual(await f.state(),state);
  await failure(()=>f.review(r.id,2,detail.draft.content_hash),'40001','WEEKLY_EMAIL_SOURCE_CHANGED');assert.deepEqual(await f.state(),state);
 });
 await t.test('source-only content may be reviewed and a changed source must be explicitly reselected',async()=>{
  const a=await f.announcement(),body=draft({intro:'',closing:'',announcement_refs:[ref(a)]}),r=await f.save(body);const changed=await f.updateAnnouncement(a.id,'body','Latest source');const before=await f.state();await failure(()=>f.save(body,{id:r.id,expected:1}),'40001','WEEKLY_EMAIL_SOURCE_CHANGED');assert.deepEqual(await f.state(),before);
  await f.save({...body,announcement_refs:[ref(changed)]},{id:r.id,expected:1});const d=await f.get(r.id);assert.equal(d.sources_current,true);assert.equal(d.draft.sources[0].body,'Latest source');assert.equal((await f.review(r.id,2,d.draft.content_hash)).status,'reviewed');
 });
});

test('strict fields sources and complete bounded workspaces reject partial or malformed results',async t=>{
 const f=await setup(t),a=await f.announcement();
 await t.test('invalid body types keys text controls and bounds fail atomically',async()=>{
  const before=await f.state();for(const body of [null,[],{},draft({extra:true}),draft({intro:null}),draft({closing:4}),draft({subject:' '}),draft({subject:'x'.repeat(161)}),draft({subject:'bad\nheader'}),draft({subject:'bad\u0001'}),draft({intro:'x'.repeat(4001)}),draft({closing:'x'.repeat(2001)}),draft({intro:'bad\u0001'}),draft({closing:'bad\u0002'}),draft({announcement_refs:null}),draft({announcement_refs:{}})])await failure(()=>f.save(body),'22023','INVALID_WEEKLY_EMAIL_FIELDS');assert.deepEqual(await f.state(),before);
 });
 await t.test('week validation rejects non-Monday impossible and out-of-range dates',async()=>{
  for(const value of ['2026-09-15','1999-12-27','2101-01-03','2026-02-30'])await failure(()=>f.save(draft({week_start:value})),'22023','INVALID_WEEKLY_EMAIL_WEEK');
  for(const value of [null,'2026-09-15','1999-12-27','2101-01-03','infinity'])await failure(()=>f.workspace(value),'22023','INVALID_WEEKLY_EMAIL_WEEK');
  for(const value of ['2026-9-14','2026-09-14T00:00:00Z',3])await failure(()=>f.save(draft({week_start:value})),'22023','INVALID_WEEKLY_EMAIL_FIELDS');
 });
 await t.test('references reject duplicate IDs malformed values and client-supplied snapshots',async()=>{
  const before=await f.state();for(const refs of [[ref(a),ref(a)],[{...ref(a),body:'Untrusted'}],[{id:a.id,version:0}],[{id:a.id,version:'1'}],[{id:a.id,version:1.5}],[{id:a.id,version:2147483648}],[{id:'bad',version:1}],[null],Array(13).fill(ref(a))])await failure(()=>f.save(draft({announcement_refs:refs})),'22023','INVALID_WEEKLY_EMAIL_FIELDS');assert.deepEqual(await f.state(),before);
 });
 await t.test('missing stale unready and out-of-week sources fail without partial history',async()=>{
  const notReady=await f.announcement({status:'draft'}),future=await f.announcement({starts_on:otherWeek}),past=await f.announcement({ends_on:'2026-09-13'});const before=await f.state();
  for(const refs of [[{id:randomUUID(),version:1}],[{id:a.id,version:2}],[ref(notReady)],[ref(future)],[ref(past)]])await failure(()=>f.save(draft({announcement_refs:refs})),'40001','WEEKLY_EMAIL_SOURCE_CHANGED');assert.deepEqual(await f.state(),before);
 });
 await t.test('overlap boundaries and undated ready sources appear but draft archived and nonoverlap do not',async()=>{
  const monday=await f.announcement({starts_on:week,ends_on:week}),sunday=await f.announcement({starts_on:'2026-09-20',ends_on:'2026-09-20'});await f.announcement({status:'archived'});
  const w=await f.workspace();assert.deepEqual(new Set(w.announcements.map(x=>x.id)),new Set([a.id,monday.id,sunday.id]));assert(w.announcements.every(x=>Object.keys(x).sort().join(',')==='body,ends_on,id,starts_on,title,version'));
 });
 await t.test('snapshot aggregate character boundary is inclusive and overflow is atomic',async()=>{
  const sources=[];for(let i=0;i<3;i++)sources.push(await f.announcement({title:'x'.repeat(10),body:'x'.repeat(9990)}));const good=await f.save(draft({announcement_refs:sources.map(ref)}));assert.equal((await f.get(good.id)).draft.sources.length,3);
  sources[2]=await f.updateAnnouncement(sources[2].id,'title','x'.repeat(11));const before=await f.state();await failure(()=>f.save(draft({announcement_refs:sources.map(ref)})),'54000','WEEKLY_EMAIL_LIMIT_EXCEEDED');assert.deepEqual(await f.state(),before);
 });
});

test('twenty-draft capacity is enforced on create and cross-week move while edit and retry remain safe',async t=>{
 const f=await setup(t);const saved=[];
 for(let i=0;i<20;i++){const id=randomUUID(),key=randomUUID(),body=draft({subject:'Fictional '+i});saved.push({id,key,body,receipt:await f.save(body,{id,key})});}
 await t.test('complete twenty-row workspace passes and a twenty-first create leaves no partial records',async()=>{
  assert.equal((await f.workspace()).drafts.length,20);const before=await f.state();await failure(()=>f.save(),'54000','WEEKLY_EMAIL_LIMIT_EXCEEDED');assert.deepEqual(await f.state(),before);
 });
 await t.test('moves into a full week fail but editing within that week and exact retries still work',async()=>{
  const other=await f.save(draft({week_start:otherWeek}));const before=await f.state();await failure(()=>f.save(draft(),{id:other.id,expected:1}),'54000','WEEKLY_EMAIL_LIMIT_EXCEEDED');assert.deepEqual(await f.state(),before);assert.equal((await f.get(other.id)).draft.week_start,otherWeek);
  const first=saved[0];assert.equal((await f.save(draft({subject:'Edited within full week'}),{id:first.id,expected:1})).version,2);const current=await f.state();assert.deepEqual(await f.save(first.body,{id:first.id,key:first.key}),first.receipt);assert.deepEqual(await f.state(),current);
  await f.save(draft({week_start:otherWeek}),{id:saved[1].id,expected:1});assert.equal((await f.workspace()).drafts.length,19);await f.save();assert.equal((await f.workspace()).drafts.length,20);
 });
 await t.test('missing write guard fails closed without an unguarded save',async()=>{
  await f.rows('delete from private.app_weekly_email_write_guard');const before=await f.state();await failure(()=>f.save(draft({week_start:otherWeek})),'22023','INVALID_WEEKLY_EMAIL_FIELDS');assert.deepEqual(await f.state(),before);
 });
});

test('workspace source and audience bounds return all data or an explicit overflow without leaking addresses',async t=>{
 const f=await setup(t);
 await t.test('two hundred ready source candidates pass and the sentinel fails instead of truncating',async()=>{
  await f.as('admin',"insert into public.office_announcements(title,body,status)select 'Fictional '||i,'Body','ready' from generate_series(1,200)i");assert.equal((await f.workspace()).announcements.length,200);
  const last=await f.announcement();await failure(()=>f.workspace(),'54000','WEEKLY_EMAIL_LIMIT_EXCEEDED');await f.updateAnnouncement(last.id,'status','archived');assert.equal((await f.workspace()).announcements.length,200);
 });
 await t.test('audience projection is counts only and uses fresh requested held and no-choice classifications',async()=>{
  const profile={first_name:'Fictional',last_name:'Private',phone:null,preferred_contact:'email',contact_permission:true,sunday_school:null,visit_status:'not_yet',first_visit_on:null};
  for(const actor of ['guest','admin','editor'])await f.rpc(actor,'register_app_guest',[randomUUID(),profile]);await f.rpc('guest','set_my_communication_preferences',[randomUUID(),0,true]);await f.rpc('admin','set_my_communication_preferences',[randomUUID(),0,false]);
  let w=await f.workspace();assert.deepEqual(w.audience,{total:3,requested:1,held:0,not_requested:2});assert(!JSON.stringify(w).includes('@example.invalid'));assert(!JSON.stringify(w).includes('Fictional Private'));
  await f.db.query("update auth.users set email='changed@example.invalid' where id=$1",[ids.guest]);w=await f.workspace();assert.deepEqual(w.audience,{total:3,requested:0,held:1,not_requested:2});
  const outside=await f.outside(),saved=await f.save();const detail=await f.get(saved.id);await f.review(saved.id,1,detail.draft.content_hash);assert.deepEqual(await f.outside(),outside);
 });
 await t.test('five thousand audience entries yield counts only and overflow becomes the fixed weekly limit error',async()=>{
  await f.db.exec(`insert into auth.users(id,email,is_anonymous)select ('20000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'boundary'||i||'@example.invalid',false from generate_series(1,4998)i;
  insert into public.app_connections(auth_user_id,first_name,last_name,email,preferred_contact,contact_permission)select id,'Fictional','Boundary',email,'email',true from auth.users where id::text like '20000000-%' and id::text<>'20000000-0000-4000-8000-000000004998';`);
  const w=await f.workspace();assert.equal(w.audience.total,5000);assert.deepEqual(Object.keys(w.audience).sort(),['held','not_requested','requested','total']);assert.equal(JSON.stringify(w).includes('boundary1@example.invalid'),false);
  await f.db.exec("insert into public.app_connections(auth_user_id,first_name,email,preferred_contact,contact_permission)select id,'Final',email,'email',true from auth.users where id='20000000-0000-4000-8000-000000004998';");
  await failure(()=>f.workspace(),'54000','WEEKLY_EMAIL_LIMIT_EXCEEDED');
 });
});
