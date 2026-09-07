/* Private staff care workspace. Data lives only in this instance and the staff database. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CreekCare = api;
}(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  var DAY = 86400000;
  function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !isNaN(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
  }
  function today(now) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now || new Date());
  }
  function addDays(value, days) {
    return validDate(value) ? new Date(Date.parse(value + 'T12:00:00Z') + days * DAY).toISOString().slice(0, 10) : null;
  }
  function latestFirst(a, b) {
    return String(b.contacted_on || '').localeCompare(String(a.contacted_on || '')) ||
      String(b.created_at || '').localeCompare(String(a.created_at || '')) || String(b.id || '').localeCompare(String(a.id || ''));
  }
  var ROLES = ['deacon', 'sunday_school', 'welcome', 'pastoral', 'custom'];
  var ROLE_LABELS = { deacon: 'Deacon', sunday_school: 'Sunday school', welcome: 'Welcome team', pastoral: 'Pastoral care', custom: 'Additional care' };
  function roleOf(record) { return record.care_role || 'deacon'; }
  function addMonths(value, months) {
    if (!validDate(value) || !Number.isInteger(months)) return null;
    var target = new Date(value + 'T12:00:00Z'), originalDay = target.getUTCDate();
    target.setUTCDate(1); target.setUTCMonth(target.getUTCMonth() + months);
    var end = new Date(target.getTime()); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
    target.setUTCDate(Math.min(originalDay, end.getUTCDate()));
    return target.toISOString().slice(0, 10);
  }
  function dueFor(assignment, visits, date) {
    date = validDate(date) ? date : today();
    var history = (visits || []).filter(function (visit) { return visit.contact_id === assignment.contact_id && roleOf(visit) === roleOf(assignment) && validDate(visit.contacted_on) && visit.contacted_on <= date; }).slice().sort(latestFirst);
    if (assignment.one_time && validDate(assignment.started_on)) history = history.filter(function (visit) { return visit.contacted_on >= assignment.started_on; });
    var latest = history[0], success = history.find(function (visit) { return visit.outcome === 'contacted'; });
    var cadence = Number(assignment.cadence_days), months = Number(assignment.cadence_months);
    if (!Number.isInteger(cadence) || cadence < 1 || cadence > 365) cadence = 28;
    if (!Number.isInteger(months) || months < 1 || months > 12) months = null;
    var explicit = latest && validDate(latest.next_contact_on) ? latest.next_contact_on : null;
    var base = success ? success.contacted_on : assignment.started_on;
    var completed = !!assignment.one_time && history.some(function (visit) { return visit.outcome === 'contacted' && (!validDate(assignment.started_on) || visit.contacted_on >= assignment.started_on); });
    var first = !success && validDate(assignment.first_due_on) ? assignment.first_due_on : null;
    var due = completed ? null : explicit || first || (months ? addMonths(base, months) : addDays(base, cadence));
    return { due: due, paused: !!assignment.paused, completed: completed, neverContacted: !success, lastContact: success ? success.contacted_on : null,
      explicit: !!explicit && !completed, cadence: cadence, months: months, state: assignment.paused ? 'paused' : completed ? 'completed' : !due ? 'unscheduled' : due < date ? 'overdue' : due === date ? 'due' : 'upcoming',
      daysOverdue: due && due < date ? Math.round((Date.parse(date + 'T12:00:00Z') - Date.parse(due + 'T12:00:00Z')) / DAY) : 0 };
  }
  function coverageFor(people, assignments) {
    var gaps = [];
    (people || []).filter(function (person) { return person.status === 'active'; }).forEach(function (person) {
      ['deacon', 'sunday_school'].forEach(function (role) {
        var plan = (assignments || []).find(function (item) { return item.contact_id === person.id && roleOf(item) === role; });
        var months = plan && Number(plan.cadence_months), days = plan && Number(plan.cadence_days);
        var intervalExceedsGoal = plan && (Number.isInteger(months) && months > 0 ? months > (role === 'deacon' ? 3 : 1) : Number.isInteger(days) && days > (role === 'deacon' ? 90 : 30));
        if (!plan || plan.paused || !plan.assigned_to || !String(plan.assigned_to).trim() || plan.one_time || intervalExceedsGoal) gaps.push({ contact_id: person.id, care_role: role, plan: plan || null, reason: !plan ? 'No plan yet' : plan.paused ? 'Plan paused' : plan.one_time ? 'Needs a recurring plan' : !plan.assigned_to || !String(plan.assigned_to).trim() ? 'Needs an assigned person' : 'Interval exceeds care goal' });
      });
    });
    return gaps;
  }
  function create(options) {
    var host = options.root, doc = host.ownerDocument, db = options.db;
    var state = { assignments: [], visits: [], guests: [], guidelines: null };
    var mounted = false, mountedEpoch = null, dataEpoch = null, request = 0, formVersion = 0, formEpoch = null;
    var view = 'followup', search = '', deacon = '', careRole = '', ready = false, failed = false, saving = false;
    var activeForm = null, returnFocus = null;
    function context() { return options.getContext() || {}; }
    function allowed(ctx) { return !!ctx.userId && ctx.canEdit === true && ['admin', 'editor'].indexOf(ctx.role) !== -1 && options.isCurrent(ctx.epoch); }
    function current(epoch) { var ctx = context(); return ctx.epoch === epoch && allowed(ctx); }
    function q(selector) { return host.querySelector(selector); }
    function safe(value) { var el = doc.createElement('span'); el.textContent = value == null ? '' : String(value); return el.innerHTML.replace(/"/g, '&quot;'); }
    function dateLabel(value) { return validDate(value) ? new Date(value + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'Not set'; }
    function people() { return Array.isArray(options.people()) ? options.people() : []; }
    function personName(id) {
      var person = people().find(function (item) { return item.id === id; });
      return person ? (person.display_name || person.name || [person.first_name, person.last_name].filter(Boolean).join(' ') || 'Unnamed person') : 'Person unavailable';
    }
    function tell(message, bad) { if (allowed(context())) options.notice(message, !!bad); }
    function empty(message) { return '<p class="care-empty">' + safe(message) + '</p>'; }
    function button(action, text, id, quiet, role) { return '<button type="button" class="' + (quiet ? 'quiet' : '') + '" data-care-action="' + action + '"' + (id ? ' data-contact="' + safe(id) + '"' : '') + (role ? ' data-care-role="' + safe(role) + '"' : '') + '>' + safe(text) + '</button>'; }
    function mount() {
      host.classList.add('care-workspace');
      host.innerHTML = '<div class="care-intro"><p class="eyebrow">Know people. Stay in touch.</p><h2>Care that continues.</h2><p>Plan a follow-up, record a visit, and help guests find their next step.</p></div>' +
        '<nav class="care-nav" aria-label="Care areas">' + [['followup', 'Follow-up'], ['coverage', 'Care coverage'], ['guests', 'Guests'], ['visitation', 'Visitation'], ['guidelines', 'Guidelines']].map(function (item) { return '<button type="button" data-care-view="' + item[0] + '" aria-pressed="false">' + item[1] + '</button>'; }).join('') + '</nav>' +
        '<p class="care-load-status" role="status"></p><div class="care-editor panel" hidden></div>' +
        '<div class="care-filters"><label>Search people<input type="search" data-care-search autocomplete="off" placeholder="Name or household"></label><label>Assigned person<select data-care-deacon><option value="">All assignments</option></select></label><label>Care role<select data-care-role-filter><option value="">All care roles</option>' + ROLES.map(function (role) { return '<option value="' + role + '">' + ROLE_LABELS[role] + '</option>'; }).join('') + '</select></label></div>' +
        '<section data-care-panel="followup" aria-label="Follow-up"><div class="care-section-head"><div><h3>Follow-up reminders</h3><p>Due dates use the church’s Central time. These reminders stay in Creek Office.</p></div>' + button('assignment', 'Set up follow-up') + '</div><div class="care-metrics"></div><p class="care-note">Deacons: every 3 months. Sunday school teachers: every month. Each role has its own plan and contact history. An attempted contact does not restart either schedule. Welcome visits can be one-time follow-ups.</p><div data-care-list="assignments" class="care-list"></div><details class="care-paused"><summary></summary><div data-care-list="paused" class="care-list"></div></details></section>' +
        '<section data-care-panel="coverage" aria-label="Care coverage" hidden><div class="care-section-head"><div><h3>No one overlooked.</h3><p>Active people who still need a recurring deacon or Sunday school plan, an assigned person, an unpaused plan, or an interval within the care goal. Historical inactive records and visitors are excluded.</p></div></div><div data-care-list="coverage" class="care-list"></div></section>' +
        '<section data-care-panel="guests" aria-label="Guests" hidden><div class="care-section-head"><div><h3>Welcome into the life of the church.</h3><p>Choose an existing person to start a guest follow-up record. Add someone new in <a href="#people">People</a> with visitor status.</p></div>' + button('guest', 'Add guest follow-up') + '</div><div data-care-list="guests" class="care-list"></div></section>' +
        '<section data-care-panel="visitation" aria-label="Visitation" hidden><div class="care-section-head"><div><h3>A record of being there.</h3><p>Record the date, method, and outcome of a contact. Entries stay as recorded.</p></div>' + button('visit', 'Record a contact') + '</div><div data-care-list="visits" class="care-list"></div></section>' +
        '<section data-care-panel="guidelines" aria-label="Guidelines" hidden><div data-care-guidelines></div></section>';
      mounted = true; mountedEpoch = context().epoch;
    }
    function matching(contactId) {
      var person = people().find(function (item) { return item.id === contactId; }) || {};
      return !search || [personName(contactId), person.household_name].join(' ').toLowerCase().includes(search.toLowerCase());
    }
    function matchingAssignment(item) {
      var name = item && item.assigned_to ? item.assigned_to : '';
      return (!careRole || (item && roleOf(item) === careRole)) && (!deacon || (deacon === '__unassigned' ? !name : name === deacon));
    }
    function matchingContact(contactId, role) {
      var plans = state.assignments.filter(function (item) { return item.contact_id === contactId && (!role || roleOf(item) === role); });
      return (!careRole || !role || careRole === role) && (plans.length ? plans.some(matchingAssignment) : (!deacon || deacon === '__unassigned') && (!careRole || careRole === role));
    }
    function dueTag(due) {
      if (due.state === 'completed') return '<span class="care-tag">Completed</span>';
      if (due.state === 'paused') return '<span class="care-tag">Paused</span>';
      var label = due.state === 'overdue' ? 'Overdue · ' + due.daysOverdue + (due.daysOverdue === 1 ? ' day' : ' days') : due.state === 'due' ? 'Due today' : due.state === 'upcoming' ? 'Next · ' + dateLabel(due.due) : 'Choose a start date';
      return '<span class="care-tag ' + (due.state === 'overdue' ? 'care-overdue' : '') + '">' + safe(label) + '</span>';
    }
    function assignmentRow(item) {
      var due = dueFor(item, state.visits);
      return '<article class="care-row"><div class="care-row-main"><div class="care-row-title"><h4>' + safe(personName(item.contact_id)) + '</h4>' + dueTag(due) + '</div><p>' + safe(ROLE_LABELS[roleOf(item)]) + ' · ' + safe(item.assigned_to || 'No person assigned') + ' · ' + (item.one_time ? 'One-time follow-up' : 'Every ' + (due.months || due.cadence) + (due.months ? (due.months === 1 ? ' month' : ' months') : ' days')) + '</p><p class="care-small">' + (due.neverContacted ? 'Never contacted in this record' : 'Last successful contact · ' + dateLabel(due.lastContact)) + (due.explicit ? ' · Next date chosen in the latest contact record' : '') + '</p>' + (item.notes ? '<details><summary>Planning note</summary><p class="care-preserve">' + safe(item.notes) + '</p></details>' : '') + '</div><div class="care-row-actions">' + button('visit', 'Record contact', item.contact_id, false, roleOf(item)) + button('assignment', 'Edit plan', item.contact_id, true, roleOf(item)) + '</div></article>';
    }
    function renderLists() {
      if (!mounted) return;
      var visible = state.assignments.filter(function (item) { return matching(item.contact_id) && matchingAssignment(item); });
      var active = visible.filter(function (item) { return !item.paused; }).sort(function (a, b) { return String(dueFor(a, state.visits).due || '9999').localeCompare(String(dueFor(b, state.visits).due || '9999')); });
      var paused = visible.filter(function (item) { return item.paused; });
      var due = active.filter(function (item) { return ['due', 'overdue'].indexOf(dueFor(item, state.visits).state) !== -1; });
      var never = active.filter(function (item) { return dueFor(item, state.visits).neverContacted; });
      var gaps = coverageFor(people(), state.assignments).filter(function (gap) { return matching(gap.contact_id) && matchingAssignment(gap.plan || gap); });
      q('.care-metrics').innerHTML = [['Due or overdue', due.length], ['Never contacted', never.length], ['Paused plans', paused.length], ['Coverage gaps', gaps.length]].map(function (item) { return '<div><span>' + item[0] + '</span><b>' + item[1] + '</b></div>'; }).join('');
      q('[data-care-list="assignments"]').innerHTML = active.map(assignmentRow).join('') || empty(ready ? 'No follow-up plans match. Set up a plan for an existing person to begin.' : 'Care records have not loaded.');
      q('.care-paused summary').textContent = 'Paused plans (' + paused.length + ')';
      q('[data-care-list="paused"]').innerHTML = paused.map(assignmentRow).join('') || empty('No paused plans match.');
      q('[data-care-list="coverage"]').innerHTML = gaps.map(function (gap) { return '<article class="care-row"><div class="care-row-main"><h4>' + safe(personName(gap.contact_id)) + '</h4><p>' + safe(ROLE_LABELS[gap.care_role]) + ' · ' + safe(gap.reason) + '</p></div><div class="care-row-actions">' + button('assignment', gap.plan ? 'Review plan' : 'Set up plan', gap.contact_id, false, gap.care_role) + '</div></article>'; }).join('') || empty(ready ? 'Every active person in this selection has assigned, recurring plans within the deacon and Sunday school care goals.' : 'Care records have not loaded.');
      q('[data-care-list="guests"]').innerHTML = state.guests.filter(function (item) { return matching(item.contact_id) && matchingContact(item.contact_id); }).slice().sort(function (a, b) { return String(a.follow_up_on || '9999').localeCompare(String(b.follow_up_on || '9999')); }).map(function (item) {
        var open = ['new', 'contacted'].indexOf(item.status) !== -1;
        var label = validDate(item.follow_up_on) ? (open && item.follow_up_on < today() ? 'Follow-up overdue · ' : 'Follow-up · ') + dateLabel(item.follow_up_on) : 'No follow-up date chosen';
        return '<article class="care-row"><div class="care-row-main"><div class="care-row-title"><h4>' + safe(personName(item.contact_id)) + '</h4><span class="care-tag">' + safe(item.status) + '</span></div><p>First visit · ' + dateLabel(item.first_visit_on) + '</p><p class="care-small">' + safe(label) + '</p>' + (item.next_step ? '<p><b>Next step:</b> ' + safe(item.next_step) + '</p>' : '') + (item.notes ? '<details><summary>Guest note</summary><p class="care-preserve">' + safe(item.notes) + '</p></details>' : '') + '</div><div class="care-row-actions">' + button('guest', 'Edit follow-up', item.contact_id, true) + button('visit', 'Record contact', item.contact_id, true, 'welcome') + '</div></article>';
      }).join('') || empty(ready ? 'No guest follow-up records match. Add an existing visitor to get started.' : 'Care records have not loaded.');
      q('[data-care-list="visits"]').innerHTML = state.visits.filter(function (item) { return matching(item.contact_id) && matchingContact(item.contact_id, roleOf(item)); }).slice().sort(latestFirst).map(function (item) {
        return '<article class="care-row"><div class="care-row-main"><div class="care-row-title"><h4>' + safe(personName(item.contact_id)) + '</h4><span class="care-tag">' + (item.outcome === 'contacted' ? 'Contacted' : 'Attempted') + '</span></div><p>' + dateLabel(item.contacted_on) + ' · ' + safe(ROLE_LABELS[roleOf(item)]) + ' · ' + safe(item.method) + ' · ' + safe(item.visitor_name) + '</p>' + (item.next_contact_on ? '<p class="care-small">Next contact requested · ' + dateLabel(item.next_contact_on) + '</p>' : '') + (item.notes ? '<details><summary>Contact note</summary><p class="care-preserve">' + safe(item.notes) + '</p></details>' : '') + '</div></article>';
      }).join('') || empty(ready ? 'No contacts have been recorded for this selection.' : 'Care records have not loaded.');
    }
    function renderGuidelines() {
      var record = state.guidelines, canWrite = context().role === 'admin';
      q('[data-care-guidelines]').innerHTML = '<div class="care-section-head"><div><h3>Guidelines for caring well.</h3><p>Keep the team’s agreed approach in one place. Only workspace administrators can edit this text.</p></div>' + (canWrite ? button('guidelines', record ? 'Edit guidelines' : 'Write guidelines') : '') + '</div>' +
        (record ? '<div class="panel care-guidelines-body"><p class="care-preserve">' + safe(record.body) + '</p><p class="care-small">Last updated · ' + dateLabel(String(record.updated_at || record.created_at || '').slice(0, 10)) + '</p></div>' : '<div class="panel care-guidelines-body"><span class="care-tag">Proposed starting guidance · not church policy</span><h4>No church guidelines have been saved yet.</h4><ul><li>Ask how and when each person would like to be contacted.</li><li>Choose an appropriate follow-up interval together.</li><li>Record a brief, useful note and the next agreed step.</li><li>Keep personal information within the authorized care team.</li></ul><p class="care-small">These suggestions are a draft for staff discussion. An administrator can replace them with the church’s agreed guidance.</p></div>');
    }
    function render() {
      var ctx = context();
      if (!allowed(ctx)) { clear(); return; }
      if (mounted && mountedEpoch !== ctx.epoch) clear();
      if (!mounted) mount();
      host.querySelectorAll('[data-care-panel]').forEach(function (node) { node.hidden = node.dataset.carePanel !== view; });
      host.querySelectorAll('[data-care-view]').forEach(function (node) { node.setAttribute('aria-pressed', String(node.dataset.careView === view)); });
      q('.care-filters').hidden = view === 'guidelines';
      var names = Array.from(new Set(state.assignments.map(function (item) { return item.assigned_to; }).filter(Boolean))).sort();
      q('[data-care-deacon]').innerHTML = '<option value="">All assignments</option><option value="__unassigned">Unassigned</option>' + names.map(function (name) { return '<option value="' + safe(name) + '">' + safe(name) + '</option>'; }).join('');
      if (deacon && deacon !== '__unassigned' && names.indexOf(deacon) === -1) deacon = '';
      q('[data-care-deacon]').value = deacon;
      q('[data-care-role-filter]').value = careRole;
      q('.care-load-status').textContent = failed ? 'Care records could not load. Use Refresh care to try again.' : !ready ? 'Loading care records…' : '';
      var retry = q('[data-care-action="retry"]');
      if (failed && !retry) q('.care-load-status').insertAdjacentHTML('afterend', button('retry', 'Refresh care', null, true));
      if (!failed && retry) retry.remove();
      renderLists(); renderGuidelines();
      host.querySelectorAll('.care-section-head button[data-care-action]').forEach(function (node) { node.disabled = !ready; });
    }
    async function allRows(table, epoch, token) {
      var rows = [], offset = 0;
      while (current(epoch) && token === request) {
        var result = await db.from(table).select('*').order('id', { ascending: true }).range(offset, offset + 999);
        if (!current(epoch) || token !== request) return { data: [] };
        if (result.error) return { error: true };
        var page = result.data || []; rows = rows.concat(page);
        if (page.length < 1000) return { data: rows };
        offset += 1000;
      }
      return { data: [] };
    }
    async function load(epoch) {
      if (!current(epoch)) return false;
      if (mounted && mountedEpoch !== epoch) clear();
      var token = ++request;
      try {
        var results = await Promise.all([
          allRows('care_assignments', epoch, token), allRows('care_visits', epoch, token),
          allRows('guest_intakes', epoch, token), db.from('care_guidelines').select('*').eq('id', 'default').maybeSingle()
        ]);
        if (!current(epoch) || token !== request) return false;
        if (results.some(function (result) { return result.error; })) throw new Error('load');
        state = { assignments: results[0].data || [], visits: results[1].data || [], guests: results[2].data || [], guidelines: results[3].data || null };
        dataEpoch = epoch; ready = true; failed = false; render(); return true;
      } catch (_) {
        if (!current(epoch) || token !== request) return false;
        state = { assignments: [], visits: [], guests: [], guidelines: null }; dataEpoch = epoch; ready = false; failed = true; render();
        tell('Care records could not load. Please try again.', true); return false;
      }
    }
    function contactSelect(id) {
      return '<label class="care-wide">Person<select name="contact_id" required><option value="">Choose a person</option>' + people().map(function (person) { return '<option value="' + safe(person.id) + '"' + (person.id === id ? ' selected' : '') + '>' + safe(personName(person.id)) + '</option>'; }).join('') + '</select><small>Manage people and new visitors in <a href="#people">People</a>.</small></label>';
    }
    function input(name, label, type, value, required, extra) { return '<label>' + safe(label) + '<input name="' + name + '" type="' + type + '" value="' + safe(value || '') + '"' + (required ? ' required' : '') + ' ' + (extra || '') + '></label>'; }
    function select(name, label, choices, selected) { return '<label>' + safe(label) + '<select name="' + name + '">' + choices.map(function (value) { return '<option value="' + value + '"' + (value === selected ? ' selected' : '') + '>' + value.charAt(0).toUpperCase() + value.slice(1) + '</option>'; }).join('') + '</select></label>'; }
    function roleSelect(role) { return '<label>Care role<select name="care_role" required>' + ROLES.map(function (value) { return '<option value="' + value + '"' + (value === role ? ' selected' : '') + '>' + ROLE_LABELS[value] + '</option>'; }).join('') + '</select></label>'; }
    function area(name, label, value, max) { return '<label class="care-wide">' + safe(label) + '<textarea name="' + name + '" maxlength="' + (max || 4000) + '">' + safe(value || '') + '</textarea></label>'; }
    function closeEditor(focus) {
      formVersion++; activeForm = null; formEpoch = null; saving = false;
      if (mounted) { q('.care-editor').replaceChildren(); q('.care-editor').hidden = true; }
      if (focus && returnFocus && returnFocus.isConnected) returnFocus.focus();
      else if (focus && mounted) q('[data-care-view="' + view + '"]').focus();
      returnFocus = null;
    }
    function openEditor(kind, id, trigger, role) {
      var ctx = context();
      if (!allowed(ctx) || !ready || dataEpoch !== ctx.epoch || (kind === 'guidelines' && ctx.role !== 'admin') || saving) return;
      closeEditor(false); activeForm = kind; formEpoch = ctx.epoch; returnFocus = trigger;
      var item = {}, fields = '', title = '';
      role = ROLES.indexOf(role) !== -1 ? role : 'deacon';
      if (kind === 'assignment') {
        item = state.assignments.find(function (row) { return row.contact_id === id && roleOf(row) === role; }) || {};
        title = item.id ? 'Edit follow-up plan' : 'Set up follow-up';
        var months = item.id ? item.cadence_months : role === 'deacon' ? 3 : role === 'sunday_school' ? 1 : null;
        var once = item.id ? item.one_time : role === 'welcome';
        fields = contactSelect(id) + roleSelect(role) + input('assigned_to', 'Assigned person / teacher / deacon', 'text', item.assigned_to, false, 'maxlength="120" autocomplete="off"') + select('cadence_unit', 'Repeat interval', ['months', 'days'], months ? 'months' : 'days') + input('cadence_value', 'Every', 'number', months || item.cadence_days || (role === 'welcome' ? 2 : 14), true, 'min="1" max="' + (months ? '12' : '365') + '" step="1"') + input('started_on', 'Plan starts on', 'date', item.started_on || today(), true) + input('first_due_on', 'First contact due (optional)', 'date', item.first_due_on || (role === 'welcome' && !item.id ? addDays(today(), 2) : ''), false) + '<label class="care-check"><input name="one_time" type="checkbox"' + (once ? ' checked' : '') + '>One-time follow-up</label><label class="care-check"><input name="paused" type="checkbox"' + (item.paused ? ' checked' : '') + '>Pause this care plan</label><p class="care-wide care-small">Presets: deacon every 3 months; Sunday school every month; welcome within 2 days. Use Additional care for an optional 2-week check-in. Monthly plans use calendar months. A first due date applies until the first successful contact; later dates can be chosen when recording a contact.</p>' + area('notes', 'Planning notes', item.notes);
      } else if (kind === 'visit') {
        title = 'Record a contact';
        fields = contactSelect(id) + roleSelect(role) + input('visitor_name', 'Person who made the contact', 'text', '', true, 'maxlength="120" autocomplete="off"') + input('contacted_on', 'Contact date', 'date', today(), true, 'max="' + today() + '"') + select('method', 'Method', ['call', 'visit', 'text', 'email', 'other'], 'visit') + select('outcome', 'Outcome', ['contacted', 'attempted'], 'contacted') + input('next_contact_on', 'Next contact date (optional)', 'date', '', false) + '<p class="care-wide care-small">Choose the role this contact fulfills. It only updates that role’s plan. A chosen next date overrides its interval; an attempt without a next date does not restart it.</p>' + area('notes', 'Brief contact notes', '');
      } else if (kind === 'guest') {
        item = state.guests.find(function (row) { return row.contact_id === id; }) || {}; title = item.id ? 'Edit guest follow-up' : 'Add guest follow-up';
        fields = contactSelect(id) + input('first_visit_on', 'First visit date (optional)', 'date', item.first_visit_on || '', false) + select('status', 'Connection status', ['new', 'contacted', 'connected', 'closed'], item.status || 'new') + input('follow_up_on', 'Follow-up date (optional)', 'date', item.follow_up_on || '', false) + '<div></div>' + area('next_step', 'Next step', item.next_step, 1000) + area('notes', 'Guest notes', item.notes);
      } else if (kind === 'guidelines') { title = 'Church care guidelines'; fields = area('body', 'Agreed guidance for the care team', state.guidelines ? state.guidelines.body : '', 12000); }
      else return;
      q('.care-editor').innerHTML = '<form data-care-form><div class="care-form-head"><h3 tabindex="-1">' + title + '</h3>' + button('cancel', 'Cancel', null, true) + '</div><div class="care-form-grid">' + fields + '</div><p class="care-form-error error" role="alert"></p><div class="care-form-actions"><button type="submit">Save ' + (kind === 'visit' ? 'contact' : kind === 'guidelines' ? 'guidelines' : 'follow-up') + '</button></div></form>';
      q('.care-editor').hidden = false; q('.care-editor h3').focus();
      if (item.id && kind !== 'guidelines') q('[name="contact_id"]').disabled = true;
    }
    function values(form) {
      var result = {};
      form.querySelectorAll('[name]').forEach(function (node) { result[node.name] = node.type === 'checkbox' ? node.checked : node.value.trim(); });
      return result;
    }
    async function save(event) {
      event.preventDefault();
      var form = event.target, kind = activeForm, epoch = formEpoch, version = formVersion;
      if (!form.matches('[data-care-form]') || saving || !current(epoch) || (kind === 'guidelines' && context().role !== 'admin')) return;
      if (!ready || dataEpoch !== epoch) { q('.care-form-error').textContent = 'Refresh care records before saving.'; return; }
      if (form.reportValidity && !form.reportValidity()) return;
      var row = values(form), table, payload, error = '';
      if (kind !== 'guidelines' && !people().some(function (person) { return person.id === row.contact_id; })) error = 'Choose an existing person.';
      if (kind === 'assignment') {
        var cadence = Number(row.cadence_value), months = row.cadence_unit === 'months';
        if (!Number.isInteger(cadence) || cadence < 1 || cadence > (months ? 12 : 365) || !validDate(row.started_on) || ['months', 'days'].indexOf(row.cadence_unit) === -1) error = 'Choose a valid start date and an interval from 1 to 12 months or 1 to 365 days.';
        if (row.first_due_on && (!validDate(row.first_due_on) || row.first_due_on < row.started_on)) error = 'Choose a first due date on or after the plan starts.';
        if (ROLES.indexOf(row.care_role) === -1) error = 'Choose the role for this care plan.';
        table = 'care_assignments'; payload = { contact_id: row.contact_id, care_role: row.care_role, assigned_to: row.assigned_to || null, cadence_days: months ? 28 : cadence, cadence_months: months ? cadence : null, first_due_on: row.first_due_on || null, one_time: row.one_time, started_on: row.started_on, paused: row.paused, notes: row.notes || null };
      } else if (kind === 'visit') {
        if (ROLES.indexOf(row.care_role) === -1 || !row.visitor_name || !validDate(row.contacted_on) || row.contacted_on > today() || ['call', 'visit', 'text', 'email', 'other'].indexOf(row.method) === -1 || ['contacted', 'attempted'].indexOf(row.outcome) === -1) error = 'Enter who made the contact, a valid contact date, method, and outcome.';
        if (row.next_contact_on && (!validDate(row.next_contact_on) || row.next_contact_on < row.contacted_on)) error = 'Choose a next contact date on or after this contact.';
        table = 'care_visits'; payload = { contact_id: row.contact_id, care_role: row.care_role, visitor_name: row.visitor_name, contacted_on: row.contacted_on, method: row.method, outcome: row.outcome, notes: row.notes || null, next_contact_on: row.next_contact_on || null };
      } else if (kind === 'guest') {
        if ((row.first_visit_on && !validDate(row.first_visit_on)) || (row.follow_up_on && !validDate(row.follow_up_on)) || ['new', 'contacted', 'connected', 'closed'].indexOf(row.status) === -1) error = 'Choose valid dates and a guest connection status.';
        table = 'guest_intakes'; payload = { contact_id: row.contact_id, first_visit_on: row.first_visit_on || null, next_step: row.next_step || null, status: row.status, follow_up_on: row.follow_up_on || null, notes: row.notes || null };
      } else if (kind === 'guidelines') { if (!row.body) error = 'Write the agreed guidance before saving.'; table = 'care_guidelines'; payload = { id: 'default', body: row.body }; }
      else return;
      if (error) { q('.care-form-error').textContent = error; return; }
      saving = true; q('.care-form-error').textContent = ''; form.querySelector('button[type="submit"]').disabled = true;
      var saved = false;
      try {
        if (!current(epoch)) return;
        var write = kind === 'visit' ? db.from(table).insert(payload) : db.from(table).upsert(payload, { onConflict: kind === 'guidelines' ? 'id' : kind === 'assignment' ? 'contact_id,care_role' : 'contact_id' });
        var result = await write.select('id').single();
        if (!current(epoch) || version !== formVersion) return;
        if (result.error || !result.data || !result.data.id) throw new Error('save');
        saved = true; closeEditor(false); tell('Care record saved.');
        await options.refresh();
      } catch (_) {
        if (current(epoch) && saved) tell('Saved, but care records could not refresh. Please refresh the workspace.', true);
        else if (current(epoch) && version === formVersion && q('.care-form-error')) q('.care-form-error').textContent = 'This record could not be saved. Your entries are still here; please try again.';
      } finally {
        if (current(epoch) && version === formVersion && q('[data-care-form]')) { saving = false; q('[data-care-form] button[type="submit"]').disabled = false; }
      }
    }
    function clear() {
      request++; formVersion++; activeForm = null; formEpoch = null; saving = false; returnFocus = null;
      state = { assignments: [], visits: [], guests: [], guidelines: null };
      view = 'followup'; search = ''; deacon = ''; careRole = ''; ready = false; failed = false; dataEpoch = null; mountedEpoch = null; mounted = false;
      host.replaceChildren();
    }
    host.addEventListener('click', function (event) {
      var target = event.target.closest('button');
      if (!target || !host.contains(target) || !allowed(context())) return;
      if (target.dataset.careView) {
        view = target.dataset.careView; render(); var heading = q('[data-care-panel="' + view + '"] h3');
        if (heading) { heading.tabIndex = -1; heading.focus(); }
      }
      if (target.dataset.careAction === 'cancel') closeEditor(true);
      else if (target.dataset.careAction === 'retry') options.refresh().catch(function () { tell('Care records could not load. Please try again.', true); });
      else if (target.dataset.careAction) openEditor(target.dataset.careAction, target.dataset.contact, target, target.dataset.careRole);
    });
    host.addEventListener('input', function (event) { if (!allowed(context())) return; if (event.target.matches('[data-care-search]')) { search = event.target.value; renderLists(); } });
    host.addEventListener('change', function (event) {
      if (!allowed(context())) return;
      if (event.target.matches('[data-care-deacon]')) { deacon = event.target.value; renderLists(); }
      if (event.target.matches('[data-care-role-filter]')) { careRole = event.target.value; renderLists(); }
      if (event.target.matches('[name="cadence_unit"]')) q('[name="cadence_value"]').max = event.target.value === 'months' ? '12' : '365';
      if ((event.target.matches('[name="contact_id"]') || event.target.matches('[name="care_role"]')) && ['assignment', 'guest'].indexOf(activeForm) !== -1) {
        var id = q('[name="contact_id"]').value, role = q('[name="care_role"]') ? q('[name="care_role"]').value : null;
        var rows = activeForm === 'assignment' ? state.assignments : state.guests;
        if (event.target.name === 'care_role' || rows.some(function (item) { return item.contact_id === id && (activeForm !== 'assignment' || roleOf(item) === role); })) openEditor(activeForm, id, returnFocus, role);
      }
    });
    host.addEventListener('submit', save);
    return { load: load, render: render, clear: clear };
  }
  return { create: create, dueFor: dueFor, today: today, validDate: validDate, addMonths: addMonths, coverageFor: coverageFor };
}));
