#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadRegistry } = require('./workflow_controller');
const {
  loadSystemBudgetState,
  loadSystemBudgetAutopauseState,
  evaluateSystemBudgetGuard,
  writeSystemBudgetDecision,
  recordSystemBudgetUsage
} = require('../budget/system_budget');
let evaluateRateLimitDecision = null;
let recordRateLimitOutcome = null;
try {
  ({ evaluateRateLimitDecision, recordRateLimitOutcome } = require('./rate_limit_intelligence.js'));
} catch {
  evaluateRateLimitDecision = null;
  recordRateLimitOutcome = null;
}
let prepareCommunicationAttempt = null;
let finalizeCommunicationAttempt = null;
try {
  ({ prepareCommunicationAttempt, finalizeCommunicationAttempt } = require('./client_communication_organ.js'));
} catch {
  prepareCommunicationAttempt = null;
  finalizeCommunicationAttempt = null;
}
let recordHighValuePlayOutcomes = null;
try {
  ({ recordExecutionOutcomes: recordHighValuePlayOutcomes } = require('./high_value_play_detector.js'));
} catch {
  recordHighValuePlayOutcomes = null;
}
let candidateMutationOrderExternal = null;
let applyMutationKindExternal = null;
let evaluateMutationGateExternal = null;
try {
  ({
    candidateMutationOrder: candidateMutationOrderExternal,
    applyMutationKind: applyMutationKindExternal,
    evaluateMutationGate: evaluateMutationGateExternal
  } = require('./inflight_mutation_engine.js'));
} catch {
  candidateMutationOrderExternal = null;
  applyMutationKindExternal = null;
  evaluateMutationGateExternal = null;
}

type AnyObj = Record<string, any>;

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(REPO_ROOT, 'config', 'workflow_executor_policy.json');
const RUNS_DIR = process.env.WORKFLOW_EXECUTOR_RUNS_DIR
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_RUNS_DIR)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'executor', 'runs');
const HISTORY_PATH = process.env.WORKFLOW_EXECUTOR_HISTORY_PATH
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_HISTORY_PATH)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'executor', 'history.jsonl');
const LATEST_PATH = process.env.WORKFLOW_EXECUTOR_LATEST_PATH
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_LATEST_PATH)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'executor', 'latest.json');
const LATEST_LIVE_PATH = process.env.WORKFLOW_EXECUTOR_LATEST_LIVE_PATH
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_LATEST_LIVE_PATH)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'executor', 'latest_live.json');
const ROLLOUT_STATE_PATH = process.env.WORKFLOW_EXECUTOR_ROLLOUT_STATE_PATH
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_ROLLOUT_STATE_PATH)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'executor', 'rollout_state.json');
const STEP_RECEIPTS_DIR = process.env.WORKFLOW_EXECUTOR_STEP_RECEIPTS_DIR
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_STEP_RECEIPTS_DIR)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'executor', 'step_receipts');
const MUTATION_RECEIPTS_DIR = process.env.WORKFLOW_EXECUTOR_MUTATION_RECEIPTS_DIR
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_MUTATION_RECEIPTS_DIR)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'executor', 'mutations');
const DEFER_QUEUE_PATH = process.env.WORKFLOW_EXECUTOR_DEFER_QUEUE_PATH
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_DEFER_QUEUE_PATH)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'executor', 'defer_queue.jsonl');
const EXEC_CWD = process.env.WORKFLOW_EXECUTOR_CWD
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_CWD)
  : REPO_ROOT;
const EYE_KERNEL_SCRIPT = process.env.WORKFLOW_EXECUTOR_EYE_KERNEL_SCRIPT
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_EYE_KERNEL_SCRIPT)
  : path.join(REPO_ROOT, 'systems', 'eye', 'eye_kernel.js');
const SUBSUMPTION_REGISTRY_SCRIPT = process.env.WORKFLOW_EXECUTOR_SUBSUMPTION_REGISTRY_SCRIPT
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_SUBSUMPTION_REGISTRY_SCRIPT)
  : path.join(REPO_ROOT, 'systems', 'eye', 'subsumption_registry.js');
const POLICY_ROOT_SCRIPT = process.env.WORKFLOW_EXECUTOR_POLICY_ROOT_SCRIPT
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_POLICY_ROOT_SCRIPT)
  : path.join(REPO_ROOT, 'systems', 'security', 'policy_rootd.js');
const EYE_POLICY_PATH = process.env.WORKFLOW_EXECUTOR_EYE_POLICY_PATH
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_EYE_POLICY_PATH)
  : path.join(REPO_ROOT, 'config', 'eye_kernel_policy.json');
const EYE_STATE_PATH = process.env.WORKFLOW_EXECUTOR_EYE_STATE_PATH
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_EYE_STATE_PATH)
  : path.join(REPO_ROOT, 'state', 'eye', 'control_plane_state.json');
const EYE_AUDIT_PATH = process.env.WORKFLOW_EXECUTOR_EYE_AUDIT_PATH
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_EYE_AUDIT_PATH)
  : path.join(REPO_ROOT, 'state', 'eye', 'audit', 'command_bus.jsonl');
const EYE_LATEST_PATH = process.env.WORKFLOW_EXECUTOR_EYE_LATEST_PATH
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_EYE_LATEST_PATH)
  : path.join(REPO_ROOT, 'state', 'eye', 'latest.json');
const SUBSUMPTION_POLICY_PATH = process.env.WORKFLOW_EXECUTOR_SUBSUMPTION_POLICY_PATH
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_SUBSUMPTION_POLICY_PATH)
  : path.join(REPO_ROOT, 'config', 'subsumption_adapter_policy.json');
const SUBSUMPTION_STATE_PATH = process.env.WORKFLOW_EXECUTOR_SUBSUMPTION_STATE_PATH
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_SUBSUMPTION_STATE_PATH)
  : path.join(REPO_ROOT, 'state', 'eye', 'subsumption_registry_state.json');
const SUBSUMPTION_AUDIT_PATH = process.env.WORKFLOW_EXECUTOR_SUBSUMPTION_AUDIT_PATH
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_SUBSUMPTION_AUDIT_PATH)
  : path.join(REPO_ROOT, 'state', 'eye', 'audit', 'subsumption_registry.jsonl');
const SUBSUMPTION_LATEST_PATH = process.env.WORKFLOW_EXECUTOR_SUBSUMPTION_LATEST_PATH
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_SUBSUMPTION_LATEST_PATH)
  : path.join(REPO_ROOT, 'state', 'eye', 'subsumption_latest.json');
const SYSTEM_HEALTH_EVENTS_PATH = process.env.SYSTEM_HEALTH_EVENTS_PATH
  ? path.resolve(process.env.SYSTEM_HEALTH_EVENTS_PATH)
  : path.join(REPO_ROOT, 'state', 'ops', 'system_health', 'events.jsonl');
const SOUL_TOKEN_GUARD_SCRIPT = process.env.WORKFLOW_EXECUTOR_SOUL_TOKEN_GUARD_SCRIPT
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_SOUL_TOKEN_GUARD_SCRIPT)
  : path.join(REPO_ROOT, 'systems', 'security', 'soul_token_guard.js');

function usage() {
  console.log('Usage:');
  console.log('  node systems/workflow/workflow_executor.js run [YYYY-MM-DD] [--id=<workflow_id>] [--max=N] [--include-draft=1|0] [--dry-run=1|0] [--continue-on-error=1|0] [--receipt-strict=1|0] [--runtime-mutation=1|0] [--runtime-mutation-safety-attested=1|0] [--runtime-mutation-veto-cleared=1|0] [--enforce-eligibility=1|0] [--policy=path]');
  console.log('  node systems/workflow/workflow_executor.js status [YYYY-MM-DD|latest|latest-live]');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
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

function dateArgOrToday(v: unknown) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function boolFlag(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function cleanText(v: unknown, maxLen = 180) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return payload == null ? fallback : payload;
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

function parseJsonPayload(raw: unknown) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function shellUnquote(raw: unknown) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '';
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('\'') && text.endsWith('\''))) {
    return text.slice(1, -1);
  }
  return text;
}

function parseCommandFlag(command: string, flag: string) {
  const escaped = String(flag || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\s)--${escaped}=(\"[^\"]+\"|'[^']+'|[^\\s]+)`);
  const match = String(command || '').match(re);
  if (!match) return '';
  return shellUnquote(match[1] || '');
}

function runJsonCommand(args: string[], opts: AnyObj = {}) {
  const timeoutMs = clampInt(opts.timeout_ms, 200, 120000, 15000);
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  const payload = parseJsonPayload(result && result.stdout);
  const ok = Number(result && result.status) === 0 && payload && payload.ok === true;
  return {
    ok,
    status: Number.isInteger(result && result.status) ? Number(result.status) : 1,
    payload,
    stdout: String(result && result.stdout || '').trim().slice(0, 2000),
    stderr: String(result && result.stderr || '').trim().slice(0, 2000),
    error: result && result.error ? String(result.error.message || result.error).slice(0, 2000) : null
  };
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`);
}

function appendSystemHealthEvent(row: AnyObj) {
  try {
    ensureDir(path.dirname(SYSTEM_HEALTH_EVENTS_PATH));
    const payload = row && typeof row === 'object' ? row : {};
    const event = {
      ts: nowIso(),
      type: 'system_health_event',
      source: 'workflow_executor',
      subsystem: 'workflow.executor',
      severity: 'medium',
      risk: 'medium',
      code: 'workflow_executor_event',
      summary: 'workflow executor event',
      ...payload
    };
    fs.appendFileSync(SYSTEM_HEALTH_EVENTS_PATH, `${JSON.stringify(event)}\n`);
  } catch {
    // Health telemetry must never block workflow execution.
  }
}

function relPath(filePath: string) {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

function stableId(seed: unknown, prefix = 'wf') {
  const src = String(seed == null ? '' : seed);
  let h = 2166136261;
  for (let i = 0; i < src.length; i += 1) {
    h ^= src.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  return `${prefix}_${hex}`;
}

function safeRate(num: unknown, den: unknown, fallback = 0) {
  const n = Number(num);
  const d = Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return fallback;
  return n / d;
}

function defaultPolicy() {
  return {
    version: '1.0',
    execution_gate: {
      enabled: true,
      min_steps: 3,
      require_gate_step: true,
      require_receipt_step: true,
      require_concrete_commands: true,
      require_rollback_path: true,
      allow_policy_default_rollback: true,
      min_composite_score: 0.45,
      require_metrics_for_auto: false,
      blocked_command_tokens: ['todo', 'placeholder', 'tbd'],
      placeholder_allowlist: ['date', 'workflow_id', 'step_id', 'run_id', 'objective_id', 'eye_id', 'adapter', 'provider']
    },
    failure_rollback: {
      enabled: true,
      default_command: 'node systems/autonomy/strategy_execute_guard.js rollback <date>',
      timeout_ms: 120000,
      retries: 0
    },
    rollout: {
      enabled: true,
      initial_stage: 'canary',
      shadow_dry_run: true,
      canary_fraction: 0.15,
      canary_min_fraction: 0.05,
      canary_max_fraction: 0.6,
      scale_up_step: 0.1,
      scale_down_step: 0.1,
      min_consecutive_green_for_scale_up: 3,
      min_consecutive_red_for_scale_down: 1,
      promote_to_live_fraction: 0.6,
      demote_shadow_on_floor_breach: true,
      rollback_guard: {
        enabled: true,
        trigger_on_workflow_failure: true,
        trigger_on_workflow_blocked: true,
        min_execution_success_rate: 0.95,
        rollback_fraction_step: 0.2,
        demote_live_to_canary: true
      }
    },
    slo: {
      min_execution_success_rate: 0.9,
      min_queue_drain_rate: 0.75,
      max_time_to_first_execution_ms: 180000,
      lookback_runs: 6,
      min_runs_for_decision: 3,
      ignore_dry_run_history: true
    },
    fallback_selection: {
      enabled: true,
      trigger_when_selected_zero: true,
      include_drafts: false,
      require_safe_commands: true,
      allow_eligibility_reasons: ['composite_score_below_min'],
      max_candidates_considered: 32
    },
    minimum_selection: {
      enabled: true,
      target_selected: 1,
      require_low_risk_presence: true,
      include_drafts: false,
      require_safe_commands: true,
      allow_eligibility_reasons: ['composite_score_below_min'],
      max_candidates_considered: 64
    },
    alerts: {
      live_zero_selection_streak_threshold: 2,
      history_scan_limit: 240
    },
    runtime_mutation: {
      enabled: true,
      max_mutations_per_run: 8,
      max_mutations_per_workflow: 2,
      retry_after_apply: true,
      rollback_on_regression: true,
      max_retry_increment: 1,
      max_total_retry_per_step: 3,
      veto_window_sec: 0,
      require_safety_attestation: false,
      require_human_veto_for_high_impact: false,
      high_impact_levels: ['high', 'critical'],
      max_attempts_per_kind: 3,
      allow: {
        guard_hardening: true,
        rollback_path: true,
        retry_tuning: true
      }
    },
    step_runtime: {
      enforce_success_criteria: true,
      default_allowed_exit_codes: [0],
      max_total_attempts_per_workflow: 24,
      max_total_retry_attempts_per_workflow: 16,
      max_total_step_duration_ms_per_workflow: 10 * 60 * 1000
    },
    external_orchestration: {
      enabled: true,
      detect_actuation_commands: true,
      command_pattern: 'systems/actuation/actuation_executor.js',
      require_policy_root_for_live: true,
      allow_dry_run_without_policy_root: true,
      policy_root_scope: 'workflow_external_orchestration',
      policy_root_source: 'workflow_executor',
      eye_lane: 'vassal',
      eye_action: 'execute',
      eye_clearance: 'L2',
      risk_default: 'medium',
      require_subsumption_allow: true,
      allow_escalate_decision: false,
      estimated_tokens_default: 100,
      default_provider: 'ollama'
    },
    security_gates: {
      soul_token: {
        enabled: true,
        enforce_shadow_on_violation: true,
        strict_verify: false,
        timeout_ms: 8000,
        script: 'systems/security/soul_token_guard.js'
      }
    },
    token_economics: {
      enabled: true,
      use_system_budget: true,
      run_token_cap: 0,
      fallback_run_token_cap: 1200,
      reserve_tokens_for_critical_lanes: 320,
      per_workflow_min_token_cap: 80,
      per_workflow_min_token_cap_critical: 140,
      per_workflow_max_token_cap: 2200,
      step_command_default_tokens: 40,
      step_gate_tokens: 18,
      step_receipt_tokens: 10,
      step_external_tokens: 120,
      envelope_headroom_multiplier: 1.6,
      throttle_floor_ratio: 0.35,
      defer_queue_enabled: true,
      defer_on_autopause: true,
      defer_on_guard_deny: true,
      allow_critical_when_autopause: false,
      critical_priority_floor: 4,
      critical_tags: ['critical', 'security', 'doctor', 'repair', 'incident', 'compliance', 'recovery']
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const gate = raw && raw.execution_gate && typeof raw.execution_gate === 'object'
    ? raw.execution_gate
    : {};
  const failureRollback = raw && raw.failure_rollback && typeof raw.failure_rollback === 'object'
    ? raw.failure_rollback
    : {};
  const rollout = raw && raw.rollout && typeof raw.rollout === 'object'
    ? raw.rollout
    : {};
  const slo = raw && raw.slo && typeof raw.slo === 'object'
    ? raw.slo
    : {};
  const fallbackSelection = raw && raw.fallback_selection && typeof raw.fallback_selection === 'object'
    ? raw.fallback_selection
    : {};
  const minimumSelection = raw && raw.minimum_selection && typeof raw.minimum_selection === 'object'
    ? raw.minimum_selection
    : {};
  const alerts = raw && raw.alerts && typeof raw.alerts === 'object'
    ? raw.alerts
    : {};
  const rm = raw && raw.runtime_mutation && typeof raw.runtime_mutation === 'object'
    ? raw.runtime_mutation
    : {};
  const stepRuntime = raw && raw.step_runtime && typeof raw.step_runtime === 'object'
    ? raw.step_runtime
    : {};
  const external = raw && raw.external_orchestration && typeof raw.external_orchestration === 'object'
    ? raw.external_orchestration
    : {};
  const securityGates = raw && raw.security_gates && typeof raw.security_gates === 'object'
    ? raw.security_gates
    : {};
  const tokenEconomicsRaw = raw && raw.token_economics && typeof raw.token_economics === 'object'
    ? raw.token_economics
    : {};
  const soulTokenGateRaw = securityGates && securityGates.soul_token && typeof securityGates.soul_token === 'object'
    ? securityGates.soul_token
    : {};
  const allowRaw = rm && rm.allow && typeof rm.allow === 'object' ? rm.allow : {};
  const normalizeTokenArray = (input: unknown, fallback: string[]) => {
    if (!Array.isArray(input)) return fallback.slice(0);
    const out = input
      .map((v) => String(v == null ? '' : v).trim().toLowerCase())
      .filter(Boolean);
    return out.length ? Array.from(new Set(out)) : fallback.slice(0);
  };
  const stageRaw = String(rollout.initial_stage || base.rollout.initial_stage).trim().toLowerCase();
  const initialStage = stageRaw === 'shadow' || stageRaw === 'canary' || stageRaw === 'live'
    ? stageRaw
    : base.rollout.initial_stage;
  return {
    version: cleanText(raw.version || base.version, 24) || '1.0',
    execution_gate: {
      enabled: gate.enabled !== false,
      min_steps: clampInt(gate.min_steps, 1, 32, base.execution_gate.min_steps),
      require_gate_step: gate.require_gate_step !== false,
      require_receipt_step: gate.require_receipt_step !== false,
      require_concrete_commands: gate.require_concrete_commands !== false,
      require_rollback_path: gate.require_rollback_path !== false,
      allow_policy_default_rollback: gate.allow_policy_default_rollback !== false,
      min_composite_score: clampNumber(gate.min_composite_score, 0, 1, base.execution_gate.min_composite_score),
      require_metrics_for_auto: gate.require_metrics_for_auto === true,
      blocked_command_tokens: normalizeTokenArray(gate.blocked_command_tokens, base.execution_gate.blocked_command_tokens),
      placeholder_allowlist: normalizeTokenArray(gate.placeholder_allowlist, base.execution_gate.placeholder_allowlist)
    },
    failure_rollback: {
      enabled: failureRollback.enabled !== false,
      default_command: cleanText(
        failureRollback.default_command || base.failure_rollback.default_command,
        260
      ) || base.failure_rollback.default_command,
      timeout_ms: clampInt(
        failureRollback.timeout_ms,
        500,
        30 * 60 * 1000,
        base.failure_rollback.timeout_ms
      ),
      retries: clampInt(failureRollback.retries, 0, 8, base.failure_rollback.retries)
    },
    rollout: {
      enabled: rollout.enabled !== false,
      initial_stage: initialStage,
      shadow_dry_run: rollout.shadow_dry_run !== false,
      canary_fraction: clampNumber(rollout.canary_fraction, 0.01, 1, base.rollout.canary_fraction),
      canary_min_fraction: clampNumber(rollout.canary_min_fraction, 0.01, 1, base.rollout.canary_min_fraction),
      canary_max_fraction: clampNumber(rollout.canary_max_fraction, 0.01, 1, base.rollout.canary_max_fraction),
      scale_up_step: clampNumber(rollout.scale_up_step, 0.01, 1, base.rollout.scale_up_step),
      scale_down_step: clampNumber(rollout.scale_down_step, 0.01, 1, base.rollout.scale_down_step),
      min_consecutive_green_for_scale_up: clampInt(
        rollout.min_consecutive_green_for_scale_up,
        1,
        100,
        base.rollout.min_consecutive_green_for_scale_up
      ),
      min_consecutive_red_for_scale_down: clampInt(
        rollout.min_consecutive_red_for_scale_down,
        1,
        100,
        base.rollout.min_consecutive_red_for_scale_down
      ),
      promote_to_live_fraction: clampNumber(
        rollout.promote_to_live_fraction,
        0.01,
        1,
        base.rollout.promote_to_live_fraction
      ),
      demote_shadow_on_floor_breach: rollout.demote_shadow_on_floor_breach !== false,
      rollback_guard: {
        enabled: !rollout.rollback_guard || rollout.rollback_guard.enabled !== false,
        trigger_on_workflow_failure: !rollout.rollback_guard || rollout.rollback_guard.trigger_on_workflow_failure !== false,
        trigger_on_workflow_blocked: !rollout.rollback_guard || rollout.rollback_guard.trigger_on_workflow_blocked !== false,
        min_execution_success_rate: clampNumber(
          rollout.rollback_guard && rollout.rollback_guard.min_execution_success_rate,
          0,
          1,
          base.rollout.rollback_guard.min_execution_success_rate
        ),
        rollback_fraction_step: clampNumber(
          rollout.rollback_guard && rollout.rollback_guard.rollback_fraction_step,
          0.01,
          1,
          base.rollout.rollback_guard.rollback_fraction_step
        ),
        demote_live_to_canary: !rollout.rollback_guard || rollout.rollback_guard.demote_live_to_canary !== false
      }
    },
    slo: {
      min_execution_success_rate: clampNumber(
        slo.min_execution_success_rate,
        0,
        1,
        base.slo.min_execution_success_rate
      ),
      min_queue_drain_rate: clampNumber(
        slo.min_queue_drain_rate,
        0,
        1,
        base.slo.min_queue_drain_rate
      ),
      max_time_to_first_execution_ms: clampInt(
        slo.max_time_to_first_execution_ms,
        1000,
        24 * 60 * 60 * 1000,
        base.slo.max_time_to_first_execution_ms
      ),
      lookback_runs: clampInt(slo.lookback_runs, 1, 200, base.slo.lookback_runs),
      min_runs_for_decision: clampInt(
        slo.min_runs_for_decision,
        1,
        100,
        base.slo.min_runs_for_decision
      ),
      ignore_dry_run_history: slo.ignore_dry_run_history !== false
    },
    fallback_selection: {
      enabled: fallbackSelection.enabled !== false,
      trigger_when_selected_zero: fallbackSelection.trigger_when_selected_zero !== false,
      include_drafts: fallbackSelection.include_drafts === true,
      require_safe_commands: fallbackSelection.require_safe_commands !== false,
      allow_eligibility_reasons: (() => {
        const src = Array.isArray(fallbackSelection.allow_eligibility_reasons)
          ? fallbackSelection.allow_eligibility_reasons
          : base.fallback_selection.allow_eligibility_reasons;
        const rows = src
          .map((v) => cleanText(v || '', 96).toLowerCase())
          .filter(Boolean);
        return rows.length ? Array.from(new Set(rows)) : base.fallback_selection.allow_eligibility_reasons.slice(0);
      })(),
      max_candidates_considered: clampInt(
        fallbackSelection.max_candidates_considered,
        1,
        256,
        base.fallback_selection.max_candidates_considered
      )
    },
    minimum_selection: {
      enabled: minimumSelection.enabled !== false,
      target_selected: clampInt(
        minimumSelection.target_selected,
        1,
        32,
        base.minimum_selection.target_selected
      ),
      require_low_risk_presence: minimumSelection.require_low_risk_presence !== false,
      include_drafts: minimumSelection.include_drafts === true,
      require_safe_commands: minimumSelection.require_safe_commands !== false,
      allow_eligibility_reasons: (() => {
        const src = Array.isArray(minimumSelection.allow_eligibility_reasons)
          ? minimumSelection.allow_eligibility_reasons
          : base.minimum_selection.allow_eligibility_reasons;
        const rows = src
          .map((v) => cleanText(v || '', 96).toLowerCase())
          .filter(Boolean);
        return rows.length ? Array.from(new Set(rows)) : base.minimum_selection.allow_eligibility_reasons.slice(0);
      })(),
      max_candidates_considered: clampInt(
        minimumSelection.max_candidates_considered,
        1,
        512,
        base.minimum_selection.max_candidates_considered
      )
    },
    alerts: {
      live_zero_selection_streak_threshold: clampInt(
        alerts.live_zero_selection_streak_threshold,
        1,
        100,
        base.alerts.live_zero_selection_streak_threshold
      ),
      history_scan_limit: clampInt(
        alerts.history_scan_limit,
        20,
        5000,
        base.alerts.history_scan_limit
      )
    },
    runtime_mutation: {
      enabled: rm.enabled !== false,
      max_mutations_per_run: clampInt(rm.max_mutations_per_run, 0, 128, base.runtime_mutation.max_mutations_per_run),
      max_mutations_per_workflow: clampInt(rm.max_mutations_per_workflow, 0, 32, base.runtime_mutation.max_mutations_per_workflow),
      retry_after_apply: rm.retry_after_apply !== false,
      rollback_on_regression: rm.rollback_on_regression !== false,
      max_retry_increment: clampInt(rm.max_retry_increment, 0, 4, base.runtime_mutation.max_retry_increment),
      max_total_retry_per_step: clampInt(rm.max_total_retry_per_step, 0, 8, base.runtime_mutation.max_total_retry_per_step),
      veto_window_sec: clampInt(rm.veto_window_sec, 0, 3600, base.runtime_mutation.veto_window_sec),
      require_safety_attestation: rm.require_safety_attestation === true,
      require_human_veto_for_high_impact: rm.require_human_veto_for_high_impact === true,
      high_impact_levels: (() => {
        const source = Array.isArray(rm.high_impact_levels)
          ? rm.high_impact_levels
          : base.runtime_mutation.high_impact_levels;
        const out = source
          .map((v) => cleanText(v, 40).toLowerCase().replace(/[^a-z0-9_.:/-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, ''))
          .filter(Boolean);
        return out.length ? Array.from(new Set(out)) : base.runtime_mutation.high_impact_levels.slice(0);
      })(),
      max_attempts_per_kind: clampInt(rm.max_attempts_per_kind, 1, 16, base.runtime_mutation.max_attempts_per_kind),
      allow: {
        guard_hardening: allowRaw.guard_hardening !== false,
        rollback_path: allowRaw.rollback_path !== false,
        retry_tuning: allowRaw.retry_tuning !== false
      }
    },
    step_runtime: {
      enforce_success_criteria: stepRuntime.enforce_success_criteria !== false,
      default_allowed_exit_codes: (() => {
        const source = Array.isArray(stepRuntime.default_allowed_exit_codes)
          ? stepRuntime.default_allowed_exit_codes
          : base.step_runtime.default_allowed_exit_codes;
        const out = source
          .map((v) => Number(v))
          .filter((n) => Number.isInteger(n) && n >= 0 && n <= 255);
        return out.length ? Array.from(new Set(out)) : base.step_runtime.default_allowed_exit_codes.slice(0);
      })(),
      max_total_attempts_per_workflow: clampInt(
        stepRuntime.max_total_attempts_per_workflow,
        1,
        4096,
        base.step_runtime.max_total_attempts_per_workflow
      ),
      max_total_retry_attempts_per_workflow: clampInt(
        stepRuntime.max_total_retry_attempts_per_workflow,
        0,
        4096,
        base.step_runtime.max_total_retry_attempts_per_workflow
      ),
      max_total_step_duration_ms_per_workflow: clampInt(
        stepRuntime.max_total_step_duration_ms_per_workflow,
        1000,
        24 * 60 * 60 * 1000,
        base.step_runtime.max_total_step_duration_ms_per_workflow
      )
    },
    external_orchestration: {
      enabled: external.enabled !== false,
      detect_actuation_commands: external.detect_actuation_commands !== false,
      command_pattern: cleanText(external.command_pattern || base.external_orchestration.command_pattern, 220)
        || base.external_orchestration.command_pattern,
      require_policy_root_for_live: external.require_policy_root_for_live !== false,
      allow_dry_run_without_policy_root: external.allow_dry_run_without_policy_root !== false,
      policy_root_scope: cleanText(external.policy_root_scope || base.external_orchestration.policy_root_scope, 120)
        || base.external_orchestration.policy_root_scope,
      policy_root_source: cleanText(external.policy_root_source || base.external_orchestration.policy_root_source, 120)
        || base.external_orchestration.policy_root_source,
      eye_lane: cleanText(external.eye_lane || base.external_orchestration.eye_lane, 40).toLowerCase()
        || base.external_orchestration.eye_lane,
      eye_action: cleanText(external.eye_action || base.external_orchestration.eye_action, 40).toLowerCase()
        || base.external_orchestration.eye_action,
      eye_clearance: cleanText(external.eye_clearance || base.external_orchestration.eye_clearance, 12).toUpperCase()
        || base.external_orchestration.eye_clearance,
      risk_default: cleanText(external.risk_default || base.external_orchestration.risk_default, 24).toLowerCase()
        || base.external_orchestration.risk_default,
      require_subsumption_allow: external.require_subsumption_allow !== false,
      allow_escalate_decision: external.allow_escalate_decision === true,
      estimated_tokens_default: clampInt(
        external.estimated_tokens_default,
        0,
        10_000_000,
        base.external_orchestration.estimated_tokens_default
      ),
      default_provider: cleanText(external.default_provider || base.external_orchestration.default_provider, 80).toLowerCase()
        || base.external_orchestration.default_provider
    },
    security_gates: {
      soul_token: {
        enabled: soulTokenGateRaw.enabled !== false,
        enforce_shadow_on_violation: soulTokenGateRaw.enforce_shadow_on_violation !== false,
        strict_verify: soulTokenGateRaw.strict_verify === true,
        timeout_ms: clampInt(
          soulTokenGateRaw.timeout_ms,
          200,
          120000,
          base.security_gates.soul_token.timeout_ms
        ),
        script: cleanText(soulTokenGateRaw.script || base.security_gates.soul_token.script, 260)
          || base.security_gates.soul_token.script
      }
    },
    token_economics: {
      enabled: tokenEconomicsRaw.enabled !== false,
      use_system_budget: tokenEconomicsRaw.use_system_budget !== false,
      run_token_cap: clampInt(
        tokenEconomicsRaw.run_token_cap,
        0,
        100_000_000,
        base.token_economics.run_token_cap
      ),
      fallback_run_token_cap: clampInt(
        tokenEconomicsRaw.fallback_run_token_cap,
        100,
        100_000_000,
        base.token_economics.fallback_run_token_cap
      ),
      reserve_tokens_for_critical_lanes: clampInt(
        tokenEconomicsRaw.reserve_tokens_for_critical_lanes,
        0,
        100_000_000,
        base.token_economics.reserve_tokens_for_critical_lanes
      ),
      per_workflow_min_token_cap: clampInt(
        tokenEconomicsRaw.per_workflow_min_token_cap,
        0,
        10_000_000,
        base.token_economics.per_workflow_min_token_cap
      ),
      per_workflow_min_token_cap_critical: clampInt(
        tokenEconomicsRaw.per_workflow_min_token_cap_critical,
        0,
        10_000_000,
        base.token_economics.per_workflow_min_token_cap_critical
      ),
      per_workflow_max_token_cap: clampInt(
        tokenEconomicsRaw.per_workflow_max_token_cap,
        1,
        100_000_000,
        base.token_economics.per_workflow_max_token_cap
      ),
      step_command_default_tokens: clampInt(
        tokenEconomicsRaw.step_command_default_tokens,
        1,
        1_000_000,
        base.token_economics.step_command_default_tokens
      ),
      step_gate_tokens: clampInt(
        tokenEconomicsRaw.step_gate_tokens,
        0,
        1_000_000,
        base.token_economics.step_gate_tokens
      ),
      step_receipt_tokens: clampInt(
        tokenEconomicsRaw.step_receipt_tokens,
        0,
        1_000_000,
        base.token_economics.step_receipt_tokens
      ),
      step_external_tokens: clampInt(
        tokenEconomicsRaw.step_external_tokens,
        1,
        1_000_000,
        base.token_economics.step_external_tokens
      ),
      envelope_headroom_multiplier: clampNumber(
        tokenEconomicsRaw.envelope_headroom_multiplier,
        1,
        3,
        base.token_economics.envelope_headroom_multiplier
      ),
      throttle_floor_ratio: clampNumber(
        tokenEconomicsRaw.throttle_floor_ratio,
        0,
        1,
        base.token_economics.throttle_floor_ratio
      ),
      defer_queue_enabled: tokenEconomicsRaw.defer_queue_enabled !== false,
      defer_on_autopause: tokenEconomicsRaw.defer_on_autopause !== false,
      defer_on_guard_deny: tokenEconomicsRaw.defer_on_guard_deny !== false,
      allow_critical_when_autopause: tokenEconomicsRaw.allow_critical_when_autopause === true,
      critical_priority_floor: clampInt(
        tokenEconomicsRaw.critical_priority_floor,
        1,
        5,
        base.token_economics.critical_priority_floor
      ),
      critical_tags: (() => {
        const src = Array.isArray(tokenEconomicsRaw.critical_tags)
          ? tokenEconomicsRaw.critical_tags
          : base.token_economics.critical_tags;
        const out = src
          .map((v) => cleanText(v || '', 64).toLowerCase())
          .filter(Boolean);
        return out.length ? Array.from(new Set(out)) : base.token_economics.critical_tags.slice(0);
      })()
    }
  };
}

function workflowPriorityRank(priorityRaw: unknown) {
  const p = String(priorityRaw || '').trim().toLowerCase();
  if (p === 'critical' || p === 'p0') return 5;
  if (p === 'high' || p === 'p1') return 4;
  if (p === 'medium' || p === 'p2') return 3;
  if (p === 'low' || p === 'p3') return 2;
  if (p === 'background' || p === 'p4') return 1;
  return 3;
}

function classifyWorkflowPriority(workflow: AnyObj, tokenPolicy: AnyObj) {
  const wf = workflow && typeof workflow === 'object' ? workflow : {};
  const meta = wf.metadata && typeof wf.metadata === 'object' ? wf.metadata : {};
  const tags = []
    .concat(Array.isArray(wf.tags) ? wf.tags : [])
    .concat(Array.isArray(meta.tags) ? meta.tags : [])
    .map((v) => cleanText(v || '', 64).toLowerCase())
    .filter(Boolean);
  const criticalTagSet = new Set(
    Array.isArray(tokenPolicy && tokenPolicy.critical_tags)
      ? tokenPolicy.critical_tags.map((v: unknown) => cleanText(v || '', 64).toLowerCase()).filter(Boolean)
      : []
  );
  const explicitPriority = cleanText(
    wf.priority || meta.priority || (wf.value_context && wf.value_context.priority) || '',
    24
  ).toLowerCase();
  const objectiveText = cleanText(
    wf.objective || wf.objective_id || meta.objective || wf.name || '',
    220
  ).toLowerCase();
  const criticalKeyword = /\b(incident|security|doctor|repair|rollback|compliance|integrity|recovery|hotfix|safety)\b/.test(objectiveText);
  const hasCriticalTag = tags.some((tag) => criticalTagSet.has(tag));
  const rank = workflowPriorityRank(explicitPriority) + (criticalKeyword || hasCriticalTag ? 1 : 0);
  const bounded = clampInt(rank, 1, 5, 3);
  const isCritical = bounded >= Number(tokenPolicy && tokenPolicy.critical_priority_floor || 4);
  let normalized = explicitPriority;
  if (!normalized) normalized = bounded >= 5 ? 'critical' : bounded >= 4 ? 'high' : bounded === 3 ? 'medium' : 'low';
  return {
    priority: normalized,
    priority_rank: bounded,
    critical_lane: isCritical
  };
}

function estimateStepTokens(step: AnyObj, tokenPolicy: AnyObj) {
  const row = step && typeof step === 'object' ? step : {};
  const explicit = Number(row.estimated_tokens);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
  const type = String(row.type || 'command').trim().toLowerCase();
  if (type === 'gate') return clampInt(tokenPolicy && tokenPolicy.step_gate_tokens, 0, 1_000_000, 18);
  if (type === 'receipt') return clampInt(tokenPolicy && tokenPolicy.step_receipt_tokens, 0, 1_000_000, 10);
  if (type === 'external') return clampInt(tokenPolicy && tokenPolicy.step_external_tokens, 1, 1_000_000, 120);
  return clampInt(tokenPolicy && tokenPolicy.step_command_default_tokens, 1, 1_000_000, 40);
}

function estimateWorkflowTokens(workflow: AnyObj, tokenPolicy: AnyObj) {
  const steps = Array.isArray(workflow && workflow.steps) ? workflow.steps.map((row, i) => normalizeStep(row, i)) : [];
  if (!steps.length) {
    return clampInt(tokenPolicy && tokenPolicy.per_workflow_min_token_cap, 0, 10_000_000, 80);
  }
  const total = steps.reduce((sum, step) => {
    const perAttempt = Math.max(0, estimateStepTokens(step, tokenPolicy));
    const attempts = Math.max(1, Number(step && step.retries || 0) + 1);
    return sum + (perAttempt * attempts);
  }, 0);
  const minCap = clampInt(tokenPolicy && tokenPolicy.per_workflow_min_token_cap, 0, 10_000_000, 80);
  const maxCap = clampInt(tokenPolicy && tokenPolicy.per_workflow_max_token_cap, 1, 100_000_000, 2200);
  return clampInt(total, 0, 100_000_000, minCap > 0 ? minCap : 1) > 0
    ? Math.max(minCap, Math.min(maxCap, Math.round(total)))
    : minCap;
}

function tokenEconomicsBudgetSnapshot(dateStr: string, tokenPolicy: AnyObj) {
  const out = {
    budget_state_available: false,
    token_cap_tokens: 0,
    used_est_tokens: 0,
    remaining_tokens: 0,
    autopause_active: false,
    autopause_reason: null,
    autopause_source: null
  };
  if (!(tokenPolicy && tokenPolicy.use_system_budget === true)) return out;
  try {
    const state = loadSystemBudgetState(dateStr, {});
    out.budget_state_available = !!(state && typeof state === 'object');
    out.token_cap_tokens = Math.max(0, Number(state && state.token_cap || 0));
    out.used_est_tokens = Math.max(0, Number(state && state.used_est || 0));
    out.remaining_tokens = Math.max(0, out.token_cap_tokens - out.used_est_tokens);
  } catch {
    // Fail-open to local executor token cap fallback.
  }
  try {
    const autopause = loadSystemBudgetAutopauseState({});
    out.autopause_active = !!(autopause && autopause.active === true);
    out.autopause_reason = autopause && autopause.reason ? cleanText(autopause.reason, 180) : null;
    out.autopause_source = autopause && autopause.source ? cleanText(autopause.source, 80) : null;
  } catch {
    // Fail-open: missing autopause state should not block execution.
  }
  return out;
}

function planTokenEconomics(
  dateStr: string,
  selected: AnyObj[],
  policy: AnyObj,
  args: AnyObj = {},
  opts: AnyObj = {}
) {
  const tokenPolicy = policy && policy.token_economics && typeof policy.token_economics === 'object'
    ? policy.token_economics
    : defaultPolicy().token_economics;
  const dryRun = opts && opts.dry_run === true;
  const rows = Array.isArray(selected) ? selected : [];
  if (tokenPolicy.enabled !== true) {
    return {
      enabled: false,
      token_policy: tokenPolicy,
      run_token_cap_tokens: 0,
      predicted_total_tokens: 0,
      enveloped_total_tokens: 0,
      deferred: [],
      executable: rows.map((workflow) => ({
        workflow,
        predicted_tokens: 0,
        envelope_tokens: 0,
        throttle_ratio: 1,
        priority: 'medium',
        priority_rank: 3,
        critical_lane: false,
        reason: 'token_economics_disabled'
      })),
      budget_snapshot: tokenEconomicsBudgetSnapshot(dateStr, tokenPolicy)
    };
  }

  const budgetSnapshot = tokenEconomicsBudgetSnapshot(dateStr, tokenPolicy);
  const explicitCap = clampInt(
    args && (args['token-cap'] != null ? args['token-cap'] : args.token_cap),
    0,
    100_000_000,
    0
  );
  const configuredRunCap = clampInt(tokenPolicy.run_token_cap, 0, 100_000_000, 0);
  let runCap = explicitCap > 0 ? explicitCap : configuredRunCap;
  if (runCap <= 0 && tokenPolicy.use_system_budget === true && budgetSnapshot.remaining_tokens > 0) {
    runCap = budgetSnapshot.remaining_tokens;
  }
  if (runCap <= 0) {
    runCap = clampInt(tokenPolicy.fallback_run_token_cap, 100, 100_000_000, 1200);
  }

  const planned = rows.map((workflow) => {
    const priority = classifyWorkflowPriority(workflow, tokenPolicy);
    const predictedTokens = estimateWorkflowTokens(workflow, tokenPolicy);
    return {
      workflow,
      workflow_id: String(workflow && workflow.id || '').trim(),
      workflow_name: cleanText(workflow && workflow.name || '', 120),
      ...priority,
      predicted_tokens: predictedTokens
    };
  });
  const criticalRows = planned.filter((row) => row.critical_lane === true);
  const nonCriticalRows = planned.filter((row) => row.critical_lane !== true);
  const criticalTotal = criticalRows.reduce((sum, row) => sum + Number(row.predicted_tokens || 0), 0);
  const nonCriticalTotal = nonCriticalRows.reduce((sum, row) => sum + Number(row.predicted_tokens || 0), 0);
  let reserveForCritical = clampInt(tokenPolicy.reserve_tokens_for_critical_lanes, 0, runCap, 0);
  if (criticalTotal <= 0) reserveForCritical = 0;
  let criticalBudget = Math.max(reserveForCritical, Math.round(runCap * 0.35));
  criticalBudget = Math.min(runCap, criticalBudget);
  if (criticalTotal > 0 && criticalTotal < criticalBudget) criticalBudget = criticalTotal;
  let nonCriticalBudget = Math.max(0, runCap - criticalBudget);
  if (criticalTotal <= 0) nonCriticalBudget = runCap;

  const criticalScale = criticalTotal > 0 ? Math.min(1, criticalBudget / criticalTotal) : 1;
  const nonCriticalScale = nonCriticalTotal > 0 ? Math.min(1, nonCriticalBudget / nonCriticalTotal) : 1;
  const headroomMultiplier = clampNumber(tokenPolicy.envelope_headroom_multiplier, 1, 3, 1.6);
  const throttleFloor = clampNumber(tokenPolicy.throttle_floor_ratio, 0, 1, 0.35);
  let criticalRemaining = criticalBudget;
  let nonCriticalRemaining = nonCriticalBudget;

  const deferred: AnyObj[] = [];
  const executable: AnyObj[] = [];
  const sorted = planned.slice().sort((a, b) => {
    if (Number(b.priority_rank) !== Number(a.priority_rank)) return Number(b.priority_rank) - Number(a.priority_rank);
    if (Number(a.predicted_tokens) !== Number(b.predicted_tokens)) return Number(a.predicted_tokens) - Number(b.predicted_tokens);
    return String(a.workflow_id).localeCompare(String(b.workflow_id));
  });

  let attemptsToday = 0;
  for (const row of sorted) {
    const predictedTokens = Math.max(0, Number(row.predicted_tokens || 0));
    const isCritical = row.critical_lane === true;
    const minCap = isCritical
      ? clampInt(tokenPolicy.per_workflow_min_token_cap_critical, 0, 10_000_000, 140)
      : clampInt(tokenPolicy.per_workflow_min_token_cap, 0, 10_000_000, 80);
    const maxCap = clampInt(tokenPolicy.per_workflow_max_token_cap, 1, 100_000_000, 2200);
    const laneScale = isCritical ? criticalScale : nonCriticalScale;
    const laneRemaining = isCritical ? criticalRemaining : nonCriticalRemaining;
    let envelope = Math.min(maxCap, Math.floor(predictedTokens * laneScale));
    if (predictedTokens > 0 && envelope < minCap) envelope = Math.min(maxCap, minCap);
    if (predictedTokens > 0) {
      const headroomTarget = Math.ceil(predictedTokens * headroomMultiplier);
      if (envelope < headroomTarget) envelope = Math.min(maxCap, headroomTarget);
    }
    if (envelope > laneRemaining) envelope = laneRemaining;
    if (envelope < 0) envelope = 0;
    const throttleRatio = predictedTokens > 0 ? Number((envelope / predictedTokens).toFixed(4)) : 1;

    const autopauseActive = budgetSnapshot.autopause_active === true;
    if (
      autopauseActive
      && tokenPolicy.defer_on_autopause === true
      && (!isCritical || tokenPolicy.allow_critical_when_autopause !== true)
    ) {
      deferred.push({
        workflow_id: row.workflow_id,
        workflow_name: row.workflow_name,
        predicted_tokens: predictedTokens,
        envelope_tokens: 0,
        priority: row.priority,
        priority_rank: row.priority_rank,
        critical_lane: isCritical,
        throttle_ratio: 0,
        reason: 'budget_autopause_active_preflight',
        autopause_reason: budgetSnapshot.autopause_reason || null
      });
      continue;
    }

    if (envelope <= 0) {
      deferred.push({
        workflow_id: row.workflow_id,
        workflow_name: row.workflow_name,
        predicted_tokens: predictedTokens,
        envelope_tokens: 0,
        priority: row.priority,
        priority_rank: row.priority_rank,
        critical_lane: isCritical,
        throttle_ratio: 0,
        reason: 'token_economics_no_headroom'
      });
      continue;
    }
    if (predictedTokens > 0 && throttleRatio < throttleFloor && !isCritical) {
      deferred.push({
        workflow_id: row.workflow_id,
        workflow_name: row.workflow_name,
        predicted_tokens: predictedTokens,
        envelope_tokens: envelope,
        priority: row.priority,
        priority_rank: row.priority_rank,
        critical_lane: isCritical,
        throttle_ratio: throttleRatio,
        reason: 'token_economics_throttle_floor_unmet'
      });
      continue;
    }

    let budgetGuard = null;
    if (tokenPolicy.use_system_budget === true) {
      try {
        budgetGuard = evaluateSystemBudgetGuard({
          date: dateStr,
          request_tokens_est: envelope,
          attempts_today: attemptsToday
        }, {});
      } catch {
        budgetGuard = null;
      }
      if (
        tokenPolicy.defer_on_guard_deny === true
        && budgetGuard
        && budgetGuard.allow !== true
      ) {
        deferred.push({
          workflow_id: row.workflow_id,
          workflow_name: row.workflow_name,
          predicted_tokens: predictedTokens,
          envelope_tokens: envelope,
          priority: row.priority,
          priority_rank: row.priority_rank,
          critical_lane: isCritical,
          throttle_ratio: throttleRatio,
          reason: cleanText(
            Array.isArray(budgetGuard.hard_stop_reasons) && budgetGuard.hard_stop_reasons.length
              ? budgetGuard.hard_stop_reasons[0]
              : 'budget_guard_deny_preflight',
            140
          ) || 'budget_guard_deny_preflight',
          budget_guard: {
            allow: budgetGuard.allow === true,
            hard_stop: budgetGuard.hard_stop === true
          }
        });
        continue;
      }
    }

    executable.push({
      workflow: row.workflow,
      workflow_id: row.workflow_id,
      workflow_name: row.workflow_name,
      predicted_tokens: predictedTokens,
      envelope_tokens: envelope,
      throttle_ratio: throttleRatio,
      priority: row.priority,
      priority_rank: row.priority_rank,
      critical_lane: isCritical,
      reason: throttleRatio < 0.9999 ? 'token_economics_throttled' : 'token_economics_allow',
      budget_guard: budgetGuard
    });
    attemptsToday += 1;
    if (isCritical) criticalRemaining = Math.max(0, criticalRemaining - envelope);
    else nonCriticalRemaining = Math.max(0, nonCriticalRemaining - envelope);
  }

  if (tokenPolicy.use_system_budget === true && !dryRun) {
    for (const row of executable) {
      try {
        writeSystemBudgetDecision({
          date: dateStr,
          module: 'workflow_executor',
          capability: row.priority || 'workflow',
          request_tokens_est: row.envelope_tokens,
          decision: 'allow',
          reason: row.reason
        }, {});
      } catch {
        // Non-fatal: decision receipts should not block executor.
      }
    }
    for (const row of deferred) {
      try {
        writeSystemBudgetDecision({
          date: dateStr,
          module: 'workflow_executor',
          capability: row.priority || 'workflow',
          request_tokens_est: row.envelope_tokens || row.predicted_tokens || 0,
          decision: 'deny',
          reason: row.reason
        }, {});
      } catch {
        // Non-fatal.
      }
    }
  }

  return {
    enabled: true,
    token_policy: tokenPolicy,
    run_token_cap_tokens: runCap,
    predicted_total_tokens: planned.reduce((sum, row) => sum + Number(row.predicted_tokens || 0), 0),
    enveloped_total_tokens: executable.reduce((sum, row) => sum + Number(row.envelope_tokens || 0), 0),
    deferred,
    executable,
    budget_snapshot: budgetSnapshot,
    scaling: {
      critical_scale: Number(criticalScale.toFixed(4)),
      non_critical_scale: Number(nonCriticalScale.toFixed(4)),
      critical_budget_tokens: criticalBudget,
      non_critical_budget_tokens: nonCriticalBudget,
      critical_remaining_tokens: criticalRemaining,
      non_critical_remaining_tokens: nonCriticalRemaining
    }
  };
}

function evaluateSoulTokenGate(policy: AnyObj, args: AnyObj = {}) {
  const base = defaultPolicy().security_gates.soul_token;
  const gate = policy && policy.security_gates && policy.security_gates.soul_token
    ? policy.security_gates.soul_token
    : base;
  const enabled = gate && gate.enabled !== false;
  if (!enabled) {
    return {
      enabled: false,
      checked: false,
      verify_ok: null,
      shadow_only: false,
      forced_shadow: false,
      reason: 'disabled',
      script_path: null,
      strict_verify: false
    };
  }
  const scriptRaw = cleanText(gate.script || '', 260) || relPath(SOUL_TOKEN_GUARD_SCRIPT);
  const scriptPath = path.isAbsolute(scriptRaw) ? scriptRaw : path.join(REPO_ROOT, scriptRaw);
  const timeoutMs = clampInt(gate.timeout_ms, 200, 120000, base.timeout_ms);
  const strictVerify = gate.strict_verify === true || boolFlag(args['soul-token-strict'], false);
  if (!fs.existsSync(scriptPath)) {
    return {
      enabled: true,
      checked: false,
      verify_ok: false,
      shadow_only: true,
      forced_shadow: gate.enforce_shadow_on_violation !== false,
      reason: 'script_missing',
      script_path: relPath(scriptPath),
      strict_verify: strictVerify
    };
  }
  const verifyArgs = [scriptPath, 'verify'];
  if (strictVerify) verifyArgs.push('--strict=1');
  const verifyRes = spawnSync(process.execPath, verifyArgs, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  const payload = parseJsonPayload(verifyRes && verifyRes.stdout);
  const verifyOk = Number(verifyRes && verifyRes.status) === 0
    && payload
    && payload.ok === true;
  const shadowOnly = payload && payload.shadow_only === true;
  const reason = cleanText(
    (payload && payload.reason)
      || (verifyRes && verifyRes.stderr)
      || (verifyRes && verifyRes.stdout)
      || `soul_token_verify_exit_${Number.isInteger(verifyRes && verifyRes.status) ? verifyRes.status : 1}`,
    180
  ) || 'soul_token_verify_unknown';
  const forcedShadow = gate.enforce_shadow_on_violation !== false && (!verifyOk || shadowOnly);
  return {
    enabled: true,
    checked: true,
    verify_ok: verifyOk === true,
    shadow_only: shadowOnly === true,
    forced_shadow: forcedShadow === true,
    reason,
    script_path: relPath(scriptPath),
    strict_verify: strictVerify === true,
    payload: payload && typeof payload === 'object' ? {
      type: payload.type || null,
      enforcement_mode: payload.enforcement_mode || null,
      token_present: payload.token_present === true,
      attestation_present: payload.attestation_present === true,
      biometric_forced_shadow: payload.biometric_forced_shadow === true,
      biometric_attestation: payload.biometric_attestation && typeof payload.biometric_attestation === 'object'
        ? {
            enabled: payload.biometric_attestation.enabled === true,
            checked: payload.biometric_attestation.checked === true,
            match: payload.biometric_attestation.match === true,
            confidence: Number(payload.biometric_attestation.confidence || 0),
            min_confidence: Number(payload.biometric_attestation.min_confidence || 0),
            liveness_ok: payload.biometric_attestation.liveness_ok === true,
            require_for_verify: payload.biometric_attestation.require_for_verify === true,
            shadow_only: payload.biometric_attestation.shadow_only === true,
            reason: payload.biometric_attestation.reason || null
          }
        : null
    } : null
  };
}

function normalizeSuccessCriteria(rawCriteria: AnyObj, fallbackExitCodes: number[]) {
  const src = rawCriteria && typeof rawCriteria === 'object' ? rawCriteria : {};
  const exitSource = Array.isArray(src.allowed_exit_codes) ? src.allowed_exit_codes : fallbackExitCodes;
  const allowedExitCodes = (Array.isArray(exitSource) ? exitSource : [])
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  const normalizeTokens = (rows: unknown) => (
    Array.isArray(rows)
      ? rows
        .map((v) => String(v == null ? '' : v).trim())
        .filter(Boolean)
        .slice(0, 32)
      : []
  );
  const stdoutIncludes = normalizeTokens(src.stdout_includes);
  const stderrExcludes = normalizeTokens(src.stderr_excludes);
  const hasMaxDuration = src.max_duration_ms != null;
  const maxDurationMs = hasMaxDuration
    ? clampInt(src.max_duration_ms, 1, 24 * 60 * 60 * 1000, 120000)
    : null;
  return {
    allowed_exit_codes: allowedExitCodes.length ? Array.from(new Set(allowedExitCodes)) : [0],
    stdout_includes: stdoutIncludes,
    stderr_excludes: stderrExcludes,
    max_duration_ms: hasMaxDuration ? Number(maxDurationMs) : null
  };
}

function normalizeStep(rawStep: AnyObj, index = 0) {
  const src = rawStep && typeof rawStep === 'object' ? rawStep : {};
  const fallbackId = `step_${index + 1}`;
  const id = String(src.id || fallbackId).trim() || fallbackId;
  const typeRaw = String(src.type || 'command').trim().toLowerCase();
  const type = typeRaw === 'gate' || typeRaw === 'receipt' || typeRaw === 'external'
    ? typeRaw
    : 'command';
  const policyFallbackExitCodes = defaultPolicy().step_runtime.default_allowed_exit_codes;
  const normalizeExternalValue = (value: unknown, maxLen: number) => {
    const cleaned = cleanText(value || '', maxLen);
    if (!cleaned) return null;
    if (/^<[^>]+>$/.test(cleaned)) return null;
    return cleaned;
  };
  const adapter = normalizeExternalValue(src.adapter, 80);
  const provider = normalizeExternalValue(src.provider, 80);
  const lane = cleanText(src.lane || '', 40).toLowerCase() || null;
  const risk = cleanText(src.risk || '', 24).toLowerCase() || null;
  const clearance = cleanText(src.clearance || '', 12).toUpperCase() || null;
  const estimatedTokens = src.estimated_tokens == null
    ? null
    : clampInt(src.estimated_tokens, 0, 10_000_000, 0);
  return {
    id,
    type,
    command: String(src.command || '').trim(),
    purpose: String(src.purpose || '').trim(),
    timeout_ms: clampInt(src.timeout_ms, 500, 30 * 60 * 1000, 120000),
    retries: clampInt(src.retries, 0, 8, 0),
    success_criteria: normalizeSuccessCriteria(src.success_criteria, policyFallbackExitCodes),
    adapter,
    provider,
    lane,
    risk,
    clearance,
    estimated_tokens: estimatedTokens,
    require_policy_root: src.require_policy_root === true
  };
}

function normalizeStage(raw: unknown, fallback = 'shadow') {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (s === 'shadow' || s === 'canary' || s === 'live') return s;
  return fallback;
}

function rolloutDefaultState(policy: AnyObj) {
  const stage = normalizeStage(policy && policy.rollout ? policy.rollout.initial_stage : 'shadow', 'shadow');
  const fraction = clampNumber(
    Number(policy && policy.rollout ? policy.rollout.canary_fraction : 0.15),
    0.01,
    1,
    0.15
  );
  return {
    schema_id: 'workflow_executor_rollout_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    stage,
    canary_fraction: fraction,
    consecutive_green: 0,
    consecutive_red: 0,
    last_slo_pass: null,
    last_scale_action: null
  };
}

function loadRolloutState(policy: AnyObj) {
  const fallback = rolloutDefaultState(policy);
  const src = readJson(ROLLOUT_STATE_PATH, fallback);
  const out = {
    ...fallback,
    ...(src && typeof src === 'object' ? src : {})
  };
  out.stage = normalizeStage(out.stage, fallback.stage);
  out.canary_fraction = clampNumber(
    Number(out.canary_fraction),
    Number(policy && policy.rollout ? policy.rollout.canary_min_fraction : 0.05),
    Number(policy && policy.rollout ? policy.rollout.canary_max_fraction : 1),
    fallback.canary_fraction
  );
  out.consecutive_green = clampInt(out.consecutive_green, 0, 100000, 0);
  out.consecutive_red = clampInt(out.consecutive_red, 0, 100000, 0);
  out.last_slo_pass = out.last_slo_pass == null ? null : !!out.last_slo_pass;
  out.last_scale_action = cleanText(out.last_scale_action || '', 80) || null;
  return out;
}

function saveRolloutState(next: AnyObj) {
  writeJsonAtomic(ROLLOUT_STATE_PATH, {
    ...(next && typeof next === 'object' ? next : {}),
    updated_at: nowIso()
  });
}

function stableUnit(seed: unknown) {
  const src = String(seed == null ? '' : seed);
  let h = 2166136261;
  for (let i = 0; i < src.length; i += 1) {
    h ^= src.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  const out = (h >>> 0) / 0xffffffff;
  return clampNumber(out, 0, 1, 0);
}

function extractTemplateTokens(value: unknown) {
  const text = String(value == null ? '' : value);
  const re = /<([a-zA-Z0-9_:-]+)>/g;
  const out: string[] = [];
  let m = null;
  while ((m = re.exec(text)) != null) {
    const token = String(m[1] || '').trim().toLowerCase();
    if (token) out.push(token);
  }
  return Array.from(new Set(out));
}

function hasRollbackStep(steps: AnyObj[]) {
  return (Array.isArray(steps) ? steps : []).some((row) => {
    const id = String(row && row.id || '').toLowerCase();
    const purpose = String(row && row.purpose || '').toLowerCase();
    const command = String(row && row.command || '').toLowerCase();
    return id.includes('rollback')
      || purpose.includes('rollback')
      || /\brollback\b/.test(command);
  });
}

function assessWorkflowEligibility(workflow: AnyObj, policy: AnyObj, opts: AnyObj = {}) {
  const gate = policy && policy.execution_gate && typeof policy.execution_gate === 'object'
    ? policy.execution_gate
    : defaultPolicy().execution_gate;
  if (gate.enabled !== true) {
    return {
      eligible: true,
      reasons: [],
      has_rollback_path: hasRollbackStep(Array.isArray(workflow && workflow.steps) ? workflow.steps : [])
    };
  }
  const steps = Array.isArray(workflow && workflow.steps)
    ? workflow.steps.map((row, i) => normalizeStep(row, i))
    : [];
  const reasons: string[] = [];
  if (steps.length < Number(gate.min_steps || 1)) reasons.push('min_steps_unmet');

  const hasGate = steps.some((row) => String(row && row.type || '').toLowerCase() === 'gate');
  const hasReceipt = steps.some((row) => String(row && row.type || '').toLowerCase() === 'receipt');
  const hasRollback = hasRollbackStep(steps);
  if (gate.require_gate_step === true && !hasGate) reasons.push('missing_gate_step');
  if (gate.require_receipt_step === true && !hasReceipt) reasons.push('missing_receipt_step');
  if (gate.require_rollback_path === true && !hasRollback && gate.allow_policy_default_rollback !== true) {
    reasons.push('missing_rollback_step');
  }

  const allowTokens = new Set(
    Array.isArray(gate.placeholder_allowlist) ? gate.placeholder_allowlist.map((v) => String(v).toLowerCase()) : []
  );
  const blockedTokens = Array.isArray(gate.blocked_command_tokens)
    ? gate.blocked_command_tokens.map((v) => String(v).toLowerCase())
    : [];
  for (const step of steps) {
    const command = String(step && step.command || '').trim();
    if (gate.require_concrete_commands === true && !command) {
      reasons.push(`empty_command:${String(step && step.id || '')}`);
      continue;
    }
    const lower = command.toLowerCase();
    for (const marker of blockedTokens) {
      if (marker && lower.includes(marker)) {
        reasons.push(`blocked_token:${marker}`);
        break;
      }
    }
    const placeholders = extractTemplateTokens(command);
    for (const token of placeholders) {
      if (!allowTokens.has(token)) {
        reasons.push(`placeholder_not_allowed:${token}`);
      }
    }
  }

  const explicitManual = opts && opts.manual_id === true;
  const requireMetrics = gate.require_metrics_for_auto === true && !explicitManual;
  const metricScoreRaw = workflow && workflow.metrics && Number.isFinite(Number(workflow.metrics.score))
    ? Number(workflow.metrics.score)
    : null;
  if (requireMetrics && metricScoreRaw == null) reasons.push('missing_metrics_score');
  if (!explicitManual && metricScoreRaw != null && metricScoreRaw < Number(gate.min_composite_score || 0)) {
    reasons.push('composite_score_below_min');
  }

  return {
    eligible: reasons.length === 0,
    reasons: Array.from(new Set(reasons)),
    has_rollback_path: hasRollback
  };
}

function commandAppearsSafeForFallback(commandRaw: unknown) {
  const command = String(commandRaw || '').trim();
  if (!command) return false;
  const lower = command.toLowerCase();
  if (lower.includes('systems/actuation/actuation_executor.js')) return false;
  if (/\bcurl\b|\bwget\b/.test(lower)) return false;
  if (/\bopen\s+https?:\/\//.test(lower)) return false;
  return true;
}

function workflowAppearsSafeForFallback(workflow: AnyObj) {
  const steps = Array.isArray(workflow && workflow.steps) ? workflow.steps : [];
  if (!steps.length) return false;
  for (let i = 0; i < steps.length; i += 1) {
    const step = normalizeStep(steps[i], i);
    const type = String(step && step.type || '').toLowerCase();
    if (type === 'external') return false;
    if (!commandAppearsSafeForFallback(step && step.command)) return false;
  }
  return true;
}

function fallbackSelectionDecision(candidates: AnyObj[], excluded: AnyObj[], policy: AnyObj, opts: AnyObj = {}) {
  const cfg = policy && policy.fallback_selection && typeof policy.fallback_selection === 'object'
    ? policy.fallback_selection
    : defaultPolicy().fallback_selection;
  if (cfg.enabled !== true || cfg.trigger_when_selected_zero !== true) {
    return { selected: null, reason: 'fallback_disabled' };
  }
  const allowReasonSet = new Set(
    Array.isArray(cfg.allow_eligibility_reasons) ? cfg.allow_eligibility_reasons.map((v: unknown) => String(v || '').toLowerCase()) : []
  );
  const maxConsider = clampInt(cfg.max_candidates_considered, 1, 256, 32);
  const candidateRows = Array.isArray(candidates) ? candidates.slice(0, maxConsider) : [];
  const explicitId = opts && opts.explicit_id ? String(opts.explicit_id).trim() : '';
  for (const row of candidateRows) {
    const workflowId = String(row && row.id || '').trim();
    if (!workflowId) continue;
    if (explicitId && workflowId !== explicitId) continue;
    const gate = assessWorkflowEligibility(row, policy, { manual_id: !!explicitId });
    const reasons = Array.isArray(gate && gate.reasons) ? gate.reasons : [];
    const safeReasonOnly = reasons.length > 0 && reasons.every((r) => allowReasonSet.has(String(r || '').toLowerCase()));
    if (!safeReasonOnly) continue;
    if (cfg.require_safe_commands === true && !workflowAppearsSafeForFallback(row)) continue;
    excluded.push({
      workflow_id: workflowId,
      reason: 'fallback_selected',
      details: reasons,
      fallback: true
    });
    return {
      selected: row,
      reason: 'fallback_composite_only',
      reasons
    };
  }
  return { selected: null, reason: 'fallback_no_candidate' };
}

function minimumSelectionDecision(candidates: AnyObj[], selected: AnyObj[], policy: AnyObj, opts: AnyObj = {}) {
  const cfg = policy && policy.minimum_selection && typeof policy.minimum_selection === 'object'
    ? policy.minimum_selection
    : defaultPolicy().minimum_selection;
  if (cfg.enabled !== true) {
    return { selected: null, reason: 'minimum_selection_disabled' };
  }
  const allowReasonSet = new Set(
    Array.isArray(cfg.allow_eligibility_reasons) ? cfg.allow_eligibility_reasons.map((v: unknown) => String(v || '').toLowerCase()) : []
  );
  const selectedIds = new Set(
    Array.isArray(selected)
      ? selected.map((row: AnyObj) => String(row && row.id || '').trim()).filter(Boolean)
      : []
  );
  const maxConsider = clampInt(cfg.max_candidates_considered, 1, 512, 64);
  const candidateRows = Array.isArray(candidates) ? candidates.slice(0, maxConsider) : [];
  const explicitId = opts && opts.explicit_id ? String(opts.explicit_id).trim() : '';
  for (const row of candidateRows) {
    const workflowId = String(row && row.id || '').trim();
    if (!workflowId) continue;
    if (explicitId && workflowId !== explicitId) continue;
    if (selectedIds.has(workflowId)) continue;
    if (cfg.require_safe_commands === true && !workflowAppearsSafeForFallback(row)) continue;
    const gate = assessWorkflowEligibility(row, policy, { manual_id: !!explicitId });
    const reasons = Array.isArray(gate && gate.reasons) ? gate.reasons : [];
    const safeReasonOnly = reasons.length > 0 && reasons.every((r) => allowReasonSet.has(String(r || '').toLowerCase()));
    if (gate.eligible !== true && !safeReasonOnly) continue;
    return {
      selected: row,
      reason: gate.eligible === true
        ? 'minimum_selection_safe_eligible'
        : 'minimum_selection_safe_composite_only',
      reasons
    };
  }
  return { selected: null, reason: 'minimum_selection_no_candidate' };
}

function liveZeroSelectionStreak(rows: AnyObj[], maxScan = 240) {
  const list = Array.isArray(rows) ? rows : [];
  const scanMax = clampInt(maxScan, 20, 5000, 240);
  let streak = 0;
  for (let i = list.length - 1, scanned = 0; i >= 0 && scanned < scanMax; i -= 1, scanned += 1) {
    const row = list[i];
    if (!row || typeof row !== 'object') continue;
    if (row.dry_run === true) continue;
    const selected = Number(row.workflows_selected || 0);
    if (!Number.isFinite(selected)) continue;
    if (selected <= 0) {
      streak += 1;
      continue;
    }
    break;
  }
  return streak;
}

function interpolateTemplate(input: unknown, context: AnyObj) {
  const str = String(input == null ? '' : input);
  return str
    .replace(/<date>/g, String(context.date || ''))
    .replace(/<workflow_id>/g, String(context.workflow_id || ''))
    .replace(/<step_id>/g, String(context.step_id || ''))
    .replace(/<run_id>/g, String(context.run_id || ''))
    .replace(/<objective_id>/g, String(context.objective_id || ''))
    .replace(/<eye_id>/g, String(context.eye_id || ''))
    .replace(/<adapter>/g, String(context.adapter || ''))
    .replace(/<provider>/g, String(context.provider || ''));
}

function runCommandShell(command: string, timeoutMs: number, env: AnyObj, cwd: string) {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const result = spawnSync(command, {
    shell: true,
    cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  const durationMs = Date.now() - started;
  const endedAt = new Date(started + durationMs).toISOString();
  const exitCode = Number(result && result.status);
  const timedOut = !!(result && result.error && String(result.error.code || '') === 'ETIMEDOUT');
  const shellOk = Number.isInteger(exitCode) ? exitCode === 0 : (!timedOut && !result.error && !result.signal);
  return {
    ok: shellOk,
    shell_ok: shellOk,
    exit_code: Number.isFinite(exitCode) ? exitCode : null,
    signal: result && result.signal ? String(result.signal) : null,
    timed_out: timedOut,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs,
    stdout: String(result && result.stdout || '').trim().slice(0, 2000),
    stderr: String(result && result.stderr || '').trim().slice(0, 2000),
    error: result && result.error ? String(result.error.message || result.error) : null
  };
}

function evaluateStepSuccess(run: AnyObj, step: AnyObj, policy: AnyObj) {
  const runtime = policy && policy.step_runtime && typeof policy.step_runtime === 'object'
    ? policy.step_runtime
    : defaultPolicy().step_runtime;
  const criteria = normalizeSuccessCriteria(
    step && step.success_criteria && typeof step.success_criteria === 'object'
      ? step.success_criteria
      : {},
    Array.isArray(runtime.default_allowed_exit_codes)
      ? runtime.default_allowed_exit_codes
      : [0]
  );
  const reasons = [];
  if (runtime.enforce_success_criteria !== true) {
    return {
      pass: run && run.ok === true,
      reasons: run && run.ok === true ? [] : ['step_failed'],
      criteria
    };
  }
  if (run && run.timed_out) reasons.push('timed_out');
  if (run && run.signal) reasons.push(`signal:${String(run.signal)}`);
  if (run && run.error) reasons.push('shell_error');

  const exitCode = run && Number.isFinite(Number(run.exit_code)) ? Number(run.exit_code) : null;
  if (exitCode == null) reasons.push('exit_code_missing');
  else if (!criteria.allowed_exit_codes.includes(exitCode)) reasons.push(`exit_code_not_allowed:${exitCode}`);

  const stdout = String(run && run.stdout || '').toLowerCase();
  for (const token of criteria.stdout_includes) {
    const needle = String(token || '').toLowerCase();
    if (needle && !stdout.includes(needle)) {
      reasons.push(`stdout_missing_token:${needle}`);
    }
  }

  const stderr = String(run && run.stderr || '').toLowerCase();
  for (const token of criteria.stderr_excludes) {
    const needle = String(token || '').toLowerCase();
    if (needle && stderr.includes(needle)) {
      reasons.push(`stderr_contains_token:${needle}`);
    }
  }

  if (criteria.max_duration_ms != null) {
    const durationMs = Number(run && run.duration_ms || 0);
    if (durationMs > Number(criteria.max_duration_ms)) {
      reasons.push(`duration_exceeded_max:${durationMs}`);
    }
  }

  const pass = reasons.length === 0;
  return {
    pass,
    reasons,
    criteria
  };
}

function summarizeStepUsage(stepResult: AnyObj) {
  const records = Array.isArray(stepResult && stepResult.records) ? stepResult.records : [];
  const attempts = Math.max(0, Number(stepResult && stepResult.attempts || records.length || 0));
  const retries = Math.max(0, attempts - 1);
  const durationMs = records.reduce((sum, row) => {
    const v = Number(row && row.duration_ms || 0);
    return sum + (Number.isFinite(v) && v > 0 ? v : 0);
  }, 0);
  const tokensEst = Number.isFinite(Number(stepResult && stepResult.tokens_est_total))
    ? Number(stepResult.tokens_est_total)
    : records.reduce((sum, row) => {
      const v = Number(row && row.tokens_est || 0);
      return sum + (Number.isFinite(v) && v > 0 ? v : 0);
    }, 0);
  return {
    attempts,
    retries,
    duration_ms: durationMs,
    tokens_est: Math.max(0, Number(tokensEst || 0))
  };
}

function projectedStepBudget(step: AnyObj, tokenPolicy: AnyObj = {}) {
  const attempts = Math.max(1, Number(step && step.retries || 0) + 1);
  const retries = Math.max(0, attempts - 1);
  const timeoutMs = Math.max(0, Number(step && step.timeout_ms || 0));
  const tokensPerAttempt = Math.max(0, estimateStepTokens(step, tokenPolicy));
  return {
    attempts,
    retries,
    duration_ms: timeoutMs * attempts,
    tokens_est: tokensPerAttempt * attempts
  };
}

function checkBudgetPreflight(step: AnyObj, budgetState: AnyObj, budgetPolicy: AnyObj, tokenPolicy: AnyObj = {}) {
  const projected = projectedStepBudget(step, tokenPolicy);
  const attemptsCap = Math.max(0, Number(budgetPolicy && budgetPolicy.max_total_attempts_per_workflow || 0));
  const retryCap = Math.max(0, Number(budgetPolicy && budgetPolicy.max_total_retry_attempts_per_workflow || 0));
  const durationCap = Math.max(0, Number(budgetPolicy && budgetPolicy.max_total_step_duration_ms_per_workflow || 0));
  const tokenCap = Math.max(0, Number(budgetState && budgetState.token_cap_tokens || 0));
  if (attemptsCap > 0 && (Number(budgetState && budgetState.attempts_used || 0) + projected.attempts) > attemptsCap) {
    return 'attempt_budget_exceeded_precheck';
  }
  if (retryCap > 0 && (Number(budgetState && budgetState.retries_used || 0) + projected.retries) > retryCap) {
    return 'retry_budget_exceeded_precheck';
  }
  if (durationCap > 0 && (Number(budgetState && budgetState.duration_ms_used || 0) + projected.duration_ms) > durationCap) {
    return 'duration_budget_exceeded_precheck';
  }
  if (tokenCap > 0 && (Number(budgetState && budgetState.tokens_used_est || 0) + projected.tokens_est) > tokenCap) {
    return 'token_budget_exceeded_precheck';
  }
  return null;
}

function checkBudgetPostStep(budgetState: AnyObj, budgetPolicy: AnyObj) {
  const attemptsCap = Math.max(0, Number(budgetPolicy && budgetPolicy.max_total_attempts_per_workflow || 0));
  const retryCap = Math.max(0, Number(budgetPolicy && budgetPolicy.max_total_retry_attempts_per_workflow || 0));
  const durationCap = Math.max(0, Number(budgetPolicy && budgetPolicy.max_total_step_duration_ms_per_workflow || 0));
  const tokenCap = Math.max(0, Number(budgetState && budgetState.token_cap_tokens || 0));
  if (attemptsCap > 0 && Number(budgetState && budgetState.attempts_used || 0) > attemptsCap) {
    return 'attempt_budget_exceeded';
  }
  if (retryCap > 0 && Number(budgetState && budgetState.retries_used || 0) > retryCap) {
    return 'retry_budget_exceeded';
  }
  if (durationCap > 0 && Number(budgetState && budgetState.duration_ms_used || 0) > durationCap) {
    return 'duration_budget_exceeded';
  }
  if (tokenCap > 0 && Number(budgetState && budgetState.tokens_used_est || 0) > tokenCap) {
    return 'token_budget_exceeded';
  }
  return null;
}

function resolveReceiptPath(stepCommand: string, context: AnyObj) {
  const templated = interpolateTemplate(stepCommand, context);
  if (!templated) return '';
  if (path.isAbsolute(templated)) return templated;
  return path.resolve(EXEC_CWD, templated);
}

function stepLooksExternal(step: AnyObj, command: string, policy: AnyObj) {
  const externalPolicy = policy && policy.external_orchestration && typeof policy.external_orchestration === 'object'
    ? policy.external_orchestration
    : defaultPolicy().external_orchestration;
  if (String(step && step.type || '').toLowerCase() === 'external') return true;
  if (externalPolicy.enabled !== true || externalPolicy.detect_actuation_commands !== true) return false;
  const marker = String(externalPolicy.command_pattern || '').trim().toLowerCase();
  if (!marker) return false;
  return String(command || '').toLowerCase().includes(marker);
}

function resolveExternalMetadata(step: AnyObj, command: string, context: AnyObj, policy: AnyObj) {
  const externalPolicy = policy && policy.external_orchestration && typeof policy.external_orchestration === 'object'
    ? policy.external_orchestration
    : defaultPolicy().external_orchestration;
  const adapterFromCommand = parseCommandFlag(command, 'kind');
  const cleanExternalRef = (value: unknown, maxLen: number) => {
    const cleaned = cleanText(value, maxLen);
    if (!cleaned) return '';
    if (/^<[^>]+>$/.test(cleaned)) return '';
    return cleaned;
  };
  const adapter = cleanExternalRef(
    step && step.adapter
      ? step.adapter
      : (context && context.adapter ? context.adapter : adapterFromCommand),
    80
  ) || null;
  const provider = cleanExternalRef(
    step && step.provider
      ? step.provider
      : (
        context && context.provider
          ? context.provider
          : (adapter || externalPolicy.default_provider)
      ),
    80
  ).toLowerCase() || externalPolicy.default_provider;
  const lane = cleanText(step && step.lane ? step.lane : externalPolicy.eye_lane, 40).toLowerCase() || 'vassal';
  const risk = cleanText(step && step.risk ? step.risk : externalPolicy.risk_default, 24).toLowerCase() || 'medium';
  const clearance = cleanText(step && step.clearance ? step.clearance : externalPolicy.eye_clearance, 12).toUpperCase() || 'L2';
  const estimatedTokens = step && step.estimated_tokens != null
    ? clampInt(step.estimated_tokens, 0, 10_000_000, 0)
    : clampInt(externalPolicy.estimated_tokens_default, 0, 10_000_000, 100);
  return {
    adapter,
    provider,
    lane,
    risk,
    clearance,
    estimated_tokens: estimatedTokens
  };
}

function evaluateExternalOrchestrationGate(step: AnyObj, command: string, context: AnyObj, options: AnyObj) {
  const policy = options && options.policy && typeof options.policy === 'object'
    ? options.policy
    : defaultPolicy();
  const externalPolicy = policy && policy.external_orchestration && typeof policy.external_orchestration === 'object'
    ? policy.external_orchestration
    : defaultPolicy().external_orchestration;
  if (!stepLooksExternal(step, command, policy)) {
    return { applicable: false, ok: true, reason: null, metadata: null };
  }
  if (externalPolicy.enabled !== true) {
    return {
      applicable: true,
      ok: false,
      reason: 'external_orchestration_disabled',
      metadata: null
    };
  }
  const dryRun = options && options.dry_run === true;
  const meta = resolveExternalMetadata(step, command, context, policy);
  const allowDryRunBypass = dryRun && externalPolicy.allow_dry_run_without_policy_root === true;
  const requirePolicyRoot = !allowDryRunBypass && (
    (step && step.require_policy_root === true)
    || externalPolicy.require_policy_root_for_live === true
  );
  let policyRoot = null;
  if (requirePolicyRoot) {
    const leaseToken = cleanText(
      context && context.policy_root_lease_token
        ? context.policy_root_lease_token
        : (process.env.CAPABILITY_LEASE_TOKEN || ''),
      8192
    );
    const approvalNote = cleanText(
      context && context.policy_root_approval_note
        ? context.policy_root_approval_note
        : (
          `workflow ${String(context && context.workflow_id || '')} external step ${String(step && step.id || '')}`
        ),
      320
    );
    const policyRootArgs = [
      POLICY_ROOT_SCRIPT,
      'authorize',
      `--scope=${cleanText(externalPolicy.policy_root_scope || 'workflow_external_orchestration', 120) || 'workflow_external_orchestration'}`,
      `--target=${meta.provider}`,
      `--source=${cleanText(externalPolicy.policy_root_source || 'workflow_executor', 120) || 'workflow_executor'}`,
      `--approval-note=${approvalNote}`
    ];
    if (leaseToken) policyRootArgs.push(`--lease-token=${leaseToken}`);
    policyRoot = runJsonCommand(policyRootArgs, { timeout_ms: 15000 });
    if (!policyRoot.payload || policyRoot.payload.ok !== true) {
      return {
        applicable: true,
        ok: false,
        reason: 'policy_root_denied',
        metadata: meta,
        policy_root: policyRoot
      };
    }
  }

  const apply = dryRun !== true;
  const eyeArgs = [
    EYE_KERNEL_SCRIPT,
    'route',
    `--lane=${meta.lane}`,
    `--target=${meta.provider}`,
    `--action=${cleanText(externalPolicy.eye_action || 'execute', 40).toLowerCase() || 'execute'}`,
    `--risk=${meta.risk}`,
    `--clearance=${meta.clearance}`,
    `--estimated-tokens=${meta.estimated_tokens}`,
    `--apply=${apply ? 1 : 0}`,
    `--policy=${EYE_POLICY_PATH}`,
    `--state=${EYE_STATE_PATH}`,
    `--audit=${EYE_AUDIT_PATH}`,
    `--latest=${EYE_LATEST_PATH}`,
    `--reason=workflow_external_orchestration`
  ];
  const eyeRoute = runJsonCommand(eyeArgs, { timeout_ms: 15000 });
  if (!eyeRoute.payload || eyeRoute.payload.ok !== true) {
    return {
      applicable: true,
      ok: false,
      reason: 'eye_route_denied',
      metadata: meta,
      policy_root: policyRoot,
      eye_route: eyeRoute
    };
  }
  if (eyeRoute.payload.decision === 'escalate' && externalPolicy.allow_escalate_decision !== true) {
    return {
      applicable: true,
      ok: false,
      reason: 'eye_route_escalated',
      metadata: meta,
      policy_root: policyRoot,
      eye_route: eyeRoute
    };
  }

  let subsumption = null;
  if (externalPolicy.require_subsumption_allow === true) {
    const subsumptionArgs = [
      SUBSUMPTION_REGISTRY_SCRIPT,
      'evaluate',
      `--provider=${meta.provider}`,
      `--estimated-tokens=${meta.estimated_tokens}`,
      `--risk=${meta.risk}`,
      `--apply=${apply ? 1 : 0}`,
      `--policy=${SUBSUMPTION_POLICY_PATH}`,
      `--state=${SUBSUMPTION_STATE_PATH}`,
      `--audit=${SUBSUMPTION_AUDIT_PATH}`,
      `--latest=${SUBSUMPTION_LATEST_PATH}`
    ];
    subsumption = runJsonCommand(subsumptionArgs, { timeout_ms: 15000 });
    if (!subsumption.payload || subsumption.payload.ok !== true) {
      return {
        applicable: true,
        ok: false,
        reason: 'subsumption_denied',
        metadata: meta,
        policy_root: policyRoot,
        eye_route: eyeRoute,
        subsumption
      };
    }
    if (subsumption.payload.decision === 'escalate' && externalPolicy.allow_escalate_decision !== true) {
      return {
        applicable: true,
        ok: false,
        reason: 'subsumption_escalated',
        metadata: meta,
        policy_root: policyRoot,
        eye_route: eyeRoute,
        subsumption
      };
    }
  }

  return {
    applicable: true,
    ok: true,
    reason: null,
    metadata: meta,
    policy_root: policyRoot,
    eye_route: eyeRoute,
    subsumption
  };
}

function resolveWorkflowSignals(executionContext: AnyObj, step: AnyObj, externalMeta: AnyObj = {}) {
  const workflow = executionContext && executionContext.workflow && typeof executionContext.workflow === 'object'
    ? executionContext.workflow
    : {};
  const metrics = workflow && workflow.metrics && typeof workflow.metrics === 'object' ? workflow.metrics : {};
  const highValue = workflow && workflow.high_value_play && typeof workflow.high_value_play === 'object'
    ? workflow.high_value_play
    : {};
  const approval = workflow && workflow.approval && typeof workflow.approval === 'object'
    ? workflow.approval
    : {};
  const objectiveText = cleanText(
    workflow && workflow.objective_primary
      ? workflow.objective_primary
      : (workflow && workflow.objective_id ? workflow.objective_id : executionContext && executionContext.objective_id),
    260
  );
  const qualityScore = clampNumber(
    metrics.composite_score != null ? metrics.composite_score : metrics.score,
    0,
    1,
    0.55
  );
  const driftRisk = clampNumber(
    highValue.drift_risk != null
      ? highValue.drift_risk
      : (
        metrics.regression_risk != null
          ? metrics.regression_risk
          : Math.max(0, Number(metrics.predicted_drift_delta || 0) / 0.06)
      ),
    0,
    1,
    0.32
  );
  const trustScore = clampNumber(
    highValue.confidence != null
      ? highValue.confidence
      : (
        cleanText(externalMeta && externalMeta.risk || '', 24).toLowerCase() === 'low'
          ? 0.72
          : 0.55
      ),
    0,
    1,
    0.55
  );
  return {
    workflow,
    objective_text: objectiveText,
    quality_score: qualityScore,
    drift_risk: driftRisk,
    trust_score: trustScore,
    high_value_confidence: clampNumber(highValue.confidence, 0, 1, 0),
    communication_gate_approved: approval.communication_gate === true,
    risk: cleanText(externalMeta && externalMeta.risk || step && step.risk || 'medium', 24).toLowerCase() || 'medium'
  };
}

function executeStep(step: AnyObj, context: AnyObj, options: AnyObj) {
  let executionContext = { ...(context && typeof context === 'object' ? context : {}) };
  let command = interpolateTemplate(step.command, executionContext);
  const maxAttempts = Math.max(1, Number(step.retries || 0) + 1);
  const records = [];
  const runtimePolicy = options && options.policy && typeof options.policy.step_runtime === 'object'
    ? options.policy.step_runtime
    : defaultPolicy().step_runtime;
  const criteria = normalizeSuccessCriteria(
    step && step.success_criteria && typeof step.success_criteria === 'object'
      ? step.success_criteria
      : {},
    Array.isArray(runtimePolicy.default_allowed_exit_codes) ? runtimePolicy.default_allowed_exit_codes : [0]
  );
  const tokenPolicy = options && options.token_economics && typeof options.token_economics === 'object'
    ? options.token_economics
    : defaultPolicy().token_economics;
  const tokensPerAttempt = Math.max(0, estimateStepTokens(step, tokenPolicy));
  const externalGate = evaluateExternalOrchestrationGate(step, command, executionContext, options);
  let rateLimitGate = null;
  let communicationGate = null;
  if (externalGate && externalGate.applicable === true && externalGate.metadata && typeof externalGate.metadata === 'object') {
    executionContext = { ...executionContext, ...externalGate.metadata };
    command = interpolateTemplate(step.command, executionContext);
  }
  if (externalGate && externalGate.applicable === true && externalGate.ok !== true) {
    const ts = nowIso();
    const reason = cleanText(externalGate.reason || 'external_orchestration_denied', 120) || 'external_orchestration_denied';
    return {
      ok: false,
      attempts: 1,
      dry_run: options && options.dry_run === true,
      step: {
        id: step.id,
        type: step.type,
        command
      },
      records: [{
        attempt: 1,
        ok: false,
        criteria_pass: false,
        criteria_fail_reasons: [reason],
        tokens_est: tokensPerAttempt,
        exit_code: 1,
        started_at: ts,
        ended_at: ts,
        duration_ms: 0,
        timed_out: false,
        stdout: '',
        stderr: reason,
        error: null
      }],
      tokens_est_per_attempt: tokensPerAttempt,
      tokens_est_total: tokensPerAttempt,
      success_criteria: criteria,
      failure_reason: reason,
      external_gate: externalGate,
      rate_limit_gate: null,
      communication_gate: null
    };
  }
  if (
    externalGate
    && externalGate.applicable === true
    && externalGate.ok === true
    && externalGate.metadata
    && typeof externalGate.metadata === 'object'
  ) {
    const signals = resolveWorkflowSignals(executionContext, step, externalGate.metadata);
    if (typeof evaluateRateLimitDecision === 'function') {
      try {
        rateLimitGate = evaluateRateLimitDecision({
          workflow_id: executionContext.workflow_id || '',
          objective_id: executionContext.objective_id || '',
          objective: signals.objective_text,
          adapter: externalGate.metadata.adapter || '',
          provider: externalGate.metadata.provider || '',
          risk: signals.risk,
          quality_score: signals.quality_score,
          drift_risk: signals.drift_risk,
          trust_score: signals.trust_score,
          dry_run: options && options.dry_run === true
        }, {
          apply: options && options.dry_run !== true
        });
      } catch (err) {
        rateLimitGate = {
          ok: false,
          applicable: true,
          reason: cleanText(err && err.message ? err.message : err || 'rate_limit_guard_failed', 160) || 'rate_limit_guard_failed'
        };
      }
      if (rateLimitGate && rateLimitGate.applicable === true && rateLimitGate.ok !== true) {
        const ts = nowIso();
        const reason = cleanText(rateLimitGate.reason || 'rate_limit_guard_blocked', 140) || 'rate_limit_guard_blocked';
        return {
          ok: false,
          attempts: 1,
          dry_run: options && options.dry_run === true,
          step: {
            id: step.id,
            type: step.type,
            command
          },
          records: [{
            attempt: 1,
            ok: false,
            criteria_pass: false,
            criteria_fail_reasons: [reason],
            tokens_est: tokensPerAttempt,
            exit_code: 1,
            started_at: ts,
            ended_at: ts,
            duration_ms: 0,
            timed_out: false,
            stdout: '',
            stderr: reason,
            error: null
          }],
          tokens_est_per_attempt: tokensPerAttempt,
          tokens_est_total: tokensPerAttempt,
          success_criteria: criteria,
          failure_reason: reason,
          external_gate: externalGate,
          rate_limit_gate: rateLimitGate,
          communication_gate: null
        };
      }
    }
    if (typeof prepareCommunicationAttempt === 'function') {
      try {
        communicationGate = prepareCommunicationAttempt({
          workflow_id: executionContext.workflow_id || '',
          objective_id: executionContext.objective_id || '',
          objective: signals.objective_text,
          adapter: externalGate.metadata.adapter || '',
          provider: externalGate.metadata.provider || '',
          risk: signals.risk,
          channel: externalGate.metadata.adapter || externalGate.metadata.provider || '',
          high_value_confidence: signals.high_value_confidence,
          communication_gate_approved: signals.communication_gate_approved === true,
          dry_run: options && options.dry_run === true
        }, {
          apply: options && options.dry_run !== true
        });
      } catch (err) {
        communicationGate = {
          ok: false,
          applicable: true,
          allowed: false,
          reason: cleanText(err && err.message ? err.message : err || 'client_communication_guard_failed', 160) || 'client_communication_guard_failed'
        };
      }
      if (
        communicationGate
        && communicationGate.applicable === true
        && communicationGate.allowed !== true
      ) {
        const ts = nowIso();
        const reason = cleanText(communicationGate.reason || 'client_communication_guard_blocked', 140) || 'client_communication_guard_blocked';
        return {
          ok: false,
          attempts: 1,
          dry_run: options && options.dry_run === true,
          step: {
            id: step.id,
            type: step.type,
            command
          },
          records: [{
            attempt: 1,
            ok: false,
            criteria_pass: false,
            criteria_fail_reasons: [reason],
            tokens_est: tokensPerAttempt,
            exit_code: 1,
            started_at: ts,
            ended_at: ts,
            duration_ms: 0,
            timed_out: false,
            stdout: '',
            stderr: reason,
            error: null
          }],
          tokens_est_per_attempt: tokensPerAttempt,
          tokens_est_total: tokensPerAttempt,
          success_criteria: criteria,
          failure_reason: reason,
          external_gate: externalGate,
          rate_limit_gate: rateLimitGate,
          communication_gate: communicationGate
        };
      }
    }
  }
  const finalizeExternalTelemetry = (ok: boolean, failureReason = '') => {
    if (
      rateLimitGate
      && rateLimitGate.applicable === true
      && typeof recordRateLimitOutcome === 'function'
    ) {
      try {
        recordRateLimitOutcome({
          workflow_id: executionContext.workflow_id || '',
          objective_id: executionContext.objective_id || '',
          adapter: executionContext.adapter || '',
          provider: executionContext.provider || '',
          ok: ok === true,
          failure_reason: failureReason || null,
          drift_risk: Number(rateLimitGate && rateLimitGate.drift_risk || 0)
        });
      } catch {
        // Best-effort telemetry must never block execution.
      }
    }
    if (
      communicationGate
      && communicationGate.applicable === true
      && typeof finalizeCommunicationAttempt === 'function'
    ) {
      try {
        finalizeCommunicationAttempt({
          thread_id: communicationGate.thread_id || '',
          ok: ok === true,
          dry_run: options && options.dry_run === true,
          failure_reason: failureReason || null
        });
      } catch {
        // Best-effort telemetry must never block execution.
      }
    }
  };
  const env = {
    ...process.env,
    WORKFLOW_RUN_ID: String(executionContext.run_id || ''),
    WORKFLOW_ID: String(executionContext.workflow_id || ''),
    WORKFLOW_STEP_ID: String(step.id || ''),
    WORKFLOW_DATE: String(executionContext.date || ''),
    WORKFLOW_OBJECTIVE_ID: String(executionContext.objective_id || ''),
    WORKFLOW_ADAPTER: String(executionContext.adapter || ''),
    WORKFLOW_PROVIDER: String(executionContext.provider || '')
  };

  if (options.dry_run === true) {
    return {
      ok: true,
      attempts: 0,
      dry_run: true,
      step: {
        id: step.id,
        type: step.type,
        command
      },
      records: [],
      tokens_est_per_attempt: tokensPerAttempt,
      tokens_est_total: 0,
      success_criteria: criteria,
      external_gate: externalGate && externalGate.applicable === true ? externalGate : null,
      rate_limit_gate: rateLimitGate && rateLimitGate.applicable === true ? rateLimitGate : null,
      communication_gate: communicationGate && communicationGate.applicable === true ? communicationGate : null
    };
  }

  if (step.type === 'receipt') {
    const ts = nowIso();
    const receiptPath = resolveReceiptPath(step.command, executionContext);
    const exists = !!(receiptPath && fs.existsSync(receiptPath));
    const ok = exists || options.receipt_strict !== true;
    return {
      ok,
      attempts: 1,
      dry_run: false,
      step: {
        id: step.id,
        type: step.type,
        command
      },
      records: [{
        attempt: 1,
        ok,
        criteria_pass: ok,
        criteria_fail_reasons: ok ? [] : ['receipt_missing'],
        tokens_est: tokensPerAttempt,
        exit_code: exists ? 0 : 1,
        started_at: ts,
        ended_at: ts,
        duration_ms: 0,
        timed_out: false,
        stdout: '',
        stderr: exists ? '' : 'receipt_missing',
        error: null
      }],
      receipt_path: receiptPath,
      receipt_exists: exists,
      tokens_est_per_attempt: tokensPerAttempt,
      tokens_est_total: tokensPerAttempt,
      success_criteria: criteria,
      failure_reason: ok ? null : 'receipt_missing',
      external_gate: externalGate && externalGate.applicable === true ? externalGate : null,
      rate_limit_gate: rateLimitGate && rateLimitGate.applicable === true ? rateLimitGate : null,
      communication_gate: communicationGate && communicationGate.applicable === true ? communicationGate : null
    };
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const run = runCommandShell(command, step.timeout_ms, env, EXEC_CWD);
    const evalResult = evaluateStepSuccess(run, step, options && options.policy ? options.policy : {});
    records.push({
      attempt,
      ...run,
      tokens_est: tokensPerAttempt,
      criteria_pass: evalResult.pass === true,
      criteria_fail_reasons: evalResult.reasons
    });
    if (evalResult.pass === true) {
      finalizeExternalTelemetry(true, null);
      return {
        ok: true,
        attempts: attempt,
        dry_run: false,
        step: {
          id: step.id,
          type: step.type,
          command
        },
        records,
        tokens_est_per_attempt: tokensPerAttempt,
        tokens_est_total: tokensPerAttempt * attempt,
        success_criteria: evalResult.criteria,
        failure_reason: null,
        external_gate: externalGate && externalGate.applicable === true ? externalGate : null,
        rate_limit_gate: rateLimitGate && rateLimitGate.applicable === true ? rateLimitGate : null,
        communication_gate: communicationGate && communicationGate.applicable === true ? communicationGate : null
      };
    }
  }

  const last = records.length ? records[records.length - 1] : null;
  const failReasons = Array.isArray(last && last.criteria_fail_reasons) ? last.criteria_fail_reasons : [];
  const failureReason = failReasons.length ? String(failReasons[0]) : 'step_failed';
  finalizeExternalTelemetry(false, failureReason);
  return {
    ok: false,
    attempts: records.length,
    dry_run: false,
    step: {
      id: step.id,
      type: step.type,
      command
    },
    records,
    tokens_est_per_attempt: tokensPerAttempt,
    tokens_est_total: tokensPerAttempt * records.length,
    success_criteria: criteria,
    failure_reason: failureReason,
    external_gate: externalGate && externalGate.applicable === true ? externalGate : null,
    rate_limit_gate: rateLimitGate && rateLimitGate.applicable === true ? rateLimitGate : null,
    communication_gate: communicationGate && communicationGate.applicable === true ? communicationGate : null
  };
}

function cloneSteps(steps: AnyObj[]) {
  return Array.isArray(steps)
    ? steps.map((row) => ({ ...(row || {}) }))
    : [];
}

function hasStepId(steps: AnyObj[], stepId: string) {
  return Array.isArray(steps) && steps.some((row) => String(row && row.id || '') === String(stepId || ''));
}

function stepsFingerprint(steps: AnyObj[]) {
  const list = (Array.isArray(steps) ? steps : []).map((row) => ({
    id: String(row && row.id || ''),
    type: String(row && row.type || ''),
    retries: Number(row && row.retries || 0),
    timeout_ms: Number(row && row.timeout_ms || 0),
    command: String(row && row.command || ''),
    adapter: String(row && row.adapter || ''),
    provider: String(row && row.provider || '')
  }));
  return stableId(JSON.stringify(list), 'fp');
}

function insertBeforeReceipt(steps: AnyObj[], newStep: AnyObj) {
  const out = cloneSteps(steps);
  const receiptIdx = out.findIndex((row) => String(row && row.type || '').toLowerCase() === 'receipt');
  if (receiptIdx < 0) out.push(newStep);
  else out.splice(receiptIdx, 0, newStep);
  return out;
}

function candidateMutationOrder(workflow: AnyObj, step: AnyObj, policy: AnyObj, mutationSummary: AnyObj) {
  if (typeof candidateMutationOrderExternal === 'function') {
    try {
      const delegated = candidateMutationOrderExternal(workflow, step, policy, mutationSummary);
      if (Array.isArray(delegated)) {
        return delegated
          .map((v) => normalizeToken(v, 60))
          .filter(Boolean);
      }
    } catch {
      // Fall back to local ordering logic.
    }
  }
  const allow = policy && policy.allow && typeof policy.allow === 'object' ? policy.allow : {};
  const order: string[] = [];
  const preferred = String(workflow && workflow.mutation && workflow.mutation.kind || '')
    .trim()
    .toLowerCase();
  const pushKind = (kind: string) => {
    if (allow[kind] !== true) return;
    if (!order.includes(kind)) order.push(kind);
  };
  if (preferred) pushKind(preferred);
  if (String(step && step.type || '').toLowerCase() !== 'receipt') pushKind('retry_tuning');
  pushKind('guard_hardening');
  pushKind('rollback_path');
  const attempts = mutationSummary && mutationSummary.by_kind && typeof mutationSummary.by_kind === 'object'
    ? mutationSummary.by_kind
    : {};
  return order.filter((kind) => Number(attempts[kind] || 0) < Number(policy && policy.max_attempts_per_kind || 3));
}

function applyMutationKind(kind: string, steps: AnyObj[], stepIndex: number, policy: AnyObj) {
  if (typeof applyMutationKindExternal === 'function') {
    try {
      const delegated = applyMutationKindExternal(kind, steps, stepIndex, policy);
      if (delegated && typeof delegated === 'object') return delegated;
    } catch {
      // Fall back to local mutation logic.
    }
  }
  const list = cloneSteps(steps);
  if (!list.length) return { ok: false, changed: false, reason: 'steps_empty' };
  const safeIndex = Math.max(0, Math.min(list.length - 1, Number(stepIndex || 0)));
  const target = list[safeIndex] || null;

  if (kind === 'retry_tuning') {
    if (!target || String(target.type || '').toLowerCase() === 'receipt') {
      return { ok: false, changed: false, reason: 'retry_tuning_ineligible_step' };
    }
    const increment = Math.max(0, Number(policy.max_retry_increment || 0));
    if (increment <= 0) {
      return { ok: false, changed: false, reason: 'retry_increment_disabled' };
    }
    const maxTotal = Math.max(0, Number(policy.max_total_retry_per_step || 0));
    const currentRetries = Math.max(0, Number(target.retries || 0));
    if (currentRetries >= maxTotal) {
      return { ok: false, changed: false, reason: 'retry_cap_reached' };
    }
    target.retries = Math.min(maxTotal, currentRetries + increment);
    list[safeIndex] = normalizeStep(target, safeIndex);
    return {
      ok: true,
      changed: true,
      steps: list,
      retry_index: safeIndex,
      detail: `step=${target.id} retries ${currentRetries}->${target.retries}`
    };
  }

  if (kind === 'guard_hardening') {
    if (hasStepId(list, 'preflight_runtime_guard')) {
      return { ok: false, changed: false, reason: 'preflight_guard_already_present' };
    }
    const guardStep = normalizeStep({
      id: 'preflight_runtime_guard',
      type: 'gate',
      command: 'node systems/autonomy/strategy_execute_guard.js run <date>',
      purpose: 'runtime mutation preflight guard',
      timeout_ms: 120000,
      retries: 0
    }, 0);
    list.splice(safeIndex, 0, guardStep);
    return {
      ok: true,
      changed: true,
      steps: list,
      retry_index: safeIndex,
      detail: 'inserted preflight_runtime_guard'
    };
  }

  if (kind === 'rollback_path') {
    const hasRollback = list.some((row) => String(row && row.id || '').toLowerCase().includes('rollback'));
    if (hasRollback) {
      return { ok: false, changed: false, reason: 'rollback_step_already_present' };
    }
    let rollbackId = 'rollback_runtime';
    let suffix = 1;
    while (hasStepId(list, rollbackId)) {
      rollbackId = `rollback_runtime_${suffix}`;
      suffix += 1;
    }
    const rollbackStep = normalizeStep({
      id: rollbackId,
      type: 'command',
      command: 'node systems/autonomy/strategy_execute_guard.js rollback <date>',
      purpose: 'runtime mutation rollback path',
      timeout_ms: 120000,
      retries: 0
    }, list.length);
    return {
      ok: true,
      changed: true,
      steps: insertBeforeReceipt(list, rollbackStep),
      retry_index: safeIndex,
      detail: `inserted ${rollbackId}`
    };
  }

  return { ok: false, changed: false, reason: 'unknown_mutation_kind' };
}

function selectWorkflows(
  registry: AnyObj,
  args: AnyObj,
  policy: AnyObj,
  rolloutState: AnyObj,
  runSeed: string
) {
  const rows = Array.isArray(registry && registry.workflows) ? registry.workflows.slice() : [];
  const max = clampInt(args.max, 1, 256, 8);
  const fallbackCfg = policy && policy.fallback_selection && typeof policy.fallback_selection === 'object'
    ? policy.fallback_selection
    : defaultPolicy().fallback_selection;
  const minimumCfg = policy && policy.minimum_selection && typeof policy.minimum_selection === 'object'
    ? policy.minimum_selection
    : defaultPolicy().minimum_selection;
  const includeDraft = boolFlag(
    args['include-draft'],
    fallbackCfg.include_drafts === true || minimumCfg.include_drafts === true
  );
  const explicitId = String(args.id || '').trim();
  const enforceEligibility = boolFlag(args['enforce-eligibility'], true);
  const stage = normalizeStage(
    rolloutState && rolloutState.stage,
    policy && policy.rollout ? policy.rollout.initial_stage : 'shadow'
  );
  const canaryFraction = clampNumber(
    Number(rolloutState && rolloutState.canary_fraction),
    Number(policy && policy.rollout ? policy.rollout.canary_min_fraction : 0.05),
    Number(policy && policy.rollout ? policy.rollout.canary_max_fraction : 1),
    Number(policy && policy.rollout ? policy.rollout.canary_fraction : 0.15)
  );

  let candidates = rows.filter((row) => {
    const status = String(row && row.status || '').toLowerCase();
    if (explicitId) return String(row && row.id || '') === explicitId;
    if (status === 'active') return true;
    if (includeDraft && status === 'draft') return true;
    return false;
  });
  candidates = candidates
    .sort((a, b) => String(b && b.updated_at || '').localeCompare(String(a && a.updated_at || '')));

  let selected = [];
  const excluded = [];
  const eligiblePool = [];
  for (const row of candidates) {
    const workflowId = String(row && row.id || '').trim();
    if (!workflowId) continue;
    const gate = assessWorkflowEligibility(row, policy, {
      manual_id: !!explicitId
    });
    if (enforceEligibility && gate.eligible !== true) {
      excluded.push({
        workflow_id: workflowId,
        reason: 'ineligible',
        details: gate.reasons
      });
      continue;
    }
    const seed = `${runSeed}|${workflowId}|canary`;
    const sampleUnit = stableUnit(seed);
    const sampled = !!explicitId || stage !== 'canary' || sampleUnit <= canaryFraction;
    const candidate = {
      row,
      workflow_id: workflowId,
      sample_unit: Number(sampleUnit.toFixed(6)),
      sampled
    };
    eligiblePool.push(candidate);
    if (!sampled) {
      excluded.push({
        workflow_id: workflowId,
        reason: 'canary_not_sampled',
        sample_unit: candidate.sample_unit,
        canary_fraction: Number(canaryFraction.toFixed(6))
      });
      continue;
    }
    selected.push(row);
  }

  if (!explicitId && stage === 'canary' && selected.length === 0 && eligiblePool.length > 0 && canaryFraction > 0) {
    const rescue = eligiblePool.slice(0).sort((a, b) => Number(a.sample_unit) - Number(b.sample_unit))[0];
    if (rescue && rescue.row) {
      selected.push(rescue.row);
      excluded.push({
        workflow_id: rescue.workflow_id,
        reason: 'canary_force_single_sample',
        sample_unit: rescue.sample_unit,
        canary_fraction: Number(canaryFraction.toFixed(6))
      });
    }
  }

  if (!explicitId && selected.length > max) {
    const overflow = selected.slice(max);
    for (const row of overflow) {
      excluded.push({
        workflow_id: String(row && row.id || ''),
        reason: 'max_limit_reached',
        max
      });
    }
    selected = selected.slice(0, max);
  }

  let fallbackApplied = false;
  let fallbackReason = '';
  if (!explicitId && selected.length === 0) {
    const fallback = fallbackSelectionDecision(candidates, excluded, policy, { explicit_id: explicitId });
    if (fallback && fallback.selected) {
      selected = [fallback.selected];
      fallbackApplied = true;
      fallbackReason = String(fallback.reason || 'fallback_selected');
    } else {
      fallbackReason = String(fallback && fallback.reason || '');
    }
  }

  let minimumSelectionApplied = false;
  let minimumSelectionReason = '';
  if (!explicitId && minimumCfg.enabled === true) {
    const targetSelected = clampInt(minimumCfg.target_selected, 1, 32, 1);
    const enforceLowRisk = minimumCfg.require_low_risk_presence === true;
    const hasLowRiskSelected = selected.some((row) => workflowAppearsSafeForFallback(row));
    const needsTargetCount = selected.length < targetSelected;
    const needsLowRisk = enforceLowRisk && !hasLowRiskSelected;

    const applyMinimumSelection = () => {
      const floor = minimumSelectionDecision(candidates, selected, policy, { explicit_id: explicitId });
      minimumSelectionReason = String(floor && floor.reason || 'minimum_selection_no_candidate');
      if (!floor || !floor.selected) return false;
      if (selected.length < max) {
        selected.push(floor.selected);
      } else {
        const replaced = selected[selected.length - 1];
        selected[selected.length - 1] = floor.selected;
        excluded.push({
          workflow_id: String(replaced && replaced.id || ''),
          reason: 'minimum_selection_replaced',
          details: [minimumSelectionReason]
        });
      }
      minimumSelectionApplied = true;
      return true;
    };

    if (needsTargetCount) {
      while (selected.length < targetSelected) {
        if (!applyMinimumSelection()) break;
      }
    }

    if (needsLowRisk && !selected.some((row) => workflowAppearsSafeForFallback(row))) {
      applyMinimumSelection();
    }
  }

  return {
    selected,
    excluded,
    stage,
    canary_fraction: Number(canaryFraction.toFixed(6)),
    enforce_eligibility: enforceEligibility,
    fallback_applied: fallbackApplied,
    fallback_reason: fallbackReason,
    minimum_selection_applied: minimumSelectionApplied,
    minimum_selection_reason: minimumSelectionReason
  };
}

function resolveFailureRollbackStep(steps: AnyObj[], policy: AnyObj) {
  const list = Array.isArray(steps) ? steps : [];
  const explicit = list.find((row) => {
    const id = String(row && row.id || '').toLowerCase();
    const purpose = String(row && row.purpose || '').toLowerCase();
    const command = String(row && row.command || '').toLowerCase();
    return id.includes('rollback')
      || purpose.includes('rollback')
      || /\brollback\b/.test(command);
  });
  if (explicit && typeof explicit === 'object') {
    return normalizeStep(explicit, list.indexOf(explicit));
  }
  const fb = policy && policy.failure_rollback && typeof policy.failure_rollback === 'object'
    ? policy.failure_rollback
    : defaultPolicy().failure_rollback;
  if (fb.enabled !== true) return null;
  const command = String(fb.default_command || '').trim();
  if (!command) return null;
  return normalizeStep({
    id: 'policy_default_rollback',
    type: 'command',
    command,
    purpose: 'policy default rollback',
    timeout_ms: Number(fb.timeout_ms || 120000),
    retries: Number(fb.retries || 0)
  }, list.length);
}

function executeWorkflow(workflow: AnyObj, context: AnyObj, options: AnyObj) {
  const started = Date.now();
  const stepSeed = Array.isArray(workflow && workflow.steps)
    ? workflow.steps.map((row, i) => normalizeStep(row, i))
    : [];
  let steps = stepSeed;
  const stepResults = [];
  const mutationReceipts = [];
  const mutationSummary = {
    attempted: 0,
    applied: 0,
    rolled_back: 0,
    by_kind: {}
  };
  const stepRuntime = options && options.policy && options.policy.step_runtime && typeof options.policy.step_runtime === 'object'
    ? options.policy.step_runtime
    : defaultPolicy().step_runtime;
  const tokenPolicy = options && options.token_economics && typeof options.token_economics === 'object'
    ? options.token_economics
    : defaultPolicy().token_economics;
  const workflowTokenCap = Math.max(0, Number(context && context.workflow_token_cap_tokens || 0));
  const workflowPredictedTokens = Math.max(0, Number(context && context.workflow_predicted_tokens || 0));
  const executionBudget = {
    attempts_cap: Number(stepRuntime.max_total_attempts_per_workflow || 0),
    retries_cap: Number(stepRuntime.max_total_retry_attempts_per_workflow || 0),
    duration_cap_ms: Number(stepRuntime.max_total_step_duration_ms_per_workflow || 0),
    token_cap_tokens: workflowTokenCap,
    attempts_used: 0,
    retries_used: 0,
    duration_ms_used: 0,
    tokens_used_est: 0
  };
  let ok = true;
  let blockedByGate = false;
  let stoppedStep = null;
  let failureReason = null;
  let rollbackResult = null;
  let cursor = 0;

  const runtimeMutation = options && options.runtime_mutation && typeof options.runtime_mutation === 'object'
    ? options.runtime_mutation
    : defaultPolicy().runtime_mutation;
  const runMutationState = options && options._run_mutation_state && typeof options._run_mutation_state === 'object'
    ? options._run_mutation_state
    : { total_mutations: 0 };

  const mergeBudgetUsage = (stepResult) => {
    const usage = summarizeStepUsage(stepResult);
    executionBudget.attempts_used += Number(usage.attempts || 0);
    executionBudget.retries_used += Number(usage.retries || 0);
    executionBudget.duration_ms_used += Number(usage.duration_ms || 0);
    executionBudget.tokens_used_est += Number(usage.tokens_est || 0);
    return checkBudgetPostStep(executionBudget, stepRuntime);
  };

  const runFailureRollback = (triggerStep, triggerReason) => {
    if (options.dry_run === true) return;
    const rollbackStep = resolveFailureRollbackStep(steps, options.policy || {});
    if (!rollbackStep) {
      rollbackResult = {
        source: 'none',
        ok: false,
        trigger_reason: String(triggerReason || 'step_failed'),
        trigger_step_id: triggerStep ? String(triggerStep.id || '') : null,
        reason: 'rollback_path_unavailable'
      };
      return;
    }
    const rollbackExec = executeStep(rollbackStep, {
      ...context,
      step_id: rollbackStep.id
    }, options);
    rollbackResult = {
      source: String(rollbackStep.id || '').toLowerCase() === 'policy_default_rollback'
        ? 'policy_default'
        : 'workflow',
      trigger_reason: String(triggerReason || 'step_failed'),
      trigger_step_id: triggerStep ? String(triggerStep.id || '') : null,
      ...rollbackExec
    };
    stepResults.push({
      ...rollbackExec,
      rollback_step: true,
      rollback_trigger_reason: String(triggerReason || 'step_failed')
    });
    mergeBudgetUsage(rollbackExec);
  };

  while (cursor < steps.length) {
    const step = steps[cursor];
    const preflightBudgetReason = checkBudgetPreflight(step, executionBudget, stepRuntime, tokenPolicy);
    if (preflightBudgetReason) {
      ok = false;
      stoppedStep = String(step && step.id || `step_${cursor + 1}`);
      failureReason = preflightBudgetReason;
      if (String(step && step.type || '').toLowerCase() === 'gate') blockedByGate = true;
      runFailureRollback(step, failureReason);
      break;
    }
    const stepResult = executeStep(step, {
      ...context,
      step_id: step && step.id ? step.id : `step_${cursor + 1}`
    }, options);
    stepResults.push(stepResult);
    const postStepBudgetReason = mergeBudgetUsage(stepResult);
    if (postStepBudgetReason) {
      ok = false;
      stoppedStep = String(step && step.id || `step_${cursor + 1}`);
      failureReason = postStepBudgetReason;
      if (String(step && step.type || '').toLowerCase() === 'gate') blockedByGate = true;
      runFailureRollback(step, failureReason);
      break;
    }
    if (stepResult.ok === true) {
      cursor += 1;
      continue;
    }

    let recovered = false;
    let terminalFailure = false;
    const mutationGate = typeof evaluateMutationGateExternal === 'function'
      ? evaluateMutationGateExternal({
          now_ts: nowIso(),
          last_failure_ts: nowIso(),
          objective_impact: workflow && workflow.objective_impact || workflow && workflow.risk || 'medium',
          safety_attested: options && options.runtime_mutation_safety_attested === true,
          human_veto_cleared: options && options.runtime_mutation_veto_cleared === true
        }, runtimeMutation)
      : { allowed: true, reasons: [] };

    const canMutate = options.dry_run !== true
      && runtimeMutation.enabled === true
      && Number(runMutationState.total_mutations || 0) < Number(runtimeMutation.max_mutations_per_run || 0)
      && Number(mutationSummary.applied || 0) < Number(runtimeMutation.max_mutations_per_workflow || 0)
      && mutationGate && mutationGate.allowed === true;

    if (!canMutate && runtimeMutation.enabled === true && options.dry_run !== true && mutationGate && Array.isArray(mutationGate.reasons) && mutationGate.reasons.length) {
      mutationReceipts.push({
        ts: nowIso(),
        type: 'workflow_runtime_mutation',
        status: 'blocked',
        run_id: String(context.run_id || ''),
        workflow_id: String(context.workflow_id || ''),
        workflow_name: String(workflow && workflow.name || ''),
        step_id: String(step && step.id || ''),
        step_type: String(step && step.type || ''),
        reason: mutationGate.reasons.join('|'),
        veto_until_ts: mutationGate.veto_until_ts || null
      });
    }

    if (canMutate) {
      const kinds = candidateMutationOrder(workflow, step, runtimeMutation, mutationSummary);
      for (const kind of kinds) {
        mutationSummary.attempted += 1;
        mutationSummary.by_kind[kind] = Number(mutationSummary.by_kind[kind] || 0) + 1;

        const beforeSteps = cloneSteps(steps);
        const beforeFingerprint = stepsFingerprint(beforeSteps);
        const mutationId = stableId(`${context.run_id}|${context.workflow_id}|${step.id}|${kind}|${mutationSummary.attempted}`, 'mut');
        const patch = applyMutationKind(kind, steps, cursor, runtimeMutation);

        if (!patch || patch.ok !== true || patch.changed !== true || !Array.isArray(patch.steps)) {
          mutationReceipts.push({
            ts: nowIso(),
            type: 'workflow_runtime_mutation',
            status: 'skipped',
            mutation_id: mutationId,
            run_id: String(context.run_id || ''),
            workflow_id: String(context.workflow_id || ''),
            workflow_name: String(workflow && workflow.name || ''),
            step_id: String(step && step.id || ''),
            step_type: String(step && step.type || ''),
            mutation_kind: kind,
            before_fingerprint: beforeFingerprint,
            after_fingerprint: beforeFingerprint,
            reason: String(patch && patch.reason || 'mutation_not_applicable')
          });
          continue;
        }

        steps = patch.steps.map((row, i) => normalizeStep(row, i));
        const afterFingerprint = stepsFingerprint(steps);
        mutationSummary.applied += 1;
        runMutationState.total_mutations = Number(runMutationState.total_mutations || 0) + 1;

        mutationReceipts.push({
          ts: nowIso(),
          type: 'workflow_runtime_mutation',
          status: 'applied',
          mutation_id: mutationId,
          run_id: String(context.run_id || ''),
          workflow_id: String(context.workflow_id || ''),
          workflow_name: String(workflow && workflow.name || ''),
          step_id: String(step && step.id || ''),
          step_type: String(step && step.type || ''),
          mutation_kind: kind,
          before_fingerprint: beforeFingerprint,
          after_fingerprint: afterFingerprint,
          detail: cleanText(patch.detail || '', 220)
        });

        if (runtimeMutation.retry_after_apply === true) {
          const retryIndex = Math.max(0, Math.min(steps.length - 1, Number(patch.retry_index || cursor)));
          const retryStep = steps[retryIndex];
          const retryResult = executeStep(retryStep, {
            ...context,
            step_id: retryStep.id
          }, options);
          stepResults.push({
            ...retryResult,
            runtime_mutation_retry: true,
            mutation_id: mutationId,
            mutation_kind: kind
          });
          const retryBudgetReason = mergeBudgetUsage(retryResult);
          if (retryBudgetReason) {
            ok = false;
            stoppedStep = String(retryStep && retryStep.id || `step_${retryIndex + 1}`);
            failureReason = retryBudgetReason;
            if (String(retryStep && retryStep.type || '').toLowerCase() === 'gate') blockedByGate = true;
            runFailureRollback(retryStep, failureReason);
            terminalFailure = true;
            break;
          }
          if (retryResult.ok === true) {
            cursor = retryIndex + 1;
            recovered = true;
            break;
          }
          if (runtimeMutation.rollback_on_regression === true) {
            steps = beforeSteps;
            mutationSummary.rolled_back += 1;
            mutationReceipts.push({
              ts: nowIso(),
              type: 'workflow_runtime_mutation_rollback',
              status: 'rolled_back',
              mutation_id: mutationId,
              run_id: String(context.run_id || ''),
              workflow_id: String(context.workflow_id || ''),
              workflow_name: String(workflow && workflow.name || ''),
              step_id: String(step && step.id || ''),
              step_type: String(step && step.type || ''),
              mutation_kind: kind,
              reason: 'regression_after_mutation_retry'
            });
          }
        }
      }
    }

    if (terminalFailure === true) break;
    if (recovered === true) continue;

    ok = false;
    stoppedStep = step.id;
    failureReason = String(stepResult && stepResult.failure_reason || '').trim() || 'step_failed';
    if (step.type === 'gate') blockedByGate = true;
    runFailureRollback(step, failureReason);
    break;
  }

  const ended = Date.now();
  return {
    workflow_id: String(workflow && workflow.id || ''),
    name: String(workflow && workflow.name || ''),
    status: ok ? 'succeeded' : (blockedByGate ? 'blocked' : 'failed'),
    ok,
    blocked_by_gate: blockedByGate,
    stopped_step_id: stoppedStep,
    failure_reason: failureReason,
    rollback_attempted: !!rollbackResult,
    rollback_ok: rollbackResult ? rollbackResult.ok === true : null,
    rollback_source: rollbackResult ? rollbackResult.source : null,
    rollback_step_id: rollbackResult && rollbackResult.step ? rollbackResult.step.id : null,
    rollback_trigger_reason: rollbackResult ? rollbackResult.trigger_reason || null : null,
    started_at: new Date(started).toISOString(),
    ended_at: new Date(ended).toISOString(),
    duration_ms: ended - started,
    step_count: steps.length,
    execution_budget: {
      attempts_cap: executionBudget.attempts_cap,
      retries_cap: executionBudget.retries_cap,
      duration_cap_ms: executionBudget.duration_cap_ms,
      token_cap_tokens: executionBudget.token_cap_tokens,
      predicted_tokens: workflowPredictedTokens,
      attempts_used: executionBudget.attempts_used,
      retries_used: executionBudget.retries_used,
      duration_ms_used: executionBudget.duration_ms_used,
      tokens_used_est: executionBudget.tokens_used_est
    },
    step_results: stepResults,
    mutation_summary: mutationSummary,
    mutation_receipts: mutationReceipts
  };
}

function parseIsoMs(value: unknown) {
  const ts = Date.parse(String(value == null ? '' : value));
  return Number.isFinite(ts) ? ts : null;
}

function computeRunSlo(results: AnyObj[], selectedCount: number, runStartedMs: number, policy: AnyObj) {
  const list = Array.isArray(results) ? results : [];
  const executed = list.length;
  const succeeded = list.filter((row) => row && row.ok === true).length;
  const firstStartMs = list
    .map((row) => parseIsoMs(row && row.started_at))
    .filter((n) => Number.isFinite(Number(n)))
    .sort((a, b) => Number(a) - Number(b))[0];
  const timeToFirst = Number.isFinite(Number(firstStartMs))
    ? Math.max(0, Number(firstStartMs) - Number(runStartedMs || Date.now()))
    : null;
  const measured = {
    execution_success_rate: Number(safeRate(succeeded, executed, 0).toFixed(4)),
    queue_drain_rate: Number(safeRate(executed, selectedCount, 0).toFixed(4)),
    time_to_first_execution_ms: timeToFirst
  };
  const thresholds = {
    min_execution_success_rate: Number(policy && policy.slo ? policy.slo.min_execution_success_rate : 0.9),
    min_queue_drain_rate: Number(policy && policy.slo ? policy.slo.min_queue_drain_rate : 0.75),
    max_time_to_first_execution_ms: Number(policy && policy.slo ? policy.slo.max_time_to_first_execution_ms : 180000)
  };
  const checks = {
    execution_success_rate: measured.execution_success_rate >= thresholds.min_execution_success_rate,
    queue_drain_rate: measured.queue_drain_rate >= thresholds.min_queue_drain_rate,
    time_to_first_execution_ms: measured.time_to_first_execution_ms != null
      && measured.time_to_first_execution_ms <= thresholds.max_time_to_first_execution_ms
  };
  return {
    thresholds,
    measured,
    checks,
    pass: checks.execution_success_rate && checks.queue_drain_rate && checks.time_to_first_execution_ms
  };
}

function historicalSloRows(historyRows: AnyObj[], opts: AnyObj = {}) {
  const ignoreDryRun = opts && opts.ignore_dry_run === true;
  const out = [];
  for (const row of Array.isArray(historyRows) ? historyRows : []) {
    if (!row || typeof row !== 'object') continue;
    if (ignoreDryRun && row.dry_run === true) continue;
    if (row.slo && typeof row.slo === 'object' && row.slo.measured && typeof row.slo.measured === 'object') {
      out.push({
        ts: row.ts || null,
        execution_success_rate: Number(row.slo.measured.execution_success_rate || 0),
        queue_drain_rate: Number(row.slo.measured.queue_drain_rate || 0),
        time_to_first_execution_ms: row.slo.measured.time_to_first_execution_ms == null
          ? null
          : Number(row.slo.measured.time_to_first_execution_ms || 0)
      });
      continue;
    }
    const selected = Number(row.workflows_selected || 0);
    const executed = Number(row.workflows_executed || 0);
    const succeeded = Number(row.workflows_succeeded || 0);
    out.push({
      ts: row.ts || null,
      execution_success_rate: Number(safeRate(succeeded, executed, 0).toFixed(4)),
      queue_drain_rate: Number(safeRate(executed, selected, 0).toFixed(4)),
      time_to_first_execution_ms: row.time_to_first_execution_ms == null
        ? null
        : Number(row.time_to_first_execution_ms || 0)
    });
  }
  return out;
}

function computeSloWindow(historyRows: AnyObj[], runSlo: AnyObj, policy: AnyObj) {
  const lookback = clampInt(policy && policy.slo ? policy.slo.lookback_runs : 6, 1, 200, 6);
  const minRuns = clampInt(policy && policy.slo ? policy.slo.min_runs_for_decision : 3, 1, 100, 3);
  const prior = historicalSloRows(historyRows, {
    ignore_dry_run: policy && policy.slo ? policy.slo.ignore_dry_run_history === true : true
  }).slice(-Math.max(0, lookback - 1));
  const current = {
    ts: nowIso(),
    execution_success_rate: Number(runSlo && runSlo.measured ? runSlo.measured.execution_success_rate || 0 : 0),
    queue_drain_rate: Number(runSlo && runSlo.measured ? runSlo.measured.queue_drain_rate || 0 : 0),
    time_to_first_execution_ms: runSlo && runSlo.measured ? runSlo.measured.time_to_first_execution_ms : null
  };
  const window = prior.concat([current]);
  const successRates = window
    .map((row) => Number(row.execution_success_rate))
    .filter((v) => Number.isFinite(v));
  const drainRates = window
    .map((row) => Number(row.queue_drain_rate))
    .filter((v) => Number.isFinite(v));
  const ttfValues = window
    .map((row) => Number(row.time_to_first_execution_ms))
    .filter((v) => Number.isFinite(v) && v >= 0);
  const avg = (values: number[]) => {
    if (!Array.isArray(values) || values.length === 0) return null;
    return values.reduce((sum, v) => sum + Number(v), 0) / values.length;
  };
  const aggregate = {
    runs_considered: window.length,
    min_runs_for_decision: minRuns,
    avg_execution_success_rate: avg(successRates),
    avg_queue_drain_rate: avg(drainRates),
    max_time_to_first_execution_ms: ttfValues.length ? Math.max(...ttfValues) : null
  };
  const thresholds = {
    min_execution_success_rate: Number(policy && policy.slo ? policy.slo.min_execution_success_rate : 0.9),
    min_queue_drain_rate: Number(policy && policy.slo ? policy.slo.min_queue_drain_rate : 0.75),
    max_time_to_first_execution_ms: Number(policy && policy.slo ? policy.slo.max_time_to_first_execution_ms : 180000)
  };
  const sufficientData = aggregate.runs_considered >= minRuns;
  const checks = {
    execution_success_rate: aggregate.avg_execution_success_rate != null
      && aggregate.avg_execution_success_rate >= thresholds.min_execution_success_rate,
    queue_drain_rate: aggregate.avg_queue_drain_rate != null
      && aggregate.avg_queue_drain_rate >= thresholds.min_queue_drain_rate,
    time_to_first_execution_ms: aggregate.max_time_to_first_execution_ms != null
      && aggregate.max_time_to_first_execution_ms <= thresholds.max_time_to_first_execution_ms
  };
  return {
    thresholds,
    aggregate: {
      ...aggregate,
      avg_execution_success_rate: aggregate.avg_execution_success_rate == null
        ? null
        : Number(aggregate.avg_execution_success_rate.toFixed(4)),
      avg_queue_drain_rate: aggregate.avg_queue_drain_rate == null
        ? null
        : Number(aggregate.avg_queue_drain_rate.toFixed(4))
    },
    checks,
    sufficient_data: sufficientData,
    pass: sufficientData && checks.execution_success_rate && checks.queue_drain_rate && checks.time_to_first_execution_ms
  };
}

function rollbackGuardTriggered(runSignal: AnyObj, rollout: AnyObj) {
  const guard = rollout && rollout.rollback_guard && typeof rollout.rollback_guard === 'object'
    ? rollout.rollback_guard
    : defaultPolicy().rollout.rollback_guard;
  if (guard.enabled !== true) return false;
  const failed = Number(runSignal && runSignal.workflows_failed || 0);
  const blocked = Number(runSignal && runSignal.workflows_blocked || 0);
  const successRate = safeRate(
    Number(runSignal && runSignal.workflows_succeeded || 0),
    Number(runSignal && runSignal.workflows_executed || 0),
    0
  );
  if (guard.trigger_on_workflow_failure === true && failed > 0) return true;
  if (guard.trigger_on_workflow_blocked === true && blocked > 0) return true;
  if (Number.isFinite(successRate) && successRate < Number(guard.min_execution_success_rate || 0.95)) return true;
  return false;
}

function nextRolloutState(current: AnyObj, policy: AnyObj, scalePass: boolean, scaleEligible: boolean, runSignal: AnyObj = {}) {
  const rollout = policy && policy.rollout && typeof policy.rollout === 'object'
    ? policy.rollout
    : defaultPolicy().rollout;
  const minFraction = Number(rollout.canary_min_fraction || 0.05);
  const maxFraction = Number(rollout.canary_max_fraction || 1);
  const next = {
    ...(current && typeof current === 'object' ? current : rolloutDefaultState(policy))
  };
  next.stage = normalizeStage(next.stage, normalizeStage(rollout.initial_stage, 'shadow'));
  next.canary_fraction = clampNumber(Number(next.canary_fraction), minFraction, maxFraction, Number(rollout.canary_fraction || 0.15));
  next.last_scale_action = null;

  if (rollout.enabled !== true) {
    next.stage = 'live';
    next.canary_fraction = 1;
    next.last_slo_pass = null;
    next.consecutive_green = 0;
    next.consecutive_red = 0;
    next.last_scale_action = 'rollout_disabled_force_live';
    return next;
  }

  if (!scaleEligible) {
    next.last_slo_pass = null;
    next.last_scale_action = 'rollout_scale_skipped';
    return next;
  }

  if (rollbackGuardTriggered(runSignal, rollout)) {
    const guard = rollout && rollout.rollback_guard && typeof rollout.rollback_guard === 'object'
      ? rollout.rollback_guard
      : defaultPolicy().rollout.rollback_guard;
    const rollbackStep = clampNumber(
      Number(guard.rollback_fraction_step || 0.2),
      0.01,
      1,
      0.2
    );
    if (next.stage === 'live' && guard.demote_live_to_canary !== false) {
      next.stage = 'canary';
      next.canary_fraction = clampNumber(
        Number(rollout.promote_to_live_fraction || 0.6) - rollbackStep,
        minFraction,
        maxFraction,
        minFraction
      );
      next.last_scale_action = 'rollback_guard_live_to_canary';
    } else if (next.stage === 'canary') {
      next.canary_fraction = clampNumber(
        next.canary_fraction - rollbackStep,
        minFraction,
        maxFraction,
        minFraction
      );
      const floorReached = next.canary_fraction <= (minFraction + 1e-9);
      if (floorReached && rollout.demote_shadow_on_floor_breach === true) {
        next.stage = 'shadow';
        next.last_scale_action = 'rollback_guard_canary_to_shadow';
      } else {
        next.last_scale_action = 'rollback_guard_canary_step_down';
      }
    }
    next.last_slo_pass = false;
    next.consecutive_green = 0;
    next.consecutive_red = 0;
    return next;
  }

  next.last_slo_pass = scalePass === true;
  if (scalePass === true) {
    next.consecutive_green = Number(next.consecutive_green || 0) + 1;
    next.consecutive_red = 0;
  } else {
    next.consecutive_red = Number(next.consecutive_red || 0) + 1;
    next.consecutive_green = 0;
  }

  const minGreen = Number(rollout.min_consecutive_green_for_scale_up || 3);
  const minRed = Number(rollout.min_consecutive_red_for_scale_down || 1);
  if (next.stage === 'shadow' && scalePass === true && next.consecutive_green >= minGreen) {
    next.stage = 'canary';
    next.canary_fraction = clampNumber(next.canary_fraction, minFraction, maxFraction, Number(rollout.canary_fraction || 0.15));
    next.consecutive_green = 0;
    next.consecutive_red = 0;
    next.last_scale_action = 'promote_shadow_to_canary';
    return next;
  }

  if (next.stage === 'canary') {
    if (scalePass === true && next.consecutive_green >= minGreen) {
      const promoteFloor = clampNumber(Number(rollout.promote_to_live_fraction || 0.6), minFraction, 1, 0.6);
      if (next.canary_fraction >= promoteFloor) {
        next.stage = 'live';
        next.canary_fraction = 1;
        next.last_scale_action = 'promote_canary_to_live';
      } else {
        next.canary_fraction = clampNumber(
          next.canary_fraction + Number(rollout.scale_up_step || 0.1),
          minFraction,
          maxFraction,
          next.canary_fraction
        );
        next.last_scale_action = 'canary_scale_up';
      }
      next.consecutive_green = 0;
      next.consecutive_red = 0;
      return next;
    }
    if (scalePass !== true && next.consecutive_red >= minRed) {
      next.canary_fraction = clampNumber(
        next.canary_fraction - Number(rollout.scale_down_step || 0.1),
        minFraction,
        maxFraction,
        next.canary_fraction
      );
      const floorReached = next.canary_fraction <= (minFraction + 1e-9);
      if (floorReached && rollout.demote_shadow_on_floor_breach === true) {
        next.stage = 'shadow';
        next.last_scale_action = 'demote_canary_to_shadow';
      } else {
        next.last_scale_action = 'canary_scale_down';
      }
      next.consecutive_green = 0;
      next.consecutive_red = 0;
      return next;
    }
    return next;
  }

  if (next.stage === 'live' && scalePass !== true && next.consecutive_red >= minRed) {
    next.stage = 'canary';
    next.canary_fraction = clampNumber(
      Number(rollout.promote_to_live_fraction || 0.6),
      minFraction,
      maxFraction,
      maxFraction
    );
    next.consecutive_green = 0;
    next.consecutive_red = 0;
    next.last_scale_action = 'demote_live_to_canary';
  }
  return next;
}

function runCmd(dateStr: string, args: AnyObj) {
  const runStartedMs = Date.now();
  const runId = `wfexec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const policyPath = path.resolve(String(args.policy || process.env.WORKFLOW_EXECUTOR_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const rolloutState = loadRolloutState(policy);
  const rolloutEnabled = policy && policy.rollout && policy.rollout.enabled === true;
  const stage = rolloutEnabled
    ? normalizeStage(rolloutState.stage, normalizeStage(policy.rollout.initial_stage, 'shadow'))
    : 'live';
  const dryRunArgPresent = Object.prototype.hasOwnProperty.call(args, 'dry-run');
  const dryRunArgValue = boolFlag(args['dry-run'], false);
  const soulTokenGate = evaluateSoulTokenGate(policy, args);
  const gateForcedDryRun = soulTokenGate.forced_shadow === true;
  const stageForcedDryRun = rolloutEnabled
    && stage === 'shadow'
    && policy.rollout.shadow_dry_run === true
    && !dryRunArgPresent;
  const effectiveDryRun = dryRunArgValue || stageForcedDryRun || gateForcedDryRun;
  const options = {
    dry_run: effectiveDryRun,
    continue_on_error: boolFlag(args['continue-on-error'], false),
    receipt_strict: boolFlag(args['receipt-strict'], true),
    policy,
    runtime_mutation: {
      ...(policy && policy.runtime_mutation && typeof policy.runtime_mutation === 'object'
        ? policy.runtime_mutation
        : defaultPolicy().runtime_mutation),
      enabled: boolFlag(
        args['runtime-mutation'],
        !!(policy && policy.runtime_mutation && policy.runtime_mutation.enabled === true)
      )
    },
    runtime_mutation_safety_attested: boolFlag(args['runtime-mutation-safety-attested'], false),
    runtime_mutation_veto_cleared: boolFlag(args['runtime-mutation-veto-cleared'], false),
    soul_token_gate: soulTokenGate,
    _run_mutation_state: {
      total_mutations: 0
    }
  };

  const registry = loadRegistry();
  const selection = selectWorkflows(registry, args, policy, rolloutState, `${runId}|${dateStr}`);
  const selectedInitial = Array.isArray(selection && selection.selected) ? selection.selected : [];
  const tokenPlan = planTokenEconomics(dateStr, selectedInitial, policy, args, {
    dry_run: options.dry_run === true
  });
  const deferredRows = Array.isArray(tokenPlan && tokenPlan.deferred) ? tokenPlan.deferred : [];
  if (Array.isArray(selection && selection.excluded) && deferredRows.length) {
    for (const row of deferredRows) {
      selection.excluded.push({
        workflow_id: row.workflow_id || null,
        reason: row.reason || 'token_economics_deferred',
        details: [
          `predicted_tokens=${Number(row.predicted_tokens || 0)}`,
          `envelope_tokens=${Number(row.envelope_tokens || 0)}`,
          `critical_lane=${row.critical_lane === true ? '1' : '0'}`
        ]
      });
    }
  }
  if (
    options.dry_run !== true
    && tokenPlan
    && tokenPlan.token_policy
    && tokenPlan.token_policy.defer_queue_enabled === true
    && deferredRows.length
  ) {
    for (const row of deferredRows) {
      appendJsonl(DEFER_QUEUE_PATH, {
        ts: nowIso(),
        type: 'workflow_executor_defer',
        run_id: runId,
        date: dateStr,
        workflow_id: row.workflow_id || null,
        workflow_name: row.workflow_name || null,
        predicted_tokens: Number(row.predicted_tokens || 0),
        envelope_tokens: Number(row.envelope_tokens || 0),
        priority: row.priority || null,
        priority_rank: Number(row.priority_rank || 0),
        critical_lane: row.critical_lane === true,
        throttle_ratio: Number(row.throttle_ratio || 0),
        reason: row.reason || 'token_economics_deferred',
        autopause_reason: row.autopause_reason || null
      });
    }
  }
  const executionPlans = Array.isArray(tokenPlan && tokenPlan.executable) ? tokenPlan.executable : [];
  const selected = executionPlans.map((row) => row.workflow).filter(Boolean);
  const results = [];

  for (const planned of executionPlans) {
    const workflow = planned && planned.workflow ? planned.workflow : null;
    if (!workflow) continue;
    const workflowMeta = workflow && workflow.metadata && typeof workflow.metadata === 'object'
      ? workflow.metadata
      : {};
    const result = executeWorkflow(workflow, {
      run_id: runId,
      date: dateStr,
      workflow,
      workflow_id: String(workflow && workflow.id || ''),
      objective_id: String(workflow && workflow.objective_id || ''),
      eye_id: String(workflow && workflow.trigger && workflow.trigger.eye_id || workflow && workflow.eye_id || ''),
      adapter: cleanText(workflowMeta.adapter || '', 80) || '',
      provider: cleanText(workflowMeta.provider || '', 80).toLowerCase() || '',
      workflow_priority: planned && planned.priority ? String(planned.priority) : 'medium',
      workflow_critical_lane: planned && planned.critical_lane === true,
      workflow_predicted_tokens: Number(planned && planned.predicted_tokens || 0),
      workflow_token_cap_tokens: Number(planned && planned.envelope_tokens || 0),
      policy_root_lease_token: cleanText(
        args['lease-token'] || args.lease_token || process.env.CAPABILITY_LEASE_TOKEN || '',
        8192
      ),
      policy_root_approval_note: cleanText(
        args['approval-note'] || args.approval_note || process.env.WORKFLOW_EXECUTOR_POLICY_ROOT_APPROVAL_NOTE || '',
        320
      )
    }, options);
    result.token_economics = {
      predicted_tokens: Number(planned && planned.predicted_tokens || 0),
      envelope_tokens: Number(planned && planned.envelope_tokens || 0),
      throttle_ratio: Number(planned && planned.throttle_ratio || 0),
      priority: planned && planned.priority ? String(planned.priority) : 'medium',
      priority_rank: Number(planned && planned.priority_rank || 0),
      critical_lane: planned && planned.critical_lane === true,
      decision_reason: planned && planned.reason ? String(planned.reason) : 'token_economics_allow'
    };
    result.high_value_play = workflow && workflow.high_value_play && typeof workflow.high_value_play === 'object'
      ? workflow.high_value_play
      : null;
    results.push(result);
    if (
      options.dry_run !== true
      && tokenPlan
      && tokenPlan.token_policy
      && tokenPlan.token_policy.use_system_budget === true
    ) {
      try {
        const usedTokens = Math.max(
          0,
          Number(
            result
            && result.execution_budget
            && result.execution_budget.tokens_used_est != null
              ? result.execution_budget.tokens_used_est
              : (planned && planned.envelope_tokens || 0)
          )
        );
        if (usedTokens > 0) {
          recordSystemBudgetUsage({
            date: dateStr,
            module: 'workflow_executor',
            capability: planned && planned.priority ? String(planned.priority) : 'workflow',
            tokens_est: usedTokens
          }, {});
        }
      } catch {
        // Budget usage receipts are best-effort and should never stop execution.
      }
    }
    if (result.ok !== true && options.continue_on_error !== true) break;
  }

  let highValueOutcomes = null;
  if (typeof recordHighValuePlayOutcomes === 'function') {
    try {
      highValueOutcomes = recordHighValuePlayOutcomes({
        date: dateStr,
        run_id: runId,
        dry_run: options.dry_run === true,
        results,
        workflows: selected
      });
    } catch (err) {
      highValueOutcomes = {
        ok: false,
        error: cleanText(err && err.message ? err.message : err || 'high_value_outcome_record_failed', 180)
      };
    }
  }

  const succeeded = results.filter((row) => row && row.ok === true).length;
  const failed = results.filter((row) => row && row.ok !== true).length;
  const blocked = results.filter((row) => row && row.blocked_by_gate === true).length;
  const failedNonBlocked = results.filter((row) => row && row.ok !== true && row.blocked_by_gate !== true).length;
  const unhandledFailures = results.filter((row) =>
    row
    && row.ok !== true
    && row.blocked_by_gate !== true
    && row.rollback_ok !== true
  ).length;
  const handledFailures = Math.max(0, failedNonBlocked - unhandledFailures);
  const mutationAttempted = results.reduce((sum, row) => sum + Number(row && row.mutation_summary && row.mutation_summary.attempted || 0), 0);
  const mutationApplied = results.reduce((sum, row) => sum + Number(row && row.mutation_summary && row.mutation_summary.applied || 0), 0);
  const mutationRolledBack = results.reduce((sum, row) => sum + Number(row && row.mutation_summary && row.mutation_summary.rolled_back || 0), 0);
  const workflowsDeferred = deferredRows.length;
  const tokenPredictedSelected = Number(tokenPlan && tokenPlan.predicted_total_tokens || 0);
  const tokenEnvelopeSelected = Number(tokenPlan && tokenPlan.enveloped_total_tokens || 0);
  const tokenUsedExecuted = results.reduce((sum, row) => {
    return sum + Number(row && row.execution_budget && row.execution_budget.tokens_used_est || 0);
  }, 0);
  const deferredByReason = deferredRows.reduce((acc: AnyObj, row: AnyObj) => {
    const reason = cleanText(row && row.reason || 'token_economics_deferred', 80) || 'token_economics_deferred';
    acc[reason] = Number(acc[reason] || 0) + 1;
    return acc;
  }, {});

  const mutationRows = [];
  const stepReceiptRows = [];
  const failureReasons: AnyObj = {};
  for (const row of results) {
    const failureReason = String(row && row.failure_reason || '').trim();
    if (failureReason) failureReasons[failureReason] = Number(failureReasons[failureReason] || 0) + 1;
    const receipts = Array.isArray(row && row.mutation_receipts) ? row.mutation_receipts : [];
    for (const rec of receipts) mutationRows.push(rec);
    const steps = Array.isArray(row && row.step_results) ? row.step_results : [];
    for (const step of steps) {
      stepReceiptRows.push({
        ts: nowIso(),
        type: 'workflow_executor_step_receipt',
        run_id: runId,
        date: dateStr,
        workflow_id: String(row && row.workflow_id || ''),
        workflow_name: String(row && row.name || ''),
        workflow_status: String(row && row.status || ''),
        step_id: String(step && step.step && step.step.id || ''),
        step_type: String(step && step.step && step.step.type || ''),
        ok: step && step.ok === true,
        attempts: Number(step && step.attempts || 0),
        dry_run: step && step.dry_run === true,
        failure_reason: step && step.failure_reason ? String(step.failure_reason) : null,
        rollback_step: step && step.rollback_step === true,
        rollback_trigger_reason: step && step.rollback_trigger_reason ? String(step.rollback_trigger_reason) : null,
        runtime_mutation_retry: step && step.runtime_mutation_retry === true,
        tokens_est_total: Number(step && step.tokens_est_total || 0),
        external_gate: step && step.external_gate && typeof step.external_gate === 'object'
          ? step.external_gate
          : null,
        rate_limit_gate: step && step.rate_limit_gate && typeof step.rate_limit_gate === 'object'
          ? step.rate_limit_gate
          : null,
        communication_gate: step && step.communication_gate && typeof step.communication_gate === 'object'
          ? step.communication_gate
          : null,
        success_criteria: step && step.success_criteria && typeof step.success_criteria === 'object'
          ? step.success_criteria
          : null,
        records: Array.isArray(step && step.records) ? step.records : []
      });
    }
  }

  let stepReceiptPathRel = null;
  if (stepReceiptRows.length && options.dry_run !== true) {
    ensureDir(STEP_RECEIPTS_DIR);
    const stepReceiptPath = path.join(STEP_RECEIPTS_DIR, `${dateStr}.jsonl`);
    for (const rec of stepReceiptRows) appendJsonl(stepReceiptPath, rec);
    stepReceiptPathRel = relPath(stepReceiptPath);
  }

  let mutationReceiptPathRel = null;
  if (mutationRows.length && options.dry_run !== true) {
    ensureDir(MUTATION_RECEIPTS_DIR);
    const mutationReceiptPath = path.join(MUTATION_RECEIPTS_DIR, `${dateStr}.jsonl`);
    for (const rec of mutationRows) appendJsonl(mutationReceiptPath, rec);
    mutationReceiptPathRel = relPath(mutationReceiptPath);
  }

  const runSlo = computeRunSlo(results, selected.length, runStartedMs, policy);
  const historyRows = readJsonl(HISTORY_PATH);
  const sloWindow = computeSloWindow(historyRows, runSlo, policy);
  const alertCfg = policy && policy.alerts && typeof policy.alerts === 'object'
    ? policy.alerts
    : defaultPolicy().alerts;
  const projectedHistory = historyRows.concat([{
    dry_run: options.dry_run === true,
    workflows_selected: selected.length
  }]);
  const liveZeroStreak = liveZeroSelectionStreak(
    projectedHistory,
    Number(alertCfg.history_scan_limit || 240)
  );
  const liveZeroSelectionThreshold = clampInt(
    alertCfg.live_zero_selection_streak_threshold,
    1,
    100,
    defaultPolicy().alerts.live_zero_selection_streak_threshold
  );
  const scaleEligible = options.dry_run !== true;
  const scalePass = sloWindow.sufficient_data === true
    ? sloWindow.pass === true
    : runSlo.pass === true;
  const runSignal = {
    workflows_selected: selected.length,
    workflows_executed: results.length,
    workflows_succeeded: succeeded,
    workflows_failed: failed,
    workflows_blocked: blocked
  };
  const rolloutBefore = {
    stage: normalizeStage(rolloutState.stage, stage),
    canary_fraction: Number(clampNumber(
      Number(rolloutState.canary_fraction),
      Number(policy && policy.rollout ? policy.rollout.canary_min_fraction : 0.05),
      Number(policy && policy.rollout ? policy.rollout.canary_max_fraction : 1),
      Number(policy && policy.rollout ? policy.rollout.canary_fraction : 0.15)
    ).toFixed(6)),
    consecutive_green: Number(rolloutState.consecutive_green || 0),
    consecutive_red: Number(rolloutState.consecutive_red || 0),
    last_slo_pass: rolloutState.last_slo_pass == null ? null : rolloutState.last_slo_pass === true,
    last_scale_action: rolloutState.last_scale_action || null
  };
  const rolloutAfter = nextRolloutState(rolloutState, policy, scalePass, scaleEligible, runSignal);
  saveRolloutState(rolloutAfter);

  const payload = {
    ok: true,
    type: 'workflow_executor_run',
    ts: nowIso(),
    run_id: runId,
    date: dateStr,
    dry_run: options.dry_run === true,
    forced_shadow_dry_run: stageForcedDryRun === true,
    forced_shadow_soul_token: gateForcedDryRun === true,
    soul_token_gate: soulTokenGate,
    continue_on_error: options.continue_on_error === true,
    receipt_strict: options.receipt_strict === true,
    rollout_enabled: rolloutEnabled,
    rollout_stage: stage,
    rollout_canary_fraction: Number(selection && selection.canary_fraction || 0),
    rollout_scale_eligible: scaleEligible,
    rollout_state_before: rolloutBefore,
    rollout_state_after: {
      stage: rolloutAfter.stage,
      canary_fraction: Number(Number(rolloutAfter.canary_fraction || 0).toFixed(6)),
      consecutive_green: Number(rolloutAfter.consecutive_green || 0),
      consecutive_red: Number(rolloutAfter.consecutive_red || 0),
      last_slo_pass: rolloutAfter.last_slo_pass == null ? null : rolloutAfter.last_slo_pass === true,
      last_scale_action: rolloutAfter.last_scale_action || null
    },
    runtime_mutation_enabled: options.runtime_mutation.enabled === true,
    runtime_mutation_policy_path: relPath(policyPath),
    registry_total: Array.isArray(registry && registry.workflows) ? registry.workflows.length : 0,
    workflows_selected_initial: selectedInitial.length,
    workflows_selected: selected.length,
    workflows_deferred: workflowsDeferred,
    workflows_excluded: Array.isArray(selection && selection.excluded) ? selection.excluded.length : 0,
    selection_excluded: Array.isArray(selection && selection.excluded) ? selection.excluded : [],
    selection_excluded_by_reason: (() => {
      const counts: AnyObj = {};
      const rows = Array.isArray(selection && selection.excluded) ? selection.excluded : [];
      for (const row of rows) {
        const reason = cleanText(row && row.reason || 'unknown', 80) || 'unknown';
        counts[reason] = Number(counts[reason] || 0) + 1;
      }
      return counts;
    })(),
    fallback_applied: selection && selection.fallback_applied === true,
    fallback_reason: selection ? cleanText(selection.fallback_reason || '', 80) : '',
    minimum_selection_applied: selection && selection.minimum_selection_applied === true,
    minimum_selection_reason: selection ? cleanText(selection.minimum_selection_reason || '', 120) : '',
    enforce_eligibility: selection && selection.enforce_eligibility === true,
    live_zero_selection_streak: options.dry_run === true ? null : liveZeroStreak,
    live_zero_selection_streak_threshold: liveZeroSelectionThreshold,
    workflows_executed: results.length,
    workflows_succeeded: succeeded,
    workflows_failed: failed,
    workflows_blocked: blocked,
    handled_failures: handledFailures,
    unhandled_failures: unhandledFailures,
    failure_reasons: failureReasons,
    deferred_reasons: deferredByReason,
    token_economics: {
      enabled: tokenPlan && tokenPlan.enabled === true,
      run_token_cap_tokens: Number(tokenPlan && tokenPlan.run_token_cap_tokens || 0),
      predicted_total_tokens: tokenPredictedSelected,
      enveloped_total_tokens: tokenEnvelopeSelected,
      used_total_tokens: Number(tokenUsedExecuted.toFixed(2)),
      deferred_count: workflowsDeferred,
      deferred_by_reason: deferredByReason,
      budget_snapshot: tokenPlan && tokenPlan.budget_snapshot ? tokenPlan.budget_snapshot : null,
      scaling: tokenPlan && tokenPlan.scaling ? tokenPlan.scaling : null
    },
    high_value_play: highValueOutcomes && typeof highValueOutcomes === 'object'
      ? highValueOutcomes
      : null,
    step_receipts_count: stepReceiptRows.length,
    step_receipts_path: stepReceiptPathRel,
    runtime_mutations_attempted: mutationAttempted,
    runtime_mutations_applied: mutationApplied,
    runtime_mutations_rolled_back: mutationRolledBack,
    runtime_mutation_receipts_path: mutationReceiptPathRel,
    slo: runSlo,
    slo_window: sloWindow,
    results
  };

  ensureDir(RUNS_DIR);
  const runPath = path.join(RUNS_DIR, `${dateStr}.json`);
  writeJsonAtomic(runPath, payload);
  writeJsonAtomic(LATEST_PATH, payload);
  if (payload.dry_run !== true) {
    writeJsonAtomic(LATEST_LIVE_PATH, payload);
  }
  appendJsonl(HISTORY_PATH, {
    ts: payload.ts,
    type: payload.type,
    run_id: payload.run_id,
    date: payload.date,
    dry_run: payload.dry_run,
    runtime_mutation_enabled: payload.runtime_mutation_enabled,
    soul_token_gate: payload.soul_token_gate && typeof payload.soul_token_gate === 'object'
      ? {
          enabled: payload.soul_token_gate.enabled === true,
          checked: payload.soul_token_gate.checked === true,
          verify_ok: payload.soul_token_gate.verify_ok === true,
          shadow_only: payload.soul_token_gate.shadow_only === true,
          forced_shadow: payload.soul_token_gate.forced_shadow === true,
          reason: payload.soul_token_gate.reason || null,
          biometric_forced_shadow: payload.soul_token_gate.payload
            && payload.soul_token_gate.payload.biometric_forced_shadow === true,
          biometric_attestation: payload.soul_token_gate.payload
            && payload.soul_token_gate.payload.biometric_attestation
            && typeof payload.soul_token_gate.payload.biometric_attestation === 'object'
            ? {
                enabled: payload.soul_token_gate.payload.biometric_attestation.enabled === true,
                checked: payload.soul_token_gate.payload.biometric_attestation.checked === true,
                match: payload.soul_token_gate.payload.biometric_attestation.match === true,
                confidence: Number(payload.soul_token_gate.payload.biometric_attestation.confidence || 0),
                reason: payload.soul_token_gate.payload.biometric_attestation.reason || null
              }
            : null
        }
      : null,
    runtime_mutations_applied: payload.runtime_mutations_applied,
    runtime_mutations_rolled_back: payload.runtime_mutations_rolled_back,
    rollout_stage: payload.rollout_stage,
    rollout_canary_fraction: payload.rollout_canary_fraction,
    rollout_last_scale_action: payload.rollout_state_after ? payload.rollout_state_after.last_scale_action : null,
    workflows_selected_initial: payload.workflows_selected_initial,
    workflows_selected: payload.workflows_selected,
    workflows_deferred: payload.workflows_deferred,
    workflows_excluded: payload.workflows_excluded,
    selection_excluded_by_reason: payload.selection_excluded_by_reason || {},
    fallback_applied: payload.fallback_applied === true,
    fallback_reason: payload.fallback_reason || '',
    minimum_selection_applied: payload.minimum_selection_applied === true,
    minimum_selection_reason: payload.minimum_selection_reason || '',
    live_zero_selection_streak: payload.live_zero_selection_streak,
    live_zero_selection_streak_threshold: payload.live_zero_selection_streak_threshold,
    workflows_executed: payload.workflows_executed,
    workflows_succeeded: payload.workflows_succeeded,
    workflows_failed: payload.workflows_failed,
    workflows_blocked: payload.workflows_blocked,
    handled_failures: payload.handled_failures,
    unhandled_failures: payload.unhandled_failures,
    deferred_reasons: payload.deferred_reasons || {},
    token_economics: payload.token_economics && typeof payload.token_economics === 'object'
      ? {
          enabled: payload.token_economics.enabled === true,
          run_token_cap_tokens: Number(payload.token_economics.run_token_cap_tokens || 0),
          predicted_total_tokens: Number(payload.token_economics.predicted_total_tokens || 0),
          enveloped_total_tokens: Number(payload.token_economics.enveloped_total_tokens || 0),
          used_total_tokens: Number(payload.token_economics.used_total_tokens || 0),
          deferred_count: Number(payload.token_economics.deferred_count || 0),
          deferred_by_reason: payload.token_economics.deferred_by_reason || {}
        }
      : null,
    high_value_play: payload.high_value_play && typeof payload.high_value_play === 'object'
      ? {
          ok: payload.high_value_play.ok === true,
          outcomes_recorded: Number(payload.high_value_play.outcomes_recorded || 0),
          false_positive_rate: Number(payload.high_value_play.false_positive_rate || 0),
          false_positive_samples: Number(payload.high_value_play.false_positive_samples || 0)
        }
      : null,
    time_to_first_execution_ms: payload.slo && payload.slo.measured
      ? payload.slo.measured.time_to_first_execution_ms
      : null,
    slo: payload.slo && typeof payload.slo === 'object'
      ? {
          pass: payload.slo.pass === true,
          measured: payload.slo.measured || {},
          checks: payload.slo.checks || {}
        }
      : null,
    slo_window: payload.slo_window && typeof payload.slo_window === 'object'
      ? {
          pass: payload.slo_window.pass === true,
          sufficient_data: payload.slo_window.sufficient_data === true,
          aggregate: payload.slo_window.aggregate || {},
          checks: payload.slo_window.checks || {}
        }
      : null
  });

  const runDegraded = failed > 0
    || blocked > 0
    || (runSlo && runSlo.pass !== true)
    || (sloWindow && sloWindow.sufficient_data === true && sloWindow.pass !== true);
  if (runDegraded) {
    appendSystemHealthEvent({
      severity: failed > 0 ? 'high' : 'medium',
      risk: failed > 0 ? 'high' : 'medium',
      code: blocked > 0 ? 'workflow_executor_blocked' : 'workflow_executor_degraded',
      summary: `workflow executor degraded fail=${failed} blocked=${blocked} slo=${runSlo.pass === true ? 'pass' : 'fail'}`.slice(0, 220),
      run_id: runId,
      date: dateStr,
      dry_run: options.dry_run === true,
      workflows_selected: selected.length,
      workflows_deferred: workflowsDeferred,
      workflows_executed: results.length,
      workflows_succeeded: succeeded,
      workflows_failed: failed,
      workflows_blocked: blocked,
      handled_failures: handledFailures,
      unhandled_failures: unhandledFailures,
      failure_reasons: failureReasons,
      execution_success_rate: runSlo && runSlo.measured ? runSlo.measured.execution_success_rate : null,
      queue_drain_rate: runSlo && runSlo.measured ? runSlo.measured.queue_drain_rate : null,
      time_to_first_execution_ms: runSlo && runSlo.measured ? runSlo.measured.time_to_first_execution_ms : null,
      token_predicted_total: tokenPredictedSelected,
      token_enveloped_total: tokenEnvelopeSelected,
      token_used_total: Number(tokenUsedExecuted.toFixed(2)),
      slo_pass: runSlo ? runSlo.pass === true : null,
      slo_window_pass: sloWindow ? sloWindow.pass === true : null,
      slo_window_sufficient_data: sloWindow ? sloWindow.sufficient_data === true : null
    });
  }

  if (options.dry_run !== true && liveZeroStreak >= liveZeroSelectionThreshold) {
    appendSystemHealthEvent({
      severity: 'high',
      risk: 'high',
      code: 'workflow_executor_zero_selection_streak',
      summary: `workflow executor selected=0 streak=${liveZeroStreak} threshold=${liveZeroSelectionThreshold}`.slice(0, 220),
      run_id: runId,
      date: dateStr,
      workflows_selected: selected.length,
      workflows_deferred: workflowsDeferred,
      workflows_executed: results.length,
      live_zero_selection_streak: liveZeroStreak,
      live_zero_selection_streak_threshold: liveZeroSelectionThreshold
    });
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: payload.type,
    run_id: payload.run_id,
    date: payload.date,
    dry_run: payload.dry_run === true,
    forced_shadow_dry_run: payload.forced_shadow_dry_run === true,
    forced_shadow_soul_token: payload.forced_shadow_soul_token === true,
    workflows_selected_initial: payload.workflows_selected_initial,
    workflows_selected: payload.workflows_selected,
    workflows_deferred: payload.workflows_deferred,
    workflows_excluded: payload.workflows_excluded,
    minimum_selection_applied: payload.minimum_selection_applied === true,
    minimum_selection_reason: payload.minimum_selection_reason || '',
    workflows_executed: payload.workflows_executed,
    workflows_succeeded: payload.workflows_succeeded,
    workflows_failed: payload.workflows_failed,
    workflows_blocked: payload.workflows_blocked,
    handled_failures: payload.handled_failures,
    unhandled_failures: payload.unhandled_failures,
    failure_reasons: payload.failure_reasons || {},
    deferred_reasons: payload.deferred_reasons || {},
    token_run_cap_tokens: payload.token_economics && payload.token_economics.run_token_cap_tokens != null
      ? Number(payload.token_economics.run_token_cap_tokens)
      : 0,
    token_predicted_total: payload.token_economics && payload.token_economics.predicted_total_tokens != null
      ? Number(payload.token_economics.predicted_total_tokens)
      : 0,
    token_enveloped_total: payload.token_economics && payload.token_economics.enveloped_total_tokens != null
      ? Number(payload.token_economics.enveloped_total_tokens)
      : 0,
    token_used_total: payload.token_economics && payload.token_economics.used_total_tokens != null
      ? Number(payload.token_economics.used_total_tokens)
      : 0,
    rollout_stage: payload.rollout_stage,
    rollout_canary_fraction: payload.rollout_canary_fraction,
    rollout_last_scale_action: payload.rollout_state_after ? payload.rollout_state_after.last_scale_action : null,
    execution_success_rate: payload.slo && payload.slo.measured
      ? payload.slo.measured.execution_success_rate
      : null,
    queue_drain_rate: payload.slo && payload.slo.measured
      ? payload.slo.measured.queue_drain_rate
      : null,
    time_to_first_execution_ms: payload.slo && payload.slo.measured
      ? payload.slo.measured.time_to_first_execution_ms
      : null,
    slo_pass: payload.slo ? payload.slo.pass === true : false,
    slo_window_pass: payload.slo_window ? payload.slo_window.pass === true : false,
    runtime_mutation_enabled: payload.runtime_mutation_enabled,
    soul_token_gate: payload.soul_token_gate && typeof payload.soul_token_gate === 'object'
      ? {
          enabled: payload.soul_token_gate.enabled === true,
          checked: payload.soul_token_gate.checked === true,
          verify_ok: payload.soul_token_gate.verify_ok === true,
          shadow_only: payload.soul_token_gate.shadow_only === true,
          forced_shadow: payload.soul_token_gate.forced_shadow === true,
          reason: payload.soul_token_gate.reason || null,
          biometric_forced_shadow: payload.soul_token_gate.payload
            && payload.soul_token_gate.payload.biometric_forced_shadow === true,
          biometric_attestation: payload.soul_token_gate.payload
            && payload.soul_token_gate.payload.biometric_attestation
            && typeof payload.soul_token_gate.payload.biometric_attestation === 'object'
            ? {
                enabled: payload.soul_token_gate.payload.biometric_attestation.enabled === true,
                checked: payload.soul_token_gate.payload.biometric_attestation.checked === true,
                match: payload.soul_token_gate.payload.biometric_attestation.match === true,
                confidence: Number(payload.soul_token_gate.payload.biometric_attestation.confidence || 0),
                reason: payload.soul_token_gate.payload.biometric_attestation.reason || null
              }
            : null
        }
      : null,
    runtime_mutations_applied: payload.runtime_mutations_applied,
    runtime_mutations_rolled_back: payload.runtime_mutations_rolled_back,
    live_zero_selection_streak: payload.live_zero_selection_streak,
    live_zero_selection_streak_threshold: payload.live_zero_selection_streak_threshold,
    run_path: relPath(runPath),
    latest_path: relPath(LATEST_PATH),
    latest_live_path: relPath(LATEST_LIVE_PATH)
  })}\n`);
}

function statusCmd(dateArg: string) {
  const key = String(dateArg || 'latest').trim().toLowerCase();
  const payload = key === 'latest'
    ? readJson(LATEST_PATH, null)
    : key === 'latest-live' || key === 'latest_live'
      ? readJson(LATEST_LIVE_PATH, null)
      : readJson(path.join(RUNS_DIR, `${dateArgOrToday(key)}.json`), null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'workflow_executor_status',
      error: 'workflow_executor_snapshot_missing'
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'workflow_executor_status',
    ts: payload.ts || null,
    run_id: payload.run_id || null,
    date: payload.date || null,
    dry_run: payload.dry_run === true,
    rollout_stage: payload.rollout_stage || null,
    rollout_canary_fraction: payload.rollout_canary_fraction == null ? null : Number(payload.rollout_canary_fraction),
    rollout_last_scale_action: payload.rollout_state_after ? payload.rollout_state_after.last_scale_action || null : null,
    runtime_mutation_enabled: payload.runtime_mutation_enabled === true,
    soul_token_gate: payload.soul_token_gate && typeof payload.soul_token_gate === 'object'
      ? {
          enabled: payload.soul_token_gate.enabled === true,
          checked: payload.soul_token_gate.checked === true,
          verify_ok: payload.soul_token_gate.verify_ok === true,
          shadow_only: payload.soul_token_gate.shadow_only === true,
          forced_shadow: payload.soul_token_gate.forced_shadow === true,
          reason: payload.soul_token_gate.reason || null,
          biometric_forced_shadow: payload.soul_token_gate.payload
            && payload.soul_token_gate.payload.biometric_forced_shadow === true,
          biometric_attestation: payload.soul_token_gate.payload
            && payload.soul_token_gate.payload.biometric_attestation
            && typeof payload.soul_token_gate.payload.biometric_attestation === 'object'
            ? {
                enabled: payload.soul_token_gate.payload.biometric_attestation.enabled === true,
                checked: payload.soul_token_gate.payload.biometric_attestation.checked === true,
                match: payload.soul_token_gate.payload.biometric_attestation.match === true,
                confidence: Number(payload.soul_token_gate.payload.biometric_attestation.confidence || 0),
                reason: payload.soul_token_gate.payload.biometric_attestation.reason || null
              }
            : null
        }
      : null,
    runtime_mutations_applied: Number(payload.runtime_mutations_applied || 0),
    runtime_mutations_rolled_back: Number(payload.runtime_mutations_rolled_back || 0),
    workflows_selected_initial: Number(payload.workflows_selected_initial || payload.workflows_selected || 0),
    workflows_selected: Number(payload.workflows_selected || 0),
    workflows_deferred: Number(payload.workflows_deferred || 0),
    workflows_excluded: Number(payload.workflows_excluded || 0),
    selection_excluded_by_reason: payload.selection_excluded_by_reason && typeof payload.selection_excluded_by_reason === 'object'
      ? payload.selection_excluded_by_reason
      : {},
    fallback_applied: payload.fallback_applied === true,
    fallback_reason: payload.fallback_reason || '',
    minimum_selection_applied: payload.minimum_selection_applied === true,
    minimum_selection_reason: payload.minimum_selection_reason || '',
    workflows_executed: Number(payload.workflows_executed || 0),
    workflows_succeeded: Number(payload.workflows_succeeded || 0),
    workflows_failed: Number(payload.workflows_failed || 0),
    workflows_blocked: Number(payload.workflows_blocked || 0),
    handled_failures: Number(payload.handled_failures || 0),
    unhandled_failures: Number(payload.unhandled_failures || 0),
    failure_reasons: payload.failure_reasons && typeof payload.failure_reasons === 'object'
      ? payload.failure_reasons
      : {},
    deferred_reasons: payload.deferred_reasons && typeof payload.deferred_reasons === 'object'
      ? payload.deferred_reasons
      : {},
    token_economics: payload.token_economics && typeof payload.token_economics === 'object'
      ? payload.token_economics
      : null,
    execution_success_rate: payload.slo && payload.slo.measured
      ? Number(payload.slo.measured.execution_success_rate || 0)
      : Number(safeRate(payload.workflows_succeeded, payload.workflows_executed, 0).toFixed(4)),
    queue_drain_rate: payload.slo && payload.slo.measured
      ? Number(payload.slo.measured.queue_drain_rate || 0)
      : Number(safeRate(payload.workflows_executed, payload.workflows_selected, 0).toFixed(4)),
    time_to_first_execution_ms: payload.slo && payload.slo.measured
      ? payload.slo.measured.time_to_first_execution_ms
      : null,
    live_zero_selection_streak: payload.live_zero_selection_streak == null
      ? null
      : Number(payload.live_zero_selection_streak),
    live_zero_selection_streak_threshold: payload.live_zero_selection_streak_threshold == null
      ? null
      : Number(payload.live_zero_selection_streak_threshold),
    slo_pass: payload.slo ? payload.slo.pass === true : false,
    slo_window_pass: payload.slo_window ? payload.slo_window.pass === true : false,
    slo_window_sufficient_data: payload.slo_window ? payload.slo_window.sufficient_data === true : false
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
    appendSystemHealthEvent({
      severity: 'critical',
      risk: 'high',
      code: 'workflow_executor_fatal',
      summary: 'workflow executor crashed',
      details: String(err && err.message ? err.message : err || 'workflow_executor_failed').slice(0, 240)
    });
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'workflow_executor',
      error: String(err && err.message ? err.message : err || 'workflow_executor_failed')
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  normalizeStep,
  estimateStepTokens,
  estimateWorkflowTokens,
  planTokenEconomics,
  executeStep,
  executeWorkflow,
  selectWorkflows,
  loadPolicy,
  main
};
