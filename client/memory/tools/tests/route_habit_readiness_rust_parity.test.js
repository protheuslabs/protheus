#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function fail(msg) {
  console.error(`❌ route_habit_readiness_rust_parity.test.js: ${msg}`);
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
  const out = spawnSync(bin, ['route-habit-readiness', `--payload-base64=${encoded}`], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const parsed = parsePayload(out.stdout);
  if (Number(out.status) !== 0 || !parsed || typeof parsed !== 'object') {
    fail(`route-habit-readiness failed: ${(out.stderr || out.stdout || '').slice(0, 260)}`);
  }
  return parsed;
}

function main() {
  ensureReleaseBinary();

  const required = runRust({
    habit_state: 'active',
    entrypoint_resolved: '/repo/client/habits/scripts/run_habit.js',
    trusted_entrypoints: ['/repo/client/habits/scripts/run_habit.js'],
    required_inputs: ['user_id']
  });
  assert.strictEqual(required.state, 'active');
  assert.strictEqual(required.runnable, false);
  assert.strictEqual(required.reason_code, 'required_inputs');
  assert.deepStrictEqual(required.required_inputs, ['user_id']);

  const untrusted = runRust({
    habit_state: 'candidate',
    entrypoint_resolved: '/repo/client/habits/scripts/untrusted.js',
    trusted_entrypoints: ['/repo/client/habits/scripts/run_habit.js'],
    required_inputs: []
  });
  assert.strictEqual(untrusted.state, 'candidate');
  assert.strictEqual(untrusted.trusted_entrypoint, false);
  assert.strictEqual(untrusted.runnable, false);
  assert.strictEqual(untrusted.reason_code, 'untrusted_entrypoint');

  const runnable = runRust({
    habit_state: 'active',
    entrypoint_resolved: '/repo/client/habits/scripts/run_habit.js',
    trusted_entrypoints: ['/repo/client/habits/scripts/run_habit.js'],
    required_inputs: []
  });
  assert.strictEqual(runnable.state, 'active');
  assert.strictEqual(runnable.trusted_entrypoint, true);
  assert.strictEqual(runnable.runnable, true);
  assert.strictEqual(runnable.reason_code, 'runnable_active');

  console.log('route_habit_readiness_rust_parity.test.js: OK');
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
