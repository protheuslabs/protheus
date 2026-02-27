#!/usr/bin/env node
'use strict';
export {};

/**
 * proposal_enricher.js
 *
 * Deterministic proposal metadata/admission enrichment.
 * - Normalizes proposal meta scores used by autonomy gates.
 * - Adds admission preview (eligible + blocked reasons) per proposal.
 * - Produces daily admission summary for orchestration logs.
 *
 * Usage:
 *   node systems/autonomy/proposal_enricher.js run [YYYY-MM-DD] [--dry-run]
 *   node systems/autonomy/proposal_enricher.js --help
 */

const fs = require('fs');
const path = require('path');
const { loadActiveDirectives } = require('../../lib/directive_resolver');
const { resolveCatalogPath } = require('../../lib/eyes_catalog');
const {
  loadActiveStrategy,
  applyThresholdOverrides,
  effectiveAllowedRisks,
  strategyAllowsProposalType
} = require('../../lib/strategy_resolver');
const {
  loadOutcomeFitnessPolicy,
  proposalTypeThresholdOffsetsFor
} = require('../../lib/outcome_fitness');
const {
  evaluateMutationSafetyEnvelope,
  loadPolicy: loadMutationSafetyKernelPolicy
} = require('./mutation_safety_kernel');
const { compileProposalSuccessCriteria } = require('../../lib/success_criteria_compiler');
const { evaluateProposalQuorum } = require('../../lib/quorum_validator');
const { classifyProposalType } = require('../../lib/proposal_type_classifier');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const SENSORY_DIR = process.env.SENSORY_TEST_DIR
  ? path.resolve(process.env.SENSORY_TEST_DIR)
  : path.join(ROOT, 'state', 'sensory');
const PROPOSALS_DIR = path.join(SENSORY_DIR, 'proposals');

const EYES_CONFIG_PATH = resolveCatalogPath(ROOT);
const EYES_REGISTRY_PATH = process.env.PROPOSAL_ENRICHER_EYES_REGISTRY
  ? path.resolve(process.env.PROPOSAL_ENRICHER_EYES_REGISTRY)
  : path.join(ROOT, 'state', 'sensory', 'eyes', 'registry.json');
const DREAMS_DIR = process.env.PROPOSAL_ENRICHER_DREAMS_DIR
  ? path.resolve(process.env.PROPOSAL_ENRICHER_DREAMS_DIR)
  : path.join(ROOT, 'state', 'memory', 'dreams');
const DREAMS_REM_DIR = path.join(DREAMS_DIR, 'rem');
const DREAM_SIGNAL_MAX_TOKENS = clamp(Number(process.env.PROPOSAL_ENRICHER_DREAM_MAX_TOKENS || 24), 8, 64);
const DREAM_DIRECTIVE_BONUS_CAP = clamp(Number(process.env.AUTONOMY_DREAM_DIRECTIVE_BONUS_CAP || 6), 0, 12);
const DREAM_REM_RUN_FILE_LIMIT = clamp(Number(process.env.PROPOSAL_ENRICHER_DREAM_REM_RUN_FILE_LIMIT || 3), 0, 12);
const DREAM_REM_SYNTHESIS_WEIGHT_SCALE = clamp(Number(process.env.PROPOSAL_ENRICHER_DREAM_REM_SYNTHESIS_WEIGHT_SCALE || 0.5), 0.25, 1);
const DREAM_REM_BONUS_CAP = clamp(Number(process.env.AUTONOMY_DREAM_REM_BONUS_CAP || 2), 0, 4);
const DREAM_MAX_SOURCE_UIDS = clamp(Number(process.env.PROPOSAL_ENRICHER_DREAM_MAX_SOURCE_UIDS || 24), 8, 128);
const DREAM_SIGNAL_QUALITY_MIN_SCORE = clamp(Number(process.env.PROPOSAL_ENRICHER_DREAM_QUALITY_MIN_SCORE || 35), 0, 100);
const DREAM_SIGNAL_QUALITY_MIN_SCALE = clamp(Number(process.env.PROPOSAL_ENRICHER_DREAM_QUALITY_MIN_SCALE || 0.25), 0, 1);

const FIT_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'through', 'that', 'this', 'those', 'these', 'your', 'you',
  'their', 'our', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'will', 'would', 'should',
  'could', 'must', 'can', 'not', 'all', 'any', 'only', 'each', 'per', 'but', 'its', 'it', 'as', 'at', 'on',
  'to', 'in', 'of', 'or', 'an', 'a', 'by'
]);

const ACTION_VERB_RE = /\b(build|implement|fix|add|create|generate|optimize|refactor|automate|ship|deploy|test|measure|instrument|reduce|increase|stabilize)\b/i;
const OPPORTUNITY_MARKER_RE = /\b(opportunity|freelance|job|jobs|hiring|contract|contractor|gig|client|rfp|request for proposal|seeking|looking for)\b/i;
const META_COORDINATION_RE = /\b(review|prioritize|triage|health\s*check|high\s*leverage)\b/i;
const META_NOOP_INTENT_RE = /\b(review|prioritize|triage|health\s*check|status|report|assess|analy[sz]e|audit|investigate|monitor)\b/i;
const SELF_REFERENTIAL_SCOPE_RE = /\b(proposals?|proposal_queue|queue|backlog|automation\s+health|system\s+health)\b/i;
const CONCRETE_DELTA_RE = /\b(update|edit|patch|modify|create|add|remove|delete|migrate|wire|instrument|implement|set|configure|fix|ship|commit|write)\b/i;
const META_MEASURABLE_MIN_COUNT = 2;
const CONCRETE_TARGET_RE = /\b(file|script|collector|parser|endpoint|model|config|test|hook|queue|ledger|registry|adapter|workflow|routing|transport|fallback|sensor|retry|dns|network|probe|api|cache)\b/i;
const EXPLAINER_TITLE_RE = /^(why|what|how)\b/i;
const GENERIC_VALIDATION_RE = /\b(extract one concrete build\/change task from source|define measurable success check|route a dry-run execution plan)\b/i;
const GENERIC_ROUTE_TASK_RE = /--task=\"Extract one implementable step from external intel:/i;
const SUCCESS_METRIC_RE = /\b(metric|kpi|target|rate|count|latency|error|uptime|throughput|conversion|artifact|receipt|coverage|reply|interview|pass|fail|delta|percent|%|run|runs|check|checks|items_collected)\b/i;
const SUCCESS_TIMEBOUND_RE = /\b(\d+\s*(h|hr|hour|hours|d|day|days|w|week|weeks|min|mins|minute|minutes)|daily|weekly|monthly|quarterly)\b/i;
const SUCCESS_RELAXED_RUN_HORIZON_RE = /\b(next|this)\s+(run|cycle)\b/i;
const SUCCESS_COMPARATOR_RE = /\b(>=|<=|>|<|at least|at most|less than|more than|within|under|over)\b/i;
const OPTIMIZATION_INTENT_RE = /\b(optimi[sz]e|optimization|improv(?:e|ement)|tune|polish|streamlin|efficien(?:cy|t)|latency|throughput|cost|token(?:s)?|performance)\b/i;
const OPTIMIZATION_EXEMPT_RE = /\b(fail(?:ure)?|error|outage|broken|incident|security|integrity|violation|breach|timeout|rate\s*limit|dns|connection|recover|restore|rollback|revert|remediation)\b/i;
const VALUE_SIGNAL_REVENUE_RE = /\b(revenue|mrr|arr|cash|money|usd|dollar|profit|pricing|invoice|paid|payment|bill(?:ing)?)\b/;
const VALUE_SIGNAL_USER_RE = /\b(customer|client|user|buyer|subscriber|audience|lead|prospect|account|tenant)\b/;
const VALUE_SIGNAL_EXTERNAL_RE = /\b(external|market|demand|opportunity|contract|gig|upwork|freelance|sales?|pipeline|conversion|acquisition|churn|retention|roi)\b/;
const VALUE_SIGNAL_TIME_RE = /\b(time[\s_-]*to[\s_-]*(?:revenue|cash|value)|hours?\s+saved|payback|faster|latency|cycle[\s_-]*time|throughput)\b/;
const VALUE_SIGNAL_DELIVERY_RE = /\b(make|build|ship|deliver|launch|release|implement|create|complete|finish|deploy|prototype)\b/;
const VALUE_SIGNAL_QUALITY_RE = /\b(reliab|quality|uptime|error|stability|safety|accuracy|resilience|regression)\b/;
const VALUE_SIGNAL_LEARNING_RE = /\b(experiment|hypothesis|validate|validation|test|benchmark|learn(?:ing)?|discovery|probe)\b/;
const VALUE_SIMULATION_RE = /\b(simulat(?:e|ion)|what[-\s]?if|forecast|backtest|sandbox|dry[-\s]?run|pilot)\b/;
const DREAM_ORIGIN_RE = /\b(dream|idle_dream|memory_dream|rem_dream)\b/;
const PERCENT_VALUE_RE = /(-?\d+(?:\.\d+)?)\s*%/g;
const AUTONOMY_OPTIMIZATION_MIN_DELTA_PERCENT = clamp(Number(process.env.AUTONOMY_OPTIMIZATION_MIN_DELTA_PERCENT || 10), 1, 50);
const AUTONOMY_OPTIMIZATION_MIN_DELTA_PERCENT_HIGH_ACCURACY = clamp(Number(process.env.AUTONOMY_OPTIMIZATION_MIN_DELTA_PERCENT_HIGH_ACCURACY || 5), 1, 50);
const AUTONOMY_OPTIMIZATION_HIGH_ACCURACY_MODE = String(process.env.AUTONOMY_OPTIMIZATION_HIGH_ACCURACY_MODE || '0') === '1';
const AUTONOMY_OPTIMIZATION_REQUIRE_DELTA = String(process.env.AUTONOMY_OPTIMIZATION_REQUIRE_DELTA || '1') !== '0';
const AUTONOMY_SUBDIRECTIVE_V2_REQUIRED = String(process.env.AUTONOMY_SUBDIRECTIVE_V2_REQUIRED || '1') !== '0';
const AUTONOMY_SUBDIRECTIVE_V2_EXEMPT_TYPES = new Set(
  String(process.env.AUTONOMY_SUBDIRECTIVE_V2_EXEMPT_TYPES || 'directive_clarification,directive_decomposition')
    .split(',')
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean)
);
const VALUE_CURRENCY_KEYS = new Set(['revenue', 'delivery', 'user_value', 'quality', 'time_savings', 'learning']);
const VALUE_CURRENCY_WEIGHTS = {
  revenue: 1.35,
  delivery: 1,
  user_value: 1.1,
  quality: 0.95,
  time_savings: 1,
  learning: 0.85
};
const AUTONOMY_VALUE_ORACLE_REQUIRED = String(
  process.env.AUTONOMY_VALUE_ORACLE_REQUIRED != null
    ? process.env.AUTONOMY_VALUE_ORACLE_REQUIRED
    : (process.env.AUTONOMY_REVENUE_ORACLE_REQUIRED || '1')
) !== '0';
const AUTONOMY_VALUE_ORACLE_SCOPE = new Set(
  String(process.env.AUTONOMY_VALUE_ORACLE_SCOPE || process.env.AUTONOMY_REVENUE_ORACLE_SCOPE || 'dream')
    .split(',')
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean)
);
const AUTONOMY_VALUE_ORACLE_EXEMPT_TYPES = new Set(
  String(
    process.env.AUTONOMY_VALUE_ORACLE_EXEMPT_TYPES
      || process.env.AUTONOMY_REVENUE_ORACLE_EXEMPT_TYPES
      || 'pain_signal_escalation,dream_cycle_escalation,collector_remediation,infrastructure_outage,directive_clarification,directive_decomposition'
  )
    .split(',')
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean)
);
const AUTONOMY_VALUE_ORACLE_DEFAULT_CURRENCIES = String(process.env.AUTONOMY_VALUE_ORACLE_DEFAULT_CURRENCIES || 'revenue,delivery')
  .split(',')
  .map((s) => String(s || '').trim().toLowerCase())
  .filter((k) => VALUE_CURRENCY_KEYS.has(k));
const AUTONOMY_VALUE_ORACLE_REQUIRE_PRIMARY_SIGNAL = String(process.env.AUTONOMY_VALUE_ORACLE_REQUIRE_PRIMARY_SIGNAL || '0') === '1';
const AUTONOMY_VALUE_ORACLE_BACKFILL_EXPECTED_VALUE = String(process.env.AUTONOMY_VALUE_ORACLE_BACKFILL_EXPECTED_VALUE || '1') !== '0';
const ADAPTIVE_MUTATION_TYPE_RE = /\b(adaptive[_-]?mutation|mutation(?:[_-]proposal)?|topology[_-]?mutation|genome[_-]?mutation|self[_-]?(?:mutation|modify)|branch[_-]?(?:rewire|prune))\b/i;
const ADAPTIVE_MUTATION_SIGNAL_RE = /\b(mutation(?:[_-]?(?:guard|policy|kernel|budget|ttl|quarantine|veto|rollback|lineage|attestation))?|topology[_-]?mutation|genome[_-]?mutation|self[_-]?(?:mutation|modify)|branch[_-]?(?:rewire|prune))\b/i;
const AUTONOMY_MUTATION_GUARD_REQUIRED = String(process.env.AUTONOMY_MUTATION_GUARD_REQUIRED || '1') !== '0';
const AUTONOMY_MUTATION_KERNEL_REQUIRED = String(process.env.AUTONOMY_MUTATION_KERNEL_REQUIRED || '1') !== '0';
const AUTONOMY_MUTATION_BUDGET_CAP_MAX = clamp(Number(process.env.AUTONOMY_MUTATION_BUDGET_CAP_MAX || 5), 1, 50);
const AUTONOMY_MUTATION_TTL_HOURS_MAX = clamp(Number(process.env.AUTONOMY_MUTATION_TTL_HOURS_MAX || 168), 1, 24 * 90);
const AUTONOMY_MUTATION_QUARANTINE_HOURS_MIN = clamp(Number(process.env.AUTONOMY_MUTATION_QUARANTINE_HOURS_MIN || 24), 0, 24 * 30);
const AUTONOMY_MUTATION_VETO_WINDOW_HOURS_MIN = clamp(Number(process.env.AUTONOMY_MUTATION_VETO_WINDOW_HOURS_MIN || 24), 0, 24 * 30);
const EVALUABLE_SUCCESS_METRICS = new Set([
  'execution_success',
  'postconditions_ok',
  'queue_outcome_logged',
  'artifact_count',
  'entries_count',
  'revenue_actions_count',
  'outreach_artifact',
  'reply_or_interview_count',
  'token_usage',
  'duration_ms'
]);
const CRITERIA_HARDENING_ROWS = [
  { metric: 'postconditions_ok', target: 'postconditions pass', horizon: 'next run' },
  { metric: 'queue_outcome_logged', target: 'outcome receipt logged', horizon: 'next run' },
  { metric: 'execution_success', target: 'execution success', horizon: 'next run' }
];
const DIRECTIVE_OBJECTIVE_ID_RE = /^T[0-9]_[A-Za-z0-9_]+$/;
const ARCHETYPE_RULES = [
  {
    key: 'reliability',
    regex: /\b(fail|failure|outage|error|retry|timeout|flaky|stabilize|reliab|uptime|collector|sensor|ingest|queue|backlog)\b/i,
    hints: ['reliability', 'uptime', 'systems']
  },
  {
    key: 'automation',
    regex: /\b(automate|automation|deterministic|orchestrat|pipeline|spine|workflow|throughput)\b/i,
    hints: ['automated', 'systems', 'efficiency']
  },
  {
    key: 'growth',
    regex: /\b(growth|income|revenue|mrr|compounding|scale|scalable|venture|asset)\b/i,
    hints: ['income', 'scalable', 'growth']
  },
  {
    key: 'measurement',
    regex: /\b(metric|measure|validation|proof|artifact|receipt|signal|score|quality)\b/i,
    hints: ['metrics', 'quality', 'validation']
  },
  {
    key: 'risk_control',
    regex: /\b(risk|guard|safety|compliance|policy|rollback|revert|downside)\b/i,
    hints: ['risk', 'return', 'assessment']
  }
];
const DISALLOWED_PARSER_TYPES = new Set(
  String(process.env.AUTONOMY_DISALLOWED_PARSER_TYPES || 'stub')
    .split(',')
    .map(s => String(s || '').trim().toLowerCase())
    .filter(Boolean)
);
const ALLOWED_RISKS = new Set(
  String(process.env.AUTONOMY_ALLOWED_RISKS || 'low')
    .split(',')
    .map(s => String(s || '').trim().toLowerCase())
    .filter(Boolean)
);
const AUTONOMY_OBJECTIVE_BINDING_REQUIRED = String(process.env.AUTONOMY_OBJECTIVE_BINDING_REQUIRED || '1') !== '0';
const CROSS_SIGNAL_NO_CHANGE_WINDOW_DAYS = Math.max(1, Math.min(30, Math.floor(Number(process.env.AUTONOMY_CROSS_SIGNAL_NO_CHANGE_WINDOW_DAYS || 7) || 7)));
const CROSS_SIGNAL_NO_CHANGE_PENALTY_PER_HIT = Math.max(1, Math.min(12, Number(process.env.AUTONOMY_CROSS_SIGNAL_NO_CHANGE_PENALTY_PER_HIT || 3) || 3));
const CROSS_SIGNAL_NO_CHANGE_MAX_PENALTY = Math.max(2, Math.min(40, Number(process.env.AUTONOMY_CROSS_SIGNAL_NO_CHANGE_MAX_PENALTY || 18) || 18));
let STRATEGY_CACHE = undefined;

function strategyProfile() {
  if (STRATEGY_CACHE !== undefined) return STRATEGY_CACHE;
  STRATEGY_CACHE = loadActiveStrategy({ allowMissing: true });
  return STRATEGY_CACHE;
}

function thresholds() {
  const base = {
    min_signal_quality: Number(process.env.AUTONOMY_MIN_SIGNAL_QUALITY || 58),
    min_sensory_signal_score: Number(process.env.AUTONOMY_MIN_SENSORY_SIGNAL_SCORE || 45),
    min_sensory_relevance_score: Number(process.env.AUTONOMY_MIN_SENSORY_RELEVANCE_SCORE || 42),
    min_directive_fit: Number(process.env.AUTONOMY_MIN_DIRECTIVE_FIT || 40),
    min_actionability_score: Number(process.env.AUTONOMY_MIN_ACTIONABILITY_SCORE || 45),
    min_composite_eligibility: Number(process.env.AUTONOMY_MIN_COMPOSITE_ELIGIBILITY || 62),
    min_eye_score_ema: Number(process.env.AUTONOMY_MIN_EYE_SCORE_EMA || 45)
  };
  return applyThresholdOverrides(base, strategyProfile());
}

function applyTypeThresholds(baseThresholds, proposalType, outcomePolicy) {
  const base = baseThresholds && typeof baseThresholds === 'object' ? baseThresholds : thresholds();
  const offsets = proposalTypeThresholdOffsetsFor(outcomePolicy, proposalType);
  const keys = [
    'min_signal_quality',
    'min_sensory_signal_score',
    'min_sensory_relevance_score',
    'min_directive_fit',
    'min_actionability_score',
    'min_composite_eligibility',
    'min_eye_score_ema'
  ];
  const limits = {
    min_signal_quality: [30, 95],
    min_sensory_signal_score: [20, 95],
    min_sensory_relevance_score: [20, 95],
    min_directive_fit: [20, 95],
    min_actionability_score: [20, 95],
    min_composite_eligibility: [35, 95],
    min_eye_score_ema: [20, 95]
  };
  const next = { ...base };
  for (const key of keys) {
    const baseVal = Number(base[key]);
    if (!Number.isFinite(baseVal)) continue;
    const delta = Number(offsets[key] || 0);
    const [lo, hi] = limits[key] || [0, 100];
    next[key] = clamp(Math.round(baseVal + delta), lo, hi);
  }
  return {
    thresholds: next,
    offsets
  };
}

function effectiveAllowedRisksSet() {
  return effectiveAllowedRisks(ALLOWED_RISKS, strategyProfile());
}

function nowIso() { return new Date().toISOString(); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/proposal_enricher.js run [YYYY-MM-DD] [--dry-run]');
  console.log('  node systems/autonomy/proposal_enricher.js --help');
}

function parseArgs(argv: string[]): AnyObj {
  const out: AnyObj = { _: [] };
  for (const a of argv) {
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq === -1) out[a.slice(2)] = true;
    else out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function normalizeText(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

function normalizeFitText(v) {
  return normalizeText(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenizeFitText(v) {
  const n = normalizeFitText(v);
  if (!n) return [];
  return n
    .split(' ')
    .filter(Boolean)
    .filter(t => t.length >= 3)
    .filter(t => !FIT_STOPWORDS.has(t))
    .filter(t => !/^\d+$/.test(t));
}

function toStem(token) {
  const t = normalizeText(token);
  if (t.length <= 5) return t;
  return t.slice(0, 5);
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function parseLowerList(value) {
  if (Array.isArray(value)) {
    return value
      .map(v => String(v || '').trim().toLowerCase())
      .filter(Boolean);
  }
  return String(value || '')
    .split(',')
    .map(v => String(v || '').trim().toLowerCase())
    .filter(Boolean);
}

function tier(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return 'unknown';
  if (s >= 75) return 'high';
  if (s >= 50) return 'medium';
  return 'low';
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function ingestDreamToken(tokenMap, token, rawWeight, source) {
  const toks = tokenizeFitText(token).slice(0, 2);
  if (!toks.length) return;
  const weight = clamp(Number(rawWeight || 0), 1, 8);
  for (const tok of toks) {
    if (!tok) continue;
    const prev = tokenMap.get(tok) || { token: tok, weight: 0, sources: new Set() };
    prev.weight = clamp(Number(prev.weight || 0) + weight, 1, 12);
    prev.sources.add(String(source || 'unknown'));
    tokenMap.set(tok, prev);
  }
}

function listRemRunFiles(dateStr) {
  if (DREAM_REM_RUN_FILE_LIMIT <= 0) return [];
  try {
    if (!fs.existsSync(DREAMS_REM_DIR)) return [];
    const prefix = `${dateStr}__`;
    return fs.readdirSync(DREAMS_REM_DIR)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .sort()
      .slice(-DREAM_REM_RUN_FILE_LIMIT)
      .map((name) => path.join(DREAMS_REM_DIR, name));
  } catch {
    return [];
  }
}

function loadDreamSignals(dateStr) {
  const dreamPath = path.join(DREAMS_DIR, `${dateStr}.json`);
  const remPath = path.join(DREAMS_REM_DIR, `${dateStr}.json`);
  const dreamRaw = readJsonSafe(dreamPath, null);
  const remRaw = readJsonSafe(remPath, null);
  const remRunPaths = listRemRunFiles(dateStr);
  const tokenMap = new Map();
  const sourceCounts: AnyObj = { theme: 0, rem_daily: 0, rem_run: 0, rem_synthesis: 0 };
  const sourceUidSet = new Set();

  const themes = dreamRaw && Array.isArray(dreamRaw.themes) ? dreamRaw.themes : [];
  for (const row of themes) {
    const token = normalizeText(row && row.token);
    if (!token) continue;
    sourceCounts.theme += 1;
    const score = Number(row && row.score || 0);
    const weight = clamp(Math.round(score / 25), 1, 4);
    ingestDreamToken(tokenMap, token, weight, 'theme');
  }

  const ingestQuantizedRows = (rows, sourceKey, includeSynthesis) => {
    const quantizedRows = Array.isArray(rows) ? rows : [];
    for (const row of quantizedRows) {
      const token = normalizeText(row && row.token);
      if (!token) continue;
      sourceCounts[sourceKey] = Number(sourceCounts[sourceKey] || 0) + 1;
      const rawWeight = Number(row && row.weight || 0);
      const weight = clamp(Math.round(rawWeight / 8), 1, 4);
      ingestDreamToken(tokenMap, token, weight, sourceKey);
      if (includeSynthesis === true) {
        const synthesis = normalizeText(row && row.synthesis);
        if (synthesis) {
          sourceCounts.rem_synthesis += 1;
          const synthesisWeight = clamp(Math.round(weight * DREAM_REM_SYNTHESIS_WEIGHT_SCALE), 1, 4);
          ingestDreamToken(tokenMap, synthesis, synthesisWeight, 'rem_synthesis');
        }
      }
      const sourceUids = Array.isArray(row && row.source_uids) ? row.source_uids : [];
      for (const uid of sourceUids) {
        const clean = normalizeText(uid).toLowerCase();
        if (clean) sourceUidSet.add(clean);
      }
    }
  };

  ingestQuantizedRows(remRaw && remRaw.quantized, 'rem_daily', true);
  for (const fp of remRunPaths) {
    const one = readJsonSafe(fp, null);
    ingestQuantizedRows(one && one.quantized, 'rem_run', true);
  }

  const tokens = Array.from(tokenMap.values())
    .map((row) => ({
      token: row.token,
      weight: clamp(Number(row.weight || 0) + (row.sources.size > 1 ? 1 : 0), 1, 12),
      sources: Array.from(row.sources).sort()
    }))
    .sort((a, b) => Number(b.weight || 0) - Number(a.weight || 0) || String(a.token).localeCompare(String(b.token)))
    .slice(0, DREAM_SIGNAL_MAX_TOKENS);

  const sourceCoverage = ['theme', 'rem_daily', 'rem_run', 'rem_synthesis']
    .filter((key) => Number(sourceCounts[key] || 0) > 0)
    .length;
  const tokenDensityScore = clamp(Math.round((tokens.length / Math.max(1, Math.min(8, DREAM_SIGNAL_MAX_TOKENS))) * 45), 0, 45);
  const sourceCoverageScore = clamp(Math.round((sourceCoverage / 3) * 30), 0, 30);
  const sourceUidScore = clamp(Math.round((sourceUidSet.size / 6) * 15), 0, 15);
  const remPresenceScore = Number(sourceCounts.rem_daily || 0) + Number(sourceCounts.rem_run || 0) > 0 ? 10 : 0;
  const qualityScore = clamp(tokenDensityScore + sourceCoverageScore + sourceUidScore + remPresenceScore, 0, 100);
  const qualityTier = qualityScore >= 70 ? 'high' : (qualityScore >= 45 ? 'medium' : 'low');
  const qualityScale = qualityScore >= DREAM_SIGNAL_QUALITY_MIN_SCORE
    ? 1
    : clamp(
        Math.max(
          DREAM_SIGNAL_QUALITY_MIN_SCALE,
          qualityScore / Math.max(1, DREAM_SIGNAL_QUALITY_MIN_SCORE)
        ),
        DREAM_SIGNAL_QUALITY_MIN_SCALE,
        1
      );

  return {
    date: dateStr,
    available: tokens.length > 0,
    quality_score: qualityScore,
    quality_tier: qualityTier,
    quality_scale: Number(qualityScale.toFixed(3)),
    quality_floor: DREAM_SIGNAL_QUALITY_MIN_SCORE,
    total_weight: tokens.reduce((sum, row) => sum + Number(row.weight || 0), 0),
    tokens,
    source_counts: {
      ...sourceCounts,
      rem: Number(sourceCounts.rem_daily || 0) + Number(sourceCounts.rem_run || 0)
    },
    source_uids: Array.from(sourceUidSet).sort().slice(0, DREAM_MAX_SOURCE_UIDS),
    files: {
      themes: fs.existsSync(dreamPath),
      rem: fs.existsSync(remPath),
      rem_runs: remRunPaths.map((fp) => path.basename(fp))
    }
  };
}

function loadProposalsForDate(dateStr) {
  const fp = path.join(PROPOSALS_DIR, `${dateStr}.json`);
  if (!fs.existsSync(fp)) return { exists: false, filePath: fp, container: null, proposals: [] };
  const raw = readJsonSafe(fp, []);
  if (Array.isArray(raw)) return { exists: true, filePath: fp, container: null, proposals: raw };
  if (raw && typeof raw === 'object' && Array.isArray(raw.proposals)) {
    return { exists: true, filePath: fp, container: raw, proposals: raw.proposals };
  }
  return { exists: true, filePath: fp, container: null, proposals: [] };
}

function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function saveProposalsForDate(filePath, container, proposals) {
  if (container && typeof container === 'object' && !Array.isArray(container)) {
    writeJsonAtomic(filePath, { ...container, proposals });
    return;
  }
  writeJsonAtomic(filePath, proposals);
}

function loadEyesMap() {
  const out = new Map();
  const cfg = readJsonSafe(EYES_CONFIG_PATH, {});
  const reg = readJsonSafe(EYES_REGISTRY_PATH, {});
  const cfgEyes = Array.isArray(cfg && cfg.eyes) ? cfg.eyes : [];
  const regEyes = Array.isArray(reg && reg.eyes) ? reg.eyes : [];
  for (const e of cfgEyes) {
    if (!e || !e.id) continue;
    out.set(String(e.id), { ...e });
  }
  for (const e of regEyes) {
    if (!e || !e.id) continue;
    const id = String(e.id);
    out.set(id, { ...(out.get(id) || {}), ...e });
  }
  return out;
}

function asStringArray(v) {
  if (Array.isArray(v)) return v.map(x => normalizeText(x)).filter(Boolean);
  if (typeof v === 'string') {
    const s = normalizeText(v);
    return s ? [s] : [];
  }
  return [];
}

function strategyMarkerTokens(strategy) {
  const s = strategy && typeof strategy === 'object' ? strategy : {};
  const objective = s.objective && typeof s.objective === 'object' ? s.objective : {};
  const parts = [
    objective.primary,
    objective.fitness_metric,
    ...(Array.isArray(objective.secondary) ? objective.secondary : []),
    ...(Array.isArray(s.tags) ? s.tags : [])
  ];
  const set = new Set();
  for (const part of parts) {
    const norm = normalizeFitText(part);
    if (!norm) continue;
    for (const tok of tokenizeFitText(norm)) set.add(tok);
  }
  return Array.from(set).sort();
}

function loadDirectiveProfile() {
  let directives = [];
  try {
    directives = loadActiveDirectives({ allowMissing: true });
  } catch {
    return {
      available: false,
      strategy_id: null,
      strategy_tokens: [],
      active_directive_ids: [],
      positive_phrases: [],
      negative_phrases: [],
      positive_tokens: [],
      negative_tokens: []
    };
  }

  const strategic = directives.filter((d) => {
    const id = normalizeText(d && d.id);
    if (/^T0[_-]/i.test(id) || /^T0$/i.test(id)) return false;
    const entryTier = Number(d && d.tier);
    const metaTier = Number(d && d.data && d.data.metadata && d.data.metadata.tier);
    const tierVal = Number.isFinite(entryTier) ? entryTier : metaTier;
    return Number.isFinite(tierVal) ? tierVal >= 1 : true;
  });

  const positive = [];
  const negative = [];
  const ids = [];
  for (const d of strategic) {
    const data = d && d.data ? d.data : {};
    const meta = data && data.metadata ? data.metadata : {};
    const intent = data && data.intent ? data.intent : {};
    const scope = data && data.scope ? data.scope : {};
    const success = data && data.success_metrics ? data.success_metrics : {};
    ids.push(normalizeText(d.id || meta.id));
    positive.push(...asStringArray(meta.description));
    positive.push(...asStringArray(intent.primary));
    positive.push(...asStringArray(scope.included));
    positive.push(...asStringArray(success.leading));
    positive.push(...asStringArray(success.lagging));
    negative.push(...asStringArray(scope.excluded));
  }

  const posPhrases = uniq(positive.map(normalizeFitText).filter(x => x.length >= 4)).sort();
  const negPhrases = uniq(negative.map(normalizeFitText).filter(x => x.length >= 4)).sort();

  const posTokenSet = new Set();
  const negTokenSet = new Set();
  for (const p of posPhrases) for (const t of tokenizeFitText(p)) posTokenSet.add(t);
  for (const p of negPhrases) for (const t of tokenizeFitText(p)) negTokenSet.add(t);
  for (const t of posTokenSet) if (negTokenSet.has(t)) negTokenSet.delete(t);
  const strategy = strategyProfile();

  return {
    available: ids.length > 0 && posTokenSet.size > 0,
    strategy_id: strategy && strategy.id ? String(strategy.id) : null,
    strategy_tokens: strategyMarkerTokens(strategy),
    active_directive_ids: uniq(ids.filter(Boolean)).sort(),
    positive_phrases: posPhrases,
    negative_phrases: negPhrases,
    positive_tokens: Array.from(posTokenSet).sort(),
    negative_tokens: Array.from(negTokenSet).sort()
  };
}

function sourceEyeId(proposal) {
  const metaEye = normalizeText(proposal && proposal.meta && proposal.meta.source_eye);
  if (metaEye) return metaEye;
  if (Array.isArray(proposal && proposal.evidence)) {
    for (const ev of proposal.evidence) {
      const ref = normalizeText(ev && ev.evidence_ref);
      const m = ref.match(/\beye:([^\s]+)/);
      if (m) return normalizeText(m[1]);
    }
  }
  return 'unknown_eye';
}

function sanitizeDirectiveObjectiveId(v) {
  const id = normalizeText(v);
  if (!id) return '';
  if (!DIRECTIVE_OBJECTIVE_ID_RE.test(id)) return '';
  return id;
}

function activeDirectiveObjectiveIds(profile) {
  const ids = Array.isArray(profile && profile.active_directive_ids)
    ? profile.active_directive_ids
    : [];
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    const clean = sanitizeDirectiveObjectiveId(id);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  out.sort();
  return out;
}

function parseObjectiveIdFromEvidence(proposal, objectiveSet) {
  const evidence = Array.isArray(proposal && proposal.evidence) ? proposal.evidence : [];
  for (const row of evidence) {
    const ref = normalizeText(row && row.evidence_ref);
    if (!ref) continue;
    const pulseMatch = ref.match(/directive_pulse\/([A-Za-z0-9_]+)/i);
    const directiveMatch = ref.match(/\bdirective:([A-Za-z0-9_]+)/i);
    const fallbackMatch = ref.match(/\b(T[0-9]_[A-Za-z0-9_]+)\b/);
    const raw = normalizeText(
      (pulseMatch && pulseMatch[1])
      || (directiveMatch && directiveMatch[1])
      || (fallbackMatch && fallbackMatch[1])
    );
    const id = sanitizeDirectiveObjectiveId(raw);
    if (!id) continue;
    if (objectiveSet.size > 0 && !objectiveSet.has(id)) continue;
    return { objective_id: id, source: 'evidence_ref' };
  }
  return null;
}

function parseObjectiveIdFromCommand(proposal, objectiveSet) {
  const cmd = normalizeText(proposal && proposal.suggested_next_command);
  if (!cmd) return null;
  const match = cmd.match(/(?:^|\s)--id=(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const raw = normalizeText(match && (match[1] || match[2] || match[3]));
  const id = sanitizeDirectiveObjectiveId(raw);
  if (!id) return null;
  if (objectiveSet.size > 0 && !objectiveSet.has(id)) return null;
  return { objective_id: id, source: 'suggested_next_command' };
}

function isExecutableProposal(proposal) {
  const nextCmd = normalizeText(proposal && proposal.suggested_next_command);
  const actionSpec = proposal && proposal.action_spec && typeof proposal.action_spec === 'object'
    ? proposal.action_spec
    : null;
  return !!(nextCmd || actionSpec);
}

function resolveObjectiveBinding(proposal, directiveObjectiveIds) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  const actionSpec = p.action_spec && typeof p.action_spec === 'object' ? p.action_spec : {};
  const objectiveSet = new Set(Array.isArray(directiveObjectiveIds) ? directiveObjectiveIds : []);
  const executable = isExecutableProposal(p);
  const required = AUTONOMY_OBJECTIVE_BINDING_REQUIRED && executable && objectiveSet.size > 0;

  const directCandidates = [
    { source: 'meta.objective_id', value: meta.objective_id },
    { source: 'meta.directive_objective_id', value: meta.directive_objective_id },
    { source: 'action_spec.objective_id', value: actionSpec.objective_id },
    {
      source: 'meta.action_spec.objective_id',
      value: meta.action_spec && typeof meta.action_spec === 'object' ? meta.action_spec.objective_id : ''
    }
  ];

  let chosen = null;
  for (const row of directCandidates) {
    const id = sanitizeDirectiveObjectiveId(row && row.value);
    if (!id) continue;
    if (objectiveSet.size > 0 && !objectiveSet.has(id)) {
      chosen = { objective_id: id, source: row.source, valid: false };
      break;
    }
    chosen = { objective_id: id, source: row.source, valid: true };
    break;
  }

  if (!chosen) {
    const ev = parseObjectiveIdFromEvidence(p, objectiveSet);
    if (ev) chosen = { ...ev, valid: true };
  }
  if (!chosen) {
    const cmd = parseObjectiveIdFromCommand(p, objectiveSet);
    if (cmd) chosen = { ...cmd, valid: true };
  }
  if (!chosen && objectiveSet.size === 1) {
    const [only] = Array.from(objectiveSet);
    chosen = { objective_id: only, source: 'single_active_objective', valid: true };
  }
  if (!chosen && required && objectiveSet.size > 1) {
    const [first] = Array.from(objectiveSet).sort((a, b) => String(a).localeCompare(String(b)));
    if (first) chosen = { objective_id: first, source: 'default_first_active_objective', valid: true };
  }

  const objectiveId = chosen ? String(chosen.objective_id || '') : '';
  const inObjectiveSet = objectiveId && objectiveSet.has(objectiveId);
  const bindingValid = objectiveId
    ? (objectiveSet.size === 0 ? true : (chosen.valid !== false && inObjectiveSet))
    : !required;

  let reason = 'not_required';
  if (required && !objectiveId) reason = 'missing_objective_binding';
  else if (required && !bindingValid) reason = 'invalid_objective_binding';
  else if (objectiveId && bindingValid) reason = 'objective_bound';

  return {
    objective_id: objectiveId || '',
    directive_objective_id: objectiveId || '',
    binding_required: required,
    binding_valid: bindingValid,
    binding_source: chosen ? String(chosen.source || '') : '',
    reason,
    active_objectives: Array.from(objectiveSet).slice(0, 8)
  };
}

function actionVerbFromText(text) {
  const m = normalizeText(text).match(ACTION_VERB_RE);
  return m ? String(m[1] || '').toLowerCase() : '';
}

function titleSansPrefix(title) {
  return normalizeText(title).replace(/^\[[^\]]+\]\s*/g, '');
}

function compactObjective(text, maxLen = 110) {
  const clean = normalizeText(text)
    .replace(/[;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen).replace(/\s+\S*$/, '').trim();
}

function normalizedValidationMetric(proposal) {
  const validation = Array.isArray(proposal && proposal.validation) ? proposal.validation : [];
  if (validation.length) {
    const first = normalizeText(validation[0]).replace(/[.]+$/g, '');
    if (first) return first.slice(0, 120);
  }
  const cmd = normalizeText(proposal && proposal.suggested_next_command);
  if (cmd.includes('--dry-run')) return 'route dry-run completes with verifiable artifact';
  return 'proposal execution emits measurable artifact or outcome receipt';
}

function parseSuccessCriteriaRows(proposal) {
  const rows = compileProposalSuccessCriteria(proposal, {
    include_verify: true,
    include_validation: false,
    allow_fallback: false
  });
  return rows.map((row) => ({
    source: String(row.source || ''),
    metric: String(row.metric || '').toLowerCase(),
    target: normalizeText(
      [
        String(row.metric || ''),
        String(row.target || ''),
        String(row.horizon || '')
      ].filter(Boolean).join(' | ')
    ).slice(0, 180),
    measurable: row.measurable === true
  }));
}

function dedupeCriteriaRows(rows) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const metric = normalizeText(row && row.metric).toLowerCase();
    const target = normalizeText(row && row.target);
    const horizon = normalizeText(row && row.horizon);
    if (!metric) continue;
    const key = `${metric}|${target.toLowerCase()}|${horizon.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ metric, target: target || metric, horizon });
  }
  return out;
}

function hardenProposalSuccessCriteria(proposal, outcomePolicy) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const criteriaPolicy = successCriteriaRequirement(outcomePolicy);
  const proposalType = normalizeText(p.type).toLowerCase();
  const nextCmd = normalizeText(p.suggested_next_command);
  const actionSpecIn = p.action_spec && typeof p.action_spec === 'object' ? p.action_spec : null;
  const executable = !!(nextCmd || actionSpecIn);
  const exempt = executable && isSuccessCriteriaExemptProposal(proposalType, criteriaPolicy);
  const required = executable && criteriaPolicy.required && !exempt;

  const compiled = compileProposalSuccessCriteria(p, {
    include_verify: true,
    include_validation: true,
    allow_fallback: false
  });
  const compiledRows = dedupeCriteriaRows(compiled.map((row) => ({
    metric: normalizeText(row && row.metric).toLowerCase(),
    target: normalizeText(row && row.target),
    horizon: normalizeText(row && row.horizon)
  })));
  const knownMetricCount = compiledRows.filter((row) => EVALUABLE_SUCCESS_METRICS.has(row.metric)).length;

  let rowsOut = compiledRows.slice();
  let addedFallbackRows = 0;
  let hardeningApplied = false;
  let hardeningReason = '';
  const textBlob = normalizeFitText([
    p.title,
    p.summary,
    p.notes,
    p.expected_impact,
    nextCmd,
    Array.isArray(p.validation) ? p.validation.join(' ') : ''
  ].join(' '));
  const allowFallback = ACTION_VERB_RE.test(normalizeText(p.title))
    || OPPORTUNITY_MARKER_RE.test(textBlob)
    || CONCRETE_TARGET_RE.test(textBlob);
  const allowHardening = allowFallback && !isMetaNoopCandidate(p, textBlob);

  if (required && allowHardening && rowsOut.length < criteriaPolicy.min_count) {
    for (const row of CRITERIA_HARDENING_ROWS) {
      if (rowsOut.length >= criteriaPolicy.min_count) break;
      const exists = rowsOut.some((it) => it.metric === row.metric);
      if (exists) continue;
      rowsOut.push({ ...row });
      addedFallbackRows += 1;
    }
    hardeningApplied = addedFallbackRows > 0;
    hardeningReason = hardeningApplied ? 'criteria_hardening_applied' : '';
  }

  rowsOut = dedupeCriteriaRows(rowsOut);
  const actionSpecOut = rowsOut.length > 0
    ? {
        ...(actionSpecIn || {}),
        success_criteria: rowsOut
      }
    : actionSpecIn;

  const proposalOut = actionSpecOut
    ? { ...p, action_spec: actionSpecOut }
    : p;

  return {
    proposal: proposalOut,
    meta: {
      required,
      exempt,
      executable,
      min_count: criteriaPolicy.min_count,
      compiled_count: compiledRows.length,
      final_count: rowsOut.length,
      known_metric_count: knownMetricCount,
      unknown_metric_count: Math.max(0, compiledRows.length - knownMetricCount),
      fallback_rows_added: addedFallbackRows,
      hardening_applied: hardeningApplied,
      hardening_reason: hardeningReason || null
    }
  };
}

function successCriteriaRequirement(outcomePolicy) {
  const src = outcomePolicy && outcomePolicy.proposal_filter_policy && typeof outcomePolicy.proposal_filter_policy === 'object'
    ? outcomePolicy.proposal_filter_policy
    : {};
  const required = src.require_success_criteria !== false;
  const minCount = Number.isFinite(Number(src.min_success_criteria_count))
    ? clamp(src.min_success_criteria_count, 0, 5)
    : 1;
  const fromPolicy = parseLowerList(
    src.success_criteria_exempt_types
      || src.success_criteria_exempt_proposal_types
      || src.exempt_success_criteria_types
      || []
  );
  const fromEnv = parseLowerList(process.env.AUTONOMY_SUCCESS_CRITERIA_EXEMPT_TYPES || '');
  const exemptTypes = uniq([...fromPolicy, ...fromEnv]);
  const rawWeights = src.success_criteria_metric_weights && typeof src.success_criteria_metric_weights === 'object'
    ? src.success_criteria_metric_weights
    : {};
  const metricWeights = {};
  for (const [key, value] of Object.entries(rawWeights)) {
    const metric = normalizeText(key).toLowerCase();
    if (!metric) continue;
    const raw = Number(value);
    if (!Number.isFinite(raw)) continue;
    metricWeights[metric] = clamp(raw, 0.2, 2);
  }
  return { required, min_count: minCount, exempt_types: exemptTypes, metric_weights: metricWeights };
}

function isSuccessCriteriaExemptProposal(type, criteriaPolicy) {
  const proposalType = normalizeText(type).toLowerCase();
  if (!proposalType) return false;
  const exemptTypes = Array.isArray(criteriaPolicy && criteriaPolicy.exempt_types)
    ? criteriaPolicy.exempt_types
    : [];
  return exemptTypes.includes(proposalType);
}

function weightedCriteriaCount(rows, criteriaPolicy) {
  const list = Array.isArray(rows) ? rows : [];
  const weights = criteriaPolicy && criteriaPolicy.metric_weights && typeof criteriaPolicy.metric_weights === 'object'
    ? criteriaPolicy.metric_weights
    : {};
  let measurableCount = 0;
  let weightedCount = 0;
  for (const row of list) {
    if (!row || row.measurable !== true) continue;
    measurableCount += 1;
    const metric = normalizeText(row.metric).toLowerCase();
    const hasMetricWeight = metric && Object.prototype.hasOwnProperty.call(weights, metric);
    const w = hasMetricWeight ? clamp(Number(weights[metric]), 0.2, 2) : 1;
    weightedCount += Number.isFinite(w) ? w : 1;
  }
  return {
    measurable_count: measurableCount,
    weighted_count: Number(weightedCount.toFixed(3))
  };
}

function inferArchetypeHints(text) {
  const hits = [];
  const hints = new Set();
  for (const rule of ARCHETYPE_RULES) {
    if (rule.regex.test(text)) {
      hits.push(rule.key);
      for (const h of rule.hints) hints.add(h);
    }
  }
  if (!hits.length) {
    hits.push('general');
    hints.add('systems');
    hints.add('automation');
  }
  return { archetypes: hits, hints: Array.from(hints).sort() };
}

function normalizeProposalForAdmission(proposal) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  const typeDecision = classifyProposalType(p, {
    source_eye: sourceEyeId(p) || normalizeText(meta.source_eye)
  });
  const proposalType = normalizeText(typeDecision.type).toLowerCase() || 'local_state_fallback';
  const title = titleSansPrefix(p.title);
  const combinedText = [
    title,
    proposalType,
    p.summary,
    p.notes,
    p.expected_impact,
    p.suggested_next_command,
    Array.isArray(p.validation) ? p.validation.join(' ') : '',
    Array.isArray(p.evidence) ? p.evidence.map(ev => normalizeText(ev && ev.match)).join(' ') : ''
  ].join(' ');

  const { archetypes, hints } = inferArchetypeHints(combinedText);
  const actionVerb = actionVerbFromText(`${title} ${p.suggested_next_command || ''}`) || 'improve';
  const objectiveSeed = compactObjective(title) || compactObjective(`${p.type || 'proposal'} outcome quality`);
  const objective = compactObjective(`${actionVerb} ${objectiveSeed}`.replace(/\s+/g, ' ').trim(), 120);

  const expectedOutcome = normalizeText(meta.normalized_expected_outcome || '')
    || `Increase ${hints.slice(0, 2).join(' and ')} with measurable, low-risk execution.`;
  const validationMetric = normalizeText(meta.normalized_validation_metric || '')
    || normalizedValidationMetric(p);

  const summary = normalizeText(p.summary) || `${objective}. Outcome: ${expectedOutcome}`;
  const notes = normalizeText(p.notes)
    || `Objective=${objective}; Metric=${validationMetric}; Archetypes=${archetypes.join(',')}; Hints=${hints.join(',')}`;

  return {
    ...p,
    type: proposalType,
    summary,
    notes,
    meta: {
      ...meta,
      source_eye: sourceEyeId(p) || normalizeText(meta.source_eye) || 'unknown_eye',
      normalized_proposal_type: proposalType,
      proposal_type_source: String(typeDecision.source || ''),
      proposal_type_inferred: typeDecision.inferred === true,
      normalized_action_verb: actionVerb,
      normalized_objective: objective,
      normalized_expected_outcome: expectedOutcome.slice(0, 180),
      normalized_validation_metric: validationMetric.slice(0, 140),
      normalized_archetypes: archetypes.slice(0, 5),
      normalized_hint_tokens: hints.slice(0, 8),
      normalization_version: '1.0'
    }
  };
}

function normalizedRisk(v) {
  const r = normalizeText(v).toLowerCase();
  if (r === 'high' || r === 'medium' || r === 'low') return r;
  return 'low';
}

function proposalTextBlob(proposal) {
  const p = proposal || {};
  const bits = [
    p.title,
    p.type,
    p.summary,
    p.notes,
    p.suggested_next_command
  ];
  if (Array.isArray(p.validation)) bits.push(p.validation.join(' '));
  if (Array.isArray(p.evidence)) {
    for (const ev of p.evidence) bits.push(ev && ev.match, ev && ev.evidence_ref);
  }
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  bits.push(meta.preview, meta.url);
  bits.push(
    meta.normalized_objective,
    meta.normalized_expected_outcome,
    meta.normalized_validation_metric
  );
  if (Array.isArray(meta.normalized_hint_tokens)) bits.push(meta.normalized_hint_tokens.join(' '));
  if (Array.isArray(meta.normalized_archetypes)) bits.push(meta.normalized_archetypes.join(' '));
  if (Array.isArray(meta.topics)) bits.push(meta.topics.join(' '));
  return normalizeFitText(bits.filter(Boolean).join(' '));
}

function firstSentenceText(v) {
  const raw = normalizeText(v);
  if (!raw) return '';
  const cut = raw.search(/[.!?\n]/);
  const sentence = cut >= 0 ? raw.slice(0, cut) : raw;
  return normalizeFitText(sentence);
}

function proposalFirstSentenceBlob(proposal) {
  const p = proposal || {};
  const candidates = [
    p.summary,
    p.title,
    p.notes,
    p.suggested_next_command,
    Array.isArray(p.validation) ? p.validation[0] : ''
  ];
  for (const row of candidates) {
    const s = firstSentenceText(row);
    if (s) return s;
  }
  return '';
}

function normalizeValueCurrency(v) {
  const key = normalizeText(v).toLowerCase();
  if (!key) return '';
  if (!VALUE_CURRENCY_KEYS.has(key)) return '';
  return key;
}

function uniqValueCurrencies(rows, fallback = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = normalizeValueCurrency(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  if (out.length === 0) {
    for (const row of fallback) {
      const key = normalizeValueCurrency(row);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  if (out.includes('revenue')) {
    out.splice(out.indexOf('revenue'), 1);
    out.unshift('revenue');
  }
  return out.slice(0, 6);
}

function isDreamOriginProposal(proposal) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const type = normalizeText(p.type).toLowerCase();
  if (type.includes('dream')) return true;
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  const metaBits = [
    meta.source,
    meta.origin,
    meta.generator,
    meta.source_eye,
    meta.pain_source,
    meta.pain_code
  ];
  for (const bit of metaBits) {
    const value = normalizeFitText(bit);
    if (value && DREAM_ORIGIN_RE.test(value)) return true;
  }
  const evidence = Array.isArray(p.evidence) ? p.evidence : [];
  for (const ev of evidence) {
    const bits = [
      ev && ev.evidence_ref,
      ev && ev.source,
      ev && ev.path,
      ev && ev.match
    ];
    for (const bit of bits) {
      const value = normalizeFitText(bit);
      if (!value) continue;
      if (value.startsWith('dream')) return true;
      if (DREAM_ORIGIN_RE.test(value)) return true;
    }
  }
  return false;
}

function inferDirectiveValueCurrencies(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const bits = []
    .concat(Array.isArray(p.positive_phrases) ? p.positive_phrases : [])
    .concat(Array.isArray(p.strategy_tokens) ? p.strategy_tokens : [])
    .concat(Array.isArray(p.positive_tokens) ? p.positive_tokens : [])
    .concat(Array.isArray(p.active_directive_ids) ? p.active_directive_ids : []);
  const blob = normalizeFitText(bits.join(' '));
  const inferred = [];
  if (VALUE_SIGNAL_REVENUE_RE.test(blob) || /\b(income|moneti[sz]|billion|cashflow)\b/.test(blob)) inferred.push('revenue');
  if (VALUE_SIGNAL_DELIVERY_RE.test(blob) || /\b(milestone|roadmap|deliverable|prototype)\b/.test(blob)) inferred.push('delivery');
  if (VALUE_SIGNAL_USER_RE.test(blob) || /\b(adoption|engagement|retention|satisfaction|onboarding)\b/.test(blob)) inferred.push('user_value');
  if (VALUE_SIGNAL_QUALITY_RE.test(blob) || /\b(defect|incident|regression|availability|quality)\b/.test(blob)) inferred.push('quality');
  if (VALUE_SIGNAL_TIME_RE.test(blob) || /\b(turnaround|efficien(?:cy|t)|automation|speed)\b/.test(blob)) inferred.push('time_savings');
  if (VALUE_SIGNAL_LEARNING_RE.test(blob) || /\b(discovery|research|insight|ab[\s_-]?test)\b/.test(blob)) inferred.push('learning');
  const defaults = AUTONOMY_VALUE_ORACLE_DEFAULT_CURRENCIES.length > 0
    ? AUTONOMY_VALUE_ORACLE_DEFAULT_CURRENCIES
    : ['revenue', 'delivery'];
  return {
    currencies: uniqValueCurrencies(inferred, defaults),
    source: inferred.length > 0 ? 'directive_profile' : 'default'
  };
}

function valueCurrencySignals(currency, firstSentence, blob, meta) {
  const c = normalizeValueCurrency(currency);
  const m = meta && typeof meta === 'object' ? meta : {};
  if (c === 'revenue') {
    const first = VALUE_SIGNAL_REVENUE_RE.test(firstSentence);
    const any = first
      || VALUE_SIGNAL_REVENUE_RE.test(blob)
      || VALUE_SIGNAL_EXTERNAL_RE.test(blob)
      || Number.isFinite(Number(m.expected_value_score))
      || Number.isFinite(Number(m.expected_value_usd));
    return { first_sentence: first, any_signal: any };
  }
  if (c === 'delivery') {
    const first = VALUE_SIGNAL_DELIVERY_RE.test(firstSentence);
    const any = first || VALUE_SIGNAL_DELIVERY_RE.test(blob);
    return { first_sentence: first, any_signal: any };
  }
  if (c === 'user_value') {
    const first = VALUE_SIGNAL_USER_RE.test(firstSentence);
    const any = first || VALUE_SIGNAL_USER_RE.test(blob) || VALUE_SIGNAL_EXTERNAL_RE.test(blob);
    return { first_sentence: first, any_signal: any };
  }
  if (c === 'quality') {
    const first = VALUE_SIGNAL_QUALITY_RE.test(firstSentence);
    const any = first
      || VALUE_SIGNAL_QUALITY_RE.test(blob)
      || Number.isFinite(Number(m.signal_quality_score));
    return { first_sentence: first, any_signal: any };
  }
  if (c === 'time_savings') {
    const first = VALUE_SIGNAL_TIME_RE.test(firstSentence);
    const any = first
      || VALUE_SIGNAL_TIME_RE.test(blob)
      || Number.isFinite(Number(m.time_to_cash_hours));
    return { first_sentence: first, any_signal: any };
  }
  if (c === 'learning') {
    const first = VALUE_SIGNAL_LEARNING_RE.test(firstSentence);
    const any = first || VALUE_SIGNAL_LEARNING_RE.test(blob);
    return { first_sentence: first, any_signal: any };
  }
  return { first_sentence: false, any_signal: false };
}

function valueOracleScope(proposal, isMetaNoop) {
  if (!AUTONOMY_VALUE_ORACLE_REQUIRED) {
    return { applies: false, scope: 'disabled' };
  }
  const type = normalizeText(proposal && proposal.type).toLowerCase();
  if (type && AUTONOMY_VALUE_ORACLE_EXEMPT_TYPES.has(type)) {
    return { applies: false, scope: 'exempt_type' };
  }
  if (AUTONOMY_VALUE_ORACLE_SCOPE.has('all')) {
    return { applies: true, scope: 'all' };
  }
  if (AUTONOMY_VALUE_ORACLE_SCOPE.has('dream') && isDreamOriginProposal(proposal)) {
    return { applies: true, scope: 'dream' };
  }
  if (AUTONOMY_VALUE_ORACLE_SCOPE.has('meta') && isMetaNoop === true) {
    return { applies: true, scope: 'meta' };
  }
  return { applies: false, scope: 'out_of_scope' };
}

function valueOracleDecision(proposal, blobHint, isMetaNoop, directiveProfile) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  const scope = valueOracleScope(p, isMetaNoop === true);
  const currencyProfile = inferDirectiveValueCurrencies(directiveProfile);
  const blob = normalizeFitText(blobHint || proposalTextBlob(p));
  const firstSentence = proposalFirstSentenceBlob(p);
  const activeCurrencies = currencyProfile.currencies;
  const primaryCurrency = activeCurrencies.length > 0 ? activeCurrencies[0] : null;
  const signalsByCurrency: AnyObj = {};
  const matchedCurrencies = [];
  const firstSentenceCurrencies = [];
  let weightedTotal = 0;
  let weightedMatched = 0;
  let weightedFirst = 0;
  for (const currency of activeCurrencies) {
    const signals = valueCurrencySignals(currency, firstSentence, blob, meta);
    const weight = Number(VALUE_CURRENCY_WEIGHTS[currency] || 1);
    signalsByCurrency[currency] = signals;
    weightedTotal += weight;
    if (signals.any_signal) {
      matchedCurrencies.push(currency);
      weightedMatched += weight;
    }
    if (signals.first_sentence) {
      firstSentenceCurrencies.push(currency);
      weightedFirst += weight;
    }
  }
  const canSimulateFirst = VALUE_SIMULATION_RE.test(blob)
    || normalizeText(p.suggested_next_command).includes('--dry-run');
  const hasFirstSentenceValue = firstSentenceCurrencies.length > 0;
  const hasExternalValue = matchedCurrencies.length > 0;

  let pass = true;
  let reason = null;
  if (scope.applies && !hasExternalValue) {
    pass = false;
    reason = 'value_oracle_no_currency_signal';
  } else if (scope.applies && !hasFirstSentenceValue) {
    pass = false;
    reason = 'value_oracle_first_sentence_missing';
  } else if (
    scope.applies
    && AUTONOMY_VALUE_ORACLE_REQUIRE_PRIMARY_SIGNAL
    && primaryCurrency
    && !firstSentenceCurrencies.includes(primaryCurrency)
  ) {
    pass = false;
    reason = 'value_oracle_primary_currency_missing';
  }
  const priorityRaw = weightedTotal > 0
    ? ((weightedMatched + (weightedFirst * 0.25)) / (weightedTotal * 1.25)) * 100
    : 0;
  const priorityScore = clamp(Math.round(priorityRaw), 0, 100);
  const revenueSignals = signalsByCurrency.revenue || { first_sentence: false, any_signal: false };
  const userSignals = signalsByCurrency.user_value || { first_sentence: false, any_signal: false };
  const externalSignals = {
    first_sentence: VALUE_SIGNAL_EXTERNAL_RE.test(firstSentence),
    any_signal: VALUE_SIGNAL_EXTERNAL_RE.test(blob)
  };
  const timeSignals = signalsByCurrency.time_savings || { first_sentence: false, any_signal: false };
  const touchesMoney = revenueSignals.first_sentence
    || Number.isFinite(Number(meta.expected_value_usd || meta.expected_value_score));
  const touchesCustomer = userSignals.first_sentence;
  const touchesExternalValue = externalSignals.first_sentence || externalSignals.any_signal;
  const reducesTimeToRevenue = timeSignals.first_sentence
    || Number.isFinite(Number(meta.time_to_cash_hours));

  if (primaryCurrency === 'revenue' && touchesMoney) {
    reason = reason || null;
  }

  return {
    enabled: AUTONOMY_VALUE_ORACLE_REQUIRED,
    applies: scope.applies,
    scope: scope.scope,
    source: currencyProfile.source,
    pass,
    reason,
    first_sentence: firstSentence.slice(0, 180),
    active_currencies: activeCurrencies,
    primary_currency: primaryCurrency,
    matched_currencies: matchedCurrencies,
    matched_first_sentence_currencies: firstSentenceCurrencies,
    currency_signals: signalsByCurrency,
    priority_score: priorityScore,
    touches_money: touchesMoney,
    touches_customer_or_user: touchesCustomer,
    touches_external_value: touchesExternalValue,
    reduces_time_to_revenue: reducesTimeToRevenue,
    can_simulate_first: canSimulateFirst
  };
}

function firstFinitePositiveNumber(values) {
  for (const value of values || []) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) continue;
    return n;
  }
  return null;
}

function parseHoursLike(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const text = normalizeText(value).toLowerCase();
  if (!text) return null;
  const m = text.match(/^(-?\d+(?:\.\d+)?)\s*(h|hr|hour|hours|d|day|days)?$/i);
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base) || base <= 0) return null;
  const unit = String(m[2] || 'h').toLowerCase();
  if (unit === 'd' || unit === 'day' || unit === 'days') return base * 24;
  return base;
}

function parseFutureHoursFromTimestamp(values) {
  const now = Date.now();
  for (const value of values || []) {
    const text = normalizeText(value);
    if (!text) continue;
    const ts = Date.parse(text);
    if (!Number.isFinite(ts)) continue;
    const deltaHours = (ts - now) / 3600000;
    if (deltaHours > 0) return deltaHours;
  }
  return null;
}

function parseDaysFieldToHours(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric * 24;
  const text = normalizeText(value).toLowerCase();
  if (!text) return null;
  const m = text.match(/^(-?\d+(?:\.\d+)?)\s*(d|day|days|h|hr|hour|hours)?$/i);
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base) || base <= 0) return null;
  const unit = String(m[2] || 'day').toLowerCase();
  if (unit === 'h' || unit === 'hr' || unit === 'hour' || unit === 'hours') return base;
  return base * 24;
}

function hasAdaptiveMutationSignal(proposal) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const type = normalizeText(p.type).toLowerCase();
  if (type && ADAPTIVE_MUTATION_TYPE_RE.test(type)) return true;
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  const actionSpec = p.action_spec && typeof p.action_spec === 'object' ? p.action_spec : {};
  if (
    meta.adaptive_mutation === true
    || meta.mutation_proposal === true
    || meta.topology_mutation === true
    || meta.self_improvement_change === true
  ) {
    return true;
  }
  const blob = normalizeFitText([
    p.title,
    p.summary,
    p.notes,
    p.suggested_next_command,
    actionSpec.kind,
    actionSpec.target,
    actionSpec.mutation_kind,
    actionSpec.mutation_target,
    actionSpec.topology_action,
    actionSpec.genome_action,
    actionSpec.self_modify_scope,
    meta.mutation_kind,
    meta.mutation_target,
    meta.mutation_reason,
    meta.mutation_lineage_id,
    meta.topology_action,
    meta.genome_action,
    meta.self_modify_scope
  ].join(' '));
  if (!blob) return false;
  return ADAPTIVE_MUTATION_SIGNAL_RE.test(blob);
}

function adaptiveMutationGuardDecision(proposal) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  const actionSpec = p.action_spec && typeof p.action_spec === 'object' ? p.action_spec : {};
  const applies = AUTONOMY_MUTATION_GUARD_REQUIRED && hasAdaptiveMutationSignal(p);
  if (!AUTONOMY_MUTATION_GUARD_REQUIRED) {
    return {
      enabled: false,
      required: false,
      kernel_required: false,
      applies: false,
      pass: true,
      reason: null,
      reasons: [],
      controls: {},
      thresholds: {}
    };
  }
  if (!applies) {
    return {
      enabled: true,
      required: true,
      kernel_required: AUTONOMY_MUTATION_KERNEL_REQUIRED,
      applies: false,
      pass: true,
      reason: null,
      reasons: [],
      controls: {},
      thresholds: {
        budget_cap_max: AUTONOMY_MUTATION_BUDGET_CAP_MAX,
        ttl_hours_max: AUTONOMY_MUTATION_TTL_HOURS_MAX,
        quarantine_hours_min: AUTONOMY_MUTATION_QUARANTINE_HOURS_MIN,
        veto_window_hours_min: AUTONOMY_MUTATION_VETO_WINDOW_HOURS_MIN,
        mutation_kernel_required: AUTONOMY_MUTATION_KERNEL_REQUIRED
      }
    };
  }

  const reasons = [];

  const safetyAttestation = normalizeText(
    meta.safety_attestation_id
    || meta.safety_attestation
    || meta.attestation_id
    || meta.attestation_hash
    || meta.integrity_attestation_id
    || actionSpec.safety_attestation_id
    || actionSpec.attestation_id
    || actionSpec.integrity_attestation_id
  );
  const safetyAttestationPresent = !!safetyAttestation;
  if (!safetyAttestationPresent) reasons.push('adaptive_mutation_missing_safety_attestation');

  const budgetCap = firstFinitePositiveNumber([
    meta.mutation_budget_cap,
    meta.adaptive_mutation_budget_cap,
    meta.budget_cap,
    actionSpec.mutation_budget_cap,
    actionSpec.budget_cap
  ]);
  if (budgetCap == null) reasons.push('adaptive_mutation_missing_budget_cap');
  else if (budgetCap > AUTONOMY_MUTATION_BUDGET_CAP_MAX) reasons.push('adaptive_mutation_budget_cap_exceeds_max');

  const ttlHoursFromNumeric = firstFinitePositiveNumber([
    parseHoursLike(meta.mutation_ttl_hours),
    parseHoursLike(meta.adaptive_mutation_ttl_hours),
    parseHoursLike(meta.ttl_hours),
    parseHoursLike(meta.lease_ttl_hours),
    parseHoursLike(actionSpec.mutation_ttl_hours),
    parseHoursLike(actionSpec.ttl_hours),
    parseHoursLike(actionSpec.lease_ttl_hours)
  ]);
  const ttlHoursFromExpiry = parseFutureHoursFromTimestamp([
    meta.mutation_expires_at,
    meta.expires_at,
    meta.lease_expires_at,
    actionSpec.mutation_expires_at,
    actionSpec.expires_at,
    actionSpec.lease_expires_at
  ]);
  const ttlHours = ttlHoursFromNumeric != null ? ttlHoursFromNumeric : ttlHoursFromExpiry;
  if (ttlHours == null) reasons.push('adaptive_mutation_missing_ttl');
  else if (ttlHours > AUTONOMY_MUTATION_TTL_HOURS_MAX) reasons.push('adaptive_mutation_ttl_exceeds_max');

  const quarantineHours = firstFinitePositiveNumber([
    parseHoursLike(meta.mutation_quarantine_hours),
    parseHoursLike(meta.quarantine_hours),
    parseHoursLike(meta.quarantine_window_hours),
    parseDaysFieldToHours(meta.mutation_quarantine_days),
    parseDaysFieldToHours(meta.quarantine_days),
    parseHoursLike(actionSpec.mutation_quarantine_hours),
    parseHoursLike(actionSpec.quarantine_hours),
    parseHoursLike(actionSpec.quarantine_window_hours),
    parseDaysFieldToHours(actionSpec.mutation_quarantine_days),
    parseDaysFieldToHours(actionSpec.quarantine_days)
  ]);
  if (quarantineHours == null) reasons.push('adaptive_mutation_missing_quarantine_window');
  else if (quarantineHours < AUTONOMY_MUTATION_QUARANTINE_HOURS_MIN) reasons.push('adaptive_mutation_quarantine_window_too_short');

  const vetoWindowHours = firstFinitePositiveNumber([
    parseHoursLike(meta.mutation_veto_window_hours),
    parseHoursLike(meta.veto_window_hours),
    parseDaysFieldToHours(meta.veto_window_days),
    parseHoursLike(actionSpec.mutation_veto_window_hours),
    parseHoursLike(actionSpec.veto_window_hours),
    parseDaysFieldToHours(actionSpec.veto_window_days)
  ]);
  if (vetoWindowHours == null) reasons.push('adaptive_mutation_missing_veto_window');
  else if (vetoWindowHours < AUTONOMY_MUTATION_VETO_WINDOW_HOURS_MIN) reasons.push('adaptive_mutation_veto_window_too_short');

  const rollbackReceipt = normalizeText(
    meta.rollback_receipt_id
    || meta.rollback_receipt_path
    || meta.rollback_receipt
    || actionSpec.rollback_receipt_id
    || actionSpec.rollback_receipt_path
    || actionSpec.rollback_receipt
  );
  const rollbackReceiptPresent = !!rollbackReceipt;
  if (!rollbackReceiptPresent) reasons.push('adaptive_mutation_missing_rollback_receipt');

  let kernelDecision = null;
  let kernelPolicyVersion = null;
  if (AUTONOMY_MUTATION_KERNEL_REQUIRED) {
    try {
      const kernelPolicy = loadMutationSafetyKernelPolicy();
      if (kernelPolicy && typeof kernelPolicy === 'object') {
        kernelPolicyVersion = normalizeText(kernelPolicy.version) || null;
      }
      const evaluated = evaluateMutationSafetyEnvelope({ proposal: p, policy: kernelPolicy });
      if (evaluated && typeof evaluated === 'object') {
        kernelDecision = evaluated;
        if (evaluated.applies === true && evaluated.pass === false) {
          const kernelReasons = Array.isArray(evaluated.reasons) ? evaluated.reasons : [];
          for (const reasonRaw of kernelReasons) {
            const reason = normalizeText(reasonRaw);
            if (!reason || reasons.includes(reason)) continue;
            reasons.push(reason);
          }
        }
      }
    } catch (err) {
      reasons.push('adaptive_mutation_kernel_error');
      kernelDecision = {
        applies: true,
        pass: false,
        reason: 'adaptive_mutation_kernel_error',
        reasons: ['adaptive_mutation_kernel_error'],
        error: normalizeText(err && err.message ? err.message : err)
      };
    }
  }

  return {
    enabled: true,
    required: true,
    kernel_required: AUTONOMY_MUTATION_KERNEL_REQUIRED,
    applies,
    pass: reasons.length === 0,
    reason: reasons[0] || null,
    reasons,
    controls: {
      safety_attestation_present: safetyAttestationPresent,
      safety_attestation: safetyAttestationPresent ? safetyAttestation : null,
      budget_cap: budgetCap != null ? Number(budgetCap) : null,
      ttl_hours: ttlHours != null ? Number(ttlHours.toFixed(3)) : null,
      quarantine_hours: quarantineHours != null ? Number(quarantineHours.toFixed(3)) : null,
      veto_window_hours: vetoWindowHours != null ? Number(vetoWindowHours.toFixed(3)) : null,
      rollback_receipt_present: rollbackReceiptPresent,
      rollback_receipt: rollbackReceiptPresent ? rollbackReceipt : null,
      mutation_kernel_applies: !!(kernelDecision && kernelDecision.applies === true),
      mutation_kernel_pass: !(kernelDecision && kernelDecision.pass === false),
      mutation_kernel_risk_score: kernelDecision && Number.isFinite(Number(kernelDecision.risk_score))
        ? Number(kernelDecision.risk_score)
        : null,
      mutation_kernel_promotion_band: kernelDecision && kernelDecision.promotion_band
        ? normalizeText(kernelDecision.promotion_band)
        : null
    },
    thresholds: {
      budget_cap_max: AUTONOMY_MUTATION_BUDGET_CAP_MAX,
      ttl_hours_max: AUTONOMY_MUTATION_TTL_HOURS_MAX,
      quarantine_hours_min: AUTONOMY_MUTATION_QUARANTINE_HOURS_MIN,
      veto_window_hours_min: AUTONOMY_MUTATION_VETO_WINDOW_HOURS_MIN,
      mutation_kernel_required: AUTONOMY_MUTATION_KERNEL_REQUIRED
    },
    kernel_policy_version: kernelPolicyVersion,
    kernel_decision: kernelDecision
  };
}

function hasConcreteDeltaSignal(proposal) {
  const p = proposal || {};
  const nextCmd = normalizeText(p.suggested_next_command);
  const validation = Array.isArray(p.validation) ? p.validation.map((v) => normalizeText(v)).filter(Boolean) : [];
  const actionSpecBlob = p.action_spec && typeof p.action_spec === 'object'
    ? normalizeFitText(JSON.stringify(p.action_spec))
    : '';
  const blob = normalizeFitText([nextCmd, validation.join(' '), actionSpecBlob].join(' '));
  if (!blob) return false;
  return CONCRETE_DELTA_RE.test(blob) && CONCRETE_TARGET_RE.test(blob);
}

function optimizationMinDeltaPercent() {
  if (AUTONOMY_OPTIMIZATION_HIGH_ACCURACY_MODE) return AUTONOMY_OPTIMIZATION_MIN_DELTA_PERCENT_HIGH_ACCURACY;
  return AUTONOMY_OPTIMIZATION_MIN_DELTA_PERCENT;
}

function percentMentionsFromText(text) {
  const blob = String(text || '');
  if (!blob) return [];
  const out = [];
  const re = new RegExp(PERCENT_VALUE_RE.source, 'g');
  let m;
  while ((m = re.exec(blob)) !== null) {
    const raw = Number(m[1]);
    if (!Number.isFinite(raw)) continue;
    if (raw <= 0) continue;
    out.push(clamp(raw, 0, 100));
  }
  return out;
}

function inferOptimizationDelta(proposal) {
  const p = proposal || {};
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const directKeys = [
    'optimization_delta_percent',
    'expected_optimization_percent',
    'expected_delta_percent',
    'estimated_improvement_percent',
    'target_improvement_percent',
    'performance_gain_percent'
  ];
  for (const key of directKeys) {
    const raw = Number(meta[key]);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    return { delta_percent: clamp(raw, 0, 100), delta_source: `meta:${key}` };
  }

  const bits = [
    p.title,
    p.summary,
    p.notes,
    p.suggested_next_command,
    p && p.action_spec && typeof p.action_spec === 'object' ? JSON.stringify(p.action_spec) : '',
    meta.normalized_expected_outcome,
    meta.normalized_validation_metric
  ];
  if (Array.isArray(p.validation)) bits.push(p.validation.join(' '));
  if (Array.isArray(p.success_criteria)) bits.push(JSON.stringify(p.success_criteria));
  if (Array.isArray(meta.success_criteria)) bits.push(JSON.stringify(meta.success_criteria));
  if (Array.isArray(meta.success_criteria_rows)) bits.push(JSON.stringify(meta.success_criteria_rows));

  const pct = percentMentionsFromText(bits.filter(Boolean).join(' '));
  if (pct.length > 0) {
    return { delta_percent: Number(Math.max(...pct).toFixed(3)), delta_source: 'text:%' };
  }
  return { delta_percent: null, delta_source: null };
}

function subDirectiveV2Signals(proposal) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const type = normalizeText(p.type).toLowerCase();
  const actionSpec = p.action_spec && typeof p.action_spec === 'object' ? p.action_spec : {};
  const nextCmd = normalizeText(p.suggested_next_command);
  const executable = !!(nextCmd || (p.action_spec && typeof p.action_spec === 'object'));
  const required = AUTONOMY_SUBDIRECTIVE_V2_REQUIRED
    && executable
    && !AUTONOMY_SUBDIRECTIVE_V2_EXEMPT_TYPES.has(type);

  const targetRows = []
    .concat(normalizeText(actionSpec.target))
    .concat(normalizeText(actionSpec.file))
    .concat(normalizeText(actionSpec.path))
    .concat(Array.isArray(actionSpec.files) ? actionSpec.files.map((row) => normalizeText(row)) : [])
    .filter(Boolean);
  const hasTargetField = targetRows.some((row) => {
    const v = normalizeText(row).toLowerCase();
    if (!v) return false;
    if (CONCRETE_TARGET_RE.test(v)) return true;
    if (v.includes('/')) return true;
    if (v.includes(':')) return true;
    return /\.[a-z0-9]{1,8}$/i.test(v);
  });
  const hasConcreteTarget = hasTargetField || CONCRETE_TARGET_RE.test(proposalTextBlob(p));

  const inferredDelta = inferOptimizationDelta(p);
  const explicitDeltaCandidates = [
    Number(actionSpec.expected_delta_percent),
    Number(actionSpec.delta_percent),
    Number(actionSpec.expected_improvement_percent),
    Number(p.meta && p.meta.expected_delta_percent),
    Number(p.meta && p.meta.optimization_delta_percent)
  ];
  const hasExplicitDelta = explicitDeltaCandidates.some((n) => Number.isFinite(n) && n > 0);
  const successCriteriaRows = Array.isArray(actionSpec.success_criteria) ? actionSpec.success_criteria : [];
  const hasSuccessDelta = successCriteriaRows.some((row) => {
    if (typeof row === 'string') {
      const text = normalizeText(row);
      return /\d/.test(text) || /%|percent|delta|improv|increase|decrease|reduce|faster|slower|>=|<=|>|</i.test(text);
    }
    if (!row || typeof row !== 'object') return false;
    const metric = normalizeText(row.metric || row.name);
    const target = normalizeText(row.target || row.threshold || row.goal || row.description);
    const blob = normalizeText(`${metric} ${target}`);
    return /\d/.test(blob) || /%|percent|delta|improv|increase|decrease|reduce|faster|slower|>=|<=|>|</i.test(blob);
  });
  const hasExpectedDelta = hasConcreteDeltaSignal(p)
    || hasExplicitDelta
    || Number.isFinite(Number(inferredDelta && inferredDelta.delta_percent))
    || hasSuccessDelta;

  const verifyRows = Array.isArray(actionSpec.verify) ? actionSpec.verify : [];
  const validationRows = Array.isArray(p.validation) ? p.validation : [];
  const hasVerificationStep = verifyRows.length > 0 || validationRows.length > 0 || successCriteriaRows.length > 0;

  return {
    required,
    has_concrete_target: hasConcreteTarget,
    has_expected_delta: hasExpectedDelta,
    has_verification_step: hasVerificationStep,
    target_count: targetRows.length,
    verify_count: verifyRows.length,
    success_criteria_count: successCriteriaRows.length
  };
}

function isOptimizationIntentProposal(proposal) {
  const p = proposal || {};
  const type = normalizeText(p.type).toLowerCase();
  const blob = proposalTextBlob(p);
  const hasIntent = OPTIMIZATION_INTENT_RE.test(type) || OPTIMIZATION_INTENT_RE.test(blob);
  if (!hasIntent) return false;
  const hasExemptSignals = OPTIMIZATION_EXEMPT_RE.test(type) || OPTIMIZATION_EXEMPT_RE.test(blob);
  if (hasExemptSignals) return false;
  if (OPPORTUNITY_MARKER_RE.test(blob)) return false;
  return true;
}

function optimizationGateDecision(proposal, risk) {
  const applies = isOptimizationIntentProposal(proposal);
  const minDelta = optimizationMinDeltaPercent();
  const requireDelta = AUTONOMY_OPTIMIZATION_REQUIRE_DELTA;
  if (!applies) {
    return {
      applies: false,
      pass: true,
      reason: null,
      delta_percent: null,
      delta_source: null,
      min_delta_percent: minDelta,
      require_delta: requireDelta,
      mode: AUTONOMY_OPTIMIZATION_HIGH_ACCURACY_MODE ? 'high_accuracy' : 'default',
      risk: normalizeText(risk).toLowerCase() || 'low'
    };
  }
  const inferred = inferOptimizationDelta(proposal);
  if (inferred.delta_percent == null && requireDelta) {
    return {
      applies: true,
      pass: false,
      reason: 'optimization_delta_missing',
      delta_percent: null,
      delta_source: null,
      min_delta_percent: minDelta,
      require_delta: true,
      mode: AUTONOMY_OPTIMIZATION_HIGH_ACCURACY_MODE ? 'high_accuracy' : 'default',
      risk: normalizeText(risk).toLowerCase() || 'low'
    };
  }
  if (Number.isFinite(Number(inferred.delta_percent)) && Number(inferred.delta_percent) < minDelta) {
    return {
      applies: true,
      pass: false,
      reason: 'optimization_good_enough',
      delta_percent: Number(inferred.delta_percent),
      delta_source: inferred.delta_source || null,
      min_delta_percent: minDelta,
      require_delta: requireDelta,
      mode: AUTONOMY_OPTIMIZATION_HIGH_ACCURACY_MODE ? 'high_accuracy' : 'default',
      risk: normalizeText(risk).toLowerCase() || 'low'
    };
  }
  return {
    applies: true,
    pass: true,
    reason: null,
    delta_percent: Number.isFinite(Number(inferred.delta_percent)) ? Number(inferred.delta_percent) : null,
    delta_source: inferred.delta_source || null,
    min_delta_percent: minDelta,
    require_delta: requireDelta,
    mode: AUTONOMY_OPTIMIZATION_HIGH_ACCURACY_MODE ? 'high_accuracy' : 'default',
    risk: normalizeText(risk).toLowerCase() || 'low'
  };
}

function isMetaNoopCandidate(proposal, blobHint) {
  const p = proposal || {};
  const title = normalizeText(p.title).replace(/^\[[^\]]+\]\s*/g, '');
  const summary = normalizeText(p.summary);
  const blob = normalizeFitText([blobHint || '', title, summary].join(' '));
  if (!blob) return false;
  const selfReferential = SELF_REFERENTIAL_SCOPE_RE.test(blob);
  if (OPPORTUNITY_MARKER_RE.test(blob)) return false;
  if (ACTION_VERB_RE.test(blob) && CONCRETE_TARGET_RE.test(blob) && !selfReferential) return false;
  const metaIntent = META_COORDINATION_RE.test(blob) || META_NOOP_INTENT_RE.test(blob);
  return metaIntent || selfReferential;
}

function assessQuality(proposal, eye, t) {
  const p = proposal || {};
  let score = 20;
  const reasons = [];
  const impact = normalizeText(p.expected_impact).toLowerCase();
  const risk = normalizedRisk(p.risk);
  const title = normalizeText(p.title);
  const nextCmd = normalizeText(p.suggested_next_command);
  const validationCount = Array.isArray(p.validation) ? p.validation.length : 0;
  const evidenceCount = Array.isArray(p.evidence) ? p.evidence.length : 0;

  if (impact === 'high') score += 26;
  else if (impact === 'medium') score += 18;
  else score += 10;

  if (risk === 'high') score -= 16;
  else if (risk === 'medium') score -= 8;

  if (title.length >= 12) score += 6;
  if (title.length >= 28) score += 4;
  if (/\[stub\]/i.test(title)) {
    score -= 40;
    reasons.push('stub_title');
  }

  score += Math.min(16, validationCount * 4);
  score += Math.min(12, evidenceCount * 3);

  if (nextCmd) {
    score += 10;
    if (nextCmd.includes('--dry-run')) score += 4;
    if (nextCmd.startsWith('node ')) score += 3;
  } else {
    reasons.push('missing_next_command');
  }

  if (eye) {
    const eyeScore = Number(eye.score_ema);
    const eyeStatus = normalizeText(eye.status).toLowerCase();
    const parserType = normalizeText(eye.parser_type).toLowerCase();
    if (Number.isFinite(eyeScore)) {
      score += (eyeScore - 50) * 0.35;
      if (eyeScore < t.min_eye_score_ema) reasons.push('eye_score_ema_low');
    }
    if (eyeStatus === 'active') score += 4;
    else if (eyeStatus === 'probation') {
      score -= 6;
      reasons.push('eye_probation');
    } else if (eyeStatus === 'dormant') {
      score -= 20;
      reasons.push('eye_dormant');
    }
    if (parserType && DISALLOWED_PARSER_TYPES.has(parserType)) reasons.push(`parser_disallowed:${parserType}`);
  } else {
    reasons.push('eye_unknown');
  }

  return {
    score: clamp(Math.round(score), 0, 100),
    reasons: uniq(reasons)
  };
}

function tokenHits(tokens, tokenSet) {
  if (!tokenSet || !tokenSet.length) return [];
  const set = new Set(tokens);
  const stems = new Set(tokens.map(toStem));
  const out = [];
  for (const tok of tokenSet) {
    if (set.has(tok)) out.push(tok);
    else if (stems.has(toStem(tok))) out.push(tok);
  }
  return out;
}

function assessDirectiveFit(proposal, profile, t) {
  if (!profile || profile.available !== true) {
    return {
      score: 100,
      pass: true,
      matched_positive: [],
      matched_negative: [],
      reasons: ['directive_profile_unavailable']
    };
  }

  const blob = proposalTextBlob(proposal);
  const toks = tokenizeFitText(blob);
  const posPhraseHits = profile.positive_phrases.filter(ph => blob.includes(ph));
  const negPhraseHits = profile.negative_phrases.filter(ph => blob.includes(ph));
  const posTokenHits = tokenHits(toks, profile.positive_tokens);
  const negTokenHits = tokenHits(toks, profile.negative_tokens);
  const strategyTokens = Array.isArray(profile.strategy_tokens) ? profile.strategy_tokens : [];
  const strategyHits = tokenHits(toks, strategyTokens);

  let score = 30;
  score += posPhraseHits.length * 18;
  score += Math.min(28, posTokenHits.length * 5);
  score += Math.min(12, strategyHits.length * 4);
  score -= negPhraseHits.length * 20;
  score -= Math.min(24, negTokenHits.length * 6);

  const reasons = [];
  if (posPhraseHits.length === 0 && posTokenHits.length === 0 && strategyHits.length === 0) reasons.push('no_directive_alignment');
  if (strategyTokens.length > 0 && strategyHits.length === 0) reasons.push('no_strategy_marker');
  if (negPhraseHits.length > 0 || negTokenHits.length > 0) reasons.push('matches_excluded_scope');

  const finalScore = clamp(Math.round(score), 0, 100);
  const minDirectiveFit = Number((t && t.min_directive_fit) || thresholds().min_directive_fit);
  return {
    score: finalScore,
    pass: finalScore >= minDirectiveFit,
    matched_positive: uniq([...posPhraseHits, ...posTokenHits, ...strategyHits]).slice(0, 5),
    matched_negative: uniq([...negPhraseHits, ...negTokenHits]).slice(0, 5),
    reasons: uniq(reasons)
  };
}

function assessDreamAlignment(proposal, dreamSignals) {
  const source = dreamSignals && typeof dreamSignals === 'object' ? dreamSignals : {};
  const qualityScore = clamp(Number(source.quality_score || 0), 0, 100);
  const qualityTier = normalizeText(source.quality_tier || '').toLowerCase() || 'low';
  const qualityScale = clamp(Number(source.quality_scale || 0), DREAM_SIGNAL_QUALITY_MIN_SCALE, 1);
  const qualityFloor = DREAM_SIGNAL_QUALITY_MIN_SCORE;
  const rows = Array.isArray(source.tokens) ? source.tokens : [];
  if (!rows.length) {
    return {
      available: false,
      quality_score: qualityScore,
      quality_tier: qualityTier,
      quality_scale: qualityScale,
      quality_floor: qualityFloor,
      score: 0,
      directive_bonus: 0,
      hit_weight: 0,
      rem_hit_weight: 0,
      rem_bonus: 0,
      matched_tokens: [],
      matched_sources: [],
      matched_source_uids: [],
      reasons: ['dream_signals_unavailable']
    };
  }
  const proposalTokens = tokenizeFitText(proposalTextBlob(proposal));
  if (!proposalTokens.length) {
    return {
      available: true,
      quality_score: qualityScore,
      quality_tier: qualityTier,
      quality_scale: qualityScale,
      quality_floor: qualityFloor,
      score: 0,
      directive_bonus: 0,
      hit_weight: 0,
      rem_hit_weight: 0,
      rem_bonus: 0,
      matched_tokens: [],
      matched_sources: [],
      matched_source_uids: [],
      reasons: ['proposal_tokens_empty']
    };
  }

  const set = new Set(proposalTokens);
  const stems = new Set(proposalTokens.map(toStem));
  let hitWeight = 0;
  let remHitWeight = 0;
  const matchedTokens = [];
  const sourceSet = new Set();
  for (const row of rows) {
    const token = normalizeText(row && row.token).toLowerCase();
    if (!token) continue;
    if (!set.has(token) && !stems.has(toStem(token))) continue;
    const weight = clamp(Number(row && row.weight || 0), 1, 12);
    hitWeight += weight;
    matchedTokens.push(token);
    const src = Array.isArray(row && row.sources) ? row.sources : [];
    let remMatched = false;
    for (const one of src) {
      const sourceTag = String(one || '').trim().toLowerCase();
      if (!sourceTag) continue;
      sourceSet.add(sourceTag);
      if (sourceTag.startsWith('rem')) remMatched = true;
    }
    if (remMatched) remHitWeight += weight;
  }

  const totalWeight = clamp(Number(source.total_weight || 0), 1, 9999);
  const score = hitWeight > 0
    ? clamp(Math.round((hitWeight / totalWeight) * 100), 0, 100)
    : 0;
  const baseBonus = hitWeight > 0
    ? clamp(Math.round((hitWeight / 3) * qualityScale), 0, DREAM_DIRECTIVE_BONUS_CAP)
    : 0;
  const remBonus = remHitWeight > 0
    ? clamp(Math.round((remHitWeight / 6) * qualityScale), 0, DREAM_REM_BONUS_CAP)
    : 0;
  const bonus = clamp(baseBonus + remBonus, 0, DREAM_DIRECTIVE_BONUS_CAP);
  const sourceUids = Array.isArray(source.source_uids)
    ? source.source_uids.map((uid) => normalizeText(uid).toLowerCase()).filter(Boolean)
    : [];
  const reasons = [];
  if (baseBonus > 0) reasons.push('dream_alignment_bonus_applied');
  else reasons.push('dream_alignment_no_bonus');
  if (remBonus > 0) reasons.push('dream_rem_bonus_applied');
  if (qualityScale < 1) reasons.push('dream_quality_fallback_scaled_bonus');
  if (qualityScore < qualityFloor) reasons.push('dream_quality_below_floor');
  return {
    available: true,
    quality_score: qualityScore,
    quality_tier: qualityTier,
    quality_scale: Number(qualityScale.toFixed(3)),
    quality_floor: qualityFloor,
    score,
    directive_bonus: bonus,
    hit_weight: hitWeight,
    rem_hit_weight: remHitWeight,
    rem_bonus: remBonus,
    matched_tokens: uniq(matchedTokens).slice(0, 6),
    matched_sources: Array.from(sourceSet).filter(Boolean).sort(),
    matched_source_uids: hitWeight > 0 ? uniq(sourceUids).slice(0, 8) : [],
    reasons: uniq(reasons)
  };
}

function assessActionability(proposal, directiveFitScore, relevanceScore, outcomePolicy) {
  const p = proposal || {};
  const proposalType = normalizeText(p.type).toLowerCase();
  const risk = normalizedRisk(p.risk);
  const title = normalizeText(p.title).replace(/^\[[^\]]+\]\s*/g, '');
  const nextCmd = normalizeText(p.suggested_next_command);
  const validation = Array.isArray(p.validation) ? p.validation.map(v => normalizeText(v)).filter(Boolean) : [];
  const summary = normalizeText(p.summary);
  const evidenceText = Array.isArray(p.evidence)
    ? p.evidence.map(ev => normalizeText((ev && ev.match) || '')).join(' ')
    : '';
  const specificValidation = validation.filter(v => !GENERIC_VALIDATION_RE.test(v));
  const taskMatch = nextCmd.match(/--task=\"([^\"]+)\"/);
  const taskText = taskMatch ? normalizeText(taskMatch[1]) : '';
  const textBlob = normalizeFitText([title, summary, taskText, specificValidation.join(' '), evidenceText].join(' '));
  const hasActionVerb = ACTION_VERB_RE.test(title) || specificValidation.some(v => ACTION_VERB_RE.test(v));
  const hasOpportunity = OPPORTUNITY_MARKER_RE.test(textBlob);
  const hasConcreteTarget = CONCRETE_TARGET_RE.test(textBlob);
  const isMetaCoordination = META_COORDINATION_RE.test(textBlob);
  const isMetaNoop = isMetaNoopCandidate(p, textBlob);
  const hasConcreteDelta = hasConcreteDeltaSignal(p);
  const isExplainer = EXPLAINER_TITLE_RE.test(title.toLowerCase());
  const genericRouteTask = GENERIC_ROUTE_TASK_RE.test(nextCmd);
  const criteriaRows = parseSuccessCriteriaRows(p);
  const criteriaPolicy = successCriteriaRequirement(outcomePolicy);
  const criteriaCounts = weightedCriteriaCount(criteriaRows, criteriaPolicy);
  const measurableCriteriaCount = criteriaCounts.measurable_count;
  const weightedCriteriaCountValue = criteriaCounts.weighted_count;
  const isExecutableProposal = !!(nextCmd || (p.action_spec && typeof p.action_spec === 'object'));
  const criteriaExempt = isExecutableProposal && isSuccessCriteriaExemptProposal(proposalType, criteriaPolicy);
  const subdirectiveV2 = subDirectiveV2Signals(p);

  let score = 14;
  const reasons = [];

  if (hasActionVerb) score += 18;
  else reasons.push('no_action_verb');

  if (nextCmd) {
    if (genericRouteTask) {
      score += 4;
      reasons.push('generic_next_command_template');
    } else {
      score += 8;
      if (!nextCmd.includes('--dry-run')) score += 6;
      else score += 2;
    }
  }
  else reasons.push('missing_next_command');

  if (specificValidation.length >= 3) score += 18;
  else if (specificValidation.length >= 2) score += 12;
  else if (specificValidation.length >= 1) score += 6;
  else if (validation.length > 0) reasons.push('generic_validation_template');
  else reasons.push('missing_validation_plan');

  if (risk === 'low') score += 8;
  else if (risk === 'medium') score += 3;
  else score -= 8;

  score += clamp(Math.round((Number(relevanceScore || 0) - 35) * 0.4), 0, 20);
  score += clamp(Math.round((Number(directiveFitScore || 0) - 30) * 0.25), 0, 16);
  if (hasOpportunity) score += 10;

  if (isExecutableProposal && criteriaPolicy.required && !criteriaExempt) {
    if (weightedCriteriaCountValue >= criteriaPolicy.min_count) {
      score += Math.min(14, 8 + (Math.ceil(weightedCriteriaCountValue) * 2));
    } else {
      score -= 22;
      reasons.push('success_criteria_missing');
    }
  } else if (measurableCriteriaCount > 0) {
    score += Math.min(8, measurableCriteriaCount * 2);
  }

  if (!hasActionVerb && !hasOpportunity && !hasConcreteTarget) {
    score -= 20;
    reasons.push('missing_concrete_target');
  }
  if (isMetaCoordination && !hasConcreteTarget) {
    score -= 26;
    reasons.push('meta_coordination_without_concrete_target');
  }
  if (isMetaNoop && !hasConcreteDelta) {
    score -= 24;
    reasons.push('meta_missing_concrete_delta');
  }
  if (isMetaNoop && weightedCriteriaCountValue < META_MEASURABLE_MIN_COUNT) {
    score -= 16;
    reasons.push('meta_missing_measurable_outcome');
  }
  if (/\bproposals?\b/.test(textBlob) && !hasConcreteTarget && !hasOpportunity) {
    score -= 12;
    reasons.push('proposal_recursion_without_target');
  }
  if (isExplainer && !hasActionVerb && !hasOpportunity) {
    score -= 12;
    reasons.push('explainer_without_execution_path');
  }
  if (genericRouteTask && specificValidation.length === 0 && !hasOpportunity && !hasConcreteTarget) {
    score -= 18;
    reasons.push('boilerplate_execution_path');
  }
  if (subdirectiveV2.required) {
    if (!subdirectiveV2.has_concrete_target) {
      score -= 18;
      reasons.push('subdirective_v2_missing_target');
    }
    if (!subdirectiveV2.has_expected_delta) {
      score -= 20;
      reasons.push('subdirective_v2_missing_expected_delta');
    }
    if (!subdirectiveV2.has_verification_step) {
      score -= 20;
      reasons.push('subdirective_v2_missing_verification_step');
    }
  }

  return {
    score: clamp(Math.round(score), 0, 100),
    reasons: uniq(reasons),
    subdirective_v2: subdirectiveV2,
    success_criteria: {
      required: isExecutableProposal && criteriaPolicy.required,
      requirement_applied: isExecutableProposal && criteriaPolicy.required && !criteriaExempt,
      exempt_type: criteriaExempt,
      min_count: criteriaPolicy.min_count,
      measurable_count: measurableCriteriaCount,
      weighted_count: weightedCriteriaCountValue,
      total_count: criteriaRows.length
    }
  };
}

function compositeScore(quality, directiveFit, actionability) {
  const q = clamp(Number(quality || 0), 0, 100);
  const d = clamp(Number(directiveFit || 0), 0, 100);
  const a = clamp(Number(actionability || 0), 0, 100);
  return clamp(Math.round((q * 0.42) + (d * 0.26) + (a * 0.32)), 0, 100);
}

function proposalRemediationDepth(p) {
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const raw = Number(meta.remediation_depth);
  if (Number.isFinite(raw) && raw >= 0) return Math.round(raw);
  const trigger = String(meta.trigger || '').toLowerCase();
  if (trigger === 'consecutive_failures' || trigger === 'multi_eye_transport_failure') return 1;
  return 0;
}

function admission(meta, eye, risk, t, proposal, strategy, outcomePolicy, optimizationGate, directiveProfile) {
  const reasons = [];
  const allowedRisks = effectiveAllowedRisksSet();
  const type = normalizeText(proposal && proposal.type).toLowerCase();
  const blob = proposalTextBlob(proposal);
  const hasOpportunity = OPPORTUNITY_MARKER_RE.test(blob);
  const hasConcreteTarget = CONCRETE_TARGET_RE.test(blob);
  const isMetaCoordination = META_COORDINATION_RE.test(blob);
  const isMetaNoop = isMetaNoopCandidate(proposal, blob);
  const valueOracle = valueOracleDecision(proposal, blob, isMetaNoop, directiveProfile);
  const mutationGuard = adaptiveMutationGuardDecision(proposal);
  const hasConcreteDelta = hasConcreteDeltaSignal(proposal);
  const criteriaPolicy = successCriteriaRequirement(outcomePolicy);
  const criteriaExempt = isSuccessCriteriaExemptProposal(type, criteriaPolicy);
  const measuredCriteriaCount = Number(meta && meta.success_criteria_weighted_count != null
    ? meta.success_criteria_weighted_count
    : meta.success_criteria_measurable_count || 0);
  const criteriaRequired = criteriaPolicy.required && !!(
    normalizeText(proposal && proposal.suggested_next_command)
    || (proposal && proposal.action_spec && typeof proposal.action_spec === 'object')
  ) && !criteriaExempt;
  if (criteriaRequired) {
    if (measuredCriteriaCount < criteriaPolicy.min_count) reasons.push('success_criteria_missing');
  }
  if (!strategyAllowsProposalType(strategy, type)) reasons.push('strategy_type_filtered');
  const maxDepth = strategy
    && strategy.admission_policy
    && Number.isFinite(Number(strategy.admission_policy.max_remediation_depth))
      ? Number(strategy.admission_policy.max_remediation_depth)
      : null;
  if (Number.isFinite(maxDepth) && type.includes('remediation')) {
    const depth = proposalRemediationDepth(proposal);
    if (depth > maxDepth) reasons.push('strategy_remediation_depth_exceeded');
  }
  const parserType = normalizeText(eye && eye.parser_type).toLowerCase();
  if (parserType && DISALLOWED_PARSER_TYPES.has(parserType)) reasons.push(`parser_disallowed:${parserType}`);
  if (allowedRisks.size > 0 && !allowedRisks.has(risk)) reasons.push('risk_not_allowed');

  if (Number(meta.signal_quality_score) < t.min_sensory_signal_score) reasons.push('sensory_signal_low');
  if (Number(meta.relevance_score) < t.min_sensory_relevance_score) reasons.push('sensory_relevance_low');
  if (Number(meta.directive_fit_score) < t.min_directive_fit) reasons.push('directive_fit_low');
  if (Number(meta.actionability_score) < t.min_actionability_score) reasons.push('actionability_low');
  if (Number(meta.composite_eligibility_score) < t.min_composite_eligibility) reasons.push('composite_low');
  if (meta && meta.objective_binding_required === true) {
    const objectiveId = normalizeText(meta.objective_id || meta.directive_objective_id);
    if (!objectiveId) reasons.push('objective_binding_missing');
    else if (meta.objective_binding_valid === false) reasons.push('objective_binding_invalid');
  }
  if (isMetaCoordination && !hasConcreteTarget) reasons.push('meta_proposal_non_actionable');
  if (/\bproposals?\b/.test(blob) && !hasConcreteTarget && !hasOpportunity) reasons.push('proposal_recursion_non_actionable');
  if (isMetaNoop && !hasConcreteDelta) reasons.push('meta_missing_concrete_delta');
  if (isMetaNoop && measuredCriteriaCount < META_MEASURABLE_MIN_COUNT) reasons.push('meta_missing_measurable_outcome');
  if (valueOracle.applies && !valueOracle.pass && valueOracle.reason) reasons.push(valueOracle.reason);
  if (mutationGuard.applies && !mutationGuard.pass) {
    for (const reason of mutationGuard.reasons || []) {
      if (reason) reasons.push(reason);
    }
  }
  const optGate = optimizationGate && typeof optimizationGate === 'object'
    ? optimizationGate
    : optimizationGateDecision(proposal, risk);
  if (optGate.applies && !optGate.pass && optGate.reason) reasons.push(optGate.reason);
  const subdirectiveV2 = subDirectiveV2Signals(proposal);
  if (subdirectiveV2.required) {
    if (!subdirectiveV2.has_concrete_target) reasons.push('subdirective_v2_missing_target');
    if (!subdirectiveV2.has_expected_delta) reasons.push('subdirective_v2_missing_expected_delta');
    if (!subdirectiveV2.has_verification_step) reasons.push('subdirective_v2_missing_verification_step');
  }

  return {
    eligible: reasons.length === 0,
    blocked_by: uniq(reasons),
    value_oracle: valueOracle,
    mutation_guard: mutationGuard
  };
}

function enrichOne(proposal, ctx) {
  const raw = proposal && typeof proposal === 'object' ? proposal : {};
  const p0 = normalizeProposalForAdmission(raw);
  const criteriaHardening = hardenProposalSuccessCriteria(p0, ctx.outcomePolicy);
  const p = criteriaHardening.proposal;
  const srcEye = sourceEyeId(p);
  const eye = ctx.eyes.get(srcEye) || null;
  const risk = normalizedRisk(p.risk);
  const proposalType = normalizeText(p.type).toLowerCase();
  const typeThresholds = applyTypeThresholds(ctx.thresholds, proposalType, ctx.outcomePolicy);
  const t = typeThresholds.thresholds;
  const objectiveBinding = resolveObjectiveBinding(p, ctx.directiveObjectiveIds);

  let q = assessQuality(p, eye, t);
  const crossSignalDecay = crossSignalNoChangeDecay(p, ctx);
  if (crossSignalDecay.applied) {
    q = {
      ...q,
      score: clamp(Math.round(Number(q.score || 0) - Number(crossSignalDecay.penalty || 0)), 0, 100),
      reasons: uniq([
        ...(Array.isArray(q.reasons) ? q.reasons : []),
        `cross_signal_no_change_decay:${Number(crossSignalDecay.count || 0)}`
      ])
    };
  }
  const dream = assessDreamAlignment(p, ctx.dreamSignals);
  const d0 = assessDirectiveFit(p, ctx.directiveProfile, t);
  const d = {
    ...d0,
    base_score: d0.score,
    score: clamp(Math.round(Number(d0.score || 0) + Number(dream.directive_bonus || 0)), 0, 100)
  };
  const relevance = clamp(Math.round((q.score * 0.55) + (d.score * 0.45)), 0, 100);
  const a = assessActionability(p, d.score, relevance, ctx.outcomePolicy);
  const comp = compositeScore(q.score, d.score, a.score);
  const optimizationGate = optimizationGateDecision(p, risk);
  const strategy = ctx.strategy || null;
  const admit = admission({
    signal_quality_score: q.score,
    relevance_score: relevance,
    directive_fit_score: d.score,
    directive_fit_base_score: d.base_score,
    actionability_score: a.score,
    composite_eligibility_score: comp,
    success_criteria_measurable_count: a.success_criteria ? Number(a.success_criteria.measurable_count || 0) : 0,
    success_criteria_weighted_count: a.success_criteria ? Number(a.success_criteria.weighted_count || 0) : 0,
    success_criteria_total_count: a.success_criteria ? Number(a.success_criteria.total_count || 0) : 0,
    success_criteria_compiled_count: Number(criteriaHardening.meta.compiled_count || 0),
    success_criteria_known_metric_count: Number(criteriaHardening.meta.known_metric_count || 0),
    success_criteria_unknown_metric_count: Number(criteriaHardening.meta.unknown_metric_count || 0),
    success_criteria_hardening_applied: criteriaHardening.meta.hardening_applied === true,
    success_criteria_hardening_reason: criteriaHardening.meta.hardening_reason || null,
    success_criteria_fallback_rows_added: Number(criteriaHardening.meta.fallback_rows_added || 0),
    objective_id: objectiveBinding.objective_id || '',
    directive_objective_id: objectiveBinding.directive_objective_id || '',
    objective_binding_required: objectiveBinding.binding_required === true,
    objective_binding_valid: objectiveBinding.binding_valid !== false
  }, eye, risk, t, p, strategy, ctx.outcomePolicy, optimizationGate, ctx.directiveProfile);
  const quorum = evaluateProposalQuorum({
    ...p,
    risk,
    meta: {
      ...(p.meta && typeof p.meta === 'object' ? p.meta : {}),
      objective_id: objectiveBinding.objective_id || '',
      directive_objective_id: objectiveBinding.directive_objective_id || ''
    }
  });
  if (quorum.requires_quorum === true && quorum.ok !== true) {
    const tag = quorum.agreement === false ? 'quorum_disagreement' : 'quorum_denied';
    if (!admit.blocked_by.includes(tag)) admit.blocked_by.push(tag);
    admit.eligible = false;
  }

  const prevMeta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
  const valueOracle = admit && admit.value_oracle && typeof admit.value_oracle === 'object'
    ? admit.value_oracle
    : {
        enabled: AUTONOMY_VALUE_ORACLE_REQUIRED,
        applies: false,
        scope: 'unknown',
        source: 'default',
        pass: true,
        reason: null,
        first_sentence: '',
        active_currencies: [],
        primary_currency: null,
        matched_currencies: [],
        matched_first_sentence_currencies: [],
        currency_signals: {},
        priority_score: 0,
        touches_money: false,
        touches_customer_or_user: false,
        touches_external_value: false,
        reduces_time_to_revenue: false,
        can_simulate_first: false
      };
  const mutationGuard = admit && admit.mutation_guard && typeof admit.mutation_guard === 'object'
    ? admit.mutation_guard
    : {
        enabled: AUTONOMY_MUTATION_GUARD_REQUIRED,
        required: AUTONOMY_MUTATION_GUARD_REQUIRED,
        applies: false,
        pass: true,
        reason: null,
        reasons: [],
        controls: {},
        thresholds: {
          budget_cap_max: AUTONOMY_MUTATION_BUDGET_CAP_MAX,
          ttl_hours_max: AUTONOMY_MUTATION_TTL_HOURS_MAX,
          quarantine_hours_min: AUTONOMY_MUTATION_QUARANTINE_HOURS_MIN,
          veto_window_hours_min: AUTONOMY_MUTATION_VETO_WINDOW_HOURS_MIN
        }
      };
  const mutationGuardControls: AnyObj = mutationGuard.controls && typeof mutationGuard.controls === 'object'
    ? { ...mutationGuard.controls }
    : {};
  const mutationGuardReceiptId = mutationGuard.applies
    ? normalizeText(
      mutationGuardControls.guard_receipt_id
      || prevMeta.adaptive_mutation_guard_receipt_id
      || (raw && raw.id ? `mut_guard_${String(raw.id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}` : '')
    )
    : null;
  if (mutationGuardReceiptId) mutationGuardControls.guard_receipt_id = mutationGuardReceiptId;
  const rawExpectedValueScore = Number((p.meta && p.meta.expected_value_score));
  const shouldBackfillExpectedValue = AUTONOMY_VALUE_ORACLE_BACKFILL_EXPECTED_VALUE
    && !Number.isFinite(rawExpectedValueScore)
    && Number.isFinite(Number(valueOracle.priority_score));
  const backfilledExpectedValueScore = shouldBackfillExpectedValue
    ? clamp(Number(valueOracle.priority_score), 0, 100)
    : null;
  const nextMeta = {
    ...prevMeta,
    ...(p.meta && typeof p.meta === 'object' ? p.meta : {}),
    source_eye: srcEye,
    cross_signal_topic: crossSignalDecay.topic || null,
    cross_signal_no_change_count: Number(crossSignalDecay.count || 0),
    cross_signal_confidence_decay_penalty: Number(crossSignalDecay.penalty || 0),
    cross_signal_confidence_decay_applied: crossSignalDecay.applied === true,
    cross_signal_confidence_base: Number.isFinite(Number(prevMeta.confidence))
      ? Number(prevMeta.confidence)
      : null,
    cross_signal_confidence_adjusted: Number.isFinite(Number(prevMeta.confidence))
      ? clamp(Number(prevMeta.confidence) - Number(crossSignalDecay.penalty || 0), 0, 100)
      : null,
    objective_id: objectiveBinding.objective_id || null,
    directive_objective_id: objectiveBinding.directive_objective_id || null,
    objective_binding_required: objectiveBinding.binding_required === true,
    objective_binding_valid: objectiveBinding.binding_valid !== false,
    objective_binding_source: objectiveBinding.binding_source || null,
    objective_binding_reason: objectiveBinding.reason || null,
    active_directive_objectives: objectiveBinding.active_objectives,
    signal_quality_score: q.score,
    signal_quality_tier: tier(q.score),
    relevance_score: relevance,
    relevance_tier: tier(relevance),
    directive_fit_score: d.score,
    directive_fit_base_score: d.base_score,
    directive_fit_pass: d.score >= t.min_directive_fit,
    directive_fit_positive: d.matched_positive,
    directive_fit_negative: d.matched_negative,
    dream_signal_available: dream.available === true,
    dream_signal_quality_score: dream.quality_score,
    dream_signal_quality_tier: dream.quality_tier,
    dream_signal_quality_scale: dream.quality_scale,
    dream_signal_quality_floor: dream.quality_floor,
    dream_alignment_score: dream.score,
    dream_alignment_hit_weight: dream.hit_weight,
    dream_alignment_bonus: dream.directive_bonus,
    dream_alignment_rem_hit_weight: dream.rem_hit_weight,
    dream_alignment_rem_bonus: dream.rem_bonus,
    dream_alignment_tokens: dream.matched_tokens,
    dream_alignment_sources: dream.matched_sources,
    dream_alignment_source_uids: dream.matched_source_uids,
    dream_alignment_reasons: dream.reasons,
    relevance_reasons: uniq([...q.reasons, ...d.reasons, ...dream.reasons]).slice(0, 10),
    actionability_score: a.score,
    actionability_pass: a.score >= t.min_actionability_score,
    actionability_reasons: a.reasons.slice(0, 6),
    optimization_intent: optimizationGate.applies === true,
    optimization_delta_percent: Number.isFinite(Number(optimizationGate.delta_percent))
      ? Number(optimizationGate.delta_percent)
      : null,
    optimization_delta_source: optimizationGate.delta_source || null,
    optimization_min_delta_percent: Number(optimizationGate.min_delta_percent || optimizationMinDeltaPercent()),
    optimization_require_delta: optimizationGate.require_delta === true,
    optimization_gate_pass: optimizationGate.pass === true,
    optimization_gate_reason: optimizationGate.reason || null,
    value_oracle_enabled: valueOracle.enabled === true,
    value_oracle_applies: valueOracle.applies === true,
    value_oracle_scope: valueOracle.scope || null,
    value_oracle_source: valueOracle.source || null,
    value_oracle_pass: valueOracle.pass !== false,
    value_oracle_reason: valueOracle.reason || null,
    value_oracle_first_sentence: valueOracle.first_sentence || null,
    value_oracle_active_currencies: Array.isArray(valueOracle.active_currencies) ? valueOracle.active_currencies.slice(0, 6) : [],
    value_oracle_primary_currency: valueOracle.primary_currency || null,
    value_oracle_matched_currencies: Array.isArray(valueOracle.matched_currencies) ? valueOracle.matched_currencies.slice(0, 6) : [],
    value_oracle_matched_first_sentence_currencies: Array.isArray(valueOracle.matched_first_sentence_currencies)
      ? valueOracle.matched_first_sentence_currencies.slice(0, 6)
      : [],
    value_oracle_currency_signals: valueOracle.currency_signals && typeof valueOracle.currency_signals === 'object'
      ? valueOracle.currency_signals
      : {},
    value_oracle_priority_score: Number.isFinite(Number(valueOracle.priority_score))
      ? Number(valueOracle.priority_score)
      : 0,
    value_oracle_can_simulate_first: valueOracle.can_simulate_first === true,
    value_oracle_backfilled_expected_value: shouldBackfillExpectedValue,
    adaptive_mutation_guard_enabled: mutationGuard.enabled === true,
    adaptive_mutation_guard_required: mutationGuard.required === true,
    adaptive_mutation_guard_applies: mutationGuard.applies === true,
    adaptive_mutation_guard_pass: mutationGuard.pass !== false,
    adaptive_mutation_guard_reason: mutationGuard.reason || null,
    adaptive_mutation_guard_reasons: Array.isArray(mutationGuard.reasons) ? mutationGuard.reasons.slice(0, 8) : [],
    adaptive_mutation_guard_controls: mutationGuardControls,
    adaptive_mutation_guard_receipt_id: mutationGuardReceiptId || null,
    adaptive_mutation_guard_thresholds: mutationGuard.thresholds && typeof mutationGuard.thresholds === 'object'
      ? mutationGuard.thresholds
      : {},
    revenue_oracle_enabled: valueOracle.enabled === true,
    revenue_oracle_applies: valueOracle.applies === true,
    revenue_oracle_scope: valueOracle.scope || null,
    revenue_oracle_pass: valueOracle.pass !== false,
    revenue_oracle_reason: valueOracle.reason || null,
    revenue_oracle_first_sentence: valueOracle.first_sentence || null,
    revenue_oracle_touches_money: valueOracle.touches_money === true,
    revenue_oracle_touches_customer_or_user: valueOracle.touches_customer_or_user === true,
    revenue_oracle_touches_external_value: valueOracle.touches_external_value === true,
    revenue_oracle_reduces_time_to_revenue: valueOracle.reduces_time_to_revenue === true,
    revenue_oracle_can_simulate_first: valueOracle.can_simulate_first === true,
    subdirective_v2_required: a.subdirective_v2 && a.subdirective_v2.required === true,
    subdirective_v2_target_ok: !(a.subdirective_v2 && a.subdirective_v2.required === true)
      || (a.subdirective_v2 && a.subdirective_v2.has_concrete_target === true),
    subdirective_v2_expected_delta_ok: !(a.subdirective_v2 && a.subdirective_v2.required === true)
      || (a.subdirective_v2 && a.subdirective_v2.has_expected_delta === true),
    subdirective_v2_verification_ok: !(a.subdirective_v2 && a.subdirective_v2.required === true)
      || (a.subdirective_v2 && a.subdirective_v2.has_verification_step === true),
    subdirective_v2_target_count: a.subdirective_v2 ? Number(a.subdirective_v2.target_count || 0) : 0,
    subdirective_v2_verify_count: a.subdirective_v2 ? Number(a.subdirective_v2.verify_count || 0) : 0,
    success_criteria_required: a.success_criteria && a.success_criteria.required === true,
    success_criteria_requirement_applied: a.success_criteria && a.success_criteria.requirement_applied === true,
    success_criteria_exempt_type: a.success_criteria && a.success_criteria.exempt_type === true,
    success_criteria_min_count: a.success_criteria ? Number(a.success_criteria.min_count || 0) : 0,
    success_criteria_measurable_count: a.success_criteria ? Number(a.success_criteria.measurable_count || 0) : 0,
    success_criteria_weighted_count: a.success_criteria ? Number(a.success_criteria.weighted_count || 0) : 0,
    success_criteria_total_count: a.success_criteria ? Number(a.success_criteria.total_count || 0) : 0,
    success_criteria_compiled_count: Number(criteriaHardening.meta.compiled_count || 0),
    success_criteria_known_metric_count: Number(criteriaHardening.meta.known_metric_count || 0),
    success_criteria_unknown_metric_count: Number(criteriaHardening.meta.unknown_metric_count || 0),
    success_criteria_hardening_applied: criteriaHardening.meta.hardening_applied === true,
    success_criteria_hardening_reason: criteriaHardening.meta.hardening_reason || null,
    success_criteria_fallback_rows_added: Number(criteriaHardening.meta.fallback_rows_added || 0),
    composite_eligibility_score: comp,
    composite_eligibility_pass: comp >= t.min_composite_eligibility,
    type_threshold_offsets: typeThresholds.offsets,
    type_thresholds_applied: t,
    admission_preview: {
      eligible: admit.eligible,
      blocked_by: admit.blocked_by.slice(0, 6)
    },
    quorum_validation: {
      required: quorum.requires_quorum === true,
      ok: quorum.ok === true,
      agreement: quorum.agreement !== false,
      reason: quorum.reason || null
    },
    enriched_at: nowIso(),
    enrichment_version: '1.4'
  };
  if (shouldBackfillExpectedValue && Number.isFinite(Number(backfilledExpectedValueScore))) {
    nextMeta.expected_value_score = Number(backfilledExpectedValueScore);
  }

  const next = {
    ...p,
    risk,
    meta: nextMeta
  };
  if (objectiveBinding.objective_id) {
    const prevSpec = p.action_spec && typeof p.action_spec === 'object' ? p.action_spec : null;
    if (prevSpec && normalizeText(prevSpec.objective_id) !== normalizeText(objectiveBinding.objective_id)) {
      next.action_spec = {
        ...prevSpec,
        objective_id: objectiveBinding.objective_id
      };
    }
  }

  const changed = JSON.stringify(prevMeta) !== JSON.stringify(nextMeta)
    || String(p.risk || '') !== risk
    || JSON.stringify(raw.action_spec || null) !== JSON.stringify(next.action_spec || null);
  return {
    proposal: next,
    changed,
    admission: admit
  };
}

function summarizeDreamAlignment(results, dreamSignals) {
  const tokenHits: AnyObj = {};
  let proposalsWithHits = 0;
  let proposalsWithBonus = 0;
  let bonusTotal = 0;
  let remBonusTotal = 0;
  for (const row of results) {
    const proposal = row && row.proposal && typeof row.proposal === 'object' ? row.proposal : {};
    const meta = proposal && proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : {};
    const bonus = Number(meta.dream_alignment_bonus || 0);
    if (bonus > 0) {
      proposalsWithBonus += 1;
      bonusTotal += bonus;
    }
    remBonusTotal += Number(meta.dream_alignment_rem_bonus || 0);
    const tokens = Array.isArray(meta.dream_alignment_tokens) ? meta.dream_alignment_tokens : [];
    if (tokens.length > 0) proposalsWithHits += 1;
    for (const tok of tokens) {
      const key = String(tok || '').trim().toLowerCase();
      if (!key) continue;
      tokenHits[key] = Number(tokenHits[key] || 0) + 1;
    }
  }
  const source = dreamSignals && typeof dreamSignals === 'object' ? dreamSignals : {};
  const tokensLoaded = Array.isArray(source.tokens) ? source.tokens.length : 0;
  return {
    available: source.available === true,
    quality_score: clamp(Number(source.quality_score || 0), 0, 100),
    quality_tier: normalizeText(source.quality_tier || '').toLowerCase() || 'low',
    quality_scale: clamp(Number(source.quality_scale || 0), DREAM_SIGNAL_QUALITY_MIN_SCALE, 1),
    quality_floor: DREAM_SIGNAL_QUALITY_MIN_SCORE,
    tokens_loaded: tokensLoaded,
    source_counts: source.source_counts || { theme: 0, rem: 0 },
    source_uid_count: Array.isArray(source.source_uids) ? source.source_uids.length : 0,
    files: source.files || { themes: false, rem: false, rem_runs: [] },
    proposals_with_hits: proposalsWithHits,
    proposals_with_bonus: proposalsWithBonus,
    bonus_total: bonusTotal,
    rem_bonus_total: remBonusTotal,
    top_hit_tokens: Object.entries(tokenHits)
      .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0) || String(a[0]).localeCompare(String(b[0])))
      .slice(0, 6)
      .map(([token, count]) => ({ token, count }))
  };
}

function summarizeAdmissions(results) {
  let eligible = 0;
  let blocked = 0;
  const blockedByReason: AnyObj = {};
  for (const r of results) {
    const a = r && r.admission ? r.admission : { eligible: false, blocked_by: ['unknown'] };
    if (a.eligible) eligible += 1;
    else {
      blocked += 1;
      const reasons = Array.isArray(a.blocked_by) && a.blocked_by.length ? a.blocked_by : ['unknown'];
      for (const reason of reasons) blockedByReason[reason] = Number(blockedByReason[reason] || 0) + 1;
    }
  }
  return {
    total: results.length,
    eligible,
    blocked,
    blocked_by_reason: Object.fromEntries(
      Object.entries(blockedByReason as Record<string, number>)
        .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0) || String(a[0]).localeCompare(String(b[0])))
    )
  };
}

function summarizeObjectiveBinding(results) {
  const out: AnyObj = {
    total: 0,
    required: 0,
    valid_required: 0,
    missing_required: 0,
    invalid_required: 0,
    source_meta_required: 0,
    source_fallback_required: 0,
    source_counts: {} as AnyObj
  };
  const metaSources = new Set([
    'meta.objective_id',
    'meta.directive_objective_id',
    'action_spec.objective_id',
    'meta.action_spec.objective_id'
  ]);
  for (const row of results) {
    const proposal = row && row.proposal && typeof row.proposal === 'object' ? row.proposal : {};
    const meta = proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : {};
    out.total += 1;

    const required = meta.objective_binding_required === true;
    const source = normalizeText(meta.objective_binding_source);
    if (source) out.source_counts[source] = Number(out.source_counts[source] || 0) + 1;
    if (!required) continue;

    out.required += 1;
    const objectiveId = normalizeText(meta.objective_id || meta.directive_objective_id);
    const valid = meta.objective_binding_valid !== false && !!objectiveId;
    if (!objectiveId) out.missing_required += 1;
    else if (!valid) out.invalid_required += 1;
    else out.valid_required += 1;

    if (source && metaSources.has(source)) out.source_meta_required += 1;
    else out.source_fallback_required += 1;
  }
  out.source_counts = Object.fromEntries(
    Object.entries(out.source_counts).sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0) || a[0].localeCompare(b[0]))
  );
  out.ok = out.missing_required === 0 && out.invalid_required === 0;
  return out;
}

function parseDateOrToday(v) {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : todayStr();
}

function dateWindow(dateStr, days) {
  const base = Date.parse(`${dateStr}T00:00:00.000Z`);
  if (!Number.isFinite(base)) return [dateStr];
  const out = [];
  for (let i = 0; i < Math.max(1, Number(days || 1)); i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function crossSignalTopicFromProposal(proposal) {
  const meta = proposal && proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : {};
  const topic = normalizeText(meta.topic).toLowerCase();
  return topic || '';
}

function loadCrossSignalNoChangeTopicCounts(dateStr) {
  const days = dateWindow(dateStr, CROSS_SIGNAL_NO_CHANGE_WINDOW_DAYS);
  const idToTopic = new Map();
  for (const day of days) {
    const loaded = loadProposalsForDate(day);
    for (const proposal of loaded.proposals || []) {
      if (!proposal || typeof proposal !== 'object') continue;
      const id = normalizeText(proposal.id);
      const type = normalizeText(proposal.type).toLowerCase();
      if (!id || type !== 'cross_signal_opportunity') continue;
      const topic = crossSignalTopicFromProposal(proposal);
      if (topic) idToTopic.set(id, topic);
    }
  }

  const counts = new Map();
  for (const day of days) {
    const runPath = path.join(ROOT, 'state', 'autonomy', 'runs', `${day}.jsonl`);
    const rows = readJsonSafe(runPath, null);
    const list = Array.isArray(rows) ? rows : [];
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      const type = normalizeText(row.proposal_type).toLowerCase();
      const sourceEye = normalizeText(row.source_eye).toLowerCase();
      if (!(type === 'cross_signal_opportunity' || sourceEye === 'cross_signal_engine')) continue;
      const noChange = normalizeText(row.outcome).toLowerCase() === 'no_change'
        || normalizeText(row.result).toLowerCase() === 'stop_no_change'
        || normalizeText(row && row.preview_verification && row.preview_verification.outcome).toLowerCase() === 'no_change';
      if (!noChange) continue;
      const proposalId = normalizeText(row.proposal_id);
      if (!proposalId) continue;
      const topic = normalizeText(idToTopic.get(proposalId)).toLowerCase();
      if (!topic) continue;
      counts.set(topic, Number(counts.get(topic) || 0) + 1);
    }
  }

  return {
    window_days: CROSS_SIGNAL_NO_CHANGE_WINDOW_DAYS,
    counts
  };
}

function crossSignalNoChangeDecay(proposal, ctx) {
  const type = normalizeText(proposal && proposal.type).toLowerCase();
  if (type !== 'cross_signal_opportunity') {
    return { applied: false, topic: '', count: 0, penalty: 0 };
  }
  const topic = crossSignalTopicFromProposal(proposal);
  if (!topic) return { applied: false, topic: '', count: 0, penalty: 0 };
  const map = ctx && ctx.cross_signal_no_change && ctx.cross_signal_no_change.counts
    ? ctx.cross_signal_no_change.counts
    : new Map();
  const count = Number(map.get(topic) || 0);
  if (count <= 0) return { applied: false, topic, count: 0, penalty: 0 };
  const penalty = clamp(Math.round(count * CROSS_SIGNAL_NO_CHANGE_PENALTY_PER_HIT), 0, CROSS_SIGNAL_NO_CHANGE_MAX_PENALTY);
  return { applied: penalty > 0, topic, count, penalty };
}

function runForDate(dateStr, dryRun = false) {
  const loaded = loadProposalsForDate(dateStr);
  if (!loaded.exists) {
    return {
      ok: true,
      result: 'no_proposals_file',
      date: dateStr,
      path: loaded.filePath,
      changed: 0,
      admission: { total: 0, eligible: 0, blocked: 0, blocked_by_reason: {} }
    };
  }

  const directiveProfile = loadDirectiveProfile();
  const dreamSignals = loadDreamSignals(dateStr);
  const ctx = {
    eyes: loadEyesMap(),
    directiveProfile,
    directiveObjectiveIds: activeDirectiveObjectiveIds(directiveProfile),
    strategy: strategyProfile(),
    thresholds: thresholds(),
    outcomePolicy: loadOutcomeFitnessPolicy(ROOT),
    dreamSignals,
    cross_signal_no_change: loadCrossSignalNoChangeTopicCounts(dateStr)
  };

  const out = [];
  let changed = 0;
  for (const p of loaded.proposals) {
    const r = enrichOne(p, ctx);
    if (r.changed) changed += 1;
    out.push(r);
  }

  const proposalsOut = out.map(x => x.proposal);
  if (!dryRun && changed > 0) {
    saveProposalsForDate(loaded.filePath, loaded.container, proposalsOut);
  }

  const admissionSummary = summarizeAdmissions(out);
  const objectiveBindingSummary = summarizeObjectiveBinding(out);
  const dreamAlignmentSummary = summarizeDreamAlignment(out, dreamSignals);
  return {
    ok: true,
    result: dryRun ? 'dry_run' : 'enriched',
    date: dateStr,
    path: loaded.filePath,
    changed,
    total: loaded.proposals.length,
    directive_profile_available: ctx.directiveProfile.available === true,
    strategy_profile: ctx.strategy
      ? {
          id: ctx.strategy.id,
          name: ctx.strategy.name,
          status: ctx.strategy.status,
          file: path.relative(ROOT, ctx.strategy.file).replace(/\\/g, '/'),
          execution_mode: ctx.strategy.execution_policy && ctx.strategy.execution_policy.mode
            ? String(ctx.strategy.execution_policy.mode)
            : null,
          allowed_risks: Array.isArray(ctx.strategy.risk_policy && ctx.strategy.risk_policy.allowed_risks)
            ? ctx.strategy.risk_policy.allowed_risks
            : [],
          threshold_overrides: ctx.strategy.threshold_overrides || {},
          validation: ctx.strategy.validation || { strict_ok: true, errors: [], warnings: [] }
        }
      : null,
    thresholds: ctx.thresholds,
    admission: admissionSummary,
    objective_binding: objectiveBindingSummary,
    dream_alignment: dreamAlignmentSummary,
    cross_signal_no_change: {
      window_days: Number(ctx.cross_signal_no_change && ctx.cross_signal_no_change.window_days || CROSS_SIGNAL_NO_CHANGE_WINDOW_DAYS),
      topics: Array.from((ctx.cross_signal_no_change && ctx.cross_signal_no_change.counts && ctx.cross_signal_no_change.counts.entries()) || [])
        .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0) || String(a[0]).localeCompare(String(b[0])))
        .slice(0, 12)
        .map(([topic, count]) => ({ topic, no_change_count: Number(count || 0) }))
    }
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || '';
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd !== 'run') {
    usage();
    process.exit(2);
  }
  const dateStr = parseDateOrToday(args._[1]);
  const dryRun = args['dry-run'] === true;
  const out = runForDate(dateStr, dryRun);
  process.stdout.write(JSON.stringify(out) + '\n');
}

if (require.main === module) main();

module.exports = {
  runForDate,
  enrichOne,
  summarizeAdmissions,
  summarizeObjectiveBinding
};
