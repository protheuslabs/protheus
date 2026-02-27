#!/usr/bin/env node
'use strict';
export {};

/**
 * predictive_capacity_forecast.js
 *
 * RM-134: predictive capacity forecasting + preemptive scaling playbook.
 *
 * Commands:
 *   node systems/ops/predictive_capacity_forecast.js run [--strict=1|0]
 *   node systems/ops/predictive_capacity_forecast.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.PREDICTIVE_CAPACITY_POLICY_PATH
  ? path.resolve(String(process.env.PREDICTIVE_CAPACITY_POLICY_PATH))
  : path.join(ROOT, 'config', 'predictive_capacity_forecast_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function clean(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return clean(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok || '').slice(2)] = true;
    else out[String(tok || '').slice(2, idx)] = String(tok || '').slice(idx + 1);
  }
  return out;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const row = JSON.parse(line);
          return row && typeof row === 'object' ? row : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as AnyObj[];
  } catch {
    return [];
  }
}

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function resolvePath(v: unknown, fallbackRel: string) {
  const text = clean(v || fallbackRel, 320);
  return path.isAbsolute(text) ? path.resolve(text) : path.join(ROOT, text);
}

function average(rows: number[]) {
  const vals = rows.filter((n) => Number.isFinite(n));
  if (!vals.length) return 0;
  return Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4));
}

function linearSlopePerDay(points: Array<{ x: number; y: number }>) {
  const rows = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (rows.length < 2) return 0;
  const meanX = average(rows.map((r) => r.x));
  const meanY = average(rows.map((r) => r.y));
  let num = 0;
  let den = 0;
  for (const r of rows) {
    const dx = r.x - meanX;
    num += dx * (r.y - meanY);
    den += dx * dx;
  }
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return 0;
  return num / den;
}

function todayDate() {
  return nowIso().slice(0, 10);
}

function addDaysUtc(dateIsoOrDate: string, deltaDays: number) {
  const datePart = String(dateIsoOrDate || '').slice(0, 10);
  const ts = Date.parse(`${datePart}T00:00:00.000Z`);
  if (!Number.isFinite(ts)) return todayDate();
  return new Date(ts + (deltaDays * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: false,
    max_history_rows: 720,
    max_error_rows: 720,
    min_history_samples_for_forecast: 3,
    forecast_horizons_days: [7, 30],
    thresholds: {
      queue_open_warn_7d: 80,
      queue_open_warn_30d: 120,
      latency_p95_warn_7d_ms: 1500,
      latency_p95_warn_30d_ms: 2500,
      token_burn_warn_7d: 2200,
      token_burn_warn_30d: 2600,
      model_cooldown_risk_warn_7d: 0.25,
      model_cooldown_risk_warn_30d: 0.35
    },
    scaling: {
      queue_scale_step_pct: 20,
      model_pool_scale_step_pct: 15,
      budget_throttle_step_pct: 10
    },
    paths: {
      execution_reliability_history: 'state/ops/execution_reliability_slo_history.jsonl',
      token_economics_history: 'state/ops/token_economics_engine_history.jsonl',
      queue_hygiene_state: 'state/ops/queue_hygiene_state.json',
      model_health_latest: 'state/routing/model_health_auto_recovery/latest.json',
      banned_models: 'state/routing/banned_models.json',
      latest: 'state/ops/predictive_capacity_forecast/latest.json',
      history: 'state/ops/predictive_capacity_forecast/history.jsonl',
      errors: 'state/ops/predictive_capacity_forecast/forecast_errors.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const th = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const sc = raw.scaling && typeof raw.scaling === 'object' ? raw.scaling : {};
  const pathsRaw = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const horizons = Array.isArray(raw.forecast_horizons_days)
    ? raw.forecast_horizons_days.map((n: unknown) => clampInt(n, 1, 365, 0)).filter((n: number) => n > 0)
    : base.forecast_horizons_days;
  return {
    version: clean(raw.version || base.version, 24) || '1.0',
    enabled: raw.enabled !== false,
    strict_default: toBool(raw.strict_default, base.strict_default),
    max_history_rows: clampInt(raw.max_history_rows, 20, 10000, base.max_history_rows),
    max_error_rows: clampInt(raw.max_error_rows, 20, 10000, base.max_error_rows),
    min_history_samples_for_forecast: clampInt(raw.min_history_samples_for_forecast, 1, 1000, base.min_history_samples_for_forecast),
    forecast_horizons_days: horizons.length ? horizons : base.forecast_horizons_days,
    thresholds: {
      queue_open_warn_7d: clampNumber(th.queue_open_warn_7d, 1, 1_000_000, base.thresholds.queue_open_warn_7d),
      queue_open_warn_30d: clampNumber(th.queue_open_warn_30d, 1, 1_000_000, base.thresholds.queue_open_warn_30d),
      latency_p95_warn_7d_ms: clampNumber(th.latency_p95_warn_7d_ms, 1, 10_000_000, base.thresholds.latency_p95_warn_7d_ms),
      latency_p95_warn_30d_ms: clampNumber(th.latency_p95_warn_30d_ms, 1, 10_000_000, base.thresholds.latency_p95_warn_30d_ms),
      token_burn_warn_7d: clampNumber(th.token_burn_warn_7d, 1, 10_000_000, base.thresholds.token_burn_warn_7d),
      token_burn_warn_30d: clampNumber(th.token_burn_warn_30d, 1, 10_000_000, base.thresholds.token_burn_warn_30d),
      model_cooldown_risk_warn_7d: clampNumber(th.model_cooldown_risk_warn_7d, 0, 1, base.thresholds.model_cooldown_risk_warn_7d),
      model_cooldown_risk_warn_30d: clampNumber(th.model_cooldown_risk_warn_30d, 0, 1, base.thresholds.model_cooldown_risk_warn_30d)
    },
    scaling: {
      queue_scale_step_pct: clampNumber(sc.queue_scale_step_pct, 1, 500, base.scaling.queue_scale_step_pct),
      model_pool_scale_step_pct: clampNumber(sc.model_pool_scale_step_pct, 1, 500, base.scaling.model_pool_scale_step_pct),
      budget_throttle_step_pct: clampNumber(sc.budget_throttle_step_pct, 1, 500, base.scaling.budget_throttle_step_pct)
    },
    paths: {
      execution_reliability_history: resolvePath(pathsRaw.execution_reliability_history, base.paths.execution_reliability_history),
      token_economics_history: resolvePath(pathsRaw.token_economics_history, base.paths.token_economics_history),
      queue_hygiene_state: resolvePath(pathsRaw.queue_hygiene_state, base.paths.queue_hygiene_state),
      model_health_latest: resolvePath(pathsRaw.model_health_latest, base.paths.model_health_latest),
      banned_models: resolvePath(pathsRaw.banned_models, base.paths.banned_models),
      latest: resolvePath(pathsRaw.latest, base.paths.latest),
      history: resolvePath(pathsRaw.history, base.paths.history),
      errors: resolvePath(pathsRaw.errors, base.paths.errors)
    },
    policy_path: path.resolve(policyPath)
  };
}

function latestQueueOpen(queueStatePath: string) {
  const state = readJson(queueStatePath, {});
  const outputFile = clean(state.output_file || '', 320);
  if (outputFile && fs.existsSync(outputFile)) {
    const report = readJson(outputFile, {});
    return Number(report && report.summary && report.summary.totals && report.summary.totals.open || 0);
  }
  return 0;
}

function latestLatency(executionHistoryPath: string) {
  const rows = readJsonl(executionHistoryPath);
  if (!rows.length) return 0;
  const row = rows[rows.length - 1] || {};
  return Number(row && row.measured && row.measured.time_to_first_execution_p95_ms || 0);
}

function latestTokenBurn(tokenHistoryPath: string) {
  const rows = readJsonl(tokenHistoryPath);
  if (!rows.length) return 0;
  const row = rows[rows.length - 1] || {};
  return Number(row && row.summary && row.summary.predicted_tokens_avg || 0);
}

function latestCooldownRisk(modelHealthPath: string, bannedPath: string) {
  const model = readJson(modelHealthPath, {});
  const passRate = Number(model.provider_health_pass_rate == null ? 1 : model.provider_health_pass_rate);
  const providersTotal = Math.max(1, Number(model.providers_total || 1));
  const providersHealthy = Math.max(0, Number(model.providers_healthy || providersTotal));
  const providerRisk = clampNumber(1 - (providersHealthy / providersTotal), 0, 1, 0);
  const bans = readJson(bannedPath, {});
  const banCount = bans && typeof bans === 'object' ? Object.keys(bans).length : 0;
  const banRisk = clampNumber(banCount / 20, 0, 1, 0);
  const passRateRisk = clampNumber(1 - passRate, 0, 1, 0);
  return Number(Math.max(providerRisk, passRateRisk, banRisk).toFixed(4));
}

function trimJsonl(filePath: string, maxRows: number) {
  if (!fs.existsSync(filePath)) return;
  const lines = String(fs.readFileSync(filePath, 'utf8') || '').split('\n').filter(Boolean);
  if (lines.length <= maxRows) return;
  fs.writeFileSync(filePath, `${lines.slice(lines.length - maxRows).join('\n')}\n`, 'utf8');
}

function buildForecasts(policy: AnyObj, historyRows: AnyObj[], observed: AnyObj) {
  const samples = historyRows
    .map((row) => {
      const ts = Date.parse(String(row.ts || ''));
      if (!Number.isFinite(ts)) return null;
      const obs = row.observed && typeof row.observed === 'object' ? row.observed : {};
      return {
        ts,
        queue_open: Number(obs.queue_open || 0),
        latency_p95_ms: Number(obs.latency_p95_ms || 0),
        token_burn: Number(obs.token_burn || 0),
        model_cooldown_risk: Number(obs.model_cooldown_risk || 0)
      };
    })
    .filter(Boolean) as Array<{ ts: number; queue_open: number; latency_p95_ms: number; token_burn: number; model_cooldown_risk: number }>;

  const all = [...samples, {
    ts: Date.now(),
    queue_open: Number(observed.queue_open || 0),
    latency_p95_ms: Number(observed.latency_p95_ms || 0),
    token_burn: Number(observed.token_burn || 0),
    model_cooldown_risk: Number(observed.model_cooldown_risk || 0)
  }];

  const baseTs = all.length ? all[0].ts : Date.now();
  const toPoints = (field: string) => all.map((row) => ({
    x: (row.ts - baseTs) / (24 * 60 * 60 * 1000),
    y: Number((row as AnyObj)[field] || 0)
  }));

  const slopes = {
    queue_open: linearSlopePerDay(toPoints('queue_open')),
    latency_p95_ms: linearSlopePerDay(toPoints('latency_p95_ms')),
    token_burn: linearSlopePerDay(toPoints('token_burn')),
    model_cooldown_risk: linearSlopePerDay(toPoints('model_cooldown_risk'))
  };

  const confidence = clampNumber((all.length / Math.max(1, policy.min_history_samples_for_forecast * 2)), 0.1, 1, 0.3);
  const today = todayDate();
  const forecasts: Record<string, AnyObj> = {};
  for (const horizon of policy.forecast_horizons_days) {
    const key = `${horizon}d`;
    forecasts[key] = {
      horizon_days: horizon,
      target_date: addDaysUtc(today, horizon),
      queue_open: Number(Math.max(0, observed.queue_open + (slopes.queue_open * horizon)).toFixed(3)),
      latency_p95_ms: Number(Math.max(0, observed.latency_p95_ms + (slopes.latency_p95_ms * horizon)).toFixed(3)),
      token_burn: Number(Math.max(0, observed.token_burn + (slopes.token_burn * horizon)).toFixed(3)),
      model_cooldown_risk: Number(clampNumber(observed.model_cooldown_risk + (slopes.model_cooldown_risk * horizon), 0, 1, observed.model_cooldown_risk).toFixed(4)),
      confidence: Number(confidence.toFixed(4))
    };
  }

  return { forecasts, slopes };
}

function scalingRecommendation(policy: AnyObj, forecasts: AnyObj) {
  const f7 = forecasts['7d'] || forecasts[Object.keys(forecasts)[0]] || {};
  const f30 = forecasts['30d'] || f7;
  const t = policy.thresholds;

  const triggers = {
    queue_7d: Number(f7.queue_open || 0) >= Number(t.queue_open_warn_7d || 0),
    queue_30d: Number(f30.queue_open || 0) >= Number(t.queue_open_warn_30d || 0),
    latency_7d: Number(f7.latency_p95_ms || 0) >= Number(t.latency_p95_warn_7d_ms || 0),
    latency_30d: Number(f30.latency_p95_ms || 0) >= Number(t.latency_p95_warn_30d_ms || 0),
    token_7d: Number(f7.token_burn || 0) >= Number(t.token_burn_warn_7d || 0),
    token_30d: Number(f30.token_burn || 0) >= Number(t.token_burn_warn_30d || 0),
    cooldown_7d: Number(f7.model_cooldown_risk || 0) >= Number(t.model_cooldown_risk_warn_7d || 0),
    cooldown_30d: Number(f30.model_cooldown_risk || 0) >= Number(t.model_cooldown_risk_warn_30d || 0)
  };

  const hot = Object.entries(triggers).filter(([, v]) => v === true).map(([k]) => k);
  const mode = hot.length === 0 ? 'steady' : (hot.length <= 2 ? 'preemptive_scale' : 'urgent_scale');
  return {
    mode,
    triggers,
    trigger_count: hot.length,
    actions: {
      queue_capacity_increase_pct: mode === 'steady' ? 0 : policy.scaling.queue_scale_step_pct,
      model_pool_increase_pct: mode === 'steady' ? 0 : policy.scaling.model_pool_scale_step_pct,
      budget_throttle_noncritical_pct: mode === 'steady' ? 0 : policy.scaling.budget_throttle_step_pct,
      recommend_prewarm: hot.some((k) => k.includes('cooldown') || k.includes('latency')),
      recommend_queue_gc_acceleration: hot.some((k) => k.includes('queue'))
    }
  };
}

function evaluateForecastErrors(policy: AnyObj, historyRows: AnyObj[], observed: AnyObj, errorRows: AnyObj[]) {
  const today = todayDate();
  const seen = new Set(errorRows.map((row) => clean(row.forecast_id || '', 120)).filter(Boolean));
  const newErrors: AnyObj[] = [];

  for (const row of historyRows) {
    const forecastId = clean(row.forecast_id || '', 120);
    if (!forecastId || seen.has(forecastId)) continue;
    const forecast7 = row.forecasts && row.forecasts['7d'] ? row.forecasts['7d'] : null;
    if (!forecast7) continue;
    const targetDate = clean(forecast7.target_date || '', 20);
    if (!targetDate || targetDate > today) continue;

    const error = {
      queue_open_abs: Number(Math.abs(Number(forecast7.queue_open || 0) - Number(observed.queue_open || 0)).toFixed(4)),
      latency_p95_ms_abs: Number(Math.abs(Number(forecast7.latency_p95_ms || 0) - Number(observed.latency_p95_ms || 0)).toFixed(4)),
      token_burn_abs: Number(Math.abs(Number(forecast7.token_burn || 0) - Number(observed.token_burn || 0)).toFixed(4)),
      model_cooldown_risk_abs: Number(Math.abs(Number(forecast7.model_cooldown_risk || 0) - Number(observed.model_cooldown_risk || 0)).toFixed(4))
    };
    const rowOut = {
      ts: nowIso(),
      type: 'predictive_capacity_forecast_error',
      forecast_id: forecastId,
      target_date: targetDate,
      evaluated_on: today,
      error
    };
    newErrors.push(rowOut);
    seen.add(forecastId);
  }

  for (const e of newErrors) appendJsonl(policy.paths.errors, e);
  trimJsonl(policy.paths.errors, policy.max_error_rows);
  const merged = [...errorRows, ...newErrors].slice(-policy.max_error_rows);
  const errorVals = {
    queue_open_abs: merged.map((r) => Number(r && r.error && r.error.queue_open_abs || 0)),
    latency_p95_ms_abs: merged.map((r) => Number(r && r.error && r.error.latency_p95_ms_abs || 0)),
    token_burn_abs: merged.map((r) => Number(r && r.error && r.error.token_burn_abs || 0)),
    model_cooldown_risk_abs: merged.map((r) => Number(r && r.error && r.error.model_cooldown_risk_abs || 0))
  };

  return {
    evaluated_now: newErrors.length,
    total_samples: merged.length,
    mae: {
      queue_open_abs: Number(average(errorVals.queue_open_abs).toFixed(4)),
      latency_p95_ms_abs: Number(average(errorVals.latency_p95_ms_abs).toFixed(4)),
      token_burn_abs: Number(average(errorVals.token_burn_abs).toFixed(4)),
      model_cooldown_risk_abs: Number(average(errorVals.model_cooldown_risk_abs).toFixed(4))
    }
  };
}

function cmdRun(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (!policy.enabled) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'predictive_capacity_forecast', error: 'policy_disabled' })}\n`);
    process.exit(1);
  }
  const strict = toBool(args.strict, policy.strict_default === true);

  const observed = {
    queue_open: latestQueueOpen(policy.paths.queue_hygiene_state),
    latency_p95_ms: latestLatency(policy.paths.execution_reliability_history),
    token_burn: latestTokenBurn(policy.paths.token_economics_history),
    model_cooldown_risk: latestCooldownRisk(policy.paths.model_health_latest, policy.paths.banned_models)
  };

  const historyRows = readJsonl(policy.paths.history);
  const { forecasts, slopes } = buildForecasts(policy, historyRows, observed);
  const recommendation = scalingRecommendation(policy, forecasts);
  const errorRows = readJsonl(policy.paths.errors);
  const realizedErrors = evaluateForecastErrors(policy, historyRows, observed, errorRows);

  const forecastId = `capf_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const payload = {
    ok: true,
    type: 'predictive_capacity_forecast',
    ts: nowIso(),
    forecast_id: forecastId,
    policy_path: rel(policy.policy_path),
    observed,
    slopes_per_day: {
      queue_open: Number(slopes.queue_open.toFixed(6)),
      latency_p95_ms: Number(slopes.latency_p95_ms.toFixed(6)),
      token_burn: Number(slopes.token_burn.toFixed(6)),
      model_cooldown_risk: Number(slopes.model_cooldown_risk.toFixed(6))
    },
    forecasts,
    recommendation,
    realized_error: realizedErrors,
    sample_count: historyRows.length + 1,
    pass: true
  };

  writeJsonAtomic(policy.paths.latest, payload);
  appendJsonl(policy.paths.history, payload);
  trimJsonl(policy.paths.history, policy.max_history_rows);

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (strict && payload.pass !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = readJson(policy.paths.latest, null);
  const historyRows = readJsonl(policy.paths.history);
  const errorRows = readJsonl(policy.paths.errors);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'predictive_capacity_forecast_status',
    ts: nowIso(),
    available: !!latest,
    latest: latest || null,
    history_count: historyRows.length,
    error_count: errorRows.length,
    paths: {
      policy_path: rel(policy.policy_path),
      latest_path: rel(policy.paths.latest),
      history_path: rel(policy.paths.history),
      errors_path: rel(policy.paths.errors)
    }
  }, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/predictive_capacity_forecast.js run [--strict=1|0]');
  console.log('  node systems/ops/predictive_capacity_forecast.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
