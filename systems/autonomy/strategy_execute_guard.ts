#!/usr/bin/env node
'use strict';

/**
 * strategy_execute_guard.js
 *
 * Auto-reverts strategy execution mode from execute-family -> score_only when
 * readiness remains failing for consecutive runs.
 *
 * Usage:
 *   node systems/autonomy/strategy_execute_guard.js run [YYYY-MM-DD] [--days=N] [--id=<strategy_id>] [--strict]
 *   node systems/autonomy/strategy_execute_guard.js status [--id=<strategy_id>]
 *   node systems/autonomy/strategy_execute_guard.js --help
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadActiveStrategy, strategyExecutionMode } = require('../../lib/strategy_resolver.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const READINESS_SCRIPT = path.join(REPO_ROOT, 'systems', 'autonomy', 'strategy_readiness.js');
const GUARD_STATE_PATH = process.env.AUTONOMY_EXECUTE_GUARD_STATE
  ? path.resolve(process.env.AUTONOMY_EXECUTE_GUARD_STATE)
  : path.join(REPO_ROOT, 'state', 'autonomy', 'strategy_execute_guard.json');
const MODE_AUDIT_LOG_PATH = process.env.AUTONOMY_STRATEGY_MODE_LOG
  ? path.resolve(process.env.AUTONOMY_STRATEGY_MODE_LOG)
  : path.join(REPO_ROOT, 'state', 'autonomy', 'strategy_mode_changes.jsonl');
const MAX_CONSEC_NOT_READY = Number(process.env.AUTONOMY_EXECUTE_GUARD_MAX_CONSEC || 2);
const AUTONOMY_CANARY_RELAX_ENABLED = String(process.env.AUTONOMY_CANARY_RELAX_ENABLED || '1') !== '0';
const AUTONOMY_CANARY_RELAX_READINESS_CHECKS = new Set(
  String(process.env.AUTONOMY_CANARY_RELAX_READINESS_CHECKS || 'success_criteria_pass_rate')
    .split(',')
    .map((v) => String(v || '').trim())
    .filter(Boolean)
);

function isExecuteMode(mode) {
  return mode === 'execute' || mode === 'canary_execute';
}

function canaryFailedChecksAllowed(failedChecks) {
  const failed = Array.isArray(failedChecks)
    ? failedChecks.map((v) => String(v || '').trim()).filter(Boolean)
    : [];
  if (!failed.length || AUTONOMY_CANARY_RELAX_READINESS_CHECKS.size === 0) return false;
  for (const check of failed) {
    if (!AUTONOMY_CANARY_RELAX_READINESS_CHECKS.has(check)) return false;
  }
  return true;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/strategy_execute_guard.js run [YYYY-MM-DD] [--days=N] [--id=<strategy_id>] [--strict]');
  console.log('  node systems/autonomy/strategy_execute_guard.js status [--id=<strategy_id>]');
  console.log('  node systems/autonomy/strategy_execute_guard.js --help');
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

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function isDateStr(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
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
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function runReadiness({ date, days, id, strict }) {
  const args = ['run', date];
  if (days != null) args.push(`--days=${days}`);
  if (id) args.push(`--id=${id}`);
  if (strict) args.push('--strict');
  const r = spawnSync('node', [READINESS_SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  const stdout = String(r.stdout || '').trim();
  let payload = null;
  if (stdout) {
    try { payload = JSON.parse(stdout); } catch {}
  }
  return {
    ok: r.status === 0,
    code: r.status || 0,
    payload,
    stderr: String(r.stderr || '').trim(),
    stdout
  };
}

function readGuardState() {
  const raw = readJsonSafe(GUARD_STATE_PATH, {});
  if (!raw || typeof raw !== 'object') return { by_strategy: {} };
  const by = raw.by_strategy && typeof raw.by_strategy === 'object' ? raw.by_strategy : {};
  return { by_strategy: by };
}

function writeGuardState(state) {
  writeJsonAtomic(GUARD_STATE_PATH, state && typeof state === 'object' ? state : { by_strategy: {} });
}

function loadStrategy(args) {
  return loadActiveStrategy({
    allowMissing: false,
    id: args.id ? String(args.id) : undefined,
    strict: args.strict === true
  });
}

function cmdStatus(args) {
  const strategy = loadStrategy(args);
  const state = readGuardState();
  const ent = state.by_strategy && state.by_strategy[strategy.id]
    ? state.by_strategy[strategy.id]
    : { consecutive_not_ready: 0, last_result: null };
  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    strategy: {
      id: strategy.id,
      mode: strategyExecutionMode(strategy, 'execute'),
      file: path.relative(REPO_ROOT, strategy.file).replace(/\\/g, '/')
    },
    guard: {
      max_consecutive_not_ready: MAX_CONSEC_NOT_READY,
      consecutive_not_ready: Number(ent.consecutive_not_ready || 0),
      last_result: ent.last_result || null
    }
  }, null, 2) + '\n');
}

function cmdRun(args) {
  const strategy = loadStrategy(args);
  const mode = strategyExecutionMode(strategy, 'execute');
  const date = isDateStr(args._[1]) ? String(args._[1]) : todayStr();
  const days = args.days != null ? Number(args.days) : undefined;
  const state = readGuardState();
  const prior = state.by_strategy && state.by_strategy[strategy.id]
    ? state.by_strategy[strategy.id]
    : { consecutive_not_ready: 0 };

  if (!isExecuteMode(mode)) {
    const next = {
      consecutive_not_ready: 0,
      last_result: 'mode_not_execute',
      updated_at: nowIso()
    };
    state.by_strategy = state.by_strategy || {};
    state.by_strategy[strategy.id] = next;
    writeGuardState(state);
    process.stdout.write(JSON.stringify({
      ok: true,
      ts: nowIso(),
      result: 'mode_not_execute',
      strategy_id: strategy.id,
      mode
    }) + '\n');
    return;
  }

  const rep = runReadiness({
    date,
    days,
    id: strategy.id,
    strict: args.strict === true
  });
  if (!rep.ok || !rep.payload || rep.payload.ok !== true) {
    process.stdout.write(JSON.stringify({
      ok: false,
      ts: nowIso(),
      error: 'readiness_unavailable',
      detail: rep.stderr || rep.stdout || `readiness_exit_${rep.code}`
    }) + '\n');
    process.exit(1);
  }

  const ready = !!(rep.payload.readiness && rep.payload.readiness.ready_for_execute === true);
  const readiness = rep.payload && rep.payload.readiness && typeof rep.payload.readiness === 'object'
    ? rep.payload.readiness
    : null;
  const failedChecks = Array.isArray(readiness && readiness.failed_checks) ? readiness.failed_checks : [];
  const relaxedCanaryReadiness = AUTONOMY_CANARY_RELAX_ENABLED
    && mode === 'canary_execute'
    && canaryFailedChecksAllowed(failedChecks);
  const readyForGuard = ready || relaxedCanaryReadiness;
  let consecutive = Number(prior.consecutive_not_ready || 0);
  if (readyForGuard) consecutive = 0;
  else consecutive += 1;

  const shouldRevert = !readyForGuard && MAX_CONSEC_NOT_READY > 0 && consecutive >= MAX_CONSEC_NOT_READY;
  state.by_strategy = state.by_strategy || {};
  state.by_strategy[strategy.id] = {
    consecutive_not_ready: consecutive,
    last_result: shouldRevert
      ? 'auto_reverted_to_score_only'
      : (ready ? 'ready' : (relaxedCanaryReadiness ? 'canary_relaxed_ready' : 'not_ready')),
    updated_at: nowIso()
  };

  if (!shouldRevert) {
    writeGuardState(state);
    process.stdout.write(JSON.stringify({
      ok: true,
      ts: nowIso(),
      result: ready ? 'ready' : (relaxedCanaryReadiness ? 'canary_relaxed_ready' : 'not_ready'),
      strategy_id: strategy.id,
      consecutive_not_ready: consecutive,
      max_consecutive_not_ready: MAX_CONSEC_NOT_READY,
      readiness: readiness,
      readiness_relaxed: relaxedCanaryReadiness,
      readiness_relaxed_checks: relaxedCanaryReadiness ? Array.from(AUTONOMY_CANARY_RELAX_READINESS_CHECKS) : []
    }, null, 2) + '\n');
    return;
  }

  const raw = readJsonSafe(strategy.file, {});
  const next = raw && typeof raw === 'object' ? { ...raw } : {};
  next.execution_policy = {
    ...(next.execution_policy && typeof next.execution_policy === 'object' ? next.execution_policy : {}),
    mode: 'score_only'
  };
  writeJsonAtomic(strategy.file, next);
  writeGuardState(state);

  const evt = {
    ts: nowIso(),
    type: 'strategy_mode_auto_revert',
    strategy_id: strategy.id,
    file: path.relative(REPO_ROOT, strategy.file).replace(/\\/g, '/'),
    from_mode: mode,
    to_mode: 'score_only',
    reason: 'execute_guard_not_ready_consecutive',
    consecutive_not_ready: consecutive,
    threshold: MAX_CONSEC_NOT_READY,
    readiness: rep.payload.readiness || null
  };
  appendJsonl(MODE_AUDIT_LOG_PATH, evt);

  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    result: 'auto_reverted_to_score_only',
    ...evt
  }, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help) {
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
export {};
