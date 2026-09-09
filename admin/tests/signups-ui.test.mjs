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
 const calls=[],notices=[],counts=[],control={peopleReady:true};const db={from(table){const q={table};const chain={select(fields,settings){q.fields=fields;q.selectOptions=settings;return chain},order(){return chain},range(a,b){q.range=[a,b];return chain},then(resolve,reject){calls.push(q);return (control.read?control.read(q):Promise.resolve({data:rows.slice(q.range?.[0]||0,q.range?q.range[1]+1:undefined),count:rows.length})).then(resolve,reject)}};if(opts.noRange)delete chain.range;return chain},rpc:async(name,args)=>{calls.push({name,args});if(control.write)return control.write();return{data:{id:row.id,version:row.version,contact_id:'sample-person',status:'reviewed'}}}};
 const host=w.document.getElementById('signups'),people=[{id:'sample-person',first_name:'Sample',last_name:'Person',email:'sample@example.invalid',status:'active'}];let api;
 api=w.CreekSignups.create({root:host,db,people:()=>people,peopleReady:()=>control.peopleReady,getContext:()=>ctx,ensureReady:async epoch=>control.ensure?await control.ensure(epoch):true,isCurrent:e=>ctx.epoch===e&&!!ctx.userId,notice:m=>notices.push(m),onCount:n=>counts.push(n),refresh:async()=>{refreshes++;}});
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
