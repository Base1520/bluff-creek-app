/* Private staff records. Status and sharing fields do not publish or send content. */
(function (root) {
  'use strict';
  var views = {
    announcements: { table: 'office_announcements', singular: 'announcement', title: 'Prepare the words. Keep the team together.',
      description: 'Draft and review church announcements here. Ready means prepared for staff use; it does not publish to the website or app.', statuses: ['draft', 'ready', 'archived'], initial: 'draft' },
    committees: { table: 'committee_contacts', singular: 'committee contact', title: 'Know who is serving.',
      description: 'Keep committee contacts, roles, and terms together. These details stay in the private office.', statuses: ['active', 'inactive'], initial: 'active' },
    slides: { table: 'sunday_slides', singular: 'slide record', title: 'Get Sunday’s slides in place.',
      description: 'Organize an existing Google Slides, Canva, or other HTTPS deck link, or attach a file from Documents. This workspace does not generate a presentation.', statuses: ['draft', 'ready', 'archived'], initial: 'draft' },
    prayers: { table: 'office_prayer_requests', singular: 'prayer request', title: 'Keep praying. Keep caring.',
      description: 'Maintain the staff prayer list by hand. The public prayer form opens an email draft; it does not automatically add requests here.', statuses: ['active', 'answered', 'archived'], initial: 'active' }
  };
  function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value + 'T12:00:00Z')) &&
      new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
  }
  function deckLink(value) {
    if (typeof value !== 'string') return null;
    value = value.trim();
    if (!value || value.length > 4096 || /[\s\x00-\x1f\x7f\\]/.test(value)) return null;
    try {
      var url = new URL(value);
      var hostname = url.hostname;
      if (url.protocol !== 'https:' || url.username || url.password || !hostname || hostname.length > 253 || !/^[a-z0-9.-]+$/i.test(hostname) ||
        (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) ||
        hostname.split('.').some(function (label) { return label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label); })) return null;
      return url.href;
    } catch (_) { return null; }
  }
  function create(options) {
    var roots = options.roots, first = Object.keys(views).map(function (view) { return roots[view]; }).find(Boolean);
    if (!first) throw new Error('Office content needs a root section.');
    var doc = first.ownerDocument, state = {}, filters = {}, ready = {}, failed = {}, mounted = {}, loadId = 0, mountedEpoch = null;
    var dialog = null, formVersion = 0, dialogEpoch = null, dialogView = null, dialogRecord = null, returnFocus = null, saving = false;
    Object.keys(views).forEach(function (view) { state[view] = []; filters[view] = { search: '', status: 'current' }; ready[view] = false; failed[view] = false; });
    function context() { return options.getContext() || {}; }
    function allowed(ctx) { return !!ctx.userId && ctx.canEdit === true && ['admin', 'editor'].indexOf(ctx.role) !== -1 && options.isCurrent(ctx.epoch); }
    function current(epoch) { var ctx = context(); return ctx.epoch === epoch && allowed(ctx); }
    function safe(value) { var node = doc.createElement('span'); node.textContent = value == null ? '' : String(value); return node.innerHTML.replace(/"/g, '&quot;'); }
    function capitalize(value) { return String(value || '').replace(/_/g, ' ').replace(/^./, function (letter) { return letter.toUpperCase(); }); }
    function dateLabel(value) { return validDate(value) ? new Date(value + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : ''; }
    function documents() { var list = options.documents ? options.documents() : []; return Array.isArray(list) ? list : []; }
    function notice(text, bad) { if (allowed(context())) options.notice(text, !!bad); }
    function tag(value) { return '<span class="office-content-tag">' + safe(capitalize(value)) + '</span>'; }
    function button(label, attribute, value) { return '<button type="button" class="quiet" ' + attribute + '="' + safe(value || '') + '">' + safe(label) + '</button>'; }
    function textBlock(value, label) {
      if (!value) return '';
      var text = String(value);
      if (text.length <= 220) return '<p class="office-content-text">' + safe(text) + '</p>';
      return '<p class="office-content-text">' + safe(text.slice(0, 200)) + '…</p><details><summary>' + safe(label || 'Read more') + '</summary><p class="office-content-text">' + safe(text) + '</p></details>';
    }
    function mount(view) {
      var host = roots[view], config = views[view];
      if (!host) return;
      host.classList.add('office-content');
      host.innerHTML = '<div class="office-content-intro"><p class="eyebrow">Private staff workspace</p><h2>' + config.title + '</h2><p>' + config.description + '</p>' +
        (view === 'slides' ? '<div class="office-content-upload">' + button('Upload slides', 'data-office-upload', '') + '<p>Save a draft before uploading a new file. Then edit its record to attach the file from Documents.</p></div>' : '') +
        (view === 'prayers' ? '<p class="office-content-note">Sharing scope records permission only. Every approved office editor can read these records. Approval here does not send, publish, or change who has access.</p>' : '') + '</div>' +
        '<div class="office-content-filters"><label>Search ' + (view === 'committees' ? 'committee contacts' : view === 'prayers' ? 'prayer requests' : view) + '<input type="search" data-office-search autocomplete="off" placeholder="Search these records"></label>' +
        '<label>Status<select data-office-status><option value="current">Current records</option><option value="all">All statuses</option>' + config.statuses.map(function (status) { return '<option value="' + status + '">' + capitalize(status) + '</option>'; }).join('') + '</select></label></div>' +
        '<p class="office-content-status" role="status"></p><div class="office-content-list panel"></div>';
      mounted[view] = true;
    }
    function rowHTML(view, row) {
      var title = view === 'committees' ? row.committee_name : view === 'prayers' ? row.display_name : row.title;
      var body = '', actions = '';
      if (view === 'announcements') {
        body = textBlock(row.body, 'Read the full announcement');
        if (row.starts_on || row.ends_on) body += '<p class="office-content-meta">' + safe((row.starts_on ? 'Starts ' + dateLabel(row.starts_on) : '') + (row.starts_on && row.ends_on ? ' · ' : '') + (row.ends_on ? 'Ends ' + dateLabel(row.ends_on) : '')) + '</p>';
        if (row.status === 'ready') body += '<p class="office-content-meta">Ready for staff use · not published</p>';
      } else if (view === 'committees') {
        body = '<p><b>' + safe(row.contact_name) + '</b>' + (row.role_label ? ' · ' + safe(row.role_label) : '') + '</p>' +
          (row.email || row.phone ? '<p class="office-content-meta">' + safe([row.email, row.phone].filter(Boolean).join(' · ')) + '</p>' : '');
        if (row.term_start || row.term_end) body += '<p class="office-content-meta">' + safe((row.term_start ? 'Term starts ' + dateLabel(row.term_start) : '') + (row.term_start && row.term_end ? ' · ' : '') + (row.term_end ? 'Term ends ' + dateLabel(row.term_end) : '')) + '</p>';
        body += textBlock(row.notes, 'Read committee notes');
      } else if (view === 'slides') {
        body = '<p class="office-content-meta">Service · ' + safe(dateLabel(row.service_date)) + '</p>' + textBlock(row.notes, 'Read slide notes');
        var url = deckLink(row.deck_url);
        if (url) actions += '<a class="office-content-link" href="' + safe(url) + '" target="_blank" rel="noopener noreferrer">Open deck ↗</a>';
        if (row.document_id) {
          var file = documents().find(function (item) { return item.id === row.document_id; });
          if (file) actions += button('Open attached file', 'data-office-document', row.document_id);
          else body += '<p class="office-content-meta">The attached file is not in the available Documents list.</p>';
        }
      } else if (view === 'prayers') {
        body = textBlock(row.request_text, 'Read the full prayer request') + '<p class="office-content-meta">Scope recorded: ' + safe(capitalize(row.share_scope)) +
          (row.share_scope !== 'staff_only' ? (row.sharing_approved ? ' · Sharing approval recorded' : ' · Approval not recorded') : '') + '</p>';
        if (row.care_notes) body += '<details><summary>Staff care notes</summary><p class="office-content-text">' + safe(row.care_notes) + '</p></details>';
      }
      actions += button('Edit', 'data-office-edit', row.id);
      return '<article class="office-content-row"><div class="office-content-main"><div class="office-content-title"><h3>' + safe(title) + '</h3>' + tag(row.status) + '</div>' + body + '</div><div class="office-content-actions">' + actions + '</div></article>';
    }
    function renderView(view) {
      var host = roots[view];
      if (!host) return;
      if (!mounted[view]) mount(view);
      var filter = filters[view], config = views[view];
      var rows = state[view].filter(function (row) {
        var statusMatch = filter.status === 'all' || (filter.status === 'current' ? ['archived', 'inactive'].indexOf(row.status) === -1 : row.status === filter.status);
        var haystack = [row.title, row.body, row.committee_name, row.contact_name, row.role_label, row.email, row.phone, row.notes, row.display_name, row.request_text, row.care_notes, row.service_date].filter(Boolean).join(' ').toLowerCase();
        return statusMatch && (!filter.search || haystack.includes(filter.search.toLowerCase()));
      });
      rows.sort(function (a, b) { return view === 'slides' ? String(b.service_date || '').localeCompare(String(a.service_date || '')) : String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')); });
      host.querySelector('.office-content-list').innerHTML = rows.slice(0, 100).map(function (row) { return rowHTML(view, row); }).join('') || '<p class="office-content-empty">' + (ready[view] ? 'No records match. Use Add to create a ' + config.singular + '.' : 'Records have not loaded.') + '</p>';
      host.querySelector('.office-content-status').textContent = failed[view] ? 'These records could not load. Refresh the workspace to try again.' : !ready[view] ? 'Loading private records…' : rows.length + ' matching ' + (rows.length === 1 ? 'record' : 'records') + (rows.length > 100 ? ' · Showing the first 100; narrow your search to see more.' : '.');
      var retry = host.querySelector('[data-office-refresh]');
      if (failed[view] && !retry) host.querySelector('.office-content-status').insertAdjacentHTML('afterend', button('Refresh records', 'data-office-refresh', ''));
      if (!failed[view] && retry) retry.remove();
    }
    function render() {
      var ctx = context();
      if (!allowed(ctx)) { clear(); return; }
      if (mountedEpoch !== null && mountedEpoch !== ctx.epoch) clear();
      mountedEpoch = ctx.epoch;
      Object.keys(views).forEach(renderView);
    }
    async function rowsFor(view, epoch, token) {
      var rows = [];
      try {
        for (var offset = 0; current(epoch) && token === loadId; offset += 1000) {
          var result = await options.db.from(views[view].table).select('*').order('id', { ascending: true }).range(offset, offset + 999);
          if (!current(epoch) || token !== loadId) return null;
          if (result.error) throw new Error('load');
          var page = result.data || []; rows = rows.concat(page);
          if (page.length < 1000) return { rows: rows, failed: false };
        }
      } catch (_) { if (current(epoch) && token === loadId) return { rows: [], failed: true }; }
      return null;
    }
    async function load(epoch) {
      if (!current(epoch)) return false;
      if (mountedEpoch !== null && mountedEpoch !== epoch) clear();
      var token = ++loadId, names = Object.keys(views);
      var results = await Promise.all(names.map(function (view) { return roots[view] ? rowsFor(view, epoch, token) : Promise.resolve({ rows: [], failed: false }); }));
      if (!current(epoch) || token !== loadId) return false;
      names.forEach(function (view, i) { state[view] = results[i] ? results[i].rows : []; failed[view] = !results[i] || results[i].failed; ready[view] = !failed[view]; });
      mountedEpoch = epoch; render(); return names.every(function (view) { return !failed[view]; });
    }
    function input(name, label, value, type, required, maximum, wide) {
      return '<label' + (wide ? ' class="office-content-wide"' : '') + '>' + safe(label) + '<input name="' + name + '" type="' + (type || 'text') + '" value="' + safe(value || '') + '"' + (required ? ' required' : '') + (maximum ? ' maxlength="' + maximum + '"' : '') + '></label>';
    }
    function textarea(name, label, value, required, maximum) {
      return '<label class="office-content-wide">' + safe(label) + '<textarea name="' + name + '"' + (required ? ' required' : '') + (maximum ? ' maxlength="' + maximum + '"' : '') + '>' + safe(value || '') + '</textarea></label>';
    }
    function select(name, label, choices, selected) {
      return '<label>' + safe(label) + '<select name="' + name + '">' + choices.map(function (value) { return '<option value="' + value + '"' + (selected === value ? ' selected' : '') + '>' + capitalize(value) + '</option>'; }).join('') + '</select></label>';
    }
    function closeDialog(restore) {
      formVersion++; saving = false; dialogEpoch = null; dialogView = null; dialogRecord = null;
      if (dialog) { var old = dialog; dialog = null; if (old.open) old.close(); old.remove(); }
      if (restore && returnFocus && returnFocus.isConnected) returnFocus.focus();
      returnFocus = null;
    }
    function updatePrayerApproval(reset) {
      if (!dialog || dialogView !== 'prayers') return;
      var nonStaff = dialog.querySelector('[name="share_scope"]').value !== 'staff_only';
      var checkbox = dialog.querySelector('[name="sharing_approved"]');
      if (reset) checkbox.checked = false;
      checkbox.required = nonStaff; checkbox.disabled = !nonStaff;
      if (!nonStaff) checkbox.checked = false;
      dialog.querySelector('[data-office-sharing-help]').textContent = nonStaff ? 'Record explicit approval before selecting a wider sharing scope. This still does not send or publish the request.' : 'Staff only is the default. Nothing is sent or published by this editor.';
    }
    function openEditor(view, record, trigger) {
      var ctx = context(), config = views[view];
      if (!config || !roots[view] || !allowed(ctx) || saving) return;
      if (!ready[view]) { notice('Wait for these records to load, or refresh the workspace before editing.', true); return; }
      closeDialog(false); dialogView = view; dialogEpoch = ctx.epoch; dialogRecord = record || null; returnFocus = trigger || doc.activeElement;
      var row = record || {}, fields = '';
      if (view === 'announcements') fields = input('title', 'Title', row.title, 'text', true, 160, true) + textarea('body', 'Announcement text', row.body, true, 10000) + input('starts_on', 'Starts on (optional)', row.starts_on, 'date') + input('ends_on', 'Ends on (optional)', row.ends_on, 'date');
      if (view === 'committees') fields = input('committee_name', 'Committee', row.committee_name, 'text', true, 160) + input('contact_name', 'Contact name', row.contact_name, 'text', true, 160) + input('role_label', 'Role (optional)', row.role_label) + input('email', 'Email (optional)', row.email, 'email') + input('phone', 'Phone (optional)', row.phone, 'tel') + '<div></div>' + input('term_start', 'Term starts (optional)', row.term_start, 'date') + input('term_end', 'Term ends (optional)', row.term_end, 'date') + textarea('notes', 'Committee notes', row.notes);
      if (view === 'slides') {
        fields = input('title', 'Title', row.title, 'text', true, 160, true) + input('service_date', 'Service date', row.service_date, 'date', true) + input('deck_url', 'Existing deck link (HTTPS)', row.deck_url, 'url', false, 4096);
        fields += '<label class="office-content-wide">File from Documents (optional)<select name="document_id"><option value="">No attached file</option>' + documents().map(function (item) { return '<option value="' + safe(item.id) + '"' + (row.document_id === item.id ? ' selected' : '') + '>' + safe(item.title || 'Untitled document') + '</option>'; }).join('');
        if (row.document_id && !documents().some(function (item) { return item.id === row.document_id; })) fields += '<option value="' + safe(row.document_id) + '" selected>Previously attached file (not in the current list)</option>';
        fields += '</select><small>A ready record needs a deck link or attached file. To upload a new file, save a draft first, choose Upload slides, then edit this record to attach it.</small></label>' + textarea('notes', 'Slide preparation notes', row.notes);
      }
      if (view === 'prayers') fields = input('display_name', 'Display name for this staff record', row.display_name, 'text', true, 160, true) + textarea('request_text', 'Prayer request', row.request_text, true, 10000) + textarea('care_notes', 'Staff care notes', row.care_notes) + select('share_scope', 'Recorded sharing scope', ['staff_only', 'prayer_team', 'church'], row.share_scope || 'staff_only') + '<label class="office-content-check"><input type="checkbox" name="sharing_approved"' + (row.sharing_approved ? ' checked' : '') + '>Approval for this sharing scope has been recorded</label><p class="office-content-wide office-content-note" data-office-sharing-help></p>';
      fields += select('status', 'Status', config.statuses, row.status || config.initial);
      dialog = doc.createElement('dialog'); dialog.className = 'office-content-dialog'; dialog.setAttribute('aria-labelledby', 'office-content-form-title'); dialog.setAttribute('aria-describedby', 'office-content-form-help');
      dialog.innerHTML = '<form data-office-form><header><div><p class="eyebrow">Private staff record</p><h2 id="office-content-form-title">' + (record ? 'Edit ' : 'Add ') + config.singular + '</h2></div><button type="button" class="quiet" data-office-close>Close</button></header><div class="office-content-form-body"><p id="office-content-form-help" class="office-content-note">' + config.description + '</p><div class="office-content-form-grid">' + fields + '</div><p class="office-content-error error" role="alert"></p></div><footer><button type="button" class="quiet" data-office-close>Cancel</button><button type="submit">Save ' + config.singular + '</button></footer></form>';
      dialog.querySelectorAll('[data-office-close]').forEach(function (node) { node.onclick = function () { closeDialog(true); }; });
      dialog.addEventListener('cancel', function (event) { event.preventDefault(); closeDialog(true); });
      dialog.addEventListener('change', function (event) { if (event.target.name === 'share_scope') updatePrayerApproval(true); });
      dialog.querySelector('form').addEventListener('submit', save);
      doc.body.appendChild(dialog); updatePrayerApproval(); dialog.showModal();
    }
    function formValues(form) {
      var values = {};
      form.querySelectorAll('[name]').forEach(function (node) { values[node.name] = node.type === 'checkbox' ? node.checked : node.value.trim(); });
      return values;
    }
    function validate(view, values, existing) {
      var required = view === 'committees' ? ['committee_name', 'contact_name'] : view === 'prayers' ? ['display_name'] : ['title'];
      if (required.some(function (field) { return !values[field] || values[field].length > 160; })) return 'Complete the required names or title using no more than 160 characters.';
      if (views[view].statuses.indexOf(values.status) === -1) return 'Choose a valid status.';
      if (view === 'announcements' && (!values.body || values.body.length > 10000)) return 'Enter announcement text using no more than 10,000 characters.';
      if (view === 'prayers' && (!values.request_text || values.request_text.length > 10000)) return 'Enter the prayer request using no more than 10,000 characters.';
      var dates = view === 'announcements' ? ['starts_on', 'ends_on'] : view === 'committees' ? ['term_start', 'term_end'] : view === 'slides' ? ['service_date'] : [];
      if (dates.some(function (field) { return values[field] && !validDate(values[field]); })) return 'Choose valid dates.';
      if (dates.length === 2 && values[dates[0]] && values[dates[1]] && values[dates[1]] < values[dates[0]]) return 'The end date must be on or after the start date.';
      if (view === 'slides') {
        if (!validDate(values.service_date)) return 'Choose a service date.';
        if (values.deck_url && !deckLink(values.deck_url)) return 'Use a valid HTTPS deck link without a username, password, spaces, or backslashes.';
        if (values.document_id && !documents().some(function (item) { return item.id === values.document_id; }) && (!existing || existing.document_id !== values.document_id)) return 'Choose an available file from Documents.';
        if (values.status === 'ready' && !values.deck_url && !values.document_id) return 'Attach a file or add a deck link before marking slides ready.';
      }
      if (view === 'prayers') {
        if (['staff_only', 'prayer_team', 'church'].indexOf(values.share_scope) === -1) return 'Choose a valid sharing scope.';
        if (values.share_scope !== 'staff_only' && !values.sharing_approved) return 'Record approval before choosing a wider sharing scope.';
      }
      return '';
    }
    function payloadFor(view, values) {
      var fields = view === 'announcements' ? ['title', 'body', 'status', 'starts_on', 'ends_on'] : view === 'committees' ? ['committee_name', 'contact_name', 'role_label', 'email', 'phone', 'term_start', 'term_end', 'notes', 'status'] : view === 'slides' ? ['title', 'service_date', 'status', 'deck_url', 'document_id', 'notes'] : ['display_name', 'request_text', 'care_notes', 'status', 'share_scope', 'sharing_approved'];
      var payload = {};
      fields.forEach(function (field) { payload[field] = values[field] === '' ? null : values[field]; });
      if (view === 'slides' && payload.deck_url) payload.deck_url = deckLink(payload.deck_url);
      if (view === 'prayers' && payload.share_scope === 'staff_only') payload.sharing_approved = false;
      return payload;
    }
    async function save(event) {
      event.preventDefault();
      var form = event.target, epoch = dialogEpoch, version = formVersion, view = dialogView, existing = dialogRecord;
      if (!dialog || saving || !current(epoch) || !views[view]) return;
      if (!ready[view]) { form.querySelector('.office-content-error').textContent = 'Refresh these records before saving.'; return; }
      if (form.reportValidity && !form.reportValidity()) return;
      var values = formValues(form), problem = validate(view, values, existing);
      if (problem) { form.querySelector('.office-content-error').textContent = problem; return; }
      var payload = payloadFor(view, values), saved = false;
      saving = true; form.querySelector('[type="submit"]').disabled = true; form.querySelector('.office-content-error').textContent = '';
      try {
        if (!current(epoch) || version !== formVersion) return;
        var query = options.db.from(views[view].table);
        var result = existing ? await query.update(payload).eq('id', existing.id).select('id').single() : await query.insert(payload).select('id').single();
        if (!current(epoch) || version !== formVersion) return;
        if (result.error || !result.data || typeof result.data.id !== 'string' || !result.data.id || (existing && result.data.id !== existing.id)) throw new Error('save');
        saved = true; closeDialog(false); notice('Staff record saved.');
        await options.refresh();
      } catch (_) {
        if (current(epoch) && saved) notice('Saved, but records could not refresh. Please refresh the workspace.', true);
        else if (current(epoch) && version === formVersion && dialog) form.querySelector('.office-content-error').textContent = 'This record could not be saved. Your entries are still here; please try again.';
      } finally { if (current(epoch) && version === formVersion && dialog) { saving = false; form.querySelector('[type="submit"]').disabled = false; } }
    }
    function clear() {
      loadId++; closeDialog(false); mountedEpoch = null;
      Object.keys(views).forEach(function (view) { state[view] = []; filters[view] = { search: '', status: 'current' }; ready[view] = false; failed[view] = false; mounted[view] = false; if (roots[view]) roots[view].replaceChildren(); });
    }
    Object.keys(views).forEach(function (view) {
      var host = roots[view]; if (!host) return;
      host.addEventListener('input', function (event) { if (!allowed(context())) return; if (event.target.matches('[data-office-search]')) { filters[view].search = event.target.value; renderView(view); } });
      host.addEventListener('change', function (event) { if (!allowed(context())) return; if (event.target.matches('[data-office-status]')) { filters[view].status = event.target.value; renderView(view); } });
      host.addEventListener('click', function (event) {
        if (!allowed(context())) return;
        var target = event.target.closest('button'); if (!target || !host.contains(target)) return;
        if (target.hasAttribute('data-office-edit')) { var row = state[view].find(function (item) { return item.id === target.dataset.officeEdit; }); if (row) openEditor(view, row, target); }
        if (target.hasAttribute('data-office-upload') && options.uploadDocument) options.uploadDocument();
        var epoch = context().epoch;
        if (target.hasAttribute('data-office-document') && options.openDocument) Promise.resolve(options.openDocument(target.dataset.officeDocument)).catch(function () { if (current(epoch)) notice('The attached file could not be opened. Please try again.', true); });
        if (target.hasAttribute('data-office-refresh')) Promise.resolve(options.refresh()).catch(function () { if (current(epoch)) notice('These records could not load. Please try again.', true); });
      });
    });
    return { load: load, render: render, clear: clear, open: function (view) { openEditor(view, null, doc.activeElement); } };
  }
  root.CreekOfficeContent = { create: create };
}(typeof window !== 'undefined' ? window : globalThis));
