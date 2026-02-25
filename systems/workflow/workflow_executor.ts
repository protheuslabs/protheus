#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadRegistry } = require('./workflow_controller');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = process.env.WORKFLOW_EXECUTOR_RUNS_DIR
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_RUNS_DIR)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'executor', 'runs');
const HISTORY_PATH = process.env.WORKFLOW_EXECUTOR_HISTORY_PATH
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_HISTORY_PATH)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'executor', 'history.jsonl');
const LATEST_PATH = process.env.WORKFLOW_EXECUTOR_LATEST_PATH
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_LATEST_PATH)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'executor', 'latest.json');
const EXEC_CWD = process.env.WORKFLOW_EXECUTOR_CWD
  ? path.resolve(process.env.WORKFLOW_EXECUTOR_CWD)
  : REPO_ROOT;

function usage() {
  console.log('Usage:');
  console.log('  node systems/workflow/workflow_executor.js run [YYYY-MM-DD] [--id=<workflow_id>] [--max=N] [--include-draft=1|0] [--dry-run=1|0] [--continue-on-error=1|0] [--receipt-strict=1|0]');
  console.log('  node systems/workflow/workflow_executor.js status [YYYY-MM-DD|latest]');
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

function nowIso() {
  return new Date().toISOString();
}

function dateArgOrToday(v) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function boolFlag(v, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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

function normalizeStep(rawStep, index = 0) {
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

function interpolateTemplate(input, context) {
  const str = String(input == null ? '' : input);
  return str
    .replace(/<date>/g, String(context.date || ''))
    .replace(/<workflow_id>/g, String(context.workflow_id || ''))
    .replace(/<step_id>/g, String(context.step_id || ''))
    .replace(/<run_id>/g, String(context.run_id || ''));
}

function runCommandShell(command, timeoutMs, env, cwd) {
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

function resolveReceiptPath(stepCommand, context) {
  const templated = interpolateTemplate(stepCommand, context);
  if (!templated) return '';
  if (path.isAbsolute(templated)) return templated;
  return path.resolve(EXEC_CWD, templated);
}

function executeStep(step, context, options) {
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

function selectWorkflows(registry, args) {
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

function executeWorkflow(workflow, context, options) {
  const started = Date.now();
  const steps = Array.isArray(workflow && workflow.steps)
    ? workflow.steps.map((row, i) => normalizeStep(row, i))
    : [];
  const stepResults = [];
  let ok = true;
  let blockedByGate = false;
  let stoppedStep = null;

  for (const step of steps) {
    const stepResult = executeStep(step, {
      ...context,
      step_id: step.id
    }, options);
    stepResults.push(stepResult);
    if (stepResult.ok === true) continue;
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
    step_results: stepResults
  };
}

function runCmd(dateStr, args) {
  const runId = `wfexec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const options = {
    dry_run: boolFlag(args['dry-run'], false),
    continue_on_error: boolFlag(args['continue-on-error'], false),
    receipt_strict: boolFlag(args['receipt-strict'], true)
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
  const payload = {
    ok: true,
    type: 'workflow_executor_run',
    ts: nowIso(),
    run_id: runId,
    date: dateStr,
    dry_run: options.dry_run === true,
    continue_on_error: options.continue_on_error === true,
    receipt_strict: options.receipt_strict === true,
    registry_total: Array.isArray(registry && registry.workflows) ? registry.workflows.length : 0,
    workflows_selected: selected.length,
    workflows_executed: results.length,
    workflows_succeeded: succeeded,
    workflows_failed: failed,
    workflows_blocked: blocked,
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
    run_path: relPath(runPath),
    latest_path: relPath(LATEST_PATH)
  })}\n`);
}

function statusCmd(dateArg) {
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
  main
};
