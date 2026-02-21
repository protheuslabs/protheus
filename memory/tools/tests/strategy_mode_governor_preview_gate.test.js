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
  const body = (rows || []).map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(filePath, body + (body ? '\n' : ''), 'utf8');
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}'));
}

function runScript(repoRoot, args, env) {
  const script = path.join(repoRoot, 'systems', 'autonomy', 'strategy_mode_governor.js');
  return spawnSync('node', [script, ...args], { cwd: repoRoot, encoding: 'utf8', env });
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_strategy_mode_governor_preview_gate');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });

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
    id: 'governor_preview_gate_test',
    status: 'active',
    objective: { primary: 'test preview criteria gate' },
    risk_policy: { allowed_risks: ['low'] },
    promotion_policy: {
      min_days: 1,
      min_attempted: 3,
      min_verified_rate: 0.5,
      min_objective_coverage: 0,
      max_objective_no_progress_rate: 1,
      max_reverted_rate: 0.5,
      max_stop_ratio: 0.9,
      min_shipped: 1
    },
    execution_policy: { mode: 'score_only' }
  });

  const date = '2026-02-21';
  writeJsonl(path.join(runsDir, `${date}.jsonl`), [
    { ts: `${date}T01:00:00.000Z`, type: 'autonomy_run', result: 'executed', outcome: 'shipped', execution_mode: 'score_only' },
    { ts: `${date}T01:10:00.000Z`, type: 'autonomy_run', result: 'executed', outcome: 'no_change', execution_mode: 'score_only' }
  ]);

  writeJsonl(path.join(autoReceiptsDir, `${date}.jsonl`), [
    {
      type: 'autonomy_action_receipt',
      verdict: 'pass',
      receipt_contract: { attempted: true, verified: true },
      verification: { passed: true, success_criteria: { required: true, passed: true } }
    },
    {
      type: 'autonomy_action_receipt',
      verdict: 'pass',
      receipt_contract: { attempted: true, verified: true },
      verification: { passed: true, success_criteria: { required: true, passed: true } }
    },
    {
      type: 'autonomy_action_receipt',
      verdict: 'fail',
      receipt_contract: { attempted: true, verified: false },
      intent: { score_only: true },
      verification: { passed: false, success_criteria: { required: true, passed: false } }
    }
  ]);
  writeJsonl(path.join(actReceiptsDir, `${date}.jsonl`), []);

  const env = {
    ...process.env,
    AUTONOMY_STRATEGY_DIR: strategyDir,
    AUTONOMY_SUMMARY_RUNS_DIR: runsDir,
    AUTONOMY_SUMMARY_RECEIPTS_DIR: autoReceiptsDir,
    ACTUATION_SUMMARY_RECEIPTS_DIR: actReceiptsDir,
    AUTONOMY_STRATEGY_MODE_GOVERNOR_STATE: path.join(tmpRoot, 'strategy_mode_governor_state.json'),
    AUTONOMY_MODE_GOVERNOR_MIN_HOURS_BETWEEN_CHANGES: '0',
    AUTONOMY_MODE_GOVERNOR_MIN_ESCALATE_STREAK: '1',
    AUTONOMY_MODE_GOVERNOR_ALLOW_AUTO_ESCALATION: '1',
    AUTONOMY_MODE_GOVERNOR_CANARY_MIN_PREVIEW_SUCCESS_CRITERIA_PASS_RATE: '0.6'
  };

  const r = runScript(repoRoot, ['run', date, '--days=1'], env);
  assert.strictEqual(r.status, 0, `governor run should pass: ${r.stderr}`);
  const out = parseJson(r.stdout);
  assert.strictEqual(out.result, 'no_change');
  assert.strictEqual(out.mode, 'score_only');
  assert.strictEqual(out.reason, 'preview_success_criteria_below_min');
  assert.strictEqual(out.canary.preview_ready_for_canary, false);

  console.log('strategy_mode_governor_preview_gate.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`strategy_mode_governor_preview_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
