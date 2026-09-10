import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { configurationPresence, runPreflight, textReport } from './index.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const manifestPath = 'tools/office-preflight/manifest.json';
const template = JSON.parse(await readFile(join(repository, manifestPath), 'utf8'));
const guardFixture = await readFile(join(repository, template.staff_account_guard_sql_file), 'utf8');
const directFixture = await readFile(join(repository, template.direct_intake_sql_file), 'utf8');
const extensionsFixture = await readFile(join(repository, template.dispatch_extensions_sql_file), 'utf8');
const pauseFixture = 'begin; revoke execute on function public.save_app_connection(text,text,text,text,boolean,text), private.save_app_connection(text,text,text,text,boolean,text) from public,anon,authenticated; commit;';
const blankConfig = 'window.CREEK_OFFICE_CONFIG = {supabaseUrl: "", publishableKey: "", membershipSheetUrl: ""};';
const digest = source => createHash('sha256').update(source).digest('hex');
const check = (report, name) => report.checks.find(item => item.name === name)?.ok;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bcbc-office-preflight-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = structuredClone(template);
  async function put(path, source) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
  async function saveManifest() { await put(manifestPath, JSON.stringify(manifest)); }
  for (const path of manifest.required_files) await put(path, 'synthetic local asset\n');
  await put('admin/config.js', blankConfig);
  await put('admin/index.html', '<script src="https://assets.invalid/sdk.js"></script>');
  await put('admin/app.js', `const REQUIRED_REVISION = "${manifest.schema_revision}";\ndb.rpc("office_readiness");\nconst modules = ${JSON.stringify(manifest.readiness_modules)};`);
  for (const [index, row] of manifest.sql_files.entries()) {
    const source = row.path === manifest.direct_intake_sql_file ? directFixture : row.path === manifest.dispatch_extensions_sql_file ? extensionsFixture : row.path === manifest.staff_account_guard_sql_file ? guardFixture : row.path === manifest.intake_pause_sql_file ? pauseFixture : row.path !== manifest.readiness_sql_file ? '-- synthetic ordered SQL fixture ' + index + '\n'
      : `do $$ begin foreach v_table in array array[${manifest.prerequisite_tables.map(name => "'" + name + "'").join(',')}] loop\nif to_regclass('public.' || v_table) is null then raise exception 'missing dependency'; end if;\nend loop; end $$;\ncreate function public.office_readiness() returns jsonb language plpgsql stable security invoker as $$ begin return jsonb_build_object('schema_revision', '${manifest.schema_revision}', 'supported_modules', array[${manifest.readiness_modules.map(name => "'" + name + "'").join(',')}]); end $$;`;
    row.sha256 = digest(source);
    await put(row.path, source);
  }
  await saveManifest();
  async function alterSql(transform, path = manifest.readiness_sql_file) {
    const row = manifest.sql_files.find(entry => entry.path === path);
    const next = transform(await readFile(join(root, row.path), 'utf8'));
    await put(row.path, next); row.sha256 = digest(next); await saveManifest();
  }
  return { root, manifest, put, saveManifest, alterSql };
}

function invoke(args) {
  return new Promise(resolve => execFile(process.execPath, [cli, ...args], { timeout: 10000 }, (error, stdout, stderr) => resolve({ code: error?.code || 0, stdout, stderr })));
}

test('the real local checkout matches the reviewed setup manifest without claiming activation', async () => {
  const report = await runPreflight(repository);
  assert.equal(report.status, 'passed', textReport(report));
  assert.equal(report.schema_revision, '20260907174301');
  assert.equal(report.sql_apply_order.length, 10);
  assert.equal(check(report, 'eligible_staff_account_guard_declared'), true);
  assert.equal(check(report, 'staff_first_intake_pause_declared'), true);
  assert.ok(['not_configured', 'supplied_unverified'].includes(report.configuration.status));
  assert.equal(report.hosted_services, 'not_assessed');
  assert.equal(report.sql_applied, false);
  assert.equal(report.network_used, false);
  assert.equal(report.credential_values_extracted, false);
  assert.equal(report.credential_validity_checked, false);
  assert.equal(check(report, 'unique_migration_versions'), true);
  assert.equal(check(report, 'migration_filename_order_agrees'), true);
  assert.ok(report.warnings.some(message => message.includes('external assets')));
});

test('blank and supplied synthetic configuration are separate local states; values never enter reports', async t => {
  const f = await fixture(t);
  let report = await runPreflight(f.root);
  assert.equal(report.status, 'passed');
  assert.equal(report.configuration.status, 'not_configured');
  const values = ['https://fictional-project.invalid/never-send-url', 'fictional-publishable-never-send-key', 'https://fictional-ledger.invalid/never-send-link'];
  await f.put('admin/config.js', `window.CREEK_OFFICE_CONFIG = {supabaseUrl: '${values[0]}', publishableKey: '${values[1]}', membershipSheetUrl: '${values[2]}'};`);
  report = await runPreflight(f.root);
  assert.equal(report.status, 'passed');
  assert.equal(report.configuration.status, 'supplied_unverified');
  assert.equal(report.hosted_services, 'not_assessed');
  assert.deepEqual(Object.values(report.configuration).slice(1), [true, true, true]);
  for (const value of values) assert.ok(!(JSON.stringify(report) + textReport(report)).includes(value));
  assert.ok(textReport(report).includes('validity and hosted behavior have not been verified'));
});

test('partial configuration fails; a ledger link alone does not imply an office connection', async t => {
  const f = await fixture(t);
  for (const fields of ['supabaseUrl:"fictional",publishableKey:"",membershipSheetUrl:""', 'supabaseUrl:"",publishableKey:"fictional",membershipSheetUrl:""']) {
    await f.put('admin/config.js', 'window.CREEK_OFFICE_CONFIG={' + fields + '};');
    const report = await runPreflight(f.root);
    assert.equal(report.status, 'failed');
    assert.equal(report.configuration.status, 'partial');
  }
  assert.equal(configurationPresence(blankConfig.replace('membershipSheetUrl: ""', 'membershipSheetUrl: "fictional"')).status, 'not_configured');
});

test('presence parser accepts comments and string literals without evaluating configuration', () => {
  const result = configurationPresence(`/* header */ window . CREEK_OFFICE_CONFIG = {\n// local fields\nsupabaseUrl: 'fictional\\\'url', publishableKey: "fictional\\\\key", membershipSheetUrl: '',\n}; // end`);
  assert.equal(result.status, 'supplied_unverified');
  assert.equal(result.membership_link_present, false);
  for (const source of [
    blankConfig + 'globalThis.preflightMustNeverExecute = true;',
    blankConfig.replace('supabaseUrl: ""', 'supabaseUrl: process.env.SERVICE_SECRET'),
    blankConfig.replace('supabaseUrl: ""', 'supabaseUrl: `fictional`'),
    blankConfig.replace('membershipSheetUrl: ""', 'supabaseUrl: ""'),
    blankConfig.replace('membershipSheetUrl: ""', 'unknownField: ""'),
    blankConfig + ' /* unfinished',
    blankConfig.replace('supabaseUrl: ""', 'supabaseUrl: "line\nbreak"')
  ]) assert.equal(configurationPresence(source).status, 'unassessed');
  assert.equal(globalThis.preflightMustNeverExecute, undefined);
});

test('unsupported configuration syntax fails safely without returning source or error contents', async t => {
  const f = await fixture(t);
  await f.put('admin/config.js', blankConfig + ' throw new Error("fictional-hidden-marker");');
  const report = await runPreflight(f.root);
  assert.equal(report.status, 'failed');
  assert.equal(report.configuration.status, 'unassessed');
  assert.ok(!JSON.stringify(report).includes('fictional-hidden-marker'));
});

test('SQL content changes fail the stored digest check without rewriting the manifest', async t => {
  const f = await fixture(t);
  const before = await readFile(join(f.root, manifestPath), 'utf8');
  await f.put(f.manifest.sql_files[1].path, '-- locally changed SQL\n');
  const report = await runPreflight(f.root);
  assert.equal(report.status, 'failed');
  assert.equal(report.checks.find(item => item.name === 'sql_digest_matches' && item.file === f.manifest.sql_files[1].path).ok, false);
  assert.equal(await readFile(join(f.root, manifestPath), 'utf8'), before);
});

test('wrong SQL sequence and a missing predecessor fail the explicit dependency check', async t => {
  const f = await fixture(t);
  [f.manifest.sql_files[1], f.manifest.sql_files[2]] = [f.manifest.sql_files[2], f.manifest.sql_files[1]];
  await f.saveManifest();
  assert.equal(check(await runPreflight(f.root), 'explicit_sql_dependency_order'), false);
  [f.manifest.sql_files[1], f.manifest.sql_files[2]] = [f.manifest.sql_files[2], f.manifest.sql_files[1]];
  f.manifest.sql_files[2].depends_on = [f.manifest.sql_files[0].path];
  await f.saveManifest();
  assert.equal(check(await runPreflight(f.root), 'explicit_sql_dependency_order'), false);
});

test('duplicate migration versions fail even with distinct filenames and valid dependency order', async t => {
  const f = await fixture(t);
  const row=f.manifest.sql_files[2], oldPath=row.path;
  const version=f.manifest.sql_files[1].path.match(/\/(\d{14})_/)[1];
  row.path=row.path.replace(/\/\d{14}_/, '/'+version+'_');
  await f.put(row.path,await readFile(join(f.root,oldPath),'utf8'));
  await rm(join(f.root,oldPath));
  f.manifest.sql_files[3].depends_on=[row.path];
  await f.saveManifest();
  const report=await runPreflight(f.root);
  assert.equal(check(report,'explicit_sql_dependency_order'),true);
  assert.equal(check(report,'migration_inventory_matches'),true);
  assert.equal(check(report,'unique_migration_versions'),false);
  assert.equal(report.status,'failed');
});

test('timestamps must follow dependency order and use the CLI timestamp format', async t => {
  const f=await fixture(t);
  const row=f.manifest.sql_files[1], oldPath=row.path;
  row.path=row.path.replace(/\/\d{14}_/,'/20990101000000_');
  await f.put(row.path,await readFile(join(f.root,oldPath),'utf8'));
  await rm(join(f.root,oldPath));
  f.manifest.sql_files[2].depends_on=[row.path];
  await f.saveManifest();
  let report=await runPreflight(f.root);
  assert.equal(check(report,'explicit_sql_dependency_order'),true);
  assert.equal(check(report,'unique_migration_versions'),true);
  assert.equal(check(report,'migration_filename_order_agrees'),false);
  row.path=row.path.replace('20990101000000','20990101');
  await f.saveManifest();
  report=await runPreflight(f.root);
  assert.equal(check(report,'manifest_structure'),false);
});

test('unlisted or missing migration files fail the local inventory', async t => {
  const f = await fixture(t);
  await f.put('supabase/migrations/20990101000000_unreviewed.sql', '-- fictional future migration');
  assert.equal(check(await runPreflight(f.root), 'migration_inventory_matches'), false);
  await rm(join(f.root, 'supabase/migrations/20990101000000_unreviewed.sql'));
  await rm(join(f.root, f.manifest.sql_files[1].path));
  const report = await runPreflight(f.root);
  assert.equal(check(report, 'migration_inventory_matches'), false);
  assert.ok(report.checks.some(item => item.name === 'sql_file_readable' && !item.ok));
});

test('missing office module or font dependencies block the local packet', async t => {
  const f = await fixture(t);
  await rm(join(f.root, 'admin/care.js'));
  await rm(join(f.root, 'assets/fonts/nunito-sans-latin-normal-v19.woff2'));
  const report = await runPreflight(f.root);
  assert.equal(report.status, 'failed');
  assert.equal(report.checks.filter(item => item.name === 'required_local_file_readable' && !item.ok).length, 2);
});

test('client revision disagreement is caught even while SQL digests still agree', async t => {
  const f = await fixture(t);
  const path = 'admin/app.js';
  await f.put(path, (await readFile(join(f.root, path), 'utf8')).replace(f.manifest.schema_revision, '20990101000000'));
  assert.equal(check(await runPreflight(f.root), 'readiness_revision_agrees'), false);
});

test('readiness module and prerequisite declarations cannot be dropped by merely refreshing a digest', async t => {
  const f = await fixture(t);
  await f.alterSql(source => source.replace("'app_signups'", "'removed_module'"));
  assert.equal(check(await runPreflight(f.root), 'required_modules_declared'), false);
  await f.alterSql(source => source.replace("'leader_followup_contacts'", "'removed_table'"));
  assert.equal(check(await runPreflight(f.root), 'sql_prerequisite_guard_declared'), false);
  await f.alterSql(source => source.replace('stable security invoker', 'stable security definer'));
  assert.equal(check(await runPreflight(f.root), 'readiness_function_declared'), false);
});

test('invalid manifests and traversal paths return a bounded failure', async t => {
  const f = await fixture(t);
  for (const row of [null, { path: '../fictional-private-file', sha256: 'a'.repeat(64), depends_on: [] }]) {
    f.manifest.sql_files[1] = row; await f.saveManifest();
    const report = await runPreflight(f.root);
    assert.equal(check(report, 'manifest_structure'), false);
    assert.deepEqual(report.sql_apply_order, []);
    assert.ok(!JSON.stringify(report).includes('fictional-private-file'));
  }
  await f.put(manifestPath, '{ malformed JSON with fictional-private-marker');
  const report = await runPreflight(f.root);
  assert.equal(check(report, 'manifest_readable'), false);
  assert.ok(!JSON.stringify(report).includes('fictional-private-marker'));
});

test('symlink escapes are rejected without loading outside file contents', async t => {
  const f = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'bcbc-preflight-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'outside.js'), blankConfig.replace('supabaseUrl: ""', 'supabaseUrl: "fictional-outside-value"'));
  await rm(join(f.root, 'admin/config.js'));
  await symlink(join(outside, 'outside.js'), join(f.root, 'admin/config.js'));
  const report = await runPreflight(f.root);
  assert.equal(report.status, 'failed');
  assert.equal(report.configuration.status, 'unassessed');
  assert.ok(!JSON.stringify(report).includes('fictional-outside-value'));
});

test('CLI has useful exit codes and sanitized text/JSON without accepting service values', async t => {
  const f = await fixture(t);
  let result = await invoke(['--root', f.root]);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('Local office file preflight: PASSED'));
  assert.ok(result.stdout.includes('Hosted services: NOT ASSESSED'));
  result = await invoke(['--root', f.root, '--json']);
  assert.equal(JSON.parse(result.stdout).configuration.status, 'not_configured');
  await f.put('admin/config.js', blankConfig.replace('supabaseUrl: ""', 'supabaseUrl: "fictional-cli-value"'));
  result = await invoke(['--root', f.root, '--json']);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).configuration.status, 'partial');
  assert.ok(!result.stdout.includes('fictional-cli-value'));
  result = await invoke(['--unknown-fictional-secret']);
  assert.equal(result.code, 2);
  assert.ok(!(result.stderr + result.stdout).includes('unknown-fictional-secret'));
  result = await invoke(['--help']);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('Reads local manifests/files only'));
});


test('staff-first pause cannot be omitted from the declared packet even when inventory is changed with it', async t => {
  const f = await fixture(t);
  await rm(join(f.root, f.manifest.intake_pause_sql_file));
  f.manifest.sql_files = f.manifest.sql_files.filter(row => row.path !== f.manifest.intake_pause_sql_file);
  await f.saveManifest();
  assert.equal(check(await runPreflight(f.root), 'manifest_structure'), false);
});

test('the readiness source is explicit and remains separate from the pause and account guard', async t => {
  const f = await fixture(t);
  let report = await runPreflight(f.root);
  assert.equal(check(report, 'readiness_revision_agrees'), true);
  assert.equal(check(report, 'staff_first_intake_pause_declared'), true);
  f.manifest.readiness_sql_file = f.manifest.intake_pause_sql_file;
  await f.saveManifest();
  report = await runPreflight(f.root);
  assert.equal(check(report, 'manifest_structure'), false);
});

test('both submission signatures and every browser grant must be revoked without adding an enabling command', async t => {
  const f = await fixture(t);
  for (const source of [
    pauseFixture.replace('private.save_app_connection(text,text,text,text,boolean,text)', 'private.other_function(text,text,text,text,boolean,text)'),
    pauseFixture.replace('public.save_app_connection(text,text,text,text,boolean,text), ', ''),
    pauseFixture.replace('public,anon,authenticated', 'public,anon'),
    pauseFixture + ' grant execute on function public.save_app_connection(text,text,text,text,boolean,text) to authenticated;'
  ]) {
    await f.alterSql(() => source, f.manifest.intake_pause_sql_file);
    const report = await runPreflight(f.root);
    assert.equal(report.checks.filter(row => row.name === 'sql_digest_matches').every(row => row.ok), true);
    assert.equal(check(report, 'staff_first_intake_pause_declared'), false);
    assert.equal(report.status, 'failed');
  }
});

test('fresh setup cannot omit the applied account guard or declare the older format', async t => {
  const f = await fixture(t);
  await rm(join(f.root, f.manifest.staff_account_guard_sql_file));
  f.manifest.sql_files=f.manifest.sql_files.filter(row=>row.path!==f.manifest.staff_account_guard_sql_file);
  await f.saveManifest();
  assert.equal(check(await runPreflight(f.root), 'manifest_structure'), false);
  f.manifest.format_version = 2;
  delete f.manifest.staff_account_guard_sql_file;
  await f.saveManifest();
  assert.equal(check(await runPreflight(f.root), 'manifest_structure'), false);
});

test('the account guard must follow the pause and cannot be substituted for it', async t => {
  const f = await fixture(t);
  [f.manifest.sql_files[6], f.manifest.sql_files[7]] = [f.manifest.sql_files[7], f.manifest.sql_files[6]];
  await f.saveManifest();
  assert.equal(check(await runPreflight(f.root), 'manifest_structure'), false);
  [f.manifest.sql_files[6], f.manifest.sql_files[7]] = [f.manifest.sql_files[7], f.manifest.sql_files[6]];
  f.manifest.staff_account_guard_sql_file = f.manifest.intake_pause_sql_file;
  await f.saveManifest();
  assert.equal(check(await runPreflight(f.root), 'manifest_structure'), false);
});

test('weakened eligibility fails even when the manifest digest is refreshed', async t => {
  const f = await fixture(t);
  for (const next of [guardFixture.replace('account.is_anonymous is false', 'true'),
    guardFixture.replace('and account.email_confirmed_at is not null', ''),
    guardFixture.replace('and account.deleted_at is null', ''),
    guardFixture.replace('and (account.banned_until is null or account.banned_until <= now())', ''),
    guardFixture + '\ngrant execute on function private.current_staff_role() to public;\n']) {
    await f.alterSql(() => next, f.manifest.staff_account_guard_sql_file);
    const report = await runPreflight(f.root);
    assert.equal(report.checks.filter(row => row.name === 'sql_digest_matches').every(row => row.ok), true);
    assert.equal(check(report, 'eligible_staff_account_guard_declared'), false);
    assert.equal(report.status, 'failed');
  }
});

test('the retained optional preparation copy cannot also enter the active inventory', async t => {
  const f = await fixture(t);
  await f.put('supabase/migrations/20260909024020_require_eligible_staff_auth_account.sql', guardFixture);
  assert.equal(check(await runPreflight(f.root), 'migration_inventory_matches'), false);
});

test('active ten preserves the exact frozen eight baseline and both reviewed SQL copies',async()=>{
 const frozenBytes=await readFile(join(repository,'tools/office-preflight/history/manifest-eight-2026-09-09.json'));
 assert.equal(digest(frozenBytes),'572c8a631c293c1c2d322670b8f295de95e3baeb2fa59a82f2ae641e28812c68');
 const frozen=JSON.parse(frozenBytes);assert.equal(frozen.format_version,3);assert.equal(frozen.sql_files.length,8);assert.deepEqual(template.sql_files.slice(0,8),frozen.sql_files);
 const mapping=JSON.parse(await readFile(join(repository,'tools/office-preflight/direct-intake-hosted-history-2026-09-10.json'),'utf8'));
 assert.deepEqual(mapping.mappings.map(r=>r.actual_version),['20260910152017','20260910152030']);
 for(const row of mapping.mappings){const active=await readFile(join(repository,row.recommended_active_path)),reviewed=await readFile(join(repository,row.reviewed_path));assert.deepEqual(active,reviewed);assert.equal(digest(active),row.sha256);}
});

test('current packet requires both applied intake migrations and rejects the older active format',async t=>{
 for(const name of ['direct_intake_sql_file','dispatch_extensions_sql_file']){
  const f=await fixture(t);await rm(join(f.root,f.manifest[name]));f.manifest.sql_files=f.manifest.sql_files.filter(r=>r.path!==f.manifest[name]);await f.saveManifest();
  assert.equal(check(await runPreflight(f.root),'manifest_structure'),false);
 }
 const f=await fixture(t);f.manifest.format_version=3;await f.saveManifest();assert.equal(check(await runPreflight(f.root),'manifest_structure'),false);
});

test('direct intake and infrastructure sources must be distinct and follow the account guard',async t=>{
 const f=await fixture(t);[f.manifest.sql_files[8],f.manifest.sql_files[9]]=[f.manifest.sql_files[9],f.manifest.sql_files[8]];await f.saveManifest();assert.equal(check(await runPreflight(f.root),'manifest_structure'),false);
 [f.manifest.sql_files[8],f.manifest.sql_files[9]]=[f.manifest.sql_files[9],f.manifest.sql_files[8]];f.manifest.direct_intake_sql_file=f.manifest.staff_account_guard_sql_file;await f.saveManifest();assert.equal(check(await runPreflight(f.root),'manifest_structure'),false);
});

test('refreshing editable digests cannot weaken direct intake or add an unreviewed scheduler operation',async t=>{
 const f=await fixture(t);
 await f.alterSql(source=>source.replace("revoke all on private.app_intake_receipts", "grant all on private.app_intake_receipts"),f.manifest.direct_intake_sql_file);
 let report=await runPreflight(f.root);assert.equal(report.checks.filter(r=>r.name==='sql_digest_matches').every(r=>r.ok),true);assert.equal(check(report,'reviewed_direct_intake_declared'),false);
 await f.alterSql(()=>directFixture,f.manifest.direct_intake_sql_file);
 await f.alterSql(source=>source+"\nselect cron.schedule('unreviewed','* * * * *','select 1');\n",f.manifest.dispatch_extensions_sql_file);
 report=await runPreflight(f.root);assert.equal(report.checks.filter(r=>r.name==='sql_digest_matches').every(r=>r.ok),true);assert.equal(check(report,'reviewed_dispatch_extensions_declared'),false);
});

test('retained review filenames cannot also appear as active migrations',async t=>{
 const f=await fixture(t);await f.put('supabase/migrations/20260909212646_direct_app_intake.sql',directFixture);await f.put('supabase/migrations/20260909215330_direct_intake_dispatch_extensions.sql',extensionsFixture);
 assert.equal(check(await runPreflight(f.root),'migration_inventory_matches'),false);
});
