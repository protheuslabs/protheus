#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'llm_economy_organ.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(args, env = {}) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  const out = String(proc.stdout || '').trim();
  let payload = null;
  try { payload = JSON.parse(out); } catch {}
  return {
    status: proc.status == null ? 1 : proc.status,
    stderr: String(proc.stderr || ''),
    payload
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-economy-'));
  const policyPath = path.join(tmp, 'llm_economy_policy.json');
  const burnLatestPath = path.join(tmp, 'burn_latest.json');
  const discoveryPath = path.join(tmp, 'provider_market_feed_latest.json');

  writeJson(burnLatestPath, {
    ok: true,
    projection: {
      pressure: 'high',
      projected_runway_days: 1.8,
      providers_available: 2
    },
    providers: [
      {
        provider_id: 'openai',
        available: true,
        balance_usd: 2,
        burn_velocity_usd_day: 10,
        projected_runway_days: 0.2,
        projected_runway_days_regime: 0.2,
        pressure: 'critical'
      },
      {
        provider_id: 'anthropic',
        available: true,
        balance_usd: 200,
        burn_velocity_usd_day: 5,
        projected_runway_days: 40,
        projected_runway_days_regime: 40,
        pressure: 'low'
      }
    ]
  });

  writeJson(discoveryPath, {
    ts: new Date().toISOString(),
    providers: [
      {
        provider_id: 'openai',
        performance_index: 0.97,
        reliability_index: 0.95,
        pricing_index: 0.48
      },
      {
        provider_id: 'mistral',
        display_name: 'Mistral',
        performance_index: 0.86,
        reliability_index: 0.9,
        pricing_index: 0.44
      }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    allow_apply: false,
    governance: {
      low_risk_auto_execute: true,
      medium_risk_auto_execute: true,
      medium_risk_veto_minutes: 10,
      high_risk_requires_approval: true,
      high_risk_threshold_usd: 500
    },
    purchase: {
      target_runway_days: 14,
      min_balance_usd: 10,
      min_runway_days: 2,
      min_purchase_usd: 5,
      max_purchase_low_usd: 100,
      max_purchase_medium_usd: 500,
      max_purchase_high_usd: 5000
    },
    providers: {
      openai: {
        enabled: true,
        display_name: 'OpenAI',
        pricing_index: 0.5,
        performance_index: 0.92,
        reliability_index: 0.94,
        payment_route: 'x402_or_provider_billing'
      },
      anthropic: {
        enabled: true,
        display_name: 'Anthropic',
        pricing_index: 0.6,
        performance_index: 0.9,
        reliability_index: 0.93,
        payment_route: 'x402_or_provider_billing'
      }
    },
    sovereign_root_tithe: {
      require_before_spend: true,
      reason_code: 'sovereign_root_tithe_required'
    },
    discovery: {
      enabled: true,
      include_policy_disabled_candidates: true,
      metric_override_weight: 0.4,
      sources: [
        {
          id: 'market_feed',
          enabled: true,
          path: discoveryPath,
          providers_path: 'providers'
        }
      ]
    },
    paths: {
      burn_oracle_latest_path: burnLatestPath,
      state_path: path.join(tmp, 'state', 'llm_economy', 'state.json'),
      latest_path: path.join(tmp, 'state', 'llm_economy', 'latest.json'),
      history_path: path.join(tmp, 'state', 'llm_economy', 'history.jsonl'),
      receipts_path: path.join(tmp, 'state', 'llm_economy', 'receipts.jsonl'),
      provider_library_path: path.join(tmp, 'state', 'routing', 'provider_library_latest.json'),
      weaver_hint_path: path.join(tmp, 'state', 'weaver_hints.jsonl'),
      strategy_hint_path: path.join(tmp, 'state', 'strategy_hints.jsonl'),
      capital_hint_path: path.join(tmp, 'state', 'capital_hints.jsonl'),
      self_improvement_hint_path: path.join(tmp, 'state', 'self_improvement_hints.jsonl'),
      purchase_intents_path: path.join(tmp, 'state', 'purchase_intents.jsonl')
    }
  });

  let res = run(['run', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, res.stderr || 'run should succeed');
  assert.ok(res.payload && res.payload.ok === true, 'payload ok expected');
  assert.strictEqual(String(res.payload.shadow_only), 'true', 'run should stay shadow');
  assert.ok(Array.isArray(res.payload.provider_library), 'provider library expected');
  assert.ok(Array.isArray(res.payload.purchase_intents), 'purchase intents expected');
  assert.ok(res.payload.purchase_intents.length >= 1, 'openai should trigger purchase intent');
  assert.ok(Number(res.payload.summary && res.payload.summary.providers_discovered || 0) >= 2, 'discovery providers should be counted');
  const discoveredOnly = res.payload.provider_library.find((row) => row && row.provider_id === 'mistral');
  assert.ok(discoveredOnly, 'discovered provider should appear in provider library');
  assert.strictEqual(discoveredOnly.enabled, false, 'discovered provider should stay non-executable until onboarded');

  const openaiIntent = res.payload.purchase_intents.find((row) => row && row.provider_id === 'openai');
  assert.ok(openaiIntent, 'openai purchase intent missing');
  assert.strictEqual(openaiIntent.tithe_applies_first, true, 'tithe flag must be set');
  assert.ok(openaiIntent.reason_codes.includes('sovereign_root_tithe_required'), 'tithe reason code required');

  res = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, res.stderr || 'status should succeed');
  assert.ok(res.payload && res.payload.ok === true, 'status ok expected');
  assert.strictEqual(Number(res.payload.state && res.payload.state.runs || 0), 1, 'state run count should increment');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('llm_economy_organ.test.js: OK');
} catch (err) {
  console.error(`llm_economy_organ.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
