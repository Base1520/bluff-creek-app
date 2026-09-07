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
const fixtures = {
  office_announcements: { title: 'Synthetic announcement', body: 'Private fixture announcement body.' },
  committee_contacts: { committee_name: 'Synthetic committee', contact_name: 'Synthetic contact' },
  sunday_slides: { title: 'Synthetic service slides', service_date: '2026-09-13' },
  office_prayer_requests: { display_name: 'Synthetic request', request_text: 'Private fixture prayer text.' },
};
const tables = Object.keys(fixtures);
const denied = (operation, code = '42501') => assert.rejects(operation, error => error.code === code);

test('private office content enforces roles, archive workflow, field constraints and owned audit metadata', async t => {
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
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,
      unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema public,storage to anon,authenticated;
    grant select,insert,update,delete on storage.objects to anon,authenticated;
  `);
  for (const file of ['migrations/20260907231507_office_base.sql', 'migrations/20260907231527_membership_care.sql']) {
    await pg.exec(await readFile(new URL(`../../supabase/${file}`, import.meta.url), 'utf8'));
  }
  // Simulate older project defaults so missing explicit revokes cannot pass unnoticed.
  await pg.exec('alter default privileges in schema public grant all on tables to public,anon,authenticated');
  await pg.exec(await readFile(new URL('../../supabase/migrations/20260907231528_office_content.sql', import.meta.url), 'utf8'));
  for (const [role, id] of Object.entries(ids)) {
    await pg.query('insert into auth.users(id) values ($1)', [id]);
    if (role !== 'outsider') await pg.query('insert into public.staff_roles(user_id,role) values ($1,$2)', [id, role]);
  }
  async function as(role, sql, params = []) {
    await pg.exec('reset role');
    await pg.query("select set_config('request.jwt.claim.sub',$1,false)", [ids[role] ?? '']);
    await pg.exec(`set role ${role === 'anon' ? 'anon' : 'authenticated'}`);
    try { return await pg.query(sql, params); }
    finally { await pg.exec('reset role'); }
  }
  // Table/column identifiers here come only from these static synthetic fixtures.
  async function insert(role, table, values = {}) {
    const data = { ...fixtures[table], ...values };
    return as(role, `insert into public.${table}(${Object.keys(data).join(',')})
      values (${Object.keys(data).map((_, i) => `$${i + 1}`).join(',')}) returning *`, Object.values(data));
  }
  async function update(role, table, id, values) {
    return as(role, `update public.${table} set ${Object.keys(values).map((key, i) => `${key}=$${i + 1}`).join(',')}
      where id=$${Object.keys(values).length + 1} returning *`, [...Object.values(values), id]);
  }
  const rows = {};
  for (const table of tables) {
    rows[table] = (await insert('editor', table, {
      created_by: ids.outsider, updated_by: ids.outsider,
      created_at: '1900-01-01', updated_at: '1900-01-01',
    })).rows[0];
  }

  await t.test('only current admin/editor staff can read or write; archive replaces client deletion', async () => {
    for (const table of tables) {
      for (const role of ['admin', 'editor']) {
        assert.equal((await as(role, `select count(*)::int as n from public.${table} where id=$1`, [rows[table].id])).rows[0].n, 1);
        const created = (await insert(role, table)).rows[0];
        const archived = (await update(role, table, created.id, { status: table === 'committee_contacts' ? 'inactive' : 'archived' })).rows[0];
        assert.equal(archived.status, table === 'committee_contacts' ? 'inactive' : 'archived');
        await denied(() => as(role, `delete from public.${table} where id=$1`, [created.id]));
        await denied(() => as(role, `truncate public.${table}`));
      }
      for (const role of ['viewer', 'outsider', 'userless']) {
        assert.equal((await as(role, `select count(*)::int as n from public.${table}`)).rows[0].n, 0);
        await denied(() => insert(role, table));
        assert.equal((await update(role, table, rows[table].id, { status: table === 'committee_contacts' ? 'inactive' : 'archived' })).rows.length, 0);
      }
      await denied(() => as('anon', `select * from public.${table}`));
      await denied(() => insert('anon', table));
      await denied(() => update('anon', table, rows[table].id, { status: 'archived' }));
    }
  });

  await t.test('creation metadata and identities cannot be forged; update actors and audit entries come from the database', async () => {
    for (const table of tables) {
      const original = rows[table];
      assert.equal(original.created_by, ids.editor);
      assert.equal(original.updated_by, ids.editor);
      assert.notEqual(new Date(original.created_at).getUTCFullYear(), 1900);
      const changed = (await update('admin', table, original.id, {
        created_by: ids.outsider, updated_by: ids.outsider,
        created_at: '1900-01-01', updated_at: '1900-01-01',
      })).rows[0];
      assert.equal(changed.created_by, ids.editor);
      assert.deepEqual(changed.created_at, original.created_at);
      assert.equal(changed.updated_by, ids.admin);
      assert.notEqual(new Date(changed.updated_at).getUTCFullYear(), 1900);
      await denied(() => update('admin', table, original.id, { id: ids.outsider }), '23514');
      const audit = (await as('editor', 'select actor_id,action,entity_type,entity_id from public.audit_log where entity_type=$1 and entity_id=$2 order by id', [table, original.id])).rows;
      assert.deepEqual(audit, [
        { actor_id: ids.editor, action: 'insert', entity_type: table, entity_id: original.id },
        { actor_id: ids.admin, action: 'update', entity_type: table, entity_id: original.id },
      ]);
    }
    for (const role of ['viewer', 'outsider']) {
      assert.equal((await as(role, 'select count(*)::int as n from public.audit_log where entity_type=any($1::text[])', [tables])).rows[0].n, 0);
    }
    await denied(() => as('editor', "insert into public.audit_log(action,entity_type) values ('fake','office_prayer_requests')"));
    const auditJson = JSON.stringify((await as('admin', 'select * from public.audit_log where entity_type=any($1::text[])', [tables])).rows);
    assert.equal(auditJson.includes(fixtures.office_prayer_requests.request_text), false);
    assert.equal(auditJson.includes(fixtures.office_announcements.body), false);
    // The additional restrictive audit policy must not undo earlier care protections.
    const contact = (await as('editor', "insert into public.contacts(first_name,last_name) values ('Synthetic','Fixture') returning id")).rows[0];
    await as('editor', "insert into public.membership_history(contact_id,event_type) values ($1,'synthetic')", [contact.id]);
    assert.equal((await as('viewer', "select count(*)::int as n from public.audit_log where entity_type='membership_history'")).rows[0].n, 0);
    assert.equal((await as('viewer', "select count(*)::int as n from public.audit_log where entity_type='contacts'")).rows[0].n, 1);
  });

  await t.test('required text rejects empty/whitespace, missing and excessive values at the database boundary', async () => {
    const requirements = [
      ['office_announcements', 'title', 160], ['office_announcements', 'body', 10000],
      ['committee_contacts', 'committee_name', 160], ['committee_contacts', 'contact_name', 160],
      ['sunday_slides', 'title', 160], ['office_prayer_requests', 'display_name', 160],
      ['office_prayer_requests', 'request_text', 10000],
    ];
    for (const [table, field, limit] of requirements) {
      await denied(() => insert('editor', table, { [field]: null }), '23502');
      for (const invalid of ['', ' \t\n', 'x'.repeat(limit + 1)]) {
        await denied(() => update('editor', table, rows[table].id, { [field]: invalid }), '23514');
      }
      assert.equal((await update('editor', table, rows[table].id, { [field]: 'x'.repeat(limit) })).rows[0][field].length, limit);
    }
    for (const table of tables) {
      await denied(() => update('editor', table, rows[table].id, { status: 'invalid' }), '23514');
      await denied(() => update('editor', table, rows[table].id, { status: null }), '23502');
    }
  });

  await t.test('date ranges allow unknown endpoints and same-day spans but reject reversed dates', async () => {
    for (const [table, start, end] of [
      ['office_announcements', 'starts_on', 'ends_on'],
      ['committee_contacts', 'term_start', 'term_end'],
    ]) {
      await denied(() => update('editor', table, rows[table].id, { [start]: '2026-09-14', [end]: '2026-09-13' }), '23514');
      for (const dates of [
        { [start]: '2026-09-13', [end]: '2026-09-13' },
        { [start]: null, [end]: '2026-09-13' },
        { [start]: '2026-09-13', [end]: null },
      ]) assert.equal((await update('editor', table, rows[table].id, dates)).rows.length, 1);
    }
    await denied(() => insert('editor', 'sunday_slides', { service_date: null }), '23502');
  });

  await t.test('slide URLs are constrained HTTPS links; ready requires a URL or existing document', async () => {
    const id = rows.sunday_slides.id;
    await denied(() => update('editor', 'sunday_slides', id, { status: 'ready' }), '23514');
    for (const url of [
      'https://slides.example.test/deck/fixture?view=present#page1',
      'HTTPS://slides.example.test:443/deck', 'https://xn--bcher-kva.example/deck',
      'https://slides.example.test/a@b?value=two%20words',
    ]) assert.equal((await update('editor', 'sunday_slides', id, { deck_url: url, status: 'ready' })).rows[0].deck_url, url);
    for (const url of [
      '', 'http://slides.example.test', 'javascript:alert(1)', '//slides.example.test/deck',
      'https://', 'https:///deck', 'https://?deck', 'https://user:password@slides.example.test/deck',
      'https://user@slides.example.test', 'https://user%40slides.example.test',
      'https://slides.example.test\\@other.example.test', 'https://slides.example.test/a b',
      'https://slides.example.test/\npage', 'https://slides.example.test/\tpage',
      'https://slides.example.test:0/deck', 'https://slides.example.test:65536/deck',
      'https://slides.example.test:abc/deck', 'https://slides.example.test:/deck',
      'https://-bad.example.test/deck', 'https://slides..example.test/deck',
      `https://${'x'.repeat(64)}.example.test/deck`, `https://slides.example.test/${'x'.repeat(4096)}`,
    ]) await denied(() => update('editor', 'sunday_slides', id, { deck_url: url }), '23514');
    await denied(() => update('editor', 'sunday_slides', id, { deck_url: null }), '23514');
    await denied(() => update('editor', 'sunday_slides', id, { document_id: ids.outsider }), '23503');
    const path = `${ids.editor}/synthetic-slides.pdf`;
    await as('editor', "insert into storage.objects(bucket_id,name) values ('church-documents',$1)", [path]);
    const document = (await as('editor', `insert into public.documents(title,storage_path,file_name,size_bytes,uploaded_by)
      values ('Synthetic slides',$1,'synthetic-slides.pdf',100,$2) returning id`, [path, ids.editor])).rows[0];
    assert.equal((await update('editor', 'sunday_slides', id, { deck_url: null, document_id: document.id, status: 'ready' })).rows[0].document_id, document.id);
    await denied(() => as('editor', 'delete from public.documents where id=$1', [document.id]), '23001');
    // Slides do not convert ordinary church documents into locked historical sources.
    assert.equal((await as('viewer', 'select id from public.documents where id=$1', [document.id])).rows.length, 1);
    assert.equal((await as('editor', "update public.documents set title='Revised synthetic slides' where id=$1 returning id", [document.id])).rows.length, 1);
    assert.equal((await as('editor', 'delete from storage.objects where name=$1 returning id', [path])).rows.length, 1);
    await update('editor', 'sunday_slides', id, { status: 'draft', document_id: null });
    assert.equal((await as('editor', 'delete from public.documents where id=$1 returning id', [document.id])).rows.length, 1);
    await denied(() => as('anon', 'select private.valid_office_deck_url($1)', ['https://slides.example.test']));
  });

  await t.test('sharing approval is required for broader prayer scope but never changes row visibility', async () => {
    const id = rows.office_prayer_requests.id;
    assert.equal(rows.office_prayer_requests.share_scope, 'staff_only');
    assert.equal(rows.office_prayer_requests.sharing_approved, false);
    for (const scope of ['prayer_team', 'church']) {
      await denied(() => update('editor', 'office_prayer_requests', id, { share_scope: scope, sharing_approved: false }), '23514');
      await update('editor', 'office_prayer_requests', id, { share_scope: scope, sharing_approved: true, care_notes: 'Synthetic staff-only care details.' });
      assert.equal((await as('viewer', 'select * from public.office_prayer_requests')).rows.length, 0);
      assert.equal((await as('outsider', 'select * from public.office_prayer_requests')).rows.length, 0);
      await denied(() => as('anon', 'select * from public.office_prayer_requests'));
      await denied(() => update('admin', 'office_prayer_requests', id, { sharing_approved: false }), '23514');
    }
    await denied(() => update('editor', 'office_prayer_requests', id, { share_scope: 'public' }), '23514');
    await denied(() => update('editor', 'office_prayer_requests', id, { sharing_approved: null }), '23502');
    const narrowed = (await update('editor', 'office_prayer_requests', id, { share_scope: 'staff_only', sharing_approved: false, status: 'answered' })).rows[0];
    assert.equal(narrowed.status, 'answered');
    const auditJson = JSON.stringify((await as('admin', "select * from public.audit_log where entity_type='office_prayer_requests'")).rows);
    assert.equal(auditJson.includes('Synthetic staff-only care details.'), false);
  });

  await t.test('current database role revocation takes effect despite arbitrary client claims', async () => {
    await pg.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role: 'admin', user_metadata: { role: 'admin' } })]);
    for (const table of tables) {
      await denied(() => insert('outsider', table));
    }
    await pg.query("update public.staff_roles set role='viewer' where user_id=$1", [ids.editor]);
    for (const table of tables) {
      assert.equal((await as('editor', `select count(*)::int as n from public.${table}`)).rows[0].n, 0);
      await denied(() => insert('editor', table));
      assert.equal((await update('editor', table, rows[table].id, { status: table === 'committee_contacts' ? 'inactive' : 'archived' })).rows.length, 0);
    }
    await pg.query('delete from public.staff_roles where user_id=$1', [ids.editor]);
    assert.equal((await as('editor', 'select count(*)::int as n from public.audit_log')).rows[0].n, 0);
    for (const table of tables) assert.equal((await as('editor', `select count(*)::int as n from public.${table}`)).rows[0].n, 0);
  });
});
