import test from 'node:test';
import assert from 'node:assert/strict';
import { createWelcomeHandler,resolveServiceKey,welcomeMessage,officeNoticeMessage,WELCOME_VERSION,NOTICE_VERSION } from './handler.mjs';
const ORIGIN='https://app.bluffcreekbaptistchurch.org';
const USER='00000000-0000-4000-8000-000000000001';
const JOB='00000000-0000-4000-8000-000000000010';
const LEASE='00000000-0000-4000-8000-000000000020';
const PROVIDER_ID='00000000-0000-4000-8000-000000000030';
const NOW=new Date('2026-09-09T21:00:00Z');
const baseJob={id:JOB,lease_token:LEASE,recipient:'fixture@example.invalid',first_name:'Sample',template_version:WELCOME_VERSION,first_attempt_at:NOW.toISOString(),attempts:1};
const serviceKey='test.service.key',resendKey='re_fixture',jobSecret='a'.repeat(48);
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function fixture(options={}){
 const calls=[];
 const fetcher=async(url,init)=>{
  calls.push({url,init,body:init.body?JSON.parse(init.body):null});
  if(url.endsWith('/auth/v1/user'))return options.auth?options.auth():json({id:USER,is_anonymous:false,email_confirmed_at:null});
  if(url.endsWith('/claim_app_welcome_jobs'))return options.claim?options.claim():json(options.jobs||[baseJob]);
  if(url.endsWith('/claim_app_staff_notice_jobs'))return options.noticeClaim?options.noticeClaim():json(options.notices||[]);
  if(url.endsWith('/finish_app_staff_notice_job'))return json({id:JSON.parse(init.body).p_id,status:JSON.parse(init.body).p_status});
  if(url.endsWith('/finish_app_welcome_job'))return options.finish?options.finish():json({id:JOB,status:JSON.parse(init.body).p_status});
  if(url==='https://api.resend.com/emails')return options.provider?options.provider():json({id:PROVIDER_ID});
  throw new Error('Unexpected destination');
 };
 const handle=createWelcomeHandler({projectURL:'https://fixture.supabase.co',publishableKey:'sb_publishable_fixture',serviceKey,resendKey,jobSecret,fetcher,now:()=>NOW,timeoutMs:options.timeoutMs||50,...options.config});
 const invoke=async({origin=ORIGIN,body={},headers={},method='POST',path=''}={})=>{
  const h={'Content-Type':'application/json',Authorization:'Bearer fixture.user.jwt',...headers};if(origin!==null)h.Origin=origin;
  const response=await handle(new Request('https://fixture.supabase.co/functions/v1/welcome-dispatch'+path,{method,headers:h,...(!['GET','HEAD'].includes(method)?{body:JSON.stringify(body)}:{})}));
  return {response,body:response.status===204?null:await response.json()};
 };
 return{calls,invoke,handle};
}

test('real user identity scopes worker to one own pending welcome; email confirmation is not required',async()=>{
 const f=fixture();const r=await f.invoke();assert.equal(r.response.status,200);assert.deepEqual(r.body,{status:'processed',sent:1,queued:0,needs_attention:0,office_notifications:{sent:0,queued:0,needs_attention:0}});
 assert.deepEqual(f.calls.find(x=>x.url.endsWith('/claim_app_welcome_jobs')).body,{p_scope_user_id:USER,p_limit:1});
 const send=f.calls.find(x=>x.url==='https://api.resend.com/emails');assert.deepEqual(send.body.to,['fixture@example.invalid']);assert.equal(send.init.headers['Idempotency-Key'],WELCOME_VERSION+'/'+JOB);assert.equal(send.init.redirect,'error');assert.equal(send.init.credentials,'omit');
 const done=f.calls.find(x=>x.url.endsWith('/finish_app_welcome_job')).body;assert.equal(done.p_provider_id,PROVIDER_ID);assert.equal(done.p_status,'sent');
 assert.equal(r.response.headers.get('Cache-Control'),'no-store');assert.doesNotMatch(JSON.stringify(r.body),/fixture|recipient|lease|token|first_name/);
});
test('only a no-origin scheduler with the separate exact secret can claim a batch',async()=>{
 const f=fixture({jobs:[]});const r=await f.invoke({origin:null,headers:{'x-creek-job-secret':jobSecret,Authorization:''}});assert.equal(r.response.status,200);
 assert.equal(f.calls.some(x=>x.url.endsWith('/auth/v1/user')),false);assert.deepEqual(f.calls[0].body,{p_scope_user_id:null,p_limit:3});
 for(const [origin,secret] of [[ORIGIN,jobSecret],[null,'b'.repeat(48)]]){const bad=fixture();assert.equal((await bad.invoke({origin,headers:{'x-creek-job-secret':secret}})).response.status,401);assert.equal(bad.calls.length,0);}
});
test('untrusted origins, malformed auth, anonymous and banned users cannot send',async()=>{
 const f=fixture();assert.equal((await f.invoke({origin:'https://evil.invalid'})).response.status,403);assert.equal(f.calls.length,0);
 for(const token of ['', 'Bearer sb_publishable_fixture','Bearer invalid']){const bad=fixture();assert.equal((await bad.invoke({headers:{Authorization:token}})).response.status,401);assert.equal(bad.calls.length,0);}
 for(const user of [{id:USER,is_anonymous:true},{id:USER,deleted_at:NOW.toISOString()},{id:USER,banned_until:'2026-09-10T00:00:00Z'},{id:'malformed'}]){const bad=fixture({auth:()=>json(user)});assert.equal((await bad.invoke()).response.status,401);assert.equal(bad.calls.length,1);}
});
test('request never accepts recipient, content, job or user selection from the client',async()=>{
 for(const body of [{to:'other@example.invalid'},{p_scope_user_id:USER},{job_id:JOB},{html:'<h1>spam</h1>'},[],null]){const f=fixture();assert.equal((await f.invoke({body})).response.status,400);assert.equal(f.calls.length,0);}
 const f=fixture();assert.equal((await f.invoke({body:{extra:'x'.repeat(1000)}})).response.status,400);assert.equal(f.calls.length,0);
});
test('missing or incorrect environment fails closed without upstream requests',async()=>{
 for(const config of [{resendKey:''},{serviceKey:'sb_publishable_wrong'},{jobSecret:'short'},{projectURL:'https://evil.invalid'},{projectURL:'https://fixture.supabase.co/path'},{allowedOrigin:'*'}]){const f=fixture({config});assert.equal((await f.invoke()).response.status,config.allowedOrigin ? 403 : 503);assert.equal(f.calls.length,0);}
});
test('CORS preflight is exact and never authorizes the scheduler header',async()=>{
 const f=fixture();const response=await f.handle(new Request('https://fixture.supabase.co/functions/v1/welcome-dispatch',{method:'OPTIONS',headers:{Origin:ORIGIN}}));assert.equal(response.status,204);assert.equal(response.headers.get('Access-Control-Allow-Origin'),ORIGIN);assert.doesNotMatch(response.headers.get('Access-Control-Allow-Headers'),/job-secret/);assert.equal(f.calls.length,0);
});
test('fixed welcome has no prayer/profile notes, escapes names and keeps payload stable across lease retries',()=>{
 const first=welcomeMessage({...baseJob,first_name:'<script> & "guest"',prayer:'PRIVATE REQUEST',staff_notes:'PRIVATE NOTES'});
 const next=welcomeMessage({...baseJob,first_name:'<script> & "guest"',lease_token:'00000000-0000-4000-8000-000000000021',attempts:2});assert.deepEqual(first,next);assert.match(first.html,/&lt;script&gt;/);assert.doesNotMatch(first.html,/<script>|PRIVATE/);assert.match(first.text,/does not enroll/);
 for(const recipient of ['a@example.invalid\nBcc:x@example.invalid','a@b','<a@example.invalid>'])assert.throws(()=>welcomeMessage({...baseJob,recipient}),/invalid_job/);
});
test('provider acceptance plus failed finish never lies about a recorded send; retry retains idempotency',async()=>{
 const f=fixture({finish:()=>json({code:'40001'},409)});const r=await f.invoke();assert.equal(r.body.sent,0);assert.equal(r.body.queued,1);assert.equal(f.calls.filter(x=>x.url==='https://api.resend.com/emails').length,1);
 const g=fixture({jobs:[{...baseJob,attempts:2,first_attempt_at:'2026-09-09T20:59:00Z'}]});await g.invoke();assert.equal(f.calls.find(x=>x.url==='https://api.resend.com/emails').init.headers['Idempotency-Key'],g.calls.find(x=>x.url==='https://api.resend.com/emails').init.headers['Idempotency-Key']);
});
test('uncertain network and rate errors remain queued using safe fixed codes',async()=>{
 for(const [provider,code] of [[()=>{throw new Error('private token body')},'delivery_uncertain'],[()=>json({message:'private'},429),'provider_rate_limited'],[()=>json({message:'private'},500),'provider_unavailable'],[()=>json({id:'not-an-id'}),'provider_invalid_response']]){const f=fixture({provider});const r=await f.invoke();assert.equal(r.body.queued,1);const finish=f.calls.at(-1).body;assert.equal(finish.p_status,'retry');assert.equal(finish.p_error_code,code);assert.doesNotMatch(JSON.stringify(finish),/private token|private"/);}
});
test('configuration, invalid recipients and mismatched payload require attention',async()=>{
 for(const [status,body,code] of [[401,{},'provider_configuration'],[422,{},'provider_rejected'],[409,{name:'invalid_idempotent_request'},'idempotency_conflict']]){const f=fixture({provider:()=>json(body,status)});const r=await f.invoke();assert.equal(r.body.needs_attention,1);assert.equal(f.calls.at(-1).body.p_error_code,code);}
});
test('a provider timeout is bounded and retains the original job for a deduplicated retry',async()=>{
 const f=fixture({provider:()=>new Promise(()=>{}),timeoutMs:5});const r=await f.invoke();assert.equal(r.body.queued,1);assert.equal(f.calls.at(-1).body.p_error_code,'provider_timeout');
});
test('23-hour or malformed first-attempt window never makes a blind new provider request',async()=>{
 for(const first_attempt_at of ['2026-09-08T22:00:00Z','invalid','2026-09-10T21:00:00Z']){const f=fixture({jobs:[{...baseJob,first_attempt_at}]});const r=await f.invoke();assert.equal(r.body.needs_attention,1);assert.equal(f.calls.some(x=>x.url==='https://api.resend.com/emails'),false);assert.equal(f.calls.at(-1).body.p_error_code,'retry_window_expired');}
});
test('claim failure, excess jobs or invalid payload cannot turn into arbitrary emails',async()=>{
 for(const options of [{claim:()=>json({error:'secret'},500)},{jobs:[baseJob,baseJob]},{jobs:[{...baseJob,recipient:'bad'}]}]){const f=fixture(options);const r=await f.invoke();assert.equal(r.body.sent||0,0);assert.equal(f.calls.some(x=>x.url==='https://api.resend.com/emails'),false);assert.doesNotMatch(JSON.stringify(r.body),/secret|fixture|recipient/);}
});
test('Auth failures never expose raw upstream error data',async()=>{
 const f=fixture({auth:()=>json({message:'PRIVATE email/token'},500)});const r=await f.invoke();assert.deepEqual(r.body,{error:'sign_in_required'});assert.equal(f.calls.length,1);
});

const noticeJob={...baseJob,id:'00000000-0000-4000-8000-000000000040',template_version:NOTICE_VERSION,task_id:'00000000-0000-4000-8000-000000000050',task_kind:'prayer_care',recipient:'office@example.invalid'};
test('both queues are scoped by authenticated submitter; staff notices never count as guest welcome',async()=>{
 const f=fixture({jobs:[],notices:[noticeJob]});const r=await f.invoke();assert.equal(r.body.sent,0);assert.equal(r.body.office_notifications.sent,1);
 assert.deepEqual(f.calls.find(x=>x.url.endsWith('/claim_app_staff_notice_jobs')).body,{p_scope_user_id:USER,p_limit:2});
 const send=f.calls.find(x=>x.url==='https://api.resend.com/emails');assert.equal(send.init.headers['Idempotency-Key'],NOTICE_VERSION+'/'+noticeJob.id);assert.deepEqual(send.body.to,['office@example.invalid']);assert.match(send.body.text,/admin\/#intake/);assert.doesNotMatch(send.body.text,/Sample|prayer_care|00000000/);
});
test('one queue outage does not block the other queue and does not claim lost work succeeded',async()=>{
 const a=fixture({noticeClaim:()=>json({error:'private'},500)});const ar=await a.invoke();assert.equal(ar.body.sent,1);assert.equal(ar.body.office_notifications.unavailable,true);
 const b=fixture({claim:()=>json({error:'private'},500),notices:[noticeJob]});const br=await b.invoke();assert.equal(br.response.status,503);assert.equal(br.body.office_notifications.sent,1);assert.equal(br.body.error,'welcome_queued');
});
test('staff notice contains no source details and uses immutable versioned content',()=>{
 const a=officeNoticeMessage({...noticeJob,request_text:'PRIVATE',first_name:'PRIVATE',contact_text:'PRIVATE'});
 const b=officeNoticeMessage({...noticeJob,lease_token:JOB,attempts:10});assert.deepEqual(a,b);assert.doesNotMatch(JSON.stringify(a),/PRIVATE|prayer_care/);
 assert.throws(()=>officeNoticeMessage({...noticeJob,task_kind:'broadcast'}),/invalid_job/);
 assert.throws(()=>welcomeMessage({...baseJob,template_version:'changed'}),/invalid_job/);
 assert.throws(()=>officeNoticeMessage({...noticeJob,template_version:'changed'}),/invalid_job/);
});

test('final counts reflect a retry that the database moves to attention at the retry deadline',async()=>{
 const f=fixture({provider:()=>json({},500),finish:()=>json({id:JOB,status:'attention'})});const r=await f.invoke();assert.equal(r.body.queued,0);assert.equal(r.body.needs_attention,1);
});

test('runtime prefers only the modern default service key and safely falls back to a legacy JWT',()=>{
 const modern='sb_secret_fixture_default';
 assert.equal(resolveServiceKey(JSON.stringify({other:'sb_secret_other',default:modern}),serviceKey),modern);
 assert.equal(resolveServiceKey(JSON.stringify({default:modern}),undefined),modern);
 for(const raw of [undefined,'', '{broken', 'null', '[]', '"sb_secret_fixture"', '{}',
   JSON.stringify({other:modern}), JSON.stringify({__proto__:null}),
   '{"__proto__":{"default":"sb_secret_fixture"}}',
   JSON.stringify({default:'sb_publishable_fixture'}),JSON.stringify({default:serviceKey}),
   JSON.stringify({default:{value:modern}}),JSON.stringify({default:modern+'\n'}),
   JSON.stringify({default:modern,padding:'x'.repeat(16384)})]) {
  assert.equal(resolveServiceKey(raw,serviceKey),serviceKey);
  assert.equal(resolveServiceKey(raw,undefined),undefined);
 }
 for(const invalid of ['sb_publishable_fixture','sb_secret_fixture','missing','test.service.key\n',{},null]) {
  assert.equal(resolveServiceKey('{}',invalid),undefined);
 }
});

test('modern service key sends both queue RPCs only through apikey while user and provider authentication stay separate',async()=>{
 const modern='sb_secret_fixture_default';
 const f=fixture({notices:[noticeJob],config:{serviceKey:resolveServiceKey(JSON.stringify({default:modern}),undefined)}});
 const r=await f.invoke();assert.equal(r.response.status,200);assert.equal(r.body.sent,1);assert.equal(r.body.office_notifications.sent,1);
 const auth=f.calls.find(x=>x.url.endsWith('/auth/v1/user'));
 assert.deepEqual(auth.init.headers,{apikey:'sb_publishable_fixture',Authorization:'Bearer fixture.user.jwt'});
 const rpcs=f.calls.filter(x=>x.url.includes('/rest/v1/rpc/'));assert.equal(rpcs.length,4);
 for(const rpc of rpcs){assert.equal(rpc.init.headers.apikey,modern);assert.equal(Object.hasOwn(rpc.init.headers,'Authorization'),false);}
 for(const send of f.calls.filter(x=>x.url==='https://api.resend.com/emails')){assert.equal(send.init.headers.Authorization,'Bearer '+resendKey);assert.equal(Object.hasOwn(send.init.headers,'apikey'),false);}
 assert.doesNotMatch(JSON.stringify(r.body),/sb_secret|fixture|recipient|token/);
});

test('modern service key scheduler still needs the exact separate secret and never impersonates a user',async()=>{
 const config={serviceKey:'sb_secret_fixture_default'};
 const f=fixture({jobs:[],config});const r=await f.invoke({origin:null,headers:{'x-creek-job-secret':jobSecret,Authorization:''}});
 assert.equal(r.response.status,200);assert.equal(f.calls.length,2);
 for(const call of f.calls){assert.equal(call.body.p_scope_user_id,null);assert.equal(call.body.p_limit,3);assert.equal(call.init.headers.apikey,config.serviceKey);assert.equal(Object.hasOwn(call.init.headers,'Authorization'),false);}
 for(const options of [{origin:null,headers:{'x-creek-job-secret':'b'.repeat(48)}},{headers:{'x-creek-job-secret':jobSecret}},{headers:{Authorization:'Bearer sb_secret_fixture_default'}}]){
  const bad=fixture({config});assert.equal((await bad.invoke(options)).response.status,401);assert.equal(bad.calls.length,0);
 }
});

test('legacy RPC header behavior remains valid and unusable service credentials cannot make upstream requests',async()=>{
 const f=fixture();assert.equal((await f.invoke()).response.status,200);
 for(const call of f.calls.filter(x=>x.url.includes('/rest/v1/rpc/'))){assert.equal(call.init.headers.apikey,serviceKey);assert.equal(call.init.headers.Authorization,'Bearer '+serviceKey);}
 for(const invalid of [undefined,'sb_secret_','sb_secret_fixture\n','sb_publishable_fixture','test.service.key\n','x'.repeat(16385)]){
  const bad=fixture({config:{serviceKey:invalid}});const r=await bad.invoke();assert.equal(r.response.status,503);assert.deepEqual(r.body,{error:'welcome_unavailable'});assert.equal(bad.calls.length,0);
 }
});
