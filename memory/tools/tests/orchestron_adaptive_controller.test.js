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
  const scriptPath = path.join(root, 'systems', 'workflow', 'orchestron', 'adaptive_controller.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestron-controller-'));
  const dateStr = '2026-02-25';

  const strategyDir = path.join(tmp, 'config', 'strategies');
  const runsDir = path.join(tmp, 'state', 'autonomy', 'runs');
  const principlesPath = path.join(tmp, 'state', 'adaptive', 'strategy', 'principles', 'latest.json');
  const registryPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'registry.json');
  const redTeamPath = path.join(tmp, 'state', 'security', 'red_team', 'runtime_state.json');
  const orchestronOutDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'orchestron');
  const birthEventsPath = path.join(orchestronOutDir, 'birth_events.jsonl');
  const orchestronPolicyPath = path.join(tmp, 'config', 'orchestron_policy.json');

  writeJson(path.join(strategyDir, 'default.json'), {
    version: '1.0',
    id: 'orchestron_strategy',
    name: 'Orchestron Strategy',
    status: 'active',
    objective: {
      primary: 'Build adaptive workflows that increase shipped outcomes while preserving safety.'
    },
    risk_policy: {
      allowed_risks: ['low', 'medium'],
      max_risk_per_action: 40
    },
    promotion_policy: {
      min_success_criteria_receipts: 1,
      min_success_criteria_pass_rate: 0.6
    },
    budget_policy: {
      daily_runs_cap: 8,
      daily_token_cap: 9000,
      max_tokens_per_action: 2200
    },
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
    { type: 'autonomy_run', result: 'executed', outcome: 'shipped', proposal_type: 'external_intel', objective_id: 'obj_ext' },
    { type: 'autonomy_run', result: 'executed', outcome: 'shipped', proposal_type: 'external_intel', objective_id: 'obj_ext' },
    { type: 'autonomy_run', result: 'executed', outcome: 'no_change', proposal_type: 'external_intel', objective_id: 'obj_ext' },
    { type: 'autonomy_run', result: 'executed', outcome: 'shipped', proposal_type: 'publish_pipeline', objective_id: 'obj_pub' },
    { type: 'autonomy_run', result: 'executed', outcome: 'no_change', proposal_type: 'publish_pipeline', objective_id: 'obj_pub' },
    { type: 'autonomy_run', result: 'policy_hold', outcome: 'no_change', proposal_type: 'publish_pipeline', objective_id: 'obj_pub' }
  ]);

  writeJson(principlesPath, {
    ok: true,
    type: 'strategy_principles',
    summary: {
      score: 0.8,
      band: 'strong'
    },
    principles: [
      { id: 'objective_clarity', pass: true },
      { id: 'risk_bounded', pass: true }
    ]
  });

  writeJson(registryPath, {
    version: '1.0',
    updated_at: null,
    generated_at: null,
    workflows: [
      {
        id: 'wf_active_a',
        name: 'External Intel Baseline',
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

  writeJson(redTeamPath, {
    ok: true,
    type: 'red_team_harness_run',
    summary: {
      selected_cases: 3,
      executed_cases: 3,
      pass_cases: 3,
      fail_cases: 0,
      critical_fail_cases: 0
    }
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
    creative_llm: {
      enabled: false
    },
    fractal: {
      enabled: true,
      max_depth: 3,
      max_children_per_workflow: 2,
      min_attempts_for_split: 3,
      min_failure_rate_for_split: 0.3
    },
    runtime_evolution: {
      enabled: true,
      max_candidates: 2,
      failure_pressure_min: 0.3,
      no_change_pressure_min: 0.3
    },
    telemetry: {
      emit_birth_events: true
    },
    adversarial_lane: {
      enabled: true,
      max_critical_failures_per_candidate: 0,
      max_non_critical_findings_per_candidate: 12,
      max_findings_per_candidate: 24,
      block_unresolved_placeholders: true,
      high_power_requires_preflight: true,
      high_power_requires_rollback: false,
      persist_replay_artifacts: true,
      unresolved_placeholder_allowlist: ['date', 'run_id', 'workflow_id', 'objective_id', 'eye_id', 'adapter']
    },
    nursery: {
      min_safety_score: 0.55,
      max_regression_risk: 0.6,
      min_composite_score: 0.5,
      max_predicted_drift_delta: 0.03,
      min_predicted_yield_delta: -0.02,
      min_trit_alignment: -1,
      max_candidate_red_team_pressure: 1,
      max_promotions_per_run: 4
    }
  });

  const env = {
    ...process.env,
    AUTONOMY_STRATEGY_DIR: strategyDir,
    ORCHESTRON_RUNS_DIR: runsDir,
    ORCHESTRON_PRINCIPLES_PATH: principlesPath,
    ORCHESTRON_REGISTRY_PATH: registryPath,
    ORCHESTRON_RED_TEAM_RUNTIME_PATH: redTeamPath,
    ORCHESTRON_OUT_DIR: orchestronOutDir,
    ORCHESTRON_BIRTH_EVENTS_PATH: birthEventsPath,
    ORCHESTRON_POLICY_PATH: orchestronPolicyPath
  };

  const runProc = spawnSync(process.execPath, [
    scriptPath,
    'run',
    dateStr,
    '--days=7',
    '--max-candidates=6',
    '--intent=Build adaptive workflows fast while preserving safety and budget.',
    `--policy=${orchestronPolicyPath}`
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(runProc.status, 0, runProc.stderr || 'orchestron run should pass');
  const runOut = parsePayload(runProc.stdout);
  assert.ok(runOut && runOut.ok === true, 'run output should be ok');
  assert.ok(Number(runOut.candidates || 0) >= 3, 'expected at least 3 candidates');
  assert.ok(Number(runOut.drafts || 0) >= 1, 'expected at least one draft');

  const outputPath = path.join(orchestronOutDir, `${dateStr}.json`);
  assert.ok(fs.existsSync(outputPath), 'orchestron output should be persisted');
  const payload = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.ok(Array.isArray(payload.candidates), 'payload candidates should be present');
  assert.ok(payload.candidates.some((row) => row && row.mutation && row.mutation.parent_workflow_id === 'wf_active_a'), 'expected mutation candidate from active workflow');
  assert.ok(payload.candidates.some((row) => Array.isArray(row && row.children) && row.children.length >= 1), 'expected fractal child workflows');
  assert.ok(payload.adversarial && Number(payload.adversarial.probes_run || 0) >= Number(payload.candidates.length || 0), 'adversarial probes should run per candidate');
  assert.ok(Array.isArray(payload.adversarial.results), 'adversarial results should be present');
  assert.ok(Array.isArray(payload.scorecards) && payload.scorecards.length >= 1, 'scorecards should exist');
  assert.ok(payload.scorecards.every((row) => Number.isFinite(Number(row.adversarial_critical_failures))), 'scorecards should include adversarial critical field');
  assert.ok(Array.isArray(payload.drafts) && payload.drafts.length >= 1, 'drafts should exist');
  assert.ok(fs.existsSync(birthEventsPath), 'birth events should be emitted');
  const birthRows = fs.readFileSync(birthEventsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const stages = new Set(birthRows.map((row) => String(row.stage || '')));
  assert.ok(stages.has('candidates_generated'), 'birth events should include candidates_generated');
  assert.ok(stages.has('candidate_indexed'), 'birth events should include candidate_indexed');
  assert.ok(stages.has('adversarial_scored'), 'birth events should include adversarial_scored');
  assert.ok(stages.has('nursery_scored'), 'birth events should include nursery_scored');
  if (Array.isArray(payload.passing) && payload.passing.length > 0) {
    assert.ok(stages.has('graft_planned'), 'birth events should include graft_planned when passing candidates exist');
  }

  const statusProc = spawnSync(process.execPath, [scriptPath, 'status', 'latest'], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(statusProc.status, 0, statusProc.stderr || 'status should pass');
  const statusOut = parsePayload(statusProc.stdout);
  assert.ok(statusOut && statusOut.ok === true, 'status output should be ok');
  assert.strictEqual(String(statusOut.date || ''), dateStr, 'status should report latest date');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('orchestron_adaptive_controller.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`orchestron_adaptive_controller.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
