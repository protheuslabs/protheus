#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'routing', 'provider_onboarding_manifest.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function run(args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || '')
  };
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '').trim());
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-onboard-'));
  const manifestPath = path.join(tmp, 'config', 'provider_manifest.json');
  const routingPath = path.join(tmp, 'config', 'agent_routing_rules.json');
  const adaptersPath = path.join(tmp, 'config', 'model_adapters.json');
  const secretPath = path.join(tmp, 'config', 'secret_broker_policy.json');
  const trainabilityPath = path.join(tmp, 'config', 'trainability_matrix_policy.json');
  const receiptsPath = path.join(tmp, 'state', 'routing', 'provider_onboarding_receipts.jsonl');

  writeJson(manifestPath, {
    version: '1.0-test',
    providers: {
      acme_provider: {
        enabled: true,
        model_id: 'acme/model-x',
        provider_key: 'acme',
        tiers: [2],
        roles: ['logic', 'general'],
        class: 'cloud_specialist',
        spawn_allowed: true,
        budget: {
          daily_token_cap: 12345,
          request_token_cap: 2100
        },
        guard: {
          max_risk: 'medium',
          require_second_opinion_for_high_risk: false
        },
        secret: {
          secret_id: 'acme_api_key',
          env_var: 'ACME_API_KEY'
        },
        trainability: {
          allow: false,
          note: 'terms pending'
        }
      }
    }
  });

  writeJson(routingPath, {
    version: 1,
    routing: {
      spawn_model_allowlist: ['ollama/smallthinker'],
      model_profiles: {}
    }
  });
  writeJson(adaptersPath, {
    schema_version: 1,
    mode_routing: {}
  });
  writeJson(secretPath, {
    version: '1.0',
    secrets: {}
  });
  writeJson(trainabilityPath, {
    version: '1.0',
    default_allow: false,
    provider_rules: {}
  });

  const baseArgs = [
    `--manifest=${manifestPath}`,
    `--routing-config=${routingPath}`,
    `--mode-adapters=${adaptersPath}`,
    `--secret-policy=${secretPath}`,
    `--trainability-policy=${trainabilityPath}`,
    `--receipts-path=${receiptsPath}`,
    '--provider=acme_provider'
  ];

  const plan = run(['run', ...baseArgs, '--apply=0', '--strict=1']);
  assert.strictEqual(plan.status, 0, `plan failed: ${plan.stderr || plan.stdout}`);
  const planPayload = parseJson(plan.stdout);
  assert.strictEqual(planPayload.ok, true, 'plan should be ok');
  assert.strictEqual(planPayload.mode, 'plan', 'plan mode expected');
  assert.strictEqual(planPayload.pass, true, 'plan checks should pass');
  assert.ok(Number(planPayload.elapsed_ms || 0) < 900000, 'expected onboarding under 15 minutes');

  const apply = run(['run', ...baseArgs, '--apply=1', '--strict=1']);
  assert.strictEqual(apply.status, 0, `apply failed: ${apply.stderr || apply.stdout}`);
  const applyPayload = parseJson(apply.stdout);
  assert.strictEqual(applyPayload.mode, 'apply', 'apply mode expected');
  assert.strictEqual(applyPayload.pass, true, 'apply checks should pass');

  const routing = readJson(routingPath);
  assert.ok(routing.routing.model_profiles['acme/model-x'], 'routing model profile missing');
  assert.ok((routing.routing.spawn_model_allowlist || []).includes('acme/model-x'), 'spawn allowlist missing model');
  assert.ok(routing.routing.provider_budgets && routing.routing.provider_budgets.acme_provider, 'provider budget missing');
  assert.ok(routing.routing.provider_guardrails && routing.routing.provider_guardrails.acme_provider, 'provider guard missing');

  const adapters = readJson(adaptersPath);
  assert.ok(adapters.provider_profiles && adapters.provider_profiles.acme_provider, 'provider profile missing in model_adapters');

  const secret = readJson(secretPath);
  assert.ok(secret.secrets && secret.secrets.acme_api_key, 'secret policy not wired');

  const trainability = readJson(trainabilityPath);
  assert.ok(trainability.provider_rules && trainability.provider_rules.acme, 'trainability rule not wired');

  const status = run(['status', ...baseArgs]);
  assert.strictEqual(status.status, 0, `status failed: ${status.stderr || status.stdout}`);
  const statusPayload = parseJson(status.stdout);
  assert.strictEqual(statusPayload.pass, true, 'status should pass after apply');

  const receipts = readJsonl(receiptsPath);
  assert.ok(receipts.length >= 1, 'onboarding receipt should be written');
  assert.strictEqual(String(receipts[receipts.length - 1].provider_id), 'acme_provider');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('provider_onboarding_manifest.test.js: OK');
} catch (err) {
  console.error(`provider_onboarding_manifest.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

