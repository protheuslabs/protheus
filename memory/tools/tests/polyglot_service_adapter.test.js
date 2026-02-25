#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'polyglot', 'polyglot_service_adapter.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function runCmd(args, env) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    }
  });
}

function parseJson(text) {
  return JSON.parse(String(text || '{}'));
}

function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polyglot-service-adapter-test-'));
  const policyPath = path.join(tmp, 'polyglot_policy.json');

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    contract_version: '1.0',
    allow_fallback_baseline: true,
    worker: {
      runtime: 'python3',
      script: 'systems/polyglot/pilot_task_classifier.py',
      timeout_ms: 2500
    },
    benchmark: {
      default_runs: 8,
      max_runs: 40
    }
  });

  const env = {
    POLYGLOT_SERVICE_POLICY_PATH: policyPath,
    POLYGLOT_SERVICE_ENABLED: '1'
  };

  let res = runCmd([
    'run',
    '--task-type=security_review',
    '--signals={"urgency":0.9,"confidence":0.8,"risk":0.2}',
    '--rollback-token=test_001'
  ], env);
  assert.strictEqual(res.status, 0, `run should pass: ${res.stderr}`);
  let out = parseJson(res.stdout);
  assert.strictEqual(out.ok, true);
  assert.ok(['worker', 'fallback_baseline'].includes(String(out.mode || '')), 'mode should be worker or fallback');
  assert.ok(out.result && typeof out.result === 'object', 'run should emit result');
  assert.ok(Number.isFinite(Number(out.result.score)), 'result score should be numeric');

  res = runCmd(['benchmark', '--runs=6'], env);
  assert.strictEqual(res.status, 0, `benchmark should pass: ${res.stderr}`);
  out = parseJson(res.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(Number(out.runs), 6);
  assert.ok(out.rollback_path && out.rollback_path.available === true, 'benchmark should expose rollback path');

  res = runCmd(['status'], env);
  assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
  out = parseJson(res.stdout);
  assert.strictEqual(out.ok, true);
  assert.ok(out.worker && typeof out.worker.runtime_available === 'boolean', 'status should expose runtime availability');

  // Explicit kill-switch must force fallback baseline.
  res = runCmd([
    'run',
    '--task-type=delivery_task',
    '--signals={"urgency":0.7,"confidence":0.6,"risk":0.3}'
  ], {
    ...env,
    POLYGLOT_SERVICE_ENABLED: '0'
  });
  assert.strictEqual(res.status, 0, `run (disabled) should pass: ${res.stderr}`);
  out = parseJson(res.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.mode, 'fallback_baseline');
  assert.strictEqual(out.reason, 'polyglot_disabled');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('polyglot_service_adapter.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`polyglot_service_adapter.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
