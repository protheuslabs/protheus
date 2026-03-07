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

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
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
  const scriptPath = path.join(repoRoot, 'systems', 'assimilation', 'test_time_memory_evolution_primitive.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-mem-evo-'));

  const policyPath = path.join(tmpRoot, 'config', 'test_time_memory_evolution_primitive_policy.json');
  const stateDir = path.join(tmpRoot, 'state', 'assimilation', 'test_time_memory_evolution');
  const memoryGraphPath = path.join(tmpRoot, 'state', 'assimilation', 'memory_evolution', 'episodes.jsonl');

  writeJson(policyPath, {
    schema_id: 'test_time_memory_evolution_primitive_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: true,
    search: {
      max_episode_candidates: 40,
      max_synthesized_insights: 4,
      novelty_bias: 0.3
    },
    evolution: {
      reward_gain: 0.2,
      penalty_gain: 0.2,
      decay: 0.9,
      target_step_reduction: 0.5,
      max_step_reduction: 0.85
    },
    state: {
      memory_graph_path: memoryGraphPath,
      state_path: path.join(stateDir, 'state.json'),
      latest_path: path.join(stateDir, 'latest.json'),
      receipts_path: path.join(stateDir, 'receipts.jsonl')
    }
  });

  writeJsonl(memoryGraphPath, [
    { capability_id: 'cap.alpha', outcome: 'success' },
    { capability_id: 'cap.alpha', outcome: 'success' },
    { capability_id: 'cap.alpha', outcome: 'fail' },
    { capability_id: 'cap.other', outcome: 'success' }
  ]);

  const env = {
    ...process.env,
    TEST_TIME_MEMORY_EVOLUTION_POLICY_PATH: policyPath
  };

  const run1 = runNode(scriptPath, [
    'run',
    '--input-json={"capability_id":"cap.alpha","outcome":"success","observed_steps":16}'
  ], env, repoRoot);
  assert.strictEqual(run1.status, 0, run1.stderr || run1.stdout);
  const out1 = parseJson(run1);
  assert.strictEqual(out1.ok, true);
  assert.strictEqual(out1.capability_id, 'cap.alpha');
  assert.ok(Number(out1.evolution.estimated_step_reduction || 0) > 0, 'expected positive step reduction');
  assert.ok(Number(out1.evolution.predicted_steps || 0) < 16, 'predicted steps should drop');

  const run2 = runNode(scriptPath, [
    'run',
    '--input-json={"capability_id":"cap.alpha","outcome":"fail","observed_steps":16}'
  ], env, repoRoot);
  assert.strictEqual(run2.status, 0, run2.stderr || run2.stdout);
  const out2 = parseJson(run2);
  assert.strictEqual(out2.ok, true);
  assert.ok(
    Number(out2.evolution.estimated_step_reduction || 0) <= Number(out1.evolution.estimated_step_reduction || 0),
    'fail should not increase estimated reduction over prior success state'
  );

  const status = runNode(scriptPath, ['status', '--capability-id=cap.alpha'], env, repoRoot);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusOut = parseJson(status);
  assert.strictEqual(statusOut.ok, true);
  assert.ok(statusOut.snapshot, 'status should include capability snapshot');

  console.log('test_time_memory_evolution_primitive.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`test_time_memory_evolution_primitive.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
