#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runNode(scriptPath, args, env, cwd) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  let payload = null;
  try {
    payload = JSON.parse(String(r.stdout || '').trim().split('\n').filter(Boolean).slice(-1)[0]);
  } catch {}
  return {
    status: r.status ?? 0,
    payload,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || '')
  };
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(repoRoot, 'systems', 'memory', 'offdevice_memory_replication.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'offdevice-memory-'));

  const sourceA = path.join(tmp, 'source', 'state.json');
  const sourceB = path.join(tmp, 'source', 'distilled_latest.json');
  writeJson(sourceA, { schema_id: 'federation_state', local_archetypes: [{ id: 'a' }] });
  writeJson(sourceB, { schema_id: 'federation_distilled', replay_hash: 'abc123' });

  const providerRoot = path.join(tmp, 'provider');
  const stateRoot = path.join(tmp, 'state');
  const policyPath = path.join(tmp, 'config', 'offdevice_memory_replication_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: false,
    fallback_local_only: true,
    source_paths: [sourceA, sourceB],
    state: {
      root: stateRoot,
      state_path: path.join(stateRoot, 'state.json'),
      latest_path: path.join(stateRoot, 'latest.json'),
      receipts_path: path.join(stateRoot, 'receipts.jsonl'),
      drills_dir: path.join(stateRoot, 'drills')
    },
    providers: {
      local_mirror: {
        enabled: true,
        type: 'local_mirror',
        root: providerRoot,
        verify_required: true
      }
    }
  });

  let r = runNode(script, [
    'sync',
    '--provider=local_mirror',
    '--apply=1',
    `--policy=${policyPath}`
  ], {}, repoRoot);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  assert.strictEqual(r.payload && r.payload.ok, true);
  assert.strictEqual(r.payload && r.payload.verify_ok, true);
  const snapshotId = r.payload.snapshot_id;
  assert.ok(snapshotId, 'snapshot id required');

  r = runNode(script, [
    'verify',
    '--provider=local_mirror',
    `--snapshot=${snapshotId}`,
    `--policy=${policyPath}`
  ], {}, repoRoot);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  assert.strictEqual(r.payload && r.payload.ok, true);

  const manifestPath = path.join(providerRoot, 'snapshots', snapshotId, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.ok(Array.isArray(manifest.files) && manifest.files.length >= 1);
  const firstRel = manifest.files[0].path;
  const firstPayload = path.join(providerRoot, 'snapshots', snapshotId, 'payload', firstRel);
  fs.appendFileSync(firstPayload, '\n{"tampered":true}\n', 'utf8');

  r = runNode(script, [
    'restore-drill',
    '--provider=local_mirror',
    `--snapshot=${snapshotId}`,
    '--scope=all',
    `--policy=${policyPath}`
  ], {}, repoRoot);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  assert.strictEqual(r.payload && r.payload.ok, true, 'restore drill should fail-safe into fallback local-only');
  assert.strictEqual(r.payload && r.payload.fallback_local_only, true);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('offdevice_memory_replication.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`offdevice_memory_replication.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

