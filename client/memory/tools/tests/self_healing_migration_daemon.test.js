#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'migration', 'self_healing_migration_daemon.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(value), 'utf8');
}

function run(workspaceRoot, args) {
  const res = spawnSync('node', [SCRIPT, ...args], {
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

function runGit(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'self-healing-migration-'));
  const sourceRoot = path.join(tmp, 'source');
  const targetRoot = path.join(tmp, 'target');
  const daemonPolicyPath = path.join(tmp, 'config', 'self_healing_migration_daemon_policy.json');
  const migrationPolicyPath = path.join(tmp, 'config', 'core_migration_bridge_policy.json');

  writeJson(path.join(sourceRoot, 'config', 'lane.json'), { lane: 'control' });
  writeText(path.join(sourceRoot, 'memory', 'node.md'), 'memory\n');

  fs.mkdirSync(sourceRoot, { recursive: true });
  let git = runGit(sourceRoot, ['init']);
  assert.strictEqual(git.status, 0, `git init failed: ${git.stderr || git.stdout}`);
  git = runGit(sourceRoot, ['remote', 'add', 'origin', 'https://github.com/openclaw/openclaw.git']);
  assert.strictEqual(git.status, 0, `git remote add failed: ${git.stderr || git.stdout}`);

  writeJson(daemonPolicyPath, {
    enabled: true,
    strict_default: false,
    detector: {
      legacy_remote_patterns: ['openclaw'],
      suggest_if_remote_missing: true,
      require_consent_for_apply: true,
      consent_token_prefix: 'MIGR-CONSENT-'
    },
    integration: {
      self_audit_suggestions_path: path.join(tmp, 'state', 'self_audit', 'suggestions.jsonl')
    },
    paths: {
      latest_path: path.join(tmp, 'state', 'daemon', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'daemon', 'receipts.jsonl'),
      suggestions_path: path.join(tmp, 'state', 'daemon', 'suggestions.jsonl')
    }
  });

  writeJson(migrationPolicyPath, {
    enabled: true,
    strict_default: false,
    transfer_surfaces: [
      { id: 'config', source: 'config', target: 'config', required: true },
      { id: 'memory', source: 'memory', target: 'memory', required: true }
    ],
    paths: {
      latest_path: path.join(tmp, 'state', 'migration', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'migration', 'receipts.jsonl'),
      checkpoints_root: path.join(tmp, 'state', 'migration', 'checkpoints'),
      registry_path: path.join(tmp, 'state', 'migration', 'registry.json')
    }
  });

  let res = run(sourceRoot, ['scan', `--workspace=${sourceRoot}`, `--policy=${daemonPolicyPath}`]);
  assert.strictEqual(res.status, 0, `scan should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.needs_migration === true, 'scan should detect legacy remote');

  res = run(sourceRoot, [
    'scan',
    '--apply=1',
    `--workspace=${sourceRoot}`,
    '--to=acme/protheus-core',
    `--workspace-target=${targetRoot}`,
    `--migration-policy=${migrationPolicyPath}`,
    `--policy=${daemonPolicyPath}`
  ]);
  assert.strictEqual(res.status, 1, 'apply without consent should fail');
  assert.ok(res.payload && res.payload.error === 'valid_consent_token_required');

  res = run(sourceRoot, [
    'scan',
    '--apply=1',
    `--workspace=${sourceRoot}`,
    '--to=acme/protheus-core',
    `--workspace-target=${targetRoot}`,
    '--consent-token=MIGR-CONSENT-OK',
    `--migration-policy=${migrationPolicyPath}`,
    `--policy=${daemonPolicyPath}`
  ]);
  assert.strictEqual(res.status, 0, `consented apply should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.migration_triggered === true, 'migration should be triggered');
  assert.ok(fs.existsSync(path.join(targetRoot, 'config', 'lane.json')), 'target config should transfer');
  assert.ok(fs.existsSync(path.join(targetRoot, 'memory', 'node.md')), 'target memory should transfer');

  res = run(sourceRoot, ['status', `--policy=${daemonPolicyPath}`]);
  assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.type === 'self_healing_migration_daemon_status');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('self_healing_migration_daemon.test.js: OK');
} catch (err) {
  console.error(`self_healing_migration_daemon.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
