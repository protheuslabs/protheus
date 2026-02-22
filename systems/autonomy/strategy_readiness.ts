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
  const out = { _: [] } as Record<string, any>;
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
  const pol = (policy && typeof policy === 'object' ? policy : {}) as Record<string, any>;
  const runs = summary && summary.runs ? summary.runs : {};
  const receipts = summary && summary.receipts && summary.receipts.combined ? summary.receipts.combined : {};
  const autonomyReceipts = summary && summary.receipts && summary.receipts.autonomy ? summary.receipts.autonomy : {};
  const executedOutcomes = runs.executed_outcomes || {};
  const objectiveScorecard = runs.objective_scorecard && typeof runs.objective_scorecard === 'object'
    ? runs.objective_scorecard
    : {};
  const executed = Number(runs.executed || 0);
  const shipped = Number(executedOutcomes.shipped || 0);
  const reverted = Number(executedOutcomes.reverted || 0);
  const stopped = Number(runs.stopped || 0);
  const totalRuns = Number(runs.total || 0);
  const attempted = Number(receipts.attempted || 0);
  const verifiedRate = Number(receipts.verified_rate || 0);
  const criteriaQualityReceipts = Number(autonomyReceipts.success_criteria_quality_receipts || 0);
  const criteriaQualityPassRate = Number(autonomyReceipts.success_criteria_quality_receipt_pass_rate || 0);
  const criteriaLegacyReceipts = Number(autonomyReceipts.success_criteria_receipts || 0);
  const criteriaLegacyPassRate = Number(autonomyReceipts.success_criteria_receipt_pass_rate || 0);
  const criteriaQualityInsufficientReceipts = Number(
    autonomyReceipts.success_criteria_quality_filtered_receipts
    || autonomyReceipts.success_criteria_quality_insufficient_receipts
    || 0
  );
  const criteriaQualityInsufficientRateRaw = Number(autonomyReceipts.success_criteria_quality_insufficient_rate);
  const criteriaQualityInsufficientRate = Number.isFinite(criteriaQualityInsufficientRateRaw)
    ? criteriaQualityInsufficientRateRaw
    : safeRate(criteriaQualityInsufficientReceipts, criteriaLegacyReceipts);
  const minCriteriaReceipts = Number(pol.min_success_criteria_receipts || 0);
  const minCriteriaPassRate = Number(pol.min_success_criteria_pass_rate || 0.6);
  const disableLegacyFallbackAfterQualityReceipts = Number(
    pol.disable_legacy_fallback_after_quality_receipts != null
      ? pol.disable_legacy_fallback_after_quality_receipts
      : 10
  );
  const maxQualityInsufficientRate = Number(
    pol.max_success_criteria_quality_insufficient_rate != null
      ? pol.max_success_criteria_quality_insufficient_rate
      : 0.4
  );
  const forceQualityCriteria = criteriaQualityReceipts >= Math.max(0, disableLegacyFallbackAfterQualityReceipts);
  const useQualityCriteria = forceQualityCriteria || criteriaQualityReceipts >= minCriteriaReceipts;
  const criteriaReceipts = useQualityCriteria ? criteriaQualityReceipts : criteriaLegacyReceipts;
  const criteriaPassRate = useQualityCriteria ? criteriaQualityPassRate : criteriaLegacyPassRate;
  const criteriaSource = useQualityCriteria
    ? (forceQualityCriteria ? 'quality_forced' : 'quality')
    : 'legacy_fallback';
  const minObjectiveCoverage = Number(pol.min_objective_coverage || 0);
  const maxObjectiveNoProgressRate = Number(pol.max_objective_no_progress_rate || 1);
  const objectiveRows = Object.values(objectiveScorecard as Record<string, any>) as Array<Record<string, any>>;
  const objectiveAttempts = objectiveRows.reduce((acc, row) => acc + Number(row && row.attempts || 0), 0);
  const objectiveNoProgress = objectiveRows.reduce(
    (acc, row) => acc + Number(row && row.no_change || 0) + Number(row && row.reverted || 0),
    0
  );
  const objectiveCoverage = safeRate(objectiveAttempts, attempted);
  const objectiveNoProgressRate = safeRate(objectiveNoProgress, objectiveAttempts);
  const revertedRate = safeRate(reverted, executed);
  const stopRatio = safeRate(stopped, totalRuns);
  const policyDays = Number(pol.min_days || 7);
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
    },
    {
      name: 'success_criteria_receipts',
      pass: criteriaReceipts >= minCriteriaReceipts,
      value: criteriaReceipts,
      target: `>=${minCriteriaReceipts}`
    },
    {
      name: 'success_criteria_pass_rate',
      pass: criteriaReceipts >= minCriteriaReceipts && criteriaPassRate >= minCriteriaPassRate,
      value: criteriaReceipts >= minCriteriaReceipts ? criteriaPassRate : null,
      target: criteriaReceipts >= minCriteriaReceipts ? `>=${minCriteriaPassRate}` : `requires_receipts>=${minCriteriaReceipts}`
    },
    {
      name: 'success_criteria_quality_insufficient_rate',
      pass: useQualityCriteria
        ? criteriaQualityInsufficientRate <= maxQualityInsufficientRate
        : true,
      value: useQualityCriteria ? criteriaQualityInsufficientRate : null,
      target: useQualityCriteria
        ? `<=${maxQualityInsufficientRate}`
        : 'n/a(legacy_fallback)'
    },
    {
      name: 'objective_coverage',
      pass: objectiveCoverage >= minObjectiveCoverage,
      value: objectiveCoverage,
      target: `>=${minObjectiveCoverage}`
    },
    {
      name: 'objective_no_progress_rate',
      pass: objectiveAttempts > 0
        ? objectiveNoProgressRate <= maxObjectiveNoProgressRate
        : minObjectiveCoverage <= 0,
      value: objectiveAttempts > 0 ? objectiveNoProgressRate : null,
      target: objectiveAttempts > 0 ? `<=${maxObjectiveNoProgressRate}` : 'n/a(no_objective_attempts)'
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
      success_criteria_receipts: criteriaReceipts,
      success_criteria_source: criteriaSource,
      success_criteria_fallback_retired: forceQualityCriteria,
      success_criteria_quality_receipts: criteriaQualityReceipts,
      success_criteria_legacy_receipts: criteriaLegacyReceipts,
      success_criteria_quality_insufficient_receipts: criteriaQualityInsufficientReceipts,
      success_criteria_quality_insufficient_rate: criteriaLegacyReceipts > 0
        ? criteriaQualityInsufficientRate
        : null,
      min_success_criteria_receipts: minCriteriaReceipts,
      disable_legacy_fallback_after_quality_receipts: Math.max(0, disableLegacyFallbackAfterQualityReceipts),
      max_success_criteria_quality_insufficient_rate: maxQualityInsufficientRate,
      success_criteria_pass_rate: criteriaReceipts >= minCriteriaReceipts ? criteriaPassRate : null,
      objective_attempts: objectiveAttempts,
      objective_coverage: objectiveCoverage,
      min_objective_coverage: minObjectiveCoverage,
      objective_no_progress_rate: objectiveAttempts > 0 ? objectiveNoProgressRate : null,
      max_objective_no_progress_rate: maxObjectiveNoProgressRate,
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
export {};
