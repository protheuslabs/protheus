#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'competitive_observability_benchmark_pack.js');

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
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-bench-'));
  const policyPath = path.join(tmp, 'config', 'competitive_observability_benchmark_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'ops.competitive_benchmark' },
    paths: {
      memory_dir: path.join(tmp, 'memory', 'ops', 'benchmarks'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'ops', 'benchmarks', 'index.json'),
      events_path: path.join(tmp, 'state', 'ops', 'competitive_benchmark', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'ops', 'competitive_benchmark', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'ops', 'competitive_benchmark', 'receipts.jsonl'),
      scorecards_path: path.join(tmp, 'state', 'ops', 'competitive_benchmark', 'scorecards.jsonl')
    }
  });

  let out = run(['configure', '--owner=jay', '--scenario=default', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  out = run(['run', '--owner=jay', '--scenario=deterministic_001', '--risk-tier=2', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'competitive_benchmark_run');
  assert.ok(fs.existsSync(path.join(tmp, 'state', 'ops', 'competitive_benchmark', 'scorecards.jsonl')));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('competitive_observability_benchmark_pack.test.js: OK');
} catch (err) {
  console.error(`competitive_observability_benchmark_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
