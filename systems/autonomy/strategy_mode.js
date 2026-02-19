#!/usr/bin/env node
'use strict';

/**
 * strategy_mode.js
 *
 * Safe strategy execution mode manager.
 * - status: inspect active/requested strategy mode
 * - recommend: proxy readiness recommendation
 * - set: change execution mode with approval note + readiness gate
 *
 * Usage:
 *   node systems/autonomy/strategy_mode.js status [--id=<strategy_id>]
 *   node systems/autonomy/strategy_mode.js recommend [YYYY-MM-DD] [--days=N] [--id=<strategy_id>] [--strict]
 *   node systems/autonomy/strategy_mode.js set --mode=score_only|execute [--id=<strategy_id>] --approval-note="..."
 *      [--approver-id=<id> --second-approver-id=<id> --second-approval-note="..."]
 *      [--date=YYYY-MM-DD] [--days=N] [--strict] [--force=1]
 *   node systems/autonomy/strategy_mode.js --help
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadActiveStrategy, strategyExecutionMode } = require('../../lib/strategy_resolver.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const READINESS_SCRIPT = path.join(REPO_ROOT, 'systems', 'autonomy', 'strategy_readiness.js');
const AUDIT_LOG_PATH = process.env.AUTONOMY_STRATEGY_MODE_LOG
  ? path.resolve(process.env.AUTONOMY_STRATEGY_MODE_LOG)
  : path.join(REPO_ROOT, 'state', 'autonomy', 'strategy_mode_changes.jsonl');
const REQUIRE_DUAL_APPROVER_FOR_EXECUTE = String(process.env.AUTONOMY_REQUIRE_DUAL_APPROVER_FOR_EXECUTE || '1') !== '0';
const MODE_CHANGE_MIN_HOURS = Number(process.env.AUTONOMY_STRATEGY_MODE_MIN_HOURS_BETWEEN_CHANGES || 6);

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/strategy_mode.js status [--id=<strategy_id>]');
  console.log('  node systems/autonomy/strategy_mode.js recommend [YYYY-MM-DD] [--days=N] [--id=<strategy_id>] [--strict]');
  console.log('  node systems/autonomy/strategy_mode.js set --mode=score_only|execute [--id=<strategy_id>] --approval-note="..."');
  console.log('    [--approver-id=<id> --second-approver-id=<id> --second-approval-note="..."]');
  console.log('    [--date=YYYY-MM-DD] [--days=N] [--strict] [--force=1]');
  console.log('  node systems/autonomy/strategy_mode.js --help');
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

function appendJsonl(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonlSafe(filePath) {
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

function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
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
    try {
      payload = JSON.parse(stdout);
    } catch {}
  }
  return {
    ok: r.status === 0,
    code: r.status || 0,
    payload,
    stderr: String(r.stderr || '').trim(),
    stdout
  };
}

function lastModeChangeEvent(strategyId) {
  const rows = readJsonlSafe(AUDIT_LOG_PATH);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row || row.type !== 'strategy_mode_change') continue;
    if (strategyId && String(row.strategy_id || '') !== String(strategyId)) continue;
    return row;
  }
  return null;
}

function modeChangeCooldownState(last) {
  const minHours = Number.isFinite(MODE_CHANGE_MIN_HOURS) ? Math.max(0, MODE_CHANGE_MIN_HOURS) : 0;
  const out = {
    min_hours_between_changes: minHours,
    active: false,
    remaining_minutes: 0
  };
  if (!last || !last.ts || minHours <= 0) return out;
  const ts = new Date(String(last.ts));
  if (Number.isNaN(ts.getTime())) return out;
  const minMs = minHours * 60 * 60 * 1000;
  const ageMs = Date.now() - ts.getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= minMs) return out;
  out.active = true;
  out.remaining_minutes = Math.ceil((minMs - ageMs) / (60 * 1000));
  return out;
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
  const last = lastModeChangeEvent(strategy.id);
  const cooldown = modeChangeCooldownState(last);
  const out = {
    ok: true,
    ts: nowIso(),
    strategy: {
      id: strategy.id,
      name: strategy.name,
      status: strategy.status,
      file: path.relative(REPO_ROOT, strategy.file).replace(/\\/g, '/'),
      mode: strategyExecutionMode(strategy, 'execute'),
      validation: strategy.validation || { strict_ok: true, errors: [], warnings: [] },
      mode_change_min_hours_between_changes: cooldown.min_hours_between_changes,
      last_mode_change: last ? {
        ts: String(last.ts || ''),
        from_mode: String(last.from_mode || ''),
        to_mode: String(last.to_mode || ''),
        force: last.force === true
      } : null,
      mode_change_cooldown: cooldown
    }
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function cmdRecommend(args) {
  const date = isDateStr(args._[1]) ? String(args._[1]) : todayStr();
  const days = args.days != null ? Number(args.days) : undefined;
  const rep = runReadiness({
    date,
    days,
    id: args.id ? String(args.id) : undefined,
    strict: args.strict === true
  });
  if (!rep.ok || !rep.payload || rep.payload.ok !== true) {
    process.stdout.write(JSON.stringify({
      ok: false,
      ts: nowIso(),
      error: rep.stderr || rep.stdout || `readiness_exit_${rep.code}`
    }) + '\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(rep.payload, null, 2) + '\n');
}

function cmdSet(args) {
  const mode = String(args.mode || '').trim().toLowerCase();
  if (mode !== 'score_only' && mode !== 'execute') {
    process.stdout.write(JSON.stringify({
      ok: false,
      ts: nowIso(),
      error: 'invalid --mode (expected score_only|execute)'
    }) + '\n');
    process.exit(2);
  }

  const approvalNote = String(args['approval-note'] || args.approval_note || '').trim();
  if (approvalNote.length < 10) {
    process.stdout.write(JSON.stringify({
      ok: false,
      ts: nowIso(),
      error: 'approval_note_too_short',
      min_len: 10
    }) + '\n');
    process.exit(2);
  }

  const strategy = loadStrategy(args);
  const priorMode = strategyExecutionMode(strategy, 'execute');
  if (priorMode === mode) {
    process.stdout.write(JSON.stringify({
      ok: true,
      ts: nowIso(),
      result: 'no_change',
      strategy_id: strategy.id,
      mode
    }) + '\n');
    return;
  }

  const force = String(args.force || '0') === '1';
  const date = isDateStr(args.date) ? String(args.date) : todayStr();
  const days = args.days != null ? Number(args.days) : undefined;
  const changeReason = String(args.reason || '').trim().slice(0, 180);
  let readiness = null;
  const approverId = String(args['approver-id'] || args.approver_id || '').trim();
  const secondApproverId = String(args['second-approver-id'] || args.second_approver_id || '').trim();
  const secondApprovalNote = String(args['second-approval-note'] || args.second_approval_note || '').trim();

  if (mode === 'execute' && REQUIRE_DUAL_APPROVER_FOR_EXECUTE) {
    if (!approverId || !secondApproverId) {
      process.stdout.write(JSON.stringify({
        ok: false,
        ts: nowIso(),
        error: 'dual_approval_missing_approver_id',
        required_flags: ['--approver-id', '--second-approver-id', '--second-approval-note']
      }) + '\n');
      process.exit(2);
    }
    if (approverId === secondApproverId) {
      process.stdout.write(JSON.stringify({
        ok: false,
        ts: nowIso(),
        error: 'dual_approval_same_approver'
      }) + '\n');
      process.exit(2);
    }
    if (secondApprovalNote.length < 10) {
      process.stdout.write(JSON.stringify({
        ok: false,
        ts: nowIso(),
        error: 'second_approval_note_too_short',
        min_len: 10
      }) + '\n');
      process.exit(2);
    }
    if (secondApprovalNote === approvalNote) {
      process.stdout.write(JSON.stringify({
        ok: false,
        ts: nowIso(),
        error: 'dual_approval_notes_must_differ'
      }) + '\n');
      process.exit(2);
    }
  }

  if (mode === 'execute' && !force && Number.isFinite(MODE_CHANGE_MIN_HOURS) && MODE_CHANGE_MIN_HOURS > 0) {
    const last = lastModeChangeEvent(strategy.id);
    if (last && last.ts) {
      const ts = new Date(String(last.ts));
      const ageMs = Date.now() - ts.getTime();
      if (Number.isFinite(ageMs) && ageMs >= 0) {
        const minMs = MODE_CHANGE_MIN_HOURS * 60 * 60 * 1000;
        if (ageMs < minMs) {
          const remainingMinutes = Math.ceil((minMs - ageMs) / (60 * 1000));
          process.stdout.write(JSON.stringify({
            ok: false,
            ts: nowIso(),
            error: 'mode_change_cooldown_active',
            min_hours_between_changes: MODE_CHANGE_MIN_HOURS,
            remaining_minutes: remainingMinutes,
            last_change: {
              ts: String(last.ts || ''),
              from_mode: String(last.from_mode || ''),
              to_mode: String(last.to_mode || ''),
              force: last.force === true
            }
          }) + '\n');
          process.exit(1);
        }
      }
    }
  }

  if (mode === 'execute' && !force) {

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
    readiness = rep.payload;
    if (!readiness.readiness || readiness.readiness.ready_for_execute !== true) {
      process.stdout.write(JSON.stringify({
        ok: false,
        ts: nowIso(),
        error: 'not_ready_for_execute',
        readiness
      }) + '\n');
      process.exit(1);
    }
  }

  const raw = readJsonSafe(strategy.file, {});
  const next = raw && typeof raw === 'object' ? { ...raw } : {};
  next.execution_policy = {
    ...(next.execution_policy && typeof next.execution_policy === 'object' ? next.execution_policy : {}),
    mode
  };
  writeJsonAtomic(strategy.file, next);

  const evt = {
    ts: nowIso(),
    type: 'strategy_mode_change',
    strategy_id: strategy.id,
    file: path.relative(REPO_ROOT, strategy.file).replace(/\\/g, '/'),
    from_mode: priorMode,
    to_mode: mode,
    force,
    approval_note: approvalNote.slice(0, 240),
    change_reason: changeReason || null,
    approver_id: approverId || null,
    second_approver_id: secondApproverId || null,
    second_approval_note: secondApprovalNote ? secondApprovalNote.slice(0, 240) : null,
    dual_approval_required: REQUIRE_DUAL_APPROVER_FOR_EXECUTE,
    readiness: readiness && readiness.readiness ? readiness.readiness : null
  };
  appendJsonl(AUDIT_LOG_PATH, evt);

  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    result: 'mode_changed',
    ...evt
  }, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '');
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }

  if (cmd === 'status') return cmdStatus(args);
  if (cmd === 'recommend') return cmdRecommend(args);
  if (cmd === 'set') return cmdSet(args);

  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
