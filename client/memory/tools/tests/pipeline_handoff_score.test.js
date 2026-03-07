#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'pipeline_handoff_score.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-handoff-score-'));
  const policyPath = path.join(tmp, 'config', 'pipeline_handoff_score_policy.json');
  const queueLogPath = path.join(tmp, 'state', 'sensory', 'queue_log.jsonl');
  const receiptLogPath = path.join(tmp, 'state', 'actuation', 'receipts', 'today.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    thresholds: { min_score: 0.45 },
    weights: {
      generation: 0.2,
      queue_quality: 0.2,
      execution: 0.3,
      verification: 0.3
    },
    outputs: {
      latest_path: path.join(tmp, 'state', 'ops', 'score_latest.json'),
      history_path: path.join(tmp, 'state', 'ops', 'score_history.jsonl')
    }
  });

  writeJsonl(queueLogPath, [
    { type: 'proposal_generated', proposal_id: 'p1' },
    { type: 'proposal_generated', proposal_id: 'p2' },
    { type: 'proposal_filtered', proposal_id: 'p2', filter_reason: 'action_spec_missing' }
  ]);

  writeJsonl(receiptLogPath, [
    { type: 'actuation_execution', ok: true, receipt_contract: { attempted: true, verified: true } },
    { type: 'actuation_execution', ok: false, receipt_contract: { attempted: true, verified: false } }
  ]);

  const env = {
    PIPELINE_HANDOFF_SCORE_ROOT: tmp,
    PIPELINE_HANDOFF_SCORE_POLICY_PATH: policyPath
  };

  let r = run(['score', `--queue-log=${queueLogPath}`, `--receipt-log=${receiptLogPath}`, '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'score should pass threshold');
  let out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'score payload should pass');
  assert.ok(Number(out.score || 0) >= 0.45, 'score must meet threshold');
  assert.strictEqual(Number(out.metrics.generated || 0), 2, 'generated metric mismatch');
  assert.strictEqual(Number(out.metrics.executed || 0), 2, 'executed metric mismatch');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    thresholds: { min_score: 0.95 },
    outputs: {
      latest_path: path.join(tmp, 'state', 'ops', 'score_latest.json'),
      history_path: path.join(tmp, 'state', 'ops', 'score_history.jsonl')
    }
  });

  r = run(['score', `--queue-log=${queueLogPath}`, `--receipt-log=${receiptLogPath}`, '--strict=1'], env);
  assert.notStrictEqual(r.status, 0, 'strict score should fail high threshold');
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === false, 'payload should fail when below threshold');

  console.log('pipeline_handoff_score.test.js: OK');
}

try { main(); } catch (err) { console.error(`pipeline_handoff_score.test.js: FAIL: ${err.message}`); process.exit(1); }
