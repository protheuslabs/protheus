#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const EXECUTION_MANIFEST = path.join(ROOT, 'crates', 'execution', 'Cargo.toml');
const { runWorkflow } = require(path.join(ROOT, 'systems', 'execution', 'index.js'));

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

function ensureExecutionReleaseBinary() {
  const out = spawnSync('cargo', ['build', '--manifest-path', EXECUTION_MANIFEST, '--release'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (Number(out.status) !== 0) {
    throw new Error(`execution release build failed: ${(out.stderr || out.stdout || '').slice(0, 260)}`);
  }
}

function baseSpec(workflowId) {
  return {
    workflow_id: workflowId,
    deterministic_seed: 'execution-security-gate-seed',
    steps: [
      { id: 'collect', kind: 'task', action: 'collect_data', command: 'collect --source=eyes' },
      { id: 'score', kind: 'task', action: 'score', command: 'score --strategy=deterministic' },
      { id: 'ship', kind: 'task', action: 'ship', command: 'ship --mode=canary' }
    ],
    metadata: {
      lane: 'execution_security_gate',
      owner: 'foundation_lock'
    }
  };
}

console.log('═══════════════════════════════════════════════════════════');
console.log('   EXECUTION SECURITY GATE INTEGRATION TESTS');
console.log('═══════════════════════════════════════════════════════════');

runTest('security gate allow-path permits deterministic execution', () => {
  ensureExecutionReleaseBinary();
  const out = runWorkflow(baseSpec('execution_gate_allow_path'), {
    prefer_wasm: true,
    allow_cli_fallback: true,
    security_enforce: true
  });
  assert.ok(out && out.ok === true, 'runWorkflow should return ok=true');
  assert.ok(out.payload && out.payload.status === 'completed', 'workflow should complete');
  assert.ok(out.security_gate && out.security_gate.payload && out.security_gate.payload.decision, 'security gate decision should be attached');
  assert.strictEqual(out.security_gate.payload.decision.fail_closed, false, 'allow-path should not fail-close');
});

runTest('security gate fail-closed blocks execution + writes shutdown alert', () => {
  ensureExecutionReleaseBinary();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-security-fail-closed-'));
  const stateRoot = path.join(tmp, 'state');
  const out = runWorkflow(baseSpec('execution_gate_fail_closed_path'), {
    prefer_wasm: true,
    allow_cli_fallback: true,
    security_enforce: true,
    state_root: stateRoot,
    covenant_violation: true,
    tamper_signal: true,
    risk_class: 'critical',
    operator_quorum: 1,
    key_age_hours: 96
  });
  assert.ok(out && out.ok === true, 'runWorkflow should still return a deterministic failed receipt');
  assert.strictEqual(out.engine, 'security_gate_fail_closed');
  assert.ok(out.payload && out.payload.status === 'failed', 'security gate should block execution');
  assert.ok(String(out.payload.pause_reason || '').includes('covenant_violation'), 'failure reason should include covenant violation');

  const shutdownPath = path.join(stateRoot, 'security', 'hard_shutdown.json');
  const alertsPath = path.join(stateRoot, 'security', 'human_alerts.jsonl');
  assert.ok(fs.existsSync(shutdownPath), 'hard shutdown file must exist after fail-closed');
  assert.ok(fs.existsSync(alertsPath), 'human alerts ledger must exist after fail-closed');
});

if (failed) {
  process.exit(1);
}

console.log('execution_security_gate_integration.test.js: OK');
