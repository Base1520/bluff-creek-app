import test from 'node:test';
import assert from 'node:assert/strict';
import {careMessage,createCareReminderHandler,resolveServiceKey,TEMPLATE_VERSION} from '../../supabase/functions/care-reminder-dispatch/handler.mjs';

const NOW='2026-09-12T15:00:00Z', secret='a'.repeat(64), recipient='care-owner@example.invalid';
const id='10000000-0000-4000-8000-000000000001', lease='20000000-0000-4000-8000-000000000001', providerId='30000000-0000-4000-8000-000000000001';
const job={id,lease_token:lease,recipient,provider_key:'care-'+id,template_version:TEMPLATE_VERSION,attempts:1,first_attempt_at:NOW};
const response=(data,status=200)=>new Response(JSON.stringify(data),{status});
const request=(body={},headers={},url='https://worker.example.invalid/',method='POST')=>new Request(url,{method,headers:{'Content-Type':'application/json','X-Creek-Care-Job-Key':secret,...headers},...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
function fixture({jobs=[job],provider=()=>response({id:providerId}),finish,claim,enqueue,options={}}={}) {
  const calls=[], supplied=[...jobs];
  const fetcher=async(url,init)=>{
    const body=JSON.parse(init.body); calls.push({url,init,body});
    if(url==='https://api.resend.com/emails') return provider(body,init);
    if(url.endsWith('/enqueue_care_reminders')) return enqueue?enqueue():response({status:'enqueued',enqueued:supplied.length});
    if(url.endsWith('/claim_care_reminder_jobs')) return claim?claim():response(supplied.length?[supplied.shift()]:[]);
    if(url.endsWith('/finish_care_reminder_job')) return finish?finish(body):response({id:body.p_id,status:body.p_status,version:3});
    throw new Error('Unexpected network destination');
  };
  return {calls,handler:createCareReminderHandler({projectURL:'https://xzfeumdonxeodqhfirjr.supabase.co',serviceKey:'sb_secret_synthetic',resendKey:'re_synthetic',jobSecret:secret,fetcher,now:()=>new Date(NOW),...options})};
}
const count=(f,part)=>f.calls.filter(c=>c.url.includes(part)).length;
const finishBody=f=>f.calls.find(c=>c.url.endsWith('/finish_care_reminder_job'))?.body;

test('fixed generic message excludes arbitrary job content and uses only the approved Office link',()=>{
 const message=careMessage({...job,name:'PRIVATE_NAME',notes:'PRIVATE_NOTE',url:'https://example.invalid/private',count:999});
 const content=JSON.stringify(message);assert(!content.includes('PRIVATE_'));assert(!content.includes('999'));assert(!content.includes(job.id));
 assert.deepEqual(message.to,[recipient]);assert(message.text.includes('https://app.bluffcreekbaptistchurch.org/admin/#care'));
 assert.equal(careMessage({...job,attempts:2,lease_token:providerId}).text,message.text);
 for(const change of [{recipient:'Name <x@example.invalid>'},{provider_key:'other'},{template_version:'unknown'},{attempts:0},{id:'bad'}]) assert.throws(()=>careMessage({...job,...change}),/invalid_job/);
});

test('service runtime key selection supports explicit default only',()=>{
 assert.equal(resolveServiceKey('{"default":"sb_secret_synthetic"}','a.b.c'),'sb_secret_synthetic');
 assert.equal(resolveServiceKey('{"other":"sb_secret_not_selected"}','a.b.c'),'a.b.c');
 assert.equal(resolveServiceKey('not-json','sb_secret_not_legacy'),undefined);
 assert.equal(resolveServiceKey('{"default":42}',' a.b.c '),undefined);
});

test('rejects browser, anonymous, query, method and malformed requests without any network calls',async()=>{
 for(const [req,status] of [[request({}, {Origin:'https://app.bluffcreekbaptistchurch.org'}),403],[request({}, {'X-Creek-Care-Job-Key':'bad'}),401],[request({}, {},'https://worker.example.invalid/?recipient=x'),400],[request({}, {},undefined,'GET'),405],[request({recipient}),400],[request('[]'),400],[request('null'),400],[request('x'.repeat(513)),400],[request('broken'),400],[request({}, {'Content-Type':'text/plain'}),400]]) {
  const f=fixture();const r=await f.handler(req);assert.equal(r.status,status);assert.equal(f.calls.length,0);assert.equal(r.headers.get('Access-Control-Allow-Origin'),null);
 }
});

test('missing configuration and a different project fail before claiming',async()=>{
 for(const options of [{projectURL:'https://another.supabase.co'},{jobSecret:'short'},{resendKey:''},{serviceKey:''}]) {
  const f=fixture({options});assert.equal((await f.handler(request())).status,503);assert.equal(f.calls.length,0);
 }
});

test('accepted provider response is durably finished and exposes aggregate counts only',async()=>{
 const f=fixture();const r=await f.handler(request());const result=await r.json();
 assert.equal(r.status,200);assert.deepEqual(result,{status:'processed',accepted:1,retry:0,needs_attention:0,unconfirmed:0});
 assert.deepEqual(finishBody(f),{p_id:id,p_lease_token:lease,p_status:'accepted',p_provider_id:providerId,p_error_code:null});
 assert(!JSON.stringify(result).includes(recipient));assert(!JSON.stringify(result).includes(id));
 for(const c of f.calls){assert.equal(c.init.redirect,'error');assert.equal(c.init.credentials,'omit');}
 const send=f.calls.find(c=>c.url==='https://api.resend.com/emails');assert.equal(send.init.headers['Idempotency-Key'],'care-'+id);
 assert.equal(f.calls[1].body.p_limit,1);assert.equal(r.headers.get('Cache-Control'),'no-store');
});

test('disabled or empty queue sends nothing',async()=>{
 const f=fixture({jobs:[],enqueue:()=>response({status:'paused',enqueued:0})});const result=await(await f.handler(request())).json();
 assert.equal(result.accepted,0);assert.equal(count(f,'api.resend.com'),0);
});

test('one invocation claims no more than five and claims only one before each send',async()=>{
 const f=fixture({jobs:Array.from({length:7},(_,i)=>({...job,id:`10000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,provider_key:`care-10000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`}))});
 assert.equal((await(await f.handler(request())).json()).accepted,5);assert.equal(count(f,'claim_care_reminder_jobs'),5);
 assert.deepEqual(f.calls.slice(1).map(c=>c.url.split('/').pop()),Array(5).fill(['claim_care_reminder_jobs','emails','finish_care_reminder_job']).flat());
});

for(const [status,data,expected,error] of [
 [429,{},'retry','provider_rate_limited'],[503,{},'retry','provider_unavailable'],[409,{name:'concurrent_idempotent_requests'},'retry','provider_unavailable'],
 [401,{},'failed','provider_configuration'],[403,{},'failed','provider_configuration'],[400,{},'failed','provider_rejected'],[422,{},'failed','provider_rejected'],
 [409,{name:'invalid_idempotent_request'},'failed','idempotency_conflict'],[409,{},'uncertain','delivery_uncertain'],[200,{id:'invalid'},'uncertain','provider_invalid_response']
]) test(`provider ${status}/${data.name||'response'} records ${expected} and stops before another claim`,async()=>{
 const f=fixture({jobs:[job,job],provider:()=>response(data,status)});const result=await(await f.handler(request())).json();
 assert.equal(finishBody(f).p_status,expected);assert.equal(finishBody(f).p_error_code,error);assert.equal(count(f,'claim_care_reminder_jobs'),1);assert.equal(result.accepted,0);
});

test('network ambiguity and provider redirects are held rather than retried',async()=>{
 for(const provider of [()=>{throw new Error('private transport text');},()=>new Response('',{status:302,headers:{Location:'https://example.invalid'}}),()=>new Response('malformed json',{status:200})]) {
  const f=fixture({provider});const r=await f.handler(request());const text=await r.text();
  assert.equal(finishBody(f).p_status,'uncertain');assert(!text.includes('private'));assert.equal(count(f,'claim_care_reminder_jobs'),1);
 }
});

test('provider timeout becomes uncertain and aborts its request',async()=>{
 let signal;
 const f=fixture({provider:(_body,init)=>{signal=init.signal;return new Promise(()=>{});},options:{timeoutMs:5}});
 const result=await(await f.handler(request())).json();assert.equal(result.needs_attention,1);assert.equal(finishBody(f).p_error_code,'provider_timeout');assert.equal(signal.aborted,true);
});

test('lost finish receipt never claims that delivery succeeded and stops',async()=>{
 for(const finish of [()=>response({error:'private database error'},500),()=>response({id,status:'retry',version:2})]) {
  const f=fixture({jobs:[job,job],finish});const r=await f.handler(request());assert.equal(r.status,503);
  assert.deepEqual(await r.json(),{status:'processed',accepted:0,retry:0,needs_attention:0,unconfirmed:1});assert.equal(count(f,'claim_care_reminder_jobs'),1);
 }
});

test('database retry exhaustion is a verified held failure',async()=>{
 const f=fixture({provider:()=>response({},503),finish:body=>response({id:body.p_id,status:'failed',version:9})});
 const r=await f.handler(request());assert.equal(r.status,200);
 assert.deepEqual(await r.json(),{status:'processed',accepted:0,retry:0,needs_attention:1,unconfirmed:0});
});

test('invalid jobs and expired provider retry window do not reach the provider',async()=>{
 for(const change of [{template_version:'unknown'},{first_attempt_at:'2026-09-11T15:00:00Z'},{first_attempt_at:'invalid'},{first_attempt_at:'2026-09-13T15:00:00Z'},{recipient:'bad\r\nTo: victim@example.invalid'}]) {
  const f=fixture({jobs:[{...job,...change}]});assert.equal((await(await f.handler(request())).json()).needs_attention,1);assert.equal(count(f,'api.resend.com'),0);assert.equal(finishBody(f).p_status,'failed');
 }
});

test('malformed queue replies stop without provider calls or leaked errors',async()=>{
 for(const opt of [{enqueue:()=>response({error:'private details'},500)},{claim:()=>response([job,job])},{claim:()=>response({recipient})},{claim:()=>response([{id:'bad'}])}]) {
  const f=fixture(opt);const r=await f.handler(request());assert.equal(r.status,503);assert.equal(count(f,'api.resend.com'),0);assert(!(await r.text()).includes('private details'));
 }
});

test('legacy service keys use bearer auth; modern keys stay in apikey only',async()=>{
 for(const [serviceKey,bearer] of [['a.b.c',true],['sb_secret_synthetic',false]]) {
  const f=fixture({jobs:[],options:{serviceKey}});await f.handler(request());
  assert.equal(f.calls[0].init.headers.apikey,serviceKey);assert.equal(Object.hasOwn(f.calls[0].init.headers,'Authorization'),bearer);
 }
});

test('retry uses identical key and payload across attempts',async()=>{
 const first=fixture({provider:()=>response({},503)});await first.handler(request());
 const retry=fixture({jobs:[{...job,attempts:2,lease_token:providerId}]});await retry.handler(request());
 const send=f=>f.calls.find(c=>c.url==='https://api.resend.com/emails');
 assert.equal(send(first).init.body,send(retry).init.body);
 assert.equal(send(first).init.headers['Idempotency-Key'],send(retry).init.headers['Idempotency-Key']);
});

test('oversized or never-ending provider success body cannot strand the worker',async()=>{
 const providers=[()=>response({id:providerId,padding:'x'.repeat(5000)}),()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));}}),{status:200})];
 for(const provider of providers){const f=fixture({provider,options:{timeoutMs:5}});const r=await f.handler(request());assert.equal(r.status,200);assert.equal(finishBody(f).p_status,'uncertain');}
});

test('provider ID must be a string and malformed enqueue results cannot authorize a claim',async()=>{
 for(const value of [[providerId],{id:providerId},123,null]){
  const f=fixture({provider:()=>response({id:value})});await f.handler(request());
  assert.equal(finishBody(f).p_status,'uncertain');assert.equal(finishBody(f).p_error_code,'provider_invalid_response');
 }
 for(const value of [{error:'unexpected'},{status:'enqueued',enqueued:-1},{status:'enqueued',enqueued:'2'},{status:'paused',enqueued:1}]){
  const f=fixture({enqueue:()=>response(value)});assert.equal((await f.handler(request())).status,503);assert.equal(count(f,'claim_care_reminder_jobs'),0);
 }
});
