#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'habits', 'habit_promotion_quality_gate.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'habit-promotion-quality-'));
  const policyPath = path.join(tmp, 'config', 'habit_promotion_quality_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    thresholds: {
      min_sample_count: 4,
      min_time_saved_minutes_per_week: 30,
      min_effect_delta: 0.05,
      min_adoption_rate: 0.5
    },
    outputs: {
      latest_path: path.join(tmp, 'state', 'habits', 'habit_promotion_quality', 'latest.json'),
      history_path: path.join(tmp, 'state', 'habits', 'habit_promotion_quality', 'history.jsonl')
    }
  });

  const env = {
    HABIT_PROMOTION_QUALITY_ROOT: tmp,
    HABIT_PROMOTION_QUALITY_POLICY_PATH: policyPath
  };

  let r = run(['evaluate', '--strict=1', '--candidate-json={"id":"h1","sample_count":2,"baseline_minutes":80,"current_minutes":70,"success_rate_before":0.4,"success_rate_after":0.42,"adoption_rate":0.4}'], env);
  assert.notStrictEqual(r.status, 0, 'weak candidate should fail strict gate');
  let out = parseJson(r.stdout);
  assert.ok(out && out.ok === false, 'weak payload should fail');

  r = run(['evaluate', '--strict=1', '--candidate-json={"id":"h2","sample_count":8,"baseline_minutes":110,"current_minutes":50,"success_rate_before":0.5,"success_rate_after":0.7,"adoption_rate":0.8}'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'strong candidate should pass');
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'strong payload should pass');

  console.log('habit_promotion_quality_gate.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`habit_promotion_quality_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
