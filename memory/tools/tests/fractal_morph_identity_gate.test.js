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

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'fractal', 'morph_planner.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-morph-identity-'));
  const dateStr = '2026-02-25';

  const policyPath = path.join(tmpRoot, 'config', 'identity_anchor_policy.json');
  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    max_identity_drift_score: 0.58,
    enforcement: {
      block_on_parent_objective_mismatch: true,
      block_on_parent_value_currency_mismatch: true,
      block_on_active_objective_currency_mismatch: true,
      block_on_objective_missing_when_parent_present: true,
      block_on_unknown_active_objective: true,
      block_on_branch_depth_jump: false
    },
    weights: {
      objective_unknown_active: 0.7
    }
  });

  const env = {
    ...process.env,
    IDENTITY_ANCHOR_POLICY_PATH: policyPath,
    FRACTAL_MORPH_PLAN_DIR: path.join(tmpRoot, 'state', 'autonomy', 'fractal', 'morph_plans'),
    FRACTAL_MORPH_RECEIPTS_PATH: path.join(tmpRoot, 'state', 'autonomy', 'fractal', 'receipts.jsonl'),
    FRACTAL_MORPH_SIM_DIR: path.join(tmpRoot, 'state', 'autonomy', 'simulations'),
    FRACTAL_MORPH_SUGGESTION_LANE_DIR: path.join(tmpRoot, 'state', 'autonomy', 'suggestion_lane'),
    FRACTAL_MORPH_QUEUE_PATH: path.join(tmpRoot, 'state', 'autonomy', 'sensory_queue.json'),
    FRACTAL_MORPH_RUNS_DIR: path.join(tmpRoot, 'state', 'autonomy', 'runs'),
    IDENTITY_ANCHOR_OUT_DIR: path.join(tmpRoot, 'state', 'autonomy', 'identity_anchor')
  };

  writeJson(path.join(env.FRACTAL_MORPH_SIM_DIR, `${dateStr}.json`), {
    checks_effective: {
      drift_rate: { value: 0.041 },
      yield_rate: { value: 0.62 }
    }
  });
  writeJson(path.join(env.FRACTAL_MORPH_SUGGESTION_LANE_DIR, `${dateStr}.json`), {
    merged_count: 8,
    total_candidates: 22,
    capped: true
  });
  writeJson(env.FRACTAL_MORPH_QUEUE_PATH, {
    pending: 95,
    total: 120
  });
  writeJsonl(path.join(env.FRACTAL_MORPH_RUNS_DIR, `${dateStr}.jsonl`), [
    {
      type: 'autonomy_run',
      objective_id: 'unknown_objective_should_block'
    }
  ]);

  const runProc = spawnSync(process.execPath, [scriptPath, 'run', dateStr, '--max-actions=6'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(runProc.status, 0, runProc.stderr || 'run command should pass');
  const runOut = JSON.parse(String(runProc.stdout || '{}').trim());
  assert.strictEqual(runOut.ok, true);
  assert.strictEqual(Number(runOut.action_count || 0), 0, 'identity gate should block all morph actions for unknown objective in strict mode');
  assert.ok(Number(runOut.identity_blocked || 0) >= 1, 'identity gate should report blocked morph actions');

  const planPath = path.join(env.FRACTAL_MORPH_PLAN_DIR, `${dateStr}.json`);
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  assert.ok(plan.identity && Number(plan.identity.blocked || 0) >= 1, 'plan should include identity blocked summary');
  assert.strictEqual(Array.isArray(plan.actions) ? plan.actions.length : -1, 0, 'plan actions should be filtered to zero');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('fractal_morph_identity_gate.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`fractal_morph_identity_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
