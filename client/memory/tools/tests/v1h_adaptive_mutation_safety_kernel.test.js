#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'v1h_adaptive_mutation_safety_kernel.js');
function writeJson(filePath, payload) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8'); }
function run(args, env) { return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' }); }
function parseJson(stdout) { const txt = String(stdout || '').trim(); if (!txt) return null; try { return JSON.parse(txt); } catch {} const lines = txt.split('\n').filter(Boolean); for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch {} } return null; }
function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v1h-mutation-kernel-')); const policyPath = path.join(tmp, 'config', 'v1h_policy.json');
  writeJson(policyPath, { version: '1.0-test', enabled: true, allowed_risks: ['low'], max_mutations_per_day: 1, outputs: { state_path: path.join(tmp, 'state', 'state.json'), latest_path: path.join(tmp, 'state', 'latest.json'), history_path: path.join(tmp, 'state', 'history.jsonl') } });
  const env = { V1H_MUTATION_KERNEL_ROOT: tmp, V1H_MUTATION_KERNEL_POLICY_PATH: policyPath };
  let r = run(['gate', '--risk=low', '--date=2026-03-02', '--strict=1'], env); assert.strictEqual(r.status, 0, r.stderr || 'first low risk should pass');
  r = run(['gate', '--risk=high', '--date=2026-03-02', '--strict=1'], env); assert.notStrictEqual(r.status, 0, 'high risk should fail');
  r = run(['gate', '--risk=low', '--date=2026-03-02', '--strict=1'], env); assert.notStrictEqual(r.status, 0, 'second mutation should exceed cap');
  const out = parseJson(r.stdout); assert.ok(out && out.ok === false, 'cap breach payload should fail');
  console.log('v1h_adaptive_mutation_safety_kernel.test.js: OK');
}
try { main(); } catch (err) { console.error(`v1h_adaptive_mutation_safety_kernel.test.js: FAIL: ${err.message}`); process.exit(1); }
