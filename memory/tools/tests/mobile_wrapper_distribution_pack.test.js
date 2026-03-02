#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'mobile_wrapper_distribution_pack.js');

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
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-wrapper-pack-'));
  const policyPath = path.join(tmp, 'config', 'mobile_wrapper_distribution_pack_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'edge.wrapper_distribution' },
    allowed_targets: ['android_termux', 'ios_tauri'],
    wrappers: {
      android_termux: {
        install_script_path: path.join(ROOT, 'packages', 'protheus-edge', 'wrappers', 'android_termux', 'install.sh'),
        run_script_path: path.join(ROOT, 'packages', 'protheus-edge', 'wrappers', 'android_termux', 'run.sh'),
        verify_script_path: path.join(ROOT, 'packages', 'protheus-edge', 'wrappers', 'android_termux', 'verify.sh')
      },
      ios_tauri: {
        install_script_path: path.join(ROOT, 'packages', 'protheus-edge', 'wrappers', 'ios_tauri', 'install.sh'),
        run_script_path: path.join(ROOT, 'packages', 'protheus-edge', 'wrappers', 'ios_tauri', 'run.sh'),
        verify_script_path: path.join(ROOT, 'packages', 'protheus-edge', 'wrappers', 'ios_tauri', 'verify.sh')
      }
    },
    paths: {
      memory_dir: path.join(tmp, 'memory', 'edge', 'mobile_wrapper_distribution'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'edge', 'mobile_wrapper_distribution', 'index.json'),
      events_path: path.join(tmp, 'state', 'edge', 'mobile_wrapper_distribution', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'edge', 'mobile_wrapper_distribution', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'edge', 'mobile_wrapper_distribution', 'receipts.jsonl'),
      manifest_path: path.join(tmp, 'state', 'edge', 'mobile_wrapper_distribution', 'manifest.json')
    }
  });

  let out = run(['build', '--owner=jay', '--target=android_termux', '--version=0.1.0', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'mobile_wrapper_bundle_built');

  out = run(['verify', '--owner=jay', '--target=android_termux', '--strict=1', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'mobile_wrapper_bundle_verified');

  out = run(['status', '--owner=jay', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(Number(out.payload.bundle_count || 0) >= 1, true);

  out = run(['rollback', '--owner=jay', '--target=android_termux', '--reason=test', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'mobile_wrapper_bundle_rollback');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('mobile_wrapper_distribution_pack.test.js: OK');
} catch (err) {
  console.error(`mobile_wrapper_distribution_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
