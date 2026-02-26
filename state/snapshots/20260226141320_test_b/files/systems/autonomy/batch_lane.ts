#!/usr/bin/env node
'use strict';

/**
 * batch_lane.js
 *
 * Low-urgency execution lane with deterministic queueing, SLA/expiry control,
 * per-task receipts, and token delta accounting.
 *
 * Usage:
 *   node systems/autonomy/batch_lane.js enqueue --task="..." [--tokens_est=320] [--urgency=low] [--sla_minutes=240] [--ttl_minutes=1440] [--objective_id=T1_x]
 *   node systems/autonomy/batch_lane.js process [--max=10] [--dry-run]
 *   node systems/autonomy/batch_lane.js status
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const STATE_DIR = process.env.AUTONOMY_BATCH_LANE_STATE_DIR
  ? path.resolve(process.env.AUTONOMY_BATCH_LANE_STATE_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'batch_lane');
const QUEUE_PATH = path.join(STATE_DIR, 'queue.json');
const EVENTS_PATH = path.join(STATE_DIR, 'events.jsonl');
const METRICS_PATH = path.join(STATE_DIR, 'metrics.json');
const RECEIPTS_DIR = path.join(STATE_DIR, 'receipts');
const EXECUTOR_SCRIPT = process.env.AUTONOMY_BATCH_LANE_EXECUTOR_SCRIPT
  ? path.resolve(process.env.AUTONOMY_BATCH_LANE_EXECUTOR_SCRIPT)
  : path.join(ROOT, 'systems', 'routing', 'route_execute.js');
const TOKEN_SAVINGS_PCT = clamp(Number(process.env.AUTONOMY_BATCH_LANE_TOKEN_SAVINGS_PCT || 0.3), 0, 0.9);
const DEFAULT_SLA_MINUTES = Math.max(5, Number(process.env.AUTONOMY_BATCH_LANE_DEFAULT_SLA_MINUTES || 240));
const DEFAULT_TTL_MINUTES = Math.max(15, Number(process.env.AUTONOMY_BATCH_LANE_DEFAULT_TTL_MINUTES || 1440));
const MAX_TASK_LEN = 1200;

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/batch_lane.js enqueue --task="..." [--tokens_est=320] [--urgency=low] [--sla_minutes=240] [--ttl_minutes=1440] [--objective_id=T1_x]');
  console.log('  node systems/autonomy/batch_lane.js process [--max=10] [--dry-run]');
  console.log('  node systems/autonomy/batch_lane.js status');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '');
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
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

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function nowMs() {
  const override = String(process.env.AUTONOMY_BATCH_LANE_NOW_ISO || '').trim();
  if (override) {
    const ms = Date.parse(override);
    if (Number.isFinite(ms)) return ms;
  }
  return Date.now();
}

function nowIso() {
  return new Date(nowMs()).toISOString();
}

function toMs(ts) {
  const ms = Date.parse(String(ts || ''));
  return Number.isFinite(ms) ? ms : null;
}

function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

function toInt(v, fallback, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.round(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function queueState() {
  const raw = readJson(QUEUE_PATH, null);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) {
    return {
      version: '1.0',
      updated_at: null,
      items: []
    };
  }
  return {
    version: '1.0',
    updated_at: raw.updated_at ? String(raw.updated_at) : null,
    items: raw.items.filter(Boolean).map((it) => {
      const src = it && typeof it === 'object' ? it : {};
      return {
        id: String(src.id || '').trim(),
        status: String(src.status || 'queued').trim().toLowerCase() || 'queued',
        task: String(src.task || '').slice(0, MAX_TASK_LEN),
        tokens_est: toInt(src.tokens_est, 260, 1, 12000),
        urgency: String(src.urgency || 'low').trim().toLowerCase() || 'low',
        priority: String(src.priority || 'low').trim().toLowerCase() || 'low',
        objective_id: src.objective_id ? String(src.objective_id) : null,
        source: src.source ? String(src.source) : null,
        created_at: src.created_at ? String(src.created_at) : null,
        updated_at: src.updated_at ? String(src.updated_at) : null,
        not_before: src.not_before ? String(src.not_before) : null,
        sla_due_at: src.sla_due_at ? String(src.sla_due_at) : null,
        expires_at: src.expires_at ? String(src.expires_at) : null,
        attempts: toInt(src.attempts, 0, 0, 1000),
        completed_at: src.completed_at ? String(src.completed_at) : null,
        last_error: src.last_error ? String(src.last_error).slice(0, 260) : null
      };
    })
  };
}

function saveQueueState(state) {
  const src = state && typeof state === 'object' ? state : queueState();
  src.updated_at = nowIso();
  writeJson(QUEUE_PATH, src);
}

function itemPriorityScore(item) {
  const p = String(item && item.priority || '').toLowerCase();
  if (p === 'high') return 3;
  if (p === 'normal' || p === 'medium') return 2;
  return 1;
}

function enqueueCmd(args) {
  const task = String(args.task || '').trim();
  if (!task) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing_task' }) + '\n');
    process.exitCode = 1;
    return;
  }
  const urgency = String(args.urgency || 'low').trim().toLowerCase();
  if (urgency !== 'low' && String(args.force || '') !== '1') {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'batch_lane_low_urgency_only',
      urgency
    }) + '\n');
    process.exitCode = 1;
    return;
  }
  const state = queueState();
  const now = nowMs();
  const createdAt = nowIso();
  const tokensEst = toInt(args.tokens_est, 260, 1, 12000);
  const slaMinutes = toInt(args.sla_minutes, DEFAULT_SLA_MINUTES, 5, 10080);
  const ttlMinutes = toInt(args.ttl_minutes, Math.max(DEFAULT_TTL_MINUTES, slaMinutes), 15, 20160);
  const notBefore = args.not_before ? String(args.not_before) : createdAt;
  const notBeforeMs = toMs(notBefore);
  const id = `BATCH-${now}-${String(state.items.length + 1).padStart(4, '0')}`;
  const row = {
    id,
    status: 'queued',
    task: task.slice(0, MAX_TASK_LEN),
    tokens_est: tokensEst,
    urgency,
    priority: String(args.priority || 'low').trim().toLowerCase() || 'low',
    objective_id: args.objective_id ? String(args.objective_id) : null,
    source: args.source ? String(args.source) : null,
    created_at: createdAt,
    updated_at: createdAt,
    not_before: notBeforeMs != null ? new Date(notBeforeMs).toISOString() : createdAt,
    sla_due_at: new Date(now + (slaMinutes * 60 * 1000)).toISOString(),
    expires_at: new Date(now + (ttlMinutes * 60 * 1000)).toISOString(),
    attempts: 0,
    completed_at: null,
    last_error: null
  };
  state.items.push(row);
  saveQueueState(state);
  appendJsonl(EVENTS_PATH, {
    ts: createdAt,
    type: 'batch_lane_enqueued',
    id: row.id,
    urgency: row.urgency,
    priority: row.priority,
    tokens_est: row.tokens_est,
    sla_due_at: row.sla_due_at,
    expires_at: row.expires_at,
    objective_id: row.objective_id
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    result: 'enqueued',
    item: row
  }) + '\n');
}

function parseJsonLine(line) {
  try { return JSON.parse(String(line || '')); } catch { return null; }
}

function parseLastJson(text) {
  const lines = String(text || '').split('\n').map((x) => x.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    const row = parseJsonLine(line);
    if (row && typeof row === 'object') return row;
  }
  return null;
}

function runExecutor(item, dryRun) {
  const args = [
    EXECUTOR_SCRIPT,
    '--task', String(item.task || ''),
    '--tokens_est', String(item.tokens_est || 260),
    '--repeats_14d', '0',
    '--errors_30d', '0'
  ];
  if (dryRun) args.push('--dry-run');
  const child = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env }
  });
  const payload = parseLastJson(child.stdout);
  return {
    ok: child.status === 0 && (!payload || payload.ok !== false),
    code: Number(child.status == null ? 1 : child.status),
    payload,
    stdout: String(child.stdout || ''),
    stderr: String(child.stderr || '')
  };
}

function receiptPathByDate(dateStr) {
  return path.join(RECEIPTS_DIR, `${dateStr}.jsonl`);
}

function processCmd(args) {
  const dryRun = args['dry-run'] === true || args.dry_run === true;
  const max = toInt(args.max, 10, 1, 200);
  const state = queueState();
  const now = nowMs();
  const nowTs = new Date(now).toISOString();
  const queued = state.items
    .filter((it) => String(it.status || '') === 'queued')
    .sort((a, b) => {
      const prio = itemPriorityScore(b) - itemPriorityScore(a);
      if (prio !== 0) return prio;
      const ta = toMs(a.created_at) || 0;
      const tb = toMs(b.created_at) || 0;
      return ta - tb;
    });

  let processed = 0;
  let done = 0;
  let failed = 0;
  let expired = 0;
  let baselineTokens = 0;
  let batchTokens = 0;

  for (const item of queued) {
    if (processed >= max) break;
    const expiresMs = toMs(item.expires_at);
    if (expiresMs != null && now >= expiresMs) {
      item.status = 'expired';
      item.updated_at = nowTs;
      item.completed_at = nowTs;
      item.last_error = 'expired_before_processing';
      expired += 1;
      appendJsonl(EVENTS_PATH, {
        ts: nowTs,
        type: 'batch_lane_expired',
        id: item.id,
        expires_at: item.expires_at
      });
      appendJsonl(receiptPathByDate(nowTs.slice(0, 10)), {
        ts: nowTs,
        type: 'batch_lane_receipt',
        id: item.id,
        status: 'expired',
        task: item.task,
        tokens_est: item.tokens_est,
        sla_due_at: item.sla_due_at,
        expires_at: item.expires_at,
        dry_run: dryRun
      });
      continue;
    }
    const notBeforeMs = toMs(item.not_before);
    if (notBeforeMs != null && now < notBeforeMs) continue;

    item.status = 'processing';
    item.updated_at = nowTs;
    item.attempts = toInt(item.attempts, 0, 0, 1000) + 1;
    const res = runExecutor(item, dryRun);
    processed += 1;
    const savingsFactor = 1 - TOKEN_SAVINGS_PCT;
    const baseline = toInt(item.tokens_est, 260, 1, 12000);
    const batchEst = Math.max(1, Math.round(baseline * savingsFactor));
    baselineTokens += baseline;
    batchTokens += batchEst;
    const slaDueMs = toMs(item.sla_due_at);
    const slaBreached = slaDueMs != null && now > slaDueMs;

    if (res.ok) {
      item.status = 'done';
      item.updated_at = nowTs;
      item.completed_at = nowTs;
      item.last_error = null;
      done += 1;
    } else {
      item.status = 'failed';
      item.updated_at = nowTs;
      item.completed_at = nowTs;
      item.last_error = String(res.stderr || res.stdout || `executor_exit_${res.code}`).slice(0, 260);
      failed += 1;
    }

    appendJsonl(EVENTS_PATH, {
      ts: nowTs,
      type: 'batch_lane_processed',
      id: item.id,
      ok: res.ok,
      code: res.code,
      status: item.status,
      sla_breached: slaBreached,
      dry_run: dryRun
    });
    appendJsonl(receiptPathByDate(nowTs.slice(0, 10)), {
      ts: nowTs,
      type: 'batch_lane_receipt',
      id: item.id,
      status: item.status,
      attempts: item.attempts,
      dry_run: dryRun,
      objective_id: item.objective_id || null,
      source: item.source || null,
      task: item.task,
      tokens_est: baseline,
      batch_tokens_est: batchEst,
      tokens_saved_est: Math.max(0, baseline - batchEst),
      token_savings_pct: TOKEN_SAVINGS_PCT,
      sla_due_at: item.sla_due_at,
      sla_breached: slaBreached,
      expires_at: item.expires_at,
      executor: {
        ok: res.ok,
        code: res.code,
        payload: res.payload && typeof res.payload === 'object' ? res.payload : null,
        stderr: String(res.stderr || '').slice(0, 260)
      }
    });
  }

  const queuedRemaining = state.items.filter((it) => String(it.status || '') === 'queued').length;
  saveQueueState(state);
  const metrics = {
    version: '1.0',
    updated_at: nowTs,
    processed_total: processed,
    done,
    failed,
    expired,
    queued_remaining: queuedRemaining,
    token_delta: {
      baseline_tokens_est: baselineTokens,
      batch_tokens_est: batchTokens,
      saved_tokens_est: Math.max(0, baselineTokens - batchTokens),
      savings_pct: TOKEN_SAVINGS_PCT
    }
  };
  writeJson(METRICS_PATH, metrics);

  process.stdout.write(JSON.stringify({
    ok: true,
    result: 'batch_processed',
    dry_run: dryRun,
    max,
    processed,
    done,
    failed,
    expired,
    queued_remaining: queuedRemaining,
    token_delta: metrics.token_delta
  }) + '\n');
}

function statusCmd() {
  const state = queueState();
  const metrics = readJson(METRICS_PATH, null);
  const counts = state.items.reduce((acc, it) => {
    const s = String(it && it.status || 'unknown');
    acc[s] = Number(acc[s] || 0) + 1;
    return acc;
  }, {});
  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    queue: {
      total: state.items.length,
      counts
    },
    metrics: metrics && typeof metrics === 'object' ? metrics : null
  }) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    return;
  }
  if (cmd === 'enqueue') return enqueueCmd(args);
  if (cmd === 'process') return processCmd(args);
  if (cmd === 'status') return statusCmd();
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: String(err && err.message || err || 'batch_lane_failed')
    }) + '\n');
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  queueState,
  saveQueueState
};

