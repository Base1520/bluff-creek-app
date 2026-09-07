import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const code = await readFile(new URL('../office-content.js', import.meta.url), 'utf8');
const names = ['announcements', 'committees', 'slides', 'prayers'];
const tables = ['office_announcements', 'committee_contacts', 'sunday_slides', 'office_prayer_requests'];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(t, options={}) {
  const dom=new JSDOM(names.map(n=>'<section id="'+n+'"></section>').join(''),{url:'https://office.example.invalid/',runScripts:'outside-only'}),w=dom.window;
  t.after(()=>w.close());w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  w.eval(code);const rows=Object.fromEntries(tables.map(n=>[n,structuredClone(options.rows?.[n]||[])]));
  let context={epoch:1,userId:'sample-user',canEdit:true,role:options.role||'editor'}, refreshes=0, uploads=0, nextId=1;
  const calls=[],notices=[],opened=[],control={hold:null,error:null,noRows:false};
  const roots=Object.fromEntries(names.map(n=>[n,w.document.getElementById(n)]));
  const db={from(table){
    const q={table,op:'select',filters:[]};
    const chain={select(fields){q.fields=fields;return chain;},order(){return chain;},range(a,b){q.range=[a,b];return chain;},eq(k,v){q.filters.push([k,v]);return chain;},single(){q.single=true;return chain;},insert(data){q.op='insert';q.data=data;return chain;},update(data){q.op='update';q.data=data;return chain;},then(resolve,reject){
      calls.push(q);
      if(control.hold)return control.hold(q).then(resolve,reject);
      if(control.error)return Promise.resolve({error:{message:control.error}}).then(resolve,reject);
      if(q.op!=='select'&&control.noRows)return Promise.resolve({data:null,error:null}).then(resolve,reject);
      let data;
      if(q.op==='select')data=rows[table].slice(q.range?.[0]||0,q.range?q.range[1]+1:undefined);
      else if(q.op==='insert'){data={id:'new-'+nextId++,...structuredClone(q.data)};rows[table].push(data);}
      else{data=rows[table].find(r=>q.filters.every(([k,v])=>r[k]===v));if(data)Object.assign(data,structuredClone(q.data));}
      return Promise.resolve({data:q.single?(data?{id:data.id}:null):data,error:null}).then(resolve,reject);
    }};return chain;
  }};
  const docs=options.documents||[{id:'sample-document',title:'Sample presentation'}];let api;
  api=w.CreekOfficeContent.create({roots,db,getContext:()=>context,isCurrent:e=>context.epoch===e&&!!context.userId,documents:()=>docs,notice:(text,bad)=>notices.push({text,bad}),openDocument:id=>opened.push(id),uploadDocument:()=>uploads++,refresh:async()=>{refreshes++;await api.load(context.epoch);}});
  function form(){return w.document.querySelector('[data-office-form]');}
  function set(name,value,change=false){const node=form().querySelector('[name="'+name+'"]');if(node.type==='checkbox')node.checked=value;else node.value=value;if(change)node.dispatchEvent(new w.Event('change',{bubbles:true}));return node;}
  async function submit(force=false){if(force)form().reportValidity=()=>true;form().dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();await tick();}
  return {w,roots,api,rows,calls,notices,opened,control,form,set,submit,refreshes:()=>refreshes,uploads:()=>uploads,setContext:next=>context=next};
}
test('all records render as text; deck links are validated and files open only on a click',async t=>{
  const malicious='<img src=x onerror="window.unsafe=true">';
  const f=fixture(t,{rows:{office_announcements:[{id:'a',title:malicious,body:malicious,status:'ready'}],committee_contacts:[{id:'c',committee_name:malicious,contact_name:malicious,notes:malicious,status:'active'}],sunday_slides:[{id:'s',title:malicious,service_date:'2026-09-13',status:'ready',deck_url:'javascript:alert(1)',document_id:'sample-document'}],office_prayer_requests:[{id:'p',display_name:malicious,request_text:malicious,care_notes:malicious,status:'active',share_scope:'staff_only',sharing_approved:false}]}});
  await f.api.load(1);assert.equal(f.w.document.querySelector('img'),null);assert.equal(f.w.unsafe,undefined);assert.equal(f.roots.slides.querySelector('a'),null);assert.deepEqual(f.opened,[]);
  f.roots.slides.querySelector('[data-office-document]').click();assert.deepEqual(f.opened,['sample-document']);
  f.roots.slides.querySelector('[data-office-upload]').click();assert.equal(f.uploads(),1);
});
test('announcement dates are checked and exact write fields omit metadata',async t=>{
  const f=fixture(t);await f.api.load(1);f.api.open('announcements');f.set('title','Sample announcement');f.set('body','Sample text');f.set('starts_on','2026-09-13');f.set('ends_on','2026-09-12');
  await f.submit();assert.equal(f.calls.some(q=>q.op==='insert'),false);assert.match(f.form().textContent,/end date/);
  f.set('ends_on','2026-09-14');f.set('status','ready');await f.submit();
  const write=f.calls.find(q=>q.op==='insert');assert.deepEqual(Object.keys(write.data).sort(),['body','ends_on','starts_on','status','title']);assert.equal(write.fields,'id');assert.equal(write.single,true);assert.equal(f.form(),null);assert.match(f.roots.announcements.textContent,/not published/);
});
test('missing fields and excessive required text cannot save',async t=>{
  const f=fixture(t);await f.api.load(1);f.api.open('announcements');await f.submit();assert.equal(f.calls.some(q=>q.op==='insert'),false);
  f.set('title','x'.repeat(161));f.set('body','Sample body');await f.submit(true);assert.match(f.form().textContent,/160/);
  f.set('title','Sample');f.set('body','x'.repeat(10001));await f.submit(true);assert.match(f.form().textContent,/10,000/);assert.equal(f.calls.some(q=>q.op==='insert'),false);
});
test('committee edits preserve optional fields and inactive records remain discoverable by filter',async t=>{
  const f=fixture(t,{rows:{committee_contacts:[{id:'c',committee_name:'Sample committee',contact_name:'Sample contact',status:'active'}]}});await f.api.load(1);f.roots.committees.querySelector('[data-office-edit]').click();
  f.set('term_start','2026-09-01');f.set('term_end','2026-08-01');await f.submit();assert.equal(f.calls.some(q=>q.op==='update'),false);
  f.set('term_end','2027-08-01');f.set('email','sample@example.invalid');f.set('role_label','Sample role');f.set('status','inactive');await f.submit();
  const write=f.calls.find(q=>q.op==='update');assert.equal(write.data.phone,null);assert.equal(write.data.email,'sample@example.invalid');assert.equal(write.data.status,'inactive');assert.equal(f.roots.committees.querySelector('[data-office-edit]'),null);
  const status=f.roots.committees.querySelector('[data-office-status]');status.value='inactive';status.dispatchEvent(new f.w.Event('change',{bubbles:true}));assert.ok(f.roots.committees.querySelector('[data-office-edit]'));assert.equal(f.rows.committee_contacts.length,1);
});
test('ready slides need a source and HTTPS URL restrictions match the database',async t=>{
  const f=fixture(t);await f.api.load(1);f.api.open('slides');f.set('title','Sample Sunday deck');f.set('service_date','2026-09-13');f.set('status','ready');await f.submit();assert.match(f.form().textContent,/before marking slides ready/);
  for(const url of ['http://example.invalid/deck','https://user:pass@example.invalid/deck','https://example.invalid:0/deck','https://[::1]/deck','https://example.invalid/a b','https://example.invalid/a\\b','https://'+'a'.repeat(64)+'.invalid/deck','https://'+Array(5).fill('a'.repeat(60)).join('.')+'/deck']){
    f.set('deck_url',url);await f.submit(true);assert.equal(f.calls.some(q=>q.op==='insert'),false,'reject '+url);
  }
  f.set('deck_url','https://Example.Invalid:443/deck');await f.submit(true);const write=f.calls.find(q=>q.op==='insert');assert.equal(write.data.deck_url,'https://example.invalid/deck');assert.equal(write.data.document_id,null);
});
test('slides can attach an existing document, while the upload callback stays outside unsaved dialogs',async t=>{
  const f=fixture(t);await f.api.load(1);f.api.open('slides');f.set('title','Sample file deck');f.set('service_date','2026-09-13');f.set('status','ready');f.set('document_id','sample-document');
  assert.equal(f.form().querySelector('[data-office-upload]'),null);assert.equal(f.uploads(),0);await f.submit();const write=f.calls.find(q=>q.op==='insert');assert.equal(write.data.deck_url,null);assert.equal(write.data.document_id,'sample-document');
});
test('prayers default to staff only and nonstaff sharing requires explicit approval',async t=>{
  const f=fixture(t);await f.api.load(1);f.api.open('prayers');assert.equal(f.form().elements.share_scope.value,'staff_only');assert.equal(f.form().elements.sharing_approved.checked,false);assert.equal(f.form().elements.sharing_approved.disabled,true);
  f.set('display_name','Sample request');f.set('request_text','Synthetic prayer text');f.set('share_scope','church',true);assert.equal(f.form().elements.sharing_approved.required,true);await f.submit();assert.equal(f.calls.some(q=>q.op==='insert'),false);
  await f.submit(true);assert.match(f.form().textContent,/Record approval/);f.set('sharing_approved',true);await f.submit(true);
  const write=f.calls.find(q=>q.op==='insert');assert.equal(write.data.sharing_approved,true);assert.equal(write.data.share_scope,'church');assert.deepEqual(Object.keys(write.data).sort(),['care_notes','display_name','request_text','share_scope','sharing_approved','status']);
});
test('stored prayer approval survives opening but every scope change requires a fresh check',async t=>{
  const f=fixture(t,{rows:{office_prayer_requests:[{id:'p',display_name:'Sample request',request_text:'Sample text',status:'active',share_scope:'prayer_team',sharing_approved:true}]}});await f.api.load(1);f.roots.prayers.querySelector('[data-office-edit]').click();assert.equal(f.form().elements.sharing_approved.checked,true);
  f.set('share_scope','church',true);assert.equal(f.form().elements.sharing_approved.checked,false);await f.submit();assert.equal(f.calls.some(q=>q.op==='update'),false);
  f.set('sharing_approved',true);f.set('share_scope','prayer_team',true);assert.equal(f.form().elements.sharing_approved.checked,false);f.set('share_scope','staff_only',true);assert.equal(f.form().elements.sharing_approved.disabled,true);await f.submit();assert.equal(f.calls.find(q=>q.op==='update').data.sharing_approved,false);
});
test('periodic refresh preserves search, status choice, and the open unsaved dialog',async t=>{
  const f=fixture(t);await f.api.load(1);const search=f.roots.announcements.querySelector('[data-office-search]');search.value='Sample term';search.dispatchEvent(new f.w.Event('input',{bubbles:true}));
  f.api.open('announcements');f.set('title','Synthetic unsaved draft');f.set('body','Keep this text');await f.api.load(1);f.api.render();assert.equal(f.form().elements.title.value,'Synthetic unsaved draft');assert.equal(search.value,'Sample term');
});
test('zero returned rows is a failure that preserves the form without reporting saved',async t=>{
  const f=fixture(t,{rows:{office_announcements:[{id:'a',title:'Sample',body:'Sample body',status:'draft'}]}});await f.api.load(1);f.roots.announcements.querySelector('[data-office-edit]').click();f.set('body','Retain this draft');f.control.noRows=true;await f.submit();
  assert.match(f.form().querySelector('.office-content-error').textContent,/could not be saved/);assert.equal(f.form().elements.body.value,'Retain this draft');assert.equal(f.refreshes(),0);assert.equal(f.notices.length,0);
});
test('viewer has no private UI or requests; logout clears dialogs, filters, and late read responses',async t=>{
  const v=fixture(t,{role:'viewer'});assert.equal(await v.api.load(1),false);v.api.render();v.api.open('prayers');assert.equal(v.calls.length,0);assert.equal(v.form(),null);assert.equal(v.roots.prayers.textContent,'');
  const f=fixture(t);await f.api.load(1);f.api.open('prayers');f.set('request_text','Synthetic private draft');const pending=[];f.control.hold=()=>new Promise(resolve=>pending.push(resolve));const reading=f.api.load(1);await tick();
  f.setContext({epoch:2,userId:null,canEdit:false,role:null});f.api.clear();pending.forEach(resolve=>resolve({data:[],error:null}));await reading;
  assert.equal(f.form(),null);for(const host of Object.values(f.roots))assert.equal(host.textContent,'');assert.equal(f.w.document.body.textContent.includes('Synthetic private draft'),false);
});
test('late saves cannot refresh or notify a replacement session; private errors remain generic',async t=>{
  const f=fixture(t);await f.api.load(1);f.api.open('announcements');f.set('title','Sample');f.set('body','Sample body');let finish;f.control.hold=()=>new Promise(resolve=>finish=resolve);const saving=f.submit();await tick();
  f.setContext({epoch:2,userId:'other-sample',role:'editor',canEdit:true});f.api.clear();finish({data:{id:'saved-old-session'},error:null});await saving;assert.equal(f.refreshes(),0);assert.equal(f.notices.length,0);assert.equal(f.form(),null);
  const g=fixture(t);await g.api.load(1);g.api.open('announcements');g.set('title','Sample');g.set('body','Sample body');g.control.error='PRIVATE_DATABASE_ERROR_CANARY';await g.submit();assert.doesNotMatch(g.w.document.body.textContent,/PRIVATE_DATABASE_ERROR_CANARY/);assert.match(g.form().querySelector('.office-content-error').textContent,/could not be saved/);
});
test('stable pagination includes later rows and the list explicitly bounds its rendered results',async t=>{
  const rows=Array.from({length:1001},(_,i)=>({id:'row-'+i,title:i===1000?'Only final record':'Sample '+i,body:'Sample body',status:'draft'}));const f=fixture(t,{rows:{office_announcements:rows}});await f.api.load(1);
  assert.equal(f.calls.filter(q=>q.table==='office_announcements').length,2);assert.equal(f.roots.announcements.querySelectorAll('.office-content-row').length,100);assert.match(f.roots.announcements.textContent,/Showing the first 100/);
  const search=f.roots.announcements.querySelector('[data-office-search]');search.value='Only final record';search.dispatchEvent(new f.w.Event('input',{bubbles:true}));assert.equal(f.roots.announcements.querySelectorAll('.office-content-row').length,1);
});
