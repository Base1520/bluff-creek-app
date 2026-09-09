import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const ids = Object.fromEntries(['admin','editor','viewer','member'].map((role, index) => [role, `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]));
const denied = (operation, code = '42501') => assert.rejects(operation, error => error.code === code);
const migrationUrl = new URL('../../supabase/migrations/20260908220707_office_record_recovery.sql', import.meta.url);

test('office recovery adds versioned records, reversible event archives and a bounded schema/role handshake', async t => {
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
  for (const name of ['migrations/20260908220558_office_base.sql','migrations/20260908220613_membership_care.sql','migrations/20260908220623_office_content.sql','migrations/20260908220645_app_connections_care_roles.sql','migrations/20260908220658_leader_followups.sql']) {
    await pg.exec(await readFile(new URL(`../../supabase/${name}`, import.meta.url), 'utf8'));
  }
  for (const [role, id] of Object.entries(ids)) {
    await pg.query('insert into auth.users(id) values ($1)',[id]);
    if (role !== 'member') await pg.query('insert into public.staff_roles(user_id,role) values ($1,$2)',[id,role]);
  }
  async function as(role, sql, params = []) {
    await pg.exec('reset role');
    await pg.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[role] ?? '']);
    await pg.exec(`set role ${role === 'anon' ? 'anon' : 'authenticated'}`);
    try { return await pg.query(sql,params); }
    finally { await pg.exec('reset role'); }
  }
  const original = {
    events: (await as('editor', "insert into public.events(title,starts_at) values ('Synthetic event','2026-09-15T10:00:00-05:00') returning *")).rows[0],
    contacts: (await as('editor', "insert into public.contacts(first_name,last_name) values ('Synthetic','Fixture') returning *")).rows[0],
    documents: (await as('editor', "insert into public.documents(title,storage_path,file_name,size_bytes,uploaded_by) values ('Synthetic document',$1,'fixture.pdf',100,$2) returning *",[`${ids.editor}/fixture.pdf`,ids.editor])).rows[0],
  };
  const extended = {
    care_assignments: (await as('editor','insert into public.care_assignments(contact_id) values ($1) returning *',[original.contacts.id])).rows[0],
    guest_intakes: (await as('editor','insert into public.guest_intakes(contact_id) values ($1) returning *',[original.contacts.id])).rows[0],
    care_guidelines: (await as('admin',"insert into public.care_guidelines(body) values ('Synthetic guideline') returning *")).rows[0],
    office_announcements: (await as('editor',"insert into public.office_announcements(title,body) values ('Synthetic announcement','Synthetic message') returning *")).rows[0],
    committee_contacts: (await as('editor',"insert into public.committee_contacts(committee_name,contact_name) values ('Synthetic committee','Synthetic contact') returning *")).rows[0],
    sunday_slides: (await as('editor',"insert into public.sunday_slides(title,service_date) values ('Synthetic deck','2026-09-13') returning *")).rows[0],
    office_prayer_requests: (await as('editor',"insert into public.office_prayer_requests(display_name,request_text) values ('Synthetic request','Synthetic wording') returning *")).rows[0],
  };
  await pg.exec(await readFile(migrationUrl,'utf8'));
  const get = (table,id,role='editor') => as(role,`select * from public.${table} where id=$1`,[id]).then(result=>result.rows[0]);
  const current = {};

  await t.test('existing content and ownership survive migration; new stable IDs are retry-safe and metadata is server-stamped', async () => {
    for (const [table,before] of Object.entries(original)) {
      const after = await get(table,before.id);
      for (const [key,value] of Object.entries(before)) assert.deepEqual(after[key],value);
      assert.equal(after.version,1);
      current[table]=after;
    }
    assert.equal(current.events.is_archived,false);
    assert.equal(current.events.archived_at,null);
    const creations = [
      ['events', "insert into public.events(id,title,starts_at,version,created_by,created_at,archived_at) values ($1,'Retry event','2026-09-20T10:00:00Z',999,$2,'1900-01-01','1900-01-01') returning *", ['10000000-0000-4000-8000-000000000001',ids.member]],
      ['contacts', "insert into public.contacts(id,first_name,last_name,version,created_by,created_at) values ($1,'Retry','Fixture',999,$2,'1900-01-01') returning *", ['10000000-0000-4000-8000-000000000002',ids.member]],
      ['documents', "insert into public.documents(id,title,storage_path,file_name,size_bytes,uploaded_by,version,created_at) values ($1,'Retry document',$2,'retry.pdf',100,$3,999,'1900-01-01') returning *", ['10000000-0000-4000-8000-000000000003',`${ids.editor}/retry.pdf`,ids.member]],
    ];
    for (const [table,sql,params] of creations) {
      const row=(await as('editor',sql,params)).rows[0];
      assert.equal(row.id,params[0]);
      assert.equal(row.version,1);
      assert.equal(row.created_by ?? row.uploaded_by,ids.editor);
      assert.notEqual(new Date(row.created_at).getUTCFullYear(),1900);
      if (table==='events') assert.equal(row.archived_at,null);
      await denied(()=>as('editor',sql,params),'23505');
      assert.equal((await as('editor',`select count(*)::int n from public.${table} where id=$1`,[row.id])).rows[0].n,1);
    }
  });

  await t.test('versions increment exactly once, stale filtered updates affect no rows, and identities cannot be moved', async () => {
    for (const [table,before] of Object.entries(current)) {
      const creator = table==='documents' ? 'uploaded_by' : 'created_by';
      const editable = table==='contacts' ? 'notes' : 'title';
      const updated=(await as('admin',`update public.${table} set ${editable}='Synthetic revision',version=999,${creator}=$3,created_at='1900-01-01',updated_at='1900-01-01' where id=$1 and version=$2 returning *`,[before.id,before.version,ids.member])).rows[0];
      assert.equal(updated.version,before.version+1);
      assert.equal(updated[creator],before[creator]);
      assert.deepEqual(updated.created_at,before.created_at);
      assert.notEqual(new Date(updated.updated_at).getUTCFullYear(),1900);
      if (table!=='documents') assert.equal(updated.updated_by,ids.admin);
      assert.equal((await as('editor',`update public.${table} set ${editable}='Stale revision' where id=$1 and version=$2 returning id`,[before.id,before.version])).rows.length,0);
      await denied(()=>as('editor',`update public.${table} set id=$2 where id=$1`,[before.id,ids.member]),'23514');
      assert.deepEqual(await get(table,before.id),updated);
      current[table]=updated;
      for (const role of ['viewer','member']) assert.equal((await as(role,`update public.${table} set ${editable}='Unauthorized' where id=$1 returning id`,[before.id])).rows.length,0);
      await denied(()=>as('anon',`select * from public.${table}`));
    }
  });

  await t.test('care and content tables preserve baseline rows and use server versions for conditional saves', async () => {
    const fields={care_assignments:'notes',guest_intakes:'notes',care_guidelines:'body',office_announcements:'title',committee_contacts:'committee_name',sunday_slides:'title',office_prayer_requests:'request_text'};
    for(const [table,before] of Object.entries(extended)) {
      const baseline=await get(table,before.id);
      for(const [key,value] of Object.entries(before))assert.deepEqual(baseline[key],value);
      assert.equal(baseline.version,1);
      const updated=(await as('admin',`update public.${table} set ${fields[table]}='Synthetic versioned revision',version=999,created_by=$3 where id=$1 and version=$2 returning *`,[before.id,baseline.version,ids.member])).rows[0];
      assert.equal(updated.version,2);
      assert.equal(updated.created_by,before.created_by);
      assert.equal(updated.updated_by,ids.admin);
      assert.deepEqual(updated.created_at,before.created_at);
      assert.equal((await as('admin',`update public.${table} set ${fields[table]}='Stale' where id=$1 and version=$2 returning id`,[before.id,baseline.version])).rows.length,0);
      await denied(()=>as('admin',`update public.${table} set id=$2 where id=$1`,[before.id,ids.member]),'23514');
      assert.deepEqual(await get(table,before.id),updated);
    }
  });

  await t.test('archive timestamps are server-owned; archive and restore retain events and stale archives fail', async () => {
    const before=current.events;
    const archived=(await as('editor',"update public.events set is_archived=true,archived_at='1900-01-01' where id=$1 and version=$2 returning *",[before.id,before.version])).rows[0];
    assert.equal(archived.is_archived,true);
    assert.equal(archived.version,before.version+1);
    assert.notEqual(new Date(archived.archived_at).getUTCFullYear(),1900);
    assert.equal(archived.title,before.title);
    const edited=(await as('admin',"update public.events set title='Archived title correction',archived_at='2100-01-01' where id=$1 and version=$2 returning *",[before.id,archived.version])).rows[0];
    assert.deepEqual(edited.archived_at,archived.archived_at);
    const restored=(await as('editor',"update public.events set is_archived=false,archived_at='1900-01-01' where id=$1 and version=$2 returning *",[before.id,edited.version])).rows[0];
    assert.equal(restored.archived_at,null);
    assert.equal(restored.is_archived,false);
    assert.equal(restored.version,edited.version+1);
    assert.equal((await as('editor','update public.events set is_archived=true where id=$1 and version=$2 returning id',[before.id,archived.version])).rows.length,0);
    for (const role of ['admin','editor','viewer','member','anon']) {
      await denied(()=>as(role,'delete from public.events where id=$1',[before.id]));
      await denied(()=>as(role,'truncate public.events'));
    }
    await denied(()=>pg.query('delete from public.events where id=$1',[before.id]),'55000');
    await denied(()=>pg.query('truncate public.events'),'55000');
    assert.deepEqual(await get('events',before.id),restored);
    current.events=restored;
  });

  await t.test('transaction rollback restores event version, archive state and audit metadata', async () => {
    const before=await get('events',current.events.id);
    const audits=(await as('editor',"select count(*)::int n from public.audit_log where entity_type='events' and entity_id=$1",[before.id])).rows[0].n;
    await pg.exec('begin');
    const changed=(await as('editor','update public.events set is_archived=true where id=$1 and version=$2 returning *',[before.id,before.version])).rows[0];
    assert.equal(changed.is_archived,true);
    assert.equal(changed.version,before.version+1);
    await pg.exec('rollback');
    assert.deepEqual(await get('events',before.id),before);
    assert.equal((await as('editor',"select count(*)::int n from public.audit_log where entity_type='events' and entity_id=$1",[before.id])).rows[0].n,audits);
  });

  await t.test('historical source document protection still blocks metadata/version changes', async () => {
    const before=await get('documents',current.documents.id);
    await as('editor',"insert into public.membership_history(contact_id,event_type,source_document_id) values ($1,'source',$2)",[current.contacts.id,before.id]);
    await denied(()=>as('editor',"update public.documents set title='Changed source' where id=$1 and version=$2 returning *",[before.id,before.version]),'55000');
    assert.deepEqual(await get('documents',before.id),before);
    assert.equal(await get('documents',before.id,'viewer'),undefined);
  });

  await t.test('readiness returns only declared schema/modules and a live staff role; nonstaff and revoked users are denied', async () => {
    const read = role=>as(role,'select public.office_readiness() result').then(result=>result.rows[0].result);
    for (const role of ['admin','editor','viewer']) {
      const status=await read(role);
      assert.deepEqual(Object.keys(status).sort(),['schema_revision','staff_role','supported_modules'].sort());
      assert.equal(status.schema_revision,'20260907174301');
      assert.equal(status.staff_role,role);
      assert.deepEqual(status.supported_modules,role==='viewer' ? ['events','contacts','documents','activity'] : ['events','contacts','documents','activity','membership','care','office_content','app_signups','leader_followups']);
      assert.equal(JSON.stringify(status).includes(ids[role]),false);
    }
    for (const role of ['member','anon']) await denied(()=>read(role));
    await pg.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({user_metadata:{role:'admin'},app_metadata:{role:'admin'}})]);
    await denied(()=>read('member'));
    await pg.query("update public.staff_roles set role='viewer' where user_id=$1",[ids.editor]);
    assert.equal((await read('editor')).staff_role,'viewer');
    await pg.query('delete from public.staff_roles where user_id=$1',[ids.editor]);
    await denied(()=>read('editor'));
    const routine=(await pg.query("select prosecdef,provolatile,has_function_privilege('anon',oid,'EXECUTE') anon_exec from pg_proc where proname='office_readiness'")).rows[0];
    assert.deepEqual(routine,{prosecdef:false,provolatile:'s',anon_exec:false});
  });
});

test('recovery migration refuses missing prerequisites before changing the base records', async t => {
  const pg=new PGlite();
  t.after(()=>pg.close());
  await pg.exec('create table public.events(id uuid primary key)');
  await denied(async()=>pg.exec(await readFile(migrationUrl,'utf8')),'55000');
  await pg.exec('rollback');
  assert.equal((await pg.query("select column_name from information_schema.columns where table_schema='public' and table_name='events' and column_name='version'")).rows.length,0);
});
