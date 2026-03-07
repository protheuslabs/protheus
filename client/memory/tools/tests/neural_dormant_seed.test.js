#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'symbiosis', 'neural_dormant_seed.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neural-dormant-seed-'));
  const policyPath = path.join(tmp, 'config', 'neural_dormant_seed_policy.json');
  const specPath = path.join(tmp, 'research', 'neural_dormant_seed', 'README.md');
  const checklistPath = path.join(tmp, 'research', 'neural_dormant_seed', 'governance_checklist.md');
  const statePath = path.join(tmp, 'state', 'symbiosis', 'neural_dormant_seed', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'symbiosis', 'neural_dormant_seed', 'history.jsonl');

  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  fs.writeFileSync(specPath, '# spec\n', 'utf8');
  fs.writeFileSync(checklistPath, '# checklist\n', 'utf8');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    locked: true,
    allow_simulated_prototypes: true,
    allow_non_simulated_prototypes: false,
    blocked_runtime_profiles: ['prod', 'phone_seed', 'live'],
    required_governance_checks: ['ethics_review', 'security_review', 'human_signoff'],
    paths: {
      research_spec: specPath,
      governance_checklist: checklistPath,
      state: statePath,
      history: historyPath
    }
  });

  const env = { NEURAL_DORMANT_SEED_POLICY_PATH: policyPath };

  let r = run(['status', '--profile=prod'], env);
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr || r.stdout}`);
  let payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'status payload should be ok');
  assert.strictEqual(payload.locked, true, 'should be locked');
  assert.strictEqual(payload.activation_allowed, false, 'activation must be denied in prod');
  assert.strictEqual(payload.no_runtime_activation_path, true, 'runtime path must remain blocked');

  r = run(['check', '--strict=1', '--profile=prod'], env);
  assert.strictEqual(r.status, 0, `check strict should pass when locked: ${r.stderr || r.stdout}`);
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.pass === true, 'check should pass');

  r = run(['request-sim', '--purpose=evaluate_noninvasive_signal_model'], env);
  assert.strictEqual(r.status, 0, `request-sim should pass: ${r.stderr || r.stdout}`);
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'sim request should be allowed');

  r = run(['request-live', '--purpose=attempt_live_activation', '--approval-note=manual_probe', '--profile=prod'], env);
  assert.notStrictEqual(r.status, 0, 'request-live should be denied while locked/blocked');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === false, 'live request payload should be denied');

  console.log('neural_dormant_seed.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`neural_dormant_seed.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
