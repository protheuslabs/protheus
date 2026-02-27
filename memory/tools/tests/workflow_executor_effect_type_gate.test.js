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

function parsePayload(stdout) {
  const raw = String(stdout || '').trim();
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function shellQuote(value) {
  return JSON.stringify(String(value));
}

function main() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'workflow', 'workflow_executor.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wfexec-effect-gate-'));
  const dateStr = '2026-02-27';

  const registryPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'registry.json');
  const runsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'runs');
  const historyPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'history.jsonl');
  const latestPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'latest.json');
  const rolloutStatePath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'rollout_state.json');
  const stepReceiptsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'step_receipts');
  const mutationReceiptsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'mutations');

  const blockedWorkflow = {
    id: 'wf_effect_blocked',
    name: 'Effect Type Blocked Workflow',
    status: 'active',
    source: 'test',
    updated_at: '2026-02-27T00:00:00.000Z',
    steps: [
      {
        id: 'money_step',
        type: 'command',
        adapter: 'payment_task',
        command: `${shellQuote(process.execPath)} -e ${shellQuote('process.exit(0)')}`,
        retries: 0,
        timeout_ms: 30000
      },
      {
        id: 'shell_step',
        type: 'command',
        adapter: 'shell_task',
        command: `${shellQuote(process.execPath)} -e ${shellQuote('process.exit(0)')}`,
        retries: 0,
        timeout_ms: 30000
      }
    ]
  };

  writeJson(registryPath, {
    version: '1.0',
    updated_at: null,
    generated_at: null,
    workflows: [blockedWorkflow]
  });

  const env = {
    ...process.env,
    WORKFLOW_REGISTRY_PATH: registryPath,
    WORKFLOW_EXECUTOR_RUNS_DIR: runsDir,
    WORKFLOW_EXECUTOR_HISTORY_PATH: historyPath,
    WORKFLOW_EXECUTOR_LATEST_PATH: latestPath,
    WORKFLOW_EXECUTOR_ROLLOUT_STATE_PATH: rolloutStatePath,
    WORKFLOW_EXECUTOR_STEP_RECEIPTS_DIR: stepReceiptsDir,
    WORKFLOW_EXECUTOR_MUTATION_RECEIPTS_DIR: mutationReceiptsDir,
    WORKFLOW_EXECUTOR_CWD: tmp,
    SYSTEM_BUDGET_DEFAULT_DAILY_TOKEN_CAP: '6000'
  };

  const run = spawnSync(process.execPath, [
    scriptPath,
    'run',
    dateStr,
    '--max=5',
    '--include-draft=0',
    '--enforce-eligibility=0',
    '--dry-run=0',
    '--receipt-strict=0'
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(run.status, 0, run.stderr || 'workflow executor run should complete');
  const payload = parsePayload(run.stdout);
  assert.ok(payload && payload.ok === true, 'executor payload should be parseable and ok');
  assert.strictEqual(Number(payload.workflows_failed || 0), 1, 'workflow should fail');
  assert.strictEqual(Number(payload.workflows_blocked || 0), 1, 'workflow should be blocked by effect gate');

  assert.ok(fs.existsSync(latestPath), 'latest run payload should be written');
  const latestPayload = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  const first = Array.isArray(latestPayload.results) && latestPayload.results.length ? latestPayload.results[0] : null;
  assert.ok(first, 'expected one workflow result');
  assert.strictEqual(first.blocked_by_gate, true, 'workflow should be marked blocked_by_gate');
  assert.strictEqual(first.failure_reason, 'effect_plan_denied', 'workflow should be denied by effect plan');
  assert.ok(first.effect_plan && first.effect_plan.ok === false, 'effect_plan details should be attached');

  console.log('workflow_executor_effect_type_gate.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`workflow_executor_effect_type_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
