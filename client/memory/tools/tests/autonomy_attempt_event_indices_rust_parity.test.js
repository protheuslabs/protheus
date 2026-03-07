#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const target = path.join(__dirname, 'autonomy_attempt_events_rust_parity.test.js');
const out = spawnSync(process.execPath, [target], { encoding: 'utf8' });
if (out.stdout) process.stdout.write(out.stdout);
if (out.stderr) process.stderr.write(out.stderr);
if (out.status !== 0) {
  console.error('autonomy_attempt_event_indices_rust_parity.test.js: FAIL delegated to autonomy_attempt_events_rust_parity.test.js');
  process.exit(out.status || 1);
}
console.log('autonomy_attempt_event_indices_rust_parity.test.js: OK');
