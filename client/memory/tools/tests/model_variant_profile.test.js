#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'routing', 'model_variant_profile.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-variant-profile-'));
  const policyPath = path.join(tmp, 'config', 'model_variant_profile_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    thinking_suffix: ':thinking',
    min_quality_gain_pct: 12,
    max_consecutive_thinking: 2,
    thinking_task_types: ['analysis'],
    outputs: {
      state_path: path.join(tmp, 'state', 'routing', 'model_variant_profile', 'state.json'),
      latest_path: path.join(tmp, 'state', 'routing', 'model_variant_profile', 'latest.json'),
      history_path: path.join(tmp, 'state', 'routing', 'model_variant_profile', 'history.jsonl')
    }
  });

  const env = {
    MODEL_VARIANT_PROFILE_ROOT: tmp,
    MODEL_VARIANT_PROFILE_POLICY_PATH: policyPath
  };

  let r = run(['select', '--model=ollama/qwen3:8b', '--task-type=analysis', '--quality-gain=20', '--apply=1', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'thinking-eligible select should pass');
  let out = parseJson(r.stdout);
  assert.ok(out && out.selected_model.endsWith(':thinking'), 'should choose thinking variant when justified');

  r = run(['select', '--model=ollama/qwen3:8b', '--task-type=analysis', '--quality-gain=2', '--apply=1', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'fallback select should pass');
  out = parseJson(r.stdout);
  assert.strictEqual(out.selected_model, 'ollama/qwen3:8b', 'low quality gain should auto-return to base model');
  assert.strictEqual(out.decision.auto_returned, true, 'auto-return should be explicit');

  console.log('model_variant_profile.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`model_variant_profile.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
