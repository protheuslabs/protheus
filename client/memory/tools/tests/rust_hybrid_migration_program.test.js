#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'rust_hybrid_migration_program.js');
const POLICY_PATH = path.join(ROOT, 'config', 'rust_hybrid_migration_program_policy.json');

function run(args) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      RUST_HYBRID_MIGRATION_PROGRAM_POLICY_PATH: POLICY_PATH
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
  console.error(`❌ rust_hybrid_migration_program.test.js: ${msg}`);
  process.exit(1);
}

function main() {
  const argv = process.argv.slice(2);
  const idArg = argv.find((tok) => String(tok).startsWith('--id='));
  const requestedId = idArg ? String(idArg).split('=')[1].trim().toUpperCase() : '';

  const listRes = run(['list']);
  if (exitCode(listRes) !== 0) fail(`list failed: ${String(listRes.stderr || '').slice(0, 300)}`);
  const list = parseJson(listRes.stdout);
  if (!list || list.ok !== true || !Array.isArray(list.items)) fail('list response invalid');
  if (Number(list.item_count || 0) < 10) fail('expected at least 10 hybrid Rust items');

  const targetId = requestedId || String(list.items[0] && list.items[0].id || '');
  if (!targetId) fail('target id missing');

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

  console.log(`rust_hybrid_migration_program.test.js: OK (${targetId})`);
}

main();
