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
  const body = (rows || []).map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function parsePayload(stdout) {
  const raw = String(stdout || '').trim();
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runController(scriptPath, root, env, dateStr, workflowPolicyPath, orchestronPolicyPath, autoApplyArg) {
  const args = [
    scriptPath,
    'run',
    dateStr,
    '--days=7',
    '--max=6',
    '--apply=1',
    '--orchestron=1',
    '--orchestron-apply=0',
    `--policy=${workflowPolicyPath}`,
    `--orchestron-policy=${orchestronPolicyPath}`
  ];
  if (autoApplyArg != null) args.push(`--orchestron-auto=${autoApplyArg ? '1' : '0'}`);
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env
  });
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'workflow', 'workflow_controller.js');
  const dateStr = '2026-02-25';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-controller-orchestron-phase0-'));

  const strategyDir = path.join(tmp, 'config', 'strategies');
  const runsDir = path.join(tmp, 'state', 'autonomy', 'runs');
  const principlesPath = path.join(tmp, 'state', 'adaptive', 'strategy', 'principles', 'latest.json');
  const registryPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'registry.json');
  const draftsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'drafts');
  const orchOutDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'orchestron');
  const redTeamPath = path.join(tmp, 'state', 'security', 'red_team', 'runtime_state.json');
  const workflowPolicyPath = path.join(tmp, 'config', 'workflow_policy.json');
  const orchestronPolicyPath = path.join(tmp, 'config', 'orchestron_policy.json');

  writeJson(path.join(strategyDir, 'default.json'), {
    version: '1.0',
    id: 'phase0_shadow_strategy',
    name: 'Phase0 Shadow Strategy',
    status: 'active',
    objective: { primary: 'Validate Orchestron phase-0 shadow-only gates.' },
    risk_policy: { allowed_risks: ['low'], max_risk_per_action: 35 },
    execution_policy: { mode: 'execute' },
    promotion_policy: { min_success_criteria_receipts: 1, min_success_criteria_pass_rate: 0.6 },
    budget_policy: { daily_runs_cap: 8, daily_token_cap: 9000, max_tokens_per_action: 1800 },
    ranking_weights: {
      composite: 0.34,
      actionability: 0.2,
      directive_fit: 0.16,
      signal_quality: 0.15,
      expected_value: 0.1,
      risk_penalty: 0.05
    }
  });

  writeJsonl(path.join(runsDir, `${dateStr}.jsonl`), [
    { type: 'autonomy_run', result: 'executed', outcome: 'shipped', proposal_type: 'external_intel', objective_id: 'obj_x' },
    { type: 'autonomy_run', result: 'executed', outcome: 'shipped', proposal_type: 'external_intel', objective_id: 'obj_x' },
    { type: 'autonomy_run', result: 'executed', outcome: 'no_change', proposal_type: 'external_intel', objective_id: 'obj_x' }
  ]);

  writeJson(principlesPath, {
    ok: true,
    type: 'strategy_principles',
    summary: { score: 0.9, band: 'strong' },
    principles: [{ id: 'objective_clarity', pass: true }]
  });

  writeJson(redTeamPath, {
    ok: true,
    type: 'red_team_harness_run',
    summary: { critical_fail_cases: 0 }
  });

  writeJson(workflowPolicyPath, {
    version: '1.0',
    enabled: true,
    window_days: 7,
    min_pattern_occurrences: 2,
    min_shipped_rate: 0.99,
    max_drafts_per_run: 6,
    apply_threshold: 0.1,
    max_registry_workflows: 50
  });

  writeJson(orchestronPolicyPath, {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    default_window_days: 7,
    min_pattern_occurrences: 2,
    min_candidates: 3,
    max_candidates: 6,
    max_promotions_per_run: 4,
    min_principle_score: 0.6,
    auto_apply: {
      enabled: false,
      min_promotable_drafts: 1,
      min_principle_score: 0.3,
      min_composite_score: 0,
      min_avg_trit_alignment: -1,
      min_min_trit_alignment: -1,
      max_predicted_drift_delta: 1,
      min_predicted_yield_delta: -1,
      max_red_team_critical_fail_cases: 0,
      require_shadow_off: true
    },
    nursery: {
      min_safety_score: 0,
      max_regression_risk: 1,
      min_composite_score: 0,
      max_predicted_drift_delta: 1,
      min_predicted_yield_delta: -1,
      min_trit_alignment: -1,
      max_candidate_red_team_pressure: 1,
      max_promotions_per_run: 4
    }
  });

  writeJson(registryPath, {
    version: '1.0',
    updated_at: null,
    generated_at: null,
    workflows: []
  });

  const env = {
    ...process.env,
    AUTONOMY_STRATEGY_DIR: strategyDir,
    STRATEGY_PRINCIPLES_OUT_DIR: path.dirname(principlesPath),
    WORKFLOW_GENERATOR_RUNS_DIR: runsDir,
    WORKFLOW_GENERATOR_OUT_DIR: draftsDir,
    WORKFLOW_GENERATOR_PRINCIPLES_PATH: principlesPath,
    WORKFLOW_REGISTRY_PATH: registryPath,
    ORCHESTRON_RUNS_DIR: runsDir,
    ORCHESTRON_PRINCIPLES_PATH: principlesPath,
    ORCHESTRON_REGISTRY_PATH: registryPath,
    ORCHESTRON_RED_TEAM_RUNTIME_PATH: redTeamPath,
    ORCHESTRON_OUT_DIR: orchOutDir
  };

  const defaultRun = runController(
    scriptPath,
    root,
    env,
    dateStr,
    workflowPolicyPath,
    orchestronPolicyPath,
    null
  );
  assert.strictEqual(defaultRun.status, 0, defaultRun.stderr || 'phase0 default run should pass');
  const defaultOut = parsePayload(defaultRun.stdout);
  assert.ok(defaultOut && defaultOut.ok === true, 'default phase0 output should be ok');
  assert.strictEqual(defaultOut.orchestron_shadow_only, true, 'phase0 policy must stay shadow-only');
  assert.strictEqual(defaultOut.orchestron_auto_requested, false, 'auto apply should not self-enable by runtime mode');
  assert.strictEqual(defaultOut.orchestron_auto_enabled, false, 'auto apply should remain disabled');
  assert.strictEqual(defaultOut.orchestron_apply_effective, false, 'phase0 should not activate apply lane');
  assert.strictEqual(Number(defaultOut.applied || 0), 0, 'phase0 default run should not apply workflows');

  const forcedAutoRun = runController(
    scriptPath,
    root,
    env,
    dateStr,
    workflowPolicyPath,
    orchestronPolicyPath,
    true
  );
  assert.strictEqual(forcedAutoRun.status, 0, forcedAutoRun.stderr || 'phase0 forced auto run should pass');
  const forcedOut = parsePayload(forcedAutoRun.stdout);
  assert.ok(forcedOut && forcedOut.ok === true, 'forced phase0 output should be ok');
  assert.strictEqual(forcedOut.orchestron_auto_requested, true, 'forced run should report requested auto mode');
  assert.strictEqual(forcedOut.orchestron_auto_enabled, true, 'forced run should evaluate auto gate');
  assert.strictEqual(forcedOut.orchestron_auto_pass, false, 'phase0 shadow-only policy must block auto gate');
  assert.ok(
    Array.isArray(forcedOut.orchestron_auto_reasons)
      && forcedOut.orchestron_auto_reasons.includes('shadow_only_policy_on'),
    'phase0 forced auto run should include shadow-only deny reason'
  );
  assert.strictEqual(forcedOut.orchestron_apply_effective, false, 'phase0 forced auto run should still block apply');
  assert.strictEqual(Number(forcedOut.applied || 0), 0, 'phase0 forced auto run should not apply workflows');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('workflow_controller_orchestron_phase0_shadow.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`workflow_controller_orchestron_phase0_shadow.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
