#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'wasm', 'component_runtime.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-runtime-'));
  const policyPath = path.join(tmp, 'config', 'wasm_component_runtime_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'wasm.component_runtime' },
    paths: {
      memory_dir: path.join(tmp, 'memory', 'wasm'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'wasm', 'index.json'),
      events_path: path.join(tmp, 'state', 'wasm', 'component_runtime', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'wasm', 'component_runtime', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'wasm', 'component_runtime', 'receipts.jsonl')
    }
  });

  let out = run(['configure', '--owner=jay', '--module-preference=cache_warm', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  out = run(['load', '--owner=jay', '--module=planner_core', '--manifest-hash=abc123', '--risk-tier=2', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'wasm_component_load');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('wasm_component_runtime.test.js: OK');
} catch (err) {
  console.error(`wasm_component_runtime.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
