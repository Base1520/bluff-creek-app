import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const code=await readFile(new URL('../attention.js',import.meta.url),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,0));
const plain=v=>JSON.parse(JSON.stringify(v));
const task={key:'intake:fixture',category:'intake',source_type:'intake',source_id:'fixture',contact_id:null,care_role:null,title:'Guest follow-up',owner_label:'Deacon 1',due_on:'2026-09-10',reasons:['intake_overdue','recipient_setup','notice_attention']};
const care={key:'care_plan:plan',category:'care',source_type:'care_plan',source_id:'plan',contact_id:'person',care_role:'deacon',title:'Fictional Person',owner_label:'Care label: Fictional helper',due_on:'2026-09-11',reasons:['care_due_today','care_unassigned','care_coverage_gap']};
const leader={key:'leader:plan',category:'leaders',source_type:'leader',source_id:'leader',contact_id:null,care_role:null,title:'Fictional Leader',owner_label:'You',due_on:null,reasons:['leader_unscheduled']};
const data=items=>({version:1,generated_at:'2026-09-11T13:00:00Z',today:'2026-09-11',waiting_minutes:30,total:items.length,items});
function fixture(t,options={}){
 const dom=new JSDOM('<section></section>',{url:'https://example.invalid/admin/',runScripts:'outside-only'}),w=dom.window;t.after(()=>w.close());w.eval(code);
 let ctx={epoch:1,userId:'fictional-admin',role:'admin',canEdit:true,workspaceReady:true},refreshes=0;const calls=[],opened=[],summaries=[],notices=[],dates=[];
 const control={read:()=>Promise.resolve({data:data([structuredClone(task)])}),sources:{care:{items:[structuredClone(care)]},leaders:{items:[structuredClone(leader)]}},refresh:null};
 const host=w.document.querySelector('section');const api=w.CreekAttention.create({root:host,db:{rpc(name,args){calls.push({name,args});return control.read();}},getContext:()=>ctx,isCurrent:e=>ctx.epoch===e,getSources:date=>{dates.push(date);return control.sources;},onSummary:s=>summaries.push(s&&plain(s)),notice:s=>notices.push(s),openSource:(row,date)=>{opened.push({row:plain(row),date});return options.openResult!==false;},refresh:async()=>{refreshes++;if(control.refresh)return control.refresh();return api.load(ctx.epoch);}});
 const focus=value=>{const select=host.querySelector('[data-attention-filter]');select.value=value;select.dispatchEvent(new w.Event('change'));};
 return {w,host,api,control,calls,opened,summaries,notices,dates,focus,context:()=>ctx,setContext:c=>ctx=c,refreshes:()=>refreshes};
}
test('combines complete sources without multiplying one record by its reasons; no private extra fields render',async t=>{
 const f=fixture(t);f.control.sources.care.items[0].notes='PRIVATE_CANARY';f.control.read=()=>Promise.resolve({data:data([{...task,title:'<img src=x onerror=PRIVATE_HANDLER>',prayer_body:'PRIVATE_CANARY'}])});assert.equal(await f.api.load(1),true);
 assert.deepEqual(f.summaries.at(-1),{count:3,known:3,unavailable:0});assert.equal(f.host.querySelectorAll('[data-attention-key]').length,3);assert.equal(f.host.querySelector('img'),null);assert.doesNotMatch(f.host.textContent,/PRIVATE_CANARY/);assert.match(f.host.textContent,/not unique people/);assert.match(f.host.textContent,/on-screen reminders/);assert.match(f.host.textContent,/does not prove a delivery failure/);assert.equal(f.calls.length,1);assert.ok(f.dates.includes('2026-09-11'));
});
test('filters by reason so a task with due and mail reasons remains in the message queue',async t=>{
 const f=fixture(t);await f.api.load(1);f.focus('messages');assert.equal(f.host.querySelectorAll('[data-attention-key]').length,1);assert.match(f.host.textContent,/Staff notification needs review/);f.focus('today');assert.equal(f.host.querySelectorAll('[data-attention-key]').length,1);f.focus('leaders');assert.equal(f.host.querySelectorAll('[data-attention-key]').length,1);f.focus('assignments');assert.equal(f.host.querySelectorAll('[data-attention-key]').length,3);assert.deepEqual(f.summaries.at(-1),{count:3,known:3,unavailable:0});
});
test('missing read-only RPC keeps loaded care and leader work visible with incomplete counts',async t=>{
 const f=fixture(t);f.control.read=()=>Promise.resolve({error:{code:'PGRST202',message:'PRIVATE_CANARY'}});assert.equal(await f.api.load(1),false);assert.deepEqual(f.summaries.at(-1),{count:null,known:2,unavailable:1});assert.match(f.host.textContent,/Awaiting the reviewed intake check/);assert.match(f.host.textContent,/not a complete all-clear/);assert.doesNotMatch(f.host.textContent,/PRIVATE_CANARY/);assert.equal(f.host.querySelectorAll('[data-attention-key]').length,2);
});
test('null/invalid local projections are unavailable rather than empty; full zero stays scoped',async t=>{
 const f=fixture(t);f.control.sources={care:null,leaders:{items:[{...leader,owner_label:'Other staff'}]}};f.control.read=()=>Promise.resolve({data:data([])});await f.api.load(1);assert.deepEqual(f.summaries.at(-1),{count:null,known:0,unavailable:2});assert.doesNotMatch(f.host.textContent,/No items need attention/);
 f.control.sources={care:{items:[]},leaders:{items:[]}};f.api.render();assert.deepEqual(f.summaries.at(-1),{count:0,known:0,unavailable:0});assert.match(f.host.textContent,/No items need attention in these three queues/);
});
test('partial or invalid remote snapshots never restore a prior intake row',async t=>{
 for(const value of [{...data([task]),total:2},data([task,task]),{...data([]),waiting_minutes:1},{...data([]),today:'2026-02-30'},{...data([]),generated_at:'bad'},data([{...task,reasons:['care_overdue']}]),data([{...task,contact_id:'private-id'}]),data([{...task,due_on:'bad'}])]){const f=fixture(t);await f.api.load(1);f.control.read=()=>Promise.resolve({data:value});assert.equal(await f.api.load(1),false);assert.deepEqual(f.summaries.at(-1),{count:null,known:2,unavailable:1});assert.equal(f.host.querySelector('[data-attention-key="intake:fixture"]'),null);}
});
test('signout, role loss and account replacement clear all private sources and suppress late responses',async t=>{
 for(const change of [{userId:null},{role:'viewer',canEdit:false},{epoch:2,userId:'replacement'}]){const f=fixture(t);await f.api.load(1);let done;f.control.read=()=>new Promise(r=>done=r);const p=f.api.load(1);await tick();f.setContext({...f.context(),...change});f.api.render();done({data:data([task])});await p;assert.equal(f.host.textContent,'');assert.equal(f.summaries.at(-1),null);}
});
test('viewer/unready context never calls the private RPC or source readers',async t=>{
 for(const change of [{role:'viewer'},{workspaceReady:false},{workspaceReady:undefined},{canEdit:false},{userId:null}]){const f=fixture(t);f.setContext({...f.context(),...change});assert.equal(await f.api.load(1),false);assert.equal(f.calls.length,0);assert.equal(f.dates.length,0);assert.equal(f.host.textContent,'');}
});
test('source actions require explicit current click and pass only the minimal current projection and date',async t=>{
 const f=fixture(t);f.control.sources.leaders.items[0].notes='PRIVATE_CANARY';await f.api.load(1);assert.equal(f.opened.length,0);f.focus('leaders');f.host.querySelector('[data-attention-open]').click();assert.equal(f.opened.length,1);assert.deepEqual(f.opened[0],{row:leader,date:'2026-09-11'});assert.equal(f.calls.length,1);
 f.control.sources.leaders=null;f.host.querySelector('[data-attention-open]').click();assert.equal(f.opened.length,1);assert.match(f.host.textContent,/unavailable/);
});
test('source refusal preserves existing editor decisions and tells staff to refresh',async t=>{
 const f=fixture(t,{openResult:false});await f.api.load(1);f.host.querySelector('[data-attention-open]').click();assert.equal(f.opened.length,1);assert.match(f.notices[0],/could not be opened/);assert.equal(f.calls.length,1);
});
test('refresh clears prior data immediately and never uses a false empty total',async t=>{
 const f=fixture(t);await f.api.load(1);f.api.beginRefresh();assert.deepEqual(f.summaries.at(-1),{count:null,known:0,unavailable:3});assert.equal(f.host.querySelectorAll('[data-attention-key]').length,0);assert.equal(f.host.querySelector('[data-attention-refresh]').disabled,true);await f.api.load(1);assert.equal(f.host.querySelector('[data-attention-refresh]').disabled,false);assert.deepEqual(f.summaries.at(-1),{count:3,known:3,unavailable:0});
});
test('late old snapshots cannot replace the newer intake result',async t=>{
 const f=fixture(t);let finish;f.control.read=()=>new Promise(r=>finish=r);const old=f.api.load(1);await tick();f.control.read=()=>Promise.resolve({data:data([])});await f.api.load(1);finish({data:data([task])});await old;assert.deepEqual(f.summaries.at(-1),{count:2,known:2,unavailable:0});assert.equal(f.host.querySelector('[data-attention-key="intake:fixture"]'),null);
});
test('more button exposes all matched records without losing full counts or leaking filtered items',async t=>{
 const f=fixture(t);f.control.sources={care:{items:[]},leaders:{items:[]}};const rows=Array.from({length:121},(_,i)=>({...task,key:'intake:'+i,source_id:'task'+i,title:'Fictional guest '+i}));f.control.read=()=>Promise.resolve({data:data(rows)});await f.api.load(1);assert.equal(f.host.querySelectorAll('[data-attention-key]').length,60);assert.equal(f.summaries.at(-1).count,121);f.host.querySelector('[data-attention-more]').click();assert.equal(f.host.querySelectorAll('[data-attention-key]').length,120);f.host.querySelector('[data-attention-more]').click();assert.equal(f.host.querySelectorAll('[data-attention-key]').length,121);assert.equal(f.host.querySelector('[data-attention-more]').hidden,true);const search=f.host.querySelector('input');search.value='guest 120';search.dispatchEvent(new f.w.Event('input'));assert.equal(f.host.querySelectorAll('[data-attention-key]').length,1);assert.equal(f.summaries.at(-1).count,121);
});
