/* A private view of existing saved work. No second checklist, storage, or sends. */
(function (root) {
  'use strict';
  var names = {announcements:'Announcements',slides:'Sunday slides',events:'Staff planning',committees:'Committee terms'};
  function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && +value.slice(0,4)>0 && !isNaN(Date.parse(value+'T12:00:00Z')) && new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
  }
  function instant(value) { return typeof value==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && validDate(value.slice(0,10)) && Number.isFinite(Date.parse(value)); }
  function localParts(value) {
    var parts={};
    new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(value).forEach(function(p){parts[p.type]=p.value;});
    return {date:parts.year+'-'+parts.month+'-'+parts.day,clock:parts.hour+':'+parts.minute+':'+parts.second};
  }
  function addDays(day,number) { var date=new Date(day+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+number);return date.toISOString().slice(0,10); }
  function period(now) {
    var today=localParts(now).date;
    if(!validDate(today))throw new Error('Invalid church date');
    var weekday=new Date(today+'T12:00:00Z').getUTCDay(),start=addDays(today,-((weekday+6)%7)),end=addDays(start,6);
    return {today:today,weekStart:start,weekEnd:end,sunday:end,termThrough:addDays(today,30)};
  }
  function dateLabel(value,full) { return new Date(value+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',weekday:full?'long':undefined,month:full?'long':'short',day:'numeric',year:full?'numeric':undefined}); }
  function timeLabel(value) { return new Date(value).toLocaleString('en-US',{timeZone:'America/Chicago',weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}); }
  function optionalDate(value) { return value==null || validDate(value); }
  function text(value) { return typeof value==='string' && value.trim().length>0 && value.length<=400; }
  function validItems(source,kind) {
    if(!source || source.available!==true || !Array.isArray(source.items))return false;
    var seen=new Set();
    return source.items.every(function(row){
      if(!row || !text(row.id) || row.id.length>200 || seen.has(row.id) || !text(kind==='committees'?row.committee_name:row.title))return false;
      seen.add(row.id);
      if(kind==='events')return instant(row.starts_at) && (row.ends_at==null || instant(row.ends_at) && Date.parse(row.ends_at)>=Date.parse(row.starts_at));
      if(kind==='announcements')return ['draft','ready','archived'].includes(row.status) && optionalDate(row.starts_on) && optionalDate(row.ends_on) && !(row.starts_on && row.ends_on && row.ends_on<row.starts_on);
      if(kind==='slides')return ['draft','ready','archived'].includes(row.status) && validDate(row.service_date) && typeof row.hasMaterial==='boolean';
      return ['active','inactive'].includes(row.status) && optionalDate(row.term_start) && optionalDate(row.term_end) && !(row.term_start && row.term_end && row.term_end<row.term_start);
    });
  }
  function eventInWeek(row,week) {
    var start=localParts(new Date(row.starts_at)),startKey=start.date+'T'+start.clock;
    var from=week.weekStart+'T00:00:00',until=addDays(week.weekEnd,1)+'T00:00:00';
    if(startKey>=until)return false;
    if(row.ends_at && Date.parse(row.ends_at)>Date.parse(row.starts_at)) {
      var end=localParts(new Date(row.ends_at));return end.date+'T'+end.clock>from;
    }
    return startKey>=from;
  }
  function create(options) {
    var host=options.root,doc=host.ownerDocument,owner=null,epoch=null,serial=0,refreshing=false,opening=false;
    function context(){return options.getContext()||{};}
    function allowed(c){return !!c.userId && ['admin','editor'].includes(c.role) && c.canEdit===true && c.workspaceReady===true && options.isCurrent(c.epoch);}
    function same(e,u){var c=context();return allowed(c) && c.epoch===e && c.userId===u;}
    function summary(value){if(options.onSummary)options.onSummary(value);}
    function node(tag,value,className){var n=doc.createElement(tag);if(value!==undefined)n.textContent=value;if(className)n.className=className;return n;}
    function clear(){serial++;owner=null;epoch=null;refreshing=false;opening=false;host.replaceChildren();summary(null);}
    function read(){
      var data={};try{data=options.getSources()||{};}catch(_){}
      var content=data.content||{},week=period(options.now?options.now():new Date()),sources={announcements:content.announcements,slides:content.slides,committees:content.committees,events:data.events},items={};
      Object.keys(names).forEach(function(kind){
        var source=sources[kind];
        if(!validItems(source,kind)){items[kind]=null;return;}
        items[kind]=source.items.filter(function(row){
          if(kind==='announcements')return row.status!=='archived' && (!row.starts_on || row.starts_on<=week.weekEnd) && (!row.ends_on || row.ends_on>=week.weekStart);
          if(kind==='slides')return row.status!=='archived' && row.service_date===week.sunday;
          if(kind==='committees')return row.status==='active' && row.term_end && row.term_end<=week.termThrough;
          return eventInWeek(row,week);
        }).map(function(row){
          if(kind==='announcements')return {id:row.id,title:row.title,status:row.status,starts_on:row.starts_on||null,ends_on:row.ends_on||null};
          if(kind==='slides')return {id:row.id,title:row.title,status:row.status,service_date:row.service_date,hasMaterial:row.hasMaterial};
          if(kind==='committees')return {id:row.id,title:row.committee_name,term_end:row.term_end};
          return {id:row.id,title:row.title,starts_at:row.starts_at,ends_at:row.ends_at||null};
        }).sort(function(a,b){
          if(kind==='events')return Date.parse(a.starts_at)-Date.parse(b.starts_at)||a.id.localeCompare(b.id);
          if(kind==='committees')return a.term_end.localeCompare(b.term_end)||a.title.localeCompare(b.title);
          return (a.status==='draft'?0:1)-(b.status==='draft'?0:1)||a.title.localeCompare(b.title)||a.id.localeCompare(b.id);
        });
      });
      return {week:week,items:items};
    }
    function banner(week){
      var hero=node('header',undefined,'week-hero'),copy=node('div');
      copy.append(node('p','One shared view','eyebrow'),node('h2','This week at the Creek'),node('p','See what is saved, what is still a draft, and where to pick up the work.'));
      var date=node('div',undefined,'week-sunday');date.append(node('span','Sunday'),node('strong',dateLabel(week.sunday)),node('small',dateLabel(week.weekStart)+'–'+dateLabel(week.weekEnd)+' · Central'));
      hero.append(copy,date);host.append(hero);
    }
    function open(kind,id){
      var c=context(),e=c.epoch,u=c.userId;
      if(!allowed(c) || owner!==u || epoch!==e){clear();return false;}
      if(refreshing || opening)return false;
      var value;try{value=read();}catch(_){render();return false;}
      if(!same(e,u) || owner!==u || epoch!==e){clear();return false;}
      if(!value.items[kind] || !value.items[kind].some(function(row){return row.id===id;})){render();return false;}
      if(typeof options.onOpen!=='function')return false;
      var token=serial;opening=true;
      try{
        var result=options.onOpen(kind==='events'?'calendar':kind,id);
        Promise.resolve(result).catch(function(){if(same(e,u) && token===serial){var status=host.querySelector('[data-week-status]');if(status)status.textContent='This record could not be opened. Refresh the Office and try again.';}}).finally(function(){if(same(e,u) && token===serial)opening=false;});
        return result!==false;
      }catch(_){opening=false;if(same(e,u))render();return false;}
    }
    function item(kind,row,week){
      var li=node('li',undefined,'week-item');li.dataset.weekId=row.id;
      var body=node('div',undefined,'week-item-copy');body.append(node('h4',row.title));
      var label='',tag='',tone='';
      if(kind==='announcements'){
        tag=row.status==='ready'?'Ready for staff use':'Draft';tone=row.status;
        label=!row.starts_on&&!row.ends_on?'Dates not set — confirm when to use':(row.starts_on?'Starts '+dateLabel(row.starts_on):'Start date not set')+' · '+(row.ends_on?'Ends '+dateLabel(row.ends_on):'End date not set');
      }else if(kind==='slides'){
        tag=row.status==='ready'?'Ready':'Draft';tone=row.status;
        label=row.hasMaterial?'Deck link or document configured':'No deck link or available document';
      }else if(kind==='committees'){
        var ended=row.term_end<week.today;tag=ended?'Term ended — review':'Term ending soon';tone='review';label='Recorded term ends '+dateLabel(row.term_end);
      }else{tag='Staff planning';tone='planning';label=timeLabel(row.starts_at)+(row.ends_at?' – '+timeLabel(row.ends_at):'')+' Central';}
      body.append(node('span',tag,'week-tag '+tone),node('p',label,'week-item-meta'));
      var button=node('button',kind==='slides'?'Review slides':kind==='committees'?'Review term':'Open record','quiet');button.type='button';button.setAttribute('aria-label',(kind==='slides'?'Review slides: ':kind==='committees'?'Review committee term: ':'Open '+(kind==='events'?'staff event':'announcement')+': ')+row.title);button.dataset.weekOpen=kind;button.addEventListener('click',function(){open(kind,row.id);});
      li.append(body,button);return li;
    }
    function section(kind,rows,week){
      var section=node('section',undefined,'panel week-section');section.dataset.weekSection=kind;
      var head=node('div',undefined,'week-section-head');head.append(node('h3',names[kind]),node('span',rows===null?'—':String(rows.length),'week-count'));section.append(head);
      var descriptions={announcements:'Draft and ready announcements whose dates overlap this week; undated records stay visible for a date check. Ready does not mean published.',slides:'Saved records for '+dateLabel(week.sunday,true)+'. A configured link or document does not verify presentation access or playback.',events:'Private Office planning for Monday–Sunday. These records do not replace or publish the public iCloud church calendar.',committees:'Active committee records with a term already ended or ending in the next 30 days. Review the original contact record before changing a term.'};
      section.append(node('p',descriptions[kind],'week-section-note'));
      if(rows===null){section.classList.add('unavailable');section.append(node('p','Unavailable — refresh the Office to check these records.','week-empty'));return section;}
      if(!rows.length){var empty={announcements:'No dated or undated announcements match this week.',slides:'No slide record is saved for this Sunday.',events:'No saved staff planning records overlap this week.',committees:'No active committee terms are recorded as ended or ending within 30 days.'};section.append(node('p',empty[kind],'week-empty'));return section;}
      var list=node('ul',undefined,'week-list');rows.forEach(function(row){list.append(item(kind,row,week));});section.append(list);return section;
    }
    function render(){
      var c=context();
      if(!allowed(c) || owner!==null && (owner!==c.userId || epoch!==c.epoch)){clear();return;}
      owner=c.userId;epoch=c.epoch;host.replaceChildren();
      if(refreshing){var loading=node('p','Refreshing the shared week from saved records…','week-loading');loading.setAttribute('role','status');host.append(loading);summary(null);return;}
      var value;try{value=read();}catch(_){host.append(node('p','The week could not be checked. Refresh the Office and try again.','week-loading'));summary(null);return;}
      if(!same(epoch,owner)){clear();return;}
      banner(value.week);
      var missing=Object.keys(names).filter(function(kind){return value.items[kind]===null;}),known=Object.keys(names).reduce(function(total,kind){return total+(value.items[kind]?value.items[kind].length:0);},0);
      var status=node('p',missing.length?known+' saved records shown; '+missing.map(function(kind){return names[kind];}).join(', ')+' unavailable. Refresh before treating this as a complete view.':known+' saved records in this view. Changes appear after the Office refreshes.','week-status');status.dataset.weekStatus='';status.setAttribute('role','status');host.append(status);
      var grid=node('div',undefined,'week-grid');Object.keys(names).forEach(function(kind){grid.append(section(kind,value.items[kind],value.week));});host.append(grid);
      var note=node('p','Keep decisions in the original records. This view does not publish announcements, send messages, approve documents, or mark work completed.','week-footnote');host.append(note);
      summary({weekStart:value.week.weekStart,weekEnd:value.week.weekEnd,sunday:value.week.sunday,knownItems:known,unavailableSources:missing.length});
    }
    function beginRefresh(){var c=context();if(!allowed(c)){clear();return null;}if(owner!==null&&(owner!==c.userId||epoch!==c.epoch))clear();owner=c.userId;epoch=c.epoch;refreshing=true;opening=false;var token=++serial;render();return token;}
    function endRefresh(token){if(token!==serial || !refreshing)return false;var c=context();if(!allowed(c)||owner!==c.userId||epoch!==c.epoch){clear();return false;}refreshing=false;render();return true;}
    return {render:render,clear:clear,beginRefresh:beginRefresh,endRefresh:endRefresh};
  }
  root.CreekWeek={create:create};
}(typeof window!=='undefined'?window:globalThis));
