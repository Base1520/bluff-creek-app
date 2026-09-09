import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createArtifacts, EXPECTED_PROJECT_REF, parseInput, readInput, stageAccess, validateInput } from './index.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const input=()=>({projectRef:EXPECTED_PROJECT_REF,admins:[{email:'primary@example.invalid',userId:'00000000-0000-4000-8000-000000000001'},{email:'backup@example.invalid',userId:'00000000-0000-4000-8000-000000000002'}]});
async function temporary(t){const root=await mkdtemp(join(await realpath(tmpdir()),'creek-access-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
const mutate=fn=>{const value=input();fn(value);return value;};

test('exact church target and exactly two distinct admin bindings are required',()=>{
  assert.deepEqual(validateInput(input()),input());
  for(const value of [null,[],{},mutate(v=>v.projectRef='rkdqnxwvbpehfjcsaumt'),mutate(v=>v.role='admin'),mutate(v=>v.admins.pop()),mutate(v=>v.admins.push(v.admins[0])),mutate(v=>v.admins[0].role='admin'),mutate(v=>v.admins[0].userId='not-a-uuid'),mutate(v=>v.admins[0].userId='00000000-0000-0000-0000-000000000000'),mutate(v=>v.admins[1].userId=v.admins[0].userId),mutate(v=>v.admins[1].email='PRIMARY@EXAMPLE.INVALID')])assert.throws(()=>validateInput(value));
});
test('email parsing rejects ambiguity/unsafe forms and normalizes only case',()=>{
  for(const address of ['',' primary@example.invalid','primary@example.invalid ','a..b@example.invalid','.a@example.invalid','a.@example.invalid','a@-example.invalid','a@example-.invalid','a@example','a@127.0.0.1','a@example.invalid\n','a@éxample.invalid','"a b"@example.invalid','a@@example.invalid','a'.repeat(65)+'@example.invalid'])assert.throws(()=>validateInput(mutate(v=>v.admins[0].email=address)));
  const accepted=validateInput(mutate(v=>v.admins[0].email="O'Reilly+Office--@Example.Invalid"));assert.equal(accepted.admins[0].email,"o'reilly+office--@example.invalid");
  assert.notEqual(validateInput(mutate(v=>{v.admins[0].email='a.b@example.invalid';v.admins[1].email='ab@example.invalid';})).admins[0].email,'ab@example.invalid');
});
test('strict JSON rejects duplicate and escaped duplicate keys at every level',()=>{
  const source=JSON.stringify(input());assert.deepEqual(parseInput(source),input());
  for(const text of [source+'{}',source.replace('{','{"projectRef":"'+EXPECTED_PROJECT_REF+'",'),source.replace('"email":','"email":"extra@example.invalid","email":'),source.replace('"email":','"\\u0065mail":"extra@example.invalid","email":'),source.replace('"admins":','"admins":[],"admins":'),source.replace('"userId":','"userId":null,"x":'),source.replace('}]','},]'),source.replace('"projectRef":','"projectRef":true,"x":'),source+' '.repeat(8192)])assert.throws(()=>parseInput(text));
});
test('review outputs omit bindings and never claim identity/target validation or hosted mutation',()=>{
  const value=input(),packet=createArtifacts(value),report=packet.report;
  assert.deepEqual(Object.keys(packet.files).sort(),['SETUP-REVIEW.md','report.json','staff-admin-setup.sql']);
  for(const name of ['report.json','SETUP-REVIEW.md'])for(const row of value.admins)for(const secret of [row.email,row.userId])assert(!packet.files[name].includes(secret));
  for(const name of ['target_verified','auth_identities_verified','roles_changed','users_created','invitations_sent','network_used'])assert.equal(report[name],false);
  assert.equal(report.sql_contains_private_bindings,true);assert.equal(report.approved_binding_count,2);
  assert.match(packet.files['SETUP-REVIEW.md'],/SQL cannot verify the project reference/);
  assert.match(packet.files['SETUP-REVIEW.md'],/Confirm COMMIT succeeded/);
  assert.match(packet.files['staff-admin-setup.sql'],/lock table auth.users in share mode/);
  assert.match(packet.files['staff-admin-setup.sql'],/lock table public.staff_roles in share row exclusive mode/);
});
test('explicit staging uses private modes, excludes source paths and cannot overwrite',async t=>{
  const root=await temporary(t),output=join(root,'packet');await stageAccess(input(),output);
  assert.deepEqual((await readdir(output)).sort(),['SETUP-REVIEW.md','report.json','staff-admin-setup.sql']);
  assert.equal((await stat(output)).mode&0o777,0o700);
  for(const name of await readdir(output))assert.equal((await stat(join(output,name))).mode&0o777,0o600);
  const before=await readFile(join(output,'staff-admin-setup.sql'));await assert.rejects(stageAccess(input(),output));assert.deepEqual(await readFile(join(output,'staff-admin-setup.sql')),before);
  for(const destination of [join(here,'packet'),root+'/../escape',root+'/./packet',join(root,'absent','packet')])await assert.rejects(stageAccess(input(),destination));
});
test('input and output symlinks are rejected; private input bytes are unchanged',async t=>{
  const root=await temporary(t),file=join(root,'input.json'),source=JSON.stringify(input());await writeFile(file,source,{mode:0o600});assert.deepEqual(await readInput(file),input());
  const linked=join(root,'linked');await symlink(file,linked);await assert.rejects(readInput(linked));
  const dir=join(root,'alias');await symlink(root,dir);await assert.rejects(readInput(join(dir,'input.json')));await assert.rejects(stageAccess(input(),join(dir,'packet')));
  await assert.rejects(readInput(root));await assert.rejects(readInput(root+'/./input.json'));
  assert.equal(await readFile(file,'utf8'),source);await writeFile(join(root,'large.json'),' '.repeat(8193));await assert.rejects(readInput(join(root,'large.json')));
});
test('CLI defaults to validate only and never prints private paths, emails, UUIDs or source on failures',async t=>{
  const root=await temporary(t),file=join(root,'input.json'),output=join(root,'packet');await writeFile(file,JSON.stringify(input()),{mode:0o600});
  const run=args=>spawnSync(process.execPath,[join(here,'cli.mjs'),...args],{encoding:'utf8',timeout:10000});
  const validate=run(['--input',file]);assert.equal(validate.status,0);assert.deepEqual(await readdir(root),['input.json']);
  const stage=run(['--input',file,'--output',output]);assert.equal(stage.status,0);
  const again=run(['--input',file,'--output',output]);assert.equal(again.status,1);
  const unknown=run(['--input',file,'--email',input().admins[0].email]);assert.equal(unknown.status,2);
  await writeFile(file,'{"bad":"'+input().admins[0].email+'"}');const malformed=run(['--input',file]);assert.equal(malformed.status,1);
  for(const result of [validate,stage,again,unknown,malformed])for(const secret of [file,output,...input().admins.flatMap(row=>[row.email,row.userId])])assert(!(result.stdout+result.stderr).includes(secret));
});
