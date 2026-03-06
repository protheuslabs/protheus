#!/usr/bin/env node
'use strict';

/**
 * dr_gameday.js
 *
 * Deterministic disaster-recovery game-day runner:
 * - Runs backup snapshot
 * - Verifies snapshot integrity
 * - Evaluates RTO/RPO against policy thresholds
 * - Emits immutable receipts for release gating
 *
 * Usage:
 *   node systems/ops/dr_gameday.js run [--channel=state_backup|blank_slate] [--profile=<id>] [--dest=<abs_path>] [--strict=1|0]
 *   node systems/ops/dr_gameday.js list [--limit=N]
 *   node systems/ops/dr_gameday.js status
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.DR_GAMEDAY_POLICY_PATH
  ? path.resolve(process.env.DR_GAMEDAY_POLICY_PATH)
  : path.join(ROOT, 'config', 'dr_gameday_policy.json');
const RECEIPTS_PATH = process.env.DR_GAMEDAY_RECEIPTS_PATH
  ? path.resolve(process.env.DR_GAMEDAY_RECEIPTS_PATH)
  : path.join(ROOT, 'state', 'ops', 'dr_gameday_receipts.jsonl');
const STATE_BACKUP_SCRIPT = process.env.DR_GAMEDAY_STATE_BACKUP_SCRIPT
  ? path.resolve(process.env.DR_GAMEDAY_STATE_BACKUP_SCRIPT)
  : path.join(ROOT, 'systems', 'ops', 'state_backup.js');
const BACKUP_INTEGRITY_SCRIPT = process.env.DR_GAMEDAY_BACKUP_INTEGRITY_SCRIPT
  ? path.resolve(process.env.DR_GAMEDAY_BACKUP_INTEGRITY_SCRIPT)
  : path.join(ROOT, 'systems', 'ops', 'backup_integrity_check.js');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/dr_gameday.js run [--channel=state_backup|blank_slate] [--profile=<id>] [--dest=<abs_path>] [--strict=1|0]');
  console.log('  node systems/ops/dr_gameday.js list [--limit=N]');
  console.log('  node systems/ops/dr_gameday.js status');
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

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function nowIso() {
  return new Date().toISOString();
}

function trimJsonl(filePath, keepRows) {
  const rows = readJsonl(filePath);
  const limit = Math.max(10, Number(keepRows || 90));
  if (rows.length <= limit) return;
  const tail = rows.slice(-limit).map((row) => JSON.stringify(row));
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${tail.join('\n')}\n`, 'utf8');
}

function toBool(v, fallback) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function runJson(script, scriptArgs) {
  const r = spawnSync(process.execPath, [script, ...scriptArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env }
  });
  const out = String(r.stdout || '').trim();
  let payload = null;
  if (out) {
    const lines = out.split('\n').map((x) => x.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line.startsWith('{') || !line.endsWith('}')) continue;
      try {
        payload = JSON.parse(line);
        break;
      } catch {}
    }
  }
  return {
    ok: r.status === 0 && !!payload && payload.ok !== false,
    code: Number(r.status == null ? 1 : r.status),
    payload,
    stdout: out,
    stderr: String(r.stderr || '').trim()
  };
}

function loadPolicy() {
  const raw = readJson(POLICY_PATH, {});
  return {
    version: String(raw.version || '1.0'),
    default_channel: String(raw.default_channel || 'state_backup'),
    default_profile: String(raw.default_profile || 'runtime_state'),
    rto_target_minutes: Math.max(1, Number(raw.rto_target_minutes || 30)),
    rpo_target_hours: Math.max(1, Number(raw.rpo_target_hours || 24)),
    cadence_hours: Math.max(1, Number(raw.cadence_hours || 168)),
    strict_default: toBool(raw.strict_default, true),
    max_history: Math.max(10, Number(raw.max_history || 90))
  };
}

function toMs(v) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function cmdRun(args) {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const policy = loadPolicy();
  const channel = String(args.channel || policy.default_channel || 'state_backup').trim();
  const profile = String(args.profile || policy.default_profile || 'runtime_state').trim();
  const strict = toBool(args.strict, policy.strict_default);
  const dest = args.dest ? String(args.dest).trim() : '';

  const backupArgs = ['run', `--profile=${profile}`, '--prune'];
  const listArgs = ['list', `--profile=${profile}`, '--limit=1'];
  const integrityArgs = ['run', `--channel=${channel}`];
  if (strict) integrityArgs.push('--strict');
  if (dest) {
    backupArgs.push(`--dest=${dest}`);
    listArgs.push(`--dest=${dest}`);
  }

  const backup = runJson(STATE_BACKUP_SCRIPT, backupArgs);
  const integrity = runJson(BACKUP_INTEGRITY_SCRIPT, integrityArgs);
  const listed = runJson(STATE_BACKUP_SCRIPT, listArgs);
  const latest = listed.payload && Array.isArray(listed.payload.snapshots) && listed.payload.snapshots.length
    ? listed.payload.snapshots[0]
    : null;
  const latestTs = latest && latest.ts ? String(latest.ts) : null;
  const latestMs = toMs(latestTs);
  const completedMs = Date.now();
  const rtoMinutes = Number(((completedMs - startedMs) / 60000).toFixed(3));
  const rpoHours = latestMs == null
    ? null
    : Number(((completedMs - latestMs) / 3600000).toFixed(3));

  const rtoPass = rtoMinutes <= Number(policy.rto_target_minutes || 30);
  const rpoPass = rpoHours != null && rpoHours <= Number(policy.rpo_target_hours || 24);
  const integrityPass = integrity.ok === true;
  const backupPass = backup.ok === true;
  const overallOk = backupPass && integrityPass && rtoPass && rpoPass;

  const out = {
    ok: overallOk,
    type: 'dr_gameday',
    ts: nowIso(),
    strict,
    policy: {
      version: policy.version,
      rto_target_minutes: policy.rto_target_minutes,
      rpo_target_hours: policy.rpo_target_hours
    },
    run: {
      channel,
      profile,
      destination: dest || null,
      started_at: startedAt,
      completed_at: new Date(completedMs).toISOString(),
      backup_ok: backupPass,
      integrity_ok: integrityPass,
      latest_snapshot_id: latest && latest.snapshot_id ? String(latest.snapshot_id) : null,
      latest_snapshot_ts: latestTs
    },
    metrics: {
      rto_minutes: rtoMinutes,
      rpo_hours: rpoHours
    },
    gates: {
      rto_pass: rtoPass,
      rpo_pass: rpoPass,
      backup_pass: backupPass,
      integrity_pass: integrityPass
    },
    reasons: [
      !backupPass ? 'backup_failed' : null,
      !integrityPass ? 'integrity_failed' : null,
      !rtoPass ? 'rto_exceeded' : null,
      !rpoPass ? 'rpo_exceeded_or_missing_snapshot' : null
    ].filter(Boolean),
    details: {
      backup: {
        ok: backup.ok,
        code: backup.code,
        payload: backup.payload || null,
        stderr: backup.stderr || null
      },
      integrity: {
        ok: integrity.ok,
        code: integrity.code,
        payload: integrity.payload || null,
        stderr: integrity.stderr || null
      },
      list: {
        ok: listed.ok,
        code: listed.code,
        payload: listed.payload || null,
        stderr: listed.stderr || null
      }
    }
  };

  appendJsonl(RECEIPTS_PATH, out);
  trimJsonl(RECEIPTS_PATH, policy.max_history);
  process.stdout.write(JSON.stringify(out) + '\n');
  if (strict && out.ok !== true) process.exitCode = 1;
}

function cmdList(args) {
  const limitRaw = Number(args.limit || 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(100, Math.round(limitRaw)) : 10;
  const rows = readJsonl(RECEIPTS_PATH).slice(-limit).reverse();
  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'dr_gameday_list',
    ts: nowIso(),
    count: rows.length,
    rows
  }) + '\n');
}

function cmdStatus() {
  const policy = loadPolicy();
  const rows = readJsonl(RECEIPTS_PATH);
  const last = rows.length > 0 ? rows[rows.length - 1] : null;
  const lastTs = last && last.ts ? String(last.ts) : null;
  const lastMs = toMs(lastTs);
  const nowMs = Date.now();
  const cadenceMs = Number(policy.cadence_hours || 168) * 3600000;
  const nextDueMs = lastMs == null ? nowMs : (lastMs + cadenceMs);
  const out = {
    ok: true,
    type: 'dr_gameday_status',
    ts: nowIso(),
    cadence_hours: Number(policy.cadence_hours || 168),
    receipts: rows.length,
    last_run_ts: lastTs,
    due: nowMs >= nextDueMs,
    next_due_ts: new Date(nextDueMs).toISOString()
  };
  process.stdout.write(JSON.stringify(out) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    return;
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'list') return cmdList(args);
  if (cmd === 'status') return cmdStatus();
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: String(err && err.message || err || 'dr_gameday_failed')
    }) + '\n');
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  loadPolicy
};
