/* No environment reads, secrets, recipient data or provider responses are logged. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s<>@\x00-\x1f\x7f]+@[^\s<>@\x00-\x1f\x7f]+\.[^\s<>@\x00-\x1f\x7f]+$/;
const PROVIDER = 'https://api.resend.com/emails';
const APP = 'https://app.bluffcreekbaptistchurch.org/';
const FROM = 'Bluff Creek Baptist Church <office@auth.bluffcreekbaptistchurch.org>';
const REPLY = 'bluffcreekbaptist@gmail.com';
export const WELCOME_VERSION = 'creek-welcome-v1';
export const NOTICE_VERSION = 'creek-office-notice-v1';
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function welcomeMessage(job) {
  if (!job || job.template_version !== WELCOME_VERSION || !UUID.test(job.id) || !UUID.test(job.lease_token) || typeof job.recipient !== 'string' || job.recipient.length > 320 || !EMAIL.test(job.recipient) || typeof job.first_name !== 'string' || job.first_name.length > 100 || /[\x00-\x1f\x7f]/.test(job.first_name)) throw new Error('invalid_job');
  const greeting = job.first_name.trim() ? 'Hi ' + job.first_name.trim() + ',' : 'Welcome,';
  const text = `${greeting}\n\nWelcome to the Creek. We’re glad you connected with Bluff Creek Baptist Church.\n\nOur church team will review your connection and help you take your next step. You’re welcome to join us for Sunday School at 9:00 a.m. and worship at 10:15 a.m. at 1706 Highway 63, Clinton, Louisiana.\n\nOpen the Creek app for our sermon guide, worship playlist and recommended books: ${APP}\n\nHave a question? Reply to this email. We’d love to hear from you.\n\nBluff Creek Baptist Church\nRooted in the Word. Growing together.\n\nThis one-time welcome was sent because this address was entered during app registration. It does not enroll you in newsletters or mass messages. If you did not register, no action is needed.\n`;
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#f6f2e9;color:#24372a;font-family:Arial,sans-serif"><main style="max-width:560px;margin:24px auto;background:#fff;padding:32px;border-top:6px solid #3c5a45"><p style="letter-spacing:2px;font-size:12px;color:#3c5a45">BLUFF CREEK BAPTIST CHURCH</p><h1 style="font-family:Georgia,serif;font-size:32px">Welcome to the Creek.</h1><p>${escapeHTML(greeting)}</p><p style="line-height:1.65">We’re glad you connected with Bluff Creek Baptist Church. Our church team will review your connection and help you take your next step.</p><p style="line-height:1.65">Join us for <strong>Sunday School at 9:00 a.m.</strong> and <strong>worship at 10:15 a.m.</strong><br>1706 Highway 63 · Clinton, Louisiana</p><p style="line-height:1.65">Find our sermon guide, worship playlist and recommended books in the app.</p><p><a href="${APP}" style="display:inline-block;background:#3c5a45;color:white;padding:14px 22px;text-decoration:none;border-radius:6px">Open the Creek app</a></p><p style="line-height:1.65">Have a question? Reply to this email. We’d love to hear from you.</p><p style="font-family:Georgia,serif">Rooted in the Word. Growing together.</p><hr style="border:0;border-top:1px solid #e8e3d8"><p style="font-size:12px;line-height:1.5;color:#5f685f">This one-time welcome was sent because this address was entered during app registration. It does not enroll you in newsletters or mass messages. If you did not register, no action is needed.</p></main></body></html>`;
  return {from:FROM,to:[job.recipient],reply_to:REPLY,subject:'Welcome to the Creek',text,html};
}

export function officeNoticeMessage(job) {
  if (!job || job.template_version !== NOTICE_VERSION || !UUID.test(job.id) || !UUID.test(job.lease_token) || !UUID.test(job.task_id) || !['guest_followup','prayer_care'].includes(job.task_kind) || typeof job.recipient !== 'string' || job.recipient.length > 320 || !EMAIL.test(job.recipient)) throw new Error('invalid_job');
  // Keep v1 bytes stable for retries. This email intentionally contains no name,
  // contact details, prayer text, private note, account identifier or task URL.
  const link = APP + 'admin/#intake';
  const text = `A new private follow-up is ready in Creek Office.\n\nOpen Intake actions to review the item, check the assigned owner and record the next step: ${link}\n\nSign in with your approved Office account. This notice contains no guest or prayer details.\n\nBluff Creek Baptist Church\n`;
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#f6f2e9;color:#24372a;font-family:Arial,sans-serif"><main style="max-width:560px;margin:24px auto;background:#fff;padding:32px;border-top:6px solid #3c5a45"><p style="letter-spacing:2px;font-size:12px">CREEK OFFICE</p><h1 style="font-family:Georgia,serif;font-size:28px">A follow-up is ready.</h1><p style="line-height:1.65">Open Intake actions to review the item, check the assigned owner and record the next step.</p><p><a href="${link}" style="display:inline-block;background:#3c5a45;color:white;padding:14px 22px;text-decoration:none;border-radius:6px">Open Creek Office</a></p><p style="font-size:13px;line-height:1.5">Sign in with your approved Office account. This notice contains no guest or prayer details.</p></main></body></html>`;
  return {from:FROM,to:[job.recipient],reply_to:REPLY,subject:'A follow-up is ready in Creek Office',text,html};
}

function validProject(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && /^[a-z0-9-]+\.supabase\.co$/.test(u.hostname) && !u.username && !u.password && !u.port && u.pathname === '/' && !u.search && !u.hash ? u.origin : null; } catch { return null; }
}
function equalSecret(a,b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || b.length < 32 || b.length > 256) return false;
  let difference=0;for(let i=0;i<a.length;i++)difference |= a.charCodeAt(i)^b.charCodeAt(i);return difference===0;
}
async function limitedJSON(response,limit=16384) {
  if (!response.body) throw new Error('invalid_response');
  const reader=response.body.getReader();let total=0,value='';const decoder=new TextDecoder('utf-8',{fatal:true});
  try { while(true){const {done,value:chunk}=await reader.read();if(done)break;total+=chunk.byteLength;if(total>limit){await reader.cancel();throw new Error('invalid_response');}value+=decoder.decode(chunk,{stream:true});}return JSON.parse(value+decoder.decode()); }
  finally{reader.releaseLock();}
}

/**
 * Injected fetcher in tests; runtime entry provides only server-side secrets.
 * @param {{projectURL?:string,publishableKey?:string,serviceKey?:string,resendKey?:string,jobSecret?:string,allowedOrigin?:string,fetcher?:typeof fetch,now?:()=>Date,timeoutMs?:number}} options
 * @returns {(request:Request)=>Promise<Response>}
 */
export function createWelcomeHandler({projectURL,publishableKey,serviceKey,resendKey,jobSecret,allowedOrigin=APP.slice(0,-1),fetcher=fetch,now=()=>new Date(),timeoutMs=8000}={}) {
  const project=validProject(projectURL),timeout=Math.max(1,Math.min(8000,Number(timeoutMs)||8000));
  const ready=!!(project && typeof publishableKey==='string' && /^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey) && typeof serviceKey==='string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(serviceKey) && typeof resendKey==='string' && /^re_[A-Za-z0-9_-]+$/.test(resendKey) && typeof jobSecret==='string' && /^[A-Za-z0-9_-]{32,256}$/.test(jobSecret) && allowedOrigin===APP.slice(0,-1));
  function respond(body,status,origin) { return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin',...(origin===allowedOrigin?{'Access-Control-Allow-Origin':origin}: {})}}); }
  async function requestJSON(url,options,limit=16384) {
    const abort=new AbortController();let timer;
    const request=(async()=>{const response=await fetcher(url,{...options,redirect:'error',signal:abort.signal,credentials:'omit'});if(response.redirected)throw new Error('invalid_response');return {ok:response.ok,status:response.status,data:await limitedJSON(response,limit)};})();
    try { return await Promise.race([request,new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new Error('timeout'));},timeout);})]); }
    finally{clearTimeout(timer);}
  }
  async function rpc(name,body) {
    const result=await requestJSON(project+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:serviceKey,Authorization:'Bearer '+serviceKey,'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!result.ok)throw new Error('database_unavailable');return result.data;
  }
  async function finish(job,status,providerId,errorCode,kind) {
    const receipt=await rpc(kind==='notice'?'finish_app_staff_notice_job':'finish_app_welcome_job',{p_id:job.id,p_lease_token:job.lease_token,p_status:status,p_provider_id:providerId,p_error_code:errorCode});
    if(!receipt || receipt.id!==job.id || !['sent','retry','attention'].includes(receipt.status) || (receipt.status!==status && !(status==='retry' && receipt.status==='attention')))throw new Error('invalid_finish');
    return receipt.status;
  }
  async function processJob(job,kind) {
    let payload;try{payload=kind==='notice'?officeNoticeMessage(job):welcomeMessage(job);}catch{if(job && UUID.test(job.id)&&UUID.test(job.lease_token)){try{await finish(job,'attention',null,'invalid_job',kind);}catch{}}return 'attention';}
    const first=Date.parse(job.first_attempt_at),age=now().getTime()-first;
    if(!Number.isFinite(first)||age< -60000||age>=23*60*60*1000){try{await finish(job,'attention',null,'retry_window_expired',kind);}catch{}return 'attention';}
    let status='retry',providerId=null,errorCode='provider_unavailable';
    try{
      const response=await requestJSON(PROVIDER,{method:'POST',headers:{Authorization:'Bearer '+resendKey,'Content-Type':'application/json','Idempotency-Key':job.template_version+'/'+job.id},body:JSON.stringify(payload)},4096);
      if(response.ok && UUID.test(response.data?.id)){status='sent';providerId=response.data.id;errorCode=null;}
      else if(response.ok){errorCode='provider_invalid_response';}
      else if([401,403].includes(response.status)){status='attention';errorCode='provider_configuration';}
      else if(response.status===409 && response.data?.name==='invalid_idempotent_request'){status='attention';errorCode='idempotency_conflict';}
      else if(response.status===429){errorCode='provider_rate_limited';}
      else if(response.status===409 || response.status>=500){errorCode='provider_unavailable';}
      else{status='attention';errorCode='provider_rejected';}
    }catch(error){errorCode=error?.message==='timeout'?'provider_timeout':'delivery_uncertain';}
    try{return await finish(job,status,providerId,errorCode,kind);}catch{return 'retry';}
  }
  async function processQueue(scope,kind,limit) {
    const jobs=await rpc(kind==='notice'?'claim_app_staff_notice_jobs':'claim_app_welcome_jobs',{p_scope_user_id:scope,p_limit:limit});
    if(!Array.isArray(jobs)||jobs.length>limit)throw new Error('invalid_jobs');
    const results=await Promise.all(jobs.map(job=>processJob(job,kind)));
    return {sent:results.filter(x=>x==='sent').length,queued:results.filter(x=>x==='retry').length,needs_attention:results.filter(x=>x==='attention').length};
  }
  return async function handle(request) {
    const origin=request.headers.get('Origin');
    if(origin && origin!==allowedOrigin)return respond({error:'origin_not_allowed'},403,null);
    if(request.method==='OPTIONS')return new Response(null,{status:origin===allowedOrigin?204:403,headers:{'Vary':'Origin','Cache-Control':'no-store',...(origin===allowedOrigin?{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Max-Age':'600'}:{})}});
    if(request.method!=='POST')return respond({error:'method_not_allowed'},405,origin);
    if(!ready)return respond({error:'welcome_unavailable'},503,origin);
    if(new URL(request.url).search || !request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))return respond({error:'invalid_request'},400,origin);
    let timer;
    try { const body=await Promise.race([limitedJSON(request,512),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),2000);})]);if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).length)return respond({error:'invalid_request'},400,origin); }
    catch{return respond({error:'invalid_request'},400,origin);}finally{clearTimeout(timer);}
    const suppliedSecret=request.headers.get('x-creek-job-secret');let scope=null;
    if(suppliedSecret!==null){if(origin || !equalSecret(suppliedSecret,jobSecret))return respond({error:'not_authorized'},401,origin);}
    else {
      const auth=request.headers.get('Authorization')||'';
      if(!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(auth))return respond({error:'sign_in_required'},401,origin);
      try{
        const result=await requestJSON(project+'/auth/v1/user',{method:'GET',headers:{apikey:publishableKey,Authorization:auth}});
        const user=result.data;
        if(!result.ok||!UUID.test(user?.id)||user.is_anonymous===true||user.deleted_at||(user.banned_until&&Date.parse(user.banned_until)>now().getTime()))return respond({error:'sign_in_required'},401,origin);
        scope=user.id;
      }catch{return respond({error:'sign_in_required'},401,origin);}
    }
    // One queue's outage must not prevent processing the other. Top-level counts
    // always refer to guest welcome email, never to staff notifications.
    const queues=await Promise.allSettled([processQueue(scope,'welcome',scope?1:3),processQueue(scope,'notice',scope?2:3)]);
    const pending={sent:0,queued:0,needs_attention:0,unavailable:true};
    const notices=queues[1].status==='fulfilled'?queues[1].value:pending;
    if(queues[0].status==='rejected')return respond({error:'welcome_queued',office_notifications:notices},503,origin);
    return respond({status:'processed',...queues[0].value,office_notifications:notices},200,origin);
  };
}
