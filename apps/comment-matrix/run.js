#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const tsEntrypoint = path.join(ROOT, 'client', 'lib', 'ts_entrypoint.js');
const toolkitTs = path.join(ROOT, 'client', 'systems', 'ops', 'cognitive_toolkit_cli.ts');
const ctlCandidates = [
  path.join(ROOT, 'client', 'systems', 'ops', 'protheusctl.js'),
  path.join(ROOT, 'systems', 'ops', 'protheusctl.js')
];
const ctl = ctlCandidates.find((candidate) => fs.existsSync(candidate));

let commandArgs;
if (fs.existsSync(tsEntrypoint) && fs.existsSync(toolkitTs)) {
  commandArgs = [
    tsEntrypoint,
    toolkitTs,
    'comment-mapper',
    '--persona=vikram_menon',
    '--query=Should we prioritize memory or security first?',
    '--gap=1',
    '--active=1'
  ];
} else if (ctl) {
  commandArgs = [
    ctl,
    'toolkit',
    'comment-mapper',
    '--persona=vikram_menon',
    '--query=Should we prioritize memory or security first?',
    '--gap=1',
    '--active=1'
  ];
} else {
  console.error('comment-matrix: no runnable toolkit entrypoint found');
  process.exit(1);
}

const proc = spawnSync(process.execPath, commandArgs, {
  cwd: ROOT,
  encoding: 'utf8',
  input: 'a\n'
});
if (proc.stdout) process.stdout.write(proc.stdout);
if (proc.stderr) process.stderr.write(proc.stderr);
process.exit(Number.isFinite(proc.status) ? proc.status : 1);
/* Legacy payload for reference:
[
  'comment-mapper',
  '--persona=vikram_menon',
  '--query=Should we prioritize memory or security first?',
  '--gap=1',
  '--active=1'
]
*/
