#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'primitives', 'iterative_repair_primitive.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iterative-repair-test-'));
  const target = path.join(tmp, 'systems', 'workflow', 'target.ts');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'export const target = 1;\n', 'utf8');
  const policyPath = path.join(tmp, 'policy.json');
  writeJson(policyPath, {
    enabled: true,
    shadow_only: true,
    max_iterations: 3,
    max_runtime_sec: 120,
    stop_on_verify_pass: true,
    require_rollback_points: true,
    allowed_target_roots: ['../'],
    receipts_path: path.join(tmp, 'state', 'receipts.jsonl'),
    latest_path: path.join(tmp, 'state', 'latest.json'),
    state_path: path.join(tmp, 'state', 'state.json')
  });

  const env = {
    ITERATIVE_REPAIR_POLICY_PATH: policyPath,
    PASSPORT_ITERATION_CHAIN_PATH: path.join(tmp, 'state', 'passport_chain.jsonl'),
    PASSPORT_ITERATION_CHAIN_LATEST_PATH: path.join(tmp, 'state', 'passport_chain.latest.json')
  };

  const r = run([
    'run',
    `--target-path=${target}`,
    '--objective-id=obj_iterative',
    '--iterations=3',
    '--apply=0'
  ], env);
  assert.strictEqual(r.status, 0, `run should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'iterative repair should converge');
  assert.ok(Array.isArray(r.payload.rollback_points) && r.payload.rollback_points.length >= 1, 'rollback points required');

  const status = run(['status'], env);
  assert.strictEqual(status.status, 0, `status should pass: ${status.stderr}`);
  assert.ok(status.payload && status.payload.ok === true, 'status payload should be ok');

  console.log('iterative_repair_primitive.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`iterative_repair_primitive.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
