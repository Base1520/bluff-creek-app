import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const { dueFor, today, addMonths, coverageFor } = require('../care.js');
const source = await readFile(new URL('../care.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function unloadBlocked(f) { const event=new f.w.Event('beforeunload',{cancelable:true}); f.w.dispatchEvent(event); return event.defaultPrevented; }
const assignment = { version:1, id:'plan-synthetic', contact_id:'person-synthetic', started_on:'2026-03-01', cadence_days:28, paused:false };
const visit = (day, outcome='contacted', next=null) => ({ id:'visit-'+day, contact_id:assignment.contact_id, contacted_on:day, outcome, next_contact_on:next, created_at:day+'T12:00:00Z', visitor_name:'Test team', method:'call' });

test('care dates use Central and date arithmetic crosses DST without shifting a day', () => {
  assert.equal(today(new Date('2026-09-14T04:59:59Z')), '2026-09-13');
  assert.equal(today(new Date('2026-09-14T05:00:00Z')), '2026-09-14');
  const due = dueFor(assignment, [], '2026-03-29');
  assert.equal(due.due, '2026-03-29'); assert.equal(due.state, 'due'); assert.equal(due.neverContacted, true);
});
test('attempts do not reset contact cadence; latest explicit date wins and paused plans leave reminders', () => {
  const records = [visit('2026-03-02'), visit('2026-03-20','attempted')];
  assert.equal(dueFor(assignment, records, '2026-04-02').due, '2026-03-30');
  assert.equal(dueFor(assignment, records, '2026-04-02').daysOverdue, 3);
  records.push(visit('2026-03-21','attempted','2026-04-10'));
  assert.equal(dueFor(assignment, records, '2026-04-02').due, '2026-04-10');
  assert.equal(dueFor({...assignment,paused:true}, records, '2026-04-20').state, 'paused');
  records.push(visit('2026-04-01'));
  assert.equal(dueFor(assignment, records, '2026-04-02').due, '2026-04-29', 'a later contact replaces an older explicit date');
});

test('blank-date attempts preserve the chosen retry date until a replacement date or successful contact establishes a new schedule', () => {
  const plan = {...assignment,care_role:'deacon',started_on:'2026-09-01',cadence_months:3};
  const records = [visit('2026-09-01','contacted','2026-09-10'),visit('2026-09-08','attempted'),visit('2026-09-09','attempted')];
  const kept = dueFor(plan, records, '2026-09-10');
  assert.equal(kept.due,'2026-09-10'); assert.equal(kept.state,'due'); assert.equal(kept.explicit,true);
  assert.equal(kept.lastContact,'2026-09-01');
  records.push(visit('2026-09-10','attempted','2026-09-12'),visit('2026-09-11','attempted'));
  assert.equal(dueFor(plan,records,'2026-09-12').due,'2026-09-12','a date chosen on an attempt also survives another unsuccessful attempt');
  records.push(visit('2026-09-12','contacted'),visit('2026-09-13','attempted'));
  const reset = dueFor(plan, records, '2026-09-14');
  assert.equal(reset.due,'2026-12-12'); assert.equal(reset.explicit,false); assert.equal(reset.lastContact,'2026-09-12');
  assert.equal(dueFor(plan,records.slice().reverse(),'2026-09-14').due,'2026-12-12','backfilled arrival order cannot revive a historical override');
});

test('preserving retry dates still respects person/role isolation, future records and a one-time plan restart', () => {
  const plan = {...assignment,care_role:'welcome',started_on:'2026-09-04',first_due_on:'2026-09-05',one_time:true};
  const records = [
    {...visit('2026-09-03','attempted','2026-09-10'),care_role:'welcome'},
    {...visit('2026-09-06','attempted'),care_role:'welcome'},
    {...visit('2026-09-07','attempted','2026-10-01'),care_role:'deacon'},
    {...visit('2026-09-07','attempted','2026-10-02'),care_role:'welcome',contact_id:'another-synthetic-person'},
    {...visit('2026-09-15','attempted','2026-10-03'),care_role:'welcome'},
  ];
  const restarted = dueFor(plan,records,'2026-09-08');
  assert.equal(restarted.due,'2026-09-05'); assert.equal(restarted.explicit,false); assert.equal(restarted.state,'overdue');
  records.push({...visit('2026-09-07','attempted','2026-09-09'),care_role:'welcome'},{...visit('2026-09-08','attempted'),care_role:'welcome'});
  assert.equal(dueFor(plan,records,'2026-09-09').due,'2026-09-09');
  records.push({...visit('2026-09-09','contacted'),care_role:'welcome'});
  const completed = dueFor(plan,records,'2026-09-10');
  assert.equal(completed.state,'completed'); assert.equal(completed.due,null);
});

function fixture(t, opts={}) {
  const dom = new JSDOM('<section id="care-view"></section>', {url:'https://office.example.invalid/admin/',runScripts:'outside-only'}), w=dom.window;
  t.after(()=>w.close()); w.confirm=()=>true; w.eval(source);
  const host=w.document.querySelector('#care-view'), calls=[], notices=[], summaries=[];
  let ctx={epoch:1,userId:'synthetic-user',canEdit:true,workspaceReady:true,role:opts.role||'editor'}, module, refreshes=0;
  const people=opts.people||[{id:'person-synthetic',first_name:'Sample',last_name:'Person',household_name:'Test household',status:'active'}];
  const rows={care_assignments:(opts.assignments||[]).map(row=>({version:1,...row})),care_visits:opts.visits||[],guest_intakes:(opts.guests||[]).map(row=>({version:1,...row})),care_guidelines:opts.guidelines?{version:1,...opts.guidelines}:null};
  const controller={hold:null,error:null,emptySave:false,ready:true,peopleReady:true,ensureReady:null,respond:null}, checks=[];
  function execute(query) {
    const all=query.table==='care_guidelines'?(rows[query.table]?[rows[query.table]]:[]):rows[query.table];
    const matching=all.filter(row=>Object.entries(query.filters||{}).every(([key,value])=>row[key]===value));
    if(query.op==='select')return{data:query.range?matching.slice(query.range[0],query.range[1]+1):query.single?matching[0]||null:matching,count:matching.length,error:null};
    if(controller.emptySave)return{data:null,error:null};
    let record;
    if(query.op==='insert') {
      if(all.some(row=>row.id===query.data.id || query.table==='care_assignments'&&row.contact_id===query.data.contact_id&&(row.care_role||'deacon')===query.data.care_role || query.table==='guest_intakes'&&row.contact_id===query.data.contact_id))return{error:{code:'23505'}};
      record={...query.data,created_by:ctx.userId,created_at:new Date().toISOString()};
      if(query.table!=='care_visits')Object.assign(record,{version:1,updated_at:new Date().toISOString()});
      if(query.table==='care_guidelines')rows[query.table]=record;else rows[query.table].push(record);
    } else if(query.op==='update') {
      const old=matching[0];if(!old)return{data:null,error:null};
      record={...old,...query.data,version:old.version+1,updated_at:new Date().toISOString()};
      if(query.table==='care_guidelines')rows[query.table]=record;else rows[query.table][rows[query.table].indexOf(old)]=record;
    }
    return{data:record,error:null};
  }
  const db={from(table){
    const query={table,op:'select',filters:{}};
    const chain={select(fields,settings){query.fields=fields;query.selectOptions=settings;return chain;},single(){query.single=true;return chain;},order(){return chain;},range(a,b){query.range=[a,b];return chain;},eq(key,value){query.filters[key]=value;return chain;},maybeSingle(){query.single=true;return chain;},insert(data){query.op='insert';query.data={...data};return chain;},update(data){query.op='update';query.data={...data};return chain;},then(resolve,reject){
      calls.push(query);
      if(controller.hold)return controller.hold(query).then(resolve,reject);
      if(controller.error)return Promise.resolve({error:typeof controller.error==='string'?{message:controller.error}:controller.error}).then(resolve,reject);
      const result=controller.respond?controller.respond(query,()=>execute(query)):execute(query);
      return Promise.resolve(result).then(resolve,reject);
    }}; if(opts.noRange)delete chain.range;return chain;
  }};
  module=w.CreekCare.create({root:host,db,requestTimeoutMs:opts.requestTimeoutMs,getContext:()=>ctx,isCurrent:epoch=>!!ctx.userId&&ctx.epoch===epoch,ensureReady:async epoch=>{checks.push(epoch);return controller.ensureReady?controller.ensureReady(epoch):controller.ready;},people:()=>people,peopleReady:()=>controller.peopleReady,notice:(text,bad)=>notices.push({text,bad}),onSummary:opts.omitSummary?undefined:value=>summaries.push(value===null?null:JSON.parse(JSON.stringify(value))),refresh:async()=>{refreshes++;await module.load(ctx.epoch);}});
  const click=selector=>host.querySelector(selector).click();
  function set(name,value) { const el=host.querySelector('[name="'+name+'"]'); if(el.type==='checkbox')el.checked=value;else el.value=value;return el; }
  function submit() {host.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));}
  return {w,host,module,calls,notices,summaries,rows,controller,checks,execute,click,set,submit,ctx,setContext:value=>ctx=value,refreshes:()=>refreshes};
}
test('overview care totals use all authorized people and distinguish due, completed, paused and coverage needs', async t => {
  const date=today(), later=addMonths(date,1), previous=addMonths(date,-1);
  const people=[{id:'person-synthetic',display_name:'First fixture private name',status:'active'},{id:'person-other',display_name:'Other fixture private name',status:'active'},{id:'person-visitor',display_name:'Visitor fixture',status:'visitor'}];
  const f=fixture(t,{people,assignments:[
    {...assignment,care_role:'deacon',cadence_months:3,first_due_on:date,assigned_to:'First team'},
    {...assignment,id:'monthly-plan',care_role:'sunday_school',cadence_months:1,first_due_on:previous,assigned_to:'   '},
    {...assignment,id:'welcome-plan',care_role:'welcome',one_time:true,started_on:date,first_due_on:date},
    {...assignment,id:'paused-plan',care_role:'pastoral',paused:true,first_due_on:previous},
    {...assignment,id:'other-plan',contact_id:'person-other',care_role:'deacon',cadence_months:3,first_due_on:later,assigned_to:'Other team'},
    {...assignment,id:'visitor-plan',contact_id:'person-visitor',care_role:'custom',first_due_on:later,notes:'Private fixture note'},
    {...assignment,id:'orphan-plan',contact_id:'person-no-longer-loaded',care_role:'deacon',first_due_on:previous}
  ],visits:[{...visit(date),id:'welcome-fixture-contact',care_role:'welcome'}, {...visit(date,'attempted'),id:'school-fixture-attempt',care_role:'sunday_school'}, {...visit(later),care_role:'deacon'}]});
  await f.module.load(1);
  assert.equal(f.summaries[0],null);
  const total={duePlans:2,overduePlans:1,unassignedPlans:2,coverageGaps:2};assert.deepEqual(f.summaries.at(-1),total);
  const initialEmissions=f.summaries.length;
  const filter=(selector,value,event='change')=>{const node=f.host.querySelector(selector);node.value=value;node.dispatchEvent(new f.w.Event(event,{bubbles:true}));};
  filter('[data-care-search]','nobody matches','input');filter('[data-care-deacon]','First team');filter('[data-care-role-filter]','custom');filter('[data-care-plan-status]','unassigned');
  assert.equal(f.host.querySelectorAll('[data-care-list="assignments"] .care-row').length,0);
  f.module.render();assert.equal(f.summaries.length,initialEmissions);assert.deepEqual(f.summaries.at(-1),total);
  assert.equal(f.module.selectPerson('person-synthetic'),true);assert.equal(f.host.querySelector('[data-care-plan-status]').value,'');assert.deepEqual(f.summaries.at(-1),total);
  assert.equal(f.module.openQueue('due'),true);assert.equal(f.host.querySelectorAll('[data-care-list="assignments"] .care-row').length,2);assert.equal(f.host.querySelector('[data-care-plan-status]').value,'due');
  assert.equal(f.host.querySelector('[data-care-plan-status-label]').hidden,false);assert.equal(f.host.querySelector('.care-person-selection').hidden,true);
  assert.equal(f.module.openQueue('unassigned'),true);assert.equal(f.host.querySelectorAll('[data-care-list="assignments"] .care-row').length,2);assert.equal(f.host.querySelectorAll('[data-care-list="paused"] .care-row').length,0);
  assert.equal(f.module.openQueue('coverage'),true);assert.equal(f.host.querySelector('[data-care-panel="coverage"]').hidden,false);assert.equal(f.host.querySelectorAll('[data-care-list="coverage"] .care-row').length,2);assert.equal(f.host.querySelector('[data-care-plan-status-label]').hidden,true);
  assert.equal(f.host.querySelector('[data-care-plan-status]').value,'');assert.deepEqual(f.summaries.at(-1),total);
  assert.doesNotMatch(JSON.stringify(f.summaries),/private name|Private fixture note|First team|person-synthetic/);
  people.splice(0,1);f.module.render();assert.deepEqual(f.summaries.at(-1),{duePlans:0,overduePlans:0,unassignedPlans:1,coverageGaps:1});
});
test('overview summaries become unavailable on refresh, error and auth loss without stale or false-zero updates', async t => {
  const f=fixture(t,{assignments:[assignment]});await f.module.load(1);assert.equal(f.summaries.at(-1).duePlans,1);
  const pending=[];f.controller.hold=()=>new Promise(resolve=>pending.push(resolve));const old=f.module.load(1);await tick();
  assert.equal(f.summaries.at(-1),null);assert.equal(f.module.openQueue('due'),false);
  f.controller.hold=null;f.rows.care_assignments=[];await f.module.load(1);const current={duePlans:0,overduePlans:0,unassignedPlans:0,coverageGaps:2};assert.deepEqual(f.summaries.at(-1),current);
  pending.forEach(resolve=>resolve({data:[assignment],error:null}));await old;assert.deepEqual(f.summaries.at(-1),current);
  f.controller.error='Synthetic failed refresh';assert.equal(await f.module.load(1),false);assert.equal(f.summaries.at(-1),null);assert.equal(f.module.openQueue('coverage'),false);
  f.controller.error=null;await f.module.load(1);assert.deepEqual(f.summaries.at(-1),current);
  f.controller.peopleReady=false;f.module.render();assert.equal(f.summaries.at(-1),null);assert.equal(f.module.openQueue('due'),false);
  f.controller.peopleReady=true;f.module.render();assert.deepEqual(f.summaries.at(-1),current);
  f.setContext({...f.ctx,workspaceReady:false});f.module.render();assert.equal(f.summaries.at(-1),null);assert.equal(f.module.openQueue('unassigned'),false);
  f.setContext({...f.ctx});f.module.render();assert.deepEqual(f.summaries.at(-1),current);
  f.setContext({...f.ctx,role:'viewer',canEdit:false});f.module.render();assert.equal(f.summaries.at(-1),null);assert.equal(f.host.textContent,'');
  const v=fixture(t,{role:'viewer'});assert.equal(await v.module.load(1),false);assert.deepEqual(v.summaries,[null]);
  const optional=fixture(t,{omitSummary:true});assert.equal(await optional.module.load(1),true);optional.module.clear();assert.equal(optional.host.textContent,'');
});
test('late summaries cannot return after clear or a changed session and queues reject stale entry points', async t => {
  const f=fixture(t,{assignments:[assignment]});assert.equal(f.module.openQueue('due'),false);await f.module.load(1);
  const pending=[];f.controller.hold=()=>new Promise(resolve=>pending.push(resolve));const old=f.module.load(1);await tick();
  f.setContext({epoch:2,userId:'other-fixture',canEdit:true,workspaceReady:true,role:'editor'});f.module.clear();
  const count=f.summaries.length;pending.forEach(resolve=>resolve({data:[assignment],error:null}));await old;
  assert.equal(f.summaries.length,count);assert.equal(f.summaries.at(-1),null);assert.equal(f.module.openQueue('due'),false);
  f.controller.hold=null;await f.module.load(2);assert.equal(f.module.openQueue('due'),true);
  f.module.clear();assert.equal(f.summaries.at(-1),null);assert.equal(f.host.textContent,'');
});
test('overview queue navigation resets all filters and respects unsaved care edits and post-confirmation session checks', async t => {
  const f=fixture(t,{assignments:[{...assignment,assigned_to:'Fixture team'}]});await f.module.load(1);f.module.selectPerson('person-synthetic');
  const filter=(selector,value,event='change')=>{const node=f.host.querySelector(selector);node.value=value;node.dispatchEvent(new f.w.Event(event,{bubbles:true}));};
  filter('[data-care-search]','Sample','input');filter('[data-care-deacon]','Fixture team');filter('[data-care-role-filter]','deacon');
  f.click('[data-care-action="assignment"]');f.set('notes','Unsaved fixture draft');let prompts=0;f.w.confirm=()=>{prompts++;return false;};
  for(const kind of ['unknown','',null,undefined,{},1])assert.equal(f.module.openQueue(kind),false);assert.equal(prompts,0);
  assert.equal(f.module.openQueue('unassigned'),false);assert.equal(prompts,1);assert.equal(f.host.querySelector('[name="notes"]').value,'Unsaved fixture draft');assert.equal(f.host.querySelector('[data-care-search]').value,'Sample');
  f.w.confirm=()=>true;assert.equal(f.module.openQueue('due'),true);assert.equal(f.host.querySelector('[data-care-form]'),null);
  for(const selector of ['[data-care-search]','[data-care-deacon]','[data-care-role-filter]'])assert.equal(f.host.querySelector(selector).value,'');
  assert.equal(f.host.querySelector('.care-person-selection').hidden,true);assert.equal(f.host.querySelector('[data-care-plan-status]').value,'due');
  f.click('[data-care-action="assignment"]');f.set('notes','Retain after changed session');f.w.confirm=()=>{f.setContext({...f.ctx,epoch:2,userId:'another-fixture'});return true;};
  assert.equal(f.module.openQueue('coverage'),false);assert.equal(f.host.querySelector('[name="notes"]').value,'Retain after changed session');
  f.module.render();assert.equal(f.summaries.at(-1),null);assert.equal(f.host.querySelector('[data-care-form]'),null);
});
test('overview queues preserve a saving or uncertain care draft until its result is reconciled', async t => {
  const f=fixture(t);await f.module.load(1);f.click('[data-care-action="guest"]');f.set('contact_id','person-synthetic');f.set('notes','Keep uncertain fixture draft');
  let finish;f.controller.hold=()=>new Promise(resolve=>finish=resolve);f.submit();await tick();
  let prompts=0;f.w.confirm=()=>{prompts++;return true;};assert.equal(f.module.openQueue('due'),false);assert.equal(prompts,0);
  finish({data:null,error:null});await tick();assert.equal(f.module.openQueue('coverage'),false);assert.equal(prompts,0);assert.equal(f.host.querySelector('[name="notes"]').value,'Keep uncertain fixture draft');
  f.controller.hold=null;await f.module.load(1);assert.equal(f.module.openQueue('unassigned'),true);assert.equal(prompts,1);assert.equal(f.host.querySelector('[data-care-form]'),null);
});
test('viewer fails closed and clear removes notes, form values, filters, and late responses', async t => {
  const v=fixture(t,{role:'viewer'});assert.equal(await v.module.load(1),false);v.module.render();assert.equal(v.calls.length,0);assert.equal(v.host.textContent,'');
  const f=fixture(t,{assignments:[{...assignment,notes:'Synthetic private planning note'}]});await f.module.load(1);
  f.click('[data-care-action="visit"]');f.set('notes','Synthetic unsaved note');
  const pending=[];f.controller.hold=()=>new Promise(resolve=>pending.push(resolve));const response=f.module.load(1);await tick();
  f.setContext({epoch:2,userId:null,canEdit:false,role:null});f.module.clear();
  assert.equal(f.host.textContent,'');assert.equal(f.host.querySelectorAll('input,textarea').length,0);
  pending.forEach(resolve=>resolve({data:[],error:null}));await response;assert.equal(f.host.textContent,'');assert.equal(f.notices.length,0);
});
test('periodic render preserves draft entries and new selection loads the existing plan', async t => {
  const f=fixture(t,{assignments:[{...assignment,assigned_to:'Test team',cadence_days:14,notes:'Existing synthetic plan'}]});await f.module.load(1);
  f.click('[data-care-panel="followup"]>.care-section-head [data-care-action="assignment"]');
  const person=f.set('contact_id','person-synthetic');person.dispatchEvent(new f.w.Event('change',{bubbles:true}));
  assert.equal(f.host.querySelector('[name="cadence_value"]').value,'14');assert.equal(f.host.querySelector('[name="contact_id"]').disabled,true);
  f.set('notes','Synthetic draft');f.module.render();assert.equal(f.host.querySelector('[name="notes"]').value,'Synthetic draft');
});
test('assignment write uses exact allowlisted fields and supplied cadence; notes render as text', async t => {
  const f=fixture(t);await f.module.load(1);f.click('[data-care-action="assignment"]');
  assert.equal(f.host.querySelector('[name="cadence_value"]').value,'3');assert.equal(f.host.querySelector('[name="cadence_unit"]').value,'months');
  f.set('contact_id','person-synthetic');f.set('cadence_unit','days').dispatchEvent(new f.w.Event('change',{bubbles:true}));f.set('cadence_value','21');f.set('assigned_to','Test team');f.set('paused',true);f.set('notes','<img src=x onerror=alert(1)>');f.submit();await tick();await tick();
  const write=f.calls.find(q=>q.op==='insert');assert.equal(write.table,'care_assignments');assert.equal(write.data.cadence_days,21);assert.equal(write.data.paused,true);
  assert.deepEqual(Object.keys(write.data).sort(),['assigned_to','cadence_days','cadence_months','care_role','contact_id','first_due_on','id','notes','one_time','paused','started_on']);assert.match(write.data.id,/^[0-9a-f-]{36}$/);assert.equal(write.data.care_role,'deacon');assert.equal(write.fields,'*');assert.equal(write.single,true);assert.equal(f.refreshes(),1);
  f.rows.care_assignments=[{...assignment,notes:write.data.notes}];await f.module.load(1);assert.equal(f.host.querySelector('img'),null);assert.match(f.host.textContent,/<img src=x/);
});
test('visits append outcomes and next dates without audit fields; stale save cannot repaint another account', async t => {
  const f=fixture(t);await f.module.load(1);f.click('[data-care-action="visit"]');f.set('contact_id','person-synthetic');f.set('visitor_name','Test team');f.set('contacted_on','2026-03-20');f.set('outcome','attempted');f.set('next_contact_on','2026-03-25');
  let finish;f.controller.hold=()=>new Promise(resolve=>finish=resolve);f.submit();await tick();
  const write=f.calls.find(q=>q.op==='insert');assert.equal(write.table,'care_visits');assert.equal(write.data.outcome,'attempted');assert.equal(write.data.next_contact_on,'2026-03-25');assert.equal('updated_by' in write.data,false);
  f.setContext({epoch:2,userId:'other-test-user',canEdit:true,role:'editor'});f.module.clear();finish({error:null});await tick();
  assert.equal(f.host.textContent,'');assert.equal(f.refreshes(),0);assert.equal(f.notices.length,0);
});
test('paused plans are separate and shared deacon/search filters apply', async t => {
  const f=fixture(t,{assignments:[{...assignment,assigned_to:'Test team',paused:true}]});await f.module.load(1);
  assert.equal(f.host.querySelector('[data-care-list="assignments"] .care-row'),null);assert.equal(f.host.querySelectorAll('[data-care-list="paused"] .care-row').length,1);
  const filter=f.host.querySelector('[data-care-deacon]');filter.value='__unassigned';filter.dispatchEvent(new f.w.Event('change',{bubbles:true}));
  assert.equal(f.host.querySelector('[data-care-list="paused"] .care-row'),null);
});
test('People entry isolates an exact person across follow-up, coverage, guests and visitation', async t => {
  const people=[{id:'person-synthetic',display_name:'Sample Person',household_name:'Shared household',status:'active'}, {id:'person-other',display_name:'Sample Person',household_name:'Shared household',status:'active'}];
  const f=fixture(t,{people,assignments:[{...assignment,assigned_to:'First team',notes:'First person plan'}, {...assignment,id:'other-plan',contact_id:'person-other',assigned_to:'Other team',notes:'Other person plan'}],visits:[{...visit('2026-03-02'),notes:'First person contact'}, {...visit('2026-03-03'),contact_id:'person-other',notes:'Other person contact'}],guests:[{id:'guest-first',contact_id:'person-synthetic',status:'new',notes:'First person guest'}, {id:'guest-other',contact_id:'person-other',status:'new',notes:'Other person guest'}]});
  await f.module.load(1);
  const search=f.host.querySelector('[data-care-search]');search.value='no match';search.dispatchEvent(new f.w.Event('input',{bubbles:true}));
  const owner=f.host.querySelector('[data-care-deacon]');owner.value='Other team';owner.dispatchEvent(new f.w.Event('change',{bubbles:true}));
  const role=f.host.querySelector('[data-care-role-filter]');role.value='welcome';role.dispatchEvent(new f.w.Event('change',{bubbles:true}));
  f.click('[data-care-view="visitation"]');
  assert.equal(f.module.selectPerson('person-synthetic'),true);
  assert.equal(f.host.querySelector('[data-care-panel="followup"]').hidden,false);
  assert.equal(search.value,'');assert.equal(owner.value,'');assert.equal(role.value,'');
  assert.match(f.host.querySelector('[data-care-person-label]').textContent,/Showing care for Sample Person/);
  assert.equal(f.host.querySelector('.care-person-selection').hidden,false);
  for(const list of ['assignments','coverage','guests','visits'])assert.equal(f.host.querySelectorAll('[data-care-list="'+list+'"] .care-row').length,1,list);
  assert.match(f.host.textContent,/First person plan/);assert.match(f.host.textContent,/First person contact/);assert.match(f.host.textContent,/First person guest/);
  assert.doesNotMatch(f.host.textContent,/Other person|Other team/);
  f.click('[data-care-view="coverage"]');assert.equal(f.host.querySelector('[data-care-panel="coverage"]').hidden,false);
  assert.deepEqual([...f.host.querySelectorAll('[data-care-list="coverage"] [data-contact]')].map(el=>el.dataset.contact),['person-synthetic']);
  f.click('[data-care-view="guests"]');f.click('[data-care-panel="guests"] .care-section-head [data-care-action="guest"]');
  assert.equal(f.host.querySelector('[name="contact_id"]').value,'person-synthetic');assert.equal(f.host.querySelector('[name="notes"]').value,'First person guest');
  f.click('[data-care-action="cancel"]');f.click('[data-care-action="clear-person"]');
  assert.equal(f.host.querySelector('.care-person-selection').hidden,true);
  for(const list of ['assignments','coverage','guests','visits'])assert.equal(f.host.querySelectorAll('[data-care-list="'+list+'"] .care-row').length,2,list+' after clearing');
});
test('person selection persists through refresh and preselects new plans and contacts', async t => {
  const f=fixture(t,{people:[{id:'person-synthetic',display_name:'First fixture'},{id:'person-other',display_name:'Other fixture'}]});await f.module.load(1);assert.equal(f.module.selectPerson('person-synthetic'),true);
  f.click('[data-care-panel="followup"] .care-section-head [data-care-action="assignment"]');
  assert.equal(f.host.querySelector('[name="contact_id"]').value,'person-synthetic');
  f.set('notes','Retained person draft');assert.equal(f.module.selectPerson('person-synthetic'),true);
  assert.equal(f.host.querySelector('[name="notes"]').value,'Retained person draft');
  f.click('[data-care-action="cancel"]');f.rows.care_assignments.push({...assignment,version:1,notes:'Newly loaded plan'});await f.module.load(1);
  assert.equal(f.host.querySelector('.care-person-selection').hidden,false);assert.match(f.host.textContent,/Newly loaded plan/);
  f.click('[data-care-panel="visitation"] .care-section-head [data-care-action="visit"]');
  assert.equal(f.host.querySelector('[name="contact_id"]').value,'person-synthetic');
  f.set('contact_id','person-other');f.set('notes','Draft for another person');f.w.confirm=()=>false;
  assert.equal(f.module.selectPerson('person-synthetic'),false);assert.equal(f.host.querySelector('[name="contact_id"]').value,'person-other');
  f.w.confirm=()=>true;assert.equal(f.module.selectPerson('person-synthetic'),true);assert.equal(f.host.querySelector('[data-care-form]'),null);
});
test('unknown, stale and revoked People entries cannot replace the selected person', async t => {
  const f=fixture(t,{people:[{id:'person-synthetic',display_name:'First fixture'},{id:'person-other',display_name:'Other fixture'}]});
  assert.equal(f.module.selectPerson('person-synthetic'),false);assert.equal(f.host.textContent,'');
  await f.module.load(1);assert.equal(f.module.selectPerson('person-synthetic'),true);
  let prompts=0;f.w.confirm=()=>{prompts++;return true;};f.click('[data-care-action="assignment"]');f.set('notes','Keep draft');
  for(const id of ['unknown-person','First fixture','',null,undefined,{},1])assert.equal(f.module.selectPerson(id),false);
  assert.equal(prompts,0);assert.equal(f.host.querySelector('[name="notes"]').value,'Keep draft');
  const original={...f.ctx};
  for(const next of [{...original,role:'viewer',canEdit:false},{...original,userId:null},{...original,epoch:2},{...original,userId:'other-user'},{...original,workspaceReady:false}]) {
    f.setContext(next);assert.equal(f.module.selectPerson('person-other'),false);assert.match(f.host.querySelector('[data-care-person-label]').textContent,/First fixture/);
  }
  f.setContext(original);assert.equal(prompts,0);assert.equal(f.calls.some(call=>call.op!=='select'),false);
  f.module.clear();assert.equal(f.host.textContent,'');await f.module.load(1);
  assert.equal(f.host.querySelector('.care-person-selection').hidden,true);assert.equal(f.host.querySelector('[data-care-person-label]').textContent,'');
});
test('changing or clearing the selected person honors unsaved draft confirmation', async t => {
  const f=fixture(t,{people:[{id:'person-synthetic',display_name:'First fixture'},{id:'person-other',display_name:'Other fixture'}]});await f.module.load(1);f.module.selectPerson('person-synthetic');
  f.click('[data-care-action="assignment"]');f.set('notes','Unsaved first person plan');
  const prompts=[];f.w.confirm=message=>{prompts.push(message);return false;};
  assert.equal(f.module.selectPerson('person-other'),false);f.click('[data-care-action="clear-person"]');
  assert.equal(prompts.length,2);assert.ok(prompts.every(message=>message==='Discard your unsaved care changes?'));
  assert.equal(f.host.querySelector('[name="notes"]').value,'Unsaved first person plan');assert.match(f.host.querySelector('[data-care-person-label]').textContent,/First fixture/);
  f.w.confirm=()=>true;assert.equal(f.module.selectPerson('person-other'),true);assert.equal(f.host.querySelector('[data-care-form]'),null);
  assert.match(f.host.querySelector('[data-care-person-label]').textContent,/Other fixture/);
  f.click('[data-care-action="assignment"]');f.set('notes','Unsaved other person plan');f.click('[data-care-action="clear-person"]');
  assert.equal(f.host.querySelector('[data-care-form]'),null);assert.equal(f.host.querySelector('.care-person-selection').hidden,true);
});
test('person selection rechecks the session after confirmation and auth cleanup forgets it', async t => {
  const f=fixture(t,{people:[{id:'person-synthetic',display_name:'First fixture'},{id:'person-other',display_name:'Other fixture'}]});await f.module.load(1);f.module.selectPerson('person-synthetic');
  f.click('[data-care-action="assignment"]');f.set('notes','Unsent fixture note');
  f.w.confirm=()=>{f.setContext({epoch:2,userId:'new-fixture-user',canEdit:true,workspaceReady:true,role:'editor'});return true;};
  assert.equal(f.module.selectPerson('person-other'),false);assert.match(f.host.querySelector('[data-care-person-label]').textContent,/First fixture/);
  f.module.render();assert.doesNotMatch(f.host.textContent,/First fixture|Other fixture|Unsent fixture note/);
  assert.equal(f.host.querySelector('.care-person-selection').hidden,true);assert.equal(f.module.selectPerson('person-other'),false);
  await f.module.load(2);assert.equal(f.host.querySelector('.care-person-selection').hidden,true);assert.equal(f.module.selectPerson('person-other'),true);
  f.setContext({epoch:3,userId:null,canEdit:false,role:null});f.module.render();assert.equal(f.host.textContent,'');
});
test('a removed person never broadens the exact selection or exposes orphaned care rows', async t => {
  const people=[{id:'person-synthetic',display_name:'Removed fixture',status:'active'},{id:'person-other',display_name:'Remaining fixture',status:'active'}];
  const f=fixture(t,{people,assignments:[{...assignment,assigned_to:'Removed team',notes:'Removed fixture planning note'},{...assignment,id:'other-plan',contact_id:'person-other',assigned_to:'Remaining team'}],visits:[{...visit('2026-03-02'),notes:'Removed fixture contact'}],guests:[{id:'guest-first',contact_id:'person-synthetic',status:'new',notes:'Removed fixture guest'}]});
  await f.module.load(1);f.module.selectPerson('person-synthetic');people.splice(0,1);f.module.render();
  assert.match(f.host.querySelector('[data-care-person-label]').textContent,/Person unavailable/);
  assert.doesNotMatch(f.host.textContent,/Removed fixture|Removed team|Remaining fixture|Remaining team/);
  for(const list of ['assignments','coverage','guests','visits'])assert.equal(f.host.querySelectorAll('[data-care-list="'+list+'"] .care-row').length,0,list);
  assert.equal(f.module.selectPerson('person-synthetic'),false);f.click('[data-care-action="clear-person"]');
  assert.match(f.host.textContent,/Remaining fixture/);assert.doesNotMatch(f.host.textContent,/Removed fixture|Removed team/);
});
test('editors read guidelines; only admins can save the default record and empty guidance stays proposed', async t => {
  const e=fixture(t,{guidelines:{id:'default',body:'Synthetic agreed guidance',updated_at:'2026-03-01T12:00:00Z'}});await e.module.load(1);
  assert.match(e.host.textContent,/Synthetic agreed guidance/);assert.equal(e.host.querySelector('[data-care-action="guidelines"]'),null);
  const a=fixture(t,{role:'admin'});await a.module.load(1);assert.match(a.host.textContent,/Proposed starting guidance/);a.click('[data-care-action="guidelines"]');a.set('body','Synthetic approved guidance');a.submit();await tick();await tick();
  const write=a.calls.find(q=>q.op==='insert');assert.equal(write.table,'care_guidelines');assert.equal(write.data.id,'default');assert.equal(write.fields,'*');
});
test('private database errors stay out of the UI and failed saves preserve entries', async t => {
  const f=fixture(t);await f.module.load(1);f.click('[data-care-action="guest"]');f.set('contact_id','person-synthetic');f.set('notes','Synthetic guest note');f.controller.error='PRIVATE_ERROR_CANARY';f.submit();await tick();
  assert.match(f.host.querySelector('.care-form-error').textContent,/could not be saved/);assert.equal(f.host.querySelector('[name="notes"]').value,'Synthetic guest note');assert.doesNotMatch(f.host.textContent,/PRIVATE_ERROR_CANARY/);
  await f.module.load(1);assert.equal(f.notices.some(n=>n.text.includes('PRIVATE_ERROR_CANARY')),false);
});
test('visit pagination retains a success beyond the first thousand rows', async t => {
  const attempts=Array.from({length:1000},(_,i)=>({...visit('2026-03-20','attempted'),id:'attempt-'+i}));
  const f=fixture(t,{assignments:[assignment],visits:[...attempts,visit('2026-03-02')]});await f.module.load(1);
  assert.equal(f.calls.filter(q=>q.table==='care_visits').length,2);
  assert.match(f.host.querySelector('[data-care-list="assignments"]').textContent,/Last successful contact · Mar 2, 2026/);
});


test('calendar months clamp month ends and leap days, keeping monthly and quarterly dates distinct', () => {
  assert.equal(addMonths('2024-01-31',1),'2024-02-29');
  assert.equal(addMonths('2025-01-31',1),'2025-02-28');
  assert.equal(addMonths('2024-02-29',12),'2025-02-28');
  assert.equal(addMonths('2026-11-30',3),'2027-02-28');
  const monthly={...assignment,care_role:'sunday_school',cadence_months:1,started_on:'2026-03-08'};
  assert.equal(dueFor(monthly,[],'2026-04-08').due,'2026-04-08');
  const quarterly={...assignment,care_role:'deacon',cadence_months:3,started_on:'2026-01-31'};
  assert.equal(dueFor(quarterly,[],'2026-04-30').due,'2026-04-30');
});

test('each role has its own success and retry dates; future records never reset current reminders', () => {
  const deacon={...assignment,care_role:'deacon',cadence_months:3};
  const teacher={...assignment,care_role:'sunday_school',cadence_months:1};
  const records=[visit('2026-03-02'),{...visit('2026-03-15'),care_role:'sunday_school'},
    {...visit('2026-03-25','attempted','2026-04-03'),care_role:'sunday_school'},
    {...visit('2026-12-01','contacted','2027-01-01'),care_role:'deacon'}];
  assert.equal(dueFor(deacon,records,'2026-04-01').due,'2026-06-02');
  assert.equal(dueFor(teacher,records,'2026-04-01').due,'2026-04-03');
  assert.equal(dueFor(teacher,records,'2026-04-01').lastContact,'2026-03-15');
  assert.equal(dueFor({...teacher,paused:true},records,'2026-04-10').state,'paused');
  assert.equal(dueFor(assignment,records,'2026-04-01').due,'2026-03-30','old records remain day-based deacon plans');
});

test('welcome completion requires a successful contact in that plan period and role', () => {
  const plan={...assignment,care_role:'welcome',one_time:true,first_due_on:'2026-03-03'};
  let records=[{...visit('2026-02-01'),care_role:'welcome'},visit('2026-03-02'),{...visit('2026-03-02','attempted'),care_role:'welcome'}];
  assert.equal(dueFor(plan,records,'2026-03-04').state,'overdue');
  assert.equal(dueFor(plan,records,'2026-03-04').due,'2026-03-03');
  records.push({...visit('2026-03-04'),care_role:'welcome'});
  assert.equal(dueFor(plan,records,'2026-03-04').state,'completed');
  assert.equal(dueFor(plan,records,'2026-03-04').due,null);
});

test('coverage finds absent, paused, one-time and unassigned plans only for active people', () => {
  const persons=[{id:'active',status:'active'},{id:'archived',status:'inactive'},{id:'guest',status:'visitor'},{id:'unknown'}];
  let gaps=coverageFor(persons,[]);
  assert.equal(gaps.length,2);assert.ok(gaps.every(g=>g.contact_id==='active'));
  gaps=coverageFor(persons,[{contact_id:'active',assigned_to:'Sample deacon'}, {contact_id:'active',care_role:'sunday_school',assigned_to:'Sample teacher',paused:true}]);
  assert.equal(gaps.length,1);assert.equal(gaps[0].reason,'Plan paused');
  assert.equal(coverageFor(persons,[{contact_id:'active',assigned_to:'Sample deacon',one_time:true}])[0].reason,'Needs a recurring plan');
  assert.equal(coverageFor(persons,[{contact_id:'active',assigned_to:' '}])[0].reason,'Needs an assigned person');
});

test('role forms switch to separate plans and monthly presets without overwriting a deacon schedule', async t => {
  const f=fixture(t,{assignments:[{...assignment,assigned_to:'Sample deacon',cadence_days:21}]});await f.module.load(1);
  f.click('[data-care-list="assignments"] [data-care-action="assignment"]');
  assert.equal(f.host.querySelector('[name="cadence_unit"]').value,'days');
  f.set('care_role','sunday_school').dispatchEvent(new f.w.Event('change',{bubbles:true}));
  assert.equal(f.host.querySelector('[name="cadence_unit"]').value,'months');assert.equal(f.host.querySelector('[name="cadence_value"]').value,'1');
  assert.equal(f.host.querySelector('[name="contact_id"]').value,'person-synthetic');
  f.set('assigned_to','Sample teacher');f.submit();await tick();await tick();
  const write=f.calls.find(q=>q.op==='insert');assert.equal(write.data.care_role,'sunday_school');assert.equal(write.data.cadence_months,1);assert.equal(write.data.one_time,false);
  assert.equal(f.rows.care_assignments[0].cadence_days,21);
});

test('coverage plan buttons and role/owner filters target the correct independent plan', async t => {
  const f=fixture(t,{assignments:[{...assignment,care_role:'deacon',assigned_to:'Sample deacon'}, {...assignment,id:'teacher-plan',care_role:'sunday_school',assigned_to:'Sample teacher',cadence_months:1}],visits:[visit('2026-03-02'),{...visit('2026-03-03'),care_role:'sunday_school'}]});await f.module.load(1);
  assert.equal(f.host.querySelectorAll('[data-care-list="assignments"] .care-row').length,2);
  const filter=f.host.querySelector('[data-care-role-filter]');filter.value='sunday_school';filter.dispatchEvent(new f.w.Event('change',{bubbles:true}));
  assert.equal(f.host.querySelectorAll('[data-care-list="assignments"] .care-row').length,1);
  assert.match(f.host.querySelector('[data-care-list="assignments"]').textContent,/Sunday school.*Every 1 month/);
  assert.equal(f.host.querySelectorAll('[data-care-list="visits"] .care-row').length,1);
  f.click('[data-care-list="assignments"] [data-care-action="visit"]');assert.equal(f.host.querySelector('[name="care_role"]').value,'sunday_school');
  const owner=f.host.querySelector('[data-care-deacon]');owner.value='Sample deacon';owner.dispatchEvent(new f.w.Event('change',{bubbles:true}));
  assert.equal(f.host.querySelectorAll('[data-care-list="assignments"] .care-row').length,0);
  assert.equal(f.host.querySelectorAll('[data-care-list="visits"] .care-row').length,0);
  const g=fixture(t);await g.module.load(1);g.click('[data-care-list="coverage"] [data-care-role="sunday_school"]');
  assert.equal(g.host.querySelector('[name="care_role"]').value,'sunday_school');assert.equal(g.host.querySelector('[name="cadence_value"]').value,'1');
});

test('empty write acknowledgements preserve the draft and a verified retry saves the role', async t => {
  const f=fixture(t);await f.module.load(1);f.click('[data-care-action="assignment"]');
  f.set('care_role','welcome').dispatchEvent(new f.w.Event('change',{bubbles:true}));
  f.set('contact_id','person-synthetic');f.set('notes','Synthetic welcome note');
  assert.equal(f.host.querySelector('[name="one_time"]').checked,true);
  assert.ok(f.host.querySelector('[name="first_due_on"]').value);
  f.controller.emptySave=true;f.submit();await tick();assert.equal(f.refreshes(),0);
  assert.match(f.host.querySelector('.care-form-error').textContent,/could not be saved/);assert.equal(f.host.querySelector('[name="notes"]').value,'Synthetic welcome note');
  f.controller.emptySave=false;await f.module.load(1);f.submit();await tick();await tick();assert.equal(f.refreshes(),1);
  const writes=f.calls.filter(q=>q.op==='insert');assert.equal(writes.length,2);assert.equal(writes[1].data.care_role,'welcome');assert.equal(writes[1].data.one_time,true);
});


test('coverage flags recurring intervals beyond the monthly and quarterly care goals', () => {
  const persons=[{id:'active',status:'active'}];
  const plan=(role,months,days)=>({contact_id:'active',care_role:role,assigned_to:'Sample team',cadence_months:months,cadence_days:days});
  let gaps=coverageFor(persons,[plan('deacon',12,28),plan('sunday_school',null,40)]);
  assert.equal(gaps.length,2);assert.ok(gaps.every(g=>g.reason==='Interval exceeds care goal'));
  assert.equal(coverageFor(persons,[plan('deacon',3,365),plan('sunday_school',1,365)]).length,0,'calendar months take precedence over retained day fields');
  assert.equal(coverageFor(persons,[plan('deacon',null,90),plan('sunday_school',null,28)]).length,0);
  gaps=coverageFor(persons,[plan('deacon',null,91),plan('sunday_school',2,28)]);
  assert.equal(gaps.length,2);assert.ok(gaps.every(g=>g.reason==='Interval exceeds care goal'));
});

test('monthly coverage rejects day intervals that can skip February without changing their scheduled dates', () => {
  const persons=[{id:'active',status:'active'}];
  const deacon={contact_id:'active',care_role:'deacon',assigned_to:'Fictional deacon',cadence_days:90};
  for(const [year,monthlyDue,expectedDays] of [
    ['2026','2026-02-28',{28:'2026-02-28',29:'2026-03-01',30:'2026-03-02'}],
    ['2024','2024-02-29',{28:'2024-02-28',29:'2024-02-29',30:'2024-03-01'}]
  ]){
    const start=year+'-01-31',date=year+'-02-28';
    const plan={contact_id:'active',care_role:'sunday_school',assigned_to:'Fictional teacher',started_on:start};
    const contact={contact_id:'active',care_role:'sunday_school',contacted_on:start,outcome:'contacted'};
    for(const days of [28,29,30]){
      const dayPlan={...plan,cadence_days:days};
      assert.equal(dueFor(dayPlan,[contact],date).due,expectedDays[days]);
      const gaps=coverageFor(persons,[deacon,dayPlan]);
      assert.equal(gaps.length,days===28?0:1,'day-based monthly coverage must hold in non-leap years too');
      if(gaps.length){assert.equal(gaps[0].care_role,'sunday_school');assert.equal(gaps[0].reason,'Interval exceeds care goal');}
      assert.equal(dayPlan.cadence_days,days,'coverage does not rewrite the chosen schedule');
    }
    const monthly={...plan,cadence_months:1,cadence_days:30};
    assert.equal(dueFor(monthly,[contact],date).due,monthlyDue);
    assert.equal(coverageFor(persons,[deacon,monthly]).length,0);
  }
});

test('switching person loads only that person and selected role before saving', async t => {
  const persons=[{id:'person-synthetic',first_name:'Sample',status:'active'},{id:'other-synthetic',first_name:'Other',status:'active'}];
  const f=fixture(t,{people:persons,assignments:[{...assignment,care_role:'deacon',assigned_to:'First deacon'}, {...assignment,id:'other-teacher',contact_id:'other-synthetic',care_role:'sunday_school',assigned_to:'Other teacher',cadence_months:1}]});await f.module.load(1);
  f.click('[data-care-action="assignment"]');f.set('care_role','sunday_school').dispatchEvent(new f.w.Event('change',{bubbles:true}));
  f.set('contact_id','other-synthetic').dispatchEvent(new f.w.Event('change',{bubbles:true}));
  assert.equal(f.host.querySelector('[name="assigned_to"]').value,'Other teacher');
  assert.equal(f.host.querySelector('[name="contact_id"]').disabled,true);
  assert.equal(f.host.querySelector('[name="care_role"]').value,'sunday_school');
  f.set('paused',true);f.submit();await tick();await tick();
  const write=f.calls.find(q=>q.op==='update');assert.equal(write.filters.id,'other-teacher');assert.equal(write.filters.version,1);assert.equal(write.data.contact_id,'other-synthetic');assert.equal(write.data.care_role,'sunday_school');assert.equal(write.data.paused,true);
  assert.equal(f.rows.care_assignments[0].assigned_to,'First deacon');
});


test('stale care edits cannot overwrite a newer plan and keep the draft for reconciliation', async t => {
  const f=fixture(t,{assignments:[assignment]});await f.module.load(1);
  f.click('[data-care-list="assignments"] [data-care-action="assignment"]');f.set('notes','My unsaved changes');
  f.rows.care_assignments[0]={...f.rows.care_assignments[0],version:2,notes:'Other staff saved this'};
  f.submit();await tick();
  const write=f.calls.find(q=>q.op==='update');assert.deepEqual(write.filters,{id:assignment.id,version:1});
  assert.equal(f.rows.care_assignments[0].notes,'Other staff saved this');
  assert.equal(f.host.querySelector('[name="notes"]').value,'My unsaved changes');
  assert.equal(f.host.querySelector('[name="notes"]').disabled,true);
  f.submit();await tick();assert.equal(f.calls.filter(q=>q.op==='update').length,1);
  await f.module.load(1);assert.match(f.host.querySelector('.care-form-error').textContent,/changed after you opened/);
  assert.equal(f.host.querySelector('[type="submit"]').disabled,true);
});

test('pending care writes freeze every field and controls and verify the submitted snapshot', async t => {
  const f=fixture(t);await f.module.load(1);f.click('[data-care-action="visit"]');
  f.set('contact_id','person-synthetic');f.set('visitor_name','Synthetic visitor');f.set('notes','Submitted note');
  let release;f.controller.hold=q=>new Promise(resolve=>release=()=>resolve(f.execute(q)));
  f.submit();await tick();
  assert.equal(f.checks.length,1);
  assert.ok([...f.host.querySelectorAll('[data-care-form] input,[data-care-form] textarea,[data-care-form] select,[data-care-form] button')].every(el=>el.disabled));
  f.set('notes','Programmatic later change');f.submit();await tick();assert.equal(f.calls.filter(q=>q.op==='insert').length,1);
  f.controller.hold=null;release();await tick();await tick();
  assert.equal(f.rows.care_visits[0].notes,'Submitted note');assert.equal(f.host.querySelector('[data-care-form]'),null);
});

test('an uncertain committed visit is confirmed by its stable UUID without a duplicate insert', async t => {
  const f=fixture(t);await f.module.load(1);f.click('[data-care-action="visit"]');
  f.set('contact_id','person-synthetic');f.set('visitor_name','Synthetic visitor');f.set('notes','Synthetic contact note');
  f.controller.respond=(q,execute)=>{if(q.op==='insert'){execute();return{error:{message:'Network interrupted'}};}return execute();};
  f.submit();await tick();
  assert.equal(f.rows.care_visits.length,1);assert.match(f.rows.care_visits[0].id,/^[0-9a-f-]{36}$/);
  assert.equal(unloadBlocked(f),true,'an uncertain append still needs reconciliation');
  f.click('[data-care-action="cancel"]');assert.ok(f.host.querySelector('[data-care-form]'));
  f.submit();await tick();assert.equal(f.calls.filter(q=>q.op==='insert').length,1);
  f.controller.respond=null;await f.module.load(1);
  assert.equal(f.host.querySelector('[data-care-form]'),null);assert.match(f.notices.at(-1).text,/confirmed after refresh/);
  assert.equal(unloadBlocked(f),false,'authoritative confirmation removes the warning');
  assert.equal(f.rows.care_visits.length,1);
});

test('uncommitted care creates retain a stable retry ID and never use upsert', async t => {
  const f=fixture(t);await f.module.load(1);f.click('[data-care-action="guest"]');f.set('contact_id','person-synthetic');f.set('notes','Draft');
  f.controller.emptySave=true;f.submit();await tick();const first=f.calls.find(q=>q.op==='insert');
  assert.equal(f.rows.guest_intakes.length,0);f.controller.emptySave=false;await f.module.load(1);f.submit();await tick();await tick();
  const writes=f.calls.filter(q=>q.op==='insert');assert.equal(writes.length,2);assert.equal(writes[1].data.id,first.data.id);
  assert.equal(f.rows.guest_intakes.length,1);assert.equal(f.calls.some(q=>q.op==='upsert'),false);
});

test('readiness loss preserves same-user drafts while access revocation clears them', async t => {
  const f=fixture(t);await f.module.load(1);f.click('[data-care-action="guest"]');f.set('contact_id','person-synthetic');f.set('notes','Retained draft');
  f.ctx.workspaceReady=false;f.ctx.canEdit=false;f.module.render();
  assert.equal(unloadBlocked(f),true,'same-owner connection loss retains the unsaved draft warning');
  assert.equal(f.host.querySelector('[name="notes"]').value,'Retained draft');assert.equal(f.host.querySelector('[type="submit"]').disabled,true);
  f.submit();await tick();assert.equal(f.calls.some(q=>q.op!=='select'),false);
  f.ctx.workspaceReady=true;f.ctx.canEdit=true;f.controller.ready=false;f.module.render();f.submit();await tick();
  assert.equal(f.checks.length,1);assert.equal(f.calls.some(q=>q.op!=='select'),false);
  assert.equal(f.host.querySelector('[name="notes"]').value,'Retained draft');
  f.ctx.role='viewer';f.ctx.workspaceReady=false;f.ctx.canEdit=false;f.module.render();assert.equal(f.host.textContent,'');
  assert.equal(unloadBlocked(f),false,'role loss clears the listener without a discard prompt');
});

test('confirmed permission errors clear private care drafts instead of offering a write retry', async t => {
  const f=fixture(t);await f.module.load(1);f.click('[data-care-action="guest"]');f.set('contact_id','person-synthetic');f.set('notes','Private draft');
  f.controller.error={code:'42501',message:'PRIVATE_CANARY'};f.submit();await tick();
  assert.equal(f.host.textContent,'');assert.doesNotMatch(JSON.stringify(f.notices),/PRIVATE_CANARY/);
  assert.equal(unloadBlocked(f),false);
});

test('discard confirmation protects changed care drafts; forced clear bypasses prompts', async t => {
  const f=fixture(t);await f.module.load(1);f.click('[data-care-action="guest"]');f.set('notes','Unsaved draft');
  let prompts=0;f.w.confirm=()=>{prompts++;return false;};f.click('[data-care-action="cancel"]');
  assert.equal(prompts,1);assert.equal(f.host.querySelector('[name="notes"]').value,'Unsaved draft');
  f.w.confirm=()=>{prompts++;return true;};f.click('[data-care-action="cancel"]');assert.equal(f.host.querySelector('[data-care-form]'),null);
  f.click('[data-care-action="guest"]');f.set('notes','Another draft');f.module.clear();assert.equal(prompts,2);assert.equal(f.host.textContent,'');
});

test('care reload warnings follow dirty/reverted fields and accepted or rejected draft disposal', async t => {
  const f=fixture(t,{role:'admin'});await f.module.load(1);
  assert.equal(unloadBlocked(f),false);
  for(const [kind,name] of [['assignment','notes'],['guest','notes'],['visit','notes'],['guidelines','body']]) {
    f.click('[data-care-action="'+kind+'"]');assert.equal(unloadBlocked(f),false,'pristine care forms do not warn');
    const input=f.host.querySelector('[name="'+name+'"]'),original=input.value;
    input.value='Synthetic unsaved care draft';input.dispatchEvent(new f.w.Event('input',{bubbles:true}));
    assert.equal(unloadBlocked(f),true,'typed care content must request the best-effort warning');
    input.value=original;input.dispatchEvent(new f.w.Event('input',{bubbles:true}));assert.equal(unloadBlocked(f),false);
    f.click('[data-care-action="cancel"]');assert.equal(unloadBlocked(f),false);
  }
  f.click('[data-care-action="guest"]');f.set('notes','Synthetic retained draft').dispatchEvent(new f.w.Event('change',{bubbles:true}));
  f.w.confirm=()=>false;f.click('[data-care-action="cancel"]');assert.equal(unloadBlocked(f),true);
  f.w.confirm=()=>true;f.click('[data-care-action="cancel"]');assert.equal(unloadBlocked(f),false);
  assert.equal(f.w.localStorage.length,0);assert.equal(f.w.sessionStorage.length,0);
});

test('care reload warnings protect even unchanged pending writes and cannot return after account clearing', async t => {
  const f=fixture(t,{assignments:[assignment]});await f.module.load(1);
  f.click('[data-care-action="assignment"][data-contact]');assert.equal(unloadBlocked(f),false);
  let release,query;
  f.controller.hold=q=>{query=q;return new Promise(resolve=>{release=resolve;});};
  f.submit();assert.equal(unloadBlocked(f),true,'readiness and write processing need a warning even without a changed field');
  await tick();assert.equal(query.op,'update');assert.equal(f.host.querySelector('[data-care-action="cancel"]').disabled,true);
  f.controller.hold=null;release(f.execute(query));await tick();await tick();
  assert.equal(f.host.querySelector('[data-care-form]'),null);assert.equal(unloadBlocked(f),false,'confirmed save removes the listener');

  f.click('[data-care-action="assignment"][data-contact]');
  f.controller.hold=q=>{query=q;return new Promise(resolve=>{release=resolve;});};f.submit();await tick();
  assert.equal(unloadBlocked(f),true);
  f.setContext({epoch:2,userId:null,role:null,canEdit:false});f.module.clear();
  assert.equal(unloadBlocked(f),false);assert.equal(f.host.textContent,'');
  release({data:{...query.data,id:query.filters.id,version:query.filters.version+1},error:null});await tick();await tick();
  assert.equal(unloadBlocked(f),false);assert.equal(f.host.textContent,'');
});

test('care reload warnings track pristine conflicts and unresolved saves through authoritative refresh', async t => {
  const f=fixture(t,{assignments:[assignment]});await f.module.load(1);
  f.click('[data-care-action="assignment"][data-contact]');assert.equal(unloadBlocked(f),false);
  f.rows.care_assignments[0].version++;await f.module.load(1);
  assert.equal(unloadBlocked(f),true,'a conflicted unchanged form still needs explicit review');
  f.click('[data-care-action="cancel"]');assert.equal(unloadBlocked(f),false);
  f.click('[data-care-action="assignment"][data-contact]');
  f.controller.emptySave=true;f.submit();await tick();assert.equal(unloadBlocked(f),true);
  f.controller.emptySave=false;await f.module.load(1);
  assert.equal(unloadBlocked(f),false,'a refresh confirming no change releases an unchanged draft');
  assert.ok(f.host.querySelector('[data-care-form]'));
  f.click('[data-care-action="cancel"]');assert.equal(unloadBlocked(f),false);
});

test('bounded care writes stop waiting and require refresh before retrying an uncertain outcome', async t => {
  const f=fixture(t,{requestTimeoutMs:5});await f.module.load(1);f.click('[data-care-action="guest"]');f.set('contact_id','person-synthetic');
  f.controller.hold=()=>new Promise(()=>{});f.submit();await new Promise(resolve=>setTimeout(resolve,20));
  assert.match(f.host.querySelector('.care-form-error').textContent,/Refresh care/);
  assert.equal(f.host.querySelector('[type="submit"]').disabled,true);
  assert.equal(f.host.querySelector('[data-care-action="retry"]').disabled,false);
  assert.equal(unloadBlocked(f),true);
  f.module.clear();assert.equal(unloadBlocked(f),false);
});

test('smaller care page caps still include the latest success and complete reminder totals',async t=>{
  const records=Array.from({length:600},(_,i)=>({...visit(today(),i===599?'contacted':'attempted'),id:'capped-visit-'+i}));
  const f=fixture(t,{assignments:[assignment],visits:records});
  f.controller.respond=(q,execute)=>{const result=execute();if(q.table==='care_visits')result.data=result.data.slice(0,500);return result;};
  assert.equal(await f.module.load(1),true);
  assert.equal(f.summaries.at(-1).duePlans,0);
  assert.match(f.host.querySelector('[data-care-list="assignments"]').textContent,/Last successful contact/);
  assert.deepEqual(f.calls.filter(q=>q.table==='care_visits').map(q=>q.range),[[0,999],[500,1499]]);
  assert.ok(f.calls.filter(q=>q.range).every(q=>q.selectOptions.count==='exact'));
});

test('incomplete care pages never promote partial data or reconcile away an existing draft',async t=>{
  const second={...visit(today()),id:'second-visit'};
  const bad=[{data:null,count:2},{data:[],count:2},{data:[second]},{data:[second],count:3},{data:[second],count:-1},
    {data:[second],count:2.5},{data:[second],count:Number.MAX_SAFE_INTEGER+1},{data:[{...second,id:'first-visit'}],count:2},
    {data:[{...second,id:' '}],count:2},{data:[second,{...second,id:'overflow'}],count:2}];
  for(const response of bad){
    const f=fixture(t,{assignments:[assignment],visits:[{...visit(today(),'attempted'),id:'first-visit'},second]});
    assert.equal(await f.module.load(1),true);f.click('[data-care-list="assignments"] [data-care-action="assignment"]');f.set('notes','Keep this fictional care draft');
    f.controller.respond=(q,execute)=>q.table!=='care_visits'?execute():q.range[0]===0?{data:[f.rows.care_visits[0]],count:2,error:null}:response;
    assert.equal(await f.module.load(1),false);assert.equal(f.summaries.at(-1),null);
    assert.equal(f.host.querySelector('[name="notes"]').value,'Keep this fictional care draft');
    assert.equal(f.host.querySelector('[data-care-form] [type="submit"]').disabled,true);
    assert.equal(f.host.querySelectorAll('[data-care-list="assignments"] .care-row').length,0);
  }
});

test('care without range must prove its one response is complete, including an empty result',async t=>{
  const f=fixture(t,{noRange:true,assignments:[assignment]});assert.equal(await f.module.load(1),true);
  assert.ok(f.calls.filter(q=>q.table!=='care_guidelines').every(q=>q.selectOptions.count==='exact'));
  f.controller.respond=(q,execute)=>q.table==='care_assignments'?{data:[assignment],count:2}:execute();
  assert.equal(await f.module.load(1),false);assert.equal(f.summaries.at(-1),null);
});

test('care stops paginating after account clear even when the held first page has more records',async t=>{
  const f=fixture(t);let release;
  f.controller.respond=(q,execute)=>q.table==='care_visits'?new Promise(resolve=>release=resolve):execute();
  const loading=f.module.load(1);await tick();f.setContext({epoch:2,userId:null,role:null,canEdit:false});f.module.clear();
  release({data:[{...visit(today()),id:'held-first-visit'}],count:2});await loading;
  assert.equal(f.calls.filter(q=>q.table==='care_visits').length,1);assert.equal(f.host.textContent,'');assert.equal(f.summaries.at(-1),null);
});

const attentionPlain = value => value === null ? null : JSON.parse(JSON.stringify(value));
test('attention combines care plan reasons and coverage gaps without creating visitor or inactive coverage',async t=>{
  const people=[{id:'active',first_name:'Fictional',last_name:'Active',status:'active',email:'PRIVATE_EMAIL_CANARY',notes:'PRIVATE_PERSON_NOTE'},{id:'visitor',first_name:'Fictional',last_name:'Visitor',status:'visitor'},{id:'inactive',first_name:'Fictional',last_name:'Inactive',status:'inactive'}];
  const f=fixture(t,{people,assignments:[
    {...assignment,id:'active-deacon',contact_id:'active',care_role:'deacon',first_due_on:'2026-09-10',assigned_to:' ',notes:'PRIVATE_CARE_NOTE'},
    {...assignment,id:'active-teacher',contact_id:'active',care_role:'sunday_school',first_due_on:'2026-09-11',cadence_months:1,assigned_to:'Fictional teacher'},
    {...assignment,id:'visitor-plan',contact_id:'visitor',care_role:'welcome',started_on:null,assigned_to:'Welcome label'},
    {...assignment,id:'inactive-plan',contact_id:'inactive',care_role:'pastoral',first_due_on:'2026-09-10',assigned_to:'Pastoral label'},
    {...assignment,id:'missing-person-plan',contact_id:'not-loaded',first_due_on:'2026-09-10'}
  ]});assert.equal(f.module.attentionSnapshot('2026-09-11'),null);await f.module.load(1);
  const snapshot=attentionPlain(f.module.attentionSnapshot('2026-09-11'));
  assert.equal(snapshot.items.length,4);
  const deacon=snapshot.items.find(row=>row.source_id==='active-deacon');assert.deepEqual(deacon,{key:'care_plan:active-deacon',category:'care',source_type:'care_plan',source_id:'active-deacon',contact_id:'active',care_role:'deacon',title:'Fictional Active',owner_label:'Unassigned care label',due_on:'2026-09-10',reasons:['care_overdue','care_unassigned','care_coverage_gap']});
  assert.deepEqual(snapshot.items.find(row=>row.source_id==='active-teacher').reasons,['care_due_today']);assert.equal(snapshot.items.find(row=>row.source_id==='active-teacher').owner_label,'Care label: Fictional teacher');
  assert.deepEqual(snapshot.items.find(row=>row.source_id==='visitor-plan').reasons,['care_unscheduled']);assert.deepEqual(snapshot.items.find(row=>row.source_id==='inactive-plan').reasons,['care_overdue']);
  assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_|notes|email|phone|address|household/);
  snapshot.items[0].reasons.push('tampered');snapshot.items[0].title='tampered';assert.doesNotMatch(JSON.stringify(f.module.attentionSnapshot('2026-09-11')),/tampered/);assert.ok(f.calls.every(call=>call.op==='select'));
});
test('attention reuses calendar-month and role-isolated history rules and ignores every care view filter',async t=>{
  const f=fixture(t,{assignments:[{...assignment,care_role:'sunday_school',started_on:'2024-01-01',cadence_months:1,assigned_to:'Teacher label'},{...assignment,id:'welcome-complete',care_role:'welcome',started_on:'2024-01-01',one_time:true,first_due_on:'2024-01-01'}],visits:[
    {...visit('2024-01-31'),care_role:'sunday_school'},
    {...visit('2024-02-20','attempted'),care_role:'sunday_school'},
    {...visit('2024-02-20','attempted','2024-03-20'),id:'deacon-other-role-attempt',care_role:'deacon'},
    {...visit('2024-02-01'),care_role:'welcome'},
    {...visit('2024-03-01'),care_role:'sunday_school'}
  ]});await f.module.load(1);
  const feb=attentionPlain(f.module.attentionSnapshot('2024-02-29'));const due=feb.items.find(row=>row.source_id===assignment.id);assert.equal(due.due_on,'2024-02-29');assert.deepEqual(due.reasons,['care_due_today']);assert.equal(feb.items.some(row=>row.source_id==='welcome-complete'),false);
  assert.equal(f.module.selectPerson(assignment.contact_id),true);const search=f.host.querySelector('[data-care-search]');search.value='nothing matches';search.dispatchEvent(new f.w.Event('input',{bubbles:true}));
  for(const selector of ['[data-care-deacon]','[data-care-role-filter]','[data-care-plan-status]']){const node=f.host.querySelector(selector);node.value=selector.includes('deacon')?'__unassigned':selector.includes('role-filter')?'deacon':'unassigned';node.dispatchEvent(new f.w.Event('change',{bubbles:true}));}
  assert.deepEqual(attentionPlain(f.module.attentionSnapshot('2024-02-29')),feb);
  assert.equal(f.module.attentionSnapshot('2024-03-01').items.some(row=>row.source_id===assignment.id),false,'later actual success schedules the next calendar month');
  f.rows.care_visits=f.rows.care_visits.filter(row=>row.contacted_on!=='2024-03-01');await f.module.load(1);const overdue=f.module.attentionSnapshot('2024-03-01').items.find(row=>row.source_id===assignment.id);assert.equal(overdue.due_on,'2024-02-29');assert.ok(overdue.reasons.includes('care_overdue'));
});
test('paused, completed one-time and long-interval care plans still produce only their existing coverage gaps',async t=>{
  const people=['paused','completed','long','absent'].map(id=>({id,first_name:'Fictional '+id,status:'active'}));
  const assignments=[{...assignment,id:'paused-deacon',contact_id:'paused',care_role:'deacon',paused:true,assigned_to:'Label'},{...assignment,id:'completed-deacon',contact_id:'completed',care_role:'deacon',started_on:'2026-09-01',one_time:true,assigned_to:'Label'},{...assignment,id:'long-deacon',contact_id:'long',care_role:'deacon',cadence_months:4,first_due_on:'2027-01-01',assigned_to:'Label'}];
  for(const person of people)assignments.push({...assignment,id:person.id+'-teacher',contact_id:person.id,care_role:'sunday_school',cadence_months:1,first_due_on:'2027-01-01',assigned_to:'Teacher label'});
  const f=fixture(t,{people,assignments,visits:[{...visit('2026-09-02'),contact_id:'completed',care_role:'deacon'}]});await f.module.load(1);
  const items=attentionPlain(f.module.attentionSnapshot('2026-09-11')).items;assert.equal(items.length,4);assert.deepEqual(items.map(row=>row.key),people.map(person=>'care_coverage:'+person.id+':deacon'));assert.ok(items.every(row=>row.source_type==='care_coverage'&&row.source_id===row.contact_id&&row.due_on===null&&row.reasons.join(',')==='care_coverage_gap'));
});
test('care attention is unavailable during reads/failures or identity/readiness loss and source selection respects loading',async t=>{
  const f=fixture(t,{assignments:[assignment]});await f.module.load(1);assert.ok(f.module.attentionSnapshot());let release;
  f.controller.respond=(query,execute)=>query.table==='care_visits'?new Promise(resolve=>release=()=>resolve(execute())):execute();const pending=f.module.load(1);await tick();assert.equal(f.module.attentionSnapshot(),null);assert.equal(f.module.selectPerson(assignment.contact_id),false);release();await pending;assert.ok(f.module.attentionSnapshot());
  for(const change of [{workspaceReady:false},{workspaceReady:undefined},{canEdit:false},{role:'viewer'},{userId:'replacement'},{epoch:2},{userId:null}]){f.setContext({...f.ctx,...change});assert.equal(f.module.attentionSnapshot(),null);}
  f.setContext(f.ctx);f.controller.peopleReady=false;assert.equal(f.module.attentionSnapshot(),null);assert.equal(f.module.selectPerson(assignment.contact_id),false);f.controller.peopleReady=true;
  f.controller.respond=null;f.controller.error='PRIVATE_FAILURE';assert.equal(await f.module.load(1),false);assert.equal(f.module.attentionSnapshot(),null);f.controller.error=null;await f.module.load(1);assert.ok(f.module.attentionSnapshot());f.module.clear();assert.equal(f.module.attentionSnapshot(),null);
});
test('a late care read cannot re-expose attention after an owner or epoch replacement',async t=>{
  for(const replacement of [{userId:'replacement',epoch:1},{userId:'synthetic-user',epoch:2}]){
    const f=fixture(t,{assignments:[assignment]});await f.module.load(1);let release;f.controller.respond=(query,execute)=>query.table==='care_visits'?new Promise(resolve=>release=()=>resolve(execute())):execute();const pending=f.module.load(1);await tick();f.setContext({...f.ctx,...replacement});assert.equal(f.module.attentionSnapshot(),null);release();await pending;assert.equal(f.module.attentionSnapshot(),null);
  }
});

test('attention care actions select the exact person and role in the appropriate existing view without writes',async t=>{
  const f=fixture(t,{assignments:[{...assignment,id:'teacher-plan',care_role:'sunday_school',cadence_months:1,first_due_on:today(),assigned_to:'Teacher label'}]});await f.module.load(1);const snapshot=attentionPlain(f.module.attentionSnapshot());const teacher=snapshot.items.find(row=>row.source_id==='teacher-plan'),coverage=snapshot.items.find(row=>row.source_type==='care_coverage');
  assert.equal(f.module.openFromAttention({...teacher,care_role:'pastoral'}),false);assert.equal(f.module.openFromAttention({...coverage,source_id:'not-the-record'}),false);assert.equal(f.module.openFromAttention(null),false);
  assert.equal(f.module.openFromAttention(teacher),true);assert.equal(f.host.querySelector('[data-care-view="followup"]').getAttribute('aria-pressed'),'true');assert.equal(f.host.querySelector('[data-care-role-filter]').value,'sunday_school');assert.equal(f.host.querySelectorAll('[data-care-list="assignments"] .care-row').length,1);
  assert.equal(f.module.openFromAttention(coverage),true);assert.equal(f.host.querySelector('[data-care-view="coverage"]').getAttribute('aria-pressed'),'true');assert.equal(f.host.querySelector('[data-care-role-filter]').value,'deacon');assert.equal(f.host.querySelectorAll('[data-care-list="coverage"] .care-row').length,1);assert.equal(f.w.document.activeElement.dataset.careRole,'deacon');assert.ok(f.calls.every(call=>call.op==='select'));
});
test('care attention navigation preserves a declined draft and rechecks identity/data after an accepted discard',async t=>{
  for(const decision of ['decline','owner','loading']){
    const f=fixture(t,{assignments:[{...assignment,care_role:'deacon',first_due_on:today(),assigned_to:'Deacon label'}]});await f.module.load(1);const target=attentionPlain(f.module.attentionSnapshot()).items.find(row=>row.source_type==='care_coverage');f.click('[data-care-list="assignments"] [data-care-action="assignment"]');f.set('notes','Fictional retained draft');let pending,release;
    f.w.confirm=()=>{if(decision==='owner')f.setContext({...f.ctx,userId:'replacement'});if(decision==='loading'){f.controller.respond=(q,execute)=>q.table==='care_visits'?new Promise(resolve=>release=()=>resolve(execute())):execute();pending=f.module.load(1);}return decision!=='decline';};
    assert.equal(f.module.openFromAttention(target),false);assert.equal(f.host.querySelector('[data-care-view="followup"]').getAttribute('aria-pressed'),'true');assert.equal(f.host.querySelector('[name="notes"]').value,'Fictional retained draft');assert.ok(f.calls.every(call=>call.op==='select'));if(pending){await tick();release();await pending;}
  }
});
