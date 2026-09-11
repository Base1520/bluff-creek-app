/* Shared message drafting and content review. No sending, recipient export or storage. */
(function (root) {
  'use strict';
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var CONFLICTS = ['WEEKLY_EMAIL_VERSION_CONFLICT', 'WEEKLY_EMAIL_REQUEST_CONFLICT', 'WEEKLY_EMAIL_SOURCE_CHANGED', 'WEEKLY_EMAIL_CONTENT_CHANGED'];
  function object(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function text(v, max) { return typeof v === 'string' && Array.from(v).length <= max; }
  function date(v) { return typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v) && v >= '2000-01-01' && v <= '2100-12-31' && Number.isFinite(Date.parse(v + 'T12:00:00Z')) && new Date(v + 'T12:00:00Z').toISOString().slice(0, 10) === v; }
  function monday(v) { return date(v) && new Date(v + 'T12:00:00Z').getUTCDay() === 1; }
  function instant(v) { return typeof v === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)); }
  function positive(v) { return Number.isSafeInteger(v) && v > 0; }
  function offset(v, days) { var d = new Date(v + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
  function thisMonday() {
    var p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    var get = function (type) { return p.find(function (x) { return x.type === type; }).value; };
    var today = get('year') + '-' + get('month') + '-' + get('day');
    return offset(today, -((new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7));
  }
  function source(v) {
    if (!object(v) || !UUID.test(v.id) || !positive(v.version) || !text(v.title, 160) || !v.title.trim() || !text(v.body, 10000) || (v.starts_on !== null && !date(v.starts_on)) || (v.ends_on !== null && !date(v.ends_on)) || (v.starts_on && v.ends_on && v.starts_on > v.ends_on)) return null;
    return { id: v.id, version: v.version, title: v.title, body: v.body, starts_on: v.starts_on, ends_on: v.ends_on };
  }
  function sources(values, max) {
    if (!Array.isArray(values) || values.length > max) return null;
    var result = values.map(source), ids = new Set();
    if (!result.every(function (v) { if (!v || ids.has(v.id)) return false; ids.add(v.id); return true; })) return null;
    return result;
  }
  function overlaps(v, week) { return (!v.starts_on || v.starts_on <= offset(week, 6)) && (!v.ends_on || v.ends_on >= week); }
  function workspace(v, week) {
    if (!object(v) || v.version !== 1 || v.week_start !== week || !monday(week) || !instant(v.generated_at) || !Array.isArray(v.drafts) || v.drafts.length > 20) return null;
    var ids = new Set(), drafts = [];
    if (!v.drafts.every(function (d) {
      if (!object(d) || !UUID.test(d.id) || ids.has(d.id) || !positive(d.version) || !text(d.subject, 160) || !d.subject.trim() || !['draft', 'reviewed'].includes(d.status) || !instant(d.updated_at)) return false;
      ids.add(d.id); drafts.push({ id: d.id, version: d.version, subject: d.subject, status: d.status, updated_at: d.updated_at }); return true;
    })) return null;
    var candidates = sources(v.announcements, 200), a = v.audience;
    if (!candidates || !candidates.every(function (s) { return overlaps(s, week); }) || !object(a) || !['total', 'requested', 'held', 'not_requested'].every(function (k) { return Number.isSafeInteger(a[k]) && a[k] >= 0; }) || a.total !== a.requested + a.held + a.not_requested) return null;
    return { week_start: week, generated_at: v.generated_at, drafts: drafts, announcements: candidates, audience: { total: a.total, requested: a.requested, held: a.held, not_requested: a.not_requested } };
  }
  function detail(v, id) {
    if (!object(v) || v.version !== 1 || !object(v.draft) || typeof v.sources_current !== 'boolean' || typeof v.review_current !== 'boolean' || v.sending_enabled !== false) return null;
    var d = v.draft, rows = sources(d.sources, 12);
    if (d.id !== id || !UUID.test(d.id) || !positive(d.version) || !monday(d.week_start) || !text(d.subject, 160) || !d.subject.trim() || !text(d.intro, 4000) || !text(d.closing, 2000) || !rows || rows.reduce(function (n, s) { return n + Array.from(s.title + s.body).length; }, 0) > 30000 || !['draft', 'reviewed'].includes(d.status) || !instant(d.updated_at) || (d.reviewed_at !== null && !instant(d.reviewed_at)) || !/^[a-f0-9]{64}$/.test(d.content_hash) || (v.review_current && (!v.sources_current || d.status !== 'reviewed' || !d.reviewed_at))) return null;
    return { draft: { id: d.id, version: d.version, week_start: d.week_start, subject: d.subject, intro: d.intro, closing: d.closing, sources: rows, status: d.status, reviewed_at: d.reviewed_at, updated_at: d.updated_at, content_hash: d.content_hash }, sources_current: v.sources_current, review_current: v.review_current, sending_enabled: false };
  }
  function create(options) {
    var host = options.root, doc = host.ownerDocument, owner = null, epoch = null, role = null;
    var serial = 0, workSerial = 0, readSerial = 0, mounted = false, paused = false, loading = false, opening = false;
    var week = thisMonday(), savedWorkspace = null, editor = null, message = '', unloadAttached = false;
    function context() { return options.getContext() || {}; }
    function identity(c) { return !!c.userId && ['admin', 'editor'].includes(c.role) && options.isCurrent(c.epoch); }
    function same() { var c = context(); return identity(c) && c.userId === owner && c.epoch === epoch && c.role === role; }
    function ready() { var c = context(); return same() && c.canEdit === true && c.workspaceReady === true && !paused; }
    function eligible(e) { var c = context(); return identity(c) && c.epoch === e && c.canEdit === true && c.workspaceReady === true; }
    function current(token, target) { return token === serial && ready() && (!target || target === editor); }
    function dirty() { return !!editor && signature(editor.values) !== editor.base; }
    function protectedDraft() { return !!editor && (dirty() || editor.writing || editor.attempt || editor.conflict); }
    function signature(v) { return JSON.stringify({ subject: v.subject, intro: v.intro, closing: v.closing, refs: v.refs.map(function (r) { return { id: r.id, version: r.version }; }) }); }
    function unload(e) { if (!same()) { clear(); return; } if (protectedDraft()) { e.preventDefault(); e.returnValue = true; } }
    function warn() { var needed = same() && protectedDraft(); if (needed && !unloadAttached) root.addEventListener('beforeunload', unload); if (!needed && unloadAttached) root.removeEventListener('beforeunload', unload); unloadAttached = needed; }
    function clear() {
      serial++; workSerial++; readSerial++; owner = null; epoch = null; role = null; editor = null; savedWorkspace = null; loading = false; opening = false; paused = false; mounted = false; message = ''; week = thisMonday(); host.replaceChildren(); warn();
    }
    function bind(c) { owner = c.userId; epoch = c.epoch; role = c.role; }
    function pause() {
      if (!same()) { clear(); return; }
      if (!paused) { serial++; workSerial++; readSerial++; }
      paused = true; loading = false; opening = false; savedWorkspace = null; mounted = false;
      if (editor) { editor.checking = false; editor.writing = false; editor.detailFresh = false; if (editor.attempt) editor.attempt.uncertain = true; }
      host.replaceChildren(); warn();
    }
    function escape(v) { var node = doc.createElement('span'); node.textContent = String(v == null ? '' : v); return node.innerHTML.replace(/"/g, '&quot;'); }
    function labelDay(v) { return new Date(v + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }); }
    function labelTime(v) { return new Date(v).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' Central'; }
    function setMessage(value) { message = value; var node = host.querySelector('[data-weekly-status]'); if (node) node.textContent = message; }
    function mutationLocked() { return !ready() || loading || opening || !editor || editor.writing || editor.checking || !!editor.attempt; }
    function immutableAttempt() { return !!editor && (editor.writing || editor.checking || !!editor.attempt); }
    function maySwitch() {
      if (!ready() || loading || opening || immutableAttempt()) return false;
      var token = serial, target = editor;
      if (protectedDraft() && !root.confirm('Discard your unsaved weekly email changes?')) return false;
      if (!same()) { clear(); return false; }
      if (!ready()) { pause(); return false; }
      return token === serial && target === editor && !loading && !opening && !immutableAttempt();
    }
    function makeEditor(id) { var values = { subject: '', intro: '', closing: '', refs: [] }; return { id: id, version: 0, week: week, values: values, base: signature(values), selected: [], saved: null, detailFresh: false, writing: false, checking: false, attempt: null, conflict: null, acknowledged: false }; }
    function acceptDetail(target, value, replace) {
      target.saved = value;
      target.detailFresh = true;
      if (replace) {
        var d = value.draft;
        target.version = d.version; target.week = d.week_start;
        target.values = { subject: d.subject, intro: d.intro, closing: d.closing, refs: d.sources.map(function (s) { return { id: s.id, version: s.version }; }) };
        target.selected = d.sources.map(function (s) { return Object.assign({}, s); }); target.base = signature(target.values); target.conflict = null; target.acknowledged = false;
      }
    }
    function compose(container, values, rows, prefix) {
      container.replaceChildren();
      var kicker = doc.createElement('p'); kicker.className = 'weekly-preview-kicker'; kicker.textContent = prefix; container.appendChild(kicker);
      var h = doc.createElement('h3'); h.textContent = values.subject || 'Your weekly message'; container.appendChild(h);
      function paragraph(value) { if (!value) return; var p = doc.createElement('p'); p.className = 'weekly-plain-text'; p.textContent = value; container.appendChild(p); }
      paragraph(values.intro);
      rows.forEach(function (s) { var section = doc.createElement('section'), title = doc.createElement('h4'), body = doc.createElement('p'); title.textContent = s.title; body.className = 'weekly-plain-text'; body.textContent = s.body; section.append(title, body); container.appendChild(section); });
      paragraph(values.closing);
    }
    function preview() {
      if (!mounted || !editor) return;
      var draft = host.querySelector('[data-weekly-composition]'), saved = host.querySelector('[data-weekly-saved-preview]'), target = editor;
      compose(draft, target.values, target.selected, dirty() ? 'Working copy · unsaved changes' : target.version ? 'Working copy' : 'Working copy · not saved');
      saved.replaceChildren();
      if (target.saved) { var d = target.saved.draft; compose(saved, d, d.sources, (target.detailFresh ? 'Saved in Office' : 'Last confirmed saved snapshot') + ' · version ' + d.version); }
      else saved.textContent = target.version ? 'Check saved draft to load its current snapshot.' : 'Save to Office to create a shared message snapshot.';
      var state = host.querySelector('[data-weekly-review-state]');
      state.textContent = !target.saved ? 'No saved content review.' : !target.detailFresh ? 'Saved snapshot needs a fresh check before content review.' : target.saved.review_current ? 'Saved content reviewed · ' + labelTime(target.saved.draft.reviewed_at) : target.saved.draft.status === 'reviewed' ? 'Review needs attention — a selected announcement changed.' : hasReviewContent(target) ? 'Content has not been reviewed.' : 'Add opening or closing words, or select an announcement, before content review.';
      var freshness = host.querySelector('[data-weekly-source-state]');
      freshness.textContent = !target.saved ? '' : !target.detailFresh ? 'Current source status has not been confirmed.' : target.saved.sources_current ? 'Saved announcement sources were current when checked.' : 'A saved source changed or is no longer ready for this week. Refresh choices, select the current text, and save again.';
      var pending = host.querySelector('[data-weekly-uncertainty]');
      pending.hidden = !target.attempt;
      if (target.attempt) pending.textContent = target.attempt.unresolved ? 'An earlier connection is still unresolved. Check saved draft shows the current record separately. Retry same request keeps the exact request and safely asks for its receipt; it does not create a new draft.' : 'This request still needs a receipt. Check saved draft shows the current record separately. Retry same request safely asks for its original result.';
    }
    function controls() {
      if (!mounted) { warn(); return; }
      var lock = mutationLocked(), target = editor;
      host.querySelector('[data-weekly-refresh]').disabled = loading || opening || !!(target && (target.writing || target.checking));
      host.querySelector('[data-weekly-new]').disabled = loading || opening || immutableAttempt() || !savedWorkspace;
      host.querySelector('[data-weekly-week]').disabled = loading || opening || immutableAttempt();
      host.querySelectorAll('[data-weekly-open]').forEach(function (b) { b.disabled = loading || opening || immutableAttempt(); });
      if (target) {
        host.querySelectorAll('[data-weekly-field], [data-weekly-source], [data-weekly-use-source]').forEach(function (n) { n.disabled = lock; });
        host.querySelector('[data-weekly-save]').disabled = lock || !savedWorkspace || !!target.conflict;
        host.querySelector('[data-weekly-check]').disabled = !ready() || loading || opening || target.writing || target.checking || (!target.version && !target.attempt);
        host.querySelector('[data-weekly-retry]').disabled = !ready() || loading || opening || target.writing || target.checking || !target.attempt;
        host.querySelector('[data-weekly-retry]').hidden = !target.attempt;
        host.querySelector('[data-weekly-reload]').hidden = !target.saved || !target.conflict;
        host.querySelector('[data-weekly-reload]').disabled = lock || !target.detailFresh;
        var canReview = role === 'admin' && !lock && !dirty() && !target.conflict && target.saved && target.detailFresh && hasReviewContent(target) && target.saved.sources_current && target.saved.draft.version === target.version && target.saved.draft.status === 'draft';
        var acknowledge = host.querySelector('[data-weekly-ack]'); acknowledge.disabled = !canReview; acknowledge.checked = target.acknowledged;
        host.querySelector('[data-weekly-review]').disabled = !canReview || !target.acknowledged;
      }
      warn();
    }
    function render() {
      var c = context();
      if (!identity(c) || owner && !same()) { clear(); return; }
      if (!owner) bind(c);
      if (c.canEdit !== true || c.workspaceReady !== true || paused) { pause(); return; }
      host.innerHTML = '<header class="weekly-hero"><p class="eyebrow">One shared message</p><h2>Bring this week together.</h2><p>Draft the church email, choose this week’s announcements, and review the words together.</p></header><div class="weekly-toolbar"><label>Week beginning Monday<input type="date" data-weekly-week></label><button type="button" class="quiet" data-weekly-refresh>Refresh current choices</button><button type="button" data-weekly-new>New draft</button></div><p class="weekly-status" role="status" data-weekly-status></p><section class="weekly-audience" aria-label="Current communication choices" data-weekly-audience></section><div class="weekly-drafts" data-weekly-drafts></div><div data-weekly-builder></div><section class="weekly-boundary"><strong>Draft and review here. Sending comes later.</strong><p>Content review covers wording and dates only. Unsubscribe links, suppression and delivery handling, and a final audience check are still required before sending. No email is sent from this page.</p></section>';
      mounted = true; host.querySelector('[data-weekly-week]').value = week; setMessage(message);
      host.querySelector('[data-weekly-week]').onchange = function (e) { changeWeek(e.target.value); };
      host.querySelector('[data-weekly-refresh]').onclick = function () { load(context().epoch); };
      host.querySelector('[data-weekly-new]').onclick = newDraft;
      var audience = host.querySelector('[data-weekly-audience]'), list = host.querySelector('[data-weekly-drafts]');
      if (savedWorkspace) {
        [['Requested weekly updates', savedWorkspace.audience.requested], ['Held for review', savedWorkspace.audience.held], ['No current request', savedWorkspace.audience.not_requested]].forEach(function (pair) { var card = doc.createElement('div'); card.innerHTML = '<strong>' + pair[1] + '</strong><span>' + pair[0] + '</span>'; audience.appendChild(card); });
        var note = doc.createElement('p'); note.className = 'weekly-audience-note'; note.textContent = savedWorkspace.audience.total + ' registrations checked ' + labelTime(savedWorkspace.generated_at) + '. Held and no-choice accounts are excluded from requested counts; no addresses are shown.'; audience.appendChild(note);
        if (!savedWorkspace.drafts.length) list.textContent = 'No saved messages for ' + labelDay(week) + '–' + labelDay(offset(week, 6)) + '.';
        savedWorkspace.drafts.forEach(function (d) { var button = doc.createElement('button'); button.type = 'button'; button.className = 'weekly-draft-button'; button.dataset.weeklyOpen = d.id; button.innerHTML = '<span>' + escape(d.subject) + '</span><small>Version ' + d.version + ' · ' + (d.status === 'reviewed' ? 'Review recorded — open to check freshness' : 'Draft') + '</small>'; button.onclick = function () { openDraft(d.id); }; list.appendChild(button); });
      } else { audience.innerHTML = '<p>Current audience counts are unavailable.</p>'; list.textContent = loading ? 'Loading saved messages and ready announcements…' : 'Refresh to check saved messages and current announcement choices.'; }
      if (editor) build();
      controls();
    }
    function build() {
      var target = editor, area = host.querySelector('[data-weekly-builder]');
      area.innerHTML = '<div class="weekly-studio"><section class="panel weekly-editor"><p class="eyebrow">Week of ' + escape(labelDay(target.week)) + '</p><h3>' + (target.version ? 'Edit the shared draft' : 'Start with a welcome') + '</h3><label>Subject<input data-weekly-field="subject" maxlength="160" autocomplete="off"></label><label>Opening message<textarea data-weekly-field="intro" maxlength="4000" rows="5" placeholder="A short welcome and what matters this week…"></textarea></label><div class="weekly-sources"><h4>Ready announcements</h4><p>Choose up to 12. Their saved text is captured when you save; selecting one does not publish it.</p><div data-weekly-choices></div></div><label>Closing message<textarea data-weekly-field="closing" maxlength="2000" rows="4" placeholder="A closing thought or next step…"></textarea></label><div class="weekly-editor-actions"><button type="button" data-weekly-save>Save to Office</button><button type="button" class="quiet" data-weekly-check>Check saved draft</button><button type="button" data-weekly-retry hidden>Retry same request</button><button type="button" class="quiet" data-weekly-reload hidden>Load current saved draft</button></div><p class="weekly-warning" data-weekly-uncertainty hidden></p><div class="weekly-review"><h4>Content review</h4><p data-weekly-review-state></p><p data-weekly-source-state></p>' + (role === 'admin' ? '<label class="weekly-check"><input type="checkbox" data-weekly-ack><span>I reviewed the saved wording and dates for this week.</span></label><button type="button" data-weekly-review>Mark content reviewed</button>' : '<p>An Office admin can mark the saved content reviewed.</p><input type="checkbox" data-weekly-ack hidden><button type="button" data-weekly-review hidden></button>') + '</div></section><div class="weekly-preview-column"><div class="weekly-preview" data-weekly-composition></div><details class="weekly-saved" open><summary>Current saved snapshot</summary><div class="weekly-preview" data-weekly-saved-preview></div></details></div></div>';
      area.querySelectorAll('[data-weekly-field]').forEach(function (input) { var name = input.dataset.weeklyField; input.value = target.values[name]; input.oninput = function () { if (editor !== target || mutationLocked()) return; target.values[name] = input.value; target.acknowledged = false; preview(); controls(); }; });
      var choices = area.querySelector('[data-weekly-choices]'), candidates = savedWorkspace ? savedWorkspace.announcements : [];
      var rows = candidates.slice(); target.selected.forEach(function (s) { if (!rows.some(function (r) { return r.id === s.id; })) rows.push(s); });
      if (!rows.length) choices.textContent = savedWorkspace ? 'No ready announcements overlap this week. You can still write a message without announcements.' : 'Announcement choices are unavailable until refresh succeeds.';
      rows.forEach(function (s) {
        var currentSource = candidates.find(function (r) { return r.id === s.id; }), ref = target.values.refs.find(function (r) { return r.id === s.id; });
        var stale = ref && (!currentSource || ref.version !== currentSource.version), row = doc.createElement('article'); row.className = 'weekly-source' + (stale ? ' weekly-source-stale' : '');
        row.innerHTML = '<label class="weekly-check"><input type="checkbox" data-weekly-source="' + s.id + '"><span><strong>' + escape(s.title) + '</strong><small>' + (!s.starts_on && !s.ends_on ? 'Dates not set — confirm this belongs in the week' : escape((s.starts_on ? labelDay(s.starts_on) : 'No start date') + ' · ' + (s.ends_on ? labelDay(s.ends_on) : 'No end date'))) + '</small></span></label><p class="weekly-plain-text">' + escape(s.body) + '</p>';
        var checkbox = row.querySelector('input'); checkbox.checked = !!ref; checkbox.onchange = function () { choose(s.id, checkbox.checked); };
        if (stale) { var note = doc.createElement('p'); note.className = 'weekly-warning'; note.textContent = currentSource ? 'This announcement changed after selection. Review the current text above.' : 'This selection is no longer in the current ready choices.'; row.appendChild(note); if (currentSource) { var use = doc.createElement('button'); use.type = 'button'; use.className = 'quiet'; use.dataset.weeklyUseSource = s.id; use.textContent = 'Use current announcement text'; use.onclick = function () { choose(s.id, true); }; row.appendChild(use); } }
        choices.appendChild(row);
      });
      area.querySelector('[data-weekly-save]').onclick = function () { save(); };
      area.querySelector('[data-weekly-check]').onclick = function () { checkSaved(); };
      area.querySelector('[data-weekly-retry]').onclick = function () { writeAttempt(target); };
      area.querySelector('[data-weekly-reload]').onclick = function () { if (!target.saved || !target.detailFresh || !maySwitch() || editor !== target) return; acceptDetail(target, target.saved, true); setMessage('Loaded the current saved version.'); if (week !== target.week) { week = target.week; savedWorkspace = null; load(epoch); } else render(); };
      area.querySelector('[data-weekly-ack]').onchange = function (e) { if (mutationLocked()) return; target.acknowledged = e.target.checked; controls(); };
      area.querySelector('[data-weekly-review]').onclick = review;
      preview();
    }
    function choose(id, selected) {
      if (mutationLocked()) return;
      var s = savedWorkspace && savedWorkspace.announcements.find(function (r) { return r.id === id; });
      if (selected && !s) { setMessage('That announcement is unavailable. Refresh current choices.'); render(); return; }
      if (selected && !editor.values.refs.some(function (r) { return r.id === id; }) && editor.values.refs.length >= 12) { setMessage('Choose no more than 12 announcements for one message.'); render(); return; }
      editor.values.refs = editor.values.refs.filter(function (r) { return r.id !== id; }); editor.selected = editor.selected.filter(function (r) { return r.id !== id; });
      if (selected) { editor.values.refs.push({ id: s.id, version: s.version }); editor.selected.push(Object.assign({}, s)); }
      if (editor.conflict === 'source') editor.conflict = null;
      editor.acknowledged = false; render();
    }
    function newDraft() { if (!savedWorkspace || !maySwitch()) return; editor = makeEditor(root.crypto.randomUUID()); setMessage('New working copy. Save it to share with the Office.'); render(); }
    function changeWeek(value) {
      if (!monday(value)) { setMessage('Choose a Monday between 2000 and 2100.'); render(); return; }
      if (value === week || !maySwitch()) { render(); return; }
      week = value; editor = null; savedWorkspace = null; load(context().epoch);
    }
    function deadline(promise) {
      var timer;
      return Promise.race([promise, new Promise(function (_, reject) { timer = root.setTimeout(function () { reject({ code: 'CLIENT_TIMEOUT' }); }, 12000); })]).finally(function () { root.clearTimeout(timer); });
    }
    async function rpc(name, body) { var result = await deadline(Promise.resolve().then(function () { return options.db.rpc(name, body); })); if (!result || result.error) throw result && result.error || { code: 'UNAVAILABLE' }; return result.data; }
    function readError(error) { return error && error.code === 'PGRST202' ? 'Weekly email drafting is not enabled on this service yet.' : error && error.code === '54000' ? 'The complete workspace exceeds its current limit. No partial list is shown.' : 'The current saved workspace could not be confirmed. Refresh to try again.'; }
    async function load(e) {
      var c = context();
      if (!identity(c) || c.epoch !== e || owner && !same()) { clear(); if (!identity(c) || c.epoch !== e) return false; }
      if (!owner) bind(c);
      if (!eligible(e)) { pause(); return false; }
      if (editor && (editor.writing || editor.checking)) return false;
      paused = false; var token = serial, request = ++workSerial, requestedWeek = week; loading = true; savedWorkspace = null; if (editor) { editor.detailFresh = false; editor.acknowledged = false; } setMessage('Refreshing this week’s saved messages, announcements and communication choices…'); render();
      try {
        var data = await rpc('get_weekly_email_workspace', { p_week_start: requestedWeek });
        if (!current(token) || request !== workSerial || week !== requestedWeek) return false;
        var value = workspace(data, requestedWeek); if (!value) throw { code: 'INCOMPLETE' };
        savedWorkspace = value; setMessage('Current choices checked ' + labelTime(value.generated_at) + '.');
        var target = editor;
        if (target && target.version && !target.attempt) {
          try {
            var detailData = await rpc('get_weekly_email_draft', { p_id: target.id });
            if (!current(token, target) || request !== workSerial || week !== requestedWeek) return false;
            var latest = detail(detailData, target.id); if (!latest) throw { code: 'INCOMPLETE' };
            acceptDetail(target, latest, !dirty() && !target.conflict && latest.draft.week_start === week);
            if (latest.draft.week_start !== week) target.conflict = 'version';
          } catch (error) {
            if (!current(token, target) || request !== workSerial) return false;
            target.detailFresh = false; setMessage('Current choices refreshed. The saved message could not be checked; its earlier snapshot and your working changes are retained.');
          }
        }
        return true;
      } catch (error) { if (current(token) && request === workSerial) { savedWorkspace = null; setMessage(readError(error)); } return false; }
      finally { if (token === serial && request === workSerial) { if (ready()) { loading = false; render(); } else if (same()) pause(); else clear(); } }
    }
    async function openDraft(id) {
      if (!savedWorkspace || !savedWorkspace.drafts.some(function (d) { return d.id === id; }) || !maySwitch()) return false;
      var token = serial, request = ++readSerial; opening = true; controls();
      try {
        var data = await rpc('get_weekly_email_draft', { p_id: id }); if (!current(token) || request !== readSerial) return false;
        var value = detail(data, id); if (!value || value.draft.week_start !== week) throw { code: 'INCOMPLETE' };
        editor = makeEditor(id); acceptDetail(editor, value, true); setMessage('Opened the current saved snapshot.'); return true;
      } catch (error) { if (current(token) && request === readSerial) setMessage(readError(error)); return false; }
      finally { if (token === serial && request === readSerial) { if (ready()) { opening = false; render(); } else if (same()) pause(); else clear(); } }
    }
    async function checkSaved() {
      var target = editor;
      if (!target || !ready() || loading || opening || target.writing || target.checking || (!target.version && !target.attempt)) return false;
      var token = serial, request = ++readSerial; target.checking = true; target.detailFresh = false; target.acknowledged = false; preview(); controls();
      try {
        var data = await rpc('get_weekly_email_draft', { p_id: target.id }); if (!current(token, target) || request !== readSerial) return false;
        var value = detail(data, target.id); if (!value) throw { code: 'INCOMPLETE' };
        acceptDetail(target, value, false);
        if (!target.attempt && !dirty() && !target.conflict && value.draft.week_start === week) acceptDetail(target, value, true);
        if (value.draft.week_start !== week) target.conflict = 'version';
        setMessage(target.attempt ? 'Current saved version ' + value.draft.version + ' is shown separately. It does not settle the earlier request; keep its exact retry.' : target.conflict || dirty() ? 'Current saved snapshot refreshed. Your working changes are still here.' : 'Current saved snapshot and content review refreshed.'); return true;
      } catch (error) {
        if (current(token, target) && request === readSerial) setMessage(error && error.code === 'P0002' ? 'No saved draft was found by this check. An uncertain request may still finish; its exact retry is retained.' : 'Could not check the saved snapshot. Your working copy and any uncertain request are retained.'); return false;
      } finally { if (token === serial && request === readSerial) { if (ready() && target === editor) { target.checking = false; render(); } else if (same()) pause(); else clear(); } }
    }
    function validWorking(target) {
      if (!savedWorkspace || target.week !== week || !target.values.subject.trim() || !text(target.values.subject.trim(), 160) || /[\x00-\x1f\x7f]/.test(target.values.subject) || !text(target.values.intro, 4000) || !text(target.values.closing, 2000) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(target.values.intro + target.values.closing)) return 'Add a subject of up to 160 characters and keep the opening and closing within their limits.';
      if (!target.values.refs.every(function (r) { return savedWorkspace.announcements.some(function (s) { return s.id === r.id && s.version === r.version; }); })) return 'One selected announcement changed. Refresh choices and explicitly use the current announcement text before saving.';
      if (target.selected.reduce(function (n, s) { return n + Array.from(s.title + s.body).length; }, 0) > 30000) return 'The selected announcements are too long for one message. Remove an announcement and save again.';
      return null;
    }
    function save() {
      if (mutationLocked() || editor.conflict) return;
      var error = validWorking(editor); if (error) { setMessage(error); return; }
      editor.values.subject = editor.values.subject.trim();
      editor.attempt = { kind: 'save', request: root.crypto.randomUUID(), expected: editor.version, unresolved: false, uncertain: false, params: { p_id: editor.id, p_expected_version: editor.version, p_draft: { week_start: editor.week, subject: editor.values.subject, intro: editor.values.intro, closing: editor.values.closing, announcement_refs: editor.values.refs.map(function (r) { return { id: r.id, version: r.version }; }) } } };
      editor.attempt.params.p_request_id = editor.attempt.request; writeAttempt(editor);
    }
    function review() {
      var target = editor;
      if (role !== 'admin' || mutationLocked() || dirty() || target.conflict || !target.acknowledged || !target.saved || !target.detailFresh || !hasReviewContent(target) || !target.saved.sources_current || target.saved.draft.version !== target.version || target.saved.draft.status !== 'draft') return;
      target.attempt = { kind: 'review', request: root.crypto.randomUUID(), expected: target.version, unresolved: false, uncertain: false, params: { p_id: target.id, p_expected_version: target.version, p_content_hash: target.saved.draft.content_hash } };
      target.attempt.params.p_request_id = target.attempt.request; writeAttempt(target);
    }
    function hasReviewContent(target) { return !!target.saved && !!(target.saved.draft.intro.trim() || target.saved.draft.closing.trim() || target.saved.draft.sources.length); }
    async function writeAttempt(target) {
      if (target !== editor || !ready() || loading || opening || target.writing || target.checking || !target.attempt) return;
      var token = serial, attempt = target.attempt; target.writing = true; target.acknowledged = false; setMessage(attempt.kind === 'save' ? 'Saving the shared message…' : 'Recording the content review…'); render();
      var started = false;
      try {
        if (options.ensureReady && !await deadline(Promise.resolve().then(function () { return options.ensureReady(epoch); }))) throw { code: 'BEFORE_WRITE' };
        if (!current(token, target) || target.attempt !== attempt) return;
        started = true; attempt.inflight = (attempt.inflight || 0) + 1; attempt.unresolved = true;
        var pending = Promise.resolve().then(function () { if (!current(token, target) || target.attempt !== attempt) throw { code: 'BEFORE_WRITE' }; return options.db.rpc(attempt.kind === 'save' ? 'save_weekly_email_draft' : 'review_weekly_email_draft', attempt.params); });
        pending.then(settled, settled);
        function settled() { if (same() && target === editor && target.attempt === attempt) { attempt.inflight--; attempt.unresolved = attempt.inflight > 0; if (attempt.uncertain && ready() && !target.writing && !target.checking) { setMessage('A connection settled. The exact request is retained until its receipt is confirmed.'); render(); } else warn(); } }
        var result = await deadline(pending);
        if (!current(token, target) || target.attempt !== attempt) return;
        if (!result || result.error) throw result && result.error || { code: 'UNAVAILABLE' };
        var receipt = result.data;
        if (!object(receipt) || receipt.id !== target.id || receipt.version !== attempt.expected + 1 || receipt.status !== (attempt.kind === 'save' ? 'draft' : 'reviewed')) throw { code: 'UNCONFIRMED_RECEIPT' };
        target.attempt = null; target.version = receipt.version; target.base = signature(target.values); target.conflict = null; target.saved = null; target.writing = false;
        setMessage('The ' + (attempt.kind === 'save' ? 'save' : 'content review') + ' receipt is confirmed at version ' + receipt.version + '. Checking the current saved snapshot…'); render();
        await checkSaved(); if (current(token, target) && !target.attempt) await load(epoch);
      } catch (error) {
        if (!current(token, target) || target.attempt !== attempt) return;
        var code = error && error.code, conflict = code === '40001' && CONFLICTS.includes(error.message);
        if (!started || code === 'BEFORE_WRITE') { if (!attempt.uncertain) target.attempt = null; setMessage('Readiness could not be confirmed before saving. Your working copy is retained.'); }
        else if (conflict || ['22023', '42501', 'P0002', '54000', 'PGRST202'].includes(code)) {
          if (attempt.uncertain || attempt.unresolved) {
            // A refusal proves only this call failed. An earlier request may
            // still commit, even when its transport already rejected locally.
            attempt.uncertain = true;
            setMessage('The latest retry was refused, but it does not settle the earlier save or review. Its exact request remains protected. Check the saved draft or retry that same request when access is available.');
          } else {
            target.attempt = null;
            if (conflict) { target.conflict = error.message === 'WEEKLY_EMAIL_SOURCE_CHANGED' ? 'source' : 'version'; target.detailFresh = false; }
            setMessage(conflict ? 'This attempt did not change the saved message. A saved version or announcement changed; an earlier request may already have succeeded. Your working copy is retained. Check the current saved draft and refresh choices before continuing.' : code === 'PGRST202' ? 'Weekly email drafting is not enabled on this service yet. Your working copy is retained.' : code === '54000' ? 'The shared workspace limit was reached. Your working copy is retained; no partial message was saved by this attempt.' : 'The service refused this attempt. Your working copy is retained. Refresh the saved workspace before continuing.');
          }
        } else { attempt.uncertain = true; setMessage('The result could not be confirmed. Keep this request: check the saved draft or explicitly retry the same request for its receipt.'); }
      } finally {
        if (target === editor && token === serial) { if (ready()) { target.writing = false; render(); } else if (same()) pause(); else clear(); }
      }
    }
    return { load: load, render: render, clear: clear, pause: pause };
  }
  root.CreekWeeklyEmail = { create: create };
}(typeof window !== 'undefined' ? window : globalThis));
