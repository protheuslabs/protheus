#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const ctl = path.join(ROOT, 'systems', 'ops', 'protheusctl.js');
const proc = spawnSync(process.execPath, [ctl, 'toolkit', 'blob-morphing', 'status'], {
  cwd: ROOT,
  encoding: 'utf8'
});
if (proc.stdout) process.stdout.write(proc.stdout);
if (proc.stderr) process.stderr.write(proc.stderr);
process.exit(Number.isFinite(proc.status) ? proc.status : 1);
