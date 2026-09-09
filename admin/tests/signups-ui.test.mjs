import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const code=await readFile(new URL('../signups.js',import.meta.url),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,0));
const row={id:'sample-signup',first_name:'Sample',last_name:'Connection',email:'sample@example.invalid',phone:null,preferred_contact:'email',contact_permission:true,version:1,reviewed_version:0,status:'pending',submitted_at:'2026-09-07T12:00:00Z',updated_at:'2026-09-07T12:00:00Z'};
function fixture(t,opts={}){
 const dom=new JSDOM('<section id="signups"></section>',{url:'https://example.invalid/admin/',runScripts:'outside-only'}),w=dom.window;t.after(()=>w.close());
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.confirm=()=>true;w.eval(code);
 let ctx={epoch:1,userId:'sample-staff',role:opts.role||'editor',canEdit:opts.role!=='viewer'},rows=opts.rows||[{...row}],refreshes=0;
 const calls=[],notices=[],counts=[],control={peopleReady:true,directIntake:opts.directIntake===true};const db={from(table){const q={table};const chain={select(fields,settings){q.fields=fields;q.selectOptions=settings;return chain},order(){return chain},range(a,b){q.range=[a,b];return chain},then(resolve,reject){calls.push(q);return (control.read?control.read(q):Promise.resolve({data:rows.slice(q.range?.[0]||0,q.range?q.range[1]+1:undefined),count:rows.length})).then(resolve,reject)}};if(opts.noRange)delete chain.range;return chain},rpc:async(name,args)=>{if(name==='direct_intake_readiness')return control.capability?control.capability():{data:{available:control.directIntake,version:1}};calls.push({name,args});if(control.write)return control.write(name,args);return{data:{id:row.id,version:row.version,contact_id:'sample-person',status:'reviewed'}}}};
 const host=w.document.getElementById('signups'),people=[{id:'sample-person',first_name:'Sample',last_name:'Person',email:'sample@example.invalid',status:'active'}];let api;
 api=w.CreekSignups.create({root:host,db,people:()=>people,peopleReady:()=>control.peopleReady,getContext:()=>ctx,ensureReady:async epoch=>control.ensure?await control.ensure(epoch):true,isCurrent:e=>ctx.epoch===e&&!!ctx.userId,notice:m=>notices.push(m),onCount:n=>counts.push(n),intakeTask:id=>control.intakeTask?.(id)||null,openIntakeTask:id=>{(control.openedTasks??=[]).push(id);},refresh:async()=>{refreshes++;}});
 const form=()=>w.document.querySelector('form');
 const submit=async()=>{form().dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();await tick();};
 return{api,w,host,counts,calls,notices,control,form,submit,refreshes:()=>refreshes,setContext:n=>ctx=n};
}
test('pending signup and profile updates counted; user content is text, reviewed rows filter separately',async t=>{
 const f=fixture(t,{rows:[{...row,first_name:'<img src=x onerror=alert(1)>'},{...row,id:'update',contact_id:'sample-person',version:3,reviewed_version:2},{...row,id:'done',status:'reviewed',reviewed_version:1}]});await f.api.load(1);
 assert.equal(f.counts.at(-1),2);assert.equal(f.host.querySelectorAll('.signup-row').length,2);assert.equal(f.host.querySelector('img'),null);assert.match(f.host.textContent,/Profile update/);
 const filter=f.host.querySelector('select');filter.value='reviewed';filter.dispatchEvent(new f.w.Event('change'));assert.equal(f.host.querySelectorAll('.signup-row').length,1);
});
test('review requires explicit identity check and verified returned result',async t=>{
 const f=fixture(t);await f.api.load(1);f.api.open(row.id);f.form().elements.contact_id.value='sample-person';await f.submit();assert.equal(f.calls.some(c=>c.name),false);
 f.form().elements.identity_checked.checked=true;f.form().elements.welcome_owner.value='Sample welcome team';await f.submit();
 const c=f.calls.find(c=>c.name);assert.equal(c.name,'review_app_connection');assert.equal(c.args.p_version,1);assert.equal(c.args.p_create_person,false);assert.equal(c.args.p_contact_id,'sample-person');assert.equal(c.args.p_welcome_owner,'Sample welcome team');assert.equal(f.form(),null);assert.equal(f.refreshes(),1);
});
test('new visitor uses atomic review RPC; no separate People inserts or automatic merge',async t=>{
 const f=fixture(t);await f.api.load(1);f.api.open(row.id);assert.equal(f.form().elements.contact_id.value,'');f.form().elements.contact_id.value='__new';f.form().elements.identity_checked.checked=true;await f.submit();
 const c=f.calls.find(c=>c.name);assert.equal(c.args.p_create_person,true);assert.equal(c.args.p_contact_id,null);assert.equal(f.calls.filter(c=>c.name).length,1);
});
test('linked profile update keeps reviewed identity fixed and does not overwrite contact fields',async t=>{
 const f=fixture(t,{rows:[{...row,version:2,reviewed_version:1,contact_id:'sample-person'}]});await f.api.load(1);f.api.open(row.id);assert.equal(f.form().elements.contact_id.value,'sample-person');assert.equal(f.form().elements.contact_id.disabled,true);assert.equal(f.form().elements.person_search.disabled,true);
 f.control.write=()=>Promise.resolve({data:{id:row.id,version:2,contact_id:'sample-person',status:'reviewed'}});f.form().elements.identity_checked.checked=true;await f.submit();
 const args=f.calls.find(c=>c.name).args;assert.equal(args.p_version,2);assert.equal('first_name' in args,false);assert.equal('email' in args,false);
});
test('stale/uncertain review outcomes preserve drafts and never claim saved',async t=>{
 for(const result of [{data:null},{data:{id:row.id,version:99,status:'reviewed',contact_id:'sample-person'}},{error:{message:'PRIVATE_DATABASE_CANARY'}}]){
  const f=fixture(t);await f.api.load(1);f.api.open(row.id);f.form().elements.contact_id.value='__new';f.form().elements.identity_checked.checked=true;f.form().elements.staff_notes.value='Synthetic review draft';f.control.write=()=>Promise.resolve(result);await f.submit();
  assert.equal(f.refreshes(),0);assert.equal(f.notices.length,0);assert.equal(f.form().elements.staff_notes.value,'Synthetic review draft');assert.match(f.form().textContent,/could not be confirmed/);assert.doesNotMatch(f.form().textContent,/PRIVATE_DATABASE_CANARY/);
 }
});
test('viewer gets no private reads; signout clears profile/dialog and late reads and writes',async t=>{
 const v=fixture(t,{role:'viewer'});await v.api.load(1);assert.equal(v.calls.length,0);assert.equal(v.host.textContent,'');
 const f=fixture(t);await f.api.load(1);f.api.open(row.id);f.form().elements.contact_id.value='__new';f.form().elements.identity_checked.checked=true;let finish;f.control.write=()=>new Promise(r=>finish=r);const saving=f.submit();await tick();
 f.setContext({epoch:2,userId:null,role:null,canEdit:false});f.api.clear();finish({data:{id:row.id,version:1,contact_id:'sample-person',status:'reviewed'}});await saving;assert.equal(f.host.textContent,'');assert.equal(f.form(),null);assert.equal(f.notices.length,0);assert.equal(f.refreshes(),0);assert.equal(f.counts.at(-1),null);
 const g=fixture(t);let read;g.control.read=()=>new Promise(r=>read=r);const loading=g.api.load(1);await tick();g.setContext({epoch:2,userId:null,role:null,canEdit:false});g.api.clear();read({data:[row]});await loading;assert.equal(g.host.textContent,'');
});
test('refresh failures preserve review drafts while disabling writes; sign-out still clears them',async t=>{
 const f=fixture(t);await f.api.load(1);f.api.open(row.id);f.form().elements.staff_notes.value='Synthetic draft';await f.api.load(1);assert.equal(f.form().elements.staff_notes.value,'Synthetic draft');
 f.control.read=()=>Promise.resolve({error:{message:'PRIVATE_DATABASE_CANARY'}});await f.api.load(1);assert.ok(f.form());assert.equal(f.form().elements.staff_notes.value,'Synthetic draft');f.form().elements.contact_id.value='__new';f.form().elements.identity_checked.checked=true;await f.submit();assert.equal(f.calls.some(c=>c.name),false);assert.equal(f.host.querySelectorAll('.signup-row').length,0);assert.equal(f.counts.at(-1),null);assert.doesNotMatch(f.host.textContent,/PRIVATE_DATABASE_CANARY/);
});
test('pagination loads later signups and limits visible results without hiding search matches',async t=>{
 const f=fixture(t,{rows:Array.from({length:1001},(_,i)=>({...row,id:'sample-'+i,first_name:i===1000?'Final match':'Sample '+i}))});await f.api.load(1);assert.equal(f.host.querySelectorAll('.signup-row').length,100);assert.equal(f.counts.at(-1),1001);
 const search=f.host.querySelector('input');search.value='Final match';search.dispatchEvent(new f.w.Event('input'));assert.equal(f.host.querySelectorAll('.signup-row').length,1);assert.equal(f.calls.length,2);
});

test('identity review is blocked after People fails to load or becomes unavailable during review',async t=>{
 const f=fixture(t);f.control.peopleReady=false;await f.api.load(1);f.api.open(row.id);assert.equal(f.form(),null);assert.equal(f.host.querySelector('.signup-row button').disabled,true);
 f.control.peopleReady=true;await f.api.load(1);f.api.open(row.id);f.form().elements.contact_id.value='__new';f.form().elements.identity_checked.checked=true;f.control.peopleReady=false;await f.submit();assert.equal(f.calls.some(c=>c.name),false);assert.match(f.form().textContent,/People list and signup queue must be available/);
});
test('concurrent review cannot silently confirm another identity and explicit repeats do not claim draft changes saved',async t=>{
 const f=fixture(t);await f.api.load(1);f.api.open(row.id);f.form().elements.contact_id.value='sample-person';f.form().elements.identity_checked.checked=true;f.control.write=()=>Promise.resolve({data:{id:row.id,version:1,contact_id:'different-person',status:'reviewed'}});await f.submit();assert.ok(f.form());assert.equal(f.notices.length,0);
 f.control.write=()=>Promise.resolve({data:{id:row.id,version:1,contact_id:'sample-person',status:'reviewed',already_reviewed:true}});await f.api.load(1);await f.submit();assert.equal(f.form(),null);assert.match(f.notices[0],/draft changes were not applied/);
});

test('confirmed permission loss clears an open review instead of retaining private draft details',async t=>{
 const f=fixture(t);await f.api.load(1);f.api.open(row.id);f.form().elements.staff_notes.value='Synthetic private review';f.control.read=()=>Promise.resolve({error:{code:'42501',message:'denied'}});await f.api.load(1);assert.equal(f.form(),null);assert.doesNotMatch(f.w.document.body.textContent,/Synthetic private review/);
});

test('signup reviews preserve drafts on workspace outage and check readiness before writing',async t=>{
 const f=fixture(t);await f.api.load(1);f.api.open(row.id);f.form().elements.contact_id.value='__new';f.form().elements.identity_checked.checked=true;change(f,'staff_notes','Synthetic review draft');
 f.setContext({epoch:1,userId:'sample-staff',role:'editor',canEdit:false,workspaceReady:false});f.api.render();await f.api.load(1);assert.equal(f.form().elements.staff_notes.value,'Synthetic review draft');assert.equal(f.form().elements.staff_notes.disabled,true);assert.equal(f.host.querySelectorAll('.signup-row').length,0);assert.equal(unloadBlocked(f),true);
 f.setContext({epoch:1,userId:'sample-staff',role:'editor',canEdit:true,workspaceReady:true});await f.api.load(1);assert.equal(f.form().elements.staff_notes.disabled,false);
 f.control.ensure=()=>false;await f.submit();assert.equal(f.calls.some(c=>c.name),false);assert.ok(f.form());assert.equal(f.form().querySelector('[type=submit]').disabled,true);
});
test('pending signup review freezes fields and close, snapshots the request, and requires refresh after uncertainty',async t=>{
 const f=fixture(t);await f.api.load(1);f.api.open(row.id);f.form().elements.contact_id.value='sample-person';f.form().elements.identity_checked.checked=true;f.form().elements.staff_notes.value='Synthetic original notes';let finish;f.control.write=()=>new Promise(r=>finish=r);const saving=f.submit();await tick();
 assert.equal(f.form().elements.staff_notes.disabled,true);assert.equal(f.form().elements.contact_id.disabled,true);f.w.document.querySelector('[data-signup-close]').click();f.w.document.querySelector('dialog').dispatchEvent(new f.w.Event('cancel',{cancelable:true}));assert.ok(f.form());
 f.form().elements.staff_notes.value='Synthetic late mutation';assert.equal(f.calls.find(c=>c.name).args.p_staff_notes,'Synthetic original notes');finish({data:null});await saving;
 assert.equal(f.form().querySelector('[type=submit]').disabled,true);await f.submit();assert.equal(f.calls.filter(c=>c.name).length,1);await f.api.load(1);assert.equal(f.form().querySelector('[type=submit]').disabled,false);
});
test('changed signup version during refresh preserves review draft and blocks stale identity decisions',async t=>{
 const changed={...row};const f=fixture(t,{rows:[changed]});await f.api.load(1);f.api.open(row.id);f.form().elements.staff_notes.value='Synthetic review';changed.version=2;await f.api.load(1);assert.equal(f.form().elements.staff_notes.value,'Synthetic review');assert.equal(f.form().querySelector('[type=submit]').disabled,true);assert.match(f.form().textContent,/signup changed/);
});

test('a signup RPC timeout unlocks Close but requires refresh before another review request',async t=>{
 const f=fixture(t);await f.api.load(1);f.api.open(row.id);f.form().elements.contact_id.value='__new';f.form().elements.identity_checked.checked=true;let expire,finish;const real=f.w.setTimeout.bind(f.w);f.w.setTimeout=(fn,ms)=>ms===12000?(expire=fn,9999):real(fn,ms);f.control.write=()=>new Promise(r=>finish=r);const saving=f.submit();await tick();expire();await saving;assert.equal(f.form().querySelector('[type=submit]').disabled,true);assert.equal(f.w.document.querySelector('[data-signup-close]').disabled,false);assert.match(f.form().textContent,/could not be confirmed/);finish({data:{id:row.id,version:1,status:'reviewed',contact_id:'sample-person'}});await tick();assert.ok(f.form());assert.equal(f.notices.length,0);
});

function unloadBlocked(f){const event=new f.w.Event('beforeunload',{cancelable:true});f.w.dispatchEvent(event);return event.defaultPrevented;}
function change(f,name,value){const input=f.form().elements[name];if(input.type==='checkbox')input.checked=value;else input.value=value;input.dispatchEvent(new f.w.Event('change',{bubbles:true}));}

test('signup draft changes warn before reload or accidental close; pristine, discarded and saved reviews do not',async t=>{
 const f=fixture(t);await f.api.load(1);assert.equal(unloadBlocked(f),false);f.api.open(row.id);assert.equal(unloadBlocked(f),false);
 change(f,'person_search','Sample');assert.equal(unloadBlocked(f),false,'filtering alone is not a changed review');
 change(f,'staff_notes','Synthetic unsaved review');assert.equal(unloadBlocked(f),true);
 let questions=0;f.w.confirm=()=>{questions++;return false;};const original=f.form();
 f.w.document.querySelector('[data-signup-close]').click();assert.equal(f.form(),original);
 f.w.document.querySelector('dialog').dispatchEvent(new f.w.Event('cancel',{cancelable:true}));assert.equal(f.form(),original);
 f.api.open(row.id);assert.equal(f.form(),original);assert.equal(questions,3,'same review cannot silently replace its draft');
 change(f,'staff_notes','');assert.equal(unloadBlocked(f),false);f.w.document.querySelector('[data-signup-close]').click();assert.equal(f.form(),null);assert.equal(questions,3);
 f.api.open(row.id);change(f,'welcome_owner','Synthetic welcome team');f.w.confirm=()=>true;f.w.document.querySelector('[data-signup-close]').click();assert.equal(f.form(),null);assert.equal(unloadBlocked(f),false);
 f.api.open(row.id);change(f,'contact_id','sample-person');change(f,'identity_checked',true);assert.equal(unloadBlocked(f),true);await f.submit();assert.equal(f.form(),null);assert.equal(unloadBlocked(f),false);
 assert.equal(f.w.localStorage.length,0);assert.equal(f.w.sessionStorage.length,0);
});

test('pending or unresolved signup reviews warn until confirmation, explicit discard or immediate access clearing',async t=>{
 const changed={...row};const f=fixture(t,{rows:[changed]});await f.api.load(1);f.api.open(row.id);change(f,'contact_id','sample-person');change(f,'identity_checked',true);
 let finish;f.control.write=()=>new Promise(resolve=>finish=resolve);const saving=f.submit();await tick();assert.equal(unloadBlocked(f),true);
 let questions=0;f.w.confirm=()=>{questions++;return true;};f.api.open(row.id);assert.equal(questions,0,'pending write cannot be discarded');
 finish({data:null});await saving;assert.equal(unloadBlocked(f),true);
 changed.status='reviewed';changed.reviewed_version=changed.version;await f.api.load(1);assert.equal(f.form(),null);assert.equal(unloadBlocked(f),false,'saved reconciliation removes warning');
 f.api.open(row.id);assert.equal(unloadBlocked(f),false,'read-only reviewed details are not a draft');f.w.document.querySelector('[data-signup-close]').click();
 changed.status='pending';changed.reviewed_version=0;await f.api.load(1);f.api.open(row.id);change(f,'staff_notes','Synthetic retained note');changed.version=2;await f.api.load(1);assert.equal(unloadBlocked(f),true,'version conflict keeps unsaved review protected');
 f.setContext({epoch:2,userId:null,role:null,canEdit:false});f.api.clear();assert.equal(f.form(),null);assert.equal(unloadBlocked(f),false);assert.equal(questions,0,'access clearing never waits on a discard prompt');
});

test('accepting a discard cannot recreate a signup dialog after access or readiness changes',async t=>{
 for(const mode of ['signed-out','offline','people-unavailable']){
  const f=fixture(t);await f.api.load(1);f.api.open(row.id);change(f,'staff_notes','Synthetic private review');
  f.w.confirm=()=>{
   if(mode==='signed-out'){f.setContext({epoch:2,userId:null,role:null,canEdit:false});f.api.clear();}
   else if(mode==='offline'){f.setContext({epoch:1,userId:'sample-staff',role:'editor',canEdit:false,workspaceReady:false});f.api.render();}
   else f.control.peopleReady=false;
   return true;
  };
  f.api.open(row.id);assert.equal(f.form(),null);assert.equal(f.w.document.querySelector('dialog'),null);assert.equal(unloadBlocked(f),false);
  assert.equal(f.calls.some(c=>c.name),false);
 }
});

test('an older signup discard decision cannot clear a replacement review',async t=>{
 const f=fixture(t);await f.api.load(1);f.api.open(row.id);change(f,'staff_notes','Synthetic first draft');let replacement;
 f.w.confirm=()=>{f.w.confirm=()=>true;f.api.open(row.id);replacement=f.form();change(f,'staff_notes','Synthetic replacement draft');return true;};
 f.api.open(row.id);assert.equal(f.form(),replacement);assert.equal(f.form().elements.staff_notes.value,'Synthetic replacement draft');assert.equal(unloadBlocked(f),true);
 f.api.clear();assert.equal(unloadBlocked(f),false);
});

test('signup totals and search include a smaller server-capped second page',async t=>{
  const rows=Array.from({length:600},(_,i)=>({...row,id:'capped-signup-'+i,first_name:i===599?'Final capped signup':'Fictional '+i}));
  const f=fixture(t,{rows});f.control.read=q=>Promise.resolve({data:rows.slice(q.range[0],q.range[0]+500),count:rows.length});
  assert.equal(await f.api.load(1),true);assert.equal(f.counts.at(-1),600);
  const search=f.host.querySelector('input');search.value='Final capped signup';search.dispatchEvent(new f.w.Event('input'));
  assert.equal(f.host.querySelectorAll('.signup-row').length,1);assert.deepEqual(f.calls.map(q=>q.range),[[0,999],[500,1499]]);
  assert.ok(f.calls.every(q=>q.selectOptions.count==='exact'));
});

test('signup updated across the page boundary fails the load instead of silently omitting it',async t=>{
  const rows=Array.from({length:1001},(_,i)=>({...row,id:'shifted-'+i,first_name:i===1000?'Updated fictional signup':'Fictional '+i}));
  const f=fixture(t,{rows});let shifted=false;
  f.control.read=q=>{if(q.range[0]===1000&&!shifted){const updated=rows.pop();updated.updated_at='2026-09-09T12:00:00Z';rows.unshift(updated);shifted=true;}
    return Promise.resolve({data:structuredClone(rows.slice(q.range[0],q.range[1]+1)),count:rows.length});};
  assert.equal(await f.api.load(1),false);assert.equal(f.counts.at(-1),null);assert.equal(f.host.querySelectorAll('.signup-row').length,0);
  assert.match(f.host.querySelector('[data-signup-status]').textContent,/could not load/);
  assert.equal(await f.api.load(1),true);assert.equal(f.counts.at(-1),1001);
  const search=f.host.querySelector('input');search.value='Updated fictional signup';search.dispatchEvent(new f.w.Event('input'));
  assert.equal(f.host.querySelectorAll('.signup-row').length,1,'an explicit stable refresh includes the previously omitted update');
});

test('malformed signup pages keep a review draft locked and never publish a partial count',async t=>{
  const second={...row,id:'second-signup'};
  for(const response of [{data:null,count:2},{data:[],count:2},{data:[second]},{data:[second],count:3},
      {data:[second],count:-1},{data:[second],count:1.5},{data:[row],count:2},{data:[{...second,id:' '}],count:2},
      {data:[second,{...second,id:'overflow'}],count:2}]){
    const f=fixture(t,{rows:[row,second]});assert.equal(await f.api.load(1),true);f.api.open(row.id);f.form().elements.staff_notes.value='Keep this fictional identity review';
    f.control.read=q=>Promise.resolve(q.range[0]===0?{data:[row],count:2}:response);
    assert.equal(await f.api.load(1),false);assert.equal(f.counts.at(-1),null);
    assert.equal(f.form().elements.staff_notes.value,'Keep this fictional identity review');assert.equal(f.form().querySelector('[type="submit"]').disabled,true);
    assert.equal(f.host.querySelectorAll('.signup-row').length,0);
  }
});

test('signup no-range fallback requires a complete counted response and accepts genuine zero',async t=>{
  const f=fixture(t,{noRange:true,rows:[]});assert.equal(await f.api.load(1),true);assert.equal(f.counts.at(-1),0);
  f.control.read=()=>Promise.resolve({data:[row],count:1});assert.equal(await f.api.load(1),true);assert.equal(f.counts.at(-1),1);
  f.control.read=()=>Promise.resolve({data:[row],count:2});assert.equal(await f.api.load(1),false);assert.equal(f.counts.at(-1),null);
});

test('signup pagination stops on account clear before requesting a subsequent page',async t=>{
  const f=fixture(t);let release;f.control.read=()=>new Promise(resolve=>release=resolve);
  const loading=f.api.load(1);await tick();f.setContext({epoch:2,userId:null,role:null,canEdit:false});f.api.clear();
  release({data:[row],count:2});await loading;
  assert.equal(f.calls.length,1);assert.equal(f.host.textContent,'');assert.equal(f.counts.at(-1),null);
});

test('signup identity replacement clears private reviews before the unavailable-workspace path',async t=>{
 for(const entry of ['render','load'])for(const replacement of ['owner','epoch','both']){
  const f=fixture(t);await f.api.load(1);f.api.open(row.id);change(f,'staff_notes','Fictional previous-session review');
  let questions=0;f.w.confirm=()=>{questions++;return false;};assert.equal(unloadBlocked(f),true);
  const ctx={epoch:replacement==='owner'?1:2,userId:replacement==='epoch'?'sample-staff':'replacement-staff',role:'editor',canEdit:false,workspaceReady:false};
  f.setContext(ctx);if(entry==='load')await f.api.load(ctx.epoch);else f.api.render();
  assert.equal(f.form(),null,entry+' clears '+replacement+' replacement');
  assert.equal(f.w.document.querySelector('dialog'),null);assert.equal(f.host.querySelectorAll('.signup-row').length,0);
  assert.doesNotMatch(f.w.document.body.textContent,/Fictional previous-session review/);
  assert.equal(unloadBlocked(f),false);assert.equal(questions,0);assert.equal(f.counts.at(-1),null);assert.equal(f.calls.length,1,'no reads while replacement workspace is unavailable');
  f.setContext({...ctx,canEdit:true,workspaceReady:true});await f.api.load(ctx.epoch);f.api.open(row.id);
  assert.equal(f.form().elements.staff_notes.value,'');assert.equal(unloadBlocked(f),false);
 }
});

test('a prior identity read cannot restore old signups over a replacement review',async t=>{
 const f=fixture(t);await f.api.load(1);f.api.open(row.id);change(f,'staff_notes','Fictional first account draft');
 let finish;f.control.read=()=>new Promise(resolve=>finish=resolve);const loading=f.api.load(1);await tick();
 const replacement={epoch:1,userId:'replacement-staff',role:'editor',canEdit:false,workspaceReady:false};f.setContext(replacement);f.api.render();
 assert.equal(f.form(),null);assert.equal(unloadBlocked(f),false);
 f.setContext({...replacement,canEdit:true,workspaceReady:true});f.control.read=()=>Promise.resolve({data:[{...row,first_name:'Replacement queue'}],count:1});
 await f.api.load(1);f.api.open(row.id);change(f,'staff_notes','Fictional replacement draft');const currentForm=f.form();
 finish({data:[{...row,first_name:'Old queued result',version:2}],count:1});assert.equal(await loading,false);
 assert.equal(f.form(),currentForm);assert.equal(f.form().elements.staff_notes.value,'Fictional replacement draft');assert.equal(unloadBlocked(f),true);
 assert.match(f.host.textContent,/Replacement queue/);assert.doesNotMatch(f.host.textContent,/Old queued result/);assert.equal(f.counts.at(-1),1);
 assert.equal(f.form().querySelector('[type=submit]').disabled,false);assert.equal(f.calls.length,3);
});

test('captured signup identity blocks delayed readiness and save completion even before the next render',async t=>{
 for(const stage of ['readiness','save']){
  const f=fixture(t);await f.api.load(1);f.api.open(row.id);change(f,'contact_id','sample-person');change(f,'identity_checked',true);
  let finish;if(stage==='readiness')f.control.ensure=()=>new Promise(resolve=>finish=resolve);else f.control.write=()=>new Promise(resolve=>finish=resolve);
  await f.submit();assert.equal(unloadBlocked(f),true);
  f.setContext({epoch:1,userId:'replacement-staff',role:'editor',canEdit:true,workspaceReady:true});
  finish(stage==='readiness'?true:{data:{id:row.id,version:1,contact_id:'sample-person',status:'reviewed'}});await tick();await tick();
  assert.equal(f.calls.filter(c=>c.name).length,stage==='readiness'?0:1,'readiness cannot authorize a prior owner request');
  assert.equal(f.refreshes(),0);assert.equal(f.notices.length,0,'an old save cannot report success to the replacement owner');
  f.api.render();assert.equal(f.form(),null);assert.equal(unloadBlocked(f),false);assert.equal(f.host.querySelectorAll('.signup-row').length,0);
 }
});

test('a cleared signup save cannot close or unlock a replacement account review',async t=>{
 for(const outcome of ['confirmed','rejected']){
  const f=fixture(t);await f.api.load(1);f.api.open(row.id);change(f,'contact_id','sample-person');change(f,'identity_checked',true);
  let finish,reject;f.control.write=()=>new Promise((resolve,fail)=>{finish=resolve;reject=fail;});await f.submit();
  const replacement={epoch:1,userId:'replacement-staff',role:'editor',canEdit:false,workspaceReady:false};f.setContext(replacement);await f.api.load(1);
  assert.equal(f.form(),null);assert.equal(unloadBlocked(f),false);
  f.setContext({...replacement,canEdit:true,workspaceReady:true});await f.api.load(1);f.api.open(row.id);change(f,'contact_id','sample-person');change(f,'identity_checked',true);
  let finishNew;f.control.write=()=>new Promise(resolve=>finishNew=resolve);await f.submit();const replacementForm=f.form();
  if(outcome==='confirmed')finish({data:{id:row.id,version:1,contact_id:'sample-person',status:'reviewed'}});else reject(new Error('Fictional old transport failure'));
  await tick();await tick();assert.equal(f.form(),replacementForm);assert.equal(f.form().querySelector('[type=submit]').disabled,true);
  assert.equal(f.w.document.querySelector('[data-signup-close]').disabled,true);assert.equal(unloadBlocked(f),true);assert.equal(f.refreshes(),0);assert.equal(f.notices.length,0);
  finishNew({data:{id:row.id,version:1,contact_id:'sample-person',status:'reviewed'}});await tick();await tick();
  assert.equal(f.form(),null);assert.equal(f.refreshes(),1);assert.equal(f.notices.length,1);assert.equal(unloadBlocked(f),false);
 }
});

const guest={...row,staff_version:1,visit_status:'first_visit',first_visit_on:'2026-09-06',staff_visit_on:'2026-09-07',follow_up_on:'2026-09-09',follow_up_status:'new',welcome_owner:'Fictional welcome team',welcome_email_status:'queued'};
test('guest table separates reported/recorded dates and accepted mail, sorts/searches without mutating records',async t=>{
 const second={...guest,id:'other',first_name:'Another',submitted_at:'2026-09-07T01:00:00Z',welcome_email_status:'sent',follow_up_status:'contacted'};
 const f=fixture(t,{directIntake:true,rows:[{...guest},second]});await f.api.load(1);
 assert.ok(f.host.querySelector('table'));assert.match(f.host.textContent,/Visit · self-reported/);assert.match(f.host.textContent,/Visit · staff recorded/);assert.match(f.host.textContent,/Provider accepted/);assert.doesNotMatch(f.host.textContent,/Verified email|Email verified/);
 const tr=f.host.querySelector('[data-signup-row="other"]');assert.match(tr.cells[0].textContent,/Sep 6, 2026/,'registration instant displays the Central date');assert.match(tr.cells[2].textContent,/Sep 6, 2026/);assert.match(tr.cells[3].textContent,/Sep 7, 2026/,'date-only staff date never shifts a day');
 f.host.querySelector('[data-signup-sort="name"]').click();assert.equal(f.host.querySelector('.signup-row').dataset.signupRow,'other');assert.equal(f.w.document.activeElement.dataset.signupSort,'name');assert.equal(f.host.querySelector('[data-signup-sort="name"]').parentNode.getAttribute('aria-sort'),'ascending');
 const search=f.host.querySelector('[data-signup-search]');search.value='contacted';search.dispatchEvent(new f.w.Event('input'));assert.equal(f.host.querySelectorAll('.signup-row').length,1);assert.equal(second.staff_version,1);
 f.api.open('other');assert.match(f.w.document.querySelector('dialog').textContent,/Email · self-reported, not verified/);
});
test('follow-up editing needs positive readiness and actual columns; legacy identity review stays available',async t=>{
 for(const opts of [{rows:[{...guest}]},{directIntake:true,rows:[{...row}]}]){
  const f=fixture(t,opts);await f.api.load(1);assert.equal(f.host.querySelector('[data-guest-followup]').disabled,true);f.api.openFollowup(row.id);assert.equal(f.form(),null);f.api.open(row.id);assert.ok(f.form());
 }
 const f=fixture(t,{directIntake:true,rows:[{...guest}]});f.control.capability=async()=>({data:{available:true,version:'1'}});await f.api.load(1);assert.equal(f.host.querySelector('[data-guest-followup]').disabled,true);
});
test('guest follow-up uses only expected staff version and staff whitelist even when People is unavailable',async t=>{
 const r={...guest};const f=fixture(t,{directIntake:true,rows:[r]});f.control.peopleReady=false;await f.api.load(1);f.api.openFollowup(row.id);assert.ok(f.form());
 change(f,'staff_visit_on','2026-09-08');change(f,'follow_up_on','2026-09-10');change(f,'follow_up_status','contacted');change(f,'welcome_owner','Fictional contact owner');
 f.control.write=(name,args)=>{assert.equal(name,'update_guest_followup');Object.assign(r,args.p_changes,{staff_version:2});return Promise.resolve({data:{id:r.id,staff_version:2}});};await f.submit();
 const call=f.calls.find(x=>x.name);assert.equal(call.args.p_staff_version,1);assert.deepEqual(Object.keys(call.args.p_changes).sort(),['follow_up_on','follow_up_status','staff_visit_on','welcome_owner']);assert.equal(call.args.p_changes.staff_visit_on,'2026-09-08');assert.equal(r.first_visit_on,'2026-09-06');assert.equal(r.version,1);assert.equal(f.form(),null);assert.equal(f.notices.length,1);
});
test('stale follow-up conflicts retain draft and never overwrite a newer staff version',async t=>{
 const r={...guest};const f=fixture(t,{directIntake:true,rows:[r]});await f.api.load(1);f.api.openFollowup(row.id);change(f,'welcome_owner','Draft owner');f.control.write=async()=>({error:{code:'40001',message:'PRIVATE_CONFLICT'}});await f.submit();assert.ok(f.form());assert.match(f.form().textContent,/could not be confirmed/);assert.doesNotMatch(f.form().textContent,/PRIVATE_CONFLICT/);
 r.staff_version=2;r.welcome_owner='Other owner';await f.api.load(1);assert.equal(f.form().elements.welcome_owner.value,'Draft owner');assert.equal(f.form().querySelector('[type=submit]').disabled,true);await f.submit();assert.equal(f.calls.filter(c=>c.name).length,1);assert.equal(r.welcome_owner,'Other owner');assert.equal(unloadBlocked(f),true);
});
test('timed-out follow-up cannot retry or discard while unresolved; late settlement requires fresh read',async t=>{
 const r={...guest};const f=fixture(t,{directIntake:true,rows:[r]});await f.api.load(1);f.api.openFollowup(row.id);change(f,'welcome_owner','Draft owner');
 let expire,finish;const real=f.w.setTimeout.bind(f.w);f.w.setTimeout=(fn,ms)=>ms===12000?(expire=fn,9999):real(fn,ms);f.control.write=()=>new Promise(resolve=>finish=resolve);const saving=f.submit();await tick();expire();await saving;
 await f.api.load(1);assert.equal(f.form().querySelector('[type=submit]').disabled,true);f.w.document.querySelector('[data-signup-close]').click();assert.ok(f.form());assert.equal(unloadBlocked(f),true);
 finish({error:{code:'NETWORK'}});await tick();assert.equal(f.form().querySelector('[type=submit]').disabled,true);await f.api.load(1);assert.equal(f.form().querySelector('[type=submit]').disabled,false);assert.equal(f.form().elements.welcome_owner.disabled,true,'retry retains the original submitted payload');
 f.form().elements.welcome_owner.value='Forced replacement';f.control.write=async()=>({data:{id:r.id,staff_version:2}});await f.submit();const writes=f.calls.filter(c=>c.name);assert.equal(writes.length,2);assert.deepEqual(writes[1].args,writes[0].args);assert.equal(f.form(),null);
});
test('fresh follow-up reconciliation confirms matching saved fields without repeating the mutation',async t=>{
 const r={...guest};const f=fixture(t,{directIntake:true,rows:[r]});await f.api.load(1);f.api.openFollowup(row.id);change(f,'follow_up_status','contacted');f.control.write=async(_name,args)=>{Object.assign(r,args.p_changes,{staff_version:2});return {data:null};};await f.submit();await f.api.load(1);assert.equal(f.form(),null);assert.match(f.notices[0],/refreshed guest follow-up matches/);assert.equal(f.calls.filter(c=>c.name).length,1);
});
test('follow-up draft lifecycle blocks double submit and removes old identity state on clear',async t=>{
 const f=fixture(t,{directIntake:true,rows:[{...guest}]});await f.api.load(1);f.api.openFollowup(row.id);assert.equal(unloadBlocked(f),false);change(f,'welcome_owner','Private synthetic owner');assert.equal(unloadBlocked(f),true);f.w.confirm=()=>false;f.w.document.querySelector('[data-signup-close]').click();assert.ok(f.form());
 let finish;f.control.write=()=>new Promise(resolve=>finish=resolve);const saving=f.submit();await tick();await f.submit();assert.equal(f.calls.filter(c=>c.name).length,1);
 f.setContext({epoch:2,userId:'other-staff',role:'editor',canEdit:false,workspaceReady:false});f.api.render();assert.equal(f.form(),null);assert.equal(f.host.textContent,'');assert.equal(unloadBlocked(f),false);finish({data:{id:row.id,staff_version:2}});await saving;assert.equal(f.notices.length,0);assert.equal(f.refreshes(),0);assert.equal(f.w.localStorage.length,0);
});
test('CSV needs an explicit current-session click, contains all filtered matches, and neutralizes formulas',async t=>{
 const rows=Array.from({length:101},(_,i)=>({...guest,id:'csv-'+i,first_name:i===100?' \u200B=HYPERLINK("x")':'Fictional '+i,last_name:'CSV',submitted_at:'2026-09-07T01:00:00Z',first_visit_on:'2026-09-06',staff_visit_on:'2026-09-07',phone:'+15555550123',welcome_owner:'@SUM(1)'}));
 const f=fixture(t,{directIntake:true,rows});let content,downloads=0,revoked=0;f.w.Blob=class{constructor(parts){content=parts.join('');}};f.w.URL.createObjectURL=()=> 'blob:fictional';f.w.URL.revokeObjectURL=()=>revoked++;f.w.HTMLAnchorElement.prototype.click=function(){downloads++;assert.equal(this.download,'creek-guest-register.csv');};await f.api.load(1);assert.equal(downloads,0);assert.equal(f.host.querySelectorAll('.signup-row').length,100);
 const button=f.host.querySelector('[data-signup-export]');button.click();await tick();assert.equal(downloads,1);assert.equal(revoked,1);assert.equal(content.split('\r\n').length,103);assert.match(content,/' \u200B=HYPERLINK\(""x""\)/);assert.match(content,/'\+15555550123/);assert.match(content,/'@SUM\(1\)/);assert.match(content,/"2026-09-06","Fictional/);assert.match(content,/"2026-09-06","2026-09-07"/);
 const search=f.host.querySelector('[data-signup-search]');search.value='Fictional 99';search.dispatchEvent(new f.w.Event('input'));button.click();assert.equal(content.split('\r\n').length,3);
 f.setContext({epoch:2,userId:null,role:null,canEdit:false});button.onclick();assert.equal(downloads,2,'detached or forced controls cannot export an old private session');
});

test('follow-up capability loss preserves a draft and a read crossing late settlement cannot unlock it',async t=>{
 const f=fixture(t,{directIntake:true,rows:[{...guest}]});await f.api.load(1);f.api.openFollowup(row.id);change(f,'welcome_owner','Synthetic retained owner');f.control.directIntake=false;await f.api.load(1);assert.equal(f.form().querySelector('[type=submit]').disabled,true);assert.match(f.form().textContent,/tools are unavailable/);f.control.directIntake=true;await f.api.load(1);assert.equal(f.form().querySelector('[type=submit]').disabled,false);
 let expire,finish,release;const real=f.w.setTimeout.bind(f.w);f.w.setTimeout=(fn,ms)=>ms===12000?(expire=fn,9999):real(fn,ms);f.control.write=()=>new Promise(resolve=>finish=resolve);const saving=f.submit();await tick();expire();await saving;
 f.control.read=()=>new Promise(resolve=>release=resolve);const reading=f.api.load(1);await tick();finish({error:{code:'NETWORK'}});await tick();release({data:[{...guest}],count:1});await reading;assert.equal(f.form().querySelector('[type=submit]').disabled,true,'the old read cannot establish post-settlement state');
 f.control.read=null;await f.api.load(1);assert.equal(f.form().querySelector('[type=submit]').disabled,false);f.api.clear();assert.equal(unloadBlocked(f),false);
});

test('workflow-capable guest register uses only routed task fields and the visit editor cannot change a separate owner',async t=>{
 const guest={...row,staff_version:3,follow_up_status:'new',welcome_email_status:'queued',welcome_owner:'STALE_FREE_TEXT_OWNER',follow_up_on:'2040-01-02'};
 const f=fixture(t,{rows:[guest],directIntake:true});f.control.capability=()=>Promise.resolve({data:{available:true,version:1,tasks:true,routes:true}});f.control.intakeTask=()=>({id:'fictional-task',due_on:'2026-10-01',status:'in_progress',owner:'Approved fictional staff'});
 await f.api.load(1);assert.match(f.host.textContent,/Intake action owner/);assert.match(f.host.textContent,/Approved fictional staff/);assert.match(f.host.textContent,/In progress/);assert.doesNotMatch(f.host.textContent,/STALE_FREE_TEXT_OWNER|2040/);f.host.querySelector('[data-signup-intake]').click();assert.deepEqual(f.control.openedTasks,[row.id]);
 f.api.openFollowup(row.id);assert.deepEqual(Array.from(f.form().querySelectorAll('[name]'),n=>n.name),['staff_visit_on']);assert.match(f.form().textContent,/approved staff dropdown/);change(f,'staff_visit_on','2026-09-13');f.control.write=()=>Promise.resolve({data:{id:row.id,staff_version:4}});await f.submit();const write=f.calls.find(c=>c.name==='update_guest_followup');assert.deepEqual(JSON.parse(JSON.stringify(write.args)),{p_id:row.id,p_staff_version:3,p_changes:{staff_visit_on:'2026-09-13'}});assert.match(f.notices[0],/ownership and progress were not changed/);
});

test('unavailable routed tasks never fall back to stale guest-owner fields in display or CSV',async t=>{
 const f=fixture(t,{rows:[{...row,staff_version:1,follow_up_status:'closed',welcome_email_status:'sent',welcome_owner:'STALE_OWNER_CANARY',follow_up_on:'2040-01-02'}],directIntake:true});f.control.capability=()=>Promise.resolve({data:{available:true,version:1,tasks:true,routes:true}});await f.api.load(1);assert.equal(f.host.querySelector('[data-signup-intake]').disabled,true);const cells=f.host.querySelector('.signup-row').children;assert.deepEqual([cells[4].textContent,cells[5].textContent,cells[6].textContent],['Unavailable','Unavailable','Unavailable']);assert.doesNotMatch(f.host.textContent,/STALE_OWNER_CANARY|2040/);
 let csv;f.w.Blob=class{constructor(parts){csv=parts.join('');}};f.w.URL.createObjectURL=()=> 'blob:fixture';f.w.URL.revokeObjectURL=()=>{};f.w.HTMLAnchorElement.prototype.click=function(){};f.host.querySelector('[data-signup-export]').click();assert.match(csv,/Intake action owner/);assert.doesNotMatch(csv,/STALE_OWNER_CANARY|2040/);assert.match(csv,/"Unavailable","Unavailable","Unavailable"/);
 f.control.capability=()=>Promise.resolve({error:{code:'PGRST202'}});await f.api.load(1);assert.match(f.host.textContent,/Intake action owner/);assert.doesNotMatch(f.host.textContent,/STALE_OWNER_CANARY|2040/);assert.equal(f.host.querySelector('[data-guest-followup]').disabled,true);
});

test('activating routed tasks freezes an older free-text follow-up draft; source labels reject account replacement',async t=>{
 const f=fixture(t,{rows:[{...row,staff_version:1,follow_up_status:'new',welcome_email_status:'queued'}],directIntake:true});await f.api.load(1);assert.equal(f.api.labelFor(row.id),'Sample Connection');f.api.openFollowup(row.id);change(f,'welcome_owner','Fictional old contact');f.control.capability=()=>Promise.resolve({data:{available:true,version:1,tasks:true,routes:true}});await f.api.load(1);assert.equal(f.form().elements.welcome_owner.value,'Fictional old contact');assert.equal(f.form().querySelector('[type=submit]').disabled,true);await f.submit();assert.equal(f.calls.some(c=>c.name==='update_guest_followup'),false);f.setContext({epoch:1,userId:'replacement-staff',role:'editor',canEdit:true});assert.equal(f.api.labelFor(row.id),'');
});

test('private expandable profile shows self-reported birthday, membership, address and family without granting historical status',async t=>{
 const profile={...row,birth_date:'1990-01-02',membership_status:'member',address_line1:'<img src=x onerror=alert(1)>',address_line2:'Fictional suite',city:'Fictional city',state_region:'LA',postal_code:'00123',family_members:[{first_name:'Fictional <child>',last_name:'Household',relationship:'child',birth_date:'2020-02-29'},{first_name:'Fictional adult',last_name:'',relationship:'spouse',birth_date:null}]};
 const f=fixture(t,{rows:[profile]});await f.api.load(1);const details=f.host.querySelector('[data-signup-profile]');assert.equal(details.open,false);assert.match(details.querySelector('summary').textContent,/2 family members supplied/);assert.match(details.textContent,/Jan 2, 1990/);assert.match(details.textContent,/Feb 29, 2020/);assert.match(details.textContent,/Membership · self-reported/);assert.match(details.textContent,/not been verified or added to the historical membership ledger/);assert.equal(details.querySelector('img'),null);assert.equal(details.querySelector('child'),null);assert.match(details.textContent,/00123/);assert.equal(f.api.labelFor(row.id),'Sample Connection','task source label remains the adult submission name only');
 details.open=true;details.dispatchEvent(new f.w.Event('toggle'));await f.api.load(1);assert.equal(f.host.querySelector('[data-signup-profile]').open,true);f.api.open(row.id);assert.equal(f.form().querySelector('[name=birth_date]'),null);assert.equal(f.form().querySelector('[name=membership_status]'),null);assert.equal(f.form().querySelector('[name=family_members]'),null);assert.equal(f.calls.some(c=>c.name),false);
 f.api.clear();assert.doesNotMatch(f.w.document.body.textContent,/Fictional <child>|1990|00123/);await f.api.load(1);assert.equal(f.host.querySelector('[data-signup-profile]').open,false);
});

function parseCSV(text){const records=[];let record=[],value='',quoted=false;text=text.replace(/^\ufeff/,'');for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){record.push(value);value='';}else if(c==='\r'&&!quoted&&text[i+1]==='\n'){record.push(value);records.push(record);record=[];value='';i++;}else value+=c;}assert.equal(quoted,false);return records;}

test('explicit profile CSV preserves ISO dates and postal zeros, neutralizes address formulas, and serializes only approved family keys',async t=>{
 const family={first_name:'=Fictional child',last_name:'Surname, Jr.',relationship:'child',birth_date:'2020-02-29',unexpected_private_id:'PRIVATE_NESTED_CANARY'},profile={...row,birth_date:'1990-01-02',membership_status:'regular_attender',address_line1:' \u200b=HYPERLINK("private")',address_line2:'Line one\nLine two',city:'+SUM(1)',state_region:'LA',postal_code:'00123',family_members:[family]};const f=fixture(t,{rows:[profile]});let csv,downloads=0;f.w.Blob=class{constructor(parts){csv=parts.join('');}};f.w.URL.createObjectURL=()=> 'blob:fixture';f.w.URL.revokeObjectURL=()=>{};f.w.HTMLAnchorElement.prototype.click=function(){downloads++;};await f.api.load(1);assert.equal(downloads,0);f.host.querySelector('[data-signup-export]').click();assert.equal(downloads,1);
 const [headers,record]=parseCSV(csv);assert.equal(headers.length,24);assert.equal(record.length,24);const get=label=>record[headers.indexOf(label)];assert.equal(get('Birthday (self-reported)'),'1990-01-02');assert.equal(get('Membership status (self-reported; not verified)'),'Regular attender');assert.equal(get('Postal code (self-reported)'),'00123');assert.equal(get('Address line 1 (self-reported)'),"'"+profile.address_line1);assert.equal(get('City (self-reported)'),"'+SUM(1)");assert.equal(get('Address line 2 (self-reported)'),profile.address_line2);assert.deepEqual(JSON.parse(get('Family members (self-reported; JSON)')),[{first_name:family.first_name,last_name:family.last_name,relationship:'child',birth_date:'2020-02-29'}]);assert.doesNotMatch(csv,/PRIVATE_NESTED_CANARY/);
});

test('older guest rows with no optional profile stay reviewable and do not invent household or membership claims',async t=>{
 const f=fixture(t);await f.api.load(1);const details=f.host.querySelector('[data-signup-profile]');assert.match(details.textContent,/No family details supplied/);assert.equal(details.querySelector('ul'),null);assert.match(details.textContent,/Not supplied/);assert.equal(f.host.querySelector('input[name=birth_date]'),null);f.api.open(row.id);assert.ok(f.form());assert.equal(f.calls.some(c=>c.name),false);
});
