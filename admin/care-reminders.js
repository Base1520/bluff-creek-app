/* Administrator care setup and delivery review. No browser dispatch or persistent private storage. */
(function (root) {
  'use strict';
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function uuid(v) { return typeof v === 'string' && UUID.test(v); }
  var STATUSES = ['queued', 'sending', 'accepted', 'failed', 'uncertain', 'cancelled'];
  var ERRORS = ['provider_configuration', 'provider_rejected', 'provider_rate_limited', 'provider_unavailable', 'provider_timeout', 'provider_invalid_response', 'idempotency_conflict', 'delivery_uncertain', 'retry_window_expired', 'invalid_job', 'source_changed', 'operator_cancelled', 'attempt_limit'];
  var ROLE_LABELS = { deacon: 'Deacon care', sunday_school: 'Sunday school', welcome: 'Guest welcome', pastoral: 'Pastoral care', custom: 'Other care' };
  function object(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function string(v, n) { return typeof v === 'string' && Array.from(v).length <= n; }
  function count(v) { return Number.isSafeInteger(v) && v >= 0; }
  function positive(v) { return count(v) && v > 0; }
  function instant(v) { return typeof v === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)); }
  function day(v) { return typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v) && Number.isFinite(Date.parse(v + 'T12:00:00Z')) && new Date(v + 'T12:00:00Z').toISOString().slice(0, 10) === v; }
  function nullable(v, check) { return v === null || check(v); }
  function ids(v, max) { return Array.isArray(v) && v.length <= max && v.every(function (x) { return uuid(x); }) && new Set(v).size === v.length; }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function key(v) { return v.source_type + ':' + v.source_id; }
  function binding(v) {
    return object(v) && ['guest_task', 'care_plan'].includes(v.source_type) && uuid(v.source_id) && nullable(v.owner_user_id, function (x) { return uuid(x); }) && typeof v.enabled === 'boolean' && uuid(v.cycle_id) && positive(v.version) && positive(v.approved_source_version) && nullable(v.lifecycle_version, positive) && nullable(v.linked_guest_task_id, function (x) { return uuid(x); });
  }
  function workspace(v) {
    if (!object(v) || v.version !== 1 || !instant(v.generated_at) || !day(v.today) || !object(v.settings) || !object(v.readiness) || !Array.isArray(v.eligible_staff) || v.eligible_staff.length > 500 || !Array.isArray(v.sources) || v.sources.length > 5000) return null;
    var s = v.settings, r = v.readiness, staff = new Set(), sources = new Set(), bindings = new Set();
    if (s.version !== 1 || !positive(s.settings_version) || typeof s.enabled !== 'boolean' || !ids(s.pastor_user_ids, 20) || !ids(s.eligible_staff_user_ids, 500) || !Array.isArray(s.bindings) || s.bindings.length > 5000 || !s.bindings.every(function (b) { if (!binding(b) || bindings.has(key(b))) return false; bindings.add(key(b)); return true; })) return null;
    if (!v.eligible_staff.every(function (u) { if (!object(u) || !uuid(u.id) || !string(u.label, 320) || !u.label.trim() || staff.has(u.id)) return false; staff.add(u.id); return true; }) || staff.size !== s.eligible_staff_user_ids.length || !s.eligible_staff_user_ids.every(function (id) { return staff.has(id); })) return null;
    if (!v.sources.every(function (x) {
      if (!object(x) || !['guest_task', 'care_plan'].includes(x.source_type) || !uuid(x.source_id) || sources.has(key(x)) || !nullable(x.source_version, positive) || !nullable(x.lifecycle_version, positive) || !nullable(x.contact_id, function (id) { return uuid(id); }) || !string(x.label, 512) || !x.label.trim() || !nullable(x.care_role, function (role) { return string(role, 80); }) || !nullable(x.owner_label, function (label) { return string(label, 320); }) || !nullable(x.assigned_staff_user_id, function (id) { return uuid(id); }) || !nullable(x.one_time, function (v) { return typeof v === 'boolean'; }) || typeof x.active !== 'boolean' || (x.active && (!x.source_version || (x.source_type === 'guest_task' && !x.lifecycle_version)))) return false;
      sources.add(key(x)); return true;
    }) || !s.bindings.every(function (b) { return sources.has(key(b)); })) return null;
    var required = ['bindings', 'enabled_bindings', 'disabled_bindings', 'missing_sources', 'owner_changed', 'lifecycle_changed', 'recipient_unavailable', 'unassigned', 'linked_welcome_suppressed', 'linked_source_changed', 'inactive_sources', 'open_sources', 'unbound_care', 'unbound_guests'];
    if (r.available !== true || r.version !== 1 || r.settings_version !== s.settings_version || r.enabled !== s.enabled || r.today !== v.today || typeof r.pastor_setup_required !== 'boolean' || !object(r.counts) || !required.every(function (k) { return count(r.counts[k]); }) || r.counts.bindings !== s.bindings.length || r.counts.enabled_bindings + r.counts.disabled_bindings !== r.counts.bindings) return null;
    return clone(v);
  }
  function job(v) {
    return object(v) && uuid(v.id) && positive(v.version) && STATUSES.includes(v.status) && instant(v.created_at) && day(v.planned_on) && instant(v.next_attempt_at) && count(v.attempts) && v.attempts <= 8 && nullable(v.error_code, function (e) { return ERRORS.includes(e); }) && ids(v.recipient_user_ids, 500) && v.recipient_user_ids.length > 0 && positive(v.source_count) && typeof v.hold_active === 'boolean' && v.can_resolve === ['queued', 'failed', 'uncertain'].includes(v.status);
  }
  function jobs(v, filter) {
    if (!object(v) || v.version !== 1 || !instant(v.generated_at) || !count(v.total) || !object(v.countsByStatus) || !STATUSES.every(function (s) { return count(v.countsByStatus[s]); }) || !Array.isArray(v.items) || v.items.length > 50 || typeof v.has_more !== 'boolean') return null;
    var seen = new Set(), total = STATUSES.filter(function (s) { return filter === 'all' || ['queued', 'sending', 'failed', 'uncertain'].includes(s); }).reduce(function (n, s) { return n + v.countsByStatus[s]; }, 0);
    if (total !== v.total || v.items.length > total || !v.items.every(function (r) { if (!job(r) || seen.has(r.id) || (filter === 'attention' && !['queued', 'sending', 'failed', 'uncertain'].includes(r.status))) return false; seen.add(r.id); return true; })) return null;
    if (v.has_more) { var last = v.items[v.items.length - 1]; if (!last || !object(v.next_cursor) || v.next_cursor.id !== last.id || v.next_cursor.created_at !== last.created_at) return null; }
    else if (v.next_cursor !== null) return null;
    return clone(v);
  }
  function create(options) {
    var host = options.root, doc = host.ownerDocument, owner = null, epoch = null, generation = 0, readSerial = 0, jobSerial = 0;
    var saved = null, queue = null, queueRows = [], settingsDraft = null, sourceDraft = null, attempt = null;
    var writeEpoch = 0;
    var paused = false, busy = false, jobsBusy = false, message = '', readError = '', jobError = '', sourceSearch = '', sourceFilter = 'all', jobFilter = 'attention', sourceLimit = 30;
    var warned = false;
    function context() { return options.getContext() || {}; }
    function identity(c) { return !!c.userId && c.role === 'admin' && options.isCurrent(c.epoch); }
    function same() { var c = context(); return identity(c) && c.userId === owner && c.epoch === epoch; }
    function ready() { var c = context(); return same() && c.canEdit === true && c.workspaceReady === true && !paused; }
    function eligible(e) { var c = context(); return identity(c) && c.epoch === e && c.canEdit === true && c.workspaceReady === true; }
    function active(g) { return g === generation && same(); }
    function settingsValues(s) { return { enabled: s.enabled, pastor_user_ids: s.pastor_user_ids.slice().sort() }; }
    function signature(v) { return JSON.stringify(v); }
    function dirty(d) { return !!d && signature(d.values) !== d.base; }
    function protectedWork() { return dirty(settingsDraft) || dirty(sourceDraft) || !!attempt; }
    function unload(e) { if (!same()) { clear(); return; } if (protectedWork()) { e.preventDefault(); e.returnValue = true; } }
    function warn() { var needed = same() && protectedWork(); if (needed && !warned) root.addEventListener('beforeunload', unload); if (!needed && warned) root.removeEventListener('beforeunload', unload); warned = needed; }
    function summary() { if (options.onSummary) options.onSummary(ready() && saved && queue && !readError && !jobError ? { enabled: saved.settings.enabled, unbound: saved.readiness.counts.unbound_care + saved.readiness.counts.unbound_guests, held: queue.countsByStatus.failed + queue.countsByStatus.uncertain, queued: queue.countsByStatus.queued, checked_at: saved.generated_at } : null); }
    function clear() {
      generation++; writeEpoch++; readSerial++; jobSerial++; preparing = false; owner = null; epoch = null; saved = null; queue = null; queueRows = []; settingsDraft = null; sourceDraft = null; attempt = null; paused = false; busy = false; jobsBusy = false; message = ''; readError = ''; jobError = ''; sourceSearch = ''; sourceFilter = 'all'; jobFilter = 'attention'; sourceLimit = 30; host.replaceChildren(); warn(); summary();
    }
    function pause() { if (!same()) { clear(); return; } if (!paused) writeEpoch++; paused = true; readSerial++; jobSerial++; saved = null; queue = null; queueRows = []; busy = false; jobsBusy = false; if (attempt) { attempt.uncertain = true; attempt.waiting = false; } host.replaceChildren(); warn(); summary(); }
    function escape(v) { var node = doc.createElement('span'); node.textContent = String(v == null ? '' : v); return node.innerHTML.replace(/"/g, '&quot;'); }
    function userLabel(id) { var u = saved && saved.eligible_staff.find(function (s) { return s.id === id; }); return u ? u.label : id ? 'Staff account unavailable — review access' : 'No recipient selected'; }
    function time(v) { return new Date(v).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' Central'; }
    function bound(s) { return saved && saved.settings.bindings.find(function (b) { return key(b) === key(s); }); }
    function sourceNow(k) { return saved && saved.sources.find(function (s) { return key(s) === k; }); }
    function setupValues(s, b) { return { owner_user_id: s.source_type === 'guest_task' ? s.assigned_staff_user_id : b ? b.owner_user_id : null, enabled: b ? b.enabled : false, restart_cycle: false, linked_guest_task_id: b ? b.linked_guest_task_id : null }; }
    function sourceSignature(s, b) { return signature({ source: s, binding: b || null }); }
    function acceptWorkspace(v) {
      saved = v;
      if (!settingsDraft || (!dirty(settingsDraft) && !(attempt && attempt.kind === 'settings'))) { var values = settingsValues(v.settings); settingsDraft = { version: v.settings.settings_version, values: values, base: signature(values), conflict: false }; }
      else if (settingsDraft.version !== v.settings.settings_version) settingsDraft.conflict = true;
      if (sourceDraft) {
        var s = sourceNow(sourceDraft.key), b = s && bound(s);
        if (!s || sourceDraft.sourceState !== sourceSignature(s, b)) sourceDraft.conflict = true;
      }
    }
    function timeout(p) { var timer; return Promise.race([p, new Promise(function (_resolve, reject) { timer = root.setTimeout(function () { reject({ timeout: true }); }, 12000); })]).finally(function () { root.clearTimeout(timer); }); }
    async function readWorkspace(e) {
      var g = generation, token = ++readSerial; busy = true; saved = null; readError = ''; render();
      try {
        var response = await timeout(Promise.resolve().then(function () { return options.db.rpc('get_care_reminder_workspace', {}); }));
        if (!active(g) || !eligible(e) || token !== readSerial) return false;
        var value = response && !response.error && workspace(response.data);
        if (!value) { readError = response && response.error && response.error.code === 'PGRST202' ? 'not_enabled' : 'unavailable'; return false; }
        acceptWorkspace(value); return true;
      } catch (_) { if (active(g) && token === readSerial) readError = 'unavailable'; return false; }
      finally { if (active(g) && token === readSerial) { busy = false; if (eligible(e)) render(); else pause(); } }
    }
    async function readJobs(e, more) {
      var g = generation, token = ++jobSerial, filter = jobFilter, cursor = more && queue && queue.next_cursor, old = queueRows.slice();
      if (more && (!queue || !queue.has_more || !cursor)) return false;
      jobsBusy = true; jobError = ''; if (!more) { queue = null; queueRows = []; } render();
      try {
        var response = await timeout(Promise.resolve().then(function () { return options.db.rpc('get_care_reminder_jobs', { p_filter: filter, p_before_created_at: cursor ? cursor.created_at : null, p_before_id: cursor ? cursor.id : null, p_limit: 50 }); }));
        if (!active(g) || !eligible(e) || token !== jobSerial || filter !== jobFilter) return false;
        var value = response && !response.error && jobs(response.data, filter);
        if (!value) { jobError = 'unavailable'; queue = null; queueRows = []; return false; }
        if ((!value.has_more && (more ? old.length : 0) + value.items.length !== value.total) || (value.has_more && (more ? old.length : 0) + value.items.length >= value.total)) { jobError = 'unavailable'; queue = null; queueRows = []; return false; }
        if (more && (value.total !== queue.total || signature(value.countsByStatus) !== signature(queue.countsByStatus) || value.items.some(function (j) { return old.some(function (p) { return p.id === j.id; }); }))) { jobError = 'changed'; queue = null; queueRows = []; return false; }
        queue = value; queueRows = more ? old.concat(value.items) : value.items.slice(); return true;
      } catch (_) { if (active(g) && token === jobSerial) { jobError = 'unavailable'; queue = null; queueRows = []; } return false; }
      finally { if (active(g) && token === jobSerial) { jobsBusy = false; if (eligible(e)) render(); else pause(); } }
    }
    async function load(e) {
      if (!eligible(e)) { if (same()) pause(); else clear(); return false; }
      var c = context(); if (owner && !same()) clear(); if (!owner) { owner = c.userId; epoch = c.epoch; }
      paused = false;
      var results = await Promise.all([readWorkspace(e), readJobs(e, false)]); return results.every(Boolean);
    }
    function locked() { return !ready() || !saved || !queue || busy || jobsBusy || !!attempt; }
    function touch() { warn(); controls(); }
    var preparing = false;
    function validReceipt(a, v) {
      if (!object(v) || v.version !== a.args.p_version + 1) return false;
      if (a.kind === 'settings') return v.enabled === a.args.p_enabled && ids(v.pastor_user_ids, 20) && signature(v.pastor_user_ids.slice().sort()) === signature(a.args.p_pastor_user_ids.slice().sort());
      if (a.kind === 'binding') return v.source_type === a.args.p_source_type && v.source_id === a.args.p_source_id && uuid(v.cycle_id) && v.enabled === a.args.p_enabled && v.lifecycle_version === a.args.p_lifecycle_version;
      return v.id === a.args.p_id && v.status === 'cancelled' && v.resolution === 'cancel_no_resend';
    }
    function definitive(error) { return error && ['22023', '40001', '42501', 'P0002', '55P03', '54000', '55000'].includes(error.code); }
    function issue(a) {
      if (!ready() || attempt !== a || a.waiting) return;
      a.waiting = true; a.unresolved++; a.requestSerial = (a.requestSerial || 0) + 1; var requestSerial = a.requestSerial, g = generation, issuedEpoch = writeEpoch, timedOut = false;
      message = 'Saving this exact request…'; render();
      var tracked = Promise.resolve().then(function () {
        if (!active(g) || !ready() || attempt !== a || issuedEpoch !== writeEpoch) {
          if (!same()) clear();
          throw new Error('Save session changed before dispatch');
        }
        return options.db.rpc(a.method, clone(a.args));
      }).then(function (response) {
        if (!active(g) || attempt !== a) return;
        a.unresolved--;
        if (issuedEpoch !== writeEpoch || !ready()) { a.uncertain = true; return; }
        if (response && !response.error && validReceipt(a, response.data)) {
          attempt = null;
          if (a.kind === 'settings') settingsDraft = null;
          if (a.kind === 'binding') sourceDraft = null;
          message = a.kind === 'cancel' ? 'Cancelled without resending. The contact record is unchanged; future reminder cycles follow their saved settings.' : a.kind === 'settings' && !a.args.p_enabled ? 'Reminder service paused. Messages already in flight or accepted cannot be withdrawn.' : 'Saved. Refreshing the current reminder setup…';
          warn(); if (ready()) load(epoch); else if (same()) pause(); return;
        }
        if (response && definitive(response.error) && !a.uncertain && a.unresolved === 0) {
          attempt = null;
          if (a.kind === 'settings' && settingsDraft) settingsDraft.conflict = true;
          if (a.kind === 'binding' && sourceDraft) sourceDraft.conflict = true;
          message = 'The current record or access changed. Your edits are retained. Refresh, review the current saved setup, then choose Use current saved setup before making another change.';
          if (ready()) load(epoch); else if (same()) pause();
        } else {
          a.uncertain = true;
          message = 'The save result is uncertain. Check the saved setup or retry this same request. Do not start another save.';
        }
      }, function () {
        if (active(g) && attempt === a) { a.unresolved--; a.uncertain = true; message = 'The save result is uncertain. Check the saved setup or retry this same request.'; }
      });
      timeout(tracked).catch(function () {
        timedOut = true;
        if (active(g) && attempt === a) { a.uncertain = true; message = 'The request timed out; it may still finish. Your exact request is kept for checking or retry.'; }
      }).finally(function () {
        if (active(g) && attempt === a && a.requestSerial === requestSerial) { a.waiting = false; if (timedOut) a.uncertain = true; if (ready()) render(); else pause(); }
      });
    }
    async function begin(kind, method, args, confirmation) {
      if (locked() || preparing) return;
      var g = generation, e = epoch, snapshot = saved, sDraft = settingsDraft, bDraft = sourceDraft;
      var sSignature = settingsDraft && signature(settingsDraft.values), bSignature = sourceDraft && signature(sourceDraft.values);
      preparing = true; controls();
      try {
        if (options.ensureReady && !await options.ensureReady(e)) return;
        if (!active(g) || !ready() || attempt || saved !== snapshot || settingsDraft !== sDraft || sourceDraft !== bDraft || (sDraft && signature(sDraft.values) !== sSignature) || (bDraft && signature(bDraft.values) !== bSignature)) return;
        if (confirmation && !root.confirm(confirmation)) return;
        if (!active(g) || !ready() || attempt || saved !== snapshot || settingsDraft !== sDraft || sourceDraft !== bDraft || (sDraft && signature(sDraft.values) !== sSignature) || (bDraft && signature(bDraft.values) !== bSignature)) return;
        if (!root.crypto || !root.crypto.randomUUID) { message = 'This browser cannot safely identify a save. Use a current browser over HTTPS.'; return; }
        args.p_request_id = root.crypto.randomUUID();
        attempt = { kind: kind, method: method, args: clone(args), waiting: false, unresolved: 0, uncertain: false };
        issue(attempt);
      } catch (_) { if (active(g)) message = 'Access could not be confirmed. Refresh the Office before saving.'; }
      finally { if (active(g)) { preparing = false; if (ready()) render(); else pause(); } else if (!same()) clear(); }
    }
    function saveSettings() {
      if (locked() || preparing || !settingsDraft || !dirty(settingsDraft) || settingsDraft.conflict) return;
      var values = settingsDraft.values, idsNow = saved.eligible_staff.map(function (s) { return s.id; });
      if ((values.enabled && !values.pastor_user_ids.length) || values.pastor_user_ids.some(function (id) { return !idsNow.includes(id); })) { message = 'Select an available pastor recipient before enabling reminders. Remove any unavailable selection.'; render(); return; }
      begin('settings', 'set_care_reminder_settings', { p_version: settingsDraft.version, p_enabled: values.enabled, p_pastor_user_ids: values.pastor_user_ids.slice().sort() }, values.enabled ? 'Enable the reminder service with these pastor recipients? A configured server schedule can send daily and overdue care emails. This does not change the original welcome emails.' : 'Pause new care reminders? Messages already in flight or accepted cannot be withdrawn.');
    }
    function openBinding(k) {
      if (locked() || preparing) return;
      var g = generation, previous = sourceDraft, snapshot = saved;
      var accepted = !dirty(previous) || root.confirm('Discard unsaved changes for this reminder setup?');
      if (!same()) { clear(); return; }
      if (!accepted) return;
      if (!active(g) || !ready() || locked() || sourceDraft !== previous || saved !== snapshot) return;
      var s = sourceNow(k); if (!s) return; var b = bound(s), values = setupValues(s, b);
      sourceDraft = { key: k, source: clone(s), binding: b ? clone(b) : null, sourceState: sourceSignature(s, b), values: values, base: signature(values), conflict: false };
      render(); var editor = host.querySelector('[data-reminder-source-editor]'); if (editor) editor.focus();
    }
    function saveBinding() {
      if (locked() || preparing || !sourceDraft || sourceDraft.conflict) return;
      var d = sourceDraft, s = sourceNow(d.key), b = s && bound(s), v = d.values;
      if (!s || !s.source_version || sourceSignature(s, b) !== d.sourceState || !s.active) { d.conflict = true; message = 'This care source needs a current review. Open the original record or refresh before saving.'; render(); return; }
      if (v.owner_user_id && !saved.eligible_staff.some(function (u) { return u.id === v.owner_user_id; })) { message = 'Choose an available staff recipient.'; render(); return; }
      if (s.source_type === 'guest_task' && v.owner_user_id !== s.assigned_staff_user_id) { message = 'Change the guest owner in Intake actions first, then refresh this setup.'; render(); return; }
      if (b && s.source_type === 'guest_task' && b.lifecycle_version !== s.lifecycle_version && !v.restart_cycle) { message = 'This guest was restored or its lifecycle changed. Explicitly allow a new reminder cycle after reviewing the original record.'; render(); return; }
      begin('binding', 'set_care_reminder_binding', { p_source_type: s.source_type, p_source_id: s.source_id, p_version: b ? b.version : 0, p_source_version: s.source_version, p_owner_user_id: v.owner_user_id, p_enabled: v.enabled, p_restart_cycle: v.restart_cycle, p_lifecycle_version: s.source_type === 'guest_task' ? s.lifecycle_version : null, p_linked_guest_task_id: v.linked_guest_task_id }, v.restart_cycle ? 'Start a new reminder cycle for this source? Previously consumed reminder occurrences may become eligible in the new cycle. Review the source and recipient first.' : null);
    }
    function cancelJob(id) {
      if (locked() || preparing) return; var j = queueRows.find(function (j) { return j.id === id; }); if (!j || !j.can_resolve) return;
      begin('cancel', 'resolve_care_reminder_job', { p_id: j.id, p_version: j.version, p_resolution: 'cancel_no_resend' }, 'Cancel this reminder without resending it? This clears its delivery hold but does not record a visit or complete the follow-up. Future reminder cycles may still run.');
    }
    function useCurrent() {
      if (locked() || preparing || !saved) return;
      var g = generation, snapshot = saved;
      var accepted = root.confirm('Replace your unsaved reminder edits with the current saved setup?');
      if (!same()) { clear(); return; }
      if (!accepted) return;
      if (!active(g) || !ready() || locked() || saved !== snapshot) return;
      var values = settingsValues(saved.settings); settingsDraft = { version: saved.settings.settings_version, values: values, base: signature(values), conflict: false };
      if (sourceDraft) { var s = sourceNow(sourceDraft.key), b = s && bound(s); if (s) { var v = setupValues(s, b); sourceDraft = { key: key(s), source: clone(s), binding: b ? clone(b) : null, sourceState: sourceSignature(s, b), values: v, base: signature(v), conflict: false }; } else sourceDraft = null; }
      message = 'Current saved setup loaded. Review it before making a new change.'; render();
    }
    function reviewReason(s) {
      var b = bound(s);
      if (!s.active) return 'Inactive or missing source';
      if (!b) return 'Reminder setup needed';
      if (s.source_type === 'guest_task' && b.lifecycle_version !== s.lifecycle_version) return 'Restored guest — review cycle';
      if (s.source_type === 'guest_task' && b.owner_user_id !== s.assigned_staff_user_id) return 'Guest owner changed';
      if (b.owner_user_id && !saved.eligible_staff.some(function (u) { return u.id === b.owner_user_id; })) return 'Recipient unavailable';
      if (!b.enabled) return 'Reminders paused for this source';
      if (!b.owner_user_id) return 'No individual recipient';
      return 'Reminder setup saved';
    }
    function renderSources() {
      var list = host.querySelector('[data-reminder-sources]'); if (!list || !saved) return;
      var search = sourceSearch.trim().toLowerCase(), rows = saved.sources.filter(function (s) {
        var b = bound(s), reason = reviewReason(s);
        return (!search || (s.label + ' ' + (s.owner_label || '') + ' ' + (s.care_role || '')).toLowerCase().includes(search)) && (sourceFilter === 'all' || sourceFilter === 'unbound' && !b || sourceFilter === 'review' && !['Reminder setup saved', 'Reminders paused for this source'].includes(reason));
      });
      list.innerHTML = rows.slice(0, sourceLimit).map(function (s) { return '<article class="reminder-source"><div><p class="eyebrow">' + escape(s.source_type === 'guest_task' ? 'Guest follow-up' : ROLE_LABELS[s.care_role] || s.care_role || 'Care plan') + '</p><h4>' + escape(s.label) + '</h4><p>' + escape(reviewReason(s)) + '</p></div><button type="button" class="quiet" data-reminder-source-open value="' + key(s) + '">Review setup</button></article>'; }).join('') || '<p class="reminder-muted">No sources match this view.</p>';
      host.querySelector('[data-reminder-source-count]').textContent = rows.length + ' matching care sources · ' + Math.min(rows.length, sourceLimit) + ' shown. A person may have more than one care plan.';
      var more = host.querySelector('[data-reminder-sources-more]'); more.hidden = rows.length <= sourceLimit;
      list.querySelectorAll('[data-reminder-source-open]').forEach(function (button) { button.onclick = function () { openBinding(button.value); }; }); controls();
    }
    function renderEditor() {
      var area = host.querySelector('[data-reminder-editor-area]'); if (!area) return;
      if (!sourceDraft || !saved) { area.innerHTML = '<p class="reminder-muted">Choose a care source to review its recipient and reminder setup.</p>'; return; }
      var d = sourceDraft, s = sourceNow(d.key) || d.source, v = d.values, b = bound(s), g = generation;
      var people = saved.eligible_staff.map(function (u) { return '<option value="' + u.id + '">' + escape(u.label) + '</option>'; }).join('');
      if (v.owner_user_id && !saved.eligible_staff.some(function (u) { return u.id === v.owner_user_id; })) people += '<option value="' + v.owner_user_id + '">Staff account unavailable — choose a current recipient</option>';
      area.innerHTML = '<section class="reminder-editor" data-reminder-source-editor tabindex="-1"><p class="eyebrow">Reminder setup</p><h3>' + escape(s.label) + '</h3><p>' + escape(reviewReason(s)) + '</p><p class="reminder-muted">Recorded care owner: ' + escape(s.owner_label || 'Not recorded') + '. The reminder recipient is an actual eligible staff account.</p><label>Reminder recipient<select data-reminder-owner><option value="">No individual recipient</option>' + people + '</select></label><p class="reminder-muted">' + (s.source_type === 'guest_task' ? 'Guest reminders follow the owner saved in Intake actions. Change that assignment in the original record, then refresh here.' : 'This selects email routing. It does not rename the care owner or change the monthly or quarterly contact schedule.') + '</p><label class="reminder-check"><input type="checkbox" data-reminder-source-enabled>Include this source in care reminders</label><label class="reminder-check"><input type="checkbox" data-reminder-restart>Allow a new reminder cycle after reviewing this source</label><p class="reminder-muted">A new cycle can make previously consumed reminders eligible again. Leave this unchecked for ordinary edits.</p><div data-reminder-link-area></div><div class="reminder-actions"><button type="button" data-reminder-binding-save>Save reminder setup</button><button type="button" class="quiet" data-reminder-open-source>Open original ' + (s.source_type === 'guest_task' ? 'intake action' : "person’s care plans") + '</button></div><p class="reminder-editor-state">' + (d.conflict ? 'The saved source changed. Refresh and use the current saved setup before saving.' : !s.active ? 'This source is inactive or missing. It will not generate reminders. Review the original record.' : 'The reminder service must also be enabled for eligible work to send.') + '</p></section>';
      var select = area.querySelector('[data-reminder-owner]'); select.value = v.owner_user_id || '';
      select.onchange = function () { if (!active(g) || locked() || preparing || sourceDraft !== d || s.source_type === 'guest_task') return; d.values.owner_user_id = select.value || null; touch(); };
      var enabled = area.querySelector('[data-reminder-source-enabled]'); enabled.checked = v.enabled; enabled.onchange = function () { if (!active(g) || locked() || preparing || sourceDraft !== d) return; d.values.enabled = enabled.checked; touch(); };
      var restart = area.querySelector('[data-reminder-restart]'); restart.checked = v.restart_cycle; restart.onchange = function () { if (!active(g) || locked() || preparing || sourceDraft !== d) return; d.values.restart_cycle = restart.checked; touch(); };
      if (s.source_type === 'care_plan' && s.one_time && s.care_role === 'welcome') {
        var candidates = saved.sources.filter(function (x) { return x.source_type === 'guest_task' && x.contact_id && x.contact_id === s.contact_id; });
        var linkArea = area.querySelector('[data-reminder-link-area]');
        linkArea.innerHTML = '<label>Same welcome as a guest intake task?<select data-reminder-linked-guest><option value="">Separate care plan</option>' + candidates.map(function (x) { return '<option value="' + x.source_id + '">' + escape(x.label) + '</option>'; }).join('') + (v.linked_guest_task_id && !candidates.some(function (x) { return x.source_id === v.linked_guest_task_id; }) ? '<option value="' + v.linked_guest_task_id + '">Previous linked task — review required</option>' : '') + '</select></label><p class="reminder-muted">Link the same welcome so its care-plan reminder is suppressed in favor of the guest task. Separate visits should stay separate.</p>';
        var link = linkArea.querySelector('select'); link.value = v.linked_guest_task_id || ''; link.onchange = function () { if (!active(g) || locked() || preparing || sourceDraft !== d) return; d.values.linked_guest_task_id = link.value || null; touch(); };
      }
      area.querySelector('[data-reminder-binding-save]').onclick = saveBinding;
      area.querySelector('[data-reminder-open-source]').onclick = function () {
        if (!active(g) || !ready() || !saved || sourceDraft !== d || attempt || preparing) return;
        var current = sourceNow(d.key); if (current && current.source_version && options.openSource) options.openSource(clone(current));
      };
    }
    function renderJobs() {
      var area = host.querySelector('[data-reminder-jobs]'), status = host.querySelector('[data-reminder-job-status]'); if (!area) return;
      if (!queue || jobError) { area.replaceChildren(); status.textContent = jobsBusy ? 'Checking delivery records…' : jobError === 'changed' ? 'The queue changed while loading another page. Refresh to review the current deliveries.' : 'Delivery records and counts are unavailable. Refresh before making changes.'; return; }
      status.textContent = queueRows.length + ' of ' + queue.total + ' matching deliveries shown · checked ' + time(queue.generated_at) + '. Accepted means the provider accepted the email; it does not prove inbox delivery.';
      var labels = { queued: 'Waiting to send', sending: 'Send in progress', accepted: 'Provider accepted', failed: 'Delivery failed — review', uncertain: 'Delivery uncertain — review', cancelled: 'Cancelled without resend' };
      var causes = { provider_configuration: 'Sender configuration needs attention.', provider_rejected: 'The provider rejected this request.', provider_rate_limited: 'The provider asked the service to wait.', provider_unavailable: 'The provider was unavailable.', provider_timeout: 'The provider response timed out.', provider_invalid_response: 'The provider result could not be verified.', idempotency_conflict: 'The provider request identity needs review.', delivery_uncertain: 'The delivery result is unknown; review before any new action.', retry_window_expired: 'The retry window has ended.', invalid_job: 'The saved request needs review.', source_changed: 'The source or recipient changed.', operator_cancelled: 'An administrator cancelled this occurrence.', attempt_limit: 'The retry limit was reached.' };
      area.innerHTML = queueRows.map(function (j) { return '<article class="reminder-delivery reminder-delivery-' + j.status + '"><div><p class="eyebrow">' + escape(labels[j.status]) + '</p><h4>' + escape(j.recipient_user_ids.map(userLabel).join(' · ')) + '</h4><p>' + j.source_count + ' care source' + (j.source_count === 1 ? '' : 's') + ' · planned ' + escape(j.planned_on) + ' · ' + j.attempts + ' attempt' + (j.attempts === 1 ? '' : 's') + '</p><p>' + escape(causes[j.error_code] || (j.status === 'queued' ? 'The server schedule and service settings control delivery.' : '')) + '</p>' + (j.hold_active ? '<p class="reminder-hold">New daily reminders to this destination are held until the delivery issue is reviewed.</p>' : '') + '</div>' + (j.can_resolve ? '<button type="button" class="quiet" data-reminder-job-cancel value="' + j.id + '">Cancel without resend</button>' : '') + '</article>'; }).join('') || '<p class="reminder-muted">No deliveries match this filter. Care sources and missing setup are shown separately above.</p>';
      area.querySelectorAll('[data-reminder-job-cancel]').forEach(function (button) { button.onclick = function () { cancelJob(button.value); }; });
      var more = host.querySelector('[data-reminder-jobs-more]'); more.hidden = !queue.has_more;
    }
    function controls() {
      if (!ready()) { if (owner) pause(); return; }
      var lock = locked() || preparing;
      host.querySelectorAll('[data-reminder-enabled], [data-reminder-pastor], [data-reminder-source-open], [data-reminder-source-enabled], [data-reminder-restart], [data-reminder-linked-guest], [data-reminder-job-cancel]').forEach(function (n) { n.disabled = lock; });
      var ownerSelect = host.querySelector('[data-reminder-owner]'); if (ownerSelect) ownerSelect.disabled = lock || !sourceDraft || sourceDraft.source.source_type === 'guest_task';
      var save = host.querySelector('[data-reminder-settings-save]'); if (save) save.disabled = lock || !settingsDraft || !dirty(settingsDraft) || settingsDraft.conflict;
      var bindingSave = host.querySelector('[data-reminder-binding-save]'); if (bindingSave) bindingSave.disabled = lock || !sourceDraft || sourceDraft.conflict || !sourceDraft.source.active || !sourceDraft.source.source_version;
      var original = host.querySelector('[data-reminder-open-source]'); if (original) original.disabled = lock || !sourceDraft || !sourceDraft.source.source_version;
      host.querySelectorAll('[data-reminder-refresh], [data-reminder-settings-check]').forEach(function (n) { n.disabled = busy || jobsBusy || preparing || !!(attempt && attempt.waiting); });
      var retry = host.querySelector('[data-reminder-retry]'); if (retry) { retry.hidden = !attempt; retry.disabled = !attempt || attempt.waiting || busy || jobsBusy || preparing; }
      var use = host.querySelector('[data-reminder-use-current]'); if (use) { use.hidden = !(settingsDraft && settingsDraft.conflict || sourceDraft && sourceDraft.conflict); use.disabled = lock; }
      var more = host.querySelector('[data-reminder-jobs-more]'); if (more) more.disabled = lock || !queue || !queue.has_more;
      var filter = host.querySelector('[data-reminder-job-filter]'); if (filter) filter.disabled = busy || jobsBusy || preparing || !!attempt;
      var status = host.querySelector('[data-reminder-status]'); if (status) status.textContent = message || (busy || jobsBusy ? 'Checking current reminder setup…' : !saved || !queue ? 'Reminder setup or delivery counts are unavailable.' : protectedWork() ? 'You have unsaved reminder changes.' : 'Review a care source or delivery below.');
      warn(); summary();
    }
    function render() {
      if (!same()) { clear(); return; } if (!ready()) { pause(); return; }
      var g = generation;
      host.innerHTML = '<header class="reminder-hero"><div><p class="eyebrow">Care that follows through</p><h2>Keep the next conversation in sight.</h2><p>Choose who receives care reminders, check missing setup, and resolve delivery problems.</p></div><button type="button" class="quiet" data-reminder-refresh>Refresh current setup</button></header><p role="status" class="reminder-status" data-reminder-status></p><div class="reminder-recovery"><p data-reminder-pending' + (attempt ? '' : ' hidden') + '>A save still needs its receipt. Checking saved records does not discard the original request or prove it failed. Retry same save uses the exact request; it does not send a reminder email.</p><button type="button" class="quiet" data-reminder-settings-check>Check saved setup</button><button type="button" class="quiet" data-reminder-retry>Retry same save</button><button type="button" class="quiet" data-reminder-use-current>Use current saved setup</button></div><div data-reminder-content></div>';
      host.querySelector('[data-reminder-refresh]').onclick = function () { if (ready() && !busy && !jobsBusy && !preparing && !(attempt && attempt.waiting)) load(epoch); };
      host.querySelector('[data-reminder-settings-check]').onclick = host.querySelector('[data-reminder-refresh]').onclick;
      host.querySelector('[data-reminder-retry]').onclick = async function () {
        if (!ready() || !attempt || attempt.waiting || busy || jobsBusy || preparing) return; var a = attempt, currentGeneration = generation;
        if (options.ensureReady && !await options.ensureReady(epoch)) return;
        if (active(currentGeneration) && ready() && attempt === a && !a.waiting && !busy && !jobsBusy) issue(a);
      };
      host.querySelector('[data-reminder-use-current]').onclick = useCurrent;
      var content = host.querySelector('[data-reminder-content]');
      if (!saved) {
        content.innerHTML = '<section class="panel reminder-empty"><h3>' + (busy ? 'Checking the current setup' : readError === 'not_enabled' ? 'Care reminders are not connected yet' : 'Reminder setup is unavailable') + '</h3><p>' + (busy ? 'Private source and delivery records are being checked.' : readError === 'not_enabled' ? 'The reviewed care-reminder service must be connected before settings can be edited. The rest of the Office remains available.' : 'Refresh the Office connection before changing recipients. Unavailable counts do not mean there is no work due.') + '</p></section>';
        controls(); return;
      }
      var counts = saved.readiness.counts, s = settingsDraft, recipients = saved.eligible_staff.slice();
      s.values.pastor_user_ids.filter(function (id) { return !recipients.some(function (u) { return u.id === id; }); }).forEach(function (id) { recipients.push({ id: id, label: 'Unavailable staff selection — remove or restore access' }); });
      content.innerHTML = '<section class="reminder-metrics" data-reminder-counts aria-label="Reminder health"><article><span>Reminder service</span><strong>' + (saved.settings.enabled ? 'Enabled' : 'Paused') + '</strong><small>' + (saved.settings.enabled ? 'Subject to the server schedule and current eligibility' : 'New care reminders are paused') + '</small></article><article><span>Sources without setup</span><strong>' + (counts.unbound_care + counts.unbound_guests) + '</strong><small>Care plans and guest tasks, not unique people</small></article><article><span>Failed or uncertain deliveries</span><strong>' + (queue ? queue.countsByStatus.failed + queue.countsByStatus.uncertain : '—') + '</strong><small>' + (queue ? 'Review the delivery queue below' : 'Delivery counts unavailable') + '</small></article></section><details class="panel reminder-settings" open><summary><strong>Service settings &amp; pastor recipients</strong><span>Saved version ' + saved.settings.settings_version + '</span></summary><p>Daily reminders run during the configured 9 a.m.–5 p.m. Central window. Overdue care can notify the pastor; a separate three-day overdue occurrence is combined with that day’s digest.</p><label class="reminder-check"><input type="checkbox" data-reminder-enabled>Enable the care reminder service</label><fieldset><legend>Pastor recipients for overdue and missing-owner care</legend>' + recipients.map(function (u) { return '<label class="reminder-check"><input type="checkbox" data-reminder-pastor value="' + u.id + '">' + escape(u.label) + '</label>'; }).join('') + (!recipients.length ? '<p>No eligible staff accounts are available. Finish staff access setup first.</p>' : '') + '</fieldset><p class="reminder-muted">These settings cover care reminders. Original signup welcome emails and intake notices are separate. Pausing cannot withdraw messages already in flight or accepted.</p><button type="button" data-reminder-settings-save>Save service settings</button>' + (s.conflict ? '<p class="reminder-hold">Settings changed since this draft was opened. Your edits are retained; review the current saved setup before continuing.</p>' : '') + '</details><section class="reminder-source-section"><div class="panel-head"><div><p class="eyebrow">Every source has a next step</p><h3>Recipients &amp; missing setup</h3></div></div><div class="reminder-toolbar"><label>Search care sources<input type="search" data-reminder-source-search placeholder="Person, care role, recorded owner"></label><label>Show<select data-reminder-source-filter><option value="all">All care sources</option><option value="unbound">Setup needed</option><option value="review">Needs review</option></select></label></div><p data-reminder-source-count class="reminder-muted"></p><div class="reminder-source-grid"><div><div data-reminder-sources></div><button type="button" class="quiet" data-reminder-sources-more>Show more care sources</button></div><div data-reminder-editor-area class="panel"></div></div></section><section class="panel reminder-queue"><div class="panel-head"><div><p class="eyebrow">Know what happened</p><h3>Delivery review</h3></div><label>Show deliveries<select data-reminder-job-filter><option value="attention">Waiting or needing attention</option><option value="all">All delivery statuses</option></select></label></div><p data-reminder-job-status class="reminder-muted"></p><div data-reminder-jobs></div><button type="button" class="quiet" data-reminder-jobs-more>Load more deliveries</button><p class="reminder-muted">Cancelling a reminder never records a contact or completes a follow-up. Record a real call or visit in the original care record.</p></section>';
      var enabled = host.querySelector('[data-reminder-enabled]'); enabled.checked = s.values.enabled;
      enabled.onchange = function () { if (!active(g) || locked() || preparing || settingsDraft !== s) return; s.values.enabled = enabled.checked; touch(); };
      host.querySelectorAll('[data-reminder-pastor]').forEach(function (box) { box.checked = s.values.pastor_user_ids.includes(box.value); box.onchange = function () { if (!active(g) || locked() || preparing || settingsDraft !== s) return; s.values.pastor_user_ids = Array.from(host.querySelectorAll('[data-reminder-pastor]:checked')).map(function (n) { return n.value; }).sort(); touch(); }; });
      host.querySelector('[data-reminder-settings-save]').onclick = saveSettings;
      var search = host.querySelector('[data-reminder-source-search]'); search.value = sourceSearch; search.oninput = function () { if (!active(g) || !ready()) return; sourceSearch = search.value; sourceLimit = 30; renderSources(); };
      var filter = host.querySelector('[data-reminder-source-filter]'); filter.value = sourceFilter; filter.onchange = function () { if (!active(g) || !ready()) return; sourceFilter = filter.value; sourceLimit = 30; renderSources(); };
      host.querySelector('[data-reminder-sources-more]').onclick = function () { if (!active(g) || !ready()) return; sourceLimit += 30; renderSources(); };
      var jobChoice = host.querySelector('[data-reminder-job-filter]'); jobChoice.value = jobFilter; jobChoice.onchange = function () { if (!active(g) || locked() || preparing) return; jobFilter = jobChoice.value; readJobs(epoch, false); };
      host.querySelector('[data-reminder-jobs-more]').onclick = function () { if (ready() && !locked() && !preparing) readJobs(epoch, true); };
      renderSources(); renderEditor(); renderJobs(); controls();
    }
    return { load: load, render: render, pause: pause, clear: clear };
  }
  root.CreekCareReminders = { create: create };
}(typeof window !== 'undefined' ? window : globalThis));
