#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'counterfactual_signal_replay.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'counterfactual-replay-'));
  const policyPath = path.join(tmp, 'config', 'counterfactual_signal_replay_policy.json');
  const hypothesesDir = path.join(tmp, 'state', 'sensory', 'cross_signal', 'hypotheses');
  const outDir = path.join(tmp, 'state', 'sensory', 'analysis', 'counterfactual_replay');
  const currentDate = '2026-03-02';
  const pastDate = '2025-09-03'; // 180 days before 2026-03-02

  writeJson(path.join(hypothesesDir, `${pastDate}.json`), {
    type: 'cross_signal_hypotheses',
    date: pastDate,
    hypotheses: [
      { id: 'p1', confidence: 75, probability: 0.71, support_events: 1 },
      { id: 'p2', confidence: 72, probability: 0.7, support_events: 1 },
      { id: 'p3', confidence: 69, probability: 0.65, support_events: 2 }
    ]
  });

  writeJson(path.join(hypothesesDir, `${currentDate}.json`), {
    type: 'cross_signal_hypotheses',
    date: currentDate,
    hypotheses: [
      { id: 'c1', confidence: 81, probability: 0.8, support_events: 7 },
      { id: 'c2', confidence: 74, probability: 0.76, support_events: 5 },
      { id: 'c3', confidence: 67, probability: 0.68, support_events: 4 }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    offset_days: 180,
    thresholds: {
      min_confidence: 60,
      min_probability: 0.6,
      min_support_events: 3,
      min_precision_uplift: 0.0,
      min_recall_uplift: 0.0
    },
    paths: {
      hypotheses_dir: hypothesesDir,
      output_dir: outDir,
      latest_path: path.join(outDir, 'latest.json'),
      receipts_path: path.join(outDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', currentDate, `--policy=${policyPath}`, '--strict=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'replay should pass');
  assert.strictEqual(out.payload.counterfactual_date, pastDate, 'counterfactual date should be computed from offset');
  assert.strictEqual(out.payload.promotion_blocked, false, 'positive uplift should not block promotion');
  assert.ok(Number(out.payload.deltas.precision_uplift || 0) > 0, 'precision uplift should be positive');
  assert.ok(Number(out.payload.deltas.recall_uplift || 0) > 0, 'recall uplift should be positive');

  out = run(['status', currentDate, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'counterfactual_signal_replay', 'status should read replay output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('counterfactual_signal_replay.test.js: OK');
} catch (err) {
  console.error(`counterfactual_signal_replay.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
