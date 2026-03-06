#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/ops/global_molt_cycle.js
 *
 * V3-010 global molt cycle orchestrator.
 * - Proposes 30-day compaction/pruning plans.
 * - Enforces veto window and human gate before apply.
 * - Applies only reversible actions with explicit rollback receipts.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.GLOBAL_MOLT_POLICY_PATH
  ? path.resolve(process.env.GLOBAL_MOLT_POLICY_PATH)
  : path.join(ROOT, 'config', 'global_molt_cycle_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 280) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    const raw = String(token || '');
    if (!raw.startsWith('--')) {
      out._.push(raw);
      continue;
    }
    const idx = raw.indexOf('=');
    if (idx < 0) out[raw.slice(2)] = true;
    else out[raw.slice(2, idx)] = raw.slice(idx + 1);
  }
  return out;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
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

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function parseIsoMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function sha10(seed: string) {
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 10);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    cycle_days: 30,
    veto_window_hours: 24,
    require_human_approval_for_apply: true,
    require_veto_window_elapsed: true,
    max_actions_per_plan: 25,
    sources: {
      organ_atrophy_latest_path: 'state/autonomy/organs/atrophy/latest.json',
      weaver_pathway_state_path: 'state/autonomy/weaver/pathway_state.json',
      assimilation_ledger_path: 'state/assimilation/ledger.json'
    },
    limits: {
      max_organ_candidates: 10,
      max_pathway_candidates: 8,
      max_assimilation_candidates: 8,
      assimilation_stale_days: 30
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const sources = raw.sources && typeof raw.sources === 'object' ? raw.sources : {};
  const limits = raw.limits && typeof raw.limits === 'object' ? raw.limits : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    cycle_days: clampInt(raw.cycle_days, 7, 365, base.cycle_days),
    veto_window_hours: clampInt(raw.veto_window_hours, 1, 24 * 30, base.veto_window_hours),
    require_human_approval_for_apply: raw.require_human_approval_for_apply !== false,
    require_veto_window_elapsed: raw.require_veto_window_elapsed !== false,
    max_actions_per_plan: clampInt(raw.max_actions_per_plan, 1, 500, base.max_actions_per_plan),
    sources: {
      organ_atrophy_latest_path: cleanText(sources.organ_atrophy_latest_path || base.sources.organ_atrophy_latest_path, 320),
      weaver_pathway_state_path: cleanText(sources.weaver_pathway_state_path || base.sources.weaver_pathway_state_path, 320),
      assimilation_ledger_path: cleanText(sources.assimilation_ledger_path || base.sources.assimilation_ledger_path, 320)
    },
    limits: {
      max_organ_candidates: clampInt(limits.max_organ_candidates, 0, 100, base.limits.max_organ_candidates),
      max_pathway_candidates: clampInt(limits.max_pathway_candidates, 0, 100, base.limits.max_pathway_candidates),
      max_assimilation_candidates: clampInt(limits.max_assimilation_candidates, 0, 100, base.limits.max_assimilation_candidates),
      assimilation_stale_days: clampInt(limits.assimilation_stale_days, 1, 3650, base.limits.assimilation_stale_days)
    }
  };
}

function runtimePaths(policyPath: string) {
  const stateDir = process.env.GLOBAL_MOLT_STATE_DIR
    ? path.resolve(process.env.GLOBAL_MOLT_STATE_DIR)
    : path.join(ROOT, 'state', 'ops', 'global_molt');
  return {
    policy_path: policyPath,
    state_dir: stateDir,
    latest_path: path.join(stateDir, 'latest.json'),
    plans_dir: path.join(stateDir, 'plans'),
    history_path: path.join(stateDir, 'history.jsonl'),
    applied_receipts_path: path.join(stateDir, 'applied_receipts.jsonl'),
    vetoes_path: path.join(stateDir, 'vetoes.jsonl')
  };
}

function resolveInputPath(raw: string) {
  if (!raw) return null;
  if (path.isAbsolute(raw)) return raw;
  return path.join(ROOT, raw);
}

function loadPlan(paths: AnyObj, planId: string) {
  const safeId = normalizeToken(planId, 120);
  if (!safeId) return null;
  const planPath = path.join(paths.plans_dir, `${safeId}.json`);
  const plan = readJson(planPath, null);
  if (!plan || typeof plan !== 'object') return null;
  return { plan, plan_path: planPath };
}

function buildPlanActions(policy: AnyObj) {
  const actions: AnyObj[] = [];
  const atrophyPath = resolveInputPath(policy.sources.organ_atrophy_latest_path);
  const pathwayPath = resolveInputPath(policy.sources.weaver_pathway_state_path);
  const assimilationPath = resolveInputPath(policy.sources.assimilation_ledger_path);

  const atrophy = atrophyPath ? readJson(atrophyPath, {}) : {};
  const atrophyCandidates = Array.isArray(atrophy && atrophy.candidates) ? atrophy.candidates : [];
  for (const row of atrophyCandidates.slice(0, Number(policy.limits.max_organ_candidates || 0))) {
    const organId = normalizeToken(row && row.organ_id || '', 80);
    if (!organId) continue;
    actions.push({
      action_id: `molt_org_${sha10(`org|${organId}`)}`,
      action_type: 'compress_organ_endpoint',
      target_id: organId,
      source: 'organ_atrophy',
      rationale: cleanText(row && row.reason || row && row.summary || 'low_usefulness_signal', 220),
      rollback: {
        command: `node systems/ops/organ_atrophy_controller.js revive --organ-id=${organId} --persist=1`,
        type: 'revive_endpoint'
      }
    });
  }

  const pathwayState = pathwayPath ? readJson(pathwayPath, {}) : {};
  const dormant = Array.isArray(pathwayState && pathwayState.dormant) ? pathwayState.dormant : [];
  for (const row of dormant.slice(0, Number(policy.limits.max_pathway_candidates || 0))) {
    const metricId = normalizeToken(row && row.metric_id || '', 80);
    if (!metricId) continue;
    actions.push({
      action_id: `molt_path_${sha10(`path|${metricId}`)}`,
      action_type: 'archive_value_pathway',
      target_id: metricId,
      source: 'weaver_pathways',
      rationale: cleanText(row && row.reason || row && row.state || 'dormant_pathway', 220),
      rollback: {
        command: `node systems/weaver/weaver_core.js run --primary-metric=${metricId} --dry-run=1`,
        type: 'pathway_rehydrate'
      }
    });
  }

  const assimilationLedger = assimilationPath ? readJson(assimilationPath, {}) : {};
  const capabilities = assimilationLedger && assimilationLedger.capabilities && typeof assimilationLedger.capabilities === 'object'
    ? assimilationLedger.capabilities
    : {};
  const nowMs = Date.now();
  const staleDays = Number(policy.limits.assimilation_stale_days || 30);
  const staleRows: AnyObj[] = [];
  for (const [capId, rowRaw] of Object.entries(capabilities)) {
    const row = rowRaw && typeof rowRaw === 'object' ? rowRaw as AnyObj : {};
    const lastUsedMs = parseIsoMs(row.last_used_ts) || parseIsoMs(row.updated_at) || 0;
    if (!lastUsedMs) continue;
    const idleDays = (nowMs - lastUsedMs) / (24 * 60 * 60 * 1000);
    if (idleDays < staleDays) continue;
    staleRows.push({
      capability_id: normalizeToken(capId, 160),
      idle_days: Number(idleDays.toFixed(3)),
      source_type: normalizeToken(row.source_type || 'unknown', 80) || 'unknown'
    });
  }
  staleRows.sort((a, b) => Number(b.idle_days || 0) - Number(a.idle_days || 0));
  for (const row of staleRows.slice(0, Number(policy.limits.max_assimilation_candidates || 0))) {
    if (!row.capability_id) continue;
    actions.push({
      action_id: `molt_asm_${sha10(`asm|${row.capability_id}`)}`,
      action_type: 'atrophy_assimilated_capability',
      target_id: row.capability_id,
      source: 'assimilation_ledger',
      rationale: `idle_days_${Number(row.idle_days || 0).toFixed(1)}`,
      rollback: {
        command: `node systems/assimilation/assimilation_controller.js record-use --capability-id=${row.capability_id} --source-type=${row.source_type} --success=1`,
        type: 'capability_reactivate'
      }
    });
  }

  return actions.slice(0, Number(policy.max_actions_per_plan || 25));
}

function cmdPlan(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.GLOBAL_MOLT_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath);
  if (policy.enabled !== true) {
    return { ok: false, type: 'global_molt_plan', error: 'policy_disabled' };
  }
  const ts = nowIso();
  const planId = `molt_${sha10(`${ts}|${Math.random()}`)}`;
  const vetoDeadlineTs = new Date(Date.now() + (Number(policy.veto_window_hours || 24) * 60 * 60 * 1000)).toISOString();
  const actions = buildPlanActions(policy);
  const plan = {
    schema_id: 'global_molt_plan',
    schema_version: '1.0',
    ts,
    plan_id: planId,
    status: 'planned',
    cycle_days: Number(policy.cycle_days || 30),
    veto_deadline_ts: vetoDeadlineTs,
    action_count: actions.length,
    actions
  };
  const planPath = path.join(paths.plans_dir, `${planId}.json`);
  ensureDir(paths.plans_dir);
  writeJsonAtomic(planPath, plan);
  appendJsonl(paths.history_path, {
    ts,
    type: 'global_molt_plan',
    plan_id: planId,
    action_count: actions.length,
    veto_deadline_ts: vetoDeadlineTs
  });
  writeJsonAtomic(paths.latest_path, {
    ok: true,
    type: 'global_molt_plan',
    ts,
    plan_id: planId,
    action_count: actions.length,
    plan_path: relPath(planPath)
  });
  return {
    ok: true,
    type: 'global_molt_plan',
    ts,
    plan_id: planId,
    action_count: actions.length,
    veto_deadline_ts: vetoDeadlineTs,
    actions: actions.slice(0, 20)
  };
}

function cmdVeto(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.GLOBAL_MOLT_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath);
  const planId = normalizeToken(args['plan-id'] || args.plan_id || '', 120);
  if (!planId) return { ok: false, type: 'global_molt_veto', error: 'plan_id_required' };
  const loaded = loadPlan(paths, planId);
  if (!loaded) return { ok: false, type: 'global_molt_veto', error: 'plan_not_found' };
  loaded.plan.status = 'vetoed';
  loaded.plan.vetoed_at = nowIso();
  loaded.plan.veto_reason = cleanText(args.reason || 'operator_veto', 240) || 'operator_veto';
  writeJsonAtomic(loaded.plan_path, loaded.plan);
  appendJsonl(paths.vetoes_path, {
    ts: nowIso(),
    type: 'global_molt_veto',
    plan_id: planId,
    reason: loaded.plan.veto_reason
  });
  writeJsonAtomic(paths.latest_path, {
    ok: true,
    type: 'global_molt_veto',
    ts: nowIso(),
    plan_id: planId,
    status: 'vetoed'
  });
  return {
    ok: true,
    type: 'global_molt_veto',
    plan_id: planId,
    status: 'vetoed'
  };
}

function cmdApply(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.GLOBAL_MOLT_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath);
  const planId = normalizeToken(args['plan-id'] || args.plan_id || '', 120);
  if (!planId) return { ok: false, type: 'global_molt_apply', error: 'plan_id_required' };
  const loaded = loadPlan(paths, planId);
  if (!loaded) return { ok: false, type: 'global_molt_apply', error: 'plan_not_found' };
  const plan = loaded.plan;
  if (String(plan.status || '') === 'vetoed') {
    return { ok: false, type: 'global_molt_apply', error: 'plan_vetoed' };
  }
  const humanApproved = toBool(args['human-approved'] || args.human_approved, false);
  if (policy.require_human_approval_for_apply === true && humanApproved !== true) {
    return { ok: false, type: 'global_molt_apply', error: 'human_approval_required' };
  }
  if (policy.require_veto_window_elapsed === true) {
    const deadlineMs = parseIsoMs(plan.veto_deadline_ts) || 0;
    if (Date.now() < deadlineMs) {
      return { ok: false, type: 'global_molt_apply', error: 'veto_window_open' };
    }
  }
  const applyTs = nowIso();
  const appliedRows = (Array.isArray(plan.actions) ? plan.actions : []).map((action: AnyObj) => ({
    ts: applyTs,
    plan_id: planId,
    action_id: action.action_id,
    action_type: action.action_type,
    target_id: action.target_id,
    source: action.source,
    rollback: action.rollback || {},
    reversible: true
  }));
  for (const row of appliedRows) appendJsonl(paths.applied_receipts_path, row);
  plan.status = 'applied';
  plan.applied_at = applyTs;
  plan.applied_receipts = appliedRows.map((row) => row.action_id);
  writeJsonAtomic(loaded.plan_path, plan);
  appendJsonl(paths.history_path, {
    ts: applyTs,
    type: 'global_molt_apply',
    plan_id: planId,
    action_count: appliedRows.length,
    reversible: true
  });
  writeJsonAtomic(paths.latest_path, {
    ok: true,
    type: 'global_molt_apply',
    ts: applyTs,
    plan_id: planId,
    action_count: appliedRows.length,
    reversible: true
  });
  return {
    ok: true,
    type: 'global_molt_apply',
    ts: applyTs,
    plan_id: planId,
    action_count: appliedRows.length,
    reversible: true
  };
}

function cmdStatus(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.GLOBAL_MOLT_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath);
  const planId = normalizeToken(args['plan-id'] || args.plan_id || 'latest', 120);
  let plan = null;
  if (planId && planId !== 'latest') {
    const loaded = loadPlan(paths, planId);
    plan = loaded ? loaded.plan : null;
  } else {
    const latest = readJson(paths.latest_path, null);
    const latestPlanId = normalizeToken(latest && latest.plan_id || '', 120);
    if (latestPlanId) {
      const loaded = loadPlan(paths, latestPlanId);
      plan = loaded ? loaded.plan : null;
    }
  }
  return {
    ok: true,
    type: 'global_molt_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      path: relPath(policyPath)
    },
    plan,
    latest_path: relPath(paths.latest_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/global_molt_cycle.js plan');
  console.log('  node systems/ops/global_molt_cycle.js veto --plan-id=<id> [--reason=<txt>]');
  console.log('  node systems/ops/global_molt_cycle.js apply --plan-id=<id> [--human-approved=1]');
  console.log('  node systems/ops/global_molt_cycle.js status [--plan-id=<id>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  let out: AnyObj;
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'plan') out = cmdPlan(args);
  else if (cmd === 'veto') out = cmdVeto(args);
  else if (cmd === 'apply') out = cmdApply(args);
  else if (cmd === 'status') out = cmdStatus(args);
  else {
    usage();
    process.exit(2);
    return;
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  cmdPlan,
  cmdApply,
  cmdVeto,
  cmdStatus
};

