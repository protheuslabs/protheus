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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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
  const tmpRoot = path.join(__dirname, 'temp_strategy_mode_governor');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });

  const strategyDir = path.join(tmpRoot, 'strategies');
  const runsDir = path.join(tmpRoot, 'state', 'autonomy', 'runs');
  const autoReceiptsDir = path.join(tmpRoot, 'state', 'autonomy', 'receipts');
  const actReceiptsDir = path.join(tmpRoot, 'state', 'actuation', 'receipts');
  const modeLogPath = path.join(tmpRoot, 'state', 'autonomy', 'strategy_mode_changes.jsonl');
  mkDir(strategyDir);
  mkDir(runsDir);
  mkDir(autoReceiptsDir);
  mkDir(actReceiptsDir);

  const strategyPath = path.join(strategyDir, 'default.json');
  writeJson(strategyPath, {
    version: '1.0',
    id: 'governor_test',
    status: 'active',
    objective: { primary: 'test objective' },
    risk_policy: { allowed_risks: ['low'] },
    promotion_policy: {
      min_days: 1,
      min_attempted: 3,
      min_verified_rate: 0.5,
      min_success_criteria_receipts: 1,
      min_success_criteria_pass_rate: 0.5,
      min_objective_coverage: 0,
      max_objective_no_progress_rate: 1,
      max_reverted_rate: 0.5,
      max_stop_ratio: 0.9,
      min_shipped: 1
    },
    execution_policy: { mode: 'score_only' }
  });

  const date = '2026-02-19';
  writeJsonl(path.join(runsDir, `${date}.jsonl`), [
    { ts: `${date}T01:00:00.000Z`, type: 'autonomy_run', result: 'executed', outcome: 'shipped', execution_mode: 'score_only' },
    { ts: `${date}T01:10:00.000Z`, type: 'autonomy_run', result: 'executed', outcome: 'no_change', execution_mode: 'score_only' }
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
      verdict: 'pass',
      verification: { success_criteria: { required: true, passed: true } },
      receipt_contract: { verified: true }
    },
    {
      type: 'autonomy_action_receipt',
      verdict: 'pass',
      verification: { success_criteria: { required: true, passed: true } },
      receipt_contract: { verified: true }
    },
    {
      type: 'autonomy_action_receipt',
      verdict: 'pass',
      intent: { score_only: true },
      verification: { success_criteria: { required: true, passed: true } },
      receipt_contract: { verified: true }
    }
  ]);
  writeJsonl(path.join(actReceiptsDir, `${date}.jsonl`), []);

  const env = {
    ...process.env,
    AUTONOMY_STRATEGY_DIR: strategyDir,
    AUTONOMY_SUMMARY_RUNS_DIR: runsDir,
    AUTONOMY_SUMMARY_RECEIPTS_DIR: autoReceiptsDir,
    ACTUATION_SUMMARY_RECEIPTS_DIR: actReceiptsDir,
    AUTONOMY_STRATEGY_MODE_LOG: modeLogPath,
    AUTONOMY_STRATEGY_MODE_GOVERNOR_STATE: path.join(tmpRoot, 'strategy_mode_governor_state.json'),
    AUTONOMY_MODE_GOVERNOR_MIN_HOURS_BETWEEN_CHANGES: '0',
    AUTONOMY_MODE_GOVERNOR_MIN_ESCALATE_STREAK: '1',
    AUTONOMY_MODE_GOVERNOR_PROMOTE_EXECUTE: '1',
    AUTONOMY_MODE_GOVERNOR_REQUIRE_POLICY_ROOT: '0',
    AUTONOMY_MODE_GOVERNOR_CANARY_MIN_ATTEMPTED: '2',
    AUTONOMY_MODE_GOVERNOR_CANARY_MIN_VERIFIED_RATE: '0.5',
    AUTONOMY_MODE_GOVERNOR_CANARY_MAX_FAIL_RATE: '0.5',
    AUTONOMY_MODE_GOVERNOR_CANARY_MIN_SHIPPED: '1',
    AUTONOMY_MODE_GOVERNOR_REQUIRE_QUALITY_LOCK_FOR_EXECUTE: '0'
  };
  const envAllowEscalation = {
    ...env,
    AUTONOMY_MODE_GOVERNOR_ALLOW_AUTO_ESCALATION: '1'
  };

  // By default, escalation is blocked until dual-control mode set is used.
  let r = runScript(repoRoot, ['run', date, '--days=1'], env);
  assert.strictEqual(r.status, 0, `governor run (blocked escalation) should pass: ${r.stderr}`);
  let out = parseJson(r.stdout);
  assert.strictEqual(out.result, 'blocked_dual_control_required');
  assert.strictEqual(out.from_mode, 'score_only');
  assert.strictEqual(out.to_mode, 'canary_execute');
  let after = readJson(strategyPath);
  assert.strictEqual(after.execution_policy.mode, 'score_only');

  // score_only -> canary_execute
  r = runScript(repoRoot, ['run', date, '--days=1'], envAllowEscalation);
  assert.strictEqual(r.status, 0, `governor run (promote canary) should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.result, 'mode_changed');
  assert.strictEqual(out.from_mode, 'score_only');
  assert.strictEqual(out.to_mode, 'canary_execute');
  after = readJson(strategyPath);
  assert.strictEqual(after.execution_policy.mode, 'canary_execute');

  // canary_execute -> execute
  r = runScript(repoRoot, ['run', date, '--days=1'], envAllowEscalation);
  assert.strictEqual(r.status, 0, `governor run (promote execute) should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.result, 'mode_changed');
  assert.strictEqual(out.from_mode, 'canary_execute');
  assert.strictEqual(out.to_mode, 'execute');
  after = readJson(strategyPath);
  assert.strictEqual(after.execution_policy.mode, 'execute');

  // readiness failure -> demote execute -> canary_execute
  writeJsonl(path.join(autoReceiptsDir, `${date}.jsonl`), [
    {
      type: 'autonomy_action_receipt',
      verdict: 'pass',
      verification: { success_criteria: { required: true, passed: true } },
      receipt_contract: { verified: true }
    }
  ]);
  r = runScript(repoRoot, ['run', date, '--days=1'], envAllowEscalation);
  assert.strictEqual(r.status, 0, `governor run (demote not ready) should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.result, 'mode_changed');
  assert.strictEqual(out.from_mode, 'execute');
  assert.strictEqual(out.to_mode, 'canary_execute');
  after = readJson(strategyPath);
  assert.strictEqual(after.execution_policy.mode, 'canary_execute');

  console.log('strategy_mode_governor.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`strategy_mode_governor.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
