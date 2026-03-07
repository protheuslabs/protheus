#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'science', 'advanced_statistical_extensions.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-stats-'));
  const policyPath = path.join(tmp, 'config', 'advanced_statistical_extensions_policy.json');
  const latestPath = path.join(tmp, 'state', 'science', 'advanced_statistical_extensions', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'science', 'advanced_statistical_extensions', 'history.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    min_sample_size: 90,
    min_accuracy_score: 0.5,
    max_uncertainty_width: 0.6,
    causal_models: ['did', 'synthetic_control'],
    uncertainty_confidence_levels: [0.8, 0.9],
    ensemble_methods: ['bayesian_model_average', 'stacked_regression'],
    fallback_engine: 'ts_stat_extensions',
    allow_external_python: false,
    allow_external_rust: false,
    paths: {
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  let out = run(['run', '--sample_size=240', '--brier_score=0.21', '--causal_precision_lift=0.04', '--effect_size=0.17', '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'extensions should pass under healthy metrics');
  assert.ok(out.payload.selected_model, 'selected model should be present');

  out = run(['run', '--sample_size=12', '--brier_score=0.49', '--causal_precision_lift=0.0', '--effect_size=0.05', '--strict=1', `--policy=${policyPath}`]);
  assert.notStrictEqual(out.status, 0, 'strict run should fail with low sample size and weak quality');
  assert.strictEqual(out.payload.ok, false, 'extensions should fail under weak metrics');

  out = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.latest, 'status should return latest snapshot');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('advanced_statistical_extensions.test.js: OK');
} catch (err) {
  console.error(`advanced_statistical_extensions.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
