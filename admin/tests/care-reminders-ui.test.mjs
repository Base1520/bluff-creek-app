import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { JSDOM } = createRequire(import.meta.url)('jsdom');

const source = await readFile(new URL('../care-reminders.js', import.meta.url), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = '2026-09-12T15:00:00Z';
const counts = extra => ({ bindings: 1, enabled_bindings: 1, disabled_bindings: 0, missing_sources: 0,
  owner_changed: 0, lifecycle_changed: 0, recipient_unavailable: 0, unassigned: 0,
  linked_welcome_suppressed: 0, linked_source_changed: 0, inactive_sources: 0,
  open_sources: 1, unbound_care: 0, unbound_guests: 1, ...extra });
const binding = extra => ({ source_type: 'care_plan', source_id: id(10), owner_user_id: id(2), enabled: true,
  cycle_id: id(30), version: 2, approved_source_version: 3, lifecycle_version: null, linked_guest_task_id: null, ...extra });
const sourceRow = extra => ({ source_type: 'care_plan', source_id: id(10), source_version: 3,
  lifecycle_version: null, contact_id: id(20), label: 'Fictional Care Person', care_role: 'deacon',
  owner_label: 'A display name is not a staff binding', assigned_staff_user_id: id(2), one_time: false, active: true, ...extra });
const workspace = extra => ({ version: 1, generated_at: NOW, today: '2026-09-12',
  settings: { version: 1, settings_version: 4, enabled: false, pastor_user_ids: [id(1)],
    bindings: [binding()], eligible_staff_user_ids: [id(1), id(2)] },
  readiness: { available: true, version: 1, enabled: false, settings_version: 4, today: '2026-09-12', counts: counts(), pastor_setup_required: false },
  eligible_staff: [{ id: id(1), label: 'admin@example.invalid' }, { id: id(2), label: 'deacon@example.invalid' }],
  sources: [sourceRow(), sourceRow({ source_type: 'guest_task', source_id: id(11), source_version: 7,
    lifecycle_version: 2, contact_id: id(21), label: 'Fictional Guest Person', care_role: 'welcome',
    owner_label: '', assigned_staff_user_id: id(2), one_time: true })], ...extra });
const job = extra => ({ id: id(40), version: 3, status: 'uncertain', created_at: NOW, planned_on: '2026-09-12',
  next_attempt_at: NOW, attempts: 1, error_code: 'delivery_uncertain', recipient_user_ids: [id(2)],
  source_count: 1, hold_active: true, can_resolve: true, ...extra });
const jobs = extra => ({ version: 1, generated_at: NOW, total: 1,
  countsByStatus: { queued: 0, sending: 0, accepted: 0, failed: 0, uncertain: 1, cancelled: 0 },
  items: [job()], has_more: false, next_cursor: null, ...extra });
const selector = name => `[data-reminder-${name}]`;
const wait = () => new Promise(resolve => setImmediate(resolve));
async function flush() { await wait(); await wait(); }
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function fixture(t, initial = workspace(), initialJobs = jobs()) {
  const dom = new JSDOM('<section id="care-reminders-view"></section>', {
    url: 'https://office.example.invalid/admin/', runScripts: 'outside-only',
  });
  const w = dom.window, host = w.document.querySelector('section');
  t.after(() => w.close());
  let context = { epoch: 1, userId: id(1), role: 'admin', canEdit: true, workspaceReady: true };
  const state = { workspace: clone(initial), jobs: clone(initialJobs), receipts: new Map(), rpc: null, ensure: async () => true, confirm: () => true };
  const calls = [], notices = [], opened = [], summaries = [], confirms = [], timers = new Map();
  let timerId = 0;
  w.setTimeout = callback => { timers.set(++timerId, callback); return timerId; };
  w.clearTimeout = key => timers.delete(key);
  w.confirm = message => { confirms.push(message); return state.confirm(); };
  for (const key of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(w, key, { get() { throw Error('Private reminder state must stay in RAM'); } });
  }
  w.fetch = () => { throw Error('Direct network requests are forbidden'); };
  w.open = () => { throw Error('No popup or external navigation'); };
  const ok = data => ({ data: clone(data), error: null });
  w.eval(source);
  const api = w.CreekCareReminders.create({
    root: host,
    db: { rpc: async (name, args = {}) => {
      calls.push({ name, args: clone(args) });
      return state.rpc ? state.rpc(name, args, normal) : normal(name, args);
    } },
    getContext: () => context,
    isCurrent: epoch => epoch === context.epoch,
    ensureReady: epoch => state.ensure(epoch),
    notice: (...args) => notices.push(args),
    openSource: (...args) => { opened.push(args); return true; },
    onSummary: value => summaries.push(value == null ? null : clone(value)),
  });
  function normal(name, args) {
    if (name === 'get_care_reminder_workspace') return ok(state.workspace);
    if (name === 'get_care_reminder_jobs') {
      const value = clone(state.jobs);
      if (args.p_filter === 'attention') {
        const statuses = ['queued', 'sending', 'failed', 'uncertain'];
        value.items = value.items.filter(item => statuses.includes(item.status));
        value.total = statuses.reduce((total, status) => total + value.countsByStatus[status], 0);
      }
      return ok(value);
    }
    if (state.receipts.has(args.p_request_id)) return ok(state.receipts.get(args.p_request_id));
    let result;
    if (name === 'set_care_reminder_settings') {
      state.workspace.settings.settings_version++;
      state.workspace.settings.enabled = args.p_enabled;
      state.workspace.settings.pastor_user_ids = clone(args.p_pastor_user_ids);
      state.workspace.readiness.settings_version = state.workspace.settings.settings_version;
      state.workspace.readiness.enabled = args.p_enabled;
      result = { version: state.workspace.settings.settings_version, enabled: args.p_enabled, pastor_user_ids: clone(args.p_pastor_user_ids) };
    } else if (name === 'set_care_reminder_binding') {
      const saved = binding({ source_type: args.p_source_type, source_id: args.p_source_id,
        owner_user_id: args.p_owner_user_id, enabled: args.p_enabled, version: args.p_version + 1,
        approved_source_version: args.p_source_version, lifecycle_version: args.p_lifecycle_version,
        linked_guest_task_id: args.p_linked_guest_task_id, cycle_id: args.p_restart_cycle ? id(31) : id(30) });
      state.workspace.settings.bindings = state.workspace.settings.bindings.filter(b => b.source_id !== saved.source_id);
      state.workspace.settings.bindings.push(saved);
      state.workspace.readiness.counts.bindings = state.workspace.settings.bindings.length;
      state.workspace.readiness.counts.enabled_bindings = state.workspace.settings.bindings.filter(b => b.enabled).length;
      state.workspace.readiness.counts.disabled_bindings = state.workspace.settings.bindings.filter(b => !b.enabled).length;
      result = { source_type: saved.source_type, source_id: saved.source_id, version: saved.version,
        cycle_id: saved.cycle_id, enabled: saved.enabled, lifecycle_version: saved.lifecycle_version };
    } else if (name === 'resolve_care_reminder_job') {
      const saved = state.jobs.items.find(value => value.id === args.p_id);
      state.jobs.countsByStatus[saved.status]--;
      state.jobs.countsByStatus.cancelled++;
      saved.status = 'cancelled'; saved.version++; saved.hold_active = false; saved.can_resolve = false;
      result = { id: saved.id, version: saved.version, status: 'cancelled', resolution: 'cancel_no_resend' };
    } else throw Error('Unexpected RPC: ' + name);
    state.receipts.set(args.p_request_id, clone(result));
    return ok(result);
  }
  const query = selector => host.querySelector(selector);
  const click = async selector => {
    const node = query(selector);
    assert.ok(node, 'Control exists: ' + selector);
    node.click();
    await flush();
  };
  const change = (selector, value) => {
    const node = query(selector);
    assert.ok(node, 'Field exists: ' + selector);
    if (node.type === 'checkbox') node.checked = value; else node.value = value;
    node.dispatchEvent(new w.Event('change', { bubbles: true }));
  };
  const unload = () => {
    const event = new w.Event('beforeunload', { cancelable: true });
    w.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return {
    w, host, state, api, calls, notices, opened, summaries, confirms, query, click, change, unload, ok, normal,
    context: () => context,
    setContext: next => { context = next; },
    writes: () => calls.filter(c => ['set_care_reminder_settings', 'set_care_reminder_binding', 'resolve_care_reminder_job'].includes(c.name)),
    timeout: async () => {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach(fn => fn());
      await flush();
    },
  };
}

async function load(f) { assert.equal(await f.api.load(f.context().epoch), true); }
function enable(f, value = true) { f.change(selector('enabled'), value); }
async function openCare(f) { await f.click(`[data-reminder-source-open][value="care_plan:${id(10)}"]`); }
function changeOwner(f, value = id(1)) { f.change(selector('owner'), value); }

test('admin sees explicit staff bindings and safe queue controls without dispatching mail', async t => {
  const f = fixture(t); await load(f);
  assert.deepEqual(f.calls.find(c => c.name === 'get_care_reminder_workspace').args, {});
  assert.deepEqual(f.calls.find(c => c.name === 'get_care_reminder_jobs').args, {
    p_filter: 'attention', p_before_created_at: null, p_before_id: null, p_limit: 50,
  });
  assert.match(f.host.textContent, /Fictional Care Person/);
  assert.equal(f.query(selector('enabled')).checked, false);
  await openCare(f);
  assert.equal(f.query(selector('owner')).value, id(2));
  assert.equal(f.query(selector('restart')).checked, false);
  assert.equal(f.writes().length, 0);
  assert.equal(f.host.querySelector('a[download]'), null);
  assert.equal([...f.host.querySelectorAll('button')].some(b => /^send now|^resend|^complete care/i.test(b.textContent.trim())), false);
});

test('nonadmins never fetch private reminder state and identity changes clear RAM and unload warnings', async t => {
  for (const role of ['editor', 'viewer', null]) {
    const f = fixture(t); f.setContext({ ...f.context(), role });
    assert.equal(await f.api.load(1), false); assert.equal(f.calls.length, 0); assert.equal(f.host.textContent, '');
  }
  for (const change of [{ role: 'editor' }, { role: 'viewer' }, { userId: null }, { epoch: 2 }, { userId: id(3), epoch: 2 }]) {
    const f = fixture(t); await load(f); enable(f); assert.equal(f.unload(), true);
    f.setContext({ ...f.context(), ...change, workspaceReady: false, canEdit: false }); f.api.render();
    assert.equal(f.host.textContent, ''); assert.equal(f.unload(), false);
    assert.equal(f.summaries.at(-1), null);
    f.setContext({ epoch: 3, userId: id(3), role: 'admin', workspaceReady: true, canEdit: true }); await load(f);
    assert.equal(f.query(selector('enabled')).checked, false); assert.equal(f.unload(), false);
  }
});

test('missing or incomplete workspace is unavailable rather than an empty successful snapshot', async t => {
  const missing = workspace(); delete missing.readiness.counts;
  const duplicateSource = workspace(); duplicateSource.sources.push(clone(duplicateSource.sources[0]));
  const mismatch = workspace(); mismatch.readiness.settings_version++;
  for (const response of [
    { error: { code: 'PGRST202', message: 'PRIVATE_CANARY' } },
    { error: { code: '54000', message: 'PRIVATE_CANARY' } },
    { data: missing }, { data: duplicateSource }, { data: mismatch },
  ]) {
    const f = fixture(t); f.state.rpc = (name, args, normal) => name === 'get_care_reminder_workspace' ? response : normal(name, args);
    assert.equal(await f.api.load(1), false);
    assert.match(f.host.textContent, /unavailable|could not|not ready/i);
    assert.equal(f.writes().length, 0); assert.equal(f.summaries.at(-1), null);
    assert.doesNotMatch(f.host.textContent, /PRIVATE_CANARY|Fictional Care Person/);
    assert.ok(!f.query(selector('settings-save')) || f.query(selector('settings-save')).disabled);
  }
});

test('failed job read cannot present a previous held queue as cleared', async t => {
  const f = fixture(t); await load(f);
  f.state.rpc = (name, args, normal) => name === 'get_care_reminder_jobs' ? { error: { code: 'PGRST202', message: 'PRIVATE_CANARY' } } : normal(name, args);
  await f.api.load(1);
  assert.match(f.host.textContent, /unavailable|could not|not ready/i);
  assert.ok(!f.query(selector('job-cancel')) || f.query(selector('job-cancel')).disabled);
  assert.doesNotMatch(f.host.textContent, /PRIVATE_CANARY/); assert.equal(f.writes().length, 0);
});

test('incomplete first queue page cannot hide a counted held job as a successful empty result', async t => {
  const f = fixture(t, workspace(), jobs({ items: [] }));
  assert.equal(await f.api.load(1), false);
  assert.equal(f.summaries.at(-1), null);
  assert.match(f.host.textContent, /unavailable|could not|not ready/i);
  assert.equal(f.query(selector('job-cancel')), null); assert.equal(f.writes().length, 0);
});

test('refresh preserves dirty settings and changed server versions require explicit adoption', async t => {
  const f = fixture(t); await load(f); enable(f); f.change(`[data-reminder-pastor][value="${id(2)}"]`, true);
  f.state.workspace.settings.settings_version = 5; f.state.workspace.readiness.settings_version = 5;
  f.state.workspace.settings.pastor_user_ids = [id(2)];
  await f.api.load(1);
  assert.equal(f.query(selector('enabled')).checked, true);
  assert.equal(f.query(`[data-reminder-pastor][value="${id(1)}"]`).checked, true);
  assert.equal(f.query(`[data-reminder-pastor][value="${id(2)}"]`).checked, true);
  assert.equal(f.unload(), true);
  await f.click(selector('settings-save')); assert.equal(f.writes().length, 0);
  f.state.confirm = () => false; await f.click(selector('use-current'));
  assert.equal(f.query(selector('enabled')).checked, true); assert.equal(f.unload(), true);
  f.state.confirm = () => true; await f.click(selector('use-current'));
  assert.equal(f.query(selector('enabled')).checked, false); assert.equal(f.unload(), false);
  assert.equal(f.query(`[data-reminder-pastor][value="${id(1)}"]`).checked, false);
});

test('binding writes use reviewed source and binding versions, explicit UUID recipient and no display labels', async t => {
  const f = fixture(t); await load(f); await openCare(f); changeOwner(f);
  await f.click(selector('binding-save'));
  assert.equal(f.writes().length, 1);
  const call = f.writes()[0]; assert.equal(call.name, 'set_care_reminder_binding');
  assert.deepEqual({ ...call.args, p_request_id: null }, {
    p_request_id: null, p_source_type: 'care_plan', p_source_id: id(10), p_version: 2,
    p_source_version: 3, p_owner_user_id: id(1), p_enabled: true, p_restart_cycle: false,
    p_lifecycle_version: null, p_linked_guest_task_id: null,
  });
  assert.match(call.args.p_request_id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
  assert.doesNotMatch(JSON.stringify(call.args), /Fictional|example.invalid|display name/);
});

test('dirty source edits survive refresh and cannot silently acquire a newer source version', async t => {
  const f = fixture(t); await load(f); await openCare(f); changeOwner(f);
  f.state.workspace.sources[0].source_version = 4;
  await f.api.load(1);
  assert.equal(f.query(selector('owner')).value, id(1)); assert.equal(f.unload(), true);
  await f.click(selector('binding-save')); assert.equal(f.writes().length, 0);
  await f.click(selector('use-current'));
  assert.equal(f.query(selector('owner')).value, id(2)); assert.equal(f.query(selector('restart')).checked, false);
  changeOwner(f); await f.click(selector('binding-save'));
  assert.equal(f.writes()[0].args.p_source_version, 4);
});

test('unknown settings writes are frozen and explicit retries reuse exact UUID and payload even after a refused retry', async t => {
  const f = fixture(t); await load(f); enable(f); let attempts = 0;
  f.state.rpc = (name, args, normal) => {
    if (name !== 'set_care_reminder_settings') return normal(name, args);
    attempts++;
    if (attempts === 1) return Promise.reject(Error('PRIVATE_CANARY'));
    if (attempts === 2) return { error: { code: 'PGRST202', message: 'PRIVATE_CANARY' } };
    return normal(name, args);
  };
  await f.click(selector('settings-save')); const frozen = clone(f.writes()[0].args);
  assert.equal(f.writes().length, 1); assert.equal(f.unload(), true); assert.equal(f.query(selector('enabled')).disabled, true);
  await f.click(selector('settings-check')); assert.equal(f.writes().length, 1);
  assert.equal(f.query(selector('retry')).disabled, false);
  await f.click(selector('retry'));
  assert.equal(f.writes().length, 2); assert.deepEqual(f.writes()[1].args, frozen);
  assert.equal(f.query(selector('retry')).disabled, false); assert.equal(f.query(selector('enabled')).disabled, true);
  assert.equal(f.unload(), true); assert.doesNotMatch(f.host.textContent, /PRIVATE_CANARY/);
  await f.click(selector('retry'));
  assert.equal(f.writes().length, 3); assert.deepEqual(f.writes()[2].args, frozen);
  assert.equal(f.query(selector('enabled')).checked, true); assert.equal(f.unload(), false);
});

test('timed out settings write blocks duplicate clicks and old success cannot replace newer working edits', async t => {
  const f = fixture(t); await load(f); enable(f); const pending = deferred(); let first = true;
  f.state.rpc = (name, args, normal) => name === 'set_care_reminder_settings' && first ? (first = false, pending.promise) : normal(name, args);
  await f.click(selector('settings-save')); const frozen = clone(f.writes()[0].args);
  await f.click(selector('settings-save')); assert.equal(f.writes().length, 1);
  await f.timeout(); assert.equal(f.query(selector('retry')).disabled, false);
  await f.click(selector('retry')); assert.deepEqual(f.writes()[1].args, frozen);
  enable(f, false); assert.equal(f.unload(), true);
  pending.resolve(f.normal('set_care_reminder_settings', frozen)); await flush();
  assert.equal(f.query(selector('enabled')).checked, false); assert.equal(f.unload(), true); assert.equal(f.writes().length, 2);
});

test('same-session pause hides private data and retains an unresolved immutable write until explicit retry', async t => {
  const f = fixture(t); await load(f); await openCare(f); changeOwner(f);
  const pending = deferred(); let first = true;
  f.state.rpc = (name, args, normal) => name === 'set_care_reminder_binding' && first ? (first = false, pending.promise) : normal(name, args);
  await f.click(selector('binding-save')); const frozen = clone(f.writes()[0].args);
  f.setContext({ ...f.context(), workspaceReady: false, canEdit: false }); f.api.pause();
  assert.equal(f.host.textContent, ''); assert.equal(f.unload(), true); assert.equal(f.summaries.at(-1), null);
  const before = f.calls.length; assert.equal(await f.api.load(1), false); assert.equal(f.calls.length, before);
  pending.resolve(f.normal('set_care_reminder_binding', frozen)); await flush();
  assert.equal(f.host.textContent, ''); assert.equal(f.unload(), true);
  f.setContext({ ...f.context(), workspaceReady: true, canEdit: true }); await load(f);
  assert.equal(f.writes().length, 1); assert.equal(f.query(selector('retry')).disabled, false);
  assert.equal(f.query(selector('owner')).disabled, true);
  await f.click(selector('retry')); assert.deepEqual(f.writes()[1].args, frozen); assert.equal(f.unload(), false);
});

test('late workspace reads and write receipts cannot repopulate another account or clear its new edits', async t => {
  const f = fixture(t); const oldRead = deferred(); f.state.rpc = () => oldRead.promise;
  const loading = f.api.load(1); await flush();
  f.setContext({ ...f.context(), epoch: 2, userId: id(3) }); f.api.clear(); f.state.rpc = null;
  f.state.workspace.sources[0].label = 'New session only'; await load(f);
  oldRead.resolve(f.ok(workspace())); await loading; await flush();
  assert.doesNotMatch(f.host.textContent, /Fictional Care Person/); assert.match(f.host.textContent, /New session only/);
  enable(f); const oldWrite = deferred(); f.state.rpc = (name, args, normal) => name === 'set_care_reminder_settings' ? oldWrite.promise : normal(name, args);
  await f.click(selector('settings-save')); const frozen = f.writes()[0].args;
  f.setContext({ ...f.context(), epoch: 3, userId: id(4) }); f.api.clear(); f.state.rpc = null; await load(f);
  f.change(`[data-reminder-pastor][value="${id(2)}"]`, true);
  oldWrite.resolve(f.ok({ version: frozen.p_version + 1, enabled: true, pastor_user_ids: [id(1)] })); await flush();
  assert.equal(f.query(selector('enabled')).checked, false);
  assert.equal(f.query(`[data-reminder-pastor][value="${id(2)}"]`).checked, true); assert.equal(f.unload(), true);
});

test('failed readiness and identity changes during readiness prevent the first mutation', async t => {
  const f = fixture(t); await load(f); enable(f); f.state.ensure = async () => false;
  await f.click(selector('settings-save')); assert.equal(f.writes().length, 0); assert.equal(f.unload(), true);
  const gate = deferred(); f.state.ensure = () => gate.promise;
  await f.click(selector('settings-save'));
  f.setContext({ ...f.context(), epoch: 2, userId: id(3), role: 'viewer', canEdit: false, workspaceReady: false }); f.api.clear();
  gate.resolve(true); await flush();
  assert.equal(f.writes().length, 0); assert.equal(f.host.textContent, ''); assert.equal(f.unload(), false);
});

test('identity change queued after readiness but before RPC dispatch cannot send the former account decision', async t => {
  const f = fixture(t); await load(f); enable(f);
  f.state.ensure = () => {
    queueMicrotask(() => queueMicrotask(() => {
      f.setContext({ ...f.context(), epoch: 2, userId: id(3) });
      f.api.clear();
    }));
    return f.w.Promise.resolve(true);
  };
  await f.click(selector('settings-save'));
  assert.equal(f.writes().length, 0);
  assert.equal(f.host.textContent, ''); assert.equal(f.unload(), false);
});

test('version conflicts retain the working decision and require a fresh explicit review before a new request', async t => {
  const f = fixture(t); await load(f); enable(f); let first = true;
  f.state.rpc = (name, args, normal) => {
    if (name === 'set_care_reminder_settings' && first) {
      first = false; f.state.workspace.settings.settings_version = 5; f.state.workspace.readiness.settings_version = 5;
      return { error: { code: '40001', message: 'CARE_REMINDER_VERSION_CONFLICT' } };
    }
    return normal(name, args);
  };
  await f.click(selector('settings-save')); assert.equal(f.writes().length, 1);
  assert.equal(f.query(selector('enabled')).checked, true); assert.equal(f.unload(), true);
  await f.click(selector('settings-save')); assert.equal(f.writes().length, 1);
  await f.click(selector('settings-check')); assert.equal(f.query(selector('enabled')).checked, true);
  await f.click(selector('use-current')); assert.equal(f.query(selector('enabled')).checked, false);
  enable(f); await f.click(selector('settings-save'));
  assert.equal(f.writes().length, 2); assert.notEqual(f.writes()[0].args.p_request_id, f.writes()[1].args.p_request_id);
  assert.equal(f.writes()[1].args.p_version, 5);
});

test('held-job cancellation is explicit and versioned, and never sends or completes the care source', async t => {
  const f = fixture(t); await load(f); const originalSources = clone(f.state.workspace.sources);
  f.state.confirm = () => false; await f.click(selector('job-cancel')); assert.equal(f.writes().length, 0);
  f.state.confirm = () => true; await f.click(selector('job-cancel'));
  assert.equal(f.writes().length, 1); const call = f.writes()[0]; assert.equal(call.name, 'resolve_care_reminder_job');
  assert.deepEqual({ ...call.args, p_request_id: null }, { p_request_id: null, p_id: id(40), p_version: 3, p_resolution: 'cancel_no_resend' });
  assert.deepEqual(f.state.workspace.sources, originalSources);
  assert.match(f.confirms.join(' '), /no.*resend|not.*resend|without.*resend/i);
  assert.match(f.host.textContent, /does not.*complet|doesn.t.*complet|care.*unchanged|source.*unchanged/i);
  assert.equal(f.calls.some(c => /enqueue|claim|finish_care|complete.*task|record.*visit/.test(c.name)), false);
});

test('accepted or sending jobs cannot be cancelled and pausing settings does not claim to withdraw mail', async t => {
  const f = fixture(t, workspace(), jobs({ total: 2, items: [job({ status: 'accepted', can_resolve: false, hold_active: false }),
    job({ id: id(41), status: 'sending', can_resolve: false, hold_active: false })],
    countsByStatus: { queued: 0, sending: 1, accepted: 1, failed: 0, uncertain: 0, cancelled: 0 } }));
  f.state.workspace.settings.enabled = true; f.state.workspace.readiness.enabled = true;
  await load(f);
  f.change(selector('job-filter'), 'all'); await flush();
  for (const control of f.host.querySelectorAll(selector('job-cancel'))) assert.equal(control.disabled, true);
  enable(f, false); await f.click(selector('settings-save'));
  assert.equal(f.writes()[0].args.p_enabled, false);
  assert.match(f.host.textContent, /already.*accepted|accepted.*already|already.*sending|already.*sent/i);
  assert.equal(f.writes().some(c => c.name === 'resolve_care_reminder_job'), false);
});

test('server labels are escaped and private extra fields never enter DOM, summaries or mutations', async t => {
  const dangerous = '<img src=x onerror="window.bad=1"><a href="https://evil.invalid">label</a>';
  const value = workspace(); value.sources[0].label = dangerous; value.sources[0].notes = 'PRIVATE_CANARY';
  value.eligible_staff[0].label = dangerous; value.settings.private_token = 'PRIVATE_CANARY';
  const queue = jobs(); queue.items[0].provider_id = 'PRIVATE_CANARY'; queue.items[0].source_refs = [{ notes: 'PRIVATE_CANARY' }];
  const f = fixture(t, value, queue); await load(f); await openCare(f);
  assert.equal(f.host.querySelector('img,iframe,a[href="https://evil.invalid"]'), null); assert.equal(f.w.bad, undefined);
  assert.match(f.host.textContent, /<img/); assert.doesNotMatch(f.host.textContent, /PRIVATE_CANARY/);
  assert.doesNotMatch(JSON.stringify(f.summaries), /PRIVATE_CANARY/);
  changeOwner(f); await f.click(selector('binding-save'));
  assert.doesNotMatch(JSON.stringify(f.writes()), /PRIVATE_CANARY|onerror|evil.invalid/);
});

test('missing bound care source remains visible for review without enabling stale writes', async t => {
  const value = workspace(); value.sources[0] = sourceRow({ source_version: null, contact_id: null,
    care_role: null, owner_label: null, one_time: null, active: false, label: 'Missing care source' });
  value.readiness.counts.missing_sources = 1; value.readiness.counts.open_sources = 0;
  const f = fixture(t, value); await load(f);
  assert.match(f.host.textContent, /Missing care source/); await openCare(f);
  assert.equal(f.query(selector('binding-save')).disabled, true);
  await f.click(selector('binding-save')); assert.equal(f.writes().length, 0);
});

test('UUID-shaped arrays and duplicate eligible IDs cannot pass the private snapshot boundary', async t => {
  const arrayOwner = workspace(); arrayOwner.sources[0].assigned_staff_user_id = [id(2)];
  const arrayRecipient = workspace(); arrayRecipient.settings.pastor_user_ids = [[id(1)]];
  const duplicate = workspace(); duplicate.eligible_staff.push(clone(duplicate.eligible_staff[0]));
  for (const value of [arrayOwner, arrayRecipient, duplicate]) {
    const f = fixture(t, value); assert.equal(await f.api.load(1), false);
    assert.equal(f.writes().length, 0); assert.equal(f.summaries.at(-1), null);
    assert.doesNotMatch(f.host.textContent, /Fictional Care Person/);
  }
});

test('guest binding retains actual task owner and current lifecycle without silently restarting a cycle', async t => {
  const f = fixture(t); await load(f);
  await f.click(`[data-reminder-source-open][value="guest_task:${id(11)}"]`);
  assert.equal(f.query(selector('owner')).value, id(2)); assert.equal(f.query(selector('owner')).disabled, true);
  assert.equal(f.query(selector('restart')).checked, false);
  f.change(selector('source-enabled'), true); await f.click(selector('binding-save'));
  assert.equal(f.writes().length, 1);
  const args = f.writes()[0].args;
  assert.equal(args.p_source_type, 'guest_task'); assert.equal(args.p_source_id, id(11));
  assert.equal(args.p_version, 0); assert.equal(args.p_source_version, 7); assert.equal(args.p_lifecycle_version, 2);
  assert.equal(args.p_owner_user_id, id(2)); assert.equal(args.p_restart_cycle, false); assert.equal(args.p_linked_guest_task_id, null);
});

test('a mismatched successful settings receipt remains unresolved instead of certifying different settings', async t => {
  const f = fixture(t); await load(f); enable(f);
  f.state.rpc = (name, args, normal) => name === 'set_care_reminder_settings'
    ? f.ok({ version: args.p_version + 1, enabled: false, pastor_user_ids: [] }) : normal(name, args);
  await f.click(selector('settings-save'));
  assert.equal(f.writes().length, 1); assert.equal(f.query(selector('enabled')).checked, true);
  assert.equal(f.query(selector('enabled')).disabled, true); assert.equal(f.query(selector('retry')).disabled, false);
  assert.equal(f.unload(), true);
});

test('unknown held-job resolution requires identical explicit retry and never enables a resend action', async t => {
  const f = fixture(t); await load(f); let first = true;
  f.state.rpc = (name, args, normal) => name === 'resolve_care_reminder_job' && first
    ? (first = false, Promise.reject(Error('PRIVATE_CANARY'))) : normal(name, args);
  await f.click(selector('job-cancel')); const frozen = clone(f.writes()[0].args);
  await f.click(selector('settings-check')); assert.equal(f.writes().length, 1);
  assert.equal(f.query(selector('settings-save')).disabled, true); assert.equal(f.unload(), true);
  await f.click(selector('retry'));
  assert.deepEqual(f.writes()[1], { name: 'resolve_care_reminder_job', args: frozen });
  assert.equal(frozen.p_resolution, 'cancel_no_resend'); assert.equal(f.unload(), false);
  assert.doesNotMatch(f.host.textContent, /PRIVATE_CANARY/);
});

test('identity change during cancellation confirmation cannot write or expose the old private row', async t => {
  const f = fixture(t); await load(f);
  f.state.confirm = () => {
    f.setContext({ ...f.context(), epoch: 2, userId: id(3), role: 'viewer', canEdit: false, workspaceReady: false });
    return true;
  };
  await f.click(selector('job-cancel'));
  assert.equal(f.writes().length, 0); assert.equal(f.host.textContent, ''); assert.equal(f.unload(), false);
});

test('identity changes inside discard dialogs clear the old source even when the dialog is cancelled', async t => {
  for (const action of ['switch-source', 'use-current']) for (const answer of [false, true]) {
    const f = fixture(t); await load(f); await openCare(f); changeOwner(f);
    if (action === 'use-current') { f.state.workspace.sources[0].source_version++; await f.api.load(1); }
    f.state.confirm = () => {
      f.setContext({ ...f.context(), epoch: 2, userId: id(3), role: 'viewer', canEdit: false, workspaceReady: false });
      return answer;
    };
    await f.click(action === 'use-current' ? selector('use-current') : `[data-reminder-source-open][value="guest_task:${id(11)}"]`);
    assert.equal(f.writes().length, 0);
    assert.equal(f.host.textContent, '', action + ', confirm=' + answer);
    assert.equal(f.unload(), false);
  }
});

test('read deadline fails closed and a late original response cannot replace a fresh same-session snapshot', async t => {
  const f = fixture(t); const pending = deferred();
  f.state.rpc = (name, args, normal) => name === 'get_care_reminder_workspace' ? pending.promise : normal(name, args);
  const loading = f.api.load(1); await flush(); await f.timeout();
  assert.equal(await loading, false); assert.equal(f.summaries.at(-1), null);
  f.state.rpc = null; f.state.workspace.sources[0].label = 'Fresh source after timeout'; await load(f);
  pending.resolve(f.ok(workspace())); await flush();
  assert.match(f.host.textContent, /Fresh source after timeout/); assert.doesNotMatch(f.host.textContent, /Fictional Care Person/);
});

test('unbound care never guesses a staff account from the display name', async t => {
  const value = workspace(); value.settings.bindings = [];
  value.sources[0].assigned_staff_user_id = null; value.sources[0].owner_label = 'deacon@example.invalid';
  value.readiness.counts = counts({ bindings: 0, enabled_bindings: 0, unbound_care: 1, open_sources: 0 });
  const f = fixture(t, value); await load(f); await openCare(f);
  assert.equal(f.query(selector('owner')).value, ''); assert.equal(f.query(selector('source-enabled')).checked, false);
  assert.equal(f.query(selector('restart')).checked, false); assert.equal(f.writes().length, 0);
});

test('welcome dedup links require explicit same-person selection and preserve unrelated dirty settings', async t => {
  const value = workspace(); value.sources[0].one_time = true; value.sources[0].care_role = 'welcome';
  value.sources.push(sourceRow({ source_type: 'guest_task', source_id: id(12), source_version: 1,
    lifecycle_version: 1, contact_id: id(20), label: 'Same fictional person guest task', care_role: 'welcome',
    assigned_staff_user_id: id(2), one_time: true }));
  const f = fixture(t, value); await load(f); enable(f); await openCare(f);
  const link = f.query(selector('linked-guest'));
  assert.ok(link); assert.equal(link.value, '');
  assert.equal([...link.options].some(option => option.value === id(11)), false);
  assert.equal([...link.options].some(option => option.value === id(12)), true);
  f.change(selector('linked-guest'), id(12)); await f.click(selector('binding-save'));
  assert.equal(f.writes().length, 1); assert.equal(f.writes()[0].args.p_linked_guest_task_id, id(12));
  assert.equal(f.writes()[0].args.p_restart_cycle, false);
  assert.equal(f.state.workspace.settings.enabled, false);
  assert.equal(f.query(selector('enabled')).checked, true); assert.equal(f.unload(), true);
});
