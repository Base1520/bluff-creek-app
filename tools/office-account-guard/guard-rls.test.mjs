import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../admin/tests/package.json', import.meta.url));
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const baselineBytes = await readFile(new URL('../office-preflight/manifest.json', import.meta.url));
const baseline = JSON.parse(baselineBytes);
const optional = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const denied = operation => assert.rejects(operation, error => error.code === '42501');

test('the optional staff guard enforces current account eligibility without broadening or rewriting existing permissions', async t => {
  assert.equal(baseline.sql_files.length, 7);
  assert.equal(baseline.prerequisite_tables.length, 17);
  assert.match(baseline.sql_files.at(-1).path, /_pause_public_app_intake\.sql$/);
  assert.equal(optional.state, 'prepared_not_applied');
  assert.equal(optional.baseline_manifest_sha256, digest(baselineBytes));
  assert.equal(optional.active_migration_manifest_changed, false);
  assert.equal(optional.hosted_applied, false);
  assert.match(optional.migration.path, /^tools\/office-account-guard\/migrations\/\d{14}_require_eligible_staff_auth_account\.sql$/);
  assert.equal(baseline.sql_files.some(row => row.path === optional.migration.path), false);
  const optionalSql = await readFile(new URL('../../' + optional.migration.path, import.meta.url), 'utf8');
  assert.equal(digest(optionalSql), optional.migration.sha256);

  const pg = new PGlite({ extensions: { pgcrypto } });
  t.after(() => pg.close());
  // Auth and Storage provide only their required fixture contracts. There is
  // deliberately no auth.sessions table: this guard must not promise or require
  // immediate global session revocation. These are not signed HTTP/JWT tests.
  await pg.exec(`
    create role anon nologin; create role authenticated nologin; create role guard_public_only nologin;
    create schema auth;
    create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz,
      is_anonymous boolean default false, deleted_at timestamptz, banned_until timestamptz, invited_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, guard_public_only;
    grant execute on function auth.uid() to anon, authenticated, guard_public_only;
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, unique(bucket_id, name));
    alter table storage.objects enable row level security;
    grant usage on schema public, storage to anon, authenticated, guard_public_only;
    grant select, insert, update, delete on storage.objects to anon, authenticated;
  `);
  for (const row of baseline.sql_files) {
    const source = await readFile(new URL('../../' + row.path, import.meta.url));
    assert.equal(digest(source), row.sha256);
    await pg.exec(source.toString('utf8'));
  }
  // Schema access lets the PUBLIC-only execution probe reach the actual ACL.
  await pg.exec('grant usage on schema private to anon, guard_public_only');
  const cases = [
    { name: 'admin', role: 'admin', eligible: true },
    { name: 'editor', role: 'editor', eligible: true },
    { name: 'viewer', role: 'viewer', eligible: true },
    { name: 'expired_ban', role: 'editor', eligible: true, change: "banned_until=now()-interval '1 second'" },
    { name: 'banned_admin', role: 'admin', change: "banned_until=now()+interval '1 day'" },
    { name: 'banned_editor', role: 'editor', change: "banned_until=now()+interval '1 day'" },
    { name: 'deleted', role: 'admin', change: 'deleted_at=now()' },
    { name: 'unconfirmed', role: 'admin', change: 'email_confirmed_at=null' },
    { name: 'invited', role: 'editor', change: 'email_confirmed_at=null,invited_at=now()' },
    { name: 'anonymous', role: 'admin', change: 'is_anonymous=true' },
    { name: 'unknown_anonymous_state', role: 'admin', change: 'is_anonymous=null' },
    { name: 'null_email', role: 'admin', change: 'email=null' },
    { name: 'blank_email', role: 'admin', change: "email='   '" },
    { name: 'hard_deleted', role: 'admin', removeUser: true, baselineDenied: true },
    { name: 'revoked', role: 'admin', removeRole: true, baselineDenied: true },
    { name: 'outsider', baselineDenied: true },
    { name: 'unknown', absent: true, baselineDenied: true },
    { name: 'null_uid', absent: true, baselineDenied: true },
  ];
  const identities = Object.fromEntries(cases.map((item, index) => [item.name, {
    ...item, id: item.name === 'null_uid' ? '' : `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  }]));
  for (const item of Object.values(identities)) {
    if (item.absent) continue;
    await pg.query('insert into auth.users(id,email,email_confirmed_at,is_anonymous) values ($1,$2,now(),false)', [item.id, `${item.name}@example.invalid`]);
    if (item.role) await pg.query('insert into public.staff_roles(user_id,role) values ($1,$2)', [item.id, item.role]);
    if (item.change) await pg.query('update auth.users set ' + item.change + ' where id=$1', [item.id]);
    if (item.removeUser) await pg.query('delete from auth.users where id=$1', [item.id]);
    if (item.removeRole) await pg.query('delete from public.staff_roles where user_id=$1', [item.id]);
    if (!item.removeUser) await pg.query(`insert into public.app_connections
      (auth_user_id,first_name,last_name,email,preferred_contact,contact_permission,staff_notes)
      values ($1,'Synthetic','Profile',$2,'email',true,'Private synthetic staff review')`, [item.id, `${item.name}@example.invalid`]);
  }
  await pg.exec(`insert into public.contacts(first_name,last_name) values ('Synthetic','Guard fixture');
    insert into public.events(title,starts_at) values ('Synthetic fixture event',now());`);
  await pg.query("insert into storage.objects(bucket_id,name) values ('church-documents',$1)", [`${identities.admin.id}/synthetic-page.txt`]);

  // Successful write-permission probes roll back explicitly. Other successful
  // statements commit, so later snapshots detect unintended side effects of
  // reads or allegedly blocked zero-row updates; errors always roll back.
  async function as(name, query, params = [], { rollback = false } = {}) {
    const item = identities[name] ?? identities.admin;
    const role = name === 'anon' ? 'anon' : name === 'public_only' ? 'guard_public_only' : 'authenticated';
    await pg.exec('begin');
    try {
      await pg.query("select set_config('request.jwt.claim.sub',$1,true)", [item.id]);
      await pg.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: item.id, role, session_id: identities.admin.id, user_metadata: { role: 'admin' } })]);
      await pg.exec(`set local role ${role}`);
      const result = await pg.query(query, params);
      await pg.exec(rollback ? 'rollback' : 'commit');
      return result;
    } catch (error) {
      await pg.exec('rollback');
      throw error;
    }
  }
  const snapshot = async () => {
    const state = {};
    for (const table of ['auth.users', ...baseline.prerequisite_tables.map(name => 'public.' + name), 'storage.buckets', 'storage.objects']) {
      state[table] = (await pg.query(`select to_jsonb(r) data from ${table} r order by to_jsonb(r)::text`)).rows;
    }
    return state;
  };
  const inventory = async () => ({
    functions: (await pg.query(`select p.oid,n.nspname schema,p.proname name,pg_get_function_identity_arguments(p.oid) arguments,
      p.prosecdef definer,p.provolatile volatility,p.proisstrict strict,p.proleakproof leakproof,p.proparallel parallel,
      p.prorettype::regtype::text return_type,p.prolang language,p.proconfig settings,p.proowner owner,
      pg_get_functiondef(p.oid) definition,p.proacl::text acl,
      has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
      has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_execute,
      has_function_privilege('guard_public_only',p.oid,'EXECUTE') public_execute
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','private','auth','storage') and p.prokind in ('f','p')
      order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)`)).rows,
    relations: (await pg.query(`select n.nspname schema,c.relname name,c.relkind kind,c.relowner owner,
      c.relrowsecurity rls,c.relforcerowsecurity force_rls,c.relacl::text acl
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','private','auth','storage') order by n.nspname,c.relname`)).rows,
    policies: (await pg.query("select * from pg_policies where schemaname in ('public','private','auth','storage') order by schemaname,tablename,policyname")).rows,
    schemaGrants: (await pg.query("select nspname,nspowner,nspacl::text from pg_namespace where nspname in ('public','private','auth','storage') order by nspname")).rows,
    defaults: (await pg.query('select to_jsonb(r) data from pg_default_acl r order by to_jsonb(r)::text')).rows,
    roleMemberships: (await pg.query('select to_jsonb(r) data from pg_auth_members r order by to_jsonb(r)::text')).rows,
    constraints: (await pg.query("select c.oid,pg_get_constraintdef(c.oid) definition from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in ('public','private','auth','storage') order by c.oid")).rows,
    triggers: (await pg.query("select t.oid,pg_get_triggerdef(t.oid) definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','auth','storage') order by t.oid")).rows,
  });
  async function probe(item, allowed) {
    const name = item.name;
    assert.equal((await as(name, 'select private.current_staff_role() role')).rows[0].role, allowed ? item.role : null, `${name}: staff role`);
    assert.equal((await as(name, 'select id from public.contacts')).rows.length, allowed ? 1 : 0, `${name}: contacts`);
    assert.equal((await as(name, 'select id from storage.objects')).rows.length, allowed ? 1 : 0, `${name}: Storage`);
    if (allowed) {
      const readiness = (await as(name, 'select public.office_readiness() result')).rows[0].result;
      assert.equal(readiness.staff_role, item.role);
      assert.equal(readiness.schema_revision, baseline.schema_revision);
    } else await denied(() => as(name, 'select public.office_readiness()'));
    const canWrite = allowed && item.role !== 'viewer';
    for (const sql of ["insert into public.events(title,starts_at) values ('Synthetic probe',now()) returning id",
      "insert into public.contacts(first_name,last_name) values ('Synthetic','Probe') returning id"]) {
      if (canWrite) assert.equal((await as(name, sql, [], { rollback: true })).rows.length, 1);
      else await denied(() => as(name, sql));
    }
    const upload = () => as(name, "insert into storage.objects(bucket_id,name) values ('church-documents',$1) returning id", [`${item.id}/probe.txt`], { rollback: canWrite });
    if (canWrite) assert.equal((await upload()).rows.length, 1);
    else await denied(upload);
  }

  await t.test('baseline reproduces account-state gaps while hard deletion, revoked roles, outsiders and viewers retain existing boundaries', async () => {
    const before = await snapshot();
    for (const item of Object.values(identities)) await probe(item, !item.baselineDenied);
    assert.deepEqual(await snapshot(), before);
  });

  const beforeData = await snapshot();
  const beforeInventory = await inventory();
  await pg.exec(optionalSql);

  await t.test('only the exact existing helper definition changes; ownership, stability, security, ACLs, policies, other routines and all data remain unchanged', async () => {
    assert.deepEqual(await snapshot(), beforeData);
    const after = await inventory();
    for (const key of Object.keys(beforeInventory).filter(key => key !== 'functions')) assert.deepEqual(after[key], beforeInventory[key], key);
    assert.equal(after.functions.length, beforeInventory.functions.length);
    let changed = 0;
    for (let index = 0; index < after.functions.length; index++) {
      const current = after.functions[index], previous = beforeInventory.functions[index];
      if (current.schema === 'private' && current.name === 'current_staff_role' && current.arguments === '') {
        const { definition: currentDefinition, ...currentAttributes } = current;
        const { definition: previousDefinition, ...previousAttributes } = previous;
        assert.notEqual(currentDefinition, previousDefinition);
        assert.deepEqual(currentAttributes, previousAttributes);
        assert.equal(current.definer, true); assert.equal(current.volatility, 's');
        assert.deepEqual(current.settings, ['search_path=""']);
        assert.equal(current.anon_execute, false); assert.equal(current.public_execute, false);
        assert.equal(current.authenticated_execute, true); changed++;
      } else assert.deepEqual(current, previous);
    }
    assert.equal(changed, 1);
  });

  await t.test('current active admin/editor/viewer and expired bans retain precisely their protected read/write capabilities', async () => {
    for (const item of Object.values(identities).filter(item => item.eligible)) await probe(item, true);
    assert.equal((await pg.query("select to_regclass('auth.sessions') relation")).rows[0].relation, null);
    assert.deepEqual(await snapshot(), beforeData);
  });

  await t.test('ineligible accounts and stale identities lose contact/Storage/readiness access and cannot create, update or delete records', async () => {
    for (const item of Object.values(identities).filter(item => !item.eligible)) {
      await probe(item, false);
      for (const sql of ["update public.contacts set first_name='Blocked' returning id",
        "update public.events set title='Blocked' returning id",
        "update storage.objects set name='Blocked' returning id", 'delete from storage.objects returning id']) {
        assert.equal((await as(item.name, sql)).rows.length, 0, `${item.name}: hidden rows cannot be mutated`);
      }
      // The baseline forbids physical contact/event deletion even for active
      // staff; those denials occur at the table ACL before RLS filters rows.
      for (const table of ['contacts', 'events']) await denied(() => as(item.name, `delete from public.${table} returning id`));
    }
    assert.deepEqual(await snapshot(), beforeData, 'denied attempts leave entities, profiles, versions and audit rows unchanged');
  });

  await t.test('own-role rows and separately verified own-profile reads remain limited exceptions, never private office access', async () => {
    for (const item of Object.values(identities)) {
      const ownRoles = (await as(item.name, 'select user_id,role from public.staff_roles')).rows;
      const hasOwnRole = item.role && !item.removeRole && !item.removeUser;
      assert.deepEqual(ownRoles, hasOwnRole ? [{ user_id: item.id, role: item.role }] : []);
      for (const schema of ['public', 'private']) {
        const own = () => as(item.name, `select ${schema}.get_my_app_connection() result`);
        const eligibleForOwnProfile = !item.absent && !item.removeUser && !['unconfirmed', 'invited', 'anonymous', 'null_email', 'blank_email'].includes(item.name);
        if (!eligibleForOwnProfile) { await denied(own); continue; }
        const profile = (await own()).rows[0].result;
        const expected = (await pg.query('select id from public.app_connections where auth_user_id=$1', [item.id])).rows[0];
        assert.equal(profile.id, expected.id);
        for (const field of ['auth_user_id', 'staff_notes', 'reviewed_by', 'contact_id']) assert.equal(field in profile, false);
      }
      if (!item.eligible || item.role === 'viewer') assert.equal((await as(item.name, 'select * from public.app_connections')).rows.length, 0);
      await denied(() => as(item.name, 'insert into public.staff_roles(user_id,role) values ($1,\'admin\')', [identities.outsider.id]));
    }
    assert.deepEqual(await snapshot(), beforeData);
  });

  await t.test('PUBLIC and anonymous callers cannot execute the staff helper; both public-profile submission entry points stay paused for every caller', async () => {
    for (const name of ['anon', 'public_only']) await denied(() => as(name, 'select private.current_staff_role()'));
    for (const routine of (await inventory()).functions.filter(row => ['public', 'private'].includes(row.schema) && row.name === 'save_app_connection')) {
      assert.equal(routine.authenticated_execute, false); assert.equal(routine.anon_execute, false); assert.equal(routine.public_execute, false);
    }
    for (const name of ['anon', 'public_only', ...Object.keys(identities)]) {
      for (const schema of ['public', 'private']) await denied(() => as(name, `select ${schema}.save_app_connection('Synthetic','Blocked',null,'email',true,null)`));
    }
    assert.deepEqual(await snapshot(), beforeData);
  });

  await t.test('an invited staff account gains access only after current confirmation and loses it again when the existing role is revoked', async () => {
    const item = identities.invited;
    await probe(item, false);
    await pg.query('update auth.users set email_confirmed_at=now() where id=$1', [item.id]);
    const confirmed = await snapshot();
    await probe(item, true);
    assert.deepEqual(await snapshot(), confirmed);
    await pg.query('delete from public.staff_roles where user_id=$1', [item.id]);
    const revoked = await snapshot();
    await probe(item, false);
    assert.deepEqual((await as(item.name, 'select * from public.staff_roles')).rows, []);
    assert.deepEqual(await snapshot(), revoked);
  });

  await t.test('reapplying the optional transaction changes neither catalog nor data and leaves all seven active SQL bytes untouched', async () => {
    const data = await snapshot(), catalog = await inventory();
    await pg.exec(optionalSql);
    assert.deepEqual(await snapshot(), data); assert.deepEqual(await inventory(), catalog);
    assert.equal(digest(await readFile(new URL('../office-preflight/manifest.json', import.meta.url))), optional.baseline_manifest_sha256);
    for (const row of baseline.sql_files) assert.equal(digest(await readFile(new URL('../../' + row.path, import.meta.url))), row.sha256);
  });
});
