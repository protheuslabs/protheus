#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'hardware', 'surface_budget_controller.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-budget-controller-'));
  const policyPath = path.join(tmp, 'surface_budget_policy.json');
  const embodimentPath = path.join(tmp, 'state', 'hardware', 'embodiment', 'latest.json');
  const runtimeStatePath = path.join(tmp, 'state', 'runtime', 'scheduler_mode', 'latest.json');
  const statePath = path.join(tmp, 'state', 'hardware', 'surface_budget', 'latest.json');
  const receiptsPath = path.join(tmp, 'state', 'hardware', 'surface_budget', 'receipts.jsonl');

  writeJson(embodimentPath, {
    profile_id: 'phone',
    surface_budget: {
      score: 0.12,
      factors: {
        cpu_score: 0.1,
        memory_score: 0.2,
        thermal_score: 0.1,
        battery_score: 0.1,
        network_score: 0.2
      }
    },
    capability_envelope: {
      inversion_depth_cap: 1,
      dream_intensity_cap: 1,
      max_parallel_workflows: 2,
      heavy_lanes_disabled: true
    }
  });
  writeJson(runtimeStatePath, {
    schema_id: 'runtime_scheduler_state',
    schema_version: '1.0',
    mode: 'inversion',
    updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    reason: 'test_seed'
  });
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: false,
    apply_default: false,
    min_transition_seconds: 0,
    embodiment_snapshot_path: embodimentPath,
    runtime_state_path: runtimeStatePath,
    state_path: statePath,
    receipts_path: receiptsPath,
    tiers: [
      {
        id: 'critical',
        max_score: 0.2,
        allow_modes: ['operational'],
        inversion_depth_cap: 0,
        dream_intensity_cap: 0,
        right_brain_max_ratio: 0,
        fractal_breadth_cap: 1,
        max_parallel_workflows: 1
      },
      {
        id: 'balanced',
        max_score: 1,
        allow_modes: ['operational', 'dream', 'inversion'],
        inversion_depth_cap: 3,
        dream_intensity_cap: 3,
        right_brain_max_ratio: 0.6,
        fractal_breadth_cap: 4,
        max_parallel_workflows: 6
      }
    ]
  });

  const env = { SURFACE_BUDGET_POLICY_PATH: policyPath };

  const runRes = run(['run', '--apply=1', '--strict=1'], env);
  assert.strictEqual(runRes.status, 0, runRes.stderr || 'surface budget run should pass');
  const runPayload = parseJson(runRes.stdout);
  assert.ok(runPayload && runPayload.ok === true, 'run payload should be ok');
  assert.strictEqual(runPayload.mode_allowed, false, 'inversion should be disallowed in critical tier');
  assert.strictEqual(runPayload.recommended_mode, 'operational', 'recommended mode should be operational');
  assert.strictEqual(runPayload.apply_result.applied, true, 'controller should enforce runtime mode transition');

  const runtimeState = JSON.parse(fs.readFileSync(runtimeStatePath, 'utf8'));
  assert.strictEqual(runtimeState.mode, 'operational', 'runtime state should be forced to operational');
  assert.ok(fs.existsSync(statePath), 'latest state should be written');
  assert.ok(fs.existsSync(receiptsPath), 'receipts should be written');

  const statusRes = run(['status'], env);
  assert.strictEqual(statusRes.status, 0, statusRes.stderr || 'status should pass');
  const statusPayload = parseJson(statusRes.stdout);
  assert.ok(statusPayload && statusPayload.ok === true, 'status should be ok');
  assert.ok(statusPayload.latest && statusPayload.latest.budget, 'status should include latest budget payload');

  console.log('surface_budget_controller.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`surface_budget_controller.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
