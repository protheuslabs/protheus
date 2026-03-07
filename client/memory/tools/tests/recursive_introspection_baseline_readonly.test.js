#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'recursive_introspection_baseline_readonly.js');
function writeJson(filePath, payload) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8'); }
function writeText(filePath, content) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, content, 'utf8'); }
function run(args, env) { return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' }); }
function parseJson(stdout) { const txt = String(stdout || '').trim(); if (!txt) return null; try { return JSON.parse(txt); } catch {} const lines = txt.split('\n').filter(Boolean); for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch {} } return null; }
function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recursive-introspection-')); const policyPath = path.join(tmp, 'config', 'policy.json');
  writeText(path.join(tmp, 'state', 'autonomy', 'a.json'), '{}'); writeText(path.join(tmp, 'state', 'sensory', 'b.json'), '{}'); writeText(path.join(tmp, 'state', 'routing', 'c.json'), '{}');
  writeJson(policyPath, { version: '1.0-test', enabled: true, readonly: true, inputs: [path.join(tmp, 'state', 'autonomy'), path.join(tmp, 'state', 'sensory'), path.join(tmp, 'state', 'routing')], outputs: { latest_path: path.join(tmp, 'state', 'latest.json'), history_path: path.join(tmp, 'state', 'history.jsonl') } });
  const env = { RECURSIVE_INTROSPECTION_BASELINE_ROOT: tmp, RECURSIVE_INTROSPECTION_BASELINE_POLICY_PATH: policyPath };
  const r = run(['run', '--strict=1'], env); assert.strictEqual(r.status, 0, r.stderr || 'run should pass'); const out = parseJson(r.stdout); assert.ok(out && out.ok === true && out.readonly === true, 'payload should pass readonly'); assert.ok(Number(out.summary.total_files || 0) >= 3, 'should count files');
  console.log('recursive_introspection_baseline_readonly.test.js: OK');
}
try { main(); } catch (err) { console.error(`recursive_introspection_baseline_readonly.test.js: FAIL: ${err.message}`); process.exit(1); }
