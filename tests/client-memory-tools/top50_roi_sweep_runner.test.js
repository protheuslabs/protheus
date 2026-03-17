#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'client', 'runtime', 'systems', 'ops', 'top50_roi_sweep.ts');
const QUEUE_JSON = path.join(ROOT, 'docs', 'client', 'generated', 'RUST60_EXECUTION_QUEUE_261.json');

function parseLastJson(stdout) {
  const lines = String(stdout || '').trim().split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

const proc = spawnSync('node', [SCRIPT, '--max=20'], {
  cwd: ROOT,
  encoding: 'utf8',
});

assert.strictEqual(proc.status, 0, proc.stderr || proc.stdout);
const payload = parseLastJson(proc.stdout);
assert(payload, 'expected JSON payload');
assert.strictEqual(payload.ok, true);
assert.strictEqual(payload.type, 'top50_roi_sweep');
assert(fs.existsSync(QUEUE_JSON), 'expected refreshed queue json');
const queue = JSON.parse(fs.readFileSync(QUEUE_JSON, 'utf8'));
assert(queue.current_rust_percent >= 60, 'expected current rust percent to reflect live repo state');
assert(queue.bridge_wrappers_excluded > 0, 'expected bridge wrappers to be excluded');
assert(queue.top.every((lane) => fs.existsSync(path.join(ROOT, lane.path))), 'expected queue paths to exist');
assert(queue.top.every((lane) => !lane.path.endsWith('gated_self_improvement_loop.ts')), 'expected thin bridge wrappers excluded');
assert(
  queue.top.every((lane) => lane.path !== 'client/runtime/systems/autonomy/swarm_orchestration_runtime.ts'),
  'expected thin swarm bridge wrapper to be excluded from live queue'
);
console.log('top50_roi_sweep_runner.test.js: OK');
