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
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(root, 'systems', 'ops', 'execution_doctor_ga.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-doctor-ga-'));

  const workflowHistoryPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'history.jsonl');
  const doctorHistoryPath = path.join(tmp, 'state', 'ops', 'autotest_doctor', 'history.jsonl');
  const latestPath = path.join(tmp, 'state', 'ops', 'execution_doctor_ga', 'latest.json');
  const gateHistoryPath = path.join(tmp, 'state', 'ops', 'execution_doctor_ga', 'history.jsonl');
  const policyPath = path.join(tmp, 'config', 'execution_doctor_ga_policy.json');
  const date = '2026-02-26';

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    rolling_days: 30,
    thresholds: {
      max_unhandled_executor_failures: 0,
      min_known_auto_handle_rate: 0.99,
      min_unknown_route_coverage: 1,
      require_unknown_signature_routing: true
    },
    samples: {
      min_executor_runs: 1,
      min_doctor_runs: 1
    },
    paths: {
      workflow_history: workflowHistoryPath,
      doctor_history: doctorHistoryPath,
      latest: latestPath,
      history: gateHistoryPath
    }
  });

  writeJsonl(workflowHistoryPath, [
    {
      ts: `${date}T03:00:00.000Z`,
      type: 'workflow_executor_run',
      unhandled_failures: 0,
      workflows_failed: 0,
      workflows_blocked: 0
    }
  ]);
  writeJsonl(doctorHistoryPath, [
    {
      ts: `${date}T03:10:00.000Z`,
      type: 'autotest_doctor_run',
      known_signature_candidates: 100,
      known_signature_auto_handled: 100,
      unknown_signature_count: 4,
      unknown_signature_routes: 4
    }
  ]);

  const passRun = spawnSync(process.execPath, [
    script,
    'run',
    `--policy=${policyPath}`,
    `--date=${date}`,
    '--strict=1'
  ], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.strictEqual(passRun.status, 0, passRun.stderr || 'gate pass run should exit 0');
  const passPayload = parsePayload(passRun.stdout);
  assert.ok(passPayload && passPayload.ok === true, 'pass payload should be ok');
  assert.strictEqual(passPayload.pass, true, 'gate should pass with clean metrics');
  assert.strictEqual(Number(passPayload.metrics.unhandled_failures || 0), 0, 'unhandled failures should be zero');
  assert.ok(fs.existsSync(latestPath), 'latest GA snapshot should be written');

  writeJsonl(workflowHistoryPath, [
    {
      ts: `${date}T04:00:00.000Z`,
      type: 'workflow_executor_run',
      unhandled_failures: 1,
      workflows_failed: 1,
      workflows_blocked: 0
    }
  ]);
  writeJsonl(doctorHistoryPath, [
    {
      ts: `${date}T04:10:00.000Z`,
      type: 'autotest_doctor_run',
      known_signature_candidates: 50,
      known_signature_auto_handled: 50,
      unknown_signature_count: 2,
      unknown_signature_routes: 1
    }
  ]);

  const failRun = spawnSync(process.execPath, [
    script,
    'run',
    `--policy=${policyPath}`,
    `--date=${date}`,
    '--strict=1'
  ], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.strictEqual(failRun.status, 1, 'strict mode should exit 1 when checks fail');
  const failPayload = parsePayload(failRun.stdout);
  assert.ok(failPayload && failPayload.pass === false, 'failing payload should report pass=false');
  assert.strictEqual(failPayload.checks.unhandled_failures, false, 'unhandled check should fail');
  assert.strictEqual(failPayload.checks.unknown_signature_routing, false, 'unknown routing check should fail');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('execution_doctor_ga.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`execution_doctor_ga.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

