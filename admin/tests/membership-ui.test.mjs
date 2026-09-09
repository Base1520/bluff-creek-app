import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source=await readFile(new URL('../membership.js',import.meta.url),'utf8');
const delay=()=>new Promise(resolve=>setTimeout(resolve,10));
function fixture(t,options={}){
  const dom=new JSDOM('<section id="history-view"></section>',{url:'https://office.example.invalid/admin/',runScripts:'outside-only'}),w=dom.window;
  t.after(()=>w.close());w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};
  const confirmations=[];let discard=true;w.confirm=message=>{confirmations.push(message);return discard};const revoked=[];w.URL.createObjectURL=()=> 'blob:synthetic-preview';w.URL.revokeObjectURL=url=>revoked.push(url);w.eval(source);
  const realTimeout=w.setTimeout.bind(w),realClear=w.clearTimeout.bind(w);let clocked=false,nextTimer=100000;const heldTimers=new Map();w.setTimeout=(fn,ms,...args)=>clocked&&ms===12000?(heldTimers.set(++nextTimer,()=>fn(...args)),nextTimer):realTimeout(fn,ms,...args);w.clearTimeout=id=>heldTimers.has(id)?heldTimers.delete(id):realClear(id);
  const state={epoch:1,userId:'synthetic-user',role:'editor',canEdit:true,workspaceReady:true};
  const people=[{id:'person-sample',first_name:'Synthetic',last_name:'Record',membership_number:'SAMPLE-01'}];
  const calls=[],notices=[],rows=[],documents=[],blobs=new Set();let respond=null,uploads=null,gate=null,api;
  const control={after:null,noWrite:false,storageError:null,signedUrl:'javascript:alert(1)'};
  const db={from(table){const q={table,op:'select'};const chain={select(fields,options){q.fields=fields;q.countRequested=options&&options.count;return chain},order(){return chain},range(a,b){q.range=[a,b];return chain},eq(k,v){q[k]=v;return chain},maybeSingle(){q.single=true;return chain},single(){q.single=true;return chain},insert(row){q.op='insert';q.row=structuredClone(row);return chain},then(a,b){
    calls.push(q);if(respond){const response=respond(q);if(response!==undefined)return Promise.resolve(response).then(a,b);}
    const tableRows=table==='membership_history'?rows:documents;let result;
    if(q.op==='insert'){
      if(control.noWrite)result={data:null,error:{message:'Synthetic unavailable'}};
      else if(tableRows.some(r=>r.id===q.row.id))result={data:null,error:{code:'23505'}};
      else{tableRows.push(structuredClone(q.row));result={data:{id:q.row.id},error:null};}
    }else{let matches=tableRows.filter(r=>!q.id||r.id===q.id);const count=q.countRequested==='exact'?matches.length:null;if(q.range)matches=matches.slice(q.range[0],q.range[1]+1);result={data:q.single?(matches[0]||null):matches,count,error:null};}
    if(control.after)result=control.after(q,result)||result;return Promise.resolve(result).then(a,b);
  }};if(options.noRange)delete chain.range;return chain},storage:{from(){return{
    upload(path,file){calls.push({op:'upload',path,size:file.size});if(control.storageError)return Promise.resolve({error:control.storageError});blobs.add(path);return uploads?uploads():Promise.resolve({data:{path},error:null})},
    list(folder,options){calls.push({op:'storage-list',folder,options});if(control.storageError)return Promise.resolve({error:control.storageError});return Promise.resolve({data:[...blobs].filter(p=>p.startsWith(folder+'/')).map(p=>({name:p.split('/').at(-1)})),error:null})},
    createSignedUrl(path){calls.push({op:'signedUrl',path});return control.signing||Promise.resolve({data:{signedUrl:control.signedUrl}})}
  }}}};
  api=w.CreekMembership.create({root:w.document.getElementById('history-view'),db,sheetUrl:options.sheetUrl,documentUrl:options.documentUrl,getContext:()=>state,isCurrent:epoch=>epoch===state.epoch&&!!state.userId,people:()=>people,documents:()=>documents,ensureReady:async epoch=>{calls.push({op:'ensureReady',epoch});return gate?gate():state.workspaceReady},refresh:async()=>{},notice:(...args)=>notices.push(args)});
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
  const f=fixture(t);f.respond(q=>({data:q.range[0]===0?Array.from({length:1000},(_,i)=>({id:String(i),contact_id:'person-sample',event_type:'Synthetic historic entry'})):[{id:'1001',contact_id:'person-sample',event_type:'Unique later event'}],count:1001}));await f.api.load(1);const input=f.w.document.getElementById('membership-search');input.value='Unique later';input.dispatchEvent(new f.w.Event('input'));assert.match(f.w.document.getElementById('membership-history').textContent,/Unique later event/);assert.deepEqual(f.calls.map(q=>q.range),[[0,999],[1000,1999]]);assert.ok(f.calls.every(q=>q.countRequested==='exact'));
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

test('a late history commit invalidates early absence and requires recovery before another submit',async t=>{
  const f=fixture(t);await f.api.load(1);f.clock(true);const form=f.open();f.fill(form);let pendingRow,finish;f.respond(q=>{if(q.op==='insert'&&q.table==='membership_history'){pendingRow=q.row;return new Promise(resolve=>finish=resolve)}});f.submit(form);await delay();const id=pendingRow.id;f.expire();await delay();
  f.respond(null);form.querySelector('[data-recover]').click();await delay();assert.equal(form.querySelector('[type=submit]').disabled,false);
  f.rows.push(structuredClone(pendingRow));finish({data:{id},error:null});await delay();assert.equal(f.notices.length,0);assert.equal(form.querySelector('[type=submit]').disabled,true);
  f.submit(form);await delay();const inserts=f.calls.filter(q=>q.op==='insert');assert.equal(inserts.length,1);assert.equal(inserts[0].row.id,id);assert.equal(f.rows.length,1,'late completion requires a fresh check, never another automatic or manual write');
  form.querySelector('[data-recover]').click();await delay();assert.equal(f.form(),null);assert.equal(f.rows.length,1);assert.match(f.notices[0][0],/already saved/);
});


test('original page handoff uses the office URL policy without opening an automatic popup',async t=>{
  const checked=[];const f=fixture(t,{documentUrl(value){checked.push(value);const url=new URL(value);if(url.origin!=='http://127.0.0.1:55321'||url.username||url.password)throw new Error('unapproved source origin');return url;}});
  f.rows.push({id:'sample-history',contact_id:'person-sample',event_type:'Synthetic source',source_document_id:'sample-source'});
  f.documents.push({id:'sample-source',storage_path:'synthetic-user/page.png'});f.control.signedUrl='http://127.0.0.1:55321/storage/v1/object/sign/sample?token=synthetic';
  f.w.open=()=>assert.fail('Opening the source must wait for a user click');await f.api.load(1);
  [...f.w.document.querySelectorAll('.membership-entry button')].find(b=>b.textContent==='Open original page').click();await delay();
  const link=f.w.document.querySelector('dialog a');assert.ok(link);assert.equal(link.href,f.control.signedUrl);assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');assert.match(link.textContent,/expires in one minute/);assert.deepEqual(checked,[f.control.signedUrl]);
  f.api.clear();assert.equal(f.w.document.querySelector('dialog'),null);
});

async function sourceFixture(t){
  const f=fixture(t);f.rows.push({id:'sample-history',contact_id:'person-sample',event_type:'Fictional source',source_document_id:'sample-source'});f.documents.push({id:'sample-source',storage_path:'synthetic-user/page.png'});
  f.control.signedUrl='https://files.example.invalid/first-source';await f.api.load(1);
  f.sourceButton=()=>[...f.w.document.querySelectorAll('.membership-entry button')].find(b=>b.textContent==='Open original page');return f;
}
async function loseSourceAccess(f,kind){
  if(kind==='workspace'){f.state.canEdit=false;f.state.workspaceReady=false;f.api.render();}
  else{f.control.after=(q,result)=>q.table==='membership_history'&&q.op==='select'?{error:{message:'Fictional unavailable history'}}:result;await f.api.load(1);}
}
async function restoreSourceAccess(f){f.state.canEdit=true;f.state.workspaceReady=true;f.control.after=null;await f.api.load(1);}

test('source availability loss removes issued links and blocks reopen while preserving photo drafts',async t=>{
  for(const kind of ['workspace','history']){
    const f=await sourceFixture(t),original=f.sourceButton();original.click();await delay();assert.ok(f.w.document.querySelector('dialog a'));
    await loseSourceAccess(f,kind);assert.equal(f.w.document.querySelector('dialog'),null);const calls=f.calls.length;original.click();await delay();assert.equal(f.calls.length,calls);
    await restoreSourceAccess(f);f.control.signedUrl='https://files.example.invalid/renewed-source';f.sourceButton().click();await delay();assert.equal(f.w.document.querySelector('dialog a').href,f.control.signedUrl);
    f.w.document.querySelector('dialog button').click();const form=f.open();f.fill(form);f.photo(form);const file=form.elements.page.files[0];
    await loseSourceAccess(f,kind);assert.equal(f.form(),form);assert.equal(form.elements.page.files[0],file);assert.equal(form.elements.date_text.value,'Summer 1956; day [unclear]');assert.equal(form.querySelector('[type=submit]').disabled,true);assert.equal(f.revoked.length,0);
    await restoreSourceAccess(f);assert.equal(f.form(),form);assert.equal(form.querySelector('[type=submit]').disabled,false);
  }
});

test('late source metadata and signing cannot replace a fresh dialog after availability recovery',async t=>{
  for(const stage of ['metadata','signing'])for(const kind of ['workspace','history']){
    const f=await sourceFixture(t);let release;const pending=new Promise(resolve=>release=resolve);
    if(stage==='metadata')f.respond(q=>q.table==='documents'?pending:undefined);else f.control.signing=pending;
    f.sourceButton().click();await delay();await loseSourceAccess(f,kind);assert.equal(f.w.document.querySelector('dialog'),null);
    f.respond(null);f.control.signing=null;await restoreSourceAccess(f);f.control.signedUrl='https://files.example.invalid/current-source';f.sourceButton().click();await delay();
    const currentLink=f.w.document.querySelector('dialog a'),signings=f.calls.filter(q=>q.op==='signedUrl').length;assert.equal(currentLink.href,f.control.signedUrl);
    release(stage==='metadata'?{data:{storage_path:'synthetic-user/stale-page.png'}}:{data:{signedUrl:'https://files.example.invalid/stale-source'}});await delay();
    assert.equal(f.w.document.querySelector('dialog a'),currentLink);assert.equal(currentLink.href,f.control.signedUrl);assert.equal(f.calls.filter(q=>q.op==='signedUrl').length,signings);
  }
});

test('each source response rechecks workspace readiness even before the next render',async t=>{
  for(const stage of ['metadata','signing']){
    const f=await sourceFixture(t);let release;const pending=new Promise(resolve=>release=resolve);
    if(stage==='metadata')f.respond(q=>q.table==='documents'?pending:undefined);else f.control.signing=pending;
    f.sourceButton().click();await delay();f.state.canEdit=false;f.state.workspaceReady=false;
    release(stage==='metadata'?{data:{storage_path:'synthetic-user/page.png'}}:{data:{signedUrl:'https://files.example.invalid/stale-source'}});await delay();
    assert.equal(f.w.document.querySelector('dialog'),null);assert.equal(f.calls.filter(q=>q.op==='signedUrl').length,stage==='metadata'?0:1);
  }
});

test('identity clearing immediately removes a pending source dialog and ignores late signing',async t=>{
  const f=await sourceFixture(t);let release;f.control.signing=new Promise(resolve=>release=resolve);f.sourceButton().click();await delay();assert.ok(f.w.document.querySelector('dialog'));
  f.state.epoch++;f.state.userId=null;f.state.role=null;f.state.canEdit=false;f.api.clear();assert.equal(f.w.document.querySelector('dialog'),null);assert.equal(f.w.document.getElementById('membership-history').textContent,'');
  release({data:{signedUrl:'https://files.example.invalid/stale-source'}});await delay();assert.equal(f.w.document.querySelector('dialog'),null);assert.equal(f.notices.length,0);
});

test('source links without an office policy remain HTTPS-only and reject embedded credentials',async t=>{
  for(const [url,allowed] of [['https://files.example.invalid/sample',true],['http://127.0.0.1:55321/sample',false],['https://user:secret@files.example.invalid/sample',false],['javascript:alert(1)',false]]){
    const f=fixture(t);f.rows.push({id:'sample-history',contact_id:'person-sample',event_type:'Synthetic source',source_document_id:'sample-source'});f.documents.push({id:'sample-source',storage_path:'synthetic-user/page.png'});f.control.signedUrl=url;
    await f.api.load(1);[...f.w.document.querySelectorAll('.membership-entry button')].find(b=>b.textContent==='Open original page').click();await delay();assert.equal(!!f.w.document.querySelector('dialog a'),allowed);
  }
});


test('history spreadsheet shortcut appears after readiness and clears with private state',async t=>{
  const f=fixture(t,{sheetUrl:'https://docs.google.com/spreadsheets/d/Synthetic_123/edit'}),link=f.w.document.getElementById('membership-sheet-link');
  assert.equal(link.hidden,true);assert.equal(link.getAttribute('href'),null);
  await f.api.load(1);assert.equal(link.hidden,false);assert.equal(link.href,'https://docs.google.com/spreadsheets/d/Synthetic_123/edit');assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');
  f.state.canEdit=false;f.state.workspaceReady=false;f.api.render();assert.equal(link.hidden,true);assert.equal(link.getAttribute('href'),null);
  f.state.canEdit=true;f.state.workspaceReady=true;f.api.render();assert.equal(link.hidden,false);
  f.api.clear();assert.equal(link.hidden,true);assert.equal(link.getAttribute('href'),null);
  f.state.userId=null;const event=new f.w.MouseEvent('click',{cancelable:true});link.dispatchEvent(event);assert.equal(event.defaultPrevented,true);
});

test('reload cancellation is attached only for changed transcription/photo drafts and removed on discard or auth clear',async t=>{
  const f=fixture(t),listeners=new Set(),add=f.w.addEventListener.bind(f.w),remove=f.w.removeEventListener.bind(f.w);
  f.w.addEventListener=(type,handler,...rest)=>{if(type==='beforeunload')listeners.add(handler);return add(type,handler,...rest)};
  f.w.removeEventListener=(type,handler,...rest)=>{if(type==='beforeunload')listeners.delete(handler);return remove(type,handler,...rest)};
  const reload=()=>{const event=new f.w.Event('beforeunload',{cancelable:true});f.w.dispatchEvent(event);return event.defaultPrevented};
  await f.api.load(1);assert.equal(reload(),false);const form=f.open();assert.equal(reload(),false);assert.equal(listeners.size,0);
  form.elements.details.value='Synthetic unsaved transcription';form.elements.details.dispatchEvent(new f.w.Event('input',{bubbles:true}));
  assert.equal(reload(),true);assert.equal(listeners.size,1);
  form.elements.details.value='';form.elements.details.dispatchEvent(new f.w.Event('input',{bubbles:true}));assert.equal(reload(),false);assert.equal(listeners.size,0);
  f.photo(form);assert.equal(reload(),true);assert.equal(listeners.size,1);
  f.discard(false);f.w.document.querySelector('[data-close]').click();assert.equal(f.form(),form);assert.equal(reload(),true);
  f.discard(true);f.w.document.querySelector('[data-close]').click();assert.equal(f.form(),null);assert.equal(reload(),false);assert.equal(listeners.size,0);
  const next=f.open();f.fill(next);f.photo(next);assert.equal(reload(),true);f.api.clear();assert.equal(reload(),false);assert.equal(listeners.size,0);
});

test('reload cancellation covers pending and uncertain source uploads then clears after reconciled history save',async t=>{
  const f=fixture(t);const reload=()=>{const event=new f.w.Event('beforeunload',{cancelable:true});f.w.dispatchEvent(event);return event.defaultPrevented};
  await f.api.load(1);const form=f.open();f.fill(form);f.photo(form);let finish;
  f.uploads(()=>new Promise(resolve=>finish=resolve));f.submit(form);await delay();assert.equal(reload(),true);assert.equal(form.querySelector('[type=submit]').disabled,true);
  finish({error:{message:'Synthetic lost upload response'}});await delay();assert.equal(reload(),true);assert.equal(form.querySelector('[type=submit]').disabled,true);
  f.uploads(null);form.querySelector('[data-recover]').click();await delay();assert.equal(reload(),true);f.submit(form);await delay();
  assert.equal(f.rows.length,1);assert.equal(f.documents.length,1);assert.equal(f.form(),null);assert.equal(reload(),false);
});

async function pendingStage(t,stage){
  const f=fixture(t);await f.api.load(1);f.clock(true);const form=f.open();f.fill(form);f.photo(form);
  let finish,reject,payload;const response=new Promise((resolve,fail)=>{finish=resolve;reject=fail});
  if(stage==='upload')f.uploads(()=>response);
  else f.respond(q=>{if(q.op==='insert'&&q.table===(stage==='metadata'?'documents':'membership_history')){payload=q.row;return response}});
  f.submit(form);await delay();const path=f.calls.find(q=>q.op==='upload').path;
  if(stage==='upload')f.blobs.delete(path); // The original request has not committed yet.
  f.expire();await delay();
  return{f,form,finish,reject,payload,path,commit(){
    if(stage==='upload'){f.blobs.add(path);finish({data:{path},error:null})}
    else{(stage==='metadata'?f.documents:f.rows).push(structuredClone(payload));finish({data:{id:payload.id},error:null})}
  }};
}

test('early absence cannot discard unresolved upload, document or history writes; late completion requires a fresh check',async t=>{
  for(const stage of ['upload','metadata','history'])await t.test(stage,async t=>{
    const p=await pendingStage(t,stage),{f,form}=p;
    const reload=()=>{const event=new f.w.Event('beforeunload',{cancelable:true});f.w.dispatchEvent(event);return event.defaultPrevented};
    form.querySelector('[data-recover]').click();await delay();
    assert.equal(form.querySelector('[type=submit]').disabled,false,'a retry can retain the frozen IDs');
    assert.equal(f.w.document.querySelector('[data-close]').disabled,true);assert.equal(reload(),true);
    f.w.document.querySelector('[data-close]').click();f.w.document.querySelector('dialog').dispatchEvent(new f.w.Event('cancel',{cancelable:true}));
    assert.equal(f.form(),form);assert.equal(f.confirmations.length,0,'unsettled work cannot be discarded through confirmation');
    const writes=f.calls.filter(q=>q.op==='insert'||q.op==='upload').length;
    p.commit();await delay();
    assert.equal(f.form(),form);assert.equal(f.notices.length,0);assert.equal(reload(),true);
    assert.equal(form.querySelector('[type=submit]').disabled,true);assert.equal(f.w.document.querySelector('[data-close]').disabled,true);
    f.submit(form);await delay();assert.equal(f.calls.filter(q=>q.op==='insert'||q.op==='upload').length,writes,'late settlement never resumes its abandoned pipeline');
    f.respond(null);f.uploads(null);form.querySelector('[data-recover]').click();await delay();
    if(stage!=='history'){assert.equal(form.querySelector('[type=submit]').disabled,false);f.submit(form);await delay()}
    assert.equal(f.form(),null);assert.equal(reload(),false);assert.equal(f.blobs.size,1);assert.equal(f.documents.length,1);assert.equal(f.rows.length,1);
    assert.equal(f.rows[0].source_document_id,f.documents[0].id);assert.equal(f.documents[0].storage_path,p.path);
    assert.equal(f.calls.filter(q=>q.op==='upload').length,1);
  });
});

test('each overlapping same-ID history request must settle and be checked before an absent save can be discarded',async t=>{
  const f=fixture(t);await f.api.load(1);f.clock(true);const form=f.open();f.fill(form);const requests=[];
  f.respond(q=>{if(q.op==='insert'&&q.table==='membership_history')return new Promise((resolve,reject)=>requests.push({id:q.row.id,resolve,reject}))});
  f.submit(form);await delay();f.expire();await delay();form.querySelector('[data-recover]').click();await delay();
  f.submit(form);await delay();f.expire();await delay();assert.equal(requests.length,2);assert.equal(requests[0].id,requests[1].id);
  requests[0].reject(new Error('PRIVATE_SYNTHETIC_TRANSPORT'));await delay();
  assert.equal(form.querySelector('[type=submit]').disabled,true);form.querySelector('[data-recover]').click();await delay();
  assert.equal(form.querySelector('[type=submit]').disabled,false);assert.equal(f.w.document.querySelector('[data-close]').disabled,true,'settling one request leaves the other protected');
  f.w.document.querySelector('dialog').dispatchEvent(new f.w.Event('cancel',{cancelable:true}));assert.equal(f.form(),form);
  requests[1].resolve({data:null,error:{message:'PRIVATE_SYNTHETIC_RESPONSE'}});await delay();
  assert.equal(f.w.document.querySelector('[data-close]').disabled,true,'settlement itself cannot replace reconciliation');
  form.querySelector('[data-recover]').click();await delay();assert.equal(f.w.document.querySelector('[data-close]').disabled,false);
  assert.doesNotMatch(form.textContent,/PRIVATE_SYNTHETIC/);f.w.document.querySelector('[data-close]').click();assert.equal(f.form(),null);assert.equal(f.rows.length,0);
});

test('settlement during an absence check prevents that stale read from clearing uncertainty',async t=>{
  const p=await pendingStage(t,'history'),{f,form}=p;let finishRead;
  f.respond(q=>q.op==='select'&&q.table==='membership_history'&&q.single?new Promise(resolve=>finishRead=resolve):undefined);
  form.querySelector('[data-recover]').click();await delay();
  p.commit();await delay();finishRead({data:null,error:null});await delay();
  assert.equal(f.form(),form);assert.equal(form.querySelector('[type=submit]').disabled,true);assert.equal(f.w.document.querySelector('[data-close]').disabled,true);assert.equal(f.notices.length,0);
  f.respond(null);form.querySelector('[data-recover]').click();await delay();assert.equal(f.form(),null);assert.equal(f.rows.length,1);assert.equal(f.notices.length,1);
});

test('confirmed durable history completes safely while an earlier same-ID request remains pending',async t=>{
  const p=await pendingStage(t,'history'),{f,form}=p;form.querySelector('[data-recover]').click();await delay();
  f.respond(null);f.submit(form);await delay();assert.equal(f.form(),null);assert.equal(f.rows.length,1);assert.equal(f.rows[0].id,p.payload.id);
  const notices=f.notices.length,writes=f.calls.filter(q=>q.op==='insert'||q.op==='upload').length;
  p.finish({data:null,error:{code:'23505'}});await delay();assert.equal(f.form(),null);assert.equal(f.rows.length,1);assert.equal(f.notices.length,notices);
  assert.equal(f.calls.filter(q=>q.op==='insert'||q.op==='upload').length,writes);
});

test('auth clear removes protection immediately and late write settlements cannot change a replacement draft',async t=>{
  for(const stage of ['upload','metadata','history'])await t.test(stage,async t=>{
    const p=await pendingStage(t,stage),{f}=p;
    const reload=()=>{const event=new f.w.Event('beforeunload',{cancelable:true});f.w.dispatchEvent(event);return event.defaultPrevented};
    assert.equal(reload(),true);f.state.epoch=2;f.state.userId='synthetic-replacement';f.api.clear();assert.equal(reload(),false);assert.equal(f.form(),null);assert.equal(f.revoked.length,1);
    f.respond(null);f.uploads(null);await f.api.load(2);const replacement=f.open();assert.equal(reload(),false);
    const output=replacement.querySelector('output').textContent,writes=f.calls.filter(q=>q.op==='insert'||q.op==='upload').length;
    if(stage==='metadata')p.reject(new Error('PRIVATE_LATE_OLD_SESSION'));else p.commit();await delay();
    assert.equal(f.form(),replacement);assert.equal(replacement.querySelector('output').textContent,output);assert.equal(replacement.elements.details.disabled,false);
    assert.equal(f.w.document.querySelector('[data-close]').disabled,false);assert.equal(reload(),false);assert.equal(f.notices.length,0);
    assert.equal(f.calls.filter(q=>q.op==='insert'||q.op==='upload').length,writes);assert.doesNotMatch(f.w.document.body.textContent,/PRIVATE_LATE/);
  });
});

test('a600person archive loads below the requested page size and People history navigation clears an unrelated search',async t=>{
  const f=fixture(t);
  f.people.splice(0,f.people.length,...Array.from({length:600},(_,i)=>({id:'fictional-person-'+i,first_name:'Fictional '+i,last_name:'Archive',membership_number:String(i+1).padStart(4,'0')})));
  f.rows.push(...Array.from({length:2501},(_,i)=>({id:'fictional-history-'+i,contact_id:f.people[i%600].id,event_type:'Fictional history',date_text:String(1950+i%70),source_label:'Fictional page '+i,details:i===2500?'Unique final archive entry':'Fictional historical detail'})));
  f.respond(q=>q.range?{data:f.rows.slice(q.range[0],Math.min(q.range[1]+1,q.range[0]+500)),count:f.rows.length,error:null}:undefined);
  await f.api.load(1);
  assert.equal(f.w.document.getElementById('membership-person').options.length,601);
  assert.equal(f.w.document.querySelectorAll('.membership-entry').length,100);
  assert.match(f.w.document.getElementById('membership-status').textContent,/2501 history entries/);
  assert.deepEqual(f.calls.map(q=>q.range),[[0,999],[500,1499],[1000,1999],[1500,2499],[2000,2999],[2500,3499]]);
  assert.ok(f.calls.every(q=>q.countRequested==='exact'));
  const search=f.w.document.getElementById('membership-search');search.value='Unique final archive entry';search.dispatchEvent(new f.w.Event('input'));
  assert.equal(f.w.document.querySelectorAll('.membership-entry').length,1);assert.match(f.w.document.getElementById('membership-history').textContent,/Unique final archive entry/);
  f.api.selectPerson('fictional-person-599');
  assert.equal(search.value,'');assert.equal(f.w.document.getElementById('membership-person').value,'fictional-person-599');
  assert.equal(f.w.document.querySelectorAll('.membership-entry').length,4);assert.match(f.w.document.getElementById('membership-status').textContent,/4 history entries/);
  const form=f.open();assert.equal(form.elements.contact_id.value,'fictional-person-599');assert.equal(f.calls.some(q=>q.op==='insert'||q.op==='upload'),false);
});

test('invalid later archive pages never promote a partial list or discard the open review and photo',async t=>{
  const row=id=>({id,contact_id:'person-sample',event_type:'Fictional partial history'});
  const cases={
    'missing result':null,
    'null data':{data:null,count:2,error:null},
    'non-array data':{data:{length:1},count:2,error:null},
    'missing count':{data:[row('partial-2')],error:null},
    'negative count':{data:[row('partial-2')],count:-1,error:null},
    'fractional count':{data:[row('partial-2')],count:2.5,error:null},
    'unsafe count':{data:[row('partial-2')],count:Number.MAX_SAFE_INTEGER+1,error:null},
    'changed count':{data:[row('partial-2')],count:3,error:null},
    'empty before total':{data:[],count:2,error:null},
    'overflow':{data:[row('partial-2'),row('partial-3')],count:2,error:null},
    'duplicate ID':{data:[row('partial-1')],count:2,error:null},
    'empty ID':{data:[row('  ')],count:2,error:null},
    'missing ID':{data:[{contact_id:'person-sample',event_type:'Fictional malformed history'}],count:2,error:null}
  };
  for(const [label,result] of Object.entries(cases))await t.test(label,async t=>{
    const f=fixture(t);f.rows.push({id:'verified-before-refresh',contact_id:'person-sample',event_type:'Previously loaded fictional history'});
    await f.api.load(1);const form=f.open();f.fill(form);f.photo(form);
    f.respond(q=>q.range?(q.range[0]===0?{data:[row('partial-1')],count:2,error:null}:result):undefined);
    await f.api.load(1);
    assert.equal(f.w.document.querySelectorAll('.membership-entry').length,0);assert.equal(f.w.document.getElementById('membership-add').disabled,true);
    assert.match(f.w.document.getElementById('membership-status').textContent,/could not load/);assert.equal(f.form(),form);
    assert.equal(form.elements.details.value,'<img src=x onerror=alert(1)> remains literal');assert.equal(form.querySelector('.page-preview').hidden,false);
    assert.equal(form.querySelector('[type=submit]').disabled,true);
    const reload=new f.w.Event('beforeunload',{cancelable:true});f.w.dispatchEvent(reload);assert.equal(reload.defaultPrevented,true);
    f.submit(form);await delay();assert.equal(f.calls.some(q=>q.op==='insert'||q.op==='upload'),false);
    assert.equal(f.calls.filter(q=>q.range).length,3,'failed page stops without further requests');
    f.respond(null);await f.api.load(1);assert.equal(f.form(),form);assert.equal(f.w.document.getElementById('membership-add').disabled,false);
    assert.equal(form.querySelector('[type=submit]').disabled,false);assert.equal(f.w.document.querySelectorAll('.membership-entry').length,1);
  });
});

test('a query without range is accepted only when its single response proves the exact total',async t=>{
  for(const complete of [true,false]){
    const f=fixture(t,{noRange:true});f.rows.push({id:'fictional-single',contact_id:'person-sample',event_type:'Fictional complete history'});
    if(!complete)f.respond(()=>({data:f.rows,count:2,error:null}));
    await f.api.load(1);assert.equal(f.calls.length,1);assert.equal(f.calls[0].countRequested,'exact');
    assert.equal(f.w.document.getElementById('membership-add').disabled,!complete);
    assert.equal(f.w.document.querySelectorAll('.membership-entry').length,complete?1:0);
  }
});

test('a newer complete archive load supersedes an old partial load without another page request',async t=>{
  const f=fixture(t);let finish;
  f.respond(q=>q.range[0]===0?{data:[{id:'old-first',contact_id:'person-sample',event_type:'Old fictional page'}],count:3,error:null}:new Promise(resolve=>finish=resolve));
  const old=f.api.load(1);await delay();assert.equal(f.calls.length,2);
  f.respond(()=>({data:[{id:'new-complete',contact_id:'person-sample',event_type:'New fictional complete archive'}],count:1,error:null}));
  await f.api.load(1);finish({data:[{id:'old-second',contact_id:'person-sample',event_type:'Stale private page'}],count:3,error:null});await old;
  assert.equal(f.calls.length,3);assert.equal(f.w.document.querySelectorAll('.membership-entry').length,1);
  assert.match(f.w.document.getElementById('membership-history').textContent,/New fictional complete archive/);assert.doesNotMatch(f.w.document.getElementById('membership-history').textContent,/Old fictional|Stale private/);
  assert.equal(f.w.document.getElementById('membership-add').disabled,false);
});

test('auth clearing during a later archive page stops paging and erases the photo draft',async t=>{
  const f=fixture(t);await f.api.load(1);const form=f.open();f.fill(form);f.photo(form);let finish;
  f.respond(q=>q.range[0]===0?{data:[{id:'first-page',contact_id:'person-sample',event_type:'Fictional first page'}],count:3,error:null}:new Promise(resolve=>finish=resolve));
  const pending=f.api.load(1);await delay();f.state.epoch=2;f.state.userId=null;f.api.clear();
  finish({data:[{id:'late-page',contact_id:'person-sample',event_type:'Late private fictional page'}],count:3,error:null});await pending;
  assert.equal(f.calls.length,3);assert.equal(f.form(),null);assert.equal(f.revoked.length,1);
  assert.equal(f.w.document.getElementById('membership-history').textContent,'');assert.equal(f.w.document.getElementById('membership-person').options.length,1);
  const reload=new f.w.Event('beforeunload',{cancelable:true});f.w.dispatchEvent(reload);assert.equal(reload.defaultPrevented,false);
});
