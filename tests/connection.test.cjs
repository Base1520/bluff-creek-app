const test = require('node:test');
const assert = require('node:assert/strict');
const { initialize, settings } = require('../js/connection.js');
const config = { supabaseUrl:'https://sampleproject.supabase.co',publishableKey:'sb_publishable_sample',allowedOrigins:['https://church.example.invalid'] };
const ownUser = { id:'00000000-0000-4000-8000-000000000001',email:'person@example.invalid',email_confirmed_at:'2026-09-01T00:00:00Z',is_anonymous:false };
const session = { access_token:'synthetic-access',user:ownUser };
const saved = { id:'00000000-0000-4000-8000-000000000020',version:1 };
class Node {
  constructor(value='') { this.value=value;this.checked=false;this.required=false;this.hidden=true;this.disabled=false;this.textContent='';this.handlers={};this.classes=new Set();this.classList={toggle:(name,on)=>on?this.classes.add(name):this.classes.delete(name)}; }
  addEventListener(name,fn) { (this.handlers[name] ||= []).push(fn); }
  async emit(name,target=this) { for(const fn of this.handlers[name]||[])await fn({preventDefault(){},target}); }
}
function form(fields) {
  const node=new Node();const initial={...fields};const nodes=Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,new Node(v)]));
  node.elements={namedItem:name=>nodes[name]};node.querySelector=()=>node.button;node.button=new Node();node.reportValidity=()=>Object.values(nodes).every(n=>!n.required||(n.type==='checkbox'?n.checked:!!n.value));
  node.reset=()=>Object.entries(nodes).forEach(([k,n])=>{n.value=initial[k];n.checked=false});node.fields=nodes;return node;
}
function fixture(overrides={}) {
  const profile=form({first_name:'',last_name:'',phone:'',preferred_contact:'email',sunday_school:'',contact_permission:''});profile.fields.first_name.required=true;profile.fields.contact_permission.type='checkbox';profile.fields.contact_permission.required=true;
  const emailForm=form({email:''});const nodes={};for(const key of ['unavailable','signin','account','status','verified-email','retry','fields','signout'])nodes[key]=new Node();
  nodes.unavailable.hidden=false;nodes['profile-form']=profile;nodes['email-form']=emailForm;nodes.email=emailForm.fields.email;nodes.email.required=true;
  let location=new URL(overrides.url||'https://church.example.invalid/connection.html'),authCallback;
  const calls={factory:[],rpc:[],otp:[],setSession:[],signout:[],sdk:0,unsubscribed:0};
  const win={get location(){return location},history:{replaceState(_,__,url){location=new URL(url,location)}},setTimeout,addEventListener(){}};
  const doc={defaultView:win,getElementById:id=>nodes[id.replace(/^connection-/,'')],head:{appendChild(){calls.sdk++}},createElement(){return new Node()}};
  const client={auth:{getSession:async()=>({data:{session:overrides.session===undefined?session:overrides.session},error:null}),getUser:overrides.getUser||(async()=>({data:{user:overrides.user===undefined?ownUser:overrides.user},error:null})),setSession:async(value)=>{calls.setSession.push(value);return{data:{session},error:null}},onAuthStateChange(fn){authCallback=fn;return{data:{subscription:{unsubscribe(){calls.unsubscribed++}}}}},signInWithOtp:async arg=>{calls.otp.push(arg);return overrides.otpResult||{data:{session:null},error:null}},signOut:async arg=>{calls.signout.push(arg);authCallback('SIGNED_OUT',null);return{error:null}},stopAutoRefresh(){}},rpc:async(name,payload)=>{calls.rpc.push({name,payload});return overrides.rpc?overrides.rpc(name,payload):{data:name==='get_my_app_connection'?(overrides.profile||null):saved,error:null}}};
  const app=initialize(doc,{config:overrides.config===undefined?config:overrides.config,createClient:(...args)=>{calls.factory.push({args,hash:location.hash});return client}});
  const flush=async()=>{await app.ready;await new Promise(r=>setTimeout(r,5));await new Promise(r=>setTimeout(r,0));};
  function fill(){profile.fields.first_name.value='Sample';profile.fields.contact_permission.checked=true;}
  return {nodes,profile,client,calls,app,flush,fill,doc,event:(event,value)=>authCallback(event,value)};
}
function deferred(){let resolve;return{promise:new Promise(r=>resolve=r),resolve};}

test('blank configuration makes no SDK/Auth requests and strips token-bearing URLs',async()=>{
 const f=fixture({config:{},url:'https://church.example.invalid/connection.html#access_token=secret&refresh_token=secret&token_type=bearer'});await f.flush();
 assert.equal(f.calls.factory.length,0);assert.equal(f.calls.sdk,0);assert.equal(f.nodes.unavailable.hidden,false);assert.equal(f.doc.defaultView.location.hash,'');assert.equal(f.nodes['profile-form'].hidden,true);
});
test('only exact approved origins and browser publishable keys can activate connection',()=>{
 for(const bad of [{...config,allowedOrigins:['https://other.example.invalid']},{...config,publishableKey:'sb_secret_not_public'},{...config,supabaseUrl:'https://sampleproject.supabase.co.evil.invalid'}])assert.equal(settings(bad,new URL('https://church.example.invalid/connection.html')),null);
 assert.equal(settings(config,new URL('https://church.example.invalid/connection.html?redirect=https://other.invalid')).redirect,'https://church.example.invalid/connection.html');
});
test('email link success uses the exact local callback; errors never claim submission',async()=>{
 for(const error of [null,{message:'Synthetic auth failure'}]){
  const f=fixture({session:null,otpResult:{error}});await f.flush();f.nodes.email.value='person@example.invalid';await f.nodes['email-form'].emit('submit');
  assert.equal(f.calls.otp[0].options.emailRedirectTo,'https://church.example.invalid/connection.html');assert.equal(f.calls.otp[0].options.shouldCreateUser,true);assert.equal(f.calls.rpc.length,0);
  assert.match(f.nodes.status.textContent,error?/could not send/:/not been submitted/);assert.equal(f.nodes['profile-form'].hidden,true);
 }
});
test('a nonverified or anonymous user cannot load or save a profile',async()=>{
 for(const user of [{...ownUser,email_confirmed_at:null},{...ownUser,is_anonymous:true}]){
  const f=fixture({user});await f.flush();f.fill();await f.profile.emit('submit');assert.equal(f.calls.rpc.length,0);assert.equal(f.profile.hidden,true);assert.match(f.nodes.status.textContent,/could not verify/);
 }
});
test('own profile read populates only user-owned fields and requires fresh contact permission',async()=>{
 const f=fixture({profile:{...saved,first_name:'Sample',last_name:'Record',email:ownUser.email,phone:'',preferred_contact:'email',contact_permission:true,sunday_school:'Sample class',staff_notes:'Must never appear'}});await f.flush();
 assert.deepEqual(f.calls.rpc.map(x=>x.name),['get_my_app_connection']);assert.equal(f.profile.fields.first_name.value,'Sample');assert.equal(f.profile.fields.sunday_school.value,'Sample class');assert.equal(f.profile.fields.contact_permission.checked,false);assert.equal(f.profile.hidden,false);
 assert.equal(f.calls.factory[0].args[2].auth.persistSession,false);assert.equal(f.calls.factory[0].args[2].auth.storageKey,'creek-app-connection-v1');assert.equal(f.calls.factory[0].args[2].auth.detectSessionInUrl,false);
});
test('profile read failure prevents accidental blank overwrite and offers retry',async()=>{
 const f=fixture({rpc:async()=>({error:{message:'Synthetic read failure'}})});await f.flush();f.fill();await f.profile.emit('submit');assert.equal(f.calls.rpc.length,1);assert.equal(f.profile.hidden,true);assert.equal(f.nodes.retry.hidden,false);
});
test('saving requires consent and a phone for phone/text; confirmed response alone shows receipt',async()=>{
 const f=fixture();await f.flush();f.profile.fields.first_name.value='Sample';await f.profile.emit('submit');assert.equal(f.calls.rpc.length,1);
 f.profile.fields.contact_permission.checked=true;f.profile.fields.preferred_contact.value='text';await f.profile.emit('submit');assert.equal(f.calls.rpc.length,1);
 f.profile.fields.preferred_contact.value='email';await f.profile.emit('submit');assert.equal(f.calls.rpc.length,2);assert.equal(f.calls.rpc[1].name,'save_app_connection');assert.equal(f.calls.rpc[1].payload.p_last_name,'');assert.equal(f.calls.rpc[1].payload.p_contact_permission,true);assert.match(f.nodes.status.textContent,/submitted for staff review/);assert.match(f.nodes.status.textContent,/does not mean someone has contacted/);assert.equal(f.profile.fields.contact_permission.checked,false);
});
test('failed or empty save results preserve entries without claiming success',async()=>{
 for(const saveResult of [{data:null,error:null},{error:{message:'Synthetic write failure'}},{data:{id:'not-a-record',version:1},error:null}]){
  const f=fixture({rpc:async name=>name==='get_my_app_connection'?{data:null,error:null}:saveResult});await f.flush();f.fill();await f.profile.emit('submit');assert.match(f.nodes.status.textContent,/could not confirm/);assert.equal(f.profile.fields.first_name.value,'Sample');assert.equal(f.nodes.retry.hidden,false);
 }
});
test('sign out clears the profile immediately and ignores a late own-profile response',async()=>{
 const pending=deferred();const f=fixture({rpc:()=>pending.promise});await f.flush();await f.nodes.signout.emit('click');pending.resolve({data:{first_name:'Late private sample',email:ownUser.email},error:null});await f.flush();assert.equal(f.profile.fields.first_name.value,'');assert.equal(f.nodes['verified-email'].textContent,'');assert.equal(f.nodes.account.hidden,true);assert.equal(f.profile.hidden,true);assert.match(f.nodes.status.textContent,/Signed out/);assert.deepEqual(f.calls.signout,[{scope:'local'}]);
});
test('a stale save cannot restore a signed-out success message or form',async()=>{
 const pending=deferred();const f=fixture({rpc:name=>name==='get_my_app_connection'?Promise.resolve({data:null,error:null}):pending.promise});await f.flush();f.fill();const submission=f.profile.emit('submit');await new Promise(r=>setTimeout(r,0));await f.nodes.signout.emit('click');pending.resolve({data:saved,error:null});await submission;assert.match(f.nodes.status.textContent,/Signed out/);assert.equal(f.profile.fields.first_name.value,'');assert.equal(f.profile.hidden,true);
});
test('implicit callback is stripped before SDK use and verified through Auth getUser',async()=>{
 const f=fixture({url:'https://church.example.invalid/connection.html#access_token=synthetic-access&refresh_token=synthetic-refresh&token_type=bearer&type=magiclink'});await f.flush();assert.equal(f.calls.factory[0].hash,'');assert.equal(f.calls.setSession.length,1);assert.equal(f.doc.defaultView.location.hash,'');assert.equal(f.profile.hidden,false);
});
test('a refreshed token for the same user does not erase unfinished form values',async()=>{
 const f=fixture();await f.flush();f.fill();f.event('TOKEN_REFRESHED',{...session,access_token:'synthetic-refreshed'});await f.flush();assert.equal(f.profile.fields.first_name.value,'Sample');assert.equal(f.profile.fields.contact_permission.checked,true);f.app.destroy();assert.equal(f.profile.fields.first_name.value,'');assert.equal(f.calls.unsubscribed,1);
});
