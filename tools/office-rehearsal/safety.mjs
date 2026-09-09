import http from 'node:http';

export const LOCAL_ORIGIN = 'http://127.0.0.1:55321';
export const SCHEMA_REVISION = '20260907174301';
export const BUCKET = 'church-documents';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export class RehearsalError extends Error {
  constructor(code) { super(code); this.name = 'RehearsalError'; this.code = code; }
}
export function requireThat(condition, code) {
  if (!condition) throw new RehearsalError(code);
}
export function validateOrigin(value) {
  // An exact literal and fixed task port: no DNS, proxy URLs, URL normalization,
  // alternate IP spellings, tunnel names, credentials, path, query, or fragment.
  requireThat(value === LOCAL_ORIGIN, 'LOCAL_ORIGIN_REQUIRED');
  return value;
}
export function validateProcessEnvironment(env = process.env, args = process.execArgv) {
  // Node's HTTP diagnostics can print authorization headers outside our logger.
  requireThat(!env.NODE_DEBUG && !env.NODE_DEBUG_NATIVE, 'CREDENTIAL_LOGGING_MODE_REFUSED');
  requireThat(!env.NODE_USE_ENV_PROXY && !args.includes('--use-env-proxy')
    && !/(?:^|\s)--use-env-proxy(?:\s|$)/.test(env.NODE_OPTIONS || ''), 'PROXY_MODE_REFUSED');
}
export function validateConfig(value) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_INPUT');
  requireThat(Object.keys(value).every(k => ['url', 'anonKey', 'serviceKey', 'allowSyntheticWrites'].includes(k)), 'UNKNOWN_INPUT_OPTION');
  validateOrigin(value.url);
  requireThat(value.allowSyntheticWrites === true, 'SYNTHETIC_WRITES_ACK_REQUIRED');
  for (const key of ['anonKey', 'serviceKey']) {
    requireThat(typeof value[key] === 'string' && value[key].length >= 20 && value[key].length <= 8192 && !/\s/.test(value[key]), 'INVALID_KEY_INPUT');
  }
  requireThat(value.anonKey !== value.serviceKey, 'DISTINCT_KEYS_REQUIRED');
  requireThat(!value.anonKey.startsWith('sb_secret_'), 'PRIVILEGED_ANON_KEY_REFUSED');
  if (value.anonKey.startsWith('eyJ')) {
    let payload;
    try { payload = JSON.parse(Buffer.from(value.anonKey.split('.')[1], 'base64url').toString()); } catch { throw new RehearsalError('INVALID_ANON_JWT'); }
    requireThat(payload.role === 'anon', 'PRIVILEGED_ANON_KEY_REFUSED');
  }
  return Object.freeze({ ...value });
}
export function configFromEnv(env) {
  return validateConfig({ url: env.BCBC_REHEARSAL_URL, anonKey: env.BCBC_REHEARSAL_ANON_KEY,
    serviceKey: env.BCBC_REHEARSAL_SERVICE_KEY,
    allowSyntheticWrites: env.BCBC_REHEARSAL_ALLOW_SYNTHETIC_WRITES === 'local-fixtures-only' });
}
export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  requireThat(args.length >= 1 && args[0] === '--run' && args.length <= 2 && (args.length === 1 || args[1] === '--stdin'), 'USAGE_REQUIRED');
  return { stdin: args[1] === '--stdin' };
}
export function safeError(error) {
  return error instanceof RehearsalError && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'UNEXPECTED_ERROR_REDACTED';
}
export function safeHttp(response) {
  const code = response?.data?.code;
  return { http_status: Number.isInteger(response?.status) ? response.status : null,
    ...(typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? { api_code: code } : {}) };
}
export function fixtureId(value) {
  requireThat(typeof value === 'string' && UUID.test(value), 'INVALID_FIXTURE_ID');
  return value;
}
export function ownPath(userId, runId, source = false) {
  return `${fixtureId(userId)}/${source ? 'membership-history/' : ''}office-rehearsal-${fixtureId(runId)}.${source ? 'png' : 'txt'}`;
}
export function signedPath(value, expectedObjectPath) {
  requireThat(typeof value === 'string' && value.length < 16384 && !/[\s\\]/.test(value), 'UNSAFE_SIGNED_URL');
  const full = value.startsWith('/object/sign/') ? `${LOCAL_ORIGIN}/storage/v1${value}`
    : value.startsWith('/storage/v1/object/sign/') ? `${LOCAL_ORIGIN}${value}` : value;
  let parsed;
  try { parsed = new URL(full); } catch { throw new RehearsalError('UNSAFE_SIGNED_URL'); }
  requireThat(parsed.origin === LOCAL_ORIGIN && !parsed.username && !parsed.password && !parsed.hash, 'UNSAFE_SIGNED_URL');
  requireThat(parsed.pathname === `/storage/v1/object/sign/${BUCKET}/${expectedObjectPath}`, 'UNSAFE_SIGNED_URL');
  requireThat(parsed.searchParams.size === 1 && parsed.searchParams.has('token') && parsed.searchParams.get('token').length > 10, 'UNSAFE_SIGNED_URL');
  return parsed.pathname + parsed.search;
}

export class FixtureRegistry {
  constructor(runId) { this.runId = fixtureId(runId); this.rows = new Map(); this.users = new Map(); this.objects = new Map(); }
  row(table, id, disposition = 'retained') {
    requireThat(/^[a-z_]+$/.test(table), 'INVALID_FIXTURE_TABLE');
    fixtureId(id);
    if (!this.rows.has(table)) this.rows.set(table, new Map());
    this.rows.get(table).set(id, disposition);
    return id;
  }
  assertRow(table, id) { requireThat(this.rows.get(table)?.has(id), 'UNOWNED_CLEANUP_REFUSED'); return fixtureId(id); }
  user(id, email) {
    fixtureId(id);
    requireThat(['admin', 'editor', 'viewer', 'nonstaff', 'other'].some(role => email === `${role}-${this.runId}@office-rehearsal.invalid`), 'NON_SYNTHETIC_IDENTITY_REFUSED');
    this.users.set(id, email);
  }
  assertUser(id) { requireThat(this.users.has(id), 'UNOWNED_CLEANUP_REFUSED'); return fixtureId(id); }
  object(path, ownerId, source = false) {
    this.assertUser(ownerId);
    requireThat(path === ownPath(ownerId, this.runId, source), 'UNOWNED_FILE_REFUSED');
    this.objects.set(path, source ? 'retained_source' : 'disposable');
  }
  assertObject(path) { requireThat(this.objects.has(path), 'UNOWNED_CLEANUP_REFUSED'); return path; }
}

export class LocalHttp {
  constructor(config) { validateProcessEnvironment(); this.config = validateConfig(config); }
  async request(path, { method = 'GET', actor = 'anon', token, body, bytes, headers = {} } = {}) {
    // Built-in http.request does not consult HTTP_PROXY or follow redirects.
    // There is no caller-supplied agent, hostname, port, protocol, or dispatcher.
    requireThat(typeof path === 'string' && /^\/(auth|rest|storage)\/v1(?:\/|\?)/.test(path)
      && !/[\r\n\\#]/.test(path) && !path.includes('://'), 'UNSAFE_REQUEST_PATH');
    requireThat(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method), 'UNSAFE_HTTP_METHOD');
    requireThat(['anon', 'service', 'user', 'none'].includes(actor), 'INVALID_ACTOR');
    requireThat(Object.keys(headers).every(k => ['Prefer', 'Content-Type', 'x-upsert', 'Cache-Control'].includes(k)), 'UNSAFE_HEADER');
    const auth = {};
    if (actor !== 'none') {
      const key = actor === 'service' ? this.config.serviceKey : this.config.anonKey;
      auth.apikey = key;
      if (actor === 'user') {
        requireThat(typeof token === 'string' && token.length > 20 && !/\s/.test(token), 'USER_TOKEN_REQUIRED');
        auth.Authorization = `Bearer ${token}`;
      } else auth.Authorization = `Bearer ${key}`;
    }
    requireThat(!(body !== undefined && bytes !== undefined), 'AMBIGUOUS_REQUEST_BODY');
    const payload = bytes ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
    requireThat(payload === undefined || Buffer.isBuffer(payload), 'INVALID_REQUEST_BYTES');
    requireThat(!payload || payload.length <= 262144, 'REQUEST_TOO_LARGE');
    return new Promise((resolve, reject) => {
      let deadline;
      const finish = (error, result) => { clearTimeout(deadline); if (error) reject(error); else resolve(result); };
      const request = http.request({ hostname: '127.0.0.1', port: 55321, family: 4, method, path,
        agent: false, headers: { ...auth, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers,
          ...(payload ? { 'Content-Length': payload.length } : {}) } }, response => {
        if (response.statusCode >= 300 && response.statusCode < 400) {
          response.resume(); finish(new RehearsalError('REDIRECT_REFUSED')); return;
        }
        const chunks = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 1048576) { finish(new RehearsalError('RESPONSE_TOO_LARGE')); request.destroy(); }
          else chunks.push(chunk);
        });
        response.on('end', () => {
          const result = Buffer.concat(chunks); let data = null;
          if (response.headers['content-type']?.includes('json')) {
            try { data = JSON.parse(result.toString()); } catch { finish(new RehearsalError('INVALID_JSON_RESPONSE')); return; }
          }
          finish(null, { status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300, data, bytes: result });
        });
        response.on('error', () => finish(new RehearsalError('LOCAL_HTTP_FAILURE')));
      });
      // Wall-clock deadline also bounds a response that trickles bytes indefinitely.
      deadline = setTimeout(() => { finish(new RehearsalError('LOCAL_HTTP_TIMEOUT')); request.destroy(); }, 15000);
      request.on('error', error => finish(new RehearsalError(error?.code === 'LOCAL_HTTP_TIMEOUT' ? 'LOCAL_HTTP_TIMEOUT' : 'LOCAL_HTTP_FAILURE')));
      if (payload) request.write(payload);
      request.end();
    });
  }
}
