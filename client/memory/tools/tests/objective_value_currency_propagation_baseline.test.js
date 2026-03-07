#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'objective_value_currency_propagation_baseline.js');
function writeJson(filePath, payload) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8'); }
function run(args, env) { return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' }); }
function parseJson(stdout) { const txt = String(stdout || '').trim(); if (!txt) return null; try { return JSON.parse(txt); } catch {} const lines = txt.split('\n').filter(Boolean); for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch {} } return null; }
function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obj-currency-prop-')); const policyPath = path.join(tmp, 'config', 'obj_policy.json');
  writeJson(policyPath, { version: '1.0-test', enabled: true, objective_currency_map: { T1: { revenue: 0.7, reliability: 0.2, velocity: 0.1 }, DEFAULT: { revenue: 0.5, reliability: 0.3, velocity: 0.2 } }, outputs: { latest_path: path.join(tmp, 'state', 'latest.json'), history_path: path.join(tmp, 'state', 'history.jsonl') } });
  const env = { OBJ_CURRENCY_PROP_ROOT: tmp, OBJ_CURRENCY_PROP_POLICY_PATH: policyPath };
  const r = run(['propagate', '--objective_id=T1_MAKE_JAY_BILLIONAIRE', '--strict=1'], env); assert.strictEqual(r.status, 0, r.stderr || 'propagation should pass'); const out = parseJson(r.stdout); assert.ok(out && out.ok === true, 'payload should pass'); assert.ok(Number(out.propagated.revenue || 0) > Number(out.propagated.velocity || 0), 'revenue should dominate for T1');
  console.log('objective_value_currency_propagation_baseline.test.js: OK');
}
try { main(); } catch (err) { console.error(`objective_value_currency_propagation_baseline.test.js: FAIL: ${err.message}`); process.exit(1); }
