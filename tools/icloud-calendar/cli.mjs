#!/usr/bin/env node
import {readFile, writeFile, rename, unlink, realpath, stat} from 'node:fs/promises';
import {resolve, dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {convertCalendar, ImportError} from './convert.mjs';

function argumentsFor(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!['--input','--output','--now','--ics-output'].includes(name) || !args[i+1] || args[i+1].startsWith('--') || options[name]) throw new ImportError('INVALID_ARGUMENTS');
    options[name] = args[i+1];
  }
  if (!options['--input'] || !options['--output']) throw new ImportError('INVALID_ARGUMENTS');
  for (const name of ['--input','--output','--ics-output']) if (options[name] && /^[a-z][a-z0-9+.-]*:\/\//i.test(options[name])) throw new ImportError('LOCAL_FILES_ONLY');
  if (options['--now'] && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(options['--now'])) throw new ImportError('INVALID_NOW');
  return options;
}
async function existingPath(path) { try { return await realpath(path); } catch { return resolve(path); } }
export async function runCLI(args) {
  const options = argumentsFor(args), input = resolve(options['--input']);
  const outputs = [resolve(options['--output']), ...(options['--ics-output'] ? [resolve(options['--ics-output'])] : [])];
  const actual = await Promise.all([input,...outputs].map(existingPath));
  if (new Set(actual).size !== actual.length) throw new ImportError('OUTPUT_CONFLICT');
  if ((await stat(input)).size > 2 * 1024 * 1024) throw new ImportError('INPUT_LIMIT');
  const converted = convertCalendar(await readFile(input,'utf8'), options['--now'] ? {now:options['--now']} : {});
  const contents = [JSON.stringify(converted.feed,null,2)+'\n', ...(outputs.length === 2 ? [converted.ics] : [])];
  const staged = [];
  try {
    for (let i = 0; i < outputs.length; i++) {
      const temp = join(dirname(outputs[i]),`.calendar-${randomUUID()}.tmp`);
      await writeFile(temp,contents[i],{flag:'wx',mode:0o600}); staged.push({temp,path:outputs[i]});
    }
    for (const item of staged) await rename(item.temp,item.path);
  } finally { await Promise.all(staged.map(item => unlink(item.temp).catch(()=>{}))); }
  return converted.counts;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCLI(process.argv.slice(2)).then(counts => process.stdout.write(JSON.stringify(counts)+'\n')).catch(error => {
    const code = error instanceof ImportError ? error.code : 'LOCAL_IO_ERROR';
    process.stderr.write(`Calendar import failed (${code}). No source details were logged.\n`); process.exitCode = 1;
  });
}
