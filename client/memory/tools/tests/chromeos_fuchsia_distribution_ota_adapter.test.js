#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'chromeos_fuchsia_distribution_ota_adapter.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function signPackage(row, secret) {
  const h = crypto.createHmac('sha256', String(secret));
  h.update(`${row.target}|${row.channel}|${row.build_rev}|${row.package_digest}|${row.ota_track}`);
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chromeos-fuchsia-ota-'));
  const policyPath = path.join(tmp, 'config', 'chromeos_fuchsia_distribution_ota_adapter_policy.json');
  const manifestPath = path.join(tmp, 'state', 'ops', 'chromeos_fuchsia_distribution_ota_adapter', 'manifest.json');
  const channelStatePath = path.join(tmp, 'state', 'ops', 'chromeos_fuchsia_distribution_ota_adapter', 'channel_state.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'chromeos_fuchsia_distribution_ota_adapter', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'chromeos_fuchsia_distribution_ota_adapter', 'history.jsonl');
  const secret = 'chromeos_fuchsia_ota_secret';
  const channel = 'chromeos-stable';
  const base = { channel, build_rev: 'rev-cf-01' };

  const artifacts = [
    { ...base, target: 'chromeos', package_digest: 'sha256:chromeos1', ota_track: 'chromeos-ota' },
    { ...base, target: 'fuchsia', package_digest: 'sha256:fuchsia1', ota_track: 'fuchsia-ota' }
  ].map((row) => ({ ...row, signature: signPackage(row, secret) }));

  writeJson(manifestPath, {
    artifacts,
    ota_contract: {
      stages: [5, 25, 50, 100],
      rollback_window_minutes: 180
    }
  });
  writeJson(channelStatePath, { frozen_channels: {} });
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    signing_secret: secret,
    required_targets: ['chromeos', 'fuchsia'],
    required_channels: ['chromeos-stable', 'fuchsia-stable'],
    required_stage_plan: [5, 25, 50, 100],
    min_rollback_window_minutes: 60,
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
  assert.strictEqual(out.payload.parity_ok, true, 'parity should pass');

  out = run(['freeze-channel', `--channel=${channel}`, '--reason=test_lock', `--policy=${policyPath}`], {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);

  out = run(['run', `--channel=${channel}`, '--strict=1', `--policy=${policyPath}`], {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.notStrictEqual(out.status, 0, 'frozen channel should fail strict run');
  assert.strictEqual(out.payload.error, 'channel_frozen', 'should short-circuit frozen channel');

  out = run(['restore-channel', `--channel=${channel}`, `--policy=${policyPath}`], {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'restore should pass');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('chromeos_fuchsia_distribution_ota_adapter.test.js: OK');
} catch (err) {
  console.error(`chromeos_fuchsia_distribution_ota_adapter.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
