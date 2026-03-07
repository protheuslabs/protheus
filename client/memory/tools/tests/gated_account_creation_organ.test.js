#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'workflow', 'gated_account_creation_organ.js');

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8'
  });
}

function parse(proc) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, `expected stdout JSON (stderr=${proc.stderr || ''})`);
  return JSON.parse(raw);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gated-account-organ-'));
  const accountPolicyPath = path.join(tmp, 'config', 'gated_account_creation_policy.json');
  const templatesPath = path.join(tmp, 'config', 'account_creation_templates.json');
  const agentPolicyPath = path.join(tmp, 'config', 'agent_passport_policy.json');
  const aliasPolicyPath = path.join(tmp, 'config', 'alias_verification_vault_policy.json');
  const stateRoot = path.join(tmp, 'state');

  writeJson(templatesPath, {
    version: '1.0-test',
    templates: {
      generic_email_account: {
        risk_class: 'medium',
        alias_channel: 'email',
        alias_purpose: 'account_creation_verification',
        steps: [
          {
            id: 'step_open',
            intent: 'create_account_open_signup',
            profile: {
              profile_id: 'profile_open',
              execution: { adapter_kind: 'browser_task' },
              source: { source_type: 'web_ui' }
            },
            params: { flow: 'open' }
          }
        ]
      },
      payments_merchant_account: {
        risk_class: 'payments',
        alias_channel: 'email',
        alias_purpose: 'payments_verification',
        steps: [
          {
            id: 'step_payments',
            intent: 'create_payments_account_start',
            profile: {
              profile_id: 'profile_payments',
              execution: { adapter_kind: 'browser_task' },
              source: { source_type: 'web_ui' }
            },
            params: { flow: 'start' }
          }
        ]
      }
    }
  });

  writeJson(accountPolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: false,
    require_objective_id: true,
    templates_path: templatesPath,
    high_risk_classes: ['payments', 'auth', 'filesystem', 'shell', 'network-control'],
    require_human_approval_for_high_risk: true,
    execution: {
      mock_mode: true
    },
    state: {
      state_path: path.join(stateRoot, 'workflow', 'gated_account_creation', 'state.json'),
      latest_path: path.join(stateRoot, 'workflow', 'gated_account_creation', 'latest.json'),
      receipts_path: path.join(stateRoot, 'workflow', 'gated_account_creation', 'receipts.jsonl')
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
      role: 'workflow',
      tenant_id: 'local',
      org_id: 'protheus',
      framework_id: 'openclaw',
      model_id: 'test'
    },
    state: {
      root: path.join(stateRoot, 'security', 'agent_passport'),
      passport_path: path.join(stateRoot, 'security', 'agent_passport', 'passport.json'),
      action_log_path: path.join(stateRoot, 'security', 'agent_passport', 'actions.jsonl'),
      chain_state_path: path.join(stateRoot, 'security', 'agent_passport', 'actions.chain.json'),
      latest_path: path.join(stateRoot, 'security', 'agent_passport', 'latest.json'),
      receipts_path: path.join(stateRoot, 'security', 'agent_passport', 'receipts.jsonl')
    },
    pdf: {
      default_out_path: path.join(stateRoot, 'security', 'agent_passport', 'exports', 'latest.pdf'),
      max_rows: 500
    }
  });

  writeJson(aliasPolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: false,
    key_env: 'ALIAS_VERIFICATION_VAULT_KEY',
    key_min_length: 16,
    channels: {
      email: { domain: 'vault.local', prefix: 'ax' },
      sms: { prefix: '+1555000' }
    },
    state: {
      root: path.join(stateRoot, 'security', 'alias_vault'),
      index_path: path.join(stateRoot, 'security', 'alias_vault', 'index.json'),
      latest_path: path.join(stateRoot, 'security', 'alias_vault', 'latest.json'),
      receipts_path: path.join(stateRoot, 'security', 'alias_vault', 'receipts.jsonl')
    }
  });

  const env = {
    ...process.env,
    GATED_ACCOUNT_CREATION_POLICY_PATH: accountPolicyPath,
    GATED_ACCOUNT_CREATION_TEMPLATES_PATH: templatesPath,
    AGENT_PASSPORT_POLICY_PATH: agentPolicyPath,
    AGENT_PASSPORT_SIGNING_KEY: 'agent_passport_signing_key_test_123456',
    ALIAS_VERIFICATION_VAULT_POLICY_PATH: aliasPolicyPath,
    ALIAS_VERIFICATION_VAULT_KEY: 'alias_vault_key_test_1234567890'
  };

  let r = run([
    'create',
    '--template=payments_merchant_account',
    '--objective-id=payments_growth',
    '--apply=1',
    '--mock-execution=1',
    '--gate-soul=pass',
    '--gate-weaver=pass',
    '--gate-constitution=pass'
  ], env);
  assert.strictEqual(r.status, 1, 'high-risk flow should require human approval');

  r = run([
    'create',
    '--template=generic_email_account',
    '--objective-id=acct_growth',
    '--apply=0',
    '--mock-execution=1',
    '--gate-soul=pass',
    '--gate-weaver=pass',
    '--gate-constitution=pass'
  ], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'generic create should pass');
  let out = parse(r);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(String(out.status || ''), 'shadow_only');
  assert.ok(out.passport_id, 'passport id should be present');
  assert.ok(out.alias_id, 'alias id should be present');
  assert.strictEqual(Number(out.step_count || 0), 1, 'single step template should run one step');

  r = run([
    'create',
    '--template=payments_merchant_account',
    '--objective-id=payments_growth',
    '--apply=1',
    '--human-approved=1',
    '--mock-execution=1',
    '--gate-soul=pass',
    '--gate-weaver=pass',
    '--gate-constitution=pass'
  ], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'high-risk with human approval should pass');
  out = parse(r);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(String(out.status || ''), 'applied');

  r = run(['status'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'status should pass');
  out = parse(r);
  assert.ok(Number(out.runs_total || 0) >= 2, 'status should include executed runs');

  console.log('gated_account_creation_organ.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`gated_account_creation_organ.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

