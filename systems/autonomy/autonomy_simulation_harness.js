#!/usr/bin/env node
'use strict';

/**
 * autonomy_simulation_harness.js
 *
 * End-to-end replay-style health simulation over recent autonomy activity.
 * Produces a deterministic scorecard for drift, yield, and safety gates.
 *
 * Usage:
 *   node systems/autonomy/autonomy_simulation_harness.js run [YYYY-MM-DD] [--days=N] [--write=1|0] [--strict]
 *   node systems/autonomy/autonomy_simulation_harness.js status [YYYY-MM-DD] [--days=N]
 */

const fs = require('fs');
const path = require('path');
const {
  compileDirectiveLineage,
  evaluateDirectiveLineageCandidate,
  extractObjectiveIdFromProposal
} = require('../security/directive_compiler.js');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = process.env.AUTONOMY_SIM_RUNS_DIR
  ? path.resolve(String(process.env.AUTONOMY_SIM_RUNS_DIR))
  : path.join(ROOT, 'state', 'autonomy', 'runs');
const PROPOSALS_DIR = process.env.AUTONOMY_SIM_PROPOSALS_DIR
  ? path.resolve(String(process.env.AUTONOMY_SIM_PROPOSALS_DIR))
  : path.join(ROOT, 'state', 'sensory', 'proposals');
const OUTPUT_DIR = process.env.AUTONOMY_SIM_OUTPUT_DIR
  ? path.resolve(String(process.env.AUTONOMY_SIM_OUTPUT_DIR))
  : path.join(ROOT, 'state', 'autonomy', 'simulations');

const DRIFT_WARN = Number(process.env.AUTONOMY_SIM_DRIFT_WARN || 0.65);
const DRIFT_FAIL = Number(process.env.AUTONOMY_SIM_DRIFT_FAIL || 0.85);
const YIELD_WARN = Number(process.env.AUTONOMY_SIM_YIELD_WARN || 0.2);
const YIELD_FAIL = Number(process.env.AUTONOMY_SIM_YIELD_FAIL || 0.08);
const SAFETY_WARN = Number(process.env.AUTONOMY_SIM_SAFETY_WARN || 0.25);
const SAFETY_FAIL = Number(process.env.AUTONOMY_SIM_SAFETY_FAIL || 0.45);
const POLICY_HOLD_WARN = Number(process.env.AUTONOMY_SIM_POLICY_HOLD_WARN || 0.2);
const POLICY_HOLD_FAIL = Number(process.env.AUTONOMY_SIM_POLICY_HOLD_FAIL || 0.35);
const BUDGET_HOLD_WARN = Number(process.env.AUTONOMY_SIM_BUDGET_HOLD_WARN || 0.12);
const BUDGET_HOLD_FAIL = Number(process.env.AUTONOMY_SIM_BUDGET_HOLD_FAIL || 0.25);
const BUDGET_AUTOPAUSE_ACTIVE_FAIL = String(process.env.AUTONOMY_SIM_AUTOPAUSE_ACTIVE_FAIL || '1').trim() !== '0';
const ENFORCE_POLICY_HOLD_FAIL = String(process.env.AUTONOMY_SIM_ENFORCE_POLICY_HOLD_FAIL || '0').trim() === '1';
const ENFORCE_BUDGET_HOLD_FAIL = String(process.env.AUTONOMY_SIM_ENFORCE_BUDGET_HOLD_FAIL || '0').trim() === '1';
const MIN_ATTEMPTS = Math.max(1, Number(process.env.AUTONOMY_SIM_MIN_ATTEMPTS || 5));
const MAX_WINDOW_DAYS = Math.max(1, Math.floor(Number(process.env.AUTONOMY_SIM_MAX_DAYS || 180)));
const SIM_LINEAGE_REQUIRED = String(process.env.AUTONOMY_SIM_LINEAGE_REQUIRED || '1').trim() !== '0';
const SIM_LINEAGE_REQUIRE_T1_ROOT = String(process.env.AUTONOMY_SIM_LINEAGE_REQUIRE_T1_ROOT || '1').trim() !== '0';
const SIM_LINEAGE_BLOCK_MISSING_OBJECTIVE = String(process.env.AUTONOMY_SIM_LINEAGE_BLOCK_MISSING_OBJECTIVE || '1').trim() !== '0';
const SIM_LINEAGE_FILTER_CONTEXTLESS = String(process.env.AUTONOMY_SIM_LINEAGE_FILTER_CONTEXTLESS || '1').trim() !== '0';
const SIM_LINEAGE_ROLLING_CONTEXT = String(process.env.AUTONOMY_SIM_LINEAGE_ROLLING_CONTEXT || '0').trim() === '1';
const SIM_EXTERNAL_INPUT_OVERRIDE = process.env.AUTONOMY_SIM_RUNS_DIR != null
  || process.env.AUTONOMY_SIM_PROPOSALS_DIR != null;
const SIM_FILTER_LEGACY_UNBOUND_EYE_NO_CHANGE = String(process.env.AUTONOMY_SIM_FILTER_LEGACY_UNBOUND_EYE_NO_CHANGE || '1').trim() !== '0';

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/autonomy_simulation_harness.js run [YYYY-MM-DD] [--days=N] [--write=1|0] [--strict]');
  console.log('  node systems/autonomy/autonomy_simulation_harness.js status [YYYY-MM-DD] [--days=N]');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function isDateStr(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function resolveDate(args) {
  const first = String(args._[1] || '').trim();
  if (isDateStr(first)) return first;
  const second = String(args._[0] || '').trim();
  if (isDateStr(second)) return second;
  return todayStr();
}

function toInt(v, fallback, lo = 1, hi = 365) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(fp, fallback) {
  try {
    if (!fs.existsSync(fp)) return fallback;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return fallback;
  }
}

function readBudgetAutopauseSnapshot(endDateStr) {
  const fp = path.join(ROOT, 'state', 'autonomy', 'budget_autopause.json');
  const raw = readJson(fp, {});
  const active = raw && raw.active === true;
  const untilMs = Number(raw && raw.until_ms || 0);
  const nowMs = Date.now();
  const currentlyActive = active && (!Number.isFinite(untilMs) || untilMs > nowMs);
  const activeRelevant = currentlyActive && String(endDateStr || '') === todayStr();
  return {
    path: fp,
    active: active === true,
    currently_active: currentlyActive === true,
    active_relevant: activeRelevant === true,
    source: String(raw && raw.source || '').trim() || null,
    reason: String(raw && raw.reason || '').trim() || null,
    pressure: String(raw && raw.pressure || '').trim() || null,
    until: String(raw && raw.until || '').trim() || null,
    updated_at: String(raw && raw.updated_at || '').trim() || null
  };
}

function readJsonl(fp) {
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function dateWindow(endDateStr, days) {
  const end = new Date(`${endDateStr}T00:00:00.000Z`);
  if (Number.isNaN(end.getTime())) return [];
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function safeRate(num, den) {
  const n = Number(num || 0);
  const d = Number(den || 0);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return 0;
  return n / d;
}

function buildChecks(input, context = {}) {
  const attempts = Number(input && input.attempts || 0);
  const executed = Number(input && input.executed || 0);
  const shipped = Number(input && input.shipped || 0);
  const noProgress = Number(input && input.no_progress || 0);
  const safetyStops = Number(input && input.safety_stops || 0);
  const policyHolds = Number(input && input.policy_holds || 0);
  const budgetHolds = Number(context && context.budget_holds || 0);
  const autopauseActive = context && context.autopause_active === true;
  const driftRate = safeRate(noProgress, attempts);
  const yieldRate = safeRate(shipped, executed);
  const safetyRate = safeRate(safetyStops, attempts);
  const policyHoldRate = safeRate(policyHolds, attempts);
  const budgetHoldRate = safeRate(budgetHolds, attempts);
  const policyHoldStatus = policyHoldRate >= POLICY_HOLD_FAIL
    ? (ENFORCE_POLICY_HOLD_FAIL ? 'fail' : 'warn')
    : policyHoldRate >= POLICY_HOLD_WARN ? 'warn' : 'pass';
  const budgetHoldStatus = budgetHoldRate >= BUDGET_HOLD_FAIL
    ? (ENFORCE_BUDGET_HOLD_FAIL ? 'fail' : 'warn')
    : budgetHoldRate >= BUDGET_HOLD_WARN ? 'warn' : 'pass';
  return {
    drift_rate: {
      value: Number(driftRate.toFixed(3)),
      warn: DRIFT_WARN,
      fail: DRIFT_FAIL,
      status: driftRate >= DRIFT_FAIL ? 'fail' : driftRate >= DRIFT_WARN ? 'warn' : 'pass'
    },
    yield_rate: {
      value: Number(yieldRate.toFixed(3)),
      warn: YIELD_WARN,
      fail: YIELD_FAIL,
      status: yieldRate <= YIELD_FAIL ? 'fail' : yieldRate <= YIELD_WARN ? 'warn' : 'pass'
    },
    safety_stop_rate: {
      value: Number(safetyRate.toFixed(3)),
      warn: SAFETY_WARN,
      fail: SAFETY_FAIL,
      status: safetyRate >= SAFETY_FAIL ? 'fail' : safetyRate >= SAFETY_WARN ? 'warn' : 'pass'
    },
    attempt_volume: {
      value: attempts,
      min: MIN_ATTEMPTS,
      status: attempts < MIN_ATTEMPTS ? 'warn' : 'pass'
    },
    policy_hold_rate: {
      value: Number(policyHoldRate.toFixed(3)),
      warn: POLICY_HOLD_WARN,
      fail: POLICY_HOLD_FAIL,
      enforce_fail: ENFORCE_POLICY_HOLD_FAIL,
      status: policyHoldStatus
    },
    budget_hold_rate: {
      value: Number(budgetHoldRate.toFixed(3)),
      warn: BUDGET_HOLD_WARN,
      fail: BUDGET_HOLD_FAIL,
      enforce_fail: ENFORCE_BUDGET_HOLD_FAIL,
      status: budgetHoldStatus
    },
    budget_autopause_active: {
      value: autopauseActive,
      fail_when_active: BUDGET_AUTOPAUSE_ACTIVE_FAIL,
      status: autopauseActive ? (BUDGET_AUTOPAUSE_ACTIVE_FAIL ? 'fail' : 'warn') : 'pass'
    }
  };
}

function verdictFromChecks(checks) {
  const failing = Object.values(checks || {}).some((row) => row && row.status === 'fail');
  if (failing) return 'fail';
  const warning = Object.values(checks || {}).some((row) => row && row.status === 'warn');
  return warning ? 'warn' : 'pass';
}

function worstVerdict(a, b) {
  const rank = { pass: 0, warn: 1, fail: 2 };
  const av = rank[String(a || 'pass')] ?? 0;
  const bv = rank[String(b || 'pass')] ?? 0;
  return av >= bv ? String(a || 'pass') : String(b || 'pass');
}

const LEGACY_POLICY_HOLD_RESULTS = new Set([
  'stop_repeat_gate_preview_structural_cooldown',
  'stop_repeat_gate_preview_churn_cooldown',
  'stop_repeat_gate_human_escalation_pending',
  'stop_init_gate_budget_autopause',
  'stop_repeat_gate_daily_cap',
  'stop_repeat_gate_canary_cap',
  'stop_repeat_gate_unchanged_state'
]);

function isRouteBudgetHoldEvent(evt) {
  if (!evt || evt.type !== 'autonomy_run') return false;
  if (String(evt.result || '') !== 'init_gate_blocked_route') return false;
  const routeSummary = evt.route_summary && typeof evt.route_summary === 'object'
    ? evt.route_summary
    : {};
  const blockReason = String(evt.route_block_reason || '').trim().toLowerCase();
  return routeSummary.budget_deferred === true
    || routeSummary.budget_blocked === true
    || (routeSummary.budget_global_guard && routeSummary.budget_global_guard.deferred === true)
    || blockReason === 'burn_rate_exceeded'
    || blockReason === 'budget_deferred_preview';
}

function isRouteManualGovernanceHoldEvent(evt) {
  if (!evt || evt.type !== 'autonomy_run') return false;
  if (String(evt.result || '') !== 'init_gate_blocked_route') return false;
  const routeSummary = evt.route_summary && typeof evt.route_summary === 'object'
    ? evt.route_summary
    : {};
  const blockReason = String(evt.route_block_reason || '').trim().toLowerCase();
  const gateDecision = String(routeSummary.gate_decision || '').trim().toUpperCase();
  const gateRisk = String(routeSummary.gate_risk || '').trim().toLowerCase();
  return blockReason === 'gate_manual'
    || (gateDecision === 'MANUAL' && gateRisk === 'high');
}

function isPolicyHoldEvent(evt) {
  if (!evt || evt.type !== 'autonomy_run') return false;
  if (evt.policy_hold === true) return true;
  const result = String(evt.result || '');
  if (!result) return false;
  if (result.startsWith('no_candidates_policy_')) return true;
  if (LEGACY_POLICY_HOLD_RESULTS.has(result)) return true;
  if (isRouteBudgetHoldEvent(evt)) return true;
  if (isRouteManualGovernanceHoldEvent(evt)) return true;
  return result.startsWith('no_candidates_policy_')
    || result === 'score_only_fallback_route_block'
    || result === 'score_only_fallback_low_execution_confidence';
}

function isBudgetHoldEvent(evt) {
  if (!evt || evt.type !== 'autonomy_run') return false;
  if (isRouteBudgetHoldEvent(evt)) return true;
  const result = String(evt.result || '').toLowerCase();
  const holdReason = String(evt.policy_hold_reason || '').toLowerCase();
  const blockReason = String(evt.route_block_reason || '').toLowerCase();
  return result === 'stop_init_gate_budget_autopause'
    || result.includes('budget_autopause')
    || holdReason.includes('budget')
    || holdReason.includes('burn_rate')
    || blockReason.includes('budget')
    || blockReason.includes('burn_rate');
}

function deriveBudgetAutopauseFromRuns(runRows, endDateStr) {
  const endMs = Date.parse(`${String(endDateStr || '')}T23:59:59.999Z`);
  let latestExplicit = null;
  let latestImplicit = null;

  for (const evt of (Array.isArray(runRows) ? runRows : [])) {
    if (!evt || evt.type !== 'autonomy_run') continue;
    const tsMs = Date.parse(String(evt.ts || ''));
    if (!Number.isFinite(tsMs)) continue;
    if (Number.isFinite(endMs) && tsMs > endMs) continue;

    const routeSummary = evt.route_summary && typeof evt.route_summary === 'object'
      ? evt.route_summary
      : {};
    const budgetGlobalGuard = routeSummary.budget_global_guard && typeof routeSummary.budget_global_guard === 'object'
      ? routeSummary.budget_global_guard
      : null;
    const autopause = budgetGlobalGuard && budgetGlobalGuard.autopause && typeof budgetGlobalGuard.autopause === 'object'
      ? budgetGlobalGuard.autopause
      : null;

    if (autopause && typeof autopause.active === 'boolean') {
      const untilMs = Date.parse(String(autopause.until || ''));
      if (!latestExplicit || tsMs >= latestExplicit.ts_ms) {
        latestExplicit = {
          ts_ms: tsMs,
          active: autopause.active === true,
          until_ms: Number.isFinite(untilMs) ? untilMs : null,
          source: 'route_summary.autopause'
        };
      }
    }

    const result = String(evt.result || '').toLowerCase();
    const blockReason = String(evt.route_block_reason || '').toLowerCase();
    const routeBudgetBlockReason = String(routeSummary.budget_block_reason || '').toLowerCase();
    if (
      result.includes('budget_autopause')
      || blockReason.includes('budget_autopause')
      || routeBudgetBlockReason.includes('budget_autopause')
    ) {
      if (!latestImplicit || tsMs >= latestImplicit.ts_ms) {
        latestImplicit = {
          ts_ms: tsMs,
          active: true,
          until_ms: null,
          source: 'budget_autopause_signal'
        };
      }
    }
  }

  const lastSignal = latestExplicit || latestImplicit;
  let activeAtEnd = false;
  if (latestExplicit) {
    activeAtEnd = latestExplicit.active === true;
    if (activeAtEnd && Number.isFinite(latestExplicit.until_ms) && Number.isFinite(endMs)) {
      activeAtEnd = latestExplicit.until_ms > endMs;
    }
  } else if (latestImplicit) {
    activeAtEnd = true;
  }

  return {
    observed_in_window: !!lastSignal,
    active_at_window_end: activeAtEnd,
    signal_source: lastSignal ? lastSignal.source : null,
    explicit_last_ts: latestExplicit ? new Date(latestExplicit.ts_ms).toISOString() : null,
    implicit_last_ts: latestImplicit ? new Date(latestImplicit.ts_ms).toISOString() : null
  };
}

function resolveBudgetAutopauseSnapshot(endDateStr, runRows) {
  const snapshot = readBudgetAutopauseSnapshot(endDateStr);
  const derived = deriveBudgetAutopauseFromRuns(runRows, endDateStr);
  const activeRelevant = SIM_EXTERNAL_INPUT_OVERRIDE
    ? derived.active_at_window_end === true
    : (snapshot.active_relevant === true || derived.active_at_window_end === true);
  return {
    ...snapshot,
    ...derived,
    source_mode: SIM_EXTERNAL_INPUT_OVERRIDE ? 'derived_from_runs' : 'live_state_plus_runs',
    active_relevant: activeRelevant
  };
}

function isAttemptRunRaw(evt) {
  if (!evt || evt.type !== 'autonomy_run') return false;
  const result = String(evt.result || '');
  if (!result) return false;
  if (result === 'lock_busy' || result === 'stop_repeat_gate_interval') return false;
  return true;
}

function isAttemptRun(evt) {
  return isAttemptRunRaw(evt) && !isPolicyHoldEvent(evt);
}

function isNoProgress(evt) {
  if (!evt || evt.type !== 'autonomy_run') return false;
  if (isPolicyHoldEvent(evt)) return false;
  if (evt.result === 'executed') return String(evt.outcome || '') !== 'shipped';
  const result = String(evt.result || '');
  return result.startsWith('stop_') || result.startsWith('init_gate_');
}

function isSafetyStop(evt) {
  if (!evt || evt.type !== 'autonomy_run') return false;
  const result = String(evt.result || '');
  return result.includes('human_escalation')
    || result.includes('tier1_governance')
    || result.includes('medium_risk_guard')
    || result.includes('capability_cooldown')
    || result.includes('directive_pulse_tier_reservation');
}

function normalizeText(v) {
  return String(v == null ? '' : v).trim();
}

function objectiveIdFromRun(evt) {
  if (!evt || evt.type !== 'autonomy_run') return '';
  const pulse = evt.directive_pulse && typeof evt.directive_pulse === 'object' ? evt.directive_pulse : {};
  const binding = evt.objective_binding && typeof evt.objective_binding === 'object'
    ? evt.objective_binding
    : {};
  const id = normalizeText(
    pulse.objective_id
    || evt.objective_id
    || binding.objective_id
    || ''
  );
  return id;
}

function proposalIdFromRun(evt) {
  if (!evt || evt.type !== 'autonomy_run') return '';
  const topEscalation = evt.top_escalation && typeof evt.top_escalation === 'object'
    ? evt.top_escalation
    : {};
  const id = normalizeText(
    evt.proposal_id
    || evt.selected_proposal_id
    || topEscalation.proposal_id
    || ''
  );
  return id;
}

function isProposalScopedRun(evt) {
  if (!evt || evt.type !== 'autonomy_run') return false;
  return !!(proposalIdFromRun(evt) || objectiveIdFromRun(evt));
}

function isContextlessGateResult(evt) {
  if (!evt || evt.type !== 'autonomy_run') return false;
  const result = String(evt.result || '');
  if (!result) return false;
  return result.startsWith('stop_repeat_gate_')
    || result.startsWith('stop_init_gate_')
    || result.startsWith('init_gate_')
    || result.startsWith('no_candidates_policy_')
    || result === 'no_candidates'
    || result === 'stop_emergency_stop';
}

function normalizeProposalRows(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.proposals)) return raw.proposals;
  return [];
}

function proposalIndexForWindow(dates) {
  const byId = new Map();
  for (const d of dates) {
    const fp = path.join(PROPOSALS_DIR, `${d}.json`);
    const rows = normalizeProposalRows(readJson(fp, []));
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const id = normalizeText(row.id || '');
      if (!id) continue;
      const objectiveId = extractObjectiveIdFromProposal(row);
      byId.set(id, {
        proposal_id: id,
        proposal_date: d,
        objective_id: objectiveId || '',
        proposal_type: normalizeText(row.type || '')
      });
    }
  }
  return byId;
}

function resolveRunContext(evt, proposalIndex) {
  const proposalId = proposalIdFromRun(evt);
  const fromRun = objectiveIdFromRun(evt);
  const fromIndex = proposalId && proposalIndex && proposalIndex.get(proposalId)
    ? normalizeText(proposalIndex.get(proposalId).objective_id || '')
    : '';
  return {
    proposal_id: proposalId || null,
    objective_id: fromRun || fromIndex || null,
    source: fromRun ? 'run' : (fromIndex ? 'proposal_index' : 'none')
  };
}

function isLegacyUnboundEyeNoChange(evt, ctx) {
  if (!evt || evt.type !== 'autonomy_run') return false;
  if (String(evt.result || '') !== 'executed') return false;
  if (String(evt.outcome || '') === 'shipped') return false;
  const proposalId = normalizeText((ctx && ctx.proposal_id) || proposalIdFromRun(evt));
  if (!proposalId.startsWith('EYE-')) return false;
  if (normalizeText(objectiveIdFromRun(evt))) return false;
  const source = normalizeText(ctx && ctx.source);
  if (source !== 'proposal_index' && source !== 'none') return false;
  const routeSummary = evt.route_summary && typeof evt.route_summary === 'object'
    ? evt.route_summary
    : {};
  const decision = String(routeSummary.decision || '').trim().toUpperCase();
  const executable = routeSummary.executable === true;
  return decision === 'MANUAL' || decision === 'PROPOSE_HABIT' || executable === false;
}

function applyDirectiveCompilerProjection(attempts, proposalIndex, directiveCompiler) {
  const accepted = [];
  const rejected = [];
  const skipped = [];
  const rejectedByReason = {};
  let rollingContext = { proposal_id: null, objective_id: null };
  const proposalObjectiveCache = new Map();

  for (const evt of attempts) {
    let ctx = resolveRunContext(evt, proposalIndex);
    if (ctx.proposal_id && !ctx.objective_id && proposalObjectiveCache.has(ctx.proposal_id)) {
      ctx = {
        proposal_id: ctx.proposal_id,
        objective_id: proposalObjectiveCache.get(ctx.proposal_id) || null,
        source: 'proposal_objective_cache'
      };
    }
    if (
      SIM_LINEAGE_ROLLING_CONTEXT
      && !ctx.objective_id
      && !ctx.proposal_id
      && (rollingContext.objective_id || rollingContext.proposal_id)
      && isContextlessGateResult(evt)
    ) {
      ctx = {
        proposal_id: ctx.proposal_id || rollingContext.proposal_id || null,
        objective_id: ctx.objective_id || rollingContext.objective_id || null,
        source: 'rolling_prior_attempt'
      };
    }
    if (ctx.proposal_id && ctx.objective_id) {
      proposalObjectiveCache.set(ctx.proposal_id, ctx.objective_id);
    }
    if (SIM_LINEAGE_ROLLING_CONTEXT && (ctx.objective_id || ctx.proposal_id)) {
      rollingContext = {
        proposal_id: ctx.proposal_id || rollingContext.proposal_id || null,
        objective_id: ctx.objective_id || rollingContext.objective_id || null
      };
    }

    if (SIM_LINEAGE_FILTER_CONTEXTLESS && !ctx.objective_id && !ctx.proposal_id) {
      if (isContextlessGateResult(evt) && !isProposalScopedRun(evt)) {
        skipped.push({
          evt,
          context: ctx,
          lineage: {
            pass: true,
            reason: 'non_proposal_gate',
            objective_id: null,
            root_objective_id: null,
            lineage_path: []
          }
        });
        continue;
      }
      const row = {
        pass: false,
        reason: 'objective_context_missing',
        objective_id: null,
        root_objective_id: null,
        lineage_path: []
      };
      rejected.push({ evt, context: ctx, lineage: row });
      rejectedByReason[row.reason] = Number(rejectedByReason[row.reason] || 0) + 1;
      continue;
    }

    if (SIM_FILTER_LEGACY_UNBOUND_EYE_NO_CHANGE && isLegacyUnboundEyeNoChange(evt, ctx)) {
      skipped.push({
        evt,
        context: ctx,
        lineage: {
          pass: true,
          reason: 'legacy_unbound_eye_no_change',
          objective_id: null,
          root_objective_id: null,
          lineage_path: []
        }
      });
      continue;
    }

    const lineage = SIM_LINEAGE_REQUIRED
      ? evaluateDirectiveLineageCandidate(
        {
          objective_id: ctx.objective_id || ''
        },
        {
          compiler: directiveCompiler,
          require_t1_root: SIM_LINEAGE_REQUIRE_T1_ROOT,
          block_missing_objective: SIM_LINEAGE_BLOCK_MISSING_OBJECTIVE,
          max_depth: 8
        }
      )
      : { pass: true, reason: null, objective_id: ctx.objective_id || null, root_objective_id: null, lineage_path: [] };

    if (!lineage.pass) {
      const reason = String(lineage.reason || 'lineage_invalid');
      rejected.push({ evt, context: ctx, lineage });
      rejectedByReason[reason] = Number(rejectedByReason[reason] || 0) + 1;
      continue;
    }

    if (ctx.source === 'rolling_prior_attempt') {
      accepted.push({
        ...evt,
        proposal_id: proposalIdFromRun(evt) || ctx.proposal_id || null,
        objective_id: objectiveIdFromRun(evt) || ctx.objective_id || null,
        context_source: ctx.source
      });
      continue;
    }
    accepted.push(evt);
  }

  return {
    accepted,
    rejected,
    skipped,
    rejected_by_reason: rejectedByReason
  };
}

function queueSnapshotForWindow(dates) {
  let total = 0;
  let pending = 0;
  let stalePending = 0;
  const nowMs = Date.now();
  for (const d of dates) {
    const fp = path.join(PROPOSALS_DIR, `${d}.json`);
    const raw = readJson(fp, []);
    const rows = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.proposals) ? raw.proposals : []);
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      total += 1;
      const status = String(row.status || row.state || 'pending').trim().toLowerCase();
      if (status === 'pending' || status === 'open') {
        pending += 1;
        const ms = Date.parse(`${d}T00:00:00.000Z`);
        const ageHours = Number.isFinite(ms) ? Math.max(0, (nowMs - ms) / 3600000) : 0;
        if (ageHours >= 72) stalePending += 1;
      }
    }
  }
  return { total, pending, stale_pending_72h: stalePending };
}

function computeSimulation(endDateStr, days) {
  const dates = dateWindow(endDateStr, days);
  const runs = [];
  for (const d of dates) {
    runs.push(...readJsonl(path.join(RUNS_DIR, `${d}.jsonl`)));
  }
  const runRows = runs.filter((row) => row && row.type === 'autonomy_run');
  const baselineAttemptsRaw = runRows.filter(isAttemptRunRaw);
  const baselinePolicyHolds = baselineAttemptsRaw.filter(isPolicyHoldEvent);
  const baselineBudgetHolds = baselinePolicyHolds.filter(isBudgetHoldEvent);
  const baselineAttempts = baselineAttemptsRaw.filter((row) => !isPolicyHoldEvent(row));
  const baselineExecutedRaw = runRows.filter((row) => row && row.result === 'executed');
  const baselineExecuted = baselineExecutedRaw.filter((row) => !isPolicyHoldEvent(row));
  const baselineShipped = baselineExecuted.filter((row) => String(row.outcome || '') === 'shipped');
  const baselineNoProgress = baselineAttempts.filter(isNoProgress);
  const baselineSafetyStops = baselineAttempts.filter(isSafetyStop);

  const proposalIndex = proposalIndexForWindow(dates);
  const directiveCompiler = compileDirectiveLineage();
  const compilerProjection = applyDirectiveCompilerProjection(
    baselineAttemptsRaw,
    proposalIndex,
    directiveCompiler
  );

  const attempts = compilerProjection.accepted.filter((row) => !isPolicyHoldEvent(row));
  const executed = attempts.filter((row) => row && row.result === 'executed');
  const shipped = executed.filter((row) => String(row.outcome || '') === 'shipped');
  const noProgress = attempts.filter(isNoProgress);
  const safetyStops = attempts.filter(isSafetyStop);
  const effectivePolicyHolds = compilerProjection.accepted.filter(isPolicyHoldEvent);
  const effectiveBudgetHolds = effectivePolicyHolds.filter(isBudgetHoldEvent);

  const objectiveCounts = {};
  for (const row of executed) {
    const id = objectiveIdFromRun(row);
    if (!id) continue;
    objectiveCounts[id] = Number(objectiveCounts[id] || 0) + 1;
  }

  const queue = queueSnapshotForWindow(dates);
  const budgetAutopause = resolveBudgetAutopauseSnapshot(endDateStr, runRows);
  const baselineCounters = {
    attempts: baselineAttemptsRaw.length,
    executed: baselineExecuted.length,
    shipped: baselineShipped.length,
    no_progress: baselineNoProgress.length,
    safety_stops: baselineSafetyStops.length,
    policy_holds: baselinePolicyHolds.length,
    budget_holds: baselineBudgetHolds.length
  };
  const effectiveCounters = {
    attempts: attempts.length,
    executed: executed.length,
    shipped: shipped.length,
    no_progress: noProgress.length,
    safety_stops: safetyStops.length,
    policy_holds: effectivePolicyHolds.length,
    budget_holds: effectiveBudgetHolds.length
  };
  const checksRaw = buildChecks(baselineCounters, {
    budget_holds: baselineCounters.budget_holds,
    autopause_active: budgetAutopause.active_relevant === true
  });
  const checksEffective = buildChecks(effectiveCounters, {
    budget_holds: effectiveCounters.budget_holds,
    autopause_active: budgetAutopause.active_relevant === true
  });
  const verdictRaw = verdictFromChecks(checksRaw);
  const verdictEffective = verdictFromChecks(checksEffective);
  const integrity = {
    mode: 'dual_track',
    baseline_preserved: true,
    effective_projection_present: true,
    denominator_reduction_only: effectiveCounters.attempts < baselineCounters.attempts,
    denominator_delta: baselineCounters.attempts - effectiveCounters.attempts
  };
  const verdict = worstVerdict(verdictRaw, verdictEffective);

  const recommendations = [];
  if (checksRaw.drift_rate.status !== 'pass' || checksEffective.drift_rate.status !== 'pass') {
    recommendations.push('Increase proposal quality floor or tighten objective binding for non-executable proposals.');
  }
  if (checksRaw.yield_rate.status !== 'pass' || checksEffective.yield_rate.status !== 'pass') {
    recommendations.push('Bias selection toward high-value, executable proposals and reduce medium-risk capacity until shipped rate recovers.');
  }
  if (checksRaw.policy_hold_rate.status !== 'pass' || checksEffective.policy_hold_rate.status !== 'pass') {
    recommendations.push('Reduce policy-hold churn: tighten admission routing, quarantine low-actionability proposals, and cut retry pressure during governance holds.');
  }
  if (checksRaw.budget_hold_rate.status !== 'pass' || checksEffective.budget_hold_rate.status !== 'pass') {
    recommendations.push('Budget holds are elevated; reduce action frequency or projected token cost before resuming full autonomy cadence.');
  }
  if (checksRaw.budget_autopause_active.status !== 'pass') {
    recommendations.push('Budget autopause is active for the current window; treat the lane as flow-blocked until autopause clears or budget policy is adjusted.');
  }
  if (queue.pending > 80 || queue.stale_pending_72h > 10) {
    recommendations.push('Run proposal queue SLO drain to park stale backlog and reduce queue pressure.');
  }

  return {
    ok: true,
    type: 'autonomy_simulation_harness',
    ts: new Date().toISOString(),
    end_date: endDateStr,
    days,
    verdict,
    verdict_raw: verdictRaw,
    verdict_effective: verdictEffective,
    checks: checksRaw,
    checks_effective: checksEffective,
    metric_integrity: integrity,
    counters: {
      run_rows: runRows.length,
      attempts: baselineCounters.attempts,
      executed: baselineCounters.executed,
      shipped: baselineCounters.shipped,
      no_progress: baselineCounters.no_progress,
      safety_stops: baselineCounters.safety_stops,
      policy_holds: baselineCounters.policy_holds,
      budget_holds: baselineCounters.budget_holds
    },
    baseline_counters: baselineCounters,
    effective_counters: effectiveCounters,
    budget_autopause: budgetAutopause,
    compiler_projection: {
      enabled: SIM_LINEAGE_REQUIRED === true,
      lineage_require_t1_root: SIM_LINEAGE_REQUIRE_T1_ROOT === true,
      lineage_block_missing_objective: SIM_LINEAGE_BLOCK_MISSING_OBJECTIVE === true,
      filter_contextless_attempts: SIM_LINEAGE_FILTER_CONTEXTLESS === true,
      rolling_context_enabled: SIM_LINEAGE_ROLLING_CONTEXT === true,
      compiler_hash: directiveCompiler.hash || null,
      compiler_active_count: Number(directiveCompiler.active_count || 0),
      accepted_attempts: compilerProjection.accepted.length,
      rejected_attempts: compilerProjection.rejected.length,
      skipped_attempts: Array.isArray(compilerProjection.skipped) ? compilerProjection.skipped.length : 0,
      rejected_by_reason: compilerProjection.rejected_by_reason || {},
      skipped_by_reason: (Array.isArray(compilerProjection.skipped) ? compilerProjection.skipped : []).reduce((acc, row) => {
        const key = String(row && row.lineage && row.lineage.reason || 'unknown');
        acc[key] = Number(acc[key] || 0) + 1;
        return acc;
      }, {}),
      sample_rejected: compilerProjection.rejected.slice(0, 8).map((row) => ({
        result: String(row && row.evt && row.evt.result || ''),
        proposal_id: row && row.context ? row.context.proposal_id : null,
        objective_id: row && row.context ? row.context.objective_id : null,
        reason: row && row.lineage ? row.lineage.reason || null : null
      })),
      sample_skipped: (Array.isArray(compilerProjection.skipped) ? compilerProjection.skipped : []).slice(0, 6).map((row) => ({
        result: String(row && row.evt && row.evt.result || ''),
        proposal_id: row && row.context ? row.context.proposal_id : null,
        objective_id: row && row.context ? row.context.objective_id : null,
        reason: row && row.lineage ? row.lineage.reason || null : null
      }))
    },
    queue,
    objective_mix: {
      executed_total: executed.length,
      objective_count: Object.keys(objectiveCounts).length,
      counts: objectiveCounts
    },
    recommendations: recommendations.slice(0, 5)
  };
}

function writeOutput(dateStr, payload) {
  ensureDir(OUTPUT_DIR);
  const fp = path.join(OUTPUT_DIR, `${dateStr}.json`);
  fs.writeFileSync(fp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return fp;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'run').trim().toLowerCase();
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    return;
  }

  const dateStr = resolveDate(args);
  const days = toInt(args.days, 14, 1, MAX_WINDOW_DAYS);
  const strict = args.strict === true;
  const write = String(args.write == null ? '1' : args.write).trim() !== '0';
  const payload = computeSimulation(dateStr, days);
  if (write && (cmd === 'run' || cmd === 'status')) {
    payload.report_path = writeOutput(dateStr, payload);
  }
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  if (strict && payload.verdict === 'fail') process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  computeSimulation,
  queueSnapshotForWindow
};
