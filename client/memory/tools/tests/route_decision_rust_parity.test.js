#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function fail(msg) {
  console.error(`❌ route_decision_rust_parity.test.js: ${msg}`);
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
  const out = spawnSync(bin, ['route-decision', `--payload-base64=${encoded}`], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const parsed = parsePayload(out.stdout);
  if (Number(out.status) !== 0 || !parsed || typeof parsed !== 'object') {
    fail(`route-decision failed: ${(out.stderr || out.stdout || '').slice(0, 260)}`);
  }
  return parsed;
}

function main() {
  ensureReleaseBinary();

  const reflex = runRust({
    matched_reflex_id: 'drift_guard',
    reflex_eligible: true
  });
  assert.strictEqual(reflex.decision, 'RUN_REFLEX');
  assert.strictEqual(reflex.reason_code, 'reflex_match');

  const required = runRust({
    matched_habit_id: 'nightly_backup',
    matched_habit_state: 'active',
    has_required_inputs: true,
    required_input_count: 2,
    trusted_entrypoint: true
  });
  assert.strictEqual(required.decision, 'MANUAL');
  assert.strictEqual(required.reason_code, 'required_inputs');
  assert.strictEqual(required.suggested_habit_id, 'nightly_backup');

  const active = runRust({
    matched_habit_id: 'nightly_backup',
    matched_habit_state: 'active',
    trusted_entrypoint: true
  });
  assert.strictEqual(active.decision, 'RUN_HABIT');
  assert.strictEqual(active.reason_code, 'active_match');

  const candidate = runRust({
    matched_habit_id: 'nightly_candidate',
    matched_habit_state: 'candidate',
    trusted_entrypoint: true
  });
  assert.strictEqual(candidate.decision, 'RUN_CANDIDATE_FOR_VERIFICATION');
  assert.strictEqual(candidate.reason_code, 'candidate_match');

  const autocrystallize = runRust({
    any_trigger: true,
    predicted_habit_id: 'spawn_rust_hotspot'
  });
  assert.strictEqual(autocrystallize.decision, 'RUN_CANDIDATE_FOR_VERIFICATION');
  assert.strictEqual(autocrystallize.reason_code, 'trigger_autocrystallize');
  assert.strictEqual(autocrystallize.auto_habit_flow, true);
  assert.strictEqual(autocrystallize.suggested_habit_id, 'spawn_rust_hotspot');

  const manual = runRust({});
  assert.strictEqual(manual.decision, 'MANUAL');
  assert.strictEqual(manual.reason_code, 'no_match_no_trigger');

  console.log('route_decision_rust_parity.test.js: OK');
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
