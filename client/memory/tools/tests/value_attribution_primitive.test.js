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
  const scriptPath = path.join(repoRoot, 'systems', 'attribution', 'value_attribution_primitive.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'value-attribution-'));

  const policyPath = path.join(tmpRoot, 'config', 'value_attribution_primitive_policy.json');
  const agentPolicyPath = path.join(tmpRoot, 'config', 'agent_passport_policy.json');
  const recordsPath = path.join(tmpRoot, 'state', 'assimilation', 'value_attribution', 'records.jsonl');
  const helixEventsPath = path.join(tmpRoot, 'state', 'helix', 'events.jsonl');
  const passportActionsPath = path.join(tmpRoot, 'state', 'security', 'agent_passport', 'actions.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    allow_apply: false,
    scoring: {
      default_weight: 1,
      default_confidence: 0.8,
      default_impact: 0.7
    },
    sovereign_root_tithe: {
      enabled: true,
      tithe_bps: 1000,
      beneficiary_creator_id: 'jay_sovereign_root',
      beneficiary_wallet_alias: 'jay_root_wallet',
      enforce_root_first: true
    },
    passport: {
      enabled: true,
      source: 'value_attribution_primitive'
    },
    helix: {
      enabled: true,
      events_path: helixEventsPath
    },
    state: {
      root: path.join(tmpRoot, 'state', 'assimilation', 'value_attribution'),
      records_path: recordsPath,
      latest_path: path.join(tmpRoot, 'state', 'assimilation', 'value_attribution', 'latest.json'),
      history_path: path.join(tmpRoot, 'state', 'assimilation', 'value_attribution', 'history.jsonl'),
      receipts_path: path.join(tmpRoot, 'state', 'assimilation', 'value_attribution', 'receipts.jsonl')
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
    VALUE_ATTRIBUTION_POLICY_PATH: policyPath,
    AGENT_PASSPORT_POLICY_PATH: agentPolicyPath,
    AGENT_PASSPORT_SIGNING_KEY: 'agent_passport_signing_key_for_tests_123456'
  };

  const recordPayload = {
    source_type: 'external_adapter',
    source_id: 'tool.stripe.v1',
    source_url: 'https://example.test/stripe',
    creator_id: 'creator_alpha',
    creator_alias: 'Alpha',
    creator_opt_in: true,
    license: 'mit',
    objective_id: 'obj_attr_test',
    capability_id: 'cap_payment_bridge',
    task_id: 'task_1',
    run_id: 'run_attr_1',
    lane: 'assimilation',
    weight: 1.5,
    confidence: 0.8,
    impact_score: 0.7,
    value_event_usd: 250
  };

  const record = parseOut(runNode(scriptPath, [
    'record',
    `--policy=${policyPath}`,
    `--input-json=${JSON.stringify(recordPayload)}`
  ], env, repoRoot), 'record');
  assert.strictEqual(record.ok, true);
  assert.ok(record.attribution_id, 'record should return attribution_id');
  assert.strictEqual(record.shadow_only, true, 'record should respect shadow mode');
  assert.ok(record.passport_link && record.passport_link.action_id, 'record should link to agent passport');
  assert.strictEqual(Number(record.root_tithe_bps || 0), 1000, 'record should report tithe bps');
  assert.strictEqual(Number(record.root_tithe_value_usd || 0), 25, 'record should report tithe amount');

  const query = parseOut(runNode(scriptPath, [
    'query',
    `--policy=${policyPath}`,
    '--creator-id=creator_alpha'
  ], env, repoRoot), 'query');
  assert.strictEqual(query.ok, true);
  assert.strictEqual(query.count, 1, 'query should return stored row');
  assert.strictEqual(query.records[0].attribution_id, record.attribution_id);
  assert.strictEqual(
    Number(query.records[0].provenance.economic.sovereign_root_tithe.tithe_bps || 0),
    1000,
    'query should include tithe metadata'
  );
  assert.strictEqual(
    Number(query.records[0].provenance.economic.sovereign_root_tithe.tithe_value_usd || 0),
    25,
    'query should include tithe value'
  );

  const status = parseOut(runNode(scriptPath, ['status', `--policy=${policyPath}`], env, repoRoot), 'status');
  assert.strictEqual(status.ok, true);
  assert.strictEqual(Number(status.records_total || 0), 1, 'status should count recorded row');

  const recordRows = readJsonl(recordsPath);
  assert.strictEqual(recordRows.length, 1);
  assert.strictEqual(recordRows[0].attribution_id, record.attribution_id);

  const helixRows = readJsonl(helixEventsPath);
  assert.strictEqual(helixRows.length, 1, 'helix event should be emitted');
  assert.strictEqual(helixRows[0].type, 'value_attribution_recorded');

  const passportRows = readJsonl(passportActionsPath);
  assert.ok(
    passportRows.some((row) => (
      row.action_type === 'value_attribution_recorded'
      || (row.action && row.action.action_type === 'value_attribution_recorded')
    )),
    'passport chain should include attribution action'
  );

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('value_attribution_primitive.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`value_attribution_primitive.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
