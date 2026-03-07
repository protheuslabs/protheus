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
  const tmpRoot = path.join(__dirname, 'temp_strategy_mode_governor_hysteresis');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });

  const strategyDir = path.join(tmpRoot, 'strategies');
  const runsDir = path.join(tmpRoot, 'state', 'autonomy', 'runs');
  const autoReceiptsDir = path.join(tmpRoot, 'state', 'autonomy', 'receipts');
  const actReceiptsDir = path.join(tmpRoot, 'state', 'actuation', 'receipts');
  const proposalsDir = path.join(tmpRoot, 'state', 'sensory', 'proposals');
  mkDir(strategyDir);
  mkDir(runsDir);
  mkDir(autoReceiptsDir);
  mkDir(actReceiptsDir);
  mkDir(proposalsDir);

  writeJson(path.join(strategyDir, 'default.json'), {
    version: '1.0',
    id: 'governor_hysteresis_test',
    status: 'active',
    objective: { primary: 'test hysteresis' },
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
    execution_policy: { mode: 'score_only' }
  });

  const date = '2026-02-21';
  writeJsonl(path.join(runsDir, `${date}.jsonl`), [
    { ts: `${date}T01:00:00.000Z`, type: 'autonomy_run', result: 'executed', outcome: 'shipped', execution_mode: 'score_only', objective_id: 'T1_objA' },
    { ts: `${date}T01:10:00.000Z`, type: 'autonomy_run', result: 'executed', outcome: 'no_change', execution_mode: 'score_only', objective_id: 'T1_objA' }
  ]);
  writeJsonl(path.join(autoReceiptsDir, `${date}.jsonl`), [
    { type: 'autonomy_action_receipt', verdict: 'pass', intent: { objective_id: 'T1_objA' }, verification: { success_criteria: { required: true, passed: true } }, receipt_contract: { attempted: true, verified: true } },
    { type: 'autonomy_action_receipt', verdict: 'pass', intent: { objective_id: 'T1_objA' }, verification: { success_criteria: { required: true, passed: true } }, receipt_contract: { attempted: true, verified: true } },
    { type: 'autonomy_action_receipt', verdict: 'pass', intent: { score_only: true, objective_id: 'T1_objA' }, verification: { success_criteria: { required: true, passed: true } }, receipt_contract: { attempted: true, verified: true } }
  ]);
  writeJsonl(path.join(actReceiptsDir, `${date}.jsonl`), []);
  writeJson(path.join(proposalsDir, `${date}.json`), [
    { id: 'P1', title: 'admitted', meta: { admission_preview: { eligible: true } } }
  ]);

  const env = {
    ...process.env,
    AUTONOMY_STRATEGY_DIR: strategyDir,
    AUTONOMY_SUMMARY_RUNS_DIR: runsDir,
    AUTONOMY_SUMMARY_RECEIPTS_DIR: autoReceiptsDir,
    ACTUATION_SUMMARY_RECEIPTS_DIR: actReceiptsDir,
    AUTONOMY_SPC_PROPOSALS_DIR: proposalsDir,
    AUTONOMY_STRATEGY_MODE_GOVERNOR_STATE: path.join(tmpRoot, 'strategy_mode_governor_state.json'),
    AUTONOMY_MODE_GOVERNOR_MIN_HOURS_BETWEEN_CHANGES: '0',
    AUTONOMY_MODE_GOVERNOR_ALLOW_AUTO_ESCALATION: '1',
    AUTONOMY_MODE_GOVERNOR_REQUIRE_POLICY_ROOT: '0',
    AUTONOMY_MODE_GOVERNOR_MIN_ESCALATE_STREAK: '2',
    AUTONOMY_MODE_GOVERNOR_REQUIRE_SPC: '0'
  };

  let r = runScript(repoRoot, ['run', date, '--days=1'], env);
  assert.strictEqual(r.status, 0, `first governor run failed: ${r.stderr}`);
  let out = parseJson(r.stdout);
  assert.strictEqual(out.result, 'no_change');
  assert.strictEqual(out.reason, 'hysteresis_wait_escalate_streak');

  r = runScript(repoRoot, ['run', date, '--days=1'], env);
  assert.strictEqual(r.status, 0, `second governor run failed: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.result, 'mode_changed');
  assert.strictEqual(out.to_mode, 'canary_execute');

  console.log('strategy_mode_governor_hysteresis.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`strategy_mode_governor_hysteresis.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
