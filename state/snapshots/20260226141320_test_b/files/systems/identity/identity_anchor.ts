#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/identity/identity_anchor.js
 *
 * V2-045 Identity Organ (alignment anchor over fractal branches).
 * Enforces objective/value coherence checks for:
 *  - workflow graft/promotions (branch-level)
 *  - fractal morph actions (spawn/morph lane)
 *
 * Usage:
 *   node systems/identity/identity_anchor.js run [YYYY-MM-DD] [--scope=all|workflows|morph] [--strict=1|0]
 *   node systems/identity/identity_anchor.js status [YYYY-MM-DD|latest]
 */

const fs = require('fs');
const path = require('path');
const { loadActiveDirectives } = require('../../lib/directive_resolver');
const {
  loadActiveStrategy,
  resolveStrategyRankingContext
} = require('../../lib/strategy_resolver');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'identity_anchor_policy.json');
const DEFAULT_WORKFLOW_SNAPSHOT_PATH = process.env.ORCHESTRON_LATEST_PATH
  ? path.resolve(process.env.ORCHESTRON_LATEST_PATH)
  : path.join(ROOT, 'state', 'adaptive', 'workflows', 'orchestron', 'latest.json');
const DEFAULT_WORKFLOW_REGISTRY_PATH = process.env.WORKFLOW_REGISTRY_PATH
  ? path.resolve(process.env.WORKFLOW_REGISTRY_PATH)
  : path.join(ROOT, 'state', 'adaptive', 'workflows', 'registry.json');
const DEFAULT_MORPH_PLAN_DIR = process.env.FRACTAL_MORPH_PLAN_DIR
  ? path.resolve(process.env.FRACTAL_MORPH_PLAN_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'fractal', 'morph_plans');
const OUT_DIR = process.env.IDENTITY_ANCHOR_OUT_DIR
  ? path.resolve(process.env.IDENTITY_ANCHOR_OUT_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'identity_anchor');
const LATEST_PATH = path.join(OUT_DIR, 'latest.json');

const VALUE_CURRENCIES = new Set([
  'revenue',
  'delivery',
  'user_value',
  'quality',
  'time_savings',
  'learning'
]);

function usage() {
  console.log('Usage:');
  console.log('  node systems/identity/identity_anchor.js run [YYYY-MM-DD] [--scope=all|workflows|morph] [--strict=1|0] [--policy=path] [--workflow-snapshot=path] [--workflow-registry=path] [--morph-plan=path]');
  console.log('  node systems/identity/identity_anchor.js status [YYYY-MM-DD|latest]');
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
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return nowIso().slice(0, 10);
}

function normalizeScope(v) {
  const raw = String(v || 'all').trim().toLowerCase();
  if (raw === 'workflows' || raw === 'workflow') return 'workflows';
  if (raw === 'morph' || raw === 'fractal') return 'morph';
  return 'all';
}

function boolFlag(v, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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

function appendJsonl(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function relPath(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function normalizeObjectiveId(v) {
  return String(v == null ? '' : v).trim();
}

function objectiveKey(v) {
  return normalizeObjectiveId(v).toLowerCase();
}

function normalizeCurrency(v) {
  const token = String(v == null ? '' : v).trim().toLowerCase();
  if (!token) return null;
  if (!VALUE_CURRENCIES.has(token)) return token;
  return token;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    max_identity_drift_score: 0.58,
    enforcement: {
      block_on_parent_objective_mismatch: true,
      block_on_parent_value_currency_mismatch: true,
      block_on_active_objective_currency_mismatch: true,
      block_on_objective_missing_when_parent_present: true,
      block_on_unknown_active_objective: false,
      block_on_branch_depth_jump: false
    },
    weights: {
      objective_mismatch_parent: 0.68,
      objective_missing_parent: 0.38,
      objective_unknown_active: 0.34,
      value_currency_mismatch_parent: 0.55,
      value_currency_mismatch_objective: 0.52,
      branch_depth_jump: 0.24,
      identity_missing_objective: 0.12
    },
    branch_rules: {
      max_depth_delta_without_approval: 2
    },
    receipts: {
      write: true,
      max_rows: 240
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const enforcementRaw = raw && raw.enforcement && typeof raw.enforcement === 'object' ? raw.enforcement : {};
  const weightsRaw = raw && raw.weights && typeof raw.weights === 'object' ? raw.weights : {};
  const branchRaw = raw && raw.branch_rules && typeof raw.branch_rules === 'object' ? raw.branch_rules : {};
  const receiptsRaw = raw && raw.receipts && typeof raw.receipts === 'object' ? raw.receipts : {};
  return {
    version: String(raw.version || base.version),
    enabled: raw.enabled !== false,
    max_identity_drift_score: clampNumber(
      raw.max_identity_drift_score,
      0,
      1,
      base.max_identity_drift_score
    ),
    enforcement: {
      block_on_parent_objective_mismatch: enforcementRaw.block_on_parent_objective_mismatch !== false,
      block_on_parent_value_currency_mismatch: enforcementRaw.block_on_parent_value_currency_mismatch !== false,
      block_on_active_objective_currency_mismatch: enforcementRaw.block_on_active_objective_currency_mismatch !== false,
      block_on_objective_missing_when_parent_present: enforcementRaw.block_on_objective_missing_when_parent_present !== false,
      block_on_unknown_active_objective: enforcementRaw.block_on_unknown_active_objective === true,
      block_on_branch_depth_jump: enforcementRaw.block_on_branch_depth_jump === true
    },
    weights: {
      objective_mismatch_parent: clampNumber(weightsRaw.objective_mismatch_parent, 0, 1, base.weights.objective_mismatch_parent),
      objective_missing_parent: clampNumber(weightsRaw.objective_missing_parent, 0, 1, base.weights.objective_missing_parent),
      objective_unknown_active: clampNumber(weightsRaw.objective_unknown_active, 0, 1, base.weights.objective_unknown_active),
      value_currency_mismatch_parent: clampNumber(weightsRaw.value_currency_mismatch_parent, 0, 1, base.weights.value_currency_mismatch_parent),
      value_currency_mismatch_objective: clampNumber(weightsRaw.value_currency_mismatch_objective, 0, 1, base.weights.value_currency_mismatch_objective),
      branch_depth_jump: clampNumber(weightsRaw.branch_depth_jump, 0, 1, base.weights.branch_depth_jump),
      identity_missing_objective: clampNumber(weightsRaw.identity_missing_objective, 0, 1, base.weights.identity_missing_objective)
    },
    branch_rules: {
      max_depth_delta_without_approval: clampInt(
        branchRaw.max_depth_delta_without_approval,
        1,
        10,
        base.branch_rules.max_depth_delta_without_approval
      )
    },
    receipts: {
      write: receiptsRaw.write !== false,
      max_rows: clampInt(receiptsRaw.max_rows, 20, 2000, base.receipts.max_rows)
    }
  };
}

function collectActiveObjectives(directives) {
  const out = [];
  for (const row of Array.isArray(directives) ? directives : []) {
    if (!row || typeof row !== 'object') continue;
    const tier = Number(row.tier);
    const id = normalizeObjectiveId(row.id || row && row.data && row.data.metadata && row.data.metadata.id);
    if (!id) continue;
    if (/^t0[_:-]/i.test(id)) continue;
    if (Number.isFinite(tier) && tier < 1) continue;
    out.push(id);
  }
  return Array.from(new Set(out));
}

function expectedCurrencyForObjective(strategy, objectiveId) {
  if (!strategy || typeof strategy !== 'object') return null;
  try {
    const resolved = resolveStrategyRankingContext(strategy, { objective_id: objectiveId || null });
    return normalizeCurrency(resolved && resolved.value_currency);
  } catch {
    return null;
  }
}

function loadIdentityContext(options = {}) {
  const dateStr = dateArgOrToday(options.date);
  const policyPath = path.resolve(String(
    options.policy_path
      || process.env.IDENTITY_ANCHOR_POLICY_PATH
      || DEFAULT_POLICY_PATH
  ));
  const policy = options.policy && typeof options.policy === 'object'
    ? options.policy
    : loadPolicy(policyPath);

  let directives = [];
  try {
    directives = loadActiveDirectives({
      allowMissing: true,
      allowWeakTier1: true
    });
  } catch {
    directives = [];
  }

  let strategy = null;
  try {
    strategy = loadActiveStrategy({ allowMissing: true });
  } catch {
    strategy = null;
  }

  const activeObjectiveIds = collectActiveObjectives(directives);
  const activeObjectiveSet = new Set(activeObjectiveIds.map((id) => objectiveKey(id)));
  const objectiveCurrency = {};
  for (const id of activeObjectiveIds) {
    objectiveCurrency[id] = expectedCurrencyForObjective(strategy, id);
  }
  const defaultValueCurrency = expectedCurrencyForObjective(strategy, null);

  return {
    ts: nowIso(),
    date: dateStr,
    policy,
    policy_path: policyPath,
    directives_count: Array.isArray(directives) ? directives.length : 0,
    active_objective_ids: activeObjectiveIds,
    active_objective_set: activeObjectiveSet,
    objective_currency: objectiveCurrency,
    default_value_currency: defaultValueCurrency,
    strategy_id: strategy && strategy.id ? String(strategy.id) : null,
    strategy
  };
}

function isActiveObjective(context, objectiveId) {
  const key = objectiveKey(objectiveId);
  if (!key) return false;
  const set = context && context.active_objective_set instanceof Set
    ? context.active_objective_set
    : new Set();
  return set.has(key);
}

function extractWorkflowValueCurrency(row) {
  const src = row && typeof row === 'object' ? row : {};
  const direct = normalizeCurrency(src.value_currency);
  if (direct) return direct;
  const meta = src.metadata && typeof src.metadata === 'object' ? src.metadata : {};
  const fromMeta = normalizeCurrency(meta.value_currency);
  if (fromMeta) return fromMeta;
  const lineage = src.lineage && typeof src.lineage === 'object' ? src.lineage : {};
  const fromLineage = normalizeCurrency(lineage.value_currency);
  if (fromLineage) return fromLineage;
  return null;
}

function evaluateWorkflowDraft(draft, options = {}) {
  const context = options.context && typeof options.context === 'object'
    ? options.context
    : loadIdentityContext(options);
  const policy = context.policy || defaultPolicy();
  const enforcement = policy.enforcement || defaultPolicy().enforcement;
  const weights = policy.weights || defaultPolicy().weights;
  const parent = options.parent && typeof options.parent === 'object' ? options.parent : null;

  const objectiveId = normalizeObjectiveId(draft && draft.objective_id);
  const parentObjectiveId = normalizeObjectiveId(parent && parent.objective_id);
  const valueCurrency = extractWorkflowValueCurrency(draft);
  const parentValueCurrency = extractWorkflowValueCurrency(parent);
  const activeObjective = objectiveId ? isActiveObjective(context, objectiveId) : false;
  const expectedValueCurrency = objectiveId
    ? (context.objective_currency && context.objective_currency[objectiveId]
      ? normalizeCurrency(context.objective_currency[objectiveId])
      : expectedCurrencyForObjective(context.strategy, objectiveId))
    : null;

  const depth = safeNumber(draft && draft.fractal_depth, 0);
  const parentDepth = safeNumber(parent && parent.fractal_depth, 0);
  const reasons = [];

  function addReason(code, message, weight, block) {
    reasons.push({
      code,
      message,
      weight: Number(clampNumber(weight, 0, 1, 0).toFixed(4)),
      block: block === true
    });
  }

  if (parentObjectiveId) {
    if (!objectiveId) {
      addReason(
        'objective_missing_parent',
        `child branch missing objective_id while parent objective is ${parentObjectiveId}`,
        weights.objective_missing_parent,
        enforcement.block_on_objective_missing_when_parent_present === true
      );
    } else if (objectiveKey(objectiveId) !== objectiveKey(parentObjectiveId)) {
      addReason(
        'objective_mismatch_parent',
        `child objective ${objectiveId} diverges from parent objective ${parentObjectiveId}`,
        weights.objective_mismatch_parent,
        enforcement.block_on_parent_objective_mismatch === true
      );
    }
  } else if (!objectiveId) {
    addReason(
      'identity_missing_objective',
      'candidate has no objective_id; defaulting to neutral identity alignment',
      weights.identity_missing_objective,
      false
    );
  }

  if (
    objectiveId
    && context.active_objective_ids
    && context.active_objective_ids.length
    && activeObjective !== true
  ) {
    addReason(
      enforcement.block_on_unknown_active_objective === true
        ? 'objective_not_active'
        : 'objective_not_active_soft',
      `objective ${objectiveId} is not in active directive set`,
      weights.objective_unknown_active,
      enforcement.block_on_unknown_active_objective === true
    );
  }

  if (
    parentValueCurrency
    && valueCurrency
    && parentValueCurrency !== valueCurrency
  ) {
    addReason(
      'value_currency_mismatch_parent',
      `value currency ${valueCurrency} diverges from parent currency ${parentValueCurrency}`,
      weights.value_currency_mismatch_parent,
      enforcement.block_on_parent_value_currency_mismatch === true
    );
  }

  if (
    activeObjective === true
    && expectedValueCurrency
    && valueCurrency
    && expectedValueCurrency !== valueCurrency
  ) {
    addReason(
      'value_currency_mismatch_objective',
      `value currency ${valueCurrency} diverges from expected objective currency ${expectedValueCurrency}`,
      weights.value_currency_mismatch_objective,
      enforcement.block_on_active_objective_currency_mismatch === true
    );
  }

  if (
    parent
    && Number.isFinite(depth)
    && Number.isFinite(parentDepth)
    && (depth - parentDepth) > Number(policy.branch_rules && policy.branch_rules.max_depth_delta_without_approval || 2)
  ) {
    addReason(
      'branch_depth_jump',
      `fractal_depth jump ${depth - parentDepth} exceeds policy max_depth_delta_without_approval`,
      weights.branch_depth_jump,
      enforcement.block_on_branch_depth_jump === true
    );
  }

  const identityDriftScore = Number(
    clampNumber(
      reasons.reduce((sum, row) => sum + Number(row.weight || 0), 0),
      0,
      1,
      0
    ).toFixed(4)
  );
  const blockingCodes = reasons.filter((row) => row && row.block === true).map((row) => row.code);
  if (
    identityDriftScore > Number(policy.max_identity_drift_score || 0.58)
    && !blockingCodes.includes('identity_drift_above_max')
  ) {
    blockingCodes.push('identity_drift_above_max');
    reasons.push({
      code: 'identity_drift_above_max',
      message: `identity drift ${identityDriftScore} exceeds max ${Number(policy.max_identity_drift_score || 0.58)}`,
      weight: Number(identityDriftScore.toFixed(4)),
      block: true
    });
  }

  const suggestions = [];
  if (blockingCodes.includes('objective_missing_parent')) {
    suggestions.push(`inherit parent objective_id=${parentObjectiveId}`);
  }
  if (blockingCodes.includes('objective_mismatch_parent')) {
    suggestions.push(`align objective_id with parent objective_id=${parentObjectiveId}`);
  }
  if (blockingCodes.includes('objective_not_active')) {
    suggestions.push('set objective_id to an active directive objective');
  }
  if (blockingCodes.includes('value_currency_mismatch_parent') && parentValueCurrency) {
    suggestions.push(`align value_currency with parent value_currency=${parentValueCurrency}`);
  }
  if (blockingCodes.includes('value_currency_mismatch_objective') && expectedValueCurrency) {
    suggestions.push(`align value_currency with expected objective currency=${expectedValueCurrency}`);
  }

  return {
    ts: nowIso(),
    scope: 'workflow',
    source: String(options.source || 'identity_anchor').trim() || 'identity_anchor',
    candidate_id: String(draft && draft.id || '').trim() || null,
    objective_id: objectiveId || null,
    parent_objective_id: parentObjectiveId || null,
    active_objective: objectiveId ? activeObjective === true : null,
    value_currency: valueCurrency || null,
    expected_value_currency: expectedValueCurrency || null,
    parent_value_currency: parentValueCurrency || null,
    fractal_depth: Number.isFinite(depth) ? depth : null,
    parent_depth: parent ? (Number.isFinite(parentDepth) ? parentDepth : null) : null,
    identity_drift_score: identityDriftScore,
    allowed: blockingCodes.length === 0,
    blocked: blockingCodes.length > 0,
    blocking_codes: blockingCodes,
    reasons,
    suggestions
  };
}

function evaluateMorphAction(action, options = {}) {
  const context = options.context && typeof options.context === 'object'
    ? options.context
    : loadIdentityContext(options);
  const policy = context.policy || defaultPolicy();
  const enforcement = policy.enforcement || defaultPolicy().enforcement;
  const weights = policy.weights || defaultPolicy().weights;
  const objectiveId = normalizeObjectiveId(options.objective_id || action && action.objective_id);
  const activeObjective = objectiveId ? isActiveObjective(context, objectiveId) : false;
  const expectedValueCurrency = objectiveId
    ? (context.objective_currency && context.objective_currency[objectiveId]
      ? normalizeCurrency(context.objective_currency[objectiveId])
      : expectedCurrencyForObjective(context.strategy, objectiveId))
    : null;
  const valueCurrency = normalizeCurrency(options.value_currency || action && action.value_currency);
  const reasons = [];

  function addReason(code, message, weight, block) {
    reasons.push({
      code,
      message,
      weight: Number(clampNumber(weight, 0, 1, 0).toFixed(4)),
      block: block === true
    });
  }

  if (
    objectiveId
    && context.active_objective_ids
    && context.active_objective_ids.length
    && activeObjective !== true
  ) {
    addReason(
      enforcement.block_on_unknown_active_objective === true
        ? 'objective_not_active'
        : 'objective_not_active_soft',
      `morph objective ${objectiveId} is not in active directive set`,
      weights.objective_unknown_active,
      enforcement.block_on_unknown_active_objective === true
    );
  }

  if (
    activeObjective === true
    && expectedValueCurrency
    && valueCurrency
    && expectedValueCurrency !== valueCurrency
  ) {
    addReason(
      'value_currency_mismatch_objective',
      `morph action value currency ${valueCurrency} diverges from expected ${expectedValueCurrency}`,
      weights.value_currency_mismatch_objective,
      enforcement.block_on_active_objective_currency_mismatch === true
    );
  }

  if (!objectiveId && String(action && action.kind || '').trim().toLowerCase() === 'spawn') {
    addReason(
      'identity_missing_objective',
      'spawn morph action has no objective context; keeping neutral alignment',
      weights.identity_missing_objective,
      false
    );
  }

  const identityDriftScore = Number(
    clampNumber(
      reasons.reduce((sum, row) => sum + Number(row.weight || 0), 0),
      0,
      1,
      0
    ).toFixed(4)
  );
  const blockingCodes = reasons.filter((row) => row && row.block === true).map((row) => row.code);
  if (
    identityDriftScore > Number(policy.max_identity_drift_score || 0.58)
    && !blockingCodes.includes('identity_drift_above_max')
  ) {
    blockingCodes.push('identity_drift_above_max');
    reasons.push({
      code: 'identity_drift_above_max',
      message: `identity drift ${identityDriftScore} exceeds max ${Number(policy.max_identity_drift_score || 0.58)}`,
      weight: Number(identityDriftScore.toFixed(4)),
      block: true
    });
  }

  return {
    ts: nowIso(),
    scope: 'morph',
    source: String(options.source || 'identity_anchor').trim() || 'identity_anchor',
    action_id: String(action && action.id || '').trim() || null,
    kind: String(action && action.kind || '').trim() || null,
    target: String(action && action.target || '').trim() || null,
    objective_id: objectiveId || null,
    active_objective: objectiveId ? activeObjective === true : null,
    value_currency: valueCurrency || null,
    expected_value_currency: expectedValueCurrency || null,
    identity_drift_score: identityDriftScore,
    allowed: blockingCodes.length === 0,
    blocked: blockingCodes.length > 0,
    blocking_codes: blockingCodes,
    reasons
  };
}

function summarizeIdentityEvaluations(rows, maxIdentityDriftScore = 0.58) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return {
      checked: 0,
      blocked: 0,
      allowed: 0,
      identity_drift_score: 0,
      max_identity_drift_score: Number(clampNumber(maxIdentityDriftScore, 0, 1, 0.58).toFixed(4)),
      max_candidate_drift_score: 0,
      blocking_code_counts: {}
    };
  }
  const checked = list.length;
  const blocked = list.filter((row) => row && row.blocked === true).length;
  const allowed = checked - blocked;
  const driftValues = list.map((row) => safeNumber(row && row.identity_drift_score, 0));
  const avgDrift = driftValues.reduce((sum, n) => sum + n, 0) / Math.max(1, driftValues.length);
  const blockingCodeCounts = {};
  for (const row of list) {
    const codes = Array.isArray(row && row.blocking_codes) ? row.blocking_codes : [];
    for (const code of codes) {
      const key = String(code || '').trim();
      if (!key) continue;
      blockingCodeCounts[key] = Number(blockingCodeCounts[key] || 0) + 1;
    }
  }
  return {
    checked,
    blocked,
    allowed,
    identity_drift_score: Number(clampNumber(avgDrift, 0, 1, 0).toFixed(4)),
    max_identity_drift_score: Number(clampNumber(maxIdentityDriftScore, 0, 1, 0.58).toFixed(4)),
    max_candidate_drift_score: Number(Math.max(...driftValues).toFixed(4)),
    blocking_code_counts: blockingCodeCounts
  };
}

function evaluateMorphActions(actions, options = {}) {
  const context = options.context && typeof options.context === 'object'
    ? options.context
    : loadIdentityContext(options);
  const evalRows = [];
  for (const action of Array.isArray(actions) ? actions : []) {
    evalRows.push(evaluateMorphAction(action, {
      ...options,
      context
    }));
  }
  const summary = summarizeIdentityEvaluations(
    evalRows,
    Number(context.policy && context.policy.max_identity_drift_score || 0.58)
  );
  return {
    context,
    evaluations: evalRows,
    summary,
    allowed_actions: evalRows.filter((row) => row.allowed).map((row) => row.action_id),
    blocked_actions: evalRows.filter((row) => row.blocked).map((row) => row.action_id)
  };
}

function receiptPathForDate(dateStr) {
  return path.join(OUT_DIR, `${dateStr}.jsonl`);
}

function writeIdentityReceipt(options = {}) {
  const context = options.context && typeof options.context === 'object'
    ? options.context
    : loadIdentityContext(options);
  const policy = context.policy || defaultPolicy();
  if (policy.receipts && policy.receipts.write === false) {
    return {
      written: false,
      receipt_path: relPath(receiptPathForDate(context.date)),
      latest_path: relPath(LATEST_PATH)
    };
  }
  const maxRows = Number(policy.receipts && policy.receipts.max_rows || 240);
  const evaluations = Array.isArray(options.evaluations)
    ? options.evaluations.slice(0, Math.max(20, maxRows))
    : [];
  const summary = options.summary && typeof options.summary === 'object'
    ? options.summary
    : summarizeIdentityEvaluations(evaluations, Number(policy.max_identity_drift_score || 0.58));
  const row = {
    ts: nowIso(),
    type: 'identity_anchor_receipt',
    date: context.date,
    scope: normalizeScope(options.scope || 'all'),
    source: String(options.source || 'identity_anchor').trim() || 'identity_anchor',
    strategy_id: context.strategy_id || null,
    active_objective_ids: Array.isArray(context.active_objective_ids) ? context.active_objective_ids : [],
    summary,
    evaluations
  };
  const receiptPath = receiptPathForDate(context.date);
  appendJsonl(receiptPath, row);
  writeJsonAtomic(LATEST_PATH, {
    ok: true,
    type: 'identity_anchor_latest',
    ts: row.ts,
    date: context.date,
    scope: row.scope,
    source: row.source,
    strategy_id: row.strategy_id,
    active_objective_ids: row.active_objective_ids,
    summary: row.summary,
    receipt_path: relPath(receiptPath),
    policy_path: relPath(context.policy_path || DEFAULT_POLICY_PATH)
  });
  return {
    written: true,
    receipt_path: relPath(receiptPath),
    latest_path: relPath(LATEST_PATH)
  };
}

function flattenWorkflowDraftTree(rows) {
  const out = [];
  const queue = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    queue.push({
      row,
      parent_workflow_id: row.parent_workflow_id || null,
      fractal_depth: safeNumber(row.fractal_depth, 0)
    });
  }
  while (queue.length) {
    const current = queue.shift();
    if (!current || !current.row || typeof current.row !== 'object') continue;
    const children = Array.isArray(current.row.children) ? current.row.children : [];
    out.push({
      ...current.row,
      parent_workflow_id: current.parent_workflow_id || null,
      fractal_depth: safeNumber(current.fractal_depth, 0),
      children: undefined
    });
    for (const child of children) {
      if (!child || typeof child !== 'object') continue;
      queue.push({
        row: child,
        parent_workflow_id: current.row.id || current.parent_workflow_id || null,
        fractal_depth: safeNumber(current.fractal_depth, 0) + 1
      });
    }
  }
  return out;
}

function evaluateWorkflowSnapshot(dateStr, options = {}) {
  const snapshotPath = path.resolve(String(options.workflow_snapshot || DEFAULT_WORKFLOW_SNAPSHOT_PATH));
  const registryPath = path.resolve(String(options.workflow_registry || DEFAULT_WORKFLOW_REGISTRY_PATH));
  const snapshotPayload = readJson(snapshotPath, null);
  if (!snapshotPayload || typeof snapshotPayload !== 'object') {
    return {
      ok: false,
      reason: 'workflow_snapshot_missing',
      snapshot_path: relPath(snapshotPath),
      evaluations: [],
      summary: summarizeIdentityEvaluations([], 0.58)
    };
  }

  const context = options.context && typeof options.context === 'object'
    ? options.context
    : loadIdentityContext({ date: dateStr, policy_path: options.policy_path });
  const registry = readJson(registryPath, {});
  const registryRows = Array.isArray(registry && registry.workflows) ? registry.workflows : [];
  const parentMap = new Map();
  for (const row of registryRows) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id || '').trim();
    if (!id) continue;
    parentMap.set(id, row);
  }

  const sourceRows = Array.isArray(snapshotPayload.promotable_drafts) && snapshotPayload.promotable_drafts.length
    ? snapshotPayload.promotable_drafts
    : (Array.isArray(snapshotPayload.drafts) ? snapshotPayload.drafts : []);
  const drafts = flattenWorkflowDraftTree(sourceRows);
  const evaluations = [];
  for (const row of drafts) {
    const parentId = String(row && row.parent_workflow_id || '').trim();
    const parent = parentId && parentMap.has(parentId) ? parentMap.get(parentId) : null;
    evaluations.push(evaluateWorkflowDraft(row, {
      context,
      parent,
      source: 'identity_anchor_workflow_snapshot'
    }));
  }
  const summary = summarizeIdentityEvaluations(
    evaluations,
    Number(context.policy && context.policy.max_identity_drift_score || 0.58)
  );
  return {
    ok: true,
    snapshot_path: relPath(snapshotPath),
    registry_path: relPath(registryPath),
    evaluations,
    summary
  };
}

function evaluateMorphPlan(dateStr, options = {}) {
  const planPath = path.resolve(String(
    options.morph_plan
      || path.join(DEFAULT_MORPH_PLAN_DIR, `${dateStr}.json`)
  ));
  const payload = readJson(planPath, null);
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      reason: 'morph_plan_missing',
      plan_path: relPath(planPath),
      evaluations: [],
      summary: summarizeIdentityEvaluations([], 0.58)
    };
  }
  const context = options.context && typeof options.context === 'object'
    ? options.context
    : loadIdentityContext({ date: dateStr, policy_path: options.policy_path });
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const evaluated = evaluateMorphActions(actions, {
    context,
    source: 'identity_anchor_morph_plan',
    objective_id: payload.objective_id || null,
    value_currency: payload.value_currency || null
  });
  return {
    ok: true,
    plan_path: relPath(planPath),
    evaluations: evaluated.evaluations,
    summary: evaluated.summary
  };
}

function runCmd(dateStr, args) {
  const scope = normalizeScope(args.scope);
  const strict = boolFlag(args.strict, false);
  const context = loadIdentityContext({
    date: dateStr,
    policy_path: args.policy
  });

  let workflow = {
    ok: true,
    evaluations: [],
    summary: summarizeIdentityEvaluations([], Number(context.policy.max_identity_drift_score || 0.58))
  };
  let morph = {
    ok: true,
    evaluations: [],
    summary: summarizeIdentityEvaluations([], Number(context.policy.max_identity_drift_score || 0.58))
  };

  if (scope === 'all' || scope === 'workflows') {
    workflow = evaluateWorkflowSnapshot(dateStr, {
      context,
      workflow_snapshot: args['workflow-snapshot'],
      workflow_registry: args['workflow-registry']
    });
  }
  if (scope === 'all' || scope === 'morph') {
    morph = evaluateMorphPlan(dateStr, {
      context,
      morph_plan: args['morph-plan']
    });
  }

  const allEvaluations = []
    .concat(Array.isArray(workflow.evaluations) ? workflow.evaluations : [])
    .concat(Array.isArray(morph.evaluations) ? morph.evaluations : []);
  const totalSummary = summarizeIdentityEvaluations(
    allEvaluations,
    Number(context.policy && context.policy.max_identity_drift_score || 0.58)
  );

  const receipt = writeIdentityReceipt({
    context,
    scope,
    source: 'identity_anchor_run',
    evaluations: allEvaluations,
    summary: totalSummary
  });

  const output = {
    ok: strict ? totalSummary.blocked === 0 : true,
    type: 'identity_anchor_run',
    date: dateStr,
    scope,
    strict,
    strategy_id: context.strategy_id || null,
    active_objective_ids: context.active_objective_ids || [],
    policy_path: relPath(context.policy_path || DEFAULT_POLICY_PATH),
    workflow_checked: Number(workflow.summary && workflow.summary.checked || 0),
    workflow_blocked: Number(workflow.summary && workflow.summary.blocked || 0),
    morph_checked: Number(morph.summary && morph.summary.checked || 0),
    morph_blocked: Number(morph.summary && morph.summary.blocked || 0),
    checked: totalSummary.checked,
    blocked: totalSummary.blocked,
    identity_drift_score: totalSummary.identity_drift_score,
    max_identity_drift_score: totalSummary.max_identity_drift_score,
    blocking_code_counts: totalSummary.blocking_code_counts,
    receipt_path: receipt.receipt_path || null,
    latest_path: receipt.latest_path || null,
    workflow_snapshot_path: workflow.snapshot_path || null,
    morph_plan_path: morph.plan_path || null
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (strict && output.ok !== true) process.exitCode = 1;
}

function readLatestReceipt(dateStr) {
  if (String(dateStr || '').trim().toLowerCase() === 'latest') {
    return readJson(LATEST_PATH, null);
  }
  const fp = receiptPathForDate(dateArgOrToday(dateStr));
  const rows = readJsonl(fp);
  if (!rows.length) return null;
  return rows[rows.length - 1];
}

function statusCmd(dateStr) {
  const row = readLatestReceipt(dateStr);
  if (!row || typeof row !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'identity_anchor_status',
      date: String(dateStr || 'latest'),
      error: 'receipt_not_found'
    })}\n`);
    return;
  }
  const summary = row.summary && typeof row.summary === 'object'
    ? row.summary
    : summarizeIdentityEvaluations([], 0.58);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'identity_anchor_status',
    date: row.date || null,
    scope: row.scope || null,
    source: row.source || null,
    strategy_id: row.strategy_id || null,
    checked: Number(summary.checked || 0),
    blocked: Number(summary.blocked || 0),
    identity_drift_score: Number(summary.identity_drift_score || 0),
    max_identity_drift_score: Number(summary.max_identity_drift_score || 0),
    blocking_code_counts: summary.blocking_code_counts || {},
    receipt_path: row.date ? relPath(receiptPathForDate(row.date)) : null,
    latest_path: relPath(LATEST_PATH)
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help' || args.help === true) {
    usage();
    return;
  }
  if (cmd === 'run') {
    runCmd(dateArgOrToday(args._[1]), args);
    return;
  }
  if (cmd === 'status') {
    statusCmd(args._[1] || 'latest');
    return;
  }
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'identity_anchor',
      error: String(err && err.message ? err.message : err || 'identity_anchor_failed')
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  loadIdentityContext,
  evaluateWorkflowDraft,
  evaluateMorphAction,
  evaluateMorphActions,
  summarizeIdentityEvaluations,
  writeIdentityReceipt,
  extractWorkflowValueCurrency,
  main
};
