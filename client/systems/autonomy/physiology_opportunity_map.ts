#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const AUTONOMY_DIR = fs.existsSync(path.join(ROOT, 'local', 'state', 'autonomy'))
  ? path.join(ROOT, 'local', 'state', 'autonomy')
  : path.join(ROOT, 'state', 'autonomy');
const DEFAULT_SIM_DIR = path.join(AUTONOMY_DIR, 'simulations');
const DEFAULT_CONFIG_PATH = path.join(ROOT, 'config', 'autonomy_physiology_opportunities.json');
const DEFAULT_OUT_DIR = path.join(AUTONOMY_DIR, 'physiology_opportunities');

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/physiology_opportunity_map.js run [YYYY-MM-DD]');
  console.log('    [--from=<simulation.json>] [--config=<config.json>] [--top=N] [--write=1|0]');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function toInt(v, fallback, lo = 1, hi = 1000) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

function isDateStr(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(fp) {
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function resolvePath(raw, fallbackAbs) {
  const v = String(raw || '').trim();
  if (!v) return fallbackAbs;
  return path.isAbsolute(v) ? v : path.join(ROOT, v);
}

function latestSimulationPath() {
  if (!fs.existsSync(DEFAULT_SIM_DIR)) {
    throw new Error(`simulation_dir_missing:${DEFAULT_SIM_DIR}`);
  }
  const files = fs.readdirSync(DEFAULT_SIM_DIR)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort();
  if (!files.length) {
    throw new Error(`simulation_reports_missing:${DEFAULT_SIM_DIR}`);
  }
  return path.join(DEFAULT_SIM_DIR, files[files.length - 1]);
}

function simulationPathForDate(dateStr) {
  return path.join(DEFAULT_SIM_DIR, `${dateStr}.json`);
}

function normalizeSimulationMetrics(payload) {
  const checks = payload && payload.checks && typeof payload.checks === 'object' ? payload.checks : {};
  const checksEff = payload && payload.checks_effective && typeof payload.checks_effective === 'object'
    ? payload.checks_effective
    : {};
  const counters = payload && payload.counters && typeof payload.counters === 'object' ? payload.counters : {};
  const queue = payload && payload.queue && typeof payload.queue === 'object' ? payload.queue : {};
  const objectiveMix = payload && payload.objective_mix && typeof payload.objective_mix === 'object'
    ? payload.objective_mix
    : {};

  const attempts = Math.max(0, num(counters.attempts, 0));
  const noProgress = Math.max(0, num(counters.no_progress, 0));
  const queueTotal = Math.max(0, num(queue.total, 0));
  const queuePending = Math.max(0, num(queue.pending, 0));
  const objectiveCount = Math.max(0, num(objectiveMix.objective_count, 0));

  return {
    raw_drift_rate: num(checks.drift_rate && checks.drift_rate.value, 0),
    raw_yield_rate: num(checks.yield_rate && checks.yield_rate.value, 0),
    raw_safety_stop_rate: num(checks.safety_stop_rate && checks.safety_stop_rate.value, 0),
    raw_policy_hold_rate: num(checks.policy_hold_rate && checks.policy_hold_rate.value, 0),
    effective_drift_rate: num(checksEff.drift_rate && checksEff.drift_rate.value, 0),
    effective_yield_rate: num(checksEff.yield_rate && checksEff.yield_rate.value, 0),
    effective_safety_stop_rate: num(checksEff.safety_stop_rate && checksEff.safety_stop_rate.value, 0),
    effective_policy_hold_rate: num(checksEff.policy_hold_rate && checksEff.policy_hold_rate.value, 0),
    attempts,
    no_progress: noProgress,
    no_progress_rate_raw: attempts > 0 ? noProgress / attempts : 0,
    queue_total: queueTotal,
    queue_pending: queuePending,
    queue_pending_ratio: queueTotal > 0 ? queuePending / queueTotal : 0,
    objective_count: objectiveCount,
    objective_concentration: objectiveCount > 0 ? 1 / objectiveCount : 1
  };
}

function severityAbove(value, warnAt, failAt) {
  const warn = num(warnAt, 0);
  const fail = Math.max(warn + 1e-9, num(failAt, warn + 1));
  if (value <= warn) return 0;
  return clamp01((value - warn) / (fail - warn));
}

function severityBelow(value, targetAtLeast, criticalBelow) {
  const target = num(targetAtLeast, 1);
  const critical = Math.min(target - 1e-9, num(criticalBelow, target - 0.2));
  if (value >= target) return 0;
  if (value <= critical) return 1;
  return clamp01((target - value) / (target - critical));
}

function buildGapSeverities(metrics, config) {
  const gaps = config && config.gaps && typeof config.gaps === 'object' ? config.gaps : {};
  const out = {};
  for (const [k, def] of Object.entries(gaps)) {
    const value = num(metrics[k], 0);
    let severity = 0;
    if (Object.prototype.hasOwnProperty.call(def, 'target_at_least')) {
      severity = severityBelow(value, def.target_at_least, def.critical_below);
    } else {
      severity = severityAbove(value, def.warn_at, def.fail_at);
    }
    out[k] = {
      value: Number(value.toFixed(6)),
      severity: Number(clamp01(severity).toFixed(6))
    };
  }
  return out;
}

function computeOpportunityScores(config, gapSeverities) {
  const ops = Array.isArray(config && config.opportunities) ? config.opportunities : [];
  const scored = [];
  for (const op of ops) {
    const targets = Array.isArray(op.target_gaps) ? op.target_gaps : [];
    let weighted = 0;
    let weightSum = 0;
    const gapBreakdown = [];
    for (const target of targets) {
      const key = String(target && target.key || '').trim();
      const w = Math.max(0, num(target && target.weight, 0));
      if (!key || w <= 0) continue;
      const sev = gapSeverities[key] && typeof gapSeverities[key] === 'object'
        ? num(gapSeverities[key].severity, 0)
        : 0;
      weighted += sev * w;
      weightSum += w;
      gapBreakdown.push({
        key,
        weight: Number(w.toFixed(3)),
        severity: Number(sev.toFixed(3)),
        weighted: Number((sev * w).toFixed(3))
      });
    }
    const score = weightSum > 0 ? weighted / weightSum : 0;
    const priority = score >= 0.66 ? 'P1' : (score >= 0.4 ? 'P2' : 'P3');
    scored.push({
      id: String(op.id || ''),
      title: String(op.title || ''),
      biological_parallel: String(op.biological_parallel || ''),
      summary: String(op.summary || ''),
      score: Number(score.toFixed(4)),
      priority,
      target_gaps: gapBreakdown.sort((a, b) => b.weighted - a.weighted),
      proposed_components: Array.isArray(op.proposed_components) ? op.proposed_components : [],
      expected_effect: op.expected_effect && typeof op.expected_effect === 'object' ? op.expected_effect : {},
      anti_gaming_guardrails: Array.isArray(op.anti_gaming_guardrails) ? op.anti_gaming_guardrails : []
    });
  }
  scored.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
  return scored;
}

function nowIso() {
  return new Date().toISOString();
}

function buildOutput(payload, simulationPath, configPath, config, topN) {
  const metrics = normalizeSimulationMetrics(payload);
  const gapSeverities = buildGapSeverities(metrics, config);
  const scored = computeOpportunityScores(config, gapSeverities);
  const top = scored.slice(0, topN);
  return {
    ok: true,
    type: 'autonomy_physiology_opportunity_map',
    ts: nowIso(),
    source: {
      simulation_path: simulationPath,
      simulation_end_date: String(payload && payload.end_date || ''),
      simulation_days: num(payload && payload.days, 0),
      config_path: configPath
    },
    metrics: {
      raw_drift_rate: Number(metrics.raw_drift_rate.toFixed(3)),
      effective_drift_rate: Number(metrics.effective_drift_rate.toFixed(3)),
      raw_yield_rate: Number(metrics.raw_yield_rate.toFixed(3)),
      effective_yield_rate: Number(metrics.effective_yield_rate.toFixed(3)),
      effective_policy_hold_rate: Number(metrics.effective_policy_hold_rate.toFixed(3)),
      no_progress_rate_raw: Number(metrics.no_progress_rate_raw.toFixed(3)),
      queue_pending_ratio: Number(metrics.queue_pending_ratio.toFixed(3)),
      objective_concentration: Number(metrics.objective_concentration.toFixed(3))
    },
    gap_severities: gapSeverities,
    top_opportunities: top,
    all_opportunities_count: scored.length,
    policy: {
      anti_gaming_contract: [
        'Always report both raw and effective metrics.',
        'No threshold edits in the same stage as feature rollout.',
        'Absolute shipped count must be non-decreasing over matched horizon.'
      ]
    }
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help === true) {
    usage();
    return;
  }
  if (cmd !== 'run') {
    usage();
    process.exit(2);
  }

  const dateArg = String(args._[1] || '').trim();
  let simulationPath = '';
  if (args.from) simulationPath = resolvePath(args.from, latestSimulationPath());
  else if (isDateStr(dateArg)) simulationPath = simulationPathForDate(dateArg);
  else simulationPath = latestSimulationPath();
  if (!fs.existsSync(simulationPath)) {
    throw new Error(`simulation_missing:${simulationPath}`);
  }

  const configPath = resolvePath(args.config, DEFAULT_CONFIG_PATH);
  if (!fs.existsSync(configPath)) {
    throw new Error(`config_missing:${configPath}`);
  }

  const payload = readJson(simulationPath);
  const config = readJson(configPath);
  const topN = toInt(args.top, 3, 1, 20);
  const write = toBool(args.write, false);
  const out = buildOutput(payload, simulationPath, configPath, config, topN);

  if (write) {
    ensureDir(DEFAULT_OUT_DIR);
    const tag = String(payload && payload.end_date || path.basename(simulationPath, '.json'));
    const fp = path.join(DEFAULT_OUT_DIR, `${tag}.json`);
    fs.writeFileSync(fp, JSON.stringify(out, null, 2) + '\n', 'utf8');
    out.report_path = fp;
  }

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: String(err && err.message || err || 'autonomy_physiology_opportunity_map_failed')
    }) + '\n');
    process.exit(1);
  }
}

module.exports = {
  buildGapSeverities,
  buildOutput,
  computeOpportunityScores,
  normalizeSimulationMetrics,
  severityAbove,
  severityBelow
};
