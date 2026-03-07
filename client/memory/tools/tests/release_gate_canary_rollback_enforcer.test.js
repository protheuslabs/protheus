#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'release_gate_canary_rollback_enforcer.js');
function writeJson(filePath, payload) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8'); }
function run(args, env) { return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' }); }
function parseJson(stdout) { const txt = String(stdout || '').trim(); if (!txt) return null; try { return JSON.parse(txt); } catch {} const lines = txt.split('\n').filter(Boolean); for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch {} } return null; }
function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-canary-')); const policyPath = path.join(tmp, 'config', 'release_gate_canary_rollback_enforcer_policy.json');
  writeJson(policyPath, { version: '1.0-test', enabled: true, thresholds: { canary_pass_rate_min: 0.6 }, outputs: { latest_path: path.join(tmp, 'state', 'latest.json'), history_path: path.join(tmp, 'state', 'history.jsonl') } });
  const env = { RELEASE_GATE_CANARY_ROOT: tmp, RELEASE_GATE_CANARY_POLICY_PATH: policyPath };
  let r = run(['gate', '--canary_pass_rate=0.8', '--rollback_ready=1', '--strict=1'], env); assert.strictEqual(r.status, 0, r.stderr || 'good gate should pass');
  r = run(['gate', '--canary_pass_rate=0.5', '--rollback_ready=0', '--strict=1'], env); assert.notStrictEqual(r.status, 0, 'bad gate should fail strict');
  const out = parseJson(r.stdout); assert.ok(out && out.ok === false && out.blockers.length >= 1, 'bad gate payload should include blockers');
  console.log('release_gate_canary_rollback_enforcer.test.js: OK');
}
try { main(); } catch (err) { console.error(`release_gate_canary_rollback_enforcer.test.js: FAIL: ${err.message}`); process.exit(1); }
