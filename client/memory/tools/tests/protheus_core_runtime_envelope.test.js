#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'protheus_core_runtime_envelope.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  const lines = txt.split('\n').map((line) => line.trim()).filter(Boolean);
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-envelope-'));
  const policyPath = path.join(tmp, 'config', 'protheus_core_runtime_envelope_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'ops.protheus_core_envelope' },
    envelope: {
      max_mb: 50,
      max_ms: 2000,
      required_profiles: ['minimal'],
      flag_matrix: [
        { id: 'minimal', spine: false, reflex: false, gates: false },
        { id: 'full', spine: true, reflex: true, gates: true }
      ]
    },
    paths: {
      memory_dir: path.join(tmp, 'memory', 'ops', 'protheus_core_runtime_envelope'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'ops', 'protheus_core_runtime_envelope', 'index.json'),
      events_path: path.join(tmp, 'state', 'ops', 'protheus_core_runtime_envelope', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'ops', 'protheus_core_runtime_envelope', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'ops', 'protheus_core_runtime_envelope', 'receipts.jsonl'),
      trend_path: path.join(tmp, 'state', 'ops', 'protheus_core_runtime_envelope', 'trend.json')
    }
  });

  let out = run(['run', '--owner=jay', '--strict=1', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'protheus_core_runtime_envelope_run');

  out = run(['status', '--owner=jay', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(Number(out.payload.trend_runs || 0) >= 1, true);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('protheus_core_runtime_envelope.test.js: OK');
} catch (err) {
  console.error(`protheus_core_runtime_envelope.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
