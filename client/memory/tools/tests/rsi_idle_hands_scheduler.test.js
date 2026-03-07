#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'spine', 'rsi_idle_hands_scheduler.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-idle-scheduler-'));
  const policyPath = path.join(tmp, 'config', 'rsi_idle_hands_scheduler_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'spine.rsi_idle_hands_scheduler' },
    quiet_hours_start: 23,
    quiet_hours_end: 8,
    min_interval_minutes: 1,
    rsi_script: path.join(ROOT, 'adaptive', 'rsi', 'rsi_bootstrap.js'),
    rsi_policy_path: path.join(ROOT, 'config', 'rsi_bootstrap_policy.json'),
    background_hands_script: path.join(ROOT, 'systems', 'spine', 'background_hands_scheduler.js'),
    freshness_script: path.join(ROOT, 'systems', 'research', 'world_model_freshness_loop.js'),
    budget_gate_script: path.join(ROOT, 'systems', 'ops', 'complexity_budget_gate.js'),
    paths: {
      memory_dir: path.join(tmp, 'memory', 'spine', 'rsi_idle_hands_scheduler'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'spine', 'rsi_idle_hands_scheduler', 'index.json'),
      events_path: path.join(tmp, 'state', 'spine', 'rsi_idle_hands_scheduler', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'spine', 'rsi_idle_hands_scheduler', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'spine', 'rsi_idle_hands_scheduler', 'receipts.jsonl'),
      scheduler_state_path: path.join(tmp, 'state', 'spine', 'rsi_idle_hands_scheduler', 'state.json')
    }
  });

  const out = run(['run', '--owner=jay', '--mock=1', '--strict=1', '--force=1', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.event === 'rsi_idle_hands_scheduler_run', 'run should emit scheduler receipt');

  const status = run(['status', '--owner=jay', `--policy=${policyPath}`]);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  assert.ok(status.payload && status.payload.scheduler_state, 'status should include scheduler state');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('rsi_idle_hands_scheduler.test.js: OK');
} catch (err) {
  console.error(`rsi_idle_hands_scheduler.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
