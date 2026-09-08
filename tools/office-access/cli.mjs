#!/usr/bin/env node
import { readInput, stageAccess } from './index.mjs';
const usage = 'Usage: node tools/office-access/cli.mjs --input PRIVATE_JSON [--output NEW_DIRECTORY]\nDefault validates only. Explicit --output stages a private review packet. Never pass identities or credentials as arguments. No network or hosted changes run.\n';
const args = process.argv.slice(2);
let input, output, invalid = false;
if (args.length === 1 && args[0] === '--help') process.stdout.write(usage);
else {
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!['--input', '--output'].includes(flag) || !value || value.startsWith('--') || (flag === '--input' ? input !== undefined : output !== undefined)) { invalid = true; break; }
    if (flag === '--input') input = value; else output = value;
  }
  if (invalid || !input) { process.stderr.write('Invalid options. Use --help; identities belong only in the private input.\n'); process.exitCode = 2; }
  else try {
    const value = await readInput(input);
    if (output !== undefined) { await stageAccess(value, output); process.stdout.write('Private staff-access packet prepared for two admin bindings. No hosted changes or messages. Target and identity checks still require review.\n'); }
    else process.stdout.write('Two admin binding formats validated. No files written, identities verified, or services contacted.\n');
  } catch (_) {
    process.stderr.write('Staff-access preparation failed. Check the private input and local paths. Output must be new, outside source, and contain no symlink components. No identity values are printed.\n'); process.exitCode = 1;
  }
}
