import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const { dueFor, today } = require('../care.js');
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
  const people=[{id:'person-synthetic',first_name:'Sample',last_name:'Person',household_name:'Test household'}];
  const rows={care_assignments:opts.assignments||[],care_visits:opts.visits||[],guest_intakes:opts.guests||[],care_guidelines:opts.guidelines||null};
  const controller={hold:null,error:null};
  const db={from(table){
    const query={table,op:'select'};
    const chain={select(){return chain;},order(){return chain;},range(a,b){query.range=[a,b];return chain;},eq(){return chain;},maybeSingle(){return chain;},insert(data){query.op='insert';query.data=data;return chain;},upsert(data,options){query.op='upsert';query.data=data;query.options=options;return chain;},then(resolve,reject){
      calls.push(query);
      if(controller.hold)return controller.hold(query).then(resolve,reject);
      if(controller.error)return Promise.resolve({error:{message:controller.error}}).then(resolve,reject);
      const data=query.op==='select'?(query.range?rows[table].slice(query.range[0],query.range[1]+1):rows[table]):null;
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
  assert.equal(f.host.querySelector('[name="cadence_days"]').value,'14');assert.equal(f.host.querySelector('[name="contact_id"]').disabled,true);
  f.set('notes','Synthetic draft');f.module.render();assert.equal(f.host.querySelector('[name="notes"]').value,'Synthetic draft');
});
test('assignment write uses exact allowlisted fields and supplied cadence; notes render as text', async t => {
  const f=fixture(t);await f.module.load(1);f.click('[data-care-action="assignment"]');
  assert.equal(f.host.querySelector('[name="cadence_days"]').value,'28');
  f.set('contact_id','person-synthetic');f.set('cadence_days','21');f.set('assigned_to','Test team');f.set('paused',true);f.set('notes','<img src=x onerror=alert(1)>');f.submit();await tick();await tick();
  const write=f.calls.find(q=>q.op==='upsert');assert.equal(write.table,'care_assignments');assert.equal(write.data.cadence_days,21);assert.equal(write.data.paused,true);
  assert.deepEqual(Object.keys(write.data).sort(),['assigned_to','cadence_days','contact_id','notes','paused','started_on']);assert.equal(write.options.onConflict,'contact_id');assert.equal(f.refreshes(),1);
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
