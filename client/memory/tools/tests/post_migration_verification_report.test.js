#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MIGRATION_SCRIPT = path.join(ROOT, 'systems', 'migration', 'core_migration_bridge.js');
const REPORT_SCRIPT = path.join(ROOT, 'systems', 'migration', 'post_migration_verification_report.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(value), 'utf8');
}

function run(script, workspaceRoot, args) {
  const res = spawnSync('node', [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENCLAW_WORKSPACE: workspaceRoot
    }
  });
  let payload = null;
  try { payload = JSON.parse(String(res.stdout || '').trim()); } catch {}
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    payload,
    stderr: String(res.stderr || '')
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'post-migration-report-'));
  const sourceRoot = path.join(tmp, 'source');
  const targetRoot = path.join(tmp, 'target');
  const migrationPolicyPath = path.join(tmp, 'config', 'core_migration_bridge_policy.json');
  const reportPolicyPath = path.join(tmp, 'config', 'post_migration_verification_report_policy.json');

  writeJson(path.join(sourceRoot, 'config', 'lane.json'), { lane: 'core' });
  writeText(path.join(sourceRoot, 'memory', 'node.md'), 'node\n');
  writeJson(path.join(sourceRoot, 'state', 'science', 'receipt.json'), { ok: true });

  writeJson(migrationPolicyPath, {
    enabled: true,
    strict_default: false,
    transfer_surfaces: [
      { id: 'config', source: 'config', target: 'config', required: true },
      { id: 'memory', source: 'memory', target: 'memory', required: true },
      { id: 'science', source: 'state/science', target: 'state/science', required: false }
    ],
    paths: {
      latest_path: path.join(tmp, 'state', 'core_bridge', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'core_bridge', 'receipts.jsonl'),
      checkpoints_root: path.join(tmp, 'state', 'core_bridge', 'checkpoints'),
      registry_path: path.join(tmp, 'state', 'core_bridge', 'registry.json')
    }
  });

  writeJson(reportPolicyPath, {
    enabled: true,
    strict_default: false,
    expected_surfaces: [
      { id: 'config', path: 'config', required: true },
      { id: 'memory', path: 'memory', required: true },
      { id: 'science', path: 'state/science', required: false }
    ],
    core_bridge: {
      registry_path: path.join(tmp, 'state', 'core_bridge', 'registry.json'),
      checkpoints_root: path.join(tmp, 'state', 'core_bridge', 'checkpoints')
    },
    paths: {
      latest_path: path.join(tmp, 'state', 'post_report', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'post_report', 'receipts.jsonl'),
      reports_root: path.join(tmp, 'state', 'post_report', 'reports')
    }
  });

  let res = run(MIGRATION_SCRIPT, sourceRoot, [
    'run',
    '--to=acme/protheus-core',
    `--workspace=${targetRoot}`,
    '--apply=1',
    `--policy=${migrationPolicyPath}`
  ]);
  assert.strictEqual(res.status, 0, `migration apply should pass: ${res.stderr}`);
  const migrationId = res.payload && res.payload.migration_id;
  assert.ok(migrationId, 'migration id should be present');

  res = run(REPORT_SCRIPT, sourceRoot, [
    'run',
    `--migration-id=${migrationId}`,
    '--strict=1',
    '--telemetry-consent=1',
    '--apply=1',
    `--policy=${reportPolicyPath}`
  ]);
  assert.strictEqual(res.status, 0, `post migration report should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.pass === true, 'report should pass checks');
  assert.strictEqual(res.payload.finalized, true, 'apply should finalize migration registry entry');

  const reportAbs = path.join(sourceRoot, res.payload.report_path);
  assert.ok(fs.existsSync(reportAbs), 'report artifact should exist');

  res = run(REPORT_SCRIPT, sourceRoot, ['status', `--policy=${reportPolicyPath}`]);
  assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.type === 'post_migration_verification_report_status');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('post_migration_verification_report.test.js: OK');
} catch (err) {
  console.error(`post_migration_verification_report.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
