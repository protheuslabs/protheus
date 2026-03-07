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
  const scriptPath = path.join(repoRoot, 'systems', 'assimilation', 'self_teacher_distillation_primitive.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'self-teacher-'));

  const policyPath = path.join(tmpRoot, 'config', 'self_teacher_distillation_primitive_policy.json');
  const stateDir = path.join(tmpRoot, 'state', 'assimilation', 'self_teacher_distillation');

  writeJson(policyPath, {
    schema_id: 'self_teacher_distillation_primitive_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: true,
    trajectories: {
      min_quality: 0.6,
      max_samples: 20,
      success_bonus: 0.1
    },
    distillation: {
      learning_rate: 0.2,
      apply_gain_cap: 0.4,
      acceptance_threshold: 0.5
    },
    state: {
      ledger_path: path.join(stateDir, 'ledger.json'),
      latest_path: path.join(stateDir, 'latest.json'),
      receipts_path: path.join(stateDir, 'receipts.jsonl')
    }
  });

  const env = {
    ...process.env,
    SELF_TEACHER_DISTILLATION_POLICY_PATH: policyPath
  };

  const run1 = runNode(scriptPath, [
    'run',
    '--input-json={"capability_id":"cap.alpha","trajectories":[{"trajectory_id":"t1","quality":0.9,"outcome":"success"},{"trajectory_id":"t2","quality":0.85,"outcome":"shadow_only"}]}'
  ], env, repoRoot);
  assert.strictEqual(run1.status, 0, run1.stderr || run1.stdout);
  const out1 = parseJson(run1);
  assert.strictEqual(out1.ok, true);
  assert.ok(Number(out1.golden_count || 0) >= 2, 'expected golden trajectories');
  assert.ok(Number(out1.candidate_gain || 0) > 0, 'expected positive candidate gain');

  const run2 = runNode(scriptPath, [
    'run',
    '--input-json={"capability_id":"cap.alpha","trajectories":[{"trajectory_id":"t3","quality":0.1,"outcome":"fail"}]}'
  ], env, repoRoot);
  assert.strictEqual(run2.status, 0, run2.stderr || run2.stdout);
  const out2 = parseJson(run2);
  assert.strictEqual(out2.ok, true);
  assert.ok(Number(out2.golden_count || 0) === 0, 'low-quality trajectory should be filtered');

  const status = runNode(scriptPath, ['status', '--capability-id=cap.alpha'], env, repoRoot);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusOut = parseJson(status);
  assert.strictEqual(statusOut.ok, true);
  assert.ok(statusOut.snapshot, 'status should include snapshot');

  console.log('self_teacher_distillation_primitive.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`self_teacher_distillation_primitive.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
