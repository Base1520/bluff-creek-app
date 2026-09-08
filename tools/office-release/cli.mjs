#!/usr/bin/env node
import { readInput } from '../office-wiring/index.mjs';
import { prepareRelease, stageRelease, DEFAULT_ROOT } from './index.mjs';
const args=process.argv.slice(2);
if(args.length===1&&args[0]==='--help')process.stdout.write('Usage: node tools/office-release/cli.mjs --input PRIVATE_JSON [--root LOCAL_SOURCE] [--output NEW_PACKET_DIR]\nWithout --output, validates the complete static package only. Explicit output creates site/ and separate private review files. No network, source edits, hosted setup or deployment.\n');
else {
  const values={};let invalid=false;
  for(let i=0;i<args.length;i+=2){if(!['--input','--root','--output'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--')||Object.hasOwn(values,args[i])){invalid=true;break;}values[args[i]]=args[i+1];}
  if(invalid||!values['--input']){process.stderr.write('Invalid options. Use --help. Keep configuration values in a private input file.\n');process.exitCode=2;}
  else try {
    const input=await readInput(values['--input']),root=values['--root']||DEFAULT_ROOT;
    if(values['--output']){await stageRelease({root,input,output:values['--output']});process.stdout.write('Complete static review packet staged. Only site/ is uploadable; hosted setup and release approval remain pending.\n');}
    else {await prepareRelease({root,input});process.stdout.write('Complete static package validated locally. No files written and no services contacted.\n');}
  }catch(_){process.stderr.write('Release preparation failed. Check the input, explicit file manifest, static links and safe local paths. No input values are printed.\n');process.exitCode=1;}
}
