#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'composite_disaster_gameday.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'composite-gameday-'));
  const policyPath = path.join(tmp, 'config', 'composite_disaster_gameday_policy.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'composite_disaster_gameday', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'composite_disaster_gameday', 'history.jsonl');
  const postmortemDir = path.join(tmp, 'state', 'ops', 'composite_disaster_gameday', 'postmortems');

  writeJson(policyPath, {
    schema_id: 'composite_disaster_gameday_policy',
    schema_version: '1.0-test',
    enabled: true,
    strict_default: false,
    cadence_hours: 1,
    max_total_duration_ms: 20000,
    require_postmortem: true,
    scenarios: [
      {
        id: 'restore_path_probe',
        stage: 'restore',
        required: true,
        timeout_ms: 10000,
        command: ['node', '-e', 'process.exit(0)']
      },
      {
        id: 'tamper_detection_probe',
        stage: 'tamper',
        required: true,
        timeout_ms: 10000,
        command: ['node', '-e', 'process.exit(0)']
      }
    ],
    outputs: {
      latest_path: latestPath,
      history_path: historyPath,
      postmortem_dir: postmortemDir
    }
  });

  const env = {
    COMPOSITE_GAMEDAY_ROOT: tmp,
    COMPOSITE_GAMEDAY_POLICY_PATH: policyPath
  };

  let out = run(['run', '--strict=1'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'composite run should pass strict');
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'gameday run should be ok');
  assert.ok(Array.isArray(payload.scenarios) && payload.scenarios.length === 2, 'expected two scenarios');
  assert.ok(fs.existsSync(latestPath), 'latest output should exist');
  assert.ok(fs.existsSync(historyPath), 'history output should exist');
  const postmortems = fs.existsSync(postmortemDir)
    ? fs.readdirSync(postmortemDir).filter((f) => f.endsWith('.md'))
    : [];
  assert.ok(postmortems.length >= 1, 'postmortem markdown should be generated');

  writeJson(policyPath, {
    schema_id: 'composite_disaster_gameday_policy',
    schema_version: '1.0-test',
    enabled: true,
    strict_default: false,
    cadence_hours: 1,
    max_total_duration_ms: 20000,
    require_postmortem: true,
    scenarios: [
      {
        id: 'restore_path_probe',
        stage: 'restore',
        required: true,
        timeout_ms: 10000,
        command: ['node', '-e', 'process.exit(1)']
      }
    ],
    outputs: {
      latest_path: latestPath,
      history_path: historyPath,
      postmortem_dir: postmortemDir
    }
  });

  out = run(['run', '--strict=0'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'non-strict run should complete');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === false, 'required failed scenario should fail gameday');
  assert.ok(
    Array.isArray(payload.reasons) && payload.reasons.some((r) => String(r).includes('required_scenario_failed')),
    'required_scenario_failed reason should be present'
  );

  out = run(['status'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'status should execute');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'status payload should be ok');
  assert.ok(payload.latest && payload.latest.type === 'composite_disaster_gameday', 'status should expose latest drill');

  console.log('composite_disaster_gameday.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`composite_disaster_gameday.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
