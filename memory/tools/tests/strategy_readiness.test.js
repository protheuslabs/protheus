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

function writeJsonl(filePath, rows) {
  mkDir(path.dirname(filePath));
  const text = (rows || []).map(r => JSON.stringify(r)).join('\n');
  fs.writeFileSync(filePath, text + (rows && rows.length ? '\n' : ''), 'utf8');
}

function runScript(repoRoot, args, env) {
  const script = path.join(repoRoot, 'systems', 'autonomy', 'strategy_readiness.js');
  return spawnSync('node', [script, ...args], { cwd: repoRoot, encoding: 'utf8', env });
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}'));
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_strategy_readiness');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  const strategyDir = path.join(tmpRoot, 'strategies');
  const runsDir = path.join(tmpRoot, 'state', 'autonomy', 'runs');
  const autoReceiptsDir = path.join(tmpRoot, 'state', 'autonomy', 'receipts');
  const actReceiptsDir = path.join(tmpRoot, 'state', 'actuation', 'receipts');
  mkDir(strategyDir);
  mkDir(runsDir);
  mkDir(autoReceiptsDir);
  mkDir(actReceiptsDir);

  writeJson(path.join(strategyDir, 'default.json'), {
    version: '1.0',
    id: 'readiness_test',
    status: 'active',
    objective: { primary: 'test objective' },
    risk_policy: { allowed_risks: ['low'] },
    execution_policy: { mode: 'score_only' },
    promotion_policy: {
      min_days: 7,
      min_attempted: 6,
      min_verified_rate: 0.5,
      min_success_criteria_receipts: 2,
      min_success_criteria_pass_rate: 0.5,
      max_reverted_rate: 0.4,
      max_stop_ratio: 0.8,
      min_shipped: 1
    }
  });

  const date = '2026-02-19';
  writeJsonl(path.join(runsDir, `${date}.jsonl`), [
    { ts: '2026-02-19T01:00:00.000Z', type: 'autonomy_run', result: 'executed', outcome: 'shipped', objective_id: 'T1_objA' },
    { ts: '2026-02-19T01:10:00.000Z', type: 'autonomy_run', result: 'executed', outcome: 'no_change', objective_id: 'T1_objA' },
    { ts: '2026-02-19T01:20:00.000Z', type: 'autonomy_run', result: 'stop_repeat_gate_interval', objective_id: 'T1_objA' }
  ]);
  writeJsonl(path.join(autoReceiptsDir, `${date}.jsonl`), [
    {
      type: 'autonomy_action_receipt',
      verdict: 'pass',
      verification: { success_criteria: { required: true, passed: true } },
      receipt_contract: { verified: true }
    },
    {
      type: 'autonomy_action_receipt',
      verdict: 'fail',
      verification: { success_criteria: { required: true, passed: true } },
      receipt_contract: { verified: false }
    }
  ]);
  writeJsonl(path.join(actReceiptsDir, `${date}.jsonl`), [
    { adapter: 'demo', ok: true, receipt_contract: { verified: true } }
  ]);

  const baseEnv = {
    ...process.env,
    AUTONOMY_STRATEGY_DIR: strategyDir,
    AUTONOMY_SUMMARY_RUNS_DIR: runsDir,
    AUTONOMY_SUMMARY_RECEIPTS_DIR: autoReceiptsDir,
    ACTUATION_SUMMARY_RECEIPTS_DIR: actReceiptsDir
  };

  // Case 1: not ready (attempted too low for policy).
  let r = runScript(repoRoot, ['run', date, '--days=7'], baseEnv);
  assert.strictEqual(r.status, 0, `expected exit 0: ${r.stderr}`);
  let out = parseJson(r.stdout);
  assert.strictEqual(out.readiness.ready_for_execute, false);
  assert.strictEqual(out.readiness.recommended_mode, 'score_only');
  assert.ok(out.readiness.failed_checks.includes('attempted'));

  // Case 2: ready after enough receipts and no harmful stop ratio/reverted rate.
  writeJson(path.join(strategyDir, 'default.json'), {
    version: '1.0',
    id: 'readiness_test',
    status: 'active',
    objective: { primary: 'test objective' },
    risk_policy: { allowed_risks: ['low'] },
    execution_policy: { mode: 'score_only' },
    promotion_policy: {
      min_days: 7,
      min_attempted: 3,
      min_verified_rate: 0.5,
      min_success_criteria_receipts: 2,
      min_success_criteria_pass_rate: 0.5,
      max_reverted_rate: 0.5,
      max_stop_ratio: 0.9,
      min_shipped: 1
    }
  });

  r = runScript(repoRoot, ['run', date, '--days=7'], baseEnv);
  assert.strictEqual(r.status, 0, `expected exit 0: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.readiness.ready_for_execute, true);
  assert.strictEqual(out.readiness.recommended_mode, 'execute_candidate');

  console.log('strategy_readiness.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`strategy_readiness.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
