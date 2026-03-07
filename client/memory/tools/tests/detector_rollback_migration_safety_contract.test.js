#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'detector_rollback_migration_safety_contract.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-rollback-'));
  const bundleDir = path.join(tmp, 'state', 'sensory', 'detector_bundle');
  const rollbackDir = path.join(tmp, 'state', 'sensory', 'analysis', 'detector_rollback');
  const policyPath = path.join(tmp, 'config', 'detector_rollback_migration_safety_policy.json');

  writeJson(path.join(bundleDir, 'current.json'), {
    bundle_id: 'bundle_v1',
    schema_version: 1,
    decision_threshold: 0.4
  });

  writeJson(path.join(bundleDir, 'replay_fixture.json'), {
    rows: [
      { id: 'x1', probability: 0.3 },
      { id: 'x2', probability: 0.8 }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    max_schema_version_jump: 1,
    paths: {
      active_bundle_path: path.join(bundleDir, 'current.json'),
      replay_fixture_path: path.join(bundleDir, 'replay_fixture.json'),
      snapshot_dir: path.join(rollbackDir, 'snapshots'),
      history_path: path.join(rollbackDir, 'history.jsonl'),
      latest_path: path.join(rollbackDir, 'latest.json')
    }
  });

  let out = run(['snapshot', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'detector_rollback_snapshot', 'snapshot should succeed');

  writeJson(path.join(bundleDir, 'current.json'), {
    bundle_id: 'bundle_v2',
    schema_version: 2,
    decision_threshold: 0.7
  });

  out = run(['rollback', 'latest', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'detector_rollback_apply', 'rollback should produce output');
  assert.strictEqual(out.payload.rollback_applied, true, 'rollback should apply');

  const current = JSON.parse(fs.readFileSync(path.join(bundleDir, 'current.json'), 'utf8'));
  assert.strictEqual(current.bundle_id, 'bundle_v1', 'active bundle should be restored to snapshot bundle');

  out = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload, 'status should read latest state');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('detector_rollback_migration_safety_contract.test.js: OK');
} catch (err) {
  console.error(`detector_rollback_migration_safety_contract.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
