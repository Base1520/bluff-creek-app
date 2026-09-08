import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path';

const REQUIRED = ['projectRef', 'supabaseUrl', 'publishableKey', 'appOrigin', 'publicSignupEnabled'];
const ALLOWED = [...REQUIRED, 'membershipSheetUrl'];
const fail = code => { throw new Error(code); };
const placeholder = value => /(?:placeholder|replace|changeme|your[_-]|example|dummy|sample|not[_-]?real|insert[_-])/i.test(value);

// Flat JSON has a deliberately small grammar. Duplicate keys, including escaped
// spellings of the same key, are rejected rather than silently taking the last.
export function parseInput(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 65536) fail('INVALID_INPUT');
  let at = 0;
  const result = Object.create(null), seen = new Set();
  const skip = () => { while (/[\x20\t\r\n]/.test(source[at] || '') && at < source.length) at++; };
  function take(token) { skip(); if (!source.startsWith(token, at)) fail('INVALID_INPUT'); at += token.length; }
  function string() {
    skip();
    const token = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
    token.lastIndex = at;
    const match = token.exec(source);
    if (!match) fail('INVALID_INPUT');
    at = token.lastIndex;
    try { return JSON.parse(match[0]); } catch (_) { fail('INVALID_INPUT'); }
  }
  take('{'); skip();
  if (source[at] !== '}') for (;;) {
    const key = string();
    if (seen.has(key) || !ALLOWED.includes(key)) fail('INVALID_FIELDS');
    seen.add(key); take(':'); skip();
    if (source[at] === '"') result[key] = string();
    else if (source.startsWith('true', at)) { result[key] = true; at += 4; }
    else if (source.startsWith('false', at)) { result[key] = false; at += 5; }
    else fail('INVALID_INPUT');
    skip();
    if (source[at] !== ',') break;
    at++; skip();
    if (source[at] === '}') fail('INVALID_INPUT');
  }
  take('}'); skip();
  if (at !== source.length) fail('INVALID_INPUT');
  return validateInput(result);
}

function validOrigin(value) {
  if (typeof value !== 'string' || value.length > 261 || placeholder(value)) return false;
  try {
    const url = new URL(value), labels = url.hostname.split('.');
    if (value !== url.origin || url.protocol !== 'https:' || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    if (labels.length < 2 || labels.some(label => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) || label.startsWith('xn--'))) return false;
    if (!/^[a-z]{2,63}$/.test(labels.at(-1))) return false;
    if (labels.some(label => ['localhost', 'localdomain', 'local', 'internal', 'invalid', 'test', 'example', 'onion', 'lan', 'home', 'corp', 'arpa', 'alt'].includes(label))) return false;
    if (['nip.io', 'sslip.io', 'localtest.me', 'lvh.me'].some(suffix => url.hostname === suffix || url.hostname.endsWith('.' + suffix))) return false;
    return true;
  } catch (_) { return false; }
}

export function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT');
  const keys = Object.keys(input);
  if (keys.some(key => !ALLOWED.includes(key)) || REQUIRED.some(key => !Object.hasOwn(input, key))) fail('INVALID_FIELDS');
  if (typeof input.projectRef !== 'string' || input.projectRef.trim() !== input.projectRef || !/^[a-z]{20}$/.test(input.projectRef) || /^(.)\1+$/.test(input.projectRef) || input.projectRef === 'abcdefghijklmnopqrst' || placeholder(input.projectRef)) fail('INVALID_PROJECT');
  if (input.supabaseUrl !== 'https://' + input.projectRef + '.supabase.co') fail('INVALID_PROJECT_URL');
  if (typeof input.publishableKey !== 'string' || input.publishableKey.trim() !== input.publishableKey || input.publishableKey.length > 4096 || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(input.publishableKey) || placeholder(input.publishableKey) || /(?:service[_-]?role|secret|^sb_publishable_test$)/i.test(input.publishableKey)) fail('INVALID_PUBLISHABLE_KEY');
  if (!validOrigin(input.appOrigin)) fail('INVALID_APP_ORIGIN');
  if (typeof input.publicSignupEnabled !== 'boolean') fail('INVALID_SIGNUP_CHOICE');
  if (Object.hasOwn(input, 'membershipSheetUrl') && input.membershipSheetUrl !== '') fail('MEMBERSHIP_LINK_NOT_STAGED');
  return Object.freeze(Object.fromEntries(REQUIRED.map(key => [key, input[key]])));
}

export function createArtifacts(input) {
  const config = validateInput(input), signup = config.publicSignupEnabled;
  const staffCallback = config.appOrigin + '/admin/recovery.html';
  const signupCallback = config.appOrigin + '/connection.html';
  const report = {
    format_version: 1, status: 'prepared_offline',
    target: { project_ref: config.projectRef, supabase_url: config.supabaseUrl, app_origin: config.appOrigin },
    mode: signup ? 'staff and public signup browser configuration' : 'staff browser configuration only',
    public_signup_ui_staged: signup,
    hosted_auth_signup_posture: 'unverified', opaque_key_project_match: 'not_verified_offline',
    project_ownership_and_dns: 'not_verified_offline', hosted_services: 'not_assessed',
    schema_applied: false, accounts_changed: false, files_deployed: false, network_used: false,
    membership_link_staged: false,
    redirect_allowlist_for_review: [staffCallback, ...(signup ? [signupCallback] : [])],
    review_files: ['admin/config.js', 'js/connection-config.js', 'report.json', 'SETUP-CHECKLIST.md']
  };
  const office = 'window.CREEK_OFFICE_CONFIG = {\n  supabaseUrl: ' + JSON.stringify(config.supabaseUrl) + ',\n  publishableKey: ' + JSON.stringify(config.publishableKey) + ',\n  membershipSheetUrl: ""\n};\n';
  const connection = 'window.CREEK_CONNECTION_CONFIG = {\n  supabaseUrl: ' + JSON.stringify(signup ? config.supabaseUrl : '') + ',\n  publishableKey: ' + JSON.stringify(signup ? config.publishableKey : '') + ',\n  allowedOrigins: ' + JSON.stringify(signup ? [config.appOrigin] : []) + '\n};\n';
  const checklist = `# Hosted office wiring — review only

This packet was prepared offline. No source configuration was changed, no service was contacted, and no deployment or account change was made.

## Exact target to review

- Project reference: ${config.projectRef}
- Project URL: ${config.supabaseUrl}
- App origin: ${config.appOrigin}
- Staff sign-in: ${config.appOrigin}/admin/
- Staff reset and invitation callback: ${staffCallback}
- Public signup UI staged: ${signup ? 'yes' : 'no'}
${signup ? '- Public signup callback: ' + signupCallback + '\n' : ''}
## Review before any activation

1. Confirm this is the approved church project and app origin. Compare the publishable key privately against that project. Its opaque value cannot be matched to a project by this offline tool. DNS ownership, public address resolution and the actual HTTPS origin are not verified here.
2. Review the complete six-file migration manifest in tools/office-preflight/manifest.json and the setup sequence in admin/README.md and docs/office-migrations.md. Run the separate local packet preflight; its pass is not hosted readiness. Obtain the concrete setup/release instruction before applying or deploying anything.
3. Review the exact Auth redirect allowlist: ${report.redirect_allowlist_for_review.join(' and ')}. No wildcards, query redirects or alternate origins are staged. Review the hosted Auth Site URL against the approved app origin above; do not replace existing URL settings blindly.
4. Explicitly choose and review hosted Auth's allow-new-signups setting. Do not copy the local rehearsal setting auth.enable_signup=true. Blank public connection configuration disables that browser UI only; it does not disable backend Auth signup or RPCs. Hosted Auth signup posture remains unverified in both staging modes.
5. Privately approve initial staff and backup administrator identities, create or invite only after authorization, and assign the intended staff_roles role before invitation first-password completion. The browser grants no staff role. Rehearse admin/editor/viewer, anonymous/nonstaff denial, revoked access, reset, invite and expired-link behavior on the hosted service.
6. Verify all six migrations, current readiness declaration, RLS, private storage rules, signed-link expiry, database advisors, account recovery, off-device backups and restore ownership before real member data goes in. No real records belong in this packet.
7. ${signup ? 'The public connection config is staged for separate review. Verify email confirmation, exact callback, consent, own-profile isolation and office signup review before enabling the public page.' : 'The public connection config is blank. Keep public signup UI activation a separate decision; this staff-only browser packet makes no backend-disabled claim.'}
8. Rehearse the actual phone and hosted email journeys. No mail, call, invitation, donation or other external action was exercised by this tool.

The generated browser configs contain only the intended publishable key, never a service/secret key. The membership spreadsheet field is empty: do not insert a private ledger link into a publicly served asset. The report and this checklist omit all API-key values. Copying or deploying these files requires separate review; this checklist intentionally contains no apply commands.
`;
  return { files: { 'admin/config.js': office, 'js/connection-config.js': connection, 'report.json': JSON.stringify(report, null, 2) + '\n', 'SETUP-CHECKLIST.md': checklist }, report };
}

function safePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || value.split('/').some(part => part === '..' || part === '.')) fail('UNSAFE_LOCAL_PATH');
  return resolve(value);
}

async function checkPath(path, missingFinal = false) {
  const root = parse(path).root;
  let current = root;
  const parts = path.slice(root.length).split(sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = resolve(current, parts[i]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || (i < parts.length - 1 && !info.isDirectory())) fail('UNSAFE_LOCAL_PATH');
      if (i === parts.length - 1) return info;
    } catch (error) {
      if (error.code === 'ENOENT' && missingFinal && i === parts.length - 1) return null;
      fail('UNSAFE_LOCAL_PATH');
    }
  }
  return lstat(root);
}

export async function readInput(file) {
  const path = safePath(file), info = await checkPath(path);
  if (!info.isFile() || info.size > 65536) fail('INVALID_INPUT_FILE');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > 65536 || opened.dev !== info.dev || opened.ino !== info.ino) fail('INVALID_INPUT_FILE');
    return parseInput(await handle.readFile('utf8'));
  } catch (error) {
    if (error.message && /^[A-Z_]+$/.test(error.message)) throw error;
    fail('INPUT_READ_FAILED');
  } finally { await handle?.close(); }
}

export async function stageWiring(input, output) {
  const artifacts = createArtifacts(input), target = safePath(output);
  if (await checkPath(target, true)) fail('OUTPUT_ALREADY_EXISTS');
  const parent = dirname(target);
  if (!isAbsolute(target) || await realpath(parent) !== parent) fail('UNSAFE_LOCAL_PATH');
  try {
    // The destination is the exclusive reservation. No recursive creation or
    // replacement is used; a pre-existing directory, even empty, is a failure.
    await mkdir(target, { mode: 0o700 });
    for (const child of ['admin', 'js']) await mkdir(resolve(target, child), { mode: 0o700 });
    for (const [name, source] of Object.entries(artifacts.files)) {
      const file = resolve(target, name);
      if (await checkPath(file, true)) fail('OUTPUT_ALREADY_EXISTS');
      const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(source, 'utf8'); } finally { await handle.close(); }
    }
  } catch (_) {
    // Leave an incomplete private packet in place for inspection. Never remove
    // or overwrite a path after an uncertain local filesystem failure.
    fail('STAGING_FAILED');
  }
  return artifacts.report;
}
