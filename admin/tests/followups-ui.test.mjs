import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
const require=createRequire(import.meta.url);
const {dueFor,today,addMonths}=require('../followups.js');
const code=await readFile(new URL('../followups.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const plan={id:'sample-plan',owner_id:'sample-owner',display_name:'Sample leader',leadership_role:'deacon',team_name:'Sample team',cadence_months:1,cadence_days:null,first_due_on:'2026-01-31',last_contact_on:null,snoozed_until:null,paused:false,notes:'Synthetic planning note',version:1};
function fixture(t,opts={}) {
  const dom=new JSDOM('<section id="followups"></section>',{url:'https://office.example.invalid/admin/',runScripts:'outside-only'}),w=dom.window;
  t.after(()=>w.close());w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.eval(code);
  let ctx={epoch:1,userId:'sample-owner',role:opts.role||'editor',canEdit:true},api,refreshes=0,next=1;
  const root=w.document.getElementById('followups'),calls=[],notices=[],summaries=[],control={error:null,hold:null,noRows:false,returnOverride:null,leakOwners:false};
  const rows={leader_followups:structuredClone(opts.plans||[]),leader_followup_contacts:structuredClone(opts.contacts||[])};
  const db={from(table){
    const q={table,op:'select',filters:[]};
    const chain={select(fields){q.fields=fields;return chain;},eq(key,value){q.filters.push([key,value]);return chain;},order(){return chain;},range(a,b){q.range=[a,b];return chain;},single(){q.single=true;return chain;},insert(data){q.op='insert';q.data=data;return chain;},update(data){q.op='update';q.data=data;return chain;},then(resolve,reject){
      calls.push(q);if(control.hold)return control.hold(q).then(resolve,reject);
      if(control.error)return Promise.resolve({error:control.error}).then(resolve,reject);
      let data;
      if(q.op==='select'){data=rows[table].filter(r=>control.leakOwners||q.filters.every(([key,value])=>r[key]===value));data=data.slice(q.range?.[0]||0,q.range?q.range[1]+1:undefined);}
      else if(control.noRows)data=null;
      else if(q.op==='insert'){data={id:'new-'+next++,owner_id:ctx.userId,version:1,last_contact_on:null,snoozed_until:null,...structuredClone(q.data)};rows[table].push(data);}
      else{data=rows[table].find(r=>q.filters.every(([key,value])=>r[key]===value));if(data)Object.assign(data,structuredClone(q.data),{version:data.version+1});}
      if(q.op!=='select'&&control.returnOverride)data=control.returnOverride(data);
      return Promise.resolve({data:structuredClone(data),error:null}).then(resolve,reject);
    }};return chain;
  },rpc(name,args){const q={op:'rpc',name,data:args};calls.push(q);if(control.hold)return control.hold(q);if(control.error)return Promise.resolve({error:control.error});
    const row=rows.leader_followups.find(r=>r.id===args.p_id&&r.owner_id===ctx.userId&&r.version===args.p_version);if(!row||control.noRows)return Promise.resolve({data:null,error:null});
    if(args.p_outcome==='connected'){if(!row.last_contact_on||args.p_contacted_on>row.last_contact_on)row.last_contact_on=args.p_contacted_on;if(args.p_contacted_on===today())row.snoozed_until=null;}
    row.version++;rows.leader_followup_contacts.push({id:'log-'+next++,followup_id:row.id,owner_id:ctx.userId,contacted_on:args.p_contacted_on,outcome:args.p_outcome,method:args.p_method,notes:args.p_notes,created_at:today()+'T12:00:00Z'});
    let data={id:row.id,version:row.version,last_contact_on:row.last_contact_on};if(control.returnOverride)data=control.returnOverride(data);return Promise.resolve({data,error:null});
  }};
  api=w.CreekFollowups.create({root,db,getContext:()=>ctx,ensureReady:async epoch=>control.ensure?await control.ensure(epoch):true,isCurrent:e=>ctx.epoch===e&&!!ctx.userId,notice:(text,bad)=>notices.push({text,bad}),onSummary:s=>summaries.push(s),refresh:async()=>{refreshes++;return api.load(ctx.epoch);}});
  const form=()=>w.document.querySelector('[data-followups-form]');
  function set(name,value,change=false){const el=form().elements[name];if(el.type==='checkbox')el.checked=value;else el.value=value;if(change)el.dispatchEvent(new w.Event('change',{bubbles:true}));return el;}
  async function submit(force=false){if(force)form().reportValidity=()=>true;form().dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();await tick();}
  const click=selector=>root.querySelector(selector).click();
  return {w,root,api,rows,calls,notices,summaries,control,form,set,submit,click,refreshes:()=>refreshes,setContext:next=>ctx=next};
}

test('personal due dates clamp calendar months, ignore future successes, and honor Central time',()=>{
  assert.equal(addMonths('2024-01-31',1),'2024-02-29');assert.equal(addMonths('2025-01-31',1),'2025-02-28');assert.equal(addMonths('2024-02-29',12),'2025-02-28');
  assert.equal(today(new Date('2026-09-14T04:59:59Z')),'2026-09-13');
  assert.equal(dueFor({...plan,last_contact_on:'2026-03-08'},'2026-03-20').due,'2026-04-08');
  assert.equal(dueFor({...plan,last_contact_on:'2026-12-01'},'2026-02-01').due,'2026-01-31');
  assert.equal(dueFor({...plan,cadence_months:null,cadence_days:28,last_contact_on:'2026-03-01'},'2026-03-29').state,'due');
});

test('snoozing delays reminders without changing last contact or creating overdue paused plans',()=>{
  const row={...plan,last_contact_on:'2026-01-31',snoozed_until:'2026-03-10'};
  const due=dueFor(row,'2026-03-01');assert.equal(due.scheduled,'2026-02-28');assert.equal(due.due,'2026-03-10');assert.equal(due.lastContact,'2026-01-31');assert.equal(due.snoozed,true);
  assert.equal(dueFor({...row,snoozed_until:'2026-02-01'},'2026-03-01').due,'2026-02-28');
  assert.equal(dueFor({...row,paused:true},'2026-04-01').state,'paused');assert.equal(dueFor({...row,paused:true},'2026-04-01').daysOverdue,0);
});

test('reads use owner filters, cross-owner rows never render, and summary excludes private notes',async t=>{
  const f=fixture(t,{plans:[plan,{...plan,id:'other-plan',owner_id:'another-owner',display_name:'OTHER_OWNER_CANARY'}]});f.control.leakOwners=true;await f.api.load(1);
  assert.ok(f.calls.every(q=>q.filters.some(([k,v])=>k==='owner_id'&&v==='sample-owner')));assert.doesNotMatch(f.root.textContent,/OTHER_OWNER_CANARY/);
  const summary=f.summaries.at(-1);assert.equal(summary.items.length,1);assert.equal(summary.items[0].due_on,'2026-01-31');assert.equal(summary.overdue,1);assert.equal('notes' in summary.items[0],false);assert.equal('owner_id' in summary.items[0],false);
});

test('new leaders default monthly and writes omit all server-owned metadata',async t=>{
  const f=fixture(t);await f.api.load(1);f.api.openNew();assert.equal(f.form().elements.cadence_unit.value,'months');assert.equal(f.form().elements.cadence_value.value,'1');
  f.set('display_name','Sample teacher');f.set('leadership_role','sunday_school');f.set('team_name','Sample class');f.set('notes','Synthetic plan');await f.submit();
  const write=f.calls.find(q=>q.op==='insert');assert.equal(write.table,'leader_followups');assert.equal(write.fields,'*');assert.equal(write.single,true);assert.equal(write.data.cadence_months,1);assert.equal(write.data.cadence_days,null);
  assert.deepEqual(Object.keys(write.data).sort(),['cadence_days','cadence_months','display_name','first_due_on','id','leadership_role','notes','paused','team_name']);assert.equal(f.form(),null);assert.equal(f.refreshes(),1);
});

test('edits and pause/resume use owner and optimistic version filters',async t=>{
  const f=fixture(t,{plans:[plan]});await f.api.load(1);f.click('[data-followups-action="edit"]');f.set('paused',true);f.set('cadence_unit','days',true);f.set('cadence_value','21');await f.submit();
  const write=f.calls.find(q=>q.op==='update');assert.deepEqual(write.filters,[['id','sample-plan'],['owner_id','sample-owner'],['version',1]]);assert.equal(write.data.paused,true);assert.equal(write.data.cadence_days,21);assert.equal(write.data.cadence_months,null);
  assert.equal(f.summaries.at(-1).items.length,0);f.click('[data-followups-view="paused"]');assert.match(f.root.textContent,/Sample leader/);f.click('[data-followups-action="edit"]');f.set('paused',false);await f.submit();assert.equal(f.rows.leader_followups[0].paused,false);
});

test('contact RPC records attempts without resetting cadence, while connected logs update history',async t=>{
  const f=fixture(t,{plans:[{...plan,last_contact_on:'2026-01-01'}]});await f.api.load(1);f.click('[data-followups-action="contact"]');f.set('outcome','attempted');f.set('method','phone');f.set('notes','Synthetic attempt');await f.submit();
  const call=f.calls.find(q=>q.op==='rpc');assert.equal(call.name,'record_leader_contact');assert.equal(call.data.p_version,1);assert.equal(call.data.p_outcome,'attempted');assert.equal(f.rows.leader_followups[0].last_contact_on,'2026-01-01');
  f.click('[data-followups-action="contact"]');f.set('method','in_person');f.set('notes','Synthetic conversation');await f.submit();assert.equal(f.rows.leader_followups[0].last_contact_on,today());
  f.click('[data-followups-view="upcoming"]');f.click('[data-followups-action="history"]');assert.match(f.w.document.querySelector('dialog').textContent,/Synthetic attempt/);assert.match(f.w.document.querySelector('dialog').textContent,/Synthetic conversation/);
});

test('snooze updates only the snooze field and never appends a contact',async t=>{
  const f=fixture(t,{plans:[plan]});await f.api.load(1);f.click('[data-followups-action="snooze"]');f.set('snoozed_until',addMonths(today(),1));await f.submit();
  const write=f.calls.find(q=>q.op==='update');assert.deepEqual(Object.keys(write.data),['snoozed_until']);assert.equal(f.calls.some(q=>q.op==='rpc'),false);assert.equal(f.rows.leader_followups[0].last_contact_on,null);assert.equal(f.summaries.at(-1).upcoming,1);
});

test('periodic refresh retains drafts and filters, but changed versions block stale overwrites',async t=>{
  const f=fixture(t,{plans:[plan]});await f.api.load(1);const search=f.root.querySelector('[data-followups-search]');search.value='Sample';search.dispatchEvent(new f.w.Event('input',{bubbles:true}));f.click('[data-followups-action="edit"]');f.set('notes','Synthetic draft');await f.api.load(1);assert.equal(f.form().elements.notes.value,'Synthetic draft');assert.equal(search.value,'Sample');
  f.rows.leader_followups[0].version=2;await f.api.load(1);assert.equal(f.form().querySelector('[type="submit"]').disabled,true);assert.match(f.form().textContent,/plan changed/);await f.submit();assert.equal(f.calls.some(q=>q.op==='update'),false);
});

test('transient load failure clears lists, preserves draft, and blocks saves until refreshed',async t=>{
  const f=fixture(t,{plans:[plan]});await f.api.load(1);f.click('[data-followups-action="edit"]');f.set('notes','Synthetic retained draft');f.control.error={message:'PRIVATE_FAILURE_CANARY'};await f.api.load(1);
  assert.equal(f.form().elements.notes.value,'Synthetic retained draft');assert.equal(f.form().querySelector('[type="submit"]').disabled,true);assert.equal(f.summaries.at(-1).due,null);assert.doesNotMatch(f.w.document.body.textContent,/PRIVATE_FAILURE_CANARY/);await f.submit();assert.equal(f.calls.some(q=>q.op==='update'),false);
  f.control.error=null;await f.api.load(1);assert.equal(f.form().querySelector('[type="submit"]').disabled,false);await f.submit();assert.equal(f.rows.leader_followups[0].notes,'Synthetic retained draft');
});

test('auth errors and disappeared rows close private dialogs, including history',async t=>{
  const f=fixture(t,{plans:[plan]});await f.api.load(1);f.click('[data-followups-action="edit"]');f.set('notes','PRIVATE_DRAFT_CANARY');f.rows.leader_followups=[];await f.api.load(1);assert.equal(f.form(),null);assert.doesNotMatch(f.w.document.body.textContent,/PRIVATE_DRAFT_CANARY/);
  f.rows.leader_followups=[structuredClone(plan)];await f.api.load(1);f.click('[data-followups-action="history"]');f.control.error={code:'42501',message:'PRIVATE_AUTH_CANARY'};await f.api.load(1);assert.equal(f.w.document.querySelector('dialog'),null);assert.equal(f.root.textContent,'');assert.doesNotMatch(f.w.document.body.textContent,/PRIVATE_AUTH_CANARY/);
});

test('viewer never reads and stale reads or saves cannot repaint a replacement session',async t=>{
  const v=fixture(t,{role:'viewer'});assert.equal(await v.api.load(1),false);v.api.openNew();assert.equal(v.calls.length,0);assert.equal(v.root.textContent,'');
  const f=fixture(t,{plans:[plan]});await f.api.load(1);f.click('[data-followups-action="edit"]');f.set('notes','PRIVATE_PENDING_DRAFT');let finish;f.control.hold=()=>new Promise(resolve=>finish=resolve);const saving=f.submit();await tick();f.setContext({epoch:2,userId:'replacement-owner',role:'editor',canEdit:true});f.api.clear();finish({data:{...plan,version:2},error:null});await saving;assert.equal(f.notices.length,0);assert.equal(f.refreshes(),0);assert.equal(f.form(),null);assert.equal(f.root.textContent,'');
  const g=fixture(t,{plans:[plan]});await g.api.load(1);const pending=[];g.control.hold=()=>new Promise(resolve=>pending.push(resolve));const loading=g.api.load(1);await tick();g.setContext({epoch:2,userId:null,role:null,canEdit:false});g.api.clear();pending.forEach(resolve=>resolve({data:[plan],error:null}));await loading;assert.equal(g.root.textContent,'');assert.equal(g.summaries.at(-1).items.length,0);
});

test('zero-row, wrong-owner and wrong-version write acknowledgements preserve drafts',async t=>{
  for(const mode of ['none','owner','version']){
    const f=fixture(t,{plans:[plan]});await f.api.load(1);f.click('[data-followups-action="edit"]');f.set('notes','Synthetic draft');if(mode==='none')f.control.noRows=true;else f.control.returnOverride=row=>({...row,...(mode==='owner'?{owner_id:'other-owner'}:{version:88})});await f.submit();assert.ok(f.form());assert.equal(f.form().elements.notes.value,'Synthetic draft');assert.match(f.form().textContent,/could not be confirmed/);assert.equal(f.refreshes(),0);assert.equal(f.notices.length,0);
  }
});

test('validation rejects future contact dates and overlong notes, preserving plain-text records',async t=>{
  const malicious='<img src=x onerror="window.unsafe=true">';const f=fixture(t,{plans:[{...plan,display_name:malicious,notes:malicious}],contacts:[{id:'sample-log',owner_id:'sample-owner',followup_id:plan.id,contacted_on:'2026-01-01',outcome:'connected',method:'phone',notes:malicious}]});await f.api.load(1);assert.equal(f.root.querySelector('img'),null);f.click('[data-followups-action="history"]');assert.equal(f.w.document.querySelector('img'),null);assert.match(f.w.document.querySelector('dialog').textContent,/<img src=x/);f.w.document.querySelector('[data-followups-close]').click();
  f.click('[data-followups-action="contact"]');f.set('contacted_on','2999-01-01');await f.submit(true);assert.equal(f.calls.some(q=>q.op==='rpc'),false);f.set('contacted_on',today());f.set('notes','x'.repeat(2001));await f.submit(true);assert.match(f.form().textContent,/2,000/);assert.equal(f.calls.some(q=>q.op==='rpc'),false);
});

test('pagination retains later plans and search makes bounded results reachable',async t=>{
  const plans=Array.from({length:1001},(_,i)=>({...plan,id:'sample-'+i,display_name:i===1000?'Final sample':'Sample '+i}));const f=fixture(t,{plans});await f.api.load(1);assert.equal(f.calls.filter(q=>q.table==='leader_followups').length,2);assert.equal(f.root.querySelectorAll('.followups-row').length,100);assert.match(f.root.textContent,/Showing 100 of 1001/);
  const search=f.root.querySelector('[data-followups-search]');search.value='Final sample';search.dispatchEvent(new f.w.Event('input',{bubbles:true}));assert.equal(f.root.querySelectorAll('.followups-row').length,1);assert.match(f.root.textContent,/Final sample/);
});


test('an uncertain committed create reconciles its stable id without inserting a duplicate',async t=>{
  const f=fixture(t);await f.api.load(1);f.api.openNew();f.set('display_name','Sample new leader');f.control.returnOverride=()=>null;await f.submit();
  assert.equal(f.rows.leader_followups.length,1);const id=f.calls.find(q=>q.op==='insert').data.id;assert.equal(f.rows.leader_followups[0].id,id);assert.match(id,/^[0-9a-f-]{36}$/);
  assert.equal(f.form().querySelector('[type="submit"]').disabled,true);assert.ok([...f.form().querySelectorAll('input,select,textarea')].every(node=>node.disabled),'draft fields remain frozen so later edits cannot be discarded by reconciliation');assert.equal(f.form().querySelector('[data-followups-retry]').disabled,false);assert.equal(f.form().querySelector('[data-followups-close]').disabled,false);await f.submit();assert.equal(f.calls.filter(q=>q.op==='insert').length,1);
  f.control.returnOverride=null;await f.api.load(1);assert.equal(f.form(),null);assert.equal(f.rows.leader_followups.length,1);assert.match(f.notices.at(-1).text,/plan was saved.*review/);
});

test('failed new-plan retry keeps its original id after a clean refresh',async t=>{
  const f=fixture(t);await f.api.load(1);f.api.openNew();f.set('display_name','Sample retry');f.control.noRows=true;await f.submit();const first=f.calls.find(q=>q.op==='insert').data.id;
  f.control.noRows=false;await f.api.load(1);assert.equal(f.form().querySelector('[type="submit"]').disabled,false);assert.ok([...f.form().querySelectorAll('input,select,textarea')].every(node=>!node.disabled));await f.submit();const writes=f.calls.filter(q=>q.op==='insert');assert.equal(writes.length,2);assert.equal(writes[1].data.id,first);assert.equal(f.rows.leader_followups.length,1);
});

test('pending saves freeze controls and validate the immutable submitted contact snapshot',async t=>{
  const f=fixture(t,{plans:[plan]});await f.api.load(1);f.click('[data-followups-action="contact"]');f.set('contacted_on','2026-02-01');f.set('outcome','connected');let finish;f.control.hold=()=>new Promise(resolve=>finish=resolve);const saving=f.submit();await tick();
  assert.ok([...f.w.document.querySelector('dialog').querySelectorAll('input,select,textarea,button')].every(node=>node.disabled));
  const dialog=f.w.document.querySelector('dialog');dialog.dispatchEvent(new f.w.Event('cancel',{cancelable:true}));assert.equal(f.w.document.querySelector('dialog'),dialog);
  f.set('contacted_on','2026-03-01');f.control.hold=null;finish({data:{id:plan.id,version:2,last_contact_on:'2026-02-01'},error:null});await saving;
  assert.equal(f.form(),null);assert.equal(f.refreshes(),1);assert.match(f.notices.at(-1).text,/Contact saved/);
});


test('dashboard navigation reveals upcoming leaders after earlier search and role filters',async t=>{
  const f=fixture(t,{plans:[plan,{...plan,id:'upcoming-plan',display_name:'Sample future leader',leadership_role:'council',first_due_on:addMonths(today(),1)}]});await f.api.load(1);
  const search=f.root.querySelector('[data-followups-search]'),role=f.root.querySelector('[data-followups-role]');search.value='No matching name';search.dispatchEvent(new f.w.Event('input',{bubbles:true}));role.value='deacon';role.dispatchEvent(new f.w.Event('change',{bubbles:true}));
  assert.equal(f.root.querySelectorAll('.followups-row').length,0);f.api.showView('upcoming');
  assert.equal(search.value,'');assert.equal(role.value,'');assert.equal(f.root.querySelector('[data-followups-view="upcoming"]').getAttribute('aria-pressed'),'true');assert.equal(f.root.querySelectorAll('.followups-row').length,1);assert.match(f.root.querySelector('.followups-row').textContent,/Sample future leader/);
  f.api.showView('invalid');assert.equal(f.root.querySelector('[data-followups-view="upcoming"]').getAttribute('aria-pressed'),'true');
  f.setContext({epoch:2,userId:null,role:null,canEdit:false});f.api.clear();f.api.showView('all');assert.equal(f.root.textContent,'');
});

test('whole-workspace outage preserves same-owner draft, clears private list, and recovers without erasing text',async t=>{
 const f=fixture(t,{plans:[plan]});await f.api.load(1);f.click('[data-followups-action="edit"]');f.set('notes','Synthetic unsaved personal note');
 f.setContext({epoch:1,userId:'sample-owner',role:'editor',canEdit:false,workspaceReady:false});f.api.render();await f.api.load(1);assert.equal(f.form().elements.notes.value,'Synthetic unsaved personal note');assert.equal(f.form().elements.notes.disabled,true);assert.equal(f.root.querySelector('[data-followups-list]').textContent,'');assert.equal(f.summaries.at(-1).due,null);
 f.setContext({epoch:1,userId:'sample-owner',role:'editor',canEdit:true,workspaceReady:true});await f.api.load(1);assert.equal(f.form().elements.notes.value,'Synthetic unsaved personal note');assert.equal(f.form().querySelector('[type=submit]').disabled,false);
});
test('personal writes await readiness and preserve frozen drafts when the live check fails',async t=>{
 const f=fixture(t,{plans:[plan]});await f.api.load(1);f.click('[data-followups-action="contact"]');f.set('notes','Synthetic contact draft');let verify;f.control.ensure=()=>new Promise(r=>verify=r);const saving=f.submit();await tick();assert.equal(f.form().elements.notes.disabled,true);assert.equal(f.calls.some(q=>q.op==='rpc'),false);
 f.setContext({epoch:1,userId:'sample-owner',role:'editor',canEdit:false,workspaceReady:false});verify(false);await saving;assert.equal(f.form().elements.notes.value,'Synthetic contact draft');assert.equal(f.form().querySelector('[type=submit]').disabled,true);assert.equal(f.calls.some(q=>q.op==='rpc'),false);
 f.setContext({epoch:2,userId:null,role:null,canEdit:false});f.api.render();assert.equal(f.form(),null);assert.equal(f.root.textContent,'');
});

test('a personal write timeout preserves its submitted draft and ignores late acknowledgement',async t=>{
 const f=fixture(t,{plans:[plan]});await f.api.load(1);f.click('[data-followups-action="contact"]');f.set('notes','Synthetic timed contact');let finish,expire;const real=f.w.setTimeout.bind(f.w);f.w.setTimeout=(fn,ms)=>ms===12000?(expire=fn,9999):real(fn,ms);f.control.hold=q=>new Promise(r=>finish=r);const saving=f.submit();await tick();expire();await saving;assert.equal(f.form().querySelector('[type=submit]').disabled,true);assert.equal(f.w.document.querySelector('[data-followups-close]').disabled,false);assert.equal(f.form().elements.notes.value,'Synthetic timed contact');finish({data:{id:plan.id,version:2,last_contact_on:today()}});await tick();assert.ok(f.form());assert.equal(f.notices.length,0);
});
