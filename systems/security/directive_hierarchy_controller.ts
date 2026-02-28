#!/usr/bin/env node
'use strict';

/**
 * directive_hierarchy_controller.js
 *
 * Constrained directive decomposition controller.
 * - Decomposes Tier 1 directives into bounded Tier 2 children when missing.
 * - Enforces lineage, branch caps, stale expiry, and campaign/directive conflict guards.
 * - Writes only through guarded channels.
 *
 * Usage:
 *   node systems/security/directive_hierarchy_controller.js status [--id=T1_x]
 *   node systems/security/directive_hierarchy_controller.js decompose --id=T1_x [--apply=1] [--dry-run=1]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { parseYaml } = require('../../lib/directive_resolver');
let dualityEvaluate = null;
let registerDualityObservation = null;
try {
  const duality = require('../../lib/duality_seed.js');
  dualityEvaluate = duality.duality_evaluate || duality.evaluateDualitySignal || null;
  registerDualityObservation = duality.registerDualityObservation || null;
} catch {
  dualityEvaluate = null;
  registerDualityObservation = null;
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIRECTIVES_DIR = path.join(REPO_ROOT, 'config', 'directives');
const ACTIVE_PATH = path.join(DIRECTIVES_DIR, 'ACTIVE.yaml');
const STRATEGIES_DIR = path.join(REPO_ROOT, 'config', 'strategies');
const AUDIT_PATH = path.join(REPO_ROOT, 'state', 'security', 'directive_hierarchy_audit.jsonl');

const DEFAULT_MAX_CHILDREN = clampInt(process.env.DIRECTIVE_DECOMPOSE_MAX_CHILDREN, 1, 12, 5);
const DEFAULT_TTL_DAYS = clampInt(process.env.DIRECTIVE_DECOMPOSE_TTL_DAYS, 7, 180, 30);
const DEFAULT_STALE_DAYS = clampInt(process.env.DIRECTIVE_DECOMPOSE_STALE_DAYS, 7, 180, 21);
const DEFAULT_CHILD_BUDGET_TOKENS = clampInt(process.env.DIRECTIVE_DECOMPOSE_CHILD_BUDGET_TOKENS, 200, 20000, 1500);
const DEFAULT_PARENT_MIN_TIER = clampInt(process.env.DIRECTIVE_DECOMPOSE_PARENT_MIN_TIER, 1, 8, 1);
const DEFAULT_PARENT_MAX_TIER = clampInt(process.env.DIRECTIVE_DECOMPOSE_PARENT_MAX_TIER, DEFAULT_PARENT_MIN_TIER, 9, 1);

function nowIso() {
  return new Date().toISOString();
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const x = Math.round(n);
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function normalizeText(v) {
  return String(v == null ? '' : v).trim();
}

function normalizeLower(v) {
  return normalizeText(v).toLowerCase();
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i] || '');
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq >= 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function boolArg(v, fallback = false) {
  if (v == null) return fallback;
  if (typeof v === 'boolean') return v;
  const s = normalizeLower(v);
  if (!s) return fallback;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function tierFromDirectiveId(id) {
  const m = normalizeText(id).match(/^T(\d+)_/);
  return m ? Number(m[1]) : 99;
}

function normalizeDirectiveId(v) {
  const id = normalizeText(v);
  if (!/^T[0-9]_[A-Za-z0-9_]+$/.test(id)) return '';
  return id;
}

function directiveFilePath(id) {
  return path.join(DIRECTIVES_DIR, `${id}.yaml`);
}

function loadDirectiveById(id) {
  const directiveId = normalizeDirectiveId(id);
  if (!directiveId) return null;
  const fp = directiveFilePath(directiveId);
  if (!fs.existsSync(fp)) return null;
  try {
    const text = fs.readFileSync(fp, 'utf8');
    const parsed = parseYaml(text) || {};
    const metadata = parsed && parsed.metadata && typeof parsed.metadata === 'object'
      ? parsed.metadata
      : {};
    return {
      id: directiveId,
      file: fp,
      tier: tierFromDirectiveId(directiveId),
      data: parsed,
      metadata
    };
  } catch {
    return null;
  }
}

function loadActiveState() {
  if (!fs.existsSync(ACTIVE_PATH)) {
    throw new Error(`active_file_missing:${path.relative(REPO_ROOT, ACTIVE_PATH)}`);
  }
  const text = fs.readFileSync(ACTIVE_PATH, 'utf8');
  const parsed = parseYaml(text) || {};
  const metadata = parsed.metadata && typeof parsed.metadata === 'object'
    ? parsed.metadata
    : {};
  const rows = Array.isArray(parsed.active_directives) ? parsed.active_directives : [];
  const normalized = rows
    .map((row) => {
      const idRaw = normalizeText(row && row.id || '').replace(/\.ya?ml$/i, '');
      const id = normalizeDirectiveId(idRaw);
      if (!id) return null;
      const tier = clampInt(row && row.tier, 0, 9, tierFromDirectiveId(id));
      const status = normalizeLower(row && row.status || 'active') || 'active';
      return {
        id,
        tier,
        status,
        reason: normalizeText(row && row.reason || ''),
        auto_generated: boolArg(row && row.auto_generated, false),
        parent_directive_id: normalizeDirectiveId(row && row.parent_directive_id || '')
      };
    })
    .filter(Boolean);
  return { metadata, rows: normalized };
}

function loadActiveDirectiveRecords() {
  const state = loadActiveState();
  const records = [];
  for (const row of state.rows) {
    const info = loadDirectiveById(row.id);
    records.push({
      ...row,
      exists: !!info,
      data: info ? info.data : null,
      metadata: info && info.metadata ? info.metadata : {}
    });
  }
  return { state, records };
}

function activeChildrenForParent(records, parentId) {
  const pid = normalizeDirectiveId(parentId);
  if (!pid) return [];
  return (Array.isArray(records) ? records : []).filter((row) => {
    if (!row || row.status !== 'active') return false;
    if (!Number.isFinite(Number(row.tier)) || Number(row.tier) <= tierFromDirectiveId(pid)) return false;
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    const parentFromMeta = normalizeDirectiveId(meta.parent_directive_id || row.parent_directive_id || '');
    return parentFromMeta === pid;
  });
}

function decompositionKindFromRecord(row) {
  const meta = row && row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const explicit = normalizeLower(meta.decomposition_kind || '');
  if (explicit === 'plan' || explicit === 'execute') return explicit;
  const id = normalizeLower(row && row.id || '');
  if (id.includes('_plan_')) return 'plan';
  if (id.includes('_execute_') || id.includes('_execution_')) return 'execute';
  return '';
}

function isExpiredRecord(row, nowMs) {
  const meta = row && row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const expiresAt = normalizeText(meta.expires_at || '');
  if (!expiresAt) return false;
  const ts = Date.parse(expiresAt);
  if (!Number.isFinite(ts)) return false;
  return ts <= nowMs;
}

function readStrategies() {
  const out = [];
  if (!fs.existsSync(STRATEGIES_DIR)) return out;
  const files = fs.readdirSync(STRATEGIES_DIR).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const fp = path.join(STRATEGIES_DIR, f);
    const json = readJsonSafe(fp, null);
    if (!json || typeof json !== 'object') continue;
    out.push({ id: normalizeText(json.id || f.replace(/\.json$/i, '')), data: json });
  }
  return out;
}

function campaignConflict(parentId) {
  const strategies = readStrategies();
  const pid = normalizeDirectiveId(parentId);
  const conflicts = [];
  for (const row of strategies) {
    const data = row.data || {};
    if (normalizeLower(data.status || 'active') !== 'active') continue;
    const blocked = data.admission_policy && Array.isArray(data.admission_policy.blocked_types)
      ? data.admission_policy.blocked_types.map((v) => normalizeLower(v))
      : [];
    if (blocked.includes('directive_decomposition')) {
      conflicts.push({
        strategy_id: row.id,
        reason: 'strategy_blocks_directive_decomposition'
      });
    }
    const campaigns = Array.isArray(data.campaigns) ? data.campaigns : [];
    for (const c of campaigns) {
      const status = normalizeLower(c && c.status || 'active');
      if (status !== 'active') continue;
      const objectiveId = normalizeDirectiveId(c && c.objective_id || '');
      if (objectiveId && objectiveId === pid) {
        conflicts.push({
          strategy_id: row.id,
          campaign_id: normalizeText(c && c.id || ''),
          reason: 'campaign_already_bound_to_parent'
        });
      }
    }
  }
  return conflicts;
}

function toYamlQuoted(v) {
  const s = String(v == null ? '' : v).replace(/"/g, '\\"');
  return `"${s}"`;
}

function yamlList(arr, indent) {
  const pad = ' '.repeat(indent);
  const items = Array.isArray(arr) ? arr.filter(Boolean) : [];
  if (!items.length) return `${pad}- "TBD"`;
  return items.map((x) => `${pad}- ${toYamlQuoted(x)}`).join('\n');
}

function renderRiskLimitsYaml(riskLimits, indent) {
  const pad = ' '.repeat(indent);
  const src = riskLimits && typeof riskLimits === 'object' ? riskLimits : {};
  const keys = Object.keys(src).filter(Boolean).sort((a, b) => a.localeCompare(b));
  if (!keys.length) {
    return `${pad}max_drawdown_pct: 8\n${pad}max_single_bet_pct: 1\n${pad}max_monthly_burn: 12000`;
  }
  return keys.map((k) => {
    const v = src[k];
    if (typeof v === 'number' && Number.isFinite(v)) return `${pad}${k}: ${v}`;
    const n = Number(v);
    if (Number.isFinite(n)) return `${pad}${k}: ${n}`;
    return `${pad}${k}: ${toYamlQuoted(v)}`;
  }).join('\n');
}

function safeList(input, fallback) {
  const arr = Array.isArray(input) ? input.map((v) => normalizeText(v)).filter(Boolean) : [];
  if (arr.length) return arr;
  return Array.isArray(fallback) ? fallback.slice() : [];
}

function tightenRiskLimits(parentData, kind) {
  const src = parentData
    && parentData.constraints
    && parentData.constraints.risk_limits
    && typeof parentData.constraints.risk_limits === 'object'
    ? parentData.constraints.risk_limits
    : {};
  const multiplier = kind === 'plan' ? 0.55 : 0.45;
  const drawdown = clampInt(Number(src.max_drawdown_pct) * multiplier, 1, 25, kind === 'plan' ? 8 : 6);
  const singleBet = clampInt(Number(src.max_single_bet_pct) * multiplier, 1, 10, 1);
  const monthlyBurn = clampInt(Number(src.max_monthly_burn) * 0.4, 1000, 1000000, 12000);
  const out = {
    max_drawdown_pct: drawdown,
    max_single_bet_pct: singleBet,
    max_monthly_burn: monthlyBurn
  };
  if (Number.isFinite(Number(src.emergency_reserve_months))) {
    out.emergency_reserve_months = clampInt(src.emergency_reserve_months, 3, 24, 6);
  }
  return out;
}

function plusDaysIso(days) {
  const d = new Date(Date.now() + (Math.max(1, Number(days || 1)) * 24 * 60 * 60 * 1000));
  return d.toISOString();
}

function baseFromParentId(parentId) {
  return normalizeDirectiveId(parentId)
    .replace(/^T[0-9]_/, '')
    .replace(/_v[0-9]+$/i, '')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function makeChildId(parentId, tier, kind, existingIds) {
  const base = baseFromParentId(parentId) || 'objective';
  const suffix = kind === 'plan' ? 'plan' : 'execute';
  const targetTier = clampInt(tier, 1, 9, 2);
  let candidate = `T${targetTier}_${base}_${suffix}_v1`;
  if (candidate.length > 72) {
    const keep = Math.max(12, 72 - (`T${targetTier}__${suffix}_v1`.length));
    candidate = `T${targetTier}_${base.slice(0, keep)}_${suffix}_v1`;
  }
  const seen = new Set((Array.isArray(existingIds) ? existingIds : []).map((v) => normalizeDirectiveId(v)).filter(Boolean));
  if (!seen.has(candidate) && !fs.existsSync(directiveFilePath(candidate))) return candidate;
  const hash = crypto.createHash('sha256').update(`${parentId}|${suffix}`).digest('hex').slice(0, 6);
  const alt = `T${targetTier}_${base}_${suffix}_${hash}_v1`;
  if (alt.length <= 72) return alt;
  return `T${targetTier}_${base.slice(0, 40)}_${suffix}_${hash}_v1`;
}

function buildChildYaml(opts) {
  const kind = normalizeLower(opts.kind) === 'plan' ? 'plan' : 'execute';
  const parentId = normalizeDirectiveId(opts.parent_id);
  const id = normalizeDirectiveId(opts.id);
  const tier = clampInt(opts.tier, 1, 9, 2);
  const now = normalizeText(opts.generated_at || nowIso());
  const expiresAt = normalizeText(opts.expires_at || plusDaysIso(opts.ttl_days || DEFAULT_TTL_DAYS));
  const timeframe = normalizeText(opts.timeframe || 'within 30 days');
  const primary = normalizeText(opts.primary || 'Advance parent directive through bounded execution.');
  const description = kind === 'plan'
    ? `Bounded planning directive derived from ${parentId}`
    : `Bounded execution directive derived from ${parentId}`;
  const riskLimits = opts.risk_limits && typeof opts.risk_limits === 'object' ? opts.risk_limits : {};
  const leading = safeList(opts.leading, [
    'child_directive_shipped_count',
    'bounded_execution_attempts'
  ]);
  const lagging = safeList(opts.lagging, [
    'objective_progress_delta',
    'verified_t1_advance'
  ]);
  const included = safeList(opts.scope_included, [
    'Small reversible experiments',
    'Measured proposal execution'
  ]);
  const excluded = safeList(opts.scope_excluded, [
    'Irreversible external commitments',
    'Unbounded infra churn'
  ]);
  const maxChildren = clampInt(opts.max_children, 1, 12, DEFAULT_MAX_CHILDREN);
  const staleDays = clampInt(opts.stale_days, 7, 180, DEFAULT_STALE_DAYS);
  const budgetCapTokens = clampInt(opts.budget_cap_tokens, 200, 20000, DEFAULT_CHILD_BUDGET_TOKENS);
  const lineageId = crypto.createHash('sha256').update(`${parentId}|${id}|${kind}`).digest('hex').slice(0, 16);
  const target = kind === 'plan'
    ? 'Generate <=2 executable proposals with explicit rollback within 7 days.'
    : 'Ship >=1 verified low-risk outcome linked to parent objective within 14 days.';
  return [
    `# Auto-generated child directive for ${parentId}`,
    '# Generated by directive_hierarchy_controller.js',
    '',
    'metadata:',
    `  id: ${id}`,
    `  tier: ${tier}`,
    '  version: "1.0.0"',
    `  description: ${toYamlQuoted(description)}`,
    `  parent_directive_id: ${parentId}`,
    `  root_objective_id: ${parentId}`,
    `  decomposition_kind: ${toYamlQuoted(kind)}`,
    '  auto_generated: true',
    `  lineage_id: ${lineageId}`,
    '  generated_by: "directive_hierarchy_controller"',
    `  generated_at: ${toYamlQuoted(now)}`,
    `  expires_at: ${toYamlQuoted(expiresAt)}`,
    '',
    'intent:',
    `  primary: ${toYamlQuoted(primary)}`,
    '  definitions:',
    `    timeframe: ${toYamlQuoted(timeframe)}`,
    `    target: ${toYamlQuoted(target)}`,
    '',
    'constraints:',
    '  inherited_from_parent: true',
    '  risk_limits:',
    renderRiskLimitsYaml(riskLimits, 4),
    '  operational:',
    '    require_manual_approval: true',
    '    allow_auto_execute_low_risk_reversible: false',
    '    reversible_only: true',
    '',
    'success_metrics:',
    '  leading:',
    yamlList(leading, 4),
    '  lagging:',
    yamlList(lagging, 4),
    '',
    'scope:',
    '  included:',
    yamlList(included, 4),
    '  excluded:',
    yamlList(excluded, 4),
    '',
    'approval_policy:',
    '  inherits: T0_invariants',
    '  additional_gates:',
    yamlList([
      `parent_alignment:${parentId}`,
      'explicit_rollback_provided',
      'risk_low_and_reversible'
    ], 4),
    '',
    'execution_contract:',
    `  phase: ${toYamlQuoted(kind)}`,
    `  objective_id: ${parentId}`,
    '  require_manual_approval: true',
    '  allow_auto_execute_low_risk_reversible: false',
    '  reversible_required: true',
    `  budget_cap_tokens: ${budgetCapTokens}`,
    `  max_children_per_parent: ${maxChildren}`,
    `  stale_after_days: ${staleDays}`,
    '',
    'lifecycle:',
    `  auto_expire_after_days: ${staleDays}`,
    '  parent_disable_revokes: true',
    ''
  ].join('\n');
}

function renderActiveYaml(metadata, rows) {
  const nowDate = new Date().toISOString().slice(0, 10);
  const updatedBy = normalizeText(metadata && metadata.updated_by || 'directive_hierarchy_controller');
  const out = [];
  out.push('# Active Directives');
  out.push('# This file controls which directives are currently enforced.');
  out.push('');
  out.push('metadata:');
  out.push(`  last_updated: "${nowDate}"`);
  out.push(`  updated_by: "${updatedBy}"`);
  out.push('');
  out.push('active_directives:');
  const entries = Array.isArray(rows) ? rows : [];
  for (const row of entries) {
    const id = normalizeDirectiveId(row && row.id || '');
    if (!id) continue;
    const tier = clampInt(row && row.tier, 0, 9, tierFromDirectiveId(id));
    const status = normalizeLower(row && row.status || 'active') || 'active';
    const reason = normalizeText(row && row.reason || '');
    const autoGenerated = boolArg(row && row.auto_generated, false);
    const parentId = normalizeDirectiveId(row && row.parent_directive_id || '');
    out.push(`  - id: ${id}`);
    out.push(`    tier: ${tier}`);
    out.push(`    status: ${status}`);
    out.push(`    reason: ${toYamlQuoted(reason || 'managed')}`);
    if (autoGenerated) out.push('    auto_generated: true');
    if (parentId) out.push(`    parent_directive_id: ${parentId}`);
    out.push('');
  }
  out.push('# Directive precedence (lower tier = higher precedence for constraints)');
  out.push('# Tier 0: Hard invariants');
  out.push('# Tier 1+: Strategic/operational directives');
  out.push('');
  return out.join('\n');
}

function checkGuardOrThrow(filesRel) {
  const fileList = Array.from(new Set((Array.isArray(filesRel) ? filesRel : []).map((p) => normalizeText(p)).filter(Boolean)));
  if (!fileList.length) return;
  const guardPath = path.join(REPO_ROOT, 'systems', 'security', 'guard.js');
  const r = spawnSync(process.execPath, [guardPath, `--files=${fileList.join(',')}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: process.env
  });
  if (r.status === 0) return;
  const stderr = normalizeText(r.stderr || '');
  const stdout = normalizeText(r.stdout || '');
  throw new Error(stderr || stdout || `guard_blocked_exit_${Number(r.status || 1)}`);
}

function cmdStatus(args) {
  const requestedId = normalizeDirectiveId(args.id || '');
  const { records } = loadActiveDirectiveRecords();
  const activeParents = records.filter((r) => {
    if (!r || r.status !== 'active') return false;
    const tier = Number(r.tier);
    return Number.isFinite(tier) && tier >= DEFAULT_PARENT_MIN_TIER && tier <= DEFAULT_PARENT_MAX_TIER;
  });
  const rows = [];
  for (const parent of activeParents) {
    const pid = parent.id;
    if (requestedId && requestedId !== pid) continue;
    const children = activeChildrenForParent(records, pid);
    rows.push({
      parent_id: pid,
      parent_tier: Number(parent.tier),
      child_count: children.length,
      child_ids: children.map((c) => c.id),
      child_kinds: children.map((c) => decompositionKindFromRecord(c)).filter(Boolean)
    });
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'directive_hierarchy_status',
    ts: nowIso(),
    rows
  }) + '\n');
}

function cmdDecompose(args) {
  const parentId = normalizeDirectiveId(args.id || '');
  if (!parentId) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'invalid_or_missing_id' }) + '\n');
    process.exit(2);
  }
  const apply = boolArg(args.apply, false);
  const dryRun = boolArg(args['dry-run'], false);
  const maxChildren = clampInt(args['max-children'], 1, 12, DEFAULT_MAX_CHILDREN);
  const ttlDays = clampInt(args['ttl-days'], 7, 180, DEFAULT_TTL_DAYS);
  const staleDays = clampInt(args['stale-days'], 7, 180, DEFAULT_STALE_DAYS);
  const budgetCapTokens = clampInt(args['budget-cap-tokens'], 200, 20000, DEFAULT_CHILD_BUDGET_TOKENS);

  const { state, records } = loadActiveDirectiveRecords();
  const parent = records.find((r) => r && r.id === parentId && r.status === 'active');
  if (!parent) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'parent_not_active', parent_id: parentId }) + '\n');
    process.exit(2);
  }
  const parentTier = Number(parent.tier);
  if (!Number.isFinite(parentTier) || parentTier < DEFAULT_PARENT_MIN_TIER || parentTier > DEFAULT_PARENT_MAX_TIER) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'parent_tier_not_supported',
      parent_id: parentId,
      tier: parent.tier,
      parent_min_tier: DEFAULT_PARENT_MIN_TIER,
      parent_max_tier: DEFAULT_PARENT_MAX_TIER
    }) + '\n');
    process.exit(2);
  }
  const dualityRunId = `dly_${crypto.createHash('sha256')
    .update(`${parentId}|${Date.now()}|${Math.random()}`)
    .digest('hex')
    .slice(0, 16)}`;
  const duality = typeof dualityEvaluate === 'function'
    ? dualityEvaluate({
      lane: 'task_decomposition',
      source: 'directive_hierarchy_controller',
      run_id: dualityRunId,
      parent_id: parentId,
      parent_tier: parentTier,
      directive: parent && parent.data ? parent.data : {}
    }, {
      lane: 'task_decomposition',
      source: 'directive_hierarchy_controller',
      run_id: dualityRunId,
      persist: true
    })
    : null;

  const nowMs = Date.now();
  const conflicts = campaignConflict(parentId);
  const children = activeChildrenForParent(records, parentId);
  const staleChildren = children.filter((row) => isExpiredRecord(row, nowMs));
  const activeNonStale = children.filter((row) => !isExpiredRecord(row, nowMs));
  const childKinds = new Set(activeNonStale.map((row) => decompositionKindFromRecord(row)).filter(Boolean));

  if (conflicts.length > 0) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'campaign_conflict',
      parent_id: parentId,
      conflicts,
      duality: duality || { enabled: false }
    }) + '\n');
    process.exit(1);
  }

  const targetTier = Math.min(9, Number(parent.tier) + 1);
  const existingIds = records.map((r) => r.id);
  const parentData = parent.data || {};
  const intentPrimary = normalizeText(parentData && parentData.intent && parentData.intent.primary || '');
  const timeframe = normalizeText(
    parentData
    && parentData.intent
    && parentData.intent.definitions
    && (
      parentData.intent.definitions.timeframe
      || parentData.intent.definitions.target_date
      || parentData.intent.definitions.timeframe_years
    )
  ) || 'within 30 days';
  const baseLeading = safeList(
    parentData && parentData.success_metrics && parentData.success_metrics.leading,
    ['verified_progress_rate']
  );
  const baseLagging = safeList(
    parentData && parentData.success_metrics && parentData.success_metrics.lagging,
    ['objective_progress_delta']
  );
  const baseScopeIn = safeList(
    parentData && parentData.scope && parentData.scope.included,
    ['Low-risk reversible actions']
  ).slice(0, 4);
  const baseScopeOut = safeList(
    parentData && parentData.scope && parentData.scope.excluded,
    ['Irreversible external changes']
  ).slice(0, 4);

  const baseKindOrder = ['plan', 'execute'];
  const preferredKindOrder = duality
    && duality.enabled === true
    && String(duality.recommended_adjustment || '') === 'increase_yang_flux'
    ? ['execute', 'plan']
    : baseKindOrder;
  const requestedKinds = preferredKindOrder.filter((k) => !childKinds.has(k));
  const availableSlots = Math.max(0, maxChildren - activeNonStale.length);
  const kinds = requestedKinds.slice(0, availableSlots);

  if (kinds.length === 0 && staleChildren.length === 0) {
    if (duality && duality.enabled === true && typeof registerDualityObservation === 'function') {
      try {
        registerDualityObservation({
          lane: 'task_decomposition',
          source: 'directive_hierarchy_controller',
          run_id: dualityRunId,
          predicted_trit: Number(duality.score_trit || 0),
          observed_trit: 0
        });
      } catch {}
    }
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'no_change',
      reason: activeNonStale.length >= maxChildren ? 'branch_cap_reached' : 'children_already_present',
      parent_id: parentId,
      max_children: maxChildren,
      active_children: activeNonStale.map((r) => r.id),
      duality: duality || { enabled: false }
    }) + '\n');
    return;
  }

  const generatedAt = nowIso();
  const expiresAt = plusDaysIso(ttlDays);
  const generated = kinds.map((kind) => {
    const id = makeChildId(parentId, targetTier, kind, existingIds);
    const riskLimits = tightenRiskLimits(parentData, kind);
    const primary = kind === 'plan'
      ? `Create bounded executable plan for: ${intentPrimary || parentId}`
      : `Execute bounded low-risk path for: ${intentPrimary || parentId}`;
    const yaml = buildChildYaml({
      id,
      tier: targetTier,
      kind,
      parent_id: parentId,
      generated_at: generatedAt,
      expires_at: expiresAt,
      ttl_days: ttlDays,
      stale_days: staleDays,
      max_children: maxChildren,
      budget_cap_tokens: budgetCapTokens,
      timeframe,
      primary,
      leading: baseLeading,
      lagging: baseLagging,
      scope_included: baseScopeIn,
      scope_excluded: baseScopeOut,
      risk_limits: riskLimits
    });
    return { id, kind, tier: targetTier, yaml };
  });

  const activeRows = Array.isArray(state.rows) ? state.rows.slice() : [];
  const staleSet = new Set(staleChildren.map((c) => c.id));
  const nextRows = activeRows.map((row) => {
    if (!staleSet.has(row.id)) return { ...row };
    return {
      ...row,
      status: 'inactive',
      reason: `auto_expired_stale:${new Date(nowMs).toISOString().slice(0, 10)}`
    };
  });

  for (const child of generated) {
    const idx = nextRows.findIndex((r) => r && r.id === child.id);
    if (idx >= 0) {
      nextRows[idx] = {
        ...nextRows[idx],
        tier: child.tier,
        status: 'active',
        reason: `auto_decomposed_from:${parentId}`,
        auto_generated: true,
        parent_directive_id: parentId
      };
    } else {
      nextRows.push({
        id: child.id,
        tier: child.tier,
        status: 'active',
        reason: `auto_decomposed_from:${parentId}`,
        auto_generated: true,
        parent_directive_id: parentId
      });
    }
  }

  const changedFilesRel = [];
  for (const child of generated) {
    changedFilesRel.push(path.relative(REPO_ROOT, directiveFilePath(child.id)).replace(/\\/g, '/'));
  }
  if (generated.length > 0 || staleChildren.length > 0) {
    changedFilesRel.push(path.relative(REPO_ROOT, ACTIVE_PATH).replace(/\\/g, '/'));
  }

  if (apply && !dryRun && changedFilesRel.length > 0) {
    checkGuardOrThrow(changedFilesRel);
    for (const child of generated) {
      const fp = directiveFilePath(child.id);
      ensureDir(path.dirname(fp));
      fs.writeFileSync(fp, child.yaml, 'utf8');
    }
    fs.writeFileSync(ACTIVE_PATH, renderActiveYaml(state.metadata, nextRows), 'utf8');
  }

  const payload = {
    ok: true,
    result: generated.length > 0 ? 'decomposed' : 'no_change',
    parent_id: parentId,
    parent_tier: Number(parent.tier),
    apply,
    dry_run: dryRun,
    max_children: maxChildren,
    stale_days: staleDays,
    ttl_days: ttlDays,
    budget_cap_tokens: budgetCapTokens,
    created_count: generated.length,
    created_ids: generated.map((g) => g.id),
    created_kinds: generated.map((g) => g.kind),
    expired_count: staleChildren.length,
    expired_ids: staleChildren.map((c) => c.id),
    conflicts,
    duality: duality
      ? {
        enabled: duality.enabled === true,
        score_trit: Number(duality.score_trit || 0),
        score_label: normalizeLower(duality.score_label || 'unknown') || 'unknown',
        zero_point_harmony_potential: Number(duality.zero_point_harmony_potential || 0),
        recommended_adjustment: normalizeText(duality.recommended_adjustment || ''),
        confidence: Number(duality.confidence || 0),
        indicator: duality.indicator && typeof duality.indicator === 'object'
          ? duality.indicator
          : null
      }
      : {
        enabled: false
      }
  };

  appendJsonl(AUDIT_PATH, {
    ts: nowIso(),
    type: 'directive_hierarchy_decompose',
    parent_id: parentId,
    parent_tier: Number(parent.tier),
    apply,
    dry_run: dryRun,
    created_ids: generated.map((g) => g.id),
    created_kinds: generated.map((g) => g.kind),
    expired_ids: staleChildren.map((c) => c.id),
    max_children: maxChildren,
    ttl_days: ttlDays,
    stale_days: staleDays,
    conflicts,
    duality: payload.duality
  });
  if (duality && duality.enabled === true && typeof registerDualityObservation === 'function') {
    try {
      registerDualityObservation({
        lane: 'task_decomposition',
        source: 'directive_hierarchy_controller',
        run_id: dualityRunId,
        predicted_trit: Number(duality.score_trit || 0),
        observed_trit: generated.length > 0 ? 1 : 0
      });
    } catch {}
  }

  process.stdout.write(JSON.stringify(payload) + '\n');
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/directive_hierarchy_controller.js status [--id=T1_x]');
  console.log('  node systems/security/directive_hierarchy_controller.js decompose --id=T1_x [--apply=1] [--dry-run=1]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeLower(args._[0] || '');
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'status') return cmdStatus(args);
  if (cmd === 'decompose') return cmdDecompose(args);
  process.stdout.write(JSON.stringify({ ok: false, error: `unknown_command:${cmd}` }) + '\n');
  process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: String(err && err.message || err || 'directive_hierarchy_controller_failed')
    }) + '\n');
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  normalizeDirectiveId,
  loadActiveState,
  loadActiveDirectiveRecords,
  activeChildrenForParent,
  decompositionKindFromRecord,
  buildChildYaml
};
