#!/usr/bin/env node
'use strict';

/**
 * strategy_readiness.js
 *
 * Deterministic readiness evaluator for promoting strategy execution mode
 * from score_only -> execute. This command does not mutate config.
 *
 * Usage:
 *   node systems/autonomy/strategy_readiness.js run [YYYY-MM-DD] [--days=N] [--id=<strategy_id>] [--strict]
 *   node systems/autonomy/strategy_readiness.js --help
 */

const {
  loadActiveStrategy,
  strategyExecutionMode,
  strategyPromotionPolicy
} = require('../../lib/strategy_resolver.js');
const { summarizeForDate } = require('./receipt_summary.js');

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/strategy_readiness.js run [YYYY-MM-DD] [--days=N] [--id=<strategy_id>] [--strict]');
  console.log('  node systems/autonomy/strategy_readiness.js --help');
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

function safeRate(num, den) {
  const d = Number(den || 0);
  if (d <= 0) return 0;
  return Number((Number(num || 0) / d).toFixed(3));
}

function evaluateReadiness(strategy, summary, policy, requestedDays) {
  const runs = summary && summary.runs ? summary.runs : {};
  const receipts = summary && summary.receipts && summary.receipts.combined ? summary.receipts.combined : {};
  const executedOutcomes = runs.executed_outcomes || {};
  const executed = Number(runs.executed || 0);
  const shipped = Number(executedOutcomes.shipped || 0);
  const reverted = Number(executedOutcomes.reverted || 0);
  const stopped = Number(runs.stopped || 0);
  const totalRuns = Number(runs.total || 0);
  const attempted = Number(receipts.attempted || 0);
  const verifiedRate = Number(receipts.verified_rate || 0);
  const revertedRate = safeRate(reverted, executed);
  const stopRatio = safeRate(stopped, totalRuns);
  const policyDays = Number(policy.min_days || 7);
  const usedDays = Number(summary && summary.window && summary.window.days || requestedDays || 0);

  const checks = [
    {
      name: 'window_days',
      pass: usedDays >= policyDays,
      value: usedDays,
      target: `>=${policyDays}`
    },
    {
      name: 'attempted',
      pass: attempted >= Number(policy.min_attempted || 0),
      value: attempted,
      target: `>=${Number(policy.min_attempted || 0)}`
    },
    {
      name: 'verified_rate',
      pass: verifiedRate >= Number(policy.min_verified_rate || 0),
      value: verifiedRate,
      target: `>=${Number(policy.min_verified_rate || 0)}`
    },
    {
      name: 'reverted_rate',
      pass: revertedRate <= Number(policy.max_reverted_rate || 1),
      value: revertedRate,
      target: `<=${Number(policy.max_reverted_rate || 1)}`
    },
    {
      name: 'stop_ratio',
      pass: stopRatio <= Number(policy.max_stop_ratio || 1),
      value: stopRatio,
      target: `<=${Number(policy.max_stop_ratio || 1)}`
    },
    {
      name: 'min_shipped',
      pass: shipped >= Number(policy.min_shipped || 0),
      value: shipped,
      target: `>=${Number(policy.min_shipped || 0)}`
    }
  ];

  const failed = checks.filter(c => c.pass !== true).map(c => c.name);
  const mode = strategyExecutionMode(strategy, 'execute');
  const ready = failed.length === 0;
  const recommendedMode = mode === 'execute'
    ? 'execute'
    : (mode === 'canary_execute'
      ? (ready ? 'canary_execute' : 'score_only')
      : (ready ? 'execute_candidate' : 'score_only'));

  return {
    current_mode: mode,
    ready_for_execute: ready,
    recommended_mode: recommendedMode,
    checks,
    failed_checks: failed,
    metrics: {
      attempted,
      verified_rate: verifiedRate,
      executed,
      shipped,
      reverted,
      reverted_rate: revertedRate,
      stopped,
      total_runs: totalRuns,
      stop_ratio: stopRatio
    }
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '');
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd !== 'run') {
    usage();
    process.exit(2);
  }

  const dateStr = isDateStr(args._[1]) ? String(args._[1]) : todayStr();
  const strict = args.strict === true;
  let strategy = null;
  try {
    strategy = loadActiveStrategy({
      allowMissing: false,
      strict,
      id: args.id ? String(args.id) : undefined
    });
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: String(err && err.message || err || 'strategy_load_failed')
    }) + '\n');
    process.exit(1);
  }

  const promotion = strategyPromotionPolicy(strategy, {});
  const requestedDays = clampInt(args.days, 1, 90, Number(promotion.min_days || 7));
  const days = Math.max(requestedDays, Number(promotion.min_days || 7));
  const summary = summarizeForDate(dateStr, days);
  const readiness = evaluateReadiness(strategy, summary, promotion, days);

  const out = {
    ok: true,
    ts: new Date().toISOString(),
    date: dateStr,
    strategy: {
      id: strategy.id,
      name: strategy.name,
      status: strategy.status,
      mode: strategyExecutionMode(strategy, 'execute'),
      promotion_policy: promotion
    },
    summary_window: summary.window,
    readiness
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluateReadiness
};
