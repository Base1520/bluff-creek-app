/* Bound to the NEW private Guest Register spreadsheet. No automatic installation. */
const HEADERS = Object.freeze(['Signup date','First name','Last name','Email','Phone','Preferred contact','Permission to contact','Membership (self-reported)','Visit status','First visit','Confirmed visit','Next follow-up','Follow-up status','Assigned staff','Welcome email','Review status','Record ID','Updated at']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const LIMIT = 12 * 1024 * 1024;
function date(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value; }
function validateSnapshot(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).sort().join(',') !== 'generated_at,headers,rows,total,version' || data.version !== 1 || !ISO.test(data.generated_at || '') || !Number.isFinite(Date.parse(data.generated_at)) || !Number.isSafeInteger(data.total) || data.total < 0 || data.total > 5000 || !Array.isArray(data.headers) || JSON.stringify(data.headers) !== JSON.stringify(HEADERS) || !Array.isArray(data.rows) || data.rows.length !== data.total) throw Error('Invalid snapshot');
  const ids = new Set(), limits=[10,100,100,320,32,5,3,16,11,10,10,10,11,320,17,8,36,32];
  for (const row of data.rows) {
    if (!Array.isArray(row) || row.length !== 18 || row.some((v,i)=>typeof v !== 'string' || [...v].length > limits[i]) || !date(row[0]) || !row[1].trim() || !row[3].trim() || !['email','phone','text'].includes(row[5]) || !['Yes','No'].includes(row[6]) || !['member','regular_attender','guest','exploring','unsure'].includes(row[7]) || !['not_yet','first_visit','returning'].includes(row[8]) || [9,10,11].some(i=>row[i] && !date(row[i])) || !['new','in_progress','completed','contacted','connected','closed'].includes(row[12]) || !row[13] || !['Provider accepted','Processing','Queued','Needs attention'].includes(row[14]) || !['pending','reviewed'].includes(row[15]) || !UUID.test(row[16]) || ids.has(row[16].toLowerCase()) || !ISO.test(row[17]) || !Number.isFinite(Date.parse(row[17]))) throw Error('Invalid snapshot');
    ids.add(row[16].toLowerCase());
  }
  return data;
}

const GUEST_ENDPOINT = 'https://xzfeumdonxeodqhfirjr.supabase.co/functions/v1/guest-sheet-snapshot';
const GUEST_TAB = 'Guest Register', HEADER_ROW = 8, FIRST_ROW = 9;
function guestConfiguration() {
 const properties=PropertiesService.getScriptProperties();
 const book=SpreadsheetApp.getActiveSpreadsheet();
 const id=properties.getProperty('CREEK_GUEST_SHEET_SPREADSHEET_ID');
 const secret=properties.getProperty('CREEK_GUEST_SHEET_SECRET');
 if(!book || !/^[A-Za-z0-9_-]{20,160}$/.test(id || '') || book.getId()!==id || !/^[0-9a-f]{64}$/.test(secret || ''))throw Error('Guest mirror configuration needs attention');
 const sheet=book.getSheetByName(GUEST_TAB);
 if(!sheet || JSON.stringify(sheet.getRange(HEADER_ROW,1,1,18).getDisplayValues()[0])!==JSON.stringify(HEADERS))throw Error('Guest mirror layout needs attention');
 return {book:book,sheet:sheet,id:id,secret:secret};
}
function guestValue(row,column,value,sheetId) {
 return {updateCells:{range:{sheetId:sheetId,startRowIndex:row-1,endRowIndex:row,startColumnIndex:column-1,endColumnIndex:column},rows:[{values:[{userEnteredValue:{stringValue:value}}]}],fields:'userEnteredValue'}};
}
function guestWritePlan(snapshot,meta,lastRow,now) {
 validateSnapshot(snapshot);
 if(!meta || !meta.properties || meta.properties.title!==GUEST_TAB || !Number.isSafeInteger(meta.properties.sheetId) || !Number.isSafeInteger(meta.properties.gridProperties.rowCount) || !Number.isSafeInteger(lastRow) || lastRow<HEADER_ROW || lastRow>5008)throw Error('Guest mirror layout needs attention');
 const sid=meta.properties.sheetId, end=Math.max(9,HEADER_ROW+snapshot.total), clearEnd=Math.max(end,lastRow), tables=meta.tables || [];
 if(tables.length>1 || (tables.length===1 && (tables[0].name!=='BCBCGuestRegister' || typeof tables[0].tableId!=='string' || !tables[0].range || tables[0].range.startRowIndex!==7 || (tables[0].range.startColumnIndex || 0)!==0 || tables[0].range.endColumnIndex!==18)))throw Error('Guest mirror table needs attention');
 const requests=[];
 if(meta.properties.gridProperties.rowCount<clearEnd)requests.push({appendDimension:{sheetId:sid,dimension:'ROWS',length:clearEnd-meta.properties.gridProperties.rowCount}});
 // Copy only the established first data row's formatting to newly grown rows.
 if(clearEnd>Math.max(9,lastRow))requests.push({copyPaste:{source:{sheetId:sid,startRowIndex:8,endRowIndex:9,startColumnIndex:0,endColumnIndex:18},destination:{sheetId:sid,startRowIndex:Math.max(9,lastRow),endRowIndex:clearEnd,startColumnIndex:0,endColumnIndex:18},pasteType:'PASTE_FORMAT'}});
 requests.push({updateCells:{range:{sheetId:sid,startRowIndex:8,endRowIndex:clearEnd,startColumnIndex:0,endColumnIndex:18},rows:snapshot.rows.map(row=>({values:row.map(value=>({userEnteredValue:{stringValue:value}}))})),fields:'userEnteredValue'}});
 const range={sheetId:sid,startRowIndex:7,endRowIndex:end,startColumnIndex:0,endColumnIndex:18};
 if(tables.length)requests.push({updateTable:{table:{tableId:tables[0].tableId,range:range},fields:'range'}});
 else {
  const filter=meta.basicFilter || {};
  if(filter.tableId || (filter.range && (filter.range.startRowIndex!==7 || (filter.range.startColumnIndex || 0)!==0 || filter.range.endColumnIndex!==18)))throw Error('Guest mirror filter needs attention');
  requests.push({setBasicFilter:{filter:Object.assign({},filter,{range:range})}});
 }
 requests.push(guestValue(5,2,'Connected — '+snapshot.total+' guest records',sid),guestValue(5,5,snapshot.generated_at,sid),guestValue(6,1,'Last successful refresh '+now+'. Read-only copy; make changes in Creek Office. Automatic refresh requires the owner’s five-minute trigger; check the last successful sync above.',sid));
 return {requests:requests};
}
function syncGuestRegister() {
 const scriptLock=LockService.getScriptLock();if(!scriptLock.tryLock(1000))return {status:'busy'};
 let documentLock,config;
 try {
  documentLock=LockService.getDocumentLock();if(!documentLock || !documentLock.tryLock(1000))return {status:'busy'};
  config=guestConfiguration();
  const response=UrlFetchApp.fetch(GUEST_ENDPOINT,{method:'post',contentType:'application/json',payload:'{}',headers:{'X-Creek-Guest-Sheet-Key':config.secret},followRedirects:false,muteHttpExceptions:true});
  if(response.getResponseCode()!==200)throw Error('Guest snapshot unavailable');
  const raw=response.getContentText();if(raw.length>LIMIT)throw Error('Guest snapshot too large');
  const snapshot=validateSnapshot(JSON.parse(raw)), now=new Date(), generated=Date.parse(snapshot.generated_at);
  if(generated>now.getTime()+120000 || generated<now.getTime()-600000)throw Error('Guest snapshot is not current');
  const last=config.sheet.getRange(5,5).getDisplayValues()[0][0];
  if(ISO.test(last) && generated<Date.parse(last))throw Error('Guest snapshot is older than the displayed data');
  const metadata=Sheets.Spreadsheets.get(config.id,{fields:'sheets(properties,tables,basicFilter)'});
  const meta=metadata.sheets.find(value=>value.properties.sheetId===config.sheet.getSheetId());
  const plan=guestWritePlan(snapshot,meta,config.sheet.getLastRow(),now.toISOString());
  // One atomic batch: replacement, obsolete-row clearing, table/filter and status.
  // stringValue is literal text, never a formula (including =,+,-,@ prefixes).
  Sheets.Spreadsheets.batchUpdate(plan,config.id);
  return {status:'synced',total:snapshot.total};
 } catch(_) {
  if(config)try { Sheets.Spreadsheets.batchUpdate({requests:[guestValue(5,2,'Needs attention — last validated snapshot retained',config.sheet.getSheetId()),guestValue(6,1,'Refresh could not be confirmed at '+new Date().toISOString()+'. Last successful sync is shown above. Check setup or try again; do not re-enter guest records here.',config.sheet.getSheetId())]},config.id); }catch(_){}
  throw Error('Guest mirror refresh could not be confirmed. Check the sheet connection status; no records or credentials are logged.');
 } finally {
  if(documentLock && documentLock.hasLock())documentLock.releaseLock();
  scriptLock.releaseLock();
 }
}
function installGuestSheetFiveMinuteTrigger() {
 guestConfiguration();
 const existing=ScriptApp.getProjectTriggers().filter(trigger=>trigger.getHandlerFunction()==='syncGuestRegister');
 if(existing.length>1)throw Error('More than one mirror trigger exists; ask the owner to review them');
 if(existing.length===1)return {status:'already_installed'};
 ScriptApp.newTrigger('syncGuestRegister').timeBased().everyMinutes(5).create();
 return {status:'installed'};
}
