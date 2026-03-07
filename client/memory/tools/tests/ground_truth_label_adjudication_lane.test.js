#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'ground_truth_label_adjudication_lane.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'label-adjudication-'));
  const dateStr = '2026-03-02';
  const rawDir = path.join(tmp, 'state', 'sensory', 'labels', 'raw');
  const adjudicatedDir = path.join(tmp, 'state', 'sensory', 'labels', 'adjudicated');
  const promotionDir = path.join(tmp, 'state', 'sensory', 'labels', 'promotion_corpus');
  const quarantineDir = path.join(tmp, 'state', 'sensory', 'labels', 'quarantine');
  const policyPath = path.join(tmp, 'config', 'ground_truth_label_adjudication_policy.json');

  writeJson(path.join(rawDir, `${dateStr}.json`), {
    labels: [
      {
        label_id: 'lbl_good',
        example_id: 'ex_1',
        reviewer_labels: [
          { reviewer: 'r1', label: 'positive', confidence: 0.9 },
          { reviewer: 'r2', label: 'positive', confidence: 0.8 },
          { reviewer: 'r3', label: 'positive', confidence: 0.7 }
        ]
      },
      {
        label_id: 'lbl_bad',
        example_id: 'ex_2',
        reviewer_labels: [
          { reviewer: 'r1', label: 'positive', confidence: 0.4 },
          { reviewer: 'r2', label: 'negative', confidence: 0.4 }
        ]
      }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    min_reviewer_count: 2,
    min_agreement_ratio: 0.67,
    min_avg_confidence: 0.55,
    paths: {
      raw_labels_dir: rawDir,
      adjudicated_dir: adjudicatedDir,
      promotion_corpus_dir: promotionDir,
      quarantine_dir: quarantineDir,
      latest_path: path.join(adjudicatedDir, 'latest.json'),
      receipts_path: path.join(adjudicatedDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, '--strict=0', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'ground_truth_label_adjudication_lane', 'run should produce adjudication output');
  assert.strictEqual(Number(out.payload.total_labels || 0), 2, 'two labels should be adjudicated');
  assert.strictEqual(Number(out.payload.accepted_labels || 0), 1, 'one label should be accepted');
  assert.strictEqual(Number(out.payload.quarantined_labels || 0), 1, 'one label should be quarantined');

  out = run(['status', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'ground_truth_label_adjudication_lane', 'status should read output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ground_truth_label_adjudication_lane.test.js: OK');
} catch (err) {
  console.error(`ground_truth_label_adjudication_lane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
