#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const CLIENT_ROOT = path.resolve(__dirname, '..', '..');
const TS_ENTRYPOINT = path.join(CLIENT_ROOT, 'lib', 'ts_entrypoint.js');
const TS_FILE = path.join(__dirname, 'shadow_dispatch_reliability.ts');

const out = spawnSync(process.execPath, [TS_ENTRYPOINT, TS_FILE, ...process.argv.slice(2)], {
  cwd: path.resolve(CLIENT_ROOT, '..'),
  stdio: 'inherit',
  env: process.env
});
process.exit(Number.isFinite(out.status) ? out.status : 1);
