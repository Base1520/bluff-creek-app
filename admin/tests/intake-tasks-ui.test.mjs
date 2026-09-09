import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const code=await readFile(new URL('../intake-tasks.js',import.meta.url),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,0));
const plain=x=>JSON.parse(JSON.stringify(x));
const task={id:'task-fixture',kind:'guest_followup',registration_id:'guest-fixture',prayer_request_id:null,submitted_auth_user_id:'PRIVATE_AUTH_CANARY',created_at:'2026-09-09T01:00:00Z',due_on:'2020-01-02',status:'new',assigned_staff_user_id:null,routing:'office',version:1,completed_at:null,completed_by:null,notification_status:'queued'};
const initialSettings={version:1,routes:[{kind:'guest_followup',version:2,assigned_staff_user_id:null},{kind:'prayer_care',version:1,assigned_staff_user_id:null}],staff:[{id:'approved-fixture',label:'Fictional Staff <staff@example.invalid>'}]};
function fixture(t,opts={}){
 const dom=new JSDOM('<section id="intake"></section>',{url:'https://example.invalid/admin/',runScripts:'outside-only'}),w=dom.window;t.after(()=>w.close());
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.confirm=()=>true;w.eval(code);
 let ctx={epoch:1,userId:'fictional-owner',role:opts.role||'editor',canEdit:opts.role!=='viewer',workspaceReady:true};
 const control={rows:structuredClone(opts.rows||[task]),settings:structuredClone(initialSettings)},calls=[],notices=[],summaries=[],opened=[];let refreshes=0;
 const db={rpc(name,args){calls.push({name,args:plain(args)});if(name==='direct_intake_readiness')return control.capability?control.capability():Promise.resolve({data:{available:true,version:1,tasks:true,routes:true}});if(name==='get_intake_settings')return control.settingsRead?control.settingsRead():Promise.resolve({data:structuredClone(control.settings)});return control.write?control.write(name,args):Promise.resolve({data:name==='set_intake_route'?{kind:args.p_kind,version:args.p_version+1}:{id:args.p_id,version:args.p_version+1}});},from(table){assert.equal(table,'app_submission_tasks');const q={table};const chain={select(fields,options){q.fields=fields;q.selectOptions=options;return chain;},order(field,options){(q.order??=[]).push([field,options]);return chain;},range(a,b){q.range=[a,b];return chain;},then(resolve,reject){calls.push(q);return (control.read?control.read(q):Promise.resolve({data:structuredClone(control.rows.slice(q.range?.[0]||0,q.range?q.range[1]+1:undefined)),count:control.rows.length})).then(resolve,reject);}};if(opts.noRange)delete chain.range;return chain;}};
 const host=w.document.querySelector('section'),api=w.CreekIntakeTasks.create({root:host,db,getContext:()=>ctx,isCurrent:e=>ctx.epoch===e&&!!ctx.userId,ensureReady:e=>control.ensure?control.ensure(e):Promise.resolve(true),notice:m=>notices.push(m),onSummary:s=>summaries.push(s&&plain(s)),refresh:async()=>{refreshes++;},sourceLabel:(kind,id)=>opts.sourceLabel?.(kind,id)||'Fictional source',openSource:(kind,id)=>opened.push([kind,id])});
 const form=()=>w.document.querySelector('form'),submit=async()=>{form().dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();await tick();};
 return{w,host,api,control,calls,notices,summaries,opened,form,submit,setContext:c=>ctx=c,context:()=>ctx,refreshes:()=>refreshes,writes:()=>calls.filter(c=>['update_intake_task','set_intake_route'].includes(c.name))};
}
function change(f,name,value){const node=f.form().elements[name];node.value=value;node.dispatchEvent(new f.w.Event('change',{bubbles:true}));}
function unloadBlocked(f){const e=new f.w.Event('beforeunload',{cancelable:true});f.w.dispatchEvent(e);return e.defaultPrevented;}
function clock(f){let expire;const real=f.w.setTimeout.bind(f.w);f.w.setTimeout=(fn,ms)=>ms===12000?(expire=fn,9999):real(fn,ms);return()=>{assert.equal(typeof expire,'function');expire();};}

test('old baseline or invalid capability blocks only intake reads and writes; viewer reads nothing',async t=>{
 for(const result of [{error:{code:'PGRST202'}},{data:{available:true,version:1}},{data:{available:true,version:1,tasks:true,routes:false}},{data:{available:'true',version:1,tasks:true,routes:true}}]){
  const f=fixture(t);f.control.capability=()=>Promise.resolve(result);assert.equal(await f.api.load(1),false);assert.equal(f.calls.length,1);assert.equal(f.summaries.at(-1),null);f.api.openTask(task.id);f.api.openRoute('guest_followup');assert.equal(f.form(),null);assert.match(f.host.textContent,/unavailable/);
 }
 const f=fixture(t,{role:'viewer'});assert.equal(await f.api.load(1),false);assert.equal(f.calls.length,0);assert.equal(f.host.textContent,'');
});

test('counts use durable records and due dates, sources are escaped and open only after a staff click',async t=>{
 const f=fixture(t,{sourceLabel:()=>'<img src=x onerror=PRIVATE_CANARY>',rows:[task,{...task,id:'progress',status:'in_progress',due_on:'2999-01-01',notification_status:'attention',kind:'prayer_care',registration_id:null,prayer_request_id:'prayer-fixture'},{...task,id:'done',status:'completed',completed_at:'2026-09-09T12:00:00Z',notification_status:'sent'}]});
 assert.equal(await f.api.load(1),true);assert.deepEqual(f.summaries.at(-1),{new:1,due:1,open:2});assert.equal(f.host.querySelectorAll('[data-intake-row]').length,2);assert.equal(f.host.querySelector('img'),null);assert.doesNotMatch(f.host.textContent,/PRIVATE_AUTH_CANARY/);assert.match(f.host.textContent,/Office queue/);assert.equal(f.opened.length,0);
 f.host.querySelector('[data-intake-source]').click();assert.deepEqual(f.opened,[['guest_followup','guest-fixture']]);f.api.showFilter('due');assert.equal(f.host.querySelectorAll('[data-intake-row]').length,1);f.api.showFilter('completed');assert.match(f.host.textContent,/Provider accepted/);assert.match(f.host.textContent,/not confirmed delivery/);assert.match(f.host.textContent,/Completed Sep 9, 2026/);
 f.api.showFilter('all');const search=f.host.querySelector('[data-intake-search]');search.value='prayer care';search.dispatchEvent(new f.w.Event('input'));assert.equal(f.host.querySelectorAll('[data-intake-row]').length,1);assert.deepEqual(f.summaries.at(-1),{new:1,due:1,open:2});
});

test('server-capped pages retain every task, while malformed or shifting pages publish no partial totals',async t=>{
 const f=fixture(t,{rows:Array.from({length:601},(_,i)=>({...task,id:'task-'+i}))});f.control.read=q=>Promise.resolve({data:structuredClone(f.control.rows.slice(q.range[0],q.range[0]+500)),count:601});assert.equal(await f.api.load(1),true);assert.equal(f.summaries.at(-1).open,601);assert.deepEqual(f.calls.filter(c=>c.table).map(c=>c.range),[[0,999],[500,1499]]);assert.equal(f.host.querySelectorAll('[data-intake-row]').length,100);assert.match(f.host.textContent,/601 matching actions/);
 for(const bad of [{data:[],count:2},{data:[task],count:2},{data:[{...task,id:'second'}],count:3},{data:[{...task,id:'second'}]},{data:[{...task,id:'second',due_on:null}],count:2}]){
  const g=fixture(t);g.control.read=q=>Promise.resolve(q.range[0]===0?{data:[task],count:2}:bad);assert.equal(await g.api.load(1),false);assert.equal(g.summaries.at(-1),null);assert.equal(g.host.querySelector('table'),null);
 }
 const g=fixture(t,{rows:[],noRange:true});assert.equal(await g.api.load(1),true);assert.deepEqual(g.summaries.at(-1),{new:0,due:0,open:0});
});

test('invalid settings never expose partial tasks or arbitrary recipient inputs',async t=>{
 for(const settings of [{...initialSettings,version:2},{...initialSettings,routes:initialSettings.routes.slice(0,1)},{...initialSettings,staff:[initialSettings.staff[0],initialSettings.staff[0]]}]){
  const f=fixture(t);f.control.settings=settings;assert.equal(await f.api.load(1),false);assert.equal(f.host.querySelector('table'),null);assert.equal(f.summaries.at(-1),null);
 }
 const f=fixture(t,{role:'admin'});await f.api.load(1);f.api.openRoute('guest_followup');assert.equal(f.form().querySelector('input'),null);assert.equal(f.form().querySelectorAll('select option').length,2);assert.equal(f.form().elements.assigned_staff_user_id.options[1].textContent,initialSettings.staff[0].label);assert.equal(f.form().querySelector('staff'),null);
});

test('task save sends only allowed fields and expected version; completion and source fields remain server-owned',async t=>{
 const f=fixture(t);await f.api.load(1);f.api.openTask(task.id);assert.deepEqual(Array.from(f.form().querySelectorAll('[name]'),n=>n.name).sort(),['assigned_staff_user_id','due_on','status']);change(f,'assigned_staff_user_id','approved-fixture');change(f,'due_on','2026-10-01');change(f,'status','completed');await f.submit();
 assert.deepEqual(f.writes(),[{name:'update_intake_task',args:{p_id:task.id,p_version:1,p_changes:{assigned_staff_user_id:'approved-fixture',due_on:'2026-10-01',status:'completed'}}}]);assert.equal(f.form(),null);assert.equal(f.refreshes(),1);assert.match(f.notices[0],/separate notification status/);assert.equal(unloadBlocked(f),false);
});

test('required dates and forged assignees cannot write; administrators alone edit future routes',async t=>{
 const f=fixture(t);await f.api.load(1);f.api.openRoute('guest_followup');assert.equal(f.form(),null);assert.equal(f.host.querySelector('[data-intake-route]'),null);f.api.openTask(task.id);change(f,'due_on','');await f.submit();assert.equal(f.writes().length,0);change(f,'due_on','2026-10-01');f.form().elements.assigned_staff_user_id.add(new f.w.Option('Unapproved','outside-roster'));change(f,'assigned_staff_user_id','outside-roster');await f.submit();assert.equal(f.writes().length,0);assert.match(f.form().textContent,/eligible staff/);
 const g=fixture(t,{role:'admin'});await g.api.load(1);g.api.openRoute('guest_followup');change(g,'assigned_staff_user_id','approved-fixture');await g.submit();assert.deepEqual(g.writes(),[{name:'set_intake_route',args:{p_kind:'guest_followup',p_version:2,p_assigned_staff_user_id:'approved-fixture'}}]);assert.match(g.notices[0],/future submissions.*not reassigned/);assert.match(g.host.textContent,/existing tasks keep their own assignment/i);
 g.api.openRoute('prayer_care');await g.submit();assert.equal(g.writes()[1].args.p_assigned_staff_user_id,null);
});

test('route permission is rechecked after asynchronous workspace readiness',async t=>{
 const f=fixture(t,{role:'admin'});await f.api.load(1);f.api.openRoute('guest_followup');change(f,'assigned_staff_user_id','approved-fixture');let finish;f.control.ensure=()=>new Promise(r=>finish=r);const saving=f.submit();await tick();f.setContext({...f.context(),role:'editor'});finish(true);await saving;assert.equal(f.writes().length,0);assert.ok(f.form());assert.equal(f.form().querySelector('[type=submit]').disabled,true);
});

test('conflicts retain the draft, reject blind retries and redact backend error content',async t=>{
 const f=fixture(t);await f.api.load(1);f.api.openTask(task.id);change(f,'status','completed');f.control.write=()=>Promise.resolve({error:{code:'40001',message:'PRIVATE_DATABASE_CANARY'}});await f.submit();assert.equal(f.form().elements.status.value,'completed');assert.equal(f.form().querySelector('[type=submit]').disabled,true);assert.doesNotMatch(f.form().textContent,/PRIVATE_DATABASE_CANARY/);await f.submit();assert.equal(f.writes().length,1);
 f.control.rows[0].version=2;f.control.rows[0].status='in_progress';await f.api.load(1);assert.match(f.form().textContent,/record changed/);assert.equal(f.form().querySelector('[type=submit]').disabled,true);assert.equal(f.notices.length,0);
});

test('pending timeout blocks discard and repeated writes, then explicit same-payload retry requires a fresh read after settlement',async t=>{
 const f=fixture(t);await f.api.load(1);f.api.openTask(task.id);change(f,'status','in_progress');const expire=clock(f);let finish;f.control.write=()=>new Promise(r=>finish=r);const saving=f.submit();await tick();expire();await saving;assert.equal(f.form().querySelector('[type=submit]').disabled,true);assert.equal(f.form().querySelector('[data-intake-close]').disabled,true);assert.equal(unloadBlocked(f),true);
 f.form().querySelector('[data-intake-close]').click();f.w.document.querySelector('dialog').dispatchEvent(new f.w.Event('cancel',{cancelable:true}));assert.ok(f.form());await f.api.load(1);await f.submit();assert.equal(f.writes().length,1);
 finish({data:null});await tick();await f.submit();assert.equal(f.writes().length,1);await f.api.load(1);assert.equal(f.form().querySelector('[type=submit]').disabled,false);f.form().elements.status.value='completed';f.control.write=()=>Promise.resolve({data:{id:task.id,version:2}});await f.submit();assert.equal(f.writes().length,2);assert.deepEqual(f.writes()[1].args,f.writes()[0].args);assert.equal(f.form(),null);
});

test('a read begun before a late request settles cannot unlock a retained retry',async t=>{
 const f=fixture(t);await f.api.load(1);f.api.openTask(task.id);change(f,'status','in_progress');const expire=clock(f);let finish;f.control.write=()=>new Promise(r=>finish=r);const saving=f.submit();await tick();expire();await saving;
 let read;f.control.read=()=>new Promise(r=>read=r);const loading=f.api.load(1);await tick();finish({data:null});await tick();read({data:[task],count:1});await loading;assert.equal(f.form().querySelector('[type=submit]').disabled,true);f.control.read=null;await f.api.load(1);assert.equal(f.form().querySelector('[type=submit]').disabled,false);
});

test('a fresh saved-state match resolves uncertainty without a duplicate mutation',async t=>{
 const f=fixture(t);await f.api.load(1);f.api.openTask(task.id);change(f,'status','completed');f.control.write=()=>Promise.resolve({data:null});await f.submit();Object.assign(f.control.rows[0],{version:2,status:'completed',completed_at:'2026-09-09T12:00:00Z'});await f.api.load(1);assert.equal(f.form(),null);assert.equal(f.writes().length,1);assert.match(f.notices[0],/matches the submitted changes/);assert.equal(unloadBlocked(f),false);
});

test('draft warnings are memory-only and removed on revert, discard, confirmed save and immediate access clear',async t=>{
 const f=fixture(t);await f.api.load(1);f.api.openTask(task.id);assert.equal(unloadBlocked(f),false);change(f,'status','in_progress');assert.equal(unloadBlocked(f),true);const original=f.form();let questions=0;f.w.confirm=()=>{questions++;return false;};f.form().querySelector('[data-intake-close]').click();f.w.document.querySelector('dialog').dispatchEvent(new f.w.Event('cancel',{cancelable:true}));f.api.openTask(task.id);assert.equal(f.form(),original);assert.equal(questions,3);change(f,'status','new');assert.equal(unloadBlocked(f),false);f.form().querySelector('[data-intake-close]').click();assert.equal(f.form(),null);assert.equal(questions,3);
 f.api.openTask(task.id);change(f,'status','completed');f.w.confirm=()=>true;f.form().querySelector('[data-intake-close]').click();assert.equal(f.form(),null);assert.equal(unloadBlocked(f),false);f.api.openTask(task.id);change(f,'status','completed');f.api.clear();assert.equal(f.form(),null);assert.equal(unloadBlocked(f),false);assert.equal(f.w.localStorage.length,0);assert.equal(f.w.sessionStorage.length,0);
});

test('same-owner outage retains a locked draft, but capability denial clears private details',async t=>{
 const f=fixture(t);await f.api.load(1);f.api.openTask(task.id);change(f,'status','in_progress');f.setContext({...f.context(),canEdit:false,workspaceReady:false});f.api.render();assert.equal(f.form().elements.status.value,'in_progress');assert.equal(f.form().querySelector('[type=submit]').disabled,true);assert.equal(f.summaries.at(-1),null);f.setContext({...f.context(),canEdit:true,workspaceReady:true});await f.api.load(1);assert.equal(f.form().querySelector('[type=submit]').disabled,false);
 f.control.capability=()=>Promise.resolve({error:{code:'42501',message:'PRIVATE_PERMISSION_CANARY'}});await f.api.load(1);assert.equal(f.form(),null);assert.equal(f.host.textContent,'');assert.equal(unloadBlocked(f),false);
});

test('owner replacement prevents stale source handoffs, clears drafts and suppresses old write completions',async t=>{
 const f=fixture(t);await f.api.load(1);const source=f.host.querySelector('[data-intake-source]');f.api.openTask(task.id);change(f,'status','completed');let finish;f.control.write=()=>new Promise(r=>finish=r);const saving=f.submit();await tick();f.setContext({...f.context(),userId:'replacement-owner'});source.click();assert.equal(f.opened.length,0);f.api.render();assert.equal(f.form(),null);assert.equal(f.host.querySelector('table'),null);finish({data:{id:task.id,version:2}});await saving;assert.equal(f.notices.length,0);assert.equal(f.refreshes(),0);assert.equal(unloadBlocked(f),false);
});

test('old reads cannot replace a new account, and accepting discard rechecks ownership and fresh records',async t=>{
 const f=fixture(t);let finish;f.control.read=()=>new Promise(r=>finish=r);const loading=f.api.load(1);await tick();f.setContext({...f.context(),epoch:2,userId:'replacement-owner'});f.api.clear();f.control.read=null;f.control.rows=[];await f.api.load(2);finish({data:[task],count:1});await loading;assert.deepEqual(f.summaries.at(-1),{new:0,due:0,open:0});assert.equal(f.host.querySelector('table'),null);
 const g=fixture(t);await g.api.load(1);g.api.openTask(task.id);change(g,'status','completed');g.w.confirm=()=>{g.setContext({...g.context(),epoch:2,userId:null,role:null,canEdit:false});g.api.clear();return true;};g.api.openTask(task.id);assert.equal(g.form(),null);assert.equal(g.writes().length,0);assert.equal(unloadBlocked(g),false);
});

test('source lookup returns only routed task display fields and refuses stale identity or unavailable loads',async t=>{
 const f=fixture(t);await f.api.load(1);assert.deepEqual(plain(f.api.taskForSource('guest_followup','guest-fixture')),{id:task.id,due_on:task.due_on,status:'new',owner:'Office queue',notification_status:'queued'});assert.equal(f.api.taskForSource('prayer_care','guest-fixture'),null);f.setContext({...f.context(),userId:'replacement-owner'});assert.equal(f.api.taskForSource('guest_followup','guest-fixture'),null);f.api.clear();assert.equal(f.api.taskForSource('guest_followup','guest-fixture'),null);
});
