#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'secret_rotation_migration_auditor.js');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
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

function writeJson(absPath, payload) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-rotation-auditor-'));
  const runbookPath = path.join(tmp, 'SECRET_ROTATION_MIGRATION.md');
  const statePath = path.join(tmp, 'latest.json');
  const receiptsPath = path.join(tmp, 'receipts.jsonl');
  const brokerPolicyPath = path.join(tmp, 'secret_broker_policy.json');
  const policyPath = path.join(tmp, 'secret_rotation_migration_policy.json');

  fs.writeFileSync(runbookPath, [
    '# Secret rotation',
    'node client/systems/security/secret_broker.js rotation-check --strict=1',
    'node client/systems/security/secret_rotation_migration_auditor.js attest --apply=1'
  ].join('\n'), 'utf8');

  writeJson(brokerPolicyPath, {
    version: '1.0',
    rotation_policy: {
      warn_after_days: 30,
      max_after_days: 60
    },
    secrets: {
      moltbook_api_key: {
        providers: [
          { type: 'env', env: 'MOLTBOOK_TOKEN' },
          { type: 'json_file', paths: [path.join(os.homedir(), '.config', 'protheus', 'secrets', 'moltbook.credentials.json')], field: 'api_key' }
        ]
      },
      moltstack_api_key: {
        providers: [
          { type: 'env', env: 'MOLTSTACK_TOKEN' }
        ]
      }
    }
  });

  writeJson(policyPath, {
    enabled: true,
    broker_policy_path: brokerPolicyPath,
    required_secret_ids: ['moltbook_api_key', 'moltstack_api_key'],
    attestation: {
      max_age_days: 90,
      required_flags: ['active_keys_rotated', 'history_scrub_verified', 'secret_manager_migrated'],
      state_path: statePath,
      receipts_path: receiptsPath
    },
    scan: {
      enabled: false,
      fail_on_hits: true,
      max_hits: 5,
      max_file_bytes: 100000,
      patterns: []
    },
    runbook_path: runbookPath
  });

  const initialStatus = run(['status', '--strict=1', `--policy=${policyPath}`]);
  assert.notStrictEqual(initialStatus.status, 0, 'status should fail before attestation');

  const att = run([
    'attest',
    '--operator-id=test_operator',
    '--approval-note=rotation completed and history scrub verified',
    '--apply=1',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(att.status, 0, att.stderr || 'attestation should pass');
  const attPayload = parseJson(att.stdout);
  assert.ok(attPayload && attPayload.ok === true && attPayload.applied === true, 'attestation payload invalid');

  const strictStatus = run(['status', '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(strictStatus.status, 0, strictStatus.stderr || 'status should pass after attestation');
  const strictPayload = parseJson(strictStatus.stdout);
  assert.ok(strictPayload && strictPayload.ok === true, 'strict status payload should pass');

  const badBrokerPolicyPath = path.join(tmp, 'secret_broker_policy_bad.json');
  writeJson(badBrokerPolicyPath, {
    version: '1.0',
    rotation_policy: {
      warn_after_days: 30,
      max_after_days: 60
    },
    secrets: {
      moltbook_api_key: {
        providers: [
          { type: 'json_file', paths: [path.join(ROOT, 'config', 'moltbook', 'credentials.json')], field: 'api_key' }
        ]
      },
      moltstack_api_key: {
        providers: [
          { type: 'env', env: 'MOLTSTACK_TOKEN' }
        ]
      }
    }
  });
  writeJson(policyPath, {
    enabled: true,
    broker_policy_path: badBrokerPolicyPath,
    required_secret_ids: ['moltbook_api_key', 'moltstack_api_key'],
    attestation: {
      max_age_days: 90,
      required_flags: ['active_keys_rotated', 'history_scrub_verified', 'secret_manager_migrated'],
      state_path: statePath,
      receipts_path: receiptsPath
    },
    scan: {
      enabled: false,
      fail_on_hits: true,
      max_hits: 5,
      max_file_bytes: 100000,
      patterns: []
    },
    runbook_path: runbookPath
  });
  const badStatus = run(['status', '--strict=1', `--policy=${policyPath}`]);
  assert.notStrictEqual(badStatus.status, 0, 'status should fail when broker points to repo-local secret file');

  console.log('secret_rotation_migration_auditor.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`secret_rotation_migration_auditor.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
