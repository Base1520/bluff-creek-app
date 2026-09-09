import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const MANIFEST_PATH = 'tools/office-preflight/manifest.json';
const CONFIG_PATH = 'admin/config.js';
const CLIENT_PATH = 'admin/app.js';
// The reviewed staff-first gate permits only this revoke transaction.
// This is a local declaration check, not a SQL parser or hosted privilege check.
const PAUSE_SQL = 'begin; revoke execute on function public.save_app_connection(text,text,text,text,boolean,text), private.save_app_connection(text,text,text,text,boolean,text) from public,anon,authenticated; commit;';
// Pin the approved guard independently of the editable manifest digest.
const STAFF_ACCOUNT_GUARD_SHA256 = '7530eb7cd955ec1522943a179aebc03088a3ebc8126a4f4300e08eb5695bdc7b';
const compactSQL = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n\r]*/g, '').replace(/\s+/g, '').toLowerCase();
const allowedPath = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
  && !value.split('/').some(part => part === '..' || part === '.' || part === '') && !isAbsolute(value);

async function containedPath(root, name) {
  if (!allowedPath(name)) throw new Error('UNSAFE_LOCAL_PATH');
  const path = await realpath(resolve(root, name));
  const contained = relative(root, path);
  if (contained === '..' || contained.startsWith('..' + sep) || isAbsolute(contained)) throw new Error('UNSAFE_LOCAL_PATH');
  return path;
}

async function readLocal(root, name, encoding = 'utf8') {
  const path = await containedPath(root, name);
  const info = await stat(path);
  if (!info.isFile() || info.size > 5 * 1024 * 1024) throw new Error('INVALID_LOCAL_FILE');
  return readFile(path, encoding);
}

// Parse only the three expected string-literal fields. Their contents are skipped,
// never extracted, decoded, executed, validated as credentials, or included in results.
export function configurationPresence(source) {
  let offset = 0;
  const fields = Object.create(null);
  function skip() {
    for (;;) {
      while (/\s/.test(source[offset] || '') && offset < source.length) offset++;
      if (source.startsWith('//', offset)) { const end = source.indexOf('\n', offset + 2); offset = end < 0 ? source.length : end + 1; }
      else if (source.startsWith('/*', offset)) { const end = source.indexOf('*/', offset + 2); if (end < 0) return false; offset = end + 2; }
      else return true;
    }
  }
  function take(text) {
    if (!skip() || !source.startsWith(text, offset)) return false;
    offset += text.length; return true;
  }
  function stringPresence() {
    if (!skip()) return null;
    const quote = source[offset++];
    if (quote !== '"' && quote !== "'") return null;
    let present = false;
    while (offset < source.length) {
      const character = source[offset++];
      if (character === quote) return present;
      if (character === '\n' || character === '\r') return null;
      present = true;
      if (character === '\\') {
        if (offset >= source.length || source[offset] === '\n' || source[offset] === '\r') return null;
        offset++;
      }
    }
    return null;
  }
  const unknown = { status: 'unassessed', project_url_present: null, publishable_key_present: null, membership_link_present: null };
  if (!(take('window') && take('.') && take('CREEK_OFFICE_CONFIG') && take('=') && take('{'))) return unknown;
  for (;;) {
    if (!skip()) return unknown;
    if (source[offset] === '}') { offset++; break; }
    const key = source.slice(offset).match(/^[A-Za-z_$][A-Za-z0-9_$]*/)?.[0];
    if (!['supabaseUrl', 'publishableKey', 'membershipSheetUrl'].includes(key) || Object.hasOwn(fields, key)) return unknown;
    offset += key.length;
    if (!take(':')) return unknown;
    const presence = stringPresence();
    if (presence === null) return unknown;
    fields[key] = presence;
    if (!skip()) return unknown;
    if (source[offset] === ',') { offset++; continue; }
    if (source[offset] !== '}') return unknown;
  }
  if (!skip()) return unknown;
  if (source[offset] === ';') offset++;
  if (!skip() || offset !== source.length || Object.keys(fields).length !== 3) return unknown;
  const status = !fields.supabaseUrl && !fields.publishableKey ? 'not_configured'
    : fields.supabaseUrl && fields.publishableKey ? 'supplied_unverified' : 'partial';
  return { status, project_url_present: fields.supabaseUrl, publishable_key_present: fields.publishableKey, membership_link_present: fields.membershipSheetUrl };
}

function validManifest(manifest) {
  return manifest?.format_version === 3 && /^\d{14}$/.test(manifest.schema_revision || '')
    && Array.isArray(manifest.sql_files) && manifest.sql_files.length === 8
    && manifest.sql_files.every(row => row && allowedPath(row.path) && /^supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/.test(row.path)
      && /^[a-f0-9]{64}$/.test(row.sha256 || '') && Array.isArray(row.depends_on) && row.depends_on.every(allowedPath))
    && new Set(manifest.sql_files.map(row => row.path)).size === manifest.sql_files.length
    && /_office_base\.sql$/.test(manifest.sql_files[0].path)
    && allowedPath(manifest.readiness_sql_file) && /_office_record_recovery\.sql$/.test(manifest.readiness_sql_file)
    && allowedPath(manifest.intake_pause_sql_file) && /_pause_public_app_intake\.sql$/.test(manifest.intake_pause_sql_file)
    && allowedPath(manifest.staff_account_guard_sql_file) && /_require_eligible_staff_auth_account\.sql$/.test(manifest.staff_account_guard_sql_file)
    && manifest.sql_files.at(-3)?.path === manifest.readiness_sql_file
    && manifest.sql_files.at(-2)?.path === manifest.intake_pause_sql_file
    && manifest.sql_files.at(-1)?.path === manifest.staff_account_guard_sql_file
    && Array.isArray(manifest.required_files) && manifest.required_files.every(allowedPath)
    && [CONFIG_PATH, CLIENT_PATH, 'admin/index.html', 'admin/help.html'].every(path => manifest.required_files.includes(path))
    && Array.isArray(manifest.readiness_modules) && manifest.readiness_modules.length > 0
    && manifest.readiness_modules.every(name => /^[a-z_]+$/.test(name))
    && Array.isArray(manifest.prerequisite_tables) && manifest.prerequisite_tables.length > 0
    && manifest.prerequisite_tables.every(name => /^[a-z_]+$/.test(name));
}

export async function runPreflight(rootPath) {
  const report = { scope: 'local_office_files', status: 'failed', schema_revision: null,
    sql_apply_order: [], checks: [], configuration: { status: 'unassessed' }, warnings: [],
    hosted_services: 'not_assessed', sql_applied: false, network_used: false,
    credential_values_extracted: false, credential_validity_checked: false };
  const check = (name, ok, file) => report.checks.push({ name, ok: !!ok, ...(file ? { file } : {}) });
  let root, manifest;
  try { root = await realpath(rootPath); manifest = JSON.parse(await readLocal(root, MANIFEST_PATH)); }
  catch (_) { check('manifest_readable', false); return report; }
  if (!validManifest(manifest)) { check('manifest_structure', false); return report; }
  check('manifest_structure', true);
  report.schema_revision = manifest.schema_revision;
  report.sql_apply_order = manifest.sql_files.map(row => row.path);
  const seen = new Set();
  let ordered = true;
  for (const [index, entry] of manifest.sql_files.entries()) {
    if (entry.depends_on.some(name => !seen.has(name)) || (index > 0 && !entry.depends_on.includes(manifest.sql_files[index - 1].path))) ordered = false;
    seen.add(entry.path);
  }
  check('explicit_sql_dependency_order', ordered);
  const versions = manifest.sql_files.map(row => row.path.match(/\/migrations\/(\d{14})_/)[1]);
  check('unique_migration_versions', new Set(versions).size === versions.length);
  check('migration_filename_order_agrees', versions.every((version, index) => index === 0 || versions[index - 1] < version));
  try {
    const entries = await readdir(await containedPath(root, 'supabase/migrations'), { withFileTypes: true });
    const inventory = entries.filter(entry => entry.name.endsWith('.sql')).map(entry => 'supabase/migrations/' + entry.name);
    const declared = manifest.sql_files.map(entry => entry.path);
    check('migration_inventory_matches', inventory.length === declared.length && inventory.every(path => declared.includes(path)));
  } catch (_) { check('migration_inventory_matches', false); }
  const sources = new Map();
  for (const entry of manifest.sql_files) {
    try {
      const bytes = await readLocal(root, entry.path, null); sources.set(entry.path, bytes.toString('utf8'));
      check('sql_digest_matches', createHash('sha256').update(bytes).digest('hex') === entry.sha256, entry.path);
    } catch (_) { check('sql_file_readable', false, entry.path); }
  }
  for (const name of [...new Set(manifest.required_files)]) {
    try { sources.set(name, await readLocal(root, name)); check('required_local_file_readable', true, name); }
    catch (_) { check('required_local_file_readable', false, name); }
  }
  const recovery = sources.get(manifest.readiness_sql_file) || '';
  check('staff_first_intake_pause_declared', compactSQL(sources.get(manifest.intake_pause_sql_file) || '') === compactSQL(PAUSE_SQL));
  check('eligible_staff_account_guard_declared', createHash('sha256').update(sources.get(manifest.staff_account_guard_sql_file) || '').digest('hex') === STAFF_ACCOUNT_GUARD_SHA256);
  const client = sources.get(CLIENT_PATH) || '';
  const sqlRevision = recovery.match(/'schema_revision'\s*,\s*'(\d{14})'/)?.[1];
  const clientRevision = client.match(/\bREQUIRED_REVISION\s*=\s*["'](\d{14})["']/)?.[1];
  check('readiness_revision_agrees', sqlRevision === manifest.schema_revision && clientRevision === manifest.schema_revision);
  check('readiness_function_declared', /create\s+function\s+public\.office_readiness\s*\(\)/i.test(recovery)
    && /stable\s+security\s+invoker/i.test(recovery) && /db\.rpc\(["']office_readiness["']\)/.test(client));
  check('required_modules_declared', manifest.readiness_modules.every(name => recovery.includes("'" + name + "'") && (client.includes('"' + name + '"') || client.includes("'" + name + "'"))));
  const prerequisites = recovery.match(/foreach\s+v_table\s+in\s+array\s+array\s*\[([\s\S]*?)\]/i)?.[1] || '';
  check('sql_prerequisite_guard_declared', manifest.prerequisite_tables.every(name => prerequisites.includes("'" + name + "'"))
    && /to_regclass\('public\.'\s*\|\|\s*v_table\)\s+is\s+null/i.test(recovery));
  if (sources.has(CONFIG_PATH)) report.configuration = configurationPresence(sources.get(CONFIG_PATH));
  check('configuration_presence_assessable', ['not_configured', 'supplied_unverified'].includes(report.configuration.status));
  if (report.configuration.status === 'not_configured') report.warnings.push('Office project URL and key are blank. This is a prepared local candidate, not an activated office.');
  else if (report.configuration.status === 'supplied_unverified') report.warnings.push('Office URL/key fields are nonempty. Their values, ownership, safety, validity and hosted behavior have not been verified.');
  else report.warnings.push('Office configuration is partial or uses unsupported syntax. Review it privately; no configuration values are included in this report.');
  report.warnings.push('The seventh migration pauses browser-role public profile submissions and updates. The required eighth checks current Auth account eligibility for staff-role operations. Auth settings, token/logout lifecycle and previously issued links remain separate; hosted privileges are not assessed.');
  if (/\b(?:src|href)=["']https?:\/\//i.test(sources.get('admin/index.html') || '')) report.warnings.push('The office page has external assets. Their availability was not checked.');
  report.status = report.checks.every(item => item.ok) ? 'passed' : 'failed';
  return report;
}

export function textReport(report) {
  const lines = [`Local office file preflight: ${report.status.toUpperCase()}`,
    `Declared schema revision: ${report.schema_revision || 'unavailable'}`,
    `Local checks: ${report.checks.filter(check => check.ok).length}/${report.checks.length} passed`,
    `Office configuration: ${report.configuration.status}`,
    'Hosted services: NOT ASSESSED. No SQL was applied; no network or account operation ran.'];
  for (const check of report.checks.filter(check => !check.ok)) lines.push(`FAIL: ${check.name}${check.file ? ' (' + check.file + ')' : ''}`);
  for (const warning of report.warnings) lines.push('NOTE: ' + warning);
  return lines.join('\n') + '\n';
}
