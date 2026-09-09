/* Personal leadership follow-ups. No shared roster or broadcast permissions. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CreekFollowups = api;
}(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  var DAY = 86400000;
  var ROLES = { deacon: 'Deacon', sunday_school: 'Sunday school teacher', committee: 'Committee chair', council: 'Church council', other: 'Other leader' };
  var METHODS = { phone: 'Phone', text: 'Text', email: 'Email', in_person: 'In person', other: 'Other' };
  function validDate(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value; }
  function today(now) { return new Intl.DateTimeFormat('en-CA', {timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(now || new Date()); }
  function addMonths(value, months) {
    if (!validDate(value) || !Number.isInteger(months)) return null;
    var target = new Date(value + 'T12:00:00Z'), day = target.getUTCDate();
    target.setUTCDate(1); target.setUTCMonth(target.getUTCMonth() + months);
    var end = new Date(target.getTime()); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
    target.setUTCDate(Math.min(day, end.getUTCDate())); return target.toISOString().slice(0,10);
  }
  function dueFor(plan, date) {
    date = validDate(date) ? date : today();
    var last = validDate(plan.last_contact_on) && plan.last_contact_on <= date ? plan.last_contact_on : null;
    var months = Number(plan.cadence_months), days = Number(plan.cadence_days), scheduled = validDate(plan.first_due_on) ? plan.first_due_on : null;
    if (last) scheduled = Number.isInteger(months) && months >= 1 && months <= 12 ? addMonths(last, months) : Number.isInteger(days) && days >= 1 && days <= 365 ? new Date(Date.parse(last + 'T12:00:00Z') + days * DAY).toISOString().slice(0,10) : null;
    var due = validDate(plan.snoozed_until) && (!scheduled || plan.snoozed_until > scheduled) ? plan.snoozed_until : scheduled;
    return {due:due,scheduled:scheduled,lastContact:last,paused:!!plan.paused,snoozed:!!due && due !== scheduled,
      state:plan.paused ? 'paused' : !due ? 'unscheduled' : due < date ? 'overdue' : due === date ? 'due' : 'upcoming',
      daysOverdue:!plan.paused && due && due < date ? Math.round((Date.parse(date + 'T12:00:00Z') - Date.parse(due + 'T12:00:00Z')) / DAY) : 0};
  }
  function create(options) {
    var host = options.root, doc = host.ownerDocument, rows = [], contacts = [];
    var mounted = false, mountedEpoch = null, mountedOwner = null, ready = false, failed = false, request = 0, formToken = 0;
    var filter = 'due', role = '', search = '', dialog = null, draft = null, saving = false, returnFocus = null, unloadListening = false;
    function deadline(request) {
      var timer;
      return Promise.race([Promise.resolve(request),new Promise(function(_resolve,reject){timer=doc.defaultView.setTimeout(function(){reject(new Error('The request timed out.'));},12000);})]).finally(function(){doc.defaultView.clearTimeout(timer);});
    }
    function context() { return options.getContext() || {}; }
    function identity(epoch, owner) { var c = context(); return c.epoch === epoch && (!owner || c.userId === owner) && !!c.userId && ['admin','editor'].includes(c.role) && options.isCurrent(epoch); }
    function current(epoch, owner) { return identity(epoch, owner) && context().canEdit === true && context().workspaceReady !== false; }
    function unavailable() { rows=[]; contacts=[]; ready=false; failed=true; if(draft && draft.kind==='history')close(false); if(mounted){q('[data-followups-list]').replaceChildren();q('[data-followups-status]').textContent='The workspace connection is unavailable. Refresh to reconnect; your draft stays in this tab.';q('[data-followups-new]').disabled=true;} summary();syncDraft(); }
    function safe(value) { var e = doc.createElement('span'); e.textContent = value == null ? '' : String(value); return e.innerHTML.replace(/"/g,'&quot;'); }
    function labelDate(value) { return validDate(value) ? new Date(value + 'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'}) : 'Not recorded'; }
    function q(selector) { return host.querySelector(selector); }
    function owns(row) { return row.owner_id === context().userId; }
    function authError(error) { return error && (['42501','PGRST301','PGRST302'].includes(error.code) || [401,403].includes(error.status)); }
    function notify(message, bad) { if (current(context().epoch)) options.notice(message, !!bad); }
    function formFingerprint() { return dialog ? JSON.stringify(Array.from(dialog.querySelectorAll('form [name]')).map(function(node){return [node.name,node.type==='checkbox'?node.checked:node.value];})) : ''; }
    function draftNeedsWarning() { return !!(draft && draft.kind !== 'history' && (saving || draft.requiresRefresh || draft.conflict || (draft.initialForm && formFingerprint() !== draft.initialForm))); }
    function warnUnload(event) { event.preventDefault(); event.returnValue = true; }
    function syncUnload() {
      var needed = draftNeedsWarning();
      if (needed === unloadListening) return;
      doc.defaultView[needed ? 'addEventListener' : 'removeEventListener']('beforeunload',warnUnload); unloadListening = needed;
    }
    function close(focus) {
      formToken++; saving = false; draft = null; syncUnload();
      if (dialog) { if (dialog.open) dialog.close(); dialog.remove(); dialog = null; }
      if (focus && returnFocus && returnFocus.isConnected) returnFocus.focus();
      returnFocus = null;
    }
    function requestClose(focus) {
      var state = draft, token = formToken;
      if (saving) return false;
      if (draftNeedsWarning() && !doc.defaultView.confirm('Discard this unsaved follow-up? If a save was uncertain, refresh and check its saved details before starting again.')) return false;
      if (saving || draft !== state || formToken !== token) return false;
      close(focus); return true;
    }
    function summary() {
      if (!options.onSummary) return;
      if (!ready) { options.onSummary({due:null,overdue:null,upcoming:null,items:[]}); return; }
      var items = rows.filter(owns).map(function (row) { return Object.assign({}, row, {followup:dueFor(row)}); }).filter(function (row) { return !row.paused; }).sort(function (a,b) { return String(a.followup.due || '9999').localeCompare(String(b.followup.due || '9999')); });
      options.onSummary({due:items.filter(function(r){return r.followup.state==='due';}).length,overdue:items.filter(function(r){return r.followup.state==='overdue';}).length,upcoming:items.filter(function(r){return r.followup.state==='upcoming';}).length,items:items.map(function(row){return {id:row.id,display_name:row.display_name,leadership_role:row.leadership_role,team_name:row.team_name,due_on:row.followup.due,state:row.followup.state};})});
    }
    function clear() {
      request++; close(false); rows = []; contacts = []; ready = false; failed = false; mounted = false; mountedEpoch = null; mountedOwner = null;
      filter = 'due'; role = ''; search = ''; host.replaceChildren(); summary();
    }
    function mount() {
      if (mounted) return;
      var c = context(); mounted = true; mountedEpoch = c.epoch; mountedOwner = c.userId; host.classList.add('followups-workspace');
      host.innerHTML = '<div class="followups-intro"><p class="eyebrow">Your people. A little attention, often.</p><h2>Keep your leaders close.</h2><p>Keep a personal rhythm of checking in with deacons, teachers, and church leaders.</p></div>' +
        '<div class="followups-toolbar"><button type="button" data-followups-new>Add a leader</button><button type="button" class="quiet" data-followups-refresh>Refresh follow-ups</button></div>' +
        '<p data-followups-status role="status"></p>' +
        '<nav class="followups-tabs" aria-label="My follow-up views">' + [['due','Due & overdue'],['upcoming','Upcoming'],['all','All active'],['paused','Paused']].map(function(v){return '<button type="button" class="quiet" data-followups-view="'+v[0]+'" aria-pressed="false">'+v[1]+'</button>';}).join('') + '</nav>' +
        '<div class="followups-filters"><label>Search leaders<input type="search" data-followups-search placeholder="Name or team" autocomplete="off"></label><label>Leadership role<select data-followups-role><option value="">All roles</option>' + Object.keys(ROLES).map(function(r){return '<option value="'+r+'">'+ROLES[r]+'</option>';}).join('') + '</select></label></div><div class="followups-list" data-followups-list></div><details class="followups-about"><summary>About this list</summary><p class="followups-note">Only you can view these plans and contact notes in Creek Office. Monthly is a starting point; choose a rhythm that fits each relationship. Dates use church Central time. Logging an attempt or snoozing does not count as a successful contact.</p></details>';
    }
    function syncDraft() {
      if (!dialog || !draft) return;
      var latest = draft.id && rows.find(function(row){return row.id === draft.id && owns(row);});
      if (ready && draft.id && !latest) { close(false); notify('This follow-up is no longer available in your workspace.',true); return; }
      var conflict = ready && draft.id && Number(latest.version) !== draft.version;
      draft.conflict = !!conflict; syncUnload();
      var save = dialog.querySelector('[type="submit"]'); if (save) save.disabled = saving || !ready || !!conflict || !!draft.requiresRefresh;
      dialog.querySelectorAll('input,select,textarea').forEach(function(node){node.disabled = saving || !ready || !current(draft.epoch,draft.owner) || !!draft.requiresRefresh;});
      var message = dialog.querySelector('[data-followups-error]');
      if (message && (!ready || conflict)) message.textContent = conflict ? 'This plan changed after you opened it. Your draft is retained. Close and reopen the plan to review the current version before saving.' : 'The connection was interrupted. Your draft is retained. Refresh follow-ups before saving.';
      if (message && ready && !conflict && !draft.requiresRefresh && message.dataset.loadError) { message.textContent = ''; delete message.dataset.loadError; }
      if (message && !ready) message.dataset.loadError = 'true';
    }
    function render() {
      var c = context();
      if (!identity(c.epoch)) { clear(); return; }
      if (mounted && (mountedEpoch !== c.epoch || mountedOwner !== c.userId)) clear();
      if (!current(c.epoch)) { unavailable(); return; }
      mount(); q('[data-followups-new]').disabled = !ready;
      q('[data-followups-status]').textContent = failed ? 'Your follow-ups could not load. Refresh to try again.' : ready ? '' : 'Loading your follow-ups…';
      host.querySelectorAll('[data-followups-view]').forEach(function(node){node.setAttribute('aria-pressed',String(node.dataset.followupsView === filter));});
      var matches = rows.filter(function(row) {
        var due = dueFor(row), term = search.trim().toLowerCase();
        return owns(row) && (!role || row.leadership_role === role) && (!term || [row.display_name,row.team_name].join(' ').toLowerCase().includes(term)) && (filter === 'paused' ? row.paused : !row.paused && (filter === 'all' || filter === 'due' && ['due','overdue','unscheduled'].includes(due.state) || filter === 'upcoming' && due.state === 'upcoming'));
      }).sort(function(a,b){return String(dueFor(a).due || '0000').localeCompare(String(dueFor(b).due || '0000')) || a.display_name.localeCompare(b.display_name);});
      q('[data-followups-list]').innerHTML = matches.slice(0,100).map(function(row) {
        var due = dueFor(row), tag = due.state === 'paused' ? 'Paused' : due.state === 'overdue' ? 'Overdue · ' + due.daysOverdue + (due.daysOverdue === 1 ? ' day' : ' days') : due.state === 'due' ? 'Due today' : due.state === 'upcoming' ? (due.snoozed ? 'Snoozed until ' : 'Next · ') + labelDate(due.due) : 'Choose a due date';
        return '<article class="followups-row"><div class="followups-main"><span class="followups-tag '+(due.state==='overdue'?'followups-overdue':'')+'">'+safe(tag)+'</span><h3>'+safe(row.display_name)+'</h3><p>'+safe(ROLES[row.leadership_role] || 'Other leader')+(row.team_name?' · '+safe(row.team_name):'')+'</p><p class="followups-small">'+(row.cadence_months ? 'Every '+row.cadence_months+(Number(row.cadence_months)===1?' month':' months') : 'Every '+row.cadence_days+' days')+' · '+(due.lastContact?'Last connected '+labelDate(due.lastContact):'No successful contact recorded')+'</p></div><div class="followups-actions">'+
          action('contact','Record contact',row.id,false)+action('edit','Edit plan',row.id,true)+action('snooze',row.snoozed_until?'Adjust snooze':'Snooze',row.id,true)+action('history','History',row.id,true)+'</div></article>';
      }).join('') || '<div class="followups-empty"><h3>'+(!ready?'Your follow-ups are unavailable.':filter==='due'?'You’re caught up here.':'No leaders match this view.')+'</h3><p>'+(!ready?'Refresh to load your private plans.':!rows.length?'Add your first leader and choose when to check in. Start with one contact a month.':filter==='due'?'Look at Upcoming for the next conversations, or add another leader.':'Try another role or search, or add a leader to your personal list.')+'</p></div>';
      if (matches.length > 100) q('[data-followups-list]').insertAdjacentHTML('afterbegin','<p class="followups-note">Showing 100 of '+matches.length+' plans. Narrow your search to see more.</p>');
      syncDraft(); summary();
    }
    function action(kind,label,id,quiet) { return '<button type="button" '+(quiet?'class="quiet" ':'')+'data-followups-action="'+kind+'" data-followup-id="'+safe(id)+'">'+label+'</button>'; }
    async function fetchRows(table, epoch, owner, token) {
      var all = [], offset = 0, total = null, seen = new Set();
      while (current(epoch,owner) && token === request) {
        var query = options.db.from(table).select('*',{count:'exact'}).eq('owner_id',owner).order('id',{ascending:true});
        var ranged = typeof query.range === 'function';
        var result = await deadline(ranged ? query.range(offset,offset+999) : query);
        if (!current(epoch,owner) || token !== request) return null;
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
        if (offset === total) return all.filter(function(row){return row.owner_id === owner;});
      }
      return null;
    }
    async function load(epoch) {
      var owner = context().userId;
      if (!identity(epoch,owner)) { clear(); return false; }
      if (mounted && (mountedEpoch !== epoch || mountedOwner !== owner)) clear();
      if (!current(epoch,owner)) { unavailable(); return false; }
      mount(); var token=++request;
      try {
        var results=await Promise.all([fetchRows('leader_followups',epoch,owner,token),fetchRows('leader_followup_contacts',epoch,owner,token)]);
        if (!current(epoch,owner) || token !== request) { if(identity(epoch,owner) && token===request)unavailable(); return false; }
        if (!Array.isArray(results[0]) || !Array.isArray(results[1])) throw new Error('incomplete records');
        rows=results[0]; contacts=results[1]; ready=true; failed=false;
        if (draft && draft.requiresRefresh) {
          if (draft.newId && rows.some(function(row){return row.id === draft.newId && owns(row);})) { close(false); notify('This plan was saved. Open it to review the saved details.'); }
          else draft.requiresRefresh=false;
        }
        render(); return true;
      } catch(error) {
        if (!current(epoch,owner) || token !== request) { if(identity(epoch,owner) && token===request)unavailable(); return false; }
        if (authError(error)) { clear(); notify('Access to your personal follow-ups could not be confirmed. Sign in again before opening them.',true); return false; }
        if (draft && draft.kind === 'history') close(false);
        rows=[]; contacts=[]; ready=false; failed=true; render(); return false;
      }
    }
    async function refresh() { try { return options.refresh ? await options.refresh() : await load(context().epoch); } catch (_) { if (current(context().epoch)) { rows=[]; contacts=[]; ready=false; failed=true; render(); } return false; } }
    function input(name,label,type,value,extra) { return '<label>'+safe(label)+'<input name="'+name+'" type="'+type+'" value="'+safe(value || '')+'" '+(extra || '')+'></label>'; }
    function select(name,label,choices,value) { return '<label>'+safe(label)+'<select name="'+name+'">'+Object.keys(choices).map(function(key){return '<option value="'+key+'"'+(key===value?' selected':'')+'>'+choices[key]+'</option>';}).join('')+'</select></label>'; }
    function notes(value) { return '<label class="followups-wide">Private notes<textarea name="notes" maxlength="2000">'+safe(value || '')+'</textarea></label>'; }
    function open(kind,id,trigger) {
      var c=context(), epoch=c.epoch, owner=c.userId, row=id && rows.find(function(r){return r.id===id && owns(r);});
      if (!current(c.epoch) || !ready || (id && !row) || saving) return;
      if (!requestClose(false) || !current(epoch,owner) || !ready) return;
      c=context();row=id && rows.find(function(r){return r.id===id && owns(r);});if(id && !row)return;
      returnFocus=trigger || q('[data-followups-new]');
      draft={id:id || null,newId:!id && kind==='edit'?doc.defaultView.crypto.randomUUID():null,requiresRefresh:false,version:row?Number(row.version):null,epoch:c.epoch,owner:c.userId,kind:kind,lastContact:row?row.last_contact_on:null,conflict:false};
      var token=formToken, title=kind==='edit'?(row?'Edit follow-up plan':'Add a leader'):kind==='contact'?'Record a contact':kind==='history'?'Contact history':'Snooze a follow-up';
      dialog=doc.createElement('dialog');dialog.className='followups-dialog';dialog.setAttribute('aria-labelledby','followups-dialog-title');
      dialog.innerHTML='<header><div><p class="eyebrow">My follow-ups'+(row?' · '+safe(row.display_name):'')+'</p><h2 id="followups-dialog-title">'+title+'</h2></div><button type="button" class="quiet" data-followups-close>Close</button></header>';
      if (kind==='history') {
        var history=contacts.filter(function(r){return r.owner_id===c.userId && r.followup_id===id;}).slice().sort(function(a,b){return String(b.contacted_on).localeCompare(String(a.contacted_on)) || String(b.created_at).localeCompare(String(a.created_at));});
        dialog.insertAdjacentHTML('beforeend','<div class="followups-history">'+(history.map(function(r){return '<article><span class="followups-tag">'+(r.outcome==='connected'?'Connected':'Attempted')+'</span><h3>'+labelDate(r.contacted_on)+'</h3><p>'+safe(METHODS[r.method] || 'Other')+'</p>'+(r.notes?'<p class="followups-preserve">'+safe(r.notes)+'</p>':'')+'</article>';}).join('') || '<p>No contacts recorded yet. Record a conversation or attempt to begin this history.</p>')+'</div>');
      } else {
        var fields='';
        if(kind==='edit') fields=input('display_name','Leader’s name','text',row && row.display_name,'required maxlength="160" autocomplete="off"')+select('leadership_role','Leadership role',ROLES,row?row.leadership_role:'deacon')+input('team_name','Class, committee or team (optional)','text',row && row.team_name,'maxlength="160"')+select('cadence_unit','Repeat interval',{months:'Calendar months',days:'Days'},row && row.cadence_days?'days':'months')+input('cadence_value','Every','number',row?(row.cadence_months || row.cadence_days):1,'required min="1" max="'+(row && row.cadence_days?365:12)+'" step="1"')+input('first_due_on','First contact due','date',row?row.first_due_on:today(),'required')+'<label class="followups-check"><input name="paused" type="checkbox"'+(row && row.paused?' checked':'')+'>Pause reminders for this leader</label><p class="followups-small followups-wide">After a successful contact, the next due date follows this interval. The first due date applies before the first recorded connection. Use Snooze to move a current reminder without recording a contact.</p>'+notes(row && row.notes);
        else if(kind==='contact') fields=input('contacted_on','Contact date','date',today(),'required max="'+today()+'"')+select('outcome','Outcome',{connected:'Connected',attempted:'Attempted'},'connected')+select('method','Method',METHODS,'phone')+'<p class="followups-small">An attempt stays in the history without restarting the interval.</p>'+notes('');
        else fields=input('snoozed_until','Snooze until (clear to remove)','date',row.snoozed_until,'min="'+today()+'"')+'<p class="followups-small">Snoozing moves this reminder later. It does not record a contact or change your repeating interval.</p>';
        var form=doc.createElement('form');form.dataset.followupsForm='';form.innerHTML='<div class="followups-grid">'+fields+'</div><p data-followups-error role="alert"></p><button type="button" class="quiet" data-followups-retry>Refresh follow-ups</button><footer><button type="button" class="quiet" data-followups-close>Cancel</button><button type="submit">'+(kind==='contact'?'Save contact':kind==='snooze'?'Save snooze':'Save plan')+'</button></footer>';
        form.onsubmit=function(event){event.preventDefault();save(form,token);};dialog.appendChild(form);
        draft.initialForm=formFingerprint();form.addEventListener('input',syncUnload,true);form.addEventListener('change',syncUnload,true);
        var unit=form.elements.cadence_unit;if(unit)unit.onchange=function(){form.elements.cadence_value.max=unit.value==='months'?'12':'365';};
        form.querySelector('[data-followups-retry]').onclick=refresh;
      }
      dialog.querySelectorAll('[data-followups-close]').forEach(function(button){button.onclick=function(){requestClose(true);};});
      dialog.addEventListener('cancel',function(event){event.preventDefault();requestClose(true);});doc.body.appendChild(dialog);dialog.showModal();
    }
    async function save(form,token) {
      var state=draft;if(!state || saving || token!==formToken || !current(state.epoch,state.owner))return;
      var error=form.querySelector('[data-followups-error]');
      if(!ready || state.conflict || state.requiresRefresh){syncDraft();return;}
      if(!form.reportValidity())return;
      var submitted={};form.querySelectorAll('[name]').forEach(function(node){submitted[node.name]=node.type==='checkbox'?node.checked:node.value.trim();});
      var value=function(name){return submitted[name] || '';}, payload, message='';
      if(state.kind==='edit') {
        var amount=Number(value('cadence_value')), months=value('cadence_unit')==='months';
        if(!value('display_name') || value('display_name').length>160 || value('team_name').length>160 || !Object.hasOwn(ROLES,value('leadership_role')))message='Enter a name and choose a leadership role. Names and teams may use up to 160 characters.';
        if(!['months','days'].includes(value('cadence_unit')) || !Number.isInteger(amount) || amount<1 || amount>(months?12:365) || !validDate(value('first_due_on')))message='Choose a first due date and an interval from 1 to 12 months or 1 to 365 days.';
        payload={display_name:value('display_name'),leadership_role:value('leadership_role'),team_name:value('team_name') || null,cadence_months:months?amount:null,cadence_days:months?null:amount,first_due_on:value('first_due_on'),paused:!!submitted.paused,notes:value('notes') || null};
      } else if(state.kind==='snooze') {
        if(value('snoozed_until') && (!validDate(value('snoozed_until')) || value('snoozed_until')<today()))message='Choose today or a future date, or clear the date to remove the snooze.';
        payload={snoozed_until:value('snoozed_until') || null};
      } else {
        if(!validDate(value('contacted_on')) || value('contacted_on')>today() || !['connected','attempted'].includes(value('outcome')) || !Object.hasOwn(METHODS,value('method')))message='Choose a valid contact date, outcome and method. Future contacts cannot be recorded.';
      }
      if(value('notes').length>2000)message='Keep private notes to 2,000 characters.';
      if(message){error.textContent=message;return;}
      saving=true;syncUnload();error.textContent='';dialog.querySelectorAll('input,select,textarea,button').forEach(function(node){node.disabled=true;});
      try {
        if(options.ensureReady && !await options.ensureReady(state.epoch))throw new Error('readiness');
        if(!current(state.epoch,state.owner) || token!==formToken)throw new Error('readiness');
        var result;
        if(state.kind==='contact')result=await deadline(options.db.rpc('record_leader_contact',{p_id:state.id,p_version:state.version,p_contacted_on:value('contacted_on'),p_outcome:value('outcome'),p_method:value('method'),p_notes:value('notes') || null}));
        else {
          var query=options.db.from('leader_followups');
          query=state.id?query.update(payload).eq('id',state.id).eq('owner_id',state.owner).eq('version',state.version):query.insert(Object.assign({id:state.newId},payload));
          result=await deadline(query.select('*').single());
        }
        if(!current(state.epoch,state.owner) || token!==formToken){if(identity(state.epoch,state.owner) && token===formToken){state.requiresRefresh=true;unavailable();}return;}
        if(result.error)throw result.error;
        var saved=result.data;
        if(!saved || typeof saved.id!=='string' || !saved.id || (saved.id!==(state.id || state.newId)) || !Number.isInteger(saved.version) || saved.version<1 || (!state.id && saved.version!==1) || (state.id && Number(saved.version)!==state.version+1) || (state.kind!=='contact' && saved.owner_id!==state.owner))throw new Error('unconfirmed');
        if (state.kind === 'contact') {
          var expectedLast = state.lastContact || null;
          if (value('outcome') === 'connected' && (!expectedLast || value('contacted_on') > expectedLast)) expectedLast = value('contacted_on');
          if ((saved.last_contact_on || null) !== expectedLast) throw new Error('unconfirmed');
        }
        close(false);await refresh();if(current(state.epoch,state.owner))notify(state.kind==='contact'?'Contact saved to your personal history.':'Your follow-up plan was saved.');
      } catch(failure) {
        if(!identity(state.epoch,state.owner) || token!==formToken)return;
        if(authError(failure)){clear();notify('Access to your personal follow-ups could not be confirmed. Sign in again before saving.',true);return;}
        state.requiresRefresh=true;
        error.textContent='The save could not be confirmed. Your submitted draft is retained and temporarily locked. Refresh follow-ups to check the saved version before editing or trying again.';
      } finally { if(identity(state.epoch,state.owner) && token===formToken){saving=false;if(dialog)dialog.querySelectorAll('input,select,textarea,button').forEach(function(node){node.disabled=false;});syncDraft();} }
    }
    host.addEventListener('click',function(event){var button=event.target.closest('button');if(!button || !host.contains(button) || !current(context().epoch))return;
      if(button.hasAttribute('data-followups-new'))open('edit');
      else if(button.hasAttribute('data-followups-refresh'))refresh();
      else if(button.dataset.followupsView){filter=button.dataset.followupsView;render();}
      else if(button.dataset.followupsAction)open(button.dataset.followupsAction,button.dataset.followupId,button);
    });
    host.addEventListener('input',function(event){if(current(context().epoch) && event.target.matches('[data-followups-search]')){search=event.target.value;render();}});
    host.addEventListener('change',function(event){if(current(context().epoch) && event.target.matches('[data-followups-role]')){role=event.target.value;render();}});
    function showView(view) {
      if (!current(context().epoch) || !['due','upcoming','all','paused'].includes(view)) return;
      if (mounted && (mountedEpoch !== context().epoch || mountedOwner !== context().userId)) clear();
      filter=view; role=''; search=''; render();
      q('[data-followups-search]').value=''; q('[data-followups-role]').value='';
    }
    return {load:load,render:render,clear:clear,openNew:function(){open('edit');},showView:showView};
  }
  return {create:create,dueFor:dueFor,today:today,validDate:validDate,addMonths:addMonths};
}));
