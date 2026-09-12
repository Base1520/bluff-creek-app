// Server-only transport. No recipients, credentials, bodies or provider replies
// are logged or returned. Database claims are the only source of recipients.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s<>@\x00-\x1f\x7f]+@[^\s<>@\x00-\x1f\x7f]+\.[^\s<>@\x00-\x1f\x7f]+$/;
const PROJECT = 'https://xzfeumdonxeodqhfirjr.supabase.co';
const PROVIDER = 'https://api.resend.com/emails';
const OFFICE = 'https://app.bluffcreekbaptistchurch.org/admin/#care';
export const TEMPLATE_VERSION = 'creek-care-digest-v1';

function serviceKeyKind(value) {
  if (typeof value !== 'string' || value.length > 16384 || value.trim() !== value) return null;
  if (/^sb_secret_[A-Za-z0-9_-]+$/.test(value)) return 'modern';
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) ? 'legacy' : null;
}

export function resolveServiceKey(secretKeys, legacyKey) {
  if (typeof secretKeys === 'string' && secretKeys.length <= 16384) {
    try {
      const keys = JSON.parse(secretKeys);
      if (keys && !Array.isArray(keys) && Object.hasOwn(keys, 'default') && serviceKeyKind(keys.default) === 'modern') return keys.default;
    } catch { /* A valid legacy runtime key remains supported. */ }
  }
  return serviceKeyKind(legacyKey) === 'legacy' ? legacyKey : undefined;
}

function validJob(job) {
  return job && typeof job.id === 'string' && typeof job.lease_token === 'string' && UUID.test(job.id) && UUID.test(job.lease_token) &&
    job.template_version === TEMPLATE_VERSION && job.provider_key === 'care-' + job.id &&
    typeof job.recipient === 'string' && job.recipient.length <= 320 && EMAIL.test(job.recipient) &&
    Number.isInteger(job.attempts) && job.attempts > 0 && job.attempts <= 100;
}

export function careMessage(job) {
  if (!validJob(job)) throw new Error('invalid_job');
  // Freeze these v1 bytes for retries. Counts, names, notes and record links stay
  // in authenticated Office; nothing sensitive appears on a phone lock screen.
  const text = `Your care follow-ups need attention.\n\nSign in to Creek Office to review care plans and Intake actions, record completed contacts and choose the next step: ${OFFICE}\n\nUse your approved Office account. No member, guest or prayer details are included in this reminder.\n\nBluff Creek Baptist Church\n`;
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#f6f2e9;color:#24372a;font-family:Arial,sans-serif"><main style="max-width:560px;margin:24px auto;background:#fff;padding:32px;border-top:6px solid #3c5a45"><p style="letter-spacing:2px;font-size:12px">CREEK OFFICE</p><h1 style="font-family:Georgia,serif;font-size:28px">Keep caring. Keep connected.</h1><p style="line-height:1.65">Your care follow-ups need attention. Review care plans and Intake actions, record completed contacts and choose the next step.</p><p><a href="${OFFICE}" style="display:inline-block;background:#3c5a45;color:white;padding:14px 22px;text-decoration:none;border-radius:6px">Open Creek Office</a></p><p style="font-size:13px;line-height:1.5">Sign in with your approved Office account. No member, guest or prayer details are included in this reminder.</p></main></body></html>`;
  return {from:'Bluff Creek Baptist Church <office@auth.bluffcreekbaptistchurch.org>',to:[job.recipient],reply_to:'bluffcreekbaptist@gmail.com',subject:'Your Creek Office care follow-ups',text,html};
}

function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function limitedJSON(response, limit) {
  if (!response.body) throw new Error('invalid_response');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', {fatal:true});
  let total = 0, text = '';
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); throw new Error('invalid_response'); }
      text += decoder.decode(value, {stream:true});
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

/**
 * Dependency injection keeps verification completely off the network.
 * @param {{projectURL?:string,serviceKey?:string,resendKey?:string,jobSecret?:string,fetcher?:typeof fetch,now?:()=>Date,timeoutMs?:number}} options
 * @returns {(request:Request)=>Promise<Response>}
 */
export function createCareReminderHandler({projectURL,serviceKey,resendKey,jobSecret,fetcher=fetch,now=()=>new Date(),timeoutMs=8000}={}) {
  const serviceMode = serviceKeyKind(serviceKey);
  const ready = projectURL === PROJECT && serviceMode && /^re_[A-Za-z0-9_-]+$/.test(resendKey || '') && /^[0-9a-f]{64}$/.test(jobSecret || '');
  const timeout = Math.max(1, Math.min(8000, Number(timeoutMs) || 8000));
  const respond = (body,status=200) => new Response(JSON.stringify(body), {status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});

  async function requestJSON(url, options, limit=16384) {
    const abort = new AbortController();
    let timer;
    const operation = (async () => {
      const response = await fetcher(url, {...options, redirect:'error',credentials:'omit',signal:abort.signal});
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw new Error('invalid_response');
      let data, valid = true;
      try { data = await limitedJSON(response,limit); } catch { valid = false; }
      return {ok:response.ok,status:response.status,data,valid};
    })();
    try { return await Promise.race([operation,new Promise((_,reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('timeout')); },timeout); })]); }
    finally { clearTimeout(timer); }
  }

  async function rpc(name, body) {
    const response = await requestJSON(PROJECT + '/rest/v1/rpc/' + name, {method:'POST',headers:{apikey:serviceKey,...(serviceMode === 'legacy' ? {Authorization:'Bearer ' + serviceKey} : {}),'Content-Type':'application/json'},body:JSON.stringify(body)});
    if (!response.ok || !response.valid) throw new Error('database_unavailable');
    return response.data;
  }

  async function finish(job,status,providerId,errorCode) {
    const receipt = await rpc('finish_care_reminder_job',{p_id:job.id,p_lease_token:job.lease_token,p_status:status,p_provider_id:providerId,p_error_code:errorCode});
    if (!receipt || receipt.id !== job.id || (receipt.status !== status && !(status === 'retry' && receipt.status === 'failed')) || !Number.isInteger(receipt.version) || receipt.version < 1) throw new Error('invalid_finish');
    return receipt.status;
  }

  async function processJob(job) {
    let status = 'uncertain', providerId = null, errorCode = 'delivery_uncertain', stop = false;
    let payload;
    try { payload = careMessage(job); }
    catch { status = 'failed'; errorCode = 'invalid_job'; stop = true; }
    const age = now().getTime() - Date.parse(job?.first_attempt_at);
    if (payload && (!Number.isFinite(age) || age < -60000 || age >= 23 * 60 * 60 * 1000)) {
      status = 'failed'; errorCode = 'retry_window_expired'; stop = true; payload = null;
    }
    if (payload) {
      try {
        const response = await requestJSON(PROVIDER,{method:'POST',headers:{Authorization:'Bearer ' + resendKey,'Content-Type':'application/json','Idempotency-Key':job.provider_key},body:JSON.stringify(payload)},4096);
        if (response.ok && response.valid && typeof response.data?.id === 'string' && UUID.test(response.data.id)) {
          status = 'accepted'; providerId = response.data.id; errorCode = null;
        } else if (response.ok) { errorCode = 'provider_invalid_response'; stop = true; }
        else if ([401,403].includes(response.status)) { status = 'failed'; errorCode = 'provider_configuration'; stop = true; }
        else if (response.status === 409 && response.data?.name === 'invalid_idempotent_request') { status = 'failed'; errorCode = 'idempotency_conflict'; stop = true; }
        else if (response.status === 429) { status = 'retry'; errorCode = 'provider_rate_limited'; stop = true; }
        else if (response.status >= 500 || (response.status === 409 && response.data?.name === 'concurrent_idempotent_requests')) { status = 'retry'; errorCode = 'provider_unavailable'; stop = true; }
        else if (response.status === 409) { errorCode = 'delivery_uncertain'; stop = true; }
        else { status = 'failed'; errorCode = 'provider_rejected'; stop = true; }
      } catch (error) { errorCode = error?.message === 'timeout' ? 'provider_timeout' : 'delivery_uncertain'; stop = true; }
    }
    if (typeof job?.id !== 'string' || typeof job?.lease_token !== 'string' || !UUID.test(job.id) || !UUID.test(job.lease_token)) return {status:'unconfirmed',stop:true};
    try { const recorded = await finish(job,status,providerId,errorCode); return {status:recorded,stop:stop || recorded === 'failed'}; }
    catch { return {status:'unconfirmed',stop:true}; } // Lease expiry becomes an operator hold; never claim delivery.
  }

  return async function handle(request) {
    if (request.headers.has('Origin')) return respond({error:'origin_not_allowed'},403);
    if (request.method !== 'POST') return respond({error:'method_not_allowed'},405);
    if (!ready) return respond({error:'care_reminders_unavailable'},503);
    if (!equalSecret(request.headers.get('X-Creek-Care-Job-Key'),jobSecret)) return respond({error:'not_authorized'},401);
    if (new URL(request.url).search || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) return respond({error:'invalid_request'},400);
    let timer;
    try {
      const body = await Promise.race([limitedJSON(request,512),new Promise((_,reject) => { timer = setTimeout(() => reject(new Error('timeout')),2000); })]);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return respond({error:'invalid_request'},400);
    } catch { return respond({error:'invalid_request'},400); }
    finally { clearTimeout(timer); }
    const counts = {accepted:0,retry:0,needs_attention:0,unconfirmed:0};
    try {
      const enqueue = await rpc('enqueue_care_reminders',{});
      if (!enqueue || !['enqueued','paused','waiting'].includes(enqueue.status) || !Number.isInteger(enqueue.enqueued) || enqueue.enqueued < 0 || enqueue.enqueued > 500 || (enqueue.status !== 'enqueued' && enqueue.enqueued !== 0)) throw new Error('invalid_enqueue');
      if (enqueue.status !== 'enqueued') return respond({status:'processed',...counts});
      // Claim only what this invocation is about to attempt. A provider outage
      // must not strand a batch of untouched claims behind active leases.
      for (let i = 0; i < 5; i++) {
        const jobs = await rpc('claim_care_reminder_jobs',{p_limit:1});
        if (!Array.isArray(jobs) || jobs.length > 1) throw new Error('invalid_jobs');
        if (!jobs.length) break;
        const result = await processJob(jobs[0]);
        if (result.status === 'failed' || result.status === 'uncertain') counts.needs_attention++;
        else counts[result.status]++;
        if (result.stop) break;
      }
      return respond({status:'processed',...counts},counts.unconfirmed ? 503 : 200);
    } catch { return respond({error:'care_queue_unavailable',...counts},503); }
  };
}
