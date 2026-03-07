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
  const scriptPath = path.join(repoRoot, 'systems', 'assimilation', 'adaptive_ensemble_routing_primitive.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-routing-'));

  const policyPath = path.join(tmpRoot, 'config', 'adaptive_ensemble_routing_primitive_policy.json');
  const stateDir = path.join(tmpRoot, 'state', 'assimilation', 'adaptive_ensemble_routing');
  const weaverProfilesPath = path.join(tmpRoot, 'state', 'autonomy', 'weaver', 'adaptive_ensemble_profiles.jsonl');

  writeJson(policyPath, {
    schema_id: 'adaptive_ensemble_routing_primitive_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: true,
    routing: {
      min_specialists: 2,
      aligned_weight: 0.6,
      complementary_weight: 0.4,
      uncertainty_bias: 0.7,
      max_selected_specialists: 3
    },
    outputs: {
      emit_weaver_profile: true
    },
    state: {
      latest_path: path.join(stateDir, 'latest.json'),
      history_path: path.join(stateDir, 'history.jsonl'),
      receipts_path: path.join(stateDir, 'receipts.jsonl'),
      weaver_profiles_path: weaverProfilesPath
    }
  });

  const env = {
    ...process.env,
    ADAPTIVE_ENSEMBLE_ROUTING_POLICY_PATH: policyPath
  };

  const run1 = runNode(scriptPath, [
    'run',
    '--input-json={"capability_id":"cap.alpha","objective_id":"obj.alpha","uncertainty_score":0.8,"specialists":[{"specialist_id":"aligned_guard","mode":"aligned","confidence":0.8,"trust_score":0.9},{"specialist_id":"complementary_probe","mode":"complementary","confidence":0.9,"error_correction":0.9,"trust_score":0.7}]}'
  ], env, repoRoot);
  assert.strictEqual(run1.status, 0, run1.stderr || run1.stdout);
  const out1 = parseJson(run1);
  assert.strictEqual(out1.ok, true);
  assert.strictEqual(out1.capability_id, 'cap.alpha');
  assert.ok(out1.route_plan && out1.route_plan.selected_mode, 'route plan should be emitted');
  assert.ok(Array.isArray(out1.ranked_specialists), 'ranked specialists should be emitted');

  const profiles = readJsonl(weaverProfilesPath);
  assert.ok(profiles.length >= 1, 'weaver profile stream should receive ensemble rows');

  const status = runNode(scriptPath, ['status'], env, repoRoot);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusOut = parseJson(status);
  assert.strictEqual(statusOut.ok, true);

  console.log('adaptive_ensemble_routing_primitive.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`adaptive_ensemble_routing_primitive.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
