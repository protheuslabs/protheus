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
const MUTATION_RECEIPTS_DIR = process.env.WORKFLOW_EXECUTOR_MUTATION_RECEIPTS_DIR
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_MUTATION_RECEIPTS_DIR)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'executor', 'mutations');
const EXEC_CWD = process.env.WORKFLOW_EXECUTOR_CWD
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_CWD)
  : REPO_ROOT;

function usage() {
  console.log('Usage:');
  console.log('  node systems/workflow/workflow_executor.js run [YYYY-MM-DD] [--id=<workflow_id>] [--max=N] [--include-draft=1|0] [--dry-run=1|0] [--continue-on-error=1|0] [--receipt-strict=1|0] [--runtime-mutation=1|0] [--policy=path]');
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

function defaultPolicy() {
  return {
    version: '1.0',
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
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const rm = raw && raw.runtime_mutation && typeof raw.runtime_mutation === 'object'
    ? raw.runtime_mutation
    : {};
  const allowRaw = rm && rm.allow && typeof rm.allow === 'object' ? rm.allow : {};
  return {
    version: cleanText(raw.version || base.version, 24) || '1.0',
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
    }
  };
}

function normalizeStep(rawStep: AnyObj, index = 0) {
  const src = rawStep && typeof rawStep === 'object' ? rawStep : {};
  const fallbackId = `step_${index + 1}`;
  const id = String(src.id || fallbackId).trim() || fallbackId;
  const typeRaw = String(src.type || 'command').trim().toLowerCase();
  const type = typeRaw === 'gate' || typeRaw === 'receipt' ? typeRaw : 'command';
  return {
    id,
    type,
    command: String(src.command || '').trim(),
    purpose: String(src.purpose || '').trim(),
    timeout_ms: clampInt(src.timeout_ms, 500, 30 * 60 * 1000, 120000),
    retries: clampInt(src.retries, 0, 8, 0)
  };
}

function interpolateTemplate(input: unknown, context: AnyObj) {
  const str = String(input == null ? '' : input);
  return str
    .replace(/<date>/g, String(context.date || ''))
    .replace(/<workflow_id>/g, String(context.workflow_id || ''))
    .replace(/<step_id>/g, String(context.step_id || ''))
    .replace(/<run_id>/g, String(context.run_id || ''));
}

function runCommandShell(command: string, timeoutMs: number, env: AnyObj, cwd: string) {
  const started = Date.now();
  const result = spawnSync(command, {
    shell: true,
    cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  const durationMs = Date.now() - started;
  const exitCode = Number(result && result.status);
  const timedOut = !!(result && result.error && String(result.error.code || '') === 'ETIMEDOUT');
  const ok = Number.isInteger(exitCode) ? exitCode === 0 : (!timedOut && !result.error && !result.signal);
  return {
    ok,
    exit_code: Number.isFinite(exitCode) ? exitCode : null,
    signal: result && result.signal ? String(result.signal) : null,
    timed_out: timedOut,
    duration_ms: durationMs,
    stdout: String(result && result.stdout || '').trim().slice(0, 2000),
    stderr: String(result && result.stderr || '').trim().slice(0, 2000),
    error: result && result.error ? String(result.error.message || result.error) : null
  };
}

function resolveReceiptPath(stepCommand: string, context: AnyObj) {
  const templated = interpolateTemplate(stepCommand, context);
  if (!templated) return '';
  if (path.isAbsolute(templated)) return templated;
  return path.resolve(EXEC_CWD, templated);
}

function executeStep(step: AnyObj, context: AnyObj, options: AnyObj) {
  const command = interpolateTemplate(step.command, context);
  const maxAttempts = Math.max(1, Number(step.retries || 0) + 1);
  const records = [];
  const env = {
    ...process.env,
    WORKFLOW_RUN_ID: String(context.run_id || ''),
    WORKFLOW_ID: String(context.workflow_id || ''),
    WORKFLOW_STEP_ID: String(step.id || ''),
    WORKFLOW_DATE: String(context.date || '')
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
      records: []
    };
  }

  if (step.type === 'receipt') {
    const receiptPath = resolveReceiptPath(step.command, context);
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
        exit_code: exists ? 0 : 1,
        duration_ms: 0,
        timed_out: false,
        stdout: '',
        stderr: exists ? '' : 'receipt_missing',
        error: null
      }],
      receipt_path: receiptPath,
      receipt_exists: exists
    };
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const run = runCommandShell(command, step.timeout_ms, env, EXEC_CWD);
    records.push({
      attempt,
      ...run
    });
    if (run.ok) {
      return {
        ok: true,
        attempts: attempt,
        dry_run: false,
        step: {
          id: step.id,
          type: step.type,
          command
        },
        records
      };
    }
  }

  return {
    ok: false,
    attempts: records.length,
    dry_run: false,
    step: {
      id: step.id,
      type: step.type,
      command
    },
    records
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
    command: String(row && row.command || '')
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

function selectWorkflows(registry: AnyObj, args: AnyObj) {
  const rows = Array.isArray(registry && registry.workflows) ? registry.workflows.slice() : [];
  const max = clampInt(args.max, 1, 256, 8);
  const includeDraft = boolFlag(args['include-draft'], false);
  const explicitId = String(args.id || '').trim();
  let selected = rows.filter((row) => {
    const status = String(row && row.status || '').toLowerCase();
    if (explicitId) return String(row && row.id || '') === explicitId;
    if (status === 'active') return true;
    if (includeDraft && status === 'draft') return true;
    return false;
  });
  selected = selected
    .sort((a, b) => String(b && b.updated_at || '').localeCompare(String(a && a.updated_at || '')))
    .slice(0, max);
  return selected;
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
  let ok = true;
  let blockedByGate = false;
  let stoppedStep = null;
  let cursor = 0;

  const runtimeMutation = options && options.runtime_mutation && typeof options.runtime_mutation === 'object'
    ? options.runtime_mutation
    : defaultPolicy().runtime_mutation;
  const runMutationState = options && options._run_mutation_state && typeof options._run_mutation_state === 'object'
    ? options._run_mutation_state
    : { total_mutations: 0 };

  while (cursor < steps.length) {
    const step = steps[cursor];
    const stepResult = executeStep(step, {
      ...context,
      step_id: step && step.id ? step.id : `step_${cursor + 1}`
    }, options);
    stepResults.push(stepResult);
    if (stepResult.ok === true) {
      cursor += 1;
      continue;
    }

    let recovered = false;
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

    if (recovered === true) continue;

    ok = false;
    stoppedStep = step.id;
    if (step.type === 'gate') blockedByGate = true;
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
    started_at: new Date(started).toISOString(),
    ended_at: new Date(ended).toISOString(),
    duration_ms: ended - started,
    step_count: steps.length,
    step_results: stepResults,
    mutation_summary: mutationSummary,
    mutation_receipts: mutationReceipts
  };
}

function runCmd(dateStr: string, args: AnyObj) {
  const runId = `wfexec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const policyPath = path.resolve(String(args.policy || process.env.WORKFLOW_EXECUTOR_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const options = {
    dry_run: boolFlag(args['dry-run'], false),
    continue_on_error: boolFlag(args['continue-on-error'], false),
    receipt_strict: boolFlag(args['receipt-strict'], true),
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
  const selected = selectWorkflows(registry, args);
  const results = [];

  for (const workflow of selected) {
    const result = executeWorkflow(workflow, {
      run_id: runId,
      date: dateStr,
      workflow_id: String(workflow && workflow.id || '')
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
  for (const row of results) {
    const receipts = Array.isArray(row && row.mutation_receipts) ? row.mutation_receipts : [];
    for (const rec of receipts) mutationRows.push(rec);
  }

  let mutationReceiptPathRel = null;
  if (mutationRows.length && options.dry_run !== true) {
    ensureDir(MUTATION_RECEIPTS_DIR);
    const mutationReceiptPath = path.join(MUTATION_RECEIPTS_DIR, `${dateStr}.jsonl`);
    for (const rec of mutationRows) appendJsonl(mutationReceiptPath, rec);
    mutationReceiptPathRel = relPath(mutationReceiptPath);
  }

  const payload = {
    ok: true,
    type: 'workflow_executor_run',
    ts: nowIso(),
    run_id: runId,
    date: dateStr,
    dry_run: options.dry_run === true,
    continue_on_error: options.continue_on_error === true,
    receipt_strict: options.receipt_strict === true,
    runtime_mutation_enabled: options.runtime_mutation.enabled === true,
    runtime_mutation_policy_path: relPath(policyPath),
    registry_total: Array.isArray(registry && registry.workflows) ? registry.workflows.length : 0,
    workflows_selected: selected.length,
    workflows_executed: results.length,
    workflows_succeeded: succeeded,
    workflows_failed: failed,
    workflows_blocked: blocked,
    runtime_mutations_attempted: mutationAttempted,
    runtime_mutations_applied: mutationApplied,
    runtime_mutations_rolled_back: mutationRolledBack,
    runtime_mutation_receipts_path: mutationReceiptPathRel,
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
    workflows_selected: payload.workflows_selected,
    workflows_executed: payload.workflows_executed,
    workflows_succeeded: payload.workflows_succeeded,
    workflows_failed: payload.workflows_failed,
    workflows_blocked: payload.workflows_blocked
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: payload.type,
    run_id: payload.run_id,
    date: payload.date,
    workflows_selected: payload.workflows_selected,
    workflows_executed: payload.workflows_executed,
    workflows_succeeded: payload.workflows_succeeded,
    workflows_failed: payload.workflows_failed,
    workflows_blocked: payload.workflows_blocked,
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
    runtime_mutation_enabled: payload.runtime_mutation_enabled === true,
    runtime_mutations_applied: Number(payload.runtime_mutations_applied || 0),
    runtime_mutations_rolled_back: Number(payload.runtime_mutations_rolled_back || 0),
    workflows_selected: Number(payload.workflows_selected || 0),
    workflows_executed: Number(payload.workflows_executed || 0),
    workflows_succeeded: Number(payload.workflows_succeeded || 0),
    workflows_failed: Number(payload.workflows_failed || 0),
    workflows_blocked: Number(payload.workflows_blocked || 0)
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
