#!/usr/bin/env node
'use strict';
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'contracts', 'adaptive_contract_version_governance_closure.js');
function run(args) { return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env }, encoding: 'utf8' }); }
function parseJson(stdout) { const txt = String(stdout || '').trim(); if (!txt) return null; try { return JSON.parse(txt); } catch {} const lines = txt.split('\n').filter(Boolean); for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch {} } return null; }
function main() {
  const r = run(['run', '--strict=1']); assert.strictEqual(r.status, 0, r.stderr || 'existing contract targets should pass'); const out = parseJson(r.stdout); assert.ok(out && out.ok === true, 'payload should pass');
  console.log('adaptive_contract_version_governance_closure.test.js: OK');
}
try { main(); } catch (err) { console.error(`adaptive_contract_version_governance_closure.test.js: FAIL: ${err.message}`); process.exit(1); }
