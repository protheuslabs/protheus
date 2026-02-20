#!/usr/bin/env node
'use strict';

/**
 * router_budget_calibration.js — calibrate router token multipliers from telemetry.
 *
 * Usage:
 *   node systems/routing/router_budget_calibration.js run [--days=7]
 *   node systems/routing/router_budget_calibration.js apply [--days=7] [--approval-note="..."] [--break-glass=1]
 *   node systems/routing/router_budget_calibration.js rollback [latest|--snapshot=<file>] [--approval-note="..."] [--break-glass=1]
 *   node systems/routing/router_budget_calibration.js status
 *   node systems/routing/router_budget_calibration.js --help
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { stampGuardEnv } = require('../../lib/request_envelope.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = process.env.ROUTER_CONFIG_PATH || path.join(REPO_ROOT, 'config', 'agent_routing_rules.json');
const STATE_DIR = process.env.ROUTER_STATE_DIR || path.join(REPO_ROOT, 'state', 'routing');
const SPEND_DIR = process.env.ROUTER_SPEND_DIR || path.join(STATE_DIR, 'spend');
const AUTONOMY_RUNS_DIR = process.env.ROUTER_AUTONOMY_RUNS_DIR || path.join(REPO_ROOT, 'state', 'autonomy', 'runs');
const SNAPSHOT_DIR = path.join(STATE_DIR, 'router_budget_snapshots');
const AUDIT_PATH = path.join(STATE_DIR, 'router_budget_calibration.jsonl');
const GUARD_SCRIPT = path.join(REPO_ROOT, 'systems', 'security', 'guard.js');

const DEFAULTS = {
  days: 7,
  minSamples: 8,
  fullSamples: 24,
  minRequests: 8,
  minMultiplier: 0.2,
  maxMultiplier: 2.8,
  maxChangeRatio: 0.35,
  minChangeRatio: 0.05,
  effectiveWeightCap: 0.35,
  effectiveStepScale: 0.5
};

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return nowIso().slice(0, 10);
}

function toNum(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round3(n) {
  return Number(Number(n).toFixed(3));
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(p, obj) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p);
}

function appendJsonl(p, obj) {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, `${JSON.stringify(obj)}\n`, 'utf8');
}

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  const out = [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const raw of argv) {
    if (!raw.startsWith('--')) {
      out._.push(raw);
      continue;
    }
    const i = raw.indexOf('=');
    if (i === -1) {
      out[raw.slice(2)] = true;
    } else {
      out[raw.slice(2, i)] = raw.slice(i + 1);
    }
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/routing/router_budget_calibration.js run [--days=7]');
  console.log('  node systems/routing/router_budget_calibration.js apply [--days=7] [--approval-note="..."] [--break-glass=1]');
  console.log('  node systems/routing/router_budget_calibration.js rollback [latest|--snapshot=<file>] [--approval-note="..."] [--break-glass=1]');
  console.log('  node systems/routing/router_budget_calibration.js status');
  console.log('  node systems/routing/router_budget_calibration.js --help');
}

function dateFromFilename(name, ext) {
  const m = String(name || '').match(/^(\d{4}-\d{2}-\d{2})\./);
  if (!m || !String(name).endsWith(ext)) return null;
  const ts = Date.parse(`${m[1]}T00:00:00Z`);
  if (!Number.isFinite(ts)) return null;
  return { date: m[1], ts };
}

function recentDateFiles(dirPath, ext, days) {
  if (!fs.existsSync(dirPath)) return [];
  const maxDays = Math.max(1, Number(days || DEFAULTS.days));
  const now = Date.now();
  const files = fs.readdirSync(dirPath)
    .map((name) => {
      const parsed = dateFromFilename(name, ext);
      if (!parsed) return null;
      const age = (now - parsed.ts) / (24 * 60 * 60 * 1000);
      if (!(age >= 0 && age <= maxDays)) return null;
      return { name, date: parsed.date, ts: parsed.ts };
    })
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts);
  return files;
}

function normalizeModel(model) {
  const s = String(model || '').trim();
  if (!s) return '';
  return s;
}

function readRoutingConfig() {
  const cfg = readJson(CONFIG_PATH, null);
  if (!cfg || typeof cfg !== 'object' || !cfg.routing || typeof cfg.routing !== 'object') {
    throw new Error(`invalid routing config: ${CONFIG_PATH}`);
  }
  if (!cfg.routing.router_budget_policy || typeof cfg.routing.router_budget_policy !== 'object') {
    cfg.routing.router_budget_policy = {};
  }
  return cfg;
}

function defaultClassMultipliers() {
  return {
    cheap_local: 0.42,
    local: 0.55,
    cloud_anchor: 1.15,
    cloud_specialist: 1.35,
    cloud: 1.2,
    default: 1
  };
}

function mergedClassMultipliers(cfg) {
  const custom = cfg?.routing?.router_budget_policy?.class_token_multipliers;
  const src = custom && typeof custom === 'object' ? custom : {};
  return { ...defaultClassMultipliers(), ...src };
}

function fallbackMultiplierForModel(model, cfg) {
  const profiles = cfg?.routing?.model_profiles && typeof cfg.routing.model_profiles === 'object'
    ? cfg.routing.model_profiles
    : {};
  const byClass = mergedClassMultipliers(cfg);
  const profileClass = profiles[model] && typeof profiles[model] === 'object'
    ? String(profiles[model].class || '').trim()
    : '';
  if (profileClass && Number.isFinite(toNum(byClass[profileClass])) && toNum(byClass[profileClass]) > 0) {
    return Number(byClass[profileClass]);
  }
  const inferredClass = model.startsWith('ollama/') ? 'local' : 'cloud';
  const inferred = toNum(byClass[inferredClass]);
  if (Number.isFinite(inferred) && inferred > 0) return inferred;
  const d = toNum(byClass.default, 1);
  return Number.isFinite(d) && d > 0 ? d : 1;
}

function parseTokenUsage(ev) {
  const tu = ev && ev.token_usage && typeof ev.token_usage === 'object' ? ev.token_usage : null;
  if (!tu) return null;
  const actualTokens = toNum(
    tu.actual_total_tokens != null ? tu.actual_total_tokens : tu.actual_tokens,
    null
  );
  const effectiveTokens = toNum(
    tu.effective_tokens != null ? tu.effective_tokens : actualTokens,
    null
  );
  const estimatedTokens = toNum(tu.estimated_tokens, null);
  const sourceKind = String(tu.source_kind || '').toLowerCase();
  const source = String(tu.source || '').toLowerCase();
  const actualAvailable = tu.actual_available === true || sourceKind === 'actual' || (Number.isFinite(actualTokens) && actualTokens > 0 && source.indexOf('estimated') === -1 && source.indexOf('heuristic') === -1);
  const approxAvailable = tu.approximate_available === true || sourceKind === 'approximate' || source.indexOf('heuristic') !== -1;
  if (!(Number.isFinite(effectiveTokens) && effectiveTokens > 0)) return null;
  return {
    actual_tokens: actualAvailable && Number.isFinite(actualTokens) && actualTokens > 0 ? actualTokens : null,
    effective_tokens: effectiveTokens,
    estimated_tokens: estimatedTokens,
    sample_kind: actualAvailable ? 'actual' : (approxAvailable ? 'approximate' : 'estimated')
  };
}

function summaryFromRunEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const route = ev.route_summary && typeof ev.route_summary === 'object' ? ev.route_summary : null;
  if (route) return route;
  const preview = ev.preview_summary && typeof ev.preview_summary === 'object' ? ev.preview_summary : null;
  if (preview) return preview;
  return null;
}

function routeEstimateFromSummary(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const cost = summary.cost_estimate && typeof summary.cost_estimate === 'object' ? summary.cost_estimate : null;
  const budget = summary.route_budget && typeof summary.route_budget === 'object' ? summary.route_budget : null;
  return toNum(
    cost && cost.selected_model_tokens_est != null
      ? cost.selected_model_tokens_est
      : (budget ? budget.request_tokens_est : null),
    null
  );
}

function collectTelemetry(days) {
  const byModel = {};
  const daysSeen = new Set();

  for (const f of recentDateFiles(SPEND_DIR, '.json', days)) {
    const payload = readJson(path.join(SPEND_DIR, f.name), null);
    if (!payload || typeof payload !== 'object') continue;
    const rows = payload.by_model && typeof payload.by_model === 'object' ? payload.by_model : {};
    daysSeen.add(f.date);
    for (const [modelRaw, row] of Object.entries(rows)) {
      const model = normalizeModel(modelRaw);
      if (!model) continue;
      if (!byModel[model]) {
        byModel[model] = {
          model,
          requests: 0,
          request_tokens_est_total: 0,
          model_tokens_est_total: 0,
          actual_samples: 0,
          actual_tokens_total: 0,
          estimated_tokens_for_actual_samples: 0,
          effective_samples: 0,
          effective_tokens_total: 0,
          estimated_tokens_for_effective_samples: 0,
          days_seen: new Set()
        };
      }
      const rec = byModel[model];
      rec.requests += Math.max(0, toNum(row && row.requests, 0));
      rec.request_tokens_est_total += Math.max(0, toNum(row && row.request_tokens_est_total, 0));
      rec.model_tokens_est_total += Math.max(0, toNum(row && row.model_tokens_est_total, 0));
      rec.days_seen.add(f.date);
    }
  }

  for (const f of recentDateFiles(AUTONOMY_RUNS_DIR, '.jsonl', days)) {
    const events = readJsonl(path.join(AUTONOMY_RUNS_DIR, f.name));
    daysSeen.add(f.date);
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      if (String(ev.type || '') !== 'autonomy_run') continue;
      const summary = summaryFromRunEvent(ev) || {};
      const model = normalizeModel(summary.selected_model);
      if (!model) continue;
      const routeEst = routeEstimateFromSummary(summary);
      const tokenUsage = parseTokenUsage(ev);
      if (!tokenUsage) continue;
      const estFromUsage = Number.isFinite(toNum(tokenUsage.estimated_tokens, null))
        ? toNum(tokenUsage.estimated_tokens, null)
        : null;
      const sampleEst = Number.isFinite(routeEst) && routeEst > 0
        ? routeEst
        : estFromUsage;
      if (!(Number.isFinite(sampleEst) && sampleEst > 0)) continue;

      if (!byModel[model]) {
        byModel[model] = {
          model,
          requests: 0,
          request_tokens_est_total: 0,
          model_tokens_est_total: 0,
          actual_samples: 0,
          actual_tokens_total: 0,
          estimated_tokens_for_actual_samples: 0,
          effective_samples: 0,
          effective_tokens_total: 0,
          estimated_tokens_for_effective_samples: 0,
          days_seen: new Set()
        };
      }
      const rec = byModel[model];
      rec.effective_samples += 1;
      rec.effective_tokens_total += tokenUsage.effective_tokens;
      rec.estimated_tokens_for_effective_samples += sampleEst;
      if (Number.isFinite(toNum(tokenUsage.actual_tokens, null)) && toNum(tokenUsage.actual_tokens, null) > 0) {
        rec.actual_samples += 1;
        rec.actual_tokens_total += tokenUsage.actual_tokens;
        rec.estimated_tokens_for_actual_samples += sampleEst;
      }
      rec.days_seen.add(f.date);
    }
  }

  const models = {};
  let requestsTotal = 0;
  let actualSamplesTotal = 0;
  let effectiveSamplesTotal = 0;
  for (const [model, rec] of Object.entries(byModel)) {
    const out = {
      model,
      requests: Math.round(rec.requests),
      request_tokens_est_total: Math.round(rec.request_tokens_est_total),
      model_tokens_est_total: Math.round(rec.model_tokens_est_total),
      actual_samples: Math.round(rec.actual_samples),
      actual_tokens_total: Math.round(rec.actual_tokens_total),
      estimated_tokens_for_actual_samples: Math.round(rec.estimated_tokens_for_actual_samples),
      effective_samples: Math.round(rec.effective_samples),
      effective_tokens_total: Math.round(rec.effective_tokens_total),
      estimated_tokens_for_effective_samples: Math.round(rec.estimated_tokens_for_effective_samples),
      days_seen: Array.from(rec.days_seen).sort()
    };
    out.actual_to_est_ratio = out.estimated_tokens_for_actual_samples > 0
      ? Number((out.actual_tokens_total / out.estimated_tokens_for_actual_samples).toFixed(4))
      : null;
    out.effective_to_est_ratio = out.estimated_tokens_for_effective_samples > 0
      ? Number((out.effective_tokens_total / out.estimated_tokens_for_effective_samples).toFixed(4))
      : null;
    models[model] = out;
    requestsTotal += out.requests;
    actualSamplesTotal += out.actual_samples;
    effectiveSamplesTotal += out.effective_samples;
  }

  return {
    days,
    files_considered: {
      spend: recentDateFiles(SPEND_DIR, '.json', days).length,
      autonomy_runs: recentDateFiles(AUTONOMY_RUNS_DIR, '.jsonl', days).length
    },
    days_seen: Array.from(daysSeen).sort(),
    requests_total: requestsTotal,
    actual_samples_total: actualSamplesTotal,
    effective_samples_total: effectiveSamplesTotal,
    models
  };
}

function calibrationOptions(args) {
  return {
    days: Math.max(1, Math.min(30, Math.round(toNum(args.days, DEFAULTS.days)))),
    minSamples: Math.max(1, Math.min(200, Math.round(toNum(args['min-samples'], DEFAULTS.minSamples)))),
    fullSamples: Math.max(1, Math.min(400, Math.round(toNum(args['full-samples'], DEFAULTS.fullSamples)))),
    minRequests: Math.max(1, Math.min(200, Math.round(toNum(args['min-requests'], DEFAULTS.minRequests)))),
    minMultiplier: clamp(toNum(args['min-multiplier'], DEFAULTS.minMultiplier), 0.05, 10),
    maxMultiplier: clamp(toNum(args['max-multiplier'], DEFAULTS.maxMultiplier), 0.1, 12),
    maxChangeRatio: clamp(toNum(args['max-change-ratio'], DEFAULTS.maxChangeRatio), 0.05, 0.9),
    minChangeRatio: clamp(toNum(args['min-change-ratio'], DEFAULTS.minChangeRatio), 0.001, 0.5),
    effectiveWeightCap: clamp(toNum(args['effective-weight-cap'], DEFAULTS.effectiveWeightCap), 0.05, 0.7),
    effectiveStepScale: clamp(toNum(args['effective-step-scale'], DEFAULTS.effectiveStepScale), 0.1, 1)
  };
}

function computeRecommendations(cfg, telemetry, opts) {
  const existingRaw = cfg?.routing?.router_budget_policy?.model_token_multipliers;
  const existing = existingRaw && typeof existingRaw === 'object' ? existingRaw : {};
  const known = new Set([
    ...Object.keys(existing),
    ...Object.keys(telemetry.models || {}),
    ...((cfg?.routing?.spawn_model_allowlist || []).filter(Boolean))
  ]);

  const rows = [];
  let changed = 0;
  for (const model of Array.from(known).sort()) {
    const t = telemetry.models[model] || {};
    const currentFallback = fallbackMultiplierForModel(model, cfg);
    const current = toNum(existing[model], currentFallback);
    const requests = Math.max(0, toNum(t.requests, 0));
    const actualSamples = Math.max(0, toNum(t.actual_samples, 0));
    const actualTokens = Math.max(0, toNum(t.actual_tokens_total, 0));
    const estForActual = Math.max(0, toNum(t.estimated_tokens_for_actual_samples, 0));
    const effectiveSamples = Math.max(0, toNum(t.effective_samples, 0));
    const effectiveTokens = Math.max(0, toNum(t.effective_tokens_total, 0));
    const estForEffective = Math.max(0, toNum(t.estimated_tokens_for_effective_samples, 0));

    let status = 'insufficient_samples';
    let proposed = current;
    let reason = 'missing_actual_samples';
    let observedRatio = null;
    let sampleWeight = 0;
    let wouldApply = false;
    let source = 'none';

    if (actualSamples >= opts.minSamples && requests >= opts.minRequests && estForActual > 0) {
      observedRatio = actualTokens / estForActual;
      source = 'actual';
      const raw = current * observedRatio;
      sampleWeight = clamp(actualSamples / opts.fullSamples, 0, 1);
      let blended = current + ((raw - current) * sampleWeight);
      const stepLower = current * (1 - opts.maxChangeRatio);
      const stepUpper = current * (1 + opts.maxChangeRatio);
      blended = clamp(blended, opts.minMultiplier, opts.maxMultiplier);
      blended = clamp(blended, Math.max(opts.minMultiplier, stepLower), Math.min(opts.maxMultiplier, stepUpper));
      proposed = round3(blended);
      const changeRatio = current > 0 ? Math.abs((proposed - current) / current) : 0;
      wouldApply = changeRatio >= opts.minChangeRatio;
      status = wouldApply ? 'change' : 'stable';
      reason = wouldApply ? 'actual_drift' : 'drift_below_min_change_ratio';
    } else if (effectiveSamples >= opts.minSamples && requests >= opts.minRequests && estForEffective > 0) {
      observedRatio = effectiveTokens / estForEffective;
      source = 'effective';
      const raw = current * observedRatio;
      sampleWeight = clamp((effectiveSamples / opts.fullSamples) * opts.effectiveWeightCap, 0, opts.effectiveWeightCap);
      let blended = current + ((raw - current) * sampleWeight);
      const stepLower = current * (1 - (opts.maxChangeRatio * opts.effectiveStepScale));
      const stepUpper = current * (1 + (opts.maxChangeRatio * opts.effectiveStepScale));
      blended = clamp(blended, opts.minMultiplier, opts.maxMultiplier);
      blended = clamp(blended, Math.max(opts.minMultiplier, stepLower), Math.min(opts.maxMultiplier, stepUpper));
      proposed = round3(blended);
      const changeRatio = current > 0 ? Math.abs((proposed - current) / current) : 0;
      wouldApply = changeRatio >= opts.minChangeRatio;
      status = wouldApply ? 'change' : 'stable';
      reason = wouldApply ? 'effective_drift_low_confidence' : 'effective_drift_below_min_change_ratio';
    }

    if (status === 'change') changed++;
    rows.push({
      model,
      current_multiplier: round3(current),
      proposed_multiplier: round3(proposed),
      delta: round3(proposed - current),
      requests,
      actual_samples: actualSamples,
      actual_tokens_total: Math.round(actualTokens),
      estimated_tokens_for_actual_samples: Math.round(estForActual),
      effective_samples: effectiveSamples,
      effective_tokens_total: Math.round(effectiveTokens),
      estimated_tokens_for_effective_samples: Math.round(estForEffective),
      observed_ratio: observedRatio == null ? null : Number(observedRatio.toFixed(4)),
      sample_weight: Number(sampleWeight.toFixed(4)),
      source,
      status,
      reason,
      apply: wouldApply
    });
  }

  return {
    options: opts,
    changed_models: changed,
    recommendations: rows
  };
}

function runGuard(approvalNote, breakGlass) {
  if (String(process.env.ROUTER_CALIBRATION_SKIP_GUARD || '') === '1') {
    return { ok: true, skipped: true };
  }
  const rel = path.relative(REPO_ROOT, CONFIG_PATH).replace(/\\/g, '/');
  let env = {
    ...process.env,
    CLEARANCE: process.env.CLEARANCE || '2',
    APPROVAL_NOTE: String(approvalNote || '').slice(0, 240),
    BREAK_GLASS: breakGlass ? '1' : '0'
  };
  const source = String(env.REQUEST_SOURCE || 'local').trim() || 'local';
  const action = String(env.REQUEST_ACTION || 'apply').trim() || 'apply';
  env = stampGuardEnv(env, { source, action, files: [rel] });
  const r = spawnSync('node', [GUARD_SCRIPT, `--files=${rel}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env
  });
  const jsonLine = String(r.stdout || '').split('\n').find((x) => x.trim().startsWith('{')) || '{}';
  const payload = readJsonFromText(jsonLine);
  return {
    ok: r.status === 0 && payload && payload.ok === true,
    status: r.status || 0,
    payload,
    stderr: String(r.stderr || '').trim()
  };
}

function readJsonFromText(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function requireClearance3() {
  const c = toNum(process.env.CLEARANCE, 2);
  return Number.isFinite(c) && c >= 3;
}

function snapshotConfig() {
  ensureDir(SNAPSHOT_DIR);
  const name = `${todayStr()}__${Date.now()}__agent_routing_rules.json`;
  const abs = path.join(SNAPSHOT_DIR, name);
  fs.copyFileSync(CONFIG_PATH, abs);
  return abs;
}

function latestSnapshot() {
  if (!fs.existsSync(SNAPSHOT_DIR)) return null;
  const files = fs.readdirSync(SNAPSHOT_DIR).filter((x) => x.endsWith('.json')).sort();
  if (!files.length) return null;
  return path.join(SNAPSHOT_DIR, files[files.length - 1]);
}

function buildPlan(args) {
  const cfg = readRoutingConfig();
  const opts = calibrationOptions(args);
  if (opts.maxMultiplier < opts.minMultiplier) {
    const t = opts.minMultiplier;
    opts.minMultiplier = opts.maxMultiplier;
    opts.maxMultiplier = t;
  }
  const telemetry = collectTelemetry(opts.days);
  const rec = computeRecommendations(cfg, telemetry, opts);
  return {
    ok: true,
    ts: nowIso(),
    config_path: CONFIG_PATH,
    telemetry,
    options: opts,
    changed_models: rec.changed_models,
    recommendations: rec.recommendations
  };
}

function applyPlan(plan, args) {
  if (!requireClearance3()) {
    return { ok: false, code: 1, error: 'apply requires CLEARANCE>=3' };
  }
  const approvalNote = String(args['approval-note'] || process.env.ROUTER_CALIBRATION_APPROVAL_NOTE || 'router_budget_calibration').trim();
  const breakGlass = String(args['break-glass'] || '0') === '1';

  const guard = runGuard(approvalNote, breakGlass);
  if (!guard.ok) {
    return { ok: false, code: 1, error: 'guard_blocked', guard };
  }

  const changes = plan.recommendations.filter((r) => r.apply === true);
  const snapshot = snapshotConfig();
  const cfg = readRoutingConfig();
  const policy = cfg.routing.router_budget_policy && typeof cfg.routing.router_budget_policy === 'object'
    ? cfg.routing.router_budget_policy
    : {};
  const multipliersRaw = policy.model_token_multipliers && typeof policy.model_token_multipliers === 'object'
    ? policy.model_token_multipliers
    : {};
  const multipliers = { ...multipliersRaw };
  for (const row of changes) {
    multipliers[row.model] = row.proposed_multiplier;
  }
  policy.model_token_multipliers = Object.fromEntries(
    Object.entries(multipliers).sort((a, b) => a[0].localeCompare(b[0]))
  );
  cfg.routing.router_budget_policy = policy;
  writeJsonAtomic(CONFIG_PATH, cfg);

  const result = {
    ok: true,
    applied: changes.length,
    changed_models: changes.map((x) => ({
      model: x.model,
      from: x.current_multiplier,
      to: x.proposed_multiplier
    })),
    snapshot
  };

  appendJsonl(AUDIT_PATH, {
    ts: nowIso(),
    type: 'router_budget_calibration_apply',
    options: plan.options,
    changed_models: result.changed_models,
    applied: result.applied,
    snapshot,
    approval_note: approvalNote.slice(0, 240),
    break_glass: breakGlass
  });

  return result;
}

function rollbackToSnapshot(args) {
  if (!requireClearance3()) {
    return { ok: false, code: 1, error: 'rollback requires CLEARANCE>=3' };
  }
  const approvalNote = String(args['approval-note'] || process.env.ROUTER_CALIBRATION_APPROVAL_NOTE || 'router_budget_calibration_rollback').trim();
  const breakGlass = String(args['break-glass'] || '0') === '1';

  const request = String(args.snapshot || args._[1] || 'latest').trim();
  const snap = request === 'latest'
    ? latestSnapshot()
    : (path.isAbsolute(request) ? request : path.join(SNAPSHOT_DIR, path.basename(request)));
  if (!snap || !fs.existsSync(snap)) {
    return { ok: false, code: 1, error: 'snapshot_not_found' };
  }

  const guard = runGuard(approvalNote, breakGlass);
  if (!guard.ok) {
    return { ok: false, code: 1, error: 'guard_blocked', guard };
  }

  fs.copyFileSync(snap, CONFIG_PATH);
  appendJsonl(AUDIT_PATH, {
    ts: nowIso(),
    type: 'router_budget_calibration_rollback',
    snapshot: snap,
    approval_note: approvalNote.slice(0, 240),
    break_glass: breakGlass
  });
  return { ok: true, restored_from: snap };
}

function status() {
  const lines = readJsonl(AUDIT_PATH);
  const last = lines.length ? lines[lines.length - 1] : null;
  return {
    ok: true,
    audit_path: AUDIT_PATH,
    snapshot_dir: SNAPSHOT_DIR,
    events: lines.length,
    last_event: last
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || args.help || cmd === 'help' || cmd === '--help') {
    usage();
    process.exit(0);
  }

  if (cmd === 'status') {
    process.stdout.write(`${JSON.stringify(status())}\n`);
    return;
  }

  if (cmd === 'rollback') {
    const res = rollbackToSnapshot(args);
    process.stdout.write(`${JSON.stringify(res)}\n`);
    process.exit(res.ok ? 0 : (res.code || 1));
  }

  if (cmd === 'run' || cmd === 'report' || cmd === 'apply') {
    const plan = buildPlan(args);
    const shouldApply = cmd === 'apply' || String(args.apply || '0') === '1';
    if (!shouldApply) {
      process.stdout.write(`${JSON.stringify(plan)}\n`);
      return;
    }
    const res = applyPlan(plan, args);
    process.stdout.write(`${JSON.stringify({ ...plan, apply_result: res })}\n`);
    process.exit(res.ok ? 0 : (res.code || 1));
    return;
  }

  process.stdout.write(`${JSON.stringify({ ok: false, error: `unknown command: ${cmd}` })}\n`);
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  collectTelemetry,
  computeRecommendations,
  buildPlan,
  calibrationOptions
};
