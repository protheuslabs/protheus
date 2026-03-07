#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'active_learning_uncertainty_queue.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'active-learning-'));
  const dateStr = '2026-03-02';
  const abstainDir = path.join(tmp, 'state', 'sensory', 'analysis', 'abstain_uncertainty');
  const disagreementDir = path.join(tmp, 'state', 'sensory', 'analysis', 'ensemble_disagreement');
  const labelDir = path.join(tmp, 'state', 'sensory', 'labels', 'promotion_corpus');
  const activeDir = path.join(tmp, 'state', 'sensory', 'analysis', 'active_learning');
  const policyPath = path.join(tmp, 'config', 'active_learning_uncertainty_queue_policy.json');

  writeJson(path.join(abstainDir, `${dateStr}.json`), {
    abstained: [
      { abstain_id: 'abs_1', topic: 'revenue', reason_codes: ['insufficient_confidence', 'insufficient_support_events'] }
    ]
  });
  writeJson(path.join(disagreementDir, `${dateStr}.json`), {
    adjudication_queue: [
      { adjudication_id: 'ens_1', item_id: 'case_1', disagreement_stddev: 0.41 }
    ]
  });
  writeJson(path.join(labelDir, `${dateStr}.json`), {
    labels: [
      { label_id: 'lbl_1' },
      { label_id: 'lbl_2' }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    max_queue_items: 200,
    min_priority: 0.1,
    paths: {
      abstain_dir: abstainDir,
      disagreement_dir: disagreementDir,
      label_promotion_dir: labelDir,
      queue_path: path.join(activeDir, 'queue.jsonl'),
      output_dir: activeDir,
      latest_path: path.join(activeDir, 'latest.json'),
      receipts_path: path.join(activeDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'active_learning_uncertainty_queue', 'run should produce active-learning output');
  assert.strictEqual(Number(out.payload.queued_count || 0), 2, 'two cases should be queued');
  assert.strictEqual(Number(out.payload.accepted_label_feedback_count || 0), 2, 'accepted label feedback should be counted');

  out = run(['status', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'active_learning_uncertainty_queue', 'status should read output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('active_learning_uncertainty_queue.test.js: OK');
} catch (err) {
  console.error(`active_learning_uncertainty_queue.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
