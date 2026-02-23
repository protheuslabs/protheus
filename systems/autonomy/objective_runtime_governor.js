#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  compileDirectiveLineage,
  evaluateDirectiveLineageCandidate
} = require('../security/directive_compiler.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.AUTONOMY_OBJECTIVE_RUNTIME_POLICY_PATH
  ? path.resolve(process.env.AUTONOMY_OBJECTIVE_RUNTIME_POLICY_PATH)
  : path.join(REPO_ROOT, 'config', 'objective_runtime_policy.json');
const DEFAULT_STATE_DIR = process.env.AUTONOMY_OBJECTIVE_RUNTIME_STATE_DIR
  ? path.resolve(process.env.AUTONOMY_OBJECTIVE_RUNTIME_STATE_DIR)
  : path.join(REPO_ROOT, 'state', 'autonomy', 'objective_runtime');
const DEFAULT_SETTLEMENTS_PATH = process.env.AUTONOMY_OBJECTIVE_RUNTIME_SETTLEMENTS_PATH
  ? path.resolve(process.env.AUTONOMY_OBJECTIVE_RUNTIME_SETTLEMENTS_PATH)
  : path.join(DEFAULT_STATE_DIR, 'settlements.jsonl');

const OUTCOME_SET = new Set(['shipped', 'no_change', 'reverted']);
const DEFAULT_META_TYPES = [
  'local_state_fallback',
  'directive_clarification',
  'directive_decomposition',
  'human_escalation',
  'collector_remediation'
];
const DIRECTIVE_COMPILER_CACHE_TTL_MS = Math.max(
  1000,
  Number(process.env.AUTONOMY_DIRECTIVE_COMPILER_CACHE_TTL_MS || 30000)
);
let cachedDirectiveCompiler = null;
let cachedDirectiveCompilerTs = 0;

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function normalizeText(v) {
  return String(v == null ? '' : v).trim();
}

function normalizeLower(v) {
  return normalizeText(v).toLowerCase();
}

function normalizeOutcome(v) {
  const out = normalizeLower(v);
  if (OUTCOME_SET.has(out)) return out;
  return 'no_change';
}

function normalizeRisk(v) {
  const risk = normalizeLower(v);
  if (risk === 'high' || risk === 'medium' || risk === 'low') return risk;
  return 'low';
}

function normalizeObjectiveId(v) {
  const id = normalizeText(v);
  return id || 'unbound';
}

function normalizeProposalType(v) {
  return normalizeLower(v) || 'unknown';
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((row) => row && typeof row === 'object');
  } catch {
    return [];
  }
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    window_days: 7,
    min_window_samples: 6,
    max_dominant_objective_share: 0.72,
    max_no_change_rate: 0.65,
    max_reverted_rate: 0.3,
    pressure_min_value_signal: 62,
    meta_no_change_streak_limit: 2,
    high_risk_exempt: true,
    meta_types: DEFAULT_META_TYPES.slice(),
    lineage_required: true,
    lineage_require_t1_root: true,
    lineage_block_missing_objective: true,
    lineage_max_depth: 8
  };
}

function normalizePolicy(input) {
  const src = input && typeof input === 'object' ? input : {};
  const base = defaultPolicy();
  const merged = { ...base, ...src };
  return {
    version: normalizeText(merged.version) || '1.0',
    enabled: merged.enabled !== false,
    window_days: Math.max(1, Math.round(clampNumber(merged.window_days, 1, 60, base.window_days))),
    min_window_samples: Math.max(1, Math.round(clampNumber(merged.min_window_samples, 1, 500, base.min_window_samples))),
    max_dominant_objective_share: clampNumber(merged.max_dominant_objective_share, 0.4, 0.95, base.max_dominant_objective_share),
    max_no_change_rate: clampNumber(merged.max_no_change_rate, 0.2, 0.98, base.max_no_change_rate),
    max_reverted_rate: clampNumber(merged.max_reverted_rate, 0.05, 0.95, base.max_reverted_rate),
    pressure_min_value_signal: Math.round(clampNumber(merged.pressure_min_value_signal, 0, 100, base.pressure_min_value_signal)),
    meta_no_change_streak_limit: Math.max(1, Math.round(clampNumber(
      merged.meta_no_change_streak_limit,
      1,
      20,
      base.meta_no_change_streak_limit
    ))),
    high_risk_exempt: merged.high_risk_exempt !== false,
    lineage_required: merged.lineage_required !== false,
    lineage_require_t1_root: merged.lineage_require_t1_root !== false,
    lineage_block_missing_objective: merged.lineage_block_missing_objective !== false,
    lineage_max_depth: Math.max(1, Math.round(clampNumber(
      merged.lineage_max_depth,
      1,
      24,
      base.lineage_max_depth
    ))),
    meta_types: Array.from(new Set(
      (Array.isArray(merged.meta_types) ? merged.meta_types : base.meta_types)
        .map((v) => normalizeProposalType(v))
        .filter(Boolean)
    ))
  };
}

function loadDirectiveCompilerCached(opts = {}) {
  const now = Date.now();
  if (
    !opts.forceRefresh
    && cachedDirectiveCompiler
    && (now - cachedDirectiveCompilerTs) <= DIRECTIVE_COMPILER_CACHE_TTL_MS
  ) {
    return cachedDirectiveCompiler;
  }
  cachedDirectiveCompiler = compileDirectiveLineage(opts);
  cachedDirectiveCompilerTs = now;
  return cachedDirectiveCompiler;
}

function loadObjectiveRuntimePolicy(policyPath = DEFAULT_POLICY_PATH) {
  return normalizePolicy(readJsonSafe(policyPath, null));
}

function resolveWindow(dateStr, windowDays) {
  const nowMs = Date.now();
  const endMs = (() => {
    if (!dateStr) return nowMs;
    const parsed = Date.parse(`${normalizeText(dateStr)}T23:59:59.999Z`);
    return Number.isFinite(parsed) ? parsed : nowMs;
  })();
  const days = Math.max(1, Math.round(clampNumber(windowDays, 1, 60, 7)));
  const startMs = endMs - (days * 24 * 60 * 60 * 1000);
  return { startMs, endMs };
}

function rowInWindow(row, startMs, endMs) {
  const tsMs = Date.parse(String(row && row.ts || ''));
  if (!Number.isFinite(tsMs)) return false;
  return tsMs >= startMs && tsMs <= endMs;
}

function summarizeRows(rows, policy) {
  const byObjective = new Map();
  const totals = {
    total: 0,
    shipped: 0,
    no_change: 0,
    reverted: 0
  };
  const metaTypes = new Set(Array.isArray(policy.meta_types) ? policy.meta_types : []);
  const sorted = (Array.isArray(rows) ? rows.slice() : []).sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));

  for (const row of sorted) {
    const outcome = normalizeOutcome(row && row.outcome);
    const objectiveId = normalizeObjectiveId(row && row.objective_id);
    const proposalType = normalizeProposalType(row && row.proposal_type);
    totals.total += 1;
    totals[outcome] += 1;
    const cur = byObjective.get(objectiveId) || {
      objective_id: objectiveId,
      total: 0,
      shipped: 0,
      no_change: 0,
      reverted: 0,
      meta_no_change_streak: 0,
      _streak_done: false
    };
    cur.total += 1;
    cur[outcome] += 1;
    if (!cur._streak_done) {
      if (metaTypes.has(proposalType) && outcome === 'no_change') {
        cur.meta_no_change_streak += 1;
      } else {
        cur._streak_done = true;
      }
    }
    byObjective.set(objectiveId, cur);
  }

  const objectiveRows = [];
  let dominantObjectiveId = null;
  let dominantShare = 0;
  for (const row of byObjective.values()) {
    const share = totals.total > 0 ? (row.total / totals.total) : 0;
    const noChangeRate = row.total > 0 ? (row.no_change / row.total) : 0;
    const revertedRate = row.total > 0 ? (row.reverted / row.total) : 0;
    const outRow = {
      objective_id: row.objective_id,
      total: row.total,
      share: Number(share.toFixed(4)),
      shipped: row.shipped,
      no_change: row.no_change,
      no_change_rate: Number(noChangeRate.toFixed(4)),
      reverted: row.reverted,
      reverted_rate: Number(revertedRate.toFixed(4)),
      meta_no_change_streak: row.meta_no_change_streak
    };
    objectiveRows.push(outRow);
    if (share > dominantShare) {
      dominantShare = share;
      dominantObjectiveId = row.objective_id;
    }
  }
  objectiveRows.sort((a, b) => {
    if (b.share !== a.share) return b.share - a.share;
    return String(a.objective_id).localeCompare(String(b.objective_id));
  });

  const noChangeRate = totals.total > 0 ? totals.no_change / totals.total : 0;
  const revertedRate = totals.total > 0 ? totals.reverted / totals.total : 0;

  return {
    total: totals.total,
    shipped: totals.shipped,
    no_change: totals.no_change,
    reverted: totals.reverted,
    no_change_rate: Number(noChangeRate.toFixed(4)),
    reverted_rate: Number(revertedRate.toFixed(4)),
    dominant_objective_id: dominantObjectiveId,
    dominant_share: Number(dominantShare.toFixed(4)),
    by_objective: objectiveRows
  };
}

function summarizeObjectiveRuntime(dateStr, opts = {}) {
  const policy = normalizePolicy(opts.policy || loadObjectiveRuntimePolicy(opts.policyPath || DEFAULT_POLICY_PATH));
  const settlementsPath = opts.settlementsPath || DEFAULT_SETTLEMENTS_PATH;
  const window = resolveWindow(dateStr, policy.window_days);
  const rows = readJsonl(settlementsPath).filter((row) => rowInWindow(row, window.startMs, window.endMs));
  const summary = summarizeRows(rows, policy);
  const enforced = policy.enabled === true && summary.total >= policy.min_window_samples;
  return {
    policy,
    settlements_path: settlementsPath,
    window_days: policy.window_days,
    window_start: new Date(window.startMs).toISOString(),
    window_end: new Date(window.endMs).toISOString(),
    enabled: policy.enabled === true,
    enforced,
    ...summary
  };
}

function isExternalSignalProposalType(proposalType) {
  return /\b(opportunity|outreach|lead|sales|bizdev|revenue|freelance|contract|gig)\b/.test(normalizeProposalType(proposalType));
}

function evaluateObjectiveRuntimeCandidate(input, opts = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const candidate = src.candidate && typeof src.candidate === 'object' ? src.candidate : src;
  const summary = src.summary && typeof src.summary === 'object'
    ? src.summary
    : summarizeObjectiveRuntime(src.dateStr || opts.dateStr || null, opts);
  const policy = summary && summary.policy ? summary.policy : normalizePolicy(null);
  const objectiveId = normalizeObjectiveId(candidate.objective_id);
  const proposalType = normalizeProposalType(candidate.proposal_type);
  const valueSignalScore = Math.round(clampNumber(candidate.value_signal_score, 0, 100, 0));
  const risk = normalizeRisk(candidate.risk);
  const alternatives = Array.from(new Set(
    (Array.isArray(src.pool_objective_ids) ? src.pool_objective_ids : [])
      .map(normalizeObjectiveId)
      .filter((id) => id !== objectiveId)
  ));
  const objectiveStats = Array.isArray(summary.by_objective)
    ? summary.by_objective.find((row) => normalizeObjectiveId(row && row.objective_id) === objectiveId) || null
    : null;

  const response = {
    pass: true,
    gate: null,
    reason: null,
    reasons: [],
    objective_id: objectiveId,
    proposal_type: proposalType,
    risk,
    value_signal_score: valueSignalScore,
    pressure: {
      enabled: summary.enabled === true,
      enforced: summary.enforced === true,
      total_settlements: Number(summary.total || 0),
      no_change_rate: Number(summary.no_change_rate || 0),
      reverted_rate: Number(summary.reverted_rate || 0),
      dominant_objective_id: summary.dominant_objective_id || null,
      dominant_share: Number(summary.dominant_share || 0),
      objective_share: objectiveStats ? Number(objectiveStats.share || 0) : 0,
      objective_meta_no_change_streak: objectiveStats ? Number(objectiveStats.meta_no_change_streak || 0) : 0
    },
    lineage: null
  };

  if (policy.lineage_required === true) {
    const lineage = evaluateDirectiveLineageCandidate(
      {
        objective_id: objectiveId
      },
      {
        compiler: opts.directiveCompiler || loadDirectiveCompilerCached(opts.directiveCompilerOpts || {}),
        require_t1_root: policy.lineage_require_t1_root === true,
        block_missing_objective: policy.lineage_block_missing_objective === true,
        max_depth: policy.lineage_max_depth
      }
    );
    response.lineage = lineage;
    if (!lineage.pass) {
      response.pass = false;
      response.gate = 'objective_runtime';
      response.reason = String(lineage.reason || 'lineage_invalid');
      response.reasons.push(String(lineage.reason || 'lineage_invalid'));
      return response;
    }
  }

  if (summary.enabled !== true || summary.enforced !== true) return response;
  if (policy.high_risk_exempt === true && risk === 'high') {
    response.reasons.push('high_risk_exempt');
    return response;
  }

  if (
    alternatives.length > 0
    && summary.dominant_objective_id
    && normalizeObjectiveId(summary.dominant_objective_id) === objectiveId
    && Number(summary.dominant_share || 0) > Number(policy.max_dominant_objective_share || 1)
  ) {
    response.pass = false;
    response.gate = 'objective_runtime';
    response.reason = 'objective_share_cap';
    response.reasons.push('objective_share_cap');
    return response;
  }

  if (
    objectiveStats
    && Array.isArray(policy.meta_types)
    && policy.meta_types.includes(proposalType)
    && Number(objectiveStats.meta_no_change_streak || 0) >= Number(policy.meta_no_change_streak_limit || 0)
  ) {
    response.pass = false;
    response.gate = 'objective_runtime';
    response.reason = 'meta_no_change_streak';
    response.reasons.push('meta_no_change_streak');
    return response;
  }

  if (
    Number(summary.no_change_rate || 0) > Number(policy.max_no_change_rate || 1)
    && valueSignalScore < Number(policy.pressure_min_value_signal || 0)
  ) {
    response.pass = false;
    response.gate = 'objective_runtime';
    response.reason = 'no_change_pressure';
    response.reasons.push('no_change_pressure');
    return response;
  }

  if (
    Number(summary.reverted_rate || 0) > Number(policy.max_reverted_rate || 1)
    && valueSignalScore < Math.max(0, Number(policy.pressure_min_value_signal || 0) + 5)
  ) {
    response.pass = false;
    response.gate = 'objective_runtime';
    response.reason = 'reverted_pressure';
    response.reasons.push('reverted_pressure');
    return response;
  }

  return response;
}

function settleObjectiveRuntimeOutcome(input, opts = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const settlementsPath = opts.settlementsPath || DEFAULT_SETTLEMENTS_PATH;
  const policy = normalizePolicy(opts.policy || loadObjectiveRuntimePolicy(opts.policyPath || DEFAULT_POLICY_PATH));
  const lineage = policy.lineage_required === true
    ? evaluateDirectiveLineageCandidate(
      {
        objective_id: src.objective_id
      },
      {
        compiler: opts.directiveCompiler || loadDirectiveCompilerCached(opts.directiveCompilerOpts || {}),
        require_t1_root: policy.lineage_require_t1_root === true,
        block_missing_objective: policy.lineage_block_missing_objective === true,
        max_depth: policy.lineage_max_depth
      }
    )
    : null;
  const row = {
    ts: normalizeText(src.ts) || nowIso(),
    date: normalizeText(src.date) || normalizeText(src.dateStr) || nowIso().slice(0, 10),
    proposal_id: normalizeText(src.proposal_id) || null,
    proposal_type: normalizeProposalType(src.proposal_type),
    objective_id: normalizeObjectiveId(src.objective_id),
    outcome: normalizeOutcome(src.outcome),
    risk: normalizeRisk(src.risk),
    value_signal_score: Math.round(clampNumber(src.value_signal_score, 0, 100, 0)),
    directive_fit_score: Math.round(clampNumber(src.directive_fit_score, 0, 100, 0)),
    actionability_score: Math.round(clampNumber(src.actionability_score, 0, 100, 0)),
    composite_score: Math.round(clampNumber(src.composite_score, 0, 100, 0)),
    execution_mode: normalizeLower(src.execution_mode) || null,
    verification_passed: src.verification_passed === true,
    external_signal: src.external_signal === true
      || (normalizeOutcome(src.outcome) === 'shipped' && isExternalSignalProposalType(src.proposal_type))
  };
  if (lineage && typeof lineage === 'object') {
    row.lineage_valid = lineage.pass === true;
    row.lineage_reason = lineage.reason || null;
    row.root_objective_id = lineage.root_objective_id || null;
    row.lineage_path = Array.isArray(lineage.lineage_path) ? lineage.lineage_path.slice(0, 12) : [];
  }
  appendJsonl(settlementsPath, row);
  const summary = summarizeObjectiveRuntime(src.date || src.dateStr || null, {
    ...opts,
    settlementsPath
  });
  return {
    ok: true,
    row,
    summary
  };
}

module.exports = {
  defaultPolicy,
  normalizePolicy,
  loadObjectiveRuntimePolicy,
  summarizeObjectiveRuntime,
  evaluateObjectiveRuntimeCandidate,
  settleObjectiveRuntimeOutcome,
  isExternalSignalProposalType
};
