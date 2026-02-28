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

function appendJsonl(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
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

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const creatorScript = path.join(repoRoot, 'systems', 'storm', 'creator_optin_ledger.js');
  const distributionScript = path.join(repoRoot, 'systems', 'storm', 'storm_value_distribution.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'storm-distribution-'));

  const creatorPolicyPath = path.join(tmpRoot, 'config', 'creator_optin_ledger_policy.json');
  const distributionPolicyPath = path.join(tmpRoot, 'config', 'storm_value_distribution_policy.json');
  const attributionRecordsPath = path.join(tmpRoot, 'state', 'assimilation', 'value_attribution', 'records.jsonl');
  const latestPlanPath = path.join(tmpRoot, 'state', 'storm', 'value_distribution', 'latest.json');

  writeJson(creatorPolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    allow_apply: false,
    privacy: {
      hash_salt_env: 'STORM_LEDGER_SALT',
      expose_public_name: false
    },
    partnership: {
      tiers: [{ id: 'seed', min_influence: 0 }],
      badges: { first_optin: { min_events: 1 } }
    },
    state: {
      root: path.join(tmpRoot, 'state', 'storm', 'creator_optin'),
      index_path: path.join(tmpRoot, 'state', 'storm', 'creator_optin', 'index.json'),
      latest_path: path.join(tmpRoot, 'state', 'storm', 'creator_optin', 'latest.json'),
      history_path: path.join(tmpRoot, 'state', 'storm', 'creator_optin', 'history.jsonl'),
      public_ledger_path: path.join(tmpRoot, 'state', 'storm', 'creator_optin', 'public_ledger.jsonl'),
      receipts_path: path.join(tmpRoot, 'state', 'storm', 'creator_optin', 'receipts.jsonl')
    },
    passport: {
      enabled: false,
      source: 'creator_optin_ledger'
    }
  });

  writeJson(distributionPolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    allow_apply: false,
    governance: {
      constitution_gate_enabled: false,
      block_on_constitution_deny: false
    },
    inputs: {
      attribution_records_path: attributionRecordsPath,
      creator_index_policy_path: creatorPolicyPath
    },
    distribution: {
      default_pool_usd: 100,
      min_payout_usd: 0.01,
      max_creators_per_plan: 100,
      allowed_modes: ['royalty', 'donation', 'hybrid']
    },
    state: {
      root: path.join(tmpRoot, 'state', 'storm', 'value_distribution'),
      plans_dir: path.join(tmpRoot, 'state', 'storm', 'value_distribution', 'plans'),
      latest_path: latestPlanPath,
      history_path: path.join(tmpRoot, 'state', 'storm', 'value_distribution', 'history.jsonl'),
      reversals_path: path.join(tmpRoot, 'state', 'storm', 'value_distribution', 'reversals.jsonl'),
      receipts_path: path.join(tmpRoot, 'state', 'storm', 'value_distribution', 'receipts.jsonl')
    },
    passport: {
      enabled: false,
      source: 'storm_value_distribution'
    }
  });

  const env = {
    ...process.env,
    CREATOR_OPTIN_LEDGER_POLICY_PATH: creatorPolicyPath,
    STORM_VALUE_DISTRIBUTION_POLICY_PATH: distributionPolicyPath,
    STORM_LEDGER_SALT: 'storm_test_salt'
  };

  parseOut(runNode(creatorScript, [
    'opt-in',
    `--policy=${creatorPolicyPath}`,
    '--creator-id=creator_alpha',
    '--mode=royalty'
  ], env, repoRoot), 'opt-in-alpha');
  parseOut(runNode(creatorScript, [
    'opt-in',
    `--policy=${creatorPolicyPath}`,
    '--creator-id=creator_beta',
    '--mode=donation',
    '--donation-target=project_beta'
  ], env, repoRoot), 'opt-in-beta');

  appendJsonl(attributionRecordsPath, {
    ts: new Date().toISOString(),
    attribution_id: 'attr_alpha_1',
    provenance: {
      creator: { creator_id: 'creator_alpha' },
      valuation: { influence_score: 0.7, weight: 1 },
      context: { objective_id: 'obj_storm', run_id: 'run_storm_1' }
    }
  });
  appendJsonl(attributionRecordsPath, {
    ts: new Date().toISOString(),
    attribution_id: 'attr_beta_1',
    provenance: {
      creator: { creator_id: 'creator_beta' },
      valuation: { influence_score: 0.3, weight: 1 },
      context: { objective_id: 'obj_storm', run_id: 'run_storm_1' }
    }
  });

  const plan = parseOut(runNode(distributionScript, [
    'plan',
    `--policy=${distributionPolicyPath}`,
    '--objective-id=obj_storm',
    '--run-id=run_storm_1',
    '--pool-usd=100',
    '--days=30'
  ], env, repoRoot), 'plan');
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.status, 'shadow_only');
  assert.ok(Array.isArray(plan.payouts) && plan.payouts.length === 2, 'plan should produce two payouts');
  const sum = plan.payouts.reduce((acc, row) => acc + Number(row.amount_usd || 0), 0);
  assert.ok(sum > 99.9 && sum < 100.1, 'payouts should approximately sum to pool');

  const saved = readJson(path.join(tmpRoot, 'state', 'storm', 'value_distribution', 'plans', `${plan.distribution_id}.json`));
  assert.ok(saved && saved.distribution_id === plan.distribution_id, 'plan file should persist');

  const reversed = parseOut(runNode(distributionScript, [
    'reverse',
    `--policy=${distributionPolicyPath}`,
    `--distribution-id=${plan.distribution_id}`,
    '--reason=test_reversal'
  ], env, repoRoot), 'reverse');
  assert.strictEqual(reversed.ok, true);
  assert.strictEqual(reversed.distribution_id, plan.distribution_id);

  const status = parseOut(runNode(distributionScript, [
    'status',
    plan.distribution_id,
    `--policy=${distributionPolicyPath}`
  ], env, repoRoot), 'status');
  assert.strictEqual(status.ok, true);
  assert.strictEqual(status.status, 'reversed', 'status should reflect reversal');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('storm_value_distribution.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`storm_value_distribution.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
