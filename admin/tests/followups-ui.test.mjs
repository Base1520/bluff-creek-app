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
  let ctx={epoch:1,userId:'sample-owner',role:opts.role||'editor',canEdit:true,workspaceReady:true},api,refreshes=0,next=1;
  const root=w.document.getElementById('followups'),calls=[],notices=[],summaries=[],control={error:null,hold:null,noRows:false,returnOverride:null,leakOwners:false};
  const rows={leader_followups:structuredClone(opts.plans||[]),leader_followup_contacts:structuredClone(opts.contacts||[])};
  const db={from(table){
    const q={table,op:'select',filters:[]};
    const chain={select(fields,settings){q.fields=fields;q.selectOptions=settings;return chain;},eq(key,value){q.filters.push([key,value]);return chain;},order(){return chain;},range(a,b){q.range=[a,b];return chain;},single(){q.single=true;return chain;},insert(data){q.op='insert';q.data=data;return chain;},update(data){q.op='update';q.data=data;return chain;},then(resolve,reject){
      calls.push(q);if(control.hold)return control.hold(q).then(resolve,reject);
      if(control.error)return Promise.resolve({error:control.error}).then(resolve,reject);
      let data,count;
      if(q.op==='select'){data=rows[table].filter(r=>control.leakOwners||q.filters.every(([key,value])=>r[key]===value));count=data.length;data=data.slice(q.range?.[0]||0,q.range?q.range[1]+1:undefined);}
      else if(control.noRows)data=null;
      else if(q.op==='insert'){data={id:'new-'+next++,owner_id:ctx.userId,version:1,last_contact_on:null,snoozed_until:null,...structuredClone(q.data)};rows[table].push(data);}
      else{data=rows[table].find(r=>q.filters.every(([key,value])=>r[key]===value));if(data)Object.assign(data,structuredClone(q.data),{version:data.version+1});}
      if(q.op!=='select'&&control.returnOverride)data=control.returnOverride(data);
      const result={data:structuredClone(data),count,error:null};
      return Promise.resolve(q.op==='select'&&control.read?control.read(q,result):result).then(resolve,reject);
    }};if(opts.noRange)delete chain.range;return chain;
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

test('a canceled parallel read stays unavailable after readiness returns until a fresh complete load',async t=>{
  for(const canceledTable of ['leader_followups','leader_followup_contacts']){
    const f=fixture(t,{plans:[plan],contacts:[{id:'sample-contact',owner_id:'sample-owner',followup_id:plan.id,contacted_on:'2026-01-01',outcome:'attempted',method:'phone',notes:'Fictional contact'}]});
    await f.api.load(1);f.click('[data-followups-action="edit"]');f.set('notes','Fictional retained draft');
    const pending={};f.control.read=(q,result)=>new Promise(resolve=>{pending[q.table]=()=>resolve(result);});
    const loading=f.api.load(1);await tick();
    f.setContext({epoch:1,userId:'sample-owner',role:'editor',canEdit:false,workspaceReady:false});f.api.render();
    pending[canceledTable]();await tick();
    f.setContext({epoch:1,userId:'sample-owner',role:'editor',canEdit:true,workspaceReady:true});
    pending[canceledTable==='leader_followups'?'leader_followup_contacts':'leader_followups']();
    assert.equal(await loading,false);assert.ok(f.form());assert.equal(f.form().elements.notes.value,'Fictional retained draft');
    assert.equal(f.form().querySelector('[type="submit"]').disabled,true);assert.equal(f.summaries.at(-1).due,null);assert.equal(f.root.querySelectorAll('.followups-row').length,0);
    await f.submit();assert.equal(f.calls.some(q=>q.op!=='select'),false);
    f.control.read=null;assert.equal(await f.api.load(1),true);assert.equal(f.form().elements.notes.value,'Fictional retained draft');assert.equal(f.form().querySelector('[type="submit"]').disabled,false);
    await f.submit();assert.equal(f.rows.leader_followups[0].notes,'Fictional retained draft');
  }
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

function unloadCancelled(f) {
  const event=new f.w.Event('beforeunload',{cancelable:true});f.w.dispatchEvent(event);return event.defaultPrevented;
}

test('reload listener exists only for changed personal forms and is removed on revert or close',async t=>{
  const f=fixture(t,{plans:[plan]}),listeners=new Set(),add=f.w.addEventListener.bind(f.w),remove=f.w.removeEventListener.bind(f.w);
  f.w.confirm=()=>true;
  f.w.addEventListener=(type,fn,...args)=>{if(type==='beforeunload')listeners.add(fn);return add(type,fn,...args);};
  f.w.removeEventListener=(type,fn,...args)=>{if(type==='beforeunload')listeners.delete(fn);return remove(type,fn,...args);};
  await f.api.load(1);assert.equal(listeners.size,0);assert.equal(unloadCancelled(f),false);
  f.api.openNew();assert.equal(listeners.size,0);f.w.document.querySelector('[data-followups-close]').click();assert.equal(listeners.size,0);
  for(const [kind,name,value] of [['edit','notes','Synthetic unsaved note'],['contact','method','email'],['snooze','snoozed_until',addMonths(today(),1)]]){
    f.click('[data-followups-action="'+kind+'"]');assert.equal(listeners.size,0);assert.equal(unloadCancelled(f),false);
    const initial=f.form().elements[name].value;const field=f.set(name,value);field.dispatchEvent(new f.w.Event('input',{bubbles:true}));
    assert.equal(listeners.size,1);assert.equal(unloadCancelled(f),true,kind+' unsaved work cancels the DOM event');
    f.set(name,value,true);assert.equal(listeners.size,1,'repeated edits do not register another listener');
    f.set(name,initial,true);assert.equal(listeners.size,0);assert.equal(unloadCancelled(f),false,'exact reversion removes the listener');
    f.set(name,value,true);f.w.document.querySelector('[data-followups-close]').click();assert.equal(listeners.size,0);assert.equal(unloadCancelled(f),false);
  }
  f.click('[data-followups-action="edit"]');f.set('paused',true,true);assert.equal(unloadCancelled(f),true);f.set('paused',false,true);assert.equal(unloadCancelled(f),false);f.w.document.querySelector('[data-followups-close]').click();
  f.click('[data-followups-action="history"]');f.rows.leader_followups[0].version++;await f.api.load(1);assert.equal(listeners.size,0);assert.equal(unloadCancelled(f),false,'read-only history never registers a draft warning');
});

test('unchanged contact submissions warn while pending and confirmed save or account clearing removes the warning',async t=>{
  const f=fixture(t,{plans:[plan]});await f.api.load(1);f.click('[data-followups-action="contact"]');assert.equal(unloadCancelled(f),false);
  let verify;f.control.ensure=()=>new Promise(resolve=>verify=resolve);const saving=f.submit();await tick();
  assert.equal(unloadCancelled(f),true,'submitting default contact fields is pending work even without prior edits');assert.equal(f.calls.some(q=>q.op==='rpc'),false);
  verify(true);await saving;await tick();assert.equal(f.form(),null);assert.equal(unloadCancelled(f),false);assert.match(f.notices.at(-1).text,/Contact saved/);
  const g=fixture(t,{plans:[plan]});await g.api.load(1);g.click('[data-followups-action="contact"]');let finish;g.control.hold=()=>new Promise(resolve=>finish=resolve);const pending=g.submit();await tick();assert.equal(unloadCancelled(g),true);
  g.setContext({epoch:2,userId:'replacement-owner',role:'editor',canEdit:true});g.api.clear();assert.equal(unloadCancelled(g),false);assert.equal(g.form(),null);
  finish({data:{id:plan.id,version:2,last_contact_on:today()},error:null});await pending;await tick();assert.equal(unloadCancelled(g),false);assert.equal(g.notices.length,0);assert.equal(g.refreshes(),0);
});

test('uncertain pristine contact saves and stale plan conflicts warn until reconciliation or dismissal',async t=>{
  const f=fixture(t,{plans:[plan]});f.w.confirm=()=>true;await f.api.load(1);f.click('[data-followups-action="contact"]');f.control.noRows=true;await f.submit();
  assert.equal(unloadCancelled(f),true,'an unconfirmed result still needs attention when form values were unchanged');assert.match(f.form().textContent,/could not be confirmed/);
  f.control.error={message:'Synthetic unavailable'};await f.api.load(1);assert.equal(unloadCancelled(f),true);
  f.control.error=null;f.control.noRows=false;await f.api.load(1);assert.equal(unloadCancelled(f),false,'refresh found no changed version and the form is pristine');f.w.document.querySelector('[data-followups-close]').click();
  f.click('[data-followups-action="edit"]');f.rows.leader_followups[0].version++;await f.api.load(1);assert.equal(unloadCancelled(f),true);assert.match(f.form().textContent,/plan changed/);
  f.w.document.querySelector('[data-followups-close]').click();assert.equal(unloadCancelled(f),false);
  f.click('[data-followups-action="edit"]');f.set('notes','Synthetic draft',true);f.rows.leader_followups=[];await f.api.load(1);assert.equal(f.form(),null);assert.equal(unloadCancelled(f),false,'a removed row closes its private draft');
});

test('dirty follow-up save, uncertain create reconciliation, and auth failure all release their draft warning',async t=>{
  const f=fixture(t,{plans:[plan]});await f.api.load(1);f.click('[data-followups-action="edit"]');f.set('notes','Synthetic saved note',true);assert.equal(unloadCancelled(f),true);await f.submit();assert.equal(f.form(),null);assert.equal(unloadCancelled(f),false);
  f.api.openNew();f.set('display_name','Sample new leader',true);f.control.returnOverride=()=>null;await f.submit();assert.ok(f.form());assert.equal(unloadCancelled(f),true);
  f.control.returnOverride=null;await f.api.load(1);assert.equal(f.form(),null);assert.equal(unloadCancelled(f),false);assert.equal(f.calls.filter(q=>q.op==='insert').length,1);
  f.click('[data-followups-action="edit"]');f.set('notes','Synthetic private draft',true);assert.equal(unloadCancelled(f),true);
  f.control.error={code:'42501'};await f.api.load(1);assert.equal(f.form(),null);assert.equal(unloadCancelled(f),false);assert.equal(f.root.textContent,'');
});

test('personal Close, Escape and replacement preserve changed drafts unless discard is accepted',async t=>{
  const f=fixture(t,{plans:[plan]});let confirmations=0,accept=false;f.w.confirm=()=>{confirmations++;return accept;};await f.api.load(1);
  f.click('[data-followups-action="edit"]');f.w.document.querySelector('[data-followups-close]').click();assert.equal(confirmations,0);assert.equal(f.form(),null);
  f.click('[data-followups-action="edit"]');f.set('notes','Synthetic retained draft',true);const form=f.form(),dialog=f.w.document.querySelector('dialog');
  f.w.document.querySelector('[data-followups-close]').click();assert.equal(f.form(),form);assert.equal(confirmations,1);
  const escape=new f.w.Event('cancel',{cancelable:true});dialog.dispatchEvent(escape);assert.equal(escape.defaultPrevented,true);assert.equal(f.form(),form);assert.equal(confirmations,2);
  f.click('[data-followups-action="contact"]');assert.equal(f.form(),form);assert.equal(confirmations,3);assert.equal(f.form().elements.notes.value,'Synthetic retained draft');assert.equal(unloadCancelled(f),true);
  accept=true;f.click('[data-followups-action="contact"]');assert.notEqual(f.form(),form);assert.equal(f.form().elements.notes.value,'');assert.equal(unloadCancelled(f),false);assert.equal(confirmations,4);
  f.set('notes','Synthetic contact draft',true);f.w.document.querySelector('dialog').dispatchEvent(new f.w.Event('cancel',{cancelable:true}));assert.equal(f.form(),null);assert.equal(unloadCancelled(f),false);assert.equal(confirmations,5);
  f.click('[data-followups-action="edit"]');f.set('notes','Synthetic clear draft',true);accept=false;f.api.clear();assert.equal(confirmations,5);assert.equal(f.form(),null);assert.equal(unloadCancelled(f),false,'auth clearing does not wait for a discard confirmation');
});

test('replacement after discard confirmation refuses changed owner, epoch, readiness or a cleared workspace',async t=>{
  for(const mode of ['owner','epoch','readiness','cleared']){
    const f=fixture(t,{plans:[plan]});await f.api.load(1);f.click('[data-followups-action="contact"]');f.set('notes','Synthetic replacement draft',true);
    f.w.confirm=()=>{
      if(mode==='owner')f.setContext({epoch:1,userId:'replacement-owner',role:'editor',canEdit:true});
      if(mode==='epoch')f.setContext({epoch:2,userId:'sample-owner',role:'editor',canEdit:true});
      if(mode==='readiness')f.setContext({epoch:1,userId:'sample-owner',role:'editor',canEdit:false,workspaceReady:false});
      if(mode==='cleared')f.api.clear();
      return true;
    };
    f.click('[data-followups-action="edit"]');assert.equal(f.form(),null,mode+' change must not reopen a private form');assert.equal(unloadCancelled(f),false);assert.equal(f.calls.some(q=>q.op!=='select'),false);
  }
});

test('personal history follows actual returned page sizes and retains later contacts',async t=>{
  const contacts=Array.from({length:600},(_,i)=>({id:'capped-history-'+i,followup_id:plan.id,owner_id:plan.owner_id,contacted_on:'2026-09-01',created_at:'2026-09-01T12:00:00Z',method:'phone',outcome:'attempted',notes:i===599?'Final fictional contact':'Fictional attempt'}));
  const f=fixture(t,{plans:[plan],contacts});f.control.read=(q,result)=>({...result,data:result.data.slice(0,500)});
  assert.equal(await f.api.load(1),true);f.click('[data-followups-action="history"]');
  assert.equal(f.w.document.querySelectorAll('.followups-history article').length,600);assert.match(f.w.document.querySelector('dialog').textContent,/Final fictional contact/);
  assert.deepEqual(f.calls.filter(q=>q.table==='leader_followup_contacts').map(q=>q.range),[[0,999],[500,1499]]);
  assert.ok(f.calls.every(q=>q.selectOptions.count==='exact'));
});

test('invalid personal history pages clear incomplete lists while preserving a locked plan draft',async t=>{
  const first={id:'first-history',owner_id:plan.owner_id,followup_id:plan.id},second={...first,id:'second-history'};
  for(const response of [{data:null,count:2},{data:[],count:2},{data:[second]},{data:[second],count:3},
      {data:[second],count:-1},{data:[second],count:1.5},{data:[first],count:2},{data:[{id:''}],count:2},
      {data:[second,{...second,id:'overflow'}],count:2}]){
    const f=fixture(t,{plans:[plan],contacts:[first,second]});assert.equal(await f.api.load(1),true);
    f.click('[data-followups-action="edit"]');f.set('notes','Keep this fictional leader draft');
    f.control.read=(q,result)=>q.table!=='leader_followup_contacts'?result:q.range[0]===0?{data:[first],count:2}:response;
    assert.equal(await f.api.load(1),false);assert.equal(f.summaries.at(-1).due,null);
    assert.equal(f.form().elements.notes.value,'Keep this fictional leader draft');assert.equal(f.form().querySelector('[type="submit"]').disabled,true);
    assert.equal(f.root.querySelectorAll('.followups-row').length,0);
  }
});

test('personal reads without range accept only an exactly complete response',async t=>{
  const f=fixture(t,{plans:[plan],noRange:true});assert.equal(await f.api.load(1),true);
  f.control.read=(q,result)=>q.table==='leader_followups'?{data:[plan],count:2}:result;
  assert.equal(await f.api.load(1),false);assert.equal(f.summaries.at(-1).due,null);
});

test('personal paging cannot continue into an owner replacement after the first held page',async t=>{
  const f=fixture(t,{plans:[plan]});let release;
  f.control.read=(q,result)=>q.table==='leader_followups'?new Promise(resolve=>release=resolve):result;
  const loading=f.api.load(1);await tick();f.setContext({epoch:2,userId:'another-fictional-owner',role:'editor',canEdit:true});f.api.clear();
  release({data:[plan],count:2});await loading;
  assert.equal(f.calls.filter(q=>q.table==='leader_followups').length,1);assert.equal(f.root.textContent,'');assert.equal(f.summaries.at(-1).due,null);
});


test('replacement owner or session clears personal drafts before unavailable-workspace preservation',async t=>{
  for(const entry of ['render','load']){
    for(const replacement of [{epoch:2,userId:'replacement-owner'},{epoch:1,userId:'replacement-owner'},{epoch:2,userId:'sample-owner'}]){
      const f=fixture(t,{plans:[plan]});await f.api.load(1);f.click('[data-followups-action="edit"]');f.set('notes','OLD_OWNER_PRIVATE_CANARY',true);
      assert.equal(unloadCancelled(f),true);
      f.setContext({...replacement,role:'editor',canEdit:false,workspaceReady:false});
      if(entry==='render')f.api.render();else assert.equal(await f.api.load(replacement.epoch),false);
      assert.equal(f.form(),null,entry+' clears the former identity draft before retaining outage state');
      assert.doesNotMatch(f.w.document.body.textContent,/OLD_OWNER_PRIVATE_CANARY|Sample leader/);
      assert.equal(f.summaries.at(-1).items.length,0);assert.equal(unloadCancelled(f),false);
      assert.equal(f.calls.some(q=>q.op!=='select'),false);
      f.setContext({...replacement,role:'editor',canEdit:true,workspaceReady:true});
      assert.equal(await f.api.load(replacement.epoch),true);f.api.openNew();
      assert.ok(f.form());assert.equal(f.form().elements.notes.value,'');
    }
  }
});

const attentionPlain = value => value === null ? null : JSON.parse(JSON.stringify(value));
test('leader attention reuses month-end and snooze rules, ignores filters and excludes other owners and private notes',async t=>{
  const plans=[
    {...plan,id:'due-leader',display_name:'Fictional due leader',last_contact_on:'2024-01-31',notes:'PRIVATE_LEADER_NOTE',email:'PRIVATE_EMAIL_CANARY'},
    {...plan,id:'overdue-leader',first_due_on:'2024-02-28',leadership_role:'council'},
    {...plan,id:'unscheduled-leader',first_due_on:null},
    {...plan,id:'snoozed-leader',last_contact_on:'2024-01-31',snoozed_until:'2024-03-10'},
    {...plan,id:'paused-leader',paused:true},
    {...plan,id:'future-leader',first_due_on:'2024-04-01'},
    {...plan,id:'other-owner',owner_id:'someone-else',display_name:'PRIVATE_OTHER_OWNER'}
  ];const f=fixture(t,{plans,contacts:[{id:'note',owner_id:plan.owner_id,followup_id:'due-leader',notes:'PRIVATE_CONTACT_NOTE'}]});f.control.leakOwners=true;assert.equal(f.api.attentionSnapshot('2024-02-29'),null);await f.api.load(1);
  const snapshot=attentionPlain(f.api.attentionSnapshot('2024-02-29'));assert.equal(snapshot.items.length,3);
  assert.deepEqual(snapshot.items[0],{key:'leader:due-leader',category:'leaders',source_type:'leader',source_id:'due-leader',contact_id:null,care_role:null,title:'Fictional due leader',owner_label:'You',due_on:'2024-02-29',reasons:['leader_due_today']});
  assert.deepEqual(snapshot.items[1].reasons,['leader_overdue']);assert.equal(snapshot.items[2].due_on,null);assert.deepEqual(snapshot.items[2].reasons,['leader_unscheduled']);assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_|notes|email|team_name|owner_id/);
  f.api.showView('paused');const search=f.root.querySelector('[data-followups-search]');search.value='nothing matches';search.dispatchEvent(new f.w.Event('input',{bubbles:true}));const role=f.root.querySelector('[data-followups-role]');role.value='other';role.dispatchEvent(new f.w.Event('change',{bubbles:true}));assert.deepEqual(attentionPlain(f.api.attentionSnapshot('2024-02-29')),snapshot);
  assert.equal(f.api.attentionSnapshot('2024-03-10').items.find(row=>row.source_id==='snoozed-leader').reasons[0],'leader_due_today');assert.equal(f.api.attentionSnapshot('2024-03-01').items.find(row=>row.source_id==='due-leader').reasons[0],'leader_overdue');
  snapshot.items[0].title='tampered';snapshot.items[0].reasons.push('tampered');assert.doesNotMatch(JSON.stringify(f.api.attentionSnapshot('2024-02-29')),/tampered/);assert.ok(f.calls.every(call=>call.op==='select'));
});
test('leader attention uses the existing day cadence across DST and falls back from invalid comparison dates',async t=>{
  const f=fixture(t,{plans:[{...plan,last_contact_on:'2026-03-01',cadence_months:null,cadence_days:7}]});await f.api.load(1);
  const item=f.api.attentionSnapshot('2026-03-08').items[0];assert.equal(item.due_on,'2026-03-08');assert.equal(item.reasons[0],'leader_due_today');assert.deepEqual(attentionPlain(f.api.attentionSnapshot('2026-02-30')),attentionPlain(f.api.attentionSnapshot()));
});
test('leader attention goes unavailable synchronously during refresh and after incomplete data or identity/readiness loss',async t=>{
  const f=fixture(t,{plans:[plan]});await f.api.load(1);assert.ok(f.api.attentionSnapshot());let release;f.control.read=(q,result)=>q.table==='leader_followup_contacts'?new Promise(resolve=>release=()=>resolve(result)):result;
  const pending=f.api.load(1);assert.equal(f.api.attentionSnapshot(),null);assert.equal(f.api.openFromAttention(plan.id),false);await tick();release();await pending;assert.ok(f.api.attentionSnapshot());
  const base={epoch:1,userId:'sample-owner',role:'editor',canEdit:true,workspaceReady:true};
  for(const change of [{workspaceReady:false},{workspaceReady:undefined},{canEdit:false},{role:'viewer'},{userId:'replacement'},{epoch:2},{userId:null}]){f.setContext({...base,...change});assert.equal(f.api.attentionSnapshot(),null);assert.equal(f.api.openFromAttention(plan.id),false);}
  f.setContext(base);f.control.read=null;f.control.error={message:'PRIVATE_FAILURE'};await f.api.load(1);assert.equal(f.api.attentionSnapshot(),null);assert.equal(f.api.openFromAttention(plan.id),false);f.control.error=null;await f.api.load(1);assert.ok(f.api.attentionSnapshot());f.api.clear();assert.equal(f.api.attentionSnapshot(),null);
});
test('a late leader refresh cannot restore an attention snapshot for a replaced owner or session',async t=>{
  for(const replacement of [{userId:'replacement',epoch:1},{userId:'sample-owner',epoch:2}]){
    const f=fixture(t,{plans:[plan]});await f.api.load(1);let release;f.control.read=(q,result)=>q.table==='leader_followups'?new Promise(resolve=>release=()=>resolve(result)):result;const pending=f.api.load(1);await tick();f.setContext({...replacement,role:'editor',canEdit:true,workspaceReady:true});assert.equal(f.api.attentionSnapshot(),null);release();await pending;assert.equal(f.api.attentionSnapshot(),null);assert.equal(f.api.openFromAttention(plan.id),false);
  }
});
test('opening a leader from attention bypasses search without writing and respects discarded, dirty and uncertain drafts',async t=>{
  const other={...plan,id:'other-plan',display_name:'Second fictional leader'};const f=fixture(t,{plans:[plan,other]});await f.api.load(1);f.api.showView('paused');assert.equal(f.api.openFromAttention('missing'),false);assert.equal(f.api.openFromAttention(null),false);assert.equal(f.api.openFromAttention(plan.id),true);assert.equal(f.form().querySelector('[type="submit"]').textContent,'Save contact');assert.match(f.w.document.querySelector('dialog').textContent,/Sample leader/);
  f.set('notes','Fictional unsaved contact',true);f.w.confirm=()=>false;assert.equal(f.api.openFromAttention(other.id),false);assert.equal(f.form().elements.notes.value,'Fictional unsaved contact');
  f.w.confirm=()=>true;assert.equal(f.api.openFromAttention(other.id),true);assert.match(f.w.document.querySelector('dialog').textContent,/Second fictional leader/);assert.equal(f.form().elements.notes.value,'');assert.ok(f.calls.every(call=>call.op==='select'));
  let release;f.control.hold=q=>q.op==='rpc'?new Promise(resolve=>release=resolve):Promise.resolve({data:[],count:0});f.set('notes','Fictional pending save',true);await f.submit();assert.equal(f.api.attentionSnapshot(),null);assert.equal(f.api.openFromAttention(plan.id),false);release({data:null,error:null});await tick();await tick();assert.equal(f.api.attentionSnapshot(),null);assert.equal(f.api.openFromAttention(plan.id),false);assert.equal(f.form().elements.notes.value,'Fictional pending save');
});
test('attention navigation rechecks owner and loading state after a dirty-draft discard decision',async t=>{
  for(const action of ['owner','loading']){
    const f=fixture(t,{plans:[plan]});await f.api.load(1);f.api.openNew();f.set('notes','Fictional draft',true);let pending,release;
    f.w.confirm=()=>{if(action==='owner')f.setContext({epoch:1,userId:'replacement',role:'editor',canEdit:true,workspaceReady:true});else {f.control.read=(q,result)=>q.table==='leader_followups'?new Promise(resolve=>release=()=>resolve(result)):result;pending=f.api.load(1);}return true;};
    assert.equal(f.api.openFromAttention(plan.id),false);assert.equal(f.form(),null);assert.ok(f.calls.every(call=>call.op==='select'));if(pending){await tick();release();await pending;}
  }
});
