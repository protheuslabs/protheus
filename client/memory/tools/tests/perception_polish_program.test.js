#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'perception_polish_program.js');
const POLICY_PATH = path.join(ROOT, 'config', 'perception_polish_program_policy.json');

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
      PERCEPTION_POLISH_PROGRAM_POLICY_PATH: POLICY_PATH
    }
  });
}

function exitCode(res) {
  return Number.isFinite(Number(res && res.status)) ? Number(res.status) : 1;
}

function fail(msg) {
  console.error(`❌ perception_polish_program.test.js: ${msg}`);
  process.exit(1);
}

function main() {
  const listRes = run(['list']);
  if (exitCode(listRes) !== 0) fail('list failed');
  const listOut = parseJson(listRes.stdout);
  if (!listOut || listOut.ok !== true || Number(listOut.item_count || 0) < 4) fail('list payload invalid');

  const runOneRes = run(['run', '--id=V4-ILLUSION-001', '--apply=1', '--strict=1', '--illusion-mode=1']);
  if (exitCode(runOneRes) !== 0) fail('run one failed');
  const runOneOut = parseJson(runOneRes.stdout);
  if (!runOneOut || runOneOut.ok !== true) fail('run one payload invalid');

  const runAllRes = run(['run-all', '--apply=1', '--strict=1']);
  if (exitCode(runAllRes) !== 0) fail('run-all failed');
  const runAllOut = parseJson(runAllRes.stdout);
  if (!runAllOut || runAllOut.ok !== true) fail('run-all payload invalid');
  if (!Array.isArray(runAllOut.lanes) || runAllOut.lanes.length < 4) fail('lane coverage invalid');

  const flagsPath = path.join(ROOT, 'config', 'feature_flags', 'perception_flags.json');
  if (!fs.existsSync(flagsPath)) fail('flags file missing');

  const footerPath = path.join(ROOT, 'state', 'ops', 'protheus_top', 'reasoning_mirror_footer.txt');
  if (!fs.existsSync(footerPath)) fail('reasoning mirror footer missing');

  const statusRes = run(['status']);
  if (exitCode(statusRes) !== 0) fail('status failed');
  const statusOut = parseJson(statusRes.stdout);
  if (!statusOut || statusOut.ok !== true || !statusOut.state) fail('status payload invalid');

  console.log('perception_polish_program.test.js: OK');
}

main();
