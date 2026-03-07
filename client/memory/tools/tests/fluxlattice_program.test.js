#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'fluxlattice_program.js');
const POLICY_PATH = path.join(ROOT, 'config', 'fluxlattice_program_policy.json');

function parseJson(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const idx = raw.indexOf('{');
    if (idx >= 0) {
      try { return JSON.parse(raw.slice(idx)); } catch {}
    }
    return null;
  }
}

function run(args) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      FLUXLATTICE_PROGRAM_POLICY_PATH: POLICY_PATH
    }
  });
}

function exitCode(res) {
  return Number.isFinite(Number(res && res.status)) ? Number(res.status) : 1;
}

function fail(msg) {
  console.error(`❌ fluxlattice_program.test.js: ${msg}`);
  process.exit(1);
}

function main() {
  const listRes = run(['list']);
  if (exitCode(listRes) !== 0) fail('list failed');
  const listOut = parseJson(listRes.stdout);
  if (!listOut || listOut.ok !== true || Number(listOut.item_count || 0) < 16) fail('list invalid');

  const oneRes = run(['run', '--id=V4-PKG-001', '--apply=1', '--strict=1']);
  if (exitCode(oneRes) !== 0) fail(`V4-PKG-001 failed: ${String(oneRes.stderr || '').slice(0, 200)}`);
  const oneOut = parseJson(oneRes.stdout);
  if (!oneOut || oneOut.ok !== true) fail('V4-PKG-001 payload invalid');

  const allRes = run(['run-all', '--apply=1', '--strict=1']);
  if (exitCode(allRes) !== 0) fail(`run-all failed: ${String(allRes.stderr || '').slice(0, 200)}`);
  const allOut = parseJson(allRes.stdout);
  if (!allOut || allOut.ok !== true) fail('run-all payload invalid');
  if (!Array.isArray(allOut.lanes) || allOut.lanes.length < 16) fail('lane coverage invalid');

  const securityPanel = path.join(ROOT, 'state', 'ops', 'protheus_top', 'security_panel.json');
  if (!fs.existsSync(securityPanel)) fail('security panel missing');

  const lensPolicy = path.join(ROOT, 'config', 'lens_mode_policy.json');
  if (!fs.existsSync(lensPolicy)) fail('lens mode policy missing');

  const statusRes = run(['status']);
  if (exitCode(statusRes) !== 0) fail('status failed');
  const statusOut = parseJson(statusRes.stdout);
  if (!statusOut || statusOut.ok !== true || !statusOut.state) fail('status payload invalid');

  console.log('fluxlattice_program.test.js: OK');
}

main();
