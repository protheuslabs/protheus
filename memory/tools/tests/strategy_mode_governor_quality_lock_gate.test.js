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
  const tmpRoot = path.join(__dirname, 'temp_strategy_mode_governor_quality_lock_gate');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });

  const strategyDir = path.join(tmpRoot, 'strategies');
  const runsDir = path.join(tmpRoot, 'state', 'autonomy', 'runs');
  const autoReceiptsDir = path.join(tmpRoot, 'state', 'autonomy', 'receipts');
  const actReceiptsDir = path.join(tmpRoot, 'state', 'actuation', 'receipts');
  const outcomePolicyPath = path.join(tmpRoot, 'state', 'adaptive', 'strategy', 'outcome_fitness.json');
  const strategyPath = path.join(strategyDir, 'default.json');
  mkDir(strategyDir);
  mkDir(runsDir);
  mkDir(autoReceiptsDir);
  mkDir(actReceiptsDir);

  writeJson(strategyPath, {
    version: '1.0',
    id: 'governor_quality_lock_gate_test',
    status: 'active',
    objective: { primary: 'test quality lock execute gate' },
    risk_policy: { allowed_risks: ['low'] },
    promotion_policy: {
      min_days: 1,
      min_attempted: 2,
      min_verified_rate: 0.5,
      min_success_criteria_receipts: 1,
      min_success_criteria_pass_rate: 0.5,
      min_objective_coverage: 0,
      max_objective_no_progress_rate: 1,
      max_reverted_rate: 1,
      max_stop_ratio: 1,
      min_shipped: 1
    },
    execution_policy: { mode: 'canary_execute' }
  });

  const date = '2026-02-21';
  writeJsonl(path.join(runsDir, `${date}.jsonl`), [
    { ts: `${date}T01:00:00.000Z`, type: 'autonomy_run', result: 'executed', outcome: 'shipped', execution_mode: 'canary_execute', objective_id: 'T1_objA' },
    { ts: `${date}T01:10:00.000Z`, type: 'autonomy_run', result: 'executed', outcome: 'no_change', execution_mode: 'canary_execute', objective_id: 'T1_objA' }
  ]);
  writeJsonl(path.join(autoReceiptsDir, `${date}.jsonl`), [
    { type: 'autonomy_action_receipt', verdict: 'pass', intent: { objective_id: 'T1_objA' }, verification: { success_criteria: { required: true, passed: true } }, receipt_contract: { attempted: true, verified: true } },
    { type: 'autonomy_action_receipt', verdict: 'pass', intent: { objective_id: 'T1_objA' }, verification: { success_criteria: { required: true, passed: true } }, receipt_contract: { attempted: true, verified: true } },
    { type: 'autonomy_action_receipt', verdict: 'pass', intent: { score_only: true, objective_id: 'T1_objA' }, verification: { success_criteria: { required: true, passed: true } }, receipt_contract: { attempted: true, verified: true } }
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
    AUTONOMY_MODE_GOVERNOR_PROMOTE_EXECUTE: '1',
    AUTONOMY_MODE_GOVERNOR_ALLOW_AUTO_ESCALATION: '1',
    AUTONOMY_MODE_GOVERNOR_REQUIRE_POLICY_ROOT: '0',
    AUTONOMY_MODE_GOVERNOR_REQUIRE_SPC: '0',
    AUTONOMY_MODE_GOVERNOR_CANARY_MIN_ATTEMPTED: '2',
    AUTONOMY_MODE_GOVERNOR_CANARY_MIN_VERIFIED_RATE: '0.5',
    AUTONOMY_MODE_GOVERNOR_CANARY_MAX_FAIL_RATE: '0.5',
    AUTONOMY_MODE_GOVERNOR_CANARY_MIN_SHIPPED: '1',
    AUTONOMY_MODE_GOVERNOR_REQUIRE_QUALITY_LOCK_FOR_EXECUTE: '1',
    OUTCOME_FITNESS_POLICY_PATH: outcomePolicyPath
  };

  let r = runScript(repoRoot, ['run', date, '--days=1'], env);
  assert.strictEqual(r.status, 0, `governor run without quality lock should pass: ${r.stderr}`);
  let out = parseJson(r.stdout);
  assert.strictEqual(out.result, 'no_change');
  assert.strictEqual(out.mode, 'canary_execute');
  assert.ok(Array.isArray(out.canary.failed_checks) && out.canary.failed_checks.includes('quality_lock_active'));
  let after = readJson(strategyPath);
  assert.strictEqual(after.execution_policy.mode, 'canary_execute');

  writeJson(outcomePolicyPath, {
    version: '1.0',
    ts: `${date}T02:00:00.000Z`,
    strategy_policy: {
      promotion_policy_audit: {
        quality_lock: {
          active: true,
          stable_window_streak: 3
        }
      }
    }
  });

  r = runScript(repoRoot, ['run', date, '--days=1'], env);
  assert.strictEqual(r.status, 0, `governor run with quality lock should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.result, 'mode_changed');
  assert.strictEqual(out.from_mode, 'canary_execute');
  assert.strictEqual(out.to_mode, 'execute');
  after = readJson(strategyPath);
  assert.strictEqual(after.execution_policy.mode, 'execute');

  console.log('strategy_mode_governor_quality_lock_gate.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`strategy_mode_governor_quality_lock_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

