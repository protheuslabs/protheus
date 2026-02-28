#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'dynamic_burn_budget_oracle.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dynamic-burn-oracle-'));
  const policyPath = path.join(tmp, 'policy.json');
  const statePath = path.join(tmp, 'state.json');
  const latestPath = path.join(tmp, 'latest.json');
  const historyPath = path.join(tmp, 'history.jsonl');
  const receiptsPath = path.join(tmp, 'receipts.jsonl');
  const weaverHintPath = path.join(tmp, 'weaver_hints.jsonl');
  const routingHintPath = path.join(tmp, 'routing_hints.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    cadence: {
      default_minutes: 15,
      high_burn_minutes: 5,
      low_burn_minutes: 30,
      burn_spike_multiplier: 1.2
    },
    thresholds: {
      critical_runway_days: 2,
      high_runway_days: 5,
      medium_runway_days: 10,
      min_runway_days_for_capital_allocation: 3,
      min_runway_days_for_execute_escalation: 2
    },
    providers: {
      openai: {
        enabled: true,
        parse: {
          cost_24h_paths: ['total_cost_usd'],
          balance_paths: ['total_available'],
          reset_at_paths: ['next_reset_at']
        }
      },
      anthropic: {
        enabled: true,
        parse: {
          cost_24h_paths: ['total_cost_usd'],
          balance_paths: ['balance_usd'],
          reset_at_paths: ['next_reset_at']
        }
      },
      xai: {
        enabled: true,
        parse: {
          cost_24h_paths: ['cost_usd_24h'],
          balance_paths: ['available'],
          reset_at_paths: ['next_reset_at']
        }
      }
    },
    state: {
      state_path: statePath,
      latest_path: latestPath,
      history_path: historyPath,
      receipts_path: receiptsPath,
      weaver_hint_path: weaverHintPath,
      routing_hint_path: routingHintPath,
      regime_latest_path: path.join(tmp, 'regime_latest.json')
    }
  });

  const env = {
    DYNAMIC_BURN_BUDGET_ORACLE_POLICY_PATH: policyPath
  };

  const resetAt = new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)).toISOString();
  const mock = {
    providers: {
      openai: { total_available: 1200, total_cost_usd: 160, next_reset_at: resetAt },
      anthropic: { balance_usd: 500, total_cost_usd: 70, next_reset_at: resetAt },
      xai: { available: 100, cost_usd_24h: 40, next_reset_at: resetAt }
    }
  };

  let proc = run(['run', `--mock-json=${JSON.stringify(mock)}`], env);
  assert.strictEqual(proc.status, 0, proc.stderr || 'oracle run should pass');
  let out = parseJson(proc.stdout);
  assert.ok(out && out.ok === true, 'oracle output should be ok');
  assert.strictEqual(Number(out.projection.providers_available || 0), 3, 'three providers should be available');
  assert.strictEqual(String(out.projection.pressure || ''), 'high', 'projection pressure should be high from low runway');
  assert.strictEqual(out.decisions && out.decisions.capital_allocation_hold, true, 'capital allocation should hold under tight runway');
  assert.strictEqual(out.decisions && out.decisions.strategy_mode_recommendation, 'canary_execute', 'strategy recommendation should degrade to canary');
  assert.ok(Number(out.cadence && out.cadence.minutes || 0) <= 5, 'high pressure should tighten cadence');

  proc = run(['status'], env);
  assert.strictEqual(proc.status, 0, proc.stderr || 'oracle status should pass');
  out = parseJson(proc.stdout);
  assert.ok(out && out.ok === true, 'status output should be ok');
  assert.strictEqual(String(out.latest && out.latest.pressure || ''), 'high', 'status should expose latest pressure');
  assert.ok(fs.existsSync(latestPath), 'latest file should exist');
  assert.ok(fs.existsSync(historyPath), 'history file should exist');
  assert.ok(fs.existsSync(receiptsPath), 'receipts file should exist');
  assert.ok(fs.existsSync(weaverHintPath), 'weaver hints should exist');
  assert.ok(fs.existsSync(routingHintPath), 'routing hints should exist');
  assert.ok(fs.readFileSync(receiptsPath, 'utf8').trim().length > 0, 'receipts should be non-empty');

  console.log('dynamic_burn_budget_oracle.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`dynamic_burn_budget_oracle.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
