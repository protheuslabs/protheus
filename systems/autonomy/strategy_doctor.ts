#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  listStrategies,
  loadActiveStrategy,
  strategyExecutionMode,
  strategyBudgetCaps,
  strategyExplorationPolicy,
  strategyPromotionPolicy,
  strategyMaxRiskPerAction,
  strategyDuplicateWindowHours,
  strategyCanaryDailyExecLimit
} = require('../../lib/strategy_resolver');

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/strategy_doctor.js [--id=<strategy_id>] [--strict]');
  console.log('  node systems/autonomy/strategy_doctor.js --help');
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args._.length && (args.help || process.argv.length <= 2 || process.argv[2] === '--help' || process.argv[2] === '-h' || process.argv[2] === 'help')) {
    usage();
    process.exit(0);
  }
  if (args._.length && !String(args._[0]).startsWith('--')) {
    const cmd = String(args._[0] || '');
    if (cmd && cmd !== 'run') {
      usage();
      process.exit(2);
    }
  }

  const strict = args.strict === true;
  const id = args.id ? String(args.id) : undefined;
  const all = listStrategies();
  let active = null;
  try {
    active = loadActiveStrategy({ allowMissing: true, strict, id });
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      strict,
      error: String(err && err.message || err || 'strategy_load_failed')
    }) + '\n');
    process.exit(1);
  }

  const out = {
    ok: true,
    strict,
    strategy_count: all.length,
    active_strategy_id: active ? active.id : null,
    active_strategy: active
      ? {
          id: active.id,
          name: active.name,
          status: active.status,
          file: path.relative(path.resolve(__dirname, '..', '..'), active.file).replace(/\\/g, '/'),
          execution_mode: strategyExecutionMode(active, 'execute'),
          canary_daily_exec_limit: strategyCanaryDailyExecLimit(active, null),
          risk_policy: {
            allowed_risks: Array.isArray(active.risk_policy && active.risk_policy.allowed_risks)
              ? active.risk_policy.allowed_risks
              : [],
            max_risk_per_action: strategyMaxRiskPerAction(active, null)
          },
          admission_policy: {
            max_remediation_depth: active.admission_policy && Number.isFinite(Number(active.admission_policy.max_remediation_depth))
              ? Number(active.admission_policy.max_remediation_depth)
              : null,
            duplicate_window_hours: strategyDuplicateWindowHours(active, 24)
          },
          budget_policy: strategyBudgetCaps(active, {}),
          exploration_policy: strategyExplorationPolicy(active, {}),
          promotion_policy: strategyPromotionPolicy(active, {}),
          validation: active.validation || { strict_ok: true, errors: [], warnings: [] }
        }
      : null,
    strategies: all.map((s) => ({
      id: s.id,
      status: s.status,
      file: path.relative(path.resolve(__dirname, '..', '..'), s.file).replace(/\\/g, '/'),
      strict_ok: !!(s.validation && s.validation.strict_ok !== false),
      errors: s.validation && Array.isArray(s.validation.errors) ? s.validation.errors : [],
      warnings: s.validation && Array.isArray(s.validation.warnings) ? s.validation.warnings : []
    }))
  };

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main();
export {};
