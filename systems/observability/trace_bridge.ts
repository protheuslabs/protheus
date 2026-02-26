#!/usr/bin/env node
'use strict';

/**
 * trace_bridge.js
 *
 * Lightweight OpenTelemetry-style span emitter for local runtime traces.
 *
 * Usage:
 *   node systems/observability/trace_bridge.js span --name=<name> [--status=ok|warn|error] [--duration-ms=12] [--trace-id=<id>] [--span-id=<id>] [--parent-span-id=<id>] [--service=protheus] [--component=spine] [--attrs-json='{"k":"v"}'] [--policy=/abs/path.json] [--write=1|0]
 *   node systems/observability/trace_bridge.js summary [--hours=24] [--policy=/abs/path.json]
 *   node systems/observability/trace_bridge.js status [--policy=/abs/path.json]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(process.env.OBSERVABILITY_ROOT || path.join(__dirname, '..', '..'));
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'observability_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/observability/trace_bridge.js span --name=<name> [--status=ok|warn|error] [--duration-ms=12] [--trace-id=<id>] [--span-id=<id>] [--parent-span-id=<id>] [--service=protheus] [--component=spine] [--attrs-json=\'{"k":"v"}\'] [--policy=/abs/path.json] [--write=1|0]');
  console.log('  node systems/observability/trace_bridge.js summary [--hours=24] [--policy=/abs/path.json]');
  console.log('  node systems/observability/trace_bridge.js status [--policy=/abs/path.json]');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const arg of argv) {
    if (!String(arg || '').startsWith('--')) {
      out._.push(String(arg || ''));
      continue;
    }
    const idx = String(arg || '').indexOf('=');
    if (idx === -1) out[String(arg || '').slice(2)] = true;
    else out[String(arg || '').slice(2, idx)] = String(arg || '').slice(idx + 1);
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function cleanText(v: unknown, maxLen = 160) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function boolFlag(v: unknown, fallback = false) {
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

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function readJsonl(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) return [];
  const out: AnyObj[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') out.push(row);
    } catch {}
  }
  return out;
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(value: unknown, fallbackRel: string) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
}

function defaultPolicy() {
  return {
    version: '1.0',
    tracing: {
      enabled: true,
      spans_path: 'state/observability/tracing/spans.jsonl',
      latest_path: 'state/observability/tracing/latest.json',
      max_attr_count: 24,
      max_attr_key_length: 64,
      max_attr_value_length: 200
    }
  };
}

function loadPolicy(policyPathRaw: unknown) {
  const policyPath = resolvePath(
    policyPathRaw || process.env.OBSERVABILITY_POLICY_PATH || DEFAULT_POLICY_PATH,
    'config/observability_policy.json'
  );
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const src = raw && raw.tracing && typeof raw.tracing === 'object' ? raw.tracing : {};
  return {
    path: policyPath,
    version: cleanText(raw && raw.version ? raw.version : base.version, 24) || '1.0',
    tracing: {
      enabled: src.enabled !== false,
      spans_path: resolvePath(src.spans_path, base.tracing.spans_path),
      latest_path: resolvePath(src.latest_path, base.tracing.latest_path),
      max_attr_count: clampInt(src.max_attr_count, 1, 200, base.tracing.max_attr_count),
      max_attr_key_length: clampInt(src.max_attr_key_length, 8, 256, base.tracing.max_attr_key_length),
      max_attr_value_length: clampInt(src.max_attr_value_length, 16, 2000, base.tracing.max_attr_value_length)
    }
  };
}

function randomHex(bytes: number) {
  return crypto.randomBytes(bytes).toString('hex');
}

function parseAttrs(raw: unknown) {
  if (raw == null) return {};
  const s = String(raw).trim();
  if (!s) return {};
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch {}
  return {};
}

function sanitizeAttrs(attrs: AnyObj, policy: AnyObj) {
  const out: AnyObj = {};
  const entries = Object.entries(attrs || {}).slice(0, policy.tracing.max_attr_count);
  for (const [k, v] of entries) {
    const key = cleanText(k, policy.tracing.max_attr_key_length).toLowerCase();
    if (!key) continue;
    out[key] = cleanText(v, policy.tracing.max_attr_value_length);
  }
  return out;
}

function cmdSpan(args: AnyObj) {
  const policy = loadPolicy(args.policy);
  if (!policy.tracing.enabled) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      type: 'trace_bridge',
      ts: nowIso(),
      skipped: true,
      reason: 'tracing_disabled',
      policy_path: policy.path
    })}\n`);
    return;
  }

  const spanName = cleanText(args.name || '', 120);
  if (!spanName) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'name_required' })}\n`);
    process.exit(1);
  }
  const statusRaw = String(args.status || 'ok').trim().toLowerCase();
  const status = ['ok', 'warn', 'error'].includes(statusRaw) ? statusRaw : 'ok';
  const durationMs = clampInt(args['duration-ms'] || args.duration_ms, 0, 7 * 24 * 60 * 60 * 1000, 0);
  const writeEnabled = boolFlag(args.write, true);

  const span = {
    ts: nowIso(),
    type: 'trace_span',
    trace_id: cleanText(args['trace-id'] || args.trace_id, 64) || randomHex(16),
    span_id: cleanText(args['span-id'] || args.span_id, 32) || randomHex(8),
    parent_span_id: cleanText(args['parent-span-id'] || args.parent_span_id, 32) || null,
    name: spanName,
    service: cleanText(args.service || 'protheus', 60) || 'protheus',
    component: cleanText(args.component || 'spine', 80) || 'spine',
    status,
    duration_ms: durationMs,
    attributes: sanitizeAttrs(parseAttrs(args['attrs-json'] || args.attrs_json), policy)
  };

  if (writeEnabled) {
    appendJsonl(policy.tracing.spans_path, span);
    writeJsonAtomic(policy.tracing.latest_path, span);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'trace_bridge',
    ts: nowIso(),
    write_enabled: writeEnabled,
    span,
    spans_path: relPath(policy.tracing.spans_path),
    latest_path: relPath(policy.tracing.latest_path)
  })}\n`);
}

function cmdSummary(args: AnyObj) {
  const policy = loadPolicy(args.policy);
  const hours = clampInt(args.hours, 1, 24 * 90, 24);
  const cutoff = nowMs() - (hours * 60 * 60 * 1000);
  const rows = readJsonl(policy.tracing.spans_path);
  const inWindow = rows.filter((row) => {
    const ts = Date.parse(String(row && row.ts || ''));
    return Number.isFinite(ts) && ts >= cutoff;
  });
  const byStatus: AnyObj = { ok: 0, warn: 0, error: 0 };
  const byName: AnyObj = {};
  for (const row of inWindow) {
    const status = String(row && row.status || 'ok').toLowerCase();
    if (status in byStatus) byStatus[status] += 1;
    else byStatus.ok += 1;
    const name = cleanText(row && row.name || 'unknown', 120) || 'unknown';
    byName[name] = Number(byName[name] || 0) + 1;
  }
  const topNames = Object.entries(byName)
    .map(([name, count]) => ({ name, count: Number(count) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'trace_bridge_summary',
    ts: nowIso(),
    hours,
    spans_path: relPath(policy.tracing.spans_path),
    spans_total: inWindow.length,
    status_counts: byStatus,
    top_names: topNames
  })}\n`);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy);
  const latest = readJson(policy.tracing.latest_path, null);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'trace_bridge_status',
    ts: nowIso(),
    policy_path: policy.path,
    policy_version: policy.version,
    tracing_enabled: policy.tracing.enabled,
    spans_path: relPath(policy.tracing.spans_path),
    latest_path: relPath(policy.tracing.latest_path),
    latest_span_ts: latest && latest.ts ? latest.ts : null,
    latest_span_name: latest && latest.name ? latest.name : null,
    latest_span_status: latest && latest.status ? latest.status : null
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawCmd = String(args._[0] || '').trim().toLowerCase();
  if (args.help || !rawCmd || rawCmd === 'help' || rawCmd === '--help' || rawCmd === '-h') {
    usage();
    return;
  }
  const cmd = rawCmd;
  if (cmd === 'span') {
    cmdSpan(args);
    return;
  }
  if (cmd === 'summary') {
    cmdSummary(args);
    return;
  }
  if (cmd === 'status') {
    cmdStatus(args);
    return;
  }
  usage();
  process.exit(2);
}

try {
  main();
} catch (err: any) {
  process.stderr.write(`trace_bridge.js: FAIL: ${String(err && err.message || err || 'unknown_error')}\n`);
  process.exit(1);
}

export {};
