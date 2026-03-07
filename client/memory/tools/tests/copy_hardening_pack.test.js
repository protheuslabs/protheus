#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'copy_hardening_pack.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

function run(args) {
  const res = spawnSync('node', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  let payload = null;
  try { payload = JSON.parse(String(res.stdout || '').trim()); } catch {}
  return { status: res.status == null ? 1 : res.status, payload, stderr: String(res.stderr || '') };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-hardening-pack-'));
  const policyPath = path.join(tmp, 'config', 'copy_hardening_pack_policy.json');
  const modulePath = path.join(tmp, 'module.txt');
  writeText(modulePath, 'secret module body');

  writeJson(policyPath, {
    enabled: true,
    shadow_only: true,
    module_crypto: {
      algorithm: 'aes-256-gcm',
      key_seed: 'unit_test_seed'
    },
    paths: {
      latest_path: path.join(tmp, 'state', 'security', 'copy_hardening_pack', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'security', 'copy_hardening_pack', 'receipts.jsonl'),
      state_path: path.join(tmp, 'state', 'security', 'copy_hardening_pack', 'state.json'),
      variants_path: path.join(tmp, 'state', 'security', 'copy_hardening_pack', 'variants.json'),
      watermarks_path: path.join(tmp, 'state', 'security', 'copy_hardening_pack', 'watermarks.jsonl'),
      modules_path: path.join(tmp, 'state', 'security', 'copy_hardening_pack', 'modules.json'),
      honey_events_path: path.join(tmp, 'state', 'security', 'copy_hardening_pack', 'honey_events.jsonl'),
      forensic_path: path.join(tmp, 'state', 'security', 'copy_hardening_pack', 'forensics.jsonl')
    }
  });

  let res = run(['diversify-build', `--policy=${policyPath}`, '--instance-id=seed-a', '--apply=1']);
  assert.strictEqual(res.status, 0, `diversify-build should pass: ${res.stderr}`);
  assert.ok(res.payload.variant.variant_id, 'variant id expected');

  res = run(['watermark-mesh', `--policy=${policyPath}`, '--artifact-id=artifact-1', '--runtime-fingerprint=fp-1', '--apply=1']);
  assert.strictEqual(res.status, 0, `watermark-mesh should pass: ${res.stderr}`);
  assert.ok(res.payload.watermark.watermark_id, 'watermark expected');

  res = run(['trust-degrade', `--policy=${policyPath}`, '--trust-score=0.2', '--apply=1']);
  assert.strictEqual(res.status, 0, `trust-degrade should pass: ${res.stderr}`);
  assert.strictEqual(res.payload.degrade_mode, 'sandbox_only');

  res = run(['module-seal', `--policy=${policyPath}`, '--module-id=cap_a', `--module-path=${modulePath}`, '--apply=1']);
  assert.strictEqual(res.status, 0, `module-seal should pass: ${res.stderr}`);

  res = run(['module-unseal', `--policy=${policyPath}`, '--module-id=cap_a', '--apply=1']);
  assert.strictEqual(res.status, 0, `module-unseal should pass: ${res.stderr}`);
  assert.strictEqual(res.payload.unsealed, true);

  res = run(['honey-trap', `--policy=${policyPath}`, '--trap-id=decoy-api', '--touch=1', '--apply=1']);
  assert.strictEqual(res.status, 0, `honey-trap should pass: ${res.stderr}`);
  assert.strictEqual(res.payload.touched, true);

  res = run(['clone-risk-score', `--policy=${policyPath}`, '--device-id=unknown', '--geo=UNKNOWN', '--concurrency=30', '--lease-drift=0.9', '--apply=1']);
  assert.strictEqual(res.status, 0, `clone-risk-score should pass: ${res.stderr}`);
  assert.ok(Number(res.payload.risk_score) >= 0.85, 'risk should be high');
  assert.strictEqual(res.payload.action, 'revoke');

  res = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
  assert.ok(res.payload.state, 'state expected');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('copy_hardening_pack.test.js: OK');
} catch (err) {
  console.error(`copy_hardening_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
