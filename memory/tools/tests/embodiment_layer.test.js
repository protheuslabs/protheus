#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, value) {
  write(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function run(script, root, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env,
    encoding: 'utf8'
  });
  return {
    status: Number(r.status || 0),
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    payload: parseJson(r.stdout)
  };
}

function main() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(root, 'systems', 'hardware', 'embodiment_layer.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'embodiment-layer-'));

  const policyPath = path.join(tmp, 'config', 'embodiment_layer_policy.json');
  writeJson(policyPath, {
    schema_id: 'embodiment_layer_policy',
    schema_version: '1.0',
    enabled: true,
    required_contract_fields: ['profile_id', 'capabilities', 'surface_budget', 'capability_envelope', 'runtime_modes'],
    parity_ignore_fields: [
      'measured_at',
      'hardware_fingerprint',
      'surface_budget.score',
      'capabilities.cpu_threads',
      'capabilities.ram_gb',
      'capabilities.storage_gb',
      'capabilities.free_ram_gb'
    ],
    profiles: {
      phone: { max_parallel_workflows: 2, inversion_depth_cap: 1, dream_intensity_cap: 1, heavy_lanes_disabled: true, min_surface_budget_score: 0.2 },
      desktop: { max_parallel_workflows: 6, inversion_depth_cap: 3, dream_intensity_cap: 3, heavy_lanes_disabled: false, min_surface_budget_score: 0.35 },
      cluster: { max_parallel_workflows: 24, inversion_depth_cap: 5, dream_intensity_cap: 5, heavy_lanes_disabled: false, min_surface_budget_score: 0.5 }
    },
    latest_path: path.join(tmp, 'state', 'hardware', 'embodiment', 'latest.json'),
    receipts_path: path.join(tmp, 'state', 'hardware', 'embodiment', 'receipts.jsonl')
  });

  const env = {
    ...process.env,
    EMBODIMENT_LAYER_ROOT: tmp,
    EMBODIMENT_LAYER_POLICY_PATH: policyPath,
    EMBODIMENT_CPU_THREADS: '8',
    EMBODIMENT_RAM_GB: '12',
    EMBODIMENT_FREE_RAM_GB: '6',
    EMBODIMENT_STORAGE_GB: '256',
    EMBODIMENT_BATTERY: '0.8',
    EMBODIMENT_THERMAL: '0.2',
    EMBODIMENT_NETWORK: '0.9'
  };

  const sense = run(script, root, ['sense', '--profile=phone', `--policy=${policyPath}`], env);
  assert.strictEqual(sense.status, 0, sense.stderr || 'sense should pass');
  assert.ok(sense.payload && sense.payload.ok === true, 'sense payload should be ok');
  assert.strictEqual(String(sense.payload.snapshot.profile_id || ''), 'phone', 'profile should resolve to phone');
  assert.ok(sense.payload.snapshot.surface_budget.score >= 0, 'surface budget score should be present');

  const parity = run(script, root, ['verify-parity', '--profiles=phone,desktop,cluster', '--strict=1', `--policy=${policyPath}`], env);
  assert.strictEqual(parity.status, 0, parity.stderr || 'parity verify should pass');
  assert.ok(parity.payload && parity.payload.ok === true, 'parity payload should be ok');
  assert.strictEqual(Array.isArray(parity.payload.non_capacity_diffs) ? parity.payload.non_capacity_diffs.length : 1, 0, 'no non-capacity parity diffs expected');

  const status = run(script, root, ['status', `--policy=${policyPath}`], env);
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  assert.ok(status.payload && status.payload.ok === true, 'status payload should be ok');
  assert.strictEqual(String(status.payload.snapshot.profile_id || ''), 'phone', 'status snapshot should persist latest profile');

  console.log('embodiment_layer.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`embodiment_layer.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
