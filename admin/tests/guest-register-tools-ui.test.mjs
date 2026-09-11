import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const [toolsCode,signupsCode,intakeCode,index] = await Promise.all(['guest-register-tools.js','signups.js','intake-tasks.js','index.html'].map(p=>readFile(new URL('../'+p,import.meta.url),'utf8')));
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const flush=async()=>{await tick();await tick();};
const plain=value=>JSON.parse(JSON.stringify(value));
const sheetUrl='https://docs.google.com/spreadsheets/d/fictional_register_0123456789/edit';
const guest={id:'fictional-guest',first_name:'Fictional',last_name:'Guest',email:'guest@example.invalid',phone:null,preferred_contact:'email',contact_permission:true,version:2,staff_version:3,guest_lifecycle_version:1,reviewed_version:0,status:'pending',submitted_at:'2026-09-11T12:00:00Z',updated_at:'2026-09-11T12:00:00Z'};
const task={id:'fictional-task',kind:'guest_followup',registration_id:guest.id,prayer_request_id:null,created_at:'2026-09-11T12:00:00Z',due_on:'2020-01-01',status:'new',assigned_staff_user_id:null,routing:'office',version:1,completed_at:null,completed_by:null,notification_status:'queued'};

function fixture(t,options={}) {
  const dom=new JSDOM('<section id="host"></section>',{url:'https://example.invalid/admin/',runScripts:'outside-only'}),w=dom.window;
  t.after(()=>w.close());
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  w.HTMLAnchorElement.prototype.click=function(){};
  w.confirm=()=>true;
  let ctx={epoch:1,userId:'fictional-admin',role:options.role||'admin',canEdit:options.role!=='viewer',workspaceReady:true};
  const control={row:structuredClone(options.row||guest),rows:structuredClone(options.rows||[guest]),tasks:structuredClone(options.tasks||[task]),settings:{version:1,settings_version:0,sheet_url:sheetUrl},canOpen:()=>true};
  const calls=[],notices=[],counts=[],summaries=[],csv=[],timers=new Map();let refreshes=0,timerId=100000;
  const originalSet=w.setTimeout.bind(w),originalClear=w.clearTimeout.bind(w);
  w.setTimeout=(fn,ms)=>ms===12000?(timers.set(++timerId,fn),timerId):originalSet(fn,ms);
  w.clearTimeout=id=>timers.has(id)?timers.delete(id):originalClear(id);
  w.Blob=class {constructor(chunks){this.content=chunks.join('');}};
  w.URL.createObjectURL=blob=>{csv.push(blob.content);return 'blob:https://example.invalid/fictional';};w.URL.revokeObjectURL=()=>{};
  const db={rpc(name,args){
    calls.push({name,args:plain(args)});
    if(control.rpc)return Promise.resolve(control.rpc(name,args));
    if(name==='get_guest_lifecycle_readiness')return Promise.resolve(control.capability||{data:{available:true,version:1}});
    if(name==='get_guest_sheet_settings')return Promise.resolve(control.settingsResponse||{data:plain(control.settings)});
    if(name==='direct_intake_readiness')return Promise.resolve({data:{available:true,version:1,tasks:true,routes:true}});
    if(name==='get_intake_settings')return Promise.resolve({data:{version:1,routes:[{kind:'guest_followup',version:1,assigned_staff_user_id:null},{kind:'prayer_care',version:1,assigned_staff_user_id:null}],staff:[]}});
    if(control.write)return Promise.resolve(control.write(name,args));
    if(name==='set_guest_sheet_settings'){control.settings={version:1,settings_version:args.p_version+1,sheet_url:args.p_sheet_url};return Promise.resolve({data:plain(control.settings)});}
    return Promise.resolve({data:{id:args.p_id,removed:args.p_removed,lifecycle_version:args.p_lifecycle_version+1}});
  },from(table){
    const q={table},chain={select(){return chain;},order(){return chain;},range(a,b){q.range=[a,b];return chain;},then(resolve,reject){
      calls.push(q);const rows=table==='app_submission_tasks'?control.tasks:control.rows;
      return Promise.resolve(control.read?control.read(q):{data:structuredClone(rows.slice(q.range?.[0]||0,q.range?q.range[1]+1:undefined)),count:rows.length}).then(resolve,reject);
    }};return chain;
  }};
  const host=w.document.querySelector('#host');let api;
  const shared={root:host,db,getContext:()=>ctx,isCurrent:e=>ctx.epoch===e&&!!ctx.userId,ensureReady:async e=>control.ensure?control.ensure(e):true,notice:m=>notices.push(m),refresh:async()=>{refreshes++;if(control.refresh)await control.refresh();},people:()=>[{id:'fictional-person',first_name:'Fictional',last_name:'Person',status:'active'}],peopleReady:()=>true,onCount:n=>counts.push(n),onSummary:v=>summaries.push(v&&plain(v)),sourceLabel:()=> 'Fictional source',intakeTask:()=>null};
  if(!options.missingTools)w.eval(toolsCode);
  if(options.mode==='signups'){w.eval(signupsCode);api=w.CreekSignups.create(shared);}
  else if(options.mode==='intake'){w.eval(intakeCode);api=w.CreekIntakeTasks.create(shared);}
  else {host.innerHTML='<div data-toolbar></div><div data-actions></div>';api=w.CreekGuestRegisterTools.create({...shared,canOpen:()=>control.canOpen(),onChange:paint});}
  function paint(){api.toolbar(host.querySelector('[data-toolbar]'));const actions=host.querySelector('[data-actions]');actions.replaceChildren();api.rowAction(actions,control.row);}
  function button(text,within=host){return Array.from(within.querySelectorAll('button')).find(n=>n.textContent===text);}
  const form=()=>w.document.querySelector('[data-guest-sheet] form');
  return {w,host,api,control,calls,notices,counts,summaries,csv,paint,button,form,context:()=>ctx,setContext:c=>{ctx=c;},refreshes:()=>refreshes,
    writes:()=>calls.filter(c=>c.name?.startsWith('set_')),expire:()=>{assert.ok(timers.size,'a bounded request is pending');for(const [id,fn] of [...timers]){timers.delete(id);fn();}},
    async confirmRemoval(){w.document.querySelector('[data-guest-removal] footer button:last-child').click();await flush();},
    async saveLink(value){form().elements.sheet_url.value=value;form().dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await flush();},
  };
}
function unload(f){const e=new f.w.Event('beforeunload',{cancelable:true});f.w.dispatchEvent(e);return e.defaultPrevented;}

test('only current admins with positive lifecycle capability and row versions can remove or restore',async t=>{
  for(const role of ['viewer','editor','admin']){
    const f=fixture(t,{role});await f.api.load(1);f.paint();
    assert.equal(!!f.button('Remove guest visit'),role==='admin');
    f.api.openRemoval(guest);assert.equal(!!f.w.document.querySelector('[data-guest-removal]'),role==='admin');
    if(role==='viewer')assert.equal(f.calls.length,0);
  }
  for(const cap of [{error:{code:'PGRST202'}},{data:{version:1,available:'true'}},{data:{version:2,available:true}}]){
    const f=fixture(t);f.control.capability=cap;assert.equal(await f.api.load(1),false);f.paint();assert.equal(f.button('Remove guest visit'),undefined);f.api.openRemoval(guest);assert.equal(f.w.document.querySelector('dialog'),null);
  }
  const f=fixture(t);await f.api.load(1);f.control.row.guest_lifecycle_version=0;f.paint();assert.equal(f.button('Remove guest visit'),undefined);
});

test('removal and restoration send exact versioned intent only after confirmation, with truthful preservation text',async t=>{
  for(const restoring of [false,true]){
    const f=fixture(t,{row:{...guest,guest_removed_at:restoring?'2026-09-11T12:00:00Z':null}});await f.api.load(1);f.paint();
    f.button(restoring?'Restore guest visit':'Remove guest visit').click();
    assert.equal(f.writes().length,0);assert.match(f.w.document.querySelector('dialog').textContent,/login, linked People record, membership history and any separate care plans stay in place/);
    if(restoring)assert.match(f.w.document.querySelector('dialog').textContent,/does not send another welcome email/);
    await f.confirmRemoval();assert.equal(f.writes().length,1);
    const args=f.writes()[0].args;assert.equal(f.writes()[0].name,'set_guest_registration_removed');assert.match(args.p_request_id,/^[0-9a-f-]{36}$/);delete args.p_request_id;
    assert.deepEqual(args,{p_id:guest.id,p_version:2,p_staff_version:3,p_lifecycle_version:1,p_removed:!restoring});
    assert.equal(f.refreshes(),1);assert.equal(unload(f),false);assert.equal(f.w.document.querySelector('dialog'),null);
  }
});

test('timeout retains the immutable request for explicit retry and suppresses a late old result',async t=>{
  const f=fixture(t);await f.api.load(1);let finish;
  f.control.write=()=>new Promise(resolve=>finish=resolve);f.api.openRemoval(f.control.row);await f.confirmRemoval();
  assert.equal(unload(f),true);f.paint();assert.equal(f.button('Retry same guest-visit change').disabled,true);
  f.expire();await flush();f.paint();assert.equal(f.button('Retry same guest-visit change').disabled,false);assert.equal(f.refreshes(),0);
  const first=plain(f.writes()[0]);f.control.row.version=99;f.control.row.first_name='Changed display only';
  f.control.write=(_n,args)=>({data:{id:args.p_id,removed:true,lifecycle_version:2}});
  f.button('Retry same guest-visit change').click();await flush();assert.deepEqual(f.writes()[1],first);assert.equal(f.refreshes(),1);assert.equal(unload(f),false);
  finish({data:{id:guest.id,removed:false,lifecycle_version:99}});await flush();assert.equal(f.refreshes(),1);assert.equal(f.notices.length,1);
});

test('stale versions and permission denials clear the attempt, refresh, and never claim successful removal',async t=>{
  for(const code of ['40001','42501','22023']){
    const f=fixture(t);await f.api.load(1);f.control.write=()=>({error:{code,message:'PRIVATE_DATABASE_CANARY'}});f.api.openRemoval(guest);await f.confirmRemoval();f.paint();
    assert.equal(f.refreshes(),1);assert.equal(unload(f),false);assert.equal(f.button('Retry same guest-visit change'),undefined);assert.match(f.notices[0],/Refresh and review/);assert.doesNotMatch(f.notices.join(' '),/removal recorded|PRIVATE_DATABASE_CANARY/);
  }
});

test('malformed removal receipts remain uncertain and preserve the same retry rather than claiming success',async t=>{
  for(const data of [null,{id:'different',removed:true,lifecycle_version:2},{id:guest.id,removed:false,lifecycle_version:2},{id:guest.id,removed:true,lifecycle_version:3}]){
    const f=fixture(t);await f.api.load(1);f.control.write=()=>({data});f.api.openRemoval(guest);await f.confirmRemoval();f.paint();assert.equal(f.refreshes(),0);assert.equal(f.notices.length,0);assert.equal(unload(f),true);assert.ok(f.button('Retry same guest-visit change'));
  }
});

test('readiness recheck blocks writes; signout drops pending private state and ignores settlement',async t=>{
  const f=fixture(t);await f.api.load(1);f.control.ensure=()=>false;f.api.openRemoval(guest);await f.confirmRemoval();assert.equal(f.writes().length,0);assert.equal(unload(f),true);
  const g=fixture(t);await g.api.load(1);let finish;g.control.write=()=>new Promise(resolve=>finish=resolve);g.api.openRemoval(guest);await g.confirmRemoval();
  g.setContext({epoch:2,userId:null,role:null,canEdit:false,workspaceReady:false});g.api.clear();g.paint();finish({data:{id:guest.id,removed:true,lifecycle_version:2}});await flush();
  assert.equal(g.host.textContent,'');assert.equal(g.w.document.querySelector('dialog'),null);assert.equal(g.refreshes(),0);assert.equal(g.notices.length,0);assert.equal(unload(g),false);
});

test('a successful old removal cannot notify a replacement account after awaiting refresh',async t=>{
  const f=fixture(t);await f.api.load(1);let finishRefresh;
  f.control.refresh=()=>new Promise(resolve=>finishRefresh=resolve);
  f.api.openRemoval(guest);await f.confirmRemoval();assert.equal(f.refreshes(),1);assert.equal(f.notices.length,0);
  f.setContext({epoch:2,userId:'replacement-admin',role:'admin',canEdit:true,workspaceReady:true});f.api.clear();await f.api.load(2);
  finishRefresh();await flush();assert.equal(f.notices.length,0,'a completed old operation must not announce success in a replacement account');
});

test('valid private links have safe handoff attributes and invalid settings cannot render a link',async t=>{
  const f=fixture(t);await f.api.load(1);f.paint();const link=f.host.querySelector('a');assert.equal(link.href,sheetUrl);assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');assert.match(f.host.textContent,/last successful sync/);
  for(const url of ['javascript:alert(1)','https://docs.google.com.evil.invalid/spreadsheets/d/fictional_register_0123456789/edit','https://user:password@docs.google.com/spreadsheets/d/fictional_register_0123456789/edit','http://docs.google.com/spreadsheets/d/fictional_register_0123456789/edit','https://docs.google.com/spreadsheets/d/short/edit',sheetUrl+'?private=1',sheetUrl+'#gid=0']){
    f.control.settings.sheet_url=url;await f.api.load(1);f.paint();assert.equal(f.host.querySelector('a'),null);assert.doesNotMatch(f.host.innerHTML,/javascript:|password@|evil.invalid/);
  }
});

test('link save normalizes ordinary sharing suffixes and explains that saving a link does not configure sync',async t=>{
  const f=fixture(t);await f.api.load(1);f.paint();f.button('Change spreadsheet link').click();assert.match(f.form().textContent,/Automatic updates require.*configured separately/);
  const newUrl='https://docs.google.com/spreadsheets/d/fictional_replacement_9876543210/edit';await f.saveLink(newUrl+'?usp=sharing#gid=0');
  assert.deepEqual(f.writes(),[{name:'set_guest_sheet_settings',args:{p_version:0,p_sheet_url:newUrl}}]);assert.equal(f.form(),null);assert.match(f.notices[0],/link saved.*sync status/);assert.doesNotMatch(f.notices[0],/sync (?:connected|configured|successful)/i);
  f.paint();assert.equal(f.host.querySelector('a').href,newUrl);
});

test('invalid link submissions cannot write and an uncertain save requires refresh without automatic retry',async t=>{
  const f=fixture(t);await f.api.load(1);f.paint();f.button('Change spreadsheet link').click();await f.saveLink('https://example.invalid/spreadsheets/d/fictional_register_0123456789/edit');assert.equal(f.writes().length,0);assert.match(f.form().textContent,/ending in \/edit/);
  f.control.write=()=>({error:{code:'40001',message:'PRIVATE_LINK_CANARY'}});await f.saveLink(sheetUrl);assert.equal(f.writes().length,1);assert.match(f.form().textContent,/Close and refresh/);assert.doesNotMatch(f.form().textContent,/PRIVATE_LINK_CANARY/);assert.equal(f.form().querySelector('[type=submit]').disabled,true);assert.equal(f.form().querySelector('[data-sheet-close]').disabled,false);
  await f.saveLink(sheetUrl);assert.equal(f.writes().length,1,'disabled controls cannot be bypassed by synthetic submit');
});

test('signout and pause remove private links and dialogs; old reads cannot restore them',async t=>{
  for(const mode of ['pause','signout']){
    const f=fixture(t);await f.api.load(1);f.paint();f.button('Change spreadsheet link').click();
    if(mode==='pause'){f.setContext({...f.context(),canEdit:false,workspaceReady:false});f.api.unavailable();}
    else {f.setContext({epoch:2,userId:null,role:null,canEdit:false});f.api.clear();}
    f.paint();assert.equal(f.host.querySelector('a'),null);assert.equal(f.form(),null);assert.doesNotMatch(f.w.document.body.innerHTML,/fictional_register_0123456789/);
  }
  const f=fixture(t);let finish;f.control.rpc=()=>new Promise(resolve=>finish=resolve);const loading=f.api.load(1);await tick();f.setContext({epoch:2,userId:null,role:null,canEdit:false});f.api.clear();f.paint();finish({data:{version:1,settings_version:0,sheet_url:sheetUrl}});f.expire();await loading;f.paint();assert.equal(f.host.querySelector('a'),null);
});

test('confirmation side effects cannot reopen private removal or link dialogs after identity/readiness changes',async t=>{
  for(const action of ['removal','settings'])for(const mode of ['signout','pause','replacement']){
    const f=fixture(t);await f.api.load(1);f.paint();
    f.control.canOpen=()=>{if(mode==='pause'){f.setContext({...f.context(),canEdit:false,workspaceReady:false});f.api.unavailable();}else {f.setContext({epoch:2,userId:mode==='replacement'?'replacement-admin':null,role:mode==='replacement'?'admin':null,canEdit:mode==='replacement',workspaceReady:mode==='replacement'});f.api.clear();}return true;};
    if(action==='removal')f.api.openRemoval(guest);else f.button('Change spreadsheet link').click();
    assert.equal(f.w.document.querySelector('dialog'),null,action+' '+mode);assert.equal(f.writes().length,0);
  }
});

test('untrusted guest names stay literal text in recovery confirmation',async t=>{
  const f=fixture(t);await f.api.load(1);f.api.openRemoval({...guest,first_name:'<img src=x onerror=alert(1)>',last_name:'<script>window.privateLeak=1</script>'});
  assert.equal(f.w.document.querySelector('dialog img,dialog script'),null);assert.match(f.w.document.querySelector('h2').textContent,/<img/);assert.equal(f.w.privateLeak,undefined);
});

test('signups integration excludes removed visits from normal views/counts/exports and restricts recovery to restore',async t=>{
  const removed={...guest,id:'removed-fixture',first_name:'REMOVED_CANARY',guest_removed_at:'2026-09-11T13:00:00Z'};
  const archived={...guest,id:'archived-fixture',first_name:'ARCHIVED_CANARY',status:'archived'};
  const reviewed={...guest,id:'reviewed-fixture',first_name:'REVIEWED_CANARY',status:'reviewed',reviewed_version:2};
  const f=fixture(t,{mode:'signups',rows:[guest,removed,archived,reviewed]});assert.equal(await f.api.load(1),true);assert.equal(f.counts.at(-1),1);assert.equal(f.host.querySelectorAll('.signup-row').length,1);
  const filter=f.host.querySelector('[data-signup-filter]');filter.value='all';filter.dispatchEvent(new f.w.Event('change'));assert.equal(f.host.querySelectorAll('.signup-row').length,2);assert.doesNotMatch(f.host.textContent,/REMOVED_CANARY|ARCHIVED_CANARY/);
  f.host.querySelector('[data-signup-export]').click();assert.equal(f.csv.length,1);assert.doesNotMatch(f.csv[0],/REMOVED_CANARY|ARCHIVED_CANARY/);assert.match(f.csv[0],/REVIEWED_CANARY/);
  filter.value='removed';filter.dispatchEvent(new f.w.Event('change'));assert.equal(f.host.querySelectorAll('.signup-row').length,2);assert.match(f.host.textContent,/REMOVED_CANARY/);assert.equal(f.counts.at(-1),1);assert.equal(f.host.querySelector('[data-signup-export]').disabled,true);
  const exportButton=f.host.querySelector('[data-signup-export]');exportButton.disabled=false;exportButton.click();assert.equal(f.csv.length,1,'forced recovery-view export is rejected in the handler');
  assert.equal(f.host.querySelector('[data-guest-followup]'),null);assert.equal(f.host.querySelector('[data-signup-intake]'),null);assert.equal(f.api.open(removed.id),false);assert.equal(f.w.document.querySelector('dialog'),null);assert.equal(f.button('Restore guest visit')!==undefined,true);
});

test('missing optional module preserves old review behavior and still hides removed visits',async t=>{
  const f=fixture(t,{mode:'signups',missingTools:true,rows:[guest,{...guest,id:'removed',guest_removed_at:'2026-09-11T13:00:00Z'}]});assert.equal(await f.api.load(1),true);assert.equal(f.counts.at(-1),1);assert.equal(f.host.querySelectorAll('.signup-row').length,1);assert.equal(f.calls.some(c=>c.name?.startsWith('get_guest_')),false);assert.equal(f.api.open(guest.id),true);assert.ok(f.w.document.querySelector('[data-signup-id]'));assert.equal(f.host.querySelector('[data-guest-remove]'),null);
});

test('actual signups integration clears link and pending recovery state on workspace pause and signout',async t=>{
  const f=fixture(t,{mode:'signups'});await f.api.load(1);assert.ok(f.host.querySelector('[data-guest-tools] a'));f.button('Change spreadsheet link').click();assert.ok(f.form());
  f.setContext({...f.context(),canEdit:false,workspaceReady:false});f.api.render();assert.equal(f.form(),null);assert.equal(f.host.querySelector('a'),null);assert.equal(f.host.querySelector('[data-signup-export]').disabled,true);
  f.setContext({epoch:2,userId:null,role:null,canEdit:false});f.api.clear();assert.equal(f.host.textContent,'');assert.equal(f.counts.at(-1),null);
});

test('removed guest intake actions are excluded from counts, all filters, source lookup and editor navigation',async t=>{
  const f=fixture(t,{mode:'intake',tasks:[task,{...task,id:'removed-task',registration_id:'removed-guest',guest_removed_at:'2026-09-11T13:00:00Z'},{...task,id:'removed-completed',registration_id:'removed-guest-two',guest_removed_at:'2026-09-11T13:00:00Z',status:'completed',completed_at:'2026-09-11T14:00:00Z'}]});
  assert.equal(await f.api.load(1),true);assert.deepEqual(f.summaries.at(-1),{new:1,due:1,open:1});f.api.showFilter('all');assert.equal(f.host.querySelectorAll('[data-intake-row]').length,1);assert.equal(f.api.taskForSource('guest_followup','removed-guest'),null);assert.equal(f.api.openTask('removed-task'),false);assert.equal(f.w.document.querySelector('dialog'),null);
});

test('page loads optional tools before signups without introducing an external script',()=>{
  const parsed=new JSDOM(index);try{const scripts=Array.from(parsed.window.document.querySelectorAll('script[src]'),n=>n.getAttribute('src'));assert.ok(scripts.indexOf('guest-register-tools.js?v=guest-tools-1')>=0);assert.ok(scripts.findIndex(p=>p.startsWith('guest-register-tools.js'))<scripts.findIndex(p=>p.startsWith('signups.js')));}finally{parsed.window.close();}
});
