#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}'));
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(repoRoot, 'systems', 'routing', 'route_task.js');
  const env = {
    ...process.env,
    PROTHEUS_EXECUTION_RUST_BIN: path.join(repoRoot, 'tmp', 'missing_execution_core_binary'),
    PROTHEUS_EXECUTION_RUST_BIN_ONLY: '1',
    ROUTE_TASK_TS_FALLBACK: '0'
  };
  const r = spawnSync('node', [
    script,
    '--task', 'simple health check',
    '--tokens_est', '0',
    '--repeats_14d', '0',
    '--errors_30d', '0'
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(r.status, 0, `route_task should fail-closed to MANUAL: ${r.stderr}`);
  const out = parseJson(r.stdout);
  assert.strictEqual(out.decision, 'MANUAL');
  assert.strictEqual(out.route_error, 'route_evaluate_rust_unavailable');
  assert.ok(String(out.reason || '').includes('Rust route evaluate unavailable'));
  console.log('route_task_rust_failclosed.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`route_task_rust_failclosed.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
