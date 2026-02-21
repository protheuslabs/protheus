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
  const tmpRoot = path.join(__dirname, 'temp_strategy_mode_governor_spc_gate');
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
    id: 'governor_spc_test',
    status: 'active',
    objective: { primary: 'test spc hold' },
    risk_policy: { allowed_risks: ['low'] },
    execution_policy: { mode: 'score_only' },
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
    }
  });

  const date = '2026-02-21';
  writeJsonl(path.join(runsDir, `${date}.jsonl`), [
    { ts: `${date}T01:00:00.000Z`, type: 'autonomy_run', result: 'executed', outcome: 'shipped', execution_mode: 'score_only' },
    { ts: `${date}T01:10:00.000Z`, type: 'autonomy_run', result: 'executed', outcome: 'no_change', execution_mode: 'score_only' },
    { ts: `${date}T01:20:00.000Z`, type: 'autonomy_run', result: 'score_only_preview', execution_mode: 'score_only' }
  ]);
  writeJsonl(path.join(autoReceiptsDir, `${date}.jsonl`), [
    {
      type: 'autonomy_action_receipt',
      verdict: 'pass',
      receipt_contract: { attempted: true, verified: true },
      verification: { success_criteria: { required: true, passed: true } }
    },
    {
      type: 'autonomy_action_receipt',
      verdict: 'pass',
      receipt_contract: { attempted: true, verified: true },
      verification: { success_criteria: { required: true, passed: true } }
    },
    {
      type: 'autonomy_action_receipt',
      verdict: 'pass',
      intent: { score_only: true },
      receipt_contract: { attempted: true, verified: true },
      verification: { success_criteria: { required: true, passed: true } }
    }
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
    AUTONOMY_MODE_GOVERNOR_MIN_ESCALATE_STREAK: '1',
    AUTONOMY_MODE_GOVERNOR_ALLOW_AUTO_ESCALATION: '1',
    AUTONOMY_MODE_GOVERNOR_REQUIRE_SPC: '1',
    AUTONOMY_SPC_MIN_ATTEMPTED: '100'
  };

  const r = runScript(repoRoot, ['run', date, '--days=1'], env);
  assert.strictEqual(r.status, 0, `governor spc gate run should pass: ${r.stderr}`);
  const out = parseJson(r.stdout);
  assert.strictEqual(out.result, 'no_change');
  assert.strictEqual(out.mode, 'score_only');
  assert.strictEqual(out.reason, 'spc_gate_failed');
  assert.ok(out.spc && out.spc.hold_escalation === true);

  console.log('strategy_mode_governor_spc_gate.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`strategy_mode_governor_spc_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
