#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'champion_challenger_detector_promotion.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'champion-challenger-'));
  const dateStr = '2026-03-02';
  const evalDir = path.join(tmp, 'state', 'sensory', 'eval', 'champion_challenger');
  const outDir = path.join(tmp, 'state', 'sensory', 'analysis', 'champion_challenger');
  const policyPath = path.join(tmp, 'config', 'champion_challenger_detector_policy.json');

  writeJson(path.join(evalDir, `${dateStr}.json`), {
    corpus_id: 'gold_shadow_001',
    champion_id: 'detector_champion_v4',
    challenger_id: 'detector_candidate_v5',
    items: [
      { id: '1', truth: 1, champion_probability: 0.72, challenger_probability: 0.90 },
      { id: '2', truth: 1, champion_probability: 0.61, challenger_probability: 0.83 },
      { id: '3', truth: 0, champion_probability: 0.57, challenger_probability: 0.25 },
      { id: '4', truth: 0, champion_probability: 0.51, challenger_probability: 0.18 },
      { id: '5', truth: 1, champion_probability: 0.54, challenger_probability: 0.78 },
      { id: '6', truth: 0, champion_probability: 0.49, challenger_probability: 0.29 }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    decision_threshold: 0.5,
    uplift_policy: {
      min_f1_uplift: 0.01,
      min_precision_delta: -0.01,
      min_recall_delta: -0.01,
      max_brier_regression: 0.01
    },
    paths: {
      eval_pack_dir: evalDir,
      output_dir: outDir,
      latest_path: path.join(outDir, 'latest.json'),
      receipts_path: path.join(outDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'champion_challenger_detector_promotion', 'run should produce promotion output');
  assert.strictEqual(out.payload.promotion.pass, true, 'challenger should pass non-regression promotion gate');
  assert.ok(Number(out.payload.promotion.deltas.f1 || 0) > 0, 'challenger should improve F1');
  assert.ok(Number(out.payload.promotion.deltas.brier || 1) <= 0.01, 'challenger should not regress brier beyond policy');

  out = run(['status', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'champion_challenger_detector_promotion', 'status should read output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('champion_challenger_detector_promotion.test.js: OK');
} catch (err) {
  console.error(`champion_challenger_detector_promotion.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
