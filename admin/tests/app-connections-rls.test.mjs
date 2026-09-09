import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const ids = Object.fromEntries(['admin','editor','viewer','first','second','unverified','anonymous'].map((role, index) => [role, `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]));
const denied = (operation, code = '42501') => assert.rejects(operation, error => error.code === code);

test('app connection intake and care roles remain private, verified and reviewable', async t => {
  const pg = new PGlite({ extensions: { pgcrypto } });
  t.after(() => pg.close());
  await pg.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, is_anonymous boolean not null default false);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, unique(bucket_id, name));
    alter table storage.objects enable row level security;
    grant usage on schema public, storage to anon, authenticated;
    grant select, insert, update, delete on storage.objects to anon, authenticated;
  `);
  await pg.exec(await readFile(new URL('../../supabase/migrations/20260908220558_office_base.sql', import.meta.url), 'utf8'));
  await pg.exec(await readFile(new URL('../../supabase/migrations/20260908220613_membership_care.sql', import.meta.url), 'utf8'));
  await pg.exec(await readFile(new URL('../../supabase/migrations/20260908220623_office_content.sql', import.meta.url), 'utf8'));
  for (const [role, id] of Object.entries(ids)) {
    await pg.query(`insert into auth.users(id,email,email_confirmed_at,is_anonymous) values ($1,$2,$3,$4)`, [id, `${role}@example.invalid`, role === 'unverified' ? null : '2026-09-07', role === 'anonymous']);
    if (['admin','editor','viewer'].includes(role)) await pg.query('insert into public.staff_roles(user_id,role) values ($1,$2)', [id, role]);
  }
  async function as(role, sql, params = []) {
    await pg.exec('reset role');
    await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [ids[role] ?? '']);
    await pg.exec(`set role ${role === 'anon' ? 'anon' : 'authenticated'}`);
    try { return await pg.query(sql, params); }
    finally { await pg.exec('reset role'); }
  }
  const person = (await as('editor', `insert into public.contacts(first_name,last_name,email,phone,status,notes) values ('Existing','Fixture','preserve@example.invalid','555-0100','active','Preserve this staff note') returning *`)).rows[0];
  const legacyPlan = (await as('editor', `insert into public.care_assignments(contact_id,assigned_to,cadence_days) values ($1,'Fixture deacon',90) returning *`, [person.id])).rows[0];
  const legacyVisit = (await as('editor', `insert into public.care_visits(contact_id,visitor_name,contacted_on) values ($1,'Fixture deacon','2026-09-01') returning *`, [person.id])).rows[0];
  await pg.exec('alter default privileges in schema public grant all on tables to anon, authenticated');
  await pg.exec(await readFile(new URL('../../supabase/migrations/20260908220645_app_connections_care_roles.sql', import.meta.url), 'utf8'));
  const save = (role, overrides = {}) => {
    const profile = { first_name: 'Synthetic', last_name: 'Signup', phone: '', preferred_contact: 'email', contact_permission: true, sunday_school: null, ...overrides };
    return as(role, 'select public.save_app_connection($1,$2,$3,$4,$5,$6) as result', Object.values(profile)).then(result => result.rows[0].result);
  };
  const mine = role => as(role, 'select public.get_my_app_connection() as result').then(result => result.rows[0].result);
  const review = (role, connection, { contact = null, create = false, notes = null, owner = null, version = connection.version } = {}) => as(role,
    'select public.review_app_connection($1,$2,$3,$4,$5,$6) as result', [connection.id, version, contact, create, notes, owner]).then(result => result.rows[0].result);
  let first, second;

  await t.test('only a real verified user may submit a bounded, explicitly permitted own profile', async () => {
    for (const role of ['anon','unverified','anonymous']) {
      await denied(() => save(role));
      await denied(() => mine(role));
    }
    assert.equal(await mine('first'), null);
    await denied(() => save('first', { contact_permission: false }), '22023');
    await denied(() => save('first', { contact_permission: null }), '22023');
    await denied(() => save('first', { first_name: '  ' }), '22023');
    await denied(() => save('first', { first_name: 'a'.repeat(101) }), '22023');
    await denied(() => save('first', { preferred_contact: 'fax' }), '22023');
    await denied(() => save('first', { preferred_contact: 'text' }), '22023');
    await denied(() => save('first', { phone: '1'.repeat(33) }), '22023');
    await denied(() => save('first', { sunday_school: 'a'.repeat(161) }), '22023');
    first = await save('first');
    second = await save('second', { first_name: 'Another', last_name: '' });
    assert.equal(first.version, 1);
    assert.notEqual(first.id, second.id);
    assert.equal((await mine('first')).email, 'first@example.invalid');
    assert.equal((await as('first', 'select * from public.staff_roles')).rows.length, 0);
    assert.equal((await as('editor', 'select count(*)::int n from public.contacts')).rows[0].n, 1);
  });

  await t.test('self-read returns an allowlist; outsiders cannot read staff rows, audit entries or assign roles', async () => {
    const own = await mine('first');
    assert.equal(own.id, first.id);
    assert.deepEqual(Object.keys(own).sort(), ['id','first_name','last_name','email','phone','preferred_contact','contact_permission','sunday_school','version','submitted_at','updated_at'].sort());
    assert.equal((await mine('second')).id, second.id);
    for (const role of ['first','second','viewer']) {
      assert.equal((await as(role, 'select * from public.app_connections')).rows.length, 0);
      assert.equal((await as(role, "select * from public.audit_log where entity_type='app_connections'")).rows.length, 0);
      await denied(() => as(role, "update public.app_connections set status='reviewed'"));
      await denied(() => as(role, 'insert into public.staff_roles(user_id,role) values ($1,\'admin\')', [ids.first]));
      await denied(() => review(role, first, { contact: person.id }));
    }
    await denied(() => as('anon', 'select * from public.app_connections'));
    for (const role of ['admin','editor']) {
      assert.equal((await as(role, 'select * from public.app_connections')).rows.length, 2);
      await denied(() => as(role, "update public.app_connections set staff_notes='Direct bypass'"));
      await denied(() => as(role, 'delete from public.app_connections'));
      await denied(() => as(role, 'truncate public.app_connections'));
    }
    assert.equal((await as('first', 'select * from public.contacts')).rows.length, 0);
    assert.equal((await as('first', 'select * from public.care_visits')).rows.length, 0);
    await denied(() => as('first', "insert into public.app_connections(auth_user_id,first_name,last_name,email,preferred_contact,contact_permission) values ($1,'Fake','Fixture','fake@example.invalid','email',true)", [ids.second]));
    const routines = await pg.query(`select n.nspname schema,p.proname name,p.prosecdef definer,has_function_privilege('anon',p.oid,'EXECUTE') anon_exec,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_exec
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname in ('save_app_connection','get_my_app_connection','review_app_connection') order by schema,name`);
    assert.equal(routines.rows.length, 6);
    for (const routine of routines.rows) {
      assert.equal(routine.anon_exec, false);
      assert.equal(routine.authenticated_exec, true);
      assert.equal(routine.definer, routine.schema === 'private');
    }
  });

  await t.test('review checks the profile version and links without overwriting the established person', async () => {
    await denied(() => review('editor', first, { version: 99, contact: person.id }), '40001');
    await denied(() => review('editor', first), '22023');
    await denied(() => review('editor', first, { contact: person.id, create: true }), '22023');
    const reviewed = await review('editor', first, { contact: person.id, notes: 'Reviewed synthetic signup', owner: 'Fixture welcome team' });
    assert.deepEqual(reviewed, { id: first.id, version: 1, contact_id: person.id, status: 'reviewed' });
    const preserved = (await as('editor', 'select * from public.contacts where id=$1', [person.id])).rows[0];
    assert.deepEqual(preserved, person);
    const row = (await as('editor', 'select * from public.app_connections where id=$1', [first.id])).rows[0];
    assert.equal(row.reviewed_by, ids.editor);
    assert.equal(row.reviewed_version, 1);
    const welcome = (await as('editor', "select *, ((select submitted_at at time zone 'America/Chicago' from public.app_connections where id=$1)::date + 2) as expected_due from public.care_assignments where contact_id=$2 and care_role='welcome'", [first.id, person.id])).rows[0];
    assert.equal(welcome.one_time, true);
    assert.deepEqual(welcome.first_due_on, welcome.expected_due);
    assert.equal(welcome.assigned_to, 'Fixture welcome team');
    assert.equal(welcome.created_by, ids.editor);
    const auditBefore = (await as('editor', "select count(*)::int n from public.audit_log where entity_type='app_connections'")).rows[0].n;
    assert.deepEqual(await review('admin', first, { contact: person.id }), { ...reviewed, already_reviewed: true });
    assert.equal((await as('editor', "select count(*)::int n from public.audit_log where entity_type='app_connections'")).rows[0].n, auditBefore);
    assert.equal((await as('editor', "select count(*)::int n from public.care_assignments where contact_id=$1 and care_role='welcome'", [person.id])).rows[0].n, 1);
  });

  await t.test('review creates only a visitor and never an approved member or a staff account', async () => {
    const reviewed = await review('admin', second, { create: true });
    const created = (await as('editor', 'select * from public.contacts where id=$1', [reviewed.contact_id])).rows[0];
    assert.equal(created.status, 'visitor');
    assert.equal(created.needs_review, true);
    assert.equal(created.first_name, 'Another');
    assert.equal(created.email, 'second@example.invalid');
    assert.equal(created.created_by, ids.admin);
    assert.equal(created.membership_number, null);
    const auditBeforeConflict = (await as('editor', "select count(*)::int n from public.audit_log where entity_type='app_connections'")).rows[0].n;
    await denied(() => review('admin', first, { contact: created.id }), '40001');
    assert.equal((await as('editor', "select count(*)::int n from public.audit_log where entity_type='app_connections'")).rows[0].n, auditBeforeConflict);
    assert.equal((await as('editor', 'select contact_id from public.app_connections where id=$1', [first.id])).rows[0].contact_id, person.id);
    assert.equal((await as('second', 'select * from public.staff_roles')).rows.length, 0);
    assert.equal((await as('editor', "select count(*)::int n from public.care_assignments where contact_id=$1 and care_role='welcome'", [created.id])).rows[0].n, 1);
  });

  await t.test('profile updates reopen pending review, retain the person and original welcome date, and cannot be relinked accidentally', async () => {
    const before = (await as('editor', 'select * from public.app_connections where id=$1', [first.id])).rows[0];
    const originalWelcome = (await as('editor', "select * from public.care_assignments where contact_id=$1 and care_role='welcome'", [person.id])).rows[0];
    first = await save('first', { first_name: 'Revised', phone: '555-0199', preferred_contact: 'phone' });
    assert.equal(first.version, 2);
    const pending = (await as('editor', 'select * from public.app_connections where id=$1', [first.id])).rows[0];
    assert.equal(pending.status, 'pending');
    assert.equal(pending.contact_id, person.id);
    assert.equal(pending.reviewed_version, 1);
    assert.deepEqual(pending.submitted_at, before.submitted_at);
    assert.equal(pending.staff_notes, before.staff_notes);
    await denied(() => review('editor', first, { version: 1, contact: person.id }), '40001');
    await denied(() => review('editor', first, { create: true }), '22023');
    const anotherContact = (await as('editor', 'select contact_id from public.app_connections where id=$1', [second.id])).rows[0].contact_id;
    await denied(() => review('editor', first, { contact: anotherContact }), '22023');
    await review('editor', first, { contact: person.id });
    assert.deepEqual((await as('editor', 'select * from public.contacts where id=$1', [person.id])).rows[0], person);
    assert.deepEqual((await as('editor', "select * from public.care_assignments where contact_id=$1 and care_role='welcome'", [person.id])).rows[0], originalWelcome);
    const own = await mine('first');
    assert.equal(own.first_name, 'Revised');
    assert.equal('staff_notes' in own, false);
  });

  await t.test('migration preserves existing visits and plans while allowing independent role cadences', async () => {
    const migratedPlan = (await as('editor', 'select * from public.care_assignments where id=$1', [legacyPlan.id])).rows[0];
    const migratedVisit = (await as('editor', 'select * from public.care_visits where id=$1', [legacyVisit.id])).rows[0];
    for (const [key, value] of Object.entries(legacyPlan)) assert.deepEqual(migratedPlan[key], value);
    for (const [key, value] of Object.entries(legacyVisit)) assert.deepEqual(migratedVisit[key], value);
    assert.equal(migratedPlan.care_role, 'deacon');
    assert.equal(migratedVisit.care_role, 'deacon');
    await as('editor', "update public.care_assignments set cadence_months=3 where id=$1", [legacyPlan.id]);
    const teacher = (await as('editor', "insert into public.care_assignments(contact_id,care_role,cadence_months) values ($1,'sunday_school',1) returning *", [person.id])).rows[0];
    assert.equal(teacher.cadence_months, 1);
    await denied(() => as('editor', "insert into public.care_assignments(contact_id,care_role) values ($1,'sunday_school')", [person.id]), '23505');
    await denied(() => as('editor', "update public.care_assignments set care_role='custom' where id=$1", [teacher.id]), '23514');
    for (const months of [0,13]) await denied(() => as('editor', 'update public.care_assignments set cadence_months=$2 where id=$1', [teacher.id, months]), '23514');
    await denied(() => as('editor', "insert into public.care_assignments(contact_id,care_role) values ($1,'unknown')", [person.id]), '23514');
    await as('editor', "insert into public.care_visits(contact_id,care_role,visitor_name,contacted_on,method,outcome) values ($1,'sunday_school','Fixture teacher','2026-09-07','call','contacted')", [person.id]);
    await denied(() => as('editor', "update public.care_visits set care_role='sunday_school' where id=$1", [legacyVisit.id]));
    assert.equal((await as('editor', 'select count(*)::int n from public.care_visits where contact_id=$1', [person.id])).rows[0].n, 2);
  });

  await t.test('self-read reflects a newly verified Auth email without changing the office intake until submission', async () => {
    const before = (await as('editor', 'select * from public.app_connections where id=$1', [first.id])).rows[0];
    await pg.query('update auth.users set email=$2 where id=$1', [ids.first, 'changed@example.invalid']);
    const own = await mine('first');
    assert.equal(own.email, 'changed@example.invalid');
    assert.equal(own.version, before.version);
    assert.deepEqual((await as('editor', 'select * from public.app_connections where id=$1', [first.id])).rows[0], before);
    first = await save('first', { first_name: 'Revised' });
    const after = (await as('editor', 'select * from public.app_connections where id=$1', [first.id])).rows[0];
    assert.equal(after.email, 'changed@example.invalid');
    assert.equal(after.version, before.version + 1);
    assert.equal(after.status, 'pending');
    assert.equal(after.contact_id, person.id);
    assert.deepEqual((await as('editor', 'select * from public.contacts where id=$1', [person.id])).rows[0], person);
  });

  await t.test('forged claims and immediate staff revocation cannot bypass review or privacy', async () => {
    await pg.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ user_metadata: { role: 'admin' }, app_metadata: { role: 'admin' } })]);
    await denied(() => review('first', first, { contact: person.id }));
    await pg.query('delete from public.staff_roles where user_id=$1', [ids.editor]);
    assert.equal((await as('editor', 'select * from public.app_connections')).rows.length, 0);
    await denied(() => review('editor', first, { contact: person.id }));
    await pg.query('update auth.users set email_confirmed_at=null where id=$1', [ids.first]);
    await denied(() => save('first'));
    await denied(() => mine('first'));
  });
});
