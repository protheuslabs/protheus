#!/usr/bin/env node
'use strict';
// TypeScript compatibility shim only.
// Layer ownership: core/layer0/ops (swarm-runtime authority); this file is a thin CLI bridge.

const path = require('path');
const { runProtheusOps, ROOT } = require('../ops/run_protheus_ops.js');

const DEFAULT_STATE_PATH = path.join(
  ROOT,
  'local',
  'state',
  'ops',
  'swarm_orchestration_runtime_latest.json'
);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx >= 0) {
      out[token.slice(2, idx)] = token.slice(idx + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function intFlag(value, fallback) {
  const n = Number.parseInt(String(value == null ? '' : value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function optionalIntFlag(value, min = 1) {
  const n = Number.parseInt(String(value == null ? '' : value), 10);
  if (!Number.isFinite(n)) return null;
  if (n < min) return null;
  return n;
}

function optionalFloatFlag(value, min = 0, max = 1) {
  const n = Number.parseFloat(String(value == null ? '' : value));
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function statePath(parsed) {
  const explicit = String(parsed['state-path'] || '').trim();
  return explicit || DEFAULT_STATE_PATH;
}

function withState(args, parsed) {
  if (args.some((arg) => String(arg).startsWith('--state-path='))) return args;
  return args.concat(`--state-path=${statePath(parsed)}`);
}

function runOps(args) {
  return runProtheusOps(args, { unknownDomainFallback: true });
}

function runRecursive(parsed) {
  const levels = Math.max(2, intFlag(parsed.levels || parsed.team_size, 5));
  const maxDepth = Math.max(levels + 1, intFlag(parsed['max-depth'], levels + 1));
  const args = withState(
    [
      'swarm-runtime',
      'test',
      'recursive',
      `--levels=${levels}`,
      `--max-depth=${maxDepth}`,
    ],
    parsed
  );
  return runOps(args);
}

function runByzantine(parsed) {
  const agents = Math.max(3, intFlag(parsed.agents || parsed.team_size, 5));
  const corruptDefault = Math.max(1, Math.floor(agents / 3));
  const corrupt = Math.max(1, intFlag(parsed.corrupt, corruptDefault));
  const enableArgs = withState(['swarm-runtime', 'byzantine-test', 'enable'], parsed);
  const enableStatus = runOps(enableArgs);
  if (enableStatus !== 0) return enableStatus;
  const testArgs = withState(
    ['swarm-runtime', 'test', 'byzantine', `--agents=${agents}`, `--corrupt=${corrupt}`],
    parsed
  );
  return runOps(testArgs);
}

function runCommunication(parsed) {
  const delivery = String(parsed.delivery || 'at_least_once').trim() || 'at_least_once';
  const simulateFirstAttemptFail = String(parsed['simulate-first-attempt-fail'] || '1').trim();
  const args = withState(
    [
      'swarm-runtime',
      'test',
      'communication',
      `--delivery=${delivery}`,
      `--simulate-first-attempt-fail=${simulateFirstAttemptFail}`,
    ],
    parsed
  );
  return runOps(args);
}

function runAllCriticalTests(parsed) {
  const t2 = runRecursive(parsed);
  if (t2 !== 0) return t2;
  const t3 = runByzantine(parsed);
  if (t3 !== 0) return t3;
  return runCommunication(parsed);
}

function runSpawn(parsed) {
  const objective = String(parsed.objective || parsed.task || 'generic').trim() || 'generic';
  const teamSize = Math.max(1, intFlag(parsed.team_size, 3));
  const args = [
    'swarm-runtime',
    'spawn',
    `--task=objective:${objective}`,
    '--recursive=1',
    `--levels=${Math.max(2, teamSize)}`,
    '--verify=1',
    '--metrics=detailed',
  ];

  const tokenBudget = optionalIntFlag(parsed['token-budget'] ?? parsed.token_budget, 1);
  if (tokenBudget != null) args.push(`--token-budget=${tokenBudget}`);

  const tokenWarningAt = optionalFloatFlag(
    parsed['token-warning-at'] ?? parsed.token_warning_at,
    0,
    1
  );
  if (tokenWarningAt != null) args.push(`--token-warning-at=${tokenWarningAt}`);

  const onBudgetExhausted = String(
    parsed['on-budget-exhausted'] ?? parsed.on_budget_exhausted ?? ''
  )
    .trim()
    .toLowerCase();
  if (onBudgetExhausted === 'fail' || onBudgetExhausted === 'warn' || onBudgetExhausted === 'compact') {
    args.push(`--on-budget-exhausted=${onBudgetExhausted}`);
  }

  if (Object.prototype.hasOwnProperty.call(parsed, 'adaptive-complexity')) {
    args.push(`--adaptive-complexity=${String(parsed['adaptive-complexity'])}`);
  }

  const finalArgs = withState(args, parsed);
  return runOps(finalArgs);
}

function printUsage() {
  process.stdout.write(
    [
      'Usage:',
      '  node client/runtime/systems/autonomy/swarm_orchestration_runtime.ts run [--objective=<name>] [--team_size=<n>] [--token-budget=<n>] [--token-warning-at=<0..1>] [--on-budget-exhausted=<fail|warn|compact>] [--adaptive-complexity=1|0] [--state-path=<path>]',
      '  node client/runtime/systems/autonomy/swarm_orchestration_runtime.ts test --id=<2|3|6|all> [flags]',
      '  node client/runtime/systems/autonomy/swarm_orchestration_runtime.ts status [--state-path=<path>]',
      '',
      'Test IDs:',
      '  2 -> recursive decomposition',
      '  3 -> byzantine fault mode',
      '  6 -> inter-agent communication',
      '  all -> runs 2, 3, 6 in sequence',
      '',
    ].join('\n')
  );
}

function run(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const command = String(parsed._[0] || 'run').trim().toLowerCase();

  if (command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return 0;
  }

  if (command === 'status') {
    return runOps(withState(['swarm-runtime', 'status'], parsed));
  }

  if (command === 'run') {
    return runSpawn(parsed);
  }

  if (command === 'test') {
    const id = String(parsed.id || parsed._[1] || 'all').trim().toLowerCase();
    if (id === '2' || id === 'recursive') return runRecursive(parsed);
    if (id === '3' || id === 'byzantine') return runByzantine(parsed);
    if (id === '6' || id === 'communication') return runCommunication(parsed);
    if (id === 'all') return runAllCriticalTests(parsed);
    process.stderr.write(`unknown_test_id:${id}\n`);
    return 2;
  }

  if (command === 'test2') return runRecursive(parsed);
  if (command === 'test3') return runByzantine(parsed);
  if (command === 'test6') return runCommunication(parsed);

  process.stderr.write(`unknown_command:${command}\n`);
  printUsage();
  return 2;
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = {
  DEFAULT_STATE_PATH,
  parseArgs,
  runRecursive,
  runByzantine,
  runCommunication,
  runAllCriticalTests,
  runSpawn,
  run,
};
