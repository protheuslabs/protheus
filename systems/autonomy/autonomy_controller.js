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
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadActiveDirectives } = require('../../lib/directive_resolver.js');
const { writeContractReceipt } = require('../../lib/action_receipts.js');
const { isEmergencyStopEngaged } = require('../../lib/emergency_stop.js');
const { compactCommandOutput } = require('../../lib/command_output_compactor.js');
const {
  loadActiveStrategy,
  applyThresholdOverrides,
  effectiveAllowedRisks,
  strategyExecutionMode,
  strategyBudgetCaps,
  strategyExplorationPolicy,
  strategyRankingWeights,
  strategyAllowsProposalType,
  strategyMaxRiskPerAction,
  strategyDuplicateWindowHours,
  strategyCanaryDailyExecLimit
} = require('../../lib/strategy_resolver.js');

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
const MODEL_CATALOG_LOOP_SCRIPT = path.join(REPO_ROOT, 'systems', 'autonomy', 'model_catalog_loop.js');
const PROPOSAL_ENRICHER_SCRIPT = path.join(REPO_ROOT, 'systems', 'autonomy', 'proposal_enricher.js');
const STRATEGY_READINESS_SCRIPT = path.join(REPO_ROOT, 'systems', 'autonomy', 'strategy_readiness.js');
const ACTUATION_EXECUTOR_SCRIPT = path.join(REPO_ROOT, 'systems', 'actuation', 'actuation_executor.js');
const MODEL_CATALOG_AUDIT_PATH = process.env.AUTONOMY_MODEL_CATALOG_AUDIT_PATH
  ? path.resolve(process.env.AUTONOMY_MODEL_CATALOG_AUDIT_PATH)
  : path.join(REPO_ROOT, 'state', 'routing', 'model_catalog_audit.jsonl');
const MODEL_CATALOG_PROPOSALS_DIR = path.join(REPO_ROOT, 'state', 'routing', 'model_catalog_proposals');
const MODEL_CATALOG_TRIALS_DIR = path.join(REPO_ROOT, 'state', 'routing', 'model_catalog_trials');
const MODEL_CATALOG_CANARY_PATH = process.env.AUTONOMY_MODEL_CATALOG_CANARY_PATH
  ? path.resolve(process.env.AUTONOMY_MODEL_CATALOG_CANARY_PATH)
  : path.join(REPO_ROOT, 'state', 'routing', 'model_catalog_canary.json');
const MODEL_CATALOG_ROLLBACK_SCRIPT = process.env.AUTONOMY_MODEL_CATALOG_ROLLBACK_SCRIPT
  ? path.resolve(process.env.AUTONOMY_MODEL_CATALOG_ROLLBACK_SCRIPT)
  : path.join(REPO_ROOT, 'systems', 'autonomy', 'model_catalog_rollback.js');

const AUTONOMY_DIR = process.env.AUTONOMY_STATE_DIR
  ? path.resolve(process.env.AUTONOMY_STATE_DIR)
  : path.join(REPO_ROOT, 'state', 'autonomy');
const RUNS_DIR = process.env.AUTONOMY_RUNS_DIR
  ? path.resolve(process.env.AUTONOMY_RUNS_DIR)
  : path.join(AUTONOMY_DIR, 'runs');
const EXPERIMENTS_DIR = process.env.AUTONOMY_EXPERIMENTS_DIR
  ? path.resolve(process.env.AUTONOMY_EXPERIMENTS_DIR)
  : path.join(AUTONOMY_DIR, 'experiments');
const DAILY_BUDGET_DIR = process.env.AUTONOMY_DAILY_BUDGET_DIR
  ? path.resolve(process.env.AUTONOMY_DAILY_BUDGET_DIR)
  : path.join(AUTONOMY_DIR, 'daily_budget');
const RECEIPTS_DIR = process.env.AUTONOMY_RECEIPTS_DIR
  ? path.resolve(process.env.AUTONOMY_RECEIPTS_DIR)
  : path.join(AUTONOMY_DIR, 'receipts');
const COOLDOWNS_PATH = process.env.AUTONOMY_COOLDOWNS_PATH
  ? path.resolve(process.env.AUTONOMY_COOLDOWNS_PATH)
  : path.join(AUTONOMY_DIR, 'cooldowns.json');
const CALIBRATION_PATH = process.env.AUTONOMY_CALIBRATION_PATH
  ? path.resolve(process.env.AUTONOMY_CALIBRATION_PATH)
  : path.join(AUTONOMY_DIR, 'calibration.json');
const SHORT_CIRCUIT_PATH = process.env.AUTONOMY_SHORT_CIRCUIT_PATH
  ? path.resolve(process.env.AUTONOMY_SHORT_CIRCUIT_PATH)
  : path.join(AUTONOMY_DIR, 'short_circuit.json');

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
const AUTONOMY_UNCHANGED_SHORT_CIRCUIT_ENABLED = String(process.env.AUTONOMY_UNCHANGED_SHORT_CIRCUIT_ENABLED || '1') !== '0';
const AUTONOMY_UNCHANGED_SHORT_CIRCUIT_MINUTES = Number(process.env.AUTONOMY_UNCHANGED_SHORT_CIRCUIT_MINUTES || 30);
const AUTONOMY_MAX_EYE_NO_PROGRESS_24H = Number(process.env.AUTONOMY_MAX_EYE_NO_PROGRESS_24H || 2);
const AUTONOMY_DOD_ALLOW_PROPOSE_SHIPPED = String(process.env.AUTONOMY_DOD_ALLOW_PROPOSE_SHIPPED || '0') === '1';
const AUTONOMY_DOD_MIN_ARTIFACT_DELTA = Number(process.env.AUTONOMY_DOD_MIN_ARTIFACT_DELTA || 1);
const AUTONOMY_DOD_MIN_ENTRY_DELTA = Number(process.env.AUTONOMY_DOD_MIN_ENTRY_DELTA || 1);
const AUTONOMY_DOD_MIN_REVENUE_DELTA = Number(process.env.AUTONOMY_DOD_MIN_REVENUE_DELTA || 1);
const AUTONOMY_DOD_MIN_HABIT_OUTCOME_SCORE = Number(process.env.AUTONOMY_DOD_MIN_HABIT_OUTCOME_SCORE || 0.7);
const AUTONOMY_DOD_EXEC_WINDOW_SLOP_MS = Number(process.env.AUTONOMY_DOD_EXEC_WINDOW_SLOP_MS || 30000);
const AUTONOMY_ONLY_OPEN_PROPOSALS = String(process.env.AUTONOMY_ONLY_OPEN_PROPOSALS || '1') !== '0';
const AUTONOMY_ALLOWED_RISKS = new Set(
  String(process.env.AUTONOMY_ALLOWED_RISKS || 'low')
    .split(',')
    .map(s => String(s || '').trim().toLowerCase())
    .filter(Boolean)
);
const AUTONOMY_POSTCHECK_CONTRACT = String(process.env.AUTONOMY_POSTCHECK_CONTRACT || '1') !== '0';
const AUTONOMY_POSTCHECK_ADAPTER_TESTS = String(process.env.AUTONOMY_POSTCHECK_ADAPTER_TESTS || '1') !== '0';
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
const AUTONOMY_CALIBRATION_TIGHTEN_MIN_EXECUTED = Number(process.env.AUTONOMY_CALIBRATION_TIGHTEN_MIN_EXECUTED || 8);
const AUTONOMY_CALIBRATION_TIGHTEN_MIN_SHIPPED_RATE = Number(process.env.AUTONOMY_CALIBRATION_TIGHTEN_MIN_SHIPPED_RATE || 0.25);
const AUTONOMY_CALIBRATION_LOOSEN_LOW_SHIPPED_RATE = Number(process.env.AUTONOMY_CALIBRATION_LOOSEN_LOW_SHIPPED_RATE || 0.2);
const AUTONOMY_CALIBRATION_LOOSEN_EXHAUSTED_THRESHOLD = Number(process.env.AUTONOMY_CALIBRATION_LOOSEN_EXHAUSTED_THRESHOLD || 2);
const AUTONOMY_SCORECARD_WINDOW_DAYS = Number(process.env.AUTONOMY_SCORECARD_WINDOW_DAYS || 7);
const AUTONOMY_SCORECARD_MIN_ATTEMPTS = Number(process.env.AUTONOMY_SCORECARD_MIN_ATTEMPTS || 3);
const AUTONOMY_MODEL_CATALOG_ENABLED = String(process.env.AUTONOMY_MODEL_CATALOG_ENABLED || '1') !== '0';
const AUTONOMY_MODEL_CATALOG_INTERVAL_DAYS = Number(process.env.AUTONOMY_MODEL_CATALOG_INTERVAL_DAYS || 7);
const AUTONOMY_MODEL_CATALOG_SOURCE = String(process.env.AUTONOMY_MODEL_CATALOG_SOURCE || 'auto');
const AUTONOMY_MODEL_CATALOG_AUTO_APPLY = String(process.env.AUTONOMY_MODEL_CATALOG_AUTO_APPLY || '0') === '1';
const AUTONOMY_MODEL_CATALOG_AUTO_APPROVAL_NOTE = String(process.env.AUTONOMY_MODEL_CATALOG_AUTO_APPROVAL_NOTE || '').trim();
const AUTONOMY_MODEL_CATALOG_AUTO_BREAK_GLASS = String(process.env.AUTONOMY_MODEL_CATALOG_AUTO_BREAK_GLASS || '0') === '1';
const AUTONOMY_MODEL_CATALOG_CANARY_ENABLED = String(process.env.AUTONOMY_MODEL_CATALOG_CANARY_ENABLED || '1') !== '0';
const AUTONOMY_MODEL_CATALOG_CANARY_MIN_SAMPLES = Number(process.env.AUTONOMY_MODEL_CATALOG_CANARY_MIN_SAMPLES || 3);
const AUTONOMY_MODEL_CATALOG_CANARY_MAX_FAIL_RATE = Number(process.env.AUTONOMY_MODEL_CATALOG_CANARY_MAX_FAIL_RATE || 0.6);
const AUTONOMY_MODEL_CATALOG_CANARY_MAX_ROUTE_BLOCK_RATE = Number(process.env.AUTONOMY_MODEL_CATALOG_CANARY_MAX_ROUTE_BLOCK_RATE || 0.5);
const AUTONOMY_MODEL_CATALOG_CANARY_ROLLBACK_NOTE = String(process.env.AUTONOMY_MODEL_CATALOG_CANARY_ROLLBACK_NOTE || 'auto rollback: model catalog canary failed');
const AUTONOMY_MODEL_CATALOG_CANARY_ROLLBACK_BREAK_GLASS = String(process.env.AUTONOMY_MODEL_CATALOG_CANARY_ROLLBACK_BREAK_GLASS || '0') === '1';
const AUTONOMY_REQUIRE_READINESS_FOR_EXECUTE = String(process.env.AUTONOMY_REQUIRE_READINESS_FOR_EXECUTE || '1') !== '0';
const AUTONOMY_HARD_MAX_DAILY_RUNS_CAP = Number(process.env.AUTONOMY_HARD_MAX_DAILY_RUNS_CAP || 20);
const AUTONOMY_HARD_MAX_DAILY_TOKEN_CAP = Number(process.env.AUTONOMY_HARD_MAX_DAILY_TOKEN_CAP || 12000);
const AUTONOMY_HARD_MAX_TOKENS_PER_ACTION = Number(process.env.AUTONOMY_HARD_MAX_TOKENS_PER_ACTION || 4000);
const AUTONOMY_HARD_MAX_RISK_PER_ACTION = Number(process.env.AUTONOMY_HARD_MAX_RISK_PER_ACTION || 70);
const AUTONOMY_CANARY_DAILY_EXEC_LIMIT = Number(process.env.AUTONOMY_CANARY_DAILY_EXEC_LIMIT || 1);
const AUTONOMY_SCORE_ONLY_EVIDENCE = String(process.env.AUTONOMY_SCORE_ONLY_EVIDENCE || '1') !== '0';
const AUTONOMY_DIRECTIVE_PULSE_ENABLED = String(process.env.AUTONOMY_DIRECTIVE_PULSE_ENABLED || '1') !== '0';
const AUTONOMY_DIRECTIVE_PULSE_WINDOW_DAYS = Number(process.env.AUTONOMY_DIRECTIVE_PULSE_WINDOW_DAYS || 14);
const AUTONOMY_DIRECTIVE_PULSE_URGENCY_HOURS = Number(process.env.AUTONOMY_DIRECTIVE_PULSE_URGENCY_HOURS || 24);
const AUTONOMY_DIRECTIVE_PULSE_NO_PROGRESS_LIMIT = Number(process.env.AUTONOMY_DIRECTIVE_PULSE_NO_PROGRESS_LIMIT || 3);
const AUTONOMY_DIRECTIVE_PULSE_COOLDOWN_HOURS = Number(process.env.AUTONOMY_DIRECTIVE_PULSE_COOLDOWN_HOURS || 6);
const AUTONOMY_DIRECTIVE_PULSE_T1_MIN_SHARE = Number(process.env.AUTONOMY_DIRECTIVE_PULSE_T1_MIN_SHARE || 0.5);
const AUTONOMY_DIRECTIVE_PULSE_T2_MIN_SHARE = Number(process.env.AUTONOMY_DIRECTIVE_PULSE_T2_MIN_SHARE || 0.25);
const AUTONOMY_DIRECTIVE_PULSE_RANK_BONUS = Number(process.env.AUTONOMY_DIRECTIVE_PULSE_RANK_BONUS || 0.3);
const AUTONOMY_DIRECTIVE_PULSE_ESCALATE_AFTER = Number(process.env.AUTONOMY_DIRECTIVE_PULSE_ESCALATE_AFTER || 2);
const AUTONOMY_DIRECTIVE_PULSE_ESCALATE_WINDOW_HOURS = Number(process.env.AUTONOMY_DIRECTIVE_PULSE_ESCALATE_WINDOW_HOURS || 24);
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
const TOOL_CAPABILITY_TOKENS = [
  'web_fetch', 'web_search', 'browser', 'exec', 'read', 'write', 'edit',
  'cron', 'sessions_spawn', 'sessions_send', 'message', 'gmail', 'gog', 'bird'
];
let STRATEGY_CACHE = undefined;

function strategyProfile() {
  if (STRATEGY_CACHE !== undefined) return STRATEGY_CACHE;
  STRATEGY_CACHE = loadActiveStrategy({ allowMissing: true });
  return STRATEGY_CACHE;
}

function effectiveStrategyBudget() {
  const caps = strategyBudgetCaps(strategyProfile(), {
    daily_runs_cap: AUTONOMY_MAX_RUNS_PER_DAY,
    daily_token_cap: DAILY_TOKEN_CAP
  });
  const hardRuns = Number.isFinite(Number(AUTONOMY_HARD_MAX_DAILY_RUNS_CAP)) && Number(AUTONOMY_HARD_MAX_DAILY_RUNS_CAP) > 0
    ? Number(AUTONOMY_HARD_MAX_DAILY_RUNS_CAP)
    : null;
  const hardTokens = Number.isFinite(Number(AUTONOMY_HARD_MAX_DAILY_TOKEN_CAP)) && Number(AUTONOMY_HARD_MAX_DAILY_TOKEN_CAP) > 0
    ? Number(AUTONOMY_HARD_MAX_DAILY_TOKEN_CAP)
    : null;
  const hardPerAction = Number.isFinite(Number(AUTONOMY_HARD_MAX_TOKENS_PER_ACTION)) && Number(AUTONOMY_HARD_MAX_TOKENS_PER_ACTION) > 0
    ? Number(AUTONOMY_HARD_MAX_TOKENS_PER_ACTION)
    : null;
  const out = { ...caps };
  if (hardRuns != null && Number.isFinite(Number(out.daily_runs_cap))) {
    out.daily_runs_cap = Math.min(Number(out.daily_runs_cap), hardRuns);
  }
  if (hardTokens != null && Number.isFinite(Number(out.daily_token_cap))) {
    out.daily_token_cap = Math.min(Number(out.daily_token_cap), hardTokens);
  }
  if (hardPerAction != null && Number.isFinite(Number(out.max_tokens_per_action))) {
    out.max_tokens_per_action = Math.min(Number(out.max_tokens_per_action), hardPerAction);
  }
  return out;
}

function effectiveStrategyExecutionMode() {
  return strategyExecutionMode(strategyProfile(), 'execute');
}

function effectiveStrategyCanaryExecLimit() {
  return strategyCanaryDailyExecLimit(strategyProfile(), AUTONOMY_CANARY_DAILY_EXEC_LIMIT);
}

function effectiveStrategyExploration() {
  return strategyExplorationPolicy(strategyProfile(), {
    fraction: AUTONOMY_EXPLORE_FRACTION,
    every_n: AUTONOMY_EXPLORE_EVERY_N,
    min_eligible: AUTONOMY_EXPLORE_MIN_ELIGIBLE
  });
}

function isExecuteMode(mode) {
  return mode === 'execute' || mode === 'canary_execute';
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ensureState() {
  [AUTONOMY_DIR, RUNS_DIR, EXPERIMENTS_DIR, DAILY_BUDGET_DIR, RECEIPTS_DIR].forEach(ensureDir);
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

function loadShortCircuitState() {
  const raw = loadJson(SHORT_CIRCUIT_PATH, {});
  if (!raw || typeof raw !== 'object') return { entries: {} };
  if (!raw.entries || typeof raw.entries !== 'object') raw.entries = {};
  return raw;
}

function saveShortCircuitState(state) {
  saveJson(SHORT_CIRCUIT_PATH, state && typeof state === 'object' ? state : { entries: {} });
}

function autonomyStateFingerprint({
  dateStr,
  proposalDate,
  executionMode,
  shadowOnly,
  strategyId,
  pool,
  admission
}) {
  const sample = Array.isArray(pool)
    ? pool.slice(0, 24).map((entry) => {
        const p = entry && entry.proposal ? entry.proposal : {};
        const scoreRaw = Number(entry && entry.score);
        return {
          id: String(p.id || ''),
          type: String(p.type || ''),
          risk: normalizedRisk(p.risk),
          score: Number.isFinite(scoreRaw) ? Number(scoreRaw.toFixed(3)) : null,
          status: String(entry && entry.status || ''),
          source_eye: sourceEyeId(p),
          key: String(entry && entry.dedup_key || '')
        };
      })
    : [];
  const payload = {
    date: String(dateStr || ''),
    proposal_date: String(proposalDate || ''),
    execution_mode: String(executionMode || ''),
    shadow_only: !!shadowOnly,
    strategy_id: String(strategyId || ''),
    sample,
    admission: admission && typeof admission === 'object'
      ? {
          total: Number(admission.total || 0),
          eligible: Number(admission.eligible || 0),
          blocked: Number(admission.blocked || 0),
          blocked_by_reason: admission.blocked_by_reason || {}
        }
      : null
  };
  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}

function checkUnchangedShortCircuit(key, fingerprint, ttlMinutesRaw) {
  const ttlMinutes = Number.isFinite(Number(ttlMinutesRaw))
    ? Math.max(5, Math.min(240, Math.round(Number(ttlMinutesRaw))))
    : 30;
  const state = loadShortCircuitState();
  const prev = state.entries && state.entries[key] ? state.entries[key] : null;
  const nowMs = Date.now();
  const prevMs = prev && prev.ts ? Date.parse(String(prev.ts)) : NaN;
  const ageMinutes = Number.isFinite(prevMs) ? (nowMs - prevMs) / 60000 : null;
  const same = !!(prev && String(prev.fingerprint || '') === String(fingerprint || ''));
  const hit = same && ageMinutes != null && ageMinutes >= 0 && ageMinutes <= ttlMinutes;

  state.entries = state.entries || {};
  state.entries[key] = {
    ts: nowIso(),
    fingerprint: String(fingerprint || ''),
    ttl_minutes: ttlMinutes
  };
  saveShortCircuitState(state);

  return {
    hit,
    ttl_minutes: ttlMinutes,
    age_minutes: ageMinutes == null ? null : Number(ageMinutes.toFixed(2))
  };
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

function normalizeSpaces(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function proposalTextBlob(p) {
  const parts = [
    p && p.title,
    p && p.summary,
    p && p.suggested_next_command,
    p && p.suggested_command,
    p && p.notes
  ];
  if (p && Array.isArray(p.evidence)) {
    for (const ev of p.evidence) {
      if (!ev || typeof ev !== 'object') continue;
      parts.push(ev.evidence_ref, ev.path, ev.title);
    }
  }
  return normalizeSpaces(parts.filter(Boolean).join(' | ')).toLowerCase();
}

function detectEyesTerminologyDriftInPool(pool) {
  const warnings = [];
  const seen = new Set();
  for (const item of (pool || [])) {
    const p = item && item.proposal;
    if (!p) continue;
    const blob = proposalTextBlob(p);
    if (!/\beye\b|\beyes\b/.test(blob)) continue;

    const matchedTools = TOOL_CAPABILITY_TOKENS.filter(t => blob.includes(t));
    if (!matchedTools.length) continue;

    const key = `${p.id || 'unknown'}:${matchedTools.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    warnings.push({
      proposal_id: p.id || null,
      reason: 'tools_labeled_as_eyes',
      matched_tools: matchedTools.slice(0, 5),
      sample: normalizeSpaces(String(p.title || '')).slice(0, 140)
    });
  }
  return warnings.slice(0, 5);
}

function sourceEyeRef(p) {
  const metaEye = p && p.meta && typeof p.meta.source_eye === 'string' ? p.meta.source_eye.trim() : '';
  if (metaEye) return `eye:${metaEye}`;
  const evRef = p && Array.isArray(p.evidence) && p.evidence.length ? String((p.evidence[0] || {}).evidence_ref || '') : '';
  if (evRef.startsWith('eye:')) return evRef;
  return 'eye:unknown_eye';
}

function normalizedRisk(v) {
  const r = String(v || '').trim().toLowerCase();
  if (r === 'high' || r === 'medium' || r === 'low') return r;
  return 'low';
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
  const caps = effectiveStrategyBudget();
  const defaultCap = Number.isFinite(Number(caps.daily_token_cap)) ? Number(caps.daily_token_cap) : DAILY_TOKEN_CAP;
  const loaded = loadJson(dailyBudgetPath(dateStr), { date: dateStr, token_cap: defaultCap, used_est: 0 });
  const out = loaded && typeof loaded === 'object' ? { ...loaded } : { date: dateStr, token_cap: defaultCap, used_est: 0 };
  out.date = String(out.date || dateStr);
  out.used_est = Number.isFinite(Number(out.used_est)) ? Number(out.used_est) : 0;
  out.token_cap = defaultCap;
  return out;
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
    || evt.result === 'stop_repeat_gate_capability_cap'
    || evt.result === 'stop_repeat_gate_directive_pulse_cooldown'
    || evt.result === 'stop_repeat_gate_directive_pulse_tier_reservation'
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
    || evt.result === 'stop_repeat_gate_directive_pulse_cooldown'
    || evt.result === 'stop_repeat_gate_directive_pulse_tier_reservation'
    || evt.result === 'stop_repeat_gate_capability_cap'
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
    || evt.result === 'stop_repeat_gate_capability_cap'
    || evt.result === 'stop_repeat_gate_directive_pulse_cooldown'
    || evt.result === 'stop_repeat_gate_directive_pulse_tier_reservation'
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
  const modelCatalogRuns = events.filter(e => e && e.type === 'autonomy_model_catalog_run');
  const modelCatalogHandoffs = events.filter(e => e && e.type === 'autonomy_model_catalog_handoff');
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
    recommendation,
    model_catalog: {
      runs: modelCatalogRuns.length,
      proposals_ok: modelCatalogRuns.filter(e => e.step === 'propose' && e.result === 'ok').length,
      trials_ok: modelCatalogRuns.filter(e => e.step === 'trial' && e.result === 'ok').length,
      apply_pending: modelCatalogHandoffs.filter(e => e.result === 'apply_pending').length
    }
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

  if (decision === 'ACTUATE') {
    const verified = !!(summary && summary.verified === true);
    if (verified) {
      return {
        passed: true,
        class: 'actuation_verified',
        reason: `adapter_${String(summary.adapter || 'unknown')}_verified`,
        diff
      };
    }
    if (hasImpactSignal) {
      return {
        passed: true,
        class: 'actuation_with_impact_signal',
        reason: `adapter_${String(summary && summary.adapter || 'unknown')}_impact_signal`,
        diff
      };
    }
    return {
      passed: false,
      class: 'actuation_unverified',
      reason: `adapter_${String(summary && summary.adapter || 'unknown')}_unverified`,
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
  const base = {
    min_signal_quality: AUTONOMY_MIN_SIGNAL_QUALITY,
    min_sensory_signal_score: AUTONOMY_MIN_SENSORY_SIGNAL_SCORE,
    min_sensory_relevance_score: AUTONOMY_MIN_SENSORY_RELEVANCE_SCORE,
    min_directive_fit: AUTONOMY_MIN_DIRECTIVE_FIT,
    min_actionability_score: AUTONOMY_MIN_ACTIONABILITY_SCORE,
    min_eye_score_ema: AUTONOMY_MIN_EYE_SCORE_EMA
  };
  return applyThresholdOverrides(base, strategyProfile());
}

function effectiveAllowedRisksSet() {
  return effectiveAllowedRisks(AUTONOMY_ALLOWED_RISKS, strategyProfile());
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

function computeCalibrationDeltas(input = {}) {
  const zero = {
    min_signal_quality: 0,
    min_sensory_signal_score: 0,
    min_sensory_relevance_score: 0,
    min_directive_fit: 0,
    min_actionability_score: 0,
    min_eye_score_ema: 0
  };

  const executedCount = Number(input.executedCount || 0);
  const shippedRate = Number(input.shippedRate || 0);
  const noChangeRate = Number(input.noChangeRate || 0);
  const revertedRate = Number(input.revertedRate || 0);
  const exhausted = Number(input.exhausted || 0);
  const deltas = { ...zero };

  const tightenEligible = executedCount >= Math.max(AUTONOMY_CALIBRATION_MIN_EXECUTED, AUTONOMY_CALIBRATION_TIGHTEN_MIN_EXECUTED);
  const loosenEligible = executedCount >= AUTONOMY_CALIBRATION_MIN_EXECUTED;
  const lowShipHighExhaustion = (
    loosenEligible
    && shippedRate < AUTONOMY_CALIBRATION_LOOSEN_LOW_SHIPPED_RATE
    && exhausted >= AUTONOMY_CALIBRATION_LOOSEN_EXHAUSTED_THRESHOLD
  );

  if (lowShipHighExhaustion) {
    // If we are not shipping and repeatedly exhausting gates, loosen intake thresholds.
    deltas.min_signal_quality -= 3;
    deltas.min_directive_fit -= 3;
    deltas.min_actionability_score -= 2;
    deltas.min_sensory_relevance_score -= 1;
  } else if (tightenEligible) {
    // Tightening requires both enough volume and a non-trivial shipped baseline.
    if (noChangeRate >= 0.6 && shippedRate >= AUTONOMY_CALIBRATION_TIGHTEN_MIN_SHIPPED_RATE) {
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
  return deltas;
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

  const deltas = computeCalibrationDeltas({
    executedCount,
    shippedRate,
    noChangeRate,
    revertedRate,
    exhausted
  });

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

function normalizeDirectiveTier(rawTier, fallback = 3) {
  const n = Number(rawTier);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.round(n));
}

function directiveTierWeight(tier) {
  const t = normalizeDirectiveTier(tier, 3);
  if (t <= 1) return 1.3;
  if (t === 2) return 1.0;
  if (t === 3) return 0.82;
  return 0.7;
}

function directiveTierMinShare(tier) {
  const t = normalizeDirectiveTier(tier, 3);
  if (t <= 1) return clampNumber(Number(AUTONOMY_DIRECTIVE_PULSE_T1_MIN_SHARE || 0), 0, 1);
  if (t === 2) return clampNumber(Number(AUTONOMY_DIRECTIVE_PULSE_T2_MIN_SHARE || 0), 0, 1);
  return 0;
}

function compileDirectivePulseObjectives(directives) {
  const input = Array.isArray(directives) ? directives : [];
  const out = [];
  const seen = new Set();
  for (const d of input) {
    if (!d || typeof d !== 'object') continue;
    const data = d.data && typeof d.data === 'object' ? d.data : {};
    const metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
    const intent = data.intent && typeof data.intent === 'object' ? data.intent : {};
    const scope = data.scope && typeof data.scope === 'object' ? data.scope : {};
    const success = data.success_metrics && typeof data.success_metrics === 'object' ? data.success_metrics : {};
    const id = String(metadata.id || d.id || '').trim();
    if (!id || seen.has(id)) continue;
    if (/^T0[_-]/i.test(id) || /^T0$/i.test(id)) continue;

    const tier = normalizeDirectiveTier(
      Number.isFinite(Number(d.tier)) ? Number(d.tier) : Number(metadata.tier),
      3
    );

    const phrasesRaw = []
      .concat(asStringArray(metadata.description))
      .concat(asStringArray(intent.primary))
      .concat(asStringArray(scope.included))
      .concat(asStringArray(success.leading))
      .concat(asStringArray(success.lagging));
    const phrases = uniqSorted(
      phrasesRaw
        .map(normalizeDirectiveText)
        .filter(Boolean)
        .filter(x => x.length >= 6)
    ).slice(0, 16);

    const tokenSet = new Set();
    for (const p of phrases) {
      for (const tok of tokenizeDirectiveText(p)) tokenSet.add(tok);
    }
    const tokens = uniqSorted(Array.from(tokenSet)).slice(0, 64);

    out.push({
      id,
      tier,
      title: String(asStringArray(intent.primary)[0] || asStringArray(metadata.description)[0] || id),
      tier_weight: directiveTierWeight(tier),
      min_share: directiveTierMinShare(tier),
      phrases,
      tokens
    });
    seen.add(id);
  }
  out.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return String(a.id).localeCompare(String(b.id));
  });
  return out;
}

function loadDirectivePulseObjectives() {
  if (!AUTONOMY_DIRECTIVE_PULSE_ENABLED) {
    return {
      enabled: false,
      available: false,
      objectives: [],
      error: 'directive_pulse_disabled'
    };
  }
  let directives = [];
  try {
    directives = loadActiveDirectives({ allowMissing: true });
  } catch (err) {
    return {
      enabled: true,
      available: false,
      objectives: [],
      error: String(err && err.message ? err.message : err).slice(0, 200)
    };
  }
  const objectives = compileDirectivePulseObjectives(directives);
  return {
    enabled: true,
    available: objectives.length > 0,
    objectives,
    error: objectives.length > 0 ? null : 'no_objectives'
  };
}

function buildDirectivePulseStats(dateStr, windowDays) {
  const days = clampNumber(Number(windowDays || AUTONOMY_DIRECTIVE_PULSE_WINDOW_DAYS), 1, 60);
  const stats = new Map();
  const tierAttemptsToday = {};
  let attemptsToday = 0;
  for (const d of dateWindow(dateStr, days)) {
    const rows = readRuns(d);
    for (const evt of rows) {
      if (!evt || evt.type !== 'autonomy_run') continue;
      if (!isAttemptRunEvent(evt)) continue;
      const pulse = evt.directive_pulse && typeof evt.directive_pulse === 'object'
        ? evt.directive_pulse
        : null;
      const objectiveId = String(pulse && pulse.objective_id || '').trim();
      const tier = normalizeDirectiveTier(pulse && pulse.tier, 3);

      if (d === dateStr) {
        tierAttemptsToday[tier] = Number(tierAttemptsToday[tier] || 0) + 1;
        attemptsToday += 1;
      }

      if (!objectiveId) continue;

      const cur = stats.get(objectiveId) || {
        objective_id: objectiveId,
        tier,
        attempts: 0,
        shipped: 0,
        no_change: 0,
        reverted: 0,
        no_progress_streak: 0,
        last_attempt_ts: null,
        last_shipped_ts: null
      };
      cur.attempts += 1;
      cur.tier = tier;
      cur.last_attempt_ts = String(evt.ts || cur.last_attempt_ts || '');
      const shipped = evt.result === 'executed' && evt.outcome === 'shipped';
      if (shipped) {
        cur.shipped += 1;
        cur.last_shipped_ts = String(evt.ts || cur.last_shipped_ts || '');
        cur.no_progress_streak = 0;
      } else {
        if (evt.result === 'executed' && evt.outcome === 'no_change') cur.no_change += 1;
        if (evt.result === 'executed' && evt.outcome === 'reverted') cur.reverted += 1;
        if (isNoProgressRun(evt)) cur.no_progress_streak += 1;
      }
      stats.set(objectiveId, cur);
    }
  }
  return {
    stats,
    tier_attempts_today: tierAttemptsToday,
    attempts_today: attemptsToday
  };
}

function buildDirectivePulseContext(dateStr) {
  const cfg = loadDirectivePulseObjectives();
  const hist = buildDirectivePulseStats(dateStr, AUTONOMY_DIRECTIVE_PULSE_WINDOW_DAYS);
  return {
    enabled: cfg.enabled === true,
    available: cfg.available === true,
    objectives: Array.isArray(cfg.objectives) ? cfg.objectives : [],
    error: cfg.error || null,
    window_days: clampNumber(Number(AUTONOMY_DIRECTIVE_PULSE_WINDOW_DAYS || 14), 1, 60),
    urgency_hours: clampNumber(Number(AUTONOMY_DIRECTIVE_PULSE_URGENCY_HOURS || 24), 1, 240),
    no_progress_limit: clampNumber(Number(AUTONOMY_DIRECTIVE_PULSE_NO_PROGRESS_LIMIT || 3), 1, 12),
    cooldown_hours: clampNumber(Number(AUTONOMY_DIRECTIVE_PULSE_COOLDOWN_HOURS || 6), 1, 168),
    tier_attempts_today: hist.tier_attempts_today,
    attempts_today: hist.attempts_today,
    objective_stats: hist.stats
  };
}

function pulseObjectiveCooldownActive(stat, pulseCtx) {
  if (!stat || typeof stat !== 'object') return false;
  const streak = Number(stat.no_progress_streak || 0);
  const limit = Number(pulseCtx && pulseCtx.no_progress_limit || AUTONOMY_DIRECTIVE_PULSE_NO_PROGRESS_LIMIT);
  if (!Number.isFinite(streak) || streak < Math.max(1, limit)) return false;
  const last = parseIsoTs(stat.last_attempt_ts);
  if (!last) return false;
  const ageHours = (Date.now() - last.getTime()) / (1000 * 60 * 60);
  const cooldown = Number(pulseCtx && pulseCtx.cooldown_hours || AUTONOMY_DIRECTIVE_PULSE_COOLDOWN_HOURS);
  return ageHours < Math.max(1, cooldown);
}

function pulseTierCoverageBonus(tier, pulseCtx) {
  const minShare = directiveTierMinShare(tier);
  const attemptsToday = Number(pulseCtx && pulseCtx.attempts_today || 0);
  const byTier = pulseCtx && pulseCtx.tier_attempts_today && typeof pulseCtx.tier_attempts_today === 'object'
    ? pulseCtx.tier_attempts_today
    : {};
  const current = Number(byTier[normalizeDirectiveTier(tier, 3)] || 0);
  if (attemptsToday <= 0) {
    if (normalizeDirectiveTier(tier, 3) <= 1) return 8;
    if (normalizeDirectiveTier(tier, 3) === 2) return 4;
    return 0;
  }
  if (minShare <= 0) return 0;
  const expected = Math.ceil(attemptsToday * minShare);
  const deficit = Math.max(0, expected - current);
  return Math.min(18, deficit * 6);
}

function assessDirectivePulse(p, directiveFitScore, compositeScore, overlay, pulseCtx) {
  if (!pulseCtx || pulseCtx.enabled !== true || pulseCtx.available !== true) {
    return {
      pass: true,
      score: 0,
      objective_id: null,
      tier: null,
      reasons: ['directive_pulse_unavailable']
    };
  }

  const objectives = Array.isArray(pulseCtx.objectives) ? pulseCtx.objectives : [];
  const text = proposalDirectiveText(p);
  const tokens = tokenizeDirectiveText(text);
  const tokenSet = new Set(tokens);
  const stemSet = new Set(tokens.map(toStem));

  let best = null;
  for (const obj of objectives) {
    const phraseHits = (obj.phrases || []).filter(ph => text.includes(ph));
    const tokenHits = directiveTokenHits(tokenSet, stemSet, obj.tokens || []);
    const align = clampNumber(Math.round((phraseHits.length * 20) + (Math.min(6, tokenHits.length) * 8)), 0, 100);
    if (!best || align > best.alignment || (align === best.alignment && Number(obj.tier || 9) < Number(best.objective.tier || 9))) {
      best = {
        objective: obj,
        alignment: align,
        phrase_hits: phraseHits,
        token_hits: tokenHits
      };
    }
  }

  if (!best || best.alignment <= 0) {
    const weak = clampNumber(Math.round((Number(directiveFitScore || 0) * 0.35) + (Number(compositeScore || 0) * 0.15)), 0, 40);
    return {
      pass: true,
      score: weak,
      objective_id: null,
      tier: null,
      alignment: 0,
      urgency: 1,
      evidence_gap_multiplier: 1,
      retry_penalty: 0,
      coverage_bonus: 0,
      reasons: ['no_objective_match'],
      matched_positive: []
    };
  }

  const obj = best.objective;
  const stats = pulseCtx.objective_stats instanceof Map ? pulseCtx.objective_stats.get(obj.id) : null;
  if (pulseObjectiveCooldownActive(stats, pulseCtx)) {
    return {
      pass: false,
      score: 0,
      objective_id: obj.id,
      tier: obj.tier,
      alignment: best.alignment,
      reasons: ['objective_cooldown_active'],
      cooldown: {
        no_progress_streak: Number(stats && stats.no_progress_streak || 0),
        cooldown_hours: Number(pulseCtx.cooldown_hours || AUTONOMY_DIRECTIVE_PULSE_COOLDOWN_HOURS),
        last_attempt_ts: stats && stats.last_attempt_ts ? String(stats.last_attempt_ts) : null
      },
      matched_positive: uniqSorted([...(best.phrase_hits || []), ...(best.token_hits || [])]).slice(0, 6)
    };
  }

  const nowMs = Date.now();
  let urgency = 1.15;
  const lastAttempt = parseIsoTs(stats && stats.last_attempt_ts);
  if (lastAttempt) {
    const ageHours = (nowMs - lastAttempt.getTime()) / (1000 * 60 * 60);
    const horizon = Math.max(1, Number(pulseCtx.urgency_hours || AUTONOMY_DIRECTIVE_PULSE_URGENCY_HOURS));
    urgency = clampNumber(ageHours / horizon, 0.6, 1.8);
  }

  const attempts = Number(stats && stats.attempts || 0);
  const shipped = Number(stats && stats.shipped || 0);
  const shippedRate = attempts > 0 ? shipped / attempts : 0;
  let evidenceGapMultiplier = 1.0;
  if (attempts === 0) evidenceGapMultiplier = 1.15;
  else if (shippedRate < 0.2) evidenceGapMultiplier = 1.12;
  else if (shippedRate > 0.6) evidenceGapMultiplier = 0.95;

  const proposalNoChange = Number(overlay && overlay.outcomes && overlay.outcomes.no_change || 0);
  const proposalReverted = Number(overlay && overlay.outcomes && overlay.outcomes.reverted || 0);
  const objectiveNoProgress = Number(stats && stats.no_progress_streak || 0);
  const retryPenalty = Math.min(45, (proposalNoChange * 6) + (proposalReverted * 10) + (objectiveNoProgress * 8));
  const coverageBonus = pulseTierCoverageBonus(obj.tier, pulseCtx);

  const base = (
    (best.alignment * 0.55)
    + (clampNumber(Number(directiveFitScore || 0), 0, 100) * 0.25)
    + (clampNumber(Number(compositeScore || 0), 0, 100) * 0.2)
  );
  const weighted = (base * Number(obj.tier_weight || 1) * urgency * evidenceGapMultiplier) - retryPenalty + coverageBonus;
  const score = clampNumber(Math.round(weighted), 0, 100);

  return {
    pass: true,
    score,
    objective_id: obj.id,
    tier: obj.tier,
    alignment: best.alignment,
    urgency: Number(urgency.toFixed(3)),
    evidence_gap_multiplier: Number(evidenceGapMultiplier.toFixed(3)),
    retry_penalty: Number(retryPenalty.toFixed(3)),
    coverage_bonus: Number(coverageBonus.toFixed(3)),
    reasons: [],
    matched_positive: uniqSorted([...(best.phrase_hits || []), ...(best.token_hits || [])]).slice(0, 6)
  };
}

function directiveTierReservationNeed(eligible, pulseCtx) {
  if (!pulseCtx || pulseCtx.enabled !== true || pulseCtx.available !== true) return null;
  const candidates = Array.isArray(eligible) ? eligible : [];
  const attemptsToday = Math.max(0, Number(pulseCtx.attempts_today || 0));
  const byTier = pulseCtx.tier_attempts_today && typeof pulseCtx.tier_attempts_today === 'object'
    ? pulseCtx.tier_attempts_today
    : {};
  const tiers = [1, 2];
  for (const tier of tiers) {
    const minShare = directiveTierMinShare(tier);
    if (!(minShare > 0)) continue;
    const current = Math.max(0, Number(byTier[tier] || 0));
    const requiredAfterNext = Math.ceil((attemptsToday + 1) * minShare);
    if (current >= requiredAfterNext) continue;
    const candidateCount = candidates.filter(c => normalizeDirectiveTier(c && c.directive_pulse && c.directive_pulse.tier, 99) === tier).length;
    return {
      tier,
      min_share: Number(minShare.toFixed(3)),
      attempts_today: attemptsToday,
      current_tier_attempts: current,
      required_after_next: requiredAfterNext,
      candidate_count: candidateCount
    };
  }
  return null;
}

function recentDirectivePulseCooldownCount(dateStr, objectiveId, hours) {
  const objId = String(objectiveId || '').trim();
  if (!objId) return 0;
  const h = Math.max(1, Number(hours || AUTONOMY_DIRECTIVE_PULSE_ESCALATE_WINDOW_HOURS));
  const cutoff = Date.now() - (h * 60 * 60 * 1000);
  const days = Math.max(1, Math.ceil(h / 24) + 1);
  let count = 0;
  for (const d of dateWindow(dateStr, days)) {
    for (const evt of readRuns(d)) {
      if (!evt || evt.type !== 'autonomy_run') continue;
      if (String(evt.result || '') !== 'stop_repeat_gate_directive_pulse_cooldown') continue;
      const ts = parseIsoTs(evt.ts);
      if (!ts || ts.getTime() < cutoff) continue;
      const evtObjective = String(
        evt.objective_id
        || (evt.sample_directive_pulse_cooldown && evt.sample_directive_pulse_cooldown.objective_id)
        || ''
      ).trim();
      if (evtObjective !== objId) continue;
      count++;
    }
  }
  return count;
}

function ensureDirectivePulseEscalationProposal(dateStr, objectiveId, pulseCtx, sample) {
  const objId = String(objectiveId || '').trim();
  if (!objId) return { created: false, reason: 'missing_objective_id' };
  const proposals = loadProposalsForDate(dateStr);
  const existing = proposals.find((p) => (
    p
    && String(p.type || '') === 'directive_clarification'
    && p.meta
    && String(p.meta.directive_objective_id || '') === objId
  ));
  if (existing) {
    return { created: false, reason: 'already_exists', proposal_id: String(existing.id || '') };
  }

  const obj = pulseCtx
    && Array.isArray(pulseCtx.objectives)
    ? pulseCtx.objectives.find(o => String(o && o.id || '') === objId) || null
    : null;
  const tier = normalizeDirectiveTier(obj && obj.tier, 2);
  const titleTarget = String(obj && obj.title || objId);
  const proposalId = `PULSE-${crypto.createHash('sha256').update(`${dateStr}|${objId}|directive_clarify`).digest('hex').slice(0, 16)}`;
  const now = nowIso();
  const cooldownHours = Math.max(1, Number(pulseCtx && pulseCtx.cooldown_hours || AUTONOMY_DIRECTIVE_PULSE_COOLDOWN_HOURS));
  const noProgressLimit = Math.max(1, Number(pulseCtx && pulseCtx.no_progress_limit || AUTONOMY_DIRECTIVE_PULSE_NO_PROGRESS_LIMIT));

  const proposal = {
    id: proposalId,
    type: 'directive_clarification',
    title: `Clarify and replan directive objective: ${titleTarget}`,
    summary: `Repeated no-progress cooldowns for objective ${objId}. Clarify scope/metrics and define a bounded next experiment.`,
    expected_impact: tier <= 1 ? 'high' : 'medium',
    risk: 'low',
    validation: [
      'Define one explicit metric with target window',
      'Define one bounded next action with rollback condition',
      'Run one score-only preview and verify executable route'
    ],
    suggested_next_command: `node systems/security/directive_intake.js validate --id=${objId} --file=config/directives/${objId}.yaml`,
    evidence: [
      {
        source: 'autonomy_runs',
        path: `state/autonomy/runs/${dateStr}.jsonl`,
        match: `stop_repeat_gate_directive_pulse_cooldown objective=${objId}`,
        evidence_ref: `eye:directive_pulse/${objId}`
      }
    ],
    meta: {
      source_eye: 'directive_pulse',
      directive_objective_id: objId,
      directive_objective_tier: tier,
      directive_pulse_reason: 'repeated_no_progress_cooldown',
      cooldown_hours: cooldownHours,
      no_progress_limit: noProgressLimit,
      generated_at: now,
      topics: ['strategy', 'directive', 'autonomy', 'clarification'],
      signal_quality_score: 72,
      signal_quality_tier: 'medium',
      relevance_score: 78,
      relevance_tier: 'high'
    },
    notes: sample && sample.reasons
      ? `cooldown_reasons=${sample.reasons.join(',')}`
      : ''
  };

  const next = Array.isArray(proposals) ? proposals.slice() : [];
  next.push(proposal);
  const fp = path.join(PROPOSALS_DIR, `${dateStr}.json`);
  saveJson(fp, next);
  return { created: true, proposal_id: proposalId, objective_id: objId, date: dateStr };
}

function proposalDirectiveText(p) {
  const parts = [];
  parts.push(String((p && p.title) || ''));
  parts.push(String((p && p.type) || ''));
  parts.push(String((p && p.summary) || ''));
  parts.push(String((p && p.notes) || ''));
  parts.push(String((p && p.expected_impact) || ''));
  parts.push(String((p && p.risk) || ''));
  const meta = (p && p.meta) || {};
  parts.push(String(meta.preview || ''));
  parts.push(String(meta.url || ''));
  parts.push(String(meta.normalized_objective || ''));
  parts.push(String(meta.normalized_expected_outcome || ''));
  parts.push(String(meta.normalized_validation_metric || ''));
  if (Array.isArray(meta.normalized_hint_tokens)) parts.push(meta.normalized_hint_tokens.join(' '));
  if (Array.isArray(meta.normalized_archetypes)) parts.push(meta.normalized_archetypes.join(' '));
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

function proposalRemediationDepth(p) {
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const raw = Number(meta.remediation_depth);
  if (Number.isFinite(raw) && raw >= 0) return Math.round(raw);
  const trigger = String(meta.trigger || '').toLowerCase();
  if (trigger === 'consecutive_failures' || trigger === 'multi_eye_transport_failure') return 1;
  return 0;
}

function proposalDedupKey(p) {
  const type = String(p && p.type || 'unknown').toLowerCase();
  const eye = sourceEyeId(p);
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const remediationKind = String(meta.remediation_kind || '').toLowerCase();
  if (type.includes('remediation')) return `${type}|${eye}|${remediationKind || 'none'}`;
  return `${type}|${eye}|${String(p && p.id || 'unknown')}`;
}

function proposalRiskScore(p) {
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const explicit = Number(meta.risk_score);
  if (Number.isFinite(explicit)) return clampNumber(Math.round(explicit), 0, 100);
  const risk = normalizedRisk(p && p.risk);
  if (risk === 'high') return 90;
  if (risk === 'medium') return 60;
  return 25;
}

function recentProposalKeyCounts(dateStr, hours) {
  const out = new Map();
  const h = Number(hours || 0);
  if (!Number.isFinite(h) || h <= 0) return out;
  const cutoffMs = Date.now() - (h * 60 * 60 * 1000);
  const days = Math.max(1, Math.ceil(h / 24) + 1);
  for (const d of dateWindow(dateStr, days)) {
    const rows = readRuns(d);
    for (const evt of rows) {
      if (!evt || evt.type !== 'autonomy_run') continue;
      const key = String(evt.proposal_key || '').trim();
      if (!key) continue;
      const t = parseIsoTs(evt.ts);
      if (!t || t.getTime() < cutoffMs) continue;
      const result = String(evt.result || '');
      if (
        result !== 'executed'
        && result !== 'score_only_preview'
        && result !== 'stop_repeat_gate_circuit_breaker'
        && !isAttemptRunEvent(evt)
      ) continue;
      out.set(key, Number(out.get(key) || 0) + 1);
    }
  }
  return out;
}

function strategyAdmissionDecision(p, strategy, opts = {}) {
  const type = String(p && p.type || '').toLowerCase();
  if (!strategyAllowsProposalType(strategy, type)) {
    return { allow: false, reason: 'strategy_type_filtered' };
  }
  const strategyMax = strategyMaxRiskPerAction(strategy, null);
  const hardMax = Number.isFinite(Number(AUTONOMY_HARD_MAX_RISK_PER_ACTION)) && Number(AUTONOMY_HARD_MAX_RISK_PER_ACTION) >= 0
    ? Number(AUTONOMY_HARD_MAX_RISK_PER_ACTION)
    : null;
  let maxRisk = strategyMax;
  if (hardMax != null) {
    maxRisk = maxRisk == null ? hardMax : Math.min(maxRisk, hardMax);
  }
  if (maxRisk != null) {
    const riskScore = proposalRiskScore(p);
    if (riskScore > maxRisk) {
      return {
        allow: false,
        reason: 'strategy_risk_cap_exceeded',
        risk_score: riskScore,
        max_risk_per_action: maxRisk,
        strategy_max_risk_per_action: strategyMax,
        hard_max_risk_per_action: hardMax
      };
    }
  }
  const maxDepth = strategy
    && strategy.admission_policy
    && Number.isFinite(Number(strategy.admission_policy.max_remediation_depth))
      ? Number(strategy.admission_policy.max_remediation_depth)
      : null;
  if (Number.isFinite(maxDepth) && type.includes('remediation')) {
    const depth = proposalRemediationDepth(p);
    if (depth > maxDepth) return { allow: false, reason: 'strategy_remediation_depth_exceeded' };
  }
  const dedupKey = String(opts.dedup_key || '').trim();
  const keyCounts = opts.recent_key_counts instanceof Map ? opts.recent_key_counts : null;
  const duplicateWindowHours = strategyDuplicateWindowHours(strategy, 24);
  if (dedupKey && keyCounts) {
    const seen = Number(keyCounts.get(dedupKey) || 0);
    if (seen > 0) {
      return {
        allow: false,
        reason: 'strategy_duplicate_window',
        duplicate_window_hours: duplicateWindowHours,
        recent_count: seen
      };
    }
  }
  return { allow: true, reason: null };
}

function capabilityDescriptor(p, actuationSpec) {
  if (actuationSpec && actuationSpec.kind) {
    const kind = String(actuationSpec.kind).trim().toLowerCase();
    return {
      key: kind ? `actuation:${kind}` : 'actuation:unknown',
      aliases: ['actuation']
    };
  }
  const type = String(p && p.type || 'unknown').trim().toLowerCase() || 'unknown';
  return {
    key: `proposal:${type}`,
    aliases: ['proposal']
  };
}

function capabilityCap(strategyBudget, descriptor) {
  const caps = strategyBudget && strategyBudget.per_capability_caps && typeof strategyBudget.per_capability_caps === 'object'
    ? strategyBudget.per_capability_caps
    : {};
  const keys = [descriptor && descriptor.key ? descriptor.key : null]
    .concat(Array.isArray(descriptor && descriptor.aliases) ? descriptor.aliases : [])
    .filter(Boolean);
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(caps, k)) continue;
    const v = Number(caps[k]);
    if (Number.isFinite(v) && v >= 0) return Math.round(v);
  }
  return null;
}

function capabilityAttemptCountForDate(dateStr, descriptor) {
  const keys = new Set(
    [descriptor && descriptor.key ? descriptor.key : null]
      .concat(Array.isArray(descriptor && descriptor.aliases) ? descriptor.aliases : [])
      .filter(Boolean)
      .map(x => String(x).toLowerCase())
  );
  if (!keys.size) return 0;
  const events = readRuns(dateStr);
  let count = 0;
  for (const evt of events) {
    if (!evt || evt.type !== 'autonomy_run') continue;
    if (!isAttemptRunEvent(evt)) continue;
    const k = String(evt.capability_key || '').toLowerCase();
    if (!k) continue;
    if (keys.has(k)) count++;
  }
  return count;
}

function expectedValueScore(p) {
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const direct = Number(meta.expected_value_score);
  if (Number.isFinite(direct)) return clampNumber(Math.round(direct), 0, 100);
  const usd = Number(meta.expected_value_usd);
  if (Number.isFinite(usd) && usd > 0) {
    // Log-scale bucket: $1->$100 maps roughly 20->80, capped.
    const score = Math.log10(Math.max(1, usd)) * 30;
    return clampNumber(Math.round(score), 0, 100);
  }
  return impactWeight(p) * 20;
}

function timeToValueScore(p) {
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const hours = Number(meta.time_to_cash_hours);
  if (Number.isFinite(hours) && hours >= 0) {
    const score = 100 - (Math.min(168, hours) / 168) * 100;
    return clampNumber(Math.round(score), 0, 100);
  }
  const impact = String(p && p.expected_impact || '').toLowerCase();
  if (impact === 'high') return 40;
  if (impact === 'medium') return 55;
  return 70;
}

function strategyRankForCandidate(cand, strategy) {
  const p = cand && cand.proposal ? cand.proposal : {};
  const weights = strategyRankingWeights(strategy);
  const components = {
    composite: clampNumber(Number(cand && cand.composite_score || 0), 0, 100),
    actionability: clampNumber(Number(cand && cand.actionability && cand.actionability.score || 0), 0, 100),
    directive_fit: clampNumber(Number(cand && cand.directive_fit && cand.directive_fit.score || 0), 0, 100),
    signal_quality: clampNumber(Number(cand && cand.quality && cand.quality.score || 0), 0, 100),
    expected_value: expectedValueScore(p),
    risk_penalty: riskPenalty(p) * 50,
    time_to_value: timeToValueScore(p)
  };
  const raw = (
    Number(weights.composite || 0) * components.composite
    + Number(weights.actionability || 0) * components.actionability
    + Number(weights.directive_fit || 0) * components.directive_fit
    + Number(weights.signal_quality || 0) * components.signal_quality
    + Number(weights.expected_value || 0) * components.expected_value
    - Number(weights.risk_penalty || 0) * components.risk_penalty
    + Number(weights.time_to_value || 0) * components.time_to_value
  );
  return {
    score: Number(raw.toFixed(3)),
    components,
    weights
  };
}

function strategyCircuitCooldownHours(p, strategy) {
  const stopPolicy = strategy && strategy.stop_policy && typeof strategy.stop_policy === 'object'
    ? strategy.stop_policy
    : {};
  const breakers = stopPolicy.circuit_breakers && typeof stopPolicy.circuit_breakers === 'object'
    ? stopPolicy.circuit_breakers
    : {};
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const err = String(meta.last_error_code || meta.last_error || '').toLowerCase();
  if (!err) return 0;
  if (err.includes('429') || err.includes('rate_limit')) {
    return Number(breakers.http_429_cooldown_hours || 0);
  }
  if (/5\d\d/.test(err) || err.includes('5xx') || err.includes('server_error')) {
    return Number(breakers.http_5xx_cooldown_hours || 0);
  }
  if (err.includes('dns') || err.includes('enotfound') || err.includes('unreachable')) {
    return Number(breakers.dns_error_cooldown_hours || 0);
  }
  return 0;
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
  const env = {
    ...process.env,
    ROUTER_ENABLED: process.env.ROUTER_ENABLED || '1',
    ROUTER_REQUIRED: process.env.ROUTER_REQUIRED || '1'
  };
  const r = spawnSync('node', args, { cwd: REPO_ROOT, encoding: 'utf8', env });
  const stdout = (r.stdout || '').trim();
  const jsonLines = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('{') && line.endsWith('}'));
  const firstJson = jsonLines[0] || null;
  const parsedJson = jsonLines.map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  let summary = null;
  if (firstJson) {
    try { summary = JSON.parse(firstJson); } catch {}
  }
  const metricsLine = parsedJson.find(obj => obj && obj.type === 'route_execute_metrics' && obj.execution_metrics);
  return {
    ok: r.status === 0,
    code: r.status || 0,
    stdout,
    stderr: (r.stderr || '').trim(),
    summary,
    execution_metrics: metricsLine && metricsLine.execution_metrics && typeof metricsLine.execution_metrics === 'object'
      ? metricsLine.execution_metrics
      : null
  };
}

function isDirectiveClarificationProposal(p) {
  return String(p && p.type || '').trim().toLowerCase() === 'directive_clarification';
}

function sanitizeDirectiveObjectiveId(v) {
  const raw = String(v || '').trim();
  if (!raw) return '';
  if (!/^T[0-9]_[A-Za-z0-9_]+$/.test(raw)) return '';
  return raw;
}

function parseDirectiveFileArgFromCommand(cmd) {
  const text = String(cmd || '').trim();
  if (!text) return '';
  const m = text.match(/(?:^|\s)--file=(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const raw = String((m && (m[1] || m[2] || m[3])) || '').trim();
  if (!raw) return '';
  if (!/^config\/directives\/[A-Za-z0-9_]+\.ya?ml$/i.test(raw)) return '';
  return raw.replace(/\\/g, '/');
}

function directiveClarificationExecSpec(p) {
  if (!isDirectiveClarificationProposal(p)) return null;
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const objectiveId = sanitizeDirectiveObjectiveId(meta.directive_objective_id || '');
  let relFile = objectiveId ? `config/directives/${objectiveId}.yaml` : '';
  let source = objectiveId ? 'meta.directive_objective_id' : '';
  if (!relFile) {
    relFile = parseDirectiveFileArgFromCommand(p && p.suggested_next_command);
    if (relFile) source = 'suggested_next_command';
  }
  if (!relFile) {
    return {
      ok: false,
      reason: 'directive_clarification_missing_file'
    };
  }

  const absFile = path.resolve(REPO_ROOT, relFile);
  const directivesRoot = path.join(REPO_ROOT, 'config', 'directives') + path.sep;
  if (!absFile.startsWith(directivesRoot) || !fs.existsSync(absFile)) {
    return {
      ok: false,
      reason: 'directive_clarification_file_not_found',
      file: relFile
    };
  }

  const fileObjectiveId = path.basename(relFile).replace(/\.ya?ml$/i, '');
  return {
    ok: true,
    decision: 'DIRECTIVE_VALIDATE',
    objective_id: objectiveId || fileObjectiveId,
    file: relFile,
    source,
    args: ['validate', `--file=${relFile}`]
  };
}

function parseActuationSpec(p) {
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const actuation = meta && meta.actuation && typeof meta.actuation === 'object' ? meta.actuation : null;
  if (!actuation) return null;
  const kind = String(actuation.kind || '').trim();
  if (!kind) return null;
  const params = actuation.params && typeof actuation.params === 'object' ? actuation.params : {};
  return { kind, params };
}

function runActuationExecute(spec, dryRun = false) {
  const args = [
    ACTUATION_EXECUTOR_SCRIPT,
    'run',
    `--kind=${spec.kind}`,
    `--params=${JSON.stringify(spec.params || {})}`
  ];
  if (dryRun) args.push('--dry-run');
  const r = spawnSync('node', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  const stdout = (r.stdout || '').trim();
  const firstJson = stdout.split('\n').find(line => line.startsWith('{') && line.endsWith('}'));
  let payload = null;
  if (firstJson) {
    try { payload = JSON.parse(firstJson); } catch {}
  }
  return {
    ok: r.status === 0,
    code: r.status || 0,
    stdout,
    stderr: (r.stderr || '').trim(),
    summary: payload && payload.summary ? payload.summary : null
  };
}

function runDirectiveClarificationValidate(spec, dryRun = false) {
  if (!spec || spec.ok !== true) {
    const reason = spec && spec.reason ? String(spec.reason) : 'directive_clarification_spec_invalid';
    return {
      ok: false,
      code: 2,
      stdout: '',
      stderr: reason,
      summary: {
        decision: 'DIRECTIVE_VALIDATE',
        executable: false,
        gate_decision: 'DENY',
        reason,
        dry_run: !!dryRun
      }
    };
  }

  const script = path.join(REPO_ROOT, 'systems', 'security', 'directive_intake.js');
  const r = spawnSync('node', [script, ...spec.args], { cwd: REPO_ROOT, encoding: 'utf8' });
  const stdout = String(r.stdout || '').trim();
  const stderr = String(r.stderr || '').trim();
  let payload = null;
  if (stdout) {
    try { payload = JSON.parse(stdout); } catch {}
  }
  const payloadOk = payload && payload.ok === true;
  const ok = r.status === 0 && (payload ? payloadOk : true);

  return {
    ok,
    code: r.status || 0,
    stdout,
    stderr,
    summary: {
      decision: 'DIRECTIVE_VALIDATE',
      executable: ok,
      gate_decision: ok ? 'ALLOW' : 'DENY',
      objective_id: spec.objective_id || null,
      file: spec.file || null,
      source: spec.source || null,
      dry_run: !!dryRun,
      quality_ok: payload ? payload.ok === true : null,
      missing: Array.isArray(payload && payload.missing) ? payload.missing.slice(0, 8) : [],
      questions: Array.isArray(payload && payload.questions) ? payload.questions.slice(0, 8) : []
    }
  };
}

function runNodeScript(relPath, args = []) {
  const script = path.join(REPO_ROOT, relPath);
  const r = spawnSync('node', [script, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  return {
    ok: r.status === 0,
    code: r.status || 0,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim()
  };
}

function parseFirstJsonLine(text) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try { return JSON.parse(line); } catch {}
  }
  return null;
}

function runProposalEnricher(dateStr, dryRun = false) {
  const args = ['run', dateStr];
  if (dryRun) args.push('--dry-run');
  const r = spawnSync('node', [PROPOSAL_ENRICHER_SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  const stdout = (r.stdout || '').trim();
  return {
    ok: r.status === 0,
    code: r.status || 0,
    stdout,
    stderr: (r.stderr || '').trim(),
    payload: parseFirstJsonLine(stdout)
  };
}

function runStrategyReadiness(dateStr, strategyId, days = null) {
  const args = ['run', dateStr];
  if (strategyId) args.push(`--id=${strategyId}`);
  if (Number.isFinite(Number(days)) && Number(days) > 0) args.push(`--days=${Math.round(Number(days))}`);
  const r = spawnSync('node', [STRATEGY_READINESS_SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  const stdout = (r.stdout || '').trim();
  return {
    ok: r.status === 0,
    code: r.status || 0,
    stdout,
    stderr: (r.stderr || '').trim(),
    payload: parseFirstJsonLine(stdout)
  };
}

function runPostconditions(actuationSpec) {
  const checks = [];
  if (AUTONOMY_POSTCHECK_CONTRACT) {
    const c = runNodeScript(path.join('systems', 'spine', 'contract_check.js'));
    checks.push({
      name: 'contract_check',
      pass: !!c.ok,
      code: c.code,
      stdout: shortText(c.stdout, 160),
      stderr: shortText(c.stderr, 160)
    });
  }

  if (
    AUTONOMY_POSTCHECK_ADAPTER_TESTS
    && actuationSpec
    && String(actuationSpec.kind || '') === 'moltbook_publish'
  ) {
    const t = runNodeScript(path.join('memory', 'tools', 'tests', 'moltbook_publish_guard.test.js'));
    checks.push({
      name: 'adapter_test:moltbook_publish_guard',
      pass: !!t.ok,
      code: t.code,
      stdout: shortText(t.stdout, 160),
      stderr: shortText(t.stderr, 160)
    });
  }

  const failed = checks.filter(c => c.pass !== true).map(c => c.name);
  return {
    checks,
    failed,
    passed: failed.length === 0
  };
}

function shortText(v, max = 220) {
  const s = String(v || '');
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

function numberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeTokenUsageShape(raw, source = 'unknown') {
  if (!raw || typeof raw !== 'object') return null;
  const prompt = numberOrNull(raw.prompt_tokens != null ? raw.prompt_tokens : raw.input_tokens);
  const completion = numberOrNull(raw.completion_tokens != null ? raw.completion_tokens : raw.output_tokens);
  const totalDirect = numberOrNull(raw.total_tokens != null ? raw.total_tokens : raw.tokens_used);
  const total = totalDirect != null
    ? totalDirect
    : (prompt != null || completion != null ? Number((prompt || 0) + (completion || 0)) : null);
  if (total == null && prompt == null && completion == null) return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    source: String(source || 'unknown')
  };
}

function computeExecutionTokenUsage(summary, executionMetrics, routeTokensEst, fallbackEstTokens) {
  const routeSummary = summary && typeof summary === 'object' ? summary : {};
  const cost = routeSummary.cost_estimate && typeof routeSummary.cost_estimate === 'object'
    ? routeSummary.cost_estimate
    : {};
  const routeBudget = routeSummary.route_budget && typeof routeSummary.route_budget === 'object'
    ? routeSummary.route_budget
    : {};

  const estSelected = numberOrNull(cost.selected_model_tokens_est)
    ?? numberOrNull(routeBudget.request_tokens_est)
    ?? numberOrNull(routeTokensEst)
    ?? numberOrNull(fallbackEstTokens)
    ?? 0;

  const metricsUsage = normalizeTokenUsageShape(
    executionMetrics && executionMetrics.token_usage && typeof executionMetrics.token_usage === 'object'
      ? executionMetrics.token_usage
      : null,
    'route_execute_metrics'
  );

  const actualTotal = metricsUsage && numberOrNull(metricsUsage.total_tokens) != null
    ? Number(metricsUsage.total_tokens)
    : null;

  const effectiveTokens = actualTotal != null
    ? actualTotal
    : estSelected;

  return {
    available: actualTotal != null,
    source: actualTotal != null
      ? String(metricsUsage.source || 'route_execute_metrics')
      : 'estimated_fallback',
    actual_prompt_tokens: metricsUsage ? numberOrNull(metricsUsage.prompt_tokens) : null,
    actual_completion_tokens: metricsUsage ? numberOrNull(metricsUsage.completion_tokens) : null,
    actual_total_tokens: actualTotal,
    estimated_tokens: estSelected,
    effective_tokens: effectiveTokens
  };
}

function hashObj(v) {
  try {
    return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
  } catch {
    return null;
  }
}

function compactCmdResult(res) {
  if (!res) return null;
  const stdoutCompacted = compactCommandOutput(res.stdout || '', 'autonomy_cmd:stdout');
  const stderrCompacted = compactCommandOutput(res.stderr || '', 'autonomy_cmd:stderr');
  const stdoutView = stdoutCompacted.compacted ? stdoutCompacted.text : shortText(stdoutCompacted.text, 200);
  const stderrView = stderrCompacted.compacted ? stderrCompacted.text : shortText(stderrCompacted.text, 200);
  return {
    ok: !!res.ok,
    code: Number(res.code || 0),
    skipped: !!res.skipped,
    stdout: stdoutView,
    stderr: stderrView,
    stdout_compacted: stdoutCompacted.compacted === true,
    stdout_raw_path: stdoutCompacted.raw_path || null,
    stderr_compacted: stderrCompacted.compacted === true,
    stderr_raw_path: stderrCompacted.raw_path || null
  };
}

function verifyExecutionReceipt(execRes, dod, outcomeRes, postconditions) {
  const decision = String(execRes && execRes.summary && execRes.summary.decision || '');
  const execCheckName = decision === 'ACTUATE'
    ? 'actuation_execute_ok'
    : decision === 'DIRECTIVE_VALIDATE'
      ? 'directive_validate_ok'
      : 'route_execute_ok';
  const checks = [
    { name: execCheckName, pass: !!(execRes && execRes.ok === true) },
    { name: 'postconditions_ok', pass: !!(postconditions && postconditions.passed === true) },
    { name: 'dod_passed', pass: !!(dod && dod.passed === true) },
    { name: 'queue_outcome_logged', pass: !!(outcomeRes && outcomeRes.ok === true) }
  ];
  let outcome = 'shipped';
  if (!checks[0].pass || !checks[1].pass || !checks[3].pass) outcome = 'reverted';
  else if (!checks[2].pass) outcome = 'no_change';
  const failed = checks.filter(c => !c.pass).map(c => c.name);
  return {
    checks,
    failed,
    passed: failed.length === 0,
    outcome,
    primary_failure: failed.length ? failed[0] : null
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

function writeReceipt(dateStr, receipt) {
  const filePath = path.join(RECEIPTS_DIR, `${dateStr}.jsonl`);
  const verified =
    String(receipt && receipt.verdict || '').toLowerCase() === 'pass'
    && !!(receipt && receipt.verification && receipt.verification.passed === true);
  writeContractReceipt(filePath, receipt, { attempted: true, verified });
}

function runModelCatalogLoop(cmd, extraArgs = []) {
  const args = [MODEL_CATALOG_LOOP_SCRIPT, cmd, ...extraArgs];
  const r = spawnSync('node', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  const stdout = String(r.stdout || '').trim();
  const firstJson = stdout.split('\n').find(line => line.startsWith('{') && line.endsWith('}'));
  let payload = null;
  if (firstJson) {
    try { payload = JSON.parse(firstJson); } catch {}
  }
  return {
    ok: r.status === 0,
    code: r.status || 0,
    stdout,
    stderr: String(r.stderr || '').trim(),
    payload
  };
}

function modelCatalogCanaryThresholds() {
  return {
    min_samples: clampNumber(Math.round(AUTONOMY_MODEL_CATALOG_CANARY_MIN_SAMPLES), 1, 50),
    max_fail_rate: clampNumber(AUTONOMY_MODEL_CATALOG_CANARY_MAX_FAIL_RATE, 0, 1),
    max_route_block_rate: clampNumber(AUTONOMY_MODEL_CATALOG_CANARY_MAX_ROUTE_BLOCK_RATE, 0, 1)
  };
}

function normalizeModelIds(input, limit = 128) {
  const out = [];
  const seen = new Set();
  const arr = Array.isArray(input) ? input : [];
  for (const raw of arr) {
    const v = String(raw || '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

function readModelCatalogCanary() {
  return loadJson(MODEL_CATALOG_CANARY_PATH, null);
}

function writeModelCatalogCanary(state) {
  saveJson(MODEL_CATALOG_CANARY_PATH, state || {});
}

function startModelCatalogCanary(proposalId, applyPayload) {
  if (!AUTONOMY_MODEL_CATALOG_CANARY_ENABLED) return null;
  const models = normalizeModelIds(applyPayload && applyPayload.models);
  const thresholds = modelCatalogCanaryThresholds();
  const state = {
    version: 1,
    status: 'active',
    started_ts: nowIso(),
    proposal_id: String(proposalId || ''),
    models,
    snapshot: applyPayload && applyPayload.snapshot ? String(applyPayload.snapshot) : null,
    added_models: Number(applyPayload && applyPayload.added_models || models.length || 0),
    thresholds,
    stats: {
      samples: 0,
      failed: 0,
      route_blocked: 0,
      fail_rate: 0,
      route_block_rate: 0
    },
    rollback: null,
    completed_ts: null,
    last_eval_ts: null
  };
  writeModelCatalogCanary(state);
  appendJsonl(MODEL_CATALOG_AUDIT_PATH, {
    ts: nowIso(),
    type: 'canary_started',
    proposal_id: state.proposal_id,
    models: state.models.slice(0, 24),
    thresholds
  });
  return state;
}

function selectedModelFromRunEvent(evt) {
  const s = evt && evt.route_summary;
  if (!s || typeof s !== 'object') return null;
  const direct = String(s.selected_model || s.model || s.selectedModel || s.chosen_model || '').trim();
  return direct || null;
}

function modelCatalogCanaryRunEvents(startedTs) {
  if (!fs.existsSync(RUNS_DIR)) return [];
  const startMs = Date.parse(String(startedTs || ''));
  const startDate = String(startedTs || '').slice(0, 10);
  const files = fs.readdirSync(RUNS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();
  const out = [];
  for (const f of files) {
    const day = f.replace(/\.jsonl$/, '');
    if (startDate && day < startDate) continue;
    const rows = readJsonl(path.join(RUNS_DIR, f));
    for (const evt of rows) {
      if (!evt || evt.type !== 'autonomy_run') continue;
      if (Number.isFinite(startMs)) {
        const ts = Date.parse(String(evt.ts || ''));
        if (Number.isFinite(ts) && ts < startMs) continue;
      }
      out.push(evt);
    }
  }
  return out;
}

function executeModelCatalogRollback(state, stats) {
  const trigger = {
    samples: Number(stats.samples || 0),
    failed: Number(stats.failed || 0),
    route_blocked: Number(stats.route_blocked || 0),
    fail_rate: Number((stats.fail_rate || 0).toFixed(3)),
    route_block_rate: Number((stats.route_block_rate || 0).toFixed(3)),
    max_fail_rate: Number(stats.max_fail_rate || 0),
    max_route_block_rate: Number(stats.max_route_block_rate || 0)
  };
  const note = shortText(
    `${AUTONOMY_MODEL_CATALOG_CANARY_ROLLBACK_NOTE} proposal=${String(state && state.proposal_id || '')} fail_rate=${trigger.fail_rate}`,
    220
  );
  const args = [MODEL_CATALOG_ROLLBACK_SCRIPT, 'latest', `--approval-note=${note}`];
  if (AUTONOMY_MODEL_CATALOG_CANARY_ROLLBACK_BREAK_GLASS) args.push('--break-glass=1');
  const res = spawnSync('node', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CLEARANCE: '3' }
  });
  const ok = res.status === 0;
  const error = ok ? null : shortText(res.stderr || res.stdout || `rollback_exit_${res.status || 1}`, 220);
  appendJsonl(MODEL_CATALOG_AUDIT_PATH, {
    ts: nowIso(),
    type: ok ? 'canary_rollback_success' : 'canary_rollback_failed',
    proposal_id: String(state && state.proposal_id || ''),
    trigger,
    approval_note: note,
    break_glass: AUTONOMY_MODEL_CATALOG_CANARY_ROLLBACK_BREAK_GLASS,
    code: res.status || 0,
    error
  });
  return {
    ok,
    code: res.status || 0,
    error,
    note,
    break_glass: AUTONOMY_MODEL_CATALOG_CANARY_ROLLBACK_BREAK_GLASS,
    trigger
  };
}

function evaluateModelCatalogCanary(dateStr) {
  if (!AUTONOMY_MODEL_CATALOG_CANARY_ENABLED) return { status: 'disabled' };
  const state = readModelCatalogCanary();
  if (!state || typeof state !== 'object') return { status: 'missing' };
  if (String(state.status || '') !== 'active') return { status: String(state.status || 'inactive'), state };

  const thresholds = {
    ...modelCatalogCanaryThresholds(),
    ...(state.thresholds && typeof state.thresholds === 'object' ? state.thresholds : {})
  };
  const modelSet = new Set(normalizeModelIds(state.models));
  const events = modelCatalogCanaryRunEvents(state.started_ts);
  let samples = 0;
  let failed = 0;
  let routeBlocked = 0;

  for (const evt of events) {
    if (!evt) continue;
    if (evt.result !== 'executed' && evt.result !== 'init_gate_blocked_route') continue;
    const selected = selectedModelFromRunEvent(evt);
    if (modelSet.size > 0 && (!selected || !modelSet.has(selected))) continue;
    samples++;
    if (evt.result === 'init_gate_blocked_route') {
      failed++;
      routeBlocked++;
      continue;
    }
    const verificationKnown = evt.verification && typeof evt.verification === 'object';
    const verificationPass = verificationKnown ? evt.verification.passed === true : null;
    const execOk = evt.exec_ok === undefined ? true : evt.exec_ok === true;
    const outcome = String(evt.outcome || '');
    const runFailed = verificationPass === false || execOk !== true || outcome === 'reverted';
    if (runFailed) failed++;
  }

  const failRate = samples > 0 ? failed / samples : 0;
  const routeBlockRate = samples > 0 ? routeBlocked / samples : 0;
  state.stats = {
    samples,
    failed,
    route_blocked: routeBlocked,
    fail_rate: Number(failRate.toFixed(3)),
    route_block_rate: Number(routeBlockRate.toFixed(3))
  };
  state.last_eval_ts = nowIso();
  state.thresholds = thresholds;
  writeModelCatalogCanary(state);

  if (samples < thresholds.min_samples) {
    return { status: 'active', waiting: true, state };
  }

  const rollbackNeeded = failRate > thresholds.max_fail_rate || routeBlockRate > thresholds.max_route_block_rate;
  if (!rollbackNeeded) {
    state.status = 'passed';
    state.completed_ts = nowIso();
    writeModelCatalogCanary(state);
    appendJsonl(MODEL_CATALOG_AUDIT_PATH, {
      ts: nowIso(),
      type: 'canary_passed',
      proposal_id: String(state.proposal_id || ''),
      samples,
      fail_rate: state.stats.fail_rate,
      route_block_rate: state.stats.route_block_rate
    });
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_model_catalog_canary',
      result: 'passed',
      proposal_id: String(state.proposal_id || ''),
      samples,
      fail_rate: state.stats.fail_rate,
      route_block_rate: state.stats.route_block_rate
    });
    return { status: 'passed', state };
  }

  const rollback = executeModelCatalogRollback(state, {
    samples,
    failed,
    route_blocked: routeBlocked,
    fail_rate: failRate,
    route_block_rate: routeBlockRate,
    max_fail_rate: thresholds.max_fail_rate,
    max_route_block_rate: thresholds.max_route_block_rate
  });
  state.status = rollback.ok ? 'rolled_back' : 'rollback_failed';
  state.completed_ts = nowIso();
  state.rollback = {
    ts: nowIso(),
    ok: rollback.ok,
    code: rollback.code,
    note: rollback.note,
    break_glass: rollback.break_glass,
    error: rollback.error,
    trigger: rollback.trigger
  };
  writeModelCatalogCanary(state);
  writeRun(dateStr, {
    ts: nowIso(),
    type: 'autonomy_model_catalog_canary',
    result: rollback.ok ? 'rollback_success' : 'rollback_failed',
    proposal_id: String(state.proposal_id || ''),
    samples,
    fail_rate: state.stats.fail_rate,
    route_block_rate: state.stats.route_block_rate,
    rollback_code: rollback.code,
    rollback_error: rollback.error
  });
  return { status: state.status, state, rollback_triggered: true, rollback_ok: rollback.ok, rollback_error: rollback.error };
}

function modelCatalogStatusSnapshot() {
  const audits = readJsonl(MODEL_CATALOG_AUDIT_PATH);
  const applied = new Set(audits.filter(e => e && e.type === 'apply_success' && e.id).map(e => String(e.id)));
  const proposals = fs.existsSync(MODEL_CATALOG_PROPOSALS_DIR)
    ? fs.readdirSync(MODEL_CATALOG_PROPOSALS_DIR).filter(f => f.endsWith('.json'))
    : [];
  let pendingApply = 0;
  let latestProposalId = null;
  let latestProposalTs = null;
  for (const f of proposals) {
    const id = f.replace(/\.json$/, '');
    const trialPath = path.join(MODEL_CATALOG_TRIALS_DIR, `${id}.json`);
    const trial = loadJson(trialPath, null);
    if (!trial) continue;
    const passed = Array.isArray(trial.passed_models) ? trial.passed_models.length : 0;
    if (passed > 0 && !applied.has(id)) pendingApply++;
    if (!latestProposalId || id > latestProposalId) {
      latestProposalId = id;
      latestProposalTs = String(trial.ts || '').slice(0, 25) || null;
    }
  }
  const lastProposalEvt = [...audits].reverse().find(e => e && e.type === 'proposal_created') || null;
  return {
    enabled: AUTONOMY_MODEL_CATALOG_ENABLED,
    interval_days: AUTONOMY_MODEL_CATALOG_INTERVAL_DAYS,
    source: AUTONOMY_MODEL_CATALOG_SOURCE,
    pending_apply: pendingApply,
    last_proposal_id: lastProposalEvt ? String(lastProposalEvt.id || '') : latestProposalId,
    last_proposal_ts: lastProposalEvt ? String(lastProposalEvt.ts || '') : latestProposalTs
  };
}

function shouldRunModelCatalogLoop() {
  if (!AUTONOMY_MODEL_CATALOG_ENABLED) return { run: false, reason: 'disabled' };
  const audits = readJsonl(MODEL_CATALOG_AUDIT_PATH);
  const lastProposal = [...audits].reverse().find(e => e && e.type === 'proposal_created');
  if (!lastProposal || !lastProposal.ts) return { run: true, reason: 'no_prior_proposal' };
  const lastMs = Date.parse(String(lastProposal.ts));
  if (!Number.isFinite(lastMs)) return { run: true, reason: 'invalid_last_timestamp' };
  const ageDays = (Date.now() - lastMs) / (24 * 60 * 60 * 1000);
  if (ageDays >= AUTONOMY_MODEL_CATALOG_INTERVAL_DAYS) {
    return { run: true, reason: `interval_elapsed_${ageDays.toFixed(2)}d` };
  }
  return { run: false, reason: `interval_not_elapsed_${ageDays.toFixed(2)}d` };
}

function maybeRunModelCatalogLoop(dateStr) {
  const gate = shouldRunModelCatalogLoop();
  if (!gate.run) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_model_catalog_run',
      result: 'skipped',
      reason: gate.reason
    });
    return;
  }

  const propose = runModelCatalogLoop('propose', [`--source=${AUTONOMY_MODEL_CATALOG_SOURCE}`]);
  const proposalId = propose.payload && propose.payload.id ? String(propose.payload.id) : null;

  writeRun(dateStr, {
    ts: nowIso(),
    type: 'autonomy_model_catalog_run',
    step: 'propose',
    result: propose.ok ? 'ok' : 'failed',
    reason: gate.reason,
    proposal_id: proposalId,
    additions: propose.payload && Number(propose.payload.additions || 0),
    code: propose.code
  });

  if (!propose.ok || !proposalId) return;

  const trial = runModelCatalogLoop('trial', [`--id=${proposalId}`]);
  const passed = trial.payload ? Number(trial.payload.passed || 0) : 0;
  const failed = trial.payload ? Number(trial.payload.failed || 0) : 0;
  writeRun(dateStr, {
    ts: nowIso(),
    type: 'autonomy_model_catalog_run',
    step: 'trial',
    result: trial.ok ? 'ok' : 'failed',
    proposal_id: proposalId,
    passed_models: passed,
    failed_models: failed,
    code: trial.code
  });

  if (trial.ok && passed > 0) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_model_catalog_handoff',
      result: 'apply_pending',
      proposal_id: proposalId,
      passed_models: passed,
      required_clearance: 3,
      required_command: `node systems/autonomy/model_catalog_loop.js apply --id=${proposalId} --approval-note="<reason>"`
    });

    if (AUTONOMY_MODEL_CATALOG_AUTO_APPLY) {
      if (!AUTONOMY_MODEL_CATALOG_AUTO_APPROVAL_NOTE) {
        writeRun(dateStr, {
          ts: nowIso(),
          type: 'autonomy_model_catalog_run',
          step: 'apply',
          result: 'skipped_missing_approval_note',
          proposal_id: proposalId
        });
      } else {
        const applyArgs = [`--id=${proposalId}`, `--approval-note=${AUTONOMY_MODEL_CATALOG_AUTO_APPROVAL_NOTE}`];
        if (AUTONOMY_MODEL_CATALOG_AUTO_BREAK_GLASS) applyArgs.push('--break-glass=1');
        const apply = runModelCatalogLoop('apply', applyArgs);
        writeRun(dateStr, {
          ts: nowIso(),
          type: 'autonomy_model_catalog_run',
          step: 'apply',
          result: apply.ok ? 'ok' : 'failed',
          proposal_id: proposalId,
          code: apply.code,
          error: apply.ok ? null : shortText(apply.stderr || apply.stdout || 'apply_failed', 180)
        });
        if (apply.ok) {
          const canary = startModelCatalogCanary(proposalId, apply.payload || {});
          if (canary) {
            writeRun(dateStr, {
              ts: nowIso(),
              type: 'autonomy_model_catalog_canary',
              result: 'started',
              proposal_id: proposalId,
              models: Array.isArray(canary.models) ? canary.models.length : 0,
              min_samples: Number(canary.thresholds && canary.thresholds.min_samples || 0),
              max_fail_rate: Number(canary.thresholds && canary.thresholds.max_fail_rate || 0),
              max_route_block_rate: Number(canary.thresholds && canary.thresholds.max_route_block_rate || 0)
            });
          }
        }
      }
    }
  }
}

function candidatePool(dateStr) {
  const proposals = loadProposalsForDate(dateStr);
  const overlay = buildOverlay(allDecisionEvents());
  const strategy = strategyProfile();
  const allowedRisks = effectiveAllowedRisksSet();
  const duplicateWindowHours = strategyDuplicateWindowHours(strategy, 24);
  const recentKeyCounts = recentProposalKeyCounts(dateStr, duplicateWindowHours);
  const seenDedup = new Set();
  const pool = [];
  for (const p of proposals) {
    if (!p || !p.id) continue;
    const ov = overlay.get(p.id) || null;
    const status = proposalStatus(ov);
    if (status === 'rejected' || status === 'parked') continue;
    if (AUTONOMY_ONLY_OPEN_PROPOSALS && status !== 'pending') continue;
    const dedupKey = proposalDedupKey(p);
    const admission = strategyAdmissionDecision(p, strategy, {
      dedup_key: dedupKey,
      recent_key_counts: recentKeyCounts
    });
    if (!admission.allow) continue;
    const risk = normalizedRisk(p.risk);
    if (allowedRisks.size > 0 && !allowedRisks.has(risk)) continue;
    if (cooldownActive(p.id)) continue;
    if (seenDedup.has(dedupKey)) continue;
    seenDedup.add(dedupKey);
    pool.push({
      proposal: p,
      overlay: ov,
      status,
      score: proposalScore(p, ov, dateStr),
      dedup_key: dedupKey,
      admission
    });
  }
  pool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.proposal.id).localeCompare(String(b.proposal.id));
  });
  return pool;
}

function exploreQuotaForDay() {
  const caps = effectiveStrategyBudget();
  const exp = effectiveStrategyExploration();
  const maxRuns = Number.isFinite(Number(caps.daily_runs_cap)) ? Number(caps.daily_runs_cap) : AUTONOMY_MAX_RUNS_PER_DAY;
  const frac = clampNumber(exp.fraction, 0.05, 0.8);
  return Math.max(1, Math.floor(Math.max(1, maxRuns) * frac));
}

function chooseSelectionMode(eligible, priorRuns) {
  const executed = (priorRuns || []).filter(e => e && e.type === 'autonomy_run' && e.result === 'executed');
  const executedCount = executed.length;
  const exploreUsed = executed.filter(e => e.selection_mode === 'explore').length;
  const quota = exploreQuotaForDay();
  const exp = effectiveStrategyExploration();
  const everyN = Math.max(1, Number(exp.every_n || AUTONOMY_EXPLORE_EVERY_N));
  const minEligible = Math.max(2, Number(exp.min_eligible || AUTONOMY_EXPLORE_MIN_ELIGIBLE));

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
  const strategy = strategyProfile();
  const strategyBudget = effectiveStrategyBudget();
  const strategyExplore = effectiveStrategyExploration();
  const executionMode = effectiveStrategyExecutionMode();
  const canaryDailyExecLimit = executionMode === 'canary_execute'
    ? effectiveStrategyCanaryExecLimit()
    : null;
  const allowedRisks = effectiveAllowedRisksSet();
  const calibrationProfile = computeCalibrationProfile(dateStr, false);
  const thresholds = calibrationProfile.effective_thresholds || baseThresholds();
  const runs = runsSinceReset(readRuns(dateStr));
  const directivePulseCtx = buildDirectivePulseContext(dateStr);
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
  const maxRunsPerDay = Number.isFinite(Number(strategyBudget.daily_runs_cap))
    ? Number(strategyBudget.daily_runs_cap)
    : AUTONOMY_MAX_RUNS_PER_DAY;
  const exploreQuota = Math.max(1, Math.floor(Math.max(1, maxRunsPerDay) * clampNumber(strategyExplore.fraction, 0.05, 0.8)));
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
      executed_today: executedRuns.length,
      attempts_today: attemptsToday,
      max_runs_per_day: maxRunsPerDay,
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
      only_open_proposals: AUTONOMY_ONLY_OPEN_PROPOSALS,
      allowed_risks: Array.from(allowedRisks),
      postcheck_contract: AUTONOMY_POSTCHECK_CONTRACT,
      postcheck_adapter_tests: AUTONOMY_POSTCHECK_ADAPTER_TESTS,
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
    directive_pulse: {
      enabled: directivePulseCtx.enabled === true,
      available: directivePulseCtx.available === true,
      error: directivePulseCtx.error || null,
      window_days: directivePulseCtx.window_days,
      urgency_hours: directivePulseCtx.urgency_hours,
      no_progress_limit: directivePulseCtx.no_progress_limit,
      cooldown_hours: directivePulseCtx.cooldown_hours,
      rank_bonus: clampNumber(Number(AUTONOMY_DIRECTIVE_PULSE_RANK_BONUS || 0), 0, 1),
      objectives: directivePulseCtx.objectives.slice(0, 10).map(o => ({
        id: o.id,
        tier: o.tier,
        title: o.title,
        tier_weight: o.tier_weight,
        min_share: o.min_share
      })),
      attempts_today: Number(directivePulseCtx.attempts_today || 0),
      tier_attempts_today: directivePulseCtx.tier_attempts_today || {}
    },
    calibration: {
      enabled: calibrationProfile.enabled === true,
      window_days: calibrationProfile.window_days,
      deltas: calibrationProfile.deltas,
      metrics: calibrationProfile.metrics,
      top_eye_biases: calibrationProfile.top_eye_biases || [],
      top_topic_biases: calibrationProfile.top_topic_biases || []
    },
    strategy_profile: strategy
      ? {
          id: strategy.id,
          name: strategy.name,
          status: strategy.status,
          file: path.relative(REPO_ROOT, strategy.file).replace(/\\/g, '/'),
          execution_mode: executionMode,
          canary_daily_exec_limit: strategyCanaryDailyExecLimit(strategy, AUTONOMY_CANARY_DAILY_EXEC_LIMIT),
          allowed_risks: Array.isArray(strategy.risk_policy && strategy.risk_policy.allowed_risks)
            ? strategy.risk_policy.allowed_risks
            : [],
          threshold_overrides: strategy.threshold_overrides || {},
          validation: strategy.validation || { strict_ok: true, errors: [], warnings: [] }
        }
      : null,
    strategy: {
      execution_mode: executionMode,
      require_readiness_for_execute: AUTONOMY_REQUIRE_READINESS_FOR_EXECUTE,
      canary_daily_exec_limit: canaryDailyExecLimit,
      daily_runs_cap: maxRunsPerDay,
      daily_token_cap: budget.token_cap,
      max_tokens_per_action: Number.isFinite(Number(strategyBudget.max_tokens_per_action))
        ? Number(strategyBudget.max_tokens_per_action)
        : null,
      per_capability_caps: strategyBudget && strategyBudget.per_capability_caps
        ? strategyBudget.per_capability_caps
        : {},
      explore_fraction: clampNumber(strategyExplore.fraction, 0.05, 0.8),
      explore_every_n: Math.max(1, Number(strategyExplore.every_n || AUTONOMY_EXPLORE_EVERY_N)),
      explore_min_eligible: Math.max(2, Number(strategyExplore.min_eligible || AUTONOMY_EXPLORE_MIN_ELIGIBLE))
    },
    dod_gate: {
      allow_propose_shipped: AUTONOMY_DOD_ALLOW_PROPOSE_SHIPPED,
      min_artifact_delta: AUTONOMY_DOD_MIN_ARTIFACT_DELTA,
      min_entry_delta: AUTONOMY_DOD_MIN_ENTRY_DELTA,
      min_revenue_delta: AUTONOMY_DOD_MIN_REVENUE_DELTA,
      min_habit_outcome_score: AUTONOMY_DOD_MIN_HABIT_OUTCOME_SCORE,
      exec_window_slop_ms: AUTONOMY_DOD_EXEC_WINDOW_SLOP_MS
    },
    terminology_guard: {
      eyes_definition: 'passive_signal_sources_only',
      tools_are_not_eyes: true,
      warnings: detectEyesTerminologyDriftInPool(pool)
    },
    model_catalog: modelCatalogStatusSnapshot(),
    candidates: pool.slice(0, 5).map(x => {
      const q = assessSignalQuality(x.proposal, eyesMap, thresholds, calibrationProfile);
      const dfit = assessDirectiveFit(x.proposal, directiveProfile, thresholds);
      const act = assessActionability(x.proposal, dfit, thresholds);
      const composite = compositeEligibilityScore(q.score, dfit.score, act.score);
      const pulse = assessDirectivePulse(x.proposal, dfit.score, composite, x.overlay, directivePulseCtx);
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
        composite_eligibility_pass: composite >= AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
        directive_pulse: {
          pass: pulse.pass,
          score: pulse.score,
          objective_id: pulse.objective_id || null,
          tier: pulse.tier == null ? null : pulse.tier,
          reasons: Array.isArray(pulse.reasons) ? pulse.reasons.slice(0, 3) : []
        }
      };
    })
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function runCmd(dateStr, opts = {}) {
  const shadowOnly = opts && opts.shadowOnly === true;
  if (!shadowOnly && String(process.env.AUTONOMY_ENABLED || '') !== '1') {
    process.stdout.write(JSON.stringify({
      ok: true,
      skipped: true,
      reason: 'AUTONOMY_ENABLED!=1',
      ts: nowIso()
    }) + '\n');
    return;
  }

  const emergency = isEmergencyStopEngaged('autonomy');
  if (emergency.engaged) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_emergency_stop',
      scope: 'autonomy',
      stop_state: emergency.state || null
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_emergency_stop',
      scope: 'autonomy',
      stop_state: emergency.state || null,
      ts: nowIso()
    }) + '\n');
    return;
  }

  const strategy = strategyProfile();
  const strategyBudget = effectiveStrategyBudget();
  const executionMode = shadowOnly ? 'score_only' : effectiveStrategyExecutionMode();
  if (
    String(process.env.AUTONOMY_STRATEGY_STRICT || '') === '1'
    && strategy
    && strategy.validation
    && strategy.validation.strict_ok === false
  ) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_init_gate_strategy_invalid',
      strategy_id: strategy.id,
      errors: strategy.validation.errors || []
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_init_gate_strategy_invalid',
      strategy_id: strategy.id,
      errors: strategy.validation.errors || [],
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (
    AUTONOMY_REQUIRE_READINESS_FOR_EXECUTE
    && strategy
    && isExecuteMode(executionMode)
  ) {
    const minDays = strategy
      && strategy.promotion_policy
      && Number.isFinite(Number(strategy.promotion_policy.min_days))
        ? Number(strategy.promotion_policy.min_days)
        : null;
    const readiness = runStrategyReadiness(dateStr, strategy.id, minDays);
    const readinessPayload = readiness.payload && typeof readiness.payload === 'object' ? readiness.payload : null;
    const ready = !!(readiness.ok && readinessPayload && readinessPayload.ok === true && readinessPayload.readiness && readinessPayload.readiness.ready_for_execute === true);
    if (!ready) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_init_gate_readiness',
        strategy_id: strategy.id,
        execution_mode: executionMode,
        readiness_code: readiness.code,
        readiness: readinessPayload && readinessPayload.readiness ? readinessPayload.readiness : null,
        readiness_error: !readiness.ok ? shortText(readiness.stderr || readiness.stdout || `readiness_exit_${readiness.code}`, 180) : null
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_init_gate_readiness',
        strategy_id: strategy.id,
        execution_mode: executionMode,
        readiness: readinessPayload && readinessPayload.readiness ? readinessPayload.readiness : null,
        ts: nowIso()
      }) + '\n');
      return;
    }
  }

  if (!shadowOnly) {
    maybeRunModelCatalogLoop(dateStr);
  }
  const modelCatalogSnapshot = modelCatalogStatusSnapshot();
  process.stderr.write(`AUTONOMY_SUMMARY model_catalog_apply_pending=${Number(modelCatalogSnapshot.pending_apply || 0)}\n`);
  if (!shadowOnly) {
    const modelCatalogCanary = evaluateModelCatalogCanary(dateStr);
    if (modelCatalogCanary && modelCatalogCanary.rollback_triggered) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_init_gate_model_catalog_rollback',
        rollback_ok: modelCatalogCanary.rollback_ok === true,
        rollback_error: modelCatalogCanary.rollback_error || null
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_init_gate_model_catalog_rollback',
        rollback_ok: modelCatalogCanary.rollback_ok === true,
        rollback_error: modelCatalogCanary.rollback_error || null,
        ts: nowIso()
      }) + '\n');
      return;
    }
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

  const enrichRes = runProposalEnricher(proposalDate, false);
  const enrichPayload = enrichRes.payload && typeof enrichRes.payload === 'object' ? enrichRes.payload : null;
  if (!enrichRes.ok || !enrichPayload || enrichPayload.ok !== true) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'init_gate_enricher_failed',
      proposal_date: proposalDate,
      enricher_code: enrichRes.code,
      enricher_stdout: shortText(enrichRes.stdout || '', 180),
      enricher_stderr: shortText(enrichRes.stderr || '', 180)
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'init_gate_enricher_failed',
      proposal_date: proposalDate,
      enricher_code: enrichRes.code,
      ts: nowIso()
    }) + '\n');
    return;
  }
  const admissionSummary = enrichPayload.admission && typeof enrichPayload.admission === 'object'
    ? enrichPayload.admission
    : { total: 0, eligible: 0, blocked: 0, blocked_by_reason: {} };

  const pool = candidatePool(proposalDate);
  if (!pool.length) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'no_candidates',
      proposal_date: proposalDate,
      admission: admissionSummary
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'no_candidates',
      proposal_date: proposalDate,
      admission: admissionSummary,
      ts: nowIso()
    }) + '\n');
    return;
  }
  const terminologyWarnings = detectEyesTerminologyDriftInPool(pool);
  if (terminologyWarnings.length) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_terminology_warning',
      reason: 'tools_labeled_as_eyes',
      warnings: terminologyWarnings
    });
  }

  if (AUTONOMY_UNCHANGED_SHORT_CIRCUIT_ENABLED) {
    const shortCircuitKey = `${shadowOnly ? 'evidence' : 'run'}:${dateStr}`;
    const fingerprint = autonomyStateFingerprint({
      dateStr,
      proposalDate,
      executionMode,
      shadowOnly,
      strategyId: strategy ? strategy.id : null,
      pool,
      admission: admissionSummary
    });
    const shortCircuit = checkUnchangedShortCircuit(
      shortCircuitKey,
      fingerprint,
      AUTONOMY_UNCHANGED_SHORT_CIRCUIT_MINUTES
    );
    if (shortCircuit.hit) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_repeat_gate_unchanged_state',
        key: shortCircuitKey,
        fingerprint,
        ttl_minutes: shortCircuit.ttl_minutes,
        age_minutes: shortCircuit.age_minutes
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_repeat_gate_unchanged_state',
        key: shortCircuitKey,
        ttl_minutes: shortCircuit.ttl_minutes,
        age_minutes: shortCircuit.age_minutes,
        ts: nowIso()
      }) + '\n');
      return;
    }
  }

  const priorRuns = runsSinceReset(readRuns(dateStr));
  const priorAttempts = attemptEvents(priorRuns);
  const attemptsToday = priorAttempts.length;
  const executedToday = priorRuns.filter(e => e && e.type === 'autonomy_run' && e.result === 'executed').length;
  const lastAttempt = priorAttempts.length ? priorAttempts[priorAttempts.length - 1] : null;
  const lastAttemptMinutesAgo = lastAttempt ? minutesSinceTs(lastAttempt.ts) : null;
  const noProgressStreak = consecutiveNoProgressRuns(priorRuns);
  const gateExhaustionStreak = consecutiveGateExhaustedAttempts(priorAttempts);
  const shippedToday = shippedCount(priorRuns);
  const maxRunsPerDay = Number.isFinite(Number(strategyBudget.daily_runs_cap))
    ? Number(strategyBudget.daily_runs_cap)
    : AUTONOMY_MAX_RUNS_PER_DAY;
  const canaryDailyExecLimit = executionMode === 'canary_execute'
    ? effectiveStrategyCanaryExecLimit()
    : null;
  const dopamine = loadDopamineSnapshot(dateStr);
  const decisionEvents = allDecisionEvents();
  const eyesMap = loadEyesMap();
  const directiveProfile = loadDirectiveFitProfile();
  const calibrationProfile = computeCalibrationProfile(dateStr, true);
  const thresholds = calibrationProfile.effective_thresholds || baseThresholds();
  const directivePulseCtx = buildDirectivePulseContext(dateStr);

  if (!shadowOnly && maxRunsPerDay > 0 && attemptsToday >= maxRunsPerDay) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_daily_cap',
      attempts_today: attemptsToday,
      max_runs_per_day: maxRunsPerDay
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_daily_cap',
      attempts_today: attemptsToday,
      max_runs_per_day: maxRunsPerDay,
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (
    !shadowOnly
    && executionMode === 'canary_execute'
    && Number.isFinite(Number(canaryDailyExecLimit))
    && Number(canaryDailyExecLimit) > 0
    && executedToday >= Number(canaryDailyExecLimit)
  ) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_canary_cap',
      execution_mode: executionMode,
      executed_today: executedToday,
      canary_daily_exec_limit: Number(canaryDailyExecLimit)
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_canary_cap',
      execution_mode: executionMode,
      executed_today: executedToday,
      canary_daily_exec_limit: Number(canaryDailyExecLimit),
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (
    !shadowOnly
    &&
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
    !shadowOnly
    &&
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

  if (!shadowOnly && AUTONOMY_REPEAT_NO_PROGRESS_LIMIT > 0 && noProgressStreak >= AUTONOMY_REPEAT_NO_PROGRESS_LIMIT) {
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

  if (!shadowOnly && noProgressStreak > 0 && shippedToday === 0 && dopamine.momentum_ok !== true) {
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
  const skipStats = { eye_no_progress: 0, low_quality: 0, low_directive_fit: 0, low_actionability: 0, low_composite: 0, directive_pulse_cooldown: 0 };
  let sampleLowQuality = null;
  let sampleLowDirectiveFit = null;
  let sampleLowActionability = null;
  let sampleLowComposite = null;
  let sampleDirectivePulseCooldown = null;
  let tierReservation = null;
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

    const pulse = assessDirectivePulse(cand.proposal, dfit.score, compositeScore, cand.overlay, directivePulseCtx);
    if (!pulse.pass) {
      skipStats.directive_pulse_cooldown += 1;
      if (!sampleDirectivePulseCooldown) {
        sampleDirectivePulseCooldown = {
          proposal_id: cand.proposal.id,
          objective_id: pulse.objective_id || null,
          tier: pulse.tier == null ? null : pulse.tier,
          reasons: Array.isArray(pulse.reasons) ? pulse.reasons.slice(0, 3) : []
        };
      }
      continue;
    }

    eligible.push({
      ...cand,
      quality: q,
      directive_fit: dfit,
      actionability,
      composite_score: compositeScore,
      eye_no_progress_24h: eyeNoProgress24h,
      directive_pulse: pulse
    });
  }

  tierReservation = directiveTierReservationNeed(eligible, directivePulseCtx);
  if (tierReservation && Number(tierReservation.candidate_count || 0) === 0) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_directive_pulse_tier_reservation',
      reserved_tier: tierReservation.tier,
      current_tier_attempts: tierReservation.current_tier_attempts,
      required_after_next: tierReservation.required_after_next,
      attempts_today: tierReservation.attempts_today,
      min_share: tierReservation.min_share
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_directive_pulse_tier_reservation',
      reserved_tier: tierReservation.tier,
      current_tier_attempts: tierReservation.current_tier_attempts,
      required_after_next: tierReservation.required_after_next,
      attempts_today: tierReservation.attempts_today,
      min_share: tierReservation.min_share,
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (eligible.length > 0) {
    for (const cand of eligible) {
      cand.strategy_rank = strategyRankForCandidate(cand, strategy);
      cand.strategy_rank_adjusted = Number((
        Number(cand.strategy_rank && cand.strategy_rank.score || 0)
        + (clampNumber(Number(AUTONOMY_DIRECTIVE_PULSE_RANK_BONUS || 0), 0, 1) * Number(cand.directive_pulse && cand.directive_pulse.score || 0))
      ).toFixed(3));
    }
    eligible.sort((a, b) => {
      const sa = Number(a.strategy_rank_adjusted != null ? a.strategy_rank_adjusted : (a.strategy_rank && a.strategy_rank.score || 0));
      const sb = Number(b.strategy_rank_adjusted != null ? b.strategy_rank_adjusted : (b.strategy_rank && b.strategy_rank.score || 0));
      if (sb !== sa) return sb - sa;
      if (b.score !== a.score) return b.score - a.score;
      return String(a.proposal.id).localeCompare(String(b.proposal.id));
    });
    if (tierReservation && Number(tierReservation.candidate_count || 0) > 0) {
      const reservedTier = Number(tierReservation.tier);
      const reservedIdx = eligible.findIndex(c => normalizeDirectiveTier(c && c.directive_pulse && c.directive_pulse.tier, 99) === reservedTier);
      const idx = reservedIdx >= 0 ? reservedIdx : 0;
      pick = eligible[idx] || eligible[0];
      selection = {
        mode: 'directive_reservation',
        index: idx,
        explore_used: 0,
        explore_quota: 0,
        exploit_used: 0,
        reserved_tier: reservedTier,
        reservation: tierReservation
      };
    } else {
      selection = chooseSelectionMode(eligible, priorRuns);
      pick = eligible[selection.index] || eligible[0];
    }
  }

  if (!pick && shadowOnly && pool.length > 0) {
    const fallback = pool[0];
    const q = assessSignalQuality(fallback.proposal, eyesMap, thresholds, calibrationProfile);
    const dfit = assessDirectiveFit(fallback.proposal, directiveProfile, thresholds);
    const actionability = assessActionability(fallback.proposal, dfit, thresholds);
    const compositeScore = compositeEligibilityScore(q.score, dfit.score, actionability.score);
    const pulse = assessDirectivePulse(fallback.proposal, dfit.score, compositeScore, fallback.overlay, directivePulseCtx);
    pick = {
      ...fallback,
      quality: q,
      directive_fit: dfit,
      actionability,
      composite_score: compositeScore,
      eye_no_progress_24h: countEyeOutcomesInLastHours(decisionEvents, sourceEyeRef(fallback.proposal), 'no_change', 24),
      directive_pulse: pulse,
      strategy_rank: strategyRankForCandidate({
        ...fallback,
        quality: q,
        directive_fit: dfit,
        actionability,
        composite_score: compositeScore
      }, strategy),
      strategy_rank_adjusted: Number((
        Number(strategyRankForCandidate({
          ...fallback,
          quality: q,
          directive_fit: dfit,
          actionability,
          composite_score: compositeScore
        }, strategy).score || 0)
        + (clampNumber(Number(AUTONOMY_DIRECTIVE_PULSE_RANK_BONUS || 0), 0, 1) * Number(pulse.score || 0))
      ).toFixed(3))
    };
    selection = {
      mode: 'shadow_fallback',
      index: 0,
      explore_used: 0,
      explore_quota: 0,
      exploit_used: 0
    };
  }

  if (!pick) {
    if (
      skipStats.directive_pulse_cooldown > 0
      && skipStats.eye_no_progress === 0
      && skipStats.low_quality === 0
      && skipStats.low_directive_fit === 0
      && skipStats.low_actionability === 0
      && skipStats.low_composite === 0
    ) {
      const objectiveId = String(
        sampleDirectivePulseCooldown && sampleDirectivePulseCooldown.objective_id
          ? sampleDirectivePulseCooldown.objective_id
          : ''
      ).trim();
      const priorCooldownHits = objectiveId
        ? recentDirectivePulseCooldownCount(dateStr, objectiveId, AUTONOMY_DIRECTIVE_PULSE_ESCALATE_WINDOW_HOURS)
        : 0;
      const cooldownHitsWindow = priorCooldownHits + 1;
      const escalateAfter = Math.max(1, Number(AUTONOMY_DIRECTIVE_PULSE_ESCALATE_AFTER || 2));
      const shouldEscalate = !!objectiveId && cooldownHitsWindow >= escalateAfter;
      const escalation = shouldEscalate
        ? ensureDirectivePulseEscalationProposal(proposalDate, objectiveId, directivePulseCtx, sampleDirectivePulseCooldown)
        : { created: false, reason: 'below_escalation_threshold' };

      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_repeat_gate_directive_pulse_cooldown',
        objective_id: objectiveId || null,
        cooldown_hits_window: cooldownHitsWindow,
        escalate_after: escalateAfter,
        escalation,
        cooldown_hours: directivePulseCtx.cooldown_hours,
        no_progress_limit: directivePulseCtx.no_progress_limit,
        skipped_directive_pulse_cooldown: skipStats.directive_pulse_cooldown,
        sample_directive_pulse_cooldown: sampleDirectivePulseCooldown
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_repeat_gate_directive_pulse_cooldown',
        objective_id: objectiveId || null,
        cooldown_hits_window: cooldownHitsWindow,
        escalate_after: escalateAfter,
        escalation,
        cooldown_hours: directivePulseCtx.cooldown_hours,
        no_progress_limit: directivePulseCtx.no_progress_limit,
        skipped_directive_pulse_cooldown: skipStats.directive_pulse_cooldown,
        sample_directive_pulse_cooldown: sampleDirectivePulseCooldown,
        ts: nowIso()
      }) + '\n');
      return;
    }

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
      reason: `all_candidates_exhausted quality_or_directive_fit_or_actionability_or_composite_or_eye_no_progress_or_directive_pulse`,
      skipped_eye_no_progress: skipStats.eye_no_progress,
      skipped_low_quality: skipStats.low_quality,
      skipped_low_directive_fit: skipStats.low_directive_fit,
      skipped_low_actionability: skipStats.low_actionability,
      skipped_low_composite: skipStats.low_composite,
      skipped_directive_pulse_cooldown: skipStats.directive_pulse_cooldown,
      sample_low_quality: sampleLowQuality,
      sample_low_directive_fit: sampleLowDirectiveFit,
      sample_low_actionability: sampleLowActionability,
      sample_low_composite: sampleLowComposite,
      sample_directive_pulse_cooldown: sampleDirectivePulseCooldown
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_candidate_exhausted',
      reason: `all_candidates_exhausted quality_or_directive_fit_or_actionability_or_composite_or_eye_no_progress_or_directive_pulse`,
      skipped_eye_no_progress: skipStats.eye_no_progress,
      skipped_low_quality: skipStats.low_quality,
      skipped_low_directive_fit: skipStats.low_directive_fit,
      skipped_low_actionability: skipStats.low_actionability,
      skipped_low_composite: skipStats.low_composite,
      skipped_directive_pulse_cooldown: skipStats.directive_pulse_cooldown,
      sample_low_quality: sampleLowQuality,
      sample_low_directive_fit: sampleLowDirectiveFit,
      sample_low_actionability: sampleLowActionability,
      sample_low_composite: sampleLowComposite,
      sample_directive_pulse_cooldown: sampleDirectivePulseCooldown,
      ts: nowIso()
    }) + '\n');
    return;
  }

  const p = pick.proposal;
  const ov = pick.overlay || { outcomes: { no_change: 0, reverted: 0 } };
  const directiveClarification = directiveClarificationExecSpec(p);
  const actuationSpec = directiveClarification ? null : parseActuationSpec(p);
  const executionTarget = directiveClarification
    ? 'directive'
    : (actuationSpec ? 'actuation' : 'route');
  const capability = capabilityDescriptor(p, actuationSpec);
  const capabilityKey = String(capability && capability.key ? capability.key : 'unknown');
  const capabilityLimit = capabilityCap(strategyBudget, capability);
  const capabilityAttemptsToday = capabilityAttemptCountForDate(dateStr, capability);
  const noChangeCount = ov.outcomes?.no_change || 0;
  const revertedCount = ov.outcomes?.reverted || 0;
  const circuitCooldownHours = strategyCircuitCooldownHours(p, strategy);
  const directivePulse = pick.directive_pulse || null;

  if (circuitCooldownHours > 0) {
    const reason = `auto:circuit_breaker cooldown_${circuitCooldownHours}h`;
    setCooldown(p.id, circuitCooldownHours, reason);
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_circuit_breaker',
      proposal_id: p.id,
      strategy_id: strategy ? strategy.id : null,
      cooldown_hours: circuitCooldownHours,
      error_code: String((p.meta && (p.meta.last_error_code || p.meta.last_error)) || ''),
      proposal_key: proposalDedupKey(p),
      capability_key: capabilityKey,
      directive_pulse: directivePulse
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_circuit_breaker',
      proposal_id: p.id,
      strategy_id: strategy ? strategy.id : null,
      directive_pulse: directivePulse,
      cooldown_hours: circuitCooldownHours,
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (executionMode === 'score_only') {
    let previewReceiptId = null;
    let previewVerification = null;
    let previewSummary = null;
    let previewMode = shadowOnly ? 'shadow_only' : 'score_only';
    const shouldCaptureEvidence = shadowOnly || AUTONOMY_SCORE_ONLY_EVIDENCE;

    if (shouldCaptureEvidence) {
      const estTokens = estimateTokens(p);
      const eyeRef = sourceEyeRef(p);
      const eyeId = sourceEyeId(p);
      const repeats14d = Math.max(1, countEyeProposalsInWindow(eyeId, proposalDate, 14));
      const errors30d = countEyeOutcomesInWindow(decisionEvents, eyeRef, 'reverted', proposalDate, 30);
      const routeTokensEst = repeats14d >= 3 ? Math.max(estTokens, AUTONOMY_MIN_ROUTE_TOKENS) : estTokens;
      previewReceiptId = `preview_${Date.now()}_${String(p.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)}`;
      const previewRes = directiveClarification
        ? runDirectiveClarificationValidate(directiveClarification, true)
        : actuationSpec
          ? runActuationExecute(actuationSpec, true)
          : runRouteExecute(makeTaskFromProposal(p), routeTokensEst, repeats14d, errors30d, true);
      const preSummary = previewRes.summary || null;
      const preBlocked = !previewRes.ok
        || !preSummary
        || preSummary.executable !== true
        || preSummary.gate_decision === 'MANUAL'
        || preSummary.gate_decision === 'DENY';
      const checks = [
        { name: 'preview_command_ok', pass: !!previewRes.ok },
        { name: 'preview_executable', pass: !preBlocked }
      ];
      const failed = checks.filter(c => c.pass !== true).map(c => c.name);
      const primaryFailure = !previewRes.ok
        ? (actuationSpec ? `actuation_exit_${previewRes.code}` : `route_exit_${previewRes.code}`)
        : (preBlocked ? 'preflight_not_executable' : null);
      previewVerification = {
        checks,
        failed,
        passed: failed.length === 0,
        outcome: failed.length === 0 ? 'shipped' : 'no_change',
        primary_failure: primaryFailure
      };
      previewSummary = preSummary;
      writeReceipt(dateStr, {
        ts: nowIso(),
        type: 'autonomy_action_receipt',
        receipt_id: previewReceiptId,
        proposal_id: p.id,
        proposal_date: proposalDate,
        verdict: previewVerification.passed ? 'pass' : 'fail',
        intent: {
          task_hash: hashObj({ task: makeTaskFromProposal(p) }),
          actuation: actuationSpec ? { kind: actuationSpec.kind } : null,
          directive_validation: directiveClarification
            ? {
                objective_id: directiveClarification.objective_id || null,
                file: directiveClarification.file || null
              }
            : null,
          mode: previewMode,
          score_only: true,
          route_tokens_est: routeTokensEst,
          repeats_14d: repeats14d,
          errors_30d: errors30d
        },
        execution: {
          preview: compactCmdResult(previewRes)
        },
        verification: previewVerification
      });
    }

    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: shadowOnly ? 'score_only_evidence' : 'score_only_preview',
      strategy_id: strategy ? strategy.id : null,
      execution_mode: executionMode,
      proposal_id: p.id,
      proposal_date: proposalDate,
      proposal_type: String(p.type || ''),
      source_eye: sourceEyeId(p),
      proposal_key: proposalDedupKey(p),
      capability_key: capabilityKey,
      score: Number(pick.score.toFixed(3)),
      strategy_rank: pick.strategy_rank || null,
      strategy_rank_adjusted: Number(pick.strategy_rank_adjusted || (pick.strategy_rank && pick.strategy_rank.score) || 0),
      directive_pulse: directivePulse,
      selection_mode: selection.mode,
      selection_index: selection.index,
      admission: admissionSummary,
      execution_target: executionTarget,
      preview_mode: previewMode,
      preview_receipt_id: previewReceiptId,
      preview_verification: previewVerification,
      preview_summary: previewSummary
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: shadowOnly ? 'score_only_evidence' : 'score_only_preview',
      strategy_id: strategy ? strategy.id : null,
      execution_mode: executionMode,
      proposal_id: p.id,
      proposal_date: proposalDate,
      score: Number(pick.score.toFixed(3)),
      strategy_rank: pick.strategy_rank || null,
      strategy_rank_adjusted: Number(pick.strategy_rank_adjusted || (pick.strategy_rank && pick.strategy_rank.score) || 0),
      directive_pulse: directivePulse,
      selection_mode: selection.mode,
      selection_index: selection.index,
      admission: admissionSummary,
      execution_target: executionTarget,
      preview_mode: previewMode,
      preview_receipt_id: previewReceiptId,
      preview_verification: previewVerification,
      preview_summary: previewSummary,
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (noChangeCount >= NO_CHANGE_LIMIT) {
    const reason = `auto:autonomy no_change>=${NO_CHANGE_LIMIT} cooldown_${NO_CHANGE_COOLDOWN_HOURS}h`;
    runProposalQueue('park', p.id, reason);
    setCooldown(p.id, NO_CHANGE_COOLDOWN_HOURS, reason);
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_no_change',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      no_change: noChangeCount
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_no_change',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (revertedCount >= 1) {
    const reason = `auto:autonomy reverted>=1 cooldown_${REVERT_COOLDOWN_HOURS}h`;
    runProposalQueue('park', p.id, reason);
    setCooldown(p.id, REVERT_COOLDOWN_HOURS, reason);
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_reverted',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      reverted: revertedCount
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_reverted',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      ts: nowIso()
    }) + '\n');
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
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      score: Number(pick.score.toFixed(3))
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'init_gate_stub',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
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
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      score: Number(pick.score.toFixed(3)),
      min_score: AUTONOMY_MIN_PROPOSAL_SCORE
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'init_gate_low_score',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
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
      capability_key: capabilityKey,
      used_est: budget.used_est,
      token_cap: budget.token_cap,
      est_tokens: estTokens
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'skip_budget_cap',
      proposal_id: p.id,
      capability_key: capabilityKey,
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
  const maxTokensPerAction = Number.isFinite(Number(strategyBudget.max_tokens_per_action))
    ? Number(strategyBudget.max_tokens_per_action)
    : null;
  if (maxTokensPerAction != null && routeTokensEst > maxTokensPerAction) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_init_gate_per_action_token_cap',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      est_tokens: estTokens,
      route_tokens_est: routeTokensEst,
      max_tokens_per_action: maxTokensPerAction
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_init_gate_per_action_token_cap',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      est_tokens: estTokens,
      route_tokens_est: routeTokensEst,
      max_tokens_per_action: maxTokensPerAction,
      ts: nowIso()
    }) + '\n');
    return;
  }
  if (capabilityLimit != null && capabilityAttemptsToday >= capabilityLimit) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_capability_cap',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      capability_attempts_today: capabilityAttemptsToday,
      capability_daily_cap: capabilityLimit
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_capability_cap',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      capability_attempts_today: capabilityAttemptsToday,
      capability_daily_cap: capabilityLimit,
      ts: nowIso()
    }) + '\n');
    return;
  }

  const finalAdmission = strategyAdmissionDecision(p, strategy, {
    dedup_key: proposalDedupKey(p),
    recent_key_counts: recentProposalKeyCounts(dateStr, strategyDuplicateWindowHours(strategy, 24))
  });
  if (!finalAdmission.allow) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_init_gate_strategy_recheck',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      admission_reason: finalAdmission.reason || 'unknown'
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_init_gate_strategy_recheck',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      admission_reason: finalAdmission.reason || 'unknown',
      ts: nowIso()
    }) + '\n');
    return;
  }

  const task = makeTaskFromProposal(p);
  const receiptId = `auto_${Date.now()}_${String(p.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)}`;

  const preflight = directiveClarification
    ? runDirectiveClarificationValidate(directiveClarification, true)
    : actuationSpec
      ? runActuationExecute(actuationSpec, true)
      : runRouteExecute(task, routeTokensEst, repeats14d, errors30d, true);
  const preSummary = preflight.summary || null;
  const preBlocked = !preflight.ok
    || !preSummary
    || preSummary.executable !== true
    || preSummary.gate_decision === 'MANUAL'
    || preSummary.gate_decision === 'DENY';
  const preTokenUsage = computeExecutionTokenUsage(preSummary, preflight.execution_metrics, routeTokensEst, estTokens);

  if (preBlocked) {
    const blockReason = !preflight.ok
      ? `${executionTarget}_exit_${preflight.code}`
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
      receipt_id: receiptId,
      proposal_id: p.id,
      proposal_date: proposalDate,
      capability_key: capabilityKey,
      execution_target: executionTarget,
      directive_pulse: directivePulse,
      score: Number(pick.score.toFixed(3)),
      route_summary: preSummary,
      token_usage: preTokenUsage,
      route_code: preflight.code,
      route_block_reason: blockReason,
      repeats_14d: repeats14d,
      errors_30d: errors30d,
      dopamine
    });
    writeReceipt(dateStr, {
      ts: nowIso(),
      type: 'autonomy_action_receipt',
      receipt_id: receiptId,
      proposal_id: p.id,
      proposal_date: proposalDate,
      verdict: 'fail',
      intent: {
        task_hash: hashObj({ task }),
        actuation: actuationSpec ? { kind: actuationSpec.kind } : null,
        route_tokens_est: routeTokensEst,
        repeats_14d: repeats14d,
        errors_30d: errors30d
      },
      execution: {
        preflight: compactCmdResult(preflight),
        token_usage: preTokenUsage
      },
      verification: {
        checks: [{ name: 'preflight_executable', pass: false }],
        failed: ['preflight_executable'],
        passed: false,
        outcome: 'reverted',
        primary_failure: blockReason
      }
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'init_gate_blocked_route',
      receipt_id: receiptId,
      proposal_id: p.id,
      capability_key: capabilityKey,
      execution_target: executionTarget,
      directive_pulse: directivePulse,
      route_block_reason: blockReason,
      route_summary: preSummary,
      token_usage: preTokenUsage,
      repeats_14d: repeats14d,
      errors_30d: errors30d,
      ts: nowIso()
    }) + '\n');
    return;
  }

  const acceptRes = pick.status !== 'accepted'
    ? runProposalQueue('accept', p.id, 'auto:autonomy_controller selected')
    : { ok: true, code: 0, stdout: 'already_accepted', stderr: '', skipped: true };

  if (!acceptRes.ok) {
    const reason = `auto:init_gate accept_failed cooldown_${AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS}h`;
    setCooldown(p.id, AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS, reason);
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'init_gate_accept_failed',
      receipt_id: receiptId,
      proposal_id: p.id,
      proposal_date: proposalDate,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      score: Number(pick.score.toFixed(3)),
      accept_result: compactCmdResult(acceptRes),
      token_usage: preTokenUsage,
      repeats_14d: repeats14d,
      errors_30d: errors30d
    });
    writeReceipt(dateStr, {
      ts: nowIso(),
      type: 'autonomy_action_receipt',
      receipt_id: receiptId,
      proposal_id: p.id,
      proposal_date: proposalDate,
      verdict: 'fail',
      intent: {
        task_hash: hashObj({ task }),
        actuation: actuationSpec ? { kind: actuationSpec.kind } : null,
        directive_validation: directiveClarification
          ? {
              objective_id: directiveClarification.objective_id || null,
              file: directiveClarification.file || null
            }
          : null,
        route_tokens_est: routeTokensEst,
        repeats_14d: repeats14d,
        errors_30d: errors30d
      },
      execution: {
        preflight: compactCmdResult(preflight),
        accept: compactCmdResult(acceptRes),
        token_usage: preTokenUsage
      },
      verification: {
        checks: [{ name: 'queue_accept_logged', pass: false }],
        failed: ['queue_accept_logged'],
        passed: false,
        outcome: 'reverted',
        primary_failure: 'queue_accept_logged'
      }
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'init_gate_accept_failed',
      receipt_id: receiptId,
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      token_usage: preTokenUsage,
      ts: nowIso()
    }) + '\n');
    return;
  }

  const experiment = {
    ts: nowIso(),
    type: 'experiment_card',
    receipt_id: receiptId,
    strategy_id: strategy ? strategy.id : null,
    execution_mode: executionMode,
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
    directive_pulse: directivePulse,
    composite: {
      score: pick.composite_score,
      min_score: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
      pass: pick.composite_score >= AUTONOMY_MIN_COMPOSITE_ELIGIBILITY
    },
    selection_mode: selection.mode,
    selection_index: selection.index,
    strategy_rank: pick.strategy_rank || null,
    strategy_rank_adjusted: Number(pick.strategy_rank_adjusted || (pick.strategy_rank && pick.strategy_rank.score) || 0),
    thresholds,
    calibration_metrics: calibrationProfile.metrics,
    route_preflight: preSummary,
    actuation: actuationSpec ? { kind: actuationSpec.kind } : null,
    stop_conditions: [
      `daily_token_cap=${budget.token_cap}`,
      `no_change_limit=${NO_CHANGE_LIMIT}`,
      'reverted_count>=1',
      'gate decision DENY or MANUAL',
      ...(executionMode === 'canary_execute' && canaryDailyExecLimit
        ? [`canary_daily_exec_limit=${Number(canaryDailyExecLimit)}`]
        : [])
    ],
    task
  };
  writeExperiment(dateStr, experiment);

  const beforeEvidence = loadDoDEvidenceSnapshot(dateStr);
  const execStartMs = Date.now();
  const execRes = directiveClarification
    ? runDirectiveClarificationValidate(directiveClarification, false)
    : actuationSpec
      ? runActuationExecute(actuationSpec, false)
      : runRouteExecute(task, routeTokensEst, repeats14d, errors30d, false);
  const execEndMs = Date.now();
  const afterEvidence = loadDoDEvidenceSnapshot(dateStr);
  const execTokenUsage = computeExecutionTokenUsage(execRes.summary || null, execRes.execution_metrics || null, routeTokensEst, estTokens);
  budget.used_est += Number(execTokenUsage.effective_tokens || estTokens || 0);
  saveDailyBudget(budget);

  const summary = execRes.summary || {};
  const postconditions = runPostconditions(actuationSpec);
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
  } else if (postconditions.passed !== true) {
    const failName = Array.isArray(postconditions.failed) && postconditions.failed.length ? postconditions.failed[0] : 'postconditions';
    outcome = 'reverted';
    outcomeNote = `auto:autonomy postcheck_fail:${failName}`;
  } else if (dod.passed === true) {
    outcome = 'shipped';
    outcomeNote = `auto:autonomy dod_pass:${dod.class}`;
  }

  let evidence = `proposal:${p.id} ${eyeRef} receipt:${receiptId} ${outcomeNote}`.slice(0, 220);
  let outcomeRes = runProposalQueue('outcome', p.id, outcome, evidence);
  let outcomeRecoveryAttempted = false;
  if (!outcomeRes.ok && outcome !== 'reverted') {
    outcomeRecoveryAttempted = true;
    outcome = 'reverted';
    outcomeNote = 'auto:autonomy verify_outcome_retry_reverted';
    evidence = `proposal:${p.id} ${eyeRef} receipt:${receiptId} ${outcomeNote}`.slice(0, 220);
    outcomeRes = runProposalQueue('outcome', p.id, outcome, evidence);
  }

  const verification = verifyExecutionReceipt(execRes, dod, outcomeRes, postconditions);
  outcome = verification.outcome;
  let cooldownAppliedHours = 0;
  if (!verification.passed) {
    cooldownAppliedHours = outcome === 'reverted'
      ? REVERT_COOLDOWN_HOURS
      : AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS;
    const reason = `auto:verify ${verification.primary_failure || 'unknown'} cooldown_${cooldownAppliedHours}h`;
    setCooldown(p.id, cooldownAppliedHours, reason);
    if (!outcomeRes.ok) {
      runProposalQueue('park', p.id, reason);
    }
  }

  writeReceipt(dateStr, {
    ts: nowIso(),
    type: 'autonomy_action_receipt',
    receipt_id: receiptId,
    proposal_id: p.id,
    proposal_date: proposalDate,
    verdict: verification.passed ? 'pass' : 'fail',
    intent: {
      task_hash: hashObj({ task }),
      actuation: actuationSpec ? { kind: actuationSpec.kind } : null,
      directive_validation: directiveClarification
        ? {
            objective_id: directiveClarification.objective_id || null,
            file: directiveClarification.file || null
          }
        : null,
      route_tokens_est: routeTokensEst,
      repeats_14d: repeats14d,
      errors_30d: errors30d
    },
      execution: {
        preflight: compactCmdResult(preflight),
        accept: compactCmdResult(acceptRes),
        execute: compactCmdResult(execRes),
        outcome: compactCmdResult(outcomeRes),
        token_usage: execTokenUsage,
        outcome_retry_attempted: outcomeRecoveryAttempted,
        postconditions
      },
    verification: {
      ...verification,
      dod: {
        passed: !!dod.passed,
        class: dod.class || null,
        reason: dod.reason || null
      },
      cooldown_applied_hours: cooldownAppliedHours
    }
  });

  writeRun(dateStr, {
    ts: nowIso(),
    type: 'autonomy_run',
    result: 'executed',
    receipt_id: receiptId,
    strategy_id: strategy ? strategy.id : null,
    execution_mode: executionMode,
    proposal_id: p.id,
    capability_key: capabilityKey,
    execution_target: executionTarget,
    proposal_date: proposalDate,
    proposal_type: String(p.type || ''),
    source_eye: sourceEyeId(p),
    proposal_key: proposalDedupKey(p),
    score: Number(pick.score.toFixed(3)),
    strategy_rank_adjusted: Number(pick.strategy_rank_adjusted || (pick.strategy_rank && pick.strategy_rank.score) || 0),
    est_tokens: estTokens,
    route_tokens_est: routeTokensEst,
    token_usage: execTokenUsage,
    repeats_14d: repeats14d,
    errors_30d: errors30d,
    used_est_after: budget.used_est,
    dopamine,
    signal_quality: pick.quality,
    directive_fit: pick.directive_fit,
    actionability: pick.actionability,
    directive_pulse: directivePulse,
    composite: {
      score: pick.composite_score,
      min_score: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
      pass: pick.composite_score >= AUTONOMY_MIN_COMPOSITE_ELIGIBILITY
    },
    selection_mode: selection.mode,
    selection_index: selection.index,
    strategy_rank: pick.strategy_rank || null,
    explore_used_before: selection.explore_used,
    explore_quota: selection.explore_quota,
    thresholds,
    route_summary: summary,
    admission: admissionSummary,
    dod,
    postconditions,
    verification,
    exec_ok: execRes.ok,
    exec_code: execRes.code,
    outcome_write_ok: !!outcomeRes.ok,
    outcome,
    evidence
  });

  process.stdout.write(JSON.stringify({
    ok: true,
    result: 'executed',
    receipt_id: receiptId,
    strategy_id: strategy ? strategy.id : null,
    execution_mode: executionMode,
    proposal_id: p.id,
    capability_key: capabilityKey,
    execution_target: executionTarget,
    proposal_date: proposalDate,
    strategy_rank_adjusted: Number(pick.strategy_rank_adjusted || (pick.strategy_rank && pick.strategy_rank.score) || 0),
    est_tokens: estTokens,
    route_tokens_est: routeTokensEst,
    token_usage: execTokenUsage,
    repeats_14d: repeats14d,
    errors_30d: errors30d,
    used_est_after: budget.used_est,
    outcome,
    signal_quality: pick.quality,
    directive_fit: pick.directive_fit,
    actionability: pick.actionability,
    directive_pulse: directivePulse,
    composite: {
      score: pick.composite_score,
      min_score: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
      pass: pick.composite_score >= AUTONOMY_MIN_COMPOSITE_ELIGIBILITY
    },
    selection_mode: selection.mode,
    selection_index: selection.index,
    strategy_rank: pick.strategy_rank || null,
    explore_used_before: selection.explore_used,
    explore_quota: selection.explore_quota,
    dod,
    postconditions,
    verification,
    outcome_write_ok: !!outcomeRes.ok,
    route_summary: summary,
    admission: admissionSummary,
    model_catalog_apply_pending: Number(modelCatalogSnapshot.pending_apply || 0),
    terminology_warnings: terminologyWarnings,
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
  console.log('  node systems/autonomy/autonomy_controller.js evidence [YYYY-MM-DD]');
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
  if (cmd === 'evidence') return runCmd(dateStr, { shadowOnly: true });
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
  diffDoDEvidence,
  computeCalibrationDeltas,
  compileDirectivePulseObjectives,
  buildDirectivePulseContext,
  assessDirectivePulse,
  startModelCatalogCanary,
  evaluateModelCatalogCanary,
  readModelCatalogCanary
};
