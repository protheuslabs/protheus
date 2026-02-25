#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const {
  loadActiveStrategy,
  strategyMaxRiskPerAction
} = require('../../../lib/strategy_resolver');
const { analyzeIntent } = require('./intent_analyzer');
const { generateCandidates } = require('./candidate_generator');
const { evaluateCandidates } = require('./nursery_tester');
const {
  nowIso,
  clampInt,
  clampNumber,
  cleanText,
  normalizeToken,
  toWorkflowDraft
} = require('./contracts');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_POLICY_PATH = path.join(REPO_ROOT, 'config', 'orchestron_policy.json');
const RUNS_DIR = process.env.ORCHESTRON_RUNS_DIR
  ? path.resolve(process.env.ORCHESTRON_RUNS_DIR)
  : path.join(REPO_ROOT, 'state', 'autonomy', 'runs');
const PRINCIPLES_LATEST_PATH = process.env.ORCHESTRON_PRINCIPLES_PATH
  ? path.resolve(process.env.ORCHESTRON_PRINCIPLES_PATH)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'strategy', 'principles', 'latest.json');
const REGISTRY_PATH = process.env.ORCHESTRON_REGISTRY_PATH
  ? path.resolve(process.env.ORCHESTRON_REGISTRY_PATH)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'registry.json');
const RED_TEAM_RUNTIME_PATH = process.env.ORCHESTRON_RED_TEAM_RUNTIME_PATH
  ? path.resolve(process.env.ORCHESTRON_RED_TEAM_RUNTIME_PATH)
  : path.join(REPO_ROOT, 'state', 'security', 'red_team', 'runtime_state.json');
const OUT_DIR = process.env.ORCHESTRON_OUT_DIR
  ? path.resolve(process.env.ORCHESTRON_OUT_DIR)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'orchestron');
const HISTORY_PATH = path.join(OUT_DIR, 'history.jsonl');
const LATEST_PATH = path.join(OUT_DIR, 'latest.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/workflow/orchestron/adaptive_controller.js run [YYYY-MM-DD] [--intent="..."] [--days=N] [--max-candidates=N] [--policy=path]');
  console.log('  node systems/workflow/orchestron/adaptive_controller.js status [YYYY-MM-DD|latest]');
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

function dateArgOrToday(v) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return payload == null ? fallback : payload;
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
          const parsed = JSON.parse(line);
          return parsed && typeof parsed === 'object' ? parsed : null;
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

function relPath(filePath) {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
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

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    default_window_days: 14,
    min_pattern_occurrences: 2,
    min_candidates: 3,
    max_candidates: 8,
    max_promotions_per_run: 4,
    min_principle_score: 0.6,
    nursery: {
      min_safety_score: 0.62,
      max_regression_risk: 0.45,
      min_composite_score: 0.58,
      max_predicted_drift_delta: 0.01,
      min_predicted_yield_delta: -0.01,
      max_promotions_per_run: 4
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const nurserySrc = raw.nursery && typeof raw.nursery === 'object' ? raw.nursery : {};
  return {
    version: String(raw.version || base.version),
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    default_window_days: clampInt(raw.default_window_days, 1, 90, base.default_window_days),
    min_pattern_occurrences: clampInt(raw.min_pattern_occurrences, 1, 10000, base.min_pattern_occurrences),
    min_candidates: clampInt(raw.min_candidates, 1, 24, base.min_candidates),
    max_candidates: clampInt(raw.max_candidates, 1, 24, base.max_candidates),
    max_promotions_per_run: clampInt(raw.max_promotions_per_run, 1, 24, base.max_promotions_per_run),
    min_principle_score: clampNumber(raw.min_principle_score, 0, 1, base.min_principle_score),
    nursery: {
      min_safety_score: clampNumber(nurserySrc.min_safety_score, 0, 1, base.nursery.min_safety_score),
      max_regression_risk: clampNumber(nurserySrc.max_regression_risk, 0, 1, base.nursery.max_regression_risk),
      min_composite_score: clampNumber(nurserySrc.min_composite_score, 0, 1, base.nursery.min_composite_score),
      max_predicted_drift_delta: clampNumber(nurserySrc.max_predicted_drift_delta, -1, 1, base.nursery.max_predicted_drift_delta),
      min_predicted_yield_delta: clampNumber(nurserySrc.min_predicted_yield_delta, -1, 1, base.nursery.min_predicted_yield_delta),
      max_promotions_per_run: clampInt(nurserySrc.max_promotions_per_run, 1, 24, base.nursery.max_promotions_per_run)
    }
  };
}

function defaultPatternStats(scopeValue) {
  return {
    proposal_type: scopeValue,
    attempts: 0,
    executed: 0,
    shipped: 0,
    no_change: 0,
    holds: 0,
    stops: 0,
    recent_objective_id: null
  };
}

function isPolicyHold(result) {
  const r = String(result || '').trim().toLowerCase();
  if (!r) return false;
  return r === 'policy_hold'
    || r.startsWith('no_candidates_policy_')
    || r.startsWith('stop_init_gate_')
    || r.startsWith('stop_repeat_gate_');
}

function collectPatternStats(dateStr, days, minOccurrences) {
  const byType = {};
  let runRows = 0;
  for (const day of windowDates(dateStr, days)) {
    for (const row of readJsonl(path.join(RUNS_DIR, `${day}.jsonl`))) {
      if (String(row && row.type || '') !== 'autonomy_run') continue;
      runRows += 1;
      const proposalType = normalizeToken(row.proposal_type || 'unknown', 100) || 'unknown';
      if (!byType[proposalType]) byType[proposalType] = defaultPatternStats(proposalType);
      const bucket = byType[proposalType];
      bucket.attempts += 1;
      const result = String(row.result || '').trim().toLowerCase();
      const outcome = String(row.outcome || '').trim().toLowerCase();
      if (result === 'executed') bucket.executed += 1;
      if (outcome === 'shipped') bucket.shipped += 1;
      if (outcome === 'no_change') bucket.no_change += 1;
      if (isPolicyHold(result)) bucket.holds += 1;
      if (result.startsWith('stop_')) bucket.stops += 1;
      if (row.objective_id) bucket.recent_objective_id = String(row.objective_id);
    }
  }
  const rows = Object.values(byType).filter((row) => Number(row.attempts || 0) >= Number(minOccurrences || 1));
  return { run_rows: runRows, rows };
}

function loadPrincipleSnapshot() {
  const payload = readJson(PRINCIPLES_LATEST_PATH, null);
  const summary = payload && payload.summary && typeof payload.summary === 'object' ? payload.summary : {};
  const score = clampNumber(summary.score, 0, 1, 0.5);
  const ids = Array.isArray(payload && payload.principles)
    ? payload.principles.filter((row) => row && row.pass === true).map((row) => String(row.id || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  return {
    available: !!payload,
    score,
    band: String(summary.band || 'unknown'),
    ids
  };
}

function loadRegistryWorkflows() {
  const payload = readJson(REGISTRY_PATH, {});
  const workflows = Array.isArray(payload && payload.workflows) ? payload.workflows : [];
  return workflows.filter((row) => row && typeof row === 'object');
}

function loadRedTeamSnapshot() {
  const payload = readJson(RED_TEAM_RUNTIME_PATH, null);
  if (!payload || typeof payload !== 'object') {
    return {
      available: false,
      ok: true,
      summary: null,
      critical_fail_cases: 0
    };
  }
  const summary = payload.summary && typeof payload.summary === 'object' ? payload.summary : null;
  const critical = Number(
    payload.critical_fail_cases
      || (summary && summary.critical_fail_cases)
      || 0
  );
  return {
    available: true,
    ok: payload.ok !== false,
    summary,
    critical_fail_cases: critical
  };
}

function generateAdaptiveDrafts(dateStr, opts = {}) {
  const policyPath = path.resolve(String(opts.policyPath || process.env.ORCHESTRON_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = opts.policy && typeof opts.policy === 'object' ? opts.policy : loadPolicy(policyPath);
  const days = clampInt(opts.days, 1, 90, policy.default_window_days);
  if (policy.enabled === false) {
    return {
      ok: true,
      skipped: true,
      reason: 'policy_disabled',
      date: dateStr,
      policy,
      policy_path: relPath(policyPath),
      drafts: [],
      scorecards: []
    };
  }

  const strategy = loadActiveStrategy({ allowMissing: true }) || {};
  const strategyId = String(strategy.id || 'unknown');
  const objectivePrimary = cleanText(
    (strategy.objective && strategy.objective.primary)
      || 'Generate adaptive workflows that improve outcome quality under governance constraints.',
    260
  );
  const intent = analyzeIntent(opts.intent || '', {
    strategy,
    source: 'orchestron_adaptive_controller'
  });
  const patternStats = collectPatternStats(dateStr, days, policy.min_pattern_occurrences);
  const principles = loadPrincipleSnapshot();
  const registry = loadRegistryWorkflows();
  const redTeam = loadRedTeamSnapshot();

  const riskPolicy = {
    max_risk_per_action: clampInt(strategyMaxRiskPerAction(strategy, 35), 1, 100, 35),
    allowed_risks: Array.isArray(strategy.risk_policy && strategy.risk_policy.allowed_risks)
      ? strategy.risk_policy.allowed_risks.slice(0, 4)
      : ['low']
  };

  const candidates = generateCandidates({
    date: dateStr,
    strategy_id: strategyId,
    objective_primary: objectivePrimary,
    intent,
    risk_policy: riskPolicy,
    pattern_rows: patternStats.rows,
    registry_workflows: registry,
    min_candidates: policy.min_candidates,
    max_candidates: clampInt(opts.maxCandidates, 1, 24, policy.max_candidates)
  });

  const nursery = evaluateCandidates({
    candidates,
    pattern_rows: patternStats.rows,
    principle_snapshot: principles,
    red_team: redTeam,
    policy: {
      ...policy.nursery,
      max_promotions_per_run: policy.max_promotions_per_run
    }
  });

  const scoreById = new Map((Array.isArray(nursery.scorecards) ? nursery.scorecards : []).map((row) => [String(row.candidate_id || ''), row]));
  const gatedPassing = [];
  for (const row of Array.isArray(nursery.passing) ? nursery.passing : []) {
    if (!row || !row.candidate) continue;
    if (Number(principles.score || 0) < Number(policy.min_principle_score || 0.6)) continue;
    gatedPassing.push(row);
  }

  const drafts = candidates.map((candidate) => {
    const scorecard = scoreById.get(String(candidate && candidate.id || '')) || {
      candidate_id: candidate && candidate.id ? candidate.id : '',
      pass: false,
      base_shipped_rate: 0,
      predicted_yield_delta: 0,
      predicted_drift_delta: 0,
      safety_score: 0,
      regression_risk: 1,
      composite_score: 0,
      reasons: ['scorecard_missing'],
      tested_at: nowIso()
    };
    return toWorkflowDraft(candidate, scorecard, { principles });
  });
  drafts.sort((a, b) => Number(b.metrics && b.metrics.score || 0) - Number(a.metrics && a.metrics.score || 0));
  const promotableDrafts = gatedPassing
    .map((row) => toWorkflowDraft(row.candidate, row.scorecard, { principles }))
    .sort((a, b) => Number(b.metrics && b.metrics.score || 0) - Number(a.metrics && a.metrics.score || 0));

  return {
    ok: true,
    type: 'orchestron_adaptive_run',
    ts: nowIso(),
    date: dateStr,
    days,
    policy,
    policy_path: relPath(policyPath),
    strategy_id: strategyId,
    objective_primary: objectivePrimary,
    intent,
    run_rows: patternStats.run_rows,
    pattern_rows: patternStats.rows.length,
    principles,
    red_team: redTeam,
    candidates,
    scorecards: Array.isArray(nursery.scorecards) ? nursery.scorecards : [],
    passing: gatedPassing.map((row) => ({
      candidate_id: row.candidate.id,
      scorecard: row.scorecard
    })),
    drafts,
    promotable_drafts: promotableDrafts
  };
}

function persistRun(result) {
  const dateStr = String(result && result.date || nowIso().slice(0, 10));
  const fp = path.join(OUT_DIR, `${dateStr}.json`);
  writeJsonAtomic(fp, result);
  writeJsonAtomic(LATEST_PATH, result);
  appendJsonl(HISTORY_PATH, {
    ts: result.ts || nowIso(),
    type: result.type || 'orchestron_adaptive_run',
    date: dateStr,
    strategy_id: result.strategy_id || null,
    run_rows: Number(result.run_rows || 0),
    candidates: Array.isArray(result.candidates) ? result.candidates.length : 0,
    passing: Array.isArray(result.passing) ? result.passing.length : 0,
    drafts: Array.isArray(result.drafts) ? result.drafts.length : 0,
    promotable_drafts: Array.isArray(result.promotable_drafts) ? result.promotable_drafts.length : 0,
    red_team_critical_fail_cases: Number(result.red_team && result.red_team.critical_fail_cases || 0),
    principle_score: Number(result.principles && result.principles.score || 0)
  });
  return fp;
}

function runCmd(dateStr, args) {
  const payload = generateAdaptiveDrafts(dateStr, {
    policyPath: args.policy,
    days: args.days,
    maxCandidates: args['max-candidates'],
    intent: args.intent
  });
  const fp = persistRun(payload);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: payload.type,
    date: payload.date,
    run_rows: Number(payload.run_rows || 0),
    candidates: Array.isArray(payload.candidates) ? payload.candidates.length : 0,
    passing: Array.isArray(payload.passing) ? payload.passing.length : 0,
    drafts: Array.isArray(payload.drafts) ? payload.drafts.length : 0,
    promotable_drafts: Array.isArray(payload.promotable_drafts) ? payload.promotable_drafts.length : 0,
    policy_path: payload.policy_path,
    output_path: relPath(fp)
  })}\n`);
}

function statusCmd(dateArg) {
  const useLatest = String(dateArg || '').trim().toLowerCase() === 'latest';
  const fp = useLatest ? LATEST_PATH : path.join(OUT_DIR, `${dateArgOrToday(dateArg)}.json`);
  const payload = readJson(fp, null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'orchestron_adaptive_status',
      error: 'orchestron_snapshot_missing'
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'orchestron_adaptive_status',
    date: payload.date || null,
    ts: payload.ts || null,
    strategy_id: payload.strategy_id || null,
    run_rows: Number(payload.run_rows || 0),
    candidates: Array.isArray(payload.candidates) ? payload.candidates.length : 0,
    passing: Array.isArray(payload.passing) ? payload.passing.length : 0,
    drafts: Array.isArray(payload.drafts) ? payload.drafts.length : 0,
    promotable_drafts: Array.isArray(payload.promotable_drafts) ? payload.promotable_drafts.length : 0
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'run') return runCmd(dateArgOrToday(args._[1]), args);
  if (cmd === 'status') return statusCmd(args._[1] || 'latest');
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'orchestron_adaptive_controller',
      error: String(err && err.message ? err.message : err || 'orchestron_failed')
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  generateAdaptiveDrafts
};
