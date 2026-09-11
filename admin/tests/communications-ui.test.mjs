import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const code=await readFile(new URL('../communications.js',import.meta.url),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,0));
const row=(n,status='requested')=>({id:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,first_name:'Fictional',last_name:'Guest '+n,email:`fixture${n}@example.invalid`,preference_status:status,preference_version:status==='not_set'?0:1,updated_at:status==='not_set'?null:'2026-09-10T14:00:00Z'});
const data=rows=>({version:1,generated_at:'2026-09-10T15:00:00Z',total:rows.length,rows});
function fixture(t,rows=[row(1)]){
 const dom=new JSDOM('<section id="comms"></section>',{url:'https://example.invalid/admin/',runScripts:'outside-only'}),w=dom.window;t.after(()=>w.close());
 let ctx={epoch:1,userId:'fictional-owner',role:'admin',canEdit:true,workspaceReady:true};const calls=[],downloads=[],blobs=[];const control={read:()=>Promise.resolve({data:data(structuredClone(rows))}),ensure:()=>Promise.resolve(true)};
 w.URL.createObjectURL=b=>{blobs.push(b);return 'blob:fictional';};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){downloads.push(this.download);};w.eval(code);
 const host=w.document.querySelector('section'),api=w.CreekCommunications.create({root:host,db:{rpc(name,args){calls.push({name,args});return control.read();}},getContext:()=>ctx,isCurrent:e=>ctx.epoch===e,ensureReady:()=>control.ensure()});
 return{w,host,api,calls,control,downloads,blobs,context:()=>ctx,setContext:c=>ctx=c,download:async()=>{host.querySelector('[data-comms-export]').click();await tick();await tick();},blobText:()=>new Promise((resolve,reject)=>{const reader=new w.FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsText(blobs.at(-1));})};
}
test('Office audience is private to eligible editor/admin context and clears on role/session loss',async t=>{
 const f=fixture(t);await f.api.load(1);assert.match(f.host.textContent,/fixture1@example.invalid/);f.setContext({...f.context(),role:'viewer',canEdit:false});f.api.render();assert.equal(f.host.textContent,'');assert.equal(await f.api.load(1),false);assert.equal(f.calls.length,1);
});
test('one complete snapshot shows consent states and never renders extra private fields',async t=>{
 const f=fixture(t,[row(1),row(2,'not_requested'),row(3,'not_set'),row(4,'email_changed'),row(5,'account_unavailable'),row(6,'duplicate_email')]);f.control.read=()=>Promise.resolve({data:data([{...row(1),first_name:'<img src=x>',auth_user_id:'PRIVATE_CANARY',prayer:'PRIVATE_CANARY'},row(2,'not_requested')])});
 assert.equal(await f.api.load(1),true);assert.equal(f.host.querySelectorAll('[data-comms-row]').length,1);assert.equal(f.host.querySelector('img'),null);assert.doesNotMatch(f.host.textContent,/PRIVATE_CANARY/);assert.match(f.host.textContent,/not a Google Sheets sync/);assert.match(f.host.textContent,/Weekly sending is not enabled/);
 const filter=f.host.querySelector('select');filter.value='all';filter.dispatchEvent(new f.w.Event('change'));assert.equal(f.host.querySelectorAll('[data-comms-row]').length,2);
});
test('missing migration fails only this optional section without pretending no one subscribed',async t=>{
 const f=fixture(t);f.control.read=()=>Promise.resolve({error:{code:'PGRST202',message:'PRIVATE_CANARY'}});assert.equal(await f.api.load(1),false);assert.match(f.host.textContent,/not enabled/);assert.equal(f.host.querySelector('[data-comms-export]').disabled,true);assert.equal(f.host.querySelector('table'),null);assert.doesNotMatch(f.host.textContent,/PRIVATE_CANARY/);
});
test('partial, malformed and ambiguous snapshots clear prior rows and offer no export',async t=>{
 for(const bad of [{...data([row(1)]),total:2},data([row(1),row(1)]),data([row(1),{...row(2),email:row(1).email.toUpperCase()}]),data([{...row(1),preference_version:0}]),data([{...row(1),updated_at:null}]),data([{...row(1),preference_status:'approved'}]),{...data([]),generated_at:'bad'},{...data([]),total:5001},data([{...row(1),email:'bad\r\naddress'}])]){
  const f=fixture(t);await f.api.load(1);f.control.read=()=>Promise.resolve({data:bad});assert.equal(await f.api.load(1),false);assert.equal(f.host.querySelector('table'),null);assert.equal(f.host.querySelector('[data-comms-export]').disabled,true);
 }
});
test('download refreshes ALL choices and excludes withdrawn, held and unchosen addresses',async t=>{
 const f=fixture(t,[row(1),row(2)]);await f.api.load(1);const search=f.host.querySelector('input');search.value='fixture1';search.dispatchEvent(new f.w.Event('input'));
 f.control.read=()=>Promise.resolve({data:data([row(1,'not_requested'),{...row(2),first_name:'=1+1',last_name:'\x01=1+1',private_note:'PRIVATE_CANARY'},row(3,'not_set'),row(4,'email_changed')])});await f.download();
 assert.equal(f.calls.length,2);assert.equal(f.downloads.length,1);const csv=await f.blobText();assert.match(csv,/fixture2@example.invalid/);assert.doesNotMatch(csv,/fixture1@|fixture3@|fixture4@|PRIVATE_CANARY/);assert.match(csv,/'=1\+1/);assert.match(csv,/'\x01=1\+1/);assert.match(csv,/self-reported/);assert.match(f.host.textContent,/No messages were sent/);
});
test('a withdrawal before export yields no file even when initial list had an address',async t=>{
 const f=fixture(t);await f.api.load(1);f.control.read=()=>Promise.resolve({data:data([row(1,'not_requested')])});await f.download();assert.equal(f.downloads.length,0);assert.match(f.host.textContent,/no requested weekly emails/);
});
test('export cannot fall back to stale data when readiness or latest snapshot fails',async t=>{
 for(const fail of ['readiness','snapshot']){const f=fixture(t);await f.api.load(1);if(fail==='readiness')f.control.ensure=()=>Promise.resolve(false);else f.control.read=()=>Promise.reject(new Error('PRIVATE_CANARY'));await f.download();assert.equal(f.downloads.length,0);assert.equal(f.host.querySelector('table'),null);assert.doesNotMatch(f.host.textContent,/PRIVATE_CANARY/);assert.match(f.host.textContent,/No file was downloaded/);}
});
test('pending export cannot leak through signout or account switch',async t=>{
 const f=fixture(t);await f.api.load(1);let finish;f.control.read=()=>new Promise(r=>finish=r);const pending=f.download();await tick();f.setContext({...f.context(),epoch:2,userId:'other-owner'});f.api.clear();finish({data:data([row(1)])});await pending;assert.equal(f.downloads.length,0);assert.equal(f.host.textContent,'');
});
test('access lost during readiness makes no audience request and clears private rows',async t=>{
 const f=fixture(t);await f.api.load(1);let finish;f.control.ensure=()=>new Promise(r=>finish=r);const pending=f.download();await tick();f.setContext({...f.context(),role:'viewer',canEdit:false});finish(true);await pending;assert.equal(f.calls.length,1);assert.equal(f.downloads.length,0);assert.equal(f.host.textContent,'');
});
test('late older reads cannot replace newer choices',async t=>{
 const f=fixture(t);let finish;f.control.read=()=>new Promise(r=>finish=r);const old=f.api.load(1);await tick();f.control.read=()=>Promise.resolve({data:data([row(2)])});await f.api.load(1);finish({data:data([row(1)])});await old;assert.match(f.host.textContent,/fixture2@example.invalid/);assert.doesNotMatch(f.host.textContent,/fixture1@example.invalid/);
});
test('automatic refresh does not interrupt an in-progress fresh export or duplicate a file',async t=>{
 const f=fixture(t);await f.api.load(1);let finish;f.control.read=()=>new Promise(r=>finish=r);const pending=f.download();await tick();assert.equal(await f.api.load(1),false);f.host.querySelector('[data-comms-export]').click();finish({data:data([row(1)])});await pending;assert.equal(f.calls.length,2);assert.equal(f.downloads.length,1);
});
test('a 601 row audience exports every requested address even when display is limited',async t=>{
 const f=fixture(t,Array.from({length:601},(_,i)=>row(i+1)));await f.api.load(1);assert.equal(f.host.querySelectorAll('[data-comms-row]').length,100);await f.download();const csv=await f.blobText();assert.equal(csv.trim().split('\r\n').length,602);assert.match(csv,/fixture601@example.invalid/);
});

test('legacy legal field lengths and Unicode names do not block a complete audience',async t=>{
 const email='x'.repeat(270)+'@example.invalid',f=fixture(t,[{...row(1),email,first_name:'🌿'.repeat(90),last_name:'Fixture\nName'}, {...row(2,'account_unavailable'),email:'invalid legacy value'}]);assert.equal(await f.api.load(1),true);await f.download();assert.equal(f.downloads.length,1);assert.match(await f.blobText(),/Fixture\nName/);
});
