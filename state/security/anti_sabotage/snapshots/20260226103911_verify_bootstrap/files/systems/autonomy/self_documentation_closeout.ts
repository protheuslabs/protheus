#!/usr/bin/env node
'use strict';
export {};

/**
 * self_documentation_closeout.js
 *
 * Daily self-documentation updater.
 * - Compiles a compact session summary from runtime signals.
 * - Writes a deterministic summary artifact.
 * - Upserts a dated line in MEMORY.md unless the change is significant and
 *   explicit approval is required.
 *
 * Usage:
 *   node systems/autonomy/self_documentation_closeout.js run [YYYY-MM-DD] [--approve=1]
 *   node systems/autonomy/self_documentation_closeout.js status [YYYY-MM-DD]
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.env.AUTONOMY_SELF_DOC_ROOT
  ? path.resolve(process.env.AUTONOMY_SELF_DOC_ROOT)
  : path.resolve(__dirname, '..', '..');

const MEMORY_MD_PATH = process.env.AUTONOMY_SELF_DOC_MEMORY_PATH
  ? path.resolve(process.env.AUTONOMY_SELF_DOC_MEMORY_PATH)
  : path.join(ROOT, 'MEMORY.md');
const OUTPUT_DIR = process.env.AUTONOMY_SELF_DOC_OUTPUT_DIR
  ? path.resolve(process.env.AUTONOMY_SELF_DOC_OUTPUT_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'self_documentation');
const DAILY_LOGS_DIR = process.env.AUTONOMY_SELF_DOC_DAILY_LOGS_DIR
  ? path.resolve(process.env.AUTONOMY_SELF_DOC_DAILY_LOGS_DIR)
  : path.join(ROOT, 'state', 'daily_logs');
const AUTONOMY_RUNS_DIR = process.env.AUTONOMY_SELF_DOC_AUTONOMY_RUNS_DIR
  ? path.resolve(process.env.AUTONOMY_SELF_DOC_AUTONOMY_RUNS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'runs');
const SUGGESTION_LANE_DIR = process.env.AUTONOMY_SELF_DOC_SUGGESTION_LANE_DIR
  ? path.resolve(process.env.AUTONOMY_SELF_DOC_SUGGESTION_LANE_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'suggestion_lane');
const SIMULATION_DIR = process.env.AUTONOMY_SELF_DOC_SIMULATION_DIR
  ? path.resolve(process.env.AUTONOMY_SELF_DOC_SIMULATION_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'simulations');
const INTEGRITY_LOG_PATH = process.env.AUTONOMY_SELF_DOC_INTEGRITY_LOG_PATH
  ? path.resolve(process.env.AUTONOMY_SELF_DOC_INTEGRITY_LOG_PATH)
  : path.join(ROOT, 'state', 'security', 'integrity_violations.jsonl');

const DEFAULT_REQUIRE_APPROVAL = String(process.env.AUTONOMY_SELF_DOC_REQUIRE_APPROVAL || '1') !== '0';
const DEFAULT_SIGNIFICANT_THRESHOLD = clampNumber(
  process.env.AUTONOMY_SELF_DOC_SIGNIFICANT_THRESHOLD || 0.6,
  0.05,
  2,
  0.6
);

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/self_documentation_closeout.js run [YYYY-MM-DD] [--approve=1]');
  console.log('  node systems/autonomy/self_documentation_closeout.js status [YYYY-MM-DD]');
  console.log('Options for run:');
  console.log('  --require-approval=0|1');
  console.log('  --significant-threshold=0.6');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = next;
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function dateArgOrToday(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return nowIso().slice(0, 10);
}

function clampNumber(value, lo, hi, fallback = lo) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function toBool(value, fallback = false) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  if (!v) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  return fallback;
}

function readText(filePath, fallback = '') {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
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
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') out.push(parsed);
      } catch {
        // ignore malformed lines
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeJson(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function percent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 'n/a';
  return `${(n * 100).toFixed(2)}%`;
}

function normalizeDatePrefix(value) {
  const ts = String(value || '').trim();
  if (!ts) return '';
  return ts.slice(0, 10);
}

function revenueVerified(row) {
  const r = row && typeof row === 'object' ? row : {};
  if (r.verified === true || r.outcome_verified === true) return true;
  const status = String(r.status || '').trim().toLowerCase();
  return status === 'verified' || status === 'won' || status === 'paid' || status === 'closed_won';
}

function loadDailyMetrics(dateStr) {
  const fp = path.join(DAILY_LOGS_DIR, `${dateStr}.json`);
  const day = readJson(fp, {});
  const entries = Array.isArray(day && day.entries) ? day.entries : [];
  const artifacts = Array.isArray(day && day.artifacts) ? day.artifacts : [];
  const revenue = Array.isArray(day && day.revenue_actions) ? day.revenue_actions : [];
  let minutes = 0;
  for (const row of entries) {
    minutes += Math.max(0, safeNumber(row && row.minutes, 0));
  }
  let artifactEntries = 0;
  for (const row of entries) {
    const list = Array.isArray(row && row.artifacts) ? row.artifacts : [];
    if (list.length > 0) artifactEntries += 1;
  }
  return {
    file_present: fs.existsSync(fp),
    entries_count: entries.length,
    artifact_count: artifacts.length,
    artifact_entry_count: artifactEntries,
    verified_revenue_count: revenue.filter(revenueVerified).length,
    minutes_total: minutes
  };
}

function loadAutonomyMetrics(dateStr) {
  const fp = path.join(AUTONOMY_RUNS_DIR, `${dateStr}.jsonl`);
  const rows = readJsonl(fp);
  let runCount = 0;
  let executedCount = 0;
  let shippedCount = 0;
  let noChangeCount = 0;
  let revertedCount = 0;
  let policyHolds = 0;
  let auditCount = 0;
  for (const row of rows) {
    const t = String(row && row.type || '').trim();
    if (t === 'autonomy_candidate_audit') {
      auditCount += 1;
      continue;
    }
    if (t !== 'autonomy_run') continue;
    runCount += 1;
    const result = String(row && row.result || '').trim().toLowerCase();
    const outcome = String(row && row.outcome || '').trim().toLowerCase();
    if (result === 'executed') executedCount += 1;
    if (result === 'policy_hold') policyHolds += 1;
    if (outcome === 'shipped') shippedCount += 1;
    else if (outcome === 'no_change') noChangeCount += 1;
    else if (outcome === 'reverted') revertedCount += 1;
  }
  return {
    file_present: fs.existsSync(fp),
    run_count: runCount,
    audit_count: auditCount,
    executed_count: executedCount,
    shipped_count: shippedCount,
    no_change_count: noChangeCount,
    reverted_count: revertedCount,
    policy_holds: policyHolds
  };
}

function loadSuggestionLaneMetrics(dateStr) {
  const fp = path.join(SUGGESTION_LANE_DIR, `${dateStr}.json`);
  const payload = readJson(fp, null);
  if (!payload || typeof payload !== 'object') {
    return {
      file_present: false,
      merged_count: 0,
      total_candidates: 0,
      capped: false
    };
  }
  return {
    file_present: true,
    merged_count: Math.max(0, safeNumber(payload.merged_count, 0)),
    total_candidates: Math.max(0, safeNumber(payload.total_candidates, 0)),
    capped: payload.capped === true
  };
}

function firstNumberByCandidate(root, candidates, depth = 0) {
  if (depth > 6 || root == null) return null;
  if (typeof root === 'number' && Number.isFinite(root)) return null;
  if (Array.isArray(root)) {
    for (const item of root) {
      const v = firstNumberByCandidate(item, candidates, depth + 1);
      if (v != null) return v;
    }
    return null;
  }
  if (typeof root !== 'object') return null;
  const obj = root as Record<string, any>;
  for (const [rawKey, val] of Object.entries(obj)) {
    const key = String(rawKey || '').trim().toLowerCase();
    const matched = candidates.some((cand) => key === cand || key.includes(cand));
    if (matched) {
      const n = Number(val);
      if (Number.isFinite(n)) return n;
    }
  }
  for (const val of Object.values(obj)) {
    const v = firstNumberByCandidate(val, candidates, depth + 1);
    if (v != null) return v;
  }
  return null;
}

function loadSimulationMetrics(dateStr) {
  const fp = path.join(SIMULATION_DIR, `${dateStr}.json`);
  const payload = readJson(fp, null);
  if (!payload || typeof payload !== 'object') {
    return {
      file_present: false,
      drift_rate: null,
      yield_rate: null
    };
  }
  const checksEffective = payload.checks_effective && typeof payload.checks_effective === 'object'
    ? payload.checks_effective
    : {};
  const checksRaw = payload.checks && typeof payload.checks === 'object'
    ? payload.checks
    : {};
  const effectiveDrift = checksEffective.drift_rate && typeof checksEffective.drift_rate === 'object'
    ? Number(checksEffective.drift_rate.value)
    : NaN;
  const effectiveYield = checksEffective.yield_rate && typeof checksEffective.yield_rate === 'object'
    ? Number(checksEffective.yield_rate.value)
    : NaN;
  const rawDrift = checksRaw.drift_rate && typeof checksRaw.drift_rate === 'object'
    ? Number(checksRaw.drift_rate.value)
    : NaN;
  const rawYield = checksRaw.yield_rate && typeof checksRaw.yield_rate === 'object'
    ? Number(checksRaw.yield_rate.value)
    : NaN;

  if (Number.isFinite(effectiveDrift) || Number.isFinite(effectiveYield)) {
    return {
      file_present: true,
      drift_rate: Number.isFinite(effectiveDrift) ? effectiveDrift : (Number.isFinite(rawDrift) ? rawDrift : null),
      yield_rate: Number.isFinite(effectiveYield) ? effectiveYield : (Number.isFinite(rawYield) ? rawYield : null)
    };
  }

  const drift = firstNumberByCandidate(payload, [
    'effective_drift_rate',
    'effective_drift',
    'drift_rate_effective',
    'drift_rate'
  ]);
  const y = firstNumberByCandidate(payload, [
    'effective_yield_rate',
    'effective_yield',
    'yield_rate',
    'yield'
  ]);
  const driftNum = drift == null ? NaN : Number(drift);
  const yieldNum = y == null ? NaN : Number(y);
  return {
    file_present: true,
    drift_rate: Number.isFinite(driftNum) ? driftNum : null,
    yield_rate: Number.isFinite(yieldNum) ? yieldNum : null
  };
}

function loadIntegrityMetrics(dateStr) {
  const rows = readJsonl(INTEGRITY_LOG_PATH);
  let violationsToday = 0;
  const files = new Set();
  for (const row of rows) {
    const ts = normalizeDatePrefix(row && row.ts);
    if (ts !== dateStr) continue;
    const violated = Array.isArray(row && row.violated_files) ? row.violated_files : [];
    const explicit = safeNumber(row && row.violation_total, NaN);
    if (Number.isFinite(explicit)) violationsToday += Math.max(0, Math.round(explicit));
    else violationsToday += violated.length > 0 ? violated.length : 1;
    for (const f of violated) files.add(String(f || '').trim());
  }
  return {
    file_present: fs.existsSync(INTEGRITY_LOG_PATH),
    violations_today: violationsToday,
    violated_files: Array.from(files).filter(Boolean).slice(0, 10)
  };
}

function previousSummary(dateStr) {
  try {
    if (!fs.existsSync(OUTPUT_DIR)) return null;
    const files = fs.readdirSync(OUTPUT_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 10))
      .filter((d) => d < dateStr)
      .sort();
    if (!files.length) return null;
    const latestDate = files[files.length - 1];
    const fp = path.join(OUTPUT_DIR, `${latestDate}.json`);
    const parsed = readJson(fp, null);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function evaluateSignificance(snapshot, prior, threshold) {
  const reasons = [];
  let score = 0;
  const integrity = snapshot && snapshot.integrity ? snapshot.integrity : {};
  const sim = snapshot && snapshot.simulation ? snapshot.simulation : {};
  const autonomy = snapshot && snapshot.autonomy ? snapshot.autonomy : {};
  const priorSim = prior && prior.simulation ? prior.simulation : {};

  if (safeNumber(integrity.violations_today, 0) > 0) {
    score += 0.7;
    reasons.push('integrity_violation_detected');
  }
  const drift = Number(sim.drift_rate);
  if (Number.isFinite(drift) && drift >= 0.04) {
    score += 0.45;
    reasons.push('drift_above_target');
  }
  const yieldRate = Number(sim.yield_rate);
  if (Number.isFinite(yieldRate) && yieldRate < 0.62) {
    score += 0.25;
    reasons.push('yield_low');
  }
  const prevDrift = Number(priorSim.drift_rate);
  if (Number.isFinite(prevDrift) && Number.isFinite(drift)) {
    const delta = drift - prevDrift;
    if (Math.abs(delta) >= 0.02) {
      score += 0.3;
      reasons.push(delta > 0 ? 'drift_jump_up' : 'drift_drop_shift');
    }
  }
  const prevYield = Number(priorSim.yield_rate);
  if (Number.isFinite(prevYield) && Number.isFinite(yieldRate)) {
    const delta = yieldRate - prevYield;
    if (delta <= -0.06) {
      score += 0.3;
      reasons.push('yield_drop');
    }
  }
  if (safeNumber(autonomy.reverted_count, 0) > 0) {
    score += 0.18;
    reasons.push('reverted_outcomes_present');
  }
  if (safeNumber(autonomy.executed_count, 0) === 0 && safeNumber(autonomy.audit_count, 0) >= 10) {
    score += 0.18;
    reasons.push('no_execution_under_load');
  }

  score = clampNumber(score, 0, 2, 0);
  const significant = score >= threshold;
  return {
    significant,
    score: Number(score.toFixed(3)),
    threshold: Number(Number(threshold).toFixed(3)),
    reasons
  };
}

function summaryLine(dateStr, snapshot, significance) {
  const daily = snapshot && snapshot.daily ? snapshot.daily : {};
  const autonomy = snapshot && snapshot.autonomy ? snapshot.autonomy : {};
  const lane = snapshot && snapshot.suggestion_lane ? snapshot.suggestion_lane : {};
  const sim = snapshot && snapshot.simulation ? snapshot.simulation : {};
  const integrity = snapshot && snapshot.integrity ? snapshot.integrity : {};
  const flags = Array.isArray(significance && significance.reasons) && significance.reasons.length > 0
    ? ` flags=${significance.reasons.join(',')}`
    : '';
  return `- ${dateStr}: drift ${percent(sim.drift_rate)}, yield ${percent(sim.yield_rate)}, executed ${safeNumber(autonomy.executed_count, 0)}, holds ${safeNumber(autonomy.policy_holds, 0)}, audits ${safeNumber(autonomy.audit_count, 0)}, suggestions ${safeNumber(lane.merged_count, 0)}, integrity ${safeNumber(integrity.violations_today, 0)}, artifacts ${safeNumber(daily.artifact_count, 0)}.${flags}`;
}

function upsertSessionSummary(memoryText, dateStr, line) {
  const text = String(memoryText || '');
  const normalizedLine = String(line || '').trim();
  const lines = text.length ? text.split(/\r?\n/) : [];
  const datePrefix = `- ${dateStr}:`;

  for (let i = 0; i < lines.length; i += 1) {
    if (String(lines[i] || '').startsWith(datePrefix)) {
      lines[i] = normalizedLine;
      const joined = lines.join('\n');
      return joined.endsWith('\n') ? joined : `${joined}\n`;
    }
  }

  let headingIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (String(lines[i] || '').trim().toLowerCase() === '## session summaries') {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx < 0) {
    const base = text.trimEnd();
    const next = `${base}\n\n## Session Summaries\n${normalizedLine}\n`;
    return next.startsWith('\n') ? next.slice(1) : next;
  }

  let insertAt = headingIdx + 1;
  while (insertAt < lines.length && String(lines[insertAt] || '').trim() === '') insertAt += 1;
  lines.splice(insertAt, 0, normalizedLine);
  const joined = lines.join('\n');
  return joined.endsWith('\n') ? joined : `${joined}\n`;
}

function outputFilePath(dateStr) {
  return path.join(OUTPUT_DIR, `${dateStr}.json`);
}

function cmdRun(dateStr, opts) {
  const requireApproval = opts && Object.prototype.hasOwnProperty.call(opts, 'requireApproval')
    ? !!opts.requireApproval
    : DEFAULT_REQUIRE_APPROVAL;
  const approved = !!(opts && opts.approved);
  const threshold = clampNumber(
    opts && Object.prototype.hasOwnProperty.call(opts, 'significantThreshold')
      ? opts.significantThreshold
      : DEFAULT_SIGNIFICANT_THRESHOLD,
    0.05,
    2,
    DEFAULT_SIGNIFICANT_THRESHOLD
  );

  const snapshot = {
    ts: nowIso(),
    date: dateStr,
    daily: loadDailyMetrics(dateStr),
    autonomy: loadAutonomyMetrics(dateStr),
    suggestion_lane: loadSuggestionLaneMetrics(dateStr),
    simulation: loadSimulationMetrics(dateStr),
    integrity: loadIntegrityMetrics(dateStr)
  };
  const prior = previousSummary(dateStr);
  const significance = evaluateSignificance(snapshot, prior, threshold);
  const line = summaryLine(dateStr, snapshot, significance);
  const requiresReview = requireApproval && significance.significant && !approved;
  let applied = false;

  if (!requiresReview) {
    const current = readText(MEMORY_MD_PATH, '# MEMORY.md\n');
    const next = upsertSessionSummary(current, dateStr, line);
    fs.mkdirSync(path.dirname(MEMORY_MD_PATH), { recursive: true });
    fs.writeFileSync(MEMORY_MD_PATH, next, 'utf8');
    applied = true;
  }

  const payload = {
    ok: true,
    type: 'autonomy_self_documentation_closeout',
    ts: nowIso(),
    date: dateStr,
    applied,
    requires_review: requiresReview,
    require_approval: requireApproval,
    approved,
    significant: significance.significant,
    significance_score: significance.score,
    significance_threshold: significance.threshold,
    significance_reasons: significance.reasons,
    summary_line: line,
    memory_path: path.relative(ROOT, MEMORY_MD_PATH).replace(/\\/g, '/'),
    output_path: path.relative(ROOT, outputFilePath(dateStr)).replace(/\\/g, '/'),
    snapshot
  };
  writeJson(outputFilePath(dateStr), payload);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function cmdStatus(dateStr) {
  const fp = outputFilePath(dateStr);
  const payload = readJson(fp, null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'autonomy_self_documentation_closeout_status',
      date: dateStr,
      error: 'status_not_found'
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'autonomy_self_documentation_closeout_status',
    date: dateStr,
    applied: payload.applied === true,
    requires_review: payload.requires_review === true,
    significant: payload.significant === true,
    significance_score: safeNumber(payload.significance_score, 0),
    significance_reasons: Array.isArray(payload.significance_reasons) ? payload.significance_reasons : [],
    output_path: path.relative(ROOT, fp).replace(/\\/g, '/')
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help' || args.help === true) {
    usage();
    return;
  }
  const dateStr = dateArgOrToday(args._[1]);
  if (cmd === 'run') {
    cmdRun(dateStr, {
      approved: toBool(args.approve, false),
      requireApproval: toBool(
        Object.prototype.hasOwnProperty.call(args, 'require-approval') ? args['require-approval'] : DEFAULT_REQUIRE_APPROVAL,
        DEFAULT_REQUIRE_APPROVAL
      ),
      significantThreshold: clampNumber(
        Object.prototype.hasOwnProperty.call(args, 'significant-threshold') ? args['significant-threshold'] : DEFAULT_SIGNIFICANT_THRESHOLD,
        0.05,
        2,
        DEFAULT_SIGNIFICANT_THRESHOLD
      )
    });
    return;
  }
  if (cmd === 'status') {
    cmdStatus(dateStr);
    return;
  }
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  main();
}

module.exports = {
  summaryLine,
  evaluateSignificance,
  upsertSessionSummary
};
