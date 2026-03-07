#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'aws_reproducible_artifact_profile.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sign(row, secret) {
  const h = crypto.createHmac('sha256', String(secret));
  h.update(`${row.target}|${row.build_track}|${row.source_rev}|${row.nix_lock_hash}|${row.digest}|${row.bottlerocket_profile}`);
  return h.digest('hex');
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-repro-'));
  const policyPath = path.join(tmp, 'config', 'aws_reproducible_artifact_profile_policy.json');
  const manifestPath = path.join(tmp, 'state', 'ops', 'aws_reproducible_artifact_profile', 'manifest.json');
  const statePath = path.join(tmp, 'state', 'ops', 'aws_reproducible_artifact_profile', 'channel_state.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'aws_reproducible_artifact_profile', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'aws_reproducible_artifact_profile', 'history.jsonl');

  const secret = 'test_secret';
  const shared = {
    source_rev: 'abc123',
    nix_lock_hash: 'nix-lock-1'
  };
  const artifacts = [
    { target: 'ami', build_track: 'nix+image_builder', source_rev: shared.source_rev, nix_lock_hash: shared.nix_lock_hash, digest: 'sha256:1', bottlerocket_profile: 'br-v1' },
    { target: 'ecr', build_track: 'nix', source_rev: shared.source_rev, nix_lock_hash: shared.nix_lock_hash, digest: 'sha256:2', bottlerocket_profile: 'br-v1' },
    { target: 'serverless', build_track: 'nix', source_rev: shared.source_rev, nix_lock_hash: shared.nix_lock_hash, digest: 'sha256:3', bottlerocket_profile: 'br-v1' }
  ];

  writeJson(manifestPath, {
    artifacts: artifacts.map((row) => ({ ...row, provenance_sig: sign(row, secret) }))
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    provenance_secret: secret,
    required_targets: ['ami', 'ecr', 'serverless'],
    required_build_tracks: {
      ami: 'nix+image_builder',
      ecr: 'nix',
      serverless: 'nix'
    },
    require_bottlerocket_profile: true,
    paths: {
      manifest_path: manifestPath,
      channel_state_path: statePath,
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  let out = run(['run', '--channel=stable', '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'profile should pass with valid manifest');

  out = run(['revoke-channel', '--channel=stable', '--reason=drift', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);

  out = run(['run', '--channel=stable', '--strict=1', `--policy=${policyPath}`]);
  assert.notStrictEqual(out.status, 0, 'strict run should fail when channel is revoked');
  assert.strictEqual(out.payload.ok, false, 'run should fail while revoked');

  out = run(['restore-channel', '--channel=stable', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);

  out = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.channel_state, 'status should return channel state');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('aws_reproducible_artifact_profile.test.js: OK');
} catch (err) {
  console.error(`aws_reproducible_artifact_profile.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
