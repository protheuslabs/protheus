#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'seed_boot_probe.js');

try {
  const run = spawnSync(process.execPath, [SCRIPT, 'run'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.strictEqual(run.status, 0, `seed boot probe failed: ${run.stderr || run.stdout}`);
  const payload = JSON.parse(String(run.stdout || '').trim());
  assert.strictEqual(payload.type, 'seed_boot_probe', 'unexpected payload type');
  assert.strictEqual(payload.modules_ok, true, 'module loading failed');
  assert.strictEqual(payload.files_ok, true, 'file loading failed');
  assert.ok(Number(payload.boot_ms) >= 0, 'boot_ms missing');
  assert.ok(Number(payload.rss_mb) > 0, 'rss_mb missing');
  console.log('seed_boot_probe.test.js: OK');
} catch (err) {
  console.error(`seed_boot_probe.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
