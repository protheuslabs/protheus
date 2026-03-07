#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'narrow_agent_parity_harness.js');

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

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'narrow-agent-parity-'));
  const date = '2026-02-26';

  const execPath = path.join(tmp, 'state', 'ops', 'execution_reliability_slo.json');
  const runtimePath = path.join(tmp, 'state', 'ops', 'runtime_efficiency_floor.json');
  const closurePath = path.join(tmp, 'state', 'ops', 'workflow_execution_closure.json');
  const budgetDir = path.join(tmp, 'state', 'autonomy', 'daily_budget');
  const budgetEventsPath = path.join(tmp, 'state', 'autonomy', 'budget_events.jsonl');
  const statePath = path.join(tmp, 'state', 'ops', 'narrow_agent_parity_harness.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'narrow_agent_parity_harness_history.jsonl');
  const weeklyDir = path.join(tmp, 'state', 'ops', 'parity_scorecards');
  const policyPath = path.join(tmp, 'config', 'narrow_agent_parity_harness_policy.json');

  writeJson(execPath, {
    live_runs: 12,
    pass: true,
    checks: { sufficient_data: true },
    measured: {
      execution_success_rate: 0.99,
      queue_drain_rate: 0.97,
      time_to_first_execution_p95_ms: 32000
    }
  });
  writeJson(runtimePath, {
    pass: true,
    metrics: {
      cold_start_p95_ms: 210
    }
  });
  writeJson(closurePath, {
    latest_day: { pass: true },
    evidence: {
      rows: [
        { date: '2026-02-26', pass: true },
        { date: '2026-02-25', pass: true },
        { date: '2026-02-24', pass: true },
        { date: '2026-02-23', pass: false }
      ]
    }
  });

  writeJson(path.join(budgetDir, '2026-02-26.json'), { used_est: 2200, token_cap: 4000 });
  writeJson(path.join(budgetDir, '2026-02-25.json'), { used_est: 2100, token_cap: 4000 });
  writeJson(path.join(budgetDir, '2026-02-24.json'), { used_est: 2000, token_cap: 4000 });
  writeJsonl(budgetEventsPath, [
    { date: '2026-02-26', decision: 'allow', reason: 'ok' },
    { date: '2026-02-25', decision: 'allow', reason: 'ok' },
    { date: '2026-02-24', decision: 'deny', reason: 'budget_autopause_active' }
  ]);

  writeJson(policyPath, {
    version: '1.0-test',
    strict_default: true,
    window_days: 7,
    min_live_runs: 5,
    aggregate_gates: {
      min_scenarios_passed: 2,
      min_pass_ratio: 0.66,
      min_weighted_score: 0.8
    },
    sources: {
      execution_reliability_slo_path: execPath,
      runtime_efficiency_floor_path: runtimePath,
      workflow_execution_closure_path: closurePath,
      daily_budget_dir: budgetDir,
      budget_events_path: budgetEventsPath
    },
    state_path: statePath,
    history_path: historyPath,
    weekly_receipts_dir: weeklyDir
  });

  const passRun = run(['run', date, '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(passRun.status, 0, `expected pass run status=0: ${passRun.stderr || passRun.stdout}`);
  const passPayload = parseJson(passRun.stdout);
  assert.strictEqual(passPayload.ok, true, 'payload should be ok');
  assert.strictEqual(passPayload.parity_pass, true, 'parity should pass');
  assert.ok(Array.isArray(passPayload.scenarios), 'scenarios array missing');
  assert.ok(passPayload.scenarios.length >= 3, 'expected default scenarios');
  assert.ok(fs.existsSync(statePath), 'state file missing');
  assert.ok(fs.existsSync(historyPath), 'history file missing');

  const weeklyFiles = fs.existsSync(weeklyDir) ? fs.readdirSync(weeklyDir).filter((f) => f.endsWith('.json')) : [];
  assert.ok(weeklyFiles.length >= 1, 'weekly receipts not written');

  writeJson(execPath, {
    live_runs: 12,
    pass: false,
    checks: { sufficient_data: true },
    measured: {
      execution_success_rate: 0.4,
      queue_drain_rate: 0.3,
      time_to_first_execution_p95_ms: 500000
    }
  });

  const failRun = run(['run', date, '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(failRun.status, 2, `expected strict fail status=2: ${failRun.stderr || failRun.stdout}`);
  const failPayload = parseJson(failRun.stdout);
  assert.strictEqual(failPayload.parity_pass, false, 'parity should fail after degraded metrics');

  const statusRun = run(['status', 'latest', `--policy=${policyPath}`]);
  assert.strictEqual(statusRun.status, 0, `status command failed: ${statusRun.stderr || statusRun.stdout}`);
  const statusPayload = parseJson(statusRun.stdout);
  assert.strictEqual(statusPayload.ok, true, 'status should return ok');
  assert.strictEqual(statusPayload.available, true, 'status should be available');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('narrow_agent_parity_harness.test.js: OK');
} catch (err) {
  console.error(`narrow_agent_parity_harness.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
