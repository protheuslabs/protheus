#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

function mkDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, obj) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}'));
}

function runScript(repoRoot, args, env) {
  const script = path.join(repoRoot, 'systems', 'autonomy', 'strategy_execute_guard.js');
  return spawnSync('node', [script, ...args], { cwd: repoRoot, encoding: 'utf8', env });
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_strategy_execute_guard');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });

  const strategyDir = path.join(tmpRoot, 'strategies');
  const runsDir = path.join(tmpRoot, 'autonomy_runs');
  const receiptsDir = path.join(tmpRoot, 'autonomy_receipts');
  const actuationReceiptsDir = path.join(tmpRoot, 'actuation_receipts');
  mkDir(strategyDir);
  mkDir(runsDir);
  mkDir(receiptsDir);
  mkDir(actuationReceiptsDir);

  const strategyPath = path.join(strategyDir, 'default.json');
  const statePath = path.join(tmpRoot, 'strategy_execute_guard.json');
  const modeLogPath = path.join(tmpRoot, 'strategy_mode_changes.jsonl');

  writeJson(strategyPath, {
    version: '1.0',
    id: 'execute_guard_test',
    status: 'active',
    objective: { primary: 'test objective' },
    risk_policy: { allowed_risks: ['low'] },
    promotion_policy: {
      min_days: 1,
      min_attempted: 1,
      min_verified_rate: 0,
      max_reverted_rate: 1,
      max_stop_ratio: 1,
      min_shipped: 0
    },
    execution_policy: { mode: 'execute' }
  });

  const env = {
    ...process.env,
    AUTONOMY_STRATEGY_DIR: strategyDir,
    AUTONOMY_EXECUTE_GUARD_STATE: statePath,
    AUTONOMY_STRATEGY_MODE_LOG: modeLogPath,
    AUTONOMY_EXECUTE_GUARD_MAX_CONSEC: '2',
    AUTONOMY_SUMMARY_RUNS_DIR: runsDir,
    AUTONOMY_SUMMARY_RECEIPTS_DIR: receiptsDir,
    ACTUATION_SUMMARY_RECEIPTS_DIR: actuationReceiptsDir
  };

  let r = runScript(repoRoot, ['run', '--days=1'], env);
  assert.strictEqual(r.status, 0, `first run should pass: ${r.stderr}`);
  let out = parseJson(r.stdout);
  assert.strictEqual(out.result, 'not_ready', `expected not_ready, got ${String(out.result)}`);
  assert.strictEqual(Number(out.consecutive_not_ready || 0), 1);

  r = runScript(repoRoot, ['run', '--days=1'], env);
  assert.strictEqual(r.status, 0, `second run should auto-revert: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.result, 'auto_reverted_to_score_only', `expected auto-revert, got ${String(out.result)}`);
  assert.strictEqual(out.from_mode, 'execute');
  assert.strictEqual(out.to_mode, 'score_only');

  const after = readJson(strategyPath);
  assert.strictEqual(after.execution_policy.mode, 'score_only');

  const guardState = readJson(statePath);
  const ent = guardState.by_strategy.execute_guard_test || {};
  assert.strictEqual(Number(ent.consecutive_not_ready || 0), 2);

  assert.ok(fs.existsSync(modeLogPath), 'mode log should exist');
  const lines = fs.readFileSync(modeLogPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 1, 'mode log should contain auto-revert event');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(last.type, 'strategy_mode_auto_revert');
  assert.strictEqual(last.strategy_id, 'execute_guard_test');

  r = runScript(repoRoot, ['status'], env);
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.strategy.mode, 'score_only');

  console.log('strategy_execute_guard.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`strategy_execute_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
