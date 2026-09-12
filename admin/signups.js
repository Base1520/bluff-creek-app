/* Private staff review of voluntarily submitted app connection details. */
(function (root) {
  'use strict';
  function create(options) {
    var host = options.root, doc = host.ownerDocument, rows = [], request = 0, formVersion = 0;
    var review = null, directIntakeReady=false, taskWorkflowReady=false, expandedProfiles=new Set();
    var ready = false, failed = false, dialog = null, mounted = false, mountedEpoch = null, mountedOwner = null, filter = 'pending', term = '', sortKey = 'submitted_at', sortDirection = -1;
    var guestTools=root.CreekGuestRegisterTools?root.CreekGuestRegisterTools.create(Object.assign({},options,{onChange:function(){if(mounted)render();},canOpen:close})):null;
    function removed(row){return !!(row.guest_removed_at||row.status==='archived');}
    function deadline(request) {
      var timer;
      return Promise.race([Promise.resolve(request),new Promise(function(_resolve,reject){timer=doc.defaultView.setTimeout(function(){reject(new Error('The request timed out.'));},12000);})]).finally(function(){doc.defaultView.clearTimeout(timer);});
    }
    function context() { return options.getContext() || {}; }
    function identity(epoch, owner) { var c = context(); return c.epoch === epoch && !!c.userId && (owner === undefined || c.userId === owner) && ['admin', 'editor'].includes(c.role) && options.isCurrent(epoch); }
    function current(epoch, owner) { return identity(epoch, owner) && context().canEdit && context().workspaceReady !== false; }
    function safe(value) { var e = doc.createElement('span'); e.textContent = value == null ? '' : String(value); return e.innerHTML.replace(/"/g, '&quot;'); }
    function personName(p) { return [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ') || 'Unnamed person'; }
    function date(value) { if (!value) return 'Not supplied'; var d = new Date(value); return isNaN(d) ? 'Date unavailable' : d.toLocaleDateString('en-US', {timeZone:'America/Chicago', month:'short',day:'numeric',year:'numeric'}); }
    function validDay(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !isNaN(new Date(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value; }
    function dayLabel(value) { return validDay(value) ? new Date(value+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'}) : 'Not recorded'; }
    function centralDay(value) { var d=new Date(value); if(!value || isNaN(d))return ''; return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(d); }
    var visitLabels={not_yet:'Not yet visited',first_visit:'First visit',returning:'Returning'}, followupLabels={new:'New',contacted:'Contacted',connected:'Connected',closed:'Closed'}, mailLabels={queued:'Queued',sending:'Sending',sent:'Provider accepted',attention:'Needs attention'};
    var membershipLabels={member:'Member',regular_attender:'Regular attender',guest:'Guest',exploring:'Exploring',unsure:'Unsure'}, relationshipLabels={spouse:'Spouse',child:'Child',parent:'Parent',guardian:'Guardian',other:'Other'};
    function profileDate(value) { return !value?'Not supplied':validDay(value)?dayLabel(value):'Date unavailable'; }
    function familyRows(row) { return Array.isArray(row.family_members)?row.family_members.filter(function(p){return p && typeof p==='object' && !Array.isArray(p);}).map(function(p){return {first_name:typeof p.first_name==='string'?p.first_name:'',last_name:typeof p.last_name==='string'?p.last_name:'',relationship:typeof p.relationship==='string'?p.relationship:'',birth_date:validDay(p.birth_date)?p.birth_date:null};}):[]; }
    function profileDetails(row) {
      var detail=doc.createElement('details'),family=familyRows(row);detail.className='signup-profile';detail.dataset.signupProfile=row.id;detail.open=expandedProfiles.has(row.id);
      detail.innerHTML='<summary>Profile &amp; household details'+(family.length?' · '+family.length+' family members supplied':'')+'</summary><p class="signup-note">Self-reported information. Membership status and family relationships have not been verified or added to the historical membership ledger.</p><dl><dt>Birthday</dt><dd>'+safe(profileDate(row.birth_date))+'</dd><dt>Membership · self-reported</dt><dd>'+safe(membershipLabels[row.membership_status]||(row.membership_status?'Unrecognized supplied status':'Not supplied'))+'</dd><dt>Address · self-reported</dt><dd>'+[row.address_line1,row.address_line2,[row.city,row.state_region,row.postal_code].filter(Boolean).join(', ')].filter(Boolean).map(safe).join('<br>')+'</dd></dl><p class="signup-note">Family members · self-reported</p>';
      var address=detail.querySelector('dl dd:last-child');if(!address.textContent)address.textContent='Not supplied';
      if(family.length){var list=doc.createElement('ul');family.forEach(function(p){var item=doc.createElement('li');item.textContent=[p.first_name,p.last_name].filter(Boolean).join(' ')+' · '+(relationshipLabels[p.relationship]||'Relationship unavailable')+' · Birthday: '+profileDate(p.birth_date);list.appendChild(item);});detail.appendChild(list);}else{var empty=doc.createElement('p');empty.textContent='No family details supplied.';detail.appendChild(empty);}
      var epoch=mountedEpoch,owner=mountedOwner;detail.addEventListener('toggle',function(){if(!current(epoch,owner)||mountedEpoch!==epoch||mountedOwner!==owner)return;if(detail.open)expandedProfiles.add(row.id);else expandedProfiles.delete(row.id);});return detail;
    }
    function followupAvailable(row) { return directIntakeReady && Number.isSafeInteger(row.staff_version) && row.staff_version>0 && Object.hasOwn(followupLabels,row.follow_up_status) && Object.hasOwn(mailLabels,row.welcome_email_status); }
    var taskStatusLabels={new:'New',in_progress:'In progress',completed:'Completed'};
    function taskFor(row) { return taskWorkflowReady && options.intakeTask ? options.intakeTask(row.id) : null; }
    function followupField(row,key) {
      if(!taskWorkflowReady)return row[key];
      var task=taskFor(row);if(!task)return null;
      return key==='follow_up_on'?task.due_on:key==='follow_up_status'?task.status:key==='welcome_owner'?task.owner:row[key];
    }
    function statusLabel(row) { if(removed(row))return 'Removed'; var value=followupField(row,'follow_up_status');return (taskWorkflowReady?taskStatusLabels:followupLabels)[value]||'Unavailable'; }
    function filteredRows() {
      return rows.filter(function(r){return (filter==='removed'?removed(r):!removed(r)&&(filter==='all' || (filter==='pending'?pending(r):!pending(r)))) && (!term.trim() || [personName(r),r.email,r.phone,r.sunday_school,centralDay(r.submitted_at),r.first_visit_on,r.staff_visit_on,followupField(r,'follow_up_on'),followupField(r,'welcome_owner'),statusLabel(r),mailLabels[r.welcome_email_status],visitLabels[r.visit_status]].join(' ').toLowerCase().includes(term.trim().toLowerCase()));}).sort(function(a,b){
        var av=sortKey==='name'?personName(a):sortKey==='submitted_at'?Date.parse(a.submitted_at)||0:["follow_up_on","follow_up_status","welcome_owner"].includes(sortKey)?followupField(a,sortKey)||'':a[sortKey]||'', bv=sortKey==='name'?personName(b):sortKey==='submitted_at'?Date.parse(b.submitted_at)||0:["follow_up_on","follow_up_status","welcome_owner"].includes(sortKey)?followupField(b,sortKey)||'':b[sortKey]||'';
        return (typeof av==='number' ? av-bv : String(av).localeCompare(String(bv),undefined,{numeric:true,sensitivity:'base'}))*sortDirection || String(a.id).localeCompare(String(b.id));
      });
    }
    function csvCell(value) { var text=value==null?'':String(value); if(/^[\s\p{Cf}\x00-\x1f\x7f]*[=+@-]/u.test(text) || /^[\t\r\n]/.test(text))text="'"+text; return '"'+text.replace(/"/g,'""')+'"'; }
    function exportCSV() {
      var c=context();if(filter==='removed' || !current(c.epoch,c.userId) || !ready || failed || mountedOwner!==c.userId || mountedEpoch!==c.epoch)return;
      var data=[['Registered date (Central)','First name (self-reported)','Last name (self-reported)','Email (self-reported; not verified)','Phone (self-reported)','Preferred contact','Follow-up permission','Sunday school (self-reported)','Visit status (self-reported)','First visit date (self-reported)','Visit date (staff recorded)',taskWorkflowReady?'Intake action due':'Follow-up due',taskWorkflowReady?'Intake action status':'Follow-up status',taskWorkflowReady?'Intake action owner':'Follow-up owner','Welcome email (sent means provider accepted)','Identity review','Birthday (self-reported)','Membership status (self-reported; not verified)','Address line 1 (self-reported)','Address line 2 (self-reported)','City (self-reported)','State / region (self-reported)','Postal code (self-reported)','Family members (self-reported; JSON)']];
      filteredRows().filter(function(r){return !removed(r);}).forEach(function(r){data.push([centralDay(r.submitted_at),r.first_name,r.last_name,r.email,r.phone,r.preferred_contact,r.contact_permission?'Requested':'Not granted',r.sunday_school,visitLabels[r.visit_status]||'Not supplied',validDay(r.first_visit_on)?r.first_visit_on:'',validDay(r.staff_visit_on)?r.staff_visit_on:'',validDay(followupField(r,'follow_up_on'))?followupField(r,'follow_up_on'):(taskWorkflowReady?'Unavailable':''),statusLabel(r),followupField(r,'welcome_owner')||(taskWorkflowReady?'Unavailable':''),mailLabels[r.welcome_email_status]||'Unavailable',removed(r)?'Removed visit':pending(r)?'Awaiting review':'Reviewed',validDay(r.birth_date)?r.birth_date:'',membershipLabels[r.membership_status]||(r.membership_status?'Unrecognized supplied status':''),r.address_line1,r.address_line2,r.city,r.state_region,r.postal_code,JSON.stringify(familyRows(r))]);});
      try { var blob=new doc.defaultView.Blob(['\ufeff'+data.map(function(r){return r.map(csvCell).join(',');}).join('\r\n')+'\r\n'],{type:'text/csv;charset=utf-8'}),url=doc.defaultView.URL.createObjectURL(blob),link=doc.createElement('a');link.href=url;link.download='creek-guest-register.csv';link.hidden=true;doc.body.appendChild(link);link.click();link.remove();doc.defaultView.setTimeout(function(){doc.defaultView.URL.revokeObjectURL(url);},0); }
      catch(_){options.notice('The CSV could not be created. No records were sent or shared.');}
    }
    function peopleAvailable() { return !options.peopleReady || options.peopleReady(); }
    function refreshRecords() { return options.refresh ? options.refresh() : load(context().epoch); }
    function pending(row) { return !removed(row)&&(row.status === 'pending' || Number(row.version) > Number(row.reviewed_version || 0)); }
    function reviewFingerprint() { return dialog ? JSON.stringify(Array.from(dialog.querySelectorAll('form [name]')).filter(function(node){return node.name!=='person_search';}).map(function(node){return [node.name,node.type==='checkbox'?node.checked:node.value];})) : ''; }
    function reviewNeedsWarning() { return !!(review && dialog && dialog.querySelector('form') && (review.busy || review.pending || review.requiresRefresh || review.conflict || (review.initialForm !== undefined && reviewFingerprint() !== review.initialForm))); }
    function warnUnload(event) { if(reviewNeedsWarning()){event.preventDefault();event.returnValue=true;} }
    function syncUnload() { doc.defaultView[reviewNeedsWarning()?'addEventListener':'removeEventListener']('beforeunload',warnUnload); }
    function close(force) {
      var state=review,token=formVersion;
      if(review && (review.busy || review.pending) && force!==true)return false;
      if(force!==true && reviewNeedsWarning() && !doc.defaultView.confirm('Discard this unsaved guest-register draft? If a save was uncertain, refresh and check the saved review before starting again.'))return false;
      if(force!==true && (review!==state || formVersion!==token || review && review.busy))return false;
      review=null;syncUnload();formVersion++;if(dialog){if(dialog.open)dialog.close();dialog.remove();dialog=null;}return true;
    }
    function clear() { request++; close(true); if(guestTools)guestTools.clear(); directIntakeReady=false; taskWorkflowReady=false; expandedProfiles.clear(); rows = []; ready = false; failed = false; mounted = false; mountedEpoch = null; mountedOwner = null; filter = 'pending'; term = ''; sortKey='submitted_at'; sortDirection=-1; host.replaceChildren(); if (options.onCount) options.onCount(null); }
    function mount() {
      if (mounted) return;
      host.classList.add('signup-workspace');
      host.innerHTML = '<div class="signup-intro"><p class="eyebrow">From a first hello to lasting care</p><h2>Every connection has a next step.</h2><p>Find guest registrations, record follow-up, and review identities before linking a People record.</p></div>' +
        '<div class="signup-summary panel"><div><span class="eyebrow">Awaiting review</span><strong data-signup-count>—</strong></div><p>Welcome goal: within two days of the first submission. Monthly Sunday school and quarterly deacon care are separate plans.</p><button type="button" class="quiet" data-signup-refresh>Refresh guests</button><button type="button" class="quiet" data-signup-export>Export current view as CSV</button></div>' +
        '<div class="panel signup-sheet-tools" data-guest-tools></div><p class="signup-status" role="status" data-signup-status></p><div class="signup-filters"><label>Search guest register<input type="search" data-signup-search placeholder="Name, contact, date, status or owner"></label><label>Show<select data-signup-filter><option value="pending">Awaiting review</option><option value="reviewed">Reviewed</option><option value="all">All active submissions</option><option value="removed">Removed visits</option></select></label></div>' +
        '<p class="signup-note">A submitted profile is self-reported information, not church membership or permission for mass messaging. Installing the app alone creates no record. Email and visit details are self-reported, not verified. Welcome email “Provider accepted” does not prove delivery. Intake actions show the routed staff owner, due date and notification queue. Use Intake actions to assign approved staff; a free-text care-plan contact does not route an email. CSV downloads only the current filtered view to this device, including matches beyond the first 100; it does not update a Google Sheet or the membership ledger.</p><div data-signup-list class="signup-list"></div>';
      host.querySelector('[data-signup-export]').onclick=exportCSV;
      host.querySelector('[data-signup-refresh]').onclick = function () { refreshRecords(); };
      host.querySelector('[data-signup-search]').oninput = function (e) { term = e.target.value; render(); };
      host.querySelector('[data-signup-filter]').onchange = function (e) { filter = e.target.value; render(); };
      var c = context(); mounted = true; mountedEpoch = c.epoch; mountedOwner = c.userId;
    }
    async function load(epoch) {
      var owner = context().userId;
      if (!identity(epoch, owner)) { clear(); return false; }
      if (mounted && (mountedEpoch !== epoch || mountedOwner !== owner)) clear();
      if (!current(epoch, owner)) { unavailable(); return false; }
      mount(); var id = ++request, all = [], total = null, seen = new Set(), offset = 0, startingReview=review, startingRevision=review && review.revision;
      try {
        var capability;try{capability=await deadline(options.db.rpc('direct_intake_readiness',{}));}catch(_){capability=null;}
        if(!current(epoch,owner)||id!==request)return false;
        directIntakeReady=!!(capability && !capability.error && capability.data && capability.data.available===true && capability.data.version===1);
        taskWorkflowReady=taskWorkflowReady || !!(directIntakeReady && capability.data.tasks===true && capability.data.routes===true);
        if(guestTools)await guestTools.load(epoch);
        if(!current(epoch,owner)||id!==request)return false;
        while (current(epoch, owner) && id === request) {
          var query = options.db.from('app_connections').select('*', {count:'exact'}).order('updated_at', {ascending:false}).order('id', {ascending:true});
          var ranged = typeof query.range === 'function';
          var result = await deadline(ranged ? query.range(offset, offset + 999) : query);
          if (!current(epoch, owner) || id !== request) { if(identity(epoch, owner) && id===request)unavailable(); return false; }
          if (result.error) throw result.error;
          var page = result.data;
          if (!Array.isArray(page) || !Number.isSafeInteger(result.count) || result.count < 0 || total !== null && result.count !== total) throw new Error('incomplete records');
          total = result.count;
          page.forEach(function(row){
            if (!row || typeof row.id !== 'string' || !row.id.trim() || seen.has(row.id)) throw new Error('incomplete records');
            seen.add(row.id);
          });
          all = all.concat(page); offset += page.length;
          if (offset > total || offset < total && (!page.length || !ranged)) throw new Error('incomplete records');
          if (offset === total) break;
        }
        if (!current(epoch, owner) || id !== request) return false;
        rows = all; ready = true; failed = false;
        if(dialog && review && !review.busy) {
          var latest=rows.find(function(r){return r.id===dialog.dataset.signupId;});
          if(review.mode==='followup') {
            if(review!==startingReview || review.revision!==startingRevision || review.pending)review.requiresRefresh=true;
            else if(!directIntakeReady)review.requiresRefresh=true;
            else if(review.tasks!==taskWorkflowReady)review.conflict=true;
            else if(!latest || removed(latest) || !followupAvailable(latest))review.conflict=true;
            else if(review.payload && latest.staff_version>review.version && Object.keys(review.payload).every(function(k){return (latest[k]||null)===(review.payload[k]||null);})) {close(true);options.notice('The refreshed guest follow-up matches the submitted details.');}
            else if(latest.staff_version!==review.version)review.conflict=true;
            else review.requiresRefresh=false;
          } else if(!latest || removed(latest) || latest.version!==review.version)review.conflict=true;
          else if(review.requiresRefresh && !pending(latest)) { close(true); options.notice('This signup is now reviewed. Open the saved review to check its identity and welcome plan.'); }
          else review.requiresRefresh=false;
        }
        render(); syncReview(); return true;
      } catch (error) {
        if (current(epoch, owner) && id === request) { rows = []; ready = false; failed = true; if (error && ['42501','PGRST301','PGRST302'].includes(error.code)) close(true); render(); if (dialog) { var errorNode = dialog.querySelector('[data-signup-error]'); if (errorNode) errorNode.textContent = 'The connection was interrupted. Your review draft is retained. Refresh records before saving.'; } }
        syncReview(); return false;
      }
    }
    function syncReview() {
      syncUnload();
      if(!dialog || !review)return;
      var blocked=review.busy || review.pending || review.requiresRefresh || review.conflict || !ready || !current(review.epoch, review.owner) || (review.mode==='followup' ? !directIntakeReady || review.tasks!==taskWorkflowReady : !peopleAvailable());
      dialog.querySelectorAll('input,select,textarea').forEach(function(node){node.disabled=blocked || (review.mode==='followup' && !!review.payload) || (review.linked && ['contact_id','person_search'].includes(node.name));});
      var save=dialog.querySelector('[type=submit]');if(save)save.disabled=blocked;
      dialog.querySelectorAll('[data-signup-close],[data-signup-retry]').forEach(function(node){node.disabled=review.busy || !!review.pending;});
      var error=dialog.querySelector('[data-signup-error]');
      if(error && review.mode==='followup' && !directIntakeReady)error.textContent='Guest follow-up tools are unavailable. Your draft is retained; refresh before saving.';
      else if(error && review.conflict && review.mode==='followup')error.textContent='The guest follow-up changed. Your draft is retained; close and reopen the current record before editing.';
      else if(error && review.conflict)error.textContent='This signup changed or is no longer available. Your draft is preserved. Close and reopen the current signup to review it before saving.';
      else if(error && (!current(review.epoch, review.owner) || !ready))error.textContent='The workspace connection is unavailable. Your draft is preserved. Refresh records before saving.';
    }
    function unavailable() {
      if(guestTools)guestTools.unavailable();
      if(mounted)host.querySelector('[data-guest-tools]').replaceChildren();
      rows=[];ready=false;failed=true;if(options.onCount)options.onCount(null);
      if(mounted){host.querySelector('[data-signup-export]').disabled=true;host.querySelector('[data-signup-list]').replaceChildren();host.querySelector('[data-signup-count]').textContent='—';host.querySelector('[data-signup-status]').textContent='The workspace connection is unavailable. Refresh to reconnect.';}
      syncReview();
    }
    function render() {
      var c = context();
      if (!identity(c.epoch, c.userId)) { clear(); return; }
      if (mounted && (mountedEpoch !== c.epoch || mountedOwner !== c.userId)) clear();
      if (!current(c.epoch, c.userId)) { unavailable(); return; }
      mount(); var count = rows.filter(pending).length;
      if(guestTools)guestTools.toolbar(host.querySelector('[data-guest-tools]'));
      host.querySelector('[data-signup-count]').textContent = failed ? '—' : String(count);
      if (options.onCount) options.onCount(failed ? null : count);
      host.querySelector('[data-signup-status]').textContent = failed ? 'Signups could not load. Check the private connection and signup migration, then refresh.' : !peopleAvailable() ? 'People records are unavailable. Refresh records before reviewing identities or creating visitors.' : ready ? 'Showing the latest loaded submissions. Refreshes every minute while this tab is visible.' : 'Loading signups…';
      host.querySelector('[data-signup-export]').disabled=!ready || failed || filter==='removed';
      var matches=filteredRows(),area=host.querySelector('[data-signup-list]');area.replaceChildren();
      if(!matches.length){var blank=doc.createElement('p');blank.className='signup-empty';blank.textContent=failed?'The guest register is unavailable.':'No submissions match this view.';area.appendChild(blank);return;}
      var table=doc.createElement('table');table.className='signup-table';table.innerHTML='<caption>Private guest register · '+matches.length+' matches'+(matches.length>100?' · Showing the first 100; search to narrow the view':'')+'</caption><thead><tr></tr></thead><tbody></tbody>';
      [['submitted_at','Registered (Central)'],['name','Guest / contact · self-reported'],['first_visit_on','Visit · self-reported'],['staff_visit_on','Visit · staff recorded'],['follow_up_on',taskWorkflowReady?'Intake action due':'Follow-up due'],['follow_up_status',taskWorkflowReady?'Intake action status':'Follow-up status'],['welcome_owner',taskWorkflowReady?'Intake action owner':'Register owner'],['welcome_email_status','Welcome email'],['','Review / edit']].forEach(function(col){
        var th=doc.createElement('th');th.scope='col';
        if(col[0]){th.setAttribute('aria-sort',sortKey===col[0]?(sortDirection===1?'ascending':'descending'):'none');var sort=doc.createElement('button');sort.type='button';sort.dataset.signupSort=col[0];sort.textContent=col[1];sort.onclick=function(){sortDirection=sortKey===col[0]?-sortDirection:1;sortKey=col[0];render();host.querySelector('[data-signup-sort="'+sortKey+'"]').focus();};th.appendChild(sort);}else th.textContent=col[1];table.querySelector('thead tr').appendChild(th);
      });
      matches.slice(0,100).forEach(function(r){
        var tr=doc.createElement('tr');tr.className='signup-row';tr.dataset.signupRow=r.id;
        var isUpdate=!!r.contact_id || Number(r.reviewed_version)>0, task=taskFor(r), due=followupField(r,'follow_up_on'), followStatus=followupField(r,'follow_up_status'), owner=followupField(r,'welcome_owner'), overdue=validDay(due) && due<centralDay(new Date().toISOString()) && !(taskWorkflowReady?['completed']:['closed','connected']).includes(followStatus);
        tr.innerHTML='<td>'+safe(date(r.submitted_at))+'</td><td><strong>'+safe(personName(r))+'</strong><p>'+safe(r.email)+(r.phone?' · '+safe(r.phone):'')+'</p><p class="signup-note">'+safe(r.sunday_school||'No Sunday school supplied')+'</p></td><td>'+safe(visitLabels[r.visit_status]||'Not supplied')+'<p>'+safe(dayLabel(r.first_visit_on))+'</p></td><td>'+safe(dayLabel(r.staff_visit_on))+'</td><td>'+safe(taskWorkflowReady&&!task?'Unavailable':dayLabel(due))+(overdue?'<p>Overdue</p>':'')+'</td><td>'+safe(statusLabel(r))+'</td><td>'+safe(owner||(taskWorkflowReady?'Unavailable':'Unassigned'))+'</td><td>'+safe(mailLabels[r.welcome_email_status]||'Unavailable')+'</td><td><span class="signup-tag">'+(pending(r)?(isUpdate?'Profile update · review needed':'New guest'):'Reviewed')+'</span></td>';
        tr.children[1].appendChild(profileDetails(r));
        var actions=tr.lastElementChild;
        if(removed(r)){actions.replaceChildren();var removedLabel=doc.createElement('span');removedLabel.className='signup-tag';removedLabel.textContent='Removed visit';actions.appendChild(removedLabel);if(guestTools)guestTools.rowAction(actions,r);table.querySelector('tbody').appendChild(tr);return;}
        if(guestTools)guestTools.rowAction(actions,r);
        var b=doc.createElement('button');b.type='button';b.className='quiet';b.textContent=pending(r)?'Review identity & care plan':'View reviewed signup';b.disabled=!peopleAvailable();b.onclick=function(){open(r.id);};actions.appendChild(b);
        var edit=doc.createElement('button');edit.type='button';edit.className='quiet';edit.dataset.guestFollowup=r.id;edit.textContent=taskWorkflowReady?'Record visit':'Edit follow-up';edit.disabled=!followupAvailable(r);edit.onclick=function(){openFollowup(r.id);};actions.appendChild(edit);if(taskWorkflowReady){var action=doc.createElement('button');action.type='button';action.className='quiet';action.dataset.signupIntake=r.id;action.textContent='Open intake action';action.disabled=!task;action.onclick=function(){var c=context();if(current(c.epoch,c.userId)&&mountedOwner===c.userId&&mountedEpoch===c.epoch&&taskFor(r)&&options.openIntakeTask)options.openIntakeTask(r.id);};actions.appendChild(action);}table.querySelector('tbody').appendChild(tr);
      });area.appendChild(table);
    }
    function openFollowup(id) {
      var c=context(),epoch=c.epoch,owner=c.userId;
      if(mounted && (mountedEpoch!==epoch || mountedOwner!==owner)){clear();return;}
      var row=rows.find(function(r){return r.id===id;});if(!current(epoch,owner) || !ready || !row || removed(row) || !followupAvailable(row) || !close())return;
      row=rows.find(function(r){return r.id===id;});if(!current(epoch,owner) || !ready || !row || !followupAvailable(row))return;
      var version=formVersion,state=review={mode:'followup',tasks:taskWorkflowReady,epoch:epoch,owner:owner,version:row.staff_version,busy:false,pending:0,revision:0,requiresRefresh:false,conflict:false,payload:null};
      dialog=doc.createElement('dialog');dialog.className='signup-dialog';dialog.dataset.signupId=id;dialog.setAttribute('aria-labelledby','guest-followup-title');
      dialog.innerHTML='<form><header><h2 id="guest-followup-title">'+(state.tasks?'Record visit for ':'Follow up with ')+safe(personName(row))+'</h2><button type="button" class="quiet" data-signup-close>Close</button></header><p class="signup-note">These staff fields do not change the guest’s self-reported profile, link a member or send a message. Self-reported visit: '+safe(visitLabels[row.visit_status]||'Not supplied')+' · '+safe(dayLabel(row.first_visit_on))+'.</p><label>Visit date recorded by staff<input type="date" name="staff_visit_on"></label>'+(state.tasks?'<p class="signup-note">Owner, due date and progress are managed in Intake actions using the approved staff dropdown. This form records only the staff-observed visit date.</p>':'<label>Follow-up due<input type="date" name="follow_up_on"></label><label>Follow-up status<select name="follow_up_status"><option value="new">New</option><option value="contacted">Contacted</option><option value="connected">Connected</option><option value="closed">Closed</option></select></label><label>Guest-register follow-up owner<input name="welcome_owner" maxlength="120"></label>')+'<p role="alert" data-signup-error></p><button type="button" class="quiet" data-signup-retry>Refresh records</button><footer><button type="button" class="quiet" data-signup-close>Cancel</button><button type="submit">'+(state.tasks?'Save visit':'Save follow-up')+'</button></footer></form>';
      var form=dialog.querySelector('form');['staff_visit_on','follow_up_on','follow_up_status','welcome_owner'].forEach(function(k){if(form.elements[k])form.elements[k].value=row[k]||'';});
      form.addEventListener('input',syncUnload);form.addEventListener('change',syncUnload);dialog.querySelector('[data-signup-retry]').onclick=function(){refreshRecords();};
      form.onsubmit=async function(event){
        event.preventDefault();if(review!==state || state.busy || state.pending || state.requiresRefresh || state.conflict || !ready || !current(epoch,owner) || version!==formVersion || state.tasks!==taskWorkflowReady || !form.reportValidity())return;
        var error=form.querySelector('[data-signup-error]'),payload=state.payload || Object.assign({staff_visit_on:form.elements.staff_visit_on.value||null},state.tasks?{}:{follow_up_on:form.elements.follow_up_on.value||null,follow_up_status:form.elements.follow_up_status.value,welcome_owner:form.elements.welcome_owner.value.trim()||null});
        if(['staff_visit_on','follow_up_on'].some(function(k){return payload[k]&&!validDay(payload[k]);}) || !state.tasks && !Object.hasOwn(followupLabels,payload.follow_up_status) || (payload.welcome_owner||'').length>120){error.textContent='Choose valid dates, a follow-up status and an owner of no more than 120 characters.';return;}
        state.payload=payload;state.busy=true;error.textContent='';syncReview();
        try{
          if(options.ensureReady && !await options.ensureReady(epoch))throw new Error('readiness');
          if(!current(epoch,owner) || !directIntakeReady || state.tasks!==taskWorkflowReady || review!==state || version!==formVersion)throw new Error('readiness');
          state.pending++;state.revision++;
          var operation=Promise.resolve().then(function(){return options.db.rpc('update_guest_followup',{p_id:id,p_staff_version:state.version,p_changes:payload});}).then(function(result){settled();return result;},function(error){settled();throw error;});
          function settled(){state.pending--;state.revision++;if(review===state && !state.busy){state.requiresRefresh=true;syncReview();}}
          var result=await deadline(operation);
          if(!current(epoch,owner) || review!==state || version!==formVersion){if(identity(epoch,owner)&&review===state){state.requiresRefresh=true;unavailable();}return;}
          if(result.error || !result.data || result.data.id!==id || result.data.staff_version!==state.version+1)throw new Error('unconfirmed');
          close(true);await refreshRecords();if(current(epoch,owner))options.notice(state.tasks?'Staff-recorded visit saved. Intake action ownership and progress were not changed.':'Guest follow-up saved. No message was sent and no membership record was changed.');
        }catch(_){if(identity(epoch,owner)&&review===state&&version===formVersion){state.requiresRefresh=true;error.textContent='The follow-up save could not be confirmed. Keep this draft and refresh after the request finishes before retrying.';}}
        finally{if(identity(epoch,owner)&&review===state&&version===formVersion){state.busy=false;syncReview();}}
      };
      dialog.querySelectorAll('[data-signup-close]').forEach(function(b){b.onclick=close;});dialog.addEventListener('cancel',function(event){event.preventDefault();close();});state.initialForm=reviewFingerprint();doc.body.appendChild(dialog);dialog.showModal();syncReview();
    }

    function open(id) {
      var epoch = context().epoch, owner = context().userId;
      if (mounted && (mountedEpoch !== epoch || mountedOwner !== owner)) { clear(); return; }
      var row = rows.find(function (r) { return r.id === id; });
      if (!current(epoch, owner) || !ready || !peopleAvailable() || !row || removed(row)) return;
      if(!close())return;
      row=rows.find(function(r){return r.id===id;});
      if(!current(epoch, owner) || !ready || !peopleAvailable() || !row)return;
      var version = formVersion;
      review={epoch:epoch,owner:owner,version:row.version,linked:!!row.contact_id,busy:false,requiresRefresh:false,conflict:false};
      dialog = doc.createElement('dialog'); dialog.dataset.signupId = row.id; dialog.className = 'signup-dialog'; dialog.setAttribute('aria-labelledby','signup-review-title');
      var isPending = pending(row), people = options.people();
      dialog.innerHTML = '<header><div><p class="eyebrow">' + (row.contact_id ? 'Review a profile update' : 'Welcome a new connection') + '</p><h2 id="signup-review-title">' + safe(personName(row)) + '</h2></div><button type="button" class="quiet" data-signup-close>Close</button></header><dl class="signup-details"><dt>Email · self-reported, not verified</dt><dd>' + safe(row.email) + '</dd><dt>Phone · self-reported</dt><dd>' + safe(row.phone || 'Not supplied') + '</dd><dt>Preferred contact</dt><dd>' + safe(row.preferred_contact) + '</dd><dt>Care contact permission</dt><dd>' + (row.contact_permission ? 'Requested church follow-up' : 'Not granted') + '</dd><dt>Sunday school</dt><dd>' + safe(row.sunday_school || 'Not supplied') + '</dd><dt>First submitted</dt><dd>' + safe(date(row.submitted_at)) + '</dd></dl>';
      if (!isPending) {
        var done = doc.createElement('p'); done.className = 'signup-note'; done.textContent = 'Reviewed ' + date(row.reviewed_at) + '. A linked care plan can be managed in Guests & care.'; dialog.appendChild(done);
      } else {
        var form = doc.createElement('form');
        form.innerHTML = '<p class="signup-note">Check the person’s identity before linking. The submitted details stay here for review; linking does not overwrite an existing People record or change membership status.</p><label>Search existing people<input name="person_search" type="search" placeholder="Name, email or phone" autocomplete="off"></label><label>Person to connect<select name="contact_id" required><option value="">Choose an existing person or create a visitor</option><option value="__new">Create a new visitor record</option></select></label><label>Welcome care-plan contact assigned to<input name="welcome_owner" maxlength="120" placeholder="Staff member or welcome team"></label><p class="signup-note">A new one-time welcome plan is due two days after the original submission. Existing welcome plans are preserved. This optional contact belongs only to the separate ongoing care plan. The routed Intake action remains authoritative for this submission’s owner, due date and notifications. An empty assignment appears as unassigned. Assignment does not send a message or grant workspace access.</p><label>Private review notes<textarea name="staff_notes" maxlength="2000"></textarea></label><label class="signup-check"><input name="identity_checked" type="checkbox" required><span>I checked for an existing person and reviewed these details.</span></label><p role="alert" data-signup-error></p><button type="button" class="quiet" data-signup-retry>Refresh records</button><footer><button type="button" class="quiet" data-signup-close>Cancel</button><button type="submit">Save review & welcome plan</button></footer>';
        var select = form.elements.contact_id;
        function populate(search) {
          var chosen = select.value, query = (search || '').trim().toLowerCase();
          select.replaceChildren(new Option('Choose an existing person or create a visitor',''), new Option('Create a new visitor record','__new'));
          people.filter(function (p) { return p.id === chosen || p.id === row.contact_id || !query || [personName(p),p.email,p.phone].join(' ').toLowerCase().includes(query); }).forEach(function (p) { select.add(new Option(personName(p) + ' · ' + p.status + (p.membership_number ? ' · #' + p.membership_number : ''),p.id)); });
          select.value = chosen;
        }
        populate(''); if (row.contact_id) select.value = row.contact_id;
        // A reviewed identity remains fixed; profile updates never relink it silently.
        if (row.contact_id) { select.disabled = true; form.elements.person_search.disabled = true; }
        form.elements.person_search.oninput = function (e) { populate(e.target.value); };
        form.elements.staff_notes.value = row.staff_notes || '';
        form.addEventListener('input',syncUnload);form.addEventListener('change',syncUnload);
        form.querySelector('[data-signup-retry]').onclick = function () { refreshRecords(); };
        form.onsubmit = async function (event) {
          event.preventDefault(); var save = form.querySelector('[type=submit]'), error = form.querySelector('[data-signup-error]');
          if (save.disabled || !review || review.busy || review.pending || review.requiresRefresh || review.conflict || !form.reportValidity() || !current(epoch, owner) || version !== formVersion) return;
          if (!ready || !peopleAvailable()) { error.textContent = 'Refresh records before saving. The People list and signup queue must be available for identity review.'; return; }
          var chosen = select.value;
          if (!form.elements.identity_checked.checked || (chosen !== '__new' && !people.some(function (p) { return p.id === chosen; }))) { error.textContent = 'Choose a person and confirm the identity review.'; return; }
          var submitted={p_id:row.id,p_version:row.version,p_contact_id:chosen === '__new' ? null : chosen,p_create_person:chosen === '__new',p_staff_notes:form.elements.staff_notes.value.trim() || null,p_welcome_owner:form.elements.welcome_owner.value.trim() || null};
          review.busy=true; error.textContent = ''; syncReview();
          try {
            if(options.ensureReady && !await options.ensureReady(epoch))throw new Error('readiness');
            if(!current(epoch, owner) || version!==formVersion)throw new Error('readiness');
            var result = await deadline(options.db.rpc('review_app_connection', submitted));
            if (!current(epoch, owner) || version !== formVersion) { if(identity(epoch, owner) && version===formVersion && review){review.requiresRefresh=true;unavailable();}return; }
            if (result.error || !result.data || result.data.id !== row.id || result.data.version !== row.version || result.data.status !== 'reviewed' || !result.data.contact_id || (chosen !== '__new' && result.data.contact_id !== chosen)) throw new Error('review');
            close(true); await options.refresh();
            if (current(epoch, owner)) options.notice(result.data.already_reviewed ? 'This version was already reviewed. The existing person and welcome plan were preserved; these draft changes were not applied.' : 'Signup reviewed. Open Guests & care to manage the welcome plan and ongoing contacts.');
          } catch (_) { if (identity(epoch, owner) && version === formVersion && review) { review.requiresRefresh=true; error.textContent = 'The review could not be confirmed. Your submitted draft is locked temporarily. Refresh records before retrying.'; } }
          finally { if (identity(epoch, owner) && version === formVersion && review) { review.busy=false; syncReview(); } }
        };
        dialog.appendChild(form);
      }
      dialog.querySelectorAll('[data-signup-close]').forEach(function (b) { b.onclick = close; });
      dialog.addEventListener('cancel',function(e){e.preventDefault();close();});
      review.initialForm=reviewFingerprint();doc.body.appendChild(dialog);dialog.showModal();syncUnload();
    }
    return {load:load,render:render,clear:clear,open:open,openFollowup:openFollowup,labelFor:function(id){var c=context();if(!current(c.epoch,c.userId)||!ready||mountedOwner!==c.userId||mountedEpoch!==c.epoch)return '';var row=rows.find(function(r){return r.id===id;});return row?personName(row):'';}};
  }
  root.CreekSignups = {create:create};
}(typeof window !== 'undefined' ? window : globalThis));
