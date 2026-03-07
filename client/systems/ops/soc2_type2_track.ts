#!/usr/bin/env node
'use strict';
export {};

/**
 * soc2_type2_track.js
 *
 * RM-133: SOC2 Type II execution track (post-Type-I).
 *
 * Commands:
 *   node systems/ops/soc2_type2_track.js run [--days=90] [--strict=1|0]
 *   node systems/ops/soc2_type2_track.js exception-open --id=<id> --control=<control> --reason=<reason> [--owner=<owner>]
 *   node systems/ops/soc2_type2_track.js exception-close --id=<id> --resolution=<text> [--closed-by=<id>]
 *   node systems/ops/soc2_type2_track.js bundle [--window-id=<id>] [--label=<label>] [--strict=1|0]
 *   node systems/ops/soc2_type2_track.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.SOC2_TYPE2_POLICY_PATH
  ? path.resolve(String(process.env.SOC2_TYPE2_POLICY_PATH))
  : path.join(ROOT, 'config', 'soc2_type2_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function clean(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return clean(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok || '').slice(2)] = true;
    else out[String(tok || '').slice(2, idx)] = String(tok || '').slice(idx + 1);
  }
  return out;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const row = JSON.parse(line);
          return row && typeof row === 'object' ? row : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as AnyObj[];
  } catch {
    return [];
  }
}

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function resolvePath(v: unknown, fallbackRel: string) {
  const text = clean(v || fallbackRel, 320);
  return path.isAbsolute(text) ? path.resolve(text) : path.join(ROOT, text);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: false,
    default_window_days: 90,
    minimum_window_days: 90,
    minimum_soc2_runs: 10,
    minimum_unique_evidence_days: 10,
    max_open_exception_days: 30,
    required_event_types: ['soc2_readiness', 'framework_readiness', 'compliance_control_inventory'],
    history_path: 'state/ops/compliance/history.jsonl',
    state_path: 'state/ops/soc2_type2_track/latest.json',
    window_history_path: 'state/ops/soc2_type2_track/window_history.jsonl',
    exceptions_path: 'state/ops/soc2_type2_track/exceptions.json',
    bundle_dir: 'state/ops/soc2_type2_track/bundles',
    receipts_path: 'state/ops/soc2_type2_track/receipts.jsonl',
    attestation_format_version: '1.0'
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  return {
    version: clean(raw.version || base.version, 24) || '1.0',
    enabled: raw.enabled !== false,
    strict_default: toBool(raw.strict_default, base.strict_default),
    default_window_days: clampInt(raw.default_window_days, 30, 3650, base.default_window_days),
    minimum_window_days: clampInt(raw.minimum_window_days, 30, 3650, base.minimum_window_days),
    minimum_soc2_runs: clampInt(raw.minimum_soc2_runs, 1, 5000, base.minimum_soc2_runs),
    minimum_unique_evidence_days: clampInt(raw.minimum_unique_evidence_days, 1, 5000, base.minimum_unique_evidence_days),
    max_open_exception_days: clampInt(raw.max_open_exception_days, 1, 3650, base.max_open_exception_days),
    required_event_types: Array.isArray(raw.required_event_types)
      ? raw.required_event_types.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean)
      : base.required_event_types,
    history_path: resolvePath(raw.history_path, base.history_path),
    state_path: resolvePath(raw.state_path, base.state_path),
    window_history_path: resolvePath(raw.window_history_path, base.window_history_path),
    exceptions_path: resolvePath(raw.exceptions_path, base.exceptions_path),
    bundle_dir: resolvePath(raw.bundle_dir, base.bundle_dir),
    receipts_path: resolvePath(raw.receipts_path, base.receipts_path),
    attestation_format_version: clean(raw.attestation_format_version || base.attestation_format_version, 24) || '1.0',
    policy_path: path.resolve(policyPath)
  };
}

function loadExceptions(absPath: string) {
  const base = {
    schema_id: 'soc2_type2_exceptions',
    schema_version: '1.0',
    updated_at: nowIso(),
    items: {}
  } as AnyObj;
  const raw = readJson(absPath, base);
  if (!raw || typeof raw !== 'object') return base;
  const items = raw.items && typeof raw.items === 'object' ? raw.items : {};
  return {
    ...base,
    ...raw,
    items
  };
}

function writeExceptions(absPath: string, payload: AnyObj) {
  writeJsonAtomic(absPath, {
    schema_id: 'soc2_type2_exceptions',
    schema_version: '1.0',
    updated_at: nowIso(),
    items: payload && payload.items && typeof payload.items === 'object' ? payload.items : {}
  });
}

function cmdRun(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (!policy.enabled) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'soc2_type2_track', error: 'policy_disabled' })}\n`);
    process.exit(1);
  }
  const strict = toBool(args.strict, policy.strict_default === true);
  const windowDays = clampInt(args.days, 1, 3650, policy.default_window_days);
  const minWindowDays = policy.minimum_window_days;
  const now = Date.now();
  const cutoff = now - (windowDays * 24 * 60 * 60 * 1000);

  const history = readJsonl(policy.history_path);
  const rows = history
    .filter((row) => {
      const ts = Date.parse(String(row.ts || ''));
      if (!Number.isFinite(ts)) return false;
      if (ts < cutoff) return false;
      return policy.required_event_types.includes(normalizeToken(row.type || '', 80));
    })
    .sort((a, b) => Date.parse(String(a.ts || 0)) - Date.parse(String(b.ts || 0)));

  const byType: Record<string, number> = {};
  for (const t of policy.required_event_types) byType[t] = 0;
  for (const row of rows) {
    const type = normalizeToken(row.type || '', 80);
    byType[type] = Number(byType[type] || 0) + 1;
  }

  const soc2Rows = rows.filter((row) => normalizeToken(row.type || '', 80) === 'soc2_readiness');
  const failedSoc2 = soc2Rows.filter((row) => row.ok !== true).length;
  const uniqueDays = new Set(rows.map((row) => String(row.ts || '').slice(0, 10))).size;

  const exceptions = loadExceptions(policy.exceptions_path);
  const exceptionItems: AnyObj[] = Object.values(exceptions.items || {});
  const openExceptions = exceptionItems.filter((row) => !clean(row.closed_at || '', 80));
  const staleOpenExceptions = openExceptions.filter((row) => {
    const opened = Date.parse(String(row.opened_at || ''));
    if (!Number.isFinite(opened)) return true;
    const ageDays = Math.floor((now - opened) / (24 * 60 * 60 * 1000));
    return ageDays > policy.max_open_exception_days;
  });

  const requiredTypeMissing = policy.required_event_types.filter((t: string) => Number(byType[t] || 0) <= 0);
  const latestSoc2 = soc2Rows.length ? soc2Rows[soc2Rows.length - 1] : null;

  const pass =
    windowDays >= minWindowDays &&
    soc2Rows.length >= policy.minimum_soc2_runs &&
    uniqueDays >= policy.minimum_unique_evidence_days &&
    requiredTypeMissing.length === 0 &&
    staleOpenExceptions.length === 0 &&
    latestSoc2 != null && latestSoc2.ok === true;

  const startTs = cutoff;
  const endTs = now;
  const windowId = `${new Date(startTs).toISOString().slice(0, 10)}_${new Date(endTs).toISOString().slice(0, 10)}`;
  const payload = {
    ok: pass,
    type: 'soc2_type2_track',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    history_path: rel(policy.history_path),
    window: {
      id: windowId,
      days: windowDays,
      min_days: minWindowDays,
      start_at: new Date(startTs).toISOString(),
      end_at: new Date(endTs).toISOString()
    },
    evidence: {
      total_events: rows.length,
      by_type: byType,
      unique_days: uniqueDays,
      soc2_runs: soc2Rows.length,
      soc2_failures: failedSoc2,
      latest_soc2_ok: latestSoc2 ? latestSoc2.ok === true : false,
      required_type_missing: requiredTypeMissing
    },
    exceptions: {
      open_count: openExceptions.length,
      stale_open_count: staleOpenExceptions.length,
      max_open_exception_days: policy.max_open_exception_days
    },
    minimums: {
      minimum_soc2_runs: policy.minimum_soc2_runs,
      minimum_unique_evidence_days: policy.minimum_unique_evidence_days
    },
    pass,
    reasons: pass ? [] : [
      ...(windowDays < minWindowDays ? ['window_too_short'] : []),
      ...(soc2Rows.length < policy.minimum_soc2_runs ? ['insufficient_soc2_runs'] : []),
      ...(uniqueDays < policy.minimum_unique_evidence_days ? ['insufficient_unique_evidence_days'] : []),
      ...(requiredTypeMissing.length > 0 ? ['missing_required_event_types'] : []),
      ...(staleOpenExceptions.length > 0 ? ['stale_open_exceptions'] : []),
      ...(latestSoc2 == null ? ['missing_latest_soc2'] : []),
      ...(latestSoc2 != null && latestSoc2.ok !== true ? ['latest_soc2_not_ok'] : [])
    ]
  };

  writeJsonAtomic(policy.state_path, payload);
  appendJsonl(policy.window_history_path, {
    ts: payload.ts,
    window_id: windowId,
    pass,
    days: windowDays,
    soc2_runs: soc2Rows.length,
    unique_days: uniqueDays,
    stale_open_exceptions: staleOpenExceptions.length,
    reasons: payload.reasons
  });
  appendJsonl(policy.receipts_path, {
    ts: payload.ts,
    type: 'soc2_type2_track_run',
    pass,
    window_id: windowId,
    state_path: rel(policy.state_path)
  });

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (strict && pass !== true) process.exit(1);
}

function cmdExceptionOpen(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const id = normalizeToken(args.id || '', 120);
  const control = normalizeToken(args.control || '', 120);
  const reason = clean(args.reason || '', 400);
  const owner = clean(args.owner || 'unassigned', 120) || 'unassigned';
  if (!id || !control || !reason) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'soc2_type2_exception_open', error: 'missing_required_flags', required: ['--id', '--control', '--reason'] }, null, 2)}\n`);
    process.exit(2);
  }
  const book = loadExceptions(policy.exceptions_path);
  const existing = book.items[id];
  if (existing && !clean(existing.closed_at || '', 80)) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'soc2_type2_exception_open', error: 'exception_already_open', id }, null, 2)}\n`);
    process.exit(1);
  }
  book.items[id] = {
    id,
    control,
    reason,
    owner,
    opened_at: nowIso(),
    status: 'open'
  };
  writeExceptions(policy.exceptions_path, book);
  const out = {
    ok: true,
    type: 'soc2_type2_exception_open',
    ts: nowIso(),
    id,
    control,
    owner,
    exceptions_path: rel(policy.exceptions_path)
  };
  appendJsonl(policy.receipts_path, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function cmdExceptionClose(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const id = normalizeToken(args.id || '', 120);
  const resolution = clean(args.resolution || '', 400);
  const closedBy = clean(args['closed-by'] || args.closed_by || 'unknown', 120) || 'unknown';
  if (!id || !resolution) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'soc2_type2_exception_close', error: 'missing_required_flags', required: ['--id', '--resolution'] }, null, 2)}\n`);
    process.exit(2);
  }
  const book = loadExceptions(policy.exceptions_path);
  const row = book.items[id];
  if (!row || clean(row.closed_at || '', 80)) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'soc2_type2_exception_close', error: 'exception_not_open', id }, null, 2)}\n`);
    process.exit(1);
  }
  row.closed_at = nowIso();
  row.closed_by = closedBy;
  row.resolution = resolution;
  row.status = 'closed';
  book.items[id] = row;
  writeExceptions(policy.exceptions_path, book);
  const out = {
    ok: true,
    type: 'soc2_type2_exception_close',
    ts: nowIso(),
    id,
    closed_by: closedBy,
    exceptions_path: rel(policy.exceptions_path)
  };
  appendJsonl(policy.receipts_path, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function cmdBundle(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const strict = toBool(args.strict, policy.strict_default === true);
  const latest = readJson(policy.state_path, null);
  if (!latest || typeof latest !== 'object') {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'soc2_type2_bundle', error: 'missing_latest_window', state_path: rel(policy.state_path) }, null, 2)}\n`);
    process.exit(1);
  }
  const requestedWindowId = clean(args['window-id'] || args.window_id || '', 120);
  if (requestedWindowId && String(latest.window?.id || '') !== requestedWindowId) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'soc2_type2_bundle', error: 'window_not_found', requested_window_id: requestedWindowId, latest_window_id: clean(latest.window?.id || '', 120) }, null, 2)}\n`);
    process.exit(1);
  }

  const exceptions = loadExceptions(policy.exceptions_path);
  const history = readJsonl(policy.history_path)
    .filter((row) => policy.required_event_types.includes(normalizeToken(row.type || '', 80)));

  const windowId = clean(latest.window?.id || `window_${Date.now()}`, 120) || `window_${Date.now()}`;
  const label = clean(args.label || '', 120);
  const bundleId = `${windowId}${label ? `_${normalizeToken(label, 40)}` : ''}`;
  const bundlePath = path.join(policy.bundle_dir, `${bundleId}.json`);
  const bundle = {
    schema_id: 'soc2_type2_attestation_bundle',
    schema_version: policy.attestation_format_version,
    generated_at: nowIso(),
    bundle_id: bundleId,
    window: latest.window,
    summary: {
      pass: latest.pass === true,
      reasons: Array.isArray(latest.reasons) ? latest.reasons : [],
      evidence: latest.evidence || {},
      exceptions: latest.exceptions || {}
    },
    sources: {
      policy_path: rel(policy.policy_path),
      state_path: rel(policy.state_path),
      history_path: rel(policy.history_path),
      exceptions_path: rel(policy.exceptions_path)
    },
    evidence_refs: history
      .filter((row) => {
        const ts = Date.parse(String(row.ts || ''));
        if (!Number.isFinite(ts)) return false;
        const start = Date.parse(String(latest.window?.start_at || ''));
        const end = Date.parse(String(latest.window?.end_at || ''));
        return (!Number.isFinite(start) || ts >= start) && (!Number.isFinite(end) || ts <= end);
      })
      .slice(-5000)
      .map((row) => ({
        ts: clean(row.ts || '', 40),
        type: normalizeToken(row.type || '', 80),
        ok: row.ok === true,
        controls_failed: Number(row.controls_failed || 0),
        path: clean(row.path || '', 240)
      })),
    exceptions_snapshot: exceptions
  };

  writeJsonAtomic(bundlePath, bundle);
  const out = {
    ok: true,
    type: 'soc2_type2_bundle',
    ts: nowIso(),
    bundle_id: bundleId,
    window_id: windowId,
    bundle_path: rel(bundlePath),
    pass: latest.pass === true
  };
  appendJsonl(policy.receipts_path, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (strict && out.pass !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = readJson(policy.state_path, null);
  const exceptionBook = loadExceptions(policy.exceptions_path);
  const items = Object.values(exceptionBook.items || {});
  const openCount = items.filter((row: AnyObj) => !clean(row.closed_at || '', 80)).length;
  const historyRows = readJsonl(policy.window_history_path);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'soc2_type2_status',
    ts: nowIso(),
    available: !!latest,
    latest: latest || null,
    open_exception_count: openCount,
    window_history_count: historyRows.length,
    paths: {
      policy_path: rel(policy.policy_path),
      state_path: rel(policy.state_path),
      window_history_path: rel(policy.window_history_path),
      exceptions_path: rel(policy.exceptions_path),
      bundle_dir: rel(policy.bundle_dir),
      receipts_path: rel(policy.receipts_path)
    }
  }, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/soc2_type2_track.js run [--days=90] [--strict=1|0]');
  console.log('  node systems/ops/soc2_type2_track.js exception-open --id=<id> --control=<control> --reason=<reason> [--owner=<owner>]');
  console.log('  node systems/ops/soc2_type2_track.js exception-close --id=<id> --resolution=<text> [--closed-by=<id>]');
  console.log('  node systems/ops/soc2_type2_track.js bundle [--window-id=<id>] [--label=<label>] [--strict=1|0]');
  console.log('  node systems/ops/soc2_type2_track.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'exception-open') return cmdExceptionOpen(args);
  if (cmd === 'exception-close') return cmdExceptionClose(args);
  if (cmd === 'bundle') return cmdBundle(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
