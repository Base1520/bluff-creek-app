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
  t.after(()=>w.close());w.confirm=()=>true;w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  w.eval(code);const rows=Object.fromEntries(tables.map(n=>[n,structuredClone(options.rows?.[n]||[]).map(r=>({version:1,...r}))]));
  let context={epoch:1,userId:'sample-user',canEdit:true,role:options.role||'editor'}, refreshes=0, uploads=0, nextId=1;
  const calls=[],notices=[],opened=[],control={hold:null,error:null,noRows:false};
  const roots=Object.fromEntries(names.map(n=>[n,w.document.getElementById(n)]));
  const db={from(table){
    const q={table,op:'select',filters:[]};
    const chain={select(fields){q.fields=fields;return chain;},order(){return chain;},range(a,b){q.range=[a,b];return chain;},eq(k,v){q.filters.push([k,v]);return chain;},single(){q.single=true;return chain;},maybeSingle(){q.single=true;return chain;},insert(data){q.op='insert';q.data=data;return chain;},update(data){q.op='update';q.data=data;return chain;},then(resolve,reject){
      calls.push(q);
      if(control.hold)return control.hold(q).then(resolve,reject);
      if(control.error)return Promise.resolve({error:typeof control.error==='object'?control.error:{message:control.error}}).then(resolve,reject);
      if(q.op!=='select'&&control.noRows)return Promise.resolve({data:null,error:null}).then(resolve,reject);
      let data;
      if(q.op==='select')data=rows[table].filter(r=>q.filters.every(([k,v])=>r[k]===v)).slice(q.range?.[0]||0,q.range?q.range[1]+1:undefined);
      else if(q.op==='insert'){if(rows[table].some(r=>r.id===q.data.id))return Promise.resolve({error:{code:'23505'}}).then(resolve,reject);data={id:'new-'+nextId++,version:1,...structuredClone(q.data)};rows[table].push(data);}
      else{data=rows[table].find(r=>q.filters.every(([k,v])=>r[k]===v));if(data)Object.assign(data,structuredClone(q.data),{version:data.version+1});}
      return Promise.resolve({data:structuredClone(q.single?(Array.isArray(data)?data[0]||null:data||null):data),error:null}).then(resolve,reject);
    }};return chain;
  }};
  const docs=options.documents||[{id:'sample-document',title:'Sample presentation'}];let api;
  api=w.CreekOfficeContent.create({roots,db,getContext:()=>context,isCurrent:e=>context.epoch===e&&!!context.userId,documents:()=>docs,notice:(text,bad)=>notices.push({text,bad}),ensureReady:options.ensureReady,openDocument:id=>opened.push(id),uploadDocument:()=>uploads++,refresh:async()=>{refreshes++;await api.load(context.epoch);}});
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
  const write=f.calls.find(q=>q.op==='insert');assert.deepEqual(Object.keys(write.data).sort(),['body','ends_on','id','starts_on','status','title']);assert.equal(write.fields,'id,version');assert.equal(write.single,true);assert.equal(f.form(),null);assert.match(f.roots.announcements.textContent,/not published/);
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
  const write=f.calls.find(q=>q.op==='insert');assert.equal(write.data.sharing_approved,true);assert.equal(write.data.share_scope,'church');assert.deepEqual(Object.keys(write.data).sort(),['care_notes','display_name','id','request_text','share_scope','sharing_approved','status']);
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
  assert.match(f.form().querySelector('.office-content-error').textContent,/could not be confirmed/);assert.equal(f.form().elements.body.value,'Retain this draft');assert.equal(f.refreshes(),0);assert.equal(f.notices.length,0);
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
  const g=fixture(t);await g.api.load(1);g.api.open('announcements');g.set('title','Sample');g.set('body','Sample body');g.control.error='PRIVATE_DATABASE_ERROR_CANARY';await g.submit();assert.doesNotMatch(g.w.document.body.textContent,/PRIVATE_DATABASE_ERROR_CANARY/);assert.match(g.form().querySelector('.office-content-error').textContent,/could not be confirmed/);
});
test('stable pagination includes later rows and the list explicitly bounds its rendered results',async t=>{
  const rows=Array.from({length:1001},(_,i)=>({id:'row-'+i,title:i===1000?'Only final record':'Sample '+i,body:'Sample body',status:'draft'}));const f=fixture(t,{rows:{office_announcements:rows}});await f.api.load(1);
  assert.equal(f.calls.filter(q=>q.table==='office_announcements').length,2);assert.equal(f.roots.announcements.querySelectorAll('.office-content-row').length,100);assert.match(f.roots.announcements.textContent,/Showing the first 100/);
  const search=f.roots.announcements.querySelector('[data-office-search]');search.value='Only final record';search.dispatchEvent(new f.w.Event('input',{bubbles:true}));assert.equal(f.roots.announcements.querySelectorAll('.office-content-row').length,1);
});

test('stale prayer changes cannot overwrite a newer sharing decision',async t=>{
  const f=fixture(t,{rows:{office_prayer_requests:[{id:'p',display_name:'Sample request',request_text:'Sample text',status:'active',share_scope:'staff_only',sharing_approved:false}]}});
  await f.api.load(1);f.roots.prayers.querySelector('[data-office-edit]').click();f.set('share_scope','church',true);f.set('sharing_approved',true);
  Object.assign(f.rows.office_prayer_requests[0],{version:2,request_text:'Newer sample text',share_scope:'staff_only',sharing_approved:false});
  await f.submit();const write=f.calls.find(q=>q.op==='update');assert.ok(write.filters.some(([k,v])=>k==='version'&&v===1));assert.equal(f.rows.office_prayer_requests[0].sharing_approved,false);
  assert.equal(f.form().querySelector('[type=submit]').disabled,true);f.form().querySelector('[data-office-reconcile]').click();await tick();await tick();assert.match(f.form().textContent,/record changed/);assert.equal(f.form().querySelector('[type=submit]').disabled,true);assert.equal(f.form().querySelector('[data-office-close]').disabled,false);
});
test('a committed create with a lost response is reconciled without inserting twice',async t=>{
  const f=fixture(t);await f.api.load(1);f.api.open('announcements');f.set('title','Sample recovery');f.set('body','Keep these words');
  f.control.hold=async q=>{f.rows[q.table].push({...structuredClone(q.data),version:1});return {error:{message:'network'}};};
  await f.submit();assert.equal(f.form().elements.body.disabled,true);assert.equal(f.form().querySelector('[data-office-close]').disabled,true);
  await f.submit();assert.equal(f.calls.filter(q=>q.op==='insert').length,1);f.control.hold=null;f.form().querySelector('[data-office-reconcile]').click();await tick();await tick();
  assert.equal(f.form(),null);assert.equal(f.rows.office_announcements.length,1);assert.match(f.notices[0].text,/confirmed/);
});
test('an uncommitted create reuses its draft ID only after a read confirms it is absent',async t=>{
  const f=fixture(t);await f.api.load(1);f.api.open('announcements');f.set('title','Sample retry');f.set('body','Keep this draft');f.control.error='network';await f.submit();
  const first=f.calls.find(q=>q.op==='insert').data.id;f.control.error=null;f.form().querySelector('[data-office-reconcile]').click();await tick();await tick();assert.equal(f.form().querySelector('[type=submit]').disabled,false);await f.submit();
  assert.equal(f.calls.filter(q=>q.op==='insert')[1].data.id,first);assert.equal(f.rows.office_announcements.length,1);
});
test('pending writes freeze all fields and close; transient outages preserve drafts, revocation clears them',async t=>{
  const f=fixture(t);await f.api.load(1);f.api.open('announcements');f.set('title','Retain sample');f.set('body','Reviewed snapshot');
  f.setContext({epoch:1,userId:'sample-user',canEdit:false,role:'editor',workspaceReady:false});f.api.render();assert.equal(f.form().elements.body.value,'Reviewed snapshot');assert.equal(f.form().elements.body.disabled,true);
  f.setContext({epoch:1,userId:'sample-user',canEdit:true,role:'editor',workspaceReady:true});f.api.render();let finish;f.control.hold=()=>new Promise(resolve=>finish=resolve);const saving=f.submit();await tick();
  assert.equal(f.form().elements.body.disabled,true);assert.equal(f.form().querySelector('[data-office-close]').disabled,true);f.form().elements.body.value='Scripted later change';assert.equal(f.calls.find(q=>q.op==='insert').data.body,'Reviewed snapshot');
  f.setContext({epoch:2,userId:null,canEdit:false,role:null});f.api.clear();finish({error:{message:'network'}});await saving;assert.equal(f.form(),null);assert.equal(f.notices.length,0);
});
test('fresh readiness failure prevents a write and an authorization error clears private drafts',async t=>{
  const f=fixture(t,{ensureReady:async()=>false});await f.api.load(1);f.api.open('prayers');f.set('display_name','Sample');f.set('request_text','Private synthetic draft');await f.submit();assert.equal(f.calls.some(q=>q.op==='insert'),false);assert.ok(f.form());
  const g=fixture(t);await g.api.load(1);g.api.open('prayers');g.set('display_name','Sample');g.set('request_text','Private synthetic draft');g.control.error={code:'42501',message:'private'};await g.submit();assert.equal(g.form(),null);assert.equal(g.roots.prayers.textContent,'');
});

test('Cancel asks before discarding a changed draft and keeps it when staff stay',async t=>{const f=fixture(t);await f.api.load(1);f.api.open('announcements');f.set('title','Keep sample');let asks=0;f.w.confirm=()=>{asks++;return false;};f.form().querySelector('[data-office-close]').click();assert.ok(f.form());assert.equal(asks,1);f.w.confirm=()=>true;f.form().querySelector('[data-office-close]').click();assert.equal(f.form(),null);});

test('a stalled content save becomes recoverable instead of leaving the draft busy',async t=>{const f=fixture(t);await f.api.load(1);f.api.open('announcements');f.set('title','Sample stalled save');f.set('body','Keep recovery identity');f.w.setTimeout=fn=>setTimeout(fn,1);f.w.clearTimeout=clearTimeout;f.control.hold=()=>new Promise(()=>{});await f.submit();await tick();assert.match(f.form().textContent,/could not be confirmed/);const check=f.form().querySelector('[data-office-reconcile]');assert.equal(check.hidden,false);assert.equal(check.disabled,false);assert.equal(f.form().querySelector('[type=submit]').disabled,true);});

for (const transition of ['clear', 'new-user', 'viewer', 'unavailable']) {
  test('accepted content discard cannot reopen private details after ' + transition, async t => {
    const f = fixture(t, { rows: { office_prayer_requests: [{ id: 'sample-prayer', display_name: 'Fictional request', request_text: 'OLD_PRIVATE_PRAYER_CANARY', status: 'active', share_scope: 'staff_only', sharing_approved: false }] } });
    await f.api.load(1);
    f.api.open('announcements'); f.set('title', 'Unsaved sample announcement');
    f.w.confirm = () => {
      if (transition === 'clear') { f.setContext({ epoch: 2, userId: null, role: null, canEdit: false }); f.api.clear(); }
      if (transition === 'new-user') f.setContext({ epoch: 2, userId: 'other-sample-user', role: 'editor', canEdit: true });
      if (transition === 'viewer') f.setContext({ epoch: 1, userId: 'sample-user', role: 'viewer', canEdit: false });
      if (transition === 'unavailable') f.setContext({ epoch: 1, userId: 'sample-user', role: 'editor', canEdit: false, workspaceReady: false });
      return true;
    };
    f.roots.prayers.querySelector('[data-office-edit]').click();
    assert.equal(f.form(), null);
    assert.equal(f.calls.some(q => q.op !== 'select'), false);
    assert.equal(f.w.document.querySelector('.office-content-dialog'), null);
  });
}

test('an earlier content discard decision cannot erase a replacement draft', async t => {
  const f = fixture(t); await f.api.load(1);
  f.api.open('announcements'); f.set('title', 'Old sample draft');
  f.w.confirm = () => {
    f.w.confirm = () => true;
    f.api.open('committees'); f.set('committee_name', 'Keep replacement draft');
    return true;
  };
  f.form().querySelector('[data-office-close]').click();
  assert.ok(f.form());
  assert.equal(f.form().elements.committee_name.value, 'Keep replacement draft');
  assert.equal(f.w.document.querySelectorAll('.office-content-dialog').length, 1);
  assert.equal(f.calls.some(q => q.op !== 'select'), false);
});
