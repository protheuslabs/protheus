#!/usr/bin/env node
/**
 * autonomy_controller.js — bounded autonomy loop v0
 *
 * Deterministic, single-step controller:
 * - Select at most one proposal per run (WIP=1)
 * - Enforce initialization gates (stub/score/route preflight)
 * - Enforce repeat gates (no-progress streak + dopamine momentum + daily token cap)
 * - Execute via route_execute.js (ROUTER_ENABLED=1 by default)
 * - Log experiment cards + run events for auditability
 *
 * Feature flag:
 * - AUTONOMY_ENABLED=1 required for run command
 *
 * Usage:
 *   node systems/autonomy/autonomy_controller.js run [YYYY-MM-DD]
 *   node systems/autonomy/autonomy_controller.js status [YYYY-MM-DD]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadActiveDirectives } = require('../../lib/directive_resolver.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROPOSALS_DIR = path.join(REPO_ROOT, 'state', 'sensory', 'proposals');
const QUEUE_DECISIONS_DIR = path.join(REPO_ROOT, 'state', 'queue', 'decisions');
const DOPAMINE_STATE_PATH = path.join(REPO_ROOT, 'state', 'dopamine_state.json');
const DAILY_LOGS_DIR = path.join(REPO_ROOT, 'state', 'daily_logs');
const HABIT_REGISTRY_PATH = path.join(REPO_ROOT, 'habits', 'registry.json');
const HABIT_RUNS_LOG_PATH = path.join(REPO_ROOT, 'habits', 'logs', 'habit_runs.ndjson');
const HABIT_ERRORS_LOG_PATH = path.join(REPO_ROOT, 'habits', 'logs', 'habit_errors.ndjson');
const EYES_CONFIG_PATH = path.join(REPO_ROOT, 'config', 'external_eyes.json');
const EYES_STATE_REGISTRY_PATH = path.join(REPO_ROOT, 'state', 'sensory', 'eyes', 'registry.json');

const AUTONOMY_DIR = path.join(REPO_ROOT, 'state', 'autonomy');
const RUNS_DIR = path.join(AUTONOMY_DIR, 'runs');
const EXPERIMENTS_DIR = path.join(AUTONOMY_DIR, 'experiments');
const DAILY_BUDGET_DIR = path.join(AUTONOMY_DIR, 'daily_budget');
const COOLDOWNS_PATH = path.join(AUTONOMY_DIR, 'cooldowns.json');
const CALIBRATION_PATH = path.join(AUTONOMY_DIR, 'calibration.json');

const DAILY_TOKEN_CAP = Number(process.env.AUTONOMY_DAILY_TOKEN_CAP || 4000);
const NO_CHANGE_LIMIT = Number(process.env.AUTONOMY_NO_CHANGE_LIMIT || 2);
const NO_CHANGE_COOLDOWN_HOURS = Number(process.env.AUTONOMY_NO_CHANGE_COOLDOWN_HOURS || 24);
const REVERT_COOLDOWN_HOURS = Number(process.env.AUTONOMY_REVERT_COOLDOWN_HOURS || 48);
const AUTONOMY_REPEAT_NO_PROGRESS_LIMIT = Number(process.env.AUTONOMY_REPEAT_NO_PROGRESS_LIMIT || 2);
const AUTONOMY_MIN_PROPOSAL_SCORE = Number(process.env.AUTONOMY_MIN_PROPOSAL_SCORE || 0);
const AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS = Number(process.env.AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS || 12);
const AUTONOMY_MIN_DOPAMINE_LAST_SCORE = Number(process.env.AUTONOMY_MIN_DOPAMINE_LAST_SCORE || 0);
const AUTONOMY_MIN_DOPAMINE_AVG7 = Number(process.env.AUTONOMY_MIN_DOPAMINE_AVG7 || 0);
const AUTONOMY_MIN_ROUTE_TOKENS = Number(process.env.AUTONOMY_MIN_ROUTE_TOKENS || 500);
const AUTONOMY_SKIP_STUB = String(process.env.AUTONOMY_SKIP_STUB || '1') !== '0';
const AUTONOMY_MAX_RUNS_PER_DAY = Number(process.env.AUTONOMY_MAX_RUNS_PER_DAY || 4);
const AUTONOMY_MIN_MINUTES_BETWEEN_RUNS = Number(process.env.AUTONOMY_MIN_MINUTES_BETWEEN_RUNS || 15);
const AUTONOMY_MAX_EYE_NO_PROGRESS_24H = Number(process.env.AUTONOMY_MAX_EYE_NO_PROGRESS_24H || 2);
const AUTONOMY_DOD_ALLOW_PROPOSE_SHIPPED = String(process.env.AUTONOMY_DOD_ALLOW_PROPOSE_SHIPPED || '0') === '1';
const AUTONOMY_DOD_MIN_ARTIFACT_DELTA = Number(process.env.AUTONOMY_DOD_MIN_ARTIFACT_DELTA || 1);
const AUTONOMY_DOD_MIN_ENTRY_DELTA = Number(process.env.AUTONOMY_DOD_MIN_ENTRY_DELTA || 1);
const AUTONOMY_DOD_MIN_REVENUE_DELTA = Number(process.env.AUTONOMY_DOD_MIN_REVENUE_DELTA || 1);
const AUTONOMY_DOD_MIN_HABIT_OUTCOME_SCORE = Number(process.env.AUTONOMY_DOD_MIN_HABIT_OUTCOME_SCORE || 0.7);
const AUTONOMY_DOD_EXEC_WINDOW_SLOP_MS = Number(process.env.AUTONOMY_DOD_EXEC_WINDOW_SLOP_MS || 30000);
const AUTONOMY_MIN_SIGNAL_QUALITY = Number(process.env.AUTONOMY_MIN_SIGNAL_QUALITY || 58);
const AUTONOMY_MIN_SENSORY_SIGNAL_SCORE = Number(process.env.AUTONOMY_MIN_SENSORY_SIGNAL_SCORE || 45);
const AUTONOMY_MIN_SENSORY_RELEVANCE_SCORE = Number(process.env.AUTONOMY_MIN_SENSORY_RELEVANCE_SCORE || 42);
const AUTONOMY_MIN_DIRECTIVE_FIT = Number(process.env.AUTONOMY_MIN_DIRECTIVE_FIT || 40);
const AUTONOMY_MIN_ACTIONABILITY_SCORE = Number(process.env.AUTONOMY_MIN_ACTIONABILITY_SCORE || 45);
const AUTONOMY_MIN_COMPOSITE_ELIGIBILITY = Number(process.env.AUTONOMY_MIN_COMPOSITE_ELIGIBILITY || 62);
const AUTONOMY_MIN_EYE_SCORE_EMA = Number(process.env.AUTONOMY_MIN_EYE_SCORE_EMA || 45);
const AUTONOMY_MAX_PROPOSAL_FILE_AGE_HOURS = Number(process.env.AUTONOMY_MAX_PROPOSAL_FILE_AGE_HOURS || 48);
const AUTONOMY_REPEAT_EXHAUSTED_LIMIT = Number(process.env.AUTONOMY_REPEAT_EXHAUSTED_LIMIT || 3);
const AUTONOMY_REPEAT_EXHAUSTED_COOLDOWN_MINUTES = Number(process.env.AUTONOMY_REPEAT_EXHAUSTED_COOLDOWN_MINUTES || 90);
const AUTONOMY_EXPLORE_FRACTION = Number(process.env.AUTONOMY_EXPLORE_FRACTION || 0.25);
const AUTONOMY_EXPLORE_EVERY_N = Number(process.env.AUTONOMY_EXPLORE_EVERY_N || 3);
const AUTONOMY_EXPLORE_MIN_ELIGIBLE = Number(process.env.AUTONOMY_EXPLORE_MIN_ELIGIBLE || 3);
const AUTONOMY_CALIBRATION_ENABLED = String(process.env.AUTONOMY_CALIBRATION_ENABLED || '1') !== '0';
const AUTONOMY_CALIBRATION_WINDOW_DAYS = Number(process.env.AUTONOMY_CALIBRATION_WINDOW_DAYS || 7);
const AUTONOMY_CALIBRATION_MIN_EXECUTED = Number(process.env.AUTONOMY_CALIBRATION_MIN_EXECUTED || 4);
const AUTONOMY_CALIBRATION_MAX_DELTA = Number(process.env.AUTONOMY_CALIBRATION_MAX_DELTA || 10);
const AUTONOMY_SCORECARD_WINDOW_DAYS = Number(process.env.AUTONOMY_SCORECARD_WINDOW_DAYS || 7);
const AUTONOMY_SCORECARD_MIN_ATTEMPTS = Number(process.env.AUTONOMY_SCORECARD_MIN_ATTEMPTS || 3);
const AUTONOMY_DISALLOWED_PARSER_TYPES = new Set(
  String(process.env.AUTONOMY_DISALLOWED_PARSER_TYPES || 'stub')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);
const DIRECTIVE_FIT_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'through', 'that', 'this', 'these', 'those', 'your', 'you',
  'their', 'our', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'will', 'would', 'should',
  'could', 'must', 'can', 'not', 'all', 'any', 'only', 'each', 'per', 'but', 'its', 'it', 'as', 'at', 'on',
  'to', 'in', 'of', 'or', 'an', 'a', 'by'
]);
const ACTION_VERB_RE = /\b(build|implement|fix|add|create|generate|optimize|refactor|automate|ship|deploy|test|measure|instrument|reduce|increase)\b/i;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ensureState() {
  [AUTONOMY_DIR, RUNS_DIR, EXPERIMENTS_DIR, DAILY_BUDGET_DIR].forEach(ensureDir);
}

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function dateArgOrToday(v) {
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return todayStr();
}

function parseArg(name) {
  const pref = `--${name}=`;
  const a = process.argv.find(x => x.startsWith(pref));
  return a ? a.slice(pref.length) : null;
}

function appendJsonl(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function listProposalFiles() {
  if (!fs.existsSync(PROPOSALS_DIR)) return [];
  return fs.readdirSync(PROPOSALS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
}

function loadProposalsForDate(dateStr) {
  const fp = path.join(PROPOSALS_DIR, `${dateStr}.json`);
  if (!fs.existsSync(fp)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.proposals)) return parsed.proposals;
    return [];
  } catch {
    return [];
  }
}

function latestProposalDate(maxDate) {
  const files = listProposalFiles()
    .map(f => f.replace('.json', ''))
    .filter(d => d <= maxDate)
    .sort();
  return files.length ? files[files.length - 1] : null;
}

function allDecisionEvents() {
  if (!fs.existsSync(QUEUE_DECISIONS_DIR)) return [];
  const files = fs.readdirSync(QUEUE_DECISIONS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();
  const out = [];
  for (const f of files) {
    out.push(...readJsonl(path.join(QUEUE_DECISIONS_DIR, f)));
  }
  return out;
}

function buildOverlay(events) {
  const map = new Map();
  for (const e of events) {
    if (!e || !e.proposal_id) continue;
    const cur = map.get(e.proposal_id) || {
      decision: null,
      decision_ts: null,
      decision_reason: null,
      last_outcome: null,
      last_outcome_ts: null,
      last_evidence_ref: null,
      outcomes: { shipped: 0, reverted: 0, no_change: 0 }
    };
    if (e.type === 'decision' && e.decision) {
      if (!cur.decision_ts || String(e.ts) >= String(cur.decision_ts)) {
        cur.decision = e.decision;
        cur.decision_ts = e.ts;
        cur.decision_reason = e.reason || null;
      }
    }
    if (e.type === 'outcome' && e.outcome) {
      const o = String(e.outcome);
      if (cur.outcomes[o] != null) cur.outcomes[o] += 1;
      if (!cur.last_outcome_ts || String(e.ts) >= String(cur.last_outcome_ts)) {
        cur.last_outcome = o;
        cur.last_outcome_ts = e.ts;
        cur.last_evidence_ref = e.evidence_ref || null;
      }
    }
    map.set(e.proposal_id, cur);
  }
  return map;
}

function isStubProposal(p) {
  const title = String(p && p.title || '');
  return title.toUpperCase().includes('[STUB]');
}

function impactWeight(p) {
  const impact = String(p && p.expected_impact || '').toLowerCase();
  if (impact === 'high') return 3;
  if (impact === 'medium') return 2;
  return 1;
}

function riskPenalty(p) {
  const r = String(p && p.risk || '').toLowerCase();
  if (r === 'high') return 2;
  if (r === 'medium') return 1;
  return 0;
}

function estimateTokens(p) {
  const impact = String(p && p.expected_impact || '').toLowerCase();
  if (impact === 'high') return 1400;
  if (impact === 'medium') return 800;
  return 300;
}

function sourceEyeRef(p) {
  const metaEye = p && p.meta && typeof p.meta.source_eye === 'string' ? p.meta.source_eye.trim() : '';
  if (metaEye) return `eye:${metaEye}`;
  const evRef = p && Array.isArray(p.evidence) && p.evidence.length ? String((p.evidence[0] || {}).evidence_ref || '') : '';
  if (evRef.startsWith('eye:')) return evRef;
  return 'eye:unknown_eye';
}

function parseIsoTs(ts) {
  const d = new Date(String(ts || ''));
  return isNaN(d.getTime()) ? null : d;
}

function ageHours(dateStr) {
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  return (Date.now() - start.getTime()) / (1000 * 60 * 60);
}

function getCooldowns() {
  const raw = loadJson(COOLDOWNS_PATH, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function setCooldown(proposalId, hours, reason) {
  const cooldowns = getCooldowns();
  const untilMs = Date.now() + (hours * 60 * 60 * 1000);
  cooldowns[proposalId] = {
    set_ts: nowIso(),
    until_ms: untilMs,
    until: new Date(untilMs).toISOString(),
    reason: String(reason || '').slice(0, 200)
  };
  saveJson(COOLDOWNS_PATH, cooldowns);
}

function cooldownActive(proposalId) {
  const cooldowns = getCooldowns();
  const ent = cooldowns[proposalId];
  if (!ent) return false;
  const untilMs = Number(ent.until_ms || 0);
  if (!untilMs || Date.now() > untilMs) {
    delete cooldowns[proposalId];
    saveJson(COOLDOWNS_PATH, cooldowns);
    return false;
  }
  return true;
}

function dailyBudgetPath(dateStr) {
  return path.join(DAILY_BUDGET_DIR, `${dateStr}.json`);
}

function loadDailyBudget(dateStr) {
  return loadJson(dailyBudgetPath(dateStr), { date: dateStr, token_cap: DAILY_TOKEN_CAP, used_est: 0 });
}

function saveDailyBudget(b) {
  saveJson(dailyBudgetPath(b.date), b);
}

function runsPathFor(dateStr) {
  return path.join(RUNS_DIR, `${dateStr}.jsonl`);
}

function readRuns(dateStr) {
  return readJsonl(runsPathFor(dateStr));
}

function isNoProgressRun(evt) {
  if (!evt || evt.type !== 'autonomy_run') return false;
  if (evt.result === 'executed') return evt.outcome !== 'shipped';
  return evt.result === 'init_gate_stub'
    || evt.result === 'init_gate_low_score'
    || evt.result === 'init_gate_blocked_route'
    || evt.result === 'stop_repeat_gate_stale_signal'
    || evt.result === 'stop_init_gate_quality_exhausted'
    || evt.result === 'stop_init_gate_directive_fit_exhausted'
    || evt.result === 'stop_init_gate_actionability_exhausted'
    || evt.result === 'stop_init_gate_composite_exhausted'
    || evt.result === 'stop_repeat_gate_candidate_exhausted'
    || evt.result === 'stop_repeat_gate_exhaustion_cooldown'
    || evt.result === 'stop_repeat_gate_no_progress'
    || evt.result === 'stop_repeat_gate_dopamine';
}

function runsSinceReset(events) {
  let idx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.type === 'autonomy_reset') {
      idx = i;
      break;
    }
  }
  return idx >= 0 ? events.slice(idx + 1) : events;
}

function isAttemptRunEvent(evt) {
  if (!evt || evt.type !== 'autonomy_run') return false;
  return evt.result === 'executed'
    || evt.result === 'init_gate_stub'
    || evt.result === 'init_gate_low_score'
    || evt.result === 'init_gate_blocked_route'
    || evt.result === 'stop_repeat_gate_stale_signal'
    || evt.result === 'stop_init_gate_quality_exhausted'
    || evt.result === 'stop_init_gate_directive_fit_exhausted'
    || evt.result === 'stop_init_gate_actionability_exhausted'
    || evt.result === 'stop_init_gate_composite_exhausted'
    || evt.result === 'stop_repeat_gate_exhaustion_cooldown'
    || evt.result === 'stop_repeat_gate_candidate_exhausted';
}

function attemptEvents(events) {
  return events.filter(isAttemptRunEvent);
}

function isGateExhaustedAttempt(evt) {
  if (!evt || evt.type !== 'autonomy_run') return false;
  return evt.result === 'stop_repeat_gate_stale_signal'
    || evt.result === 'init_gate_blocked_route'
    || evt.result === 'stop_init_gate_quality_exhausted'
    || evt.result === 'stop_init_gate_directive_fit_exhausted'
    || evt.result === 'stop_init_gate_actionability_exhausted'
    || evt.result === 'stop_init_gate_composite_exhausted'
    || evt.result === 'stop_repeat_gate_candidate_exhausted';
}

function consecutiveGateExhaustedAttempts(events) {
  let count = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || e.type !== 'autonomy_run') continue;
    if (!isAttemptRunEvent(e)) continue;
    if (!isGateExhaustedAttempt(e)) break;
    count++;
  }
  return count;
}

function minutesSinceTs(ts) {
  const d = parseIsoTs(ts);
  if (!d) return null;
  return (Date.now() - d.getTime()) / (1000 * 60);
}

function consecutiveNoProgressRuns(events) {
  let count = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || e.type !== 'autonomy_run') continue;
    if (e.result === 'executed' && e.outcome === 'shipped') break;
    if (!isNoProgressRun(e)) break;
    count++;
  }
  return count;
}

function shippedCount(events) {
  return events.filter(e => e && e.type === 'autonomy_run' && e.result === 'executed' && e.outcome === 'shipped').length;
}

function tallyByResult(events) {
  const out = {};
  for (const e of events) {
    if (!e || e.type !== 'autonomy_run') continue;
    const k = String(e.result || 'unknown');
    out[k] = Number(out[k] || 0) + 1;
  }
  return out;
}

function sortedCounts(mapObj) {
  const items = Object.entries(mapObj || {}).map(([result, count]) => ({ result, count: Number(count || 0) }));
  items.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.result.localeCompare(b.result);
  });
  return items;
}

function scorecardCmd(dateStr) {
  const requestedDays = Number(parseArg('days'));
  const days = clampNumber(
    Number.isFinite(requestedDays) && requestedDays > 0 ? requestedDays : AUTONOMY_SCORECARD_WINDOW_DAYS,
    1,
    30
  );
  const dates = dateWindow(dateStr, days);
  const events = [];
  for (const d of dates) {
    events.push(...readRuns(d));
  }

  const attempts = events.filter(isAttemptRunEvent);
  const executed = events.filter(e => e && e.type === 'autonomy_run' && e.result === 'executed');
  const shipped = executed.filter(e => String(e.outcome || '') === 'shipped');
  const reverted = executed.filter(e => String(e.outcome || '') === 'reverted');
  const noChange = executed.filter(e => String(e.outcome || '') === 'no_change');
  const noProgress = attempts.filter(isNoProgressRun);
  const stopCounts = sortedCounts(
    tallyByResult(events.filter(e => e && e.type === 'autonomy_run' && String(e.result || '').startsWith('stop_')))
  );
  const initGateCounts = sortedCounts(
    tallyByResult(events.filter(e => e && e.type === 'autonomy_run' && (
      String(e.result || '').startsWith('init_gate_') || String(e.result || '').startsWith('stop_init_gate_')
    )))
  );
  const repeatGateCounts = sortedCounts(
    tallyByResult(events.filter(e => e && e.type === 'autonomy_run' && String(e.result || '').startsWith('stop_repeat_gate_')))
  );

  const attemptsN = attempts.length;
  const executedN = executed.length;
  const shippedN = shipped.length;
  const revertedN = reverted.length;
  const noChangeN = noChange.length;
  const noProgressN = noProgress.length;

  const attemptToShipRate = attemptsN > 0 ? shippedN / attemptsN : 0;
  const execToShipRate = executedN > 0 ? shippedN / executedN : 0;
  const revertedRate = executedN > 0 ? revertedN / executedN : 0;
  const noChangeRate = executedN > 0 ? noChangeN / executedN : 0;
  const noProgressRate = attemptsN > 0 ? noProgressN / attemptsN : 0;

  let recommendation = 'insufficient_data';
  if (attemptsN >= AUTONOMY_SCORECARD_MIN_ATTEMPTS) {
    if (attemptToShipRate >= 0.35 && execToShipRate >= 0.45) recommendation = 'scale_attempts_carefully';
    else if (noProgressRate >= 0.7) recommendation = 'raise_signal_actionability_quality';
    else if (revertedRate >= 0.2) recommendation = 'tighten_preflight_and_safety';
    else recommendation = 'focus_on_gate_bottleneck_reduction';
  }

  const out = {
    ts: nowIso(),
    date: dateStr,
    window_days: days,
    window_start: dates.length ? dates[dates.length - 1] : dateStr,
    window_end: dates.length ? dates[0] : dateStr,
    sample_size: {
      attempts: attemptsN,
      executed: executedN,
      shipped: shippedN
    },
    kpis: {
      attempt_to_ship_rate: Number(attemptToShipRate.toFixed(3)),
      executed_to_ship_rate: Number(execToShipRate.toFixed(3)),
      reverted_rate: Number(revertedRate.toFixed(3)),
      no_change_rate: Number(noChangeRate.toFixed(3)),
      no_progress_attempt_rate: Number(noProgressRate.toFixed(3))
    },
    top_stops: stopCounts.slice(0, 10),
    top_init_gates: initGateCounts.slice(0, 10),
    top_repeat_gates: repeatGateCounts.slice(0, 10),
    dominant_bottleneck: stopCounts.length ? stopCounts[0] : null,
    recommendation
  };

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function loadDopamineSnapshot(dateStr) {
  const state = loadJson(DOPAMINE_STATE_PATH, {});
  const dayLog = loadJson(path.join(DAILY_LOGS_DIR, `${dateStr}.json`), null);

  const lastScore = Number(state && state.last_score != null ? state.last_score : 0);
  const avg7 = Number(state && state.rolling_7_day_avg != null ? state.rolling_7_day_avg : 0);
  const streakDays = Number(state && state.current_streak_days != null ? state.current_streak_days : 0);
  const dayArtifacts = Array.isArray(dayLog && dayLog.artifacts) ? dayLog.artifacts.length : 0;
  const dayEntries = Array.isArray(dayLog && dayLog.entries) ? dayLog.entries.length : 0;
  const daySwitches = Number(dayLog && dayLog.context_switches != null ? dayLog.context_switches : 0);
  const dayRevenueActions = Array.isArray(dayLog && dayLog.revenue_actions) ? dayLog.revenue_actions.length : 0;
  const momentumOk = (lastScore >= AUTONOMY_MIN_DOPAMINE_LAST_SCORE) || (avg7 >= AUTONOMY_MIN_DOPAMINE_AVG7);

  return {
    last_score: lastScore,
    avg7,
    streak_days: streakDays,
    day_artifacts: dayArtifacts,
    day_entries: dayEntries,
    day_context_switches: daySwitches,
    day_revenue_actions: dayRevenueActions,
    momentum_ok: momentumOk
  };
}

function loadDailyEvidenceSnapshot(dateStr) {
  const dayLog = loadJson(path.join(DAILY_LOGS_DIR, `${dateStr}.json`), null);
  const artifacts = Array.isArray(dayLog && dayLog.artifacts) ? dayLog.artifacts.length : 0;
  const entries = Array.isArray(dayLog && dayLog.entries) ? dayLog.entries.length : 0;
  const revenueActions = Array.isArray(dayLog && dayLog.revenue_actions) ? dayLog.revenue_actions.length : 0;
  return { artifacts, entries, revenue_actions: revenueActions };
}

function loadRegistryEvidenceSnapshot() {
  const reg = loadJson(HABIT_REGISTRY_PATH, { habits: [] });
  const habits = Array.isArray(reg && reg.habits) ? reg.habits : [];
  let active = 0;
  let candidate = 0;
  for (const h of habits) {
    const state = String((h && h.governance && h.governance.state) || h.status || '').toLowerCase();
    if (state === 'active') active++;
    if (state === 'candidate') candidate++;
  }
  return { total: habits.length, active, candidate };
}

function loadHabitLogsSnapshot() {
  const runs = readJsonl(HABIT_RUNS_LOG_PATH);
  const errors = readJsonl(HABIT_ERRORS_LOG_PATH);
  return {
    run_len: runs.length,
    error_len: errors.length,
    runs,
    errors
  };
}

function loadDoDEvidenceSnapshot(dateStr) {
  return {
    daily: loadDailyEvidenceSnapshot(dateStr),
    registry: loadRegistryEvidenceSnapshot(),
    logs: loadHabitLogsSnapshot()
  };
}

function diffDoDEvidence(before, after) {
  const b = before || { daily: {}, registry: {}, logs: {} };
  const a = after || { daily: {}, registry: {}, logs: {} };
  return {
    artifacts_delta: Number((a.daily && a.daily.artifacts) || 0) - Number((b.daily && b.daily.artifacts) || 0),
    entries_delta: Number((a.daily && a.daily.entries) || 0) - Number((b.daily && b.daily.entries) || 0),
    revenue_actions_delta: Number((a.daily && a.daily.revenue_actions) || 0) - Number((b.daily && b.daily.revenue_actions) || 0),
    registry_total_delta: Number((a.registry && a.registry.total) || 0) - Number((b.registry && b.registry.total) || 0),
    registry_active_delta: Number((a.registry && a.registry.active) || 0) - Number((b.registry && b.registry.active) || 0),
    registry_candidate_delta: Number((a.registry && a.registry.candidate) || 0) - Number((b.registry && b.registry.candidate) || 0),
    habit_runs_delta: Number((a.logs && a.logs.run_len) || 0) - Number((b.logs && b.logs.run_len) || 0),
    habit_errors_delta: Number((a.logs && a.logs.error_len) || 0) - Number((b.logs && b.logs.error_len) || 0)
  };
}

function inExecWindow(ts, window) {
  const d = parseIsoTs(ts);
  if (!d || !window) return false;
  const s = Number(window.start_ms || 0) - AUTONOMY_DOD_EXEC_WINDOW_SLOP_MS;
  const e = Number(window.end_ms || 0) + AUTONOMY_DOD_EXEC_WINDOW_SLOP_MS;
  if (!s || !e) return false;
  const t = d.getTime();
  return t >= s && t <= e;
}

function newLogEvents(beforeEvidence, afterEvidence) {
  const b = beforeEvidence && beforeEvidence.logs ? beforeEvidence.logs : { run_len: 0, error_len: 0 };
  const a = afterEvidence && afterEvidence.logs ? afterEvidence.logs : { runs: [], errors: [] };
  const runStart = Number(b.run_len || 0);
  const errStart = Number(b.error_len || 0);
  return {
    runs: Array.isArray(a.runs) ? a.runs.slice(runStart) : [],
    errors: Array.isArray(a.errors) ? a.errors.slice(errStart) : []
  };
}

function evaluateDoD({ summary, execRes, beforeEvidence, afterEvidence, execWindow }) {
  const diff = diffDoDEvidence(beforeEvidence, afterEvidence);
  const decision = String(summary && summary.decision || '');
  const logs = newLogEvents(beforeEvidence, afterEvidence);

  if (!execRes || execRes.ok !== true) {
    return {
      passed: false,
      class: 'execution_failed',
      reason: `exec_failed_code_${execRes ? execRes.code : 'unknown'}`,
      diff
    };
  }

  const hasArtifactSignal = diff.artifacts_delta >= AUTONOMY_DOD_MIN_ARTIFACT_DELTA;
  const hasEntrySignal = diff.entries_delta >= AUTONOMY_DOD_MIN_ENTRY_DELTA;
  const hasRevenueSignal = diff.revenue_actions_delta >= AUTONOMY_DOD_MIN_REVENUE_DELTA;
  const hasImpactSignal = hasArtifactSignal || hasEntrySignal || hasRevenueSignal;

  if (decision === 'RUN_HABIT' || decision === 'RUN_CANDIDATE_FOR_VERIFICATION') {
    const habitId = String(summary && summary.suggested_habit_id || '').trim();
    const runsInWindow = logs.runs.filter(r => inExecWindow(r.ts, execWindow));
    const errorsInWindow = logs.errors.filter(e => inExecWindow(e.ts, execWindow));
    const relevantRuns = habitId ? runsInWindow.filter(r => String(r.habit_id || '') === habitId) : runsInWindow;
    const relevantErrors = habitId ? errorsInWindow.filter(e => String(e.habit_id || '') === habitId) : errorsInWindow;
    const securityError = relevantErrors.find(e => String(e.error || '').includes('PERMISSION_DENIED') || String(e.error || '').includes('HASH_MISMATCH'));

    if (securityError) {
      return {
        passed: false,
        class: 'habit_security_violation',
        reason: 'habit_error_permission_or_hash',
        diff,
        evidence: {
          habit_id: habitId || null,
          habit_runs_window: relevantRuns.length,
          habit_errors_window: relevantErrors.length
        }
      };
    }

    const successfulRuns = relevantRuns.filter(r => String(r.status || '') === 'success');
    const scoredRuns = successfulRuns.filter(r => Number.isFinite(Number(r.outcome_score)));
    const hasPassingScoredRun = scoredRuns.some(r => Number(r.outcome_score) >= AUTONOMY_DOD_MIN_HABIT_OUTCOME_SCORE);
    const hasSuccessRun = successfulRuns.length > 0;

    if (hasPassingScoredRun) {
      return {
        passed: true,
        class: 'habit_log_verified',
        reason: `habit_run_with_outcome_score>=${AUTONOMY_DOD_MIN_HABIT_OUTCOME_SCORE}`,
        diff,
        evidence: {
          habit_id: habitId || null,
          habit_runs_window: relevantRuns.length,
          habit_success_window: successfulRuns.length
        }
      };
    }

    if (hasSuccessRun && hasImpactSignal) {
      return {
        passed: true,
        class: 'habit_success_plus_impact_delta',
        reason: 'habit_run_success_and_impact_signal',
        diff,
        evidence: {
          habit_id: habitId || null,
          habit_runs_window: relevantRuns.length,
          habit_success_window: successfulRuns.length
        }
      };
    }

    if (hasSuccessRun) {
      return {
        passed: false,
        class: 'habit_success_missing_impact_signal',
        reason: 'habit_run_success_without_score_or_delta',
        diff,
        evidence: {
          habit_id: habitId || null,
          habit_runs_window: relevantRuns.length,
          habit_success_window: successfulRuns.length
        }
      };
    }

    if (!habitId && hasImpactSignal) {
      return {
        passed: true,
        class: 'impact_signal',
        reason: 'impact_signal_without_habit_log_binding',
        diff,
        evidence: {
          habit_id: habitId || null,
          habit_runs_window: relevantRuns.length,
          habit_errors_window: relevantErrors.length
        }
      };
    }

    return {
      passed: false,
      class: 'missing_habit_run_signal',
      reason: habitId ? 'no_habit_run_log_for_suggested_habit' : 'no_habit_run_log_or_impact_signal',
      diff,
      evidence: {
        habit_id: habitId || null,
        habit_runs_window: relevantRuns.length,
        habit_errors_window: relevantErrors.length
      }
    };
  }

  if (decision === 'PROPOSE_HABIT') {
    if (!AUTONOMY_DOD_ALLOW_PROPOSE_SHIPPED) {
      return {
        passed: false,
        class: 'proposal_only',
        reason: 'propose_habit_not_counted_as_shipped',
        diff
      };
    }
    if (diff.registry_candidate_delta >= 1 || diff.registry_total_delta >= 1) {
      return { passed: true, class: 'proposal_growth_signal', reason: 'habit_registry_growth', diff };
    }
    return {
      passed: false,
      class: 'proposal_no_growth',
      reason: 'propose_habit_without_registry_growth',
      diff
    };
  }

  if (decision === 'MANUAL' || decision === 'DENY') {
    return {
      passed: false,
      class: 'manual_or_denied',
      reason: `decision_${decision.toLowerCase()}`,
      diff
    };
  }

  return {
    passed: false,
    class: 'unknown_decision',
    reason: decision ? `decision_${decision.toLowerCase()}` : 'missing_decision',
    diff
  };
}

function dateWindow(endDateStr, days) {
  const out = [];
  const end = new Date(`${endDateStr}T00:00:00.000Z`);
  if (isNaN(end.getTime())) return out;
  for (let i = 0; i < days; i++) {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function sourceEyeId(p) {
  return sourceEyeRef(p).replace(/^eye:/, '');
}

function baseThresholds() {
  return {
    min_signal_quality: AUTONOMY_MIN_SIGNAL_QUALITY,
    min_sensory_signal_score: AUTONOMY_MIN_SENSORY_SIGNAL_SCORE,
    min_sensory_relevance_score: AUTONOMY_MIN_SENSORY_RELEVANCE_SCORE,
    min_directive_fit: AUTONOMY_MIN_DIRECTIVE_FIT,
    min_actionability_score: AUTONOMY_MIN_ACTIONABILITY_SCORE,
    min_eye_score_ema: AUTONOMY_MIN_EYE_SCORE_EMA
  };
}

function clampThreshold(name, n) {
  const x = Number(n);
  const ranges = {
    min_signal_quality: [40, 90],
    min_sensory_signal_score: [35, 85],
    min_sensory_relevance_score: [35, 85],
    min_directive_fit: [25, 90],
    min_actionability_score: [30, 90],
    min_eye_score_ema: [30, 90]
  };
  const r = ranges[name] || [0, 100];
  return clampNumber(Math.round(Number.isFinite(x) ? x : 0), r[0], r[1]);
}

function appliedThresholds(base, deltas) {
  const b = base || baseThresholds();
  const d = deltas || {};
  return {
    min_signal_quality: clampThreshold('min_signal_quality', b.min_signal_quality + Number(d.min_signal_quality || 0)),
    min_sensory_signal_score: clampThreshold('min_sensory_signal_score', b.min_sensory_signal_score + Number(d.min_sensory_signal_score || 0)),
    min_sensory_relevance_score: clampThreshold('min_sensory_relevance_score', b.min_sensory_relevance_score + Number(d.min_sensory_relevance_score || 0)),
    min_directive_fit: clampThreshold('min_directive_fit', b.min_directive_fit + Number(d.min_directive_fit || 0)),
    min_actionability_score: clampThreshold('min_actionability_score', b.min_actionability_score + Number(d.min_actionability_score || 0)),
    min_eye_score_ema: clampThreshold('min_eye_score_ema', b.min_eye_score_ema + Number(d.min_eye_score_ema || 0))
  };
}

function extractEyeFromEvidenceRef(ref) {
  const s = String(ref || '');
  const m = s.match(/\beye:([^\s]+)/);
  return m ? String(m[1]) : null;
}

function outcomeBuckets() {
  return { shipped: 0, no_change: 0, reverted: 0 };
}

function totalOutcomes(b) {
  if (!b) return 0;
  return Number(b.shipped || 0) + Number(b.no_change || 0) + Number(b.reverted || 0);
}

function deriveEntityBias(buckets, minTotal) {
  const total = totalOutcomes(buckets);
  if (total < minTotal) return 0;
  const shippedRate = Number(buckets.shipped || 0) / total;
  const churnRate = (Number(buckets.no_change || 0) + Number(buckets.reverted || 0)) / total;
  if (shippedRate >= 0.6) return -3;
  if (shippedRate >= 0.45) return -2;
  if (churnRate >= 0.8) return 5;
  if (churnRate >= 0.65) return 3;
  if (churnRate >= 0.5) return 1;
  return 0;
}

function summarizeTopBiases(mapObj, limit = 8) {
  const out = [];
  const entries = Object.entries(mapObj || {});
  for (const [key, val] of entries) {
    out.push({
      key,
      bias: Number(val && val.bias || 0),
      total: Number(val && val.total || 0),
      shipped: Number(val && val.shipped || 0),
      no_change: Number(val && val.no_change || 0),
      reverted: Number(val && val.reverted || 0)
    });
  }
  out.sort((a, b) => {
    if (Math.abs(b.bias) !== Math.abs(a.bias)) return Math.abs(b.bias) - Math.abs(a.bias);
    if (b.total !== a.total) return b.total - a.total;
    return a.key.localeCompare(b.key);
  });
  return out.slice(0, limit);
}

function recentRunEvents(endDateStr, days) {
  const events = [];
  for (const d of dateWindow(endDateStr, days)) {
    events.push(...readRuns(d));
  }
  return events;
}

function proposalMetaIndex(endDateStr, days) {
  const idx = new Map();
  for (const d of dateWindow(endDateStr, days)) {
    const proposals = loadProposalsForDate(d);
    for (const p of proposals) {
      if (!p || !p.id) continue;
      if (idx.has(p.id)) continue;
      idx.set(p.id, {
        eye_id: sourceEyeId(p),
        topics: Array.isArray(p && p.meta && p.meta.topics) ? p.meta.topics.map(t => String(t || '').toLowerCase()).filter(Boolean) : []
      });
    }
  }
  return idx;
}

function collectOutcomeStats(endDateStr, days) {
  const byEye = {};
  const byTopic = {};
  const global = outcomeBuckets();
  const metaIdx = proposalMetaIndex(endDateStr, days);
  const events = allDecisionEvents();
  for (const e of events) {
    if (!e || e.type !== 'outcome') continue;
    if (!inWindow(e.ts, endDateStr, days)) continue;
    const out = String(e.outcome || '');
    if (!(out in global)) continue;
    global[out] += 1;

    const meta = metaIdx.get(String(e.proposal_id || '')) || null;
    const eyeId = extractEyeFromEvidenceRef(e.evidence_ref) || (meta && meta.eye_id) || 'unknown_eye';
    if (!byEye[eyeId]) byEye[eyeId] = outcomeBuckets();
    byEye[eyeId][out] += 1;

    const topics = meta && Array.isArray(meta.topics) ? meta.topics : [];
    for (const t of topics) {
      if (!byTopic[t]) byTopic[t] = outcomeBuckets();
      byTopic[t][out] += 1;
    }
  }

  const eyeBiases = {};
  const topicBiases = {};
  for (const [eye, b] of Object.entries(byEye)) {
    const bias = deriveEntityBias(b, 3);
    if (bias !== 0) eyeBiases[eye] = { ...b, total: totalOutcomes(b), bias };
  }
  for (const [topic, b] of Object.entries(byTopic)) {
    const bias = deriveEntityBias(b, 4);
    if (bias !== 0) topicBiases[topic] = { ...b, total: totalOutcomes(b), bias };
  }

  return {
    global: { ...global, total: totalOutcomes(global) },
    eye_biases: eyeBiases,
    topic_biases: topicBiases
  };
}

function computeCalibrationProfile(dateStr, persist = true) {
  const base = baseThresholds();
  const zeroDeltas = {
    min_signal_quality: 0,
    min_sensory_signal_score: 0,
    min_sensory_relevance_score: 0,
    min_directive_fit: 0,
    min_actionability_score: 0,
    min_eye_score_ema: 0
  };

  if (!AUTONOMY_CALIBRATION_ENABLED) {
    return {
      enabled: false,
      ts: nowIso(),
      date: dateStr,
      window_days: AUTONOMY_CALIBRATION_WINDOW_DAYS,
      base_thresholds: base,
      deltas: zeroDeltas,
      effective_thresholds: base,
      metrics: {
        executed: 0,
        shipped: 0,
        no_change: 0,
        reverted: 0,
        exhausted: 0
      },
      eye_biases: {},
      topic_biases: {}
    };
  }

  const windowDays = clampNumber(AUTONOMY_CALIBRATION_WINDOW_DAYS, 1, 30);
  const events = recentRunEvents(dateStr, windowDays).filter(e => e && e.type === 'autonomy_run');
  const executed = events.filter(e => e.result === 'executed');
  const shipped = executed.filter(e => e.outcome === 'shipped').length;
  const noChange = executed.filter(e => e.outcome === 'no_change').length;
  const reverted = executed.filter(e => e.outcome === 'reverted').length;
  const exhausted = events.filter(e => String(e.result || '').includes('_exhausted')).length;
  const executedCount = executed.length;
  const shippedRate = executedCount > 0 ? shipped / executedCount : 0;
  const noChangeRate = executedCount > 0 ? noChange / executedCount : 0;
  const revertedRate = executedCount > 0 ? reverted / executedCount : 0;

  const deltas = { ...zeroDeltas };
  if (executedCount >= AUTONOMY_CALIBRATION_MIN_EXECUTED) {
    if (noChangeRate >= 0.6) {
      deltas.min_signal_quality += 3;
      deltas.min_directive_fit += 3;
      deltas.min_actionability_score += 2;
      deltas.min_sensory_relevance_score += 2;
    }
    if (revertedRate >= 0.15) {
      deltas.min_signal_quality += 2;
      deltas.min_actionability_score += 2;
    }
    if (shippedRate >= 0.45 && exhausted >= 2) {
      deltas.min_signal_quality -= 2;
      deltas.min_directive_fit -= 2;
      deltas.min_actionability_score -= 1;
    }
  } else if (exhausted >= 3) {
    deltas.min_signal_quality -= 1;
    deltas.min_directive_fit -= 1;
  }

  for (const k of Object.keys(deltas)) {
    deltas[k] = clampNumber(deltas[k], -AUTONOMY_CALIBRATION_MAX_DELTA, AUTONOMY_CALIBRATION_MAX_DELTA);
  }

  const outcomeStats = collectOutcomeStats(dateStr, windowDays);
  const profile = {
    version: 1,
    enabled: true,
    ts: nowIso(),
    date: dateStr,
    window_days: windowDays,
    base_thresholds: base,
    deltas,
    effective_thresholds: appliedThresholds(base, deltas),
    metrics: {
      executed: executedCount,
      shipped,
      no_change: noChange,
      reverted,
      exhausted,
      shipped_rate: Number(shippedRate.toFixed(3)),
      no_change_rate: Number(noChangeRate.toFixed(3)),
      reverted_rate: Number(revertedRate.toFixed(3))
    },
    eye_biases: outcomeStats.eye_biases,
    topic_biases: outcomeStats.topic_biases,
    top_eye_biases: summarizeTopBiases(outcomeStats.eye_biases),
    top_topic_biases: summarizeTopBiases(outcomeStats.topic_biases)
  };
  if (persist) saveJson(CALIBRATION_PATH, profile);
  return profile;
}

function clampNumber(n, min, max) {
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function urlDomain(url) {
  try {
    const u = new URL(String(url || ''));
    return String(u.hostname || '').toLowerCase();
  } catch {
    return '';
  }
}

function domainAllowed(domain, allowlist) {
  if (!domain) return false;
  if (!Array.isArray(allowlist) || allowlist.length === 0) return true;
  const d = String(domain).toLowerCase();
  return allowlist.some(raw => {
    const a = String(raw || '').toLowerCase().trim();
    if (!a) return false;
    return d === a || d.endsWith(`.${a}`);
  });
}

function normalizeDirectiveText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenizeDirectiveText(s) {
  const norm = normalizeDirectiveText(s);
  if (!norm) return [];
  return norm
    .split(' ')
    .filter(t => t.length >= 3)
    .filter(t => !DIRECTIVE_FIT_STOPWORDS.has(t))
    .filter(t => !/^\d+$/.test(t));
}

function toStem(token) {
  const t = String(token || '').trim();
  if (t.length <= 5) return t;
  return t.slice(0, 5);
}

function asStringArray(v) {
  if (Array.isArray(v)) return v.map(x => String(x || '').trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

function uniqSorted(arr) {
  return Array.from(new Set(arr)).sort();
}

function loadDirectiveFitProfile() {
  let directives = [];
  try {
    directives = loadActiveDirectives({ allowMissing: true });
  } catch (err) {
    return {
      available: false,
      error: String(err && err.message ? err.message : err).slice(0, 200),
      active_directive_ids: [],
      positive_phrases: [],
      negative_phrases: [],
      positive_tokens: [],
      negative_tokens: []
    };
  }

  const strategic = directives.filter((d) => {
    const id = String((d && d.id) || '').trim();
    if (/^T0[_-]/i.test(id) || /^T0$/i.test(id)) return false;
    const entryTier = Number(d && d.tier);
    const metaTier = Number(d && d.data && d.data.metadata && d.data.metadata.tier);
    const tier = Number.isFinite(entryTier) ? entryTier : metaTier;
    return Number.isFinite(tier) ? tier >= 1 : true;
  });
  const positivePhrases = [];
  const negativePhrases = [];
  const activeIds = [];

  for (const d of strategic) {
    const data = d && d.data ? d.data : {};
    const metadata = data && data.metadata ? data.metadata : {};
    const intent = data && data.intent ? data.intent : {};
    const scope = data && data.scope ? data.scope : {};
    const success = data && data.success_metrics ? data.success_metrics : {};
    activeIds.push(String(d.id || metadata.id || '').trim());

    positivePhrases.push(...asStringArray(metadata.description));
    positivePhrases.push(...asStringArray(intent.primary));
    positivePhrases.push(...asStringArray(scope.included));
    positivePhrases.push(...asStringArray(success.leading));
    positivePhrases.push(...asStringArray(success.lagging));

    negativePhrases.push(...asStringArray(scope.excluded));
  }

  const posPhrasesNorm = uniqSorted(
    positivePhrases
      .map(normalizeDirectiveText)
      .filter(x => x.length >= 4)
  );
  const negPhrasesNorm = uniqSorted(
    negativePhrases
      .map(normalizeDirectiveText)
      .filter(x => x.length >= 4)
  );

  const posTokenSet = new Set();
  const negTokenSet = new Set();
  for (const p of posPhrasesNorm) {
    for (const t of tokenizeDirectiveText(p)) posTokenSet.add(t);
  }
  for (const p of negPhrasesNorm) {
    for (const t of tokenizeDirectiveText(p)) negTokenSet.add(t);
  }
  for (const t of posTokenSet) {
    if (negTokenSet.has(t)) negTokenSet.delete(t);
  }

  const profile = {
    available: activeIds.length > 0 && posTokenSet.size > 0,
    error: null,
    active_directive_ids: uniqSorted(activeIds.filter(Boolean)),
    positive_phrases: posPhrasesNorm,
    negative_phrases: negPhrasesNorm,
    positive_tokens: uniqSorted(Array.from(posTokenSet)),
    negative_tokens: uniqSorted(Array.from(negTokenSet))
  };
  if (!profile.available) {
    profile.error = activeIds.length === 0 ? 'no_active_strategic_directives' : 'empty_directive_keywords';
  }
  return profile;
}

function proposalDirectiveText(p) {
  const parts = [];
  parts.push(String((p && p.title) || ''));
  parts.push(String((p && p.type) || ''));
  parts.push(String((p && p.expected_impact) || ''));
  parts.push(String((p && p.risk) || ''));
  const meta = (p && p.meta) || {};
  parts.push(String(meta.preview || ''));
  parts.push(String(meta.url || ''));
  if (Array.isArray(meta.topics)) parts.push(meta.topics.join(' '));
  if (Array.isArray(p && p.validation)) parts.push(p.validation.join(' '));
  if (Array.isArray(p && p.evidence)) {
    for (const ev of p.evidence) {
      parts.push(String((ev && ev.match) || ''));
      parts.push(String((ev && ev.evidence_ref) || ''));
    }
  }
  return normalizeDirectiveText(parts.join(' '));
}

function directiveTokenHits(textTokensSet, textStemSet, directiveTokens) {
  const hits = [];
  for (const tok of directiveTokens) {
    if (textTokensSet.has(tok)) {
      hits.push(tok);
      continue;
    }
    const stem = toStem(tok);
    if (stem && textStemSet.has(stem)) hits.push(tok);
  }
  return hits;
}

function assessDirectiveFit(p, directiveProfile, thresholds) {
  const minDirectiveFit = Number((thresholds && thresholds.min_directive_fit) || AUTONOMY_MIN_DIRECTIVE_FIT);
  if (!directiveProfile || directiveProfile.available !== true) {
    return {
      pass: true,
      score: 100,
      profile_available: false,
      active_directive_ids: directiveProfile && Array.isArray(directiveProfile.active_directive_ids)
        ? directiveProfile.active_directive_ids
        : [],
      reasons: ['directive_profile_unavailable'],
      matched_positive: [],
      matched_negative: []
    };
  }

  const text = proposalDirectiveText(p);
  const tokens = tokenizeDirectiveText(text);
  const tokenSet = new Set(tokens);
  const stemSet = new Set(tokens.map(toStem));
  const posPhraseHits = directiveProfile.positive_phrases.filter(ph => text.includes(ph));
  const negPhraseHits = directiveProfile.negative_phrases.filter(ph => text.includes(ph));
  const posTokenHits = directiveTokenHits(tokenSet, stemSet, directiveProfile.positive_tokens);
  const negTokenHits = directiveTokenHits(tokenSet, stemSet, directiveProfile.negative_tokens);

  let score = 30;
  score += posPhraseHits.length * 18;
  score += Math.min(30, posTokenHits.length * 5);
  score -= negPhraseHits.length * 20;
  score -= Math.min(24, negTokenHits.length * 6);

  const impact = String((p && p.expected_impact) || '').toLowerCase();
  if (impact === 'high') score += 6;
  else if (impact === 'medium') score += 3;

  const finalScore = clampNumber(Math.round(score), 0, 100);
  const reasons = [];
  if (posPhraseHits.length === 0 && posTokenHits.length === 0) reasons.push('no_directive_alignment');
  if (negPhraseHits.length > 0 || negTokenHits.length > 0) reasons.push('matches_excluded_scope');
  const pass = finalScore >= minDirectiveFit;
  if (!pass) reasons.push('below_min_directive_fit');

  return {
    pass,
    score: finalScore,
    profile_available: true,
    active_directive_ids: directiveProfile.active_directive_ids,
    matched_positive: uniqSorted([...posPhraseHits, ...posTokenHits]).slice(0, 5),
    matched_negative: uniqSorted([...negPhraseHits, ...negTokenHits]).slice(0, 5),
    reasons
  };
}

function loadEyesMap() {
  const out = new Map();
  const cfg = loadJson(EYES_CONFIG_PATH, {});
  const state = loadJson(EYES_STATE_REGISTRY_PATH, {});
  const cfgEyes = Array.isArray(cfg && cfg.eyes) ? cfg.eyes : [];
  const stateEyes = Array.isArray(state && state.eyes) ? state.eyes : [];

  for (const e of cfgEyes) {
    if (!e || !e.id) continue;
    out.set(String(e.id), { ...e });
  }
  for (const e of stateEyes) {
    if (!e || !e.id) continue;
    const id = String(e.id);
    out.set(id, { ...(out.get(id) || {}), ...e });
  }
  return out;
}

function assessSignalQuality(p, eyesMap, thresholds, calibrationProfile) {
  const minSignalQuality = Number((thresholds && thresholds.min_signal_quality) || AUTONOMY_MIN_SIGNAL_QUALITY);
  const minSensorySignal = Number((thresholds && thresholds.min_sensory_signal_score) || AUTONOMY_MIN_SENSORY_SIGNAL_SCORE);
  const minSensoryRelevance = Number((thresholds && thresholds.min_sensory_relevance_score) || AUTONOMY_MIN_SENSORY_RELEVANCE_SCORE);
  const minEyeScoreEma = Number((thresholds && thresholds.min_eye_score_ema) || AUTONOMY_MIN_EYE_SCORE_EMA);
  const eyeId = sourceEyeId(p);
  const eye = eyesMap.get(eyeId) || null;
  const title = String((p && p.title) || '');
  const impact = String((p && p.expected_impact) || '').toLowerCase();
  const risk = String((p && p.risk) || '').toLowerCase();
  const url = String((p && p.meta && p.meta.url) || (Array.isArray(p && p.evidence) && p.evidence[0] && p.evidence[0].evidence_url) || '');
  const domain = urlDomain(url);
  const sensoryRelevanceRaw = Number(p && p.meta && p.meta.relevance_score);
  const sensoryRelevanceTier = String((p && p.meta && p.meta.relevance_tier) || '').toLowerCase();
  const sensoryScoreRaw = Number(p && p.meta && p.meta.signal_quality_score);
  const legacyScoreRaw = Number(p && p.meta && p.meta.score);
  const itemScoreRaw = Number.isFinite(sensoryScoreRaw) ? sensoryScoreRaw : legacyScoreRaw;
  const combinedItemScoreRaw = Number.isFinite(sensoryRelevanceRaw)
    ? ((Number.isFinite(itemScoreRaw) ? itemScoreRaw : sensoryRelevanceRaw) * 0.4) + (sensoryRelevanceRaw * 0.6)
    : itemScoreRaw;
  const sensoryTier = String((p && p.meta && p.meta.signal_quality_tier) || '').toLowerCase();
  const scoreSource = Number.isFinite(sensoryRelevanceRaw)
    ? 'sensory_relevance_score'
    : Number.isFinite(sensoryScoreRaw)
    ? 'sensory_signal_quality_score'
    : Number.isFinite(legacyScoreRaw)
      ? 'legacy_meta_score'
      : 'fallback_default';

  const reasons = [];
  let hardBlock = false;
  let score = 0;

  if (Number.isFinite(combinedItemScoreRaw)) {
    score += clampNumber(combinedItemScoreRaw, 0, 100);
  } else {
    score += 18;
    reasons.push('missing_meta_score');
  }

  if (Number.isFinite(sensoryRelevanceRaw) && sensoryRelevanceRaw < minSensoryRelevance) {
    hardBlock = true;
    reasons.push('sensory_relevance_low');
  }

  if (Number.isFinite(sensoryScoreRaw) && sensoryScoreRaw < minSensorySignal) {
    hardBlock = true;
    reasons.push('sensory_quality_low');
  }

  if (sensoryRelevanceTier === 'low') score -= 8;
  if (sensoryTier === 'low') score -= 8;

  if (impact === 'high') score += 12;
  else if (impact === 'medium') score += 6;

  if (risk === 'high') score -= 12;
  else if (risk === 'medium') score -= 6;

  if (url.startsWith('https://')) score += 6;
  else if (url.startsWith('http://')) score += 2;
  else score -= 8;

  if (/\[stub\]/i.test(title)) {
    score -= 40;
    hardBlock = true;
    reasons.push('stub_title');
  }

  if (eye) {
    const eyeStatus = String(eye.status || '').toLowerCase();
    const parserType = String(eye.parser_type || '').toLowerCase();
    const eyeScoreEma = Number(eye.score_ema);

    if (Number.isFinite(eyeScoreEma)) {
      score += (eyeScoreEma - 50) * 0.35;
      if (eyeScoreEma < minEyeScoreEma) {
        hardBlock = true;
        reasons.push('eye_score_ema_low');
      }
    }

    if (eyeStatus === 'active') score += 4;
    else if (eyeStatus === 'probation') score -= 6;
    else if (eyeStatus === 'dormant') {
      score -= 18;
      hardBlock = true;
      reasons.push('eye_dormant');
    }

    if (parserType && AUTONOMY_DISALLOWED_PARSER_TYPES.has(parserType)) {
      score -= 30;
      hardBlock = true;
      reasons.push(`parser_disallowed:${parserType}`);
    }

    const allowlist = Array.isArray(eye.allowed_domains) ? eye.allowed_domains : [];
    if (domain && allowlist.length > 0 && !domainAllowed(domain, allowlist)) {
      // Eyes often collect from feed domains but point to third-party article domains.
      // Treat this as a weak signal, not a hard block.
      score -= 3;
      reasons.push('domain_outside_allowlist');
    }

    const proposedTotal = Number(eye.proposed_total || 0);
    const yieldRate = Number(eye.yield_rate);
    if (proposedTotal >= 3 && Number.isFinite(yieldRate)) {
      score += (yieldRate * 15) - 5;
      if (yieldRate < 0.1) reasons.push('eye_yield_low');
    }
  } else {
    reasons.push('eye_unknown');
  }

  const eyeBias = Number(
    calibrationProfile
      && calibrationProfile.eye_biases
      && calibrationProfile.eye_biases[eyeId]
      && calibrationProfile.eye_biases[eyeId].bias
  ) || 0;
  const topicBiases = [];
  const topics = Array.isArray(p && p.meta && p.meta.topics) ? p.meta.topics : [];
  for (const t of topics) {
    const key = String(t || '').toLowerCase();
    const b = Number(
      calibrationProfile
        && calibrationProfile.topic_biases
        && calibrationProfile.topic_biases[key]
        && calibrationProfile.topic_biases[key].bias
    );
    if (Number.isFinite(b)) topicBiases.push(b);
  }
  const topicBias = topicBiases.length ? (topicBiases.reduce((a, b) => a + b, 0) / topicBiases.length) : 0;
  const totalBias = eyeBias + topicBias;
  if (Number.isFinite(totalBias) && totalBias !== 0) {
    score -= totalBias;
    reasons.push(totalBias > 0 ? 'calibration_penalty' : 'calibration_bonus');
  }

  const finalScore = clampNumber(Math.round(score), 0, 100);
  const pass = !hardBlock && finalScore >= minSignalQuality;
  if (!pass && finalScore < minSignalQuality) reasons.push('below_min_signal_quality');

  return {
    pass,
    score: finalScore,
    score_source: scoreSource,
    eye_id: eyeId,
    sensory_relevance_score: Number.isFinite(sensoryRelevanceRaw) ? sensoryRelevanceRaw : null,
    sensory_relevance_tier: sensoryRelevanceTier || null,
    sensory_quality_score: Number.isFinite(sensoryScoreRaw) ? sensoryScoreRaw : null,
    sensory_quality_tier: sensoryTier || null,
    eye_status: eye ? String(eye.status || '') : null,
    eye_score_ema: eye && Number.isFinite(Number(eye.score_ema)) ? Number(eye.score_ema) : null,
    parser_type: eye ? String(eye.parser_type || '') : null,
    domain: domain || null,
    calibration_eye_bias: eyeBias,
    calibration_topic_bias: Number(topicBias.toFixed(3)),
    calibration_total_bias: Number(totalBias.toFixed(3)),
    reasons
  };
}

function assessActionability(p, directiveFit, thresholds) {
  const minActionability = Number((thresholds && thresholds.min_actionability_score) || AUTONOMY_MIN_ACTIONABILITY_SCORE);
  const title = String((p && p.title) || '');
  const impact = String((p && p.expected_impact) || '').toLowerCase();
  const validation = Array.isArray(p && p.validation) ? p.validation : [];
  const nextCmd = String((p && p.suggested_next_command) || '').trim();
  const relevance = Number(p && p.meta && p.meta.relevance_score);
  const fitScore = Number((directiveFit && directiveFit.score) || (p && p.meta && p.meta.directive_fit_score));
  const reasons = [];
  let score = 0;
  let hardBlock = false;

  if (impact === 'high') score += 24;
  else if (impact === 'medium') score += 16;
  else score += 8;

  if (validation.length >= 3) score += 18;
  else if (validation.length >= 2) score += 12;
  else if (validation.length >= 1) score += 6;
  else reasons.push('missing_validation_plan');

  if (nextCmd) score += 14;
  else reasons.push('missing_next_command');

  const looksLikeDiscoveryCmd = /^open\s+["'][^"']+["']$/i.test(nextCmd);
  if (looksLikeDiscoveryCmd) {
    score -= 18;
    reasons.push('discovery_only_command');
  }

  if (ACTION_VERB_RE.test(title) || validation.some(v => ACTION_VERB_RE.test(String(v || '')))) {
    score += 12;
  } else {
    reasons.push('no_action_verb');
  }

  if (Number.isFinite(relevance)) score += (relevance - 45) * 0.3;
  if (Number.isFinite(fitScore)) score += (fitScore - 35) * 0.25;

  if (looksLikeDiscoveryCmd && impact === 'low' && !ACTION_VERB_RE.test(title)) {
    hardBlock = true;
    reasons.push('non_actionable_discovery_item');
  }

  const finalScore = clampNumber(Math.round(score), 0, 100);
  const pass = !hardBlock && finalScore >= minActionability;
  if (!pass && finalScore < minActionability) reasons.push('below_min_actionability');

  return {
    pass,
    score: finalScore,
    reasons
  };
}

function compositeEligibilityScore(qualityScore, directiveFitScore, actionabilityScore) {
  const q = clampNumber(Number(qualityScore || 0), 0, 100);
  const d = clampNumber(Number(directiveFitScore || 0), 0, 100);
  const a = clampNumber(Number(actionabilityScore || 0), 0, 100);
  const weighted = (q * 0.42) + (d * 0.26) + (a * 0.32);
  return clampNumber(Math.round(weighted), 0, 100);
}

function countEyeProposalsInWindow(eyeId, endDateStr, days) {
  if (!eyeId) return 0;
  let count = 0;
  for (const d of dateWindow(endDateStr, days)) {
    for (const p of loadProposalsForDate(d)) {
      if (sourceEyeId(p) === eyeId) count++;
    }
  }
  return count;
}

function inWindow(ts, endDateStr, days) {
  const t = parseIsoTs(ts);
  if (!t) return false;
  const end = new Date(`${endDateStr}T23:59:59.999Z`);
  if (isNaN(end.getTime())) return false;
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - (days - 1));
  start.setUTCHours(0, 0, 0, 0);
  return t >= start && t <= end;
}

function countEyeOutcomesInWindow(events, eyeRef, outcome, endDateStr, days) {
  if (!eyeRef) return 0;
  let count = 0;
  for (const e of events) {
    if (!e || e.type !== 'outcome') continue;
    if (String(e.outcome || '') !== String(outcome || '')) continue;
    if (!inWindow(e.ts, endDateStr, days)) continue;
    if (!String(e.evidence_ref || '').includes(eyeRef)) continue;
    count++;
  }
  return count;
}

function countEyeOutcomesInLastHours(events, eyeRef, outcome, hours) {
  if (!eyeRef || !hours || hours <= 0) return 0;
  const cutoff = Date.now() - (hours * 60 * 60 * 1000);
  let count = 0;
  for (const e of events) {
    if (!e || e.type !== 'outcome') continue;
    if (String(e.outcome || '') !== String(outcome || '')) continue;
    if (!String(e.evidence_ref || '').includes(eyeRef)) continue;
    const d = parseIsoTs(e.ts);
    if (!d) continue;
    if (d.getTime() < cutoff) continue;
    count++;
  }
  return count;
}

function proposalStatus(overlayEnt) {
  if (!overlayEnt || !overlayEnt.decision) return 'pending';
  if (overlayEnt.decision === 'accept') return 'accepted';
  if (overlayEnt.decision === 'reject') return 'rejected';
  if (overlayEnt.decision === 'park') return 'parked';
  return 'pending';
}

function proposalScore(p, overlayEnt, dateStr) {
  const agePenalty = ageHours(dateStr) / 24 * 0.6;
  const stubPenalty = isStubProposal(p) ? 2.5 : 0;
  const noChangePenalty = (overlayEnt?.outcomes?.no_change || 0) * 1.5;
  const revertedPenalty = (overlayEnt?.outcomes?.reverted || 0) * 3.0;
  return (
    impactWeight(p) * 2.0
    - riskPenalty(p) * 1.0
    - agePenalty
    - stubPenalty
    - noChangePenalty
    - revertedPenalty
  );
}

function runProposalQueue(cmd, id, reasonOrEvidence, maybeEvidence) {
  const script = path.join(REPO_ROOT, 'habits', 'scripts', 'proposal_queue.js');
  const args = [script, cmd, id];
  if (reasonOrEvidence != null) args.push(String(reasonOrEvidence));
  if (maybeEvidence != null) args.push(String(maybeEvidence));
  const r = spawnSync('node', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return {
    ok: r.status === 0,
    code: r.status || 0,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim()
  };
}

function runRouteExecute(task, tokensEst, repeats14d = 1, errors30d = 0, dryRun = false) {
  const script = path.join(REPO_ROOT, 'systems', 'routing', 'route_execute.js');
  const args = [
    script,
    '--task', task,
    '--tokens_est', String(tokensEst),
    '--repeats_14d', String(repeats14d),
    '--errors_30d', String(errors30d)
  ];
  if (dryRun) args.push('--dry-run');
  const env = { ...process.env, ROUTER_ENABLED: process.env.ROUTER_ENABLED || '1' };
  const r = spawnSync('node', args, { cwd: REPO_ROOT, encoding: 'utf8', env });
  const stdout = (r.stdout || '').trim();
  const firstJson = stdout.split('\n').find(line => line.startsWith('{') && line.endsWith('}'));
  let summary = null;
  if (firstJson) {
    try { summary = JSON.parse(firstJson); } catch {}
  }
  return {
    ok: r.status === 0,
    code: r.status || 0,
    stdout,
    stderr: (r.stderr || '').trim(),
    summary
  };
}

function makeTaskFromProposal(p) {
  const proposalId = String((p && p.id) || 'unknown');
  const proposalType = String((p && p.type) || 'task').replace(/[^a-z0-9_-]/gi, '').toLowerCase();
  const title = String(p.title || '')
    .replace(/\[Eyes:[^\]]+\]\s*/g, '')
    .slice(0, 140);
  return `Execute bounded proposal ${proposalId} (${proposalType}): ${title}`;
}

function writeExperiment(dateStr, card) {
  appendJsonl(path.join(EXPERIMENTS_DIR, `${dateStr}.jsonl`), card);
}

function writeRun(dateStr, evt) {
  appendJsonl(path.join(RUNS_DIR, `${dateStr}.jsonl`), evt);
}

function candidatePool(dateStr) {
  const proposals = loadProposalsForDate(dateStr);
  const overlay = buildOverlay(allDecisionEvents());
  const pool = [];
  for (const p of proposals) {
    if (!p || !p.id) continue;
    const ov = overlay.get(p.id) || null;
    const status = proposalStatus(ov);
    if (status === 'rejected' || status === 'parked') continue;
    if (cooldownActive(p.id)) continue;
    pool.push({
      proposal: p,
      overlay: ov,
      status,
      score: proposalScore(p, ov, dateStr)
    });
  }
  pool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.proposal.id).localeCompare(String(b.proposal.id));
  });
  return pool;
}

function exploreQuotaForDay() {
  const frac = clampNumber(AUTONOMY_EXPLORE_FRACTION, 0.05, 0.5);
  return Math.max(1, Math.floor(Math.max(1, AUTONOMY_MAX_RUNS_PER_DAY) * frac));
}

function chooseSelectionMode(eligible, priorRuns) {
  const executed = (priorRuns || []).filter(e => e && e.type === 'autonomy_run' && e.result === 'executed');
  const executedCount = executed.length;
  const exploreUsed = executed.filter(e => e.selection_mode === 'explore').length;
  const quota = exploreQuotaForDay();
  const everyN = Math.max(1, AUTONOMY_EXPLORE_EVERY_N);
  const minEligible = Math.max(2, AUTONOMY_EXPLORE_MIN_ELIGIBLE);

  let mode = 'exploit';
  let idx = 0;
  if (
    eligible.length >= minEligible
    && exploreUsed < quota
    && executedCount > 0
    && executedCount % everyN === 0
  ) {
    mode = 'explore';
    idx = Math.min(eligible.length - 1, Math.max(1, Math.floor(eligible.length / 2)));
  }

  return {
    mode,
    index: idx,
    explore_used: exploreUsed,
    explore_quota: quota,
    exploit_used: executed.filter(e => e.selection_mode === 'exploit').length
  };
}

function statusCmd(dateStr) {
  const effectiveDate = latestProposalDate(dateStr) || dateStr;
  const pool = candidatePool(effectiveDate);
  const budget = loadDailyBudget(dateStr);
  const eyesMap = loadEyesMap();
  const directiveProfile = loadDirectiveFitProfile();
  const calibrationProfile = computeCalibrationProfile(dateStr, false);
  const thresholds = calibrationProfile.effective_thresholds || baseThresholds();
  const runs = runsSinceReset(readRuns(dateStr));
  const attempts = attemptEvents(runs);
  const executedRuns = runs.filter(e => e && e.type === 'autonomy_run' && e.result === 'executed');
  const attemptsToday = attempts.length;
  const lastAttempt = attempts.length ? attempts[attempts.length - 1] : null;
  const lastAttemptMinutesAgo = lastAttempt ? minutesSinceTs(lastAttempt.ts) : null;
  const noProgressStreak = consecutiveNoProgressRuns(runs);
  const gateExhaustionStreak = consecutiveGateExhaustedAttempts(attempts);
  const shippedToday = shippedCount(runs);
  const exploreUsed = executedRuns.filter(e => e.selection_mode === 'explore').length;
  const exploitUsed = executedRuns.filter(e => e.selection_mode === 'exploit').length;
  const exploreQuota = Math.max(1, Math.floor(Math.max(1, AUTONOMY_MAX_RUNS_PER_DAY) * clampNumber(AUTONOMY_EXPLORE_FRACTION, 0.05, 0.5)));
  const dopamine = loadDopamineSnapshot(dateStr);
  const out = {
    ts: nowIso(),
    date: dateStr,
    proposal_date: effectiveDate,
    autonomy_enabled: String(process.env.AUTONOMY_ENABLED || '') === '1',
    token_cap: budget.token_cap,
    token_used_est: budget.used_est,
    repeat_gate: {
      no_progress_streak: noProgressStreak,
      no_progress_limit: AUTONOMY_REPEAT_NO_PROGRESS_LIMIT,
      gate_exhaustion_streak: gateExhaustionStreak,
      gate_exhaustion_limit: AUTONOMY_REPEAT_EXHAUSTED_LIMIT,
      gate_exhaustion_cooldown_minutes: AUTONOMY_REPEAT_EXHAUSTED_COOLDOWN_MINUTES,
      shipped_today: shippedToday,
      attempts_today: attemptsToday,
      max_runs_per_day: AUTONOMY_MAX_RUNS_PER_DAY,
      min_minutes_between_runs: AUTONOMY_MIN_MINUTES_BETWEEN_RUNS,
      last_attempt_minutes_ago: lastAttemptMinutesAgo == null ? null : Number(lastAttemptMinutesAgo.toFixed(2)),
      max_eye_no_progress_24h: AUTONOMY_MAX_EYE_NO_PROGRESS_24H,
      explore_used: exploreUsed,
      exploit_used: exploitUsed,
      explore_quota: exploreQuota,
      dopamine
    },
    init_gate: {
      min_proposal_score: AUTONOMY_MIN_PROPOSAL_SCORE,
      skip_stub: AUTONOMY_SKIP_STUB,
      route_block_cooldown_hours: AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS,
      min_signal_quality: thresholds.min_signal_quality,
      min_sensory_signal_score: thresholds.min_sensory_signal_score,
      min_sensory_relevance_score: thresholds.min_sensory_relevance_score,
      min_directive_fit: thresholds.min_directive_fit,
      min_actionability_score: thresholds.min_actionability_score,
      min_composite_eligibility: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
      min_eye_score_ema: thresholds.min_eye_score_ema,
      max_proposal_file_age_hours: AUTONOMY_MAX_PROPOSAL_FILE_AGE_HOURS,
      disallowed_parser_types: Array.from(AUTONOMY_DISALLOWED_PARSER_TYPES),
      active_directive_ids: directiveProfile.active_directive_ids,
      directive_profile_available: directiveProfile.available === true,
      directive_profile_error: directiveProfile.error || null
    },
    calibration: {
      enabled: calibrationProfile.enabled === true,
      window_days: calibrationProfile.window_days,
      deltas: calibrationProfile.deltas,
      metrics: calibrationProfile.metrics,
      top_eye_biases: calibrationProfile.top_eye_biases || [],
      top_topic_biases: calibrationProfile.top_topic_biases || []
    },
    strategy: {
      explore_fraction: clampNumber(AUTONOMY_EXPLORE_FRACTION, 0.05, 0.5),
      explore_every_n: Math.max(1, AUTONOMY_EXPLORE_EVERY_N),
      explore_min_eligible: Math.max(2, AUTONOMY_EXPLORE_MIN_ELIGIBLE)
    },
    dod_gate: {
      allow_propose_shipped: AUTONOMY_DOD_ALLOW_PROPOSE_SHIPPED,
      min_artifact_delta: AUTONOMY_DOD_MIN_ARTIFACT_DELTA,
      min_entry_delta: AUTONOMY_DOD_MIN_ENTRY_DELTA,
      min_revenue_delta: AUTONOMY_DOD_MIN_REVENUE_DELTA,
      min_habit_outcome_score: AUTONOMY_DOD_MIN_HABIT_OUTCOME_SCORE,
      exec_window_slop_ms: AUTONOMY_DOD_EXEC_WINDOW_SLOP_MS
    },
    candidates: pool.slice(0, 5).map(x => {
      const q = assessSignalQuality(x.proposal, eyesMap, thresholds, calibrationProfile);
      const dfit = assessDirectiveFit(x.proposal, directiveProfile, thresholds);
      const act = assessActionability(x.proposal, dfit, thresholds);
      const composite = compositeEligibilityScore(q.score, dfit.score, act.score);
      return {
        id: x.proposal.id,
        title: x.proposal.title,
        status: x.status,
        score: Number(x.score.toFixed(3)),
        no_change: x.overlay?.outcomes?.no_change || 0,
        reverted: x.overlay?.outcomes?.reverted || 0,
        signal_quality_score: q.score,
        signal_quality_source: q.score_source,
        signal_quality_pass: q.pass,
        sensory_relevance_score: q.sensory_relevance_score,
        sensory_relevance_tier: q.sensory_relevance_tier,
        sensory_quality_score: q.sensory_quality_score,
        sensory_quality_tier: q.sensory_quality_tier,
        signal_quality_reasons: q.reasons.slice(0, 3),
        directive_fit_score: dfit.score,
        directive_fit_pass: dfit.pass,
        directive_fit_reasons: dfit.reasons.slice(0, 3),
        directive_fit_positive: dfit.matched_positive.slice(0, 3),
        directive_fit_negative: dfit.matched_negative.slice(0, 3),
        actionability_score: act.score,
        actionability_pass: act.pass,
        actionability_reasons: act.reasons.slice(0, 3),
        composite_eligibility_score: composite,
        composite_eligibility_pass: composite >= AUTONOMY_MIN_COMPOSITE_ELIGIBILITY
      };
    })
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function runCmd(dateStr) {
  if (String(process.env.AUTONOMY_ENABLED || '') !== '1') {
    process.stdout.write(JSON.stringify({
      ok: true,
      skipped: true,
      reason: 'AUTONOMY_ENABLED!=1',
      ts: nowIso()
    }) + '\n');
    return;
  }

  const proposalDate = latestProposalDate(dateStr);
  if (!proposalDate) {
    writeRun(dateStr, { ts: nowIso(), type: 'autonomy_run', result: 'no_proposals' });
    process.stdout.write(JSON.stringify({ ok: true, result: 'no_proposals', ts: nowIso() }) + '\n');
    return;
  }

  const proposalAgeHours = ageHours(proposalDate);
  if (AUTONOMY_MAX_PROPOSAL_FILE_AGE_HOURS > 0 && proposalAgeHours > AUTONOMY_MAX_PROPOSAL_FILE_AGE_HOURS) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_stale_signal',
      proposal_date: proposalDate,
      proposal_age_hours: Number(proposalAgeHours.toFixed(2)),
      max_proposal_file_age_hours: AUTONOMY_MAX_PROPOSAL_FILE_AGE_HOURS
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_stale_signal',
      proposal_date: proposalDate,
      proposal_age_hours: Number(proposalAgeHours.toFixed(2)),
      max_proposal_file_age_hours: AUTONOMY_MAX_PROPOSAL_FILE_AGE_HOURS,
      ts: nowIso()
    }) + '\n');
    return;
  }

  const pool = candidatePool(proposalDate);
  if (!pool.length) {
    writeRun(dateStr, { ts: nowIso(), type: 'autonomy_run', result: 'no_candidates', proposal_date: proposalDate });
    process.stdout.write(JSON.stringify({ ok: true, result: 'no_candidates', proposal_date: proposalDate, ts: nowIso() }) + '\n');
    return;
  }

  const priorRuns = runsSinceReset(readRuns(dateStr));
  const priorAttempts = attemptEvents(priorRuns);
  const attemptsToday = priorAttempts.length;
  const lastAttempt = priorAttempts.length ? priorAttempts[priorAttempts.length - 1] : null;
  const lastAttemptMinutesAgo = lastAttempt ? minutesSinceTs(lastAttempt.ts) : null;
  const noProgressStreak = consecutiveNoProgressRuns(priorRuns);
  const gateExhaustionStreak = consecutiveGateExhaustedAttempts(priorAttempts);
  const shippedToday = shippedCount(priorRuns);
  const dopamine = loadDopamineSnapshot(dateStr);
  const decisionEvents = allDecisionEvents();
  const eyesMap = loadEyesMap();
  const directiveProfile = loadDirectiveFitProfile();
  const calibrationProfile = computeCalibrationProfile(dateStr, true);
  const thresholds = calibrationProfile.effective_thresholds || baseThresholds();

  if (AUTONOMY_MAX_RUNS_PER_DAY > 0 && attemptsToday >= AUTONOMY_MAX_RUNS_PER_DAY) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_daily_cap',
      attempts_today: attemptsToday,
      max_runs_per_day: AUTONOMY_MAX_RUNS_PER_DAY
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_daily_cap',
      attempts_today: attemptsToday,
      max_runs_per_day: AUTONOMY_MAX_RUNS_PER_DAY,
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (
    AUTONOMY_MIN_MINUTES_BETWEEN_RUNS > 0
    && lastAttemptMinutesAgo != null
    && lastAttemptMinutesAgo < AUTONOMY_MIN_MINUTES_BETWEEN_RUNS
  ) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_interval',
      last_attempt_minutes_ago: Number(lastAttemptMinutesAgo.toFixed(2)),
      min_minutes_between_runs: AUTONOMY_MIN_MINUTES_BETWEEN_RUNS
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_interval',
      last_attempt_minutes_ago: Number(lastAttemptMinutesAgo.toFixed(2)),
      min_minutes_between_runs: AUTONOMY_MIN_MINUTES_BETWEEN_RUNS,
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (
    AUTONOMY_REPEAT_EXHAUSTED_LIMIT > 0
    && AUTONOMY_REPEAT_EXHAUSTED_COOLDOWN_MINUTES > 0
    && gateExhaustionStreak >= AUTONOMY_REPEAT_EXHAUSTED_LIMIT
    && lastAttemptMinutesAgo != null
    && lastAttemptMinutesAgo < AUTONOMY_REPEAT_EXHAUSTED_COOLDOWN_MINUTES
  ) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_exhaustion_cooldown',
      gate_exhaustion_streak: gateExhaustionStreak,
      gate_exhaustion_limit: AUTONOMY_REPEAT_EXHAUSTED_LIMIT,
      last_attempt_minutes_ago: Number(lastAttemptMinutesAgo.toFixed(2)),
      cooldown_minutes: AUTONOMY_REPEAT_EXHAUSTED_COOLDOWN_MINUTES
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_exhaustion_cooldown',
      gate_exhaustion_streak: gateExhaustionStreak,
      gate_exhaustion_limit: AUTONOMY_REPEAT_EXHAUSTED_LIMIT,
      last_attempt_minutes_ago: Number(lastAttemptMinutesAgo.toFixed(2)),
      cooldown_minutes: AUTONOMY_REPEAT_EXHAUSTED_COOLDOWN_MINUTES,
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (AUTONOMY_REPEAT_NO_PROGRESS_LIMIT > 0 && noProgressStreak >= AUTONOMY_REPEAT_NO_PROGRESS_LIMIT) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_no_progress',
      no_progress_streak: noProgressStreak,
      no_progress_limit: AUTONOMY_REPEAT_NO_PROGRESS_LIMIT,
      shipped_today: shippedToday
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_no_progress',
      no_progress_streak: noProgressStreak,
      no_progress_limit: AUTONOMY_REPEAT_NO_PROGRESS_LIMIT,
      shipped_today: shippedToday,
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (noProgressStreak > 0 && shippedToday === 0 && dopamine.momentum_ok !== true) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_dopamine',
      no_progress_streak: noProgressStreak,
      dopamine
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_dopamine',
      no_progress_streak: noProgressStreak,
      dopamine,
      ts: nowIso()
    }) + '\n');
    return;
  }

  let pick = null;
  let selection = { mode: 'exploit', index: 0, explore_used: 0, explore_quota: exploreQuotaForDay(), exploit_used: 0 };
  const eligible = [];
  const skipStats = { eye_no_progress: 0, low_quality: 0, low_directive_fit: 0, low_actionability: 0, low_composite: 0 };
  let sampleLowQuality = null;
  let sampleLowDirectiveFit = null;
  let sampleLowActionability = null;
  let sampleLowComposite = null;
  for (const cand of pool) {
    const q = assessSignalQuality(cand.proposal, eyesMap, thresholds, calibrationProfile);
    if (!q.pass) {
      skipStats.low_quality += 1;
      if (!sampleLowQuality) {
        sampleLowQuality = {
          proposal_id: cand.proposal.id,
          score: q.score,
          reasons: q.reasons.slice(0, 3),
          eye_id: q.eye_id
        };
      }
      continue;
    }

    const dfit = assessDirectiveFit(cand.proposal, directiveProfile, thresholds);
    if (!dfit.pass) {
      skipStats.low_directive_fit += 1;
      if (!sampleLowDirectiveFit) {
        sampleLowDirectiveFit = {
          proposal_id: cand.proposal.id,
          score: dfit.score,
          reasons: dfit.reasons.slice(0, 3),
          positive: dfit.matched_positive.slice(0, 2),
          negative: dfit.matched_negative.slice(0, 2)
        };
      }
      continue;
    }

    const actionability = assessActionability(cand.proposal, dfit, thresholds);
    if (!actionability.pass) {
      skipStats.low_actionability += 1;
      if (!sampleLowActionability) {
        sampleLowActionability = {
          proposal_id: cand.proposal.id,
          score: actionability.score,
          reasons: actionability.reasons.slice(0, 3)
        };
      }
      continue;
    }

    const compositeScore = compositeEligibilityScore(q.score, dfit.score, actionability.score);
    if (compositeScore < AUTONOMY_MIN_COMPOSITE_ELIGIBILITY) {
      skipStats.low_composite += 1;
      if (!sampleLowComposite) {
        sampleLowComposite = {
          proposal_id: cand.proposal.id,
          score: compositeScore,
          min_score: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
          quality_score: q.score,
          directive_fit_score: dfit.score,
          actionability_score: actionability.score
        };
      }
      continue;
    }

    const eyeRefCand = sourceEyeRef(cand.proposal);
    const eyeNoProgress24h = countEyeOutcomesInLastHours(decisionEvents, eyeRefCand, 'no_change', 24);
    if (AUTONOMY_MAX_EYE_NO_PROGRESS_24H > 0 && eyeNoProgress24h >= AUTONOMY_MAX_EYE_NO_PROGRESS_24H) {
      skipStats.eye_no_progress += 1;
      continue;
    }
    eligible.push({
      ...cand,
      quality: q,
      directive_fit: dfit,
      actionability,
      composite_score: compositeScore,
      eye_no_progress_24h: eyeNoProgress24h
    });
  }

  if (eligible.length > 0) {
    selection = chooseSelectionMode(eligible, priorRuns);
    pick = eligible[selection.index] || eligible[0];
  }

  if (!pick) {
    if (
      skipStats.low_quality > 0
      && skipStats.eye_no_progress === 0
      && skipStats.low_directive_fit === 0
      && skipStats.low_actionability === 0
      && skipStats.low_composite === 0
    ) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_init_gate_quality_exhausted',
        min_signal_quality: thresholds.min_signal_quality,
        skipped_low_quality: skipStats.low_quality,
        sample_low_quality: sampleLowQuality
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_init_gate_quality_exhausted',
        min_signal_quality: thresholds.min_signal_quality,
        skipped_low_quality: skipStats.low_quality,
        sample_low_quality: sampleLowQuality,
        ts: nowIso()
      }) + '\n');
      return;
    }

    if (
      skipStats.low_directive_fit > 0
      && skipStats.eye_no_progress === 0
      && skipStats.low_quality === 0
      && skipStats.low_actionability === 0
      && skipStats.low_composite === 0
    ) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_init_gate_directive_fit_exhausted',
        min_directive_fit: thresholds.min_directive_fit,
        active_directive_ids: directiveProfile.active_directive_ids,
        skipped_low_directive_fit: skipStats.low_directive_fit,
        sample_low_directive_fit: sampleLowDirectiveFit
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_init_gate_directive_fit_exhausted',
        min_directive_fit: thresholds.min_directive_fit,
        active_directive_ids: directiveProfile.active_directive_ids,
        skipped_low_directive_fit: skipStats.low_directive_fit,
        sample_low_directive_fit: sampleLowDirectiveFit,
        ts: nowIso()
      }) + '\n');
      return;
    }

    if (
      skipStats.low_actionability > 0
      && skipStats.eye_no_progress === 0
      && skipStats.low_quality === 0
      && skipStats.low_directive_fit === 0
      && skipStats.low_composite === 0
    ) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_init_gate_actionability_exhausted',
        min_actionability_score: thresholds.min_actionability_score,
        skipped_low_actionability: skipStats.low_actionability,
        sample_low_actionability: sampleLowActionability
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_init_gate_actionability_exhausted',
        min_actionability_score: thresholds.min_actionability_score,
        skipped_low_actionability: skipStats.low_actionability,
        sample_low_actionability: sampleLowActionability,
        ts: nowIso()
      }) + '\n');
      return;
    }

    if (
      skipStats.low_composite > 0
      && skipStats.eye_no_progress === 0
      && skipStats.low_quality === 0
      && skipStats.low_directive_fit === 0
      && skipStats.low_actionability === 0
    ) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_init_gate_composite_exhausted',
        min_composite_eligibility: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
        skipped_low_composite: skipStats.low_composite,
        sample_low_composite: sampleLowComposite
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_init_gate_composite_exhausted',
        min_composite_eligibility: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
        skipped_low_composite: skipStats.low_composite,
        sample_low_composite: sampleLowComposite,
        ts: nowIso()
      }) + '\n');
      return;
    }

    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_candidate_exhausted',
      reason: `all_candidates_exhausted quality_or_directive_fit_or_actionability_or_composite_or_eye_no_progress`,
      skipped_eye_no_progress: skipStats.eye_no_progress,
      skipped_low_quality: skipStats.low_quality,
      skipped_low_directive_fit: skipStats.low_directive_fit,
      skipped_low_actionability: skipStats.low_actionability,
      skipped_low_composite: skipStats.low_composite,
      sample_low_quality: sampleLowQuality,
      sample_low_directive_fit: sampleLowDirectiveFit,
      sample_low_actionability: sampleLowActionability,
      sample_low_composite: sampleLowComposite
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_candidate_exhausted',
      reason: `all_candidates_exhausted quality_or_directive_fit_or_actionability_or_composite_or_eye_no_progress`,
      skipped_eye_no_progress: skipStats.eye_no_progress,
      skipped_low_quality: skipStats.low_quality,
      skipped_low_directive_fit: skipStats.low_directive_fit,
      skipped_low_actionability: skipStats.low_actionability,
      skipped_low_composite: skipStats.low_composite,
      sample_low_quality: sampleLowQuality,
      sample_low_directive_fit: sampleLowDirectiveFit,
      sample_low_actionability: sampleLowActionability,
      sample_low_composite: sampleLowComposite,
      ts: nowIso()
    }) + '\n');
    return;
  }

  const p = pick.proposal;
  const ov = pick.overlay || { outcomes: { no_change: 0, reverted: 0 } };
  const noChangeCount = ov.outcomes?.no_change || 0;
  const revertedCount = ov.outcomes?.reverted || 0;

  if (noChangeCount >= NO_CHANGE_LIMIT) {
    const reason = `auto:autonomy no_change>=${NO_CHANGE_LIMIT} cooldown_${NO_CHANGE_COOLDOWN_HOURS}h`;
    runProposalQueue('park', p.id, reason);
    setCooldown(p.id, NO_CHANGE_COOLDOWN_HOURS, reason);
    writeRun(dateStr, { ts: nowIso(), type: 'autonomy_run', result: 'stop_no_change', proposal_id: p.id, no_change: noChangeCount });
    process.stdout.write(JSON.stringify({ ok: true, result: 'stop_no_change', proposal_id: p.id, ts: nowIso() }) + '\n');
    return;
  }

  if (revertedCount >= 1) {
    const reason = `auto:autonomy reverted>=1 cooldown_${REVERT_COOLDOWN_HOURS}h`;
    runProposalQueue('park', p.id, reason);
    setCooldown(p.id, REVERT_COOLDOWN_HOURS, reason);
    writeRun(dateStr, { ts: nowIso(), type: 'autonomy_run', result: 'stop_reverted', proposal_id: p.id, reverted: revertedCount });
    process.stdout.write(JSON.stringify({ ok: true, result: 'stop_reverted', proposal_id: p.id, ts: nowIso() }) + '\n');
    return;
  }

  if (AUTONOMY_SKIP_STUB && isStubProposal(p)) {
    const reason = `auto:init_gate stub cooldown_${AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS}h`;
    setCooldown(p.id, AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS, reason);
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'init_gate_stub',
      proposal_id: p.id,
      score: Number(pick.score.toFixed(3))
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'init_gate_stub',
      proposal_id: p.id,
      score: Number(pick.score.toFixed(3)),
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (pick.score < AUTONOMY_MIN_PROPOSAL_SCORE) {
    const reason = `auto:init_gate low_score<${AUTONOMY_MIN_PROPOSAL_SCORE} cooldown_${AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS}h`;
    setCooldown(p.id, AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS, reason);
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'init_gate_low_score',
      proposal_id: p.id,
      score: Number(pick.score.toFixed(3)),
      min_score: AUTONOMY_MIN_PROPOSAL_SCORE
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'init_gate_low_score',
      proposal_id: p.id,
      score: Number(pick.score.toFixed(3)),
      min_score: AUTONOMY_MIN_PROPOSAL_SCORE,
      ts: nowIso()
    }) + '\n');
    return;
  }

  const estTokens = estimateTokens(p);
  const budget = loadDailyBudget(dateStr);
  if ((budget.used_est + estTokens) > budget.token_cap) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'skip_budget_cap',
      proposal_id: p.id,
      used_est: budget.used_est,
      token_cap: budget.token_cap,
      est_tokens: estTokens
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'skip_budget_cap',
      proposal_id: p.id,
      used_est: budget.used_est,
      token_cap: budget.token_cap,
      est_tokens: estTokens,
      ts: nowIso()
    }) + '\n');
    return;
  }
  const eyeRef = sourceEyeRef(p);
  const eyeId = sourceEyeId(p);
  const repeats14d = Math.max(1, countEyeProposalsInWindow(eyeId, proposalDate, 14));
  const errors30d = countEyeOutcomesInWindow(decisionEvents, eyeRef, 'reverted', proposalDate, 30);
  const routeTokensEst = repeats14d >= 3 ? Math.max(estTokens, AUTONOMY_MIN_ROUTE_TOKENS) : estTokens;
  const task = makeTaskFromProposal(p);

  const preflight = runRouteExecute(task, routeTokensEst, repeats14d, errors30d, true);
  const preSummary = preflight.summary || null;
  const preBlocked = !preflight.ok
    || !preSummary
    || preSummary.executable !== true
    || preSummary.gate_decision === 'MANUAL'
    || preSummary.gate_decision === 'DENY';

  if (preBlocked) {
    const blockReason = !preflight.ok
      ? `route_exit_${preflight.code}`
      : (preSummary && preSummary.gate_decision === 'MANUAL')
        ? 'gate_manual'
        : (preSummary && preSummary.gate_decision === 'DENY')
          ? 'gate_deny'
          : 'not_executable';
    const reason = `auto:init_gate ${blockReason} cooldown_${AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS}h`;
    setCooldown(p.id, AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS, reason);
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'init_gate_blocked_route',
      proposal_id: p.id,
      proposal_date: proposalDate,
      score: Number(pick.score.toFixed(3)),
      route_summary: preSummary,
      route_code: preflight.code,
      route_block_reason: blockReason,
      repeats_14d: repeats14d,
      errors_30d: errors30d,
      dopamine
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'init_gate_blocked_route',
      proposal_id: p.id,
      route_block_reason: blockReason,
      route_summary: preSummary,
      repeats_14d: repeats14d,
      errors_30d: errors30d,
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (pick.status !== 'accepted') {
    runProposalQueue('accept', p.id, 'auto:autonomy_controller selected');
  }

  const experiment = {
    ts: nowIso(),
    type: 'experiment_card',
    proposal_id: p.id,
    proposal_date: proposalDate,
    title: p.title || '',
    hypothesis: `Executing one bounded action for ${p.id} improves measurable progress without policy violations.`,
    success_metric: 'Executable route decision with non-error exit and tracked outcome.',
    token_budget_est: estTokens,
    route_tokens_est: routeTokensEst,
    repeats_14d: repeats14d,
    errors_30d: errors30d,
    dopamine,
    signal_quality: pick.quality,
    directive_fit: pick.directive_fit,
    actionability: pick.actionability,
    composite: {
      score: pick.composite_score,
      min_score: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
      pass: pick.composite_score >= AUTONOMY_MIN_COMPOSITE_ELIGIBILITY
    },
    selection_mode: selection.mode,
    selection_index: selection.index,
    thresholds,
    calibration_metrics: calibrationProfile.metrics,
    route_preflight: preSummary,
    stop_conditions: [
      `daily_token_cap=${budget.token_cap}`,
      `no_change_limit=${NO_CHANGE_LIMIT}`,
      'reverted_count>=1',
      'gate decision DENY or MANUAL'
    ],
    task
  };
  writeExperiment(dateStr, experiment);

  const beforeEvidence = loadDoDEvidenceSnapshot(dateStr);
  const execStartMs = Date.now();
  const execRes = runRouteExecute(task, routeTokensEst, repeats14d, errors30d, false);
  const execEndMs = Date.now();
  const afterEvidence = loadDoDEvidenceSnapshot(dateStr);
  budget.used_est += estTokens;
  saveDailyBudget(budget);

  const summary = execRes.summary || {};
  const dod = evaluateDoD({
    summary,
    execRes,
    beforeEvidence,
    afterEvidence,
    execWindow: {
      start_ms: execStartMs,
      end_ms: execEndMs
    }
  });
  let outcome = 'no_change';
  let outcomeNote = `auto:autonomy dod_fail:${dod.reason}`;
  if (!execRes.ok) {
    outcome = 'reverted';
    outcomeNote = `auto:autonomy exec_failed code=${execRes.code}`;
  } else if (dod.passed === true) {
    outcome = 'shipped';
    outcomeNote = `auto:autonomy dod_pass:${dod.class}`;
  }

  const evidence = `${eyeRef} ${outcomeNote}`.slice(0, 220);
  runProposalQueue('outcome', p.id, outcome, evidence);

  writeRun(dateStr, {
    ts: nowIso(),
    type: 'autonomy_run',
    result: 'executed',
    proposal_id: p.id,
    proposal_date: proposalDate,
    score: Number(pick.score.toFixed(3)),
    est_tokens: estTokens,
    route_tokens_est: routeTokensEst,
    repeats_14d: repeats14d,
    errors_30d: errors30d,
    used_est_after: budget.used_est,
    dopamine,
    signal_quality: pick.quality,
    directive_fit: pick.directive_fit,
    actionability: pick.actionability,
    composite: {
      score: pick.composite_score,
      min_score: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
      pass: pick.composite_score >= AUTONOMY_MIN_COMPOSITE_ELIGIBILITY
    },
    selection_mode: selection.mode,
    selection_index: selection.index,
    explore_used_before: selection.explore_used,
    explore_quota: selection.explore_quota,
    thresholds,
    route_summary: summary,
    dod,
    exec_ok: execRes.ok,
    exec_code: execRes.code,
    outcome,
    evidence
  });

  process.stdout.write(JSON.stringify({
    ok: true,
    result: 'executed',
    proposal_id: p.id,
    proposal_date: proposalDate,
    est_tokens: estTokens,
    route_tokens_est: routeTokensEst,
    repeats_14d: repeats14d,
    errors_30d: errors30d,
    used_est_after: budget.used_est,
    outcome,
    signal_quality: pick.quality,
    directive_fit: pick.directive_fit,
    actionability: pick.actionability,
    composite: {
      score: pick.composite_score,
      min_score: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
      pass: pick.composite_score >= AUTONOMY_MIN_COMPOSITE_ELIGIBILITY
    },
    selection_mode: selection.mode,
    selection_index: selection.index,
    explore_used_before: selection.explore_used,
    explore_quota: selection.explore_quota,
    dod,
    route_summary: summary,
    ts: nowIso()
  }) + '\n');
}

function resetCmd(dateStr) {
  const scope = String(parseArg('scope') || 'gates').toLowerCase();
  const note = String(parseArg('note') || '').slice(0, 200);
  const allowed = new Set(['gates', 'budget', 'all']);
  if (!allowed.has(scope)) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: `invalid scope "${scope}" (expected: gates|budget|all)`,
      ts: nowIso()
    }) + '\n');
    process.exit(2);
  }

  const out = {
    ok: true,
    result: 'autonomy_reset',
    date: dateStr,
    scope,
    ts: nowIso()
  };

  if (scope === 'gates' || scope === 'all') {
    const cooldowns = getCooldowns();
    const cleared = Object.keys(cooldowns).length;
    saveJson(COOLDOWNS_PATH, {});
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_reset',
      scope: 'gates',
      cleared_cooldowns: cleared,
      note: note || null
    });
    out.cleared_cooldowns = cleared;
  }

  if (scope === 'budget' || scope === 'all') {
    const budget = loadDailyBudget(dateStr);
    const prevUsed = Number(budget.used_est || 0);
    budget.used_est = 0;
    saveDailyBudget(budget);
    out.budget = {
      token_cap: budget.token_cap,
      used_est_before: prevUsed,
      used_est_after: budget.used_est
    };
  }

  process.stdout.write(JSON.stringify(out) + '\n');
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/autonomy_controller.js run [YYYY-MM-DD]');
  console.log('  node systems/autonomy/autonomy_controller.js status [YYYY-MM-DD]');
  console.log('  node systems/autonomy/autonomy_controller.js scorecard [YYYY-MM-DD] [--days=N]');
  console.log('  node systems/autonomy/autonomy_controller.js reset [YYYY-MM-DD] [--scope=gates|budget|all] [--note=...]');
}

function main() {
  ensureState();
  const cmd = process.argv[2] || '';
  const dateStr = dateArgOrToday(process.argv[3]);

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    process.exit(0);
  }

  if (cmd === 'status') return statusCmd(dateStr);
  if (cmd === 'run') return runCmd(dateStr);
  if (cmd === 'scorecard') return scorecardCmd(dateStr);
  if (cmd === 'reset') return resetCmd(dateStr);

  usage();
  process.exit(2);
}

if (require.main === module) main();
module.exports = {
  buildOverlay,
  proposalStatus,
  proposalScore,
  estimateTokens,
  candidatePool,
  evaluateDoD,
  diffDoDEvidence
};
