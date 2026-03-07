#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'settlement_program.js');
const POLICY_PATH = path.join(ROOT, 'config', 'settlement_program_policy.json');
const STATE_DIR = path.join(ROOT, 'state', 'ops', 'settlement_program');

function parseJson(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const firstBrace = raw.indexOf('{');
  if (firstBrace >= 0) {
    const maybe = raw.slice(firstBrace);
    try {
      return JSON.parse(maybe);
    } catch {}
  }
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

function run(args, extraEnv = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      SETTLEMENT_PROGRAM_POLICY_PATH: POLICY_PATH
    }
  });
}

function exitCode(res) {
  return Number.isFinite(Number(res && res.status)) ? Number(res.status) : 1;
}

function fail(msg) {
  console.error(`❌ settlement_program.test.js: ${msg}`);
  process.exit(1);
}

function main() {
  try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch {}

  const listRes = run(['list']);
  if (exitCode(listRes) !== 0) fail('list failed');
  const listOut = parseJson(listRes.stdout);
  if (!listOut || listOut.ok !== true || Number(listOut.item_count || 0) < 11) fail('list invalid');

  const lane011 = run(['run', '--id=V4-SETTLE-011', '--apply=1', '--strict=1'], {
    PROTHEUS_TERNARY_AVAILABLE: '0',
    PROTHEUS_QUBIT_AVAILABLE: '0'
  });
  if (exitCode(lane011) !== 0) fail(`lane 011 failed: ${String(lane011.stderr || '').slice(0, 200)}`);
  const lane011Out = parseJson(lane011.stdout);
  if (!lane011Out || lane011Out.ok !== true) fail('lane 011 output invalid');
  const combined = `${String(lane011.stdout || '')}\n${String(lane011.stderr || '')}`;
  if (!combined.includes('No ternary substrate or qubit access detected. Reverting to binary mode.')) {
    fail('exact substrate fallback line not emitted');
  }

  const settleRes = run(['settle', '--apply=1', '--strict=1', '--target=binary']);
  if (exitCode(settleRes) !== 0) fail('settle run-all failed');
  const settleOut = parseJson(settleRes.stdout);
  if (!settleOut || settleOut.ok !== true) fail('settle payload invalid');
  if (!Array.isArray(settleOut.lanes) || settleOut.lanes.length < 11) fail('settle lane coverage invalid');

  const editCoreRes = run(['edit-core', '--apply=1', '--strict=1']);
  if (exitCode(editCoreRes) !== 0) fail('edit-core failed');
  const editCoreOut = parseJson(editCoreRes.stdout);
  if (!editCoreOut || editCoreOut.ok !== true) fail('edit-core payload invalid');

  const editModuleRes = run(['edit-module', '--module=memory', '--apply=1', '--strict=1']);
  if (exitCode(editModuleRes) !== 0) fail('edit-module failed');
  const editModuleOut = parseJson(editModuleRes.stdout);
  if (!editModuleOut || editModuleOut.ok !== true) fail('edit-module payload invalid');

  const revertRes = run(['revert', '--apply=1', '--strict=1']);
  if (exitCode(revertRes) !== 0) fail('revert failed');
  const revertOut = parseJson(revertRes.stdout);
  if (!revertOut || revertOut.ok !== true) fail('revert payload invalid');

  const statusRes = run(['status']);
  if (exitCode(statusRes) !== 0) fail('status failed');
  const statusOut = parseJson(statusRes.stdout);
  if (!statusOut || statusOut.ok !== true || !statusOut.state) fail('status payload invalid');

  console.log('settlement_program.test.js: OK');
}

main();
