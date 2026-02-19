#!/usr/bin/env node
'use strict';

/**
 * strategy_mode_governor.js
 *
 * Deterministic strategy mode governor:
 * - score_only -> canary_execute when readiness passes
 * - canary_execute -> execute when canary metrics pass (optional)
 * - execute/canary_execute -> safer mode when readiness fails
 *
 * Usage:
 *   node systems/autonomy/strategy_mode_governor.js run [YYYY-MM-DD] [--days=N] [--id=<strategy_id>] [--strict] [--dry-run]
 *   node systems/autonomy/strategy_mode_governor.js status [YYYY-MM-DD] [--days=N] [--id=<strategy_id>] [--strict]
 *   node systems/autonomy/strategy_mode_governor.js --help
 */

const fs = require('fs');
const path = require('path');
const {
  loadActiveStrategy,
  strategyExecutionMode,
  strategyPromotionPolicy
} = require('../../lib/strategy_resolver.js');
const { summarizeForDate } = require('./receipt_summary.js');
const { evaluateReadiness } = require('./strategy_readiness.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MODE_AUDIT_LOG_PATH = process.env.AUTONOMY_STRATEGY_MODE_LOG
  ? path.resolve(process.env.AUTONOMY_STRATEGY_MODE_LOG)
  : path.join(REPO_ROOT, 'state', 'autonomy', 'strategy_mode_changes.jsonl');
const MODE_GOVERNOR_MIN_HOURS_BETWEEN_CHANGES = Number(process.env.AUTONOMY_MODE_GOVERNOR_MIN_HOURS_BETWEEN_CHANGES || 6);
const MODE_GOVERNOR_PROMOTE_CANARY = String(process.env.AUTONOMY_MODE_GOVERNOR_PROMOTE_CANARY || '1') !== '0';
const MODE_GOVERNOR_PROMOTE_EXECUTE = String(process.env.AUTONOMY_MODE_GOVERNOR_PROMOTE_EXECUTE || '0') === '1';
const MODE_GOVERNOR_ALLOW_AUTO_ESCALATION = String(process.env.AUTONOMY_MODE_GOVERNOR_ALLOW_AUTO_ESCALATION || '0') === '1';
const MODE_GOVERNOR_DEMOTE_NOT_READY = String(process.env.AUTONOMY_MODE_GOVERNOR_DEMOTE_NOT_READY || '1') !== '0';
const MODE_GOVERNOR_CANARY_MIN_ATTEMPTED = Number(process.env.AUTONOMY_MODE_GOVERNOR_CANARY_MIN_ATTEMPTED || 3);
const MODE_GOVERNOR_CANARY_MIN_VERIFIED_RATE = Number(process.env.AUTONOMY_MODE_GOVERNOR_CANARY_MIN_VERIFIED_RATE || 0.75);
const MODE_GOVERNOR_CANARY_MAX_FAIL_RATE = Number(process.env.AUTONOMY_MODE_GOVERNOR_CANARY_MAX_FAIL_RATE || 0.25);
const MODE_GOVERNOR_CANARY_MIN_SHIPPED = Number(process.env.AUTONOMY_MODE_GOVERNOR_CANARY_MIN_SHIPPED || 1);

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/strategy_mode_governor.js run [YYYY-MM-DD] [--days=N] [--id=<strategy_id>] [--strict] [--dry-run]');
  console.log('  node systems/autonomy/strategy_mode_governor.js status [YYYY-MM-DD] [--days=N] [--id=<strategy_id>] [--strict]');
  console.log('  node systems/autonomy/strategy_mode_governor.js --help');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function isDateStr(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const rows = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (const row of rows) {
      try { out.push(JSON.parse(row)); } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

function loadStrategy(args) {
  return loadActiveStrategy({
    allowMissing: false,
    strict: args.strict === true,
    id: args.id ? String(args.id) : undefined
  });
}

function governorPolicy() {
  return {
    min_hours_between_changes: Math.max(0, Number.isFinite(MODE_GOVERNOR_MIN_HOURS_BETWEEN_CHANGES) ? MODE_GOVERNOR_MIN_HOURS_BETWEEN_CHANGES : 0),
    promote_canary: MODE_GOVERNOR_PROMOTE_CANARY,
    promote_execute: MODE_GOVERNOR_PROMOTE_EXECUTE,
    demote_not_ready: MODE_GOVERNOR_DEMOTE_NOT_READY,
    canary_min_attempted: Math.max(0, Number(MODE_GOVERNOR_CANARY_MIN_ATTEMPTED || 0)),
    canary_min_verified_rate: Math.max(0, Math.min(1, Number(MODE_GOVERNOR_CANARY_MIN_VERIFIED_RATE || 0))),
    canary_max_fail_rate: Math.max(0, Math.min(1, Number(MODE_GOVERNOR_CANARY_MAX_FAIL_RATE || 1))),
    canary_min_shipped: Math.max(0, Number(MODE_GOVERNOR_CANARY_MIN_SHIPPED || 0))
  };
}

function lastModeChangeEvent(strategyId) {
  const rows = readJsonl(MODE_AUDIT_LOG_PATH);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row || !row.type) continue;
    const t = String(row.type);
    if (t !== 'strategy_mode_change' && t !== 'strategy_mode_auto_change' && t !== 'strategy_mode_auto_revert') continue;
    if (strategyId && String(row.strategy_id || '') !== String(strategyId)) continue;
    return row;
  }
  return null;
}

function cooldownState(last, minHours) {
  const out = {
    active: false,
    remaining_minutes: 0,
    min_hours_between_changes: minHours
  };
  if (!last || !last.ts || !Number.isFinite(minHours) || minHours <= 0) return out;
  const ts = new Date(String(last.ts));
  if (Number.isNaN(ts.getTime())) return out;
  const minMs = minHours * 60 * 60 * 1000;
  const ageMs = Date.now() - ts.getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= minMs) return out;
  out.active = true;
  out.remaining_minutes = Math.ceil((minMs - ageMs) / (60 * 1000));
  return out;
}

function canaryMetrics(summary, policy) {
  const attempted = Number(summary?.receipts?.combined?.attempted || 0);
  const verifiedRate = Number(summary?.receipts?.combined?.verified_rate || 0);
  const autonomyFail = Number(summary?.receipts?.autonomy?.fail || 0);
  const actuationFail = Number(summary?.receipts?.actuation?.failed || 0);
  const failCount = autonomyFail + actuationFail;
  const failRate = attempted > 0 ? failCount / attempted : 1;
  const shipped = Number(summary?.runs?.executed_outcomes?.shipped || 0);
  const checks = [
    {
      name: 'attempted',
      pass: attempted >= policy.canary_min_attempted,
      value: attempted,
      target: `>=${policy.canary_min_attempted}`
    },
    {
      name: 'verified_rate',
      pass: verifiedRate >= policy.canary_min_verified_rate,
      value: Number(verifiedRate.toFixed(3)),
      target: `>=${policy.canary_min_verified_rate}`
    },
    {
      name: 'fail_rate',
      pass: failRate <= policy.canary_max_fail_rate,
      value: Number(failRate.toFixed(3)),
      target: `<=${policy.canary_max_fail_rate}`
    },
    {
      name: 'shipped',
      pass: shipped >= policy.canary_min_shipped,
      value: shipped,
      target: `>=${policy.canary_min_shipped}`
    }
  ];
  const failed = checks.filter(c => c.pass !== true).map(c => c.name);
  return {
    ready_for_execute: failed.length === 0,
    failed_checks: failed,
    checks,
    metrics: {
      attempted,
      verified_rate: Number(verifiedRate.toFixed(3)),
      fail_rate: Number(failRate.toFixed(3)),
      shipped
    }
  };
}

function modeRank(mode) {
  const m = String(mode || '');
  if (m === 'score_only') return 0;
  if (m === 'canary_execute') return 1;
  if (m === 'execute') return 2;
  return -1;
}

function isEscalation(fromMode, toMode) {
  const fromRank = modeRank(fromMode);
  const toRank = modeRank(toMode);
  return fromRank >= 0 && toRank >= 0 && toRank > fromRank;
}

function decideTransition(currentMode, readiness, canary, policy) {
  const mode = String(currentMode || '');
  const ready = !!(readiness && readiness.ready_for_execute === true);
  if (mode === 'score_only') {
    if (!policy.promote_canary) return null;
    if (ready) {
      return {
        to_mode: 'canary_execute',
        reason: 'readiness_pass_promote_canary',
        cooldown_exempt: false
      };
    }
    return null;
  }

  if (mode === 'canary_execute') {
    if (policy.demote_not_ready && !ready) {
      return {
        to_mode: 'score_only',
        reason: 'readiness_fail_demote_score_only',
        cooldown_exempt: true
      };
    }
    if (policy.promote_execute && ready && canary && canary.ready_for_execute === true) {
      return {
        to_mode: 'execute',
        reason: 'canary_metrics_pass_promote_execute',
        cooldown_exempt: false
      };
    }
    return null;
  }

  if (mode === 'execute') {
    if (policy.demote_not_ready && !ready) {
      return {
        to_mode: 'canary_execute',
        reason: 'readiness_fail_demote_canary',
        cooldown_exempt: true
      };
    }
  }
  return null;
}

function applyMode(strategy, toMode) {
  const raw = readJsonSafe(strategy.file, {});
  const next = raw && typeof raw === 'object' ? { ...raw } : {};
  next.execution_policy = {
    ...(next.execution_policy && typeof next.execution_policy === 'object' ? next.execution_policy : {}),
    mode: toMode
  };
  writeJsonAtomic(strategy.file, next);
}

function buildStatus(dateStr, days, strategy, policy) {
  const promotion = strategyPromotionPolicy(strategy, {});
  const windowDays = Math.max(Number(promotion.min_days || 7), clampInt(days, 1, 30, Number(promotion.min_days || 7)));
  const summary = summarizeForDate(dateStr, windowDays);
  const readiness = evaluateReadiness(strategy, summary, promotion, windowDays);
  const mode = strategyExecutionMode(strategy, 'execute');
  const canary = canaryMetrics(summary, policy);
  const last = lastModeChangeEvent(strategy.id);
  const cooldown = cooldownState(last, policy.min_hours_between_changes);
  const transition = decideTransition(mode, readiness, canary, policy);
  return {
    date: dateStr,
    days: windowDays,
    strategy,
    policy,
    summary,
    readiness,
    canary,
    current_mode: mode,
    last_mode_change: last ? {
      ts: String(last.ts || ''),
      type: String(last.type || ''),
      from_mode: String(last.from_mode || ''),
      to_mode: String(last.to_mode || '')
    } : null,
    cooldown,
    transition
  };
}

function cmdStatus(args) {
  const dateStr = isDateStr(args._[1]) ? String(args._[1]) : todayStr();
  const strategy = loadStrategy(args);
  const policy = governorPolicy();
  const status = buildStatus(dateStr, args.days, strategy, policy);
  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    date: status.date,
    days: status.days,
    strategy: {
      id: strategy.id,
      mode: status.current_mode,
      file: path.relative(REPO_ROOT, strategy.file).replace(/\\/g, '/')
    },
    readiness: status.readiness,
    canary: status.canary,
    policy: status.policy,
    cooldown: status.cooldown,
    transition: status.transition
  }, null, 2) + '\n');
}

function cmdRun(args) {
  const dateStr = isDateStr(args._[1]) ? String(args._[1]) : todayStr();
  const dryRun = args['dry-run'] === true || args.dry_run === true;
  const strategy = loadStrategy(args);
  const policy = governorPolicy();
  const status = buildStatus(dateStr, args.days, strategy, policy);
  const fromMode = status.current_mode;
  const transition = status.transition;

  if (!transition) {
    process.stdout.write(JSON.stringify({
      ok: true,
      ts: nowIso(),
      result: 'no_change',
      strategy_id: strategy.id,
      mode: fromMode,
      reason: 'no_transition_rule_triggered',
      readiness: status.readiness,
      canary: status.canary
    }, null, 2) + '\n');
    return;
  }

  const cooldown = status.cooldown;
  if (!transition.cooldown_exempt && cooldown.active) {
    process.stdout.write(JSON.stringify({
      ok: true,
      ts: nowIso(),
      result: 'cooldown_blocked',
      strategy_id: strategy.id,
      from_mode: fromMode,
      to_mode: transition.to_mode,
      reason: transition.reason,
      cooldown
    }, null, 2) + '\n');
    return;
  }

  if (dryRun) {
    process.stdout.write(JSON.stringify({
      ok: true,
      ts: nowIso(),
      result: 'dry_run',
      strategy_id: strategy.id,
      from_mode: fromMode,
      to_mode: transition.to_mode,
      reason: transition.reason,
      readiness: status.readiness,
      canary: status.canary
    }, null, 2) + '\n');
    return;
  }

  if (isEscalation(fromMode, transition.to_mode) && !MODE_GOVERNOR_ALLOW_AUTO_ESCALATION) {
    const evt = {
      ts: nowIso(),
      type: 'strategy_mode_auto_blocked',
      strategy_id: strategy.id,
      file: path.relative(REPO_ROOT, strategy.file).replace(/\\/g, '/'),
      from_mode: fromMode,
      to_mode: transition.to_mode,
      reason: 'dual_control_required_for_escalation',
      required_command: `node systems/autonomy/strategy_mode.js set --mode=${transition.to_mode} --approval-note="<reason>" --approver-id=<id> --second-approver-id=<id> --second-approval-note="<reason>"`,
      governor_policy: policy,
      readiness: status.readiness,
      canary: status.canary
    };
    appendJsonl(MODE_AUDIT_LOG_PATH, evt);
    process.stdout.write(JSON.stringify({
      ok: true,
      ts: nowIso(),
      result: 'blocked_dual_control_required',
      ...evt
    }, null, 2) + '\n');
    return;
  }

  applyMode(strategy, transition.to_mode);
  const evt = {
    ts: nowIso(),
    type: 'strategy_mode_auto_change',
    strategy_id: strategy.id,
    file: path.relative(REPO_ROOT, strategy.file).replace(/\\/g, '/'),
    from_mode: fromMode,
    to_mode: transition.to_mode,
    reason: transition.reason,
    cooldown_exempt: transition.cooldown_exempt === true,
    governor_policy: policy,
    readiness: status.readiness,
    canary: status.canary
  };
  appendJsonl(MODE_AUDIT_LOG_PATH, evt);

  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    result: 'mode_changed',
    ...evt
  }, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'status') return cmdStatus(args);
  if (cmd === 'run') return cmdRun(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  canaryMetrics,
  decideTransition
};
