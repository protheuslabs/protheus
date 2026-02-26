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
  const raw = String(stdout || '').trim();
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'continuum', 'continuum_core.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-core-'));
  const dateStr = '2026-02-25';

  const stateDir = path.join(tmp, 'state', 'autonomy', 'continuum');
  const policyPath = path.join(tmp, 'config', 'continuum_policy.json');
  const policySkipPath = path.join(tmp, 'config', 'continuum_skip_policy.json');
  const runsDir = path.join(tmp, 'state', 'autonomy', 'runs');
  const simDir = path.join(tmp, 'state', 'autonomy', 'simulations');
  const introspectionDir = path.join(tmp, 'state', 'autonomy', 'fractal', 'introspection');
  const spineRunsDir = path.join(tmp, 'state', 'spine', 'runs');
  const trainingQueuePath = path.join(tmp, 'state', 'nursery', 'training', 'continuum_queue.jsonl');

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    low_priority_nice: 10,
    daemon: {
      interval_sec: 60,
      max_cycles: 2,
      jitter_sec: 0
    },
    runtime_guard: {
      max_load_per_cpu: 5,
      max_rss_mb: 10000,
      max_heap_used_mb: 10000,
      spine_hot_window_sec: 1
    },
    tasks: {
      dream_consolidation: { enabled: true, timeout_ms: 5000, days: 3, top: 5, include_idle_cycle: false, min_trit: -1, max_trit: 1 },
      anticipation: { enabled: true, timeout_ms: 5000, days: 7, max: 3, intent: 'test intent', value_currency: 'delivery', objective_id: 'continuum_test', min_trit: -1, max_trit: 1 },
      self_improvement: { enabled: true, timeout_ms: 5000, mirror_days: 1, include_fractal_introspection: true, min_trit: -1, max_trit: 1 },
      creative_incubation: { enabled: true, timeout_ms: 5000, days: 7, top: 8, max_promotions: 1, min_trit: -1, max_trit: 1 },
      security_vigilance: { enabled: true, timeout_ms: 5000, max_cases: 1, strict: false, min_trit: -1, max_trit: 1 },
      autotest_validation: { enabled: true, timeout_ms: 5000, scope: 'changed', max_tests: 4, sleep_only: true, strict: false, min_trit: -1, max_trit: 1 }
    },
    cooldown_sec: {
      dream_consolidation: 0,
      anticipation: 0,
      self_improvement: 0,
      creative_incubation: 0,
      security_vigilance: 0,
      autotest_validation: 0
    },
    training_queue: {
      enabled: true,
      path: path.relative(root, trainingQueuePath).replace(/\\/g, '/'),
      max_rows_per_pulse: 8
    },
    telemetry: {
      emit_events: true
    }
  });

  writeJson(policySkipPath, {
    version: '1.0',
    enabled: true,
    runtime_guard: {
      max_load_per_cpu: 0.000001,
      max_rss_mb: 1,
      max_heap_used_mb: 1,
      spine_hot_window_sec: 120
    }
  });

  writeJsonl(path.join(runsDir, `${dateStr}.jsonl`), [
    { type: 'autonomy_run', result: 'executed', outcome: 'shipped' },
    { type: 'autonomy_run', result: 'executed', outcome: 'no_change' },
    { type: 'autonomy_run', result: 'policy_hold', outcome: 'no_change' }
  ]);
  writeJson(path.join(simDir, `${dateStr}.json`), {
    checks_effective: {
      drift_rate: { value: 0.028 },
      yield_rate: { value: 0.71 }
    }
  });
  writeJson(path.join(introspectionDir, `${dateStr}.json`), {
    snapshot: {
      queue: { pressure: 'normal' }
    },
    restructure_candidates: []
  });
  writeJsonl(path.join(spineRunsDir, `${dateStr}.jsonl`), [
    { ts: '2026-02-24T00:00:00.000Z', type: 'spine_run_ok' }
  ]);

  const env = {
    ...process.env,
    CONTINUUM_STATE_DIR: stateDir,
    CONTINUUM_AUTONOMY_RUNS_DIR: runsDir,
    CONTINUUM_SIM_DIR: simDir,
    CONTINUUM_INTROSPECTION_DIR: introspectionDir,
    CONTINUUM_SPINE_RUNS_DIR: spineRunsDir,
    CONTINUUM_TRAINING_QUEUE_PATH: trainingQueuePath
  };

  const pulseProc = spawnSync(process.execPath, [
    scriptPath,
    'pulse',
    dateStr,
    `--policy=${policyPath}`,
    '--profile=test',
    '--dry-run=1',
    '--force=1'
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(pulseProc.status, 0, pulseProc.stderr || 'pulse run should pass');
  const pulseOut = parsePayload(pulseProc.stdout);
  assert.ok(pulseOut && pulseOut.ok === true, 'pulse output should be ok');
  assert.strictEqual(pulseOut.skipped, false, 'pulse should execute in dry-run mode');
  assert.ok(Number(pulseOut.tasks_executed || 0) >= 1, 'pulse should report executed tasks');
  assert.ok(Array.isArray(pulseOut.actions) && pulseOut.actions.length >= 6, 'pulse should include action rows');
  assert.ok(fs.existsSync(path.join(stateDir, 'latest.json')), 'latest pulse snapshot should exist');
  assert.ok(fs.existsSync(path.join(stateDir, 'runs', `${dateStr}.json`)), 'dated pulse snapshot should exist');
  assert.ok(fs.existsSync(trainingQueuePath), 'training queue should be written');
  const trainingRows = String(fs.readFileSync(trainingQueuePath, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(trainingRows.length >= 1, 'training queue should contain at least one row');
  const firstTrainingRow = trainingRows[0];
  assert.ok(firstTrainingRow.training_conduit, 'training row should include conduit metadata');
  assert.ok(firstTrainingRow.training_conduit.source, 'training conduit should include source metadata');
  assert.ok(firstTrainingRow.training_conduit.owner, 'training conduit should include owner metadata');
  assert.ok(firstTrainingRow.training_conduit.license, 'training conduit should include license metadata');
  assert.ok(firstTrainingRow.training_conduit.consent, 'training conduit should include consent metadata');
  assert.ok(firstTrainingRow.training_conduit.retention, 'training conduit should include retention metadata');
  assert.ok(firstTrainingRow.training_conduit.delete, 'training conduit should include delete metadata');
  assert.strictEqual(firstTrainingRow.training_conduit.validation.ok, true, 'training conduit metadata should validate');
  assert.ok(firstTrainingRow.trainability, 'training row should include trainability decision');
  assert.strictEqual(firstTrainingRow.trainability.allow, true, 'internal training rows should be trainable by default policy');

  const statusProc = spawnSync(process.execPath, [
    scriptPath,
    'status',
    'latest',
    `--policy=${policyPath}`
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(statusProc.status, 0, statusProc.stderr || 'status should pass');
  const statusOut = parsePayload(statusProc.stdout);
  assert.ok(statusOut && statusOut.ok === true, 'status output should be ok');
  assert.strictEqual(String(statusOut.profile || ''), 'test', 'status should expose last profile');

  const skipProc = spawnSync(process.execPath, [
    scriptPath,
    'pulse',
    dateStr,
    `--policy=${policySkipPath}`,
    '--profile=test',
    '--dry-run=1'
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(skipProc.status, 0, skipProc.stderr || 'skip pulse should pass');
  const skipOut = parsePayload(skipProc.stdout);
  assert.ok(skipOut && skipOut.ok === true, 'skip pulse output should be ok');
  assert.strictEqual(skipOut.skipped, true, 'pulse should skip under strict runtime guard');
  assert.ok(Array.isArray(skipOut.skip_reasons) && skipOut.skip_reasons.length >= 1, 'skip reasons should be present');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('continuum_core.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`continuum_core.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
