#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'parallel_eyes_budget_aware_lane.js');
function writeJson(filePath, payload) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8'); }
function run(args, env) { return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' }); }
function parseJson(stdout) { const txt = String(stdout || '').trim(); if (!txt) return null; try { return JSON.parse(txt); } catch {} const lines = txt.split('\n').filter(Boolean); for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch {} } return null; }
function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-eyes-lane-')); const policyPath = path.join(tmp, 'config', 'parallel_eyes_budget_aware_lane_policy.json');
  writeJson(policyPath, { version: '1.0-test', enabled: true, budget: { daily_cap_tokens: 1000, degrade_at_ratio: 0.8 }, concurrency: { max_parallel: 4, min_parallel: 1 }, outputs: { latest_path: path.join(tmp, 'state', 'latest.json'), history_path: path.join(tmp, 'state', 'history.jsonl') } });
  const env = { PARALLEL_EYES_LANE_ROOT: tmp, PARALLEL_EYES_LANE_POLICY_PATH: policyPath };
  const eyes = JSON.stringify([{ id: 'e1', token_estimate: 200, priority: 9 }, { id: 'e2', token_estimate: 200, priority: 8 }, { id: 'e3', token_estimate: 200, priority: 7 }, { id: 'e4', token_estimate: 200, priority: 6 }]);
  const r = run(['plan', `--eyes-json=${eyes}`, '--budget-used=850', '--strict=1'], env); assert.strictEqual(r.status, 0, r.stderr || 'plan should pass');
  const out = parseJson(r.stdout); assert.ok(out && out.ok === true, 'payload should pass'); assert.ok(Number(out.selected_eyes.length || 0) <= 2, 'degraded budget should reduce selected eyes');
  console.log('parallel_eyes_budget_aware_lane.test.js: OK');
}
try { main(); } catch (err) { console.error(`parallel_eyes_budget_aware_lane.test.js: FAIL: ${err.message}`); process.exit(1); }
