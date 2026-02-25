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

function runController(scriptPath, root, env, dateStr, workflowPolicyPath, orchestronPolicyPath, opts = {}) {
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
  if (opts.autoArg != null) args.push(`--orchestron-auto=${opts.autoArg ? '1' : '0'}`);
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-controller-orchestron-auto-'));

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
    id: 'auto_strategy',
    name: 'Auto Apply Strategy',
    status: 'active',
    objective: { primary: 'Generate adaptive workflows with bounded dynamic promotion.' },
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
    { type: 'autonomy_run', result: 'executed', outcome: 'no_change', proposal_type: 'external_intel', objective_id: 'obj_x' },
    { type: 'autonomy_run', result: 'executed', outcome: 'no_change', proposal_type: 'external_intel', objective_id: 'obj_x' }
  ]);

  writeJson(principlesPath, {
    ok: true,
    type: 'strategy_principles',
    summary: { score: 0.9, band: 'strong' },
    principles: [{ id: 'objective_clarity', pass: true }]
  });

  writeJson(workflowPolicyPath, {
    version: '1.0',
    enabled: true,
    window_days: 7,
    min_pattern_occurrences: 2,
    min_shipped_rate: 0.95,
    max_drafts_per_run: 6,
    apply_threshold: 0.5,
    max_registry_workflows: 50
  });

  writeJson(orchestronPolicyPath, {
    version: '1.0',
    enabled: true,
    shadow_only: false,
    default_window_days: 7,
    min_pattern_occurrences: 2,
    min_candidates: 3,
    max_candidates: 6,
    max_promotions_per_run: 4,
    min_principle_score: 0.6,
    auto_apply: {
      enabled: true,
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

  // Pass case: no red-team critical failures.
  writeJson(redTeamPath, {
    ok: true,
    type: 'red_team_harness_run',
    summary: { critical_fail_cases: 0 }
  });
  const passRun = runController(scriptPath, root, env, dateStr, workflowPolicyPath, orchestronPolicyPath);
  assert.strictEqual(passRun.status, 0, passRun.stderr || 'auto pass run should pass');
  const passOut = parsePayload(passRun.stdout);
  assert.ok(passOut && passOut.ok === true, 'auto pass output should be ok');
  assert.strictEqual(passOut.full_automation_mode, true, 'full automation mode should be true');
  assert.strictEqual(passOut.strategy_execution_mode, 'execute', 'strategy mode should be execute');
  assert.strictEqual(passOut.orchestron_auto_requested, true, 'auto should default on in full automation mode');
  assert.strictEqual(passOut.orchestron_auto_enabled, true, 'auto apply should be enabled');
  assert.strictEqual(passOut.orchestron_auto_pass, true, 'auto gate should pass');
  assert.strictEqual(passOut.orchestron_apply_effective, true, 'auto pass should activate apply');
  assert.ok(Number(passOut.applied || 0) >= 1 || Number(passOut.updated || 0) >= 1, 'auto pass should apply or update at least one workflow');

  // Fail case: red-team critical failure blocks auto apply.
  writeJson(redTeamPath, {
    ok: true,
    type: 'red_team_harness_run',
    summary: { critical_fail_cases: 1 }
  });
  const failRun = runController(scriptPath, root, env, dateStr, workflowPolicyPath, orchestronPolicyPath);
  assert.strictEqual(failRun.status, 0, failRun.stderr || 'auto fail run should pass');
  const failOut = parsePayload(failRun.stdout);
  assert.ok(failOut && failOut.ok === true, 'auto fail output should be ok');
  assert.strictEqual(failOut.orchestron_auto_enabled, true, 'auto apply should remain enabled');
  assert.strictEqual(failOut.orchestron_auto_pass, false, 'auto gate should fail when red-team critical > max');
  assert.strictEqual(failOut.orchestron_apply_effective, false, 'auto fail should not activate apply');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('workflow_controller_orchestron_auto_apply.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`workflow_controller_orchestron_auto_apply.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
