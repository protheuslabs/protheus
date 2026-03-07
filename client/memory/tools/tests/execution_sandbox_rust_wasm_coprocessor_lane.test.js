#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'execution_sandbox_rust_wasm_coprocessor_lane.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  const lines = txt.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-coprocessor-'));
  const policyPath = path.join(tmp, 'config', 'execution_sandbox_rust_wasm_coprocessor_lane_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'security.execution_sandbox_rust_wasm_coprocessor' },
    enable_coprocessor: true,
    sandbox_script: path.join(ROOT, 'systems', 'security', 'execution_sandbox_envelope.js'),
    wasm_runtime_script: path.join(ROOT, 'systems', 'wasm', 'component_runtime.js'),
    paths: {
      memory_dir: path.join(tmp, 'memory', 'security', 'execution_sandbox_rust_wasm_coprocessor_lane'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'security', 'execution_sandbox_rust_wasm_coprocessor_lane', 'index.json'),
      events_path: path.join(tmp, 'state', 'security', 'execution_sandbox_rust_wasm_coprocessor_lane', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'security', 'execution_sandbox_rust_wasm_coprocessor_lane', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'security', 'execution_sandbox_rust_wasm_coprocessor_lane', 'receipts.jsonl'),
      coprocessor_state_path: path.join(tmp, 'state', 'security', 'execution_sandbox_rust_wasm_coprocessor_lane', 'state.json')
    }
  });

  const out = run(['verify', '--owner=jay', '--strict=1', '--mock=1', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.event === 'execution_sandbox_rust_wasm_coprocessor_verify', 'verify should emit coprocessor receipt');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('execution_sandbox_rust_wasm_coprocessor_lane.test.js: OK');
} catch (err) {
  console.error(`execution_sandbox_rust_wasm_coprocessor_lane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
