#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'wasi2_execution_completeness_gate.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(args) {
  const res = spawnSync('node', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  let payload = null;
  try { payload = JSON.parse(String(res.stdout || '').trim()); } catch {}
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    payload,
    stderr: String(res.stderr || '')
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wasi2-gate-'));
  const policyPath = path.join(tmp, 'config', 'wasi2_execution_completeness_gate_policy.json');

  writeJson(policyPath, {
    enabled: true,
    strict_default: true,
    thresholds: {
      min_parity_pass_rate: 1,
      max_p95_latency_delta_ms: 600,
      min_safety_pass_rate: 1
    },
    target_lanes: ['guard', 'spawn_broker'],
    paths: {
      state_path: path.join(tmp, 'state', 'state.json'),
      latest_path: path.join(tmp, 'state', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'receipts.jsonl'),
      history_path: path.join(tmp, 'state', 'history.jsonl')
    }
  });

  let res = run(['run', '--strict=1', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `run should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.pass === true, 'gate should pass');
  assert.strictEqual(res.payload.type, 'wasi2_execution_completeness_gate');
  assert.ok(Array.isArray(res.payload.rows) && res.payload.rows.length === 2, 'lane rows should be present');

  res = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.type === 'wasi2_execution_completeness_gate_status', 'status payload type should match');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('wasi2_execution_completeness_gate.test.js: OK');
} catch (err) {
  console.error(`wasi2_execution_completeness_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
