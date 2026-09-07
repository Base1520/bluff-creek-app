import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const ids = Object.fromEntries(['admin','otherAdmin','editor','viewer','member'].map((role, index) => [role, `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]));
const denied = (operation, code = '42501') => assert.rejects(operation, error => error.code === code);
const day = value => value instanceof Date ? value.toISOString().slice(0, 10) : value;

test('personal leadership follow-ups enforce owner-only access and atomic contact history', async t => {
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
  for (const name of ['migrations/20260907231507_office_base.sql', 'migrations/20260907231527_membership_care.sql', 'migrations/20260907231528_office_content.sql', 'migrations/20260907231530_app_connections_care_roles.sql']) {
    await pg.exec(await readFile(new URL(`../../supabase/${name}`, import.meta.url), 'utf8'));
  }
  // Existing broad defaults must not grant public or direct journal access.
  await pg.exec('alter default privileges in schema public grant all on tables to anon, authenticated');
  await pg.exec(await readFile(new URL('../../supabase/migrations/20260907231531_leader_followups.sql', import.meta.url), 'utf8'));
  for (const [role, id] of Object.entries(ids)) {
    await pg.query('insert into auth.users(id) values ($1)', [id]);
    if (role !== 'member') await pg.query('insert into public.staff_roles(user_id,role) values ($1,$2)', [id, role === 'otherAdmin' ? 'admin' : role]);
  }
  async function as(role, sql, params = []) {
    await pg.exec('reset role');
    await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [ids[role] ?? '']);
    await pg.exec(`set role ${role === 'anon' ? 'anon' : 'authenticated'}`);
    try { return await pg.query(sql, params); }
    finally { await pg.exec('reset role'); }
  }
  const dates = (await pg.query("select (now() at time zone 'America/Chicago')::date today, (now() at time zone 'America/Chicago')::date - 1 yesterday, (now() at time zone 'America/Chicago')::date - 7 week_ago, (now() at time zone 'America/Chicago')::date + 1 tomorrow")).rows[0];
  for (const key of Object.keys(dates)) dates[key] = day(dates[key]);
  const create = role => as(role, `insert into public.leader_followups(display_name,leadership_role,team_name,cadence_months,first_due_on,notes)
    values ('Synthetic leader','deacon','Fixture team',3,$1,'Owner-only synthetic note') returning *`, [dates.today]).then(result => result.rows[0]);
  const get = (role, id) => as(role, 'select * from public.leader_followups where id=$1', [id]).then(result => result.rows[0]);
  const record = (role, followup, { date = dates.today, outcome = 'connected', method = 'phone', notes = null, version = followup.version } = {}) => as(role,
    'select public.record_leader_contact($1,$2,$3,$4,$5,$6) result', [followup.id, version, date, outcome, method, notes]).then(result => result.rows[0].result);
  let admin, otherAdmin, editor;

  await t.test('admins and editors create their own plans; another administrator cannot see or change them', async () => {
    admin = await create('admin'); otherAdmin = await create('otherAdmin'); editor = await create('editor');
    for (const [role, plan] of [['admin',admin], ['otherAdmin',otherAdmin], ['editor',editor]]) {
      assert.equal(plan.owner_id, ids[role]);
      assert.equal(plan.version, 1);
      assert.equal(plan.last_contact_on, null);
      assert.equal(plan.paused, false);
      assert.equal((await as(role, 'select * from public.leader_followups')).rows.length, 1);
      for (const other of [admin,otherAdmin,editor].filter(item => item.id !== plan.id)) {
        assert.equal(await get(role, other.id), undefined);
        assert.equal((await as(role, "update public.leader_followups set notes='Wrong owner' where id=$1 returning id", [other.id])).rows.length, 0);
        await denied(() => record(role, other));
      }
    }
    for (const role of ['viewer','member']) {
      assert.equal((await as(role, 'select * from public.leader_followups')).rows.length, 0);
      await denied(() => create(role));
    }
    await denied(() => create('anon'));
    await denied(() => as('anon', 'select * from public.leader_followups'));
    await denied(() => as('anon', 'select * from public.leader_followup_contacts'));
  });

  await t.test('a stable draft UUID prevents duplicate creates without allowing another owner to read or mutate the result', async () => {
    const draftId = '10000000-0000-4000-8000-000000000001';
    const insertDraft = role => as(role, `insert into public.leader_followups(id,display_name,leadership_role,cadence_days,first_due_on)
      values ($1,'Synthetic retry fixture','other',30,$2) returning *`, [draftId,dates.today]);
    const created = (await insertDraft('admin')).rows[0];
    assert.equal(created.id,draftId);
    assert.equal(created.owner_id,ids.admin);
    await denied(() => insertDraft('admin'),'23505');
    assert.equal((await as('admin','select count(*)::int n from public.leader_followups where id=$1',[draftId])).rows[0].n,1);
    await denied(() => insertDraft('otherAdmin'),'23505');
    assert.equal(await get('otherAdmin',draftId),undefined);
    assert.equal((await as('otherAdmin',"update public.leader_followups set notes='Wrong owner' where id=$1 returning id",[draftId])).rows.length,0);
    assert.deepEqual(await get('admin',draftId),created);
  });

  await t.test('column privileges and stamping prevent identity, ownership, version or contact-date forgery', async () => {
    for (const [column,value] of [['id',ids.member],['owner_id',ids.otherAdmin],['version',99],['last_contact_on',dates.yesterday],['created_at','1900-01-01'],['updated_at','1900-01-01']]) {
      await denied(() => as('admin', `update public.leader_followups set ${column}=$2 where id=$1`, [admin.id,value]));
    }
    await denied(() => as('admin', `insert into public.leader_followups(owner_id,display_name,leadership_role,cadence_days,first_due_on) values ($1,'Synthetic','other',30,$2)`, [ids.otherAdmin,dates.today]));
    const changed = (await as('admin', 'update public.leader_followups set cadence_months=1,notes=$2 where id=$1 and version=$3 returning *', [admin.id,'Changed private note',admin.version])).rows[0];
    assert.equal(changed.version, 2);
    assert.equal(changed.owner_id, admin.owner_id);
    assert.deepEqual(changed.created_at, admin.created_at);
    assert.equal((await as('admin', 'update public.leader_followups set paused=true where id=$1 and version=$2 returning id', [admin.id,admin.version])).rows.length, 0);
    admin = changed;
    await denied(() => pg.query('update public.leader_followups set owner_id=$2 where id=$1', [admin.id,ids.otherAdmin]), '23514');
    await denied(() => pg.query('update public.leader_followups set last_contact_on=$2 where id=$1', [admin.id,dates.yesterday]), '23514');
    for (const [sql, params] of [
      ["update public.leader_followups set display_name=' ' where id=$1", [admin.id]],
      ["update public.leader_followups set leadership_role='admin' where id=$1", [admin.id]],
      ["update public.leader_followups set cadence_months=null,cadence_days=null where id=$1", [admin.id]],
      ["update public.leader_followups set cadence_months=1,cadence_days=28 where id=$1", [admin.id]],
      ["update public.leader_followups set cadence_months=13 where id=$1", [admin.id]],
      ["update public.leader_followups set notes=$2 where id=$1", [admin.id,'x'.repeat(2001)]],
    ]) await denied(() => as('admin', sql, params), '23514');
  });

  await t.test('attempts and backdated contacts preserve snooze; a connected contact today clears it', async () => {
    admin = (await as('admin', 'update public.leader_followups set snoozed_until=$2 where id=$1 returning *', [admin.id,dates.tomorrow])).rows[0];
    let result = await record('admin', admin, { outcome:'attempted', notes:'Synthetic attempted call' });
    assert.equal(result.version, admin.version + 1);
    assert.equal(result.last_contact_on, null);
    admin = await get('admin', admin.id);
    assert.equal(day(admin.snoozed_until), dates.tomorrow);
    result = await record('admin', admin, { date:dates.yesterday });
    assert.equal(result.last_contact_on, dates.yesterday);
    admin = await get('admin', admin.id);
    assert.equal(day(admin.snoozed_until), dates.tomorrow);
    result = await record('admin', admin, { date:dates.week_ago });
    assert.equal(result.last_contact_on, dates.yesterday);
    admin = await get('admin', admin.id);
    assert.equal(day(admin.snoozed_until), dates.tomorrow);
    result = await record('admin', admin);
    admin = await get('admin', admin.id);
    assert.equal(result.last_contact_on, dates.today);
    assert.equal(day(admin.last_contact_on), dates.today);
    assert.equal(admin.snoozed_until, null);
    assert.equal(day(admin.first_due_on), dates.today);
    assert.equal(admin.cadence_months, 1);
    assert.equal(admin.cadence_days, null);
    assert.equal((await as('admin', 'select * from public.leader_followup_contacts')).rows.length, 4);
    for (const role of ['otherAdmin','editor','viewer','member']) {
      assert.equal((await as(role, 'select * from public.leader_followup_contacts where followup_id=$1', [admin.id])).rows.length, 0);
    }
    assert.equal((await as('admin', "select * from public.audit_log where entity_type in ('leader_followups','leader_followup_contacts')")).rows.length, 0);
  });

  await t.test('RPC validates input and uses version locking to reject stale or simultaneous duplicate records', async () => {
    for (const options of [{date:dates.tomorrow},{date:null},{outcome:'unknown'},{method:'fax'},{notes:'x'.repeat(2001)}]) {
      await denied(() => record('admin', admin, options), '22023');
    }
    await denied(() => record('admin', admin, {version:admin.version-1}), '40001');
    const countBefore = (await as('admin','select count(*)::int n from public.leader_followup_contacts where followup_id=$1',[admin.id])).rows[0].n;
    await pg.query("select set_config('request.jwt.claim.sub',$1,false)",[ids.admin]);
    await pg.exec('set role authenticated');
    const concurrent = await Promise.allSettled([1,2].map(() => pg.query('select public.record_leader_contact($1,$2,$3,$4,$5,$6) result', [admin.id,admin.version,dates.today,'attempted','text','Synthetic race fixture'])));
    await pg.exec('reset role');
    assert.equal(concurrent.filter(result => result.status==='fulfilled').length, 1);
    assert.equal(concurrent.find(result => result.status==='rejected').reason.code, '40001');
    const updated = await get('admin', admin.id);
    assert.equal(updated.version, admin.version+1);
    assert.equal(day(updated.last_contact_on), dates.today);
    assert.equal((await as('admin','select count(*)::int n from public.leader_followup_contacts where followup_id=$1',[admin.id])).rows[0].n, countBefore+1);
    admin = updated;
  });

  await t.test('journals can only be appended through RPC; privileged changes cannot rewrite or delete history', async () => {
    const contact = (await as('admin','select * from public.leader_followup_contacts where followup_id=$1 limit 1',[admin.id])).rows[0];
    assert.equal(contact.owner_id,ids.admin);
    assert.ok(contact.created_at);
    await denied(() => as('admin',"insert into public.leader_followup_contacts(followup_id,owner_id,contacted_on,outcome,method) values ($1,$2,$3,'connected','phone')",[admin.id,ids.admin,dates.today]));
    await denied(() => as('admin','update public.leader_followup_contacts set notes=$2 where id=$1',[contact.id,'Changed']));
    for (const table of ['leader_followups','leader_followup_contacts']) {
      await denied(() => as('admin',`delete from public.${table}`));
      await denied(() => as('admin',`truncate public.${table}`));
      await denied(() => pg.query(`delete from public.${table}`), '55000');
      await denied(() => pg.query(`truncate public.${table} cascade`), '55000');
    }
    await denied(() => pg.query('update public.leader_followup_contacts set notes=$2 where id=$1',[contact.id,'Changed']), '55000');
    const functions = (await pg.query(`select n.nspname schema,p.prosecdef definer,has_function_privilege('anon',p.oid,'EXECUTE') anon_exec from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname='record_leader_contact' order by schema`)).rows;
    assert.deepEqual(functions,[{schema:'private',definer:true,anon_exec:false},{schema:'public',definer:false,anon_exec:false}]);
  });

  await t.test('live role removal and forged JWT claims do not grant access to personal rows or the private helper', async () => {
    await pg.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({user_metadata:{role:'admin'},app_metadata:{role:'admin'}})]);
    for (const role of ['viewer','member','anon']) {
      await denied(() => record(role,admin));
      await denied(() => as(role,'select private.record_leader_contact($1,$2,$3,$4,$5,$6)',[admin.id,admin.version,dates.today,'connected','phone',null]));
    }
    await record('editor',editor);
    await pg.query('delete from public.staff_roles where user_id=$1',[ids.editor]);
    assert.equal((await as('editor','select * from public.leader_followups')).rows.length,0);
    assert.equal((await as('editor','select * from public.leader_followup_contacts')).rows.length,0);
    assert.equal((await as('editor','update public.leader_followups set paused=true where id=$1 returning id',[editor.id])).rows.length,0);
    await denied(() => record('editor',editor));
    await pg.query("update public.staff_roles set role='viewer' where user_id=$1",[ids.admin]);
    assert.equal((await as('admin','select * from public.leader_followups')).rows.length,0);
    await denied(() => record('admin',admin));
  });
});
