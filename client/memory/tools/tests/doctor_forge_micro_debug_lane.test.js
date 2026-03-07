#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'doctor_forge_micro_debug_lane.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function parsePayload(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return {
    status: Number(r.status || 0),
    payload: parsePayload(r.stdout),
    stderr: String(r.stderr || '')
  };
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-forge-debug-test-'));
  const target = path.join(tmp, 'systems', 'workflow', 'target.ts');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'export const value = 1;\n', 'utf8');

  const policyPath = path.join(tmp, 'doctor_policy.json');
  const iterativePolicyPath = path.join(tmp, 'iterative_policy.json');
  writeJson(policyPath, {
    enabled: true,
    rollout_mode: 'shadow',
    allow_apply_modes: ['live'],
    max_risk_score: 0.5,
    receipts_path: path.join(tmp, 'state', 'doctor', 'receipts.jsonl'),
    latest_path: path.join(tmp, 'state', 'doctor', 'latest.json')
  });
  writeJson(iterativePolicyPath, {
    enabled: true,
    shadow_only: true,
    max_iterations: 3,
    max_runtime_sec: 120,
    stop_on_verify_pass: true,
    allowed_target_roots: ['../'],
    receipts_path: path.join(tmp, 'state', 'iterative', 'receipts.jsonl'),
    latest_path: path.join(tmp, 'state', 'iterative', 'latest.json'),
    state_path: path.join(tmp, 'state', 'iterative', 'state.json')
  });

  const env = {
    DOCTOR_FORGE_MICRO_DEBUG_POLICY_PATH: policyPath,
    ITERATIVE_REPAIR_POLICY_PATH: iterativePolicyPath,
    PASSPORT_ITERATION_CHAIN_PATH: path.join(tmp, 'state', 'passport_chain.jsonl'),
    PASSPORT_ITERATION_CHAIN_LATEST_PATH: path.join(tmp, 'state', 'passport_chain.latest.json')
  };

  let r = run([
    'run',
    `--target-path=${target}`,
    '--objective-id=obj_debug',
    '--risk-score=0.2',
    '--apply=0'
  ], env);
  assert.strictEqual(r.status, 0, `run should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'lane should succeed');
  assert.ok(r.payload.repair && r.payload.repair.type === 'iterative_repair_run', 'repair payload expected');

  r = run(['status'], env);
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'status should be ok');

  console.log('doctor_forge_micro_debug_lane.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`doctor_forge_micro_debug_lane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
