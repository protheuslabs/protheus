#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'strategy', 'weekly_strategy_synthesis.js');

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function writeJson(p, obj) { mkdirp(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }
function writeJsonl(p, rows) { mkdirp(path.dirname(p)); fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); }

function run(args, env) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout || '').trim()); } catch {}
  return { status: r.status ?? 0, payload, stderr: String(r.stderr || '') };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-synthesis-'));
  const proposalsDir = path.join(tmp, 'proposals');
  const queueDir = path.join(tmp, 'queue');
  const outDir = path.join(tmp, 'out');

  writeJson(path.join(proposalsDir, '2026-02-21.json'), [
    { id: 'P1', type: 'collector_remediation', meta: { source_eye: 'hn_frontpage' } },
    { id: 'P2', type: 'collector_remediation', meta: { source_eye: 'moltbook_feed' } },
    { id: 'P3', type: 'revenue_probe', meta: { source_eye: 'moltbook_feed' } }
  ]);

  writeJsonl(path.join(queueDir, '2026-02-21.jsonl'), [
    { type: 'outcome', proposal_id: 'P1', outcome: 'no_change', ts: '2026-02-21T10:00:00.000Z' },
    { type: 'outcome', proposal_id: 'P2', outcome: 'shipped', ts: '2026-02-21T10:05:00.000Z' },
    { type: 'outcome', proposal_id: 'P3', outcome: 'shipped', ts: '2026-02-21T10:10:00.000Z' }
  ]);

  const env = {
    STRATEGY_SYNTHESIS_PROPOSALS_DIR: proposalsDir,
    STRATEGY_SYNTHESIS_QUEUE_DECISIONS_DIR: queueDir,
    STRATEGY_SYNTHESIS_OUTPUT_DIR: outDir
  };

  const r = run(['run', '2026-02-21', '--days=1', '--write=1'], env);
  assert.strictEqual(r.status, 0, `run should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'payload ok expected');
  assert.strictEqual(r.payload.summary.totals.outcomes, 3, 'expected 3 outcomes');
  assert.ok(Array.isArray(r.payload.summary.by_proposal_type), 'by_proposal_type expected');
  assert.ok(Array.isArray(r.payload.summary.recommended_weight_updates), 'recommended_weight_updates expected');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('weekly_strategy_synthesis.test.js: OK');
} catch (err) {
  console.error(`weekly_strategy_synthesis.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
