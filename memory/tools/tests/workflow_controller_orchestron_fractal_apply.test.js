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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-controller-orchestron-fractal-'));

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
    id: 'fractal_apply_strategy',
    name: 'Fractal Apply Strategy',
    status: 'active',
    objective: { primary: 'Generate recursive adaptive workflows for external intake pressure.' },
    risk_policy: { allowed_risks: ['low', 'medium'], max_risk_per_action: 40 },
    execution_policy: { mode: 'execute' },
    promotion_policy: { min_success_criteria_receipts: 1, min_success_criteria_pass_rate: 0.5 },
    budget_policy: { daily_runs_cap: 8, daily_token_cap: 9000, max_tokens_per_action: 2200 },
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
    { type: 'autonomy_run', result: 'executed', outcome: 'no_change', proposal_type: 'external_intel', objective_id: 'obj_x' },
    { type: 'autonomy_run', result: 'executed', outcome: 'no_change', proposal_type: 'external_intel', objective_id: 'obj_x' },
    { type: 'autonomy_run', result: 'executed', outcome: 'no_change', proposal_type: 'external_intel', objective_id: 'obj_x' },
    { type: 'autonomy_run', result: 'policy_hold', outcome: 'no_change', proposal_type: 'external_intel', objective_id: 'obj_x' },
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
    min_shipped_rate: 0.01,
    max_drafts_per_run: 10,
    apply_threshold: 0.15,
    max_registry_workflows: 100
  });

  writeJson(orchestronPolicyPath, {
    version: '1.0',
    enabled: true,
    shadow_only: false,
    default_window_days: 7,
    min_pattern_occurrences: 2,
    min_candidates: 3,
    max_candidates: 8,
    max_promotions_per_run: 6,
    min_principle_score: 0.4,
    creative_llm: {
      enabled: false
    },
    fractal: {
      enabled: true,
      max_depth: 3,
      max_children_per_workflow: 3,
      min_attempts_for_split: 3,
      min_failure_rate_for_split: 0.3
    },
    runtime_evolution: {
      enabled: true,
      max_candidates: 3,
      failure_pressure_min: 0.3,
      no_change_pressure_min: 0.3
    },
    telemetry: {
      emit_birth_events: false
    },
    nursery: {
      min_safety_score: 0,
      max_regression_risk: 1,
      min_composite_score: 0,
      max_predicted_drift_delta: 1,
      min_predicted_yield_delta: -1,
      min_trit_alignment: -1,
      max_candidate_red_team_pressure: 1,
      max_promotions_per_run: 6
    }
  });

  writeJson(registryPath, {
    version: '1.0',
    updated_at: null,
    generated_at: null,
    workflows: [
      {
        id: 'wf_parent_base',
        name: 'External Intel Baseline',
        status: 'active',
        source: 'test',
        trigger: { proposal_type: 'external_intel', min_occurrences: 2 },
        steps: [
          { id: 'collect', type: 'command', command: 'node habits/scripts/external_eyes.js run --eye=test' },
          { id: 'verify', type: 'gate', command: 'node systems/autonomy/strategy_execute_guard.js run <date>' },
          { id: 'receipt', type: 'receipt', command: 'state/autonomy/receipts/<date>.jsonl' }
        ],
        metrics: { attempts: 12, shipped_rate: 0.2, failure_rate: 0.8 }
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

  const runProc = spawnSync(process.execPath, [
    scriptPath,
    'run',
    dateStr,
    '--days=7',
    '--max=8',
    '--apply=1',
    '--orchestron=1',
    '--orchestron-apply=1',
    '--orchestron-auto=0',
    `--policy=${workflowPolicyPath}`,
    `--orchestron-policy=${orchestronPolicyPath}`
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });

  assert.strictEqual(runProc.status, 0, runProc.stderr || 'controller run should pass');
  const out = parsePayload(runProc.stdout);
  assert.ok(out && out.ok === true, 'controller output should be ok');
  assert.strictEqual(out.orchestron_apply_effective, true, 'orchestron apply should be effective');

  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const rows = Array.isArray(registry && registry.workflows) ? registry.workflows : [];
  assert.ok(rows.length >= 2, 'expected registry growth');
  const childRows = rows.filter((row) => row && row.parent_workflow_id);
  assert.ok(childRows.length >= 1, 'expected at least one applied fractal child workflow');
  assert.ok(childRows.some((row) => Number(row.fractal_depth || 0) >= 1), 'child workflow should carry fractal depth');
  assert.ok(childRows.some((row) => row && row.lineage && row.lineage.state === 'child_active'), 'child workflow should carry child lineage state');
  assert.ok(childRows.some((row) => row && row.fractal_state === 'child_active'), 'child workflow should carry fractal_state metadata');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('workflow_controller_orchestron_fractal_apply.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`workflow_controller_orchestron_fractal_apply.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
