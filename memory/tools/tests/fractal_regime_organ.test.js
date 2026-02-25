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
  const scriptPath = path.join(repoRoot, 'systems', 'fractal', 'regime_organ.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-regime-'));
  const dateA = '2026-02-25';
  const dateB = '2026-02-26';

  const policyPath = path.join(tmpRoot, 'config', 'regime_organ_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    min_confidence: 0.5,
    max_actions: 4,
    max_magnitude: 0.4,
    hysteresis: {
      switch_margin: 0.95,
      min_dwell_minutes: 0,
      cooldown_minutes: 0
    },
    non_regression: {
      enabled: true,
      require_simulation: true,
      max_drift_regression: 0.003,
      max_yield_regression: 0.01
    }
  });

  const env = {
    ...process.env,
    FRACTAL_REGIME_DIR: path.join(tmpRoot, 'state', 'autonomy', 'fractal', 'regime'),
    FRACTAL_REGIME_RUNS_DIR: path.join(tmpRoot, 'state', 'autonomy', 'runs'),
    FRACTAL_REGIME_SIM_DIR: path.join(tmpRoot, 'state', 'autonomy', 'simulations'),
    FRACTAL_REGIME_QUEUE_PATH: path.join(tmpRoot, 'state', 'autonomy', 'sensory_queue.json'),
    FRACTAL_REGIME_AUTOPAUSE_PATH: path.join(tmpRoot, 'state', 'autonomy', 'budget_autopause.json'),
    FRACTAL_REGIME_TERNARY_DIR: path.join(tmpRoot, 'state', 'spine', 'ternary_belief'),
    IDENTITY_ANCHOR_OUT_DIR: path.join(tmpRoot, 'state', 'autonomy', 'identity_anchor')
  };

  writeJson(path.join(env.FRACTAL_REGIME_SIM_DIR, `${dateA}.json`), {
    checks_effective: {
      drift_rate: { value: 0.024 },
      yield_rate: { value: 0.72 }
    }
  });
  writeJson(path.join(env.FRACTAL_REGIME_SIM_DIR, `${dateB}.json`), {
    checks_effective: {
      drift_rate: { value: 0.041 },
      yield_rate: { value: 0.68 }
    }
  });

  writeJsonl(path.join(env.FRACTAL_REGIME_RUNS_DIR, `${dateA}.jsonl`), [
    { type: 'autonomy_run', result: 'executed', outcome: 'shipped', objective_id: 'T1_growth' },
    { type: 'autonomy_run', result: 'executed', outcome: 'shipped', objective_id: 'T1_growth' }
  ]);
  writeJsonl(path.join(env.FRACTAL_REGIME_RUNS_DIR, `${dateB}.jsonl`), [
    { type: 'autonomy_run', result: 'executed', outcome: 'no_change', objective_id: 'T1_growth' },
    { type: 'autonomy_run', result: 'policy_hold', outcome: 'no_change', objective_id: 'T1_growth' },
    { type: 'autonomy_run', result: 'executed', outcome: 'shipped', objective_id: 'T1_growth' }
  ]);

  writeJson(env.FRACTAL_REGIME_AUTOPAUSE_PATH, { active: false });
  writeJson(path.join(env.FRACTAL_REGIME_TERNARY_DIR, `${dateA}_daily.json`), {
    summary: { trit: 1, score: 0.61, confidence: 0.82 }
  });
  writeJson(path.join(env.FRACTAL_REGIME_TERNARY_DIR, `${dateB}_daily.json`), {
    summary: { trit: -1, score: -0.66, confidence: 0.91 }
  });

  writeJson(env.FRACTAL_REGIME_QUEUE_PATH, { pending: 90, total: 100 });
  const runA = spawnSync(process.execPath, [
    scriptPath,
    'run',
    dateA,
    `--policy=${policyPath}`,
    '--max-actions=4'
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(runA.status, 0, runA.stderr || 'dateA run should pass');
  const outA = JSON.parse(String(runA.stdout || '{}').trim());
  assert.strictEqual(outA.ok, true);
  assert.strictEqual(outA.selected_regime, 'throughput', 'first run should establish throughput regime');
  assert.strictEqual(outA.non_regression_pass, true, 'first run baseline should pass non-regression gate');

  writeJson(env.FRACTAL_REGIME_QUEUE_PATH, { pending: 8, total: 100 });
  const runB = spawnSync(process.execPath, [
    scriptPath,
    'run',
    dateB,
    `--policy=${policyPath}`,
    '--max-actions=4'
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(runB.status, 0, runB.stderr || 'dateB run should pass');
  const outB = JSON.parse(String(runB.stdout || '{}').trim());
  assert.strictEqual(outB.ok, true);
  assert.strictEqual(outB.selected_regime, 'throughput', 'hysteresis should keep prior regime');
  assert.strictEqual(outB.switch_reason, 'hysteresis_margin');
  assert.strictEqual(outB.non_regression_pass, false, 'second run should detect simulation regression');
  assert.strictEqual(outB.promotion_ready, false, 'promotion must be blocked when non-regression fails');

  const latestPath = path.join(env.FRACTAL_REGIME_DIR, 'latest.json');
  const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  assert.strictEqual(latest.selected_regime, 'throughput');
  assert.strictEqual(latest.non_regression.pass, false);
  assert.ok(Array.isArray(latest.actions));

  const status = spawnSync(process.execPath, [scriptPath, 'status', dateB], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  const statusOut = JSON.parse(String(status.stdout || '{}').trim());
  assert.strictEqual(statusOut.ok, true);
  assert.strictEqual(statusOut.selected_regime, 'throughput');

  console.log('fractal_regime_organ.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`fractal_regime_organ.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
