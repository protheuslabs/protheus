#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'required_checks_policy_guard.js');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env }, encoding: 'utf8' });
}
function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  const lines = txt.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch {} }
  return null;
}

function main() {
  const r = run(['check', '--strict=1']);
  assert.strictEqual(r.status, 0, r.stderr || 'required checks policy should pass in workspace');
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'payload should pass');
  assert.ok(Array.isArray(out.checked.required_checks) && out.checked.required_checks.includes('ci_suite'), 'required checks list should include ci_suite');
  console.log('required_checks_policy_guard.test.js: OK');
}

try { main(); } catch (err) { console.error(`required_checks_policy_guard.test.js: FAIL: ${err.message}`); process.exit(1); }
