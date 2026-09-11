import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createGuestSheetHandler,validateSnapshot,secretMatches,HEADERS,PROJECT_URL} from '../../supabase/functions/guest-sheet-snapshot/handler.mjs';
const key='a'.repeat(64), service='fictional-server-only-key';
const copy=x=>JSON.parse(JSON.stringify(x));
const row=(id='00000000-0000-4000-8000-000000000001')=>['2026-09-11','=Fictional','Guest','guest@example.invalid','+15550000000','email','Yes','guest','not_yet','','','','new','Office queue','Queued','pending',id,new Date().toISOString()];
const snapshot=(rows=[row()])=>({version:1,generated_at:new Date().toISOString(),total:rows.length,headers:[...HEADERS],rows});
const request=(extra={})=>new Request('https://edge.example.invalid/functions/v1/guest-sheet-snapshot'+(extra.query||''),{method:extra.method||'POST',headers:{'x-creek-guest-sheet-key':key,...extra.headers},...((extra.method||'POST')==='POST'?{body:extra.body??'{}'}:{})});
function handler(fetchImpl,extra={}){return createGuestSheetHandler({secret:key,serviceKey:service,fetchImpl,...extra});}

test('Edge accepts only exact scoped secret, POST, empty body and no browser origin or query',async()=>{
 let calls=0;const serve=handler(async()=>{calls++;return Response.json(snapshot());});
 for(const [args,status]of [[{method:'GET'},405],[{headers:{'x-creek-guest-sheet-key':'b'.repeat(64)}},401],[{headers:{'x-creek-guest-sheet-key':''}},401],[{headers:{Origin:'https://church.example.invalid'}},403],[{query:'?other=1'},403],[{body:'[]'},400],[{body:'{"page":2}'},400],[{body:' '.repeat(300)+'{}'},400]])assert.equal((await serve(request(args))).status,status);
 assert.equal(calls,0);assert.equal(secretMatches(key,key),true);assert.equal(secretMatches(key+'a',key),false);assert.equal(secretMatches(key.toUpperCase(),key),false);
});
test('Edge fixed read-only backend and private response never expose server credentials',async()=>{
 const serve=handler(async(url,opts)=>{assert.equal(url,PROJECT_URL+'/rest/v1/rpc/get_guest_sheet_snapshot');assert.equal(opts.method,'POST');assert.equal(opts.body,'{}');assert.equal(opts.redirect,'error');assert.equal(opts.headers.apikey,service);assert.equal(opts.headers.Authorization,'Bearer '+service);return Response.json(snapshot());});
 const result=await serve(request());assert.equal(result.status,200);assert.equal(result.headers.has('Access-Control-Allow-Origin'),false);assert.match(result.headers.get('Cache-Control'),/no-store/);assert.doesNotMatch(await result.text(),/fictional-server-only-key/);
});
test('Edge refuses an alternate backend or missing credentials without a request',async()=>{
 for(const extra of [{projectURL:'https://other.supabase.co'},{serviceKey:''}]){const serve=handler(()=>assert.fail('no fetch'),extra);assert.equal((await serve(request())).status,503);}
});
test('Edge failures and redirections never expose backend errors or partial snapshots',async()=>{
 for(const fake of [()=>new Response('PRIVATE_DATABASE_CANARY',{status:500}),()=>new Response(null,{status:302,headers:{Location:'https://other.invalid'}}),()=>Promise.reject(Error('PRIVATE_DATABASE_CANARY')),()=>Response.json({...snapshot(),rows:[]}),()=>Response.json({...snapshot(),private_notes:'PRIVATE_DATABASE_CANARY'})]){const response=await handler(fake)(request());assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'snapshot_unavailable'});}
});
test('Edge aborts timed-out backend reads',async()=>{
 const serve=handler((url,opts)=>new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('abort')))),{timeoutMs:5});assert.equal((await serve(request())).status,503);
});
test('full snapshot validator rejects duplicate IDs, wrong headers, invalid dates, unknown states and hidden fields',()=>{
 const valid=snapshot();assert.equal(validateSnapshot(valid),valid);
 for(const bad of [{...valid,total:2},{...valid,total:5001},{...valid,headers:[...HEADERS].reverse()},{...valid,rows:[row(),row()],total:2},{...valid,rows:[row().slice(0,17)]},{...valid,rows:[row().map((v,i)=>i===0?'2026-02-30':v)]},{...valid,rows:[row().map((v,i)=>i===15?'archived':v)]},{...valid,rows:[row().map((v,i)=>i===12?'fabricated':v)]},{...valid,rows:[row().map((v,i)=>i===4?null:v)]}])assert.throws(()=>validateSnapshot(bad));
});

const code=await readFile(new URL('./apps-script/Code.gs',import.meta.url),'utf8');
function scriptFixture({native=false,lock=true}={}){
 const state={calls:[],fetches:[],snapshot:snapshot(),status:200,failure:false,last:'',lastRow:12,installed:0,release:0,locks:0,metadata:{properties:{sheetId:3,title:'Guest Register',gridProperties:{rowCount:25,columnCount:18,frozenRowCount:8,frozenColumnCount:3}},...(native?{tables:[{tableId:'native-table',name:'BCBCGuestRegister',range:{sheetId:3,startRowIndex:7,endRowIndex:8,startColumnIndex:0,endColumnIndex:18},columnProperties:[]}]}:{basicFilter:{range:{sheetId:3,startRowIndex:7,endRowIndex:8,startColumnIndex:0,endColumnIndex:18},filterSpecs:[{columnIndex:15,filterCriteria:{hiddenValues:['reviewed']}}]}})}};
 const spreadsheetId='b'.repeat(40);
 const props={CREEK_GUEST_SHEET_SPREADSHEET_ID:spreadsheetId,CREEK_GUEST_SHEET_SECRET:key};
 const sheet={getRange:(r,c)=>({getDisplayValues:()=>r===8?[[...HEADERS]]:[[state.last]]}),getSheetId:()=>3,getLastRow:()=>state.lastRow};
 const locking=()=>({tryLock:()=>{state.locks++;return lock;},hasLock:()=>lock,releaseLock:()=>state.release++});
 const context={Date,JSON,Set,Error,Uint8Array,console:{log:()=>assert.fail('no logging')},PropertiesService:{getScriptProperties:()=>({getProperty:n=>props[n]})},SpreadsheetApp:{getActiveSpreadsheet:()=>({getId:()=>spreadsheetId,getSheetByName:n=>n==='Guest Register'?sheet:null})},LockService:{getScriptLock:locking,getDocumentLock:locking},UrlFetchApp:{fetch:(url,opts)=>{state.fetches.push({url,opts});return{getResponseCode:()=>state.status,getContentText:()=>JSON.stringify(state.snapshot)}}},Sheets:{Spreadsheets:{get:(id,opts)=>({sheets:[state.metadata]}),batchUpdate:(plan,id)=>{if(state.failure && plan.requests.some(r=>r.updateCells?.range.startRowIndex===8))throw Error('PRIVATE_WRITE_FAILURE');state.calls.push(copy(plan));return{};}}},ScriptApp:{getProjectTriggers:()=>Array.from({length:state.installed},()=>({getHandlerFunction:()=> 'syncGuestRegister'})),newTrigger:name=>({timeBased:()=>({everyMinutes:n=>({create:()=>{assert.equal(name,'syncGuestRegister');assert.equal(n,5);state.installed++;}})})})}};
 vm.createContext(context);vm.runInContext(code,context);return{state,context,props,sheet};
}
test('Apps Script and Edge agree on exact validation including formula-looking literal data',()=>{
 const f=scriptFixture();for(const value of [snapshot(),snapshot([])])assert.deepEqual(copy(f.context.validateSnapshot(value)),validateSnapshot(value));assert.throws(()=>f.context.validateSnapshot({...snapshot(),rows:[]}));
});
test('successful mirror writes one atomic batch with literal strings, clears obsolete rows and preserves surrounding cells/freeze',()=>{
 const f=scriptFixture();assert.deepEqual(copy(f.context.syncGuestRegister()),{status:'synced',total:1});assert.equal(f.state.calls.length,1);const requests=f.state.calls[0].requests;
 const data=requests.find(r=>r.updateCells?.range.startRowIndex===8).updateCells;assert.equal(data.range.endRowIndex,12);assert.equal(data.fields,'userEnteredValue');assert.equal(data.rows[0].values[1].userEnteredValue.stringValue,'=Fictional');assert.equal(data.rows[0].values[4].userEnteredValue.stringValue,'+15550000000');assert.doesNotMatch(JSON.stringify(requests),/formulaValue|deleteDimension|frozenRowCount|updateSheetProperties/);
 assert.deepEqual(requests.filter(r=>r.updateCells && r.updateCells.range.startRowIndex<8).map(r=>[r.updateCells.range.startRowIndex,r.updateCells.range.startColumnIndex]),[[4,1],[4,4],[5,0]]);assert.equal(f.state.release,2);
});
test('native table expands without overwriting its formatting or creating another filter',()=>{
 const f=scriptFixture({native:true});f.state.snapshot=snapshot(Array.from({length:30},(_,i)=>row('00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'))));f.context.syncGuestRegister();const req=f.state.calls[0].requests;assert.deepEqual(req.find(r=>r.updateTable).updateTable,{table:{tableId:'native-table',range:{sheetId:3,startRowIndex:7,endRowIndex:38,startColumnIndex:0,endColumnIndex:18}},fields:'range'});assert.equal(req.some(r=>r.setBasicFilter),false);assert.equal(req[0].appendDimension.length,13);assert.equal(req.find(r=>r.copyPaste).copyPaste.pasteType,'PASTE_FORMAT');
});
test('converted XLSX basic filter expands and preserves staff filtering choices',()=>{
 const f=scriptFixture();f.context.syncGuestRegister();const filter=f.state.calls[0].requests.find(r=>r.setBasicFilter).setBasicFilter.filter;assert.equal(filter.range.endRowIndex,9);assert.deepEqual(filter.filterSpecs,f.state.metadata.basicFilter.filterSpecs);
});
test('zero-row snapshot clears old data and keeps one formatted blank table row',()=>{
 const f=scriptFixture();f.state.snapshot=snapshot([]);f.context.syncGuestRegister();const cells=f.state.calls[0].requests.find(r=>r.updateCells?.range.startRowIndex===8).updateCells;assert.deepEqual(cells.rows,[]);assert.equal(cells.range.endRowIndex,12);assert.equal(f.state.calls[0].requests.find(r=>r.setBasicFilter).setBasicFilter.filter.range.endRowIndex,9);
});
test('malformed, stale, archived or partial snapshot updates only failure indicators; last successful time is retained',()=>{
 for(const mutate of [s=>{s.total=2},s=>{s.rows[0][15]='archived'},s=>{s.generated_at='2020-01-01T00:00:00Z'},s=>{s.extra='PRIVATE_DATA'},s=>{s.headers[0]='Wrong'}]){const f=scriptFixture();mutate(f.state.snapshot);assert.throws(()=>f.context.syncGuestRegister(),/could not be confirmed/);assert.equal(f.state.calls.length,1);assert.deepEqual(f.state.calls[0].requests.map(r=>[r.updateCells.range.startRowIndex,r.updateCells.range.startColumnIndex]),[[4,1],[5,0]]);assert.equal(f.state.release,2);}
});
test('failed atomic write reports uncertainty without another data mutation or new success time',()=>{
 const f=scriptFixture();f.state.failure=true;assert.throws(()=>f.context.syncGuestRegister(),/could not be confirmed/);assert.equal(f.state.calls.length,1);assert.equal(f.state.calls[0].requests.length,2);assert.doesNotMatch(JSON.stringify(f.state.calls),/PRIVATE_WRITE_FAILURE/);
});
test('locks prevent overlapping fetches and a copied script cannot write the wrong spreadsheet',()=>{
 const busy=scriptFixture({lock:false});assert.equal(busy.context.syncGuestRegister().status,'busy');assert.equal(busy.state.calls.length,0);assert.equal(busy.state.fetches.length,0);
 const bad=scriptFixture();bad.props.CREEK_GUEST_SHEET_SPREADSHEET_ID='c'.repeat(40);assert.throws(()=>bad.context.syncGuestRegister());assert.equal(bad.state.calls.length,0);assert.equal(bad.state.fetches.length,0);
});
test('trigger installation is explicit and never duplicates or deletes someone else’s trigger',()=>{
 const f=scriptFixture();assert.equal(f.state.installed,0);assert.equal(f.context.installGuestSheetFiveMinuteTrigger().status,'installed');assert.equal(f.context.installGuestSheetFiveMinuteTrigger().status,'already_installed');assert.equal(f.state.installed,1);f.state.installed=2;assert.throws(()=>f.context.installGuestSheetFiveMinuteTrigger());
});
test('Apps Script sends the dedicated secret only to fixed Edge endpoint with redirects off',()=>{
 const f=scriptFixture();f.context.syncGuestRegister();assert.equal(f.state.fetches[0].url,PROJECT_URL+'/functions/v1/guest-sheet-snapshot');assert.equal(f.state.fetches[0].opts.followRedirects,false);assert.deepEqual(copy(f.state.fetches[0].opts.headers),{'X-Creek-Guest-Sheet-Key':key});assert.equal(f.state.fetches[0].opts.payload,'{}');assert.doesNotMatch(JSON.stringify(f.state.calls),new RegExp(key));
});
