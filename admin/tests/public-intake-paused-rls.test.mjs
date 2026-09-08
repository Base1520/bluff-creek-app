import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const manifest = JSON.parse(await readFile(new URL('../../tools/office-preflight/manifest.json', import.meta.url), 'utf8'));
const pausePath = 'supabase/migrations/20260908220718_pause_public_app_intake.sql';
const ids = Object.fromEntries(['admin', 'editor', 'viewer', 'member', 'other', 'anonymous'].map((role, index) => [role, `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]));
const denied = operation => assert.rejects(operation, error => error.code === '42501');

test('the complete staff-first packet pauses submission at both function boundaries while preserving review and read access', async t => {
  assert.equal(manifest.sql_files.length, 7);
  assert.equal(manifest.sql_files.at(-1).path, pausePath);
  const pg = new PGlite({ extensions: { pgcrypto } });
  t.after(() => pg.close());
  await pg.exec(`
    create role anon nologin; create role authenticated nologin; create role intake_outsider nologin;
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
  const sql = [];
  for (const row of manifest.sql_files) {
    const source = await readFile(new URL('../../' + row.path, import.meta.url), 'utf8');
    assert.equal(createHash('sha256').update(source).digest('hex'), row.sha256);
    sql.push(source);
  }
  for (const source of sql.slice(0, -1)) await pg.exec(source);
  for (const [role, id] of Object.entries(ids)) {
    await pg.query('insert into auth.users(id,email,email_confirmed_at,is_anonymous) values ($1,$2,$3,$4)', [id, `${role}@example.invalid`, '2026-09-08', role === 'anonymous']);
    if (['admin', 'editor', 'viewer'].includes(role)) await pg.query('insert into public.staff_roles(user_id,role) values ($1,$2)', [id, role]);
  }
  async function as(role, query, params = []) {
    await pg.exec('reset role');
    await pg.query("select set_config('request.jwt.claim.sub',$1,false)", [ids[role] || '']);
    await pg.exec(`set role ${role === 'anon' ? 'anon' : 'authenticated'}`);
    try { return await pg.query(query, params); }
    finally { await pg.exec('reset role'); }
  }
  const submission = schema => `select ${schema}.save_app_connection('Synthetic','Profile',null,'email',true,null) result`;
  const mine = role => as(role, 'select public.get_my_app_connection() result').then(result => result.rows[0].result);
  const snapshot = async () => Object.fromEntries(await Promise.all(['app_connections', 'contacts', 'care_assignments', 'audit_log', 'staff_roles', 'auth.users'].map(async name => {
    const table = name.includes('.') ? name : 'public.' + name;
    return [name, (await pg.query(`select to_jsonb(r) data from ${table} r order by to_jsonb(r)::text`)).rows];
  })));
  const first = (await as('member', submission('public'))).rows[0].result;
  const other = (await as('other', submission('private'))).rows[0].result;
  const readiness = (await as('admin', 'select public.office_readiness() result')).rows[0].result;
  const before = await snapshot();
  await pg.exec(sql.at(-1));

  await t.test('migration preserves all preexisting rows and leaves the staff capability revision unchanged', async () => {
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual((await as('admin', 'select public.office_readiness() result')).rows[0].result, readiness);
    assert.equal(readiness.schema_revision, '20260907174301');
  });

  await t.test('anonymous, verified members and every staff role cannot create or update through either submission function', async () => {
    for (const role of ['anon', 'anonymous', 'member', 'other', 'viewer', 'editor', 'admin']) {
      for (const schema of ['public', 'private']) await denied(() => as(role, submission(schema)));
    }
    assert.deepEqual(await snapshot(), before, 'denied creates and updates must not add rows, audit events or versions');
  });

  await t.test('PUBLIC inheritance and both explicit browser-role grants are absent; own-read and review grants remain', async () => {
    const routines = (await pg.query(`select n.nspname schema,p.proname name,p.prosecdef definer,
      has_function_privilege('anon',p.oid,'EXECUTE') anon_exec,
      has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_exec,
      has_function_privilege('intake_outsider',p.oid,'EXECUTE') public_exec
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where p.proname in ('save_app_connection','get_my_app_connection','review_app_connection') order by schema,name`)).rows;
    assert.equal(routines.length, 6);
    for (const routine of routines) {
      assert.equal(routine.anon_exec, false); assert.equal(routine.public_exec, false);
      assert.equal(routine.authenticated_exec, routine.name !== 'save_app_connection');
      assert.equal(routine.definer, routine.schema === 'private');
    }
  });

  await t.test('existing member reads remain isolated and reveal no staff notes; outsiders cannot bypass tables', async () => {
    assert.equal((await mine('member')).id, first.id); assert.equal((await mine('other')).id, other.id);
    assert.equal('staff_notes' in await mine('member'), false);
    for (const role of ['anon', 'anonymous']) await denied(() => mine(role));
    for (const role of ['member', 'other', 'viewer']) assert.equal((await as(role, 'select * from public.app_connections')).rows.length, 0);
    for (const role of ['member', 'editor', 'admin']) await denied(() => as(role, "insert into public.app_connections(auth_user_id,first_name,last_name,email,preferred_contact,contact_permission) values ($1,'Direct','Bypass','synthetic@example.invalid','email',true)", [ids[role]]));
    assert.deepEqual(await snapshot(), before);
  });

  await t.test('editors and admins can still review existing pending profiles and create one-time welcome plans', async () => {
    for (const [role, connection] of [['editor', first], ['admin', other]]) {
      assert.equal((await as(role, 'select * from public.app_connections')).rows.length, 2);
      const params = [connection.id, connection.version, null, true, 'Synthetic review note', 'Synthetic welcome owner'];
      const reviewed = (await as(role, 'select public.review_app_connection($1,$2,$3,$4,$5,$6) result', params)).rows[0].result;
      const person = (await as(role, 'select * from public.contacts where id=$1', [reviewed.contact_id])).rows[0];
      assert.equal(person.status, 'visitor'); assert.equal(person.needs_review, true);
      const plan = (await as(role, 'select * from public.care_assignments where contact_id=$1', [person.id])).rows[0];
      assert.equal(plan.care_role, 'welcome'); assert.equal(plan.one_time, true);
    }
    assert.equal((await mine('member')).id, first.id); assert.equal('staff_notes' in await mine('member'), false);
    await denied(() => as('member', 'select public.review_app_connection($1,1,null,true,null,null)', [first.id]));
  });
});
