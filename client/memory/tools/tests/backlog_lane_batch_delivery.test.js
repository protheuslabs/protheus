#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'backlog_lane_batch_delivery.js');
const POLICY_PATH = path.join(ROOT, 'config', 'backlog_lane_batch_delivery_policy.json');

function parseJson(stdout) {
  try {
    return JSON.parse(String(stdout || '').trim());
  } catch {
    return null;
  }
}

function run(args) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      BACKLOG_LANE_BATCH_DELIVERY_POLICY_PATH: POLICY_PATH
    }
  });
}

function fmtRun(res) {
  return JSON.stringify({
    status: res && res.status,
    signal: res && res.signal,
    error: res && res.error ? String(res.error) : null,
    stderr: String(res && res.stderr || '').slice(0, 400),
    stdout: String(res && res.stdout || '').slice(0, 400)
  });
}

function exitCode(res) {
  return Number.isFinite(Number(res && res.status)) ? Number(res.status) : 1;
}

function fail(msg) {
  console.error(`❌ backlog_lane_batch_delivery.test.js: ${msg}`);
  process.exit(1);
}

function main() {
  const argv = process.argv.slice(2);
  const idArg = argv.find((tok) => String(tok).startsWith('--id='));
  const id = idArg ? String(idArg).split('=')[1].trim().toUpperCase() : '';

  const listRes = run(['list']);
  if (exitCode(listRes) !== 0) fail(`list failed: ${fmtRun(listRes)}`);
  const list = parseJson(listRes.stdout);
  if (!list || list.ok !== true || !Array.isArray(list.targets)) fail('list response invalid');
  if (!Number.isFinite(Number(list.target_count || 0)) || Number(list.target_count) < 1) fail('no targets configured');

  const targetId = id || String(list.targets[0] && list.targets[0].id || '');
  if (!targetId) fail('target id missing');

  const runRes = run(['run', `--id=${targetId}`, '--apply=1', '--strict=1']);
  if (exitCode(runRes) !== 0) fail(`run failed for ${targetId}: ${fmtRun(runRes)}`);
  const out = parseJson(runRes.stdout);
  if (!out || out.ok !== true) fail(`run output not ok for ${targetId}`);
  if (String(out.id || '').toUpperCase() !== targetId) fail(`id mismatch: ${out.id} != ${targetId}`);
  if (!Array.isArray(out.checks) || out.checks.length < 3) fail('checks missing');

  const statusRes = run(['status', `--id=${targetId}`]);
  if (exitCode(statusRes) !== 0) fail(`status failed for ${targetId}: ${fmtRun(statusRes)}`);
  const status = parseJson(statusRes.stdout);
  if (!status || status.ok !== true || !status.state || String(status.state.id || '').toUpperCase() !== targetId) {
    fail(`status payload invalid for ${targetId}`);
  }

  console.log(`backlog_lane_batch_delivery.test.js: OK (${targetId})`);
}

main();
