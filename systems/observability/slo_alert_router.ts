#!/usr/bin/env node
'use strict';

/**
 * slo_alert_router.js
 *
 * Routes autonomy health alerts to configured sinks.
 *
 * Usage:
 *   node systems/observability/slo_alert_router.js route [YYYY-MM-DD] [--source=/abs/path.jsonl] [--window=daily] [--min-level=warn] [--max=200] [--policy=/abs/path.json] [--write=1|0]
 *   node systems/observability/slo_alert_router.js status [--policy=/abs/path.json]
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(process.env.OBSERVABILITY_ROOT || path.join(__dirname, '..', '..'));
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'observability_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/observability/slo_alert_router.js route [YYYY-MM-DD] [--source=/abs/path.jsonl] [--window=daily] [--min-level=warn] [--max=200] [--policy=/abs/path.json] [--write=1|0]');
  console.log('  node systems/observability/slo_alert_router.js status [--policy=/abs/path.json]');
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

function todayStr() {
  return nowIso().slice(0, 10);
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

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
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

function levelRank(level: string) {
  const norm = String(level || '').trim().toLowerCase();
  if (norm === 'critical') return 2;
  if (norm === 'warn' || norm === 'warning') return 1;
  if (norm === 'ok') return 0;
  return -1;
}

function defaultPolicy() {
  return {
    version: '1.0',
    alert_routing: {
      enabled: true,
      min_level: 'warn',
      max_per_run: 400,
      source_alerts_dir: 'state/autonomy/health_alerts',
      state_path: 'state/observability/alerts/router_state.json',
      routed_jsonl_path: 'state/observability/alerts/routed.jsonl',
      max_state_keys: 12000,
      sinks: {
        file: { enabled: true },
        stdout: { enabled: false },
        webhook: {
          enabled: false,
          url: '',
          url_env: 'OBSERVABILITY_ALERT_WEBHOOK_URL',
          timeout_ms: 5000
        }
      }
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
  const src = raw && raw.alert_routing && typeof raw.alert_routing === 'object' ? raw.alert_routing : {};
  const sinks = src && src.sinks && typeof src.sinks === 'object' ? src.sinks : {};
  const fileSink = sinks.file && typeof sinks.file === 'object' ? sinks.file : {};
  const stdoutSink = sinks.stdout && typeof sinks.stdout === 'object' ? sinks.stdout : {};
  const webhookSink = sinks.webhook && typeof sinks.webhook === 'object' ? sinks.webhook : {};

  return {
    path: policyPath,
    version: cleanText(raw && raw.version ? raw.version : base.version, 24) || '1.0',
    alert_routing: {
      enabled: src.enabled !== false,
      min_level: ['ok', 'warn', 'critical'].includes(String(src.min_level || '').trim().toLowerCase())
        ? String(src.min_level).trim().toLowerCase()
        : base.alert_routing.min_level,
      max_per_run: clampInt(src.max_per_run, 1, 5000, base.alert_routing.max_per_run),
      source_alerts_dir: resolvePath(src.source_alerts_dir, base.alert_routing.source_alerts_dir),
      state_path: resolvePath(src.state_path, base.alert_routing.state_path),
      routed_jsonl_path: resolvePath(src.routed_jsonl_path, base.alert_routing.routed_jsonl_path),
      max_state_keys: clampInt(src.max_state_keys, 100, 200000, base.alert_routing.max_state_keys),
      sinks: {
        file: {
          enabled: fileSink.enabled !== false
        },
        stdout: {
          enabled: stdoutSink.enabled === true
        },
        webhook: {
          enabled: webhookSink.enabled === true,
          url: cleanText(webhookSink.url || '', 500),
          url_env: cleanText(webhookSink.url_env || base.alert_routing.sinks.webhook.url_env, 80) || base.alert_routing.sinks.webhook.url_env,
          timeout_ms: clampInt(webhookSink.timeout_ms, 500, 30000, base.alert_routing.sinks.webhook.timeout_ms)
        }
      }
    }
  };
}

function resolveSourcePath(policy: AnyObj, args: AnyObj, dateStr: string) {
  if (String(args.source || '').trim()) {
    return resolvePath(args.source, 'state/autonomy/health_alerts/unknown.jsonl');
  }
  return path.join(policy.alert_routing.source_alerts_dir, `${dateStr}.jsonl`);
}

function loadRouterState(statePath: string) {
  const raw = readJson(statePath, {});
  const keys = raw && raw.routed_keys && typeof raw.routed_keys === 'object' ? raw.routed_keys : {};
  return {
    version: '1.0',
    updated_at: raw && raw.updated_at ? String(raw.updated_at) : null,
    routed_keys: keys
  };
}

function compactRouterState(state: AnyObj, maxKeys: number) {
  const entries = Object.entries(state.routed_keys || {}).map(([k, ts]) => ({
    key: String(k || ''),
    ts: Date.parse(String(ts || ''))
  })).filter((x) => x.key && Number.isFinite(x.ts));
  entries.sort((a, b) => b.ts - a.ts);
  const keep = entries.slice(0, maxKeys);
  const next: AnyObj = {};
  for (const row of keep) next[row.key] = new Date(row.ts).toISOString();
  state.routed_keys = next;
}

function shouldRoute(row: AnyObj, minLevel: string) {
  const rowLevel = String(row && row.level || '').trim().toLowerCase();
  return levelRank(rowLevel) >= levelRank(minLevel);
}

function toRoutedRow(row: AnyObj) {
  const key = cleanText(row && row.alert_key ? row.alert_key : '', 64);
  return {
    ts: nowIso(),
    type: 'observability_alert_routed',
    source_type: cleanText(row && row.type ? row.type : 'autonomy_health_alert', 60) || 'autonomy_health_alert',
    alert_key: key || null,
    date: cleanText(row && row.date ? row.date : '', 32) || null,
    window: cleanText(row && row.window ? row.window : '', 24) || null,
    check: cleanText(row && row.check ? row.check : '', 80) || null,
    level: cleanText(row && row.level ? row.level : 'warn', 16) || 'warn',
    summary: cleanText(row && row.summary ? row.summary : '', 220),
    metrics: row && row.metrics && typeof row.metrics === 'object' ? row.metrics : {},
    thresholds: row && row.thresholds && typeof row.thresholds === 'object' ? row.thresholds : {}
  };
}

function postJson(urlRaw: string, bodyObj: AnyObj, timeoutMs: number): Promise<AnyObj> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(urlRaw);
    } catch {
      resolve({ ok: false, error: 'invalid_url' });
      return;
    }
    const payload = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const isHttps = url.protocol === 'https:';
    const req = (isHttps ? https : http).request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      method: 'POST',
      path: `${url.pathname || '/'}${url.search || ''}`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(payload.length)
      },
      timeout: timeoutMs
    }, (res: AnyObj) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(Buffer.from(d)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = Number(res.statusCode || 0);
        resolve({
          ok: status >= 200 && status < 300,
          status,
          body: cleanText(text, 300)
        });
      });
    });
    req.on('error', (err: Error) => resolve({
      ok: false,
      error: cleanText(err && err.message ? err.message : err, 180)
    }));
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.write(payload);
    req.end();
  });
}

async function cmdRoute(args: AnyObj) {
  const dateStr = cleanText(args._[1] || todayStr(), 10) || todayStr();
  const window = String(args.window || 'daily').trim().toLowerCase() === 'weekly' ? 'weekly' : 'daily';
  const policy = loadPolicy(args.policy);
  const writeEnabled = boolFlag(args.write, true);
  const sourcePath = resolveSourcePath(policy, args, dateStr);
  const minLevel = ['ok', 'warn', 'critical'].includes(String(args['min-level'] || '').trim().toLowerCase())
    ? String(args['min-level']).trim().toLowerCase()
    : policy.alert_routing.min_level;
  const maxPerRun = clampInt(args.max, 1, 5000, policy.alert_routing.max_per_run);

  if (!policy.alert_routing.enabled) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      type: 'slo_alert_router',
      ts: nowIso(),
      skipped: true,
      reason: 'alert_routing_disabled',
      date: dateStr,
      window,
      policy_path: policy.path
    })}\n`);
    return;
  }

  const rows = readJsonl(sourcePath)
    .filter((row) => row && typeof row === 'object')
    .filter((row) => String(row.type || '') === 'autonomy_health_alert');
  const state = loadRouterState(policy.alert_routing.state_path);
  const out: AnyObj = {
    ok: true,
    type: 'slo_alert_router',
    ts: nowIso(),
    date: dateStr,
    window,
    policy_path: policy.path,
    policy_version: policy.version,
    source_path: relPath(sourcePath),
    write_enabled: writeEnabled,
    min_level: minLevel,
    source_total: rows.length,
    inspected: 0,
    filtered_out: 0,
    already_routed: 0,
    routed: 0,
    webhook_delivered: 0,
    webhook_failed: 0,
    sinks: {
      file: policy.alert_routing.sinks.file.enabled,
      stdout: policy.alert_routing.sinks.stdout.enabled,
      webhook: policy.alert_routing.sinks.webhook.enabled
    },
    routed_path: relPath(policy.alert_routing.routed_jsonl_path),
    state_path: relPath(policy.alert_routing.state_path),
    routed_keys_state_size: Object.keys(state.routed_keys || {}).length
  };

  const maxRows = Math.min(maxPerRun, rows.length);
  const webhookUrl = policy.alert_routing.sinks.webhook.url
    || cleanText(process.env[policy.alert_routing.sinks.webhook.url_env] || '', 500);

  for (let i = 0; i < maxRows; i += 1) {
    const row = rows[i];
    out.inspected += 1;
    if (!shouldRoute(row, minLevel)) {
      out.filtered_out += 1;
      continue;
    }
    const routedRow = toRoutedRow(row);
    const alertKey = routedRow.alert_key || cleanText(`${routedRow.check}:${routedRow.level}:${routedRow.summary}`, 120);
    if (alertKey && state.routed_keys && state.routed_keys[alertKey]) {
      out.already_routed += 1;
      continue;
    }
    if (writeEnabled && policy.alert_routing.sinks.file.enabled) {
      appendJsonl(policy.alert_routing.routed_jsonl_path, routedRow);
    }
    if (policy.alert_routing.sinks.stdout.enabled) {
      process.stdout.write(`${JSON.stringify({ type: 'slo_alert_router_stdout', alert: routedRow })}\n`);
    }
    if (policy.alert_routing.sinks.webhook.enabled && webhookUrl) {
      const res = writeEnabled
        ? await postJson(webhookUrl, routedRow, policy.alert_routing.sinks.webhook.timeout_ms)
        : { ok: true, skipped: true };
      if (res.ok) out.webhook_delivered += 1;
      else out.webhook_failed += 1;
    }
    if (alertKey) {
      state.routed_keys[alertKey] = nowIso();
    }
    out.routed += 1;
  }

  compactRouterState(state, policy.alert_routing.max_state_keys);
  state.updated_at = nowIso();
  if (writeEnabled) {
    writeJsonAtomic(policy.alert_routing.state_path, state);
  }
  out.routed_keys_state_size = Object.keys(state.routed_keys || {}).length;

  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy);
  const state = loadRouterState(policy.alert_routing.state_path);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'slo_alert_router_status',
    ts: nowIso(),
    policy_path: policy.path,
    policy_version: policy.version,
    routing_enabled: policy.alert_routing.enabled,
    min_level: policy.alert_routing.min_level,
    source_alerts_dir: relPath(policy.alert_routing.source_alerts_dir),
    routed_path: relPath(policy.alert_routing.routed_jsonl_path),
    state_path: relPath(policy.alert_routing.state_path),
    routed_keys_state_size: Object.keys(state.routed_keys || {}).length,
    state_updated_at: state.updated_at || null,
    sinks: {
      file: policy.alert_routing.sinks.file.enabled,
      stdout: policy.alert_routing.sinks.stdout.enabled,
      webhook: policy.alert_routing.sinks.webhook.enabled
    }
  })}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawCmd = String(args._[0] || '').trim().toLowerCase();
  if (args.help || !rawCmd || rawCmd === 'help' || rawCmd === '--help' || rawCmd === '-h') {
    usage();
    return;
  }
  const cmd = rawCmd;
  if (cmd === 'route') {
    await cmdRoute(args);
    return;
  }
  if (cmd === 'status') {
    cmdStatus(args);
    return;
  }
  usage();
  process.exit(2);
}

main().catch((err: any) => {
  process.stderr.write(`slo_alert_router.js: FAIL: ${String(err && err.message || err || 'unknown_error')}\n`);
  process.exit(1);
});

export {};
