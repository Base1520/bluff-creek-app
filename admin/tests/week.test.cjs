const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const code=fs.readFileSync(path.join(__dirname,'../week.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const source=items=>({available:true,items});
const empty=()=>({content:{announcements:source([]),slides:source([]),committees:source([])},events:source([])});
const announcement=(id,extra={})=>({id,title:'Fictional announcement '+id,status:'draft',starts_on:null,ends_on:null,updated_at:'2026-09-11T15:00:00Z',...extra});
const slide=(id,extra={})=>({id,title:'Fictional slides '+id,status:'draft',service_date:'2026-09-13',hasMaterial:false,updated_at:'2026-09-11T15:00:00Z',...extra});
const committee=(id,extra={})=>({id,committee_name:'Fictional committee '+id,status:'active',term_start:null,term_end:null,updated_at:'2026-09-11T15:00:00Z',...extra});
const event=(id,extra={})=>({id,title:'Fictional staff event '+id,starts_at:'2026-09-11T15:00:00Z',ends_at:null,updated_at:'2026-09-11T15:00:00Z',...extra});
function fixture(t,options={}){
 const dom=new JSDOM('<section></section>',{url:'https://example.invalid/admin/',runScripts:'outside-only'}),w=dom.window;t.after(()=>w.close());w.eval(code);
 let ctx={userId:'fictional-admin',epoch:1,role:'admin',canEdit:true,workspaceReady:true};
 const state={sources:empty(),now:new Date(options.now||'2026-09-11T15:00:00Z'),reads:0,beforeRead:null,open:null},summaries=[],opened=[];
 for(const key of ['localStorage','sessionStorage'])Object.defineProperty(w,key,{get(){throw Error('No browser storage for shared week');}});
 w.fetch=()=>{throw Error('No network for shared week');};
 const host=w.document.querySelector('section');
 const api=w.CreekWeek.create({root:host,getContext:()=>ctx,isCurrent:e=>e===ctx.epoch,getSources:()=>{state.reads++;if(state.beforeRead)state.beforeRead();return state.sources;},now:()=>state.now,onSummary:s=>summaries.push(s&&plain(s)),onOpen:(view,id)=>{opened.push({view,id});return state.open?state.open(view,id):true;}});
 const section=kind=>host.querySelector('[data-week-section="'+kind+'"]');
 return {w,host,api,state,summaries,opened,section,context:()=>ctx,setContext:value=>{ctx=value;},rows:kind=>[...section(kind).querySelectorAll('[data-week-id]')].map(n=>n.dataset.weekId),open:(kind,id)=>section(kind).querySelector('[data-week-id="'+id+'"] button').click()};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('week uses Central Monday–Sunday and retains today as the Sunday target until local midnight',t=>{
 for(const [now,start,sunday] of [['2026-09-14T04:59:59Z','2026-09-07','2026-09-13'],['2026-09-14T05:00:00Z','2026-09-14','2026-09-20'],['2026-11-02T05:59:59Z','2026-10-26','2026-11-01'],['2026-11-02T06:00:00Z','2026-11-02','2026-11-08'],['2028-03-01T01:00:00Z','2028-02-28','2028-03-05']]){
  const f=fixture(t,{now});f.api.render();assert.equal(f.summaries.at(-1).weekStart,start);assert.equal(f.summaries.at(-1).weekEnd,sunday);assert.equal(f.summaries.at(-1).sunday,sunday);
 }
});

test('announcements distinguish drafts/ready and undated work while filtering date overlap and archival',t=>{
 const f=fixture(t);f.state.sources.content.announcements=source([
  announcement('undated'),announcement('ready',{status:'ready',starts_on:'2026-09-13',ends_on:'2026-09-13'}),announcement('ongoing',{starts_on:'2026-09-01'}),announcement('ending',{ends_on:'2026-09-07'}),
  announcement('future',{starts_on:'2026-09-14'}),announcement('expired',{ends_on:'2026-09-06'}),announcement('archived',{status:'archived'})]);f.api.render();
 assert.deepEqual(f.rows('announcements').sort(),['ending','ongoing','ready','undated']);assert.match(f.section('announcements').textContent,/Dates not set/);assert.match(f.section('announcements').textContent,/Ready for staff use/);assert.match(f.section('announcements').textContent,/Ready does not mean published/);assert.equal(f.summaries.at(-1).knownItems,4);
});

test('Sunday slides are exact-date records with separate preparation and material states',t=>{
 const f=fixture(t);f.state.sources.content.slides=source([slide('draft'),slide('ready',{status:'ready',hasMaterial:true}),slide('prior',{service_date:'2026-09-06'}),slide('following',{service_date:'2026-09-20'}),slide('archived',{status:'archived'})]);f.api.render();
 assert.deepEqual(f.rows('slides'),['draft','ready']);assert.match(f.section('slides').textContent,/No deck link or available document/);assert.match(f.section('slides').textContent,/Deck link or document configured/);assert.match(f.section('slides').textContent,/does not verify presentation access/);
 f.state.sources.content.slides=source([]);f.api.render();assert.match(f.section('slides').textContent,/No slide record is saved/);
});

test('staff planning includes true week overlap and excludes exact end boundaries across DST',t=>{
 const f=fixture(t,{now:'2026-11-01T18:00:00Z'});f.state.sources.events=source([
  event('ends-before',{starts_at:'2026-10-25T20:00:00Z',ends_at:'2026-10-26T05:00:00Z'}),
  event('overlap',{starts_at:'2026-10-25T20:00:00Z',ends_at:'2026-10-26T05:00:01Z'}),
  event('monday',{starts_at:'2026-10-26T05:00:00Z'}),event('sunday-late',{starts_at:'2026-11-02T05:59:59Z'}),
  event('next-monday',{starts_at:'2026-11-02T06:00:00Z'}),event('old-point',{starts_at:'2026-10-26T04:59:59Z'}),event('zero',{starts_at:'2026-10-26T05:00:00Z',ends_at:'2026-10-26T05:00:00Z'})]);f.api.render();
 assert.deepEqual(f.rows('events').sort(),['monday','overlap','sunday-late','zero']);assert.match(f.section('events').textContent,/Private Office planning/);assert.match(f.section('events').textContent,/public iCloud/);assert.match(f.section('events').textContent,/Central/);
});

test('committee term review includes expired active rows and the inclusive 30-day boundary only',t=>{
 const f=fixture(t);f.state.sources.content.committees=source([committee('expired',{term_end:'2026-09-10'}),committee('today',{term_end:'2026-09-11'}),committee('thirty',{term_end:'2026-10-11'}),committee('later',{term_end:'2026-10-12'}),committee('undated'),committee('inactive',{status:'inactive',term_end:'2026-09-10'})]);f.api.render();
 assert.deepEqual(f.rows('committees'),['expired','today','thirty']);assert.match(f.section('committees').textContent,/Term ended — review/);assert.match(f.section('committees').textContent,/Term ending soon/);
});

test('incomplete sources keep other saved records visible and never turn unavailable into empty',t=>{
 const f=fixture(t);f.state.sources.content.announcements=source([announcement('one')]);f.state.sources.content.slides={available:false,items:[slide('must-hide')]};delete f.state.sources.content.committees;f.api.render();
 assert.equal(f.summaries.at(-1).knownItems,1);assert.equal(f.summaries.at(-1).unavailableSources,2);assert.match(f.host.textContent,/unavailable/);assert.doesNotMatch(f.host.textContent,/must-hide|No slide record is saved/);assert.equal(f.section('slides').querySelector('.week-count').textContent,'—');
 f.state.sources=empty();f.api.render();assert.equal(f.summaries.at(-1).unavailableSources,0);assert.equal(f.summaries.at(-1).knownItems,0);assert.match(f.section('slides').textContent,/No slide record is saved/);
});

test('malformed source rows and duplicates fail that section closed instead of hiding only the bad row',t=>{
 const cases=[['announcements',[announcement('bad',{starts_on:'2026-02-30'})]],['announcements',[announcement('bad',{status:'approved'})]],['announcements',[announcement('same'),announcement('same')]],['slides',[slide('bad',{hasMaterial:undefined})]],['slides',[slide('bad',{service_date:'2026-9-13'})]],['committees',[committee('bad',{term_start:'2026-10-01',term_end:'2026-09-01'})]],['events',[event('bad',{starts_at:'2026-02-30T12:00:00Z'})]],['events',[event('bad',{ends_at:'2026-09-10T12:00:00Z'})]]];
 for(const [kind,items] of cases){const f=fixture(t);if(kind==='events')f.state.sources.events=source(items);else f.state.sources.content[kind]=source(items);f.api.render();assert.equal(f.summaries.at(-1).unavailableSources,1);assert.equal(f.section(kind).querySelector('.week-count').textContent,'—');}
});

test('titles are literal text and extra people, body, contact, notes and file URL fields never enter the view',t=>{
 const f=fixture(t),hostile='<img src=x onerror="PRIVATE_HANDLER">',privateFields={body:'PRIVATE_CANARY',contact_name:'PRIVATE_CANARY',notes:'PRIVATE_CANARY',email:'PRIVATE_CANARY',deck_url:'https://private.invalid/PRIVATE_CANARY',storage_path:'PRIVATE_CANARY'};
 f.state.sources.content.announcements=source([announcement('a',{title:hostile,...privateFields})]);f.state.sources.content.slides=source([slide('s',privateFields)]);f.state.sources.content.committees=source([committee('c',{term_end:'2026-09-11',...privateFields})]);f.state.sources.events=source([event('e',privateFields)]);f.state.sources.prayers={request_text:'PRIVATE_CANARY'};f.api.render();
 assert.match(f.host.textContent,/<img src=x/);assert.equal(f.host.querySelector('img'),null);assert.equal(f.host.querySelector('a'),null);assert.doesNotMatch(f.host.textContent,/PRIVATE_CANARY/);assert.equal(f.opened.length,0);
});

test('blocked roles, missing readiness, paused editing and signout clear private rows without another source read',t=>{
 for(const change of [{userId:null},{role:'viewer'},{canEdit:false},{workspaceReady:false},{workspaceReady:undefined}]){const f=fixture(t);f.state.sources.content.announcements=source([announcement('private')]);f.api.render();const count=f.state.reads;f.setContext({...f.context(),...change});f.api.render();assert.equal(f.host.textContent,'');assert.equal(f.state.reads,count);assert.equal(f.summaries.at(-1),null);}
});

test('owner or same-owner epoch replacement clears prior text before another source can be read',t=>{
 for(const change of [{userId:'replacement'},{epoch:2}]){const f=fixture(t);f.state.sources.content.announcements=source([announcement('private')]);f.api.render();const count=f.state.reads;f.setContext({...f.context(),...change});f.api.render();assert.equal(f.host.textContent,'');assert.equal(f.state.reads,count);assert.equal(f.summaries.at(-1),null);}
});

test('refresh tokens suppress older completions and hide previous rows until the current load finishes',t=>{
 const f=fixture(t);f.state.sources.content.announcements=source([announcement('private')]);f.api.render();const count=f.state.reads,old=f.api.beginRefresh(),latest=f.api.beginRefresh();f.api.render();assert.equal(f.state.reads,count);assert.equal(f.host.querySelector('[data-week-id]'),null);assert.equal(f.summaries.at(-1),null);
 assert.equal(f.api.endRefresh(old),false);assert.equal(f.state.reads,count);f.state.sources.content.announcements=source([announcement('new')]);assert.equal(f.api.endRefresh(latest),true);assert.deepEqual(f.rows('announcements'),['new']);assert.equal(f.api.endRefresh(latest),false);
});

test('an auth change or explicit clear invalidates a pending refresh token',t=>{
 for(const mode of ['identity','clear']){const f=fixture(t);f.api.render();const token=f.api.beginRefresh();if(mode==='identity')f.setContext({...f.context(),epoch:2,userId:'replacement'});else f.api.clear();assert.equal(f.api.endRefresh(token),false);assert.equal(f.host.textContent,'');assert.equal(f.summaries.at(-1),null);}
});

test('source replacement during a read cannot put prior-owner rows into the view',t=>{
 const f=fixture(t);f.state.sources.content.announcements=source([announcement('private')]);f.state.beforeRead=()=>f.setContext({...f.context(),epoch:2,userId:'replacement'});f.api.render();assert.equal(f.host.textContent,'');assert.equal(f.summaries.at(-1),null);
});

test('each explicit action opens only its current original view/id and does not route or copy payloads',async t=>{
 const f=fixture(t);f.state.sources.content.announcements=source([announcement('a')]);f.state.sources.content.slides=source([slide('s')]);f.state.sources.content.committees=source([committee('c',{term_end:'2026-09-11'})]);f.state.sources.events=source([event('e')]);f.api.render();
 for(const [kind,id,view] of [['announcements','a','announcements'],['slides','s','slides'],['committees','c','committees'],['events','e','calendar']]){f.open(kind,id);await tick();assert.deepEqual(f.opened.at(-1),{view,id});}
 assert.equal(f.w.location.hash,'');assert.equal(f.opened.length,4);
});

test('action clicks re-read availability, identity, date relevance and current IDs before opening',async t=>{
 for(const mode of ['unavailable','removed','date','identity']){const f=fixture(t);f.state.sources.content.announcements=source([announcement('a')]);f.api.render();const button=f.section('announcements').querySelector('button');if(mode==='unavailable')f.state.sources.content.announcements.available=false;if(mode==='removed')f.state.sources.content.announcements.items=[];if(mode==='date')f.state.sources.content.announcements.items[0].starts_on='2026-09-21';if(mode==='identity')f.setContext({...f.context(),epoch:2});button.click();await tick();assert.equal(f.opened.length,0);}
});

test('pending source open cannot double-fire and late rejection cannot write into a replaced session',async t=>{
 const f=fixture(t);f.state.sources.content.announcements=source([announcement('a')]);let reject;f.state.open=()=>new Promise((_,no)=>{reject=no;});f.api.render();f.open('announcements','a');f.open('announcements','a');assert.equal(f.opened.length,1);f.setContext({...f.context(),epoch:2,userId:'replacement'});f.api.render();reject(Error('PRIVATE_CANARY'));await tick();assert.equal(f.host.textContent,'');assert.equal(f.summaries.at(-1),null);
});

test('source refusal does not navigate or alter saved data and a getter failure remains unavailable',async t=>{
 const f=fixture(t);f.state.sources.content.announcements=source([announcement('a')]);const original=plain(f.state.sources);f.state.open=()=>false;f.api.render();f.open('announcements','a');await tick();assert.equal(f.w.location.hash,'');assert.deepEqual(f.state.sources,original);f.state.beforeRead=()=>{throw Error('PRIVATE_CANARY');};f.api.render();assert.equal(f.summaries.at(-1).unavailableSources,4);assert.doesNotMatch(f.host.textContent,/PRIVATE_CANARY/);
});
