#!/usr/bin/env node
'use strict';
export {};

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.SIGNAL_SLO_DEADLOCK_POLICY_PATH
  ? path.resolve(process.env.SIGNAL_SLO_DEADLOCK_POLICY_PATH)
  : path.join(ROOT, 'config', 'signal_slo_deadlock_policy.json');
const DEFAULT_STATE_DIR = process.env.SIGNAL_SLO_DEADLOCK_STATE_DIR
  ? path.resolve(process.env.SIGNAL_SLO_DEADLOCK_STATE_DIR)
  : path.join(ROOT, 'state', 'ops', 'signal_slo_deadlock');
const DEFAULT_STATE_PATH = path.join(DEFAULT_STATE_DIR, 'state.json');
const DEFAULT_HISTORY_PATH = path.join(DEFAULT_STATE_DIR, 'history.jsonl');
const DEFAULT_LAST_PATH = path.join(DEFAULT_STATE_DIR, 'latest.json');
const QUEUE_LOG_PATH = process.env.SIGNAL_SLO_DEADLOCK_QUEUE_LOG_PATH
  ? path.resolve(process.env.SIGNAL_SLO_DEADLOCK_QUEUE_LOG_PATH)
  : path.join(ROOT, 'state', 'sensory', 'queue_log.jsonl');
const PROPOSALS_DIR = process.env.SIGNAL_SLO_DEADLOCK_PROPOSALS_DIR
  ? path.resolve(process.env.SIGNAL_SLO_DEADLOCK_PROPOSALS_DIR)
  : path.join(ROOT, 'state', 'sensory', 'proposals');

function nowIso(): string {
  return new Date().toISOString();
}

function isDate(v: unknown): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim());
}

function todayStr(): string {
  return nowIso().slice(0, 10);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}): AnyObj {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, value: AnyObj): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function appendJsonl(filePath: string, value: AnyObj): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function hashId(seed: string): string {
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const idx = raw.indexOf('=');
    if (idx === -1) out[raw.slice(2)] = '1';
    else out[raw.slice(2, idx)] = raw.slice(idx + 1);
  }
  return out;
}

function runSignalSlo(dateStr: string): AnyObj {
  const script = process.env.SIGNAL_SLO_DEADLOCK_SLO_SCRIPT
    ? path.resolve(process.env.SIGNAL_SLO_DEADLOCK_SLO_SCRIPT)
    : path.join(ROOT, 'habits', 'scripts', 'external_eyes.js');
  const res = spawnSync('node', [script, 'slo', dateStr], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000
  });
  const stdout = String(res.stdout || '').trim();
  let payload: AnyObj = {};
  try {
    payload = JSON.parse(stdout || '{}');
  } catch {
    payload = {};
  }
  return {
    ok: res.status === 0 && payload && payload.ok === true,
    code: Number(res.status || 0),
    payload,
    stdout,
    stderr: String(res.stderr || '').trim()
  };
}

function daysAgoMs(days: number): number {
  return Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000;
}

function filteredReasonHistogram(lookbackDays: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!fs.existsSync(QUEUE_LOG_PATH)) return out;
  const cutoff = daysAgoMs(lookbackDays);
  const lines = fs.readFileSync(QUEUE_LOG_PATH, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    let row: AnyObj = {};
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || row.type !== 'proposal_filtered') continue;
    const tsMs = Number(new Date(String(row.ts || '')).getTime());
    if (!Number.isFinite(tsMs) || tsMs < cutoff) continue;
    const reason = String(row.filter_reason || 'unknown').trim() || 'unknown';
    out[reason] = Number(out[reason] || 0) + 1;
  }
  return out;
}

function topReasons(hist: Record<string, number>, max = 5): Array<{ reason: string; count: number }> {
  return Object.entries(hist)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, Math.max(1, max))
    .map(([reason, count]) => ({ reason, count: Number(count || 0) }));
}

function loadProposals(dateStr: string): AnyObj[] {
  const filePath = path.join(PROPOSALS_DIR, `${dateStr}.json`);
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveProposals(dateStr: string, proposals: AnyObj[]): string {
  const filePath = path.join(PROPOSALS_DIR, `${dateStr}.json`);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(proposals, null, 2));
  return filePath;
}

function injectEscalationProposal(
  dateStr: string,
  policy: AnyObj,
  streak: number,
  sloPayload: AnyObj,
  histogram: Record<string, number>
): AnyObj {
  const proposalType = String(policy?.proposal?.type || 'infrastructure_outage');
  const objectiveId = String(policy?.default_objective_id || 'T1_generational_wealth_v1');
  const top = topReasons(histogram, 5);
  const failedChecks = Array.isArray(sloPayload?.failed_checks) ? sloPayload.failed_checks.map((v: unknown) => String(v || '').trim()).filter(Boolean) : [];
  const proposalId = `SLODLK-${hashId(`${dateStr}|${streak}|${failedChecks.join(',')}|${JSON.stringify(top)}`)}`;

  const proposals = loadProposals(dateStr);
  const existing = proposals.find((row) => row && String(row.id || '') === proposalId);
  if (existing) {
    return {
      created: false,
      proposal_id: proposalId,
      reason: 'already_exists',
      proposals_path: path.join(PROPOSALS_DIR, `${dateStr}.json`)
    };
  }

  const title = `[SLO Deadlock] accepted_items failed ${streak} consecutive runs`;
  const summary = `Signal SLO is failing with streak=${streak}. Focus remediation on top queue filter reasons and reopen execution flow.`;
  const newProposal = {
    id: proposalId,
    type: proposalType,
    title,
    summary,
    risk: String(policy?.proposal?.risk || 'medium'),
    priority: 'high',
    suggested_next_command: `node systems/ops/signal_slo_deadlock_breaker.js run ${dateStr}`,
    validation: [
      'Confirm signal_slo.accepted_items >= 1 on the next run',
      'Reduce top filtered reasons using targeted gate adjustments',
      'Record closure receipt after streak resets to zero'
    ],
    status: 'open',
    generated_by: String(policy?.proposal?.source || 'signal_slo_deadlock_breaker'),
    quality_gate: String(policy?.proposal?.quality_gate || 'ops_deadlock_v1'),
    action_spec: {
      version: 1,
      objective_id: objectiveId,
      intent: 'resolve_signal_slo_deadlock',
      verify: ['signal_slo.accepted_items >= 1', 'streak_reset_receipt'],
      rollback: 'revert deadlock remediation change set and keep escalation open'
    },
    meta: {
      objective_id: objectiveId,
      escalation_kind: 'signal_slo_deadlock',
      signal_slo_failed_checks: failedChecks,
      streak,
      top_filtered_reasons: top,
      queue_filtered_reason_histogram: histogram
    }
  };

  proposals.push(newProposal);
  const proposalsPath = saveProposals(dateStr, proposals);
  return {
    created: true,
    proposal_id: proposalId,
    proposals_path: proposalsPath
  };
}

function usage(): void {
  console.log('Usage:');
  console.log('  node systems/ops/signal_slo_deadlock_breaker.js run [YYYY-MM-DD] [--policy=path]');
  console.log('  node systems/ops/signal_slo_deadlock_breaker.js status');
}

function runCmd(dateStr: string, policyPath: string): void {
  const policy = readJson(policyPath, {});
  if (policy && policy.enabled === false) {
    const out = { ok: true, type: 'signal_slo_deadlock_breaker', date: dateStr, skipped: true, reason: 'disabled', policy_path: path.relative(ROOT, policyPath), ts: nowIso() };
    writeJson(DEFAULT_LAST_PATH, out);
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }

  const streakThreshold = Math.max(1, Number(policy?.streak_threshold || 3));
  const maxOpenEscalations = Math.max(1, Number(policy?.max_open_escalations || 1));
  const lookbackDays = Math.max(1, Number(policy?.lookback_days || 14));
  const state = readJson(DEFAULT_STATE_PATH, {
    streak: 0,
    last_date: null,
    open_escalations: [],
    last_result: null
  });

  const slo = runSignalSlo(dateStr);
  const openEscalations = Array.isArray(state.open_escalations)
    ? state.open_escalations.map((v: unknown) => String(v || '').trim()).filter(Boolean)
    : [];
  const priorStreak = Number(state.streak || 0);
  let streak = priorStreak;
  let closureReceipt: AnyObj = null;
  let escalation: AnyObj = null;

  if (slo.ok) {
    streak = 0;
    if (priorStreak > 0 || openEscalations.length > 0) {
      closureReceipt = {
        ts: nowIso(),
        type: 'signal_slo_deadlock_closed',
        date: dateStr,
        prior_streak: priorStreak,
        closed_escalations: openEscalations
      };
      appendJsonl(DEFAULT_HISTORY_PATH, closureReceipt);
    }
    state.open_escalations = [];
  } else {
    const nextStreak = state.last_date === dateStr
      ? Math.max(priorStreak, priorStreak || 1)
      : priorStreak + 1;
    streak = Math.max(1, nextStreak);
    if (streak >= streakThreshold && openEscalations.length < maxOpenEscalations) {
      const histogram = filteredReasonHistogram(lookbackDays);
      escalation = injectEscalationProposal(dateStr, policy, streak, slo.payload, histogram);
      if (escalation && escalation.created === true) {
        state.open_escalations = Array.from(new Set([...openEscalations, String(escalation.proposal_id || '').trim()].filter(Boolean)));
      }
    }
  }

  state.streak = streak;
  state.last_date = dateStr;
  state.last_result = slo.ok ? 'pass' : 'fail';
  state.last_failed_checks = Array.isArray(slo.payload?.failed_checks)
    ? slo.payload.failed_checks.slice(0, 8)
    : [];
  state.updated_at = nowIso();
  writeJson(DEFAULT_STATE_PATH, state);

  const historyRow = {
    ts: nowIso(),
    type: 'signal_slo_deadlock_eval',
    date: dateStr,
    pass: slo.ok,
    streak,
    streak_threshold: streakThreshold,
    failed_checks: state.last_failed_checks,
    escalation: escalation || null
  };
  appendJsonl(DEFAULT_HISTORY_PATH, historyRow);

  const out = {
    ok: true,
    type: 'signal_slo_deadlock_breaker',
    ts: nowIso(),
    date: dateStr,
    policy_path: path.relative(ROOT, policyPath),
    signal_slo_ok: slo.ok,
    signal_slo_failed_checks: state.last_failed_checks,
    streak,
    streak_threshold: streakThreshold,
    open_escalations: state.open_escalations || [],
    escalation,
    closure_receipt: closureReceipt
  };
  writeJson(DEFAULT_LAST_PATH, out);
  process.stdout.write(JSON.stringify(out) + '\n');
}

function statusCmd(): void {
  const state = readJson(DEFAULT_STATE_PATH, {});
  const latest = readJson(DEFAULT_LAST_PATH, {});
  const out = {
    ok: true,
    type: 'signal_slo_deadlock_breaker_status',
    ts: nowIso(),
    state,
    latest
  };
  process.stdout.write(JSON.stringify(out) + '\n');
}

function main(): void {
  const cmd = String(process.argv[2] || '').trim();
  const args = parseArgs(process.argv.slice(3));
  const policyPath = args.policy ? path.resolve(args.policy) : DEFAULT_POLICY_PATH;
  ensureDir(DEFAULT_STATE_DIR);
  if (cmd === 'run') {
    const dateStr = isDate(process.argv[3]) ? String(process.argv[3]) : todayStr();
    runCmd(dateStr, policyPath);
    return;
  }
  if (cmd === 'status') {
    statusCmd();
    return;
  }
  usage();
}

if (require.main === module) main();
