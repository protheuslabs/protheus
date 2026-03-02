#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'edge', 'mobile_lifecycle_resilience.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-lifecycle-'));
  const policyPath = path.join(tmp, 'config', 'mobile_lifecycle_resilience_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'edge.lifecycle' },
    thresholds: {
      battery_soft_pct: 30,
      battery_hard_pct: 18,
      thermal_soft_c: 42,
      thermal_hard_c: 48,
      background_kill_soft: 2,
      background_kill_hard: 4,
      wake_lock_soft_min: 20,
      wake_lock_hard_min: 45,
      target_autonomy_hours: 72
    },
    paths: {
      memory_dir: path.join(tmp, 'memory', 'edge', 'lifecycle'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'edge', 'lifecycle', 'index.json'),
      events_path: path.join(tmp, 'state', 'edge', 'mobile_lifecycle', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'edge', 'mobile_lifecycle', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'edge', 'mobile_lifecycle', 'receipts.jsonl'),
      lifecycle_state_path: path.join(tmp, 'state', 'edge', 'mobile_lifecycle', 'state.json')
    }
  });

  let out = run(['run', '--owner=jay', '--battery=12', '--thermal=47', '--background-kills=5', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'mobile_lifecycle_evaluated');

  out = run(['status', '--owner=jay', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.lifecycle.action, 'pause');

  out = run([
    'run',
    '--owner=jay',
    '--battery=80',
    '--thermal=35',
    '--background-kills=0',
    '--wake-lock-minutes=5',
    '--uptime-hours=80',
    '--apply=1',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);

  out = run(['status', '--owner=jay', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.lifecycle.survives_72h_target, true);

  out = run(['recover', '--owner=jay', '--reason=background_kill', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'mobile_lifecycle_recover');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('mobile_lifecycle_resilience.test.js: OK');
} catch (err) {
  console.error(`mobile_lifecycle_resilience.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
