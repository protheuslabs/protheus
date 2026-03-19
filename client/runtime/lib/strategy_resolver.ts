'use strict';
export {};

// Layer ownership: core/layer2/execution (authoritative)
// Thin TypeScript wrapper only.

const path = require('path');
const { createConduitLaneModule } = require('./direct_conduit_lane_bridge.js');
const __directConduitLane = createConduitLaneModule('LIB_STRATEGY_RESOLVER');
void __directConduitLane;

const { createOpsLaneBridge } = require('./rust_lane_bridge.ts');

type AnyObj = Record<string, any>;

const bridge = createOpsLaneBridge(__dirname, 'strategy_resolver', 'strategy-resolver');

const DEFAULT_STRATEGY_DIR = path.resolve(__dirname, '..', 'config', 'strategies');
const THRESHOLD_KEYS = new Set([
  'min_signal_quality',
  'min_sensory_signal_score',
  'min_sensory_relevance_score',
  'min_directive_fit',
  'min_actionability_score',
  'min_eye_score_ema',
  'min_composite_eligibility'
]);

function invokeStrategyResolver(op: string, args: AnyObj = {}): AnyObj {
  const payload = Buffer.from(
    JSON.stringify({ op, args: args && typeof args === 'object' ? args : {} }),
    'utf8'
  ).toString('base64');

  const out = bridge.run(['invoke', `--payload-base64=${payload}`]);
  if (!out || out.ok !== true || !out.payload || out.payload.ok !== true) {
    const reason = out && out.payload && (out.payload.error || out.payload.reason)
      ? String(out.payload.error || out.payload.reason)
      : 'strategy_resolver_bridge_failed';
    throw new Error(reason);
  }
  return out.payload;
}

function listStrategies(options: AnyObj = {}): AnyObj[] {
  const result = invokeStrategyResolver('listStrategies', { ...(options || {}) }).result;
  return Array.isArray(result) ? result : [];
}

function loadActiveStrategy(options: AnyObj = {}): AnyObj | null {
  const result = invokeStrategyResolver('loadActiveStrategy', { ...(options || {}) }).result;
  if (!result || typeof result !== 'object') return null;
  return result;
}

function effectiveAllowedRisks(defaultSet, strategy): Set<string> {
  const defaults = defaultSet instanceof Set ? Array.from(defaultSet) : [];
  const result = invokeStrategyResolver('effectiveAllowedRisks', {
    defaultSet: defaults,
    strategy: strategy && typeof strategy === 'object' ? strategy : null
  }).result;
  if (!Array.isArray(result)) return new Set(defaults.map((x) => String(x).toLowerCase()));
  return new Set(result.map((x) => String(x).toLowerCase()).filter(Boolean));
}

function applyThresholdOverrides(baseThresholds, strategy) {
  const result = invokeStrategyResolver('applyThresholdOverrides', {
    baseThresholds: baseThresholds && typeof baseThresholds === 'object' ? baseThresholds : {},
    strategy: strategy && typeof strategy === 'object' ? strategy : null
  }).result;
  return result && typeof result === 'object' ? result : { ...(baseThresholds || {}) };
}

function strategyExecutionMode(strategy, fallback = 'execute') {
  const result = invokeStrategyResolver('strategyExecutionMode', {
    strategy: strategy && typeof strategy === 'object' ? strategy : null,
    fallback
  }).result;
  const mode = String(result == null ? '' : result).toLowerCase();
  if (mode === 'score_only' || mode === 'canary_execute' || mode === 'execute') return mode;
  return 'execute';
}

function strategyGenerationMode(strategy, fallback = 'hyper-creative') {
  const result = invokeStrategyResolver('strategyGenerationMode', {
    strategy: strategy && typeof strategy === 'object' ? strategy : null,
    fallback
  }).result;
  const mode = String(result == null ? '' : result).toLowerCase();
  if (['normal', 'narrative', 'creative', 'hyper-creative', 'deep-thinker'].includes(mode)) {
    return mode;
  }
  return 'hyper-creative';
}

function strategyCanaryDailyExecLimit(strategy, fallback = null) {
  const result = invokeStrategyResolver('strategyCanaryDailyExecLimit', {
    strategy: strategy && typeof strategy === 'object' ? strategy : null,
    fallback
  }).result;
  if (result == null || String(result).trim() === '') return null;
  const n = Number(result);
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(20, Math.round(n)));
}

function strategyBudgetCaps(strategy: AnyObj, defaults: AnyObj = {}): AnyObj {
  const result = invokeStrategyResolver('strategyBudgetCaps', {
    strategy: strategy && typeof strategy === 'object' ? strategy : null,
    defaults: defaults && typeof defaults === 'object' ? defaults : {}
  }).result;
  return result && typeof result === 'object' ? result : {};
}

function strategyExplorationPolicy(strategy: AnyObj, defaults: AnyObj = {}): AnyObj {
  const result = invokeStrategyResolver('strategyExplorationPolicy', {
    strategy: strategy && typeof strategy === 'object' ? strategy : null,
    defaults: defaults && typeof defaults === 'object' ? defaults : {}
  }).result;
  return result && typeof result === 'object'
    ? result
    : {
      fraction: Number.isFinite(Number(defaults.fraction)) ? Number(defaults.fraction) : 0.25,
      every_n: Number.isFinite(Number(defaults.every_n)) ? Number(defaults.every_n) : 3,
      min_eligible: Number.isFinite(Number(defaults.min_eligible)) ? Number(defaults.min_eligible) : 3
    };
}

function resolveStrategyRankingContext(strategy, context: AnyObj = {}) {
  const result = invokeStrategyResolver('resolveStrategyRankingContext', {
    strategy: strategy && typeof strategy === 'object' ? strategy : null,
    context: context && typeof context === 'object' ? context : {}
  }).result;
  return result && typeof result === 'object'
    ? result
    : {
      objective_id: null,
      value_currency: null,
      weights: {},
      applied_overrides: []
    };
}

function strategyRankingWeights(strategy, context: AnyObj = {}) {
  const result = invokeStrategyResolver('strategyRankingWeights', {
    strategy: strategy && typeof strategy === 'object' ? strategy : null,
    context: context && typeof context === 'object' ? context : {}
  }).result;
  return result && typeof result === 'object' ? result : {};
}

function strategyCampaigns(strategy: AnyObj, activeOnly: boolean = false): AnyObj[] {
  const result = invokeStrategyResolver('strategyCampaigns', {
    strategy: strategy && typeof strategy === 'object' ? strategy : null,
    activeOnly: activeOnly === true
  }).result;
  return Array.isArray(result) ? result : [];
}

function strategyAllowsProposalType(strategy, proposalType) {
  const result = invokeStrategyResolver('strategyAllowsProposalType', {
    strategy: strategy && typeof strategy === 'object' ? strategy : null,
    proposalType
  }).result;
  return result === true;
}

function strategyPromotionPolicy(strategy, defaults = {}) {
  const result = invokeStrategyResolver('strategyPromotionPolicy', {
    strategy: strategy && typeof strategy === 'object' ? strategy : null,
    defaults: defaults && typeof defaults === 'object' ? defaults : {}
  }).result;
  return result && typeof result === 'object' ? result : {};
}

function strategyMaxRiskPerAction(strategy, fallback = null) {
  const result = invokeStrategyResolver('strategyMaxRiskPerAction', {
    strategy: strategy && typeof strategy === 'object' ? strategy : null,
    fallback
  }).result;
  if (result == null || String(result).trim() === '') return null;
  const v = Number(result);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function strategyDuplicateWindowHours(strategy, fallback = 24) {
  const result = invokeStrategyResolver('strategyDuplicateWindowHours', {
    strategy: strategy && typeof strategy === 'object' ? strategy : null,
    fallback
  }).result;
  const v = Number(result);
  if (!Number.isFinite(v)) return 24;
  return Math.max(1, Math.min(168, Math.round(v)));
}

module.exports = {
  DEFAULT_STRATEGY_DIR,
  THRESHOLD_KEYS,
  listStrategies,
  loadActiveStrategy,
  effectiveAllowedRisks,
  applyThresholdOverrides,
  strategyExecutionMode,
  strategyGenerationMode,
  strategyCanaryDailyExecLimit,
  strategyBudgetCaps,
  strategyExplorationPolicy,
  strategyRankingWeights,
  resolveStrategyRankingContext,
  strategyCampaigns,
  strategyAllowsProposalType,
  strategyPromotionPolicy,
  strategyMaxRiskPerAction,
  strategyDuplicateWindowHours
};
