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
  const principlesPath = path.join(root, 'systems', 'strategy', 'strategy_principles.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-controller-'));
  const dateStr = '2026-02-25';
  const runsDir = path.join(tmp, 'state', 'autonomy', 'runs');
  const strategyDir = path.join(tmp, 'config', 'strategies');
  const principlesDir = path.join(tmp, 'state', 'adaptive', 'strategy', 'principles');
  const draftsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'drafts');
  const registryPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'registry.json');
  const policyPath = path.join(tmp, 'config', 'workflow_policy.json');

  writeJson(path.join(strategyDir, 'default.json'), {
    version: '1.0',
    id: 'workflow_strategy',
    name: 'Workflow Strategy',
    status: 'active',
    objective: { primary: 'Convert repeated successful patterns into reusable workflows.' },
    risk_policy: { allowed_risks: ['low'], max_risk_per_action: 45 },
    promotion_policy: { min_success_criteria_receipts: 1, min_success_criteria_pass_rate: 0.6 },
    budget_policy: { daily_runs_cap: 5, daily_token_cap: 6000, max_tokens_per_action: 1800 },
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
    { type: 'autonomy_run', result: 'executed', outcome: 'shipped', proposal_type: 'external_intel', objective_id: 'obj_x' },
    { type: 'autonomy_run', result: 'executed', outcome: 'no_change', proposal_type: 'external_intel', objective_id: 'obj_x' },
    { type: 'autonomy_run', result: 'policy_hold', outcome: 'no_change', proposal_type: 'unknown', objective_id: 'obj_y' }
  ]);

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    window_days: 7,
    min_pattern_occurrences: 2,
    min_shipped_rate: 0.3,
    max_drafts_per_run: 6,
    apply_threshold: 0.5,
    max_registry_workflows: 50
  });

  const env = {
    ...process.env,
    AUTONOMY_STRATEGY_DIR: strategyDir,
    STRATEGY_PRINCIPLES_OUT_DIR: principlesDir,
    WORKFLOW_GENERATOR_RUNS_DIR: runsDir,
    WORKFLOW_GENERATOR_OUT_DIR: draftsDir,
    WORKFLOW_GENERATOR_PRINCIPLES_PATH: path.join(principlesDir, 'latest.json'),
    WORKFLOW_REGISTRY_PATH: registryPath
  };

  const principlesRun = spawnSync(process.execPath, [principlesPath, 'run', dateStr], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(principlesRun.status, 0, principlesRun.stderr || 'strategy principles run should pass');

  const runProc = spawnSync(process.execPath, [scriptPath, 'run', dateStr, '--days=7', '--max=6', '--apply=1', `--policy=${policyPath}`], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(runProc.status, 0, runProc.stderr || 'workflow controller run should pass');
  const runOut = parsePayload(runProc.stdout);
  assert.ok(runOut && runOut.ok === true, 'run output should be ok');
  assert.ok(Number(runOut.drafts || 0) >= 1, 'expected at least one workflow draft');
  assert.ok(Number(runOut.applied || 0) >= 1, 'expected at least one applied workflow');

  assert.ok(fs.existsSync(registryPath), 'workflow registry should be written');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.ok(Array.isArray(registry.workflows), 'registry workflows should exist');
  assert.ok(registry.workflows.some((row) => String(row.status || '') === 'active'), 'active workflow should exist');

  const listProc = spawnSync(process.execPath, [scriptPath, 'list', '--status=active', '--limit=10'], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(listProc.status, 0, listProc.stderr || 'list should pass');
  const listOut = parsePayload(listProc.stdout);
  assert.ok(listOut && listOut.ok === true, 'list output should be ok');
  assert.ok(Number(listOut.count || 0) >= 1, 'active list should include workflows');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('workflow_controller.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`workflow_controller.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
