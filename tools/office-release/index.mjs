import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifacts } from '../office-wiring/index.mjs';

const TOOL_ROOT = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(TOOL_ROOT, '../..');
const GENERATED = ['admin/config.js', 'js/connection-config.js'];
const REQUIRED = ['index.html','connection.html','css/connection.css','js/connection.js','js/connection-config.js','admin/index.html','admin/recovery.html','admin/recovery.js','admin/config.js','manifest.webmanifest','sw.js'];
const fail = code => { throw new Error(code); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const allowed = name => typeof name === 'string' && !/(?:^|\/)(?:\.|private|fixtures?|tests?|docs|tools|supabase|node_modules)(?:\/|\.|$)/i.test(name) && (
  /^(?:index|connection)\.html$|^manifest\.webmanifest$|^sw\.js$|^events\.json$|^calendar\.ics$/.test(name)
  || /^(?:js|css)\/[a-z][a-z0-9-]*\.(?:js|css)$/.test(name)
  || /^admin\/[a-z][a-z0-9-]*\.(?:html|js|css)$/.test(name)
  || /^assets\/[a-z][a-z0-9-]*\.(?:png|svg)$/.test(name)
  || /^assets\/fonts\/(?:[a-z][a-z0-9-]*\.woff2|OFL-(?:Bitter|NunitoSans)\.txt)$/.test(name)
);

export function validateManifest(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'files,format_version' || value.format_version !== 1 || !Array.isArray(value.files) || value.files.length > 200 || value.files.some(name => !allowed(name)) || new Set(value.files).size !== value.files.length || REQUIRED.some(name => !value.files.includes(name))) fail('INVALID_RELEASE_MANIFEST');
  return value.files.slice();
}

function safePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || value.split('/').some(part => part === '.' || part === '..')) fail('UNSAFE_LOCAL_PATH');
  return resolve(value);
}
async function inspect(path, missingFinal = false) {
  const base=parse(path).root,parts=path.slice(base.length).split(sep).filter(Boolean);let current=base;
  for(let i=0;i<parts.length;i++) {
    current=resolve(current,parts[i]);
    try { const info=await lstat(current);if(info.isSymbolicLink() || (i<parts.length-1 && !info.isDirectory()))fail('UNSAFE_LOCAL_PATH');if(i===parts.length-1)return info; }
    catch(error) { if(error.code==='ENOENT'&&missingFinal&&i===parts.length-1)return null;fail('UNSAFE_LOCAL_PATH'); }
  }
  return lstat(base);
}
async function readSource(path) {
  const info=await inspect(path);if(!info.isFile()||info.size>8*1024*1024)fail('INVALID_RELEASE_FILE');
  let handle;
  try {
    handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const before=await handle.stat();if(!before.isFile()||before.ino!==info.ino||before.dev!==info.dev||before.size>8*1024*1024)fail('INVALID_RELEASE_FILE');
    const bytes=await handle.readFile(),after=await handle.stat();
    if(bytes.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)fail('SOURCE_CHANGED_DURING_READ');
    return bytes;
  } catch (_) { fail('RELEASE_SOURCE_READ_FAILED'); }
  finally { await handle?.close(); }
}

function decodeAttribute(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt);|&#(?:x[\da-f]+|\d+);/gi,token=>{
    const named={'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>'};
    if(named[token.toLowerCase()])return named[token.toLowerCase()];
    const raw=token.slice(2,-1),n=raw[0].toLowerCase()==='x'?parseInt(raw.slice(1),16):parseInt(raw,10);
    return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';
  });
}
function attributes(tag) {
  return [...tag.matchAll(/\b([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].map(row=>[row[1].toLowerCase(),decodeAttribute(row[2]??row[3]??row[4])]);
}

export function checkClosure(files, origin) {
  const edges=new Set(),external=new Set();
  function link(from,value,base=from) {
    if(!value||value.startsWith('#')||/^(?:data|mailto|tel|blob):/i.test(value))return;
    if(/^(?:javascript|file):/i.test(value))fail('UNSAFE_LINK');
    let url;try {url=new URL(value,new URL(base,origin+'/'));}catch(_){fail('INVALID_STATIC_LINK');}
    if(from.startsWith('admin/') && url.hostname==='docs.google.com' && /^\/spreadsheets\/(?:u\/\d+\/)?d\//i.test(url.pathname))fail('SPREADSHEET_LINK_IN_STATIC_SOURCE');
    if(url.origin!==origin){external.add(url.origin);return;}
    let name;try{name=decodeURIComponent(url.pathname.slice(1));}catch(_){fail('INVALID_STATIC_LINK');}
    if(!name||name.endsWith('/'))name+='index.html';
    if(!files.has(name))fail('STATIC_LINK_NOT_IN_RELEASE');
    edges.add(from+' -> '+name);
  }
  function cssLinks(from,source) {
    for(const match of source.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/gi))link(from,match[1]??match[2]??match[3]);
    for(const match of source.matchAll(/@import\s+["']([^"']+)["']/gi))link(from,match[1]);
  }
  for(const [name,bytes] of files) {
    // Office source spreadsheets are private inputs. This catches literal links
    // in markup and scripts, not arbitrary personal data or dynamic URL assembly.
    if(name.startsWith('admin/') && /\.(?:html|js|css)$/.test(name) && /(?:https?:)?\/\/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\//i.test(decodeAttribute(bytes.toString('utf8'))))fail('SPREADSHEET_LINK_IN_STATIC_SOURCE');
    if(name.endsWith('.html')) {
      const source=bytes.toString('utf8');
      if(/<base\b/i.test(source))fail('UNSUPPORTED_BASE_ELEMENT');
      const markup=source.replace(/<script\b([^>]*)>[\s\S]*?<\/script\s*>/gi,'<script $1></script>').replace(/<!--[\s\S]*?-->/g,'');
      for(const tag of markup.matchAll(/<[a-z][^>]*>/gi)) {
        const attrs=attributes(tag[0]),map=Object.fromEntries(attrs);
        if(/^<input\b/i.test(tag[0]) && ['email','password'].includes((map.type||'').toLowerCase()) && map.value)fail('PREFILLED_ACCOUNT_INPUT');
        for(const [key,value] of attrs) {
          if(['src','href','poster','action'].includes(key))link(name,value);
          if(key==='srcset')for(const part of value.split(','))link(name,part.trim().split(/\s+/)[0]);
          if(key==='style')cssLinks(name,value);
        }
      }
      for(const style of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi))cssLinks(name,style[1]);
    } else if(name.endsWith('.css'))cssLinks(name,bytes.toString('utf8'));
    else if(name.endsWith('.js')&&!GENERATED.includes(name)) {
      const source=bytes.toString('utf8');
      // Literal resource paths used by the current nonbundled runtime. Dynamic
      // runtime URLs remain a separate browser/hosted acceptance check.
      for(const match of source.matchAll(/["']((?:\.?\/|assets\/|css\/|js\/|admin\/)[^"'\s]*\.(?:js|css|html|png|svg|woff2|json|ics|webmanifest))["']/g))link(name,match[1],'index.html');
      for(const match of source.matchAll(/(?:register|importScripts)\(\s*["']([^"']+)["']/g))link(name,match[1],'index.html');
    }
  }
  let manifest;try{manifest=JSON.parse(files.get('manifest.webmanifest').toString());}catch(_){fail('INVALID_WEB_MANIFEST');}
  if(manifest.scope!=='./'||manifest.start_url!=='./index.html'||!Array.isArray(manifest.icons)||!manifest.icons.length)fail('INVALID_WEB_MANIFEST');
  link('manifest.webmanifest',manifest.start_url);for(const icon of manifest.icons)link('manifest.webmanifest',icon.src);
  const sw=files.get('sw.js').toString(),shell=sw.match(/const SHELL\s*=\s*\[([\s\S]*?)\]\.map/);
  if(!shell)fail('UNSUPPORTED_PUBLIC_CACHE_MANIFEST');
  const tokens=[...shell[1].matchAll(/(['"])([^'"\\]+)\1/g)];
  if(!tokens.length||shell[1].replace(/(['"])([^'"\\]+)\1/g,'').replace(/[\s,]/g,''))fail('UNSUPPORTED_PUBLIC_CACHE_MANIFEST');
  for(const token of tokens) {
    link('sw.js',token[2],'index.html');
    const path=new URL(token[2],origin+'/').pathname;
    if(path.startsWith('/admin')||path==='/connection.html'||path.startsWith('/js/connection'))fail('PRIVATE_ROUTE_IN_PUBLIC_CACHE');
  }
  return {linked_asset_completeness:'passed_static_paths',local_reference_count:edges.size,external_origins:[...external].sort(),public_cache:sw.match(/const CACHE\s*=\s*['"]([a-z0-9-]+)['"]/)?.[1]||'unidentified',public_shell_entries:tokens.length};
}

export async function prepareRelease({root=DEFAULT_ROOT,input}) {
  const target=safePath(root),info=await inspect(target);if(!info.isDirectory())fail('INVALID_SOURCE_ROOT');
  const wiring=createArtifacts(input);
  let manifest,manifestBytes;try{manifestBytes=await readSource(resolve(TOOL_ROOT,'manifest.json'));manifest=JSON.parse(manifestBytes.toString());}catch(_){fail('INVALID_RELEASE_MANIFEST');}
  const names=validateManifest(manifest),files=new Map(),records=[];
  for(const name of names) {
    // Never read, execute, hash or copy existing source/demo configuration.
    const generated=GENERATED.includes(name),bytes=generated?Buffer.from(wiring.files[name]):await readSource(resolve(target,name));
    if(!generated&&/\.(?:html|js)$/.test(name)) {
      const source=bytes.toString();
      if(/localDevelopment\s*:\s*true|sb_secret_[a-z0-9_-]+|@office-rehearsal\.invalid/i.test(source)||(/\.html$/.test(name)&&/CREEK_(?:OFFICE|CONNECTION)_CONFIG\s*=|getElementById\s*\(\s*['"](?:email|password)['"]\s*\)\s*\.value\s*=(?!=)/.test(source)))fail('DEMO_OR_SECRET_IN_STATIC_SOURCE');
    }
    files.set(name,bytes);records.push({path:name,bytes:bytes.length,sha256:sha(bytes),source:generated?'generated_hosted_configuration':'byte_identical_source_copy'});
  }
  const closure=checkClosure(files,wiring.report.target.app_origin);
  return {files,checklist:wiring.files['SETUP-CHECKLIST.md'],report:{
    format_version:1,status:'static_package_prepared_offline',site_directory:'site',file_count:records.length,allowlist_sha256:sha(manifestBytes),files:records,
    wiring:wiring.report,closure,source_configuration_read:false,source_configuration_changed:false,
    source_files_transformed:false,service_worker_changed:false,network_used:false,deployed:false,
    local_office_preflight:{status:'separate_required_check',command:'node tools/office-preflight/cli.mjs',hosted_services:'not_assessed'},
    excluded:['.git','docs','tests','tools','supabase','brand','private files','CNAME and hosting configuration'],
    limitations:['Only explicitly allowlisted static files are included.','External resources, dynamic links, hosted access and real phones are not verified.','Static file availability does not establish backend activation or release authorization.']
  }};
}

async function writeExclusive(path,bytes) {
  if(await inspect(path,true))fail('OUTPUT_ALREADY_EXISTS');
  const handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(bytes);}finally{await handle.close();}
}
export async function stageRelease({root=DEFAULT_ROOT,input,output}) {
  const target=safePath(output),source=safePath(root),within=relative(source,target);
  if(!within||(!isAbsolute(within)&&within!=='..'&&!within.startsWith('..'+sep)))fail('OUTPUT_INSIDE_SOURCE');
  if(await inspect(target,true))fail('OUTPUT_ALREADY_EXISTS');
  if(await realpath(dirname(target))!==dirname(target))fail('UNSAFE_LOCAL_PATH');
  const packet=await prepareRelease({root:source,input});
  try {
    await mkdir(target,{mode:0o700});await mkdir(resolve(target,'site'),{mode:0o700});
    const made=new Set(['']);
    for(const [name,bytes] of packet.files) {
      const parts=name.split('/');parts.pop();let parent='';
      for(const part of parts){parent=parent?parent+'/'+part:part;if(!made.has(parent)){await mkdir(resolve(target,'site',parent),{mode:0o700});made.add(parent);}}
      await writeExclusive(resolve(target,'site',name),bytes);
    }
    await writeExclusive(resolve(target,'review-manifest.json'),JSON.stringify(packet.report,null,2)+'\n');
    await writeExclusive(resolve(target,'SETUP-CHECKLIST.md'),packet.checklist);
    await writeExclusive(resolve(target,'RELEASE-REVIEW.md'),'# Static release packet — review only\n\nThe complete uploadable content is in `site/`. Keep this review file, the setup checklist and the hash manifest outside the public upload root.\n\nNo hosting settings, CNAME/DNS records, accounts, SQL, invitations or deployment were changed. Source configuration was never read or copied; the two hosted configuration files were generated from the reviewed input. All other files match source bytes.\n\nReview `review-manifest.json` for exact file hashes and target/callback information. This packet still requires explicit hosted setup and release approval, configured HTTPS hosting at the reviewed origin, server role/storage checks, email and physical-phone rehearsal. External resources need a connection. Do not upload the repository or this enclosing packet directory.\n');
  }catch(_){fail('RELEASE_STAGING_FAILED');}
  return packet.report;
}
