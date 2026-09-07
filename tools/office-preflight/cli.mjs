#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { runPreflight, textReport } from './index.mjs';

const args = process.argv.slice(2);
let root = fileURLToPath(new URL('../../', import.meta.url)), json = false, valid = true;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--json') json = true;
  else if (args[index] === '--root' && args[index + 1] && !args[index + 1].startsWith('--')) root = args[++index];
  else if (args[index] === '--help') {
    process.stdout.write('Usage: node tools/office-preflight/cli.mjs [--json] [--root LOCAL_CHECKOUT]\nReads local manifests/files only. Never applies SQL, contacts a service or prints configuration values.\n');
    process.exit(0);
  } else valid = false;
}
if (!valid) {
  process.stderr.write('Invalid options. Use --help; do not pass keys or service URLs.\n');
  process.exitCode = 2;
} else {
  try {
    const report = await runPreflight(root);
    process.stdout.write(json ? JSON.stringify(report, null, 2) + '\n' : textReport(report));
    process.exitCode = report.status === 'passed' ? 0 : 1;
  } catch (_) {
    process.stderr.write('Local preflight could not finish. Review local file access; no configuration values are included.\n');
    process.exitCode = 1;
  }
}
