#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'observability_slo_runbook_closure_pass.js');
function writeJson(filePath, payload) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8'); }
function writeText(filePath, content) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, content, 'utf8'); }
function run(args, env) { return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' }); }
function parseJson(stdout) { const txt = String(stdout || '').trim(); if (!txt) return null; try { return JSON.parse(txt); } catch {} const lines = txt.split('\n').filter(Boolean); for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch {} } return null; }
function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-slo-runbook-')); const policyPath = path.join(tmp, 'config', 'obs_policy.json'); const mapPath = path.join(tmp, 'config', 'slo_map.json'); const runbookPath = path.join(tmp, 'docs', 'runbook.md');
  writeJson(mapPath, { verification_pass_rate: 'Incident 8', queue_health: 'Incident 3' }); writeText(runbookPath, 'Incident 8\nIncident 3\n');
  writeJson(policyPath, { version: '1.0-test', enabled: true, inputs: { slo_map_path: mapPath, runbook_path: runbookPath }, outputs: { latest_path: path.join(tmp, 'state', 'latest.json'), history_path: path.join(tmp, 'state', 'history.jsonl') } });
  const env = { OBS_SLO_RUNBOOK_CLOSURE_ROOT: tmp, OBS_SLO_RUNBOOK_CLOSURE_POLICY_PATH: policyPath };
  const r = run(['run', '--strict=1'], env); assert.strictEqual(r.status, 0, r.stderr || 'closure pass should succeed'); const out = parseJson(r.stdout); assert.ok(out && out.ok === true, 'payload should pass');
  console.log('observability_slo_runbook_closure_pass.test.js: OK');
}
try { main(); } catch (err) { console.error(`observability_slo_runbook_closure_pass.test.js: FAIL: ${err.message}`); process.exit(1); }
