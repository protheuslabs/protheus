#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'hardware', 'compression_transfer_plane.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compression-transfer-plane-'));
  const policyPath = path.join(tmp, 'compression_transfer_plane_policy.json');
  const bundleDir = path.join(tmp, 'state', 'hardware', 'compression_transfer_plane', 'bundles');
  const latestPath = path.join(tmp, 'state', 'hardware', 'compression_transfer_plane', 'latest.json');
  const receiptsPath = path.join(tmp, 'state', 'hardware', 'compression_transfer_plane', 'receipts.jsonl');
  const includePath = path.join(tmp, 'state', 'runtime', 'scheduler_mode', 'latest.json');

  writeJson(includePath, {
    schema_id: 'runtime_scheduler_state',
    mode: 'operational',
    updated_at: new Date().toISOString()
  });
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: false,
    apply_default: false,
    bundle_dir: bundleDir,
    latest_path: latestPath,
    receipts_path: receiptsPath,
    include_paths: [includePath]
  });
  const env = { COMPRESSION_TRANSFER_PLANE_POLICY_PATH: policyPath };

  const compress = run(['compress', '--strict=1'], env);
  assert.strictEqual(compress.status, 0, compress.stderr || 'compress should pass');
  const compressPayload = parseJson(compress.stdout);
  assert.ok(compressPayload && compressPayload.ok === true, 'compress payload should be ok');
  assert.ok(compressPayload.bundle_id, 'bundle id should be present');
  const bundlePath = path.join(bundleDir, `${compressPayload.bundle_id}.json`);
  assert.ok(fs.existsSync(bundlePath), 'bundle file should exist');

  writeJson(includePath, {
    schema_id: 'runtime_scheduler_state',
    mode: 'inversion',
    updated_at: new Date().toISOString()
  });

  const expand = run(['expand', `--bundle-id=${compressPayload.bundle_id}`, '--apply=1', '--strict=1'], env);
  assert.strictEqual(expand.status, 0, expand.stderr || 'expand should pass');
  const expandPayload = parseJson(expand.stdout);
  assert.ok(expandPayload && expandPayload.ok === true, 'expand payload should be ok');
  const restored = JSON.parse(fs.readFileSync(includePath, 'utf8'));
  assert.strictEqual(restored.mode, 'operational', 'restored file should match compressed state');

  const status = run(['status'], env);
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  const statusPayload = parseJson(status.stdout);
  assert.ok(statusPayload && statusPayload.ok === true, 'status payload should be ok');
  assert.ok(Number(statusPayload.bundle_count || 0) >= 1, 'status should report bundles');

  console.log('compression_transfer_plane.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`compression_transfer_plane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
