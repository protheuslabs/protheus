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

function parseJson(proc, label) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, `${label}: expected stdout`);
  return JSON.parse(raw.split('\n').filter(Boolean).slice(-1)[0]);
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'fractal', 'resonance_field_gates.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resonance-gates-'));
  const policyPath = path.join(tmp, 'config', 'resonance_field_gates_policy.json');
  const latestPath = path.join(tmp, 'state', 'fractal', 'resonance_field_gates', 'latest.json');
  const receiptsPath = path.join(tmp, 'state', 'fractal', 'resonance_field_gates', 'receipts.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    max_influence: 0.3,
    min_confidence: 0.6,
    fallback_confidence_floor: 0.45,
    min_consensus_sources: 2,
    allowed_objective_prefixes: ['obj_'],
    auto_fallback_on_drop: true
  });

  const env = {
    ...process.env,
    RESONANCE_GATES_POLICY_PATH: policyPath,
    RESONANCE_GATES_LATEST_PATH: latestPath,
    RESONANCE_GATES_RECEIPTS_PATH: receiptsPath
  };

  const blocked = runNode(scriptPath, [
    'evaluate',
    '--objective-id=obj_alpha',
    '--resonance-json={"score":0.8,"confidence":0.9,"sources":["mirror"]}'
  ], env, root);
  assert.notStrictEqual(blocked.status, 0, 'single source should fail consensus threshold');
  const blockedOut = parseJson(blocked, 'evaluate_blocked');
  assert.strictEqual(blockedOut.ok, false);
  assert.ok(blockedOut.blocked.includes('consensus_sources_below_min'));

  const passed = runNode(scriptPath, [
    'evaluate',
    '--objective-id=obj_alpha',
    '--resonance-json={"score":0.82,"confidence":0.88,"sources":["mirror","regime","identity"]}'
  ], env, root);
  assert.strictEqual(passed.status, 0, passed.stderr || passed.stdout);
  const passedOut = parseJson(passed, 'evaluate_pass');
  assert.strictEqual(passedOut.ok, true);
  assert.strictEqual(passedOut.hint, 'accelerate');
  assert.ok(Number(passedOut.influence || 0) > 0);
  assert.ok(Number(passedOut.influence || 0) <= 0.3);

  const status = runNode(scriptPath, ['status'], env, root);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusOut = parseJson(status, 'status');
  assert.strictEqual(statusOut.ok, true);
  assert.strictEqual(statusOut.latest.objective_id, 'obj_alpha');

  assert.ok(fs.existsSync(receiptsPath), 'resonance receipts should be written');
}

run();
