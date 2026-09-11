import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../weekly-email.js', import.meta.url), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const WEEK = '2026-09-07', NOW = '2026-09-11T15:00:00Z';
const announcement = (n = 1, version = 1) => ({ id: id(n), version, title: 'Fictional announcement ' + n, body: 'Saved announcement text ' + version + '\nSecond line.', starts_on: WEEK, ends_on: '2026-09-13' });
const summary = (n = 20, version = 1) => ({ id: id(n), version, subject: 'Shared message ' + n, status: 'draft', updated_at: NOW });
const workspace = (extra = {}) => ({ version: 1, week_start: WEEK, generated_at: NOW, drafts: [], announcements: [announcement()], audience: { total: 12, requested: 7, held: 2, not_requested: 3 }, ...extra });
const draft = (n = 20, extra = {}) => ({ version: 1, draft: { id: id(n), version: 1, week_start: WEEK, subject: 'Shared message ' + n, intro: 'A saved opening.', closing: 'A saved closing.', sources: [announcement()], status: 'draft', reviewed_at: null, updated_at: NOW, content_hash: 'a'.repeat(64), ...extra }, sources_current: true, review_current: false, sending_enabled: false });
const wait = () => new Promise(resolve => setImmediate(resolve));
async function flush() { await wait(); await wait(); }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

function fixture(t, initial = workspace(), now = NOW) {
  const dom = new JSDOM('<section id="weekly-email-view"></section>', { url: 'https://office.example.invalid/admin/', runScripts: 'outside-only' });
  const w = dom.window, host = w.document.querySelector('section'); t.after(() => w.close());
  const ActualDate = w.Date;
  w.Date = class extends ActualDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return ActualDate.parse(now); } };
  let context = { epoch: 1, userId: 'fictional-admin', role: 'admin', canEdit: true, workspaceReady: true };
  const state = { workspace: clone(initial), details: new Map(), receipts: new Map(), rpc: null, ensure: async () => true, confirms: [], confirm: () => true };
  const calls = [], timers = new Map(); let timerId = 0;
  w.setTimeout = callback => { timers.set(++timerId, callback); return timerId; }; w.clearTimeout = key => timers.delete(key);
  w.confirm = text => { state.confirms.push(text); return state.confirm(); };
  for (const key of ['localStorage', 'sessionStorage']) Object.defineProperty(w, key, { get() { throw Error('Persistent browser storage is forbidden'); } });
  w.HTMLAnchorElement.prototype.click = () => { throw Error('No downloads or navigation'); };
  const ok = data => ({ data: clone(data), error: null });
  function updateSummary(saved) {
    const list = state.workspace.drafts.filter(d => d.id !== saved.draft.id);
    list.push({ id: saved.draft.id, version: saved.draft.version, subject: saved.draft.subject, status: saved.draft.status, updated_at: NOW });
    state.workspace.drafts = list;
  }
  function normal(name, args) {
    if (name === 'get_weekly_email_workspace') return ok({ ...state.workspace, week_start: args.p_week_start });
    if (name === 'get_weekly_email_draft') return state.details.has(args.p_id) ? ok(state.details.get(args.p_id)) : { error: { code: 'P0002', message: 'WEEKLY_EMAIL_NOT_FOUND' } };
    if (name === 'save_weekly_email_draft') {
      if (state.receipts.has(args.p_request_id)) return ok(state.receipts.get(args.p_request_id));
      const body = args.p_draft, detail = draft(20, { id: args.p_id, version: args.p_expected_version + 1, week_start: body.week_start, subject: body.subject, intro: body.intro, closing: body.closing, sources: body.announcement_refs.map(ref => clone(state.workspace.announcements.find(a => a.id === ref.id && a.version === ref.version))) });
      state.details.set(args.p_id, detail); updateSummary(detail);
      const receipt = { id: args.p_id, version: detail.draft.version, status: 'draft' }; state.receipts.set(args.p_request_id, receipt); return ok(receipt);
    }
    if (name === 'review_weekly_email_draft') {
      if (state.receipts.has(args.p_request_id)) return ok(state.receipts.get(args.p_request_id));
      const detail = state.details.get(args.p_id); detail.draft.version++; detail.draft.status = 'reviewed'; detail.draft.reviewed_at = NOW; detail.review_current = true; updateSummary(detail);
      const receipt = { id: args.p_id, version: detail.draft.version, status: 'reviewed' }; state.receipts.set(args.p_request_id, receipt); return ok(receipt);
    }
    throw Error('Unexpected RPC');
  }
  w.eval(source);
  const api = w.CreekWeeklyEmail.create({ root: host, db: { rpc: async (name, args) => { calls.push({ name, args: clone(args) }); return state.rpc ? state.rpc(name, args, normal) : normal(name, args); } }, getContext: () => context, isCurrent: e => e === context.epoch, ensureReady: e => state.ensure(e) });
  const query = selector => host.querySelector(selector);
  const input = (name, value) => { const node = query(`[data-weekly-field="${name}"]`); node.value = value; node.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const click = async selector => { const node = query(selector); assert.ok(node, 'button exists: ' + selector); node.click(); await flush(); };
  const checkbox = (selector, checked) => { const node = query(selector); node.checked = checked; node.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const unload = () => { const event = new w.Event('beforeunload', { cancelable: true }); w.dispatchEvent(event); return event.defaultPrevented; };
  return { w, host, api, calls, state, query, input, click, checkbox, unload, normal, ok, context: () => context, setContext: value => context = value, timeout: async () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); await flush(); }, writes: () => calls.filter(c => ['save_weekly_email_draft', 'review_weekly_email_draft'].includes(c.name)) };
}
async function newMessage(f) { assert.equal(await f.api.load(1), true); await f.click('[data-weekly-new]'); f.input('subject', 'This week at the Creek'); f.input('intro', 'A fictional opening.'); f.input('closing', 'See you Sunday.'); }
async function openExisting(f, value = draft()) { f.state.workspace.drafts = [summary(20, value.draft.version)]; f.state.details.set(value.draft.id, value); await f.api.load(1); await f.click('[data-weekly-open]'); }

test('current Central Monday loads complete saved choices and truthful count-only audience', async t => {
  const f = fixture(t); assert.equal(await f.api.load(1), true);
  assert.deepEqual(f.calls[0], { name: 'get_weekly_email_workspace', args: { p_week_start: WEEK } });
  assert.equal(f.query('[data-weekly-week]').value, WEEK); assert.match(f.host.textContent, /7Requested weekly updates/); assert.match(f.host.textContent, /2Held for review/); assert.match(f.host.textContent, /3No current request/);
  assert.equal(f.host.querySelector('a[download]'), null); assert.equal([...f.host.querySelectorAll('button')].some(b => /^Send|Download/.test(b.textContent)), false);
});

test('missing RPC, overflow and incomplete workspace never masquerade as an empty ready audience', async t => {
  for (const response of [{ error: { code: 'PGRST202', message: 'PRIVATE_CANARY' } }, { error: { code: '54000', message: 'PRIVATE_CANARY' } }, { data: workspace({ audience: { total: 12, requested: 7, held: 2, not_requested: 2 } }) }, { data: workspace({ announcements: [announcement(), announcement()] }) }, { data: workspace({ drafts: Array.from({ length: 21 }, (_, i) => summary(20 + i)) }) }, { data: workspace({ announcements: [{ ...announcement(), starts_on: '2026-02-30' }] }) }]) {
    const f = fixture(t); await f.api.load(1); f.state.rpc = () => response;
    assert.equal(await f.api.load(1), false); assert.match(f.host.textContent, /counts are unavailable/); assert.equal(f.query('[data-weekly-new]').disabled, true); assert.doesNotMatch(f.host.textContent, /PRIVATE_CANARY/);
  }
});

test('text inputs keep focus and draft values while update preview, and revert removes reload warning', async t => {
  const f = fixture(t); await f.api.load(1); await f.click('[data-weekly-new]'); assert.equal(f.unload(), false);
  const field = f.query('[data-weekly-field="subject"]'); field.focus(); f.input('subject', 'Fictional draft');
  assert.equal(f.query('[data-weekly-field="subject"]'), field); assert.equal(f.w.document.activeElement, field); assert.equal(f.unload(), true); assert.match(f.query('[data-weekly-composition]').textContent, /Fictional draft/);
  f.input('subject', ''); assert.equal(f.unload(), false);
});

test('only explicit selected source references enter save and saved snapshot preview is separate', async t => {
  const f = fixture(t, workspace({ announcements: [announcement(), announcement(2)] })); await newMessage(f);
  f.checkbox(`[data-weekly-source="${id(1)}"]`, true); await f.click('[data-weekly-save]');
  assert.equal(f.writes().length, 1); const body = f.writes()[0].args;
  assert.equal(body.p_expected_version, 0); assert.match(body.p_request_id, /^[0-9a-f-]{36}$/); assert.deepEqual(Object.keys(body.p_draft).sort(), ['announcement_refs', 'closing', 'intro', 'subject', 'week_start']);
  assert.deepEqual(body.p_draft.announcement_refs, [{ id: id(1), version: 1 }]); assert.doesNotMatch(JSON.stringify(body), /Saved announcement text/);
  assert.match(f.query('[data-weekly-saved-preview]').textContent, /Saved in Office · version 1/); assert.match(f.query('[data-weekly-saved-preview]').textContent, /Saved announcement text 1/); assert.equal(f.unload(), false);
});

test('admin review requires saved unchanged content, explicit acknowledgement, and exact version/hash', async t => {
  const f = fixture(t); await openExisting(f); assert.equal(f.query('[data-weekly-review]').disabled, true);
  f.checkbox('[data-weekly-ack]', true); assert.equal(f.query('[data-weekly-review]').disabled, false); f.input('intro', 'Changed draft'); assert.equal(f.query('[data-weekly-review]').disabled, true);
  f.input('intro', 'A saved opening.'); f.checkbox('[data-weekly-ack]', true); await f.click('[data-weekly-review]');
  const call = f.writes()[0]; assert.equal(call.name, 'review_weekly_email_draft'); assert.equal(call.args.p_expected_version, 1); assert.equal(call.args.p_content_hash, 'a'.repeat(64)); assert.deepEqual(Object.keys(call.args).sort(), ['p_content_hash', 'p_expected_version', 'p_id', 'p_request_id']);
  assert.match(f.query('[data-weekly-review-state]').textContent, /content reviewed/i); assert.equal(f.query('[data-weekly-review]').disabled, true); assert.equal(f.unload(), false);
});

test('editor can save content but cannot invoke the admin-only review', async t => {
  const f = fixture(t); f.setContext({ ...f.context(), role: 'editor' }); await openExisting(f);
  assert.equal(f.query('[data-weekly-review]').hidden, true); assert.equal(f.query('[data-weekly-review]').disabled, true); f.checkbox('[data-weekly-ack]', true); await f.click('[data-weekly-review]'); assert.equal(f.writes().length, 0);
  f.input('intro', 'Editor revised the wording.'); await f.click('[data-weekly-save]'); assert.equal(f.writes()[0].name, 'save_weekly_email_draft');
});

test('refresh preserves selected old bytes and requires explicit adoption of a newer announcement', async t => {
  const f = fixture(t); await newMessage(f); f.checkbox('[data-weekly-source]', true);
  f.state.workspace.announcements = [announcement(1, 2)]; await f.api.load(1);
  assert.match(f.query('[data-weekly-composition]').textContent, /Saved announcement text 1/); assert.doesNotMatch(f.query('[data-weekly-composition]').textContent, /Saved announcement text 2/); assert.match(f.host.textContent, /changed after selection/);
  await f.click('[data-weekly-save]'); assert.equal(f.writes().length, 0);
  await f.click('[data-weekly-use-source]'); assert.match(f.query('[data-weekly-composition]').textContent, /Saved announcement text 2/); await f.click('[data-weekly-save]'); assert.equal(f.writes()[0].args.p_draft.announcement_refs[0].version, 2);
});

test('list review status does not certify freshness; detail can show changed reviewed sources', async t => {
  const f = fixture(t); const stale = draft(20, { status: 'reviewed', reviewed_at: NOW }); stale.sources_current = false; stale.review_current = false;
  f.state.workspace.drafts = [{ ...summary(), status: 'reviewed' }]; f.state.details.set(id(20), stale); await f.api.load(1);
  assert.match(f.query('[data-weekly-drafts]').textContent, /open to check freshness/); await f.click('[data-weekly-open]');
  assert.match(f.query('[data-weekly-review-state]').textContent, /Review needs attention/); assert.match(f.query('[data-weekly-saved-preview]').textContent, /Saved announcement text 1/); assert.equal(f.query('[data-weekly-review]').disabled, true);
});

test('timed-out save stays frozen through absent reads; exact retry can finish before the old transport', async t => {
  const f = fixture(t); await newMessage(f); const pending = deferred(); let first = true;
  f.state.rpc = (name, args, normal) => name === 'save_weekly_email_draft' && first ? (first = false, pending.promise) : normal(name, args);
  await f.click('[data-weekly-save]'); assert.equal(f.writes().length, 1); await f.timeout();
  const frozen = clone(f.writes()[0].args); assert.equal(f.query('[data-weekly-retry]').disabled, false); assert.equal(f.query('[data-weekly-new]').disabled, true); assert.equal(f.unload(), true);
  await f.click('[data-weekly-check]'); assert.match(f.host.textContent, /No saved draft was found/); assert.equal(f.query('[data-weekly-retry]').disabled, false); assert.equal(f.writes().length, 1);
  await f.click('[data-weekly-retry]'); assert.equal(f.writes().length, 2); assert.deepEqual(f.writes()[1].args, frozen); assert.equal(f.unload(), false); assert.match(f.query('[data-weekly-saved-preview]').textContent, /version 1/);
  f.input('intro', 'A new working edit after the confirmed receipt.'); pending.resolve(f.normal('save_weekly_email_draft', frozen)); await flush();
  assert.equal(f.query('[data-weekly-field="intro"]').value, 'A new working edit after the confirmed receipt.'); assert.equal(f.writes().length, 2); assert.equal(f.unload(), true);
});

test('fresh later detail is shown separately and cannot settle an ambiguous prior request', async t => {
  const f = fixture(t); await newMessage(f); f.state.rpc = (name, args, normal) => name === 'save_weekly_email_draft' ? Promise.reject(Error('PRIVATE_CANARY')) : normal(name, args);
  await f.click('[data-weekly-save]'); const attempt = f.writes()[0].args;
  f.state.details.set(attempt.p_id, draft(20, { id: attempt.p_id, version: 4, subject: 'Another saved version' }));
  await f.click('[data-weekly-check]'); assert.match(f.query('[data-weekly-saved-preview]').textContent, /Another saved version/); assert.equal(f.query('[data-weekly-field="subject"]').value, 'This week at the Creek'); assert.match(f.host.textContent, /does not settle the earlier request/); assert.equal(f.query('[data-weekly-new]').disabled, true); assert.equal(f.unload(), true); assert.doesNotMatch(f.host.textContent, /PRIVATE_CANARY/);
});

test('definitive version conflict retains edits until current saved draft is explicitly loaded', async t => {
  const f = fixture(t); await openExisting(f); f.input('intro', 'Keep this unfinished wording.');
  f.state.details.set(id(20), draft(20, { version: 2, intro: 'Other staff saved this.' })); f.state.rpc = (name, args, normal) => name === 'save_weekly_email_draft' ? { error: { code: '40001', message: 'WEEKLY_EMAIL_VERSION_CONFLICT' } } : normal(name, args);
  await f.click('[data-weekly-save]'); assert.equal(f.query('[data-weekly-field="intro"]').value, 'Keep this unfinished wording.'); assert.equal(f.query('[data-weekly-save]').disabled, true); assert.match(f.host.textContent, /earlier request may already have succeeded/);
  await f.click('[data-weekly-check]'); assert.equal(f.query('[data-weekly-field="intro"]').value, 'Keep this unfinished wording.'); f.state.confirm = () => false; await f.click('[data-weekly-reload]'); assert.equal(f.query('[data-weekly-field="intro"]').value, 'Keep this unfinished wording.');
  f.state.confirm = () => true; await f.click('[data-weekly-reload]'); assert.equal(f.query('[data-weekly-field="intro"]').value, 'Other staff saved this.'); assert.equal(f.query('[data-weekly-save]').disabled, false); assert.equal(f.unload(), false);
});

test('new-source conflict is recoverable by refresh and explicit reselection without losing wording', async t => {
  const f = fixture(t); await newMessage(f); f.checkbox('[data-weekly-source]', true); let conflict = true;
  f.state.rpc = (name, args, normal) => name === 'save_weekly_email_draft' && conflict ? (conflict = false, { error: { code: '40001', message: 'WEEKLY_EMAIL_SOURCE_CHANGED' } }) : normal(name, args);
  await f.click('[data-weekly-save]'); f.state.workspace.announcements = [announcement(1, 2)]; await f.api.load(1); await f.click('[data-weekly-use-source]'); await f.click('[data-weekly-save]');
  assert.equal(f.writes().length, 2); assert.notEqual(f.writes()[0].args.p_request_id, f.writes()[1].args.p_request_id); assert.equal(f.writes()[1].args.p_draft.intro, 'A fictional opening.'); assert.equal(f.writes()[1].args.p_draft.announcement_refs[0].version, 2);
});

test('ordinary workspace refresh preserves dirty draft; missing feature never fabricates a save', async t => {
  const f = fixture(t); await newMessage(f); f.state.rpc = () => ({ error: { code: 'PGRST202', message: 'PRIVATE_CANARY' } });
  assert.equal(await f.api.load(1), false); assert.equal(f.query('[data-weekly-field="intro"]').value, 'A fictional opening.'); assert.equal(f.query('[data-weekly-save]').disabled, true); assert.equal(f.unload(), true); assert.doesNotMatch(f.host.textContent, /PRIVATE_CANARY/);
});

test('read-only deadline suppresses old workspace and draft responses', async t => {
  const f = fixture(t); const old = deferred(); f.state.rpc = () => old.promise; const loading = f.api.load(1); await flush(); await f.timeout(); assert.equal(await loading, false); assert.match(f.host.textContent, /counts are unavailable/);
  f.state.rpc = null; await f.api.load(1); old.resolve(f.ok(workspace({ audience: { total: 99, requested: 99, held: 0, not_requested: 0 } }))); await flush(); assert.doesNotMatch(f.host.textContent, /99/);
  f.state.workspace.drafts = [summary()]; await f.api.load(1); const detailRead = deferred(); f.state.rpc = (name, args, normal) => name === 'get_weekly_email_draft' ? detailRead.promise : normal(name, args); await f.click('[data-weekly-open]'); await f.timeout(); detailRead.resolve(f.ok(draft())); await flush(); assert.equal(f.query('[data-weekly-field]'), null);
});

test('failed readiness causes no RPC write and preserves the working copy', async t => {
  const f = fixture(t); await newMessage(f); f.state.ensure = async () => false; await f.click('[data-weekly-save]');
  assert.equal(f.writes().length, 0); assert.equal(f.query('[data-weekly-field="subject"]').value, 'This week at the Creek'); assert.equal(f.query('[data-weekly-retry]').hidden, true); assert.equal(f.unload(), true);
});

test('pause hides private text but retains same-session draft and warning; load safely resumes it', async t => {
  const f = fixture(t); await newMessage(f); f.setContext({ ...f.context(), workspaceReady: false, canEdit: false }); f.api.pause();
  assert.equal(f.host.textContent, ''); assert.equal(f.unload(), true); const before = f.calls.length; assert.equal(await f.api.load(1), false); assert.equal(f.calls.length, before);
  f.setContext({ ...f.context(), workspaceReady: true, canEdit: true }); await f.api.load(1); assert.equal(f.query('[data-weekly-field="subject"]').value, 'This week at the Creek'); assert.equal(f.unload(), true);
});

test('paused unresolved save ignores late receipt and needs explicit same request after resume', async t => {
  const f = fixture(t); await newMessage(f); const pending = deferred(); let first = true; f.state.rpc = (name, args, normal) => name === 'save_weekly_email_draft' && first ? (first = false, pending.promise) : normal(name, args);
  await f.click('[data-weekly-save]'); const frozen = f.writes()[0].args; f.setContext({ ...f.context(), workspaceReady: false, canEdit: false }); f.api.pause();
  pending.resolve(f.normal('save_weekly_email_draft', frozen)); await flush(); assert.equal(f.host.textContent, ''); assert.equal(f.unload(), true);
  f.setContext({ ...f.context(), workspaceReady: true, canEdit: true }); await f.api.load(1); assert.equal(f.query('[data-weekly-retry]').disabled, false); assert.equal(f.writes().length, 1); await f.click('[data-weekly-retry]'); assert.deepEqual(f.writes()[1].args, frozen); assert.equal(f.unload(), false);
});

test('owner, epoch, role and signout changes clear RAM, DOM and warning before readiness handling', async t => {
  for (const change of [{ userId: 'other-owner', epoch: 2 }, { epoch: 2 }, { role: 'editor' }, { role: 'viewer' }, { userId: null }]) {
    const f = fixture(t); await newMessage(f); f.setContext({ ...f.context(), ...change, workspaceReady: false, canEdit: false }); f.api.render(); assert.equal(f.host.textContent, ''); assert.equal(f.unload(), false);
    f.setContext({ ...f.context(), userId: 'new-session', role: 'admin', workspaceReady: true, canEdit: true }); await f.api.load(f.context().epoch); assert.equal(f.query('[data-weekly-field]'), null);
  }
});

test('old read/write callbacks cannot replace a new identity or restore cleared text', async t => {
  const f = fixture(t); await newMessage(f); const pending = deferred(); f.state.rpc = (name, args, normal) => name === 'save_weekly_email_draft' ? pending.promise : normal(name, args); await f.click('[data-weekly-save]'); const frozen = f.writes()[0].args;
  f.setContext({ ...f.context(), epoch: 2, userId: 'new-owner' }); f.api.clear(); f.state.rpc = null; await f.api.load(2); pending.resolve({ data: { id: frozen.p_id, version: 1, status: 'draft' } }); await flush(); assert.equal(f.query('[data-weekly-field]'), null); assert.equal(f.unload(), false); assert.doesNotMatch(f.host.textContent, /This week at the Creek/);
});

test('cancelled discard and identity change inside confirmation never navigate or reuse old source rows', async t => {
  const f = fixture(t); await newMessage(f); f.state.confirm = () => false; await f.click('[data-weekly-new]'); assert.equal(f.query('[data-weekly-field="subject"]').value, 'This week at the Creek');
  f.state.confirm = () => { f.setContext({ ...f.context(), epoch: 2, userId: 'replacement', canEdit: false, workspaceReady: false }); return true; }; const calls = f.calls.length; await f.click('[data-weekly-new]'); assert.equal(f.calls.length, calls); assert.equal(f.host.textContent, ''); assert.equal(f.unload(), false);
});

test('all preview content is escaped plain text and extra private server fields are discarded', async t => {
  const dangerous = '<img src=x onerror="window.bad=1"><a href="https://evil.invalid">link</a>', f = fixture(t, workspace({ announcements: [{ ...announcement(), title: dangerous, body: dangerous, phone: 'PRIVATE_CANARY' }], audience: { total: 0, requested: 0, held: 0, not_requested: 0, emails: ['PRIVATE_CANARY'] } })); await newMessage(f); f.input('intro', dangerous); f.checkbox('[data-weekly-source]', true);
  assert.equal(f.host.querySelector('img,iframe,a'), null); assert.match(f.query('[data-weekly-composition]').textContent, /<img/); assert.doesNotMatch(f.host.textContent, /PRIVATE_CANARY/); assert.equal(f.w.bad, undefined); await f.click('[data-weekly-save]'); assert.equal(f.host.querySelector('img,iframe,a'), null);
});

test('current workspace renders its complete allowed draft list and rejects partial detail', async t => {
  const f = fixture(t, workspace({ drafts: Array.from({ length: 20 }, (_, i) => summary(20 + i)), announcements: Array.from({ length: 200 }, (_, i) => announcement(1 + i)) })); await f.api.load(1); assert.equal(f.host.querySelectorAll('[data-weekly-open]').length, 20);
  f.state.details.set(id(20), { ...draft(), sending_enabled: true }); await f.click('[data-weekly-open]'); assert.equal(f.query('[data-weekly-field]'), null); assert.match(f.host.textContent, /could not be confirmed/);
});

test('busy mutation blocks double-click, source changes, new drafts and automatic workspace refresh', async t => {
  const f = fixture(t); await newMessage(f); const pending = deferred(); f.state.rpc = (name, args, normal) => name === 'save_weekly_email_draft' ? pending.promise : normal(name, args); await f.click('[data-weekly-save]'); await f.click('[data-weekly-save]'); await f.click('[data-weekly-new]'); assert.equal(await f.api.load(1), false);
  assert.equal(f.writes().length, 1); assert.equal(f.query('[data-weekly-field="intro"]').disabled, true); assert.equal(f.unload(), true); f.api.clear(); pending.resolve({ error: { code: '22023', message: 'PRIVATE_CANARY' } }); await flush(); assert.equal(f.host.textContent, ''); assert.equal(f.unload(), false);
});

test('uncertain review retains the original review request and hash, with no automatic second write', async t => {
  const f = fixture(t); await openExisting(f); const pending = deferred(); let first = true; f.state.rpc = (name, args, normal) => name === 'review_weekly_email_draft' && first ? (first = false, pending.promise) : normal(name, args); f.checkbox('[data-weekly-ack]', true); await f.click('[data-weekly-review]'); const frozen = f.writes()[0].args; await f.timeout(); pending.resolve(f.normal('review_weekly_email_draft', frozen)); await flush();
  assert.equal(f.writes().length, 1); assert.equal(f.query('[data-weekly-review]').disabled, true); await f.click('[data-weekly-retry]'); assert.equal(f.writes()[1].name, 'review_weekly_email_draft'); assert.deepEqual(f.writes()[1].args, frozen); assert.match(f.query('[data-weekly-review-state]').textContent, /content reviewed/i);
});

test('Central Sunday does not become the next drafting week at UTC midnight', async t => {
  for (const [now, expected] of [['2026-09-14T04:59:00Z', '2026-09-07'], ['2026-09-14T05:00:00Z', '2026-09-14'], ['2026-11-02T05:59:00Z', '2026-10-26'], ['2026-11-02T06:00:00Z', '2026-11-02']]) {
    const f = fixture(t, workspace({ announcements: [] }), now); assert.equal(await f.api.load(1), true); assert.equal(f.calls[0].args.p_week_start, expected);
  }
});

test('failed explicit detail check preserves saved bytes but removes review freshness and acknowledgement', async t => {
  const f = fixture(t); await openExisting(f); f.checkbox('[data-weekly-ack]', true); assert.equal(f.query('[data-weekly-review]').disabled, false);
  f.state.rpc = (name, args, normal) => name === 'get_weekly_email_draft' ? { error: { code: 'PRIVATE_CANARY' } } : normal(name, args); await f.click('[data-weekly-check]');
  assert.match(f.query('[data-weekly-saved-preview]').textContent, /Last confirmed saved snapshot/); assert.match(f.query('[data-weekly-saved-preview]').textContent, /A saved opening/); assert.match(f.query('[data-weekly-review-state]').textContent, /fresh check/); assert.equal(f.query('[data-weekly-ack]').checked, false); assert.equal(f.query('[data-weekly-review]').disabled, true); assert.doesNotMatch(f.host.textContent, /PRIVATE_CANARY/);
});

test('workspace refresh rechecks effective review freshness without replacing a dirty selection snapshot', async t => {
  const f = fixture(t), reviewed = draft(20, { status: 'reviewed', reviewed_at: NOW }); reviewed.review_current = true; await openExisting(f, reviewed); assert.match(f.query('[data-weekly-review-state]').textContent, /content reviewed/i);
  f.input('intro', 'Unsaved working words.'); f.state.workspace.announcements = [announcement(1, 2)]; f.state.details.get(id(20)).sources_current = false; f.state.details.get(id(20)).review_current = false;
  const before = f.calls.filter(c => c.name === 'get_weekly_email_draft').length; await f.api.load(1);
  assert.equal(f.calls.filter(c => c.name === 'get_weekly_email_draft').length, before + 1); assert.match(f.query('[data-weekly-review-state]').textContent, /Review needs attention/); assert.equal(f.query('[data-weekly-field="intro"]').value, 'Unsaved working words.'); assert.match(f.query('[data-weekly-composition]').textContent, /Saved announcement text 1/); assert.match(f.query('[data-weekly-saved-preview]').textContent, /Saved announcement text 1/); assert.doesNotMatch(f.query('[data-weekly-saved-preview]').textContent, /Unsaved working words/); assert.equal(f.unload(), true);
});

test('subject-only draft can be saved but cannot be marked content reviewed as an empty email', async t => {
  const f = fixture(t); await f.api.load(1); await f.click('[data-weekly-new]'); f.input('subject', 'A placeholder for next week'); await f.click('[data-weekly-save]');
  assert.equal(f.writes().length, 1); assert.match(f.query('[data-weekly-saved-preview]').textContent, /A placeholder/); assert.equal(f.query('[data-weekly-ack]').disabled, true); assert.equal(f.query('[data-weekly-review]').disabled, true); assert.match(f.query('[data-weekly-review-state]').textContent, /before content review/);
});

test('an externally moved saved draft requires explicit reload before changing the editor week', async t => {
  const f = fixture(t); await openExisting(f); f.input('intro', 'Unsaved original week words.'); f.state.details.set(id(20), draft(20, { version: 2, week_start: '2026-09-14', intro: 'Moved shared message.', sources: [] }));
  await f.click('[data-weekly-check]'); assert.equal(f.query('[data-weekly-week]').value, WEEK); assert.equal(f.query('[data-weekly-field="intro"]').value, 'Unsaved original week words.');
  f.state.workspace.announcements = []; await f.click('[data-weekly-reload]'); assert.equal(f.query('[data-weekly-week]').value, '2026-09-14'); assert.equal(f.query('[data-weekly-field="intro"]').value, 'Moved shared message.'); assert.equal(f.unload(), false);
});

test('a refused identical retry cannot release an earlier pending or transport-unknown save', async t => {
  for (const outcome of ['pending', 'rejected']) for (const error of [{ code: '42501', message: 'STAFF_REQUIRED' }, { code: 'PGRST202', message: 'PRIVATE_CANARY' }]) {
    const f = fixture(t); await newMessage(f); const pending = deferred(); let saves = 0;
    f.state.rpc = (name, args, normal) => {
      if (name !== 'save_weekly_email_draft') return normal(name, args);
      saves++;
      if (saves === 1) return outcome === 'pending' ? pending.promise : Promise.reject(Error('Unknown transport result'));
      if (saves === 2) return { error };
      return normal(name, args);
    };
    await f.click('[data-weekly-save]'); if (outcome === 'pending') await f.timeout(); const frozen = clone(f.writes()[0].args);
    await f.click('[data-weekly-retry]'); assert.equal(f.writes().length, 2); assert.deepEqual(f.writes()[1].args, frozen);
    assert.equal(f.query('[data-weekly-new]').disabled, true); assert.equal(f.query('[data-weekly-retry]').hidden, false); assert.equal(f.query('[data-weekly-retry]').disabled, false); assert.equal(f.query('[data-weekly-field="intro"]').disabled, true); assert.equal(f.unload(), true); assert.match(f.host.textContent, /does not settle the earlier/); assert.doesNotMatch(f.host.textContent, /PRIVATE_CANARY/);
    await f.click('[data-weekly-check]'); assert.equal(f.query('[data-weekly-new]').disabled, true); assert.equal(f.unload(), true);
    if (outcome === 'pending') { pending.resolve(f.normal('save_weekly_email_draft', frozen)); await flush(); assert.equal(f.writes().length, 2); assert.equal(f.query('[data-weekly-new]').disabled, true); }
    await f.click('[data-weekly-retry]'); assert.equal(f.writes().length, 3); assert.deepEqual(f.writes()[2].args, frozen); assert.equal(f.state.details.size, 1); assert.equal(f.query('[data-weekly-retry]').hidden, true); assert.equal(f.unload(), false);
  }
});

test('a fresh single-attempt definitive refusal does not create an unnecessary uncertain request', async t => {
  const f = fixture(t); await newMessage(f); f.state.rpc = (name, args, normal) => name === 'save_weekly_email_draft' ? { error: { code: '42501', message: 'STAFF_REQUIRED' } } : normal(name, args);
  await f.click('[data-weekly-save]'); assert.equal(f.query('[data-weekly-retry]').hidden, true); assert.equal(f.query('[data-weekly-new]').disabled, false); assert.equal(f.query('[data-weekly-field="intro"]').disabled, false); assert.equal(f.unload(), true);
});
