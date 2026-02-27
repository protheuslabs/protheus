#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'phone_seed_profile.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-seed-profile-'));
  const policyPath = path.join(tmp, 'phone_seed_profile_policy.json');
  const embodimentPath = path.join(tmp, 'state', 'hardware', 'embodiment', 'latest.json');
  const statePath = path.join(tmp, 'state', 'ops', 'phone_seed_profile', 'status.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'phone_seed_profile', 'history.jsonl');

  writeJson(embodimentPath, {
    profile_id: 'phone',
    capability_envelope: {
      heavy_lanes_disabled: true
    }
  });
  writeJson(policyPath, {
    version: '1.0-test',
    strict_default: false,
    samples: 3,
    thresholds: {
      boot_ms_max: 800,
      idle_rss_mb_max: 180,
      workflow_latency_ms_max: 3000,
      memory_latency_ms_max: 3000
    },
    require_heavy_lanes_disabled: true,
    embodiment_snapshot_path: embodimentPath,
    boot_probe_command: [process.execPath, '-e', "console.log(JSON.stringify({ok:true,boot_ms:120,rss_mb:95,modules_ok:true,files_ok:true}))"],
    workflow_probe_command: [process.execPath, '-e', "process.exit(0)"],
    memory_probe_command: [process.execPath, '-e', "process.exit(0)"],
    state_path: statePath,
    history_path: historyPath
  });

  const env = { PHONE_SEED_PROFILE_POLICY_PATH: policyPath };

  const runRes = run(['run', '--strict=1'], env);
  assert.strictEqual(runRes.status, 0, runRes.stderr || 'phone seed profile run should pass strict mode');
  const payload = parseJson(runRes.stdout);
  assert.ok(payload && payload.ok === true, 'expected ok payload');
  assert.strictEqual(payload.checks.boot_probe_ok, true, 'boot probe should be healthy');
  assert.strictEqual(payload.checks.heavy_lanes_disabled_by_policy, true, 'heavy lanes should be disabled');
  assert.ok(fs.existsSync(statePath), 'state file should be written');
  assert.ok(fs.existsSync(historyPath), 'history file should be written');

  const statusRes = run(['status'], env);
  assert.strictEqual(statusRes.status, 0, statusRes.stderr || 'status should pass');
  const statusPayload = parseJson(statusRes.stdout);
  assert.ok(statusPayload && statusPayload.ok === true, 'status payload should be ok');

  console.log('phone_seed_profile.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`phone_seed_profile.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
