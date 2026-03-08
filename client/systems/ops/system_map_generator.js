#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TS_ENTRYPOINT = path.join(ROOT, 'lib', 'ts_entrypoint.js');
const TS_FILE = path.join(__dirname, 'system_map_generator.ts');

const out = spawnSync(process.execPath, [TS_ENTRYPOINT, TS_FILE, ...process.argv.slice(2)], {
  cwd: path.resolve(ROOT, '..'),
  stdio: 'inherit',
  env: process.env
});
process.exit(Number.isFinite(out.status) ? out.status : 1);
