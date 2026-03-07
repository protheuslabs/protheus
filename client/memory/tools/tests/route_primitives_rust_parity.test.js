#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function fail(msg) {
  console.error(`❌ route_primitives_rust_parity.test.js: ${msg}`);
  process.exit(1);
}

function parsePayload(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function ensureReleaseBinary() {
  const out = spawnSync('cargo', ['build', '-p', 'execution_core', '--release'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (Number(out.status) !== 0) {
    fail(`cargo build failed: ${(out.stderr || out.stdout || '').slice(0, 260)}`);
  }
}

function runRust(payload) {
  const bin = path.join(ROOT, 'target', 'release', 'execution_core');
  const encoded = Buffer.from(JSON.stringify(payload || {}), 'utf8').toString('base64');
  const out = spawnSync(bin, ['route-primitives', `--payload-base64=${encoded}`], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const parsed = parsePayload(out.stdout);
  if (Number(out.status) !== 0 || !parsed || typeof parsed !== 'object') {
    fail(`route-primitives failed: ${(out.stderr || out.stdout || '').slice(0, 260)}`);
  }
  return parsed;
}

function main() {
  ensureReleaseBinary();

  const high = runRust({
    task_text: 'Spawn a child process to run shell commands',
    tokens_est: 2200,
    repeats_14d: 3,
    errors_30d: 0
  });
  assert.strictEqual(high.intent_key, 'spawn_a_child_process_to_run_shell_commands');
  assert.strictEqual(high.predicted_habit_id, 'spawn_a_child_process_to_run_shell_commands');
  assert.strictEqual(high.trigger_a, true);
  assert.strictEqual(high.trigger_b, true);
  assert.strictEqual(high.trigger_c, false);
  assert.deepStrictEqual(high.which_met, ['A', 'B']);
  assert.ok(high.thresholds && high.thresholds.A && high.thresholds.B && high.thresholds.C);
  assert.strictEqual(high.thresholds.A.met, true);
  assert.strictEqual(high.thresholds.B.met, true);
  assert.strictEqual(high.thresholds.C.met, false);

  const normalized = runRust({
    task_text: 'Deploy 2026-03-03 run 123e4567-e89b-12d3-a456-426614174000 "quoted context"',
    tokens_est: 100,
    repeats_14d: 0,
    errors_30d: 0
  });
  assert.strictEqual(normalized.intent_key, 'deploy_run');
  assert.strictEqual(normalized.predicted_habit_id, 'deploy_run');
  assert.strictEqual(normalized.any_trigger, false);

  const empty = runRust({
    task_text: '   ',
    tokens_est: 0,
    repeats_14d: 0,
    errors_30d: 2
  });
  assert.strictEqual(empty.intent_key, '');
  assert.strictEqual(empty.intent, 'task');
  assert.strictEqual(empty.predicted_habit_id, 'habit');
  assert.strictEqual(empty.trigger_c, true);
  assert.deepStrictEqual(empty.which_met, ['C']);

  console.log('route_primitives_rust_parity.test.js: OK');
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
