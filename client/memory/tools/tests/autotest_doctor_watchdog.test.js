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
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function parsePayload(stdout) {
  const raw = String(stdout || '').trim();
  assert.ok(raw, 'expected stdout');
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  throw new Error('unable to parse json payload');
}

function runCli(scriptPath, args, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8'
  });
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'ops', 'autotest_doctor_watchdog.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-doctor-watchdog-'));

  const latestPath = path.join(tmp, 'state', 'ops', 'autotest_doctor', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'autotest_doctor', 'history.jsonl');
  const statePath = path.join(tmp, 'state', 'ops', 'autotest_doctor', 'state.json');
  const watchdogStatePath = path.join(tmp, 'state', 'ops', 'autotest_doctor', 'watchdog_state.json');
  const watchdogHistoryPath = path.join(tmp, 'state', 'ops', 'autotest_doctor', 'watchdog_history.jsonl');
  const watchdogBlockPath = path.join(tmp, 'state', 'ops', 'autotest_doctor', 'watchdog_block.json');
  const policyPath = path.join(tmp, 'config', 'autotest_doctor_watchdog_policy.json');

  writeJson(policyPath, {
    enabled: true,
    force_disable_on_violation: true,
    auto_clear_block: true,
    paths: {
      latest: latestPath,
      history: historyPath,
      state: statePath,
      watchdog_state: watchdogStatePath,
      watchdog_history: watchdogHistoryPath,
      watchdog_block: watchdogBlockPath
    }
  });

  writeJson(latestPath, {
    run_id: 'doctor_run_1',
    apply: true,
    recipe_release_gate: { valid: true },
    kill_switch: { engaged: false },
    actions: [
      {
        status: 'applied',
        recipe_id: 'retest_then_pulse',
        recipe_gate: { stage: 'canary', allow_apply: true }
      }
    ]
  });
  writeJson(statePath, {
    kill_switch: { engaged: false }
  });
  writeJsonl(historyPath, [
    {
      ts: '2026-02-27T03:00:00.000Z',
      run_id: 'doctor_run_1'
    }
  ]);

  let r = runCli(scriptPath, ['run', `--policy=${policyPath}`], root);
  assert.strictEqual(r.status, 0, `watchdog healthy run should pass: ${r.stderr}`);
  let out = parsePayload(r.stdout);
  assert.strictEqual(out.ok, true);
  let block = JSON.parse(fs.readFileSync(watchdogBlockPath, 'utf8'));
  assert.strictEqual(block.active, false, 'healthy run should clear block');

  writeJson(latestPath, {
    run_id: 'doctor_run_2',
    apply: true,
    recipe_release_gate: { valid: true },
    kill_switch: { engaged: false },
    actions: []
  });
  // Keep history stale on purpose.
  r = runCli(scriptPath, ['run', `--policy=${policyPath}`], root);
  assert.strictEqual(r.status, 0, `watchdog violation run should still return payload: ${r.stderr}`);
  out = parsePayload(r.stdout);
  assert.strictEqual(out.ok, false, 'watchdog should detect mismatch');
  assert.ok(Array.isArray(out.violations) && out.violations.length >= 1, 'watchdog should report violations');
  block = JSON.parse(fs.readFileSync(watchdogBlockPath, 'utf8'));
  assert.strictEqual(block.active, true, 'violation should activate block');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('autotest_doctor_watchdog.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autotest_doctor_watchdog.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

