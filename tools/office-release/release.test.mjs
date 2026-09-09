import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { checkClosure, DEFAULT_ROOT, prepareRelease, stageRelease, validateManifest } from './index.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const manifest=JSON.parse(await readFile(join(here,'manifest.json'),'utf8'));
const ref='rkdqnxwvbpehfjcsaumt',key='sb_publishable_aA0bB1cC2dD3eE4fF5gG6hH7iI8jJ9';
const input=(extra={})=>({projectRef:ref,supabaseUrl:`https://${ref}.supabase.co`,publishableKey:key,appOrigin:'https://office.riverparish.org',publicSignupEnabled:false,...extra});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceBytes=new Map(await Promise.all(manifest.files.filter(name=>!['admin/config.js','js/connection-config.js'].includes(name)).map(async name=>[name,await readFile(join(DEFAULT_ROOT,name))])));
async function fixture(t) {
  const temp=await mkdtemp(join(await realpath(tmpdir()),'creek-release-'));t.after(()=>rm(temp,{recursive:true,force:true}));
  const root=join(temp,'source');await mkdir(root,{mode:0o700});
  for(const [name,bytes]of sourceBytes){await mkdir(dirname(join(root,name)),{recursive:true,mode:0o700});await writeFile(join(root,name),bytes,{mode:0o600});}
  return {temp,root,out:join(temp,'packet')};
}
async function tree(root,prefix='') {let results=[];for(const entry of await readdir(join(root,prefix),{withFileTypes:true})){const name=prefix?prefix+'/'+entry.name:entry.name;results.push(...entry.isDirectory()?await tree(root,name):[name]);}return results.sort();}
function browserConfig(bytes,name){const context={window:{}};runInNewContext(bytes.toString(),context);return JSON.parse(JSON.stringify(context.window[name]));}

test('allowlist is explicit, unique and requires the full public/connection/recovery entry paths', () => {
  assert.equal(validateManifest(manifest).length,49);
  for(const name of ['connection.html','css/connection.css','admin/recovery.html'])assert.throws(()=>validateManifest({...manifest,files:manifest.files.filter(file=>file!==name)}));
  for(const name of ['../private.json','.git/config','tools/private.js','docs/notes.html','admin/tests/fixture.js','admin/config.example.js','assets/private.json','CNAME','admin/fixture.js','assets/../private.png'])assert.throws(()=>validateManifest({...manifest,files:[...manifest.files,name]}));
  assert.throws(()=>validateManifest({...manifest,files:[...manifest.files,'index.html']}));
});

test('complete static package passes closure and stages exact byte copies beside generated hosted configs',async t=>{
  const f=await fixture(t),packet=await prepareRelease({root:f.root,input:input()});
  assert.equal(packet.report.file_count,manifest.files.length);assert.equal(packet.report.closure.linked_asset_completeness,'passed_static_paths');
  assert.equal(packet.report.closure.public_cache,'creek-v12');assert.equal(packet.report.service_worker_changed,false);
  assert.equal(packet.report.local_office_preflight.status,'separate_required_check');
  await stageRelease({root:f.root,input:input(),output:f.out});
  assert.deepEqual(await tree(join(f.out,'site')),manifest.files.slice().sort());
  assert.deepEqual((await readdir(f.out)).sort(),['RELEASE-REVIEW.md','SETUP-CHECKLIST.md','review-manifest.json','site']);
  for(const record of packet.report.files){const bytes=await readFile(join(f.out,'site',record.path));assert.equal(hash(bytes),record.sha256);assert.equal(bytes.length,record.bytes);if(sourceBytes.has(record.path))assert.deepEqual(bytes,sourceBytes.get(record.path));}
  assert.equal((await stat(f.out)).mode&0o777,0o700);assert.equal((await stat(join(f.out,'site/admin'))).mode&0o777,0o700);assert.equal((await stat(join(f.out,'site/admin/config.js'))).mode&0o777,0o600);
});

test('source/demo configs are not read, copied or modified, and staff-only public config remains blank',async t=>{
  const f=await fixture(t),sentinel='window.CREEK_OFFICE_CONFIG={localDevelopment:true,publishableKey:"sb_secret_fictional_do_not_copy"};';
  await writeFile(join(f.root,'admin/config.js'),sentinel);await writeFile(join(f.root,'js/connection-config.js'),sentinel);
  const packet=await prepareRelease({root:f.root,input:input()});
  assert.equal(packet.report.source_configuration_read,false);assert.equal(packet.report.source_configuration_changed,false);
  assert.equal(await readFile(join(f.root,'admin/config.js'),'utf8'),sentinel);assert.equal(await readFile(join(f.root,'js/connection-config.js'),'utf8'),sentinel);
  const office=browserConfig(packet.files.get('admin/config.js'),'CREEK_OFFICE_CONFIG'),connection=browserConfig(packet.files.get('js/connection-config.js'),'CREEK_CONNECTION_CONFIG');
  assert.equal(office.supabaseUrl,input().supabaseUrl);assert.equal(office.publishableKey,key);assert.equal(office.membershipSheetUrl,'');assert(!Object.hasOwn(office,'localDevelopment'));
  assert.deepEqual(connection,{supabaseUrl:'',publishableKey:'',allowedOrigins:[]});
  assert(![...packet.files.values()].some(bytes=>bytes.toString().includes('fictional_do_not_copy')));
});

test('public signup staging remains explicit and redacted review files stay outside site',async t=>{
  const f=await fixture(t);await stageRelease({root:f.root,input:input({publicSignupEnabled:true}),output:f.out});
  const connection=browserConfig(await readFile(join(f.out,'site/js/connection-config.js')),'CREEK_CONNECTION_CONFIG');
  assert.equal(connection.publishableKey,key);assert.deepEqual(connection.allowedOrigins,[input().appOrigin]);
  const report=JSON.parse(await readFile(join(f.out,'review-manifest.json'),'utf8'));assert.equal(report.wiring.public_signup_ui_staged,true);assert.equal(report.wiring.hosted_auth_signup_posture,'unverified');
  for(const name of ['review-manifest.json','SETUP-CHECKLIST.md','RELEASE-REVIEW.md']){const text=await readFile(join(f.out,name),'utf8');assert(!text.includes(key));assert(!(await tree(join(f.out,'site'))).includes(name));}
});

test('unlisted private files, repository metadata and hosting configuration cannot enter the site',async t=>{
  const f=await fixture(t);for(const name of ['.git/config','docs/notes.md','tests/fixture.js','tools/private.json','supabase/migrations/private.sql','admin/tests/private.json','brand/index.html','CNAME','private.csv','admin/extra.js']){await mkdir(dirname(join(f.root,name)),{recursive:true});await writeFile(join(f.root,name),'FICTIONAL-EXCLUDED-CONTENT');}
  const packet=await prepareRelease({root:f.root,input:input()});assert.equal(packet.files.size,49);assert(![...packet.files.values()].some(bytes=>bytes.toString().includes('FICTIONAL-EXCLUDED-CONTENT')));
});

test('missing connection page/CSS or recovery assets fail before creating any output',async t=>{
  const f=await fixture(t);for(const name of ['connection.html','css/connection.css','admin/recovery.js','assets/fonts/bitter-latin-normal-v42.woff2']){const file=join(f.root,name),original=await readFile(file);await rm(file);await assert.rejects(stageRelease({root:f.root,input:input(),output:f.out}));assert(!(await readdir(f.temp)).includes('packet'));await writeFile(file,original);}
});

test('static link closure catches missing CSS images, scripts, root routes and manifest icons',async t=>{
  const f=await fixture(t),packet=await prepareRelease({root:f.root,input:input()});
  for(const [name,extra]of [['index.html','<script src="js/missing.js"></script>'],['admin/help.html','<a href="../missing.html">Missing</a>'],['css/connection.css','body{background:url(../assets/missing.png)}']]){const files=new Map(packet.files);files.set(name,Buffer.concat([files.get(name),Buffer.from(extra)]));assert.throws(()=>checkClosure(files,input().appOrigin));}
  const files=new Map(packet.files),web=JSON.parse(files.get('manifest.webmanifest'));web.icons[0].src='assets/missing.png';files.set('manifest.webmanifest',Buffer.from(JSON.stringify(web)));assert.throws(()=>checkClosure(files,input().appOrigin));
});

test('public service-worker list cannot absorb private office or connection files',async t=>{
  const f=await fixture(t),packet=await prepareRelease({root:f.root,input:input()});
  for(const name of ['./admin/config.js','./connection.html','./js/connection.js']){const files=new Map(packet.files);files.set('sw.js',Buffer.from(files.get('sw.js').toString().replace('const SHELL = [',`const SHELL = ['${name}',`)));assert.throws(()=>checkClosure(files,input().appOrigin),/PRIVATE_ROUTE_IN_PUBLIC_CACHE/);}
});

test('injected demo prefills, inline auth overrides and loopback config literals are rejected',async t=>{
  const f=await fixture(t),file=join(f.root,'admin/index.html'),original=await readFile(file);
  for(const injected of ['<input type="password" value="fictional-prefill">','<input type="email" value="practice@example.invalid">','<script>window.CREEK_OFFICE_CONFIG={};</script>','<script>const test={localDevelopment:true};</script>','<script>document.getElementById("email").value="practice@example.invalid";</script>','<script>document.getElementById("password").value="fictional-pass";</script>','<script>const account="practice@office-rehearsal.invalid";</script>']){await writeFile(file,Buffer.concat([original,Buffer.from(injected)]));await assert.rejects(stageRelease({root:f.root,input:input(),output:f.out}));assert(!(await readdir(f.temp)).includes('packet'));}
});

test('source symlinks, unsafe output paths and existing outputs are refused without overwrite',async t=>{
  const f=await fixture(t),file=join(f.root,'connection.html');await rm(file);await symlink(join(DEFAULT_ROOT,'connection.html'),file);await assert.rejects(prepareRelease({root:f.root,input:input()}));await rm(file);await writeFile(file,sourceBytes.get('connection.html'));
  const linked=join(f.temp,'linked');await symlink(f.temp,linked);
  for(const output of [f.temp+'/source/../escape',join(linked,'packet'),f.temp+'/./packet',join(f.temp,'absent','packet')])await assert.rejects(stageRelease({root:f.root,input:input(),output}));
  await assert.rejects(stageRelease({root:f.root,input:input(),output:join(f.root,'packet')}),/OUTPUT_INSIDE_SOURCE/);assert(!(await readdir(f.root)).includes('packet'));
  await mkdir(f.out);await writeFile(join(f.out,'keep.txt'),'keep');await assert.rejects(stageRelease({root:f.root,input:input(),output:f.out}));assert.equal(await readFile(join(f.out,'keep.txt'),'utf8'),'keep');
});

test('private spreadsheet links in public static sources fail before any packet is written',async t=>{
  const f=await fixture(t);
  const cases=[
    ['admin/index.html','<a href="https://docs.google.com/spreadsheets/d/fictional-private-ledger/edit">Review requests</a>'],
    ['admin/help.html','<a href="//docs.google.com/spreadsheets/u/0/d/fictional-private-ledger/edit">Ledger</a>'],
    ['admin/index.html','<a href="https&#58;&#47;&#47;docs.google.com/spreadsheets/d/fictional-private-ledger/edit">Ledger</a>'],
    ['admin/app.js','\nconst privateSource="https://docs.google.com/spreadsheets/d/fictional-private-ledger/edit";']
  ];
  for(const [name,injected] of cases){
    const file=join(f.root,name),original=await readFile(file);
    await writeFile(file,Buffer.concat([original,Buffer.from(injected)]));
    await assert.rejects(stageRelease({root:f.root,input:input(),output:f.out}),error=>error.message==='SPREADSHEET_LINK_IN_STATIC_SOURCE' && !error.message.includes('fictional-private-ledger'));
    assert(!(await readdir(f.temp)).includes('packet'));
    await writeFile(file,original);
  }
});

test('CLI defaults to validate-only and prints neither synthetic key nor config values on error/success',async t=>{
  const f=await fixture(t),inputFile=join(f.temp,'input.json');await writeFile(inputFile,JSON.stringify(input()),{mode:0o600});
  const run=args=>spawnSync(process.execPath,[join(here,'cli.mjs'),...args],{encoding:'utf8',timeout:10000});
  const validated=run(['--input',inputFile,'--root',f.root]);assert.equal(validated.status,0);assert(!(await readdir(f.temp)).includes('packet'));
  const staged=run(['--input',inputFile,'--root',f.root,'--output',f.out]);assert.equal(staged.status,0);
  const repeated=run(['--input',inputFile,'--root',f.root,'--output',f.out]);assert.equal(repeated.status,1);
  const unknown=run(['--input',inputFile,'--root',f.root,'--secret',key]);assert.equal(unknown.status,2);
  for(const result of [validated,staged,repeated,unknown])for(const sensitive of [key,ref,inputFile,f.root,f.out])assert(!(result.stdout+result.stderr).includes(sensitive));
});
