#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function parseJson(proc) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, 'expected JSON stdout');
  return JSON.parse(raw);
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'assimilation', 'generative_simulation_mode.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-sim-'));

  const policyPath = path.join(tmpRoot, 'config', 'generative_simulation_mode_policy.json');
  const latestPath = path.join(tmpRoot, 'state', 'assimilation', 'generative_simulation', 'latest.json');
  const receiptsPath = path.join(tmpRoot, 'state', 'assimilation', 'generative_simulation', 'receipts.jsonl');

  writeJson(policyPath, {
    schema_id: 'generative_simulation_mode_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: true,
    beta_stage_lock: {
      enabled: true,
      max_allowed_stage: 'months',
      locked_stages: ['years', 'decades', 'centuries']
    },
    scenarios: {
      count: 5,
      fail_if_drift_over: 0.8,
      fail_if_safety_under: 0.2,
      fail_if_yield_under: 0.05
    },
    stage_windows: {
      days: 7,
      weeks: 30,
      months: 120,
      years: 365,
      decades: 3650,
      centuries: 36500
    },
    state: {
      latest_path: latestPath,
      receipts_path: receiptsPath
    }
  });

  const env = {
    ...process.env,
    GENERATIVE_SIM_POLICY_PATH: policyPath
  };

  const passProc = runNode(scriptPath, [
    'run',
    '--input-json={"capability_id":"cap.alpha","risk_class":"auth","impact_score":0.9,"base_drift":0.1,"base_safety":0.95,"base_yield":0.8}'
  ], env, repoRoot);
  assert.strictEqual(passProc.status, 0, passProc.stderr || passProc.stdout);
  const passOut = parseJson(passProc);
  assert.strictEqual(passOut.ok, true);
  assert.strictEqual(passOut.stage, 'months', 'high impact auth class should map to months stage');
  assert.ok(Array.isArray(passOut.scenarios));
  assert.ok(passOut.scenarios.length === 5);
  assert.ok(['pass', 'fail'].includes(passOut.verdict));

  const failProc = runNode(scriptPath, [
    'run',
    '--input-json={"capability_id":"cap.alpha","risk_class":"general","impact_score":0.2,"heroic_echo_blocked":true}'
  ], env, repoRoot);
  assert.strictEqual(failProc.status, 0, failProc.stderr || failProc.stdout);
  const failOut = parseJson(failProc);
  assert.strictEqual(failOut.ok, true);
  assert.strictEqual(failOut.verdict, 'fail');
  assert.ok((failOut.reason_codes || []).includes('heroic_echo_gate_blocked'));

  const statusProc = runNode(scriptPath, ['status'], env, repoRoot);
  assert.strictEqual(statusProc.status, 0, statusProc.stderr || statusProc.stdout);
  const status = parseJson(statusProc);
  assert.strictEqual(status.ok, true);
  assert.ok(status.latest && status.latest.capability_id);

  console.log('generative_simulation_mode.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`generative_simulation_mode.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
