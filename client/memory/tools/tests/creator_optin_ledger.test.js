#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function parseOut(proc, label) {
  assert.strictEqual(proc.status, 0, `${label} failed: ${proc.stderr || proc.stdout}`);
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, `${label} missing stdout`);
  return JSON.parse(raw);
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return String(fs.readFileSync(filePath, 'utf8') || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'storm', 'creator_optin_ledger.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-optin-'));

  const policyPath = path.join(tmpRoot, 'config', 'creator_optin_ledger_policy.json');
  const agentPolicyPath = path.join(tmpRoot, 'config', 'agent_passport_policy.json');
  const publicLedgerPath = path.join(tmpRoot, 'state', 'storm', 'creator_optin', 'public_ledger.jsonl');
  const passportActionsPath = path.join(tmpRoot, 'state', 'security', 'agent_passport', 'actions.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    allow_apply: false,
    privacy: {
      hash_salt_env: 'STORM_LEDGER_SALT',
      expose_public_name: false
    },
    partnership: {
      tiers: [
        { id: 'seed', min_influence: 0 },
        { id: 'bronze', min_influence: 1 },
        { id: 'silver', min_influence: 2 }
      ],
      badges: {
        first_optin: { min_events: 1 },
        contributor: { min_events: 3 }
      }
    },
    state: {
      root: path.join(tmpRoot, 'state', 'storm', 'creator_optin'),
      index_path: path.join(tmpRoot, 'state', 'storm', 'creator_optin', 'index.json'),
      latest_path: path.join(tmpRoot, 'state', 'storm', 'creator_optin', 'latest.json'),
      history_path: path.join(tmpRoot, 'state', 'storm', 'creator_optin', 'history.jsonl'),
      public_ledger_path: publicLedgerPath,
      receipts_path: path.join(tmpRoot, 'state', 'storm', 'creator_optin', 'receipts.jsonl')
    },
    passport: {
      enabled: true,
      source: 'creator_optin_ledger'
    }
  });

  writeJson(agentPolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: false,
    auto_issue_passport: true,
    require_active_passport: false,
    passport_ttl_hours: 24,
    key_env: 'AGENT_PASSPORT_SIGNING_KEY',
    actor_defaults: {
      actor_id: 'test_actor',
      role: 'system',
      tenant_id: 'local',
      org_id: 'protheus',
      framework_id: 'openclaw',
      model_id: 'test'
    },
    state: {
      root: path.join(tmpRoot, 'state', 'security', 'agent_passport'),
      passport_path: path.join(tmpRoot, 'state', 'security', 'agent_passport', 'passport.json'),
      action_log_path: passportActionsPath,
      chain_state_path: path.join(tmpRoot, 'state', 'security', 'agent_passport', 'actions.chain.json'),
      latest_path: path.join(tmpRoot, 'state', 'security', 'agent_passport', 'latest.json'),
      receipts_path: path.join(tmpRoot, 'state', 'security', 'agent_passport', 'receipts.jsonl')
    }
  });

  const env = {
    ...process.env,
    CREATOR_OPTIN_LEDGER_POLICY_PATH: policyPath,
    AGENT_PASSPORT_POLICY_PATH: agentPolicyPath,
    AGENT_PASSPORT_SIGNING_KEY: 'agent_passport_signing_key_for_tests_123456',
    STORM_LEDGER_SALT: 'storm_test_salt'
  };

  const optIn = parseOut(runNode(scriptPath, [
    'opt-in',
    `--policy=${policyPath}`,
    '--creator-id=creator_alpha',
    '--alias=Alpha',
    '--mode=royalty'
  ], env, repoRoot), 'opt-in');
  assert.strictEqual(optIn.ok, true);
  assert.strictEqual(optIn.opted_in, true);

  for (let i = 0; i < 3; i += 1) {
    const rec = parseOut(runNode(scriptPath, [
      'record-contribution',
      `--policy=${policyPath}`,
      '--creator-id=creator_alpha',
      '--influence=0.7',
      '--weight=1',
      `--source-id=src_${i + 1}`
    ], env, repoRoot), `record-contribution-${i + 1}`);
    assert.strictEqual(rec.ok, true);
  }

  const publish = parseOut(runNode(scriptPath, ['publish', `--policy=${policyPath}`], env, repoRoot), 'publish');
  assert.strictEqual(publish.ok, true);
  assert.strictEqual(publish.count, 1, 'publish should include opted-in creator');
  assert.ok(publish.rows[0].public_creator_ref, 'public creator ref should be present');
  assert.strictEqual(publish.rows[0].public_name, null, 'public name should be hidden by default');
  assert.ok(!Object.prototype.hasOwnProperty.call(publish.rows[0], 'creator_id'), 'public row should not expose raw creator id');

  const status = parseOut(runNode(scriptPath, ['status', `--policy=${policyPath}`], env, repoRoot), 'status');
  assert.strictEqual(status.ok, true);
  assert.strictEqual(status.creators_total, 1);
  assert.strictEqual(status.creators[0].opted_in, true);
  assert.ok(
    Array.isArray(status.creators[0].partnership.badges) && status.creators[0].partnership.badges.includes('contributor'),
    'creator should receive contributor badge after contribution events'
  );

  const optOut = parseOut(runNode(scriptPath, [
    'opt-out',
    `--policy=${policyPath}`,
    '--creator-id=creator_alpha'
  ], env, repoRoot), 'opt-out');
  assert.strictEqual(optOut.ok, true);
  assert.strictEqual(optOut.opted_in, false);

  const ledgerRows = readJsonl(publicLedgerPath);
  assert.strictEqual(ledgerRows.length, 1, 'public ledger row should be written');
  assert.ok(ledgerRows[0].public_creator_ref, 'public ledger should contain hashed creator reference');
  assert.ok(!Object.prototype.hasOwnProperty.call(ledgerRows[0], 'creator_id'));

  const passportRows = readJsonl(passportActionsPath);
  assert.ok(
    passportRows.some((row) => (
      row.action_type === 'creator_optin'
      || (row.action && row.action.action_type === 'creator_optin')
    )),
    'passport chain should include creator opt-in action'
  );

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('creator_optin_ledger.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`creator_optin_ledger.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
