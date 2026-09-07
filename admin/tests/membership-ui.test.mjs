import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source=await readFile(new URL('../membership.js',import.meta.url),'utf8');
const delay=()=>new Promise(resolve=>setTimeout(resolve,10));
function fixture(t){
  const dom=new JSDOM('<section id="history-view"></section>',{url:'https://office.example.invalid/admin/',runScripts:'outside-only'}),w=dom.window;
  t.after(()=>w.close());w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};
  w.eval(source);
  const state={epoch:1,userId:'synthetic-user',role:'editor',canEdit:true};
  const people=[{id:'person-sample',first_name:'Synthetic',last_name:'Record',membership_number:'SAMPLE-01'}];
  const calls=[],notices=[],rows=[];let respond=null,uploads=null,api;
  const db={from(table){const q={table,op:'select'};const chain={select(){return chain},order(){return chain},range(a,b){q.range=[a,b];return chain},eq(k,v){q[k]=v;return chain},maybeSingle(){q.single=true;return chain},single(){q.single=true;return chain},insert(row){q.op='insert';q.row=row;return chain},then(a,b){calls.push(q);const result=respond?respond(q):q.op==='insert'?{data:{id:'doc-synthetic'}}:{data:table==='membership_history'?rows:[]};return Promise.resolve(result).then(a,b)}};return chain},storage:{from(){return{upload(path,file){calls.push({op:'upload',path,size:file.size});return uploads?uploads():Promise.resolve({error:null})},createSignedUrl(){return Promise.resolve({data:{signedUrl:'javascript:alert(1)'}})}}}}};
  api=w.CreekMembership.create({root:w.document.getElementById('history-view'),db,getContext:()=>state,isCurrent:epoch=>epoch===state.epoch&&!!state.userId,people:()=>people,documents:()=>[],refresh:async()=>{},notice:(...args)=>notices.push(args)});
  const form=()=>w.document.querySelector('dialog form');
  const open=()=>{w.document.getElementById('membership-add').click();return form()};
  const fill=f=>{f.elements.contact_id.value=people[0].id;f.elements.event_type.value='Received by letter';f.elements.source_label.value='Synthetic ledger · page 1';f.elements.date_text.value='Summer 1956; day [unclear]';f.elements.details.value='<img src=x onerror=alert(1)> remains literal';f.elements.reviewed.checked=true};
  const submit=f=>f.dispatchEvent(new w.Event('submit',{cancelable:true,bubbles:true}));
  return{w,api,state,people,calls,rows,notices,open,fill,submit,respond:f=>respond=f,uploads:f=>uploads=f};
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

test('page upload checks size/type and stops metadata after a closed review',async t=>{
  const f=fixture(t);await f.api.load(1);let form=f.open();f.fill(form);Object.defineProperty(form.elements.page,'files',{value:[{type:'image/jpeg',size:15728641}],configurable:true});f.submit(form);await delay();assert(!f.calls.some(x=>x.op==='upload'));
  let release;f.uploads(()=>new Promise(resolve=>release=resolve));Object.defineProperty(form.elements.page,'files',{value:[{type:'image/jpeg',size:12}],configurable:true});f.submit(form);await delay();assert.match(f.calls.find(x=>x.op==='upload').path,/^synthetic-user\/membership-history\//);f.w.document.querySelector('[data-close]').click();release({error:null});await delay();assert(!f.calls.some(x=>x.table==='documents'&&x.op==='insert'));assert(!f.calls.some(x=>x.table==='membership_history'&&x.op==='insert'));
});

test('history pagination includes later pages so searches do not silently stop at 1000',async t=>{
  const f=fixture(t);f.respond(q=>({data:q.range[0]===0?Array.from({length:1000},(_,i)=>({id:String(i),contact_id:'person-sample',event_type:'Synthetic historic entry'})):[{id:'1001',contact_id:'person-sample',event_type:'Unique later event'}]}));await f.api.load(1);const input=f.w.document.getElementById('membership-search');input.value='Unique later';input.dispatchEvent(new f.w.Event('input'));assert.match(f.w.document.getElementById('membership-history').textContent,/Unique later event/);assert.deepEqual(f.calls.map(q=>q.range),[[0,999],[1000,1999]]);
});
