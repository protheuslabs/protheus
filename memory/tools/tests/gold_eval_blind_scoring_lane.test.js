#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'gold_eval_blind_scoring_lane.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-eval-'));
  const dateStr = '2026-03-02';
  const evalDir = path.join(tmp, 'state', 'sensory', 'eval', 'gold');
  const outDir = path.join(tmp, 'state', 'sensory', 'analysis', 'gold_eval_blind');
  const policyPath = path.join(tmp, 'config', 'gold_eval_blind_scoring_policy.json');

  writeJson(path.join(evalDir, `${dateStr}.json`), {
    corpus_id: 'gold_pack_alpha',
    detector_id: 'candidate_alpha',
    items: [
      { id: 'a', truth: 1, candidate_probability: 0.9 },
      { id: 'b', truth: 1, candidate_probability: 0.8 },
      { id: 'c', truth: 0, candidate_probability: 0.2 },
      { id: 'd', truth: 0, candidate_probability: 0.3 },
      { id: 'e', truth: 1, candidate_probability: 0.65 },
      { id: 'f', truth: 0, candidate_probability: 0.45 }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    prediction_key: 'candidate_probability',
    truth_key: 'truth',
    decision_threshold: 0.5,
    blind_salt: 'test_salt',
    thresholds: {
      min_precision: 0.62,
      min_recall: 0.55,
      min_f1: 0.58,
      max_brier: 0.28
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
  assert.ok(out.payload && out.payload.type === 'gold_eval_blind_scoring_lane', 'run should produce eval output');
  assert.strictEqual(out.payload.promotion_gate.pass, true, 'sample pack should pass promotion thresholds');
  assert.ok(Number(out.payload.metrics.precision || 0) >= 0.62, 'precision threshold should pass');
  assert.ok(Number(out.payload.metrics.recall || 0) >= 0.55, 'recall threshold should pass');
  assert.ok(Number(out.payload.metrics.f1 || 0) >= 0.58, 'f1 threshold should pass');
  assert.ok(Number(out.payload.metrics.brier || 1) <= 0.28, 'brier threshold should pass');
  assert.ok(Array.isArray(out.payload.scored_rows) && out.payload.scored_rows.length === 6, 'scored rows should include blinded outputs');

  out = run(['status', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'gold_eval_blind_scoring_lane', 'status should read output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('gold_eval_blind_scoring_lane.test.js: OK');
} catch (err) {
  console.error(`gold_eval_blind_scoring_lane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
