import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source=await readFile(new URL('../membership.js',import.meta.url),'utf8');
const delay=()=>new Promise(resolve=>setTimeout(resolve,10));
function fixture(t){
  const dom=new JSDOM('<section id="history-view"></section>',{url:'https://office.example.invalid/admin/',runScripts:'outside-only'}),w=dom.window;
  t.after(()=>w.close());w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};
  const confirmations=[];let discard=true;w.confirm=message=>{confirmations.push(message);return discard};const revoked=[];w.URL.createObjectURL=()=> 'blob:synthetic-preview';w.URL.revokeObjectURL=url=>revoked.push(url);w.eval(source);
  const realTimeout=w.setTimeout.bind(w),realClear=w.clearTimeout.bind(w);let clocked=false,nextTimer=100000;const heldTimers=new Map();w.setTimeout=(fn,ms,...args)=>clocked&&ms===12000?(heldTimers.set(++nextTimer,()=>fn(...args)),nextTimer):realTimeout(fn,ms,...args);w.clearTimeout=id=>heldTimers.has(id)?heldTimers.delete(id):realClear(id);
  const state={epoch:1,userId:'synthetic-user',role:'editor',canEdit:true,workspaceReady:true};
  const people=[{id:'person-sample',first_name:'Synthetic',last_name:'Record',membership_number:'SAMPLE-01'}];
  const calls=[],notices=[],rows=[],documents=[],blobs=new Set();let respond=null,uploads=null,gate=null,api;
  const control={after:null,noWrite:false,storageError:null};
  const db={from(table){const q={table,op:'select'};const chain={select(fields){q.fields=fields;return chain},order(){return chain},range(a,b){q.range=[a,b];return chain},eq(k,v){q[k]=v;return chain},maybeSingle(){q.single=true;return chain},single(){q.single=true;return chain},insert(row){q.op='insert';q.row=structuredClone(row);return chain},then(a,b){
    calls.push(q);if(respond){const response=respond(q);if(response!==undefined)return Promise.resolve(response).then(a,b);}
    const tableRows=table==='membership_history'?rows:documents;let result;
    if(q.op==='insert'){
      if(control.noWrite)result={data:null,error:{message:'Synthetic unavailable'}};
      else if(tableRows.some(r=>r.id===q.row.id))result={data:null,error:{code:'23505'}};
      else{tableRows.push(structuredClone(q.row));result={data:{id:q.row.id},error:null};}
    }else{let matches=tableRows.filter(r=>!q.id||r.id===q.id);if(q.range)matches=matches.slice(q.range[0],q.range[1]+1);result={data:q.single?(matches[0]||null):matches,error:null};}
    if(control.after)result=control.after(q,result)||result;return Promise.resolve(result).then(a,b);
  }};return chain},storage:{from(){return{
    upload(path,file){calls.push({op:'upload',path,size:file.size});if(control.storageError)return Promise.resolve({error:control.storageError});blobs.add(path);return uploads?uploads():Promise.resolve({data:{path},error:null})},
    list(folder,options){calls.push({op:'storage-list',folder,options});if(control.storageError)return Promise.resolve({error:control.storageError});return Promise.resolve({data:[...blobs].filter(p=>p.startsWith(folder+'/')).map(p=>({name:p.split('/').at(-1)})),error:null})},
    createSignedUrl(){return Promise.resolve({data:{signedUrl:'javascript:alert(1)'}})}
  }}}};
  api=w.CreekMembership.create({root:w.document.getElementById('history-view'),db,getContext:()=>state,isCurrent:epoch=>epoch===state.epoch&&!!state.userId,people:()=>people,documents:()=>documents,ensureReady:async epoch=>{calls.push({op:'ensureReady',epoch});return gate?gate():state.workspaceReady},refresh:async()=>{},notice:(...args)=>notices.push(args)});
  const form=()=>w.document.querySelector('dialog form');
  const open=()=>{w.document.getElementById('membership-add').click();return form()};
  const fill=f=>{f.elements.contact_id.value=people[0].id;f.elements.event_type.value='Received by letter';f.elements.source_label.value='Synthetic ledger · page 1';f.elements.date_text.value='Summer 1956; day [unclear]';f.elements.details.value='<img src=x onerror=alert(1)> remains literal';f.elements.reviewed.checked=true};
  const submit=f=>f.dispatchEvent(new w.Event('submit',{cancelable:true,bubbles:true}));
  const photo=f=>{Object.defineProperty(f.elements.page,'files',{value:[{type:'image/jpeg',size:12}],configurable:true});f.elements.page.dispatchEvent(new w.Event('change'));};
  return{w,api,state,people,calls,rows,documents,blobs,notices,control,revoked,clock:value=>clocked=value,expire:()=>{const pending=[...heldTimers.values()];heldTimers.clear();pending.forEach(fn=>fn())},confirmations,discard:value=>discard=value,form,open,fill,submit,photo,respond:f=>respond=f,uploads:f=>uploads=f,gate:f=>gate=f};
}

test('private ledger links accept only a normal Google Sheets document URL',t=>{
  const f=fixture(t),link=f.w.CreekMembership.sheetLink;
  assert.equal(link('https://docs.google.com/spreadsheets/d/Synthetic_123/edit?usp=sharing'),'https://docs.google.com/spreadsheets/d/Synthetic_123/edit');
  for(const value of ['', 'http://docs.google.com/spreadsheets/d/test/edit','https://docs.google.com.evil.test/spreadsheets/d/test/edit','https://user:pass@docs.google.com/spreadsheets/d/test/edit','javascript:alert(1)'])assert.equal(link(value),null);
});

test('a reviewed entry preserves uncertain date text and appends rather than replacing history',async t=>{
  const f=fixture(t);await f.api.load(1);const form=f.open();f.fill(form);f.submit(form);await delay();
  const write=f.calls.find(x=>x.table==='membership_history'&&x.op==='insert');assert(write);assert.equal(write.row.event_date,null);assert.equal(write.row.date_text,'Summer 1956; day [unclear]');assert.equal(write.row.details,'<img src=x onerror=alert(1)> remains literal');assert.equal(write.row.corrects_id,null);assert.match(f.notices[0][0],/Google ledger has not been changed/);assert.equal(f.w.document.querySelector('dialog'),null);
});

test('review checkbox and nonblank required values prevent a write',async t=>{
  const f=fixture(t);await f.api.load(1);const form=f.open();f.fill(form);form.elements.reviewed.checked=false;f.submit(form);await delay();assert(!f.calls.some(x=>x.op==='insert'));
  form.elements.reviewed.checked=true;form.elements.source_label.value='   ';f.submit(form);await delay();assert(!f.calls.some(x=>x.op==='insert'));assert.match(form.querySelector('output').textContent,/source/);
});

test('correction retains the previous entry and its original document',async t=>{
  const f=fixture(t);f.rows.push({id:'old-entry',contact_id:'person-sample',event_type:'Joined',date_text:'1956?',source_label:'Synthetic source',source_document_id:'doc-source',details:'Original wording'});await f.api.load(1);
  [...f.w.document.querySelectorAll('.membership-entry button')].find(x=>x.textContent==='Add correction').click();const form=f.w.document.querySelector('dialog form');form.elements.reviewed.checked=true;f.submit(form);await delay();
  const write=f.calls.find(x=>x.table==='membership_history'&&x.op==='insert');assert.equal(write.row.corrects_id,'old-entry');assert.equal(write.row.source_document_id,'doc-source');assert.equal(f.rows[0].details,'Original wording');assert.equal(f.calls.some(x=>x.op==='update'||x.op==='delete'),false);
});

test('late history loads and an open transcription are erased after auth changes',async t=>{
  const f=fixture(t);await f.api.load(1);const form=f.open();f.fill(form);let release;f.respond(()=>new Promise(resolve=>release=resolve));const pending=f.api.load(1);await delay();f.state.epoch=2;f.state.userId=null;f.state.canEdit=false;f.api.clear();release({data:[{contact_id:'person-sample',event_type:'Private synthetic history'}]});await pending;
  assert.equal(f.w.document.querySelector('dialog'),null);assert.equal(f.w.document.getElementById('membership-history').textContent,'');assert.equal(f.w.document.getElementById('membership-person').options.length,1);
});

test('page upload freezes review and close actions, retaining a complete submitted snapshot',async t=>{
  const f=fixture(t);await f.api.load(1);const form=f.open();f.fill(form);Object.defineProperty(form.elements.page,'files',{value:[{type:'image/jpeg',size:15728641}],configurable:true});f.submit(form);await delay();assert(!f.calls.some(x=>x.op==='upload'));
  let release;f.uploads(()=>new Promise(resolve=>release=resolve));f.photo(form);f.submit(form);await delay();assert.match(f.calls.find(x=>x.op==='upload').path,/^synthetic-user\/membership-history\//);
  assert.ok([...form.querySelectorAll('input,select,textarea')].every(n=>n.disabled));assert.equal(f.w.document.querySelector('[data-close]').disabled,true);f.w.document.querySelector('[data-close]').click();assert.equal(f.form(),form);
  form.elements.details.value='Changed during pending request';form.elements.date_text.value='Changed date';form.elements.reviewed.checked=false;
  release({error:null});await delay();const write=f.calls.find(q=>q.table==='membership_history'&&q.op==='insert');assert.equal(write.row.details,'<img src=x onerror=alert(1)> remains literal');assert.equal(write.row.date_text,'Summer 1956; day [unclear]');assert.equal(f.form(),null);assert.equal(f.revoked.length,1);
});

test('history pagination includes later pages so searches do not silently stop at 1000',async t=>{
  const f=fixture(t);f.respond(q=>({data:q.range[0]===0?Array.from({length:1000},(_,i)=>({id:String(i),contact_id:'person-sample',event_type:'Synthetic historic entry'})):[{id:'1001',contact_id:'person-sample',event_type:'Unique later event'}]}));await f.api.load(1);const input=f.w.document.getElementById('membership-search');input.value='Unique later';input.dispatchEvent(new f.w.Event('input'));assert.match(f.w.document.getElementById('membership-history').textContent,/Unique later event/);assert.deepEqual(f.calls.map(q=>q.range),[[0,999],[1000,1999]]);
});


test('committed history with a lost response reconciles once and never duplicates',async t=>{
  const f=fixture(t);await f.api.load(1);const form=f.open();f.fill(form);f.control.after=(q,r)=>q.op==='insert'&&q.table==='membership_history'?{data:null,error:{message:'PRIVATE_LOST_RESPONSE'}}:r;
  f.submit(form);await delay();assert.equal(f.rows.length,1);assert.equal(form.querySelector('[type=submit]').disabled,true);assert.equal(f.w.document.querySelector('[data-close]').disabled,true);assert.equal(f.notices.length,0);assert.doesNotMatch(form.textContent,/PRIVATE_LOST_RESPONSE/);
  f.submit(form);await delay();assert.equal(f.calls.filter(q=>q.op==='insert').length,1);form.querySelector('[data-recover]').click();await delay();assert.equal(f.form(),null);assert.equal(f.rows.length,1);assert.match(f.notices[0][0],/already saved/);
});

test('failed uncommitted history retries with the same ID after explicit reconciliation',async t=>{
  const f=fixture(t);await f.api.load(1);const form=f.open();f.fill(form);f.control.noWrite=true;f.submit(form);await delay();const id=f.calls.find(q=>q.op==='insert').row.id;f.control.noWrite=false;form.querySelector('[data-recover]').click();await delay();assert.equal(form.querySelector('[type=submit]').disabled,false);f.submit(form);await delay();assert.equal(f.rows.length,1);assert.equal(f.rows[0].id,id);assert.equal(f.calls.filter(q=>q.op==='insert').length,2);
});

test('lost upload and metadata responses resume stable source stages without extra blobs or documents',async t=>{
  for(const stage of ['upload','metadata']){
    const f=fixture(t);await f.api.load(1);const form=f.open();f.fill(form);f.photo(form);
    if(stage==='upload')f.uploads(()=>Promise.resolve({error:{message:'Synthetic connection loss'}}));
    else f.control.after=(q,r)=>q.op==='insert'&&q.table==='documents'?{data:null,error:{message:'Synthetic response loss'}}:r;
    f.submit(form);await delay();assert.equal(f.blobs.size,1);assert.equal(f.rows.length,0);
    f.uploads(null);f.control.after=null;form.querySelector('[data-recover]').click();await delay();assert.equal(form.querySelector('[type=submit]').disabled,false);f.submit(form);await delay();assert.equal(f.rows.length,1);assert.equal(f.documents.length,1);assert.equal(f.blobs.size,1);assert.equal(f.calls.filter(q=>q.op==='upload').length,1);assert.equal(f.rows[0].source_document_id,f.documents[0].id);
  }
});

test('transient workspace outage retains editable draft and photo while ensureReady blocks writes',async t=>{
  const f=fixture(t);await f.api.load(1);const form=f.open();f.fill(form);f.photo(form);f.state.canEdit=false;f.state.workspaceReady=false;f.api.render();assert.equal(f.form(),form);assert.equal(form.elements.details.value,'<img src=x onerror=alert(1)> remains literal');assert.equal(form.querySelector('.page-preview').hidden,false);assert.equal(form.querySelector('[type=submit]').disabled,true);f.submit(form);await delay();assert.equal(f.calls.some(q=>q.op==='upload'||q.op==='insert'),false);
  f.state.canEdit=true;f.state.workspaceReady=true;f.api.render();f.gate(()=>false);f.submit(form);await delay();assert.equal(f.calls.some(q=>q.op==='upload'||q.op==='insert'),false);assert.match(form.querySelector('output').textContent,/connection is unavailable/);assert.ok(f.calls.some(q=>q.op==='ensureReady'));
});

test('authorization failures and identity replacement clear private photos and ignore late writes',async t=>{
  const f=fixture(t);await f.api.load(1);const form=f.open();f.fill(form);f.photo(form);f.respond(()=>({error:{code:'42501',message:'PRIVATE_ROLE_ERROR'}}));await f.api.load(1);assert.equal(f.form(),null);assert.equal(f.revoked.length,1);assert.doesNotMatch(f.w.document.body.textContent,/PRIVATE_ROLE_ERROR/);
  const g=fixture(t);await g.api.load(1);const review=g.open();g.fill(review);g.photo(review);let release;g.uploads(()=>new Promise(resolve=>release=resolve));g.submit(review);await delay();g.state.userId='replacement-user';g.state.epoch=2;g.api.clear();release({error:null});await delay();assert.equal(g.calls.some(q=>q.op==='insert'),false);assert.equal(g.form(),null);assert.equal(g.notices.length,0);
});

test('null or incorrect returned IDs are never treated as a successful history save',async t=>{
  const f=fixture(t);await f.api.load(1);const form=f.open();f.fill(form);f.control.after=(q,r)=>q.op==='insert'?{data:{id:'wrong-id'},error:null}:r;f.submit(form);await delay();assert.equal(f.notices.length,0);assert.equal(f.form(),form);assert.match(form.querySelector('output').textContent,/could not be confirmed/);assert.equal(form.querySelector('[type=submit]').disabled,true);
});


test('accidental close asks before discarding a changed review while forced auth clear bypasses',async t=>{
  const f=fixture(t);await f.api.load(1);const form=f.open();f.fill(form);f.photo(form);f.discard(false);f.w.document.querySelector('[data-close]').click();assert.equal(f.form(),form);assert.equal(f.confirmations.length,1);assert.equal(f.revoked.length,0);
  f.discard(true);f.w.document.querySelector('dialog').dispatchEvent(new f.w.Event('cancel',{cancelable:true}));assert.equal(f.form(),null);assert.equal(f.revoked.length,1);
  const next=f.open();f.fill(next);f.discard(false);f.api.clear();assert.equal(f.form(),null);assert.equal(f.confirmations.length,2,'forced clear never asks the signed-out user to retain a private draft');
});


test('authorization loss while opening an original source clears the source dialog and history',async t=>{
  const f=fixture(t);f.rows.push({id:'sample-history',contact_id:'person-sample',event_type:'Synthetic source',source_document_id:'sample-source'});await f.api.load(1);f.respond(q=>q.table==='documents'?{error:{code:'42501',message:'PRIVATE_SOURCE_ERROR'}}:undefined);
  [...f.w.document.querySelectorAll('.membership-entry button')].find(b=>b.textContent==='Open original page').click();await delay();assert.equal(f.w.document.querySelector('dialog'),null);assert.equal(f.w.document.getElementById('membership-history').textContent,'');assert.doesNotMatch(f.w.document.body.textContent,/PRIVATE_SOURCE_ERROR/);
});


test('timed-out upload unlocks recovery and a late server commit is reused without another upload',async t=>{
  const f=fixture(t);await f.api.load(1);f.clock(true);const form=f.open();f.fill(form);f.photo(form);let finish;f.uploads(()=>new Promise(resolve=>finish=resolve));f.submit(form);await delay();const originalPath=f.calls.find(q=>q.op==='upload').path;
  f.expire();await delay();assert.equal(form.querySelector('[data-recover]').disabled,false);assert.equal(form.querySelector('[type=submit]').disabled,true);assert.match(form.querySelector('output').textContent,/could not be confirmed/);
  finish({data:{path:originalPath},error:null});await delay();assert.equal(f.calls.some(q=>q.op==='insert'),false,'late response cannot continue the abandoned write pipeline');
  f.uploads(null);form.querySelector('[data-recover]').click();await delay();f.submit(form);await delay();assert.equal(f.calls.filter(q=>q.op==='upload').length,1);assert.equal(f.documents[0].storage_path,originalPath);assert.equal(f.rows.length,1);
});

test('early absence after a write timeout retries the same ID and reconciles a later commit',async t=>{
  const f=fixture(t);await f.api.load(1);f.clock(true);const form=f.open();f.fill(form);let pendingRow,finish;f.respond(q=>{if(q.op==='insert'&&q.table==='membership_history'){pendingRow=q.row;return new Promise(resolve=>finish=resolve)}});f.submit(form);await delay();const id=pendingRow.id;f.expire();await delay();
  f.respond(null);form.querySelector('[data-recover]').click();await delay();assert.equal(form.querySelector('[type=submit]').disabled,false);
  f.rows.push(structuredClone(pendingRow));finish({data:{id},error:null});await delay();assert.equal(f.notices.length,0);
  f.submit(form);await delay();const inserts=f.calls.filter(q=>q.op==='insert');assert.equal(inserts.length,2);assert.ok(inserts.every(q=>q.row.id===id));assert.equal(f.rows.length,1,'duplicate primary key prevents a second historical entry');
  form.querySelector('[data-recover]').click();await delay();assert.equal(f.form(),null);assert.equal(f.rows.length,1);assert.match(f.notices[0][0],/already saved/);
});
