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
  const scriptPath = path.join(repoRoot, 'systems', 'assimilation', 'memory_evolution_primitive.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-evo-'));

  const policyPath = path.join(tmpRoot, 'config', 'memory_evolution_primitive_policy.json');
  const stateRoot = path.join(tmpRoot, 'state', 'assimilation', 'memory_evolution');
  const doctorQueuePath = path.join(tmpRoot, 'state', 'ops', 'autotest_doctor', 'memory_evolution_feedback.jsonl');
  const causalGraphPath = path.join(tmpRoot, 'state', 'memory', 'causal_temporal_graph', 'state.json');

  writeJson(policyPath, {
    schema_id: 'memory_evolution_primitive_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: true,
    learning_rate: 0.4,
    discount_factor: 0.7,
    retrieval: {
      two_phase_enabled: true,
      max_recent_episodes: 32,
      max_graph_events: 10,
      require_capability_match: true
    },
    rewards: {
      success: 0.2,
      shadow_only: 0.03,
      reject: -0.1,
      fail: -0.3,
      environment_weight: 0.1,
      duality_weight: 0.1
    },
    doctor_feedback: {
      enabled: true,
      queue_path: doctorQueuePath,
      q_alert_threshold: -0.05
    },
    state: {
      root: stateRoot,
      q_values_path: path.join(stateRoot, 'q_values.json'),
      episodes_path: path.join(stateRoot, 'episodes.jsonl'),
      latest_path: path.join(stateRoot, 'latest.json'),
      receipts_path: path.join(stateRoot, 'receipts.jsonl'),
      causal_graph_state_path: causalGraphPath
    }
  });

  writeJson(causalGraphPath, {
    schema_id: 'causal_temporal_memory_graph',
    events: [
      { event_id: 'evt1', type: 'assimilation', capability_id: 'cap.alpha', ts: new Date().toISOString() },
      { event_id: 'evt2', type: 'other', note: 'not related' }
    ]
  });

  const env = {
    ...process.env,
    MEMORY_EVOLUTION_POLICY_PATH: policyPath
  };

  const run1 = runNode(scriptPath, [
    'run',
    '--input-json={"capability_id":"cap.alpha","source_type":"external_tool","outcome":"success","environment_score":0.8,"duality_score":1}'
  ], env, repoRoot);
  assert.strictEqual(run1.status, 0, run1.stderr || run1.stdout);
  const out1 = parseJson(run1);
  assert.strictEqual(out1.ok, true);
  assert.strictEqual(out1.capability_id, 'cap.alpha');
  assert.ok(out1.q_after > out1.q_before, 'success should increase Q');
  assert.ok(out1.retrieval.phase_two_matches >= 1, 'causal graph match should be detected');

  const run2 = runNode(scriptPath, [
    'run',
    '--input-json={"capability_id":"cap.alpha","source_type":"external_tool","outcome":"fail","environment_score":-1,"duality_score":-1}'
  ], env, repoRoot);
  assert.strictEqual(run2.status, 0, run2.stderr || run2.stdout);
  const out2 = parseJson(run2);
  assert.strictEqual(out2.ok, true);
  assert.ok(out2.q_after < out1.q_after, 'failure should reduce Q');

  const doctorRows = fs.existsSync(doctorQueuePath)
    ? String(fs.readFileSync(doctorQueuePath, 'utf8') || '').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  assert.ok(doctorRows.length >= 1, 'low-q path should enqueue doctor feedback');

  const status = runNode(scriptPath, ['status', '--capability-id=cap.alpha'], env, repoRoot);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusOut = parseJson(status);
  assert.strictEqual(statusOut.ok, true);
  assert.strictEqual(statusOut.capability_id, 'cap.alpha');

  console.log('memory_evolution_primitive.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`memory_evolution_primitive.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
