#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'low_urgency_batch_execution_lane.js');
function writeJson(filePath, payload) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8'); }
function run(args, env) { return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' }); }
function parseJson(stdout) { const txt = String(stdout || '').trim(); if (!txt) return null; try { return JSON.parse(txt); } catch {} const lines = txt.split('\n').filter(Boolean); for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch {} } return null; }
function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'low-urg-batch-')); const policyPath = path.join(tmp, 'config', 'low_urgency_batch_execution_lane_policy.json');
  writeJson(policyPath, { version: '1.0-test', enabled: true, batch: { max_tasks_per_batch: 2, max_tokens_per_batch: 500 }, outputs: { latest_path: path.join(tmp, 'state', 'latest.json'), history_path: path.join(tmp, 'state', 'history.jsonl') } });
  const env = { LOW_URGENCY_BATCH_ROOT: tmp, LOW_URGENCY_BATCH_POLICY_PATH: policyPath };
  const rows = JSON.stringify([{ id: 'a', urgency: 'low', tokens: 200 }, { id: 'b', urgency: 'low', tokens: 200 }, { id: 'c', urgency: 'high', tokens: 200 }, { id: 'd', urgency: 'low', tokens: 200 }]);
  const r = run(['run', `--tasks-json=${rows}`, '--strict=1'], env); assert.strictEqual(r.status, 0, r.stderr || 'run should pass');
  const out = parseJson(r.stdout); assert.ok(out && out.ok === true, 'payload should pass'); assert.strictEqual(Number(out.deferred_count || 0), 1, 'high urgency should defer'); assert.strictEqual(Number(out.batches.length || 0), 2, 'should batch low urgency tasks');
  console.log('low_urgency_batch_execution_lane.test.js: OK');
}
try { main(); } catch (err) { console.error(`low_urgency_batch_execution_lane.test.js: FAIL: ${err.message}`); process.exit(1); }
