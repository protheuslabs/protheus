#!/usr/bin/env node
// @ts-nocheck
'use strict';

/**
 * ops_dashboard.js
 *
 * Summarize autonomy SLO health from daily/weekly health reports.
 *
 * Usage:
 *   node systems/autonomy/ops_dashboard.js run [YYYY-MM-DD] [--days=N]
 *   node systems/autonomy/ops_dashboard.js --help
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const REPORTS_DIR = process.env.AUTONOMY_HEALTH_REPORTS_DIR
  ? path.resolve(process.env.AUTONOMY_HEALTH_REPORTS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'health_reports');

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/ops_dashboard.js run [YYYY-MM-DD] [--days=N]');
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

function isDateStr(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
}

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return nowIso().slice(0, 10);
}

function dateShift(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Number(deltaDays || 0));
  return d.toISOString().slice(0, 10);
}

function dateRange(endDate, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(dateShift(endDate, -i));
  return out;
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

function summarize(rows) {
  const totals = {
    reports: rows.length,
    failed_checks: 0,
    critical: 0,
    warnings: 0
  };
  const slo = {
    dark_eye: { fail: 0 },
    proposal_starvation: { fail: 0 },
    loop_stall: { fail: 0 },
    drift: { fail: 0 }
  };

  for (const row of rows) {
    const checks = row && row.slo && Array.isArray(row.slo.checks) ? row.slo.checks : [];
    const failed = checks.filter((c) => c && c.pass === false);
    totals.failed_checks += failed.length;
    const level = norm(row && row.slo && row.slo.alert_level);
    if (level === 'critical') totals.critical += 1;
    else if (level === 'warn' || level === 'warning') totals.warnings += 1;

    for (const c of checks) {
      if (!c || c.pass !== false) continue;
      const id = norm(c.name);
      if (id === 'dark_eye') slo.dark_eye.fail += 1;
      if (id === 'proposal_starvation') slo.proposal_starvation.fail += 1;
      if (id === 'loop_stall') slo.loop_stall.fail += 1;
      if (id === 'drift') slo.drift.fail += 1;
    }
  }

  return { totals, slo };
}

function cmdRun(args) {
  const date = isDateStr(args._[1]) ? String(args._[1]) : todayStr();
  const daysRaw = Number(args.days || 7);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(Math.round(daysRaw), 60) : 7;
  const dates = dateRange(date, days);

  const reports = [];
  for (const d of dates) {
    for (const window of ['daily', 'weekly']) {
      const fp = path.join(REPORTS_DIR, `${d}__${window}.json`);
      const row = readJsonSafe(fp, null);
      if (row && typeof row === 'object') reports.push(row);
    }
  }

  const summary = summarize(reports);
  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'ops_dashboard',
    ts: nowIso(),
    date,
    days,
    reports: reports.length,
    summary
  }) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help === true) {
    usage();
    return;
  }
  if (cmd === 'run' || cmd === 'status') {
    cmdRun(args);
    return;
  }
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err || 'ops_dashboard_failed') }) + '\n');
    process.exit(1);
  }
}
