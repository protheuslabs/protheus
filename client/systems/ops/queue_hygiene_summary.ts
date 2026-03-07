#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const QUEUE_LOG_PATH = process.env.QUEUE_HYGIENE_QUEUE_LOG_PATH
  ? path.resolve(process.env.QUEUE_HYGIENE_QUEUE_LOG_PATH)
  : path.join(REPO_ROOT, 'state', 'sensory', 'queue_log.jsonl');
const OUT_DIR = process.env.QUEUE_HYGIENE_SUMMARY_DIR
  ? path.resolve(process.env.QUEUE_HYGIENE_SUMMARY_DIR)
  : path.join(REPO_ROOT, 'state', 'ops', 'queue_hygiene');
const STATE_PATH = process.env.QUEUE_HYGIENE_STATE_PATH
  ? path.resolve(process.env.QUEUE_HYGIENE_STATE_PATH)
  : path.join(REPO_ROOT, 'state', 'ops', 'queue_hygiene_state.json');

function nowIso() {
  return new Date().toISOString();
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

function normalizeDate(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return nowIso().slice(0, 10);
}

function toPositiveInt(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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

function asMs(ts) {
  const ms = Date.parse(String(ts || ''));
  return Number.isFinite(ms) ? ms : null;
}

function sortedCounts(obj) {
  return Object.entries(obj || {})
    .map(([key, count]) => ({ key, count: Number(count || 0) }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return String(a.key).localeCompare(String(b.key));
    });
}

function computeSummary(rows, dateStr, days, staleOpenHours) {
  const endMs = Date.parse(`${dateStr}T23:59:59.999Z`);
  const startMs = endMs - (days * 24 * 60 * 60 * 1000);
  const staleCutoffMs = endMs - (Math.max(1, staleOpenHours) * 60 * 60 * 1000);
  const inWindow = rows.filter((row) => {
    const ts = asMs(row && row.ts);
    return ts != null && ts >= startMs && ts <= endMs;
  });

  const typeCounts = {};
  const rejectReasonCounts = {};
  const statusById = new Map();
  const generatedTsById = new Map();

  const ordered = rows
    .slice()
    .sort((a, b) => {
      const ta = asMs(a && a.ts) || 0;
      const tb = asMs(b && b.ts) || 0;
      return ta - tb;
    });

  for (const row of ordered) {
    const id = String(row && row.proposal_id || '').trim();
    const type = String(row && row.type || '').trim().toLowerCase();
    if (!id || !type) continue;
    if (type === 'proposal_generated') {
      statusById.set(id, 'open');
      const ts = asMs(row.ts);
      if (ts != null) generatedTsById.set(id, ts);
      continue;
    }
    if (type === 'proposal_accepted') statusById.set(id, 'accepted');
    else if (type === 'proposal_done') statusById.set(id, 'done');
    else if (type === 'proposal_rejected') statusById.set(id, 'rejected');
    else if (type === 'proposal_filtered') statusById.set(id, 'filtered');
    else if (type === 'proposal_snoozed') statusById.set(id, 'snoozed');
  }

  for (const row of inWindow) {
    const type = String(row && row.type || '').trim().toLowerCase() || 'unknown';
    typeCounts[type] = Number(typeCounts[type] || 0) + 1;
    if (type === 'proposal_rejected') {
      const reason = String(row && row.reason || row && row.filter_reason || 'unknown').trim().toLowerCase() || 'unknown';
      rejectReasonCounts[reason] = Number(rejectReasonCounts[reason] || 0) + 1;
    }
  }

  let openCount = 0;
  let staleOpenCount = 0;
  for (const [id, status] of statusById.entries()) {
    if (status !== 'open') continue;
    openCount += 1;
    const ts = generatedTsById.get(id);
    if (Number.isFinite(ts) && ts <= staleCutoffMs) staleOpenCount += 1;
  }

  return {
    window: {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      days
    },
    totals: {
      events: inWindow.length,
      open: openCount,
      stale_open: staleOpenCount
    },
    types: sortedCounts(typeCounts),
    top_reject_reasons: sortedCounts(rejectReasonCounts).slice(0, 10),
    stale_open_hours: Math.max(1, staleOpenHours)
  };
}

function shouldSkipByInterval(dateStr, intervalDays) {
  const state = readJson(STATE_PATH, {});
  const lastTs = state && state.last_run_ts ? asMs(state.last_run_ts) : null;
  if (lastTs == null) return { skip: false, state };
  const nowMs = Date.parse(`${dateStr}T23:59:59.999Z`);
  const minGapMs = Math.max(1, intervalDays) * 24 * 60 * 60 * 1000;
  const ageMs = nowMs - lastTs;
  if (ageMs < minGapMs) {
    return {
      skip: true,
      state,
      age_hours: Number((ageMs / (60 * 60 * 1000)).toFixed(2)),
      min_gap_hours: Number((minGapMs / (60 * 60 * 1000)).toFixed(2))
    };
  }
  return { skip: false, state };
}

function cmdRun(args) {
  const date = normalizeDate(args._[1]);
  const days = toPositiveInt(args.days, 7);
  const intervalDays = toPositiveInt(args['interval-days'], toPositiveInt(args.interval_days, 7));
  const staleOpenHours = toPositiveInt(args['stale-open-hours'], toPositiveInt(args.stale_open_hours, 96));
  const force = String(args.force || '0') === '1';

  if (!force) {
    const gate = shouldSkipByInterval(date, intervalDays);
    if (gate.skip) {
      return {
        ok: true,
        result: 'skip_recent_run',
        date,
        interval_days: intervalDays,
        age_hours: gate.age_hours,
        min_gap_hours: gate.min_gap_hours,
        output_file: gate.state && gate.state.output_file ? String(gate.state.output_file) : null
      };
    }
  }

  const rows = readJsonl(QUEUE_LOG_PATH);
  const summary = computeSummary(rows, date, days, staleOpenHours);
  const outputPath = path.join(OUT_DIR, `${date}.json`);
  writeJson(outputPath, {
    ok: true,
    ts: nowIso(),
    date,
    queue_log_path: QUEUE_LOG_PATH,
    summary
  });
  writeJson(STATE_PATH, {
    version: '1.0',
    last_run_ts: nowIso(),
    last_date: date,
    output_file: outputPath
  });

  return {
    ok: true,
    result: 'queue_hygiene_summary_written',
    date,
    days,
    interval_days: intervalDays,
    output_file: outputPath,
    totals: summary.totals
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/queue_hygiene_summary.js run [YYYY-MM-DD] [--days=7] [--interval-days=7] [--stale-open-hours=96] [--force=1]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  let out;
  if (cmd === 'run') out = cmdRun(args);
  else {
    usage();
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (!out || out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: String(err && err.message ? err.message : err || 'queue_hygiene_summary_failed')
    })}\n`);
    process.exit(1);
  }
}

