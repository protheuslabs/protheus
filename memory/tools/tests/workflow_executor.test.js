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
  const toolsDir = path.join(tmp, 'tools');
  const writerScript = path.join(toolsDir, 'write_receipt.js');
  const receiptPath = path.join(tmp, 'state', 'autonomy', 'receipts', `${dateStr}.jsonl`);

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
    '--dry-run=0'
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

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('workflow_executor.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`workflow_executor.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
