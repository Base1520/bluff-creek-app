export const PROJECT_URL = 'https://xzfeumdonxeodqhfirjr.supabase.co';
export const HEADERS = Object.freeze(['Signup date','First name','Last name','Email','Phone','Preferred contact','Permission to contact','Membership (self-reported)','Visit status','First visit','Confirmed visit','Next follow-up','Follow-up status','Assigned staff','Welcome email','Review status','Record ID','Updated at']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const LIMIT = 12 * 1024 * 1024;
function date(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value; }
export function validateSnapshot(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).sort().join(',') !== 'generated_at,headers,rows,total,version' || data.version !== 1 || !ISO.test(data.generated_at || '') || !Number.isFinite(Date.parse(data.generated_at)) || !Number.isSafeInteger(data.total) || data.total < 0 || data.total > 5000 || !Array.isArray(data.headers) || JSON.stringify(data.headers) !== JSON.stringify(HEADERS) || !Array.isArray(data.rows) || data.rows.length !== data.total) throw Error('Invalid snapshot');
  const ids = new Set(), limits=[10,100,100,320,32,5,3,16,11,10,10,10,11,320,17,8,36,32];
  for (const row of data.rows) {
    if (!Array.isArray(row) || row.length !== 18 || row.some((v,i)=>typeof v !== 'string' || [...v].length > limits[i]) || !date(row[0]) || !row[1].trim() || !row[3].trim() || !['email','phone','text'].includes(row[5]) || !['Yes','No'].includes(row[6]) || !['member','regular_attender','guest','exploring','unsure'].includes(row[7]) || !['not_yet','first_visit','returning'].includes(row[8]) || [9,10,11].some(i=>row[i] && !date(row[i])) || !['new','in_progress','completed','contacted','connected','closed'].includes(row[12]) || !row[13] || !['Provider accepted','Processing','Queued','Needs attention'].includes(row[14]) || !['pending','reviewed'].includes(row[15]) || !UUID.test(row[16]) || ids.has(row[16].toLowerCase()) || !ISO.test(row[17]) || !Number.isFinite(Date.parse(row[17]))) throw Error('Invalid snapshot');
    ids.add(row[16].toLowerCase());
  }
  return data;
}
export function secretMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(actual) || !/^[0-9a-f]{64}$/.test(expected)) return false;
  let difference=0; for(let i=0;i<64;i++) difference |= actual.charCodeAt(i)^expected.charCodeAt(i); return difference===0;
}
async function limitedText(body, limit) {
  if (!body) return ''; const reader=body.getReader();let size=0;const parts=[];
  try { for (;;) { const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw Error('Oversized');parts.push(value); } }
  finally { try { await reader.cancel(); } catch {} }
  const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.byteLength;}return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
export function createGuestSheetHandler({secret,serviceKey,projectURL=PROJECT_URL,fetchImpl=fetch,timeoutMs=10000}) {
 const reply=(status,value)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private, max-age=0','Pragma':'no-cache','X-Content-Type-Options':'nosniff'}});
 return async function(request) {
  if(request.method!=='POST')return reply(405,{error:'method_not_allowed'});
  if(request.headers.has('origin') || new URL(request.url).search)return reply(403,{error:'forbidden'});
  if(!secretMatches(request.headers.get('x-creek-guest-sheet-key'),secret))return reply(401,{error:'unauthorized'});
  if(projectURL!==PROJECT_URL || typeof serviceKey!=='string' || !serviceKey || /[\r\n]/.test(serviceKey))return reply(503,{error:'unavailable'});
  let input;try { input=JSON.parse(await limitedText(request.body,256));if(!input || Array.isArray(input) || Object.keys(input).length)throw Error('body'); } catch{return reply(400,{error:'invalid_request'});}
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),timeoutMs);
  try {
   const result=await fetchImpl(PROJECT_URL+'/rest/v1/rpc/get_guest_sheet_snapshot',{method:'POST',redirect:'error',signal:abort.signal,headers:{apikey:serviceKey,Authorization:'Bearer '+serviceKey,'Content-Type':'application/json'},body:'{}'});
   if(result.status!==200 || result.redirected)throw Error('backend');
   const snapshot=validateSnapshot(JSON.parse(await limitedText(result.body,LIMIT)));
   return reply(200,snapshot);
  }catch{return reply(503,{error:'snapshot_unavailable'});}finally{clearTimeout(timer);}
 };
}
