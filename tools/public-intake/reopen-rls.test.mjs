// Historical before/after proof uses the byte-identical seven-migration snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../admin/tests/package.json', import.meta.url));
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const baselineBytes = await readFile(new URL('../office-preflight/history/manifest-seven-2026-09-08.json', import.meta.url));
const baseline = JSON.parse(baselineBytes);
const optional = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const ids = Object.fromEntries(['admin', 'editor', 'viewer', 'first', 'second', 'unverified', 'anonymous', 'unknown', 'deleted', 'banned', 'expired_ban', 'null_email', 'blank_email'].map((name, index) => [name, `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]));
const denied = (operation, code = '42501') => assert.rejects(operation, error => error.code === code);

// The fixture models Auth/storage contracts only; all office definitions and ACLs
// come from the checked baseline and the separate, unapplied migration packet.
test('the optional intake reopening hardens Auth eligibility and preserves own-profile and staff-review boundaries', async t => {
  assert.equal(baseline.sql_files.length, 7);
  assert.match(baseline.sql_files.at(-1).path, /_pause_public_app_intake\.sql$/);
  assert.equal(optional.status, 'prepared_not_applied');
  assert.equal(optional.baseline.manifest_path, 'tools/office-preflight/manifest.json');
  assert.equal(optional.baseline.manifest_sha256, digest(baselineBytes));
  assert.equal(optional.baseline.sql_file_count, baseline.sql_files.length);
  assert.equal(optional.baseline.schema_revision, baseline.schema_revision);
  assert.ok(optional.migration.path.startsWith('tools/public-intake/'));
  assert.equal(baseline.sql_files.some(row => row.path === optional.migration.path), false);
  const pg = new PGlite({ extensions: { pgcrypto } });
  t.after(() => pg.close());
  await pg.exec(`
    create role anon nologin; create role authenticated nologin;
    create role intake_public_only nologin;
    create schema auth;
    create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, is_anonymous boolean not null default false, deleted_at timestamptz, banned_until timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, intake_public_only;
    grant execute on function auth.uid() to anon, authenticated, intake_public_only;
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, unique(bucket_id, name));
    alter table storage.objects enable row level security;
    grant usage on schema public, storage to anon, authenticated, intake_public_only;
    grant select, insert, update, delete on storage.objects to anon, authenticated;
  `);
  for (const row of baseline.sql_files) {
    const source = await readFile(new URL('../../' + row.path, import.meta.url), 'utf8');
    assert.equal(digest(source), row.sha256);
    await pg.exec(source);
  }
  // Permit schema lookup for the unrelated role so its denial proves that a
  // PUBLIC function grant cannot leak through, independently of schema access.
  await pg.exec('grant usage on schema private to intake_public_only');
  for (const [name, id] of Object.entries(ids).filter(([name]) => name !== 'unknown')) {
    await pg.query('insert into auth.users(id,email,email_confirmed_at,is_anonymous) values ($1,$2,$3,$4)', [id, `${name}@example.invalid`, name === 'unverified' ? null : '2026-09-08T00:00:00Z', name === 'anonymous']);
    if (['admin', 'editor', 'viewer'].includes(name)) await pg.query('insert into public.staff_roles(user_id,role) values ($1,$2)', [id, name]);
  }
  await pg.query('update auth.users set email=null where id=$1', [ids.null_email]);
  await pg.query("update auth.users set email='   ' where id=$1", [ids.blank_email]);
  await pg.query('update auth.users set deleted_at=now() where id=$1', [ids.deleted]);
  await pg.query("update auth.users set banned_until=now()+interval '1 day' where id=$1", [ids.banned]);
  await pg.query("update auth.users set banned_until=now()-interval '1 day' where id=$1", [ids.expired_ban]);
  const existingOther = (await pg.query("insert into public.app_connections(auth_user_id,first_name,last_name,email,preferred_contact,contact_permission,staff_notes) values ($1,'Existing','Synthetic','second@example.invalid','email',true,'Private synthetic review note') returning *", [ids.second])).rows[0];
  async function as(name, query, params = []) {
    await pg.exec('reset role');
    await pg.query("select set_config('request.jwt.claim.sub',$1,false)", [name === 'public_only' || name === 'anon' ? ids.first : ids[name] ?? '']);
    const role = name === 'anon' ? 'anon' : name === 'public_only' ? 'intake_public_only' : 'authenticated';
    await pg.exec(`set role ${role}`);
    try { return await pg.query(query, params); }
    finally { await pg.exec('reset role'); }
  }
  const save = (name, schema = 'public', firstName = 'Synthetic profile') => as(name, `select ${schema}.save_app_connection($1,$2,$3,$4,$5,$6) result`, [firstName, 'Fixture', null, 'email', true, null]).then(result => result.rows[0].result);
  const mine = (name, schema = 'public') => as(name, `select ${schema}.get_my_app_connection() result`).then(result => result.rows[0].result);
  const review = (name, connection, { schema = 'public', contact = null, create = true, version = connection.version } = {}) => as(name, `select ${schema}.review_app_connection($1,$2,$3,$4,$5,$6) result`, [connection.id, version, contact, create, 'Private synthetic review note', 'Synthetic welcome owner']).then(result => result.rows[0].result);
  const rows = async table => (await pg.query(`select to_jsonb(r) data from ${table} r order by to_jsonb(r)::text`)).rows;
  const snapshot = async () => {
    const state = {};
    for (const table of ['auth.users', ...baseline.prerequisite_tables.map(name => 'public.' + name), 'storage.buckets', 'storage.objects']) state[table] = await rows(table);
    return state;
  };
  const inventory = async () => ({
    functions: (await pg.query(`select n.nspname schema,p.proname name,pg_get_function_identity_arguments(p.oid) arguments,
      p.prosecdef definer,p.proconfig settings,p.proowner owner,pg_get_functiondef(p.oid) definition,p.proacl::text acl,
      has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
      has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_execute,
      has_function_privilege('intake_public_only',p.oid,'EXECUTE') public_execute
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','private','auth','storage') and p.prokind in ('f','p')
      order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)`)).rows,
    relations: (await pg.query(`select n.nspname schema,c.relname name,c.relkind kind,c.relowner owner,c.relrowsecurity rls,c.relforcerowsecurity force_rls,c.relacl::text acl
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','private','auth','storage') order by n.nspname,c.relname`)).rows,
    policies: (await pg.query("select * from pg_policies where schemaname in ('public','private','auth','storage') order by schemaname,tablename,policyname")).rows,
    schemaGrants: (await pg.query("select nspname,nspowner,nspacl::text from pg_namespace where nspname in ('public','private','auth','storage') order by nspname")).rows,
    defaults: (await pg.query('select to_jsonb(r) data from pg_default_acl r order by to_jsonb(r)::text')).rows,
  });
  const beforeData = await snapshot();
  const beforeInventory = await inventory();
  const saveRoutines = beforeInventory.functions.filter(row => ['public', 'private'].includes(row.schema) && row.name === 'save_app_connection');
  assert.equal(saveRoutines.length, 2);
  for (const routine of saveRoutines) {
    assert.equal(routine.authenticated_execute, false, 'the baseline must still be paused');
    assert.equal(routine.anon_execute, false); assert.equal(routine.public_execute, false);
  }
  for (const name of ['first', 'admin', 'editor', 'viewer', 'anon', 'public_only']) {
    for (const schema of ['public', 'private']) await denied(() => save(name, schema));
  }
  assert.deepEqual(await snapshot(), beforeData);
  const optionalSql = await readFile(new URL('../../' + optional.migration.path, import.meta.url), 'utf8');
  assert.equal(digest(optionalSql), optional.migration.sha256);
  await pg.exec(optionalSql);

  await t.test('only the verifier definition and two submission ACLs change; all data, other definitions, security settings and grants are preserved', async () => {
    assert.deepEqual(await snapshot(), beforeData);
    const after = await inventory();
    for (const key of ['relations', 'policies', 'schemaGrants', 'defaults']) assert.deepEqual(after[key], beforeInventory[key]);
    assert.equal(after.functions.length, beforeInventory.functions.length);
    let changed = 0, hardened = 0;
    for (let i = 0; i < after.functions.length; i++) {
      const current = after.functions[i], previous = beforeInventory.functions[i];
      if (['public', 'private'].includes(current.schema) && current.name === 'save_app_connection') {
        const { acl: _newAcl, authenticated_execute: _newAuthenticated, ...currentUnchanged } = current;
        const { acl: _oldAcl, authenticated_execute: _oldAuthenticated, ...previousUnchanged } = previous;
        assert.deepEqual(currentUnchanged, previousUnchanged);
        assert.equal(current.authenticated_execute, true);
        assert.equal(current.anon_execute, false); assert.equal(current.public_execute, false);
        assert.notEqual(current.acl, previous.acl); changed++;
      } else if (current.schema === 'private' && current.name === 'verified_connection_email') {
        const { definition: currentDefinition, ...currentUnchanged } = current;
        const { definition: previousDefinition, ...previousUnchanged } = previous;
        assert.deepEqual(currentUnchanged, previousUnchanged, 'hardening must retain the verifier ACL, security mode and search path');
        assert.notEqual(currentDefinition, previousDefinition); hardened++;
      } else assert.deepEqual(current, previous);
    }
    assert.equal(changed, 2); assert.equal(hardened, 1);
  });

  await t.test('both entry points accept verified normal/staff users and expired bans only for their own identity', async () => {
    for (const name of ['first', 'admin', 'editor', 'viewer', 'expired_ban']) {
      const first = await save(name, 'public', 'Public synthetic ' + name);
      const revised = await save(name, 'private', 'Private synthetic ' + name);
      assert.equal(first.id, revised.id); assert.equal(first.version, 1); assert.equal(revised.version, 2);
      for (const schema of ['public', 'private']) {
        const own = await mine(name, schema);
        assert.equal(own.id, first.id); assert.equal(own.email, `${name}@example.invalid`);
        assert.equal(own.first_name, 'Private synthetic ' + name);
        assert.equal('auth_user_id' in own, false); assert.equal('staff_notes' in own, false);
        assert.equal('reviewed_by' in own, false); assert.equal('contact_id' in own, false);
      }
      const stored = (await pg.query('select auth_user_id,status from public.app_connections where id=$1', [first.id])).rows[0];
      assert.equal(stored.auth_user_id, ids[name]); assert.equal(stored.status, 'pending');
    }
    assert.deepEqual((await pg.query('select * from public.app_connections where id=$1', [existingOther.id])).rows[0], existingOther);
    assert.equal((await pg.query('select count(*)::int n from public.contacts')).rows[0].n, 0, 'submitting is not staff review');
  });

  await t.test('missing, anonymous, unconfirmed, deleted, banned, unknown and emailless identities plus anon/PUBLIC callers remain denied', async () => {
    const before = await snapshot();
    for (const name of ['missing', 'anonymous', 'unverified', 'deleted', 'banned', 'unknown', 'null_email', 'blank_email', 'anon', 'public_only']) {
      for (const schema of ['public', 'private']) {
        await denied(() => save(name, schema));
        await denied(() => mine(name, schema));
      }
    }
    assert.deepEqual(await snapshot(), before);
  });

  await t.test('no direct table writes or JWT metadata can turn profile submission into staff powers', async () => {
    const before = await snapshot();
    await pg.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ user_metadata: { role: 'admin', is_admin: true }, app_metadata: { role: 'admin' } })]);
    for (const name of ['first', 'viewer', 'admin', 'editor']) {
      await denied(() => as(name, "insert into public.app_connections(auth_user_id,first_name,last_name,email,preferred_contact,contact_permission) values ($1,'Direct','Bypass','bypass@example.invalid','email',true)", [ids.second]));
      await denied(() => as(name, "update public.app_connections set status='reviewed' where id=$1", [existingOther.id]));
      await denied(() => as(name, 'delete from public.app_connections where id=$1', [existingOther.id]));
      await denied(() => as(name, 'insert into public.staff_roles(user_id,role) values ($1,\'admin\')', [ids.first]));
    }
    for (const name of ['first', 'viewer', 'unknown']) {
      for (const schema of ['public', 'private']) await denied(() => review(name, existingOther, { schema }));
    }
    assert.equal((await as('first', 'select * from public.staff_roles')).rows.length, 0);
    assert.deepEqual(await snapshot(), before);
    await pg.query("select set_config('request.jwt.claims','{}',false)");
  });

  await t.test('other-person records and private review data remain isolated while a member edits their own profile', async () => {
    const otherBefore = (await pg.query('select * from public.app_connections where id=$1', [existingOther.id])).rows[0];
    const ownBefore = await mine('first');
    const update = await save('first', 'private', 'Revised own synthetic profile');
    assert.equal(update.id, ownBefore.id); assert.equal(update.version, ownBefore.version + 1);
    assert.equal((await mine('second')).id, existingOther.id);
    assert.deepEqual((await pg.query('select * from public.app_connections where id=$1', [existingOther.id])).rows[0], otherBefore);
    for (const name of ['first', 'second', 'viewer']) {
      assert.equal((await as(name, 'select * from public.app_connections')).rows.length, 0);
      assert.equal((await as(name, "select * from public.audit_log where entity_type='app_connections'")).rows.length, 0);
    }
    for (const name of ['first', 'second']) {
      assert.equal((await as(name, 'select * from public.contacts')).rows.length, 0);
      assert.equal('staff_notes' in await mine(name), false);
    }
  });

  await t.test('staff review creates exactly one visitor and welcome plan, and identical retries make no audit or record changes', async () => {
    const connection = await mine('first');
    const reviewed = await review('editor', connection);
    const contact = (await pg.query('select * from public.contacts where id=$1', [reviewed.contact_id])).rows[0];
    assert.equal(contact.status, 'visitor'); assert.equal(contact.needs_review, true);
    assert.equal(contact.membership_number, null); assert.equal(contact.email, 'first@example.invalid');
    const plans = (await pg.query("select * from public.care_assignments where contact_id=$1 and care_role='welcome'", [contact.id])).rows;
    assert.equal(plans.length, 1); assert.equal(plans[0].one_time, true);
    const afterReview = await snapshot();
    assert.deepEqual(await review('admin', connection, { schema: 'private' }), { ...reviewed, already_reviewed: true });
    assert.deepEqual(await snapshot(), afterReview, 'retry must not duplicate a contact, plan, audit event or metadata update');
    assert.equal((await pg.query('select count(*)::int n from public.contacts')).rows[0].n, 1);
    assert.equal((await pg.query("select count(*)::int n from public.care_assignments where care_role='welcome'")).rows[0].n, 1);
    const edited = await save('first', 'public', 'Edited after review');
    const pending = (await pg.query('select * from public.app_connections where id=$1', [connection.id])).rows[0];
    assert.equal(pending.status, 'pending'); assert.equal(pending.contact_id, contact.id);
    assert.equal(pending.version, connection.version + 1); assert.equal(pending.reviewed_version, connection.version);
    assert.equal(pending.staff_notes, 'Private synthetic review note');
    await denied(() => review('admin', edited, { contact: contact.id, create: false, version: connection.version }), '40001');
    const rereviewed = await review('admin', edited, { schema: 'private', contact: contact.id, create: false });
    assert.deepEqual((await pg.query('select * from public.contacts where id=$1', [contact.id])).rows[0], contact);
    assert.deepEqual((await pg.query("select * from public.care_assignments where contact_id=$1 and care_role='welcome'", [contact.id])).rows, plans);
    const afterRereview = await snapshot();
    assert.deepEqual(await review('editor', edited, { contact: contact.id, create: false }), { ...rereviewed, already_reviewed: true });
    assert.deepEqual(await snapshot(), afterRereview);
  });

  await t.test('reapplying the optional transaction preserves the current catalog, privileges and all data', async () => {
    const beforeRetryData = await snapshot();
    const beforeRetryInventory = await inventory();
    await pg.exec(optionalSql);
    assert.deepEqual(await snapshot(), beforeRetryData);
    assert.deepEqual(await inventory(), beforeRetryInventory);
  });
});
