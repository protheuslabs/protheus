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
    WORKFLOW_EXECUTOR_CWD: tmp
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
