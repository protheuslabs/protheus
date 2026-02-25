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

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'workflow', 'workflow_controller.js');
  const dateStr = '2026-02-25';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-controller-orchestron-'));

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
    id: 'shadow_strategy',
    name: 'Shadow Strategy',
    status: 'active',
    objective: { primary: 'Generate adaptive workflows with strict governance.' },
    risk_policy: { allowed_risks: ['low'], max_risk_per_action: 35 },
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
    summary: { score: 0.85, band: 'strong' },
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
    nursery: {
      min_safety_score: 0.55,
      max_regression_risk: 0.6,
      min_composite_score: 0.5,
      max_predicted_drift_delta: 0.03,
      min_predicted_yield_delta: -0.02,
      max_promotions_per_run: 4
    }
  });

  writeJson(registryPath, {
    version: '1.0',
    updated_at: null,
    generated_at: null,
    workflows: [
      {
        id: 'wf_existing',
        name: 'Existing External Intel',
        status: 'active',
        source: 'test',
        trigger: { proposal_type: 'external_intel', min_occurrences: 2 },
        steps: [
          { id: 'collect', type: 'command', command: 'node habits/scripts/external_eyes.js run --eye=test' },
          { id: 'verify', type: 'gate', command: 'node systems/autonomy/strategy_execute_guard.js run <date>' },
          { id: 'receipt', type: 'receipt', command: 'state/autonomy/receipts/<date>.jsonl' }
        ],
        metrics: { attempts: 10, shipped_rate: 0.6, failure_rate: 0.4 }
      }
    ]
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

  const shadowRun = spawnSync(process.execPath, [
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
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });

  assert.strictEqual(shadowRun.status, 0, shadowRun.stderr || 'shadow run should pass');
  const shadowOut = parsePayload(shadowRun.stdout);
  assert.ok(shadowOut && shadowOut.ok === true, 'shadow run output should be ok');
  assert.strictEqual(Number(shadowOut.baseline_drafts || 0), 0, 'baseline drafts should be 0 in this test');
  assert.ok(Number(shadowOut.orchestron_drafts || 0) >= 1, 'orchestron should emit drafts');
  assert.strictEqual(shadowOut.orchestron_apply_effective, false, 'shadow run should not include orchestron drafts for apply');
  assert.strictEqual(Number(shadowOut.applied || 0), 0, 'shadow run should apply nothing');

  const activeRun = spawnSync(process.execPath, [
    scriptPath,
    'run',
    dateStr,
    '--days=7',
    '--max=6',
    '--apply=1',
    '--orchestron=1',
    '--orchestron-apply=1',
    `--policy=${workflowPolicyPath}`,
    `--orchestron-policy=${orchestronPolicyPath}`
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });

  assert.strictEqual(activeRun.status, 0, activeRun.stderr || 'active run should pass');
  const activeOut = parsePayload(activeRun.stdout);
  assert.ok(activeOut && activeOut.ok === true, 'active run output should be ok');
  assert.strictEqual(activeOut.orchestron_apply_effective, true, 'orchestron apply should be effective');
  assert.ok(Number(activeOut.applied || 0) >= 1 || Number(activeOut.updated || 0) >= 1, 'expected orchestron draft to apply or update');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('workflow_controller_orchestron_shadow.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`workflow_controller_orchestron_shadow.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
