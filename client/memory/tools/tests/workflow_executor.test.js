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

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'workflow', 'workflow_executor.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-executor-'));
  const dateStr = '2026-02-25';

  const registryPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'registry.json');
  const runsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'runs');
  const historyPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'history.jsonl');
  const latestPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'latest.json');
  const rolloutStatePath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'rollout_state.json');
  const stepReceiptsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'step_receipts');
  const mutationReceiptsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'mutations');
  const toolsDir = path.join(tmp, 'tools');
  const writerScript = path.join(toolsDir, 'write_receipt.js');
  const failOnceScript = path.join(toolsDir, 'fail_once_then_pass.js');
  const receiptPath = path.join(tmp, 'state', 'autonomy', 'receipts', `${dateStr}.jsonl`);
  const failOnceMarkerPath = path.join(tmp, 'state', 'tmp', 'fail_once_marker.txt');
  const mutationPolicyPath = path.join(tmp, 'config', 'workflow_executor_policy.json');
  const tokenDeferPolicyPath = path.join(tmp, 'config', 'workflow_executor_token_defer_policy.json');
  const deferQueuePath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'defer_queue.jsonl');
  const budgetStateDir = path.join(tmp, 'state', 'autonomy', 'daily_budget');
  const budgetEventsPath = path.join(tmp, 'state', 'autonomy', 'budget_events.jsonl');
  const budgetAutopausePath = path.join(tmp, 'state', 'autonomy', 'budget_autopause.json');

  fs.mkdirSync(toolsDir, { recursive: true });
  fs.writeFileSync(
    writerScript,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const p = String(process.argv[2] || '');",
      "if (!p) process.exit(2);",
      "fs.mkdirSync(require('path').dirname(p), { recursive: true });",
      "fs.writeFileSync(p, JSON.stringify({ ok: true, ts: new Date().toISOString() }) + '\\n', 'utf8');"
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    failOnceScript,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const path = require('path');",
      "const marker = String(process.argv[2] || '');",
      "if (!marker) process.exit(2);",
      "if (fs.existsSync(marker)) process.exit(0);",
      "fs.mkdirSync(path.dirname(marker), { recursive: true });",
      "fs.writeFileSync(marker, 'first_fail\\n', 'utf8');",
      'process.exit(9);'
    ].join('\n'),
    'utf8'
  );
  writeJson(mutationPolicyPath, {
    version: '1.0',
    runtime_mutation: {
      enabled: true,
      max_mutations_per_run: 4,
      max_mutations_per_workflow: 2,
      retry_after_apply: true,
      rollback_on_regression: true,
      max_retry_increment: 1,
      max_total_retry_per_step: 3,
      allow: {
        guard_hardening: false,
        rollback_path: false,
        retry_tuning: true
      }
    }
  });
  writeJson(tokenDeferPolicyPath, {
    version: '1.0',
    token_economics: {
      enabled: true,
      use_system_budget: false,
      run_token_cap: 80,
      fallback_run_token_cap: 80,
      reserve_tokens_for_critical_lanes: 0,
      per_workflow_min_token_cap: 30,
      per_workflow_min_token_cap_critical: 30,
      per_workflow_max_token_cap: 300,
      throttle_floor_ratio: 0.9,
      defer_queue_enabled: true,
      critical_priority_floor: 5
    }
  });
  writeJson(budgetAutopausePath, {
    schema_id: 'system_budget_autopause',
    schema_version: '1.0.0',
    active: false,
    source: 'test',
    reason: null,
    pressure: null,
    until_ms: 0,
    until: null,
    updated_at: new Date().toISOString()
  });

  const successWorkflow = {
    id: 'wf_success',
    name: 'Success Workflow',
    status: 'active',
    source: 'test',
    updated_at: '2026-02-25T00:00:00.000Z',
    steps: [
      {
        id: 'prepare',
        type: 'command',
        command: `${shellQuote(process.execPath)} ${shellQuote(writerScript)} ${shellQuote(receiptPath)}`,
        retries: 0,
        timeout_ms: 30000
      },
      {
        id: 'gate',
        type: 'gate',
        command: `${shellQuote(process.execPath)} -e ${shellQuote('process.exit(0)')}`,
        retries: 0,
        timeout_ms: 30000
      },
      {
        id: 'receipt',
        type: 'receipt',
        command: receiptPath,
        retries: 0,
        timeout_ms: 30000
      }
    ]
  };

  const draftWorkflow = {
    id: 'wf_draft',
    name: 'Draft Workflow',
    status: 'draft',
    source: 'test',
    updated_at: '2026-02-25T00:00:00.000Z',
    steps: [
      {
        id: 'noop',
        type: 'command',
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
    workflows: [successWorkflow, draftWorkflow]
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
    WORKFLOW_EXECUTOR_DEFER_QUEUE_PATH: deferQueuePath,
    WORKFLOW_EXECUTOR_CWD: tmp,
    SYSTEM_BUDGET_STATE_DIR: budgetStateDir,
    SYSTEM_BUDGET_EVENTS_PATH: budgetEventsPath,
    SYSTEM_BUDGET_AUTOPAUSE_PATH: budgetAutopausePath,
    SYSTEM_BUDGET_DEFAULT_DAILY_TOKEN_CAP: '6000'
  };

  const successRun = spawnSync(process.execPath, [
    scriptPath,
    'run',
    dateStr,
    '--max=5',
    '--include-draft=0',
    '--dry-run=0',
    '--receipt-strict=1'
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });

  assert.strictEqual(successRun.status, 0, successRun.stderr || 'success run should pass');
  const successOut = parsePayload(successRun.stdout);
  assert.ok(successOut && successOut.ok === true, 'success run output should be ok');
  assert.strictEqual(Number(successOut.workflows_selected || 0), 1, 'should select only active workflow by default');
  assert.strictEqual(Number(successOut.workflows_succeeded || 0), 1, 'active workflow should succeed');
  assert.strictEqual(Number(successOut.workflows_failed || 0), 0, 'no failures expected');
  assert.ok(fs.existsSync(receiptPath), 'receipt file should be created by command step');

  const runPath = path.join(runsDir, `${dateStr}.json`);
  assert.ok(fs.existsSync(runPath), 'run snapshot should be persisted');
  const runPayload = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  assert.strictEqual(Number(runPayload.workflows_executed || 0), 1, 'snapshot should record one executed workflow');

  const statusRun = spawnSync(process.execPath, [
    scriptPath,
    'status',
    'latest'
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(statusRun.status, 0, statusRun.stderr || 'status should pass');
  const statusOut = parsePayload(statusRun.stdout);
  assert.ok(statusOut && statusOut.ok === true, 'status output should be ok');
  assert.strictEqual(Number(statusOut.workflows_succeeded || 0), 1, 'status should report succeeded workflow');

  const costlyWorkflow = {
    id: 'wf_costly',
    name: 'Costly Workflow',
    status: 'active',
    source: 'test',
    updated_at: '2026-02-25T00:00:00.000Z',
    steps: [
      {
        id: 'heavy_step',
        type: 'command',
        command: `${shellQuote(process.execPath)} -e ${shellQuote('process.exit(0)')}`,
        estimated_tokens: 180,
        retries: 0,
        timeout_ms: 30000
      },
      {
        id: 'gate',
        type: 'gate',
        command: `${shellQuote(process.execPath)} -e ${shellQuote('process.exit(0)')}`,
        estimated_tokens: 40,
        retries: 0,
        timeout_ms: 30000
      },
      {
        id: 'receipt',
        type: 'receipt',
        command: receiptPath,
        estimated_tokens: 10,
        retries: 0,
        timeout_ms: 30000
      }
    ]
  };
  writeJson(registryPath, {
    version: '1.0',
    updated_at: null,
    generated_at: null,
    workflows: [costlyWorkflow]
  });
  const deferRun = spawnSync(process.execPath, [
    scriptPath,
    'run',
    dateStr,
    '--max=2',
    '--dry-run=0',
    '--runtime-mutation=0',
    '--enforce-eligibility=1',
    `--policy=${tokenDeferPolicyPath}`
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(deferRun.status, 0, deferRun.stderr || 'defer run should return payload');
  const deferOut = parsePayload(deferRun.stdout);
  assert.ok(deferOut && deferOut.ok === true, 'defer run output should be ok');
  assert.strictEqual(Number(deferOut.workflows_selected_initial || 0), 1, 'defer run should start with one selected workflow');
  assert.strictEqual(Number(deferOut.workflows_selected || 0), 0, 'token economics should defer execution');
  assert.strictEqual(Number(deferOut.workflows_deferred || 0), 1, 'one workflow should be deferred');
  assert.strictEqual(Number(deferOut.workflows_executed || 0), 0, 'deferred workflow must not execute');
  assert.ok(
    Number((deferOut.token_predicted_total || 0)) > Number((deferOut.token_enveloped_total || 0)),
    'predicted tokens should exceed enveloped tokens when deferred'
  );
  assert.ok(fs.existsSync(deferQueuePath), 'defer queue should be written');
  const deferRows = fs.readFileSync(deferQueuePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(deferRows.length >= 1, 'defer queue should contain at least one entry');
  assert.strictEqual(String(deferRows[deferRows.length - 1].workflow_id || ''), 'wf_costly', 'defer queue should record the deferred workflow');

  const failingWorkflow = {
    id: 'wf_fail',
    name: 'Fail Workflow',
    status: 'active',
    source: 'test',
    updated_at: '2026-02-25T00:00:00.000Z',
    steps: [
      {
        id: 'pre',
        type: 'command',
        command: `${shellQuote(process.execPath)} -e ${shellQuote('process.exit(0)')}`,
        retries: 0,
        timeout_ms: 30000
      },
      {
        id: 'gate_fail',
        type: 'gate',
        command: `${shellQuote(process.execPath)} -e ${shellQuote('process.exit(3)')}`,
        retries: 1,
        timeout_ms: 30000
      }
    ]
  };
  writeJson(registryPath, {
    version: '1.0',
    updated_at: null,
    generated_at: null,
    workflows: [failingWorkflow]
  });

  const failRun = spawnSync(process.execPath, [
    scriptPath,
    'run',
    dateStr,
    '--max=3',
    '--continue-on-error=1',
    '--dry-run=0',
    '--runtime-mutation=0',
    '--enforce-eligibility=0'
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(failRun.status, 0, failRun.stderr || 'fail run should still return 0 payload');
  const failOut = parsePayload(failRun.stdout);
  assert.ok(failOut && failOut.ok === true, 'fail run output should be ok');
  assert.strictEqual(Number(failOut.workflows_failed || 0), 1, 'expected one failed workflow');
  assert.strictEqual(Number(failOut.workflows_blocked || 0), 1, 'gate failure should count as blocked');
  assert.strictEqual(Number(failOut.unhandled_failures || 0), 0, 'gate-blocked failures should not count as unhandled');

  const unhandledWorkflow = {
    id: 'wf_unhandled',
    name: 'Unhandled Workflow',
    status: 'active',
    source: 'test',
    updated_at: '2026-02-25T00:00:00.000Z',
    steps: [
      {
        id: 'fails_without_rollback',
        type: 'command',
        command: `${shellQuote(process.execPath)} -e ${shellQuote('process.exit(11)')}`,
        retries: 0,
        timeout_ms: 30000
      }
    ]
  };
  writeJson(registryPath, {
    version: '1.0',
    updated_at: null,
    generated_at: null,
    workflows: [unhandledWorkflow]
  });
  const unhandledRun = spawnSync(process.execPath, [
    scriptPath,
    'run',
    dateStr,
    '--max=1',
    '--continue-on-error=1',
    '--dry-run=0',
    '--runtime-mutation=0',
    '--enforce-eligibility=0'
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(unhandledRun.status, 0, unhandledRun.stderr || 'unhandled run should return payload');
  const unhandledOut = parsePayload(unhandledRun.stdout);
  assert.ok(unhandledOut && unhandledOut.ok === true, 'unhandled run output should be ok');
  assert.strictEqual(Number(unhandledOut.workflows_failed || 0), 1, 'unhandled run should fail once');
  assert.strictEqual(Number(unhandledOut.workflows_blocked || 0), 0, 'command failure should not be gate-blocked');
  assert.strictEqual(Number(unhandledOut.unhandled_failures || 0), 1, 'unrecovered command failure should count as unhandled');

  const mutatingWorkflow = {
    id: 'wf_mutation_retry',
    name: 'Mutation Retry Workflow',
    status: 'active',
    source: 'test',
    updated_at: '2026-02-25T00:00:00.000Z',
    mutation: {
      kind: 'retry_tuning'
    },
    steps: [
      {
        id: 'flaky',
        type: 'command',
        command: `${shellQuote(process.execPath)} ${shellQuote(failOnceScript)} ${shellQuote(failOnceMarkerPath)}`,
        retries: 0,
        timeout_ms: 30000
      },
      {
        id: 'confirm',
        type: 'command',
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
    workflows: [mutatingWorkflow]
  });

  const mutationRun = spawnSync(process.execPath, [
    scriptPath,
    'run',
    dateStr,
    '--max=2',
    '--dry-run=0',
    '--runtime-mutation=1',
    '--enforce-eligibility=0',
    `--policy=${mutationPolicyPath}`
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(mutationRun.status, 0, mutationRun.stderr || 'mutation run should pass');
  const mutationOut = parsePayload(mutationRun.stdout);
  assert.ok(mutationOut && mutationOut.ok === true, 'mutation run output should be ok');
  assert.strictEqual(Number(mutationOut.workflows_succeeded || 0), 1, 'mutation workflow should succeed after runtime retry tuning');
  assert.ok(Number(mutationOut.runtime_mutations_applied || 0) >= 1, 'runtime mutation should be applied');
  assert.strictEqual(Number(mutationOut.unhandled_failures || 0), 0, 'successful mutation run should have no unhandled failures');

  const mutationRunPayload = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  assert.ok(Number(mutationRunPayload.runtime_mutations_applied || 0) >= 1, 'run snapshot should record mutation apply');
  const mutationResult = Array.isArray(mutationRunPayload.results) ? mutationRunPayload.results[0] : null;
  assert.ok(mutationResult && mutationResult.mutation_summary, 'mutation summary should exist on result');
  assert.ok(Number(mutationResult.mutation_summary.applied || 0) >= 1, 'result mutation summary should record applied mutation');
  const retryRows = Array.isArray(mutationResult.step_results)
    ? mutationResult.step_results.filter((row) => row && row.runtime_mutation_retry === true)
    : [];
  assert.ok(retryRows.length >= 1, 'step results should include runtime mutation retry execution');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('workflow_executor.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`workflow_executor.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
