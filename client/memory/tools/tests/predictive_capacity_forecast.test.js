#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'predictive_capacity_forecast.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
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

function isoNowMinus(days) {
  return new Date(Date.now() - (Number(days) * 24 * 60 * 60 * 1000)).toISOString();
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-forecast-'));

  const execHist = path.join(tmp, 'state', 'ops', 'execution_reliability_slo_history.jsonl');
  const tokenHist = path.join(tmp, 'state', 'ops', 'token_economics_engine_history.jsonl');
  const queueState = path.join(tmp, 'state', 'ops', 'queue_hygiene_state.json');
  const queueSnapshot = path.join(tmp, 'state', 'ops', 'queue_hygiene', 'latest.json');
  const modelLatest = path.join(tmp, 'state', 'routing', 'model_health_auto_recovery', 'latest.json');
  const banned = path.join(tmp, 'state', 'routing', 'banned_models.json');
  const latest = path.join(tmp, 'state', 'ops', 'predictive_capacity_forecast', 'latest.json');
  const history = path.join(tmp, 'state', 'ops', 'predictive_capacity_forecast', 'history.jsonl');
  const errors = path.join(tmp, 'state', 'ops', 'predictive_capacity_forecast', 'forecast_errors.jsonl');
  const policy = path.join(tmp, 'config', 'predictive_capacity_forecast_policy.json');

  writeJsonl(execHist, [
    { ts: isoNowMinus(5), measured: { time_to_first_execution_p95_ms: 1100 } },
    { ts: isoNowMinus(3), measured: { time_to_first_execution_p95_ms: 1200 } },
    { ts: isoNowMinus(1), measured: { time_to_first_execution_p95_ms: 1300 } }
  ]);
  writeJsonl(tokenHist, [
    { ts: isoNowMinus(5), summary: { predicted_tokens_avg: 1600 } },
    { ts: isoNowMinus(3), summary: { predicted_tokens_avg: 1750 } },
    { ts: isoNowMinus(1), summary: { predicted_tokens_avg: 1900 } }
  ]);
  writeJson(queueSnapshot, {
    summary: {
      totals: { open: 95 }
    }
  });
  writeJson(queueState, {
    output_file: queueSnapshot
  });
  writeJson(modelLatest, {
    provider_health_pass_rate: 0.5,
    providers_total: 2,
    providers_healthy: 1
  });
  writeJson(banned, {
    'ollama/gemma3:4b': { reason: 'cooldown' },
    'ollama/qwen2.5:7b': { reason: 'cooldown' }
  });

  const oldForecast = {
    ts: isoNowMinus(8),
    forecast_id: 'old_forecast_1',
    observed: {
      queue_open: 60,
      latency_p95_ms: 900,
      token_burn: 1500,
      model_cooldown_risk: 0.1
    },
    forecasts: {
      '7d': {
        target_date: new Date().toISOString().slice(0, 10),
        queue_open: 80,
        latency_p95_ms: 1100,
        token_burn: 1700,
        model_cooldown_risk: 0.2
      }
    }
  };
  writeJsonl(history, [oldForecast]);

  writeJson(policy, {
    version: '1.0-test',
    enabled: true,
    strict_default: false,
    max_history_rows: 200,
    max_error_rows: 200,
    min_history_samples_for_forecast: 1,
    forecast_horizons_days: [7, 30],
    thresholds: {
      queue_open_warn_7d: 80,
      queue_open_warn_30d: 120,
      latency_p95_warn_7d_ms: 1200,
      latency_p95_warn_30d_ms: 2000,
      token_burn_warn_7d: 1800,
      token_burn_warn_30d: 2400,
      model_cooldown_risk_warn_7d: 0.2,
      model_cooldown_risk_warn_30d: 0.3
    },
    scaling: {
      queue_scale_step_pct: 20,
      model_pool_scale_step_pct: 15,
      budget_throttle_step_pct: 10
    },
    paths: {
      execution_reliability_history: execHist,
      token_economics_history: tokenHist,
      queue_hygiene_state: queueState,
      model_health_latest: modelLatest,
      banned_models: banned,
      latest,
      history,
      errors
    }
  });

  const env = { PREDICTIVE_CAPACITY_POLICY_PATH: policy };

  let r = run(['run', '--strict=1'], env);
  assert.strictEqual(r.status, 0, `run should pass strict: ${r.stderr || r.stdout}`);
  let payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'run payload should be ok');
  assert.ok(payload.forecasts && payload.forecasts['7d'] && payload.forecasts['30d'], '7d and 30d forecasts expected');
  assert.ok(payload.recommendation && typeof payload.recommendation.mode === 'string', 'recommendation mode expected');
  assert.ok(Number(payload.realized_error.evaluated_now || 0) >= 1, 'should evaluate at least one matured forecast');

  r = run(['status'], env);
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr || r.stdout}`);
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'status payload should be ok');
  assert.strictEqual(payload.available, true, 'latest should be available');
  assert.ok(Number(payload.history_count || 0) >= 2, 'history should include prior + latest entries');
  assert.ok(Number(payload.error_count || 0) >= 1, 'error history should include evaluated sample');

  console.log('predictive_capacity_forecast.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`predictive_capacity_forecast.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
