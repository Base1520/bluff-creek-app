import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {setup,denied,ids} from './server-test-support.mjs';

const migration=new URL('./migrations/20260912224640_care_reminder_controls.sql',import.meta.url);
const sourceKeys=['source_type','source_id','source_version','lifecycle_version','contact_id','label','care_role','owner_label','assigned_staff_user_id','one_time','active'];
const jobKeys=['id','version','status','created_at','planned_on','next_attempt_at','attempts','error_code','recipient_user_ids','source_count','hold_active','can_resolve'];
const statuses=['queued','sending','accepted','failed','uncertain','cancelled'];
const workspace=f=>f.rpc('admin','get_care_reminder_workspace');
const jobs=(f,args=[])=>f.rpc('admin','get_care_reminder_jobs',args);
async function addJob(f,status='queued',extra={}){
 const id=extra.id||randomUUID();
 await f.rows(`insert into private.care_reminder_jobs(id,destination_key,recipient_user_ids,source_refs,planned_on,status,
  created_at,next_attempt_at,attempts,first_attempt_at,lease_token,lease_until,provider_id,error_code)
 values($1,$2,$3,$4,'2026-09-12',$5,$6,'2026-09-12T15:00:00Z',$7,$8,$9,$10,$11,$12)`,[
  id,extra.destination_key||createHash('sha256').update(id).digest('hex'),extra.recipients||[ids.editor],
  [{source_type:'care_plan',source_id:randomUUID(),cycle_id:randomUUID(),source_fingerprint:'f'.repeat(64),private_note:'NEVER_PROJECT_SOURCE_REFS'}],status,
  extra.created_at||'2026-09-12T14:00:00Z',status==='queued'?0:1,status==='queued'?null:'2026-09-12T14:00:00Z',
  status==='sending'?randomUUID():null,status==='sending'?'2026-09-12T14:02:00Z':null,
  status==='accepted'?'NEVER_PROJECT_PROVIDER_ID':null,['failed','uncertain'].includes(status)?'provider_timeout':null
 ]);return id;
}
async function tableSnapshot(f){
 const tables=await f.rows("select schemaname,tablename from pg_tables where schemaname in('public','private','auth') order by 1,2");
 const result={};
 for(const {schemaname,tablename} of tables){
  assert.match(schemaname,/^[a-z_]+$/);assert.match(tablename,/^[a-z_]+$/);
  result[schemaname+'.'+tablename]=(await f.rows(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) value from ${schemaname}.${tablename} t`))[0].value;
 }return result;
}

test('controls only add four STABLE guarded functions and preserve prior SQL, policies and rows',async t=>{
 const f=await setup(t,{queue:true}),before=await f.functionState(),policies=await f.rows('select * from pg_policies order by schemaname,tablename,policyname'),rows=await tableSnapshot(f);
 for(const [file,hash] of [
  ['20260912183930_care_reminder_bindings.sql','0cb3338ecfd93f5b5c0b16e9b4177ea715b509f866691e437d0a4fe6a60778ab'],
  ['20260912183934_care_reminder_queue.sql','7751c0cfc72dc48e93f126a41cb58d3af69c1f01e1e4083f5c9678749d05b488']
 ])assert.equal(createHash('sha256').update(await readFile(new URL('./migrations/'+file,import.meta.url))).digest('hex'),hash);
 await f.db.exec(await readFile(migration,'utf8'));
 const after=await f.functionState(),old=new Set(before.map(x=>x.nspname+'.'+x.proname+'('+x.args+')'));
 assert.deepEqual(after.filter(x=>old.has(x.nspname+'.'+x.proname+'('+x.args+')')),before);
 const added=after.filter(x=>!old.has(x.nspname+'.'+x.proname+'('+x.args+')'));
 assert.equal(added.length,4);assert.ok(added.every(x=>x.provolatile==='s'&&x.proconfig.includes('search_path=""')));
 assert.ok(added.filter(x=>x.nspname==='public').every(x=>!x.prosecdef));
 assert.ok(added.filter(x=>x.nspname==='private').every(x=>x.prosecdef));
 assert.deepEqual(await f.rows('select * from pg_policies order by schemaname,tablename,policyname'),policies);
 assert.deepEqual(await tableSnapshot(f),rows);
});

test('empty workspace and queue have truthful disabled state, complete counts and only eligible staff',async t=>{
 const f=await setup(t,{controls:true}),w=await workspace(f),j=await jobs(f);
 assert.deepEqual(Object.keys(w).sort(),['version','generated_at','today','settings','readiness','eligible_staff','sources'].sort());
 assert.equal(w.version,1);assert.match(w.today,/^\d{4}-\d{2}-\d{2}$/);assert.ok(Number.isFinite(Date.parse(w.generated_at)));
 assert.deepEqual(w.settings,await f.rpc('admin','get_care_reminder_settings'));assert.deepEqual(w.readiness,await f.rpc('admin','get_care_reminder_readiness'));
 assert.equal(w.settings.enabled,false);assert.deepEqual(w.sources,[]);
 assert.deepEqual(w.eligible_staff,[{id:ids.admin,label:'admin@example.invalid'},{id:ids.editor,label:'editor@example.invalid'}]);
 assert.deepEqual(j.items,[]);assert.equal(j.total,0);assert.equal(j.has_more,false);assert.equal(j.next_cursor,null);
 assert.deepEqual(j.countsByStatus,Object.fromEntries(statuses.map(s=>[s,0])));
});

test('public and private read functions require a current eligible administrator, including service-role denial',async t=>{
 const f=await setup(t,{controls:true});
 for(const actor of ['editor','viewer','guest','other','unconfirmed','banned','deleted','anonymous','anon','service_role']){
  for(const fn of ['get_care_reminder_workspace','get_care_reminder_jobs']){
   await denied(()=>f.rpc(actor,fn));await denied(()=>f.as(actor,'select private.'+fn+'()'));
  }
 }
 const grants=await f.rows(`select n.nspname,p.proname,
  has_function_privilege('anon',p.oid,'execute') anon,
  has_function_privilege('service_role',p.oid,'execute') service,
  has_function_privilege('authenticated',p.oid,'execute') authenticated
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where p.proname in('get_care_reminder_workspace','get_care_reminder_jobs')`);
 assert.equal(grants.length,4);assert.ok(grants.every(g=>!g.anon&&!g.service&&g.authenticated));
});

test('same-identity role revocation or ban blocks the next read immediately',async t=>{
 const f=await setup(t,{controls:true});await workspace(f);
 await f.rows("update public.staff_roles set role='editor' where user_id=$1",[ids.admin]);
 await denied(()=>workspace(f));await denied(()=>jobs(f));
 await f.rows("update public.staff_roles set role='admin' where user_id=$1",[ids.admin]);
 await f.rows("update auth.users set banned_until=now()+interval '1 day' where id=$1",[ids.admin]);
 await denied(()=>workspace(f));await denied(()=>jobs(f));
});

test('sources project minimal review fields and keep display labels distinct from approved recipients',async t=>{
 const f=await setup(t,{controls:true});
 const c=await f.makeCare({person:{notes:'PRIVATE_PERSON_NOTES'},plan:{assigned_to:'Historical display owner',notes:'PRIVATE_PLAN_NOTES'}});
 const r=await f.reg(),task=await f.taskFor(r.id);
 let w=await workspace(f),care=w.sources.find(x=>x.source_id===c.plan.id),guest=w.sources.find(x=>x.source_id===task.id);
 for(const s of w.sources)assert.deepEqual(Object.keys(s).sort(),sourceKeys.slice().sort());
 assert.equal(care.label,'Fictional Care');assert.equal(care.owner_label,'Historical display owner');assert.equal(care.assigned_staff_user_id,null);
 assert.equal(care.lifecycle_version,null);assert.equal(care.source_version,c.plan.version);assert.equal(care.active,true);
 assert.equal(guest.label,'Fictional Guest');assert.equal(guest.owner_label,'Office queue');assert.equal(guest.assigned_staff_user_id,null);assert.equal(guest.lifecycle_version,1);
 assert.ok(!JSON.stringify(w).includes('PRIVATE_'));assert.ok(!JSON.stringify(w).includes('submitted_auth_user_id'));
 await f.bind('care_plan',c.plan.id);w=await workspace(f);care=w.sources.find(x=>x.source_id===c.plan.id);
 assert.equal(care.assigned_staff_user_id,ids.editor);assert.equal(care.owner_label,'Historical display owner');
});

test('unbound paused, inactive and completed care is omitted; bound entries stay visible for review',async t=>{
 const f=await setup(t,{controls:true});
 const paused=await f.makeCare({plan:{paused:true}}),inactive=await f.makeCare({person:{status:'inactive'}}),done=await f.makeCare({plan:{one_time:true},visits:[{}]}),active=await f.makeCare();
 assert.deepEqual((await workspace(f)).sources.map(s=>s.source_id),[active.plan.id]);
 for(const c of [paused,inactive,done])await f.bind('care_plan',c.plan.id);
 const w=await workspace(f);assert.equal(w.sources.length,4);
 for(const c of [paused,inactive,done])assert.equal(w.sources.find(s=>s.source_id===c.plan.id).active,false);
 assert.equal(w.readiness.counts.unbound_care,1);
});

test('missing bound care retains its identity with null current version and no stale personal label',async t=>{
 const f=await setup(t,{controls:true}),c=await f.makeCare();await f.bind('care_plan',c.plan.id);
 await f.rows('delete from public.care_assignments where id=$1',[c.plan.id]);
 const w=await workspace(f),s=w.sources[0];assert.equal(s.source_id,c.plan.id);assert.equal(s.source_version,null);assert.equal(s.contact_id,null);
 assert.equal(s.label,'Unavailable care plan');assert.equal(s.active,false);assert.equal(w.readiness.counts.missing_sources,1);
});

test('removed and restored guests retain review visibility and expose current lifecycle without implicit restart',async t=>{
 const f=await setup(t,{controls:true}),r=await f.reg(),task=await f.taskFor(r.id);
 await f.bind('guest_task',task.id);const initial=(await workspace(f)).settings.bindings[0];await f.change(r.id,true);
 let w=await workspace(f),s=w.sources.find(x=>x.source_id===task.id);assert.equal(s.active,false);assert.equal(s.lifecycle_version,2);
 assert.equal(w.settings.bindings[0].lifecycle_version,1);assert.equal(w.readiness.counts.lifecycle_changed,1);
 await f.change(r.id,false);w=await workspace(f);s=w.sources.find(x=>x.source_id===task.id);
 assert.equal(s.active,true);assert.equal(s.lifecycle_version,3);assert.equal(w.settings.bindings[0].cycle_id,initial.cycle_id);
 assert.equal(w.settings.bindings[0].lifecycle_version,1);assert.deepEqual(await f.sourceRows(),[]);
});

test('guest source ownership reflects current task, including unavailable staff, without rewriting old binding',async t=>{
 const f=await setup(t,{controls:true}),r=await f.reg(),task=await f.taskFor(r.id);await f.bind('guest_task',task.id);
 await f.rpc('admin','update_intake_task',[task.id,task.version,{assigned_staff_user_id:ids.editor}]);
 let w=await workspace(f),s=w.sources.find(x=>x.source_id===task.id);
 assert.equal(s.assigned_staff_user_id,ids.editor);assert.equal(s.owner_label,'editor@example.invalid');assert.equal(w.settings.bindings[0].owner_user_id,null);
 assert.equal(w.readiness.counts.owner_changed,1);
 await f.rows("update auth.users set banned_until=now()+interval '1 day' where id=$1",[ids.editor]);
 w=await workspace(f);s=w.sources.find(x=>x.source_id===task.id);assert.equal(s.owner_label,'Unavailable staff');assert.equal(s.assigned_staff_user_id,ids.editor);
 assert.ok(!w.eligible_staff.some(s=>s.id===ids.editor));
});

test('unbound removed, archived and completed guests are omitted',async t=>{
 const f=await setup(t,{controls:true}),r=await f.reg(),task=await f.taskFor(r.id);await f.change(r.id,true);
 assert.deepEqual((await workspace(f)).sources,[]);
 await f.change(r.id,false);const registration=await f.get(r.id);await f.rows("update public.app_connections set status='archived' where id=$1",[r.id]);
 assert.deepEqual((await workspace(f)).sources,[]);
 await f.rows('update public.app_connections set status=$2 where id=$1',[r.id,registration.status]);
 const current=await f.taskFor(r.id);await f.rpc('admin','update_intake_task',[task.id,current.version,{status:'completed'}]);
 assert.deepEqual((await workspace(f)).sources,[]);
});

test('workspace returns exactly 5000 sources or fails closed at 5001, with no partial result',async t=>{
 const f=await setup(t,{controls:true});await f.makeCare();
 await f.rows(`with people as (insert into public.contacts(first_name,last_name,status)
  select 'Fictional','Capacity','active' from generate_series(1,4999) returning id)
  insert into public.care_assignments(contact_id,assigned_to,care_role,cadence_days,started_on)
  select id,'Fictional staff','deacon',28,'2026-09-01'::date from people`);
 assert.equal((await workspace(f)).sources.length,5000);
 await f.makeCare();
 await denied(()=>workspace(f),'54000','CARE_REMINDER_SOURCE_LIMIT');
});

test('job projection excludes transport/source secrets and accurately summarizes states and active holds',async t=>{
 const f=await setup(t,{controls:true}),byStatus={};for(const s of statuses)byStatus[s]=await addJob(f,s);
 await f.rows(`insert into private.care_reminder_destination_holds(destination_key,job_id,reason,created_at)
  select destination_key,id,'delivery_uncertain',created_at from private.care_reminder_jobs where id=$1`,[byStatus.uncertain]);
 const all=await jobs(f,['all']);assert.equal(all.total,6);assert.equal(all.items.length,6);assert.equal(all.has_more,false);
 assert.deepEqual(all.countsByStatus,Object.fromEntries(statuses.map(s=>[s,1])));
 for(const item of all.items){
  assert.deepEqual(Object.keys(item).sort(),jobKeys.slice().sort());assert.equal(item.source_count,1);
  assert.equal(item.can_resolve,['queued','failed','uncertain'].includes(item.status));assert.equal(item.hold_active,item.status==='uncertain');
 }
 const encoded=JSON.stringify(all);for(const forbidden of ['NEVER_PROJECT','destination_key','lease_token','lease_until','provider_id','source_refs','source_fingerprint'])assert.ok(!encoded.includes(forbidden));
 const attention=await jobs(f);assert.equal(attention.total,4);assert.equal(attention.items.length,4);assert.deepEqual(attention.countsByStatus,all.countsByStatus);
});

test('keyset pagination includes tied timestamps without duplicates and counts the whole filter on every page',async t=>{
 const f=await setup(t,{controls:true});
 await f.rows(`insert into private.care_reminder_jobs(id,destination_key,recipient_user_ids,source_refs,planned_on,created_at,next_attempt_at)
  select gen_random_uuid(),encode(sha256(convert_to(n::text,'UTF8')),'hex'),$1::uuid[],'[{}]'::jsonb,'2026-09-12',
   '2026-09-12T14:00:00Z'::timestamptz,'2026-09-12T15:00:00Z'::timestamptz from generate_series(1,105) n`,[[ids.editor]]);
 const first=await jobs(f);assert.equal(first.items.length,50);assert.equal(first.has_more,true);
 assert.deepEqual(first.next_cursor,{created_at:first.items.at(-1).created_at,id:first.items.at(-1).id});
 const seen=first.items.map(x=>x.id);let next=first.next_cursor;
 while(next){const p=await jobs(f,['attention',next.created_at,next.id,50]);assert.equal(p.total,105);seen.push(...p.items.map(x=>x.id));next=p.next_cursor;assert.equal(p.has_more,next!==null);}
 assert.equal(seen.length,105);assert.equal(new Set(seen).size,105);assert.deepEqual(seen,[...seen].sort().reverse());
 assert.equal((await jobs(f,['all',null,null,100])).items.length,100);
});

test('job query rejects invalid filters, limits and partial or nonfinite cursors',async t=>{
 const f=await setup(t,{controls:true});
 for(const args of [[null],['failed'],['all',null,null,0],['all',null,null,101],['all',null,null,null],
  ['all','2026-09-12T14:00:00Z',null],['all',null,randomUUID()],['all','infinity',randomUUID()],['all','-infinity',randomUUID()]])
  await denied(()=>jobs(f,args),'22023');
});

test('can_resolve agrees with the existing versioned cancel-only RPC, including expired sending leases',async t=>{
 const f=await setup(t,{controls:true});for(const s of statuses)await addJob(f,s);
 for(const j of (await jobs(f,['all'])).items){
  const action=()=>f.rpc('admin','resolve_care_reminder_job',[randomUUID(),j.id,j.version,'cancel_no_resend']);
  if(j.can_resolve){const result=await action();assert.equal(result.status,'cancelled');assert.equal(result.version,j.version+1);}
  else await denied(action,'55000');
 }
 assert.equal((await jobs(f)).items.length,1);assert.equal((await jobs(f)).items[0].status,'sending');
});

test('workspace and jobs reads do not claim jobs, expire leases, clear holds, mutate sources or create audit rows',async t=>{
 const f=await setup(t,{controls:true}),c=await f.makeCare();await f.bind('care_plan',c.plan.id);await f.configure();
 await f.reg();await addJob(f,'sending');const uncertain=await addJob(f,'uncertain');
 await f.rows(`insert into private.care_reminder_destination_holds(destination_key,job_id,reason,created_at)
  select destination_key,id,'delivery_uncertain',created_at from private.care_reminder_jobs where id=$1`,[uncertain]);
 const before=await tableSnapshot(f);await workspace(f);await jobs(f);await jobs(f,['all']);assert.deepEqual(await tableSnapshot(f),before);
});
