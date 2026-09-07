import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const html = await readFile(new URL('../index.html',import.meta.url),'utf8');
const app = await readFile(new URL('../app.js',import.meta.url),'utf8');
const session = id => ({ user:{ id, email:'staff-'+id+'@example.invalid' }, access_token:'synthetic-token' });
const pause = () => new Promise(r=>setTimeout(r,15));
const deferred = () => { let resolve; const promise=new Promise(r=>resolve=r);return {promise,resolve}; };
function fixture(t,options={}) {
  const dom = new JSDOM(html,{url:'https://office.example.invalid/admin/',runScripts:'outside-only'}),w=dom.window;
  t.after(()=>w.close());
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
  const calls=[], delayed=[], pending=[]; let callback, current=options.initial===undefined?session('a'):options.initial, insideCallback=false;
  const records = new Map();
  const rows = owner => { if (!records.has(owner)) records.set(owner, ({ events:[{id:'event-'+owner,title:'Synthetic gathering '+owner,starts_at:'2030-01-06T15:00:00Z',tag:'Special'}], contacts:[{id:'person-'+owner,first_name:'Synthetic',last_name:'Record '+owner,status:'active',updated_at:'2030-01-01',notes:'Synthetic private note '+owner}], documents:[{id:'doc-'+owner,title:'Sample policy '+owner,file_name:'fixture.pdf',storage_path:owner+'/fixture.pdf',category:'policy',updated_at:'2030-01-01'}],audit_log:[] })); const value=records.get(owner); Object.values(value).forEach(list=>list.forEach(row=>{ if(!row.version)row.version=1; })); return value; };
  function respond(q) {
    calls.push(q);
    assert.equal(insideCallback,false,'database work must not run inside the auth callback');
    if(delayed.some(match=>match(q))) {const d=deferred();pending.push({q,...d});return d.promise;}
    if(options.onQuery) { const result=options.onQuery(q,rows); if(result!==undefined)return Promise.resolve(result); }
    if(q.table==='staff_roles')return Promise.resolve({data:options.roles?.[q.owner]===null?null:{role:options.roles?.[q.owner]||'editor'}});
    const records=rows(q.owner)[q.table];
    if(q.op==='select')return Promise.resolve({data:records.filter(row=>!q.id||row.id===q.id)});
    if(q.op==='insert') { if(records.some(row=>row.id===q.row.id))return Promise.resolve({error:{code:'23505'}}); const row={...q.row,version:1,updated_at:'2030-01-01',created_at:'2030-01-01'};records.push(row);return Promise.resolve({data:row}); }
    if(q.op==='update') {const row=records.find(row=>row.id===q.id&&row.version===q.version);if(!row)return Promise.resolve({data:null,error:null});Object.assign(row,q.row,{version:row.version+1,updated_at:'2030-01-01'});return Promise.resolve({data:row});}
    return Promise.resolve({data:null,error:null});
  }
  const client={auth:{
    stopAutoRefresh(){}, startAutoRefresh(){},
    onAuthStateChange(cb){callback=cb;return {data:{subscription:{unsubscribe(){}}}};},
    async getSession(){return {data:{session:current}};},
    async signInWithPassword(){if(options.signInDeferred)return options.signInDeferred.promise;w.sessionStorage.setItem('creek-office-auth',JSON.stringify(session('a')));emit(session('a'),'SIGNED_IN');return {data:{session:current}};},
    async signOut(){if(options.signOutDeferred)return options.signOutDeferred.promise;emit(null);return {error:null};}
  },rpc(name){calls.push({op:'rpc',name});const role=options.roles?.[current?.user.id]||'editor';return Promise.resolve(typeof options.readiness==='function'?options.readiness():options.readiness||{data:{schema_revision:'20260907174301',staff_role:role,supported_modules:['events','contacts','documents','activity','membership','care','office_content','app_signups','leader_followups']}});},from(table){
    assert.equal(insideCallback,false,'do not start database queries inside the auth callback');
    const q={table,owner:current?.user.id,op:'select'};
    const chain={select(){return chain;},eq(k,v){q[k]=v;return chain;},order(){return chain;},limit(){return chain;},maybeSingle(){return chain;},single(){q.single=true;return chain;},insert(row){q.op='insert';q.row=row;return chain;},update(row){q.op='update';q.row=row;return chain;},delete(){q.op='delete';return chain;},then(a,b){return respond(q).then(a,b);}};return chain;
  },storage:{from(){return {
    async upload(path,file){calls.push({op:'upload',path,size:file.size});if(options.uploadDeferred)return options.uploadDeferred.promise;return {error:null};},
    async list(path,opts){calls.push({op:'list',path,options:opts});return options.storageList||{data:[]};},
    async remove(paths){calls.push({op:'remove',paths});return {error:null};},
    async createSignedUrl(){calls.push({op:'signedUrl'});if(options.signedDeferred)return options.signedDeferred.promise;return {data:{signedUrl:'https://files.example.invalid/synthetic?token=test'}};}
  };}}};
  function emit(next,event='TEST'){current=next;insideCallback=true;const returned=callback(event,next);insideCallback=false;assert.equal(returned,undefined);}
  if (options.followups) w.CreekFollowups = { create(moduleOptions) { options.followups.options = moduleOptions; return { load: async () => moduleOptions.onSummary(options.followups.summary), render() {}, clear() { moduleOptions.onSummary({ due:null, overdue:null, upcoming:null, items:[] }); }, openNew() {} }; } };
  let created=0; w.CREEK_OFFICE_CONFIG=options.config||{supabaseUrl:'https://project.example.invalid',publishableKey:'sb_publishable_synthetic'};
  w.supabase={createClient(){created++;return client;}};w.eval(app);
  const el=id=>w.document.getElementById(id);
  return {w,el,calls,delayed,pending,emit,created:()=>created,rows};
}
test('logout immediately clears open record, hidden lists, filters and pending data',async t=>{
  const d=deferred(),f=fixture(t,{signOutDeferred:d});await pause();
  f.w.location.hash='#people';f.el('people-list').querySelector('button').click();
  assert.equal(f.el('editor').open,true);assert.match(f.el('editor-fields').textContent,/Synthetic private note a/);
  f.el('people-search').value='Synthetic';f.el('logout').click();
  assert.equal(f.el('editor').open,false);assert.equal(f.el('editor-fields').textContent,'');assert.equal(f.el('people-list').textContent,'');assert.equal(f.el('people-search').value,'');assert.equal(f.el('user-label').textContent,'');assert.equal(f.el('login').classList.contains('hidden'),false);
  d.resolve({error:null});
});
test('late account-A data and role responses cannot replace account-B state',async t=>{
  const f=fixture(t,{initial:null});await pause();f.delayed.push(q=>q.owner==='a');f.emit(session('a'));await pause();
  assert.equal(f.pending.length,1);f.emit(session('b'));await pause();
  f.pending[0].resolve({data:{role:'admin'}});await pause();assert.match(f.el('user-label').textContent,/staff-b/);assert.match(f.el('people-list').textContent,/Record b/);assert.doesNotMatch(f.el('people-list').textContent,/Record a/);
});
test('late table fetch after logout cannot repopulate private DOM',async t=>{
  const f=fixture(t,{initial:null});await pause();f.delayed.push(q=>q.owner==='a'&&q.table!=='staff_roles');f.emit(session('a'));await pause();assert.equal(f.pending.length,4);
  f.emit(null);for(const p of f.pending)p.resolve({data:f.rows('a')[p.q.table]});await pause();
  assert.equal(f.el('people-list').textContent,'');assert.equal(f.el('documents-list').textContent,'');assert.equal(f.el('workspace').classList.contains('hidden'),true);
});
test('same-account token events preserve unsaved edits; viewer cannot open editor',async t=>{
  const f=fixture(t);await pause();f.el('people-list').querySelector('button').click();f.el('editor-fields').querySelector('[name=notes]').value='Synthetic unsaved edit';f.emit(session('a'));await pause();assert.equal(f.el('editor').open,true);assert.equal(f.el('editor-fields').querySelector('[name=notes]').value,'Synthetic unsaved edit');
  const v=fixture(t,{roles:{a:'viewer'}});await pause();v.w.location.hash='#people';await pause();assert.equal(v.el('primary-action').classList.contains('hidden'),true);v.el('primary-action').click();assert.equal(v.el('editor').open,false);assert.equal(v.el('people-list').querySelector('button'),null);
  for(const view of ['history','care','signups','followups','announcements','committees','slides','prayers']) {
    v.w.location.hash='#'+view;await pause();
    assert.equal(v.el(view+'-view').classList.contains('hidden'),true);
    assert.equal(v.w.document.querySelector('[data-view="'+view+'"]').classList.contains('hidden'),true);
    assert.equal(v.el('page-title').textContent,'Overview');
  }
});
test('document links require a fresh user click and disappear on account change',async t=>{
  const f=fixture(t);await pause();f.w.open=()=>assert.fail('No async popup');f.el('documents-list').querySelector('button').click();await pause();
  const link=f.el('document-result').querySelector('a');assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener');assert.match(link.href,/files.example.invalid/);f.emit(null);assert.equal(f.el('document-dialog').open,false);assert.equal(f.el('document-result').textContent,'');
  const d=deferred(),g=fixture(t,{signedDeferred:d});await pause();g.el('documents-list').querySelector('button').click();g.emit(null);d.resolve({data:{signedUrl:'https://files.example.invalid/stale'}});await pause();assert.equal(g.el('document-result').querySelector('a'),null);
});
test('50 MB preflight blocks the network and account change stops upload metadata',async t=>{
  const f=fixture(t);await pause();f.w.location.hash='#documents';await pause();f.el('primary-action').click();
  const data=new Map([['title','Synthetic upload'],['category','policy'],['file',{name:'fixture.pdf',size:52428801,type:'application/pdf'}]]);f.w.FormData=class{get(k){return data.get(k);}};
  f.el('editor-form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await pause();assert.match(f.el('editor-error').textContent,/larger than 50 MB/);assert.equal(f.calls.some(q=>q.op==='upload'),false);
  const d=deferred(),g=fixture(t,{uploadDeferred:d});await pause();g.w.location.hash='#documents';await pause();g.el('primary-action').click();data.get('file').size=12;g.w.FormData=f.w.FormData;g.el('editor-form').dispatchEvent(new g.w.Event('submit',{bubbles:true,cancelable:true}));await pause();g.emit(session('b'));d.resolve({error:null});await pause();assert.equal(g.calls.some(q=>q.table==='documents'&&q.op==='insert'),false);assert.match(g.el('user-label').textContent,/staff-b/);
});
test('secret/service-role config fails closed without constructing a client',async t=>{
  for(const key of ['sb_secret_synthetic','x.'+Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url')+'.x']) {const f=fixture(t,{config:{supabaseUrl:'https://project.example.invalid',publishableKey:key}});await pause();assert.equal(f.created(),0);assert.equal(f.el('setup').classList.contains('hidden'),false);}
});
test('failed sign-out stays locked against late auth callbacks and clears only owned storage',async t=>{
  const d=deferred(),f=fixture(t,{signOutDeferred:d});await pause();
  f.w.sessionStorage.setItem('creek-office-auth','synthetic session');f.w.sessionStorage.setItem('creek-office-auth-code-verifier','synthetic verifier');f.w.sessionStorage.setItem('unrelated-preference','keep');
  f.el('logout').click();d.resolve({error:{message:'Synthetic offline failure'}});await pause();
  f.w.sessionStorage.setItem('creek-office-auth','late synthetic token');f.emit(session('a'));await pause();
  assert.equal(f.el('workspace').classList.contains('hidden'),true);assert.equal(f.el('people-list').textContent,'');assert.equal(f.w.sessionStorage.getItem('creek-office-auth'),null);assert.equal(f.w.sessionStorage.getItem('creek-office-auth-code-verifier'),null);assert.equal(f.w.sessionStorage.getItem('unrelated-preference'),'keep');
  f.el('email').value='synthetic@example.invalid';f.el('password').value='synthetic';f.el('login-form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await pause();
  assert.equal(f.el('workspace').classList.contains('hidden'),false);assert.match(f.el('people-list').textContent,/Record a/);
  const stored=JSON.parse(f.w.sessionStorage.getItem('creek-office-auth'));assert.equal(stored.user.id,'a');
  const refreshed=fixture(t,{initial:stored});await pause();assert.equal(refreshed.el('workspace').classList.contains('hidden'),false);
});
test('late token during a manual sign-in cannot unlock UI; failed sign-in clears it',async t=>{
  const d=deferred(),f=fixture(t,{signInDeferred:d});await pause();f.el('logout').click();await pause();
  f.el('login-form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));
  f.w.sessionStorage.setItem('creek-office-auth','late synthetic token');f.emit(session('a'),'TOKEN_REFRESHED');await pause();
  assert.equal(f.el('workspace').classList.contains('hidden'),true);assert.equal(f.el('people-list').textContent,'');
  d.resolve({error:{message:'Synthetic invalid credentials'}});await pause();assert.equal(f.w.sessionStorage.getItem('creek-office-auth'),null);assert.equal(f.el('workspace').classList.contains('hidden'),true);
});
test('document expiry removes the signed URL visibly',async t=>{
  const f=fixture(t);await pause();let expire;const real=f.w.setTimeout.bind(f.w);f.w.setTimeout=(fn,ms)=>ms===60000?(expire=fn,99):real(fn,ms);
  f.el('documents-list').querySelector('button').click();await pause();assert.ok(f.el('document-result').querySelector('a'));expire();assert.equal(f.el('document-result').querySelector('a'),null);assert.match(f.el('document-result').textContent,/expired/);
});
test('text rendered into editor values cannot create markup or event attributes',async t=>{
  const f=fixture(t,{initial:null});await pause();f.delayed.push(q=>q.table==='contacts');f.emit(session('a'));await pause();f.pending[0].resolve({data:[{...f.rows('a').contacts[0],first_name:'Synthetic" autofocus onfocus="alert(1)'}]});await pause();f.el('people-list').querySelector('button').click();const input=f.el('editor-fields').querySelector('[name=first_name]');assert.equal(input.hasAttribute('onfocus'),false);assert.equal(input.value,'Synthetic" autofocus onfocus="alert(1)');
});

test('personal dashboard shows due leaders and clears names and badge on sign-out', async t => {
  const personal = { summary: { due:1, overdue:1, upcoming:2, items:[{display_name:'Synthetic Leader A', due_on:'2026-09-07'}] } };
  const f=fixture(t,{followups:personal}); await pause();
  assert.equal(f.el('followup-badge').textContent,'2'); assert.match(f.el('dashboard-followup-list').textContent,/Synthetic Leader A/);
  personal.options.onSummary({due:null,overdue:null,upcoming:null,items:[]});
  assert.match(f.el('dashboard-followup-status').textContent,/unavailable/); assert.equal(f.el('followup-badge').textContent,'');
  personal.options.onSummary(personal.summary); f.emit(null);
  assert.equal(f.el('dashboard-followup-list').textContent,''); assert.equal(f.el('dashboard-followup-status').textContent,''); assert.equal(f.el('followup-badge').textContent,''); assert.equal(f.el('followup-badge').hasAttribute('aria-label'),false);
  personal.options.onSummary(personal.summary); assert.equal(f.el('dashboard-followup-list').textContent,'');
});

function submit(f) { f.el('editor-form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true})); }
function field(f,name) { return f.el('editor-fields').querySelector('[name="'+name+'"]'); }
async function newPerson(f) { f.w.location.hash='#people'; await pause(); f.el('primary-action').click(); field(f,'first_name').value='Synthetic'; field(f,'last_name').value='New record'; }

test('missing readiness or module support blocks editing with persistent setup help', async t => {
  for (const readiness of [{error:{code:'PGRST202'}},{data:{schema_revision:'20260907174301',staff_role:'editor',supported_modules:['events']}}]) {
    const f=fixture(t,{readiness}); await pause();
    assert.equal(f.el('workspace').classList.contains('hidden'),false);
    assert.match(f.el('workspace-health-message').textContent,/setup.*incomplete/i);
    assert.equal(f.el('workspace-setup-help').hidden,false);
    assert.equal(f.el('workspace-setup-help').classList.contains('hidden'),false);
    assert.equal(f.el('primary-action').disabled,true); assert.equal(f.el('people-list').textContent,'');
    assert.equal(f.calls.some(q=>q.table==='contacts'),false);
  }
});
test('failed core refresh clears stale lists, preserves draft, and recovers without false empty success', async t => {
  let broken=false;const options={onQuery:q=>broken&&q.table==='documents'?{error:{message:'Synthetic offline'}}:undefined};
  const f=fixture(t,options);await pause();f.el('people-list').querySelector('button').click();field(f,'notes').value='Synthetic unsaved draft';
  broken=true;f.el('workspace-refresh').click();await pause();
  assert.equal(f.el('people-list').textContent,'');assert.equal(f.el('documents-list').textContent,'');assert.equal(f.el('people-count').textContent,'—');
  assert.equal(field(f,'notes').value,'Synthetic unsaved draft');assert.equal(field(f,'notes').disabled,true);assert.equal(f.el('save').disabled,true);
  assert.match(f.el('workspace-health-message').textContent,/could not be refreshed/);
  broken=false;f.el('workspace-refresh').click();await pause();
  assert.match(f.el('people-list').textContent,/Record a/);assert.equal(field(f,'notes').value,'Synthetic unsaved draft');assert.equal(field(f,'notes').disabled,false);assert.equal(f.el('save').disabled,false);
});
test('a live role removal before saving clears every private draft and prevents the mutation', async t => {
  const options={roles:{a:'editor'}}, f=fixture(t,options);await pause();f.el('people-list').querySelector('button').click();field(f,'notes').value='Synthetic private draft';
  options.roles.a=null;submit(f);await pause();
  assert.equal(f.el('editor').open,false);assert.equal(f.el('editor-fields').textContent,'');assert.equal(f.el('people-list').textContent,'');assert.equal(f.calls.some(q=>q.op==='update'),false);
  assert.match(f.el('login-error').textContent,/no longer/);
});
test('updated rows must return the exact identity and incremented version; stale drafts stay intact', async t => {
  let uncertain=true;const f=fixture(t,{onQuery:q=>q.op==='update'&&uncertain?{data:{id:'wrong-id',version:2}}:undefined});await pause();f.el('people-list').querySelector('button').click();field(f,'notes').value='Synthetic submitted note';submit(f);await pause();
  const save=f.calls.find(q=>q.op==='update');assert.equal(save.version,1);assert.equal(save.single,true);assert.equal(save.row.updated_by,undefined);
  assert.equal(f.el('editor').open,true);assert.equal(f.el('save').disabled,true);assert.match(f.el('editor-error').textContent,/could not be confirmed/);assert.equal(field(f,'notes').disabled,true);
  f.rows('a').contacts[0].version=2;f.el('editor-refresh').click();await pause();
  assert.equal(field(f,'notes').value,'Synthetic submitted note');assert.match(f.el('editor-error').textContent,/record changed/);assert.equal(f.el('save').disabled,true);uncertain=false;
});
test('an ordinary refresh never overwrites an unsaved draft after another editor changes its version', async t => {
  const f=fixture(t);await pause();f.el('people-list').querySelector('button').click();field(f,'notes').value='Synthetic local changes';
  f.rows('a').contacts[0].version=2;f.rows('a').contacts[0].notes='Synthetic remote changes';f.el('workspace-refresh').click();await pause();
  assert.equal(field(f,'notes').value,'Synthetic local changes');assert.equal(f.el('save').disabled,true);assert.match(f.el('editor-error').textContent,/cannot overwrite/);
});
test('a committed create with a lost response reconciles the same UUID without duplicate records', async t => {
  const f=fixture(t,{onQuery:(q,rows)=>{if(q.op==='insert'&&q.table==='contacts'){rows(q.owner).contacts.push({...q.row,version:1,updated_at:'2030-01-01'});return {error:{message:'Synthetic lost response'}};}}});await pause();await newPerson(f);submit(f);await pause();
  const created=f.calls.find(q=>q.op==='insert');assert.match(created.row.id,/^[0-9a-f-]{36}$/);assert.equal(created.row.updated_by,undefined);assert.equal(field(f,'first_name').disabled,true);assert.equal(f.el('editor-refresh').classList.contains('hidden'),false);
  submit(f);await pause();assert.equal(f.calls.filter(q=>q.op==='insert').length,1);
  f.el('editor-refresh').click();await pause();assert.equal(f.el('editor').open,false);assert.match(f.el('notice').textContent,/previous save was confirmed/);assert.equal(f.rows('a').contacts.filter(r=>r.id===created.row.id).length,1);
});
test('a missing uncertain create unlocks the same draft and UUID only after read reconciliation', async t => {
  let first=true;const f=fixture(t,{onQuery:q=>{if(q.op==='insert'&&first){first=false;return {data:null,error:null};}}});await pause();await newPerson(f);submit(f);await pause();
  const original=f.calls.find(q=>q.op==='insert').row.id;assert.equal(f.el('save').disabled,true);f.el('editor-refresh').click();await pause();assert.equal(f.el('save').disabled,false);assert.equal(field(f,'last_name').value,'New record');submit(f);await pause();
  const attempts=f.calls.filter(q=>q.op==='insert');assert.equal(attempts.length,2);assert.equal(attempts[1].row.id,original);assert.equal(f.el('editor').open,false);
});
test('pending saves freeze fields, repeated submit, close controls and Escape until the response settles', async t => {
  const d=deferred(), f=fixture(t,{onQuery:q=>q.op==='update'?d.promise:undefined});await pause();f.el('people-list').querySelector('button').click();field(f,'notes').value='Synthetic submitted';submit(f);await pause();
  assert.equal(field(f,'notes').disabled,true);assert.equal(f.el('save').disabled,true);f.w.document.querySelector('[data-close-editor]').click();f.el('editor').dispatchEvent(new f.w.Event('cancel',{cancelable:true}));submit(f);assert.equal(f.el('editor').open,true);assert.equal(f.calls.filter(q=>q.op==='update').length,1);
  const query=f.calls.find(q=>q.op==='update');d.resolve({data:{...query.row,id:query.id,version:2}});await pause();assert.equal(f.el('editor').open,false);
});
test('documents retain successful uploads after uncertain metadata and retry the same path and ID', async t => {
  let first=true;const f=fixture(t,{onQuery:q=>{if(q.table==='documents'&&q.op==='insert'&&first){first=false;return {error:{message:'Synthetic response failure'}};}}});await pause();f.w.location.hash='#documents';await pause();f.el('primary-action').click();
  const data=new Map([['title','Synthetic upload'],['category','policy'],['file',{name:'fixture.pdf',size:12,type:'application/pdf'}]]);f.w.FormData=class{get(k){return data.get(k);}};submit(f);await pause();
  const insert=f.calls.find(q=>q.op==='insert');assert.equal(f.calls.filter(q=>q.op==='upload').length,1);assert.equal(f.calls.some(q=>q.op==='remove'),false);assert.equal(insert.row.uploaded_by,undefined);assert.ok(insert.row.storage_path.includes(insert.row.id));
  f.el('editor-refresh').click();await pause();submit(f);await pause();const inserts=f.calls.filter(q=>q.op==='insert');assert.equal(inserts.length,2);assert.equal(inserts[1].row.id,insert.row.id);assert.equal(inserts[1].row.storage_path,insert.row.storage_path);assert.equal(f.calls.filter(q=>q.op==='upload').length,1);assert.equal(f.el('editor').open,false);
});
test('an uncertain upload is checked before retry; existing same-sized file is not re-uploaded or removed', async t => {
  const d=deferred(),options={uploadDeferred:d},f=fixture(t,options);await pause();f.w.location.hash='#documents';await pause();f.el('primary-action').click();const data=new Map([['title','Synthetic upload'],['category','policy'],['file',{name:'fixture.pdf',size:12,type:'application/pdf'}]]);f.w.FormData=class{get(k){return data.get(k);}};submit(f);await pause();
  const upload=f.calls.find(q=>q.op==='upload');d.resolve({error:{message:'Synthetic upload response lost'}});await pause();options.storageList={data:[{name:upload.path.split('/').pop(),metadata:{size:12}}]};f.el('editor-refresh').click();await pause();submit(f);await pause();assert.equal(f.calls.filter(q=>q.op==='upload').length,1);assert.equal(f.calls.some(q=>q.op==='list'),true);assert.equal(f.calls.some(q=>q.op==='remove'),false);assert.equal(f.el('editor').open,false);
});
test('document details update uses a version guard without replacing its file', async t => {
  const f=fixture(t);await pause();f.el('documents-list').querySelector('[data-edit-document]').click();field(f,'title').value='Synthetic revised title';submit(f);await pause();const query=f.calls.find(q=>q.op==='update');assert.equal(query.table,'documents');assert.equal(query.version,1);assert.equal(query.row.storage_path,undefined);assert.equal(f.calls.some(q=>q.op==='upload'||q.op==='remove'),false);
});
test('event archive requires confirmation and can be restored from the Archived filter; no DELETE occurs', async t => {
  const f=fixture(t);await pause();let confirmed=false;f.w.confirm=()=>confirmed;f.el('events-list').querySelector('[data-delete-event]').click();await pause();assert.equal(f.calls.some(q=>q.op==='update'),false);assert.equal(f.el('event-delete').classList.contains('hidden'),false);
  confirmed=true;f.el('event-delete').click();await pause();assert.equal(f.rows('a').events[0].is_archived,true);assert.equal(f.el('event-count').textContent,'0');assert.equal(f.el('events-list').textContent,'');
  f.el('event-status-filter').value='archived';f.el('event-status-filter').dispatchEvent(new f.w.Event('input'));assert.match(f.el('events-list').textContent,/Restore/);f.el('events-list').querySelector('[data-delete-event]').click();await pause();assert.equal(f.rows('a').events[0].is_archived,false);assert.equal(f.calls.some(q=>q.op==='delete'),false);assert.deepEqual(f.calls.filter(q=>q.op==='update').map(q=>q.version),[1,2]);
});

test('dirty Cancel and Escape require confirmation but actual sign-out still clears immediately', async t => {
  const f=fixture(t);await pause();f.el('people-list').querySelector('button').click();field(f,'notes').value='Synthetic unsaved';let asks=0;f.w.confirm=()=>{asks++;return false;};f.w.document.querySelector('[data-close-editor]').click();f.el('editor').dispatchEvent(new f.w.Event('cancel',{cancelable:true}));assert.equal(asks,2);assert.equal(f.el('editor').open,true);assert.equal(field(f,'notes').value,'Synthetic unsaved');f.emit(null);assert.equal(asks,2);assert.equal(f.el('editor').open,false);
});
test('an older readiness success cannot unlock the workspace after a newer failed check', async t => {
  const personal={summary:{due:0,overdue:0,items:[]}}, options={followups:personal}, f=fixture(t,options);await pause();const epoch=personal.options.getContext().epoch,resolvers=[];
  options.readiness=()=>new Promise(resolve=>resolvers.push(resolve));const older=personal.options.ensureReady(epoch);await pause();const newer=personal.options.ensureReady(epoch);await pause();
  resolvers[1]({error:{code:'PGRST202'}});assert.equal(await newer,false);resolvers[0]({data:{schema_revision:'20260907174301',staff_role:'editor',supported_modules:['events','contacts','documents','activity','membership','care','office_content','app_signups','leader_followups']}});assert.equal(await older,false);assert.equal(personal.options.getContext().canEdit,false);assert.match(f.el('workspace-health-message').textContent,/setup.*incomplete/i);
});

test('archiving cannot silently discard other unsaved event edits', async t => {
  const f=fixture(t);await pause();f.w.confirm=()=>true;f.el('events-list').querySelector('[data-edit-event]').click();field(f,'title').value='Synthetic unsaved event title';f.el('event-delete').click();await pause();assert.equal(f.calls.some(q=>q.op==='update'),false);assert.equal(field(f,'title').value,'Synthetic unsaved event title');assert.equal(f.el('editor').open,true);assert.match(f.el('editor-error').textContent,/Save your other event changes/);
});
test('a timed-out core save remains uncertain and ignores a later successful response', async t => {
  const d=deferred(),f=fixture(t,{onQuery:q=>q.op==='update'?d.promise:undefined});await pause();f.el('people-list').querySelector('button').click();field(f,'notes').value='Synthetic timed request';let expire;const real=f.w.setTimeout.bind(f.w);f.w.setTimeout=(fn,ms)=>ms===12000?(expire=fn,12345):real(fn,ms);submit(f);await pause();const q=f.calls.find(q=>q.op==='update');expire();await pause();assert.equal(f.el('save').disabled,true);assert.match(f.el('editor-error').textContent,/could not be confirmed/);d.resolve({data:{...q.row,id:q.id,version:2}});await pause();assert.equal(f.el('editor').open,true);assert.equal(field(f,'notes').value,'Synthetic timed request');assert.doesNotMatch(f.el('notice').textContent,/Saved and confirmed/);
});
