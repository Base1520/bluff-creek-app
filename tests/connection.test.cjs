const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const {JSDOM} = createRequire(path.join(__dirname, '../admin/tests/package.json'))('jsdom');
const {initialize, settings, sessionStore} = require('../js/connection.js');
const html = fs.readFileSync(path.join(__dirname, '../connection.html'), 'utf8');
const config = {enabled:true,supabaseUrl:'https://sampleproject.supabase.co',publishableKey:'sb_publishable_sample',allowedOrigins:['https://church.example.invalid']};
const A = {id:'00000000-0000-4000-8000-000000000001',email:'first@example.invalid',email_confirmed_at:null,is_anonymous:false};
const B = {...A,id:'00000000-0000-4000-8000-000000000002',email:'second@example.invalid'};
const saved = {id:'00000000-0000-4000-8000-000000000020',version:1,submitted_at:'2026-09-09T15:00:00Z',welcome_email_status:'queued'};
const session = user => ({user,access_token:'synthetic-'+user.id});
function deferred(){let resolve,reject;return {promise:new Promise((yes,no)=>{resolve=yes;reject=no}),resolve,reject};}
const tick=()=>new Promise(r=>setTimeout(r,0));
async function settle(){for(let i=0;i<7;i++)await tick();}
function fixture(t, overrides={}) {
  const dom = new JSDOM(overrides.indexRouter?fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'):html,{url:overrides.url||'https://church.example.invalid/connection.html',runScripts:'outside-only'});
  const win=dom.window, doc=win.document;
  for(const [key,value] of Object.entries(overrides.storage||{}))win.localStorage.setItem(key,value);
  var documentStage = 'loading';
  if(overrides.routerOrder==='controller-first')Object.defineProperty(doc,'readyState',{get:()=>documentStage,configurable:true});
  function runRouter(){for(const script of doc.querySelectorAll('script:not([src])')){if(!script.closest('head'))win.eval(script.textContent);}}
  function documentReady(){documentStage='interactive';doc.dispatchEvent(new win.Event('DOMContentLoaded'));}
  if(overrides.indexRouter){
    win.scrollTo=()=>{};win.matchMedia=()=>({matches:false});win.fetch=async()=>{throw new Error('No network in synthetic router test');};
    win.CreekCalendar={CSV_URL:'',FORM_URL:'#',DEFAULT_FEED:{},load:async()=>({events:[]}),statusText:()=>'',eventTimeLabel:()=>''};win.CreekAppStatus={initialize(){}};
    for(const script of doc.head.querySelectorAll('script:not([src])'))win.eval(script.textContent);
    if(overrides.routerOrder!=='controller-first')runRouter();
    if(overrides.navigateBeforeController)doc.querySelector('[data-tab="'+overrides.navigateBeforeController+'"]').click();
  }
  let identity=overrides.user===undefined?A:overrides.user, currentSession=identity?session(identity):null,callback;
  const routes=[];win.addEventListener('creek:open-profile',()=>routes.push('new'));
  const calls={communication:[],rpc:[],invoke:[],signup:[],signin:[],getUser:0,factory:[],signout:[],setSession:[],update:[],reset:[]},profiles=new Map();
  const client={auth:{
    getSession:async()=>overrides.getSession?overrides.getSession():({data:{session:currentSession},error:null}),
    getUser:async()=>{calls.getUser++;return overrides.getUser?overrides.getUser(identity):{data:{user:identity},error:null};},
    setSession:async value=>{calls.setSession.push(value);return overrides.setSession?overrides.setSession(value):{data:{session:session(A)},error:null};},
    updateUser:async value=>{calls.update.push({...value});return overrides.update?overrides.update(value):{data:{user:identity},error:null};},
    resetPasswordForEmail:async(...args)=>{calls.reset.push(args);return overrides.reset?overrides.reset():{error:null};},
    onAuthStateChange(fn){callback=fn;return {data:{subscription:{unsubscribe(){}}}};},
    signUp:async value=>{calls.signup.push({...value});return overrides.auth?overrides.auth(value):{data:{session:session(A)},error:null};},
    signInWithPassword:async value=>{calls.signin.push({...value});return overrides.auth?overrides.auth(value):{data:{session:session(A)},error:null};},
    signOut:async value=>{calls.signout.push(value);currentSession=null;callback('SIGNED_OUT',null);return {error:null};},stopAutoRefresh(){}
  },rpc:async(name,payload)=>{
    if(name==='get_app_communication_capabilities' || name==='get_my_communication_preferences' || name==='set_my_communication_preferences') {
      calls.communication.push({name,payload:payload&&structuredClone(payload)});
      return overrides.communication?overrides.communication(name,payload):{error:{code:'PGRST202'}};
    }
    calls.rpc.push({name,payload:payload&&structuredClone(payload)});
    if(overrides.rpc)return overrides.rpc(name,payload);
    if(name==='get_my_app_connection')return {data:profiles.get(identity?.id)||null,error:null};
    // Successful fictional writes must be visible to the separate current-state read.
    if(name==='register_app_guest')profiles.set(identity.id,{...structuredClone(payload.p_profile),email:identity.email,guest_removed:false});
    return {data:saved,error:null};
  },
  functions:{invoke:async(name,payload)=>{calls.invoke.push({name,payload});return overrides.invoke?overrides.invoke():{data:{status:'processed',sent:0,queued:1,needs_attention:0},error:null};}}};
  const app=initialize(doc,{config:overrides.config===undefined?config:overrides.config,timeoutMs:overrides.timeoutMs||1000,now:overrides.now,createClient:(...args)=>{calls.factory.push(args);return client;}});
  const el=id=>doc.getElementById('connection-'+id);
  const form=kind=>el(kind+'-form');
  const field=(kind,name)=>form(kind).elements.namedItem(name);
  const input=(kind,name,value)=>{const node=field(kind,name);if(typeof value==='boolean')node.checked=value;else node.value=value;node.dispatchEvent(new win.Event('input',{bubbles:true}));};
  const submit=kind=>form(kind).dispatchEvent(new win.Event('submit',{cancelable:true,bubbles:true}));
  const click=id=>el(id).dispatchEvent(new win.MouseEvent('click',{bubbles:true}));
  const event=(kind,user)=>{identity=user;currentSession=user?session(user):null;callback(kind,currentSession);};
  const fill=()=>{input('guest','first_name','Fictional');input('guest','contact_permission',true);};
  t.after(()=>{app.destroy();win.close();});
  return {win,doc,el,form,field,input,submit,click,event,fill,app,calls,client,routes,runRouter,documentReady,setUser:user=>{identity=user;currentSession=user?session(user):null;}};
}

test('disabled/invalid configuration strips credential URLs and makes no SDK/Auth call',async t=>{
  for(const cfg of [{}, {...config,enabled:false},{...config,enabled:'true'}]){
    const f=fixture(t,{config:cfg,url:'https://church.example.invalid/connection.html#access_token=private&refresh_token=private'});await f.app.ready;
    assert.equal(f.calls.factory.length,0);assert.equal(f.win.location.hash,'');assert.equal(f.el('guest-submit').disabled,true);assert.equal(f.el('prayer-submit').disabled,true);
    assert.match(f.el('availability').textContent,/not connected/);assert.equal(f.doc.querySelector('script[src*=supabase]'),null);
  }
});
test('activation requires exact origin, hosted project root, public key, and explicit dual-loopback opt-in',()=>{
  const url=new URL('https://church.example.invalid/'); assert.ok(settings(config,url));
  for(const change of [{publishableKey:'sb_secret_bad'},{publishableKey:'sb_publishable_bad\n'},{allowedOrigins:['https://other.invalid']},{supabaseUrl:'https://sample.supabase.co.evil.invalid'},{supabaseUrl:'https://sample.supabase.co/rest/v1'},{localDevelopment:true}])assert.equal(settings({...config,...change},url),null);
  assert.equal(settings(config,new URL('https://church.example.invalid/admin/')),null);
  const local={...config,localDevelopment:true,supabaseUrl:'http://127.0.0.1:55321',allowedOrigins:['http://127.0.0.1:8830']};
  assert.ok(settings(local,new URL('http://127.0.0.1:8830/index.html')));
  for(const change of [{localDevelopment:false},{supabaseUrl:'http://192.168.1.2:55321'},{allowedOrigins:['http://localhost:8830']}])assert.equal(settings({...local,...change},new URL('http://127.0.0.1:8830/')),null);
});
test('unconfirmed email is accepted but anonymous/invalid identity cannot read or submit',async t=>{
  const f=fixture(t);await f.app.ready;assert.deepEqual(f.calls.rpc.map(x=>x.name),['get_my_app_connection']);assert.equal(f.el('identity').textContent,'Signed in as '+A.email);
  for(const user of [{...A,is_anonymous:true},{...A,email:''},{...A,id:'not-an-id'}]){
    const bad=fixture(t,{user});await bad.app.ready;bad.fill();bad.submit('guest');await settle();assert.equal(bad.calls.rpc.length,0);
  }
});
test('guest draft and prayer survive account-form mode switching and password signup without verification',async t=>{
  const f=fixture(t,{user:null});await f.app.ready;f.fill();f.input('prayer','request_text','Fictional private prayer');f.doc.querySelector('[data-connection-account]').click();await settle();
  assert.equal(f.el('dialog').open,true);assert.equal(f.calls.rpc.length,0);
  f.el('auth-mode').value='signin';f.el('auth-mode').dispatchEvent(new f.win.Event('change'));f.el('auth-mode').value='signup';
  f.el('email').value=A.email;f.el('password').value='synthetic-password-123';f.setUser(A);f.submit('auth');await settle();
  assert.equal(f.calls.signup.length,1);assert.equal(f.calls.signin.length,0);assert.equal(f.el('password').value,'');
  assert.equal(f.field('prayer','request_text').value,'Fictional private prayer');assert.equal(f.field('guest','first_name').value,'Fictional');
  assert.deepEqual(f.calls.rpc.map(x=>x.name),['get_my_app_connection']);assert.equal(f.calls.invoke.length,0);
  assert.equal(f.calls.factory[0][2].auth.detectSessionInUrl,false);assert.equal(f.calls.factory[0][2].auth.storageKey,'creek-public-intake-v1');
});
test('password signin and missing immediate signup session never claim a submitted form',async t=>{
  for(const result of [{error:{message:'private provider text'}},{data:{session:null},error:null}]){
    const f=fixture(t,{user:null,auth:async()=>result});await f.app.ready;f.input('prayer','request_text','Fictional draft');f.el('auth-mode').value='signin';f.el('email').value=A.email;f.el('password').value='synthetic-password-123';f.submit('auth');await settle();
    assert.equal(f.calls.signin.length,1);assert.equal(f.calls.rpc.length,0);assert.match(f.el('auth-status').textContent,/could not sign you in/);assert.doesNotMatch(f.doc.body.textContent,/private provider text/);assert.equal(f.field('prayer','request_text').value,'Fictional draft');
  }
});
test('remembering stores only the isolated Auth session and never touches Office storage',()=>{
  const dom=new JSDOM('',{url:'https://church.example.invalid'}), win=dom.window;win.localStorage.setItem('creek-office-auth','untouched');
  const store=sessionStore(win);store.storage.setItem('creek-public-intake-v1','memory-session');assert.equal(win.localStorage.length,1);
  store.choose(true);store.storage.setItem('creek-public-intake-v1','remembered-session');store.storage.setItem('password','not-allowed');
  assert.equal(win.localStorage.getItem('creek-public-intake-v1'),'remembered-session');assert.equal(win.localStorage.getItem('password'),null);
  assert.equal(sessionStore(win).storage.getItem('creek-public-intake-v1'),'remembered-session');
  store.clear();store.storage.setItem('creek-public-intake-v1','late-old-session');assert.equal(win.localStorage.getItem('creek-public-intake-v1'),null);assert.equal(win.localStorage.getItem('creek-office-auth'),'untouched');dom.window.close();
});
test('guest saves exact self-reported visit payload and a durable receipt survives welcome failure',async t=>{
  const f=fixture(t,{invoke:async()=>({error:{message:'welcome_queued'}})});await f.app.ready;f.fill();f.input('guest','visit_status','first_visit');f.input('guest','first_visit_on','2026-09-06');f.submit('guest');await settle();
  const call=f.calls.rpc.find(x=>x.name==='register_app_guest');assert.match(call.payload.p_request_id,/^[0-9a-f-]{36}$/);assert.deepEqual(call.payload.p_profile,{first_name:'Fictional',last_name:'',phone:'',preferred_contact:'email',contact_permission:true,sunday_school:'',visit_status:'first_visit',first_visit_on:'2026-09-06'});
  assert.deepEqual(f.calls.invoke,[{name:'welcome-dispatch',payload:{body:{}}}]);assert.match(f.el('guest-status').textContent,/registration receipt is saved/i);assert.match(f.el('guest-status').textContent,/welcome email status could not be confirmed/);assert.doesNotMatch(f.el('guest-status').textContent,/welcome email was requested/);assert.equal(f.el('guest-submit').textContent,'Save my registration');
});
test('prayer-only receipt dispatches a body-free notification without registering a guest or emailing prayer text',async t=>{
  const f=fixture(t);await f.app.ready;f.input('prayer','display_name','Fictional');f.input('prayer','request_text','A fictional prayer');f.input('prayer','contact_text','Optional fictional contact');f.submit('prayer');await settle();
  assert.deepEqual(f.calls.rpc.map(x=>x.name),['get_my_app_connection','submit_app_prayer']);assert.deepEqual(f.calls.rpc[1].payload.p_request,{display_name:'Fictional',request_text:'A fictional prayer',contact_text:'Optional fictional contact'});assert.deepEqual(f.calls.invoke,[{name:'welcome-dispatch',payload:{body:{}}}]);assert.match(f.el('prayer-status').textContent,/received/);assert.equal(f.field('prayer','request_text').value,'');
});
test('double submit and timeout retries freeze the same request and ignore late older receipts',async t=>{
  const pending=deferred();let writes=0;
  const f=fixture(t,{timeoutMs:20,rpc:async name=>name==='get_my_app_connection'?{data:null,error:null}:++writes===1?pending.promise:{data:saved,error:null}});await f.app.ready;f.input('prayer','request_text','Fictional one');f.submit('prayer');f.submit('prayer');await settle();assert.equal(writes,1);
  await new Promise(r=>setTimeout(r,30));assert.match(f.el('prayer-status').textContent,/could not confirm/);assert.equal(f.form('prayer').querySelector('fieldset').disabled,true);assert.equal(f.el('prayer-submit').disabled,false);
  const warn=new f.win.Event('beforeunload',{cancelable:true});f.win.dispatchEvent(warn);assert.equal(warn.defaultPrevented,true);
  f.submit('prayer');await settle();const attempts=f.calls.rpc.filter(x=>x.name==='submit_app_prayer');assert.deepEqual(attempts[0].payload,attempts[1].payload);
  f.input('prayer','request_text','Second fictional draft');pending.resolve({data:{...saved,id:'00000000-0000-4000-8000-000000000030'},error:null});await settle();assert.equal(f.field('prayer','request_text').value,'Second fictional draft');assert.equal(writes,2);
});
test('wrong identity at submit clears drafts and prevents RPC; old account write cannot restore after replacement',async t=>{
  const pending=deferred();const f=fixture(t,{rpc:async name=>name==='get_my_app_connection'?{data:null,error:null}:pending.promise});await f.app.ready;f.fill();f.input('prayer','request_text','Private old draft');f.submit('guest');await settle();
  f.event('SIGNED_IN',B);assert.equal(f.field('prayer','request_text').value,'');assert.equal(f.field('guest','first_name').value,'');await settle();
  pending.resolve({data:saved,error:null});await settle();assert.equal(f.el('guest-status').textContent,'');assert.match(f.el('identity').textContent,/second@example.invalid/);assert.equal(f.calls.invoke.length,0);
  f.input('prayer','request_text','New private draft');f.setUser(A);f.submit('prayer');await settle();assert.equal(f.field('prayer','request_text').value,'');assert.equal(f.calls.rpc.filter(x=>x.name==='submit_app_prayer').length,0);
});
test('signout immediately clears memory and unload guard; queued auth callback cannot restore it',async t=>{
  const f=fixture(t);await f.app.ready;f.fill();f.input('prayer','request_text','Private draft');f.click('signout');assert.equal(f.field('prayer','request_text').value,'');assert.equal(f.field('guest','first_name').value,'');await settle();
  assert.deepEqual(f.calls.signout,[{scope:'local'}]);const event=new f.win.Event('beforeunload',{cancelable:true});f.win.dispatchEvent(event);assert.equal(event.defaultPrevented,false);
  f.event('SIGNED_IN',A);f.event('SIGNED_OUT',null);await settle();assert.doesNotMatch(f.el('identity').textContent,/first@example.invalid/);
});
test('failed profile load blocks guest overwrite but allows prayer, and retry preserves unsent guest fields',async t=>{
  let reads=0;const f=fixture(t,{user:null,rpc:async name=>name==='get_my_app_connection'?(++reads===1?{error:{message:'failure'}}:{data:{first_name:'Old fictional name',email:A.email},error:null}):{data:saved,error:null}});await f.app.ready;f.fill();f.event('SIGNED_IN',A);await settle();
  f.submit('guest');await settle();assert.equal(f.calls.rpc.filter(x=>x.name==='register_app_guest').length,0);f.input('prayer','request_text','Fictional prayer');f.submit('prayer');await settle();assert.equal(f.calls.rpc.filter(x=>x.name==='submit_app_prayer').length,1);
  f.click('retry-profile');await settle();assert.equal(f.field('guest','first_name').value,'Fictional');assert.equal(f.el('guest-submit').disabled,false);
});
test('profile read timeout cannot overwrite a later edit, and account changes invalidate in-flight reads',async t=>{
  const pending=deferred();let reads=0;const f=fixture(t,{timeoutMs:20,rpc:async name=>name==='get_my_app_connection'?(++reads===1?pending.promise:{data:null,error:null}):{data:saved,error:null}});await f.app.ready;
  f.click('retry-profile');await settle();f.fill();pending.resolve({data:{first_name:'Stale fictional name',email:A.email},error:null});await settle();assert.equal(f.field('guest','first_name').value,'Fictional');assert.equal(f.el('guest-submit').disabled,false);
});
test('ambiguous or malformed receipts retain drafts and never dispatch welcome',async t=>{
  for(const data of [null,{id:'bad',submitted_at:saved.submitted_at}, {...saved,version:0},{...saved,welcome_email_status:'delivered'}]){
    const f=fixture(t,{rpc:async name=>({data:name==='get_my_app_connection'?null:data,error:null})});await f.app.ready;f.fill();f.submit('guest');await settle();assert.match(f.el('guest-status').textContent,/could not confirm/);assert.equal(f.field('guest','first_name').value,'Fictional');assert.equal(f.calls.invoke.length,0);
  }
});
test('consent, phone preference, visit consistency and whitespace prayer block invalid writes',async t=>{
  const f=fixture(t);await f.app.ready;f.input('guest','first_name','Fictional');f.submit('guest');await settle();f.input('guest','contact_permission',true);f.input('guest','preferred_contact','text');f.submit('guest');await settle();f.input('guest','preferred_contact','email');f.input('guest','first_visit_on','2026-09-06');f.submit('guest');await settle();f.input('prayer','request_text','   ');f.submit('prayer');await settle();assert.equal(f.calls.rpc.length,1);
});
test('both public entry points mount direct forms and no email-draft handler',()=>{
  for(const file of ['index.html','connection.html']){
    const doc=new JSDOM(fs.readFileSync(path.join(__dirname,'..',file),'utf8')).window.document;
    for(const id of ['connection-guest-form','connection-prayer-form','connection-auth-form'])assert.equal(doc.querySelectorAll('#'+id).length,1,file);
    assert.equal(doc.querySelector('script[src="js/app-forms.js"]'),null);assert.equal(doc.querySelector('script[src="js/connection.js?v=weekly-choices-1"]')!==null,true);
    assert.equal(doc.querySelector('[type=password]').getAttribute('autocomplete'),'new-password');assert.equal(doc.querySelector('form[action^="mailto:"]'),null);
  }
});

test('reset requests use the exact public callback and indistinguishable responses without sending form text',async t=>{
  const messages=[];
  for(const result of [{error:null},{error:{message:'unknown account private detail'}}]){
    const f=fixture(t,{user:null,reset:async()=>result});await f.app.ready;f.input('prayer','request_text','Private fictional prayer');f.click('reset-open');f.el('reset-email').value=A.email;f.submit('reset');await settle();
    assert.deepEqual(f.calls.reset,[[A.email,{redirectTo:'https://church.example.invalid/connection.html'}]]);messages.push(f.el('reset-status').textContent);assert.equal(f.field('prayer','request_text').value,'Private fictional prayer');assert.equal(f.calls.rpc.length,0);assert.equal(f.el('reset-email').value,'');
  }
  assert.equal(messages[0],messages[1]);
});
const recoveryURL=type=>'https://church.example.invalid/connection.html#type='+type+'&token_type=bearer&access_token=synthetic-access&refresh_token=synthetic-refresh';
test('only recovery links enter password setup; invitation/signup/magiclink/duplicate/query credentials are scrubbed and rejected',async t=>{
  for(const url of [recoveryURL('invite'),recoveryURL('signup'),recoveryURL('magiclink'),recoveryURL('recovery')+'&type=recovery',recoveryURL('recovery').replace('/connection.html','/index.html'),'https://church.example.invalid/connection.html?code=private']){
    const f=fixture(t,{url});await f.app.ready;assert.equal(f.win.location.hash,'');assert.equal(f.win.location.search,'');assert.equal(f.calls.factory.length,0);assert.equal(f.el('recovery-fields').hidden,true);assert.match(f.el('recovery-status').textContent,/invalid/);assert.equal(f.calls.rpc.length,0);
  }
});
test('verified recovery uses a separate memory-only session, requires matching passwords, and never signs into intake',async t=>{
  const f=fixture(t,{url:recoveryURL('recovery')});await f.app.ready;
  assert.equal(f.win.location.hash,'');assert.equal(f.calls.setSession.length,1);assert.equal(f.calls.factory[0][2].auth.storageKey,'creek-public-recovery-v1');assert.equal(f.calls.factory[0][2].auth.persistSession,false);assert.equal(f.calls.rpc.length,0);assert.equal(f.el('recovery-fields').hidden,false);
  f.el('new-password').value='synthetic-password-123';f.el('confirm-password').value='different-password-123';f.submit('recovery');await settle();assert.equal(f.calls.update.length,0);
  f.el('confirm-password').value='synthetic-password-123';f.submit('recovery');await settle();assert.equal(f.calls.update.length,1);assert.equal(f.calls.getUser,2);assert.match(f.el('recovery-status').textContent,/password was saved/);assert.equal(f.el('new-password').value,'');assert.equal(f.el('confirm-password').value,'');assert.equal(f.calls.rpc.length,0);assert.equal(f.el('recovery-fields').hidden,true);
});
test('expired link, identity mismatch and ordinary sessions cannot change a password',async t=>{
  const expired=fixture(t,{url:recoveryURL('recovery'),setSession:async()=>({error:{message:'expired private token'}})});await expired.app.ready;assert.equal(expired.el('recovery-fields').hidden,true);assert.doesNotMatch(expired.el('recovery-status').textContent,/expired private token/);
  const wrong=fixture(t,{url:recoveryURL('recovery'),getUser:async()=>({data:{user:B},error:null})});await wrong.app.ready;assert.equal(wrong.el('recovery-fields').hidden,true);assert.equal(wrong.calls.update.length,0);
  const normal=fixture(t);await normal.app.ready;normal.el('new-password').value='synthetic-password-123';normal.el('confirm-password').value='synthetic-password-123';normal.submit('recovery');await settle();assert.equal(normal.calls.update.length,0);assert.equal(normal.el('recovery').hidden,true);
});
test('recovery cancellation/account change clears passwords immediately and ignores late updates',async t=>{
  for(const reason of ['cancel','account']){
    const pending=deferred(), f=fixture(t,{url:recoveryURL('recovery'),update:async()=>pending.promise});await f.app.ready;f.el('new-password').value='synthetic-password-123';f.el('confirm-password').value='synthetic-password-123';f.submit('recovery');f.submit('recovery');await settle();assert.equal(f.calls.update.length,1);
    if(reason==='cancel')f.click('recovery-cancel');else f.event('SIGNED_IN',B);
    assert.equal(f.el('new-password').value,'');assert.equal(f.el('recovery-fields').hidden,true);const message=f.el('recovery-status').textContent;
    pending.resolve({data:{user:A},error:null});await settle();assert.equal(f.el('recovery-status').textContent,message);assert.doesNotMatch(message,/password was saved/);
  }
});
test('recovery password timeout closes the consumed link without claiming failure or auto retry',async t=>{
  const pending=deferred(),f=fixture(t,{url:recoveryURL('recovery'),timeoutMs:20,update:async()=>pending.promise});await f.app.ready;f.el('new-password').value='synthetic-password-123';f.el('confirm-password').value='synthetic-password-123';f.submit('recovery');await new Promise(r=>setTimeout(r,30));assert.match(f.el('recovery-status').textContent,/could not confirm/);assert.equal(f.el('recovery-fields').hidden,true);pending.resolve({data:{user:A},error:null});await settle();assert.doesNotMatch(f.el('recovery-status').textContent,/password was saved/);assert.equal(f.calls.update.length,1);
});
test('timed-out account creation cannot trigger duplicate signup or silently send a pending prayer',async t=>{
  const pending=deferred(),f=fixture(t,{user:null,timeoutMs:20,auth:async()=>pending.promise});await f.app.ready;f.input('prayer','request_text','Fictional unsent prayer');f.el('email').value=A.email;f.el('password').value='synthetic-password-123';f.submit('auth');await new Promise(r=>setTimeout(r,30));assert.equal(f.el('auth-check').disabled,true);f.submit('auth');assert.equal(f.calls.signup.length,1);
  f.setUser(A);pending.resolve({data:{session:session(A)},error:null});await settle();assert.equal(f.calls.rpc.length,0);assert.equal(f.el('auth-check').disabled,false);f.click('auth-check');await settle();assert.deepEqual(f.calls.rpc.map(x=>x.name),['get_my_app_connection']);assert.equal(f.field('prayer','request_text').value,'Fictional unsent prayer');
});
test('post-prayer notification failure preserves the private receipt and never offers a duplicate retry',async t=>{
  const f=fixture(t,{invoke:async()=>({error:{message:'welcome_queued'}})});await f.app.ready;f.input('prayer','request_text','Fictional private request');f.submit('prayer');await settle();assert.match(f.el('prayer-status').textContent,/received/);assert.equal(f.calls.invoke.length,1);assert.equal(f.el('prayer-submit').textContent,'Send prayer request');assert.equal(f.calls.rpc.filter(x=>x.name==='register_app_guest').length,0);
});
test('late signup settlement after signout neither restores a retired session nor leaves account controls locked',async t=>{
  const pending=deferred(),f=fixture(t,{user:null,timeoutMs:20,auth:async()=>pending.promise});await f.app.ready;f.el('email').value=A.email;f.el('password').value='synthetic-password-123';f.submit('auth');await new Promise(r=>setTimeout(r,30));f.click('signout');await settle();assert.equal(f.el('auth-fields').disabled,true);
  f.event('SIGNED_IN',A);pending.resolve({data:{session:session(A)},error:null});await settle();assert.doesNotMatch(f.el('identity').textContent,/first@example.invalid/);assert.equal(f.el('auth-fields').disabled,false);assert.equal(f.calls.rpc.length,0);
});
test('password recovery clears an older remembered public account while preserving Office storage',async t=>{
  const f=fixture(t,{url:recoveryURL('recovery'),storage:{'creek-public-intake-v1':'old-account-session','creek-public-intake-remember-v1':'yes','creek-office-auth':'office-session'}});await f.app.ready;
  assert.equal(f.win.localStorage.getItem('creek-public-intake-v1'),null);assert.equal(f.win.localStorage.getItem('creek-public-intake-remember-v1'),null);assert.equal(f.win.localStorage.getItem('creek-office-auth'),'office-session');assert.equal(f.calls.rpc.length,0);
});
test('returning from sign-in to a fresh account cannot inherit the looser sign-in password minimum',async t=>{
  const f=fixture(t);await f.app.ready;f.el('auth-mode').value='signin';f.el('auth-mode').dispatchEvent(new f.win.Event('change'));f.click('signout');await settle();assert.equal(f.el('auth-mode').value,'signup');assert.equal(f.el('password').minLength,12);assert.equal(f.el('password').autocomplete,'new-password');f.el('email').value=A.email;f.el('password').value='short';f.submit('auth');await settle();assert.equal(f.calls.signup.length,0);
});

test('Send intent continues exactly one captured guest/prayer submission after successful password authentication',async t=>{
  for(const kind of ['guest','prayer']){
    const f=fixture(t,{user:null});await f.app.ready;if(kind==='guest')f.fill();else f.input('prayer','request_text','Fictional captured prayer');
    f.submit(kind);f.submit(kind);assert.equal(f.el('auth-submit').textContent,'Create account & send');assert.equal(f.calls.rpc.length,0);assert.equal(f.form(kind).querySelector('fieldset').disabled,true);
    f.el('email').value=A.email;f.el('password').value='synthetic-password-123';f.setUser(A);f.submit('auth');f.submit('auth');await settle();
    const name=kind==='guest'?'register_app_guest':'submit_app_prayer';assert.equal(f.calls.rpc.filter(x=>x.name===name).length,1);assert.equal(f.calls.invoke.length,1);assert.match(f.el(kind+'-status').textContent,kind==='guest'?/Registration saved/:/Prayer request received/);
    f.event('SIGNED_IN',A);f.event('TOKEN_REFRESHED',A);await settle();assert.equal(f.calls.rpc.filter(x=>x.name===name).length,1);assert.equal(f.calls.invoke.length,1);
  }
});
test('closing or escaping the account dialog cancels the Send intent but keeps editable drafts',async t=>{
  for(const cancel of ['close','escape']){
    const pending=deferred(),f=fixture(t,{user:null,auth:async()=>pending.promise});await f.app.ready;f.input('prayer','request_text','Fictional kept prayer');f.submit('prayer');f.el('email').value=A.email;f.el('password').value='synthetic-password-123';f.submit('auth');
    if(cancel==='close')f.click('close');else f.el('dialog').dispatchEvent(new f.win.Event('cancel',{cancelable:true}));
    assert.equal(f.field('prayer','request_text').value,'Fictional kept prayer');assert.equal(f.form('prayer').querySelector('fieldset').disabled,false);
    f.setUser(A);pending.resolve({data:{session:session(A)},error:null});await settle();assert.deepEqual(f.calls.rpc.map(x=>x.name),['get_my_app_connection']);assert.equal(f.calls.invoke.length,0);assert.equal(f.field('prayer','request_text').value,'Fictional kept prayer');
  }
});
test('failed guest profile read stops auto-send; a read retry alone cannot submit but explicit Save can',async t=>{
  let reads=0;const f=fixture(t,{user:null,rpc:async name=>name==='get_my_app_connection'?(++reads===1?{error:{message:'offline'}}:{data:null,error:null}):{data:saved,error:null}});await f.app.ready;f.fill();f.submit('guest');f.el('email').value=A.email;f.el('password').value='synthetic-password-123';f.setUser(A);f.submit('auth');await settle();assert.equal(f.calls.rpc.filter(x=>x.name==='register_app_guest').length,0);assert.equal(f.field('guest','first_name').value,'Fictional');
  f.click('retry-profile');await settle();assert.equal(f.calls.rpc.filter(x=>x.name==='register_app_guest').length,0);f.submit('guest');await settle();assert.equal(f.calls.rpc.filter(x=>x.name==='register_app_guest').length,1);
});
test('an ambiguous Auth response retires automatic sending even after Check sign-in succeeds',async t=>{
  const pending=deferred(),f=fixture(t,{user:null,timeoutMs:20,auth:async()=>pending.promise});await f.app.ready;f.input('prayer','request_text','Fictional pending prayer');f.submit('prayer');f.el('email').value=A.email;f.el('password').value='synthetic-password-123';f.submit('auth');await new Promise(r=>setTimeout(r,30));f.setUser(A);pending.resolve({data:{session:session(A)},error:null});await settle();f.click('auth-check');await settle();assert.deepEqual(f.calls.rpc.map(x=>x.name),['get_my_app_connection']);assert.equal(f.field('prayer','request_text').value,'Fictional pending prayer');f.submit('prayer');await settle();assert.equal(f.calls.rpc.filter(x=>x.name==='submit_app_prayer').length,1);
});
test('a stale account event cannot auto-send a captured intent and replacement clears it before later responses',async t=>{
  const pending=deferred(),f=fixture(t,{user:null,auth:async()=>pending.promise});await f.app.ready;f.fill();f.submit('guest');f.el('email').value=A.email;f.el('password').value='synthetic-password-123';f.submit('auth');f.event('SIGNED_OUT',null);f.event('SIGNED_IN',B);pending.resolve({data:{session:session(A)},error:null});await settle();assert.equal(f.calls.rpc.filter(x=>x.name==='register_app_guest').length,0);assert.equal(f.field('guest','first_name').value,'');
});
test('a successful automatic submission with a lost receipt retries the same frozen payload and request ID',async t=>{
  let writes=0;const f=fixture(t,{user:null,rpc:async name=>name==='get_my_app_connection'?{data:writes?{first_name:'Fictional',email:A.email,guest_removed:false}:null,error:null}:++writes===1?{error:{message:'lost receipt'}}:{data:saved,error:null}});await f.app.ready;f.fill();f.submit('guest');f.el('auth-mode').value='signin';f.el('remember').checked=true;f.el('auth-mode').dispatchEvent(new f.win.Event('change'));assert.equal(f.el('auth-submit').textContent,'Sign in & send');assert.equal(f.el('remember').checked,true);
  f.el('email').value=A.email;f.el('password').value='synthetic-password-123';f.setUser(A);f.submit('auth');await settle();assert.equal(writes,1);assert.match(f.el('guest-status').textContent,/could not confirm/);f.submit('guest');await settle();const attempts=f.calls.rpc.filter(x=>x.name==='register_app_guest');assert.deepEqual(attempts[0].payload,attempts[1].payload);assert.equal(f.calls.invoke.length,1);
});

function familyField(f,index,key,value){const node=f.el('family-rows').querySelectorAll('[data-family-row]')[index].querySelector('[data-family-field="'+key+'"]');if(arguments.length===4){node.value=value;node.dispatchEvent(new f.win.Event('input',{bubbles:true}));}return node;}
const extended={first_name:'Fictional',email:A.email,birth_date:'1985-02-28',membership_status:'member',address_line1:'100 Fictional Lane',address_line2:'Unit Sample',city:'Sample City',state_region:'LA',postal_code:'00001',family_members:[{first_name:'Fictional Child',last_name:'Example',relationship:'child',birth_date:'2020-02-29'}]};
test('extended household profile travels through one account-and-send intent without putting details in Auth or dispatch',async t=>{
  const f=fixture(t,{user:null});await f.app.ready;f.fill();f.input('guest','birth_date','1985-02-28');f.input('guest','membership_status','member');f.input('guest','address_line1',' 100 Fictional Lane ');f.input('guest','city','Sample City');f.input('guest','state_region','LA');f.input('guest','postal_code','00001');f.click('family-add');familyField(f,0,'first_name','Fictional Child');familyField(f,0,'last_name','Example');familyField(f,0,'relationship','child');familyField(f,0,'birth_date','2020-02-29');f.submit('guest');
  f.el('email').value=A.email;f.el('password').value='synthetic-password-123';f.setUser(A);f.submit('auth');await settle();const writes=f.calls.rpc.filter(x=>x.name==='register_app_guest');assert.equal(writes.length,1);const body=writes[0].payload.p_profile;
  assert.equal(body.birth_date,'1985-02-28');assert.equal(body.membership_status,'member');assert.equal(body.address_line1,'100 Fictional Lane');assert.equal(body.postal_code,'00001');assert.deepEqual(body.family_members,extended.family_members);assert.equal(Object.hasOwn(body,'email'),false);assert.equal(Object.hasOwn(body,'password'),false);assert.deepEqual(Object.keys(f.calls.signup[0]).sort(),['email','password']);assert.deepEqual(f.calls.invoke,[{name:'welcome-dispatch',payload:{body:{}}}]);assert.equal(f.el('open-app').hidden,false);assert.equal(f.win.localStorage.length,0);
});
test('reading existing household values does not include untouched optional fields in a basic profile update',async t=>{
  const f=fixture(t,{rpc:async name=>({data:name==='get_my_app_connection'?extended:saved,error:null})});await f.app.ready;
  assert.equal(f.field('guest','birth_date').value,extended.birth_date);assert.equal(f.field('guest','address_line1').value,extended.address_line1);assert.equal(familyField(f,0,'first_name').value,'Fictional Child');f.fill();f.submit('guest');await settle();const body=f.calls.rpc.find(x=>x.name==='register_app_guest').payload.p_profile;
  for(const key of ['birth_date','membership_status','address_line1','address_line2','city','state_region','postal_code','family_members'])assert.equal(Object.hasOwn(body,key),false,key);
});
test('pre-auth optional edits survive existing-profile hydration and explicit clears stay distinct from omissions',async t=>{
  const f=fixture(t,{user:null,rpc:async name=>({data:name==='get_my_app_connection'?extended:saved,error:null})});await f.app.ready;f.fill();f.input('guest','city','New Sample City');f.doc.querySelector('[data-connection-account]').click();f.el('email').value=A.email;f.el('password').value='synthetic-password-123';f.setUser(A);f.submit('auth');await settle();assert.equal(f.field('guest','city').value,'New Sample City');assert.equal(f.field('guest','address_line1').value,extended.address_line1);
  f.input('guest','birth_date','');f.input('guest','address_line2','');f.el('family-rows').querySelector('button').click();f.submit('guest');await settle();const body=f.calls.rpc.find(x=>x.name==='register_app_guest').payload.p_profile;assert.equal(body.city,'New Sample City');assert.equal(body.birth_date,null);assert.equal(body.address_line2,null);assert.deepEqual(body.family_members,[]);assert.equal(Object.hasOwn(body,'address_line1'),false);
});
test('birthdays use the church date, permit real leap days, and reject future self/family dates before RPC',async t=>{
  const f=fixture(t,{now:()=>new Date('2026-03-01T05:30:00Z')});await f.app.ready;f.fill();assert.equal(f.field('guest','birth_date').max,'2026-02-28');f.input('guest','birth_date','2026-03-01');f.submit('guest');await settle();assert.equal(f.calls.rpc.length,1);
  f.input('guest','birth_date','1984-02-29');f.click('family-add');familyField(f,0,'first_name','Fictional');familyField(f,0,'relationship','child');familyField(f,0,'birth_date','2026-03-01');f.submit('guest');await settle();assert.equal(f.calls.rpc.length,1);familyField(f,0,'birth_date','2024-02-29');f.submit('guest');await settle();assert.equal(f.calls.rpc.filter(x=>x.name==='register_app_guest').length,1);
});
test('family entries require a name and chosen relationship, enforce 20 rows, and clear on identity loss',async t=>{
  const f=fixture(t);await f.app.ready;f.fill();f.click('family-add');f.submit('guest');await settle();assert.equal(f.calls.rpc.length,1);familyField(f,0,'first_name','Fictional');f.submit('guest');await settle();assert.equal(f.calls.rpc.length,1);
  for(let i=1;i<22;i++)f.click('family-add');assert.equal(f.el('family-rows').children.length,20);assert.equal(f.el('family-add').disabled,true);f.event('SIGNED_IN',B);assert.equal(f.el('family-rows').children.length,0);assert.equal(f.field('guest','birth_date').value,'');assert.equal(f.field('guest','address_line1').value,'');await settle();assert.equal(f.win.localStorage.length,0);
});
test('fresh root entry opens onboarding only when no registration is known and never overrides explicit content navigation',async t=>{
  for(const [url,user,data,expected] of [
    ['https://church.example.invalid/',null,null,['new']],['https://church.example.invalid/index.html',A,null,['new']],['https://church.example.invalid/',A,extended,[]],['https://church.example.invalid/#grow',null,null,[]],['https://church.example.invalid/#home',null,null,[]]
  ]){const f=fixture(t,{url,user,rpc:async()=>({data,error:null})});await f.app.ready;assert.deepEqual(f.routes,expected,url);}
  const pending=deferred(),f=fixture(t,{user:null,url:'https://church.example.invalid/',getSession:async()=>pending.promise});f.win.dispatchEvent(new f.win.CustomEvent('creek:navigation',{detail:{screen:'grow'}}));pending.resolve({data:{session:null},error:null});await f.app.ready;assert.deepEqual(f.routes,[]);
  const disabled=fixture(t,{user:null,url:'https://church.example.invalid/',config:{}});await disabled.app.ready;assert.deepEqual(disabled.routes,[]);
});
test('unknown profile-read state never assumes a missing registration or overwrites an explicit route',async t=>{
  let reads=0;const f=fixture(t,{url:'https://church.example.invalid/',rpc:async()=>++reads===1?{error:{message:'offline'}}:{data:null,error:null}});await f.app.ready;assert.deepEqual(f.routes,[]);f.win.dispatchEvent(new f.win.CustomEvent('creek:navigation',{detail:{screen:'calendar'}}));f.click('retry-profile');await settle();assert.deepEqual(f.routes,[]);
});
test('actual index router normalization cannot lose the fresh-root onboarding intent',async t=>{
  for(const [user,profile,screen] of [[null,null,'new'],[A,null,'new'],[A,extended,'home']]){
    const f=fixture(t,{indexRouter:true,url:'https://church.example.invalid/',user,rpc:async()=>({data:profile,error:null})});
    assert.equal(f.win.location.hash,'#home');await f.app.ready;assert.equal(f.win.location.hash,'#'+screen);assert.equal(f.doc.querySelector('.screen:not([hidden])').dataset.screen,screen);
  }
});
test('actual index navigation before account controller startup preserves content browsing',async t=>{
  const f=fixture(t,{indexRouter:true,url:'https://church.example.invalid/',user:null,navigateBeforeController:'grow'});await f.app.ready;assert.equal(f.win.location.hash,'#grow');assert.deepEqual(f.routes,[]);
  const deep=fixture(t,{indexRouter:true,url:'https://church.example.invalid/#calendar',user:null});await deep.app.ready;assert.equal(deep.win.location.hash,'#calendar');assert.deepEqual(deep.routes,[]);
});
test('actual parser script order waits for the router before applying an early account result',async t=>{
  for(const [user,profile,expected] of [[null,null,'new'],[A,null,'new'],[A,extended,'home']]){
    const f=fixture(t,{indexRouter:true,routerOrder:'controller-first',url:'https://church.example.invalid/',user,rpc:async()=>({data:profile,error:null})});await f.app.ready;
    assert.deepEqual(f.routes,[]);assert.equal(f.win.location.hash,'');f.runRouter();assert.equal(f.win.location.hash,'#home');f.documentReady();await settle();assert.equal(f.win.location.hash,'#'+expected);assert.equal(f.doc.querySelector('.screen:not([hidden])').dataset.screen,expected);
  }
});
test('navigation and account loss cancel onboarding while an early result waits for the router',async t=>{
  for(const action of ['navigate','signout']){
    const f=fixture(t,{indexRouter:true,routerOrder:'controller-first',url:'https://church.example.invalid/',user:null});await f.app.ready;assert.deepEqual(f.routes,[]);f.runRouter();
    if(action==='navigate')f.doc.querySelector('[data-tab="grow"]').click();else f.event('SIGNED_OUT',null);
    f.documentReady();await settle();assert.deepEqual(f.routes,[]);assert.equal(f.win.location.hash,action==='navigate'?'#grow':'#home');
  }
});

function preference(version=0,weekly=false,emailMatches=true) { return {version:1,preference_version:version,weekly_email:weekly,email_matches:emailMatches,updated_at:version?'2026-09-10T12:00:00Z':null}; }
function communicationFixture(t, options={}) {
  let value=options.value||preference(),profile=null;
  function write(payload, expectedKey) {
    if(payload[expectedKey]!==value.preference_version)return {error:{code:'40001',message:'COMMUNICATION_VERSION_CONFLICT'}};
    value=preference(value.preference_version+1,payload.p_weekly_email);return {data:value,error:null};
  }
  const f=fixture(t,{...options,communication:async(name,payload)=>{
    if(name==='get_app_communication_capabilities')return options.capability?options.capability():{data:{version:1,weekly_email:true},error:null};
    if(name==='get_my_communication_preferences')return options.read?options.read():{data:value,error:null};
    return options.set?options.set(payload):write(payload,'p_expected_version');
  },rpc:async(name,payload)=>{
    if(name==='get_my_app_connection')return options.profile?options.profile():{data:profile,error:null};
    if(name==='register_app_guest_with_preferences'){
      let result;if(options.register)result=await options.register(payload);
      else {const written=write(payload,'p_preference_version');result=written.error?written:{data:{...saved,communication_preferences:written.data},error:null};}
      if(result&&!result.error&&result.data)profile={...structuredClone(payload.p_profile),email:A.email,guest_removed:false};
      return result;
    }
    return {data:saved,error:null};
  }});
  return Object.assign(f,{getPreference:()=>value,setPreference:next=>{value=next;}});
}
function authenticate(f) { f.el('email').value=A.email;f.el('password').value='synthetic-password-123';f.setUser(A);f.submit('auth'); }
function canceledUnload(f) { const event=new f.win.Event('beforeunload',{cancelable:true});f.win.dispatchEvent(event);return event.defaultPrevented; }

test('weekly email starts unchecked and optional; guest choice and registration use one atomic RPC',async t=>{
  for(const weekly of [false,true]){
    const f=communicationFixture(t,{user:null});await f.app.ready;
    assert.equal(f.el('weekly-choice').hidden,false);assert.equal(f.field('guest','weekly_email').checked,false);assert.equal(f.field('guest','weekly_email').required,false);assert.equal(f.el('preferences').hidden,true);
    f.fill();if(weekly)f.input('guest','weekly_email',true);f.submit('guest');authenticate(f);await settle();
    const writes=f.calls.rpc.filter(call=>call.name!=='get_my_app_connection');assert.equal(writes.length,1);assert.equal(writes[0].name,'register_app_guest_with_preferences');assert.equal(writes[0].payload.p_weekly_email,weekly);assert.equal(writes[0].payload.p_preference_version,0);assert.equal(writes[0].payload.p_profile.contact_permission,true);assert.equal(Object.hasOwn(writes[0].payload.p_profile,'weekly_email'),false);
    assert.equal(f.getPreference().weekly_email,weekly);assert.equal(f.field('preferences','weekly_email').checked,weekly);assert.equal(f.calls.communication.filter(call=>call.name==='set_my_communication_preferences').length,0);assert.equal(f.calls.invoke.length,1);assert.equal(f.el('open-app').hidden,false);assert.equal(canceledUnload(f),false);
  }
});
test('existing weekly choice survives an untouched anonymous form but an explicit unchecked choice wins',async t=>{
  for(const touched of [false,true]){
    const f=communicationFixture(t,{user:null,value:preference(3,true)});await f.app.ready;f.fill();
    if(touched){f.input('guest','weekly_email',true);f.input('guest','weekly_email',false);}
    f.submit('guest');f.el('auth-mode').value='signin';authenticate(f);await settle();
    const write=f.calls.rpc.find(call=>call.name==='register_app_guest_with_preferences');assert.equal(write.payload.p_weekly_email,!touched);assert.equal(write.payload.p_preference_version,3);assert.equal(f.getPreference().weekly_email,!touched);
  }
});
test('email withdrawal is independent of invalid registration and personal care consent, and never dispatches mail',async t=>{
  const f=communicationFixture(t,{value:preference(2,true)});await f.app.ready;
  assert.equal(f.field('guest','contact_permission').checked,false);assert.equal(f.field('guest','first_name').value,'');
  f.input('preferences','weekly_email',false);assert.equal(canceledUnload(f),true);assert.equal(f.el('guest-submit').disabled,true);f.submit('guest');f.submit('preferences');f.submit('preferences');await settle();
  const writes=f.calls.communication.filter(call=>call.name==='set_my_communication_preferences');assert.equal(writes.length,1);assert.deepEqual(Object.keys(writes[0].payload).sort(),['p_expected_version','p_request_id','p_weekly_email']);assert.equal(writes[0].payload.p_weekly_email,false);assert.equal(writes[0].payload.p_expected_version,2);assert.equal(f.getPreference().weekly_email,false);assert.equal(f.calls.rpc.length,1);assert.equal(f.calls.invoke.length,0);assert.equal(f.field('guest','contact_permission').checked,false);assert.equal(canceledUnload(f),false);
});
test('missing capability hides both choices and retains the legacy registration endpoint',async t=>{
  const f=fixture(t);await f.app.ready;assert.equal(f.el('weekly-choice').hidden,true);assert.equal(f.el('preferences').hidden,true);f.fill();f.submit('guest');await settle();
  assert.deepEqual(f.calls.communication.map(call=>call.name),['get_app_communication_capabilities']);assert.deepEqual(f.calls.rpc.map(call=>call.name),['get_my_app_connection','register_app_guest','get_my_app_connection']);assert.equal(Object.hasOwn(f.calls.rpc[1].payload,'p_weekly_email'),false);
});
test('unknown capability fails closed for guest choices but prayer works; a later check can recover',async t=>{
  for(const response of [{error:{code:'42501',message:'private diagnostic'}},{data:{version:1,weekly_email:false}},{data:{version:2,weekly_email:true}}]){
    let recovered=false;const f=communicationFixture(t,{capability:async()=>recovered?{data:{version:1,weekly_email:true}}:response});await f.app.ready;f.fill();f.submit('guest');await settle();assert.equal(f.calls.rpc.length,1);assert.equal(f.el('guest-submit').disabled,true);assert.equal(f.el('communication-retry').hidden,false);assert.doesNotMatch(f.doc.body.textContent,/private diagnostic/);
    f.input('prayer','request_text','Fictional prayer');f.submit('prayer');await settle();assert.equal(f.calls.rpc.at(-1).name,'submit_app_prayer');
    recovered=true;f.click('communication-retry');await settle();assert.equal(f.el('guest-submit').disabled,false);f.submit('guest');await settle();assert.equal(f.calls.rpc.filter(c=>c.name!=='get_my_app_connection').at(-1).name,'register_app_guest_with_preferences');assert.equal(f.calls.rpc.at(-1).name,'get_my_app_connection');
  }
});
test('failed or invalid own preference read holds automatic guest submission until explicit reload and Send',async t=>{
  for(const data of [null,preference(-1),{...preference(),weekly_email:true},{...preference(1),email_matches:false,weekly_email:true},{...preference(1),updated_at:null},{...preference(),email_matches:'yes'}]){
    let recovered=false;const f=communicationFixture(t,{user:null,read:async()=>({data:recovered?preference():data,error:null})});await f.app.ready;f.fill();f.input('guest','weekly_email',true);f.submit('guest');authenticate(f);await settle();
    assert.equal(f.calls.rpc.length,1);assert.equal(f.el('guest-submit').disabled,true);assert.equal(f.field('guest','first_name').value,'Fictional');
    recovered=true;f.click('communication-retry');await settle();assert.equal(f.calls.rpc.length,1);assert.equal(f.el('guest-submit').disabled,false);f.submit('guest');await settle();assert.equal(f.calls.rpc.filter(c=>c.name==='register_app_guest_with_preferences').at(-1).payload.p_weekly_email,true);assert.equal(f.calls.rpc.at(-1).name,'get_my_app_connection');
  }
});
test('ambiguous atomic registration freezes choice/version/request and fresh read beats historical replay',async t=>{
  const pending=deferred();let writes=0;
  const oldReceipt={...saved,communication_preferences:preference(2,true)};
  const f=communicationFixture(t,{value:preference(1,false),timeoutMs:20,register:async()=>++writes===1?pending.promise:{data:oldReceipt,error:null}});await f.app.ready;f.fill();f.input('guest','weekly_email',true);f.submit('guest');f.submit('guest');await settle();assert.equal(writes,1);
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.el('guest-submit').disabled,false);assert.equal(f.form('guest').querySelector('fieldset').disabled,true);assert.equal(f.el('preferences-submit').disabled,true);assert.equal(canceledUnload(f),true);
  f.setPreference(preference(3,false));f.submit('guest');await settle();const calls=f.calls.rpc.filter(call=>call.name==='register_app_guest_with_preferences');assert.equal(calls.length,2);assert.deepEqual(calls[0].payload,calls[1].payload);assert.equal(f.field('preferences','weekly_email').checked,false);assert.equal(f.field('guest','weekly_email').checked,false);assert.match(f.el('preferences-status').textContent,/current choice is off/);
  pending.resolve({data:{...saved,communication_preferences:preference(2,true)},error:null});await settle();assert.equal(f.field('preferences','weekly_email').checked,false);assert.equal(f.calls.invoke.length,1);assert.equal(canceledUnload(f),false);
});
test('ambiguous standalone preference retry is immutable and cannot race a guest registration or late receipt',async t=>{
  const pending=deferred();let writes=0;
  const f=communicationFixture(t,{timeoutMs:20,set:async()=>++writes===1?pending.promise:{data:preference(1,true),error:null}});await f.app.ready;f.input('preferences','weekly_email',true);f.submit('preferences');f.submit('preferences');await settle();assert.equal(writes,1);
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.el('preferences-submit').disabled,false);assert.equal(f.form('preferences').querySelector('fieldset').disabled,true);assert.equal(canceledUnload(f),true);f.fill();f.submit('guest');await settle();assert.equal(f.calls.rpc.length,1);
  f.setPreference(preference(2,false));f.submit('preferences');await settle();const calls=f.calls.communication.filter(call=>call.name==='set_my_communication_preferences');assert.deepEqual(calls[0].payload,calls[1].payload);assert.equal(f.field('preferences','weekly_email').checked,false);assert.equal(f.calls.invoke.length,0);
  pending.resolve({data:preference(1,true)});await settle();assert.equal(f.field('preferences','weekly_email').checked,false);
});
test('definitive version conflicts preserve choice and profile for explicit review with a fresh version and request',async t=>{
  for(const kind of ['guest','preferences']){
    let writes=0;const f=communicationFixture(t,{value:preference(1,false),register:async payload=>++writes===1?{error:{code:'40001',message:'COMMUNICATION_VERSION_CONFLICT'}}:{data:{...saved,communication_preferences:preference(payload.p_preference_version+1,payload.p_weekly_email)}},set:async payload=>++writes===1?{error:{code:'40001',message:'COMMUNICATION_VERSION_CONFLICT'}}:{data:preference(payload.p_expected_version+1,payload.p_weekly_email)}});await f.app.ready;
    if(kind==='guest')f.fill();f.input(kind,'weekly_email',true);f.setPreference(preference(4,false));f.submit(kind);await settle();assert.equal(writes,1);assert.equal(f.field(kind,'weekly_email').checked,true);assert.equal(f.form(kind).querySelector('fieldset').disabled,false);assert.match(f.el(kind==='guest'?'guest-status':'preferences-status').textContent,/changed elsewhere/);assert.equal(f.calls.invoke.length,0);
    f.submit(kind);await settle();const calls=(kind==='guest'?f.calls.rpc:f.calls.communication).filter(call=>call.name===(kind==='guest'?'register_app_guest_with_preferences':'set_my_communication_preferences'));assert.equal(calls.length,2);assert.notEqual(calls[0].payload.p_request_id,calls[1].payload.p_request_id);assert.equal(calls[1].payload[kind==='guest'?'p_preference_version':'p_expected_version'],4);
  }
});
test('an email-change projection defaults off and only explicit choice binds a new preference',async t=>{
  const f=communicationFixture(t,{value:preference(5,false,false)});await f.app.ready;assert.equal(f.field('guest','weekly_email').checked,false);assert.equal(f.field('preferences','weekly_email').checked,false);assert.match(f.el('communication-status').textContent,/email has changed/);assert.equal(f.calls.communication.filter(call=>call.name==='set_my_communication_preferences').length,0);
  f.input('preferences','weekly_email',true);f.submit('preferences');await settle();assert.equal(f.getPreference().email_matches,true);assert.equal(f.getPreference().weekly_email,true);
});
test('account replacement or same-account email change clears preference drafts and ignores old reads/writes',async t=>{
  for(const replacement of [B,{...A,email:'changed@example.invalid'}]){
    const pending=deferred();const f=communicationFixture(t,{set:async()=>pending.promise});await f.app.ready;f.input('preferences','weekly_email',true);f.submit('preferences');await settle();assert.equal(canceledUnload(f),true);
    f.event('USER_UPDATED',replacement);assert.equal(f.field('preferences','weekly_email').checked,false);assert.equal(f.el('preferences').hidden,true);assert.equal(canceledUnload(f),false);await settle();assert.match(f.el('identity').textContent,new RegExp(replacement.email.replaceAll('.','\\.')));
    pending.resolve({data:preference(1,true)});await settle();assert.equal(f.field('preferences','weekly_email').checked,false);assert.equal(f.el('preferences-status').textContent.includes('saved.'),false);assert.equal(f.calls.invoke.length,0);
  }
  const pending=deferred();let reads=0;const f=communicationFixture(t,{read:async()=>++reads===1?pending.promise:{data:preference()}});await tick();await tick();f.event('SIGNED_IN',B);pending.resolve({data:preference(8,true)});await f.app.ready;await settle();assert.equal(f.field('preferences','weekly_email').checked,false);assert.match(f.el('identity').textContent,/second@example.invalid/);
});
test('getUser detects a same-ID changed email before preference write and signout clears unresolved drafts',async t=>{
  const f=communicationFixture(t);await f.app.ready;f.input('preferences','weekly_email',true);f.setUser({...A,email:'changed@example.invalid'});f.submit('preferences');await settle();assert.equal(f.calls.communication.filter(call=>call.name==='set_my_communication_preferences').length,0);assert.equal(f.field('preferences','weekly_email').checked,false);assert.equal(canceledUnload(f),false);
  const pending=deferred();const g=communicationFixture(t,{set:async()=>pending.promise});await g.app.ready;g.input('preferences','weekly_email',true);g.submit('preferences');await settle();g.click('signout');assert.equal(g.el('preferences').hidden,true);assert.equal(g.field('preferences','weekly_email').checked,false);assert.equal(canceledUnload(g),false);pending.resolve({data:preference(1,true)});await settle();assert.equal(g.el('preferences').hidden,true);assert.equal(g.win.localStorage.length,0);
});

test('definitive opt-in rate limit releases the rejected request so opt-out remains possible',async t=>{
  for(const kind of ['guest','preferences']){
    let calls=0;
    const response=payload=>{if(++calls===1){f.setPreference(preference(3,true));return {error:{code:'P0001',message:'COMMUNICATION_RATE_LIMIT'}};}return {data:kind==='guest'?{...saved,communication_preferences:preference(4,false)}:preference(4,false)};};
    const f=communicationFixture(t,{value:preference(2,false),register:async payload=>response(payload),set:async payload=>response(payload)});await f.app.ready;
    if(kind==='guest')f.fill();f.input(kind,'weekly_email',true);f.submit(kind);
    await settle();assert.equal(calls,1);assert.equal(f.form(kind).querySelector('fieldset').disabled,false);assert.equal(f.calls.invoke.length,0);
    f.input(kind,'weekly_email',false);f.submit(kind);await settle();assert.equal(calls,2);
    const writes=(kind==='guest'?f.calls.rpc:f.calls.communication).filter(call=>call.name===(kind==='guest'?'register_app_guest_with_preferences':'set_my_communication_preferences'));
    assert.equal(writes[1].payload.p_weekly_email,false);assert.notEqual(writes[0].payload.p_request_id,writes[1].payload.p_request_id);assert.equal(writes[1].payload[kind==='guest'?'p_preference_version':'p_expected_version'],3);
  }
});
test('atomic and standalone malformed preference receipts never clear attempts or claim a completed choice',async t=>{
  for(const kind of ['guest','preferences']){
    const f=communicationFixture(t,{register:async()=>({data:{...saved,communication_preferences:preference(1,false)}}),set:async()=>({data:preference(99,true)})});await f.app.ready;if(kind==='guest')f.fill();f.input(kind,'weekly_email',true);f.submit(kind);await settle();
    assert.equal(f.form(kind).querySelector('fieldset').disabled,true);assert.match(f.el(kind==='guest'?'guest-status':'preferences-status').textContent,/could not confirm/);assert.equal(canceledUnload(f),true);assert.equal(f.calls.invoke.length,0);
  }
});
test('a failed current read after a valid preference receipt requires only a read retry, never another write',async t=>{
  let reads=0;const f=communicationFixture(t,{read:async()=>++reads===2?{error:{code:'network'}}:{data:reads===1?preference():preference(2,false)},set:async()=>({data:preference(1,true)})});await f.app.ready;f.input('preferences','weekly_email',true);f.submit('preferences');await settle();
  assert.equal(f.el('preferences-submit').disabled,true);assert.equal(f.el('communication-retry').hidden,false);assert.equal(canceledUnload(f),false);f.click('communication-retry');await settle();assert.equal(f.field('preferences','weekly_email').checked,false);assert.equal(f.calls.communication.filter(call=>call.name==='set_my_communication_preferences').length,1);assert.equal(f.calls.invoke.length,0);
});

test('request conflicts reload current registration before explicit retry without denying earlier committed records',async t=>{
  for(const message of ['COMMUNICATION_VERSION_CONFLICT','COMMUNICATION_REQUEST_CONFLICT','REQUEST_ID_CONFLICT']){
    const pending=deferred();let reads=0,writes=0;
    const f=communicationFixture(t,{profile:async()=>++reads===1?{data:null}:pending.promise,register:async payload=>++writes===1?{error:{code:'40001',message}}:{data:{...saved,communication_preferences:preference(1,payload.p_weekly_email)}}});await f.app.ready;f.fill();f.input('guest','weekly_email',true);f.submit('guest');await settle();
    assert.equal(reads,2);assert.equal(writes,1);assert.equal(f.el('guest-submit').disabled,true);assert.equal(f.field('guest','first_name').value,'Fictional');assert.doesNotMatch(f.el('guest-status').textContent,/Nothing from.*saved|registration was not saved/i);f.submit('guest');await settle();assert.equal(writes,1);
    pending.resolve({data:{first_name:'Fictional saved record',email:A.email}});await settle();assert.equal(f.field('guest','first_name').value,'Fictional');assert.equal(f.el('guest-submit').disabled,false);assert.equal(writes,1);f.submit('guest');await settle();assert.equal(writes,2);
  }
});

test('removed own guest registration blocks guest writes but preserves prayer and explicit restoration reread',async t=>{
  let removed=true;
  const f=fixture(t,{rpc:async name=>name==='get_my_app_connection'?{data:{first_name:'Fictional saved guest',email:A.email,guest_removed:removed}}:{data:saved,error:null}});
  await f.app.ready;assert.equal(f.el('guest-submit').disabled,true);assert.equal(f.form('guest').querySelector('fieldset').disabled,true);assert.equal(f.el('retry-profile').hidden,false);
  assert.match(f.el('profile-status').textContent,/office removed.*login still works.*prayer request/i);
  f.fill();f.submit('guest');await settle();assert.equal(f.calls.rpc.some(c=>c.name==='register_app_guest'),false,'forced submit cannot bypass removal');
  f.input('prayer','request_text','Fictional private prayer after visit removal');f.submit('prayer');await settle();assert.equal(f.calls.rpc.filter(c=>c.name==='submit_app_prayer').length,1);assert.match(f.el('prayer-status').textContent,/received/);
  removed=false;f.click('retry-profile');await settle();assert.equal(f.el('guest-submit').disabled,false);assert.equal(f.form('guest').querySelector('fieldset').disabled,false);assert.equal(f.calls.rpc.some(c=>c.name==='register_app_guest'),false,'a read alone never resubmits');
});

test('a durable historical guest receipt is rechecked after removal and never dispatches or claims a current welcome',async t=>{
  let reads=0,writes=0;
  const f=fixture(t,{rpc:async name=>name==='get_my_app_connection'?{data:++reads===1?null:{first_name:'Fictional removed guest',email:A.email,guest_removed:true}}:++writes===1?{error:{message:'Synthetic lost receipt'}}:{data:saved,error:null}});
  await f.app.ready;f.fill();f.submit('guest');await settle();assert.match(f.el('guest-status').textContent,/could not confirm/);
  f.submit('guest');await settle();const attempts=f.calls.rpc.filter(c=>c.name==='register_app_guest');assert.equal(attempts.length,2);assert.deepEqual(attempts[0].payload,attempts[1].payload);
  assert.equal(f.calls.invoke.length,0);assert.match(f.el('guest-status').textContent,/original submission was received.*since removed/i);assert.doesNotMatch(f.el('guest-status').textContent,/welcome email was requested|Registration saved\./);
  assert.equal(f.el('guest-submit').disabled,true);assert.equal(f.el('prayer-submit').disabled,false);assert.equal(f.el('retry-profile').hidden,false);
});

test('post-receipt current-profile failures expose read retry and cannot dispatch or enable another guest write',async t=>{
  for(const failure of [{error:{message:'PRIVATE_READ_CANARY'}},{data:null},{data:{first_name:'Another account',email:B.email,guest_removed:false}}]){
    let reads=0,recovered=false;
    const f=fixture(t,{rpc:async name=>name==='get_my_app_connection'?(++reads===1?{data:null}:recovered?{data:{first_name:'Fictional restored guest',email:A.email,guest_removed:false}}:failure):{data:saved,error:null}});
    await f.app.ready;f.fill();f.submit('guest');await settle();assert.equal(f.calls.invoke.length,0);assert.doesNotMatch(f.el('guest-status').textContent,/welcome email was requested|PRIVATE_READ_CANARY/);assert.match(f.el('guest-status').textContent,/could not be confirmed/);
    assert.equal(f.el('guest-submit').disabled,true);assert.equal(f.el('retry-profile').hidden,false);assert.equal(f.el('prayer-submit').disabled,false);
    f.submit('guest');await settle();assert.equal(f.calls.rpc.filter(c=>c.name==='register_app_guest').length,1);
    recovered=true;f.click('retry-profile');await settle();assert.equal(f.el('guest-submit').disabled,false);assert.equal(f.calls.rpc.filter(c=>c.name==='register_app_guest').length,1);assert.equal(f.calls.invoke.length,0,'read recovery never automatically requests mail');
  }
});

test('late removed-profile confirmation cannot disable or notify a replacement public account',async t=>{
  const pending=deferred();let reads=0;
  const f=fixture(t,{rpc:async name=>name==='get_my_app_connection'?(++reads===1?{data:null}:reads===2?pending.promise:{data:{first_name:'Fictional replacement',email:B.email,guest_removed:false}}):{data:saved,error:null}});
  await f.app.ready;f.fill();f.submit('guest');await settle();assert.equal(reads,2);assert.equal(f.calls.invoke.length,0);
  f.event('SIGNED_OUT',null);f.event('SIGNED_IN',B);await settle();pending.resolve({data:{first_name:'Previous removed guest',email:A.email,guest_removed:true}});await settle();
  assert.equal(f.el('guest-submit').disabled,false);assert.equal(f.field('guest','first_name').value,'Fictional replacement');assert.doesNotMatch(f.el('guest-status').textContent,/removed|saved|welcome/);assert.equal(f.calls.invoke.length,0);
});
