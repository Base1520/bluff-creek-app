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
  const rows = owner => ({ events:[{id:'event-'+owner,title:'Synthetic gathering '+owner,starts_at:'2030-01-06T15:00:00Z',tag:'Special'}], contacts:[{id:'person-'+owner,first_name:'Synthetic',last_name:'Record '+owner,status:'active',updated_at:'2030-01-01',notes:'Synthetic private note '+owner}], documents:[{id:'doc-'+owner,title:'Sample policy '+owner,file_name:'fixture.pdf',storage_path:owner+'/fixture.pdf',category:'policy',updated_at:'2030-01-01'}],audit_log:[] });
  function respond(q) {
    calls.push(q);
    assert.equal(insideCallback,false,'database work must not run inside the auth callback');
    if(delayed.some(match=>match(q))) {const d=deferred();pending.push({q,...d});return d.promise;}
    return Promise.resolve(q.table==='staff_roles'?{data:{role:options.roles?.[q.owner]||'editor'}}:{data:q.op==='select'?rows(q.owner)[q.table]:null,error:null});
  }
  const client={auth:{
    stopAutoRefresh(){}, startAutoRefresh(){},
    onAuthStateChange(cb){callback=cb;return {data:{subscription:{unsubscribe(){}}}};},
    async getSession(){return {data:{session:current}};},
    async signInWithPassword(){if(options.signInDeferred)return options.signInDeferred.promise;w.sessionStorage.setItem('creek-office-auth',JSON.stringify(session('a')));emit(session('a'),'SIGNED_IN');return {data:{session:current}};},
    async signOut(){if(options.signOutDeferred)return options.signOutDeferred.promise;emit(null);return {error:null};}
  },from(table){
    assert.equal(insideCallback,false,'do not start database queries inside the auth callback');
    const q={table,owner:current?.user.id,op:'select'};
    const chain={select(){return chain;},eq(k,v){q[k]=v;return chain;},order(){return chain;},limit(){return chain;},maybeSingle(){return chain;},insert(row){q.op='insert';q.row=row;return chain;},update(row){q.op='update';q.row=row;return chain;},delete(){q.op='delete';return chain;},then(a,b){return respond(q).then(a,b);}};return chain;
  },storage:{from(){return {
    async upload(path,file){calls.push({op:'upload',path,size:file.size});if(options.uploadDeferred)return options.uploadDeferred.promise;return {error:null};},
    async remove(paths){calls.push({op:'remove',paths});return {error:null};},
    async createSignedUrl(){calls.push({op:'signedUrl'});if(options.signedDeferred)return options.signedDeferred.promise;return {data:{signedUrl:'https://files.example.invalid/synthetic?token=test'}};}
  };}}};
  function emit(next,event='TEST'){current=next;insideCallback=true;const returned=callback(event,next);insideCallback=false;assert.equal(returned,undefined);}
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
  for(const view of ['history','care','announcements','committees','slides','prayers']) {
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
