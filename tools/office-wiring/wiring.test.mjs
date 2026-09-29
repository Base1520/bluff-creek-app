import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { createArtifacts, parseInput, readInput, stageWiring, validateInput } from './index.mjs';
import { configurationPresence } from '../office-preflight/index.mjs';

const require = createRequire(import.meta.url);
const recovery = require('../../admin/recovery.js');
const connection = require('../../js/connection.js');
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, 'cli.mjs');
const ref = 'rkdqnxwvbpehfjcsaumt';
const key = 'sb_publishable_aA0bB1cC2dD3eE4fF5gG6hH7iI8jJ9';
const origin = 'https://office.riverparish.org';
const fixture = (extra = {}) => ({projectRef:ref, supabaseUrl:`https://${ref}.supabase.co`, publishableKey:key, appOrigin:origin, publicSignupEnabled:false, ...extra});
function configFrom(source, property) { const context = {window:{}};runInNewContext(source,context);return JSON.parse(JSON.stringify(context.window[property])); }
async function temp(t) { const root=await mkdtemp(join(await realpath(tmpdir()),'creek-wiring-'));t.after(()=>rm(root,{recursive:true,force:true}));return root; }
function run(args) { return spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:10000}); }

test('strict input accepts only the intended flat types and requires an explicit signup decision', () => {
  for(const publicSignupEnabled of [false,true]) {
    const value=parseInput(JSON.stringify(fixture({publicSignupEnabled,membershipSheetUrl:''})));
    assert.equal(value.publicSignupEnabled,publicSignupEnabled);
    assert.equal(Object.hasOwn(value,'membershipSheetUrl'),false);
    assert(Object.isFrozen(value));
  }
  for(const field of ['projectRef','supabaseUrl','publishableKey','appOrigin','publicSignupEnabled']) {
    const row=fixture();delete row[field];assert.throws(()=>validateInput(row));
  }
  for(const value of ['false',0,null,{},[]])assert.throws(()=>validateInput(fixture({publicSignupEnabled:value})));
});

test('unknown and duplicate keys cannot hide config overrides or executable payloads', () => {
  const good=JSON.stringify(fixture());
  for(const source of [
    good.replace('{','{"publicSignupEnabled":true,'),
    good.replace('{','{"publicSignup\\u0045nabled":true,'),
    good.replace('{','{"serviceRoleKey":"anything",'),
    good.replace('{','{"__proto__":"anything",'),
    good.replace('{','{/*comment*/'),good.slice(0,-1)+',}',
    '['+good+']',good+';',good+' {}',good.replace('false','{"nested":true}'),
    good.replace('false','null'),good.replace('false','falsehood'),
    good.replace('false','[true]'),'{"projectRef":NaN}'
  ])assert.throws(()=>parseInput(source));
});

test('project references and URLs must match exactly, without placeholders or URL normalization', () => {
  for(const projectRef of ['',null,ref+'x',ref.slice(1),ref.toUpperCase(),ref+'\n',ref+'\r','a'.repeat(20),'abcdefghijklmnopqrst','replaceabcdefghijklm',ref.slice(0,-1)+'1'])assert.throws(()=>validateInput(fixture({projectRef})));
  for(const supabaseUrl of [`http://${ref}.supabase.co`,`https://${ref}.supabase.co/`,`https://${ref}.supabase.co:443`,`https://${ref}.supabase.co?`,`https://${ref}.supabase.co#`,`https://${ref}.supabase.co/rest/v1`,`https://otherprojectrefxxxxx.supabase.co`,`https://user@${ref}.supabase.co`,`https://${ref}.supabase.co.evil.org`,fixture().supabaseUrl+'\n'])assert.throws(()=>validateInput(fixture({supabaseUrl})));
});

test('modern publishable syntax rejects secrets, legacy JWTs, placeholders and final newlines', () => {
  const legacy='eyJhbGciOiJIUzI1NiJ9.'+Buffer.from('{"role":"anon"}').toString('base64url')+'.signature';
  for(const publishableKey of ['',null,'sb_secret_abcd','service_role',legacy,'sb_publishable_','sb_publishable_replace_me','sb_publishable_YOUR_KEY','sb_publishable_service_role','sb_publishable_test',key+'\n',key+'\r',key+'\r\n',' '+key,key+' ',key+';',key+'/',key+'😀'])assert.throws(()=>validateInput(fixture({publishableKey})));
});

test('app origins reject traversal, credentials, IPs, private/testing names, ports and ambiguous normalization', () => {
  for(const appOrigin of [
    'http://office.riverparish.org',origin+'/',origin+'/admin',origin+'/../',origin+'?',origin+'#',origin+':443',origin+':8080',origin+'\n',
    'https://user:pass@office.riverparish.org','https://office.riverparish.org\\admin','https://OFFICE.riverparish.org','https://office.riverparish.org.',
    'https://localhost','https://localhost.localdomain','https://127.0.0.1','https://127.1','https://2130706433','https://[::1]',
    'https://church.local','https://church.internal','https://church.example','https://example.com','https://app.example.org','https://church.test','https://church.invalid',
    'https://127-0-0-1.nip.io','https://church.localtest.me','https://church.lvh.me','https://church.sslip.io',
    'https://xn--bcher-kva.org','https://bücher.org','https://bad_name.org','https://-church.org','https://church-.org','https://singlehost'
  ])assert.throws(()=>validateInput(fixture({appOrigin})),appOrigin);
});

test('membership links are never staged, even a valid Google Sheets URL', () => {
  for(const membershipSheetUrl of [' ','https://docs.google.com/spreadsheets/d/fictional-ledger/edit',null,false])assert.throws(()=>createArtifacts(fixture({membershipSheetUrl})));
  const packet=createArtifacts(fixture({membershipSheetUrl:''}));
  assert.equal(configFrom(packet.files['admin/config.js'],'CREEK_OFFICE_CONFIG').membershipSheetUrl,'');
  assert(!Object.values(packet.files).join('').includes('fictional-ledger'));
});

test('staff-only browser packet keeps public config blank and passes real office preflight/recovery contracts', () => {
  const packet=createArtifacts(fixture()),office=configFrom(packet.files['admin/config.js'],'CREEK_OFFICE_CONFIG');
  assert.deepEqual(Object.keys(office),['supabaseUrl','publishableKey','membershipSheetUrl']);
  assert.deepEqual(configurationPresence(packet.files['admin/config.js']),{status:'supplied_unverified',project_url_present:true,publishable_key_present:true,membership_link_present:false});
  assert.deepEqual(recovery.settings(office,{href:origin+'/admin/recovery.html'}),{url:fixture().supabaseUrl,key,redirect:origin+'/admin/recovery.html'});
  const publicConfig=configFrom(packet.files['js/connection-config.js'],'CREEK_CONNECTION_CONFIG');
  assert.deepEqual(publicConfig,{supabaseUrl:'',publishableKey:'',allowedOrigins:[]});
  assert.equal(connection.settings(publicConfig,{href:origin+'/connection.html'}),null);
  assert.equal(packet.report.mode,'staff browser configuration only');
  assert.equal(packet.report.public_signup_ui_staged,false);
  assert.equal(packet.report.hosted_auth_signup_posture,'unverified');
  assert.deepEqual(packet.report.redirect_allowlist_for_review,[origin+'/admin/recovery.html']);
});

test('historical public UI staging preserves its origin but cannot enable the current direct-intake client', () => {
  const packet=createArtifacts(fixture({publicSignupEnabled:true}));
  const office=configFrom(packet.files['admin/config.js'],'CREEK_OFFICE_CONFIG'),publicConfig=configFrom(packet.files['js/connection-config.js'],'CREEK_CONNECTION_CONFIG');
  assert.equal(publicConfig.supabaseUrl,office.supabaseUrl);assert.equal(publicConfig.publishableKey,office.publishableKey);
  assert.deepEqual(publicConfig.allowedOrigins,[origin]);
  assert.equal(connection.settings(publicConfig,{href:origin+'/connection.html'}),null);
  assert.equal(packet.report.direct_intake_activation_supported,false);
  assert.equal(packet.report.database_baseline_manifest,'tools/office-preflight/history/manifest-eight-2026-09-09.json');
  for(const href of ['https://other.riverparish.org/connection.html',origin+'/admin/',origin+'/connection.html/'])assert.equal(connection.settings(publicConfig,{href}),null);
  assert.deepEqual(packet.report.redirect_allowlist_for_review,[origin+'/admin/recovery.html',origin+'/connection.html']);
  assert.equal(packet.report.hosted_auth_signup_posture,'unverified');
});

test('report/checklist redact key values and preserve pending ownership/signup/setup decisions', () => {
  for(const publicSignupEnabled of [false,true]) {
    const packet=createArtifacts(fixture({publicSignupEnabled}));
    const redacted=packet.files['report.json']+packet.files['SETUP-CHECKLIST.md'];
    assert(!redacted.includes(key));assert(!redacted.includes('sb_publishable_'));
    assert.equal(packet.report.opaque_key_project_match,'not_verified_offline');
    assert.equal(packet.report.schema_applied,false);assert.equal(packet.report.network_used,false);
    assert.equal(packet.report.reviewed_database_intake_default,'paused_after_complete_migration_sequence');
    assert.equal(packet.report.hosted_database_intake_state,'unverified');
    assert.match(redacted,/does not disable Auth signup or email sending/);
    assert.match(redacted,/allow-new-signups/);assert.match(redacted,/Do not copy the local rehearsal setting auth.enable_signup=true/);
    assert.match(redacted,/does not disable backend Auth signup or RPCs/);
    assert.match(redacted,/staff_roles/);assert.match(redacted,/frozen eight-file staff-first baseline/);
    assert.doesNotMatch(redacted,/supabase db push|supabase migration up|psql |INSERT INTO|curl /i);
  }
});

test('explicit staging creates only fixed review artifacts with private permissions and never overwrites', async t => {
  const root=await temp(t),out=join(root,'packet');
  const before=await readFile(join(here,'../../admin/config.js'),'utf8');
  await stageWiring(fixture(),out);
  assert.deepEqual((await readdir(out)).sort(),['SETUP-CHECKLIST.md','admin','js','report.json']);
  for(const directory of [out,join(out,'admin'),join(out,'js')])assert.equal((await stat(directory)).mode&0o777,0o700);
  for(const name of ['admin/config.js','js/connection-config.js','report.json','SETUP-CHECKLIST.md'])assert.equal((await stat(join(out,name))).mode&0o777,0o600);
  const existing=await readFile(join(out,'admin/config.js'),'utf8');
  await assert.rejects(stageWiring(fixture({publicSignupEnabled:true}),out),/OUTPUT_ALREADY_EXISTS/);
  assert.equal(await readFile(join(out,'admin/config.js'),'utf8'),existing);
  const empty=join(root,'empty');await mkdir(empty);await assert.rejects(stageWiring(fixture(),empty));assert.deepEqual(await readdir(empty),[]);
  assert.equal(await readFile(join(here,'../../admin/config.js'),'utf8'),before);
});

test('traversal, missing parents and symlink destinations/ancestors cannot receive staged files', async t => {
  const root=await temp(t),real=join(root,'real');await mkdir(real);
  const linked=join(root,'linked');await symlink(real,linked);
  for(const output of [root+'/real/../escape',root+'/./escape',root+'\\escape',join(root,'missing','packet'),linked,join(linked,'packet')])await assert.rejects(stageWiring(fixture(),output));
  const dangling=join(root,'dangling');await symlink(join(root,'absent'),dangling);await assert.rejects(stageWiring(fixture(),dangling));
  assert.deepEqual(await readdir(real),[]);
  assert(!(await readdir(root)).includes('escape'));
});

test('input reads reject symlinks, directories, oversized files and keep errors free of input contents', async t => {
  const root=await temp(t),input=join(root,'input.json');await writeFile(input,JSON.stringify(fixture()),{mode:0o600});
  assert.equal((await readInput(input)).projectRef,ref);
  const linked=join(root,'input-link');await symlink(input,linked);await assert.rejects(readInput(linked));
  const ancestor=join(root,'folder-link');await symlink(root,ancestor);await assert.rejects(readInput(join(ancestor,'input.json')));
  await assert.rejects(readInput(root));
  await writeFile(input,'x'.repeat(65537));await assert.rejects(readInput(input));
  await writeFile(input,JSON.stringify(fixture({publishableKey:'sb_secret_do_not_print'})));
  await assert.rejects(readInput(input),error=>!error.message.includes('sb_secret_do_not_print'));
});

test('CLI validates by default, stages only on explicit output, and never prints config values', async t => {
  const root=await temp(t),input=join(root,'input.json');await writeFile(input,JSON.stringify(fixture()),{mode:0o600});
  const valid=run(['--input',input]);assert.equal(valid.status,0);assert.match(valid.stdout,/No files written/);assert.deepEqual(await readdir(root),['input.json']);
  const out=join(root,'packet'),staged=run(['--input',input,'--output',out]);assert.equal(staged.status,0);assert.match(staged.stdout,/Private review packet staged/);
  const repeat=run(['--input',input,'--output',out]);assert.equal(repeat.status,1);
  for(const result of [valid,staged,repeat])for(const value of [key,ref,origin,input,out])assert(!(result.stdout+result.stderr).includes(value));
  for(const args of [[],['--output',join(root,'no-input')],['--input',input,'--input',input],['--input',input,'--publicSignupEnabled','true'],['--input',input,'--output'],['--publishableKey','sb_secret_do_not_print']]) {
    const bad=run(args);assert.notEqual(bad.status,0);assert(!(bad.stdout+bad.stderr).includes('sb_secret_do_not_print'));
  }
});

test('placeholder example and invalid key input cannot create a packet or leak values', async t => {
  const root=await temp(t),out=join(root,'packet');
  const example=run(['--input',join(here,'input.example.json'),'--output',out]);assert.equal(example.status,1);assert.deepEqual(await readdir(root),[]);
  const input=join(root,'bad.json');await writeFile(input,JSON.stringify(fixture({publishableKey:'sb_secret_never_echo_this'})),{mode:0o600});
  const result=run(['--input',input,'--output',out]);assert.equal(result.status,1);assert(!(result.stdout+result.stderr).includes('sb_secret_never_echo_this'));assert.deepEqual(await readdir(root),['bad.json']);
});
