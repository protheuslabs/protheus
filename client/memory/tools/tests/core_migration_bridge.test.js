#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'migration', 'core_migration_bridge.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(value), 'utf8');
}

function run(workspaceRoot, args, envExtra = {}) {
  const env = {
    ...process.env,
    OPENCLAW_WORKSPACE: workspaceRoot,
    ...envExtra
  };
  const res = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-migration-bridge-'));
  const sourceRoot = path.join(tmp, 'source');
  const targetRoot = path.join(tmp, 'target');
  const policyPath = path.join(tmp, 'config', 'core_migration_bridge_policy.json');

  // Seed source workspace surfaces.
  writeJson(path.join(sourceRoot, 'config', 'lane.json'), { lane: 'science', version: 1 });
  writeText(path.join(sourceRoot, 'habits', 'README.md'), '# habits\n');
  writeText(path.join(sourceRoot, 'memory', 'notes.md'), 'memory node\n');
  writeJson(path.join(sourceRoot, 'state', 'science', 'receipt.json'), { receipt: true });
  writeJson(path.join(sourceRoot, 'state', 'science', 'scientific_mode_v4', 'latest.json'), { ok: true });

  // Seed target preexisting file and git remote.
  writeJson(path.join(targetRoot, 'config', 'lane.json'), { lane: 'legacy', version: 0 });
  fs.mkdirSync(targetRoot, { recursive: true });
  let git = runGit(targetRoot, ['init']);
  assert.strictEqual(git.status, 0, `git init failed: ${git.stderr || git.stdout}`);
  git = runGit(targetRoot, ['remote', 'add', 'origin', 'https://github.com/legacy/repo.git']);
  assert.strictEqual(git.status, 0, `git remote add failed: ${git.stderr || git.stdout}`);

  const policy = {
    enabled: true,
    strict_default: false,
    workspace: {
      default_parent: '..'
    },
    transfer_surfaces: [
      { id: 'config', source: 'config', target: 'config', required: true },
      { id: 'memory', source: 'memory', target: 'memory', required: true },
      { id: 'science', source: 'state/science', target: 'state/science', required: false }
    ],
    paths: {
      latest_path: path.join(tmp, 'state', 'migration', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'migration', 'receipts.jsonl'),
      checkpoints_root: path.join(tmp, 'state', 'migration', 'checkpoints'),
      registry_path: path.join(tmp, 'state', 'migration', 'registry.json')
    }
  };
  writeJson(policyPath, policy);

  let res = run(sourceRoot, [
    'run',
    '--to=acme/protheus-core',
    `--workspace=${targetRoot}`,
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(res.status, 0, `plan should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'plan payload should be ok');
  assert.strictEqual(res.payload.applied, false, 'plan should not apply by default');
  assert.strictEqual(res.payload.result, 'planned');

  res = run(sourceRoot, [
    'run',
    '--to=acme/protheus-core',
    `--workspace=${targetRoot}`,
    '--apply=1',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(res.status, 0, `apply should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.applied === true, 'apply should mark applied=true');
  assert.strictEqual(res.payload.remote_action, 'set-url', 'existing origin should be updated');
  const migrationId = res.payload.migration_id;
  assert.ok(migrationId, 'migration id required');

  const targetConfig = JSON.parse(fs.readFileSync(path.join(targetRoot, 'config', 'lane.json'), 'utf8'));
  assert.strictEqual(targetConfig.version, 1, 'config should transfer to target');
  assert.ok(fs.existsSync(path.join(targetRoot, 'memory', 'notes.md')), 'memory file should transfer');

  git = runGit(targetRoot, ['remote', 'get-url', 'origin']);
  assert.strictEqual(git.status, 0, 'remote lookup should pass after migrate');
  assert.strictEqual(String(git.stdout || '').trim(), 'https://github.com/acme/protheus-core.git');

  res = run(sourceRoot, [
    'rollback',
    `--migration-id=${migrationId}`,
    '--apply=1',
    '--approval-note=test_rollback',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(res.status, 0, `rollback should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'rollback payload should be ok');
  assert.strictEqual(res.payload.result, 'applied', 'rollback should apply');

  const rolledBackConfig = JSON.parse(fs.readFileSync(path.join(targetRoot, 'config', 'lane.json'), 'utf8'));
  assert.strictEqual(rolledBackConfig.version, 0, 'rollback should restore previous target file');
  assert.ok(!fs.existsSync(path.join(targetRoot, 'memory', 'notes.md')), 'rollback should remove newly introduced file');

  git = runGit(targetRoot, ['remote', 'get-url', 'origin']);
  assert.strictEqual(git.status, 0, 'remote lookup should pass after rollback');
  assert.strictEqual(String(git.stdout || '').trim(), 'https://github.com/legacy/repo.git', 'rollback should restore original remote');

  res = run(sourceRoot, ['status', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.type === 'core_migration_bridge_status', 'status payload type should match');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('core_migration_bridge.test.js: OK');
} catch (err) {
  console.error(`core_migration_bridge.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
