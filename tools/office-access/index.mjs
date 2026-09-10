import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTED_PROJECT_REF = 'xzfeumdonxeodqhfirjr';
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fail = code => { throw new Error(code); };
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
function email(value) {
  if (typeof value !== 'string' || value.length > 254 || value.trim() !== value) return null;
  const parts = value.split('@');
  if (parts.length !== 2 || parts[0].length > 64 || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(parts[0])) return null;
  const labels = parts[1].split('.');
  if (labels.length < 2 || !/^[a-z]{2,63}$/i.test(labels.at(-1)) || labels.some(label => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return null;
  return value.toLowerCase();
}
export function validateInput(value) {
  if (!exactKeys(value, ['projectRef', 'admins']) || value.projectRef !== EXPECTED_PROJECT_REF || !Array.isArray(value.admins) || value.admins.length !== 2) fail('INVALID_ACCESS_INPUT');
  const admins = value.admins.map(row => {
    if (!exactKeys(row, ['email', 'userId'])) fail('INVALID_ADMIN_BINDING');
    const normalized = email(row.email);
    if (!normalized || typeof row.userId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.userId)) fail('INVALID_ADMIN_BINDING');
    return Object.freeze({ email: normalized, userId: row.userId.toLowerCase() });
  });
  if (new Set(admins.map(row => row.email)).size !== 2 || new Set(admins.map(row => row.userId)).size !== 2) fail('DUPLICATE_ADMIN_BINDING');
  return Object.freeze({ projectRef: EXPECTED_PROJECT_REF, admins: Object.freeze(admins) });
}

// Only strings, arrays and objects are needed. Reject duplicate decoded keys,
// including escaped spellings, before ordinary JSON parsing could lose them.
export function parseInput(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 8192) fail('INVALID_INPUT_FILE');
  let at = 0;
  const skip = () => { while (/[\x20\t\r\n]/.test(source[at] || '') && at < source.length) at++; };
  function string() {
    skip(); const expression = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y; expression.lastIndex = at;
    const match = expression.exec(source); if (!match) fail('INVALID_JSON'); at = expression.lastIndex;
    try { return JSON.parse(match[0]); } catch (_) { fail('INVALID_JSON'); }
  }
  function value(depth = 0) {
    skip(); if (depth > 3) fail('INVALID_JSON');
    if (source[at] === '"') return string();
    const array = source[at] === '['; if (!array && source[at] !== '{') fail('INVALID_JSON');
    at++; skip(); const result = array ? [] : Object.create(null), end = array ? ']' : '}', seen = new Set();
    if (source[at] !== end) for (;;) {
      let key;
      if (!array) { key = string(); if (seen.has(key)) fail('DUPLICATE_JSON_KEY'); seen.add(key); skip(); if (source[at++] !== ':') fail('INVALID_JSON'); }
      const next = value(depth + 1); if (array) result.push(next); else result[key] = next;
      skip(); if (source[at] !== ',') break; at++; skip(); if (source[at] === end) fail('INVALID_JSON');
    }
    if (source[at++] !== end) fail('INVALID_JSON'); return result;
  }
  const result = value(); skip(); if (at !== source.length) fail('INVALID_JSON'); return validateInput(result);
}

const literal = value => "'" + value.replaceAll("'", "''") + "'";
export function createArtifacts(input) {
  const config = validateInput(input);
  const bindings = config.admins.map(row => `(${literal(row.userId)}::uuid, ${literal(row.email)}::text)`).join(',\n      ');
  const ids = config.admins.map(row => `${literal(row.userId)}::uuid`).join(', ');
  // Valid mailbox local parts may contain dollar signs. Keep the DO delimiter
  // absent from every interpolated value, including adversarial valid mailboxes.
  let blockTag = 'office_access';
  while (config.admins.some(row => row.email.includes('$' + blockTag + '$'))) blockTag += '_';
  const sql = `-- PRIVATE: contains the approved Auth identity bindings. Never publish or log.
-- Confirm the target project independently against SETUP-REVIEW.md before running.
-- SQL does not attest a Supabase project reference. This is not a migration.
-- No Auth users, invitations, passwords, email settings or public intake are created.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '15s';
-- Briefly prevent new/changed Auth rows from introducing a second email match.
-- Matching row locks alone do not protect that predicate. Ordinary reads continue.
lock table auth.users in share mode;
-- Serialize the two role grants and their count-only result.
lock table public.staff_roles in share row exclusive mode;
do $${blockTag}$
declare
  v_binding record;
  v_user auth.users%rowtype;
  v_matches integer;
begin
  -- Lock both supplied IDs and matching email rows in one deterministic order.
  -- Identity changes/deletions cannot race the checks and role insert below.
  perform u.id from auth.users u
  where u.id in (${ids})
     or lower(btrim(u.email)) in (${config.admins.map(row => literal(row.email)).join(', ')})
  order by u.id for update;
  -- Validate the complete pair before writing either role.
  for v_binding in select * from (values
      ${bindings}
    ) as intended(user_id, email)
  loop
    select count(*) into v_matches from auth.users u
      where lower(btrim(u.email)) = v_binding.email;
    if v_matches <> 1 then
      raise exception 'Approved staff identity did not match exactly one Auth account' using errcode = '42501';
    end if;
    select * into v_user from auth.users u
      where u.id = v_binding.user_id and lower(btrim(u.email)) = v_binding.email;
    if not found then
      raise exception 'Approved staff identity binding did not match' using errcode = '42501';
    end if;
    if coalesce(v_user.is_anonymous, true) or v_user.deleted_at is not null
       or v_user.banned_until > now()
       or (v_user.email_confirmed_at is null and v_user.invited_at is null) then
      raise exception 'Approved staff Auth account is not eligible' using errcode = '42501';
    end if;
    if exists (select 1 from public.staff_roles s
      where s.user_id = v_binding.user_id and s.role <> 'admin') then
      raise exception 'Existing staff role needs a separate reviewed change' using errcode = '42501';
    end if;
  end loop;
end $${blockTag}$;
with inserted as (
  insert into public.staff_roles(user_id, role)
    select intended.user_id, 'admin'::public.staff_role
    from (values (${ids.split(', ').join('), (')})) as intended(user_id)
    where not exists (select 1 from public.staff_roles s where s.user_id = intended.user_id)
  returning 1
)
select count(*)::integer as created, (2 - count(*))::integer as already_admin,
       2::integer as total_admin_bindings from inserted;
commit;
`;
  const report = {
    format_version: 1, status: 'prepared_offline', target_project_ref: EXPECTED_PROJECT_REF,
    approved_binding_count: 2, role: 'admin', identities_in_report: false,
    sql_contains_private_bindings: true, target_verified: false, auth_identities_verified: false,
    roles_changed: false, users_created: false, invitations_sent: false, network_used: false
  };
  const review = `# Staff administrator setup — review only

This private packet is for the dedicated Bluff Creek Church Office project, reference \`${EXPECTED_PROJECT_REF}\`. It creates no account, role, invitation, password, email configuration or deployed file by preparing it.

1. Independently confirm the connected Supabase project is exactly \`${EXPECTED_PROJECT_REF}\` and its current recorded-migration verification, including the required account guard, is current. SQL cannot verify the project reference; never infer the target from matching table names or user UUIDs. Stop if the connection is uncertain.
2. Privately compare both approved people, their exact Auth emails and returned Auth UUIDs. Confirm they are distinct intended accounts. Never use editable user metadata to select a role. Review the sensitive SQL privately; it contains both bindings. Do not upload, commit, attach or print the input or SQL.
3. Get the explicit instruction for these two admin grants. This preparation is not execution permission. The SQL creates only missing admin roles; existing admin rows are unchanged. Any other current role requires a separate reviewed change. Auth identities must already exist and be eligible. Pending invited accounts are allowed so the role can exist before first-password setup; uninvited unconfirmed accounts are refused.
4. Run the entire transaction through the authorized project administrator connection with stop-on-error. Confirm COMMIT succeeded before accepting its count-only result: created + already_admin = 2. A timeout, error or unknown commit outcome requires a fresh read-only reconciliation before retry; do not run later statements separately after a failure. A confirmed re-run against the same identities is a no-op. This is operational access setup, not a schema migration.
5. Separately authorize and configure the reviewed HTTPS recovery page, exact callback, approved SMTP provider and staff-only Auth signup posture. Keep public connection configuration blank and both profile-submission grants revoked. Office admin access does not confer Supabase organization/account recovery access.
6. Invitations need their own explicit instruction and a working hosted callback/email route before account setup. The normal invite API creates the invited identity and sends immediately, before this role transaction can run. Tell recipients to wait for role confirmation before completing setup; do not describe the two operations as atomic or send a second invitation automatically. Reconcile any failure privately before continuing. Each recipient verifies their own inbox, sets their own password, returns to manual staff sign-in, and confirms admin readiness independently. The operator never handles their passwords.
7. Rehearse sign-out/private-state clearing, recovery and access removal only with separately authorized test actions. Keep backup administrator and account-recovery responsibilities explicit; successful sign-in alone does not prove backup restoration or real membership readiness.

Only the SQL contains identity bindings. This checklist and report omit them. Keep the entire packet private and outside the static release; delete according to the church's approved handling process after reconciliation. No cleanup runs automatically.
`;
  return { files: { 'staff-admin-setup.sql': sql, 'SETUP-REVIEW.md': review, 'report.json': JSON.stringify(report, null, 2) + '\n' }, report };
}

function safePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || value.split('/').some(part => part === '.' || part === '..')) fail('UNSAFE_LOCAL_PATH');
  return resolve(value);
}
async function inspect(path, missingFinal = false) {
  const base = parse(path).root, parts = path.slice(base.length).split(sep).filter(Boolean); let current = base;
  for (let i = 0; i < parts.length; i++) {
    current = resolve(current, parts[i]);
    try { const info = await lstat(current); if (info.isSymbolicLink() || (i < parts.length - 1 && !info.isDirectory())) fail('UNSAFE_LOCAL_PATH'); if (i === parts.length - 1) return info; }
    catch (error) { if (error.code === 'ENOENT' && missingFinal && i === parts.length - 1) return null; fail('UNSAFE_LOCAL_PATH'); }
  }
  return lstat(base);
}
export async function readInput(file) {
  const path = safePath(file), info = await inspect(path); if (!info.isFile() || info.size > 8192) fail('INVALID_INPUT_FILE');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); const before = await handle.stat();
    if (!before.isFile() || before.size > 8192 || before.dev !== info.dev || before.ino !== info.ino) fail('INVALID_INPUT_FILE');
    const bytes = await handle.readFile('utf8'), after = await handle.stat();
    if (Buffer.byteLength(bytes) !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail('INPUT_CHANGED_DURING_READ');
    return parseInput(bytes);
  } catch (_) { fail('INPUT_READ_FAILED'); } finally { await handle?.close(); }
}
export async function stageAccess(input, output) {
  const artifacts = createArtifacts(input), target = safePath(output), within = relative(SOURCE_ROOT, target);
  if (!within || (!isAbsolute(within) && within !== '..' && !within.startsWith('..' + sep))) fail('OUTPUT_INSIDE_SOURCE');
  if (await inspect(target, true)) fail('OUTPUT_ALREADY_EXISTS');
  if (await realpath(dirname(target)) !== dirname(target)) fail('UNSAFE_LOCAL_PATH');
  try {
    await mkdir(target, { mode: 0o700 });
    for (const [name, source] of Object.entries(artifacts.files)) {
      const file = resolve(target, name); if (await inspect(file, true)) fail('OUTPUT_ALREADY_EXISTS');
      const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(source, 'utf8'); } finally { await handle.close(); }
    }
  } catch (_) { fail('ACCESS_STAGING_FAILED'); }
  return artifacts.report;
}
