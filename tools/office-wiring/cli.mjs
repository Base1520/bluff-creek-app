#!/usr/bin/env node
import { readInput, stageWiring } from './index.mjs';

const usage = 'Usage: node tools/office-wiring/cli.mjs --input PRIVATE_JSON [--output NEW_DIRECTORY]\nDefault validates only. Explicit --output stages private review files; no source files are overwritten and no network or hosted changes occur. Use file paths only; never put keys in arguments.\n';
const args = process.argv.slice(2);
let input, output, invalid = false;
if (args.length === 1 && args[0] === '--help') process.stdout.write(usage);
else {
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[i + 1];
    if (!['--input', '--output'].includes(flag) || !value || value.startsWith('--') || (flag === '--input' ? input !== undefined : output !== undefined)) { invalid = true; break; }
    if (flag === '--input') input = value; else output = value;
    i++;
  }
  if (invalid || !input) { process.stderr.write('Invalid options. Use --help; configuration values must stay in a private input file.\n'); process.exitCode = 2; }
  else try {
    const config = await readInput(input);
    if (output !== undefined) {
      await stageWiring(config, output);
      process.stdout.write('Private review packet staged. No source or hosted configuration changed. Hosted setup, signup posture and key/project match remain unverified.\n');
    } else process.stdout.write('Input format validated. No files written or services contacted. Hosted setup, signup posture and key/project match remain unverified.\n');
  } catch (_) {
    process.stderr.write('Wiring preparation failed. Check input format and local paths; an output directory must be new and contain no symlink components. No configuration values are printed.\n');
    process.exitCode = 1;
  }
}
