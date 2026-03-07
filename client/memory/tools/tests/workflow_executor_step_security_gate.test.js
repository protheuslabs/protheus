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
  if (!raw) return null;
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
  const executorScript = path.join(root, 'systems', 'workflow', 'workflow_executor.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-step-security-gate-'));
  const dateStr = '2026-03-03';

  const policyPath = path.join(tmp, 'config', 'workflow_executor_policy.json');
  const registryPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'registry.json');
  const runsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'runs');
  const historyPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'history.jsonl');
  const latestPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'latest.json');
  const latestLivePath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'latest_live.json');
  const rolloutStatePath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'rollout_state.json');

  writeJson(policyPath, {
    version: '1.0-test',
    rollout: { enabled: false }
  });

  const allowReceiptPath = path.join(tmp, 'state', 'receipts', 'allow_receipt.json');
  const failReceiptPath = path.join(tmp, 'state', 'receipts', 'fail_receipt.json');
  const workflow = {
    id: 'wf_step_security_gate',
    name: 'Step Security Gate Workflow',
    status: 'active',
    source: 'test',
    updated_at: '2026-03-03T00:00:00.000Z',
    steps: [
      {
        id: 'prepare',
        type: 'command',
        command: `${shellQuote(process.execPath)} -e ${shellQuote(`const fs=require('fs');const p=${JSON.stringify(allowReceiptPath)};fs.mkdirSync(require('path').dirname(p),{recursive:true});fs.writeFileSync(p,'ok\\n','utf8');`)}`,
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
        command: allowReceiptPath,
        retries: 0,
        timeout_ms: 30000
      }
    ]
  };

  writeJson(registryPath, {
    version: '1.0',
    workflows: [workflow]
  });

  const baseEnv = {
    ...process.env,
    WORKFLOW_REGISTRY_PATH: registryPath,
    WORKFLOW_EXECUTOR_RUNS_DIR: runsDir,
    WORKFLOW_EXECUTOR_HISTORY_PATH: historyPath,
    WORKFLOW_EXECUTOR_LATEST_PATH: latestPath,
    WORKFLOW_EXECUTOR_LATEST_LIVE_PATH: latestLivePath,
    WORKFLOW_EXECUTOR_ROLLOUT_STATE_PATH: rolloutStatePath
  };

  const allowRun = spawnSync(process.execPath, [
    executorScript,
    'run',
    dateStr,
    '--dry-run=0',
    '--max=1',
    '--step-security-gate=1',
    `--policy=${policyPath}`
  ], {
    cwd: root,
    encoding: 'utf8',
    env: baseEnv
  });
  assert.strictEqual(allowRun.status, 0, allowRun.stderr || 'allow run should return payload');
  const allowPayload = parsePayload(allowRun.stdout);
  assert.ok(allowPayload && allowPayload.ok === true, 'allow payload should be ok');
  assert.strictEqual(Number(allowPayload.workflows_succeeded || 0), 1, 'allow run should succeed');
  assert.strictEqual(Number(allowPayload.workflows_failed || 0), 0, 'allow run should not fail');
  assert.ok(fs.existsSync(allowReceiptPath), 'allow path should execute command and write receipt');

  const denyStateRoot = path.join(tmp, 'state_fail_closed');
  writeJson(registryPath, {
    version: '1.0',
    workflows: [{
      ...workflow,
      id: 'wf_step_security_gate_fail',
      steps: [
        {
          id: 'prepare',
          type: 'command',
          command: `${shellQuote(process.execPath)} -e ${shellQuote(`const fs=require('fs');const p=${JSON.stringify(failReceiptPath)};fs.mkdirSync(require('path').dirname(p),{recursive:true});fs.writeFileSync(p,'ok\\n','utf8');`)}`,
          retries: 0,
          timeout_ms: 30000
        },
        { id: 'gate', type: 'gate', command: `${shellQuote(process.execPath)} -e ${shellQuote('process.exit(0)')}`, retries: 0, timeout_ms: 30000 },
        { id: 'receipt', type: 'receipt', command: failReceiptPath, retries: 0, timeout_ms: 30000 }
      ]
    }]
  });

  const denyRun = spawnSync(process.execPath, [
    executorScript,
    'run',
    dateStr,
    '--dry-run=0',
    '--max=1',
    '--step-security-gate=1',
    '--security-covenant-violation=1',
    '--security-tamper-signal=1',
    '--security-operator-quorum=1',
    `--state-root=${denyStateRoot}`,
    `--policy=${policyPath}`
  ], {
    cwd: root,
    encoding: 'utf8',
    env: baseEnv
  });
  assert.strictEqual(denyRun.status, 0, denyRun.stderr || 'deny run should return payload');
  const denyPayload = parsePayload(denyRun.stdout);
  assert.ok(denyPayload && denyPayload.ok === true, 'deny payload should be ok');
  assert.strictEqual(Number(denyPayload.workflows_succeeded || 0), 0, 'deny run should not succeed');
  assert.strictEqual(Number(denyPayload.workflows_failed || 0), 1, 'deny run should fail exactly one workflow');
  assert.strictEqual(fs.existsSync(failReceiptPath), false, 'deny path must block command execution before receipt is written');

  const runSnapshotPath = path.join(runsDir, `${dateStr}.json`);
  assert.ok(fs.existsSync(runSnapshotPath), 'deny run should persist snapshot');
  const runSnapshot = JSON.parse(fs.readFileSync(runSnapshotPath, 'utf8'));
  assert.ok(Array.isArray(runSnapshot.results) && runSnapshot.results.length === 1, 'run snapshot should contain one workflow result');
  const firstStep = runSnapshot.results[0]
    && Array.isArray(runSnapshot.results[0].step_results)
    && runSnapshot.results[0].step_results.length
    ? runSnapshot.results[0].step_results[0]
    : null;
  assert.ok(firstStep && firstStep.security_gate && firstStep.security_gate.ok === false, 'first step should fail security gate');
  assert.ok(
    String(firstStep && firstStep.failure_reason || '').includes('security_gate_blocked'),
    'step failure should include security gate block'
  );

  const shutdownPath = path.join(denyStateRoot, 'security', 'hard_shutdown.json');
  const alertsPath = path.join(denyStateRoot, 'security', 'human_alerts.jsonl');
  assert.ok(fs.existsSync(shutdownPath), 'deny path should emit hard shutdown artifact');
  assert.ok(fs.existsSync(alertsPath), 'deny path should emit human alert ledger');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('workflow_executor_step_security_gate.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`workflow_executor_step_security_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
