#!/usr/bin/env node
'use strict';
export {};
/**
 * autonomy_controller.js — bounded autonomy loop v0
 *
 * Deterministic, single-step controller:
 * - Select at most one proposal per run (WIP=1)
 * - Enforce initialization gates (stub/score/route preflight)
 * - Enforce repeat gates (no-progress streak + dopamine momentum + daily token cap)
 * - Execute via route_execute.js (ROUTER_ENABLED=1 by default)
 * - Log experiment cards + run events for auditability
 *
 * Feature flag:
 * - AUTONOMY_ENABLED=1 required for run command
 *
 * Usage:
 *   node systems/autonomy/autonomy_controller.js run [YYYY-MM-DD]
 *   node systems/autonomy/autonomy_controller.js status [YYYY-MM-DD]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadActiveDirectives } = require('../../lib/directive_resolver');
const { writeContractReceipt } = require('../../lib/action_receipts');
const { isEmergencyStopEngaged } = require('../../lib/emergency_stop');
const { compactCommandOutput } = require('../../lib/command_output_compactor');
const {
  loadOutcomeFitnessPolicy,
  proposalTypeThresholdOffsetsFor
} = require('../../lib/outcome_fitness');
const { evaluateSuccessCriteria } = require('../../lib/success_criteria_verifier');
const {
  toSuccessCriteriaRecord,
  withSuccessCriteriaVerification,
  normalizeAutonomyReceiptForWrite
} = require('../../lib/autonomy_receipt_schema');
const { evaluateTernaryBelief } = require('../../lib/ternary_belief_engine');
const {
  loadTritShadowPolicy,
  loadTritShadowTrustState,
  buildTritSourceTrustMap,
  evaluateTritShadowProductivity
} = require('../../lib/trit_shadow_control');
const { resolveCatalogPath } = require('../../lib/eyes_catalog');
const { evaluatePipelineSpcGate } = require('./pipeline_spc_gate');
const {
  listStrategies,
  loadActiveStrategy,
  applyThresholdOverrides,
  effectiveAllowedRisks,
  strategyExecutionMode,
  strategyBudgetCaps,
  strategyExplorationPolicy,
  resolveStrategyRankingContext,
  strategyAllowsProposalType,
  strategyMaxRiskPerAction,
  strategyDuplicateWindowHours,
  strategyCanaryDailyExecLimit
} = require('../../lib/strategy_resolver');
const {
  annotateCampaignPriority,
  buildCampaignDecompositionPlans
} = require('../../lib/strategy_campaign_scheduler');
const { classifyProposalType } = require('../../lib/proposal_type_classifier');
const {
  evaluateTier1Governance,
  classifyAndRecordException,
  summarizeExceptionMemory,
  exceptionRecoveryDecision
} = require('./tier1_governance');
const {
  DEFAULT_STATE_DIR: GLOBAL_BUDGET_STATE_DIR,
  loadSystemBudgetState,
  saveSystemBudgetState,
  recordSystemBudgetUsage,
  writeSystemBudgetDecision,
  loadSystemBudgetAutopauseState,
  setSystemBudgetAutopause
} = require('../budget/system_budget');
const {
  startPainFocusSession,
  stopPainFocusSession
} = require('./pain_signal');
const { runBacklogAutoscalePrimitive } = require('./backlog_autoscale_rust_bridge.js');

type AnyObj = Record<string, any>;

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROPOSALS_DIR = path.join(REPO_ROOT, 'state', 'sensory', 'proposals');
const QUEUE_DECISIONS_DIR = path.join(REPO_ROOT, 'state', 'queue', 'decisions');
const DOPAMINE_STATE_PATH = path.join(REPO_ROOT, 'state', 'dopamine_state.json');
const DAILY_LOGS_DIR = path.join(REPO_ROOT, 'state', 'daily_logs');
const HABIT_REGISTRY_PATH = path.join(REPO_ROOT, 'habits', 'registry.json');
const HABIT_RUNS_LOG_PATH = path.join(REPO_ROOT, 'habits', 'logs', 'habit_runs.ndjson');
const HABIT_ERRORS_LOG_PATH = path.join(REPO_ROOT, 'habits', 'logs', 'habit_errors.ndjson');
const EYES_CONFIG_PATH = resolveCatalogPath(REPO_ROOT);
const EYES_STATE_REGISTRY_PATH = path.join(REPO_ROOT, 'state', 'sensory', 'eyes', 'registry.json');
const MODEL_CATALOG_LOOP_SCRIPT = path.join(REPO_ROOT, 'systems', 'autonomy', 'model_catalog_loop.js');
const PROPOSAL_ENRICHER_SCRIPT = path.join(REPO_ROOT, 'systems', 'autonomy', 'proposal_enricher.js');
const STRATEGY_READINESS_SCRIPT = path.join(REPO_ROOT, 'systems', 'autonomy', 'strategy_readiness.js');
const ACTUATION_EXECUTOR_SCRIPT = path.join(REPO_ROOT, 'systems', 'actuation', 'actuation_executor.js');
const DIRECTIVE_HIERARCHY_CONTROLLER_SCRIPT = path.join(REPO_ROOT, 'systems', 'security', 'directive_hierarchy_controller.js');
const MODEL_CATALOG_AUDIT_PATH = process.env.AUTONOMY_MODEL_CATALOG_AUDIT_PATH
  ? path.resolve(process.env.AUTONOMY_MODEL_CATALOG_AUDIT_PATH)
  : path.join(REPO_ROOT, 'state', 'routing', 'model_catalog_audit.jsonl');
const MODEL_CATALOG_PROPOSALS_DIR = path.join(REPO_ROOT, 'state', 'routing', 'model_catalog_proposals');
const MODEL_CATALOG_TRIALS_DIR = path.join(REPO_ROOT, 'state', 'routing', 'model_catalog_trials');
const MODEL_CATALOG_CANARY_PATH = process.env.AUTONOMY_MODEL_CATALOG_CANARY_PATH
  ? path.resolve(process.env.AUTONOMY_MODEL_CATALOG_CANARY_PATH)
  : path.join(REPO_ROOT, 'state', 'routing', 'model_catalog_canary.json');
const MODEL_CATALOG_ROLLBACK_SCRIPT = process.env.AUTONOMY_MODEL_CATALOG_ROLLBACK_SCRIPT
  ? path.resolve(process.env.AUTONOMY_MODEL_CATALOG_ROLLBACK_SCRIPT)
  : path.join(REPO_ROOT, 'systems', 'autonomy', 'model_catalog_rollback.js');
const SPAWN_STATE_DIR = process.env.SPAWN_STATE_DIR
  ? path.resolve(process.env.SPAWN_STATE_DIR)
  : path.join(REPO_ROOT, 'state', 'spawn');
const SPAWN_EVENTS_PATH = process.env.SPAWN_EVENTS_PATH
  ? path.resolve(process.env.SPAWN_EVENTS_PATH)
  : path.join(SPAWN_STATE_DIR, 'events.jsonl');
const SPAWN_BROKER_SCRIPT = process.env.SPAWN_BROKER_SCRIPT
  ? path.resolve(process.env.SPAWN_BROKER_SCRIPT)
  : path.join(REPO_ROOT, 'systems', 'spawn', 'spawn_broker.js');

const AUTONOMY_DIR = process.env.AUTONOMY_STATE_DIR
  ? path.resolve(process.env.AUTONOMY_STATE_DIR)
  : path.join(REPO_ROOT, 'state', 'autonomy');
const AUTONOMY_RUN_LOCK_PATH = process.env.AUTONOMY_RUN_LOCK_PATH
  ? path.resolve(process.env.AUTONOMY_RUN_LOCK_PATH)
  : path.join(AUTONOMY_DIR, 'run.lock');
const RUNS_DIR = process.env.AUTONOMY_RUNS_DIR
  ? path.resolve(process.env.AUTONOMY_RUNS_DIR)
  : path.join(AUTONOMY_DIR, 'runs');
const EXPERIMENTS_DIR = process.env.AUTONOMY_EXPERIMENTS_DIR
  ? path.resolve(process.env.AUTONOMY_EXPERIMENTS_DIR)
  : path.join(AUTONOMY_DIR, 'experiments');
const DAILY_BUDGET_DIR = process.env.AUTONOMY_DAILY_BUDGET_DIR
  ? path.resolve(process.env.AUTONOMY_DAILY_BUDGET_DIR)
  : GLOBAL_BUDGET_STATE_DIR;
const RECEIPTS_DIR = process.env.AUTONOMY_RECEIPTS_DIR
  ? path.resolve(process.env.AUTONOMY_RECEIPTS_DIR)
  : path.join(AUTONOMY_DIR, 'receipts');
const OUTCOME_FALLBACK_DIR = process.env.AUTONOMY_OUTCOME_FALLBACK_DIR
  ? path.resolve(process.env.AUTONOMY_OUTCOME_FALLBACK_DIR)
  : path.join(AUTONOMY_DIR, 'outcome_fallback');
const NON_YIELD_LEDGER_PATH = process.env.AUTONOMY_NON_YIELD_LEDGER_PATH
  ? path.resolve(process.env.AUTONOMY_NON_YIELD_LEDGER_PATH)
  : path.join(AUTONOMY_DIR, 'non_yield_ledger.jsonl');
const COOLDOWNS_PATH = process.env.AUTONOMY_COOLDOWNS_PATH
  ? path.resolve(process.env.AUTONOMY_COOLDOWNS_PATH)
  : path.join(AUTONOMY_DIR, 'cooldowns.json');
const CALIBRATION_PATH = process.env.AUTONOMY_CALIBRATION_PATH
  ? path.resolve(process.env.AUTONOMY_CALIBRATION_PATH)
  : path.join(AUTONOMY_DIR, 'calibration.json');
const SUCCESS_CRITERIA_PATTERN_STATE_PATH = process.env.AUTONOMY_SUCCESS_CRITERIA_PATTERN_STATE_PATH
  ? path.resolve(process.env.AUTONOMY_SUCCESS_CRITERIA_PATTERN_STATE_PATH)
  : path.join(AUTONOMY_DIR, 'success_criteria_pattern_memory.json');
const SHORT_CIRCUIT_PATH = process.env.AUTONOMY_SHORT_CIRCUIT_PATH
  ? path.resolve(process.env.AUTONOMY_SHORT_CIRCUIT_PATH)
  : path.join(AUTONOMY_DIR, 'short_circuit.json');
const BACKLOG_AUTOSCALE_STATE_PATH = process.env.AUTONOMY_BACKLOG_AUTOSCALE_STATE_PATH
  ? path.resolve(process.env.AUTONOMY_BACKLOG_AUTOSCALE_STATE_PATH)
  : path.join(AUTONOMY_DIR, 'backlog_autoscale.json');
const HUMAN_CANARY_OVERRIDE_PATH = process.env.HUMAN_CANARY_OVERRIDE_PATH
  ? path.resolve(process.env.HUMAN_CANARY_OVERRIDE_PATH)
  : path.join(REPO_ROOT, 'state', 'security', 'human_canary_override.json');
const HUMAN_CANARY_OVERRIDE_AUDIT_PATH = process.env.HUMAN_CANARY_OVERRIDE_AUDIT_PATH
  ? path.resolve(process.env.HUMAN_CANARY_OVERRIDE_AUDIT_PATH)
  : path.join(REPO_ROOT, 'state', 'security', 'human_canary_override.jsonl');
const AUTONOMY_HUMAN_ESCALATION_LOG_PATH = process.env.AUTONOMY_HUMAN_ESCALATION_LOG_PATH
  ? path.resolve(process.env.AUTONOMY_HUMAN_ESCALATION_LOG_PATH)
  : path.join(REPO_ROOT, 'state', 'security', 'autonomy_human_escalations.jsonl');
const AUTONOMY_TIER1_EXCEPTION_MEMORY_PATH = process.env.AUTONOMY_TIER1_EXCEPTION_MEMORY_PATH
  ? path.resolve(process.env.AUTONOMY_TIER1_EXCEPTION_MEMORY_PATH)
  : path.join(AUTONOMY_DIR, 'exception_memory.json');
const AUTONOMY_TIER1_EXCEPTION_AUDIT_PATH = process.env.AUTONOMY_TIER1_EXCEPTION_AUDIT_PATH
  ? path.resolve(process.env.AUTONOMY_TIER1_EXCEPTION_AUDIT_PATH)
  : path.join(AUTONOMY_DIR, 'exception_events.jsonl');
const AUTONOMY_TIER1_EXCEPTION_POLICY_PATH = process.env.AUTONOMY_TIER1_EXCEPTION_POLICY_PATH
  ? path.resolve(process.env.AUTONOMY_TIER1_EXCEPTION_POLICY_PATH)
  : path.join(REPO_ROOT, 'config', 'autonomy_exception_recovery_policy.json');

const DAILY_TOKEN_CAP = Number(process.env.AUTONOMY_DAILY_TOKEN_CAP || 4000);
const NO_CHANGE_LIMIT = Number(process.env.AUTONOMY_NO_CHANGE_LIMIT || 2);
const NO_CHANGE_COOLDOWN_HOURS = Number(process.env.AUTONOMY_NO_CHANGE_COOLDOWN_HOURS || 24);
const REVERT_COOLDOWN_HOURS = Number(process.env.AUTONOMY_REVERT_COOLDOWN_HOURS || 48);
const AUTONOMY_REPEAT_NO_PROGRESS_LIMIT = Number(process.env.AUTONOMY_REPEAT_NO_PROGRESS_LIMIT || 2);
const AUTONOMY_MIN_PROPOSAL_SCORE = Number(process.env.AUTONOMY_MIN_PROPOSAL_SCORE || 0);
const AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS = Number(process.env.AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS || 12);
const AUTONOMY_ROUTE_BLOCK_PREFILTER_ENABLED = String(process.env.AUTONOMY_ROUTE_BLOCK_PREFILTER_ENABLED || '1') !== '0';
const AUTONOMY_ROUTE_BLOCK_PREFILTER_WINDOW_HOURS = Math.max(1, Number(process.env.AUTONOMY_ROUTE_BLOCK_PREFILTER_WINDOW_HOURS || 24));
const AUTONOMY_ROUTE_BLOCK_PREFILTER_MAX_EVENTS = Math.max(50, Number(process.env.AUTONOMY_ROUTE_BLOCK_PREFILTER_MAX_EVENTS || 800));
const AUTONOMY_ROUTE_BLOCK_PREFILTER_MIN_OBSERVATIONS = Math.max(1, Number(process.env.AUTONOMY_ROUTE_BLOCK_PREFILTER_MIN_OBSERVATIONS || 2));
const AUTONOMY_ROUTE_BLOCK_PREFILTER_MAX_RATE = clampNumber(Number(process.env.AUTONOMY_ROUTE_BLOCK_PREFILTER_MAX_RATE || 0.7), 0.2, 1);
const AUTONOMY_MIN_DOPAMINE_LAST_SCORE = Number(process.env.AUTONOMY_MIN_DOPAMINE_LAST_SCORE || 0);
const AUTONOMY_MIN_DOPAMINE_AVG7 = Number(process.env.AUTONOMY_MIN_DOPAMINE_AVG7 || 0);
const AUTONOMY_MIN_ROUTE_TOKENS = Number(process.env.AUTONOMY_MIN_ROUTE_TOKENS || 500);
const AUTONOMY_SKIP_STUB = String(process.env.AUTONOMY_SKIP_STUB || '1') !== '0';
const AUTONOMY_MAX_RUNS_PER_DAY = Number(process.env.AUTONOMY_MAX_RUNS_PER_DAY || 4);
const AUTONOMY_MIN_DAILY_EXECUTIONS = Math.max(0, Number(process.env.AUTONOMY_MIN_DAILY_EXECUTIONS || 1));
const AUTONOMY_MIN_MINUTES_BETWEEN_RUNS = Number(process.env.AUTONOMY_MIN_MINUTES_BETWEEN_RUNS || 15);
const AUTONOMY_POLICY_HOLD_COOLDOWN_MINUTES = Number(process.env.AUTONOMY_POLICY_HOLD_COOLDOWN_MINUTES || AUTONOMY_MIN_MINUTES_BETWEEN_RUNS);
const AUTONOMY_POLICY_HOLD_PRESSURE_WINDOW_HOURS = Math.max(1, Number(process.env.AUTONOMY_POLICY_HOLD_PRESSURE_WINDOW_HOURS || 24));
const AUTONOMY_POLICY_HOLD_PRESSURE_MIN_SAMPLES = Math.max(1, Number(process.env.AUTONOMY_POLICY_HOLD_PRESSURE_MIN_SAMPLES || 6));
const AUTONOMY_POLICY_HOLD_PRESSURE_WARN_RATE = clampNumber(
  Number(process.env.AUTONOMY_POLICY_HOLD_PRESSURE_WARN_RATE || 0.25),
  0.05,
  1
);
const AUTONOMY_POLICY_HOLD_PRESSURE_HARD_RATE = clampNumber(
  Number(process.env.AUTONOMY_POLICY_HOLD_PRESSURE_HARD_RATE || 0.4),
  AUTONOMY_POLICY_HOLD_PRESSURE_WARN_RATE,
  1
);
const AUTONOMY_POLICY_HOLD_COOLDOWN_WARN_MINUTES = Math.max(
  AUTONOMY_POLICY_HOLD_COOLDOWN_MINUTES,
  Number(process.env.AUTONOMY_POLICY_HOLD_COOLDOWN_WARN_MINUTES || Math.max(AUTONOMY_POLICY_HOLD_COOLDOWN_MINUTES * 2, 30))
);
const AUTONOMY_POLICY_HOLD_COOLDOWN_HARD_MINUTES = Math.max(
  AUTONOMY_POLICY_HOLD_COOLDOWN_WARN_MINUTES,
  Number(process.env.AUTONOMY_POLICY_HOLD_COOLDOWN_HARD_MINUTES || Math.max(AUTONOMY_POLICY_HOLD_COOLDOWN_MINUTES * 4, 60))
);
const AUTONOMY_POLICY_HOLD_COOLDOWN_CAP_MINUTES = Math.max(
  AUTONOMY_POLICY_HOLD_COOLDOWN_HARD_MINUTES,
  Number(process.env.AUTONOMY_POLICY_HOLD_COOLDOWN_CAP_MINUTES || 180)
);
const AUTONOMY_POLICY_HOLD_COOLDOWN_MANUAL_REVIEW_MINUTES = Math.max(
  AUTONOMY_POLICY_HOLD_COOLDOWN_HARD_MINUTES,
  Number(process.env.AUTONOMY_POLICY_HOLD_COOLDOWN_MANUAL_REVIEW_MINUTES || 90)
);
const AUTONOMY_POLICY_HOLD_COOLDOWN_UNCHANGED_STATE_MINUTES = Math.max(
  AUTONOMY_POLICY_HOLD_COOLDOWN_WARN_MINUTES,
  Number(process.env.AUTONOMY_POLICY_HOLD_COOLDOWN_UNCHANGED_STATE_MINUTES || 90)
);
const AUTONOMY_POLICY_HOLD_COOLDOWN_UNTIL_NEXT_DAY_CAPS = String(process.env.AUTONOMY_POLICY_HOLD_COOLDOWN_UNTIL_NEXT_DAY_CAPS || '1') !== '0';
const AUTONOMY_POLICY_HOLD_DAMPENER_ENABLED = String(process.env.AUTONOMY_POLICY_HOLD_DAMPENER_ENABLED || '1') !== '0';
const AUTONOMY_POLICY_HOLD_DAMPENER_WINDOW_HOURS = Math.max(1, Number(process.env.AUTONOMY_POLICY_HOLD_DAMPENER_WINDOW_HOURS || 24));
const AUTONOMY_POLICY_HOLD_DAMPENER_REPEAT_THRESHOLD = Math.max(2, Number(process.env.AUTONOMY_POLICY_HOLD_DAMPENER_REPEAT_THRESHOLD || 2));
const AUTONOMY_POLICY_HOLD_DAMPENER_COOLDOWN_HOURS = Math.max(1, Number(process.env.AUTONOMY_POLICY_HOLD_DAMPENER_COOLDOWN_HOURS || 6));
const AUTONOMY_READINESS_RETRY_COOLDOWN_HOURS = Math.max(0, Number(process.env.AUTONOMY_READINESS_RETRY_COOLDOWN_HOURS || 2));
const AUTONOMY_UNCHANGED_SHORT_CIRCUIT_ENABLED = String(process.env.AUTONOMY_UNCHANGED_SHORT_CIRCUIT_ENABLED || '1') !== '0';
const AUTONOMY_UNCHANGED_SHORT_CIRCUIT_MINUTES = Number(process.env.AUTONOMY_UNCHANGED_SHORT_CIRCUIT_MINUTES || 30);
const AUTONOMY_MAX_EYE_NO_PROGRESS_24H = Number(process.env.AUTONOMY_MAX_EYE_NO_PROGRESS_24H || 2);
const AUTONOMY_DOD_ALLOW_PROPOSE_SHIPPED = String(process.env.AUTONOMY_DOD_ALLOW_PROPOSE_SHIPPED || '0') === '1';
const AUTONOMY_DOD_MIN_ARTIFACT_DELTA = Number(process.env.AUTONOMY_DOD_MIN_ARTIFACT_DELTA || 1);
const AUTONOMY_DOD_MIN_ENTRY_DELTA = Number(process.env.AUTONOMY_DOD_MIN_ENTRY_DELTA || 1);
const AUTONOMY_DOD_MIN_REVENUE_DELTA = Number(process.env.AUTONOMY_DOD_MIN_REVENUE_DELTA || 1);
const AUTONOMY_DOD_MIN_HABIT_OUTCOME_SCORE = Number(process.env.AUTONOMY_DOD_MIN_HABIT_OUTCOME_SCORE || 0.7);
const AUTONOMY_DOD_EXEC_WINDOW_SLOP_MS = Number(process.env.AUTONOMY_DOD_EXEC_WINDOW_SLOP_MS || 30000);
const AUTONOMY_ONLY_OPEN_PROPOSALS = String(process.env.AUTONOMY_ONLY_OPEN_PROPOSALS || '1') !== '0';
const AUTONOMY_QUEUE_UNDERFLOW_BACKFILL_MAX = Math.max(0, Number(process.env.AUTONOMY_QUEUE_UNDERFLOW_BACKFILL_MAX || 1));
const AUTONOMY_ALLOWED_RISKS = new Set(
  String(process.env.AUTONOMY_ALLOWED_RISKS || 'low')
    .split(',')
    .map(s => String(s || '').trim().toLowerCase())
    .filter(Boolean)
);
const AUTONOMY_POSTCHECK_CONTRACT = String(process.env.AUTONOMY_POSTCHECK_CONTRACT || '1') !== '0';
const AUTONOMY_POSTCHECK_ADAPTER_TESTS = String(process.env.AUTONOMY_POSTCHECK_ADAPTER_TESTS || '1') !== '0';
const AUTONOMY_POSTCHECK_EXTERNAL_VERIFY = String(process.env.AUTONOMY_POSTCHECK_EXTERNAL_VERIFY || '1') !== '0';
const AUTONOMY_MIN_SIGNAL_QUALITY = Number(process.env.AUTONOMY_MIN_SIGNAL_QUALITY || 58);
const AUTONOMY_MIN_SENSORY_SIGNAL_SCORE = Number(process.env.AUTONOMY_MIN_SENSORY_SIGNAL_SCORE || 45);
const AUTONOMY_MIN_SENSORY_RELEVANCE_SCORE = Number(process.env.AUTONOMY_MIN_SENSORY_RELEVANCE_SCORE || 42);
const AUTONOMY_MIN_DIRECTIVE_FIT = Number(process.env.AUTONOMY_MIN_DIRECTIVE_FIT || 40);
const AUTONOMY_MIN_ACTIONABILITY_SCORE = Number(process.env.AUTONOMY_MIN_ACTIONABILITY_SCORE || 45);
const AUTONOMY_MIN_COMPOSITE_ELIGIBILITY = Number(process.env.AUTONOMY_MIN_COMPOSITE_ELIGIBILITY || 62);
const AUTONOMY_MIN_EYE_SCORE_EMA = Number(process.env.AUTONOMY_MIN_EYE_SCORE_EMA || 45);
const AUTONOMY_OPTIMIZATION_MIN_DELTA_PERCENT = clampNumber(Number(process.env.AUTONOMY_OPTIMIZATION_MIN_DELTA_PERCENT || 10), 1, 50);
const AUTONOMY_OPTIMIZATION_MIN_DELTA_PERCENT_HIGH_ACCURACY = clampNumber(Number(process.env.AUTONOMY_OPTIMIZATION_MIN_DELTA_PERCENT_HIGH_ACCURACY || 5), 1, 50);
const AUTONOMY_OPTIMIZATION_HIGH_ACCURACY_MODE = String(process.env.AUTONOMY_OPTIMIZATION_HIGH_ACCURACY_MODE || '0') === '1';
const AUTONOMY_OPTIMIZATION_REQUIRE_DELTA = String(process.env.AUTONOMY_OPTIMIZATION_REQUIRE_DELTA || '1') !== '0';
const AUTONOMY_SUBDIRECTIVE_V2_REQUIRED = String(process.env.AUTONOMY_SUBDIRECTIVE_V2_REQUIRED || '1') !== '0';
const AUTONOMY_SUBDIRECTIVE_V2_EXEMPT_TYPES = new Set(
  String(process.env.AUTONOMY_SUBDIRECTIVE_V2_EXEMPT_TYPES || 'directive_clarification,directive_decomposition')
    .split(',')
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean)
);
const AUTONOMY_DOPAMINE_REQUIRE_VERIFIED_PROGRESS = String(process.env.AUTONOMY_DOPAMINE_REQUIRE_VERIFIED_PROGRESS || '1') !== '0';
const AUTONOMY_UNLINKED_OPTIMIZATION_PENALTY = Math.max(0, Number(process.env.AUTONOMY_UNLINKED_OPTIMIZATION_PENALTY || 18));
const AUTONOMY_UNLINKED_OPTIMIZATION_HARD_BLOCK_HIGH_RISK = String(process.env.AUTONOMY_UNLINKED_OPTIMIZATION_HARD_BLOCK_HIGH_RISK || '1') !== '0';
const AUTONOMY_UNLINKED_OPTIMIZATION_EXEMPT_TYPES = new Set(
  String(process.env.AUTONOMY_UNLINKED_OPTIMIZATION_EXEMPT_TYPES || 'directive_clarification,human_escalation')
    .split(',')
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean)
);
const ADAPTIVE_MUTATION_TYPE_RE = /\b(adaptive[_-]?mutation|mutation(?:[_-]proposal)?|topology[_-]?mutation|genome[_-]?mutation|self[_-]?(?:mutation|modify)|branch[_-]?(?:rewire|prune))\b/i;
const ADAPTIVE_MUTATION_SIGNAL_RE = /\b(mutation(?:[_-]?(?:guard|policy|kernel|budget|ttl|quarantine|veto|rollback|lineage|attestation))?|topology[_-]?mutation|genome[_-]?mutation|self[_-]?(?:mutation|modify)|branch[_-]?(?:rewire|prune))\b/i;
const AUTONOMY_REQUIRE_ADMISSION_PREVIEW = String(process.env.AUTONOMY_REQUIRE_ADMISSION_PREVIEW || '1') !== '0';
const AUTONOMY_MUTATION_EXECUTION_GUARD_REQUIRED = String(process.env.AUTONOMY_MUTATION_EXECUTION_GUARD_REQUIRED || '1') !== '0';
const AUTONOMY_MUTATION_EXECUTION_GUARD_COOLDOWN_HOURS = Math.max(1, Number(process.env.AUTONOMY_MUTATION_EXECUTION_GUARD_COOLDOWN_HOURS || 6));
const AUTONOMY_MAX_PROPOSAL_FILE_AGE_HOURS = Number(process.env.AUTONOMY_MAX_PROPOSAL_FILE_AGE_HOURS || 48);
const AUTONOMY_REPEAT_EXHAUSTED_LIMIT = Number(process.env.AUTONOMY_REPEAT_EXHAUSTED_LIMIT || 3);
const AUTONOMY_REPEAT_EXHAUSTED_COOLDOWN_MINUTES = Number(process.env.AUTONOMY_REPEAT_EXHAUSTED_COOLDOWN_MINUTES || 90);
const AUTONOMY_BUDGET_AUTOPAUSE_MINUTES = Math.max(5, Number(process.env.AUTONOMY_BUDGET_AUTOPAUSE_MINUTES || 60));
const AUTONOMY_BUDGET_AUTOPAUSE_CANARY_BYPASS_ENABLED = String(process.env.AUTONOMY_BUDGET_AUTOPAUSE_CANARY_BYPASS_ENABLED || '1') !== '0';
const AUTONOMY_BUDGET_AUTOPAUSE_CANARY_BYPASS_MAX_PER_DAY = Math.max(0, Number(process.env.AUTONOMY_BUDGET_AUTOPAUSE_CANARY_BYPASS_MAX_PER_DAY || 1));
const AUTONOMY_BUDGET_AUTOPAUSE_CANARY_BYPASS_MAX_TOKENS = Math.max(
  100,
  Number(process.env.AUTONOMY_BUDGET_AUTOPAUSE_CANARY_BYPASS_MAX_TOKENS || 2200)
);
const AUTONOMY_NON_YIELD_LEDGER_ENABLED = String(process.env.AUTONOMY_NON_YIELD_LEDGER_ENABLED || '1') !== '0';
const AUTONOMY_BUDGET_PACING_ENABLED = String(process.env.AUTONOMY_BUDGET_PACING_ENABLED || '1') !== '0';
const AUTONOMY_BUDGET_PACING_MIN_REMAINING_RATIO = clampNumber(Number(process.env.AUTONOMY_BUDGET_PACING_MIN_REMAINING_RATIO || 0.2), 0, 1);
const AUTONOMY_BUDGET_PACING_HIGH_TOKEN_THRESHOLD = Math.max(100, Number(process.env.AUTONOMY_BUDGET_PACING_HIGH_TOKEN_THRESHOLD || 900));
const AUTONOMY_BUDGET_PACING_MIN_VALUE_SIGNAL = clampNumber(Number(process.env.AUTONOMY_BUDGET_PACING_MIN_VALUE_SIGNAL || 65), 0, 100);
const AUTONOMY_BUDGET_EXECUTION_RESERVE_ENABLED = String(process.env.AUTONOMY_BUDGET_EXECUTION_RESERVE_ENABLED || '1') !== '0';
const AUTONOMY_BUDGET_EXECUTION_RESERVE_RATIO = clampNumber(
  Number(process.env.AUTONOMY_BUDGET_EXECUTION_RESERVE_RATIO || 0.12),
  0,
  0.9
);
const AUTONOMY_BUDGET_EXECUTION_RESERVE_MIN_TOKENS = Math.max(
  0,
  Number(process.env.AUTONOMY_BUDGET_EXECUTION_RESERVE_MIN_TOKENS || 600)
);
const AUTONOMY_BUDGET_EXECUTION_RESERVE_MIN_VALUE_SIGNAL = clampNumber(
  Number(process.env.AUTONOMY_BUDGET_EXECUTION_RESERVE_MIN_VALUE_SIGNAL || 45),
  0,
  100
);
const AUTONOMY_BUDGET_EXECUTION_RESERVE_AUTOPAUSE_BYPASS_ENABLED = String(process.env.AUTONOMY_BUDGET_EXECUTION_RESERVE_AUTOPAUSE_BYPASS_ENABLED || '1') !== '0';
const AUTONOMY_EXPLORE_FRACTION = Number(process.env.AUTONOMY_EXPLORE_FRACTION || 0.25);
const AUTONOMY_EXPLORE_EVERY_N = Number(process.env.AUTONOMY_EXPLORE_EVERY_N || 3);
const AUTONOMY_EXPLORE_MIN_ELIGIBLE = Number(process.env.AUTONOMY_EXPLORE_MIN_ELIGIBLE || 3);
const AUTONOMY_CALIBRATION_ENABLED = String(process.env.AUTONOMY_CALIBRATION_ENABLED || '1') !== '0';
const AUTONOMY_CALIBRATION_WINDOW_DAYS = Number(process.env.AUTONOMY_CALIBRATION_WINDOW_DAYS || 7);
const AUTONOMY_CALIBRATION_MIN_EXECUTED = Number(process.env.AUTONOMY_CALIBRATION_MIN_EXECUTED || 4);
const AUTONOMY_CALIBRATION_MAX_DELTA = Number(process.env.AUTONOMY_CALIBRATION_MAX_DELTA || 10);
const AUTONOMY_CALIBRATION_TIGHTEN_MIN_EXECUTED = Number(process.env.AUTONOMY_CALIBRATION_TIGHTEN_MIN_EXECUTED || 8);
const AUTONOMY_CALIBRATION_TIGHTEN_MIN_SHIPPED_RATE = Number(process.env.AUTONOMY_CALIBRATION_TIGHTEN_MIN_SHIPPED_RATE || 0.25);
const AUTONOMY_CALIBRATION_LOOSEN_LOW_SHIPPED_RATE = Number(process.env.AUTONOMY_CALIBRATION_LOOSEN_LOW_SHIPPED_RATE || 0.2);
const AUTONOMY_CALIBRATION_LOOSEN_EXHAUSTED_THRESHOLD = Number(process.env.AUTONOMY_CALIBRATION_LOOSEN_EXHAUSTED_THRESHOLD || 2);
const AUTONOMY_SCORECARD_WINDOW_DAYS = Number(process.env.AUTONOMY_SCORECARD_WINDOW_DAYS || 7);
const AUTONOMY_SCORECARD_MIN_ATTEMPTS = Number(process.env.AUTONOMY_SCORECARD_MIN_ATTEMPTS || 3);
const AUTONOMY_MODEL_CATALOG_ENABLED = String(process.env.AUTONOMY_MODEL_CATALOG_ENABLED || '1') !== '0';
const AUTONOMY_MODEL_CATALOG_INTERVAL_DAYS = Number(process.env.AUTONOMY_MODEL_CATALOG_INTERVAL_DAYS || 7);
const AUTONOMY_MODEL_CATALOG_SOURCE = String(process.env.AUTONOMY_MODEL_CATALOG_SOURCE || 'auto');
const AUTONOMY_MODEL_CATALOG_AUTO_APPLY = String(process.env.AUTONOMY_MODEL_CATALOG_AUTO_APPLY || '0') === '1';
const AUTONOMY_MODEL_CATALOG_AUTO_APPROVAL_NOTE = String(process.env.AUTONOMY_MODEL_CATALOG_AUTO_APPROVAL_NOTE || '').trim();
const AUTONOMY_MODEL_CATALOG_AUTO_BREAK_GLASS = String(process.env.AUTONOMY_MODEL_CATALOG_AUTO_BREAK_GLASS || '0') === '1';
const AUTONOMY_MODEL_CATALOG_CANARY_ENABLED = String(process.env.AUTONOMY_MODEL_CATALOG_CANARY_ENABLED || '1') !== '0';
const AUTONOMY_MODEL_CATALOG_CANARY_MIN_SAMPLES = Number(process.env.AUTONOMY_MODEL_CATALOG_CANARY_MIN_SAMPLES || 3);
const AUTONOMY_MODEL_CATALOG_CANARY_MAX_FAIL_RATE = Number(process.env.AUTONOMY_MODEL_CATALOG_CANARY_MAX_FAIL_RATE || 0.6);
const AUTONOMY_MODEL_CATALOG_CANARY_MAX_ROUTE_BLOCK_RATE = Number(process.env.AUTONOMY_MODEL_CATALOG_CANARY_MAX_ROUTE_BLOCK_RATE || 0.5);
const AUTONOMY_MODEL_CATALOG_CANARY_ROLLBACK_NOTE = String(process.env.AUTONOMY_MODEL_CATALOG_CANARY_ROLLBACK_NOTE || 'auto rollback: model catalog canary failed');
const AUTONOMY_MODEL_CATALOG_CANARY_ROLLBACK_BREAK_GLASS = String(process.env.AUTONOMY_MODEL_CATALOG_CANARY_ROLLBACK_BREAK_GLASS || '0') === '1';
const AUTONOMY_REQUIRE_READINESS_FOR_EXECUTE = String(process.env.AUTONOMY_REQUIRE_READINESS_FOR_EXECUTE || '1') !== '0';
const AUTONOMY_REQUIRE_SPC_FOR_EXECUTE = String(process.env.AUTONOMY_REQUIRE_SPC_FOR_EXECUTE || '1') !== '0';
const AUTONOMY_SPC_BASELINE_DAYS = Number(process.env.AUTONOMY_SPC_BASELINE_DAYS || 21);
const AUTONOMY_SPC_BASELINE_MIN_DAYS = Number(process.env.AUTONOMY_SPC_BASELINE_MIN_DAYS || 7);
const AUTONOMY_SPC_SIGMA = Number(process.env.AUTONOMY_SPC_SIGMA || 3);
const AUTONOMY_RUN_LOCK_STALE_MINUTES = Number(process.env.AUTONOMY_RUN_LOCK_STALE_MINUTES || 90);
const AUTONOMY_RUN_LOCK_DEAD_PID_GRACE_MINUTES = Math.max(0, Number(process.env.AUTONOMY_RUN_LOCK_DEAD_PID_GRACE_MINUTES || 1));
const AUTONOMY_HARD_MAX_DAILY_RUNS_CAP = Number(process.env.AUTONOMY_HARD_MAX_DAILY_RUNS_CAP || 20);
const AUTONOMY_HARD_MAX_DAILY_TOKEN_CAP = Number(process.env.AUTONOMY_HARD_MAX_DAILY_TOKEN_CAP || 12000);
const AUTONOMY_HARD_MAX_TOKENS_PER_ACTION = Number(process.env.AUTONOMY_HARD_MAX_TOKENS_PER_ACTION || 4000);
const AUTONOMY_HARD_MAX_RISK_PER_ACTION = Number(process.env.AUTONOMY_HARD_MAX_RISK_PER_ACTION || 70);
const AUTONOMY_CANARY_DAILY_EXEC_LIMIT = Number(process.env.AUTONOMY_CANARY_DAILY_EXEC_LIMIT || 1);
const AUTONOMY_CANARY_MEDIUM_RISK_DAILY_EXEC_LIMIT = Number(process.env.AUTONOMY_CANARY_MEDIUM_RISK_DAILY_EXEC_LIMIT || 1);
const AUTONOMY_CANARY_LOW_RISK_COMPOSITE_RELAX = Number(process.env.AUTONOMY_CANARY_LOW_RISK_COMPOSITE_RELAX || 4);
const AUTONOMY_DYNAMIC_IO_CAP_ENABLED = String(process.env.AUTONOMY_DYNAMIC_IO_CAP_ENABLED || '1') !== '0';
const AUTONOMY_DYNAMIC_IO_CAP_WARN_FACTOR = clampNumber(
  Number(process.env.AUTONOMY_DYNAMIC_IO_CAP_WARN_FACTOR || 0.75),
  0.2,
  1
);
const AUTONOMY_DYNAMIC_IO_CAP_CRITICAL_FACTOR = clampNumber(
  Number(process.env.AUTONOMY_DYNAMIC_IO_CAP_CRITICAL_FACTOR || 0.5),
  0.1,
  AUTONOMY_DYNAMIC_IO_CAP_WARN_FACTOR
);
const AUTONOMY_DYNAMIC_IO_CAP_MIN_INPUT_POOL = Math.max(1, Number(process.env.AUTONOMY_DYNAMIC_IO_CAP_MIN_INPUT_POOL || 8));
const AUTONOMY_DYNAMIC_IO_CAP_RESET_ON_SPAWN = String(process.env.AUTONOMY_DYNAMIC_IO_CAP_RESET_ON_SPAWN || '1') !== '0';
const AUTONOMY_DYNAMIC_IO_CAP_SPAWN_LOOKBACK_MINUTES = Math.max(
  5,
  Number(process.env.AUTONOMY_DYNAMIC_IO_CAP_SPAWN_LOOKBACK_MINUTES || 180)
);
const AUTONOMY_DYNAMIC_IO_CAP_SPAWN_MIN_GRANTED_CELLS = Math.max(
  1,
  Number(process.env.AUTONOMY_DYNAMIC_IO_CAP_SPAWN_MIN_GRANTED_CELLS || 1)
);
const AUTONOMY_BACKLOG_AUTOSCALE_ENABLED = String(process.env.AUTONOMY_BACKLOG_AUTOSCALE_ENABLED || '1') !== '0';
const AUTONOMY_BACKLOG_AUTOSCALE_MODULE = String(process.env.AUTONOMY_BACKLOG_AUTOSCALE_MODULE || 'autonomy').trim() || 'autonomy';
const AUTONOMY_BACKLOG_AUTOSCALE_MIN_CELLS = Math.max(0, Number(process.env.AUTONOMY_BACKLOG_AUTOSCALE_MIN_CELLS || 0));
const AUTONOMY_BACKLOG_AUTOSCALE_MAX_CELLS = Math.max(
  AUTONOMY_BACKLOG_AUTOSCALE_MIN_CELLS,
  Number(process.env.AUTONOMY_BACKLOG_AUTOSCALE_MAX_CELLS || 3)
);
const AUTONOMY_BACKLOG_AUTOSCALE_SCALE_UP_PENDING_RATIO = clampNumber(
  Number(process.env.AUTONOMY_BACKLOG_AUTOSCALE_SCALE_UP_PENDING_RATIO || 0.3),
  0.01,
  1
);
const AUTONOMY_BACKLOG_AUTOSCALE_SCALE_UP_PENDING_COUNT = Math.max(
  1,
  Number(process.env.AUTONOMY_BACKLOG_AUTOSCALE_SCALE_UP_PENDING_COUNT || 45)
);
const AUTONOMY_BACKLOG_AUTOSCALE_SCALE_DOWN_PENDING_RATIO = clampNumber(
  Number(process.env.AUTONOMY_BACKLOG_AUTOSCALE_SCALE_DOWN_PENDING_RATIO || 0.08),
  0,
  AUTONOMY_BACKLOG_AUTOSCALE_SCALE_UP_PENDING_RATIO
);
const AUTONOMY_BACKLOG_AUTOSCALE_SCALE_DOWN_PENDING_COUNT = Math.max(
  0,
  Number(process.env.AUTONOMY_BACKLOG_AUTOSCALE_SCALE_DOWN_PENDING_COUNT || 8)
);
const AUTONOMY_BACKLOG_AUTOSCALE_RUN_INTERVAL_MINUTES = Math.max(
  1,
  Number(process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUN_INTERVAL_MINUTES || 10)
);
const AUTONOMY_BACKLOG_AUTOSCALE_IDLE_RELEASE_MINUTES = Math.max(
  AUTONOMY_BACKLOG_AUTOSCALE_RUN_INTERVAL_MINUTES,
  Number(process.env.AUTONOMY_BACKLOG_AUTOSCALE_IDLE_RELEASE_MINUTES || 120)
);
const AUTONOMY_BACKLOG_AUTOSCALE_LEASE_SEC = Math.max(
  60,
  Number(process.env.AUTONOMY_BACKLOG_AUTOSCALE_LEASE_SEC || 600)
);
const AUTONOMY_BACKLOG_AUTOSCALE_REQUEST_TOKENS_PER_CELL = Math.max(
  0,
  Number(process.env.AUTONOMY_BACKLOG_AUTOSCALE_REQUEST_TOKENS_PER_CELL || 200)
);
const AUTONOMY_BACKLOG_AUTOSCALE_BATCH_ON_RUN = String(process.env.AUTONOMY_BACKLOG_AUTOSCALE_BATCH_ON_RUN || '1') !== '0';
const AUTONOMY_BACKLOG_AUTOSCALE_BATCH_MAX = Math.max(1, Number(process.env.AUTONOMY_BACKLOG_AUTOSCALE_BATCH_MAX || 4));
const AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = String(process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED || '1') !== '0';
const AUTONOMY_CANARY_REQUIRE_EXECUTABLE = String(process.env.AUTONOMY_CANARY_REQUIRE_EXECUTABLE || '1') !== '0';
const AUTONOMY_CANARY_BLOCK_GENERIC_ROUTE_TASK = String(process.env.AUTONOMY_CANARY_BLOCK_GENERIC_ROUTE_TASK || '1') !== '0';
const AUTONOMY_MEDIUM_RISK_MIN_COMPOSITE_ELIGIBILITY = Number(process.env.AUTONOMY_MEDIUM_RISK_MIN_COMPOSITE_ELIGIBILITY || 70);
const AUTONOMY_MEDIUM_RISK_MIN_DIRECTIVE_FIT = Number(process.env.AUTONOMY_MEDIUM_RISK_MIN_DIRECTIVE_FIT || 45);
const AUTONOMY_MEDIUM_RISK_MIN_ACTIONABILITY = Number(process.env.AUTONOMY_MEDIUM_RISK_MIN_ACTIONABILITY || 55);
const AUTONOMY_MEDIUM_RISK_NO_CHANGE_COOLDOWN_HOURS = Number(process.env.AUTONOMY_MEDIUM_RISK_NO_CHANGE_COOLDOWN_HOURS || 24);
const AUTONOMY_MEDIUM_RISK_REVERT_COOLDOWN_HOURS = Number(process.env.AUTONOMY_MEDIUM_RISK_REVERT_COOLDOWN_HOURS || 48);
const AUTONOMY_MIN_VALUE_SIGNAL_SCORE = Number(process.env.AUTONOMY_MIN_VALUE_SIGNAL_SCORE || 45);
const AUTONOMY_MEDIUM_RISK_VALUE_SIGNAL_BONUS = Number(process.env.AUTONOMY_MEDIUM_RISK_VALUE_SIGNAL_BONUS || 8);
const AUTONOMY_VALUE_CURRENCY_RANKING_ENABLED = String(process.env.AUTONOMY_VALUE_CURRENCY_RANKING_ENABLED || '1') !== '0';
const AUTONOMY_VALUE_CURRENCY_RANK_BLEND = clampNumber(Number(process.env.AUTONOMY_VALUE_CURRENCY_RANK_BLEND || 0.35), 0, 1);
const AUTONOMY_VALUE_CURRENCY_RANK_BONUS_CAP = clampNumber(Number(process.env.AUTONOMY_VALUE_CURRENCY_RANK_BONUS_CAP || 12), 0, 30);
const VALUE_CURRENCY_RANK_KEYS = new Set(['revenue', 'delivery', 'user_value', 'quality', 'time_savings', 'learning']);
const VALUE_CURRENCY_RANK_WEIGHTS = {
  revenue: 1.15,
  delivery: 1.06,
  user_value: 1.1,
  quality: 1.04,
  time_savings: 1.05,
  learning: 0.96
};
const VALUE_CURRENCY_REVENUE_RE = /\b(revenue|mrr|arr|cash|money|usd|dollar|profit|pricing|invoice|paid|payment|billing|income)\b/i;
const VALUE_CURRENCY_DELIVERY_RE = /\b(deliver|delivery|ship|release|milestone|throughput|lead[\s_-]?time|cycle[\s_-]?time|backlog)\b/i;
const VALUE_CURRENCY_USER_RE = /\b(customer|user|adoption|engagement|retention|conversion|satisfaction|onboarding)\b/i;
const VALUE_CURRENCY_QUALITY_RE = /\b(quality|reliab|uptime|error|stability|safety|accuracy|resilience|regression)\b/i;
const VALUE_CURRENCY_TIME_RE = /\b(time[\s_-]*to[\s_-]*(?:value|cash|revenue)|hours?\s+saved|latency|faster|payback)\b/i;
const VALUE_CURRENCY_LEARNING_RE = /\b(learn|discovery|research|insight|ab[\s_-]?test|hypothesis)\b/i;
const AUTONOMY_LANE_NO_CHANGE_WINDOW_DAYS = Number(process.env.AUTONOMY_LANE_NO_CHANGE_WINDOW_DAYS || 7);
const AUTONOMY_LANE_NO_CHANGE_LIMIT = Number(process.env.AUTONOMY_LANE_NO_CHANGE_LIMIT || 3);
const AUTONOMY_LANE_NO_CHANGE_COOLDOWN_HOURS = Number(process.env.AUTONOMY_LANE_NO_CHANGE_COOLDOWN_HOURS || 24);
const AUTONOMY_QOS_LANES_ENABLED = String(process.env.AUTONOMY_QOS_LANES_ENABLED || '1') !== '0';
const AUTONOMY_QOS_BACKPRESSURE_ENABLED = String(process.env.AUTONOMY_QOS_BACKPRESSURE_ENABLED || '1') !== '0';
const AUTONOMY_QOS_QUEUE_PENDING_WARN_RATIO = clampNumber(
  Number(process.env.AUTONOMY_QOS_QUEUE_PENDING_WARN_RATIO || 0.3),
  0.05,
  0.95
);
const AUTONOMY_QOS_QUEUE_PENDING_CRITICAL_RATIO = clampNumber(
  Number(process.env.AUTONOMY_QOS_QUEUE_PENDING_CRITICAL_RATIO || 0.45),
  AUTONOMY_QOS_QUEUE_PENDING_WARN_RATIO,
  0.98
);
const AUTONOMY_QOS_QUEUE_PENDING_WARN_COUNT = Math.max(
  5,
  Number(process.env.AUTONOMY_QOS_QUEUE_PENDING_WARN_COUNT || 45)
);
const AUTONOMY_QOS_QUEUE_PENDING_CRITICAL_COUNT = Math.max(
  AUTONOMY_QOS_QUEUE_PENDING_WARN_COUNT,
  Number(process.env.AUTONOMY_QOS_QUEUE_PENDING_CRITICAL_COUNT || 80)
);
const AUTONOMY_QOS_LANE_WEIGHT_CRITICAL = Math.max(
  0.5,
  Number(process.env.AUTONOMY_QOS_LANE_WEIGHT_CRITICAL || 4)
);
const AUTONOMY_QOS_LANE_WEIGHT_STANDARD = Math.max(
  0.5,
  Number(process.env.AUTONOMY_QOS_LANE_WEIGHT_STANDARD || 3)
);
const AUTONOMY_QOS_LANE_WEIGHT_EXPLORE = Math.max(
  0,
  Number(process.env.AUTONOMY_QOS_LANE_WEIGHT_EXPLORE || 2)
);
const AUTONOMY_QOS_LANE_WEIGHT_QUARANTINE = Math.max(
  0,
  Number(process.env.AUTONOMY_QOS_LANE_WEIGHT_QUARANTINE || 1)
);
const AUTONOMY_QOS_EXPLORE_MAX_SHARE = clampNumber(
  Number(process.env.AUTONOMY_QOS_EXPLORE_MAX_SHARE || 0.35),
  0.05,
  0.9
);
const AUTONOMY_QOS_QUARANTINE_MAX_SHARE = clampNumber(
  Number(process.env.AUTONOMY_QOS_QUARANTINE_MAX_SHARE || 0.2),
  0.01,
  0.9
);
const AUTONOMY_CANDIDATE_AUDIT_MAX_ROWS = Number(process.env.AUTONOMY_CANDIDATE_AUDIT_MAX_ROWS || 25);
const AUTONOMY_SCORE_ONLY_EVIDENCE = String(process.env.AUTONOMY_SCORE_ONLY_EVIDENCE || '1') !== '0';
const AUTONOMY_FORCE_PROPOSAL_ID = String(process.env.AUTONOMY_FORCE_PROPOSAL_ID || '').trim();
const AUTONOMY_SCORE_ONLY_STRUCTURAL_COOLDOWN_HOURS = Math.max(
  0,
  Number(process.env.AUTONOMY_SCORE_ONLY_STRUCTURAL_COOLDOWN_HOURS || 24)
);
const AUTONOMY_SCORE_ONLY_REPEAT_PROPOSAL_LIMIT = Math.max(
  1,
  Number(process.env.AUTONOMY_SCORE_ONLY_REPEAT_PROPOSAL_LIMIT || 3)
);
const AUTONOMY_SCORE_ONLY_REPEAT_WINDOW_HOURS = Math.max(
  1,
  Number(process.env.AUTONOMY_SCORE_ONLY_REPEAT_WINDOW_HOURS || 24)
);
const AUTONOMY_SCORE_ONLY_REPEAT_COOLDOWN_HOURS = Math.max(
  0,
  Number(process.env.AUTONOMY_SCORE_ONLY_REPEAT_COOLDOWN_HOURS || 12)
);
const AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_ENABLED = String(process.env.AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_ENABLED || '1') !== '0';
const AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_WINDOW_HOURS = Math.max(
  1,
  Number(process.env.AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_WINDOW_HOURS || 24)
);
const AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_MAX_EVENTS = Math.max(
  50,
  Number(process.env.AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_MAX_EVENTS || 800)
);
const AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_MIN_OBSERVATIONS = Math.max(
  1,
  Number(process.env.AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_MIN_OBSERVATIONS || 2)
);
const AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_MAX_RATE = clampNumber(
  Number(process.env.AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_MAX_RATE || 0.5),
  0.05,
  1
);
const AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_ENABLED = String(process.env.AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_ENABLED || '1') !== '0';
const AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_MIN_SHIPPED_PER_DAY = Math.max(
  0,
  Number(process.env.AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_MIN_SHIPPED_PER_DAY || 1)
);
const AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_MAX_PER_DAY = Math.max(
  0,
  Number(process.env.AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_MAX_PER_DAY || 1)
);
const AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_MAX_TOKENS = Math.max(
  80,
  Number(process.env.AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_MAX_TOKENS || 1200)
);
const AUTONOMY_SUCCESS_CRITERIA_ALLOW_DEFERRED_PREVIEW = String(process.env.AUTONOMY_SUCCESS_CRITERIA_ALLOW_DEFERRED_PREVIEW || '1') !== '0';
const AUTONOMY_SEMANTIC_DEDUPE_ENABLED = String(process.env.AUTONOMY_SEMANTIC_DEDUPE_ENABLED || '1') !== '0';
const AUTONOMY_SEMANTIC_DEDUPE_THRESHOLD = clampNumber(
  Number(process.env.AUTONOMY_SEMANTIC_DEDUPE_THRESHOLD || 0.74),
  0.55,
  0.98
);
const AUTONOMY_SEMANTIC_DEDUPE_MIN_TOKENS = Math.max(
  3,
  Number(process.env.AUTONOMY_SEMANTIC_DEDUPE_MIN_TOKENS || 6)
);
const AUTONOMY_SEMANTIC_DEDUPE_REQUIRE_SAME_TYPE = String(process.env.AUTONOMY_SEMANTIC_DEDUPE_REQUIRE_SAME_TYPE || '1') !== '0';
const AUTONOMY_SEMANTIC_DEDUPE_REQUIRE_SHARED_CONTEXT = String(process.env.AUTONOMY_SEMANTIC_DEDUPE_REQUIRE_SHARED_CONTEXT || '1') !== '0';
const AUTONOMY_EVIDENCE_SAMPLE_WINDOW = Math.max(1, Number(process.env.AUTONOMY_EVIDENCE_SAMPLE_WINDOW || 5));
const AUTONOMY_PREEXEC_CRITERIA_GATE_ENABLED = String(process.env.AUTONOMY_PREEXEC_CRITERIA_GATE_ENABLED || '1') !== '0';
const AUTONOMY_PREEXEC_CRITERIA_COOLDOWN_HOURS = Math.max(1, Number(process.env.AUTONOMY_PREEXEC_CRITERIA_COOLDOWN_HOURS || AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS));
const AUTONOMY_EXECUTE_CONFIDENCE_MARGIN = Math.max(0, Number(process.env.AUTONOMY_EXECUTE_CONFIDENCE_MARGIN || 4));
const AUTONOMY_EXECUTE_MIN_VALUE_SIGNAL_BONUS = Math.max(0, Number(process.env.AUTONOMY_EXECUTE_MIN_VALUE_SIGNAL_BONUS || 5));
const AUTONOMY_EXECUTE_CONFIDENCE_ADAPTIVE_ENABLED = String(process.env.AUTONOMY_EXECUTE_CONFIDENCE_ADAPTIVE_ENABLED || '1') !== '0';
const AUTONOMY_EXECUTE_CONFIDENCE_HISTORY_DAYS = Math.max(1, Number(process.env.AUTONOMY_EXECUTE_CONFIDENCE_HISTORY_DAYS || 7));
const AUTONOMY_EXECUTE_CONFIDENCE_LOW_RISK_RELAX_COMPOSITE = Math.max(0, Number(process.env.AUTONOMY_EXECUTE_CONFIDENCE_LOW_RISK_RELAX_COMPOSITE || 2));
const AUTONOMY_EXECUTE_CONFIDENCE_LOW_RISK_RELAX_VALUE = Math.max(0, Number(process.env.AUTONOMY_EXECUTE_CONFIDENCE_LOW_RISK_RELAX_VALUE || 4));
const AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_EVERY = Math.max(1, Number(process.env.AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_EVERY || 3));
const AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_STEP = Math.max(0, Number(process.env.AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_STEP || 1));
const AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_MAX = Math.max(0, Number(process.env.AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_MAX || 3));
const AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_MIN_EXECUTED = Math.max(0, Number(process.env.AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_MIN_EXECUTED || 2));
const AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_MIN_SHIPPED = Math.max(0, Number(process.env.AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_MIN_SHIPPED || 1));
const AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_MIN_SHIP_RATE = clampNumber(
  Number(process.env.AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_MIN_SHIP_RATE || 0.5),
  0,
  1
);
const AUTONOMY_EXECUTE_CONFIDENCE_NO_CHANGE_TIGHTEN_MIN_EXECUTED = Math.max(1, Number(process.env.AUTONOMY_EXECUTE_CONFIDENCE_NO_CHANGE_TIGHTEN_MIN_EXECUTED || 3));
const AUTONOMY_EXECUTE_CONFIDENCE_NO_CHANGE_TIGHTEN_THRESHOLD = clampNumber(Number(process.env.AUTONOMY_EXECUTE_CONFIDENCE_NO_CHANGE_TIGHTEN_THRESHOLD || 0.8), 0, 1);
const AUTONOMY_EXECUTE_CONFIDENCE_NO_CHANGE_TIGHTEN_STEP = Math.max(0, Number(process.env.AUTONOMY_EXECUTE_CONFIDENCE_NO_CHANGE_TIGHTEN_STEP || 1));
const AUTONOMY_EXECUTE_CONFIDENCE_LANE_COOLDOWN_HOURS = Math.max(
  1,
  Number(process.env.AUTONOMY_EXECUTE_CONFIDENCE_LANE_COOLDOWN_HOURS || AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS)
);
const AUTONOMY_EXECUTE_CONFIDENCE_LOOP_ESCALATE_THRESHOLD = Math.max(
  2,
  Number(process.env.AUTONOMY_EXECUTE_CONFIDENCE_LOOP_ESCALATE_THRESHOLD || 3)
);
const AUTONOMY_EXECUTE_CONFIDENCE_LOOP_COOLDOWN_HOURS = Math.max(
  1,
  Number(process.env.AUTONOMY_EXECUTE_CONFIDENCE_LOOP_COOLDOWN_HOURS || 24)
);
const AUTONOMY_CRITERIA_PATTERN_WINDOW_DAYS = Math.max(1, Number(process.env.AUTONOMY_CRITERIA_PATTERN_WINDOW_DAYS || 14));
const AUTONOMY_CRITERIA_PATTERN_FAIL_THRESHOLD = Math.max(1, Number(process.env.AUTONOMY_CRITERIA_PATTERN_FAIL_THRESHOLD || 2));
const AUTONOMY_CRITERIA_PATTERN_PENALTY_PER_HIT = Math.max(1, Number(process.env.AUTONOMY_CRITERIA_PATTERN_PENALTY_PER_HIT || 6));
const AUTONOMY_CRITERIA_PATTERN_MAX_PENALTY = Math.max(4, Number(process.env.AUTONOMY_CRITERIA_PATTERN_MAX_PENALTY || 24));
const HUMAN_CANARY_OVERRIDE_REQUIRE_TTY = String(process.env.HUMAN_CANARY_OVERRIDE_REQUIRE_TTY || '1') !== '0';
const HUMAN_CANARY_OVERRIDE_DEFAULT_TTL_MINUTES = Number(process.env.HUMAN_CANARY_OVERRIDE_DEFAULT_TTL_MINUTES || 20);
const HUMAN_CANARY_OVERRIDE_MAX_TTL_MINUTES = Number(process.env.HUMAN_CANARY_OVERRIDE_MAX_TTL_MINUTES || 120);
const HUMAN_CANARY_OVERRIDE_PREFIX = String(process.env.HUMAN_CANARY_OVERRIDE_PREFIX || 'I_APPROVE_ONE_SHOT_CANARY_OVERRIDE');
const AUTONOMY_DIRECTIVE_PULSE_ENABLED = String(process.env.AUTONOMY_DIRECTIVE_PULSE_ENABLED || '1') !== '0';
const AUTONOMY_DIRECTIVE_PULSE_WINDOW_DAYS = Number(process.env.AUTONOMY_DIRECTIVE_PULSE_WINDOW_DAYS || 14);
const AUTONOMY_DIRECTIVE_PULSE_URGENCY_HOURS = Number(process.env.AUTONOMY_DIRECTIVE_PULSE_URGENCY_HOURS || 24);
const AUTONOMY_DIRECTIVE_PULSE_NO_PROGRESS_LIMIT = Number(process.env.AUTONOMY_DIRECTIVE_PULSE_NO_PROGRESS_LIMIT || 3);
const AUTONOMY_DIRECTIVE_PULSE_COOLDOWN_HOURS = Number(process.env.AUTONOMY_DIRECTIVE_PULSE_COOLDOWN_HOURS || 6);
const AUTONOMY_DIRECTIVE_PULSE_T1_MIN_SHARE = Number(process.env.AUTONOMY_DIRECTIVE_PULSE_T1_MIN_SHARE || 0.5);
const AUTONOMY_DIRECTIVE_PULSE_T2_MIN_SHARE = Number(process.env.AUTONOMY_DIRECTIVE_PULSE_T2_MIN_SHARE || 0.25);
const AUTONOMY_DIRECTIVE_PULSE_RANK_BONUS = Number(process.env.AUTONOMY_DIRECTIVE_PULSE_RANK_BONUS || 0.3);
const AUTONOMY_DIRECTIVE_PULSE_ESCALATE_AFTER = Number(process.env.AUTONOMY_DIRECTIVE_PULSE_ESCALATE_AFTER || 2);
const AUTONOMY_DIRECTIVE_PULSE_ESCALATE_WINDOW_HOURS = Number(process.env.AUTONOMY_DIRECTIVE_PULSE_ESCALATE_WINDOW_HOURS || 24);
const AUTONOMY_DIRECTIVE_PULSE_RESERVATION_HARD = String(process.env.AUTONOMY_DIRECTIVE_PULSE_RESERVATION_HARD || '0') === '1';
const AUTONOMY_OBJECTIVE_BINDING_REQUIRED = String(process.env.AUTONOMY_OBJECTIVE_BINDING_REQUIRED || '1') !== '0';
const AUTONOMY_OBJECTIVE_BINDING_FALLBACK_DIRECTIVES = String(process.env.AUTONOMY_OBJECTIVE_BINDING_FALLBACK_DIRECTIVES || '1') !== '0';
const AUTONOMY_EXECUTE_REQUIRE_T1 = String(process.env.AUTONOMY_EXECUTE_REQUIRE_T1 || '1') !== '0';
const AUTONOMY_OBJECTIVE_ALLOCATION_RANK_BONUS = Number(process.env.AUTONOMY_OBJECTIVE_ALLOCATION_RANK_BONUS || 0.25);
const AUTONOMY_OBJECTIVE_MIX_ENABLED = String(process.env.AUTONOMY_OBJECTIVE_MIX_ENABLED || '1') !== '0';
const AUTONOMY_OBJECTIVE_MIX_WINDOW_DAYS = Math.max(1, Number(process.env.AUTONOMY_OBJECTIVE_MIX_WINDOW_DAYS || 7));
const AUTONOMY_OBJECTIVE_MIX_MIN_EXECUTED = Math.max(1, Number(process.env.AUTONOMY_OBJECTIVE_MIX_MIN_EXECUTED || 4));
const AUTONOMY_OBJECTIVE_MIX_MAX_SHARE = clampNumber(Number(process.env.AUTONOMY_OBJECTIVE_MIX_MAX_SHARE || 0.7), 0.4, 0.95);
const AUTONOMY_TIER1_GOVERNANCE_ENABLED = String(process.env.AUTONOMY_TIER1_GOVERNANCE_ENABLED || '1') !== '0';
const AUTONOMY_TIER1_TOKEN_COST_PER_1K = Number(process.env.AUTONOMY_TIER1_TOKEN_COST_PER_1K || 0);
const AUTONOMY_TIER1_DAILY_USD_CAP = Number(process.env.AUTONOMY_TIER1_DAILY_USD_CAP || 0);
const AUTONOMY_TIER1_PER_ACTION_AVG_USD_CAP = Number(process.env.AUTONOMY_TIER1_PER_ACTION_AVG_USD_CAP || 0);
const AUTONOMY_TIER1_BURN_RATE_MULTIPLIER = Number(process.env.AUTONOMY_TIER1_BURN_RATE_MULTIPLIER || 1.5);
const AUTONOMY_TIER1_MIN_PROJECTED_TOKENS_FOR_BURN_CHECK = Number(process.env.AUTONOMY_TIER1_MIN_PROJECTED_TOKENS_FOR_BURN_CHECK || 600);
const AUTONOMY_TIER1_BURN_BASELINE_MIN_DAYS = Number(process.env.AUTONOMY_TIER1_BURN_BASELINE_MIN_DAYS || 3);
const AUTONOMY_TIER1_MONTHLY_USD_ALLOCATION = Number(process.env.AUTONOMY_TIER1_MONTHLY_USD_ALLOCATION || 0);
const AUTONOMY_TIER1_MONTHLY_CREDITS_FLOOR_PCT = Number(process.env.AUTONOMY_TIER1_MONTHLY_CREDITS_FLOOR_PCT || 0.2);
const AUTONOMY_TIER1_DRIFT_RECENT_DAYS = Number(process.env.AUTONOMY_TIER1_DRIFT_RECENT_DAYS || 7);
const AUTONOMY_TIER1_DRIFT_BASELINE_DAYS = Number(process.env.AUTONOMY_TIER1_DRIFT_BASELINE_DAYS || 21);
const AUTONOMY_TIER1_DRIFT_EMA_THRESHOLD = Number(process.env.AUTONOMY_TIER1_DRIFT_EMA_THRESHOLD || 0.55);
const AUTONOMY_TIER1_DRIFT_TOKEN_RATIO_THRESHOLD = Number(process.env.AUTONOMY_TIER1_DRIFT_TOKEN_RATIO_THRESHOLD || 3);
const AUTONOMY_TIER1_DRIFT_ERROR_RATE_THRESHOLD = Number(process.env.AUTONOMY_TIER1_DRIFT_ERROR_RATE_THRESHOLD || 0.35);
const AUTONOMY_TIER1_DRIFT_MIN_SAMPLES = Number(process.env.AUTONOMY_TIER1_DRIFT_MIN_SAMPLES || 6);
const AUTONOMY_TIER1_DRIFT_HARD_STOP_ON_HIGH = String(process.env.AUTONOMY_TIER1_DRIFT_HARD_STOP_ON_HIGH || '1') !== '0';
const AUTONOMY_TIER1_ALIGNMENT_THRESHOLD = Number(process.env.AUTONOMY_TIER1_ALIGNMENT_THRESHOLD || 60);
const AUTONOMY_TIER1_ALIGNMENT_MIN_WEEK_SAMPLES = Number(process.env.AUTONOMY_TIER1_ALIGNMENT_MIN_WEEK_SAMPLES || 3);
const AUTONOMY_TIER1_EXCEPTION_SUMMARY_DAYS = Number(process.env.AUTONOMY_TIER1_EXCEPTION_SUMMARY_DAYS || 7);
const AUTONOMY_TIER1_CANARY_BURN_RATE_MULTIPLIER = Number(process.env.AUTONOMY_TIER1_CANARY_BURN_RATE_MULTIPLIER || 2);
const AUTONOMY_TIER1_CANARY_MIN_PROJECTED_TOKENS_FOR_BURN_CHECK = Number(process.env.AUTONOMY_TIER1_CANARY_MIN_PROJECTED_TOKENS_FOR_BURN_CHECK || 800);
const AUTONOMY_TIER1_CANARY_DRIFT_MIN_SAMPLES = Number(process.env.AUTONOMY_TIER1_CANARY_DRIFT_MIN_SAMPLES || 8);
const AUTONOMY_TIER1_CANARY_ALIGNMENT_THRESHOLD = Number(process.env.AUTONOMY_TIER1_CANARY_ALIGNMENT_THRESHOLD || 55);
const AUTONOMY_TIER1_CANARY_SUPPRESS_ALIGNMENT_BLOCKER = String(process.env.AUTONOMY_TIER1_CANARY_SUPPRESS_ALIGNMENT_BLOCKER || '1') !== '0';
const AUTONOMY_HUMAN_ESCALATION_HOLD_HOURS = Number(process.env.AUTONOMY_HUMAN_ESCALATION_HOLD_HOURS || 6);
const AUTONOMY_HUMAN_ESCALATION_DEDUPE_HOURS = Number(process.env.AUTONOMY_HUMAN_ESCALATION_DEDUPE_HOURS || 24);
const AUTONOMY_HUMAN_ESCALATION_BLOCK_RUNS = String(process.env.AUTONOMY_HUMAN_ESCALATION_BLOCK_RUNS || '1') !== '0';
const AUTONOMY_HUMAN_ESCALATION_MAX_STATUS_ROWS = Number(process.env.AUTONOMY_HUMAN_ESCALATION_MAX_STATUS_ROWS || 5);
const AUTONOMY_HUMAN_ESCALATION_CREATE_PROPOSAL = String(process.env.AUTONOMY_HUMAN_ESCALATION_CREATE_PROPOSAL || '1') !== '0';
const AUTONOMY_DISALLOWED_PARSER_TYPES = new Set(
  String(process.env.AUTONOMY_DISALLOWED_PARSER_TYPES || 'stub')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);
const DIRECTIVE_FIT_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'through', 'that', 'this', 'these', 'those', 'your', 'you',
  'their', 'our', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'will', 'would', 'should',
  'could', 'must', 'can', 'not', 'all', 'any', 'only', 'each', 'per', 'but', 'its', 'it', 'as', 'at', 'on',
  'to', 'in', 'of', 'or', 'an', 'a', 'by'
]);
const ACTION_VERB_RE = /\b(build|implement|fix|add|create|generate|optimize|refactor|automate|ship|deploy|test|measure|instrument|reduce|increase)\b/i;
const OPPORTUNITY_MARKER_RE = /\b(opportunity|freelance|job|jobs|hiring|contract|contractor|gig|client|rfp|request for proposal|seeking|looking for)\b/i;
const META_COORDINATION_RE = /\b(review|prioritize|triage|health\s*check|high\s*leverage)\b/i;
const CONCRETE_TARGET_RE = /\b(file|script|collector|parser|endpoint|model|config|test|hook|queue|ledger|registry|adapter|workflow|routing|transport|fallback|sensor|retry|dns|network|probe|api|cache)\b/i;
const EXPLAINER_TITLE_RE = /^(why|what|how)\b/i;
const OPTIMIZATION_INTENT_RE = /\b(optimi[sz]e|optimization|improv(?:e|ement)|tune|polish|streamlin|efficien(?:cy|t)|latency|throughput|cost|token(?:s)?|performance)\b/i;
const OPTIMIZATION_EXEMPT_RE = /\b(fail(?:ure)?|error|outage|broken|incident|security|integrity|violation|breach|timeout|rate\s*limit|dns|connection|recover|restore|rollback|revert|remediation)\b/i;
const PERCENT_VALUE_RE = /(-?\d+(?:\.\d+)?)\s*%/g;
const GENERIC_VALIDATION_RE = /\b(extract one concrete build\/change task from source|define measurable success check|route a dry-run execution plan)\b/i;
const GENERIC_ROUTE_TASK_RE = /--task=\"Extract one implementable step from external intel:/i;
const ROLLBACK_SIGNAL_RE = /\b(rollback|revert|undo|restore|fallback)\b/i;
const SUCCESS_METRIC_RE = /\b(metric|kpi|target|rate|count|latency|error|uptime|throughput|conversion|artifact|receipt|coverage|reply|interview|pass|fail|delta|percent|%|run|runs|check|checks|items_collected)\b/i;
const SUCCESS_TIMEBOUND_RE = /\b(\d+\s*(h|hr|hour|hours|d|day|days|w|week|weeks|min|mins|minute|minutes)|daily|weekly|monthly|quarterly)\b/i;
const SUCCESS_RELAXED_RUN_HORIZON_RE = /\b(next|this)\s+(run|cycle)\b/i;
const SUCCESS_COMPARATOR_RE = /\b(>=|<=|>|<|at least|at most|less than|more than|within|under|over)\b/i;
const AUTONOMY_CANARY_RELAX_ENABLED = String(process.env.AUTONOMY_CANARY_RELAX_ENABLED || '1') !== '0';
const AUTONOMY_CANARY_ALLOW_WITH_FLAG_OFF = String(process.env.AUTONOMY_CANARY_ALLOW_WITH_FLAG_OFF || '1') !== '0';
const AUTONOMY_CANARY_RELAX_READINESS_CHECKS = new Set(
  parseLowerList(process.env.AUTONOMY_CANARY_RELAX_READINESS_CHECKS || 'success_criteria_pass_rate')
);
const AUTONOMY_CANARY_RELAX_SPC_CHECKS = new Set(
  parseLowerList(process.env.AUTONOMY_CANARY_RELAX_SPC_CHECKS || 'success_criteria_pass_rate')
);
const TOOL_CAPABILITY_TOKENS = [
  'web_fetch', 'web_search', 'browser', 'exec',
  'cron', 'sessions_spawn', 'sessions_send', 'gmail', 'gog', 'bird_x'
];
const AUTONOMY_PREFER_NON_FALLBACK_ELIGIBLE = String(process.env.AUTONOMY_PREFER_NON_FALLBACK_ELIGIBLE || '1') !== '0';
const AUTONOMY_DEPRIORITIZED_SOURCE_EYES = new Set(
  String(process.env.AUTONOMY_DEPRIORITIZED_SOURCE_EYES || 'local_state_fallback')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);
const AUTONOMY_UNKNOWN_TYPE_QUARANTINE_ENABLED = String(process.env.AUTONOMY_UNKNOWN_TYPE_QUARANTINE_ENABLED || '1') !== '0';
const AUTONOMY_UNKNOWN_TYPE_QUARANTINE_TYPES = new Set(
  parseLowerList(process.env.AUTONOMY_UNKNOWN_TYPE_QUARANTINE_TYPES || 'unknown')
);
const AUTONOMY_UNKNOWN_TYPE_QUARANTINE_ALLOW_TIER1 = String(process.env.AUTONOMY_UNKNOWN_TYPE_QUARANTINE_ALLOW_TIER1 || '1') !== '0';
const AUTONOMY_UNKNOWN_TYPE_QUARANTINE_ALLOW_DIRECTIVE = String(process.env.AUTONOMY_UNKNOWN_TYPE_QUARANTINE_ALLOW_DIRECTIVE || '1') !== '0';
const AUTONOMY_CAMPAIGN_DECOMPOSE_ENABLED = String(process.env.AUTONOMY_CAMPAIGN_DECOMPOSE_ENABLED || '1') !== '0';
const AUTONOMY_CAMPAIGN_DECOMPOSE_MAX_PER_RUN = Math.max(0, Number(process.env.AUTONOMY_CAMPAIGN_DECOMPOSE_MAX_PER_RUN || 2));
const AUTONOMY_CAMPAIGN_DECOMPOSE_MIN_OPEN_PER_TYPE = Math.max(1, Number(process.env.AUTONOMY_CAMPAIGN_DECOMPOSE_MIN_OPEN_PER_TYPE || 1));
const AUTONOMY_CAMPAIGN_DECOMPOSE_DEFAULT_RISK = String(process.env.AUTONOMY_CAMPAIGN_DECOMPOSE_DEFAULT_RISK || 'low').trim().toLowerCase() || 'low';
const AUTONOMY_CAMPAIGN_DECOMPOSE_DEFAULT_IMPACT = String(process.env.AUTONOMY_CAMPAIGN_DECOMPOSE_DEFAULT_IMPACT || 'medium').trim().toLowerCase() || 'medium';
const AUTONOMY_STRATEGY_RANK_NON_YIELD_PENALTY_ENABLED = String(process.env.AUTONOMY_STRATEGY_RANK_NON_YIELD_PENALTY_ENABLED || '1') !== '0';
const AUTONOMY_STRATEGY_RANK_NON_YIELD_WINDOW_HOURS = Math.max(1, Number(process.env.AUTONOMY_STRATEGY_RANK_NON_YIELD_WINDOW_HOURS || 72));
const AUTONOMY_STRATEGY_RANK_NON_YIELD_MIN_SAMPLES = Math.max(1, Number(process.env.AUTONOMY_STRATEGY_RANK_NON_YIELD_MIN_SAMPLES || 2));
const AUTONOMY_STRATEGY_RANK_NON_YIELD_POLICY_HOLD_WEIGHT = Math.max(0, Number(process.env.AUTONOMY_STRATEGY_RANK_NON_YIELD_POLICY_HOLD_WEIGHT || 18));
const AUTONOMY_STRATEGY_RANK_NON_YIELD_NO_PROGRESS_WEIGHT = Math.max(0, Number(process.env.AUTONOMY_STRATEGY_RANK_NON_YIELD_NO_PROGRESS_WEIGHT || 22));
const AUTONOMY_STRATEGY_RANK_NON_YIELD_STOP_WEIGHT = Math.max(0, Number(process.env.AUTONOMY_STRATEGY_RANK_NON_YIELD_STOP_WEIGHT || 10));
const AUTONOMY_STRATEGY_RANK_NON_YIELD_SHIPPED_RELIEF_WEIGHT = Math.max(0, Number(process.env.AUTONOMY_STRATEGY_RANK_NON_YIELD_SHIPPED_RELIEF_WEIGHT || 8));
const AUTONOMY_STRATEGY_RANK_NON_YIELD_MAX_PENALTY = Math.max(0, Number(process.env.AUTONOMY_STRATEGY_RANK_NON_YIELD_MAX_PENALTY || 30));
const COLLECTIVE_SHADOW_LATEST_PATH = process.env.AUTONOMY_COLLECTIVE_SHADOW_PATH
  ? path.resolve(process.env.AUTONOMY_COLLECTIVE_SHADOW_PATH)
  : path.join(REPO_ROOT, 'state', 'autonomy', 'collective_shadow', 'latest.json');
const AUTONOMY_COLLECTIVE_SHADOW_ENABLED = String(process.env.AUTONOMY_COLLECTIVE_SHADOW_ENABLED || '1') !== '0';
const AUTONOMY_COLLECTIVE_SHADOW_MIN_CONFIDENCE = clampNumber(
  Number(process.env.AUTONOMY_COLLECTIVE_SHADOW_MIN_CONFIDENCE || 0.6),
  0,
  1
);
const AUTONOMY_COLLECTIVE_SHADOW_MAX_PENALTY = Math.max(0, Number(process.env.AUTONOMY_COLLECTIVE_SHADOW_MAX_PENALTY || 8));
const AUTONOMY_COLLECTIVE_SHADOW_MAX_BONUS = Math.max(0, Number(process.env.AUTONOMY_COLLECTIVE_SHADOW_MAX_BONUS || 3));
const AUTONOMY_TRIT_SHADOW_ENABLED = String(process.env.AUTONOMY_TRIT_SHADOW_ENABLED || '1') !== '0';
const AUTONOMY_TRIT_SHADOW_BONUS_BLEND = clampNumber(Number(process.env.AUTONOMY_TRIT_SHADOW_BONUS_BLEND || 0.2), 0, 1);
const AUTONOMY_TRIT_SHADOW_TOP_K = Math.max(1, Number(process.env.AUTONOMY_TRIT_SHADOW_TOP_K || 5));
const AUTONOMY_MULTI_STRATEGY_CANARY_ENABLED = String(process.env.AUTONOMY_MULTI_STRATEGY_CANARY_ENABLED || '1') !== '0';
const AUTONOMY_MULTI_STRATEGY_CANARY_FRACTION = clampNumber(Number(process.env.AUTONOMY_MULTI_STRATEGY_CANARY_FRACTION || 0.25), 0, 0.9);
const AUTONOMY_MULTI_STRATEGY_MAX_ACTIVE = Math.max(1, Number(process.env.AUTONOMY_MULTI_STRATEGY_MAX_ACTIVE || 3));
const AUTONOMY_MULTI_STRATEGY_CANARY_ALLOW_EXECUTE = String(process.env.AUTONOMY_MULTI_STRATEGY_CANARY_ALLOW_EXECUTE || '0') === '1';
const STRATEGY_SCORECARD_LATEST_PATH = process.env.AUTONOMY_STRATEGY_SCORECARD_LATEST_PATH
  ? path.resolve(process.env.AUTONOMY_STRATEGY_SCORECARD_LATEST_PATH)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'strategy', 'scorecards', 'latest.json');
let STRATEGY_CACHE = undefined;
let STRATEGY_VARIANTS_CACHE = undefined;
let STRATEGY_SCORECARD_CACHE = undefined;
let COLLECTIVE_SHADOW_CACHE = undefined;
let OUTCOME_FITNESS_POLICY_CACHE = undefined;

function strategyProfile() {
  if (STRATEGY_CACHE !== undefined) return STRATEGY_CACHE;
  const loaded = loadActiveStrategy({ allowMissing: true });
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'strategy_profile',
      {
        strategy: loaded && typeof loaded === 'object' ? loaded : null
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      STRATEGY_CACHE = payload.strategy && typeof payload.strategy === 'object'
        ? payload.strategy
        : null;
      return STRATEGY_CACHE;
    }
  }
  STRATEGY_CACHE = loaded;
  return STRATEGY_CACHE;
}

function activeStrategyVariants() {
  if (STRATEGY_VARIANTS_CACHE !== undefined) return STRATEGY_VARIANTS_CACHE;
  let listed = [];
  try {
    listed = listStrategies();
  } catch {
    listed = [];
  }
  const primary = strategyProfile();
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'active_strategy_variants',
      {
        listed: Array.isArray(listed) ? listed : [],
        primary: primary && typeof primary === 'object' ? primary : null
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      STRATEGY_VARIANTS_CACHE = Array.isArray(payload.variants)
        ? payload.variants.filter((row) => row && typeof row === 'object')
        : [];
      return STRATEGY_VARIANTS_CACHE;
    }
  }
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(listed) ? listed : []) {
    if (!row || typeof row !== 'object') continue;
    if (String(row.status || '').trim().toLowerCase() !== 'active') continue;
    if (row.validation && row.validation.strict_ok === false) continue;
    const id = String(row.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  if (primary && primary.id && !seen.has(String(primary.id))) out.push(primary);
  out.sort((a, b) => String(a && a.id || '').localeCompare(String(b && b.id || '')));
  STRATEGY_VARIANTS_CACHE = out;
  return STRATEGY_VARIANTS_CACHE;
}

function strategyScorecardSummaries() {
  if (STRATEGY_SCORECARD_CACHE !== undefined) return STRATEGY_SCORECARD_CACHE;
  const payload = loadJson(STRATEGY_SCORECARD_LATEST_PATH, null);
  const summaries = Array.isArray(payload && payload.summaries) ? payload.summaries : [];
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'strategy_scorecard_summaries',
      {
        path: STRATEGY_SCORECARD_LATEST_PATH,
        ts: payload && payload.ts ? String(payload.ts) : null,
        summaries
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const rustPayload = rust.payload.payload;
      STRATEGY_SCORECARD_CACHE = {
        path: rustPayload.path ? String(rustPayload.path) : STRATEGY_SCORECARD_LATEST_PATH,
        ts: rustPayload.ts ? String(rustPayload.ts) : null,
        by_id: rustPayload.by_id && typeof rustPayload.by_id === 'object'
          ? rustPayload.by_id
          : {}
      };
      return STRATEGY_SCORECARD_CACHE;
    }
  }
  const byId = {};
  for (const row of summaries) {
    const id = String(row && row.strategy_id || '').trim();
    if (!id) continue;
    byId[id] = {
      score: Number(row && row.metrics && row.metrics.score || 0),
      confidence: Number(row && row.metrics && row.metrics.confidence || 0),
      stage: String(row && row.stage || '').trim().toLowerCase() || null
    };
  }
  STRATEGY_SCORECARD_CACHE = {
    path: STRATEGY_SCORECARD_LATEST_PATH,
    ts: payload && payload.ts ? String(payload.ts) : null,
    by_id: byId
  };
  return STRATEGY_SCORECARD_CACHE;
}

function stableSelectionIndex(seed, size) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'stable_selection_index',
      {
        seed: seed == null ? null : String(seed),
        size: Number(size)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Number(rust.payload.payload.index || 0);
    }
  }
  const n = Math.max(0, Math.floor(Number(size || 0)));
  if (n <= 0) return 0;
  const hex = crypto.createHash('sha256').update(String(seed || '')).digest('hex').slice(0, 12);
  const num = Number.parseInt(hex, 16);
  if (!Number.isFinite(num) || num < 0) return 0;
  return num % n;
}

function selectStrategyForRun(dateStr, priorRuns = []) {
  const variants = activeStrategyVariants();
  const primary = strategyProfile();
  const fallback = primary || (variants.length ? variants[0] : null);
  const attempts = (Array.isArray(priorRuns) ? priorRuns : []).filter((evt) => evt && evt.type === 'autonomy_run').length;
  const attemptIndex = attempts + 1;
  const scorecards = strategyScorecardSummaries();
  const variantRows = variants
    .map((s) => {
      const id = String(s && s.id || '');
      const scoreRow = scorecards && scorecards.by_id && scorecards.by_id[id]
        ? scorecards.by_id[id]
        : {};
      return {
        strategy: s,
        id,
        score: Number.isFinite(Number(scoreRow.score)) ? Number(scoreRow.score) : 0,
        confidence: Number.isFinite(Number(scoreRow.confidence)) ? Number(scoreRow.confidence) : 0,
        stage: scoreRow.stage || null,
        execution_mode: strategyExecutionMode(s, 'score_only')
      };
    });

  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'strategy_selection',
      {
        date_str: String(dateStr || ''),
        attempt_index: attemptIndex,
        canary_enabled: AUTONOMY_MULTI_STRATEGY_CANARY_ENABLED,
        canary_allow_execute: AUTONOMY_MULTI_STRATEGY_CANARY_ALLOW_EXECUTE,
        canary_fraction: Number(AUTONOMY_MULTI_STRATEGY_CANARY_FRACTION || 0),
        max_active: Number(AUTONOMY_MULTI_STRATEGY_MAX_ACTIVE || 1),
        fallback_strategy_id: String(fallback && fallback.id || ''),
        variants: variantRows.map((row) => ({
          strategy_id: row.id,
          score: Number(row.score || 0),
          confidence: Number(row.confidence || 0),
          stage: row.stage || null,
          execution_mode: String(row.execution_mode || '')
        }))
      },
      { allow_cli_fallback: true }
    );
    if (
      rust
      && rust.ok === true
      && rust.payload
      && rust.payload.ok === true
      && rust.payload.payload
    ) {
      const payload = rust.payload.payload;
      const ranked = Array.isArray(payload.ranked) ? payload.ranked : [];
      const strategyById = new Map(variantRows.map((row) => [String(row.id || ''), row.strategy]));
      const selectedId = String(payload.selected_strategy_id || '');
      const selectedStrategy = strategyById.get(selectedId) || fallback || null;
      return {
        strategy: selectedStrategy,
        mode: String(payload.mode || (selectedId ? 'primary_best' : 'none')),
        canary_enabled: payload.canary_enabled === true,
        canary_due: payload.canary_due === true,
        canary_every: Number.isFinite(Number(payload.canary_every))
          ? Number(payload.canary_every)
          : null,
        attempt_index: Number(payload.attempt_index || attemptIndex),
        active_count: Number(payload.active_count || ranked.length || 0),
        ranked: ranked.map((row) => ({
          strategy_id: String(row && row.strategy_id || ''),
          score: Number(row && row.score || 0),
          confidence: Number(row && row.confidence || 0),
          stage: row && row.stage ? String(row.stage) : null,
          execution_mode: String(row && row.execution_mode || '')
        }))
      };
    }
  }

  if (!fallback) {
    return {
      strategy: null,
      mode: 'none',
      canary_enabled: AUTONOMY_MULTI_STRATEGY_CANARY_ENABLED,
      canary_due: false,
      active_count: 0,
      attempt_index: attemptIndex,
      ranked: []
    };
  }

  const ranked = variantRows
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || String(a.id || '').localeCompare(String(b.id || '')))
    .slice(0, Math.max(1, AUTONOMY_MULTI_STRATEGY_MAX_ACTIVE));

  const defaultRow = ranked[0] || {
    strategy: fallback,
    id: String(fallback.id || ''),
    score: 0,
    confidence: 0,
    stage: null,
    execution_mode: strategyExecutionMode(fallback, 'score_only')
  };

  const canaryPool = ranked.filter((row, idx) => {
    if (idx === 0) return false;
    if (!row || !row.strategy) return false;
    if (AUTONOMY_MULTI_STRATEGY_CANARY_ALLOW_EXECUTE) return true;
    return String(row.execution_mode || '') !== 'execute';
  });
  const canaryEvery = AUTONOMY_MULTI_STRATEGY_CANARY_FRACTION > 0
    ? Math.max(2, Math.round(1 / AUTONOMY_MULTI_STRATEGY_CANARY_FRACTION))
    : Number.POSITIVE_INFINITY;
  const canaryDue = AUTONOMY_MULTI_STRATEGY_CANARY_ENABLED
    && canaryPool.length > 0
    && Number.isFinite(canaryEvery)
    && canaryEvery > 0
    && (attemptIndex % canaryEvery === 0);
  const canaryIdx = canaryDue
    ? stableSelectionIndex(`${dateStr}|${attemptIndex}|${canaryPool.map((row) => row.id).join(',')}`, canaryPool.length)
    : 0;
  const selectedRow = canaryDue ? canaryPool[canaryIdx] : defaultRow;

  return {
    strategy: selectedRow && selectedRow.strategy ? selectedRow.strategy : fallback,
    mode: canaryDue ? 'canary_variant' : 'primary_best',
    canary_enabled: AUTONOMY_MULTI_STRATEGY_CANARY_ENABLED,
    canary_due: canaryDue,
    canary_every: Number.isFinite(canaryEvery) ? canaryEvery : null,
    attempt_index: attemptIndex,
    active_count: ranked.length,
    ranked: ranked.map((row) => ({
      strategy_id: row.id,
      score: Number(row.score || 0),
      confidence: Number(row.confidence || 0),
      stage: row.stage || null,
      execution_mode: row.execution_mode
    }))
  };
}

function outcomeFitnessPolicy() {
  if (OUTCOME_FITNESS_POLICY_CACHE !== undefined) return OUTCOME_FITNESS_POLICY_CACHE;
  const loaded = loadOutcomeFitnessPolicy(REPO_ROOT);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'outcome_fitness_policy',
      {
        policy: loaded && typeof loaded === 'object' ? loaded : null
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      OUTCOME_FITNESS_POLICY_CACHE = payload.policy && typeof payload.policy === 'object'
        ? payload.policy
        : {};
      return OUTCOME_FITNESS_POLICY_CACHE;
    }
  }
  OUTCOME_FITNESS_POLICY_CACHE = loaded;
  return OUTCOME_FITNESS_POLICY_CACHE;
}

function effectiveStrategyBudget(strategyOverride = null) {
  const strategy = strategyOverride || strategyProfile();
  const caps = strategyBudgetCaps(strategy, {
    daily_runs_cap: AUTONOMY_MAX_RUNS_PER_DAY,
    daily_token_cap: DAILY_TOKEN_CAP
  });
  const hardRuns = Number.isFinite(Number(AUTONOMY_HARD_MAX_DAILY_RUNS_CAP)) && Number(AUTONOMY_HARD_MAX_DAILY_RUNS_CAP) > 0
    ? Number(AUTONOMY_HARD_MAX_DAILY_RUNS_CAP)
    : null;
  const hardTokens = Number.isFinite(Number(AUTONOMY_HARD_MAX_DAILY_TOKEN_CAP)) && Number(AUTONOMY_HARD_MAX_DAILY_TOKEN_CAP) > 0
    ? Number(AUTONOMY_HARD_MAX_DAILY_TOKEN_CAP)
    : null;
  const hardPerAction = Number.isFinite(Number(AUTONOMY_HARD_MAX_TOKENS_PER_ACTION)) && Number(AUTONOMY_HARD_MAX_TOKENS_PER_ACTION) > 0
    ? Number(AUTONOMY_HARD_MAX_TOKENS_PER_ACTION)
    : null;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'strategy_budget_effective',
      {
        caps,
        hard_runs: hardRuns,
        hard_tokens: hardTokens,
        hard_per_action: hardPerAction
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const budget = rust.payload.payload.budget && typeof rust.payload.payload.budget === 'object'
        ? rust.payload.payload.budget
        : null;
      if (budget) return budget;
    }
  }
  const out = { ...caps };
  if (hardRuns != null && Number.isFinite(Number(out.daily_runs_cap))) {
    out.daily_runs_cap = Math.min(Number(out.daily_runs_cap), hardRuns);
  }
  if (hardTokens != null && Number.isFinite(Number(out.daily_token_cap))) {
    out.daily_token_cap = Math.min(Number(out.daily_token_cap), hardTokens);
  }
  if (hardPerAction != null && Number.isFinite(Number(out.max_tokens_per_action))) {
    out.max_tokens_per_action = Math.min(Number(out.max_tokens_per_action), hardPerAction);
  }
  return out;
}

function effectiveStrategyExecutionMode(strategyOverride = null) {
  const strategy = strategyOverride || strategyProfile();
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'strategy_execution_mode_effective',
      {
        strategy_mode: strategy && strategy.execution_policy ? strategy.execution_policy.mode : null,
        fallback: 'execute'
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const mode = String(rust.payload.payload.mode || '').trim().toLowerCase();
      if (mode === 'execute' || mode === 'canary_execute' || mode === 'score_only') {
        return mode;
      }
    }
  }
  return strategyExecutionMode(strategy, 'execute');
}

function effectiveStrategyCanaryExecLimit(strategyOverride = null) {
  const strategy = strategyOverride || strategyProfile();
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'strategy_canary_exec_limit_effective',
      {
        strategy_limit: strategy && strategy.execution_policy
          ? strategy.execution_policy.canary_daily_exec_limit
          : null,
        fallback: AUTONOMY_CANARY_DAILY_EXEC_LIMIT
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const raw = rust.payload.payload.limit;
      if (raw == null || String(raw).trim() === '') return null;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return Math.max(1, Math.min(20, Math.round(n)));
    }
  }
  return strategyCanaryDailyExecLimit(strategy, AUTONOMY_CANARY_DAILY_EXEC_LIMIT);
}

function effectiveStrategyExploration(strategyOverride = null) {
  const strategy = strategyOverride || strategyProfile();
  const defaults = {
    fraction: AUTONOMY_EXPLORE_FRACTION,
    every_n: AUTONOMY_EXPLORE_EVERY_N,
    min_eligible: AUTONOMY_EXPLORE_MIN_ELIGIBLE
  };
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'strategy_exploration_effective',
      {
        strategy_exploration: strategy && strategy.exploration_policy ? strategy.exploration_policy : null,
        default_fraction: defaults.fraction,
        default_every_n: defaults.every_n,
        default_min_eligible: defaults.min_eligible
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      const fraction = Number(payload.fraction);
      const everyN = Number(payload.every_n);
      const minEligible = Number(payload.min_eligible);
      if (Number.isFinite(fraction) && Number.isFinite(everyN) && Number.isFinite(minEligible)) {
        return {
          fraction,
          every_n: everyN,
          min_eligible: minEligible
        };
      }
    }
  }
  return strategyExplorationPolicy(strategy, defaults);
}

function isExecuteMode(mode) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'is_execute_mode',
      { execution_mode: mode == null ? null : String(mode) },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.execute_mode === true;
    }
  }
  return mode === 'execute' || mode === 'canary_execute';
}

function executionAllowedByFeatureFlag(executionMode, shadowOnly = false) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'execution_allowed_by_feature_flag',
      {
        execution_mode: executionMode == null ? null : String(executionMode),
        shadow_only: shadowOnly === true,
        autonomy_enabled: String(process.env.AUTONOMY_ENABLED || '') === '1',
        canary_allow_with_flag_off: AUTONOMY_CANARY_ALLOW_WITH_FLAG_OFF === true
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.allowed === true;
    }
  }
  if (shadowOnly) return true;
  if (String(process.env.AUTONOMY_ENABLED || '') === '1') return true;
  return AUTONOMY_CANARY_ALLOW_WITH_FLAG_OFF && String(executionMode || '') === 'canary_execute';
}

function isTier1ObjectiveId(objectiveId) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'is_tier1_objective_id',
      { objective_id: objectiveId == null ? null : String(objectiveId) },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.tier1 === true;
    }
  }
  const id = String(objectiveId || '').trim();
  if (!id) return false;
  return /^T1(?:\b|[_:-])/i.test(id);
}

function isTier1CandidateObjective(candidate) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const c = candidate && typeof candidate === 'object' ? candidate : {};
    const binding = c.objective_binding && typeof c.objective_binding === 'object' ? c.objective_binding : {};
    const pulse = c.directive_pulse && typeof c.directive_pulse === 'object' ? c.directive_pulse : {};
    const pulseTierRaw = Number(pulse.tier);
    const rust = runBacklogAutoscalePrimitive(
      'is_tier1_candidate_objective',
      {
        objective_binding_objective_id: binding.objective_id == null ? null : String(binding.objective_id),
        directive_pulse_tier: Number.isFinite(pulseTierRaw) ? pulseTierRaw : null,
        directive_pulse_objective_id: pulse.objective_id == null ? null : String(pulse.objective_id)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.tier1 === true;
    }
  }
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const binding = c.objective_binding && typeof c.objective_binding === 'object' ? c.objective_binding : {};
  const pulse = c.directive_pulse && typeof c.directive_pulse === 'object' ? c.directive_pulse : {};
  const pulseTier = normalizeDirectiveTier(pulse.tier, 99);
  if (pulseTier <= 1) return true;
  if (isTier1ObjectiveId(binding.objective_id)) return true;
  if (isTier1ObjectiveId(pulse.objective_id)) return true;
  return false;
}

function needsExecutionQuota(executionMode, shadowOnly, executedToday) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const minDailyExecutions = Number(AUTONOMY_MIN_DAILY_EXECUTIONS);
    const rust = runBacklogAutoscalePrimitive(
      'needs_execution_quota',
      {
        execution_mode: executionMode == null ? null : String(executionMode),
        shadow_only: shadowOnly === true,
        executed_today: Number(executedToday || 0),
        min_daily_executions: Number.isFinite(minDailyExecutions) ? minDailyExecutions : Number.NaN
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.required === true;
    }
  }
  if (shadowOnly) return false;
  if (!isExecuteMode(executionMode)) return false;
  if (!Number.isFinite(Number(AUTONOMY_MIN_DAILY_EXECUTIONS)) || Number(AUTONOMY_MIN_DAILY_EXECUTIONS) <= 0) return false;
  return Number(executedToday || 0) < Number(AUTONOMY_MIN_DAILY_EXECUTIONS);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ensureState() {
  [AUTONOMY_DIR, RUNS_DIR, EXPERIMENTS_DIR, DAILY_BUDGET_DIR, RECEIPTS_DIR, OUTCOME_FALLBACK_DIR, path.dirname(NON_YIELD_LEDGER_PATH)].forEach(ensureDir);
}

function nowIso() {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'now_iso',
      { now_iso: null },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const value = String(rust.payload.payload.value || '').trim();
      if (value) return value;
    }
  }
  return new Date().toISOString();
}

function todayStr() {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'today_str',
      { now_iso: null },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const value = String(rust.payload.payload.value || '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    }
  }
  return new Date().toISOString().slice(0, 10);
}

function dateArgOrToday(v) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'date_arg_or_today',
      {
        value: v == null ? null : String(v),
        today: todayStr()
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return String(rust.payload.payload.date || '');
    }
  }
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return todayStr();
}

function parseArg(name) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'parse_arg',
      {
        args: Array.isArray(process.argv) ? process.argv.map((x) => String(x || '')) : [],
        name: name == null ? null : String(name)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.value == null ? null : String(rust.payload.payload.value);
    }
  }
  const pref = `--${name}=`;
  const a = process.argv.find(x => x.startsWith(pref));
  return a ? a.slice(pref.length) : null;
}

function appendJsonl(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

function defaultCriteriaPatternMemory() {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'default_criteria_pattern_memory',
      { },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      if (payload && typeof payload === 'object') {
        return {
          version: String(payload.version || '1.0'),
          updated_at: payload.updated_at ? String(payload.updated_at) : null,
          patterns: payload.patterns && typeof payload.patterns === 'object' ? payload.patterns : {}
        };
      }
    }
  }
  return {
    version: '1.0',
    updated_at: null,
    patterns: {}
  };
}

function loadCriteriaPatternMemory() {
  const raw = loadJson(SUCCESS_CRITERIA_PATTERN_STATE_PATH, null);
  const base = defaultCriteriaPatternMemory();
  if (!raw || typeof raw !== 'object') return base;
  const patterns = raw.patterns && typeof raw.patterns === 'object' ? raw.patterns : {};
  const normalized = {};
  for (const [key, value] of Object.entries(patterns)) {
    const k = normalizeSpaces(key).toLowerCase();
    if (!k) continue;
    const row = value && typeof value === 'object' ? value as AnyObj : {};
    normalized[k] = {
      failures: Math.max(0, Number(row.failures || 0)),
      passes: Math.max(0, Number(row.passes || 0)),
      last_failure_ts: row.last_failure_ts ? String(row.last_failure_ts) : null,
      last_pass_ts: row.last_pass_ts ? String(row.last_pass_ts) : null
    };
  }
  return {
    version: '1.0',
    updated_at: raw.updated_at ? String(raw.updated_at) : null,
    patterns: normalized
  };
}

function saveCriteriaPatternMemory(memory) {
  const src = memory && typeof memory === 'object' ? memory : defaultCriteriaPatternMemory();
  const patterns = src.patterns && typeof src.patterns === 'object' ? src.patterns : {};
  saveJson(SUCCESS_CRITERIA_PATTERN_STATE_PATH, {
    version: '1.0',
    updated_at: nowIso(),
    patterns
  });
}

function normalizeCriteriaMetric(v) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'normalize_criteria_metric',
      { value: v == null ? null : String(v) },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return String(rust.payload.payload.metric || '');
    }
  }
  return normalizeSpaces(v).toLowerCase().replace(/[\s-]+/g, '_');
}

function deleteFileIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // best effort
  }
}

function humanCanaryOverrideApprovalPhrase(dateStr, nonce) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'human_canary_override_approval_phrase',
      {
        prefix: HUMAN_CANARY_OVERRIDE_PREFIX,
        date_str: dateStr == null ? null : String(dateStr),
        nonce: nonce == null ? null : String(nonce)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const phrase = String(rust.payload.payload.phrase || '');
      if (phrase) return phrase;
    }
  }
  return `${HUMAN_CANARY_OVERRIDE_PREFIX}:${String(dateStr || '')}:${String(nonce || '')}`;
}

function readHumanCanaryOverride() {
  const raw = loadJson(HUMAN_CANARY_OVERRIDE_PATH, null);
  if (!raw || typeof raw !== 'object') return null;
  return raw;
}

function writeHumanCanaryOverride(obj) {
  saveJson(HUMAN_CANARY_OVERRIDE_PATH, obj && typeof obj === 'object' ? obj : {});
}

function auditHumanCanaryOverride(type, payload) {
  appendJsonl(HUMAN_CANARY_OVERRIDE_AUDIT_PATH, {
    ts: nowIso(),
    ...(payload && typeof payload === 'object' ? payload : {}),
    type: String(type || 'human_canary_override_event')
  });
}

function parseHumanCanaryOverrideState(rec) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'parse_human_canary_override_state',
      {
        record: rec && typeof rec === 'object' ? rec : null,
        now_ms: Date.now()
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      const active = payload.active === true;
      const reason = String(payload.reason || (active ? 'ok' : 'missing'));
      const expired = payload.expired === true;
      const remaining = Number(payload.remaining || 0);
      if (!active) {
        if (reason === 'depleted' || reason === 'expired') {
          return { active: false, reason, expired, remaining };
        }
        return { active: false, reason };
      }
      return {
        active: true,
        reason,
        expired: payload.expired === true,
        remaining: Number(payload.remaining || 0),
        expires_at: String(payload.expires_at || ''),
        date: String(payload.date || ''),
        require_execution_mode: String(payload.require_execution_mode || ''),
        id: String(payload.id || ''),
        type: String(payload.type || '')
      };
    }
  }
  const o = rec && typeof rec === 'object' ? rec : null;
  if (!o) return { active: false, reason: 'missing' };
  const expMs = Date.parse(String(o.expires_at || ''));
  const remaining = Number(o.remaining_uses || 0);
  const expired = !Number.isFinite(expMs) || Date.now() > expMs;
  if (remaining <= 0) return { active: false, reason: 'depleted', expired, remaining };
  if (expired) return { active: false, reason: 'expired', expired, remaining };
  return {
    active: true,
    reason: 'ok',
    expired: false,
    remaining,
    expires_at: String(o.expires_at || ''),
    date: String(o.date || ''),
    require_execution_mode: String(o.require_execution_mode || ''),
    id: String(o.id || ''),
    type: String(o.type || '')
  };
}

function consumeHumanCanaryDailyCapOverrideIfAllowed({ dateStr, executionMode, attemptsToday, maxRunsPerDay, shadowOnly }) {
  if (shadowOnly) return { consumed: false, reason: 'shadow_mode' };
  if (String(executionMode || '') !== 'canary_execute') return { consumed: false, reason: 'not_canary_execute' };
  if (!(Number(maxRunsPerDay) > 0 && Number(attemptsToday) >= Number(maxRunsPerDay))) {
    return { consumed: false, reason: 'not_required' };
  }
  const rec = readHumanCanaryOverride();
  const state = parseHumanCanaryOverrideState(rec);
  if (!state.active) {
    if (state.reason === 'expired' || state.reason === 'depleted') deleteFileIfExists(HUMAN_CANARY_OVERRIDE_PATH);
    return { consumed: false, reason: state.reason || 'missing' };
  }
  if (state.type !== 'daily_cap_once') return { consumed: false, reason: 'invalid_type' };
  if (state.date && state.date !== String(dateStr || '')) return { consumed: false, reason: 'date_mismatch' };
  if (state.require_execution_mode && state.require_execution_mode !== String(executionMode || '')) {
    return { consumed: false, reason: 'mode_mismatch' };
  }

  const nextRemaining = Math.max(0, Number(state.remaining || 0) - 1);
  const next = {
    ...rec,
    remaining_uses: nextRemaining,
    last_used_at: nowIso(),
    last_used_for_date: String(dateStr || ''),
    last_used_for_mode: String(executionMode || '')
  };
  if (nextRemaining <= 0) deleteFileIfExists(HUMAN_CANARY_OVERRIDE_PATH);
  else writeHumanCanaryOverride(next);

  const evt = {
    override_id: state.id || null,
    date: String(dateStr || ''),
    execution_mode: String(executionMode || ''),
    attempts_today: Number(attemptsToday || 0),
    max_runs_per_day: Number(maxRunsPerDay || 0),
    remaining_uses_after: nextRemaining,
    expires_at: state.expires_at || null
  };
  auditHumanCanaryOverride('human_canary_override_consumed', evt);
  writeRun(dateStr, { ts: nowIso(), type: 'human_canary_override_consumed', ...evt });
  return {
    consumed: true,
    ...evt
  };
}

function issueHumanCanaryOverrideCmd(dateStr) {
  if (String(process.env.AUTONOMY_ENABLED || '0') === '1') {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'autonomy_enabled_context_denied',
      detail: 'Disable AUTONOMY_ENABLED when issuing a human override.',
      ts: nowIso()
    }) + '\n');
    process.exit(2);
  }
  if (HUMAN_CANARY_OVERRIDE_REQUIRE_TTY && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'interactive_tty_required',
      detail: 'Issue override from an interactive human terminal session.',
      ts: nowIso()
    }) + '\n');
    process.exit(2);
  }

  const nonce = String(parseArg('nonce') || '').trim();
  const approve = String(parseArg('approve') || '').trim();
  const note = String(parseArg('note') || '').slice(0, 200);
  const ttlRaw = Number(parseArg('ttl_minutes') || HUMAN_CANARY_OVERRIDE_DEFAULT_TTL_MINUTES);
  const ttlMinutes = Number.isFinite(ttlRaw)
    ? Math.max(1, Math.min(Math.max(1, HUMAN_CANARY_OVERRIDE_MAX_TTL_MINUTES), Math.round(ttlRaw)))
    : Math.max(1, Math.min(Math.max(1, HUMAN_CANARY_OVERRIDE_MAX_TTL_MINUTES), Math.round(HUMAN_CANARY_OVERRIDE_DEFAULT_TTL_MINUTES)));

  if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'invalid_nonce',
      detail: 'nonce must match /^[A-Za-z0-9_-]{8,64}$/',
      ts: nowIso()
    }) + '\n');
    process.exit(2);
  }

  const expectedApproval = humanCanaryOverrideApprovalPhrase(dateStr, nonce);
  if (approve !== expectedApproval) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'approval_phrase_mismatch',
      expected_format: `${HUMAN_CANARY_OVERRIDE_PREFIX}:YYYY-MM-DD:<nonce>`,
      example: expectedApproval,
      ts: nowIso()
    }) + '\n');
    process.exit(2);
  }

  const issuedAt = nowIso();
  const expiresMs = Date.now() + (ttlMinutes * 60 * 1000);
  const rec = {
    id: `hco_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`,
    type: 'daily_cap_once',
    date: String(dateStr || ''),
    issued_at: issuedAt,
    expires_at: new Date(expiresMs).toISOString(),
    remaining_uses: 1,
    require_execution_mode: 'canary_execute',
    created_by: 'human_tty',
    nonce_hash: crypto.createHash('sha256').update(nonce).digest('hex').slice(0, 16),
    note: note || null
  };
  writeHumanCanaryOverride(rec);

  const evt = {
    override_id: rec.id,
    date: rec.date,
    override_type: rec.type,
    require_execution_mode: rec.require_execution_mode,
    expires_at: rec.expires_at,
    remaining_uses: rec.remaining_uses,
    issued_by: rec.created_by,
    note: rec.note
  };
  auditHumanCanaryOverride('human_canary_override_issued', evt);
  writeRun(dateStr, { ts: nowIso(), type: 'human_canary_override_issued', ...evt });
  process.stdout.write(JSON.stringify({
    ok: true,
    result: 'human_canary_override_issued',
    ...evt,
    ts: nowIso()
  }) + '\n');
}

function humanCanaryOverrideStatusCmd() {
  const rec = readHumanCanaryOverride();
  const state = parseHumanCanaryOverrideState(rec);
  if (!rec) {
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'human_canary_override_none',
      active: false,
      ts: nowIso()
    }) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    result: 'human_canary_override_status',
    active: state.active === true,
    reason: state.reason,
    id: String(rec.id || ''),
    type: String(rec.type || ''),
    date: String(rec.date || ''),
    require_execution_mode: String(rec.require_execution_mode || ''),
    expires_at: String(rec.expires_at || ''),
    remaining_uses: Number(rec.remaining_uses || 0),
    issued_at: String(rec.issued_at || ''),
    last_used_at: String(rec.last_used_at || ''),
    created_by: String(rec.created_by || ''),
    ts: nowIso()
  }) + '\n');
}

function revokeHumanCanaryOverrideCmd(dateStr) {
  const rec = readHumanCanaryOverride();
  if (!rec) {
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'human_canary_override_none',
      revoked: false,
      ts: nowIso()
    }) + '\n');
    return;
  }
  deleteFileIfExists(HUMAN_CANARY_OVERRIDE_PATH);
  const evt = {
    override_id: String(rec.id || ''),
    date: String(rec.date || ''),
    override_type: String(rec.type || ''),
    revoked_by: 'manual_cli'
  };
  auditHumanCanaryOverride('human_canary_override_revoked', evt);
  writeRun(dateStr, { ts: nowIso(), type: 'human_canary_override_revoked', ...evt });
  process.stdout.write(JSON.stringify({
    ok: true,
    result: 'human_canary_override_revoked',
    revoked: true,
    ...evt,
    ts: nowIso()
  }) + '\n');
}

function loadShortCircuitState() {
  const raw = loadJson(SHORT_CIRCUIT_PATH, {});
  if (!raw || typeof raw !== 'object') return { entries: {} };
  if (!raw.entries || typeof raw.entries !== 'object') raw.entries = {};
  return raw;
}

function saveShortCircuitState(state) {
  saveJson(SHORT_CIRCUIT_PATH, state && typeof state === 'object' ? state : { entries: {} });
}

function autonomyStateFingerprint({
  dateStr,
  proposalDate,
  executionMode,
  shadowOnly,
  strategyId,
  pool,
  admission
}) {
  const sample = Array.isArray(pool)
    ? pool.slice(0, 24).map((entry) => {
        const p = entry && entry.proposal ? entry.proposal : {};
        const scoreRaw = Number(entry && entry.score);
        return {
          id: String(p.id || ''),
          type: String(p.type || ''),
          risk: normalizedRisk(p.risk),
          score: Number.isFinite(scoreRaw) ? Number(scoreRaw.toFixed(3)) : null,
          status: String(entry && entry.status || ''),
          source_eye: sourceEyeId(p),
          key: String(entry && entry.dedup_key || '')
        };
      })
    : [];
  const payload = {
    date: String(dateStr || ''),
    proposal_date: String(proposalDate || ''),
    execution_mode: String(executionMode || ''),
    shadow_only: !!shadowOnly,
    strategy_id: String(strategyId || ''),
    sample,
    admission: admission && typeof admission === 'object'
      ? {
          total: Number(admission.total || 0),
          eligible: Number(admission.eligible || 0),
          blocked: Number(admission.blocked || 0),
          blocked_by_reason: admission.blocked_by_reason || {}
        }
      : null
  };
  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}

function checkUnchangedShortCircuit(key, fingerprint, ttlMinutesRaw) {
  const ttlMinutes = Number.isFinite(Number(ttlMinutesRaw))
    ? Math.max(5, Math.min(240, Math.round(Number(ttlMinutesRaw))))
    : 30;
  const state = loadShortCircuitState();
  const prev = state.entries && state.entries[key] ? state.entries[key] : null;
  const nowMs = Date.now();
  const prevMs = prev && prev.ts ? Date.parse(String(prev.ts)) : NaN;
  const ageMinutes = Number.isFinite(prevMs) ? (nowMs - prevMs) / 60000 : null;
  const same = !!(prev && String(prev.fingerprint || '') === String(fingerprint || ''));
  const hit = same && ageMinutes != null && ageMinutes >= 0 && ageMinutes <= ttlMinutes;

  state.entries = state.entries || {};
  state.entries[key] = {
    ts: nowIso(),
    fingerprint: String(fingerprint || ''),
    ttl_minutes: ttlMinutes
  };
  saveShortCircuitState(state);

  return {
    hit,
    ttl_minutes: ttlMinutes,
    age_minutes: ageMinutes == null ? null : Number(ageMinutes.toFixed(2))
  };
}

function peekUnchangedShortCircuit(key, fingerprint, ttlMinutesRaw) {
  const ttlMinutes = Number.isFinite(Number(ttlMinutesRaw))
    ? Math.max(5, Math.min(240, Math.round(Number(ttlMinutesRaw))))
    : 30;
  const state = loadShortCircuitState();
  const prev = state.entries && state.entries[key] ? state.entries[key] : null;
  const nowMs = Date.now();
  const prevMs = prev && prev.ts ? Date.parse(String(prev.ts)) : NaN;
  const ageMinutes = Number.isFinite(prevMs) ? (nowMs - prevMs) / 60000 : null;
  const same = !!(prev && String(prev.fingerprint || '') === String(fingerprint || ''));
  const hit = same && ageMinutes != null && ageMinutes >= 0 && ageMinutes <= ttlMinutes;
  return {
    hit,
    ttl_minutes: ttlMinutes,
    age_minutes: ageMinutes == null ? null : Number(ageMinutes.toFixed(2))
  };
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function spawnCapacityBoostSnapshot(nowMs = Date.now()) {
  const base = {
    enabled: AUTONOMY_DYNAMIC_IO_CAP_RESET_ON_SPAWN,
    active: false,
    lookback_minutes: AUTONOMY_DYNAMIC_IO_CAP_SPAWN_LOOKBACK_MINUTES,
    min_granted_cells: AUTONOMY_DYNAMIC_IO_CAP_SPAWN_MIN_GRANTED_CELLS,
    grant_count: 0,
    granted_cells: 0,
    latest_ts: null
  };
  if (!AUTONOMY_DYNAMIC_IO_CAP_RESET_ON_SPAWN) return base;
  const rows = readJsonl(SPAWN_EVENTS_PATH);
  if (!rows.length) return base;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'spawn_capacity_boost_snapshot',
      {
        enabled: AUTONOMY_DYNAMIC_IO_CAP_RESET_ON_SPAWN,
        lookback_minutes: AUTONOMY_DYNAMIC_IO_CAP_SPAWN_LOOKBACK_MINUTES,
        min_granted_cells: AUTONOMY_DYNAMIC_IO_CAP_SPAWN_MIN_GRANTED_CELLS,
        now_ms: Number(nowMs),
        rows
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  const cutoffMs = Number(nowMs) - (AUTONOMY_DYNAMIC_IO_CAP_SPAWN_LOOKBACK_MINUTES * 60000);
  let grantCount = 0;
  let grantedCells = 0;
  let latestTs = null;
  for (let idx = rows.length - 1; idx >= 0; idx -= 1) {
    const row = rows[idx];
    if (!row || row.type !== 'spawn_request') continue;
    const ts = String(row.ts || '');
    const tsMs = Date.parse(ts);
    if (!Number.isFinite(tsMs)) continue;
    if (tsMs < cutoffMs) break;
    const granted = Number(row.granted_cells || 0);
    if (!Number.isFinite(granted) || granted < AUTONOMY_DYNAMIC_IO_CAP_SPAWN_MIN_GRANTED_CELLS) continue;
    grantCount += 1;
    grantedCells += granted;
    if (!latestTs) latestTs = ts;
  }
  return {
    ...base,
    active: grantCount > 0,
    grant_count: grantCount,
    granted_cells: Number(grantedCells.toFixed(3)),
    latest_ts: latestTs
  };
}

function defaultBacklogAutoscaleState() {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'default_backlog_autoscale_state',
      {
        module: AUTONOMY_BACKLOG_AUTOSCALE_MODULE
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  return {
    schema_id: 'autonomy_backlog_autoscale',
    schema_version: '1.0.0',
    module: AUTONOMY_BACKLOG_AUTOSCALE_MODULE,
    current_cells: 0,
    target_cells: 0,
    last_run_ts: null,
    last_high_pressure_ts: null,
    last_action: null,
    updated_at: null
  };
}

function loadBacklogAutoscaleState(filePath = BACKLOG_AUTOSCALE_STATE_PATH) {
  const raw = loadJson(filePath, null);
  const base = defaultBacklogAutoscaleState();
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'normalize_backlog_autoscale_state',
      {
        module: AUTONOMY_BACKLOG_AUTOSCALE_MODULE,
        src: raw && typeof raw === 'object' ? raw : {}
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    ...base,
    ...src,
    module: String(src.module || base.module),
    current_cells: Math.max(0, Number(src.current_cells || 0)),
    target_cells: Math.max(0, Number(src.target_cells || 0)),
    last_run_ts: src.last_run_ts ? String(src.last_run_ts) : null,
    last_high_pressure_ts: src.last_high_pressure_ts ? String(src.last_high_pressure_ts) : null,
    last_action: src.last_action ? String(src.last_action) : null,
    updated_at: src.updated_at ? String(src.updated_at) : null
  };
}

function saveBacklogAutoscaleState(state, filePath = BACKLOG_AUTOSCALE_STATE_PATH) {
  const next = state && typeof state === 'object' ? state : defaultBacklogAutoscaleState();
  saveJson(filePath, {
    ...next,
    updated_at: nowIso()
  });
}

function spawnAllocatedCells() {
  const allocations = loadJson(path.join(SPAWN_STATE_DIR, 'allocations.json'), {});
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'spawn_allocated_cells',
      {
        active_cells: allocations && allocations.active_cells != null ? Number(allocations.active_cells) : null,
        current_cells: allocations && allocations.current_cells != null ? Number(allocations.current_cells) : null,
        allocated_cells: allocations && allocations.allocated_cells != null ? Number(allocations.allocated_cells) : null
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      if (payload.active_cells != null) {
        const resolved = Number(payload.active_cells);
        if (Number.isFinite(resolved)) return Math.max(0, Math.floor(resolved));
      }
    }
  }
  const active = Number(
    allocations && allocations.active_cells != null
      ? allocations.active_cells
      : (allocations && allocations.current_cells != null
        ? allocations.current_cells
        : allocations && allocations.allocated_cells)
  );
  if (Number.isFinite(active)) return Math.max(0, Math.floor(active));
  const state = loadBacklogAutoscaleState();
  return Math.max(0, Math.floor(Number(state.current_cells || 0)));
}

function normalizeQueuePressure(queuePressure: AnyObj = {}) {
  const src = queuePressure && typeof queuePressure === 'object' ? queuePressure : {};
  const pending = Math.max(0, Number(src.pending || 0));
  const total = Math.max(0, Number(src.total || 0));
  const pendingRatioRaw = Number(src.pending_ratio);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'normalize_queue',
      {
        pressure: src.pressure != null ? String(src.pressure) : '',
        pending,
        total,
        pending_ratio: Number.isFinite(pendingRatioRaw) ? pendingRatioRaw : null,
        warn_pending_count: AUTONOMY_QOS_QUEUE_PENDING_WARN_COUNT,
        critical_pending_count: AUTONOMY_QOS_QUEUE_PENDING_CRITICAL_COUNT,
        warn_pending_ratio: AUTONOMY_QOS_QUEUE_PENDING_WARN_RATIO,
        critical_pending_ratio: AUTONOMY_QOS_QUEUE_PENDING_CRITICAL_RATIO
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
    const pendingRatio = Number.isFinite(pendingRatioRaw)
      ? Math.max(0, Math.min(1, pendingRatioRaw))
      : (total > 0 ? pending / total : 0);
    return {
      pressure: 'critical',
      pending,
      total,
      pending_ratio: Number(pendingRatio.toFixed(6))
    };
  }
  const pendingRatio = Number.isFinite(pendingRatioRaw)
    ? Math.max(0, Math.min(1, pendingRatioRaw))
    : (total > 0 ? pending / total : 0);
  let pressure = String(src.pressure || '').trim().toLowerCase();
  if (pressure !== 'critical' && pressure !== 'warning' && pressure !== 'normal') {
    pressure = 'normal';
    if (
      pending >= AUTONOMY_QOS_QUEUE_PENDING_CRITICAL_COUNT
      || pendingRatio >= AUTONOMY_QOS_QUEUE_PENDING_CRITICAL_RATIO
    ) {
      pressure = 'critical';
    } else if (
      pending >= AUTONOMY_QOS_QUEUE_PENDING_WARN_COUNT
      || pendingRatio >= AUTONOMY_QOS_QUEUE_PENDING_WARN_RATIO
    ) {
      pressure = 'warning';
    }
  }
  return {
    pressure,
    pending,
    total,
    pending_ratio: Number(pendingRatio.toFixed(6))
  };
}

function adaptiveExecutionCaps(input: AnyObj = {}) {
  const baseDailyCap = Math.max(1, Number(input.baseDailyCap || AUTONOMY_MAX_RUNS_PER_DAY));
  const baseCanaryCapRaw = Number(input.baseCanaryCap);
  const baseCanaryCap = Number.isFinite(baseCanaryCapRaw) ? Math.max(0, Math.floor(baseCanaryCapRaw)) : null;
  const candidatePoolSizeRaw = Number(input.candidatePoolSize);
  const admission = input.admission && typeof input.admission === 'object' ? input.admission : {};
  const candidatePoolSize = Number.isFinite(candidatePoolSizeRaw)
    ? Math.max(0, Math.floor(candidatePoolSizeRaw))
    : Math.max(0, Math.floor(Number(admission.total || 0)));
  const queuePressure = normalizeQueuePressure(input.queuePressure && typeof input.queuePressure === 'object' ? input.queuePressure : {});
  const policyHold = input.policyHoldPressure && typeof input.policyHoldPressure === 'object' ? input.policyHoldPressure : {};
  const spawnCapacityBoost = input.spawnCapacityBoost && typeof input.spawnCapacityBoost === 'object'
    ? input.spawnCapacityBoost
    : { enabled: false, active: false };
  const out: AnyObj = {
    enabled: AUTONOMY_DYNAMIC_IO_CAP_ENABLED,
    daily_runs_cap: baseDailyCap,
    canary_daily_exec_cap: baseCanaryCap,
    input_candidates_cap: null,
    inputCandidateCap: null,
    low_yield: false,
    high_yield: false,
    spawn_reset_active: false,
    queue_pressure: queuePressure.pressure,
    policy_hold_level: String(policyHold.level || 'normal'),
    reasons: []
  };

  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'dynamic_caps',
      {
        enabled: AUTONOMY_DYNAMIC_IO_CAP_ENABLED,
        base_daily_cap: baseDailyCap,
        base_canary_cap: baseCanaryCap,
        candidate_pool_size: candidatePoolSize,
        queue_pressure: queuePressure.pressure,
        policy_hold_level: String(policyHold.level || 'normal'),
        policy_hold_applicable: policyHold.applicable === true,
        spawn_boost_enabled: spawnCapacityBoost.enabled === true,
        spawn_boost_active: spawnCapacityBoost.active === true,
        shipped_today: Number(input.shippedToday || 0),
        no_progress_streak: Number(input.noProgressStreak || 0),
        gate_exhaustion_streak: Number(input.gateExhaustionStreak || 0),
        warn_factor: AUTONOMY_DYNAMIC_IO_CAP_WARN_FACTOR,
        critical_factor: AUTONOMY_DYNAMIC_IO_CAP_CRITICAL_FACTOR,
        min_input_pool: AUTONOMY_DYNAMIC_IO_CAP_MIN_INPUT_POOL
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      const inputCandidateCap = payload.inputCandidateCap != null
        ? payload.inputCandidateCap
        : (payload.input_candidate_cap_alias != null ? payload.input_candidate_cap_alias : null);
      return {
        ...payload,
        inputCandidateCap
      };
    }
    return {
      ...out,
      daily_runs_cap: 1,
      input_candidates_cap: AUTONOMY_DYNAMIC_IO_CAP_MIN_INPUT_POOL,
      inputCandidateCap: AUTONOMY_DYNAMIC_IO_CAP_MIN_INPUT_POOL,
      low_yield: true,
      high_yield: false,
      reasons: ['rust_dynamic_caps_unavailable']
    };
  }

  const markLowYield = (reason: string) => {
    out.low_yield = true;
    if (!out.reasons.includes(reason)) out.reasons.push(reason);
  };

  if (AUTONOMY_DYNAMIC_IO_CAP_ENABLED) {
    let factor = 1;
    if (queuePressure.pressure === 'critical') {
      factor = AUTONOMY_DYNAMIC_IO_CAP_CRITICAL_FACTOR;
      markLowYield('downshift_queue_backlog_critical');
    } else if (queuePressure.pressure === 'warning') {
      factor = AUTONOMY_DYNAMIC_IO_CAP_WARN_FACTOR;
      markLowYield('downshift_queue_backlog_warning');
    }
    if (factor < 1) {
      const loweredRuns = Math.max(1, Math.floor(baseDailyCap * factor));
      out.daily_runs_cap = Math.min(out.daily_runs_cap, loweredRuns);
      if (candidatePoolSize > 0) {
        const loweredPool = Math.max(
          AUTONOMY_DYNAMIC_IO_CAP_MIN_INPUT_POOL,
          Math.floor(candidatePoolSize * factor)
        );
        if (loweredPool < candidatePoolSize) {
          out.input_candidates_cap = loweredPool;
          out.inputCandidateCap = loweredPool;
        }
      }
    }
  }

  const holdLevel = String(policyHold.level || 'normal');
  const holdApplicable = policyHold.applicable === true;
  if (holdApplicable && holdLevel === 'hard') {
    out.daily_runs_cap = Math.min(out.daily_runs_cap, 1);
    out.high_yield = false;
    markLowYield('downshift_policy_hold_hard');
  } else if (holdApplicable && holdLevel === 'warn') {
    const warnCap = Math.max(1, Math.floor(baseDailyCap * 0.6));
    out.daily_runs_cap = Math.min(out.daily_runs_cap, warnCap);
    out.high_yield = false;
    markLowYield('downshift_policy_hold_warn');
  }

  if (spawnCapacityBoost.enabled === true && spawnCapacityBoost.active === true) {
    out.daily_runs_cap = baseDailyCap;
    out.input_candidates_cap = null;
    out.inputCandidateCap = null;
    out.low_yield = false;
    out.spawn_reset_active = true;
    if (!out.reasons.includes('reset_caps_spawn_capacity')) out.reasons.push('reset_caps_spawn_capacity');
  }

  if (!out.low_yield) {
    const shippedToday = Number(input.shippedToday || 0);
    const noProgressStreak = Number(input.noProgressStreak || 0);
    const gateExhaustionStreak = Number(input.gateExhaustionStreak || 0);
    out.high_yield = shippedToday > 0 && noProgressStreak <= 0 && gateExhaustionStreak <= 0;
  }

  return out;
}

function computeBacklogAutoscalePlan(input: AnyObj = {}) {
  const queuePressure = normalizeQueuePressure(input.queuePressure && typeof input.queuePressure === 'object' ? input.queuePressure : {});
  const minCells = Math.max(0, Math.floor(Number(input.minCells != null ? input.minCells : AUTONOMY_BACKLOG_AUTOSCALE_MIN_CELLS)));
  const maxCells = Math.max(minCells, Math.floor(Number(input.maxCells != null ? input.maxCells : AUTONOMY_BACKLOG_AUTOSCALE_MAX_CELLS)));
  const currentCells = Math.max(minCells, Math.min(maxCells, Math.floor(Number(input.currentCells || 0))));
  const runIntervalMinutes = Math.max(1, Number(input.runIntervalMinutes || AUTONOMY_BACKLOG_AUTOSCALE_RUN_INTERVAL_MINUTES));
  const idleReleaseMinutes = Math.max(runIntervalMinutes, Number(input.idleReleaseMinutes || AUTONOMY_BACKLOG_AUTOSCALE_IDLE_RELEASE_MINUTES));
  const autopauseActive = input.autopauseActive === true;
  const lastRunMinutesAgo = minutesSinceTs(input.lastRunTs);
  const lastHighPressureMinutesAgo = minutesSinceTs(input.lastHighPressureTs);
  const tritProductivity = input.tritProductivity && typeof input.tritProductivity === 'object'
    ? input.tritProductivity
    : null;
  const tritBlocked = !!(tritProductivity && tritProductivity.enabled === true && tritProductivity.active !== true);
  const highPressure = queuePressure.pressure === 'critical';
  const warningPressure = queuePressure.pressure === 'warning';
  const pressureActive = highPressure || warningPressure;
  const cooldownActive = Number.isFinite(Number(lastRunMinutesAgo)) && Number(lastRunMinutesAgo) < runIntervalMinutes;
  const idleReleaseReady = currentCells > minCells
    && !pressureActive
    && Number.isFinite(Number(lastHighPressureMinutesAgo))
    && Number(lastHighPressureMinutesAgo) >= idleReleaseMinutes;

  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'plan',
      {
        queue_pressure: queuePressure,
        min_cells: minCells,
        max_cells: maxCells,
        current_cells: currentCells,
        run_interval_minutes: runIntervalMinutes,
        idle_release_minutes: idleReleaseMinutes,
        autopause_active: autopauseActive,
        last_run_minutes_ago: Number.isFinite(Number(lastRunMinutesAgo)) ? Number(lastRunMinutesAgo) : null,
        last_high_pressure_minutes_ago: Number.isFinite(Number(lastHighPressureMinutesAgo)) ? Number(lastHighPressureMinutesAgo) : null,
        trit_shadow_blocked: tritBlocked
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const raw = rust.payload.payload;
      const warningPressure = raw.warningPressure != null ? !!raw.warningPressure : !!raw.warning_pressure;
      const highPressure = raw.highPressure != null ? !!raw.highPressure : !!raw.high_pressure;
      const pressureActive = raw.pressureActive != null ? !!raw.pressureActive : !!raw.pressure_active;
      return {
        action: String(raw.action || 'hold'),
        reason: String(raw.reason || 'hold'),
        pressure: String(raw.pressure || 'normal'),
        pending: Number(raw.pending || 0),
        pending_ratio: Number(raw.pending_ratio || 0),
        current_cells: Math.max(0, Math.floor(Number(raw.current_cells || 0))),
        target_cells: Math.max(0, Math.floor(Number(raw.target_cells != null ? raw.target_cells : raw.current_cells || 0))),
        warningPressure,
        highPressure,
        pressureActive,
        cooldown_active: raw.cooldown_active === true,
        idle_release_ready: raw.idle_release_ready === true,
        budget_blocked: raw.budget_blocked === true,
        trit_shadow_blocked: raw.trit_shadow_blocked === true
      };
    }
    return {
      action: 'hold',
      reason: 'rust_plan_unavailable',
      pressure: queuePressure.pressure,
      pending: queuePressure.pending,
      pending_ratio: queuePressure.pending_ratio,
      current_cells: currentCells,
      target_cells: currentCells,
      warningPressure,
      highPressure,
      pressureActive,
      cooldown_active: cooldownActive,
      idle_release_ready: idleReleaseReady,
      budget_blocked: autopauseActive,
      trit_shadow_blocked: tritBlocked
    };
  }

  if (tritBlocked) {
    return {
      action: 'hold',
      reason: 'shadow_hold',
      pressure: queuePressure.pressure,
      pending: queuePressure.pending,
      pending_ratio: queuePressure.pending_ratio,
      current_cells: currentCells,
      target_cells: currentCells,
      warningPressure,
      highPressure,
      pressureActive,
      cooldown_active: cooldownActive,
      idle_release_ready: idleReleaseReady,
      budget_blocked: autopauseActive,
      trit_shadow_blocked: true
    };
  }

  if (autopauseActive && pressureActive) {
    return {
      action: 'hold',
      reason: 'budget_autopause_active',
      pressure: queuePressure.pressure,
      pending: queuePressure.pending,
      pending_ratio: queuePressure.pending_ratio,
      current_cells: currentCells,
      target_cells: currentCells,
      warningPressure,
      highPressure,
      pressureActive,
      cooldown_active: cooldownActive,
      idle_release_ready: idleReleaseReady,
      budget_blocked: true,
      trit_shadow_blocked: false
    };
  }

  if (pressureActive && cooldownActive) {
    return {
      action: 'cooldown_hold',
      reason: 'cooldown_hold',
      pressure: queuePressure.pressure,
      pending: queuePressure.pending,
      pending_ratio: queuePressure.pending_ratio,
      current_cells: currentCells,
      target_cells: currentCells,
      warningPressure,
      highPressure,
      pressureActive,
      cooldown_active: true,
      idle_release_ready: idleReleaseReady,
      budget_blocked: autopauseActive,
      trit_shadow_blocked: false
    };
  }

  if (highPressure && currentCells < maxCells) {
    return {
      action: 'scale_up',
      reason: 'backlog_critical',
      pressure: queuePressure.pressure,
      pending: queuePressure.pending,
      pending_ratio: queuePressure.pending_ratio,
      current_cells: currentCells,
      target_cells: maxCells,
      warningPressure,
      highPressure,
      pressureActive,
      cooldown_active: cooldownActive,
      idle_release_ready: idleReleaseReady,
      budget_blocked: autopauseActive,
      trit_shadow_blocked: false
    };
  }

  if (warningPressure && currentCells < maxCells) {
    return {
      action: 'scale_up',
      reason: 'backlog_warning',
      pressure: queuePressure.pressure,
      pending: queuePressure.pending,
      pending_ratio: queuePressure.pending_ratio,
      current_cells: currentCells,
      target_cells: Math.min(maxCells, Math.max(currentCells + 1, minCells)),
      warningPressure,
      highPressure,
      pressureActive,
      cooldown_active: cooldownActive,
      idle_release_ready: idleReleaseReady,
      budget_blocked: autopauseActive,
      trit_shadow_blocked: false
    };
  }

  if (idleReleaseReady) {
    return {
      action: 'scale_down',
      reason: 'idle_release_ready',
      pressure: queuePressure.pressure,
      pending: queuePressure.pending,
      pending_ratio: queuePressure.pending_ratio,
      current_cells: currentCells,
      target_cells: minCells,
      warningPressure,
      highPressure,
      pressureActive,
      cooldown_active: cooldownActive,
      idle_release_ready: true,
      budget_blocked: autopauseActive,
      trit_shadow_blocked: false
    };
  }

  return {
    action: 'hold',
    reason: currentCells > minCells && !pressureActive ? 'idle_hold' : 'no_pressure',
    pressure: queuePressure.pressure,
    pending: queuePressure.pending,
    pending_ratio: queuePressure.pending_ratio,
    current_cells: currentCells,
    target_cells: currentCells,
    warningPressure,
    highPressure,
    pressureActive,
    cooldown_active: cooldownActive,
    idle_release_ready: idleReleaseReady,
    budget_blocked: autopauseActive,
    trit_shadow_blocked: false
  };
}

function runSpawnBroker(action: string, opts: AnyObj = {}) {
  if (!fs.existsSync(SPAWN_BROKER_SCRIPT)) {
    return {
      ok: false,
      skipped: true,
      reason: 'spawn_broker_unavailable',
      action
    };
  }
  const args = [
    SPAWN_BROKER_SCRIPT,
    String(action || 'status'),
    '--json=1',
    `--module=${String(opts.module || AUTONOMY_BACKLOG_AUTOSCALE_MODULE)}`
  ];
  if (opts.cells != null) args.push(`--cells=${Math.max(0, Math.floor(Number(opts.cells || 0)))}`);
  if (opts.leaseSec != null) args.push(`--lease-sec=${Math.max(1, Math.floor(Number(opts.leaseSec || AUTONOMY_BACKLOG_AUTOSCALE_LEASE_SEC)))}`);
  if (opts.requestTokensEst != null) args.push(`--request-tokens-est=${Math.max(0, Math.floor(Number(opts.requestTokensEst || 0)))}`);
  const child = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    cwd: REPO_ROOT
  });
  const stdout = String(child.stdout || '').trim();
  let payload = null;
  if (stdout) {
    const lines = stdout.split('\n').map((line) => String(line || '').trim()).filter(Boolean);
    for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
      if (!lines[idx].startsWith('{')) continue;
      try {
        payload = JSON.parse(lines[idx]);
        break;
      } catch {}
    }
  }
  return {
    ok: child.status === 0,
    code: child.status == null ? 1 : child.status,
    action,
    payload,
    stdout,
    stderr: String(child.stderr || '').trim()
  };
}

function backlogAutoscaleSnapshot(dateStr, opts: AnyObj = {}) {
  const state = loadBacklogAutoscaleState();
  const queuePressure = opts.queuePressure && typeof opts.queuePressure === 'object'
    ? opts.queuePressure
    : queuePressureSnapshot(dateStr);
  const budgetAutopause = opts.budgetAutopause && typeof opts.budgetAutopause === 'object'
    ? opts.budgetAutopause
    : loadSystemBudgetAutopauseState();
  const tritProductivity = opts.tritProductivity && typeof opts.tritProductivity === 'object'
    ? opts.tritProductivity
    : evaluateTritShadowProductivity(loadTritShadowPolicy());
  const plan = computeBacklogAutoscalePlan({
    queuePressure,
    currentCells: Number(state.current_cells || spawnAllocatedCells()),
    minCells: AUTONOMY_BACKLOG_AUTOSCALE_MIN_CELLS,
    maxCells: AUTONOMY_BACKLOG_AUTOSCALE_MAX_CELLS,
    lastRunTs: state.last_run_ts,
    lastHighPressureTs: state.last_high_pressure_ts,
    autopauseActive: budgetAutopause && budgetAutopause.active === true,
    runIntervalMinutes: AUTONOMY_BACKLOG_AUTOSCALE_RUN_INTERVAL_MINUTES,
    idleReleaseMinutes: AUTONOMY_BACKLOG_AUTOSCALE_IDLE_RELEASE_MINUTES,
    tritProductivity
  });
  const queue = normalizeQueuePressure(queuePressure);
  const output = {
    enabled: AUTONOMY_BACKLOG_AUTOSCALE_ENABLED,
    module: AUTONOMY_BACKLOG_AUTOSCALE_MODULE,
    state,
    queue,
    current_cells: Number(plan.current_cells || 0),
    plan,
    trit_productivity: tritProductivity
  };
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'backlog_autoscale_snapshot',
      output,
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  return output;
}

function runBacklogAutoscaler(dateStr, opts: AnyObj = {}) {
  const snapshot = backlogAutoscaleSnapshot(dateStr, opts);
  const state = snapshot.state && typeof snapshot.state === 'object'
    ? snapshot.state
    : defaultBacklogAutoscaleState();
  const plan: AnyObj = snapshot.plan && typeof snapshot.plan === 'object' ? snapshot.plan as AnyObj : { action: 'hold' };
  if (!AUTONOMY_BACKLOG_AUTOSCALE_ENABLED) {
    return {
      ...snapshot,
      executed: false,
      action: 'hold',
      reason: 'feature_disabled'
    };
  }

  const nextState: AnyObj = {
    ...state,
    module: AUTONOMY_BACKLOG_AUTOSCALE_MODULE,
    current_cells: Number(plan.current_cells || 0),
    target_cells: Number(plan.target_cells != null ? plan.target_cells : plan.current_cells || 0),
    last_action: String(plan.action || 'hold'),
    last_run_ts: nowIso()
  };
  if (plan.pressureActive === true) nextState.last_high_pressure_ts = nowIso();
  if (!nextState.last_high_pressure_ts && state.last_high_pressure_ts) nextState.last_high_pressure_ts = state.last_high_pressure_ts;

  let broker = null;
  if (plan.action === 'scale_up' || plan.action === 'scale_down') {
    const desired = Math.max(0, Number(plan.target_cells || 0));
    const delta = Math.max(0, Math.abs(desired - Number(plan.current_cells || 0)));
    const reqTokens = Math.max(0, Math.floor(delta * AUTONOMY_BACKLOG_AUTOSCALE_REQUEST_TOKENS_PER_CELL));
    broker = runSpawnBroker(plan.action === 'scale_up' ? 'spawn_request' : 'spawn_release', {
      module: AUTONOMY_BACKLOG_AUTOSCALE_MODULE,
      cells: delta,
      leaseSec: AUTONOMY_BACKLOG_AUTOSCALE_LEASE_SEC,
      requestTokensEst: reqTokens
    });
  }
  saveBacklogAutoscaleState(nextState);
  return {
    ...snapshot,
    executed: true,
    action: String(plan.action || 'hold'),
    reason: String(plan.reason || 'hold'),
    state: nextState,
    broker
  };
}

function computeBacklogBatchMax(input: AnyObj = {}) {
  const enabled = input.enabled === true;
  const autoscaleSnapshot = input.autoscaleSnapshot && typeof input.autoscaleSnapshot === 'object'
    ? input.autoscaleSnapshot
    : {};
  const plan = autoscaleSnapshot.plan && typeof autoscaleSnapshot.plan === 'object'
    ? autoscaleSnapshot.plan
    : {};
  const maxBatch = Math.max(1, Math.floor(Number(input.maxBatch || AUTONOMY_BACKLOG_AUTOSCALE_BATCH_MAX)));
  const currentCells = Math.max(0, Math.floor(Number(autoscaleSnapshot.current_cells || plan.current_cells || 0)));
  const dailyRemainingRaw = Number(input.dailyRemaining);
  const dailyRemaining = Number.isFinite(dailyRemainingRaw) ? Math.max(0, Math.floor(dailyRemainingRaw)) : null;
  const pressure = String(plan.pressure || 'normal').toLowerCase();
  const budgetBlocked = plan.budget_blocked === true;
  const tritBlocked = plan.trit_shadow_blocked === true;

  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'batch_max',
      {
        enabled,
        max_batch: maxBatch,
        daily_remaining: dailyRemaining,
        pressure,
        current_cells: currentCells,
        budget_blocked: budgetBlocked,
        trit_shadow_blocked: tritBlocked
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
    return {
      max: 1,
      reason: 'rust_batch_max_unavailable',
      pressure,
      current_cells: currentCells,
      budget_blocked: budgetBlocked,
      trit_shadow_blocked: tritBlocked
    };
  }

  if (!enabled) {
    return { max: 1, reason: 'disabled', pressure, current_cells: currentCells, budget_blocked: budgetBlocked, trit_shadow_blocked: tritBlocked };
  }
  if (budgetBlocked) {
    return { max: 1, reason: 'budget_blocked', pressure, current_cells: currentCells, budget_blocked: true, trit_shadow_blocked: tritBlocked };
  }
  if (tritBlocked) {
    return { max: 1, reason: 'shadow_hold', pressure, current_cells: currentCells, budget_blocked: budgetBlocked, trit_shadow_blocked: true };
  }
  let suggested = 1;
  if (pressure === 'critical') {
    suggested = Math.min(maxBatch, Math.max(1, currentCells + 1));
  } else if (pressure === 'warning') {
    suggested = Math.min(maxBatch, 2);
  }
  let reason = suggested > 1 ? 'backlog_autoscale' : 'no_pressure';
  if (dailyRemaining != null && dailyRemaining < suggested) {
    suggested = Math.max(1, dailyRemaining);
    reason = 'daily_cap_limited';
  }
  return {
    max: Math.max(1, Math.floor(suggested)),
    reason,
    pressure,
    current_cells: currentCells,
    budget_blocked: budgetBlocked,
    trit_shadow_blocked: tritBlocked
  };
}

function suggestAutonomyRunBatchMax(dateStr, opts: AnyObj = {}) {
  const runs = runsSinceReset(readRuns(dateStr));
  const attempts = capacityCountedAttemptEvents(runs);
  const strategyBudget = opts.strategyBudget && typeof opts.strategyBudget === 'object'
    ? opts.strategyBudget
    : effectiveStrategyBudget();
  const baseDailyCap = Number.isFinite(Number(strategyBudget.daily_runs_cap))
    ? Number(strategyBudget.daily_runs_cap)
    : AUTONOMY_MAX_RUNS_PER_DAY;
  const dailyRemaining = Math.max(0, Math.floor(baseDailyCap - attempts.length));
  const autoscale = backlogAutoscaleSnapshot(dateStr, opts);
  const batch = computeBacklogBatchMax({
    enabled: AUTONOMY_BACKLOG_AUTOSCALE_BATCH_ON_RUN,
    maxBatch: AUTONOMY_BACKLOG_AUTOSCALE_BATCH_MAX,
    autoscaleSnapshot: autoscale,
    dailyRemaining
  });
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'suggest_run_batch_max',
      {
        enabled: AUTONOMY_BACKLOG_AUTOSCALE_BATCH_ON_RUN,
        batch_max: Number(batch.max || 1),
        batch_reason: batch.reason || 'no_pressure',
        daily_remaining: dailyRemaining,
        autoscale_hint: autoscale
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  return {
    enabled: AUTONOMY_BACKLOG_AUTOSCALE_BATCH_ON_RUN,
    max: Number(batch.max || 1),
    reason: batch.reason || 'no_pressure',
    daily_remaining: dailyRemaining,
    autoscale_hint: autoscale
  };
}

const TS_CLONE_DYNAMIC_IO_PARITY = [
  'queuePressure',
  'spawnCapacityBoost',
  'candidatePoolSize',
  'queueHard',
  'queueWarn',
  'lowYieldActive',
  'input_candidates_cap',
  'inputCandidateCap',
  'evaluationPool',
  'downshift_queue_backlog_critical',
  'downshift_queue_backlog_warning',
  'input_cap_critical_backlog',
  'input_cap_backlog',
  'reset_caps_spawn_capacity',
  'SPAWN_BROKER_SCRIPT',
  'BACKLOG_AUTOSCALE_STATE_PATH',
  'AUTONOMY_BACKLOG_AUTOSCALE_ENABLED',
  'AUTONOMY_BACKLOG_AUTOSCALE_MODULE',
  'AUTONOMY_BACKLOG_AUTOSCALE_MIN_CELLS',
  'AUTONOMY_BACKLOG_AUTOSCALE_MAX_CELLS',
  'AUTONOMY_BACKLOG_AUTOSCALE_SCALE_UP_PENDING_RATIO',
  'AUTONOMY_BACKLOG_AUTOSCALE_SCALE_UP_PENDING_COUNT',
  'AUTONOMY_BACKLOG_AUTOSCALE_SCALE_DOWN_PENDING_RATIO',
  'AUTONOMY_BACKLOG_AUTOSCALE_SCALE_DOWN_PENDING_COUNT',
  'AUTONOMY_BACKLOG_AUTOSCALE_RUN_INTERVAL_MINUTES',
  'AUTONOMY_BACKLOG_AUTOSCALE_IDLE_RELEASE_MINUTES',
  'AUTONOMY_BACKLOG_AUTOSCALE_LEASE_SEC',
  'AUTONOMY_BACKLOG_AUTOSCALE_REQUEST_TOKENS_PER_CELL',
  'AUTONOMY_BACKLOG_AUTOSCALE_BATCH_ON_RUN',
  'AUTONOMY_BACKLOG_AUTOSCALE_BATCH_MAX',
  'computeBacklogBatchMax',
  'suggestAutonomyRunBatchMax',
  'autoscaleSnapshot',
  'dailyRemaining',
  'maxBatch',
  'activeCells',
  'pressureActive',
  'budgetBlocked',
  'remainingDailyRuns',
  'attemptsTodayForCap',
  'baseDailyCap',
  'proposalDate',
  'forcedMax',
  'hasArgMax',
  'maxSource',
  'autoscale_hint',
  'isBatchChild',
  'noBatchArg',
  'noBatch',
  'runLockExists',
  'batchHint',
  'AUTONOMY_BATCH_CHILD',
  'AUTONOMY_BATCH_MAX',
  'no_batch',
  'max_source',
  'daily_cap_limited',
  'backlog_autoscale',
  'budget_blocked',
  'no_pressure',
  'defaultBacklogAutoscaleState',
  'loadBacklogAutoscaleState',
  'saveBacklogAutoscaleState',
  'spawnAllocatedCells',
  'runSpawnBroker',
  'computeBacklogAutoscalePlan',
  'runBacklogAutoscaler',
  'backlogAutoscaleSnapshot',
  'backlog_autoscale',
  'autonomy_backlog_autoscale',
  'scale_up',
  'scale_down',
  'shadow_hold',
  'cooldown_hold',
  'mode_hold',
  'idle_release_ready',
  'budget_autopause_active',
  'dateStr',
  'queuePressureState',
  'budgetAutopause',
  'autopauseActive',
  'moduleName',
  'spawnAllocatedCells',
  'spawnCapacityBoostSnapshot',
  'queuePressureSnapshot',
  'runSpawnBroker',
  'spawn_request',
  'spawn_release',
  'requested_cells',
  'granted_cells',
  'request_tokens_est',
  'lease_sec',
  'current_cells',
  'target_cells',
  'observed_cells',
  'pressure',
  'pending',
  'pending_ratio',
  'total',
  'cooldown_active',
  'high_pressure_active',
  'warningPressure',
  'highPressure',
  'idleReleaseReady',
  'last_run_ts',
  'last_action_ts',
  'last_high_pressure_ts',
  'last_target_cells',
  'last_observed_cells',
  'last_plan',
  'last_result',
  'updated_at',
  'backlog_critical',
  'backlog_warning',
  'backlog_normal',
  'idle_hold',
  'shadow_hold',
  'spawn_error',
  'action',
  'reason',
  'plan',
  'queue',
  'min_cells',
  'max_cells',
  'scaleUpPendingCount',
  'scaleUpPendingRatio',
  'scaleDownPendingCount',
  'scaleDownPendingRatio',
  'runIntervalMinutes',
  'idleReleaseMinutes',
  'runIntervalMs',
  'idleReleaseMs',
  'backlogAutoscale',
  'backlog_autoscale',
  'autonomy_backlog_autoscale',
  'AUTONOMY_BACKLOG_AUTOSCALE_SCALE_UP_PENDING_RATIO',
  'AUTONOMY_BACKLOG_AUTOSCALE_SCALE_UP_PENDING_COUNT',
  'AUTONOMY_BACKLOG_AUTOSCALE_SCALE_DOWN_PENDING_RATIO',
  'AUTONOMY_BACKLOG_AUTOSCALE_SCALE_DOWN_PENDING_COUNT',
  'AUTONOMY_BACKLOG_AUTOSCALE_RUN_INTERVAL_MINUTES',
  'AUTONOMY_BACKLOG_AUTOSCALE_IDLE_RELEASE_MINUTES',
  'AUTONOMY_BACKLOG_AUTOSCALE_LEASE_SEC',
  'AUTONOMY_BACKLOG_AUTOSCALE_REQUEST_TOKENS_PER_CELL'
];

function listProposalFiles() {
  if (!fs.existsSync(PROPOSALS_DIR)) return [];
  const entries = fs.readdirSync(PROPOSALS_DIR);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'list_proposal_files',
      { entries },
      { allow_cli_fallback: true }
    );
    if (
      rust
      && rust.ok === true
      && rust.payload
      && rust.payload.ok === true
      && rust.payload.payload
      && Array.isArray(rust.payload.payload.files)
    ) {
      return rust.payload.payload.files.map((v) => String(v || ''));
    }
  }
  return entries
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
}

function normalizeStoredProposalStatus(raw, fallback = 'pending') {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const fallbackRaw = String(fallback || 'pending');
    const rawStatus = String(raw || '');
    const cacheKey = `${fallbackRaw}\u0000${rawStatus}`;
    if (NORMALIZE_PROPOSAL_STATUS_CACHE.has(cacheKey)) {
      return NORMALIZE_PROPOSAL_STATUS_CACHE.get(cacheKey);
    }
    const rust = runBacklogAutoscalePrimitive(
      'normalize_proposal_status',
      {
        raw_status: rawStatus,
        fallback: fallbackRaw
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const rustStatus = String(rust.payload.payload.normalized_status || '').trim().toLowerCase();
      if (rustStatus) {
        if (NORMALIZE_PROPOSAL_STATUS_CACHE.size >= NORMALIZE_PROPOSAL_STATUS_CACHE_MAX) {
          const oldest = NORMALIZE_PROPOSAL_STATUS_CACHE.keys().next();
          if (!oldest.done) NORMALIZE_PROPOSAL_STATUS_CACHE.delete(oldest.value);
        }
        NORMALIZE_PROPOSAL_STATUS_CACHE.set(cacheKey, rustStatus);
        return rustStatus;
      }
    }
  }
  const base = String(fallback || 'pending').trim().toLowerCase() || 'pending';
  const s = String(raw || '').trim().toLowerCase();
  if (!s || s === 'unknown' || s === 'new' || s === 'queued') return base;
  if (s === 'open' || s === 'admitted') return base;
  if (s === 'closed_won' || s === 'won' || s === 'paid' || s === 'verified') return 'closed';
  return s;
}

function normalizeStoredProposalRow(proposal, fallback = 'pending') {
  if (!proposal || typeof proposal !== 'object') return proposal;
  const next = { ...proposal };
  const meta = next.meta && typeof next.meta === 'object' ? next.meta : {};
  const typeDecision = classifyProposalType(next, {
    source_eye: normalizeSpaces(meta.source_eye)
  });
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'normalize_stored_proposal_row',
      {
        proposal: next,
        fallback: String(fallback || 'pending'),
        proposal_type: String(typeDecision && typeDecision.type || 'local_state_fallback'),
        proposal_type_source: String(typeDecision && typeDecision.source || ''),
        proposal_type_inferred: !!(typeDecision && typeDecision.inferred === true)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload.proposal;
      if (payload && typeof payload === 'object') return payload;
    }
  }
  next.type = String(typeDecision && typeDecision.type || 'local_state_fallback').trim().toLowerCase() || 'local_state_fallback';
  next.status = normalizeStoredProposalStatus(next.status, fallback);
  next.meta = {
    ...meta,
    normalized_proposal_type: next.type,
    proposal_type_source: String(typeDecision && typeDecision.source || ''),
    proposal_type_inferred: !!(typeDecision && typeDecision.inferred === true)
  };
  return next;
}

function loadProposalsForDate(dateStr) {
  const fp = path.join(PROPOSALS_DIR, `${dateStr}.json`);
  if (!fs.existsSync(fp)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (Array.isArray(parsed)) return parsed.map((p) => normalizeStoredProposalRow(p, 'pending'));
    if (parsed && Array.isArray(parsed.proposals)) return parsed.proposals.map((p) => normalizeStoredProposalRow(p, 'pending'));
    return [];
  } catch {
    return [];
  }
}

function latestProposalDate(maxDate) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'latest_proposal_date',
      {
        files: listProposalFiles(),
        max_date: maxDate == null ? null : String(maxDate)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.date == null ? null : String(rust.payload.payload.date);
    }
  }
  const files = listProposalFiles()
    .map(f => f.replace('.json', ''))
    .filter(d => d <= maxDate)
    .sort();
  return files.length ? files[files.length - 1] : null;
}

function allDecisionEvents() {
  if (!fs.existsSync(QUEUE_DECISIONS_DIR)) return [];
  const files = fs.readdirSync(QUEUE_DECISIONS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();
  const buckets = [];
  for (const f of files) {
    buckets.push(readJsonl(path.join(QUEUE_DECISIONS_DIR, f)));
  }
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'all_decision_events',
      { day_events: buckets },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Array.isArray(rust.payload.payload.events) ? rust.payload.payload.events : [];
    }
  }
  const out = [];
  for (const bucket of buckets) {
    out.push(...bucket);
  }
  return out;
}

function buildOverlay(events) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'build_overlay',
      {
        events: (Array.isArray(events) ? events : []).map((evt) => ({
          proposal_id: evt && evt.proposal_id == null ? null : String(evt && evt.proposal_id || ''),
          type: evt && evt.type == null ? null : String(evt && evt.type || ''),
          decision: evt && evt.decision == null ? null : String(evt && evt.decision || ''),
          ts: evt && evt.ts == null ? null : String(evt && evt.ts || ''),
          reason: evt && evt.reason == null ? null : String(evt && evt.reason || ''),
          outcome: evt && evt.outcome == null ? null : String(evt && evt.outcome || ''),
          evidence_ref: evt && evt.evidence_ref == null ? null : String(evt && evt.evidence_ref || '')
        }))
      },
      { allow_cli_fallback: true }
    );
    if (
      rust
      && rust.ok === true
      && rust.payload
      && rust.payload.ok === true
      && rust.payload.payload
      && Array.isArray(rust.payload.payload.entries)
    ) {
      const map = new Map();
      for (const row of rust.payload.payload.entries) {
        const proposalId = normalizeSpaces(row && row.proposal_id);
        if (!proposalId) continue;
        map.set(proposalId, {
          decision: row && row.decision ? String(row.decision) : null,
          decision_ts: row && row.decision_ts ? String(row.decision_ts) : null,
          decision_reason: row && row.decision_reason ? String(row.decision_reason) : null,
          last_outcome: row && row.last_outcome ? String(row.last_outcome) : null,
          last_outcome_ts: row && row.last_outcome_ts ? String(row.last_outcome_ts) : null,
          last_evidence_ref: row && row.last_evidence_ref ? String(row.last_evidence_ref) : null,
          outcomes: {
            shipped: Math.max(0, Number(row && row.outcomes && row.outcomes.shipped || 0)),
            reverted: Math.max(0, Number(row && row.outcomes && row.outcomes.reverted || 0)),
            no_change: Math.max(0, Number(row && row.outcomes && row.outcomes.no_change || 0))
          }
        });
      }
      return map;
    }
  }
  const map = new Map();
  for (const e of events) {
    if (!e || !e.proposal_id) continue;
    const cur = map.get(e.proposal_id) || {
      decision: null,
      decision_ts: null,
      decision_reason: null,
      last_outcome: null,
      last_outcome_ts: null,
      last_evidence_ref: null,
      outcomes: { shipped: 0, reverted: 0, no_change: 0 }
    };
    if (e.type === 'decision' && e.decision) {
      if (!cur.decision_ts || String(e.ts) >= String(cur.decision_ts)) {
        cur.decision = e.decision;
        cur.decision_ts = e.ts;
        cur.decision_reason = e.reason || null;
      }
    }
    if (e.type === 'outcome' && e.outcome) {
      const o = String(e.outcome);
      if (cur.outcomes[o] != null) cur.outcomes[o] += 1;
      if (!cur.last_outcome_ts || String(e.ts) >= String(cur.last_outcome_ts)) {
        cur.last_outcome = o;
        cur.last_outcome_ts = e.ts;
        cur.last_evidence_ref = e.evidence_ref || null;
      }
    }
    map.set(e.proposal_id, cur);
  }
  return map;
}

function isStubProposal(p) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'is_stub_proposal',
      { title: p && p.title == null ? null : String(p && p.title || '') },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.is_stub === true;
    }
  }
  const title = String(p && p.title || '');
  return title.toUpperCase().includes('[STUB]');
}

function impactWeight(p) {
  const impact = String(p && p.expected_impact || '').toLowerCase();
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    if (IMPACT_WEIGHT_CACHE.has(impact)) {
      return IMPACT_WEIGHT_CACHE.get(impact);
    }
    const rust = runBacklogAutoscalePrimitive(
      'impact_weight',
      { expected_impact: impact },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = Math.max(1, Math.round(Number(rust.payload.payload.weight || 1)));
      if (IMPACT_WEIGHT_CACHE.size >= IMPACT_WEIGHT_CACHE_MAX) {
        const oldest = IMPACT_WEIGHT_CACHE.keys().next();
        if (!oldest.done) IMPACT_WEIGHT_CACHE.delete(oldest.value);
      }
      IMPACT_WEIGHT_CACHE.set(impact, val);
      return val;
    }
  }
  if (impact === 'high') return 3;
  if (impact === 'medium') return 2;
  return 1;
}

function riskPenalty(p) {
  const r = String(p && p.risk || '').toLowerCase();
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    if (RISK_PENALTY_CACHE.has(r)) {
      return RISK_PENALTY_CACHE.get(r);
    }
    const rust = runBacklogAutoscalePrimitive(
      'risk_penalty',
      { risk: r },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = Math.max(0, Math.round(Number(rust.payload.payload.penalty || 0)));
      if (RISK_PENALTY_CACHE.size >= RISK_PENALTY_CACHE_MAX) {
        const oldest = RISK_PENALTY_CACHE.keys().next();
        if (!oldest.done) RISK_PENALTY_CACHE.delete(oldest.value);
      }
      RISK_PENALTY_CACHE.set(r, val);
      return val;
    }
  }
  if (r === 'high') return 2;
  if (r === 'medium') return 1;
  return 0;
}

function estimateTokens(p) {
  const impact = String(p && p.expected_impact || '').toLowerCase();
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    if (ESTIMATE_TOKENS_CACHE.has(impact)) {
      return ESTIMATE_TOKENS_CACHE.get(impact);
    }
    const rust = runBacklogAutoscalePrimitive(
      'estimate_tokens',
      { expected_impact: impact },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = Math.max(80, Math.round(Number(rust.payload.payload.est_tokens || 300)));
      if (ESTIMATE_TOKENS_CACHE.size >= ESTIMATE_TOKENS_CACHE_MAX) {
        const oldest = ESTIMATE_TOKENS_CACHE.keys().next();
        if (!oldest.done) ESTIMATE_TOKENS_CACHE.delete(oldest.value);
      }
      ESTIMATE_TOKENS_CACHE.set(impact, val);
      return val;
    }
  }
  if (impact === 'high') return 1400;
  if (impact === 'medium') return 800;
  return 300;
}

function normalizeSpaces(s) {
  const raw = String(s == null ? '' : s);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    if (NORMALIZE_SPACES_CACHE.has(raw)) return NORMALIZE_SPACES_CACHE.get(raw);
    const rust = runBacklogAutoscalePrimitive(
      'normalize_spaces',
      { text: raw || null },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const normalized = String(rust.payload.payload.normalized || '');
      if (NORMALIZE_SPACES_CACHE.size >= NORMALIZE_SPACES_CACHE_MAX) {
        const oldest = NORMALIZE_SPACES_CACHE.keys().next();
        if (!oldest.done) NORMALIZE_SPACES_CACHE.delete(oldest.value);
      }
      NORMALIZE_SPACES_CACHE.set(raw, normalized);
      return normalized;
    }
  }
  return raw.replace(/\s+/g, ' ').trim();
}

function parseLowerList(value) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const cache = globalThis.__PROTHEUS_PARSE_LOWER_LIST_CACHE instanceof Map
      ? globalThis.__PROTHEUS_PARSE_LOWER_LIST_CACHE
      : (globalThis.__PROTHEUS_PARSE_LOWER_LIST_CACHE = new Map());
    const cacheKey = Array.isArray(value)
      ? `arr:${value.map((v) => String(v || '')).join('\u0001')}`
      : `csv:${String(value || '')}`;
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }
    const rust = runBacklogAutoscalePrimitive(
      'parse_lower_list',
      {
        list: Array.isArray(value) ? value.map((v) => String(v || '')) : [],
        csv: Array.isArray(value) ? null : String(value || '')
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const items = Array.isArray(rust.payload.payload.items)
        ? rust.payload.payload.items.map((v) => String(v || '')).filter(Boolean)
        : [];
      if (cache.size >= 2048) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(cacheKey, items);
      return items;
    }
  }
  if (Array.isArray(value)) {
    return value
      .map(v => String(v || '').trim().toLowerCase())
      .filter(Boolean);
  }
  return String(value || '')
    .split(',')
    .map(v => String(v || '').trim().toLowerCase())
    .filter(Boolean);
}

function canaryFailedChecksAllowed(failedChecks, allowedSet) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const allowed = allowedSet instanceof Set ? allowedSet : new Set();
    const failed = Array.isArray(failedChecks)
      ? failedChecks.map((v) => String(v || '').trim()).filter(Boolean)
      : [];
    const cache = globalThis.__PROTHEUS_CANARY_FAILED_CHECKS_ALLOWED_CACHE instanceof Map
      ? globalThis.__PROTHEUS_CANARY_FAILED_CHECKS_ALLOWED_CACHE
      : (globalThis.__PROTHEUS_CANARY_FAILED_CHECKS_ALLOWED_CACHE = new Map());
    const cacheKey = `${failed.join('\u0001')}::${Array.from(allowed).join('\u0001')}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const rust = runBacklogAutoscalePrimitive(
      'canary_failed_checks_allowed',
      {
        failed_checks: failed,
        allowed_checks: Array.from(allowed).map((v) => String(v || '').trim()).filter(Boolean)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const decision = rust.payload.payload.allowed === true;
      if (cache.size >= 1024) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(cacheKey, decision);
      return decision;
    }
  }
  const allowed = allowedSet instanceof Set ? allowedSet : new Set();
  const failed = Array.isArray(failedChecks)
    ? failedChecks.map((v) => String(v || '').trim()).filter(Boolean)
    : [];
  if (!failed.length || !allowed.size) return false;
  for (const check of failed) {
    if (!allowed.has(check)) return false;
  }
  return true;
}

function proposalTextBlob(p) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const proposal = p && typeof p === 'object' ? p : {};
    const evidence = Array.isArray(proposal.evidence)
      ? proposal.evidence
        .filter((ev) => ev && typeof ev === 'object')
        .map((ev) => ({
          evidence_ref: String(ev.evidence_ref || '').trim() || null,
          path: String(ev.path || '').trim() || null,
          title: String(ev.title || '').trim() || null
        }))
      : [];
    const cache = globalThis.__PROTHEUS_PROPOSAL_TEXT_BLOB_CACHE instanceof Map
      ? globalThis.__PROTHEUS_PROPOSAL_TEXT_BLOB_CACHE
      : (globalThis.__PROTHEUS_PROPOSAL_TEXT_BLOB_CACHE = new Map());
    const cacheKey = JSON.stringify({
      title: String(proposal.title || ''),
      summary: String(proposal.summary || ''),
      suggested_next_command: String(proposal.suggested_next_command || ''),
      suggested_command: String(proposal.suggested_command || ''),
      notes: String(proposal.notes || ''),
      evidence
    });
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const rust = runBacklogAutoscalePrimitive(
      'proposal_text_blob',
      {
        title: proposal.title || null,
        summary: proposal.summary || null,
        suggested_next_command: proposal.suggested_next_command || null,
        suggested_command: proposal.suggested_command || null,
        notes: proposal.notes || null,
        evidence
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const blob = String(rust.payload.payload.blob || '');
      if (cache.size >= 2048) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(cacheKey, blob);
      return blob;
    }
  }
  const parts = [
    p && p.title,
    p && p.summary,
    p && p.suggested_next_command,
    p && p.suggested_command,
    p && p.notes
  ];
  if (p && Array.isArray(p.evidence)) {
    for (const ev of p.evidence) {
      if (!ev || typeof ev !== 'object') continue;
      parts.push(ev.evidence_ref, ev.path, ev.title);
    }
  }
  return normalizeSpaces(parts.filter(Boolean).join(' | ')).toLowerCase();
}

function optimizationMinDeltaPercent() {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'optimization_min_delta_percent',
      {
        high_accuracy_mode: AUTONOMY_OPTIMIZATION_HIGH_ACCURACY_MODE,
        high_accuracy_value: AUTONOMY_OPTIMIZATION_MIN_DELTA_PERCENT_HIGH_ACCURACY,
        base_value: AUTONOMY_OPTIMIZATION_MIN_DELTA_PERCENT
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const minDelta = Number(rust.payload.payload.min_delta_percent);
      if (Number.isFinite(minDelta)) return minDelta;
    }
  }
  if (AUTONOMY_OPTIMIZATION_HIGH_ACCURACY_MODE) return AUTONOMY_OPTIMIZATION_MIN_DELTA_PERCENT_HIGH_ACCURACY;
  return AUTONOMY_OPTIMIZATION_MIN_DELTA_PERCENT;
}

function percentMentionsFromText(text) {
  const blob = String(text || '');
  if (!blob) return [];
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const cache = globalThis.__PROTHEUS_PERCENT_MENTIONS_CACHE instanceof Map
      ? globalThis.__PROTHEUS_PERCENT_MENTIONS_CACHE
      : (globalThis.__PROTHEUS_PERCENT_MENTIONS_CACHE = new Map());
    if (cache.has(blob)) return cache.get(blob);
    const rust = runBacklogAutoscalePrimitive(
      'percent_mentions_from_text',
      { text: blob },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const values = Array.isArray(rust.payload.payload.values)
        ? rust.payload.payload.values
          .map((v) => Number(v))
          .filter((v) => Number.isFinite(v) && v > 0)
          .map((v) => clampNumber(v, 0, 100))
        : [];
      if (cache.size >= 2048) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(blob, values);
      return values;
    }
  }
  const out = [];
  const re = new RegExp(PERCENT_VALUE_RE.source, 'g');
  let m;
  while ((m = re.exec(blob)) !== null) {
    const raw = Number(m[1]);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    out.push(clampNumber(raw, 0, 100));
  }
  return out;
}

function inferOptimizationDeltaForProposal(p) {
  const proposal = p || {};
  const meta = proposal && proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : {};
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const bits = [
      proposal.title,
      proposal.summary,
      proposal.notes,
      proposal.suggested_next_command,
      proposal.suggested_command,
      proposal && proposal.action_spec && typeof proposal.action_spec === 'object'
        ? JSON.stringify(proposal.action_spec)
        : '',
      meta.normalized_expected_outcome,
      meta.normalized_validation_metric
    ];
    if (Array.isArray(proposal.validation)) bits.push(proposal.validation.join(' '));
    if (Array.isArray(proposal.success_criteria)) bits.push(JSON.stringify(proposal.success_criteria));
    if (Array.isArray(meta.success_criteria)) bits.push(JSON.stringify(meta.success_criteria));
    if (Array.isArray(meta.success_criteria_rows)) bits.push(JSON.stringify(meta.success_criteria_rows));
    const rust = runBacklogAutoscalePrimitive(
      'infer_optimization_delta',
      {
        optimization_delta_percent: Number(meta.optimization_delta_percent),
        expected_optimization_percent: Number(meta.expected_optimization_percent),
        expected_delta_percent: Number(meta.expected_delta_percent),
        estimated_improvement_percent: Number(meta.estimated_improvement_percent),
        target_improvement_percent: Number(meta.target_improvement_percent),
        performance_gain_percent: Number(meta.performance_gain_percent),
        text_blob: bits.filter(Boolean).join(' ')
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  const directKeys = [
    'optimization_delta_percent',
    'expected_optimization_percent',
    'expected_delta_percent',
    'estimated_improvement_percent',
    'target_improvement_percent',
    'performance_gain_percent'
  ];
  for (const key of directKeys) {
    const raw = Number(meta[key]);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    return { delta_percent: clampNumber(raw, 0, 100), delta_source: `meta:${key}` };
  }
  const bits = [
    proposal.title,
    proposal.summary,
    proposal.notes,
    proposal.suggested_next_command,
    proposal.suggested_command,
    proposal && proposal.action_spec && typeof proposal.action_spec === 'object'
      ? JSON.stringify(proposal.action_spec)
      : '',
    meta.normalized_expected_outcome,
    meta.normalized_validation_metric
  ];
  if (Array.isArray(proposal.validation)) bits.push(proposal.validation.join(' '));
  if (Array.isArray(proposal.success_criteria)) bits.push(JSON.stringify(proposal.success_criteria));
  if (Array.isArray(meta.success_criteria)) bits.push(JSON.stringify(meta.success_criteria));
  if (Array.isArray(meta.success_criteria_rows)) bits.push(JSON.stringify(meta.success_criteria_rows));
  const pct = percentMentionsFromText(bits.filter(Boolean).join(' '));
  if (pct.length > 0) {
    return { delta_percent: Number(Math.max(...pct).toFixed(3)), delta_source: 'text:%' };
  }
  return { delta_percent: null, delta_source: null };
}

function isOptimizationIntentProposal(p) {
  const proposal = p || {};
  const type = normalizeSpaces(proposal.type).toLowerCase();
  const meta = proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : {};
  const actuationMeta = meta.actuation && typeof meta.actuation === 'object' ? meta.actuation : null;
  const blob = proposalTextBlob(proposal);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'optimization_intent_proposal',
      {
        proposal_type: type || null,
        blob,
        has_actuation_meta: !!actuationMeta
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.intent === true;
    }
  }
  const canaryActuation =
    (type.startsWith('actuation_') || type === 'actuation' || !!actuationMeta)
    && /\bcanary\b|\bsmoke\s*test\b/i.test(blob);
  if (canaryActuation) return false;
  const hasIntent = OPTIMIZATION_INTENT_RE.test(type) || OPTIMIZATION_INTENT_RE.test(blob);
  if (!hasIntent) return false;
  const hasExemptSignals = OPTIMIZATION_EXEMPT_RE.test(type) || OPTIMIZATION_EXEMPT_RE.test(blob);
  if (hasExemptSignals) return false;
  if (OPPORTUNITY_MARKER_RE.test(blob)) return false;
  return true;
}

function extractObjectiveIdToken(value) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const raw = String(value == null ? '' : value);
    const cache = globalThis.__PROTHEUS_EXTRACT_OBJECTIVE_ID_TOKEN_CACHE instanceof Map
      ? globalThis.__PROTHEUS_EXTRACT_OBJECTIVE_ID_TOKEN_CACHE
      : (globalThis.__PROTHEUS_EXTRACT_OBJECTIVE_ID_TOKEN_CACHE = new Map());
    if (cache.has(raw)) return cache.get(raw);
    const rust = runBacklogAutoscalePrimitive(
      'extract_objective_id_token',
      { value: raw || null },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const objectiveId = rust.payload.payload.objective_id == null
        ? null
        : String(rust.payload.payload.objective_id || '');
      if (cache.size >= 2048) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(raw, objectiveId);
      return objectiveId;
    }
  }
  const text = normalizeSpaces(value);
  if (!text) return null;
  const direct = text.match(/^T[0-9]+_[A-Za-z0-9_]+$/);
  if (direct) return direct[0];
  const token = text.match(/\b(T[0-9]+_[A-Za-z0-9_]+)\b/);
  return token ? token[1] : null;
}

function hasLinkedObjectiveEntry(entry) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const e = entry && typeof entry === 'object' ? entry : {};
    const rust = runBacklogAutoscalePrimitive(
      'has_linked_objective_entry',
      {
        objective_id: e.objective_id == null ? null : String(e.objective_id),
        directive_objective_id: e.directive_objective_id == null ? null : String(e.directive_objective_id),
        directive: e.directive == null ? null : String(e.directive)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.linked === true;
    }
  }
  const e = entry && typeof entry === 'object' ? entry : {};
  return !!(
    extractObjectiveIdToken(e.objective_id)
    || extractObjectiveIdToken(e.directive_objective_id)
    || extractObjectiveIdToken(e.directive)
  );
}

function isVerifiedEntryOutcome(entry) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const e = entry && typeof entry === 'object' ? entry : {};
    const rust = runBacklogAutoscalePrimitive(
      'verified_entry_outcome',
      {
        outcome_verified: e.outcome_verified === true,
        outcome: e.outcome == null ? null : String(e.outcome)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.verified === true;
    }
  }
  const e = entry && typeof entry === 'object' ? entry : {};
  if (e.outcome_verified === true) return true;
  const outcome = String(e.outcome || '').trim().toLowerCase();
  return ['verified', 'verified_success', 'verified_pass', 'shipped', 'closed_won', 'won', 'paid', 'revenue_verified', 'pass'].includes(outcome);
}

function isVerifiedRevenueAction(action) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const row = action && typeof action === 'object' ? action : {};
    const rust = runBacklogAutoscalePrimitive(
      'verified_revenue_action',
      {
        verified: row.verified === true,
        outcome_verified: row.outcome_verified === true,
        status: row.status == null ? null : String(row.status)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.verified === true;
    }
  }
  const row = action && typeof action === 'object' ? action : {};
  if (row.verified === true || row.outcome_verified === true) return true;
  const status = String(row.status || '').trim().toLowerCase();
  return ['verified', 'won', 'paid', 'closed_won', 'received'].includes(status);
}

function assessUnlinkedOptimizationAdmission(proposal, objectiveBinding, risk) {
  const type = normalizeSpaces(proposal && proposal.type).toLowerCase();
  const optimizationIntent = isOptimizationIntentProposal(proposal);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const linked = !!(
      objectiveBinding
      && objectiveBinding.pass === true
      && objectiveBinding.objective_id
      && objectiveBinding.valid !== false
    );
    const normalizedRiskVal = normalizedRisk(risk || (proposal && proposal.risk));
    const rust = runBacklogAutoscalePrimitive(
      'unlinked_optimization_admission',
      {
        optimization_intent: optimizationIntent === true,
        proposal_type: type || null,
        exempt_types: Array.from(AUTONOMY_UNLINKED_OPTIMIZATION_EXEMPT_TYPES || []),
        linked,
        normalized_risk: normalizedRiskVal,
        hard_block_high_risk: AUTONOMY_UNLINKED_OPTIMIZATION_HARD_BLOCK_HIGH_RISK === true,
        penalty: Number(AUTONOMY_UNLINKED_OPTIMIZATION_PENALTY || 0)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  if (!optimizationIntent) {
    return {
      applies: false,
      linked: true,
      penalty: 0,
      block: false,
      reason: null
    };
  }
  if (AUTONOMY_UNLINKED_OPTIMIZATION_EXEMPT_TYPES.has(type)) {
    return {
      applies: true,
      linked: true,
      penalty: 0,
      block: false,
      reason: 'optimization_exempt_type'
    };
  }
  const linked = !!(objectiveBinding && objectiveBinding.pass === true && objectiveBinding.objective_id && objectiveBinding.valid !== false);
  if (linked) {
    return {
      applies: true,
      linked: true,
      penalty: 0,
      block: false,
      reason: null
    };
  }
  const normalizedRiskVal = normalizedRisk(risk || (proposal && proposal.risk));
  const highRiskBlock = AUTONOMY_UNLINKED_OPTIMIZATION_HARD_BLOCK_HIGH_RISK && normalizedRiskVal === 'high';
  return {
    applies: true,
    linked: false,
    penalty: AUTONOMY_UNLINKED_OPTIMIZATION_PENALTY,
    block: highRiskBlock,
    reason: highRiskBlock ? 'optimization_unlinked_objective_high_risk_block' : 'optimization_unlinked_objective_penalty'
  };
}

function assessOptimizationGoodEnough(p, risk) {
  const applies = isOptimizationIntentProposal(p);
  const minDelta = optimizationMinDeltaPercent();
  const requireDelta = AUTONOMY_OPTIMIZATION_REQUIRE_DELTA;
  const normalizedRiskVal = normalizedRisk(risk || (p && p.risk));
  const inferred = inferOptimizationDeltaForProposal(p);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'optimization_good_enough',
      {
        applies,
        min_delta_percent: Number(minDelta || 0),
        require_delta: requireDelta === true,
        high_accuracy_mode: AUTONOMY_OPTIMIZATION_HIGH_ACCURACY_MODE === true,
        normalized_risk: normalizedRiskVal,
        delta_percent: inferred.delta_percent == null ? null : Number(inferred.delta_percent),
        delta_source: inferred.delta_source || null
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  if (!applies) {
    return {
      applies: false,
      pass: true,
      reason: null,
      delta_percent: null,
      delta_source: null,
      min_delta_percent: minDelta,
      require_delta: requireDelta,
      mode: AUTONOMY_OPTIMIZATION_HIGH_ACCURACY_MODE ? 'high_accuracy' : 'default',
      risk: normalizedRiskVal
    };
  }
  if (inferred.delta_percent == null && requireDelta) {
    return {
      applies: true,
      pass: false,
      reason: 'optimization_delta_missing',
      delta_percent: null,
      delta_source: null,
      min_delta_percent: minDelta,
      require_delta: true,
      mode: AUTONOMY_OPTIMIZATION_HIGH_ACCURACY_MODE ? 'high_accuracy' : 'default',
      risk: normalizedRiskVal
    };
  }
  if (Number.isFinite(Number(inferred.delta_percent)) && Number(inferred.delta_percent) < minDelta) {
    return {
      applies: true,
      pass: false,
      reason: 'optimization_good_enough',
      delta_percent: Number(inferred.delta_percent),
      delta_source: inferred.delta_source || null,
      min_delta_percent: minDelta,
      require_delta: requireDelta,
      mode: AUTONOMY_OPTIMIZATION_HIGH_ACCURACY_MODE ? 'high_accuracy' : 'default',
      risk: normalizedRiskVal
    };
  }
  return {
    applies: true,
    pass: true,
    reason: null,
    delta_percent: Number.isFinite(Number(inferred.delta_percent)) ? Number(inferred.delta_percent) : null,
    delta_source: inferred.delta_source || null,
    min_delta_percent: minDelta,
    require_delta: requireDelta,
    mode: AUTONOMY_OPTIMIZATION_HIGH_ACCURACY_MODE ? 'high_accuracy' : 'default',
    risk: normalizedRiskVal
  };
}

function escapeRegExp(s) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'escape_reg_exp',
      { value: s == null ? null : String(s) },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return String(rust.payload.payload.escaped || '');
    }
  }
  return String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toolTokenMentioned(blob, token) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'tool_token_mentioned',
      {
        blob: blob == null ? null : String(blob),
        token: token == null ? null : String(token)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.mentioned === true;
    }
  }
  const text = String(blob || '');
  const tok = String(token || '').trim().toLowerCase();
  if (!text || !tok) return false;
  const exact = new RegExp(`\\b${escapeRegExp(tok)}\\b`);
  if (exact.test(text)) return true;
  if (tok === 'bird_x') {
    return /\bbird[\s_-]*x\b/.test(text);
  }
  return false;
}

function detectEyesTerminologyDriftInPool(pool) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const proposals = [];
    for (const item of (pool || [])) {
      const p = item && item.proposal;
      if (p && typeof p === 'object') proposals.push(p);
    }
    const rust = runBacklogAutoscalePrimitive(
      'detect_eyes_terminology_drift',
      {
        proposals,
        tool_capability_tokens: Array.isArray(TOOL_CAPABILITY_TOKENS)
          ? TOOL_CAPABILITY_TOKENS.map((x) => String(x || ''))
          : []
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const warnings = Array.isArray(rust.payload.payload.warnings)
        ? rust.payload.payload.warnings
        : [];
      return warnings.slice(0, 5).map((w) => ({
        proposal_id: w && w.proposal_id != null ? String(w.proposal_id) : null,
        reason: String(w && w.reason || 'tools_labeled_as_eyes'),
        matched_tools: Array.isArray(w && w.matched_tools) ? w.matched_tools.map((x) => String(x || '')).slice(0, 5) : [],
        sample: normalizeSpaces(String(w && w.sample || '')).slice(0, 140)
      }));
    }
  }
  const warnings = [];
  const seen = new Set();
  for (const item of (pool || [])) {
    const p = item && item.proposal;
    if (!p) continue;
    const blob = proposalTextBlob(p);
    if (!/\beye\b|\beyes\b/.test(blob)) continue;

    const matchedTools = TOOL_CAPABILITY_TOKENS.filter(t => toolTokenMentioned(blob, t));
    if (!matchedTools.length) continue;

    const key = `${p.id || 'unknown'}:${matchedTools.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    warnings.push({
      proposal_id: p.id || null,
      reason: 'tools_labeled_as_eyes',
      matched_tools: matchedTools.slice(0, 5),
      sample: normalizeSpaces(String(p.title || '')).slice(0, 140)
    });
  }
  return warnings.slice(0, 5);
}

function sourceEyeRef(p) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const proposal = p && typeof p === 'object' ? p : {};
    const metaSourceEye = proposal && proposal.meta && typeof proposal.meta.source_eye === 'string'
      ? proposal.meta.source_eye
      : null;
    const firstEvidenceRef = proposal && Array.isArray(proposal.evidence) && proposal.evidence.length
      ? String((proposal.evidence[0] || {}).evidence_ref || '')
      : null;
    const cache = globalThis.__PROTHEUS_SOURCE_EYE_REF_CACHE instanceof Map
      ? globalThis.__PROTHEUS_SOURCE_EYE_REF_CACHE
      : (globalThis.__PROTHEUS_SOURCE_EYE_REF_CACHE = new Map());
    const cacheKey = `${String(metaSourceEye || '')}\u0000${String(firstEvidenceRef || '')}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const rust = runBacklogAutoscalePrimitive(
      'source_eye_ref',
      {
        meta_source_eye: metaSourceEye,
        first_evidence_ref: firstEvidenceRef
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const eyeRef = String(rust.payload.payload.eye_ref || '');
      if (cache.size >= 1024) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(cacheKey, eyeRef);
      return eyeRef;
    }
  }
  const metaEye = p && p.meta && typeof p.meta.source_eye === 'string' ? p.meta.source_eye.trim() : '';
  if (metaEye) return `eye:${metaEye}`;
  const evRef = p && Array.isArray(p.evidence) && p.evidence.length ? String((p.evidence[0] || {}).evidence_ref || '') : '';
  if (evRef.startsWith('eye:')) return evRef;
  return 'eye:unknown_eye';
}

function normalizedRisk(v) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const raw = String(v || '');
    const cache = globalThis.__PROTHEUS_NORMALIZED_RISK_CACHE instanceof Map
      ? globalThis.__PROTHEUS_NORMALIZED_RISK_CACHE
      : (globalThis.__PROTHEUS_NORMALIZED_RISK_CACHE = new Map());
    if (cache.has(raw)) return cache.get(raw);
    const rust = runBacklogAutoscalePrimitive(
      'normalized_risk',
      { risk: raw || null },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const risk = String(rust.payload.payload.risk || 'low');
      if (cache.size >= 1024) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(raw, risk);
      return risk;
    }
  }
  const r = String(v || '').trim().toLowerCase();
  if (r === 'high' || r === 'medium' || r === 'low') return r;
  return 'low';
}

function parseIsoTs(ts) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const raw = String(ts || '');
    const cache = globalThis.__PROTHEUS_PARSE_ISO_TS_CACHE instanceof Map
      ? globalThis.__PROTHEUS_PARSE_ISO_TS_CACHE
      : (globalThis.__PROTHEUS_PARSE_ISO_TS_CACHE = new Map());
    if (cache.has(raw)) {
      const cached = cache.get(raw);
      return cached == null ? null : new Date(Number(cached));
    }
    const rust = runBacklogAutoscalePrimitive(
      'parse_iso_ts',
      { ts: raw || null },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const tsMs = rust.payload.payload.timestamp_ms;
      const parsed = tsMs == null ? NaN : Number(tsMs);
      const normalized = Number.isFinite(parsed) ? parsed : null;
      if (cache.size >= 2048) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(raw, normalized);
      return normalized == null ? null : new Date(normalized);
    }
  }
  const d = new Date(String(ts || ''));
  return isNaN(d.getTime()) ? null : d;
}

const NORMALIZE_PROPOSAL_STATUS_CACHE = new Map();
const NORMALIZE_PROPOSAL_STATUS_CACHE_MAX = 1024;
const PROPOSAL_STATUS_CACHE = new Map();
const PROPOSAL_STATUS_CACHE_MAX = 1024;
const PROPOSAL_STATUS_FOR_QUEUE_PRESSURE_CACHE = new Map();
const PROPOSAL_STATUS_FOR_QUEUE_PRESSURE_CACHE_MAX = 1024;
const PROPOSAL_OUTCOME_STATUS_CACHE = new Map();
const PROPOSAL_OUTCOME_STATUS_CACHE_MAX = 1024;
const QUEUE_UNDERFLOW_BACKFILL_CACHE = new Map();
const QUEUE_UNDERFLOW_BACKFILL_CACHE_MAX = 1024;
const PROPOSAL_RISK_SCORE_CACHE = new Map();
const PROPOSAL_RISK_SCORE_CACHE_MAX = 1024;
const PROPOSAL_SCORE_CACHE = new Map();
const PROPOSAL_SCORE_CACHE_MAX = 1024;
const IMPACT_WEIGHT_CACHE = new Map();
const IMPACT_WEIGHT_CACHE_MAX = 512;
const RISK_PENALTY_CACHE = new Map();
const RISK_PENALTY_CACHE_MAX = 512;
const ESTIMATE_TOKENS_CACHE = new Map();
const ESTIMATE_TOKENS_CACHE_MAX = 512;
const PROPOSAL_REMEDIATION_DEPTH_CACHE = new Map();
const PROPOSAL_REMEDIATION_DEPTH_CACHE_MAX = 512;
const PROPOSAL_DEDUP_KEY_CACHE = new Map();
const PROPOSAL_DEDUP_KEY_CACHE_MAX = 1024;
const SEMANTIC_TOKEN_SIMILARITY_CACHE = new Map();
const SEMANTIC_TOKEN_SIMILARITY_CACHE_MAX = 2048;
const SEMANTIC_CONTEXT_COMPARABLE_CACHE = new Map();
const SEMANTIC_CONTEXT_COMPARABLE_CACHE_MAX = 2048;
const SEMANTIC_NEAR_DUPLICATE_MATCH_CACHE = new Map();
const SEMANTIC_NEAR_DUPLICATE_MATCH_CACHE_MAX = 1024;
const STRATEGY_RANK_SCORE_CACHE = new Map();
const STRATEGY_RANK_SCORE_CACHE_MAX = 2048;
const STRATEGY_RANK_ADJUSTED_CACHE = new Map();
const STRATEGY_RANK_ADJUSTED_CACHE_MAX = 2048;
const TRIT_SHADOW_RANK_SCORE_CACHE = new Map();
const TRIT_SHADOW_RANK_SCORE_CACHE_MAX = 1024;
const STRATEGY_CIRCUIT_COOLDOWN_CACHE = new Map();
const STRATEGY_CIRCUIT_COOLDOWN_CACHE_MAX = 512;
const STRATEGY_TRIT_SHADOW_ADJUSTED_CACHE = new Map();
const STRATEGY_TRIT_SHADOW_ADJUSTED_CACHE_MAX = 1024;
const NON_YIELD_PENALTY_SCORE_CACHE = new Map();
const NON_YIELD_PENALTY_SCORE_CACHE_MAX = 1024;
const COLLECTIVE_SHADOW_ADJUSTMENTS_CACHE = new Map();
const COLLECTIVE_SHADOW_ADJUSTMENTS_CACHE_MAX = 1024;
const STRATEGY_TRIT_SHADOW_RANKING_SUMMARY_CACHE = new Map();
const STRATEGY_TRIT_SHADOW_RANKING_SUMMARY_CACHE_MAX = 512;
const SHADOW_SCOPE_MATCHES_CACHE = new Map();
const SHADOW_SCOPE_MATCHES_CACHE_MAX = 2048;
const COLLECTIVE_SHADOW_AGGREGATE_CACHE = new Map();
const COLLECTIVE_SHADOW_AGGREGATE_CACHE_MAX = 1024;
const EXPECTED_VALUE_SIGNAL_CACHE = new Map();
const EXPECTED_VALUE_SIGNAL_CACHE_MAX = 1024;
const VALUE_SIGNAL_SCORE_CACHE = new Map();
const VALUE_SIGNAL_SCORE_CACHE_MAX = 1024;
const COMPOSITE_ELIGIBILITY_SCORE_CACHE = new Map();
const COMPOSITE_ELIGIBILITY_SCORE_CACHE_MAX = 1024;
const TIME_TO_VALUE_SCORE_CACHE = new Map();
const TIME_TO_VALUE_SCORE_CACHE_MAX = 1024;
const VALUE_DENSITY_SCORE_CACHE = new Map();
const VALUE_DENSITY_SCORE_CACHE_MAX = 1024;
const TO_STEM_CACHE = new Map();
const TO_STEM_CACHE_MAX = 4096;
const NORMALIZE_DIRECTIVE_TEXT_CACHE = new Map();
const NORMALIZE_DIRECTIVE_TEXT_CACHE_MAX = 4096;
const TOKENIZE_DIRECTIVE_TEXT_CACHE = new Map();
const TOKENIZE_DIRECTIVE_TEXT_CACHE_MAX = 4096;
const NORMALIZE_SPACES_CACHE = new Map();
const NORMALIZE_SPACES_CACHE_MAX = 2048;
const PARSE_LOWER_LIST_CACHE = new Map();
const PARSE_LOWER_LIST_CACHE_MAX = 2048;
const CANARY_FAILED_CHECKS_ALLOWED_CACHE = new Map();
const CANARY_FAILED_CHECKS_ALLOWED_CACHE_MAX = 1024;
const NORMALIZE_DIRECTIVE_TIER_CACHE = new Map();
const NORMALIZE_DIRECTIVE_TIER_CACHE_MAX = 512;
const DIRECTIVE_TIER_WEIGHT_CACHE = new Map();
const DIRECTIVE_TIER_WEIGHT_CACHE_MAX = 256;
const DIRECTIVE_TIER_MIN_SHARE_CACHE = new Map();
const DIRECTIVE_TIER_MIN_SHARE_CACHE_MAX = 256;
const DIRECTIVE_TIER_COVERAGE_BONUS_CACHE = new Map();
const DIRECTIVE_TIER_COVERAGE_BONUS_CACHE_MAX = 512;
const DIRECTIVE_TIER_RESERVATION_NEED_CACHE = new Map();
const DIRECTIVE_TIER_RESERVATION_NEED_CACHE_MAX = 256;
const EXECUTION_RESERVE_SNAPSHOT_CACHE = new Map();
const EXECUTION_RESERVE_SNAPSHOT_CACHE_MAX = 512;
const BUDGET_PACING_GATE_CACHE = new Map();
const BUDGET_PACING_GATE_CACHE_MAX = 1024;
const CAPABILITY_CAP_CACHE = new Map();
const CAPABILITY_CAP_CACHE_MAX = 1024;
const ESTIMATE_TOKENS_FOR_CANDIDATE_CACHE = new Map();
const ESTIMATE_TOKENS_FOR_CANDIDATE_CACHE_MAX = 1024;
const MINUTES_SINCE_TS_CACHE = new Map();
const MINUTES_SINCE_TS_CACHE_MAX = 512;
const DATE_WINDOW_CACHE = new Map();
const DATE_WINDOW_CACHE_MAX = 256;
const IN_WINDOW_CACHE = new Map();
const IN_WINDOW_CACHE_MAX = 1024;
const START_OF_NEXT_UTC_DAY_CACHE = new Map();
const START_OF_NEXT_UTC_DAY_CACHE_MAX = 512;
const ISO_AFTER_MINUTES_CACHE = new Map();
const ISO_AFTER_MINUTES_CACHE_MAX = 1024;
const EXECUTE_CONFIDENCE_HISTORY_MATCH_CACHE = new Map();
const EXECUTE_CONFIDENCE_HISTORY_MATCH_CACHE_MAX = 1024;
const POLICY_HOLD_RESULT_CACHE = new Map();
const POLICY_HOLD_RESULT_CACHE_MAX = 256;
const NO_PROGRESS_RESULT_CACHE = new Map();
const NO_PROGRESS_RESULT_CACHE_MAX = 512;
const ATTEMPT_RUN_EVENT_CACHE = new Map();
const ATTEMPT_RUN_EVENT_CACHE_MAX = 512;
const SAFETY_STOP_RUN_EVENT_CACHE = new Map();
const SAFETY_STOP_RUN_EVENT_CACHE_MAX = 512;
const NON_YIELD_CATEGORY_CACHE = new Map();
const NON_YIELD_CATEGORY_CACHE_MAX = 1024;
const NON_YIELD_REASON_CACHE = new Map();
const NON_YIELD_REASON_CACHE_MAX = 1024;
const PROPOSAL_TYPE_FROM_RUN_EVENT_CACHE = new Map();
const PROPOSAL_TYPE_FROM_RUN_EVENT_CACHE_MAX = 1024;
const RUN_EVENT_OBJECTIVE_ID_CACHE = new Map();
const RUN_EVENT_OBJECTIVE_ID_CACHE_MAX = 1024;
const RUN_EVENT_PROPOSAL_ID_CACHE = new Map();
const RUN_EVENT_PROPOSAL_ID_CACHE_MAX = 1024;
const CAPACITY_COUNTED_ATTEMPT_EVENT_CACHE = new Map();
const CAPACITY_COUNTED_ATTEMPT_EVENT_CACHE_MAX = 1024;
const REPEAT_GATE_ANCHOR_CACHE = new Map();
const REPEAT_GATE_ANCHOR_CACHE_MAX = 1024;
const SCORE_ONLY_RESULT_CACHE = new Map();
const SCORE_ONLY_RESULT_CACHE_MAX = 1024;
const SCORE_ONLY_FAILURE_LIKE_CACHE = new Map();
const SCORE_ONLY_FAILURE_LIKE_CACHE_MAX = 1024;
const GATE_EXHAUSTED_ATTEMPT_CACHE = new Map();
const GATE_EXHAUSTED_ATTEMPT_CACHE_MAX = 1024;
const CONSECUTIVE_GATE_EXHAUSTED_ATTEMPTS_CACHE = new Map();
const CONSECUTIVE_GATE_EXHAUSTED_ATTEMPTS_CACHE_MAX = 512;
const POLICY_HOLD_RUN_EVENT_CACHE = new Map();
const POLICY_HOLD_RUN_EVENT_CACHE_MAX = 1024;
const RUNS_SINCE_RESET_INDEX_CACHE = new Map();
const RUNS_SINCE_RESET_INDEX_CACHE_MAX = 256;
const ATTEMPT_EVENT_INDICES_CACHE = new Map();
const ATTEMPT_EVENT_INDICES_CACHE_MAX = 256;
const CAPACITY_COUNTED_ATTEMPT_INDICES_CACHE = new Map();
const CAPACITY_COUNTED_ATTEMPT_INDICES_CACHE_MAX = 256;
const CONSECUTIVE_NO_PROGRESS_RUNS_CACHE = new Map();
const CONSECUTIVE_NO_PROGRESS_RUNS_CACHE_MAX = 256;
const SHIPPED_COUNT_CACHE = new Map();
const SHIPPED_COUNT_CACHE_MAX = 256;
const EXECUTED_COUNT_BY_RISK_CACHE = new Map();
const EXECUTED_COUNT_BY_RISK_CACHE_MAX = 512;
const RUN_RESULT_TALLY_CACHE = new Map();
const RUN_RESULT_TALLY_CACHE_MAX = 256;
const QOS_LANE_USAGE_CACHE = new Map();
const QOS_LANE_USAGE_CACHE_MAX = 256;
const QOS_LANE_WEIGHTS_CACHE = new Map();
const QOS_LANE_WEIGHTS_CACHE_MAX = 256;
const QOS_LANE_SHARE_CAP_EXCEEDED_CACHE = new Map();
const QOS_LANE_SHARE_CAP_EXCEEDED_CACHE_MAX = 256;
const QOS_LANE_FROM_CANDIDATE_CACHE = new Map();
const QOS_LANE_FROM_CANDIDATE_CACHE_MAX = 512;
const EYE_OUTCOME_COUNT_WINDOW_CACHE = new Map();
const EYE_OUTCOME_COUNT_WINDOW_CACHE_MAX = 256;
const EYE_OUTCOME_COUNT_LAST_HOURS_CACHE = new Map();
const EYE_OUTCOME_COUNT_LAST_HOURS_CACHE_MAX = 256;
const SORTED_COUNTS_CACHE = new Map();
const SORTED_COUNTS_CACHE_MAX = 256;

function isPolicyHoldResult(result): boolean {
  const r = String(result || '').trim();
  if (!r) return false;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    if (POLICY_HOLD_RESULT_CACHE.has(r)) {
      return POLICY_HOLD_RESULT_CACHE.get(r) === true;
    }
    const rust = runBacklogAutoscalePrimitive(
      'policy_hold_result',
      { result: r },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = rust.payload.payload.is_policy_hold === true;
      if (POLICY_HOLD_RESULT_CACHE.size >= POLICY_HOLD_RESULT_CACHE_MAX) {
        const oldest = POLICY_HOLD_RESULT_CACHE.keys().next();
        if (!oldest.done) POLICY_HOLD_RESULT_CACHE.delete(oldest.value);
      }
      POLICY_HOLD_RESULT_CACHE.set(r, val);
      return val;
    }
  }
  return r.startsWith('no_candidates_policy_')
    || r === 'stop_init_gate_budget_autopause'
    || r === 'stop_init_gate_readiness'
    || r === 'stop_init_gate_readiness_blocked'
    || r === 'stop_init_gate_criteria_quality_insufficient'
    || r === 'stop_repeat_gate_mutation_guard'
    || r === 'score_only_fallback_route_block'
    || r === 'score_only_fallback_low_execution_confidence';
}

function isPolicyHoldRunEvent(evt): boolean {
  if (!evt || evt.type !== 'autonomy_run') return false;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const result = String(evt.result || '').trim();
    const key = `${evt.policy_hold === true ? '1' : '0'}\u0000${result}`;
    if (POLICY_HOLD_RUN_EVENT_CACHE.has(key)) {
      return POLICY_HOLD_RUN_EVENT_CACHE.get(key) === true;
    }
    const rust = runBacklogAutoscalePrimitive(
      'policy_hold_run_event',
      {
        event_type: String(evt.type || ''),
        policy_hold: evt.policy_hold === true,
        result
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = rust.payload.payload.is_policy_hold_run_event === true;
      if (POLICY_HOLD_RUN_EVENT_CACHE.size >= POLICY_HOLD_RUN_EVENT_CACHE_MAX) {
        const oldest = POLICY_HOLD_RUN_EVENT_CACHE.keys().next();
        if (!oldest.done) POLICY_HOLD_RUN_EVENT_CACHE.delete(oldest.value);
      }
      POLICY_HOLD_RUN_EVENT_CACHE.set(key, val);
      return val;
    }
  }
  if (evt.policy_hold === true) return true;
  return isPolicyHoldResult(evt.result);
}

function latestPolicyHoldRunEvent(events) {
  const rows = Array.isArray(events) ? events : [];
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rustEvents = [];
    for (const evt of rows) {
      if (!evt || typeof evt !== 'object') continue;
      const parsedTs = parseIsoTs(evt.ts);
      rustEvents.push({
        event_type: String(evt.type || ''),
        result: String(evt.result || ''),
        policy_hold: evt.policy_hold === true,
        ts_ms: parsedTs ? parsedTs.getTime() : null,
        ts: evt.ts != null ? String(evt.ts) : '',
        hold_reason: evt.hold_reason != null ? String(evt.hold_reason) : '',
        route_block_reason: evt.route_block_reason != null ? String(evt.route_block_reason) : ''
      });
    }
    const rust = runBacklogAutoscalePrimitive(
      'policy_hold_latest_event',
      { events: rustEvents },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      if (payload.found === true) {
        const idx = Number(payload.event_index);
        if (Number.isFinite(idx) && idx >= 0 && idx < rows.length) {
          const exact = rows[Math.floor(idx)];
          if (exact && typeof exact === 'object') return exact;
        }
        const tsText = normalizeSpaces(payload.ts || '');
        let tsValue = tsText || null;
        if (!tsValue && Number.isFinite(Number(payload.ts_ms))) {
          tsValue = new Date(Number(payload.ts_ms)).toISOString();
        }
        return {
          type: 'autonomy_run',
          result: String(payload.result || ''),
          ts: tsValue,
          hold_reason: payload.hold_reason != null ? String(payload.hold_reason) : '',
          route_block_reason: payload.route_block_reason != null ? String(payload.route_block_reason) : '',
          policy_hold: true
        };
      }
      return null;
    }
  }
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const evt = rows[i];
    if (!evt || evt.type !== 'autonomy_run') continue;
    if (!isPolicyHoldRunEvent(evt)) continue;
    return evt;
  }
  return null;
}

function policyHoldPressureSnapshot(events, opts: AnyObj = {}) {
  const rows = Array.isArray(events) ? events : [];
  const windowHours = Math.max(
    1,
    Number(opts.window_hours || AUTONOMY_POLICY_HOLD_PRESSURE_WINDOW_HOURS || 24)
  );
  const minSamples = Math.max(
    1,
    Number(opts.min_samples || AUTONOMY_POLICY_HOLD_PRESSURE_MIN_SAMPLES || 1)
  );
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rustEvents = [];
    for (const evt of rows) {
      if (!evt || typeof evt !== 'object') continue;
      const parsedTs = parseIsoTs(evt.ts);
      rustEvents.push({
        event_type: String(evt.type || ''),
        result: String(evt.result || ''),
        policy_hold: evt.policy_hold === true,
        ts_ms: parsedTs ? parsedTs.getTime() : null
      });
    }
    const rust = runBacklogAutoscalePrimitive(
      'policy_hold_pressure',
      {
        events: rustEvents,
        window_hours: windowHours,
        min_samples: minSamples,
        now_ms: Date.now(),
        warn_rate: AUTONOMY_POLICY_HOLD_PRESSURE_WARN_RATE,
        hard_rate: AUTONOMY_POLICY_HOLD_PRESSURE_HARD_RATE
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }

  const cutoffMs = Date.now() - (windowHours * 3600000);
  let attempts = 0;
  let policyHolds = 0;
  for (const evt of rows) {
    if (!evt || evt.type !== 'autonomy_run') continue;
    const result = String(evt.result || '');
    if (!result || result === 'lock_busy' || result === 'stop_repeat_gate_interval') continue;
    const t = parseIsoTs(evt.ts);
    if (t && t.getTime() < cutoffMs) continue;
    attempts += 1;
    if (isPolicyHoldRunEvent(evt)) policyHolds += 1;
  }
  const rate = attempts > 0 ? clampNumber(policyHolds / attempts, 0, 1) : 0;
  const applicable = attempts >= minSamples;
  const level = !applicable
    ? 'normal'
    : rate >= AUTONOMY_POLICY_HOLD_PRESSURE_HARD_RATE
      ? 'hard'
      : rate >= AUTONOMY_POLICY_HOLD_PRESSURE_WARN_RATE
        ? 'warn'
        : 'normal';
  return {
    window_hours: windowHours,
    min_samples: minSamples,
    samples: attempts,
    policy_holds: policyHolds,
    rate: Number(rate.toFixed(3)),
    level,
    applicable
  };
}

function policyHoldCooldownMinutesForPressure(baseMinutes, pressure) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const snapshot = pressure && typeof pressure === 'object' ? pressure : {};
    const rust = runBacklogAutoscalePrimitive(
      'policy_hold_cooldown',
      {
        base_minutes: Number(baseMinutes || 0),
        pressure_level: String(snapshot.level || ''),
        pressure_applicable: snapshot.applicable === true,
        last_result: '',
        now_ms: Date.now(),
        cooldown_warn_minutes: AUTONOMY_POLICY_HOLD_COOLDOWN_WARN_MINUTES,
        cooldown_hard_minutes: AUTONOMY_POLICY_HOLD_COOLDOWN_HARD_MINUTES,
        cooldown_cap_minutes: AUTONOMY_POLICY_HOLD_COOLDOWN_CAP_MINUTES,
        cooldown_manual_review_minutes: AUTONOMY_POLICY_HOLD_COOLDOWN_MANUAL_REVIEW_MINUTES,
        cooldown_unchanged_state_minutes: AUTONOMY_POLICY_HOLD_COOLDOWN_UNCHANGED_STATE_MINUTES,
        readiness_retry_minutes: Math.max(0, Math.round(Number(AUTONOMY_READINESS_RETRY_COOLDOWN_HOURS || 0) * 60)),
        until_next_day_caps: AUTONOMY_POLICY_HOLD_COOLDOWN_UNTIL_NEXT_DAY_CAPS === true
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Math.max(0, Math.round(Number(rust.payload.payload.cooldown_minutes || 0)));
    }
  }

  let cooldown = Math.max(0, Number(baseMinutes || 0));
  const snapshot = pressure && typeof pressure === 'object' ? pressure : {};
  const level = String(snapshot.level || '').toLowerCase();
  if (snapshot.applicable === true && level === 'hard') {
    cooldown = Math.max(cooldown, AUTONOMY_POLICY_HOLD_COOLDOWN_HARD_MINUTES);
  } else if (snapshot.applicable === true && level === 'warn') {
    cooldown = Math.max(cooldown, AUTONOMY_POLICY_HOLD_COOLDOWN_WARN_MINUTES);
  }
  return Math.max(0, Math.round(cooldown));
}

function minutesUntilNextUtcDay(nowMs = Date.now()) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'minutes_until_next_utc_day',
      { now_ms: Number(nowMs) },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Math.max(0, Math.round(Number(rust.payload.payload.minutes || 0)));
    }
  }
  const now = Number(nowMs);
  if (!Number.isFinite(now) || now <= 0) return 0;
  const d = new Date(now);
  const nextUtcDayMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
  const deltaMs = Math.max(0, nextUtcDayMs - now);
  return Math.max(0, Math.ceil(deltaMs / 60000));
}

function policyHoldCooldownMinutesForResult(baseMinutes, pressure, lastPolicyHoldRun) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const snapshot = pressure && typeof pressure === 'object' ? pressure : {};
    const row = lastPolicyHoldRun && typeof lastPolicyHoldRun === 'object' ? lastPolicyHoldRun : {};
    const rust = runBacklogAutoscalePrimitive(
      'policy_hold_cooldown',
      {
        base_minutes: Number(baseMinutes || 0),
        pressure_level: String(snapshot.level || ''),
        pressure_applicable: snapshot.applicable === true,
        last_result: String(row.result || ''),
        now_ms: Date.now(),
        cooldown_warn_minutes: AUTONOMY_POLICY_HOLD_COOLDOWN_WARN_MINUTES,
        cooldown_hard_minutes: AUTONOMY_POLICY_HOLD_COOLDOWN_HARD_MINUTES,
        cooldown_cap_minutes: AUTONOMY_POLICY_HOLD_COOLDOWN_CAP_MINUTES,
        cooldown_manual_review_minutes: AUTONOMY_POLICY_HOLD_COOLDOWN_MANUAL_REVIEW_MINUTES,
        cooldown_unchanged_state_minutes: AUTONOMY_POLICY_HOLD_COOLDOWN_UNCHANGED_STATE_MINUTES,
        readiness_retry_minutes: Math.max(0, Math.round(Number(AUTONOMY_READINESS_RETRY_COOLDOWN_HOURS || 0) * 60)),
        until_next_day_caps: AUTONOMY_POLICY_HOLD_COOLDOWN_UNTIL_NEXT_DAY_CAPS === true
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Math.max(0, Math.round(Number(rust.payload.payload.cooldown_minutes || 0)));
    }
  }

  let cooldown = policyHoldCooldownMinutesForPressure(baseMinutes, pressure);
  const row = lastPolicyHoldRun && typeof lastPolicyHoldRun === 'object' ? lastPolicyHoldRun : {};
  const result = String(row.result || '').trim().toLowerCase();
  if (!result) return cooldown;

  if (result === 'no_candidates_policy_daily_cap' || result === 'no_candidates_policy_canary_cap') {
    const capCooldown = AUTONOMY_POLICY_HOLD_COOLDOWN_UNTIL_NEXT_DAY_CAPS
      ? minutesUntilNextUtcDay()
      : AUTONOMY_POLICY_HOLD_COOLDOWN_CAP_MINUTES;
    cooldown = Math.max(cooldown, capCooldown);
  } else if (result === 'no_candidates_policy_manual_review_pending' || result === 'stop_repeat_gate_human_escalation_pending') {
    cooldown = Math.max(cooldown, AUTONOMY_POLICY_HOLD_COOLDOWN_MANUAL_REVIEW_MINUTES);
  } else if (result === 'no_candidates_policy_unchanged_state') {
    cooldown = Math.max(cooldown, AUTONOMY_POLICY_HOLD_COOLDOWN_UNCHANGED_STATE_MINUTES);
  } else if (
    result === 'stop_init_gate_readiness'
    || result === 'stop_init_gate_readiness_blocked'
    || result === 'stop_init_gate_criteria_quality_insufficient'
  ) {
    const readinessRetryMinutes = Math.max(0, Math.round(Number(AUTONOMY_READINESS_RETRY_COOLDOWN_HOURS || 0) * 60));
    cooldown = Math.max(cooldown, readinessRetryMinutes);
  }

  return Math.max(0, Math.round(cooldown));
}

function policyHoldReasonFromEvent(evt) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const row = evt && typeof evt === 'object' ? evt : {};
    const rust = runBacklogAutoscalePrimitive(
      'policy_hold_reason_from_event',
      {
        hold_reason: row.hold_reason == null ? null : String(row.hold_reason),
        route_block_reason: row.route_block_reason == null ? null : String(row.route_block_reason),
        result: row.result == null ? null : String(row.result)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return String(rust.payload.payload.reason || '');
    }
  }
  const row = evt && typeof evt === 'object' ? evt : {};
  const explicit = normalizeSpaces(row.hold_reason || row.route_block_reason).toLowerCase();
  if (explicit) return explicit;
  const result = normalizeSpaces(row.result).toLowerCase();
  if (result) return result;
  return 'policy_hold_unknown';
}

function objectivePolicyHoldPattern(events, objectiveId, opts: AnyObj = {}) {
  const oid = normalizeSpaces(objectiveId);
  const windowHours = Math.max(1, Number(opts.window_hours || AUTONOMY_POLICY_HOLD_DAMPENER_WINDOW_HOURS || 24));
  const repeatThreshold = Math.max(2, Number(opts.repeat_threshold || AUTONOMY_POLICY_HOLD_DAMPENER_REPEAT_THRESHOLD || 2));
  const out = {
    objective_id: oid || null,
    window_hours: windowHours,
    repeat_threshold: repeatThreshold,
    total_holds: 0,
    top_reason: null,
    top_count: 0,
    by_reason: {},
    should_dampen: false
  };
  if (!oid) return out;

  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rows = Array.isArray(events) ? events : [];
    const rustEvents = [];
    for (const evt of rows) {
      if (!evt || typeof evt !== 'object') continue;
      const parsedTs = parseIsoTs(evt.ts);
      rustEvents.push({
        event_type: String(evt.type || ''),
        result: String(evt.result || ''),
        objective_id: normalizeSpaces(evt.objective_id || ''),
        hold_reason: normalizeSpaces(evt.hold_reason || ''),
        route_block_reason: normalizeSpaces(evt.route_block_reason || ''),
        policy_hold: evt.policy_hold === true,
        ts_ms: parsedTs ? parsedTs.getTime() : null
      });
    }
    const rust = runBacklogAutoscalePrimitive(
      'policy_hold_pattern',
      {
        events: rustEvents,
        objective_id: oid,
        window_hours: windowHours,
        repeat_threshold: repeatThreshold,
        now_ms: Date.now()
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }

  const rows = Array.isArray(events) ? events : [];
  const cutoffMs = Date.now() - (windowHours * 3600000);
  const counts = {};
  for (const evt of rows) {
    if (!evt || evt.type !== 'autonomy_run') continue;
    if (!isPolicyHoldRunEvent(evt)) continue;
    const evtObjectiveId = normalizeSpaces(evt.objective_id);
    if (!evtObjectiveId || evtObjectiveId !== oid) continue;
    const t = parseIsoTs(evt.ts);
    if (t && t.getTime() < cutoffMs) continue;
    const reason = policyHoldReasonFromEvent(evt);
    counts[reason] = Number(counts[reason] || 0) + 1;
    out.total_holds += 1;
  }
  out.by_reason = counts;
  for (const [reason, countRaw] of Object.entries(counts)) {
    const count = Number(countRaw || 0);
    if (count <= out.top_count) continue;
    out.top_reason = reason;
    out.top_count = count;
  }
  out.should_dampen = out.top_count >= repeatThreshold;
  return out;
}

function ageHours(dateStr) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'age_hours',
      {
        date: dateStr == null ? null : String(dateStr),
        now_ms: Date.now()
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Number(rust.payload.payload.age_hours || 0);
    }
  }
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  return (Date.now() - start.getTime()) / (1000 * 60 * 60);
}

function getCooldowns() {
  const raw = loadJson(COOLDOWNS_PATH, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function setCooldown(proposalId, hours, reason) {
  const cooldowns = getCooldowns();
  const untilMs = Date.now() + (hours * 60 * 60 * 1000);
  cooldowns[proposalId] = {
    set_ts: nowIso(),
    until_ms: untilMs,
    until: new Date(untilMs).toISOString(),
    reason: String(reason || '').slice(0, 200)
  };
  saveJson(COOLDOWNS_PATH, cooldowns);
}

function cooldownEntry(proposalId) {
  const cooldowns = getCooldowns();
  const ent = cooldowns[proposalId];
  if (!ent) return null;
  const nowMs = Date.now();
  const untilMs = Number(ent.until_ms || 0);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'cooldown_active_state',
      {
        until_ms: untilMs,
        now_ms: nowMs
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      if (rust.payload.payload.expired === true) {
        delete cooldowns[proposalId];
        saveJson(COOLDOWNS_PATH, cooldowns);
        return null;
      }
      return rust.payload.payload.active === true ? ent : null;
    }
  }
  if (!untilMs || nowMs > untilMs) {
    delete cooldowns[proposalId];
    saveJson(COOLDOWNS_PATH, cooldowns);
    return null;
  }
  return ent;
}

function cooldownActive(proposalId) {
  const cooldowns = getCooldowns();
  const ent = cooldowns[proposalId];
  if (!ent) return false;
  const nowMs = Date.now();
  const untilMs = Number(ent.until_ms || 0);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'cooldown_active_state',
      {
        until_ms: untilMs,
        now_ms: nowMs
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      if (rust.payload.payload.expired === true) {
        delete cooldowns[proposalId];
        saveJson(COOLDOWNS_PATH, cooldowns);
        return false;
      }
      return rust.payload.payload.active === true;
    }
  }
  if (!untilMs || nowMs > untilMs) {
    delete cooldowns[proposalId];
    saveJson(COOLDOWNS_PATH, cooldowns);
    return false;
  }
  return true;
}

function capabilityCooldownKey(capabilityKey) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'capability_cooldown_key',
      { capability_key: capabilityKey == null ? null : String(capabilityKey) },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return String(rust.payload.payload.cooldown_key || '');
    }
  }
  const k = String(capabilityKey || '').trim().toLowerCase();
  if (!k) return '';
  return `capability:${k.replace(/[^a-z0-9:_-]/g, '_')}`;
}

function setCapabilityCooldown(capabilityKey, hours, reason) {
  const key = capabilityCooldownKey(capabilityKey);
  if (!key) return;
  setCooldown(key, hours, reason);
}

function capabilityCooldownActive(capabilityKey) {
  const key = capabilityCooldownKey(capabilityKey);
  if (!key) return false;
  return cooldownActive(key);
}

function executeConfidenceCooldownKey(capabilityKey, objectiveId, proposalType) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'execute_confidence_cooldown_key',
      {
        capability_key: String(capabilityKey || ''),
        objective_id: String(objectiveId || ''),
        proposal_type: String(proposalType || '')
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return String(rust.payload.payload.cooldown_key || '');
    }
  }

  const objective = sanitizeDirectiveObjectiveId(objectiveId || '');
  if (objective) {
    return `exec_confidence:objective:${String(objective).toLowerCase().replace(/[^a-z0-9:_-]/g, '_')}`;
  }
  const capKey = String(capabilityKey || '').trim().toLowerCase();
  if (capKey) {
    return `exec_confidence:capability:${capKey.replace(/[^a-z0-9:_-]/g, '_')}`;
  }
  const type = String(proposalType || '').trim().toLowerCase();
  if (type) {
    return `exec_confidence:type:${type.replace(/[^a-z0-9:_-]/g, '_')}`;
  }
  return '';
}

function readinessRetryCooldownKey(strategyId, executionMode) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'readiness_retry_cooldown_key',
      {
        strategy_id: strategyId == null ? null : String(strategyId),
        execution_mode: executionMode == null ? null : String(executionMode)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return String(rust.payload.payload.cooldown_key || '');
    }
  }
  const sid = normalizeSpaces(strategyId).toLowerCase().replace(/[^a-z0-9:_-]/g, '_');
  if (!sid) return '';
  const mode = normalizeSpaces(executionMode).toLowerCase().replace(/[^a-z0-9:_-]/g, '_');
  if (!mode) return `readiness:strategy:${sid}`;
  return `readiness:strategy:${sid}:mode:${mode}`;
}

function executeConfidenceCooldownActive(capabilityKey, objectiveId, proposalType) {
  const key = executeConfidenceCooldownKey(capabilityKey, objectiveId, proposalType);
  if (!key) return false;
  const active = cooldownActive(key);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'execute_confidence_cooldown_active',
      {
        cooldown_key: key,
        cooldown_active: active === true
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.active === true;
    }
  }
  return active;
}

function dailyBudgetPath(dateStr) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'daily_budget_path',
      {
        state_dir: DAILY_BUDGET_DIR,
        date_str: dateStr == null ? null : String(dateStr)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const value = String(rust.payload.payload.path || '').trim();
      if (value) return value;
    }
  }
  return path.join(DAILY_BUDGET_DIR, `${dateStr}.json`);
}

function loadDailyBudget(dateStr) {
  const caps = effectiveStrategyBudget();
  const defaultCap = Number.isFinite(Number(caps.daily_token_cap)) ? Number(caps.daily_token_cap) : DAILY_TOKEN_CAP;
  const out = loadSystemBudgetState(dateStr, {
    state_dir: DAILY_BUDGET_DIR,
    allow_strategy: false,
    daily_token_cap: defaultCap
  });
  out.date = String(out.date || dateStr);
  out.used_est = Number.isFinite(Number(out.used_est)) ? Number(out.used_est) : 0;
  out.token_cap = defaultCap;
  return out;
}

function saveDailyBudget(b) {
  const dateStr = String((b && b.date) || nowIso().slice(0, 10));
  saveSystemBudgetState({
    ...(b && typeof b === 'object' ? b : {}),
    date: dateStr
  }, {
    state_dir: DAILY_BUDGET_DIR,
    allow_strategy: false
  });
}

function runsPathFor(dateStr) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'runs_path_for',
      {
        runs_dir: RUNS_DIR,
        date_str: dateStr == null ? null : String(dateStr)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const value = String(rust.payload.payload.path || '').trim();
      if (value) return value;
    }
  }
  return path.join(RUNS_DIR, `${dateStr}.jsonl`);
}

function readRuns(dateStr) {
  return readJsonl(runsPathFor(dateStr));
}

function isNoProgressRun(evt) {
  if (!evt || evt.type !== 'autonomy_run') return false;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const result = String(evt.result || '');
    const outcome = String(evt.outcome || '');
    const key = `${result}\u0000${outcome}`;
    if (NO_PROGRESS_RESULT_CACHE.has(key)) {
      return NO_PROGRESS_RESULT_CACHE.get(key) === true;
    }
    const rust = runBacklogAutoscalePrimitive(
      'no_progress_result',
      {
        event_type: String(evt.type || ''),
        result,
        outcome
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = rust.payload.payload.is_no_progress === true;
      if (NO_PROGRESS_RESULT_CACHE.size >= NO_PROGRESS_RESULT_CACHE_MAX) {
        const oldest = NO_PROGRESS_RESULT_CACHE.keys().next();
        if (!oldest.done) NO_PROGRESS_RESULT_CACHE.delete(oldest.value);
      }
      NO_PROGRESS_RESULT_CACHE.set(key, val);
      return val;
    }
  }
  if (evt.result === 'executed') return evt.outcome !== 'shipped';
  return evt.result === 'init_gate_stub'
    || evt.result === 'init_gate_low_score'
    || evt.result === 'init_gate_blocked_route'
    || evt.result === 'stop_repeat_gate_capability_cap'
    || evt.result === 'stop_repeat_gate_directive_pulse_cooldown'
    || evt.result === 'stop_repeat_gate_directive_pulse_tier_reservation'
    || evt.result === 'stop_repeat_gate_human_escalation_pending'
    || evt.result === 'stop_repeat_gate_stale_signal'
    || evt.result === 'stop_init_gate_quality_exhausted'
    || evt.result === 'stop_init_gate_directive_fit_exhausted'
    || evt.result === 'stop_init_gate_actionability_exhausted'
    || evt.result === 'stop_init_gate_optimization_good_enough'
    || evt.result === 'stop_init_gate_value_signal_exhausted'
    || evt.result === 'stop_init_gate_tier1_governance'
    || evt.result === 'stop_init_gate_medium_risk_guard'
    || evt.result === 'stop_init_gate_medium_requires_canary'
    || evt.result === 'stop_init_gate_composite_exhausted'
    || evt.result === 'stop_repeat_gate_capability_cooldown'
    || evt.result === 'stop_repeat_gate_capability_no_change_cooldown'
    || evt.result === 'stop_repeat_gate_medium_canary_cap'
    || evt.result === 'stop_repeat_gate_candidate_exhausted'
    || evt.result === 'stop_repeat_gate_preview_churn_cooldown'
    || evt.result === 'stop_repeat_gate_exhaustion_cooldown'
    || evt.result === 'stop_repeat_gate_no_progress'
    || evt.result === 'stop_repeat_gate_dopamine';
}

function runsSinceReset(events) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rows = Array.isArray(events) ? events : [];
    const rustEvents = [];
    for (const evt of rows) {
      if (!evt || typeof evt !== 'object') continue;
      rustEvents.push({ event_type: String(evt.type || '') });
    }
    const key = rustEvents.map((row) => row.event_type).join('\u0001');
    if (RUNS_SINCE_RESET_INDEX_CACHE.has(key)) {
      const cached = Number(RUNS_SINCE_RESET_INDEX_CACHE.get(key) || 0);
      return rows.slice(Math.max(0, cached));
    }
    const rust = runBacklogAutoscalePrimitive(
      'runs_since_reset_index',
      { events: rustEvents },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const start = Math.max(0, Number(rust.payload.payload.start_index || 0));
      if (RUNS_SINCE_RESET_INDEX_CACHE.size >= RUNS_SINCE_RESET_INDEX_CACHE_MAX) {
        const oldest = RUNS_SINCE_RESET_INDEX_CACHE.keys().next();
        if (!oldest.done) RUNS_SINCE_RESET_INDEX_CACHE.delete(oldest.value);
      }
      RUNS_SINCE_RESET_INDEX_CACHE.set(key, start);
      return rows.slice(start);
    }
  }
  let idx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.type === 'autonomy_reset') {
      idx = i;
      break;
    }
  }
  return idx >= 0 ? events.slice(idx + 1) : events;
}

function isAttemptRunEvent(evt) {
  if (!evt || evt.type !== 'autonomy_run') return false;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const result = String(evt.result || '');
    if (ATTEMPT_RUN_EVENT_CACHE.has(result)) {
      return ATTEMPT_RUN_EVENT_CACHE.get(result) === true;
    }
    const rust = runBacklogAutoscalePrimitive(
      'attempt_run_event',
      {
        event_type: String(evt.type || ''),
        result
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = rust.payload.payload.is_attempt === true;
      if (ATTEMPT_RUN_EVENT_CACHE.size >= ATTEMPT_RUN_EVENT_CACHE_MAX) {
        const oldest = ATTEMPT_RUN_EVENT_CACHE.keys().next();
        if (!oldest.done) ATTEMPT_RUN_EVENT_CACHE.delete(oldest.value);
      }
      ATTEMPT_RUN_EVENT_CACHE.set(result, val);
      return val;
    }
  }
  return evt.result === 'executed'
    || evt.result === 'init_gate_stub'
    || evt.result === 'init_gate_low_score'
    || evt.result === 'init_gate_blocked_route'
    || evt.result === 'stop_repeat_gate_directive_pulse_cooldown'
    || evt.result === 'stop_repeat_gate_directive_pulse_tier_reservation'
    || evt.result === 'stop_repeat_gate_human_escalation_pending'
    || evt.result === 'stop_repeat_gate_capability_cap'
    || evt.result === 'stop_repeat_gate_stale_signal'
    || evt.result === 'stop_init_gate_quality_exhausted'
    || evt.result === 'stop_init_gate_directive_fit_exhausted'
    || evt.result === 'stop_init_gate_actionability_exhausted'
    || evt.result === 'stop_init_gate_optimization_good_enough'
    || evt.result === 'stop_init_gate_value_signal_exhausted'
    || evt.result === 'stop_init_gate_tier1_governance'
    || evt.result === 'stop_init_gate_composite_exhausted'
    || evt.result === 'stop_repeat_gate_capability_cooldown'
    || evt.result === 'stop_repeat_gate_capability_no_change_cooldown'
    || evt.result === 'stop_repeat_gate_preview_churn_cooldown'
    || evt.result === 'stop_repeat_gate_exhaustion_cooldown'
    || evt.result === 'stop_repeat_gate_candidate_exhausted';
}

function attemptEvents(events) {
  const rows = Array.isArray(events) ? events : [];
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rustEvents = [];
    for (const evt of rows) {
      if (!evt || typeof evt !== 'object') continue;
      rustEvents.push({
        event_type: String(evt.type || ''),
        result: String(evt.result || '')
      });
    }
    const key = rustEvents
      .map((row) => `${row.event_type}\u0000${row.result}`)
      .join('\u0001');
    if (ATTEMPT_EVENT_INDICES_CACHE.has(key)) {
      const cached = ATTEMPT_EVENT_INDICES_CACHE.get(key);
      const indices = Array.isArray(cached) ? cached : [];
      return indices
        .map((idx) => rows[Number(idx)])
        .filter(Boolean);
    }
    const rust = runBacklogAutoscalePrimitive(
      'attempt_event_indices',
      { events: rustEvents },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const indicesRaw = Array.isArray(rust.payload.payload.indices) ? rust.payload.payload.indices : [];
      const indices = indicesRaw
        .map((idx) => Math.max(0, Math.floor(Number(idx))))
        .filter((idx) => Number.isFinite(idx) && idx < rows.length);
      if (ATTEMPT_EVENT_INDICES_CACHE.size >= ATTEMPT_EVENT_INDICES_CACHE_MAX) {
        const oldest = ATTEMPT_EVENT_INDICES_CACHE.keys().next();
        if (!oldest.done) ATTEMPT_EVENT_INDICES_CACHE.delete(oldest.value);
      }
      ATTEMPT_EVENT_INDICES_CACHE.set(key, indices);
      return indices
        .map((idx) => rows[idx])
        .filter(Boolean);
    }
  }
  return rows.filter(isAttemptRunEvent);
}

function runEventProposalId(evt) {
  if (!evt || typeof evt !== 'object') return '';
  const topEscalation = evt.top_escalation && typeof evt.top_escalation === 'object'
    ? evt.top_escalation
    : {};
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const proposalRaw = evt.proposal_id;
    const selectedRaw = evt.selected_proposal_id;
    const topEscalationRaw = topEscalation.proposal_id;
    const key = [
      proposalRaw ? '1' : '0',
      String(proposalRaw || ''),
      selectedRaw ? '1' : '0',
      String(selectedRaw || ''),
      topEscalationRaw ? '1' : '0',
      String(topEscalationRaw || '')
    ].join('\u0000');
    if (RUN_EVENT_PROPOSAL_ID_CACHE.has(key)) {
      return String(RUN_EVENT_PROPOSAL_ID_CACHE.get(key) || '');
    }
    const rust = runBacklogAutoscalePrimitive(
      'run_event_proposal_id',
      {
        proposal_id_present: !!proposalRaw,
        proposal_id: String(proposalRaw || ''),
        selected_proposal_id_present: !!selectedRaw,
        selected_proposal_id: String(selectedRaw || ''),
        top_escalation_present: !!topEscalationRaw,
        top_escalation_proposal_id: String(topEscalationRaw || '')
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const proposalVal = String(rust.payload.payload.proposal_id || '');
      if (RUN_EVENT_PROPOSAL_ID_CACHE.size >= RUN_EVENT_PROPOSAL_ID_CACHE_MAX) {
        const oldest = RUN_EVENT_PROPOSAL_ID_CACHE.keys().next();
        if (!oldest.done) RUN_EVENT_PROPOSAL_ID_CACHE.delete(oldest.value);
      }
      RUN_EVENT_PROPOSAL_ID_CACHE.set(key, proposalVal);
      return proposalVal;
    }
  }
  return normalizeSpaces(
    evt.proposal_id
    || evt.selected_proposal_id
    || topEscalation.proposal_id
    || ''
  );
}

function runEventObjectiveId(evt) {
  if (!evt || typeof evt !== 'object') return '';
  const pulse = evt.directive_pulse && typeof evt.directive_pulse === 'object'
    ? evt.directive_pulse
    : {};
  const binding = evt.objective_binding && typeof evt.objective_binding === 'object'
    ? evt.objective_binding
    : {};
  const topEscalation = evt.top_escalation && typeof evt.top_escalation === 'object'
    ? evt.top_escalation
    : {};
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const directivePulseRaw = pulse.objective_id;
    const objectiveRaw = evt.objective_id;
    const bindingRaw = binding.objective_id;
    const topEscalationRaw = topEscalation.objective_id;
    const key = [
      directivePulseRaw ? '1' : '0',
      String(directivePulseRaw || ''),
      objectiveRaw ? '1' : '0',
      String(objectiveRaw || ''),
      bindingRaw ? '1' : '0',
      String(bindingRaw || ''),
      topEscalationRaw ? '1' : '0',
      String(topEscalationRaw || '')
    ].join('\u0000');
    if (RUN_EVENT_OBJECTIVE_ID_CACHE.has(key)) {
      return String(RUN_EVENT_OBJECTIVE_ID_CACHE.get(key) || '');
    }
    const rust = runBacklogAutoscalePrimitive(
      'run_event_objective_id',
      {
        directive_pulse_present: !!directivePulseRaw,
        directive_pulse_objective_id: String(directivePulseRaw || ''),
        objective_id_present: !!objectiveRaw,
        objective_id: String(objectiveRaw || ''),
        objective_binding_present: !!bindingRaw,
        objective_binding_objective_id: String(bindingRaw || ''),
        top_escalation_present: !!topEscalationRaw,
        top_escalation_objective_id: String(topEscalationRaw || '')
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const objectiveVal = String(rust.payload.payload.objective_id || '');
      if (RUN_EVENT_OBJECTIVE_ID_CACHE.size >= RUN_EVENT_OBJECTIVE_ID_CACHE_MAX) {
        const oldest = RUN_EVENT_OBJECTIVE_ID_CACHE.keys().next();
        if (!oldest.done) RUN_EVENT_OBJECTIVE_ID_CACHE.delete(oldest.value);
      }
      RUN_EVENT_OBJECTIVE_ID_CACHE.set(key, objectiveVal);
      return objectiveVal;
    }
  }
  return sanitizeDirectiveObjectiveId(
    pulse.objective_id
    || evt.objective_id
    || binding.objective_id
    || topEscalation.objective_id
    || ''
  ) || '';
}

function isCapacityCountedAttemptEvent(evt): boolean {
  if (!evt || evt.type !== 'autonomy_run') return false;
  const result = String(evt.result || '');
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const proposalId = runEventProposalId(evt);
    const key = [
      String(evt.type || ''),
      result,
      evt.policy_hold === true ? '1' : '0',
      proposalId
    ].join('\u0000');
    if (CAPACITY_COUNTED_ATTEMPT_EVENT_CACHE.has(key)) {
      return CAPACITY_COUNTED_ATTEMPT_EVENT_CACHE.get(key) === true;
    }
    const rust = runBacklogAutoscalePrimitive(
      'capacity_counted_attempt_event',
      {
        event_type: String(evt.type || ''),
        result,
        policy_hold: evt.policy_hold === true,
        proposal_id: proposalId
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = rust.payload.payload.capacity_counted === true;
      if (CAPACITY_COUNTED_ATTEMPT_EVENT_CACHE.size >= CAPACITY_COUNTED_ATTEMPT_EVENT_CACHE_MAX) {
        const oldest = CAPACITY_COUNTED_ATTEMPT_EVENT_CACHE.keys().next();
        if (!oldest.done) CAPACITY_COUNTED_ATTEMPT_EVENT_CACHE.delete(oldest.value);
      }
      CAPACITY_COUNTED_ATTEMPT_EVENT_CACHE.set(key, val);
      return val;
    }
  }
  if (!result) return false;
  if (evt.policy_hold === true) return false;
  if (isPolicyHoldRunEvent(evt)) return false;
  if (result === 'lock_busy' || result === 'stop_repeat_gate_interval') return false;
  if (isScoreOnlyResult(result)) return false;
  if (result === 'executed') return true;
  if (isAttemptRunEvent(evt) && !!runEventProposalId(evt)) return true;
  return false;
}

function capacityCountedAttemptEvents(events) {
  const rows = Array.isArray(events) ? events : [];
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rustEvents = [];
    for (const evt of rows) {
      if (!evt || typeof evt !== 'object') continue;
      rustEvents.push({
        event_type: String(evt.type || ''),
        result: String(evt.result || ''),
        policy_hold: evt.policy_hold === true,
        proposal_id: runEventProposalId(evt)
      });
    }
    const key = rustEvents
      .map((row) => [
        row.event_type,
        row.result,
        row.policy_hold ? '1' : '0',
        row.proposal_id
      ].join('\u0000'))
      .join('\u0001');
    if (CAPACITY_COUNTED_ATTEMPT_INDICES_CACHE.has(key)) {
      const cached = CAPACITY_COUNTED_ATTEMPT_INDICES_CACHE.get(key);
      const indices = Array.isArray(cached) ? cached : [];
      return indices
        .map((idx) => rows[Number(idx)])
        .filter(Boolean);
    }
    const rust = runBacklogAutoscalePrimitive(
      'capacity_counted_attempt_indices',
      { events: rustEvents },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const indicesRaw = Array.isArray(rust.payload.payload.indices) ? rust.payload.payload.indices : [];
      const indices = indicesRaw
        .map((idx) => Math.max(0, Math.floor(Number(idx))))
        .filter((idx) => Number.isFinite(idx) && idx < rows.length);
      if (CAPACITY_COUNTED_ATTEMPT_INDICES_CACHE.size >= CAPACITY_COUNTED_ATTEMPT_INDICES_CACHE_MAX) {
        const oldest = CAPACITY_COUNTED_ATTEMPT_INDICES_CACHE.keys().next();
        if (!oldest.done) CAPACITY_COUNTED_ATTEMPT_INDICES_CACHE.delete(oldest.value);
      }
      CAPACITY_COUNTED_ATTEMPT_INDICES_CACHE.set(key, indices);
      return indices
        .map((idx) => rows[idx])
        .filter(Boolean);
    }
  }
  return rows.filter(isCapacityCountedAttemptEvent);
}

function deriveRepeatGateAnchor(evt) {
  if (!evt || typeof evt !== 'object') return {};
  const proposalId = runEventProposalId(evt);
  const objectiveId = runEventObjectiveId(evt);
  const binding = evt.objective_binding && typeof evt.objective_binding === 'object'
    ? evt.objective_binding
    : null;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = [
      proposalId,
      objectiveId,
      binding ? '1' : '0',
      binding && binding.pass !== false ? '1' : '0',
      binding && binding.required === true ? '1' : '0',
      String(binding && binding.source || ''),
      binding && binding.valid !== false ? '1' : '0'
    ].join('\u0000');
    if (REPEAT_GATE_ANCHOR_CACHE.has(key)) {
      const cached = REPEAT_GATE_ANCHOR_CACHE.get(key);
      return cached && typeof cached === 'object'
        ? { ...cached }
        : {};
    }
    const rust = runBacklogAutoscalePrimitive(
      'repeat_gate_anchor',
      {
        proposal_id: proposalId,
        objective_id: objectiveId,
        objective_binding_present: !!binding,
        objective_binding_pass: binding ? binding.pass !== false : true,
        objective_binding_required: binding ? binding.required === true : false,
        objective_binding_source: binding ? String(binding.source || '') : '',
        objective_binding_valid: binding ? binding.valid !== false : true
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      const outRust: AnyObj = {};
      if (payload.proposal_id) outRust.proposal_id = String(payload.proposal_id);
      if (payload.objective_id) outRust.objective_id = String(payload.objective_id);
      if (payload.objective_binding && typeof payload.objective_binding === 'object') {
        const b = payload.objective_binding;
        outRust.objective_binding = {
          pass: b.pass !== false,
          required: b.required === true,
          objective_id: String(b.objective_id || ''),
          source: String(b.source || 'repeat_gate_anchor'),
          valid: b.valid !== false
        };
      }
      if (REPEAT_GATE_ANCHOR_CACHE.size >= REPEAT_GATE_ANCHOR_CACHE_MAX) {
        const oldest = REPEAT_GATE_ANCHOR_CACHE.keys().next();
        if (!oldest.done) REPEAT_GATE_ANCHOR_CACHE.delete(oldest.value);
      }
      REPEAT_GATE_ANCHOR_CACHE.set(key, outRust);
      return outRust;
    }
  }
  const out: AnyObj = {};
  if (proposalId) out.proposal_id = proposalId;
  if (objectiveId) out.objective_id = objectiveId;
  if (binding && objectiveId) {
    out.objective_binding = {
      pass: binding.pass !== false,
      required: binding.required === true,
      objective_id: objectiveId,
      source: binding.source || 'repeat_gate_anchor',
      valid: binding.valid !== false
    };
  }
  return out;
}

function isScoreOnlyResult(result): boolean {
  const r = String(result || '');
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    if (SCORE_ONLY_RESULT_CACHE.has(r)) {
      return SCORE_ONLY_RESULT_CACHE.get(r) === true;
    }
    const rust = runBacklogAutoscalePrimitive(
      'score_only_result',
      { result: r },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = rust.payload.payload.is_score_only === true;
      if (SCORE_ONLY_RESULT_CACHE.size >= SCORE_ONLY_RESULT_CACHE_MAX) {
        const oldest = SCORE_ONLY_RESULT_CACHE.keys().next();
        if (!oldest.done) SCORE_ONLY_RESULT_CACHE.delete(oldest.value);
      }
      SCORE_ONLY_RESULT_CACHE.set(r, val);
      return val;
    }
  }
  return r === 'score_only_preview'
    || r === 'score_only_evidence'
    || r === 'stop_repeat_gate_preview_structural_cooldown'
    || r === 'stop_repeat_gate_preview_churn_cooldown';
}

function isScoreOnlyFailureLikeEvent(evt): boolean {
  if (!evt || evt.type !== 'autonomy_run') return false;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const verification = evt.preview_verification && typeof evt.preview_verification === 'object'
      ? evt.preview_verification
      : null;
    const key = [
      String(evt.type || ''),
      String(evt.result || ''),
      verification ? '1' : '0',
      verification && verification.passed === false ? '0' : '1',
      String(verification && verification.outcome || '')
    ].join('\u0000');
    if (SCORE_ONLY_FAILURE_LIKE_CACHE.has(key)) {
      return SCORE_ONLY_FAILURE_LIKE_CACHE.get(key) === true;
    }
    const rust = runBacklogAutoscalePrimitive(
      'score_only_failure_like',
      {
        event_type: String(evt.type || ''),
        result: String(evt.result || ''),
        preview_verification_present: !!verification,
        preview_verification_passed: verification ? verification.passed === true : null,
        preview_verification_outcome: verification ? String(verification.outcome || '') : ''
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = rust.payload.payload.is_failure_like === true;
      if (SCORE_ONLY_FAILURE_LIKE_CACHE.size >= SCORE_ONLY_FAILURE_LIKE_CACHE_MAX) {
        const oldest = SCORE_ONLY_FAILURE_LIKE_CACHE.keys().next();
        if (!oldest.done) SCORE_ONLY_FAILURE_LIKE_CACHE.delete(oldest.value);
      }
      SCORE_ONLY_FAILURE_LIKE_CACHE.set(key, val);
      return val;
    }
  }
  if (!isScoreOnlyResult(evt.result)) return false;
  if (evt.result === 'stop_repeat_gate_preview_structural_cooldown') return true;
  if (evt.result === 'stop_repeat_gate_preview_churn_cooldown') return true;
  const verification = evt.preview_verification && typeof evt.preview_verification === 'object'
    ? evt.preview_verification
    : null;
  if (!verification) return false;
  if (verification.passed === false) return true;
  return String(verification.outcome || '') === 'no_change';
}

function scoreOnlyProposalChurn(priorRuns, proposalId, windowHours) {
  const pid = String(proposalId || '').trim();
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'score_only_proposal_churn',
      {
        prior_runs: Array.isArray(priorRuns) ? priorRuns : [],
        proposal_id: pid,
        window_hours: Number(windowHours || 1),
        now_ms: Date.now()
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      return {
        count: Math.max(0, Number(payload.count || 0)),
        streak: Math.max(0, Number(payload.streak || 0)),
        first_ts: payload.first_ts ? String(payload.first_ts) : null,
        last_ts: payload.last_ts ? String(payload.last_ts) : null
      };
    }
  }
  if (!pid) {
    return {
      count: 0,
      streak: 0,
      first_ts: null,
      last_ts: null
    };
  }
  const nowMs = Date.now();
  const windowMs = Math.max(1, Number(windowHours || 1)) * 3600000;
  const cutoffMs = nowMs - windowMs;
  const matches: Array<{ ts: number; evt: AnyObj }> = [];
  for (const evt of priorRuns || []) {
    if (!evt || evt.type !== 'autonomy_run') continue;
    if (String(evt.proposal_id || '') !== pid) continue;
    const t = parseIsoTs(evt.ts);
    if (!t || t.getTime() < cutoffMs) continue;
    if (!isScoreOnlyFailureLikeEvent(evt)) continue;
    matches.push({ ts: t.getTime(), evt });
  }
  matches.sort((a, b) => a.ts - b.ts);
  let streak = 0;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const row = matches[i];
    if (!row || !row.evt) continue;
    if (!isScoreOnlyFailureLikeEvent(row.evt)) break;
    streak += 1;
  }
  return {
    count: matches.length,
    streak,
    first_ts: matches.length ? new Date(matches[0].ts).toISOString() : null,
    last_ts: matches.length ? new Date(matches[matches.length - 1].ts).toISOString() : null
  };
}

function isGateExhaustedAttempt(evt) {
  if (!evt || evt.type !== 'autonomy_run') return false;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const eventType = String(evt.type || '');
    const result = String(evt.result || '');
    const key = `${eventType}\u0000${result}`;
    if (GATE_EXHAUSTED_ATTEMPT_CACHE.has(key)) {
      return GATE_EXHAUSTED_ATTEMPT_CACHE.get(key) === true;
    }
    const rust = runBacklogAutoscalePrimitive(
      'gate_exhausted_attempt',
      { event_type: eventType, result },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = rust.payload.payload.is_gate_exhausted === true;
      if (GATE_EXHAUSTED_ATTEMPT_CACHE.size >= GATE_EXHAUSTED_ATTEMPT_CACHE_MAX) {
        const oldest = GATE_EXHAUSTED_ATTEMPT_CACHE.keys().next();
        if (!oldest.done) GATE_EXHAUSTED_ATTEMPT_CACHE.delete(oldest.value);
      }
      GATE_EXHAUSTED_ATTEMPT_CACHE.set(key, val);
      return val;
    }
  }
  return evt.result === 'stop_repeat_gate_stale_signal'
    || evt.result === 'stop_repeat_gate_capability_cap'
    || evt.result === 'stop_repeat_gate_directive_pulse_cooldown'
    || evt.result === 'stop_repeat_gate_directive_pulse_tier_reservation'
    || evt.result === 'stop_repeat_gate_human_escalation_pending'
    || evt.result === 'init_gate_blocked_route'
    || evt.result === 'stop_init_gate_quality_exhausted'
    || evt.result === 'stop_init_gate_directive_fit_exhausted'
    || evt.result === 'stop_init_gate_actionability_exhausted'
    || evt.result === 'stop_init_gate_optimization_good_enough'
    || evt.result === 'stop_init_gate_value_signal_exhausted'
    || evt.result === 'stop_init_gate_tier1_governance'
    || evt.result === 'stop_init_gate_medium_risk_guard'
    || evt.result === 'stop_init_gate_medium_requires_canary'
    || evt.result === 'stop_init_gate_composite_exhausted'
    || evt.result === 'stop_repeat_gate_capability_cooldown'
    || evt.result === 'stop_repeat_gate_capability_no_change_cooldown'
    || evt.result === 'stop_repeat_gate_preview_churn_cooldown'
    || evt.result === 'stop_repeat_gate_medium_canary_cap'
    || evt.result === 'stop_repeat_gate_candidate_exhausted';
}

function consecutiveGateExhaustedAttempts(events) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rows = Array.isArray(events) ? events : [];
    const rustEvents = [];
    for (const evt of rows) {
      if (!evt || typeof evt !== 'object') continue;
      rustEvents.push({
        event_type: String(evt.type || ''),
        result: String(evt.result || '')
      });
    }
    const key = rustEvents
      .map((row) => `${row.event_type}\u0000${row.result}`)
      .join('\u0001');
    if (CONSECUTIVE_GATE_EXHAUSTED_ATTEMPTS_CACHE.has(key)) {
      return Number(CONSECUTIVE_GATE_EXHAUSTED_ATTEMPTS_CACHE.get(key) || 0);
    }
    const rust = runBacklogAutoscalePrimitive(
      'consecutive_gate_exhausted_attempts',
      { events: rustEvents },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = Math.max(0, Number(rust.payload.payload.count || 0));
      if (CONSECUTIVE_GATE_EXHAUSTED_ATTEMPTS_CACHE.size >= CONSECUTIVE_GATE_EXHAUSTED_ATTEMPTS_CACHE_MAX) {
        const oldest = CONSECUTIVE_GATE_EXHAUSTED_ATTEMPTS_CACHE.keys().next();
        if (!oldest.done) CONSECUTIVE_GATE_EXHAUSTED_ATTEMPTS_CACHE.delete(oldest.value);
      }
      CONSECUTIVE_GATE_EXHAUSTED_ATTEMPTS_CACHE.set(key, val);
      return val;
    }
  }
  let count = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || e.type !== 'autonomy_run') continue;
    if (!isAttemptRunEvent(e)) continue;
    if (!isGateExhaustedAttempt(e)) break;
    count++;
  }
  return count;
}

function minutesSinceTs(ts) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const tsRaw = String(ts || '');
    const nowMs = Date.now();
    const key = `${tsRaw}\u0000${nowMs}`;
    if (MINUTES_SINCE_TS_CACHE.has(key)) {
      return MINUTES_SINCE_TS_CACHE.get(key);
    }
    const rust = runBacklogAutoscalePrimitive(
      'minutes_since_ts',
      {
        ts: tsRaw,
        now_ms: nowMs
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const rawVal = rust.payload.payload.minutes_since;
      const val = rawVal == null ? null : Number(rawVal);
      if (val == null || Number.isFinite(val)) {
        if (MINUTES_SINCE_TS_CACHE.size >= MINUTES_SINCE_TS_CACHE_MAX) {
          const oldest = MINUTES_SINCE_TS_CACHE.keys().next();
          if (!oldest.done) MINUTES_SINCE_TS_CACHE.delete(oldest.value);
        }
        MINUTES_SINCE_TS_CACHE.set(key, val);
        return val;
      }
    }
  }
  const d = parseIsoTs(ts);
  if (!d) return null;
  return (Date.now() - d.getTime()) / (1000 * 60);
}

function consecutiveNoProgressRuns(events) {
  const rows = Array.isArray(events) ? events : [];
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rustEvents = [];
    for (const evt of rows) {
      if (!evt || typeof evt !== 'object') continue;
      rustEvents.push({
        event_type: String(evt.type || ''),
        result: String(evt.result || ''),
        outcome: String(evt.outcome || '')
      });
    }
    const key = rustEvents
      .map((row) => `${row.event_type}\u0000${row.result}\u0000${row.outcome}`)
      .join('\u0001');
    if (CONSECUTIVE_NO_PROGRESS_RUNS_CACHE.has(key)) {
      return Number(CONSECUTIVE_NO_PROGRESS_RUNS_CACHE.get(key) || 0);
    }
    const rust = runBacklogAutoscalePrimitive(
      'consecutive_no_progress_runs',
      { events: rustEvents },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = Math.max(0, Number(rust.payload.payload.count || 0));
      if (CONSECUTIVE_NO_PROGRESS_RUNS_CACHE.size >= CONSECUTIVE_NO_PROGRESS_RUNS_CACHE_MAX) {
        const oldest = CONSECUTIVE_NO_PROGRESS_RUNS_CACHE.keys().next();
        if (!oldest.done) CONSECUTIVE_NO_PROGRESS_RUNS_CACHE.delete(oldest.value);
      }
      CONSECUTIVE_NO_PROGRESS_RUNS_CACHE.set(key, val);
      return val;
    }
  }
  let count = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const e = rows[i];
    if (!e || e.type !== 'autonomy_run') continue;
    if (e.result === 'executed' && e.outcome === 'shipped') break;
    if (!isNoProgressRun(e)) break;
    count++;
  }
  return count;
}

function shippedCount(events) {
  const rows = Array.isArray(events) ? events : [];
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rustEvents = [];
    for (const evt of rows) {
      if (!evt || typeof evt !== 'object') continue;
      rustEvents.push({
        event_type: String(evt.type || ''),
        result: String(evt.result || ''),
        outcome: String(evt.outcome || '')
      });
    }
    const key = rustEvents
      .map((row) => `${row.event_type}\u0000${row.result}\u0000${row.outcome}`)
      .join('\u0001');
    if (SHIPPED_COUNT_CACHE.has(key)) {
      return Number(SHIPPED_COUNT_CACHE.get(key) || 0);
    }
    const rust = runBacklogAutoscalePrimitive(
      'shipped_count',
      { events: rustEvents },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = Math.max(0, Number(rust.payload.payload.count || 0));
      if (SHIPPED_COUNT_CACHE.size >= SHIPPED_COUNT_CACHE_MAX) {
        const oldest = SHIPPED_COUNT_CACHE.keys().next();
        if (!oldest.done) SHIPPED_COUNT_CACHE.delete(oldest.value);
      }
      SHIPPED_COUNT_CACHE.set(key, val);
      return val;
    }
  }
  return rows.filter((e) => e && e.type === 'autonomy_run' && e.result === 'executed' && e.outcome === 'shipped').length;
}

function executedCountByRisk(events, risk) {
  const rows = Array.isArray(events) ? events : [];
  const target = normalizedRisk(risk);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rustEvents = [];
    for (const evt of rows) {
      if (!evt || typeof evt !== 'object') continue;
      rustEvents.push({
        event_type: String(evt.type || ''),
        result: String(evt.result || ''),
        risk: evt.risk != null ? String(evt.risk || '') : null,
        proposal_risk: evt.proposal_risk != null ? String(evt.proposal_risk || '') : null
      });
    }
    const key = [target].concat(
      rustEvents.map((row) => [
        row.event_type,
        row.result,
        String(row.risk || ''),
        String(row.proposal_risk || '')
      ].join('\u0000'))
    ).join('\u0001');
    if (EXECUTED_COUNT_BY_RISK_CACHE.has(key)) {
      return Number(EXECUTED_COUNT_BY_RISK_CACHE.get(key) || 0);
    }
    const rust = runBacklogAutoscalePrimitive(
      'executed_count_by_risk',
      { events: rustEvents, risk: target },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = Math.max(0, Number(rust.payload.payload.count || 0));
      if (EXECUTED_COUNT_BY_RISK_CACHE.size >= EXECUTED_COUNT_BY_RISK_CACHE_MAX) {
        const oldest = EXECUTED_COUNT_BY_RISK_CACHE.keys().next();
        if (!oldest.done) EXECUTED_COUNT_BY_RISK_CACHE.delete(oldest.value);
      }
      EXECUTED_COUNT_BY_RISK_CACHE.set(key, val);
      return val;
    }
  }
  let count = 0;
  for (const e of rows) {
    if (!e || e.type !== 'autonomy_run' || e.result !== 'executed') continue;
    const runRisk = normalizedRisk((e.risk != null ? e.risk : e.proposal_risk) || '');
    if (runRisk === target) count += 1;
  }
  return count;
}

function tallyByResult(events) {
  const rows = Array.isArray(events) ? events : [];
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rustEvents = [];
    for (const evt of rows) {
      if (!evt || typeof evt !== 'object') continue;
      rustEvents.push({
        event_type: String(evt.type || ''),
        result: String(evt.result || '')
      });
    }
    const key = rustEvents
      .map((row) => `${row.event_type}\u0000${row.result}`)
      .join('\u0001');
    if (RUN_RESULT_TALLY_CACHE.has(key)) {
      const cached = RUN_RESULT_TALLY_CACHE.get(key);
      return cached && typeof cached === 'object' ? { ...cached } : {};
    }
    const rust = runBacklogAutoscalePrimitive(
      'run_result_tally',
      { events: rustEvents },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const src = rust.payload.payload.counts && typeof rust.payload.payload.counts === 'object'
        ? rust.payload.payload.counts
        : {};
      const out = {};
      for (const [result, count] of Object.entries(src)) {
        out[String(result)] = Math.max(0, Number(count || 0));
      }
      if (RUN_RESULT_TALLY_CACHE.size >= RUN_RESULT_TALLY_CACHE_MAX) {
        const oldest = RUN_RESULT_TALLY_CACHE.keys().next();
        if (!oldest.done) RUN_RESULT_TALLY_CACHE.delete(oldest.value);
      }
      RUN_RESULT_TALLY_CACHE.set(key, out);
      return out;
    }
  }
  const out = {};
  for (const e of rows) {
    if (!e || e.type !== 'autonomy_run') continue;
    const k = String(e.result || 'unknown');
    out[k] = Number(out[k] || 0) + 1;
  }
  return out;
}

function sortedCounts(mapObj) {
  const src = mapObj && typeof mapObj === 'object' ? mapObj : {};
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const normalized = {};
    for (const [result, count] of Object.entries(src)) {
      normalized[String(result)] = Number(count || 0);
    }
    const key = Object.keys(normalized)
      .sort()
      .map((result) => `${result}\u0000${String(normalized[result])}`)
      .join('\u0001');
    if (SORTED_COUNTS_CACHE.has(key)) {
      const cached = SORTED_COUNTS_CACHE.get(key);
      return Array.isArray(cached) ? cached.map((row) => ({ ...row })) : [];
    }
    const rust = runBacklogAutoscalePrimitive(
      'sorted_counts',
      { counts: normalized },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const rows = Array.isArray(rust.payload.payload.items)
        ? rust.payload.payload.items.map((row) => ({
          result: String(row && row.result || ''),
          count: Math.max(0, Number(row && row.count || 0))
        }))
        : [];
      if (SORTED_COUNTS_CACHE.size >= SORTED_COUNTS_CACHE_MAX) {
        const oldest = SORTED_COUNTS_CACHE.keys().next();
        if (!oldest.done) SORTED_COUNTS_CACHE.delete(oldest.value);
      }
      SORTED_COUNTS_CACHE.set(key, rows);
      return rows;
    }
  }
  const items = Object.entries(mapObj || {}).map(([result, count]) => ({ result, count: Number(count || 0) }));
  items.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.result.localeCompare(b.result);
  });
  return items;
}

function bumpCount(mapObj, key) {
  if (!mapObj || !key) return;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'bump_count',
      { current_count: Number(mapObj[key] || 0) },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      mapObj[key] = Number(rust.payload.payload.count || 0);
      return;
    }
  }
  mapObj[key] = Number(mapObj[key] || 0) + 1;
}

function scorecardCmd(dateStr) {
  const requestedDays = Number(parseArg('days'));
  const days = clampNumber(
    Number.isFinite(requestedDays) && requestedDays > 0 ? requestedDays : AUTONOMY_SCORECARD_WINDOW_DAYS,
    1,
    30
  );
  const dates = dateWindow(dateStr, days);
  const events = [];
  for (const d of dates) {
    events.push(...readRuns(d));
  }

  const attempts = events.filter(isAttemptRunEvent);
  const executed = events.filter(e => e && e.type === 'autonomy_run' && e.result === 'executed');
  const shipped = executed.filter(e => String(e.outcome || '') === 'shipped');
  const reverted = executed.filter(e => String(e.outcome || '') === 'reverted');
  const noChange = executed.filter(e => String(e.outcome || '') === 'no_change');
  const noProgress = attempts.filter(isNoProgressRun);
  const modelCatalogRuns = events.filter(e => e && e.type === 'autonomy_model_catalog_run');
  const modelCatalogHandoffs = events.filter(e => e && e.type === 'autonomy_model_catalog_handoff');
  const candidateAudits = events.filter(e => e && e.type === 'autonomy_candidate_audit');
  const stopCounts = sortedCounts(
    tallyByResult(events.filter(e => e && e.type === 'autonomy_run' && String(e.result || '').startsWith('stop_')))
  );
  const initGateCounts = sortedCounts(
    tallyByResult(events.filter(e => e && e.type === 'autonomy_run' && (
      String(e.result || '').startsWith('init_gate_') || String(e.result || '').startsWith('stop_init_gate_')
    )))
  );
  const repeatGateCounts = sortedCounts(
    tallyByResult(events.filter(e => e && e.type === 'autonomy_run' && String(e.result || '').startsWith('stop_repeat_gate_')))
  );
  const candidateRejectedByGate = {};
  let candidatePoolTotal = 0;
  let candidateEligibleTotal = 0;
  let candidateRejectedTotal = 0;
  let candidateSelectionTotal = 0;
  for (const evt of candidateAudits) {
    if (!evt || typeof evt !== 'object') continue;
    candidatePoolTotal += Number(evt.pool_size || 0);
    candidateEligibleTotal += Number(evt.eligible_count || 0);
    candidateRejectedTotal += Number(evt.rejected_count || 0);
    if (String(evt.selected_proposal_id || '').trim()) candidateSelectionTotal += 1;
    const byGate = evt.rejected_by_gate && typeof evt.rejected_by_gate === 'object'
      ? evt.rejected_by_gate
      : {};
    for (const [gate, count] of Object.entries(byGate)) {
      candidateRejectedByGate[gate] = Number(candidateRejectedByGate[gate] || 0) + Number(count || 0);
    }
  }
  const candidateEligibleRate = candidatePoolTotal > 0 ? candidateEligibleTotal / candidatePoolTotal : 0;
  const candidateSelectionRate = candidateAudits.length > 0 ? candidateSelectionTotal / candidateAudits.length : 0;

  const attemptsN = attempts.length;
  const executedN = executed.length;
  const shippedN = shipped.length;
  const revertedN = reverted.length;
  const noChangeN = noChange.length;
  const noProgressN = noProgress.length;

  const attemptToShipRate = attemptsN > 0 ? shippedN / attemptsN : 0;
  const execToShipRate = executedN > 0 ? shippedN / executedN : 0;
  const revertedRate = executedN > 0 ? revertedN / executedN : 0;
  const noChangeRate = executedN > 0 ? noChangeN / executedN : 0;
  const noProgressRate = attemptsN > 0 ? noProgressN / attemptsN : 0;

  let recommendation = 'insufficient_data';
  if (attemptsN >= AUTONOMY_SCORECARD_MIN_ATTEMPTS) {
    if (attemptToShipRate >= 0.35 && execToShipRate >= 0.45) recommendation = 'scale_attempts_carefully';
    else if (noProgressRate >= 0.7) recommendation = 'raise_signal_actionability_quality';
    else if (revertedRate >= 0.2) recommendation = 'tighten_preflight_and_safety';
    else recommendation = 'focus_on_gate_bottleneck_reduction';
  }

  const out = {
    ts: nowIso(),
    date: dateStr,
    window_days: days,
    window_start: dates.length ? dates[dates.length - 1] : dateStr,
    window_end: dates.length ? dates[0] : dateStr,
    sample_size: {
      attempts: attemptsN,
      executed: executedN,
      shipped: shippedN
    },
    kpis: {
      attempt_to_ship_rate: Number(attemptToShipRate.toFixed(3)),
      executed_to_ship_rate: Number(execToShipRate.toFixed(3)),
      reverted_rate: Number(revertedRate.toFixed(3)),
      no_change_rate: Number(noChangeRate.toFixed(3)),
      no_progress_attempt_rate: Number(noProgressRate.toFixed(3))
    },
    top_stops: stopCounts.slice(0, 10),
    top_init_gates: initGateCounts.slice(0, 10),
    top_repeat_gates: repeatGateCounts.slice(0, 10),
    candidate_funnel: {
      audit_events: candidateAudits.length,
      pool_total: candidatePoolTotal,
      eligible_total: candidateEligibleTotal,
      rejected_total: candidateRejectedTotal,
      selected_runs: candidateSelectionTotal,
      no_selection_runs: Math.max(0, candidateAudits.length - candidateSelectionTotal),
      eligible_rate: Number(candidateEligibleRate.toFixed(3)),
      selection_rate: Number(candidateSelectionRate.toFixed(3)),
      top_reject_gates: sortedCounts(candidateRejectedByGate).slice(0, 10)
    },
    dominant_bottleneck: stopCounts.length ? stopCounts[0] : null,
    recommendation,
    model_catalog: {
      runs: modelCatalogRuns.length,
      proposals_ok: modelCatalogRuns.filter(e => e.step === 'propose' && e.result === 'ok').length,
      trials_ok: modelCatalogRuns.filter(e => e.step === 'trial' && e.result === 'ok').length,
      apply_pending: modelCatalogHandoffs.filter(e => e.result === 'apply_pending').length
    }
  };

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function loadDopamineSnapshot(dateStr) {
  const state = loadJson(DOPAMINE_STATE_PATH, {});
  const dayLog = loadJson(path.join(DAILY_LOGS_DIR, `${dateStr}.json`), null);

  const lastScore = Number(state && state.last_score != null ? state.last_score : 0);
  const avg7 = Number(state && state.rolling_7_day_avg != null ? state.rolling_7_day_avg : 0);
  const streakDays = Number(state && state.current_streak_days != null ? state.current_streak_days : 0);
  const entries = Array.isArray(dayLog && dayLog.entries) ? dayLog.entries : [];
  const revenueActions = Array.isArray(dayLog && dayLog.revenue_actions) ? dayLog.revenue_actions : [];
  const verifiedObjectiveEntries = entries.filter((entry) => hasLinkedObjectiveEntry(entry) && isVerifiedEntryOutcome(entry)).length;
  const linkedEntries = entries.filter((entry) => hasLinkedObjectiveEntry(entry)).length;
  const unlinkedEntries = Math.max(0, entries.length - linkedEntries);
  const verifiedRevenueActions = revenueActions.filter(isVerifiedRevenueAction).length;
  const dayArtifacts = Array.isArray(dayLog && dayLog.artifacts) ? dayLog.artifacts.length : 0;
  const dayEntries = Array.isArray(dayLog && dayLog.entries) ? dayLog.entries.length : 0;
  const daySwitches = Number(dayLog && dayLog.context_switches != null ? dayLog.context_switches : 0);
  const dayRevenueActions = Array.isArray(dayLog && dayLog.revenue_actions) ? dayLog.revenue_actions.length : 0;
  const baseMomentumOk = (lastScore >= AUTONOMY_MIN_DOPAMINE_LAST_SCORE) || (avg7 >= AUTONOMY_MIN_DOPAMINE_AVG7);
  const verifiedProgressToday = verifiedObjectiveEntries > 0 || verifiedRevenueActions > 0;
  const momentumOk = AUTONOMY_DOPAMINE_REQUIRE_VERIFIED_PROGRESS
    ? (baseMomentumOk && (verifiedProgressToday || dayEntries === 0))
    : baseMomentumOk;
  const directivePainActive = AUTONOMY_DOPAMINE_REQUIRE_VERIFIED_PROGRESS
    ? (dayEntries > 0 && !verifiedProgressToday)
    : false;

  return {
    last_score: lastScore,
    avg7,
    streak_days: streakDays,
    day_artifacts: dayArtifacts,
    day_entries: dayEntries,
    day_context_switches: daySwitches,
    day_revenue_actions: dayRevenueActions,
    verified_objective_entries: verifiedObjectiveEntries,
    verified_revenue_actions: verifiedRevenueActions,
    linked_entries: linkedEntries,
    unlinked_entries: unlinkedEntries,
    verified_progress_today: verifiedProgressToday,
    directive_pain_active: directivePainActive,
    momentum_ok: momentumOk
  };
}

function loadDailyEvidenceSnapshot(dateStr) {
  const dayLog = loadJson(path.join(DAILY_LOGS_DIR, `${dateStr}.json`), null);
  const artifacts = Array.isArray(dayLog && dayLog.artifacts) ? dayLog.artifacts.length : 0;
  const entries = Array.isArray(dayLog && dayLog.entries) ? dayLog.entries.length : 0;
  const revenueActions = Array.isArray(dayLog && dayLog.revenue_actions) ? dayLog.revenue_actions.length : 0;
  return { artifacts, entries, revenue_actions: revenueActions };
}

function loadRegistryEvidenceSnapshot() {
  const reg = loadJson(HABIT_REGISTRY_PATH, { habits: [] });
  const habits = Array.isArray(reg && reg.habits) ? reg.habits : [];
  let active = 0;
  let candidate = 0;
  for (const h of habits) {
    const state = String((h && h.governance && h.governance.state) || h.status || '').toLowerCase();
    if (state === 'active') active++;
    if (state === 'candidate') candidate++;
  }
  return { total: habits.length, active, candidate };
}

function loadHabitLogsSnapshot() {
  const runs = readJsonl(HABIT_RUNS_LOG_PATH);
  const errors = readJsonl(HABIT_ERRORS_LOG_PATH);
  return {
    run_len: runs.length,
    error_len: errors.length,
    runs,
    errors
  };
}

function loadDoDEvidenceSnapshot(dateStr) {
  return {
    daily: loadDailyEvidenceSnapshot(dateStr),
    registry: loadRegistryEvidenceSnapshot(),
    logs: loadHabitLogsSnapshot()
  };
}

function diffDoDEvidence(before, after) {
  const b = before || { daily: {}, registry: {}, logs: {} };
  const a = after || { daily: {}, registry: {}, logs: {} };
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'dod_evidence_diff',
      {
        before_artifacts: Number((b.daily && b.daily.artifacts) || 0),
        before_entries: Number((b.daily && b.daily.entries) || 0),
        before_revenue_actions: Number((b.daily && b.daily.revenue_actions) || 0),
        before_registry_total: Number((b.registry && b.registry.total) || 0),
        before_registry_active: Number((b.registry && b.registry.active) || 0),
        before_registry_candidate: Number((b.registry && b.registry.candidate) || 0),
        before_habit_runs: Number((b.logs && b.logs.run_len) || 0),
        before_habit_errors: Number((b.logs && b.logs.error_len) || 0),
        after_artifacts: Number((a.daily && a.daily.artifacts) || 0),
        after_entries: Number((a.daily && a.daily.entries) || 0),
        after_revenue_actions: Number((a.daily && a.daily.revenue_actions) || 0),
        after_registry_total: Number((a.registry && a.registry.total) || 0),
        after_registry_active: Number((a.registry && a.registry.active) || 0),
        after_registry_candidate: Number((a.registry && a.registry.candidate) || 0),
        after_habit_runs: Number((a.logs && a.logs.run_len) || 0),
        after_habit_errors: Number((a.logs && a.logs.error_len) || 0)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }

  return {
    artifacts_delta: Number((a.daily && a.daily.artifacts) || 0) - Number((b.daily && b.daily.artifacts) || 0),
    entries_delta: Number((a.daily && a.daily.entries) || 0) - Number((b.daily && b.daily.entries) || 0),
    revenue_actions_delta: Number((a.daily && a.daily.revenue_actions) || 0) - Number((b.daily && b.daily.revenue_actions) || 0),
    registry_total_delta: Number((a.registry && a.registry.total) || 0) - Number((b.registry && b.registry.total) || 0),
    registry_active_delta: Number((a.registry && a.registry.active) || 0) - Number((b.registry && b.registry.active) || 0),
    registry_candidate_delta: Number((a.registry && a.registry.candidate) || 0) - Number((b.registry && b.registry.candidate) || 0),
    habit_runs_delta: Number((a.logs && a.logs.run_len) || 0) - Number((b.logs && b.logs.run_len) || 0),
    habit_errors_delta: Number((a.logs && a.logs.error_len) || 0) - Number((b.logs && b.logs.error_len) || 0)
  };
}

function inExecWindow(ts, window) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const d = parseIsoTs(ts);
    if (!d || !window) return false;
    const s = Number(window.start_ms || 0) - AUTONOMY_DOD_EXEC_WINDOW_SLOP_MS;
    const e = Number(window.end_ms || 0) + AUTONOMY_DOD_EXEC_WINDOW_SLOP_MS;
    if (!s || !e) return false;
    const rust = runBacklogAutoscalePrimitive(
      'exec_window_match',
      {
        ts_ms: d.getTime(),
        start_ms: s,
        end_ms: e
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.in_window === true;
    }
  }

  const d = parseIsoTs(ts);
  if (!d || !window) return false;
  const s = Number(window.start_ms || 0) - AUTONOMY_DOD_EXEC_WINDOW_SLOP_MS;
  const e = Number(window.end_ms || 0) + AUTONOMY_DOD_EXEC_WINDOW_SLOP_MS;
  if (!s || !e) return false;
  const t = d.getTime();
  return t >= s && t <= e;
}

function newLogEvents(beforeEvidence, afterEvidence) {
  const b = beforeEvidence && beforeEvidence.logs ? beforeEvidence.logs : { run_len: 0, error_len: 0 };
  const a = afterEvidence && afterEvidence.logs ? afterEvidence.logs : { runs: [], errors: [] };
  const runStart = Number(b.run_len || 0);
  const errStart = Number(b.error_len || 0);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'new_log_events',
      {
        before_run_len: runStart,
        before_error_len: errStart,
        after_runs: Array.isArray(a.runs) ? a.runs : [],
        after_errors: Array.isArray(a.errors) ? a.errors : []
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return {
        runs: Array.isArray(rust.payload.payload.runs) ? rust.payload.payload.runs : [],
        errors: Array.isArray(rust.payload.payload.errors) ? rust.payload.payload.errors : []
      };
    }
  }
  return {
    runs: Array.isArray(a.runs) ? a.runs.slice(runStart) : [],
    errors: Array.isArray(a.errors) ? a.errors.slice(errStart) : []
  };
}

function evaluateDoD({ summary, execRes, beforeEvidence, afterEvidence, execWindow }) {
  const diff = diffDoDEvidence(beforeEvidence, afterEvidence);
  const decision = String(summary && summary.decision || '');
  const logs = newLogEvents(beforeEvidence, afterEvidence);

  if (!execRes || execRes.ok !== true) {
    return {
      passed: false,
      class: 'execution_failed',
      reason: `exec_failed_code_${execRes ? execRes.code : 'unknown'}`,
      diff
    };
  }

  const hasArtifactSignal = diff.artifacts_delta >= AUTONOMY_DOD_MIN_ARTIFACT_DELTA;
  const hasEntrySignal = diff.entries_delta >= AUTONOMY_DOD_MIN_ENTRY_DELTA;
  const hasRevenueSignal = diff.revenue_actions_delta >= AUTONOMY_DOD_MIN_REVENUE_DELTA;
  const hasImpactSignal = hasArtifactSignal || hasEntrySignal || hasRevenueSignal;

  if (decision === 'RUN_HABIT' || decision === 'RUN_CANDIDATE_FOR_VERIFICATION') {
    const habitId = String(summary && summary.suggested_habit_id || '').trim();
    const runsInWindow = logs.runs.filter(r => inExecWindow(r.ts, execWindow));
    const errorsInWindow = logs.errors.filter(e => inExecWindow(e.ts, execWindow));
    const relevantRuns = habitId ? runsInWindow.filter(r => String(r.habit_id || '') === habitId) : runsInWindow;
    const relevantErrors = habitId ? errorsInWindow.filter(e => String(e.habit_id || '') === habitId) : errorsInWindow;
    const securityError = relevantErrors.find(e => String(e.error || '').includes('PERMISSION_DENIED') || String(e.error || '').includes('HASH_MISMATCH'));

    if (securityError) {
      return {
        passed: false,
        class: 'habit_security_violation',
        reason: 'habit_error_permission_or_hash',
        diff,
        evidence: {
          habit_id: habitId || null,
          habit_runs_window: relevantRuns.length,
          habit_errors_window: relevantErrors.length
        }
      };
    }

    const successfulRuns = relevantRuns.filter(r => String(r.status || '') === 'success');
    const scoredRuns = successfulRuns.filter(r => Number.isFinite(Number(r.outcome_score)));
    const hasPassingScoredRun = scoredRuns.some(r => Number(r.outcome_score) >= AUTONOMY_DOD_MIN_HABIT_OUTCOME_SCORE);
    const hasSuccessRun = successfulRuns.length > 0;

    if (hasPassingScoredRun) {
      return {
        passed: true,
        class: 'habit_log_verified',
        reason: `habit_run_with_outcome_score>=${AUTONOMY_DOD_MIN_HABIT_OUTCOME_SCORE}`,
        diff,
        evidence: {
          habit_id: habitId || null,
          habit_runs_window: relevantRuns.length,
          habit_success_window: successfulRuns.length
        }
      };
    }

    if (hasSuccessRun && hasImpactSignal) {
      return {
        passed: true,
        class: 'habit_success_plus_impact_delta',
        reason: 'habit_run_success_and_impact_signal',
        diff,
        evidence: {
          habit_id: habitId || null,
          habit_runs_window: relevantRuns.length,
          habit_success_window: successfulRuns.length
        }
      };
    }

    if (hasSuccessRun) {
      return {
        passed: false,
        class: 'habit_success_missing_impact_signal',
        reason: 'habit_run_success_without_score_or_delta',
        diff,
        evidence: {
          habit_id: habitId || null,
          habit_runs_window: relevantRuns.length,
          habit_success_window: successfulRuns.length
        }
      };
    }

    if (!habitId && hasImpactSignal) {
      return {
        passed: true,
        class: 'impact_signal',
        reason: 'impact_signal_without_habit_log_binding',
        diff,
        evidence: {
          habit_id: habitId || null,
          habit_runs_window: relevantRuns.length,
          habit_errors_window: relevantErrors.length
        }
      };
    }

    return {
      passed: false,
      class: 'missing_habit_run_signal',
      reason: habitId ? 'no_habit_run_log_for_suggested_habit' : 'no_habit_run_log_or_impact_signal',
      diff,
      evidence: {
        habit_id: habitId || null,
        habit_runs_window: relevantRuns.length,
        habit_errors_window: relevantErrors.length
      }
    };
  }

  if (decision === 'PROPOSE_HABIT') {
    if (!AUTONOMY_DOD_ALLOW_PROPOSE_SHIPPED) {
      return {
        passed: false,
        class: 'proposal_only',
        reason: 'propose_habit_not_counted_as_shipped',
        diff
      };
    }
    if (diff.registry_candidate_delta >= 1 || diff.registry_total_delta >= 1) {
      return { passed: true, class: 'proposal_growth_signal', reason: 'habit_registry_growth', diff };
    }
    return {
      passed: false,
      class: 'proposal_no_growth',
      reason: 'propose_habit_without_registry_growth',
      diff
    };
  }

  if (decision === 'ACTUATE') {
    const verified = !!(summary && summary.verified === true);
    if (verified) {
      return {
        passed: true,
        class: 'actuation_verified',
        reason: `adapter_${String(summary.adapter || 'unknown')}_verified`,
        diff
      };
    }
    if (hasImpactSignal) {
      return {
        passed: true,
        class: 'actuation_with_impact_signal',
        reason: `adapter_${String(summary && summary.adapter || 'unknown')}_impact_signal`,
        diff
      };
    }
    return {
      passed: false,
      class: 'actuation_unverified',
      reason: `adapter_${String(summary && summary.adapter || 'unknown')}_unverified`,
      diff
    };
  }

  if (decision === 'MANUAL' || decision === 'DENY') {
    return {
      passed: false,
      class: 'manual_or_denied',
      reason: `decision_${decision.toLowerCase()}`,
      diff
    };
  }

  return {
    passed: false,
    class: 'unknown_decision',
    reason: decision ? `decision_${decision.toLowerCase()}` : 'missing_decision',
    diff
  };
}

function dateWindow(endDateStr, days) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const safeEndDateStr = String(endDateStr || '').trim();
    const safeDays = Number(days);
    const key = `${safeEndDateStr}\u0000${safeDays}`;
    if (DATE_WINDOW_CACHE.has(key)) {
      const cached = DATE_WINDOW_CACHE.get(key);
      return Array.isArray(cached) ? cached.slice() : [];
    }
    const rust = runBacklogAutoscalePrimitive(
      'date_window',
      {
        end_date_str: safeEndDateStr,
        days: safeDays
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const dates = Array.isArray(rust.payload.payload.dates)
        ? rust.payload.payload.dates.map((d) => String(d || '')).filter(Boolean)
        : [];
      if (DATE_WINDOW_CACHE.size >= DATE_WINDOW_CACHE_MAX) {
        const oldest = DATE_WINDOW_CACHE.keys().next();
        if (!oldest.done) DATE_WINDOW_CACHE.delete(oldest.value);
      }
      DATE_WINDOW_CACHE.set(key, dates.slice());
      return dates;
    }
  }
  const out = [];
  const end = new Date(`${endDateStr}T00:00:00.000Z`);
  if (isNaN(end.getTime())) return out;
  for (let i = 0; i < days; i++) {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function startOfNextUtcDay(dateStr) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const safeDateStr = String(dateStr || '').trim();
    if (START_OF_NEXT_UTC_DAY_CACHE.has(safeDateStr)) {
      return START_OF_NEXT_UTC_DAY_CACHE.get(safeDateStr);
    }
    const rust = runBacklogAutoscalePrimitive(
      'start_of_next_utc_day',
      { date_str: safeDateStr },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const raw = rust.payload.payload.iso_ts;
      const val = raw == null ? null : String(raw || '').trim();
      const normalized = val || null;
      if (START_OF_NEXT_UTC_DAY_CACHE.size >= START_OF_NEXT_UTC_DAY_CACHE_MAX) {
        const oldest = START_OF_NEXT_UTC_DAY_CACHE.keys().next();
        if (!oldest.done) START_OF_NEXT_UTC_DAY_CACHE.delete(oldest.value);
      }
      START_OF_NEXT_UTC_DAY_CACHE.set(safeDateStr, normalized);
      return normalized;
    }
  }
  const base = new Date(`${String(dateStr || '')}T00:00:00.000Z`);
  if (isNaN(base.getTime())) return null;
  base.setUTCDate(base.getUTCDate() + 1);
  return base.toISOString();
}

function isoAfterMinutes(minutes) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const safeMinutes = Number(minutes);
    const nowMs = Date.now();
    const key = `${safeMinutes}\u0000${nowMs}`;
    if (ISO_AFTER_MINUTES_CACHE.has(key)) {
      return ISO_AFTER_MINUTES_CACHE.get(key);
    }
    const rust = runBacklogAutoscalePrimitive(
      'iso_after_minutes',
      {
        minutes: safeMinutes,
        now_ms: nowMs
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const raw = rust.payload.payload.iso_ts;
      const val = raw == null ? null : String(raw || '').trim();
      const normalized = val || null;
      if (ISO_AFTER_MINUTES_CACHE.size >= ISO_AFTER_MINUTES_CACHE_MAX) {
        const oldest = ISO_AFTER_MINUTES_CACHE.keys().next();
        if (!oldest.done) ISO_AFTER_MINUTES_CACHE.delete(oldest.value);
      }
      ISO_AFTER_MINUTES_CACHE.set(key, normalized);
      return normalized;
    }
  }
  const n = Number(minutes);
  if (!Number.isFinite(n)) return null;
  const ms = Date.now() + Math.max(0, n) * 60 * 1000;
  return new Date(ms).toISOString();
}

function admissionSummaryFromProposals(proposals) {
  const arr = Array.isArray(proposals) ? proposals : [];
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'admission_summary',
      {
        proposals: arr.map((p) => {
          const preview = p && p.meta && p.meta.admission_preview && typeof p.meta.admission_preview === 'object'
            ? p.meta.admission_preview
            : null;
          const reasons = Array.isArray(preview && preview.blocked_by)
            ? preview.blocked_by
            : [];
          return {
            preview_eligible: preview ? preview.eligible !== false : true,
            blocked_by: reasons.map((r) => String(r == null ? '' : r))
          };
        })
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  const out = {
    total: arr.length,
    eligible: 0,
    blocked: 0,
    blocked_by_reason: {}
  };
  for (const p of arr) {
    const preview = p && p.meta && p.meta.admission_preview && typeof p.meta.admission_preview === 'object'
      ? p.meta.admission_preview
      : null;
    const eligible = !preview || preview.eligible !== false;
    if (eligible) {
      out.eligible += 1;
      continue;
    }
    out.blocked += 1;
    const reasons = Array.isArray(preview.blocked_by) && preview.blocked_by.length
      ? preview.blocked_by
      : ['unknown'];
    for (const r of reasons) {
      const key = String(r || 'unknown').trim() || 'unknown';
      out.blocked_by_reason[key] = Number(out.blocked_by_reason[key] || 0) + 1;
    }
  }
  return out;
}

function sourceEyeId(p) {
  const eyeRef = sourceEyeRef(p);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'source_eye_id',
      { eye_ref: eyeRef == null ? null : String(eyeRef) },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return String(rust.payload.payload.eye_id || '');
    }
  }
  return eyeRef.replace(/^eye:/, '');
}

function isDeprioritizedSourceProposal(p) {
  const eyeId = String(sourceEyeId(p) || '').trim().toLowerCase();
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'deprioritized_source_proposal',
      {
        eye_id: eyeId || null,
        deprioritized_eye_ids: Array.from(AUTONOMY_DEPRIORITIZED_SOURCE_EYES || [])
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.deprioritized === true;
    }
  }
  if (!eyeId) return false;
  return AUTONOMY_DEPRIORITIZED_SOURCE_EYES.has(eyeId);
}

function proposalUnknownTypeQuarantineDecision(proposal, objectiveBinding = null) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const type = String(p.type || '').trim().toLowerCase();
  const binding = objectiveBinding && typeof objectiveBinding === 'object' ? objectiveBinding : {};
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  const objectiveId = sanitizeDirectiveObjectiveId(
    binding.objective_id
    || meta.objective_id
    || meta.directive_objective_id
    || ''
  );
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'unknown_type_quarantine_decision',
      {
        enabled: AUTONOMY_UNKNOWN_TYPE_QUARANTINE_ENABLED === true,
        proposal_type: type || null,
        type_in_quarantine_set: !!(type && AUTONOMY_UNKNOWN_TYPE_QUARANTINE_TYPES.has(type)),
        allow_directive: AUTONOMY_UNKNOWN_TYPE_QUARANTINE_ALLOW_DIRECTIVE === true,
        allow_tier1: AUTONOMY_UNKNOWN_TYPE_QUARANTINE_ALLOW_TIER1 === true,
        objective_id: objectiveId || null,
        tier1_objective: isTier1ObjectiveId(objectiveId)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  if (!AUTONOMY_UNKNOWN_TYPE_QUARANTINE_ENABLED) {
    return { block: false, proposal_type: type || null, reason: null };
  }
  if (!type || !AUTONOMY_UNKNOWN_TYPE_QUARANTINE_TYPES.has(type)) {
    return { block: false, proposal_type: type || null, reason: null };
  }
  if (
    AUTONOMY_UNKNOWN_TYPE_QUARANTINE_ALLOW_DIRECTIVE
    && (type === 'directive_clarification' || type === 'directive_decomposition')
  ) {
    return { block: false, proposal_type: type, reason: 'directive_exempt' };
  }
  if (AUTONOMY_UNKNOWN_TYPE_QUARANTINE_ALLOW_TIER1 && isTier1ObjectiveId(objectiveId)) {
    return {
      block: false,
      proposal_type: type,
      reason: 'tier1_objective_exempt',
      objective_id: objectiveId
    };
  }
  return {
    block: true,
    proposal_type: type,
    reason: 'unknown_type_quarantine',
    objective_id: objectiveId || null
  };
}

function baseThresholds(strategyOverride = null) {
  const base = {
    min_signal_quality: AUTONOMY_MIN_SIGNAL_QUALITY,
    min_sensory_signal_score: AUTONOMY_MIN_SENSORY_SIGNAL_SCORE,
    min_sensory_relevance_score: AUTONOMY_MIN_SENSORY_RELEVANCE_SCORE,
    min_directive_fit: AUTONOMY_MIN_DIRECTIVE_FIT,
    min_actionability_score: AUTONOMY_MIN_ACTIONABILITY_SCORE,
    min_eye_score_ema: AUTONOMY_MIN_EYE_SCORE_EMA
  };
  const strategy = strategyOverride || strategyProfile();
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const overrides = strategy && strategy.threshold_overrides && typeof strategy.threshold_overrides === 'object'
      ? strategy.threshold_overrides
      : {};
    const rust = runBacklogAutoscalePrimitive(
      'strategy_threshold_overrides',
      {
        min_signal_quality: Number(base.min_signal_quality || 0),
        min_sensory_signal_score: Number(base.min_sensory_signal_score || 0),
        min_sensory_relevance_score: Number(base.min_sensory_relevance_score || 0),
        min_directive_fit: Number(base.min_directive_fit || 0),
        min_actionability_score: Number(base.min_actionability_score || 0),
        min_eye_score_ema: Number(base.min_eye_score_ema || 0),
        override_min_signal_quality: Number(overrides.min_signal_quality),
        override_min_sensory_signal_score: Number(overrides.min_sensory_signal_score),
        override_min_sensory_relevance_score: Number(overrides.min_sensory_relevance_score),
        override_min_directive_fit: Number(overrides.min_directive_fit),
        override_min_actionability_score: Number(overrides.min_actionability_score),
        override_min_eye_score_ema: Number(overrides.min_eye_score_ema)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  return applyThresholdOverrides(base, strategy);
}

function effectiveAllowedRisksSet(strategyOverride = null) {
  const strategy = strategyOverride || strategyProfile();
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const allowed = strategy
      && strategy.risk_policy
      && Array.isArray(strategy.risk_policy.allowed_risks)
        ? strategy.risk_policy.allowed_risks
        : [];
    const rust = runBacklogAutoscalePrimitive(
      'effective_allowed_risks',
      {
        default_risks: Array.from(AUTONOMY_ALLOWED_RISKS || []),
        strategy_allowed_risks: allowed.map((x) => String(x || ''))
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return new Set(
        Array.isArray(rust.payload.payload.risks)
          ? rust.payload.payload.risks.map((x) => String(x || '')).filter(Boolean)
          : []
      );
    }
  }
  return effectiveAllowedRisks(AUTONOMY_ALLOWED_RISKS, strategy);
}

function mediumRiskThresholds(baseThresholdsObj) {
  const base = baseThresholdsObj && typeof baseThresholdsObj === 'object'
    ? baseThresholdsObj
    : baseThresholds();
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'medium_risk_thresholds',
      {
        base_min_directive_fit: Number(base.min_directive_fit),
        base_min_actionability_score: Number(base.min_actionability_score),
        medium_risk_min_composite_eligibility: Number(AUTONOMY_MEDIUM_RISK_MIN_COMPOSITE_ELIGIBILITY || 0),
        min_composite_eligibility: Number(AUTONOMY_MIN_COMPOSITE_ELIGIBILITY || 0),
        medium_risk_min_directive_fit: Number(AUTONOMY_MEDIUM_RISK_MIN_DIRECTIVE_FIT || 0),
        default_min_directive_fit: Number(AUTONOMY_MIN_DIRECTIVE_FIT || 0),
        medium_risk_min_actionability: Number(AUTONOMY_MEDIUM_RISK_MIN_ACTIONABILITY || 0),
        default_min_actionability: Number(AUTONOMY_MIN_ACTIONABILITY_SCORE || 0)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  return {
    composite_min: Math.max(
      AUTONOMY_MEDIUM_RISK_MIN_COMPOSITE_ELIGIBILITY,
      AUTONOMY_MIN_COMPOSITE_ELIGIBILITY + 6
    ),
    directive_fit_min: Math.max(
      AUTONOMY_MEDIUM_RISK_MIN_DIRECTIVE_FIT,
      Number(base.min_directive_fit || AUTONOMY_MIN_DIRECTIVE_FIT) + 5
    ),
    actionability_min: Math.max(
      AUTONOMY_MEDIUM_RISK_MIN_ACTIONABILITY,
      Number(base.min_actionability_score || AUTONOMY_MIN_ACTIONABILITY_SCORE) + 6
    )
  };
}

function compositeEligibilityMin(risk, executionMode) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'composite_eligibility_min',
      {
        risk: risk == null ? null : String(risk),
        execution_mode: executionMode == null ? null : String(executionMode),
        base_min: Number(AUTONOMY_MIN_COMPOSITE_ELIGIBILITY),
        canary_low_risk_relax: Number(AUTONOMY_CANARY_LOW_RISK_COMPOSITE_RELAX || 0)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Number(rust.payload.payload.min_score || 0);
    }
  }
  const normalized = normalizedRisk(risk);
  const baseMin = AUTONOMY_MIN_COMPOSITE_ELIGIBILITY;
  if (normalized !== 'low' || executionMode !== 'canary_execute') return baseMin;
  const relax = Math.max(0, Number(AUTONOMY_CANARY_LOW_RISK_COMPOSITE_RELAX || 0));
  return Math.max(55, baseMin - relax);
}

function mediumRiskGateDecision(proposal, directiveFitScore, actionabilityScore, compositeScore, baseThresholdsObj) {
  const risk = normalizedRisk(proposal && proposal.risk);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const required = mediumRiskThresholds(baseThresholdsObj);
    const rust = runBacklogAutoscalePrimitive(
      'medium_risk_gate_decision',
      {
        risk,
        composite_score: Number(compositeScore || 0),
        directive_fit_score: Number(directiveFitScore || 0),
        actionability_score: Number(actionabilityScore || 0),
        composite_min: Number(required.composite_min || 0),
        directive_fit_min: Number(required.directive_fit_min || 0),
        actionability_min: Number(required.actionability_min || 0)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  if (risk !== 'medium') {
    return {
      pass: true,
      risk,
      reasons: [],
      required: null
    };
  }

  const required = mediumRiskThresholds(baseThresholdsObj);
  const reasons = [];
  if (Number(compositeScore || 0) < Number(required.composite_min || 0)) reasons.push('medium_composite_low');
  if (Number(directiveFitScore || 0) < Number(required.directive_fit_min || 0)) reasons.push('medium_directive_fit_low');
  if (Number(actionabilityScore || 0) < Number(required.actionability_min || 0)) reasons.push('medium_actionability_low');
  return {
    pass: reasons.length === 0,
    risk,
    reasons,
    required
  };
}

function clampThreshold(name, n) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'clamp_threshold',
      {
        name: name == null ? null : String(name),
        value: Number(n)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Number(rust.payload.payload.threshold || 0);
    }
  }
  const x = Number(n);
  const ranges = {
    min_signal_quality: [40, 90],
    min_sensory_signal_score: [35, 85],
    min_sensory_relevance_score: [35, 85],
    min_directive_fit: [25, 90],
    min_actionability_score: [30, 90],
    min_eye_score_ema: [30, 90]
  };
  const r = ranges[name] || [0, 100];
  return clampNumber(Math.round(Number.isFinite(x) ? x : 0), r[0], r[1]);
}

function appliedThresholds(base, deltas) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const bObj = base || baseThresholds();
    const dObj = deltas || {};
    const rust = runBacklogAutoscalePrimitive(
      'applied_thresholds',
      {
        base: {
          min_signal_quality: Number(bObj.min_signal_quality || 0),
          min_sensory_signal_score: Number(bObj.min_sensory_signal_score || 0),
          min_sensory_relevance_score: Number(bObj.min_sensory_relevance_score || 0),
          min_directive_fit: Number(bObj.min_directive_fit || 0),
          min_actionability_score: Number(bObj.min_actionability_score || 0),
          min_eye_score_ema: Number(bObj.min_eye_score_ema || 0)
        },
        deltas: {
          min_signal_quality: Number(dObj.min_signal_quality || 0),
          min_sensory_signal_score: Number(dObj.min_sensory_signal_score || 0),
          min_sensory_relevance_score: Number(dObj.min_sensory_relevance_score || 0),
          min_directive_fit: Number(dObj.min_directive_fit || 0),
          min_actionability_score: Number(dObj.min_actionability_score || 0),
          min_eye_score_ema: Number(dObj.min_eye_score_ema || 0)
        }
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const t = rust.payload.payload.thresholds && typeof rust.payload.payload.thresholds === 'object'
        ? rust.payload.payload.thresholds
        : {};
      return {
        min_signal_quality: Number(t.min_signal_quality || 0),
        min_sensory_signal_score: Number(t.min_sensory_signal_score || 0),
        min_sensory_relevance_score: Number(t.min_sensory_relevance_score || 0),
        min_directive_fit: Number(t.min_directive_fit || 0),
        min_actionability_score: Number(t.min_actionability_score || 0),
        min_eye_score_ema: Number(t.min_eye_score_ema || 0)
      };
    }
  }
  const b = base || baseThresholds();
  const d = deltas || {};
  return {
    min_signal_quality: clampThreshold('min_signal_quality', b.min_signal_quality + Number(d.min_signal_quality || 0)),
    min_sensory_signal_score: clampThreshold('min_sensory_signal_score', b.min_sensory_signal_score + Number(d.min_sensory_signal_score || 0)),
    min_sensory_relevance_score: clampThreshold('min_sensory_relevance_score', b.min_sensory_relevance_score + Number(d.min_sensory_relevance_score || 0)),
    min_directive_fit: clampThreshold('min_directive_fit', b.min_directive_fit + Number(d.min_directive_fit || 0)),
    min_actionability_score: clampThreshold('min_actionability_score', b.min_actionability_score + Number(d.min_actionability_score || 0)),
    min_eye_score_ema: clampThreshold('min_eye_score_ema', b.min_eye_score_ema + Number(d.min_eye_score_ema || 0))
  };
}

function thresholdsForProposalType(baseThresholdsObj, proposalType, policy) {
  const base = baseThresholdsObj && typeof baseThresholdsObj === 'object'
    ? baseThresholdsObj
    : baseThresholds();
  const offsets = proposalTypeThresholdOffsetsFor(policy || outcomeFitnessPolicy(), proposalType);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'applied_thresholds',
      {
        base: {
          min_signal_quality: Number(base.min_signal_quality || 0),
          min_sensory_signal_score: Number(base.min_sensory_signal_score || 0),
          min_sensory_relevance_score: Number(base.min_sensory_relevance_score || 0),
          min_directive_fit: Number(base.min_directive_fit || 0),
          min_actionability_score: Number(base.min_actionability_score || 0),
          min_eye_score_ema: Number(base.min_eye_score_ema || 0)
        },
        deltas: {
          min_signal_quality: Number(offsets && offsets.min_signal_quality || 0),
          min_sensory_signal_score: Number(offsets && offsets.min_sensory_signal_score || 0),
          min_sensory_relevance_score: Number(offsets && offsets.min_sensory_relevance_score || 0),
          min_directive_fit: Number(offsets && offsets.min_directive_fit || 0),
          min_actionability_score: Number(offsets && offsets.min_actionability_score || 0),
          min_eye_score_ema: Number(offsets && offsets.min_eye_score_ema || 0)
        }
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const t = rust.payload.payload.thresholds && typeof rust.payload.payload.thresholds === 'object'
        ? rust.payload.payload.thresholds
        : {};
      return {
        thresholds: {
          min_signal_quality: Number(t.min_signal_quality || 0),
          min_sensory_signal_score: Number(t.min_sensory_signal_score || 0),
          min_sensory_relevance_score: Number(t.min_sensory_relevance_score || 0),
          min_directive_fit: Number(t.min_directive_fit || 0),
          min_actionability_score: Number(t.min_actionability_score || 0),
          min_eye_score_ema: Number(t.min_eye_score_ema || 0)
        },
        offsets
      };
    }
  }
  const next = { ...base };
  for (const [key, deltaRaw] of Object.entries(offsets || {})) {
    if (!Object.prototype.hasOwnProperty.call(base, key)) continue;
    const baseVal = Number(base[key]);
    if (!Number.isFinite(baseVal)) continue;
    const delta = Number(deltaRaw || 0);
    next[key] = clampThreshold(key, baseVal + delta);
  }
  return {
    thresholds: next,
    offsets
  };
}

function extractEyeFromEvidenceRef(ref) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'extract_eye_from_evidence_ref',
      { reference: ref == null ? null : String(ref) },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const eyeId = rust.payload.payload.eye_id;
      return eyeId == null ? null : String(eyeId);
    }
  }
  const s = String(ref || '');
  const m = s.match(/\beye:([^\s]+)/);
  return m ? String(m[1]) : null;
}

function outcomeBuckets() {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'outcome_buckets',
      {},
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return {
        shipped: Number(rust.payload.payload.shipped || 0),
        no_change: Number(rust.payload.payload.no_change || 0),
        reverted: Number(rust.payload.payload.reverted || 0)
      };
    }
  }
  return { shipped: 0, no_change: 0, reverted: 0 };
}

function totalOutcomes(b) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const row = b && typeof b === 'object' ? b : {};
    const rust = runBacklogAutoscalePrimitive(
      'total_outcomes',
      {
        shipped: Number(row.shipped || 0),
        no_change: Number(row.no_change || 0),
        reverted: Number(row.reverted || 0)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Number(rust.payload.payload.total || 0);
    }
  }
  if (!b) return 0;
  return Number(b.shipped || 0) + Number(b.no_change || 0) + Number(b.reverted || 0);
}

function deriveEntityBias(buckets, minTotal) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const row = buckets && typeof buckets === 'object' ? buckets : {};
    const rust = runBacklogAutoscalePrimitive(
      'derive_entity_bias',
      {
        shipped: Number(row.shipped || 0),
        no_change: Number(row.no_change || 0),
        reverted: Number(row.reverted || 0),
        min_total: Number(minTotal || 0)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Number(rust.payload.payload.bias || 0);
    }
  }
  const total = totalOutcomes(buckets);
  if (total < minTotal) return 0;
  const shippedRate = Number(buckets.shipped || 0) / total;
  const churnRate = (Number(buckets.no_change || 0) + Number(buckets.reverted || 0)) / total;
  if (shippedRate >= 0.6) return -3;
  if (shippedRate >= 0.45) return -2;
  if (churnRate >= 0.8) return 5;
  if (churnRate >= 0.65) return 3;
  if (churnRate >= 0.5) return 1;
  return 0;
}

function summarizeTopBiases(mapObj, limit = 8) {
  const entries = Object.entries((mapObj || {}) as AnyObj);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'top_biases_summary',
      {
        entries: entries.map(([key, val]) => {
          const row = (val || {}) as AnyObj;
          return {
            key,
            bias: Number(row.bias || 0),
            total: Number(row.total || 0),
            shipped: Number(row.shipped || 0),
            no_change: Number(row.no_change || 0),
            reverted: Number(row.reverted || 0)
          };
        }),
        limit: Math.max(1, Math.floor(Number(limit || 8)))
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const rows = Array.isArray(rust.payload.payload.rows) ? rust.payload.payload.rows : [];
      return rows.map((row) => ({
        key: String(row && row.key || ''),
        bias: Number(row && row.bias || 0),
        total: Number(row && row.total || 0),
        shipped: Number(row && row.shipped || 0),
        no_change: Number(row && row.no_change || 0),
        reverted: Number(row && row.reverted || 0)
      }));
    }
  }
  const out = [];
  for (const [key, val] of entries) {
    const row = (val || {}) as AnyObj;
    out.push({
      key,
      bias: Number(row.bias || 0),
      total: Number(row.total || 0),
      shipped: Number(row.shipped || 0),
      no_change: Number(row.no_change || 0),
      reverted: Number(row.reverted || 0)
    });
  }
  out.sort((a, b) => {
    if (Math.abs(b.bias) !== Math.abs(a.bias)) return Math.abs(b.bias) - Math.abs(a.bias);
    if (b.total !== a.total) return b.total - a.total;
    return a.key.localeCompare(b.key);
  });
  return out.slice(0, limit);
}

function recentRunEvents(endDateStr, days) {
  const buckets = [];
  for (const d of dateWindow(endDateStr, days)) {
    buckets.push(readRuns(d));
  }
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'recent_run_events',
      { day_events: buckets },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Array.isArray(rust.payload.payload.events) ? rust.payload.payload.events : [];
    }
  }
  const events = [];
  for (const bucket of buckets) {
    events.push(...bucket);
  }
  return events;
}

function proposalMetaIndex(endDateStr, days) {
  const rows = [];
  for (const d of dateWindow(endDateStr, days)) {
    const proposals = loadProposalsForDate(d);
    for (const p of proposals) {
      if (!p || !p.id) continue;
      rows.push({
        proposal_id: String(p.id || ''),
        eye_id: String(sourceEyeId(p) || ''),
        topics: Array.isArray(p && p.meta && p.meta.topics)
          ? p.meta.topics.map(t => String(t || '').toLowerCase()).filter(Boolean)
          : []
      });
    }
  }
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'proposal_meta_index',
      { entries: rows },
      { allow_cli_fallback: true }
    );
    if (
      rust
      && rust.ok === true
      && rust.payload
      && rust.payload.ok === true
      && rust.payload.payload
      && Array.isArray(rust.payload.payload.entries)
    ) {
      const idx = new Map();
      for (const row of rust.payload.payload.entries) {
        const proposalId = String(row && row.proposal_id || '');
        if (!proposalId || idx.has(proposalId)) continue;
        idx.set(proposalId, {
          eye_id: String(row && row.eye_id || ''),
          topics: Array.isArray(row && row.topics)
            ? row.topics.map(t => String(t || '').toLowerCase()).filter(Boolean)
            : []
        });
      }
      return idx;
    }
  }
  const idx = new Map();
  for (const row of rows) {
    const proposalId = String(row && row.proposal_id || '');
    if (!proposalId || idx.has(proposalId)) continue;
    idx.set(proposalId, {
      eye_id: String(row && row.eye_id || ''),
      topics: Array.isArray(row && row.topics)
        ? row.topics.map(t => String(t || '').toLowerCase()).filter(Boolean)
        : []
    });
  }
  return idx;
}

function collectOutcomeStats(endDateStr, days) {
  const byEye = {};
  const byTopic = {};
  const global = outcomeBuckets();
  const metaIdx = proposalMetaIndex(endDateStr, days);
  const events = allDecisionEvents();
  for (const e of events) {
    if (!e || e.type !== 'outcome') continue;
    if (!inWindow(e.ts, endDateStr, days)) continue;
    const out = String(e.outcome || '');
    if (!(out in global)) continue;
    global[out] += 1;

    const meta = metaIdx.get(String(e.proposal_id || '')) || null;
    const eyeId = extractEyeFromEvidenceRef(e.evidence_ref) || (meta && meta.eye_id) || 'unknown_eye';
    if (!byEye[eyeId]) byEye[eyeId] = outcomeBuckets();
    byEye[eyeId][out] += 1;

    const topics = meta && Array.isArray(meta.topics) ? meta.topics : [];
    for (const t of topics) {
      if (!byTopic[t]) byTopic[t] = outcomeBuckets();
      byTopic[t][out] += 1;
    }
  }

  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'collect_outcome_stats',
      {
        by_eye: byEye,
        by_topic: byTopic,
        global,
        eye_min_samples: 3,
        topic_min_samples: 4
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      return {
        global: payload.global && typeof payload.global === 'object'
          ? payload.global
          : { ...global, total: totalOutcomes(global) },
        eye_biases: payload.eye_biases && typeof payload.eye_biases === 'object'
          ? payload.eye_biases
          : {},
        topic_biases: payload.topic_biases && typeof payload.topic_biases === 'object'
          ? payload.topic_biases
          : {}
      };
    }
  }

  const eyeBiases = {};
  const topicBiases = {};
  for (const [eye, bRaw] of Object.entries(byEye as AnyObj)) {
    const b: AnyObj = (bRaw || {}) as AnyObj;
    const bias = deriveEntityBias(b, 3);
    if (bias !== 0) eyeBiases[eye] = { ...b, total: totalOutcomes(b), bias };
  }
  for (const [topic, bRaw] of Object.entries(byTopic as AnyObj)) {
    const b: AnyObj = (bRaw || {}) as AnyObj;
    const bias = deriveEntityBias(b, 4);
    if (bias !== 0) topicBiases[topic] = { ...b, total: totalOutcomes(b), bias };
  }

  return {
    global: { ...global, total: totalOutcomes(global) },
    eye_biases: eyeBiases,
    topic_biases: topicBiases
  };
}

function computeCalibrationDeltas(input: AnyObj = {}) {
  const zero = {
    min_signal_quality: 0,
    min_sensory_signal_score: 0,
    min_sensory_relevance_score: 0,
    min_directive_fit: 0,
    min_actionability_score: 0,
    min_eye_score_ema: 0
  };

  const executedCount = Number(input.executedCount || 0);
  const shippedRate = Number(input.shippedRate || 0);
  const noChangeRate = Number(input.noChangeRate || 0);
  const revertedRate = Number(input.revertedRate || 0);
  const exhausted = Number(input.exhausted || 0);
  const deltas = { ...zero };

  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'calibration_deltas',
      {
        executed_count: executedCount,
        shipped_rate: shippedRate,
        no_change_rate: noChangeRate,
        reverted_rate: revertedRate,
        exhausted,
        min_executed: Number(AUTONOMY_CALIBRATION_MIN_EXECUTED || 0),
        tighten_min_executed: Number(AUTONOMY_CALIBRATION_TIGHTEN_MIN_EXECUTED || 0),
        loosen_low_shipped_rate: Number(AUTONOMY_CALIBRATION_LOOSEN_LOW_SHIPPED_RATE || 0),
        loosen_exhausted_threshold: Number(AUTONOMY_CALIBRATION_LOOSEN_EXHAUSTED_THRESHOLD || 0),
        tighten_min_shipped_rate: Number(AUTONOMY_CALIBRATION_TIGHTEN_MIN_SHIPPED_RATE || 0),
        max_delta: Number(AUTONOMY_CALIBRATION_MAX_DELTA || 0)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return {
        min_signal_quality: Number(rust.payload.payload.min_signal_quality || 0),
        min_sensory_signal_score: Number(rust.payload.payload.min_sensory_signal_score || 0),
        min_sensory_relevance_score: Number(rust.payload.payload.min_sensory_relevance_score || 0),
        min_directive_fit: Number(rust.payload.payload.min_directive_fit || 0),
        min_actionability_score: Number(rust.payload.payload.min_actionability_score || 0),
        min_eye_score_ema: Number(rust.payload.payload.min_eye_score_ema || 0)
      };
    }
  }

  const tightenEligible = executedCount >= Math.max(AUTONOMY_CALIBRATION_MIN_EXECUTED, AUTONOMY_CALIBRATION_TIGHTEN_MIN_EXECUTED);
  const loosenEligible = executedCount >= AUTONOMY_CALIBRATION_MIN_EXECUTED;
  const lowShipHighExhaustion = (
    loosenEligible
    && shippedRate < AUTONOMY_CALIBRATION_LOOSEN_LOW_SHIPPED_RATE
    && exhausted >= AUTONOMY_CALIBRATION_LOOSEN_EXHAUSTED_THRESHOLD
  );

  if (lowShipHighExhaustion) {
    // If we are not shipping and repeatedly exhausting gates, loosen intake thresholds.
    deltas.min_signal_quality -= 3;
    deltas.min_directive_fit -= 3;
    deltas.min_actionability_score -= 2;
    deltas.min_sensory_relevance_score -= 1;
  } else if (tightenEligible) {
    // Tightening requires both enough volume and a non-trivial shipped baseline.
    if (noChangeRate >= 0.6 && shippedRate >= AUTONOMY_CALIBRATION_TIGHTEN_MIN_SHIPPED_RATE) {
      deltas.min_signal_quality += 3;
      deltas.min_directive_fit += 3;
      deltas.min_actionability_score += 2;
      deltas.min_sensory_relevance_score += 2;
    }
    if (revertedRate >= 0.15) {
      deltas.min_signal_quality += 2;
      deltas.min_actionability_score += 2;
    }
    if (shippedRate >= 0.45 && exhausted >= 2) {
      deltas.min_signal_quality -= 2;
      deltas.min_directive_fit -= 2;
      deltas.min_actionability_score -= 1;
    }
  } else if (exhausted >= 3) {
    deltas.min_signal_quality -= 1;
    deltas.min_directive_fit -= 1;
  }

  for (const k of Object.keys(deltas)) {
    deltas[k] = clampNumber(deltas[k], -AUTONOMY_CALIBRATION_MAX_DELTA, AUTONOMY_CALIBRATION_MAX_DELTA);
  }
  return deltas;
}

function computeCalibrationProfile(dateStr, persist = true) {
  const base = baseThresholds();
  const zeroDeltas = {
    min_signal_quality: 0,
    min_sensory_signal_score: 0,
    min_sensory_relevance_score: 0,
    min_directive_fit: 0,
    min_actionability_score: 0,
    min_eye_score_ema: 0
  };

  if (!AUTONOMY_CALIBRATION_ENABLED) {
    return {
      enabled: false,
      ts: nowIso(),
      date: dateStr,
      window_days: AUTONOMY_CALIBRATION_WINDOW_DAYS,
      base_thresholds: base,
      deltas: zeroDeltas,
      effective_thresholds: base,
      metrics: {
        executed: 0,
        shipped: 0,
        no_change: 0,
        reverted: 0,
        exhausted: 0
      },
      eye_biases: {},
      topic_biases: {}
    };
  }

  const windowDays = clampNumber(AUTONOMY_CALIBRATION_WINDOW_DAYS, 1, 30);
  const events = recentRunEvents(dateStr, windowDays).filter(e => e && e.type === 'autonomy_run');
  const executed = events.filter(e => e.result === 'executed');
  const shipped = executed.filter(e => e.outcome === 'shipped').length;
  const noChange = executed.filter(e => e.outcome === 'no_change').length;
  const reverted = executed.filter(e => e.outcome === 'reverted').length;
  const exhausted = events.filter(e => String(e.result || '').includes('_exhausted')).length;
  const executedCount = executed.length;
  const shippedRate = executedCount > 0 ? shipped / executedCount : 0;
  const noChangeRate = executedCount > 0 ? noChange / executedCount : 0;
  const revertedRate = executedCount > 0 ? reverted / executedCount : 0;

  const deltas = computeCalibrationDeltas({
    executedCount,
    shippedRate,
    noChangeRate,
    revertedRate,
    exhausted
  });

  const outcomeStats = collectOutcomeStats(dateStr, windowDays);
  const profile = {
    version: 1,
    enabled: true,
    ts: nowIso(),
    date: dateStr,
    window_days: windowDays,
    base_thresholds: base,
    deltas,
    effective_thresholds: appliedThresholds(base, deltas),
    metrics: {
      executed: executedCount,
      shipped,
      no_change: noChange,
      reverted,
      exhausted,
      shipped_rate: Number(shippedRate.toFixed(3)),
      no_change_rate: Number(noChangeRate.toFixed(3)),
      reverted_rate: Number(revertedRate.toFixed(3))
    },
    eye_biases: outcomeStats.eye_biases,
    topic_biases: outcomeStats.topic_biases,
    top_eye_biases: summarizeTopBiases(outcomeStats.eye_biases),
    top_topic_biases: summarizeTopBiases(outcomeStats.topic_biases)
  };
  if (persist) saveJson(CALIBRATION_PATH, profile);
  return profile;
}

function clampNumber(n, min, max) {
  if (String(process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED || '0') === '1') {
    const rust = runBacklogAutoscalePrimitive(
      'clamp_number',
      { value: Number(n), min: Number(min), max: Number(max) },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Number(rust.payload.payload.value || 0);
    }
  }
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function urlDomain(url) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'url_domain',
      { url: url == null ? null : String(url) },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return String(rust.payload.payload.domain || '').toLowerCase();
    }
  }
  try {
    const u = new URL(String(url || ''));
    return String(u.hostname || '').toLowerCase();
  } catch {
    return '';
  }
}

function domainAllowed(domain, allowlist) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'domain_allowed',
      {
        domain: domain == null ? null : String(domain),
        allowlist: Array.isArray(allowlist) ? allowlist : []
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.allowed === true;
    }
  }
  if (!domain) return false;
  if (!Array.isArray(allowlist) || allowlist.length === 0) return true;
  const d = String(domain).toLowerCase();
  return allowlist.some(raw => {
    const a = String(raw || '').toLowerCase().trim();
    if (!a) return false;
    return d === a || d.endsWith(`.${a}`);
  });
}

function normalizeDirectiveText(s) {
  const raw = String(s || '');
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    if (NORMALIZE_DIRECTIVE_TEXT_CACHE.has(raw)) return NORMALIZE_DIRECTIVE_TEXT_CACHE.get(raw);
    const rust = runBacklogAutoscalePrimitive(
      'normalize_directive_text',
      { text: raw || null },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const normalized = String(rust.payload.payload.normalized || '');
      if (NORMALIZE_DIRECTIVE_TEXT_CACHE.size >= NORMALIZE_DIRECTIVE_TEXT_CACHE_MAX) {
        const oldest = NORMALIZE_DIRECTIVE_TEXT_CACHE.keys().next();
        if (!oldest.done) NORMALIZE_DIRECTIVE_TEXT_CACHE.delete(oldest.value);
      }
      NORMALIZE_DIRECTIVE_TEXT_CACHE.set(raw, normalized);
      return normalized;
    }
  }
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenizeDirectiveText(s) {
  const raw = String(s || '');
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const cacheKey = raw;
    if (TOKENIZE_DIRECTIVE_TEXT_CACHE.has(cacheKey)) {
      return TOKENIZE_DIRECTIVE_TEXT_CACHE.get(cacheKey);
    }
    const rust = runBacklogAutoscalePrimitive(
      'tokenize_directive_text',
      {
        text: raw || null,
        stopwords: Array.from(DIRECTIVE_FIT_STOPWORDS)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const tokens = Array.isArray(rust.payload.payload.tokens)
        ? rust.payload.payload.tokens.map((t) => String(t || '')).filter(Boolean)
        : [];
      if (TOKENIZE_DIRECTIVE_TEXT_CACHE.size >= TOKENIZE_DIRECTIVE_TEXT_CACHE_MAX) {
        const oldest = TOKENIZE_DIRECTIVE_TEXT_CACHE.keys().next();
        if (!oldest.done) TOKENIZE_DIRECTIVE_TEXT_CACHE.delete(oldest.value);
      }
      TOKENIZE_DIRECTIVE_TEXT_CACHE.set(cacheKey, tokens);
      return tokens;
    }
  }
  const norm = normalizeDirectiveText(raw);
  if (!norm) return [];
  return norm
    .split(' ')
    .filter(t => t.length >= 3)
    .filter(t => !DIRECTIVE_FIT_STOPWORDS.has(t))
    .filter(t => !/^\d+$/.test(t));
}

function toStem(token) {
  const t = String(token || '').trim();
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    if (TO_STEM_CACHE.has(t)) return TO_STEM_CACHE.get(t);
    const rust = runBacklogAutoscalePrimitive(
      'to_stem',
      { token: t || null },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const stem = String(rust.payload.payload.stem || '');
      if (TO_STEM_CACHE.size >= TO_STEM_CACHE_MAX) {
        const oldest = TO_STEM_CACHE.keys().next();
        if (!oldest.done) TO_STEM_CACHE.delete(oldest.value);
      }
      TO_STEM_CACHE.set(t, stem);
      return stem;
    }
  }
  if (t.length <= 5) return t;
  return t.slice(0, 5);
}

function asStringArray(v) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'as_string_array',
      { value: v == null ? null : v },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Array.isArray(rust.payload.payload.values)
        ? rust.payload.payload.values.map((x) => String(x || '')).filter(Boolean)
        : [];
    }
  }
  if (Array.isArray(v)) return v.map(x => String(x || '').trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

function strategyMarkerTokens(strategy) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const s = strategy && typeof strategy === 'object' ? strategy : {};
    const objective = s.objective && typeof s.objective === 'object' ? s.objective : {};
    const rust = runBacklogAutoscalePrimitive(
      'strategy_marker_tokens',
      {
        objective_primary: objective.primary == null ? null : String(objective.primary),
        objective_fitness_metric: objective.fitness_metric == null ? null : String(objective.fitness_metric),
        objective_secondary: Array.isArray(objective.secondary) ? objective.secondary.map(v => String(v || '')) : [],
        tags: Array.isArray(s.tags) ? s.tags.map(v => String(v || '')) : []
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const out = Array.isArray(rust.payload.payload.tokens)
        ? rust.payload.payload.tokens.map(v => String(v || '')).filter(Boolean)
        : [];
      return uniqSorted(out);
    }
  }
  const s = strategy && typeof strategy === 'object' ? strategy : {};
  const objective = s.objective && typeof s.objective === 'object' ? s.objective : {};
  const textParts = [
    objective.primary,
    objective.fitness_metric,
    ...(Array.isArray(objective.secondary) ? objective.secondary : []),
    ...(Array.isArray(s.tags) ? s.tags : [])
  ];
  const tokenSet = new Set();
  for (const part of textParts) {
    const norm = normalizeDirectiveText(part);
    if (!norm) continue;
    for (const t of tokenizeDirectiveText(norm)) tokenSet.add(t);
  }
  return uniqSorted(Array.from(tokenSet));
}

function uniqSorted(arr) {
  if (
    AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED
    && Array.isArray(arr)
    && arr.every((x) => typeof x === 'string')
  ) {
    const rust = runBacklogAutoscalePrimitive(
      'uniq_sorted',
      { values: arr.slice() },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Array.isArray(rust.payload.payload.values)
        ? rust.payload.payload.values.map((x) => String(x || ''))
        : [];
    }
  }
  return Array.from(new Set(arr)).sort();
}

function loadDirectiveFitProfile() {
  let directives = [];
  try {
    directives = loadActiveDirectives({ allowMissing: true });
  } catch (err) {
    return {
      available: false,
      error: String(err && err.message ? err.message : err).slice(0, 200),
      strategy_id: null,
      strategy_tokens: [],
      active_directive_ids: [],
      positive_phrases: [],
      negative_phrases: [],
      positive_tokens: [],
      negative_tokens: []
    };
  }

  const strategic = directives.filter((d) => {
    const id = String((d && d.id) || '').trim();
    if (/^T0[_-]/i.test(id) || /^T0$/i.test(id)) return false;
    const entryTier = Number(d && d.tier);
    const metaTier = Number(d && d.data && d.data.metadata && d.data.metadata.tier);
    const tier = Number.isFinite(entryTier) ? entryTier : metaTier;
    return Number.isFinite(tier) ? tier >= 1 : true;
  });
  const positivePhrases = [];
  const negativePhrases = [];
  const activeIds = [];

  for (const d of strategic) {
    const data = d && d.data ? d.data : {};
    const metadata = data && data.metadata ? data.metadata : {};
    const intent = data && data.intent ? data.intent : {};
    const scope = data && data.scope ? data.scope : {};
    const success = data && data.success_metrics ? data.success_metrics : {};
    activeIds.push(String(d.id || metadata.id || '').trim());

    positivePhrases.push(...asStringArray(metadata.description));
    positivePhrases.push(...asStringArray(intent.primary));
    positivePhrases.push(...asStringArray(scope.included));
    positivePhrases.push(...asStringArray(success.leading));
    positivePhrases.push(...asStringArray(success.lagging));

    negativePhrases.push(...asStringArray(scope.excluded));
  }

  const posPhrasesNorm = uniqSorted(
    positivePhrases
      .map(normalizeDirectiveText)
      .filter(x => x.length >= 4)
  );
  const negPhrasesNorm = uniqSorted(
    negativePhrases
      .map(normalizeDirectiveText)
      .filter(x => x.length >= 4)
  );

  const posTokenSet = new Set();
  const negTokenSet = new Set();
  for (const p of posPhrasesNorm) {
    for (const t of tokenizeDirectiveText(p)) posTokenSet.add(t);
  }
  for (const p of negPhrasesNorm) {
    for (const t of tokenizeDirectiveText(p)) negTokenSet.add(t);
  }
  for (const t of posTokenSet) {
    if (negTokenSet.has(t)) negTokenSet.delete(t);
  }
  const strategy = strategyProfile();
  const strategyTokens = strategyMarkerTokens(strategy);

  const profile = {
    available: activeIds.length > 0 && posTokenSet.size > 0,
    error: null,
    strategy_id: strategy && strategy.id ? String(strategy.id) : null,
    strategy_tokens: strategyTokens,
    active_directive_ids: uniqSorted(activeIds.filter(Boolean)),
    positive_phrases: posPhrasesNorm,
    negative_phrases: negPhrasesNorm,
    positive_tokens: uniqSorted(Array.from(posTokenSet)),
    negative_tokens: uniqSorted(Array.from(negTokenSet))
  };
  if (!profile.available) {
    profile.error = activeIds.length === 0 ? 'no_active_strategic_directives' : 'empty_directive_keywords';
  }
  return profile;
}

function normalizeDirectiveTier(rawTier, fallback = 3) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const raw = Number(rawTier);
    const fallbackRaw = Number(fallback);
    const cacheKey = [
      Number.isFinite(raw) ? String(raw) : 'NaN',
      Number.isFinite(fallbackRaw) ? String(fallbackRaw) : 'NaN'
    ].join('\u0000');
    if (NORMALIZE_DIRECTIVE_TIER_CACHE.has(cacheKey)) {
      return NORMALIZE_DIRECTIVE_TIER_CACHE.get(cacheKey);
    }
    const rust = runBacklogAutoscalePrimitive(
      'normalize_directive_tier',
      {
        raw_tier: Number.isFinite(raw) ? raw : null,
        fallback: Number.isFinite(fallbackRaw) ? fallbackRaw : 3
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const tier = Math.max(1, Math.round(Number(rust.payload.payload.tier || 0)));
      if (NORMALIZE_DIRECTIVE_TIER_CACHE.size >= NORMALIZE_DIRECTIVE_TIER_CACHE_MAX) {
        const oldest = NORMALIZE_DIRECTIVE_TIER_CACHE.keys().next();
        if (!oldest.done) NORMALIZE_DIRECTIVE_TIER_CACHE.delete(oldest.value);
      }
      NORMALIZE_DIRECTIVE_TIER_CACHE.set(cacheKey, tier);
      return tier;
    }
  }
  const n = Number(rawTier);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.round(n));
}

function directiveTierWeight(tier) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const tierRaw = Number(tier);
    const cacheKey = Number.isFinite(tierRaw) ? String(tierRaw) : 'NaN';
    if (DIRECTIVE_TIER_WEIGHT_CACHE.has(cacheKey)) {
      return DIRECTIVE_TIER_WEIGHT_CACHE.get(cacheKey);
    }
    const rust = runBacklogAutoscalePrimitive(
      'directive_tier_weight',
      {
        tier: Number.isFinite(tierRaw) ? tierRaw : null,
        fallback: 3
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const weight = Number(rust.payload.payload.weight);
      if (Number.isFinite(weight)) {
        if (DIRECTIVE_TIER_WEIGHT_CACHE.size >= DIRECTIVE_TIER_WEIGHT_CACHE_MAX) {
          const oldest = DIRECTIVE_TIER_WEIGHT_CACHE.keys().next();
          if (!oldest.done) DIRECTIVE_TIER_WEIGHT_CACHE.delete(oldest.value);
        }
        DIRECTIVE_TIER_WEIGHT_CACHE.set(cacheKey, weight);
        return weight;
      }
    }
  }
  const t = normalizeDirectiveTier(tier, 3);
  if (t <= 1) return 1.3;
  if (t === 2) return 1.0;
  if (t === 3) return 0.82;
  return 0.7;
}

function directiveTierMinShare(tier) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const tierRaw = Number(tier);
    const t1 = Number(AUTONOMY_DIRECTIVE_PULSE_T1_MIN_SHARE || 0);
    const t2 = Number(AUTONOMY_DIRECTIVE_PULSE_T2_MIN_SHARE || 0);
    const cacheKey = [
      Number.isFinite(tierRaw) ? String(tierRaw) : 'NaN',
      String(t1),
      String(t2)
    ].join('\u0000');
    if (DIRECTIVE_TIER_MIN_SHARE_CACHE.has(cacheKey)) {
      return DIRECTIVE_TIER_MIN_SHARE_CACHE.get(cacheKey);
    }
    const rust = runBacklogAutoscalePrimitive(
      'directive_tier_min_share',
      {
        tier: Number.isFinite(tierRaw) ? tierRaw : null,
        fallback: 3,
        t1_min_share: t1,
        t2_min_share: t2
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const minShare = clampNumber(Number(rust.payload.payload.min_share || 0), 0, 1);
      if (DIRECTIVE_TIER_MIN_SHARE_CACHE.size >= DIRECTIVE_TIER_MIN_SHARE_CACHE_MAX) {
        const oldest = DIRECTIVE_TIER_MIN_SHARE_CACHE.keys().next();
        if (!oldest.done) DIRECTIVE_TIER_MIN_SHARE_CACHE.delete(oldest.value);
      }
      DIRECTIVE_TIER_MIN_SHARE_CACHE.set(cacheKey, minShare);
      return minShare;
    }
  }
  const t = normalizeDirectiveTier(tier, 3);
  if (t <= 1) return clampNumber(Number(AUTONOMY_DIRECTIVE_PULSE_T1_MIN_SHARE || 0), 0, 1);
  if (t === 2) return clampNumber(Number(AUTONOMY_DIRECTIVE_PULSE_T2_MIN_SHARE || 0), 0, 1);
  return 0;
}

function compileDirectivePulseObjectives(directives) {
  const input = Array.isArray(directives) ? directives : [];
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'compile_directive_pulse_objectives',
      {
        directives: input,
        stopwords: Array.from(DIRECTIVE_FIT_STOPWORDS),
        allowed_value_keys: Array.from(VALUE_CURRENCY_RANK_KEYS),
        t1_min_share: Number(AUTONOMY_DIRECTIVE_PULSE_T1_MIN_SHARE || 0),
        t2_min_share: Number(AUTONOMY_DIRECTIVE_PULSE_T2_MIN_SHARE || 0)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const rows = Array.isArray(rust.payload.payload.objectives) ? rust.payload.payload.objectives : [];
      const out = [];
      for (const rawRow of rows) {
        const row = rawRow && typeof rawRow === 'object' ? rawRow : {};
        const id = String(row.id || '').trim();
        if (!id) continue;
        const tier = normalizeDirectiveTier(Number(row.tier), 3);
        const phrases = uniqSorted(
          (Array.isArray(row.phrases) ? row.phrases : [])
            .map((x) => normalizeDirectiveText(String(x || '')))
            .filter(Boolean)
            .filter((x) => x.length >= 6)
        ).slice(0, 16);
        const tokens = uniqSorted(
          (Array.isArray(row.tokens) ? row.tokens : [])
            .map((x) => String(x || ''))
            .filter(Boolean)
        ).slice(0, 64);
        const valueCurrencies = listValueCurrencies(
          (Array.isArray(row.value_currencies) ? row.value_currencies : []).map((x) => String(x || ''))
        );
        const primaryCurrencyRaw = String(row.primary_currency || '').trim().toLowerCase();
        const primaryCurrency = primaryCurrencyRaw && valueCurrencies.includes(primaryCurrencyRaw)
          ? primaryCurrencyRaw
          : (valueCurrencies[0] || null);
        out.push({
          id,
          tier,
          title: String(row.title || id),
          tier_weight: Number.isFinite(Number(row.tier_weight)) ? Number(row.tier_weight) : directiveTierWeight(tier),
          min_share: clampNumber(Number(row.min_share || 0), 0, 1),
          phrases,
          tokens,
          value_currencies: valueCurrencies,
          primary_currency: primaryCurrency
        });
      }
      out.sort((a, b) => {
        if (a.tier !== b.tier) return a.tier - b.tier;
        return String(a.id).localeCompare(String(b.id));
      });
      return out;
    }
  }
  const out = [];
  const seen = new Set();
  for (const d of input) {
    if (!d || typeof d !== 'object') continue;
    const data = d.data && typeof d.data === 'object' ? d.data : {};
    const metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
    const intent = data.intent && typeof data.intent === 'object' ? data.intent : {};
    const scope = data.scope && typeof data.scope === 'object' ? data.scope : {};
    const success = data.success_metrics && typeof data.success_metrics === 'object' ? data.success_metrics : {};
    const id = String(metadata.id || d.id || '').trim();
    if (!id || seen.has(id)) continue;
    if (/^T0[_-]/i.test(id) || /^T0$/i.test(id)) continue;

    const tier = normalizeDirectiveTier(
      Number.isFinite(Number(d.tier)) ? Number(d.tier) : Number(metadata.tier),
      3
    );

    const phrasesRaw = []
      .concat(asStringArray(metadata.description))
      .concat(asStringArray(intent.primary))
      .concat(asStringArray(scope.included))
      .concat(asStringArray(success.leading))
      .concat(asStringArray(success.lagging));
    const phrases = uniqSorted(
      phrasesRaw
        .map(normalizeDirectiveText)
        .filter(Boolean)
        .filter(x => x.length >= 6)
    ).slice(0, 16);

    const tokenSet = new Set();
    for (const p of phrases) {
      for (const tok of tokenizeDirectiveText(p)) tokenSet.add(tok);
    }
    const tokens = uniqSorted(Array.from(tokenSet)).slice(0, 64);
    const explicitCurrencies = listValueCurrencies(
      []
        .concat(asStringArray(metadata.value_currency))
        .concat(asStringArray(metadata.value_currencies))
        .concat(asStringArray(data.value_currency))
        .concat(asStringArray(data.value_currencies))
        .concat(asStringArray(intent.value_currency))
        .concat(asStringArray(intent.value_currencies))
    );
    const inferredCurrencies = inferValueCurrenciesFromDirectiveBits([
      id,
      ...phrasesRaw,
      ...phrases,
      ...tokens
    ]);
    const valueCurrencies = explicitCurrencies.length > 0
      ? listValueCurrencies([].concat(explicitCurrencies).concat(inferredCurrencies))
      : inferredCurrencies;
    const primaryCurrency = valueCurrencies.length > 0 ? valueCurrencies[0] : null;

    out.push({
      id,
      tier,
      title: String(asStringArray(intent.primary)[0] || asStringArray(metadata.description)[0] || id),
      tier_weight: directiveTierWeight(tier),
      min_share: directiveTierMinShare(tier),
      phrases,
      tokens,
      value_currencies: valueCurrencies,
      primary_currency: primaryCurrency
    });
    seen.add(id);
  }
  out.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return String(a.id).localeCompare(String(b.id));
  });
  return out;
}

function loadDirectivePulseObjectives() {
  const profileFromRust = (enabled, loadError, objectives) => {
    const rust = runBacklogAutoscalePrimitive(
      'directive_pulse_objectives_profile',
      {
        enabled: enabled === true,
        load_error: loadError ? String(loadError) : null,
        objectives: Array.isArray(objectives) ? objectives : []
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      return {
        enabled: payload.enabled === true,
        available: payload.available === true,
        objectives: Array.isArray(payload.objectives) ? payload.objectives : [],
        error: payload.error ? String(payload.error) : null
      };
    }
    return null;
  };
  if (!AUTONOMY_DIRECTIVE_PULSE_ENABLED) {
    if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
      const viaRust = profileFromRust(false, null, []);
      if (viaRust) return viaRust;
    }
    return {
      enabled: false,
      available: false,
      objectives: [],
      error: 'directive_pulse_disabled'
    };
  }
  let directives = [];
  try {
    directives = loadActiveDirectives({ allowMissing: true });
  } catch (err) {
    if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
      const viaRust = profileFromRust(true, String(err && err.message ? err.message : err).slice(0, 200), []);
      if (viaRust) return viaRust;
    }
    return {
      enabled: true,
      available: false,
      objectives: [],
      error: String(err && err.message ? err.message : err).slice(0, 200)
    };
  }
  const objectives = compileDirectivePulseObjectives(directives);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const viaRust = profileFromRust(true, null, objectives);
    if (viaRust) return viaRust;
  }
  return {
    enabled: true,
    available: objectives.length > 0,
    objectives,
    error: objectives.length > 0 ? null : 'no_objectives'
  };
}

function buildDirectivePulseStats(dateStr, windowDays) {
  const days = clampNumber(Number(windowDays || AUTONOMY_DIRECTIVE_PULSE_WINDOW_DAYS), 1, 60);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rustEvents = [];
    for (const d of dateWindow(dateStr, days)) {
      const rows = readRuns(d);
      for (const evt of rows) {
        if (!evt || typeof evt !== 'object') continue;
        const pulse = evt.directive_pulse && typeof evt.directive_pulse === 'object'
          ? evt.directive_pulse
          : null;
        rustEvents.push({
          day: String(d || ''),
          event_type: String(evt.type || ''),
          result: String(evt.result || ''),
          outcome: String(evt.outcome || ''),
          objective_id: pulse && pulse.objective_id != null ? String(pulse.objective_id) : null,
          tier: Number.isFinite(Number(pulse && pulse.tier)) ? Number(pulse && pulse.tier) : null,
          ts: evt.ts ? String(evt.ts) : null
        });
      }
    }
    const rust = runBacklogAutoscalePrimitive(
      'directive_pulse_stats',
      {
        date_str: String(dateStr || ''),
        window_days: Number(days || AUTONOMY_DIRECTIVE_PULSE_WINDOW_DAYS),
        events: rustEvents
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      const stats = new Map();
      const rows = Array.isArray(payload.objective_stats) ? payload.objective_stats : [];
      for (const rawRow of rows) {
        const row = rawRow && typeof rawRow === 'object' ? rawRow : {};
        const objectiveId = String(row.objective_id || '').trim();
        if (!objectiveId) continue;
        stats.set(objectiveId, {
          objective_id: objectiveId,
          tier: Number(row.tier || 0),
          attempts: Number(row.attempts || 0),
          shipped: Number(row.shipped || 0),
          no_change: Number(row.no_change || 0),
          reverted: Number(row.reverted || 0),
          no_progress_streak: Number(row.no_progress_streak || 0),
          last_attempt_ts: row.last_attempt_ts ? String(row.last_attempt_ts) : null,
          last_shipped_ts: row.last_shipped_ts ? String(row.last_shipped_ts) : null
        });
      }
      return {
        stats,
        tier_attempts_today: payload.tier_attempts_today && typeof payload.tier_attempts_today === 'object'
          ? payload.tier_attempts_today
          : {},
        attempts_today: Number(payload.attempts_today || 0)
      };
    }
  }
  const stats = new Map();
  const tierAttemptsToday = {};
  let attemptsToday = 0;
  for (const d of dateWindow(dateStr, days)) {
    const rows = readRuns(d);
    for (const evt of rows) {
      if (!evt || evt.type !== 'autonomy_run') continue;
      if (!isAttemptRunEvent(evt)) continue;
      const pulse = evt.directive_pulse && typeof evt.directive_pulse === 'object'
        ? evt.directive_pulse
        : null;
      const objectiveId = String(pulse && pulse.objective_id || '').trim();
      const tier = normalizeDirectiveTier(pulse && pulse.tier, 3);

      if (d === dateStr) {
        tierAttemptsToday[tier] = Number(tierAttemptsToday[tier] || 0) + 1;
        attemptsToday += 1;
      }

      if (!objectiveId) continue;

      const cur = stats.get(objectiveId) || {
        objective_id: objectiveId,
        tier,
        attempts: 0,
        shipped: 0,
        no_change: 0,
        reverted: 0,
        no_progress_streak: 0,
        last_attempt_ts: null,
        last_shipped_ts: null
      };
      cur.attempts += 1;
      cur.tier = tier;
      cur.last_attempt_ts = String(evt.ts || cur.last_attempt_ts || '');
      const shipped = evt.result === 'executed' && evt.outcome === 'shipped';
      if (shipped) {
        cur.shipped += 1;
        cur.last_shipped_ts = String(evt.ts || cur.last_shipped_ts || '');
        cur.no_progress_streak = 0;
      } else {
        if (evt.result === 'executed' && evt.outcome === 'no_change') cur.no_change += 1;
        if (evt.result === 'executed' && evt.outcome === 'reverted') cur.reverted += 1;
        if (isNoProgressRun(evt)) cur.no_progress_streak += 1;
      }
      stats.set(objectiveId, cur);
    }
  }
  return {
    stats,
    tier_attempts_today: tierAttemptsToday,
    attempts_today: attemptsToday
  };
}

function buildDirectivePulseContext(dateStr) {
  const cfg = loadDirectivePulseObjectives();
  const hist = buildDirectivePulseStats(dateStr, AUTONOMY_DIRECTIVE_PULSE_WINDOW_DAYS);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const objectiveStatsRows = hist && hist.stats instanceof Map
      ? Array.from(hist.stats.entries()).map(([objectiveId, stat]) => {
        const row = stat && typeof stat === 'object' ? stat : {};
        const objective_id = String(objectiveId || row.objective_id || '').trim();
        return {
          objective_id,
          tier: Number(row.tier || 0),
          attempts: Number(row.attempts || 0),
          shipped: Number(row.shipped || 0),
          no_change: Number(row.no_change || 0),
          reverted: Number(row.reverted || 0),
          no_progress_streak: Number(row.no_progress_streak || 0),
          last_attempt_ts: row.last_attempt_ts ? String(row.last_attempt_ts) : null,
          last_shipped_ts: row.last_shipped_ts ? String(row.last_shipped_ts) : null
        };
      })
      : [];
    const rust = runBacklogAutoscalePrimitive(
      'directive_pulse_context',
      {
        enabled: cfg.enabled === true,
        available: cfg.available === true,
        objectives: Array.isArray(cfg.objectives) ? cfg.objectives : [],
        error: cfg.error || null,
        window_days: Number(AUTONOMY_DIRECTIVE_PULSE_WINDOW_DAYS || 14),
        urgency_hours: Number(AUTONOMY_DIRECTIVE_PULSE_URGENCY_HOURS || 24),
        no_progress_limit: Number(AUTONOMY_DIRECTIVE_PULSE_NO_PROGRESS_LIMIT || 3),
        cooldown_hours: Number(AUTONOMY_DIRECTIVE_PULSE_COOLDOWN_HOURS || 6),
        tier_attempts_today: hist && hist.tier_attempts_today && typeof hist.tier_attempts_today === 'object'
          ? hist.tier_attempts_today
          : {},
        attempts_today: Number(hist && hist.attempts_today || 0),
        objective_stats: objectiveStatsRows
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      const objectiveStats = new Map();
      const rows = Array.isArray(payload.objective_stats) ? payload.objective_stats : [];
      for (const rawRow of rows) {
        const row = rawRow && typeof rawRow === 'object' ? rawRow : {};
        const objectiveId = String(row.objective_id || '').trim();
        if (!objectiveId) continue;
        objectiveStats.set(objectiveId, {
          objective_id: objectiveId,
          tier: Number(row.tier || 0),
          attempts: Number(row.attempts || 0),
          shipped: Number(row.shipped || 0),
          no_change: Number(row.no_change || 0),
          reverted: Number(row.reverted || 0),
          no_progress_streak: Number(row.no_progress_streak || 0),
          last_attempt_ts: row.last_attempt_ts ? String(row.last_attempt_ts) : null,
          last_shipped_ts: row.last_shipped_ts ? String(row.last_shipped_ts) : null
        });
      }
      return {
        enabled: payload.enabled === true,
        available: payload.available === true,
        objectives: Array.isArray(payload.objectives) ? payload.objectives : [],
        error: payload.error ? String(payload.error) : null,
        window_days: Number(payload.window_days || 0),
        urgency_hours: Number(payload.urgency_hours || 0),
        no_progress_limit: Number(payload.no_progress_limit || 0),
        cooldown_hours: Number(payload.cooldown_hours || 0),
        tier_attempts_today: payload.tier_attempts_today && typeof payload.tier_attempts_today === 'object'
          ? payload.tier_attempts_today
          : {},
        attempts_today: Number(payload.attempts_today || 0),
        objective_stats: objectiveStats
      };
    }
  }
  return {
    enabled: cfg.enabled === true,
    available: cfg.available === true,
    objectives: Array.isArray(cfg.objectives) ? cfg.objectives : [],
    error: cfg.error || null,
    window_days: clampNumber(Number(AUTONOMY_DIRECTIVE_PULSE_WINDOW_DAYS || 14), 1, 60),
    urgency_hours: clampNumber(Number(AUTONOMY_DIRECTIVE_PULSE_URGENCY_HOURS || 24), 1, 240),
    no_progress_limit: clampNumber(Number(AUTONOMY_DIRECTIVE_PULSE_NO_PROGRESS_LIMIT || 3), 1, 12),
    cooldown_hours: clampNumber(Number(AUTONOMY_DIRECTIVE_PULSE_COOLDOWN_HOURS || 6), 1, 168),
    tier_attempts_today: hist.tier_attempts_today,
    attempts_today: hist.attempts_today,
    objective_stats: hist.stats
  };
}

function pulseObjectiveCooldownActive(stat, pulseCtx) {
  if (!stat || typeof stat !== 'object') return false;
  const streak = Number(stat.no_progress_streak || 0);
  const limit = Number(pulseCtx && pulseCtx.no_progress_limit || AUTONOMY_DIRECTIVE_PULSE_NO_PROGRESS_LIMIT);
  const cooldown = Number(pulseCtx && pulseCtx.cooldown_hours || AUTONOMY_DIRECTIVE_PULSE_COOLDOWN_HOURS);
  const ts = String(stat.last_attempt_ts || '').trim();
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'pulse_objective_cooldown_active',
      {
        no_progress_streak: Number.isFinite(streak) ? streak : 0,
        no_progress_limit: Number.isFinite(limit) ? limit : 0,
        last_attempt_ts: ts || null,
        cooldown_hours: Number.isFinite(cooldown) ? cooldown : 0,
        now_ms: Date.now()
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.active === true;
    }
  }
  if (!Number.isFinite(streak) || streak < Math.max(1, limit)) return false;
  const last = parseIsoTs(ts);
  if (!last) return false;
  const ageHours = (Date.now() - last.getTime()) / (1000 * 60 * 60);
  return ageHours < Math.max(1, cooldown);
}

function pulseTierCoverageBonus(tier, pulseCtx) {
  const tierRaw = Number(tier);
  const attemptsToday = Number(pulseCtx && pulseCtx.attempts_today || 0);
  const byTier = pulseCtx && pulseCtx.tier_attempts_today && typeof pulseCtx.tier_attempts_today === 'object'
    ? pulseCtx.tier_attempts_today
    : {};
  const normalizedTier = normalizeDirectiveTier(tierRaw, 3);
  const current = Number(byTier[normalizedTier] || 0);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const t1 = Number(AUTONOMY_DIRECTIVE_PULSE_T1_MIN_SHARE || 0);
    const t2 = Number(AUTONOMY_DIRECTIVE_PULSE_T2_MIN_SHARE || 0);
    const cacheKey = [
      Number.isFinite(tierRaw) ? String(tierRaw) : 'NaN',
      String(attemptsToday),
      String(current),
      String(t1),
      String(t2)
    ].join('\u0000');
    if (DIRECTIVE_TIER_COVERAGE_BONUS_CACHE.has(cacheKey)) {
      return DIRECTIVE_TIER_COVERAGE_BONUS_CACHE.get(cacheKey);
    }
    const rust = runBacklogAutoscalePrimitive(
      'directive_tier_coverage_bonus',
      {
        tier: Number.isFinite(tierRaw) ? tierRaw : null,
        fallback: 3,
        attempts_today: Number.isFinite(attemptsToday) ? attemptsToday : 0,
        current_for_tier: Number.isFinite(current) ? current : 0,
        t1_min_share: t1,
        t2_min_share: t2
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const bonus = clampNumber(Number(rust.payload.payload.bonus || 0), 0, 18);
      if (DIRECTIVE_TIER_COVERAGE_BONUS_CACHE.size >= DIRECTIVE_TIER_COVERAGE_BONUS_CACHE_MAX) {
        const oldest = DIRECTIVE_TIER_COVERAGE_BONUS_CACHE.keys().next();
        if (!oldest.done) DIRECTIVE_TIER_COVERAGE_BONUS_CACHE.delete(oldest.value);
      }
      DIRECTIVE_TIER_COVERAGE_BONUS_CACHE.set(cacheKey, bonus);
      return bonus;
    }
  }
  const minShare = directiveTierMinShare(tierRaw);
  if (attemptsToday <= 0) {
    if (normalizedTier <= 1) return 8;
    if (normalizedTier === 2) return 4;
    return 0;
  }
  if (minShare <= 0) return 0;
  const expected = Math.ceil(attemptsToday * minShare);
  const deficit = Math.max(0, expected - current);
  return Math.min(18, deficit * 6);
}

function assessDirectivePulse(p, directiveFitScore, compositeScore, overlay, pulseCtx, preferredObjectiveId = null) {
  if (!pulseCtx || pulseCtx.enabled !== true || pulseCtx.available !== true) {
    return {
      pass: true,
      score: 0,
      objective_id: null,
      tier: null,
      objective_allocation_score: 0,
      reasons: ['directive_pulse_unavailable']
    };
  }

  const objectives = Array.isArray(pulseCtx.objectives) ? pulseCtx.objectives : [];
  const text = proposalDirectiveText(p);
  const tokens = tokenizeDirectiveText(text);
  const tokenSet = new Set(tokens);
  const stemSet = new Set(tokens.map(toStem));

  const objectiveStatsById = pulseCtx.objective_stats instanceof Map ? pulseCtx.objective_stats : new Map();
  const scoreObjective = (obj) => {
    const phraseHits = (obj.phrases || []).filter(ph => text.includes(ph));
    const tokenHits = directiveTokenHits(tokenSet, stemSet, obj.tokens || []);
    const align = clampNumber(Math.round((phraseHits.length * 20) + (Math.min(6, tokenHits.length) * 8)), 0, 100);
    return {
      objective: obj,
      alignment: align,
      phrase_hits: phraseHits,
      token_hits: tokenHits
    };
  };

  const preferredId = sanitizeDirectiveObjectiveId(preferredObjectiveId || '');
  let best = null;
  if (preferredId) {
    const preferred = objectives.find((obj) => String(obj && obj.id || '') === preferredId);
    if (!preferred) {
      return {
        pass: false,
        score: 0,
        objective_id: preferredId,
        tier: null,
        objective_allocation_score: 0,
        reasons: ['objective_binding_invalid'],
        matched_positive: []
      };
    }
    best = scoreObjective(preferred);
  } else {
    for (const obj of objectives) {
      const scored = scoreObjective(obj);
      if (!best || scored.alignment > best.alignment || (scored.alignment === best.alignment && Number(obj.tier || 9) < Number(best.objective.tier || 9))) {
        best = scored;
      }
    }
  }

  if (!best) {
    const weak = clampNumber(Math.round((Number(directiveFitScore || 0) * 0.35) + (Number(compositeScore || 0) * 0.15)), 0, 40);
    return {
      pass: true,
      score: weak,
      objective_id: null,
      tier: null,
      alignment: 0,
      objective_allocation_score: 0,
      urgency: 1,
      evidence_gap_multiplier: 1,
      retry_penalty: 0,
      coverage_bonus: 0,
      reasons: ['no_objective_match'],
      matched_positive: []
    };
  }

  if (best.alignment <= 0 && !preferredId) {
    const weak = clampNumber(Math.round((Number(directiveFitScore || 0) * 0.35) + (Number(compositeScore || 0) * 0.15)), 0, 40);
    return {
      pass: true,
      score: weak,
      objective_id: null,
      tier: null,
      alignment: 0,
      objective_allocation_score: 0,
      urgency: 1,
      evidence_gap_multiplier: 1,
      retry_penalty: 0,
      coverage_bonus: 0,
      reasons: ['no_objective_match'],
      matched_positive: []
    };
  }

  const obj = best.objective;
  const stats = objectiveStatsById.get(obj.id) || null;
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const proposalCurrency = normalizeValueCurrencyToken(
    meta.value_oracle_primary_currency
    || listValueCurrencies(meta.value_oracle_matched_currencies)[0]
    || listValueCurrencies(meta.value_oracle_active_currencies)[0]
    || ''
  );
  const objectiveCurrencies = listValueCurrencies(
    []
      .concat(asStringArray(obj && obj.value_currencies))
      .concat(asStringArray(obj && obj.primary_currency))
  );
  const primaryObjectiveCurrency = objectiveCurrencies.length > 0 ? objectiveCurrencies[0] : null;
  const valueCurrencyAlignment = (
    proposalCurrency && objectiveCurrencies.length > 0
      ? (objectiveCurrencies.includes(proposalCurrency) ? 1 : -1)
      : 0
  );
  const valueCurrencyBonus = valueCurrencyAlignment > 0 ? 10 : (valueCurrencyAlignment < 0 ? -6 : 0);
  if (pulseObjectiveCooldownActive(stats, pulseCtx)) {
    return {
      pass: false,
      score: 0,
      objective_id: obj.id,
      tier: obj.tier,
      alignment: best.alignment,
      objective_allocation_score: 0,
      reasons: ['objective_cooldown_active'],
      cooldown: {
        no_progress_streak: Number(stats && stats.no_progress_streak || 0),
        cooldown_hours: Number(pulseCtx.cooldown_hours || AUTONOMY_DIRECTIVE_PULSE_COOLDOWN_HOURS),
        last_attempt_ts: stats && stats.last_attempt_ts ? String(stats.last_attempt_ts) : null
      },
      proposal_value_currency: proposalCurrency || null,
      objective_primary_currency: primaryObjectiveCurrency,
      objective_value_currencies: objectiveCurrencies,
      value_currency_alignment: valueCurrencyAlignment,
      matched_positive: uniqSorted([...(best.phrase_hits || []), ...(best.token_hits || [])]).slice(0, 6)
    };
  }

  const nowMs = Date.now();
  let urgency = 1.15;
  const lastAttempt = parseIsoTs(stats && stats.last_attempt_ts);
  if (lastAttempt) {
    const ageHours = (nowMs - lastAttempt.getTime()) / (1000 * 60 * 60);
    const horizon = Math.max(1, Number(pulseCtx.urgency_hours || AUTONOMY_DIRECTIVE_PULSE_URGENCY_HOURS));
    urgency = clampNumber(ageHours / horizon, 0.6, 1.8);
  }

  const attempts = Number(stats && stats.attempts || 0);
  const shipped = Number(stats && stats.shipped || 0);
  const shippedRate = attempts > 0 ? shipped / attempts : 0;
  let evidenceGapMultiplier = 1.0;
  if (attempts === 0) evidenceGapMultiplier = 1.15;
  else if (shippedRate < 0.2) evidenceGapMultiplier = 1.12;
  else if (shippedRate > 0.6) evidenceGapMultiplier = 0.95;

  const proposalNoChange = Number(overlay && overlay.outcomes && overlay.outcomes.no_change || 0);
  const proposalReverted = Number(overlay && overlay.outcomes && overlay.outcomes.reverted || 0);
  const objectiveNoProgress = Number(stats && stats.no_progress_streak || 0);
  const objectiveReverted = Number(stats && stats.reverted || 0);
  const retryPenalty = Math.min(45, (proposalNoChange * 6) + (proposalReverted * 10) + (objectiveNoProgress * 8));
  const coverageBonus = pulseTierCoverageBonus(obj.tier, pulseCtx);
  const allocationRaw = (
    (directiveTierWeight(obj.tier) * 22)
    + (coverageBonus * 2)
    + ((1 - clampNumber(shippedRate, 0, 1)) * 28)
    + (Math.max(0, urgency - 1) * 15)
    + (attempts === 0 ? 12 : 0)
    + valueCurrencyBonus
    - (objectiveNoProgress * 12)
    - (objectiveReverted * 6)
  );
  const objectiveAllocationScore = clampNumber(Math.round(allocationRaw), 0, 100);

  const base = (
    (best.alignment * 0.55)
    + (clampNumber(Number(directiveFitScore || 0), 0, 100) * 0.25)
    + (clampNumber(Number(compositeScore || 0), 0, 100) * 0.2)
  );
  const weighted = (base * Number(obj.tier_weight || 1) * urgency * evidenceGapMultiplier) - retryPenalty + coverageBonus;
  const score = clampNumber(Math.round(weighted), 0, 100);

  return {
    pass: true,
    score,
    objective_id: obj.id,
    tier: obj.tier,
    alignment: best.alignment,
    objective_allocation_score: objectiveAllocationScore,
    urgency: Number(urgency.toFixed(3)),
    evidence_gap_multiplier: Number(evidenceGapMultiplier.toFixed(3)),
    retry_penalty: Number(retryPenalty.toFixed(3)),
    coverage_bonus: Number(coverageBonus.toFixed(3)),
    reasons: [],
    proposal_value_currency: proposalCurrency || null,
    objective_primary_currency: primaryObjectiveCurrency,
    objective_value_currencies: objectiveCurrencies,
    value_currency_alignment: valueCurrencyAlignment,
    matched_positive: uniqSorted([...(best.phrase_hits || []), ...(best.token_hits || [])]).slice(0, 6)
  };
}

function directiveTierReservationNeed(eligible, pulseCtx) {
  if (!pulseCtx || pulseCtx.enabled !== true || pulseCtx.available !== true) return null;
  const candidates = Array.isArray(eligible) ? eligible : [];
  const attemptsToday = Math.max(0, Number(pulseCtx.attempts_today || 0));
  const byTier = pulseCtx.tier_attempts_today && typeof pulseCtx.tier_attempts_today === 'object'
    ? pulseCtx.tier_attempts_today
    : {};
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const candidateTiers = candidates.map((c) => normalizeDirectiveTier(c && c.directive_pulse && c.directive_pulse.tier, 99));
    const t1 = Number(AUTONOMY_DIRECTIVE_PULSE_T1_MIN_SHARE || 0);
    const t2 = Number(AUTONOMY_DIRECTIVE_PULSE_T2_MIN_SHARE || 0);
    const cacheKey = [
      String(attemptsToday),
      String(Math.max(0, Number(byTier[1] || 0))),
      String(Math.max(0, Number(byTier[2] || 0))),
      String(t1),
      String(t2),
      candidateTiers.join(',')
    ].join('\u0000');
    if (DIRECTIVE_TIER_RESERVATION_NEED_CACHE.has(cacheKey)) {
      return DIRECTIVE_TIER_RESERVATION_NEED_CACHE.get(cacheKey);
    }
    const rust = runBacklogAutoscalePrimitive(
      'directive_tier_reservation_need',
      {
        enabled: true,
        available: true,
        attempts_today: attemptsToday,
        tier1_attempts: Math.max(0, Number(byTier[1] || 0)),
        tier2_attempts: Math.max(0, Number(byTier[2] || 0)),
        tier1_min_share: t1,
        tier2_min_share: t2,
        candidate_tiers: candidateTiers
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      const reserve = payload.reserve === true;
      const reservation = reserve
        ? {
          tier: Math.max(1, Math.round(Number(payload.tier || 0))),
          min_share: Number(Number(payload.min_share || 0).toFixed(3)),
          attempts_today: attemptsToday,
          current_tier_attempts: Math.max(0, Number(payload.current_tier_attempts || 0)),
          required_after_next: Math.max(0, Number(payload.required_after_next || 0)),
          candidate_count: Math.max(0, Math.round(Number(payload.candidate_count || 0)))
        }
        : null;
      if (DIRECTIVE_TIER_RESERVATION_NEED_CACHE.size >= DIRECTIVE_TIER_RESERVATION_NEED_CACHE_MAX) {
        const oldest = DIRECTIVE_TIER_RESERVATION_NEED_CACHE.keys().next();
        if (!oldest.done) DIRECTIVE_TIER_RESERVATION_NEED_CACHE.delete(oldest.value);
      }
      DIRECTIVE_TIER_RESERVATION_NEED_CACHE.set(cacheKey, reservation);
      return reservation;
    }
  }
  const tiers = [1, 2];
  for (const tier of tiers) {
    const minShare = directiveTierMinShare(tier);
    if (!(minShare > 0)) continue;
    const current = Math.max(0, Number(byTier[tier] || 0));
    const requiredAfterNext = Math.ceil((attemptsToday + 1) * minShare);
    if (current >= requiredAfterNext) continue;
    const candidateCount = candidates.filter(c => normalizeDirectiveTier(c && c.directive_pulse && c.directive_pulse.tier, 99) === tier).length;
    return {
      tier,
      min_share: Number(minShare.toFixed(3)),
      attempts_today: attemptsToday,
      current_tier_attempts: current,
      required_after_next: requiredAfterNext,
      candidate_count: candidateCount
    };
  }
  return null;
}

function recentDirectivePulseCooldownCount(dateStr, objectiveId, hours) {
  const objId = String(objectiveId || '').trim();
  if (!objId) return 0;
  const h = Math.max(1, Number(hours || AUTONOMY_DIRECTIVE_PULSE_ESCALATE_WINDOW_HOURS));
  const days = Math.max(1, Math.ceil(h / 24) + 1);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const nowMs = Date.now();
    const rustEvents = [];
    for (const d of dateWindow(dateStr, days)) {
      for (const evt of readRuns(d)) {
        if (!evt || typeof evt !== 'object') continue;
        const sample = evt.sample_directive_pulse_cooldown && typeof evt.sample_directive_pulse_cooldown === 'object'
          ? evt.sample_directive_pulse_cooldown
          : null;
        rustEvents.push({
          event_type: String(evt.type || ''),
          result: String(evt.result || ''),
          ts: evt.ts ? String(evt.ts) : null,
          objective_id: evt.objective_id ? String(evt.objective_id) : null,
          sample_objective_id: sample && sample.objective_id ? String(sample.objective_id) : null
        });
      }
    }
    const rust = runBacklogAutoscalePrimitive(
      'recent_directive_pulse_cooldown_count',
      {
        objective_id: objId,
        hours: h,
        now_ms: nowMs,
        events: rustEvents
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Math.max(0, Number(rust.payload.payload.count || 0));
    }
  }
  const cutoff = Date.now() - (h * 60 * 60 * 1000);
  let count = 0;
  for (const d of dateWindow(dateStr, days)) {
    for (const evt of readRuns(d)) {
      if (!evt || evt.type !== 'autonomy_run') continue;
      if (String(evt.result || '') !== 'stop_repeat_gate_directive_pulse_cooldown') continue;
      const ts = parseIsoTs(evt.ts);
      if (!ts || ts.getTime() < cutoff) continue;
      const evtObjective = String(
        evt.objective_id
        || (evt.sample_directive_pulse_cooldown && evt.sample_directive_pulse_cooldown.objective_id)
        || ''
      ).trim();
      if (evtObjective !== objId) continue;
      count++;
    }
  }
  return count;
}

function ensureDirectivePulseEscalationProposal(dateStr, objectiveId, pulseCtx, sample) {
  const objId = String(objectiveId || '').trim();
  if (!objId) return { created: false, reason: 'missing_objective_id' };
  const proposals = loadProposalsForDate(dateStr);
  const existing = proposals.find((p) => (
    p
    && String(p.type || '') === 'directive_clarification'
    && p.meta
    && String(p.meta.directive_objective_id || '') === objId
  ));
  if (existing) {
    return { created: false, reason: 'already_exists', proposal_id: String(existing.id || '') };
  }

  const obj = pulseCtx
    && Array.isArray(pulseCtx.objectives)
    ? pulseCtx.objectives.find(o => String(o && o.id || '') === objId) || null
    : null;
  const tier = normalizeDirectiveTier(obj && obj.tier, 2);
  const titleTarget = String(obj && obj.title || objId);
  const proposalId = `PULSE-${crypto.createHash('sha256').update(`${dateStr}|${objId}|directive_clarify`).digest('hex').slice(0, 16)}`;
  const now = nowIso();
  const cooldownHours = Math.max(1, Number(pulseCtx && pulseCtx.cooldown_hours || AUTONOMY_DIRECTIVE_PULSE_COOLDOWN_HOURS));
  const noProgressLimit = Math.max(1, Number(pulseCtx && pulseCtx.no_progress_limit || AUTONOMY_DIRECTIVE_PULSE_NO_PROGRESS_LIMIT));

  const proposal = {
    id: proposalId,
    type: 'directive_clarification',
    title: `Clarify and replan directive objective: ${titleTarget}`,
    summary: `Repeated no-progress cooldowns for objective ${objId}. Clarify scope/metrics and define a bounded next experiment.`,
    expected_impact: tier <= 1 ? 'high' : 'medium',
    risk: 'low',
    validation: [
      'Define one explicit metric with target window',
      'Define one bounded next action with rollback condition',
      'Run one score-only preview and verify executable route'
    ],
    suggested_next_command: `node systems/security/directive_intake.js validate --id=${objId} --file=config/directives/${objId}.yaml`,
    evidence: [
      {
        source: 'autonomy_runs',
        path: `state/autonomy/runs/${dateStr}.jsonl`,
        match: `stop_repeat_gate_directive_pulse_cooldown objective=${objId}`,
        evidence_ref: `eye:directive_pulse/${objId}`
      }
    ],
    meta: {
      source_eye: 'directive_pulse',
      directive_objective_id: objId,
      directive_objective_tier: tier,
      directive_pulse_reason: 'repeated_no_progress_cooldown',
      cooldown_hours: cooldownHours,
      no_progress_limit: noProgressLimit,
      generated_at: now,
      topics: ['strategy', 'directive', 'autonomy', 'clarification'],
      signal_quality_score: 72,
      signal_quality_tier: 'medium',
      relevance_score: 78,
      relevance_tier: 'high'
    },
    notes: sample && sample.reasons
      ? `cooldown_reasons=${sample.reasons.join(',')}`
      : ''
  };

  const next = Array.isArray(proposals) ? proposals.slice() : [];
  next.push(proposal);
  const fp = path.join(PROPOSALS_DIR, `${dateStr}.json`);
  saveJson(fp, next);
  return { created: true, proposal_id: proposalId, objective_id: objId, date: dateStr };
}

function proposalDirectiveText(p) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'proposal_directive_text',
      { proposal: p && typeof p === 'object' ? p : {} },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return String(rust.payload.payload.text || '');
    }
  }
  const parts = [];
  parts.push(String((p && p.title) || ''));
  parts.push(String((p && p.type) || ''));
  parts.push(String((p && p.summary) || ''));
  parts.push(String((p && p.notes) || ''));
  parts.push(String((p && p.expected_impact) || ''));
  parts.push(String((p && p.risk) || ''));
  const meta = (p && p.meta) || {};
  parts.push(String(meta.preview || ''));
  parts.push(String(meta.url || ''));
  parts.push(String(meta.normalized_objective || ''));
  parts.push(String(meta.normalized_expected_outcome || ''));
  parts.push(String(meta.normalized_validation_metric || ''));
  if (Array.isArray(meta.normalized_hint_tokens)) parts.push(meta.normalized_hint_tokens.join(' '));
  if (Array.isArray(meta.normalized_archetypes)) parts.push(meta.normalized_archetypes.join(' '));
  if (Array.isArray(meta.topics)) parts.push(meta.topics.join(' '));
  if (Array.isArray(p && p.validation)) parts.push(p.validation.join(' '));
  if (Array.isArray(p && p.evidence)) {
    for (const ev of p.evidence) {
      parts.push(String((ev && ev.match) || ''));
      parts.push(String((ev && ev.evidence_ref) || ''));
    }
  }
  return normalizeDirectiveText(parts.join(' '));
}

function directiveTokenHits(textTokensSet, textStemSet, directiveTokens) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'directive_token_hits',
      {
        text_tokens: Array.from(textTokensSet || []),
        text_stems: Array.from(textStemSet || []),
        directive_tokens: Array.isArray(directiveTokens) ? directiveTokens : []
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const hits = Array.isArray(rust.payload.payload.hits)
        ? rust.payload.payload.hits.map((t) => String(t || '')).filter(Boolean)
        : [];
      return hits;
    }
  }
  const hits = [];
  for (const tok of directiveTokens) {
    if (textTokensSet.has(tok)) {
      hits.push(tok);
      continue;
    }
    const stem = toStem(tok);
    if (stem && textStemSet.has(stem)) hits.push(tok);
  }
  return hits;
}

function assessDirectiveFit(p, directiveProfile, thresholds) {
  const minDirectiveFit = Number((thresholds && thresholds.min_directive_fit) || AUTONOMY_MIN_DIRECTIVE_FIT);
  if (!directiveProfile || directiveProfile.available !== true) {
    return {
      pass: true,
      score: 100,
      profile_available: false,
      active_directive_ids: directiveProfile && Array.isArray(directiveProfile.active_directive_ids)
        ? directiveProfile.active_directive_ids
        : [],
      reasons: ['directive_profile_unavailable'],
      matched_positive: [],
      matched_negative: []
    };
  }

  const text = proposalDirectiveText(p);
  const tokens = tokenizeDirectiveText(text);
  const tokenSet = new Set(tokens);
  const stemSet = new Set(tokens.map(toStem));
  const posPhraseHits = directiveProfile.positive_phrases.filter(ph => text.includes(ph));
  const negPhraseHits = directiveProfile.negative_phrases.filter(ph => text.includes(ph));
  const posTokenHits = directiveTokenHits(tokenSet, stemSet, directiveProfile.positive_tokens);
  const negTokenHits = directiveTokenHits(tokenSet, stemSet, directiveProfile.negative_tokens);
  const strategyTokens = Array.isArray(directiveProfile.strategy_tokens)
    ? directiveProfile.strategy_tokens
    : [];
  const strategyHits = directiveTokenHits(tokenSet, stemSet, strategyTokens);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'directive_fit_assessment',
      {
        min_directive_fit: minDirectiveFit,
        profile_available: true,
        active_directive_ids: Array.isArray(directiveProfile.active_directive_ids)
          ? directiveProfile.active_directive_ids.map((x) => String(x || ''))
          : [],
        positive_phrase_hits: posPhraseHits,
        positive_token_hits: posTokenHits,
        strategy_hits: strategyHits,
        negative_phrase_hits: negPhraseHits,
        negative_token_hits: negTokenHits,
        strategy_token_count: strategyTokens.length,
        impact: p && p.expected_impact != null ? String(p.expected_impact) : null
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      return {
        pass: payload.pass === true,
        score: Number(payload.score || 0),
        profile_available: payload.profile_available !== false,
        active_directive_ids: Array.isArray(payload.active_directive_ids)
          ? payload.active_directive_ids.map((x) => String(x || '')).filter(Boolean)
          : [],
        matched_positive: Array.isArray(payload.matched_positive)
          ? payload.matched_positive.map((x) => String(x || '')).filter(Boolean)
          : [],
        matched_negative: Array.isArray(payload.matched_negative)
          ? payload.matched_negative.map((x) => String(x || '')).filter(Boolean)
          : [],
        reasons: Array.isArray(payload.reasons)
          ? payload.reasons.map((x) => String(x || '')).filter(Boolean)
          : []
      };
    }
  }

  let score = 30;
  score += posPhraseHits.length * 18;
  score += Math.min(30, posTokenHits.length * 5);
  score += Math.min(12, strategyHits.length * 4);
  score -= negPhraseHits.length * 20;
  score -= Math.min(24, negTokenHits.length * 6);

  const impact = String((p && p.expected_impact) || '').toLowerCase();
  if (impact === 'high') score += 6;
  else if (impact === 'medium') score += 3;

  const finalScore = clampNumber(Math.round(score), 0, 100);
  const reasons = [];
  if (posPhraseHits.length === 0 && posTokenHits.length === 0 && strategyHits.length === 0) reasons.push('no_directive_alignment');
  if (strategyTokens.length > 0 && strategyHits.length === 0) reasons.push('no_strategy_marker');
  if (negPhraseHits.length > 0 || negTokenHits.length > 0) reasons.push('matches_excluded_scope');
  const pass = finalScore >= minDirectiveFit;
  if (!pass) reasons.push('below_min_directive_fit');

  return {
    pass,
    score: finalScore,
    profile_available: true,
    active_directive_ids: directiveProfile.active_directive_ids,
    matched_positive: uniqSorted([...posPhraseHits, ...posTokenHits, ...strategyHits]).slice(0, 5),
    matched_negative: uniqSorted([...negPhraseHits, ...negTokenHits]).slice(0, 5),
    reasons
  };
}

function loadEyesMap() {
  const out = new Map();
  const cfg = loadJson(EYES_CONFIG_PATH, {});
  const state = loadJson(EYES_STATE_REGISTRY_PATH, {});
  const cfgEyes = Array.isArray(cfg && cfg.eyes) ? cfg.eyes : [];
  const stateEyes = Array.isArray(state && state.eyes) ? state.eyes : [];

  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'load_eyes_map',
      {
        cfg_eyes: cfgEyes,
        state_eyes: stateEyes
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      const rows = Array.isArray(payload.eyes) ? payload.eyes : [];
      for (const row of rows) {
        const id = String(row && row.id || '').trim();
        if (!id) continue;
        out.set(id, { ...(row && typeof row === 'object' ? row : {}) });
      }
      return out;
    }
  }

  for (const e of cfgEyes) {
    if (!e || !e.id) continue;
    out.set(String(e.id), { ...e });
  }
  for (const e of stateEyes) {
    if (!e || !e.id) continue;
    const id = String(e.id);
    out.set(id, { ...(out.get(id) || {}), ...e });
  }
  return out;
}

function assessSignalQuality(p, eyesMap, thresholds, calibrationProfile) {
  const minSignalQuality = Number((thresholds && thresholds.min_signal_quality) || AUTONOMY_MIN_SIGNAL_QUALITY);
  const minSensorySignal = Number((thresholds && thresholds.min_sensory_signal_score) || AUTONOMY_MIN_SENSORY_SIGNAL_SCORE);
  const minSensoryRelevance = Number((thresholds && thresholds.min_sensory_relevance_score) || AUTONOMY_MIN_SENSORY_RELEVANCE_SCORE);
  const minEyeScoreEma = Number((thresholds && thresholds.min_eye_score_ema) || AUTONOMY_MIN_EYE_SCORE_EMA);
  const eyeId = sourceEyeId(p);
  const eye = eyesMap.get(eyeId) || null;
  const title = normalizeSpaces(String((p && p.title) || '')).replace(/^\[[^\]]+\]\s*/g, '');
  const impact = String((p && p.expected_impact) || '').toLowerCase();
  const risk = String((p && p.risk) || '').toLowerCase();
  const url = String((p && p.meta && p.meta.url) || (Array.isArray(p && p.evidence) && p.evidence[0] && p.evidence[0].evidence_url) || '');
  const domain = urlDomain(url);
  const sensoryRelevanceRaw = Number(p && p.meta && p.meta.relevance_score);
  const sensoryRelevanceTier = String((p && p.meta && p.meta.relevance_tier) || '').toLowerCase();
  const sensoryScoreRaw = Number(p && p.meta && p.meta.signal_quality_score);
  const legacyScoreRaw = Number(p && p.meta && p.meta.score);
  const itemScoreRaw = Number.isFinite(sensoryScoreRaw) ? sensoryScoreRaw : legacyScoreRaw;
  const combinedItemScoreRaw = Number.isFinite(sensoryRelevanceRaw)
    ? ((Number.isFinite(itemScoreRaw) ? itemScoreRaw : sensoryRelevanceRaw) * 0.4) + (sensoryRelevanceRaw * 0.6)
    : itemScoreRaw;
  const sensoryTier = String((p && p.meta && p.meta.signal_quality_tier) || '').toLowerCase();
  const scoreSource = Number.isFinite(sensoryRelevanceRaw)
    ? 'sensory_relevance_score'
    : Number.isFinite(sensoryScoreRaw)
    ? 'sensory_signal_quality_score'
    : Number.isFinite(legacyScoreRaw)
      ? 'legacy_meta_score'
      : 'fallback_default';
  const titleHasStub = /\[stub\]/i.test(title);
  const urlScheme = url.startsWith('https://')
    ? 'https'
    : url.startsWith('http://')
      ? 'http'
      : '';
  const eyeKnown = !!eye;
  const eyeStatus = eye ? String(eye.status || '').toLowerCase() : '';
  const parserType = eye ? String(eye.parser_type || '').toLowerCase() : '';
  const eyeScoreEma = eye && Number.isFinite(Number(eye.score_ema)) ? Number(eye.score_ema) : null;
  const eyeProposedTotal = eye ? Number(eye.proposed_total || 0) : null;
  const eyeYieldRate = eye ? Number(eye.yield_rate) : null;
  const allowlist = Array.isArray(eye && eye.allowed_domains) ? eye.allowed_domains : [];
  const domainAllowlistEnforced = !!(domain && allowlist.length > 0);
  const domainAllowedByAllowlist = domainAllowlistEnforced
    ? domainAllowed(domain, allowlist)
    : true;
  const parserDisallowed = !!(parserType && AUTONOMY_DISALLOWED_PARSER_TYPES.has(parserType));
  const eyeBias = Number(
    calibrationProfile
      && calibrationProfile.eye_biases
      && calibrationProfile.eye_biases[eyeId]
      && calibrationProfile.eye_biases[eyeId].bias
  ) || 0;
  const topicBiases = [];
  const topics = Array.isArray(p && p.meta && p.meta.topics) ? p.meta.topics : [];
  for (const t of topics) {
    const key = String(t || '').toLowerCase();
    const b = Number(
      calibrationProfile
        && calibrationProfile.topic_biases
        && calibrationProfile.topic_biases[key]
        && calibrationProfile.topic_biases[key].bias
    );
    if (Number.isFinite(b)) topicBiases.push(b);
  }
  const topicBias = topicBiases.length ? (topicBiases.reduce((a, b) => a + b, 0) / topicBiases.length) : 0;
  const totalBias = eyeBias + topicBias;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'signal_quality_assessment',
      {
        min_signal_quality: minSignalQuality,
        min_sensory_signal: minSensorySignal,
        min_sensory_relevance: minSensoryRelevance,
        min_eye_score_ema: minEyeScoreEma,
        eye_id: eyeId || null,
        score_source: scoreSource,
        impact,
        risk,
        domain: domain || null,
        url_scheme: urlScheme || null,
        title_has_stub: titleHasStub === true,
        combined_item_score: Number.isFinite(combinedItemScoreRaw) ? combinedItemScoreRaw : null,
        sensory_relevance_score: Number.isFinite(sensoryRelevanceRaw) ? sensoryRelevanceRaw : null,
        sensory_relevance_tier: sensoryRelevanceTier || null,
        sensory_quality_score: Number.isFinite(sensoryScoreRaw) ? sensoryScoreRaw : null,
        sensory_quality_tier: sensoryTier || null,
        eye_known: eyeKnown === true,
        eye_status: eyeStatus || null,
        eye_score_ema: Number.isFinite(eyeScoreEma) ? eyeScoreEma : null,
        parser_type: parserType || null,
        parser_disallowed: parserDisallowed === true,
        domain_allowlist_enforced: domainAllowlistEnforced === true,
        domain_allowed: domainAllowedByAllowlist === true,
        eye_proposed_total: Number.isFinite(eyeProposedTotal) ? eyeProposedTotal : null,
        eye_yield_rate: Number.isFinite(eyeYieldRate) ? eyeYieldRate : null,
        calibration_eye_bias: eyeBias,
        calibration_topic_bias: topicBias
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      return {
        pass: payload.pass === true,
        score: Number(payload.score || 0),
        score_source: String(payload.score_source || scoreSource),
        eye_id: String(payload.eye_id || eyeId || ''),
        sensory_relevance_score: Number.isFinite(Number(payload.sensory_relevance_score))
          ? Number(payload.sensory_relevance_score)
          : null,
        sensory_relevance_tier: payload.sensory_relevance_tier ? String(payload.sensory_relevance_tier) : null,
        sensory_quality_score: Number.isFinite(Number(payload.sensory_quality_score))
          ? Number(payload.sensory_quality_score)
          : null,
        sensory_quality_tier: payload.sensory_quality_tier ? String(payload.sensory_quality_tier) : null,
        eye_status: payload.eye_status ? String(payload.eye_status) : null,
        eye_score_ema: Number.isFinite(Number(payload.eye_score_ema)) ? Number(payload.eye_score_ema) : null,
        parser_type: payload.parser_type ? String(payload.parser_type) : null,
        domain: payload.domain ? String(payload.domain) : null,
        calibration_eye_bias: Number(payload.calibration_eye_bias || 0),
        calibration_topic_bias: Number(payload.calibration_topic_bias || 0),
        calibration_total_bias: Number(payload.calibration_total_bias || 0),
        reasons: Array.isArray(payload.reasons)
          ? payload.reasons.map((x) => String(x || '')).filter(Boolean)
          : []
      };
    }
  }

  const reasons = [];
  let hardBlock = false;
  let score = 0;

  if (Number.isFinite(combinedItemScoreRaw)) {
    score += clampNumber(combinedItemScoreRaw, 0, 100);
  } else {
    score += 18;
    reasons.push('missing_meta_score');
  }

  if (Number.isFinite(sensoryRelevanceRaw) && sensoryRelevanceRaw < minSensoryRelevance) {
    hardBlock = true;
    reasons.push('sensory_relevance_low');
  }

  if (Number.isFinite(sensoryScoreRaw) && sensoryScoreRaw < minSensorySignal) {
    hardBlock = true;
    reasons.push('sensory_quality_low');
  }

  if (sensoryRelevanceTier === 'low') score -= 8;
  if (sensoryTier === 'low') score -= 8;

  if (impact === 'high') score += 12;
  else if (impact === 'medium') score += 6;

  if (risk === 'high') score -= 12;
  else if (risk === 'medium') score -= 6;

  if (url.startsWith('https://')) score += 6;
  else if (url.startsWith('http://')) score += 2;
  else score -= 8;

  if (titleHasStub) {
    score -= 40;
    hardBlock = true;
    reasons.push('stub_title');
  }

  if (eyeKnown) {

    if (Number.isFinite(eyeScoreEma)) {
      score += (eyeScoreEma - 50) * 0.35;
      if (eyeScoreEma < minEyeScoreEma) {
        hardBlock = true;
        reasons.push('eye_score_ema_low');
      }
    }

    if (eyeStatus === 'active') score += 4;
    else if (eyeStatus === 'probation') score -= 6;
    else if (eyeStatus === 'dormant') {
      score -= 18;
      hardBlock = true;
      reasons.push('eye_dormant');
    }

    if (parserDisallowed) {
      score -= 30;
      hardBlock = true;
      reasons.push(`parser_disallowed:${parserType}`);
    }

    if (domainAllowlistEnforced && !domainAllowedByAllowlist) {
      // Eyes often collect from feed domains but point to third-party article domains.
      // Treat this as a weak signal, not a hard block.
      score -= 3;
      reasons.push('domain_outside_allowlist');
    }

    if (eyeProposedTotal >= 3 && Number.isFinite(eyeYieldRate)) {
      score += (eyeYieldRate * 15) - 5;
      if (eyeYieldRate < 0.1) reasons.push('eye_yield_low');
    }
  } else {
    reasons.push('eye_unknown');
  }

  if (Number.isFinite(totalBias) && totalBias !== 0) {
    score -= totalBias;
    reasons.push(totalBias > 0 ? 'calibration_penalty' : 'calibration_bonus');
  }

  const finalScore = clampNumber(Math.round(score), 0, 100);
  const pass = !hardBlock && finalScore >= minSignalQuality;
  if (!pass && finalScore < minSignalQuality) reasons.push('below_min_signal_quality');

  return {
    pass,
    score: finalScore,
    score_source: scoreSource,
    eye_id: eyeId,
    sensory_relevance_score: Number.isFinite(sensoryRelevanceRaw) ? sensoryRelevanceRaw : null,
    sensory_relevance_tier: sensoryRelevanceTier || null,
    sensory_quality_score: Number.isFinite(sensoryScoreRaw) ? sensoryScoreRaw : null,
    sensory_quality_tier: sensoryTier || null,
    eye_status: eye ? String(eye.status || '') : null,
    eye_score_ema: eye && Number.isFinite(Number(eye.score_ema)) ? Number(eye.score_ema) : null,
    parser_type: eye ? String(eye.parser_type || '') : null,
    domain: domain || null,
    calibration_eye_bias: eyeBias,
    calibration_topic_bias: Number(topicBias.toFixed(3)),
    calibration_total_bias: Number(totalBias.toFixed(3)),
    reasons
  };
}

function parseSuccessCriteriaRows(p) {
  const proposal = p && typeof p === 'object' ? p : {};
  const actionSpec = proposal.action_spec && typeof proposal.action_spec === 'object' ? proposal.action_spec : {};
  const actionRows = Array.isArray(actionSpec.success_criteria) ? actionSpec.success_criteria : [];
  const verifyRows = Array.isArray(actionSpec.verify) ? actionSpec.verify : [];
  const validationRows = Array.isArray(proposal.validation) ? proposal.validation : [];
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'parse_success_criteria_rows',
      {
        action_rows: actionRows,
        verify_rows: verifyRows,
        validation_rows: validationRows
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payloadRows = Array.isArray(rust.payload.payload.rows) ? rust.payload.payload.rows : [];
      return payloadRows
        .filter((row) => row && typeof row === 'object')
        .map((row) => ({
          source: String(row.source || ''),
          metric: String(row.metric || ''),
          target: String(row.target || '').slice(0, 140),
          measurable: row.measurable === true
        }))
        .filter((row) => row.target);
    }
  }
  const rows = [];

  const hasTimebound = (text) => {
    const clean = normalizeSpaces(text);
    if (!clean) return false;
    return SUCCESS_TIMEBOUND_RE.test(clean) || SUCCESS_RELAXED_RUN_HORIZON_RE.test(clean);
  };

  const structuredMeasurable = (metric, target, horizon) => {
    const m = normalizeSpaces(metric);
    const t = normalizeSpaces(target);
    const h = normalizeSpaces(horizon);
    if (!m || !t) return false;
    const metricLike = SUCCESS_METRIC_RE.test(m) || /[_-]/.test(m);
    const quantifiedTarget = /\d/.test(t) || SUCCESS_COMPARATOR_RE.test(t) || SUCCESS_METRIC_RE.test(t);
    const timebound = hasTimebound(`${h} ${t}`);
    return metricLike && (quantifiedTarget || timebound);
  };

  const pushText = (text, source) => {
    const clean = normalizeSpaces(text);
    if (!clean) return;
    const metricMatch = clean.match(SUCCESS_METRIC_RE);
    rows.push({
      source,
      metric: metricMatch ? String(metricMatch[1] || '').toLowerCase() : '',
      target: clean.slice(0, 140),
      measurable: SUCCESS_METRIC_RE.test(clean)
        && (hasTimebound(clean) || /\d/.test(clean) || SUCCESS_COMPARATOR_RE.test(clean))
    });
  };

  for (const row of actionRows) {
    if (!row) continue;
    if (typeof row === 'string') {
      pushText(row, 'action_spec.success_criteria');
      continue;
    }
    if (typeof row === 'object') {
      const metric = normalizeSpaces(row.metric || row.name || '');
      const target = normalizeSpaces(row.target || row.threshold || row.description || row.goal || '');
      const horizon = normalizeSpaces(row.horizon || row.window || row.by || '');
      const merged = normalizeSpaces([metric, target, horizon].filter(Boolean).join(' | '));
      if (!merged) continue;
      rows.push({
        source: 'action_spec.success_criteria',
        metric: metric.toLowerCase(),
        target: merged.slice(0, 140),
        measurable: structuredMeasurable(metric, target, horizon)
      });
    }
  }
  for (const row of verifyRows) pushText(row, 'action_spec.verify');
  for (const row of validationRows) pushText(row, 'validation');

  const dedupe = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${row.metric}|${row.target}`.toLowerCase();
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    out.push(row);
  }
  return out;
}

function criteriaPatternKeysForProposal(p, capabilityKeyHint = '') {
  const proposal = p && typeof p === 'object' ? p : {};
  const rows = parseSuccessCriteriaRows(proposal);
  const capKey = normalizeSpaces(capabilityKeyHint).toLowerCase()
    || String((capabilityDescriptor(proposal, parseActuationSpec(proposal)) || {}).key || '').toLowerCase()
    || 'unknown';
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'criteria_pattern_keys',
      {
        capability_key_hint: normalizeSpaces(capabilityKeyHint).toLowerCase(),
        capability_descriptor_key: String((capabilityDescriptor(proposal, parseActuationSpec(proposal)) || {}).key || '').toLowerCase(),
        rows: rows.map((row) => ({ metric: row && row.metric != null ? String(row.metric) : null }))
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Array.isArray(rust.payload.payload.keys)
        ? rust.payload.payload.keys.map((x) => String(x || '')).filter(Boolean)
        : [];
    }
  }
  const keys = [];
  for (const row of rows) {
    const metric = normalizeCriteriaMetric(row && row.metric);
    if (!metric) continue;
    keys.push(`${capKey}|${metric}`);
  }
  return Array.from(new Set(keys)).sort();
}

function criteriaPatternPenaltyForProposal(p, capabilityKeyHint = '') {
  const keys = criteriaPatternKeysForProposal(p, capabilityKeyHint);
  if (!keys.length) {
    return {
      penalty: 0,
      hit_patterns: [],
      threshold: AUTONOMY_CRITERIA_PATTERN_FAIL_THRESHOLD
    };
  }
  const memory = loadCriteriaPatternMemory();
  const patterns = memory.patterns && typeof memory.patterns === 'object' ? memory.patterns : {};
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rustRows = keys.map((key) => {
      const row = patterns[key] && typeof patterns[key] === 'object' ? patterns[key] : {};
      return {
        key,
        failures: Number(row.failures || 0),
        passes: Number(row.passes || 0),
        last_failure_ts: row.last_failure_ts ? String(row.last_failure_ts) : null
      };
    });
    const rust = runBacklogAutoscalePrimitive(
      'criteria_pattern_penalty',
      {
        keys,
        patterns: rustRows,
        fail_threshold: Number(AUTONOMY_CRITERIA_PATTERN_FAIL_THRESHOLD || 0),
        penalty_per_hit: Number(AUTONOMY_CRITERIA_PATTERN_PENALTY_PER_HIT || 0),
        max_penalty: Number(AUTONOMY_CRITERIA_PATTERN_MAX_PENALTY || 0),
        window_days: Number(AUTONOMY_CRITERIA_PATTERN_WINDOW_DAYS || 0),
        now_ms: Date.now()
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  let penalty = 0;
  const hits = [];
  const windowMs = AUTONOMY_CRITERIA_PATTERN_WINDOW_DAYS * 24 * 3600 * 1000;
  const now = Date.now();
  for (const key of keys) {
    const row = patterns[key] && typeof patterns[key] === 'object' ? patterns[key] : null;
    if (!row) continue;
    const failTs = Date.parse(String(row.last_failure_ts || ''));
    if (Number.isFinite(failTs) && windowMs > 0 && (now - failTs) > windowMs) continue;
    const failures = Math.max(0, Number(row.failures || 0));
    const passes = Math.max(0, Number(row.passes || 0));
    const effectiveFailures = Math.max(0, failures - Math.floor(passes * 0.5));
    if (effectiveFailures < AUTONOMY_CRITERIA_PATTERN_FAIL_THRESHOLD) continue;
    const over = effectiveFailures - AUTONOMY_CRITERIA_PATTERN_FAIL_THRESHOLD + 1;
    const rowPenalty = over * AUTONOMY_CRITERIA_PATTERN_PENALTY_PER_HIT;
    penalty += rowPenalty;
    hits.push({
      key,
      failures,
      passes,
      effective_failures: effectiveFailures,
      penalty: rowPenalty
    });
  }
  return {
    penalty: Math.min(AUTONOMY_CRITERIA_PATTERN_MAX_PENALTY, Math.max(0, Math.round(penalty))),
    hit_patterns: hits.slice(0, 4),
    threshold: AUTONOMY_CRITERIA_PATTERN_FAIL_THRESHOLD
  };
}

function recordCriteriaPatternOutcome(p, capabilityKeyHint, criteria) {
  const src = criteria && typeof criteria === 'object' ? criteria : {};
  const checks = Array.isArray(src.checks) ? src.checks : [];
  if (!checks.length) return;
  const capKey = normalizeSpaces(capabilityKeyHint).toLowerCase()
    || String((capabilityDescriptor(p, parseActuationSpec(p)) || {}).key || '').toLowerCase()
    || 'unknown';
  const memory = loadCriteriaPatternMemory();
  const patterns = memory.patterns && typeof memory.patterns === 'object'
    ? memory.patterns
    : {};
  const touched = new Set();
  for (const check of checks) {
    const metric = normalizeCriteriaMetric(check && check.metric);
    if (!metric) continue;
    const key = `${capKey}|${metric}`;
    const row = patterns[key] && typeof patterns[key] === 'object'
      ? patterns[key]
      : { failures: 0, passes: 0, last_failure_ts: null, last_pass_ts: null };
    if (check.pass === false) {
      row.failures = Math.max(0, Number(row.failures || 0)) + 1;
      row.last_failure_ts = nowIso();
    } else if (check.pass === true) {
      row.passes = Math.max(0, Number(row.passes || 0)) + 1;
      row.last_pass_ts = nowIso();
    } else {
      continue;
    }
    patterns[key] = row;
    touched.add(key);
  }
  if (!touched.size) return;
  const windowMs = AUTONOMY_CRITERIA_PATTERN_WINDOW_DAYS * 24 * 3600 * 1000;
  const now = Date.now();
  for (const [key, row] of Object.entries(patterns)) {
    const r = row && typeof row === 'object' ? row : {};
    const failTs = Date.parse(String(r.last_failure_ts || ''));
    const passTs = Date.parse(String(r.last_pass_ts || ''));
    const latestTs = Number.isFinite(failTs) && Number.isFinite(passTs)
      ? Math.max(failTs, passTs)
      : (Number.isFinite(failTs) ? failTs : (Number.isFinite(passTs) ? passTs : null));
    if (latestTs == null) continue;
    if (windowMs > 0 && (now - latestTs) > windowMs) {
      delete patterns[key];
    }
  }
  saveCriteriaPatternMemory({
    version: '1.0',
    updated_at: nowIso(),
    patterns
  });
}

function successCriteriaRequirement() {
  const policy = outcomeFitnessPolicy();
  const src = policy && policy.proposal_filter_policy && typeof policy.proposal_filter_policy === 'object'
    ? policy.proposal_filter_policy
    : {};
  const fromPolicy = parseLowerList(
    src.success_criteria_exempt_types
      || src.success_criteria_exempt_proposal_types
      || src.exempt_success_criteria_types
      || []
  );
  const fromEnv = parseLowerList(process.env.AUTONOMY_SUCCESS_CRITERIA_EXEMPT_TYPES || '');
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'success_criteria_requirement',
      {
        require_success_criteria: src.require_success_criteria !== false,
        min_success_criteria_count: Number(src.min_success_criteria_count),
        policy_exempt_types: fromPolicy,
        env_exempt_types: fromEnv
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      return {
        required: payload.required !== false,
        min_count: clampNumber(Number(payload.min_count || 0), 0, 5),
        exempt_types: Array.isArray(payload.exempt_types)
          ? payload.exempt_types.map((x) => String(x || '').toLowerCase()).filter(Boolean)
          : []
      };
    }
  }
  const exemptTypes = Array.from(new Set([...fromPolicy, ...fromEnv]));
  return {
    required: src.require_success_criteria !== false,
    min_count: Number.isFinite(Number(src.min_success_criteria_count))
      ? clampNumber(src.min_success_criteria_count, 0, 5)
      : 1,
    exempt_types: exemptTypes
  };
}

function successCriteriaPolicyForProposal(proposal) {
  const base = successCriteriaRequirement();
  const proposalType = normalizeSpaces(proposal && proposal.type || '').toLowerCase();
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'success_criteria_policy_for_proposal',
      {
        base_required: base.required !== false,
        base_min_count: Number(base.min_count || 0),
        base_exempt_types: Array.isArray(base.exempt_types) ? base.exempt_types : [],
        proposal_type: proposalType || null
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      return {
        required: payload.required === true,
        min_count: Number(payload.min_count || 0),
        exempt: payload.exempt === true
      };
    }
  }
  const exempt = proposalType
    && Array.isArray(base.exempt_types)
    && base.exempt_types.includes(proposalType);
  return {
    required: base.required !== false && !exempt,
    min_count: Number(base.min_count || 0),
    exempt_types: Array.isArray(base.exempt_types) ? base.exempt_types : [],
    exempt_type: !!exempt
  };
}

function subDirectiveV2SignalsForProposal(proposal, opts: AnyObj = {}) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const type = normalizeSpaces(p.type).toLowerCase();
  const actionSpec = p.action_spec && typeof p.action_spec === 'object' ? p.action_spec : {};
  const nextCmd = normalizeSpaces(p.suggested_next_command);
  const executable = !!(nextCmd || (p && p.action_spec && typeof p.action_spec === 'object'));
  const required = AUTONOMY_SUBDIRECTIVE_V2_REQUIRED
    && executable
    && !AUTONOMY_SUBDIRECTIVE_V2_EXEMPT_TYPES.has(type);

  const targetRows = []
    .concat(normalizeSpaces(actionSpec.target))
    .concat(normalizeSpaces(actionSpec.file))
    .concat(normalizeSpaces(actionSpec.path))
    .concat(Array.isArray(actionSpec.files) ? actionSpec.files.map((row) => normalizeSpaces(row)) : [])
    .filter(Boolean);
  const hasTargetField = targetRows.some((row) => {
    const v = normalizeSpaces(row).toLowerCase();
    if (!v) return false;
    if (CONCRETE_TARGET_RE.test(v)) return true;
    if (v.includes('/')) return true;
    if (v.includes(':')) return true;
    return /\.[a-z0-9]{1,8}$/i.test(v);
  });
  const hasConcreteTarget = hasTargetField || CONCRETE_TARGET_RE.test(proposalTextBlob(p));

  const inferredDelta = inferOptimizationDeltaForProposal(p);
  const explicitDeltaCandidates = [
    Number(actionSpec.expected_delta_percent),
    Number(actionSpec.delta_percent),
    Number(actionSpec.expected_improvement_percent),
    Number(p.meta && p.meta.expected_delta_percent),
    Number(p.meta && p.meta.optimization_delta_percent)
  ];
  const hasExplicitDelta = explicitDeltaCandidates.some((n) => Number.isFinite(n) && n > 0);

  const successCriteriaRows = Array.isArray(opts && opts.success_criteria_rows)
    ? opts.success_criteria_rows
    : parseSuccessCriteriaRows(p);
  const hasSuccessCriteriaDelta = successCriteriaRows.some((row) => {
    const metric = normalizeSpaces(row && row.metric);
    const target = normalizeSpaces(row && row.target);
    const blob = normalizeSpaces(`${metric} ${target}`);
    return /\d/.test(blob) || /%|percent|delta|improv|increase|decrease|reduce|faster|slower|>=|<=|>|</i.test(blob);
  });
  const hasExpectedDelta = Number.isFinite(Number(inferredDelta && inferredDelta.delta_percent))
    || hasExplicitDelta
    || hasSuccessCriteriaDelta;

  const verifyRows = Array.isArray(actionSpec.verify) ? actionSpec.verify : [];
  const validationRows = Array.isArray(p.validation) ? p.validation : [];
  const hasVerificationStep = verifyRows.length > 0 || validationRows.length > 0 || successCriteriaRows.length > 0;

  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'subdirective_v2_signals',
      {
        required,
        has_concrete_target: hasConcreteTarget,
        has_expected_delta: hasExpectedDelta,
        has_verification_step: hasVerificationStep,
        target_count: targetRows.length,
        verify_count: verifyRows.length,
        success_criteria_count: successCriteriaRows.length
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }

  return {
    required,
    has_concrete_target: hasConcreteTarget,
    has_expected_delta: hasExpectedDelta,
    has_verification_step: hasVerificationStep,
    target_count: targetRows.length,
    verify_count: verifyRows.length,
    success_criteria_count: successCriteriaRows.length
  };
}

function assessActionability(p, directiveFit, thresholds) {
  const minActionability = Number((thresholds && thresholds.min_actionability_score) || AUTONOMY_MIN_ACTIONABILITY_SCORE);
  const risk = normalizedRisk(p && p.risk);
  const title = String((p && p.title) || '');
  const impact = String((p && p.expected_impact) || '').toLowerCase();
  const validation = Array.isArray(p && p.validation)
    ? p.validation.map(v => normalizeSpaces(v)).filter(Boolean)
    : [];
  const nextCmd = String((p && p.suggested_next_command) || '').trim();
  const relevance = Number(p && p.meta && p.meta.relevance_score);
  const fitScore = Number((directiveFit && directiveFit.score) || (p && p.meta && p.meta.directive_fit_score));
  const specificValidation = validation.filter(v => !GENERIC_VALIDATION_RE.test(v));
  const evidenceBlob = Array.isArray(p && p.evidence)
    ? p.evidence.map(ev => normalizeSpaces((ev && ev.match) || '')).join(' ')
    : '';
  const taskMatch = nextCmd.match(/--task=\"([^\"]+)\"/);
  const taskText = taskMatch ? normalizeSpaces(taskMatch[1]) : '';
  const concreteBlob = normalizeSpaces([
    title,
    p && p.summary,
    taskText,
    evidenceBlob,
    specificValidation.join(' ')
  ].join(' ')).toLowerCase();
  const hasActionVerb = ACTION_VERB_RE.test(title) || specificValidation.some(v => ACTION_VERB_RE.test(String(v || '')));
  const hasOpportunity = OPPORTUNITY_MARKER_RE.test(concreteBlob);
  const hasConcreteTarget = CONCRETE_TARGET_RE.test(concreteBlob);
  const isMetaCoordination = META_COORDINATION_RE.test(concreteBlob);
  const isExplainer = EXPLAINER_TITLE_RE.test(String(title || '').toLowerCase());
  const genericRouteTask = GENERIC_ROUTE_TASK_RE.test(nextCmd);
  const criteriaRows = parseSuccessCriteriaRows(p);
  const measurableCriteriaCount = criteriaRows.filter((row) => row.measurable === true).length;
  const criteriaPolicy = successCriteriaPolicyForProposal(p);
  const capabilityKey = String((capabilityDescriptor(p, parseActuationSpec(p)) || {}).key || '').toLowerCase();
  const criteriaPatternPenalty = criteriaPatternPenaltyForProposal(p, capabilityKey);
  const isExecutableProposal = !!(nextCmd || (p && p.action_spec && typeof p.action_spec === 'object'));
  const subdirectiveV2 = subDirectiveV2SignalsForProposal(p, { success_criteria_rows: criteriaRows });
  const rollbackBlob = normalizeSpaces([
    p && p.rollback_plan,
    p && p.meta && p.meta.rollback_plan,
    p && p.action_spec && p.action_spec.rollback_command,
    specificValidation.join(' ')
  ].join(' ')).toLowerCase();
  const hasRollbackSignal = ROLLBACK_SIGNAL_RE.test(rollbackBlob) || ROLLBACK_SIGNAL_RE.test(concreteBlob);
  const criteriaRequirementApplied = isExecutableProposal && criteriaPolicy.required;
  const mentionsProposal = /\bproposals?\b/.test(concreteBlob);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'actionability_assessment',
      {
        min_actionability: minActionability,
        risk,
        impact,
        validation_count: validation.length,
        specific_validation_count: specificValidation.length,
        has_next_cmd: !!nextCmd,
        generic_route_task: genericRouteTask === true,
        next_cmd_has_dry_run: nextCmd.includes('--dry-run'),
        looks_like_discovery_cmd: /^open\s+["'][^"']+["']$/i.test(nextCmd),
        has_action_verb: hasActionVerb === true,
        has_opportunity: hasOpportunity === true,
        has_concrete_target: hasConcreteTarget === true,
        is_meta_coordination: isMetaCoordination === true,
        is_explainer: isExplainer === true,
        mentions_proposal: mentionsProposal === true,
        relevance_score: Number.isFinite(relevance) ? relevance : null,
        directive_fit_score: Number.isFinite(fitScore) ? fitScore : null,
        criteria_requirement_applied: criteriaRequirementApplied === true,
        criteria_exempt_type: criteriaPolicy.exempt_type === true,
        criteria_min_count: Number(criteriaPolicy.min_count || 0),
        measurable_criteria_count: measurableCriteriaCount,
        criteria_total_count: criteriaRows.length,
        criteria_pattern_penalty: Number(criteriaPatternPenalty.penalty || 0),
        criteria_pattern_hits: Array.isArray(criteriaPatternPenalty.hit_patterns)
          ? criteriaPatternPenalty.hit_patterns
          : [],
        is_executable_proposal: isExecutableProposal === true,
        has_rollback_signal: hasRollbackSignal === true,
        subdirective_required: subdirectiveV2.required === true,
        subdirective_has_concrete_target: subdirectiveV2.has_concrete_target === true,
        subdirective_has_expected_delta: subdirectiveV2.has_expected_delta === true,
        subdirective_has_verification_step: subdirectiveV2.has_verification_step === true,
        subdirective_target_count: Number(subdirectiveV2.target_count || 0),
        subdirective_verify_count: Number(subdirectiveV2.verify_count || 0),
        subdirective_success_criteria_count: Number(subdirectiveV2.success_criteria_count || 0)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      return {
        pass: payload.pass === true,
        score: Number(payload.score || 0),
        reasons: Array.isArray(payload.reasons)
          ? payload.reasons.map((x) => String(x || '')).filter(Boolean)
          : [],
        executable: payload.executable === true,
        rollback_signal: payload.rollback_signal === true,
        generic_next_command_template: payload.generic_next_command_template === true,
        subdirective_v2: payload.subdirective_v2 && typeof payload.subdirective_v2 === 'object'
          ? payload.subdirective_v2
          : {
              required: subdirectiveV2.required === true,
              has_concrete_target: subdirectiveV2.has_concrete_target === true,
              has_expected_delta: subdirectiveV2.has_expected_delta === true,
              has_verification_step: subdirectiveV2.has_verification_step === true,
              target_count: Number(subdirectiveV2.target_count || 0),
              verify_count: Number(subdirectiveV2.verify_count || 0),
              success_criteria_count: Number(subdirectiveV2.success_criteria_count || 0)
            },
        success_criteria: payload.success_criteria && typeof payload.success_criteria === 'object'
          ? payload.success_criteria
          : {
              required: criteriaRequirementApplied,
              exempt_type: criteriaPolicy.exempt_type === true,
              min_count: criteriaPolicy.min_count,
              measurable_count: measurableCriteriaCount,
              total_count: criteriaRows.length,
              pattern_penalty: criteriaPatternPenalty.penalty,
              pattern_hits: criteriaPatternPenalty.hit_patterns
            }
      };
    }
  }
  const reasons = [];
  let score = 0;
  let hardBlock = false;

  if (impact === 'high') score += 24;
  else if (impact === 'medium') score += 16;
  else score += 8;

  if (specificValidation.length >= 3) score += 18;
  else if (specificValidation.length >= 2) score += 12;
  else if (specificValidation.length >= 1) score += 6;
  else if (validation.length > 0) reasons.push('generic_validation_template');
  else reasons.push('missing_validation_plan');

  if (nextCmd) {
    if (genericRouteTask) {
      score += 4;
      reasons.push('generic_next_command_template');
    } else {
      score += 8;
      if (!nextCmd.includes('--dry-run')) score += 4;
      else score += 2;
    }
  }
  else reasons.push('missing_next_command');

  const looksLikeDiscoveryCmd = /^open\s+["'][^"']+["']$/i.test(nextCmd);
  if (looksLikeDiscoveryCmd) {
    score -= 18;
    reasons.push('discovery_only_command');
  }

  if (hasActionVerb) {
    score += 12;
  } else {
    reasons.push('no_action_verb');
  }

  if (hasOpportunity) score += 10;

  if (Number.isFinite(relevance)) score += (relevance - 45) * 0.3;
  if (Number.isFinite(fitScore)) score += (fitScore - 35) * 0.25;

  if (criteriaRequirementApplied) {
    if (measurableCriteriaCount >= criteriaPolicy.min_count) {
      score += Math.min(14, 8 + (measurableCriteriaCount * 2));
    } else {
      score -= 22;
      reasons.push('success_criteria_missing');
      hardBlock = true;
    }
  } else if (measurableCriteriaCount > 0) {
    score += Math.min(8, measurableCriteriaCount * 2);
  }

  if (!hasActionVerb && !hasOpportunity && !hasConcreteTarget) {
    score -= 20;
    reasons.push('missing_concrete_target');
  }
  if (isMetaCoordination && !hasConcreteTarget) {
    score -= 26;
    reasons.push('meta_coordination_without_concrete_target');
  }
  if (mentionsProposal && !hasConcreteTarget && !hasOpportunity) {
    score -= 12;
    reasons.push('proposal_recursion_without_target');
  }
  if (isExplainer && !hasActionVerb && !hasOpportunity) {
    score -= 12;
    reasons.push('explainer_without_execution_path');
  }
  if (genericRouteTask && specificValidation.length === 0 && !hasOpportunity && !hasConcreteTarget) {
    score -= 18;
    reasons.push('boilerplate_execution_path');
  }

  if (looksLikeDiscoveryCmd && impact === 'low' && !ACTION_VERB_RE.test(title)) {
    hardBlock = true;
    reasons.push('non_actionable_discovery_item');
  }
  if (isMetaCoordination && !hasConcreteTarget && impact === 'low' && !hasOpportunity) {
    hardBlock = true;
    reasons.push('non_actionable_meta_item');
  }

  if (criteriaPatternPenalty.penalty > 0) {
    score -= criteriaPatternPenalty.penalty;
    reasons.push('criteria_pattern_penalty');
  }

  if (risk === 'medium' && isExecutableProposal && !hasRollbackSignal) {
    score -= 28;
    reasons.push('medium_risk_missing_rollback_path');
    hardBlock = true;
  }
  if (subdirectiveV2.required) {
    if (!subdirectiveV2.has_concrete_target) {
      score -= 18;
      reasons.push('subdirective_v2_missing_target');
      hardBlock = true;
    }
    if (!subdirectiveV2.has_expected_delta) {
      score -= 20;
      reasons.push('subdirective_v2_missing_expected_delta');
      hardBlock = true;
    }
    if (!subdirectiveV2.has_verification_step) {
      score -= 20;
      reasons.push('subdirective_v2_missing_verification_step');
      hardBlock = true;
    }
  }

  const finalScore = clampNumber(Math.round(score), 0, 100);
  const pass = !hardBlock && finalScore >= minActionability;
  if (!pass && finalScore < minActionability) reasons.push('below_min_actionability');

  return {
    pass,
    score: finalScore,
    reasons,
    executable: isExecutableProposal,
    rollback_signal: hasRollbackSignal,
    generic_next_command_template: genericRouteTask,
    subdirective_v2: subdirectiveV2,
    success_criteria: {
      required: criteriaRequirementApplied,
      exempt_type: criteriaPolicy.exempt_type === true,
      min_count: criteriaPolicy.min_count,
      measurable_count: measurableCriteriaCount,
      total_count: criteriaRows.length,
      pattern_penalty: criteriaPatternPenalty.penalty,
      pattern_hits: criteriaPatternPenalty.hit_patterns
    }
  };
}

function assessValueSignal(p, actionability, directiveFit) {
  const risk = normalizedRisk(p && p.risk);
  const minScore = Math.max(
    0,
    Number(AUTONOMY_MIN_VALUE_SIGNAL_SCORE || 0)
      + (risk === 'medium' ? Number(AUTONOMY_MEDIUM_RISK_VALUE_SIGNAL_BONUS || 0) : 0)
  );
  const expectedValue = expectedValueScore(p);
  const timeToValue = timeToValueScore(p);
  const actionabilityScore = clampNumber(Number(actionability && actionability.score || 0), 0, 100);
  const directiveFitScore = clampNumber(Number(directiveFit && directiveFit.score || 0), 0, 100);
  let score = NaN;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = [
      expectedValue,
      timeToValue,
      actionabilityScore,
      directiveFitScore
    ].join('\u0000');
    if (VALUE_SIGNAL_SCORE_CACHE.has(key)) {
      score = Number(VALUE_SIGNAL_SCORE_CACHE.get(key));
    } else {
      const rust = runBacklogAutoscalePrimitive(
        'value_signal_score',
        {
          expected_value: expectedValue,
          time_to_value: timeToValue,
          actionability: actionabilityScore,
          directive_fit: directiveFitScore
        },
        { allow_cli_fallback: true }
      );
      if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
        score = Number(rust.payload.payload.score || 0);
        if (VALUE_SIGNAL_SCORE_CACHE.size >= VALUE_SIGNAL_SCORE_CACHE_MAX) {
          const oldest = VALUE_SIGNAL_SCORE_CACHE.keys().next();
          if (!oldest.done) VALUE_SIGNAL_SCORE_CACHE.delete(oldest.value);
        }
        VALUE_SIGNAL_SCORE_CACHE.set(key, score);
      }
    }
  }
  if (!Number.isFinite(score)) {
    score = 0;
    score += expectedValue * 0.52;
    score += timeToValue * 0.22;
    score += actionabilityScore * 0.18;
    score += directiveFitScore * 0.08;
  }
  const reasons = [];
  if (expectedValue < 35) reasons.push('low_expected_value');
  if (timeToValue < 35) reasons.push('slow_time_to_value');
  if (actionabilityScore < 50) reasons.push('weak_execution_path');
  const finalScore = clampNumber(Math.round(score), 0, 100);
  const pass = finalScore >= minScore;
  if (!pass) reasons.push('below_min_value_signal');
  return {
    pass,
    score: finalScore,
    min_score: minScore,
    components: {
      expected_value: expectedValue,
      time_to_value: timeToValue,
      actionability: actionabilityScore,
      directive_fit: directiveFitScore
    },
    reasons
  };
}

function compositeEligibilityScore(qualityScore, directiveFitScore, actionabilityScore) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const qRaw = Number(qualityScore || 0);
    const dRaw = Number(directiveFitScore || 0);
    const aRaw = Number(actionabilityScore || 0);
    const cacheKey = `${qRaw}\u0000${dRaw}\u0000${aRaw}`;
    if (COMPOSITE_ELIGIBILITY_SCORE_CACHE.has(cacheKey)) {
      return COMPOSITE_ELIGIBILITY_SCORE_CACHE.get(cacheKey);
    }
    const rust = runBacklogAutoscalePrimitive(
      'composite_eligibility_score',
      {
        quality_score: qRaw,
        directive_fit_score: dRaw,
        actionability_score: aRaw
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = clampNumber(Math.round(Number(rust.payload.payload.score || 0)), 0, 100);
      if (COMPOSITE_ELIGIBILITY_SCORE_CACHE.size >= COMPOSITE_ELIGIBILITY_SCORE_CACHE_MAX) {
        const oldest = COMPOSITE_ELIGIBILITY_SCORE_CACHE.keys().next();
        if (!oldest.done) COMPOSITE_ELIGIBILITY_SCORE_CACHE.delete(oldest.value);
      }
      COMPOSITE_ELIGIBILITY_SCORE_CACHE.set(cacheKey, val);
      return val;
    }
  }
  const q = clampNumber(Number(qualityScore || 0), 0, 100);
  const d = clampNumber(Number(directiveFitScore || 0), 0, 100);
  const a = clampNumber(Number(actionabilityScore || 0), 0, 100);
  const weighted = (q * 0.42) + (d * 0.26) + (a * 0.32);
  return clampNumber(Math.round(weighted), 0, 100);
}

function countEyeProposalsInWindow(eyeId, endDateStr, days) {
  if (!eyeId) return 0;
  let count = 0;
  for (const d of dateWindow(endDateStr, days)) {
    for (const p of loadProposalsForDate(d)) {
      if (sourceEyeId(p) === eyeId) count++;
    }
  }
  return count;
}

function inWindow(ts, endDateStr, days) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const safeTs = String(ts || '');
    const safeEndDateStr = String(endDateStr || '').trim();
    const safeDays = Number(days);
    const key = `${safeTs}\u0000${safeEndDateStr}\u0000${safeDays}`;
    if (IN_WINDOW_CACHE.has(key)) {
      return IN_WINDOW_CACHE.get(key) === true;
    }
    const rust = runBacklogAutoscalePrimitive(
      'in_window',
      {
        ts: safeTs,
        end_date_str: safeEndDateStr,
        days: safeDays
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = rust.payload.payload.in_window === true;
      if (IN_WINDOW_CACHE.size >= IN_WINDOW_CACHE_MAX) {
        const oldest = IN_WINDOW_CACHE.keys().next();
        if (!oldest.done) IN_WINDOW_CACHE.delete(oldest.value);
      }
      IN_WINDOW_CACHE.set(key, val);
      return val;
    }
  }
  const t = parseIsoTs(ts);
  if (!t) return false;
  const end = new Date(`${endDateStr}T23:59:59.999Z`);
  if (isNaN(end.getTime())) return false;
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - (days - 1));
  start.setUTCHours(0, 0, 0, 0);
  return t >= start && t <= end;
}

function countEyeOutcomesInWindow(events, eyeRef, outcome, endDateStr, days) {
  if (!eyeRef) return 0;
  const rows = Array.isArray(events) ? events : [];
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const safeDays = Math.max(1, Math.floor(Number(days || 1)));
    const rustEvents = [];
    for (const evt of rows) {
      if (!evt || typeof evt !== 'object') continue;
      rustEvents.push({
        event_type: String(evt.type || ''),
        outcome: String(evt.outcome || ''),
        evidence_ref: String(evt.evidence_ref || ''),
        ts: String(evt.ts || '')
      });
    }
    const key = [
      String(eyeRef || ''),
      String(outcome || ''),
      String(endDateStr || ''),
      String(safeDays),
      rustEvents
        .map((row) => `${row.event_type}\u0000${row.outcome}\u0000${row.evidence_ref}\u0000${row.ts}`)
        .join('\u0001')
    ].join('\u0002');
    if (EYE_OUTCOME_COUNT_WINDOW_CACHE.has(key)) {
      return Number(EYE_OUTCOME_COUNT_WINDOW_CACHE.get(key) || 0);
    }
    const rust = runBacklogAutoscalePrimitive(
      'eye_outcome_count_window',
      {
        events: rustEvents,
        eye_ref: String(eyeRef || ''),
        outcome: String(outcome || ''),
        end_date_str: String(endDateStr || ''),
        days: safeDays
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = Math.max(0, Number(rust.payload.payload.count || 0));
      if (EYE_OUTCOME_COUNT_WINDOW_CACHE.size >= EYE_OUTCOME_COUNT_WINDOW_CACHE_MAX) {
        const oldest = EYE_OUTCOME_COUNT_WINDOW_CACHE.keys().next();
        if (!oldest.done) EYE_OUTCOME_COUNT_WINDOW_CACHE.delete(oldest.value);
      }
      EYE_OUTCOME_COUNT_WINDOW_CACHE.set(key, val);
      return val;
    }
  }
  let count = 0;
  for (const e of rows) {
    if (!e || e.type !== 'outcome') continue;
    if (String(e.outcome || '') !== String(outcome || '')) continue;
    if (!inWindow(e.ts, endDateStr, days)) continue;
    if (!String(e.evidence_ref || '').includes(eyeRef)) continue;
    count++;
  }
  return count;
}

function countEyeOutcomesInLastHours(events, eyeRef, outcome, hours) {
  if (!eyeRef || !hours || hours <= 0) return 0;
  const rows = Array.isArray(events) ? events : [];
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const safeHours = Number(hours);
    const nowMs = Date.now();
    const rustEvents = [];
    for (const evt of rows) {
      if (!evt || typeof evt !== 'object') continue;
      rustEvents.push({
        event_type: String(evt.type || ''),
        outcome: String(evt.outcome || ''),
        evidence_ref: String(evt.evidence_ref || ''),
        ts: String(evt.ts || '')
      });
    }
    const key = [
      String(eyeRef || ''),
      String(outcome || ''),
      String(safeHours),
      String(nowMs),
      rustEvents
        .map((row) => `${row.event_type}\u0000${row.outcome}\u0000${row.evidence_ref}\u0000${row.ts}`)
        .join('\u0001')
    ].join('\u0002');
    if (EYE_OUTCOME_COUNT_LAST_HOURS_CACHE.has(key)) {
      return Number(EYE_OUTCOME_COUNT_LAST_HOURS_CACHE.get(key) || 0);
    }
    const rust = runBacklogAutoscalePrimitive(
      'eye_outcome_count_last_hours',
      {
        events: rustEvents,
        eye_ref: String(eyeRef || ''),
        outcome: String(outcome || ''),
        hours: safeHours,
        now_ms: nowMs
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = Math.max(0, Number(rust.payload.payload.count || 0));
      if (EYE_OUTCOME_COUNT_LAST_HOURS_CACHE.size >= EYE_OUTCOME_COUNT_LAST_HOURS_CACHE_MAX) {
        const oldest = EYE_OUTCOME_COUNT_LAST_HOURS_CACHE.keys().next();
        if (!oldest.done) EYE_OUTCOME_COUNT_LAST_HOURS_CACHE.delete(oldest.value);
      }
      EYE_OUTCOME_COUNT_LAST_HOURS_CACHE.set(key, val);
      return val;
    }
  }
  const cutoff = Date.now() - (hours * 60 * 60 * 1000);
  let count = 0;
  for (const e of rows) {
    if (!e || e.type !== 'outcome') continue;
    if (String(e.outcome || '') !== String(outcome || '')) continue;
    if (!String(e.evidence_ref || '').includes(eyeRef)) continue;
    const d = parseIsoTs(e.ts);
    if (!d) continue;
    if (d.getTime() < cutoff) continue;
    count++;
  }
  return count;
}

function executeConfidenceHistoryMatch(evt, proposalType, capabilityKey) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const eventType = String(evt && evt.type || '');
    const eventCapabilityKey = String(evt && evt.capability_key || '');
    const eventProposalType = String(evt && evt.proposal_type || '');
    const safeProposalType = String(proposalType || '');
    const safeCapabilityKey = String(capabilityKey || '');
    const key = [
      eventType,
      eventCapabilityKey,
      eventProposalType,
      safeProposalType,
      safeCapabilityKey
    ].join('\u0000');
    if (EXECUTE_CONFIDENCE_HISTORY_MATCH_CACHE.has(key)) {
      return EXECUTE_CONFIDENCE_HISTORY_MATCH_CACHE.get(key) === true;
    }
    const rust = runBacklogAutoscalePrimitive(
      'execute_confidence_history_match',
      {
        event_type: eventType,
        event_capability_key: eventCapabilityKey,
        event_proposal_type: eventProposalType,
        proposal_type: safeProposalType,
        capability_key: safeCapabilityKey
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = rust.payload.payload.matched === true;
      if (EXECUTE_CONFIDENCE_HISTORY_MATCH_CACHE.size >= EXECUTE_CONFIDENCE_HISTORY_MATCH_CACHE_MAX) {
        const oldest = EXECUTE_CONFIDENCE_HISTORY_MATCH_CACHE.keys().next();
        if (!oldest.done) EXECUTE_CONFIDENCE_HISTORY_MATCH_CACHE.delete(oldest.value);
      }
      EXECUTE_CONFIDENCE_HISTORY_MATCH_CACHE.set(key, val);
      return val;
    }
  }
  if (!evt || evt.type !== 'autonomy_run') return false;
  const capKey = String(capabilityKey || '').trim().toLowerCase();
  const evtCap = String(evt.capability_key || '').trim().toLowerCase();
  if (capKey && evtCap) return evtCap === capKey;
  const type = String(proposalType || '').trim().toLowerCase();
  const evtType = String(evt.proposal_type || '').trim().toLowerCase();
  if (type && evtType) return evtType === type;
  return false;
}

function collectExecuteConfidenceHistory(dateStr, proposalType, capabilityKey, days = 7) {
  const windowDays = clampNumber(Number(days || 7), 1, 30);
  const normalizedProposalType = String(proposalType || '').trim().toLowerCase() || null;
  const normalizedCapabilityKey = String(capabilityKey || '').trim().toLowerCase() || null;
  const out = {
    window_days: windowDays,
    proposal_type: normalizedProposalType,
    capability_key: normalizedCapabilityKey,
    matched_events: 0,
    confidence_fallback: 0,
    route_blocked: 0,
    executed: 0,
    shipped: 0,
    no_change: 0,
    reverted: 0,
    no_change_rate: 0,
    reverted_rate: 0
  };
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rustEvents = [];
    for (const d of dateWindow(dateStr, windowDays)) {
      for (const evt of readRuns(d)) {
        rustEvents.push({
          matched: executeConfidenceHistoryMatch(evt, normalizedProposalType, normalizedCapabilityKey),
          result: evt && evt.result != null ? String(evt.result) : null,
          outcome: evt && evt.outcome != null ? String(evt.outcome) : null
        });
      }
    }
    const rust = runBacklogAutoscalePrimitive(
      'execute_confidence_history',
      {
        window_days: windowDays,
        proposal_type: normalizedProposalType,
        capability_key: normalizedCapabilityKey,
        events: rustEvents
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  for (const d of dateWindow(dateStr, windowDays)) {
    for (const evt of readRuns(d)) {
      if (!executeConfidenceHistoryMatch(evt, normalizedProposalType, normalizedCapabilityKey)) continue;
      out.matched_events += 1;
      const result = String(evt.result || '').trim();
      if (result === 'score_only_fallback_low_execution_confidence') {
        out.confidence_fallback += 1;
        continue;
      }
      if (result === 'score_only_fallback_route_block' || result === 'init_gate_blocked_route') {
        out.route_blocked += 1;
        continue;
      }
      if (result !== 'executed') continue;
      out.executed += 1;
      const outcome = String(evt.outcome || '').trim().toLowerCase();
      if (outcome === 'shipped') out.shipped += 1;
      else if (outcome === 'no_change') out.no_change += 1;
      else if (outcome === 'reverted') out.reverted += 1;
    }
  }
  if (out.executed > 0) {
    out.no_change_rate = Number((out.no_change / out.executed).toFixed(3));
    out.reverted_rate = Number((out.reverted / out.executed).toFixed(3));
  }
  return out;
}

function computeExecuteConfidencePolicy(dateStr, proposal, capabilityKey, proposalRisk, executionMode) {
  const type = String(proposal && proposal.type || '').trim().toLowerCase();
  const risk = normalizedRisk(proposalRisk);
  const baseCompositeMargin = Math.max(0, Number(AUTONOMY_EXECUTE_CONFIDENCE_MARGIN || 0));
  const baseValueMargin = Math.max(0, Number(AUTONOMY_EXECUTE_MIN_VALUE_SIGNAL_BONUS || 0));
  let compositeMargin = baseCompositeMargin;
  let valueMargin = baseValueMargin;
  const reasons = [];
  const history = collectExecuteConfidenceHistory(
    dateStr,
    type,
    capabilityKey,
    AUTONOMY_EXECUTE_CONFIDENCE_HISTORY_DAYS
  );
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'execute_confidence_policy',
      {
        proposal_type: type || null,
        capability_key: String(capabilityKey || '').trim().toLowerCase() || null,
        risk,
        execution_mode: String(executionMode || ''),
        adaptive_enabled: AUTONOMY_EXECUTE_CONFIDENCE_ADAPTIVE_ENABLED,
        base_composite_margin: baseCompositeMargin,
        base_value_margin: baseValueMargin,
        low_risk_relax_composite: AUTONOMY_EXECUTE_CONFIDENCE_LOW_RISK_RELAX_COMPOSITE,
        low_risk_relax_value: AUTONOMY_EXECUTE_CONFIDENCE_LOW_RISK_RELAX_VALUE,
        fallback_relax_every: AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_EVERY,
        fallback_relax_step: AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_STEP,
        fallback_relax_max: AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_MAX,
        fallback_relax_min_executed: AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_MIN_EXECUTED,
        fallback_relax_min_shipped: AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_MIN_SHIPPED,
        fallback_relax_min_ship_rate: AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_MIN_SHIP_RATE,
        no_change_tighten_min_executed: AUTONOMY_EXECUTE_CONFIDENCE_NO_CHANGE_TIGHTEN_MIN_EXECUTED,
        no_change_tighten_threshold: AUTONOMY_EXECUTE_CONFIDENCE_NO_CHANGE_TIGHTEN_THRESHOLD,
        no_change_tighten_step: AUTONOMY_EXECUTE_CONFIDENCE_NO_CHANGE_TIGHTEN_STEP,
        history
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.policy || {};
    }
  }
  if (
    AUTONOMY_EXECUTE_CONFIDENCE_ADAPTIVE_ENABLED
    && String(executionMode || '') === 'canary_execute'
    && risk === 'low'
  ) {
    compositeMargin = Math.max(0, compositeMargin - AUTONOMY_EXECUTE_CONFIDENCE_LOW_RISK_RELAX_COMPOSITE);
    valueMargin = Math.max(0, valueMargin - AUTONOMY_EXECUTE_CONFIDENCE_LOW_RISK_RELAX_VALUE);
    reasons.push('low_risk_canary_relax');
  }
  if (
    AUTONOMY_EXECUTE_CONFIDENCE_ADAPTIVE_ENABLED
    && history.reverted === 0
    && history.confidence_fallback >= AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_EVERY
  ) {
    const shipRate = history.executed > 0
      ? Number(history.shipped || 0) / Number(history.executed || 1)
      : 0;
    const relaxEligible = Number(history.executed || 0) >= AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_MIN_EXECUTED
      && Number(history.shipped || 0) >= AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_MIN_SHIPPED
      && shipRate >= AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_MIN_SHIP_RATE;
    if (relaxEligible) {
      const relaxSteps = Math.floor(history.confidence_fallback / AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_EVERY);
      const relaxRaw = relaxSteps * AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_STEP;
      const relax = clampNumber(relaxRaw, 0, AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_MAX);
      if (relax > 0) {
        compositeMargin = Math.max(0, compositeMargin - relax);
        valueMargin = Math.max(0, valueMargin - relax);
        reasons.push('fallback_churn_relax');
      }
    } else {
      reasons.push('fallback_churn_relax_blocked_low_success');
    }
  }
  if (
    AUTONOMY_EXECUTE_CONFIDENCE_ADAPTIVE_ENABLED
    && history.executed >= AUTONOMY_EXECUTE_CONFIDENCE_NO_CHANGE_TIGHTEN_MIN_EXECUTED
    && history.no_change_rate >= AUTONOMY_EXECUTE_CONFIDENCE_NO_CHANGE_TIGHTEN_THRESHOLD
  ) {
    compositeMargin += AUTONOMY_EXECUTE_CONFIDENCE_NO_CHANGE_TIGHTEN_STEP;
    valueMargin += AUTONOMY_EXECUTE_CONFIDENCE_NO_CHANGE_TIGHTEN_STEP;
    reasons.push('high_no_change_tighten');
  }
  if (history.reverted > 0) {
    compositeMargin = Math.max(compositeMargin, baseCompositeMargin);
    valueMargin = Math.max(valueMargin, baseValueMargin);
    reasons.push('reverted_restore_base');
  }
  return {
    adaptive_enabled: AUTONOMY_EXECUTE_CONFIDENCE_ADAPTIVE_ENABLED,
    proposal_type: type || null,
    capability_key: String(capabilityKey || '').trim().toLowerCase() || null,
    risk,
    execution_mode: String(executionMode || ''),
    base: {
      composite_margin: baseCompositeMargin,
      value_margin: baseValueMargin
    },
    applied: {
      composite_margin: Math.max(0, Number(compositeMargin || 0)),
      value_margin: Math.max(0, Number(valueMargin || 0))
    },
    history,
    fallback_relax_eligibility: {
      min_executed: AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_MIN_EXECUTED,
      min_shipped: AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_MIN_SHIPPED,
      min_ship_rate: AUTONOMY_EXECUTE_CONFIDENCE_FALLBACK_RELAX_MIN_SHIP_RATE,
      ship_rate: history.executed > 0
        ? Number((Number(history.shipped || 0) / Number(history.executed || 1)).toFixed(3))
        : 0
    },
    reasons
  };
}

function isRouteExecutionSampleEvent(evt) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'route_execution_sample_event',
      {
        event_type: evt && evt.type == null ? null : String(evt && evt.type || ''),
        result: evt && evt.result == null ? null : String(evt && evt.result || ''),
        execution_target: evt && evt.execution_target == null ? null : String(evt && evt.execution_target || ''),
        route_summary_present: !!(evt && evt.route_summary && typeof evt.route_summary === 'object')
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.is_sample_event === true;
    }
  }
  if (!evt || evt.type !== 'autonomy_run') return false;
  const result = String(evt.result || '').trim();
  if (!result) return false;
  if (result === 'score_only_fallback_route_block' || result === 'init_gate_blocked_route') return true;
  if (String(evt.execution_target || '').trim().toLowerCase() === 'route') {
    return result === 'executed';
  }
  if (result === 'executed' && evt.route_summary && typeof evt.route_summary === 'object') return true;
  return false;
}

function recentAutonomyRunEventsInLastHours(hours, maxEvents = 800) {
  const h = Math.max(1, Number(hours || 1));
  const cap = Math.max(50, Number(maxEvents || 800));
  const cutoffMs = Date.now() - (h * 60 * 60 * 1000);
  if (!fs.existsSync(RUNS_DIR)) return [];
  const files = fs.readdirSync(RUNS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort()
    .reverse();
  const orderedEvents = [];
  for (const file of files) {
    const rows = readJsonl(path.join(RUNS_DIR, file));
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      orderedEvents.push(rows[i]);
    }
  }
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'recent_autonomy_run_events',
      {
        events: orderedEvents,
        cutoff_ms: cutoffMs,
        cap
      },
      { allow_cli_fallback: true }
    );
    if (
      rust
      && rust.ok === true
      && rust.payload
      && rust.payload.ok === true
      && rust.payload.payload
      && Array.isArray(rust.payload.payload.events)
    ) {
      return rust.payload.payload.events;
    }
  }
  const out = [];
  for (const evt of orderedEvents) {
    if (!evt || evt.type !== 'autonomy_run') continue;
    const ts = parseIsoTs(evt.ts);
    if (!ts) continue;
    const tsMs = ts.getTime();
    if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;
    out.push(evt);
    if (out.length >= cap) return out;
  }
  return out;
}

function summarizeRecentRouteBlockTelemetry(hours, maxEvents = 800) {
  const events = recentAutonomyRunEventsInLastHours(hours, maxEvents);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'route_block_telemetry_summary',
      {
        events: events.map((evt) => ({
          event_type: evt && evt.type == null ? null : String(evt && evt.type || ''),
          result: evt && evt.result == null ? null : String(evt && evt.result || ''),
          execution_target: evt && evt.execution_target == null ? null : String(evt && evt.execution_target || ''),
          route_summary_present: !!(evt && evt.route_summary && typeof evt.route_summary === 'object'),
          capability_key: evt && evt.capability_key == null ? null : String(evt && evt.capability_key || '')
        })),
        window_hours: Number(hours || 1)
      },
      { allow_cli_fallback: true }
    );
    if (
      rust
      && rust.ok === true
      && rust.payload
      && rust.payload.ok === true
      && rust.payload.payload
      && Array.isArray(rust.payload.payload.by_capability)
    ) {
      const byCapability = {};
      for (const row of rust.payload.payload.by_capability) {
        const key = String(row && row.key || '').trim().toLowerCase();
        if (!key) continue;
        byCapability[key] = {
          attempts: Math.max(0, Number(row && row.attempts || 0)),
          route_blocked: Math.max(0, Number(row && row.route_blocked || 0)),
          route_block_rate: Math.max(0, Math.min(1, Number(row && row.route_block_rate || 0)))
        };
      }
      return {
        window_hours: Math.max(1, Number(rust.payload.payload.window_hours || hours || 1)),
        sample_events: Math.max(0, Number(rust.payload.payload.sample_events || events.length || 0)),
        by_capability: byCapability
      };
    }
  }
  const byCapability = {};
  for (const evt of events) {
    if (!isRouteExecutionSampleEvent(evt)) continue;
    const key = String(evt.capability_key || '').trim().toLowerCase();
    if (!key) continue;
    if (!byCapability[key]) {
      byCapability[key] = { attempts: 0, route_blocked: 0, route_block_rate: 0 };
    }
    byCapability[key].attempts += 1;
    if (evt.result === 'score_only_fallback_route_block' || evt.result === 'init_gate_blocked_route') {
      byCapability[key].route_blocked += 1;
    }
  }
  for (const key of Object.keys(byCapability)) {
    const row = byCapability[key];
    row.route_block_rate = row.attempts > 0
      ? Number((Number(row.route_blocked || 0) / Number(row.attempts || 1)).toFixed(3))
      : 0;
  }
  return {
    window_hours: Math.max(1, Number(hours || 1)),
    sample_events: events.length,
    by_capability: byCapability
  };
}

function evaluateRouteBlockPrefilter(telemetry, capabilityKey) {
  const key = String(capabilityKey || '').trim().toLowerCase();
  const rows = telemetry && telemetry.by_capability && typeof telemetry.by_capability === 'object'
    ? telemetry.by_capability
    : {};
  const row = rows[key] && typeof rows[key] === 'object' ? rows[key] : null;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'route_block_prefilter',
      {
        enabled: AUTONOMY_ROUTE_BLOCK_PREFILTER_ENABLED === true,
        capability_key: key || null,
        window_hours: Number(AUTONOMY_ROUTE_BLOCK_PREFILTER_WINDOW_HOURS || 0),
        min_observations: Number(AUTONOMY_ROUTE_BLOCK_PREFILTER_MIN_OBSERVATIONS || 0),
        max_block_rate: Number(AUTONOMY_ROUTE_BLOCK_PREFILTER_MAX_RATE || 0),
        row_present: !!row,
        attempts: Number(row && row.attempts || 0),
        route_blocked: Number(row && row.route_blocked || 0),
        route_block_rate: Number(row && row.route_block_rate || 0)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  const out = {
    enabled: AUTONOMY_ROUTE_BLOCK_PREFILTER_ENABLED,
    applicable: false,
    pass: true,
    reason: 'disabled',
    capability_key: key || null,
    window_hours: AUTONOMY_ROUTE_BLOCK_PREFILTER_WINDOW_HOURS,
    min_observations: AUTONOMY_ROUTE_BLOCK_PREFILTER_MIN_OBSERVATIONS,
    max_block_rate: AUTONOMY_ROUTE_BLOCK_PREFILTER_MAX_RATE,
    attempts: 0,
    route_blocked: 0,
    route_block_rate: 0
  };
  if (!AUTONOMY_ROUTE_BLOCK_PREFILTER_ENABLED) return out;
  out.reason = 'missing_capability_key';
  if (!key) return out;
  out.applicable = true;
  out.reason = 'no_recent_route_samples';
  if (!row) return out;
  out.attempts = Math.max(0, Number(row.attempts || 0));
  out.route_blocked = Math.max(0, Number(row.route_blocked || 0));
  out.route_block_rate = clampNumber(Number(row.route_block_rate || 0), 0, 1);
  if (out.attempts < AUTONOMY_ROUTE_BLOCK_PREFILTER_MIN_OBSERVATIONS) {
    out.reason = 'insufficient_observations';
    return out;
  }
  if (out.route_block_rate >= AUTONOMY_ROUTE_BLOCK_PREFILTER_MAX_RATE) {
    out.pass = false;
    out.reason = 'route_block_rate_exceeded';
    return out;
  }
  out.reason = 'pass';
  return out;
}

function summarizeRecentManualGateTelemetry(hours, maxEvents = 800) {
  const events = recentAutonomyRunEventsInLastHours(hours, maxEvents);
  const byCapability = {};
  for (const evt of events) {
    if (!isRouteExecutionSampleEvent(evt)) continue;
    const key = String(evt.capability_key || '').trim().toLowerCase();
    if (!key) continue;
    if (!byCapability[key]) {
      byCapability[key] = { attempts: 0, manual_blocked: 0, manual_block_rate: 0 };
    }
    byCapability[key].attempts += 1;
    const result = String(evt.result || '').trim();
    const blockReason = String(
      evt.route_block_reason
      || evt.hold_reason
      || evt.primary_failure
      || ''
    ).trim().toLowerCase();
    if (
      (result === 'score_only_fallback_route_block' || result === 'init_gate_blocked_route')
      && blockReason.includes('gate_manual')
    ) {
      byCapability[key].manual_blocked += 1;
    }
  }
  for (const key of Object.keys(byCapability)) {
    const row = byCapability[key];
    row.manual_block_rate = row.attempts > 0
      ? Number((Number(row.manual_blocked || 0) / Number(row.attempts || 1)).toFixed(3))
      : 0;
  }
  return {
    window_hours: Math.max(1, Number(hours || 1)),
    sample_events: events.length,
    by_capability: byCapability
  };
}

function evaluateManualGatePrefilter(telemetry, capabilityKey) {
  const key = String(capabilityKey || '').trim().toLowerCase();
  const rows = telemetry && telemetry.by_capability && typeof telemetry.by_capability === 'object'
    ? telemetry.by_capability
    : {};
  const row = rows[key] && typeof rows[key] === 'object' ? rows[key] : null;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'manual_gate_prefilter',
      {
        enabled: AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_ENABLED === true,
        capability_key: key || null,
        window_hours: Number(AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_WINDOW_HOURS || 0),
        min_observations: Number(AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_MIN_OBSERVATIONS || 0),
        max_manual_block_rate: Number(AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_MAX_RATE || 0),
        row_present: !!row,
        attempts: Number(row && row.attempts || 0),
        manual_blocked: Number(row && row.manual_blocked || 0),
        manual_block_rate: Number(row && row.manual_block_rate || 0)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  const out = {
    enabled: AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_ENABLED,
    applicable: false,
    pass: true,
    reason: 'disabled',
    capability_key: key || null,
    window_hours: AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_WINDOW_HOURS,
    min_observations: AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_MIN_OBSERVATIONS,
    max_manual_block_rate: AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_MAX_RATE,
    attempts: 0,
    manual_blocked: 0,
    manual_block_rate: 0
  };
  if (!AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_ENABLED) return out;
  out.reason = 'missing_capability_key';
  if (!key) return out;
  out.applicable = true;
  out.reason = 'no_recent_manual_gate_samples';
  if (!row) return out;
  out.attempts = Math.max(0, Number(row.attempts || 0));
  out.manual_blocked = Math.max(0, Number(row.manual_blocked || 0));
  out.manual_block_rate = clampNumber(Number(row.manual_block_rate || 0), 0, 1);
  if (out.attempts < AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_MIN_OBSERVATIONS) {
    out.reason = 'insufficient_observations';
    return out;
  }
  if (out.manual_block_rate >= AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_MAX_RATE) {
    out.pass = false;
    out.reason = 'manual_gate_rate_exceeded';
    return out;
  }
  out.reason = 'pass';
  return out;
}

function proposalStatus(overlayEnt) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const overlayDecision = String((overlayEnt && overlayEnt.decision) || '');
    if (PROPOSAL_STATUS_CACHE.has(overlayDecision)) {
      return PROPOSAL_STATUS_CACHE.get(overlayDecision);
    }
    const rust = runBacklogAutoscalePrimitive(
      'proposal_status',
      { overlay_decision: overlayDecision },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = String(rust.payload.payload.status || '').trim().toLowerCase();
      if (val) {
        if (PROPOSAL_STATUS_CACHE.size >= PROPOSAL_STATUS_CACHE_MAX) {
          const oldest = PROPOSAL_STATUS_CACHE.keys().next();
          if (!oldest.done) PROPOSAL_STATUS_CACHE.delete(oldest.value);
        }
        PROPOSAL_STATUS_CACHE.set(overlayDecision, val);
        return val;
      }
    }
  }
  if (!overlayEnt || !overlayEnt.decision) return 'pending';
  if (overlayEnt.decision === 'accept') return 'accepted';
  if (overlayEnt.decision === 'reject') return 'rejected';
  if (overlayEnt.decision === 'park') return 'parked';
  return 'pending';
}

function proposalOutcomeStatus(overlayEnt) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const overlayOutcome = String((overlayEnt && overlayEnt.outcome) || '');
    if (PROPOSAL_OUTCOME_STATUS_CACHE.has(overlayOutcome)) {
      return PROPOSAL_OUTCOME_STATUS_CACHE.get(overlayOutcome);
    }
    const rust = runBacklogAutoscalePrimitive(
      'proposal_outcome_status',
      { overlay_outcome: overlayOutcome },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const raw = rust.payload.payload.outcome;
      const val = raw == null ? null : String(raw || '').trim().toLowerCase();
      const normalized = val || null;
      if (PROPOSAL_OUTCOME_STATUS_CACHE.size >= PROPOSAL_OUTCOME_STATUS_CACHE_MAX) {
        const oldest = PROPOSAL_OUTCOME_STATUS_CACHE.keys().next();
        if (!oldest.done) PROPOSAL_OUTCOME_STATUS_CACHE.delete(oldest.value);
      }
      PROPOSAL_OUTCOME_STATUS_CACHE.set(overlayOutcome, normalized);
      return normalized;
    }
  }
  if (!overlayEnt || !overlayEnt.outcome) return null;
  const out = String(overlayEnt.outcome || '').trim().toLowerCase();
  if (!out) return null;
  return out;
}

function canQueueUnderflowBackfill(status, overlayEnt) {
  if (AUTONOMY_QUEUE_UNDERFLOW_BACKFILL_MAX <= 0) return false;
  const statusRaw = String(status || '');
  if (statusRaw !== 'accepted') return false;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const overlayOutcome = String((overlayEnt && overlayEnt.outcome) || '');
    const cacheKey = `${String(AUTONOMY_QUEUE_UNDERFLOW_BACKFILL_MAX)}\u0000${statusRaw}\u0000${overlayOutcome}`;
    if (QUEUE_UNDERFLOW_BACKFILL_CACHE.has(cacheKey)) {
      return QUEUE_UNDERFLOW_BACKFILL_CACHE.get(cacheKey) === true;
    }
    const rust = runBacklogAutoscalePrimitive(
      'queue_underflow_backfill',
      {
        underflow_backfill_max: Number(AUTONOMY_QUEUE_UNDERFLOW_BACKFILL_MAX) || 0,
        status: statusRaw,
        overlay_outcome: overlayOutcome
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = rust.payload.payload.allow === true;
      if (QUEUE_UNDERFLOW_BACKFILL_CACHE.size >= QUEUE_UNDERFLOW_BACKFILL_CACHE_MAX) {
        const oldest = QUEUE_UNDERFLOW_BACKFILL_CACHE.keys().next();
        if (!oldest.done) QUEUE_UNDERFLOW_BACKFILL_CACHE.delete(oldest.value);
      }
      QUEUE_UNDERFLOW_BACKFILL_CACHE.set(cacheKey, val);
      return val;
    }
  }
  const out = proposalOutcomeStatus(overlayEnt);
  return !out;
}

function proposalScore(p, overlayEnt, dateStr) {
  const impact = impactWeight(p);
  const risk = riskPenalty(p);
  const age = ageHours(dateStr);
  const stub = isStubProposal(p) === true;
  const noChange = Number(overlayEnt?.outcomes?.no_change || 0);
  const reverted = Number(overlayEnt?.outcomes?.reverted || 0);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = [
      impact,
      risk,
      age,
      stub ? 1 : 0,
      noChange,
      reverted
    ].join('\u0000');
    if (PROPOSAL_SCORE_CACHE.has(key)) {
      return PROPOSAL_SCORE_CACHE.get(key);
    }
    const rust = runBacklogAutoscalePrimitive(
      'proposal_score',
      {
        impact_weight: impact,
        risk_penalty: risk,
        age_hours: age,
        is_stub: stub,
        no_change_count: noChange,
        reverted_count: reverted
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = Number(rust.payload.payload.score || 0);
      if (PROPOSAL_SCORE_CACHE.size >= PROPOSAL_SCORE_CACHE_MAX) {
        const oldest = PROPOSAL_SCORE_CACHE.keys().next();
        if (!oldest.done) PROPOSAL_SCORE_CACHE.delete(oldest.value);
      }
      PROPOSAL_SCORE_CACHE.set(key, val);
      return val;
    }
  }
  const agePenalty = age / 24 * 0.6;
  const stubPenalty = stub ? 2.5 : 0;
  const noChangePenalty = noChange * 1.5;
  const revertedPenalty = reverted * 3.0;
  return (impact * 2.0) - (risk * 1.0) - agePenalty - stubPenalty - noChangePenalty - revertedPenalty;
}

function proposalRemediationDepth(p) {
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const raw = Number(meta.remediation_depth);
  const trigger = String(meta.trigger || '').toLowerCase();
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = `${Number.isFinite(raw) ? raw : 'nan'}\u0000${trigger}`;
    if (PROPOSAL_REMEDIATION_DEPTH_CACHE.has(key)) {
      return PROPOSAL_REMEDIATION_DEPTH_CACHE.get(key);
    }
    const rust = runBacklogAutoscalePrimitive(
      'proposal_remediation_depth',
      {
        remediation_depth: Number.isFinite(raw) ? raw : null,
        trigger
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = Number(rust.payload.payload.depth || 0);
      if (PROPOSAL_REMEDIATION_DEPTH_CACHE.size >= PROPOSAL_REMEDIATION_DEPTH_CACHE_MAX) {
        const oldest = PROPOSAL_REMEDIATION_DEPTH_CACHE.keys().next();
        if (!oldest.done) PROPOSAL_REMEDIATION_DEPTH_CACHE.delete(oldest.value);
      }
      PROPOSAL_REMEDIATION_DEPTH_CACHE.set(key, val);
      return val;
    }
  }
  if (Number.isFinite(raw) && raw >= 0) return Math.round(raw);
  if (trigger === 'consecutive_failures' || trigger === 'multi_eye_transport_failure') return 1;
  return 0;
}

function proposalDedupKey(p) {
  const type = String(p && p.type || 'unknown').toLowerCase();
  const eye = sourceEyeId(p);
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const remediationKind = String(meta.remediation_kind || '').toLowerCase();
  const proposalId = String(p && p.id || 'unknown');
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = `${type}\u0000${eye}\u0000${remediationKind}\u0000${proposalId}`;
    if (PROPOSAL_DEDUP_KEY_CACHE.has(key)) {
      return PROPOSAL_DEDUP_KEY_CACHE.get(key);
    }
    const rust = runBacklogAutoscalePrimitive(
      'proposal_dedup_key',
      {
        proposal_type: type,
        source_eye_id: eye,
        remediation_kind: remediationKind,
        proposal_id: proposalId
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = String(rust.payload.payload.dedup_key || '');
      if (PROPOSAL_DEDUP_KEY_CACHE.size >= PROPOSAL_DEDUP_KEY_CACHE_MAX) {
        const oldest = PROPOSAL_DEDUP_KEY_CACHE.keys().next();
        if (!oldest.done) PROPOSAL_DEDUP_KEY_CACHE.delete(oldest.value);
      }
      PROPOSAL_DEDUP_KEY_CACHE.set(key, val);
      return val;
    }
  }
  if (type.includes('remediation')) return `${type}|${eye}|${remediationKind || 'none'}`;
  return `${type}|${eye}|${proposalId}`;
}

function proposalSemanticObjectiveId(p) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'proposal_semantic_objective_id',
      { proposal: p && typeof p === 'object' ? p : {} },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return String(rust.payload.payload.objective_id || '');
    }
  }
  const proposal = p && typeof p === 'object' ? p : {};
  const meta = proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : {};
  const candidates = [
    meta.objective_id,
    meta.directive_objective_id,
    meta.linked_objective_id,
    parseDirectiveObjectiveArgFromCommand(proposal.suggested_next_command),
    parseDirectiveObjectiveArgFromCommand(proposal.suggested_command)
  ];
  for (const raw of candidates) {
    const id = sanitizeDirectiveObjectiveId(raw || '');
    if (id) return id;
  }
  return '';
}

function proposalSemanticFingerprint(p) {
  const proposal = p && typeof p === 'object' ? p : {};
  const type = String(proposal.type || '').trim().toLowerCase() || 'unknown';
  const sourceEye = String(sourceEyeId(proposal) || '').trim().toLowerCase();
  const objectiveId = proposalSemanticObjectiveId(proposal);
  const proposalId = normalizeSpaces(proposal.id) || null;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'proposal_semantic_fingerprint',
      {
        proposal_id: proposalId,
        proposal_type: type,
        source_eye: sourceEye || null,
        objective_id: objectiveId || null,
        text_blob: proposalTextBlob(proposal),
        stopwords: Array.from(DIRECTIVE_FIT_STOPWORDS),
        min_tokens: AUTONOMY_SEMANTIC_DEDUPE_MIN_TOKENS
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      const tokenStems = Array.isArray(payload.token_stems)
        ? payload.token_stems.map((tok) => String(tok || '').trim()).filter(Boolean)
        : [];
      const tokenCountRaw = Number(payload.token_count);
      const tokenCount = Number.isFinite(tokenCountRaw)
        ? Math.max(0, Math.round(tokenCountRaw))
        : tokenStems.length;
      return {
        proposal_id: payload.proposal_id || proposalId,
        proposal_type: String(payload.proposal_type || type || 'unknown').trim().toLowerCase() || 'unknown',
        source_eye: payload.source_eye ? String(payload.source_eye).trim().toLowerCase() : (sourceEye || null),
        objective_id: payload.objective_id ? String(payload.objective_id).trim() : (objectiveId || null),
        token_stems: tokenStems,
        token_count: tokenCount,
        eligible: payload.eligible === true
      };
    }
  }

  const tokenStems = uniqSorted(
    tokenizeDirectiveText(proposalTextBlob(proposal))
      .map((tok) => toStem(tok))
      .filter(Boolean)
  );
  return {
    proposal_id: proposalId,
    proposal_type: type,
    source_eye: sourceEye || null,
    objective_id: objectiveId || null,
    token_stems: tokenStems,
    token_count: tokenStems.length,
    eligible: tokenStems.length >= AUTONOMY_SEMANTIC_DEDUPE_MIN_TOKENS
  };
}

function semanticTokenSimilarity(aTokens, bTokens) {
  const aList = Array.isArray(aTokens) ? aTokens.map((v) => String(v || '').trim()).filter(Boolean) : [];
  const bList = Array.isArray(bTokens) ? bTokens.map((v) => String(v || '').trim()).filter(Boolean) : [];
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = `${aList.join('\u0001')}\u0000${bList.join('\u0001')}`;
    if (SEMANTIC_TOKEN_SIMILARITY_CACHE.has(key)) {
      return Number(SEMANTIC_TOKEN_SIMILARITY_CACHE.get(key) || 0);
    }
    const rust = runBacklogAutoscalePrimitive(
      'semantic_token_similarity',
      {
        left_tokens: aList,
        right_tokens: bList
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = Number(Number(rust.payload.payload.similarity || 0).toFixed(6));
      if (SEMANTIC_TOKEN_SIMILARITY_CACHE.size >= SEMANTIC_TOKEN_SIMILARITY_CACHE_MAX) {
        const oldest = SEMANTIC_TOKEN_SIMILARITY_CACHE.keys().next();
        if (!oldest.done) SEMANTIC_TOKEN_SIMILARITY_CACHE.delete(oldest.value);
      }
      SEMANTIC_TOKEN_SIMILARITY_CACHE.set(key, val);
      return val;
    }
  }
  const aSet = new Set(aList);
  const bSet = new Set(bList);
  if (!aSet.size || !bSet.size) return 0;
  let intersection = 0;
  for (const token of aSet) {
    if (bSet.has(token)) intersection += 1;
  }
  const union = (aSet.size + bSet.size) - intersection;
  if (!union) return 0;
  return Number((intersection / union).toFixed(6));
}

function semanticContextComparable(a, b) {
  const left = a && typeof a === 'object' ? a : {};
  const right = b && typeof b === 'object' ? b : {};
  const leftType = String(left.proposal_type || '').trim().toLowerCase();
  const rightType = String(right.proposal_type || '').trim().toLowerCase();
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const leftEye = String(left.source_eye || '').trim().toLowerCase();
    const rightEye = String(right.source_eye || '').trim().toLowerCase();
    const leftObjective = String(left.objective_id || '').trim();
    const rightObjective = String(right.objective_id || '').trim();
    const key = [
      leftType,
      rightType,
      leftEye,
      rightEye,
      leftObjective,
      rightObjective,
      AUTONOMY_SEMANTIC_DEDUPE_REQUIRE_SAME_TYPE ? '1' : '0',
      AUTONOMY_SEMANTIC_DEDUPE_REQUIRE_SHARED_CONTEXT ? '1' : '0'
    ].join('\u0000');
    if (SEMANTIC_CONTEXT_COMPARABLE_CACHE.has(key)) {
      return SEMANTIC_CONTEXT_COMPARABLE_CACHE.get(key) === true;
    }
    const rust = runBacklogAutoscalePrimitive(
      'semantic_context_comparable',
      {
        left_proposal_type: leftType,
        right_proposal_type: rightType,
        left_source_eye: leftEye,
        right_source_eye: rightEye,
        left_objective_id: leftObjective,
        right_objective_id: rightObjective,
        require_same_type: AUTONOMY_SEMANTIC_DEDUPE_REQUIRE_SAME_TYPE,
        require_shared_context: AUTONOMY_SEMANTIC_DEDUPE_REQUIRE_SHARED_CONTEXT
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const out = rust.payload.payload.comparable === true;
      if (SEMANTIC_CONTEXT_COMPARABLE_CACHE.size >= SEMANTIC_CONTEXT_COMPARABLE_CACHE_MAX) {
        const oldest = SEMANTIC_CONTEXT_COMPARABLE_CACHE.keys().next();
        if (!oldest.done) SEMANTIC_CONTEXT_COMPARABLE_CACHE.delete(oldest.value);
      }
      SEMANTIC_CONTEXT_COMPARABLE_CACHE.set(key, out);
      return out;
    }
  }
  if (AUTONOMY_SEMANTIC_DEDUPE_REQUIRE_SAME_TYPE && leftType && rightType && leftType !== rightType) {
    return false;
  }
  if (!AUTONOMY_SEMANTIC_DEDUPE_REQUIRE_SHARED_CONTEXT) return true;
  const leftEye = String(left.source_eye || '').trim().toLowerCase();
  const rightEye = String(right.source_eye || '').trim().toLowerCase();
  const leftObjective = String(left.objective_id || '').trim();
  const rightObjective = String(right.objective_id || '').trim();
  if (leftEye && rightEye && leftEye === rightEye) return true;
  if (leftObjective && rightObjective && leftObjective === rightObjective) return true;
  return false;
}

function semanticNearDuplicateMatch(fingerprint, seenFingerprints, minSimilarity = AUTONOMY_SEMANTIC_DEDUPE_THRESHOLD) {
  const fp = fingerprint && typeof fingerprint === 'object' ? fingerprint : null;
  if (!fp || fp.eligible !== true) return null;
  const seen = Array.isArray(seenFingerprints) ? seenFingerprints : [];
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const normalizeFingerprint = (row) => ({
      proposal_id: normalizeSpaces(row && row.proposal_id) || null,
      proposal_type: normalizeSpaces(row && row.proposal_type || '').toLowerCase() || null,
      source_eye: normalizeSpaces(row && row.source_eye || '').toLowerCase() || null,
      objective_id: normalizeSpaces(row && row.objective_id) || null,
      token_stems: Array.isArray(row && row.token_stems)
        ? row.token_stems.map((tok) => String(tok || '').trim()).filter(Boolean)
        : [],
      eligible: row && row.eligible === true
    });
    const minSimilarityRaw = Number(minSimilarity || AUTONOMY_SEMANTIC_DEDUPE_THRESHOLD);
    const minSimilarityNorm = Number.isFinite(minSimilarityRaw)
      ? minSimilarityRaw
      : Number(AUTONOMY_SEMANTIC_DEDUPE_THRESHOLD || 0);
    const normalizedFp = normalizeFingerprint(fp);
    const normalizedSeen = seen.map((row) => normalizeFingerprint(row));
    const key = JSON.stringify({
      fp: normalizedFp,
      seen: normalizedSeen,
      min_similarity: minSimilarityNorm,
      require_same_type: AUTONOMY_SEMANTIC_DEDUPE_REQUIRE_SAME_TYPE,
      require_shared_context: AUTONOMY_SEMANTIC_DEDUPE_REQUIRE_SHARED_CONTEXT
    });
    if (SEMANTIC_NEAR_DUPLICATE_MATCH_CACHE.has(key)) {
      return SEMANTIC_NEAR_DUPLICATE_MATCH_CACHE.get(key);
    }
    const rust = runBacklogAutoscalePrimitive(
      'semantic_near_duplicate_match',
      {
        fingerprint: normalizedFp,
        seen_fingerprints: normalizedSeen,
        min_similarity: minSimilarityNorm,
        require_same_type: AUTONOMY_SEMANTIC_DEDUPE_REQUIRE_SAME_TYPE,
        require_shared_context: AUTONOMY_SEMANTIC_DEDUPE_REQUIRE_SHARED_CONTEXT
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      const out = payload.matched === true
        ? {
          similarity: Number(Number(payload.similarity || 0).toFixed(6)),
          proposal_id: payload.proposal_id || null,
          proposal_type: payload.proposal_type || null,
          source_eye: payload.source_eye || null,
          objective_id: payload.objective_id || null
        }
        : null;
      if (SEMANTIC_NEAR_DUPLICATE_MATCH_CACHE.size >= SEMANTIC_NEAR_DUPLICATE_MATCH_CACHE_MAX) {
        const oldest = SEMANTIC_NEAR_DUPLICATE_MATCH_CACHE.keys().next();
        if (!oldest.done) SEMANTIC_NEAR_DUPLICATE_MATCH_CACHE.delete(oldest.value);
      }
      SEMANTIC_NEAR_DUPLICATE_MATCH_CACHE.set(key, out);
      return out;
    }
  }
  let best = null;
  for (const candidate of seen) {
    if (!candidate || candidate.eligible !== true) continue;
    if (!semanticContextComparable(fp, candidate)) continue;
    const similarity = semanticTokenSimilarity(fp.token_stems, candidate.token_stems);
    if (similarity < Number(minSimilarity || AUTONOMY_SEMANTIC_DEDUPE_THRESHOLD)) continue;
    if (!best || similarity > best.similarity) {
      best = {
        similarity,
        proposal_id: candidate.proposal_id || null,
        proposal_type: candidate.proposal_type || null,
        source_eye: candidate.source_eye || null,
        objective_id: candidate.objective_id || null
      };
    }
  }
  return best;
}

function proposalRiskScore(p) {
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const explicit = Number(meta.risk_score);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const riskRaw = String(p && p.risk || '');
    const explicitKey = Number.isFinite(explicit) ? String(explicit) : 'NaN';
    const cacheKey = `${explicitKey}\u0000${riskRaw}`;
    if (PROPOSAL_RISK_SCORE_CACHE.has(cacheKey)) {
      return PROPOSAL_RISK_SCORE_CACHE.get(cacheKey);
    }
    const rust = runBacklogAutoscalePrimitive(
      'proposal_risk_score',
      {
        explicit_risk_score: Number.isFinite(explicit) ? explicit : null,
        risk: riskRaw
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = clampNumber(Math.round(Number(rust.payload.payload.risk_score || 0)), 0, 100);
      if (PROPOSAL_RISK_SCORE_CACHE.size >= PROPOSAL_RISK_SCORE_CACHE_MAX) {
        const oldest = PROPOSAL_RISK_SCORE_CACHE.keys().next();
        if (!oldest.done) PROPOSAL_RISK_SCORE_CACHE.delete(oldest.value);
      }
      PROPOSAL_RISK_SCORE_CACHE.set(cacheKey, val);
      return val;
    }
  }
  if (Number.isFinite(explicit)) return clampNumber(Math.round(explicit), 0, 100);
  const risk = normalizedRisk(p && p.risk);
  if (risk === 'high') return 90;
  if (risk === 'medium') return 60;
  return 25;
}

function proposalAdmissionPreview(p) {
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const preview = meta && meta.admission_preview && typeof meta.admission_preview === 'object'
    ? meta.admission_preview
    : null;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'proposal_admission_preview',
      { admission_preview: preview },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payloadPreview = rust.payload.payload.preview;
      if (payloadPreview && typeof payloadPreview === 'object') return payloadPreview;
      return null;
    }
  }
  return preview;
}

function hasAdaptiveMutationSignal(p) {
  const proposal = p && typeof p === 'object' ? p : {};
  const meta = proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : {};
  const actionSpec = proposal.action_spec && typeof proposal.action_spec === 'object' ? proposal.action_spec : {};
  const type = String(proposal.type || '').trim();
  const blob = [
    String(proposal.title || ''),
    String(proposal.summary || ''),
    String(proposal.suggested_next_command || ''),
    String(actionSpec.kind || ''),
    String(actionSpec.target || ''),
    String(actionSpec.mutation_kind || ''),
    String(actionSpec.mutation_target || ''),
    String(actionSpec.topology_action || ''),
    String(actionSpec.genome_action || ''),
    String(actionSpec.self_modify_scope || ''),
    String(meta.mutation_kind || ''),
    String(meta.mutation_target || ''),
    String(meta.mutation_reason || ''),
    String(meta.mutation_lineage_id || ''),
    String(meta.topology_action || ''),
    String(meta.genome_action || ''),
    String(meta.self_modify_scope || '')
  ].join(' ');
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'has_adaptive_mutation_signal',
      {
        proposal_type: type,
        adaptive_mutation: meta.adaptive_mutation === true,
        mutation_proposal: meta.mutation_proposal === true,
        topology_mutation: meta.topology_mutation === true,
        self_improvement_change: meta.self_improvement_change === true,
        signal_blob: blob
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.has_signal === true;
    }
  }
  if (type && ADAPTIVE_MUTATION_TYPE_RE.test(type)) return true;
  if (meta.adaptive_mutation === true) return true;
  if (meta.mutation_proposal === true || meta.topology_mutation === true || meta.self_improvement_change === true) {
    return true;
  }
  if (!blob) return false;
  return ADAPTIVE_MUTATION_TYPE_RE.test(blob) || ADAPTIVE_MUTATION_SIGNAL_RE.test(blob);
}

function adaptiveMutationExecutionGuardDecision(p) {
  const proposal = p && typeof p === 'object' ? p : {};
  const meta = proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : {};
  const controls = meta.adaptive_mutation_guard_controls && typeof meta.adaptive_mutation_guard_controls === 'object'
    ? meta.adaptive_mutation_guard_controls
    : {};
  const applies = hasAdaptiveMutationSignal(proposal) || meta.adaptive_mutation_guard_applies === true;
  const safetyAttestation = String(
    controls.safety_attestation
    || meta.safety_attestation_id
    || meta.safety_attestation
    || meta.attestation_id
    || ''
  ).trim();
  const rollbackReceipt = String(
    controls.rollback_receipt
    || meta.rollback_receipt_id
    || meta.rollback_receipt
    || ''
  ).trim();
  const guardReceipt = String(
    controls.guard_receipt_id
    || meta.adaptive_mutation_guard_receipt_id
    || meta.mutation_guard_receipt_id
    || ''
  ).trim();
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'adaptive_mutation_execution_guard',
      {
        guard_required: AUTONOMY_MUTATION_EXECUTION_GUARD_REQUIRED,
        applies,
        metadata_applies: meta.adaptive_mutation_guard_applies === true,
        guard_pass: meta.adaptive_mutation_guard_pass !== false,
        guard_reason: meta.adaptive_mutation_guard_reason == null
          ? null
          : String(meta.adaptive_mutation_guard_reason || ''),
        safety_attestation: safetyAttestation || null,
        rollback_receipt: rollbackReceipt || null,
        guard_receipt_id: guardReceipt || null,
        mutation_kernel_applies: controls.mutation_kernel_applies === true,
        mutation_kernel_pass: controls.mutation_kernel_pass !== false
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      const controlsOut = payload.applies === true
        ? {
          safety_attestation: payload.controls && payload.controls.safety_attestation
            ? String(payload.controls.safety_attestation)
            : null,
          rollback_receipt: payload.controls && payload.controls.rollback_receipt
            ? String(payload.controls.rollback_receipt)
            : null,
          guard_receipt_id: payload.controls && payload.controls.guard_receipt_id
            ? String(payload.controls.guard_receipt_id)
            : null,
          mutation_kernel_applies: payload.controls && payload.controls.mutation_kernel_applies === true,
          mutation_kernel_pass: !(payload.controls && payload.controls.mutation_kernel_pass === false)
        }
        : {};
      return {
        required: payload.required !== false,
        applies: payload.applies === true,
        pass: payload.pass !== false,
        reason: payload.reason ? String(payload.reason) : null,
        reasons: Array.isArray(payload.reasons) ? payload.reasons.map((row) => String(row || '')).filter(Boolean) : [],
        controls: controlsOut
      };
    }
  }
  if (!AUTONOMY_MUTATION_EXECUTION_GUARD_REQUIRED) {
    return {
      required: false,
      applies: false,
      pass: true,
      reason: null,
      reasons: [],
      controls: {}
    };
  }
  if (!applies) {
    return {
      required: true,
      applies: false,
      pass: true,
      reason: null,
      reasons: [],
      controls: {}
    };
  }

  const reasons = [];
  if (meta.adaptive_mutation_guard_applies !== true) reasons.push('adaptive_mutation_guard_metadata_missing');
  if (meta.adaptive_mutation_guard_pass === false) {
    reasons.push(String(meta.adaptive_mutation_guard_reason || 'adaptive_mutation_guard_failed').trim() || 'adaptive_mutation_guard_failed');
  }
  if (!safetyAttestation) reasons.push('adaptive_mutation_missing_safety_attestation');
  if (!rollbackReceipt) reasons.push('adaptive_mutation_missing_rollback_receipt');
  if (!guardReceipt) reasons.push('adaptive_mutation_missing_execution_guard_receipt');
  if (controls.mutation_kernel_applies === true && controls.mutation_kernel_pass === false) {
    reasons.push('adaptive_mutation_kernel_failed');
  }

  const uniqReasons = Array.from(new Set(reasons.filter(Boolean)));
  return {
    required: true,
    applies: true,
    pass: uniqReasons.length === 0,
    reason: uniqReasons[0] || null,
    reasons: uniqReasons,
    controls: {
      safety_attestation: safetyAttestation || null,
      rollback_receipt: rollbackReceipt || null,
      guard_receipt_id: guardReceipt || null,
      mutation_kernel_applies: controls.mutation_kernel_applies === true,
      mutation_kernel_pass: controls.mutation_kernel_pass !== false
    }
  };
}

function recentProposalKeyCounts(dateStr, hours) {
  const out = new Map();
  const h = Number(hours || 0);
  if (!Number.isFinite(h) || h <= 0) return out;
  const cutoffMs = Date.now() - (h * 60 * 60 * 1000);
  const days = Math.max(1, Math.ceil(h / 24) + 1);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rustEvents = [];
    for (const d of dateWindow(dateStr, days)) {
      const rows = readRuns(d);
      for (const evt of rows) {
        if (!evt || evt.type !== 'autonomy_run') continue;
        rustEvents.push({
          proposal_key: evt.proposal_key == null ? null : String(evt.proposal_key),
          ts_ms: parseIsoTs(evt.ts)?.getTime() || null,
          result: evt.result == null ? null : String(evt.result),
          is_attempt: isAttemptRunEvent(evt)
        });
      }
    }
    const rust = runBacklogAutoscalePrimitive(
      'recent_proposal_key_counts',
      {
        events: rustEvents,
        cutoff_ms: cutoffMs
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const counts = rust.payload.payload.counts && typeof rust.payload.payload.counts === 'object'
        ? rust.payload.payload.counts
        : {};
      return new Map(
        Object.entries(counts).map(([key, count]) => [String(key), Number(count || 0)])
      );
    }
  }
  for (const d of dateWindow(dateStr, days)) {
    const rows = readRuns(d);
    for (const evt of rows) {
      if (!evt || evt.type !== 'autonomy_run') continue;
      const key = String(evt.proposal_key || '').trim();
      if (!key) continue;
      const t = parseIsoTs(evt.ts);
      if (!t || t.getTime() < cutoffMs) continue;
      const result = String(evt.result || '');
      if (
        result !== 'executed'
        && result !== 'score_only_preview'
        && result !== 'stop_repeat_gate_circuit_breaker'
        && !isAttemptRunEvent(evt)
      ) continue;
      out.set(key, Number(out.get(key) || 0) + 1);
    }
  }
  return out;
}

function strategyAdmissionDecision(p, strategy, opts: AnyObj = {}) {
  const preview = proposalAdmissionPreview(p);
  const blocked = Array.isArray(preview && preview.blocked_by) && preview.blocked_by.length
    ? preview.blocked_by.map((r) => String(r || '').trim()).filter(Boolean)
    : [];
  const mutationGuard = adaptiveMutationExecutionGuardDecision(p);
  const type = String(p && p.type || '').toLowerCase();
  const strategyTypeAllowed = strategyAllowsProposalType(strategy, type);
  const strategyMax = strategyMaxRiskPerAction(strategy, null);
  const hardMax = Number.isFinite(Number(AUTONOMY_HARD_MAX_RISK_PER_ACTION)) && Number(AUTONOMY_HARD_MAX_RISK_PER_ACTION) >= 0
    ? Number(AUTONOMY_HARD_MAX_RISK_PER_ACTION)
    : null;
  let maxRisk = strategyMax;
  if (hardMax != null) {
    maxRisk = maxRisk == null ? hardMax : Math.min(maxRisk, hardMax);
  }
  const riskScore = maxRisk != null ? proposalRiskScore(p) : null;
  const maxDepth = strategy
    && strategy.admission_policy
    && Number.isFinite(Number(strategy.admission_policy.max_remediation_depth))
      ? Number(strategy.admission_policy.max_remediation_depth)
      : null;
  const remediationCheckRequired = Number.isFinite(maxDepth) && type.includes('remediation');
  const remediationDepth = remediationCheckRequired ? proposalRemediationDepth(p) : 0;
  const dedupKey = String(opts.dedup_key || '').trim();
  const keyCounts = opts.recent_key_counts instanceof Map ? opts.recent_key_counts : null;
  const duplicateWindowHours = strategyDuplicateWindowHours(strategy, 24);
  const seen = dedupKey && keyCounts ? Number(keyCounts.get(dedupKey) || 0) : 0;

  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'strategy_admission_decision',
      {
        require_admission_preview: AUTONOMY_REQUIRE_ADMISSION_PREVIEW,
        preview_eligible: !(preview && preview.eligible === false),
        preview_blocked_by: blocked.slice(0, 6),
        mutation_guard: mutationGuard,
        strategy_type_allowed: strategyTypeAllowed,
        max_risk_per_action: maxRisk,
        strategy_max_risk_per_action: strategyMax,
        hard_max_risk_per_action: hardMax,
        risk_score: riskScore,
        remediation_check_required: remediationCheckRequired,
        remediation_depth: remediationDepth,
        remediation_max_depth: maxDepth,
        dedup_key: dedupKey || null,
        duplicate_window_hours: duplicateWindowHours,
        recent_count: seen
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      if (payload && payload.mutation_guard && mutationGuard) {
        payload.mutation_guard = {
          ...mutationGuard,
          ...payload.mutation_guard,
          required: mutationGuard.required
        };
      }
      return payload;
    }
  }

  if (AUTONOMY_REQUIRE_ADMISSION_PREVIEW && preview && preview.eligible === false) {
    return {
      allow: false,
      reason: blocked[0] || 'admission_preview_blocked',
      admission_preview: {
        eligible: false,
        blocked_by: blocked.slice(0, 6)
      }
    };
  }

  if (mutationGuard.applies && !mutationGuard.pass) {
    return {
      allow: false,
      reason: mutationGuard.reason || 'adaptive_mutation_execution_guard_blocked',
      mutation_guard: mutationGuard
    };
  }

  if (!strategyTypeAllowed) {
    return { allow: false, reason: 'strategy_type_filtered' };
  }
  if (maxRisk != null) {
    if (riskScore > maxRisk) {
      return {
        allow: false,
        reason: 'strategy_risk_cap_exceeded',
        risk_score: riskScore,
        max_risk_per_action: maxRisk,
        strategy_max_risk_per_action: strategyMax,
        hard_max_risk_per_action: hardMax
      };
    }
  }
  if (remediationCheckRequired) {
    if (remediationDepth > maxDepth) return { allow: false, reason: 'strategy_remediation_depth_exceeded' };
  }
  if (dedupKey && keyCounts) {
    if (seen > 0) {
      return {
        allow: false,
        reason: 'strategy_duplicate_window',
        duplicate_window_hours: duplicateWindowHours,
        recent_count: seen
      };
    }
  }
  return { allow: true, reason: null };
}

function capabilityDescriptor(p, actuationSpec) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'capability_descriptor',
      {
        actuation_kind: actuationSpec && actuationSpec.kind != null ? String(actuationSpec.kind) : null,
        proposal_type: p && p.type != null ? String(p.type) : null
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      return {
        key: String(payload.key || 'proposal:unknown'),
        aliases: Array.isArray(payload.aliases)
          ? payload.aliases.map((x) => String(x || '')).filter(Boolean)
          : []
      };
    }
  }
  if (actuationSpec && actuationSpec.kind) {
    const kind = String(actuationSpec.kind).trim().toLowerCase();
    return {
      key: kind ? `actuation:${kind}` : 'actuation:unknown',
      aliases: ['actuation']
    };
  }
  const type = String(p && p.type || 'unknown').trim().toLowerCase() || 'unknown';
  return {
    key: `proposal:${type}`,
    aliases: ['proposal']
  };
}

function capabilityCap(strategyBudget, descriptor) {
  const caps = strategyBudget && strategyBudget.per_capability_caps && typeof strategyBudget.per_capability_caps === 'object'
    ? strategyBudget.per_capability_caps
    : {};
  const keys = [descriptor && descriptor.key ? descriptor.key : null]
    .concat(Array.isArray(descriptor && descriptor.aliases) ? descriptor.aliases : [])
    .filter(Boolean);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const normalizedCaps = {};
    for (const [k, v] of Object.entries(caps)) {
      normalizedCaps[String(k)] = Number(v);
    }
    const key = JSON.stringify({
      caps: normalizedCaps,
      primary_key: keys[0] || null,
      aliases: keys.slice(1)
    });
    if (CAPABILITY_CAP_CACHE.has(key)) {
      const cached = CAPABILITY_CAP_CACHE.get(key);
      return cached == null ? null : Number(cached);
    }
    const rust = runBacklogAutoscalePrimitive(
      'capability_cap',
      {
        caps: normalizedCaps,
        primary_key: keys[0] || null,
        aliases: keys.slice(1)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const raw = rust.payload.payload.cap;
      const out = raw == null ? null : Math.round(Number(raw));
      if (CAPABILITY_CAP_CACHE.size >= CAPABILITY_CAP_CACHE_MAX) {
        const oldest = CAPABILITY_CAP_CACHE.keys().next();
        if (!oldest.done) CAPABILITY_CAP_CACHE.delete(oldest.value);
      }
      CAPABILITY_CAP_CACHE.set(key, out);
      return out;
    }
  }
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(caps, k)) continue;
    const v = Number(caps[k]);
    if (Number.isFinite(v) && v >= 0) return Math.round(v);
  }
  return null;
}

function capabilityAttemptCountForDate(dateStr, descriptor) {
  const keys = new Set(
    [descriptor && descriptor.key ? descriptor.key : null]
      .concat(Array.isArray(descriptor && descriptor.aliases) ? descriptor.aliases : [])
      .filter(Boolean)
      .map(x => String(x).toLowerCase())
  );
  if (!keys.size) return 0;
  const events = readRuns(dateStr);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'capability_attempt_count_for_date',
      {
        events: events.map((evt) => ({
          event_type: evt && evt.type != null ? String(evt.type) : null,
          capability_key: evt && evt.capability_key != null ? String(evt.capability_key) : null,
          is_attempt: isAttemptRunEvent(evt)
        })),
        keys: Array.from(keys)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Number(rust.payload.payload.count || 0);
    }
  }
  let count = 0;
  for (const evt of events) {
    if (!evt || evt.type !== 'autonomy_run') continue;
    if (!isAttemptRunEvent(evt)) continue;
    const k = String(evt.capability_key || '').toLowerCase();
    if (!k) continue;
    if (keys.has(k)) count++;
  }
  return count;
}

function capabilityOutcomeStatsInWindow(dateStr, descriptor, days) {
  const windowDays = clampNumber(Number(days || AUTONOMY_LANE_NO_CHANGE_WINDOW_DAYS), 1, 60);
  const keys = new Set(
    [descriptor && descriptor.key ? descriptor.key : null]
      .concat(Array.isArray(descriptor && descriptor.aliases) ? descriptor.aliases : [])
      .filter(Boolean)
      .map(x => String(x).toLowerCase())
  );
  const out = { executed: 0, shipped: 0, no_change: 0, reverted: 0 };
  if (!keys.size) return out;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rustEvents = [];
    for (const d of dateWindow(dateStr, windowDays)) {
      for (const evt of readRuns(d)) {
        rustEvents.push({
          event_type: evt && evt.type != null ? String(evt.type) : null,
          result: evt && evt.result != null ? String(evt.result) : null,
          capability_key: evt && evt.capability_key != null ? String(evt.capability_key) : null,
          outcome: evt && evt.outcome != null ? String(evt.outcome) : null
        });
      }
    }
    const rust = runBacklogAutoscalePrimitive(
      'capability_outcome_stats_in_window',
      {
        events: rustEvents,
        keys: Array.from(keys)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return {
        executed: Number(rust.payload.payload.executed || 0),
        shipped: Number(rust.payload.payload.shipped || 0),
        no_change: Number(rust.payload.payload.no_change || 0),
        reverted: Number(rust.payload.payload.reverted || 0)
      };
    }
  }
  for (const d of dateWindow(dateStr, windowDays)) {
    for (const evt of readRuns(d)) {
      if (!evt || evt.type !== 'autonomy_run' || evt.result !== 'executed') continue;
      const k = String(evt.capability_key || '').toLowerCase();
      if (!k || !keys.has(k)) continue;
      out.executed += 1;
      const outcome = String(evt.outcome || '').toLowerCase();
      if (outcome === 'shipped') out.shipped += 1;
      else if (outcome === 'no_change') out.no_change += 1;
      else if (outcome === 'reverted') out.reverted += 1;
    }
  }
  return out;
}

function normalizeValueCurrencyToken(value) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'normalize_value_currency_token',
      {
        value: value == null ? null : String(value),
        allowed_keys: Array.from(VALUE_CURRENCY_RANK_KEYS)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return String(rust.payload.payload.token || '');
    }
  }
  const token = String(value || '').trim().toLowerCase();
  if (!token || !VALUE_CURRENCY_RANK_KEYS.has(token)) return '';
  return token;
}

function listValueCurrencies(value) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'list_value_currencies',
      {
        value_list: Array.isArray(value) ? value.map((row) => String(row || '')) : [],
        value_csv: Array.isArray(value) ? null : String(value || ''),
        allowed_keys: Array.from(VALUE_CURRENCY_RANK_KEYS)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Array.isArray(rust.payload.payload.currencies)
        ? rust.payload.payload.currencies.map((row: unknown) => String(row || '')).filter(Boolean)
        : [];
    }
  }
  const rows = Array.isArray(value)
    ? value
    : String(value || '')
      .split(',')
      .map((row) => String(row || '').trim())
      .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const token = normalizeValueCurrencyToken(row);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function inferValueCurrenciesFromDirectiveBits(bits) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'infer_value_currencies_from_directive_bits',
      {
        bits: Array.isArray(bits) ? bits.map((x) => String(x || '')) : [],
        allowed_keys: Array.from(VALUE_CURRENCY_RANK_KEYS)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Array.isArray(rust.payload.payload.currencies)
        ? rust.payload.payload.currencies.map((row: unknown) => String(row || '')).filter(Boolean)
        : [];
    }
  }
  const blob = normalizeSpaces((Array.isArray(bits) ? bits : []).map((x) => String(x || '')).join(' ')).toLowerCase();
  const out = [];
  if (!blob) return out;
  if (VALUE_CURRENCY_REVENUE_RE.test(blob)) out.push('revenue');
  if (VALUE_CURRENCY_DELIVERY_RE.test(blob)) out.push('delivery');
  if (VALUE_CURRENCY_USER_RE.test(blob)) out.push('user_value');
  if (VALUE_CURRENCY_QUALITY_RE.test(blob)) out.push('quality');
  if (VALUE_CURRENCY_TIME_RE.test(blob)) out.push('time_savings');
  if (VALUE_CURRENCY_LEARNING_RE.test(blob)) out.push('learning');
  return listValueCurrencies(out);
}

function expectedValueSignalForProposal(p) {
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const direct = Number(meta.expected_value_score);
  const usd = Number(meta.expected_value_usd);
  const impactWeightScore = Number(impactWeight(p) || 0);
  const oraclePriorityRaw = Number(meta.value_oracle_priority_score);
  const oraclePriority = Number.isFinite(oraclePriorityRaw)
    ? clampNumber(Math.round(oraclePriorityRaw), 0, 100)
    : null;
  const matchedCurrencies = listValueCurrencies(meta.value_oracle_matched_currencies);
  const activeCurrencies = listValueCurrencies(meta.value_oracle_active_currencies);
  const matchedFirstSentenceCurrencies = listValueCurrencies(meta.value_oracle_matched_first_sentence_currencies);
  const primaryCurrency = normalizeValueCurrencyToken(meta.value_oracle_primary_currency);
  const selectedCurrency = primaryCurrency || matchedCurrencies[0] || activeCurrencies[0] || null;
  const currencyMultiplier = selectedCurrency
    ? Number(VALUE_CURRENCY_RANK_WEIGHTS[selectedCurrency] || 1)
    : 1;
  const oracleApplies = meta.value_oracle_applies === true || matchedCurrencies.length > 0 || activeCurrencies.length > 0;
  const oraclePass = meta.value_oracle_pass !== false;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = JSON.stringify({
      direct: Number.isFinite(direct) ? direct : null,
      usd: Number.isFinite(usd) ? usd : null,
      oracle_priority: oraclePriority,
      impact_weight: impactWeightScore,
      selected_currency: selectedCurrency,
      currency_multiplier: currencyMultiplier,
      matched_first_sentence_selected: !!(selectedCurrency && matchedFirstSentenceCurrencies.includes(selectedCurrency)),
      currency_ranking_enabled: AUTONOMY_VALUE_CURRENCY_RANKING_ENABLED,
      oracle_applies: oracleApplies,
      oracle_pass: oraclePass,
      rank_blend: AUTONOMY_VALUE_CURRENCY_RANK_BLEND,
      bonus_cap: AUTONOMY_VALUE_CURRENCY_RANK_BONUS_CAP,
      matched: matchedCurrencies,
      active: activeCurrencies,
      matched_first_sentence: matchedFirstSentenceCurrencies
    });
    if (EXPECTED_VALUE_SIGNAL_CACHE.has(key)) {
      return EXPECTED_VALUE_SIGNAL_CACHE.get(key);
    }
    const rust = runBacklogAutoscalePrimitive(
      'expected_value_signal',
      {
        explicit_score: Number.isFinite(direct) ? direct : null,
        expected_value_usd: Number.isFinite(usd) ? usd : null,
        oracle_priority_score: oraclePriority,
        impact_weight: impactWeightScore,
        selected_currency: selectedCurrency,
        currency_multiplier: currencyMultiplier,
        matched_first_sentence_contains_selected: !!(selectedCurrency && matchedFirstSentenceCurrencies.includes(selectedCurrency)),
        currency_ranking_enabled: AUTONOMY_VALUE_CURRENCY_RANKING_ENABLED,
        oracle_applies: oracleApplies,
        oracle_pass: oraclePass,
        rank_blend: AUTONOMY_VALUE_CURRENCY_RANK_BLEND,
        bonus_cap: AUTONOMY_VALUE_CURRENCY_RANK_BONUS_CAP
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      const rawPriority = payload.value_oracle_priority;
      const rawCurrencyAdjusted = payload.currency_adjusted_score;
      const out = {
        score: clampNumber(Math.round(Number(payload.score || 0)), 0, 100),
        base_score: clampNumber(Math.round(Number(payload.base_score || 0)), 0, 100),
        source: String(payload.source || 'impact_weight_fallback'),
        value_oracle_priority: rawPriority == null
          ? null
          : Number.isFinite(Number(rawPriority))
            ? clampNumber(Math.round(Number(rawPriority)), 0, 100)
            : null,
        currency: selectedCurrency,
        currency_multiplier: Number(Number(currencyMultiplier || 1).toFixed(3)),
        currency_adjusted_score: rawCurrencyAdjusted == null
          ? null
          : Number.isFinite(Number(rawCurrencyAdjusted))
            ? clampNumber(Math.round(Number(rawCurrencyAdjusted)), 0, 100)
            : null,
        currency_delta: Number(Number(payload.currency_delta || 0).toFixed(3)),
        oracle_applies: payload.oracle_applies === true,
        oracle_pass: payload.oracle_pass !== false,
        matched_currencies: matchedCurrencies.slice(0, 6),
        active_currencies: activeCurrencies.slice(0, 6),
        matched_first_sentence_currencies: matchedFirstSentenceCurrencies.slice(0, 6)
      };
      if (EXPECTED_VALUE_SIGNAL_CACHE.size >= EXPECTED_VALUE_SIGNAL_CACHE_MAX) {
        const oldest = EXPECTED_VALUE_SIGNAL_CACHE.keys().next();
        if (!oldest.done) EXPECTED_VALUE_SIGNAL_CACHE.delete(oldest.value);
      }
      EXPECTED_VALUE_SIGNAL_CACHE.set(key, out);
      return out;
    }
  }

  let baseScore = impactWeightScore * 20;
  let source = 'impact_weight_fallback';
  if (Number.isFinite(direct)) {
    baseScore = clampNumber(Math.round(direct), 0, 100);
    source = 'expected_value_score';
  } else if (Number.isFinite(usd) && usd > 0) {
    baseScore = clampNumber(Math.round(Math.log10(Math.max(1, usd)) * 30), 0, 100);
    source = 'expected_value_usd';
  } else if (oraclePriority != null) {
    baseScore = oraclePriority;
    source = 'value_oracle_priority_score';
  }

  const currencyAdjusted = oraclePriority != null
    ? clampNumber(Math.round(oraclePriority * currencyMultiplier), 0, 100)
    : null;
  const applyCurrencyRank = AUTONOMY_VALUE_CURRENCY_RANKING_ENABLED
    && oracleApplies
    && oraclePass
    && currencyAdjusted != null;
  const firstSentenceBonus = (
    applyCurrencyRank
    && selectedCurrency
    && matchedFirstSentenceCurrencies.includes(selectedCurrency)
  )
    ? 2
    : 0;
  let delta = 0;
  if (applyCurrencyRank && currencyAdjusted != null) {
    const blended = (baseScore * (1 - AUTONOMY_VALUE_CURRENCY_RANK_BLEND))
      + (currencyAdjusted * AUTONOMY_VALUE_CURRENCY_RANK_BLEND)
      + firstSentenceBonus;
    delta = clampNumber(
      blended - baseScore,
      -AUTONOMY_VALUE_CURRENCY_RANK_BONUS_CAP,
      AUTONOMY_VALUE_CURRENCY_RANK_BONUS_CAP
    );
  }
  const finalScore = clampNumber(Math.round(baseScore + delta), 0, 100);
  return {
    score: finalScore,
    base_score: clampNumber(Math.round(baseScore), 0, 100),
    source,
    value_oracle_priority: oraclePriority,
    currency: selectedCurrency,
    currency_multiplier: Number(currencyMultiplier.toFixed(3)),
    currency_adjusted_score: currencyAdjusted,
    currency_delta: Number(delta.toFixed(3)),
    oracle_applies: oracleApplies,
    oracle_pass: oraclePass,
    matched_currencies: matchedCurrencies.slice(0, 6),
    active_currencies: activeCurrencies.slice(0, 6),
    matched_first_sentence_currencies: matchedFirstSentenceCurrencies.slice(0, 6)
  };
}

function expectedValueScore(p) {
  const signal = expectedValueSignalForProposal(p);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'expected_value_score',
      {
        score: Number(signal && signal.score || 0)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Number(rust.payload.payload.score || 0);
    }
  }
  return signal.score;
}

function timeToValueScore(p) {
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const hours = Number(meta.time_to_cash_hours);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const impactRaw = String(p && p.expected_impact || '');
    const hoursKey = Number.isFinite(hours) ? String(hours) : 'NaN';
    const cacheKey = `${hoursKey}\u0000${impactRaw}`;
    if (TIME_TO_VALUE_SCORE_CACHE.has(cacheKey)) {
      return TIME_TO_VALUE_SCORE_CACHE.get(cacheKey);
    }
    const rust = runBacklogAutoscalePrimitive(
      'time_to_value_score',
      {
        time_to_cash_hours: Number.isFinite(hours) ? hours : null,
        expected_impact: impactRaw
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = clampNumber(Math.round(Number(rust.payload.payload.score || 0)), 0, 100);
      if (TIME_TO_VALUE_SCORE_CACHE.size >= TIME_TO_VALUE_SCORE_CACHE_MAX) {
        const oldest = TIME_TO_VALUE_SCORE_CACHE.keys().next();
        if (!oldest.done) TIME_TO_VALUE_SCORE_CACHE.delete(oldest.value);
      }
      TIME_TO_VALUE_SCORE_CACHE.set(cacheKey, val);
      return val;
    }
  }
  if (Number.isFinite(hours) && hours >= 0) {
    const score = 100 - (Math.min(168, hours) / 168) * 100;
    return clampNumber(Math.round(score), 0, 100);
  }
  const impact = String(p && p.expected_impact || '').toLowerCase();
  if (impact === 'high') return 40;
  if (impact === 'medium') return 55;
  return 70;
}

function estimateTokensForCandidate(cand, proposal) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  const direct = Number(cand && cand.est_tokens);
  const routeEst = Number(meta.route_tokens_est);
  const fallbackEstimate = Number(estimateTokens(p));
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = `${direct}\u0000${routeEst}\u0000${fallbackEstimate}`;
    if (ESTIMATE_TOKENS_FOR_CANDIDATE_CACHE.has(key)) {
      return ESTIMATE_TOKENS_FOR_CANDIDATE_CACHE.get(key);
    }
    const rust = runBacklogAutoscalePrimitive(
      'estimate_tokens_for_candidate',
      {
        direct_est_tokens: direct,
        route_tokens_est: routeEst,
        fallback_estimate: fallbackEstimate
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = clampNumber(Math.round(Number(rust.payload.payload.est_tokens || 0)), 80, 12000);
      if (ESTIMATE_TOKENS_FOR_CANDIDATE_CACHE.size >= ESTIMATE_TOKENS_FOR_CANDIDATE_CACHE_MAX) {
        const oldest = ESTIMATE_TOKENS_FOR_CANDIDATE_CACHE.keys().next();
        if (!oldest.done) ESTIMATE_TOKENS_FOR_CANDIDATE_CACHE.delete(oldest.value);
      }
      ESTIMATE_TOKENS_FOR_CANDIDATE_CACHE.set(key, val);
      return val;
    }
  }
  if (Number.isFinite(direct) && direct > 0) return clampNumber(Math.round(direct), 80, 12000);
  if (Number.isFinite(routeEst) && routeEst > 0) return clampNumber(Math.round(routeEst), 80, 12000);
  return clampNumber(fallbackEstimate, 80, 12000);
}

function valueDensityScore(expectedValue, estTokens) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const valueRaw = Number(expectedValue || 0);
    const tokensRaw = Number(estTokens || 0);
    const cacheKey = `${valueRaw}\u0000${tokensRaw}`;
    if (VALUE_DENSITY_SCORE_CACHE.has(cacheKey)) {
      return VALUE_DENSITY_SCORE_CACHE.get(cacheKey);
    }
    const rust = runBacklogAutoscalePrimitive(
      'value_density_score',
      {
        expected_value: valueRaw,
        est_tokens: tokensRaw
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = clampNumber(Math.round(Number(rust.payload.payload.score || 0)), 0, 100);
      if (VALUE_DENSITY_SCORE_CACHE.size >= VALUE_DENSITY_SCORE_CACHE_MAX) {
        const oldest = VALUE_DENSITY_SCORE_CACHE.keys().next();
        if (!oldest.done) VALUE_DENSITY_SCORE_CACHE.delete(oldest.value);
      }
      VALUE_DENSITY_SCORE_CACHE.set(cacheKey, val);
      return val;
    }
  }
  const value = clampNumber(Number(expectedValue || 0), 0, 100);
  const tokens = clampNumber(Number(estTokens || 0), 80, 12000);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const score = (value * 1000) / Math.max(80, tokens);
  return clampNumber(Math.round(score), 0, 100);
}

function executionReserveSnapshot(cap, used) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const tokenCap = Math.max(0, Number(cap || 0));
    const usedEst = Math.max(0, Number(used || 0));
    const cacheKey = [
      tokenCap,
      usedEst,
      AUTONOMY_BUDGET_EXECUTION_RESERVE_ENABLED ? 1 : 0,
      AUTONOMY_BUDGET_EXECUTION_RESERVE_RATIO,
      AUTONOMY_BUDGET_EXECUTION_RESERVE_MIN_TOKENS
    ].join('\u0000');
    if (EXECUTION_RESERVE_SNAPSHOT_CACHE.has(cacheKey)) {
      return EXECUTION_RESERVE_SNAPSHOT_CACHE.get(cacheKey);
    }
    const rust = runBacklogAutoscalePrimitive(
      'execution_reserve_snapshot',
      {
        cap: tokenCap,
        used: usedEst,
        reserve_enabled: AUTONOMY_BUDGET_EXECUTION_RESERVE_ENABLED,
        reserve_ratio: AUTONOMY_BUDGET_EXECUTION_RESERVE_RATIO,
        reserve_min_tokens: AUTONOMY_BUDGET_EXECUTION_RESERVE_MIN_TOKENS
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = {
        enabled: rust.payload.payload.enabled === true,
        reserve_tokens: Math.max(0, Number(rust.payload.payload.reserve_tokens || 0)),
        reserve_remaining: Math.max(0, Number(rust.payload.payload.reserve_remaining || 0))
      };
      if (EXECUTION_RESERVE_SNAPSHOT_CACHE.size >= EXECUTION_RESERVE_SNAPSHOT_CACHE_MAX) {
        const oldest = EXECUTION_RESERVE_SNAPSHOT_CACHE.keys().next();
        if (!oldest.done) EXECUTION_RESERVE_SNAPSHOT_CACHE.delete(oldest.value);
      }
      EXECUTION_RESERVE_SNAPSHOT_CACHE.set(cacheKey, val);
      return val;
    }
  }
  const tokenCap = Math.max(0, Number(cap || 0));
  const usedEst = Math.max(0, Number(used || 0));
  const reserveTarget = AUTONOMY_BUDGET_EXECUTION_RESERVE_ENABLED
    ? Math.max(
      Math.round(tokenCap * AUTONOMY_BUDGET_EXECUTION_RESERVE_RATIO),
      AUTONOMY_BUDGET_EXECUTION_RESERVE_MIN_TOKENS
    )
    : 0;
  const reserveTokens = Math.max(0, Math.min(tokenCap, reserveTarget));
  const spendBeyondNonReserve = Math.max(0, usedEst - Math.max(0, tokenCap - reserveTokens));
  const reserveRemaining = Math.max(0, reserveTokens - spendBeyondNonReserve);
  return {
    enabled: AUTONOMY_BUDGET_EXECUTION_RESERVE_ENABLED,
    reserve_tokens: reserveTokens,
    reserve_remaining: reserveRemaining
  };
}

function budgetPacingSnapshot(dateStr) {
  const budget = loadDailyBudget(dateStr);
  const autopause = loadSystemBudgetAutopauseState();
  const cap = Number(budget && budget.token_cap || 0);
  const used = Number(budget && budget.used_est || 0);
  const remaining = Math.max(0, cap - used);
  const remainingRatio = cap > 0 ? clampNumber(remaining / cap, 0, 1) : 0;
  const autopauseActive = !!(autopause && autopause.active === true && Number(autopause.until_ms || 0) > Date.now());
  const pressure = normalizeSpaces(
    (autopause && autopause.pressure)
    || (budget && budget.pressure)
    || ''
  ).toLowerCase() || 'none';
  const tight = autopauseActive
    || pressure === 'hard'
    || remainingRatio <= AUTONOMY_BUDGET_PACING_MIN_REMAINING_RATIO;
  const reserve = executionReserveSnapshot(cap, used);
  return {
    token_cap: cap,
    used_est: used,
    remaining_tokens: remaining,
    remaining_ratio: Number(remainingRatio.toFixed(4)),
    pressure,
    autopause_active: autopauseActive,
    tight,
    execution_reserve_enabled: reserve.enabled === true,
    execution_reserve_tokens: Number(reserve.reserve_tokens || 0),
    execution_reserve_remaining: Number(reserve.reserve_remaining || 0)
  };
}

function evaluateBudgetPacingGate(cand, valueSignal, risk, snapshot, opts: AnyObj = {}) {
  const estTokens = estimateTokensForCandidate(cand, cand && cand.proposal);
  const valueScore = clampNumber(Number(valueSignal && valueSignal.score || 0), 0, 100);
  const normalized = normalizedRisk(risk);
  const snap = snapshot && typeof snapshot === 'object'
    ? snapshot
    : { tight: false, autopause_active: false, remaining_ratio: 1, pressure: 'none' };
  const reserveRemaining = Math.max(0, Number(snap.execution_reserve_remaining || 0));
  const executionFloorDeficit = !!(opts && opts.execution_floor_deficit === true);
  const out = {
    pass: true,
    reason: null,
    est_tokens: estTokens,
    value_signal_score: valueScore,
    remaining_ratio: Number(snap.remaining_ratio || 0),
    autopause_active: snap.autopause_active === true,
    pressure: String(snap.pressure || 'none'),
    min_remaining_ratio: AUTONOMY_BUDGET_PACING_MIN_REMAINING_RATIO,
    high_token_threshold: AUTONOMY_BUDGET_PACING_HIGH_TOKEN_THRESHOLD,
    min_value_signal_score: AUTONOMY_BUDGET_PACING_MIN_VALUE_SIGNAL,
    execution_floor_deficit: executionFloorDeficit,
    execution_reserve_enabled: AUTONOMY_BUDGET_EXECUTION_RESERVE_ENABLED,
    execution_reserve_remaining: reserveRemaining,
    execution_reserve_min_value_signal: AUTONOMY_BUDGET_EXECUTION_RESERVE_MIN_VALUE_SIGNAL,
    execution_reserve_bypass: false
  };
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = [
      estTokens,
      valueScore,
      normalized,
      snap.tight === true ? 1 : 0,
      snap.autopause_active === true ? 1 : 0,
      Number(snap.remaining_ratio || 0),
      String(snap.pressure || 'none'),
      executionFloorDeficit ? 1 : 0,
      AUTONOMY_BUDGET_EXECUTION_RESERVE_ENABLED ? 1 : 0,
      reserveRemaining,
      AUTONOMY_BUDGET_EXECUTION_RESERVE_MIN_VALUE_SIGNAL,
      AUTONOMY_BUDGET_PACING_ENABLED ? 1 : 0,
      AUTONOMY_BUDGET_PACING_MIN_REMAINING_RATIO,
      AUTONOMY_BUDGET_PACING_HIGH_TOKEN_THRESHOLD,
      AUTONOMY_BUDGET_PACING_MIN_VALUE_SIGNAL
    ].join('\u0000');
    if (BUDGET_PACING_GATE_CACHE.has(key)) {
      const cached = BUDGET_PACING_GATE_CACHE.get(key);
      return Object.assign({}, out, cached);
    }
    const rust = runBacklogAutoscalePrimitive(
      'budget_pacing_gate',
      {
        est_tokens: Number(estTokens || 0),
        value_signal_score: Number(valueScore || 0),
        risk: normalized,
        snapshot_tight: snap.tight === true,
        snapshot_autopause_active: snap.autopause_active === true,
        snapshot_remaining_ratio: Number(snap.remaining_ratio || 0),
        snapshot_pressure: String(snap.pressure || 'none'),
        execution_floor_deficit: executionFloorDeficit === true,
        execution_reserve_enabled: AUTONOMY_BUDGET_EXECUTION_RESERVE_ENABLED,
        execution_reserve_remaining: reserveRemaining,
        execution_reserve_min_value_signal: Number(AUTONOMY_BUDGET_EXECUTION_RESERVE_MIN_VALUE_SIGNAL || 0),
        budget_pacing_enabled: AUTONOMY_BUDGET_PACING_ENABLED,
        min_remaining_ratio: Number(AUTONOMY_BUDGET_PACING_MIN_REMAINING_RATIO || 0),
        high_token_threshold: Number(AUTONOMY_BUDGET_PACING_HIGH_TOKEN_THRESHOLD || 0),
        min_value_signal_score: Number(AUTONOMY_BUDGET_PACING_MIN_VALUE_SIGNAL || 0)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      const rustOut = {
        pass: payload.pass === true,
        reason: payload.reason ? String(payload.reason) : null,
        execution_reserve_bypass: payload.execution_reserve_bypass === true
      };
      if (BUDGET_PACING_GATE_CACHE.size >= BUDGET_PACING_GATE_CACHE_MAX) {
        const oldest = BUDGET_PACING_GATE_CACHE.keys().next();
        if (!oldest.done) BUDGET_PACING_GATE_CACHE.delete(oldest.value);
      }
      BUDGET_PACING_GATE_CACHE.set(key, rustOut);
      return Object.assign({}, out, rustOut);
    }
  }
  if (AUTONOMY_BUDGET_PACING_ENABLED !== true) return out;
  if (snap.tight !== true) return out;
  const highValueEscape = valueScore >= Math.max(AUTONOMY_BUDGET_PACING_MIN_VALUE_SIGNAL + 20, 85);
  if (highValueEscape) return out;
  const reserveBypassAllowed = AUTONOMY_BUDGET_EXECUTION_RESERVE_ENABLED
    && executionFloorDeficit
    && normalized === 'low'
    && valueScore >= AUTONOMY_BUDGET_EXECUTION_RESERVE_MIN_VALUE_SIGNAL
    && reserveRemaining >= estTokens;
  if (reserveBypassAllowed) {
    out.pass = true;
    out.reason = 'execution_floor_reserve_bypass';
    out.execution_reserve_bypass = true;
    return out;
  }
  if (snap.autopause_active === true && normalized !== 'low') {
    out.pass = false;
    out.reason = 'budget_pacing_autopause_risk_guard';
    return out;
  }
  if (estTokens >= AUTONOMY_BUDGET_PACING_HIGH_TOKEN_THRESHOLD && valueScore < AUTONOMY_BUDGET_PACING_MIN_VALUE_SIGNAL) {
    out.pass = false;
    out.reason = 'budget_pacing_high_token_low_value';
    return out;
  }
  if (Number(snap.remaining_ratio || 0) <= AUTONOMY_BUDGET_PACING_MIN_REMAINING_RATIO && valueScore < AUTONOMY_BUDGET_PACING_MIN_VALUE_SIGNAL) {
    out.pass = false;
    out.reason = 'budget_pacing_low_remaining_ratio';
    return out;
  }
  return out;
}

function runEventProposalType(evt) {
  const eventType = String(evt && evt.type || '').trim().toLowerCase();
  const proposalType = String(evt && evt.proposal_type || '').trim().toLowerCase();
  const capabilityKey = String(evt && evt.capability_key || '').trim().toLowerCase();
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = [eventType, proposalType, capabilityKey].join('\u0000');
    if (PROPOSAL_TYPE_FROM_RUN_EVENT_CACHE.has(key)) {
      return String(PROPOSAL_TYPE_FROM_RUN_EVENT_CACHE.get(key) || '');
    }
    const rust = runBacklogAutoscalePrimitive(
      'proposal_type_from_run_event',
      {
        event_type: eventType,
        proposal_type: proposalType,
        capability_key: capabilityKey
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const typeVal = String(rust.payload.payload.proposal_type || '');
      if (PROPOSAL_TYPE_FROM_RUN_EVENT_CACHE.size >= PROPOSAL_TYPE_FROM_RUN_EVENT_CACHE_MAX) {
        const oldest = PROPOSAL_TYPE_FROM_RUN_EVENT_CACHE.keys().next();
        if (!oldest.done) PROPOSAL_TYPE_FROM_RUN_EVENT_CACHE.delete(oldest.value);
      }
      PROPOSAL_TYPE_FROM_RUN_EVENT_CACHE.set(key, typeVal);
      return typeVal;
    }
  }
  if (eventType !== 'autonomy_run') return '';
  if (proposalType) return proposalType;
  if (capabilityKey.startsWith('proposal:') && capabilityKey.length > 'proposal:'.length) {
    return capabilityKey.slice('proposal:'.length);
  }
  return '';
}

function computeNonYieldPenaltyScore(
  policyHoldRate,
  noProgressRate,
  stopRate,
  shippedRate
) {
  const phRate = Number(policyHoldRate || 0);
  const npRate = Number(noProgressRate || 0);
  const stRate = Number(stopRate || 0);
  const shRate = Number(shippedRate || 0);

  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = [
      phRate,
      npRate,
      stRate,
      shRate,
      AUTONOMY_STRATEGY_RANK_NON_YIELD_POLICY_HOLD_WEIGHT,
      AUTONOMY_STRATEGY_RANK_NON_YIELD_NO_PROGRESS_WEIGHT,
      AUTONOMY_STRATEGY_RANK_NON_YIELD_STOP_WEIGHT,
      AUTONOMY_STRATEGY_RANK_NON_YIELD_SHIPPED_RELIEF_WEIGHT,
      AUTONOMY_STRATEGY_RANK_NON_YIELD_MAX_PENALTY
    ].join('\u0000');
    if (NON_YIELD_PENALTY_SCORE_CACHE.has(key)) {
      return Number(NON_YIELD_PENALTY_SCORE_CACHE.get(key) || 0);
    }
    const rust = runBacklogAutoscalePrimitive(
      'non_yield_penalty_score',
      {
        policy_hold_rate: phRate,
        no_progress_rate: npRate,
        stop_rate: stRate,
        shipped_rate: shRate,
        policy_hold_weight: Number(AUTONOMY_STRATEGY_RANK_NON_YIELD_POLICY_HOLD_WEIGHT || 0),
        no_progress_weight: Number(AUTONOMY_STRATEGY_RANK_NON_YIELD_NO_PROGRESS_WEIGHT || 0),
        stop_weight: Number(AUTONOMY_STRATEGY_RANK_NON_YIELD_STOP_WEIGHT || 0),
        shipped_relief_weight: Number(AUTONOMY_STRATEGY_RANK_NON_YIELD_SHIPPED_RELIEF_WEIGHT || 0),
        max_penalty: Number(AUTONOMY_STRATEGY_RANK_NON_YIELD_MAX_PENALTY || 0)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const out = Number(Number(rust.payload.payload.penalty || 0).toFixed(3));
      if (NON_YIELD_PENALTY_SCORE_CACHE.size >= NON_YIELD_PENALTY_SCORE_CACHE_MAX) {
        const oldest = NON_YIELD_PENALTY_SCORE_CACHE.keys().next();
        if (!oldest.done) NON_YIELD_PENALTY_SCORE_CACHE.delete(oldest.value);
      }
      NON_YIELD_PENALTY_SCORE_CACHE.set(key, out);
      return out;
    }
  }

  const rawPenalty = (
    (phRate * AUTONOMY_STRATEGY_RANK_NON_YIELD_POLICY_HOLD_WEIGHT)
    + (npRate * AUTONOMY_STRATEGY_RANK_NON_YIELD_NO_PROGRESS_WEIGHT)
    + (stRate * AUTONOMY_STRATEGY_RANK_NON_YIELD_STOP_WEIGHT)
    - (shRate * AUTONOMY_STRATEGY_RANK_NON_YIELD_SHIPPED_RELIEF_WEIGHT)
  );
  return Number(
    clampNumber(rawPenalty, 0, AUTONOMY_STRATEGY_RANK_NON_YIELD_MAX_PENALTY).toFixed(3)
  );
}

function candidateNonYieldPenaltySignal(cand, opts: AnyObj = {}) {
  const out = {
    applied: false,
    penalty: 0,
    samples: 0,
    policy_holds: 0,
    no_progress: 0,
    stops: 0,
    shipped: 0,
    policy_hold_rate: 0,
    no_progress_rate: 0,
    stop_rate: 0,
    shipped_rate: 0,
    window_hours: AUTONOMY_STRATEGY_RANK_NON_YIELD_WINDOW_HOURS,
    min_samples: AUTONOMY_STRATEGY_RANK_NON_YIELD_MIN_SAMPLES,
    objective_id: null,
    capability_key: null,
    proposal_type: null
  };
  if (!AUTONOMY_STRATEGY_RANK_NON_YIELD_PENALTY_ENABLED) return out;

  const priorRuns = Array.isArray(opts.priorRuns) ? opts.priorRuns : [];
  if (!priorRuns.length) return out;

  const proposal = cand && cand.proposal && typeof cand.proposal === 'object' ? cand.proposal : {};
  const objectiveBinding = cand && cand.objective_binding && typeof cand.objective_binding === 'object'
    ? cand.objective_binding
    : {};
  const objectiveId = sanitizeDirectiveObjectiveId(
    objectiveBinding.objective_id
    || cand && cand.directive_pulse && cand.directive_pulse.objective_id
    || proposal && proposal.meta && proposal.meta.objective_id
    || proposal && proposal.meta && proposal.meta.directive_objective_id
    || ''
  );
  const proposalType = String(proposal && proposal.type || '').trim().toLowerCase();
  const capabilityKey = String(
    cand && cand.capability_key
    || capabilityDescriptor(proposal, parseActuationSpec(proposal)).key
    || ''
  ).trim().toLowerCase();

  out.objective_id = objectiveId || null;
  out.proposal_type = proposalType || null;
  out.capability_key = capabilityKey || null;

  const cutoffMs = Date.now() - (AUTONOMY_STRATEGY_RANK_NON_YIELD_WINDOW_HOURS * 3600000);
  const matches = (evt) => {
    if (!evt || evt.type !== 'autonomy_run') return false;
    if (objectiveId) {
      const evtObjectiveId = runEventObjectiveId(evt);
      if (evtObjectiveId && evtObjectiveId === objectiveId) return true;
    }
    if (capabilityKey) {
      const evtCapabilityKey = String(evt.capability_key || '').trim().toLowerCase();
      if (evtCapabilityKey && evtCapabilityKey === capabilityKey) return true;
    }
    if (proposalType) {
      const evtProposalType = runEventProposalType(evt);
      if (evtProposalType && evtProposalType === proposalType) return true;
    }
    return false;
  };

  for (const evt of priorRuns) {
    if (!evt || evt.type !== 'autonomy_run') continue;
    const t = parseIsoTs(evt.ts);
    if (t && t.getTime() < cutoffMs) continue;
    if (!matches(evt)) continue;
    const result = String(evt.result || '');
    if (!result || result === 'lock_busy' || result === 'stop_repeat_gate_interval') continue;
    out.samples += 1;
    if (isPolicyHoldRunEvent(evt)) out.policy_holds += 1;
    if (isNoProgressRun(evt)) out.no_progress += 1;
    if (result.startsWith('stop_')) out.stops += 1;
    if (result === 'executed' && String(evt.outcome || '') === 'shipped') out.shipped += 1;
  }

  if (out.samples < AUTONOMY_STRATEGY_RANK_NON_YIELD_MIN_SAMPLES) return out;
  out.applied = true;
  out.policy_hold_rate = Number((out.policy_holds / out.samples).toFixed(4));
  out.no_progress_rate = Number((out.no_progress / out.samples).toFixed(4));
  out.stop_rate = Number((out.stops / out.samples).toFixed(4));
  out.shipped_rate = Number((out.shipped / out.samples).toFixed(4));
  out.penalty = computeNonYieldPenaltyScore(
    out.policy_hold_rate,
    out.no_progress_rate,
    out.stop_rate,
    out.shipped_rate
  );
  return out;
}

function loadCollectiveShadowSnapshot() {
  if (COLLECTIVE_SHADOW_CACHE !== undefined) return COLLECTIVE_SHADOW_CACHE;
  const payload = loadJson(COLLECTIVE_SHADOW_LATEST_PATH, null);
  const rows = Array.isArray(payload && payload.archetypes) ? payload.archetypes : [];
  COLLECTIVE_SHADOW_CACHE = {
    available: !!(payload && typeof payload === 'object' && rows.length > 0),
    path: COLLECTIVE_SHADOW_LATEST_PATH,
    ts: payload && payload.ts ? String(payload.ts) : null,
    date: payload && payload.date ? String(payload.date) : null,
    archetypes: rows
  };
  return COLLECTIVE_SHADOW_CACHE;
}

function shadowScopeMatchesCandidate(scope, candidateCtx) {
  const s = scope && typeof scope === 'object' ? scope : {};
  const scopeType = String(s.scope_type || '').trim().toLowerCase();
  const scopeValue = String(s.scope_value || '').trim().toLowerCase();
  const riskLevels = Array.isArray(s.risk_levels)
    ? s.risk_levels.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const risk = String(candidateCtx.risk || '').trim().toLowerCase();
  const proposalType = String(candidateCtx.proposal_type || '').trim().toLowerCase();
  const capabilityKey = String(candidateCtx.capability_key || '').trim().toLowerCase();
  const objectiveId = String(candidateCtx.objective_id || '').trim().toLowerCase();
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = [
      scopeType,
      scopeValue,
      riskLevels.join('\u0004'),
      risk,
      proposalType,
      capabilityKey,
      objectiveId
    ].join('\u0003');
    if (SHADOW_SCOPE_MATCHES_CACHE.has(key)) {
      return SHADOW_SCOPE_MATCHES_CACHE.get(key) === true;
    }
    const rust = runBacklogAutoscalePrimitive(
      'shadow_scope_matches',
      {
        scope_type: scopeType,
        scope_value: scopeValue,
        risk_levels: riskLevels,
        risk,
        proposal_type: proposalType,
        capability_key: capabilityKey,
        objective_id: objectiveId
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const out = rust.payload.payload.matched === true;
      if (SHADOW_SCOPE_MATCHES_CACHE.size >= SHADOW_SCOPE_MATCHES_CACHE_MAX) {
        const oldest = SHADOW_SCOPE_MATCHES_CACHE.keys().next();
        if (!oldest.done) SHADOW_SCOPE_MATCHES_CACHE.delete(oldest.value);
      }
      SHADOW_SCOPE_MATCHES_CACHE.set(key, out);
      return out;
    }
  }

  if (scopeType === 'proposal_type') {
    if (!scopeValue || !proposalType) return false;
    return scopeValue === proposalType;
  }
  if (scopeType === 'capability_key') {
    if (!scopeValue || !capabilityKey) return false;
    return scopeValue === capabilityKey;
  }
  if (scopeType === 'objective_id') {
    if (!scopeValue || !objectiveId) return false;
    return scopeValue === objectiveId;
  }
  if (scopeType === 'global') {
    if (!riskLevels.length) return true;
    return !!risk && riskLevels.includes(risk);
  }
  return false;
}

function computeCollectiveShadowAggregate(rows) {
  const entries = Array.isArray(rows) ? rows : [];
  const normalized = entries.map((row) => ({
    kind: String(row && row.kind || ''),
    confidence: clampNumber(Number(row && row.confidence || 0), 0, 1),
    score_impact: Math.max(0, Number(row && row.score_impact || 0))
  }));
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = normalized
      .map((row) => `${row.kind}\u0000${row.confidence}\u0000${row.score_impact}`)
      .join('\u0001');
    if (COLLECTIVE_SHADOW_AGGREGATE_CACHE.has(key)) {
      return COLLECTIVE_SHADOW_AGGREGATE_CACHE.get(key);
    }
    const rust = runBacklogAutoscalePrimitive(
      'collective_shadow_aggregate',
      { entries: normalized },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      const out = {
        matches: Number(payload.matches || normalized.length),
        confidence_avg: Number(Number(payload.confidence_avg || 0).toFixed(4)),
        penalty_raw: Number(Number(payload.penalty_raw || 0).toFixed(3)),
        bonus_raw: Number(Number(payload.bonus_raw || 0).toFixed(3))
      };
      if (COLLECTIVE_SHADOW_AGGREGATE_CACHE.size >= COLLECTIVE_SHADOW_AGGREGATE_CACHE_MAX) {
        const oldest = COLLECTIVE_SHADOW_AGGREGATE_CACHE.keys().next();
        if (!oldest.done) COLLECTIVE_SHADOW_AGGREGATE_CACHE.delete(oldest.value);
      }
      COLLECTIVE_SHADOW_AGGREGATE_CACHE.set(key, out);
      return out;
    }
  }
  if (!normalized.length) {
    return { matches: 0, confidence_avg: 0, penalty_raw: 0, bonus_raw: 0 };
  }
  const confidenceAvg = Number(
    (normalized.reduce((acc, row) => acc + Number(row.confidence || 0), 0) / normalized.length).toFixed(4)
  );
  const penaltyRaw = normalized
    .filter((row) => row.kind === 'avoid')
    .reduce((acc, row) => acc + (Number(row.score_impact || 0) * Number(row.confidence || 0)), 0);
  const bonusRaw = normalized
    .filter((row) => row.kind === 'reinforce')
    .reduce((acc, row) => acc + (Number(row.score_impact || 0) * Number(row.confidence || 0)), 0);
  return {
    matches: normalized.length,
    confidence_avg: confidenceAvg,
    penalty_raw: Number(penaltyRaw.toFixed(3)),
    bonus_raw: Number(bonusRaw.toFixed(3))
  };
}

function computeCollectiveShadowAdjustments(penaltyRaw, bonusRaw) {
  const penalty = Number(penaltyRaw || 0);
  const bonus = Number(bonusRaw || 0);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = [
      penalty,
      bonus,
      AUTONOMY_COLLECTIVE_SHADOW_MAX_PENALTY,
      AUTONOMY_COLLECTIVE_SHADOW_MAX_BONUS
    ].join('\u0000');
    if (COLLECTIVE_SHADOW_ADJUSTMENTS_CACHE.has(key)) {
      return COLLECTIVE_SHADOW_ADJUSTMENTS_CACHE.get(key);
    }
    const rust = runBacklogAutoscalePrimitive(
      'collective_shadow_adjustments',
      {
        penalty_raw: penalty,
        bonus_raw: bonus,
        max_penalty: Number(AUTONOMY_COLLECTIVE_SHADOW_MAX_PENALTY || 0),
        max_bonus: Number(AUTONOMY_COLLECTIVE_SHADOW_MAX_BONUS || 0)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      const out = {
        penalty: Number(Number(payload.penalty || 0).toFixed(3)),
        bonus: Number(Number(payload.bonus || 0).toFixed(3))
      };
      if (COLLECTIVE_SHADOW_ADJUSTMENTS_CACHE.size >= COLLECTIVE_SHADOW_ADJUSTMENTS_CACHE_MAX) {
        const oldest = COLLECTIVE_SHADOW_ADJUSTMENTS_CACHE.keys().next();
        if (!oldest.done) COLLECTIVE_SHADOW_ADJUSTMENTS_CACHE.delete(oldest.value);
      }
      COLLECTIVE_SHADOW_ADJUSTMENTS_CACHE.set(key, out);
      return out;
    }
  }
  return {
    penalty: Number(clampNumber(penalty, 0, AUTONOMY_COLLECTIVE_SHADOW_MAX_PENALTY).toFixed(3)),
    bonus: Number(clampNumber(bonus, 0, AUTONOMY_COLLECTIVE_SHADOW_MAX_BONUS).toFixed(3))
  };
}

function candidateCollectiveShadowSignal(cand) {
  const out = {
    applied: false,
    available: false,
    snapshot_date: null,
    snapshot_ts: null,
    penalty: 0,
    bonus: 0,
    matches: 0,
    matched_ids: [],
    confidence_avg: 0,
    source_path: path.relative(REPO_ROOT, COLLECTIVE_SHADOW_LATEST_PATH).replace(/\\/g, '/')
  };
  if (!AUTONOMY_COLLECTIVE_SHADOW_ENABLED) return out;

  const snapshot = loadCollectiveShadowSnapshot();
  out.available = snapshot && snapshot.available === true;
  out.snapshot_date = snapshot && snapshot.date ? snapshot.date : null;
  out.snapshot_ts = snapshot && snapshot.ts ? snapshot.ts : null;
  if (!snapshot || snapshot.available !== true) return out;

  const proposal = cand && cand.proposal && typeof cand.proposal === 'object' ? cand.proposal : {};
  const objectiveBinding = cand && cand.objective_binding && typeof cand.objective_binding === 'object'
    ? cand.objective_binding
    : {};
  const proposalType = String(proposal && proposal.type || '').trim().toLowerCase();
  const capabilityKey = String(
    cand && cand.capability_key
    || capabilityDescriptor(proposal, parseActuationSpec(proposal)).key
    || ''
  ).trim().toLowerCase();
  const objectiveId = sanitizeDirectiveObjectiveId(
    objectiveBinding.objective_id
    || cand && cand.directive_pulse && cand.directive_pulse.objective_id
    || proposal && proposal.meta && proposal.meta.objective_id
    || proposal && proposal.meta && proposal.meta.directive_objective_id
    || ''
  ).toLowerCase();
  const risk = normalizedRisk(cand && cand.risk || proposal && proposal.risk || 'low');
  const candidateCtx = {
    proposal_type: proposalType,
    capability_key: capabilityKey,
    objective_id: objectiveId,
    risk
  };

  const matched = [];
  for (const row of snapshot.archetypes) {
    const archetype = row && typeof row === 'object' ? row : {};
    const confidence = clampNumber(Number(archetype.confidence || 0), 0, 1);
    if (confidence < AUTONOMY_COLLECTIVE_SHADOW_MIN_CONFIDENCE) continue;
    if (!shadowScopeMatchesCandidate(archetype.scope, candidateCtx)) continue;
    const kind = String(archetype.kind || '').trim().toLowerCase();
    const impact = Math.max(0, Number(archetype.score_impact || 0));
    matched.push({
      id: String(archetype.id || '').trim(),
      kind,
      confidence,
      score_impact: impact
    });
  }

  if (!matched.length) return out;
  out.applied = true;
  const aggregate = computeCollectiveShadowAggregate(matched);
  out.matches = Number(aggregate.matches || matched.length);
  out.matched_ids = matched.map((row) => row.id).filter(Boolean).slice(0, 8);
  out.confidence_avg = Number(Number(aggregate.confidence_avg || 0).toFixed(4));
  const penaltyRaw = Number(aggregate.penalty_raw || 0);
  const bonusRaw = Number(aggregate.bonus_raw || 0);
  const adjusted = computeCollectiveShadowAdjustments(penaltyRaw, bonusRaw);
  out.penalty = Number(adjusted.penalty || 0);
  out.bonus = Number(adjusted.bonus || 0);
  return out;
}

function candidateObjectiveId(cand, proposal) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const cRust = cand && typeof cand === 'object' ? cand : {};
    const pRust = proposal && typeof proposal === 'object' ? proposal : {};
    const metaRust = pRust && pRust.meta && typeof pRust.meta === 'object' ? pRust.meta : {};
    const rust = runBacklogAutoscalePrimitive(
      'objective_id_for_execution',
      {
        objective_binding_id: null,
        directive_pulse_id: cRust && cRust.directive_pulse && cRust.directive_pulse.objective_id == null
          ? null
          : String(cRust && cRust.directive_pulse && cRust.directive_pulse.objective_id || ''),
        directive_action_id: null,
        meta_objective_id: pRust.objective_id == null ? null : String(pRust.objective_id),
        meta_directive_objective_id: metaRust.objective_id == null ? null : String(metaRust.objective_id),
        action_spec_objective_id: metaRust.directive_objective_id == null ? null : String(metaRust.directive_objective_id)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return String(rust.payload.payload.objective_id || '');
    }
  }
  const c = cand && typeof cand === 'object' ? cand : {};
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  return sanitizeDirectiveObjectiveId(
    c && c.directive_pulse && c.directive_pulse.objective_id
    || p.objective_id
    || meta.objective_id
    || meta.directive_objective_id
    || ''
  );
}

function strategyRankForCandidate(cand, strategy, opts: AnyObj = {}) {
  const p = cand && cand.proposal ? cand.proposal : {};
  const expectedValueSignal = expectedValueSignalForProposal(p);
  const rankingContext = resolveStrategyRankingContext(strategy, {
    objective_id: candidateObjectiveId(cand, p),
    value_currency: expectedValueSignal.currency
  });
  const weights = rankingContext.weights && typeof rankingContext.weights === 'object'
    ? rankingContext.weights
    : {
      composite: 0.35,
      actionability: 0.2,
      directive_fit: 0.15,
      signal_quality: 0.15,
      expected_value: 0.1,
      time_to_value: 0,
      risk_penalty: 0.05
    };
  const expectedValue = expectedValueSignal.score;
  const estimatedTokens = estimateTokensForCandidate(cand, p);
  const valueDensity = valueDensityScore(expectedValue, estimatedTokens);
  const valueDensityWeight = Number.isFinite(Number(weights && weights.value_density))
    ? Number(weights.value_density)
    : 0.08;
  const nonYieldPenalty = candidateNonYieldPenaltySignal(cand, opts);
  const collectiveShadow = candidateCollectiveShadowSignal(cand);
  const components = {
    composite: clampNumber(Number(cand && cand.composite_score || 0), 0, 100),
    actionability: clampNumber(Number(cand && cand.actionability && cand.actionability.score || 0), 0, 100),
    directive_fit: clampNumber(Number(cand && cand.directive_fit && cand.directive_fit.score || 0), 0, 100),
    signal_quality: clampNumber(Number(cand && cand.quality && cand.quality.score || 0), 0, 100),
    expected_value: expectedValue,
    expected_value_base: expectedValueSignal.base_score,
    expected_value_source: expectedValueSignal.source,
    value_oracle_priority: expectedValueSignal.value_oracle_priority,
    value_currency: expectedValueSignal.currency,
    value_currency_multiplier: expectedValueSignal.currency_multiplier,
    value_currency_delta: expectedValueSignal.currency_delta,
    estimated_tokens: estimatedTokens,
    value_density: valueDensity,
    risk_penalty: riskPenalty(p) * 50,
    time_to_value: timeToValueScore(p),
    non_yield_penalty: Number(nonYieldPenalty.penalty || 0),
    non_yield_samples: Number(nonYieldPenalty.samples || 0),
    non_yield_policy_hold_rate: Number(nonYieldPenalty.policy_hold_rate || 0),
    non_yield_no_progress_rate: Number(nonYieldPenalty.no_progress_rate || 0),
    non_yield_stop_rate: Number(nonYieldPenalty.stop_rate || 0),
    non_yield_shipped_rate: Number(nonYieldPenalty.shipped_rate || 0),
    collective_shadow_penalty: Number(collectiveShadow.penalty || 0),
    collective_shadow_bonus: Number(collectiveShadow.bonus || 0),
    collective_shadow_matches: Number(collectiveShadow.matches || 0),
    collective_shadow_confidence: Number(collectiveShadow.confidence_avg || 0),
    ranking_context_objective_id: rankingContext.objective_id || null,
    ranking_context_currency: rankingContext.value_currency || null,
    ranking_context_overrides: Array.isArray(rankingContext.applied_overrides)
      ? rankingContext.applied_overrides.slice(0, 4)
      : []
  };
  const compositeWeight = Number(weights.composite || 0);
  const actionabilityWeight = Number(weights.actionability || 0);
  const directiveFitWeight = Number(weights.directive_fit || 0);
  const signalQualityWeight = Number(weights.signal_quality || 0);
  const expectedValueWeight = Number(weights.expected_value || 0);
  const riskPenaltyWeight = Number(weights.risk_penalty || 0);
  const timeToValueWeight = Number(weights.time_to_value || 0);
  const nonYieldPenaltyValue = Number(nonYieldPenalty.penalty || 0);
  const collectiveShadowPenaltyValue = Number(collectiveShadow.penalty || 0);
  const collectiveShadowBonusValue = Number(collectiveShadow.bonus || 0);

  let raw = NaN;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = [
      compositeWeight,
      actionabilityWeight,
      directiveFitWeight,
      signalQualityWeight,
      expectedValueWeight,
      valueDensityWeight,
      riskPenaltyWeight,
      timeToValueWeight,
      components.composite,
      components.actionability,
      components.directive_fit,
      components.signal_quality,
      components.expected_value,
      components.value_density,
      components.risk_penalty,
      components.time_to_value,
      nonYieldPenaltyValue,
      collectiveShadowPenaltyValue,
      collectiveShadowBonusValue
    ].join('\u0000');
    if (STRATEGY_RANK_SCORE_CACHE.has(key)) {
      raw = Number(STRATEGY_RANK_SCORE_CACHE.get(key));
    } else {
      const rust = runBacklogAutoscalePrimitive(
        'strategy_rank_score',
        {
          composite_weight: compositeWeight,
          actionability_weight: actionabilityWeight,
          directive_fit_weight: directiveFitWeight,
          signal_quality_weight: signalQualityWeight,
          expected_value_weight: expectedValueWeight,
          value_density_weight: valueDensityWeight,
          risk_penalty_weight: riskPenaltyWeight,
          time_to_value_weight: timeToValueWeight,
          composite: Number(components.composite || 0),
          actionability: Number(components.actionability || 0),
          directive_fit: Number(components.directive_fit || 0),
          signal_quality: Number(components.signal_quality || 0),
          expected_value: Number(components.expected_value || 0),
          value_density: Number(components.value_density || 0),
          risk_penalty: Number(components.risk_penalty || 0),
          time_to_value: Number(components.time_to_value || 0),
          non_yield_penalty: nonYieldPenaltyValue,
          collective_shadow_penalty: collectiveShadowPenaltyValue,
          collective_shadow_bonus: collectiveShadowBonusValue
        },
        { allow_cli_fallback: true }
      );
      if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
        raw = Number(rust.payload.payload.score || 0);
        if (STRATEGY_RANK_SCORE_CACHE.size >= STRATEGY_RANK_SCORE_CACHE_MAX) {
          const oldest = STRATEGY_RANK_SCORE_CACHE.keys().next();
          if (!oldest.done) STRATEGY_RANK_SCORE_CACHE.delete(oldest.value);
        }
        STRATEGY_RANK_SCORE_CACHE.set(key, raw);
      }
    }
  }
  if (!Number.isFinite(raw)) {
    raw = (
      compositeWeight * components.composite
      + actionabilityWeight * components.actionability
      + directiveFitWeight * components.directive_fit
      + signalQualityWeight * components.signal_quality
      + expectedValueWeight * components.expected_value
      + valueDensityWeight * components.value_density
      - riskPenaltyWeight * components.risk_penalty
      + timeToValueWeight * components.time_to_value
      - nonYieldPenaltyValue
      - collectiveShadowPenaltyValue
      + collectiveShadowBonusValue
    );
  }
  return {
    score: Number(raw.toFixed(3)),
    components,
    adjustments: {
      non_yield_penalty: nonYieldPenalty,
      collective_shadow: collectiveShadow
    },
    weights: {
      ...weights,
      value_density: valueDensityWeight
    }
  };
}

function strategyRankAdjustedForCandidate(cand, executionMode) {
  const base = Number(cand && cand.strategy_rank && cand.strategy_rank.score || 0);
  const pulseScore = clampNumber(Number(cand && cand.directive_pulse && cand.directive_pulse.score || 0), 0, 100);
  const pulseWeight = clampNumber(Number(AUTONOMY_DIRECTIVE_PULSE_RANK_BONUS || 0), 0, 1);
  const objectiveAllocation = clampNumber(
    Number(cand && cand.directive_pulse && cand.directive_pulse.objective_allocation_score || 0),
    0,
    100
  );
  const baseObjectiveWeight = clampNumber(Number(AUTONOMY_OBJECTIVE_ALLOCATION_RANK_BONUS || 0), 0, 1);
  const canaryMode = executionMode === 'canary_execute';
  let rustPayload = null;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = [
      base,
      pulseScore,
      pulseWeight,
      objectiveAllocation,
      baseObjectiveWeight,
      canaryMode ? 1 : 0
    ].join('\u0000');
    if (STRATEGY_RANK_ADJUSTED_CACHE.has(key)) {
      rustPayload = STRATEGY_RANK_ADJUSTED_CACHE.get(key);
    } else {
      const rust = runBacklogAutoscalePrimitive(
        'strategy_rank_adjusted',
        {
          base,
          pulse_score: pulseScore,
          pulse_weight: pulseWeight,
          objective_allocation_score: objectiveAllocation,
          base_objective_weight: baseObjectiveWeight,
          canary_mode: canaryMode
        },
        { allow_cli_fallback: true }
      );
      if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
        rustPayload = rust.payload.payload;
        if (STRATEGY_RANK_ADJUSTED_CACHE.size >= STRATEGY_RANK_ADJUSTED_CACHE_MAX) {
          const oldest = STRATEGY_RANK_ADJUSTED_CACHE.keys().next();
          if (!oldest.done) STRATEGY_RANK_ADJUSTED_CACHE.delete(oldest.value);
        }
        STRATEGY_RANK_ADJUSTED_CACHE.set(key, rustPayload);
      }
    }
  }

  if (rustPayload && typeof rustPayload === 'object') {
    const adjusted = Number(rustPayload.adjusted || 0);
    const bonus = rustPayload.bonus && typeof rustPayload.bonus === 'object' ? rustPayload.bonus : {};
    return {
      adjusted: Number(adjusted.toFixed(3)),
      bonus: {
        pulse_weight: clampNumber(Number(bonus.pulse_weight || pulseWeight), 0, 1),
        pulse_score: clampNumber(Number(bonus.pulse_score || pulseScore), 0, 100),
        objective_weight: clampNumber(Number(bonus.objective_weight || 0), 0, 1),
        objective_allocation_score: clampNumber(Number(bonus.objective_allocation_score || objectiveAllocation), 0, 100),
        total: Number(Number(bonus.total || 0).toFixed(3))
      }
    };
  }

  const objectiveWeight = canaryMode ? baseObjectiveWeight : Number((baseObjectiveWeight * 0.35).toFixed(3));
  const pulseBonus = pulseWeight * pulseScore;
  const objectiveBonus = objectiveWeight * objectiveAllocation;
  const total = Number((pulseBonus + objectiveBonus).toFixed(3));
  const adjusted = Number((base + total).toFixed(3));
  return {
    adjusted,
    bonus: {
      pulse_weight: pulseWeight,
      pulse_score: pulseScore,
      objective_weight: objectiveWeight,
      objective_allocation_score: objectiveAllocation,
      total
    }
  };
}

function tritShadowRankScoreFromBelief(belief) {
  const src = belief && typeof belief === 'object' ? belief : {};
  const score = clampNumber(Number(src.score || 0), -1, 1);
  const confidence = clampNumber(Number(src.confidence || 0), 0, 1);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = [score, confidence].join('\u0000');
    if (TRIT_SHADOW_RANK_SCORE_CACHE.has(key)) {
      return Number(TRIT_SHADOW_RANK_SCORE_CACHE.get(key));
    }
    const rust = runBacklogAutoscalePrimitive(
      'trit_shadow_rank_score',
      {
        score,
        confidence
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const out = Number(rust.payload.payload.score || 0);
      if (TRIT_SHADOW_RANK_SCORE_CACHE.size >= TRIT_SHADOW_RANK_SCORE_CACHE_MAX) {
        const oldest = TRIT_SHADOW_RANK_SCORE_CACHE.keys().next();
        if (!oldest.done) TRIT_SHADOW_RANK_SCORE_CACHE.delete(oldest.value);
      }
      TRIT_SHADOW_RANK_SCORE_CACHE.set(key, out);
      return out;
    }
  }
  const normalized = ((score + 1) * 50) + (confidence * 10);
  return Number(clampNumber(normalized, 0, 100).toFixed(3));
}

function strategyTritShadowAdjustedScore(baseScore, bonusRaw, bonusBlend = AUTONOMY_TRIT_SHADOW_BONUS_BLEND) {
  const base = Number(baseScore || 0);
  const raw = Number(bonusRaw || 0);
  const blend = Number(bonusBlend || 0);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = [base, raw, blend].join('\u0000');
    if (STRATEGY_TRIT_SHADOW_ADJUSTED_CACHE.has(key)) {
      return STRATEGY_TRIT_SHADOW_ADJUSTED_CACHE.get(key);
    }
    const rust = runBacklogAutoscalePrimitive(
      'strategy_trit_shadow_adjusted',
      {
        base_score: base,
        bonus_raw: raw,
        bonus_blend: blend
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      const out = {
        adjusted_score: Number(Number(payload.adjusted_score || 0).toFixed(3)),
        bonus_applied: Number(Number(payload.bonus_applied || 0).toFixed(3))
      };
      if (STRATEGY_TRIT_SHADOW_ADJUSTED_CACHE.size >= STRATEGY_TRIT_SHADOW_ADJUSTED_CACHE_MAX) {
        const oldest = STRATEGY_TRIT_SHADOW_ADJUSTED_CACHE.keys().next();
        if (!oldest.done) STRATEGY_TRIT_SHADOW_ADJUSTED_CACHE.delete(oldest.value);
      }
      STRATEGY_TRIT_SHADOW_ADJUSTED_CACHE.set(key, out);
      return out;
    }
  }
  const bonusApplied = Number((raw * blend).toFixed(3));
  return {
    adjusted_score: Number((base + bonusApplied).toFixed(3)),
    bonus_applied: bonusApplied
  };
}

function tritShadowBeliefOptions() {
  const policy = loadTritShadowPolicy();
  const trustState = loadTritShadowTrustState(policy);
  const trustMap = buildTritSourceTrustMap(trustState);
  const trust = policy && policy.trust && typeof policy.trust === 'object' ? policy.trust : {};
  const semantics = policy && policy.semantics && typeof policy.semantics === 'object' ? policy.semantics : {};
  return {
    source_trust: trustMap,
    source_trust_floor: trust.source_trust_floor,
    source_trust_ceiling: trust.source_trust_ceiling,
    freshness_half_life_hours: trust.freshness_half_life_hours,
    min_non_neutral_signals: semantics.min_non_neutral_signals,
    min_non_neutral_weight: semantics.min_non_neutral_weight,
    min_confidence_for_non_neutral: semantics.min_confidence_for_non_neutral,
    force_neutral_on_insufficient_evidence: semantics.neutral_on_missing !== false
  };
}

function strategyTritShadowForCandidate(cand) {
  if (!AUTONOMY_TRIT_SHADOW_ENABLED) return null;
  const row = cand && typeof cand === 'object' ? cand : {};
  const qualityScore = clampNumber(Number(row.quality && row.quality.score || 0), 0, 100);
  const directiveFitScore = clampNumber(Number(row.directive_fit && row.directive_fit.score || 0), 0, 100);
  const actionabilityScore = clampNumber(Number(row.actionability && row.actionability.score || 0), 0, 100);
  const compositeScore = clampNumber(Number(row.composite_score || 0), 0, 100);
  const compositeMin = clampNumber(Number(row.composite_min_score || 0), 0, 100);
  const valueSignalScore = clampNumber(Number(row.value_signal && row.value_signal.score || 0), 0, 100);
  const risk = normalizedRisk(row.risk);
  const nonYieldPenalty = clampNumber(Number(
    row.strategy_rank
    && row.strategy_rank.adjustments
    && row.strategy_rank.adjustments.non_yield_penalty
    && row.strategy_rank.adjustments.non_yield_penalty.penalty
    || 0
  ), 0, AUTONOMY_STRATEGY_RANK_NON_YIELD_MAX_PENALTY);

  const signals = [
    {
      source: 'quality_gate',
      trit: qualityScore >= AUTONOMY_MIN_SIGNAL_QUALITY ? 1 : -1,
      weight: 1.2
    },
    {
      source: 'directive_fit_gate',
      trit: directiveFitScore >= AUTONOMY_MIN_DIRECTIVE_FIT ? 1 : -1,
      weight: 1.1
    },
    {
      source: 'actionability_gate',
      trit: actionabilityScore >= AUTONOMY_MIN_ACTIONABILITY_SCORE ? 1 : -1,
      weight: 1.2
    },
    {
      source: 'value_signal_gate',
      trit: valueSignalScore >= AUTONOMY_MIN_VALUE_SIGNAL_SCORE ? 1 : -1,
      weight: 1.2
    },
    {
      source: 'composite_gate',
      trit: compositeScore >= compositeMin ? 1 : -1,
      weight: 1.5
    },
    {
      source: 'risk_posture',
      trit: risk === 'low' ? 1 : (risk === 'medium' ? 0 : -1),
      weight: 0.8
    },
    {
      source: 'objective_binding',
      trit: row.objective_binding && row.objective_binding.pass === false ? -1 : 1,
      weight: 1.1
    },
    {
      source: 'budget_pacing',
      trit: row.budget_pacing_gate && row.budget_pacing_gate.pass === false ? -1 : 0,
      weight: 0.9
    },
    {
      source: 'non_yield_penalty',
      trit: nonYieldPenalty >= (AUTONOMY_STRATEGY_RANK_NON_YIELD_MAX_PENALTY * 0.5)
        ? -1
        : (nonYieldPenalty <= 2 ? 1 : 0),
      weight: 0.9
    }
  ];

  const belief = evaluateTernaryBelief(signals, {
    label: 'autonomy_strategy_rank_shadow',
    positive_threshold: 0.12,
    negative_threshold: -0.12,
    evidence_saturation_count: 8,
    ...tritShadowBeliefOptions()
  });
  const baseScore = tritShadowRankScoreFromBelief(belief);
  const bonusRaw = Number(row.strategy_rank_bonus && row.strategy_rank_bonus.total || 0);
  const blended = strategyTritShadowAdjustedScore(baseScore, bonusRaw, AUTONOMY_TRIT_SHADOW_BONUS_BLEND);
  const blendedBonus = Number(blended.bonus_applied || 0);
  const adjustedScore = Number(blended.adjusted_score || 0);
  const topSignals = Array.isArray(belief.top_sources) ? belief.top_sources.slice(0, 5) : [];
  return {
    score: baseScore,
    adjusted_score: adjustedScore,
    bonus_blend: AUTONOMY_TRIT_SHADOW_BONUS_BLEND,
    bonus_applied: blendedBonus,
    belief: {
      trit: Number(belief.trit || 0),
      label: String(belief.trit_label || 'unknown'),
      score: Number(belief.score || 0),
      confidence: Number(belief.confidence || 0),
      evidence_count: Number(belief.evidence_count || 0)
    },
    top_sources: topSignals
  };
}

function strategyTritShadowRankingSummary(eligible, selectedProposalId = null, selectionMode = null) {
  if (!AUTONOMY_TRIT_SHADOW_ENABLED) return null;
  const rows = Array.isArray(eligible) ? eligible : [];
  const selected = String(selectedProposalId || '');
  if (!rows.length) {
    return {
      enabled: true,
      considered: 0,
      diverged_from_legacy_top: false,
      diverged_from_selected: false,
      selected_proposal_id: selected || null,
      selection_mode: selectionMode || null,
      legacy_top_proposal_id: null,
      trit_top_proposal_id: null,
      top: []
    };
  }
  const rankingRows = rows.map((cand, idx) => {
    const proposalId = String(cand && cand.proposal && cand.proposal.id || '');
    const legacy = Number(cand && (cand.strategy_rank_adjusted != null
      ? cand.strategy_rank_adjusted
      : (cand.strategy_rank && cand.strategy_rank.score || 0)));
    const tritShadow = cand && cand.strategy_trit_shadow && typeof cand.strategy_trit_shadow === 'object'
      ? cand.strategy_trit_shadow
      : strategyTritShadowForCandidate(cand);
    const tritScore = Number(tritShadow && tritShadow.adjusted_score != null
      ? tritShadow.adjusted_score
      : (tritShadow && tritShadow.score != null ? tritShadow.score : 0));
    return {
      index: idx,
      proposal_id: proposalId,
      legacy_rank: Number(legacy.toFixed(3)),
      trit_rank: Number(tritScore.toFixed(3)),
      trit_label: tritShadow && tritShadow.belief ? tritShadow.belief.label : 'unknown',
      trit_confidence: Number(tritShadow && tritShadow.belief && tritShadow.belief.confidence != null
        ? Number(tritShadow.belief.confidence).toFixed(4)
        : 0),
      trit_top_sources: tritShadow && Array.isArray(tritShadow.top_sources) ? tritShadow.top_sources.slice(0, 3) : []
    };
  });

  const legacyTop = String(rows[0] && rows[0].proposal && rows[0].proposal.id || '');
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = [
      selected,
      String(selectionMode || ''),
      AUTONOMY_TRIT_SHADOW_TOP_K,
      legacyTop,
      rankingRows
        .map((row) => [
          row.index,
          row.proposal_id,
          row.legacy_rank,
          row.trit_rank,
          row.trit_label,
          row.trit_confidence,
          Array.isArray(row.trit_top_sources) ? row.trit_top_sources.join('\u0004') : ''
        ].join('\u0003'))
        .join('\u0002')
    ].join('\u0001');
    if (STRATEGY_TRIT_SHADOW_RANKING_SUMMARY_CACHE.has(key)) {
      return STRATEGY_TRIT_SHADOW_RANKING_SUMMARY_CACHE.get(key);
    }
    const rust = runBacklogAutoscalePrimitive(
      'strategy_trit_shadow_ranking_summary',
      {
        rows: rankingRows,
        selected_proposal_id: selected || null,
        selection_mode: selectionMode || null,
        top_k: AUTONOMY_TRIT_SHADOW_TOP_K
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      const out = {
        enabled: true,
        considered: Number(payload.considered || rows.length),
        selection_mode: payload.selection_mode || selectionMode || null,
        selected_proposal_id: payload.selected_proposal_id || selected || null,
        legacy_top_proposal_id: payload.legacy_top_proposal_id || legacyTop || null,
        trit_top_proposal_id: payload.trit_top_proposal_id || null,
        diverged_from_legacy_top: payload.diverged_from_legacy_top === true,
        diverged_from_selected: payload.diverged_from_selected === true,
        top: Array.isArray(payload.top) ? payload.top : []
      };
      if (STRATEGY_TRIT_SHADOW_RANKING_SUMMARY_CACHE.size >= STRATEGY_TRIT_SHADOW_RANKING_SUMMARY_CACHE_MAX) {
        const oldest = STRATEGY_TRIT_SHADOW_RANKING_SUMMARY_CACHE.keys().next();
        if (!oldest.done) STRATEGY_TRIT_SHADOW_RANKING_SUMMARY_CACHE.delete(oldest.value);
      }
      STRATEGY_TRIT_SHADOW_RANKING_SUMMARY_CACHE.set(key, out);
      return out;
    }
  }

  const ranked = rankingRows.sort((a, b) => {
    if (b.trit_rank !== a.trit_rank) return b.trit_rank - a.trit_rank;
    if (b.legacy_rank !== a.legacy_rank) return b.legacy_rank - a.legacy_rank;
    return String(a.proposal_id || '').localeCompare(String(b.proposal_id || ''));
  });
  const tritTop = String(ranked[0] && ranked[0].proposal_id || '');
  return {
    enabled: true,
    considered: rows.length,
    selection_mode: selectionMode || null,
    selected_proposal_id: selected || null,
    legacy_top_proposal_id: legacyTop || null,
    trit_top_proposal_id: tritTop || null,
    diverged_from_legacy_top: !!(legacyTop && tritTop && legacyTop !== tritTop),
    diverged_from_selected: !!(selected && tritTop && selected !== tritTop),
    top: ranked.slice(0, AUTONOMY_TRIT_SHADOW_TOP_K)
  };
}

function strategyCircuitCooldownHours(p, strategy) {
  const stopPolicy = strategy && strategy.stop_policy && typeof strategy.stop_policy === 'object'
    ? strategy.stop_policy
    : {};
  const breakers = stopPolicy.circuit_breakers && typeof stopPolicy.circuit_breakers === 'object'
    ? stopPolicy.circuit_breakers
    : {};
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const err = String(meta.last_error_code || meta.last_error || '').toLowerCase();
  if (!err) return 0;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = [
      err,
      Number(breakers.http_429_cooldown_hours || 0),
      Number(breakers.http_5xx_cooldown_hours || 0),
      Number(breakers.dns_error_cooldown_hours || 0)
    ].join('\u0000');
    if (STRATEGY_CIRCUIT_COOLDOWN_CACHE.has(key)) {
      return Number(STRATEGY_CIRCUIT_COOLDOWN_CACHE.get(key));
    }
    const rust = runBacklogAutoscalePrimitive(
      'strategy_circuit_cooldown',
      {
        last_error_code: String(meta.last_error_code || ''),
        last_error: String(meta.last_error || ''),
        http_429_cooldown_hours: Number(breakers.http_429_cooldown_hours || 0),
        http_5xx_cooldown_hours: Number(breakers.http_5xx_cooldown_hours || 0),
        dns_error_cooldown_hours: Number(breakers.dns_error_cooldown_hours || 0)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const out = Number(rust.payload.payload.cooldown_hours || 0);
      if (STRATEGY_CIRCUIT_COOLDOWN_CACHE.size >= STRATEGY_CIRCUIT_COOLDOWN_CACHE_MAX) {
        const oldest = STRATEGY_CIRCUIT_COOLDOWN_CACHE.keys().next();
        if (!oldest.done) STRATEGY_CIRCUIT_COOLDOWN_CACHE.delete(oldest.value);
      }
      STRATEGY_CIRCUIT_COOLDOWN_CACHE.set(key, out);
      return out;
    }
  }
  if (err.includes('429') || err.includes('rate_limit')) {
    return Number(breakers.http_429_cooldown_hours || 0);
  }
  if (/5\d\d/.test(err) || err.includes('5xx') || err.includes('server_error')) {
    return Number(breakers.http_5xx_cooldown_hours || 0);
  }
  if (err.includes('dns') || err.includes('enotfound') || err.includes('unreachable')) {
    return Number(breakers.dns_error_cooldown_hours || 0);
  }
  return 0;
}

function runProposalQueue(cmd, id, reasonOrEvidence = '', maybeEvidence = '') {
  const script = path.join(REPO_ROOT, 'habits', 'scripts', 'proposal_queue.js');
  const args = [script, cmd, id];
  if (reasonOrEvidence != null) args.push(String(reasonOrEvidence));
  if (maybeEvidence != null) args.push(String(maybeEvidence));
  const r = spawnSync('node', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return {
    ok: r.status === 0,
    code: r.status || 0,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim()
  };
}

function runRouteExecute(task, tokensEst, repeats14d = 1, errors30d = 0, dryRun = false, sourceEye = '') {
  const script = path.join(REPO_ROOT, 'systems', 'routing', 'route_execute.js');
  const args = [
    script,
    '--task', task,
    '--tokens_est', String(tokensEst),
    '--repeats_14d', String(repeats14d),
    '--errors_30d', String(errors30d)
  ];
  if (sourceEye) args.push('--source_eye', String(sourceEye));
  if (dryRun) args.push('--dry-run');
  const env = {
    ...process.env,
    ROUTER_ENABLED: process.env.ROUTER_ENABLED || '1',
    ROUTER_REQUIRED: process.env.ROUTER_REQUIRED || '1'
  };
  const r = spawnSync('node', args, { cwd: REPO_ROOT, encoding: 'utf8', env });
  const stdout = (r.stdout || '').trim();
  const jsonLines = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('{') && line.endsWith('}'));
  const firstJson = jsonLines[0] || null;
  const parsedJson = jsonLines.map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  let summary = null;
  if (firstJson) {
    try { summary = JSON.parse(firstJson); } catch {}
  }
  const metricsLine = parsedJson.find(obj => obj && obj.type === 'route_execute_metrics' && obj.execution_metrics);
  return {
    ok: r.status === 0,
    code: r.status || 0,
    stdout,
    stderr: (r.stderr || '').trim(),
    summary,
    execution_metrics: metricsLine && metricsLine.execution_metrics && typeof metricsLine.execution_metrics === 'object'
      ? metricsLine.execution_metrics
      : null
  };
}

function isDirectiveClarificationProposal(p) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'is_directive_clarification_proposal',
      { proposal_type: p && p.type == null ? null : String(p && p.type || '') },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.is_clarification === true;
    }
  }
  return String(p && p.type || '').trim().toLowerCase() === 'directive_clarification';
}

function isDirectiveDecompositionProposal(p) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'is_directive_decomposition_proposal',
      { proposal_type: p && p.type == null ? null : String(p && p.type || '') },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.is_decomposition === true;
    }
  }
  return String(p && p.type || '').trim().toLowerCase() === 'directive_decomposition';
}

function sanitizeDirectiveObjectiveId(v) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'sanitize_directive_objective_id',
      { value: v == null ? null : String(v) },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return String(rust.payload.payload.objective_id || '');
    }
  }
  const raw = String(v || '').trim();
  if (!raw) return '';
  if (!/^T[0-9]_[A-Za-z0-9_]+$/.test(raw)) return '';
  return raw;
}

function parseDirectiveFileArgFromCommand(cmd) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'parse_directive_file_arg',
      { command: cmd == null ? null : String(cmd) },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return String(rust.payload.payload.file || '');
    }
  }
  const text = String(cmd || '').trim();
  if (!text) return '';
  const m = text.match(/(?:^|\s)--file=(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const raw = String((m && (m[1] || m[2] || m[3])) || '').trim();
  if (!raw) return '';
  if (!/^config\/directives\/[A-Za-z0-9_]+\.ya?ml$/i.test(raw)) return '';
  return raw.replace(/\\/g, '/');
}

function parseDirectiveObjectiveArgFromCommand(cmd) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'parse_directive_objective_arg',
      { command: cmd == null ? null : String(cmd) },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return String(rust.payload.payload.objective_id || '');
    }
  }
  const text = normalizeSpaces(cmd);
  if (!text) return '';
  const m = text.match(/(?:^|\s)--id=(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const raw = normalizeSpaces(m && (m[1] || m[2] || m[3]));
  const id = sanitizeDirectiveObjectiveId(raw);
  return id || '';
}

function directiveClarificationExecSpec(p) {
  if (!isDirectiveClarificationProposal(p)) return null;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'directive_clarification_exec_spec',
      {
        proposal_type: p && p.type == null ? null : String(p && p.type || ''),
        meta_directive_objective_id: p && p.meta && typeof p.meta === 'object' && p.meta.directive_objective_id == null
          ? null
          : String(p && p.meta && typeof p.meta === 'object' ? p.meta.directive_objective_id || '' : ''),
        suggested_next_command: p && p.suggested_next_command == null ? null : String(p && p.suggested_next_command || '')
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      if (payload.applicable === false) return null;
      if (payload.ok !== true) {
        return {
          ok: false,
          reason: String(payload.reason || 'directive_clarification_missing_file')
        };
      }
      const relFile = normalizeSpaces(payload.file || '');
      const source = normalizeSpaces(payload.source || '');
      const objectiveId = normalizeSpaces(payload.objective_id || '');
      if (!relFile) {
        return {
          ok: false,
          reason: 'directive_clarification_missing_file'
        };
      }
      const absFile = path.resolve(REPO_ROOT, relFile);
      const directivesRoot = path.join(REPO_ROOT, 'config', 'directives') + path.sep;
      if (!absFile.startsWith(directivesRoot) || !fs.existsSync(absFile)) {
        return {
          ok: false,
          reason: 'directive_clarification_file_not_found',
          file: relFile
        };
      }
      const fileObjectiveId = path.basename(relFile).replace(/\.ya?ml$/i, '');
      return {
        ok: true,
        decision: 'DIRECTIVE_VALIDATE',
        objective_id: objectiveId || fileObjectiveId,
        file: relFile,
        source,
        args: ['validate', `--file=${relFile}`]
      };
    }
  }
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const objectiveId = sanitizeDirectiveObjectiveId(meta.directive_objective_id || '');
  let relFile = objectiveId ? `config/directives/${objectiveId}.yaml` : '';
  let source = objectiveId ? 'meta.directive_objective_id' : '';
  if (!relFile) {
    relFile = parseDirectiveFileArgFromCommand(p && p.suggested_next_command);
    if (relFile) source = 'suggested_next_command';
  }
  if (!relFile) {
    return {
      ok: false,
      reason: 'directive_clarification_missing_file'
    };
  }

  const absFile = path.resolve(REPO_ROOT, relFile);
  const directivesRoot = path.join(REPO_ROOT, 'config', 'directives') + path.sep;
  if (!absFile.startsWith(directivesRoot) || !fs.existsSync(absFile)) {
    return {
      ok: false,
      reason: 'directive_clarification_file_not_found',
      file: relFile
    };
  }

  const fileObjectiveId = path.basename(relFile).replace(/\.ya?ml$/i, '');
  return {
    ok: true,
    decision: 'DIRECTIVE_VALIDATE',
    objective_id: objectiveId || fileObjectiveId,
    file: relFile,
    source,
    args: ['validate', `--file=${relFile}`]
  };
}

function directiveDecompositionExecSpec(p) {
  if (!isDirectiveDecompositionProposal(p)) return null;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'directive_decomposition_exec_spec',
      {
        proposal_type: p && p.type == null ? null : String(p && p.type || ''),
        meta_directive_objective_id: p && p.meta && typeof p.meta === 'object' && p.meta.directive_objective_id == null
          ? null
          : String(p && p.meta && typeof p.meta === 'object' ? p.meta.directive_objective_id || '' : ''),
        suggested_next_command: p && p.suggested_next_command == null ? null : String(p && p.suggested_next_command || '')
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      if (payload.applicable === false) return null;
      if (payload.ok !== true) {
        return {
          ok: false,
          reason: String(payload.reason || 'directive_decomposition_missing_objective_id')
        };
      }
      const chosenId = normalizeSpaces(payload.objective_id || '');
      const source = normalizeSpaces(payload.source || '');
      if (!chosenId) {
        return {
          ok: false,
          reason: 'directive_decomposition_missing_objective_id'
        };
      }
      return {
        ok: true,
        decision: 'DIRECTIVE_DECOMPOSE',
        objective_id: chosenId,
        source,
        args: ['decompose', `--id=${chosenId}`]
      };
    }
  }
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const objectiveId = sanitizeDirectiveObjectiveId(meta.directive_objective_id || '');
  const commandId = parseDirectiveObjectiveArgFromCommand(p && p.suggested_next_command);
  const chosenId = objectiveId || commandId;
  const source = objectiveId ? 'meta.directive_objective_id' : (commandId ? 'suggested_next_command' : '');
  if (!chosenId) {
    return {
      ok: false,
      reason: 'directive_decomposition_missing_objective_id'
    };
  }
  return {
    ok: true,
    decision: 'DIRECTIVE_DECOMPOSE',
    objective_id: chosenId,
    source,
    args: ['decompose', `--id=${chosenId}`]
  };
}

function parseActuationSpec(p) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'parse_actuation_spec',
      { proposal: p && typeof p === 'object' ? p : null },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      if (payload.has_spec !== true) return null;
      const kind = String(payload.kind || '').trim();
      if (!kind) return null;
      const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
        ? payload.params
        : {};
      const contextPayload = payload.context && typeof payload.context === 'object'
        ? payload.context
        : {};
      const mutationPayload = contextPayload.mutation_guard && typeof contextPayload.mutation_guard === 'object'
        ? contextPayload.mutation_guard
        : {};
      const controls = mutationPayload.controls && typeof mutationPayload.controls === 'object' && !Array.isArray(mutationPayload.controls)
        ? { ...mutationPayload.controls }
        : {};
      return {
        kind,
        params,
        context: {
          proposal_id: String(contextPayload.proposal_id || '').trim() || null,
          objective_id: sanitizeDirectiveObjectiveId(contextPayload.objective_id || '') || null,
          safety_attestation_id: String(contextPayload.safety_attestation_id || '').trim() || null,
          rollback_receipt_id: String(contextPayload.rollback_receipt_id || '').trim() || null,
          adaptive_mutation_guard_receipt_id: String(contextPayload.adaptive_mutation_guard_receipt_id || '').trim() || null,
          mutation_guard: {
            applies: mutationPayload.applies === true,
            pass: mutationPayload.pass !== false,
            reason: String(mutationPayload.reason || '').trim() || null,
            reasons: Array.isArray(mutationPayload.reasons) ? mutationPayload.reasons.slice(0, 8) : [],
            controls
          }
        }
      };
    }
  }
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const actuation = meta && meta.actuation && typeof meta.actuation === 'object' ? meta.actuation : null;
  if (!actuation) return null;
  const kind = String(actuation.kind || '').trim();
  if (!kind) return null;
  const params = actuation.params && typeof actuation.params === 'object' ? actuation.params : {};
  const actionSpec = p && p.action_spec && typeof p.action_spec === 'object' ? p.action_spec : {};
  const guardControls = meta.adaptive_mutation_guard_controls && typeof meta.adaptive_mutation_guard_controls === 'object'
    ? { ...meta.adaptive_mutation_guard_controls }
    : {};
  const context = {
    proposal_id: String(p && p.id || '').trim() || null,
    objective_id: sanitizeDirectiveObjectiveId(
      meta.objective_id
      || meta.directive_objective_id
      || actionSpec.objective_id
    ) || null,
    safety_attestation_id: String(
      guardControls.safety_attestation
      || meta.safety_attestation_id
      || meta.safety_attestation
      || meta.attestation_id
      || ''
    ).trim() || null,
    rollback_receipt_id: String(
      guardControls.rollback_receipt
      || meta.rollback_receipt_id
      || meta.rollback_receipt
      || actionSpec.rollback_receipt_id
      || ''
    ).trim() || null,
    adaptive_mutation_guard_receipt_id: String(
      guardControls.guard_receipt_id
      || meta.adaptive_mutation_guard_receipt_id
      || meta.mutation_guard_receipt_id
      || ''
    ).trim() || null,
    mutation_guard: {
      applies: meta.adaptive_mutation_guard_applies === true,
      pass: meta.adaptive_mutation_guard_pass !== false,
      reason: String(meta.adaptive_mutation_guard_reason || '').trim() || null,
      reasons: Array.isArray(meta.adaptive_mutation_guard_reasons)
        ? meta.adaptive_mutation_guard_reasons.slice(0, 8)
        : [],
      controls: guardControls
    }
  };
  return { kind, params, context };
}

let objectiveBindingFallbackCache = null;

function loadFallbackDirectiveObjectiveIds() {
  if (objectiveBindingFallbackCache && Array.isArray(objectiveBindingFallbackCache.ids)) {
    return objectiveBindingFallbackCache.ids.slice();
  }
  let directives = [];
  try {
    directives = loadActiveDirectives({ allowMissing: true });
  } catch {
    directives = [];
  }
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'fallback_directive_objective_ids',
      {
        directive_ids: Array.isArray(directives)
          ? directives.map((row) => String(row && row.id || ''))
          : []
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const ids = Array.isArray(rust.payload.payload.ids)
        ? rust.payload.payload.ids.map((x) => String(x || '')).filter(Boolean)
        : [];
      objectiveBindingFallbackCache = { ids };
      return ids.slice();
    }
  }
  const ids = [];
  const seen = new Set();
  for (const row of directives) {
    const id = sanitizeDirectiveObjectiveId(row && row.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  ids.sort((a, b) => String(a).localeCompare(String(b)));
  objectiveBindingFallbackCache = { ids };
  return ids.slice();
}

function objectiveIdsFromPulseContext(pulseCtx) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const objectives = pulseCtx && Array.isArray(pulseCtx.objectives)
      ? pulseCtx.objectives
      : [];
    const fallbackIds = AUTONOMY_OBJECTIVE_BINDING_FALLBACK_DIRECTIVES
      ? loadFallbackDirectiveObjectiveIds()
      : [];
    const rust = runBacklogAutoscalePrimitive(
      'objective_ids_from_pulse_context',
      {
        objectives,
        fallback_enabled: AUTONOMY_OBJECTIVE_BINDING_FALLBACK_DIRECTIVES === true,
        fallback_ids: fallbackIds
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const set = new Set();
      const ids = Array.isArray(rust.payload.payload.ids)
        ? rust.payload.payload.ids
        : [];
      for (const raw of ids) {
        const id = String(raw || '').trim();
        if (!id) continue;
        set.add(id);
      }
      return set;
    }
  }
  const set = new Set();
  const objectives = pulseCtx && Array.isArray(pulseCtx.objectives)
    ? pulseCtx.objectives
    : [];
  for (const row of objectives) {
    const id = String(row && row.id || '').trim();
    if (!id) continue;
    set.add(id);
  }
  if (set.size === 0 && AUTONOMY_OBJECTIVE_BINDING_FALLBACK_DIRECTIVES) {
    for (const id of loadFallbackDirectiveObjectiveIds()) {
      if (!id) continue;
      set.add(id);
    }
  }
  return set;
}

function policyHoldObjectiveContext(pulseCtx, candidateObjectiveIds = []) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const poolObjectiveIds = Array.from(objectiveIdsFromPulseContext(pulseCtx));
    const rust = runBacklogAutoscalePrimitive(
      'policy_hold_objective_context',
      {
        candidate_objective_ids: Array.isArray(candidateObjectiveIds) ? candidateObjectiveIds : [],
        pool_objective_ids: poolObjectiveIds,
        dominant_objective_id: pulseCtx && pulseCtx.dominant_objective_id != null
          ? String(pulseCtx.dominant_objective_id)
          : null
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      const objectiveId = payload.objective_id ? String(payload.objective_id) : '';
      const out: AnyObj = {
        objective_id: objectiveId || null,
        objective_source: payload.objective_source ? String(payload.objective_source) : null
      };
      if (Array.isArray(payload.objective_ids) && payload.objective_ids.length > 0) {
        out.objective_ids = payload.objective_ids.map((x) => String(x || ''));
      }
      return out;
    }
  }
  const set = new Set();
  for (const raw of Array.isArray(candidateObjectiveIds) ? candidateObjectiveIds : []) {
    const id = sanitizeDirectiveObjectiveId(raw);
    if (!id) continue;
    set.add(id);
  }
  if (set.size === 0) {
    for (const raw of objectiveIdsFromPulseContext(pulseCtx)) {
      const id = sanitizeDirectiveObjectiveId(raw);
      if (!id) continue;
      set.add(id);
    }
  }
  const ids = Array.from(set);
  const dominant = sanitizeDirectiveObjectiveId(pulseCtx && pulseCtx.dominant_objective_id);
  const objectiveId = dominant || (ids.length > 0 ? ids[0] : '');
  const out: AnyObj = {
    objective_id: objectiveId || null,
    objective_source: objectiveId
      ? (dominant ? 'directive_pulse_dominant' : 'directive_pulse_pool')
      : null
  };
  if (ids.length > 1) out.objective_ids = ids.slice(0, 8);
  return out;
}

function parseObjectiveIdFromEvidenceRefs(proposal, objectiveSet) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const evidence = Array.isArray(proposal && proposal.evidence) ? proposal.evidence : [];
    const rust = runBacklogAutoscalePrimitive(
      'parse_objective_id_from_evidence_refs',
      {
        evidence_refs: evidence.map((row) => normalizeSpaces(row && row.evidence_ref)),
        objective_ids: Array.from(objectiveSet || [])
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      const objectiveId = payload.objective_id == null ? '' : String(payload.objective_id || '');
      if (objectiveId) {
        return {
          objective_id: objectiveId,
          source: String(payload.source || 'evidence_ref'),
          valid: payload.valid !== false
        };
      }
      return null;
    }
  }
  const evidence = Array.isArray(proposal && proposal.evidence) ? proposal.evidence : [];
  for (const row of evidence) {
    const ref = normalizeSpaces(row && row.evidence_ref);
    if (!ref) continue;
    const pulseMatch = ref.match(/directive_pulse\/([A-Za-z0-9_]+)/i);
    const directMatch = ref.match(/\bdirective:([A-Za-z0-9_]+)/i);
    const fallbackMatch = ref.match(/\b(T[0-9]_[A-Za-z0-9_]+)\b/);
    const raw = normalizeSpaces(
      (pulseMatch && pulseMatch[1])
      || (directMatch && directMatch[1])
      || (fallbackMatch && fallbackMatch[1])
    );
    const id = sanitizeDirectiveObjectiveId(raw);
    if (!id) continue;
    if (objectiveSet.size > 0 && !objectiveSet.has(id)) return { objective_id: id, source: 'evidence_ref', valid: false };
    return { objective_id: id, source: 'evidence_ref', valid: true };
  }
  return null;
}

function parseObjectiveIdFromCommand(proposal, objectiveSet) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'parse_objective_id_from_command',
      {
        command: proposal && proposal.suggested_next_command == null
          ? null
          : String(proposal && proposal.suggested_next_command || ''),
        objective_ids: Array.from(objectiveSet || [])
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      const objectiveId = payload.objective_id == null ? '' : String(payload.objective_id || '');
      if (objectiveId) {
        return {
          objective_id: objectiveId,
          source: String(payload.source || 'suggested_next_command'),
          valid: payload.valid !== false
        };
      }
      return null;
    }
  }
  const cmd = normalizeSpaces(proposal && proposal.suggested_next_command);
  if (!cmd) return null;
  const match = cmd.match(/(?:^|\s)--id=(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const raw = normalizeSpaces(match && (match[1] || match[2] || match[3]));
  const id = sanitizeDirectiveObjectiveId(raw);
  if (!id) return null;
  if (objectiveSet.size > 0 && !objectiveSet.has(id)) return { objective_id: id, source: 'suggested_next_command', valid: false };
  return { objective_id: id, source: 'suggested_next_command', valid: true };
}

function resolveObjectiveBinding(p, pulseCtx) {
  const proposal = p && typeof p === 'object' ? p : {};
  const meta = proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : {};
  const actionSpec = proposal.action_spec && typeof proposal.action_spec === 'object' ? proposal.action_spec : {};
  const nextCmd = normalizeSpaces(proposal.suggested_next_command);
  const executable = !!(nextCmd || (proposal.action_spec && typeof proposal.action_spec === 'object'));
  const objectiveSet = objectiveIdsFromPulseContext(pulseCtx);
  const required = AUTONOMY_OBJECTIVE_BINDING_REQUIRED && executable && objectiveSet.size > 0;

  const directCandidates = [
    { source: 'meta.objective_id', value: meta.objective_id },
    { source: 'meta.directive_objective_id', value: meta.directive_objective_id },
    { source: 'action_spec.objective_id', value: actionSpec.objective_id },
    {
      source: 'meta.action_spec.objective_id',
      value: meta.action_spec && typeof meta.action_spec === 'object' ? meta.action_spec.objective_id : ''
    }
  ];

  let chosen = null;
  for (const row of directCandidates) {
    const id = sanitizeDirectiveObjectiveId(row && row.value);
    if (!id) continue;
    if (objectiveSet.size > 0 && !objectiveSet.has(id)) {
      chosen = { objective_id: id, source: row.source, valid: false };
      break;
    }
    chosen = { objective_id: id, source: row.source, valid: true };
    break;
  }

  if (!chosen) {
    const ev = parseObjectiveIdFromEvidenceRefs(proposal, objectiveSet);
    if (ev) chosen = ev;
  }
  if (!chosen) {
    const cmd = parseObjectiveIdFromCommand(proposal, objectiveSet);
    if (cmd) chosen = cmd;
  }
  if (!chosen && objectiveSet.size === 1) {
    const [only] = Array.from(objectiveSet);
    chosen = { objective_id: only, source: 'single_active_objective', valid: true };
  }
  if (!chosen && required && objectiveSet.size > 1) {
    const [first] = Array.from(objectiveSet).sort((a, b) => String(a).localeCompare(String(b)));
    if (first) chosen = { objective_id: first, source: 'default_first_active_objective', valid: true };
  }

  const objectiveId = String(chosen && chosen.objective_id || '').trim();
  const inObjectiveSet = objectiveId ? objectiveSet.has(objectiveId) : false;
  const valid = objectiveId
    ? (objectiveSet.size === 0 ? true : (chosen.valid !== false && inObjectiveSet))
    : !required;

  const reasons = [];
  if (required && !objectiveId) reasons.push('objective_binding_missing');
  if (required && objectiveId && !valid) reasons.push('objective_binding_invalid');

  return {
    pass: reasons.length === 0,
    required,
    objective_id: objectiveId || null,
    source: chosen ? String(chosen.source || '') : null,
    valid,
    reasons,
    objectives_available: objectiveSet.size
  };
}

function objectiveIdForExecution(p, directivePulse, directiveAction, objectiveBinding) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const proposal = p && typeof p === 'object' ? p : {};
    const meta = proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : {};
    const actionSpec = proposal.action_spec && typeof proposal.action_spec === 'object' ? proposal.action_spec : {};
    const rust = runBacklogAutoscalePrimitive(
      'objective_id_for_execution',
      {
        objective_binding_id: objectiveBinding && objectiveBinding.objective_id == null
          ? null
          : String(objectiveBinding && objectiveBinding.objective_id || ''),
        directive_pulse_id: directivePulse && directivePulse.objective_id == null
          ? null
          : String(directivePulse && directivePulse.objective_id || ''),
        directive_action_id: directiveAction && directiveAction.objective_id == null
          ? null
          : String(directiveAction && directiveAction.objective_id || ''),
        meta_objective_id: meta.objective_id == null ? null : String(meta.objective_id),
        meta_directive_objective_id: meta.directive_objective_id == null ? null : String(meta.directive_objective_id),
        action_spec_objective_id: actionSpec.objective_id == null ? null : String(actionSpec.objective_id)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const objectiveId = rust.payload.payload.objective_id;
      return objectiveId == null ? null : String(objectiveId || '');
    }
  }
  const proposal = p && typeof p === 'object' ? p : {};
  const meta = proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : {};
  const actionSpec = proposal.action_spec && typeof proposal.action_spec === 'object' ? proposal.action_spec : {};
  const candidates = [
    objectiveBinding && objectiveBinding.objective_id,
    directivePulse && directivePulse.objective_id,
    directiveAction && directiveAction.objective_id,
    meta.objective_id,
    meta.directive_objective_id,
    actionSpec.objective_id
  ];
  for (const row of candidates) {
    const id = sanitizeDirectiveObjectiveId(row);
    if (id) return id;
  }
  return null;
}

function runActuationExecute(spec, dryRun = false) {
  const args = [
    ACTUATION_EXECUTOR_SCRIPT,
    'run',
    `--kind=${spec.kind}`,
    `--params=${JSON.stringify(spec.params || {})}`
  ];
  if (spec && spec.context && typeof spec.context === 'object') {
    args.push(`--context=${JSON.stringify(spec.context)}`);
  }
  if (dryRun) args.push('--dry-run');
  const r = spawnSync('node', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  const stdout = (r.stdout || '').trim();
  const firstJson = stdout.split('\n').find(line => line.startsWith('{') && line.endsWith('}'));
  let payload = null;
  if (firstJson) {
    try { payload = JSON.parse(firstJson); } catch {}
  }
  return {
    ok: r.status === 0,
    code: r.status || 0,
    stdout,
    stderr: (r.stderr || '').trim(),
    summary: payload && payload.summary ? payload.summary : null,
    details: payload && payload.details && typeof payload.details === 'object' ? payload.details : null
  };
}

function runDirectiveClarificationValidate(spec, dryRun = false) {
  if (!spec || spec.ok !== true) {
    const reason = spec && spec.reason ? String(spec.reason) : 'directive_clarification_spec_invalid';
    return {
      ok: false,
      code: 2,
      stdout: '',
      stderr: reason,
      summary: {
        decision: 'DIRECTIVE_VALIDATE',
        executable: false,
        gate_decision: 'DENY',
        reason,
        dry_run: !!dryRun
      }
    };
  }

  const script = path.join(REPO_ROOT, 'systems', 'security', 'directive_intake.js');
  const r = spawnSync('node', [script, ...spec.args], { cwd: REPO_ROOT, encoding: 'utf8' });
  const stdout = String(r.stdout || '').trim();
  const stderr = String(r.stderr || '').trim();
  let payload = null;
  if (stdout) {
    try { payload = JSON.parse(stdout); } catch {}
  }
  const payloadOk = payload && payload.ok === true;
  const ok = r.status === 0 && (payload ? payloadOk : true);

  return {
    ok,
    code: r.status || 0,
    stdout,
    stderr,
    summary: {
      decision: 'DIRECTIVE_VALIDATE',
      executable: ok,
      gate_decision: ok ? 'ALLOW' : 'DENY',
      objective_id: spec.objective_id || null,
      file: spec.file || null,
      source: spec.source || null,
      dry_run: !!dryRun,
      quality_ok: payload ? payload.ok === true : null,
      missing: Array.isArray(payload && payload.missing) ? payload.missing.slice(0, 8) : [],
      questions: Array.isArray(payload && payload.questions) ? payload.questions.slice(0, 8) : []
    }
  };
}

function runDirectiveDecomposition(spec, dryRun = false) {
  if (!spec || spec.ok !== true || !sanitizeDirectiveObjectiveId(spec.objective_id)) {
    const reason = spec && spec.reason ? String(spec.reason) : 'directive_decomposition_spec_invalid';
    return {
      ok: false,
      code: 2,
      stdout: '',
      stderr: reason,
      summary: {
        decision: 'DIRECTIVE_DECOMPOSE',
        executable: false,
        gate_decision: 'DENY',
        reason,
        dry_run: !!dryRun
      }
    };
  }

  const args = Array.isArray(spec.args) ? spec.args.slice() : ['decompose', `--id=${spec.objective_id}`];
  if (dryRun) {
    args.push('--dry-run=1');
  } else {
    args.push('--apply=1');
  }
  const r = spawnSync('node', [DIRECTIVE_HIERARCHY_CONTROLLER_SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  const stdout = String(r.stdout || '').trim();
  const stderr = String(r.stderr || '').trim();
  const payload = parseFirstJsonLine(stdout);
  const payloadOk = !!(payload && payload.ok === true);
  const created = Math.max(0, Number(payload && payload.created_count || 0));
  const expired = Math.max(0, Number(payload && payload.expired_count || 0));
  const executable = payloadOk && (created > 0 || expired > 0);
  const ok = r.status === 0 && payloadOk && (dryRun ? executable : true);
  const reason = !payloadOk
    ? String((payload && payload.error) || stderr || `directive_decomposition_exit_${Number(r.status || 1)}`)
    : (dryRun && !executable ? 'no_decomposition_needed' : '');

  return {
    ok,
    code: r.status || 0,
    stdout,
    stderr,
    summary: {
      decision: 'DIRECTIVE_DECOMPOSE',
      executable: !!executable,
      gate_decision: executable ? 'ALLOW' : 'DENY',
      objective_id: spec.objective_id || null,
      source: spec.source || null,
      dry_run: !!dryRun,
      quality_ok: payloadOk,
      created_count: created,
      created_ids: Array.isArray(payload && payload.created_ids) ? payload.created_ids.slice(0, 8) : [],
      expired_count: expired,
      expired_ids: Array.isArray(payload && payload.expired_ids) ? payload.expired_ids.slice(0, 8) : [],
      reason: reason || null
    }
  };
}

function runNodeScript(relPath, args = []) {
  const script = path.join(REPO_ROOT, relPath);
  const r = spawnSync('node', [script, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  return {
    ok: r.status === 0,
    code: r.status || 0,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim()
  };
}

function parseFirstJsonLine(text) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'parse_first_json_line',
      { text: text == null ? null : String(text) },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const value = rust.payload.payload.value;
      return value == null ? null : value;
    }
  }
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try { return JSON.parse(line); } catch {}
  }
  return null;
}

function runProposalEnricher(dateStr, dryRun = false) {
  const args = ['run', dateStr];
  if (dryRun) args.push('--dry-run');
  const r = spawnSync('node', [PROPOSAL_ENRICHER_SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  const stdout = (r.stdout || '').trim();
  return {
    ok: r.status === 0,
    code: r.status || 0,
    stdout,
    stderr: (r.stderr || '').trim(),
    payload: parseFirstJsonLine(stdout)
  };
}

function runStrategyReadiness(dateStr, strategyId, days = null) {
  const args = ['run', dateStr];
  if (strategyId) args.push(`--id=${strategyId}`);
  if (Number.isFinite(Number(days)) && Number(days) > 0) args.push(`--days=${Math.round(Number(days))}`);
  const r = spawnSync('node', [STRATEGY_READINESS_SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  const stdout = (r.stdout || '').trim();
  return {
    ok: r.status === 0,
    code: r.status || 0,
    stdout,
    stderr: (r.stderr || '').trim(),
    payload: parseFirstJsonLine(stdout)
  };
}

function runPostconditions(actuationSpec, execRes = null) {
  const checks = [];
  if (AUTONOMY_POSTCHECK_CONTRACT) {
    const c = runNodeScript(path.join('systems', 'spine', 'contract_check.js'));
    checks.push({
      name: 'contract_check',
      pass: !!c.ok,
      code: c.code,
      stdout: shortText(c.stdout, 160),
      stderr: shortText(c.stderr, 160)
    });
  }

  if (
    AUTONOMY_POSTCHECK_ADAPTER_TESTS
    && actuationSpec
    && String(actuationSpec.kind || '') === 'moltbook_publish'
  ) {
    const t = runNodeScript(path.join('memory', 'tools', 'tests', 'moltbook_publish_guard.test.js'));
    checks.push({
      name: 'adapter_test:moltbook_publish_guard',
      pass: !!t.ok,
      code: t.code,
      stdout: shortText(t.stdout, 160),
      stderr: shortText(t.stderr, 160)
    });
  }

  if (AUTONOMY_POSTCHECK_EXTERNAL_VERIFY && actuationSpec) {
    const summary = execRes && execRes.summary && typeof execRes.summary === 'object'
      ? execRes.summary
      : {};
    const isDryRun = summary.dry_run === true;
    if (!isDryRun) {
      checks.push({
        name: 'actuation_verified',
        pass: summary.verified === true,
        code: summary.verified === true ? 0 : 1,
        stdout: summary.verified === true ? 'verified:true' : 'verified:false',
        stderr: summary.verified === true ? '' : 'actuation_summary_not_verified'
      });
    }
  }

  const failed = checks.filter(c => c.pass !== true).map(c => c.name);
  return {
    checks,
    failed,
    passed: failed.length === 0
  };
}

function shortText(v, max = 220) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'short_text',
      {
        value: v == null ? null : String(v),
        max_len: Number(max)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return String(rust.payload.payload.text || '');
    }
  }
  const s = String(v || '');
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

function normalizedSignalStatus(value, fallback = 'unknown') {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'normalized_signal_status',
      {
        value: value == null ? null : String(value),
        fallback: fallback == null ? null : String(fallback)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return String(rust.payload.payload.status || 'unknown');
    }
  }
  const raw = normalizeSpaces(value).toLowerCase();
  if (raw === 'pass' || raw === 'warn' || raw === 'fail') return raw;
  return fallback;
}

function preexecVerdictFromSignals(blockers, signals, nextRunnableAt) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'preexec_verdict_from_signals',
      {
        blockers: Array.isArray(blockers) ? blockers : [],
        signals: signals && typeof signals === 'object' ? signals : {},
        next_runnable_at: nextRunnableAt ? String(nextRunnableAt) : null,
        now_iso: nowIso()
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      return {
        verdict: String(payload.verdict || 'proceed'),
        confidence: Number(Number(payload.confidence || 0).toFixed(3)),
        blocker_count: Math.max(0, Number(payload.blocker_count || 0)),
        blocker_codes: Array.isArray(payload.blocker_codes) ? payload.blocker_codes.map((x) => String(x || '')).slice(0, 16) : [],
        manual_action_required: payload.manual_action_required === true,
        next_runnable_at: payload.next_runnable_at ? String(payload.next_runnable_at) : null,
        signals: payload.signals && typeof payload.signals === 'object' ? payload.signals : {}
      };
    }
  }
  const blockerRows = Array.isArray(blockers) ? blockers : [];
  const signalMap = signals && typeof signals === 'object' ? signals : {};
  const blockerCodes = blockerRows
    .map((b) => String(b && b.code || '').trim())
    .filter(Boolean)
    .slice(0, 16);
  const manualActionRequired = blockerRows.some((b) => b && b.retryable !== true);
  const retryableOnly = blockerRows.length > 0 && blockerRows.every((b) => b && b.retryable === true);
  let verdict = 'proceed';
  if (blockerRows.length > 0) {
    verdict = manualActionRequired ? 'reject' : (retryableOnly ? 'defer' : 'reject');
  }

  let failCount = 0;
  let warnCount = 0;
  for (const row of Object.values(signalMap as AnyObj)) {
    const signal = row && typeof row === 'object' ? row : {};
    const status = normalizedSignalStatus(signal.status, 'unknown');
    if (status === 'fail') failCount += 1;
    else if (status === 'warn') warnCount += 1;
  }
  const blockerPenalty = blockerRows.length > 0
    ? Math.min(0.42, blockerRows.length * 0.06)
    : 0;
  let confidence = 1
    - (failCount * 0.22)
    - (warnCount * 0.08)
    - blockerPenalty;
  confidence = clampNumber(confidence, 0.05, 1);
  if (verdict === 'reject') confidence = Math.min(confidence, 0.49);
  if (verdict === 'defer') confidence = Math.min(confidence, 0.69);

  return {
    verdict,
    confidence: Number(confidence.toFixed(3)),
    blocker_count: blockerRows.length,
    blocker_codes: blockerCodes,
    manual_action_required: manualActionRequired,
    next_runnable_at: verdict === 'proceed' ? nowIso() : (nextRunnableAt || null),
    signals: signalMap
  };
}

function sanitizedDirectiveIdList(rows, limit = 12) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'sanitized_directive_id_list',
      {
        rows: Array.isArray(rows) ? rows.map((x) => String(x || '')) : [],
        limit: Number(limit)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Array.isArray(rust.payload.payload.ids)
        ? rust.payload.payload.ids.map((x) => String(x || ''))
        : [];
    }
  }
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(rows) ? rows : []) {
    if (out.length >= limit) break;
    const id = sanitizeDirectiveObjectiveId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function proposalDependencySummary(proposal, directiveAction, actionSummary = null) {
  const action = directiveAction && typeof directiveAction === 'object' ? directiveAction : null;
  if (!action) return null;
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const summary = actionSummary && typeof actionSummary === 'object' ? actionSummary : {};
  const decision = normalizeSpaces(action.decision || '').toUpperCase();
  if (!decision) return null;
  const parentObjectiveId = sanitizeDirectiveObjectiveId(action.objective_id || '');
  const createdIds = sanitizedDirectiveIdList(summary.created_ids, 16);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'proposal_dependency_summary',
      {
        proposal_id: String(p.id || '').trim() || null,
        decision,
        source: String(action.source || '').trim() || null,
        parent_objective_id: parentObjectiveId || null,
        created_ids: createdIds,
        dry_run: summary.dry_run === true,
        created_count: Number(summary.created_count),
        quality_ok: summary.quality_ok === true,
        reason: summary.reason || null
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  const nodes = [];
  const edges = [];
  if (parentObjectiveId) {
    nodes.push({
      id: parentObjectiveId,
      kind: 'directive',
      role: 'parent'
    });
  }
  for (const childId of createdIds) {
    nodes.push({
      id: childId,
      kind: 'directive',
      role: 'child'
    });
    if (parentObjectiveId) {
      edges.push({
        from: parentObjectiveId,
        to: childId,
        relation: 'parent_child'
      });
    }
  }
  const chain = parentObjectiveId
    ? [parentObjectiveId, ...createdIds]
    : createdIds.slice();
  return {
    proposal_id: String(p.id || '').trim() || null,
    decision,
    source: String(action.source || '').trim() || null,
    parent_objective_id: parentObjectiveId || null,
    child_objective_ids: createdIds,
    edge_count: edges.length,
    nodes: nodes.slice(0, 20),
    edges: edges.slice(0, 20),
    chain,
    dry_run: summary.dry_run === true,
    created_count: Number(summary.created_count || createdIds.length || 0),
    quality_ok: summary.quality_ok === true,
    reason: summary.reason || null
  };
}

function numberOrNull(v) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'number_or_null',
      { value: Number(v) },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.value == null ? null : Number(rust.payload.payload.value);
    }
  }
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseJsonObjectsFromText(text, maxObjects = 40) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'parse_json_objects_from_text',
      {
        text: text == null ? null : String(text),
        max_objects: Number(maxObjects)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Array.isArray(rust.payload.payload.objects)
        ? rust.payload.payload.objects.filter((row) => row && typeof row === 'object')
        : [];
    }
  }
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{') && l.endsWith('}'));
  const out = [];
  for (const line of lines) {
    if (out.length >= maxObjects) break;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {
      // Ignore malformed lines.
    }
  }
  return out;
}

function readPathValue(obj, pathExpr) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'read_path_value',
      {
        obj: obj && typeof obj === 'object' ? obj : null,
        path_expr: pathExpr == null ? null : String(pathExpr)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.value == null ? null : rust.payload.payload.value;
    }
  }
  const src = obj && typeof obj === 'object' ? obj : null;
  if (!src) return null;
  const parts = String(pathExpr || '').split('.').filter(Boolean);
  if (!parts.length) return null;
  let cur = src;
  for (const key of parts) {
    if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, key)) {
      return null;
    }
    cur = cur[key];
  }
  return cur;
}

function readFirstNumericMetric(sources, pathExprs) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'read_first_numeric_metric',
      {
        sources: Array.isArray(sources) ? sources.filter((row) => row && typeof row === 'object') : [],
        path_exprs: Array.isArray(pathExprs) ? pathExprs.map((x) => String(x || '')) : []
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.value == null ? null : Number(rust.payload.payload.value);
    }
  }
  const rows = Array.isArray(pathExprs) ? pathExprs : [];
  for (const expr of rows) {
    for (const src of sources) {
      const raw = readPathValue(src, expr);
      const n = numberOrNull(raw);
      if (n != null) return n;
    }
  }
  return null;
}

function extractSuccessCriteriaMetricValues(proposal, opts: AnyObj = {}) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  const execSummary = opts.exec_summary && typeof opts.exec_summary === 'object' ? opts.exec_summary : {};
  const executionMetrics = opts.execution_metrics && typeof opts.execution_metrics === 'object' ? opts.execution_metrics : {};
  const execDetails = opts.exec_details && typeof opts.exec_details === 'object' ? opts.exec_details : {};
  const dodDiff = opts.dod_diff && typeof opts.dod_diff === 'object' ? opts.dod_diff : {};
  const execStdoutObjects = parseJsonObjectsFromText(opts.exec_stdout || '');
  const outcomeObjects = parseJsonObjectsFromText(opts.outcome_stdout || '');

  const sources = [
    meta.metric_values,
    meta,
    execSummary.metric_values,
    execSummary,
    executionMetrics.metric_values,
    executionMetrics,
    execDetails
  ];
  for (const obj of execStdoutObjects) {
    sources.push(obj.metric_values, obj.execution_metrics, obj.summary, obj.details, obj.receipt, obj);
  }
  for (const obj of outcomeObjects) {
    sources.push(obj.metric_values, obj.details, obj.summary, obj);
  }

  const out: AnyObj = {};
  const setMetric = (name, value) => {
    const n = numberOrNull(value);
    if (n != null) out[name] = n;
  };
  const setDefaultMetric = (name, fallback = 0) => {
    if (Object.prototype.hasOwnProperty.call(out, name)) return;
    const n = numberOrNull(fallback);
    if (n != null) out[name] = n;
  };

  const artifactsDelta = numberOrNull(dodDiff.artifacts_delta);
  const entriesDelta = numberOrNull(dodDiff.entries_delta);
  const revenueDelta = numberOrNull(dodDiff.revenue_actions_delta);
  setMetric('artifact_count', artifactsDelta);
  setMetric('entries_count', entriesDelta);
  setMetric('revenue_actions_count', revenueDelta);
  setDefaultMetric('artifact_count', artifactsDelta != null ? artifactsDelta : 0);
  setDefaultMetric('entries_count', entriesDelta != null ? entriesDelta : 0);
  setDefaultMetric('revenue_actions_count', revenueDelta != null ? revenueDelta : 0);

  const outreachArtifact = readFirstNumericMetric(sources, [
    'outreach_artifact',
    'outreach_artifact_count',
    'proposal_draft_count',
    'offer_draft_count',
    'draft_count',
    'artifact_count',
    'artifacts_created',
    'details.outreach_artifact_count',
    'details.proposal_draft_count'
  ]);
  if (outreachArtifact != null) {
    setMetric('outreach_artifact', outreachArtifact);
    setMetric('outreach_artifact_count', outreachArtifact);
    setMetric('proposal_draft_count', outreachArtifact);
  } else if (artifactsDelta != null) {
    // Fallback to DoD evidence deltas when explicit outreach counters are absent.
    setMetric('outreach_artifact', artifactsDelta);
    setMetric('outreach_artifact_count', artifactsDelta);
  }

  const replyCount = readFirstNumericMetric(sources, [
    'reply_count',
    'outreach_reply_count',
    'replies',
    'engagement.reply_count',
    'details.reply_count'
  ]);
  const interviewCount = readFirstNumericMetric(sources, [
    'interview_count',
    'outreach_interview_count',
    'interviews',
    'engagement.interview_count',
    'details.interview_count'
  ]);
  const replyOrInterview = readFirstNumericMetric(sources, [
    'reply_or_interview_count',
    'engagement.reply_or_interview_count',
    'details.reply_or_interview_count'
  ]);
  setMetric('reply_count', replyCount);
  setMetric('outreach_reply_count', replyCount);
  setMetric('interview_count', interviewCount);
  setMetric('outreach_interview_count', interviewCount);
  if (replyOrInterview != null) {
    setMetric('reply_or_interview_count', replyOrInterview);
  } else if (replyCount != null || interviewCount != null) {
    setMetric('reply_or_interview_count', Number(replyCount || 0) + Number(interviewCount || 0));
  }

  // Deterministic defaults prevent "unknown" criteria rows for known outreach metrics.
  setDefaultMetric('outreach_artifact', 0);
  setDefaultMetric('outreach_artifact_count', Number(out.outreach_artifact || 0));
  setDefaultMetric('proposal_draft_count', Number(out.outreach_artifact || 0));
  setDefaultMetric('reply_count', 0);
  setDefaultMetric('outreach_reply_count', Number(out.reply_count || 0));
  setDefaultMetric('interview_count', 0);
  setDefaultMetric('outreach_interview_count', Number(out.interview_count || 0));
  setDefaultMetric('reply_or_interview_count', Number(out.reply_count || 0) + Number(out.interview_count || 0));

  return Object.keys(out).length ? out : null;
}

function assessSuccessCriteriaQuality(criteria) {
  const src = criteria && typeof criteria === 'object' ? criteria : {};
  const checks = Array.isArray(src.checks) ? src.checks : [];
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'assess_success_criteria_quality',
      {
        checks: checks.map((row) => ({
          evaluated: row && row.evaluated === true,
          reason: row && row.reason == null ? null : String(row && row.reason || '')
        })),
        total_count: Number(src.total_count || 0),
        unknown_count: Number(src.unknown_count || 0),
        synthesized: src.synthesized === true
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  const totalCount = Number(src.total_count || 0);
  const unknownExemptReasons = new Set([
    'artifact_delta_unavailable',
    'entry_delta_unavailable',
    'revenue_delta_unavailable',
    'outreach_artifact_unavailable',
    'reply_or_interview_count_unavailable',
    'deferred_pending_window'
  ]);
  const unknownExemptCount = checks.filter((row) => {
    if (!row || row.evaluated === true) return false;
    const reason = String(row.reason || '');
    return unknownExemptReasons.has(reason);
  }).length;
  const unknownCountRaw = Number(src.unknown_count || 0);
  const unknownCount = Math.max(0, unknownCountRaw - unknownExemptCount);
  const unknownRate = totalCount > 0
    ? (unknownCount / totalCount)
    : (checks.length > 0
      ? (Math.max(0, checks.filter((row) => !(row && row.evaluated === true)).length - unknownExemptCount) / checks.length)
      : 1);
  const unsupportedCount = checks.filter((row) => {
    const reason = String(row && row.reason || '');
    return reason === 'unsupported_metric' || reason === 'metric_not_allowed_for_capability';
  }).length;
  const unsupportedRate = checks.length > 0 ? (unsupportedCount / checks.length) : 0;
  const synthesized = src.synthesized === true;
  const reasons = [];
  if (synthesized) reasons.push('synthesized_criteria');
  if (unknownRate > 0.4) reasons.push('high_unknown_rate');
  if (unsupportedRate > 0.5) reasons.push('high_unsupported_rate');
  return {
    insufficient: reasons.length > 0,
    reasons,
    total_count: totalCount,
    unknown_count_raw: unknownCountRaw,
    unknown_exempt_count: unknownExemptCount,
    unknown_count: unknownCount,
    unknown_rate: Number(unknownRate.toFixed(4)),
    unsupported_count: unsupportedCount,
    unsupported_rate: Number(unsupportedRate.toFixed(4)),
    synthesized
  };
}

function hasStructuralPreviewCriteriaFailure(verification) {
  const src = verification && typeof verification === 'object' ? verification : {};
  const criteria = src.success_criteria && typeof src.success_criteria === 'object'
    ? src.success_criteria
    : {};
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'structural_preview_criteria_failure',
      {
        primary_failure: String(src.primary_failure || ''),
        contract_not_allowed_count: Number(criteria.contract_not_allowed_count || 0),
        unsupported_count: Number(criteria.unsupported_count || 0),
        total_count: Number(criteria.total_count || 0)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.has_failure === true;
    }
  }

  const primary = String(src.primary_failure || '').toLowerCase();
  if (primary.includes('metric_not_allowed_for_capability')) return true;
  if (primary.includes('insufficient_supported_metrics')) return true;
  const notAllowed = Math.max(0, Number(criteria.contract_not_allowed_count || 0));
  const unsupported = Math.max(0, Number(criteria.unsupported_count || 0));
  const total = Math.max(1, Number(criteria.total_count || 0));
  if (notAllowed > 0) return true;
  if (unsupported > 0 && (unsupported / total) >= 0.5) return true;
  return false;
}

function preExecCriteriaGateDecision(criteria, policy) {
  const src = criteria && typeof criteria === 'object' ? criteria : {};
  const cfg = policy && typeof policy === 'object' ? policy : {};
  const minCount = Math.max(0, Number(src.min_count != null ? src.min_count : cfg.min_count || 0));
  const totalCount = Math.max(0, Number(src.total_count || 0));
  const unsupportedCount = Math.max(
    0,
    Number(src.contract_not_allowed_count || 0) + Number(src.unsupported_count || 0)
  );
  const supportedCount = Math.max(
    0,
    Number(src.structurally_supported_count != null ? src.structurally_supported_count : (totalCount - unsupportedCount))
  );
  const contract = src.contract && typeof src.contract === 'object' ? src.contract : {};
  const violationCount = Math.max(0, Number(contract.violation_count || 0));

  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'criteria_gate',
      {
        min_count: minCount,
        total_count: totalCount,
        contract_not_allowed_count: Number(src.contract_not_allowed_count || 0),
        unsupported_count: Number(src.unsupported_count || 0),
        structurally_supported_count: src.structurally_supported_count != null
          ? Number(src.structurally_supported_count)
          : null,
        contract_violation_count: violationCount
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }

  const reasons = [];
  if (totalCount < minCount) reasons.push('criteria_count_below_min');
  if (violationCount > 0) reasons.push('criteria_contract_violation');
  if (supportedCount < minCount) reasons.push('criteria_supported_count_below_min');
  return {
    pass: reasons.length === 0,
    reasons,
    min_count: minCount,
    total_count: totalCount,
    supported_count: supportedCount,
    unsupported_count: unsupportedCount,
    contract_violation_count: violationCount
  };
}

function withSuccessCriteriaQualityAudit(verification) {
  const base = verification && typeof verification === 'object' ? verification : {};
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'success_criteria_quality_audit',
      { verification: base },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload.verification;
      if (payload && typeof payload === 'object') return payload;
    }
  }
  const criteria = base.success_criteria && typeof base.success_criteria === 'object'
    ? base.success_criteria
    : null;
  if (!criteria) {
    return {
      ...base,
      criteria_quality: null,
      criteria_quality_insufficient: false
    };
  }
  const quality = assessSuccessCriteriaQuality(criteria);
  return {
    ...base,
    criteria_quality: quality,
    criteria_quality_insufficient: quality.insufficient === true
  };
}

function normalizeTokenUsageShape(raw, source = 'unknown') {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const src = raw && typeof raw === 'object' ? raw : null;
    const rust = runBacklogAutoscalePrimitive(
      'normalize_token_usage_shape',
      {
        prompt_tokens: src ? numberOrNull(src.prompt_tokens) : null,
        input_tokens: src ? numberOrNull(src.input_tokens) : null,
        completion_tokens: src ? numberOrNull(src.completion_tokens) : null,
        output_tokens: src ? numberOrNull(src.output_tokens) : null,
        total_tokens: src ? numberOrNull(src.total_tokens) : null,
        tokens_used: src ? numberOrNull(src.tokens_used) : null,
        source: source == null ? 'unknown' : String(source)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      if (payload.has_value !== true || !payload.usage || typeof payload.usage !== 'object') return null;
      const usage = payload.usage;
      return {
        prompt_tokens: numberOrNull(usage.prompt_tokens),
        completion_tokens: numberOrNull(usage.completion_tokens),
        total_tokens: numberOrNull(usage.total_tokens),
        source: String(usage.source || 'unknown')
      };
    }
  }
  if (!raw || typeof raw !== 'object') return null;
  const prompt = numberOrNull(raw.prompt_tokens != null ? raw.prompt_tokens : raw.input_tokens);
  const completion = numberOrNull(raw.completion_tokens != null ? raw.completion_tokens : raw.output_tokens);
  const totalDirect = numberOrNull(raw.total_tokens != null ? raw.total_tokens : raw.tokens_used);
  const total = totalDirect != null
    ? totalDirect
    : (prompt != null || completion != null ? Number((prompt || 0) + (completion || 0)) : null);
  if (total == null && prompt == null && completion == null) return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    source: String(source || 'unknown')
  };
}

function computeExecutionTokenUsage(summary, executionMetrics, routeTokensEst, fallbackEstTokens) {
  const routeSummary = summary && typeof summary === 'object' ? summary : {};
  const cost = routeSummary.cost_estimate && typeof routeSummary.cost_estimate === 'object'
    ? routeSummary.cost_estimate
    : {};
  const routeBudget = routeSummary.route_budget && typeof routeSummary.route_budget === 'object'
    ? routeSummary.route_budget
    : {};

  const estSelected = numberOrNull(cost.selected_model_tokens_est)
    ?? numberOrNull(routeBudget.request_tokens_est)
    ?? numberOrNull(routeTokensEst)
    ?? numberOrNull(fallbackEstTokens)
    ?? 0;

  const rawMetricsUsage = executionMetrics && executionMetrics.token_usage && typeof executionMetrics.token_usage === 'object'
    ? executionMetrics.token_usage
    : null;

  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'token_usage',
      {
        selected_model_tokens_est: numberOrNull(cost.selected_model_tokens_est),
        route_budget_request_tokens_est: numberOrNull(routeBudget.request_tokens_est),
        route_tokens_est: numberOrNull(routeTokensEst),
        fallback_est_tokens: numberOrNull(fallbackEstTokens),
        metrics_prompt_tokens: rawMetricsUsage
          ? numberOrNull(rawMetricsUsage.prompt_tokens != null ? rawMetricsUsage.prompt_tokens : rawMetricsUsage.input_tokens)
          : null,
        metrics_input_tokens: rawMetricsUsage ? numberOrNull(rawMetricsUsage.input_tokens) : null,
        metrics_completion_tokens: rawMetricsUsage
          ? numberOrNull(rawMetricsUsage.completion_tokens != null ? rawMetricsUsage.completion_tokens : rawMetricsUsage.output_tokens)
          : null,
        metrics_output_tokens: rawMetricsUsage ? numberOrNull(rawMetricsUsage.output_tokens) : null,
        metrics_total_tokens: rawMetricsUsage
          ? numberOrNull(rawMetricsUsage.total_tokens != null ? rawMetricsUsage.total_tokens : rawMetricsUsage.tokens_used)
          : null,
        metrics_tokens_used: rawMetricsUsage ? numberOrNull(rawMetricsUsage.tokens_used) : null,
        metrics_source: rawMetricsUsage && rawMetricsUsage.source != null ? String(rawMetricsUsage.source) : 'route_execute_metrics'
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }

  const metricsUsage = normalizeTokenUsageShape(
    rawMetricsUsage,
    'route_execute_metrics'
  );

  const actualTotal = metricsUsage && numberOrNull(metricsUsage.total_tokens) != null
    ? Number(metricsUsage.total_tokens)
    : null;

  const effectiveTokens = actualTotal != null
    ? actualTotal
    : estSelected;

  return {
    available: actualTotal != null,
    source: actualTotal != null
      ? String(metricsUsage.source || 'route_execute_metrics')
      : 'estimated_fallback',
    actual_prompt_tokens: metricsUsage ? numberOrNull(metricsUsage.prompt_tokens) : null,
    actual_completion_tokens: metricsUsage ? numberOrNull(metricsUsage.completion_tokens) : null,
    actual_total_tokens: actualTotal,
    estimated_tokens: estSelected,
    effective_tokens: effectiveTokens
  };
}

function hashObj(v) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    try {
      const json = JSON.stringify(v);
      const rust = runBacklogAutoscalePrimitive(
        'hash_obj',
        { json: json == null ? null : String(json) },
        { allow_cli_fallback: true }
      );
      if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
        const hash = rust.payload.payload.hash;
        return hash == null ? null : String(hash);
      }
    } catch {}
  }
  try {
    return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
  } catch {
    return null;
  }
}

function compactCmdResult(res) {
  if (!res) return null;
  const stdoutCompacted = compactCommandOutput(res.stdout || '', 'autonomy_cmd:stdout');
  const stderrCompacted = compactCommandOutput(res.stderr || '', 'autonomy_cmd:stderr');
  const stdoutView = stdoutCompacted.compacted ? stdoutCompacted.text : shortText(stdoutCompacted.text, 200);
  const stderrView = stderrCompacted.compacted ? stderrCompacted.text : shortText(stderrCompacted.text, 200);
  return {
    ok: !!res.ok,
    code: Number(res.code || 0),
    skipped: !!res.skipped,
    stdout: stdoutView,
    stderr: stderrView,
    stdout_compacted: stdoutCompacted.compacted === true,
    stdout_raw_path: stdoutCompacted.raw_path || null,
    stderr_compacted: stderrCompacted.compacted === true,
    stderr_raw_path: stderrCompacted.raw_path || null
  };
}

function truthyFlag(v) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'truthy_flag',
      { value: v == null ? null : v },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.value === true;
    }
  }
  if (v === true) return true;
  if (v === false || v == null) return false;
  const t = String(v).trim().toLowerCase();
  return t === 'true' || t === '1' || t === 'yes';
}

function falseyFlag(v) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'falsey_flag',
      { value: v == null ? null : v },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.value === true;
    }
  }
  if (v === false) return true;
  if (v === true || v == null) return false;
  const t = String(v).trim().toLowerCase();
  return t === 'false' || t === '0' || t === 'no';
}

function routeExecutionPolicyHold(summary, executionTarget) {
  const target = String(executionTarget || '').trim().toLowerCase();
  const out = {
    hold: false,
    hold_scope: null,
    hold_reason: null,
    route_block_reason: null
  };
  if (target !== 'route') return out;
  const s = summary && typeof summary === 'object' ? summary : {};
  const gateDecision = String(s.gate_decision || '').trim().toUpperCase();
  const routeDecision = String(s.route_decision_raw || s.decision || '').trim().toUpperCase();
  const needsManualReview = truthyFlag(s.needs_manual_review);
  const executable = !falseyFlag(s.executable);
  const budgetReason = normalizeSpaces(
    s.budget_block_reason
      || (s.budget_enforcement && s.budget_enforcement.reason)
      || (s.budget_global_guard && s.budget_global_guard.reason)
      || ''
  );
  const routeReason = normalizeSpaces(
    s.reason
      || s.route_reason
      || ''
  );
  const budgetBlockedFlag = truthyFlag(s.budget_blocked);
  const budgetGlobalBlocked = truthyFlag(s.budget_global_guard && s.budget_global_guard.blocked);
  const budgetEnforcementBlocked = truthyFlag(s.budget_enforcement && s.budget_enforcement.blocked);

  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'route_execution_policy_hold',
      {
        target: target || 'route',
        gate_decision: String(s.gate_decision || ''),
        route_decision_raw: String(s.route_decision_raw || ''),
        decision: String(s.decision || ''),
        needs_manual_review: needsManualReview === true,
        executable: executable === true,
        budget_block_reason: String(s.budget_block_reason || ''),
        budget_enforcement_reason: String((s.budget_enforcement && s.budget_enforcement.reason) || ''),
        budget_global_reason: String((s.budget_global_guard && s.budget_global_guard.reason) || ''),
        summary_reason: String(s.reason || ''),
        route_reason: String(s.route_reason || ''),
        budget_blocked: budgetBlockedFlag,
        budget_global_blocked: budgetGlobalBlocked,
        budget_enforcement_blocked: budgetEnforcementBlocked
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }

  const budgetSignalText = normalizeSpaces([budgetReason, routeReason].filter(Boolean).join(' ')).toLowerCase();
  const budgetBlockedByReason = budgetSignalText.includes('burn_rate_exceeded')
    || budgetSignalText.includes('budget_autopause')
    || budgetSignalText.includes('budget guard blocked')
    || budgetSignalText.includes('budget_deferred')
    || budgetSignalText.includes('budget_blocked');
  const budgetBlocked = budgetBlockedFlag
    || budgetGlobalBlocked
    || budgetEnforcementBlocked
    || budgetBlockedByReason;
  if (budgetBlocked) {
    const reason = budgetReason || 'budget_guard_blocked';
    return {
      hold: true,
      hold_scope: 'budget',
      hold_reason: reason,
      route_block_reason: reason
    };
  }
  const manualBlocked = gateDecision === 'MANUAL'
    || routeDecision === 'MANUAL'
    || needsManualReview === true;
  if (manualBlocked && !executable) {
    return {
      hold: true,
      hold_scope: 'proposal',
      hold_reason: 'gate_manual',
      route_block_reason: 'gate_manual'
    };
  }
  return out;
}

function verifyExecutionReceipt(execRes, dod, outcomeRes, postconditions, successCriteria) {
  const decision = String(execRes && execRes.summary && execRes.summary.decision || '');
  const execCheckName = decision === 'ACTUATE'
    ? 'actuation_execute_ok'
    : decision === 'DIRECTIVE_VALIDATE'
      ? 'directive_validate_ok'
      : decision === 'DIRECTIVE_DECOMPOSE'
        ? 'directive_decompose_ok'
      : 'route_execute_ok';
  const routeAttestation = execRes
    && execRes.execution_metrics
    && execRes.execution_metrics.route_model_attestation
    && typeof execRes.execution_metrics.route_model_attestation === 'object'
      ? execRes.execution_metrics.route_model_attestation
      : null;
  const routeAttestationStatus = String(routeAttestation && routeAttestation.status || '').toLowerCase();
  const routeExpectedModel = String(routeAttestation && routeAttestation.expected_model || '').trim();
  const routeAttestationMismatch = !!routeExpectedModel && routeAttestationStatus === 'mismatch';
  const criteria = toSuccessCriteriaRecord(successCriteria, { required: false, min_count: 0 });
  const criteriaRequired = criteria.required === true;
  const criteriaPass = criteriaRequired ? criteria.passed === true : true;
  let checks = [
    { name: execCheckName, pass: !!(execRes && execRes.ok === true) },
    { name: 'postconditions_ok', pass: !!(postconditions && postconditions.passed === true) },
    { name: 'dod_passed', pass: !!(dod && dod.passed === true) },
    { name: 'success_criteria_met', pass: criteriaPass },
    { name: 'queue_outcome_logged', pass: !!(outcomeRes && outcomeRes.ok === true) },
    { name: 'route_model_attested', pass: !routeAttestationMismatch }
  ];
  let failed = checks.filter(c => !c.pass).map(c => c.name);
  let outcome = 'shipped';
  let primaryFailure = failed.length
    ? (failed[0] === 'success_criteria_met' && criteria.primary_failure
      ? String(criteria.primary_failure)
      : failed[0])
    : null;

  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'receipt_verdict',
      {
        decision,
        exec_ok: !!(execRes && execRes.ok === true),
        postconditions_ok: !!(postconditions && postconditions.passed === true),
        dod_passed: !!(dod && dod.passed === true),
        success_criteria_required: criteriaRequired === true,
        success_criteria_passed: criteria.passed === true,
        queue_outcome_logged: !!(outcomeRes && outcomeRes.ok === true),
        route_attestation_status: routeAttestationStatus,
        route_attestation_expected_model: routeExpectedModel,
        success_criteria_primary_failure: criteria.primary_failure ? String(criteria.primary_failure) : null
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      if (Array.isArray(payload.checks)) checks = payload.checks.map((row) => ({
        name: String(row && row.name || ''),
        pass: row && row.pass === true
      }));
      failed = Array.isArray(payload.failed)
        ? payload.failed.map((row) => String(row || '')).filter(Boolean)
        : failed;
      outcome = String(payload.outcome || outcome);
      primaryFailure = payload.primary_failure != null ? String(payload.primary_failure) : primaryFailure;
    } else {
      const checkMap = Object.create(null);
      for (const check of checks) checkMap[check.name] = check.pass === true;
      if (!checkMap[execCheckName] || !checkMap.postconditions_ok || !checkMap.queue_outcome_logged || !checkMap.route_model_attested) outcome = 'reverted';
      else if (!checkMap.dod_passed || !checkMap.success_criteria_met) outcome = 'no_change';
    }
  } else {
    const checkMap = Object.create(null);
    for (const check of checks) checkMap[check.name] = check.pass === true;
    if (!checkMap[execCheckName] || !checkMap.postconditions_ok || !checkMap.queue_outcome_logged || !checkMap.route_model_attested) outcome = 'reverted';
    else if (!checkMap.dod_passed || !checkMap.success_criteria_met) outcome = 'no_change';
  }

  const verification = withSuccessCriteriaVerification({
    checks,
    failed,
    passed: failed.length === 0,
    outcome,
    primary_failure: primaryFailure
  }, criteria);
  verification.route_model_attestation = routeAttestation
    ? {
      status: routeAttestationStatus || null,
      expected_model: routeExpectedModel || null,
      observed_model: String(routeAttestation.observed_model || '').trim() || null,
      mismatch: routeAttestationMismatch
    }
    : null;
  return withSuccessCriteriaQualityAudit(verification);
}

function makeTaskFromProposal(p) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'task_from_proposal',
      {
        proposal_id: p && p.id == null ? null : String(p && p.id || ''),
        proposal_type: p && p.type == null ? null : String(p && p.type || ''),
        title: p && p.title == null ? null : String(p && p.title || '')
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const task = String(rust.payload.payload.task || '');
      if (task) return task;
    }
  }
  const proposalId = String((p && p.id) || 'unknown');
  const proposalType = String((p && p.type) || 'task').replace(/[^a-z0-9_-]/gi, '').toLowerCase();
  const title = String(p.title || '')
    .replace(/\[Eyes:[^\]]+\]\s*/g, '')
    .slice(0, 140);
  return `Execute bounded proposal ${proposalId} (${proposalType}): ${title}`;
}

function writeExperiment(dateStr, card) {
  appendJsonl(path.join(EXPERIMENTS_DIR, `${dateStr}.jsonl`), card);
}

function isSafetyStopRunEvent(evt): boolean {
  if (!evt || evt.type !== 'autonomy_run') return false;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const result = String(evt.result || '');
    if (SAFETY_STOP_RUN_EVENT_CACHE.has(result)) {
      return SAFETY_STOP_RUN_EVENT_CACHE.get(result) === true;
    }
    const rust = runBacklogAutoscalePrimitive(
      'safety_stop_run_event',
      {
        event_type: String(evt.type || ''),
        result
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = rust.payload.payload.is_safety_stop === true;
      if (SAFETY_STOP_RUN_EVENT_CACHE.size >= SAFETY_STOP_RUN_EVENT_CACHE_MAX) {
        const oldest = SAFETY_STOP_RUN_EVENT_CACHE.keys().next();
        if (!oldest.done) SAFETY_STOP_RUN_EVENT_CACHE.delete(oldest.value);
      }
      SAFETY_STOP_RUN_EVENT_CACHE.set(result, val);
      return val;
    }
  }
  const result = String(evt.result || '');
  return result.includes('human_escalation')
    || result.includes('tier1_governance')
    || result.includes('medium_risk_guard')
    || result.includes('capability_cooldown')
    || result.includes('directive_pulse_tier_reservation');
}

function classifyNonYieldCategory(evt): string | null {
  if (!evt || evt.type !== 'autonomy_run') return null;
  const result = String(evt.result || '');
  if (!result || result === 'lock_busy' || result === 'stop_repeat_gate_interval') return null;
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = [
      String(evt.type || ''),
      result,
      String(evt.outcome || ''),
      evt.policy_hold === true ? '1' : '0',
      normalizeSpaces(evt.hold_reason || ''),
      normalizeSpaces(evt.route_block_reason || '')
    ].join('\u0000');
    if (NON_YIELD_CATEGORY_CACHE.has(key)) {
      const cached = NON_YIELD_CATEGORY_CACHE.get(key);
      return cached == null ? null : String(cached);
    }
    const rust = runBacklogAutoscalePrimitive(
      'non_yield_category',
      {
        event_type: String(evt.type || ''),
        result,
        outcome: String(evt.outcome || ''),
        policy_hold: evt.policy_hold === true,
        hold_reason: String(evt.hold_reason || ''),
        route_block_reason: String(evt.route_block_reason || '')
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const categoryRaw = rust.payload.payload.category;
      const category = categoryRaw == null ? null : String(categoryRaw || '');
      if (NON_YIELD_CATEGORY_CACHE.size >= NON_YIELD_CATEGORY_CACHE_MAX) {
        const oldest = NON_YIELD_CATEGORY_CACHE.keys().next();
        if (!oldest.done) NON_YIELD_CATEGORY_CACHE.delete(oldest.value);
      }
      NON_YIELD_CATEGORY_CACHE.set(key, category);
      return category;
    }
  }
  if (isPolicyHoldRunEvent(evt)) {
    const reason = normalizeSpaces(evt.hold_reason || evt.route_block_reason || evt.result).toLowerCase();
    if (result.includes('budget') || reason.includes('budget') || reason.includes('autopause')) return 'budget_hold';
    return 'policy_hold';
  }
  if (isSafetyStopRunEvent(evt)) return 'safety_stop';
  if (isNoProgressRun(evt)) return 'no_progress';
  return null;
}

function nonYieldReasonFromRun(evt, category): string {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = [
      String(category || ''),
      normalizeSpaces(evt && evt.hold_reason || ''),
      normalizeSpaces(evt && evt.route_block_reason || ''),
      normalizeSpaces(evt && evt.reason || ''),
      normalizeSpaces(evt && evt.result || ''),
      normalizeSpaces(evt && evt.outcome || '')
    ].join('\u0000');
    if (NON_YIELD_REASON_CACHE.has(key)) {
      return String(NON_YIELD_REASON_CACHE.get(key) || '');
    }
    const rust = runBacklogAutoscalePrimitive(
      'non_yield_reason',
      {
        category: String(category || ''),
        hold_reason: String(evt && evt.hold_reason || ''),
        route_block_reason: String(evt && evt.route_block_reason || ''),
        reason: String(evt && evt.reason || ''),
        result: String(evt && evt.result || ''),
        outcome: String(evt && evt.outcome || '')
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const reasonVal = String(rust.payload.payload.reason || '');
      if (NON_YIELD_REASON_CACHE.size >= NON_YIELD_REASON_CACHE_MAX) {
        const oldest = NON_YIELD_REASON_CACHE.keys().next();
        if (!oldest.done) NON_YIELD_REASON_CACHE.delete(oldest.value);
      }
      NON_YIELD_REASON_CACHE.set(key, reasonVal);
      return reasonVal;
    }
  }
  const explicit = normalizeSpaces(evt && (evt.hold_reason || evt.route_block_reason || evt.reason)).toLowerCase();
  if (explicit) return explicit;
  const result = normalizeSpaces(evt && evt.result).toLowerCase();
  const outcome = normalizeSpaces(evt && evt.outcome).toLowerCase();
  if (category === 'no_progress' && result === 'executed') {
    return outcome ? `executed_${outcome}` : 'executed_no_progress';
  }
  if (result) return result;
  return `${String(category || 'non_yield').toLowerCase()}_unknown`;
}

function writeNonYieldLedger(dateStr, evt): void {
  if (AUTONOMY_NON_YIELD_LEDGER_ENABLED !== true) return;
  if (!evt || evt.type !== 'autonomy_run') return;
  const category = classifyNonYieldCategory(evt);
  if (!category) return;
  const objectiveId = runEventObjectiveId(evt);
  const proposalId = runEventProposalId(evt);
  const riskRaw = normalizeSpaces(evt.risk != null ? evt.risk : evt.proposal_risk);
  const card: AnyObj = {
    ts: nowIso(),
    type: 'autonomy_non_yield',
    source: 'autonomy_controller',
    date: dateStr,
    category,
    reason: nonYieldReasonFromRun(evt, category),
    result: String(evt.result || ''),
    outcome: String(evt.outcome || ''),
    policy_hold: isPolicyHoldRunEvent(evt),
    attempt_like: isAttemptRunEvent(evt),
    proposal_id: proposalId || null,
    objective_id: objectiveId || null,
    risk: riskRaw ? normalizedRisk(riskRaw) : null,
    execution_mode: normalizeSpaces(evt.execution_mode || evt.mode) || null
  };
  try {
    appendJsonl(NON_YIELD_LEDGER_PATH, card);
  } catch {
    // Non-yield capture is telemetry-only and must never alter autonomy execution behavior.
  }
}

function writeRun(dateStr, evt) {
  appendJsonl(path.join(RUNS_DIR, `${dateStr}.jsonl`), evt);
  writeNonYieldLedger(dateStr, evt);
}

function writeOutcomeFallback(dateStr, evt) {
  appendJsonl(path.join(OUTCOME_FALLBACK_DIR, `${dateStr}.jsonl`), evt);
}

function writeReceipt(dateStr, receipt) {
  const filePath = path.join(RECEIPTS_DIR, `${dateStr}.jsonl`);
  const normalized = normalizeAutonomyReceiptForWrite(receipt);
  const verified =
    String(normalized && normalized.verdict || '').toLowerCase() === 'pass'
    && !!(normalized && normalized.verification && normalized.verification.passed === true);
  writeContractReceipt(filePath, normalized, { attempted: true, verified });
}

function effectiveTier1Policy(executionMode) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'effective_tier1_policy',
      {
        execution_mode: executionMode == null ? null : String(executionMode),
        tier1_burn_rate_multiplier: Number(AUTONOMY_TIER1_BURN_RATE_MULTIPLIER),
        tier1_canary_burn_rate_multiplier: Number(AUTONOMY_TIER1_CANARY_BURN_RATE_MULTIPLIER),
        tier1_min_projected_tokens_for_burn_check: Number(AUTONOMY_TIER1_MIN_PROJECTED_TOKENS_FOR_BURN_CHECK),
        tier1_canary_min_projected_tokens_for_burn_check: Number(AUTONOMY_TIER1_CANARY_MIN_PROJECTED_TOKENS_FOR_BURN_CHECK),
        tier1_drift_min_samples: Number(AUTONOMY_TIER1_DRIFT_MIN_SAMPLES),
        tier1_canary_drift_min_samples: Number(AUTONOMY_TIER1_CANARY_DRIFT_MIN_SAMPLES),
        tier1_alignment_threshold: Number(AUTONOMY_TIER1_ALIGNMENT_THRESHOLD),
        tier1_canary_alignment_threshold: Number(AUTONOMY_TIER1_CANARY_ALIGNMENT_THRESHOLD),
        tier1_canary_suppress_alignment_blocker: AUTONOMY_TIER1_CANARY_SUPPRESS_ALIGNMENT_BLOCKER === true
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  const mode = String(executionMode || '').trim().toLowerCase();
  const isCanary = mode === 'canary_execute';
  return {
    execution_mode: mode || null,
    canary_relaxed: isCanary,
    burn_rate_multiplier: isCanary
      ? Math.max(AUTONOMY_TIER1_BURN_RATE_MULTIPLIER, AUTONOMY_TIER1_CANARY_BURN_RATE_MULTIPLIER)
      : AUTONOMY_TIER1_BURN_RATE_MULTIPLIER,
    min_projected_tokens_for_burn_check: isCanary
      ? Math.max(AUTONOMY_TIER1_MIN_PROJECTED_TOKENS_FOR_BURN_CHECK, AUTONOMY_TIER1_CANARY_MIN_PROJECTED_TOKENS_FOR_BURN_CHECK)
      : AUTONOMY_TIER1_MIN_PROJECTED_TOKENS_FOR_BURN_CHECK,
    drift_min_samples: isCanary
      ? Math.max(AUTONOMY_TIER1_DRIFT_MIN_SAMPLES, AUTONOMY_TIER1_CANARY_DRIFT_MIN_SAMPLES)
      : AUTONOMY_TIER1_DRIFT_MIN_SAMPLES,
    alignment_threshold: isCanary
      ? Math.min(AUTONOMY_TIER1_ALIGNMENT_THRESHOLD, AUTONOMY_TIER1_CANARY_ALIGNMENT_THRESHOLD)
      : AUTONOMY_TIER1_ALIGNMENT_THRESHOLD,
    suppress_alignment_blocker: isCanary && AUTONOMY_TIER1_CANARY_SUPPRESS_ALIGNMENT_BLOCKER
  };
}

function hasEnvNumericOverride(name) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = String(name || '');
    const present = Object.prototype.hasOwnProperty.call(process.env, key);
    const rust = runBacklogAutoscalePrimitive(
      'has_env_numeric_override',
      {
        present,
        raw_value: present ? String(process.env[key] == null ? '' : process.env[key]) : null
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.has_override === true;
    }
  }
  return Object.prototype.hasOwnProperty.call(process.env, name)
    && String(process.env[name] == null ? '' : process.env[name]).trim() !== '';
}

function coalesceNumeric(primary, fallback, nullFallback = null) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'coalesce_numeric',
      {
        primary: Number(primary),
        fallback: Number(fallback),
        null_fallback: nullFallback == null ? null : Number(nullFallback)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.value == null ? null : Number(rust.payload.payload.value);
    }
  }
  const p = Number(primary);
  if (Number.isFinite(p)) return p;
  const f = Number(fallback);
  if (Number.isFinite(f)) return f;
  return nullFallback;
}

function evaluateTier1GovernanceSnapshot(dateStr, attemptsToday, estActionTokens = 0, opts: AnyObj = {}) {
  if (!AUTONOMY_TIER1_GOVERNANCE_ENABLED) {
    return {
      enabled: false,
      hard_stop: false,
      blockers: []
    };
  }
  const tier1Policy = effectiveTier1Policy(opts && opts.execution_mode);
  const strategyBudget = opts && opts.strategy_budget && typeof opts.strategy_budget === 'object'
    ? opts.strategy_budget
    : {};
  const tokenCostPer1k = hasEnvNumericOverride('AUTONOMY_TIER1_TOKEN_COST_PER_1K')
    ? AUTONOMY_TIER1_TOKEN_COST_PER_1K
    : coalesceNumeric(strategyBudget.token_cost_per_1k, null, 0);
  const dailyUsdCap = hasEnvNumericOverride('AUTONOMY_TIER1_DAILY_USD_CAP')
    ? AUTONOMY_TIER1_DAILY_USD_CAP
    : coalesceNumeric(strategyBudget.daily_usd_cap, null, 0);
  const perActionAvgUsdCap = hasEnvNumericOverride('AUTONOMY_TIER1_PER_ACTION_AVG_USD_CAP')
    ? AUTONOMY_TIER1_PER_ACTION_AVG_USD_CAP
    : coalesceNumeric(strategyBudget.per_action_avg_usd_cap, null, 0);
  const monthlyUsdAllocation = hasEnvNumericOverride('AUTONOMY_TIER1_MONTHLY_USD_ALLOCATION')
    ? AUTONOMY_TIER1_MONTHLY_USD_ALLOCATION
    : coalesceNumeric(strategyBudget.monthly_usd_allocation, null, 0);
  const monthlyCreditsFloorPct = hasEnvNumericOverride('AUTONOMY_TIER1_MONTHLY_CREDITS_FLOOR_PCT')
    ? AUTONOMY_TIER1_MONTHLY_CREDITS_FLOOR_PCT
    : coalesceNumeric(strategyBudget.monthly_credits_floor_pct, AUTONOMY_TIER1_MONTHLY_CREDITS_FLOOR_PCT, AUTONOMY_TIER1_MONTHLY_CREDITS_FLOOR_PCT);
  const minProjectedTokensForBurnCheck = hasEnvNumericOverride('AUTONOMY_TIER1_MIN_PROJECTED_TOKENS_FOR_BURN_CHECK')
    ? AUTONOMY_TIER1_MIN_PROJECTED_TOKENS_FOR_BURN_CHECK
    : coalesceNumeric(strategyBudget.min_projected_tokens_for_burn_check, tier1Policy.min_projected_tokens_for_burn_check, tier1Policy.min_projected_tokens_for_burn_check);
  try {
    let out = evaluateTier1Governance({
      runsDir: RUNS_DIR,
      dateStr,
      attemptsToday: Math.max(0, Number(attemptsToday || 0)),
      estActionTokens: Math.max(0, Number(estActionTokens || 0)),
      tokenCostPer1k,
      dailyUsdCap,
      perActionAvgUsdCap,
      burnRateMultiplier: tier1Policy.burn_rate_multiplier,
      minProjectedTokensForBurnCheck,
      monthlyUsdAllocation,
      monthlyCreditsFloorPct,
      minDaysForBurnBaseline: AUTONOMY_TIER1_BURN_BASELINE_MIN_DAYS,
      driftRecentDays: AUTONOMY_TIER1_DRIFT_RECENT_DAYS,
      driftBaselineDays: AUTONOMY_TIER1_DRIFT_BASELINE_DAYS,
      driftEmaThreshold: AUTONOMY_TIER1_DRIFT_EMA_THRESHOLD,
      driftTokenRatioThreshold: AUTONOMY_TIER1_DRIFT_TOKEN_RATIO_THRESHOLD,
      driftErrorRateThreshold: AUTONOMY_TIER1_DRIFT_ERROR_RATE_THRESHOLD,
      driftMinSamples: tier1Policy.drift_min_samples,
      driftHardStopOnHigh: AUTONOMY_TIER1_DRIFT_HARD_STOP_ON_HIGH,
      alignmentThreshold: tier1Policy.alignment_threshold,
      alignmentMinWeekSamples: AUTONOMY_TIER1_ALIGNMENT_MIN_WEEK_SAMPLES
    });
    if (tier1Policy.suppress_alignment_blocker && out && Array.isArray(out.blockers)) {
      const filtered = out.blockers.filter(b => String(b && b.gate || '') !== 'alignment_oracle');
      out = {
        ...out,
        blockers: filtered,
        hard_stop: filtered.length > 0
      };
    }
    return {
      ...out,
      mode_policy: {
        ...tier1Policy,
        token_cost_per_1k: tokenCostPer1k,
        daily_usd_cap: dailyUsdCap,
        per_action_avg_usd_cap: perActionAvgUsdCap,
        monthly_usd_allocation: monthlyUsdAllocation,
        monthly_credits_floor_pct: monthlyCreditsFloorPct,
        min_projected_tokens_for_burn_check: minProjectedTokensForBurnCheck
      }
    };
  } catch (err) {
    return {
      enabled: true,
      hard_stop: false,
      blockers: [],
      mode_policy: {
        ...tier1Policy,
        token_cost_per_1k: tokenCostPer1k,
        daily_usd_cap: dailyUsdCap,
        per_action_avg_usd_cap: perActionAvgUsdCap,
        monthly_usd_allocation: monthlyUsdAllocation,
        monthly_credits_floor_pct: monthlyCreditsFloorPct,
        min_projected_tokens_for_burn_check: minProjectedTokensForBurnCheck
      },
      error: shortText(err && err.message ? err.message : String(err || 'tier1_eval_error'), 180)
    };
  }
}

function compactTier1Exception(info) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const src = info && typeof info === 'object' ? info : {};
    const rust = runBacklogAutoscalePrimitive(
      'compact_tier1_exception',
      {
        tracked: src.tracked === true,
        novel: src.novel === true,
        stage: src.stage == null ? null : String(src.stage),
        error_code: src.error_code == null ? null : String(src.error_code),
        signature: src.signature == null ? null : String(src.signature),
        count: Number(src.count || 0),
        recovery: src.recovery && typeof src.recovery === 'object' ? src.recovery : null
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const payload = rust.payload.payload;
      if (payload.has_value !== true) return null;
      if (payload.value && typeof payload.value === 'object') return payload.value;
      return null;
    }
  }
  if (!info || info.tracked !== true) return null;
  const recovery = info.recovery && typeof info.recovery === 'object' ? info.recovery : null;
  return {
    novel: info.novel === true,
    stage: info.stage || null,
    error_code: info.error_code || null,
    signature: info.signature || null,
    count: Number(info.count || 0),
    recovery_action: recovery ? String(recovery.action || '') : null,
    recovery_cooldown_hours: recovery ? Number(recovery.cooldown_hours || 0) : null,
    recovery_playbook: recovery ? String(recovery.playbook || '') : null,
    recovery_reason: recovery ? String(recovery.reason || '') : null,
    recovery_should_escalate: recovery ? recovery.should_escalate === true : null
  };
}

function trackTier1Exception(dateStr, stage, errorCode, errorMessage, context = {}) {
  if (!AUTONOMY_TIER1_GOVERNANCE_ENABLED) return null;
  try {
    const tracked = classifyAndRecordException({
      memoryPath: AUTONOMY_TIER1_EXCEPTION_MEMORY_PATH,
      auditPath: AUTONOMY_TIER1_EXCEPTION_AUDIT_PATH,
      dateStr,
      stage,
      errorCode,
      errorMessage,
      context
    });
    const recovery = exceptionRecoveryDecision({
      tracked,
      policyPath: AUTONOMY_TIER1_EXCEPTION_POLICY_PATH
    });
    return compactTier1Exception({
      ...tracked,
      recovery
    });
  } catch (err) {
    return {
      novel: false,
      stage: String(stage || ''),
      error_code: String(errorCode || 'unknown'),
      signature: null,
      count: 0,
      tracking_error: shortText(err && err.message ? err.message : String(err || 'tier1_exception_track_failed'), 180)
    };
  }
}

function tier1ExceptionMemorySummary(days = AUTONOMY_TIER1_EXCEPTION_SUMMARY_DAYS) {
  if (!AUTONOMY_TIER1_GOVERNANCE_ENABLED) return null;
  try {
    return summarizeExceptionMemory(AUTONOMY_TIER1_EXCEPTION_MEMORY_PATH, days);
  } catch (err) {
    return {
      error: shortText(err && err.message ? err.message : String(err || 'tier1_exception_summary_failed'), 180)
    };
  }
}

function readHumanEscalationEvents() {
  if (!fs.existsSync(AUTONOMY_HUMAN_ESCALATION_LOG_PATH)) return [];
  return readJsonl(AUTONOMY_HUMAN_ESCALATION_LOG_PATH)
    .filter(e => e && typeof e === 'object' && String(e.type || '') === 'autonomy_human_escalation');
}

function activeHumanEscalations(holdHours = AUTONOMY_HUMAN_ESCALATION_HOLD_HOURS, nowMs = Date.now()) {
  const h = Math.max(1, Number(holdHours || AUTONOMY_HUMAN_ESCALATION_HOLD_HOURS));
  const ttlMs = h * 60 * 60 * 1000;
  const out = [];
  const rows = readHumanEscalationEvents();
  for (const row of rows) {
    const ts = parseIsoTs(row.ts);
    if (!ts) continue;
    const explicitExp = parseIsoTs(row.expires_at);
    const expMs = explicitExp ? explicitExp.getTime() : (ts.getTime() + ttlMs);
    if (nowMs > expMs) continue;
    if (String(row.status || '').toLowerCase() === 'resolved') continue;
    out.push({
      ...row,
      expires_at: new Date(expMs).toISOString(),
      remaining_minutes: Number(Math.max(0, (expMs - nowMs) / 60000).toFixed(2))
    });
  }
  out.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  const dedup = [];
  const seen = new Set();
  for (const row of out) {
    const id = String(row.escalation_id || '');
    if (!id || !seen.has(id)) {
      dedup.push(row);
      if (id) seen.add(id);
    }
  }
  return dedup;
}

function nextHumanEscalationClearAt(activeRows) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'next_human_escalation_clear_at',
      {
        rows: Array.isArray(activeRows) ? activeRows : []
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const value = rust.payload.payload.value;
      return value == null ? null : String(value || '');
    }
  }
  const rows = Array.isArray(activeRows) ? activeRows : [];
  const ms = rows
    .map(r => Date.parse(String(r && r.expires_at || '')))
    .filter(v => Number.isFinite(v) && v > 0);
  if (!ms.length) return null;
  return new Date(Math.min(...ms)).toISOString();
}

function ensureNovelExceptionEscalationProposal(dateStr, escalation) {
  if (!AUTONOMY_HUMAN_ESCALATION_CREATE_PROPOSAL) {
    return { created: false, reason: 'proposal_creation_disabled' };
  }
  const signature = String(escalation && escalation.signature || '').trim();
  if (!signature) return { created: false, reason: 'missing_signature' };

  const proposals = loadProposalsForDate(dateStr);
  const existing = proposals.find((p) => (
    p
    && String(p.type || '') === 'human_escalation'
    && p.meta
    && String(p.meta.exception_signature || '') === signature
  ));
  if (existing) {
    return { created: false, reason: 'already_exists', proposal_id: String(existing.id || '') };
  }

  const proposalId = `HESC-${crypto.createHash('sha256').update(`${dateStr}|${signature}|human_escalation`).digest('hex').slice(0, 16)}`;
  const escId = String(escalation && escalation.escalation_id || '').trim();
  const stage = String(escalation && escalation.stage || '').trim();
  const errCode = String(escalation && escalation.error_code || '').trim();
  const risk = String(escalation && escalation.risk || '').trim().toLowerCase();
  const titleCode = errCode || 'unknown_error';
  const statusCmd = `node systems/autonomy/autonomy_controller.js status ${dateStr}`;
  const verifyCmd = `node systems/spine/contract_check.js`;
  const proposal = {
    id: proposalId,
    type: 'human_escalation',
    title: `Human review required: novel autonomy exception (${titleCode})`,
    summary: `Novel exception detected at ${stage || 'unknown_stage'} with signature ${signature.slice(0, 12)}. Execute bounded verification, choose one remediation, then close escalation.`,
    expected_impact: 'high',
    risk: risk === 'high' ? 'high' : 'high',
    validation: [
      `Run "${statusCmd}" and confirm escalation_id ${escId || signature} is still open`,
      `Run "${verifyCmd}" and confirm result contains "\"ok\": true"`,
      `Record one bounded remediation step and close escalation only after 2 clean autonomy runs`
    ],
    success_criteria: [
      { metric: 'execution_success', target: '>= 1 successful verification run', horizon: 'within 1 run' },
      { metric: 'postconditions_ok', target: 'checks pass >= 1', horizon: 'within 1 run' },
      { metric: 'queue_outcome_logged', target: 'queue outcome logged >= 1', horizon: 'within 1 run' }
    ],
    action_spec: {
      kind: 'manual_review_packet',
      command: statusCmd,
      verify: [
        { metric: 'execution_success', target: '>= 1 successful verification run', horizon: 'within 1 run' },
        { metric: 'postconditions_ok', target: 'checks pass >= 1', horizon: 'within 1 run' }
      ],
      rollback_plan: 'Keep escalation open and defer remediation if verification fails or risk remains unclear.'
    },
    suggested_next_command: statusCmd,
    evidence: [
      {
        source: 'autonomy_human_escalation',
        path: 'state/security/autonomy_human_escalations.jsonl',
        match: `escalation_id=${escId || signature}`,
        evidence_ref: `eye:tier1_exception/${signature.slice(0, 12)}`
      }
    ],
    meta: {
      source_eye: 'tier1_exception',
      exception_signature: signature,
      escalation_id: escId || null,
      exception_stage: stage || null,
      exception_error_code: errCode || null,
      requires_human_review: true,
      manual_only: true,
      escalation_packet: {
        status_command: statusCmd,
        verify_command: verifyCmd
      },
      generated_at: nowIso(),
      topics: ['governance', 'autonomy', 'exceptions', 'human_review'],
      signal_quality_score: 90,
      signal_quality_tier: 'high',
      relevance_score: 92,
      relevance_tier: 'high'
    }
  };
  const next = Array.isArray(proposals) ? proposals.slice() : [];
  next.push(proposal);
  saveJson(path.join(PROPOSALS_DIR, `${dateStr}.json`), next);
  return { created: true, proposal_id: proposalId, date: dateStr, escalation_id: escId || null };
}

function emitNovelExceptionHumanEscalation(dateStr, data: AnyObj = {}) {
  if (!data || data.novel !== true) return { created: false, reason: 'not_novel' };
  const signature = String(data.signature || '').trim();
  if (!signature) return { created: false, reason: 'missing_signature' };
  const dedupeHrs = Math.max(1, Number(AUTONOMY_HUMAN_ESCALATION_DEDUPE_HOURS || 24));
  const cutoffMs = Date.now() - (dedupeHrs * 60 * 60 * 1000);
  const recent = readHumanEscalationEvents().find((row) => {
    if (String(row && row.signature || '') !== signature) return false;
    const t = parseIsoTs(row.ts);
    return !!(t && t.getTime() >= cutoffMs);
  });
  if (recent) {
    return {
      created: false,
      reason: 'dedup_recent',
      escalation_id: String(recent.escalation_id || ''),
      signature
    };
  }

  const holdHours = Math.max(1, Number(AUTONOMY_HUMAN_ESCALATION_HOLD_HOURS || 6));
  const now = nowIso();
  const exp = new Date(Date.now() + (holdHours * 60 * 60 * 1000)).toISOString();
  const escId = `hesc_${Date.now().toString(36)}_${crypto.createHash('sha256').update(`${signature}|${data.stage || ''}|${data.error_code || ''}`).digest('hex').slice(0, 8)}`;
  const row = {
    ts: now,
    type: 'autonomy_human_escalation',
    escalation_id: escId,
    status: 'open',
    signature,
    stage: data.stage || null,
    error_code: data.error_code || null,
    proposal_id: data.proposal_id || null,
    receipt_id: data.receipt_id || null,
    capability_key: data.capability_key || null,
    execution_target: data.execution_target || null,
    risk: data.risk || null,
    gate: data.gate || null,
    hold_hours: holdHours,
    expires_at: exp,
    requires_human_review: true
  };
  appendJsonl(AUTONOMY_HUMAN_ESCALATION_LOG_PATH, row);
  const proposal = ensureNovelExceptionEscalationProposal(dateStr, row);
  writeRun(dateStr, {
    ts: now,
    type: 'autonomy_human_escalation',
    escalation_id: escId,
    status: 'open',
    signature,
    stage: row.stage,
    error_code: row.error_code,
    proposal_id: row.proposal_id,
    receipt_id: row.receipt_id,
    capability_key: row.capability_key,
    execution_target: row.execution_target,
    risk: row.risk,
    gate: row.gate,
    hold_hours: holdHours,
    expires_at: exp,
    proposal_escalation: proposal
  });
  return {
    created: true,
    escalation_id: escId,
    signature,
    expires_at: exp,
    hold_hours: holdHours,
    proposal
  };
}

function maybeWriteNovelExceptionRun(dateStr, data: AnyObj = {}) {
  if (!data || data.novel !== true) return;
  writeRun(dateStr, {
    ts: nowIso(),
    type: 'autonomy_exception_novel',
    stage: data.stage || null,
    error_code: data.error_code || null,
    signature: data.signature || null,
    count: Number(data.count || 0),
    proposal_id: data.proposal_id || null,
    receipt_id: data.receipt_id || null,
    capability_key: data.capability_key || null,
    execution_target: data.execution_target || null,
    risk: data.risk || null,
    gate: data.gate || null
  });
  const escalation = emitNovelExceptionHumanEscalation(dateStr, data);
  if (escalation && escalation.created === true) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_exception_novel_escalated',
      escalation_id: escalation.escalation_id || null,
      signature: escalation.signature || null,
      hold_hours: escalation.hold_hours || null,
      expires_at: escalation.expires_at || null,
      proposal_escalation: escalation.proposal || null
    });
  }
}

function runModelCatalogLoop(cmd, extraArgs = []) {
  const args = [MODEL_CATALOG_LOOP_SCRIPT, cmd, ...extraArgs];
  const r = spawnSync('node', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  const stdout = String(r.stdout || '').trim();
  const firstJson = stdout.split('\n').find(line => line.startsWith('{') && line.endsWith('}'));
  let payload = null;
  if (firstJson) {
    try { payload = JSON.parse(firstJson); } catch {}
  }
  return {
    ok: r.status === 0,
    code: r.status || 0,
    stdout,
    stderr: String(r.stderr || '').trim(),
    payload
  };
}

function modelCatalogCanaryThresholds() {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'model_catalog_canary_thresholds',
      {
        min_samples: Number(AUTONOMY_MODEL_CATALOG_CANARY_MIN_SAMPLES),
        max_fail_rate: Number(AUTONOMY_MODEL_CATALOG_CANARY_MAX_FAIL_RATE),
        max_route_block_rate: Number(AUTONOMY_MODEL_CATALOG_CANARY_MAX_ROUTE_BLOCK_RATE)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  return {
    min_samples: clampNumber(Math.round(AUTONOMY_MODEL_CATALOG_CANARY_MIN_SAMPLES), 1, 50),
    max_fail_rate: clampNumber(AUTONOMY_MODEL_CATALOG_CANARY_MAX_FAIL_RATE, 0, 1),
    max_route_block_rate: clampNumber(AUTONOMY_MODEL_CATALOG_CANARY_MAX_ROUTE_BLOCK_RATE, 0, 1)
  };
}

function normalizeModelIds(input, limit = 128) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'normalize_model_ids',
      {
        models: Array.isArray(input) ? input.map((x) => String(x || '')) : [],
        limit: Number(limit)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Array.isArray(rust.payload.payload.models)
        ? rust.payload.payload.models.map((x) => String(x || ''))
        : [];
    }
  }
  const out = [];
  const seen = new Set();
  const arr = Array.isArray(input) ? input : [];
  for (const raw of arr) {
    const v = String(raw || '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

function readModelCatalogCanary() {
  return loadJson(MODEL_CATALOG_CANARY_PATH, null);
}

function writeModelCatalogCanary(state) {
  saveJson(MODEL_CATALOG_CANARY_PATH, state || {});
}

function startModelCatalogCanary(proposalId, applyPayload) {
  if (!AUTONOMY_MODEL_CATALOG_CANARY_ENABLED) return null;
  const models = normalizeModelIds(applyPayload && applyPayload.models);
  const thresholds = modelCatalogCanaryThresholds();
  const state = {
    version: 1,
    status: 'active',
    started_ts: nowIso(),
    proposal_id: String(proposalId || ''),
    models,
    snapshot: applyPayload && applyPayload.snapshot ? String(applyPayload.snapshot) : null,
    added_models: Number(applyPayload && applyPayload.added_models || models.length || 0),
    thresholds,
    stats: {
      samples: 0,
      failed: 0,
      route_blocked: 0,
      fail_rate: 0,
      route_block_rate: 0
    },
    rollback: null,
    completed_ts: null,
    last_eval_ts: null
  };
  writeModelCatalogCanary(state);
  appendJsonl(MODEL_CATALOG_AUDIT_PATH, {
    ts: nowIso(),
    type: 'canary_started',
    proposal_id: state.proposal_id,
    models: state.models.slice(0, 24),
    thresholds
  });
  return state;
}

function selectedModelFromRunEvent(evt) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'selected_model_from_run_event',
      {
        route_summary: evt && evt.route_summary && typeof evt.route_summary === 'object'
          ? evt.route_summary
          : null
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload.model == null ? null : String(rust.payload.payload.model || '');
    }
  }
  const s = evt && evt.route_summary;
  if (!s || typeof s !== 'object') return null;
  const direct = String(s.selected_model || s.model || s.selectedModel || s.chosen_model || '').trim();
  return direct || null;
}

function modelCatalogCanaryRunEvents(startedTs) {
  if (!fs.existsSync(RUNS_DIR)) return [];
  const startMs = Date.parse(String(startedTs || ''));
  const startDate = String(startedTs || '').slice(0, 10);
  const files = fs.readdirSync(RUNS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();
  const out = [];
  for (const f of files) {
    const day = f.replace(/\.jsonl$/, '');
    if (startDate && day < startDate) continue;
    const rows = readJsonl(path.join(RUNS_DIR, f));
    for (const evt of rows) {
      if (!evt || evt.type !== 'autonomy_run') continue;
      if (Number.isFinite(startMs)) {
        const ts = Date.parse(String(evt.ts || ''));
        if (Number.isFinite(ts) && ts < startMs) continue;
      }
      out.push(evt);
    }
  }
  return out;
}

function executeModelCatalogRollback(state, stats) {
  const trigger = {
    samples: Number(stats.samples || 0),
    failed: Number(stats.failed || 0),
    route_blocked: Number(stats.route_blocked || 0),
    fail_rate: Number((stats.fail_rate || 0).toFixed(3)),
    route_block_rate: Number((stats.route_block_rate || 0).toFixed(3)),
    max_fail_rate: Number(stats.max_fail_rate || 0),
    max_route_block_rate: Number(stats.max_route_block_rate || 0)
  };
  const note = shortText(
    `${AUTONOMY_MODEL_CATALOG_CANARY_ROLLBACK_NOTE} proposal=${String(state && state.proposal_id || '')} fail_rate=${trigger.fail_rate}`,
    220
  );
  const args = [MODEL_CATALOG_ROLLBACK_SCRIPT, 'latest', `--approval-note=${note}`];
  if (AUTONOMY_MODEL_CATALOG_CANARY_ROLLBACK_BREAK_GLASS) args.push('--break-glass=1');
  const res = spawnSync('node', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CLEARANCE: '3' }
  });
  const ok = res.status === 0;
  const error = ok ? null : shortText(res.stderr || res.stdout || `rollback_exit_${res.status || 1}`, 220);
  appendJsonl(MODEL_CATALOG_AUDIT_PATH, {
    ts: nowIso(),
    type: ok ? 'canary_rollback_success' : 'canary_rollback_failed',
    proposal_id: String(state && state.proposal_id || ''),
    trigger,
    approval_note: note,
    break_glass: AUTONOMY_MODEL_CATALOG_CANARY_ROLLBACK_BREAK_GLASS,
    code: res.status || 0,
    error
  });
  return {
    ok,
    code: res.status || 0,
    error,
    note,
    break_glass: AUTONOMY_MODEL_CATALOG_CANARY_ROLLBACK_BREAK_GLASS,
    trigger
  };
}

function evaluateModelCatalogCanary(dateStr) {
  if (!AUTONOMY_MODEL_CATALOG_CANARY_ENABLED) return { status: 'disabled' };
  const state = readModelCatalogCanary();
  if (!state || typeof state !== 'object') return { status: 'missing' };
  if (String(state.status || '') !== 'active') return { status: String(state.status || 'inactive'), state };

  const thresholds = {
    ...modelCatalogCanaryThresholds(),
    ...(state.thresholds && typeof state.thresholds === 'object' ? state.thresholds : {})
  };
  const modelSet = new Set(normalizeModelIds(state.models));
  const events = modelCatalogCanaryRunEvents(state.started_ts);
  let samples = 0;
  let failed = 0;
  let routeBlocked = 0;

  for (const evt of events) {
    if (!evt) continue;
    if (evt.result !== 'executed' && evt.result !== 'init_gate_blocked_route') continue;
    const selected = selectedModelFromRunEvent(evt);
    if (modelSet.size > 0 && (!selected || !modelSet.has(selected))) continue;
    samples++;
    if (evt.result === 'init_gate_blocked_route') {
      failed++;
      routeBlocked++;
      continue;
    }
    const verificationKnown = evt.verification && typeof evt.verification === 'object';
    const verificationPass = verificationKnown ? evt.verification.passed === true : null;
    const execOk = evt.exec_ok === undefined ? true : evt.exec_ok === true;
    const outcome = String(evt.outcome || '');
    const runFailed = verificationPass === false || execOk !== true || outcome === 'reverted';
    if (runFailed) failed++;
  }

  const failRate = samples > 0 ? failed / samples : 0;
  const routeBlockRate = samples > 0 ? routeBlocked / samples : 0;
  state.stats = {
    samples,
    failed,
    route_blocked: routeBlocked,
    fail_rate: Number(failRate.toFixed(3)),
    route_block_rate: Number(routeBlockRate.toFixed(3))
  };
  state.last_eval_ts = nowIso();
  state.thresholds = thresholds;
  writeModelCatalogCanary(state);

  if (samples < thresholds.min_samples) {
    return { status: 'active', waiting: true, state };
  }

  const rollbackNeeded = failRate > thresholds.max_fail_rate || routeBlockRate > thresholds.max_route_block_rate;
  if (!rollbackNeeded) {
    state.status = 'passed';
    state.completed_ts = nowIso();
    writeModelCatalogCanary(state);
    appendJsonl(MODEL_CATALOG_AUDIT_PATH, {
      ts: nowIso(),
      type: 'canary_passed',
      proposal_id: String(state.proposal_id || ''),
      samples,
      fail_rate: state.stats.fail_rate,
      route_block_rate: state.stats.route_block_rate
    });
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_model_catalog_canary',
      result: 'passed',
      proposal_id: String(state.proposal_id || ''),
      samples,
      fail_rate: state.stats.fail_rate,
      route_block_rate: state.stats.route_block_rate
    });
    return { status: 'passed', state };
  }

  const rollback = executeModelCatalogRollback(state, {
    samples,
    failed,
    route_blocked: routeBlocked,
    fail_rate: failRate,
    route_block_rate: routeBlockRate,
    max_fail_rate: thresholds.max_fail_rate,
    max_route_block_rate: thresholds.max_route_block_rate
  });
  state.status = rollback.ok ? 'rolled_back' : 'rollback_failed';
  state.completed_ts = nowIso();
  state.rollback = {
    ts: nowIso(),
    ok: rollback.ok,
    code: rollback.code,
    note: rollback.note,
    break_glass: rollback.break_glass,
    error: rollback.error,
    trigger: rollback.trigger
  };
  writeModelCatalogCanary(state);
  writeRun(dateStr, {
    ts: nowIso(),
    type: 'autonomy_model_catalog_canary',
    result: rollback.ok ? 'rollback_success' : 'rollback_failed',
    proposal_id: String(state.proposal_id || ''),
    samples,
    fail_rate: state.stats.fail_rate,
    route_block_rate: state.stats.route_block_rate,
    rollback_code: rollback.code,
    rollback_error: rollback.error
  });
  return { status: state.status, state, rollback_triggered: true, rollback_ok: rollback.ok, rollback_error: rollback.error };
}

function modelCatalogStatusSnapshot() {
  const audits = readJsonl(MODEL_CATALOG_AUDIT_PATH);
  const applied = new Set(audits.filter(e => e && e.type === 'apply_success' && e.id).map(e => String(e.id)));
  const proposals = fs.existsSync(MODEL_CATALOG_PROPOSALS_DIR)
    ? fs.readdirSync(MODEL_CATALOG_PROPOSALS_DIR).filter(f => f.endsWith('.json'))
    : [];
  let pendingApply = 0;
  let latestProposalId = null;
  let latestProposalTs = null;
  for (const f of proposals) {
    const id = f.replace(/\.json$/, '');
    const trialPath = path.join(MODEL_CATALOG_TRIALS_DIR, `${id}.json`);
    const trial = loadJson(trialPath, null);
    if (!trial) continue;
    const passed = Array.isArray(trial.passed_models) ? trial.passed_models.length : 0;
    if (passed > 0 && !applied.has(id)) pendingApply++;
    if (!latestProposalId || id > latestProposalId) {
      latestProposalId = id;
      latestProposalTs = String(trial.ts || '').slice(0, 25) || null;
    }
  }
  const lastProposalEvt = [...audits].reverse().find(e => e && e.type === 'proposal_created') || null;
  return {
    enabled: AUTONOMY_MODEL_CATALOG_ENABLED,
    interval_days: AUTONOMY_MODEL_CATALOG_INTERVAL_DAYS,
    source: AUTONOMY_MODEL_CATALOG_SOURCE,
    pending_apply: pendingApply,
    last_proposal_id: lastProposalEvt ? String(lastProposalEvt.id || '') : latestProposalId,
    last_proposal_ts: lastProposalEvt ? String(lastProposalEvt.ts || '') : latestProposalTs
  };
}

function shouldRunModelCatalogLoop() {
  if (!AUTONOMY_MODEL_CATALOG_ENABLED) return { run: false, reason: 'disabled' };
  const audits = readJsonl(MODEL_CATALOG_AUDIT_PATH);
  const lastProposal = [...audits].reverse().find(e => e && e.type === 'proposal_created');
  if (!lastProposal || !lastProposal.ts) return { run: true, reason: 'no_prior_proposal' };
  const lastMs = Date.parse(String(lastProposal.ts));
  if (!Number.isFinite(lastMs)) return { run: true, reason: 'invalid_last_timestamp' };
  const ageDays = (Date.now() - lastMs) / (24 * 60 * 60 * 1000);
  if (ageDays >= AUTONOMY_MODEL_CATALOG_INTERVAL_DAYS) {
    return { run: true, reason: `interval_elapsed_${ageDays.toFixed(2)}d` };
  }
  return { run: false, reason: `interval_not_elapsed_${ageDays.toFixed(2)}d` };
}

function maybeRunModelCatalogLoop(dateStr) {
  const gate = shouldRunModelCatalogLoop();
  if (!gate.run) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_model_catalog_run',
      step: 'gate',
      result: 'skipped',
      reason: gate.reason
    });
    return;
  }

  const propose = runModelCatalogLoop('propose', [`--source=${AUTONOMY_MODEL_CATALOG_SOURCE}`]);
  const proposalId = propose.payload && propose.payload.id ? String(propose.payload.id) : null;

  writeRun(dateStr, {
    ts: nowIso(),
    type: 'autonomy_model_catalog_run',
    step: 'propose',
    result: propose.ok ? 'ok' : 'failed',
    reason: gate.reason,
    proposal_id: proposalId,
    additions: propose.payload && Number(propose.payload.additions || 0),
    code: propose.code
  });

  if (!propose.ok || !proposalId) return;

  const trial = runModelCatalogLoop('trial', [`--id=${proposalId}`]);
  const passed = trial.payload ? Number(trial.payload.passed || 0) : 0;
  const failed = trial.payload ? Number(trial.payload.failed || 0) : 0;
  writeRun(dateStr, {
    ts: nowIso(),
    type: 'autonomy_model_catalog_run',
    step: 'trial',
    result: trial.ok ? 'ok' : 'failed',
    proposal_id: proposalId,
    passed_models: passed,
    failed_models: failed,
    code: trial.code
  });

  if (trial.ok && passed > 0) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_model_catalog_handoff',
      result: 'apply_pending',
      proposal_id: proposalId,
      passed_models: passed,
      required_clearance: 3,
      required_command: `node systems/autonomy/model_catalog_loop.js apply --id=${proposalId} --approval-note="<reason>"`
    });

    if (AUTONOMY_MODEL_CATALOG_AUTO_APPLY) {
      if (!AUTONOMY_MODEL_CATALOG_AUTO_APPROVAL_NOTE) {
        writeRun(dateStr, {
          ts: nowIso(),
          type: 'autonomy_model_catalog_run',
          step: 'apply',
          result: 'skipped_missing_approval_note',
          proposal_id: proposalId
        });
      } else {
        const applyArgs = [`--id=${proposalId}`, `--approval-note=${AUTONOMY_MODEL_CATALOG_AUTO_APPROVAL_NOTE}`];
        if (AUTONOMY_MODEL_CATALOG_AUTO_BREAK_GLASS) applyArgs.push('--break-glass=1');
        const apply = runModelCatalogLoop('apply', applyArgs);
        writeRun(dateStr, {
          ts: nowIso(),
          type: 'autonomy_model_catalog_run',
          step: 'apply',
          result: apply.ok ? 'ok' : 'failed',
          proposal_id: proposalId,
          code: apply.code,
          error: apply.ok ? null : shortText(apply.stderr || apply.stdout || 'apply_failed', 180)
        });
        if (apply.ok) {
          const canary = startModelCatalogCanary(proposalId, apply.payload || {});
          if (canary) {
            writeRun(dateStr, {
              ts: nowIso(),
              type: 'autonomy_model_catalog_canary',
              result: 'started',
              proposal_id: proposalId,
              models: Array.isArray(canary.models) ? canary.models.length : 0,
              min_samples: Number(canary.thresholds && canary.thresholds.min_samples || 0),
              max_fail_rate: Number(canary.thresholds && canary.thresholds.max_fail_rate || 0),
              max_route_block_rate: Number(canary.thresholds && canary.thresholds.max_route_block_rate || 0)
            });
          }
        }
      }
    }
  }
}

function candidatePool(dateStr, strategyOverride = null) {
  const proposals = loadProposalsForDate(dateStr);
  const overlay = buildOverlay(allDecisionEvents());
  const strategy = strategyOverride || strategyProfile();
  const allowedRisks = effectiveAllowedRisksSet();
  const duplicateWindowHours = strategyDuplicateWindowHours(strategy, 24);
  const recentKeyCounts = recentProposalKeyCounts(dateStr, duplicateWindowHours);
  const forcedProposalId = String(AUTONOMY_FORCE_PROPOSAL_ID || '').trim();
  const seenDedup = new Set();
  const semanticFingerprints = [];
  const pool = [];
  const backfillPool = [];
  const forcedPool = [];
  for (const p of proposals) {
    if (!p || !p.id) continue;
    const proposalId = String(p.id || '');
    const forceSelected = forcedProposalId && proposalId === forcedProposalId;
    const ov = overlay.get(p.id) || null;
    const status = proposalStatus(ov);
    if (!forceSelected && (status === 'rejected' || status === 'parked')) continue;
    const allowUnderflowBackfill = AUTONOMY_ONLY_OPEN_PROPOSALS
      && status !== 'pending'
      && canQueueUnderflowBackfill(status, ov);
    if (!forceSelected && AUTONOMY_ONLY_OPEN_PROPOSALS && status !== 'pending' && !allowUnderflowBackfill) continue;
    const dedupKey = proposalDedupKey(p);
    const admission = forceSelected
      ? {
          allow: true,
          reason: 'forced_proposal_id',
          forced: true
        }
      : strategyAdmissionDecision(p, strategy, {
          dedup_key: dedupKey,
          recent_key_counts: recentKeyCounts
        });
    if (!admission.allow && !forceSelected) continue;
    const risk = normalizedRisk(p.risk);
    if (!forceSelected && allowedRisks.size > 0 && !allowedRisks.has(risk)) continue;
    if (!forceSelected && cooldownActive(p.id)) continue;
    const semanticFingerprint = proposalSemanticFingerprint(p);
    const semanticDuplicate = !forceSelected && AUTONOMY_SEMANTIC_DEDUPE_ENABLED
      ? semanticNearDuplicateMatch(
          semanticFingerprint,
          semanticFingerprints,
          AUTONOMY_SEMANTIC_DEDUPE_THRESHOLD
        )
      : null;
    if (!forceSelected && semanticDuplicate) continue;
    if (!forceSelected && seenDedup.has(dedupKey)) continue;
    seenDedup.add(dedupKey);
    if (!forceSelected && semanticFingerprint && semanticFingerprint.eligible === true) {
      semanticFingerprints.push({
        ...semanticFingerprint,
        proposal_id: proposalId,
        dedup_key: dedupKey
      });
    }
    const row = {
      proposal: p,
      overlay: ov,
      status,
      score: proposalScore(p, ov, dateStr),
      dedup_key: dedupKey,
      semantic_fingerprint: semanticFingerprint,
      admission,
      force_selected: forceSelected === true
    };
    if (forceSelected) {
      forcedPool.push(row);
      continue;
    }
    if (allowUnderflowBackfill) {
      backfillPool.push({
        ...row,
        queue_underflow_backfill: true
      });
      continue;
    }
    pool.push(row);
  }
  pool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.proposal.id).localeCompare(String(b.proposal.id));
  });
  if (forcedPool.length > 0) {
    forcedPool.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.proposal.id).localeCompare(String(b.proposal.id));
    });
    return forcedPool;
  }
  if (pool.length > 0) return pool;
  if (backfillPool.length <= 0) return backfillPool;
  backfillPool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.proposal.id).localeCompare(String(b.proposal.id));
  });
  return backfillPool.slice(0, AUTONOMY_QUEUE_UNDERFLOW_BACKFILL_MAX);
}

function proposalStatusForQueuePressure(proposal, overlayEntry) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const overlayDecision = String((overlayEntry && overlayEntry.decision) || '');
    const proposalStatusRaw = String((proposal && proposal.status) || '');
    const cacheKey = `${overlayDecision}\u0000${proposalStatusRaw}`;
    if (PROPOSAL_STATUS_FOR_QUEUE_PRESSURE_CACHE.has(cacheKey)) {
      return PROPOSAL_STATUS_FOR_QUEUE_PRESSURE_CACHE.get(cacheKey);
    }
    const rust = runBacklogAutoscalePrimitive(
      'proposal_status_for_queue_pressure',
      {
        overlay_decision: overlayDecision,
        proposal_status: proposalStatusRaw
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = String(rust.payload.payload.status || '').trim().toLowerCase();
      if (val) {
        if (PROPOSAL_STATUS_FOR_QUEUE_PRESSURE_CACHE.size >= PROPOSAL_STATUS_FOR_QUEUE_PRESSURE_CACHE_MAX) {
          const oldest = PROPOSAL_STATUS_FOR_QUEUE_PRESSURE_CACHE.keys().next();
          if (!oldest.done) PROPOSAL_STATUS_FOR_QUEUE_PRESSURE_CACHE.delete(oldest.value);
        }
        PROPOSAL_STATUS_FOR_QUEUE_PRESSURE_CACHE.set(cacheKey, val);
        return val;
      }
    }
  }
  const hasOverlayDecision = !!(overlayEntry && overlayEntry.decision);
  let status = proposalStatus(overlayEntry);
  if (hasOverlayDecision) return status;
  const explicit = normalizeStoredProposalStatus(proposal && proposal.status, 'pending');
  if (
    explicit === 'accepted'
    || explicit === 'closed'
    || explicit === 'rejected'
    || explicit === 'parked'
  ) {
    status = explicit;
  }
  return status;
}

function queuePressureSnapshot(dateStr) {
  const proposals = loadProposalsForDate(dateStr);
  const overlay = buildOverlay(allDecisionEvents());
  const statuses = [];
  let total = 0;
  let pending = 0;
  let accepted = 0;
  let closed = 0;
  let rejected = 0;
  let parked = 0;
  for (const proposal of proposals) {
    if (!proposal || !proposal.id) continue;
    total += 1;
    const ov = overlay.get(proposal.id) || null;
    const status = proposalStatusForQueuePressure(proposal, ov);
    statuses.push(status);
    if (status === 'pending') pending += 1;
    else if (status === 'accepted') accepted += 1;
    else if (status === 'closed') closed += 1;
    else if (status === 'rejected') rejected += 1;
    else if (status === 'parked') parked += 1;
  }
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'queue_pressure_snapshot',
      {
        statuses,
        warn_count: AUTONOMY_QOS_QUEUE_PENDING_WARN_COUNT,
        critical_count: AUTONOMY_QOS_QUEUE_PENDING_CRITICAL_COUNT,
        warn_ratio: AUTONOMY_QOS_QUEUE_PENDING_WARN_RATIO,
        critical_ratio: AUTONOMY_QOS_QUEUE_PENDING_CRITICAL_RATIO
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  const pendingRatio = total > 0 ? pending / total : 0;
  let pressure = 'normal';
  if (
    pending >= AUTONOMY_QOS_QUEUE_PENDING_CRITICAL_COUNT
    || pendingRatio >= AUTONOMY_QOS_QUEUE_PENDING_CRITICAL_RATIO
  ) {
    pressure = 'critical';
  } else if (
    pending >= AUTONOMY_QOS_QUEUE_PENDING_WARN_COUNT
    || pendingRatio >= AUTONOMY_QOS_QUEUE_PENDING_WARN_RATIO
  ) {
    pressure = 'warning';
  }
  return {
    total,
    pending,
    accepted,
    closed,
    rejected,
    parked,
    pending_ratio: Number(pendingRatio.toFixed(6)),
    pressure,
    warn_ratio: Number(AUTONOMY_QOS_QUEUE_PENDING_WARN_RATIO.toFixed(6)),
    critical_ratio: Number(AUTONOMY_QOS_QUEUE_PENDING_CRITICAL_RATIO.toFixed(6)),
    warn_count: AUTONOMY_QOS_QUEUE_PENDING_WARN_COUNT,
    critical_count: AUTONOMY_QOS_QUEUE_PENDING_CRITICAL_COUNT
  };
}

function qosLaneFromCandidate(cand) {
  const c = cand && typeof cand === 'object' ? cand : {};
  const proposal = c.proposal && typeof c.proposal === 'object' ? c.proposal : {};
  const proposalType = String(proposal && proposal.type || '').trim().toLowerCase();
  const pulseTier = normalizeDirectiveTier(c && c.directive_pulse && c.directive_pulse.tier, 99);
  const risk = String(c.risk || normalizedRisk(proposal && proposal.risk)).trim().toLowerCase();
  const deprioritizedSource = isDeprioritizedSourceProposal(proposal);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const key = [
      c.queue_underflow_backfill === true ? '1' : '0',
      pulseTier,
      proposalType,
      deprioritizedSource ? '1' : '0',
      risk
    ].join('\u0000');
    if (QOS_LANE_FROM_CANDIDATE_CACHE.has(key)) {
      return QOS_LANE_FROM_CANDIDATE_CACHE.get(key);
    }
    const rust = runBacklogAutoscalePrimitive(
      'qos_lane_from_candidate',
      {
        queue_underflow_backfill: c.queue_underflow_backfill === true,
        pulse_tier: pulseTier,
        proposal_type: proposalType,
        deprioritized_source: deprioritizedSource,
        risk
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const lane = String(rust.payload.payload.lane || '').trim().toLowerCase();
      const val = lane === 'critical' || lane === 'standard' || lane === 'explore' || lane === 'quarantine'
        ? lane
        : 'standard';
      if (QOS_LANE_FROM_CANDIDATE_CACHE.size >= QOS_LANE_FROM_CANDIDATE_CACHE_MAX) {
        const oldest = QOS_LANE_FROM_CANDIDATE_CACHE.keys().next();
        if (!oldest.done) QOS_LANE_FROM_CANDIDATE_CACHE.delete(oldest.value);
      }
      QOS_LANE_FROM_CANDIDATE_CACHE.set(key, val);
      return val;
    }
  }
  if (c.queue_underflow_backfill === true) return 'quarantine';
  if (pulseTier <= 1) return 'critical';
  if (proposalType === 'directive_clarification' || proposalType === 'directive_decomposition') return 'critical';
  if (deprioritizedSource) return 'quarantine';
  if (risk === 'medium') return 'explore';
  return 'standard';
}

function qosLaneWeights(queuePressure: AnyObj = {}) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const pressure = String(queuePressure && queuePressure.pressure || 'normal').trim().toLowerCase();
    const key = [
      pressure,
      AUTONOMY_QOS_LANE_WEIGHT_CRITICAL,
      AUTONOMY_QOS_LANE_WEIGHT_STANDARD,
      AUTONOMY_QOS_LANE_WEIGHT_EXPLORE,
      AUTONOMY_QOS_LANE_WEIGHT_QUARANTINE
    ].join('\u0000');
    if (QOS_LANE_WEIGHTS_CACHE.has(key)) {
      const cached = QOS_LANE_WEIGHTS_CACHE.get(key);
      return cached && typeof cached === 'object'
        ? { ...cached }
        : {
            critical: AUTONOMY_QOS_LANE_WEIGHT_CRITICAL,
            standard: AUTONOMY_QOS_LANE_WEIGHT_STANDARD,
            explore: AUTONOMY_QOS_LANE_WEIGHT_EXPLORE,
            quarantine: AUTONOMY_QOS_LANE_WEIGHT_QUARANTINE
          };
    }
    const rust = runBacklogAutoscalePrimitive(
      'qos_lane_weights',
      {
        pressure,
        critical_weight: AUTONOMY_QOS_LANE_WEIGHT_CRITICAL,
        standard_weight: AUTONOMY_QOS_LANE_WEIGHT_STANDARD,
        explore_weight: AUTONOMY_QOS_LANE_WEIGHT_EXPLORE,
        quarantine_weight: AUTONOMY_QOS_LANE_WEIGHT_QUARANTINE
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const out = {
        critical: Number(rust.payload.payload.critical || 0),
        standard: Number(rust.payload.payload.standard || 0),
        explore: Number(rust.payload.payload.explore || 0),
        quarantine: Number(rust.payload.payload.quarantine || 0)
      };
      if (QOS_LANE_WEIGHTS_CACHE.size >= QOS_LANE_WEIGHTS_CACHE_MAX) {
        const oldest = QOS_LANE_WEIGHTS_CACHE.keys().next();
        if (!oldest.done) QOS_LANE_WEIGHTS_CACHE.delete(oldest.value);
      }
      QOS_LANE_WEIGHTS_CACHE.set(key, { ...out });
      return out;
    }
  }
  const pressure = String(queuePressure && queuePressure.pressure || 'normal').trim().toLowerCase();
  const weights = {
    critical: AUTONOMY_QOS_LANE_WEIGHT_CRITICAL,
    standard: AUTONOMY_QOS_LANE_WEIGHT_STANDARD,
    explore: AUTONOMY_QOS_LANE_WEIGHT_EXPLORE,
    quarantine: AUTONOMY_QOS_LANE_WEIGHT_QUARANTINE
  };
  if (pressure === 'warning') {
    weights.explore = Number((weights.explore * 0.75).toFixed(6));
    weights.quarantine = Number((weights.quarantine * 0.35).toFixed(6));
  } else if (pressure === 'critical') {
    weights.critical = Number((weights.critical * 1.2).toFixed(6));
    weights.standard = Number((weights.standard * 1.1).toFixed(6));
    weights.explore = Number((weights.explore * 0.3).toFixed(6));
    weights.quarantine = Number((weights.quarantine * 0.1).toFixed(6));
  }
  return weights;
}

function qosLaneUsageFromRuns(priorRuns) {
  const rows = Array.isArray(priorRuns) ? priorRuns : [];
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rustEvents = [];
    for (const evt of rows) {
      if (!evt || typeof evt !== 'object') continue;
      rustEvents.push({
        event_type: String(evt.type || ''),
        result: String(evt.result || ''),
        selection_mode: String(evt.selection_mode || '')
      });
    }
    const key = rustEvents
      .map((row) => `${row.event_type}\u0000${row.result}\u0000${row.selection_mode}`)
      .join('\u0001');
    if (QOS_LANE_USAGE_CACHE.has(key)) {
      const cached = QOS_LANE_USAGE_CACHE.get(key);
      return cached && typeof cached === 'object'
        ? { ...cached }
        : { critical: 0, standard: 0, explore: 0, quarantine: 0 };
    }
    const rust = runBacklogAutoscalePrimitive(
      'qos_lane_usage',
      { events: rustEvents },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const out = {
        critical: Math.max(0, Number(rust.payload.payload.critical || 0)),
        standard: Math.max(0, Number(rust.payload.payload.standard || 0)),
        explore: Math.max(0, Number(rust.payload.payload.explore || 0)),
        quarantine: Math.max(0, Number(rust.payload.payload.quarantine || 0))
      };
      if (QOS_LANE_USAGE_CACHE.size >= QOS_LANE_USAGE_CACHE_MAX) {
        const oldest = QOS_LANE_USAGE_CACHE.keys().next();
        if (!oldest.done) QOS_LANE_USAGE_CACHE.delete(oldest.value);
      }
      QOS_LANE_USAGE_CACHE.set(key, out);
      return out;
    }
  }
  const out = {
    critical: 0,
    standard: 0,
    explore: 0,
    quarantine: 0
  };
  for (const evt of rows) {
    if (!evt || evt.type !== 'autonomy_run' || evt.result !== 'executed') continue;
    const mode = String(evt.selection_mode || '').toLowerCase();
    const m = mode.match(/qos_(critical|standard|explore|quarantine)_/);
    if (m && m[1]) out[m[1]] = Number(out[m[1]] || 0) + 1;
  }
  return out;
}

function qosLaneShareCapExceeded(lane, usage, executedCount) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const laneRaw = String(lane || '');
    const exploreUsage = Number(usage && usage.explore || 0);
    const quarantineUsage = Number(usage && usage.quarantine || 0);
    const executed = Number(executedCount || 0);
    const key = [
      laneRaw,
      exploreUsage,
      quarantineUsage,
      executed,
      AUTONOMY_QOS_EXPLORE_MAX_SHARE,
      AUTONOMY_QOS_QUARANTINE_MAX_SHARE
    ].join('\u0000');
    if (QOS_LANE_SHARE_CAP_EXCEEDED_CACHE.has(key)) {
      return QOS_LANE_SHARE_CAP_EXCEEDED_CACHE.get(key) === true;
    }
    const rust = runBacklogAutoscalePrimitive(
      'qos_lane_share_cap_exceeded',
      {
        lane: laneRaw,
        explore_usage: exploreUsage,
        quarantine_usage: quarantineUsage,
        executed_count: executed,
        explore_max_share: AUTONOMY_QOS_EXPLORE_MAX_SHARE,
        quarantine_max_share: AUTONOMY_QOS_QUARANTINE_MAX_SHARE
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const val = rust.payload.payload.exceeded === true;
      if (QOS_LANE_SHARE_CAP_EXCEEDED_CACHE.size >= QOS_LANE_SHARE_CAP_EXCEEDED_CACHE_MAX) {
        const oldest = QOS_LANE_SHARE_CAP_EXCEEDED_CACHE.keys().next();
        if (!oldest.done) QOS_LANE_SHARE_CAP_EXCEEDED_CACHE.delete(oldest.value);
      }
      QOS_LANE_SHARE_CAP_EXCEEDED_CACHE.set(key, val);
      return val;
    }
  }
  if (!executedCount || executedCount <= 0) return false;
  if (lane === 'explore') {
    return (Number(usage.explore || 0) / executedCount) >= AUTONOMY_QOS_EXPLORE_MAX_SHARE;
  }
  if (lane === 'quarantine') {
    return (Number(usage.quarantine || 0) / executedCount) >= AUTONOMY_QOS_QUARANTINE_MAX_SHARE;
  }
  return false;
}

function chooseQosLaneSelection(eligible: AnyObj[], priorRuns: AnyObj[], opts: AnyObj = {}) {
  const candidates = Array.isArray(eligible) ? eligible : [];
  if (!candidates.length) return null;
  const shadowOnly = opts && opts.shadowOnly === true;
  const queuePressure = opts && opts.queuePressure && typeof opts.queuePressure === 'object'
    ? opts.queuePressure
    : { pressure: 'normal' };
  const pressure = String(queuePressure.pressure || 'normal').trim().toLowerCase();
  const weights = qosLaneWeights(queuePressure);
  const executedCount = (Array.isArray(priorRuns) ? priorRuns : [])
    .filter((e) => e && e.type === 'autonomy_run' && e.result === 'executed')
    .length;
  const usage = qosLaneUsageFromRuns(priorRuns);
  const laneOrder = ['critical', 'standard', 'explore', 'quarantine'];
  const laneBuckets = {
    critical: [],
    standard: [],
    explore: [],
    quarantine: []
  };
  for (const cand of candidates) {
    const lane = String(cand && cand.qos_lane || qosLaneFromCandidate(cand));
    if (!laneBuckets[lane]) laneBuckets.standard.push(cand);
    else laneBuckets[lane].push(cand);
    if (cand && typeof cand === 'object') cand.qos_lane = laneBuckets[lane] ? lane : 'standard';
  }
  const laneCounts = {
    critical: laneBuckets.critical.length,
    standard: laneBuckets.standard.length,
    explore: laneBuckets.explore.length,
    quarantine: laneBuckets.quarantine.length
  };
  const coreAvailable = (laneCounts.critical + laneCounts.standard) > 0;
  const blockedLanes = new Set();
  if (AUTONOMY_QOS_BACKPRESSURE_ENABLED && coreAvailable) {
    if (pressure === 'warning') {
      blockedLanes.add('quarantine');
    } else if (pressure === 'critical') {
      blockedLanes.add('quarantine');
      blockedLanes.add('explore');
    }
  }

  const chooseLane = (allowBlocked, allowShareExceeded) => {
    let selected = null;
    let selectedScore = -Infinity;
    for (const lane of laneOrder) {
      const rows = laneBuckets[lane];
      if (!rows.length) continue;
      if (!allowBlocked && blockedLanes.has(lane)) continue;
      if (!allowShareExceeded && coreAvailable && qosLaneShareCapExceeded(lane, usage, executedCount)) continue;
      const laneWeight = Number(weights[lane] || 0);
      const laneScore = laneWeight / (1 + Number(usage[lane] || 0));
      if (laneScore > selectedScore) {
        selected = lane;
        selectedScore = laneScore;
      }
    }
    return selected;
  };

  let selectedLane = chooseLane(false, false);
  if (!selectedLane) selectedLane = chooseLane(true, false);
  if (!selectedLane) selectedLane = chooseLane(true, true);
  if (!selectedLane) return null;

  const laneEligible = laneBuckets[selectedLane];
  const laneSelection = shadowOnly
    ? chooseEvidenceSelectionMode(laneEligible, priorRuns, 'evidence')
    : chooseSelectionMode(laneEligible, priorRuns);
  const lanePick = laneEligible[laneSelection.index] || laneEligible[0];
  const fullIdx = candidates.findIndex((cand) => (
    String(cand && cand.proposal && cand.proposal.id || '') === String(lanePick && lanePick.proposal && lanePick.proposal.id || '')
  ));
  const modeSuffix = laneSelection.mode === 'explore' ? 'explore' : 'exploit';
  const selectionMode = shadowOnly
    ? String(laneSelection.mode || 'evidence_sample')
    : `qos_${selectedLane}_${modeSuffix}`;
  const selection = {
    ...laneSelection,
    mode: selectionMode,
    index: fullIdx >= 0 ? fullIdx : 0,
    qos_lane: selectedLane
  };
  return {
    pick: lanePick,
    selection,
    telemetry: {
      pressure,
      backpressure_applied: AUTONOMY_QOS_BACKPRESSURE_ENABLED && blockedLanes.size > 0,
      blocked_lanes: Array.from(blockedLanes),
      selected_lane: selectedLane,
      lane_counts: laneCounts,
      lane_usage: usage,
      lane_weights: weights,
      queue: {
        total: Number(queuePressure.total || 0),
        pending: Number(queuePressure.pending || 0),
        pending_ratio: Number(queuePressure.pending_ratio || 0)
      }
    }
  };
}

function exploreQuotaForDay() {
  const caps = effectiveStrategyBudget();
  const exp = effectiveStrategyExploration();
  const maxRuns = Number.isFinite(Number(caps.daily_runs_cap)) ? Number(caps.daily_runs_cap) : AUTONOMY_MAX_RUNS_PER_DAY;
  const frac = clampNumber(exp.fraction, 0.05, 0.8);
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'explore_quota_for_day',
      {
        daily_runs_cap: Number(caps.daily_runs_cap),
        explore_fraction: Number(exp.fraction),
        default_max_runs: Number(AUTONOMY_MAX_RUNS_PER_DAY)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return Math.max(1, Number(rust.payload.payload.quota || 1));
    }
  }
  return Math.max(1, Math.floor(Math.max(1, maxRuns) * frac));
}

function chooseSelectionMode(eligible, priorRuns) {
  const executed = (priorRuns || []).filter(e => e && e.type === 'autonomy_run' && e.result === 'executed');
  const executedCount = executed.length;
  const exploreUsed = executed.filter(e => e.selection_mode === 'explore').length;
  const exploitUsed = executed.filter(e => e.selection_mode === 'exploit').length;
  const quota = exploreQuotaForDay();
  const exp = effectiveStrategyExploration();
  const everyN = Math.max(1, Number(exp.every_n || AUTONOMY_EXPLORE_EVERY_N));
  const minEligible = Math.max(2, Number(exp.min_eligible || AUTONOMY_EXPLORE_MIN_ELIGIBLE));
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'choose_selection_mode',
      {
        eligible_len: Math.max(0, Number(eligible && eligible.length || 0)),
        executed_count: executedCount,
        explore_used: exploreUsed,
        exploit_used: exploitUsed,
        explore_quota: quota,
        every_n: everyN,
        min_eligible: minEligible
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }

  let mode = 'exploit';
  let idx = 0;
  if (
    eligible.length >= minEligible
    && exploreUsed < quota
    && executedCount > 0
    && executedCount % everyN === 0
  ) {
    mode = 'explore';
    idx = Math.min(eligible.length - 1, Math.max(1, Math.floor(eligible.length / 2)));
  }

  return {
    mode,
    index: idx,
    explore_used: exploreUsed,
    explore_quota: quota,
    exploit_used: exploitUsed
  };
}

function chooseEvidenceSelectionMode(eligible, priorRuns, modePrefix) {
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'choose_evidence_selection_mode',
      {
        eligible_len: Array.isArray(eligible) ? eligible.length : 0,
        prior_runs: Array.isArray(priorRuns)
          ? priorRuns.map((row) => ({
            event_type: row && row.type == null ? null : String(row && row.type || ''),
            result: row && row.result == null ? null : String(row && row.result || '')
          }))
          : [],
        evidence_sample_window: Number(AUTONOMY_EVIDENCE_SAMPLE_WINDOW || 1),
        mode_prefix: modePrefix == null ? null : String(modePrefix)
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      return rust.payload.payload;
    }
  }
  const evidenceAttempts = (priorRuns || []).filter(e =>
    e
    && e.type === 'autonomy_run'
    && (e.result === 'score_only_preview' || e.result === 'score_only_evidence')
  );
  const window = Math.max(1, Math.min(
    Number(eligible && eligible.length || 0),
    Math.max(1, Number(AUTONOMY_EVIDENCE_SAMPLE_WINDOW || 1))
  ));
  const cursor = window > 0 ? (evidenceAttempts.length % window) : 0;
  const mode = `${String(modePrefix || 'evidence')}_sample`;
  return {
    mode,
    index: cursor,
    sample_window: window,
    sample_cursor: cursor,
    prior_evidence_attempts: evidenceAttempts.length
  };
}

function statusCmd(dateStr) {
  const effectiveDate = latestProposalDate(dateStr) || dateStr;
  const pool = candidatePool(effectiveDate);
  const budget = loadDailyBudget(dateStr);
  const budgetAutopause = loadSystemBudgetAutopauseState();
  const eyesMap = loadEyesMap();
  const directiveProfile = loadDirectiveFitProfile();
  const strategy = strategyProfile();
  const strategyBudget = effectiveStrategyBudget();
  const strategyExplore = effectiveStrategyExploration();
  const executionMode = effectiveStrategyExecutionMode();
  const canaryDailyExecLimit = executionMode === 'canary_execute'
    ? effectiveStrategyCanaryExecLimit()
    : null;
  const allowedRisks = effectiveAllowedRisksSet();
  const calibrationProfile: AnyObj = computeCalibrationProfile(dateStr, false);
  const thresholds = calibrationProfile.effective_thresholds || baseThresholds();
  const mediumLane = mediumRiskThresholds(thresholds);
  const runs = runsSinceReset(readRuns(dateStr));
  const directivePulseCtx = buildDirectivePulseContext(dateStr);
  const attempts = attemptEvents(runs);
  const capAttempts = capacityCountedAttemptEvents(runs);
  const executedRuns = runs.filter(e => e && e.type === 'autonomy_run' && e.result === 'executed');
  const mediumExecuted = executedCountByRisk(executedRuns, 'medium');
  const attemptsToday = attempts.length;
  const attemptsTodayForCap = capAttempts.length;
  const lastAttempt = attempts.length ? attempts[attempts.length - 1] : null;
  const lastCapacityAttempt = capAttempts.length ? capAttempts[capAttempts.length - 1] : lastAttempt;
  const lastAttemptMinutesAgo = lastAttempt ? minutesSinceTs(lastAttempt.ts) : null;
  const lastCapacityAttemptMinutesAgo = lastCapacityAttempt ? minutesSinceTs(lastCapacityAttempt.ts) : null;
  const noProgressStreak = consecutiveNoProgressRuns(runs);
  const gateExhaustionStreak = consecutiveGateExhaustedAttempts(attempts);
  const shippedToday = shippedCount(runs);
  const exploreUsed = executedRuns.filter(e => e.selection_mode === 'explore').length;
  const exploitUsed = executedRuns.filter(e => e.selection_mode === 'exploit').length;
  const maxRunsPerDay = Number.isFinite(Number(strategyBudget.daily_runs_cap))
    ? Number(strategyBudget.daily_runs_cap)
    : AUTONOMY_MAX_RUNS_PER_DAY;
  const exploreQuota = Math.max(1, Math.floor(Math.max(1, maxRunsPerDay) * clampNumber(strategyExplore.fraction, 0.05, 0.8)));
  const dopamine = loadDopamineSnapshot(dateStr);
  const tier1Governance = evaluateTier1GovernanceSnapshot(dateStr, attemptsToday, 0, {
    execution_mode: executionMode,
    strategy_budget: strategyBudget
  });
  const tier1ExceptionSummary = tier1ExceptionMemorySummary(AUTONOMY_TIER1_EXCEPTION_SUMMARY_DAYS);
  const humanEscalations = activeHumanEscalations(AUTONOMY_HUMAN_ESCALATION_HOLD_HOURS);
  const humanEscalationNextClearAt = nextHumanEscalationClearAt(humanEscalations);
  const out = {
    ts: nowIso(),
    date: dateStr,
    proposal_date: effectiveDate,
    autonomy_enabled: String(process.env.AUTONOMY_ENABLED || '') === '1',
    token_cap: budget.token_cap,
    token_used_est: budget.used_est,
    budget_autopause: {
      active: budgetAutopause && budgetAutopause.active === true,
      source: budgetAutopause && budgetAutopause.source ? String(budgetAutopause.source) : null,
      reason: budgetAutopause && budgetAutopause.reason ? String(budgetAutopause.reason) : null,
      pressure: budgetAutopause && budgetAutopause.pressure ? String(budgetAutopause.pressure) : null,
      until: budgetAutopause && budgetAutopause.until ? String(budgetAutopause.until) : null
    },
    repeat_gate: {
      no_progress_streak: noProgressStreak,
      no_progress_limit: AUTONOMY_REPEAT_NO_PROGRESS_LIMIT,
      gate_exhaustion_streak: gateExhaustionStreak,
      gate_exhaustion_limit: AUTONOMY_REPEAT_EXHAUSTED_LIMIT,
      gate_exhaustion_cooldown_minutes: AUTONOMY_REPEAT_EXHAUSTED_COOLDOWN_MINUTES,
      shipped_today: shippedToday,
      executed_today: executedRuns.length,
      medium_executed_today: mediumExecuted,
      attempts_today: attemptsTodayForCap,
      attempts_total: attemptsToday,
      attempts_counted_for_cap: attemptsTodayForCap,
      max_runs_per_day: maxRunsPerDay,
      min_minutes_between_runs: AUTONOMY_MIN_MINUTES_BETWEEN_RUNS,
      last_attempt_minutes_ago: lastCapacityAttemptMinutesAgo == null ? null : Number(lastCapacityAttemptMinutesAgo.toFixed(2)),
      last_attempt_minutes_ago_any: lastAttemptMinutesAgo == null ? null : Number(lastAttemptMinutesAgo.toFixed(2)),
      max_eye_no_progress_24h: AUTONOMY_MAX_EYE_NO_PROGRESS_24H,
      explore_used: exploreUsed,
      exploit_used: exploitUsed,
      explore_quota: exploreQuota,
      dopamine
    },
    init_gate: {
      min_proposal_score: AUTONOMY_MIN_PROPOSAL_SCORE,
      skip_stub: AUTONOMY_SKIP_STUB,
      only_open_proposals: AUTONOMY_ONLY_OPEN_PROPOSALS,
      allowed_risks: Array.from(allowedRisks),
      postcheck_contract: AUTONOMY_POSTCHECK_CONTRACT,
      postcheck_adapter_tests: AUTONOMY_POSTCHECK_ADAPTER_TESTS,
      route_block_cooldown_hours: AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS,
      min_signal_quality: thresholds.min_signal_quality,
      min_sensory_signal_score: thresholds.min_sensory_signal_score,
      min_sensory_relevance_score: thresholds.min_sensory_relevance_score,
      min_directive_fit: thresholds.min_directive_fit,
      min_actionability_score: thresholds.min_actionability_score,
      optimization_policy: {
        high_accuracy_mode: AUTONOMY_OPTIMIZATION_HIGH_ACCURACY_MODE,
        min_delta_percent: optimizationMinDeltaPercent(),
        min_delta_percent_default: AUTONOMY_OPTIMIZATION_MIN_DELTA_PERCENT,
        min_delta_percent_high_accuracy: AUTONOMY_OPTIMIZATION_MIN_DELTA_PERCENT_HIGH_ACCURACY,
        require_explicit_delta: AUTONOMY_OPTIMIZATION_REQUIRE_DELTA
      },
      min_value_signal_score: AUTONOMY_MIN_VALUE_SIGNAL_SCORE,
      medium_risk_value_signal_bonus: AUTONOMY_MEDIUM_RISK_VALUE_SIGNAL_BONUS,
      min_composite_eligibility: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
      min_composite_eligibility_base: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
      min_composite_eligibility_low_risk_canary: compositeEligibilityMin('low', executionMode),
      canary_low_risk_composite_relax: Math.max(0, Number(AUTONOMY_CANARY_LOW_RISK_COMPOSITE_RELAX || 0)),
      lane_no_change_policy: {
        window_days: AUTONOMY_LANE_NO_CHANGE_WINDOW_DAYS,
        limit: AUTONOMY_LANE_NO_CHANGE_LIMIT,
        cooldown_hours: AUTONOMY_LANE_NO_CHANGE_COOLDOWN_HOURS
      },
      medium_risk_lane: {
        canary_only: true,
        composite_min: mediumLane.composite_min,
        directive_fit_min: mediumLane.directive_fit_min,
        actionability_min: mediumLane.actionability_min,
        canary_daily_exec_limit: AUTONOMY_CANARY_MEDIUM_RISK_DAILY_EXEC_LIMIT,
        executed_today: mediumExecuted
      },
      min_eye_score_ema: thresholds.min_eye_score_ema,
      max_proposal_file_age_hours: AUTONOMY_MAX_PROPOSAL_FILE_AGE_HOURS,
      disallowed_parser_types: Array.from(AUTONOMY_DISALLOWED_PARSER_TYPES),
      active_directive_ids: directiveProfile.active_directive_ids,
      directive_profile_available: directiveProfile.available === true,
      directive_profile_error: directiveProfile.error || null
    },
    directive_pulse: {
      enabled: directivePulseCtx.enabled === true,
      available: directivePulseCtx.available === true,
      error: directivePulseCtx.error || null,
      window_days: directivePulseCtx.window_days,
      urgency_hours: directivePulseCtx.urgency_hours,
      no_progress_limit: directivePulseCtx.no_progress_limit,
      cooldown_hours: directivePulseCtx.cooldown_hours,
      rank_bonus: clampNumber(Number(AUTONOMY_DIRECTIVE_PULSE_RANK_BONUS || 0), 0, 1),
      objectives: directivePulseCtx.objectives.slice(0, 10).map(o => ({
        id: o.id,
        tier: o.tier,
        title: o.title,
        tier_weight: o.tier_weight,
        min_share: o.min_share
      })),
      attempts_today: Number(directivePulseCtx.attempts_today || 0),
      tier_attempts_today: directivePulseCtx.tier_attempts_today || {}
    },
    calibration: {
      enabled: calibrationProfile.enabled === true,
      window_days: calibrationProfile.window_days,
      deltas: calibrationProfile.deltas,
      metrics: calibrationProfile.metrics,
      top_eye_biases: calibrationProfile.top_eye_biases || calibrationProfile.eye_biases || [],
      top_topic_biases: calibrationProfile.top_topic_biases || calibrationProfile.topic_biases || []
    },
    tier1_governance: {
      enabled: tier1Governance.enabled === true,
      hard_stop: tier1Governance.hard_stop === true,
      blockers: Array.isArray(tier1Governance.blockers) ? tier1Governance.blockers.slice(0, 6) : [],
      error: tier1Governance.error || null,
      mode_policy: tier1Governance.mode_policy || null,
      cost: tier1Governance.cost || null,
      drift: tier1Governance.drift || null,
      alignment: tier1Governance.alignment || null,
      exception_memory: tier1ExceptionSummary
    },
    human_escalation: {
      block_runs: AUTONOMY_HUMAN_ESCALATION_BLOCK_RUNS,
      block_active: AUTONOMY_HUMAN_ESCALATION_BLOCK_RUNS && humanEscalations.length > 0,
      hold_hours: Math.max(1, Number(AUTONOMY_HUMAN_ESCALATION_HOLD_HOURS || 6)),
      active_count: humanEscalations.length,
      pending_count: humanEscalations.length,
      next_clear_at: humanEscalationNextClearAt,
      active: humanEscalations.slice(0, Math.max(1, Number(AUTONOMY_HUMAN_ESCALATION_MAX_STATUS_ROWS || 5))).map(e => ({
        escalation_id: e.escalation_id || null,
        ts: e.ts || null,
        expires_at: e.expires_at || null,
        remaining_minutes: e.remaining_minutes,
        stage: e.stage || null,
        error_code: e.error_code || null,
        signature: e.signature || null,
        proposal_id: e.proposal_id || null,
        receipt_id: e.receipt_id || null,
        gate: e.gate || null
      }))
    },
    strategy_profile: strategy
      ? {
          id: strategy.id,
          name: strategy.name,
          status: strategy.status,
          file: path.relative(REPO_ROOT, strategy.file).replace(/\\/g, '/'),
          execution_mode: executionMode,
          canary_daily_exec_limit: strategyCanaryDailyExecLimit(strategy, AUTONOMY_CANARY_DAILY_EXEC_LIMIT),
          allowed_risks: Array.isArray(strategy.risk_policy && strategy.risk_policy.allowed_risks)
            ? strategy.risk_policy.allowed_risks
            : [],
          threshold_overrides: strategy.threshold_overrides || {},
          validation: strategy.validation || { strict_ok: true, errors: [], warnings: [] }
        }
      : null,
    strategy: {
      execution_mode: executionMode,
      require_readiness_for_execute: AUTONOMY_REQUIRE_READINESS_FOR_EXECUTE,
      canary_daily_exec_limit: canaryDailyExecLimit,
      daily_runs_cap: maxRunsPerDay,
      daily_token_cap: budget.token_cap,
      max_tokens_per_action: Number.isFinite(Number(strategyBudget.max_tokens_per_action))
        ? Number(strategyBudget.max_tokens_per_action)
        : null,
      token_cost_per_1k: Number.isFinite(Number(strategyBudget.token_cost_per_1k))
        ? Number(strategyBudget.token_cost_per_1k)
        : null,
      daily_usd_cap: Number.isFinite(Number(strategyBudget.daily_usd_cap))
        ? Number(strategyBudget.daily_usd_cap)
        : null,
      per_action_avg_usd_cap: Number.isFinite(Number(strategyBudget.per_action_avg_usd_cap))
        ? Number(strategyBudget.per_action_avg_usd_cap)
        : null,
      monthly_usd_allocation: Number.isFinite(Number(strategyBudget.monthly_usd_allocation))
        ? Number(strategyBudget.monthly_usd_allocation)
        : null,
      monthly_credits_floor_pct: Number.isFinite(Number(strategyBudget.monthly_credits_floor_pct))
        ? Number(strategyBudget.monthly_credits_floor_pct)
        : null,
      per_capability_caps: strategyBudget && strategyBudget.per_capability_caps
        ? strategyBudget.per_capability_caps
        : {},
      explore_fraction: clampNumber(strategyExplore.fraction, 0.05, 0.8),
      explore_every_n: Math.max(1, Number(strategyExplore.every_n || AUTONOMY_EXPLORE_EVERY_N)),
      explore_min_eligible: Math.max(2, Number(strategyExplore.min_eligible || AUTONOMY_EXPLORE_MIN_ELIGIBLE))
    },
    dod_gate: {
      allow_propose_shipped: AUTONOMY_DOD_ALLOW_PROPOSE_SHIPPED,
      min_artifact_delta: AUTONOMY_DOD_MIN_ARTIFACT_DELTA,
      min_entry_delta: AUTONOMY_DOD_MIN_ENTRY_DELTA,
      min_revenue_delta: AUTONOMY_DOD_MIN_REVENUE_DELTA,
      min_habit_outcome_score: AUTONOMY_DOD_MIN_HABIT_OUTCOME_SCORE,
      exec_window_slop_ms: AUTONOMY_DOD_EXEC_WINDOW_SLOP_MS
    },
    terminology_guard: {
      eyes_definition: 'passive_signal_sources_only',
      tools_are_not_eyes: true,
      warnings: detectEyesTerminologyDriftInPool(pool)
    },
    model_catalog: modelCatalogStatusSnapshot(),
    candidates: pool.slice(0, 5).map(x => {
      const candidateType = String(x && x.proposal && x.proposal.type || '');
      const typeThresholdPack = thresholdsForProposalType(thresholds, candidateType, outcomeFitnessPolicy());
      const candidateThresholds = typeThresholdPack.thresholds;
      const q = assessSignalQuality(x.proposal, eyesMap, candidateThresholds, calibrationProfile);
      const dfit = assessDirectiveFit(x.proposal, directiveProfile, candidateThresholds);
      const act = assessActionability(x.proposal, dfit, candidateThresholds);
      const valueSignal = assessValueSignal(x.proposal, act, dfit);
      const composite = compositeEligibilityScore(q.score, dfit.score, act.score);
      const candidateRisk = normalizedRisk(x.proposal && x.proposal.risk);
      const compositeMin = compositeEligibilityMin(candidateRisk, executionMode);
      const objectiveBinding = resolveObjectiveBinding(x.proposal, directivePulseCtx);
      const pulse = assessDirectivePulse(
        x.proposal,
        dfit.score,
        composite,
        x.overlay,
        directivePulseCtx,
        objectiveBinding.objective_id
      );
      return {
        id: x.proposal.id,
        title: x.proposal.title,
        status: x.status,
        score: Number(x.score.toFixed(3)),
        no_change: x.overlay?.outcomes?.no_change || 0,
        reverted: x.overlay?.outcomes?.reverted || 0,
        signal_quality_score: q.score,
        signal_quality_source: q.score_source,
        signal_quality_pass: q.pass,
        sensory_relevance_score: q.sensory_relevance_score,
        sensory_relevance_tier: q.sensory_relevance_tier,
        sensory_quality_score: q.sensory_quality_score,
        sensory_quality_tier: q.sensory_quality_tier,
        signal_quality_reasons: q.reasons.slice(0, 3),
        directive_fit_score: dfit.score,
        directive_fit_pass: dfit.pass,
        directive_fit_reasons: dfit.reasons.slice(0, 3),
        directive_fit_positive: dfit.matched_positive.slice(0, 3),
        directive_fit_negative: dfit.matched_negative.slice(0, 3),
        actionability_score: act.score,
        actionability_pass: act.pass,
        actionability_reasons: act.reasons.slice(0, 3),
        success_criteria_required: !!(act.success_criteria && act.success_criteria.required),
        success_criteria_min_count: Number(act.success_criteria && act.success_criteria.min_count || 0),
        success_criteria_measurable_count: Number(act.success_criteria && act.success_criteria.measurable_count || 0),
        value_signal_score: valueSignal.score,
        value_signal_min_score: valueSignal.min_score,
        value_signal_pass: valueSignal.pass,
        value_signal_reasons: valueSignal.reasons.slice(0, 3),
        risk: candidateRisk,
        composite_eligibility_score: composite,
        composite_eligibility_min_score: compositeMin,
        composite_eligibility_base_min_score: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
        type_threshold_offsets: typeThresholdPack.offsets,
        type_thresholds_applied: candidateThresholds,
        composite_eligibility_pass: composite >= compositeMin,
        directive_pulse: {
          pass: pulse.pass,
          score: pulse.score,
          objective_id: pulse.objective_id || null,
          tier: pulse.tier == null ? null : pulse.tier,
          objective_allocation_score: Number(pulse.objective_allocation_score || 0),
          reasons: Array.isArray(pulse.reasons) ? pulse.reasons.slice(0, 3) : []
        },
        objective_binding: {
          pass: objectiveBinding.pass === true,
          required: objectiveBinding.required === true,
          objective_id: objectiveBinding.objective_id || null,
          source: objectiveBinding.source || null,
          reasons: Array.isArray(objectiveBinding.reasons) ? objectiveBinding.reasons.slice(0, 3) : []
        }
      };
    })
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function readinessCmd(dateStr) {
  const blockers = [];
  const addBlocker = (code, detail, opts: AnyObj = {}) => {
    blockers.push({
      code: String(code || 'unknown'),
      detail: String(detail || '').slice(0, 220),
      retryable: opts.retryable !== false,
      next_at: opts.next_at || null,
      meta: opts.meta && typeof opts.meta === 'object' ? opts.meta : {}
    });
  };

  const emergency = isEmergencyStopEngaged('autonomy');
  if (emergency.engaged) {
    addBlocker('emergency_stop', 'emergency stop engaged for autonomy scope', {
      retryable: false,
      meta: { scope: 'autonomy', stop_state: emergency.state || null }
    });
  }

  const strategy = strategyProfile();
  const executionMode = effectiveStrategyExecutionMode();
  const strategyBudget = effectiveStrategyBudget();
  const readinessRequired = AUTONOMY_REQUIRE_READINESS_FOR_EXECUTE && isExecuteMode(executionMode);
  const strategyReadinessSignal: AnyObj = {
    status: readinessRequired ? 'warn' : 'pass',
    required: readinessRequired,
    ready_for_execute: readinessRequired ? null : true,
    failed_checks: []
  };
  const maxRunsPerDay = Number.isFinite(Number(strategyBudget.daily_runs_cap))
    ? Number(strategyBudget.daily_runs_cap)
    : AUTONOMY_MAX_RUNS_PER_DAY;
  const canaryDailyExecLimit = executionMode === 'canary_execute'
    ? effectiveStrategyCanaryExecLimit(strategy)
    : null;
  const autonomyEnabled = executionAllowedByFeatureFlag(executionMode, false);
  if (!autonomyEnabled) {
    addBlocker('feature_flag_disabled', 'AUTONOMY_ENABLED!=1', {
      retryable: false,
      meta: {
        execution_mode: executionMode,
        canary_allow_with_flag_off: AUTONOMY_CANARY_ALLOW_WITH_FLAG_OFF
      }
    });
  }

  if (
    String(process.env.AUTONOMY_STRATEGY_STRICT || '') === '1'
    && strategy
    && strategy.validation
    && strategy.validation.strict_ok === false
  ) {
    addBlocker('strategy_invalid', 'strategy validation failed in strict mode', {
      retryable: false,
      meta: {
        strategy_id: strategy.id || null,
        errors: Array.isArray(strategy.validation.errors) ? strategy.validation.errors.slice(0, 8) : []
      }
    });
  }

  if (readinessRequired) {
    const minDays = strategy
      && strategy.promotion_policy
      && Number.isFinite(Number(strategy.promotion_policy.min_days))
        ? Number(strategy.promotion_policy.min_days)
        : null;
    const readiness = runStrategyReadiness(dateStr, strategy ? strategy.id : null, minDays);
    const payload = readiness.payload && typeof readiness.payload === 'object' ? readiness.payload : null;
    const readinessDetails = payload && payload.readiness && typeof payload.readiness === 'object'
      ? payload.readiness
      : {};
    const failedChecks = Array.isArray(readinessDetails.failed_checks)
      ? readinessDetails.failed_checks.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const ready = !!(readiness.ok && payload && payload.ok === true && payload.readiness && payload.readiness.ready_for_execute === true);
    strategyReadinessSignal.status = ready ? 'pass' : 'fail';
    strategyReadinessSignal.ready_for_execute = ready;
    strategyReadinessSignal.failed_checks = failedChecks.slice(0, 8);
    strategyReadinessSignal.strategy_id = strategy ? strategy.id || null : null;
    strategyReadinessSignal.readiness_code = Number(readiness.code || 0);
    if (!readiness.ok) {
      strategyReadinessSignal.error = shortText(readiness.stderr || readiness.stdout || `readiness_exit_${readiness.code}`, 180);
    }
    if (!ready) {
      addBlocker('strategy_readiness', 'strategy is not ready for execute mode', {
        retryable: false,
        meta: {
          strategy_id: strategy ? strategy.id : null,
          code: readiness.code,
          readiness: payload && payload.readiness ? payload.readiness : null,
          error: !readiness.ok ? shortText(readiness.stderr || readiness.stdout || `readiness_exit_${readiness.code}`, 180) : null
        }
      });
    }
  }

  const runs = runsSinceReset(readRuns(dateStr));
  const attempts = attemptEvents(runs);
  const capAttempts = capacityCountedAttemptEvents(runs);
  const attemptsToday = attempts.length;
  const attemptsTodayForCap = capAttempts.length;
  const executedRuns = runs.filter(e => e && e.type === 'autonomy_run' && e.result === 'executed');
  const executedToday = executedRuns.length;
  const executionQuotaDeficit = needsExecutionQuota(executionMode, false, executedToday);
  const executionQuotaRemaining = Math.max(0, Number(AUTONOMY_MIN_DAILY_EXECUTIONS || 0) - Number(executedToday || 0));
  const shippedToday = shippedCount(runs);
  const noProgressStreak = consecutiveNoProgressRuns(runs);
  const gateExhaustionStreak = consecutiveGateExhaustedAttempts(attempts);
  const lastAttempt = attempts.length ? attempts[attempts.length - 1] : null;
  const lastCapacityAttempt = capAttempts.length ? capAttempts[capAttempts.length - 1] : lastAttempt;
  const lastAttemptMinutesAgo = lastAttempt ? minutesSinceTs(lastAttempt.ts) : null;
  const lastCapacityAttemptMinutesAgo = lastCapacityAttempt ? minutesSinceTs(lastCapacityAttempt.ts) : null;
  const tier1Governance = evaluateTier1GovernanceSnapshot(dateStr, attemptsToday, 0, {
    execution_mode: executionMode,
    strategy_budget: strategyBudget
  });
  const activeEscalations = activeHumanEscalations(AUTONOMY_HUMAN_ESCALATION_HOLD_HOURS);

  if (tier1Governance.enabled === true && tier1Governance.hard_stop === true) {
    addBlocker('tier1_governance', 'tier1 governance hard stop active', {
      retryable: false,
      meta: {
        blockers: Array.isArray(tier1Governance.blockers) ? tier1Governance.blockers.slice(0, 6) : [],
        mode_policy: tier1Governance.mode_policy || null,
        cost: tier1Governance.cost || null,
        drift: tier1Governance.drift || null,
        alignment: tier1Governance.alignment || null
      }
    });
  }

  if (
    AUTONOMY_HUMAN_ESCALATION_BLOCK_RUNS
    && activeEscalations.length > 0
  ) {
    const nextAt = nextHumanEscalationClearAt(activeEscalations);
    addBlocker('human_escalation_pending', 'novel exception escalation hold is active', {
      retryable: true,
      next_at: nextAt,
      meta: {
        active_count: activeEscalations.length,
        hold_hours: Math.max(1, Number(AUTONOMY_HUMAN_ESCALATION_HOLD_HOURS || 6)),
        next_clear_at: nextAt,
        top_escalation: {
          escalation_id: activeEscalations[0].escalation_id || null,
          stage: activeEscalations[0].stage || null,
          error_code: activeEscalations[0].error_code || null,
          signature: activeEscalations[0].signature || null,
          proposal_id: activeEscalations[0].proposal_id || null,
          expires_at: activeEscalations[0].expires_at || null
        }
      }
    });
  }

  if (!executionQuotaDeficit && maxRunsPerDay > 0 && attemptsTodayForCap >= maxRunsPerDay) {
    addBlocker('daily_cap', 'daily run cap reached', {
      next_at: startOfNextUtcDay(dateStr),
      meta: {
        attempts_today: attemptsTodayForCap,
        attempts_total: attemptsToday,
        max_runs_per_day: maxRunsPerDay
      }
    });
  }

  if (
    executionMode === 'canary_execute'
    && Number.isFinite(Number(canaryDailyExecLimit))
    && Number(canaryDailyExecLimit) > 0
    && executedToday >= Number(canaryDailyExecLimit)
    && !executionQuotaDeficit
  ) {
    addBlocker('canary_cap', 'canary execute cap reached', {
      next_at: startOfNextUtcDay(dateStr),
      meta: { executed_today: executedToday, canary_daily_exec_limit: Number(canaryDailyExecLimit) }
    });
  }

  if (
    AUTONOMY_MIN_MINUTES_BETWEEN_RUNS > 0
    && lastCapacityAttemptMinutesAgo != null
    && lastCapacityAttemptMinutesAgo < AUTONOMY_MIN_MINUTES_BETWEEN_RUNS
    && !executionQuotaDeficit
  ) {
    addBlocker('interval', 'minimum interval between runs not elapsed', {
      next_at: isoAfterMinutes(AUTONOMY_MIN_MINUTES_BETWEEN_RUNS - lastCapacityAttemptMinutesAgo),
      meta: {
        last_attempt_minutes_ago: Number(lastCapacityAttemptMinutesAgo.toFixed(2)),
        last_attempt_minutes_ago_any: lastAttemptMinutesAgo == null ? null : Number(lastAttemptMinutesAgo.toFixed(2)),
        min_minutes_between_runs: AUTONOMY_MIN_MINUTES_BETWEEN_RUNS
      }
    });
  }

  if (
    AUTONOMY_REPEAT_EXHAUSTED_LIMIT > 0
    && AUTONOMY_REPEAT_EXHAUSTED_COOLDOWN_MINUTES > 0
    && gateExhaustionStreak >= AUTONOMY_REPEAT_EXHAUSTED_LIMIT
    && lastAttemptMinutesAgo != null
    && lastAttemptMinutesAgo < AUTONOMY_REPEAT_EXHAUSTED_COOLDOWN_MINUTES
    && !executionQuotaDeficit
  ) {
    addBlocker('exhaustion_cooldown', 'gate exhaustion cooldown active', {
      next_at: isoAfterMinutes(AUTONOMY_REPEAT_EXHAUSTED_COOLDOWN_MINUTES - lastAttemptMinutesAgo),
      meta: {
        gate_exhaustion_streak: gateExhaustionStreak,
        gate_exhaustion_limit: AUTONOMY_REPEAT_EXHAUSTED_LIMIT,
        cooldown_minutes: AUTONOMY_REPEAT_EXHAUSTED_COOLDOWN_MINUTES
      }
    });
  }

  if (AUTONOMY_REPEAT_NO_PROGRESS_LIMIT > 0 && noProgressStreak >= AUTONOMY_REPEAT_NO_PROGRESS_LIMIT) {
    addBlocker('no_progress_streak', 'no-progress streak cap reached', {
      retryable: false,
      meta: { no_progress_streak: noProgressStreak, no_progress_limit: AUTONOMY_REPEAT_NO_PROGRESS_LIMIT, shipped_today: shippedToday }
    });
  }

  const dopamine = loadDopamineSnapshot(dateStr);
  if (noProgressStreak > 0 && shippedToday === 0 && dopamine.momentum_ok !== true) {
    addBlocker('dopamine_momentum', 'dopamine momentum gate failed after no-progress streak', {
      retryable: false,
      meta: { dopamine }
    });
  }
  const budgetPacing = budgetPacingSnapshot(dateStr);

  const proposalDate = latestProposalDate(dateStr);
  let pool = [];
  if (!proposalDate) {
    addBlocker('no_proposals', 'no proposal file available');
  } else {
    const proposalAgeHours = ageHours(proposalDate);
    if (AUTONOMY_MAX_PROPOSAL_FILE_AGE_HOURS > 0 && proposalAgeHours > AUTONOMY_MAX_PROPOSAL_FILE_AGE_HOURS) {
      addBlocker('stale_signal', 'proposal file is older than max age window', {
        retryable: false,
        meta: {
          proposal_date: proposalDate,
          proposal_age_hours: Number(proposalAgeHours.toFixed(2)),
          max_proposal_file_age_hours: AUTONOMY_MAX_PROPOSAL_FILE_AGE_HOURS
        }
      });
    }
    pool = candidatePool(proposalDate);
    if (!pool.length) {
      addBlocker('no_candidates', 'no admissible proposal candidates after policy filters');
    } else if (AUTONOMY_UNCHANGED_SHORT_CIRCUIT_ENABLED) {
      const proposals = loadProposalsForDate(proposalDate);
      const admission = admissionSummaryFromProposals(proposals);
      const fingerprint = autonomyStateFingerprint({
        dateStr,
        proposalDate,
        executionMode,
        shadowOnly: false,
        strategyId: strategy ? strategy.id : null,
        pool,
        admission
      });
      const shortCircuit = peekUnchangedShortCircuit(
        `run:${dateStr}`,
        fingerprint,
        AUTONOMY_UNCHANGED_SHORT_CIRCUIT_MINUTES
      );
      if (shortCircuit.hit) {
        const remainMinutes = Math.max(0, Number(shortCircuit.ttl_minutes || 0) - Number(shortCircuit.age_minutes || 0));
        addBlocker('unchanged_state', 'unchanged-state short-circuit active', {
          next_at: isoAfterMinutes(remainMinutes),
          meta: {
            key: `run:${dateStr}`,
            ttl_minutes: shortCircuit.ttl_minutes,
            age_minutes: shortCircuit.age_minutes
          }
        });
      }
    }
  }

  const retryableOnly = blockers.length > 0 && blockers.every(b => b.retryable === true);
  const timedMs = blockers
    .map(b => Date.parse(String(b.next_at || '')))
    .filter(ms => Number.isFinite(ms) && ms > 0);
  const nextRunnableAt = retryableOnly && timedMs.length
    ? new Date(Math.max(...timedMs)).toISOString()
    : null;
  const blockerCodeSet = new Set(
    blockers
      .map((b) => String(b && b.code || '').trim())
      .filter(Boolean)
  );
  const preexecSignals = {
    strategy_readiness: {
      ...strategyReadinessSignal,
      status: normalizedSignalStatus(strategyReadinessSignal.status, readinessRequired ? 'warn' : 'pass')
    },
    tier1_governance: {
      status: tier1Governance.enabled === true
        ? (tier1Governance.hard_stop === true ? 'fail' : 'pass')
        : 'pass',
      enabled: tier1Governance.enabled === true,
      hard_stop: tier1Governance.hard_stop === true,
      blockers: Array.isArray(tier1Governance.blockers) ? tier1Governance.blockers.slice(0, 6) : []
    },
    dopamine_momentum: {
      status: noProgressStreak > 0
        ? (dopamine.momentum_ok === true ? 'warn' : 'fail')
        : 'pass',
      no_progress_streak: noProgressStreak,
      shipped_today: shippedToday,
      momentum_ok: dopamine.momentum_ok === true,
      verified_progress_today: dopamine.verified_progress_today === true
    },
    budget_pacing: {
      status: budgetPacing.autopause_active === true
        ? 'fail'
        : (budgetPacing.tight === true ? 'warn' : 'pass'),
      pressure: String(budgetPacing.pressure || 'none'),
      autopause_active: budgetPacing.autopause_active === true,
      remaining_ratio: Number(budgetPacing.remaining_ratio || 0),
      remaining_tokens: Number(budgetPacing.remaining_tokens || 0),
      token_cap: Number(budgetPacing.token_cap || 0)
    },
    queue_supply: {
      status: !proposalDate
        ? 'fail'
        : (Array.isArray(pool) && pool.length > 0 ? 'pass' : 'fail'),
      proposal_date: proposalDate || null,
      candidate_pool_size: Array.isArray(pool) ? pool.length : 0,
      stale_signal: blockerCodeSet.has('stale_signal')
    },
    human_escalation: {
      status: activeEscalations.length > 0 ? 'warn' : 'pass',
      active_count: activeEscalations.length,
      blocking_enabled: AUTONOMY_HUMAN_ESCALATION_BLOCK_RUNS === true
    }
  };
  const preexecVerdict = preexecVerdictFromSignals(blockers, preexecSignals, nextRunnableAt);

  const out = {
    ok: true,
    ts: nowIso(),
    date: dateStr,
    can_run: blockers.length === 0,
    next_runnable_at: blockers.length === 0 ? nowIso() : nextRunnableAt,
    manual_action_required: blockers.some(b => b.retryable !== true),
    execution_mode: executionMode,
    strategy_id: strategy ? strategy.id : null,
    attempts_today: attemptsToday,
    executed_today: executedToday,
    min_daily_executions: AUTONOMY_MIN_DAILY_EXECUTIONS,
    execution_quota_deficit: executionQuotaDeficit,
    execution_quota_remaining: executionQuotaRemaining,
    max_runs_per_day: maxRunsPerDay,
    canary_daily_exec_limit: canaryDailyExecLimit,
    proposal_date: proposalDate || null,
    candidate_pool_size: Array.isArray(pool) ? pool.length : 0,
    preexec_verdict: preexecVerdict,
    blockers
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function runCmd(dateStr, opts: AnyObj = {}) {
  const shadowOnly = opts && opts.shadowOnly === true;

  const emergency = isEmergencyStopEngaged('autonomy');
  if (emergency.engaged) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_emergency_stop',
      scope: 'autonomy',
      stop_state: emergency.state || null
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_emergency_stop',
      scope: 'autonomy',
      stop_state: emergency.state || null,
      ts: nowIso()
    }) + '\n');
    return;
  }

  const priorRunsForStrategySelection = runsSinceReset(readRuns(dateStr));
  const strategySelection = selectStrategyForRun(dateStr, priorRunsForStrategySelection);
  const strategy = strategySelection && strategySelection.strategy
    ? strategySelection.strategy
    : strategyProfile();
  STRATEGY_CACHE = strategy || STRATEGY_CACHE;
  const strategyBudget = effectiveStrategyBudget(strategy);
  const executionMode = shadowOnly ? 'score_only' : effectiveStrategyExecutionMode(strategy);
  if (!executionAllowedByFeatureFlag(executionMode, shadowOnly)) {
    process.stdout.write(JSON.stringify({
      ok: true,
      skipped: true,
      reason: 'AUTONOMY_ENABLED!=1',
      execution_mode: executionMode,
      canary_allow_with_flag_off: AUTONOMY_CANARY_ALLOW_WITH_FLAG_OFF,
      ts: nowIso()
    }) + '\n');
    return;
  }
  const allowedRiskSet = effectiveAllowedRisksSet(strategy);
  if (
    String(process.env.AUTONOMY_STRATEGY_STRICT || '') === '1'
    && strategy
    && strategy.validation
    && strategy.validation.strict_ok === false
  ) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_init_gate_strategy_invalid',
      strategy_id: strategy.id,
      errors: strategy.validation.errors || []
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_init_gate_strategy_invalid',
      strategy_id: strategy.id,
      errors: strategy.validation.errors || [],
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (!shadowOnly && strategySelection && Number(strategySelection.active_count || 0) > 1) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_strategy_selection',
      selected_strategy_id: strategy && strategy.id ? String(strategy.id) : null,
      selection_mode: strategySelection.mode || null,
      canary_due: strategySelection.canary_due === true,
      canary_every: Number.isFinite(Number(strategySelection.canary_every))
        ? Number(strategySelection.canary_every)
        : null,
      attempt_index: Number(strategySelection.attempt_index || 0),
      active_count: Number(strategySelection.active_count || 0),
      ranked: Array.isArray(strategySelection.ranked)
        ? strategySelection.ranked.slice(0, 5)
        : []
    });
  }

  const priorRunsForPolicyHoldCooldown = priorRunsForStrategySelection;
  const lastPolicyHoldRun = latestPolicyHoldRunEvent(priorRunsForPolicyHoldCooldown);
  const policyHoldPressure = policyHoldPressureSnapshot(priorRunsForPolicyHoldCooldown);
  const policyHoldCooldownMinutes = policyHoldCooldownMinutesForResult(
    Math.max(0, Number(AUTONOMY_POLICY_HOLD_COOLDOWN_MINUTES || 0)),
    policyHoldPressure,
    lastPolicyHoldRun
  );
  const lastPolicyHoldMinutesAgo = lastPolicyHoldRun ? minutesSinceTs(lastPolicyHoldRun.ts) : null;
  if (
    !shadowOnly
    && policyHoldCooldownMinutes > 0
    && lastPolicyHoldMinutesAgo != null
    && lastPolicyHoldMinutesAgo < policyHoldCooldownMinutes
  ) {
    const remainingMinutes = Math.max(0, policyHoldCooldownMinutes - Number(lastPolicyHoldMinutesAgo || 0));
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_interval',
      interval_scope: 'policy_hold',
      last_policy_hold_result: String(lastPolicyHoldRun.result || ''),
      last_policy_hold_minutes_ago: Number(lastPolicyHoldMinutesAgo.toFixed(2)),
      min_minutes_between_runs: policyHoldCooldownMinutes,
      policy_hold_pressure: policyHoldPressure,
      next_runnable_at: isoAfterMinutes(remainingMinutes)
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_interval',
      interval_scope: 'policy_hold',
      last_policy_hold_result: String(lastPolicyHoldRun.result || ''),
      last_policy_hold_minutes_ago: Number(lastPolicyHoldMinutesAgo.toFixed(2)),
      min_minutes_between_runs: policyHoldCooldownMinutes,
      policy_hold_pressure: policyHoldPressure,
      next_runnable_at: isoAfterMinutes(remainingMinutes),
      ts: nowIso()
    }) + '\n');
    return;
  }
  const directivePulseCtx = buildDirectivePulseContext(dateStr);
  const globalHoldObjectiveContext = policyHoldObjectiveContext(directivePulseCtx);

  if (
    AUTONOMY_REQUIRE_READINESS_FOR_EXECUTE
    && strategy
    && isExecuteMode(executionMode)
  ) {
    const readinessRetryCooldownKeyId = readinessRetryCooldownKey(strategy.id, executionMode);
    if (
      !shadowOnly
      && AUTONOMY_READINESS_RETRY_COOLDOWN_HOURS > 0
      && readinessRetryCooldownKeyId
      && cooldownActive(readinessRetryCooldownKeyId)
    ) {
      const readinessRetryEnt = cooldownEntry(readinessRetryCooldownKeyId);
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_repeat_gate_interval',
        interval_scope: 'readiness_hold',
        strategy_id: strategy.id,
        execution_mode: executionMode,
        readiness_retry_cooldown_hours: AUTONOMY_READINESS_RETRY_COOLDOWN_HOURS,
        readiness_retry_cooldown_key: readinessRetryCooldownKeyId,
        next_runnable_at: readinessRetryEnt ? (readinessRetryEnt.until || null) : null
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_repeat_gate_interval',
        interval_scope: 'readiness_hold',
        strategy_id: strategy.id,
        execution_mode: executionMode,
        readiness_retry_cooldown_hours: AUTONOMY_READINESS_RETRY_COOLDOWN_HOURS,
        readiness_retry_cooldown_key: readinessRetryCooldownKeyId,
        next_runnable_at: readinessRetryEnt ? (readinessRetryEnt.until || null) : null,
        ts: nowIso()
      }) + '\n');
      return;
    }

    const minDays = strategy
      && strategy.promotion_policy
      && Number.isFinite(Number(strategy.promotion_policy.min_days))
        ? Number(strategy.promotion_policy.min_days)
        : null;
    const readiness = runStrategyReadiness(dateStr, strategy.id, minDays);
    const readinessPayload = readiness.payload && typeof readiness.payload === 'object' ? readiness.payload : null;
    const readinessDetails = readinessPayload && readinessPayload.readiness && typeof readinessPayload.readiness === 'object'
      ? readinessPayload.readiness
      : null;
    const readinessFailedChecks = Array.isArray(readinessDetails && readinessDetails.failed_checks)
      ? readinessDetails.failed_checks
      : [];
    const ready = !!(readiness.ok && readinessPayload && readinessPayload.ok === true && readinessDetails && readinessDetails.ready_for_execute === true);
    const relaxedCanaryReadiness = AUTONOMY_CANARY_RELAX_ENABLED
      && executionMode === 'canary_execute'
      && canaryFailedChecksAllowed(readinessFailedChecks, AUTONOMY_CANARY_RELAX_READINESS_CHECKS);
    if (!ready && !relaxedCanaryReadiness) {
      const readinessStopResult = readinessFailedChecks.includes('success_criteria_quality_insufficient_rate')
        ? 'stop_init_gate_criteria_quality_insufficient'
        : 'stop_init_gate_readiness';
      const readinessHoldReason = readinessStopResult === 'stop_init_gate_criteria_quality_insufficient'
        ? 'success_criteria_quality_insufficient_rate'
        : 'strategy_readiness';
      const readinessRetryCooldownHours = Math.max(0, Number(AUTONOMY_READINESS_RETRY_COOLDOWN_HOURS || 0));
      if (!shadowOnly && readinessRetryCooldownHours > 0 && readinessRetryCooldownKeyId) {
        setCooldown(
          readinessRetryCooldownKeyId,
          readinessRetryCooldownHours,
          `auto:readiness_retry cooldown_${readinessRetryCooldownHours}h`
        );
      }
      const readinessRetryEnt = readinessRetryCooldownKeyId ? cooldownEntry(readinessRetryCooldownKeyId) : null;
      const readinessObjectiveContext = policyHoldObjectiveContext(directivePulseCtx);
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: readinessStopResult,
        policy_hold: true,
        hold_scope: 'readiness',
        hold_reason: readinessHoldReason,
        ...readinessObjectiveContext,
        strategy_id: strategy.id,
        execution_mode: executionMode,
        readiness_retry_cooldown_hours: readinessRetryCooldownHours,
        readiness_retry_cooldown_key: readinessRetryCooldownKeyId || null,
        next_runnable_at: readinessRetryEnt ? (readinessRetryEnt.until || null) : null,
        readiness_code: readiness.code,
        readiness: readinessDetails,
        readiness_error: !readiness.ok ? shortText(readiness.stderr || readiness.stdout || `readiness_exit_${readiness.code}`, 180) : null
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: readinessStopResult,
        policy_hold: true,
        hold_scope: 'readiness',
        hold_reason: readinessHoldReason,
        ...readinessObjectiveContext,
        strategy_id: strategy.id,
        execution_mode: executionMode,
        readiness_retry_cooldown_hours: readinessRetryCooldownHours,
        readiness_retry_cooldown_key: readinessRetryCooldownKeyId || null,
        next_runnable_at: readinessRetryEnt ? (readinessRetryEnt.until || null) : null,
        readiness: readinessDetails,
        ts: nowIso()
      }) + '\n');
      return;
    }
    if (!ready && relaxedCanaryReadiness) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'init_gate_canary_relaxed_readiness',
        strategy_id: strategy.id,
        execution_mode: executionMode,
        readiness_failed_checks: readinessFailedChecks,
        readiness_relaxed_checks: Array.from(AUTONOMY_CANARY_RELAX_READINESS_CHECKS)
      });
    }
  }

  if (
    AUTONOMY_REQUIRE_SPC_FOR_EXECUTE
    && strategy
    && isExecuteMode(executionMode)
  ) {
    const minDays = strategy
      && strategy.promotion_policy
      && Number.isFinite(Number(strategy.promotion_policy.min_days))
        ? Number(strategy.promotion_policy.min_days)
        : 7;
    const spc = evaluatePipelineSpcGate(dateStr, {
      days: Math.max(1, minDays),
      baseline_days: AUTONOMY_SPC_BASELINE_DAYS,
      baseline_min_days: AUTONOMY_SPC_BASELINE_MIN_DAYS,
      sigma: AUTONOMY_SPC_SIGMA
    });
    const spcFailedChecks = Array.isArray(spc && spc.failed_checks) ? spc.failed_checks : [];
    const relaxedCanarySpc = AUTONOMY_CANARY_RELAX_ENABLED
      && executionMode === 'canary_execute'
      && canaryFailedChecksAllowed(spcFailedChecks, AUTONOMY_CANARY_RELAX_SPC_CHECKS);
    if ((!spc || spc.pass !== true || spc.hold_escalation === true) && !relaxedCanarySpc) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_init_gate_spc',
        strategy_id: strategy.id,
        execution_mode: executionMode,
        spc_failed_checks: spcFailedChecks,
        spc_control_source: spc && spc.control ? spc.control.source || null : null
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_init_gate_spc',
        strategy_id: strategy.id,
        execution_mode: executionMode,
        spc,
        ts: nowIso()
      }) + '\n');
      return;
    }
    if ((spc && (spc.pass !== true || spc.hold_escalation === true)) && relaxedCanarySpc) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'init_gate_canary_relaxed_spc',
        strategy_id: strategy.id,
        execution_mode: executionMode,
        spc_failed_checks: spcFailedChecks,
        spc_relaxed_checks: Array.from(AUTONOMY_CANARY_RELAX_SPC_CHECKS)
      });
    }
  }

  if (!shadowOnly) {
    maybeRunModelCatalogLoop(dateStr);
  }
  const modelCatalogSnapshot = modelCatalogStatusSnapshot();
  process.stderr.write(`AUTONOMY_SUMMARY model_catalog_apply_pending=${Number(modelCatalogSnapshot.pending_apply || 0)}\n`);
  if (!shadowOnly) {
    const modelCatalogCanary = evaluateModelCatalogCanary(dateStr);
    if (modelCatalogCanary && modelCatalogCanary.rollback_triggered) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_init_gate_model_catalog_rollback',
        rollback_ok: modelCatalogCanary.rollback_ok === true,
        rollback_error: modelCatalogCanary.rollback_error || null
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_init_gate_model_catalog_rollback',
        rollback_ok: modelCatalogCanary.rollback_ok === true,
        rollback_error: modelCatalogCanary.rollback_error || null,
        ts: nowIso()
      }) + '\n');
      return;
    }
  }

  const proposalDate = latestProposalDate(dateStr);
  if (!proposalDate) {
    writeRun(dateStr, { ts: nowIso(), type: 'autonomy_run', result: 'no_proposals' });
    process.stdout.write(JSON.stringify({ ok: true, result: 'no_proposals', ts: nowIso() }) + '\n');
    return;
  }

  const proposalAgeHours = ageHours(proposalDate);
  if (AUTONOMY_MAX_PROPOSAL_FILE_AGE_HOURS > 0 && proposalAgeHours > AUTONOMY_MAX_PROPOSAL_FILE_AGE_HOURS) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_stale_signal',
      proposal_date: proposalDate,
      proposal_age_hours: Number(proposalAgeHours.toFixed(2)),
      max_proposal_file_age_hours: AUTONOMY_MAX_PROPOSAL_FILE_AGE_HOURS
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_stale_signal',
      proposal_date: proposalDate,
      proposal_age_hours: Number(proposalAgeHours.toFixed(2)),
      max_proposal_file_age_hours: AUTONOMY_MAX_PROPOSAL_FILE_AGE_HOURS,
      ts: nowIso()
    }) + '\n');
    return;
  }

  const enrichRes = runProposalEnricher(proposalDate, false);
  const enrichPayload = enrichRes.payload && typeof enrichRes.payload === 'object' ? enrichRes.payload : null;
  if (!enrichRes.ok || !enrichPayload || enrichPayload.ok !== true) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'init_gate_enricher_failed',
      proposal_date: proposalDate,
      enricher_code: enrichRes.code,
      enricher_stdout: shortText(enrichRes.stdout || '', 180),
      enricher_stderr: shortText(enrichRes.stderr || '', 180)
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'init_gate_enricher_failed',
      proposal_date: proposalDate,
      enricher_code: enrichRes.code,
      ts: nowIso()
    }) + '\n');
    return;
  }
  const admissionSummary = enrichPayload.admission && typeof enrichPayload.admission === 'object'
    ? enrichPayload.admission
    : { total: 0, eligible: 0, blocked: 0, blocked_by_reason: {} };

  const pool = candidatePool(proposalDate, strategy);
  if (!pool.length) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'no_candidates',
      proposal_date: proposalDate,
      admission: admissionSummary
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'no_candidates',
      proposal_date: proposalDate,
      admission: admissionSummary,
      ts: nowIso()
    }) + '\n');
    return;
  }
  const terminologyWarnings = detectEyesTerminologyDriftInPool(pool);
  if (terminologyWarnings.length) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_terminology_warning',
      reason: 'tools_labeled_as_eyes',
      warnings: terminologyWarnings
    });
  }

  if (AUTONOMY_UNCHANGED_SHORT_CIRCUIT_ENABLED) {
    const shortCircuitKey = `${shadowOnly ? 'evidence' : 'run'}:${dateStr}`;
    const fingerprint = autonomyStateFingerprint({
      dateStr,
      proposalDate,
      executionMode,
      shadowOnly,
      strategyId: strategy ? strategy.id : null,
      pool,
      admission: admissionSummary
    });
    const shortCircuit = checkUnchangedShortCircuit(
      shortCircuitKey,
      fingerprint,
      AUTONOMY_UNCHANGED_SHORT_CIRCUIT_MINUTES
    );
    if (shortCircuit.hit) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_repeat_gate_unchanged_state',
        ...globalHoldObjectiveContext,
        key: shortCircuitKey,
        fingerprint,
        ttl_minutes: shortCircuit.ttl_minutes,
        age_minutes: shortCircuit.age_minutes
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_repeat_gate_unchanged_state',
        ...globalHoldObjectiveContext,
        key: shortCircuitKey,
        ttl_minutes: shortCircuit.ttl_minutes,
        age_minutes: shortCircuit.age_minutes,
        ts: nowIso()
      }) + '\n');
      return;
    }
  }

  const priorRuns = runsSinceReset(readRuns(dateStr));
  const priorAttempts = attemptEvents(priorRuns);
  const priorCapAttempts = capacityCountedAttemptEvents(priorRuns);
  const attemptsToday = priorAttempts.length;
  const attemptsTodayForCap = priorCapAttempts.length;
  const executedToday = priorRuns.filter(e => e && e.type === 'autonomy_run' && e.result === 'executed').length;
  const executionQuotaDeficit = needsExecutionQuota(executionMode, shadowOnly, executedToday);
  const mediumExecutedToday = executedCountByRisk(priorRuns, 'medium');
  const lastAttempt = priorAttempts.length ? priorAttempts[priorAttempts.length - 1] : null;
  const lastCapacityAttempt = priorCapAttempts.length ? priorCapAttempts[priorCapAttempts.length - 1] : lastAttempt;
  const lastAttemptMinutesAgo = lastAttempt ? minutesSinceTs(lastAttempt.ts) : null;
  const lastCapacityAttemptMinutesAgo = lastCapacityAttempt ? minutesSinceTs(lastCapacityAttempt.ts) : null;
  const noProgressStreak = consecutiveNoProgressRuns(priorRuns);
  const gateExhaustionStreak = consecutiveGateExhaustedAttempts(priorAttempts);
  const shippedToday = shippedCount(priorRuns);
  const executionFloorShippedDeficit = !shadowOnly
    && AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_ENABLED
    && Number(AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_MIN_SHIPPED_PER_DAY || 0) > 0
    && shippedToday < Number(AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_MIN_SHIPPED_PER_DAY || 0);
  const maxRunsPerDay = Number.isFinite(Number(strategyBudget.daily_runs_cap))
    ? Number(strategyBudget.daily_runs_cap)
    : AUTONOMY_MAX_RUNS_PER_DAY;
  const canaryDailyExecLimit = executionMode === 'canary_execute'
    ? effectiveStrategyCanaryExecLimit(strategy)
    : null;
  const mediumCanaryDailyExecLimit = executionMode === 'canary_execute'
    ? Math.max(0, Number(AUTONOMY_CANARY_MEDIUM_RISK_DAILY_EXEC_LIMIT || 0))
    : 0;
  const dopamine = loadDopamineSnapshot(dateStr);
  const decisionEvents = allDecisionEvents();
  const eyesMap = loadEyesMap();
  const directiveProfile = loadDirectiveFitProfile();
  const calibrationProfile: AnyObj = computeCalibrationProfile(dateStr, true);
  const thresholds = calibrationProfile.effective_thresholds || baseThresholds(strategy);
  const repeatGateAnchor = deriveRepeatGateAnchor(lastCapacityAttempt || lastAttempt);
  const dailyCapOverride = consumeHumanCanaryDailyCapOverrideIfAllowed({
    dateStr,
    executionMode,
    attemptsToday: attemptsTodayForCap,
    maxRunsPerDay,
    shadowOnly
  });

  if (
    !shadowOnly
    && !executionQuotaDeficit
    && maxRunsPerDay > 0
    && attemptsTodayForCap >= maxRunsPerDay
    && dailyCapOverride.consumed !== true
  ) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_daily_cap',
      ...globalHoldObjectiveContext,
      attempts_today: attemptsTodayForCap,
      attempts_total: attemptsToday,
      max_runs_per_day: maxRunsPerDay,
      ...repeatGateAnchor
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_daily_cap',
      ...globalHoldObjectiveContext,
      attempts_today: attemptsTodayForCap,
      attempts_total: attemptsToday,
      max_runs_per_day: maxRunsPerDay,
      ...repeatGateAnchor,
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (
    !shadowOnly
    && executionMode === 'canary_execute'
    && Number.isFinite(Number(canaryDailyExecLimit))
    && Number(canaryDailyExecLimit) > 0
    && executedToday >= Number(canaryDailyExecLimit)
    && !executionQuotaDeficit
  ) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_canary_cap',
      ...globalHoldObjectiveContext,
      execution_mode: executionMode,
      executed_today: executedToday,
      canary_daily_exec_limit: Number(canaryDailyExecLimit)
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_canary_cap',
      ...globalHoldObjectiveContext,
      execution_mode: executionMode,
      executed_today: executedToday,
      canary_daily_exec_limit: Number(canaryDailyExecLimit),
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (
    !shadowOnly
    &&
    AUTONOMY_MIN_MINUTES_BETWEEN_RUNS > 0
    && lastCapacityAttemptMinutesAgo != null
    && lastCapacityAttemptMinutesAgo < AUTONOMY_MIN_MINUTES_BETWEEN_RUNS
    && !executionQuotaDeficit
  ) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_interval',
      last_attempt_minutes_ago: Number(lastCapacityAttemptMinutesAgo.toFixed(2)),
      last_attempt_minutes_ago_any: lastAttemptMinutesAgo == null ? null : Number(lastAttemptMinutesAgo.toFixed(2)),
      min_minutes_between_runs: AUTONOMY_MIN_MINUTES_BETWEEN_RUNS,
      ...repeatGateAnchor
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_interval',
      last_attempt_minutes_ago: Number(lastCapacityAttemptMinutesAgo.toFixed(2)),
      last_attempt_minutes_ago_any: lastAttemptMinutesAgo == null ? null : Number(lastAttemptMinutesAgo.toFixed(2)),
      min_minutes_between_runs: AUTONOMY_MIN_MINUTES_BETWEEN_RUNS,
      ...repeatGateAnchor,
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (
    !shadowOnly
    &&
    AUTONOMY_REPEAT_EXHAUSTED_LIMIT > 0
    && AUTONOMY_REPEAT_EXHAUSTED_COOLDOWN_MINUTES > 0
    && gateExhaustionStreak >= AUTONOMY_REPEAT_EXHAUSTED_LIMIT
    && lastAttemptMinutesAgo != null
    && lastAttemptMinutesAgo < AUTONOMY_REPEAT_EXHAUSTED_COOLDOWN_MINUTES
    && !executionQuotaDeficit
  ) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_exhaustion_cooldown',
      gate_exhaustion_streak: gateExhaustionStreak,
      gate_exhaustion_limit: AUTONOMY_REPEAT_EXHAUSTED_LIMIT,
      last_attempt_minutes_ago: Number(lastAttemptMinutesAgo.toFixed(2)),
      cooldown_minutes: AUTONOMY_REPEAT_EXHAUSTED_COOLDOWN_MINUTES
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_exhaustion_cooldown',
      gate_exhaustion_streak: gateExhaustionStreak,
      gate_exhaustion_limit: AUTONOMY_REPEAT_EXHAUSTED_LIMIT,
      last_attempt_minutes_ago: Number(lastAttemptMinutesAgo.toFixed(2)),
      cooldown_minutes: AUTONOMY_REPEAT_EXHAUSTED_COOLDOWN_MINUTES,
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (!shadowOnly && AUTONOMY_REPEAT_NO_PROGRESS_LIMIT > 0 && noProgressStreak >= AUTONOMY_REPEAT_NO_PROGRESS_LIMIT) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_no_progress',
      no_progress_streak: noProgressStreak,
      no_progress_limit: AUTONOMY_REPEAT_NO_PROGRESS_LIMIT,
      shipped_today: shippedToday,
      ...repeatGateAnchor
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_no_progress',
      no_progress_streak: noProgressStreak,
      no_progress_limit: AUTONOMY_REPEAT_NO_PROGRESS_LIMIT,
      shipped_today: shippedToday,
      ...repeatGateAnchor,
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (!shadowOnly && noProgressStreak > 0 && shippedToday === 0 && dopamine.momentum_ok !== true) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_dopamine',
      no_progress_streak: noProgressStreak,
      dopamine,
      ...repeatGateAnchor
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_dopamine',
      no_progress_streak: noProgressStreak,
      dopamine,
      ...repeatGateAnchor,
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (!shadowOnly && AUTONOMY_HUMAN_ESCALATION_BLOCK_RUNS) {
    const activeEscalations = activeHumanEscalations(AUTONOMY_HUMAN_ESCALATION_HOLD_HOURS);
    if (activeEscalations.length > 0) {
      const nextAt = nextHumanEscalationClearAt(activeEscalations);
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_repeat_gate_human_escalation_pending',
        ...globalHoldObjectiveContext,
        active_count: activeEscalations.length,
        hold_hours: Math.max(1, Number(AUTONOMY_HUMAN_ESCALATION_HOLD_HOURS || 6)),
        next_clear_at: nextAt,
        top_escalation: {
          escalation_id: activeEscalations[0].escalation_id || null,
          stage: activeEscalations[0].stage || null,
          error_code: activeEscalations[0].error_code || null,
          signature: activeEscalations[0].signature || null,
          proposal_id: activeEscalations[0].proposal_id || null,
          expires_at: activeEscalations[0].expires_at || null
        }
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_repeat_gate_human_escalation_pending',
        ...globalHoldObjectiveContext,
        active_count: activeEscalations.length,
        hold_hours: Math.max(1, Number(AUTONOMY_HUMAN_ESCALATION_HOLD_HOURS || 6)),
        next_clear_at: nextAt,
        top_escalation: {
          escalation_id: activeEscalations[0].escalation_id || null,
          stage: activeEscalations[0].stage || null,
          error_code: activeEscalations[0].error_code || null,
          signature: activeEscalations[0].signature || null,
          proposal_id: activeEscalations[0].proposal_id || null,
          expires_at: activeEscalations[0].expires_at || null
        },
        ts: nowIso()
      }) + '\n');
      return;
    }
  }

  let pick = null;
  let selection: AnyObj = { mode: 'exploit', index: 0, explore_used: 0, explore_quota: exploreQuotaForDay(), exploit_used: 0 };
  let campaignPlan: AnyObj = { enabled: false, campaign_count: 0, matched_count: 0 };
  const eligible = [];
  const skipStats = {
    unknown_type_quarantine: 0,
    eye_no_progress: 0,
    low_quality: 0,
    low_directive_fit: 0,
    low_actionability: 0,
    optimization_good_enough: 0,
    objective_binding: 0,
    low_value_signal: 0,
    budget_pacing: 0,
    low_composite: 0,
    capability_cooldown: 0,
    medium_risk_guard: 0,
    medium_policy_blocked: 0,
    medium_daily_cap: 0,
    directive_pulse_cooldown: 0,
    manual_gate_prefilter: 0
  };
  let sampleUnknownTypeQuarantine = null;
  let sampleLowQuality = null;
  let sampleLowDirectiveFit = null;
  let sampleLowActionability = null;
  let sampleOptimizationGoodEnough = null;
  let sampleObjectiveBinding = null;
  let sampleLowValueSignal = null;
  let sampleBudgetPacing = null;
  let sampleLowComposite = null;
  let sampleCapabilityCooldown = null;
  let sampleMediumRiskGuard = null;
  let sampleMediumPolicyBlocked = null;
  let sampleMediumDailyCap = null;
  let sampleDirectivePulseCooldown = null;
  let sampleManualGatePrefilter = null;
  const manualGateDeferredCandidates = [];
  const fitnessPolicy = outcomeFitnessPolicy();
  const candidateAuditLimit = clampNumber(Math.round(AUTONOMY_CANDIDATE_AUDIT_MAX_ROWS), 5, 200);
  const candidateRejectedByGate = {};
  const candidateAuditRows = [];
  const budgetPacingState = budgetPacingSnapshot(dateStr);
  const manualGateTelemetry = (
    !shadowOnly
    && executionMode === 'score_only'
    && AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_ENABLED
  )
    ? summarizeRecentManualGateTelemetry(
      AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_WINDOW_HOURS,
      AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_MAX_EVENTS
    )
    : {
      window_hours: AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_WINDOW_HOURS,
      sample_events: 0,
      by_capability: {}
    };
  const queuePressureState = queuePressureSnapshot(proposalDate);
  const tritProductivityState = AUTONOMY_TRIT_SHADOW_ENABLED
    ? evaluateTritShadowProductivity(loadTritShadowPolicy())
    : { enabled: false, active: true, reason: 'trit_shadow_disabled' };
  const dynamicCapsState = adaptiveExecutionCaps({
    executionMode,
    baseDailyCap: maxRunsPerDay,
    baseCanaryCap: canaryDailyExecLimit,
    attemptsToday: attemptsTodayForCap,
    noProgressStreak,
    executedNoProgressStreak: noProgressStreak,
    gateExhaustionStreak,
    shippedToday,
    admission: admissionSummary,
    policyHoldPressure,
    queuePressure: queuePressureState,
    candidatePoolSize: pool.length,
    spawnCapacityBoost: spawnCapacityBoostSnapshot(),
    trit_shadow: tritProductivityState
  });
  const backlogAutoscaleState = backlogAutoscaleSnapshot(dateStr, {
    queuePressure: queuePressureState,
    budgetAutopause: loadSystemBudgetAutopauseState(),
    tritProductivity: tritProductivityState
  });
  const candidateAuditPolicy = {
    strategy_id: strategy ? strategy.id : null,
    strategy_selection: strategySelection
      ? {
        mode: strategySelection.mode || null,
        canary_enabled: strategySelection.canary_enabled === true,
        canary_due: strategySelection.canary_due === true,
        canary_every: Number.isFinite(Number(strategySelection.canary_every))
          ? Number(strategySelection.canary_every)
          : null,
        attempt_index: Number(strategySelection.attempt_index || 0),
        active_count: Number(strategySelection.active_count || 0),
        ranked: Array.isArray(strategySelection.ranked) ? strategySelection.ranked.slice(0, 5) : []
      }
      : null,
    execution_mode: executionMode,
    shadow_only: shadowOnly,
    directive_pulse_reservation_hard: AUTONOMY_DIRECTIVE_PULSE_RESERVATION_HARD,
    prefer_non_fallback_eligible: AUTONOMY_PREFER_NON_FALLBACK_ELIGIBLE,
    deprioritized_source_eyes: Array.from(AUTONOMY_DEPRIORITIZED_SOURCE_EYES),
    allowed_risks: Array.from(allowedRiskSet),
    base_thresholds: thresholds,
    min_composite_eligibility_base: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
    min_composite_eligibility_low_risk_canary: compositeEligibilityMin('low', executionMode),
    canary_low_risk_composite_relax: Math.max(0, Number(AUTONOMY_CANARY_LOW_RISK_COMPOSITE_RELAX || 0)),
    min_value_signal_score: AUTONOMY_MIN_VALUE_SIGNAL_SCORE,
    medium_risk_value_signal_bonus: AUTONOMY_MEDIUM_RISK_VALUE_SIGNAL_BONUS,
    lane_no_change_policy: {
      window_days: AUTONOMY_LANE_NO_CHANGE_WINDOW_DAYS,
      limit: AUTONOMY_LANE_NO_CHANGE_LIMIT,
      cooldown_hours: AUTONOMY_LANE_NO_CHANGE_COOLDOWN_HOURS
    },
    medium_risk_lane: mediumRiskThresholds(thresholds),
    medium_canary_daily_exec_limit: mediumCanaryDailyExecLimit,
    objective_binding: {
      required: AUTONOMY_OBJECTIVE_BINDING_REQUIRED,
      objective_allocation_rank_bonus: AUTONOMY_OBJECTIVE_ALLOCATION_RANK_BONUS
    },
    canary_executable_policy: {
      require_executable: AUTONOMY_CANARY_REQUIRE_EXECUTABLE,
      block_generic_route_task: AUTONOMY_CANARY_BLOCK_GENERIC_ROUTE_TASK
    },
    route_block_prefilter: {
      enabled: AUTONOMY_ROUTE_BLOCK_PREFILTER_ENABLED,
      window_hours: AUTONOMY_ROUTE_BLOCK_PREFILTER_WINDOW_HOURS,
      min_observations: AUTONOMY_ROUTE_BLOCK_PREFILTER_MIN_OBSERVATIONS,
      max_block_rate: AUTONOMY_ROUTE_BLOCK_PREFILTER_MAX_RATE,
      sample_events: 0
    },
    optimization_policy: {
      high_accuracy_mode: AUTONOMY_OPTIMIZATION_HIGH_ACCURACY_MODE,
      min_delta_percent: optimizationMinDeltaPercent(),
      min_delta_percent_default: AUTONOMY_OPTIMIZATION_MIN_DELTA_PERCENT,
      min_delta_percent_high_accuracy: AUTONOMY_OPTIMIZATION_MIN_DELTA_PERCENT_HIGH_ACCURACY,
      require_explicit_delta: AUTONOMY_OPTIMIZATION_REQUIRE_DELTA
    },
    budget_pacing: {
      enabled: AUTONOMY_BUDGET_PACING_ENABLED,
      min_remaining_ratio: AUTONOMY_BUDGET_PACING_MIN_REMAINING_RATIO,
      high_token_threshold: AUTONOMY_BUDGET_PACING_HIGH_TOKEN_THRESHOLD,
      min_value_signal_score: AUTONOMY_BUDGET_PACING_MIN_VALUE_SIGNAL,
      snapshot: budgetPacingState,
      execution_reserve: {
        enabled: AUTONOMY_BUDGET_EXECUTION_RESERVE_ENABLED,
        ratio: AUTONOMY_BUDGET_EXECUTION_RESERVE_RATIO,
        min_tokens: AUTONOMY_BUDGET_EXECUTION_RESERVE_MIN_TOKENS,
        min_value_signal_score: AUTONOMY_BUDGET_EXECUTION_RESERVE_MIN_VALUE_SIGNAL,
        floor_shipped_deficit: executionFloorShippedDeficit
      }
    },
    score_only_manual_gate_prefilter: {
      enabled: AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_ENABLED,
      window_hours: AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_WINDOW_HOURS,
      min_observations: AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_MIN_OBSERVATIONS,
      max_manual_block_rate: AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_MAX_RATE,
      sample_events: Number(manualGateTelemetry.sample_events || 0)
    },
    score_only_execution_floor: {
      enabled: AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_ENABLED,
      min_shipped_per_day: AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_MIN_SHIPPED_PER_DAY,
      max_per_day: AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_MAX_PER_DAY,
      max_tokens: AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_MAX_TOKENS,
      shipped_today: shippedToday,
      deficit: executionFloorShippedDeficit
    },
    campaign_scheduler: {
      enabled: Array.isArray(strategy && strategy.campaigns) && strategy.campaigns.length > 0
    },
    trit_shadow: {
      enabled: AUTONOMY_TRIT_SHADOW_ENABLED,
      bonus_blend: AUTONOMY_TRIT_SHADOW_BONUS_BLEND,
      top_k: AUTONOMY_TRIT_SHADOW_TOP_K,
      productivity: tritProductivityState
    },
    dynamic_execution_caps: dynamicCapsState,
    backlog_autoscale: {
      enabled: AUTONOMY_BACKLOG_AUTOSCALE_ENABLED,
      batch_on_run: AUTONOMY_BACKLOG_AUTOSCALE_BATCH_ON_RUN,
      snapshot: backlogAutoscaleState
    },
    queue_underflow_backfill: {
      enabled: AUTONOMY_QUEUE_UNDERFLOW_BACKFILL_MAX > 0,
      max_candidates: AUTONOMY_QUEUE_UNDERFLOW_BACKFILL_MAX
    },
    unknown_type_quarantine: {
      enabled: AUTONOMY_UNKNOWN_TYPE_QUARANTINE_ENABLED,
      proposal_types: Array.from(AUTONOMY_UNKNOWN_TYPE_QUARANTINE_TYPES),
      allow_tier1: AUTONOMY_UNKNOWN_TYPE_QUARANTINE_ALLOW_TIER1,
      allow_directive: AUTONOMY_UNKNOWN_TYPE_QUARANTINE_ALLOW_DIRECTIVE
    },
    qos_lanes: {
      enabled: AUTONOMY_QOS_LANES_ENABLED,
      backpressure_enabled: AUTONOMY_QOS_BACKPRESSURE_ENABLED,
      queue_pending_warn_ratio: AUTONOMY_QOS_QUEUE_PENDING_WARN_RATIO,
      queue_pending_critical_ratio: AUTONOMY_QOS_QUEUE_PENDING_CRITICAL_RATIO,
      queue_pending_warn_count: AUTONOMY_QOS_QUEUE_PENDING_WARN_COUNT,
      queue_pending_critical_count: AUTONOMY_QOS_QUEUE_PENDING_CRITICAL_COUNT,
      lane_weights_base: {
        critical: AUTONOMY_QOS_LANE_WEIGHT_CRITICAL,
        standard: AUTONOMY_QOS_LANE_WEIGHT_STANDARD,
        explore: AUTONOMY_QOS_LANE_WEIGHT_EXPLORE,
        quarantine: AUTONOMY_QOS_LANE_WEIGHT_QUARANTINE
      },
      lane_share_caps: {
        explore_max_share: AUTONOMY_QOS_EXPLORE_MAX_SHARE,
        quarantine_max_share: AUTONOMY_QOS_QUARANTINE_MAX_SHARE
      },
      pressure_snapshot: queuePressureState
    }
  };
  const candidateAuditPolicyHash = hashObj(candidateAuditPolicy);
  const pushCandidateAudit = (row) => {
    if (!row || typeof row !== 'object') return;
    if (candidateAuditRows.length < candidateAuditLimit) candidateAuditRows.push(row);
  };
  const writeCandidateAudit = (selectedProposalId = null, selectionMode = null, reservation = null, tritShadow = null) => {
    const tritShadowAudit = {
      ranking: tritShadow && typeof tritShadow === 'object' ? tritShadow : null,
      productivity: tritProductivityState
    };
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_candidate_audit',
      proposal_date: proposalDate,
      policy_hash: candidateAuditPolicyHash,
      policy: candidateAuditPolicy,
      pool_size: pool.length,
      eligible_count: eligible.length,
      rejected_count: Math.max(0, pool.length - eligible.length),
      rejected_by_gate: candidateRejectedByGate,
      skip_stats: skipStats,
      selected_proposal_id: selectedProposalId,
      selection_mode: selectionMode,
      tier_reservation: reservation || null,
      trit_shadow: tritShadowAudit,
      dynamic_execution_caps: dynamicCapsState,
      backlog_autoscale: backlogAutoscaleState,
      rows_truncated: pool.length > candidateAuditRows.length,
      rows: candidateAuditRows
    });
  };
  let tierReservation = null;
  let qosSelectionTelemetry = null;
  const routeBlockPrefilterTelemetry = (
    !shadowOnly
    && isExecuteMode(executionMode)
    && AUTONOMY_ROUTE_BLOCK_PREFILTER_ENABLED
  )
    ? summarizeRecentRouteBlockTelemetry(
      AUTONOMY_ROUTE_BLOCK_PREFILTER_WINDOW_HOURS,
      AUTONOMY_ROUTE_BLOCK_PREFILTER_MAX_EVENTS
    )
    : {
      window_hours: AUTONOMY_ROUTE_BLOCK_PREFILTER_WINDOW_HOURS,
      sample_events: 0,
      by_capability: {}
    };
  candidateAuditPolicy.route_block_prefilter.sample_events = Number(routeBlockPrefilterTelemetry.sample_events || 0);
  for (const cand of pool) {
    const proposalId = String(cand && cand.proposal && cand.proposal.id || '');
    const proposalType = String(cand && cand.proposal && cand.proposal.type || '');
    const typeThresholdPack = thresholdsForProposalType(thresholds, proposalType, fitnessPolicy);
    const gateThresholds = typeThresholdPack.thresholds;
    const risk = normalizedRisk(cand.proposal && cand.proposal.risk);
    const q = assessSignalQuality(cand.proposal, eyesMap, gateThresholds, calibrationProfile);
    if (!q.pass) {
      skipStats.low_quality += 1;
      bumpCount(candidateRejectedByGate, 'signal_quality');
      pushCandidateAudit({
        proposal_id: proposalId,
        proposal_type: proposalType,
        risk,
        pass: false,
        gate: 'signal_quality',
        score: Number(cand.score || 0),
        scores: {
          signal_quality: q.score,
          sensory_quality: q.sensory_quality_score,
          sensory_relevance: q.sensory_relevance_score
        },
        thresholds: {
          min_signal_quality: gateThresholds.min_signal_quality,
          min_sensory_signal_score: gateThresholds.min_sensory_signal_score,
          min_sensory_relevance_score: gateThresholds.min_sensory_relevance_score
        },
        type_threshold_offsets: typeThresholdPack.offsets,
        reasons: q.reasons.slice(0, 3)
      });
      if (!sampleLowQuality) {
        sampleLowQuality = {
          proposal_id: cand.proposal.id,
          score: q.score,
          reasons: q.reasons.slice(0, 3),
          eye_id: q.eye_id
        };
      }
      continue;
    }

    const dfit = assessDirectiveFit(cand.proposal, directiveProfile, gateThresholds);
    if (!dfit.pass) {
      skipStats.low_directive_fit += 1;
      bumpCount(candidateRejectedByGate, 'directive_fit');
      pushCandidateAudit({
        proposal_id: proposalId,
        proposal_type: proposalType,
        risk,
        pass: false,
        gate: 'directive_fit',
        score: Number(cand.score || 0),
        scores: { directive_fit: dfit.score },
        thresholds: { min_directive_fit: gateThresholds.min_directive_fit },
        type_threshold_offsets: typeThresholdPack.offsets,
        reasons: dfit.reasons.slice(0, 3)
      });
      if (!sampleLowDirectiveFit) {
        sampleLowDirectiveFit = {
          proposal_id: cand.proposal.id,
          score: dfit.score,
          reasons: dfit.reasons.slice(0, 3),
          positive: dfit.matched_positive.slice(0, 2),
          negative: dfit.matched_negative.slice(0, 2)
        };
      }
      continue;
    }

    const actionability = assessActionability(cand.proposal, dfit, gateThresholds);
    if (!actionability.pass) {
      skipStats.low_actionability += 1;
      bumpCount(candidateRejectedByGate, 'actionability');
      pushCandidateAudit({
        proposal_id: proposalId,
        proposal_type: proposalType,
        risk,
        pass: false,
        gate: 'actionability',
        score: Number(cand.score || 0),
        scores: {
          directive_fit: dfit.score,
          actionability: actionability.score
        },
        thresholds: {
          min_directive_fit: gateThresholds.min_directive_fit,
          min_actionability_score: gateThresholds.min_actionability_score
        },
        type_threshold_offsets: typeThresholdPack.offsets,
        reasons: actionability.reasons.slice(0, 3)
      });
      if (!sampleLowActionability) {
        sampleLowActionability = {
          proposal_id: cand.proposal.id,
          score: actionability.score,
          reasons: actionability.reasons.slice(0, 3)
        };
      }
      continue;
    }

    if (!shadowOnly && executionMode === 'canary_execute' && AUTONOMY_CANARY_REQUIRE_EXECUTABLE) {
      const executableBlocked = actionability.executable !== true;
      const genericBlocked = AUTONOMY_CANARY_BLOCK_GENERIC_ROUTE_TASK
        && actionability.generic_next_command_template === true;
      if (executableBlocked || genericBlocked) {
        skipStats.low_actionability += 1;
        bumpCount(candidateRejectedByGate, 'canary_executable');
        const reasons = [];
        if (executableBlocked) reasons.push('canary_requires_executable_action');
        if (genericBlocked) reasons.push('canary_disallows_generic_route_task');
        pushCandidateAudit({
          proposal_id: proposalId,
          proposal_type: proposalType,
          risk,
          pass: false,
          gate: 'canary_executable',
          score: Number(cand.score || 0),
          scores: {
            actionability: actionability.score
          },
          thresholds: {
            require_executable: AUTONOMY_CANARY_REQUIRE_EXECUTABLE,
            block_generic_route_task: AUTONOMY_CANARY_BLOCK_GENERIC_ROUTE_TASK
          },
          reasons
        });
        if (!sampleLowActionability) {
          sampleLowActionability = {
            proposal_id: cand.proposal.id,
            score: actionability.score,
            reasons: reasons.slice(0, 3)
          };
        }
        continue;
      }
    }

    const optimizationGate = assessOptimizationGoodEnough(cand.proposal, risk);
    if (!optimizationGate.pass) {
      skipStats.optimization_good_enough += 1;
      bumpCount(candidateRejectedByGate, 'optimization_good_enough');
      pushCandidateAudit({
        proposal_id: proposalId,
        proposal_type: proposalType,
        risk,
        pass: false,
        gate: 'optimization_good_enough',
        score: Number(cand.score || 0),
        scores: {
          optimization_delta_percent: optimizationGate.delta_percent
        },
        thresholds: {
          min_optimization_delta_percent: optimizationGate.min_delta_percent,
          require_explicit_delta: optimizationGate.require_delta === true
        },
        optimization: {
          intent: optimizationGate.applies === true,
          delta_source: optimizationGate.delta_source || null,
          mode: optimizationGate.mode || 'default'
        },
        reasons: [optimizationGate.reason || 'optimization_good_enough']
      });
      if (!sampleOptimizationGoodEnough) {
        sampleOptimizationGoodEnough = {
          proposal_id: cand.proposal.id,
          reason: optimizationGate.reason || 'optimization_good_enough',
          delta_percent: optimizationGate.delta_percent,
          min_delta_percent: optimizationGate.min_delta_percent,
          require_delta: optimizationGate.require_delta === true,
          delta_source: optimizationGate.delta_source || null,
          mode: optimizationGate.mode || 'default'
        };
      }
      continue;
    }

    const objectiveBinding = resolveObjectiveBinding(cand.proposal, directivePulseCtx);
    if (!objectiveBinding.pass) {
      skipStats.objective_binding += 1;
      bumpCount(candidateRejectedByGate, 'objective_binding');
      pushCandidateAudit({
        proposal_id: proposalId,
        proposal_type: proposalType,
        risk,
        pass: false,
        gate: 'objective_binding',
        score: Number(cand.score || 0),
        objective_binding: {
          required: objectiveBinding.required === true,
          objective_id: objectiveBinding.objective_id,
          source: objectiveBinding.source,
          objectives_available: objectiveBinding.objectives_available
        },
        reasons: Array.isArray(objectiveBinding.reasons) ? objectiveBinding.reasons.slice(0, 3) : []
      });
      if (!sampleObjectiveBinding) {
        sampleObjectiveBinding = {
          proposal_id: cand.proposal.id,
          objective_id: objectiveBinding.objective_id || null,
          source: objectiveBinding.source || null,
          required: objectiveBinding.required === true,
          objectives_available: objectiveBinding.objectives_available,
          reasons: Array.isArray(objectiveBinding.reasons) ? objectiveBinding.reasons.slice(0, 3) : []
        };
      }
      continue;
    }

    const optimizationLink = assessUnlinkedOptimizationAdmission(cand.proposal, objectiveBinding, risk);
    if (optimizationLink.block) {
      skipStats.objective_binding += 1;
      bumpCount(candidateRejectedByGate, 'objective_binding');
      pushCandidateAudit({
        proposal_id: proposalId,
        proposal_type: proposalType,
        risk,
        pass: false,
        gate: 'objective_binding',
        score: Number(cand.score || 0),
        objective_binding: {
          required: objectiveBinding.required === true,
          objective_id: objectiveBinding.objective_id || null,
          source: objectiveBinding.source || null,
          objectives_available: objectiveBinding.objectives_available
        },
        optimization_link: optimizationLink,
        reasons: [optimizationLink.reason || 'optimization_unlinked_objective_high_risk_block']
      });
      if (!sampleObjectiveBinding) {
        sampleObjectiveBinding = {
          proposal_id: cand.proposal.id,
          objective_id: objectiveBinding.objective_id || null,
          source: objectiveBinding.source || null,
          required: objectiveBinding.required === true,
          objectives_available: objectiveBinding.objectives_available,
          reasons: [optimizationLink.reason || 'optimization_unlinked_objective_high_risk_block']
        };
      }
      continue;
    }

    const valueSignal = assessValueSignal(cand.proposal, actionability, dfit);
    if (Number(optimizationLink.penalty || 0) > 0) {
      valueSignal.score = clampNumber(
        Math.round(Number(valueSignal.score || 0) - Number(optimizationLink.penalty || 0)),
        0,
        100
      );
      if (valueSignal.score < Number(valueSignal.min_score || 0)) valueSignal.pass = false;
      if (!Array.isArray(valueSignal.reasons)) valueSignal.reasons = [];
      valueSignal.reasons.push('optimization_unlinked_objective_penalty');
    }
    if (!valueSignal.pass) {
      skipStats.low_value_signal += 1;
      bumpCount(candidateRejectedByGate, 'value_signal');
      pushCandidateAudit({
        proposal_id: proposalId,
        proposal_type: proposalType,
        risk,
        pass: false,
        gate: 'value_signal',
        score: Number(cand.score || 0),
        scores: {
          value_signal: valueSignal.score,
          expected_value: valueSignal.components.expected_value,
          time_to_value: valueSignal.components.time_to_value,
          actionability: valueSignal.components.actionability,
          directive_fit: valueSignal.components.directive_fit
        },
        thresholds: {
          min_value_signal_score: valueSignal.min_score,
          min_value_signal_score_base: AUTONOMY_MIN_VALUE_SIGNAL_SCORE,
          medium_risk_value_signal_bonus: AUTONOMY_MEDIUM_RISK_VALUE_SIGNAL_BONUS
        },
        optimization_link: optimizationLink,
        reasons: valueSignal.reasons.slice(0, 3)
      });
      if (!sampleLowValueSignal) {
        sampleLowValueSignal = {
          proposal_id: cand.proposal.id,
          score: valueSignal.score,
          min_score: valueSignal.min_score,
          optimization_penalty: Number(optimizationLink.penalty || 0),
          reasons: valueSignal.reasons.slice(0, 3)
        };
      }
      continue;
    }

    if (!shadowOnly && AUTONOMY_BUDGET_PACING_ENABLED && !executionQuotaDeficit) {
      const budgetPacingGate = evaluateBudgetPacingGate(cand, valueSignal, risk, budgetPacingState, {
        execution_floor_deficit: executionFloorShippedDeficit
      });
      if (!budgetPacingGate.pass) {
        skipStats.budget_pacing += 1;
        bumpCount(candidateRejectedByGate, 'budget_pacing');
        pushCandidateAudit({
          proposal_id: proposalId,
          proposal_type: proposalType,
          risk,
          pass: false,
          gate: 'budget_pacing',
          score: Number(cand.score || 0),
          scores: {
            value_signal: Number(budgetPacingGate.value_signal_score || 0),
            est_tokens: Number(budgetPacingGate.est_tokens || 0)
          },
          budget_pacing: budgetPacingGate,
          reasons: [budgetPacingGate.reason || 'budget_pacing_blocked']
        });
        if (!sampleBudgetPacing) {
          sampleBudgetPacing = {
            proposal_id: cand.proposal.id,
            reason: budgetPacingGate.reason || 'budget_pacing_blocked',
            est_tokens: Number(budgetPacingGate.est_tokens || 0),
            value_signal_score: Number(budgetPacingGate.value_signal_score || 0),
            remaining_ratio: Number(budgetPacingGate.remaining_ratio || 0),
            autopause_active: budgetPacingGate.autopause_active === true
          };
        }
        continue;
      }
    }

    const capDescriptorCand = capabilityDescriptor(cand.proposal, parseActuationSpec(cand.proposal));
    const capKeyCand = String(capDescriptorCand && capDescriptorCand.key || '').toLowerCase();
    if (!shadowOnly && executionMode === 'score_only' && AUTONOMY_SCORE_ONLY_MANUAL_GATE_PREFILTER_ENABLED) {
      const manualGatePrefilter = evaluateManualGatePrefilter(manualGateTelemetry, capKeyCand);
      if (!manualGatePrefilter.pass && manualGatePrefilter.applicable) {
        skipStats.manual_gate_prefilter += 1;
        bumpCount(candidateRejectedByGate, 'manual_gate_prefilter');
        manualGateDeferredCandidates.push({
          ...cand,
          quality: q,
          directive_fit: dfit,
          actionability,
          value_signal: valueSignal,
          risk,
          capability_key: capKeyCand,
          objective_binding: objectiveBinding,
          optimization_link: optimizationLink,
          manual_gate_prefilter: manualGatePrefilter
        });
        pushCandidateAudit({
          proposal_id: proposalId,
          proposal_type: proposalType,
          risk,
          pass: false,
          gate: 'manual_gate_prefilter',
          score: Number(cand.score || 0),
          capability_key: capKeyCand,
          manual_gate_prefilter: manualGatePrefilter,
          reasons: [manualGatePrefilter.reason || 'manual_gate_rate_exceeded']
        });
        if (!sampleManualGatePrefilter) {
          sampleManualGatePrefilter = {
            proposal_id: cand.proposal.id,
            capability_key: capKeyCand,
            reason: manualGatePrefilter.reason || 'manual_gate_rate_exceeded',
            attempts: Number(manualGatePrefilter.attempts || 0),
            manual_blocked: Number(manualGatePrefilter.manual_blocked || 0),
            manual_block_rate: Number(manualGatePrefilter.manual_block_rate || 0)
          };
        }
        continue;
      }
    }

    if (!shadowOnly && capKeyCand && capabilityCooldownActive(capKeyCand)) {
      skipStats.capability_cooldown += 1;
      bumpCount(candidateRejectedByGate, 'capability_cooldown');
      pushCandidateAudit({
        proposal_id: proposalId,
        proposal_type: proposalType,
        risk,
        pass: false,
        gate: 'capability_cooldown',
        score: Number(cand.score || 0),
        capability_key: capKeyCand,
        reasons: ['capability_lane_cooldown_active']
      });
      if (!sampleCapabilityCooldown) {
        sampleCapabilityCooldown = {
          proposal_id: cand.proposal.id,
          capability_key: capKeyCand,
          reason: 'capability_lane_cooldown_active'
        };
      }
      continue;
    }

    const executeConfidenceCooldownKeyCand = executeConfidenceCooldownKey(
      capKeyCand,
      objectiveBinding.objective_id,
      proposalType
    );
    if (!shadowOnly && executeConfidenceCooldownKeyCand && cooldownActive(executeConfidenceCooldownKeyCand)) {
      skipStats.capability_cooldown += 1;
      bumpCount(candidateRejectedByGate, 'execute_confidence_cooldown');
      pushCandidateAudit({
        proposal_id: proposalId,
        proposal_type: proposalType,
        risk,
        pass: false,
        gate: 'execute_confidence_cooldown',
        score: Number(cand.score || 0),
        capability_key: capKeyCand || null,
        execute_confidence_cooldown_key: executeConfidenceCooldownKeyCand,
        reasons: ['execute_confidence_lane_cooldown_active']
      });
      if (!sampleCapabilityCooldown) {
        sampleCapabilityCooldown = {
          proposal_id: cand.proposal.id,
          capability_key: capKeyCand || null,
          reason: 'execute_confidence_lane_cooldown_active',
          execute_confidence_cooldown_key: executeConfidenceCooldownKeyCand
        };
      }
      continue;
    }

    if (!shadowOnly && isExecuteMode(executionMode) && capKeyCand) {
      const routePrefilter = evaluateRouteBlockPrefilter(routeBlockPrefilterTelemetry, capKeyCand);
      if (!routePrefilter.pass && routePrefilter.applicable) {
        skipStats.capability_cooldown += 1;
        bumpCount(candidateRejectedByGate, 'route_block_prefilter');
        pushCandidateAudit({
          proposal_id: proposalId,
          proposal_type: proposalType,
          risk,
          pass: false,
          gate: 'route_block_prefilter',
          score: Number(cand.score || 0),
          capability_key: capKeyCand,
          route_block_prefilter: {
            window_hours: routePrefilter.window_hours,
            min_observations: routePrefilter.min_observations,
            max_block_rate: routePrefilter.max_block_rate,
            attempts: routePrefilter.attempts,
            route_blocked: routePrefilter.route_blocked,
            route_block_rate: routePrefilter.route_block_rate
          },
          reasons: [routePrefilter.reason || 'route_block_rate_exceeded']
        });
        if (!sampleCapabilityCooldown) {
          sampleCapabilityCooldown = {
            proposal_id: cand.proposal.id,
            capability_key: capKeyCand,
            reason: routePrefilter.reason || 'route_block_rate_exceeded',
            attempts: routePrefilter.attempts,
            route_blocked: routePrefilter.route_blocked,
            route_block_rate: routePrefilter.route_block_rate
          };
        }
        continue;
      }
    }

    const compositeScoreRaw = compositeEligibilityScore(q.score, dfit.score, actionability.score);
    const compositeScore = clampNumber(
      Math.round(Number(compositeScoreRaw || 0) - Number(optimizationLink.penalty || 0)),
      0,
      100
    );
    const compositeMin = compositeEligibilityMin(risk, executionMode);
    if (compositeScore < compositeMin) {
      skipStats.low_composite += 1;
      bumpCount(candidateRejectedByGate, 'composite');
      pushCandidateAudit({
        proposal_id: proposalId,
        proposal_type: proposalType,
        risk,
        pass: false,
        gate: 'composite',
        score: Number(cand.score || 0),
        scores: {
          signal_quality: q.score,
          directive_fit: dfit.score,
          actionability: actionability.score,
          composite: compositeScore
        },
        thresholds: {
          min_composite_eligibility: compositeMin,
          min_composite_eligibility_base: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY
        },
        optimization_link: optimizationLink,
        reasons: ['composite_below_threshold']
      });
      if (!sampleLowComposite) {
        sampleLowComposite = {
          proposal_id: cand.proposal.id,
          score: compositeScore,
          raw_score: compositeScoreRaw,
          optimization_penalty: Number(optimizationLink.penalty || 0),
          min_score: compositeMin,
          base_min_score: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
          quality_score: q.score,
          directive_fit_score: dfit.score,
          actionability_score: actionability.score
        };
      }
      continue;
    }

    let executeConfidencePolicyCand = null;
    if (!shadowOnly && isExecuteMode(executionMode)) {
      executeConfidencePolicyCand = computeExecuteConfidencePolicy(
        dateStr,
        cand.proposal,
        capKeyCand,
        risk,
        executionMode
      );
      const executeCompositeMargin = Math.max(
        0,
        Number(
          executeConfidencePolicyCand
          && executeConfidencePolicyCand.applied
          && executeConfidencePolicyCand.applied.composite_margin
          || AUTONOMY_EXECUTE_CONFIDENCE_MARGIN
        )
      );
      const executeValueMargin = Math.max(
        0,
        Number(
          executeConfidencePolicyCand
          && executeConfidencePolicyCand.applied
          && executeConfidencePolicyCand.applied.value_margin
          || AUTONOMY_EXECUTE_MIN_VALUE_SIGNAL_BONUS
        )
      );
      const executeCompositeMin = Math.max(0, Number(compositeMin || 0) + executeCompositeMargin);
      const executeValueMin = Math.max(
        0,
        Number(AUTONOMY_MIN_VALUE_SIGNAL_SCORE || 0)
          + executeValueMargin
          + (risk === 'medium' ? Number(AUTONOMY_MEDIUM_RISK_VALUE_SIGNAL_BONUS || 0) : 0)
      );
      const executeCompositeScore = Number(compositeScore || 0);
      const executeValueScore = Number(valueSignal.score || 0);
      if (executeCompositeScore < executeCompositeMin || executeValueScore < executeValueMin) {
        skipStats.low_value_signal += 1;
        bumpCount(candidateRejectedByGate, 'execute_confidence_precheck');
        const confidenceReasons = [];
        if (executeCompositeScore < executeCompositeMin) confidenceReasons.push('composite_below_execute_confidence_min');
        if (executeValueScore < executeValueMin) confidenceReasons.push('value_signal_below_execute_confidence_min');
        pushCandidateAudit({
          proposal_id: proposalId,
          proposal_type: proposalType,
          risk,
          pass: false,
          gate: 'execute_confidence_precheck',
          score: Number(cand.score || 0),
          scores: {
            composite: executeCompositeScore,
            value_signal: executeValueScore
          },
          thresholds: {
            min_composite: executeCompositeMin,
            min_value_signal: executeValueMin,
            composite_margin: executeCompositeMargin,
            value_margin: executeValueMargin
          },
          reasons: confidenceReasons,
          execute_confidence_policy: executeConfidencePolicyCand
        });
        if (!sampleLowValueSignal) {
          sampleLowValueSignal = {
            proposal_id: cand.proposal.id,
            score: executeValueScore,
            min_score: executeValueMin,
            composite_score: executeCompositeScore,
            composite_min_score: executeCompositeMin,
            reasons: confidenceReasons
          };
        }
        continue;
      }
    }

    const mediumGate = mediumRiskGateDecision(cand.proposal, dfit.score, actionability.score, compositeScore, gateThresholds);
    if (!mediumGate.pass) {
      skipStats.medium_risk_guard += 1;
      bumpCount(candidateRejectedByGate, 'medium_risk_guard');
      pushCandidateAudit({
        proposal_id: proposalId,
        proposal_type: proposalType,
        risk,
        pass: false,
        gate: 'medium_risk_guard',
        score: Number(cand.score || 0),
        scores: {
          composite: compositeScore,
          directive_fit: dfit.score,
          actionability: actionability.score
        },
        thresholds: mediumGate.required || null,
        type_threshold_offsets: typeThresholdPack.offsets,
        reasons: mediumGate.reasons.slice(0, 3)
      });
      if (!sampleMediumRiskGuard) {
        sampleMediumRiskGuard = {
          proposal_id: cand.proposal.id,
          risk,
          reasons: mediumGate.reasons.slice(0, 3),
          required: mediumGate.required || null,
          scores: {
            composite: compositeScore,
            directive_fit: dfit.score,
            actionability: actionability.score
          }
        };
      }
      continue;
    }

    if (!shadowOnly && risk === 'medium' && executionMode !== 'canary_execute') {
      skipStats.medium_policy_blocked += 1;
      bumpCount(candidateRejectedByGate, 'medium_requires_canary');
      pushCandidateAudit({
        proposal_id: proposalId,
        proposal_type: proposalType,
        risk,
        pass: false,
        gate: 'medium_requires_canary',
        score: Number(cand.score || 0),
        reasons: ['medium_requires_canary_execute']
      });
      if (!sampleMediumPolicyBlocked) {
        sampleMediumPolicyBlocked = {
          proposal_id: cand.proposal.id,
          risk,
          reason: 'medium_requires_canary_execute'
        };
      }
      continue;
    }

    if (
      !shadowOnly
      && risk === 'medium'
      && executionMode === 'canary_execute'
      && mediumCanaryDailyExecLimit > 0
      && mediumExecutedToday >= mediumCanaryDailyExecLimit
    ) {
      skipStats.medium_daily_cap += 1;
      bumpCount(candidateRejectedByGate, 'medium_daily_cap');
      pushCandidateAudit({
        proposal_id: proposalId,
        proposal_type: proposalType,
        risk,
        pass: false,
        gate: 'medium_daily_cap',
        score: Number(cand.score || 0),
        reasons: ['medium_canary_daily_exec_cap_reached'],
        context: {
          executed_today: mediumExecutedToday,
          medium_canary_daily_exec_limit: mediumCanaryDailyExecLimit
        }
      });
      if (!sampleMediumDailyCap) {
        sampleMediumDailyCap = {
          proposal_id: cand.proposal.id,
          risk,
          executed_today: mediumExecutedToday,
          medium_canary_daily_exec_limit: mediumCanaryDailyExecLimit
        };
      }
      continue;
    }

    const eyeRefCand = sourceEyeRef(cand.proposal);
    const eyeNoProgress24h = countEyeOutcomesInLastHours(decisionEvents, eyeRefCand, 'no_change', 24);
    if (AUTONOMY_MAX_EYE_NO_PROGRESS_24H > 0 && eyeNoProgress24h >= AUTONOMY_MAX_EYE_NO_PROGRESS_24H) {
      skipStats.eye_no_progress += 1;
      bumpCount(candidateRejectedByGate, 'eye_no_progress');
      pushCandidateAudit({
        proposal_id: proposalId,
        proposal_type: proposalType,
        risk,
        pass: false,
        gate: 'eye_no_progress',
        score: Number(cand.score || 0),
        reasons: ['eye_no_progress_24h_cap_reached'],
        context: {
          eye_no_progress_24h: eyeNoProgress24h,
          max_eye_no_progress_24h: AUTONOMY_MAX_EYE_NO_PROGRESS_24H
        }
      });
      continue;
    }

    const pulse = assessDirectivePulse(
      cand.proposal,
      dfit.score,
      compositeScore,
      cand.overlay,
      directivePulseCtx,
      objectiveBinding.objective_id
    );
    if (!pulse.pass) {
      skipStats.directive_pulse_cooldown += 1;
      bumpCount(candidateRejectedByGate, 'directive_pulse');
      pushCandidateAudit({
        proposal_id: proposalId,
        proposal_type: proposalType,
        risk,
        pass: false,
        gate: 'directive_pulse',
        score: Number(cand.score || 0),
        reasons: Array.isArray(pulse.reasons) ? pulse.reasons.slice(0, 3) : []
      });
      if (!sampleDirectivePulseCooldown) {
        sampleDirectivePulseCooldown = {
          proposal_id: cand.proposal.id,
          objective_id: pulse.objective_id || null,
          tier: pulse.tier == null ? null : pulse.tier,
          reasons: Array.isArray(pulse.reasons) ? pulse.reasons.slice(0, 3) : []
        };
      }
      continue;
    }

    if (
      objectiveBinding.required === true
      && objectiveBinding.objective_id
      && pulse.objective_id
      && String(objectiveBinding.objective_id) !== String(pulse.objective_id)
    ) {
      skipStats.objective_binding += 1;
      bumpCount(candidateRejectedByGate, 'objective_binding');
      pushCandidateAudit({
        proposal_id: proposalId,
        proposal_type: proposalType,
        risk,
        pass: false,
        gate: 'objective_binding',
        score: Number(cand.score || 0),
        objective_binding: {
          required: true,
          objective_id: objectiveBinding.objective_id,
          source: objectiveBinding.source
        },
        directive_pulse: {
          objective_id: pulse.objective_id || null,
          tier: pulse.tier == null ? null : pulse.tier
        },
        reasons: ['objective_binding_mismatch']
      });
      if (!sampleObjectiveBinding) {
        sampleObjectiveBinding = {
          proposal_id: cand.proposal.id,
          objective_id: objectiveBinding.objective_id || null,
          source: objectiveBinding.source || null,
          required: true,
          objectives_available: objectiveBinding.objectives_available,
          reasons: ['objective_binding_mismatch']
        };
      }
      continue;
    }

    const unknownTypeQuarantine = proposalUnknownTypeQuarantineDecision(cand.proposal, objectiveBinding);
    if (unknownTypeQuarantine.block) {
      skipStats.unknown_type_quarantine += 1;
      bumpCount(candidateRejectedByGate, 'unknown_type_quarantine');
      pushCandidateAudit({
        proposal_id: proposalId,
        proposal_type: proposalType,
        risk,
        pass: false,
        gate: 'unknown_type_quarantine',
        score: Number(cand.score || 0),
        objective_binding: {
          required: objectiveBinding.required === true,
          objective_id: objectiveBinding.objective_id || null,
          source: objectiveBinding.source || null
        },
        reasons: [unknownTypeQuarantine.reason || 'unknown_type_quarantine']
      });
      if (!sampleUnknownTypeQuarantine) {
        sampleUnknownTypeQuarantine = {
          proposal_id: cand.proposal.id,
          proposal_type: unknownTypeQuarantine.proposal_type || null,
          objective_id: unknownTypeQuarantine.objective_id || null,
          reason: unknownTypeQuarantine.reason || 'unknown_type_quarantine'
        };
      }
      continue;
    }

    const qosLane = qosLaneFromCandidate({
      ...cand,
      risk,
      directive_pulse: pulse
    });
    eligible.push({
      ...cand,
      quality: q,
      directive_fit: dfit,
      actionability,
      value_signal: valueSignal,
      composite_score: compositeScore,
      composite_min_score: compositeMin,
      risk,
      capability_key: capKeyCand,
      eye_no_progress_24h: eyeNoProgress24h,
      objective_binding: objectiveBinding,
      optimization_link: optimizationLink,
      execute_confidence_policy: executeConfidencePolicyCand,
      directive_pulse: pulse,
      qos_lane: qosLane
    });
    pushCandidateAudit({
      proposal_id: proposalId,
      proposal_type: proposalType,
      risk,
      queue_underflow_backfill: cand.queue_underflow_backfill === true,
      qos_lane: qosLane,
      pass: true,
      gate: 'eligible',
      score: Number(cand.score || 0),
      scores: {
        signal_quality: q.score,
        directive_fit: dfit.score,
        actionability: actionability.score,
        value_signal: valueSignal.score,
        composite: compositeScore
      },
      thresholds: {
        min_signal_quality: gateThresholds.min_signal_quality,
        min_directive_fit: gateThresholds.min_directive_fit,
        min_actionability_score: gateThresholds.min_actionability_score,
        min_value_signal_score: valueSignal.min_score,
        min_composite_eligibility: compositeMin,
        min_composite_eligibility_base: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY
      },
      type_threshold_offsets: typeThresholdPack.offsets,
      directive_pulse: {
        score: pulse.score,
        objective_id: pulse.objective_id || null,
        tier: pulse.tier == null ? null : pulse.tier,
        objective_allocation_score: Number(pulse.objective_allocation_score || 0)
      },
      objective_binding: {
        required: objectiveBinding.required === true,
        objective_id: objectiveBinding.objective_id || null,
        source: objectiveBinding.source || null
      }
    });
  }

  if (eligible.length === 0 && manualGateDeferredCandidates.length > 0) {
    manualGateDeferredCandidates.sort((a, b) => {
      const sa = Number(a && a.score || 0);
      const sb = Number(b && b.score || 0);
      if (sb !== sa) return sb - sa;
      return String(a && a.proposal && a.proposal.id || '').localeCompare(String(b && b.proposal && b.proposal.id || ''));
    });
    const revived = manualGateDeferredCandidates[0];
    if (revived) {
      eligible.push({
        ...revived,
        manual_gate_prefilter_bypass: true
      });
      pushCandidateAudit({
        proposal_id: String(revived && revived.proposal && revived.proposal.id || ''),
        proposal_type: String(revived && revived.proposal && revived.proposal.type || ''),
        risk: String(revived && revived.risk || normalizedRisk(revived && revived.proposal && revived.proposal.risk)),
        pass: true,
        gate: 'manual_gate_prefilter_fallback',
        score: Number(revived && revived.score || 0),
        reasons: ['manual_gate_prefilter_all_candidates_filtered']
      });
    }
  }

  tierReservation = directiveTierReservationNeed(eligible, directivePulseCtx);
  if (tierReservation && Number(tierReservation.candidate_count || 0) === 0) {
    if (AUTONOMY_DIRECTIVE_PULSE_RESERVATION_HARD) {
      writeCandidateAudit(null, null, tierReservation);
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_repeat_gate_directive_pulse_tier_reservation',
        ...globalHoldObjectiveContext,
        reserved_tier: tierReservation.tier,
        current_tier_attempts: tierReservation.current_tier_attempts,
        required_after_next: tierReservation.required_after_next,
        attempts_today: tierReservation.attempts_today,
        min_share: tierReservation.min_share
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_repeat_gate_directive_pulse_tier_reservation',
        ...globalHoldObjectiveContext,
        reserved_tier: tierReservation.tier,
        current_tier_attempts: tierReservation.current_tier_attempts,
        required_after_next: tierReservation.required_after_next,
        attempts_today: tierReservation.attempts_today,
        min_share: tierReservation.min_share,
        ts: nowIso()
      }) + '\n');
      return;
    }
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_directive_pulse',
      result: 'reservation_soft_miss',
      reserved_tier: tierReservation.tier,
      current_tier_attempts: tierReservation.current_tier_attempts,
      required_after_next: tierReservation.required_after_next,
      attempts_today: tierReservation.attempts_today,
      min_share: tierReservation.min_share
    });
    tierReservation = null;
  }

  if (eligible.length > 0) {
    for (const cand of eligible) {
      cand.strategy_rank = strategyRankForCandidate(cand, strategy, { priorRuns });
      const adjusted = strategyRankAdjustedForCandidate(cand, executionMode);
      cand.strategy_rank_adjusted = adjusted.adjusted;
      cand.strategy_rank_bonus = adjusted.bonus;
      cand.strategy_trit_shadow = strategyTritShadowForCandidate(cand);
      cand.strategy_trit_shadow_adjusted = Number(
        cand.strategy_trit_shadow && cand.strategy_trit_shadow.adjusted_score != null
          ? cand.strategy_trit_shadow.adjusted_score
          : 0
      );
    }
    campaignPlan = annotateCampaignPriority(eligible, strategy);
    eligible.sort((a, b) => {
      const aCampaignBucket = Number(a && a.campaign_sort_bucket || 0);
      const bCampaignBucket = Number(b && b.campaign_sort_bucket || 0);
      if (bCampaignBucket !== aCampaignBucket) return bCampaignBucket - aCampaignBucket;
      const aCampaignScore = Number(a && a.campaign_sort_score || 0);
      const bCampaignScore = Number(b && b.campaign_sort_score || 0);
      if (bCampaignScore !== aCampaignScore) return bCampaignScore - aCampaignScore;
      const aCampaignPriority = Number(a && a.campaign_match && a.campaign_match.campaign_priority != null ? a.campaign_match.campaign_priority : 999);
      const bCampaignPriority = Number(b && b.campaign_match && b.campaign_match.campaign_priority != null ? b.campaign_match.campaign_priority : 999);
      if (aCampaignPriority !== bCampaignPriority) return aCampaignPriority - bCampaignPriority;
      const aPhaseOrder = Number(a && a.campaign_match && a.campaign_match.phase_order != null ? a.campaign_match.phase_order : 999);
      const bPhaseOrder = Number(b && b.campaign_match && b.campaign_match.phase_order != null ? b.campaign_match.phase_order : 999);
      if (aPhaseOrder !== bPhaseOrder) return aPhaseOrder - bPhaseOrder;
      const sa = Number(a.strategy_rank_adjusted != null ? a.strategy_rank_adjusted : (a.strategy_rank && a.strategy_rank.score || 0));
      const sb = Number(b.strategy_rank_adjusted != null ? b.strategy_rank_adjusted : (b.strategy_rank && b.strategy_rank.score || 0));
      if (sb !== sa) return sb - sa;
      if (b.score !== a.score) return b.score - a.score;
      return String(a.proposal.id).localeCompare(String(b.proposal.id));
    });
    const nonFallbackEligible = eligible.filter(c => !isDeprioritizedSourceProposal(c && c.proposal));
    if (
      !tierReservation
      && AUTONOMY_PREFER_NON_FALLBACK_ELIGIBLE
      && nonFallbackEligible.length > 0
      && nonFallbackEligible.length < eligible.length
      && isDeprioritizedSourceProposal(eligible[0] && eligible[0].proposal)
    ) {
      const laneSelection = shadowOnly
        ? chooseEvidenceSelectionMode(nonFallbackEligible, priorRuns, 'source_diversity')
        : chooseSelectionMode(nonFallbackEligible, priorRuns);
      const lanePick = nonFallbackEligible[laneSelection.index] || nonFallbackEligible[0];
      const fullIdx = eligible.findIndex(c => String(c && c.proposal && c.proposal.id || '') === String(lanePick && lanePick.proposal && lanePick.proposal.id || ''));
      pick = lanePick;
      selection = {
        ...laneSelection,
        mode: shadowOnly
          ? laneSelection.mode
          : (laneSelection.mode === 'explore' ? 'source_diversity_explore' : 'source_diversity_exploit'),
        index: fullIdx >= 0 ? fullIdx : 0
      };
    } else if (!tierReservation && AUTONOMY_QOS_LANES_ENABLED) {
      const qosSelection = chooseQosLaneSelection(eligible, priorRuns, {
        shadowOnly,
        queuePressure: queuePressureState
      });
      if (qosSelection && qosSelection.pick) {
        pick = qosSelection.pick;
        selection = qosSelection.selection;
        qosSelectionTelemetry = qosSelection.telemetry;
      }
    } else if (tierReservation && Number(tierReservation.candidate_count || 0) > 0) {
      const reservedTier = Number(tierReservation.tier);
      const reservedIdx = eligible.findIndex(c => normalizeDirectiveTier(c && c.directive_pulse && c.directive_pulse.tier, 99) === reservedTier);
      const idx = reservedIdx >= 0 ? reservedIdx : 0;
      pick = eligible[idx] || eligible[0];
      selection = {
        mode: 'directive_reservation',
        index: idx,
        explore_used: 0,
        explore_quota: 0,
        exploit_used: 0,
        reserved_tier: reservedTier,
        reservation: tierReservation
      };
    } else {
      selection = shadowOnly
        ? chooseEvidenceSelectionMode(eligible, priorRuns, 'evidence')
        : chooseSelectionMode(eligible, priorRuns);
      pick = eligible[selection.index] || eligible[0];
    }
    if (pick && pick.queue_underflow_backfill === true) {
      selection = {
        ...selection,
        mode: `queue_underflow_${String(selection && selection.mode || 'exploit')}`
      };
    }
    if (qosSelectionTelemetry && qosSelectionTelemetry.backpressure_applied) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_qos_backpressure',
        result: 'active',
        pressure: qosSelectionTelemetry.pressure || null,
        blocked_lanes: Array.isArray(qosSelectionTelemetry.blocked_lanes)
          ? qosSelectionTelemetry.blocked_lanes.slice(0, 8)
          : [],
        selected_lane: qosSelectionTelemetry.selected_lane || null,
        lane_counts: qosSelectionTelemetry.lane_counts || {},
        lane_usage: qosSelectionTelemetry.lane_usage || {},
        queue: qosSelectionTelemetry.queue || {}
      });
    }
  }

  if (!pick && shadowOnly && pool.length > 0) {
    const fallback = pool[0];
    const fallbackType = String(fallback && fallback.proposal && fallback.proposal.type || '');
    const fallbackThresholdPack = thresholdsForProposalType(thresholds, fallbackType, fitnessPolicy);
    const fallbackThresholds = fallbackThresholdPack.thresholds;
    const fallbackRisk = normalizedRisk(fallback.proposal && fallback.proposal.risk);
    const fallbackObjectiveBinding = resolveObjectiveBinding(fallback.proposal, directivePulseCtx);
    const q = assessSignalQuality(fallback.proposal, eyesMap, fallbackThresholds, calibrationProfile);
    const dfit = assessDirectiveFit(fallback.proposal, directiveProfile, fallbackThresholds);
    const actionability = assessActionability(fallback.proposal, dfit, fallbackThresholds);
    const valueSignal = assessValueSignal(fallback.proposal, actionability, dfit);
    const compositeScore = compositeEligibilityScore(q.score, dfit.score, actionability.score);
    const compositeMin = compositeEligibilityMin(fallbackRisk, executionMode);
    const pulse = assessDirectivePulse(
      fallback.proposal,
      dfit.score,
      compositeScore,
      fallback.overlay,
      directivePulseCtx,
      fallbackObjectiveBinding.objective_id
    );
    const fallbackCapKey = String(capabilityDescriptor(fallback.proposal, parseActuationSpec(fallback.proposal)).key || '').toLowerCase();
    const fallbackStrategyRank = strategyRankForCandidate({
      ...fallback,
      quality: q,
      directive_fit: dfit,
      actionability,
      composite_score: compositeScore,
      composite_min_score: compositeMin,
      risk: fallbackRisk
    }, strategy, { priorRuns });
    const fallbackAdjusted = strategyRankAdjustedForCandidate({
      ...fallback,
      directive_pulse: pulse,
      strategy_rank: fallbackStrategyRank
    }, executionMode);
    const fallbackTritShadow = strategyTritShadowForCandidate({
      ...fallback,
      quality: q,
      directive_fit: dfit,
      actionability,
      value_signal: valueSignal,
      composite_score: compositeScore,
      composite_min_score: compositeMin,
      risk: fallbackRisk,
      objective_binding: fallbackObjectiveBinding,
      strategy_rank: fallbackStrategyRank,
      strategy_rank_bonus: fallbackAdjusted.bonus
    });
    pick = {
      ...fallback,
      quality: q,
      directive_fit: dfit,
      actionability,
      value_signal: valueSignal,
      composite_score: compositeScore,
      composite_min_score: compositeMin,
      risk: fallbackRisk,
      capability_key: fallbackCapKey,
      eye_no_progress_24h: countEyeOutcomesInLastHours(decisionEvents, sourceEyeRef(fallback.proposal), 'no_change', 24),
      objective_binding: fallbackObjectiveBinding,
      directive_pulse: pulse,
      type_threshold_offsets: fallbackThresholdPack.offsets,
      type_thresholds_applied: fallbackThresholds,
      strategy_rank: fallbackStrategyRank,
      strategy_rank_adjusted: fallbackAdjusted.adjusted,
      strategy_rank_bonus: fallbackAdjusted.bonus,
      strategy_trit_shadow: fallbackTritShadow,
      strategy_trit_shadow_adjusted: Number(
        fallbackTritShadow && fallbackTritShadow.adjusted_score != null
          ? fallbackTritShadow.adjusted_score
          : 0
      )
    };
    selection = {
      mode: 'shadow_fallback',
      index: 0,
      explore_used: 0,
      explore_quota: 0,
      exploit_used: 0
    };
  }

  const tritShadowSelection = strategyTritShadowRankingSummary(
    eligible,
    pick && pick.proposal ? String(pick.proposal.id || '') : null,
    selection ? selection.mode : null
  );
  if (tritShadowSelection && tritShadowSelection.enabled) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_trit_shadow_ranking',
      result: tritShadowSelection.diverged_from_legacy_top ? 'diverged' : 'matched',
      selection_mode: tritShadowSelection.selection_mode || null,
      considered: Number(tritShadowSelection.considered || 0),
      selected_proposal_id: tritShadowSelection.selected_proposal_id || null,
      legacy_top_proposal_id: tritShadowSelection.legacy_top_proposal_id || null,
      trit_top_proposal_id: tritShadowSelection.trit_top_proposal_id || null,
      diverged_from_legacy_top: tritShadowSelection.diverged_from_legacy_top === true,
      diverged_from_selected: tritShadowSelection.diverged_from_selected === true,
      top: Array.isArray(tritShadowSelection.top) ? tritShadowSelection.top.slice(0, AUTONOMY_TRIT_SHADOW_TOP_K) : []
    });
  }

  writeCandidateAudit(
    pick && pick.proposal ? String(pick.proposal.id || '') : null,
    selection ? selection.mode : null,
    tierReservation && Number(tierReservation.candidate_count || 0) > 0 ? tierReservation : null,
    tritShadowSelection
  );

  if (!pick) {
    if (
      skipStats.unknown_type_quarantine > 0
      && skipStats.eye_no_progress === 0
      && skipStats.low_quality === 0
      && skipStats.low_directive_fit === 0
      && skipStats.low_actionability === 0
      && skipStats.optimization_good_enough === 0
      && skipStats.objective_binding === 0
      && skipStats.low_value_signal === 0
      && skipStats.budget_pacing === 0
      && skipStats.low_composite === 0
      && skipStats.capability_cooldown === 0
      && skipStats.medium_risk_guard === 0
      && skipStats.medium_policy_blocked === 0
      && skipStats.medium_daily_cap === 0
      && skipStats.directive_pulse_cooldown === 0
    ) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_init_gate_unknown_type_quarantine',
        skipped_unknown_type_quarantine: skipStats.unknown_type_quarantine,
        sample_unknown_type_quarantine: sampleUnknownTypeQuarantine
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_init_gate_unknown_type_quarantine',
        skipped_unknown_type_quarantine: skipStats.unknown_type_quarantine,
        sample_unknown_type_quarantine: sampleUnknownTypeQuarantine,
        ts: nowIso()
      }) + '\n');
      return;
    }

    if (
      skipStats.medium_daily_cap > 0
      && skipStats.eye_no_progress === 0
      && skipStats.low_quality === 0
      && skipStats.low_directive_fit === 0
      && skipStats.low_actionability === 0
      && skipStats.optimization_good_enough === 0
      && skipStats.low_value_signal === 0
      && skipStats.low_composite === 0
      && skipStats.capability_cooldown === 0
      && skipStats.medium_risk_guard === 0
      && skipStats.medium_policy_blocked === 0
      && skipStats.directive_pulse_cooldown === 0
      && skipStats.objective_binding === 0
    ) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_repeat_gate_medium_canary_cap',
        medium_executed_today: mediumExecutedToday,
        medium_canary_daily_exec_limit: mediumCanaryDailyExecLimit,
        skipped_medium_daily_cap: skipStats.medium_daily_cap,
        sample_medium_daily_cap: sampleMediumDailyCap
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_repeat_gate_medium_canary_cap',
        medium_executed_today: mediumExecutedToday,
        medium_canary_daily_exec_limit: mediumCanaryDailyExecLimit,
        skipped_medium_daily_cap: skipStats.medium_daily_cap,
        sample_medium_daily_cap: sampleMediumDailyCap,
        ts: nowIso()
      }) + '\n');
      return;
    }

    if (
      skipStats.medium_policy_blocked > 0
      && skipStats.eye_no_progress === 0
      && skipStats.low_quality === 0
      && skipStats.low_directive_fit === 0
      && skipStats.low_actionability === 0
      && skipStats.optimization_good_enough === 0
      && skipStats.low_value_signal === 0
      && skipStats.low_composite === 0
      && skipStats.capability_cooldown === 0
      && skipStats.medium_risk_guard === 0
      && skipStats.medium_daily_cap === 0
      && skipStats.directive_pulse_cooldown === 0
      && skipStats.objective_binding === 0
    ) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_init_gate_medium_requires_canary',
        execution_mode: executionMode,
        skipped_medium_policy_blocked: skipStats.medium_policy_blocked,
        sample_medium_policy_blocked: sampleMediumPolicyBlocked
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_init_gate_medium_requires_canary',
        execution_mode: executionMode,
        skipped_medium_policy_blocked: skipStats.medium_policy_blocked,
        sample_medium_policy_blocked: sampleMediumPolicyBlocked,
        ts: nowIso()
      }) + '\n');
      return;
    }

    if (
      skipStats.medium_risk_guard > 0
      && skipStats.eye_no_progress === 0
      && skipStats.low_quality === 0
      && skipStats.low_directive_fit === 0
      && skipStats.low_actionability === 0
      && skipStats.optimization_good_enough === 0
      && skipStats.low_value_signal === 0
      && skipStats.low_composite === 0
      && skipStats.capability_cooldown === 0
      && skipStats.medium_policy_blocked === 0
      && skipStats.medium_daily_cap === 0
      && skipStats.directive_pulse_cooldown === 0
      && skipStats.objective_binding === 0
    ) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_init_gate_medium_risk_guard',
        skipped_medium_risk_guard: skipStats.medium_risk_guard,
        sample_medium_risk_guard: sampleMediumRiskGuard
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_init_gate_medium_risk_guard',
        skipped_medium_risk_guard: skipStats.medium_risk_guard,
        sample_medium_risk_guard: sampleMediumRiskGuard,
        ts: nowIso()
      }) + '\n');
      return;
    }

    if (
      skipStats.directive_pulse_cooldown > 0
      && skipStats.eye_no_progress === 0
      && skipStats.low_quality === 0
      && skipStats.low_directive_fit === 0
      && skipStats.low_actionability === 0
      && skipStats.optimization_good_enough === 0
      && skipStats.low_value_signal === 0
      && skipStats.low_composite === 0
      && skipStats.capability_cooldown === 0
      && skipStats.medium_risk_guard === 0
      && skipStats.medium_policy_blocked === 0
      && skipStats.medium_daily_cap === 0
      && skipStats.objective_binding === 0
    ) {
      const objectiveId = String(
        sampleDirectivePulseCooldown && sampleDirectivePulseCooldown.objective_id
          ? sampleDirectivePulseCooldown.objective_id
          : ''
      ).trim();
      const priorCooldownHits = objectiveId
        ? recentDirectivePulseCooldownCount(dateStr, objectiveId, AUTONOMY_DIRECTIVE_PULSE_ESCALATE_WINDOW_HOURS)
        : 0;
      const cooldownHitsWindow = priorCooldownHits + 1;
      const escalateAfter = Math.max(1, Number(AUTONOMY_DIRECTIVE_PULSE_ESCALATE_AFTER || 2));
      const shouldEscalate = !!objectiveId && cooldownHitsWindow >= escalateAfter;
      const escalation = shouldEscalate
        ? ensureDirectivePulseEscalationProposal(proposalDate, objectiveId, directivePulseCtx, sampleDirectivePulseCooldown)
        : { created: false, reason: 'below_escalation_threshold' };

      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_repeat_gate_directive_pulse_cooldown',
        objective_id: objectiveId || null,
        cooldown_hits_window: cooldownHitsWindow,
        escalate_after: escalateAfter,
        escalation,
        cooldown_hours: directivePulseCtx.cooldown_hours,
        no_progress_limit: directivePulseCtx.no_progress_limit,
        skipped_directive_pulse_cooldown: skipStats.directive_pulse_cooldown,
        sample_directive_pulse_cooldown: sampleDirectivePulseCooldown
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_repeat_gate_directive_pulse_cooldown',
        objective_id: objectiveId || null,
        cooldown_hits_window: cooldownHitsWindow,
        escalate_after: escalateAfter,
        escalation,
        cooldown_hours: directivePulseCtx.cooldown_hours,
        no_progress_limit: directivePulseCtx.no_progress_limit,
        skipped_directive_pulse_cooldown: skipStats.directive_pulse_cooldown,
        sample_directive_pulse_cooldown: sampleDirectivePulseCooldown,
        ts: nowIso()
      }) + '\n');
      return;
    }

    if (
      skipStats.objective_binding > 0
      && skipStats.eye_no_progress === 0
      && skipStats.low_quality === 0
      && skipStats.low_directive_fit === 0
      && skipStats.low_actionability === 0
      && skipStats.optimization_good_enough === 0
      && skipStats.low_value_signal === 0
      && skipStats.low_composite === 0
      && skipStats.capability_cooldown === 0
      && skipStats.medium_risk_guard === 0
      && skipStats.medium_policy_blocked === 0
      && skipStats.medium_daily_cap === 0
      && skipStats.directive_pulse_cooldown === 0
    ) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_init_gate_objective_binding_exhausted',
        skipped_objective_binding: skipStats.objective_binding,
        sample_objective_binding: sampleObjectiveBinding
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_init_gate_objective_binding_exhausted',
        skipped_objective_binding: skipStats.objective_binding,
        sample_objective_binding: sampleObjectiveBinding,
        ts: nowIso()
      }) + '\n');
      return;
    }

    if (
      skipStats.low_quality > 0
      && skipStats.eye_no_progress === 0
      && skipStats.low_directive_fit === 0
      && skipStats.low_actionability === 0
      && skipStats.optimization_good_enough === 0
      && skipStats.low_value_signal === 0
      && skipStats.low_composite === 0
      && skipStats.capability_cooldown === 0
      && skipStats.objective_binding === 0
    ) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_init_gate_quality_exhausted',
        min_signal_quality: thresholds.min_signal_quality,
        skipped_low_quality: skipStats.low_quality,
        sample_low_quality: sampleLowQuality
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_init_gate_quality_exhausted',
        min_signal_quality: thresholds.min_signal_quality,
        skipped_low_quality: skipStats.low_quality,
        sample_low_quality: sampleLowQuality,
        ts: nowIso()
      }) + '\n');
      return;
    }

    if (
      skipStats.low_directive_fit > 0
      && skipStats.eye_no_progress === 0
      && skipStats.low_quality === 0
      && skipStats.low_actionability === 0
      && skipStats.optimization_good_enough === 0
      && skipStats.low_value_signal === 0
      && skipStats.low_composite === 0
      && skipStats.capability_cooldown === 0
      && skipStats.objective_binding === 0
    ) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_init_gate_directive_fit_exhausted',
        min_directive_fit: thresholds.min_directive_fit,
        active_directive_ids: directiveProfile.active_directive_ids,
        skipped_low_directive_fit: skipStats.low_directive_fit,
        sample_low_directive_fit: sampleLowDirectiveFit
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_init_gate_directive_fit_exhausted',
        min_directive_fit: thresholds.min_directive_fit,
        active_directive_ids: directiveProfile.active_directive_ids,
        skipped_low_directive_fit: skipStats.low_directive_fit,
        sample_low_directive_fit: sampleLowDirectiveFit,
        ts: nowIso()
      }) + '\n');
      return;
    }

    if (
      skipStats.low_actionability > 0
      && skipStats.eye_no_progress === 0
      && skipStats.low_quality === 0
      && skipStats.low_directive_fit === 0
      && skipStats.optimization_good_enough === 0
      && skipStats.low_value_signal === 0
      && skipStats.low_composite === 0
      && skipStats.capability_cooldown === 0
      && skipStats.objective_binding === 0
    ) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_init_gate_actionability_exhausted',
        min_actionability_score: thresholds.min_actionability_score,
        skipped_low_actionability: skipStats.low_actionability,
        sample_low_actionability: sampleLowActionability
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_init_gate_actionability_exhausted',
        min_actionability_score: thresholds.min_actionability_score,
        skipped_low_actionability: skipStats.low_actionability,
        sample_low_actionability: sampleLowActionability,
        ts: nowIso()
      }) + '\n');
      return;
    }

    if (
      skipStats.optimization_good_enough > 0
      && skipStats.eye_no_progress === 0
      && skipStats.low_quality === 0
      && skipStats.low_directive_fit === 0
      && skipStats.low_actionability === 0
      && skipStats.low_value_signal === 0
      && skipStats.low_composite === 0
      && skipStats.capability_cooldown === 0
      && skipStats.medium_risk_guard === 0
      && skipStats.medium_policy_blocked === 0
      && skipStats.medium_daily_cap === 0
      && skipStats.directive_pulse_cooldown === 0
      && skipStats.objective_binding === 0
    ) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_init_gate_optimization_good_enough',
        min_optimization_delta_percent: optimizationMinDeltaPercent(),
        optimization_high_accuracy_mode: AUTONOMY_OPTIMIZATION_HIGH_ACCURACY_MODE,
        optimization_require_delta: AUTONOMY_OPTIMIZATION_REQUIRE_DELTA,
        skipped_optimization_good_enough: skipStats.optimization_good_enough,
        sample_optimization_good_enough: sampleOptimizationGoodEnough
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_init_gate_optimization_good_enough',
        min_optimization_delta_percent: optimizationMinDeltaPercent(),
        optimization_high_accuracy_mode: AUTONOMY_OPTIMIZATION_HIGH_ACCURACY_MODE,
        optimization_require_delta: AUTONOMY_OPTIMIZATION_REQUIRE_DELTA,
        skipped_optimization_good_enough: skipStats.optimization_good_enough,
        sample_optimization_good_enough: sampleOptimizationGoodEnough,
        ts: nowIso()
      }) + '\n');
      return;
    }

    if (
      skipStats.low_value_signal > 0
      && skipStats.eye_no_progress === 0
      && skipStats.low_quality === 0
      && skipStats.low_directive_fit === 0
      && skipStats.low_actionability === 0
      && skipStats.optimization_good_enough === 0
      && skipStats.low_composite === 0
      && skipStats.capability_cooldown === 0
      && skipStats.medium_risk_guard === 0
      && skipStats.medium_policy_blocked === 0
      && skipStats.medium_daily_cap === 0
      && skipStats.directive_pulse_cooldown === 0
      && skipStats.objective_binding === 0
    ) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_init_gate_value_signal_exhausted',
        min_value_signal_score: AUTONOMY_MIN_VALUE_SIGNAL_SCORE,
        medium_risk_value_signal_bonus: AUTONOMY_MEDIUM_RISK_VALUE_SIGNAL_BONUS,
        skipped_low_value_signal: skipStats.low_value_signal,
        sample_low_value_signal: sampleLowValueSignal
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_init_gate_value_signal_exhausted',
        min_value_signal_score: AUTONOMY_MIN_VALUE_SIGNAL_SCORE,
        medium_risk_value_signal_bonus: AUTONOMY_MEDIUM_RISK_VALUE_SIGNAL_BONUS,
        skipped_low_value_signal: skipStats.low_value_signal,
        sample_low_value_signal: sampleLowValueSignal,
        ts: nowIso()
      }) + '\n');
      return;
    }

    if (
      skipStats.budget_pacing > 0
      && skipStats.eye_no_progress === 0
      && skipStats.low_quality === 0
      && skipStats.low_directive_fit === 0
      && skipStats.low_actionability === 0
      && skipStats.optimization_good_enough === 0
      && skipStats.low_value_signal === 0
      && skipStats.low_composite === 0
      && skipStats.capability_cooldown === 0
      && skipStats.medium_risk_guard === 0
      && skipStats.medium_policy_blocked === 0
      && skipStats.medium_daily_cap === 0
      && skipStats.directive_pulse_cooldown === 0
      && skipStats.objective_binding === 0
    ) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_init_gate_budget_pacing',
        skipped_budget_pacing: skipStats.budget_pacing,
        sample_budget_pacing: sampleBudgetPacing,
        budget_pacing: budgetPacingState
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_init_gate_budget_pacing',
        skipped_budget_pacing: skipStats.budget_pacing,
        sample_budget_pacing: sampleBudgetPacing,
        budget_pacing: budgetPacingState,
        ts: nowIso()
      }) + '\n');
      return;
    }

    if (
      skipStats.manual_gate_prefilter > 0
      && skipStats.eye_no_progress === 0
      && skipStats.low_quality === 0
      && skipStats.low_directive_fit === 0
      && skipStats.low_actionability === 0
      && skipStats.optimization_good_enough === 0
      && skipStats.low_value_signal === 0
      && skipStats.budget_pacing === 0
      && skipStats.low_composite === 0
      && skipStats.capability_cooldown === 0
      && skipStats.medium_risk_guard === 0
      && skipStats.medium_policy_blocked === 0
      && skipStats.medium_daily_cap === 0
      && skipStats.directive_pulse_cooldown === 0
      && skipStats.objective_binding === 0
    ) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_init_gate_score_only_manual_gate_prefilter',
        skipped_manual_gate_prefilter: skipStats.manual_gate_prefilter,
        sample_manual_gate_prefilter: sampleManualGatePrefilter
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_init_gate_score_only_manual_gate_prefilter',
        skipped_manual_gate_prefilter: skipStats.manual_gate_prefilter,
        sample_manual_gate_prefilter: sampleManualGatePrefilter,
        ts: nowIso()
      }) + '\n');
      return;
    }

    if (
      skipStats.capability_cooldown > 0
      && skipStats.eye_no_progress === 0
      && skipStats.low_quality === 0
      && skipStats.low_directive_fit === 0
      && skipStats.low_actionability === 0
      && skipStats.optimization_good_enough === 0
      && skipStats.low_value_signal === 0
      && skipStats.low_composite === 0
      && skipStats.medium_risk_guard === 0
      && skipStats.medium_policy_blocked === 0
      && skipStats.medium_daily_cap === 0
      && skipStats.directive_pulse_cooldown === 0
      && skipStats.objective_binding === 0
    ) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_repeat_gate_capability_cooldown',
        skipped_capability_cooldown: skipStats.capability_cooldown,
        sample_capability_cooldown: sampleCapabilityCooldown
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_repeat_gate_capability_cooldown',
        skipped_capability_cooldown: skipStats.capability_cooldown,
        sample_capability_cooldown: sampleCapabilityCooldown,
        ts: nowIso()
      }) + '\n');
      return;
    }

    if (
      skipStats.low_composite > 0
      && skipStats.eye_no_progress === 0
      && skipStats.low_quality === 0
      && skipStats.low_directive_fit === 0
      && skipStats.low_actionability === 0
      && skipStats.optimization_good_enough === 0
      && skipStats.low_value_signal === 0
      && skipStats.capability_cooldown === 0
      && skipStats.objective_binding === 0
    ) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_init_gate_composite_exhausted',
        min_composite_eligibility: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
        min_composite_eligibility_base: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
        min_composite_eligibility_low_risk_canary: compositeEligibilityMin('low', executionMode),
        canary_low_risk_composite_relax: Math.max(0, Number(AUTONOMY_CANARY_LOW_RISK_COMPOSITE_RELAX || 0)),
        skipped_low_composite: skipStats.low_composite,
        sample_low_composite: sampleLowComposite
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_init_gate_composite_exhausted',
        min_composite_eligibility: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
        min_composite_eligibility_base: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
        min_composite_eligibility_low_risk_canary: compositeEligibilityMin('low', executionMode),
        canary_low_risk_composite_relax: Math.max(0, Number(AUTONOMY_CANARY_LOW_RISK_COMPOSITE_RELAX || 0)),
        skipped_low_composite: skipStats.low_composite,
        sample_low_composite: sampleLowComposite,
        ts: nowIso()
      }) + '\n');
      return;
    }

    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_candidate_exhausted',
      reason: `all_candidates_exhausted quality_or_directive_fit_or_actionability_or_optimization_good_enough_or_objective_binding_or_value_or_budget_pacing_or_composite_or_capability_cooldown_or_medium_risk_or_eye_no_progress_or_directive_pulse_or_manual_gate_prefilter`,
      skipped_eye_no_progress: skipStats.eye_no_progress,
      skipped_low_quality: skipStats.low_quality,
      skipped_low_directive_fit: skipStats.low_directive_fit,
      skipped_low_actionability: skipStats.low_actionability,
      skipped_optimization_good_enough: skipStats.optimization_good_enough,
      skipped_objective_binding: skipStats.objective_binding,
      skipped_low_value_signal: skipStats.low_value_signal,
      skipped_budget_pacing: skipStats.budget_pacing,
      skipped_low_composite: skipStats.low_composite,
      skipped_capability_cooldown: skipStats.capability_cooldown,
      skipped_medium_risk_guard: skipStats.medium_risk_guard,
      skipped_medium_policy_blocked: skipStats.medium_policy_blocked,
      skipped_medium_daily_cap: skipStats.medium_daily_cap,
      skipped_directive_pulse_cooldown: skipStats.directive_pulse_cooldown,
      skipped_manual_gate_prefilter: skipStats.manual_gate_prefilter,
      sample_low_quality: sampleLowQuality,
      sample_low_directive_fit: sampleLowDirectiveFit,
      sample_low_actionability: sampleLowActionability,
      sample_optimization_good_enough: sampleOptimizationGoodEnough,
      sample_objective_binding: sampleObjectiveBinding,
      sample_low_value_signal: sampleLowValueSignal,
      sample_budget_pacing: sampleBudgetPacing,
      sample_low_composite: sampleLowComposite,
      sample_capability_cooldown: sampleCapabilityCooldown,
      sample_medium_risk_guard: sampleMediumRiskGuard,
      sample_medium_policy_blocked: sampleMediumPolicyBlocked,
      sample_medium_daily_cap: sampleMediumDailyCap,
      sample_directive_pulse_cooldown: sampleDirectivePulseCooldown,
      sample_manual_gate_prefilter: sampleManualGatePrefilter
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_candidate_exhausted',
      reason: `all_candidates_exhausted quality_or_directive_fit_or_actionability_or_optimization_good_enough_or_objective_binding_or_value_or_budget_pacing_or_composite_or_capability_cooldown_or_medium_risk_or_eye_no_progress_or_directive_pulse_or_manual_gate_prefilter`,
      skipped_eye_no_progress: skipStats.eye_no_progress,
      skipped_low_quality: skipStats.low_quality,
      skipped_low_directive_fit: skipStats.low_directive_fit,
      skipped_low_actionability: skipStats.low_actionability,
      skipped_optimization_good_enough: skipStats.optimization_good_enough,
      skipped_objective_binding: skipStats.objective_binding,
      skipped_low_value_signal: skipStats.low_value_signal,
      skipped_budget_pacing: skipStats.budget_pacing,
      skipped_low_composite: skipStats.low_composite,
      skipped_capability_cooldown: skipStats.capability_cooldown,
      skipped_medium_risk_guard: skipStats.medium_risk_guard,
      skipped_medium_policy_blocked: skipStats.medium_policy_blocked,
      skipped_medium_daily_cap: skipStats.medium_daily_cap,
      skipped_directive_pulse_cooldown: skipStats.directive_pulse_cooldown,
      skipped_manual_gate_prefilter: skipStats.manual_gate_prefilter,
      sample_low_quality: sampleLowQuality,
      sample_low_directive_fit: sampleLowDirectiveFit,
      sample_low_actionability: sampleLowActionability,
      sample_optimization_good_enough: sampleOptimizationGoodEnough,
      sample_objective_binding: sampleObjectiveBinding,
      sample_low_value_signal: sampleLowValueSignal,
      sample_budget_pacing: sampleBudgetPacing,
      sample_low_composite: sampleLowComposite,
      sample_capability_cooldown: sampleCapabilityCooldown,
      sample_medium_risk_guard: sampleMediumRiskGuard,
      sample_medium_policy_blocked: sampleMediumPolicyBlocked,
      sample_medium_daily_cap: sampleMediumDailyCap,
      sample_directive_pulse_cooldown: sampleDirectivePulseCooldown,
      sample_manual_gate_prefilter: sampleManualGatePrefilter,
      ts: nowIso()
    }) + '\n');
    return;
  }

  const p = pick.proposal;
  const proposalRisk = normalizedRisk(p && p.risk);
  const compositeMinScore = Number(pick && pick.composite_min_score != null
    ? pick.composite_min_score
    : compositeEligibilityMin(proposalRisk, executionMode));
  const ov = pick.overlay || { outcomes: { no_change: 0, reverted: 0 } };
  const directiveClarification = directiveClarificationExecSpec(p);
  const directiveDecomposition = directiveClarification ? null : directiveDecompositionExecSpec(p);
  const directiveAction = directiveClarification || directiveDecomposition;
  const proposalDependenciesBase = proposalDependencySummary(p, directiveAction, null);
  const actuationSpec = directiveAction ? null : parseActuationSpec(p);
  const executionTarget = directiveClarification
    ? 'directive'
    : (directiveDecomposition ? 'directive' : (actuationSpec ? 'actuation' : 'route'));
  const capability = capabilityDescriptor(p, actuationSpec);
  const capabilityKey = String(capability && capability.key ? capability.key : 'unknown');
  const capabilityLimit = capabilityCap(strategyBudget, capability);
  const capabilityAttemptsToday = capabilityAttemptCountForDate(dateStr, capability);
  const laneNoChangeStats = capabilityOutcomeStatsInWindow(dateStr, capability, AUTONOMY_LANE_NO_CHANGE_WINDOW_DAYS);
  const noChangeCount = ov.outcomes?.no_change || 0;
  const revertedCount = ov.outcomes?.reverted || 0;
  const circuitCooldownHours = strategyCircuitCooldownHours(p, strategy);
  const directivePulse = pick.directive_pulse || null;
  const campaignMatch = pick && pick.campaign_match && pick.campaign_match.matched === true
    ? pick.campaign_match
    : null;
  const objectiveBinding = pick.objective_binding || resolveObjectiveBinding(p, directivePulseCtx);
  const executionObjectiveId = objectiveIdForExecution(p, directivePulse, directiveAction, objectiveBinding);
  const policyHoldDampener = objectivePolicyHoldPattern(priorRuns, executionObjectiveId, {
    window_hours: AUTONOMY_POLICY_HOLD_DAMPENER_WINDOW_HOURS,
    repeat_threshold: AUTONOMY_POLICY_HOLD_DAMPENER_REPEAT_THRESHOLD
  });
  const mutationExecutionGuard = adaptiveMutationExecutionGuardDecision(p);

  if (
    !shadowOnly
    && AUTONOMY_MUTATION_EXECUTION_GUARD_REQUIRED
    && mutationExecutionGuard.applies
    && !mutationExecutionGuard.pass
  ) {
    const guardReason = String(mutationExecutionGuard.reason || 'adaptive_mutation_execution_guard_blocked').trim() || 'adaptive_mutation_execution_guard_blocked';
    const reason = `auto:mutation_guard ${guardReason} cooldown_${AUTONOMY_MUTATION_EXECUTION_GUARD_COOLDOWN_HOURS}h`;
    runProposalQueue('park', p.id, reason);
    setCooldown(p.id, AUTONOMY_MUTATION_EXECUTION_GUARD_COOLDOWN_HOURS, reason);
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_mutation_guard',
      policy_hold: true,
      hold_scope: 'proposal',
      hold_reason: guardReason,
      proposal_id: p.id,
      objective_id: executionObjectiveId || null,
      capability_key: capabilityKey,
      execution_target: executionTarget,
      proposal_type: String(p.type || ''),
      risk: proposalRisk,
      source_eye: sourceEyeId(p),
      mutation_guard: mutationExecutionGuard
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_mutation_guard',
      proposal_id: p.id,
      objective_id: executionObjectiveId || null,
      capability_key: capabilityKey,
      hold_reason: guardReason,
      mutation_guard: mutationExecutionGuard,
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (
    !shadowOnly
    && AUTONOMY_POLICY_HOLD_DAMPENER_ENABLED
    && AUTONOMY_POLICY_HOLD_DAMPENER_COOLDOWN_HOURS > 0
    && policyHoldDampener.should_dampen === true
  ) {
    const holdReason = String(policyHoldDampener.top_reason || 'policy_hold_unknown');
    const reason = `auto:policy_hold_dampener ${holdReason} repeats_${policyHoldDampener.top_count}/${policyHoldDampener.repeat_threshold} cooldown_${AUTONOMY_POLICY_HOLD_DAMPENER_COOLDOWN_HOURS}h`;
    runProposalQueue('park', p.id, reason);
    setCooldown(p.id, AUTONOMY_POLICY_HOLD_DAMPENER_COOLDOWN_HOURS, reason);
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_policy_hold_dampener',
      proposal_id: p.id,
      objective_id: executionObjectiveId || null,
      capability_key: capabilityKey,
      hold_reason: holdReason,
      policy_hold_dampener: policyHoldDampener,
      cooldown_hours: AUTONOMY_POLICY_HOLD_DAMPENER_COOLDOWN_HOURS,
      reason
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_policy_hold_dampener',
      proposal_id: p.id,
      objective_id: executionObjectiveId || null,
      capability_key: capabilityKey,
      hold_reason: holdReason,
      policy_hold_dampener: policyHoldDampener,
      cooldown_hours: AUTONOMY_POLICY_HOLD_DAMPENER_COOLDOWN_HOURS,
      reason,
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (circuitCooldownHours > 0) {
    const reason = `auto:circuit_breaker cooldown_${circuitCooldownHours}h`;
    setCooldown(p.id, circuitCooldownHours, reason);
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_circuit_breaker',
      proposal_id: p.id,
      strategy_id: strategy ? strategy.id : null,
      cooldown_hours: circuitCooldownHours,
      error_code: String((p.meta && (p.meta.last_error_code || p.meta.last_error)) || ''),
      proposal_key: proposalDedupKey(p),
      capability_key: capabilityKey,
      directive_pulse: directivePulse
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_circuit_breaker',
      proposal_id: p.id,
      strategy_id: strategy ? strategy.id : null,
      directive_pulse: directivePulse,
      cooldown_hours: circuitCooldownHours,
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (executionMode === 'score_only') {
    let previewReceiptId = null;
    let previewVerification = null;
    let previewSummary = null;
    let previewTokenUsage = null;
    let scoreOnlyExecutionFloorArmed = false;
    let scoreOnlyExecutionFloorPolicy = null;
    let previewMode = shadowOnly ? 'shadow_only' : 'score_only';
    const churn = scoreOnlyProposalChurn(priorRuns, p.id, AUTONOMY_SCORE_ONLY_REPEAT_WINDOW_HOURS);
    if (
      AUTONOMY_SCORE_ONLY_REPEAT_COOLDOWN_HOURS > 0
      && Number(churn.count || 0) >= AUTONOMY_SCORE_ONLY_REPEAT_PROPOSAL_LIMIT
    ) {
      const reason = `auto:score_only_proposal_churn cooldown_${AUTONOMY_SCORE_ONLY_REPEAT_COOLDOWN_HOURS}h count_${churn.count}/${AUTONOMY_SCORE_ONLY_REPEAT_PROPOSAL_LIMIT}`;
      runProposalQueue('park', p.id, reason);
      setCooldown(p.id, AUTONOMY_SCORE_ONLY_REPEAT_COOLDOWN_HOURS, reason);
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_repeat_gate_preview_churn_cooldown',
        proposal_id: p.id,
        objective_id: executionObjectiveId || null,
        proposal_date: proposalDate,
        proposal_type: String(p.type || ''),
        risk: proposalRisk,
        source_eye: sourceEyeId(p),
        proposal_key: proposalDedupKey(p),
        capability_key: capabilityKey,
        score_only_churn: churn,
        score_only_repeat_window_hours: AUTONOMY_SCORE_ONLY_REPEAT_WINDOW_HOURS,
        score_only_repeat_limit: AUTONOMY_SCORE_ONLY_REPEAT_PROPOSAL_LIMIT,
        cooldown_hours: AUTONOMY_SCORE_ONLY_REPEAT_COOLDOWN_HOURS,
        reason
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_repeat_gate_preview_churn_cooldown',
        proposal_id: p.id,
        capability_key: capabilityKey,
        churn_count: churn.count,
        churn_streak: churn.streak,
        score_only_repeat_window_hours: AUTONOMY_SCORE_ONLY_REPEAT_WINDOW_HOURS,
        score_only_repeat_limit: AUTONOMY_SCORE_ONLY_REPEAT_PROPOSAL_LIMIT,
        cooldown_hours: AUTONOMY_SCORE_ONLY_REPEAT_COOLDOWN_HOURS,
        reason,
        ts: nowIso()
      }) + '\n');
      return;
    }
    const shouldCaptureEvidence = shadowOnly || AUTONOMY_SCORE_ONLY_EVIDENCE;

    if (shouldCaptureEvidence) {
      const estTokens = estimateTokens(p);
      const eyeRef = sourceEyeRef(p);
      const eyeId = sourceEyeId(p);
      const repeats14d = Math.max(1, countEyeProposalsInWindow(eyeId, proposalDate, 14));
      const errors30d = countEyeOutcomesInWindow(decisionEvents, eyeRef, 'reverted', proposalDate, 30);
      const routeTokensEst = repeats14d >= 3 ? Math.max(estTokens, AUTONOMY_MIN_ROUTE_TOKENS) : estTokens;
      previewReceiptId = `preview_${Date.now()}_${String(p.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)}`;
      const previewRes: AnyObj = directiveClarification
        ? runDirectiveClarificationValidate(directiveClarification, true)
        : directiveDecomposition
          ? runDirectiveDecomposition(directiveDecomposition, true)
        : actuationSpec
          ? runActuationExecute(actuationSpec, true)
          : runRouteExecute(makeTaskFromProposal(p), routeTokensEst, repeats14d, errors30d, true, sourceEyeId(p));
      const preSummary = previewRes.summary || null;
      const preBudgetDeferred = !!(preSummary && preSummary.budget_deferred === true);
      const preBlocked = !previewRes.ok
        || !preSummary
        || (!preBudgetDeferred && preSummary.executable !== true)
        || (!preBudgetDeferred && preSummary.gate_decision === 'MANUAL')
        || (!preBudgetDeferred && preSummary.gate_decision === 'DENY');
      const checks = [
        { name: 'preview_command_ok', pass: !!previewRes.ok },
        { name: 'preview_executable', pass: !preBlocked }
      ];
      const failed = checks.filter(c => c.pass !== true).map(c => c.name);
      const primaryFailure = !previewRes.ok
        ? `${executionTarget}_exit_${previewRes.code}`
        : (preBlocked ? 'preflight_not_executable' : null);
      previewVerification = {
        checks,
        failed,
        passed: failed.length === 0,
        outcome: preBudgetDeferred ? 'no_change' : (failed.length === 0 ? 'shipped' : 'no_change'),
        primary_failure: preBudgetDeferred ? null : primaryFailure
      };
      previewSummary = preSummary;
      previewTokenUsage = computeExecutionTokenUsage(preSummary, previewRes.execution_metrics, routeTokensEst, estTokens);
      const criteriaPolicy = successCriteriaPolicyForProposal(p);
      const previewMetricValues = extractSuccessCriteriaMetricValues(p, {
        exec_summary: preSummary,
        execution_metrics: previewRes && previewRes.execution_metrics,
        exec_details: previewRes && previewRes.details,
        exec_stdout: previewRes && previewRes.stdout,
        dod_diff: {}
      });
      const previewSuccessCriteria = evaluateSuccessCriteria(
        p,
        {
          phase: 'preview',
          allow_deferred_preview: AUTONOMY_SUCCESS_CRITERIA_ALLOW_DEFERRED_PREVIEW,
          capability_key: capabilityKey,
          outcome: previewVerification.outcome,
          exec_ok: previewRes && previewRes.ok === true,
          dod_passed: previewVerification.passed === true,
          postconditions_ok: !!(preSummary && preSummary.postconditions_ok === true),
          queue_outcome_logged: true,
          duration_ms: Number(previewRes && previewRes.execution_metrics && previewRes.execution_metrics.duration_ms || 0),
          token_usage: previewTokenUsage,
          dod_diff: {},
          metric_values: previewMetricValues || {}
        },
        {
          required: criteriaPolicy.required,
          min_count: criteriaPolicy.min_count,
          capability_key: capabilityKey
        }
      );
      previewVerification = withSuccessCriteriaVerification(previewVerification, previewSuccessCriteria, {
        fallback: { required: criteriaPolicy.required, min_count: criteriaPolicy.min_count },
        enforceNoChangeOnFailure: true
      });
      previewVerification = withSuccessCriteriaQualityAudit(previewVerification);
      const scoreOnlyExecutionFloorCountToday = Array.isArray(priorRuns)
        ? priorRuns.filter((evt) => evt && evt.type === 'autonomy_run' && evt.result === 'score_only_execution_floor_bootstrap_execute').length
        : 0;
      const previewGateDecision = String(preSummary && preSummary.gate_decision || 'ALLOW').trim().toUpperCase() || 'ALLOW';
      const floorEligible = !shadowOnly
        && AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_ENABLED
        && executionFloorShippedDeficit
        && proposalRisk === 'low'
        && pick
        && pick.actionability
        && pick.actionability.executable === true
        && previewVerification
        && previewVerification.passed === true
        && preBudgetDeferred !== true
        && preSummary
        && preSummary.executable === true
        && previewGateDecision !== 'MANUAL'
        && previewGateDecision !== 'DENY'
        && routeTokensEst <= AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_MAX_TOKENS
        && scoreOnlyExecutionFloorCountToday < AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_MAX_PER_DAY;
      if (floorEligible) {
        scoreOnlyExecutionFloorArmed = true;
        previewMode = 'score_only_execution_floor_bootstrap';
        scoreOnlyExecutionFloorPolicy = {
          enabled: AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_ENABLED,
          min_shipped_per_day: AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_MIN_SHIPPED_PER_DAY,
          shipped_today: shippedToday,
          max_per_day: AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_MAX_PER_DAY,
          executions_today: scoreOnlyExecutionFloorCountToday,
          max_tokens: AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_MAX_TOKENS,
          route_tokens_est: routeTokensEst,
          gate_decision: previewGateDecision
        };
        writeRun(dateStr, {
          ts: nowIso(),
          type: 'autonomy_run',
          result: 'score_only_execution_floor_bootstrap_execute',
          proposal_id: p.id,
          objective_id: executionObjectiveId || null,
          capability_key: capabilityKey,
          execution_target: executionTarget,
          preview_receipt_id: previewReceiptId,
          preview_verification: previewVerification,
          preview_summary: previewSummary,
          token_usage: previewTokenUsage,
          execution_floor_policy: scoreOnlyExecutionFloorPolicy
        });
      }
      const previewDependencies = proposalDependencySummary(
        p,
        directiveAction,
        previewSummary || preSummary || null
      ) || proposalDependenciesBase;
      writeReceipt(dateStr, {
        ts: nowIso(),
        type: 'autonomy_action_receipt',
        receipt_id: previewReceiptId,
        proposal_id: p.id,
        proposal_date: proposalDate,
        verdict: previewVerification.passed ? 'pass' : 'fail',
        intent: {
          task_hash: hashObj({ task: makeTaskFromProposal(p) }),
          objective_id: executionObjectiveId || null,
          actuation: actuationSpec ? { kind: actuationSpec.kind } : null,
          directive_validation: directiveAction
            ? {
              decision: directiveAction.decision || null,
              objective_id: directiveAction.objective_id || null,
              file: directiveClarification ? (directiveClarification.file || null) : null
            }
          : null,
          proposal_dependencies: previewDependencies,
          mode: previewMode,
          score_only: true,
          route_tokens_est: routeTokensEst,
          repeats_14d: repeats14d,
          errors_30d: errors30d,
          success_criteria_policy: {
            required: criteriaPolicy.required === true,
            min_count: Number(criteriaPolicy.min_count || 0)
          }
        },
        execution: {
          preview: compactCmdResult(previewRes),
          token_usage: previewTokenUsage
        },
        verification: previewVerification
      });
      if (
        previewVerification
        && previewVerification.passed !== true
        && hasStructuralPreviewCriteriaFailure(previewVerification)
        && AUTONOMY_SCORE_ONLY_STRUCTURAL_COOLDOWN_HOURS > 0
      ) {
        const reason = `auto:score_only_structural_criteria cooldown_${AUTONOMY_SCORE_ONLY_STRUCTURAL_COOLDOWN_HOURS}h`;
        runProposalQueue('park', p.id, reason);
        setCooldown(p.id, AUTONOMY_SCORE_ONLY_STRUCTURAL_COOLDOWN_HOURS, reason);
        writeRun(dateStr, {
          ts: nowIso(),
          type: 'autonomy_run',
          result: 'stop_repeat_gate_preview_structural_cooldown',
          proposal_id: p.id,
          objective_id: executionObjectiveId || null,
          proposal_date: proposalDate,
          proposal_type: String(p.type || ''),
          risk: proposalRisk,
          source_eye: sourceEyeId(p),
          proposal_key: proposalDedupKey(p),
          capability_key: capabilityKey,
          preview_mode: previewMode,
          preview_receipt_id: previewReceiptId,
          preview_verification: previewVerification,
          cooldown_hours: AUTONOMY_SCORE_ONLY_STRUCTURAL_COOLDOWN_HOURS,
          reason
        });
        process.stdout.write(JSON.stringify({
          ok: true,
          result: 'stop_repeat_gate_preview_structural_cooldown',
          proposal_id: p.id,
          capability_key: capabilityKey,
          preview_receipt_id: previewReceiptId,
          cooldown_hours: AUTONOMY_SCORE_ONLY_STRUCTURAL_COOLDOWN_HOURS,
          reason,
          ts: nowIso()
        }) + '\n');
        return;
      }
    }

    if (!scoreOnlyExecutionFloorArmed) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: shadowOnly ? 'score_only_evidence' : 'score_only_preview',
        strategy_id: strategy ? strategy.id : null,
        execution_mode: executionMode,
        proposal_id: p.id,
        objective_id: executionObjectiveId || null,
        proposal_date: proposalDate,
        proposal_type: String(p.type || ''),
        risk: proposalRisk,
        source_eye: sourceEyeId(p),
        proposal_key: proposalDedupKey(p),
        capability_key: capabilityKey,
        score: Number(pick.score.toFixed(3)),
        strategy_rank: pick.strategy_rank || null,
        strategy_rank_adjusted: Number(pick.strategy_rank_adjusted || (pick.strategy_rank && pick.strategy_rank.score) || 0),
        value_signal: pick.value_signal || null,
        objective_binding: objectiveBinding,
        directive_pulse: directivePulse,
        campaign_match: campaignMatch,
        campaign_plan: campaignPlan,
        selection_mode: selection.mode,
        selection_index: selection.index,
        admission: admissionSummary,
        execution_target: executionTarget,
        preview_mode: previewMode,
        preview_receipt_id: previewReceiptId,
        preview_verification: previewVerification,
        preview_summary: previewSummary,
        proposal_dependencies: proposalDependencySummary(p, directiveAction, previewSummary || null) || proposalDependenciesBase,
        token_usage: previewTokenUsage
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: shadowOnly ? 'score_only_evidence' : 'score_only_preview',
        strategy_id: strategy ? strategy.id : null,
        execution_mode: executionMode,
        proposal_id: p.id,
        objective_id: executionObjectiveId || null,
        proposal_date: proposalDate,
        risk: proposalRisk,
        score: Number(pick.score.toFixed(3)),
        strategy_rank: pick.strategy_rank || null,
        strategy_rank_adjusted: Number(pick.strategy_rank_adjusted || (pick.strategy_rank && pick.strategy_rank.score) || 0),
        value_signal: pick.value_signal || null,
        objective_binding: objectiveBinding,
        directive_pulse: directivePulse,
        campaign_match: campaignMatch,
        campaign_plan: campaignPlan,
        selection_mode: selection.mode,
        selection_index: selection.index,
        admission: admissionSummary,
        execution_target: executionTarget,
        preview_mode: previewMode,
        preview_receipt_id: previewReceiptId,
        preview_verification: previewVerification,
        preview_summary: previewSummary,
        proposal_dependencies: proposalDependencySummary(p, directiveAction, previewSummary || null) || proposalDependenciesBase,
        token_usage: previewTokenUsage,
        ts: nowIso()
      }) + '\n');
      return;
    }
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'score_only_execution_floor_bootstrap_armed',
      proposal_id: p.id,
      objective_id: executionObjectiveId || null,
      capability_key: capabilityKey,
      execution_target: executionTarget,
      preview_receipt_id: previewReceiptId,
      preview_verification: previewVerification,
      preview_summary: previewSummary,
      token_usage: previewTokenUsage,
      execution_floor_policy: scoreOnlyExecutionFloorPolicy
    });
  }

  if (
    !shadowOnly
    && AUTONOMY_LANE_NO_CHANGE_LIMIT > 0
    && AUTONOMY_LANE_NO_CHANGE_COOLDOWN_HOURS > 0
    && capabilityKey
    && capabilityKey !== 'unknown'
    && Number(laneNoChangeStats.no_change || 0) >= AUTONOMY_LANE_NO_CHANGE_LIMIT
    && Number(laneNoChangeStats.shipped || 0) === 0
  ) {
    const reason = `auto:capability_no_change limit_${AUTONOMY_LANE_NO_CHANGE_LIMIT} window_${AUTONOMY_LANE_NO_CHANGE_WINDOW_DAYS}d cooldown_${AUTONOMY_LANE_NO_CHANGE_COOLDOWN_HOURS}h`;
    setCapabilityCooldown(capabilityKey, AUTONOMY_LANE_NO_CHANGE_COOLDOWN_HOURS, reason);
    setCooldown(p.id, AUTONOMY_LANE_NO_CHANGE_COOLDOWN_HOURS, reason);
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_capability_no_change_cooldown',
      proposal_id: p.id,
      capability_key: capabilityKey,
      lane_no_change_policy: {
        window_days: AUTONOMY_LANE_NO_CHANGE_WINDOW_DAYS,
        limit: AUTONOMY_LANE_NO_CHANGE_LIMIT,
        cooldown_hours: AUTONOMY_LANE_NO_CHANGE_COOLDOWN_HOURS
      },
      lane_outcomes_window: laneNoChangeStats
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_capability_no_change_cooldown',
      proposal_id: p.id,
      capability_key: capabilityKey,
      lane_no_change_policy: {
        window_days: AUTONOMY_LANE_NO_CHANGE_WINDOW_DAYS,
        limit: AUTONOMY_LANE_NO_CHANGE_LIMIT,
        cooldown_hours: AUTONOMY_LANE_NO_CHANGE_COOLDOWN_HOURS
      },
      lane_outcomes_window: laneNoChangeStats,
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (noChangeCount >= NO_CHANGE_LIMIT) {
    const reason = `auto:autonomy no_change>=${NO_CHANGE_LIMIT} cooldown_${NO_CHANGE_COOLDOWN_HOURS}h`;
    runProposalQueue('park', p.id, reason);
    setCooldown(p.id, NO_CHANGE_COOLDOWN_HOURS, reason);
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_no_change',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      no_change: noChangeCount
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_no_change',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (revertedCount >= 1) {
    const reason = `auto:autonomy reverted>=1 cooldown_${REVERT_COOLDOWN_HOURS}h`;
    runProposalQueue('park', p.id, reason);
    setCooldown(p.id, REVERT_COOLDOWN_HOURS, reason);
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_reverted',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      reverted: revertedCount
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_reverted',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (AUTONOMY_SKIP_STUB && isStubProposal(p)) {
    const reason = `auto:init_gate stub cooldown_${AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS}h`;
    setCooldown(p.id, AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS, reason);
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'init_gate_stub',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      score: Number(pick.score.toFixed(3))
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'init_gate_stub',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      score: Number(pick.score.toFixed(3)),
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (pick.score < AUTONOMY_MIN_PROPOSAL_SCORE) {
    const reason = `auto:init_gate low_score<${AUTONOMY_MIN_PROPOSAL_SCORE} cooldown_${AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS}h`;
    setCooldown(p.id, AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS, reason);
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'init_gate_low_score',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      score: Number(pick.score.toFixed(3)),
      min_score: AUTONOMY_MIN_PROPOSAL_SCORE
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'init_gate_low_score',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      score: Number(pick.score.toFixed(3)),
      min_score: AUTONOMY_MIN_PROPOSAL_SCORE,
      ts: nowIso()
    }) + '\n');
    return;
  }

  const estTokens = estimateTokens(p);
  const tier1Governance = evaluateTier1GovernanceSnapshot(dateStr, attemptsToday, estTokens, {
    execution_mode: executionMode,
    strategy_budget: strategyBudget
  });
  if (!shadowOnly && tier1Governance.enabled === true && tier1Governance.hard_stop === true) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_init_gate_tier1_governance',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      governance: {
        blockers: Array.isArray(tier1Governance.blockers) ? tier1Governance.blockers.slice(0, 6) : [],
        mode_policy: tier1Governance.mode_policy || null,
        cost: tier1Governance.cost || null,
        drift: tier1Governance.drift || null,
        alignment: tier1Governance.alignment || null
      }
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_init_gate_tier1_governance',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      governance: {
        blockers: Array.isArray(tier1Governance.blockers) ? tier1Governance.blockers.slice(0, 6) : [],
        mode_policy: tier1Governance.mode_policy || null,
        cost: tier1Governance.cost || null,
        drift: tier1Governance.drift || null,
        alignment: tier1Governance.alignment || null
      },
      ts: nowIso()
    }) + '\n');
    return;
  }
  const budget = loadDailyBudget(dateStr);
  const budgetAutopause = loadSystemBudgetAutopauseState();
  const autopauseActive = !!(budgetAutopause && budgetAutopause.active === true && Number(budgetAutopause.until_ms || 0) > Date.now());
  const autopauseBypassCountToday = Array.isArray(priorRunsForPolicyHoldCooldown)
    ? priorRunsForPolicyHoldCooldown.filter((evt) => evt && evt.type === 'autonomy_run' && evt.result === 'budget_autopause_canary_bypass').length
    : 0;
  const executionReserveBypassCountToday = Array.isArray(priorRunsForPolicyHoldCooldown)
    ? priorRunsForPolicyHoldCooldown.filter((evt) => evt && evt.type === 'autonomy_run' && evt.result === 'budget_autopause_execution_reserve_bypass').length
    : 0;
  const canaryBudgetAutopauseBypassAllowed = !shadowOnly
    && autopauseActive
    && AUTONOMY_BUDGET_AUTOPAUSE_CANARY_BYPASS_ENABLED
    && executionMode === 'canary_execute'
    && proposalRisk === 'low'
    && estTokens <= AUTONOMY_BUDGET_AUTOPAUSE_CANARY_BYPASS_MAX_TOKENS
    && (budget.used_est + estTokens) <= budget.token_cap
    && autopauseBypassCountToday < AUTONOMY_BUDGET_AUTOPAUSE_CANARY_BYPASS_MAX_PER_DAY;
  const executionReserveBypassAllowed = !shadowOnly
    && autopauseActive
    && executionMode === 'score_only'
    && AUTONOMY_BUDGET_EXECUTION_RESERVE_AUTOPAUSE_BYPASS_ENABLED
    && executionFloorShippedDeficit
    && proposalRisk === 'low'
    && AUTONOMY_BUDGET_EXECUTION_RESERVE_ENABLED
    && Number(budgetPacingState.execution_reserve_remaining || 0) >= estTokens
    && estTokens <= AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_MAX_TOKENS
    && executionReserveBypassCountToday < AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_MAX_PER_DAY
    && (budget.used_est + estTokens) <= budget.token_cap;
  if (autopauseActive && shadowOnly) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'budget_autopause_shadow_bypass',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      budget_autopause: {
        source: budgetAutopause.source || null,
        reason: budgetAutopause.reason || null,
        pressure: budgetAutopause.pressure || null,
        until: budgetAutopause.until || null
      }
    });
  }
  if (canaryBudgetAutopauseBypassAllowed) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'budget_autopause_canary_bypass',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      budget_autopause: {
        source: budgetAutopause.source || null,
        reason: budgetAutopause.reason || null,
        pressure: budgetAutopause.pressure || null,
        until: budgetAutopause.until || null
      },
      bypass: {
        execution_mode: executionMode,
        proposal_risk: proposalRisk,
        est_tokens: estTokens,
        used_est: budget.used_est,
        token_cap: budget.token_cap,
        max_tokens: AUTONOMY_BUDGET_AUTOPAUSE_CANARY_BYPASS_MAX_TOKENS,
        bypass_count_today: autopauseBypassCountToday,
        bypass_limit_per_day: AUTONOMY_BUDGET_AUTOPAUSE_CANARY_BYPASS_MAX_PER_DAY
      }
    });
  }
  if (executionReserveBypassAllowed) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'budget_autopause_execution_reserve_bypass',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      budget_autopause: {
        source: budgetAutopause.source || null,
        reason: budgetAutopause.reason || null,
        pressure: budgetAutopause.pressure || null,
        until: budgetAutopause.until || null
      },
      bypass: {
        execution_mode: executionMode,
        proposal_risk: proposalRisk,
        est_tokens: estTokens,
        used_est: budget.used_est,
        token_cap: budget.token_cap,
        reserve_remaining: Number(budgetPacingState.execution_reserve_remaining || 0),
        shipped_today: shippedToday,
        min_shipped_per_day: AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_MIN_SHIPPED_PER_DAY,
        bypass_count_today: executionReserveBypassCountToday,
        bypass_limit_per_day: AUTONOMY_SCORE_ONLY_EXECUTION_FLOOR_MAX_PER_DAY
      }
    });
  }
  if (autopauseActive && !shadowOnly) {
    if (!canaryBudgetAutopauseBypassAllowed && !executionReserveBypassAllowed) {
      writeRun(dateStr, {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'stop_init_gate_budget_autopause',
        policy_hold: true,
        hold_scope: 'budget',
        hold_reason: budgetAutopause && budgetAutopause.reason ? String(budgetAutopause.reason) : 'budget_autopause',
        proposal_id: p.id,
        capability_key: capabilityKey,
        directive_pulse: directivePulse,
        budget_autopause: {
          source: budgetAutopause.source || null,
          reason: budgetAutopause.reason || null,
          pressure: budgetAutopause.pressure || null,
          until: budgetAutopause.until || null
        }
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_init_gate_budget_autopause',
        policy_hold: true,
        hold_scope: 'budget',
        hold_reason: budgetAutopause && budgetAutopause.reason ? String(budgetAutopause.reason) : 'budget_autopause',
        proposal_id: p.id,
        capability_key: capabilityKey,
        directive_pulse: directivePulse,
        budget_autopause: {
          source: budgetAutopause.source || null,
          reason: budgetAutopause.reason || null,
          pressure: budgetAutopause.pressure || null,
          until: budgetAutopause.until || null
        },
        ts: nowIso()
      }) + '\n');
      return;
    }
  }
  if ((budget.used_est + estTokens) > budget.token_cap) {
    try {
      writeSystemBudgetDecision({
        date: dateStr,
        module: 'autonomy_controller',
        capability: capabilityKey || null,
        request_tokens_est: estTokens,
        decision: 'deny',
        reason: 'autonomy_budget_cap_exceeded'
      }, {
        state_dir: DAILY_BUDGET_DIR,
        allow_strategy: false
      });
      setSystemBudgetAutopause({
        date: dateStr,
        source: 'autonomy_controller',
        pressure: 'hard',
        reason: 'autonomy_budget_cap_exceeded',
        minutes: AUTONOMY_BUDGET_AUTOPAUSE_MINUTES
      });
    } catch {
      // fail-open: budget telemetry should never block execution gates
    }
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'skip_budget_cap',
      proposal_id: p.id,
      capability_key: capabilityKey,
      used_est: budget.used_est,
      token_cap: budget.token_cap,
      est_tokens: estTokens
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'skip_budget_cap',
      proposal_id: p.id,
      capability_key: capabilityKey,
      used_est: budget.used_est,
      token_cap: budget.token_cap,
      est_tokens: estTokens,
      ts: nowIso()
    }) + '\n');
    return;
  }
  const eyeRef = sourceEyeRef(p);
  const eyeId = sourceEyeId(p);
  const repeats14d = Math.max(1, countEyeProposalsInWindow(eyeId, proposalDate, 14));
  const errors30d = countEyeOutcomesInWindow(decisionEvents, eyeRef, 'reverted', proposalDate, 30);
  const routeTokensEst = repeats14d >= 3 ? Math.max(estTokens, AUTONOMY_MIN_ROUTE_TOKENS) : estTokens;
  const maxTokensPerAction = Number.isFinite(Number(strategyBudget.max_tokens_per_action))
    ? Number(strategyBudget.max_tokens_per_action)
    : null;
  if (maxTokensPerAction != null && routeTokensEst > maxTokensPerAction) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_init_gate_per_action_token_cap',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      est_tokens: estTokens,
      route_tokens_est: routeTokensEst,
      max_tokens_per_action: maxTokensPerAction
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_init_gate_per_action_token_cap',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      est_tokens: estTokens,
      route_tokens_est: routeTokensEst,
      max_tokens_per_action: maxTokensPerAction,
      ts: nowIso()
    }) + '\n');
    return;
  }
  if (capabilityLimit != null && capabilityAttemptsToday >= capabilityLimit) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_repeat_gate_capability_cap',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      capability_attempts_today: capabilityAttemptsToday,
      capability_daily_cap: capabilityLimit
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_capability_cap',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      capability_attempts_today: capabilityAttemptsToday,
      capability_daily_cap: capabilityLimit,
      ts: nowIso()
    }) + '\n');
    return;
  }

  const finalAdmission = strategyAdmissionDecision(p, strategy, {
    dedup_key: proposalDedupKey(p),
    recent_key_counts: recentProposalKeyCounts(dateStr, strategyDuplicateWindowHours(strategy, 24))
  });
  if (!finalAdmission.allow) {
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'stop_init_gate_strategy_recheck',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      admission_reason: finalAdmission.reason || 'unknown'
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_init_gate_strategy_recheck',
      proposal_id: p.id,
      capability_key: capabilityKey,
      directive_pulse: directivePulse,
      admission_reason: finalAdmission.reason || 'unknown',
      ts: nowIso()
    }) + '\n');
    return;
  }

  const task = makeTaskFromProposal(p);
  const receiptId = `auto_${Date.now()}_${String(p.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)}`;

  const preflight: AnyObj = directiveClarification
    ? runDirectiveClarificationValidate(directiveClarification, true)
    : directiveDecomposition
      ? runDirectiveDecomposition(directiveDecomposition, true)
    : actuationSpec
      ? runActuationExecute(actuationSpec, true)
      : runRouteExecute(task, routeTokensEst, repeats14d, errors30d, true, sourceEyeId(p));
  const preSummary = preflight.summary || null;
  const preBlocked = !preflight.ok
    || !preSummary
    || preSummary.executable !== true
    || preSummary.gate_decision === 'MANUAL'
    || preSummary.gate_decision === 'DENY';
  const preTokenUsage = computeExecutionTokenUsage(preSummary, preflight.execution_metrics, routeTokensEst, estTokens);
  const proposalDependencies = proposalDependencySummary(p, directiveAction, preSummary || null) || proposalDependenciesBase;

  if (preBlocked) {
    const blockReason = !preflight.ok
      ? `${executionTarget}_exit_${preflight.code}`
      : (preSummary && preSummary.gate_decision === 'MANUAL')
        ? 'gate_manual'
        : (preSummary && preSummary.gate_decision === 'DENY')
          ? 'gate_deny'
          : 'not_executable';
    const preflightException = trackTier1Exception(
      dateStr,
      `preflight_${executionTarget}`,
      blockReason,
      shortText((preflight.stderr || preflight.stdout || (preSummary && preSummary.reason) || blockReason), 320),
      {
        proposal_id: p.id,
        proposal_type: String(p.type || ''),
        capability_key: capabilityKey,
        execution_target: executionTarget,
        risk: proposalRisk
      }
    );
    maybeWriteNovelExceptionRun(dateStr, {
      ...preflightException,
      proposal_id: p.id,
      receipt_id: receiptId,
      capability_key: capabilityKey,
      execution_target: executionTarget,
      risk: proposalRisk,
      gate: 'preflight'
    });
    const reason = `auto:init_gate ${blockReason} cooldown_${AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS}h`;
    setCooldown(p.id, AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS, reason);
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'init_gate_blocked_route',
      receipt_id: receiptId,
      proposal_id: p.id,
      objective_id: executionObjectiveId || null,
      proposal_date: proposalDate,
      capability_key: capabilityKey,
      execution_target: executionTarget,
      proposal_dependencies: proposalDependencies,
      directive_pulse: directivePulse,
      score: Number(pick.score.toFixed(3)),
      route_summary: preSummary,
      token_usage: preTokenUsage,
      route_code: preflight.code,
      route_block_reason: blockReason,
      exception_novelty: preflightException,
      repeats_14d: repeats14d,
      errors_30d: errors30d,
      dopamine
    });
    const preflightCriteriaPolicy = successCriteriaPolicyForProposal(p);
    const preflightMetricValues = extractSuccessCriteriaMetricValues(p, {
      exec_summary: preSummary,
      execution_metrics: preflight && preflight.execution_metrics,
      exec_details: preflight && preflight.details,
      exec_stdout: preflight && preflight.stdout,
      dod_diff: {}
    });
    const preflightSuccessCriteria = evaluateSuccessCriteria(
      p,
      {
        phase: 'preflight_blocked',
        capability_key: capabilityKey,
        outcome: 'reverted',
        exec_ok: false,
        dod_passed: false,
        postconditions_ok: false,
        queue_outcome_logged: false,
        duration_ms: Number(preflight && preflight.execution_metrics && preflight.execution_metrics.duration_ms || 0),
        token_usage: preTokenUsage,
        dod_diff: {},
        metric_values: preflightMetricValues || {}
      },
      {
        required: preflightCriteriaPolicy.required,
        min_count: preflightCriteriaPolicy.min_count,
        capability_key: capabilityKey
      }
    );
    const preflightVerificationBase = withSuccessCriteriaVerification({
      checks: [{ name: 'preflight_executable', pass: false }],
      failed: ['preflight_executable'],
      passed: false,
      outcome: 'reverted',
      primary_failure: blockReason
    }, preflightSuccessCriteria, {
      fallback: { required: preflightCriteriaPolicy.required, min_count: preflightCriteriaPolicy.min_count }
    });
    const preflightVerification = withSuccessCriteriaQualityAudit(preflightVerificationBase);
    writeReceipt(dateStr, {
      ts: nowIso(),
      type: 'autonomy_action_receipt',
      receipt_id: receiptId,
      proposal_id: p.id,
      proposal_date: proposalDate,
      verdict: 'fail',
      intent: {
        task_hash: hashObj({ task }),
        objective_id: executionObjectiveId || null,
        actuation: actuationSpec ? { kind: actuationSpec.kind } : null,
        proposal_dependencies: proposalDependencies,
        route_tokens_est: routeTokensEst,
        repeats_14d: repeats14d,
        errors_30d: errors30d,
        success_criteria_policy: {
          required: preflightCriteriaPolicy.required === true,
          min_count: Number(preflightCriteriaPolicy.min_count || 0)
        }
      },
      execution: {
        preflight: compactCmdResult(preflight),
        token_usage: preTokenUsage
      },
      verification: preflightVerification
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'init_gate_blocked_route',
      receipt_id: receiptId,
      proposal_id: p.id,
      objective_id: executionObjectiveId || null,
      capability_key: capabilityKey,
      execution_target: executionTarget,
      proposal_dependencies: proposalDependencies,
      directive_pulse: directivePulse,
      route_block_reason: blockReason,
      exception_novelty: preflightException,
      route_summary: preSummary,
      token_usage: preTokenUsage,
      repeats_14d: repeats14d,
      errors_30d: errors30d,
      ts: nowIso()
    }) + '\n');
    return;
  }

  const preExecCriteriaPolicy = successCriteriaPolicyForProposal(p);
  const preExecMetricValues = extractSuccessCriteriaMetricValues(p, {
    exec_summary: preSummary,
    execution_metrics: preflight && preflight.execution_metrics,
    exec_details: preflight && preflight.details,
    exec_stdout: preflight && preflight.stdout,
    dod_diff: {}
  });
  const preExecSuccessCriteria = evaluateSuccessCriteria(
    p,
    {
      phase: 'pre_exec_gate',
      capability_key: capabilityKey,
      outcome: 'no_change',
      exec_ok: true,
      dod_passed: false,
      postconditions_ok: true,
      queue_outcome_logged: false,
      duration_ms: Number(preflight && preflight.execution_metrics && preflight.execution_metrics.duration_ms || 0),
      token_usage: preTokenUsage,
      dod_diff: {},
      metric_values: preExecMetricValues || {}
    },
    {
      required: preExecCriteriaPolicy.required,
      min_count: preExecCriteriaPolicy.min_count,
      capability_key: capabilityKey,
      enforce_contract: true,
      enforce_min_supported: true
    }
  );
  const preExecCriteriaGate = preExecCriteriaGateDecision(preExecSuccessCriteria, preExecCriteriaPolicy);
  if (AUTONOMY_PREEXEC_CRITERIA_GATE_ENABLED && !preExecCriteriaGate.pass) {
    recordCriteriaPatternOutcome(p, capabilityKey, preExecSuccessCriteria);
    const gateReason = String(preExecCriteriaGate.reasons && preExecCriteriaGate.reasons[0] || 'criteria_gate_failed');
    const reason = `auto:init_gate ${gateReason} cooldown_${AUTONOMY_PREEXEC_CRITERIA_COOLDOWN_HOURS}h`;
    setCooldown(p.id, AUTONOMY_PREEXEC_CRITERIA_COOLDOWN_HOURS, reason);
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'init_gate_blocked_success_criteria',
      receipt_id: receiptId,
      proposal_id: p.id,
      objective_id: executionObjectiveId || null,
      proposal_date: proposalDate,
      capability_key: capabilityKey,
      execution_target: executionTarget,
      proposal_dependencies: proposalDependencies,
      directive_pulse: directivePulse,
      score: Number(pick.score.toFixed(3)),
      route_summary: preSummary,
      token_usage: preTokenUsage,
      criteria_gate: preExecCriteriaGate,
      repeats_14d: repeats14d,
      errors_30d: errors30d
    });
    const preExecVerificationBase = withSuccessCriteriaVerification({
      checks: [{ name: 'pre_exec_criteria_gate', pass: false }],
      failed: ['pre_exec_criteria_gate'],
      passed: false,
      outcome: 'reverted',
      primary_failure: gateReason
    }, preExecSuccessCriteria, {
      fallback: { required: preExecCriteriaPolicy.required, min_count: preExecCriteriaPolicy.min_count }
    });
    const preExecVerification = withSuccessCriteriaQualityAudit(preExecVerificationBase);
    writeReceipt(dateStr, {
      ts: nowIso(),
      type: 'autonomy_action_receipt',
      receipt_id: receiptId,
      proposal_id: p.id,
      proposal_date: proposalDate,
      verdict: 'fail',
      intent: {
        task_hash: hashObj({ task }),
        objective_id: executionObjectiveId || null,
        actuation: actuationSpec ? { kind: actuationSpec.kind } : null,
        proposal_dependencies: proposalDependencies,
        route_tokens_est: routeTokensEst,
        repeats_14d: repeats14d,
        errors_30d: errors30d,
        success_criteria_policy: {
          required: preExecCriteriaPolicy.required === true,
          min_count: Number(preExecCriteriaPolicy.min_count || 0)
        }
      },
      execution: {
        preflight: compactCmdResult(preflight),
        token_usage: preTokenUsage,
        pre_exec_criteria_gate: preExecCriteriaGate
      },
      verification: preExecVerification
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'init_gate_blocked_success_criteria',
      receipt_id: receiptId,
      proposal_id: p.id,
      objective_id: executionObjectiveId || null,
      capability_key: capabilityKey,
      execution_target: executionTarget,
      proposal_dependencies: proposalDependencies,
      directive_pulse: directivePulse,
      route_summary: preSummary,
      token_usage: preTokenUsage,
      criteria_gate: preExecCriteriaGate,
      ts: nowIso()
    }) + '\n');
    return;
  }

  const executeConfidencePolicy = pick.execute_confidence_policy || computeExecuteConfidencePolicy(
    dateStr,
    p,
    capabilityKey,
    proposalRisk,
    executionMode
  );
  const executeConfidenceCompositeMargin = Math.max(
    0,
    Number(
      executeConfidencePolicy
      && executeConfidencePolicy.applied
      && executeConfidencePolicy.applied.composite_margin
      || AUTONOMY_EXECUTE_CONFIDENCE_MARGIN
    )
  );
  const executeConfidenceValueMargin = Math.max(
    0,
    Number(
      executeConfidencePolicy
      && executeConfidencePolicy.applied
      && executeConfidencePolicy.applied.value_margin
      || AUTONOMY_EXECUTE_MIN_VALUE_SIGNAL_BONUS
    )
  );
  const executeConfidenceMinComposite = Math.max(0, Number(compositeMinScore || 0) + executeConfidenceCompositeMargin);
  const executeConfidenceMinValue = Math.max(
    0,
    Number(AUTONOMY_MIN_VALUE_SIGNAL_SCORE || 0)
      + executeConfidenceValueMargin
      + (proposalRisk === 'medium' ? Number(AUTONOMY_MEDIUM_RISK_VALUE_SIGNAL_BONUS || 0) : 0)
  );
  const executeValueSignal = Number(pick && pick.value_signal ? pick.value_signal.score || 0 : 0);
  if (
    !shadowOnly
    && isExecuteMode(executionMode)
    && (
      Number(pick && pick.composite_score || 0) < executeConfidenceMinComposite
      || executeValueSignal < executeConfidenceMinValue
    )
  ) {
    const confidenceHistory = executeConfidencePolicy && executeConfidencePolicy.history && typeof executeConfidencePolicy.history === 'object'
      ? executeConfidencePolicy.history
      : {};
    const confidenceFallbackHits = Math.max(0, Number(confidenceHistory.confidence_fallback || 0));
    const confidenceLoopDetected = (confidenceFallbackHits + 1) >= AUTONOMY_EXECUTE_CONFIDENCE_LOOP_ESCALATE_THRESHOLD;
    const confidenceProposalCooldownHours = confidenceLoopDetected
      ? Math.max(AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS, AUTONOMY_EXECUTE_CONFIDENCE_LOOP_COOLDOWN_HOURS)
      : AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS;
    const confidenceLaneHoursBase = Math.max(
      1,
      Number(AUTONOMY_EXECUTE_CONFIDENCE_LANE_COOLDOWN_HOURS || AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS)
    );
    const confidenceLaneHours = confidenceLoopDetected
      ? Math.max(confidenceLaneHoursBase, confidenceProposalCooldownHours)
      : confidenceLaneHoursBase;
    const confidenceHoldReason = confidenceLoopDetected
      ? `auto:execute_confidence_fallback_loop cooldown_${confidenceProposalCooldownHours}h hits_${confidenceFallbackHits + 1}`
      : `auto:execute_confidence_fallback cooldown_${confidenceProposalCooldownHours}h`;
    const confidenceLaneKey = executeConfidenceCooldownKey(
      capabilityKey,
      executionObjectiveId,
      String(p.type || '')
    );
    setCooldown(p.id, confidenceProposalCooldownHours, confidenceHoldReason);
    if (confidenceLaneKey) {
      setCooldown(
        confidenceLaneKey,
        confidenceLaneHours,
        `${confidenceHoldReason} lane:${confidenceLaneKey}`
      );
    }
    if (confidenceLoopDetected && capabilityKey) {
      setCapabilityCooldown(
        capabilityKey,
        confidenceLaneHours,
        `${confidenceHoldReason} capability:${capabilityKey}`
      );
    }
    const confidenceCooldown = cooldownEntry(p.id);
    const confidenceNextClearAt = confidenceCooldown ? (confidenceCooldown.until || null) : null;
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'score_only_fallback_low_execution_confidence',
      policy_hold: true,
      hold_scope: 'proposal',
      proposal_id: p.id,
      objective_id: executionObjectiveId || null,
      proposal_date: proposalDate,
      proposal_type: String(p.type || ''),
      risk: proposalRisk,
      capability_key: capabilityKey,
      execution_mode: executionMode,
      objective_binding: {
        required: objectiveBinding.required === true,
        objective_id: objectiveBinding.objective_id || null,
        source: objectiveBinding.source || null
      },
      directive_pulse: directivePulse
        ? {
            objective_id: directivePulse.objective_id || null,
            tier: directivePulse.tier == null ? null : directivePulse.tier,
            objective_allocation_score: Number(directivePulse.objective_allocation_score || 0)
          }
        : null,
      score: Number(pick.score.toFixed(3)),
      cooldown_hours: confidenceProposalCooldownHours,
      execute_confidence_lane_cooldown_hours: confidenceLaneHours,
      execute_confidence_cooldown_key: confidenceLaneKey || null,
      execute_confidence_fallback_hits_window: confidenceFallbackHits + 1,
      execute_confidence_loop_detected: confidenceLoopDetected,
      next_clear_at: confidenceNextClearAt,
      hold_reason: confidenceHoldReason,
      confidence_gate: {
        composite_score: Number(pick && pick.composite_score || 0),
        composite_min_required: executeConfidenceMinComposite,
        value_signal_score: executeValueSignal,
        value_signal_min_required: executeConfidenceMinValue,
        margin_composite: executeConfidenceCompositeMargin,
        margin_value_signal: executeConfidenceValueMargin,
        policy: executeConfidencePolicy
      }
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'score_only_fallback_low_execution_confidence',
      policy_hold: true,
      hold_scope: 'proposal',
      proposal_id: p.id,
      objective_id: executionObjectiveId || null,
      capability_key: capabilityKey,
      execution_mode: executionMode,
      objective_binding: {
        required: objectiveBinding.required === true,
        objective_id: objectiveBinding.objective_id || null,
        source: objectiveBinding.source || null
      },
      directive_pulse: directivePulse
        ? {
            objective_id: directivePulse.objective_id || null,
            tier: directivePulse.tier == null ? null : directivePulse.tier,
            objective_allocation_score: Number(directivePulse.objective_allocation_score || 0)
          }
        : null,
      cooldown_hours: confidenceProposalCooldownHours,
      execute_confidence_lane_cooldown_hours: confidenceLaneHours,
      execute_confidence_cooldown_key: confidenceLaneKey || null,
      execute_confidence_fallback_hits_window: confidenceFallbackHits + 1,
      execute_confidence_loop_detected: confidenceLoopDetected,
      next_clear_at: confidenceNextClearAt,
      hold_reason: confidenceHoldReason,
      confidence_gate: {
        composite_score: Number(pick && pick.composite_score || 0),
        composite_min_required: executeConfidenceMinComposite,
        value_signal_score: executeValueSignal,
        value_signal_min_required: executeConfidenceMinValue,
        margin_composite: executeConfidenceCompositeMargin,
        margin_value_signal: executeConfidenceValueMargin,
        policy: executeConfidencePolicy
      },
      ts: nowIso()
    }) + '\n');
    return;
  }

  const acceptRes = pick.status !== 'accepted'
    ? runProposalQueue('accept', p.id, 'auto:autonomy_controller selected')
    : { ok: true, code: 0, stdout: 'already_accepted', stderr: '', skipped: true };

  if (!acceptRes.ok) {
    const reason = `auto:init_gate accept_failed cooldown_${AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS}h`;
    setCooldown(p.id, AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS, reason);
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'init_gate_accept_failed',
      receipt_id: receiptId,
      proposal_id: p.id,
      objective_id: executionObjectiveId || null,
      proposal_date: proposalDate,
      capability_key: capabilityKey,
      proposal_dependencies: proposalDependencies,
      directive_pulse: directivePulse,
      score: Number(pick.score.toFixed(3)),
      accept_result: compactCmdResult(acceptRes),
      token_usage: preTokenUsage,
      repeats_14d: repeats14d,
      errors_30d: errors30d
    });
    const acceptCriteriaPolicy = successCriteriaPolicyForProposal(p);
    const acceptMetricValues = extractSuccessCriteriaMetricValues(p, {
      exec_summary: preSummary,
      execution_metrics: preflight && preflight.execution_metrics,
      exec_details: preflight && preflight.details,
      exec_stdout: preflight && preflight.stdout,
      dod_diff: {}
    });
    const acceptSuccessCriteria = evaluateSuccessCriteria(
      p,
      {
        phase: 'accept_failed',
        capability_key: capabilityKey,
        outcome: 'reverted',
        exec_ok: false,
        dod_passed: false,
        postconditions_ok: false,
        queue_outcome_logged: false,
        duration_ms: Number(preflight && preflight.execution_metrics && preflight.execution_metrics.duration_ms || 0),
        token_usage: preTokenUsage,
        dod_diff: {},
        metric_values: acceptMetricValues || {}
      },
      {
        required: acceptCriteriaPolicy.required,
        min_count: acceptCriteriaPolicy.min_count,
        capability_key: capabilityKey
      }
    );
    const acceptVerificationBase = withSuccessCriteriaVerification({
      checks: [{ name: 'queue_accept_logged', pass: false }],
      failed: ['queue_accept_logged'],
      passed: false,
      outcome: 'reverted',
      primary_failure: 'queue_accept_logged'
    }, acceptSuccessCriteria, {
      fallback: { required: acceptCriteriaPolicy.required, min_count: acceptCriteriaPolicy.min_count }
    });
    const acceptVerification = withSuccessCriteriaQualityAudit(acceptVerificationBase);
    writeReceipt(dateStr, {
      ts: nowIso(),
      type: 'autonomy_action_receipt',
      receipt_id: receiptId,
      proposal_id: p.id,
      proposal_date: proposalDate,
      verdict: 'fail',
      intent: {
        task_hash: hashObj({ task }),
        objective_id: executionObjectiveId || null,
        actuation: actuationSpec ? { kind: actuationSpec.kind } : null,
        directive_validation: directiveAction
          ? {
              decision: directiveAction.decision || null,
              objective_id: directiveAction.objective_id || null,
              file: directiveClarification ? (directiveClarification.file || null) : null
            }
          : null,
        proposal_dependencies: proposalDependencies,
        route_tokens_est: routeTokensEst,
        repeats_14d: repeats14d,
        errors_30d: errors30d,
        success_criteria_policy: {
          required: acceptCriteriaPolicy.required === true,
          min_count: Number(acceptCriteriaPolicy.min_count || 0)
        }
      },
      execution: {
        preflight: compactCmdResult(preflight),
        accept: compactCmdResult(acceptRes),
        token_usage: preTokenUsage
      },
      verification: acceptVerification
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'init_gate_accept_failed',
      receipt_id: receiptId,
      proposal_id: p.id,
      objective_id: executionObjectiveId || null,
      capability_key: capabilityKey,
      proposal_dependencies: proposalDependencies,
      directive_pulse: directivePulse,
      token_usage: preTokenUsage,
      ts: nowIso()
    }) + '\n');
    return;
  }

  const experiment = {
    ts: nowIso(),
    type: 'experiment_card',
    receipt_id: receiptId,
    strategy_id: strategy ? strategy.id : null,
    execution_mode: executionMode,
    proposal_id: p.id,
    objective_id: executionObjectiveId || null,
    proposal_date: proposalDate,
    title: p.title || '',
    hypothesis: `Executing one bounded action for ${p.id} improves measurable progress without policy violations.`,
    success_metric: 'Executable route decision with non-error exit and tracked outcome.',
    token_budget_est: estTokens,
    route_tokens_est: routeTokensEst,
    repeats_14d: repeats14d,
    errors_30d: errors30d,
    dopamine,
    signal_quality: pick.quality,
    directive_fit: pick.directive_fit,
    actionability: pick.actionability,
    value_signal: pick.value_signal || null,
    objective_binding: objectiveBinding,
    directive_pulse: directivePulse,
    campaign_match: campaignMatch,
    campaign_plan: campaignPlan,
    proposal_dependencies: proposalDependencies,
    composite: {
      score: pick.composite_score,
      min_score: compositeMinScore,
      base_min_score: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
      pass: pick.composite_score >= compositeMinScore
    },
    selection_mode: selection.mode,
    selection_index: selection.index,
    strategy_rank: pick.strategy_rank || null,
    strategy_rank_bonus: pick.strategy_rank_bonus || null,
    strategy_rank_adjusted: Number(pick.strategy_rank_adjusted || (pick.strategy_rank && pick.strategy_rank.score) || 0),
    thresholds,
    calibration_metrics: calibrationProfile.metrics,
    route_preflight: preSummary,
    actuation: actuationSpec ? { kind: actuationSpec.kind } : null,
    stop_conditions: [
      `daily_token_cap=${budget.token_cap}`,
      `no_change_limit=${NO_CHANGE_LIMIT}`,
      'reverted_count>=1',
      'gate decision DENY or MANUAL',
      ...(executionMode === 'canary_execute' && canaryDailyExecLimit
        ? [`canary_daily_exec_limit=${Number(canaryDailyExecLimit)}`]
        : []),
      ...(executionMode === 'canary_execute' && mediumCanaryDailyExecLimit
        ? [`canary_medium_risk_daily_exec_limit=${Number(mediumCanaryDailyExecLimit)}`]
        : [])
    ],
    task
  };
  writeExperiment(dateStr, experiment);

  const beforeEvidence = loadDoDEvidenceSnapshot(dateStr);
  const painFocusTtlRaw = Number(process.env.AUTONOMY_PAIN_FOCUS_TTL_MINUTES || 30);
  const painFocusTtlMinutes = Number.isFinite(painFocusTtlRaw)
    ? Math.max(5, Math.min(180, Math.round(painFocusTtlRaw)))
    : 30;
  let painFocusSession: AnyObj = null;
  try {
    painFocusSession = startPainFocusSession({
      source: 'autonomy_controller',
      task: `execute:${String(p && p.id || 'unknown_proposal')}`,
      reason: 'active_autonomy_execution',
      ttl_minutes: painFocusTtlMinutes
    });
  } catch {
    painFocusSession = null;
  }
  const execStartMs = Date.now();
  const execRes: AnyObj = directiveClarification
    ? runDirectiveClarificationValidate(directiveClarification, false)
    : directiveDecomposition
      ? runDirectiveDecomposition(directiveDecomposition, false)
    : actuationSpec
      ? runActuationExecute(actuationSpec, false)
      : runRouteExecute(task, routeTokensEst, repeats14d, errors30d, false, sourceEyeId(p));
  try {
    const sid = painFocusSession && painFocusSession.session && painFocusSession.session.id
      ? String(painFocusSession.session.id)
      : '';
    if (sid) {
      stopPainFocusSession({
        session_id: sid,
        reason: 'execution_complete'
      });
    }
  } catch {
    // focus teardown should never block execution path
  }
  const execEndMs = Date.now();
  const afterEvidence = loadDoDEvidenceSnapshot(dateStr);
  const execTokenUsage = computeExecutionTokenUsage(execRes.summary || null, execRes.execution_metrics || null, routeTokensEst, estTokens);
  const recordedBudget = recordSystemBudgetUsage({
    date: dateStr,
    module: 'autonomy_controller',
    capability: capabilityKey || null,
    tokens_est: Number(execTokenUsage.effective_tokens || estTokens || 0)
  }, {
    state_dir: DAILY_BUDGET_DIR,
    allow_strategy: false
  });
  budget.used_est = Number(recordedBudget.used_est || budget.used_est || 0);
  budget.token_cap = Number(recordedBudget.token_cap || budget.token_cap || 0);

  const summary = execRes.summary || {};
  const routeExecutionHold = routeExecutionPolicyHold(summary, executionTarget);
  if (routeExecutionHold.hold && execRes.ok) {
    const holdReason = `auto:execute_route_hold ${routeExecutionHold.hold_reason || 'route_blocked'} cooldown_${AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS}h`;
    setCooldown(p.id, AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS, holdReason);
    const routeCooldown = cooldownEntry(p.id);
    const routeNextClearAt = routeCooldown ? (routeCooldown.until || null) : null;
    const holdEvidence = `proposal:${p.id} ${eyeRef} receipt:${receiptId} auto:route_hold:${routeExecutionHold.hold_reason || 'route_blocked'}`.slice(0, 220);
    const holdOutcomeRes = runProposalQueue('park', p.id, holdReason);
    const holdCriteriaPolicy = successCriteriaPolicyForProposal(p);
    const holdMetricValues = extractSuccessCriteriaMetricValues(p, {
      exec_summary: execRes && execRes.summary,
      execution_metrics: execRes && execRes.execution_metrics,
      exec_details: execRes && execRes.details,
      exec_stdout: execRes && execRes.stdout,
      outcome_stdout: holdOutcomeRes && holdOutcomeRes.stdout,
      dod_diff: {}
    });
    const holdSuccessCriteria = evaluateSuccessCriteria(
      p,
      {
        phase: 'execute_blocked',
        capability_key: capabilityKey,
        outcome: 'no_change',
        exec_ok: false,
        dod_passed: false,
        postconditions_ok: false,
        queue_outcome_logged: holdOutcomeRes && holdOutcomeRes.ok === true,
        duration_ms: Math.max(0, Number(execEndMs || 0) - Number(execStartMs || 0)),
        token_usage: execTokenUsage,
        dod_diff: {},
        metric_values: holdMetricValues || {}
      },
      {
        required: holdCriteriaPolicy.required,
        min_count: holdCriteriaPolicy.min_count,
        capability_key: capabilityKey
      }
    );
    const holdVerificationBase = withSuccessCriteriaVerification({
      checks: [
        { name: 'route_execute_ok', pass: true },
        { name: 'route_executable', pass: false },
        { name: 'queue_outcome_logged', pass: !!(holdOutcomeRes && holdOutcomeRes.ok) }
      ],
      failed: ['route_executable'],
      passed: false,
      outcome: 'no_change',
      primary_failure: `route_policy_hold:${routeExecutionHold.route_block_reason || 'route_blocked'}`
    }, holdSuccessCriteria, {
      fallback: { required: holdCriteriaPolicy.required, min_count: holdCriteriaPolicy.min_count },
      enforceNoChangeOnFailure: true
    });
    const holdVerification = withSuccessCriteriaQualityAudit(holdVerificationBase);
    writeReceipt(dateStr, {
      ts: nowIso(),
      type: 'autonomy_action_receipt',
      receipt_id: receiptId,
      proposal_id: p.id,
      proposal_date: proposalDate,
      verdict: 'fail',
      intent: {
        task_hash: hashObj({ task }),
        objective_id: executionObjectiveId || null,
        actuation: actuationSpec ? { kind: actuationSpec.kind } : null,
        directive_validation: directiveAction
          ? {
              decision: directiveAction.decision || null,
              objective_id: directiveAction.objective_id || null,
              file: directiveClarification ? (directiveClarification.file || null) : null
            }
          : null,
        proposal_dependencies: proposalDependencies,
        route_tokens_est: routeTokensEst,
        repeats_14d: repeats14d,
        errors_30d: errors30d,
        success_criteria_policy: {
          required: holdCriteriaPolicy.required === true,
          min_count: Number(holdCriteriaPolicy.min_count || 0)
        }
      },
      execution: {
        preflight: compactCmdResult(preflight),
        accept: compactCmdResult(acceptRes),
        execute: compactCmdResult(execRes),
        outcome: compactCmdResult(holdOutcomeRes),
        token_usage: execTokenUsage,
        outcome_retry_attempted: false,
        postconditions: {
          checks: [],
          failed: ['route_executable'],
          passed: false
        }
      },
      verification: {
        ...holdVerification,
        dod: {
          passed: false,
          class: null,
          reason: `route_policy_hold:${routeExecutionHold.route_block_reason || 'route_blocked'}`
        },
        cooldown_applied_hours: AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS
      }
    });
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_run',
      result: 'init_gate_blocked_route',
      legacy_result: 'executed',
      policy_hold: true,
      hold_scope: routeExecutionHold.hold_scope || 'proposal',
      hold_reason: routeExecutionHold.hold_reason || 'route_blocked',
      route_block_phase: 'execute',
      receipt_id: receiptId,
      strategy_id: strategy ? strategy.id : null,
      execution_mode: executionMode,
      proposal_id: p.id,
      objective_id: executionObjectiveId || null,
      capability_key: capabilityKey,
      execution_target: executionTarget,
      proposal_dependencies: proposalDependencies,
      proposal_date: proposalDate,
      proposal_type: String(p.type || ''),
      risk: proposalRisk,
      source_eye: sourceEyeId(p),
      proposal_key: proposalDedupKey(p),
      score: Number(pick.score.toFixed(3)),
      strategy_rank_adjusted: Number(pick.strategy_rank_adjusted || (pick.strategy_rank && pick.strategy_rank.score) || 0),
      est_tokens: estTokens,
      route_tokens_est: routeTokensEst,
      token_usage: execTokenUsage,
      repeats_14d: repeats14d,
      errors_30d: errors30d,
      used_est_after: budget.used_est,
      dopamine,
      signal_quality: pick.quality,
      directive_fit: pick.directive_fit,
      actionability: pick.actionability,
      value_signal: pick.value_signal || null,
      objective_binding: objectiveBinding,
      directive_pulse: directivePulse,
      campaign_match: campaignMatch,
      campaign_plan: campaignPlan,
      composite: {
        score: pick.composite_score,
        min_score: compositeMinScore,
        base_min_score: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
        pass: pick.composite_score >= compositeMinScore
      },
      selection_mode: selection.mode,
      selection_index: selection.index,
      strategy_rank: pick.strategy_rank || null,
      strategy_rank_bonus: pick.strategy_rank_bonus || null,
      explore_used_before: selection.explore_used,
      explore_quota: selection.explore_quota,
      thresholds,
      route_summary: summary,
      admission: admissionSummary,
      route_block_reason: routeExecutionHold.route_block_reason || 'route_blocked',
      cooldown_hours: AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS,
      next_clear_at: routeNextClearAt,
      exec_ok: execRes.ok,
      exec_code: execRes.code,
      outcome_write_ok: !!(holdOutcomeRes && holdOutcomeRes.ok),
      outcome: 'no_change',
      evidence: holdEvidence
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'init_gate_blocked_route',
      legacy_result: 'executed',
      policy_hold: true,
      hold_scope: routeExecutionHold.hold_scope || 'proposal',
      hold_reason: routeExecutionHold.hold_reason || 'route_blocked',
      route_block_phase: 'execute',
      receipt_id: receiptId,
      strategy_id: strategy ? strategy.id : null,
      execution_mode: executionMode,
      proposal_id: p.id,
      objective_id: executionObjectiveId || null,
      capability_key: capabilityKey,
      execution_target: executionTarget,
      proposal_dependencies: proposalDependencies,
      proposal_date: proposalDate,
      risk: proposalRisk,
      strategy_rank_adjusted: Number(pick.strategy_rank_adjusted || (pick.strategy_rank && pick.strategy_rank.score) || 0),
      est_tokens: estTokens,
      route_tokens_est: routeTokensEst,
      token_usage: execTokenUsage,
      repeats_14d: repeats14d,
      errors_30d: errors30d,
      used_est_after: budget.used_est,
      signal_quality: pick.quality,
      directive_fit: pick.directive_fit,
      actionability: pick.actionability,
      value_signal: pick.value_signal || null,
      objective_binding: objectiveBinding,
      directive_pulse: directivePulse,
      composite: {
        score: pick.composite_score,
        min_score: compositeMinScore,
        base_min_score: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
        pass: pick.composite_score >= compositeMinScore
      },
      selection_mode: selection.mode,
      selection_index: selection.index,
      strategy_rank: pick.strategy_rank || null,
      strategy_rank_bonus: pick.strategy_rank_bonus || null,
      explore_used_before: selection.explore_used,
      explore_quota: selection.explore_quota,
      outcome_write_ok: !!(holdOutcomeRes && holdOutcomeRes.ok),
      route_summary: summary,
      admission: admissionSummary,
      route_block_reason: routeExecutionHold.route_block_reason || 'route_blocked',
      cooldown_hours: AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS,
      next_clear_at: routeNextClearAt,
      ts: nowIso()
    }) + '\n');
    return;
  }
  const postconditions = runPostconditions(actuationSpec, execRes);
  const dod = evaluateDoD({
    summary,
    execRes,
    beforeEvidence,
    afterEvidence,
    execWindow: {
      start_ms: execStartMs,
      end_ms: execEndMs
    }
  });
  let outcome = 'no_change';
  let outcomeNote = `auto:autonomy dod_fail:${dod.reason}`;
  if (!execRes.ok) {
    outcome = 'reverted';
    outcomeNote = `auto:autonomy exec_failed code=${execRes.code}`;
  } else if (postconditions.passed !== true) {
    const failName = Array.isArray(postconditions.failed) && postconditions.failed.length ? postconditions.failed[0] : 'postconditions';
    outcome = 'reverted';
    outcomeNote = `auto:autonomy postcheck_fail:${failName}`;
  } else if (dod.passed === true) {
    outcome = 'shipped';
    outcomeNote = `auto:autonomy dod_pass:${dod.class}`;
  }

  let evidence = `proposal:${p.id} ${eyeRef} receipt:${receiptId} ${outcomeNote}`.slice(0, 220);
  let outcomeRes = runProposalQueue('outcome', p.id, outcome, evidence);
  let outcomeRecoveryAttempted = false;
  let outcomeFallbackLogged = false;
  let outcomeFallbackPath = null;
  if (!outcomeRes.ok) {
    outcomeRecoveryAttempted = true;
    const retryRes = runProposalQueue('outcome', p.id, outcome, evidence);
    if (retryRes && retryRes.ok) {
      outcomeRes = retryRes;
    } else if (outcome === 'shipped') {
      try {
        outcomeFallbackPath = path.join(OUTCOME_FALLBACK_DIR, `${dateStr}.jsonl`);
        writeOutcomeFallback(dateStr, {
          ts: nowIso(),
          type: 'autonomy_outcome_fallback',
          proposal_id: p.id,
          receipt_id: receiptId,
          objective_id: executionObjectiveId || null,
          capability_key: capabilityKey,
          outcome,
          evidence,
          reason: 'queue_outcome_logging_failed'
        });
        outcomeFallbackLogged = true;
        outcomeRes = {
          ok: true,
          code: 0,
          stdout: 'outcome_fallback_logged',
          stderr: retryRes && retryRes.stderr ? String(retryRes.stderr) : ''
        };
      } catch {
        outcome = 'reverted';
        outcomeNote = 'auto:autonomy verify_outcome_retry_reverted';
        evidence = `proposal:${p.id} ${eyeRef} receipt:${receiptId} ${outcomeNote}`.slice(0, 220);
        outcomeRes = runProposalQueue('outcome', p.id, outcome, evidence);
      }
    } else if (outcome !== 'reverted') {
      outcome = 'reverted';
      outcomeNote = 'auto:autonomy verify_outcome_retry_reverted';
      evidence = `proposal:${p.id} ${eyeRef} receipt:${receiptId} ${outcomeNote}`.slice(0, 220);
      outcomeRes = runProposalQueue('outcome', p.id, outcome, evidence);
    } else {
      outcomeRes = retryRes;
    }
  }

  const criteriaPolicy = successCriteriaPolicyForProposal(p);
  const successMetricValues = extractSuccessCriteriaMetricValues(p, {
    exec_summary: execRes && execRes.summary,
    execution_metrics: execRes && execRes.execution_metrics,
    exec_details: execRes && execRes.details,
    exec_stdout: execRes && execRes.stdout,
    outcome_stdout: outcomeRes && outcomeRes.stdout,
    dod_diff: dod && dod.diff && typeof dod.diff === 'object' ? dod.diff : {}
  });
  const successCriteria = evaluateSuccessCriteria(
    p,
    {
      capability_key: capabilityKey,
      outcome,
      exec_ok: execRes && execRes.ok === true,
      dod_passed: dod && dod.passed === true,
      postconditions_ok: postconditions && postconditions.passed === true,
      queue_outcome_logged: outcomeRes && outcomeRes.ok === true,
      duration_ms: Math.max(0, Number(execEndMs || 0) - Number(execStartMs || 0)),
      token_usage: execTokenUsage,
      dod_diff: dod && dod.diff && typeof dod.diff === 'object' ? dod.diff : {},
      metric_values: successMetricValues || {}
    },
    {
      required: criteriaPolicy.required,
      min_count: criteriaPolicy.min_count,
      capability_key: capabilityKey
    }
  );

  const verification = verifyExecutionReceipt(execRes, dod, outcomeRes, postconditions, successCriteria);
  recordCriteriaPatternOutcome(p, capabilityKey, successCriteria);
  const verifyException = verification.passed
    ? null
    : trackTier1Exception(
      dateStr,
      `verify_${executionTarget}`,
      verification.primary_failure || (!execRes.ok ? `${executionTarget}_exit_${execRes.code}` : 'verification_failed'),
      shortText([
        execRes && execRes.stderr ? execRes.stderr : '',
        execRes && execRes.stdout ? execRes.stdout : '',
        dod && dod.reason ? `dod:${dod.reason}` : '',
        Array.isArray(postconditions && postconditions.failed) ? postconditions.failed.join(',') : ''
      ].filter(Boolean).join(' | '), 320),
      {
        proposal_id: p.id,
        proposal_type: String(p.type || ''),
        capability_key: capabilityKey,
        execution_target: executionTarget,
        risk: proposalRisk,
        outcome: verification.outcome || null
      }
    );
  maybeWriteNovelExceptionRun(dateStr, {
    ...verifyException,
    proposal_id: p.id,
    receipt_id: receiptId,
    capability_key: capabilityKey,
    execution_target: executionTarget,
    risk: proposalRisk,
    gate: 'verify'
  });
  outcome = verification.outcome;
  let cooldownAppliedHours = 0;
  if (!verification.passed) {
    cooldownAppliedHours = outcome === 'reverted'
      ? REVERT_COOLDOWN_HOURS
      : AUTONOMY_ROUTE_BLOCK_COOLDOWN_HOURS;
    const reason = `auto:verify ${verification.primary_failure || 'unknown'} cooldown_${cooldownAppliedHours}h`;
    setCooldown(p.id, cooldownAppliedHours, reason);
    if (!outcomeRes.ok) {
      runProposalQueue('park', p.id, reason);
    }
  }

  if (proposalRisk === 'medium' && (outcome === 'no_change' || outcome === 'reverted')) {
    const laneHours = outcome === 'reverted'
      ? AUTONOMY_MEDIUM_RISK_REVERT_COOLDOWN_HOURS
      : AUTONOMY_MEDIUM_RISK_NO_CHANGE_COOLDOWN_HOURS;
    if (laneHours > 0) {
      const appliedHours = Math.max(Number(cooldownAppliedHours || 0), Number(laneHours));
      const laneReason = `auto:medium_risk_${outcome} cooldown_${appliedHours}h`;
      setCooldown(p.id, appliedHours, laneReason);
      cooldownAppliedHours = appliedHours;
    }
  }

  writeReceipt(dateStr, {
    ts: nowIso(),
    type: 'autonomy_action_receipt',
    receipt_id: receiptId,
    proposal_id: p.id,
    proposal_date: proposalDate,
    verdict: verification.passed ? 'pass' : 'fail',
    intent: {
      task_hash: hashObj({ task }),
      objective_id: executionObjectiveId || null,
      actuation: actuationSpec ? { kind: actuationSpec.kind } : null,
      directive_validation: directiveAction
        ? {
            decision: directiveAction.decision || null,
            objective_id: directiveAction.objective_id || null,
            file: directiveClarification ? (directiveClarification.file || null) : null
          }
        : null,
      proposal_dependencies: proposalDependencies,
      route_tokens_est: routeTokensEst,
      repeats_14d: repeats14d,
      errors_30d: errors30d,
      success_criteria_policy: {
        required: criteriaPolicy.required === true,
        min_count: Number(criteriaPolicy.min_count || 0)
      }
    },
      execution: {
        preflight: compactCmdResult(preflight),
        accept: compactCmdResult(acceptRes),
        execute: compactCmdResult(execRes),
        outcome: compactCmdResult(outcomeRes),
        token_usage: execTokenUsage,
        outcome_retry_attempted: outcomeRecoveryAttempted,
        outcome_fallback_logged: outcomeFallbackLogged,
        outcome_fallback_path: outcomeFallbackPath,
        postconditions
      },
    verification: {
      ...verification,
      dod: {
        passed: !!dod.passed,
        class: dod.class || null,
        reason: dod.reason || null
      },
      cooldown_applied_hours: cooldownAppliedHours
    }
  });

  writeRun(dateStr, {
    ts: nowIso(),
    type: 'autonomy_run',
    result: 'executed',
    receipt_id: receiptId,
    strategy_id: strategy ? strategy.id : null,
    execution_mode: executionMode,
    proposal_id: p.id,
    objective_id: executionObjectiveId || null,
    capability_key: capabilityKey,
    execution_target: executionTarget,
    proposal_dependencies: proposalDependencies,
    proposal_date: proposalDate,
    proposal_type: String(p.type || ''),
    risk: proposalRisk,
    source_eye: sourceEyeId(p),
    proposal_key: proposalDedupKey(p),
    score: Number(pick.score.toFixed(3)),
    strategy_rank_adjusted: Number(pick.strategy_rank_adjusted || (pick.strategy_rank && pick.strategy_rank.score) || 0),
    est_tokens: estTokens,
    route_tokens_est: routeTokensEst,
    token_usage: execTokenUsage,
    repeats_14d: repeats14d,
    errors_30d: errors30d,
    used_est_after: budget.used_est,
    dopamine,
    signal_quality: pick.quality,
    directive_fit: pick.directive_fit,
    actionability: pick.actionability,
    value_signal: pick.value_signal || null,
    objective_binding: objectiveBinding,
    directive_pulse: directivePulse,
    campaign_match: campaignMatch,
    campaign_plan: campaignPlan,
    composite: {
      score: pick.composite_score,
      min_score: compositeMinScore,
      base_min_score: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
      pass: pick.composite_score >= compositeMinScore
    },
    selection_mode: selection.mode,
    selection_index: selection.index,
    strategy_rank: pick.strategy_rank || null,
    strategy_rank_bonus: pick.strategy_rank_bonus || null,
    explore_used_before: selection.explore_used,
    explore_quota: selection.explore_quota,
    thresholds,
    route_summary: summary,
    admission: admissionSummary,
    dod,
    postconditions,
    verification,
    exception_novelty: verifyException,
    exec_ok: execRes.ok,
    exec_code: execRes.code,
    outcome_write_ok: !!outcomeRes.ok,
    outcome_fallback_logged: outcomeFallbackLogged,
    outcome_fallback_path: outcomeFallbackPath,
    outcome,
    evidence
  });

  process.stdout.write(JSON.stringify({
    ok: true,
    result: 'executed',
    receipt_id: receiptId,
    strategy_id: strategy ? strategy.id : null,
    execution_mode: executionMode,
    proposal_id: p.id,
    objective_id: executionObjectiveId || null,
    capability_key: capabilityKey,
    execution_target: executionTarget,
    proposal_dependencies: proposalDependencies,
    proposal_date: proposalDate,
    risk: proposalRisk,
    strategy_rank_adjusted: Number(pick.strategy_rank_adjusted || (pick.strategy_rank && pick.strategy_rank.score) || 0),
    est_tokens: estTokens,
    route_tokens_est: routeTokensEst,
    token_usage: execTokenUsage,
    repeats_14d: repeats14d,
    errors_30d: errors30d,
    used_est_after: budget.used_est,
    outcome,
    signal_quality: pick.quality,
    directive_fit: pick.directive_fit,
    actionability: pick.actionability,
    value_signal: pick.value_signal || null,
    objective_binding: objectiveBinding,
    directive_pulse: directivePulse,
    composite: {
      score: pick.composite_score,
      min_score: compositeMinScore,
      base_min_score: AUTONOMY_MIN_COMPOSITE_ELIGIBILITY,
      pass: pick.composite_score >= compositeMinScore
    },
    selection_mode: selection.mode,
    selection_index: selection.index,
    strategy_rank: pick.strategy_rank || null,
    strategy_rank_bonus: pick.strategy_rank_bonus || null,
    explore_used_before: selection.explore_used,
    explore_quota: selection.explore_quota,
    dod,
    postconditions,
    verification,
    exception_novelty: verifyException,
    outcome_write_ok: !!outcomeRes.ok,
    outcome_fallback_logged: outcomeFallbackLogged,
    outcome_fallback_path: outcomeFallbackPath,
    route_summary: summary,
    admission: admissionSummary,
    model_catalog_apply_pending: Number(modelCatalogSnapshot.pending_apply || 0),
    terminology_warnings: terminologyWarnings,
    ts: nowIso()
  }) + '\n');
}

function resetCmd(dateStr) {
  const scope = String(parseArg('scope') || 'gates').toLowerCase();
  const note = String(parseArg('note') || '').slice(0, 200);
  const allowed = new Set(['gates', 'budget', 'all']);
  if (!allowed.has(scope)) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: `invalid scope "${scope}" (expected: gates|budget|all)`,
      ts: nowIso()
    }) + '\n');
    process.exit(2);
  }

  const out: AnyObj = {
    ok: true,
    result: 'autonomy_reset',
    date: dateStr,
    scope,
    ts: nowIso()
  };

  if (scope === 'gates' || scope === 'all') {
    const cooldowns = getCooldowns();
    const cleared = Object.keys(cooldowns).length;
    saveJson(COOLDOWNS_PATH, {});
    writeRun(dateStr, {
      ts: nowIso(),
      type: 'autonomy_reset',
      scope: 'gates',
      cleared_cooldowns: cleared,
      note: note || null
    });
    out.cleared_cooldowns = cleared;
  }

  if (scope === 'budget' || scope === 'all') {
    const budget = loadDailyBudget(dateStr);
    const prevUsed = Number(budget.used_est || 0);
    budget.used_est = 0;
    saveDailyBudget(budget);
    out.budget = {
      token_cap: budget.token_cap,
      used_est_before: prevUsed,
      used_est_after: budget.used_est
    };
  }

  process.stdout.write(JSON.stringify(out) + '\n');
}

function readRunLockState() {
  try {
    if (!fs.existsSync(AUTONOMY_RUN_LOCK_PATH)) return null;
    return JSON.parse(fs.readFileSync(AUTONOMY_RUN_LOCK_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function lockAgeMinutes(lock) {
  const lockTs = String(lock && lock.ts || '');
  const nowMs = Date.now();
  if (AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED) {
    const rust = runBacklogAutoscalePrimitive(
      'lock_age_minutes',
      {
        lock_ts: lockTs,
        now_ms: nowMs
      },
      { allow_cli_fallback: true }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const age = rust.payload.payload.age_minutes;
      return age == null ? null : Number(age);
    }
  }
  const ts = Date.parse(lockTs);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, (nowMs - ts) / (60 * 1000));
}

function pidAlive(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    process.kill(id, 0);
    return true;
  } catch (err) {
    const code = String(err && (err as AnyObj).code || '');
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return null;
  }
}

function acquireAutonomyRunLock(meta) {
  const payload = {
    ts: nowIso(),
    pid: process.pid,
    mode: meta && meta.mode ? String(meta.mode) : 'run',
    date: meta && meta.date ? String(meta.date) : null
  };
  const staleMinutes = Number(AUTONOMY_RUN_LOCK_STALE_MINUTES || 0);
  fs.mkdirSync(path.dirname(AUTONOMY_RUN_LOCK_PATH), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(AUTONOMY_RUN_LOCK_PATH, 'wx');
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
      fs.closeSync(fd);
      return { ok: true, lock: payload };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        return { ok: false, code: 'lock_error', detail: String(err && err.message || err || 'lock_error') };
      }
      const existing = readRunLockState();
      const ageMinutes = lockAgeMinutes(existing);
      const existingPid = Number(existing && (existing as AnyObj).pid);
      const processAlive = pidAlive(existingPid);
      const staleByAge = Number.isFinite(ageMinutes) && staleMinutes > 0 && ageMinutes > staleMinutes;
      const staleByDeadPid = Number.isInteger(existingPid)
        && existingPid > 0
        && existingPid !== process.pid
        && processAlive === false
        && (
          !Number.isFinite(ageMinutes)
          || ageMinutes > AUTONOMY_RUN_LOCK_DEAD_PID_GRACE_MINUTES
        );
      const malformed = !existing || typeof existing !== 'object';
      const stale = staleByAge || staleByDeadPid || malformed;
      if (stale) {
        try {
          fs.unlinkSync(AUTONOMY_RUN_LOCK_PATH);
          continue;
        } catch {}
      }
      return {
        ok: false,
        code: 'lock_held',
        detail: 'another_autonomy_run_in_progress',
        lock: existing || null,
        age_minutes: ageMinutes,
        process_alive: processAlive
      };
    }
  }
  return { ok: false, code: 'lock_unavailable', detail: 'unable_to_acquire_lock' };
}

function releaseAutonomyRunLock() {
  try {
    if (fs.existsSync(AUTONOMY_RUN_LOCK_PATH)) fs.unlinkSync(AUTONOMY_RUN_LOCK_PATH);
  } catch {}
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/autonomy_controller.js run [YYYY-MM-DD]');
  console.log('  node systems/autonomy/autonomy_controller.js run-batch [YYYY-MM-DD] [--max=N]');
  console.log('  node systems/autonomy/autonomy_controller.js evidence [YYYY-MM-DD]');
  console.log('  node systems/autonomy/autonomy_controller.js readiness [YYYY-MM-DD]');
  console.log('  node systems/autonomy/autonomy_controller.js status [YYYY-MM-DD]');
  console.log('  node systems/autonomy/autonomy_controller.js scorecard [YYYY-MM-DD] [--days=N]');
  console.log('  node systems/autonomy/autonomy_controller.js reset [YYYY-MM-DD] [--scope=gates|budget|all] [--note=...]');
  console.log('  node systems/autonomy/autonomy_controller.js issue-canary-override [YYYY-MM-DD] --nonce=<token> --approve=<phrase> [--ttl_minutes=N] [--note=...]');
  console.log('  node systems/autonomy/autonomy_controller.js canary-override-status');
  console.log('  node systems/autonomy/autonomy_controller.js revoke-canary-override [YYYY-MM-DD]');
}

function runChildAutonomy(dateStr) {
  const childScript = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
  const child = spawnSync(process.execPath, [childScript, 'run', dateStr], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AUTONOMY_BATCH_CHILD: '1'
    }
  });
  const rawOut = String(child.stdout || '').trim();
  let payload = null;
  if (rawOut) {
    const lines = rawOut.split('\n').map(x => String(x || '').trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.startsWith('{')) continue;
      try {
        payload = JSON.parse(line);
        break;
      } catch {}
    }
  }
  return {
    ok: child.status === 0,
    code: child.status == null ? 1 : child.status,
    payload,
    stdout: rawOut,
    stderr: String(child.stderr || '').trim()
  };
}

function runBatchCmd(dateStr) {
  const argMax = parseArg('max');
  const envMax = process.env.AUTONOMY_BATCH_MAX;
  const hasArgMax = argMax != null && String(argMax).trim() !== '';
  const hasEnvMax = envMax != null && String(envMax).trim() !== '';
  const strategyBudget = effectiveStrategyBudget();
  const batchHint = suggestAutonomyRunBatchMax(dateStr, { strategyBudget });
  const rawMax = Number(
    hasArgMax
      ? argMax
      : (hasEnvMax ? envMax : Number(batchHint && batchHint.max || 3))
  );
  const max = Number.isFinite(rawMax) ? Math.max(1, Math.min(10, Math.round(rawMax))) : 3;
  const maxSource = hasArgMax ? 'arg' : (hasEnvMax ? 'env' : 'backlog_autoscale');
  const rows = [];
  let executed = 0;
  let stop = null;

  for (let i = 0; i < max; i++) {
    const child = runChildAutonomy(dateStr);
    const payload = child.payload && typeof child.payload === 'object'
      ? child.payload
      : {
          ok: child.ok,
          result: child.ok ? 'unknown' : `child_exit_${child.code}`
        };
    const result = String(payload.result || (child.ok ? 'unknown' : `child_exit_${child.code}`));
    rows.push({
      idx: i + 1,
      ok: child.ok,
      code: child.code,
      result,
      proposal_id: payload.proposal_id || null,
      receipt_id: payload.receipt_id || null,
      ts: payload.ts || nowIso()
    });
    if (!child.ok) {
      stop = `child_exit_${child.code}`;
      break;
    }
    if (result === 'executed') {
      executed += 1;
      continue;
    }
    stop = result;
    break;
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    result: 'batch_complete',
    date: dateStr,
    max,
    max_source: maxSource,
    backlog_autoscale: batchHint && batchHint.autoscale_hint ? {
      enabled: AUTONOMY_BACKLOG_AUTOSCALE_ENABLED,
      batch_on_run: AUTONOMY_BACKLOG_AUTOSCALE_BATCH_ON_RUN,
      reason: batchHint.reason || null,
      suggested_max: Number(batchHint.max || 1),
      daily_remaining: Number(batchHint.daily_remaining || 0),
      pressure: batchHint.autoscale_hint && batchHint.autoscale_hint.plan
        ? String(batchHint.autoscale_hint.plan.pressure || 'normal')
        : 'normal',
      action: batchHint.autoscale_hint && batchHint.autoscale_hint.plan
        ? String(batchHint.autoscale_hint.plan.action || 'hold')
        : 'hold',
      trit_productivity_active: !!(
        batchHint.autoscale_hint
        && batchHint.autoscale_hint.trit_productivity
        && batchHint.autoscale_hint.trit_productivity.active === true
      )
    } : null,
    executed,
    attempted: rows.length,
    stop_reason: stop || null,
    runs: rows
  }) + '\n');
}

function main() {
  ensureState();
  const cmd = process.argv[2] || '';
  const dateStr = dateArgOrToday(process.argv[3]);

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    process.exit(0);
  }

  if (cmd === 'status') return statusCmd(dateStr);
  if (cmd === 'readiness') return readinessCmd(dateStr);
  if (cmd === 'run-batch') return runBatchCmd(dateStr);
  if (cmd === 'run' || cmd === 'evidence') {
    const shadowOnly = cmd === 'evidence';
    const lockRes = acquireAutonomyRunLock({
      mode: shadowOnly ? 'evidence' : 'run',
      date: dateStr
    });
    if (!lockRes.ok) {
      process.stdout.write(JSON.stringify({
        ok: true,
        result: 'stop_init_gate_run_lock',
        lock_code: lockRes.code,
        lock_detail: lockRes.detail || null,
        lock: lockRes.lock || null,
        lock_age_minutes: Number.isFinite(Number(lockRes.age_minutes)) ? Number(lockRes.age_minutes.toFixed(3)) : null,
        lock_process_alive: typeof lockRes.process_alive === 'boolean' ? lockRes.process_alive : null,
        ts: nowIso()
      }) + '\n');
      return;
    }
    try {
      return runCmd(dateStr, { shadowOnly });
    } finally {
      releaseAutonomyRunLock();
    }
  }
  if (cmd === 'scorecard') return scorecardCmd(dateStr);
  if (cmd === 'reset') return resetCmd(dateStr);
  if (cmd === 'issue-canary-override') return issueHumanCanaryOverrideCmd(dateStr);
  if (cmd === 'canary-override-status') return humanCanaryOverrideStatusCmd();
  if (cmd === 'revoke-canary-override') return revokeHumanCanaryOverrideCmd(dateStr);

  usage();
  process.exit(2);
}

if (require.main === module) main();
module.exports = {
  buildOverlay,
  proposalStatus,
  proposalOutcomeStatus,
  canQueueUnderflowBackfill,
  proposalRiskScore,
  compositeEligibilityScore,
  proposalScore,
  proposalAdmissionPreview,
  hasAdaptiveMutationSignal,
  adaptiveMutationExecutionGuardDecision,
  strategyAdmissionDecision,
  capabilityCap,
  assessActionability,
  assessSignalQuality,
  assessValueSignal,
  normalizeDirectiveText,
  tokenizeDirectiveText,
  normalizeSpaces,
  normalizeCriteriaMetric,
  defaultCriteriaPatternMemory,
  parseLowerList,
  canaryFailedChecksAllowed,
  proposalTextBlob,
  percentMentionsFromText,
  optimizationMinDeltaPercent,
  inferOptimizationDeltaForProposal,
  isOptimizationIntentProposal,
  assessUnlinkedOptimizationAdmission,
  assessOptimizationGoodEnough,
  proposalDependencySummary,
  exploreQuotaForDay,
  chooseSelectionMode,
  evaluateRouteBlockPrefilter,
  evaluateManualGatePrefilter,
  summarizeTopBiases,
  criteriaPatternKeysForProposal,
  criteriaPatternPenaltyForProposal,
  normalizeStoredProposalRow,
  detectEyesTerminologyDriftInPool,
  sourceEyeRef,
  escapeRegExp,
  toolTokenMentioned,
  urlDomain,
  domainAllowed,
  normalizedRisk,
  parseIsoTs,
  extractObjectiveIdToken,
  hasLinkedObjectiveEntry,
  isVerifiedEntryOutcome,
  isVerifiedRevenueAction,
  isExecuteMode,
  executionAllowedByFeatureFlag,
  isTier1ObjectiveId,
  isTier1CandidateObjective,
  needsExecutionQuota,
  policyHoldReasonFromEvent,
  strategyMarkerTokens,
  toStem,
  directiveTokenHits,
  expectedValueScore,
  timeToValueScore,
  valueDensityScore,
  normalizeValueCurrencyToken,
  listValueCurrencies,
  inferValueCurrenciesFromDirectiveBits,
  effectiveStrategyBudget,
  effectiveStrategyExecutionMode,
  effectiveStrategyCanaryExecLimit,
  effectiveStrategyExploration,
  executionReserveSnapshot,
  evaluateBudgetPacingGate,
  expectedValueSignalForProposal,
  strategyRankForCandidate,
  strategyRankAdjustedForCandidate,
  tritShadowRankScoreFromBelief,
  strategyTritShadowAdjustedScore,
  strategyCircuitCooldownHours,
  strategyProfile,
  activeStrategyVariants,
  strategyScorecardSummaries,
  outcomeFitnessPolicy,
  directiveTierWeight,
  directiveTierMinShare,
  strategyTritShadowForCandidate,
  strategyTritShadowRankingSummary,
  candidateNonYieldPenaltySignal,
  computeNonYieldPenaltyScore,
  shadowScopeMatchesCandidate,
  computeCollectiveShadowAggregate,
  computeCollectiveShadowAdjustments,
  candidateCollectiveShadowSignal,
  selectStrategyForRun,
  impactWeight,
  riskPenalty,
  estimateTokens,
  proposalRemediationDepth,
  proposalDedupKey,
  estimateTokensForCandidate,
  candidatePool,
  evaluateDoD,
  diffDoDEvidence,
  inExecWindow,
  hasStructuralPreviewCriteriaFailure,
  computeCalibrationDeltas,
  loadDirectivePulseObjectives,
  compileDirectivePulseObjectives,
  buildDirectivePulseStats,
  buildDirectivePulseContext,
  pulseObjectiveCooldownActive,
  normalizeDirectiveTier,
  pulseTierCoverageBonus,
  directiveTierReservationNeed,
  recentDirectivePulseCooldownCount,
  proposalDirectiveText,
  assessDirectivePulse,
  assessDirectiveFit,
  qosLaneFromCandidate,
  chooseQosLaneSelection,
  chooseEvidenceSelectionMode,
  compositeEligibilityMin,
  mediumRiskThresholds,
  mediumRiskGateDecision,
  thresholdsForProposalType,
  baseThresholds,
  effectiveAllowedRisksSet,
  qosLaneWeights,
  qosLaneShareCapExceeded,
  normalizeQueuePressure,
  queuePressureSnapshot,
  proposalStatusForQueuePressure,
  spawnCapacityBoostSnapshot,
  adaptiveExecutionCaps,
  defaultBacklogAutoscaleState,
  loadBacklogAutoscaleState,
  saveBacklogAutoscaleState,
  spawnAllocatedCells,
  runSpawnBroker,
  stableSelectionIndex,
  computeBacklogAutoscalePlan,
  runBacklogAutoscaler,
  backlogAutoscaleSnapshot,
  computeBacklogBatchMax,
  suggestAutonomyRunBatchMax,
  TS_CLONE_DYNAMIC_IO_PARITY,
  isPolicyHoldResult,
  isPolicyHoldRunEvent,
  latestPolicyHoldRunEvent,
  objectivePolicyHoldPattern,
  objectiveIdsFromPulseContext,
  policyHoldObjectiveContext,
  policyHoldPressureSnapshot,
  policyHoldCooldownMinutesForPressure,
  policyHoldCooldownMinutesForResult,
  capabilityCooldownKey,
  readinessRetryCooldownKey,
  minutesUntilNextUtcDay,
  ageHours,
  executeConfidenceCooldownKey,
  executeConfidenceCooldownActive,
  asStringArray,
  uniqSorted,
  normalizeModelIds,
  selectedModelFromRunEvent,
  parseArg,
  dateArgOrToday,
  hasEnvNumericOverride,
  coalesceNumeric,
  clampNumber,
  latestProposalDate,
  startModelCatalogCanary,
  evaluateModelCatalogCanary,
  readModelCatalogCanary,
  runPostconditions,
  verifyExecutionReceipt,
  loadEyesMap,
  loadFallbackDirectiveObjectiveIds,
  capabilityDescriptor,
  normalizeTokenUsageShape,
  computeExecutionTokenUsage,
  preexecVerdictFromSignals,
  withSuccessCriteriaQualityAudit,
  preExecCriteriaGateDecision,
  routeExecutionPolicyHold,
  proposalSemanticObjectiveId,
  proposalSemanticFingerprint,
  semanticTokenSimilarity,
  semanticContextComparable,
  semanticNearDuplicateMatch,
  isNoProgressRun,
  isAttemptRunEvent,
  attemptEvents,
  runsSinceReset,
  isSafetyStopRunEvent,
  classifyNonYieldCategory,
  nonYieldReasonFromRun,
  minutesSinceTs,
  dateWindow,
  inWindow,
  startOfNextUtcDay,
  isoAfterMinutes,
  executeConfidenceHistoryMatch,
  collectExecuteConfidenceHistory,
  computeExecuteConfidencePolicy,
  recentProposalKeyCounts,
  capabilityAttemptCountForDate,
  capabilityOutcomeStatsInWindow,
  runEventProposalType,
  runEventObjectiveId,
  runEventProposalId,
  isCapacityCountedAttemptEvent,
  capacityCountedAttemptEvents,
  successCriteriaRequirement,
  successCriteriaPolicyForProposal,
  deriveRepeatGateAnchor,
  isScoreOnlyResult,
  isScoreOnlyFailureLikeEvent,
  scoreOnlyProposalChurn,
  isGateExhaustedAttempt,
  consecutiveGateExhaustedAttempts,
  consecutiveNoProgressRuns,
  shippedCount,
  executedCountByRisk,
  tallyByResult,
  qosLaneUsageFromRuns,
  countEyeOutcomesInWindow,
  countEyeOutcomesInLastHours,
  normalizeStoredProposalStatus,
  sortedCounts,
  sourceEyeId,
  isDeprioritizedSourceProposal,
  admissionSummaryFromProposals,
  proposalUnknownTypeQuarantineDecision,
  extractEyeFromEvidenceRef,
  clampThreshold,
  appliedThresholds,
  totalOutcomes,
  deriveEntityBias,
  isDirectiveClarificationProposal,
  isDirectiveDecompositionProposal,
  sanitizeDirectiveObjectiveId,
  parseDirectiveFileArgFromCommand,
  parseDirectiveObjectiveArgFromCommand,
  parseSuccessCriteriaRows,
  collectOutcomeStats,
  parseFirstJsonLine,
  parseJsonObjectsFromText,
  readPathValue,
  readFirstNumericMetric,
  numberOrNull,
  truthyFlag,
  falseyFlag,
  parseObjectiveIdFromEvidenceRefs,
  parseObjectiveIdFromCommand,
  sanitizedDirectiveIdList,
  candidateObjectiveId,
  objectiveIdForExecution,
  shortText,
  normalizedSignalStatus
};
