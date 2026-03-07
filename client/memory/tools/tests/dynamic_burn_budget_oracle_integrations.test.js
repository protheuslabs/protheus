#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OPT_SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'optimization_aperture_controller.js');
const CAPITAL_SCRIPT = path.join(ROOT, 'systems', 'budget', 'capital_allocation_organ.js');
const GSI_SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'gated_self_improvement_loop.js');
const STRATEGY_SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'strategy_mode.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(script, args, env) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burn-oracle-integrations-'));
  const oracleLatestPath = path.join(tmp, 'oracle_latest.json');
  writeJson(oracleLatestPath, {
    ok: true,
    ts: new Date().toISOString(),
    projection: {
      pressure: 'critical',
      projected_runway_days_regime: 1.2,
      projected_runway_days: 1.2,
      projected_days_to_reset: 2.1,
      providers_available: 2,
      reason_codes: ['projection_pressure_critical']
    },
    decisions: {
      capital_allocation_hold: true,
      self_improvement_hold: true,
      strategy_mode_recommendation: 'score_only'
    }
  });

  // optimization aperture should default to oracle pressure when no explicit budget-pressure is supplied.
  let proc = run(OPT_SCRIPT, ['run', '--lane=autonomy', '--risk=medium', '--impact=medium'], {
    OPTIMIZATION_APERTURE_BURN_ORACLE_LATEST_PATH: oracleLatestPath,
    OPTIMIZATION_APERTURE_STATE_DIR: path.join(tmp, 'aperture_state')
  });
  assert.strictEqual(proc.status, 0, proc.stderr || 'optimization aperture run should pass');
  let out = parseJson(proc.stdout);
  assert.ok(out && out.ok === true, 'optimization payload should be ok');
  assert.strictEqual(String(out.decision && out.decision.inputs && out.decision.inputs.budget_pressure || ''), 'critical', 'aperture should consume critical oracle pressure');
  assert.strictEqual(String(out.decision && out.decision.inputs && out.decision.inputs.budget_pressure_source || ''), 'burn_oracle', 'aperture should mark burn_oracle source');

  // capital allocation should block allocations when oracle requests hold.
  const capitalPolicyPath = path.join(tmp, 'capital_policy.json');
  writeJson(capitalPolicyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: false,
    min_simulation_score: 0.5,
    min_risk_adjusted_return: 0,
    buckets: {
      compute: { max_share: 0.7, drawdown_stop_pct: 0.6 },
      tools: { max_share: 0.2, drawdown_stop_pct: 0.5 }
    },
    state_path: path.join(tmp, 'capital_state.json'),
    latest_path: path.join(tmp, 'capital_latest.json'),
    receipts_path: path.join(tmp, 'capital_receipts.jsonl')
  });
  let env = {
    CAPITAL_ALLOCATION_POLICY_PATH: capitalPolicyPath,
    CAPITAL_ALLOCATION_BURN_ORACLE_LATEST_PATH: oracleLatestPath
  };
  proc = run(CAPITAL_SCRIPT, ['seed', '--balance=1000'], env);
  assert.strictEqual(proc.status, 0, proc.stderr || 'capital seed should pass');
  proc = run(CAPITAL_SCRIPT, ['simulate', '--bucket=compute', '--amount=100', '--expected-return=0.8', '--risk-score=0.1'], env);
  assert.strictEqual(proc.status, 0, proc.stderr || 'capital simulate should pass');
  out = parseJson(proc.stdout);
  const simId = out && out.simulation && out.simulation.simulation_id;
  assert.ok(simId, 'simulation id required');
  proc = run(CAPITAL_SCRIPT, ['allocate', '--bucket=compute', '--amount=50', `--simulation-id=${simId}`], env);
  assert.strictEqual(proc.status, 1, 'capital allocation should be blocked by budget oracle');
  out = parseJson(proc.stdout);
  assert.strictEqual(String(out && out.error || ''), 'budget_oracle_hold', 'capital block reason should be budget_oracle_hold');

  // gated self improvement should hold expensive run phase when oracle says hold.
  const gsiPolicyPath = path.join(tmp, 'gsi_policy.json');
  writeJson(gsiPolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: false,
    require_objective_id: true,
    auto_rollback_on_regression: true,
    simulation_days: 30,
    rollout_stages: ['shadow', 'canary', 'live'],
    gates: {
      max_effective_drift_rate: 0.04,
      min_effective_yield_rate: 0.6,
      max_effective_safety_stop_rate: 0.01,
      max_red_critical_fail_cases: 0,
      max_red_fail_rate: 0.25
    },
    paths: {
      state_path: path.join(tmp, 'gsi_state.json'),
      receipts_path: path.join(tmp, 'gsi_receipts.jsonl'),
      latest_path: path.join(tmp, 'gsi_latest.json')
    }
  });
  env = {
    GATED_SELF_IMPROVEMENT_POLICY_PATH: gsiPolicyPath,
    GATED_SELF_IMPROVEMENT_BURN_ORACLE_LATEST_PATH: oracleLatestPath
  };
  proc = run(GSI_SCRIPT, ['propose', '--objective-id=x', '--target-path=client/systems/autonomy/x.ts'], env);
  assert.strictEqual(proc.status, 0, proc.stderr || 'gsi propose should pass');
  out = parseJson(proc.stdout);
  const proposalId = out && out.proposal && out.proposal.proposal_id;
  assert.ok(proposalId, 'proposal id required');
  proc = run(GSI_SCRIPT, ['run', `--proposal-id=${proposalId}`, '--mock-sandbox=1'], env);
  assert.strictEqual(proc.status, 1, 'gsi run should be blocked by budget oracle');
  out = parseJson(proc.stdout);
  assert.strictEqual(String(out && out.error || ''), 'budget_oracle_hold', 'gsi block reason should be budget_oracle_hold');

  // strategy mode should reject execute escalation when oracle pressure is high/critical.
  const strategyDir = path.join(tmp, 'strategies');
  const strategyPath = path.join(strategyDir, 'default.json');
  writeJson(strategyPath, {
    version: '1.0',
    id: 'oracle_strategy_test',
    status: 'active',
    objective: { primary: 'budget-aware execution' },
    risk_policy: { allowed_risks: ['low'] },
    execution_policy: { mode: 'score_only' }
  });
  env = {
    AUTONOMY_STRATEGY_DIR: strategyDir,
    AUTONOMY_STRATEGY_MODE_LOG: path.join(tmp, 'strategy_mode_changes.jsonl'),
    AUTONOMY_STRATEGY_MODE_REQUIRE_POLICY_ROOT: '0',
    AUTONOMY_STRATEGY_MODE_REQUIRE_SPC: '0',
    AUTONOMY_STRATEGY_BURN_ORACLE_LATEST_PATH: oracleLatestPath
  };
  proc = run(STRATEGY_SCRIPT, [
    'set',
    '--mode=execute',
    '--approval-note=budget aware escalation request',
    '--approver-id=owner',
    '--second-approver-id=operator',
    '--second-approval-note=second approval for escalation'
  ], env);
  assert.strictEqual(proc.status, 1, 'strategy execute escalation should be blocked by budget oracle');
  out = parseJson(proc.stdout);
  assert.strictEqual(String(out && out.error || ''), 'budget_oracle_hold', 'strategy block reason should be budget_oracle_hold');

  console.log('dynamic_burn_budget_oracle_integrations.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`dynamic_burn_budget_oracle_integrations.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
