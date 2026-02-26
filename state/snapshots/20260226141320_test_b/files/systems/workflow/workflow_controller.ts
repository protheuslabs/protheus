#!/usr/bin/env node
'use strict';
export {};

/**
 * workflow_controller.js
 *
 * Controller for adaptive workflow drafts/registry materialization.
 *
 * Usage:
 *   node systems/workflow/workflow_controller.js run [YYYY-MM-DD] [--days=N] [--max=N] [--apply=1|0]
 *   node systems/workflow/workflow_controller.js list [--status=active|draft|all] [--limit=N]
 *   node systems/workflow/workflow_controller.js status
 */

const fs = require('fs');
const path = require('path');
const { generateDrafts, loadPolicy } = require('./workflow_generator');
const {
  loadActiveStrategy,
  strategyExecutionMode
} = require('../../lib/strategy_resolver');
const {
  generateAdaptiveDrafts,
  loadPolicy: loadOrchestronPolicy
} = require('./orchestron/adaptive_controller');
const {
  loadIdentityContext,
  evaluateWorkflowDraft,
  summarizeIdentityEvaluations,
  writeIdentityReceipt
} = require('../identity/identity_anchor');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = process.env.WORKFLOW_REGISTRY_PATH
  ? path.resolve(process.env.WORKFLOW_REGISTRY_PATH)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'registry.json');
const ORCHESTRON_OUT_DIR = process.env.ORCHESTRON_OUT_DIR
  ? path.resolve(process.env.ORCHESTRON_OUT_DIR)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'orchestron');
const ORCHESTRON_LATEST_PATH = process.env.ORCHESTRON_LATEST_PATH
  ? path.resolve(process.env.ORCHESTRON_LATEST_PATH)
  : path.join(ORCHESTRON_OUT_DIR, 'latest.json');
const PROMOTION_RECEIPTS_DIR = process.env.WORKFLOW_PROMOTION_RECEIPTS_DIR
  ? path.resolve(process.env.WORKFLOW_PROMOTION_RECEIPTS_DIR)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'promotion_receipts');
const DEFAULT_POLICY_PATH = path.join(REPO_ROOT, 'config', 'workflow_policy.json');
const DEFAULT_ORCHESTRON_POLICY_PATH = path.join(REPO_ROOT, 'config', 'orchestron_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/workflow/workflow_controller.js run [YYYY-MM-DD] [--days=N] [--max=N] [--apply=1|0] [--policy=path] [--orchestron=1|0] [--orchestron-apply=1|0] [--orchestron-auto=1|0] [--intent=\"...\"] [--value-currency=<currency>] [--objective-id=<id>] [--orchestron-policy=path]');
  console.log('  node systems/workflow/workflow_controller.js promote [--source=promotable|passing|drafts] [--status=active|draft] [--id=<workflow_id[,workflow_id...]>] [--from=path] [--dry-run=1|0] [--ignore-threshold=1|0] [--approval-note="..."] [--approver-id=<id>] [--policy=path]');
  console.log('  node systems/workflow/workflow_controller.js list [--status=active|draft|all] [--limit=N]');
  console.log('  node systems/workflow/workflow_controller.js status [--policy=path] [--orchestron-latest=path]');
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

function cleanText(v, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function boolFlag(v, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
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

function defaultRegistry() {
  return {
    version: '1.0',
    updated_at: null,
    generated_at: null,
    workflows: []
  };
}

function normalizeWorkflow(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const id = String(src.id || '').trim();
  if (!id) return null;
  const statusRaw = String(src.status || 'draft').trim().toLowerCase();
  const status = statusRaw === 'active' || statusRaw === 'disabled' ? statusRaw : 'draft';
  return {
    ...src,
    id,
    name: String(src.name || id).trim(),
    status,
    source: String(src.source || 'unknown').trim(),
    updated_at: String(src.updated_at || src.generated_at || nowIso())
  };
}

function loadRegistry() {
  const payload = readJson(REGISTRY_PATH, defaultRegistry());
  const workflows = Array.isArray(payload && payload.workflows) ? payload.workflows : [];
  const normalized = workflows.map(normalizeWorkflow).filter(Boolean);
  return {
    version: String(payload && payload.version || '1.0'),
    updated_at: payload && payload.updated_at ? String(payload.updated_at) : null,
    generated_at: payload && payload.generated_at ? String(payload.generated_at) : null,
    workflows: normalized
  };
}

function saveRegistry(registry) {
  const rows = Array.isArray(registry && registry.workflows) ? registry.workflows : [];
  const dedupe = new Map();
  for (const row of rows) {
    const normalized = normalizeWorkflow(row);
    if (!normalized) continue;
    dedupe.set(normalized.id, normalized);
  }
  const payload = {
    version: '1.0',
    updated_at: nowIso(),
    generated_at: registry && registry.generated_at ? registry.generated_at : null,
    workflows: Array.from(dedupe.values()).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  };
  writeJsonAtomic(REGISTRY_PATH, payload);
  return payload;
}

function applyDrafts(registry, drafts, policy, options = {}) {
  const rows = Array.isArray(registry && registry.workflows) ? registry.workflows.slice() : [];
  const map = new Map(rows.map((row) => [String(row.id || ''), row]));
  const threshold = Number(policy && policy.apply_threshold || 0.62);
  const ignoreThreshold = options && options.ignore_threshold === true;
  const statusRaw = String(options && options.status || 'active').trim().toLowerCase();
  const targetStatus = statusRaw === 'draft' ? 'draft' : 'active';
  const writeIdentityReceiptEnabled = options && options.identity_write_receipt !== false;
  let applied = 0;
  let updated = 0;
  const activatedThisRun = new Set();
  const identityDate = dateArgOrToday(options && options.date);
  const identitySource = String(options && options.identity_source || 'workflow_controller').trim() || 'workflow_controller';
  let identityContext = null;
  let identityError = null;
  try {
    identityContext = loadIdentityContext({ date: identityDate });
  } catch (err) {
    identityError = String(err && err.message ? err.message : err || 'identity_anchor_unavailable');
  }
  const identityEvaluations = [];

  function resolveRootWorkflowId(workflowId, maxHops = 24) {
    let currentId = String(workflowId || '').trim();
    if (!currentId) return null;
    let hops = 0;
    while (hops < maxHops) {
      const row = map.get(currentId);
      if (!row || typeof row !== 'object') break;
      const parentId = String(row.parent_workflow_id || '').trim();
      if (!parentId) return currentId;
      currentId = parentId;
      hops += 1;
    }
    return currentId || null;
  }

  function flattenDraftTree(sourceRows) {
    const out = [];
    const queue = [];
    for (const row of Array.isArray(sourceRows) ? sourceRows : []) {
      if (!row || typeof row !== 'object') continue;
      queue.push({
        row,
        parent_workflow_id: row.parent_workflow_id || null,
        fractal_depth: Number(row.fractal_depth || 0)
      });
    }
    while (queue.length) {
      const current = queue.shift();
      if (!current || !current.row || typeof current.row !== 'object') continue;
      const children = Array.isArray(current.row.children) ? current.row.children : [];
      out.push({
        ...current.row,
        parent_workflow_id: current.parent_workflow_id || null,
        fractal_depth: Number(current.fractal_depth || 0),
        children_ids: children.map((child) => String(child && child.id || '')).filter(Boolean),
        children: undefined
      });
      for (const child of children) {
        if (!child || typeof child !== 'object') continue;
        queue.push({
          row: child,
          parent_workflow_id: current.row.id || current.parent_workflow_id || null,
          fractal_depth: Number(current.fractal_depth || 0) + 1
        });
      }
    }
    return out;
  }

  for (const draft of flattenDraftTree(drafts)) {
    const score = Number(draft && draft.metrics && draft.metrics.score || 0);
    if (!ignoreThreshold && score < threshold) continue;
    const id = String(draft && draft.id || '').trim();
    if (!id) continue;
    const parentWorkflowId = String(draft && draft.parent_workflow_id || '').trim();
    if (parentWorkflowId) {
      const parentKnown = map.has(parentWorkflowId) || activatedThisRun.has(parentWorkflowId);
      if (!parentKnown) continue;
    }
    const effectiveParentId = parentWorkflowId || null;
    const parentRow = effectiveParentId ? (map.get(effectiveParentId) || null) : null;
    if (targetStatus === 'active' && identityContext) {
      const identityVerdict = evaluateWorkflowDraft(draft, {
        context: identityContext,
        parent: parentRow,
        source: identitySource
      });
      identityEvaluations.push(identityVerdict);
      if (identityVerdict && identityVerdict.blocked === true) continue;
    }
    const rootWorkflowId = effectiveParentId ? (resolveRootWorkflowId(effectiveParentId) || effectiveParentId) : id;
    const depth = Number(draft && draft.fractal_depth || 0);
    const existing = map.get(id);
    const activatedAt = targetStatus === 'active'
      ? (existing && existing.activated_at ? existing.activated_at : nowIso())
      : (existing && existing.activated_at ? existing.activated_at : null);
    const lineageState = targetStatus === 'active'
      ? (effectiveParentId ? 'child_active' : 'root_active')
      : (effectiveParentId ? 'child_draft' : 'root_draft');
    const row = {
      ...(existing || {}),
      ...draft,
      parent_workflow_id: effectiveParentId,
      status: targetStatus,
      source: existing ? 'adaptive_workflow_controller_update' : 'adaptive_workflow_controller',
      activated_at: activatedAt,
      fractal_state: lineageState,
      lineage: {
        parent_workflow_id: effectiveParentId,
        root_workflow_id: rootWorkflowId,
        fractal_depth: depth,
        state: lineageState,
        activation_mode: existing ? 'update' : 'promote',
        activated_at: activatedAt
      },
      updated_at: nowIso()
    };
    map.set(id, row);
    activatedThisRun.add(id);
    if (existing) updated += 1;
    else applied += 1;
  }

  const maxRows = Number(policy && policy.max_registry_workflows || 128);
  const workflows = Array.from(map.values())
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .slice(0, Math.max(8, maxRows));
  const identitySummary = summarizeIdentityEvaluations(
    identityEvaluations,
    Number(identityContext && identityContext.policy && identityContext.policy.max_identity_drift_score || 0.58)
  );
  let identityReceiptPath = null;
  if (identityContext && writeIdentityReceiptEnabled) {
    const receipt = writeIdentityReceipt({
      context: identityContext,
      scope: 'workflows',
      source: identitySource,
      evaluations: identityEvaluations,
      summary: identitySummary
    });
    identityReceiptPath = receipt && receipt.receipt_path ? String(receipt.receipt_path) : null;
  }
  return {
    workflows,
    applied,
    updated,
    identity_checked: Number(identitySummary.checked || 0),
    identity_blocked: Number(identitySummary.blocked || 0),
    identity_drift_score: Number(identitySummary.identity_drift_score || 0),
    identity_max_drift_score: Number(identitySummary.max_identity_drift_score || 0),
    identity_blocking_code_counts: identitySummary.blocking_code_counts || {},
    identity_receipt_path: identityReceiptPath,
    identity_error: identityError
  };
}

function loadOrchestronSnapshot(filePath) {
  const resolved = path.resolve(String(filePath || ORCHESTRON_LATEST_PATH));
  const payload = readJson(resolved, null);
  if (!payload || typeof payload !== 'object') {
    return {
      path: resolved,
      payload: null
    };
  }
  return {
    path: resolved,
    payload
  };
}

function normalizePromotionSource(raw) {
  const source = String(raw || 'promotable').trim().toLowerCase();
  if (source === 'drafts') return 'drafts';
  if (source === 'passing') return 'passing';
  return 'promotable';
}

function parseIdFilter(raw) {
  const txt = String(raw || '').trim();
  if (!txt) return null;
  const ids = txt.split(',').map((v) => String(v || '').trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function selectPromotableRows(snapshotPayload, source, idFilter) {
  const payload = snapshotPayload && typeof snapshotPayload === 'object' ? snapshotPayload : {};
  const sourceRows = source === 'drafts'
    ? (Array.isArray(payload.drafts) ? payload.drafts : [])
    : (source === 'passing'
        ? (Array.isArray(payload.passing) ? payload.passing : [])
        : (Array.isArray(payload.promotable_drafts) ? payload.promotable_drafts : []));
  const rows = idFilter
    ? sourceRows.filter((row) => row && idFilter.has(String(row.id || '').trim()))
    : sourceRows.slice();
  return {
    rows,
    source_total: sourceRows.length,
    selected: rows.length
  };
}

function normalizePromotionGatePolicy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled !== false,
    require_contract_fields: src.require_contract_fields !== false,
    require_non_regression: src.require_non_regression !== false,
    require_approval_receipt: src.require_approval_receipt !== false,
    require_gate_step: src.require_gate_step !== false,
    require_receipt_step: src.require_receipt_step !== false,
    require_approver_id: src.require_approver_id !== false,
    require_approval_note: src.require_approval_note !== false,
    max_predicted_drift_delta: clampNumber(src.max_predicted_drift_delta, -1, 1, 0),
    min_predicted_yield_delta: clampNumber(src.min_predicted_yield_delta, -1, 1, 0),
    min_safety_score: clampNumber(src.min_safety_score, 0, 1, 0.5),
    max_regression_risk: clampNumber(src.max_regression_risk, 0, 1, 0.56),
    max_red_team_critical_fail_cases: clampInt(src.max_red_team_critical_fail_cases, 0, 64, 0)
  };
}

function hasStepType(steps, type) {
  const target = String(type || '').trim().toLowerCase();
  return (Array.isArray(steps) ? steps : []).some((row) => String(row && row.type || '').trim().toLowerCase() === target);
}

function normalizeDraftMetricValue(metrics, key) {
  const n = Number(metrics && metrics[key]);
  return Number.isFinite(n) ? n : null;
}

function evaluatePromotionGate(draft, context = {}) {
  const row = draft && typeof draft === 'object' ? draft : {};
  const policy = normalizePromotionGatePolicy(context.policy);
  const reasons = [];
  if (policy.enabled !== true) {
    return { pass: true, reasons, policy };
  }

  const status = String(context.status || 'active').trim().toLowerCase() === 'draft' ? 'draft' : 'active';
  const dryRun = context.dry_run === true;
  const approverId = cleanText(context.approver_id || '', 80);
  const approvalNote = cleanText(context.approval_note || '', 240);
  const snapshotRedTeamCritical = clampInt(context.snapshot_red_team_critical_fail_cases, 0, 1000, 0);
  const steps = Array.isArray(row.steps) ? row.steps : [];
  const metrics = row.metrics && typeof row.metrics === 'object' ? row.metrics : {};

  if (policy.require_contract_fields) {
    if (!cleanText(row.id || '', 120)) reasons.push('contract_id_missing');
    if (!cleanText(row.name || '', 180)) reasons.push('contract_name_missing');
    if (!cleanText(row.trigger && row.trigger.proposal_type || '', 120)) reasons.push('contract_trigger_missing');
    if (!steps.length) reasons.push('contract_steps_missing');
    if (policy.require_gate_step && !hasStepType(steps, 'gate')) reasons.push('contract_gate_step_missing');
    if (policy.require_receipt_step && !hasStepType(steps, 'receipt')) reasons.push('contract_receipt_step_missing');
    if (!Number.isFinite(Number(metrics.score))) reasons.push('contract_metrics_score_missing');
  }

  if (status === 'active' && policy.require_non_regression) {
    const predictedDriftDelta = normalizeDraftMetricValue(metrics, 'predicted_drift_delta');
    const predictedYieldDelta = normalizeDraftMetricValue(metrics, 'predicted_yield_delta');
    const safetyScore = normalizeDraftMetricValue(metrics, 'safety_score');
    const regressionRisk = normalizeDraftMetricValue(metrics, 'regression_risk');
    if (predictedDriftDelta == null) reasons.push('non_regression_missing_predicted_drift');
    else if (predictedDriftDelta > policy.max_predicted_drift_delta) reasons.push('non_regression_predicted_drift_above_max');
    if (predictedYieldDelta == null) reasons.push('non_regression_missing_predicted_yield');
    else if (predictedYieldDelta < policy.min_predicted_yield_delta) reasons.push('non_regression_predicted_yield_below_min');
    if (safetyScore == null) reasons.push('non_regression_missing_safety_score');
    else if (safetyScore < policy.min_safety_score) reasons.push('non_regression_safety_below_min');
    if (regressionRisk == null) reasons.push('non_regression_missing_regression_risk');
    else if (regressionRisk > policy.max_regression_risk) reasons.push('non_regression_regression_risk_above_max');
    if (snapshotRedTeamCritical > policy.max_red_team_critical_fail_cases) reasons.push('non_regression_red_team_critical_failures_above_max');
  }

  if (status === 'active' && !dryRun && policy.require_approval_receipt) {
    if (policy.require_approver_id && !approverId) reasons.push('approval_receipt_approver_id_missing');
    if (policy.require_approval_note && !approvalNote) reasons.push('approval_receipt_note_missing');
  }

  return {
    pass: reasons.length === 0,
    reasons,
    policy
  };
}

function summarizeBlockedByReason(rows) {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const reason of Array.isArray(row && row.reasons) ? row.reasons : []) {
      const key = String(reason || '').trim();
      if (!key) continue;
      out[key] = Number(out[key] || 0) + 1;
    }
  }
  return out;
}

function appendPromotionReceipt(dateStr, row) {
  const date = dateArgOrToday(dateStr);
  const filePath = path.join(PROMOTION_RECEIPTS_DIR, `${date}.jsonl`);
  appendJsonl(filePath, {
    ts: nowIso(),
    type: 'workflow_promotion_gate_receipt',
    date,
    ...row
  });
  return relPath(filePath);
}

function mergeDrafts(baseDrafts, extraDrafts) {
  const map = new Map();
  for (const row of Array.isArray(baseDrafts) ? baseDrafts : []) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id || '').trim();
    if (!id) continue;
    map.set(id, row);
  }
  for (const row of Array.isArray(extraDrafts) ? extraDrafts : []) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id || '').trim();
    if (!id) continue;
    const prev = map.get(id);
    if (!prev) {
      map.set(id, row);
      continue;
    }
    const prevScore = Number(prev.metrics && prev.metrics.score || 0);
    const nextScore = Number(row.metrics && row.metrics.score || 0);
    if (nextScore >= prevScore) map.set(id, { ...prev, ...row });
  }
  return Array.from(map.values());
}

function hasArg(args, key) {
  return Object.prototype.hasOwnProperty.call(args || {}, String(key || ''));
}

function activeStrategyExecutionMode() {
  try {
    const strategy = loadActiveStrategy({ allowMissing: true });
    const mode = String(strategyExecutionMode(strategy, 'execute') || '').trim().toLowerCase();
    const normalized = mode === 'score_only' || mode === 'canary_execute' || mode === 'execute'
      ? mode
      : 'execute';
    return {
      mode: normalized,
      full_automation: normalized === 'execute'
    };
  } catch {
    return {
      mode: 'execute',
      full_automation: true
    };
  }
}

function normalizeAutoApplyPolicy(raw, fallbackPrincipleScore = 0.6) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled === true,
    min_promotable_drafts: clampInt(src.min_promotable_drafts, 1, 64, 1),
    min_principle_score: clampNumber(src.min_principle_score, 0, 1, fallbackPrincipleScore),
    min_composite_score: clampNumber(src.min_composite_score, 0, 1, 0.5),
    min_avg_trit_alignment: clampNumber(src.min_avg_trit_alignment, -1, 1, -0.2),
    min_min_trit_alignment: clampNumber(src.min_min_trit_alignment, -1, 1, -0.7),
    max_predicted_drift_delta: clampNumber(src.max_predicted_drift_delta, -1, 1, 0),
    min_predicted_yield_delta: clampNumber(src.min_predicted_yield_delta, -1, 1, 0),
    max_red_team_critical_fail_cases: clampInt(src.max_red_team_critical_fail_cases, 0, 64, 0),
    require_shadow_off: src.require_shadow_off !== false
  };
}

function summarizeDraftMetrics(drafts) {
  const rows = Array.isArray(drafts) ? drafts : [];
  if (!rows.length) {
    return {
      count: 0,
      avg_composite_score: 0,
      avg_predicted_drift_delta: 0,
      avg_predicted_yield_delta: 0,
      avg_trit_alignment: 0,
      max_predicted_drift_delta: 0,
      min_predicted_yield_delta: 0,
      min_trit_alignment: 0
    };
  }
  const metrics = rows.map((row) => (row && row.metrics && typeof row.metrics === 'object') ? row.metrics : {});
  const asNum = (v, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const scores = metrics.map((m) => asNum(m.score, 0));
  const drifts = metrics.map((m) => asNum(m.predicted_drift_delta, 0));
  const yields = metrics.map((m) => asNum(m.predicted_yield_delta, 0));
  const trits = metrics.map((m) => asNum(m.trit_alignment, 0));
  const avg = (arr) => arr.reduce((sum, n) => sum + n, 0) / Math.max(1, arr.length);
  return {
    count: rows.length,
    avg_composite_score: Number(avg(scores).toFixed(4)),
    avg_predicted_drift_delta: Number(avg(drifts).toFixed(4)),
    avg_predicted_yield_delta: Number(avg(yields).toFixed(4)),
    avg_trit_alignment: Number(avg(trits).toFixed(4)),
    max_predicted_drift_delta: Number(Math.max(...drifts).toFixed(4)),
    min_predicted_yield_delta: Number(Math.min(...yields).toFixed(4)),
    min_trit_alignment: Number(Math.min(...trits).toFixed(4))
  };
}

function evaluateAutoApplyGate(context) {
  const src = context && typeof context === 'object' ? context : {};
  const policy = src.policy && typeof src.policy === 'object' ? src.policy : normalizeAutoApplyPolicy({}, 0.6);
  const shadowOnly = src.shadowOnly === true;
  const orchestronError = src.orchestronError ? String(src.orchestronError) : '';
  const principleScore = Number(src.principleScore || 0);
  const redCritical = Number(src.redTeamCriticalFailCases || 0);
  const metrics = summarizeDraftMetrics(src.promotableDrafts);
  const reasons = [];
  const policyNum = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  if (shadowOnly && policy.require_shadow_off) reasons.push('shadow_only_policy_on');
  if (orchestronError) reasons.push('orchestron_error');
  if (metrics.count < policyNum(policy.min_promotable_drafts, 1)) reasons.push('promotable_drafts_below_min');
  if (principleScore < policyNum(policy.min_principle_score, 0.6)) reasons.push('principle_score_below_min');
  if (redCritical > policyNum(policy.max_red_team_critical_fail_cases, 0)) reasons.push('red_team_critical_failures');
  if (metrics.avg_composite_score < policyNum(policy.min_composite_score, 0.5)) reasons.push('composite_score_below_min');
  if (metrics.avg_trit_alignment < policyNum(policy.min_avg_trit_alignment, -0.2)) reasons.push('avg_trit_alignment_below_min');
  if (metrics.min_trit_alignment < policyNum(policy.min_min_trit_alignment, -0.7)) reasons.push('min_trit_alignment_below_min');
  if (metrics.max_predicted_drift_delta > policyNum(policy.max_predicted_drift_delta, 0)) reasons.push('predicted_drift_above_max');
  if (metrics.avg_predicted_yield_delta < policyNum(policy.min_predicted_yield_delta, 0)) reasons.push('predicted_yield_below_min');

  return {
    pass: reasons.length === 0,
    reasons,
    metrics,
    checks: {
      principle_score: Number(principleScore.toFixed(4)),
      red_team_critical_fail_cases: redCritical,
      avg_trit_alignment: Number(metrics.avg_trit_alignment || 0),
      min_trit_alignment: Number(metrics.min_trit_alignment || 0)
    }
  };
}

function runCmd(dateStr, args) {
  const policyPath = path.resolve(String(args.policy || process.env.WORKFLOW_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const strategyMode = activeStrategyExecutionMode();
  const apply = boolFlag(args.apply, true);
  const baseline = generateDrafts(dateStr, {
    policy,
    days: args.days,
    maxDrafts: args.max
  });
  const orchestronEnabled = boolFlag(
    args.orchestron,
    boolFlag(process.env.WORKFLOW_ORCHESTRON_ENABLED, true)
  );
  const orchestronApplyRequested = boolFlag(
    args['orchestron-apply'],
    boolFlag(process.env.WORKFLOW_ORCHESTRON_APPLY, false)
  );
  const orchestronAutoArgPresent = hasArg(args, 'orchestron-auto');
  const orchestronAutoRequested = orchestronAutoArgPresent
    ? boolFlag(args['orchestron-auto'], false)
    : boolFlag(
        process.env.WORKFLOW_ORCHESTRON_AUTO_APPLY,
        false
      );
  const orchestronPolicyPath = path.resolve(String(
    args['orchestron-policy']
      || process.env.ORCHESTRON_POLICY_PATH
      || DEFAULT_ORCHESTRON_POLICY_PATH
  ));
  let orchestronPayload = null;
  let orchestronError = null;
  let orchestronApplyEffective = false;
  let orchestronDraftsForApply = [];
  let orchestronAutoEnabled = false;
  let orchestronAutoGate = {
    pass: false,
    reasons: [],
    metrics: {
      count: 0,
      avg_composite_score: 0,
      avg_predicted_drift_delta: 0,
      avg_predicted_yield_delta: 0,
      avg_trit_alignment: 0,
      max_predicted_drift_delta: 0,
      min_predicted_yield_delta: 0,
      min_trit_alignment: 0
    },
    checks: {
      principle_score: 0,
      red_team_critical_fail_cases: 0,
      avg_trit_alignment: 0,
      min_trit_alignment: 0
    }
  };

  if (orchestronEnabled) {
    try {
      const orchestronPolicy = loadOrchestronPolicy(orchestronPolicyPath);
      orchestronPayload = generateAdaptiveDrafts(dateStr, {
        policy: orchestronPolicy,
        policyPath: orchestronPolicyPath,
        days: args.days,
        maxCandidates: args.max,
        intent: args.intent,
        valueCurrency: args['value-currency'],
        objectiveId: args['objective-id']
      });
      orchestronDraftsForApply = orchestronPayload && Array.isArray(orchestronPayload.promotable_drafts)
        ? orchestronPayload.promotable_drafts
        : [];
      const shadowOnly = orchestronPayload && orchestronPayload.policy && orchestronPayload.policy.shadow_only === true;
      const autoPolicy = normalizeAutoApplyPolicy(
        orchestronPolicy && orchestronPolicy.auto_apply,
        Number(orchestronPolicy && orchestronPolicy.min_principle_score || 0.6)
      );
      orchestronAutoEnabled = orchestronAutoRequested || autoPolicy.enabled === true;
      if (orchestronAutoEnabled) {
        orchestronAutoGate = evaluateAutoApplyGate({
          policy: autoPolicy,
          shadowOnly,
          orchestronError: null,
          principleScore: orchestronPayload && orchestronPayload.principles
            ? Number(orchestronPayload.principles.score || 0)
            : 0,
          redTeamCriticalFailCases: orchestronPayload && orchestronPayload.red_team
            ? Number(orchestronPayload.red_team.critical_fail_cases || 0)
            : 0,
          promotableDrafts: orchestronDraftsForApply
        });
      }
      orchestronApplyEffective = (!shadowOnly && orchestronApplyRequested)
        || (orchestronAutoEnabled && orchestronAutoGate.pass === true);
    } catch (err) {
      orchestronError = String(err && err.message ? err.message : err || 'orchestron_failed');
      if (orchestronAutoEnabled) {
        orchestronAutoGate = evaluateAutoApplyGate({
          policy: normalizeAutoApplyPolicy({}, 0.6),
          shadowOnly: true,
          orchestronError,
          principleScore: 0,
          redTeamCriticalFailCases: 0,
          promotableDrafts: []
        });
      }
    }
  }
  const generatedDrafts = orchestronApplyEffective
    ? mergeDrafts(
        baseline && Array.isArray(baseline.drafts) ? baseline.drafts : [],
        orchestronDraftsForApply
      )
    : (baseline && Array.isArray(baseline.drafts) ? baseline.drafts : []);
  const registry = loadRegistry();
  let summary = {
    applied: 0,
    updated: 0,
    identity_checked: 0,
    identity_blocked: 0,
    identity_drift_score: 0,
    identity_max_drift_score: 0,
    identity_blocking_code_counts: {},
    identity_receipt_path: null,
    identity_error: null
  };
  let nextWorkflows = registry.workflows;

  if (apply) {
    const ignoreThresholdForApply = orchestronApplyEffective === true;
    const applied = applyDrafts(registry, generatedDrafts, policy, {
      date: dateStr,
      identity_source: 'workflow_controller_run',
      ignore_threshold: ignoreThresholdForApply
    });
    nextWorkflows = applied.workflows;
    summary = {
      applied: applied.applied,
      updated: applied.updated,
      identity_checked: Number(applied.identity_checked || 0),
      identity_blocked: Number(applied.identity_blocked || 0),
      identity_drift_score: Number(applied.identity_drift_score || 0),
      identity_max_drift_score: Number(applied.identity_max_drift_score || 0),
      identity_blocking_code_counts: applied.identity_blocking_code_counts || {},
      identity_receipt_path: applied.identity_receipt_path || null,
      identity_error: applied.identity_error || null
    };
  }

  const saved = saveRegistry({
    ...registry,
    generated_at: nowIso(),
    workflows: nextWorkflows
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'workflow_controller_run',
    date: dateStr,
    apply,
    strategy_execution_mode: strategyMode.mode,
    full_automation_mode: strategyMode.full_automation === true,
    drafts: generatedDrafts.length,
    baseline_drafts: baseline && Array.isArray(baseline.drafts) ? baseline.drafts.length : 0,
    orchestron_enabled: orchestronEnabled,
    orchestron_apply_requested: orchestronApplyRequested,
    orchestron_auto_requested: orchestronAutoRequested,
    orchestron_auto_enabled: orchestronAutoEnabled,
    orchestron_auto_pass: orchestronAutoGate.pass === true,
    orchestron_auto_reasons: orchestronAutoGate.reasons,
    orchestron_auto_metrics: orchestronAutoGate.metrics,
    orchestron_auto_checks: orchestronAutoGate.checks,
    orchestron_apply_effective: orchestronApplyEffective,
    orchestron_drafts: orchestronPayload && Array.isArray(orchestronPayload.drafts) ? orchestronPayload.drafts.length : 0,
    orchestron_promotable_drafts: Array.isArray(orchestronDraftsForApply) ? orchestronDraftsForApply.length : 0,
    orchestron_candidates: orchestronPayload && Array.isArray(orchestronPayload.candidates) ? orchestronPayload.candidates.length : 0,
    orchestron_passing: orchestronPayload && Array.isArray(orchestronPayload.passing) ? orchestronPayload.passing.length : 0,
    orchestron_value_currency: orchestronPayload && orchestronPayload.value_context
      ? orchestronPayload.value_context.value_currency || null
      : null,
    orchestron_policy_path: orchestronEnabled ? relPath(orchestronPolicyPath) : null,
    orchestron_shadow_only: orchestronPayload && orchestronPayload.policy ? orchestronPayload.policy.shadow_only === true : null,
    orchestron_error: orchestronError,
    applied: summary.applied,
    updated: summary.updated,
    identity_checked: summary.identity_checked,
    identity_blocked: summary.identity_blocked,
    identity_drift_score: summary.identity_drift_score,
    identity_max_drift_score: summary.identity_max_drift_score,
    identity_blocking_code_counts: summary.identity_blocking_code_counts,
    identity_receipt_path: summary.identity_receipt_path,
    identity_error: summary.identity_error,
    registry_total: Array.isArray(saved.workflows) ? saved.workflows.length : 0,
    policy_path: relPath(policyPath),
    registry_path: relPath(REGISTRY_PATH)
  })}\n`);
}

function listCmd(args) {
  const statusFilter = String(args.status || 'all').trim().toLowerCase();
  const limit = clampInt(args.limit, 1, 500, 50);
  const registry = loadRegistry();
  let rows = Array.isArray(registry.workflows) ? registry.workflows.slice() : [];
  if (statusFilter !== 'all') rows = rows.filter((row) => String(row.status || '').toLowerCase() === statusFilter);
  rows.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  rows = rows.slice(0, limit);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'workflow_controller_list',
    status: statusFilter,
    count: rows.length,
    workflows: rows
  })}\n`);
}

function promoteCmd(args) {
  const policyPath = path.resolve(String(args.policy || process.env.WORKFLOW_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const source = normalizePromotionSource(args.source);
  const status = String(args.status || 'active').trim().toLowerCase() === 'draft' ? 'draft' : 'active';
  const idFilter = parseIdFilter(args.id);
  const dryRun = boolFlag(args['dry-run'], false);
  const ignoreThreshold = boolFlag(args['ignore-threshold'], false);
  const approvalNote = cleanText(args['approval-note'] || '', 240);
  const approverId = cleanText(args['approver-id'] || '', 80);
  const snapshotPath = path.resolve(String(args.from || args['orchestron-latest'] || ORCHESTRON_LATEST_PATH));
  const snapshot = loadOrchestronSnapshot(snapshotPath);
  if (!snapshot.payload) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'workflow_controller_promote',
      error: 'orchestron_snapshot_missing',
      source,
      status,
      snapshot_path: relPath(snapshot.path)
    })}\n`);
    process.exitCode = 1;
    return;
  }

  const snapshotRedTeamCritical = snapshot.payload && snapshot.payload.red_team
    ? Number(snapshot.payload.red_team.critical_fail_cases || 0)
    : 0;
  const promotionGatePolicy = normalizePromotionGatePolicy(policy && policy.promotion_gate);
  const selected = selectPromotableRows(snapshot.payload, source, idFilter);
  const gateEvaluations = selected.rows.map((row) => ({
    draft: row,
    ...evaluatePromotionGate(row, {
      policy: promotionGatePolicy,
      status,
      dry_run: dryRun,
      approver_id: approverId,
      approval_note: approvalNote,
      snapshot_red_team_critical_fail_cases: snapshotRedTeamCritical
    })
  }));
  const gatedRows = gateEvaluations
    .filter((row) => row.pass === true)
    .map((row) => row.draft);
  const blockedRows = gateEvaluations
    .filter((row) => row.pass !== true)
    .map((row) => ({
      workflow_id: String(row && row.draft && row.draft.id || '').trim() || null,
      reasons: Array.isArray(row && row.reasons) ? row.reasons.slice(0, 24) : []
    }));
  const promotionGateBlockedByReason = summarizeBlockedByReason(blockedRows);
  const registry = loadRegistry();
  const promotionDate = dateArgOrToday(snapshot.payload && snapshot.payload.date);
  const applied = applyDrafts(registry, gatedRows, policy, {
    status,
    ignore_threshold: ignoreThreshold,
    date: promotionDate,
    identity_source: 'workflow_controller_promote',
    identity_write_receipt: dryRun !== true
  });
  const saved = dryRun
    ? {
        ...registry,
        workflows: applied.workflows,
        updated_at: registry.updated_at || null
      }
    : saveRegistry({
        ...registry,
        generated_at: nowIso(),
        workflows: applied.workflows
      });
  const promotionReceiptPath = appendPromotionReceipt(promotionDate, {
    source,
    status,
    dry_run: dryRun,
    ignore_threshold: ignoreThreshold,
    snapshot_path: relPath(snapshot.path),
    snapshot_red_team_critical_fail_cases: snapshotRedTeamCritical,
    approval: {
      approver_id: approverId || null,
      approval_note_present: approvalNote.length > 0
    },
    promotion_gate_policy: promotionGatePolicy,
    source_total: selected.source_total,
    selected: selected.selected,
    eligible: gatedRows.length,
    blocked: blockedRows.length,
    blocked_by_reason: promotionGateBlockedByReason,
    blocked_rows: blockedRows.slice(0, 128),
    applied: Number(applied.applied || 0),
    updated: Number(applied.updated || 0),
    identity_checked: Number(applied.identity_checked || 0),
    identity_blocked: Number(applied.identity_blocked || 0)
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'workflow_controller_promote',
    source,
    status,
    dry_run: dryRun,
    ignore_threshold: ignoreThreshold,
    approver_id: approverId || null,
    approval_note_present: approvalNote.length > 0,
    snapshot_path: relPath(snapshot.path),
    snapshot_shadow_only: snapshot.payload && snapshot.payload.policy
      ? snapshot.payload.policy.shadow_only === true
      : null,
    snapshot_red_team_critical_fail_cases: snapshotRedTeamCritical,
    source_total: selected.source_total,
    selected: selected.selected,
    promotion_gate_enabled: promotionGatePolicy.enabled === true,
    promotion_gate_eligible: gatedRows.length,
    promotion_gate_blocked: blockedRows.length,
    promotion_gate_blocked_by_reason: promotionGateBlockedByReason,
    promotion_receipt_path: promotionReceiptPath,
    applied: applied.applied,
    updated: applied.updated,
    identity_checked: Number(applied.identity_checked || 0),
    identity_blocked: Number(applied.identity_blocked || 0),
    identity_drift_score: Number(applied.identity_drift_score || 0),
    identity_max_drift_score: Number(applied.identity_max_drift_score || 0),
    identity_blocking_code_counts: applied.identity_blocking_code_counts || {},
    identity_receipt_path: applied.identity_receipt_path || null,
    identity_error: applied.identity_error || null,
    registry_total: Array.isArray(saved.workflows) ? saved.workflows.length : 0,
    policy_path: relPath(policyPath),
    registry_path: relPath(REGISTRY_PATH)
  })}\n`);
}

function statusCmd(args) {
  const registry = loadRegistry();
  const rows = Array.isArray(registry.workflows) ? registry.workflows : [];
  const counts = {
    active: rows.filter((row) => String(row.status || '') === 'active').length,
    draft: rows.filter((row) => String(row.status || '') === 'draft').length,
    disabled: rows.filter((row) => String(row.status || '') === 'disabled').length
  };
  const snapshotPath = path.resolve(String(args['orchestron-latest'] || ORCHESTRON_LATEST_PATH));
  const snapshot = loadOrchestronSnapshot(snapshotPath);
  const orchPayload = snapshot.payload || null;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'workflow_controller_status',
    total: rows.length,
    counts,
    registry_path: relPath(REGISTRY_PATH),
    updated_at: registry.updated_at || null,
    orchestron_latest_path: relPath(snapshot.path),
    orchestron_latest_exists: !!orchPayload,
    orchestron_shadow_only: orchPayload && orchPayload.policy ? orchPayload.policy.shadow_only === true : null,
    orchestron_promotable_drafts: orchPayload && Array.isArray(orchPayload.promotable_drafts) ? orchPayload.promotable_drafts.length : 0,
    orchestron_passing: orchPayload && Array.isArray(orchPayload.passing) ? orchPayload.passing.length : 0,
    orchestron_drafts: orchPayload && Array.isArray(orchPayload.drafts) ? orchPayload.drafts.length : 0,
    orchestron_red_team_critical_fail_cases: orchPayload && orchPayload.red_team ? Number(orchPayload.red_team.critical_fail_cases || 0) : 0
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
  if (cmd === 'promote') return promoteCmd(args);
  if (cmd === 'list') return listCmd(args);
  if (cmd === 'status') return statusCmd(args);
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'workflow_controller',
      error: String(err && err.message ? err.message : err || 'workflow_controller_failed')
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadRegistry,
  applyDrafts,
  mergeDrafts,
  loadOrchestronSnapshot,
  selectPromotableRows,
  main
};
