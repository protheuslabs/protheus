#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MEMORY_MANIFEST = path.join(ROOT, 'crates', 'memory', 'Cargo.toml');
const memory = require(path.join(ROOT, 'systems', 'memory', 'index.js'));

let failed = false;

function runTest(name, fn) {
  try {
    fn();
    console.log(`   ✅ ${name}`);
  } catch (err) {
    failed = true;
    console.error(`   ❌ ${name}: ${err && err.message ? err.message : err}`);
  }
}

function ensureMemoryReleaseBinary() {
  const out = spawnSync('cargo', ['build', '--manifest-path', MEMORY_MANIFEST, '--release'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (Number(out.status) !== 0) {
    throw new Error(`memory release build failed: ${(out.stderr || out.stdout || '').slice(0, 260)}`);
  }
}

console.log('═══════════════════════════════════════════════════════════');
console.log('   MEMORY SECURITY GATE INTEGRATION TESTS');
console.log('═══════════════════════════════════════════════════════════');

runTest('allow-path executes memory operation with security gate attached', () => {
  ensureMemoryReleaseBinary();
  const out = memory.runMemoryCli('ebbinghaus-score', [
    '--age-days=2',
    '--repetitions=3',
    '--lambda=0.02'
  ]);
  assert.ok(out && out.ok === true, 'memory op should succeed');
  assert.ok(out.payload && out.payload.ok === true, 'memory payload should be ok');
  assert.ok(out.security_gate && out.security_gate.payload && out.security_gate.payload.decision, 'security decision should be attached');
  assert.strictEqual(out.security_gate.payload.decision.fail_closed, false, 'allow-path should not fail-close');
});

runTest('fail-closed blocks memory operation and emits shutdown+alert', () => {
  ensureMemoryReleaseBinary();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-security-fail-closed-'));
  const stateRoot = path.join(tmp, 'state');
  const out = memory.runMemoryCli(
    'compress',
    ['--aggressive=1'],
    120000,
    {
      state_root: stateRoot,
      covenant_violation: true,
      tamper_signal: true,
      risk_class: 'critical',
      operator_quorum: 1,
      key_age_hours: 96
    }
  );
  assert.ok(out && out.ok === false, 'memory op should be blocked');
  assert.strictEqual(out.engine, 'security_gate_fail_closed');
  assert.ok(String(out.error || '').includes('security_gate_blocked'), 'error should include security gate block');

  const shutdownPath = path.join(stateRoot, 'security', 'hard_shutdown.json');
  const alertsPath = path.join(stateRoot, 'security', 'human_alerts.jsonl');
  assert.ok(fs.existsSync(shutdownPath), 'hard shutdown file must exist');
  assert.ok(fs.existsSync(alertsPath), 'human alerts ledger must exist');
});

if (failed) {
  process.exit(1);
}

console.log('memory_security_gate_integration.test.js: OK');
