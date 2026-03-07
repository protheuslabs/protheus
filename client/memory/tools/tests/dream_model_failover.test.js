#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'memory', 'dream_model_failover.js');

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeJson(filePath, payload) {
  writeText(filePath, `${JSON.stringify(payload, null, 2)}\n`);
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-model-failover-'));
  const policyPath = path.join(tmp, 'config', 'dream_model_failover_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    models: ['model/a', 'model/b'],
    base_cooldown_minutes: 10,
    max_cooldown_minutes: 60,
    outputs: {
      state_path: path.join(tmp, 'state', 'memory', 'dream_model_failover', 'state.json'),
      latest_path: path.join(tmp, 'state', 'memory', 'dream_model_failover', 'latest.json'),
      history_path: path.join(tmp, 'state', 'memory', 'dream_model_failover', 'history.jsonl')
    }
  });

  const env = {
    DREAM_MODEL_FAILOVER_ROOT: tmp,
    DREAM_MODEL_FAILOVER_POLICY_PATH: policyPath
  };

  let r = run(['record', '--model=model/a', '--result=timeout', '--reason=timeout', '--apply=1', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'failure record should pass');
  let out = parseJson(r.stdout);
  assert.ok(out && out.health && Number(out.health.failure_streak || 0) === 1, 'failure streak should increment');

  r = run(['select', '--preferred=model/a', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'select should pass');
  out = parseJson(r.stdout);
  assert.ok(out && out.selected && out.selected.selected_model === 'model/b', 'should fail over to secondary model while primary cooling down');

  r = run(['record', '--model=model/a', '--result=ok', '--apply=1', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'success record should pass');
  out = parseJson(r.stdout);
  assert.strictEqual(Number(out.health.failure_streak || 0), 0, 'success should reset failure streak');

  console.log('dream_model_failover.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`dream_model_failover.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
