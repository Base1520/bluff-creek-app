import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const code=await readFile(new URL('../signups.js',import.meta.url),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,0));
const row={id:'sample-signup',first_name:'Sample',last_name:'Connection',email:'sample@example.invalid',phone:null,preferred_contact:'email',contact_permission:true,version:1,reviewed_version:0,status:'pending',submitted_at:'2026-09-07T12:00:00Z',updated_at:'2026-09-07T12:00:00Z'};
function fixture(t,opts={}){
 const dom=new JSDOM('<section id="signups"></section>',{url:'https://example.invalid/admin/',runScripts:'outside-only'}),w=dom.window;t.after(()=>w.close());
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.eval(code);
 let ctx={epoch:1,userId:'sample-staff',role:opts.role||'editor',canEdit:opts.role!=='viewer'},rows=opts.rows||[{...row}],refreshes=0;
 const calls=[],notices=[],counts=[],control={peopleReady:true};const db={from(table){const q={table};const chain={select(){return chain},order(){return chain},range(a,b){q.range=[a,b];return chain},then(resolve,reject){calls.push(q);return (control.read?control.read():Promise.resolve({data:rows.slice(q.range?.[0]||0,q.range?q.range[1]+1:undefined)})).then(resolve,reject)}};return chain},rpc:async(name,args)=>{calls.push({name,args});if(control.write)return control.write();return{data:{id:row.id,version:row.version,contact_id:'sample-person',status:'reviewed'}}}};
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
 const f=fixture(t);await f.api.load(1);f.api.open(row.id);f.form().elements.contact_id.value='__new';f.form().elements.identity_checked.checked=true;f.form().elements.staff_notes.value='Synthetic review draft';
 f.setContext({epoch:1,userId:'staff',role:'editor',canEdit:false,workspaceReady:false});f.api.render();await f.api.load(1);assert.equal(f.form().elements.staff_notes.value,'Synthetic review draft');assert.equal(f.form().elements.staff_notes.disabled,true);assert.equal(f.host.querySelectorAll('.signup-row').length,0);
 f.setContext({epoch:1,userId:'staff',role:'editor',canEdit:true,workspaceReady:true});await f.api.load(1);assert.equal(f.form().elements.staff_notes.disabled,false);
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
