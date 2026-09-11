import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const html = await readFile(new URL('../index.html',import.meta.url),'utf8');
const app = await readFile(new URL('../app.js',import.meta.url),'utf8');
const membershipSource = await readFile(new URL('../membership.js',import.meta.url),'utf8');
const session = id => ({ user:{ id, email:'staff-'+id+'@example.invalid' }, access_token:'synthetic-token' });
const pause = () => new Promise(r=>setTimeout(r,15));
async function until(check, message) {
  const deadline=performance.now()+5000;
  while(!check()&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(check(),message);
}
const deferred = () => { let resolve; const promise=new Promise(r=>resolve=r);return {promise,resolve}; };
function unloadBlocked(f) { const event=new f.w.Event('beforeunload',{cancelable:true}); f.w.dispatchEvent(event); return event.defaultPrevented; }
function coreRequestClock(f) {
  const originalSet=f.w.setTimeout.bind(f.w), originalClear=f.w.clearTimeout.bind(f.w), timers=new Map();let next=-1;
  f.w.setTimeout=(fn,ms,...args)=>{if(ms!==12000)return originalSet(fn,ms,...args);const id=next--;timers.set(id,()=>fn(...args));return id;};
  f.w.clearTimeout=id=>{if(!timers.delete(id))originalClear(id);};
  return ()=>{assert.equal(timers.size,1,'exactly the held request reaches its deadline');const [id,run]=timers.entries().next().value;timers.delete(id);run();};
}
async function newDocumentUpload(f) {
  await until(()=>f.el('people-list').querySelector('button'),'workspace ready');f.w.location.hash='#documents';
  await until(()=>f.el('primary-action').textContent==='Upload document','document route ready');f.el('primary-action').click();
  const values=new Map([['title','Synthetic pending upload'],['category','policy'],['file',{name:'fixture.pdf',size:12,type:'application/pdf'}]]);
  f.w.FormData=class{get(key){return values.get(key);}};
}
function fixture(t,options={}) {
  const dom = new JSDOM(html,{url:options.url||'https://office.example.invalid/admin/',runScripts:'outside-only'}),w=dom.window;
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
    if(q.op==='select') { const selected=records.filter(row=>!q.id||row.id===q.id); const start=q.range?.[0]||0; const end=q.range?Math.min(q.range[1]+1,start+(options.pageCap||1000)):undefined; return Promise.resolve({data:selected.slice(start,end),count:q.count==='exact'?selected.length:null}); }
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
    const chain={select(fields,opts){q.count=opts?.count;return chain;},range(a,b){q.range=[a,b];return chain;},eq(k,v){q[k]=v;return chain;},order(){return chain;},limit(){return chain;},maybeSingle(){return chain;},single(){q.single=true;return chain;},insert(row){q.op='insert';q.row=row;return chain;},update(row){q.op='update';q.row=row;return chain;},delete(){q.op='delete';return chain;},then(a,b){return respond(q).then(a,b);}};return chain;
  },storage:{from(){return {
    async upload(path,file){calls.push({op:'upload',path,size:file.size});if(options.uploadDeferred)return options.uploadDeferred.promise;return {error:null};},
    async list(path,opts){calls.push({op:'list',path,options:opts});return options.storageList||{data:[]};},
    async remove(paths){calls.push({op:'remove',paths});return {error:null};},
    async createSignedUrl(){calls.push({op:'signedUrl'});if(options.signedDeferred)return options.signedDeferred.promise;return {data:{signedUrl:'https://files.example.invalid/synthetic?token=test'}};}
  };}}};
  function emit(next,event='TEST'){current=next;insideCallback=true;const returned=callback(event,next);insideCallback=false;assert.equal(returned,undefined);}
  if (options.membership) w.CreekMembership = { create(moduleOptions) { options.membership.options = moduleOptions; return { load: async () => {}, render() {}, clear() {} }; } };
  if (options.sheetControls) { w.eval(membershipSource); const sheetLink=w.CreekMembership.sheetLink; w.CreekMembership={sheetLink,create(){return {load:async()=>{},render(){},clear(){}}}}; }
  if (options.care) w.CreekCare = { create(moduleOptions) { options.care.options=moduleOptions; return { load: async () => { options.care.loaded=true; moduleOptions.onSummary(options.care.summary || null); }, attentionSnapshot(date) { options.care.date=date; return options.care.snapshot||null; }, openFromAttention(item,date) { options.care.opened={item,date};return options.care.accepted!==false; }, render() {}, clear() { moduleOptions.onSummary(null); }, selectPerson(id) { (options.care.selected ||= []).push(id); return options.care.accepted !== false; }, openQueue(kind) { (options.care.queues ||= []).push(kind); return options.care.queueAccepted !== false; } }; } };
  if (options.followups) w.CreekFollowups = { create(moduleOptions) { options.followups.options = moduleOptions; return { load: async () => {options.followups.loaded=true; moduleOptions.onSummary(options.followups.summary);}, attentionSnapshot(date) {options.followups.date=date; return options.followups.snapshot||null;}, openFromAttention(id) {options.followups.opened=id; return options.followups.accepted!==false;}, render() {}, clear() { moduleOptions.onSummary({ due:null, overdue:null, upcoming:null, items:[] }); }, openNew() {} }; } };
  if (options.intake) w.CreekIntakeTasks={create(moduleOptions){options.intake.options=moduleOptions;return{load:async()=>moduleOptions.onSummary(options.intake.summary||null),render(){},clear(){moduleOptions.onSummary(null);},showFilter(value){(options.intake.filters??=[]).push(value);},taskForSource(){return null;},openTask(id){options.intake.opened=id;return options.intake.accepted!==false;}};}};
  if(options.communications)w.CreekCommunications={create(moduleOptions){options.communications.options=moduleOptions;return {load:async e=>{(options.communications.loads??=[]).push(e);moduleOptions.root.textContent='Fictional private choices';},render(){},clear(){moduleOptions.root.replaceChildren();}};}};
  if(options.signups)w.CreekSignups={create(moduleOptions){options.signups.options=moduleOptions;return {load:async()=>{},render(){},clear(){},open(id){options.signups.opened=id;return options.signups.accepted!==false;}};}};
  if(options.attention)w.CreekAttention={create(moduleOptions){options.attention.options=moduleOptions;return {beginRefresh(){options.attention.begins=(options.attention.begins||0)+1;moduleOptions.onSummary(null);},load:async e=>{(options.attention.loads||=[]).push(e);options.attention.loadedAfterSources=!!options.care?.loaded&&!!options.followups?.loaded;moduleOptions.root.textContent='Fictional attention record';moduleOptions.onSummary(options.attention.summary||null);},render(){},clear(){moduleOptions.root.replaceChildren();moduleOptions.onSummary(null);}};}};
  let created=0; w.CREEK_OFFICE_CONFIG=options.config||{supabaseUrl:'https://testproject.supabase.co',publishableKey:'sb_publishable_synthetic'};
  w.supabase={createClient(){created++;return client;}};w.eval(app);
  const el=id=>w.document.getElementById(id);
  return {w,el,calls,delayed,pending,emit,created:()=>created,rows};
}
test('logout immediately clears open record, hidden lists, filters and pending data',async t=>{
  const d=deferred(),f=fixture(t,{signOutDeferred:d});
  // Initial auth intentionally defers loading; wait for the record, not elapsed time.
  const readinessDeadline=performance.now()+2000;
  while(!f.el('people-list').querySelector('button')&&performance.now()<readinessDeadline) {
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.ok(f.el('people-list').querySelector('button'),'Initial contact must render before testing immediate logout cleanup');
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
  f.emit(null);for(const p of f.pending)p.resolve({data:f.rows('a')[p.q.table],count:f.rows('a')[p.q.table].length});await pause();
  assert.equal(f.el('people-list').textContent,'');assert.equal(f.el('documents-list').textContent,'');assert.equal(f.el('workspace').classList.contains('hidden'),true);
});
test('same-account token events preserve unsaved edits; viewer cannot open editor',async t=>{
  const f=fixture(t);await until(()=>f.el('people-list').querySelector('button'),'editable records loaded');f.el('people-list').querySelector('button').click();f.el('editor-fields').querySelector('[name=notes]').value='Synthetic unsaved edit';f.emit(session('a'));await pause();assert.equal(f.el('editor').open,true);assert.equal(f.el('editor-fields').querySelector('[name=notes]').value,'Synthetic unsaved edit');
  const v=fixture(t,{roles:{a:'viewer'}});await pause();v.w.location.hash='#people';await pause();assert.equal(v.el('primary-action').classList.contains('hidden'),true);v.el('primary-action').click();assert.equal(v.el('editor').open,false);assert.equal(v.el('people-list').querySelector('button'),null);
  for(const view of ['history','care','signups','intake','communications','attention','followups','announcements','committees','slides','prayers']) {
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
  for(const key of ['sb_secret_synthetic','x.'+Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url')+'.x']) {const f=fixture(t,{config:{supabaseUrl:'https://testproject.supabase.co',publishableKey:key}});await pause();assert.equal(f.created(),0);assert.equal(f.el('setup').classList.contains('hidden'),false);}
});
test('local office rehearsal fails closed unless both the page and backend are loopback',async t=>{
  const config={supabaseUrl:'http://127.0.0.1:55321',publishableKey:'sb_publishable_synthetic',localDevelopment:true};
  const f=fixture(t,{config,url:'http://127.0.0.1:8810/admin/'});await pause();assert.equal(f.created(),1);
  for(const options of [
    {config},
    {config:{...config,localDevelopment:false},url:'http://127.0.0.1:8810/admin/'},
    {config:{...config,supabaseUrl:'http://192.168.1.2:55321'},url:'http://127.0.0.1:8810/admin/'},
    {config:{...config,supabaseUrl:'https://testproject.supabase.co'},url:'http://127.0.0.1:8810/admin/'},
    {config:{...config,supabaseUrl:'http://127.0.0.1:55321/rest/v1'},url:'http://127.0.0.1:8810/admin/'},
    {config:{...config,publishableKey:'sb_secret_synthetic'},url:'http://127.0.0.1:8810/admin/'}
  ]) { const g=fixture(t,options);await pause();assert.equal(g.created(),0); }
});
test('local document handoff permits HTTP only at its configured loopback backend',async t=>{
  const config={supabaseUrl:'http://127.0.0.1:55321',publishableKey:'sb_publishable_synthetic',localDevelopment:true};
  for(const [signedUrl,allowed] of [['http://127.0.0.1:55321/storage/v1/object/sign/test',true],['http://127.0.0.1:55322/test',false],['http://files.example.invalid/test',false],['http://user@127.0.0.1:55321/test',false]]) {
    const d=deferred(),f=fixture(t,{config,url:'http://127.0.0.1:8810/admin/',signedDeferred:d});
    const until=performance.now()+2000;while(!f.el('documents-list').querySelector('button')&&performance.now()<until)await pause();
    assert.ok(f.el('documents-list').querySelector('button'));f.el('documents-list').querySelector('button').click();d.resolve({data:{signedUrl}});await pause();
    assert.equal(!!f.el('document-result').querySelector('a'),allowed);
  }
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
  const f=fixture(t,{initial:null});await pause();f.delayed.push(q=>q.table==='contacts');f.emit(session('a'));await pause();f.pending[0].resolve({data:[{...f.rows('a').contacts[0],first_name:'Synthetic" autofocus onfocus="alert(1)'}],count:1});await pause();f.el('people-list').querySelector('button').click();const input=f.el('editor-fields').querySelector('[name=first_name]');assert.equal(input.hasAttribute('onfocus'),false);assert.equal(input.value,'Synthetic" autofocus onfocus="alert(1)');
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
  const personal={summary:{due:0,overdue:0,items:[]}}, options={followups:personal}, f=fixture(t,options);await until(()=>personal.options.getContext().canEdit,'initial staff readiness');const epoch=personal.options.getContext().epoch,resolvers=[];
  options.readiness=()=>new Promise(resolve=>resolvers.push(resolve));const older=personal.options.ensureReady(epoch);await until(()=>resolvers.length===1,'older readiness request');const newer=personal.options.ensureReady(epoch);await until(()=>resolvers.length===2,'newer readiness request');
  resolvers[1]({error:{code:'PGRST202'}});assert.equal(await newer,false);resolvers[0]({data:{schema_revision:'20260907174301',staff_role:'editor',supported_modules:['events','contacts','documents','activity','membership','care','office_content','app_signups','leader_followups']}});assert.equal(await older,false);assert.equal(personal.options.getContext().canEdit,false);assert.match(f.el('workspace-health-message').textContent,/setup.*incomplete/i);
});

test('archiving cannot silently discard other unsaved event edits', async t => {
  const f=fixture(t);await until(()=>f.el('events-list').querySelector('[data-edit-event]'),'initial event rendered');f.w.confirm=()=>true;f.el('events-list').querySelector('[data-edit-event]').click();field(f,'title').value='Synthetic unsaved event title';f.el('event-delete').click();await pause();assert.equal(f.calls.some(q=>q.op==='update'),false);assert.equal(field(f,'title').value,'Synthetic unsaved event title');assert.equal(f.el('editor').open,true);assert.match(f.el('editor-error').textContent,/Save your other event changes/);
});
test('a timed-out core save remains uncertain and ignores a later successful response', async t => {
  const d=deferred(),f=fixture(t,{onQuery:q=>q.op==='update'?d.promise:undefined});await until(()=>f.el('people-list').querySelector('button'),'initial person rendered');f.el('people-list').querySelector('button').click();field(f,'notes').value='Synthetic timed request';let expire;const real=f.w.setTimeout.bind(f.w);f.w.setTimeout=(fn,ms)=>ms===12000?(expire=fn,12345):real(fn,ms);submit(f);await until(()=>f.calls.some(q=>q.op==='update')&&expire,'save awaiting acknowledgement');const q=f.calls.find(q=>q.op==='update');expire();await pause();assert.equal(f.el('save').disabled,true);assert.match(f.el('editor-error').textContent,/could not be confirmed/);d.resolve({data:{...q.row,id:q.id,version:2}});await pause();assert.equal(f.el('editor').open,true);assert.equal(field(f,'notes').value,'Synthetic timed request');assert.doesNotMatch(f.el('notice').textContent,/Saved and confirmed/);
});


test('membership receives the same document URL policy as the authenticated office',async t=>{
  const membership={},config={supabaseUrl:'http://127.0.0.1:55321',publishableKey:'sb_publishable_synthetic',localDevelopment:true};
  fixture(t,{membership,config,url:'http://127.0.0.1:8810/admin/'});await pause();
  assert.equal(membership.options.documentUrl('http://127.0.0.1:55321/storage/v1/object/sign/sample').origin,'http://127.0.0.1:55321');
  for(const value of ['http://127.0.0.1:55322/sample','http://files.example.invalid/sample','http://user@127.0.0.1:55321/sample','javascript:alert(1)','data:text/html,test','https://user:secret@files.example.invalid/sample'])assert.throws(()=>membership.options.documentUrl(value));
  const hosted={};fixture(t,{membership:hosted});await pause();
  assert.equal(hosted.options.documentUrl('https://files.example.invalid/sample').protocol,'https:');
  assert.throws(()=>hosted.options.documentUrl('http://127.0.0.1:55321/sample'));
});

test('People hands Care the exact current ID and navigates only when accepted',async t=>{
  const care={selected:[],accepted:false},f=fixture(t,{care});await pause();
  f.w.location.hash='#people';await pause();
  const button=f.el('people-list').querySelector('[data-person-care]');assert.ok(button);
  button.click();assert.deepEqual(care.selected,['person-a']);assert.equal(f.w.location.hash,'#people');
  care.accepted=true;button.click();assert.equal(f.w.location.hash,'#care');
  const count=care.selected.length;button.dataset.personCare='missing-person';button.click();assert.equal(care.selected.length,count);
  f.emit(null);button.dataset.personCare='person-a';button.click();assert.equal(care.selected.length,count);
  const viewer=fixture(t,{care:{selected:[]},roles:{a:'viewer'}});await pause();assert.equal(viewer.el('people-list').querySelector('[data-person-care]'),null);
});

function change(f,name,value) { const input=field(f,name); input.value=value;input.dispatchEvent(new f.w.Event('input',{bubbles:true})); }
function acceptPersonMatch(f) { const input=field(f,'person_match_reviewed');assert.ok(input);input.checked=true;input.dispatchEvent(new f.w.Event('change',{bubbles:true})); }

test('format-only first names remain editable and never create an active person',async t=>{
  const f=fixture(t);await until(()=>f.el('people-list').querySelector('button'),'people ready');await newPerson(f);change(f,'last_name','');
  for(const value of ['\u200b','\u200c\u200d',' \u2060\u202e\ufeff ']){
    change(f,'first_name',value);assert.equal(f.el('editor-form').checkValidity(),true);
    submit(f);await pause();assert.equal(f.calls.some(q=>q.table==='contacts'&&q.op==='insert'),false);
    assert.equal(f.el('editor').open,true);assert.equal(field(f,'first_name').disabled,false);assert.equal(field(f,'first_name').value,value);
    assert.match(f.el('editor-error').textContent,/Enter a first name/);
  }
});

test('invisible format characters cannot bypass same-name review or rewrite the saved name',async t=>{
  const f=fixture(t);await until(()=>f.el('people-list').querySelector('button'),'people ready');await newPerson(f);
  const first='Synthetic\u200b';change(f,'first_name',first);change(f,'last_name','Record a');
  assert.equal(f.el('person-review').hidden,false);submit(f);await pause();
  assert.equal(f.calls.some(q=>q.table==='contacts'&&q.op==='insert'),false);assert.match(f.el('editor-error').textContent,/Review the similar records/);
  acceptPersonMatch(f);submit(f);await until(()=>!f.el('editor').open,'acknowledged save');
  const insert=f.calls.find(q=>q.table==='contacts'&&q.op==='insert');assert.equal(insert.row.first_name,first);
  assert.equal(f.rows('a').contacts.length,2,'review never merges the two people');
});

test('format-tolerant identifier review preserves Unicode joiners and exact record text',async t=>{
  const f=fixture(t);await until(()=>f.el('people-list').querySelector('button'),'people ready');
  f.rows('a').contacts[0].membership_number='0012';f.rows('a').contacts[0].legacy_member_id='L-01';await newPerson(f);
  const expected={first_name:'क्\u200dष',last_name:'Fictional record',membership_number:'00\u200b12',legacy_member_id:'L\u200c-01',birth_date_text:'Summer\u2060 1956; unclear',notes:'Original क्\u200dष wording'};
  for(const [name,value] of Object.entries(expected))change(f,name,value);
  assert.equal(f.el('person-review').hidden,false);submit(f);await pause();assert.equal(f.calls.some(q=>q.table==='contacts'&&q.op==='insert'),false);
  acceptPersonMatch(f);submit(f);await until(()=>!f.el('editor').open,'Unicode record saved');
  const insert=f.calls.find(q=>q.table==='contacts'&&q.op==='insert');for(const [name,value] of Object.entries(expected))assert.equal(insert.row[name],value,name);
});

test('format-only event and document titles are rejected before a write',async t=>{
  for(const kind of ['event','document'])await t.test(kind,async t=>{
    const f=fixture(t);await until(()=>f.el('people-list').querySelector('button'),'workspace ready');
    f.el(kind==='event'?'events-list':'documents-list').querySelector(kind==='event'?'[data-edit-event]':'[data-edit-document]').click();
    change(f,'title','\u200b\u200d');assert.equal(f.el('editor-form').checkValidity(),true);submit(f);await pause();
    assert.equal(f.calls.some(q=>q.op==='update'||q.op==='insert'||q.op==='upload'),false);assert.equal(f.el('editor').open,true);assert.match(f.el('editor-error').textContent,/Enter a title/);
    const title='Fictional क्\u200dष title';change(f,'title',title);submit(f);await until(()=>!f.el('editor').open,'valid title saved');
    assert.equal(f.calls.find(q=>q.op==='update').row.title,title);
  });
});

test('a same-name new record requires review and explicit different-person acknowledgement',async t=>{
  const f=fixture(t);await pause();await newPerson(f);
  change(f,'first_name','  SYNTHETIC ');change(f,'last_name','Record   a');
  assert.equal(f.el('person-review').hidden,false);assert.match(f.el('person-review').textContent,/Synthetic Record a/);
  submit(f);await pause();assert.equal(f.calls.some(q=>q.op==='insert'&&q.table==='contacts'),false);
  assert.match(f.el('editor-error').textContent,/Review the similar records/);
  acceptPersonMatch(f);submit(f);await pause();
  assert.equal(f.calls.filter(q=>q.op==='insert'&&q.table==='contacts').length,1);
  assert.equal(f.el('editor').open,false);assert.equal(f.rows('a').contacts.length,2);
});

test('identifier review preserves leading zeros and does not guess a missing surname',async t=>{
  const f=fixture(t);await pause();f.rows('a').contacts[0].membership_number='0012';f.rows('a').contacts[0].legacy_member_id='LEDGER-A';
  await newPerson(f);change(f,'first_name','Synthetic');change(f,'last_name','');
  assert.equal(f.el('person-review').hidden,true);
  change(f,'membership_number','12');assert.equal(f.el('person-review').hidden,true);
  change(f,'membership_number',' 0012 ');assert.equal(f.el('person-review').hidden,false);
  submit(f);await pause();assert.equal(f.calls.some(q=>q.op==='insert'),false);
  change(f,'membership_number','');change(f,'legacy_member_id','ledger-a');assert.equal(f.el('person-review').hidden,false);
  submit(f);await pause();assert.equal(f.calls.some(q=>q.op==='insert'),false);
});

test('similar-record acceptance resets after identity edits or a newly loaded match',async t=>{
  const f=fixture(t);await pause();await newPerson(f);change(f,'last_name','Record a');acceptPersonMatch(f);
  change(f,'membership_number','NEW-NUMBER');assert.equal(field(f,'person_match_reviewed').checked,false);
  submit(f);await pause();assert.equal(f.calls.some(q=>q.op==='insert'),false);
  acceptPersonMatch(f);
  f.rows('a').contacts.push({...f.rows('a').contacts[0],id:'person-a-second',membership_number:'NEW-NUMBER'});
  f.el('workspace-refresh').click();await pause();await pause();
  assert.equal(field(f,'person_match_reviewed').checked,false);assert.match(f.el('person-review').textContent,/2 existing records/);
  submit(f);await pause();assert.equal(f.calls.some(q=>q.op==='insert'),false);
});

test('reviewing an existing person honors draft cancellation and sign-out clears the review',async t=>{
  const f=fixture(t);await pause();await newPerson(f);change(f,'last_name','Record a');
  const review=f.el('person-review').querySelector('[data-review-person]');f.w.confirm=()=>false;review.click();
  assert.equal(f.el('editor-title').textContent,'Add person');assert.equal(f.el('editor-form').dataset.id,'');
  f.w.confirm=()=>true;review.click();assert.equal(f.el('editor-title').textContent,'Edit person');assert.equal(f.el('editor-form').dataset.id,'person-a');
  assert.equal(f.el('person-review'),null);
  f.w.confirm=()=>true;await newPerson(f);change(f,'last_name','Record a');const held=f.el('person-review').querySelector('button');
  f.emit(null);held.click();assert.equal(f.el('editor').open,false);assert.equal(f.el('editor-fields').textContent,'');
});

test('similar-record markup is escaped and ordinary edits do not trigger new-person review',async t=>{
  const f=fixture(t);await pause();f.rows('a').contacts[0].membership_number='M-1';f.rows('a').contacts[0].household_name='<img src=x onerror=alert(1)>';
  await newPerson(f);change(f,'membership_number','M-1');
  assert.equal(f.el('person-review').querySelector('img'),null);assert.match(f.el('person-review').textContent,/<img/);
  f.w.confirm=()=>true;f.el('person-review').querySelector('button').click();change(f,'notes','A routine note change.');submit(f);await pause();
  assert.equal(f.calls.filter(q=>q.op==='update'&&q.table==='contacts').length,1);
});

test('detached review controls cannot acknowledge or replace a later person draft',async t=>{
  const f=fixture(t);await pause();await newPerson(f);change(f,'last_name','Record a');
  const checkbox=field(f,'person_match_reviewed'),button=f.el('person-review').querySelector('button');
  change(f,'membership_number','DIFFERENT-ID');
  checkbox.checked=true;checkbox.dispatchEvent(new f.w.Event('change'));f.w.confirm=()=>true;button.click();
  assert.equal(f.el('editor-title').textContent,'Add person');submit(f);await pause();assert.equal(f.calls.some(q=>q.op==='insert'),false);
  const oldCheckbox=field(f,'person_match_reviewed'),oldButton=f.el('person-review').querySelector('button');
  f.emit(null);f.emit(session('a'));await pause();await newPerson(f);change(f,'last_name','Record a');
  oldCheckbox.checked=true;oldCheckbox.dispatchEvent(new f.w.Event('change'));oldButton.click();
  assert.equal(f.el('editor-title').textContent,'Add person');submit(f);await pause();assert.equal(f.calls.some(q=>q.op==='insert'),false);
});

test('refresh landing during save must force review of the newly known match',async t=>{
  const f=fixture(t);await pause();await newPerson(f);
  f.delayed.push(q=>q.table==='contacts'&&q.op==='select');
  f.el('workspace-refresh').click();await pause();
  const pendingContacts=f.pending.find(p=>p.q.table==='contacts');assert.ok(pendingContacts);
  f.delayed.push(q=>q.table==='staff_roles');
  submit(f);await pause();
  const pendingStaff=f.pending.find(p=>p.q.table==='staff_roles');assert.ok(pendingStaff);
  const existing={...f.rows('a').contacts[0],id:'parallel-person',first_name:'Synthetic',last_name:'New record'};
  f.rows('a').contacts.push(existing);
  pendingContacts.resolve({data:f.rows('a').contacts,count:f.rows('a').contacts.length});await pause();
  assert.equal(f.el('person-review').hidden,false);assert.equal(field(f,'person_match_reviewed').checked,false);
  f.delayed.length=0;pendingStaff.resolve({data:{role:'editor'}});await pause();
  assert.equal(f.calls.filter(q=>q.op==='insert'&&q.table==='contacts').length,0,'the new match must be reviewed before insertion');
  assert.equal(f.el('save').disabled,false);assert.equal(f.el('editor').open,true);assert.match(f.el('editor-error').textContent,/Review the similar records/);
  acceptPersonMatch(f);submit(f);await pause();assert.equal(f.calls.filter(q=>q.op==='insert'&&q.table==='contacts').length,1);
});


test('match review refreshes the household and status it displays',async t=>{
  const f=fixture(t);await pause();f.rows('a').contacts[0].household_name='Old fixture household';
  await newPerson(f);change(f,'last_name','Record a');acceptPersonMatch(f);
  assert.match(f.el('person-review').textContent,/Old fixture household/);
  f.rows('a').contacts[0].household_name='Corrected fixture household';f.rows('a').contacts[0].status='inactive';
  f.el('workspace-refresh').click();await pause();
  assert.match(f.el('person-review').textContent,/Corrected fixture household/);
  assert.equal(field(f,'person_match_reviewed').checked,false);
});


test('membership spreadsheet shortcut is staff-only and removed immediately on sign-out',async t=>{
  const config={supabaseUrl:'https://testproject.supabase.co',publishableKey:'sb_publishable_synthetic',membershipSheetUrl:'https://docs.google.com/spreadsheets/d/Synthetic_123/edit?usp=sharing'};
  for(const role of ['admin','editor','viewer']){
    const f=fixture(t,{sheetControls:true,config,roles:{a:role}});await until(()=>f.el('role-label').textContent===role,'staff role loaded');await pause();
    const link=f.el('people-sheet-link'),box=f.el('people-sheet-tools');
    assert.equal(box.hidden,role==='viewer');assert.equal(link.getAttribute('href'),role==='viewer'?null:'https://docs.google.com/spreadsheets/d/Synthetic_123/edit');
    assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');
    f.emit(null);assert.equal(box.hidden,true);assert.equal(link.getAttribute('href'),null);
    const click=new f.w.MouseEvent('click',{cancelable:true});link.dispatchEvent(click);assert.equal(click.defaultPrevented,true);
  }
});

test('membership spreadsheet shortcut rejects unsafe configuration and clears on workspace failure',async t=>{
  for(const value of ['', 'javascript:alert(1)', 'https://docs.google.com.evil.invalid/spreadsheets/d/test/edit']){
    const f=fixture(t,{sheetControls:true,config:{supabaseUrl:'https://testproject.supabase.co',publishableKey:'sb_publishable_synthetic',membershipSheetUrl:value}});await until(()=>f.el('people-list').querySelector('button'),'people loaded');
    assert.equal(f.el('people-sheet-tools').hidden,true);assert.equal(f.el('people-sheet-link').getAttribute('href'),null);
  }
  let blocked=false;const f=fixture(t,{sheetControls:true,config:{supabaseUrl:'https://testproject.supabase.co',publishableKey:'sb_publishable_synthetic',membershipSheetUrl:'https://docs.google.com/spreadsheets/d/Synthetic_123/edit'},onQuery:q=>blocked&&q.table==='contacts'?{error:{code:'NETWORK'}}:undefined});
  await until(()=>!f.el('people-sheet-tools').hidden,'sheet shortcut ready');blocked=true;f.el('workspace-refresh').click();await until(()=>f.el('workspace').dataset.connection==='blocked','workspace blocked');
  assert.equal(f.el('people-sheet-tools').hidden,true);assert.equal(f.el('people-sheet-link').getAttribute('href'),null);
});


test('Overview care totals open the requested queue only after safe navigation is accepted',async t=>{
  const care={summary:{duePlans:4,overduePlans:2,unassignedPlans:1,coverageGaps:3},queueAccepted:false},f=fixture(t,{care});
  await until(()=>f.el('care-due-count').textContent==='4','care summary ready');
  assert.equal(f.el('care-unassigned-count').textContent,'1');assert.equal(f.el('care-gaps-count').textContent,'3');assert.match(f.el('dashboard-care-status').textContent,/2 overdue/);
  const button=f.w.document.querySelector('[data-care-queue=due]');button.click();assert.deepEqual(care.queues,['due']);assert.notEqual(f.w.location.hash,'#care');
  care.queueAccepted=true;button.click();assert.equal(f.w.location.hash,'#care');
  f.w.document.querySelector('[data-care-queue=coverage]').click();assert.equal(care.queues.at(-1),'coverage');
  button.dataset.careQueue='invalid';const count=care.queues.length;button.click();assert.equal(care.queues.length,count);
  f.emit(null);care.options.onSummary(care.summary);assert.equal(f.el('care-due-count').textContent,'—');assert.equal(f.el('dashboard-care-status').textContent,'');assert.equal(button.disabled,true);
});

test('unavailable or invalid care counts never become a false all-clear and viewers cannot open care queues',async t=>{
  const care={},f=fixture(t,{care});await until(()=>f.el('people-list').querySelector('button'),'office ready');
  assert.equal(f.el('care-due-count').textContent,'—');assert.match(f.el('dashboard-care-status').textContent,/unavailable/);
  for(const summary of [{duePlans:-1,overduePlans:0,unassignedPlans:0,coverageGaps:0},{duePlans:0,overduePlans:1,unassignedPlans:0,coverageGaps:0},{duePlans:0,overduePlans:0,unassignedPlans:NaN,coverageGaps:0}]){care.options.onSummary(summary);assert.equal(f.el('care-due-count').textContent,'—');}
  care.options.onSummary({duePlans:0,overduePlans:0,unassignedPlans:0,coverageGaps:0});assert.equal(f.el('care-due-count').textContent,'0');
  const viewerCare={summary:{duePlans:9,overduePlans:9,unassignedPlans:9,coverageGaps:9}},v=fixture(t,{roles:{a:'viewer'},care:viewerCare});await until(()=>v.el('role-label').textContent==='viewer','viewer ready');viewerCare.options.onSummary(viewerCare.summary);
  assert.equal(v.el('care-due-count').textContent,'—');const button=v.w.document.querySelector('[data-care-queue=due]');assert.equal(button.disabled,true);button.click();assert.equal(viewerCare.queues,undefined);
});


test('a core workspace failure removes care dashboard counts before a stale summary can repaint them',async t=>{
  let blocked=false;const care={summary:{duePlans:2,overduePlans:1,unassignedPlans:1,coverageGaps:4}},f=fixture(t,{care,onQuery:q=>blocked&&q.table==='contacts'?{error:{code:'NETWORK'}}:undefined});
  await until(()=>f.el('care-due-count').textContent==='2','care summary loaded');blocked=true;f.el('workspace-refresh').click();await until(()=>f.el('workspace').dataset.connection==='blocked','workspace blocked');
  care.options.onSummary(care.summary);for(const id of ['care-due-count','care-unassigned-count','care-gaps-count'])assert.equal(f.el(id).textContent,'—');
  for(const button of f.w.document.querySelectorAll('[data-care-queue]'))assert.equal(button.disabled,true);
});


test('hosted office rejects incompatible origins, endpoint paths and unsafe key shapes before client creation', async t => {
  const config={supabaseUrl:'https://testproject.supabase.co',publishableKey:'sb_publishable_synthetic'};
  const invalid=[
    {supabaseUrl:'https://unrelated.example.invalid'},
    {supabaseUrl:'https://testproject.supabase.co.evil.invalid'},
    {supabaseUrl:'https://testproject.supabase.co/rest/v1'},
    {supabaseUrl:'https://testproject.supabase.co?token=synthetic'},
    {supabaseUrl:'https://testproject.supabase.co#synthetic'},
    {supabaseUrl:'https://testproject.supabase.co:8443'},
    {supabaseUrl:'https://user@testproject.supabase.co'},
    {publishableKey:'sb_publishable_bad token'},
    {publishableKey:'sb_publishable_bad\n'},
    {publishableKey:'sb_publishable_'},
    {publishableKey:'x.'+Buffer.from(JSON.stringify({role:'anon'})).toString('base64url')+'.x'}
  ];
  for(const patch of invalid){const f=fixture(t,{config:{...config,...patch}});await pause();assert.equal(f.created(),0);assert.equal(f.el('setup').classList.contains('hidden'),false);}
  for(const url of ['http://office.example.invalid/admin/','https://user@office.example.invalid/admin/','https://office.example.invalid/elsewhere/']){
    const f=fixture(t,{config,url});await pause();assert.equal(f.created(),0);
  }
});

test('explicit local office accepts its legacy anon fixture but rejects a privileged token', async t => {
  const config={supabaseUrl:'http://127.0.0.1:55321',publishableKey:'x.'+Buffer.from(JSON.stringify({role:'anon'})).toString('base64url')+'.x',localDevelopment:true};
  const f=fixture(t,{config,url:'http://127.0.0.1:8812/admin/'});await until(()=>f.el('people-list').querySelector('button'),'local legacy fixture loaded');assert.equal(f.created(),1);
  const bad=fixture(t,{config:{...config,publishableKey:'x.'+Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url')+'.x'},url:'http://127.0.0.1:8812/admin/'});await pause();assert.equal(bad.created(),0);
});

test('unsaved core edits warn before reload, while unchanged, discarded and confirmed records do not',async t=>{
  const f=fixture(t);await until(()=>f.el('people-list').querySelector('button'),'initial people rendered');
  assert.equal(unloadBlocked(f),false);
  for(const [selector,name] of [['[data-edit-person]','notes'],['[data-edit-event]','title'],['[data-edit-document]','description']]) {
    f.w.document.querySelector(selector).click();assert.equal(unloadBlocked(f),false,'opening a record is not an edit');
    const input=field(f,name),original=input.value;input.value=original+' Synthetic change';input.dispatchEvent(new f.w.Event('input',{bubbles:true}));
    assert.equal(unloadBlocked(f),true);assert.equal(f.el('editor').open,true);
    input.value=original;input.dispatchEvent(new f.w.Event('input',{bubbles:true}));assert.equal(unloadBlocked(f),false,'reverting removes the warning');
    input.value=original+' Synthetic save';input.dispatchEvent(new f.w.Event('change',{bubbles:true}));assert.equal(unloadBlocked(f),true);
    submit(f);await until(()=>!f.el('editor').open,'confirmed save closes draft');assert.equal(unloadBlocked(f),false);
    await until(()=>!f.el('workspace-refresh').disabled,'save refresh completed');
  }
  f.w.document.querySelector('[data-edit-person]').click();field(f,'notes').value='Synthetic discard';field(f,'notes').dispatchEvent(new f.w.Event('input',{bubbles:true}));
  f.w.confirm=()=>true;f.w.document.querySelector('[data-close-editor]').click();assert.equal(unloadBlocked(f),false);
  assert.equal(f.w.localStorage.length,0);assert.equal(f.w.sessionStorage.length,0,'drafts are not persisted');
});

test('selecting only an upload file warns before reload and account clearing removes the warning',async t=>{
  const f=fixture(t);await until(()=>f.el('people-list').querySelector('button'),'initial workspace rendered');
  f.w.location.hash='#documents';await until(()=>f.el('primary-action').textContent==='Upload document','document route ready');f.el('primary-action').click();
  assert.equal(unloadBlocked(f),false);const input=field(f,'file'),file=new f.w.File(['Synthetic original'],'page.pdf',{type:'application/pdf',lastModified:1});
  Object.defineProperty(input,'files',{configurable:true,value:[file]});input.dispatchEvent(new f.w.Event('change',{bubbles:true}));
  assert.equal(unloadBlocked(f),true,'the file matters even before title entry');assert.equal(f.calls.some(q=>q.op==='upload'),false);
  f.emit(null);assert.equal(unloadBlocked(f),false);assert.equal(f.el('editor').open,false);assert.equal(f.el('editor-fields').textContent,'');
});

test('pending and uncertain core saves keep the unload warning until confirmation or immediate sign-out clearing',async t=>{
  const response=deferred(),f=fixture(t,{onQuery:q=>q.op==='update'?response.promise:undefined});
  await until(()=>f.el('people-list').querySelector('button'),'initial workspace rendered');f.w.document.querySelector('[data-edit-person]').click();
  // Even a no-change save is an operation that must finish before leaving.
  submit(f);assert.equal(unloadBlocked(f),true);await until(()=>f.calls.some(q=>q.op==='update'),'mutation started');
  response.resolve({error:{message:'Synthetic lost response'}});await until(()=>f.el('editor-error').textContent.includes('could not be confirmed'),'uncertain state shown');
  assert.equal(unloadBlocked(f),true);assert.equal(field(f,'notes').disabled,true);
  f.emit(null);assert.equal(unloadBlocked(f),false);assert.equal(f.el('editor').open,false);
});

test('timed-out document upload retains its draft through early absence and settles without automatic metadata writes',async t=>{
  const upload=deferred(),options={uploadDeferred:upload},f=fixture(t,options);await newDocumentUpload(f);const expire=coreRequestClock(f);
  submit(f);await until(()=>f.calls.some(q=>q.op==='upload'),'upload started');expire();await until(()=>f.el('editor-error').textContent.includes('could not be confirmed'),'deadline reported');
  const originalPath=f.calls.find(q=>q.op==='upload').path;
  f.el('editor-refresh').click();await until(()=>f.el('save').disabled===false,'same-ID retry is offered after absent read');
  assert.equal(field(f,'title').disabled,true,'pending submitted fields remain frozen');
  assert.equal(f.w.document.querySelector('[data-close-editor]').disabled,true);
  let asked=0;f.w.confirm=()=>{asked++;return true;};f.el('editor').dispatchEvent(new f.w.Event('cancel',{cancelable:true}));
  assert.equal(f.el('editor').open,true);assert.equal(asked,0);assert.equal(unloadBlocked(f),true);
  options.storageList={data:[{name:originalPath.split('/').pop(),metadata:{size:12}}]};upload.resolve({error:null});
  await until(()=>f.el('save').disabled,'settled upload requires a fresh recovery read');
  assert.equal(f.calls.some(q=>q.table==='documents'&&q.op==='insert'),false);assert.equal(f.w.document.querySelector('[data-close-editor]').disabled,true);
  f.el('editor-refresh').click();await until(()=>f.el('save').disabled===false,'fresh read verifies the existing upload');submit(f);
  await until(()=>!f.el('editor').open,'explicit metadata save confirms the draft');
  assert.equal(f.calls.filter(q=>q.op==='upload').length,1);assert.equal(f.calls.filter(q=>q.table==='documents'&&q.op==='insert').length,1);assert.equal(f.calls.some(q=>q.op==='remove'),false);
});

test('a storage absence read started before upload settlement cannot unlock recovery',async t=>{
  const upload=deferred(),listing=deferred(),options={uploadDeferred:upload},f=fixture(t,options);await newDocumentUpload(f);const expire=coreRequestClock(f);
  submit(f);await until(()=>f.calls.some(q=>q.op==='upload'),'upload started');expire();await until(()=>f.el('editor-error').textContent.includes('could not be confirmed'),'deadline reported');
  options.storageList=listing.promise;f.el('editor-refresh').click();await until(()=>f.calls.some(q=>q.op==='list'),'recovery read started');
  upload.resolve({error:{message:'Synthetic late transport response'}});await pause();listing.resolve({data:[]});
  await until(()=>f.el('workspace-refresh').disabled===false,'refresh completed');
  assert.equal(f.el('save').disabled,true);assert.equal(f.w.document.querySelector('[data-close-editor]').disabled,true);
  assert.match(f.el('editor-error').textContent,/settled.*refresh|refresh.*settled/i);assert.equal(f.calls.some(q=>q.table==='documents'&&q.op==='insert'),false);
  options.storageList={data:[]};f.el('editor-refresh').click();await until(()=>f.el('save').disabled===false,'a later read can unlock the same draft');
});

test('a metadata absence snapshot predating late settlement cannot unlock or discard a document',async t=>{
  const mutation=deferred(),reading=deferred();let holdRead=false;
  const options={onQuery:q=>q.table==='documents'&&q.op==='insert'?mutation.promise:q.table==='documents'&&q.op==='select'&&holdRead?reading.promise:undefined};
  const f=fixture(t,options);await newDocumentUpload(f);const expire=coreRequestClock(f);submit(f);
  await until(()=>f.calls.some(q=>q.table==='documents'&&q.op==='insert'),'metadata write started');expire();await until(()=>f.el('editor-error').textContent.includes('could not be confirmed'),'deadline reported');
  const write=f.calls.find(q=>q.table==='documents'&&q.op==='insert'),before=structuredClone(f.rows('a').documents),reads=f.calls.filter(q=>q.table==='documents'&&q.op==='select').length;
  holdRead=true;f.el('editor-refresh').click();await until(()=>f.calls.filter(q=>q.table==='documents'&&q.op==='select').length>reads,'metadata recovery read started');
  const saved={...write.row,version:1};f.rows('a').documents.push(saved);mutation.resolve({data:saved});await pause();reading.resolve({data:before,count:before.length});
  await until(()=>f.el('workspace-refresh').disabled===false,'stale refresh completed');assert.equal(f.el('save').disabled,true);assert.equal(f.el('editor').open,true);
  assert.equal(f.w.document.querySelector('[data-close-editor]').disabled,true);holdRead=false;f.el('editor-refresh').click();
  await until(()=>!f.el('editor').open,'fresh durable record confirms the original write');assert.equal(f.calls.filter(q=>q.table==='documents'&&q.op==='insert').length,1);
});

test('late document upload settlement after account clearing cannot affect a replacement draft',async t=>{
  const upload=deferred(),f=fixture(t,{uploadDeferred:upload});await newDocumentUpload(f);const expire=coreRequestClock(f);submit(f);
  await until(()=>f.calls.some(q=>q.op==='upload'),'upload started');expire();await until(()=>f.el('editor-error').textContent.includes('could not be confirmed'),'deadline reported');
  f.emit(session('b'));await until(()=>f.el('user-label').textContent.includes('staff-b'),'replacement account ready');
  f.w.document.querySelector('[data-edit-person]').click();field(f,'notes').value='Keep replacement draft';field(f,'notes').dispatchEvent(new f.w.Event('input',{bubbles:true}));
  const before=f.el('editor-error').textContent;upload.resolve({error:null});await pause();
  assert.equal(field(f,'notes').value,'Keep replacement draft');assert.equal(f.el('editor-error').textContent,before);assert.equal(f.el('save').disabled,false);
  assert.equal(f.calls.some(q=>q.table==='documents'&&q.op==='insert'),false);assert.equal(f.calls.some(q=>q.op==='remove'),false);
});

test('a confirmed same-path document retry can finish while an earlier upload remains unresolved',async t=>{
  const first=deferred(),second=deferred(),options={uploadDeferred:first},f=fixture(t,options);await newDocumentUpload(f);const expire=coreRequestClock(f);
  submit(f);await until(()=>f.calls.some(q=>q.op==='upload'),'first upload started');expire();await until(()=>f.el('editor-error').textContent.includes('could not be confirmed'),'first deadline reported');
  f.el('editor-refresh').click();await until(()=>f.el('save').disabled===false,'absent read permits stable retry');assert.match(f.el('editor-error').textContent,/earlier request is still unresolved.*Keep this draft open/);
  options.uploadDeferred=second;field(f,'title').value='Scripted replacement title';f.w.FormData=class{get(){return 'Must not become the retry payload';}};submit(f);
  await until(()=>f.calls.filter(q=>q.op==='upload').length===2,'explicit retry started');const uploads=f.calls.filter(q=>q.op==='upload');assert.equal(uploads[0].path,uploads[1].path);
  second.resolve({error:null});await until(()=>!f.el('editor').open,'confirmed metadata completes the safe retry');
  const metadata=f.calls.find(q=>q.table==='documents'&&q.op==='insert');assert.equal(metadata.row.storage_path,uploads[0].path);assert.equal(metadata.row.title,'Synthetic pending upload');
  const notice=f.el('notice').textContent;first.resolve({error:{message:'Synthetic older upload settled'}});await pause();
  assert.equal(f.el('editor').open,false);assert.equal(f.el('notice').textContent,notice);assert.equal(f.calls.filter(q=>q.table==='documents'&&q.op==='insert').length,1);assert.equal(f.calls.some(q=>q.op==='remove'),false);
});

test('an unresolved event save permits only its submitted retry and blocks alternate archive actions',async t=>{
  const mutation=deferred(),f=fixture(t,{onQuery:q=>q.table==='events'&&q.op==='update'?mutation.promise:undefined});
  await until(()=>f.el('events-list').querySelector('[data-edit-event]'),'event ready');f.el('events-list').querySelector('[data-edit-event]').click();const expire=coreRequestClock(f);submit(f);
  await until(()=>f.calls.some(q=>q.table==='events'&&q.op==='update'),'event write started');expire();await until(()=>f.el('editor-error').textContent.includes('could not be confirmed'),'event deadline reported');
  f.el('editor-refresh').click();await until(()=>f.el('save').disabled===false,'fresh unchanged version permits submitted retry');
  assert.equal(f.el('event-delete').disabled,true);assert.equal(field(f,'title').disabled,true);f.w.confirm=()=>true;
  f.el('event-delete').disabled=false;f.el('event-delete').click();await pause();
  assert.equal(f.calls.filter(q=>q.table==='events'&&q.op==='update').length,1,'the handler independently rejects an alternate archive payload');
  f.emit(null);mutation.resolve({error:{message:'Synthetic abandoned response'}});await pause();assert.equal(f.el('editor').open,false);
});

test('people load every record despite a lower server page cap',async t=>{
  const f=fixture(t,{initial:null,pageCap:500});await pause();
  f.rows('a').contacts=Array.from({length:600},(_,i)=>({id:'synthetic-person-'+i,version:1,updated_at:'2030-01-01',first_name:'Synthetic',last_name:i===599?'Final archive person':'Record '+i,status:'active'}));
  f.emit(session('a'));await until(()=>f.el('people-count').textContent==='600','all 600 people loaded');
  assert.deepEqual(f.calls.filter(q=>q.table==='contacts').map(q=>q.range),[[0,999],[500,1499]]);
  assert.ok(f.calls.filter(q=>q.table==='contacts').every(q=>q.count==='exact'));
  f.el('people-search').value='Final archive person';f.el('people-search').dispatchEvent(new f.w.Event('input'));assert.match(f.el('people-list').textContent,/Final archive person/);
});

test('incomplete or shifted record pages pause editing and retain the open draft',async t=>{
  for(const kind of ['null-page','empty-page','missing-count','changed-count','duplicate','overflow'])await t.test(kind,async t=>{
    let broken=false;
    const options={onQuery(q,rows){
      if(!broken||q.op!=='select'||q.table!=='contacts')return;
      const row=rows('a').contacts[0];
      if(q.range[0]===0)return {data:[row],count:kind==='overflow'?0:2};
      if(kind==='null-page')return {data:null,error:null,count:2};
      if(kind==='empty-page')return {data:[],count:2};
      if(kind==='missing-count')return {data:[{...row,id:'second'}]};
      if(kind==='changed-count')return {data:[{...row,id:'second'}],count:3};
      return {data:[row],count:2};
    }};
    const f=fixture(t,options);await until(()=>f.el('people-list').querySelector('button'),'initial records loaded');
    f.el('people-list').querySelector('button').click();field(f,'notes').value='Keep this synthetic draft';broken=true;f.el('workspace-refresh').click();
    await until(()=>f.el('workspace-health-message').textContent.includes('could not be refreshed'),'load failure shown');
    assert.equal(f.el('people-list').textContent,'');assert.equal(f.el('save').disabled,true);assert.equal(field(f,'notes').value,'Keep this synthetic draft');
  });
});

test('a late first page cannot start the next page after sign-out',async t=>{
  const held=deferred();const f=fixture(t,{initial:null,onQuery:q=>q.table==='contacts'?held.promise:undefined});await pause();f.emit(session('a'));
  await until(()=>f.calls.some(q=>q.table==='contacts'),'first page started');f.emit(null);
  held.resolve({data:Array.from({length:500},(_,i)=>({id:'synthetic-old-'+i,version:1})),count:600});await pause();
  assert.equal(f.calls.filter(q=>q.table==='contacts').length,1);assert.equal(f.el('people-list').textContent,'');assert.equal(f.el('workspace').classList.contains('hidden'),true);
});

test('intake dashboard accepts counted actions, opens an explicit filter, and clears immediately on sign-out',async t=>{
 const intake={summary:{new:2,due:3,open:4}},f=fixture(t,{intake});await until(()=>f.el('intake-new-count').textContent==='2','intake summary loaded');assert.equal(f.el('intake-due-count').textContent,'3');const button=f.w.document.querySelector('button[data-intake-filter="due"]');assert.equal(button.disabled,false);button.click();assert.equal(f.w.location.hash,'#intake');assert.deepEqual(intake.filters,['due']);assert.equal(f.el('page-title').textContent,'Intake actions');f.emit(null);assert.equal(f.el('intake-new-count').textContent,'—');assert.equal(f.el('intake-due-count').textContent,'—');assert.equal(button.disabled,true);assert.equal(f.el('workspace').classList.contains('hidden'),true);
});

test('intake dashboard refuses malformed totals rather than inventing a complete queue',async t=>{
 const intake={summary:{new:4,due:2,open:1}},f=fixture(t,{intake});await until(()=>f.el('people-list').querySelector('button'),'workspace ready');assert.equal(f.el('intake-new-count').textContent,'—');assert.equal(f.w.document.querySelector('button[data-intake-filter="new"]').disabled,true);assert.match(f.el('dashboard-intake-status').textContent,/unavailable/);
});

test('communications is wired to the private workspace lifecycle and never exposed to viewers',async t=>{
 const communications={},f=fixture(t,{communications});await pause();await pause();assert.ok(communications.loads?.length);assert.equal(communications.options.getContext().canEdit,true);
 f.w.location.hash='#communications';f.w.dispatchEvent(new f.w.Event('hashchange'));assert.equal(f.el('communications-view').classList.contains('hidden'),false);assert.match(f.el('communications-view').textContent,/Fictional private choices/);
 f.emit(null);assert.equal(f.el('communications-view').textContent,'');
 const privateModule={},v=fixture(t,{roles:{a:'viewer'},communications:privateModule});await pause();await pause();assert.equal(privateModule.loads,undefined);v.w.location.hash='#communications';v.w.dispatchEvent(new v.w.Event('hashchange'));assert.equal(v.el('communications-view').classList.contains('hidden'),true);
});

test('attention waits for source modules, reports partial counts and clears on sign-out',async t=>{
 const care={snapshot:{items:[]}},followups={summary:{due:0,overdue:0,upcoming:0,items:[]},snapshot:{items:[]}},attention={summary:{count:null,known:2,unavailable:1}},f=fixture(t,{care,followups,attention});
 await until(()=>attention.loads?.length,'attention loaded');assert.equal(attention.loadedAfterSources,true);assert.ok(attention.begins>0);assert.equal(f.el('attention-count').textContent,'—');assert.match(f.el('attention-dashboard-status').textContent,/2 known items; 1 source queues unavailable/);
 const sources=attention.options.getSources('2026-09-11');assert.equal(sources.care,care.snapshot);assert.equal(sources.leaders,followups.snapshot);assert.equal(care.date,'2026-09-11');assert.equal(followups.date,'2026-09-11');
 attention.options.onSummary({count:0,known:0,unavailable:0});assert.equal(f.el('attention-count').textContent,'0');assert.match(f.el('attention-dashboard-status').textContent,/these three queues/);
 attention.options.onSummary({count:0,known:3,unavailable:1});assert.equal(f.el('attention-count').textContent,'—');
 f.w.location.hash='#attention';f.w.dispatchEvent(new f.w.Event('hashchange'));assert.equal(f.el('attention-view').classList.contains('hidden'),false);f.emit(null);assert.equal(f.el('attention-view').textContent,'');assert.equal(f.el('attention-count').textContent,'—');attention.options.onSummary(attention.summary);assert.equal(f.el('attention-count').textContent,'—');
 const held={},v=fixture(t,{roles:{a:'viewer'},attention:held});await until(()=>v.el('role-label').textContent==='viewer','viewer identified');assert.equal(held.loads,undefined);v.w.location.hash='#attention';v.w.dispatchEvent(new v.w.Event('hashchange'));assert.equal(v.el('attention-view').classList.contains('hidden'),true);
});
test('attention handoffs route only after the current source accepts opening',async t=>{
 const attention={},intake={},signups={},care={},followups={summary:{due:0,overdue:0,upcoming:0,items:[]}},f=fixture(t,{attention,intake,signups,care,followups});await until(()=>attention.loads?.length,'workspace ready');
 for(const [type,target,module] of [['intake','intake',intake],['registration','signups',signups],['care_plan','care',care],['care_coverage','care',care],['leader','followups',followups]]){
  f.w.location.hash='#attention';f.w.dispatchEvent(new f.w.Event('hashchange'));module.accepted=false;const item={source_type:type,source_id:'fictional-source',contact_id:'person',care_role:'deacon'};
  assert.equal(attention.options.openSource(item,'2026-09-11'),false);assert.equal(f.w.location.hash,'#attention');module.accepted=true;assert.equal(attention.options.openSource(item,'2026-09-11'),true);assert.equal(f.w.location.hash,'#'+target);
  if(type.startsWith('care_'))assert.equal(care.opened.date,'2026-09-11');
 }
 f.emit(null);assert.equal(attention.options.openSource({source_type:'intake',source_id:'fictional-source'}),false);
});
test('connection diagnostics identify the failed phase without exposing backend details',async t=>{
 for(const [phase,options] of [
  ['staff access',{onQuery:q=>q.table==='staff_roles'?{error:{message:'PRIVATE_CANARY',code:'42501'}}:undefined}],
  ['workspace setup',{readiness:{error:{message:'PRIVATE_CANARY',code:'NETWORK'}}}],
  ['office records',{onQuery:q=>q.table==='documents'?{error:{message:'PRIVATE_CANARY'}}:undefined}]
 ]){const f=fixture(t,options);await until(()=>f.el('workspace-health-message').textContent.includes('Connection check:'),'phase diagnostic ready');assert.ok(f.el('workspace-health-message').textContent.includes(phase));assert.doesNotMatch(f.el('workspace-health-message').textContent,/PRIVATE_CANARY/);assert.equal(f.el('people-list').textContent,'');}
 const held=deferred(),f=fixture(t,{initial:null,onQuery:q=>q.table==='staff_roles'?held.promise:undefined});await pause();const expire=coreRequestClock(f);f.emit(session('a'));await until(()=>f.calls.some(q=>q.table==='staff_roles'),'role read waiting');expire();await until(()=>f.el('workspace-health-message').textContent.includes('request timed out'),'timeout diagnostic');assert.match(f.el('workspace-health-message').textContent,/staff access/);f.emit(null);held.resolve({data:{role:'admin'}});await pause();assert.equal(f.el('people-list').textContent,'');
});
