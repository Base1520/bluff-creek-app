/* Derived private attention queue. Opening a source never completes work or sends mail. */
(function(root){
  'use strict';
  var reasons={
    intake_overdue:'Intake follow-up overdue',intake_due_today:'Intake follow-up due today',intake_unassigned:'Needs a follow-up owner',recipient_setup:'Notification recipient needs setup',
    notice_attention:'Staff notification needs review',notice_waiting:'Staff notification waiting 30+ minutes',welcome_attention:'Welcome email needs review',welcome_waiting:'Welcome email waiting 30+ minutes',
    care_overdue:'Care contact overdue',care_due_today:'Care contact due today',care_unassigned:'Care plan needs an owner',care_unscheduled:'Care plan needs a date',care_coverage_gap:'Recurring care coverage needs review',
    leader_overdue:'Your leader check-in is overdue',leader_due_today:'Your leader check-in is due today',leader_unscheduled:'Your leader check-in needs a date'
  };
  var types={intake:'Review action',registration:'Review guest',care_plan:'Open care plan',care_coverage:'Review care coverage',leader:'Record leader contact'};
  var groups={intake:'Intake & notifications',care:'Member care',leaders:'Your leader check-ins'};
  var roleLabels={deacon:'Deacon',sunday_school:'Sunday school',welcome:'Welcome',pastoral:'Pastoral care',custom:'Additional care'};
  function create(options){
    var host=options.root,doc=host.ownerDocument,remote=null,mounted=false,owner=null,epoch=null,serial=0,busy=false,localRefreshing=false,error='',search='',filter='all',limit=60;
    function context(){return options.getContext()||{};}
    function current(e,u){var c=context();return !!u&&c.epoch===e&&c.userId===u&&['admin','editor'].includes(c.role)&&c.canEdit===true&&c.workspaceReady===true&&options.isCurrent(e);}
    function safe(v){var n=doc.createElement('span');n.textContent=v==null?'':String(v);return n.innerHTML.replace(/"/g,'&quot;');}
    function day(v){return typeof v==='string'&&/^\d{4}-\d\d-\d\d$/.test(v)&&!isNaN(Date.parse(v+'T12:00:00Z'))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v;}
    function instant(v){return typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)&&Number.isFinite(Date.parse(v));}
    function id(v){return typeof v==='string'&&v.length>0&&v.length<=200&&!/[\x00-\x1f\x7f]/.test(v);}
    function text(v,max){return typeof v==='string'&&Array.from(v).length<=max;}
    function dateToday(){return remote?remote.today:new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
    function dateLabel(v){return day(v)?new Date(v+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'}):'Date not set';}
    function timeLabel(v){return new Date(v).toLocaleString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' Central';}
    function allowedReason(value,group){return Object.hasOwn(reasons,value)&&(group==='intake'?/^(intake_|recipient_setup$|notice_|welcome_)/.test(value):group==='care'?value.startsWith('care_'):value.startsWith('leader_'));}
    function validItems(items,group){
      if(!Array.isArray(items)||items.length>5000)return false;var keys=new Set();
      return items.every(function(r){
        if(!r||!id(r.key)||keys.has(r.key)||!id(r.source_id)||!Object.hasOwn(types,r.source_type)||!text(r.title,400)||!r.title.trim()||!text(r.owner_label,400)||!r.owner_label.trim()||r.due_on!==null&&!day(r.due_on)||!Array.isArray(r.reasons)||!r.reasons.length||new Set(r.reasons).size!==r.reasons.length||!r.reasons.every(function(v){return allowedReason(v,group);}))return false;
        keys.add(r.key);
        if(group==='intake')return ['intake','mail'].includes(r.category)&&['intake','registration'].includes(r.source_type)&&r.contact_id===null&&r.care_role===null;
        if(group==='care')return r.category==='care'&&['care_plan','care_coverage'].includes(r.source_type)&&id(r.contact_id)&&Object.hasOwn(roleLabels,r.care_role);
        return r.category==='leaders'&&r.source_type==='leader'&&r.contact_id===null&&r.care_role===null&&r.owner_label==='You';
      });
    }
    function cleaned(items){return items.map(function(r){return {key:r.key,category:r.category,source_type:r.source_type,source_id:r.source_id,contact_id:r.contact_id,care_role:r.care_role,title:r.title,owner_label:r.owner_label,due_on:r.due_on,reasons:r.reasons.slice()};});}
    function sources(){
      var local={};if(!localRefreshing){try{local=options.getSources?options.getSources(dateToday())||{}:{};}catch(_){}}
      return {intake:remote?remote.items:null,care:local.care&&validItems(local.care.items,'care')?cleaned(local.care.items):null,leaders:local.leaders&&validItems(local.leaders.items,'leaders')?cleaned(local.leaders.items):null};
    }
    function summary(value){if(options.onSummary)options.onSummary(value);}
    function clear(){serial++;remote=null;mounted=false;owner=null;epoch=null;busy=false;localRefreshing=false;error='';search='';filter='all';limit=60;host.replaceChildren();summary(null);}
    function mount(){
      if(mounted)return;
      host.innerHTML='<header class="attention-hero"><p class="eyebrow">Care has a next step</p><h2>The next right thing.</h2><p>Bring guest follow-ups, member care and your own leader check-ins into one view. Resolve each item in its original record.</p></header><div class="attention-health" data-attention-health></div><div class="attention-toolbar"><label>Search this queue<input type="search" data-attention-search placeholder="Person, role or reason"></label><label>Focus<select data-attention-filter><option value="all">Everything needing attention</option><option value="overdue">Overdue contacts</option><option value="today">Contacts due today</option><option value="messages">Notification problems</option><option value="assignments">Owners, dates &amp; coverage</option><option value="leaders">My leader check-ins</option></select></label><button type="button" class="quiet" data-attention-refresh>Refresh all queues</button></div><p class="attention-status" role="status" data-attention-status></p><div class="attention-list" data-attention-list></div><button type="button" class="quiet attention-more" data-attention-more hidden>Show more items</button><section class="panel attention-guide"><h3>Keep the record with the work.</h3><p>A call attempt, a completed conversation and an accepted email are different outcomes. Opening an item does not complete it, reassign it or resend a message. Completed or corrected work leaves this queue after its source refreshes.</p><p>These are on-screen reminders while the Office is open. A message waiting 30 minutes deserves review; that threshold does not prove a delivery failure. Calendar freshness, backups and email-provider delivery feedback are separate checks. A clear queue does not certify those systems.</p></section>';
      host.querySelector('[data-attention-search]').value=search;host.querySelector('[data-attention-filter]').value=filter;
      host.querySelector('[data-attention-search]').oninput=function(e){search=e.target.value;limit=60;render();};host.querySelector('[data-attention-filter]').onchange=function(e){filter=e.target.value;limit=60;render();};
      host.querySelector('[data-attention-refresh]').onclick=refresh;host.querySelector('[data-attention-more]').onclick=function(){limit+=60;render();};
      var c=context();mounted=true;owner=c.userId;epoch=c.epoch;
    }
    function beginRefresh(){var c=context();if(!current(c.epoch,c.userId)){clear();return;}if(mounted&&(owner!==c.userId||epoch!==c.epoch))clear();serial++;remote=null;busy=true;localRefreshing=true;error='';mount();render();}
    function matches(r){
      var reason=r.reasons;
      return (filter==='all'||filter==='overdue'&&reason.some(function(v){return v.endsWith('_overdue');})||filter==='today'&&reason.some(function(v){return v.endsWith('_due_today');})||filter==='messages'&&reason.some(function(v){return /^(notice_|welcome_)/.test(v);})||filter==='assignments'&&reason.some(function(v){return /(_unassigned|_unscheduled|_coverage_gap)$|^recipient_setup$/.test(v);})||filter==='leaders'&&r.category==='leaders')&&(!search.trim()||[r.title,r.owner_label,roleLabels[r.care_role],reason.map(function(v){return reasons[v];}).join(' ')].join(' ').toLowerCase().includes(search.trim().toLowerCase()));
    }
    function priority(r){return r.reasons.some(function(v){return /_attention$/.test(v);})?0:r.reasons.some(function(v){return v.endsWith('_overdue');})?1:2;}
    function guidance(r){
      if(r.reasons.some(function(v){return /^(notice_|welcome_)/.test(v);}))return 'Review the recipient and notification state. Check the delivery issue before considering a resend; provider acceptance is not inbox delivery.';
      if(r.category==='leaders')return 'Record the conversation or attempt in your private follow-up. A snooze does not count as a contact.';
      if(r.category==='care')return 'Review this person’s role-specific care plan. Keep Sunday school and deacon contacts separate.';
      return 'Review the owner, due date and actual follow-up. A deacon name alone does not set up a notification recipient.';
    }
    function render(){
      var c=context();if(!current(c.epoch,c.userId)||mounted&&(owner!==c.userId||epoch!==c.epoch)){clear();return;}mount();
      var values=sources(),missing=Object.keys(groups).filter(function(g){return values[g]===null;}),items=[];
      Object.keys(groups).forEach(function(g){if(values[g])values[g].forEach(function(r){r.group=g;items.push(r);});});
      summary({count:missing.length?null:items.length,known:items.length,unavailable:missing.length});
      var health=host.querySelector('[data-attention-health]');health.replaceChildren();
      Object.keys(groups).forEach(function(g){var card=doc.createElement('article');card.className=values[g]===null?'attention-source unavailable':'attention-source';card.innerHTML='<h3>'+safe(groups[g])+'</h3><strong>'+ (values[g]===null?'—':values[g].length)+'</strong><p>'+safe(values[g]===null?(localRefreshing?'Refreshing…':g==='intake'&&error==='not_enabled'?'Awaiting the reviewed intake check':'Unavailable — refresh to check'):g==='intake'?'Checked '+timeLabel(remote.generated_at):'From the currently loaded private records')+'</p>';health.appendChild(card);});
      host.querySelector('[data-attention-refresh]').disabled=busy;
      var list=items.filter(matches).sort(function(a,b){return priority(a)-priority(b)||String(a.due_on||'9999').localeCompare(String(b.due_on||'9999'))||a.title.localeCompare(b.title)||a.key.localeCompare(b.key);});
      host.querySelector('[data-attention-status]').textContent=localRefreshing?'Refreshing the source queues…':missing.length?items.length+' known item'+(items.length===1?'':'s')+'; '+missing.map(function(g){return groups[g];}).join(', ')+' unavailable. This is not a complete all-clear.':items.length+' item'+(items.length===1?'':'s')+' across these three queues. '+list.length+' match this view. Counts describe records, not unique people.';
      var area=host.querySelector('[data-attention-list]');area.replaceChildren();
      if(!list.length){var empty=doc.createElement('div');empty.className='panel attention-empty';empty.textContent=missing.length?'No matching items in the queues that loaded. Refresh the unavailable sections before drawing a conclusion.':items.length?'Nothing matches this filter. Choose another focus or clear the search.':'No items need attention in these three queues right now.';area.appendChild(empty);}
      list.slice(0,limit).forEach(function(r){var card=doc.createElement('article');card.className='panel attention-item';card.dataset.attentionKey=r.key;card.innerHTML='<div class="attention-item-main"><p class="eyebrow">'+safe(groups[r.group])+(r.care_role?' · '+safe(roleLabels[r.care_role]):'')+'</p><h3>'+safe(r.title)+'</h3><ul class="attention-reasons">'+r.reasons.map(function(v){return '<li>'+safe(reasons[v])+'</li>';}).join('')+'</ul><p class="attention-owner">'+safe(r.category==='care'?'Recorded owner: ':'Owner: ')+safe(r.owner_label)+(r.due_on?' · '+safe(dateLabel(r.due_on)):'')+'</p><p class="attention-next">'+safe(guidance(r))+'</p></div><button type="button" class="quiet" data-attention-open>'+safe(types[r.source_type])+'</button>';
        card.querySelector('button').onclick=function(){openSource(r);};area.appendChild(card);
      });
      var more=host.querySelector('[data-attention-more]');more.hidden=list.length<=limit;more.textContent='Show more items ('+Math.min(limit,list.length)+' of '+list.length+')';
    }
    function openSource(item){
      var c=context();if(!current(c.epoch,c.userId)||busy||owner!==c.userId||epoch!==c.epoch)return;
      var values=sources(),latest=values[item.group]&&values[item.group].find(function(r){return r.key===item.key&&r.source_type===item.source_type&&r.source_id===item.source_id;});
      if(!latest){render();return;}if(options.openSource&&options.openSource(latest,dateToday())===false){if(options.notice)options.notice('That source could not be opened. Refresh the queues before continuing.');}
    }
    function deadline(p){var timer;return Promise.race([p,new Promise(function(_resolve,reject){timer=root.setTimeout(function(){reject(new Error('timeout'));},12000);})]).finally(function(){root.clearTimeout(timer);});}
    async function load(e){
      var u=context().userId;if(!current(e,u)){clear();return false;}if(mounted&&(owner!==u||epoch!==e))clear();mount();var token=++serial;remote=null;busy=true;localRefreshing=false;error='';render();
      try{
        var result=await deadline(Promise.resolve().then(function(){return options.db.rpc('get_office_attention',{});}));if(!current(e,u)||token!==serial)return false;
        if(result.error){error=result.error.code==='PGRST202'?'not_enabled':'unavailable';throw new Error('unavailable');}
        var value=result.data;if(!value||value.version!==1||!instant(value.generated_at)||!day(value.today)||value.waiting_minutes!==30||!Number.isSafeInteger(value.total)||value.total<0||value.total>5000||!Array.isArray(value.items)||value.total!==value.items.length||!validItems(value.items,'intake'))throw new Error('incomplete');
        remote={generated_at:value.generated_at,today:value.today,items:cleaned(value.items)};return true;
      }catch(_){if(current(e,u)&&token===serial){remote=null;if(!error)error='unavailable';}return false;}
      finally{if(token===serial){if(current(e,u)){busy=false;render();}else clear();}}
    }
    async function refresh(){var c=context();if(busy||!current(c.epoch,c.userId))return;beginRefresh();try{await options.refresh();}catch(_){if(current(c.epoch,c.userId)){busy=false;localRefreshing=false;error='unavailable';render();}}finally{if(current(c.epoch,c.userId)&&localRefreshing){busy=false;localRefreshing=false;render();}}}
    return {load:load,render:render,clear:clear,beginRefresh:beginRefresh};
  }
  root.CreekAttention={create:create};
}(typeof window!=='undefined'?window:globalThis));
