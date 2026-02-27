#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'execution_reliability_slo.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, `${body}\n`, 'utf8');
}

function run(args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || '')
  };
}

function parseJson(text) {
  return JSON.parse(String(text || '').trim());
}

function addUtcDays(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Number(delta || 0));
  return d.toISOString().slice(0, 10);
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-reliability-slo-'));
  const policyPath = path.join(tmp, 'config', 'execution_reliability_slo_policy.json');
  const historyPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'history.jsonl');
  const statePath = path.join(tmp, 'state', 'ops', 'execution_reliability_slo.json');
  const outputHistoryPath = path.join(tmp, 'state', 'ops', 'execution_reliability_slo_history.jsonl');
  const endDate = '2026-02-26';

  writeJson(policyPath, {
    version: '1.0-test',
    window_days: 30,
    min_live_runs: 10,
    min_execution_success_rate: 0.97,
    min_queue_drain_rate: 0.9,
    max_time_to_first_execution_p95_ms: 120000,
    max_zero_shipped_streak_days: 6
  });

  const goodRows = [];
  for (let i = 0; i < 12; i += 1) {
    goodRows.push({
      ts: `${addUtcDays(endDate, -i)}T12:00:00.000Z`,
      date: addUtcDays(endDate, -i),
      dry_run: false,
      workflows_selected: 10,
      workflows_executed: 9,
      workflows_succeeded: 9,
      workflows_failed: 0,
      workflows_blocked: 0,
      time_to_first_execution_ms: 50000
    });
  }
  writeJsonl(historyPath, goodRows);

  const passRun = run([
    'run',
    endDate,
    `--policy=${policyPath}`,
    `--executor-history-path=${historyPath}`,
    `--state-path=${statePath}`,
    `--history-path=${outputHistoryPath}`
  ]);
  assert.strictEqual(passRun.status, 0, `pass run failed: ${passRun.stderr}`);
  const passPayload = parseJson(passRun.stdout);
  assert.strictEqual(passPayload.ok, true, 'payload should be ok');
  assert.strictEqual(passPayload.pass, true, 'expected pass=true');
  assert.strictEqual(passPayload.result, 'pass', 'expected pass result');
  assert.ok(Array.isArray(passPayload.blocking_checks), 'blocking_checks should be present');
  assert.strictEqual(passPayload.blocking_checks.length, 0, 'pass should have no blocking checks');
  assert.strictEqual(Number(passPayload.remaining_recovery_days || 0), 0, 'pass should have zero recovery days');
  assert.ok(passPayload.measured.execution_success_rate >= 0.97, 'success rate should meet threshold');
  assert.ok(passPayload.measured.queue_drain_rate >= 0.9, 'queue drain should meet threshold');

  const badRows = [];
  for (let i = 0; i < 12; i += 1) {
    badRows.push({
      ts: `${addUtcDays(endDate, -i)}T13:00:00.000Z`,
      date: addUtcDays(endDate, -i),
      dry_run: false,
      workflows_selected: 1,
      workflows_executed: 1,
      workflows_succeeded: i >= 8 ? 1 : 0,
      workflows_failed: i >= 8 ? 0 : 1,
      workflows_blocked: 0,
      time_to_first_execution_ms: 40000
    });
  }
  // Last 8 days have zero shipped -> should fail streak check.
  writeJsonl(historyPath, badRows);

  const failRun = run([
    'run',
    endDate,
    `--policy=${policyPath}`,
    `--executor-history-path=${historyPath}`,
    `--state-path=${statePath}`,
    `--history-path=${outputHistoryPath}`
  ]);
  assert.strictEqual(failRun.status, 0, `fail run should still return payload: ${failRun.stderr}`);
  const failPayload = parseJson(failRun.stdout);
  assert.strictEqual(failPayload.ok, true, 'fail payload should still be ok');
  assert.strictEqual(failPayload.pass, false, 'expected pass=false');
  assert.strictEqual(failPayload.checks.zero_shipped_streak_days, false, 'zero shipped streak check should fail');
  assert.ok(Number(failPayload.measured.zero_shipped_streak_days || 0) >= 7, 'streak should be at least 7');
  assert.ok(
    Array.isArray(failPayload.blocking_checks) && failPayload.blocking_checks.includes('zero_shipped_streak_days'),
    'failing payload should include zero_shipped_streak_days blocker'
  );
  assert.ok(Number(failPayload.remaining_recovery_days || 0) >= 1, 'failing payload should estimate recovery days');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('execution_reliability_slo.test.js: OK');
} catch (err) {
  console.error(`execution_reliability_slo.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
