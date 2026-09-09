import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createArtifacts } from './index.mjs';

const require = createRequire(new URL('../../admin/tests/package.json', import.meta.url));
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const manifest = JSON.parse(await readFile(new URL('../office-preflight/manifest.json', import.meta.url), 'utf8'));
const ids = {
  primary: '00000000-0000-4000-8000-000000000001',
  backup: '00000000-0000-4000-8000-000000000002',
  outside: '00000000-0000-4000-8000-000000000003',
  duplicate: '00000000-0000-4000-8000-000000000004',
};
const input = () => ({
  projectRef: 'xzfeumdonxeodqhfirjr',
  admins: [
    { email: 'primary@example.invalid', userId: ids.primary },
    { email: 'backup@example.invalid', userId: ids.backup },
  ],
});
const sqlFor = value => createArtifacts(value ?? input()).files['staff-admin-setup.sql'];

function summary(results) {
  const rows = results.flatMap(result => result.rows ?? []);
  assert.equal(rows.length, 1, 'the setup packet must return exactly one counts-only row');
  let counts = rows[0];
  if (Object.keys(counts).length === 1) {
    const value = Object.values(counts)[0];
    counts = typeof value === 'string' ? JSON.parse(value) : value;
  }
  assert.deepEqual(Object.keys(counts).sort(), ['already_admin', 'created', 'total_admin_bindings']);
  assert.equal(JSON.stringify(rows).includes('@'), false, 'result rows must not disclose email addresses');
  for (const id of Object.values(ids)) assert.equal(JSON.stringify(rows).includes(id), false, 'result rows must not disclose account IDs');
  return Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)]));
}

test('prepared staff setup binds only the two verified Auth identities, atomically and without altering existing grants', async t => {
  assert.equal(manifest.sql_files.length, 8, 'test the complete staff-first migration sequence');
  assert.match(manifest.sql_files.at(-2).path, /_pause_public_app_intake\.sql$/);
  assert.match(manifest.sql_files.at(-1).path, /20260909124122_require_eligible_staff_auth_account\.sql$/);
  const pg = new PGlite({ extensions: { pgcrypto } });
  t.after(() => pg.close());
  await pg.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users (
      id uuid primary key, email text, email_confirmed_at timestamptz,
      is_anonymous boolean not null default false, invited_at timestamptz,
      deleted_at timestamptz, banned_until timestamptz
    );
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
  for (const row of manifest.sql_files) {
    const source = await readFile(new URL('../../' + row.path, import.meta.url), 'utf8');
    assert.equal(createHash('sha256').update(source).digest('hex'), row.sha256);
    await pg.exec(source);
  }
  const tables = ['auth.users', ...manifest.prerequisite_tables.map(name => 'public.' + name), 'storage.buckets', 'storage.objects'];
  const snapshot = async () => {
    const state = {};
    for (const table of tables) state[table] = (await pg.query(`select to_jsonb(r) data from ${table} r order by to_jsonb(r)::text`)).rows;
    return state;
  };
  const roles = async () => (await pg.query('select user_id, role, created_at, updated_at from public.staff_roles order by user_id')).rows;
  const reset = async () => {
    await pg.exec('delete from auth.users');
    for (const [name, id] of Object.entries(ids).filter(([name]) => name !== 'duplicate')) {
      await pg.query('insert into auth.users(id,email,email_confirmed_at) values ($1,$2,$3)', [id, `${name}@example.invalid`, '2026-09-08T00:00:00Z']);
    }
    await pg.query("insert into public.staff_roles(user_id,role,created_at,updated_at) values ($1,'admin','2001-01-01T00:00:00Z','2002-01-01T00:00:00Z')", [ids.outside]);
  };
  const rejectedUnchanged = async (value = input()) => {
    const before = await snapshot();
    await assert.rejects(() => pg.exec(sqlFor(value)), error => {
      assert.equal(error.code, '42501', 'identity or role denial must use the bounded PostgreSQL validation error');
      return true;
    });
    await pg.exec('rollback');
    assert.deepEqual(await snapshot(), before, 'a rejected pair must leave every office and Auth row unchanged');
  };

  await t.test('confirmed identities receive two admin bindings and no other data changes', async () => {
    await reset();
    const before = await snapshot();
    assert.deepEqual(summary(await pg.exec(sqlFor())), { created: 2, already_admin: 0, total_admin_bindings: 2 });
    const after = await snapshot();
    for (const table of tables.filter(table => table !== 'public.staff_roles')) assert.deepEqual(after[table], before[table]);
    const current = await roles();
    assert.deepEqual(current.map(row => [row.user_id, row.role]), Object.values(ids).slice(0, 3).map(id => [id, 'admin']));
    assert.deepEqual(after['public.staff_roles'].find(row => row.data.user_id === ids.outside), before['public.staff_roles'][0]);
    const intake = (await pg.query(`select n.nspname, has_function_privilege('authenticated',p.oid,'EXECUTE') can_execute
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','private') and p.proname='save_app_connection' order by n.nspname`)).rows;
    assert.equal(intake.length, 2);
    assert.equal(intake.every(row => row.can_execute === false), true, 'staff setup must not reopen public intake');
  });

  await t.test('mixed-case, padded Auth addresses match their normalized requested addresses', async () => {
    await reset();
    await pg.query("update auth.users set email='  PRIMARY@Example.Invalid  ' where id=$1", [ids.primary]);
    await pg.query("update auth.users set email=' BACKUP@example.INVALID ' where id=$1", [ids.backup]);
    assert.deepEqual(summary(await pg.exec(sqlFor())), { created: 2, already_admin: 0, total_admin_bindings: 2 });
  });

  await t.test('apostrophes, comment-looking text and the DO delimiter remain literal email characters', async () => {
    await reset();
    const value = input();
    value.admins[0].email = "o'brien+$office_access$--/*@example.invalid";
    await pg.query('update auth.users set email=$1 where id=$2', [value.admins[0].email, ids.primary]);
    const before = (await snapshot())['auth.users'];
    try {
      assert.deepEqual(summary(await pg.exec(sqlFor(value))), { created: 2, already_admin: 0, total_admin_bindings: 2 });
    } finally {
      // Keep later cases independent even if SQL quoting regresses mid-transaction.
      await pg.exec('rollback');
    }
    assert.deepEqual((await snapshot())['auth.users'], before);
  });

  await t.test('pending invitations are accepted without marking the accounts confirmed', async () => {
    await reset();
    await pg.query('update auth.users set email_confirmed_at=null,invited_at=now() where id in ($1,$2)', [ids.primary, ids.backup]);
    const before = (await snapshot())['auth.users'];
    assert.deepEqual(summary(await pg.exec(sqlFor())), { created: 2, already_admin: 0, total_admin_bindings: 2 });
    assert.deepEqual((await snapshot())['auth.users'], before);
  });

  await t.test('expired bans do not reject otherwise eligible accounts', async () => {
    await reset();
    await pg.query("update auth.users set banned_until=now()-interval '1 day' where id=$1", [ids.backup]);
    assert.deepEqual(summary(await pg.exec(sqlFor())), { created: 2, already_admin: 0, total_admin_bindings: 2 });
  });

  for (const [name, change] of [
    ['missing Auth row', () => pg.query('delete from auth.users where id=$1', [ids.backup])],
    ['wrong stored email', () => pg.query("update auth.users set email='wrong@example.invalid' where id=$1", [ids.backup])],
    ['null stored email', () => pg.query('update auth.users set email=null where id=$1', [ids.backup])],
    ['anonymous account', () => pg.query('update auth.users set is_anonymous=true where id=$1', [ids.backup])],
    ['deleted account', () => pg.query('update auth.users set deleted_at=now() where id=$1', [ids.backup])],
    ['currently banned account', () => pg.query("update auth.users set banned_until=now()+interval '1 day' where id=$1", [ids.backup])],
    ['uninvited, unconfirmed account', () => pg.query('update auth.users set email_confirmed_at=null,invited_at=null where id=$1', [ids.backup])],
    ['ambiguous normalized address', () => pg.query("insert into auth.users(id,email,email_confirmed_at) values ($1,' BACKUP@Example.Invalid ',now())", [ids.duplicate])],
    ['duplicate exact address', () => pg.query("insert into auth.users(id,email,email_confirmed_at) values ($1,'backup@example.invalid',now())", [ids.duplicate])],
  ]) {
    await t.test(`${name} denies the entire pair before creating any grant`, async () => {
      await reset();
      await change();
      await rejectedUnchanged();
      assert.deepEqual((await roles()).map(row => row.user_id), [ids.outside]);
    });
  }

  await t.test('a wrong UUID cannot bind an address to another existing Auth account', async () => {
    await reset();
    const value = input();
    value.admins[1].userId = ids.outside;
    await rejectedUnchanged(value);
  });

  await t.test('swapped UUIDs cannot grant either intended email identity', async () => {
    await reset();
    const value = input();
    [value.admins[0].userId, value.admins[1].userId] = [ids.backup, ids.primary];
    await rejectedUnchanged(value);
  });

  for (const existingRole of ['viewer', 'editor']) {
    await t.test(`an existing ${existingRole} role is not silently promoted, and the other grant is not inserted`, async () => {
      await reset();
      await pg.query("insert into public.staff_roles(user_id,role,created_at,updated_at) values ($1,$2,'2003-01-01','2004-01-01')", [ids.backup, existingRole]);
      await rejectedUnchanged();
    });
  }

  await t.test('one existing admin is preserved byte for byte while only the missing binding is inserted', async () => {
    await reset();
    await pg.query("insert into public.staff_roles(user_id,role,created_at,updated_at) values ($1,'admin','2003-01-01','2004-01-01')", [ids.primary]);
    const existing = (await roles()).filter(row => row.user_id !== ids.backup);
    assert.deepEqual(summary(await pg.exec(sqlFor())), { created: 1, already_admin: 1, total_admin_bindings: 2 });
    assert.deepEqual((await roles()).filter(row => row.user_id !== ids.backup), existing);
  });

  await t.test('rerunning the packet makes no updates, including role timestamps', async () => {
    await reset();
    assert.deepEqual(summary(await pg.exec(sqlFor())), { created: 2, already_admin: 0, total_admin_bindings: 2 });
    const before = await snapshot();
    assert.deepEqual(summary(await pg.exec(sqlFor())), { created: 0, already_admin: 2, total_admin_bindings: 2 });
    assert.deepEqual(await snapshot(), before);
  });

  await t.test('an invalid first identity also prevents granting the valid second identity', async () => {
    await reset();
    await pg.query('update auth.users set is_anonymous=true where id=$1', [ids.primary]);
    await rejectedUnchanged();
  });

  await t.test('an existing admin binding does not waive current Auth eligibility checks', async () => {
    await reset();
    await pg.query("insert into public.staff_roles(user_id,role) values ($1,'admin')", [ids.backup]);
    await pg.query('update auth.users set deleted_at=now() where id=$1', [ids.backup]);
    await rejectedUnchanged();
  });
});
