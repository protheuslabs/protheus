#!/usr/bin/env node
'use strict';
export {};

/**
 * Workflow execution closure tracker (RM-113).
 *
 * Proves closure on the "all signal, no action" gap by tracking consecutive
 * daily passes where BOTH conditions hold:
 * - accepted_items >= min_accepted_items
 * - workflows_executed >= min_workflows_executed
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.WORKFLOW_EXECUTION_CLOSURE_POLICY_PATH
  ? path.resolve(process.env.WORKFLOW_EXECUTION_CLOSURE_POLICY_PATH)
  : path.join(ROOT, 'config', 'workflow_execution_closure_policy.json');
const DEFAULT_STATE_PATH = process.env.WORKFLOW_EXECUTION_CLOSURE_STATE_PATH
  ? path.resolve(process.env.WORKFLOW_EXECUTION_CLOSURE_STATE_PATH)
  : path.join(ROOT, 'state', 'ops', 'workflow_execution_closure.json');
const DEFAULT_HISTORY_PATH = process.env.WORKFLOW_EXECUTION_CLOSURE_HISTORY_PATH
  ? path.resolve(process.env.WORKFLOW_EXECUTION_CLOSURE_HISTORY_PATH)
  : path.join(ROOT, 'state', 'ops', 'workflow_execution_closure_history.jsonl');
const DEFAULT_PROPOSALS_DIR = process.env.WORKFLOW_EXECUTION_CLOSURE_PROPOSALS_DIR
  ? path.resolve(process.env.WORKFLOW_EXECUTION_CLOSURE_PROPOSALS_DIR)
  : path.join(ROOT, 'state', 'sensory', 'eyes', 'proposals');
const DEFAULT_WORKFLOW_RUNS_DIR = process.env.WORKFLOW_EXECUTION_CLOSURE_RUNS_DIR
  ? path.resolve(process.env.WORKFLOW_EXECUTION_CLOSURE_RUNS_DIR)
  : path.join(ROOT, 'state', 'adaptive', 'workflows', 'executor', 'runs');

type AnyObj = Record<string, any>;

function nowIso() {
  return new Date().toISOString();
}

function todayUtc() {
  return nowIso().slice(0, 10);
}

function toDate(raw: unknown) {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return todayUtc();
}

function normalizeToken(v: unknown, maxLen = 64) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .slice(0, maxLen)
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok).startsWith('--')) {
      out._.push(String(tok));
      continue;
    }
    const eq = String(tok).indexOf('=');
    if (eq === -1) {
      out[String(tok).slice(2)] = true;
      continue;
    }
    out[String(tok).slice(2, eq)] = String(tok).slice(eq + 1);
  }
  return out;
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function addUtcDays(dateStr: string, deltaDays: number) {
  const ts = Date.parse(`${String(dateStr)}T00:00:00.000Z`);
  if (!Number.isFinite(ts)) return todayUtc();
  return new Date(ts + (deltaDays * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function dateWindow(endDate: string, days: number) {
  const out = [];
  const n = Math.max(1, Number(days || 1));
  for (let i = 0; i < n; i += 1) {
    out.push(addUtcDays(endDate, -i));
  }
  return out;
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const minSuccessRaw = Number(raw && raw.min_success_ratio);
  const minSuccessRatio = Number.isFinite(minSuccessRaw) ? minSuccessRaw : 0.5;
  return {
    version: String(raw && raw.version || '1.0'),
    target_streak_days: clampInt(raw && raw.target_streak_days, 1, 365, 7),
    min_accepted_items: clampInt(raw && raw.min_accepted_items, 0, 1000, 1),
    min_workflows_executed: clampInt(raw && raw.min_workflows_executed, 0, 1000, 1),
    min_workflows_succeeded: clampInt(raw && raw.min_workflows_succeeded, 0, 1000, 1),
    min_success_ratio: Math.max(0, Math.min(1, minSuccessRatio)),
    lookback_days: clampInt(raw && raw.lookback_days, 1, 365, 21),
    max_history_rows: clampInt(raw && raw.max_history_rows, 10, 5000, 120)
  };
}

function normalizeProposalStatus(raw: unknown) {
  const s = normalizeToken(raw || '', 40);
  if (!s || s === 'unknown' || s === 'new' || s === 'queued' || s === 'pending' || s === 'admitted') return 'open';
  if (s === 'closed_won' || s === 'won' || s === 'paid' || s === 'verified') return 'closed';
  return s;
}

function proposalIsRejected(row: AnyObj) {
  const status = normalizeProposalStatus(row && row.status);
  if (status === 'rejected' || status === 'blocked' || status === 'failed' || status === 'invalid') return true;
  const decision = normalizeToken(row && (row.decision || row.queue_decision), 40);
  return decision === 'reject' || decision === 'rejected' || decision === 'block' || decision === 'blocked';
}

function proposalIsSignalAccepted(row: AnyObj) {
  if (!row || typeof row !== 'object') return false;
  if (proposalIsRejected(row)) return false;
  const status = normalizeProposalStatus(row.status);
  if (
    status === 'accepted'
    || status === 'approved'
    || status === 'sprouted'
    || status === 'verified'
    || status === 'closed'
    || status === 'resolved'
    || status === 'executed'
    || status === 'shipped'
  ) {
    return true;
  }
  const meta = row.meta && typeof row.meta === 'object' ? row.meta : null;
  if (meta && meta.admission_preview && typeof meta.admission_preview === 'object' && meta.admission_preview.eligible === true) {
    return true;
  }
  if (meta && meta.composite_eligibility_pass === true) return true;
  const type = normalizeToken(row.type || '', 80);
  return type === 'external_intel';
}

function loadProposalsForDate(proposalsDir: string, dateStr: string) {
  const filePath = path.join(proposalsDir, `${dateStr}.json`);
  if (!fs.existsSync(filePath)) {
    return {
      path: relPath(filePath),
      exists: false,
      rows: [],
      total: 0,
      accepted_items: 0
    };
  }
  const parsed = readJson(filePath, null);
  let rows = [];
  if (Array.isArray(parsed)) rows = parsed;
  else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.proposals)) rows = parsed.proposals;
  rows = rows.filter((row: unknown) => row && typeof row === 'object');
  const accepted = rows.filter((row: AnyObj) => proposalIsSignalAccepted(row)).length;
  return {
    path: relPath(filePath),
    exists: true,
    rows,
    total: rows.length,
    accepted_items: accepted
  };
}

function loadWorkflowRunForDate(workflowRunsDir: string, dateStr: string) {
  const filePath = path.join(workflowRunsDir, `${dateStr}.json`);
  if (!fs.existsSync(filePath)) {
    return {
      path: relPath(filePath),
      exists: false,
      workflows_executed: 0,
      workflows_selected: 0,
      workflows_succeeded: 0,
      workflows_failed: 0
    };
  }
  const payload = readJson(filePath, {});
  return {
    path: relPath(filePath),
    exists: true,
    workflows_executed: Math.max(0, Number(payload && payload.workflows_executed || 0)),
    workflows_selected: Math.max(0, Number(payload && payload.workflows_selected || 0)),
    workflows_succeeded: Math.max(0, Number(payload && payload.workflows_succeeded || 0)),
    workflows_failed: Math.max(0, Number(payload && payload.workflows_failed || 0))
  };
}

function computeStreak(rows: AnyObj[]) {
  let streak = 0;
  for (const row of rows) {
    if (row && row.pass === true) streak += 1;
    else break;
  }
  return streak;
}

function runClosure(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const date = toDate(args._[1] || args.date);
  const lookbackDays = clampInt(args.days ?? args['lookback-days'], 1, 365, policy.lookback_days);
  const targetStreakDays = clampInt(args['target-days'] ?? args.target_days, 1, 365, policy.target_streak_days);
  const minAcceptedItems = clampInt(args['min-accepted'] ?? args.min_accepted_items, 0, 1000, policy.min_accepted_items);
  const minWorkflowsExecuted = clampInt(args['min-workflows'] ?? args.min_workflows_executed, 0, 1000, policy.min_workflows_executed);
  const minWorkflowsSucceeded = clampInt(args['min-succeeded'] ?? args.min_workflows_succeeded, 0, 1000, policy.min_workflows_succeeded);
  const minSuccessRatioRaw = args['min-success-ratio'] ?? args.min_success_ratio;
  const minSuccessRatioParsed = Number(minSuccessRatioRaw == null ? policy.min_success_ratio : minSuccessRatioRaw);
  const minSuccessRatio = Math.max(
    0,
    Math.min(
      1,
      Number.isFinite(minSuccessRatioParsed) ? minSuccessRatioParsed : policy.min_success_ratio
    )
  );
  const strict = toBool(args.strict, false);
  const statePath = args['state-path'] ? path.resolve(String(args['state-path'])) : DEFAULT_STATE_PATH;
  const historyPath = args['history-path'] ? path.resolve(String(args['history-path'])) : DEFAULT_HISTORY_PATH;
  const proposalsDir = args['proposals-dir'] ? path.resolve(String(args['proposals-dir'])) : DEFAULT_PROPOSALS_DIR;
  const workflowRunsDir = args['workflow-runs-dir'] ? path.resolve(String(args['workflow-runs-dir'])) : DEFAULT_WORKFLOW_RUNS_DIR;

  const dates = dateWindow(date, lookbackDays);
  const rows = dates.map((d) => {
    const proposals = loadProposalsForDate(proposalsDir, d);
    const workflow = loadWorkflowRunForDate(workflowRunsDir, d);
    const acceptedItems = Number(proposals.accepted_items || 0);
    const workflowsExecuted = Number(workflow.workflows_executed || 0);
    const workflowsSucceeded = Number(workflow.workflows_succeeded || 0);
    const successRatio = workflowsExecuted > 0 ? (workflowsSucceeded / workflowsExecuted) : 0;
    const pass = acceptedItems >= minAcceptedItems
      && workflowsExecuted >= minWorkflowsExecuted
      && workflowsSucceeded >= minWorkflowsSucceeded
      && successRatio >= minSuccessRatio;
    return {
      date: d,
      pass,
      accepted_items: acceptedItems,
      workflows_executed: workflowsExecuted,
      workflows_selected: Number(workflow.workflows_selected || 0),
      workflows_succeeded: workflowsSucceeded,
      workflow_success_ratio: Number(successRatio.toFixed(4)),
      workflows_failed: Number(workflow.workflows_failed || 0),
      proposal_total: Number(proposals.total || 0),
      proposal_path: proposals.path,
      workflow_run_path: workflow.path
    };
  });

  const streak = computeStreak(rows);
  const closurePass = streak >= targetStreakDays;
  const latest = rows.length ? rows[0] : null;
  const payload = {
    ok: true,
    type: 'workflow_execution_closure',
    ts: nowIso(),
    date,
    policy_path: relPath(policyPath),
    policy_version: policy.version,
    target_streak_days: targetStreakDays,
    min_accepted_items: minAcceptedItems,
    min_workflows_executed: minWorkflowsExecuted,
    min_workflows_succeeded: minWorkflowsSucceeded,
    min_success_ratio: Number(minSuccessRatio.toFixed(4)),
    lookback_days: lookbackDays,
    consecutive_days_passed: streak,
    remaining_days: Math.max(0, targetStreakDays - streak),
    closure_pass: closurePass,
    result: closurePass ? 'pass' : 'pending',
    latest_day: latest ? {
      date: latest.date,
      pass: latest.pass === true,
      accepted_items: Number(latest.accepted_items || 0),
      workflows_executed: Number(latest.workflows_executed || 0)
    } : null,
    evidence: {
      proposals_dir: relPath(proposalsDir),
      workflow_runs_dir: relPath(workflowRunsDir),
      rows
    },
    state_path: relPath(statePath),
    history_path: relPath(historyPath)
  };

  writeJsonAtomic(statePath, {
    schema_id: 'workflow_execution_closure',
    schema_version: '1.0',
    updated_at: payload.ts,
    date: payload.date,
    policy_version: payload.policy_version,
    target_streak_days: payload.target_streak_days,
    min_accepted_items: payload.min_accepted_items,
    min_workflows_executed: payload.min_workflows_executed,
    lookback_days: payload.lookback_days,
    consecutive_days_passed: payload.consecutive_days_passed,
    remaining_days: payload.remaining_days,
    closure_pass: payload.closure_pass,
    result: payload.result,
    latest_day: payload.latest_day,
    evidence: payload.evidence
  });
  appendJsonl(historyPath, {
    ts: payload.ts,
    date: payload.date,
    target_streak_days: payload.target_streak_days,
    min_accepted_items: payload.min_accepted_items,
    min_workflows_executed: payload.min_workflows_executed,
    consecutive_days_passed: payload.consecutive_days_passed,
    closure_pass: payload.closure_pass,
    latest_day: payload.latest_day
  });
  trimHistory(historyPath, policy.max_history_rows);

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (strict && !closurePass) process.exit(1);
}

function trimHistory(historyPath: string, maxRows: number) {
  if (!fs.existsSync(historyPath)) return;
  const lines = String(fs.readFileSync(historyPath, 'utf8') || '').split('\n').filter(Boolean);
  if (lines.length <= maxRows) return;
  const next = lines.slice(lines.length - maxRows).join('\n');
  fs.writeFileSync(historyPath, `${next}\n`, 'utf8');
}

function statusClosure() {
  const payload = readJson(DEFAULT_STATE_PATH, null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(JSON.stringify({
      ok: true,
      type: 'workflow_execution_closure_status',
      ts: nowIso(),
      available: false,
      state_path: relPath(DEFAULT_STATE_PATH)
    }, null, 2) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'workflow_execution_closure_status',
    ts: nowIso(),
    available: true,
    state_path: relPath(DEFAULT_STATE_PATH),
    payload
  }, null, 2) + '\n');
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/workflow_execution_closure.js run [YYYY-MM-DD] [--days=21] [--target-days=7] [--min-accepted=1] [--min-workflows=1] [--strict=1]');
  console.log('  node systems/ops/workflow_execution_closure.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'run', 32);
  if (cmd === 'run') {
    runClosure(args);
    return;
  }
  if (cmd === 'status' || cmd === 'latest') {
    statusClosure();
    return;
  }
  usage();
  process.exit(2);
}

main();
