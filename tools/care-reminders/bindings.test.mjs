import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {setup,denied,ids,baselineSql} from './server-test-support.mjs';
const {dueFor}=createRequire(import.meta.url)('../../admin/care.js');
const day=v=>v instanceof Date?v.toISOString().slice(0,10):v;
const normalized=v=>Object.fromEntries(Object.entries(v).map(([k,x])=>[k,k.endsWith('_on')?day(x):x instanceof Date?x.toISOString():x]));

test('exact twelve baseline is checked and disabled defaults do not invent bindings or pastors',async t=>{
 const f=await setup(t);assert.equal(baselineSql.length,12);assert.equal(baselineSql.filter(x=>x.execute).length,11);
 const state=await f.rpc('admin','get_care_reminder_settings');assert.equal(state.enabled,false);assert.deepEqual(state.pastor_user_ids,[]);assert.deepEqual(state.bindings,[]);
 assert.deepEqual(await f.sourceRows(),[]);assert.equal((await f.rpc('admin','get_care_reminder_readiness')).pastor_setup_required,true);
});

test('all configuration and setup reads require a current eligible administrator',async t=>{
 const f=await setup(t),c=await f.makeCare();
 for(const actor of ['editor','viewer','guest','unconfirmed','banned','deleted','anonymous','anon','service_role']){
  for(const fn of ['get_care_reminder_settings','get_care_reminder_readiness'])await denied(()=>f.rpc(actor,fn));
  await denied(()=>f.configure({actor}));await denied(()=>f.bind('care_plan',c.plan.id,{actor}));
 }
 for(const actor of ['admin','editor','guest','anon','service_role']){
  for(const table of ['care_reminder_settings','care_reminder_bindings','care_reminder_config_receipts'])await denied(()=>f.as(actor,'select * from private.'+table));
  await denied(()=>f.as(actor,"select * from private.care_reminder_source_rows('2026-09-12')"));
 }
});

test('settings use explicit eligible recipients, expected versions and immutable historical receipts',async t=>{
 const f=await setup(t),request_id=randomUUID(),a=await f.configure({request_id});
 assert.equal(a.version,2);assert.deepEqual(await f.configure({request_id,version:1}),a);
 await denied(()=>f.configure({version:1}),'40001');await denied(()=>f.configure({request_id,version:1,enabled:false}),'40001');
 for(const pastor_user_ids of [[],[ids.viewer],[ids.unconfirmed],[ids.banned],[ids.admin,ids.admin],[null]])await denied(()=>f.configure({pastor_user_ids}),'22023');
 await f.configure({enabled:false,pastor_user_ids:[]});assert.deepEqual(await f.configure({request_id,version:1}),a);
 assert.equal((await f.rpc('admin','get_care_reminder_settings')).enabled,false);
 await denied(()=>f.rows('delete from private.care_reminder_config_receipts'),'55000');
});

test('care binding retry is exact, source/version conflicts are atomic, and only explicit restart changes cycle',async t=>{
 const f=await setup(t),c=await f.makeCare(),request_id=randomUUID(),a=await f.bind('care_plan',c.plan.id,{request_id});
 assert.deepEqual(await f.bind('care_plan',c.plan.id,{request_id,version:0}),a);
 await denied(()=>f.bind('care_plan',c.plan.id,{version:0}),'40001');
 await denied(()=>f.bind('care_plan',c.plan.id,{source_version:c.plan.version+1}),'40001');
 await denied(()=>f.bind('care_plan',c.plan.id,{request_id,version:0,owner_user_id:ids.admin}),'40001');
 const b=await f.bind('care_plan',c.plan.id,{enabled:false});assert.equal(b.cycle_id,a.cycle_id);
 const d=await f.bind('care_plan',c.plan.id,{restart_cycle:true});assert.notEqual(d.cycle_id,a.cycle_id);
 assert.equal((await f.rows('select count(*)::int n from private.care_reminder_config_receipts'))[0].n,3);
 await denied(()=>f.configure({request_id,version:1}),'40001');
});

test('recipient choices cannot turn a display name, viewer or unavailable account into an authorized destination',async t=>{
 const f=await setup(t),c=await f.makeCare({plan:{assigned_to:'An unapproved display name'}});
 for(const owner_user_id of [ids.viewer,ids.unconfirmed,ids.banned,ids.deleted,ids.anonymous,ids.guest])await denied(()=>f.bind('care_plan',c.plan.id,{owner_user_id}),'22023');
 await f.bind('care_plan',c.plan.id,{owner_user_id:null});assert.equal((await f.sourceRows())[0].owner_user_id,null);
 assert.equal((await f.rpc('admin','get_care_reminder_readiness')).counts.unassigned,1);
 await f.bind('care_plan',c.plan.id);await f.rows("update auth.users set banned_until=now()+interval '1 day' where id=$1",[ids.editor]);
 assert.equal((await f.sourceRows())[0].owner_user_id,ids.editor); // Queue resolves eligibility again; never silently switches owner.
 assert.equal((await f.rpc('admin','get_care_reminder_readiness')).counts.recipient_unavailable,1);
});

test('SQL due dates match actual dueFor for calendar months, leap days, first dates, attempts, retries and role history',async t=>{
 const f=await setup(t);
 const cases=[
  {plan:{started_on:'2026-01-31',cadence_months:1}},
  {plan:{started_on:'2024-02-29',cadence_months:12}},
  {plan:{started_on:'2026-05-31',cadence_months:3}},
  {plan:{first_due_on:'2026-09-04'},visits:[{outcome:'attempted',contacted_on:'2026-09-02'}]},
  {plan:{first_due_on:'2026-09-04'},visits:[{contacted_on:'2026-09-02'}]},
  {visits:[{outcome:'attempted',contacted_on:'2026-09-02',next_contact_on:'2026-09-15'},{outcome:'attempted',contacted_on:'2026-09-03'}]},
  {visits:[{outcome:'attempted',contacted_on:'2026-09-02',next_contact_on:'2026-09-15'},{contacted_on:'2026-09-03'}]},
  {visits:[{contacted_on:'2026-09-02',care_role:'pastoral'},{contacted_on:'2026-09-15'}]},
  {plan:{one_time:true},visits:[{contacted_on:'2026-08-31'}]},
  {plan:{one_time:true},visits:[{contacted_on:'2026-09-03'}]},
  {plan:{paused:true}},
  {visits:[{id:'11111111-1111-4111-8111-111111111111',outcome:'attempted',contacted_on:'2026-09-03',next_contact_on:'2026-09-16'},
   {id:'22222222-2222-4222-8222-222222222222',outcome:'attempted',contacted_on:'2026-09-03',next_contact_on:'2026-09-18'}]}
 ];
 for(const sample of cases){
  const c=await f.makeCare(sample);await f.bind('care_plan',c.plan.id);
  const expected=dueFor(normalized(c.plan),c.visits.map(normalized),'2026-09-12'),got=(await f.sourceRows()).find(x=>x.source_id===c.plan.id);
  if(expected.paused||expected.completed)assert.equal(got,undefined,JSON.stringify(sample));else assert.equal(got.due_on,expected.due,JSON.stringify(sample));
 }
});

test('new source progress changes the fingerprint and due but preserves the approved cycle',async t=>{
 const f=await setup(t),c=await f.makeCare();await f.bind('care_plan',c.plan.id);const before=(await f.sourceRows())[0];
 await f.addVisit(c,{contacted_on:'2026-09-10',notes:'Fictional private note never projected'});
 const after=(await f.sourceRows())[0];assert.equal(after.due_on,'2026-10-08');assert.equal(after.cycle_id,before.cycle_id);assert.notEqual(after.source_fingerprint,before.source_fingerprint);
 assert.match(after.source_fingerprint,/^[a-f0-9]{64}$/);assert.deepEqual(Object.keys(after).sort(),['source_type','source_id','cycle_id','due_on','state','owner_user_id','source_fingerprint'].sort());
 assert.ok(!JSON.stringify(after).includes('Fictional'));assert.ok(!JSON.stringify(after).includes('@'));
});

test('disabled, inactive and completed sources are excluded without altering their original records',async t=>{
 const f=await setup(t),a=await f.makeCare(),inactive=await f.makeCare({person:{status:'inactive'}}),done=await f.makeCare({plan:{one_time:true},visits:[{contacted_on:'2026-09-02'}]});
 await f.bind('care_plan',a.plan.id,{enabled:false});await f.bind('care_plan',inactive.plan.id);await f.bind('care_plan',done.plan.id);
 assert.deepEqual(await f.sourceRows(),[]);
 await f.makeCare({plan:{one_time:true},visits:[{contacted_on:'2026-09-02'}]});
 assert.equal((await f.rpc('admin','get_care_reminder_readiness')).counts.unbound_care,0);
 assert.equal((await f.rows('select count(*)::int n from public.care_visits'))[0].n,2);
});

test('guest owner must match the authoritative task; later reassignment suppresses old routing until explicit rebind',async t=>{
 const f=await setup(t),r=await f.reg(),task=await f.taskFor(r.id);
 await denied(()=>f.bind('guest_task',task.id,{owner_user_id:ids.editor}),'40001','CARE_REMINDER_OWNER_CHANGED');
 const a=await f.bind('guest_task',task.id);assert.equal((await f.sourceRows())[0].owner_user_id,null);
 await f.rpc('admin','update_intake_task',[task.id,task.version,{assigned_staff_user_id:ids.editor}]);
 assert.deepEqual(await f.sourceRows(),[]);assert.equal((await f.rpc('admin','get_care_reminder_readiness')).counts.owner_changed,1);
 const b=await f.bind('guest_task',task.id);assert.equal(b.cycle_id,a.cycle_id);assert.equal((await f.sourceRows())[0].owner_user_id,ids.editor);
});

test('removed/restored guest requires a reviewed new lifecycle and explicit cycle restart, never old receipt reactivation',async t=>{
 const f=await setup(t),r=await f.reg(),task=await f.taskFor(r.id),request_id=randomUUID();
 const a=await f.bind('guest_task',task.id,{request_id});await f.change(r.id);assert.deepEqual(await f.sourceRows(),[]);
 await f.change(r.id,false);assert.deepEqual(await f.sourceRows(),[]);
 await denied(()=>f.bind('guest_task',task.id),'40001','CARE_REMINDER_RESTART_REQUIRED');
 assert.deepEqual(await f.bind('guest_task',task.id,{request_id,version:0,source_version:task.version,lifecycle_version:1}),a);assert.deepEqual(await f.sourceRows(),[]);
 const restored=await f.bind('guest_task',task.id,{restart_cycle:true});assert.notEqual(restored.cycle_id,a.cycle_id);assert.equal((await f.sourceRows()).length,1);
});

test('linked one-time welcome is represented only by guest task; unrelated recurring or independent care remains',async t=>{
 const f=await setup(t),r=await f.reg();await f.rpc('admin','review_app_connection',[r.id,r.version,null,true,null,null]);
 const registration=await f.get(r.id),task=await f.taskFor(r.id),plan=(await f.rows("select * from public.care_assignments where contact_id=$1 and care_role='welcome'",[registration.contact_id]))[0];
 assert.ok(plan);await f.bind('care_plan',plan.id,{linked_guest_task_id:task.id});await f.bind('guest_task',task.id);
 assert.deepEqual((await f.sourceRows()).map(x=>x.source_type),['guest_task']);
 const independent=await f.makeCare({plan:{one_time:true,care_role:'welcome'}});await f.bind('care_plan',independent.plan.id);
 await denied(()=>f.bind('care_plan',independent.plan.id,{linked_guest_task_id:task.id}),'22023');
 assert.equal((await f.sourceRows()).length,2);assert.equal((await f.rpc('admin','get_care_reminder_readiness')).counts.linked_welcome_suppressed,1);
 // Emulate a future authoritative relink while preserving the existing source guards.
 await f.db.exec('alter table public.app_connections disable trigger user');
 await f.rows('update public.app_connections set contact_id=$1 where id=$2',[independent.person.id,r.id]);
 await f.db.exec('alter table public.app_connections enable trigger user');
 assert.ok((await f.sourceRows()).some(x=>x.source_id===plan.id));
 assert.equal((await f.rpc('admin','get_care_reminder_readiness')).counts.linked_source_changed,1);
});

test('source snapshot and configuration fail closed if singleton is missing; invalid dates are rejected',async t=>{
 const f=await setup(t);for(const value of [null,'infinity','-infinity'])await denied(()=>f.sourceRows(value),'22023');
 await f.rows('delete from private.care_reminder_settings');await denied(()=>f.sourceRows(),'55000');await denied(()=>f.rpc('admin','get_care_reminder_settings'),'55000');
 await denied(()=>f.rpc('admin','set_care_reminder_settings',[randomUUID(),1,false,[]]),'55000');
});

test('five thousand binding capacity is enforced before mutation; overflow snapshots refuse truncation',async t=>{
 const f=await setup(t),c=await f.makeCare();
 await f.rows("insert into private.care_reminder_bindings(source_type,source_id,approved_source_version,created_by,updated_by) select 'care_plan',gen_random_uuid(),1,$1,$1 from generate_series(1,5000)",[ids.admin]);
 assert.equal((await f.rpc('admin','get_care_reminder_settings')).bindings.length,5000);
 await denied(()=>f.bind('care_plan',c.plan.id),'54000');assert.equal((await f.rows('select count(*)::int n from private.care_reminder_config_receipts'))[0].n,0);
 await f.rows("insert into private.care_reminder_bindings(source_type,source_id,approved_source_version,created_by,updated_by) values('care_plan',gen_random_uuid(),1,$1,$1)",[ids.admin]);
 await denied(()=>f.sourceRows(),'54000');await denied(()=>f.rpc('admin','get_care_reminder_settings'),'54000');
});

test('new catalog is private RLS deny-all, empty search paths, invoker public API and no service grants',async t=>{
 const f=await setup(t),catalog=await f.rows("select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname in('care_reminder_settings','care_reminder_bindings','care_reminder_config_receipts')");
 assert.equal(catalog.length,3);for(const row of catalog)assert.equal(row.relrowsecurity,true);
 const functions=(await f.functionState()).filter(x=>x.proname.includes('care_reminder'));
 assert.equal(functions.length,10);for(const row of functions){assert.deepEqual(row.proconfig,['search_path=""']);if(row.nspname==='public')assert.equal(row.prosecdef,false);}
 for(const role of ['anon','service_role'])assert.equal((await f.rows("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private') and p.proname like '%care_reminder%' and has_function_privilege($1,p.oid,'EXECUTE')",[role]))[0].n,0);
 assert.deepEqual(await f.rows('select * from pg_policies order by schemaname,tablename,policyname'),f.oldPolicies);
});

test('migration and configuration preserve every preexisting function, policy, staff/account and intake outbox',async t=>{
 const f=await setup(t),current=await f.functionState();for(const row of f.oldFunctions)assert.deepEqual(current.find(x=>x.nspname===row.nspname&&x.proname===row.proname&&x.args===row.args),row);
 const r=await f.reg(),c=await f.makeCare(),capture=async()=>({roles:await f.rows('select * from public.staff_roles order by user_id'),auth:await f.rows('select * from auth.users order by id'),people:await f.rows('select * from public.contacts order by id'),care:await f.rows('select * from public.care_assignments order by id'),tasks:await f.rows('select * from public.app_submission_tasks order by id'),welcome:await f.rows('select * from private.app_welcome_outbox order by id'),notices:await f.rows('select * from private.app_staff_notice_outbox order by id')});
 const before=await capture();await f.configure();await f.bind('care_plan',c.plan.id);await f.bind('guest_task',(await f.taskFor(r.id)).id);await f.sourceRows();assert.deepEqual(await capture(),before);
});
