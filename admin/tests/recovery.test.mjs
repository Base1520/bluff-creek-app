import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const html = await readFile(new URL('../recovery.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../recovery.js', import.meta.url), 'utf8');
const config = { supabaseUrl: 'https://testproject.supabase.co', publishableKey: 'sb_publishable_synthetic' };
const user = { id: 'synthetic-staff-a', email: 'staff@example.invalid', email_confirmed_at: '2026-09-01T00:00:00Z' };
const link = type => '#type=' + type + '&token_type=bearer&access_token=synthetic-access&refresh_token=synthetic-refresh';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(check) { const end = performance.now() + 2000; while (!check() && performance.now() < end) await new Promise(r => setTimeout(r, 5)); assert.ok(check(), 'Expected state did not arrive'); }
function fixture(t, options = {}) {
  const dom = new JSDOM(html, { url: options.url || 'https://office.example.invalid/admin/recovery.html' + (options.callback === undefined ? link('recovery') : options.callback), runScripts: 'outside-only' });
  const w = dom.window, calls = []; let listener, inside = false, role = options.role === undefined ? 'editor' : options.role, currentUser = options.user || user, roleDeferred = options.roleDeferred || null, roleError = options.roleError || null;
  const emit = (event, next) => { inside = true; const result = listener(event, next); inside = false; assert.equal(result, undefined); };
  const checked = name => { assert.equal(inside, false, name + ' must stay outside Auth callback'); calls.push(name); };
  const client = { auth: {
    onAuthStateChange(cb) { listener = cb; return { data: { subscription: { unsubscribe() { calls.push('unsubscribe'); } } } }; },
    async setSession(tokens) { checked('setSession'); assert.deepEqual(JSON.parse(JSON.stringify(tokens)), { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' }); if (options.sessionDeferred) return options.sessionDeferred.promise; if (options.badSession) return { error: { message: 'private provider details' } }; emit('SIGNED_IN', { user }); return { data: { session: { user } } }; },
    async getUser() { checked('getUser'); if (options.userDeferred) return options.userDeferred.promise; return { data: { user: currentUser } }; },
    async resetPasswordForEmail(email, params) { checked('request'); calls.push({ email, params }); if (options.requestFailure) throw new Error('private account exists detail'); return { error: options.requestError ? { message: 'private account detail' } : null }; },
    async updateUser(payload) { checked('update'); calls.push({ password: payload.password }); if (options.updateDeferred) return options.updateDeferred.promise; emit('USER_UPDATED', { user: currentUser }); return options.updateError ? { error: { message: 'private backend details' } } : { data: { user: currentUser } }; },
    stopAutoRefresh() { checked('stop'); },
    async signOut() { checked('signOut'); emit('SIGNED_OUT', null); if (options.signOutError) throw new Error('private signout detail'); return { error: null }; }
  }, from(table) { checked('role'); assert.equal(table, 'staff_roles'); const q = { select(column) { assert.equal(column, 'role'); return q; }, eq(column, id) { assert.equal(column, 'user_id'); assert.equal(id, currentUser.id); return q; }, maybeSingle() { if (roleDeferred) return roleDeferred.promise; return Promise.resolve({ data: role ? { role } : null, error: roleError }); } }; return q; } };
  w.CREEK_OFFICE_CONFIG = options.config || config;
  w.supabase = { createClient(url, key, settings) { calls.push('create'); assert.equal(w.location.hash, ''); assert.equal(w.location.search, ''); assert.equal(settings.auth.persistSession, false); assert.equal(settings.auth.autoRefreshToken, false); assert.equal(settings.auth.detectSessionInUrl, false); assert.equal(settings.auth.flowType, 'implicit'); return client; } };
  if (options.timeoutMs) { const timeout = w.setTimeout.bind(w); w.setTimeout = (fn, ms) => timeout(fn, ms === 12000 ? options.timeoutMs : ms); }
  const interval = w.setInterval.bind(w); w.setInterval = (...args) => { calls.push('interval'); return interval(...args); };
  w.eval(source);
  const el = id => w.document.getElementById('recovery-' + id);
  const submit = id => el(id).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  t.after(() => { w.dispatchEvent(new w.Event('pagehide')); w.close(); });
  return { w, el, calls, emit, submit, role(value) { role = value; }, roleDeferred(value) { roleDeferred = value; }, roleError(value) { roleError = value; }, user(value) { currentUser = value; }, fill(password = 'synthetic strong password', confirm = password) { el('password').value = password; el('confirm').value = confirm; } };
}

test('only approved URL/key configurations can construct a recovery client', async t => {
  const good = fixture(t, { callback: '' }); await until(() => !good.el('request').hidden);
  const local = { supabaseUrl: 'http://127.0.0.1:55321', publishableKey: 'sb_publishable_local', localDevelopment: true };
  const yes = fixture(t, { config: local, url: 'http://127.0.0.1:8810/admin/recovery.html' }); await until(() => !yes.el('request').hidden);
  const anon = role => 'x.' + Buffer.from(JSON.stringify({ role })).toString('base64url') + '.x';
  const checks = [
    { config: { supabaseUrl: '', publishableKey: '' } },
    { config: { ...config, publishableKey: 'sb_secret_synthetic' } },
    { config: { ...config, publishableKey: anon('service_role') } },
    { config: { ...config, publishableKey: anon('anon') } },
    { config: { ...config, publishableKey: 'sb_publishable_bad token' } },
    { config: { ...config, supabaseUrl: 'https://testproject.supabase.co.evil.invalid' } },
    { config: local },
    { config: { ...local, localDevelopment: 'true' }, url: 'http://127.0.0.1:8810/admin/recovery.html' },
    { config: { ...local, supabaseUrl: 'http://192.168.1.2:55321' }, url: 'http://127.0.0.1:8810/admin/recovery.html' },
    { config: { ...local, supabaseUrl: 'http://user@127.0.0.1:55321' }, url: 'http://127.0.0.1:8810/admin/recovery.html' },
    { config: { ...local, supabaseUrl: 'http://127.0.0.1:55321/auth/v1' }, url: 'http://127.0.0.1:8810/admin/recovery.html' },
    { config, url: 'https://office.example.invalid/admin/index.html' }
  ];
  for (const options of checks) { const f = fixture(t, options); assert.equal(f.calls.includes('create'), false); assert.equal(f.el('password-panel').hidden, true); }
  assert.ok(yes.w.CreekRecovery.settings({ ...local, publishableKey: anon('anon') }, yes.w.location));
});

test('unsupported, ambiguous and provider-error callbacks are scrubbed before any client loads', t => {
  for (const callback of [link('magiclink'), link('invite') + '&type=recovery', link('recovery') + '&error_code=otp_expired', '?code=synthetic', '#error=access_denied&error_description=private-token', '#type=recovery&access_token=synthetic', '?redirect=https://evil.invalid' + link('recovery')]) {
    const f = fixture(t, { callback }); assert.equal(f.w.location.hash, ''); assert.equal(f.w.location.search, ''); assert.equal(f.calls.includes('create'), false); assert.equal(f.el('password-panel').hidden, true); assert.doesNotMatch(f.el('status').textContent, /private-token/);
  }
});

test('reset requests use one exact callback and identical results for unknown/provider/network outcomes', async t => {
  const messages = [];
  for (const options of [{}, { requestError: true }, { requestFailure: true }]) {
    const f = fixture(t, { ...options, callback: '' }); await until(() => !f.el('request').hidden);
    f.el('email').value = 'synthetic@example.invalid'; f.submit('request-form'); await until(() => f.calls.includes('request') && !f.el('send').disabled);
    const request = f.calls.find(x => typeof x === 'object' && x.email); assert.equal(request.params.redirectTo, 'https://office.example.invalid/admin/recovery.html');
    messages.push(f.el('status').textContent); assert.equal(f.el('email').value, ''); assert.equal(f.calls.includes('setSession'), false); assert.equal(f.calls.includes('update'), false);
  }
  assert.equal(new Set(messages).size, 1); assert.doesNotMatch(messages[0], /private|delivered|sent successfully/i);
});

test('both recovery and invite links require verified current staff before password fields appear', async t => {
  for (const type of ['recovery', 'invite']) { const f = fixture(t, { callback: link(type) }); await until(() => !f.el('password-panel').hidden); assert.equal(f.w.document.activeElement.id, 'recovery-password'); assert.match(f.el('account').textContent, /staff@example.invalid/); assert.equal(f.w.localStorage.length, 0); assert.equal(f.w.sessionStorage.length, 0); }
  for (const options of [{ role: null }, { user: { ...user, email_confirmed_at: null } }, { user: { ...user, is_anonymous: true } }, { user: { ...user, id: 'different-user' } }, { badSession: true }]) {
    const f = fixture(t, options); await until(() => !f.el('restart').hidden); assert.equal(f.el('password-panel').hidden, true); assert.equal(f.calls.includes('update'), false);
  }
});

test('validation prevents mismatched/short submissions and successful save returns to manual sign-in', async t => {
  const f = fixture(t); await until(() => !f.el('password-panel').hidden);
  f.fill('short'); f.submit('password-form'); assert.equal(f.calls.includes('update'), false);
  f.fill('synthetic long value', 'synthetic different'); f.submit('password-form'); assert.equal(f.calls.includes('update'), false);
  f.fill(); f.submit('password-form'); await until(() => /password was saved/.test(f.el('status').textContent)); await until(() => f.calls.includes('signOut'));
  assert.equal(f.el('password').value, ''); assert.equal(f.el('confirm').value, ''); assert.equal(f.el('account').textContent, ''); assert.equal(f.el('password-panel').hidden, true); assert.equal(f.el('restart').hidden, true);
  assert.equal(f.w.document.activeElement, f.el('login')); assert.equal(f.el('login').getAttribute('href'), 'index.html'); assert.equal(f.calls.filter(x => x === 'update').length, 1);
  f.emit('SIGNED_IN', { user }); assert.equal(f.el('password-panel').hidden, true);
});

test('role revocation or identity switch before saving prevents a password update', async t => {
  for (const change of [f => f.role(null), f => f.user({ ...user, id: 'other-user' })]) {
    const f = fixture(t); await until(() => !f.el('password-panel').hidden); change(f); f.fill(); f.submit('password-form'); await until(() => !f.el('restart').hidden); assert.equal(f.calls.includes('update'), false); assert.equal(f.el('password').value, '');
  }
});

test('sign-out clears fields synchronously, defers SDK cleanup outside the callback, and rejects late events', async t => {
  const f = fixture(t, { signOutError: true }); await until(() => !f.el('password-panel').hidden); f.fill();
  f.emit('SIGNED_OUT', null); assert.equal(f.el('password').value, ''); assert.equal(f.el('password-panel').hidden, true);
  f.emit('SIGNED_IN', { user }); await until(() => f.calls.includes('signOut')); assert.equal(f.el('password-panel').hidden, true); assert.doesNotMatch(f.el('status').textContent, /private signout/);
});

test('cancelled verification cannot reopen when its session arrives late', async t => {
  const d = deferred(), f = fixture(t, { sessionDeferred: d }); await until(() => f.calls.includes('setSession'));
  f.el('cancel').click(); d.resolve({ data: { session: { user } } }); await until(() => f.calls.includes('signOut'));
  assert.equal(f.el('password-panel').hidden, true); assert.equal(f.calls.includes('role'), false);
});

test('a timeout or provider failure never claims a password was saved; a late result stays closed', async t => {
  for (const options of [{ updateError: true }, { updateDeferred: deferred(), timeoutMs: 10 }]) {
    const f = fixture(t, options); await until(() => !f.el('password-panel').hidden); f.fill(); f.submit('password-form'); await until(() => /could not confirm/.test(f.el('status').textContent));
    if (options.updateDeferred) options.updateDeferred.resolve({ data: { user } });
    assert.equal(f.el('password').value, ''); assert.equal(f.el('password-panel').hidden, true); assert.doesNotMatch(f.el('status').textContent, /private backend|was saved/);
  }
});

test('leaving the page clears secrets and a pending update cannot replace the closed UI', async t => {
  const d = deferred(), f = fixture(t, { updateDeferred: d }); await until(() => !f.el('password-panel').hidden); f.fill(); f.submit('password-form'); await until(() => f.calls.includes('update'));
  f.w.dispatchEvent(new f.w.Event('pagehide')); d.resolve({ data: { user } });
  assert.equal(f.el('password').value, ''); assert.equal(f.el('password-panel').hidden, true); assert.ok(f.calls.includes('unsubscribe'));
});

test('returning to manual login clears only this tab\'s office auth keys', async t => {
  const f = fixture(t, { callback: '' }); await until(() => !f.el('request').hidden);
  for (const key of ['creek-office-auth', 'creek-office-auth-code-verifier', 'creek-office-auth-user', 'unrelated']) f.w.sessionStorage.setItem(key, 'synthetic');
  f.w.localStorage.setItem('unrelated', 'keep');
  f.el('login').addEventListener('click', event => event.preventDefault()); f.el('login').click();
  assert.equal(f.w.sessionStorage.length, 1); assert.equal(f.w.sessionStorage.getItem('unrelated'), 'synthetic'); assert.equal(f.w.localStorage.getItem('unrelated'), 'keep');
});


const countCalls = (f, name) => f.calls.filter(call => call === name).length;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function pending(f) {
  await until(() => !f.el('access-pending').hidden && !f.el('check-access').disabled);
  assert.equal(f.el('password-panel').hidden, true);
  assert.equal(f.el('request').hidden, true);
  assert.equal(f.el('account').textContent, '');
  assert.equal(f.el('email').value, '');
  assert.equal(f.el('password').value, '');
  assert.equal(f.el('confirm').value, '');
  assert.equal(f.el('restart').hidden, true);
  assert.equal(f.w.document.activeElement.id, 'recovery-check-access');
  assert.equal(f.calls.includes('update'), false);
  assert.equal(f.w.localStorage.length, 0);
  assert.equal(f.w.sessionStorage.length, 0);
}
function closed(f) {
  assert.equal(f.el('access-pending').hidden, true);
  assert.equal(f.el('check-access').disabled, true);
  assert.equal(f.el('password-panel').hidden, true);
  assert.equal(f.el('account').textContent, '');
  assert.equal(f.el('password').value, '');
  assert.equal(f.el('confirm').value, '');
  assert.equal(f.calls.includes('update'), false);
}

test('a verified invite waits only in memory, then each allowed staff role enables manual password setup', async t => {
  for (const role of ['admin', 'editor', 'viewer']) {
    const f = fixture(t, { callback: link('invite'), role: null });
    await pending(f);
    assert.equal(countCalls(f, 'setSession'), 1);
    assert.equal(countCalls(f, 'role'), 1);
    const before = countCalls(f, 'role');
    await pause(35);
    assert.equal(countCalls(f, 'role'), before, 'pending access must not poll automatically');
    assert.equal(f.calls.includes('interval'), false);
    f.role(role); f.el('check-access').click();
    await until(() => !f.el('password-panel').hidden);
    assert.equal(f.el('access-pending').hidden, true);
    assert.match(f.el('account').textContent, /staff@example.invalid/);
    assert.equal(f.w.document.activeElement.id, 'recovery-password');
    f.fill(); f.submit('password-form');
    await until(() => /password was saved/.test(f.el('status').textContent));
    await until(() => f.calls.includes('signOut'));
    assert.equal(countCalls(f, 'role'), 3, 'initial, manual, and pre-save checks must each read the current role');
    assert.equal(countCalls(f, 'update'), 1);
    assert.equal(f.el('access-pending').hidden, true);
    assert.equal(f.el('account').textContent, '');
    assert.equal(f.el('password').value, '');
    assert.equal(f.w.localStorage.length, 0);
    assert.equal(f.w.sessionStorage.length, 0);
  }
});

test('repeated missing roles remain pending and concurrent manual checks cannot overlap', async t => {
  const f = fixture(t, { callback: link('invite'), role: null });
  await pending(f);
  for (let i = 0; i < 2; i++) {
    const before = countCalls(f, 'role'); f.el('check-access').click();
    await until(() => countCalls(f, 'role') === before + 1 && !f.el('check-access').disabled);
    await pending(f);
  }
  const d = deferred(), before = countCalls(f, 'role'); f.roleDeferred(d);
  f.el('check-access').click();
  f.el('check-access').dispatchEvent(new f.w.Event('click', { bubbles: true, cancelable: true }));
  await until(() => countCalls(f, 'role') === before + 1);
  assert.equal(f.el('check-access').disabled, true);
  await pause(25);
  assert.equal(countCalls(f, 'role'), before + 1);
  d.resolve({ data: null, error: null });
  await pending(f);
  await pause(25);
  assert.equal(countCalls(f, 'role'), before + 1);
  assert.equal(f.calls.includes('interval'), false);
});

test('missing access is pending only for a verified invite, never a failed query or ordinary recovery', async t => {
  const cases = [
    { callback: link('recovery'), role: null },
    { callback: link('invite'), role: null, badSession: true },
    { callback: link('invite'), role: null, roleError: { message: 'private role lookup detail' } },
    { callback: link('invite'), role: 'admin', roleError: { message: 'private role lookup detail' } },
    { callback: link('invite'), roleDeferred: { promise: Promise.resolve({ error: null }) } },
    { callback: link('invite'), roleDeferred: { promise: Promise.resolve({ data: {}, error: null }) } },
    { callback: link('invite'), role: 'owner' },
  ];
  for (const options of cases) {
    const f = fixture(t, options); await until(() => !f.el('restart').hidden);
    closed(f);
    assert.doesNotMatch(f.el('status').textContent, /private role lookup detail/);
  }
});

test('manual pending errors and timeouts close the flow and late role grants cannot reopen it', async t => {
  for (const timeout of [false, true]) {
    const f = fixture(t, { callback: link('invite'), role: null, timeoutMs: timeout ? 15 : undefined });
    await pending(f);
    const d = deferred();
    if (timeout) f.roleDeferred(d); else f.roleError({ message: 'private manual query detail' });
    f.el('check-access').click();
    await until(() => !f.el('restart').hidden);
    closed(f);
    if (timeout) d.resolve({ data: { role: 'admin' }, error: null });
    await pause(25);
    closed(f);
    assert.doesNotMatch(f.el('status').textContent, /private manual query detail|password was saved/);
  }
});

test('initial invite role lookup timeout fails closed and ignores a late role result', async t => {
  const d = deferred(), f = fixture(t, { callback: link('invite'), role: null, roleDeferred: d, timeoutMs: 15 });
  await until(() => !f.el('restart').hidden);
  closed(f);
  d.resolve({ data: { role: 'admin' }, error: null });
  await pause(25);
  closed(f);
});

test('cancel, page exit, sign-out and account change retire an in-flight manual role check', async t => {
  for (const finish of [
    f => f.el('cancel').click(),
    f => f.w.dispatchEvent(new f.w.Event('pagehide')),
    f => f.emit('SIGNED_OUT', null),
    f => f.emit('SIGNED_IN', { user: { ...user, id: 'other-staff-account' } }),
  ]) {
    const f = fixture(t, { callback: link('invite'), role: null });
    await pending(f);
    const d = deferred(), before = countCalls(f, 'role'); f.roleDeferred(d);
    f.el('check-access').click();
    await until(() => countCalls(f, 'role') === before + 1);
    f.fill(); finish(f);
    closed(f);
    d.resolve({ data: { role: 'admin' }, error: null });
    f.emit('SIGNED_IN', { user });
    await pause(25);
    closed(f);
    assert.equal(countCalls(f, 'role'), before + 1);
    assert.ok(f.calls.includes('unsubscribe'));
  }
});

test('manual checks revalidate the link owner, confirmation, anonymity and role before showing passwords', async t => {
  const changes = [
    f => f.user({ ...user, id: 'different-verified-user' }),
    f => f.user({ ...user, email_confirmed_at: null }),
    f => f.user({ ...user, is_anonymous: true }),
    f => f.role('owner'),
    f => f.role('ADMIN'),
    f => f.roleDeferred({ promise: Promise.resolve({ data: {}, error: null }) }),
  ];
  for (const change of changes) {
    const f = fixture(t, { callback: link('invite'), role: null });
    await pending(f); change(f); f.el('check-access').click();
    await until(() => !f.el('restart').hidden);
    closed(f);
  }
  for (const invalidUser of [{ ...user, id: 'different-verified-user' }, { ...user, email_confirmed_at: null }, { ...user, is_anonymous: true }]) {
    const f = fixture(t, { callback: link('invite'), role: null, user: invalidUser });
    await until(() => !f.el('restart').hidden);
    closed(f);
    assert.equal(countCalls(f, 'role'), 0, 'an invalid verified identity must not reach the role lookup');
  }
});

test('role removal after pending access was granted prevents the later password save', async t => {
  const f = fixture(t, { callback: link('invite'), role: null });
  await pending(f);
  f.role('admin'); f.el('check-access').click();
  await until(() => !f.el('password-panel').hidden);
  f.role(null); f.fill(); f.submit('password-form');
  await until(() => !f.el('restart').hidden);
  closed(f);
  assert.doesNotMatch(f.el('status').textContent, /password was saved/);
});
