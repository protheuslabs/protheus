#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HARNESS = path.join(ROOT, 'systems', 'memory', 'abstraction', 'test_harness.js');
const ANALYTICS = path.join(ROOT, 'systems', 'memory', 'abstraction', 'analytics_engine.js');
const VIEW = path.join(ROOT, 'systems', 'memory', 'abstraction', 'memory_view.js');
const SECURITY_MANIFEST = path.join(ROOT, 'crates', 'security', 'Cargo.toml');

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

function parseJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runNode(scriptPath, args, env = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    }
  });
}

function runSecurityCore(args, env = {}) {
  return spawnSync('cargo', ['run', '--quiet', '--manifest-path', SECURITY_MANIFEST, '--bin', 'security_core', '--', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    }
  });
}

console.log('═══════════════════════════════════════════════════════════');
console.log('   FOUNDATION LOCK ABSTRACTION + SECURITY TESTS');
console.log('═══════════════════════════════════════════════════════════');

runTest('memory abstraction harness enforces <=2% drift gate', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foundation-abstraction-'));
  const dbPath = path.join(tmp, 'memory.sqlite');
  const stateRoot = path.join(tmp, 'state');

  let out = runNode(HARNESS, ['run'], {
    PROTHEUS_MEMORY_DB_PATH: dbPath,
    PROTHEUS_SECURITY_GATE_BYPASS: '0'
  });
  assert.strictEqual(out.status, 0, `harness run failed: ${out.stderr}`);
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'harness should pass on first baseline run');
  assert.ok(Number(payload.max_drift_pct || 0) <= 2, 'max drift should be <=2');

  out = runNode(HARNESS, ['baseline-capture'], {
    PROTHEUS_MEMORY_DB_PATH: dbPath,
    PROTHEUS_SECURITY_GATE_BYPASS: '0'
  });
  assert.strictEqual(out.status, 0, `baseline capture failed: ${out.stderr}`);

  out = runNode(VIEW, ['snapshot', '--q=foundation', '--top=5'], {
    PROTHEUS_MEMORY_DB_PATH: dbPath,
    PROTHEUS_SECURITY_GATE_BYPASS: '0'
  });
  assert.strictEqual(out.status, 0, `memory view snapshot failed: ${out.stderr}`);
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.type === 'memory_view_snapshot', 'snapshot type should match');

  out = runNode(ANALYTICS, ['run'], {
    PROTHEUS_MEMORY_DB_PATH: dbPath,
    PROTHEUS_SECURITY_GATE_BYPASS: '0'
  });
  assert.strictEqual(out.status, 0, `analytics run failed: ${out.stderr}`);
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'analytics should pass drift gate');
  assert.ok(payload.metrics && Number.isFinite(Number(payload.metrics.sovereignty_index)), 'sovereignty index should exist');

  fs.mkdirSync(path.join(stateRoot, 'security'), { recursive: true });
});

runTest('security core fail-closed emits shutdown + human alert', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foundation-security-'));
  const stateRoot = path.join(tmp, 'state');
  const request = {
    operation_id: 'security_fail_closed_test',
    subsystem: 'memory',
    action: 'compress',
    actor: 'test',
    risk_class: 'critical',
    tags: ['drift', 'tamper'],
    covenant_violation: true,
    tamper_signal: true,
    key_age_hours: 100,
    operator_quorum: 1,
    audit_receipt_nonce: null,
    zk_proof: null,
    ciphertext_digest: null
  };

  const out = runSecurityCore([
    'enforce',
    `--request-json=${JSON.stringify(request)}`,
    `--state-root=${stateRoot}`
  ]);
  assert.strictEqual(out.status, 0, `security enforce failed: ${out.stderr}`);
  const payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'security enforce payload should be ok');
  assert.ok(payload.decision && payload.decision.fail_closed === true, 'decision should fail-close');

  const shutdownPath = path.join(stateRoot, 'security', 'hard_shutdown.json');
  const alertsPath = path.join(stateRoot, 'security', 'human_alerts.jsonl');
  assert.ok(fs.existsSync(shutdownPath), 'hard_shutdown.json should exist');
  assert.ok(fs.existsSync(alertsPath), 'human_alerts.jsonl should exist');
});

if (failed) {
  process.exit(1);
}

console.log('foundation_lock_abstraction_and_security.test.js: OK');
