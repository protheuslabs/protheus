#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'reproducible_distribution_artifact_pack.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function signArtifact(row, secret) {
  const h = crypto.createHmac('sha256', String(secret));
  h.update(`${row.target}|${row.source_rev}|${row.digest}|${row.flake_lock_hash}|${row.build_system}`);
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

function run(args, env) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-dist-'));
  const manifestPath = path.join(tmp, 'state', 'ops', 'reproducible_distribution_artifact_pack', 'manifest.json');
  const channelStatePath = path.join(tmp, 'state', 'ops', 'reproducible_distribution_artifact_pack', 'channel_state.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'reproducible_distribution_artifact_pack', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'reproducible_distribution_artifact_pack', 'history.jsonl');
  const policyPath = path.join(tmp, 'config', 'reproducible_distribution_artifact_pack_policy.json');

  const secret = 'reproducible_distribution_secret';
  const base = {
    source_rev: 'abc123',
    flake_lock_hash: 'flake_hash_001',
    build_system: 'nix_flake'
  };

  const artifacts = [
    { ...base, target: 'container', digest: 'sha256:c1' },
    { ...base, target: 'vm', digest: 'sha256:v1' },
    { ...base, target: 'marketplace', digest: 'sha256:m1' }
  ].map((row) => ({ ...row, provenance_sig: signArtifact(row, secret) }));

  writeJson(manifestPath, { artifacts });
  writeJson(channelStatePath, { revoked_channels: {} });
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    provenance_secret: secret,
    required_build_system: 'nix_flake',
    required_targets: ['container', 'vm', 'marketplace'],
    paths: {
      manifest_path: manifestPath,
      channel_state_path: channelStatePath,
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  let out = run(['run', '--channel=stable', '--strict=1', `--policy=${policyPath}`], {
    REPRO_DISTRIBUTION_ROOT: tmp,
    REPRO_DISTRIBUTION_POLICY_PATH: policyPath
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'reproducible pack should pass with valid signatures');

  const broken = JSON.parse(JSON.stringify(artifacts));
  broken[1].provenance_sig = 'invalid_sig';
  writeJson(manifestPath, { artifacts: broken });

  out = run(['run', '--channel=stable', '--strict=1', `--policy=${policyPath}`], {
    REPRO_DISTRIBUTION_ROOT: tmp,
    REPRO_DISTRIBUTION_POLICY_PATH: policyPath
  });
  assert.notStrictEqual(out.status, 0, 'strict run should fail when provenance is invalid');
  assert.strictEqual(out.payload.ok, false, 'run should fail for invalid provenance');

  out = run(['revoke-channel', '--channel=stable', '--reason=manual_test', `--policy=${policyPath}`], {
    REPRO_DISTRIBUTION_ROOT: tmp,
    REPRO_DISTRIBUTION_POLICY_PATH: policyPath
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);

  out = run(['run', '--channel=stable', '--strict=1', `--policy=${policyPath}`], {
    REPRO_DISTRIBUTION_ROOT: tmp,
    REPRO_DISTRIBUTION_POLICY_PATH: policyPath
  });
  assert.notStrictEqual(out.status, 0, 'revoked channel should fail strict run');
  assert.strictEqual(out.payload.error, 'channel_revoked', 'channel revocation should short-circuit');

  out = run(['restore-channel', '--channel=stable', `--policy=${policyPath}`], {
    REPRO_DISTRIBUTION_ROOT: tmp,
    REPRO_DISTRIBUTION_POLICY_PATH: policyPath
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'restore should succeed');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('reproducible_distribution_artifact_pack.test.js: OK');
} catch (err) {
  console.error(`reproducible_distribution_artifact_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
