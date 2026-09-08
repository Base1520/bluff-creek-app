import { execFile, spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { RehearsalError, requireThat, validateProcessEnvironment } from './safety.mjs';

const execFileAsync = promisify(execFile);
export const DOCKER = '/opt/homebrew/bin/docker';
export const SOCKET = '/private/tmp/bcbc-office-im-x20/colima/office/docker.sock';
export const CONTAINER = 'supabase_db_bcbc-office-rehearsal';
const HOST = `unix://${SOCKET}`;
const OWN_SOCKET = resolve(dirname(fileURLToPath(import.meta.url)), '../../../office-runtime/colima/office/docker.sock');
const ROLES = new Set(['admin', 'editor', 'viewer']);
const DISPOSABLE = Object.freeze({ documents: 'uploaded_by', office_announcements: 'created_by',
  office_prayer_requests: 'created_by', app_connections: 'auth_user_id' });
const dockerEnv = () => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', DOCKER_HOST: HOST });
const literal = value => `'${String(value).replaceAll("'", "''")}'`;

export function verifyContainerInspection(text) {
  requireThat(typeof text === 'string' && text.startsWith('true '), 'LOCAL_DATABASE_NOT_RUNNING');
  let ports;
  try { ports = JSON.parse(text.slice(5)); } catch { throw new RehearsalError('LOCAL_BINDING_UNVERIFIED'); }
  const binding = ports?.['5432/tcp'];
  requireThat(ports && Object.keys(ports).length === 1 && Array.isArray(binding) && binding.length === 1
    && binding[0].HostIp === '127.0.0.1' && binding[0].HostPort === '55322', 'LOCAL_BINDING_UNVERIFIED');
  return true;
}

export function fixtureStatement(action, registry, { id, role, table } = {}) {
  if (action === 'assign-role' || action === 'revoke-role') {
    registry.assertUser(id);
    const email = registry.users.get(id);
    const identity = `id = ${literal(id)}::uuid and email = ${literal(email)}`;
    if (action === 'assign-role') {
      requireThat(ROLES.has(role), 'UNSAFE_FIXTURE_ROLE');
      return `begin;
do $fixture$ begin
  if not exists (select 1 from auth.users where ${identity}) then
    raise exception 'Synthetic Auth identity did not match';
  end if;
  insert into public.staff_roles(user_id, role) values (${literal(id)}::uuid, ${literal(role)}::public.staff_role);
end $fixture$;
select json_build_object('role', role) from public.staff_roles where user_id = ${literal(id)}::uuid;
commit;`;
    }
    return `begin;
delete from public.staff_roles s using auth.users u
where s.user_id = u.id and u.${identity};
select json_build_object('remaining', count(*)) from public.staff_roles where user_id = ${literal(id)}::uuid;
commit;`;
  }
  requireThat(action === 'remove-disposable-row' && Object.hasOwn(DISPOSABLE, table), 'UNSAFE_FIXTURE_SQL_OPERATION');
  registry.assertRow(table, id);
  requireThat(registry.rows.get(table).get(id) === 'disposable' && registry.users.size > 0, 'PRESERVED_FIXTURE_REMOVAL_REFUSED');
  const ownerColumn = DISPOSABLE[table];
  const identities = [...registry.users].map(([uid, email]) => {
    registry.assertUser(uid);
    return `(id = ${literal(uid)}::uuid and email = ${literal(email)})`;
  }).join(' or ');
  return `begin;
delete from public.${table} where id = ${literal(id)}::uuid and ${ownerColumn} in
  (select id from auth.users where ${identities});
select json_build_object('remaining', count(*)) from public.${table} where id = ${literal(id)}::uuid;
commit;`;
}

export class LocalFixtureSql {
  constructor(registry) { this.registry = registry; this.verified = false; }
  async verify() {
    validateProcessEnvironment();
    let stat, actual;
    try { stat = await lstat(SOCKET); actual = await realpath(SOCKET); } catch { throw new RehearsalError('LOCAL_DOCKER_SOCKET_UNAVAILABLE'); }
    requireThat(stat.isSocket() && !stat.isSymbolicLink() && stat.uid === process.getuid() && actual === OWN_SOCKET, 'LOCAL_DOCKER_SOCKET_UNVERIFIED');
    let result;
    try {
      result = await execFileAsync(DOCKER, ['--host', HOST, 'inspect', '--format', '{{json .State.Running}} {{json .NetworkSettings.Ports}}', CONTAINER],
        { env: dockerEnv(), encoding: 'utf8', timeout: 15000, maxBuffer: 16384 });
    } catch { throw new RehearsalError('LOCAL_CONTAINER_INSPECTION_FAILED'); }
    verifyContainerInspection(result.stdout.trim());
    this.verified = true;
    return true;
  }
  async perform(action, values) {
    requireThat(this.verified, 'LOCAL_FIXTURE_SQL_NOT_VERIFIED');
    const sql = fixtureStatement(action, this.registry, values);
    // Reverify the socket and exact published loopback port before each mutation.
    await this.verify();
    return new Promise((resolveResult, reject) => {
      const child = spawn(DOCKER, ['--host', HOST, 'exec', '-i', CONTAINER,
        'psql', '-X', '--no-password', '--username=postgres', '--dbname=postgres', '--set=ON_ERROR_STOP=1',
        '--set=VERBOSITY=sqlstate', '--tuples-only', '--no-align', '--quiet'],
      { env: dockerEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', size = 0, failed = false;
      const timer = setTimeout(() => { failed = true; child.kill('SIGTERM'); reject(new RehearsalError('LOCAL_FIXTURE_SQL_TIMEOUT')); }, 15000);
      const fail = code => { failed = true; clearTimeout(timer); child.kill('SIGTERM'); reject(new RehearsalError(code)); };
      child.stdout.on('data', data => { size += data.length; if (size > 16384) fail('LOCAL_FIXTURE_SQL_OUTPUT_REFUSED'); else output += data; });
      // Capture no stderr text: even server diagnostics must not expose rows/keys.
      child.stderr.on('data', data => { size += data.length; if (size > 16384) fail('LOCAL_FIXTURE_SQL_OUTPUT_REFUSED'); });
      child.on('error', () => fail('LOCAL_FIXTURE_SQL_UNAVAILABLE'));
      child.stdin.on('error', () => fail('LOCAL_FIXTURE_SQL_INPUT_FAILED'));
      child.on('close', code => {
        clearTimeout(timer); if (failed) return;
        if (code !== 0) { reject(new RehearsalError('LOCAL_FIXTURE_SQL_FAILED')); return; }
        let result;
        try { result = JSON.parse(output.trim()); } catch { reject(new RehearsalError('LOCAL_FIXTURE_SQL_RESULT_UNCONFIRMED')); return; }
        if (action === 'assign-role') {
          if (result?.role !== values.role || Object.keys(result).length !== 1) { reject(new RehearsalError('LOCAL_FIXTURE_ROLE_UNCONFIRMED')); return; }
        } else if (result?.remaining !== 0 || Object.keys(result).length !== 1) { reject(new RehearsalError('LOCAL_FIXTURE_REMOVAL_UNCONFIRMED')); return; }
        resolveResult(result);
      });
      child.stdin.end(sql + '\n');
    });
  }
  assignRole(id, role) { return this.perform('assign-role', { id, role }); }
  revokeRole(id) { return this.perform('revoke-role', { id }); }
  removeDisposable(table, id) { return this.perform('remove-disposable-row', { table, id }); }
}
