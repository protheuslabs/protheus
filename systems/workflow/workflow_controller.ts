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
  generateAdaptiveDrafts,
  loadPolicy: loadOrchestronPolicy
} = require('./orchestron/adaptive_controller');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = process.env.WORKFLOW_REGISTRY_PATH
  ? path.resolve(process.env.WORKFLOW_REGISTRY_PATH)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'registry.json');
const DEFAULT_POLICY_PATH = path.join(REPO_ROOT, 'config', 'workflow_policy.json');
const DEFAULT_ORCHESTRON_POLICY_PATH = path.join(REPO_ROOT, 'config', 'orchestron_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/workflow/workflow_controller.js run [YYYY-MM-DD] [--days=N] [--max=N] [--apply=1|0] [--policy=path] [--orchestron=1|0] [--orchestron-apply=1|0] [--intent=\"...\"] [--orchestron-policy=path]');
  console.log('  node systems/workflow/workflow_controller.js list [--status=active|draft|all] [--limit=N]');
  console.log('  node systems/workflow/workflow_controller.js status [--policy=path]');
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

function applyDrafts(registry, drafts, policy) {
  const rows = Array.isArray(registry && registry.workflows) ? registry.workflows.slice() : [];
  const map = new Map(rows.map((row) => [String(row.id || ''), row]));
  const threshold = Number(policy && policy.apply_threshold || 0.62);
  let applied = 0;
  let updated = 0;

  for (const draft of Array.isArray(drafts) ? drafts : []) {
    const score = Number(draft && draft.metrics && draft.metrics.score || 0);
    if (score < threshold) continue;
    const id = String(draft && draft.id || '').trim();
    if (!id) continue;
    const existing = map.get(id);
    const row = {
      ...(existing || {}),
      ...draft,
      status: 'active',
      source: existing ? 'adaptive_workflow_controller_update' : 'adaptive_workflow_controller',
      activated_at: existing && existing.activated_at ? existing.activated_at : nowIso(),
      updated_at: nowIso()
    };
    map.set(id, row);
    if (existing) updated += 1;
    else applied += 1;
  }

  const maxRows = Number(policy && policy.max_registry_workflows || 128);
  const workflows = Array.from(map.values())
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .slice(0, Math.max(8, maxRows));
  return {
    workflows,
    applied,
    updated
  };
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

function runCmd(dateStr, args) {
  const policyPath = path.resolve(String(args.policy || process.env.WORKFLOW_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
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
  const orchestronPolicyPath = path.resolve(String(
    args['orchestron-policy']
      || process.env.ORCHESTRON_POLICY_PATH
      || DEFAULT_ORCHESTRON_POLICY_PATH
  ));
  let orchestronPayload = null;
  let orchestronError = null;
  let orchestronApplyEffective = false;
  let orchestronDraftsForApply = [];

  if (orchestronEnabled) {
    try {
      const orchestronPolicy = loadOrchestronPolicy(orchestronPolicyPath);
      orchestronPayload = generateAdaptiveDrafts(dateStr, {
        policy: orchestronPolicy,
        policyPath: orchestronPolicyPath,
        days: args.days,
        maxCandidates: args.max,
        intent: args.intent
      });
      orchestronDraftsForApply = orchestronPayload && Array.isArray(orchestronPayload.promotable_drafts)
        ? orchestronPayload.promotable_drafts
        : (orchestronPayload && Array.isArray(orchestronPayload.drafts) ? orchestronPayload.drafts : []);
      const shadowOnly = orchestronPayload && orchestronPayload.policy && orchestronPayload.policy.shadow_only === true;
      orchestronApplyEffective = orchestronApplyRequested && !shadowOnly;
    } catch (err) {
      orchestronError = String(err && err.message ? err.message : err || 'orchestron_failed');
    }
  }
  const generatedDrafts = orchestronApplyEffective
    ? mergeDrafts(
        baseline && Array.isArray(baseline.drafts) ? baseline.drafts : [],
        orchestronDraftsForApply
      )
    : (baseline && Array.isArray(baseline.drafts) ? baseline.drafts : []);
  const registry = loadRegistry();
  let summary = { applied: 0, updated: 0 };
  let nextWorkflows = registry.workflows;

  if (apply) {
    const applied = applyDrafts(registry, generatedDrafts, policy);
    nextWorkflows = applied.workflows;
    summary = { applied: applied.applied, updated: applied.updated };
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
    drafts: generatedDrafts.length,
    baseline_drafts: baseline && Array.isArray(baseline.drafts) ? baseline.drafts.length : 0,
    orchestron_enabled: orchestronEnabled,
    orchestron_apply_requested: orchestronApplyRequested,
    orchestron_apply_effective: orchestronApplyEffective,
    orchestron_drafts: orchestronPayload && Array.isArray(orchestronPayload.drafts) ? orchestronPayload.drafts.length : 0,
    orchestron_promotable_drafts: Array.isArray(orchestronDraftsForApply) ? orchestronDraftsForApply.length : 0,
    orchestron_candidates: orchestronPayload && Array.isArray(orchestronPayload.candidates) ? orchestronPayload.candidates.length : 0,
    orchestron_passing: orchestronPayload && Array.isArray(orchestronPayload.passing) ? orchestronPayload.passing.length : 0,
    orchestron_policy_path: orchestronEnabled ? relPath(orchestronPolicyPath) : null,
    orchestron_shadow_only: orchestronPayload && orchestronPayload.policy ? orchestronPayload.policy.shadow_only === true : null,
    orchestron_error: orchestronError,
    applied: summary.applied,
    updated: summary.updated,
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

function statusCmd() {
  const registry = loadRegistry();
  const rows = Array.isArray(registry.workflows) ? registry.workflows : [];
  const counts = {
    active: rows.filter((row) => String(row.status || '') === 'active').length,
    draft: rows.filter((row) => String(row.status || '') === 'draft').length,
    disabled: rows.filter((row) => String(row.status || '') === 'disabled').length
  };
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'workflow_controller_status',
    total: rows.length,
    counts,
    registry_path: relPath(REGISTRY_PATH),
    updated_at: registry.updated_at || null
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
  if (cmd === 'list') return listCmd(args);
  if (cmd === 'status') return statusCmd();
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
  mergeDrafts
};
