import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const ids = {
  admin: '00000000-0000-4000-8000-000000000001',
  editor: '00000000-0000-4000-8000-000000000002',
  viewer: '00000000-0000-4000-8000-000000000003',
  outsider: '00000000-0000-4000-8000-000000000004',
};
const privateTables = ['membership_history', 'care_assignments', 'care_visits', 'guest_intakes', 'care_guidelines'];
const rejectsCode = (operation, code) => assert.rejects(operation, error => error.code === code);

test('membership and care migration enforces database privileges, preservation and private source access', async t => {
  const pg = new PGlite({ extensions: { pgcrypto } });
  t.after(() => pg.close());
  await pg.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text,
      unique(bucket_id, name));
    alter table storage.objects enable row level security;
    grant usage on schema public, storage to anon, authenticated;
    grant select, insert, update, delete on storage.objects to anon, authenticated;
  `);
  await pg.exec(await readFile(new URL('../../supabase/migrations/20260908220558_office_base.sql', import.meta.url), 'utf8'));
  // Model pre-2026 broad defaults: the migration must explicitly remove them.
  await pg.exec('alter default privileges in schema public grant all on tables to anon, authenticated');
  await pg.exec(await readFile(new URL('../../supabase/migrations/20260908220613_membership_care.sql', import.meta.url), 'utf8'));
  for (const [role, id] of Object.entries(ids)) {
    await pg.query('insert into auth.users(id) values ($1)', [id]);
    if (role !== 'outsider') await pg.query('insert into public.staff_roles(user_id,role) values ($1,$2)', [id, role]);
  }
  async function as(role, sql, params = []) {
    await pg.exec('reset role');
    await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [ids[role] ?? '']);
    await pg.exec(`set role ${role === 'anon' ? 'anon' : 'authenticated'}`);
    try { return await pg.query(sql, params); }
    finally { await pg.exec('reset role'); }
  }
  async function owner(sql, params = []) {
    await pg.exec('reset role');
    return pg.query(sql, params);
  }
  const contact = (await as('editor', `insert into public.contacts(first_name,last_name,
    legacy_member_id,birth_date_text,received_date_text,needs_review,created_by,created_at)
    values ('Synthetic','Fixture','fixture-001','circa 1950','1950s',true,$1,'1900-01-01') returning *`, [ids.outsider])).rows[0];
  const second = (await as('editor', "insert into public.contacts(first_name,last_name) values ('Second','Fixture') returning *")).rows[0];
  const original = (await as('editor', `insert into public.membership_history(contact_id,event_type,date_text,
    details,created_by,created_at) values ($1,'received','1950s','Synthetic test entry',$2,'1900-01-01') returning *`,
  [contact.id, ids.outsider])).rows[0];
  const visit = (await as('editor', `insert into public.care_visits(contact_id,visitor_name,contacted_on,
    method,outcome,notes) values ($1,'Synthetic Visitor','2026-09-07','call','attempted','Synthetic private note') returning *`,
  [contact.id])).rows[0];
  const assignment = (await as('editor', `insert into public.care_assignments(contact_id,assigned_to,notes)
    values ($1,'Synthetic Assignee','Synthetic assignment note') returning *`, [contact.id])).rows[0];
  const intake = (await as('editor', 'insert into public.guest_intakes(contact_id) values ($1) returning *', [contact.id])).rows[0];

  await t.test('admin/editor can work; viewers retain contacts but cannot read care, history or their audit entries', async () => {
    assert.equal(contact.created_by, ids.editor);
    assert.notEqual(new Date(contact.created_at).getUTCFullYear(), 1900);
    assert.equal(contact.birth_date_text, 'circa 1950');
    assert.equal(contact.received_date_text, '1950s');
    assert.equal(original.created_by, ids.editor);
    assert.notEqual(new Date(original.created_at).getUTCFullYear(), 1900);
    for (const role of ['admin', 'editor']) {
      assert.equal((await as(role, 'select count(*)::int as n from public.membership_history')).rows[0].n, 1);
      assert.equal((await as(role, 'select count(*)::int as n from public.care_visits')).rows[0].n, 1);
    }
    assert.equal((await as('viewer', 'select count(*)::int as n from public.contacts')).rows[0].n, 2);
    for (const table of privateTables) {
      for (const role of ['viewer', 'outsider']) {
        assert.equal((await as(role, `select count(*)::int as n from public.${table}`)).rows[0].n, 0);
      }
      await rejectsCode(() => as('anon', `select * from public.${table}`), '42501');
      for (const role of ['admin', 'editor']) {
        await rejectsCode(() => as(role, `delete from public.${table}`), '42501');
        await rejectsCode(() => as(role, `truncate public.${table}`), '42501');
      }
    }
    const audit = await as('editor', 'select actor_id,action,entity_type,entity_id from public.audit_log where entity_type = $1', ['care_visits']);
    assert.deepEqual(audit.rows, [{ actor_id: ids.editor, action: 'insert', entity_type: 'care_visits', entity_id: visit.id }]);
    assert.equal((await as('viewer', 'select count(*)::int as n from public.audit_log where entity_type = any($1::text[])', [privateTables])).rows[0].n, 0);
    assert.ok((await as('viewer', "select count(*)::int as n from public.audit_log where entity_type = 'contacts'")).rows[0].n > 0);
  });

  await t.test('denies unauthorized writes and does not treat assignment names or arbitrary claims as roles', async () => {
    await owner("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role: 'admin', tenant_id: 'invented', user_metadata: { role: 'admin' } })]);
    for (const role of ['viewer', 'outsider', 'anon']) {
      await rejectsCode(() => as(role, "insert into public.membership_history(contact_id,event_type) values ($1,'received')", [contact.id]), '42501');
      await rejectsCode(() => as(role, "insert into public.care_visits(contact_id,visitor_name,contacted_on) values ($1,'Synthetic Assignee','2026-09-07')", [contact.id]), '42501');
      await rejectsCode(() => as(role, 'insert into public.care_assignments(contact_id) values ($1)', [second.id]), '42501');
      await rejectsCode(() => as(role, 'insert into public.guest_intakes(contact_id) values ($1)', [second.id]), '42501');
    }
    assert.equal((await as('outsider', 'select count(*)::int as n from public.care_assignments')).rows[0].n, 0);
    await owner("select set_config('request.jwt.claims', '', false)");
  });

  await t.test('corrections append to the same contact; owner SQL cannot update, delete or truncate preserved records', async () => {
    const correction = (await as('admin', `insert into public.membership_history(contact_id,event_type,
      corrects_id,event_date,date_text,details) values ($1,'correction',$2,'1954-01-01','Year confirmed; day approximate','Synthetic correction') returning *`,
    [contact.id, original.id])).rows[0];
    assert.equal(correction.corrects_id, original.id);
    assert.equal((await as('editor', 'select details from public.membership_history where id=$1', [original.id])).rows[0].details, 'Synthetic test entry');
    await rejectsCode(() => as('editor', "insert into public.membership_history(contact_id,event_type,corrects_id) values ($1,'correction',$2)", [second.id, original.id]), '23503');
    await rejectsCode(() => as('editor', "insert into public.membership_history(id,contact_id,event_type,corrects_id) values ($1,$2,'correction',$1)", ['10000000-0000-4000-8000-000000000001', contact.id]), '23503');
    for (const [table, id] of [['membership_history', original.id], ['care_visits', visit.id]]) {
      await rejectsCode(() => as('editor', `update public.${table} set created_by=$1 where id=$2`, [ids.outsider, id]), '42501');
      await rejectsCode(() => owner(`update public.${table} set created_by=$1 where id=$2`, [ids.outsider, id]), '55000');
      await rejectsCode(() => owner(`delete from public.${table} where id=$1`, [id]), '55000');
      // CASCADE reaches referencing tables but the statement trigger must still stop it.
      await rejectsCode(() => owner(`truncate public.${table} cascade`), '55000');
    }
    await rejectsCode(() => as('editor', 'delete from public.contacts where id=$1', [second.id]), '42501');
    await rejectsCode(() => owner('delete from public.contacts where id=$1', [second.id]), '55000');
    await rejectsCode(() => owner('truncate public.contacts cascade'), '55000');
    assert.equal((await as('editor', "update public.contacts set status='inactive' where id=$1 returning status", [second.id])).rows[0].status, 'inactive');
  });

  await t.test('mutable records support upsert while preserving identity and database-owned metadata', async () => {
    const updated = (await as('admin', `insert into public.care_assignments(contact_id,cadence_days,assigned_to)
      values ($1,14,'Changed Fixture') on conflict(contact_id) do update set cadence_days=excluded.cadence_days,
      assigned_to=excluded.assigned_to,created_by=$2,created_at='1900-01-01',updated_by=$2,updated_at='1900-01-01' returning *`,
    [contact.id, ids.outsider])).rows[0];
    assert.equal(updated.id, assignment.id);
    assert.equal(updated.created_by, ids.editor);
    assert.deepEqual(updated.created_at, assignment.created_at);
    assert.equal(updated.updated_by, ids.admin);
    assert.notEqual(new Date(updated.updated_at).getUTCFullYear(), 1900);
    assert.equal(updated.cadence_days, 14);
    const updatedIntake = (await as('editor', `insert into public.guest_intakes(contact_id,status) values ($1,'contacted')
      on conflict(contact_id) do update set status=excluded.status returning *`, [contact.id])).rows[0];
    assert.equal(updatedIntake.id, intake.id);
    assert.equal(updatedIntake.status, 'contacted');
    const revisedContact = (await as('admin', `update public.contacts set preferred_name='Synthetic',created_by=$2,
      created_at='1900-01-01',updated_by=$2 where id=$1 returning *`, [contact.id, ids.outsider])).rows[0];
    assert.equal(revisedContact.created_by, ids.editor);
    assert.deepEqual(revisedContact.created_at, contact.created_at);
    assert.equal(revisedContact.updated_by, ids.admin);
    await rejectsCode(() => as('editor', 'update public.care_assignments set contact_id=$1 where id=$2', [second.id, assignment.id]), '23514');
    await rejectsCode(() => as('editor', 'update public.guest_intakes set contact_id=$1 where id=$2', [second.id, intake.id]), '23514');
    await rejectsCode(() => as('editor', 'update public.contacts set id=$1 where id=$2', [ids.outsider, second.id]), '23514');
    for (const [table, id] of [['care_assignments', assignment.id], ['guest_intakes', intake.id]]) {
      assert.equal((await as('viewer', `update public.${table} set notes='Denied' where id=$1 returning id`, [id])).rows.length, 0);
    }
  });

  await t.test('constraints preserve optional historical text and reject invalid relationships or scheduling values', async () => {
    assert.equal(assignment.cadence_days, 28);
    assert.equal(assignment.paused, false);
    assert.ok(assignment.started_on);
    assert.equal(second.needs_review, false);
    for (const days of [0, 366]) await rejectsCode(() => as('editor', 'update public.care_assignments set cadence_days=$1 where id=$2', [days, assignment.id]), '23514');
    await rejectsCode(() => as('editor', "update public.guest_intakes set status='unknown' where id=$1", [intake.id]), '23514');
    await rejectsCode(() => as('editor', "insert into public.care_visits(contact_id,visitor_name,contacted_on,method) values ($1,'Fixture','2026-09-07','fax')", [contact.id]), '23514');
    await rejectsCode(() => as('editor', "insert into public.care_visits(contact_id,visitor_name,contacted_on,outcome) values ($1,'Fixture','2026-09-07','unknown')", [contact.id]), '23514');
    await rejectsCode(() => as('editor', "insert into public.care_visits(contact_id,visitor_name,contacted_on) values ($1,'  ','2026-09-07')", [contact.id]), '23514');
    await rejectsCode(() => as('editor', "insert into public.membership_history(contact_id,event_type) values ($1,'  ')", [contact.id]), '23514');
    await rejectsCode(() => as('editor', "insert into public.membership_history(contact_id,event_type) values ($1,'received')", [ids.outsider]), '23503');
    await rejectsCode(() => as('editor', "insert into public.membership_history(contact_id,event_type,source_document_id) values ($1,'received',$2)", [contact.id, ids.outsider]), '23503');
    await rejectsCode(() => as('editor', "update public.contacts set legacy_member_id='fixture-001' where id=$1", [second.id]), '23505');
    await rejectsCode(() => as('editor', "update public.contacts set legacy_member_id=' ' where id=$1", [second.id]), '23514');
    await rejectsCode(() => as('editor', 'insert into public.care_assignments(contact_id) values ($1)', [contact.id]), '23505');
    await rejectsCode(() => as('editor', 'insert into public.guest_intakes(contact_id) values ($1)', [contact.id]), '23505');
  });

  await t.test('guidelines have no seed and only admins may create or revise the singleton', async () => {
    assert.equal((await as('admin', 'select * from public.care_guidelines')).rows.length, 0);
    await rejectsCode(() => as('editor', "insert into public.care_guidelines(body) values ('Synthetic guideline')"), '42501');
    await rejectsCode(() => as('admin', "insert into public.care_guidelines(id,body) values ('another','Synthetic guideline')"), '23514');
    await rejectsCode(() => as('admin', "insert into public.care_guidelines(body) values ('  ')"), '23514');
    const first = (await as('admin', "insert into public.care_guidelines(body) values ('Synthetic guideline') returning *")).rows[0];
    assert.equal(first.id, 'default');
    assert.equal((await as('editor', 'select body from public.care_guidelines')).rows[0].body, 'Synthetic guideline');
    assert.equal((await as('editor', "update public.care_guidelines set body='Unauthorized' returning id")).rows.length, 0);
    const revised = (await as('admin', `insert into public.care_guidelines(id,body) values ('default','Revised synthetic guideline')
      on conflict(id) do update set body=excluded.body returning *`)).rows[0];
    assert.deepEqual(revised.created_at, first.created_at);
    assert.equal(revised.updated_by, ids.admin);
  });

  await t.test('history source metadata and blobs stay private and cannot be replaced, renamed or deleted', async () => {
    const path = `${ids.editor}/membership-history/source-fixture.png`;
    const ordinaryPath = `${ids.editor}/ordinary-fixture.pdf`;
    for (const name of [path, ordinaryPath]) await as('editor', "insert into storage.objects(bucket_id,name) values ('church-documents',$1)", [name]);
    const document = (await as('editor', `insert into public.documents(title,storage_path,file_name,size_bytes,uploaded_by)
      values ('Synthetic source',$1,'source-fixture.png',100,$2) returning *`, [path, ids.editor])).rows[0];
    const ordinary = (await as('editor', `insert into public.documents(title,storage_path,file_name,size_bytes,uploaded_by)
      values ('Synthetic ordinary document',$1,'ordinary-fixture.pdf',100,$2) returning *`, [ordinaryPath, ids.editor])).rows[0];
    // Upload → metadata → history is not transactional: the reserved path must be private first.
    assert.equal((await as('viewer', 'select id from public.documents where id=$1', [document.id])).rows.length, 0);
    assert.equal((await as('viewer', 'select name from storage.objects where name=$1', [path])).rows.length, 0);
    await as('editor', "insert into public.membership_history(contact_id,event_type,source_document_id) values ($1,'source',$2)", [contact.id, document.id]);
    for (const role of ['admin', 'editor']) {
      assert.equal((await as(role, 'select id from public.documents where id=$1', [document.id])).rows.length, 1);
      assert.equal((await as(role, "select name from storage.objects where name=$1", [path])).rows.length, 1);
      assert.equal((await as(role, "delete from storage.objects where name=$1 returning id", [path])).rows.length, 0);
      assert.equal((await as(role, "update storage.objects set name=$2 where name=$1 returning id", [path, `${path}.changed`])).rows.length, 0);
      await rejectsCode(() => as(role, "update storage.objects set name=$2 where name=$1", [ordinaryPath, path]), '42501');
      await rejectsCode(() => as(role, "update public.documents set storage_path=$2 where id=$1", [document.id, `${path}.changed`]), '55000');
      await rejectsCode(() => as(role, "delete from public.documents where id=$1", [document.id]), '55000');
    }
    await rejectsCode(() => as('editor', "insert into storage.objects(bucket_id,name) values ('church-documents',$1) on conflict(bucket_id,name) do update set name=excluded.name", [path]), '42501');
    assert.equal((await as('viewer', 'select id from public.documents where id=$1', [document.id])).rows.length, 0);
    assert.equal((await as('viewer', 'select name from storage.objects where name=$1', [path])).rows.length, 0);
    assert.equal((await as('viewer', 'select id from public.documents where id=$1', [ordinary.id])).rows.length, 1);
    assert.equal((await as('viewer', 'select name from storage.objects where name=$1', [ordinaryPath])).rows.length, 1);
    assert.equal((await as('editor', 'delete from storage.objects where name=$1 returning id', [ordinaryPath])).rows.length, 1);
    await rejectsCode(() => owner('delete from public.documents where id=$1', [document.id]), '55000');
    await rejectsCode(() => owner('update public.documents set title=$2 where id=$1', [document.id, 'Changed']), '55000');
    assert.equal((await as('outsider', 'select private.can_read_membership_source($1) as allowed', [path])).rows[0].allowed, false);
    assert.equal((await as('outsider', 'select private.membership_source_locked($1) as locked', [ordinaryPath])).rows[0].locked, true);
    await rejectsCode(() => as('anon', 'select private.membership_source_locked($1)', [path]), '42501');
    // Older sources outside the reserved path also become restricted when linked.
    const legacyPath = `${ids.editor}/older-source-fixture.png`;
    await as('editor', "insert into storage.objects(bucket_id,name) values ('church-documents',$1)", [legacyPath]);
    const legacyDoc = (await as('editor', `insert into public.documents(title,storage_path,file_name,size_bytes,uploaded_by)
      values ('Synthetic old source',$1,'older-source-fixture.png',100,$2) returning id`, [legacyPath, ids.editor])).rows[0];
    assert.equal((await as('viewer', 'select id from public.documents where id=$1', [legacyDoc.id])).rows.length, 1);
    await as('editor', "insert into public.membership_history(contact_id,event_type,source_document_id) values ($1,'source',$2)", [contact.id, legacyDoc.id]);
    assert.equal((await as('viewer', 'select id from public.documents where id=$1', [legacyDoc.id])).rows.length, 0);
    assert.equal((await as('viewer', 'select name from storage.objects where name=$1', [legacyPath])).rows.length, 0);
  });

  await t.test('database role removal takes effect immediately, regardless of existing session claims', async () => {
    await owner("update public.staff_roles set role='viewer' where user_id=$1", [ids.editor]);
    assert.equal((await as('editor', 'select count(*)::int as n from public.membership_history')).rows[0].n, 0);
    await rejectsCode(() => as('editor', "insert into public.membership_history(contact_id,event_type) values ($1,'denied')", [contact.id]), '42501');
    await owner('delete from public.staff_roles where user_id=$1', [ids.editor]);
    assert.equal((await as('editor', 'select count(*)::int as n from public.contacts')).rows[0].n, 0);
    assert.equal((await as('editor', 'select count(*)::int as n from public.care_assignments')).rows[0].n, 0);
    assert.equal((await as('editor', 'select count(*)::int as n from storage.objects')).rows[0].n, 0);
    assert.equal((await as('editor', 'select count(*)::int as n from public.audit_log')).rows[0].n, 0);
  });
});
