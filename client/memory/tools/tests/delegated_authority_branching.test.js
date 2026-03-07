#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, value) {
  write(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function run(script, cwd, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
  return {
    status: Number(r.status || 0),
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    payload: parseJson(r.stdout)
  };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(repoRoot, 'systems', 'security', 'delegated_authority_branching.js');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegated-authority-'));
  const delegatedPolicyPath = path.join(tmp, 'config', 'delegated_authority_policy.json');
  const keyPolicyPath = path.join(tmp, 'config', 'key_lifecycle_policy.json');
  const keyStatePath = path.join(tmp, 'state', 'security', 'key_lifecycle', 'state.json');
  const constitutionPolicyPath = path.join(tmp, 'config', 'constitution_guardian_policy.json');

  writeJson(keyPolicyPath, {
    schema_id: 'key_lifecycle_policy',
    schema_version: '1.0',
    enabled: true,
    key_classes: ['signing', 'encryption'],
    allowed_algorithms: ['ed25519'],
    default_algorithm: 'ed25519',
    state_path: keyStatePath,
    receipts_path: path.join(tmp, 'state', 'security', 'key_lifecycle', 'receipts.jsonl'),
    crypto_agility_contract_path: path.join(tmp, 'config', 'crypto_agility_contract.json')
  });

  writeJson(keyStatePath, {
    schema_id: 'key_lifecycle_state',
    schema_version: '1.0',
    updated_at: new Date().toISOString(),
    keys: {
      key_primary: {
        key_id: 'key_primary',
        key_class: 'signing',
        status: 'active',
        algorithm: 'ed25519'
      }
    }
  });

  writeJson(constitutionPolicyPath, {
    schema_id: 'constitution_guardian_policy',
    schema_version: '1.0',
    enabled: true
  });

  writeJson(delegatedPolicyPath, {
    schema_id: 'delegated_authority_policy',
    schema_version: '1.0',
    enabled: true,
    shadow_only: false,
    signing_key_env: 'DELEGATED_AUTHORITY_SIGNING_KEY',
    signing_key_min_length: 24,
    default_ttl_hours: 24,
    max_ttl_hours: 240,
    min_approval_note_chars: 8,
    required_key_class: 'signing',
    required_constitution_guard_enabled: true,
    constitution_denied_scopes: ['constitution_mutation', 'policy_root_bypass'],
    paths: {
      key_lifecycle_policy: keyPolicyPath,
      constitution_guardian_policy: constitutionPolicyPath,
      index_path: path.join(tmp, 'state', 'security', 'delegated_authority', 'index.json'),
      latest_path: path.join(tmp, 'state', 'security', 'delegated_authority', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'security', 'delegated_authority', 'receipts.jsonl')
    },
    handoff_contract: {
      v4_contract_id: 'v4_succession_branch_handoff',
      minimum_fields: ['branch_id', 'delegate_id', 'roles', 'scopes', 'expires_at', 'revoked_at']
    }
  });

  const env = {
    ...process.env,
    DELEGATED_AUTHORITY_ROOT: tmp,
    DELEGATED_AUTHORITY_POLICY_PATH: delegatedPolicyPath,
    DELEGATED_AUTHORITY_SIGNING_KEY: 'delegated_authority_signing_key_for_test_12345'
  };

  const issue = run(script, repoRoot, [
    'issue',
    '--delegate-id=family_member',
    '--roles=observer,operator',
    '--scopes=memory_read,status_view',
    '--ttl-hours=48',
    '--approved-by=owner',
    '--approval-note=delegation_for_support_and_status_visibility',
    `--policy=${delegatedPolicyPath}`
  ], env);
  assert.strictEqual(issue.status, 0, issue.stderr || 'issue should pass');
  assert.ok(issue.payload && issue.payload.ok === true, 'issue payload should be ok');
  const branchId = String(issue.payload.branch_id || '');
  assert.ok(branchId.startsWith('soul_branch_'), 'branch id should be generated');

  const evaluateAllow = run(script, repoRoot, [
    'evaluate',
    `--branch-id=${branchId}`,
    '--scope=memory_read',
    '--role=observer',
    `--policy=${delegatedPolicyPath}`
  ], env);
  assert.strictEqual(evaluateAllow.status, 0, evaluateAllow.stderr || 'evaluate should pass for allowed scope');
  assert.ok(evaluateAllow.payload && evaluateAllow.payload.ok === true, 'allowed evaluation should be ok');

  const evaluateDenied = run(script, repoRoot, [
    'evaluate',
    `--branch-id=${branchId}`,
    '--scope=constitution_mutation',
    '--role=observer',
    `--policy=${delegatedPolicyPath}`
  ], env);
  assert.notStrictEqual(evaluateDenied.status, 0, 'denied scope should fail evaluation');
  assert.ok(evaluateDenied.payload && evaluateDenied.payload.ok === false, 'denied evaluation should be false');

  const handoff = run(script, repoRoot, ['handoff-contract', `--branch-id=${branchId}`, `--policy=${delegatedPolicyPath}`], env);
  assert.strictEqual(handoff.status, 0, handoff.stderr || 'handoff contract should pass');
  assert.ok(handoff.payload && handoff.payload.ok === true, 'handoff payload should be ok');
  assert.strictEqual(String(handoff.payload.contract && handoff.payload.contract.compatible_with || ''), 'V4-006', 'handoff must declare V4-006 compatibility');

  const revoke = run(script, repoRoot, [
    'revoke',
    `--branch-id=${branchId}`,
    '--revoked-by=owner',
    '--reason=delegation_window_closed',
    `--policy=${delegatedPolicyPath}`
  ], env);
  assert.strictEqual(revoke.status, 0, revoke.stderr || 'revoke should pass');
  assert.ok(revoke.payload && revoke.payload.ok === true, 'revoke payload should be ok');

  const evaluateAfterRevoke = run(script, repoRoot, [
    'evaluate',
    `--branch-id=${branchId}`,
    '--scope=memory_read',
    '--role=observer',
    `--policy=${delegatedPolicyPath}`
  ], env);
  assert.notStrictEqual(evaluateAfterRevoke.status, 0, 'revoked branch should fail evaluation');

  const status = run(script, repoRoot, ['status', `--policy=${delegatedPolicyPath}`], env);
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  assert.ok(status.payload && status.payload.ok === true, 'status payload should be ok');
  assert.strictEqual(Number(status.payload.counts && status.payload.counts.total_branches || 0), 1, 'status should include branch count');
  assert.strictEqual(Number(status.payload.counts && status.payload.counts.revoked_branches || 0), 1, 'status should include revoked count');

  console.log('delegated_authority_branching.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`delegated_authority_branching.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
