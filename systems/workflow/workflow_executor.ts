#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadRegistry } = require('./workflow_controller');

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
const ROLLOUT_STATE_PATH = process.env.WORKFLOW_EXECUTOR_ROLLOUT_STATE_PATH
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_ROLLOUT_STATE_PATH)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'executor', 'rollout_state.json');
const STEP_RECEIPTS_DIR = process.env.WORKFLOW_EXECUTOR_STEP_RECEIPTS_DIR
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_STEP_RECEIPTS_DIR)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'executor', 'step_receipts');
const MUTATION_RECEIPTS_DIR = process.env.WORKFLOW_EXECUTOR_MUTATION_RECEIPTS_DIR
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_MUTATION_RECEIPTS_DIR)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'executor', 'mutations');
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

function usage() {
  console.log('Usage:');
  console.log('  node systems/workflow/workflow_executor.js run [YYYY-MM-DD] [--id=<workflow_id>] [--max=N] [--include-draft=1|0] [--dry-run=1|0] [--continue-on-error=1|0] [--receipt-strict=1|0] [--runtime-mutation=1|0] [--enforce-eligibility=1|0] [--policy=path]');
  console.log('  node systems/workflow/workflow_executor.js status [YYYY-MM-DD|latest]');
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
      demote_shadow_on_floor_breach: true
    },
    slo: {
      min_execution_success_rate: 0.9,
      min_queue_drain_rate: 0.75,
      max_time_to_first_execution_ms: 180000,
      lookback_runs: 6,
      min_runs_for_decision: 3
    },
    runtime_mutation: {
      enabled: true,
      max_mutations_per_run: 8,
      max_mutations_per_workflow: 2,
      retry_after_apply: true,
      rollback_on_regression: true,
      max_retry_increment: 1,
      max_total_retry_per_step: 3,
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
  const rm = raw && raw.runtime_mutation && typeof raw.runtime_mutation === 'object'
    ? raw.runtime_mutation
    : {};
  const stepRuntime = raw && raw.step_runtime && typeof raw.step_runtime === 'object'
    ? raw.step_runtime
    : {};
  const external = raw && raw.external_orchestration && typeof raw.external_orchestration === 'object'
    ? raw.external_orchestration
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
      demote_shadow_on_floor_breach: rollout.demote_shadow_on_floor_breach !== false
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
    }
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
  return {
    attempts,
    retries,
    duration_ms: durationMs
  };
}

function projectedStepBudget(step: AnyObj) {
  const attempts = Math.max(1, Number(step && step.retries || 0) + 1);
  const retries = Math.max(0, attempts - 1);
  const timeoutMs = Math.max(0, Number(step && step.timeout_ms || 0));
  return {
    attempts,
    retries,
    duration_ms: timeoutMs * attempts
  };
}

function checkBudgetPreflight(step: AnyObj, budgetState: AnyObj, budgetPolicy: AnyObj) {
  const projected = projectedStepBudget(step);
  const attemptsCap = Math.max(0, Number(budgetPolicy && budgetPolicy.max_total_attempts_per_workflow || 0));
  const retryCap = Math.max(0, Number(budgetPolicy && budgetPolicy.max_total_retry_attempts_per_workflow || 0));
  const durationCap = Math.max(0, Number(budgetPolicy && budgetPolicy.max_total_step_duration_ms_per_workflow || 0));
  if (attemptsCap > 0 && (Number(budgetState && budgetState.attempts_used || 0) + projected.attempts) > attemptsCap) {
    return 'attempt_budget_exceeded_precheck';
  }
  if (retryCap > 0 && (Number(budgetState && budgetState.retries_used || 0) + projected.retries) > retryCap) {
    return 'retry_budget_exceeded_precheck';
  }
  if (durationCap > 0 && (Number(budgetState && budgetState.duration_ms_used || 0) + projected.duration_ms) > durationCap) {
    return 'duration_budget_exceeded_precheck';
  }
  return null;
}

function checkBudgetPostStep(budgetState: AnyObj, budgetPolicy: AnyObj) {
  const attemptsCap = Math.max(0, Number(budgetPolicy && budgetPolicy.max_total_attempts_per_workflow || 0));
  const retryCap = Math.max(0, Number(budgetPolicy && budgetPolicy.max_total_retry_attempts_per_workflow || 0));
  const durationCap = Math.max(0, Number(budgetPolicy && budgetPolicy.max_total_step_duration_ms_per_workflow || 0));
  if (attemptsCap > 0 && Number(budgetState && budgetState.attempts_used || 0) > attemptsCap) {
    return 'attempt_budget_exceeded';
  }
  if (retryCap > 0 && Number(budgetState && budgetState.retries_used || 0) > retryCap) {
    return 'retry_budget_exceeded';
  }
  if (durationCap > 0 && Number(budgetState && budgetState.duration_ms_used || 0) > durationCap) {
    return 'duration_budget_exceeded';
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
  const externalGate = evaluateExternalOrchestrationGate(step, command, executionContext, options);
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
        exit_code: 1,
        started_at: ts,
        ended_at: ts,
        duration_ms: 0,
        timed_out: false,
        stdout: '',
        stderr: reason,
        error: null
      }],
      success_criteria: criteria,
      failure_reason: reason,
      external_gate: externalGate
    };
  }
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
      success_criteria: criteria,
      external_gate: externalGate && externalGate.applicable === true ? externalGate : null
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
      success_criteria: criteria,
      failure_reason: ok ? null : 'receipt_missing',
      external_gate: externalGate && externalGate.applicable === true ? externalGate : null
    };
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const run = runCommandShell(command, step.timeout_ms, env, EXEC_CWD);
    const evalResult = evaluateStepSuccess(run, step, options && options.policy ? options.policy : {});
    records.push({
      attempt,
      ...run,
      criteria_pass: evalResult.pass === true,
      criteria_fail_reasons: evalResult.reasons
    });
    if (evalResult.pass === true) {
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
        success_criteria: evalResult.criteria,
        failure_reason: null,
        external_gate: externalGate && externalGate.applicable === true ? externalGate : null
      };
    }
  }

  const last = records.length ? records[records.length - 1] : null;
  const failReasons = Array.isArray(last && last.criteria_fail_reasons) ? last.criteria_fail_reasons : [];
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
    success_criteria: criteria,
    failure_reason: failReasons.length ? String(failReasons[0]) : 'step_failed',
    external_gate: externalGate && externalGate.applicable === true ? externalGate : null
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
  return order.filter((kind) => Number(attempts[kind] || 0) < 3);
}

function applyMutationKind(kind: string, steps: AnyObj[], stepIndex: number, policy: AnyObj) {
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
  const includeDraft = boolFlag(args['include-draft'], false);
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

  return {
    selected,
    excluded,
    stage,
    canary_fraction: Number(canaryFraction.toFixed(6)),
    enforce_eligibility: enforceEligibility
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
  const executionBudget = {
    attempts_cap: Number(stepRuntime.max_total_attempts_per_workflow || 0),
    retries_cap: Number(stepRuntime.max_total_retry_attempts_per_workflow || 0),
    duration_cap_ms: Number(stepRuntime.max_total_step_duration_ms_per_workflow || 0),
    attempts_used: 0,
    retries_used: 0,
    duration_ms_used: 0
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
    const preflightBudgetReason = checkBudgetPreflight(step, executionBudget, stepRuntime);
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
    const canMutate = options.dry_run !== true
      && runtimeMutation.enabled === true
      && Number(runMutationState.total_mutations || 0) < Number(runtimeMutation.max_mutations_per_run || 0)
      && Number(mutationSummary.applied || 0) < Number(runtimeMutation.max_mutations_per_workflow || 0);

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
      attempts_used: executionBudget.attempts_used,
      retries_used: executionBudget.retries_used,
      duration_ms_used: executionBudget.duration_ms_used
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

function historicalSloRows(historyRows: AnyObj[]) {
  const out = [];
  for (const row of Array.isArray(historyRows) ? historyRows : []) {
    if (!row || typeof row !== 'object') continue;
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
  const prior = historicalSloRows(historyRows).slice(-Math.max(0, lookback - 1));
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

function nextRolloutState(current: AnyObj, policy: AnyObj, scalePass: boolean, scaleEligible: boolean) {
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
  const stageForcedDryRun = rolloutEnabled
    && stage === 'shadow'
    && policy.rollout.shadow_dry_run === true
    && !dryRunArgPresent;
  const effectiveDryRun = dryRunArgValue || stageForcedDryRun;
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
    _run_mutation_state: {
      total_mutations: 0
    }
  };

  const registry = loadRegistry();
  const selection = selectWorkflows(registry, args, policy, rolloutState, `${runId}|${dateStr}`);
  const selected = Array.isArray(selection && selection.selected) ? selection.selected : [];
  const results = [];

  for (const workflow of selected) {
    const workflowMeta = workflow && workflow.metadata && typeof workflow.metadata === 'object'
      ? workflow.metadata
      : {};
    const result = executeWorkflow(workflow, {
      run_id: runId,
      date: dateStr,
      workflow_id: String(workflow && workflow.id || ''),
      objective_id: String(workflow && workflow.objective_id || ''),
      eye_id: String(workflow && workflow.trigger && workflow.trigger.eye_id || workflow && workflow.eye_id || ''),
      adapter: cleanText(workflowMeta.adapter || '', 80) || '',
      provider: cleanText(workflowMeta.provider || '', 80).toLowerCase() || '',
      policy_root_lease_token: cleanText(
        args['lease-token'] || args.lease_token || process.env.CAPABILITY_LEASE_TOKEN || '',
        8192
      ),
      policy_root_approval_note: cleanText(
        args['approval-note'] || args.approval_note || process.env.WORKFLOW_EXECUTOR_POLICY_ROOT_APPROVAL_NOTE || '',
        320
      )
    }, options);
    results.push(result);
    if (result.ok !== true && options.continue_on_error !== true) break;
  }

  const succeeded = results.filter((row) => row && row.ok === true).length;
  const failed = results.filter((row) => row && row.ok !== true).length;
  const blocked = results.filter((row) => row && row.blocked_by_gate === true).length;
  const mutationAttempted = results.reduce((sum, row) => sum + Number(row && row.mutation_summary && row.mutation_summary.attempted || 0), 0);
  const mutationApplied = results.reduce((sum, row) => sum + Number(row && row.mutation_summary && row.mutation_summary.applied || 0), 0);
  const mutationRolledBack = results.reduce((sum, row) => sum + Number(row && row.mutation_summary && row.mutation_summary.rolled_back || 0), 0);

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
        external_gate: step && step.external_gate && typeof step.external_gate === 'object'
          ? step.external_gate
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
  const scaleEligible = options.dry_run !== true;
  const scalePass = sloWindow.sufficient_data === true
    ? sloWindow.pass === true
    : runSlo.pass === true;
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
  const rolloutAfter = nextRolloutState(rolloutState, policy, scalePass, scaleEligible);
  saveRolloutState(rolloutAfter);

  const payload = {
    ok: true,
    type: 'workflow_executor_run',
    ts: nowIso(),
    run_id: runId,
    date: dateStr,
    dry_run: options.dry_run === true,
    forced_shadow_dry_run: stageForcedDryRun === true,
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
    workflows_selected: selected.length,
    workflows_excluded: Array.isArray(selection && selection.excluded) ? selection.excluded.length : 0,
    selection_excluded: Array.isArray(selection && selection.excluded) ? selection.excluded : [],
    enforce_eligibility: selection && selection.enforce_eligibility === true,
    workflows_executed: results.length,
    workflows_succeeded: succeeded,
    workflows_failed: failed,
    workflows_blocked: blocked,
    failure_reasons: failureReasons,
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
  appendJsonl(HISTORY_PATH, {
    ts: payload.ts,
    type: payload.type,
    run_id: payload.run_id,
    date: payload.date,
    dry_run: payload.dry_run,
    runtime_mutation_enabled: payload.runtime_mutation_enabled,
    runtime_mutations_applied: payload.runtime_mutations_applied,
    runtime_mutations_rolled_back: payload.runtime_mutations_rolled_back,
    rollout_stage: payload.rollout_stage,
    rollout_canary_fraction: payload.rollout_canary_fraction,
    rollout_last_scale_action: payload.rollout_state_after ? payload.rollout_state_after.last_scale_action : null,
    workflows_selected: payload.workflows_selected,
    workflows_excluded: payload.workflows_excluded,
    workflows_executed: payload.workflows_executed,
    workflows_succeeded: payload.workflows_succeeded,
    workflows_failed: payload.workflows_failed,
    workflows_blocked: payload.workflows_blocked,
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

  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: payload.type,
    run_id: payload.run_id,
    date: payload.date,
    workflows_selected: payload.workflows_selected,
    workflows_excluded: payload.workflows_excluded,
    workflows_executed: payload.workflows_executed,
    workflows_succeeded: payload.workflows_succeeded,
    workflows_failed: payload.workflows_failed,
    workflows_blocked: payload.workflows_blocked,
    failure_reasons: payload.failure_reasons || {},
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
    runtime_mutations_applied: payload.runtime_mutations_applied,
    runtime_mutations_rolled_back: payload.runtime_mutations_rolled_back,
    run_path: relPath(runPath),
    latest_path: relPath(LATEST_PATH)
  })}\n`);
}

function statusCmd(dateArg: string) {
  const key = String(dateArg || 'latest').trim().toLowerCase();
  const payload = key === 'latest'
    ? readJson(LATEST_PATH, null)
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
    runtime_mutations_applied: Number(payload.runtime_mutations_applied || 0),
    runtime_mutations_rolled_back: Number(payload.runtime_mutations_rolled_back || 0),
    workflows_selected: Number(payload.workflows_selected || 0),
    workflows_excluded: Number(payload.workflows_excluded || 0),
    workflows_executed: Number(payload.workflows_executed || 0),
    workflows_succeeded: Number(payload.workflows_succeeded || 0),
    workflows_failed: Number(payload.workflows_failed || 0),
    workflows_blocked: Number(payload.workflows_blocked || 0),
    failure_reasons: payload.failure_reasons && typeof payload.failure_reasons === 'object'
      ? payload.failure_reasons
      : {},
    execution_success_rate: payload.slo && payload.slo.measured
      ? Number(payload.slo.measured.execution_success_rate || 0)
      : Number(safeRate(payload.workflows_succeeded, payload.workflows_executed, 0).toFixed(4)),
    queue_drain_rate: payload.slo && payload.slo.measured
      ? Number(payload.slo.measured.queue_drain_rate || 0)
      : Number(safeRate(payload.workflows_executed, payload.workflows_selected, 0).toFixed(4)),
    time_to_first_execution_ms: payload.slo && payload.slo.measured
      ? payload.slo.measured.time_to_first_execution_ms
      : null,
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
  executeStep,
  executeWorkflow,
  selectWorkflows,
  loadPolicy,
  main
};
