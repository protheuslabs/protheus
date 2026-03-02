#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-003
 * Autonomy receipt dashboard/summary.
 *
 * Usage:
 *   node systems/autonomy/receipt_dashboard.js daily [--date=YYYY-MM-DD] [--days=N] [--policy=<path>]
 *   node systems/autonomy/receipt_dashboard.js status [--policy=<path>]
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.RECEIPT_DASHBOARD_ROOT
  ? path.resolve(process.env.RECEIPT_DASHBOARD_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.RECEIPT_DASHBOARD_POLICY_PATH
  ? path.resolve(process.env.RECEIPT_DASHBOARD_POLICY_PATH)
  : path.join(ROOT, 'config', 'receipt_dashboard_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
      continue;
    }
    const key = tok.slice(2);
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

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const x = Math.floor(n);
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 600);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function parseMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    failure_token_patterns: [
      'failed',
      'error',
      'blocked',
      'fallback',
      'deny',
      'timeout',
      'revert',
      'invalid',
      'no_change'
    ],
    paths: {
      runs_dir: 'state/autonomy/runs',
      latest_path: 'state/autonomy/receipt_dashboard/latest.json',
      history_path: 'state/autonomy/receipt_dashboard/history.jsonl',
      reports_dir: 'state/autonomy/receipt_dashboard/reports'
    }
  };
}

function normalizeStringArray(v: unknown, fallback: string[]) {
  if (!Array.isArray(v)) return fallback.slice();
  const out: string[] = [];
  for (const item of v) {
    const token = cleanText(item, 120).toLowerCase();
    if (!token) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out.length ? out : fallback.slice();
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    failure_token_patterns: normalizeStringArray(raw.failure_token_patterns, base.failure_token_patterns),
    paths: {
      runs_dir: resolvePath(paths.runs_dir, base.paths.runs_dir),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path),
      reports_dir: resolvePath(paths.reports_dir, base.paths.reports_dir)
    },
    policy_path: path.resolve(policyPath)
  };
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function walkFiles(dirPath: string, out: string[] = []) {
  if (!fs.existsSync(dirPath)) return out;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  entries.sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
  for (const ent of entries) {
    const abs = path.join(dirPath, ent.name);
    if (ent.isDirectory()) walkFiles(abs, out);
    else if (ent.isFile()) out.push(abs);
  }
  return out;
}

function normalizeDate(v: unknown) {
  const s = cleanText(v, 40);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return nowIso().slice(0, 10);
}

function sortedCounts(map: Record<string, number>) {
  return Object.entries(map)
    .map(([key, count]) => ({ key, count: Number(count || 0) }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return String(a.key).localeCompare(String(b.key));
    });
}

function looksFailed(result: string, policy: AnyObj) {
  const tok = String(result || '').toLowerCase();
  if (!tok) return true;
  for (const needle of policy.failure_token_patterns || []) {
    if (tok.includes(String(needle || '').toLowerCase())) return true;
  }
  return false;
}

function summarizeRuns(rows: AnyObj[], policy: AnyObj) {
  const failureReasons: Record<string, number> = {};
  let evaluated = 0;
  let passed = 0;
  let failed = 0;

  for (const row of rows) {
    const type = cleanText(row && row.type, 80).toLowerCase();
    const result = cleanText(row && row.result, 160);
    const hasSuccessFlag = row && row.success_criteria && typeof row.success_criteria === 'object' && typeof row.success_criteria.passed === 'boolean';
    if (type !== 'autonomy_run' && !result) continue;

    evaluated += 1;
    let pass = false;
    if (hasSuccessFlag) {
      pass = row.success_criteria.passed === true;
    } else {
      pass = !looksFailed(result, policy);
    }

    if (pass) {
      passed += 1;
      continue;
    }

    failed += 1;
    const key = result ? result.toLowerCase() : 'unknown_failure';
    failureReasons[key] = Number(failureReasons[key] || 0) + 1;
  }

  const passRate = evaluated > 0 ? Number((passed / evaluated).toFixed(6)) : 0;
  return {
    totals: {
      evaluated,
      passed,
      failed,
      pass_rate: passRate
    },
    top_failure_reasons: sortedCounts(failureReasons).slice(0, 10)
  };
}

function loadRunsInWindow(runsDir: string, date: string, days: number) {
  const endMs = Date.parse(`${date}T23:59:59.999Z`);
  const startMs = endMs - (Math.max(1, days) * 24 * 60 * 60 * 1000);
  const rows: AnyObj[] = [];

  const files = walkFiles(runsDir, []).filter((fp) => fp.endsWith('.jsonl'));
  for (const fp of files) {
    for (const row of readJsonl(fp)) {
      const ts = parseMs(row && (row.ts || row.created_at || row.finished_at));
      if (!Number.isFinite(ts)) continue;
      if (ts < startMs || ts > endMs) continue;
      rows.push(row);
    }
  }

  rows.sort((a, b) => {
    const ta = parseMs(a && (a.ts || a.created_at || a.finished_at)) || 0;
    const tb = parseMs(b && (b.ts || b.created_at || b.finished_at)) || 0;
    return ta - tb;
  });
  return {
    rows,
    window: {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      days: Math.max(1, days)
    },
    file_count: files.length
  };
}

function cmdDaily(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const date = normalizeDate(args.date || args._[1]);
  const days = clampInt(args.days, 1, 60, 1);

  if (!policy.enabled) {
    return {
      ok: true,
      result: 'disabled_by_policy',
      date,
      policy_path: policy.policy_path
    };
  }

  const windowRows = loadRunsInWindow(policy.paths.runs_dir, date, days);
  const summary = summarizeRuns(windowRows.rows, policy);

  const payload = {
    ok: true,
    ts: nowIso(),
    type: 'autonomy_receipt_dashboard',
    date,
    policy_path: rel(policy.policy_path),
    runs_dir: rel(policy.paths.runs_dir),
    file_count: windowRows.file_count,
    window: windowRows.window,
    summary
  };

  const reportPath = path.join(policy.paths.reports_dir, `${date}.json`);
  writeJsonAtomic(reportPath, payload);
  writeJsonAtomic(policy.paths.latest_path, payload);
  appendJsonl(policy.paths.history_path, {
    ts: payload.ts,
    type: payload.type,
    date,
    window: payload.window,
    pass_rate: summary.totals.pass_rate,
    evaluated: summary.totals.evaluated,
    failed: summary.totals.failed,
    report_path: rel(reportPath)
  });

  return {
    ...payload,
    output: {
      report_path: rel(reportPath),
      latest_path: rel(policy.paths.latest_path),
      history_path: rel(policy.paths.history_path)
    }
  };
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const latest = readJson(policy.paths.latest_path, null);
  return {
    ok: true,
    ts: nowIso(),
    type: 'autonomy_receipt_dashboard_status',
    latest,
    latest_path: rel(policy.paths.latest_path),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/receipt_dashboard.js daily [--date=YYYY-MM-DD] [--days=N] [--policy=<path>]');
  console.log('  node systems/autonomy/receipt_dashboard.js status [--policy=<path>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || '', 80).toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }

  try {
    const out = cmd === 'daily'
      ? cmdDaily(args)
      : cmd === 'status'
        ? cmdStatus(args)
        : null;
    if (!out) {
      usage();
      process.exit(2);
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } catch (err: any) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText(err && err.message ? err.message : err, 400) }, null, 2)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  summarizeRuns,
  loadRunsInWindow,
  cmdDaily,
  cmdStatus,
  loadPolicy
};
