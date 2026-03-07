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

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return String(fs.readFileSync(filePath, 'utf8') || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'assimilation', 'environment_evolution_layer.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'env-evo-'));

  const policyPath = path.join(tmpRoot, 'config', 'environment_evolution_layer_policy.json');
  const statePath = path.join(tmpRoot, 'state', 'assimilation', 'environment_evolution', 'state.json');
  const latestPath = path.join(tmpRoot, 'state', 'assimilation', 'environment_evolution', 'latest.json');
  const receiptsPath = path.join(tmpRoot, 'state', 'assimilation', 'environment_evolution', 'receipts.jsonl');
  const doctorQueuePath = path.join(tmpRoot, 'state', 'ops', 'autotest_doctor', 'environment_feedback_queue.jsonl');

  writeJson(policyPath, {
    schema_id: 'environment_evolution_layer_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: true,
    ema_alpha: 0.5,
    robustness_thresholds: {
      strong: 0.7,
      weak: 0.35
    },
    feedback: {
      confidence_shaping_gain: 0.3,
      doctor_on_fail: true,
      min_samples_for_stability: 2
    },
    state: {
      state_path: statePath,
      latest_path: latestPath,
      receipts_path: receiptsPath,
      doctor_queue_path: doctorQueuePath
    }
  });

  const env = {
    ...process.env,
    ENV_EVOLUTION_POLICY_PATH: policyPath
  };

  const successProc = runNode(scriptPath, [
    'run',
    '--input-json={"capability_id":"cap.alpha","source_type":"external_tool","outcome":"success"}'
  ], env, repoRoot);
  assert.strictEqual(successProc.status, 0, successProc.stderr || successProc.stdout);
  const successOut = parseJson(successProc);
  assert.strictEqual(successOut.ok, true);
  assert.ok(successOut.robustness_score > 0.5, 'success should increase robustness');

  const failProc = runNode(scriptPath, [
    'run',
    '--input-json={"capability_id":"cap.alpha","source_type":"external_tool","outcome":"fail"}'
  ], env, repoRoot);
  assert.strictEqual(failProc.status, 0, failProc.stderr || failProc.stdout);
  const failOut = parseJson(failProc);
  assert.strictEqual(failOut.ok, true);
  assert.strictEqual(failOut.doctor_feedback_queued, true, 'fail outcome should queue doctor feedback');

  const doctorRows = readJsonl(doctorQueuePath);
  assert.ok(doctorRows.length >= 1, 'doctor queue should contain environment feedback rows');

  const statusProc = runNode(scriptPath, ['status', '--capability-id=cap.alpha'], env, repoRoot);
  assert.strictEqual(statusProc.status, 0, statusProc.stderr || statusProc.stdout);
  const status = parseJson(statusProc);
  assert.strictEqual(status.ok, true);
  assert.ok(status.snapshot && Number(status.snapshot.samples || 0) >= 2);

  console.log('environment_evolution_layer.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`environment_evolution_layer.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
