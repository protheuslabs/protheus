#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'detector_error_taxonomy_autotune.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-autotune-'));
  const dateStr = '2026-03-02';
  const evalDir = path.join(tmp, 'state', 'sensory', 'eval', 'champion_challenger');
  const outDir = path.join(tmp, 'state', 'sensory', 'analysis', 'detector_autotune');
  const policyPath = path.join(tmp, 'config', 'detector_error_taxonomy_autotune_policy.json');

  writeJson(path.join(evalDir, `${dateStr}.json`), {
    challenger_id: 'detector_candidate_v6',
    items: [
      { id: '1', truth: 0, challenger_probability: 0.91 },
      { id: '2', truth: 0, challenger_probability: 0.83 },
      { id: '3', truth: 0, challenger_probability: 0.71 },
      { id: '4', truth: 1, challenger_probability: 0.66 },
      { id: '5', truth: 1, challenger_probability: 0.63 },
      { id: '6', truth: 1, challenger_probability: 0.58 }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    probability_key: 'challenger_probability',
    decision_threshold_default: 0.5,
    fp_target_rate: 0.12,
    fn_target_rate: 0.12,
    max_threshold_step: 0.04,
    regression_f1_tolerance: 0.2,
    rollback_on_regression: true,
    paths: {
      eval_pack_dir: evalDir,
      state_path: path.join(outDir, 'state.json'),
      output_dir: outDir,
      latest_path: path.join(outDir, 'latest.json'),
      receipts_path: path.join(outDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, '--strict=0', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'detector_error_taxonomy_autotune', 'run should produce autotune output');
  assert.ok(Number(out.payload.taxonomy.false_positive_high_confidence || 0) >= 1, 'taxonomy should classify high-confidence false positives');
  assert.ok(Number(out.payload.threshold.proposed || 0) >= Number(out.payload.threshold.before || 0), 'threshold should increase when fp rate is above target');

  out = run(['status', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'detector_error_taxonomy_autotune', 'status should read output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('detector_error_taxonomy_autotune.test.js: OK');
} catch (err) {
  console.error(`detector_error_taxonomy_autotune.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
