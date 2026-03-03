#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'rust50_migration_program.js');
const POLICY = path.join(ROOT, 'config', 'rust50_migration_program_policy.json');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      RUST50_MIGRATION_PROGRAM_POLICY_PATH: POLICY
    }
  });
}

function parseJson(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function fail(msg) {
  console.error(`❌ rust50_migration_program.test.js: ${msg}`);
  process.exit(1);
}

function assert(cond, msg) {
  if (!cond) fail(msg);
}

function exitCode(res) {
  return Number.isFinite(Number(res && res.status)) ? Number(res.status) : 1;
}

function main() {
  const listRes = run(['list']);
  assert(exitCode(listRes) === 0, `list failed: ${String(listRes.stderr || '').slice(0, 240)}`);
  const listOut = parseJson(listRes.stdout);
  assert(listOut && listOut.ok === true, 'list payload invalid');
  assert(Number(listOut.item_count || 0) === 7, `expected 7 items, got ${listOut && listOut.item_count}`);

  const lane001 = run(['run', '--id=V6-RUST50-001', '--apply=1', '--strict=1']);
  assert(exitCode(lane001) === 0, `lane001 failed: ${String(lane001.stderr || '').slice(0, 240)}`);
  const lane001Out = parseJson(lane001.stdout);
  assert(lane001Out && lane001Out.ok === true, 'lane001 output not ok');
  assert(lane001Out.checks && lane001Out.checks.preflight_security_audit_ok === true, 'lane001 security audit preflight missing');
  assert(lane001Out.hotspot_profile && Array.isArray(lane001Out.hotspot_profile.top_hotspots), 'lane001 hotspot profile missing');

  const lane006 = run(['run', '--id=V6-RUST50-006', '--apply=1', '--strict=0']);
  assert(exitCode(lane006) === 0, `lane006 failed: ${String(lane006.stderr || '').slice(0, 240)}`);
  const lane006Out = parseJson(lane006.stdout);
  assert(lane006Out && lane006Out.ok === true, 'lane006 output not ok');
  assert(lane006Out.summary && Number.isFinite(Number(lane006Out.summary.background_battery_pct_24h)), 'lane006 summary missing battery metric');
  assert(lane006Out.checks && lane006Out.checks.preflight_security_audit_ok === true, 'lane006 security audit preflight missing');

  const gateSoft = run(['run', '--id=V6-RUST50-007', '--apply=1', '--strict=0']);
  assert(exitCode(gateSoft) === 0, `gate soft run failed: ${String(gateSoft.stderr || '').slice(0, 240)}`);
  const gateSoftOut = parseJson(gateSoft.stdout);
  assert(gateSoftOut && gateSoftOut.ok === true, 'gate soft output not ok');
  assert(gateSoftOut.summary && typeof gateSoftOut.summary.status === 'string', 'gate soft status missing');

  const gateStrict = run(['run', '--id=V6-RUST50-007', '--apply=1', '--strict=1']);
  const gateStrictOut = parseJson(gateStrict.stdout);
  assert(gateStrictOut && gateStrictOut.summary && typeof gateStrictOut.summary.status === 'string', 'gate strict payload invalid');
  if (exitCode(gateStrict) !== 0) {
    assert(gateStrictOut.summary.status === 'PAUSED', 'strict gate failure must emit PAUSED status');
  }

  const statusRes = run(['status', '--id=V6-RUST50-007']);
  assert(exitCode(statusRes) === 0, 'status command failed');
  const statusOut = parseJson(statusRes.stdout);
  assert(statusOut && statusOut.ok === true && statusOut.state, 'status payload missing lane state');

  console.log('rust50_migration_program.test.js: OK');
}

main();
