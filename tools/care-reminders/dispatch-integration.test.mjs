import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setup} from './server-test-support.mjs';
import {createCareReminderHandler} from '../../supabase/functions/care-reminder-dispatch/handler.mjs';
const NOW='2026-09-12T15:00:00Z', secret='a'.repeat(64);
const response=(data,status=200)=>new Response(JSON.stringify(data),{status});
const request=()=>new Request('https://worker.example.invalid/',{method:'POST',headers:{'Content-Type':'application/json','X-Creek-Care-Job-Key':secret},body:'{}'});
function integrated(f,{provider=()=>response({id:randomUUID()}),beforeClaim,now=NOW}={}) {
 const sends=[];
 const fetcher=async(url,init)=>{
  const b=JSON.parse(init.body);
  if(url==='https://api.resend.com/emails'){sends.push(b);return provider(b);}
  let fn,args;
  if(url.endsWith('/enqueue_care_reminders')){fn='enqueue_care_reminders_at';args=[now];}
  else if(url.endsWith('/claim_care_reminder_jobs')){if(beforeClaim)await beforeClaim();fn='claim_care_reminder_jobs_at';args=[b.p_limit,now];}
  else if(url.endsWith('/finish_care_reminder_job')){fn='finish_care_reminder_job_at';args=[b.p_id,b.p_lease_token,b.p_status,b.p_provider_id,b.p_error_code,now];}
  else throw new Error('Unexpected endpoint');
  const [row]=await f.rows('select private.'+fn+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') result',args);return response(row.result);
 };
 return {sends,handler:createCareReminderHandler({projectURL:'https://xzfeumdonxeodqhfirjr.supabase.co',serviceKey:'sb_secret_synthetic',resendKey:'re_synthetic',jobSecret:secret,fetcher,now:()=>new Date(now)})};
}

test('actual care history/binding/queue feeds worker; recorded contact suppresses the next digest',async t=>{
 const f=await setup(t,{queue:true});
 const care=await f.makeCare({plan:{started_on:'2026-08-01',first_due_on:'2026-09-09',cadence_months:3}});
 await f.bind('care_plan',care.plan.id);await f.configure();
 const flow=integrated(f);const result=await(await flow.handler(request())).json();assert.equal(result.accepted,2);assert.equal(result.unconfirmed,0);
 assert.deepEqual(flow.sends.map(x=>x.to[0]).sort(),['admin@example.invalid','editor@example.invalid']);
 assert.equal((await f.rows("select count(*)::int n from private.care_reminder_jobs where status='accepted'"))[0].n,2);
 assert.equal((await(await flow.handler(request())).json()).accepted,0);assert.equal(flow.sends.length,2);
 await f.addVisit(care,{contacted_on:'2026-09-12'});
 const next=integrated(f,{now:'2026-09-13T15:00:00Z'});assert.equal((await(await next.handler(request())).json()).accepted,0);assert.equal(next.sends.length,0);
});

test('actual guest removal after enqueue and before claim cancels reminder without changing original welcome receipts',async t=>{
 const f=await setup(t,{queue:true}),registration=await f.reg();let task=await f.taskFor(registration.id);
 await f.rpc('admin','update_intake_task',[task.id,task.version,{assigned_staff_user_id:f.ids.editor,due_on:'2026-09-09'}]);
 task=await f.taskFor(registration.id);await f.bind('guest_task',task.id);await f.configure();let changed=false;
 const flow=integrated(f,{beforeClaim:async()=>{if(!changed){await f.change(registration.id);changed=true;}}});
 const result=await(await flow.handler(request())).json();assert.equal(result.accepted,0);assert.equal(flow.sends.length,0);
 const jobs=await f.rows('select status,error_code from private.care_reminder_jobs');assert.equal(jobs.length,2);assert(jobs.every(x=>x.status==='cancelled'&&x.error_code==='source_changed'));
 assert.equal((await f.get(registration.id)).guest_removed_at!==null,true);
});

test('ambiguous mocked provider leaves a durable hold and cannot produce a later retry',async t=>{
 const f=await setup(t,{queue:true}),care=await f.makeCare({plan:{first_due_on:'2026-09-09'}});
 await f.bind('care_plan',care.plan.id);await f.configure({pastor_user_ids:[f.ids.editor]});
 const flow=integrated(f,{provider:()=>{throw new Error('synthetic transport loss');}});
 assert.equal((await(await flow.handler(request())).json()).needs_attention,1);
 const [held]=await f.rows('select * from private.care_reminder_destination_holds');assert.equal(held.active,true);
 const next=integrated(f,{now:'2026-09-13T15:00:00Z'});assert.equal((await(await next.handler(request())).json()).accepted,0);assert.equal(next.sends.length,0);
 assert.equal((await f.rows('select count(*)::int n from private.care_reminder_jobs'))[0].n,1);
});
