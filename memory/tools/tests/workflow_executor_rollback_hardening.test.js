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

function runNode(scriptPath, argv, opts = {}) {
  return spawnSync(process.execPath, [scriptPath].concat(argv || []), {
    encoding: 'utf8',
    ...opts
  });
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'workflow', 'workflow_executor.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-executor-rm014-'));
  const dateA = '2026-02-26';
  const dateB = '2026-02-27';

  const registryPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'registry.json');
  const runsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'runs');
  const historyPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'history.jsonl');
  const latestPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'latest.json');
  const rolloutStatePath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'rollout_state.json');
  const stepReceiptsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'step_receipts');
  const mutationReceiptsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'mutations');
  const policyPath = path.join(tmp, 'config', 'workflow_executor_policy.json');

  const toolsDir = path.join(tmp, 'tools');
  const printScript = path.join(toolsDir, 'print_then_exit.js');
  const markerScript = path.join(toolsDir, 'write_marker.js');
  const failScript = path.join(toolsDir, 'fail_always.js');
  const rollbackMarkerA = path.join(tmp, 'state', 'tmp', 'rollback_a.marker');
  const rollbackMarkerB = path.join(tmp, 'state', 'tmp', 'rollback_b.marker');

  fs.mkdirSync(toolsDir, { recursive: true });
  fs.writeFileSync(
    printScript,
    [
      '#!/usr/bin/env node',
      "const msg = String(process.argv[2] || '');",
      "process.stdout.write(msg + '\\n');",
      'process.exit(0);'
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    markerScript,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const path = require('path');",
      "const p = String(process.argv[2] || '');",
      "if (!p) process.exit(2);",
      "fs.mkdirSync(path.dirname(p), { recursive: true });",
      "fs.writeFileSync(p, 'ok\\n', 'utf8');",
      'process.exit(0);'
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    failScript,
    [
      '#!/usr/bin/env node',
      "process.stderr.write('forced_fail\\n');",
      'process.exit(7);'
    ].join('\n'),
    'utf8'
  );

  writeJson(policyPath, {
    version: '1.0',
    execution_gate: {
      enabled: true,
      min_steps: 3,
      require_gate_step: true,
      require_receipt_step: true,
      require_concrete_commands: true,
      require_rollback_path: true,
      allow_policy_default_rollback: true,
      min_composite_score: 0.01,
      require_metrics_for_auto: false,
      blocked_command_tokens: ['todo', 'placeholder', 'tbd'],
      placeholder_allowlist: ['date', 'workflow_id', 'step_id', 'run_id']
    },
    failure_rollback: {
      enabled: true,
      default_command: `node ${shellQuote(markerScript)} ${shellQuote(path.join(tmp, 'state', 'tmp', 'fallback_rollback.marker'))}`,
      timeout_ms: 30000,
      retries: 0
    },
    rollout: {
      enabled: false,
      initial_stage: 'live',
      shadow_dry_run: false,
      canary_fraction: 1,
      canary_min_fraction: 1,
      canary_max_fraction: 1,
      scale_up_step: 0.1,
      scale_down_step: 0.1,
      min_consecutive_green_for_scale_up: 1,
      min_consecutive_red_for_scale_down: 1,
      promote_to_live_fraction: 1,
      demote_shadow_on_floor_breach: false
    },
    slo: {
      min_execution_success_rate: 0,
      min_queue_drain_rate: 0,
      max_time_to_first_execution_ms: 300000,
      lookback_runs: 3,
      min_runs_for_decision: 1
    },
    runtime_mutation: {
      enabled: false,
      max_mutations_per_run: 0,
      max_mutations_per_workflow: 0,
      retry_after_apply: false,
      rollback_on_regression: false,
      max_retry_increment: 0,
      max_total_retry_per_step: 0,
      allow: {
        guard_hardening: false,
        rollback_path: false,
        retry_tuning: false
      }
    },
    step_runtime: {
      enforce_success_criteria: true,
      default_allowed_exit_codes: [0],
      max_total_attempts_per_workflow: 24,
      max_total_retry_attempts_per_workflow: 16,
      max_total_step_duration_ms_per_workflow: 600000
    }
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
    WORKFLOW_EXECUTOR_CWD: tmp
  };

  const criteriaFailWorkflow = {
    id: 'wf_success_criteria_fail',
    name: 'Success Criteria Fail',
    status: 'active',
    source: 'test',
    updated_at: '2026-02-26T00:00:00.000Z',
    steps: [
      {
        id: 'execute',
        type: 'command',
        command: `${shellQuote(process.execPath)} ${shellQuote(printScript)} ${shellQuote('hello')}`,
        retries: 0,
        timeout_ms: 30000,
        success_criteria: {
          stdout_includes: ['ready']
        }
      },
      {
        id: 'rollback_plan',
        type: 'command',
        command: `${shellQuote(process.execPath)} ${shellQuote(markerScript)} ${shellQuote(rollbackMarkerA)}`,
        retries: 0,
        timeout_ms: 30000
      },
      {
        id: 'verify',
        type: 'gate',
        command: `${shellQuote(process.execPath)} -e ${shellQuote('process.exit(0)')}`,
        retries: 0,
        timeout_ms: 30000
      },
      {
        id: 'receipt',
        type: 'receipt',
        command: path.join(tmp, 'state', 'noop', `${dateA}.jsonl`),
        retries: 0,
        timeout_ms: 30000
      }
    ]
  };

  writeJson(registryPath, {
    version: '1.0',
    workflows: [criteriaFailWorkflow]
  });

  const runA = runNode(scriptPath, [
    'run',
    dateA,
    '--max=4',
    '--dry-run=0',
    '--runtime-mutation=0',
    '--continue-on-error=1',
    '--receipt-strict=1',
    '--enforce-eligibility=1',
    `--policy=${policyPath}`
  ], { cwd: root, env });
  assert.strictEqual(runA.status, 0, `criteria run should exit 0: ${runA.stderr}`);
  const outA = parsePayload(runA.stdout);
  assert.ok(outA && outA.ok === true, 'criteria run payload should be ok');
  assert.strictEqual(Number(outA.workflows_failed || 0), 1, 'criteria run should fail one workflow');
  assert.strictEqual(Number(outA.workflows_succeeded || 0), 0, 'criteria run should have zero successes');
  assert.ok(
    Number((outA.failure_reasons || {})['stdout_missing_token:ready'] || 0) >= 1,
    'failure reasons should include success-criteria miss'
  );
  assert.ok(fs.existsSync(rollbackMarkerA), 'rollback marker for criteria failure should exist');

  const runASnapshot = JSON.parse(fs.readFileSync(path.join(runsDir, `${dateA}.json`), 'utf8'));
  const resultA = Array.isArray(runASnapshot.results) ? runASnapshot.results[0] : null;
  assert.ok(resultA && resultA.ok === false, 'criteria workflow result should fail');
  assert.strictEqual(resultA.failure_reason, 'stdout_missing_token:ready', 'failure reason should come from success criteria');
  assert.strictEqual(resultA.rollback_attempted, true, 'rollback should be attempted');
  assert.strictEqual(resultA.rollback_ok, true, 'rollback should succeed');

  const stepReceiptPathA = path.resolve(root, runASnapshot.step_receipts_path);
  assert.ok(fs.existsSync(stepReceiptPathA), 'step receipt file should exist for criteria run');
  const stepRowsA = fs.readFileSync(stepReceiptPathA, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(stepRowsA.some((row) => row && row.failure_reason === 'stdout_missing_token:ready'), 'step receipt should preserve failure reason');
  assert.ok(stepRowsA.some((row) => row && row.rollback_step === true), 'step receipt should include rollback step row');

  const budgetPolicy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  budgetPolicy.step_runtime.max_total_retry_attempts_per_workflow = 1;
  budgetPolicy.step_runtime.max_total_attempts_per_workflow = 64;
  budgetPolicy.step_runtime.max_total_step_duration_ms_per_workflow = 600000;
  writeJson(policyPath, budgetPolicy);

  const budgetFailWorkflow = {
    id: 'wf_retry_budget_fail',
    name: 'Retry Budget Fail',
    status: 'active',
    source: 'test',
    updated_at: '2026-02-27T00:00:00.000Z',
    steps: [
      {
        id: 'heavy',
        type: 'command',
        command: `${shellQuote(process.execPath)} ${shellQuote(failScript)}`,
        retries: 5,
        timeout_ms: 1000
      },
      {
        id: 'rollback_budget',
        type: 'command',
        command: `${shellQuote(process.execPath)} ${shellQuote(markerScript)} ${shellQuote(rollbackMarkerB)}`,
        retries: 0,
        timeout_ms: 30000
      },
      {
        id: 'verify',
        type: 'gate',
        command: `${shellQuote(process.execPath)} -e ${shellQuote('process.exit(0)')}`,
        retries: 0,
        timeout_ms: 30000
      },
      {
        id: 'receipt',
        type: 'receipt',
        command: path.join(tmp, 'state', 'noop', `${dateB}.jsonl`),
        retries: 0,
        timeout_ms: 30000
      }
    ]
  };

  writeJson(registryPath, {
    version: '1.0',
    workflows: [budgetFailWorkflow]
  });

  const runB = runNode(scriptPath, [
    'run',
    dateB,
    '--max=4',
    '--dry-run=0',
    '--runtime-mutation=0',
    '--continue-on-error=1',
    '--receipt-strict=1',
    '--enforce-eligibility=1',
    `--policy=${policyPath}`
  ], { cwd: root, env });
  assert.strictEqual(runB.status, 0, `budget run should exit 0: ${runB.stderr}`);
  const outB = parsePayload(runB.stdout);
  assert.ok(outB && outB.ok === true, 'budget run payload should be ok');
  assert.strictEqual(Number(outB.workflows_failed || 0), 1, 'budget run should fail one workflow');
  assert.ok(fs.existsSync(rollbackMarkerB), 'rollback marker for budget failure should exist');

  const runBSnapshot = JSON.parse(fs.readFileSync(path.join(runsDir, `${dateB}.json`), 'utf8'));
  const resultB = Array.isArray(runBSnapshot.results) ? runBSnapshot.results[0] : null;
  assert.ok(resultB && resultB.ok === false, 'budget workflow result should fail');
  assert.strictEqual(resultB.failure_reason, 'retry_budget_exceeded_precheck', 'budget precheck should fail before heavy step execution');
  assert.strictEqual(resultB.rollback_attempted, true, 'budget failure should still trigger rollback');
  assert.strictEqual(resultB.rollback_ok, true, 'budget rollback should succeed');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('workflow_executor_rollback_hardening.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`workflow_executor_rollback_hardening.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
