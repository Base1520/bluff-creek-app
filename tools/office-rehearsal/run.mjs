import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { BUCKET, SCHEMA_REVISION, LOCAL_ORIGIN, RehearsalError, requireThat, safeError, safeHttp,
  fixtureId, ownPath, signedPath, FixtureRegistry, LocalHttp, parseArgs, validateConfig, configFromEnv } from './safety.mjs';
import { LocalFixtureSql } from './fixture-sql.mjs';

const RETURNING = { Prefer: 'return=representation' };
const DATE = '2026-09-07'; // Fictional fixed historical fixture date, not sermon/production data.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7xkAAAAASUVORK5CYII=', 'base64');

export async function rehearse(config) {
  const api = new LocalHttp(config), registry = new FixtureRegistry(randomUUID());
  const fixtures = new LocalFixtureSql(registry);
  const report = { kind: 'local-http-office-rehearsal', origin: LOCAL_ORIGIN, run_id: registry.runId,
    schema_revision: SCHEMA_REVISION, started_at: new Date().toISOString(), checks: [], cleanup: [],
    limits: ['Local HTTP services only; no production/hosted acceptance.', 'Confirmed users are created by local admin API; no email/OTP/delivery rehearsal.',
      'Preserved synthetic records and their sources remain in this disposable stack; no triggers are bypassed.',
      'Revocation blocks new authorized access; already issued signed URLs remain bearer links until their expiry.'] };
  const users = {}, state = {};
  let lastResponse;
  function check(condition, code) { requireThat(condition, code); }
  async function request(path, options) { lastResponse = await api.request(path, options); return lastResponse; }
  async function test(name, operation) {
    lastResponse = undefined;
    try { await operation(); report.checks.push({ check: name, status: 'passed' }); return true; }
    catch (error) { report.checks.push({ check: name, status: 'failed', error: safeError(error), ...safeHttp(lastResponse) }); return false; }
  }
  async function scenario(name, operation) {
    try { await operation(); }
    catch (error) { report.checks.push({ check: name, status: 'blocked', error: safeError(error), ...safeHttp(lastResponse) }); }
  }
  async function must(name, operation) { if (!await test(name, operation)) throw new RehearsalError('SCENARIO_DEPENDENCY_FAILED'); }
  const as = role => ({ actor: 'user', token: users[role]?.token });
  async function table(role, tableName, { method = 'GET', query = '', body } = {}) {
    return request(`/rest/v1/${tableName}?${query || 'select=*'}`, { ...as(role), method, body, headers: RETURNING });
  }
  async function rpc(role, name, body = {}) { return request(`/rest/v1/rpc/${name}`, { ...as(role), method: 'POST', body }); }
  const row = response => { check(response.ok && Array.isArray(response.data) && response.data.length === 1, 'EXPECTED_SINGLE_ROW'); return response.data[0]; };
  const empty = response => check(response.ok && Array.isArray(response.data) && response.data.length === 0, 'EXPECTED_NO_VISIBLE_ROWS');
  const denied = response => check(!response.ok && [401, 403].includes(response.status), 'EXPECTED_ACCESS_DENIAL');
  const storageDenied = response => check(!response.ok && [400, 401, 403, 404].includes(response.status), 'EXPECTED_PRIVATE_FILE_DENIAL');
  async function create(role, tableName, body, disposition = 'retained') {
    const id = registry.row(tableName, body.id || randomUUID(), disposition);
    const result = row(await table(role, tableName, { method: 'POST', body: { ...body, id } }));
    check(result.id === id, 'RETURNED_ID_MISMATCH'); return result;
  }
  async function get(role, tableName, id) { return table(role, tableName, { query: `id=eq.${fixtureId(id)}&select=*` }); }
  async function patch(role, tableName, id, version, body) {
    return table(role, tableName, { method: 'PATCH', query: `id=eq.${fixtureId(id)}&version=eq.${version}&select=*`, body });
  }
  async function upload(role, path, data) {
    return request(`/storage/v1/object/${BUCKET}/${path}`, { ...as(role), method: 'POST', bytes: data,
      headers: { 'Content-Type': path.endsWith('.png') ? 'image/png' : 'text/plain', 'x-upsert': 'false' } });
  }
  async function file(role, path) { return request(`/storage/v1/object/authenticated/${BUCKET}/${path}`, as(role)); }
  async function sign(role, path, ttl = 3) { return request(`/storage/v1/object/sign/${BUCKET}/${path}`, { ...as(role), method: 'POST', body: { expiresIn: ttl } }); }
  function hasCore() { check(state.contact && state.event, 'CORE_FIXTURES_UNAVAILABLE'); }

  try {
    await must('fixture database is this task container on its verified local Unix socket and loopback port', async () => { await fixtures.verify(); });
    await must('local Auth health responds', async () => { check((await request('/auth/v1/health', { actor: 'anon' })).ok, 'AUTH_UNAVAILABLE'); });
    await must('five confirmed synthetic users sign in without sending email', async () => {
      for (const role of ['admin', 'editor', 'viewer', 'nonstaff', 'other']) {
        const id = randomUUID(), email = `${role}-${registry.runId}@office-rehearsal.invalid`, password = randomBytes(36).toString('base64url');
        registry.user(id, email); users[role] = { id, email, token: null };
        const result = await request('/auth/v1/admin/users', { actor: 'service', method: 'POST', body: {
          id, email, password, email_confirm: true,
          user_metadata: role === 'nonstaff' ? { role: 'admin', staff_role: 'admin' } : { rehearsal: true } } });
        const user = result.data?.user ?? result.data;
        check(result.ok && user?.id === id && user?.email === email && user?.email_confirmed_at, 'SYNTHETIC_AUTH_CREATE_FAILED');
        const session = await request('/auth/v1/token?grant_type=password', { actor: 'anon', method: 'POST', body: { email, password } });
        check(session.ok && session.data?.user?.id === id && typeof session.data?.access_token === 'string', 'PASSWORD_SESSION_FAILED');
        users[role].token = session.data.access_token;
        if (['admin', 'editor', 'viewer'].includes(role)) {
          await fixtures.assignRole(id, role);
        }
      }
    });
    for (const role of ['admin', 'editor', 'viewer']) await must(`${role} readiness reports actual live role and revision`, async () => {
      const r = await rpc(role, 'office_readiness');
      check(r.ok && r.data?.schema_revision === SCHEMA_REVISION && r.data?.staff_role === role, 'READINESS_MISMATCH');
      check(Array.isArray(r.data.supported_modules) && (role === 'viewer' ? !r.data.supported_modules.includes('care') : r.data.supported_modules.includes('care')), 'READINESS_MODULE_MISMATCH');
    });
    await test('no-session readiness and contact access denied', async () => {
      denied(await request('/rest/v1/rpc/office_readiness', { method: 'POST', body: {} }));
      denied(await request('/rest/v1/contacts?select=id&limit=1'));
    });
    await test('user-editable admin metadata grants no office access', async () => {
      denied(await rpc('nonstaff', 'office_readiness'));
      empty(await table('nonstaff', 'staff_roles', { query: 'select=user_id,role' }));
    });
    await scenario('core record rehearsal', async () => {
      await must('admin creates fictional contact and event with server-owned versions', async () => {
        state.contact = await create('admin', 'contacts', { first_name: `OfficeRehearsal-${registry.runId}`, last_name: 'Fictional', status: 'visitor', version: 999 });
        state.event = await create('admin', 'events', { title: `Office rehearsal ${registry.runId}`, starts_at: `${DATE}T16:00:00Z`, version: 999 });
        check(state.contact.version === 1 && state.event.version === 1 && state.contact.created_by === users.admin.id, 'SERVER_VERSION_OR_OWNER_MISMATCH');
      });
      for (const role of ['admin', 'editor', 'viewer']) await test(`${role} reads permitted base contact and event`, async () => {
        check(row(await get(role, 'contacts', state.contact.id)).id === state.contact.id, 'CONTACT_READ_FAILED');
        check(row(await get(role, 'events', state.event.id)).id === state.event.id, 'EVENT_READ_FAILED');
      });
      await test('nonstaff cannot see existing core fixtures', async () => {
        empty(await get('nonstaff', 'contacts', state.contact.id)); empty(await get('nonstaff', 'events', state.event.id));
      });
      await must('editor saves core record with optimistic version filter', async () => {
        state.contact = row(await patch('editor', 'contacts', state.contact.id, state.contact.version, { notes: 'Synthetic editor update' }));
        check(state.contact.version === 2 && state.contact.updated_by === users.editor.id, 'EDITOR_UPDATE_FAILED');
      });
      await test('viewer update and stale editor update change no rows', async () => {
        empty(await patch('viewer', 'contacts', state.contact.id, 2, { notes: 'Must not save' }));
        empty(await patch('editor', 'contacts', state.contact.id, 1, { notes: 'Must not save' }));
        const actual = row(await get('admin', 'contacts', state.contact.id));
        check(actual.notes === 'Synthetic editor update' && actual.version === 2, 'DENIED_WRITE_CHANGED_RECORD');
      });
      await test('viewer and nonstaff cannot insert core records', async () => {
        for (const role of ['viewer', 'nonstaff']) {
          const id = registry.row('contacts', randomUUID());
          denied(await table(role, 'contacts', { method: 'POST', body: { id, first_name: `OfficeRehearsal-${registry.runId}`, last_name: 'Denied', status: 'visitor' } }));
        }
      });
      await test('authenticated roles cannot promote themselves', async () => {
        for (const role of ['admin', 'editor', 'viewer']) {
          denied(await table(role, 'staff_roles', { method: 'PATCH', query: `user_id=eq.${users[role].id}`, body: { role: 'admin' } }));
          const actual = row(await table(role, 'staff_roles', { query: `user_id=eq.${users[role].id}&select=user_id,role` }));
          check(actual.role === role, 'ROLE_CHANGED_UNEXPECTEDLY');
        }
      });
    });
    await scenario('care and content rehearsal', async () => {
      hasCore();
      await must('editor appends fictional history and separate deacon/teacher plans', async () => {
        state.history = await create('editor', 'membership_history', { contact_id: state.contact.id, event_type: 'Synthetic review', date_text: '[unclear] fictional date', source_label: 'Fictional test page', details: 'No real church history.' });
        state.deacon = await create('editor', 'care_assignments', { contact_id: state.contact.id, care_role: 'deacon', cadence_months: 3, started_on: DATE });
        state.teacher = await create('editor', 'care_assignments', { contact_id: state.contact.id, care_role: 'sunday_school', cadence_months: 1, started_on: DATE });
        state.visit = await create('editor', 'care_visits', { contact_id: state.contact.id, care_role: 'deacon', visitor_name: 'Fictional Operator', contacted_on: DATE, method: 'other', outcome: 'attempted', notes: 'Synthetic attempt; no communication sent.' });
        check(state.deacon.id !== state.teacher.id && state.deacon.cadence_months === 3 && state.teacher.cadence_months === 1, 'CARE_ROLE_SEPARATION_FAILED');
      });
      await test('viewers and nonstaff cannot read care/history fixtures', async () => {
        for (const role of ['viewer', 'nonstaff']) for (const [name, value] of [['membership_history', state.history], ['care_assignments', state.deacon], ['care_visits', state.visit]]) empty(await get(role, name, value.id));
        check(row(await get('admin', 'membership_history', state.history.id)).id === state.history.id, 'ADMIN_HISTORY_READ_FAILED');
      });
      await test('preserved historical entry and contact refuse destructive API operations', async () => {
        denied(await table('editor', 'membership_history', { method: 'PATCH', query: `id=eq.${state.history.id}`, body: { details: 'Must not rewrite history' } }));
        denied(await table('admin', 'contacts', { method: 'DELETE', query: `id=eq.${state.contact.id}` }));
        check(row(await get('admin', 'membership_history', state.history.id)).details === 'No real church history.', 'PRESERVED_ENTRY_CHANGED');
      });
      await must('editor prepares private announcement and prayer fixture', async () => {
        state.announcement = await create('editor', 'office_announcements', { title: `Office rehearsal ${registry.runId}`, body: 'Fictional local announcement; never published.' }, 'disposable');
        state.prayer = await create('editor', 'office_prayer_requests', { display_name: 'Fictional Test', request_text: 'Synthetic request; no real prayer information.', care_notes: 'Synthetic staff-only note.' }, 'disposable');
      });
      await test('private office content stays invisible to viewer and nonstaff', async () => {
        for (const role of ['viewer', 'nonstaff']) { empty(await get(role, 'office_announcements', state.announcement.id)); empty(await get(role, 'office_prayer_requests', state.prayer.id)); }
        check(row(await get('admin', 'office_prayer_requests', state.prayer.id)).share_scope === 'staff_only', 'PRAYER_DEFAULT_NOT_PRIVATE');
      });
      await test('prayer sharing requires recorded approval', async () => {
        const r = await patch('editor', 'office_prayer_requests', state.prayer.id, state.prayer.version, { share_scope: 'church', sharing_approved: false });
        check(!r.ok && r.data?.code === '23514', 'PRAYER_APPROVAL_CONSTRAINT_FAILED');
      });
    });
    await scenario('personal leadership rehearsal', async () => {
      await must('editor creates an owner-only leadership plan', async () => {
        state.leader = await create('editor', 'leader_followups', { display_name: 'Fictional Leader', leadership_role: 'deacon', cadence_months: 1, first_due_on: DATE, notes: 'Synthetic owner-only note.' });
        check(state.leader.owner_id === users.editor.id && state.leader.version === 1, 'LEADER_OWNER_FAILED');
      });
      await test('even administrator cannot read or edit another owner leadership plan', async () => {
        for (const role of ['admin', 'viewer', 'nonstaff']) empty(await get(role, 'leader_followups', state.leader.id));
        empty(await patch('admin', 'leader_followups', state.leader.id, 1, { notes: 'Must not save' }));
        check(row(await get('editor', 'leader_followups', state.leader.id)).notes === 'Synthetic owner-only note.', 'CROSS_OWNER_WRITE_SUCCEEDED');
      });
      await test('leadership contact RPC rejects another owner and stale version', async () => {
        const payload = { p_id: state.leader.id, p_version: 1, p_contacted_on: DATE, p_outcome: 'attempted', p_method: 'other', p_notes: 'Synthetic journal; no communication sent.' };
        denied(await rpc('admin', 'record_leader_contact', payload));
        const saved = await rpc('editor', 'record_leader_contact', payload);
        check(saved.ok && saved.data?.version === 2 && saved.data?.last_contact_on === null, 'LEADER_ATTEMPT_RPC_FAILED');
        const history = await table('editor', 'leader_followup_contacts', { query: `followup_id=eq.${state.leader.id}&select=*` });
        const entry = row(history); registry.row('leader_followup_contacts', entry.id);
        check(entry.owner_id === users.editor.id, 'LEADER_JOURNAL_OWNER_FAILED');
        const stale = await rpc('editor', 'record_leader_contact', payload);
        check(!stale.ok && stale.data?.code === '40001', 'LEADER_STALE_RETRY_NOT_REJECTED');
        empty(await get('admin', 'leader_followup_contacts', entry.id));
      });
      await test('owner-only leadership identifiers are absent from shared audit', async () => {
        empty(await table('admin', 'audit_log', { query: `entity_id=eq.${state.leader.id}&select=id` }));
      });
    });
    await scenario('private Storage rehearsal', async () => {
      hasCore();
      await must('editor uploads ordinary document and reserved source image through Storage API', async () => {
        state.plainPath = ownPath(users.editor.id, registry.runId); state.sourcePath = ownPath(users.editor.id, registry.runId, true);
        registry.object(state.plainPath, users.editor.id); registry.object(state.sourcePath, users.editor.id, true);
        const plain = Buffer.from(`Fictional office rehearsal ${registry.runId}\n`); state.plainBytes = plain;
        check((await upload('editor', state.plainPath, plain)).ok, 'PLAIN_UPLOAD_FAILED');
        check((await upload('editor', state.sourcePath, PNG)).ok, 'SOURCE_UPLOAD_FAILED');
        state.plainDocument = await create('editor', 'documents', { title: 'Fictional test document', category: 'other', storage_path: state.plainPath, file_name: 'fictional.txt', mime_type: 'text/plain', size_bytes: plain.length, uploaded_by: users.editor.id }, 'disposable');
        state.sourceDocument = await create('editor', 'documents', { title: 'Fictional source image', category: 'other', storage_path: state.sourcePath, file_name: 'fictional.png', mime_type: 'image/png', size_bytes: PNG.length, uploaded_by: users.editor.id });
      });
      await test('staff download ordinary private file; source is admin/editor only before linking', async () => {
        for (const role of ['admin', 'editor', 'viewer']) {
          const downloaded = await file(role, state.plainPath); check(downloaded.ok && downloaded.bytes.equals(state.plainBytes), 'PRIVATE_DOWNLOAD_FAILED');
        }
        for (const role of ['admin', 'editor']) { const source = await file(role, state.sourcePath); check(source.ok && source.bytes.equals(PNG), 'SOURCE_DOWNLOAD_FAILED'); }
        storageDenied(await file('viewer', state.sourcePath)); empty(await get('viewer', 'documents', state.sourceDocument.id));
        storageDenied(await file('nonstaff', state.plainPath));
        storageDenied(await request(`/storage/v1/object/public/${BUCKET}/${state.plainPath}`, { actor: 'none' }));
      });
      await test('viewer upload and editor upload under another user prefix are denied', async () => {
        const viewerPath = ownPath(users.viewer.id, registry.runId); registry.object(viewerPath, users.viewer.id);
        storageDenied(await upload('viewer', viewerPath, state.plainBytes));
        const wrongPath = ownPath(users.admin.id, registry.runId); registry.object(wrongPath, users.admin.id);
        storageDenied(await upload('editor', wrongPath, state.plainBytes));
      });
      await must('history links the source and prevents editor replacement and metadata rewrite', async () => {
        state.sourceHistory = await create('editor', 'membership_history', { contact_id: state.contact.id, event_type: 'Synthetic page review', source_label: 'Fictional image only', source_document_id: state.sourceDocument.id });
        const replaced = await request(`/storage/v1/object/${BUCKET}/${state.sourcePath}`, { ...as('editor'), method: 'PUT', bytes: Buffer.from('Must not replace'), headers: { 'Content-Type': 'image/png' } });
        storageDenied(replaced);
        const changed = await patch('editor', 'documents', state.sourceDocument.id, 1, { description: 'Must not rewrite linked source' });
        check(!changed.ok && changed.data?.code === '55000', 'LINKED_SOURCE_METADATA_NOT_LOCKED');
        check((await file('editor', state.sourcePath)).bytes.equals(PNG), 'LINKED_SOURCE_CHANGED');
      });
      await test('source signed URL is usable without session then expires; viewer cannot mint one', async () => {
        storageDenied(await sign('viewer', state.sourcePath));
        const signed = await sign('editor', state.sourcePath, 3);
        check(signed.ok, 'SIGNED_URL_CREATE_FAILED');
        const path = signedPath(signed.data?.signedURL, state.sourcePath);
        const before = await request(path, { actor: 'none' }); check(before.ok && before.bytes.equals(PNG), 'SIGNED_DOWNLOAD_FAILED');
        await delay(4100);
        storageDenied(await request(path, { actor: 'none' }));
      });
    });
    await scenario('verified signup and welcome rehearsal', async () => {
      hasCore();
      const profile = { p_first_name: `OfficeRehearsal-${registry.runId}`, p_last_name: 'Fictional Signup', p_phone: null, p_preferred_contact: 'email', p_contact_permission: true, p_sunday_school: null };
      await must('verified nonstaff submits own profile through scoped RPC only', async () => {
        const result = await rpc('nonstaff', 'save_app_connection', profile);
        check(result.ok && result.data?.version === 1, 'PROFILE_SUBMISSION_FAILED');
        state.connection = { id: fixtureId(result.data.id), version: 1 }; registry.row('app_connections', state.connection.id, 'disposable');
        const own = await rpc('nonstaff', 'get_my_app_connection');
        check(own.ok && own.data?.id === state.connection.id && own.data?.email === users.nonstaff.email && !('staff_notes' in own.data), 'PROFILE_ISOLATION_FAILED');
        const other = await rpc('other', 'get_my_app_connection'); check(other.ok && other.data === null, 'OTHER_PROFILE_VISIBLE');
        for (const role of ['nonstaff', 'viewer']) empty(await get(role, 'app_connections', state.connection.id));
        denied(await request('/rest/v1/rpc/save_app_connection', { method: 'POST', body: profile }));
      });
      const review = { p_id: state.connection.id, p_version: 1, p_contact_id: state.contact.id, p_create_person: false, p_staff_notes: 'Synthetic private review', p_welcome_owner: 'Fictional Welcome Operator' };
      await must('editor links reviewed signup without rewriting existing contact and creates one welcome plan', async () => {
        denied(await rpc('viewer', 'review_app_connection', review)); denied(await rpc('nonstaff', 'review_app_connection', review));
        const result = await rpc('editor', 'review_app_connection', review);
        check(result.ok && result.data?.contact_id === state.contact.id && result.data?.status === 'reviewed', 'SIGNUP_REVIEW_FAILED');
        check(row(await get('admin', 'contacts', state.contact.id)).last_name === 'Fictional', 'LINK_OVERWROTE_EXISTING_CONTACT');
        const welcome = row(await table('editor', 'care_assignments', { query: `contact_id=eq.${state.contact.id}&care_role=eq.welcome&select=*` }));
        registry.row('care_assignments', welcome.id); state.welcome = welcome;
        check(welcome.one_time && welcome.cadence_days === 2 && welcome.first_due_on === new Date(Date.parse(`${welcome.started_on}T00:00:00Z`) + 172800000).toISOString().slice(0, 10), 'WELCOME_DUE_DATE_FAILED');
      });
      await test('retried signup review creates no duplicate welcome plan', async () => {
        const result = await rpc('editor', 'review_app_connection', review);
        check(result.ok && result.data?.already_reviewed === true, 'SIGNUP_RETRY_NOT_IDEMPOTENT');
        check(row(await table('editor', 'care_assignments', { query: `contact_id=eq.${state.contact.id}&care_role=eq.welcome&select=*` })).id === state.welcome.id, 'DUPLICATE_WELCOME_PLAN');
      });
      await test('profile update returns to review while preserving link and welcome history', async () => {
        const changed = await rpc('nonstaff', 'save_app_connection', { ...profile, p_last_name: 'Fictional Updated' });
        check(changed.ok && changed.data?.id === state.connection.id && changed.data?.version === 2, 'PROFILE_UPDATE_FAILED');
        const pending = row(await get('editor', 'app_connections', state.connection.id));
        check(pending.status === 'pending' && pending.contact_id === state.contact.id && pending.reviewed_version === 1, 'PROFILE_REVIEW_STATE_LOST');
        const oldReview = await rpc('editor', 'review_app_connection', review); check(!oldReview.ok && oldReview.data?.code === '40001', 'STALE_SIGNUP_REVIEW_NOT_REJECTED');
        check((await rpc('editor', 'review_app_connection', { ...review, p_version: 2 })).ok, 'UPDATED_SIGNUP_REVIEW_FAILED');
        check(row(await table('editor', 'care_assignments', { query: `contact_id=eq.${state.contact.id}&care_role=eq.welcome&select=*` })).id === state.welcome.id, 'WELCOME_CHANGED_ON_PROFILE_UPDATE');
        const own = await rpc('nonstaff', 'get_my_app_connection'); check(own.ok && !('staff_notes' in own.data) && !('contact_id' in own.data), 'STAFF_FIELDS_EXPOSED_IN_PROFILE');
      });
      await test('new visitor review and retry preserve one generated person identity', async () => {
        const saved = await rpc('other', 'save_app_connection', { ...profile, p_last_name: 'Fictional New Visitor' });
        check(saved.ok && saved.data?.version === 1, 'SECOND_PROFILE_FAILED');
        registry.row('app_connections', fixtureId(saved.data.id), 'disposable');
        const payload = { ...review, p_id: saved.data.id, p_contact_id: null, p_create_person: true };
        const first = await rpc('admin', 'review_app_connection', payload); check(first.ok, 'NEW_VISITOR_REVIEW_FAILED');
        const personId = registry.row('contacts', fixtureId(first.data.contact_id));
        const person = row(await get('admin', 'contacts', personId)); check(person.status === 'visitor' && person.needs_review === true, 'NEW_VISITOR_STATUS_FAILED');
        const retry = await rpc('admin', 'review_app_connection', payload);
        check(retry.ok && retry.data?.contact_id === personId && retry.data?.already_reviewed === true, 'NEW_VISITOR_RETRY_DUPLICATED_PERSON');
        const welcome = row(await table('admin', 'care_assignments', { query: `contact_id=eq.${personId}&care_role=eq.welcome&select=*` })); registry.row('care_assignments', welcome.id);
      });
    });
    await scenario('role revocation rehearsal', async () => {
      await must('revoked editor loses access using the same unexpired session token', async () => {
        registry.assertUser(users.editor.id);
        await fixtures.revokeRole(users.editor.id);
        denied(await rpc('editor', 'office_readiness'));
        if (state.contact) empty(await get('editor', 'contacts', state.contact.id));
        if (state.leader) empty(await get('editor', 'leader_followups', state.leader.id));
        if (state.sourcePath) { storageDenied(await file('editor', state.sourcePath)); storageDenied(await sign('editor', state.sourcePath)); }
        const id = registry.row('contacts', randomUUID());
        denied(await table('editor', 'contacts', { method: 'POST', body: { id, first_name: `OfficeRehearsal-${registry.runId}`, last_name: 'Revoked' } }));
        check((await rpc('admin', 'office_readiness')).ok && (await rpc('viewer', 'office_readiness')).ok, 'REVOCATION_TEST_SERVICE_UNAVAILABLE');
      });
    });
  } catch (error) {
    report.checks.push({ check: 'rehearsal setup', status: 'blocked', error: safeError(error) });
  } finally {
    // Only fixed local fixture SQL and Storage/Auth operations. No global cleanup,
    // name-prefix deletes, bucket removal, trigger bypass, history edits or reset.
    for (const [tableName, ids] of registry.rows) for (const [id, disposition] of ids) {
      if (disposition !== 'disposable') continue;
      try {
        registry.assertRow(tableName, id);
        await fixtures.removeDisposable(tableName, id);
        report.cleanup.push({ kind: 'fixture_row', table: tableName, id, status: 'removed_or_absent' });
      } catch (error) { report.cleanup.push({ kind: 'fixture_row', table: tableName, id, status: 'unconfirmed', error: safeError(error) }); }
    }
    for (const [path, disposition] of registry.objects) {
      if (disposition !== 'disposable') continue;
      try {
        registry.assertObject(path);
        const removed = await api.request(`/storage/v1/object/${BUCKET}`, { actor: 'service', method: 'DELETE', body: { prefixes: [path] } });
        report.cleanup.push({ kind: 'fixture_file', status: removed.ok ? 'removed_or_absent' : 'retained', ...(!removed.ok ? safeHttp(removed) : {}) });
      } catch (error) { report.cleanup.push({ kind: 'fixture_file', status: 'unconfirmed', error: safeError(error) }); }
    }
    for (const [id, email] of registry.users) {
      try {
        registry.assertUser(id);
        const found = await api.request(`/auth/v1/admin/users/${id}`, { actor: 'service' }); const owned = found.data?.user ?? found.data;
        if (found.status === 404) { report.cleanup.push({ kind: 'fixture_access', id, status: 'absent' }); continue; }
        check(found.ok && owned?.id === id && owned?.email === email, 'UNOWNED_CLEANUP_REFUSED');
        // Continue independent containment actions even if another service fails.
        const actions = {};
        try {
          await fixtures.revokeRole(id);
          actions.role_removal = 'confirmed';
        } catch (error) { actions.role_removal = safeError(error); }
        const actor = Object.values(users).find(u => u.id === id);
        if (actor?.token) {
          try {
            const logout = await api.request('/auth/v1/logout?scope=global', { actor: 'user', token: actor.token, method: 'POST' });
            check(logout.ok, 'CLEANUP_LOGOUT_UNCONFIRMED'); actions.session_logout = 'confirmed';
          } catch (error) { actions.session_logout = safeError(error); }
        } else actions.session_logout = 'no_session_obtained';
        try {
          const banned = await api.request(`/auth/v1/admin/users/${id}`, { actor: 'service', method: 'PUT', body: { ban_duration: '87600h' } });
          const updated = banned.data?.user ?? banned.data;
          check(banned.ok && Date.parse(updated?.banned_until) > Date.now(), 'CLEANUP_BAN_UNCONFIRMED'); actions.user_ban = 'confirmed';
        } catch (error) { actions.user_ban = safeError(error); }
        const complete = actions.role_removal === 'confirmed' && actions.user_ban === 'confirmed'
          && ['confirmed', 'no_session_obtained'].includes(actions.session_logout);
        report.cleanup.push({ kind: 'fixture_access', id, status: complete ? 'access_containment_confirmed' : 'unconfirmed', actions });
      } catch (error) { report.cleanup.push({ kind: 'fixture_access', id, status: 'unconfirmed', error: safeError(error) }); }
    }
  }
  report.retained_fixture_ids = Object.fromEntries([...registry.rows].map(([name, ids]) => [name, [...ids].filter(([, disposition]) => disposition !== 'disposable').map(([id]) => id)]).filter(([, ids]) => ids.length));
  report.retained_source_files = [...registry.objects.values()].filter(v => v === 'retained_source').length;
  report.retained_auth_users = registry.users.size;
  report.fixture_note = 'IDs include attempted inserts when a response was denied or uncertain; retained counts are planned inventory, not asserted database totals. Auth rows are retained because preserved records and audit foreign keys may reference them; access containment is recorded separately for each user.';
  report.finished_at = new Date().toISOString();
  report.passed = report.checks.filter(c => c.status === 'passed').length;
  report.failed = report.checks.filter(c => c.status === 'failed').length;
  report.blocked = report.checks.filter(c => c.status === 'blocked').length;
  report.cleanup_unconfirmed = report.cleanup.filter(c => ['unconfirmed', 'retained'].includes(c.status)).length;
  report.status = report.failed || report.blocked || report.cleanup_unconfirmed ? 'failed_or_incomplete' : 'passed_local_http_only';
  return report;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write('Local-only office HTTP rehearsal (Node 24+).\nUsage: node tools/office-rehearsal/run.mjs --run [--stdin]\nOnly http://127.0.0.1:55321 is accepted. Keys: env or stdin JSON only. Read README.md before running. No hosted/URL/key/reset/SQL CLI flags exist.\n'); return;
    }
    requireThat(Number(process.versions.node.split('.')[0]) >= 24, 'NODE_24_REQUIRED');
    let config;
    if (options.stdin) {
      requireThat(!process.stdin.isTTY, 'PIPE_JSON_INPUT_REQUIRED');
      let text = '';
      for await (const chunk of process.stdin) { text += chunk; requireThat(Buffer.byteLength(text) <= 32768, 'INPUT_TOO_LARGE'); }
      try { config = validateConfig(JSON.parse(text)); } catch (error) { throw error instanceof RehearsalError ? error : new RehearsalError('INVALID_INPUT_JSON'); }
    } else config = configFromEnv(process.env);
    const report = await rehearse(config);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = report.status === 'passed_local_http_only' ? 0 : 1;
  } catch (error) {
    process.stderr.write(JSON.stringify({ status: 'refused_or_failed', error: safeError(error) }) + '\n'); process.exitCode = 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
