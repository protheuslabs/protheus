#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'rm_progress_dashboard.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-progress-dashboard-'));
  const policyPath = path.join(tmp, 'config', 'rm_progress_dashboard_policy.json');
  const statePath = path.join(tmp, 'state', 'ops', 'rm_progress_dashboard.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'rm_progress_dashboard_history.jsonl');
  const rm113Path = path.join(tmp, 'state', 'ops', 'workflow_execution_closure.json');
  const rm119Path = path.join(tmp, 'state', 'ops', 'execution_reliability_slo.json');
  const rm001Path = path.join(tmp, 'state', 'ops', 'ci_baseline_guard.json');

  writeJson(policyPath, {
    version: '1.0-test',
    max_history_rows: 40,
    sources: {
      rm113_closure_path: rm113Path,
      rm119_reliability_path: rm119Path,
      rm001_ci_guard_path: rm001Path
    }
  });

  writeJson(rm113Path, {
    closure_pass: true,
    consecutive_days_passed: 5,
    target_streak_days: 7,
    remaining_days: 2,
    result: 'pending'
  });
  writeJson(rm119Path, {
    pass: true,
    window_days: 30,
    live_runs: 14,
    measured: {
      execution_success_rate: 0.99,
      queue_drain_rate: 0.93,
      zero_shipped_streak_days: 0
    },
    result: 'pass'
  });
  writeJson(rm001Path, {
    pass: false,
    streak: 3,
    target_days: 7,
    latest_run_ok: true,
    latest_run_lag_days: 0,
    result: 'pending'
  });

  const partial = run([
    'run',
    '2026-02-26',
    `--policy=${policyPath}`,
    `--state-path=${statePath}`,
    `--history-path=${historyPath}`
  ]);
  assert.strictEqual(partial.status, 0, `partial run failed: ${partial.stderr}`);
  const partialPayload = parseJson(partial.stdout);
  assert.strictEqual(partialPayload.ok, true, 'partial payload expected ok');
  assert.strictEqual(partialPayload.status.all_pass, false, 'partial should not all-pass');
  assert.strictEqual(partialPayload.status.result, 'partial', 'partial status expected');
  assert.ok(Array.isArray(partialPayload.blocked_by), 'blocked_by should be array');
  assert.ok(partialPayload.blocked_by.includes('rm001_ci_baseline_guard'), 'rm001 should block');

  writeJson(rm001Path, {
    pass: true,
    streak: 7,
    target_days: 7,
    latest_run_ok: true,
    latest_run_lag_days: 0,
    result: 'pass'
  });

  const pass = run([
    'run',
    '2026-02-26',
    `--policy=${policyPath}`,
    `--state-path=${statePath}`,
    `--history-path=${historyPath}`,
    '--strict=1'
  ]);
  assert.strictEqual(pass.status, 0, `pass strict run failed: ${pass.stderr}`);
  const passPayload = parseJson(pass.stdout);
  assert.strictEqual(passPayload.status.all_pass, true, 'pass should be all-pass');
  assert.strictEqual(passPayload.status.result, 'pass', 'pass result expected');
  assert.strictEqual(passPayload.status.passed_count, 3, 'all three checks should pass');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('rm_progress_dashboard.test.js: OK');
} catch (err) {
  console.error(`rm_progress_dashboard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

