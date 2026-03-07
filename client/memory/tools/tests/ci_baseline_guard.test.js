#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'ci_baseline_guard.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(args, env = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-baseline-guard-'));
  const policyPath = path.join(tmp, 'config', 'ci_baseline_guard_policy.json');
  const ciStatePath = path.join(tmp, 'state', 'ops', 'ci_baseline_streak.json');
  const statePath = path.join(tmp, 'state', 'ops', 'ci_baseline_guard.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'ci_baseline_guard_history.jsonl');
  const date = '2026-02-26';

  writeJson(policyPath, {
    version: '1.0-test',
    target_days: 7,
    stale_after_days: 1
  });

  writeJson(ciStatePath, {
    schema_id: 'ci_baseline_streak',
    schema_version: '1.0',
    updated_at: `${date}T05:00:00.000Z`,
    target_days: 7,
    consecutive_daily_green_runs: 3,
    latest_green_date: date,
    history: [
      { ts: `${date}T05:00:00.000Z`, date, ok: true, passed: 10, failed: 0, total: 10, include_stateful: false }
    ]
  });

  const pendingRun = run([
    'run',
    date,
    `--policy=${policyPath}`,
    `--ci-state-path=${ciStatePath}`,
    `--state-path=${statePath}`,
    `--history-path=${historyPath}`
  ]);
  assert.strictEqual(pendingRun.status, 0, `pending run failed: ${pendingRun.stderr}`);
  const pendingPayload = parseJson(pendingRun.stdout);
  assert.strictEqual(pendingPayload.ok, true, 'pending payload should be ok');
  assert.strictEqual(pendingPayload.pass, false, 'pending should not pass target');
  assert.strictEqual(pendingPayload.result, 'pending', 'result should be pending');
  assert.strictEqual(Number(pendingPayload.remaining_days || 0), 4, 'remaining days should reflect target gap');
  assert.strictEqual(
    pendingPayload.advisories && pendingPayload.advisories.requires_future_green_days,
    true,
    'pending run should require future green days'
  );
  assert.ok(Array.isArray(pendingPayload.blocking_checks), 'blocking checks should be emitted');
  assert.ok(
    pendingPayload.blocking_checks.includes('streak_target_met'),
    'streak_target_met should block pending state'
  );
  assert.ok(
    Number(pendingPayload.same_day_green_runs || 0) >= 1,
    'same_day_green_runs should track same-day reruns'
  );

  const passRun = run([
    'run',
    date,
    `--policy=${policyPath}`,
    '--target-days=3',
    `--ci-state-path=${ciStatePath}`,
    `--state-path=${statePath}`,
    `--history-path=${historyPath}`
  ]);
  assert.strictEqual(passRun.status, 0, `pass run failed: ${passRun.stderr}`);
  const passPayload = parseJson(passRun.stdout);
  assert.strictEqual(passPayload.ok, true, 'pass payload should be ok');
  assert.strictEqual(passPayload.pass, true, 'expected pass=true with target-days=3');
  assert.strictEqual(passPayload.result, 'pass', 'result should be pass');
  assert.strictEqual(Number(passPayload.remaining_days || 0), 0, 'pass should have zero remaining days');
  assert.strictEqual(
    passPayload.advisories && passPayload.advisories.requires_future_green_days,
    false,
    'pass should not require future green days'
  );
  assert.ok(Array.isArray(passPayload.blocking_checks), 'blocking checks should be present');
  assert.strictEqual(passPayload.blocking_checks.length, 0, 'pass should have no blocking checks');

  writeJson(ciStatePath, {
    schema_id: 'ci_baseline_streak',
    schema_version: '1.0',
    updated_at: '2026-02-23T05:00:00.000Z',
    target_days: 7,
    consecutive_daily_green_runs: 7,
    latest_green_date: '2026-02-23',
    history: [
      { ts: '2026-02-23T05:00:00.000Z', date: '2026-02-23', ok: true, passed: 10, failed: 0, total: 10, include_stateful: false }
    ]
  });

  const staleRun = run([
    'run',
    date,
    `--policy=${policyPath}`,
    `--ci-state-path=${ciStatePath}`,
    `--state-path=${statePath}`,
    `--history-path=${historyPath}`
  ]);
  assert.strictEqual(staleRun.status, 0, `stale run failed: ${staleRun.stderr}`);
  const stalePayload = parseJson(staleRun.stdout);
  assert.strictEqual(stalePayload.ok, true, 'stale payload should be ok');
  assert.strictEqual(stalePayload.pass, false, 'stale run should fail');
  assert.strictEqual(stalePayload.result, 'stale', 'result should be stale');
  assert.strictEqual(stalePayload.checks.latest_run_fresh, false, 'stale freshness check should fail');

  const overrideRun = run([
    'run',
    `--policy=${policyPath}`,
    `--ci-state-path=${ciStatePath}`,
    `--state-path=${statePath}`,
    `--history-path=${historyPath}`
  ], {
    CI_BASELINE_GUARD_NOW_ISO: '2026-02-26T08:00:00.000Z'
  });
  assert.strictEqual(overrideRun.status, 0, `override run failed: ${overrideRun.stderr}`);
  const overridePayload = parseJson(overrideRun.stdout);
  assert.strictEqual(String(overridePayload.date || ''), '2026-02-26', 'now override should control default date in guard');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ci_baseline_guard.test.js: OK');
} catch (err) {
  console.error(`ci_baseline_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
