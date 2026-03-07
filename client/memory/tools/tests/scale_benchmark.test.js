#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'scale_benchmark.js');

function mkDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(p, obj) {
  mkDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function run(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) }
  });
  const out = String(r.stdout || '').trim();
  let payload = null;
  if (out) {
    try { payload = JSON.parse(out); } catch {}
  }
  if (!payload) {
    const lines = out.split('\n').map((x) => x.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        payload = JSON.parse(lines[i]);
        break;
      } catch {}
    }
  }
  return { status: Number(r.status || 0), stdout: out, stderr: String(r.stderr || '').trim(), payload };
}

function runTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-benchmark-test-'));
  const policyPath = path.join(tmp, 'policy.json');
  const reportDir = path.join(tmp, 'reports');
  const historyPath = path.join(reportDir, 'history.jsonl');

  writeJson(policyPath, {
    version: '1.0',
    strict_default: true,
    tiers: [
      {
        id: 'smoke',
        operations: 80,
        synthetic_tokens_per_op: 300,
        max_error_rate: 0.1,
        max_p95_latency_ms: 30,
        min_throughput_ops_sec: 20
      },
      {
        id: 'failing_tier',
        operations: 80,
        synthetic_tokens_per_op: 300,
        max_error_rate: 1,
        max_p95_latency_ms: 30,
        min_throughput_ops_sec: 1000000000
      }
    ]
  });

  const env = {
    SCALE_BENCHMARK_POLICY_PATH: policyPath,
    SCALE_BENCHMARK_REPORT_DIR: reportDir,
    SCALE_BENCHMARK_HISTORY_PATH: historyPath
  };

  try {
    let r = run(['run', '--tier=smoke', '--strict=1'], env);
    assert.strictEqual(r.status, 0, `smoke should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'smoke payload should pass');
    assert.ok(r.payload.rows && r.payload.rows.length === 1, 'expected one tier row');

    r = run(['run', '--tier=failing_tier', '--strict=1'], env);
    assert.notStrictEqual(r.status, 0, 'failing tier should fail strict gate');
    assert.ok(r.payload && r.payload.ok === false, 'failing payload should fail');

    r = run(['status'], env);
    assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
    assert.ok(r.payload && Number(r.payload.recent_runs || 0) >= 2, 'status should show recent runs');

    console.log('scale_benchmark.test.js: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`scale_benchmark.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
