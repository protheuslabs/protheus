#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'full_pipeline_e2e_hardening_pack.js');
function writeJson(filePath, payload) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8'); }
function writeJsonl(filePath, rows) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8'); }
function run(args, env) { return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' }); }
function parseJson(stdout) { const txt = String(stdout || '').trim(); if (!txt) return null; try { return JSON.parse(txt); } catch {} const lines = txt.split('\n').filter(Boolean); for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch {} } return null; }
function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-e2e-hardening-')); const policyPath = path.join(tmp, 'config', 'full_pipeline_e2e_hardening_pack_policy.json');
  const queuePath = path.join(tmp, 'state', 'sensory', 'queue.jsonl'); const receiptsPath = path.join(tmp, 'state', 'actuation', 'receipts.jsonl'); const scorePath = path.join(tmp, 'state', 'ops', 'score.json');
  writeJsonl(queuePath, [{ type: 'proposal_generated' }]); writeJsonl(receiptsPath, [{ type: 'actuation_execution', receipt_contract: { attempted: true } }]); writeJson(scorePath, { score: 0.7 });
  writeJson(policyPath, { version: '1.0-test', enabled: true, inputs: { queue_log_path: queuePath, actuation_receipts_path: receiptsPath, score_path: scorePath }, outputs: { latest_path: path.join(tmp, 'state', 'latest.json'), history_path: path.join(tmp, 'state', 'history.jsonl') } });
  const env = { PIPELINE_E2E_HARDENING_ROOT: tmp, PIPELINE_E2E_HARDENING_POLICY_PATH: policyPath };
  const r = run(['run', '--strict=1'], env); assert.strictEqual(r.status, 0, r.stderr || 'run should pass'); const out = parseJson(r.stdout); assert.ok(out && out.ok === true, 'payload should pass');
  console.log('full_pipeline_e2e_hardening_pack.test.js: OK');
}
try { main(); } catch (err) { console.error(`full_pipeline_e2e_hardening_pack.test.js: FAIL: ${err.message}`); process.exit(1); }
