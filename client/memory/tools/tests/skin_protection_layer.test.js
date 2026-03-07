#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'skin_protection_layer.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(args) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout || '').trim()); } catch {}
  return {
    status: r.status == null ? 1 : r.status,
    payload,
    stderr: String(r.stderr || '')
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-protection-layer-'));
  const policyPath = path.join(tmp, 'config', 'skin_protection_policy.json');

  const stateRoot = path.join(tmp, 'state', 'security', 'skin_protection');
  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    shadow_only: false,
    auto_stasis_on_fail: true,
    contract_mesh: {
      required_by_lane: {
        global: [],
        execution_primitive: [
          'safety_attestation',
          'rollback_receipt',
          'guard_receipt_id'
        ]
      }
    },
    runtime_attestation: {
      enabled: false
    },
    binary_hardening: {
      enabled: false
    },
    paths: {
      latest_path: path.join(stateRoot, 'latest.json'),
      history_path: path.join(stateRoot, 'history.jsonl'),
      stasis_state_path: path.join(stateRoot, 'stasis_state.json')
    }
  });

  let res = run([
    'verify',
    `--policy=${policyPath}`,
    '--lane=execution_primitive',
    '--context-json={}',
    '--strict=1'
  ]);
  assert.notStrictEqual(res.status, 0, `verify should fail when required contract context is missing: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === false, 'failed verify should return ok=false');
  assert.ok(Array.isArray(res.payload.fail_reasons) && res.payload.fail_reasons.includes('contract_mesh_failed'));

  res = run([
    'verify',
    `--policy=${policyPath}`,
    '--lane=execution_primitive',
    '--context-json={"safety_attestation":"sa_1","rollback_receipt":"rb_1","guard_receipt_id":"gr_1"}',
    '--strict=1'
  ]);
  assert.strictEqual(res.status, 0, `verify should pass with complete contract context: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'successful verify should return ok=true');

  res = run([
    'enforce',
    `--policy=${policyPath}`,
    '--lane=execution_primitive',
    '--context-json={}',
    '--strict=1'
  ]);
  assert.notStrictEqual(res.status, 0, `enforce should fail strict when checks fail: ${res.stderr}`);
  assert.ok(res.payload && res.payload.stasis && res.payload.stasis.containment_applied === true, 'containment should apply on enforce failure');

  res = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.stasis && res.payload.stasis.active === true, 'stasis should be active after enforce failure');

  res = run(['clear-stasis', `--policy=${policyPath}`, '--reason=test_release']);
  assert.strictEqual(res.status, 0, `clear-stasis should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'clear-stasis should return ok=true');

  res = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.stasis && res.payload.stasis.active === false, 'stasis should clear');

  const shadowPolicyPath = path.join(tmp, 'config', 'skin_protection_policy_shadow.json');
  writeJson(shadowPolicyPath, {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    auto_stasis_on_fail: true,
    contract_mesh: {
      required_by_lane: {
        global: [],
        execution_primitive: ['safety_attestation']
      }
    },
    runtime_attestation: { enabled: false },
    binary_hardening: { enabled: false },
    paths: {
      latest_path: path.join(stateRoot, 'latest_shadow.json'),
      history_path: path.join(stateRoot, 'history_shadow.jsonl'),
      stasis_state_path: path.join(stateRoot, 'stasis_shadow.json')
    }
  });

  res = run([
    'verify',
    `--policy=${shadowPolicyPath}`,
    '--lane=execution_primitive',
    '--context-json={}',
    '--strict=1'
  ]);
  assert.strictEqual(res.status, 0, `shadow verify should not hard-fail: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'shadow verify should remain ok=true');
  assert.ok(Array.isArray(res.payload.fail_reasons) && res.payload.fail_reasons.includes('contract_mesh_failed'));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('skin_protection_layer.test.js: OK');
} catch (err) {
  console.error(`skin_protection_layer.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
