#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const ctl = path.join(ROOT, 'systems', 'ops', 'protheusctl.js');
const proc = spawnSync(process.execPath, [
  ctl,
  'toolkit',
  'comment-mapper',
  '--persona=vikram_menon',
  '--query=Should we prioritize memory or security first?',
  '--gap=1',
  '--active=1'
], {
  cwd: ROOT,
  encoding: 'utf8',
  input: 'a\n'
});
if (proc.stdout) process.stdout.write(proc.stdout);
if (proc.stderr) process.stderr.write(proc.stderr);
process.exit(Number.isFinite(proc.status) ? proc.status : 1);
