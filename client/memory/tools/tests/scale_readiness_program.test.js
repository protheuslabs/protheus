#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'scale_readiness_program.js');
const POLICY_PATH = path.join(ROOT, 'config', 'scale_readiness_program_policy.json');

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
      SCALE_READINESS_PROGRAM_POLICY_PATH: POLICY_PATH
    }
  });
}

function exitCode(res) {
  return Number.isFinite(Number(res && res.status)) ? Number(res.status) : 1;
}

function fail(msg) {
  console.error(`❌ scale_readiness_program.test.js: ${msg}`);
  process.exit(1);
}

function main() {
  const listRes = run(['list']);
  if (exitCode(listRes) !== 0) fail('list failed');
  const listOut = parseJson(listRes.stdout);
  if (!listOut || listOut.ok !== true || Number(listOut.item_count || 0) < 10) fail('list invalid');

  const runOneRes = run(['run', '--id=V4-SCALE-001', '--apply=1', '--strict=1']);
  if (exitCode(runOneRes) !== 0) fail(`run one failed: ${String(runOneRes.stderr || '').slice(0, 200)}`);
  const runOneOut = parseJson(runOneRes.stdout);
  if (!runOneOut || runOneOut.ok !== true) fail('run one payload invalid');
  if (!runOneOut.checks || runOneOut.checks.stage_gates_defined !== true) fail('scale-001 checks missing');

  const runAllRes = run(['run-all', '--apply=1', '--strict=1']);
  if (exitCode(runAllRes) !== 0) fail(`run-all failed: ${String(runAllRes.stderr || '').slice(0, 200)}`);
  const runAllOut = parseJson(runAllRes.stdout);
  if (!runAllOut || runAllOut.ok !== true) fail('run-all payload invalid');
  if (!Array.isArray(runAllOut.lanes) || runAllOut.lanes.length < 10) fail('lane coverage invalid');

  const scaleContract = path.join(ROOT, 'config', 'scale_readiness', 'load_model_contract.json');
  if (!fs.existsSync(scaleContract)) fail('expected load_model_contract.json not found');

  const statusRes = run(['status']);
  if (exitCode(statusRes) !== 0) fail('status failed');
  const statusOut = parseJson(statusRes.stdout);
  if (!statusOut || statusOut.ok !== true || !statusOut.state) fail('status payload invalid');

  console.log('scale_readiness_program.test.js: OK');
}

main();
