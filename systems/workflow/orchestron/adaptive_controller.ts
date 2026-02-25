#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const {
  loadActiveStrategy,
  strategyMaxRiskPerAction,
  resolveStrategyRankingContext
} = require('../../../lib/strategy_resolver');
const { analyzeIntent } = require('./intent_analyzer');
const { generateCandidates } = require('./candidate_generator');
const { evaluateCandidates } = require('./nursery_tester');
const { runAdversarialLane } = require('./adversarial_lane');
const {
  nowIso,
  clampInt,
  clampNumber,
  cleanText,
  normalizeToken,
  stableId,
  toWorkflowDraft
} = require('./contracts');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_POLICY_PATH = path.join(REPO_ROOT, 'config', 'orchestron_policy.json');
const RUNS_DIR = process.env.ORCHESTRON_RUNS_DIR
  ? path.resolve(process.env.ORCHESTRON_RUNS_DIR)
  : path.join(REPO_ROOT, 'state', 'autonomy', 'runs');
const PRINCIPLES_LATEST_PATH = process.env.ORCHESTRON_PRINCIPLES_PATH
  ? path.resolve(process.env.ORCHESTRON_PRINCIPLES_PATH)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'strategy', 'principles', 'latest.json');
const REGISTRY_PATH = process.env.ORCHESTRON_REGISTRY_PATH
  ? path.resolve(process.env.ORCHESTRON_REGISTRY_PATH)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'registry.json');
const RED_TEAM_RUNTIME_PATH = process.env.ORCHESTRON_RED_TEAM_RUNTIME_PATH
  ? path.resolve(process.env.ORCHESTRON_RED_TEAM_RUNTIME_PATH)
  : path.join(REPO_ROOT, 'state', 'security', 'red_team', 'runtime_state.json');
const OUT_DIR = process.env.ORCHESTRON_OUT_DIR
  ? path.resolve(process.env.ORCHESTRON_OUT_DIR)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'orchestron');
const BIRTH_EVENTS_PATH = process.env.ORCHESTRON_BIRTH_EVENTS_PATH
  ? path.resolve(process.env.ORCHESTRON_BIRTH_EVENTS_PATH)
  : path.join(OUT_DIR, 'birth_events.jsonl');
const HISTORY_PATH = path.join(OUT_DIR, 'history.jsonl');
const LATEST_PATH = path.join(OUT_DIR, 'latest.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/workflow/orchestron/adaptive_controller.js run [YYYY-MM-DD] [--intent="..."] [--days=N] [--max-candidates=N] [--value-currency=<currency>] [--objective-id=<id>] [--policy=path]');
  console.log('  node systems/workflow/orchestron/adaptive_controller.js status [YYYY-MM-DD|latest]');
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

function dateArgOrToday(v) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
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
          const parsed = JSON.parse(line);
          return parsed && typeof parsed === 'object' ? parsed : null;
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

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(filePath) {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

function shiftDate(dateStr, deltaDays) {
  const base = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return dateStr;
  base.setUTCDate(base.getUTCDate() + Number(deltaDays || 0));
  return base.toISOString().slice(0, 10);
}

function windowDates(dateStr, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) out.push(shiftDate(dateStr, -i));
  return out;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    default_window_days: 14,
    min_pattern_occurrences: 2,
    min_candidates: 3,
    max_candidates: 8,
    max_promotions_per_run: 4,
    min_principle_score: 0.6,
    auto_apply: {
      enabled: false,
      min_promotable_drafts: 1,
      min_principle_score: 0.75,
      min_composite_score: 0.48,
      max_predicted_drift_delta: 0.004,
      min_predicted_yield_delta: 0,
      max_red_team_critical_fail_cases: 0,
      require_shadow_off: true
    },
    creative_llm: {
      enabled: false,
      model: 'qwen3:4b',
      timeout_ms: 2500,
      max_candidates: 3,
      primary_source: true,
      reserved_slots: 2,
      min_novelty_trit: 0,
      cache_ttl_ms: 600000
    },
    fractal: {
      enabled: true,
      max_depth: 3,
      max_children_per_workflow: 3,
      min_attempts_for_split: 4,
      min_failure_rate_for_split: 0.45,
      auto_depth_expansion: true,
      auto_depth_cap: 5,
      recurse_child_budget: 1,
      recurse_when_failure_min: 0.58,
      recurse_when_no_change_min: 0.5,
      recurse_when_uncertainty_min: 0.55,
      active_registry_soft_cap: 24
    },
    runtime_evolution: {
      enabled: true,
      max_candidates: 3,
      failure_pressure_min: 0.45,
      no_change_pressure_min: 0.35
    },
    telemetry: {
      emit_birth_events: true
    },
    adversarial_lane: {
      enabled: true,
      max_critical_failures_per_candidate: 0,
      max_non_critical_findings_per_candidate: 8,
      max_findings_per_candidate: 24,
      block_unresolved_placeholders: true,
      high_power_requires_preflight: true,
      high_power_requires_rollback: false,
      persist_replay_artifacts: true,
      unresolved_placeholder_allowlist: ['date', 'run_id', 'workflow_id', 'objective_id', 'eye_id', 'adapter']
    },
    nursery: {
      min_safety_score: 0.5,
      max_regression_risk: 0.56,
      min_composite_score: 0.45,
      max_predicted_drift_delta: 0.008,
      min_predicted_yield_delta: -0.005,
      min_trit_alignment: -0.7,
      max_candidate_red_team_pressure: 0.72,
      max_promotions_per_run: 4
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const nurserySrc = raw.nursery && typeof raw.nursery === 'object' ? raw.nursery : {};
  const autoApplySrc = raw.auto_apply && typeof raw.auto_apply === 'object' ? raw.auto_apply : {};
  const creativeSrc = raw.creative_llm && typeof raw.creative_llm === 'object' ? raw.creative_llm : {};
  const fractalSrc = raw.fractal && typeof raw.fractal === 'object' ? raw.fractal : {};
  const runtimeSrc = raw.runtime_evolution && typeof raw.runtime_evolution === 'object' ? raw.runtime_evolution : {};
  const telemetrySrc = raw.telemetry && typeof raw.telemetry === 'object' ? raw.telemetry : {};
  const adversarialSrc = raw.adversarial_lane && typeof raw.adversarial_lane === 'object' ? raw.adversarial_lane : {};
  return {
    version: String(raw.version || base.version),
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    default_window_days: clampInt(raw.default_window_days, 1, 90, base.default_window_days),
    min_pattern_occurrences: clampInt(raw.min_pattern_occurrences, 1, 10000, base.min_pattern_occurrences),
    min_candidates: clampInt(raw.min_candidates, 1, 24, base.min_candidates),
    max_candidates: clampInt(raw.max_candidates, 1, 24, base.max_candidates),
    max_promotions_per_run: clampInt(raw.max_promotions_per_run, 1, 24, base.max_promotions_per_run),
    min_principle_score: clampNumber(raw.min_principle_score, 0, 1, base.min_principle_score),
    auto_apply: {
      enabled: autoApplySrc.enabled === true,
      min_promotable_drafts: clampInt(autoApplySrc.min_promotable_drafts, 1, 64, base.auto_apply.min_promotable_drafts),
      min_principle_score: clampNumber(autoApplySrc.min_principle_score, 0, 1, base.auto_apply.min_principle_score),
      min_composite_score: clampNumber(autoApplySrc.min_composite_score, 0, 1, base.auto_apply.min_composite_score),
      max_predicted_drift_delta: clampNumber(autoApplySrc.max_predicted_drift_delta, -1, 1, base.auto_apply.max_predicted_drift_delta),
      min_predicted_yield_delta: clampNumber(autoApplySrc.min_predicted_yield_delta, -1, 1, base.auto_apply.min_predicted_yield_delta),
      max_red_team_critical_fail_cases: clampInt(autoApplySrc.max_red_team_critical_fail_cases, 0, 64, base.auto_apply.max_red_team_critical_fail_cases),
      require_shadow_off: autoApplySrc.require_shadow_off !== false
    },
    creative_llm: {
      enabled: creativeSrc.enabled === true,
      model: cleanText(creativeSrc.model || base.creative_llm.model, 80),
      timeout_ms: clampInt(creativeSrc.timeout_ms, 300, 30000, base.creative_llm.timeout_ms),
      max_candidates: clampInt(creativeSrc.max_candidates, 1, 12, base.creative_llm.max_candidates),
      primary_source: creativeSrc.primary_source !== false,
      reserved_slots: clampInt(creativeSrc.reserved_slots, 0, 12, base.creative_llm.reserved_slots),
      min_novelty_trit: clampInt(creativeSrc.min_novelty_trit, -1, 1, base.creative_llm.min_novelty_trit),
      cache_ttl_ms: clampInt(creativeSrc.cache_ttl_ms, 0, 24 * 60 * 60 * 1000, base.creative_llm.cache_ttl_ms),
      seed_candidates: Array.isArray(creativeSrc.seed_candidates) ? creativeSrc.seed_candidates.slice(0, 24) : []
    },
    fractal: {
      enabled: fractalSrc.enabled !== false,
      max_depth: clampInt(fractalSrc.max_depth, 1, 6, base.fractal.max_depth),
      max_children_per_workflow: clampInt(fractalSrc.max_children_per_workflow, 1, 8, base.fractal.max_children_per_workflow),
      min_attempts_for_split: clampInt(fractalSrc.min_attempts_for_split, 1, 100000, base.fractal.min_attempts_for_split),
      min_failure_rate_for_split: clampNumber(fractalSrc.min_failure_rate_for_split, 0, 1, base.fractal.min_failure_rate_for_split),
      auto_depth_expansion: fractalSrc.auto_depth_expansion !== false,
      auto_depth_cap: clampInt(fractalSrc.auto_depth_cap, 1, 8, base.fractal.auto_depth_cap),
      recurse_child_budget: clampInt(fractalSrc.recurse_child_budget, 0, 4, base.fractal.recurse_child_budget),
      recurse_when_failure_min: clampNumber(fractalSrc.recurse_when_failure_min, 0, 1, base.fractal.recurse_when_failure_min),
      recurse_when_no_change_min: clampNumber(fractalSrc.recurse_when_no_change_min, 0, 1, base.fractal.recurse_when_no_change_min),
      recurse_when_uncertainty_min: clampNumber(fractalSrc.recurse_when_uncertainty_min, 0, 1, base.fractal.recurse_when_uncertainty_min),
      active_registry_soft_cap: clampInt(fractalSrc.active_registry_soft_cap, 1, 500, base.fractal.active_registry_soft_cap)
    },
    runtime_evolution: {
      enabled: runtimeSrc.enabled !== false,
      max_candidates: clampInt(runtimeSrc.max_candidates, 0, 24, base.runtime_evolution.max_candidates),
      failure_pressure_min: clampNumber(runtimeSrc.failure_pressure_min, 0, 1, base.runtime_evolution.failure_pressure_min),
      no_change_pressure_min: clampNumber(runtimeSrc.no_change_pressure_min, 0, 1, base.runtime_evolution.no_change_pressure_min)
    },
    telemetry: {
      emit_birth_events: telemetrySrc.emit_birth_events !== false
    },
    adversarial_lane: {
      enabled: adversarialSrc.enabled !== false,
      max_critical_failures_per_candidate: clampInt(
        adversarialSrc.max_critical_failures_per_candidate,
        0,
        64,
        base.adversarial_lane.max_critical_failures_per_candidate
      ),
      max_non_critical_findings_per_candidate: clampInt(
        adversarialSrc.max_non_critical_findings_per_candidate,
        0,
        128,
        base.adversarial_lane.max_non_critical_findings_per_candidate
      ),
      max_findings_per_candidate: clampInt(
        adversarialSrc.max_findings_per_candidate,
        1,
        256,
        base.adversarial_lane.max_findings_per_candidate
      ),
      block_unresolved_placeholders: adversarialSrc.block_unresolved_placeholders !== false,
      high_power_requires_preflight: adversarialSrc.high_power_requires_preflight !== false,
      high_power_requires_rollback: adversarialSrc.high_power_requires_rollback === true,
      persist_replay_artifacts: adversarialSrc.persist_replay_artifacts !== false,
      unresolved_placeholder_allowlist: Array.isArray(adversarialSrc.unresolved_placeholder_allowlist)
        ? adversarialSrc.unresolved_placeholder_allowlist
          .map((row) => normalizeToken(row, 60))
          .filter(Boolean)
          .slice(0, 32)
        : base.adversarial_lane.unresolved_placeholder_allowlist.slice(0, 32)
    },
    nursery: {
      min_safety_score: clampNumber(nurserySrc.min_safety_score, 0, 1, base.nursery.min_safety_score),
      max_regression_risk: clampNumber(nurserySrc.max_regression_risk, 0, 1, base.nursery.max_regression_risk),
      min_composite_score: clampNumber(nurserySrc.min_composite_score, 0, 1, base.nursery.min_composite_score),
      max_predicted_drift_delta: clampNumber(nurserySrc.max_predicted_drift_delta, -1, 1, base.nursery.max_predicted_drift_delta),
      min_predicted_yield_delta: clampNumber(nurserySrc.min_predicted_yield_delta, -1, 1, base.nursery.min_predicted_yield_delta),
      min_trit_alignment: clampNumber(nurserySrc.min_trit_alignment, -1, 1, base.nursery.min_trit_alignment),
      max_candidate_red_team_pressure: clampNumber(nurserySrc.max_candidate_red_team_pressure, 0, 1, base.nursery.max_candidate_red_team_pressure),
      max_promotions_per_run: clampInt(nurserySrc.max_promotions_per_run, 1, 24, base.nursery.max_promotions_per_run)
    }
  };
}

function emitBirthEvent(policy, row) {
  if (!policy || !policy.telemetry || policy.telemetry.emit_birth_events !== true) return;
  appendJsonl(BIRTH_EVENTS_PATH, row);
}

function flattenCandidateNodes(candidates, maxDepth = 6) {
  const out = [];
  const queue = [];
  for (const row of Array.isArray(candidates) ? candidates : []) {
    if (!row || typeof row !== 'object') continue;
    queue.push({
      node: row,
      parent_candidate_id: row.parent_workflow_id || null,
      depth: Number(row.fractal_depth || 0)
    });
  }
  while (queue.length) {
    const current = queue.shift();
    if (!current || !current.node || typeof current.node !== 'object') continue;
    out.push(current);
    if (Number(current.depth || 0) >= Number(maxDepth || 6)) continue;
    const children = Array.isArray(current.node.children) ? current.node.children : [];
    for (const child of children) {
      if (!child || typeof child !== 'object') continue;
      queue.push({
        node: child,
        parent_candidate_id: current.node.id || current.parent_candidate_id || null,
        depth: Number(current.depth || 0) + 1
      });
    }
  }
  return out;
}

function defaultPatternStats(scopeValue) {
  return {
    proposal_type: scopeValue,
    attempts: 0,
    executed: 0,
    shipped: 0,
    no_change: 0,
    holds: 0,
    stops: 0,
    recent_objective_id: null
  };
}

function isPolicyHold(result) {
  const r = String(result || '').trim().toLowerCase();
  if (!r) return false;
  return r === 'policy_hold'
    || r.startsWith('no_candidates_policy_')
    || r.startsWith('stop_init_gate_')
    || r.startsWith('stop_repeat_gate_');
}

function collectPatternStats(dateStr, days, minOccurrences) {
  const byType = {};
  let runRows = 0;
  for (const day of windowDates(dateStr, days)) {
    for (const row of readJsonl(path.join(RUNS_DIR, `${day}.jsonl`))) {
      if (String(row && row.type || '') !== 'autonomy_run') continue;
      runRows += 1;
      const proposalType = normalizeToken(row.proposal_type || 'unknown', 100) || 'unknown';
      if (!byType[proposalType]) byType[proposalType] = defaultPatternStats(proposalType);
      const bucket = byType[proposalType];
      bucket.attempts += 1;
      const result = String(row.result || '').trim().toLowerCase();
      const outcome = String(row.outcome || '').trim().toLowerCase();
      if (result === 'executed') bucket.executed += 1;
      if (outcome === 'shipped') bucket.shipped += 1;
      if (outcome === 'no_change') bucket.no_change += 1;
      if (isPolicyHold(result)) bucket.holds += 1;
      if (result.startsWith('stop_')) bucket.stops += 1;
      if (row.objective_id) bucket.recent_objective_id = String(row.objective_id);
    }
  }
  const rows = Object.values(byType).filter((row) => Number(row.attempts || 0) >= Number(minOccurrences || 1));
  return { run_rows: runRows, rows };
}

function loadPrincipleSnapshot() {
  const payload = readJson(PRINCIPLES_LATEST_PATH, null);
  const summary = payload && payload.summary && typeof payload.summary === 'object' ? payload.summary : {};
  const score = clampNumber(summary.score, 0, 1, 0.5);
  const ids = Array.isArray(payload && payload.principles)
    ? payload.principles.filter((row) => row && row.pass === true).map((row) => String(row.id || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  return {
    available: !!payload,
    score,
    band: String(summary.band || 'unknown'),
    ids
  };
}

function loadRegistryWorkflows() {
  const payload = readJson(REGISTRY_PATH, {});
  const workflows = Array.isArray(payload && payload.workflows) ? payload.workflows : [];
  return workflows.filter((row) => row && typeof row === 'object');
}

function loadRedTeamSnapshot() {
  const payload = readJson(RED_TEAM_RUNTIME_PATH, null);
  if (!payload || typeof payload !== 'object') {
    return {
      available: false,
      ok: true,
      summary: null,
      critical_fail_cases: 0
    };
  }
  const summary = payload.summary && typeof payload.summary === 'object' ? payload.summary : null;
  const critical = Number(
    payload.critical_fail_cases
      || (summary && summary.critical_fail_cases)
      || 0
  );
  return {
    available: true,
    ok: payload.ok !== false,
    summary,
    critical_fail_cases: critical
  };
}

function generateAdaptiveDrafts(dateStr, opts = {}) {
  const policyPath = path.resolve(String(opts.policyPath || process.env.ORCHESTRON_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = opts.policy && typeof opts.policy === 'object' ? opts.policy : loadPolicy(policyPath);
  const days = clampInt(opts.days, 1, 90, policy.default_window_days);
  const runId = stableId(`${dateStr}|${opts.intent || ''}|${Date.now()}`, 'orcrun', 14);
  if (policy.enabled === false) {
    return {
      ok: true,
      skipped: true,
      reason: 'policy_disabled',
      date: dateStr,
      run_id: runId,
      policy,
      policy_path: relPath(policyPath),
      drafts: [],
      scorecards: []
    };
  }

  const strategy = loadActiveStrategy({ allowMissing: true }) || {};
  const strategyId = String(strategy.id || 'unknown');
  const objectivePrimary = cleanText(
    (strategy.objective && strategy.objective.primary)
      || 'Generate adaptive workflows that improve outcome quality under governance constraints.',
    260
  );
  const intent = analyzeIntent(opts.intent || '', {
    strategy,
    source: 'orchestron_adaptive_controller'
  });
  emitBirthEvent(policy, {
    ts: nowIso(),
    type: 'orchestron_birth_event',
    stage: 'intent_analyzed',
    run_id: runId,
    date: dateStr,
    strategy_id: strategyId,
    intent_id: intent.id,
    objective: intent.objective
  });
  const patternStats = collectPatternStats(dateStr, days, policy.min_pattern_occurrences);
  const objectiveHint = cleanText(
    opts.objectiveId
      || (patternStats.rows.find((row) => row && row.recent_objective_id) || {}).recent_objective_id
      || '',
    120
  ) || null;
  const requestedValueCurrency = normalizeToken(opts.valueCurrency || '', 40) || null;
  const valueContext = resolveStrategyRankingContext(strategy, {
    objective_id: objectiveHint,
    value_currency: requestedValueCurrency
  });
  const principles = loadPrincipleSnapshot();
  const registry = loadRegistryWorkflows();
  const redTeam = loadRedTeamSnapshot();
  emitBirthEvent(policy, {
    ts: nowIso(),
    type: 'orchestron_birth_event',
    stage: 'context_collected',
    run_id: runId,
    date: dateStr,
    strategy_id: strategyId,
    pattern_rows: patternStats.rows.length,
    registry_workflows: registry.length
  });

  const riskPolicy = {
    max_risk_per_action: clampInt(strategyMaxRiskPerAction(strategy, 35), 1, 100, 35),
    allowed_risks: Array.isArray(strategy.risk_policy && strategy.risk_policy.allowed_risks)
      ? strategy.risk_policy.allowed_risks.slice(0, 4)
      : ['low']
  };

  const candidates = generateCandidates({
    date: dateStr,
    strategy_id: strategyId,
    objective_primary: objectivePrimary,
    intent,
    value_context: valueContext,
    risk_policy: riskPolicy,
    pattern_rows: patternStats.rows,
    registry_workflows: registry,
    min_candidates: policy.min_candidates,
    max_candidates: clampInt(opts.maxCandidates, 1, 24, policy.max_candidates),
    creative_llm: policy.creative_llm,
    fractal: policy.fractal,
    runtime_evolution: policy.runtime_evolution
  });
  const fractalChildren = candidates.reduce((sum, row) => (
    sum + (Array.isArray(row && row.children) ? row.children.length : 0)
  ), 0);
  emitBirthEvent(policy, {
    ts: nowIso(),
    type: 'orchestron_birth_event',
    stage: 'candidates_generated',
    run_id: runId,
    date: dateStr,
    strategy_id: strategyId,
    candidates: candidates.length,
    fractal_children: fractalChildren
  });
  for (const node of flattenCandidateNodes(candidates, policy.fractal.max_depth).slice(0, 96)) {
    emitBirthEvent(policy, {
      ts: nowIso(),
      type: 'orchestron_birth_event',
      stage: 'candidate_indexed',
      run_id: runId,
      date: dateStr,
      strategy_id: strategyId,
      candidate_id: node.node && node.node.id ? String(node.node.id) : null,
      parent_candidate_id: node.parent_candidate_id || null,
      fractal_depth: Number(node.depth || 0),
      proposal_type: node.node && node.node.trigger ? node.node.trigger.proposal_type || null : null,
      mutation_kind: node.node && node.node.mutation ? node.node.mutation.kind || 'none' : 'none'
    });
  }

  const adversarial = runAdversarialLane({
    date: dateStr,
    run_id: runId,
    candidates,
    max_depth: policy.fractal.max_depth,
    policy: policy.adversarial_lane
  });
  emitBirthEvent(policy, {
    ts: nowIso(),
    type: 'orchestron_birth_event',
    stage: 'adversarial_scored',
    run_id: runId,
    date: dateStr,
    strategy_id: strategyId,
    probes_run: Number(adversarial && adversarial.probes_run || 0),
    candidates_failed: Number(adversarial && adversarial.candidates_failed || 0),
    critical_failures: Number(adversarial && adversarial.critical_failures || 0)
  });
  for (const row of (Array.isArray(adversarial && adversarial.results) ? adversarial.results : []).slice(0, 96)) {
    emitBirthEvent(policy, {
      ts: nowIso(),
      type: 'orchestron_birth_event',
      stage: 'candidate_adversarial',
      run_id: runId,
      date: dateStr,
      strategy_id: strategyId,
      candidate_id: row && row.candidate_id ? String(row.candidate_id) : null,
      parent_candidate_id: row && row.parent_candidate_id ? String(row.parent_candidate_id) : null,
      fractal_depth: Number(row && row.depth || 0),
      critical_failures: Number(row && row.critical_failures || 0),
      non_critical_findings: Number(row && row.non_critical_findings || 0),
      pass: row && row.pass === true
    });
  }

  const nursery = evaluateCandidates({
    candidates,
    pattern_rows: patternStats.rows,
    value_context: valueContext,
    principle_snapshot: principles,
    red_team: redTeam,
    adversarial_results: Array.isArray(adversarial && adversarial.results) ? adversarial.results : [],
    policy: {
      ...policy.nursery,
      max_candidate_adversarial_critical_failures: Number(
        policy.adversarial_lane && policy.adversarial_lane.max_critical_failures_per_candidate
      ),
      max_candidate_adversarial_non_critical_findings: Number(
        policy.adversarial_lane && policy.adversarial_lane.max_non_critical_findings_per_candidate
      ),
      max_promotions_per_run: policy.max_promotions_per_run
    }
  });
  emitBirthEvent(policy, {
    ts: nowIso(),
    type: 'orchestron_birth_event',
    stage: 'nursery_scored',
    run_id: runId,
    date: dateStr,
    strategy_id: strategyId,
    scorecards: Array.isArray(nursery.scorecards) ? nursery.scorecards.length : 0,
    passing: Array.isArray(nursery.passing) ? nursery.passing.length : 0
  });
  for (const row of (Array.isArray(nursery.passing) ? nursery.passing : []).slice(0, 48)) {
    const candidate = row && row.candidate && typeof row.candidate === 'object' ? row.candidate : {};
    const scorecard = row && row.scorecard && typeof row.scorecard === 'object' ? row.scorecard : {};
    emitBirthEvent(policy, {
      ts: nowIso(),
      type: 'orchestron_birth_event',
      stage: 'graft_planned',
      run_id: runId,
      date: dateStr,
      strategy_id: strategyId,
      candidate_id: candidate && candidate.id ? String(candidate.id) : null,
      parent_candidate_id: row && row.parent_candidate_id ? String(row.parent_candidate_id) : null,
      fractal_depth: Number(row && row.depth || candidate && candidate.fractal_depth || 0),
      proposal_type: candidate && candidate.trigger ? candidate.trigger.proposal_type || null : null,
      mutation_kind: candidate && candidate.mutation ? candidate.mutation.kind || 'none' : 'none',
      trit_alignment: Number(scorecard && scorecard.trit_alignment || 0),
      composite_score: Number(scorecard && scorecard.composite_score || 0),
      predicted_drift_delta: Number(scorecard && scorecard.predicted_drift_delta || 0),
      predicted_yield_delta: Number(scorecard && scorecard.predicted_yield_delta || 0)
    });
  }

  const scoreById = new Map((Array.isArray(nursery.scorecards) ? nursery.scorecards : []).map((row) => [String(row.candidate_id || ''), row]));
  const gatedPassing = [];
  for (const row of Array.isArray(nursery.passing) ? nursery.passing : []) {
    if (!row || !row.candidate) continue;
    if (Number(principles.score || 0) < Number(policy.min_principle_score || 0.6)) continue;
    gatedPassing.push(row);
  }

  const drafts = candidates.map((candidate) => {
    const scorecard = scoreById.get(String(candidate && candidate.id || '')) || null;
    return toWorkflowDraft(candidate, scorecard, {
      principles,
      score_lookup: scoreById,
      max_depth: policy.fractal.max_depth
    });
  });
  drafts.sort((a, b) => Number(b.metrics && b.metrics.score || 0) - Number(a.metrics && a.metrics.score || 0));
  const promotableDrafts = gatedPassing
    .map((row) => toWorkflowDraft(row.candidate, row.scorecard, {
      principles,
      score_lookup: scoreById,
      max_depth: policy.fractal.max_depth
    }))
    .sort((a, b) => Number(b.metrics && b.metrics.score || 0) - Number(a.metrics && a.metrics.score || 0));
  emitBirthEvent(policy, {
    ts: nowIso(),
    type: 'orchestron_birth_event',
    stage: 'drafts_built',
    run_id: runId,
    date: dateStr,
    strategy_id: strategyId,
    drafts: drafts.length,
    promotable_drafts: promotableDrafts.length
  });
  if (promotableDrafts.length) {
    emitBirthEvent(policy, {
      ts: nowIso(),
      type: 'orchestron_birth_event',
      stage: 'graft_ready',
      run_id: runId,
      date: dateStr,
      strategy_id: strategyId,
      promotable_drafts: promotableDrafts.length
    });
    emitBirthEvent(policy, {
      ts: nowIso(),
      type: 'orchestron_birth_event',
      stage: 'grafted',
      run_id: runId,
      date: dateStr,
      strategy_id: strategyId,
      promotable_drafts: promotableDrafts.length
    });
  }

  return {
    ok: true,
    type: 'orchestron_adaptive_run',
    ts: nowIso(),
    run_id: runId,
    date: dateStr,
    days,
    policy,
    policy_path: relPath(policyPath),
    birth_events_path: relPath(BIRTH_EVENTS_PATH),
    strategy_id: strategyId,
    value_context: valueContext,
    objective_primary: objectivePrimary,
    intent,
    run_rows: patternStats.run_rows,
    pattern_rows: patternStats.rows.length,
    principles,
    red_team: redTeam,
    adversarial: {
      probes_run: Number(adversarial && adversarial.probes_run || 0),
      candidates_failed: Number(adversarial && adversarial.candidates_failed || 0),
      critical_failures: Number(adversarial && adversarial.critical_failures || 0),
      non_critical_findings: Number(adversarial && adversarial.non_critical_findings || 0),
      results: Array.isArray(adversarial && adversarial.results) ? adversarial.results.slice(0, 256) : []
    },
    candidates,
    scorecards: Array.isArray(nursery.scorecards) ? nursery.scorecards : [],
    passing: gatedPassing.map((row) => ({
      candidate_id: row.candidate.id,
      scorecard: row.scorecard
    })),
    drafts,
    promotable_drafts: promotableDrafts
  };
}

function persistRun(result) {
  const dateStr = String(result && result.date || nowIso().slice(0, 10));
  const fp = path.join(OUT_DIR, `${dateStr}.json`);
  writeJsonAtomic(fp, result);
  writeJsonAtomic(LATEST_PATH, result);
  appendJsonl(HISTORY_PATH, {
    ts: result.ts || nowIso(),
    type: result.type || 'orchestron_adaptive_run',
    run_id: result.run_id || null,
    date: dateStr,
    strategy_id: result.strategy_id || null,
    run_rows: Number(result.run_rows || 0),
    candidates: Array.isArray(result.candidates) ? result.candidates.length : 0,
    passing: Array.isArray(result.passing) ? result.passing.length : 0,
    drafts: Array.isArray(result.drafts) ? result.drafts.length : 0,
    promotable_drafts: Array.isArray(result.promotable_drafts) ? result.promotable_drafts.length : 0,
    red_team_critical_fail_cases: Number(result.red_team && result.red_team.critical_fail_cases || 0),
    adversarial_probes_run: Number(result.adversarial && result.adversarial.probes_run || 0),
    adversarial_candidates_failed: Number(result.adversarial && result.adversarial.candidates_failed || 0),
    adversarial_critical_failures: Number(result.adversarial && result.adversarial.critical_failures || 0),
    principle_score: Number(result.principles && result.principles.score || 0)
  });
  return fp;
}

function runCmd(dateStr, args) {
  const payload = generateAdaptiveDrafts(dateStr, {
    policyPath: args.policy,
    days: args.days,
    maxCandidates: args['max-candidates'],
    intent: args.intent,
    valueCurrency: args['value-currency'],
    objectiveId: args['objective-id']
  });
  const fp = persistRun(payload);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: payload.type,
    run_id: payload.run_id || null,
    date: payload.date,
    run_rows: Number(payload.run_rows || 0),
    candidates: Array.isArray(payload.candidates) ? payload.candidates.length : 0,
    passing: Array.isArray(payload.passing) ? payload.passing.length : 0,
    drafts: Array.isArray(payload.drafts) ? payload.drafts.length : 0,
    promotable_drafts: Array.isArray(payload.promotable_drafts) ? payload.promotable_drafts.length : 0,
    adversarial_probes_run: Number(payload.adversarial && payload.adversarial.probes_run || 0),
    adversarial_candidates_failed: Number(payload.adversarial && payload.adversarial.candidates_failed || 0),
    adversarial_critical_failures: Number(payload.adversarial && payload.adversarial.critical_failures || 0),
    value_currency: payload && payload.value_context ? payload.value_context.value_currency || null : null,
    birth_events_path: payload.birth_events_path || null,
    policy_path: payload.policy_path,
    output_path: relPath(fp)
  })}\n`);
}

function statusCmd(dateArg) {
  const useLatest = String(dateArg || '').trim().toLowerCase() === 'latest';
  const fp = useLatest ? LATEST_PATH : path.join(OUT_DIR, `${dateArgOrToday(dateArg)}.json`);
  const payload = readJson(fp, null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'orchestron_adaptive_status',
      error: 'orchestron_snapshot_missing'
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'orchestron_adaptive_status',
    date: payload.date || null,
    ts: payload.ts || null,
    run_id: payload.run_id || null,
    strategy_id: payload.strategy_id || null,
    value_currency: payload && payload.value_context ? payload.value_context.value_currency || null : null,
    run_rows: Number(payload.run_rows || 0),
    candidates: Array.isArray(payload.candidates) ? payload.candidates.length : 0,
    passing: Array.isArray(payload.passing) ? payload.passing.length : 0,
    drafts: Array.isArray(payload.drafts) ? payload.drafts.length : 0,
    promotable_drafts: Array.isArray(payload.promotable_drafts) ? payload.promotable_drafts.length : 0,
    adversarial_probes_run: Number(payload.adversarial && payload.adversarial.probes_run || 0),
    adversarial_candidates_failed: Number(payload.adversarial && payload.adversarial.candidates_failed || 0),
    adversarial_critical_failures: Number(payload.adversarial && payload.adversarial.critical_failures || 0)
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
  if (cmd === 'status') return statusCmd(args._[1] || 'latest');
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'orchestron_adaptive_controller',
      error: String(err && err.message ? err.message : err || 'orchestron_failed')
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  generateAdaptiveDrafts
};
