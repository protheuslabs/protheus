#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'ngc_nvidia_enterprise_distribution_adapter.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function signArtifact(row, secret) {
  const h = crypto.createHmac('sha256', String(secret));
  h.update(`${row.target}|${row.channel}|${row.registry}|${row.source_rev}|${row.flake_lock_hash}|${row.digest}|${row.ai_enterprise_profile}`);
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

function run(args, env = {}) {
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ngc-dist-'));
  const policyPath = path.join(tmp, 'config', 'ngc_nvidia_enterprise_distribution_adapter_policy.json');
  const manifestPath = path.join(tmp, 'state', 'ops', 'ngc_nvidia_enterprise_distribution_adapter', 'manifest.json');
  const channelStatePath = path.join(tmp, 'state', 'ops', 'ngc_nvidia_enterprise_distribution_adapter', 'channel_state.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'ngc_nvidia_enterprise_distribution_adapter', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'ngc_nvidia_enterprise_distribution_adapter', 'history.jsonl');
  const secret = 'ngc_nvidia_distribution_secret';
  const channel = 'stable';
  const base = { channel, registry: 'nvcr.io/protheus', source_rev: 'rev-ngc-01', flake_lock_hash: 'flake-ngc-01' };

  const artifacts = [
    { ...base, target: 'seed_image', digest: 'sha256:seed1', ai_enterprise_profile: 'production-certified' },
    { ...base, target: 'lane_container', digest: 'sha256:lane1', ai_enterprise_profile: 'support-lts' }
  ].map((row) => ({ ...row, signature: signArtifact(row, secret) }));

  writeJson(manifestPath, { artifacts });
  writeJson(channelStatePath, { frozen_channels: {} });
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    provenance_secret: secret,
    required_targets: ['seed_image', 'lane_container'],
    required_registry_prefix: 'nvcr.io',
    required_profiles: ['production-certified', 'support-lts'],
    paths: {
      manifest_path: manifestPath,
      channel_state_path: channelStatePath,
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  let out = run(['run', `--channel=${channel}`, '--strict=1', `--policy=${policyPath}`], {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'valid manifest should pass');

  out = run(['freeze-channel', `--channel=${channel}`, '--reason=test_freeze', `--policy=${policyPath}`], {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);

  out = run(['run', `--channel=${channel}`, '--strict=1', `--policy=${policyPath}`], {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.notStrictEqual(out.status, 0, 'frozen channel should fail strict run');
  assert.strictEqual(out.payload.error, 'channel_frozen', 'should block on frozen channel');

  out = run(['restore-channel', `--channel=${channel}`, `--policy=${policyPath}`], {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'restore should pass');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ngc_nvidia_enterprise_distribution_adapter.test.js: OK');
} catch (err) {
  console.error(`ngc_nvidia_enterprise_distribution_adapter.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
