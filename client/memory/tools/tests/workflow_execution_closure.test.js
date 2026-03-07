#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function parseJsonOutput(proc) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, 'expected stdout payload');
  try {
    return JSON.parse(raw);
  } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  throw new Error('unable to parse json output');
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'ops', 'workflow_execution_closure.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-exec-closure-'));
  const proposalsDir = path.join(tmpRoot, 'state', 'sensory', 'proposals');
  const workflowRunsDir = path.join(tmpRoot, 'state', 'adaptive', 'workflows', 'executor', 'runs');
  const strategyPath = path.join(tmpRoot, 'config', 'strategies', 'default.json');
  const statePath = path.join(tmpRoot, 'state', 'ops', 'workflow_execution_closure.json');
  const historyPath = path.join(tmpRoot, 'state', 'ops', 'workflow_execution_closure_history.jsonl');
  const policyPath = path.join(tmpRoot, 'config', 'workflow_execution_closure_policy.json');

  writeJson(policyPath, {
    version: '1.0-test',
    target_streak_days: 3,
    min_accepted_items: 1,
    min_workflows_executed: 1,
    lookback_days: 7,
    max_history_rows: 40
  });
  writeJson(strategyPath, {
    version: '1.0-test',
    id: 'default_general',
    execution_policy: {
      mode: 'canary_execute'
    }
  });

  const env = {
    ...process.env,
    WORKFLOW_EXECUTION_CLOSURE_POLICY_PATH: policyPath,
    WORKFLOW_EXECUTION_CLOSURE_PROPOSALS_DIR: proposalsDir,
    WORKFLOW_EXECUTION_CLOSURE_RUNS_DIR: workflowRunsDir,
    WORKFLOW_EXECUTION_CLOSURE_STRATEGY_PATH: strategyPath,
    WORKFLOW_EXECUTION_CLOSURE_STATE_PATH: statePath,
    WORKFLOW_EXECUTION_CLOSURE_HISTORY_PATH: historyPath
  };

  // Three passing days -> streak should pass target=3.
  writeJson(path.join(proposalsDir, '2026-02-24.json'), { proposals: [{ type: 'external_intel' }] });
  writeJson(path.join(proposalsDir, '2026-02-25.json'), {
    proposals: [
      { type: 'cross_signal_opportunity', meta: { composite_eligibility_pass: true } },
      { type: 'other' }
    ]
  });
  writeJson(path.join(proposalsDir, '2026-02-26.json'), { proposals: [{ type: 'external_intel' }] });
  writeJson(path.join(workflowRunsDir, '2026-02-24.json'), { workflows_executed: 1, workflows_succeeded: 1 });
  writeJson(path.join(workflowRunsDir, '2026-02-25.json'), { workflows_executed: 1, workflows_succeeded: 1 });
  writeJson(path.join(workflowRunsDir, '2026-02-26.json'), { workflows_executed: 2, workflows_succeeded: 2 });

  let proc = runNode(
    scriptPath,
    ['run', '2026-02-26', '--days=5', '--target-days=3', '--min-accepted=1', '--min-workflows=1'],
    env,
    repoRoot
  );
  assert.strictEqual(proc.status, 0, proc.stderr || 'run should pass');
  let out = parseJsonOutput(proc);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.closure_pass, true);
  assert.strictEqual(Number(out.consecutive_days_passed || 0), 3);
  assert.strictEqual(
    out.execution_gates && out.execution_gates.canary_mode_active,
    true,
    'canary mode should be detected as active'
  );
  assert.strictEqual(
    out.execution_gates && out.execution_gates.mutation_guard_scope_ok,
    true,
    'mutation guard scope should pass in clean dataset'
  );
  assert.ok(fs.existsSync(statePath), 'state payload should be written');
  assert.ok(fs.existsSync(historyPath), 'history payload should be written');

  // Break accepted-items requirement on the latest day -> streak should reset.
  writeJson(path.join(proposalsDir, '2026-02-26.json'), {
    proposals: [{ type: 'cross_signal_opportunity', meta: { composite_eligibility_pass: false } }]
  });
  proc = runNode(
    scriptPath,
    ['run', '2026-02-26', '--days=5', '--target-days=3', '--min-accepted=1', '--min-workflows=1'],
    env,
    repoRoot
  );
  assert.strictEqual(proc.status, 0, proc.stderr || 'run should still return payload');
  out = parseJsonOutput(proc);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.closure_pass, false);
  assert.strictEqual(Number(out.consecutive_days_passed || 0), 0);
  assert.strictEqual(String(out.result || ''), 'pending');
  assert.ok(out.latest_day && out.latest_day.pass === false, 'latest day should fail after accepted-items drop');
  assert.ok(Array.isArray(out.latest_day && out.latest_day.blockers), 'latest day should expose blocker list');
  assert.ok(
    out.latest_day.blockers.includes('accepted_items_below_min'),
    'accepted_items_below_min blocker should be emitted'
  );
  assert.ok(Array.isArray(out.top_blockers), 'payload should expose top_blockers');
  assert.ok(out.execution_gates && typeof out.execution_gates === 'object', 'execution gates should be emitted');
  assert.strictEqual(out.estimated_closure_date, null, 'estimated closure date should be null when latest day fails');

  // strict=1 should fail process if closure target is not met.
  proc = runNode(
    scriptPath,
    ['run', '2026-02-26', '--days=5', '--target-days=3', '--strict=1'],
    env,
    repoRoot
  );
  assert.strictEqual(proc.status, 1, 'strict mode should fail when closure target not met');

  // status should return last saved state.
  proc = runNode(scriptPath, ['status'], env, repoRoot);
  assert.strictEqual(proc.status, 0, proc.stderr || 'status should pass');
  out = parseJsonOutput(proc);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.available, true);
  assert.ok(out.payload && typeof out.payload === 'object');
}

run();
