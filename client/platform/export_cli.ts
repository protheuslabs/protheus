#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'systems', 'ops', 'open_platform_release_pack.js');

const proc = spawnSync('node', [TARGET].concat(process.argv.slice(2)), {
  cwd: ROOT,
  env: process.env,
  stdio: 'inherit'
});

const code = Number.isFinite(Number(proc.status)) ? Number(proc.status) : 1;
process.exit(code);
