#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'error_budget_release_gate.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'error-budget-gate-'));
  const policyPath = path.join(tmp, 'config', 'error_budget_release_gate_policy.json');
  const execPath = path.join(tmp, 'state', 'ops', 'execution_reliability_slo.json');
  const chaosPath = path.join(tmp, 'state', 'ops', 'continuous_chaos_resilience', 'latest.json');
  const doctorPath = path.join(tmp, 'state', 'ops', 'execution_doctor_ga', 'latest.json');
  const maturityPath = path.join(tmp, 'state', 'ops', 'operational_maturity_closure', 'latest.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'error_budget_release_gate', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'error_budget_release_gate', 'history.jsonl');
  const freezeStatePath = path.join(tmp, 'state', 'ops', 'error_budget_release_gate', 'freeze_state.json');

  writeJson(execPath, { payload: { pass: true } });
  writeJson(chaosPath, { ok: true, evaluation: { promotion_blocked: false } });
  writeJson(doctorPath, { ok: true });
  writeJson(maturityPath, { ok: true });

  writeJson(policyPath, {
    schema_id: 'error_budget_release_gate_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: false,
    strict_default: false,
    budget: {
      max_burn_ratio: 0.45,
      warn_burn_ratio: 0.25,
      missing_signal_penalty: true
    },
    sources: {
      execution_reliability_path: execPath,
      continuous_chaos_latest_path: chaosPath,
      execution_doctor_latest_path: doctorPath,
      operational_maturity_latest_path: maturityPath
    },
    weights: {
      execution_reliability: 0.4,
      chaos_resilience: 0.3,
      execution_doctor_ga: 0.15,
      operational_maturity: 0.15
    },
    outputs: {
      latest_path: latestPath,
      history_path: historyPath,
      freeze_state_path: freezeStatePath
    }
  });

  const env = { ERROR_BUDGET_RELEASE_POLICY_PATH: policyPath };

  let out = run(['gate', '--strict=1'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'gate should pass when all signals pass');
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'gate payload should be ok');
  assert.ok(payload.gate && payload.gate.promotion_blocked === false, 'release should remain open');
  assert.ok(fs.existsSync(latestPath), 'latest output should be written');
  assert.ok(fs.existsSync(historyPath), 'history output should be written');
  assert.ok(fs.existsSync(freezeStatePath), 'freeze state output should be written');

  writeJson(chaosPath, {
    ok: false,
    evaluation: { promotion_blocked: true }
  });

  out = run(['run', '--strict=0'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'non-strict run should complete');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === false, 'gate should fail after chaos hard block');
  assert.strictEqual(payload.gate.promotion_blocked, true, 'release should be frozen');
  assert.ok(
    Array.isArray(payload.gate.reasons) && payload.gate.reasons.some((r) => String(r).includes('hard_block:chaos_resilience')),
    'hard block reason should be recorded'
  );

  out = run(['status'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'status should execute');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'status payload should be ok');
  assert.ok(payload.payload && payload.payload.type === 'error_budget_release_gate', 'status should include latest payload');

  console.log('error_budget_release_gate.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`error_budget_release_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
