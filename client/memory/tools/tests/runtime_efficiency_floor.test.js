#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'runtime_efficiency_floor.js');

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

function parseJson(stdout) {
  return JSON.parse(String(stdout || '').trim());
}

try {
  const tmpRoot = path.join(ROOT, 'tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'runtime-eff-'));

  const artifactDir = path.join(tmp, 'artifact');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'payload.bin'), Buffer.alloc(256 * 1024)); // 0.25MB

  const statePath = path.join(tmp, 'state', 'runtime_efficiency_floor.json');
  const historyPath = path.join(tmp, 'state', 'runtime_efficiency_floor_history.jsonl');
  const policyPath = path.join(tmp, 'config', 'runtime_efficiency_floor_policy.json');

  writeJson(policyPath, {
    version: '1.0-test',
    strict_default: true,
    target_hold_days: 3,
    enforce_hold_streak_strict: false,
    cold_start_probe: {
      command: [process.execPath, '-e', 'process.stdout.write("ok\\n")'],
      samples: 3,
      max_ms: 1500
    },
    idle_rss_probe: {
      samples: 2,
      max_mb: 512,
      require_modules: []
    },
    install_artifact_probe: {
      max_mb: 10,
      paths: [artifactDir]
    },
    state_path: statePath,
    history_path: historyPath
  });

  const runResult = run(['run', '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(runResult.status, 0, `run should pass: ${runResult.stderr || runResult.stdout}`);
  const payload = parseJson(runResult.stdout);
  assert.strictEqual(payload.ok, true, 'run payload should be ok');
  assert.strictEqual(payload.pass, true, 'run should pass policy checks');
  assert.ok(Array.isArray(payload.blocking_checks), 'blocking_checks should be present');
  assert.strictEqual(payload.blocking_checks.length, 0, 'passing run should have no blockers');
  assert.ok(payload.threshold_gaps && typeof payload.threshold_gaps === 'object', 'threshold gap payload missing');
  assert.ok(Array.isArray(payload.optimization_order), 'optimization_order should be present');
  assert.ok(payload.hardware && typeof payload.hardware.class_id === 'string', 'hardware classification missing');
  assert.ok(payload.metrics.cold_start_p95_ms > 0, 'cold start metric missing');
  assert.ok(payload.metrics.idle_rss_p95_mb > 0, 'idle rss metric missing');
  assert.ok(payload.metrics.install_artifact_total_mb >= 0, 'artifact metric missing');
  assert.strictEqual(Number(payload.target_hold_days || 0), 3, 'target hold days should be reported');
  assert.ok(Number(payload.hold_streak_days || 0) >= 1, 'hold streak should include current pass day');
  assert.strictEqual(payload.hold_ready, false, 'single run should not satisfy hold readiness target');
  assert.ok(fs.existsSync(statePath), 'state path should exist');
  assert.ok(fs.existsSync(historyPath), 'history path should exist');

  const statusResult = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(statusResult.status, 0, `status should pass: ${statusResult.stderr || statusResult.stdout}`);
  const status = parseJson(statusResult.stdout);
  assert.strictEqual(status.ok, true, 'status payload should be ok');
  assert.strictEqual(status.available, true, 'status should be available');
  assert.strictEqual(status.payload.pass, true, 'status payload pass should be true');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('runtime_efficiency_floor.test.js: OK');
} catch (err) {
  console.error(`runtime_efficiency_floor.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
