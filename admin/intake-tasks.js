/* Private durable actions. Source submissions create tasks; this UI never creates them. */
(function(root){
  'use strict';
  var kinds={guest_followup:'Guest follow-up',prayer_care:'Prayer care'},statuses={new:'New',in_progress:'In progress',completed:'Completed'},mail={queued:'Queued',sending:'Sending',sent:'Provider accepted',attention:'Needs attention'};
  function create(options){
    var host=options.root,doc=host.ownerDocument,rows=[],settings=null,ready=false,mounted=false,mountedOwner=null,mountedEpoch=null,loadId=0,dialog=null,draft=null,formId=0,filter='open',search='';
    function context(){return options.getContext()||{};}
    function identity(epoch,owner){var c=context();return c.epoch===epoch && c.userId===owner && !!owner && ['admin','editor'].includes(c.role) && options.isCurrent(epoch);}
    function current(epoch,owner){return identity(epoch,owner) && context().canEdit===true && context().workspaceReady!==false;}
    function safe(value){var node=doc.createElement('span');node.textContent=value==null?'':String(value);return node.innerHTML.replace(/"/g,'&quot;');}
    function day(value){return typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(new Date(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}
    function slotNumber(value){return Number.isInteger(value)&&value>=1&&value<=5;}
    function uuid(value){return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);}
    function validName(value){return value===null||typeof value==='string'&&value===value.trim()&&value.length>0&&value.length<=100&&!/[<>\x00-\x1f\x7f]/.test(value);}
    function rotationEnabled(){return !!(settings&&settings.deacon_rotation&&settings.deacon_rotation.enabled===true);}
    function deaconFor(slot){return rotationEnabled()?settings.deacons.find(function(d){return d.slot===slot;}):null;}
    function deaconLabel(slot){var d=deaconFor(slot);return 'Deacon '+slot+(d&&d.display_name?' · '+d.display_name:'');}
    function ownerLabel(row){return row.deacon_slot!=null?deaconLabel(row.deacon_slot):staffLabel(row.assigned_staff_user_id);}
    function adminMode(mode){return mode==='route'||mode==='deacon';}
    function findItem(mode,id){return mode==='deacon'?(rotationEnabled()?settings.deacons.find(function(r){return r.slot===id;}):null):mode==='route'?settings.routes.find(function(r){return r.kind===id;}):rows.find(function(r){return r.id===id;});}
    function modeAvailable(mode,id){if(mode==='deacon')return rotationEnabled();return !(mode==='route'&&id==='guest_followup'&&rotationEnabled());}
    function payloadMatches(state,item){return Object.keys(state.payload).every(function(k){
      // A slot request leaves notification resolution to the server; null is a
      // placeholder, not a requested Office override. Completed recipients may
      // intentionally differ from a slot's later notification setting.
      if(state.mode==='task'&&state.payload.deacon_slot!=null&&k==='assigned_staff_user_id')return true;
      return (item[k]==null?null:item[k])===state.payload[k];
    });}
    function today(){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
    function dayLabel(value){return day(value)?new Date(value+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'}):'Date unavailable';}
    function instantLabel(value){var d=new Date(value);return value&&!isNaN(d)?d.toLocaleDateString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',year:'numeric'}):'Not recorded';}
    function deadline(promise){var timer;return Promise.race([Promise.resolve(promise),new Promise(function(_resolve,reject){timer=root.setTimeout(function(){reject(new Error('timeout'));},12000);})]).finally(function(){root.clearTimeout(timer);});}
    function rpc(name,args){return Promise.resolve().then(function(){return options.db.rpc(name,args);});}
    function values(){var result={};if(dialog)dialog.querySelectorAll('[name]').forEach(function(n){result[n.name]=n.value;});return result;}
    function fingerprint(){return JSON.stringify(values());}
    function dirty(){return !!(draft && dialog && (draft.busy || draft.pending || draft.requiresRefresh || draft.conflict || draft.payload || fingerprint()!==draft.initial));}
    function unload(event){if(dirty()){event.preventDefault();event.returnValue=true;}}
    function syncUnload(){root[dirty()?'addEventListener':'removeEventListener']('beforeunload',unload);}
    function close(force){
      var state=draft,version=formId;if(force!==true && draft && (draft.busy||draft.pending))return false;
      if(force!==true && dirty() && !root.confirm('Discard these unsaved action changes? If a save was uncertain, check the current record before editing again.'))return false;
      if(force!==true && (draft!==state || formId!==version || draft && (draft.busy||draft.pending)))return false;
      draft=null;formId++;if(dialog){if(dialog.open)dialog.close();dialog.remove();dialog=null;}syncUnload();return true;
    }
    function summary(value){if(options.onSummary)options.onSummary(value);}
    function clear(){loadId++;close(true);rows=[];settings=null;ready=false;mounted=false;mountedOwner=null;mountedEpoch=null;filter='open';search='';host.replaceChildren();summary(null);}
    function unavailable(message){rows=[];settings=null;ready=false;summary(null);mount();host.querySelector('[data-intake-status]').textContent=message||'Intake actions are unavailable. Refresh when the reviewed intake service is ready.';host.querySelector('[data-intake-list]').replaceChildren();host.querySelector('[data-intake-routes]').replaceChildren();var panel=host.querySelector('[data-intake-deacons]');panel.replaceChildren();panel.hidden=true;syncEditor();}
    function mount(){
      if(mounted)return;host.innerHTML='<div class="intake-intro"><p class="eyebrow">Every submission has a next step</p><h2>Care starts here.</h2><p class="intake-note">Guest registrations and private app prayers create durable actions when the intake service is enabled. New actions route to the Office until an approved staff route is selected. A staff assignment does not make someone a deacon or grant access.</p></div><div class="intake-toolbar"><label>Search actions<input type="search" data-intake-search placeholder="Source, action, owner or status"></label><label>Show<select data-intake-filter><option value="open">Open actions</option><option value="new">New actions</option><option value="due">Due &amp; overdue</option><option value="completed">Completed</option><option value="all">All actions</option></select></label><button type="button" class="quiet" data-intake-refresh>Refresh actions</button></div><p role="status" class="intake-status" data-intake-status></p><div class="panel intake-list" data-intake-list></div><section class="panel intake-routes" data-intake-routes></section>';
      host.querySelector('[data-intake-search]').value=search;host.querySelector('[data-intake-filter]').value=filter;
      host.querySelector('[data-intake-search]').oninput=function(e){search=e.target.value;render();};host.querySelector('[data-intake-filter]').onchange=function(e){filter=e.target.value;render();};host.querySelector('[data-intake-refresh]').onclick=refresh;
      var panel=doc.createElement('section');panel.className='panel intake-deacons';panel.dataset.intakeDeacons='';panel.hidden=true;host.querySelector('.intake-intro').after(panel);
      var c=context();mounted=true;mountedOwner=c.userId;mountedEpoch=c.epoch;
    }
    function validSettings(value){
      if(!value || value.version!==1 || !Array.isArray(value.routes) || value.routes.length!==2 || !Array.isArray(value.staff))return false;
      var seen=new Set();if(!value.routes.every(function(r){if(!r || !Object.hasOwn(kinds,r.kind) || seen.has(r.kind) || !Number.isSafeInteger(r.version) || r.version<1 || r.assigned_staff_user_id!==null && typeof r.assigned_staff_user_id!=='string')return false;seen.add(r.kind);return true;}))return false;
      seen=new Set();if(!value.staff.every(function(p){if(!p || typeof p.id!=='string' || !p.id || typeof p.label!=='string' || !p.label || seen.has(p.id))return false;seen.add(p.id);return true;}))return false;
      if(!Object.hasOwn(value,'deacons')&&!Object.hasOwn(value,'deacon_rotation'))return true;
      if(!Array.isArray(value.deacons)||value.deacons.length!==5||!value.deacon_rotation||value.deacon_rotation.enabled!==true||!slotNumber(value.deacon_rotation.next_slot))return false;
      seen=new Set();return value.deacons.every(function(d){if(!d||!slotNumber(d.slot)||seen.has(d.slot)||!validName(d.display_name)||!Number.isSafeInteger(d.version)||d.version<1||d.assigned_staff_user_id!==null&&!uuid(d.assigned_staff_user_id))return false;seen.add(d.slot);return true;});
    }
    function validTask(r){return r && typeof r.id==='string' && r.id && Object.hasOwn(kinds,r.kind) && Object.hasOwn(statuses,r.status) && Object.hasOwn(mail,r.notification_status) && Number.isSafeInteger(r.version) && r.version>0 && day(r.due_on) && (r.assigned_staff_user_id===null || typeof r.assigned_staff_user_id==='string') && r.routing===(r.assigned_staff_user_id?'staff':'office') && (r.deacon_slot==null||slotNumber(r.deacon_slot)&&r.kind==='guest_followup'&&(r.assigned_staff_user_id===null||uuid(r.assigned_staff_user_id))) && (r.kind==='guest_followup'?typeof r.registration_id==='string' && r.registration_id && r.prayer_request_id===null:typeof r.prayer_request_id==='string' && r.prayer_request_id && r.registration_id===null);}
    async function taskRows(epoch,owner,token){
      var all=[],total=null,offset=0,seen=new Set();
      while(current(epoch,owner) && loadId===token){
        var q=options.db.from('app_submission_tasks').select('*',{count:'exact'}).order('created_at',{ascending:false}).order('id',{ascending:true}),paged=typeof q.range==='function';
        var result=await deadline(paged?q.range(offset,offset+999):q);if(!current(epoch,owner)||loadId!==token)return null;
        if(result.error)throw result.error;
        if(!Array.isArray(result.data)||!Number.isSafeInteger(result.count)||result.count<0||total!==null&&result.count!==total)throw new Error('incomplete');total=result.count;
        result.data.forEach(function(r){if(!validTask(r)||seen.has(r.id))throw new Error('incomplete');seen.add(r.id);});all=all.concat(result.data);offset+=result.data.length;
        if(offset>total || offset<total&&(!result.data.length||!paged))throw new Error('incomplete');if(offset===total)return all;
      }return null;
    }
    async function load(epoch){
      var owner=context().userId;if(!identity(epoch,owner)){clear();return false;}if(mounted && (mountedEpoch!==epoch||mountedOwner!==owner))clear();if(!current(epoch,owner)){unavailable();return false;}mount();
      var token=++loadId,state=draft,revision=state&&state.revision;
      try{
        var cap=await deadline(rpc('direct_intake_readiness',{}));if(!current(epoch,owner)||token!==loadId)return false;
        if(cap.error && ['42501','PGRST301','PGRST302'].includes(cap.error.code)){clear();return false;}
        if(cap.error || !cap.data || cap.data.available!==true || cap.data.version!==1 || cap.data.tasks!==true || cap.data.routes!==true){unavailable();return false;}
        var results=await Promise.all([deadline(rpc('get_intake_settings',{})),taskRows(epoch,owner,token)]);if(!current(epoch,owner)||token!==loadId)return false;
        if(results[0].error)throw results[0].error;if(!validSettings(results[0].data)||!Array.isArray(results[1])||results[1].some(function(r){return r.deacon_slot!=null&&!results[0].data.deacon_rotation;}))throw new Error('incomplete');settings=results[0].data;rows=results[1];ready=true;
        if(draft && !draft.busy){
          var latest=findItem(draft.mode,draft.id);
          if(draft!==state || draft.revision!==revision || draft.pending)draft.requiresRefresh=true;
          else if(!latest||!modeAvailable(draft.mode,draft.id)||draft.kind==='guest_followup'&&draft.rotation!==rotationEnabled())draft.conflict=true;
          else if(draft.payload && latest.version>draft.version && payloadMatches(draft,latest)){close(true);options.notice('The refreshed action, route or deacon slot matches the submitted changes.');}
          else if(latest.version!==draft.version)draft.conflict=true;else draft.requiresRefresh=false;
        }
        render();syncEditor();return true;
      }catch(error){if(identity(epoch,owner)&&token===loadId){if(error&&['42501','PGRST301','PGRST302'].includes(error.code)){clear();return false;}unavailable('Intake actions could not refresh. Existing drafts are retained; no partial action count is shown.');}return false;}
    }
    function staffLabel(id){if(!id)return 'Office queue';var person=settings&&settings.staff.find(function(p){return p.id===id;});return person?person.label:'Assigned staff no longer eligible';}
    function sourceId(row){return row.kind==='guest_followup'?row.registration_id:row.prayer_request_id;}
    function sourceLabel(row){return options.sourceLabel && options.sourceLabel(row.kind,sourceId(row)) || (row.kind==='guest_followup'?'Guest registration':'Private prayer request');}
    function matches(row){return (filter==='all' || filter==='completed'&&row.status==='completed' || filter==='new'&&row.status==='new' || filter==='open'&&row.status!=='completed' || filter==='due'&&row.status!=='completed'&&row.due_on<=today()) && (!search.trim() || [sourceLabel(row),kinds[row.kind],statuses[row.status],ownerLabel(row),staffLabel(row.assigned_staff_user_id),row.due_on,mail[row.notification_status]].join(' ').toLowerCase().includes(search.trim().toLowerCase()));}
    function renderDeacons(){
      var panel=host.querySelector('[data-intake-deacons]');panel.replaceChildren();panel.hidden=!rotationEnabled();if(panel.hidden)return;
      panel.innerHTML='<header class="intake-deacon-heading"><div><p class="eyebrow">A shared ministry of welcome</p><h3>Five deacons. Every guest.</h3></div><span class="intake-next" data-intake-next></span></header><p class="intake-note">New guests rotate through Deacons 1–5 in order. The deacon slot owns the follow-up; its approved Office recipient receives the notification. Names are optional. Setting a recipient does not create an account or grant access.</p><div class="intake-deacon-grid" data-intake-deacon-grid></div>';
      panel.querySelector('[data-intake-next]').textContent='Next up: '+deaconLabel(settings.deacon_rotation.next_slot);
      settings.deacons.slice().sort(function(a,b){return a.slot-b.slot;}).forEach(function(d){
        var card=doc.createElement('article');card.className='intake-deacon-card'+(d.slot===settings.deacon_rotation.next_slot?' is-next':'');card.dataset.intakeDeaconSlot=d.slot;
        var count=rows.filter(function(r){return r.deacon_slot===d.slot&&r.status!=='completed';}).length;
        card.innerHTML='<div class="intake-deacon-top"><span class="intake-slot-number" aria-hidden="true">'+d.slot+'</span>'+(d.slot===settings.deacon_rotation.next_slot?'<span class="intake-next-label">Next guest</span>':'')+'</div><h4>'+safe(deaconLabel(d.slot))+'</h4><p class="intake-deacon-count"><strong data-intake-deacon-count>'+count+'</strong> open '+(count===1?'action':'actions')+'</p><p class="intake-note">'+(d.assigned_staff_user_id?'Notification recipient: '+safe(staffLabel(d.assigned_staff_user_id)):'<strong>Needs deacon notification setup</strong><br>Office fallback')+'</p>';
        if(context().role==='admin'){var edit=doc.createElement('button');edit.type='button';edit.className='quiet';edit.textContent='Edit slot';edit.setAttribute('aria-label','Edit Deacon '+d.slot+' slot');edit.dataset.intakeDeacon=d.slot;edit.onclick=function(){open('deacon',d.slot);};card.appendChild(edit);}panel.querySelector('[data-intake-deacon-grid]').appendChild(card);
      });
    }
    function render(){
      var c=context();if(!identity(c.epoch,c.userId)){clear();return;}if(mounted&&(mountedOwner!==c.userId||mountedEpoch!==c.epoch))clear();if(!current(c.epoch,c.userId)){unavailable();return;}mount();if(!ready){unavailable();return;}
      host.querySelector('.intake-intro .intake-note').textContent=rotationEnabled()?'Guest follow-up is shared across five deacon slots. Private prayers follow their selected route. Track the owner, due date and next step here.':'Guest registrations and private app prayers create durable actions when the intake service is enabled. New actions route to the Office until an approved staff route is selected. A staff assignment does not make someone a deacon or grant access.';
      renderDeacons();
      var active=rows.filter(function(r){return r.status!=='completed';});summary({new:active.filter(function(r){return r.status==='new';}).length,due:active.filter(function(r){return r.due_on<=today();}).length,open:active.length});
      var list=rows.filter(matches).sort(function(a,b){return a.due_on.localeCompare(b.due_on)||String(a.created_at).localeCompare(String(b.created_at))||a.id.localeCompare(b.id);});
      host.querySelector('[data-intake-status]').textContent='Loaded '+rows.length+' durable actions. Counts refresh while this workspace is open. Email “Provider accepted” is not confirmed delivery.';
      var area=host.querySelector('[data-intake-list]');area.replaceChildren();if(!list.length){var empty=doc.createElement('p');empty.className='intake-note';empty.textContent='No actions match this view.';area.appendChild(empty);}else{
        var table=doc.createElement('table');table.className='intake-table';table.innerHTML='<caption>'+list.length+' matching actions'+(list.length>100?' · Showing first 100; narrow the search':'')+'</caption><thead><tr><th scope="col">Action / source</th><th scope="col">Owner</th><th scope="col">Due (Central)</th><th scope="col">Status</th><th scope="col">Staff notification</th><th scope="col">Actions</th></tr></thead><tbody></tbody>';
        list.slice(0,100).forEach(function(r){var tr=doc.createElement('tr');tr.dataset.intakeRow=r.id;tr.innerHTML='<td><strong>'+safe(kinds[r.kind])+'</strong><p>'+safe(sourceLabel(r))+'</p><small>Received '+safe(instantLabel(r.created_at))+'</small></td><td>'+safe(ownerLabel(r))+'</td><td>'+safe(dayLabel(r.due_on))+(r.status!=='completed'&&r.due_on<today()?'<p>Overdue</p>':'')+'</td><td>'+safe(statuses[r.status])+(r.status==='completed'?'<p>Completed '+safe(instantLabel(r.completed_at))+'</p>':'')+'</td><td>'+safe(mail[r.notification_status])+(r.deacon_slot!=null?'<p class="intake-note">'+(r.assigned_staff_user_id?'Notification recipient: '+safe(staffLabel(r.assigned_staff_user_id)):'Needs deacon notification setup · Office fallback')+'</p>':'')+'</td><td></td>';var actions=tr.lastElementChild;
          var source=doc.createElement('button');source.type='button';source.className='quiet';source.textContent='Open source';source.dataset.intakeSource=r.id;source.onclick=function(){var c=context();if(mountedOwner===c.userId&&mountedEpoch===c.epoch&&current(c.epoch,c.userId)&&ready&&rows.some(function(x){return x.id===r.id;})&&options.openSource)options.openSource(r.kind,sourceId(r));};actions.appendChild(source);
          var edit=doc.createElement('button');edit.type='button';edit.className='quiet';edit.textContent='Update action';edit.dataset.intakeEdit=r.id;edit.onclick=function(){open('task',r.id);};actions.appendChild(edit);table.querySelector('tbody').appendChild(tr);
        });area.appendChild(table);
      }
      var routeArea=host.querySelector('[data-intake-routes]');routeArea.innerHTML='<h3>Where new submissions go</h3><p class="intake-note">'+(rotationEnabled()?'Guest follow-up uses the five-deacon rotation above. The prayer default applies to future prayers; existing tasks keep their own assignment.':'Office is the default until an approved staff route is selected. Defaults apply to future submissions; existing tasks keep their own assignment.')+' Only administrators change defaults. Staff notification status comes from the durable email queue; provider acceptance does not confirm a deacon received or read a notice.</p>';
      settings.routes.forEach(function(r){if(r.kind==='guest_followup'&&rotationEnabled())return;var line=doc.createElement('div');line.className='intake-route';line.innerHTML='<div><strong>'+safe(kinds[r.kind])+'</strong><p>'+safe(staffLabel(r.assigned_staff_user_id))+'</p></div>';if(context().role==='admin'){var edit=doc.createElement('button');edit.type='button';edit.className='quiet';edit.textContent='Change default';edit.dataset.intakeRoute=r.kind;edit.onclick=function(){open('route',r.kind);};line.appendChild(edit);}routeArea.appendChild(line);});syncEditor();
    }
    function refresh(){return options.refresh?options.refresh():load(context().epoch);}
    function syncRecipient(){
      if(!dialog)return;var select=dialog.querySelector('[name=deacon_slot]'),field=dialog.querySelector('[data-intake-assignee-field]'),hint=dialog.querySelector('[data-intake-slot-recipient]');if(!select||!field||!hint)return;
      var owned=select.value!=='';field.hidden=owned;hint.hidden=!owned;
      if(owned){var d=deaconFor(Number(select.value));hint.textContent=d?(d.assigned_staff_user_id?'Notification recipient: '+staffLabel(d.assigned_staff_user_id):'Needs deacon notification setup. Notifications fall back to Office while this deacon owns the follow-up.'):'Choose one of the five deacon slots.';field.querySelector('select').disabled=true;}
    }
    function syncEditor(){
      syncUnload();if(!draft||!dialog)return;var blocked=draft.busy||draft.pending||draft.requiresRefresh||draft.conflict||!ready||!current(draft.epoch,draft.owner)||!modeAvailable(draft.mode,draft.id)||(adminMode(draft.mode)&&context().role!=='admin');
      dialog.querySelectorAll('input,select').forEach(function(n){n.disabled=!!blocked||!!draft.payload;});dialog.querySelector('[type=submit]').disabled=!!blocked;dialog.querySelectorAll('[data-intake-close],[data-intake-retry]').forEach(function(n){n.disabled=!!draft.busy||!!draft.pending;});syncRecipient();
      var error=dialog.querySelector('[role=alert]');if(draft.conflict)error.textContent='This record changed. Your draft is retained; close and reopen the current record before editing.';else if(!ready||!current(draft.epoch,draft.owner))error.textContent='The intake workspace is unavailable. Your draft is retained; refresh before saving.';
    }
    function open(mode,id){
      var c=context(),epoch=c.epoch,owner=c.userId;if(mounted&&(mountedOwner!==owner||mountedEpoch!==epoch)){clear();return false;}if(!current(epoch,owner)||!ready||!modeAvailable(mode,id)||adminMode(mode)&&c.role!=='admin')return false;
      var item=findItem(mode,id);if(!item||!close())return false;
      if(!current(epoch,owner)||!ready||!modeAvailable(mode,id)||adminMode(mode)&&context().role!=='admin')return false;item=findItem(mode,id);if(!item)return false;
      var token=formId,state=draft={mode:mode,id:id,kind:item.kind,rotation:rotationEnabled(),version:item.version,epoch:epoch,owner:owner,busy:false,pending:0,revision:0,payload:null,requiresRefresh:false,conflict:false};
      var slotTask=mode==='task'&&item.kind==='guest_followup'&&rotationEnabled();
      var title=mode==='deacon'?'Set up Deacon '+id:mode==='route'?'Default route · '+kinds[id]:'Update '+kinds[item.kind].toLowerCase();
      var guidance=mode==='deacon'?'A name is optional. Choose an existing approved Office recipient for this deacon’s notifications. Recipient changes apply to open actions in this slot; completed actions stay unchanged. Name-only edits do not replay email. This does not create access.':mode==='route'?'This selects an approved staff recipient for future submissions only. Existing actions keep their own owner.':'Record ownership and progress for this action. Completed dates are recorded by the server. Staff email status is tracked separately; source registration or prayer fields are not changed.';
      dialog=doc.createElement('dialog');dialog.className='intake-dialog';dialog.setAttribute('aria-labelledby','intake-editor-title');
      dialog.innerHTML='<form><header><h2 id="intake-editor-title">'+safe(title)+'</h2><button type="button" class="quiet" data-intake-close>Close</button></header><p class="intake-note">'+safe(guidance)+'</p>'+(mode==='deacon'?'<label>Deacon name <span class="intake-note">(optional)</span><input name="display_name" maxlength="100" autocomplete="off" placeholder="Leave blank to use Deacon '+id+'"></label>':'')+(slotTask?'<label>Follow-up owner<select name="deacon_slot"><option value="">Office / manual staff override</option></select></label><p class="intake-note" data-intake-slot-recipient hidden></p>':'')+'<label data-intake-assignee-field>'+(mode==='deacon'?'Send notifications to':slotTask?'Manual owner / notification recipient':'Assigned to')+'<select name="assigned_staff_user_id"><option value="">Office '+(mode==='deacon'?'fallback':'queue')+'</option></select></label>'+(mode==='task'?'<label>Due date (Central)<input name="due_on" type="date" required></label><label>Status<select name="status"><option value="new">New</option><option value="in_progress">In progress</option><option value="completed">Completed</option></select></label>':'')+'<p role="alert"></p><button type="button" class="quiet" data-intake-retry>Refresh records</button><footer><button type="button" class="quiet" data-intake-close>Cancel</button><button type="submit">Save '+(mode==='deacon'?'slot':mode==='route'?'default':'action')+'</button></footer></form>';
      var form=dialog.querySelector('form'),select=form.elements.assigned_staff_user_id;settings.staff.forEach(function(p){select.add(new root.Option(p.label,p.id));});if(item.assigned_staff_user_id&&!settings.staff.some(function(p){return p.id===item.assigned_staff_user_id;})){var old=new root.Option('Current assignee unavailable — choose Office or approved staff',item.assigned_staff_user_id);old.disabled=true;select.add(old);}select.value=item.assigned_staff_user_id||'';
      if(mode==='deacon')form.elements.display_name.value=item.display_name||'';
      if(slotTask){settings.deacons.slice().sort(function(a,b){return a.slot-b.slot;}).forEach(function(d){form.elements.deacon_slot.add(new root.Option(deaconLabel(d.slot),String(d.slot)));});form.elements.deacon_slot.value=item.deacon_slot==null?'':String(item.deacon_slot);}
      if(mode==='task'){form.elements.due_on.value=item.due_on;form.elements.status.value=item.status;}
      form.addEventListener('input',syncUnload);form.addEventListener('change',syncEditor);dialog.querySelectorAll('[data-intake-close]').forEach(function(b){b.onclick=close;});dialog.addEventListener('cancel',function(e){e.preventDefault();close();});dialog.querySelector('[data-intake-retry]').onclick=refresh;
      form.onsubmit=async function(event){
        event.preventDefault();if(draft!==state||state.busy||state.pending||state.requiresRefresh||state.conflict||!ready||!current(epoch,owner)||token!==formId||!modeAvailable(mode,id)||adminMode(mode)&&context().role!=='admin'||!form.reportValidity())return;
        var formData=values(),payload=state.payload,error=dialog.querySelector('[role=alert]');
        if(!payload){
          payload={assigned_staff_user_id:formData.assigned_staff_user_id||null};
          if(mode==='deacon')payload.display_name=formData.display_name.trim()||null;
          if(mode==='task'){payload.due_on=formData.due_on;payload.status=formData.status;if(slotTask){if(formData.deacon_slot!==''&&!/^[1-5]$/.test(formData.deacon_slot)){error.textContent='Choose one of the five deacons or a manual owner.';return;}var selectedSlot=formData.deacon_slot===''?null:Number(formData.deacon_slot);if(selectedSlot!==null&&selectedSlot===item.deacon_slot){delete payload.assigned_staff_user_id;}else{payload.deacon_slot=selectedSlot;if(selectedSlot!==null)payload.assigned_staff_user_id=null;}}}
        }
        if(payload.assigned_staff_user_id&&!settings.staff.some(function(p){return p.id===payload.assigned_staff_user_id;})||mode==='task'&&(!day(payload.due_on)||!Object.hasOwn(statuses,payload.status))||mode==='deacon'&&!validName(payload.display_name)){error.textContent=mode==='deacon'?'Use an optional name of up to 100 characters without markup, and choose Office or eligible staff.':'Choose Office or eligible staff, a valid due date and an action status.';return;}
        state.payload=payload;state.busy=true;error.textContent='';syncEditor();
        try{
          if(options.ensureReady&&!await options.ensureReady(epoch))throw new Error('readiness');if(!current(epoch,owner)||draft!==state||token!==formId||!ready||!modeAvailable(mode,id)||adminMode(mode)&&context().role!=='admin')throw new Error('readiness');
          state.pending++;state.revision++;var args=mode==='deacon'?{p_slot:id,p_version:state.version,p_display_name:payload.display_name,p_assigned_staff_user_id:payload.assigned_staff_user_id}:mode==='route'?{p_kind:id,p_version:state.version,p_assigned_staff_user_id:payload.assigned_staff_user_id}:{p_id:id,p_version:state.version,p_changes:payload};
          function settled(){state.pending--;state.revision++;if(draft===state&&!state.busy){state.requiresRefresh=true;syncEditor();}}
          var operation=rpc(mode==='deacon'?'set_deacon_slot':mode==='route'?'set_intake_route':'update_intake_task',args).then(function(r){settled();return r;},function(e){settled();throw e;});var result=await deadline(operation);
          if(!current(epoch,owner)||draft!==state||token!==formId){if(identity(epoch,owner)&&draft===state){state.requiresRefresh=true;unavailable();}return;}
          if(mode==='deacon'&&result.error&&result.error.code==='55P03')throw new Error('deacon_busy');
          if(result.error||!result.data||result.data.version!==state.version+1||result.data[mode==='deacon'?'slot':mode==='route'?'kind':'id']!==id)throw new Error('unconfirmed');
          close(true);await refresh();if(current(epoch,owner))options.notice(mode==='deacon'?'Deacon slot saved. Recipient changes apply to open actions; name-only edits do not replay email. Check each action’s notification status.':mode==='route'?'Default route saved for future submissions. Existing actions were not reassigned.':'Action saved. Check its separate notification status for email progress.');
        }catch(caught){if(identity(epoch,owner)&&draft===state&&token===formId){state.requiresRefresh=true;error.textContent=caught.message==='deacon_busy'?'An action in this slot is being updated or sent. Nothing changed. Keep this draft, refresh, then explicitly retry after it finishes.':'The save could not be confirmed. Keep this draft and refresh after the request settles before retrying.';}}
        finally{if(identity(epoch,owner)&&draft===state&&token===formId){state.busy=false;syncEditor();}}
      };
      state.initial=fingerprint();doc.body.appendChild(dialog);dialog.showModal();syncEditor();return true;
    }
    function showFilter(value){if(!['open','new','due','completed','all'].includes(value))return;var c=context();if(!current(c.epoch,c.userId))return;filter=value;mount();host.querySelector('[data-intake-filter]').value=value;render();}
    function taskForSource(kind,id){
      var c=context();if(!ready||!current(c.epoch,c.userId)||mountedOwner!==c.userId||mountedEpoch!==c.epoch)return null;
      var task=rows.find(function(r){return r.kind===kind&&sourceId(r)===id;});
      return task?{id:task.id,due_on:task.due_on,status:task.status,owner:ownerLabel(task),notification_status:task.notification_status}:null;
    }
    return {load:load,render:render,clear:clear,showFilter:showFilter,taskForSource:taskForSource,openTask:function(id){return open('task',id);},openRoute:function(kind){open('route',kind);},openDeacon:function(slot){open('deacon',slot);}};
  }
  root.CreekIntakeTasks={create:create};
}(typeof window!=='undefined'?window:globalThis));
