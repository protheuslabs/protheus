#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'competitive_benchmark_matrix.js');

function run(args, env = {}) {
  const out = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  const raw = String(out.stdout || '').trim();
  let payload = {};
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const candidate = lines.slice(idx).join('\n');
      try {
        payload = JSON.parse(candidate);
        break;
      } catch {
        // continue
      }
    }
  }
  return { status: out.status, payload, stderr: String(out.stderr || '') };
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-matrix-'));
  const policyPath = path.join(tmp, 'config', 'competitive_benchmark_matrix_policy.json');
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, JSON.stringify({
    version: '1.0',
    enabled: true,
    strict_default: true,
    owner_id: 'test',
    event_stream: { enabled: true, publish: true, stream: 'ops.test' },
    paths: {
      memory_dir: path.join(tmp, 'state', 'memory'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'index.json'),
      events_path: path.join(tmp, 'state', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'receipts.jsonl'),
      snapshots_path: path.join(tmp, 'state', 'snapshots.jsonl')
    },
    baseline_metrics: {
      cold_start_ms: 250,
      idle_memory_mb: 120,
      install_size_mb: 66,
      evidence_verify_latency_ms: 35
    },
    engines: ['protheus', 'openfang']
  }, null, 2));

  const runRes = run(['run', '--scenario=ci_lane', '--skip-subbench=1', `--policy=${policyPath}`, '--apply=1']);
  assert.strictEqual(runRes.status, 0, runRes.stderr);
  assert.strictEqual(runRes.payload.ok, true);
  assert.strictEqual(runRes.payload.event, 'competitive_benchmark_matrix_run');
  assert.strictEqual(Array.isArray(runRes.payload.payload.matrix), true);
  assert.strictEqual(runRes.payload.payload.matrix.length, 2);

  const statusRes = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(statusRes.status, 0, statusRes.stderr);
  assert.strictEqual(statusRes.payload.ok, true);
  assert.strictEqual(statusRes.payload.type, 'competitive_benchmark_matrix_status');

  console.log('competitive_benchmark_matrix.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`competitive_benchmark_matrix.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
