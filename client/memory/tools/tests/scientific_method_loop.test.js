#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'science', 'scientific_method_loop.js');

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
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sci-loop-'));
  const policyPath = path.join(tmp, 'config', 'scientific_method_loop_policy.json');
  const latestPath = path.join(tmp, 'state', 'science', 'loop', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'science', 'loop', 'history.jsonl');
  const runsDir = path.join(tmp, 'state', 'science', 'loop', 'runs');
  const replayPath = path.join(tmp, 'state', 'science', 'loop', 'replay_latest.json');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_contracts: true,
    minimum_lengths: {
      observation: 5,
      question: 5,
      hypothesis: 5,
      prediction: 5
    },
    paths: {
      latest_path: latestPath,
      history_path: historyPath,
      runs_dir: runsDir,
      replay_latest_path: replayPath
    }
  });

  const env = {
    SCI_LOOP_ROOT: tmp,
    SCI_LOOP_POLICY_PATH: policyPath
  };

  let out = run([
    'run',
    '--observation=Revenue dipped after pricing changed.',
    '--question=Why did conversion drop?',
    '--hypothesis=If price increased, then conversion will decline.',
    '--prediction=Conversion rate will recover when price is restored.',
    '--experiment-json={"type":"ab_test","duration_days":7}',
    '--outcome-json={"effect_size":0.12,"p_value":0.03}'
  ], env);
  assert.strictEqual(out.status, 0, out.stderr || 'run should pass');
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'run payload should be ok');
  assert.ok(Array.isArray(payload.steps) && payload.steps.length === 8, 'scientific loop should include 8 steps');
  assert.ok(payload.receipt_id && payload.signature, 'receipt/signature should exist');
  assert.ok(fs.existsSync(latestPath), 'latest should exist');

  out = run(['replay', `--run-file=${payload.run_path}`], env);
  assert.strictEqual(out.status, 0, out.stderr || 'replay should pass for unchanged run');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'replay payload should be ok');

  out = run(['status'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'status should pass');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'status payload should be ok');

  console.log('scientific_method_loop.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`scientific_method_loop.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
