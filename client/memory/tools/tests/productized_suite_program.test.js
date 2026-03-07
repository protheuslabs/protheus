#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'productized_suite_program.js');
const POLICY_PATH = path.join(ROOT, 'config', 'productized_suite_program_policy.json');

function run(args) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PRODUCTIZED_SUITE_PROGRAM_POLICY_PATH: POLICY_PATH
    }
  });
}

function parseJson(stdout) {
  try {
    return JSON.parse(String(stdout || '').trim());
  } catch {
    return null;
  }
}

function exitCode(res) {
  return Number.isFinite(Number(res && res.status)) ? Number(res.status) : 1;
}

function fail(msg) {
  console.error(`❌ productized_suite_program.test.js: ${msg}`);
  process.exit(1);
}

function main() {
  const listRes = run(['list']);
  if (exitCode(listRes) !== 0) fail(`list failed: ${String(listRes.stderr || '').slice(0, 300)}`);
  const list = parseJson(listRes.stdout);
  if (!list || list.ok !== true || !Array.isArray(list.items)) fail('list response invalid');
  if (Number(list.item_count || 0) < 18) fail('expected at least 18 productized suite items');

  const required = new Set([
    'V4-SUITE-001',
    'V4-SUITE-012',
    'V4-BRAND-001',
    'V4-BRAND-002',
    'V4-TRUST-001',
    'V4-REL-001',
    'V4-ROLL-001',
    'V4-DOC-ORG-001'
  ]);
  const ids = new Set(list.items.map((row) => String(row.id || '').toUpperCase()));
  for (const id of required) {
    if (!ids.has(id)) fail(`missing required lane in list: ${id}`);
  }

  const targetId = 'V4-SUITE-001';
  const runRes = run(['run', `--id=${targetId}`, '--apply=1', '--strict=1']);
  if (exitCode(runRes) !== 0) fail(`run failed for ${targetId}: ${String(runRes.stderr || '').slice(0, 300)}`);
  const out = parseJson(runRes.stdout);
  if (!out || out.ok !== true) fail(`run output not ok for ${targetId}`);
  if (String(out.lane_id || '').toUpperCase() !== targetId) fail(`lane id mismatch: ${out.lane_id} != ${targetId}`);
  if (!out.checks || typeof out.checks !== 'object') fail('checks missing');

  const statusRes = run(['status', `--id=${targetId}`]);
  if (exitCode(statusRes) !== 0) fail(`status failed for ${targetId}: ${String(statusRes.stderr || '').slice(0, 300)}`);
  const status = parseJson(statusRes.stdout);
  if (!status || status.ok !== true || !status.state) fail(`status payload invalid for ${targetId}`);
  if (String(status.id || '').toUpperCase() !== targetId) fail(`status id mismatch: ${status.id} != ${targetId}`);
  if (String(status.state.lane_id || '').toUpperCase() !== targetId) fail('status state lane id mismatch');

  console.log(`productized_suite_program.test.js: OK (${targetId})`);
}

main();
