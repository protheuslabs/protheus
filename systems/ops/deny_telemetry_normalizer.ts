#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.DENY_TELEMETRY_NORMALIZER_ROOT
  ? path.resolve(process.env.DENY_TELEMETRY_NORMALIZER_ROOT)
  : path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.DENY_TELEMETRY_NORMALIZER_POLICY_PATH
  ? path.resolve(process.env.DENY_TELEMETRY_NORMALIZER_POLICY_PATH)
  : path.join(ROOT, 'config', 'deny_telemetry_normalizer_policy.json');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 320) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}
function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
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
  for (const token of argv) {
    if (!String(token || '').startsWith('--')) {
      out._.push(String(token || ''));
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[String(token).slice(2)] = true;
    else out[String(token).slice(2, idx)] = String(token).slice(idx + 1);
  }
  return out;
}
function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/deny_telemetry_normalizer.js run [--hours=24] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/deny_telemetry_normalizer.js status [--policy=<path>]');
}
function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }
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
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}
function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}
function writeJsonlAtomic(filePath: string, rows: AnyObj[]) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${rows.map((row) => JSON.stringify(row)).join('\n')}${rows.length ? '\n' : ''}`, 'utf8');
  fs.renameSync(tmp, filePath);
}
function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}
function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw || '', 600);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}
function rel(absPath: string) { return path.relative(ROOT, absPath).replace(/\\/g, '/'); }
function listCanonicalFiles(dirPath: string) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(dirPath, name))
    .filter((absPath) => {
      try { return fs.statSync(absPath).isFile(); } catch { return false; }
    })
    .sort((a, b) => a.localeCompare(b));
}
function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    default_hours: 24,
    sources: {
      llm_gateway: 'state/routing/llm_gateway_calls.jsonl',
      budget_events: 'state/autonomy/budget_events.jsonl',
      command_bus: 'state/eye/audit/command_bus.jsonl',
      canonical_events: 'state/runtime/canonical_events'
    },
    normalized_events_path: 'state/ops/deny_telemetry/normalized_events.jsonl',
    latest_path: 'state/ops/deny_telemetry/latest.json',
    receipts_path: 'state/ops/deny_telemetry/receipts.jsonl'
  };
}
function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const src = raw.sources && typeof raw.sources === 'object' ? raw.sources : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    default_hours: clampInt(raw.default_hours, 1, 24 * 180, base.default_hours),
    sources: {
      llm_gateway: resolvePath(src.llm_gateway || base.sources.llm_gateway, base.sources.llm_gateway),
      budget_events: resolvePath(src.budget_events || base.sources.budget_events, base.sources.budget_events),
      command_bus: resolvePath(src.command_bus || base.sources.command_bus, base.sources.command_bus),
      canonical_events: resolvePath(src.canonical_events || base.sources.canonical_events, base.sources.canonical_events)
    },
    normalized_events_path: resolvePath(raw.normalized_events_path || base.normalized_events_path, base.normalized_events_path),
    latest_path: resolvePath(raw.latest_path || base.latest_path, base.latest_path),
    receipts_path: resolvePath(raw.receipts_path || base.receipts_path, base.receipts_path),
    policy_path: path.resolve(policyPath)
  };
}

function parseTsMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function normalizeEvent(source: string, ts: unknown, decision: string, reason: string, details: AnyObj = {}) {
  const tsIso = cleanText(ts || '', 48) || nowIso();
  const category = normalizeToken(decision || 'deny', 40) || 'deny';
  const normalizedReason = normalizeToken(reason || 'unknown', 180) || 'unknown';
  const fingerprint = `${source}|${category}|${normalizedReason}|${normalizeToken(details.scope || details.adapter || details.opcode || '', 80)}`;
  return {
    ts: tsIso,
    source,
    decision: category,
    reason: normalizedReason,
    fingerprint,
    details
  };
}

function runNormalizer(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const hours = clampInt(args.hours, 1, 24 * 180, policy.default_hours);
  const sinceMs = Date.now() - (hours * 3600000);
  const rows: AnyObj[] = [];

  for (const row of readJsonl(policy.sources.llm_gateway)) {
    const tsMs = parseTsMs(row && row.ts);
    if (!Number.isFinite(tsMs) || tsMs < sinceMs) continue;
    const denied = row && (row.blocked === true || row.ok === false || String(row.error_code || '').includes('deny'));
    if (!denied) continue;
    rows.push(normalizeEvent('llm_gateway', row.ts, row.blocked === true ? 'deny' : 'error', row.error_code || row.block_reason || row.error || 'gateway_error', {
      model: cleanText(row.model || '', 80) || null,
      scope: cleanText(row.source || '', 80) || null
    }));
  }

  for (const row of readJsonl(policy.sources.budget_events)) {
    const tsMs = parseTsMs(row && row.ts);
    if (!Number.isFinite(tsMs) || tsMs < sinceMs) continue;
    const decision = normalizeToken(row && row.decision || '', 32);
    if (decision !== 'deny' && decision !== 'degrade') continue;
    rows.push(normalizeEvent('budget_events', row.ts, decision, row.reason || 'budget_gate', {
      scope: cleanText(row.capability || row.module || '', 80) || null,
      request_tokens_est: Number(row.request_tokens_est || 0) || null
    }));
  }

  for (const row of readJsonl(policy.sources.command_bus)) {
    const tsMs = parseTsMs(row && row.ts);
    if (!Number.isFinite(tsMs) || tsMs < sinceMs) continue;
    const denied = normalizeToken(row && row.decision || '', 32) === 'deny'
      || String(row && row.ok).toLowerCase() === 'false'
      || normalizeToken(row && row.status || '', 40) === 'denied';
    if (!denied) continue;
    rows.push(normalizeEvent('command_bus', row.ts, 'deny', row.reason || row.error || 'command_denied', {
      scope: cleanText(row.channel || row.route || '', 80) || null
    }));
  }

  for (const filePath of listCanonicalFiles(policy.sources.canonical_events)) {
    for (const row of readJsonl(filePath)) {
      const tsMs = parseTsMs(row && row.ts);
      if (!Number.isFinite(tsMs) || tsMs < sinceMs) continue;
      if (String(row.type || '') !== 'primitive_execution') continue;
      if (String(row.phase || '') !== 'finish') continue;
      if (row.ok !== false) continue;
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      const reason = payload.reason || payload.error || payload.policy_decision || 'primitive_failed';
      rows.push(normalizeEvent('canonical_events', row.ts, 'deny', reason, {
        opcode: cleanText(row.opcode || '', 80) || null,
        adapter: cleanText(payload.adapter_kind || '', 80) || null,
        scope: cleanText(row.effect || '', 60) || null
      }));
    }
  }

  rows.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  const dedup = [] as AnyObj[];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.ts}|${row.fingerprint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(row);
  }

  const bySource: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  for (const row of dedup) {
    bySource[row.source] = Number(bySource[row.source] || 0) + 1;
    byReason[row.reason] = Number(byReason[row.reason] || 0) + 1;
  }

  const out = {
    ok: true,
    type: 'deny_telemetry_normalizer',
    ts: nowIso(),
    hours,
    total_events: dedup.length,
    by_source: Object.entries(bySource)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .map(([source, count]) => ({ source, count })),
    top_reasons: Object.entries(byReason)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 20)
      .map(([reason, count]) => ({ reason, count })),
    paths: {
      normalized_events_path: rel(policy.normalized_events_path),
      latest_path: rel(policy.latest_path),
      receipts_path: rel(policy.receipts_path),
      policy_path: rel(policy.policy_path)
    }
  };

  writeJsonlAtomic(policy.normalized_events_path, dedup);
  writeJsonAtomic(policy.latest_path, out);
  appendJsonl(policy.receipts_path, out);
  return out;
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = readJson(policy.latest_path, null);
  if (!latest || typeof latest !== 'object') {
    return {
      ok: false,
      type: 'deny_telemetry_normalizer_status',
      reason: 'status_not_found',
      latest_path: rel(policy.latest_path)
    };
  }
  return {
    ok: true,
    type: 'deny_telemetry_normalizer_status',
    ts: nowIso(),
    latest,
    latest_path: rel(policy.latest_path),
    normalized_events_path: rel(policy.normalized_events_path),
    receipts_path: rel(policy.receipts_path)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 64);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') {
    const out = runNormalizer(args);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (toBool(args.strict, false) && out.ok !== true) process.exit(1);
    return;
  }
  if (cmd === 'status') {
    const out = cmdStatus(args);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (!out.ok) process.exit(1);
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  runNormalizer,
  cmdStatus
};
