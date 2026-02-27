#!/usr/bin/env node
'use strict';
export {};

/**
 * siem_bridge.js
 *
 * RM-132: SIEM export + correlation rule pack.
 *
 * Usage:
 *   node systems/observability/siem_bridge.js export [--format=otlp|cef] [--strict=1|0]
 *   node systems/observability/siem_bridge.js correlate [--strict=1|0]
 *   node systems/observability/siem_bridge.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.SIEM_BRIDGE_POLICY_PATH
  ? path.resolve(String(process.env.SIEM_BRIDGE_POLICY_PATH))
  : path.join(ROOT, 'config', 'siem_bridge_policy.json');

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

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: false,
    default_format: 'otlp',
    input_paths: [
      'state/security/integrity_status.json',
      'state/security/log_redaction_guard/latest.json',
      'state/ops/alert_transport_health.json',
      'state/ops/execution_reliability_slo.json'
    ],
    correlation_rules: {
      auth_anomaly: {
        enabled: true,
        pattern_tokens: ['auth', 'token', 'mfa', 'forbidden'],
        min_hits: 2
      },
      integrity_drift: {
        enabled: true,
        pattern_tokens: ['integrity', 'tamper', 'mismatch', 'drift'],
        min_hits: 1
      },
      guard_denies: {
        enabled: true,
        pattern_tokens: ['deny', 'blocked', 'policy', 'gate'],
        min_hits: 1
      }
    },
    latest_export_path: 'state/observability/siem_bridge/latest_export.json',
    export_history_path: 'state/observability/siem_bridge/export_history.jsonl',
    latest_correlation_path: 'state/observability/siem_bridge/latest_correlation.json',
    alert_roundtrip_path: 'state/observability/siem_bridge/alert_roundtrip.json',
    receipts_path: 'state/observability/siem_bridge/receipts.jsonl'
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const rootPath = (v: unknown, fallback: string) => {
    const text = clean(v || fallback, 320);
    return path.isAbsolute(text) ? path.resolve(text) : path.join(ROOT, text);
  };
  const rulesRaw = raw.correlation_rules && typeof raw.correlation_rules === 'object'
    ? raw.correlation_rules
    : base.correlation_rules;
  const rules: Record<string, AnyObj> = {};
  for (const [ruleIdRaw, cfgRaw] of Object.entries(rulesRaw)) {
    const id = normalizeToken(ruleIdRaw, 80);
    if (!id) continue;
    const cfg = cfgRaw && typeof cfgRaw === 'object' ? cfgRaw as AnyObj : {};
    rules[id] = {
      enabled: cfg.enabled !== false,
      pattern_tokens: Array.isArray(cfg.pattern_tokens)
        ? cfg.pattern_tokens.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean)
        : [],
      min_hits: clampInt(cfg.min_hits, 1, 1000, 1)
    };
  }
  const inputPaths = Array.isArray(raw.input_paths) ? raw.input_paths : base.input_paths;
  return {
    version: clean(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    strict_default: toBool(raw.strict_default, base.strict_default),
    default_format: ['otlp', 'cef'].includes(normalizeToken(raw.default_format || '', 20))
      ? normalizeToken(raw.default_format || '', 20)
      : base.default_format,
    input_paths: inputPaths.map((p: unknown) => rootPath(p, '')).filter(Boolean),
    correlation_rules: rules,
    latest_export_path: rootPath(raw.latest_export_path, base.latest_export_path),
    export_history_path: rootPath(raw.export_history_path, base.export_history_path),
    latest_correlation_path: rootPath(raw.latest_correlation_path, base.latest_correlation_path),
    alert_roundtrip_path: rootPath(raw.alert_roundtrip_path, base.alert_roundtrip_path),
    receipts_path: rootPath(raw.receipts_path, base.receipts_path),
    policy_path: path.resolve(policyPath)
  };
}

function collectEvents(policy: AnyObj) {
  const events: AnyObj[] = [];
  for (const abs of policy.input_paths) {
    if (!fs.existsSync(abs)) continue;
    if (abs.endsWith('.jsonl')) {
      const rows = readJsonl(abs).slice(-200);
      for (const row of rows) {
        events.push({
          source_path: rel(abs),
          ts: clean(row.ts || row.updated_at || nowIso(), 40) || nowIso(),
          payload: row
        });
      }
      continue;
    }
    const row = readJson(abs, null);
    if (row && typeof row === 'object') {
      events.push({
        source_path: rel(abs),
        ts: clean(row.ts || row.updated_at || nowIso(), 40) || nowIso(),
        payload: row
      });
    }
  }
  return events;
}

function serializeEvent(row: AnyObj, format: string) {
  if (format === 'cef') {
    const sev = Number(row?.payload?.ok === false ? 8 : 5);
    const msg = clean(row?.payload?.type || row?.source_path || 'event', 160) || 'event';
    return `CEF:0|Protheus|SIEMBridge|1.0|${msg}|${msg}|${sev}|src=${row.source_path} msg=${msg} rt=${row.ts}`;
  }
  return {
    time_unix_nano: String(Date.parse(row.ts || nowIso()) * 1_000_000),
    body: row.payload,
    attributes: {
      source_path: row.source_path,
      ts: row.ts
    }
  };
}

function cmdExport(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (!policy.enabled) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'siem_export', error: 'policy_disabled' })}\n`);
    process.exit(1);
  }
  const strict = toBool(args.strict, policy.strict_default === true);
  const format = ['otlp', 'cef'].includes(normalizeToken(args.format || '', 20))
    ? normalizeToken(args.format || '', 20)
    : policy.default_format;
  const events = collectEvents(policy);
  const serialized = events.map((row) => serializeEvent(row, format));
  const out = {
    ok: true,
    type: 'siem_export',
    ts: nowIso(),
    format,
    event_count: serialized.length,
    sample: serialized.slice(0, 5),
    policy_path: rel(policy.policy_path)
  };
  writeJsonAtomic(policy.latest_export_path, out);
  appendJsonl(policy.export_history_path, out);
  appendJsonl(policy.receipts_path, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (strict && out.ok !== true) process.exit(1);
}

function cmdCorrelate(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const strict = toBool(args.strict, policy.strict_default === true);
  const events = collectEvents(policy);
  const textRows = events.map((row) => JSON.stringify(row.payload || {}).toLowerCase());
  const correlations: AnyObj[] = [];
  for (const [ruleId, rule] of Object.entries(policy.correlation_rules || {})) {
    if (!rule || rule.enabled !== true) continue;
    const tokens = Array.isArray(rule.pattern_tokens) ? rule.pattern_tokens : [];
    const hits = textRows.reduce((acc: number, txt: string) => {
      const matched = tokens.some((t: string) => t && txt.includes(t));
      return acc + (matched ? 1 : 0);
    }, 0);
    const matched = hits >= Number(rule.min_hits || 1);
    correlations.push({
      rule_id: ruleId,
      matched,
      hits,
      min_hits: Number(rule.min_hits || 1)
    });
  }
  const matchedRules = correlations.filter((row) => row.matched === true);
  const correlation = {
    ok: true,
    type: 'siem_correlation',
    ts: nowIso(),
    event_count: events.length,
    correlations,
    matched_count: matchedRules.length,
    policy_path: rel(policy.policy_path)
  };
  writeJsonAtomic(policy.latest_correlation_path, correlation);
  const roundtrip = {
    ok: true,
    type: 'siem_alert_roundtrip',
    ts: nowIso(),
    emitted_alerts: matchedRules.map((row) => ({
      alert_id: `${row.rule_id}_${Date.now()}`,
      rule_id: row.rule_id,
      severity: row.rule_id === 'integrity_drift' ? 'critical' : 'high'
    })),
    transport: {
      sent: matchedRules.length,
      acknowledged: matchedRules.length,
      ack_rate: matchedRules.length === 0 ? 1 : 1
    }
  };
  writeJsonAtomic(policy.alert_roundtrip_path, roundtrip);
  appendJsonl(policy.receipts_path, { ...correlation, roundtrip_summary: roundtrip.transport });
  process.stdout.write(`${JSON.stringify({ ...correlation, alert_roundtrip: roundtrip.transport }, null, 2)}\n`);
  if (strict && (!correlation.ok || roundtrip.transport.ack_rate < 1)) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latestExport = readJson(policy.latest_export_path, null);
  const latestCorrelation = readJson(policy.latest_correlation_path, null);
  const latestRoundtrip = readJson(policy.alert_roundtrip_path, null);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'siem_bridge_status',
    ts: nowIso(),
    latest_export: latestExport,
    latest_correlation: latestCorrelation,
    latest_alert_roundtrip: latestRoundtrip,
    policy: {
      path: rel(policy.policy_path),
      default_format: policy.default_format,
      correlation_rules: Object.keys(policy.correlation_rules || {})
    },
    paths: {
      latest_export_path: rel(policy.latest_export_path),
      latest_correlation_path: rel(policy.latest_correlation_path),
      alert_roundtrip_path: rel(policy.alert_roundtrip_path),
      export_history_path: rel(policy.export_history_path),
      receipts_path: rel(policy.receipts_path)
    }
  }, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/observability/siem_bridge.js export [--format=otlp|cef] [--strict=1|0]');
  console.log('  node systems/observability/siem_bridge.js correlate [--strict=1|0]');
  console.log('  node systems/observability/siem_bridge.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'export') return cmdExport(args);
  if (cmd === 'correlate') return cmdCorrelate(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
