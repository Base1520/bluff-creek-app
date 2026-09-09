import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FixtureRegistry } from './safety.mjs';
import { fixtureStatement, verifyContainerInspection, LocalFixtureSql } from './fixture-sql.mjs';

function fixtures() {
  const r = new FixtureRegistry(randomUUID()), id = randomUUID();
  r.user(id, `editor-${r.runId}@office-rehearsal.invalid`);
  return { r, id };
}
test('only exact running task database loopback binding is accepted', () => {
  assert.equal(verifyContainerInspection('true {"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"55322"}]}'), true);
  for (const value of ['false {"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"55322"}]}',
    'true {"5432/tcp":[{"HostIp":"0.0.0.0","HostPort":"55322"}]}',
    'true {"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"54322"}]}',
    'true {"5432/tcp":[{"HostIp":"::","HostPort":"55322"}]}',
    'true {"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"55322"},{"HostIp":"0.0.0.0","HostPort":"55322"}]}',
    'true {}', 'true null', 'true not-json']) assert.throws(() => verifyContainerInspection(value), /LOCAL_(BINDING_UNVERIFIED|DATABASE_NOT_RUNNING)/);
});
test('fixture role SQL is restricted to registered Auth identities and three allowed roles', () => {
  const { r, id } = fixtures();
  for (const role of ['admin', 'editor', 'viewer']) {
    const sql = fixtureStatement('assign-role', r, { id, role });
    assert.match(sql, /if not exists \(select 1 from auth.users/);
    assert.ok(sql.includes(`id = '${id}'::uuid`));
    assert.ok(sql.includes(`email = 'editor-${r.runId}@office-rehearsal.invalid'`));
    assert.ok(sql.includes(`'${role}'::public.staff_role`));
  }
  for (const role of ['service_role', 'postgres', "admin'); drop table public.contacts;--", undefined]) assert.throws(() => fixtureStatement('assign-role', r, { id, role }), /UNSAFE_FIXTURE_ROLE/);
  assert.throws(() => fixtureStatement('assign-role', r, { id: randomUUID(), role: 'admin' }), /UNOWNED_CLEANUP_REFUSED/);
  const revoke = fixtureStatement('revoke-role', r, { id });
  assert.match(revoke, /delete from public.staff_roles s using auth.users u/);
  assert.ok(revoke.includes(`s.user_id = u.id and u.id = '${id}'::uuid`));
  assert.ok(revoke.includes('office-rehearsal.invalid'));
});
test('disposable SQL cleanup refuses preserved tables, unknown IDs, raw SQL and owner substitution', () => {
  const { r, id } = fixtures(), record = r.row('documents', randomUUID(), 'disposable');
  const sql = fixtureStatement('remove-disposable-row', r, { table: 'documents', id: record });
  assert.ok(sql.includes(`delete from public.documents where id = '${record}'::uuid and uploaded_by in`));
  assert.ok(sql.includes(`id = '${id}'::uuid and email = 'editor-${r.runId}@office-rehearsal.invalid'`));
  assert.match(sql, /json_build_object\('remaining', count\(\*\)\)/);
  for (const table of ['contacts', 'membership_history', 'events', 'staff_roles', 'auth.users', 'documents; drop table contacts']) assert.throws(() => fixtureStatement('remove-disposable-row', r, { table, id: record }), /UNSAFE_FIXTURE_SQL_OPERATION/);
  assert.throws(() => fixtureStatement('remove-disposable-row', r, { table: 'documents', id: randomUUID() }), /UNOWNED_CLEANUP_REFUSED/);
  const preserved = r.row('documents', randomUUID(), 'retained');
  assert.throws(() => fixtureStatement('remove-disposable-row', r, { table: 'documents', id: preserved }), /PRESERVED_FIXTURE_REMOVAL_REFUSED/);
  for (const action of ['sql', 'reset', 'alter-role', 'disable-trigger', 'delete-users']) assert.throws(() => fixtureStatement(action, r, { id }), /UNSAFE_FIXTURE_SQL_OPERATION/);
  assert.throws(() => r.user(randomUUID(), `editor-${r.runId}' OR true --@office-rehearsal.invalid`), /NON_SYNTHETIC_IDENTITY_REFUSED/);
});
test('SQL fixture operations cannot run until actual local socket/container verification passes', async () => {
  const { r, id } = fixtures();
  await assert.rejects(new LocalFixtureSql(r).assignRole(id, 'admin'), /LOCAL_FIXTURE_SQL_NOT_VERIFIED/);
});
