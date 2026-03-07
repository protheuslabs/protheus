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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-morph-'));
  const dateStr = '2026-02-25';

  const env = {
    ...process.env,
    FRACTAL_MORPH_PLAN_DIR: path.join(tmpRoot, 'state', 'autonomy', 'fractal', 'morph_plans'),
    FRACTAL_MORPH_RECEIPTS_PATH: path.join(tmpRoot, 'state', 'autonomy', 'fractal', 'receipts.jsonl'),
    FRACTAL_MORPH_SIM_DIR: path.join(tmpRoot, 'state', 'autonomy', 'simulations'),
    FRACTAL_MORPH_SUGGESTION_LANE_DIR: path.join(tmpRoot, 'state', 'autonomy', 'suggestion_lane'),
    FRACTAL_MORPH_QUEUE_PATH: path.join(tmpRoot, 'state', 'autonomy', 'sensory_queue.json'),
    FRACTAL_MORPH_RUNS_DIR: path.join(tmpRoot, 'state', 'autonomy', 'runs')
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
      objective_id: 'T1_generational_wealth_v1'
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
  assert.ok(Number(runOut.action_count || 0) >= 3, 'should emit multiple bounded actions');

  const planPath = path.join(env.FRACTAL_MORPH_PLAN_DIR, `${dateStr}.json`);
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  assert.strictEqual(plan.governance_required, true);
  assert.strictEqual(plan.execution_mode, 'proposal_only');
  assert.ok(Array.isArray(plan.actions));
  assert.ok(plan.actions.length > 0);

  const statusProc = spawnSync(process.execPath, [scriptPath, 'status', dateStr], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(statusProc.status, 0, statusProc.stderr || 'status command should pass');
  const statusOut = JSON.parse(String(statusProc.stdout || '{}').trim());
  assert.strictEqual(statusOut.ok, true);
  assert.strictEqual(Number(statusOut.action_count || 0), plan.actions.length);

  console.log('fractal_morph_planner.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`fractal_morph_planner.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
