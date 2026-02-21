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
  const text = (rows || []).map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(filePath, text + (text ? '\n' : ''), 'utf8');
}

function runScript(repoRoot, args, env) {
  const script = path.join(repoRoot, 'systems', 'autonomy', 'strategy_mode.js');
  return spawnSync('node', [script, ...args], { cwd: repoRoot, encoding: 'utf8', env });
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}'));
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_strategy_mode_spc_gate');
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
    id: 'mode_spc_test',
    status: 'active',
    objective: { primary: 'test objective' },
    risk_policy: { allowed_risks: ['low'] },
    execution_policy: { mode: 'score_only' },
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
    }
  });

  const date = '2026-02-21';
  writeJsonl(path.join(runsDir, `${date}.jsonl`), [
    { ts: `${date}T01:00:00.000Z`, type: 'autonomy_run', result: 'executed', outcome: 'shipped', objective_id: 'T1_objA' },
    { ts: `${date}T01:10:00.000Z`, type: 'autonomy_run', result: 'executed', outcome: 'no_change', objective_id: 'T1_objA' }
  ]);
  writeJsonl(path.join(autoReceiptsDir, `${date}.jsonl`), [
    { type: 'autonomy_action_receipt', verdict: 'pass', intent: { objective_id: 'T1_objA' }, verification: { success_criteria: { required: true, passed: true } }, receipt_contract: { attempted: true, verified: true } },
    { type: 'autonomy_action_receipt', verdict: 'pass', intent: { objective_id: 'T1_objA' }, verification: { success_criteria: { required: true, passed: true } }, receipt_contract: { attempted: true, verified: true } }
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
    AUTONOMY_STRATEGY_MODE_REQUIRE_SPC: '1',
    AUTONOMY_SPC_MIN_ATTEMPTED: '500',
    AUTONOMY_STRATEGY_MODE_REQUIRE_POLICY_ROOT: '0'
  };

  const r = runScript(repoRoot, [
    'set',
    '--mode=canary_execute',
    '--approval-note=approved for canary execute mode',
    '--approver-id=owner',
    '--second-approver-id=operator',
    '--second-approval-note=second approval for canary execute mode',
    `--date=${date}`,
    '--days=1'
  ], env);
  assert.notStrictEqual(r.status, 0, 'spc gate should block strategy mode set');
  const out = parseJson(r.stdout);
  assert.strictEqual(out.error, 'spc_gate_failed');
  assert.ok(out.spc && out.spc.hold_escalation === true);

  console.log('strategy_mode_spc_gate.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`strategy_mode_spc_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
