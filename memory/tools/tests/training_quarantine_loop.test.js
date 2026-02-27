#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = (rows || []).map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function parseJson(stdout) {
  const raw = String(stdout || '').trim();
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'nursery', 'training_quarantine_loop.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'training-quarantine-loop-'));

  const policyPath = path.join(tmp, 'config', 'training_quarantine_policy.json');
  const pendingQueuePath = path.join(tmp, 'state', 'nursery', 'training', 'workflow_learning_queue.jsonl');
  const canaryQueuePath = path.join(tmp, 'state', 'nursery', 'training', 'workflow_learning_canary.jsonl');
  const masterQueuePath = path.join(tmp, 'state', 'nursery', 'training', 'continuum_queue.jsonl');
  const statePath = path.join(tmp, 'state', 'nursery', 'training', 'quarantine_state.json');
  const receiptsPath = path.join(tmp, 'state', 'nursery', 'training', 'quarantine_receipts.jsonl');
  const latestPath = path.join(tmp, 'state', 'nursery', 'training', 'quarantine_latest.json');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    canary: {
      min_score: 0.8,
      max_regression_rate: 0.2
    },
    paths: {
      pending_queue_path: pendingQueuePath,
      canary_queue_path: canaryQueuePath,
      master_queue_path: masterQueuePath,
      state_path: statePath,
      receipts_path: receiptsPath,
      latest_path: latestPath
    }
  });

  writeJsonl(pendingQueuePath, [
    {
      entry_id: 'lq_alpha',
      workflow_id: 'wf_alpha',
      stage: 'pending_canary'
    }
  ]);
  writeJsonl(canaryQueuePath, []);
  writeJsonl(masterQueuePath, []);

  const runCmd = (args) => spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    encoding: 'utf8'
  });

  let proc = runCmd(['stage', `--policy=${policyPath}`, '--apply=1']);
  assert.strictEqual(proc.status, 0, proc.stderr || proc.stdout);
  let out = parseJson(proc.stdout);
  assert.ok(out && out.ok === true, 'stage should succeed');
  assert.strictEqual(Number(out.staged || 0), 1, 'one checkpoint should be staged');

  proc = runCmd([
    'evaluate',
    `--policy=${policyPath}`,
    '--entry-id=lq_alpha',
    '--slo-pass=1',
    '--score=0.92',
    '--regression-rate=0.03',
    '--apply=1'
  ]);
  assert.strictEqual(proc.status, 0, proc.stderr || proc.stdout);
  out = parseJson(proc.stdout);
  assert.ok(out && out.ok === true, 'evaluate pass should succeed');
  assert.strictEqual(Number(out.promoted_count || 0), 1, 'checkpoint should be promoted');
  assert.strictEqual(String(out.status || ''), 'promoted');

  proc = runCmd([
    'evaluate',
    `--policy=${policyPath}`,
    '--entry-id=lq_alpha',
    '--slo-pass=0',
    '--score=0.3',
    '--regression-rate=0.6',
    '--apply=1'
  ]);
  assert.strictEqual(proc.status, 0, proc.stderr || proc.stdout);
  out = parseJson(proc.stdout);
  assert.ok(out && out.ok === true, 'evaluate regression should still return ok payload');
  assert.strictEqual(Number(out.rollback_count || 0), 1, 'checkpoint should auto-rollback on regression');
  assert.strictEqual(String(out.status || ''), 'rolled_back');

  const masterRows = fs.readFileSync(masterQueuePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(masterRows.some((row) => row && row.stage === 'promoted'), 'promotion row missing');
  assert.ok(masterRows.some((row) => row && row.stage === 'rolled_back'), 'rollback row missing');

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const checkpoint = state.checkpoints && state.checkpoints.lq_alpha;
  assert.ok(checkpoint, 'checkpoint state should exist');
  assert.strictEqual(checkpoint.status, 'rolled_back', 'checkpoint should be marked rolled back');

  console.log('training_quarantine_loop.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`training_quarantine_loop.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
