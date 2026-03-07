#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function fail(msg) {
  console.error(`❌ route_evaluate_rust_parity.test.js: ${msg}`);
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
  const out = spawnSync(bin, ['route-evaluate', `--payload-base64=${encoded}`], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const parsed = parsePayload(out.stdout);
  if (Number(out.status) !== 0 || !parsed || typeof parsed !== 'object') {
    fail(`route-evaluate failed: ${(out.stderr || out.stdout || '').slice(0, 260)}`);
  }
  return parsed;
}

function main() {
  ensureReleaseBinary();

  const out = runRust({
    task_text: 'run nightly backup and drift remediation',
    tokens_est: 900,
    repeats_14d: 3,
    errors_30d: 0,
    skip_habit_id: '',
    habits: [{ id: 'nightly_backup' }, { id: 'daily_ops' }],
    reflex_routines: [{ id: 'drift_guard', status: 'enabled', tags: ['drift', 'remediation'] }]
  });
  assert.strictEqual(out.intent_key, 'run_nightly_backup_and_drift_remediation');
  assert.strictEqual(out.matched_habit_id, 'nightly_backup');
  assert.strictEqual(out.matched_reflex_id, 'drift_guard');
  assert.strictEqual(out.complexity, 'medium');
  assert.strictEqual(out.trigger_a, true);
  assert.strictEqual(out.trigger_c, false);
  console.log('route_evaluate_rust_parity.test.js: OK');
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
