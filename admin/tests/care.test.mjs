import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const { dueFor, today, addMonths, coverageFor } = require('../care.js');
const source = await readFile(new URL('../care.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const assignment = { id:'plan-synthetic', contact_id:'person-synthetic', started_on:'2026-03-01', cadence_days:28, paused:false };
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

function fixture(t, opts={}) {
  const dom = new JSDOM('<section id="care-view"></section>', {url:'https://office.example.invalid/admin/',runScripts:'outside-only'}), w=dom.window;
  t.after(()=>w.close()); w.eval(source);
  const host=w.document.querySelector('#care-view'), calls=[], notices=[];
  let ctx={epoch:1,userId:'synthetic-user',canEdit:true,role:opts.role||'editor'}, module, refreshes=0;
  const people=opts.people||[{id:'person-synthetic',first_name:'Sample',last_name:'Person',household_name:'Test household',status:'active'}];
  const rows={care_assignments:opts.assignments||[],care_visits:opts.visits||[],guest_intakes:opts.guests||[],care_guidelines:opts.guidelines||null};
  const controller={hold:null,error:null,emptySave:false};
  const db={from(table){
    const query={table,op:'select'};
    const chain={select(fields){query.fields=fields;return chain;},single(){query.single=true;return chain;},order(){return chain;},range(a,b){query.range=[a,b];return chain;},eq(){return chain;},maybeSingle(){return chain;},insert(data){query.op='insert';query.data=data;return chain;},upsert(data,options){query.op='upsert';query.data=data;query.options=options;return chain;},then(resolve,reject){
      calls.push(query);
      if(controller.hold)return controller.hold(query).then(resolve,reject);
      if(controller.error)return Promise.resolve({error:{message:controller.error}}).then(resolve,reject);
      const data=query.op==='select'?(query.range?rows[table].slice(query.range[0],query.range[1]+1):rows[table]):controller.emptySave?null:{id:'saved-synthetic'};
      return Promise.resolve({data,error:null}).then(resolve,reject);
    }}; return chain;
  }};
  module=w.CreekCare.create({root:host,db,getContext:()=>ctx,isCurrent:epoch=>!!ctx.userId&&ctx.epoch===epoch,people:()=>people,notice:(text,bad)=>notices.push({text,bad}),refresh:async()=>{refreshes++;await module.load(ctx.epoch);}});
  const click=selector=>host.querySelector(selector).click();
  function set(name,value) { const el=host.querySelector('[name="'+name+'"]'); if(el.type==='checkbox')el.checked=value;else el.value=value;return el; }
  function submit() {host.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));}
  return {w,host,module,calls,notices,rows,controller,click,set,submit,ctx,setContext:value=>ctx=value,refreshes:()=>refreshes};
}
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
  const write=f.calls.find(q=>q.op==='upsert');assert.equal(write.table,'care_assignments');assert.equal(write.data.cadence_days,21);assert.equal(write.data.paused,true);
  assert.deepEqual(Object.keys(write.data).sort(),['assigned_to','cadence_days','cadence_months','care_role','contact_id','first_due_on','notes','one_time','paused','started_on']);assert.equal(write.options.onConflict,'contact_id,care_role');assert.equal(write.data.care_role,'deacon');assert.equal(write.fields,'id');assert.equal(write.single,true);assert.equal(f.refreshes(),1);
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
test('editors read guidelines; only admins can save the default record and empty guidance stays proposed', async t => {
  const e=fixture(t,{guidelines:{id:'default',body:'Synthetic agreed guidance',updated_at:'2026-03-01T12:00:00Z'}});await e.module.load(1);
  assert.match(e.host.textContent,/Synthetic agreed guidance/);assert.equal(e.host.querySelector('[data-care-action="guidelines"]'),null);
  const a=fixture(t,{role:'admin'});await a.module.load(1);assert.match(a.host.textContent,/Proposed starting guidance/);a.click('[data-care-action="guidelines"]');a.set('body','Synthetic approved guidance');a.submit();await tick();await tick();
  const write=a.calls.find(q=>q.op==='upsert');assert.equal(write.table,'care_guidelines');assert.equal(write.data.id,'default');assert.equal(write.options.onConflict,'id');
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
  const write=f.calls.find(q=>q.op==='upsert');assert.equal(write.data.care_role,'sunday_school');assert.equal(write.data.cadence_months,1);assert.equal(write.data.one_time,false);
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
  f.controller.emptySave=false;f.submit();await tick();await tick();assert.equal(f.refreshes(),1);
  const writes=f.calls.filter(q=>q.op==='upsert');assert.equal(writes.length,2);assert.equal(writes[1].data.care_role,'welcome');assert.equal(writes[1].data.one_time,true);
});


test('coverage flags recurring intervals beyond the monthly and quarterly care goals', () => {
  const persons=[{id:'active',status:'active'}];
  const plan=(role,months,days)=>({contact_id:'active',care_role:role,assigned_to:'Sample team',cadence_months:months,cadence_days:days});
  let gaps=coverageFor(persons,[plan('deacon',12,28),plan('sunday_school',null,40)]);
  assert.equal(gaps.length,2);assert.ok(gaps.every(g=>g.reason==='Interval exceeds care goal'));
  assert.equal(coverageFor(persons,[plan('deacon',3,365),plan('sunday_school',1,365)]).length,0,'calendar months take precedence over retained day fields');
  assert.equal(coverageFor(persons,[plan('deacon',null,90),plan('sunday_school',null,30)]).length,0);
  gaps=coverageFor(persons,[plan('deacon',null,91),plan('sunday_school',2,28)]);
  assert.equal(gaps.length,2);assert.ok(gaps.every(g=>g.reason==='Interval exceeds care goal'));
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
  const write=f.calls.find(q=>q.op==='upsert');assert.equal(write.data.contact_id,'other-synthetic');assert.equal(write.data.care_role,'sunday_school');assert.equal(write.data.paused,true);
  assert.equal(f.rows.care_assignments[0].assigned_to,'First deacon');
});
