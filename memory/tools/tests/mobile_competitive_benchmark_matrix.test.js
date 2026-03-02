#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'mobile_competitive_benchmark_matrix.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-bench-matrix-'));
  const policyPath = path.join(tmp, 'config', 'mobile_competitive_benchmark_matrix_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'ops.mobile_benchmark' },
    thresholds: {
      max_battery_drain_hour: 3.2,
      max_thermal_c: 44,
      min_survival_hours: 72,
      min_sync_integrity: 0.997,
      min_protheus_parity_score: 72
    },
    ci: {
      scenarios: [
        {
          name: 'ci_mobile_android',
          target: 'android',
          battery_drain_hour: 2.4,
          thermal_c: 39,
          survival_hours: 72,
          sync_integrity: 0.998
        }
      ]
    },
    paths: {
      memory_dir: path.join(tmp, 'memory', 'ops', 'mobile_benchmark'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'ops', 'mobile_benchmark', 'index.json'),
      events_path: path.join(tmp, 'state', 'ops', 'mobile_benchmark', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'ops', 'mobile_benchmark', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'ops', 'mobile_benchmark', 'receipts.jsonl'),
      matrix_path: path.join(tmp, 'state', 'ops', 'mobile_benchmark', 'matrix.json')
    }
  });

  let out = run([
    'run',
    '--owner=jay',
    '--scenario=ci_mobile_android',
    '--target=android',
    '--battery-drain-hour=2.4',
    '--thermal=39',
    '--survival-hours=72',
    '--sync-integrity=0.998',
    '--apply=1',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'mobile_benchmark_run');

  out = run(['ci-matrix', '--owner=jay', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'mobile_benchmark_ci_matrix');

  out = run(['status', '--owner=jay', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(Number(out.payload.run_count || 0), 1);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('mobile_competitive_benchmark_matrix.test.js: OK');
} catch (err) {
  console.error(`mobile_competitive_benchmark_matrix.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
