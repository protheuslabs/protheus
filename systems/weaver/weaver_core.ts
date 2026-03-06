#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/weaver/weaver_core.js
 *
 * Metric-agnostic value arbitration with monoculture protection.
 *
 * Usage:
 *   node systems/weaver/weaver_core.js run [YYYY-MM-DD] [--policy=path] [--objective-id=<id>] [--value-metrics=<csv|json>] [--value-currency=<currency>] [--primary-metric=<id>] [--apply=1|0] [--dry-run=1|0] [--source=<id>]
 *   node systems/weaver/weaver_core.js status [latest|YYYY-MM-DD]
 */

const fs = require('fs');
const path = require('path');
const { loadActiveStrategy } = require('../../lib/strategy_resolver');
const { loadDynamicBurnOracleSignal } = require('../../lib/dynamic_burn_budget_signal');
const { buildMetricSchema } = require('./metric_schema');
const { arbitrateMetrics, buildStrategyOverlayFromAllocation } = require('./arbitration_engine');
const { applyMonocultureGuard } = require('./monoculture_guard');
let runEthicalReasoning = null;
try {
  ({ runEthicalReasoning } = require('../autonomy/ethical_reasoning_organ.js'));
} catch {
  runEthicalReasoning = null;
}
let decideBrainRoute = null;
try {
  ({ decideBrainRoute } = require('../dual_brain/coordinator.js'));
} catch {
  decideBrainRoute = null;
}
let evaluateWorkflowDraft = null;
try {
  ({ evaluateWorkflowDraft } = require('../identity/identity_anchor.js'));
} catch {
  evaluateWorkflowDraft = null;
}
let evaluateDirectiveTask = null;
try {
  ({ evaluateTask: evaluateDirectiveTask } = require('../security/directive_gate.js'));
} catch {
  evaluateDirectiveTask = null;
}
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
let runLongHorizonPlanning = null;
try {
  ({ runLongHorizonPlanning } = require('../primitives/long_horizon_planning_primitive.js'));
} catch {
  runLongHorizonPlanning = null;
}
let runMultiAgentDebate = null;
try {
  ({ runMultiAgentDebate } = require('../autonomy/multi_agent_debate_orchestrator.js'));
} catch {
  runMultiAgentDebate = null;
}

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'weaver_policy.json');
const DEFAULT_STATE_DIR = path.join(ROOT, 'state', 'autonomy', 'weaver');
const DEFAULT_RUNS_DIR = path.join(DEFAULT_STATE_DIR, 'runs');
const DEFAULT_EVENTS_PATH = path.join(DEFAULT_STATE_DIR, 'events.jsonl');
const DEFAULT_HISTORY_PATH = path.join(DEFAULT_STATE_DIR, 'history.jsonl');
const DEFAULT_LATEST_PATH = path.join(DEFAULT_STATE_DIR, 'latest.json');
const DEFAULT_ACTIVE_OVERLAY_PATH = path.join(DEFAULT_STATE_DIR, 'strategy_overlay.json');
const DEFAULT_PREVIEW_OVERLAY_PATH = path.join(DEFAULT_STATE_DIR, 'strategy_overlay.preview.json');
const DEFAULT_PATHWAY_STATE_PATH = path.join(DEFAULT_STATE_DIR, 'pathway_state.json');
const DEFAULT_OBSIDIAN_QUEUE_PATH = path.join(DEFAULT_STATE_DIR, 'obsidian_projection.jsonl');
const DEFAULT_AXIS_LEDGER_PATH = path.join(DEFAULT_STATE_DIR, 'value_axis_switches.jsonl');
const DEFAULT_METRIC_ADAPTERS_PATH = path.join(ROOT, 'config', 'value_metric_adapters.json');

const DEFAULT_REGIME_LATEST_PATH = path.join(ROOT, 'state', 'autonomy', 'fractal', 'regime', 'latest.json');
const DEFAULT_MIRROR_LATEST_PATH = path.join(ROOT, 'state', 'autonomy', 'mirror_organ', 'latest.json');
const DEFAULT_AUTOPAUSE_PATH = path.join(ROOT, 'state', 'autonomy', 'budget_autopause.json');
const DEFAULT_BURN_ORACLE_LATEST_PATH = path.join(ROOT, 'state', 'ops', 'dynamic_burn_budget_oracle', 'latest.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/weaver/weaver_core.js run [YYYY-MM-DD] [--policy=path] [--objective-id=<id>] [--value-metrics=<csv|json>] [--value-currency=<currency>] [--primary-metric=<id>] [--apply=1|0] [--dry-run=1|0] [--source=<id>]');
  console.log('  node systems/weaver/weaver_core.js status [latest|YYYY-MM-DD]');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
      continue;
    }
    const key = tok.slice(2);
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

function nowIso() {
  return new Date().toISOString();
}

function toDate(v: unknown) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
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

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 80) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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

function readJsonl(filePath: string) {
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

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function parseMetricInput(raw: unknown) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  const text = String(raw || '').trim();
  if (!text) return null;
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function objectiveMetricImpact(objectiveId: string, objectiveText: string) {
  const id = normalizeToken(objectiveId, 120);
  const blob = `${id} ${String(objectiveText || '').toLowerCase()}`;
  const out: AnyObj = {};
  if (/(billion|revenue|income|profit|cash|sales)/.test(blob)) out.revenue = 0.8;
  if (/(quality|safe|safety|stable|truth|reliable)/.test(blob)) out.quality = 0.8;
  if (/(time|faster|speed|latency|efficiency|freedom)/.test(blob)) out.time_savings = 0.75;
  if (/(learn|wisdom|knowledge|research|principle)/.test(blob)) out.learning = 0.75;
  if (/(user|impact|help|joy|beauty|creative|hero)/.test(blob)) out.user_value = 0.75;
  if (/(ship|deliver|execute|throughput)/.test(blob)) out.delivery = 0.7;
  if (!Object.keys(out).length) out.adaptive_value = 0.6;
  return out;
}

function runtimePaths(policyPath: string) {
  const stateDir = process.env.WEAVER_STATE_DIR
    ? path.resolve(process.env.WEAVER_STATE_DIR)
    : DEFAULT_STATE_DIR;
  const defaultRunsDir = path.join(stateDir, 'runs');
  const defaultEventsPath = path.join(stateDir, 'events.jsonl');
  const defaultHistoryPath = path.join(stateDir, 'history.jsonl');
  const defaultLatestPath = path.join(stateDir, 'latest.json');
  const defaultActiveOverlayPath = path.join(stateDir, 'strategy_overlay.json');
  const defaultPreviewOverlayPath = path.join(stateDir, 'strategy_overlay.preview.json');
  const defaultPathwayStatePath = path.join(stateDir, 'pathway_state.json');
  const defaultObsidianQueuePath = path.join(stateDir, 'obsidian_projection.jsonl');
  const defaultAxisLedgerPath = path.join(stateDir, 'value_axis_switches.jsonl');
  return {
    policy_path: policyPath,
    state_dir: stateDir,
    runs_dir: process.env.WEAVER_RUNS_DIR ? path.resolve(process.env.WEAVER_RUNS_DIR) : defaultRunsDir,
    events_path: process.env.WEAVER_EVENTS_PATH ? path.resolve(process.env.WEAVER_EVENTS_PATH) : defaultEventsPath,
    history_path: process.env.WEAVER_HISTORY_PATH ? path.resolve(process.env.WEAVER_HISTORY_PATH) : defaultHistoryPath,
    latest_path: process.env.WEAVER_LATEST_PATH ? path.resolve(process.env.WEAVER_LATEST_PATH) : defaultLatestPath,
    active_overlay_path: process.env.WEAVER_ACTIVE_OVERLAY_PATH ? path.resolve(process.env.WEAVER_ACTIVE_OVERLAY_PATH) : defaultActiveOverlayPath,
    preview_overlay_path: process.env.WEAVER_PREVIEW_OVERLAY_PATH ? path.resolve(process.env.WEAVER_PREVIEW_OVERLAY_PATH) : defaultPreviewOverlayPath,
    pathway_state_path: process.env.WEAVER_PATHWAY_STATE_PATH ? path.resolve(process.env.WEAVER_PATHWAY_STATE_PATH) : defaultPathwayStatePath,
    obsidian_queue_path: process.env.WEAVER_OBSIDIAN_QUEUE_PATH ? path.resolve(process.env.WEAVER_OBSIDIAN_QUEUE_PATH) : defaultObsidianQueuePath,
    axis_ledger_path: process.env.WEAVER_AXIS_LEDGER_PATH ? path.resolve(process.env.WEAVER_AXIS_LEDGER_PATH) : defaultAxisLedgerPath,
    regime_latest_path: process.env.WEAVER_REGIME_LATEST_PATH ? path.resolve(process.env.WEAVER_REGIME_LATEST_PATH) : DEFAULT_REGIME_LATEST_PATH,
    mirror_latest_path: process.env.WEAVER_MIRROR_LATEST_PATH ? path.resolve(process.env.WEAVER_MIRROR_LATEST_PATH) : DEFAULT_MIRROR_LATEST_PATH,
    autopause_path: process.env.WEAVER_AUTOPAUSE_PATH ? path.resolve(process.env.WEAVER_AUTOPAUSE_PATH) : DEFAULT_AUTOPAUSE_PATH,
    burn_oracle_latest_path: process.env.WEAVER_BURN_ORACLE_LATEST_PATH
      ? path.resolve(process.env.WEAVER_BURN_ORACLE_LATEST_PATH)
      : DEFAULT_BURN_ORACLE_LATEST_PATH
  };
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: false,
    allow_apply: true,
    metric_schema: {
      include_builtin_metrics: true,
      min_metric_weight: 0.04,
      default_primary_metric: 'adaptive_value',
      extra_metrics: []
    },
    arbitration: {
      floor_share: 0.04,
      soft_caps: [],
      max_uncertainty_exploration_share: 0.35,
      exploration_uncertainty_threshold: 0.7,
      block_unsafe_high_reward: false,
      unsafe_high_reward_impact_threshold: 0.82,
      unsafe_high_reward_drift_threshold: 0.45,
      max_unsafe_high_reward_share: 0.15,
      currency_profiles: {},
      ranking_profiles: {},
      weights: {
        impact: 1.2,
        confidence: 1.05,
        uncertainty: 0.35,
        drift_risk: 1.15,
        cost_pressure: 1.0,
        mirror_pressure: 0.8,
        regime_alignment: 0.45
      }
    },
    monoculture_guard: {
      enabled: true,
      window_days: 21,
      max_single_metric_share: 0.68,
      metric_caps: {},
      currency_caps: {}
    },
    constitutional_veto: {
      enabled: true,
      deny_on_directive_decision: ['deny'],
      deny_on_identity_block: true,
      fallback_block_on_error: true,
      value_sovereignty: {
        enabled: true,
        min_combined_share: 0.24,
        protected_metric_ids: ['adaptive_value', 'user_value', 'quality'],
        protected_value_currencies: ['user_value', 'quality', 'learning']
      }
    },
    creative_routing: {
      enabled: true,
      prefer_right_for_metric_ids: ['joy', 'beauty', 'learning', 'truth_seeking', 'creative', 'play'],
      prefer_right_for_currencies: ['learning', 'user_value'],
      task_class_default: 'general',
      task_class_creative: 'creative',
      persist_decisions: false
    },
    pathways: {
      enabled: true,
      min_share_for_active: 0.08,
      dormant_after_days: 14,
      archive_candidate_after_days: 60,
      atrophy_gain_per_day: 0.03
    },
    outputs: {
      emit_events: true,
      write_preview_overlay: true,
      emit_ide_events: true,
      emit_obsidian_projection: true
    },
    advisory_primitives: {
      long_horizon_planning_enabled: true,
      multi_agent_debate_enabled: true
    }
  };
}

function loadPolicy(policyPath: string) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const metricSchema = raw.metric_schema && typeof raw.metric_schema === 'object' ? raw.metric_schema : {};
  const arbitration = raw.arbitration && typeof raw.arbitration === 'object' ? raw.arbitration : {};
  const guard = raw.monoculture_guard && typeof raw.monoculture_guard === 'object' ? raw.monoculture_guard : {};
  const veto = raw.constitutional_veto && typeof raw.constitutional_veto === 'object' ? raw.constitutional_veto : {};
  const creative = raw.creative_routing && typeof raw.creative_routing === 'object' ? raw.creative_routing : {};
  const pathways = raw.pathways && typeof raw.pathways === 'object' ? raw.pathways : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const advisoryPrimitives = raw.advisory_primitives && typeof raw.advisory_primitives === 'object'
    ? raw.advisory_primitives
    : {};
  const legacyRevenueCap = clampNumber(
    arbitration.revenue_soft_cap_share,
    0.2,
    0.95,
    base.monoculture_guard.max_single_metric_share
  );
  const hasLegacyRevenueCap = Number.isFinite(Number(arbitration.revenue_soft_cap_share));
  const normalizeCaps = (src: unknown, fallback: AnyObj = {}) => {
    const out: AnyObj = {};
    const obj = src && typeof src === 'object' ? src : fallback;
    for (const [kRaw, vRaw] of Object.entries(obj || {})) {
      const k = normalizeToken(kRaw, 80);
      if (!k) continue;
      out[k] = clampNumber(vRaw, 0.3, 0.95, base.monoculture_guard.max_single_metric_share);
    }
    return out;
  };
  const softCaps = Array.isArray(arbitration.soft_caps)
    ? arbitration.soft_caps
      .map((rowRaw: unknown) => {
        const row = rowRaw && typeof rowRaw === 'object' ? rowRaw as AnyObj : {};
        const metricId = normalizeToken(row.metric_id || '', 80) || null;
        const valueCurrency = normalizeToken(row.value_currency || '', 80) || null;
        if (!metricId && !valueCurrency) return null;
        return {
          metric_id: metricId,
          value_currency: valueCurrency,
          max_share: clampNumber(row.max_share, 0.2, 0.95, 0.68)
        };
      })
      .filter(Boolean)
      .slice(0, 24)
    : [];
  if (!softCaps.length && hasLegacyRevenueCap) {
    softCaps.push({
      metric_id: null,
      value_currency: 'revenue',
      max_share: legacyRevenueCap
    });
  }
  return {
    version: cleanText(raw.version || base.version, 32) || '1.0',
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only === true,
    allow_apply: raw.allow_apply !== false,
    metric_schema: {
      include_builtin_metrics: metricSchema.include_builtin_metrics !== false,
      min_metric_weight: clampNumber(metricSchema.min_metric_weight, 0, 0.2, base.metric_schema.min_metric_weight),
      default_primary_metric: normalizeToken(
        metricSchema.default_primary_metric || base.metric_schema.default_primary_metric,
        80
      ) || base.metric_schema.default_primary_metric,
      extra_metrics: Array.isArray(metricSchema.extra_metrics) ? metricSchema.extra_metrics.slice(0, 64) : []
    },
    arbitration: {
      floor_share: clampNumber(arbitration.floor_share, 0, 0.2, base.arbitration.floor_share),
      soft_caps: softCaps,
      max_uncertainty_exploration_share: clampNumber(
        arbitration.max_uncertainty_exploration_share,
        0,
        1,
        base.arbitration.max_uncertainty_exploration_share
      ),
      exploration_uncertainty_threshold: clampNumber(
        arbitration.exploration_uncertainty_threshold,
        0,
        1,
        base.arbitration.exploration_uncertainty_threshold
      ),
      block_unsafe_high_reward: arbitration.block_unsafe_high_reward === true,
      unsafe_high_reward_impact_threshold: clampNumber(
        arbitration.unsafe_high_reward_impact_threshold,
        0,
        1,
        base.arbitration.unsafe_high_reward_impact_threshold
      ),
      unsafe_high_reward_drift_threshold: clampNumber(
        arbitration.unsafe_high_reward_drift_threshold,
        0,
        1,
        base.arbitration.unsafe_high_reward_drift_threshold
      ),
      max_unsafe_high_reward_share: clampNumber(
        arbitration.max_unsafe_high_reward_share,
        0,
        1,
        base.arbitration.max_unsafe_high_reward_share
      ),
      currency_profiles: arbitration.currency_profiles && typeof arbitration.currency_profiles === 'object'
        ? arbitration.currency_profiles
        : {},
      ranking_profiles: arbitration.ranking_profiles && typeof arbitration.ranking_profiles === 'object'
        ? arbitration.ranking_profiles
        : {},
      weights: {
        ...base.arbitration.weights,
        ...(arbitration.weights && typeof arbitration.weights === 'object' ? arbitration.weights : {})
      }
    },
    monoculture_guard: {
      enabled: guard.enabled !== false,
      window_days: clampInt(guard.window_days, 1, 365, base.monoculture_guard.window_days),
      max_single_metric_share: clampNumber(
        guard.max_single_metric_share,
        0.3,
        0.95,
        base.monoculture_guard.max_single_metric_share
      ),
      metric_caps: normalizeCaps(guard.metric_caps, base.monoculture_guard.metric_caps),
      currency_caps: (() => {
        const caps = normalizeCaps(guard.currency_caps, base.monoculture_guard.currency_caps);
        if (Object.keys(caps).length) return caps;
        if (guard.enforce_revenue_guard === true) {
          return {
            revenue: clampNumber(
              guard.revenue_cap_share,
              0.3,
              0.95,
              base.monoculture_guard.max_single_metric_share
            )
          };
        }
        return {};
      })()
    },
    constitutional_veto: {
      enabled: veto.enabled !== false,
      deny_on_directive_decision: Array.isArray(veto.deny_on_directive_decision)
        ? veto.deny_on_directive_decision.map((v: unknown) => normalizeToken(v, 32)).filter(Boolean).slice(0, 8)
        : base.constitutional_veto.deny_on_directive_decision.slice(0),
      deny_on_identity_block: veto.deny_on_identity_block !== false,
      fallback_block_on_error: veto.fallback_block_on_error !== false,
      value_sovereignty: (() => {
        const src = veto.value_sovereignty && typeof veto.value_sovereignty === 'object'
          ? veto.value_sovereignty
          : base.constitutional_veto.value_sovereignty;
        const metricIds = Array.isArray(src.protected_metric_ids)
          ? src.protected_metric_ids
              .map((v: unknown) => normalizeToken(v, 80))
              .filter(Boolean)
              .slice(0, 32)
          : base.constitutional_veto.value_sovereignty.protected_metric_ids.slice(0);
        const currencies = Array.isArray(src.protected_value_currencies)
          ? src.protected_value_currencies
              .map((v: unknown) => normalizeToken(v, 80))
              .filter(Boolean)
              .slice(0, 16)
          : base.constitutional_veto.value_sovereignty.protected_value_currencies.slice(0);
        return {
          enabled: src.enabled !== false,
          min_combined_share: clampNumber(
            src.min_combined_share,
            0.05,
            0.8,
            base.constitutional_veto.value_sovereignty.min_combined_share
          ),
          protected_metric_ids: metricIds.length
            ? metricIds
            : base.constitutional_veto.value_sovereignty.protected_metric_ids.slice(0),
          protected_value_currencies: currencies.length
            ? currencies
            : base.constitutional_veto.value_sovereignty.protected_value_currencies.slice(0)
        };
      })()
    },
    creative_routing: {
      enabled: creative.enabled !== false,
      prefer_right_for_metric_ids: Array.isArray(creative.prefer_right_for_metric_ids)
        ? creative.prefer_right_for_metric_ids.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean).slice(0, 32)
        : base.creative_routing.prefer_right_for_metric_ids.slice(0),
      prefer_right_for_currencies: Array.isArray(creative.prefer_right_for_currencies)
        ? creative.prefer_right_for_currencies.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean).slice(0, 16)
        : base.creative_routing.prefer_right_for_currencies.slice(0),
      task_class_default: normalizeToken(creative.task_class_default || base.creative_routing.task_class_default, 80)
        || base.creative_routing.task_class_default,
      task_class_creative: normalizeToken(creative.task_class_creative || base.creative_routing.task_class_creative, 80)
        || base.creative_routing.task_class_creative,
      persist_decisions: creative.persist_decisions === true
    },
    pathways: {
      enabled: pathways.enabled !== false,
      min_share_for_active: clampNumber(pathways.min_share_for_active, 0, 1, base.pathways.min_share_for_active),
      dormant_after_days: clampInt(pathways.dormant_after_days, 1, 3650, base.pathways.dormant_after_days),
      archive_candidate_after_days: clampInt(
        pathways.archive_candidate_after_days,
        1,
        3650,
        base.pathways.archive_candidate_after_days
      ),
      atrophy_gain_per_day: clampNumber(pathways.atrophy_gain_per_day, 0, 1, base.pathways.atrophy_gain_per_day)
    },
    outputs: {
      emit_events: outputs.emit_events !== false,
      write_preview_overlay: outputs.write_preview_overlay !== false,
      emit_ide_events: outputs.emit_ide_events !== false,
      emit_obsidian_projection: outputs.emit_obsidian_projection !== false
    },
    advisory_primitives: {
      long_horizon_planning_enabled: advisoryPrimitives.long_horizon_planning_enabled !== false,
      multi_agent_debate_enabled: advisoryPrimitives.multi_agent_debate_enabled !== false
    }
  };
}

function emitEvent(paths: AnyObj, policy: AnyObj, stage: string, payload: AnyObj = {}) {
  if (!(policy && policy.outputs && policy.outputs.emit_events === true)) return;
  appendJsonl(paths.events_path, {
    ts: nowIso(),
    type: 'weaver_event',
    stage,
    ...payload
  });
}

function colorForCurrency(currency: string) {
  const key = normalizeToken(currency || '', 80);
  if (key === 'revenue') return '#6ea8ff';
  if (key === 'learning') return '#9c7bff';
  if (key === 'quality') return '#57d5ff';
  if (key === 'time_savings') return '#68f0a5';
  if (key === 'delivery') return '#7de0c0';
  if (key === 'user_value') return '#8fb6ff';
  return '#9da9b8';
}

function emitIdeProjection(paths: AnyObj, policy: AnyObj, payload: AnyObj = {}) {
  if (!(policy && policy.outputs && policy.outputs.emit_ide_events === true)) return;
  emitEvent(paths, policy, 'ide_projection', payload);
}

function emitObsidianProjection(paths: AnyObj, policy: AnyObj, payload: AnyObj = {}) {
  if (!(policy && policy.outputs && policy.outputs.emit_obsidian_projection === true)) return;
  appendJsonl(paths.obsidian_queue_path, {
    ts: nowIso(),
    type: 'weaver_obsidian_projection',
    ...payload
  });
}

function loadMetricAdapters(adapterPathRaw: unknown) {
  const pathRaw = cleanText(adapterPathRaw || process.env.WEAVER_METRIC_ADAPTERS_PATH || DEFAULT_METRIC_ADAPTERS_PATH, 500);
  const adapterPath = path.isAbsolute(pathRaw) ? pathRaw : path.join(ROOT, pathRaw);
  const payload = readJson(adapterPath, {});
  const adapters = Array.isArray(payload && payload.adapters)
    ? payload.adapters
    : [];
  return {
    path: adapterPath,
    version: cleanText(payload && payload.version || '', 40) || null,
    adapters
  };
}

function readLatestAxisSwitch(axisLedgerPath: string) {
  try {
    if (!fs.existsSync(axisLedgerPath)) return null;
    const rows = String(fs.readFileSync(axisLedgerPath, 'utf8') || '')
      .split('\n')
      .filter(Boolean);
    if (!rows.length) return null;
    const parsed = JSON.parse(rows[rows.length - 1]);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function evaluateConstitutionalVeto(policy: AnyObj, input: AnyObj = {}) {
  const cfg = policy && policy.constitutional_veto && typeof policy.constitutional_veto === 'object'
    ? policy.constitutional_veto
    : {};
  if (cfg.enabled !== true) {
    return {
      blocked: false,
      reason_codes: [],
      identity: { evaluated: false },
      directive: { evaluated: false }
    };
  }

  const reasonCodes: string[] = [];
  let blocked = false;
  const identityResult: AnyObj = { evaluated: false, blocked: false, reasons: [] };
  const directiveResult: AnyObj = { evaluated: false, blocked: false, decision: 'unknown', reasons: [] };

  try {
    if (typeof evaluateWorkflowDraft === 'function') {
      const evalOut = evaluateWorkflowDraft({
        id: input.run_id || 'weaver_run',
        objective_id: input.objective_id || null,
        value_currency: input.value_currency || null,
        fractal_depth: 0,
        metadata: {
          source: 'weaver_constitutional_veto',
          purpose: 'value_arbitration'
        }
      }, {
        source: 'weaver_constitutional_veto'
      });
      identityResult.evaluated = true;
      identityResult.blocked = evalOut && evalOut.blocked === true;
      identityResult.reasons = Array.isArray(evalOut && evalOut.blocking_codes)
        ? evalOut.blocking_codes.slice(0, 8)
        : [];
      if (cfg.deny_on_identity_block === true && identityResult.blocked === true) {
        blocked = true;
        reasonCodes.push('identity_anchor_blocked');
      }
    }
  } catch (err) {
    identityResult.error = cleanText(err && err.message ? err.message : err || 'identity_check_failed', 160);
    if (cfg.fallback_block_on_error === true) {
      blocked = true;
      reasonCodes.push('identity_check_error_block');
    }
  }

  try {
    if (typeof evaluateDirectiveTask === 'function') {
      const taskText = [
        `weaver arbitrate objective ${cleanText(input.objective_text || input.objective_id || '', 120)}`,
        `primary_metric ${cleanText(input.primary_metric_id || '', 80)}`,
        `value_currency ${cleanText(input.value_currency || '', 80)}`
      ].join(' ');
      const evalOut = evaluateDirectiveTask(taskText);
      const denySet = new Set(
        (Array.isArray(cfg.deny_on_directive_decision) ? cfg.deny_on_directive_decision : ['deny'])
          .map((v: unknown) => normalizeToken(v, 32))
          .filter(Boolean)
      );
      const decision = normalizeToken(evalOut && evalOut.decision || 'unknown', 32) || 'unknown';
      directiveResult.evaluated = true;
      directiveResult.decision = decision;
      directiveResult.reasons = Array.isArray(evalOut && evalOut.reasons) ? evalOut.reasons.slice(0, 6) : [];
      if (denySet.has(decision)) {
        directiveResult.blocked = true;
        blocked = true;
        reasonCodes.push('directive_gate_deny');
      }
    }
  } catch (err) {
    directiveResult.error = cleanText(err && err.message ? err.message : err || 'directive_check_failed', 160);
    if (cfg.fallback_block_on_error === true) {
      blocked = true;
      reasonCodes.push('directive_check_error_block');
    }
  }

  return {
    blocked,
    reason_codes: reasonCodes,
    identity: identityResult,
    directive: directiveResult
  };
}

function evaluateCreativeBrainRoute(policy: AnyObj, input: AnyObj = {}) {
  const cfg = policy && policy.creative_routing && typeof policy.creative_routing === 'object'
    ? policy.creative_routing
    : {};
  const primaryMetric = normalizeToken(input.primary_metric_id || '', 80);
  const valueCurrency = normalizeToken(input.value_currency || '', 80);
  const preferMetricSet = new Set(
    (Array.isArray(cfg.prefer_right_for_metric_ids) ? cfg.prefer_right_for_metric_ids : [])
      .map((v: unknown) => normalizeToken(v, 80))
      .filter(Boolean)
  );
  const preferCurrencySet = new Set(
    (Array.isArray(cfg.prefer_right_for_currencies) ? cfg.prefer_right_for_currencies : [])
      .map((v: unknown) => normalizeToken(v, 80))
      .filter(Boolean)
  );
  const creativePreferred = cfg.enabled === true
    && (preferMetricSet.has(primaryMetric) || preferCurrencySet.has(valueCurrency));
  const taskClass = creativePreferred
    ? (normalizeToken(cfg.task_class_creative || 'creative', 80) || 'creative')
    : (normalizeToken(cfg.task_class_default || 'general', 80) || 'general');

  if (typeof decideBrainRoute !== 'function') {
    return {
      available: false,
      creative_preferred: creativePreferred,
      task_class: taskClass,
      right_permitted: false,
      selected_live_brain: 'left',
      reasons: ['dual_brain_unavailable']
    };
  }
  try {
    const decision = decideBrainRoute({
      context: 'weaver_arbitration',
      task_class: taskClass,
      desired_lane: 'auto',
      trit: Number.isFinite(Number(input.trit)) ? Number(input.trit) : 0,
      persist: cfg.persist_decisions === true
    });
    return {
      available: true,
      creative_preferred: creativePreferred,
      task_class: taskClass,
      right_permitted: !!(decision && decision.right && decision.right.permitted === true),
      selected_live_brain: cleanText(decision && decision.selected_live_brain || 'left', 40) || 'left',
      mode: cleanText(decision && decision.mode || 'left_only', 64) || 'left_only',
      reasons: Array.isArray(decision && decision.reasons) ? decision.reasons.slice(0, 8) : [],
      right_lane_id: cleanText(decision && decision.right && decision.right.id || '', 80) || null
    };
  } catch (err) {
    return {
      available: false,
      creative_preferred: creativePreferred,
      task_class: taskClass,
      right_permitted: false,
      selected_live_brain: 'left',
      reasons: [cleanText(err && err.message ? err.message : err || 'dual_brain_route_failed', 140)]
    };
  }
}

function parseIsoMs(v: unknown) {
  const ts = Date.parse(String(v || ''));
  return Number.isFinite(ts) ? ts : null;
}

function daysSince(ts: unknown, nowMs: number) {
  const ms = parseIsoMs(ts);
  if (ms == null) return null;
  const delta = Math.max(0, nowMs - ms);
  return Number((delta / (24 * 60 * 60 * 1000)).toFixed(4));
}

function loadPathwayState(pathwayStatePath: string) {
  const payload = readJson(pathwayStatePath, null);
  if (!payload || typeof payload !== 'object') {
    return {
      version: '1.0',
      updated_at: null,
      pathways: {}
    };
  }
  return {
    version: cleanText(payload.version || '1.0', 16) || '1.0',
    updated_at: payload.updated_at ? String(payload.updated_at) : null,
    pathways: payload.pathways && typeof payload.pathways === 'object' ? payload.pathways : {}
  };
}

function updatePathwayState(paths: AnyObj, policy: AnyObj, metrics: AnyObj[], allocations: AnyObj[], primaryMetricId: string, ts: string) {
  const cfg = policy && policy.pathways && typeof policy.pathways === 'object' ? policy.pathways : {};
  if (cfg.enabled !== true) return null;
  const minShareForActive = clampNumber(cfg.min_share_for_active, 0, 1, 0.08);
  const dormantAfterDays = clampInt(cfg.dormant_after_days, 1, 3650, 14);
  const archiveAfterDays = clampInt(cfg.archive_candidate_after_days, 1, 3650, 60);
  const atrophyGainPerDay = clampNumber(cfg.atrophy_gain_per_day, 0, 1, 0.03);
  const nowMs = parseIsoMs(ts) || Date.now();

  const state = loadPathwayState(paths.pathway_state_path);
  const nextPathways: AnyObj = { ...(state.pathways || {}) };
  const allocByMetric = new Map(
    (Array.isArray(allocations) ? allocations : [])
      .map((row) => [normalizeToken(row && row.metric_id || '', 80), row])
      .filter((row) => row[0])
  );
  const metricIds = new Set<string>();
  for (const row of Array.isArray(metrics) ? metrics : []) {
    const id = normalizeToken(row && row.metric_id || '', 80);
    if (!id) continue;
    metricIds.add(id);
    const prev = nextPathways[id] && typeof nextPathways[id] === 'object' ? nextPathways[id] : {};
    const alloc = allocByMetric.get(id) || {};
    const share = clampNumber(alloc.share, 0, 1, 0);
    const isPrimary = id === normalizeToken(primaryMetricId || '', 80);
    const isActive = share >= minShareForActive || isPrimary;
    const lastSeenAt = ts;
    const lastActiveAt = isActive ? ts : (prev.last_active_at || null);
    const lastPrimaryAt = isPrimary ? ts : (prev.last_primary_at || null);
    const idleDays = daysSince(lastActiveAt || prev.last_seen_at || ts, nowMs) || 0;
    const atrophyScore = clampNumber(idleDays * atrophyGainPerDay, 0, 1, 0);
    nextPathways[id] = {
      metric_id: id,
      value_currency: normalizeToken(
        alloc.value_currency || row.value_currency || prev.value_currency || '',
        80
      ) || null,
      last_seen_at: lastSeenAt,
      last_active_at: lastActiveAt,
      last_primary_at: lastPrimaryAt,
      runs_seen: Number(prev.runs_seen || 0) + 1,
      idle_days: Number(idleDays.toFixed(4)),
      atrophy_score: Number(atrophyScore.toFixed(4)),
      dormant_candidate: idleDays >= dormantAfterDays,
      archive_candidate: idleDays >= archiveAfterDays
    };
  }

  for (const id of Object.keys(nextPathways)) {
    if (metricIds.has(id)) continue;
    const prev = nextPathways[id];
    const idleDays = daysSince(prev && (prev.last_active_at || prev.last_seen_at || prev.updated_at), nowMs) || 0;
    const atrophyScore = clampNumber(idleDays * atrophyGainPerDay, 0, 1, 0);
    nextPathways[id] = {
      ...(prev && typeof prev === 'object' ? prev : {}),
      metric_id: id,
      idle_days: Number(idleDays.toFixed(4)),
      atrophy_score: Number(atrophyScore.toFixed(4)),
      dormant_candidate: idleDays >= dormantAfterDays,
      archive_candidate: idleDays >= archiveAfterDays
    };
  }

  const out = {
    version: '1.0',
    updated_at: ts,
    pathways: nextPathways
  };
  writeJsonAtomic(paths.pathway_state_path, out);
  const dormant = Object.values(nextPathways)
    .filter((row: unknown) => row && typeof row === 'object' && (row as AnyObj).dormant_candidate === true)
    .map((row) => ({
      metric_id: String((row as AnyObj).metric_id || ''),
      idle_days: Number((row as AnyObj).idle_days || 0),
      atrophy_score: Number((row as AnyObj).atrophy_score || 0),
      archive_candidate: (row as AnyObj).archive_candidate === true
    }))
    .slice(0, 24);
  return {
    state_path: relPath(paths.pathway_state_path),
    dormant_count: dormant.length,
    dormant
  };
}

function runWeaver(dateStr: string, opts: AnyObj = {}) {
  const policyPath = path.resolve(String(opts.policyPath || opts.policy_path || process.env.WEAVER_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = opts.policy && typeof opts.policy === 'object' ? opts.policy : loadPolicy(policyPath);
  const paths = runtimePaths(policyPath);
  const runId = `wea_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = nowIso();
  const dryRun = opts.dry_run === true || opts.dryRun === true;
  const applyRequested = opts.apply === true || opts.apply_requested === true;

  if (policy.enabled !== true) {
    const payload = {
      ok: true,
      skipped: true,
      reason: 'policy_disabled',
      type: 'weaver_run',
      ts,
      date: dateStr,
      run_id: runId,
      policy: {
        version: policy.version,
        path: relPath(policyPath)
      }
    };
    writeJsonAtomic(paths.latest_path, payload);
    return payload;
  }

  const strategy = loadActiveStrategy({ allowMissing: true }) || {};
  const strategyId = cleanText(strategy.id || '*', 80) || '*';
  const objectiveId = normalizeToken(
    opts.objectiveId || opts.objective_id || strategy.objective_id || '',
    120
  ) || 'generic_objective';
  const objectiveText = cleanText(
    opts.objective || opts.intent || (strategy.objective && strategy.objective.primary) || objectiveId,
    280
  );
  const longHorizonPlanning = (
    policy.advisory_primitives
    && policy.advisory_primitives.long_horizon_planning_enabled === true
    && typeof runLongHorizonPlanning === 'function'
  )
    ? runLongHorizonPlanning({
      date: dateStr,
      objective_id: objectiveId,
      objective: objectiveText,
      risk: normalizeToken(opts.risk || opts.risk_tier || 'medium', 40) || 'medium'
    }, {
      persist: true
    })
    : null;
  const dualitySignal = typeof dualityEvaluate === 'function'
    ? dualityEvaluate({
      lane: 'weaver_arbitration',
      source: 'weaver_core',
      run_id: runId,
      objective_id: objectiveId,
      objective: objectiveText,
      strategy_id: strategyId,
      requested_metrics: opts.valueMetrics || opts.value_metrics || null
    }, {
      lane: 'weaver_arbitration',
      source: 'weaver_core',
      run_id: runId,
      persist: true
    })
    : null;

  const regime = readJson(paths.regime_latest_path, {});
  const mirror = readJson(paths.mirror_latest_path, {});
  const autopause = readJson(paths.autopause_path, {});
  const burnOracle = loadDynamicBurnOracleSignal({
    latest_path: paths.burn_oracle_latest_path
  });
  const trit = clampNumber(
    regime && regime.context && regime.context.trit && regime.context.trit.trit,
    -1,
    1,
    0
  );
  const regimeName = normalizeToken(regime && regime.selected_regime || '', 64) || 'unknown';
  const regimeConfidence = clampNumber(regime && regime.candidate_confidence, 0, 1, 0.5);
  const autopauseActive = !!(
    (autopause && autopause.active === true && Number(autopause.until_ms || 0) > Date.now())
    || (regime && regime.context && regime.context.autopause && regime.context.autopause.active === true)
  );
  const mirrorPressure = clampNumber(mirror && mirror.pressure_score, 0, 1, 0);
  const mirrorReasons = Array.isArray(mirror && mirror.reasons) ? mirror.reasons.slice(0, 8) : [];
  const burnCostPressure = clampNumber(
    burnOracle && burnOracle.available === true ? burnOracle.cost_pressure : 0,
    0,
    1,
    0
  );

  const metricInput = parseMetricInput(
    opts.valueMetrics
    || opts.value_metrics
    || opts.valueCurrency
    || opts.value_currency
    || null
  );
  const primaryMetric = normalizeToken(opts.primaryMetric || opts.primary_metric || '', 80) || null;
  const userDeclaredPrimaryMetric = normalizeToken(
    opts.primaryMetric != null ? opts.primaryMetric : opts.primary_metric,
    80
  ) || null;
  const metricAdapters = loadMetricAdapters(opts.metricAdaptersPath || opts.metric_adapters_path);
  const schema = buildMetricSchema({
    policy_metric_schema: policy.metric_schema,
    strategy,
    adapter_rows: metricAdapters.adapters,
    requested_metrics: metricInput,
    primary_metric: primaryMetric
  });

  const context = {
    trit,
    regime: regimeName,
    regime_confidence: clampNumber(
      regimeConfidence + (
        dualitySignal && dualitySignal.enabled === true
          ? Number(dualitySignal.score_trit || 0) * Number(dualitySignal.effective_weight || 0) * 0.08
          : 0
      ),
      0,
      1,
      regimeConfidence
    ),
    autopause_active: autopauseActive,
    cost_pressure: clampNumber(
      Math.max(
        autopauseActive ? 1 : 0,
        burnCostPressure
      ),
      0,
      1,
      autopauseActive ? 1 : burnCostPressure
    ),
    mirror_pressure: mirrorPressure,
    mirror_reasons: mirrorReasons,
    objective_metric_impact: objectiveMetricImpact(objectiveId, objectiveText),
    primary_metric_hint: primaryMetric || schema.primary_metric_hint || null,
    allow_exploration: !!(
      dualitySignal
      && dualitySignal.enabled === true
      && String(dualitySignal.recommended_adjustment || '') === 'increase_yang_flux'
    ),
    planning_complexity: longHorizonPlanning && longHorizonPlanning.ok === true
      ? Number(longHorizonPlanning.complexity_score || 0)
      : null,
    planning_token_budget: longHorizonPlanning && longHorizonPlanning.ok === true
      ? Number(longHorizonPlanning.thinking_token_budget || 0)
      : null,
    currency_profiles: policy.arbitration && policy.arbitration.currency_profiles
      ? policy.arbitration.currency_profiles
      : {}
  };

  const arbitration = arbitrateMetrics({
    metrics: schema.metrics,
    context,
    policy: policy.arbitration
  });
  const historyRows = readJsonl(paths.history_path);
  const guarded = applyMonocultureGuard({
    rows: arbitration.rows,
    history_rows: historyRows,
    policy: policy.monoculture_guard,
    now_ts: ts,
    constitution_policy: policy.constitutional_veto,
    fallback_metric: primaryMetric || schema.primary_metric_hint || 'adaptive_value'
  });
  const finalRows = Array.isArray(guarded && guarded.rows) ? guarded.rows : arbitration.rows;
  const finalPrimary = finalRows[0] || null;
  const finalCurrency = finalPrimary ? normalizeToken(finalPrimary.value_currency || '', 64) : null;
  const finalMetric = finalPrimary ? normalizeToken(finalPrimary.metric_id || '', 80) : null;
  const multiAgentDebate = (
    policy.advisory_primitives
    && policy.advisory_primitives.multi_agent_debate_enabled === true
    && typeof runMultiAgentDebate === 'function'
  )
    ? runMultiAgentDebate({
      date: dateStr,
      objective_id: objectiveId,
      objective: objectiveText,
      candidates: finalRows.slice(0, 8).map((row: AnyObj) => ({
        candidate_id: normalizeToken(row.metric_id || 'unknown_metric', 120) || 'unknown_metric',
        score: clampNumber(row.share, 0, 1, 0),
        confidence: clampNumber(row.signals && row.signals.confidence, 0, 1, 0.5),
        risk: clampNumber(row.signals && row.signals.drift_risk, 0, 1, 0.5) >= 0.66
          ? 'high'
          : (clampNumber(row.signals && row.signals.drift_risk, 0, 1, 0.5) >= 0.33 ? 'medium' : 'low')
      }))
    }, {
      persist: true
    })
    : null;

  const overlayBody = buildStrategyOverlayFromAllocation(
    {
      rows: finalRows
    },
    {
      objective_id: objectiveId,
      ranking_profiles: policy.arbitration && policy.arbitration.ranking_profiles
        ? policy.arbitration.ranking_profiles
        : {}
    }
  );

  const constitutionalVeto = evaluateConstitutionalVeto(policy, {
    run_id: runId,
    objective_id: objectiveId,
    objective_text: objectiveText,
    primary_metric_id: finalMetric || null,
    value_currency: finalCurrency || null
  });
  const brainRoute = evaluateCreativeBrainRoute(policy, {
    trit,
    primary_metric_id: finalMetric || null,
    value_currency: finalCurrency || null
  });
  const valueReasonCodes = []
    .concat(Array.isArray(arbitration.reason_codes) ? arbitration.reason_codes : [])
    .concat(Array.isArray(guarded.reason_codes) ? guarded.reason_codes : [])
    .concat(Array.isArray(constitutionalVeto.reason_codes) ? constitutionalVeto.reason_codes : [])
    .concat(Array.isArray(brainRoute.reasons) ? brainRoute.reasons.slice(0, 2) : [])
    .concat(
      burnOracle && burnOracle.available === true && burnOracle.pressure !== 'none'
        ? [`budget_oracle_pressure_${String(burnOracle.pressure)}`]
        : []
    )
    .concat(
      dualitySignal && dualitySignal.enabled === true
        ? ['duality_advisory_applied']
        : []
    )
    .concat(
      longHorizonPlanning && longHorizonPlanning.ok === true
        ? ['long_horizon_planning_advisory_applied']
        : []
    )
    .concat(
      multiAgentDebate && multiAgentDebate.ok === true
        ? [multiAgentDebate.consensus === true ? 'multi_agent_consensus_reached' : 'multi_agent_consensus_not_reached']
        : []
    )
    .filter(Boolean);

  const previousHistory = historyRows.length ? historyRows[historyRows.length - 1] : null;
  const previousPrimaryMetric = normalizeToken(
    previousHistory && previousHistory.primary_metric_id,
    80
  ) || null;
  const metricSwitchDeclaredByUser = !!(
    userDeclaredPrimaryMetric
    && userDeclaredPrimaryMetric !== previousPrimaryMetric
  );
  const metricSwitchRequestedByUser = !!userDeclaredPrimaryMetric;
  const metricSwitchAccepted = !!(
    metricSwitchRequestedByUser
    && finalMetric
    && userDeclaredPrimaryMetric === finalMetric
  );

  const canApply = (
    applyRequested
    && dryRun !== true
    && policy.allow_apply === true
    && policy.shadow_only !== true
    && constitutionalVeto.blocked !== true
    && !!overlayBody
  );
  const overlayPayload = overlayBody
    ? {
        schema_id: 'weaver_strategy_overlay',
        schema_version: '1.0',
        ts,
        run_id: runId,
        enabled: canApply === true,
        shadow_only: policy.shadow_only === true,
        strategy_id: strategyId,
        objective_id: objectiveId,
        primary_metric_id: finalMetric || null,
        value_currency: finalCurrency || null,
        reason_codes: valueReasonCodes,
        strategy_policy: {
          value_currency_policy_overrides: overlayBody
        }
      }
    : null;

  if (overlayPayload && canApply) {
    writeJsonAtomic(paths.active_overlay_path, overlayPayload);
  } else if (overlayPayload && policy.outputs.write_preview_overlay === true) {
    writeJsonAtomic(paths.preview_overlay_path, overlayPayload);
  }

  const payload = {
    ok: true,
    type: 'weaver_run',
    ts,
    date: dateStr,
    run_id: runId,
    policy: {
      version: policy.version,
      path: relPath(policyPath),
      shadow_only: policy.shadow_only === true
    },
    source: cleanText(opts.source || 'manual', 80) || 'manual',
    strategy_id: strategyId,
    objective_id: objectiveId,
    objective_text: objectiveText,
    requested_metrics: schema.requested_weights,
    requested_metric_ids: schema.requested_metric_ids,
    adapter_rows_count: Number(schema.adapter_rows_count || 0),
    metric_adapters: {
      path: relPath(metricAdapters.path),
      version: metricAdapters.version,
      adapter_count: Array.isArray(metricAdapters.adapters) ? metricAdapters.adapters.length : 0
    },
    primary_metric_hint: schema.primary_metric_hint,
    value_context: {
      primary_metric_id: finalMetric || null,
      value_currency: finalCurrency || null,
      active_metric_ids: finalRows.map((row) => String(row.metric_id || '')),
      allocations: finalRows.map((row) => ({
        metric_id: String(row.metric_id || ''),
        value_currency: String(row.value_currency || ''),
        share: Number(row.share || 0),
        raw_score: Number(row.raw_score || 0),
        normalized_weight: Number(row.normalized_weight || 0),
        signals: row.signals && typeof row.signals === 'object' ? row.signals : {},
        render: {
          aura_color: colorForCurrency(String(row.value_currency || '')),
          aura_intensity: Number(clampNumber(row.share, 0, 1, 0).toFixed(4))
        }
      })),
      reason_codes: valueReasonCodes,
      monoculture_guard: {
        triggered: guarded && guarded.triggered === true,
        top_changed: guarded && guarded.top_changed === true,
        dominance: guarded && guarded.dominance ? guarded.dominance : {},
        value_sovereignty: guarded && guarded.sovereignty ? guarded.sovereignty : {}
      },
      constitutional_veto: constitutionalVeto,
      creative_route: brainRoute,
      budget_oracle: burnOracle && burnOracle.available === true
        ? {
          available: true,
          pressure: String(burnOracle.pressure || 'none'),
          projected_runway_days: burnOracle.projected_runway_days,
          projected_days_to_reset: burnOracle.projected_days_to_reset,
          providers_available: Number(burnOracle.providers_available || 0),
          reason_codes: Array.isArray(burnOracle.reason_codes) ? burnOracle.reason_codes.slice(0, 12) : [],
          source_path: burnOracle.latest_path_rel || relPath(paths.burn_oracle_latest_path)
        }
        : {
          available: false,
          source_path: relPath(paths.burn_oracle_latest_path)
        },
      duality: dualitySignal
        ? {
          enabled: dualitySignal.enabled === true,
          score_trit: Number(dualitySignal.score_trit || 0),
          score_label: cleanText(dualitySignal.score_label || 'unknown', 32),
          zero_point_harmony_potential: Number(dualitySignal.zero_point_harmony_potential || 0),
          recommended_adjustment: cleanText(dualitySignal.recommended_adjustment || '', 120) || null,
          confidence: Number(dualitySignal.confidence || 0),
          effective_weight: Number(dualitySignal.effective_weight || 0),
          indicator: dualitySignal.indicator && typeof dualitySignal.indicator === 'object'
            ? dualitySignal.indicator
            : null,
          zero_point_insight: cleanText(dualitySignal.zero_point_insight || '', 220) || null
        }
        : {
          enabled: false
        },
      long_horizon_planning: longHorizonPlanning && longHorizonPlanning.ok === true
        ? {
          enabled: true,
          complexity_score: Number(longHorizonPlanning.complexity_score || 0),
          complexity_tier: cleanText(longHorizonPlanning.complexity_tier || 'unknown', 24),
          thinking_token_budget: Number(longHorizonPlanning.thinking_token_budget || 0),
          structured_step_count: Number(
            longHorizonPlanning.structured_thinking && longHorizonPlanning.structured_thinking.step_count || 0
          ),
          reason_codes: Array.isArray(longHorizonPlanning.reason_codes)
            ? longHorizonPlanning.reason_codes.slice(0, 8)
            : []
        }
        : {
          enabled: false
        },
      multi_agent_debate: multiAgentDebate && multiAgentDebate.ok === true
        ? {
          enabled: true,
          consensus: multiAgentDebate.consensus === true,
          consensus_share: Number(multiAgentDebate.consensus_share || 0),
          recommended_candidate_id: multiAgentDebate.recommended_candidate_id || null,
          rounds_executed: Number(multiAgentDebate.rounds_executed || 0),
          reason_codes: Array.isArray(multiAgentDebate.reason_codes)
            ? multiAgentDebate.reason_codes.slice(0, 8)
            : []
        }
        : {
          enabled: false
        },
      metric_switch: metricSwitchRequestedByUser
        ? {
            declared_by_user: true,
            switch_changed: metricSwitchDeclaredByUser,
            from_metric_id: previousPrimaryMetric || null,
            requested_metric_id: userDeclaredPrimaryMetric,
            selected_metric_id: finalMetric || null,
            accepted: metricSwitchAccepted
          }
        : null
    },
    context: {
      trit,
      regime: regimeName,
      regime_confidence: regimeConfidence,
      autopause_active: autopauseActive,
      mirror_pressure: mirrorPressure,
      mirror_reasons: mirrorReasons
    },
    apply_requested: applyRequested,
    apply_executed: canApply,
    dry_run: dryRun,
    veto_blocked: constitutionalVeto.blocked === true,
    overlay: overlayPayload
      ? {
          active_path: canApply ? relPath(paths.active_overlay_path) : null,
          preview_path: !canApply && policy.outputs.write_preview_overlay === true ? relPath(paths.preview_overlay_path) : null
        }
      : null
  };

  const pathwayState = updatePathwayState(
    paths,
    policy,
    schema.metrics,
    payload.value_context && Array.isArray(payload.value_context.allocations)
      ? payload.value_context.allocations
      : [],
    finalMetric || '',
    ts
  );
  if (pathwayState && typeof pathwayState === 'object') {
    payload.value_context.pathways = pathwayState;
  }

  const runPath = path.join(paths.runs_dir, `${dateStr}.json`);
  writeJsonAtomic(runPath, payload);
  writeJsonAtomic(paths.latest_path, payload);
  appendJsonl(paths.history_path, {
    ts,
    type: 'weaver_history',
    run_id: runId,
    date: dateStr,
    objective_id: objectiveId,
    strategy_id: strategyId,
    primary_metric_id: finalMetric || null,
    value_currency: finalCurrency || null,
    guard_triggered: guarded && guarded.triggered === true,
    apply_executed: canApply,
    veto_blocked: constitutionalVeto.blocked === true
  });

  emitEvent(paths, policy, 'arbitrated', {
    run_id: runId,
    date: dateStr,
    objective_id: objectiveId,
    primary_metric_id: finalMetric || null,
    value_currency: finalCurrency || null,
    guard_triggered: guarded && guarded.triggered === true,
    apply_executed: canApply,
    veto_blocked: constitutionalVeto.blocked === true
  });
  if (guarded && guarded.triggered === true) {
    emitEvent(paths, policy, 'monoculture_guard', {
      run_id: runId,
      date: dateStr,
      objective_id: objectiveId,
      reason_codes: Array.isArray(guarded.reason_codes) ? guarded.reason_codes.slice(0, 8) : [],
      dominance: guarded.dominance && typeof guarded.dominance === 'object' ? guarded.dominance : {}
    });
  }
  if (dualitySignal && dualitySignal.enabled === true) {
    emitEvent(paths, policy, 'duality_advisory', {
      run_id: runId,
      date: dateStr,
      objective_id: objectiveId,
      score_trit: Number(dualitySignal.score_trit || 0),
      zero_point_harmony_potential: Number(dualitySignal.zero_point_harmony_potential || 0),
      recommended_adjustment: cleanText(dualitySignal.recommended_adjustment || '', 120) || null,
      indicator: dualitySignal.indicator && typeof dualitySignal.indicator === 'object'
        ? dualitySignal.indicator
        : null
    });
  }
  if (longHorizonPlanning && longHorizonPlanning.ok === true) {
    emitEvent(paths, policy, 'long_horizon_planning', {
      run_id: runId,
      date: dateStr,
      objective_id: objectiveId,
      complexity_score: Number(longHorizonPlanning.complexity_score || 0),
      complexity_tier: cleanText(longHorizonPlanning.complexity_tier || 'unknown', 24),
      thinking_token_budget: Number(longHorizonPlanning.thinking_token_budget || 0),
      structured_step_count: Number(
        longHorizonPlanning.structured_thinking && longHorizonPlanning.structured_thinking.step_count || 0
      )
    });
  }
  if (multiAgentDebate && multiAgentDebate.ok === true) {
    emitEvent(paths, policy, 'multi_agent_debate', {
      run_id: runId,
      date: dateStr,
      objective_id: objectiveId,
      consensus: multiAgentDebate.consensus === true,
      consensus_share: Number(multiAgentDebate.consensus_share || 0),
      recommended_candidate_id: multiAgentDebate.recommended_candidate_id || null
    });
  }
  if (metricSwitchRequestedByUser) {
    emitEvent(paths, policy, 'metric_switch_declared_by_user', {
      run_id: runId,
      date: dateStr,
      objective_id: objectiveId,
      switch_changed: metricSwitchDeclaredByUser,
      from_metric_id: previousPrimaryMetric || null,
      requested_metric_id: userDeclaredPrimaryMetric,
      selected_metric_id: finalMetric || null,
      accepted: metricSwitchAccepted
    });
    appendJsonl(paths.axis_ledger_path, {
      ts,
      type: 'weaver_axis_switch',
      run_id: runId,
      date: dateStr,
      source: cleanText(opts.source || 'manual', 80) || 'manual',
      objective_id: objectiveId,
      switch_changed: metricSwitchDeclaredByUser,
      from_metric_id: previousPrimaryMetric || null,
      requested_metric_id: userDeclaredPrimaryMetric,
      selected_metric_id: finalMetric || null,
      accepted: metricSwitchAccepted,
      reason_codes: valueReasonCodes.slice(0, 10)
    });
  }
  if (pathwayState && pathwayState.dormant_count > 0) {
    emitEvent(paths, policy, 'pathway_atrophy', {
      run_id: runId,
      date: dateStr,
      dormant_count: Number(pathwayState.dormant_count || 0),
      dormant: Array.isArray(pathwayState.dormant) ? pathwayState.dormant.slice(0, 12) : []
    });
  }

  if (typeof runEthicalReasoning === 'function') {
    try {
      const ethicalOut = runEthicalReasoning({
        ts,
        run_id: runId,
        objective_id: objectiveId,
        maturity_score: clampNumber((regimeConfidence + (1 - mirrorPressure)) / 2, 0, 1, 0.5),
        weaver_payload: payload,
        mirror_payload: mirror
      }, {
        persist: true
      });
      if (ethicalOut && ethicalOut.ok === true) {
        payload.ethical_reasoning = {
          enabled: true,
          summary: ethicalOut.summary || {},
          reason_codes: Array.isArray(ethicalOut.reason_codes) ? ethicalOut.reason_codes.slice(0, 8) : [],
          correction_actions: Array.isArray(ethicalOut.correction_actions)
            ? ethicalOut.correction_actions.slice(0, 8)
            : [],
          tradeoff_receipts: Array.isArray(ethicalOut.tradeoff_receipts)
            ? ethicalOut.tradeoff_receipts.slice(0, 8)
            : []
        };
        if (Array.isArray(payload.ethical_reasoning.reason_codes) && payload.ethical_reasoning.reason_codes.length) {
          emitEvent(paths, policy, 'ethical_reasoning', {
            run_id: runId,
            date: dateStr,
            objective_id: objectiveId,
            reason_codes: payload.ethical_reasoning.reason_codes
          });
        }
      }
    } catch (err) {
      payload.ethical_reasoning = {
        enabled: false,
        error: cleanText(err && err.message ? err.message : err || 'ethical_reasoning_failed', 180)
      };
    }
  }
  if (payload.ethical_reasoning) {
    writeJsonAtomic(runPath, payload);
    writeJsonAtomic(paths.latest_path, payload);
  }

  emitIdeProjection(paths, policy, {
    run_id: runId,
    date: dateStr,
    objective_id: objectiveId,
    primary_metric_id: finalMetric || null,
    value_currency: finalCurrency || null,
    allocations: payload.value_context && Array.isArray(payload.value_context.allocations)
      ? payload.value_context.allocations.slice(0, 12).map((row: AnyObj) => ({
        metric_id: row.metric_id || null,
        value_currency: row.value_currency || null,
        share: Number(row.share || 0),
        aura_color: row.render && row.render.aura_color ? row.render.aura_color : colorForCurrency(row.value_currency),
        aura_intensity: row.render && row.render.aura_intensity != null
          ? Number(row.render.aura_intensity)
          : Number(clampNumber(row.share, 0, 1, 0))
      }))
      : [],
    monoculture_guard: payload.value_context && payload.value_context.monoculture_guard
      ? payload.value_context.monoculture_guard
      : {},
    constitutional_veto: constitutionalVeto,
    creative_route: brainRoute,
    duality: payload.value_context && payload.value_context.duality
      ? payload.value_context.duality
      : { enabled: false },
    long_horizon_planning: payload.value_context && payload.value_context.long_horizon_planning
      ? payload.value_context.long_horizon_planning
      : { enabled: false },
    multi_agent_debate: payload.value_context && payload.value_context.multi_agent_debate
      ? payload.value_context.multi_agent_debate
      : { enabled: false },
    metric_switch: metricSwitchRequestedByUser
      ? {
          declared_by_user: true,
          switch_changed: metricSwitchDeclaredByUser,
          from_metric_id: previousPrimaryMetric || null,
          requested_metric_id: userDeclaredPrimaryMetric,
          selected_metric_id: finalMetric || null,
          accepted: metricSwitchAccepted
        }
      : null
  });

  const obsidianSummaryLines = [
    `# Weaver Arbitration (${dateStr})`,
    '',
    `- Objective: \`${objectiveId}\``,
    `- Primary metric: \`${finalMetric || 'none'}\``,
    `- Value currency: \`${finalCurrency || 'none'}\``,
    `- Apply executed: \`${canApply ? 'yes' : 'no'}\``,
    `- Constitutional veto: \`${constitutionalVeto.blocked === true ? 'blocked' : 'clear'}\``,
    `- Creative route: \`${brainRoute.selected_live_brain || 'left'}\` (preferred=\`${brainRoute.creative_preferred === true ? 'yes' : 'no'}\`)`,
    `- Long-horizon planning: \`${longHorizonPlanning && longHorizonPlanning.ok === true ? 'enabled' : 'disabled'}\``,
    `- Multi-agent debate: \`${multiAgentDebate && multiAgentDebate.ok === true ? (multiAgentDebate.consensus === true ? 'consensus' : 'no_consensus') : 'disabled'}\``,
    '',
    '## Top Allocations'
  ];
  for (const row of (payload.value_context && Array.isArray(payload.value_context.allocations)
    ? payload.value_context.allocations
    : []).slice(0, 5)) {
    obsidianSummaryLines.push(
      `- \`${String(row.metric_id || '')}\` / \`${String(row.value_currency || '')}\` -> \`${Number(row.share || 0).toFixed(3)}\``
    );
  }
  if (Array.isArray(valueReasonCodes) && valueReasonCodes.length) {
    obsidianSummaryLines.push('', '## Reason Codes');
    for (const reason of valueReasonCodes.slice(0, 10)) obsidianSummaryLines.push(`- ${String(reason)}`);
  }
  if (metricSwitchRequestedByUser) {
    obsidianSummaryLines.push('', '## Value Axis Switch');
    obsidianSummaryLines.push(`- Previous: \`${previousPrimaryMetric || 'none'}\``);
    obsidianSummaryLines.push(`- Requested: \`${userDeclaredPrimaryMetric || 'none'}\``);
    obsidianSummaryLines.push(`- Selected: \`${finalMetric || 'none'}\``);
    obsidianSummaryLines.push(`- Changed: \`${metricSwitchDeclaredByUser ? 'yes' : 'no'}\``);
    obsidianSummaryLines.push(`- Accepted: \`${metricSwitchAccepted ? 'yes' : 'no'}\``);
  }
  emitObsidianProjection(paths, policy, {
    run_id: runId,
    date: dateStr,
    objective_id: objectiveId,
    primary_metric_id: finalMetric || null,
    value_currency: finalCurrency || null,
    markdown: obsidianSummaryLines.join('\n'),
    duality: payload.value_context && payload.value_context.duality
      ? payload.value_context.duality
      : { enabled: false }
  });
  if (metricSwitchRequestedByUser) {
    emitObsidianProjection(paths, policy, {
      stage: 'metric_switch_declared_by_user',
      run_id: runId,
      date: dateStr,
      objective_id: objectiveId,
      switch_changed: metricSwitchDeclaredByUser,
      from_metric_id: previousPrimaryMetric || null,
      requested_metric_id: userDeclaredPrimaryMetric,
      selected_metric_id: finalMetric || null,
      accepted: metricSwitchAccepted
    });
  }
  if (dualitySignal && dualitySignal.enabled === true && typeof registerDualityObservation === 'function') {
    try {
      registerDualityObservation({
        lane: 'weaver_arbitration',
        source: 'weaver_core',
        run_id: runId,
        predicted_trit: Number(dualitySignal.score_trit || 0),
        observed_trit: constitutionalVeto.blocked === true
          ? -1
          : (finalMetric ? 1 : 0)
      });
    } catch {
      // Advisory telemetry must not fail the run.
    }
  }

  payload.run_path = relPath(runPath);
  payload.latest_path = relPath(paths.latest_path);
  payload.history_path = relPath(paths.history_path);
  return payload;
}

function status(dateArg: string, opts: AnyObj = {}) {
  const policyPath = path.resolve(String(opts.policy_path || process.env.WEAVER_POLICY_PATH || DEFAULT_POLICY_PATH));
  const paths = runtimePaths(policyPath);
  const key = String(dateArg || 'latest').trim().toLowerCase();
  const payload = key === 'latest'
    ? readJson(paths.latest_path, null)
    : readJson(path.join(paths.runs_dir, `${toDate(key)}.json`), null);
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      type: 'weaver_status',
      error: 'weaver_snapshot_missing',
      date: key === 'latest' ? 'latest' : toDate(key)
    };
  }
  return {
    ok: true,
    type: 'weaver_status',
    ts: String(payload.ts || ''),
    date: String(payload.date || ''),
    run_id: String(payload.run_id || ''),
    strategy_id: String(payload.strategy_id || ''),
    objective_id: String(payload.objective_id || ''),
    primary_metric_id: String(payload.value_context && payload.value_context.primary_metric_id || ''),
    value_currency: String(payload.value_context && payload.value_context.value_currency || ''),
    guard_triggered: !!(
      payload.value_context
      && payload.value_context.monoculture_guard
      && payload.value_context.monoculture_guard.triggered === true
    ),
    veto_blocked: payload.veto_blocked === true,
    creative_selected_brain: String(
      payload.value_context
      && payload.value_context.creative_route
      && payload.value_context.creative_route.selected_live_brain
      || ''
    ),
    dormant_pathways: Number(
      payload.value_context
      && payload.value_context.pathways
      && payload.value_context.pathways.dormant_count
      || 0
    ),
    latest_axis_switch: readLatestAxisSwitch(paths.axis_ledger_path),
    apply_executed: payload.apply_executed === true,
    run_path: payload.run_path || null,
    latest_path: relPath(paths.latest_path)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'run', 32) || 'run';
  if (args.help === true || args.h === true || cmd === 'help') {
    usage();
    return;
  }
  if (cmd === 'status') {
    const dateArg = args._[1] || 'latest';
    process.stdout.write(`${JSON.stringify(status(String(dateArg), {
      policy_path: args.policy
    }))}\n`);
    return;
  }
  if (cmd === 'run') {
    const dateStr = toDate(args._[1]);
    const payload = runWeaver(dateStr, {
      policyPath: args.policy,
      objectiveId: args['objective-id'] || args.objective_id,
      objective: args.objective,
      intent: args.intent,
      valueMetrics: args['value-metrics'] || args.value_metrics,
      valueCurrency: args['value-currency'] || args.value_currency,
      primaryMetric: args['primary-metric'] || args.primary_metric,
      apply: toBool(args.apply, false),
      dry_run: toBool(args['dry-run'], false),
      source: args.source
    });
    process.stdout.write(`${JSON.stringify(payload)}\n`);
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
      type: 'weaver_run',
      error: String(err && err.message ? err.message : err || 'weaver_run_failed')
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  runWeaver,
  status
};
