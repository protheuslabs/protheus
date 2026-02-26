#!/usr/bin/env node
'use strict';
export {};

/**
 * collective_shadow.js
 *
 * Read-only failure-memory lane: distills non-yield and red-team outcomes into
 * bounded archetypes that can influence ranking (penalty/bonus only).
 *
 * Usage:
 *   node systems/autonomy/collective_shadow.js run [YYYY-MM-DD] [--days=14] [--policy=path]
 *   node systems/autonomy/collective_shadow.js status [YYYY-MM-DD]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'collective_shadow_policy.json');
const RUNS_DIR = process.env.COLLECTIVE_SHADOW_RUNS_DIR
  ? path.resolve(process.env.COLLECTIVE_SHADOW_RUNS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'runs');
const RED_TEAM_RUNS_DIR = process.env.COLLECTIVE_SHADOW_RED_TEAM_RUNS_DIR
  ? path.resolve(process.env.COLLECTIVE_SHADOW_RED_TEAM_RUNS_DIR)
  : path.join(ROOT, 'state', 'security', 'red_team', 'runs');
const OUT_DIR = process.env.COLLECTIVE_SHADOW_OUT_DIR
  ? path.resolve(process.env.COLLECTIVE_SHADOW_OUT_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'collective_shadow');
const LATEST_PATH = path.join(OUT_DIR, 'latest.json');
const HISTORY_PATH = path.join(OUT_DIR, 'history.jsonl');

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/collective_shadow.js run [YYYY-MM-DD] [--days=14] [--policy=path]');
  console.log('  node systems/autonomy/collective_shadow.js status [YYYY-MM-DD]');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!String(arg || '').startsWith('--')) {
      out._.push(String(arg || ''));
      continue;
    }
    const idx = arg.indexOf('=');
    if (idx === -1) out[String(arg || '').slice(2)] = true;
    else out[String(arg || '').slice(2, idx)] = String(arg || '').slice(idx + 1);
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function dateArgOrToday(v) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
}

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function normalizeToken(v, maxLen = 120) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .slice(0, maxLen)
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
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
      .filter(Boolean);
  } catch {
    return [];
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function shiftDate(dateStr, deltaDays) {
  const base = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return dateStr;
  base.setUTCDate(base.getUTCDate() + Number(deltaDays || 0));
  return base.toISOString().slice(0, 10);
}

function windowDates(dateStr, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) out.push(shiftDate(dateStr, -i));
  return out;
}

function stableId(seed, prefix = 'csh') {
  const digest = crypto.createHash('sha256').update(String(seed || '')).digest('hex').slice(0, 14);
  return `${prefix}_${digest}`;
}

function relPath(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    window_days: 14,
    min_occurrences: 4,
    max_archetypes: 24,
    avoid_failure_rate_min: 0.65,
    reinforce_success_rate_min: 0.58,
    min_confidence: 0.6,
    penalty_base: 1.8,
    penalty_slope: 9.5,
    penalty_max: 8,
    bonus_base: 0.4,
    bonus_slope: 5.5,
    bonus_max: 3,
    red_team_pressure: {
      enabled: true,
      min_runs: 1,
      critical_fail_penalty: 2.5,
      high_fail_rate_penalty: 1.5,
      fail_rate_threshold: 0.35
    }
  };
}

function loadPolicy(policyPath) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const redTeam = raw.red_team_pressure && typeof raw.red_team_pressure === 'object'
    ? raw.red_team_pressure
    : {};
  return {
    version: String(raw.version || base.version),
    enabled: raw.enabled !== false,
    window_days: clampInt(raw.window_days, 1, 90, base.window_days),
    min_occurrences: clampInt(raw.min_occurrences, 1, 200, base.min_occurrences),
    max_archetypes: clampInt(raw.max_archetypes, 1, 120, base.max_archetypes),
    avoid_failure_rate_min: clampNumber(raw.avoid_failure_rate_min, 0, 1, base.avoid_failure_rate_min),
    reinforce_success_rate_min: clampNumber(raw.reinforce_success_rate_min, 0, 1, base.reinforce_success_rate_min),
    min_confidence: clampNumber(raw.min_confidence, 0, 1, base.min_confidence),
    penalty_base: clampNumber(raw.penalty_base, 0, 20, base.penalty_base),
    penalty_slope: clampNumber(raw.penalty_slope, 0, 50, base.penalty_slope),
    penalty_max: clampNumber(raw.penalty_max, 0, 40, base.penalty_max),
    bonus_base: clampNumber(raw.bonus_base, 0, 20, base.bonus_base),
    bonus_slope: clampNumber(raw.bonus_slope, 0, 30, base.bonus_slope),
    bonus_max: clampNumber(raw.bonus_max, 0, 20, base.bonus_max),
    red_team_pressure: {
      enabled: redTeam.enabled !== false,
      min_runs: clampInt(redTeam.min_runs, 1, 300, base.red_team_pressure.min_runs),
      critical_fail_penalty: clampNumber(
        redTeam.critical_fail_penalty,
        0,
        40,
        base.red_team_pressure.critical_fail_penalty
      ),
      high_fail_rate_penalty: clampNumber(
        redTeam.high_fail_rate_penalty,
        0,
        40,
        base.red_team_pressure.high_fail_rate_penalty
      ),
      fail_rate_threshold: clampNumber(
        redTeam.fail_rate_threshold,
        0,
        1,
        base.red_team_pressure.fail_rate_threshold
      )
    }
  };
}

function isPolicyHoldResult(result) {
  const r = normalizeToken(result, 80);
  return r === 'policy_hold'
    || r.startsWith('no_candidates_policy_')
    || r.startsWith('stop_init_gate_')
    || r.startsWith('stop_repeat_gate_');
}

function isNoProgressRun(row) {
  if (!row || typeof row !== 'object') return false;
  const result = normalizeToken(row.result, 80);
  const outcome = normalizeToken(row.outcome, 80);
  if (result === 'executed' && outcome === 'no_change') return true;
  if (result === 'score_only_evidence' && outcome === 'no_change') return true;
  return false;
}

function confidenceForSamples(samples, rate) {
  const s = Math.max(0, Number(samples || 0));
  const r = clampNumber(rate, 0, 1, 0);
  const base = 0.42 + Math.min(0.4, Math.log2(s + 1) / 10);
  const rateBoost = Math.abs(r - 0.5) >= 0.2 ? 0.08 : 0;
  return Number(clampNumber(base + rateBoost, 0.45, 0.95, 0.45).toFixed(4));
}

function riskLevelsFromStats(stats) {
  const risks = stats && stats.risks && typeof stats.risks === 'object' ? stats.risks : {};
  const ordered = Object.entries(risks)
    .map(([risk, count]) => ({ risk: normalizeToken(risk, 24) || 'unknown', count: Number(count || 0) }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count || a.risk.localeCompare(b.risk));
  const rows = ordered.map((row) => row.risk).filter(Boolean);
  return rows.length ? rows.slice(0, 3) : ['low', 'medium', 'high'];
}

function emptyStats(scopeType, scopeValue) {
  return {
    scope_type: scopeType,
    scope_value: scopeValue,
    samples: 0,
    shipped: 0,
    no_change: 0,
    policy_holds: 0,
    stops: 0,
    risks: {}
  };
}

function updateStats(mapObj, scopeType, scopeValue, row) {
  const key = `${scopeType}:${scopeValue}`;
  if (!mapObj[key]) mapObj[key] = emptyStats(scopeType, scopeValue);
  const bucket = mapObj[key];
  bucket.samples += 1;
  const outcome = normalizeToken(row.outcome, 48);
  const result = normalizeToken(row.result, 80);
  const risk = normalizeToken(row.risk || 'low', 24) || 'low';
  bucket.risks[risk] = Number(bucket.risks[risk] || 0) + 1;
  if (outcome === 'shipped') bucket.shipped += 1;
  if (isNoProgressRun(row)) bucket.no_change += 1;
  if (isPolicyHoldResult(result)) bucket.policy_holds += 1;
  if (result.startsWith('stop_')) bucket.stops += 1;
}

function collectRunStats(dateStr, days) {
  const stats = {};
  let runRows = 0;
  const sampledDays = [];
  for (const day of windowDates(dateStr, days)) {
    sampledDays.push(day);
    const fp = path.join(RUNS_DIR, `${day}.jsonl`);
    for (const row of readJsonl(fp)) {
      if (String(row && row.type || '') !== 'autonomy_run') continue;
      runRows += 1;
      const pType = normalizeToken(row.proposal_type || 'unknown', 80) || 'unknown';
      const capKey = normalizeToken(
        row.capability_key
        || `proposal:${pType}`,
        120
      ) || `proposal:${pType}`;
      updateStats(stats, 'proposal_type', pType, row);
      updateStats(stats, 'capability_key', capKey, row);
    }
  }
  return {
    stats,
    sampled_days: sampledDays,
    run_rows: runRows
  };
}

function listJsonFiles(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => path.join(dirPath, name));
  } catch {
    return [];
  }
}

function redTeamSummary(dateStr, days) {
  const cutoffStart = new Date(`${shiftDate(dateStr, -(days - 1))}T00:00:00.000Z`).getTime();
  const cutoffEnd = new Date(`${dateStr}T23:59:59.999Z`).getTime();
  let runs = 0;
  let executedCases = 0;
  let failCases = 0;
  let criticalFailCases = 0;
  for (const fp of listJsonFiles(RED_TEAM_RUNS_DIR)) {
    const payload = readJson(fp, null);
    if (!payload || typeof payload !== 'object') continue;
    const ts = Date.parse(String(payload.ts || payload.date || ''));
    if (Number.isFinite(ts) && (ts < cutoffStart || ts > cutoffEnd)) continue;
    const summary = payload.summary && typeof payload.summary === 'object' ? payload.summary : {};
    runs += 1;
    executedCases += Number(summary.executed_cases || 0);
    failCases += Number(summary.fail_cases || 0);
    criticalFailCases += Number(summary.critical_fail_cases || 0);
  }
  const failRate = executedCases > 0 ? failCases / executedCases : 0;
  return {
    runs,
    executed_cases: executedCases,
    fail_cases: failCases,
    critical_fail_cases: criticalFailCases,
    fail_rate: Number(failRate.toFixed(4))
  };
}

function buildArchetypes(policy, runStats, redTeam, dateStr) {
  const rows = [];
  const buckets = Object.values(runStats && runStats.stats && typeof runStats.stats === 'object' ? runStats.stats : {});
  for (const rawBucket of buckets) {
    const bucket = rawBucket && typeof rawBucket === 'object' ? rawBucket : {};
    const samples = Number(bucket.samples || 0);
    if (samples < Number(policy.min_occurrences || 1)) continue;
    const shipped = Number(bucket.shipped || 0);
    const noChange = Number(bucket.no_change || 0);
    const holds = Number(bucket.policy_holds || 0);
    const stops = Number(bucket.stops || 0);
    const shippedRate = samples > 0 ? shipped / samples : 0;
    const failureRate = samples > 0 ? (noChange + holds + stops) / samples : 0;
    const confidence = confidenceForSamples(samples, Math.max(shippedRate, failureRate));
    if (failureRate >= Number(policy.avoid_failure_rate_min || 0.65)) {
      const rawPenalty = Number(policy.penalty_base || 0) + (
        (failureRate - Number(policy.avoid_failure_rate_min || 0.65))
        * Number(policy.penalty_slope || 1)
      );
      const penalty = Number(clampNumber(rawPenalty, 0, Number(policy.penalty_max || 8), 0).toFixed(3));
      rows.push({
        id: stableId(`avoid|${bucket.scope_type}|${bucket.scope_value}`, 'csh'),
        kind: 'avoid',
        confidence,
        score_impact: penalty,
        scope: {
          scope_type: bucket.scope_type || 'proposal_type',
          scope_value: bucket.scope_value || 'unknown',
          risk_levels: riskLevelsFromStats(bucket)
        },
        samples,
        shipped_rate: Number(shippedRate.toFixed(4)),
        failure_rate: Number(failureRate.toFixed(4)),
        evidence: `fail=${noChange + holds + stops}/${samples}; shipped=${shipped}/${samples}`,
        updated_at: nowIso()
      });
      continue;
    }
    if (shippedRate >= Number(policy.reinforce_success_rate_min || 0.58)) {
      const rawBonus = Number(policy.bonus_base || 0) + (
        (shippedRate - Number(policy.reinforce_success_rate_min || 0.58))
        * Number(policy.bonus_slope || 1)
      );
      const bonus = Number(clampNumber(rawBonus, 0, Number(policy.bonus_max || 3), 0).toFixed(3));
      rows.push({
        id: stableId(`reinforce|${bucket.scope_type}|${bucket.scope_value}`, 'csh'),
        kind: 'reinforce',
        confidence,
        score_impact: bonus,
        scope: {
          scope_type: bucket.scope_type || 'proposal_type',
          scope_value: bucket.scope_value || 'unknown',
          risk_levels: riskLevelsFromStats(bucket)
        },
        samples,
        shipped_rate: Number(shippedRate.toFixed(4)),
        failure_rate: Number(failureRate.toFixed(4)),
        evidence: `shipped=${shipped}/${samples}; no_change=${noChange}/${samples}`,
        updated_at: nowIso()
      });
    }
  }

  if (
    policy.red_team_pressure
    && policy.red_team_pressure.enabled !== false
    && Number(redTeam && redTeam.runs || 0) >= Number(policy.red_team_pressure.min_runs || 1)
  ) {
    const pressurePenalty = Number(redTeam.critical_fail_cases || 0) > 0
      ? Number(policy.red_team_pressure.critical_fail_penalty || 0)
      : (
          Number(redTeam.fail_rate || 0) >= Number(policy.red_team_pressure.fail_rate_threshold || 1)
            ? Number(policy.red_team_pressure.high_fail_rate_penalty || 0)
            : 0
        );
    if (pressurePenalty > 0) {
      rows.push({
        id: stableId(`red_team_pressure|${dateStr}`, 'csh'),
        kind: 'avoid',
        confidence: confidenceForSamples(Number(redTeam.executed_cases || 0), Number(redTeam.fail_rate || 0)),
        score_impact: Number(clampNumber(pressurePenalty, 0, Number(policy.penalty_max || 8), 0).toFixed(3)),
        scope: {
          scope_type: 'global',
          scope_value: 'security_pressure',
          risk_levels: ['medium', 'high']
        },
        samples: Number(redTeam.executed_cases || 0),
        shipped_rate: 0,
        failure_rate: Number(redTeam.fail_rate || 0),
        evidence: `red_team runs=${Number(redTeam.runs || 0)} fail_rate=${Number(redTeam.fail_rate || 0)}`,
        updated_at: nowIso()
      });
    }
  }

  const minConfidence = Number(policy.min_confidence || 0);
  const filtered = rows
    .filter((row) => Number(row.confidence || 0) >= minConfidence)
    .sort((a, b) => {
      const sa = Number(a.confidence || 0) * Number(a.score_impact || 0);
      const sb = Number(b.confidence || 0) * Number(b.score_impact || 0);
      if (sb !== sa) return sb - sa;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });

  return filtered.slice(0, Number(policy.max_archetypes || 24));
}

function outputPath(dateStr) {
  return path.join(OUT_DIR, `${dateStr}.json`);
}

function runShadow(dateStr, args) {
  const policyPath = path.resolve(String(args.policy || process.env.COLLECTIVE_SHADOW_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const requestedDays = clampInt(args.days, 1, 90, Number(policy.window_days || 14));
  const days = clampInt(requestedDays, 1, 90, Number(policy.window_days || 14));

  if (policy.enabled === false) {
    const out = {
      ok: true,
      type: 'collective_shadow_run',
      ts: nowIso(),
      date: dateStr,
      skipped: true,
      reason: 'policy_disabled',
      policy_path: relPath(policyPath)
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }

  const runs = collectRunStats(dateStr, days);
  const redTeam = redTeamSummary(dateStr, days);
  const archetypes = buildArchetypes(policy, runs, redTeam, dateStr);
  const payload = {
    ok: true,
    type: 'collective_shadow_run',
    ts: nowIso(),
    date: dateStr,
    policy_version: policy.version,
    policy_path: relPath(policyPath),
    window_days: days,
    sampled_days: runs.sampled_days,
    run_rows: Number(runs.run_rows || 0),
    red_team: redTeam,
    summary: {
      archetypes_total: archetypes.length,
      avoid: archetypes.filter((row) => String(row.kind) === 'avoid').length,
      reinforce: archetypes.filter((row) => String(row.kind) === 'reinforce').length
    },
    archetypes
  };

  const fp = outputPath(dateStr);
  writeJsonAtomic(fp, payload);
  writeJsonAtomic(LATEST_PATH, payload);
  appendJsonl(HISTORY_PATH, {
    ts: payload.ts,
    type: payload.type,
    date: payload.date,
    run_rows: payload.run_rows,
    archetypes_total: payload.summary.archetypes_total,
    avoid: payload.summary.avoid,
    reinforce: payload.summary.reinforce,
    red_team_fail_rate: payload.red_team.fail_rate,
    red_team_critical_fail_cases: payload.red_team.critical_fail_cases
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: payload.type,
    date: payload.date,
    window_days: payload.window_days,
    run_rows: payload.run_rows,
    archetypes_total: payload.summary.archetypes_total,
    avoid: payload.summary.avoid,
    reinforce: payload.summary.reinforce,
    red_team_fail_rate: payload.red_team.fail_rate,
    output_path: relPath(fp)
  })}\n`);
}

function statusShadow(dateStr) {
  const payload = readJson(outputPath(dateStr), null) || readJson(LATEST_PATH, null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'collective_shadow_status',
      date: dateStr,
      error: 'collective_shadow_snapshot_missing'
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'collective_shadow_status',
    ts: payload.ts || null,
    date: payload.date || dateStr,
    archetypes_total: payload.summary ? Number(payload.summary.archetypes_total || 0) : 0,
    avoid: payload.summary ? Number(payload.summary.avoid || 0) : 0,
    reinforce: payload.summary ? Number(payload.summary.reinforce || 0) : 0,
    red_team_fail_rate: payload.red_team ? Number(payload.red_team.fail_rate || 0) : 0
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  const dateStr = dateArgOrToday(args._[1]);
  if (cmd === 'run') return runShadow(dateStr, args);
  if (cmd === 'status') return statusShadow(dateStr);
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'collective_shadow',
      error: String(err && err.message ? err.message : err || 'collective_shadow_failed')
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  collectRunStats,
  redTeamSummary,
  buildArchetypes
};
