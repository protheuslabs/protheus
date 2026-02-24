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
const { resolveCatalogPath } = require('../../lib/eyes_catalog');
const { evaluatePipelineSpcGate } = require('./pipeline_spc_gate');
const {
  loadActiveStrategy,
  applyThresholdOverrides,
  effectiveAllowedRisks,
  strategyExecutionMode,
  strategyBudgetCaps,
  strategyExplorationPolicy,
  strategyRankingWeights,
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
const AUTONOMY_MAX_PROPOSAL_FILE_AGE_HOURS = Number(process.env.AUTONOMY_MAX_PROPOSAL_FILE_AGE_HOURS || 48);
const AUTONOMY_REPEAT_EXHAUSTED_LIMIT = Number(process.env.AUTONOMY_REPEAT_EXHAUSTED_LIMIT || 3);
const AUTONOMY_REPEAT_EXHAUSTED_COOLDOWN_MINUTES = Number(process.env.AUTONOMY_REPEAT_EXHAUSTED_COOLDOWN_MINUTES || 90);
const AUTONOMY_BUDGET_AUTOPAUSE_MINUTES = Math.max(5, Number(process.env.AUTONOMY_BUDGET_AUTOPAUSE_MINUTES || 60));
const AUTONOMY_NON_YIELD_LEDGER_ENABLED = String(process.env.AUTONOMY_NON_YIELD_LEDGER_ENABLED || '1') !== '0';
const AUTONOMY_BUDGET_PACING_ENABLED = String(process.env.AUTONOMY_BUDGET_PACING_ENABLED || '1') !== '0';
const AUTONOMY_BUDGET_PACING_MIN_REMAINING_RATIO = clampNumber(Number(process.env.AUTONOMY_BUDGET_PACING_MIN_REMAINING_RATIO || 0.2), 0, 1);
const AUTONOMY_BUDGET_PACING_HIGH_TOKEN_THRESHOLD = Math.max(100, Number(process.env.AUTONOMY_BUDGET_PACING_HIGH_TOKEN_THRESHOLD || 900));
const AUTONOMY_BUDGET_PACING_MIN_VALUE_SIGNAL = clampNumber(Number(process.env.AUTONOMY_BUDGET_PACING_MIN_VALUE_SIGNAL || 65), 0, 100);
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
const AUTONOMY_CANARY_REQUIRE_EXECUTABLE = String(process.env.AUTONOMY_CANARY_REQUIRE_EXECUTABLE || '1') !== '0';
const AUTONOMY_CANARY_BLOCK_GENERIC_ROUTE_TASK = String(process.env.AUTONOMY_CANARY_BLOCK_GENERIC_ROUTE_TASK || '1') !== '0';
const AUTONOMY_MEDIUM_RISK_MIN_COMPOSITE_ELIGIBILITY = Number(process.env.AUTONOMY_MEDIUM_RISK_MIN_COMPOSITE_ELIGIBILITY || 70);
const AUTONOMY_MEDIUM_RISK_MIN_DIRECTIVE_FIT = Number(process.env.AUTONOMY_MEDIUM_RISK_MIN_DIRECTIVE_FIT || 45);
const AUTONOMY_MEDIUM_RISK_MIN_ACTIONABILITY = Number(process.env.AUTONOMY_MEDIUM_RISK_MIN_ACTIONABILITY || 55);
const AUTONOMY_MEDIUM_RISK_NO_CHANGE_COOLDOWN_HOURS = Number(process.env.AUTONOMY_MEDIUM_RISK_NO_CHANGE_COOLDOWN_HOURS || 24);
const AUTONOMY_MEDIUM_RISK_REVERT_COOLDOWN_HOURS = Number(process.env.AUTONOMY_MEDIUM_RISK_REVERT_COOLDOWN_HOURS || 48);
const AUTONOMY_MIN_VALUE_SIGNAL_SCORE = Number(process.env.AUTONOMY_MIN_VALUE_SIGNAL_SCORE || 45);
const AUTONOMY_MEDIUM_RISK_VALUE_SIGNAL_BONUS = Number(process.env.AUTONOMY_MEDIUM_RISK_VALUE_SIGNAL_BONUS || 8);
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
const AUTONOMY_CAMPAIGN_DECOMPOSE_ENABLED = String(process.env.AUTONOMY_CAMPAIGN_DECOMPOSE_ENABLED || '1') !== '0';
const AUTONOMY_CAMPAIGN_DECOMPOSE_MAX_PER_RUN = Math.max(0, Number(process.env.AUTONOMY_CAMPAIGN_DECOMPOSE_MAX_PER_RUN || 2));
const AUTONOMY_CAMPAIGN_DECOMPOSE_MIN_OPEN_PER_TYPE = Math.max(1, Number(process.env.AUTONOMY_CAMPAIGN_DECOMPOSE_MIN_OPEN_PER_TYPE || 1));
const AUTONOMY_CAMPAIGN_DECOMPOSE_DEFAULT_RISK = String(process.env.AUTONOMY_CAMPAIGN_DECOMPOSE_DEFAULT_RISK || 'low').trim().toLowerCase() || 'low';
const AUTONOMY_CAMPAIGN_DECOMPOSE_DEFAULT_IMPACT = String(process.env.AUTONOMY_CAMPAIGN_DECOMPOSE_DEFAULT_IMPACT || 'medium').trim().toLowerCase() || 'medium';
let STRATEGY_CACHE = undefined;
let OUTCOME_FITNESS_POLICY_CACHE = undefined;

function strategyProfile() {
  if (STRATEGY_CACHE !== undefined) return STRATEGY_CACHE;
  STRATEGY_CACHE = loadActiveStrategy({ allowMissing: true });
  return STRATEGY_CACHE;
}

function outcomeFitnessPolicy() {
  if (OUTCOME_FITNESS_POLICY_CACHE !== undefined) return OUTCOME_FITNESS_POLICY_CACHE;
  OUTCOME_FITNESS_POLICY_CACHE = loadOutcomeFitnessPolicy(REPO_ROOT);
  return OUTCOME_FITNESS_POLICY_CACHE;
}

function effectiveStrategyBudget() {
  const caps = strategyBudgetCaps(strategyProfile(), {
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

function effectiveStrategyExecutionMode() {
  return strategyExecutionMode(strategyProfile(), 'execute');
}

function effectiveStrategyCanaryExecLimit() {
  return strategyCanaryDailyExecLimit(strategyProfile(), AUTONOMY_CANARY_DAILY_EXEC_LIMIT);
}

function effectiveStrategyExploration() {
  return strategyExplorationPolicy(strategyProfile(), {
    fraction: AUTONOMY_EXPLORE_FRACTION,
    every_n: AUTONOMY_EXPLORE_EVERY_N,
    min_eligible: AUTONOMY_EXPLORE_MIN_ELIGIBLE
  });
}

function isExecuteMode(mode) {
  return mode === 'execute' || mode === 'canary_execute';
}

function executionAllowedByFeatureFlag(executionMode, shadowOnly = false) {
  if (shadowOnly) return true;
  if (String(process.env.AUTONOMY_ENABLED || '') === '1') return true;
  return AUTONOMY_CANARY_ALLOW_WITH_FLAG_OFF && String(executionMode || '') === 'canary_execute';
}

function isTier1ObjectiveId(objectiveId) {
  const id = String(objectiveId || '').trim();
  if (!id) return false;
  return /^T1(?:\b|[_:-])/i.test(id);
}

function isTier1CandidateObjective(candidate) {
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
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function dateArgOrToday(v) {
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return todayStr();
}

function parseArg(name) {
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
  return fs.readdirSync(PROPOSALS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
}

function normalizeStoredProposalStatus(raw, fallback = 'pending') {
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
  const out = [];
  for (const f of files) {
    out.push(...readJsonl(path.join(QUEUE_DECISIONS_DIR, f)));
  }
  return out;
}

function buildOverlay(events) {
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
  const title = String(p && p.title || '');
  return title.toUpperCase().includes('[STUB]');
}

function impactWeight(p) {
  const impact = String(p && p.expected_impact || '').toLowerCase();
  if (impact === 'high') return 3;
  if (impact === 'medium') return 2;
  return 1;
}

function riskPenalty(p) {
  const r = String(p && p.risk || '').toLowerCase();
  if (r === 'high') return 2;
  if (r === 'medium') return 1;
  return 0;
}

function estimateTokens(p) {
  const impact = String(p && p.expected_impact || '').toLowerCase();
  if (impact === 'high') return 1400;
  if (impact === 'medium') return 800;
  return 300;
}

function normalizeSpaces(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function parseLowerList(value) {
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
  if (AUTONOMY_OPTIMIZATION_HIGH_ACCURACY_MODE) return AUTONOMY_OPTIMIZATION_MIN_DELTA_PERCENT_HIGH_ACCURACY;
  return AUTONOMY_OPTIMIZATION_MIN_DELTA_PERCENT;
}

function percentMentionsFromText(text) {
  const blob = String(text || '');
  if (!blob) return [];
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
  const blob = proposalTextBlob(proposal);
  const hasIntent = OPTIMIZATION_INTENT_RE.test(type) || OPTIMIZATION_INTENT_RE.test(blob);
  if (!hasIntent) return false;
  const hasExemptSignals = OPTIMIZATION_EXEMPT_RE.test(type) || OPTIMIZATION_EXEMPT_RE.test(blob);
  if (hasExemptSignals) return false;
  if (OPPORTUNITY_MARKER_RE.test(blob)) return false;
  return true;
}

function extractObjectiveIdToken(value) {
  const text = normalizeSpaces(value);
  if (!text) return null;
  const direct = text.match(/^T[0-9]+_[A-Za-z0-9_]+$/);
  if (direct) return direct[0];
  const token = text.match(/\b(T[0-9]+_[A-Za-z0-9_]+)\b/);
  return token ? token[1] : null;
}

function hasLinkedObjectiveEntry(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  return !!(
    extractObjectiveIdToken(e.objective_id)
    || extractObjectiveIdToken(e.directive_objective_id)
    || extractObjectiveIdToken(e.directive)
  );
}

function isVerifiedEntryOutcome(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  if (e.outcome_verified === true) return true;
  const outcome = String(e.outcome || '').trim().toLowerCase();
  return ['verified', 'verified_success', 'verified_pass', 'shipped', 'closed_won', 'won', 'paid', 'revenue_verified', 'pass'].includes(outcome);
}

function isVerifiedRevenueAction(action) {
  const row = action && typeof action === 'object' ? action : {};
  if (row.verified === true || row.outcome_verified === true) return true;
  const status = String(row.status || '').trim().toLowerCase();
  return ['verified', 'won', 'paid', 'closed_won', 'received'].includes(status);
}

function assessUnlinkedOptimizationAdmission(proposal, objectiveBinding, risk) {
  const type = normalizeSpaces(proposal && proposal.type).toLowerCase();
  if (!isOptimizationIntentProposal(proposal)) {
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
  const inferred = inferOptimizationDeltaForProposal(p);
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
  return String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toolTokenMentioned(blob, token) {
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
  const metaEye = p && p.meta && typeof p.meta.source_eye === 'string' ? p.meta.source_eye.trim() : '';
  if (metaEye) return `eye:${metaEye}`;
  const evRef = p && Array.isArray(p.evidence) && p.evidence.length ? String((p.evidence[0] || {}).evidence_ref || '') : '';
  if (evRef.startsWith('eye:')) return evRef;
  return 'eye:unknown_eye';
}

function normalizedRisk(v) {
  const r = String(v || '').trim().toLowerCase();
  if (r === 'high' || r === 'medium' || r === 'low') return r;
  return 'low';
}

function parseIsoTs(ts) {
  const d = new Date(String(ts || ''));
  return isNaN(d.getTime()) ? null : d;
}

function isPolicyHoldResult(result): boolean {
  const r = String(result || '').trim();
  if (!r) return false;
  return r.startsWith('no_candidates_policy_')
    || r === 'stop_init_gate_budget_autopause'
    || r === 'stop_init_gate_readiness'
    || r === 'stop_init_gate_readiness_blocked'
    || r === 'stop_init_gate_criteria_quality_insufficient'
    || r === 'score_only_fallback_route_block'
    || r === 'score_only_fallback_low_execution_confidence';
}

function isPolicyHoldRunEvent(evt): boolean {
  if (!evt || evt.type !== 'autonomy_run') return false;
  if (evt.policy_hold === true) return true;
  return isPolicyHoldResult(evt.result);
}

function latestPolicyHoldRunEvent(events) {
  const rows = Array.isArray(events) ? events : [];
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

function policyHoldReasonFromEvent(evt) {
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
  const untilMs = Number(ent.until_ms || 0);
  if (!untilMs || Date.now() > untilMs) {
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
  const untilMs = Number(ent.until_ms || 0);
  if (!untilMs || Date.now() > untilMs) {
    delete cooldowns[proposalId];
    saveJson(COOLDOWNS_PATH, cooldowns);
    return false;
  }
  return true;
}

function capabilityCooldownKey(capabilityKey) {
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
  const sid = normalizeSpaces(strategyId).toLowerCase().replace(/[^a-z0-9:_-]/g, '_');
  if (!sid) return '';
  const mode = normalizeSpaces(executionMode).toLowerCase().replace(/[^a-z0-9:_-]/g, '_');
  if (!mode) return `readiness:strategy:${sid}`;
  return `readiness:strategy:${sid}:mode:${mode}`;
}

function executeConfidenceCooldownActive(capabilityKey, objectiveId, proposalType) {
  const key = executeConfidenceCooldownKey(capabilityKey, objectiveId, proposalType);
  if (!key) return false;
  return cooldownActive(key);
}

function dailyBudgetPath(dateStr) {
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
  return path.join(RUNS_DIR, `${dateStr}.jsonl`);
}

function readRuns(dateStr) {
  return readJsonl(runsPathFor(dateStr));
}

function isNoProgressRun(evt) {
  if (!evt || evt.type !== 'autonomy_run') return false;
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
  return events.filter(isAttemptRunEvent);
}

function runEventProposalId(evt) {
  if (!evt || typeof evt !== 'object') return '';
  const topEscalation = evt.top_escalation && typeof evt.top_escalation === 'object'
    ? evt.top_escalation
    : {};
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
  return (events || []).filter(isCapacityCountedAttemptEvent);
}

function deriveRepeatGateAnchor(evt) {
  if (!evt || typeof evt !== 'object') return {};
  const proposalId = runEventProposalId(evt);
  const objectiveId = runEventObjectiveId(evt);
  const out: AnyObj = {};
  if (proposalId) out.proposal_id = proposalId;
  if (objectiveId) out.objective_id = objectiveId;
  const binding = evt.objective_binding && typeof evt.objective_binding === 'object'
    ? evt.objective_binding
    : null;
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
  return r === 'score_only_preview'
    || r === 'score_only_evidence'
    || r === 'stop_repeat_gate_preview_structural_cooldown'
    || r === 'stop_repeat_gate_preview_churn_cooldown';
}

function isScoreOnlyFailureLikeEvent(evt): boolean {
  if (!evt || evt.type !== 'autonomy_run') return false;
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
  const d = parseIsoTs(ts);
  if (!d) return null;
  return (Date.now() - d.getTime()) / (1000 * 60);
}

function consecutiveNoProgressRuns(events) {
  let count = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || e.type !== 'autonomy_run') continue;
    if (e.result === 'executed' && e.outcome === 'shipped') break;
    if (!isNoProgressRun(e)) break;
    count++;
  }
  return count;
}

function shippedCount(events) {
  return events.filter(e => e && e.type === 'autonomy_run' && e.result === 'executed' && e.outcome === 'shipped').length;
}

function executedCountByRisk(events, risk) {
  const target = normalizedRisk(risk);
  let count = 0;
  for (const e of events || []) {
    if (!e || e.type !== 'autonomy_run' || e.result !== 'executed') continue;
    const runRisk = normalizedRisk((e.risk != null ? e.risk : e.proposal_risk) || '');
    if (runRisk === target) count += 1;
  }
  return count;
}

function tallyByResult(events) {
  const out = {};
  for (const e of events) {
    if (!e || e.type !== 'autonomy_run') continue;
    const k = String(e.result || 'unknown');
    out[k] = Number(out[k] || 0) + 1;
  }
  return out;
}

function sortedCounts(mapObj) {
  const items = Object.entries(mapObj || {}).map(([result, count]) => ({ result, count: Number(count || 0) }));
  items.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.result.localeCompare(b.result);
  });
  return items;
}

function bumpCount(mapObj, key) {
  if (!mapObj || !key) return;
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
  const base = new Date(`${String(dateStr || '')}T00:00:00.000Z`);
  if (isNaN(base.getTime())) return null;
  base.setUTCDate(base.getUTCDate() + 1);
  return base.toISOString();
}

function isoAfterMinutes(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n)) return null;
  const ms = Date.now() + Math.max(0, n) * 60 * 1000;
  return new Date(ms).toISOString();
}

function admissionSummaryFromProposals(proposals) {
  const arr = Array.isArray(proposals) ? proposals : [];
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
  return sourceEyeRef(p).replace(/^eye:/, '');
}

function isDeprioritizedSourceProposal(p) {
  const eyeId = String(sourceEyeId(p) || '').trim().toLowerCase();
  if (!eyeId) return false;
  return AUTONOMY_DEPRIORITIZED_SOURCE_EYES.has(eyeId);
}

function baseThresholds() {
  const base = {
    min_signal_quality: AUTONOMY_MIN_SIGNAL_QUALITY,
    min_sensory_signal_score: AUTONOMY_MIN_SENSORY_SIGNAL_SCORE,
    min_sensory_relevance_score: AUTONOMY_MIN_SENSORY_RELEVANCE_SCORE,
    min_directive_fit: AUTONOMY_MIN_DIRECTIVE_FIT,
    min_actionability_score: AUTONOMY_MIN_ACTIONABILITY_SCORE,
    min_eye_score_ema: AUTONOMY_MIN_EYE_SCORE_EMA
  };
  return applyThresholdOverrides(base, strategyProfile());
}

function effectiveAllowedRisksSet() {
  return effectiveAllowedRisks(AUTONOMY_ALLOWED_RISKS, strategyProfile());
}

function mediumRiskThresholds(baseThresholdsObj) {
  const base = baseThresholdsObj && typeof baseThresholdsObj === 'object'
    ? baseThresholdsObj
    : baseThresholds();
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
  const normalized = normalizedRisk(risk);
  const baseMin = AUTONOMY_MIN_COMPOSITE_ELIGIBILITY;
  if (normalized !== 'low' || executionMode !== 'canary_execute') return baseMin;
  const relax = Math.max(0, Number(AUTONOMY_CANARY_LOW_RISK_COMPOSITE_RELAX || 0));
  return Math.max(55, baseMin - relax);
}

function mediumRiskGateDecision(proposal, directiveFitScore, actionabilityScore, compositeScore, baseThresholdsObj) {
  const risk = normalizedRisk(proposal && proposal.risk);
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
  const s = String(ref || '');
  const m = s.match(/\beye:([^\s]+)/);
  return m ? String(m[1]) : null;
}

function outcomeBuckets() {
  return { shipped: 0, no_change: 0, reverted: 0 };
}

function totalOutcomes(b) {
  if (!b) return 0;
  return Number(b.shipped || 0) + Number(b.no_change || 0) + Number(b.reverted || 0);
}

function deriveEntityBias(buckets, minTotal) {
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
  const out = [];
  const entries = Object.entries((mapObj || {}) as AnyObj);
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
  const events = [];
  for (const d of dateWindow(endDateStr, days)) {
    events.push(...readRuns(d));
  }
  return events;
}

function proposalMetaIndex(endDateStr, days) {
  const idx = new Map();
  for (const d of dateWindow(endDateStr, days)) {
    const proposals = loadProposalsForDate(d);
    for (const p of proposals) {
      if (!p || !p.id) continue;
      if (idx.has(p.id)) continue;
      idx.set(p.id, {
        eye_id: sourceEyeId(p),
        topics: Array.isArray(p && p.meta && p.meta.topics) ? p.meta.topics.map(t => String(t || '').toLowerCase()).filter(Boolean) : []
      });
    }
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
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function urlDomain(url) {
  try {
    const u = new URL(String(url || ''));
    return String(u.hostname || '').toLowerCase();
  } catch {
    return '';
  }
}

function domainAllowed(domain, allowlist) {
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
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenizeDirectiveText(s) {
  const norm = normalizeDirectiveText(s);
  if (!norm) return [];
  return norm
    .split(' ')
    .filter(t => t.length >= 3)
    .filter(t => !DIRECTIVE_FIT_STOPWORDS.has(t))
    .filter(t => !/^\d+$/.test(t));
}

function toStem(token) {
  const t = String(token || '').trim();
  if (t.length <= 5) return t;
  return t.slice(0, 5);
}

function asStringArray(v) {
  if (Array.isArray(v)) return v.map(x => String(x || '').trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

function strategyMarkerTokens(strategy) {
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
  const n = Number(rawTier);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.round(n));
}

function directiveTierWeight(tier) {
  const t = normalizeDirectiveTier(tier, 3);
  if (t <= 1) return 1.3;
  if (t === 2) return 1.0;
  if (t === 3) return 0.82;
  return 0.7;
}

function directiveTierMinShare(tier) {
  const t = normalizeDirectiveTier(tier, 3);
  if (t <= 1) return clampNumber(Number(AUTONOMY_DIRECTIVE_PULSE_T1_MIN_SHARE || 0), 0, 1);
  if (t === 2) return clampNumber(Number(AUTONOMY_DIRECTIVE_PULSE_T2_MIN_SHARE || 0), 0, 1);
  return 0;
}

function compileDirectivePulseObjectives(directives) {
  const input = Array.isArray(directives) ? directives : [];
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

    out.push({
      id,
      tier,
      title: String(asStringArray(intent.primary)[0] || asStringArray(metadata.description)[0] || id),
      tier_weight: directiveTierWeight(tier),
      min_share: directiveTierMinShare(tier),
      phrases,
      tokens
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
  if (!AUTONOMY_DIRECTIVE_PULSE_ENABLED) {
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
    return {
      enabled: true,
      available: false,
      objectives: [],
      error: String(err && err.message ? err.message : err).slice(0, 200)
    };
  }
  const objectives = compileDirectivePulseObjectives(directives);
  return {
    enabled: true,
    available: objectives.length > 0,
    objectives,
    error: objectives.length > 0 ? null : 'no_objectives'
  };
}

function buildDirectivePulseStats(dateStr, windowDays) {
  const days = clampNumber(Number(windowDays || AUTONOMY_DIRECTIVE_PULSE_WINDOW_DAYS), 1, 60);
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
  if (!Number.isFinite(streak) || streak < Math.max(1, limit)) return false;
  const last = parseIsoTs(stat.last_attempt_ts);
  if (!last) return false;
  const ageHours = (Date.now() - last.getTime()) / (1000 * 60 * 60);
  const cooldown = Number(pulseCtx && pulseCtx.cooldown_hours || AUTONOMY_DIRECTIVE_PULSE_COOLDOWN_HOURS);
  return ageHours < Math.max(1, cooldown);
}

function pulseTierCoverageBonus(tier, pulseCtx) {
  const minShare = directiveTierMinShare(tier);
  const attemptsToday = Number(pulseCtx && pulseCtx.attempts_today || 0);
  const byTier = pulseCtx && pulseCtx.tier_attempts_today && typeof pulseCtx.tier_attempts_today === 'object'
    ? pulseCtx.tier_attempts_today
    : {};
  const current = Number(byTier[normalizeDirectiveTier(tier, 3)] || 0);
  if (attemptsToday <= 0) {
    if (normalizeDirectiveTier(tier, 3) <= 1) return 8;
    if (normalizeDirectiveTier(tier, 3) === 2) return 4;
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
  const cutoff = Date.now() - (h * 60 * 60 * 1000);
  const days = Math.max(1, Math.ceil(h / 24) + 1);
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

  if (/\[stub\]/i.test(title)) {
    score -= 40;
    hardBlock = true;
    reasons.push('stub_title');
  }

  if (eye) {
    const eyeStatus = String(eye.status || '').toLowerCase();
    const parserType = String(eye.parser_type || '').toLowerCase();
    const eyeScoreEma = Number(eye.score_ema);

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

    if (parserType && AUTONOMY_DISALLOWED_PARSER_TYPES.has(parserType)) {
      score -= 30;
      hardBlock = true;
      reasons.push(`parser_disallowed:${parserType}`);
    }

    const allowlist = Array.isArray(eye.allowed_domains) ? eye.allowed_domains : [];
    if (domain && allowlist.length > 0 && !domainAllowed(domain, allowlist)) {
      // Eyes often collect from feed domains but point to third-party article domains.
      // Treat this as a weak signal, not a hard block.
      score -= 3;
      reasons.push('domain_outside_allowlist');
    }

    const proposedTotal = Number(eye.proposed_total || 0);
    const yieldRate = Number(eye.yield_rate);
    if (proposedTotal >= 3 && Number.isFinite(yieldRate)) {
      score += (yieldRate * 15) - 5;
      if (yieldRate < 0.1) reasons.push('eye_yield_low');
    }
  } else {
    reasons.push('eye_unknown');
  }

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
  const capKey = normalizeSpaces(capabilityKeyHint).toLowerCase()
    || String((capabilityDescriptor(proposal, parseActuationSpec(proposal)) || {}).key || '').toLowerCase()
    || 'unknown';
  const rows = parseSuccessCriteriaRows(proposal);
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
  if (/\bproposals?\b/.test(concreteBlob) && !hasConcreteTarget && !hasOpportunity) {
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
  let score = 0;
  score += expectedValue * 0.52;
  score += timeToValue * 0.22;
  score += actionabilityScore * 0.18;
  score += directiveFitScore * 0.08;
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
  let count = 0;
  for (const e of events) {
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
  const cutoff = Date.now() - (hours * 60 * 60 * 1000);
  let count = 0;
  for (const e of events) {
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
  const out = {
    window_days: windowDays,
    proposal_type: String(proposalType || '').trim().toLowerCase() || null,
    capability_key: String(capabilityKey || '').trim().toLowerCase() || null,
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
  for (const d of dateWindow(dateStr, windowDays)) {
    for (const evt of readRuns(d)) {
      if (!executeConfidenceHistoryMatch(evt, proposalType, capabilityKey)) continue;
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
  const out = [];
  for (const file of files) {
    const rows = readJsonl(path.join(RUNS_DIR, file));
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const evt = rows[i];
      if (!evt || evt.type !== 'autonomy_run') continue;
      const ts = parseIsoTs(evt.ts);
      if (!ts) continue;
      const tsMs = ts.getTime();
      if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;
      out.push(evt);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

function summarizeRecentRouteBlockTelemetry(hours, maxEvents = 800) {
  const events = recentAutonomyRunEventsInLastHours(hours, maxEvents);
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
  const rows = telemetry && telemetry.by_capability && typeof telemetry.by_capability === 'object'
    ? telemetry.by_capability
    : {};
  const row = rows[key] && typeof rows[key] === 'object' ? rows[key] : null;
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

function proposalStatus(overlayEnt) {
  if (!overlayEnt || !overlayEnt.decision) return 'pending';
  if (overlayEnt.decision === 'accept') return 'accepted';
  if (overlayEnt.decision === 'reject') return 'rejected';
  if (overlayEnt.decision === 'park') return 'parked';
  return 'pending';
}

function proposalOutcomeStatus(overlayEnt) {
  if (!overlayEnt || !overlayEnt.outcome) return null;
  const out = String(overlayEnt.outcome || '').trim().toLowerCase();
  if (!out) return null;
  return out;
}

function canQueueUnderflowBackfill(status, overlayEnt) {
  if (AUTONOMY_QUEUE_UNDERFLOW_BACKFILL_MAX <= 0) return false;
  if (String(status || '') !== 'accepted') return false;
  const out = proposalOutcomeStatus(overlayEnt);
  return !out;
}

function proposalScore(p, overlayEnt, dateStr) {
  const agePenalty = ageHours(dateStr) / 24 * 0.6;
  const stubPenalty = isStubProposal(p) ? 2.5 : 0;
  const noChangePenalty = (overlayEnt?.outcomes?.no_change || 0) * 1.5;
  const revertedPenalty = (overlayEnt?.outcomes?.reverted || 0) * 3.0;
  return (
    impactWeight(p) * 2.0
    - riskPenalty(p) * 1.0
    - agePenalty
    - stubPenalty
    - noChangePenalty
    - revertedPenalty
  );
}

function proposalRemediationDepth(p) {
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const raw = Number(meta.remediation_depth);
  if (Number.isFinite(raw) && raw >= 0) return Math.round(raw);
  const trigger = String(meta.trigger || '').toLowerCase();
  if (trigger === 'consecutive_failures' || trigger === 'multi_eye_transport_failure') return 1;
  return 0;
}

function proposalDedupKey(p) {
  const type = String(p && p.type || 'unknown').toLowerCase();
  const eye = sourceEyeId(p);
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const remediationKind = String(meta.remediation_kind || '').toLowerCase();
  if (type.includes('remediation')) return `${type}|${eye}|${remediationKind || 'none'}`;
  return `${type}|${eye}|${String(p && p.id || 'unknown')}`;
}

function proposalRiskScore(p) {
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const explicit = Number(meta.risk_score);
  if (Number.isFinite(explicit)) return clampNumber(Math.round(explicit), 0, 100);
  const risk = normalizedRisk(p && p.risk);
  if (risk === 'high') return 90;
  if (risk === 'medium') return 60;
  return 25;
}

function recentProposalKeyCounts(dateStr, hours) {
  const out = new Map();
  const h = Number(hours || 0);
  if (!Number.isFinite(h) || h <= 0) return out;
  const cutoffMs = Date.now() - (h * 60 * 60 * 1000);
  const days = Math.max(1, Math.ceil(h / 24) + 1);
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
  const type = String(p && p.type || '').toLowerCase();
  if (!strategyAllowsProposalType(strategy, type)) {
    return { allow: false, reason: 'strategy_type_filtered' };
  }
  const strategyMax = strategyMaxRiskPerAction(strategy, null);
  const hardMax = Number.isFinite(Number(AUTONOMY_HARD_MAX_RISK_PER_ACTION)) && Number(AUTONOMY_HARD_MAX_RISK_PER_ACTION) >= 0
    ? Number(AUTONOMY_HARD_MAX_RISK_PER_ACTION)
    : null;
  let maxRisk = strategyMax;
  if (hardMax != null) {
    maxRisk = maxRisk == null ? hardMax : Math.min(maxRisk, hardMax);
  }
  if (maxRisk != null) {
    const riskScore = proposalRiskScore(p);
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
  const maxDepth = strategy
    && strategy.admission_policy
    && Number.isFinite(Number(strategy.admission_policy.max_remediation_depth))
      ? Number(strategy.admission_policy.max_remediation_depth)
      : null;
  if (Number.isFinite(maxDepth) && type.includes('remediation')) {
    const depth = proposalRemediationDepth(p);
    if (depth > maxDepth) return { allow: false, reason: 'strategy_remediation_depth_exceeded' };
  }
  const dedupKey = String(opts.dedup_key || '').trim();
  const keyCounts = opts.recent_key_counts instanceof Map ? opts.recent_key_counts : null;
  const duplicateWindowHours = strategyDuplicateWindowHours(strategy, 24);
  if (dedupKey && keyCounts) {
    const seen = Number(keyCounts.get(dedupKey) || 0);
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

function expectedValueScore(p) {
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const direct = Number(meta.expected_value_score);
  if (Number.isFinite(direct)) return clampNumber(Math.round(direct), 0, 100);
  const usd = Number(meta.expected_value_usd);
  if (Number.isFinite(usd) && usd > 0) {
    // Log-scale bucket: $1->$100 maps roughly 20->80, capped.
    const score = Math.log10(Math.max(1, usd)) * 30;
    return clampNumber(Math.round(score), 0, 100);
  }
  return impactWeight(p) * 20;
}

function timeToValueScore(p) {
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const hours = Number(meta.time_to_cash_hours);
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
  if (Number.isFinite(direct) && direct > 0) return clampNumber(Math.round(direct), 80, 12000);
  const routeEst = Number(meta.route_tokens_est);
  if (Number.isFinite(routeEst) && routeEst > 0) return clampNumber(Math.round(routeEst), 80, 12000);
  return clampNumber(estimateTokens(p), 80, 12000);
}

function valueDensityScore(expectedValue, estTokens) {
  const value = clampNumber(Number(expectedValue || 0), 0, 100);
  const tokens = clampNumber(Number(estTokens || 0), 80, 12000);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const score = (value * 1000) / Math.max(80, tokens);
  return clampNumber(Math.round(score), 0, 100);
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
  return {
    token_cap: cap,
    used_est: used,
    remaining_tokens: remaining,
    remaining_ratio: Number(remainingRatio.toFixed(4)),
    pressure,
    autopause_active: autopauseActive,
    tight
  };
}

function evaluateBudgetPacingGate(cand, valueSignal, risk, snapshot) {
  const estTokens = estimateTokensForCandidate(cand, cand && cand.proposal);
  const valueScore = clampNumber(Number(valueSignal && valueSignal.score || 0), 0, 100);
  const snap = snapshot && typeof snapshot === 'object'
    ? snapshot
    : { tight: false, autopause_active: false, remaining_ratio: 1, pressure: 'none' };
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
    min_value_signal_score: AUTONOMY_BUDGET_PACING_MIN_VALUE_SIGNAL
  };
  if (AUTONOMY_BUDGET_PACING_ENABLED !== true) return out;
  if (snap.tight !== true) return out;
  const normalized = normalizedRisk(risk);
  const highValueEscape = valueScore >= Math.max(AUTONOMY_BUDGET_PACING_MIN_VALUE_SIGNAL + 20, 85);
  if (highValueEscape) return out;
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

function strategyRankForCandidate(cand, strategy) {
  const p = cand && cand.proposal ? cand.proposal : {};
  const weights = strategyRankingWeights(strategy);
  const expectedValue = expectedValueScore(p);
  const estimatedTokens = estimateTokensForCandidate(cand, p);
  const valueDensity = valueDensityScore(expectedValue, estimatedTokens);
  const valueDensityWeight = Number.isFinite(Number(weights && weights.value_density))
    ? Number(weights.value_density)
    : 0.08;
  const components = {
    composite: clampNumber(Number(cand && cand.composite_score || 0), 0, 100),
    actionability: clampNumber(Number(cand && cand.actionability && cand.actionability.score || 0), 0, 100),
    directive_fit: clampNumber(Number(cand && cand.directive_fit && cand.directive_fit.score || 0), 0, 100),
    signal_quality: clampNumber(Number(cand && cand.quality && cand.quality.score || 0), 0, 100),
    expected_value: expectedValue,
    estimated_tokens: estimatedTokens,
    value_density: valueDensity,
    risk_penalty: riskPenalty(p) * 50,
    time_to_value: timeToValueScore(p)
  };
  const raw = (
    Number(weights.composite || 0) * components.composite
    + Number(weights.actionability || 0) * components.actionability
    + Number(weights.directive_fit || 0) * components.directive_fit
    + Number(weights.signal_quality || 0) * components.signal_quality
    + Number(weights.expected_value || 0) * components.expected_value
    + valueDensityWeight * components.value_density
    - Number(weights.risk_penalty || 0) * components.risk_penalty
    + Number(weights.time_to_value || 0) * components.time_to_value
  );
  return {
    score: Number(raw.toFixed(3)),
    components,
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
  const objectiveWeight = executionMode === 'canary_execute'
    ? baseObjectiveWeight
    : Number((baseObjectiveWeight * 0.35).toFixed(3));
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

function runRouteExecute(task, tokensEst, repeats14d = 1, errors30d = 0, dryRun = false) {
  const script = path.join(REPO_ROOT, 'systems', 'routing', 'route_execute.js');
  const args = [
    script,
    '--task', task,
    '--tokens_est', String(tokensEst),
    '--repeats_14d', String(repeats14d),
    '--errors_30d', String(errors30d)
  ];
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
  return String(p && p.type || '').trim().toLowerCase() === 'directive_clarification';
}

function isDirectiveDecompositionProposal(p) {
  return String(p && p.type || '').trim().toLowerCase() === 'directive_decomposition';
}

function sanitizeDirectiveObjectiveId(v) {
  const raw = String(v || '').trim();
  if (!raw) return '';
  if (!/^T[0-9]_[A-Za-z0-9_]+$/.test(raw)) return '';
  return raw;
}

function parseDirectiveFileArgFromCommand(cmd) {
  const text = String(cmd || '').trim();
  if (!text) return '';
  const m = text.match(/(?:^|\s)--file=(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const raw = String((m && (m[1] || m[2] || m[3])) || '').trim();
  if (!raw) return '';
  if (!/^config\/directives\/[A-Za-z0-9_]+\.ya?ml$/i.test(raw)) return '';
  return raw.replace(/\\/g, '/');
}

function parseDirectiveObjectiveArgFromCommand(cmd) {
  const text = normalizeSpaces(cmd);
  if (!text) return '';
  const m = text.match(/(?:^|\s)--id=(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const raw = normalizeSpaces(m && (m[1] || m[2] || m[3]));
  const id = sanitizeDirectiveObjectiveId(raw);
  return id || '';
}

function directiveClarificationExecSpec(p) {
  if (!isDirectiveClarificationProposal(p)) return null;
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
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const actuation = meta && meta.actuation && typeof meta.actuation === 'object' ? meta.actuation : null;
  if (!actuation) return null;
  const kind = String(actuation.kind || '').trim();
  if (!kind) return null;
  const params = actuation.params && typeof actuation.params === 'object' ? actuation.params : {};
  return { kind, params };
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
  const s = String(v || '');
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

function numberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseJsonObjectsFromText(text, maxObjects = 40) {
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
  const totalCount = Number(src.total_count || 0);
  const unknownExemptReasons = new Set([
    'artifact_delta_unavailable',
    'entry_delta_unavailable',
    'revenue_delta_unavailable',
    'outreach_artifact_unavailable',
    'reply_or_interview_count_unavailable'
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
  const primary = String(src.primary_failure || '').toLowerCase();
  if (primary.includes('metric_not_allowed_for_capability')) return true;
  if (primary.includes('insufficient_supported_metrics')) return true;
  const criteria = src.success_criteria && typeof src.success_criteria === 'object'
    ? src.success_criteria
    : {};
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

  const metricsUsage = normalizeTokenUsageShape(
    executionMetrics && executionMetrics.token_usage && typeof executionMetrics.token_usage === 'object'
      ? executionMetrics.token_usage
      : null,
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
  if (v === true) return true;
  if (v === false || v == null) return false;
  const t = String(v).trim().toLowerCase();
  return t === 'true' || t === '1' || t === 'yes';
}

function falseyFlag(v) {
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
  const budgetSignalText = normalizeSpaces([budgetReason, routeReason].filter(Boolean).join(' ')).toLowerCase();
  const budgetBlockedByReason = budgetSignalText.includes('burn_rate_exceeded')
    || budgetSignalText.includes('budget_autopause')
    || budgetSignalText.includes('budget guard blocked')
    || budgetSignalText.includes('budget_deferred')
    || budgetSignalText.includes('budget_blocked');
  const budgetBlocked = truthyFlag(s.budget_blocked)
    || truthyFlag(s.budget_global_guard && s.budget_global_guard.blocked)
    || truthyFlag(s.budget_enforcement && s.budget_enforcement.blocked)
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
  const checks = [
    { name: execCheckName, pass: !!(execRes && execRes.ok === true) },
    { name: 'postconditions_ok', pass: !!(postconditions && postconditions.passed === true) },
    { name: 'dod_passed', pass: !!(dod && dod.passed === true) },
    { name: 'success_criteria_met', pass: criteriaPass },
    { name: 'queue_outcome_logged', pass: !!(outcomeRes && outcomeRes.ok === true) },
    { name: 'route_model_attested', pass: !routeAttestationMismatch }
  ];
  const checkMap = Object.create(null);
  for (const check of checks) checkMap[check.name] = check.pass === true;
  let outcome = 'shipped';
  if (!checkMap[execCheckName] || !checkMap.postconditions_ok || !checkMap.queue_outcome_logged || !checkMap.route_model_attested) outcome = 'reverted';
  else if (!checkMap.dod_passed || !checkMap.success_criteria_met) outcome = 'no_change';
  const failed = checks.filter(c => !c.pass).map(c => c.name);
  const verification = withSuccessCriteriaVerification({
    checks,
    failed,
    passed: failed.length === 0,
    outcome,
    primary_failure: failed.length
      ? (failed[0] === 'success_criteria_met' && criteria.primary_failure
        ? String(criteria.primary_failure)
        : failed[0])
      : null
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
  return Object.prototype.hasOwnProperty.call(process.env, name)
    && String(process.env[name] == null ? '' : process.env[name]).trim() !== '';
}

function coalesceNumeric(primary, fallback, nullFallback = null) {
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
  return {
    min_samples: clampNumber(Math.round(AUTONOMY_MODEL_CATALOG_CANARY_MIN_SAMPLES), 1, 50),
    max_fail_rate: clampNumber(AUTONOMY_MODEL_CATALOG_CANARY_MAX_FAIL_RATE, 0, 1),
    max_route_block_rate: clampNumber(AUTONOMY_MODEL_CATALOG_CANARY_MAX_ROUTE_BLOCK_RATE, 0, 1)
  };
}

function normalizeModelIds(input, limit = 128) {
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

function candidatePool(dateStr) {
  const proposals = loadProposalsForDate(dateStr);
  const overlay = buildOverlay(allDecisionEvents());
  const strategy = strategyProfile();
  const allowedRisks = effectiveAllowedRisksSet();
  const duplicateWindowHours = strategyDuplicateWindowHours(strategy, 24);
  const recentKeyCounts = recentProposalKeyCounts(dateStr, duplicateWindowHours);
  const seenDedup = new Set();
  const pool = [];
  const backfillPool = [];
  for (const p of proposals) {
    if (!p || !p.id) continue;
    const ov = overlay.get(p.id) || null;
    const status = proposalStatus(ov);
    if (status === 'rejected' || status === 'parked') continue;
    const allowUnderflowBackfill = AUTONOMY_ONLY_OPEN_PROPOSALS
      && status !== 'pending'
      && canQueueUnderflowBackfill(status, ov);
    if (AUTONOMY_ONLY_OPEN_PROPOSALS && status !== 'pending' && !allowUnderflowBackfill) continue;
    const dedupKey = proposalDedupKey(p);
    const admission = strategyAdmissionDecision(p, strategy, {
      dedup_key: dedupKey,
      recent_key_counts: recentKeyCounts
    });
    if (!admission.allow) continue;
    const risk = normalizedRisk(p.risk);
    if (allowedRisks.size > 0 && !allowedRisks.has(risk)) continue;
    if (cooldownActive(p.id)) continue;
    if (seenDedup.has(dedupKey)) continue;
    seenDedup.add(dedupKey);
    const row = {
      proposal: p,
      overlay: ov,
      status,
      score: proposalScore(p, ov, dateStr),
      dedup_key: dedupKey,
      admission
    };
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
  if (pool.length > 0) return pool;
  if (backfillPool.length <= 0) return backfillPool;
  backfillPool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.proposal.id).localeCompare(String(b.proposal.id));
  });
  return backfillPool.slice(0, AUTONOMY_QUEUE_UNDERFLOW_BACKFILL_MAX);
}

function proposalStatusForQueuePressure(proposal, overlayEntry) {
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
    if (status === 'pending') pending += 1;
    else if (status === 'accepted') accepted += 1;
    else if (status === 'closed') closed += 1;
    else if (status === 'rejected') rejected += 1;
    else if (status === 'parked') parked += 1;
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
  if (c.queue_underflow_backfill === true) return 'quarantine';
  if (pulseTier <= 1) return 'critical';
  if (proposalType === 'directive_clarification' || proposalType === 'directive_decomposition') return 'critical';
  if (isDeprioritizedSourceProposal(proposal)) return 'quarantine';
  if (risk === 'medium') return 'explore';
  return 'standard';
}

function qosLaneWeights(queuePressure: AnyObj = {}) {
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
  const out = {
    critical: 0,
    standard: 0,
    explore: 0,
    quarantine: 0
  };
  for (const evt of Array.isArray(priorRuns) ? priorRuns : []) {
    if (!evt || evt.type !== 'autonomy_run' || evt.result !== 'executed') continue;
    const mode = String(evt.selection_mode || '').toLowerCase();
    const m = mode.match(/qos_(critical|standard|explore|quarantine)_/);
    if (m && m[1]) out[m[1]] = Number(out[m[1]] || 0) + 1;
  }
  return out;
}

function qosLaneShareCapExceeded(lane, usage, executedCount) {
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
  return Math.max(1, Math.floor(Math.max(1, maxRuns) * frac));
}

function chooseSelectionMode(eligible, priorRuns) {
  const executed = (priorRuns || []).filter(e => e && e.type === 'autonomy_run' && e.result === 'executed');
  const executedCount = executed.length;
  const exploreUsed = executed.filter(e => e.selection_mode === 'explore').length;
  const quota = exploreQuotaForDay();
  const exp = effectiveStrategyExploration();
  const everyN = Math.max(1, Number(exp.every_n || AUTONOMY_EXPLORE_EVERY_N));
  const minEligible = Math.max(2, Number(exp.min_eligible || AUTONOMY_EXPLORE_MIN_ELIGIBLE));

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
    exploit_used: executed.filter(e => e.selection_mode === 'exploit').length
  };
}

function chooseEvidenceSelectionMode(eligible, priorRuns, modePrefix) {
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
  const maxRunsPerDay = Number.isFinite(Number(strategyBudget.daily_runs_cap))
    ? Number(strategyBudget.daily_runs_cap)
    : AUTONOMY_MAX_RUNS_PER_DAY;
  const canaryDailyExecLimit = executionMode === 'canary_execute'
    ? effectiveStrategyCanaryExecLimit()
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

  if (
    AUTONOMY_REQUIRE_READINESS_FOR_EXECUTE
    && isExecuteMode(executionMode)
  ) {
    const minDays = strategy
      && strategy.promotion_policy
      && Number.isFinite(Number(strategy.promotion_policy.min_days))
        ? Number(strategy.promotion_policy.min_days)
        : null;
    const readiness = runStrategyReadiness(dateStr, strategy ? strategy.id : null, minDays);
    const payload = readiness.payload && typeof readiness.payload === 'object' ? readiness.payload : null;
    const ready = !!(readiness.ok && payload && payload.ok === true && payload.readiness && payload.readiness.ready_for_execute === true);
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

  const strategy = strategyProfile();
  const strategyBudget = effectiveStrategyBudget();
  const executionMode = shadowOnly ? 'score_only' : effectiveStrategyExecutionMode();
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
  const allowedRiskSet = effectiveAllowedRisksSet();
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

  const priorRunsForPolicyHoldCooldown = runsSinceReset(readRuns(dateStr));
  const lastPolicyHoldRun = latestPolicyHoldRunEvent(priorRunsForPolicyHoldCooldown);
  const policyHoldPressure = policyHoldPressureSnapshot(priorRunsForPolicyHoldCooldown);
  const policyHoldCooldownMinutes = policyHoldCooldownMinutesForPressure(
    Math.max(0, Number(AUTONOMY_POLICY_HOLD_COOLDOWN_MINUTES || 0)),
    policyHoldPressure
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

  const pool = candidatePool(proposalDate);
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
  const maxRunsPerDay = Number.isFinite(Number(strategyBudget.daily_runs_cap))
    ? Number(strategyBudget.daily_runs_cap)
    : AUTONOMY_MAX_RUNS_PER_DAY;
  const canaryDailyExecLimit = executionMode === 'canary_execute'
    ? effectiveStrategyCanaryExecLimit()
    : null;
  const mediumCanaryDailyExecLimit = executionMode === 'canary_execute'
    ? Math.max(0, Number(AUTONOMY_CANARY_MEDIUM_RISK_DAILY_EXEC_LIMIT || 0))
    : 0;
  const dopamine = loadDopamineSnapshot(dateStr);
  const decisionEvents = allDecisionEvents();
  const eyesMap = loadEyesMap();
  const directiveProfile = loadDirectiveFitProfile();
  const calibrationProfile: AnyObj = computeCalibrationProfile(dateStr, true);
  const thresholds = calibrationProfile.effective_thresholds || baseThresholds();
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
    directive_pulse_cooldown: 0
  };
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
  const fitnessPolicy = outcomeFitnessPolicy();
  const candidateAuditLimit = clampNumber(Math.round(AUTONOMY_CANDIDATE_AUDIT_MAX_ROWS), 5, 200);
  const candidateRejectedByGate = {};
  const candidateAuditRows = [];
  const budgetPacingState = budgetPacingSnapshot(dateStr);
  const queuePressureState = queuePressureSnapshot(proposalDate);
  const candidateAuditPolicy = {
    strategy_id: strategy ? strategy.id : null,
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
      snapshot: budgetPacingState
    },
    campaign_scheduler: {
      enabled: Array.isArray(strategy && strategy.campaigns) && strategy.campaigns.length > 0
    },
    queue_underflow_backfill: {
      enabled: AUTONOMY_QUEUE_UNDERFLOW_BACKFILL_MAX > 0,
      max_candidates: AUTONOMY_QUEUE_UNDERFLOW_BACKFILL_MAX
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
  const writeCandidateAudit = (selectedProposalId = null, selectionMode = null, reservation = null) => {
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
      const budgetPacingGate = evaluateBudgetPacingGate(cand, valueSignal, risk, budgetPacingState);
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
      cand.strategy_rank = strategyRankForCandidate(cand, strategy);
      const adjusted = strategyRankAdjustedForCandidate(cand, executionMode);
      cand.strategy_rank_adjusted = adjusted.adjusted;
      cand.strategy_rank_bonus = adjusted.bonus;
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
    }, strategy);
    const fallbackAdjusted = strategyRankAdjustedForCandidate({
      ...fallback,
      directive_pulse: pulse,
      strategy_rank: fallbackStrategyRank
    }, executionMode);
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
      strategy_rank_bonus: fallbackAdjusted.bonus
    };
    selection = {
      mode: 'shadow_fallback',
      index: 0,
      explore_used: 0,
      explore_quota: 0,
      exploit_used: 0
    };
  }

  writeCandidateAudit(
    pick && pick.proposal ? String(pick.proposal.id || '') : null,
    selection ? selection.mode : null,
    tierReservation && Number(tierReservation.candidate_count || 0) > 0 ? tierReservation : null
  );

  if (!pick) {
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
      reason: `all_candidates_exhausted quality_or_directive_fit_or_actionability_or_optimization_good_enough_or_objective_binding_or_value_or_budget_pacing_or_composite_or_capability_cooldown_or_medium_risk_or_eye_no_progress_or_directive_pulse`,
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
      sample_directive_pulse_cooldown: sampleDirectivePulseCooldown
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'stop_repeat_gate_candidate_exhausted',
      reason: `all_candidates_exhausted quality_or_directive_fit_or_actionability_or_optimization_good_enough_or_objective_binding_or_value_or_budget_pacing_or_composite_or_capability_cooldown_or_medium_risk_or_eye_no_progress_or_directive_pulse`,
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
          : runRouteExecute(makeTaskFromProposal(p), routeTokensEst, repeats14d, errors30d, true);
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
          capability_key: capabilityKey,
          outcome: previewVerification.outcome,
          exec_ok: previewRes && previewRes.ok === true,
          dod_passed: previewVerification.passed === true,
          postconditions_ok: previewVerification.passed === true,
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
      token_usage: previewTokenUsage,
      ts: nowIso()
    }) + '\n');
    return;
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
  if (autopauseActive && !shadowOnly) {
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
      : runRouteExecute(task, routeTokensEst, repeats14d, errors30d, true);
  const preSummary = preflight.summary || null;
  const preBlocked = !preflight.ok
    || !preSummary
    || preSummary.executable !== true
    || preSummary.gate_decision === 'MANUAL'
    || preSummary.gate_decision === 'DENY';
  const preTokenUsage = computeExecutionTokenUsage(preSummary, preflight.execution_metrics, routeTokensEst, estTokens);

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
      : runRouteExecute(task, routeTokensEst, repeats14d, errors30d, false);
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
  const ts = Date.parse(String(lock && lock.ts || ''));
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, (Date.now() - ts) / (60 * 1000));
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
  const rawMax = Number(parseArg('max') || process.env.AUTONOMY_BATCH_MAX || 3);
  const max = Number.isFinite(rawMax) ? Math.max(1, Math.min(10, Math.round(rawMax))) : 3;
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
  proposalScore,
  assessActionability,
  estimateTokens,
  candidatePool,
  evaluateDoD,
  diffDoDEvidence,
  hasStructuralPreviewCriteriaFailure,
  computeCalibrationDeltas,
  compileDirectivePulseObjectives,
  buildDirectivePulseContext,
  assessDirectivePulse,
  qosLaneFromCandidate,
  chooseQosLaneSelection,
  queuePressureSnapshot,
  spawnCapacityBoostSnapshot,
  TS_CLONE_DYNAMIC_IO_PARITY,
  isPolicyHoldResult,
  isPolicyHoldRunEvent,
  latestPolicyHoldRunEvent,
  policyHoldPressureSnapshot,
  policyHoldCooldownMinutesForPressure,
  executeConfidenceCooldownKey,
  executeConfidenceCooldownActive,
  startModelCatalogCanary,
  evaluateModelCatalogCanary,
  readModelCatalogCanary,
  runPostconditions
};
