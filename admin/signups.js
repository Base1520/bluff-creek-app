/* Private staff review of voluntarily submitted app connection details. */
(function (root) {
  'use strict';
  function create(options) {
    var host = options.root, doc = host.ownerDocument, rows = [], request = 0, formVersion = 0;
    var review = null;
    var ready = false, failed = false, dialog = null, mounted = false, filter = 'pending', term = '';
    function deadline(request) {
      var timer;
      return Promise.race([Promise.resolve(request),new Promise(function(_resolve,reject){timer=doc.defaultView.setTimeout(function(){reject(new Error('The request timed out.'));},12000);})]).finally(function(){doc.defaultView.clearTimeout(timer);});
    }
    function context() { return options.getContext() || {}; }
    function identity(epoch) { var c = context(); return c.epoch === epoch && !!c.userId && ['admin', 'editor'].includes(c.role) && options.isCurrent(epoch); }
    function current(epoch) { return identity(epoch) && context().canEdit && context().workspaceReady !== false; }
    function safe(value) { var e = doc.createElement('span'); e.textContent = value == null ? '' : String(value); return e.innerHTML.replace(/"/g, '&quot;'); }
    function personName(p) { return [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ') || 'Unnamed person'; }
    function date(value) { var d = new Date(value); return isNaN(d) ? 'Date unavailable' : d.toLocaleDateString('en-US', {timeZone:'America/Chicago', month:'short',day:'numeric',year:'numeric'}); }
    function peopleAvailable() { return !options.peopleReady || options.peopleReady(); }
    function refreshRecords() { return options.refresh ? options.refresh() : load(context().epoch); }
    function pending(row) { return row.status === 'pending' || Number(row.version) > Number(row.reviewed_version || 0); }
    function reviewFingerprint() { return dialog ? JSON.stringify(Array.from(dialog.querySelectorAll('form [name]')).filter(function(node){return node.name!=='person_search';}).map(function(node){return [node.name,node.type==='checkbox'?node.checked:node.value];})) : ''; }
    function reviewNeedsWarning() { return !!(review && dialog && dialog.querySelector('form') && (review.busy || review.requiresRefresh || review.conflict || (review.initialForm !== undefined && reviewFingerprint() !== review.initialForm))); }
    function warnUnload(event) { if(reviewNeedsWarning()){event.preventDefault();event.returnValue=true;} }
    function syncUnload() { doc.defaultView[reviewNeedsWarning()?'addEventListener':'removeEventListener']('beforeunload',warnUnload); }
    function close(force) {
      var state=review,token=formVersion;
      if(review && review.busy && force!==true)return false;
      if(force!==true && reviewNeedsWarning() && !doc.defaultView.confirm('Discard this unsaved signup review? If a save was uncertain, refresh and check the saved review before starting again.'))return false;
      if(force!==true && (review!==state || formVersion!==token || review && review.busy))return false;
      review=null;syncUnload();formVersion++;if(dialog){if(dialog.open)dialog.close();dialog.remove();dialog=null;}return true;
    }
    function clear() { request++; close(true); rows = []; ready = false; failed = false; mounted = false; filter = 'pending'; term = ''; host.replaceChildren(); if (options.onCount) options.onCount(null); }
    function mount() {
      if (mounted) return;
      host.classList.add('signup-workspace');
      host.innerHTML = '<div class="signup-intro"><p class="eyebrow">From a first hello to lasting care</p><h2>Every connection has a next step.</h2><p>Review app signups and profile updates, check for an existing person, and assign a welcome contact.</p></div>' +
        '<div class="signup-summary panel"><div><span class="eyebrow">Awaiting review</span><strong data-signup-count>—</strong></div><p>Welcome goal: within two days of the first submission. Monthly Sunday school and quarterly deacon care are separate plans.</p><button type="button" class="quiet" data-signup-refresh>Refresh signups</button></div>' +
        '<p class="signup-status" role="status" data-signup-status></p><div class="signup-filters"><label>Search signups<input type="search" data-signup-search placeholder="Name, email or Sunday school class"></label><label>Show<select data-signup-filter><option value="pending">Awaiting review</option><option value="reviewed">Reviewed</option><option value="all">All submissions</option></select></label></div>' +
        '<p class="signup-note">A submitted profile is self-reported information, not church membership or permission for mass messaging. Installing the app alone creates no record. This queue refreshes while the workspace is open; it does not send staff alerts.</p><div data-signup-list class="signup-list"></div>';
      host.querySelector('[data-signup-refresh]').onclick = function () { refreshRecords(); };
      host.querySelector('[data-signup-search]').oninput = function (e) { term = e.target.value; render(); };
      host.querySelector('[data-signup-filter]').onchange = function (e) { filter = e.target.value; render(); };
      mounted = true;
    }
    async function load(epoch) {
      if (!identity(epoch)) { clear(); return false; }
      if (!current(epoch)) { unavailable(); return false; }
      mount(); var id = ++request, all = [], total = null, seen = new Set(), offset = 0;
      try {
        while (current(epoch) && id === request) {
          var query = options.db.from('app_connections').select('*', {count:'exact'}).order('updated_at', {ascending:false}).order('id', {ascending:true});
          var ranged = typeof query.range === 'function';
          var result = await deadline(ranged ? query.range(offset, offset + 999) : query);
          if (!current(epoch) || id !== request) { if(identity(epoch) && id===request)unavailable(); return false; }
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
        if (!current(epoch) || id !== request) return false;
        rows = all; ready = true; failed = false;
        if(dialog && review && !review.busy) {
          var latest=rows.find(function(r){return r.id===dialog.dataset.signupId;});
          if(!latest || latest.version!==review.version)review.conflict=true;
          else if(review.requiresRefresh && !pending(latest)) { close(true); options.notice('This signup is now reviewed. Open the saved review to check its identity and welcome plan.'); }
          else review.requiresRefresh=false;
        }
        render(); syncReview(); return true;
      } catch (error) {
        if (current(epoch) && id === request) { rows = []; ready = false; failed = true; if (error && ['42501','PGRST301','PGRST302'].includes(error.code)) close(true); render(); if (dialog) { var errorNode = dialog.querySelector('[data-signup-error]'); if (errorNode) errorNode.textContent = 'The connection was interrupted. Your review draft is retained. Refresh records before saving.'; } }
        syncReview(); return false;
      }
    }
    function syncReview() {
      syncUnload();
      if(!dialog || !review)return;
      var blocked=review.busy || review.requiresRefresh || review.conflict || !ready || !current(review.epoch) || !peopleAvailable();
      dialog.querySelectorAll('input,select,textarea').forEach(function(node){node.disabled=blocked || (review.linked && ['contact_id','person_search'].includes(node.name));});
      var save=dialog.querySelector('[type=submit]');if(save)save.disabled=blocked;
      dialog.querySelectorAll('[data-signup-close],[data-signup-retry]').forEach(function(node){node.disabled=review.busy;});
      var error=dialog.querySelector('[data-signup-error]');
      if(error && review.conflict)error.textContent='This signup changed or is no longer available. Your draft is preserved. Close and reopen the current signup to review it before saving.';
      else if(error && (!current(review.epoch) || !ready))error.textContent='The workspace connection is unavailable. Your draft is preserved. Refresh records before saving.';
    }
    function unavailable() {
      rows=[];ready=false;failed=true;if(options.onCount)options.onCount(null);
      if(mounted){host.querySelector('[data-signup-list]').replaceChildren();host.querySelector('[data-signup-count]').textContent='—';host.querySelector('[data-signup-status]').textContent='The workspace connection is unavailable. Refresh to reconnect.';}
      syncReview();
    }
    function render() {
      if (!identity(context().epoch)) { clear(); return; }
      if (!current(context().epoch)) { unavailable(); return; }
      mount(); var count = rows.filter(pending).length;
      host.querySelector('[data-signup-count]').textContent = failed ? '—' : String(count);
      if (options.onCount) options.onCount(failed ? null : count);
      host.querySelector('[data-signup-status]').textContent = failed ? 'Signups could not load. Check the private connection and signup migration, then refresh.' : !peopleAvailable() ? 'People records are unavailable. Refresh records before reviewing identities or creating visitors.' : ready ? 'Showing the latest loaded submissions. Refreshes every minute while this tab is visible.' : 'Loading signups…';
      var matches = rows.filter(function (r) { return (filter === 'all' || (filter === 'pending' ? pending(r) : !pending(r))) && (!term || [r.first_name,r.last_name,r.email,r.phone,r.sunday_school].join(' ').toLowerCase().includes(term.trim().toLowerCase())); });
      var area = host.querySelector('[data-signup-list]'); area.replaceChildren();
      if (!matches.length) { var blank = doc.createElement('p'); blank.className = 'signup-empty'; blank.textContent = failed ? 'The signup queue is unavailable.' : 'No submissions match this view.'; area.appendChild(blank); }
      if (matches.length > 100) { var limit = doc.createElement('p'); limit.className = 'signup-note'; limit.textContent = 'Showing the first 100 of ' + matches.length + ' submissions. Narrow the search to see more.'; area.appendChild(limit); }
      matches.slice(0,100).forEach(function (r) {
        var card = doc.createElement('article'); card.className = 'signup-row';
        var isUpdate = !!r.contact_id || Number(r.reviewed_version) > 0;
        card.innerHTML = '<div><span class="signup-tag">' + (pending(r) ? (isUpdate ? 'Profile update · review needed' : 'New signup') : 'Reviewed') + '</span><h3>' + safe(personName(r)) + '</h3><p>' + safe(r.email) + (r.phone ? ' · ' + safe(r.phone) : '') + '</p><p class="signup-note">' + (r.sunday_school ? 'Sunday school: ' + safe(r.sunday_school) + ' · ' : '') + 'Updated ' + safe(date(r.updated_at)) + '</p></div>';
        var b = doc.createElement('button'); b.type = 'button'; b.className = 'quiet'; b.textContent = pending(r) ? 'Review & assign welcome' : 'View reviewed signup'; b.disabled = !peopleAvailable(); b.onclick = function () { open(r.id); }; card.appendChild(b); area.appendChild(card);
      });
    }
    function open(id) {
      var epoch = context().epoch, row = rows.find(function (r) { return r.id === id; });
      if (!current(epoch) || !ready || !peopleAvailable() || !row) return;
      if(!close())return;
      row=rows.find(function(r){return r.id===id;});
      if(!current(epoch) || !ready || !peopleAvailable() || !row)return;
      var version = formVersion;
      review={epoch:epoch,version:row.version,linked:!!row.contact_id,busy:false,requiresRefresh:false,conflict:false};
      dialog = doc.createElement('dialog'); dialog.dataset.signupId = row.id; dialog.className = 'signup-dialog'; dialog.setAttribute('aria-labelledby','signup-review-title');
      var isPending = pending(row), people = options.people();
      dialog.innerHTML = '<header><div><p class="eyebrow">' + (row.contact_id ? 'Review a profile update' : 'Welcome a new connection') + '</p><h2 id="signup-review-title">' + safe(personName(row)) + '</h2></div><button type="button" class="quiet" data-signup-close>Close</button></header><dl class="signup-details"><dt>Verified email account</dt><dd>' + safe(row.email) + '</dd><dt>Phone · self-reported</dt><dd>' + safe(row.phone || 'Not supplied') + '</dd><dt>Preferred contact</dt><dd>' + safe(row.preferred_contact) + '</dd><dt>Care contact permission</dt><dd>' + (row.contact_permission ? 'Requested church follow-up' : 'Not granted') + '</dd><dt>Sunday school</dt><dd>' + safe(row.sunday_school || 'Not supplied') + '</dd><dt>First submitted</dt><dd>' + safe(date(row.submitted_at)) + '</dd></dl>';
      if (!isPending) {
        var done = doc.createElement('p'); done.className = 'signup-note'; done.textContent = 'Reviewed ' + date(row.reviewed_at) + '. A linked care plan can be managed in Guests & care.'; dialog.appendChild(done);
      } else {
        var form = doc.createElement('form');
        form.innerHTML = '<p class="signup-note">Check the person’s identity before linking. The submitted details stay here for review; linking does not overwrite an existing People record or change membership status.</p><label>Search existing people<input name="person_search" type="search" placeholder="Name, email or phone" autocomplete="off"></label><label>Person to connect<select name="contact_id" required><option value="">Choose an existing person or create a visitor</option><option value="__new">Create a new visitor record</option></select></label><label>Welcome contact assigned to<input name="welcome_owner" maxlength="120" placeholder="Staff member or welcome team"></label><p class="signup-note">A new one-time welcome plan is due two days after the original submission. Existing welcome plans are preserved. An empty assignment appears as unassigned. Assignment does not send a message or grant workspace access.</p><label>Private review notes<textarea name="staff_notes" maxlength="2000"></textarea></label><label class="signup-check"><input name="identity_checked" type="checkbox" required><span>I checked for an existing person and reviewed these details.</span></label><p role="alert" data-signup-error></p><button type="button" class="quiet" data-signup-retry>Refresh records</button><footer><button type="button" class="quiet" data-signup-close>Cancel</button><button type="submit">Save review & welcome plan</button></footer>';
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
          if (save.disabled || !review || review.busy || review.requiresRefresh || review.conflict || !form.reportValidity() || !current(epoch) || version !== formVersion) return;
          if (!ready || !peopleAvailable()) { error.textContent = 'Refresh records before saving. The People list and signup queue must be available for identity review.'; return; }
          var chosen = select.value;
          if (!form.elements.identity_checked.checked || (chosen !== '__new' && !people.some(function (p) { return p.id === chosen; }))) { error.textContent = 'Choose a person and confirm the identity review.'; return; }
          var submitted={p_id:row.id,p_version:row.version,p_contact_id:chosen === '__new' ? null : chosen,p_create_person:chosen === '__new',p_staff_notes:form.elements.staff_notes.value.trim() || null,p_welcome_owner:form.elements.welcome_owner.value.trim() || null};
          review.busy=true; error.textContent = ''; syncReview();
          try {
            if(options.ensureReady && !await options.ensureReady(epoch))throw new Error('readiness');
            if(!current(epoch) || version!==formVersion)throw new Error('readiness');
            var result = await deadline(options.db.rpc('review_app_connection', submitted));
            if (!current(epoch) || version !== formVersion) { if(identity(epoch) && version===formVersion && review){review.requiresRefresh=true;unavailable();}return; }
            if (result.error || !result.data || result.data.id !== row.id || result.data.version !== row.version || result.data.status !== 'reviewed' || !result.data.contact_id || (chosen !== '__new' && result.data.contact_id !== chosen)) throw new Error('review');
            close(true); await options.refresh();
            if (current(epoch)) options.notice(result.data.already_reviewed ? 'This version was already reviewed. The existing person and welcome plan were preserved; these draft changes were not applied.' : 'Signup reviewed. Open Guests & care to manage the welcome plan and ongoing contacts.');
          } catch (_) { if (identity(epoch) && version === formVersion && review) { review.requiresRefresh=true; error.textContent = 'The review could not be confirmed. Your submitted draft is locked temporarily. Refresh records before retrying.'; } }
          finally { if (identity(epoch) && version === formVersion && review) { review.busy=false; syncReview(); } }
        };
        dialog.appendChild(form);
      }
      dialog.querySelectorAll('[data-signup-close]').forEach(function (b) { b.onclick = close; });
      dialog.addEventListener('cancel',function(e){e.preventDefault();close();});
      review.initialForm=reviewFingerprint();doc.body.appendChild(dialog);dialog.showModal();syncUnload();
    }
    return {load:load,render:render,clear:clear,open:open};
  }
  root.CreekSignups = {create:create};
}(typeof window !== 'undefined' ? window : globalThis));
