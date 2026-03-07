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
  const scriptPath = path.join(repoRoot, 'systems', 'assimilation', 'generative_meta_model_primitive.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-model-'));

  const policyPath = path.join(tmpRoot, 'config', 'generative_meta_model_primitive_policy.json');
  const stateDir = path.join(tmpRoot, 'state', 'assimilation', 'generative_meta_model');

  writeJson(policyPath, {
    schema_id: 'generative_meta_model_primitive_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: true,
    manifold: {
      ema_alpha: 0.3,
      max_vector_dims: 16,
      max_steering_magnitude: 0.4,
      steering_gain: 0.5
    },
    safety: {
      fluency_floor: 0.3,
      stability_floor: 0.3,
      clamp_distance: 2
    },
    state: {
      manifold_state_path: path.join(stateDir, 'manifold_state.json'),
      latest_path: path.join(stateDir, 'latest.json'),
      receipts_path: path.join(stateDir, 'receipts.jsonl')
    }
  });

  const env = {
    ...process.env,
    GENERATIVE_META_MODEL_POLICY_PATH: policyPath
  };

  const run1 = runNode(scriptPath, [
    'run',
    '--input-json={"capability_id":"cap.alpha","activation_vector":[0.2,0.3,0.4]}'
  ], env, repoRoot);
  assert.strictEqual(run1.status, 0, run1.stderr || run1.stdout);
  const out1 = parseJson(run1);
  assert.strictEqual(out1.ok, true);
  assert.strictEqual(out1.capability_id, 'cap.alpha');
  assert.ok(Number(out1.activation_vector_dims || 0) >= 3, 'vector dims should be tracked');
  assert.ok(Array.isArray(out1.steering_vector), 'steering vector should be emitted');

  const run2 = runNode(scriptPath, [
    'run',
    '--input-json={"capability_id":"cap.alpha","activation_vector":[1.2,1.2,1.2]}'
  ], env, repoRoot);
  assert.strictEqual(run2.status, 0, run2.stderr || run2.stdout);
  const out2 = parseJson(run2);
  assert.strictEqual(out2.ok, true);
  assert.ok(Number(out2.manifold_distance || 0) >= 0, 'distance should be present');

  const status = runNode(scriptPath, ['status'], env, repoRoot);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusOut = parseJson(status);
  assert.strictEqual(statusOut.ok, true);
  assert.ok(Number(statusOut.manifold_count || 0) >= 2, 'status should reflect runs');

  console.log('generative_meta_model_primitive.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`generative_meta_model_primitive.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
