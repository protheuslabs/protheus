#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'memory', 'idle_dream_cycle.js');

try {
  const run = spawnSync(process.execPath, [SCRIPT, 'status'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROTHEUS_IDLE_DREAM_LEGACY_FALLBACK: '0',
      PROTHEUS_IDLE_DREAM_TIMEOUT_MS: '1'
    }
  });

  assert.strictEqual(run.status, 0, run.stderr || run.stdout);
  const payload = JSON.parse(String(run.stdout || '').trim().split('\n').filter(Boolean).pop());
  assert.strictEqual(payload.ok, false);
  assert.strictEqual(payload.type, 'idle_dream_cycle_wrapper_error');
  assert.ok(String(payload.error || '').includes('core_idle_dream_cycle_failed_no_payload'));
  console.log('idle_dream_cycle_core_wrapper.test.js: OK');
} catch (err) {
  console.error(`idle_dream_cycle_core_wrapper.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
