import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LOCAL_ORIGIN, BUCKET, validateOrigin, validateConfig, validateProcessEnvironment, configFromEnv, parseArgs, safeError,
  safeHttp, RehearsalError, ownPath, signedPath, FixtureRegistry, LocalHttp } from './safety.mjs';

const config = () => ({ url: LOCAL_ORIGIN, anonKey: 'fictional-public-key-only-123456789', serviceKey: 'fictional-server-key-only-987654321', allowSyntheticWrites: true });
const jwt = role => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.fictional-signature-never-used`;

test('exact task API origin is accepted', () => assert.equal(validateOrigin(LOCAL_ORIGIN), LOCAL_ORIGIN));
test('hosted, LAN, DNS, normalized and ambiguous targets are refused', () => {
  for (const value of ['https://example.supabase.co', 'http://192.168.1.2:55321', 'http://localhost:55321',
    'http://127.0.0.1:55322', 'http://127.0.0.1', 'http://127.0.0.1:55321/', 'https://127.0.0.1:55321',
    'http://127.1:55321', 'http://2130706433:55321', 'http://0x7f000001:55321', 'http://[::1]:55321',
    'http://127.0.0.1:55321@remote.invalid', 'http://user:secret@127.0.0.1:55321',
    'http://127.0.0.1:55321?target=remote.invalid', 'http://127.0.0.1:55321#secret', ' http://127.0.0.1:55321',
    'http://127.0.0.1:55321/rest/v1', '', null, undefined]) assert.throws(() => validateOrigin(value), /LOCAL_ORIGIN_REQUIRED/);
});
test('config requires distinct in-memory keys and explicit synthetic-write acknowledgment', () => {
  assert.equal(validateConfig(config()).url, LOCAL_ORIGIN);
  assert.throws(() => validateConfig({ ...config(), serviceKey: config().anonKey }), /DISTINCT_KEYS_REQUIRED/);
  for (const allowSyntheticWrites of [undefined, false, 'true', 1]) assert.throws(() => validateConfig({ ...config(), allowSyntheticWrites }), /SYNTHETIC_WRITES_ACK_REQUIRED/);
  assert.throws(() => validateConfig({ ...config(), dumpKeys: true }), /UNKNOWN_INPUT_OPTION/);
  assert.throws(() => validateConfig({ ...config(), serviceKey: 'bad\nheader-that-is-long-enough' }), /INVALID_KEY_INPUT/);
});
test('privileged keys cannot act as the public key in role checks', () => {
  assert.throws(() => validateConfig({ ...config(), anonKey: 'sb_secret_fictional-only-123456789' }), /PRIVILEGED_ANON_KEY_REFUSED/);
  for (const role of ['service_role', 'authenticated', undefined]) assert.throws(() => validateConfig({ ...config(), anonKey: jwt(role) }), /PRIVILEGED_ANON_KEY_REFUSED/);
  assert.equal(validateConfig({ ...config(), anonKey: jwt('anon') }).anonKey, jwt('anon'));
  assert.throws(() => validateConfig({ ...config(), anonKey: 'eyJmalformed-but-long-enough' }), /INVALID_ANON_JWT/);
});
test('only dedicated environment variables are accepted, with no hosted fallback', () => {
  const c = config();
  assert.deepEqual(configFromEnv({ BCBC_REHEARSAL_URL: c.url, BCBC_REHEARSAL_ANON_KEY: c.anonKey,
    BCBC_REHEARSAL_SERVICE_KEY: c.serviceKey, BCBC_REHEARSAL_ALLOW_SYNTHETIC_WRITES: 'local-fixtures-only' }), c);
  assert.throws(() => configFromEnv({ SUPABASE_URL: c.url, SUPABASE_ANON_KEY: c.anonKey, SUPABASE_SERVICE_ROLE_KEY: c.serviceKey }), /LOCAL_ORIGIN_REQUIRED/);
});
test('Node credential diagnostics and inherited proxy activation are refused', () => {
  assert.doesNotThrow(() => validateProcessEnvironment({}, []));
  for (const env of [{ NODE_DEBUG: 'http' }, { NODE_DEBUG: '*' }, { NODE_DEBUG_NATIVE: 'HTTP2' }]) assert.throws(() => validateProcessEnvironment(env, []), /CREDENTIAL_LOGGING_MODE_REFUSED/);
  for (const env of [{ NODE_USE_ENV_PROXY: '1' }, { NODE_OPTIONS: '--use-env-proxy' }]) assert.throws(() => validateProcessEnvironment(env, []), /PROXY_MODE_REFUSED/);
  assert.throws(() => validateProcessEnvironment({}, ['--use-env-proxy']), /PROXY_MODE_REFUSED/);
});
test('CLI rejects keys, hosted overrides, cleanup/reset/SQL flags and duplicate options', () => {
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.deepEqual(parseArgs(['--run']), { stdin: false });
  assert.deepEqual(parseArgs(['--run', '--stdin']), { stdin: true });
  for (const args of [[], ['--run', '--url=https://remote.invalid'], ['--run', '--service-key=secret'],
    ['--run', '--reset'], ['--run', '--sql'], ['--run', '--force'], ['--run', '--stdin', '--stdin'],
    ['--help', '--run'], ['--stdin', '--run']]) assert.throws(() => parseArgs(args), /USAGE_REQUIRED/);
});
test('server-issued signed URL must stay on exact origin and registered object path', () => {
  const path = ownPath(randomUUID(), randomUUID(), true), relative = `/object/sign/${BUCKET}/${path}?token=fictional-test-token`;
  assert.equal(signedPath(relative, path), `/storage/v1${relative}`);
  assert.equal(signedPath(`${LOCAL_ORIGIN}/storage/v1${relative}`, path), `/storage/v1${relative}`);
  for (const value of [`https://example.supabase.co/storage/v1${relative}`, `//remote.invalid${relative}`,
    `${LOCAL_ORIGIN}@remote.invalid/storage/v1${relative}`, `${LOCAL_ORIGIN}:443/storage/v1${relative}`,
    `/object/sign/${BUCKET}/other.png?token=fictional-test-token`, relative + '&redirect=https://remote.invalid',
    relative + '#secret', relative.replace('?token=', '?access_token='), relative.replace('token=fictional-test-token', 'token=x'),
    relative.replace('/object/', '/object/../'), relative.replace('/object/', '/object\\')]) assert.throws(() => signedPath(value, path), /UNSAFE_SIGNED_URL/);
});
test('cleanup registry accepts only its known synthetic users, IDs and object paths', () => {
  const run = randomUUID(), owner = randomUUID(), stranger = randomUUID(), r = new FixtureRegistry(run);
  r.user(owner, `editor-${run}@office-rehearsal.invalid`);
  assert.equal(r.assertUser(owner), owner);
  assert.throws(() => r.user(stranger, `editor-${run}@example.com`), /NON_SYNTHETIC_IDENTITY_REFUSED/);
  assert.throws(() => r.assertUser(stranger), /UNOWNED_CLEANUP_REFUSED/);
  const record = r.row('contacts', randomUUID());
  assert.equal(r.assertRow('contacts', record), record);
  assert.throws(() => r.assertRow('contacts', randomUUID()), /UNOWNED_CLEANUP_REFUSED/);
  assert.throws(() => r.assertRow('documents', record), /UNOWNED_CLEANUP_REFUSED/);
  const path = ownPath(owner, run); r.object(path, owner);
  assert.equal(r.assertObject(path), path);
  assert.throws(() => r.object(ownPath(stranger, run), stranger), /UNOWNED_CLEANUP_REFUSED/);
  assert.throws(() => r.object(`${owner}/real-document.pdf`, owner), /UNOWNED_FILE_REFUSED/);
  assert.throws(() => r.assertObject(`${owner}/other.txt`), /UNOWNED_CLEANUP_REFUSED/);
});
test('untrusted error messages, response bodies and tokens never enter safe diagnostics', () => {
  const secret = 'sb_secret_fictional-confidential-value';
  assert.equal(safeError(new Error(secret)), 'UNEXPECTED_ERROR_REDACTED');
  assert.equal(safeError(new RehearsalError(secret)), 'UNEXPECTED_ERROR_REDACTED');
  assert.equal(safeError(new RehearsalError('LOCAL_HTTP_FAILURE')), 'LOCAL_HTTP_FAILURE');
  assert.deepEqual(safeHttp({ status: 403, data: { code: '42501', message: secret, detail: secret, access_token: secret } }), { http_status: 403, api_code: '42501' });
  assert.deepEqual(safeHttp({ status: 400, data: { code: secret } }), { http_status: 400 });
});
test('HTTP transport refuses URL overrides and caller-controlled credential/host headers before any connection', async () => {
  const api = new LocalHttp(config());
  for (const path of ['https://remote.invalid/auth/v1/health', '//remote.invalid/auth/v1/health', '/auth/v1/health\r\nHost: remote.invalid']) {
    await assert.rejects(api.request(path), /UNSAFE_REQUEST_PATH/);
  }
  for (const headers of [{ Host: 'remote.invalid' }, { Authorization: 'Bearer stolen' }, { apikey: 'stolen' }]) await assert.rejects(api.request('/auth/v1/health', { headers }), /UNSAFE_HEADER/);
  await assert.rejects(api.request('/auth/v1/health', { method: 'CONNECT' }), /UNSAFE_HTTP_METHOD/);
  await assert.rejects(api.request('/auth/v1/health', { actor: 'user' }), /USER_TOKEN_REQUIRED/);
});
test('HTTP transport pins literal socket destination and sends user bearer with public key only', async t => {
  let observed;
  t.mock.method(http, 'request', (options, callback) => {
    observed = options;
    const req = new EventEmitter(); req.setTimeout = () => req; req.write = () => {}; req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter(); res.statusCode = 200; res.headers = { 'content-type': 'application/json' };
      callback(res); res.emit('data', Buffer.from('[]')); res.emit('end');
    };
    return req;
  });
  const c = config(), api = new LocalHttp(c), userToken = 'fictional-user-access-token-only';
  const r = await api.request('/rest/v1/contacts?select=id', { actor: 'user', token: userToken });
  assert.equal(r.status, 200); assert.equal(observed.hostname, '127.0.0.1'); assert.equal(observed.port, 55321);
  assert.equal(observed.family, 4); assert.equal(observed.agent, false);
  assert.equal(observed.headers.apikey, c.anonKey); assert.equal(observed.headers.Authorization, `Bearer ${userToken}`);
  assert.ok(!JSON.stringify(observed).includes(c.serviceKey));
});
test('redirect responses are rejected without following their location', async t => {
  let calls = 0;
  t.mock.method(http, 'request', (_options, callback) => {
    calls++;
    const req = new EventEmitter(); req.setTimeout = () => req; req.write = () => {};
    req.end = () => { callback({ statusCode: 302, headers: { location: 'https://remote.invalid/secret' }, resume() {} }); };
    return req;
  });
  await assert.rejects(new LocalHttp(config()).request('/auth/v1/health'), /REDIRECT_REFUSED/);
  assert.equal(calls, 1);
});
test('CLI refusal does not echo stdin credentials, malformed JSON or unsupported arguments', () => {
  const cli = fileURLToPath(new URL('./run.mjs', import.meta.url));
  const secret = 'fictional-secret-not-for-output-123456';
  const result = spawnSync(process.execPath, [cli, '--run', '--stdin'], { input: JSON.stringify({ ...config(), url: 'https://remote.invalid', serviceKey: secret }), encoding: 'utf8' });
  assert.equal(result.status, 2); assert.match(result.stderr, /LOCAL_ORIGIN_REQUIRED/);
  assert.ok(!result.stderr.includes(secret)); assert.equal(result.stdout, '');
  const malformed = spawnSync(process.execPath, [cli, '--run', '--stdin'], { input: `{secret:${secret}`, encoding: 'utf8' });
  assert.equal(malformed.status, 2); assert.match(malformed.stderr, /INVALID_INPUT_JSON/); assert.ok(!malformed.stderr.includes(secret));
});
