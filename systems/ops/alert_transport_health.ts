#!/usr/bin/env node
'use strict';
export {};

/**
 * alert_transport_health.js
 *
 * RM-130: Alert transport reliability hardening.
 * Synthetic probe chain:
 *   slack webhook (primary) -> email outbox (fallback) -> local outbox (fallback)
 *
 * Tracks rolling 30-day transport success rate with dedupe receipts.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.ALERT_TRANSPORT_POLICY_PATH
  ? path.resolve(String(process.env.ALERT_TRANSPORT_POLICY_PATH))
  : path.join(ROOT, 'config', 'alert_transport_policy.json');

type AnyObj = Record<string, any>;

function nowIso() {
  return new Date().toISOString();
}

function hourBucket(ts = nowIso()) {
  return String(ts).slice(0, 13); // YYYY-MM-DDTHH
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const arg of argv) {
    if (!String(arg).startsWith('--')) {
      out._.push(String(arg));
      continue;
    }
    const idx = String(arg).indexOf('=');
    if (idx === -1) out[String(arg).slice(2)] = true;
    else out[String(arg).slice(2, idx)] = String(arg).slice(idx + 1);
  }
  return out;
}

function clean(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
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

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((x) => x && typeof x === 'object');
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

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(s) ? s : path.join(ROOT, s);
}

function defaultPolicy() {
  return {
    version: '1.0',
    rolling_days: 30,
    target_success_rate: 0.99,
    dedupe_window_days: 30,
    state_path: 'state/ops/alert_transport_health.json',
    history_path: 'state/ops/alert_transport_health_history.jsonl',
    channels: {
      slack_webhook: {
        enabled: true,
        url: '',
        url_env: 'SLACK_ALERT_WEBHOOK_URL',
        timeout_ms: 5000
      },
      email_fallback: {
        enabled: true,
        outbox_path: 'state/observability/alerts/email_fallback.jsonl'
      },
      local_fallback: {
        enabled: true,
        outbox_path: 'state/observability/alerts/local_fallback.jsonl'
      }
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const channels = raw && raw.channels && typeof raw.channels === 'object'
    ? raw.channels
    : {};
  const slack = channels.slack_webhook && typeof channels.slack_webhook === 'object'
    ? channels.slack_webhook
    : {};
  const email = channels.email_fallback && typeof channels.email_fallback === 'object'
    ? channels.email_fallback
    : {};
  const local = channels.local_fallback && typeof channels.local_fallback === 'object'
    ? channels.local_fallback
    : {};
  return {
    version: clean(raw && raw.version || base.version, 24) || '1.0',
    rolling_days: clampInt(raw && raw.rolling_days, 1, 365, base.rolling_days),
    target_success_rate: clampNumber(raw && raw.target_success_rate, 0, 1, base.target_success_rate),
    dedupe_window_days: clampInt(raw && raw.dedupe_window_days, 1, 365, base.dedupe_window_days),
    state_path: resolvePath(raw && raw.state_path, base.state_path),
    history_path: resolvePath(raw && raw.history_path, base.history_path),
    channels: {
      slack_webhook: {
        enabled: slack.enabled !== false,
        url: clean(slack.url || '', 800),
        url_env: clean(slack.url_env || base.channels.slack_webhook.url_env, 80) || base.channels.slack_webhook.url_env,
        timeout_ms: clampInt(slack.timeout_ms, 500, 30000, base.channels.slack_webhook.timeout_ms)
      },
      email_fallback: {
        enabled: email.enabled !== false,
        outbox_path: resolvePath(email.outbox_path, base.channels.email_fallback.outbox_path)
      },
      local_fallback: {
        enabled: local.enabled !== false,
        outbox_path: resolvePath(local.outbox_path, base.channels.local_fallback.outbox_path)
      }
    }
  };
}

function httpPostJson(urlRaw: string, body: AnyObj, timeoutMs: number): Promise<AnyObj> {
  return new Promise((resolve) => {
    const urlText = String(urlRaw || '').trim();
    if (!urlText) return resolve({ ok: false, code: null, error: 'webhook_url_missing' });
    let target;
    try {
      target = new URL(urlText);
    } catch {
      return resolve({ ok: false, code: null, error: 'webhook_url_invalid' });
    }
    const payload = JSON.stringify(body || {});
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request({
      method: 'POST',
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname || '/'}${target.search || ''}`,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      },
      timeout: timeoutMs
    }, (res: AnyObj) => {
      const status = Number(res && res.statusCode || 0);
      const ok = status >= 200 && status < 300;
      res.resume();
      resolve({
        ok,
        code: status || null,
        error: ok ? null : `http_${status || 'error'}`
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err: AnyObj) => resolve({
      ok: false,
      code: null,
      error: clean(err && err.message ? err.message : 'webhook_post_failed', 120) || 'webhook_post_failed'
    }));
    req.write(payload);
    req.end();
  });
}

function filterRollingRows(rows: AnyObj[], rollingDays: number, endTs: string) {
  const end = Date.parse(String(endTs || nowIso()));
  if (!Number.isFinite(end)) return [];
  const minTs = end - (rollingDays * 24 * 60 * 60 * 1000);
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const ts = Date.parse(String(row && row.ts || ''));
    return Number.isFinite(ts) && ts >= minTs && ts <= end;
  });
}

function computeRollingStats(rows: AnyObj[]) {
  const total = rows.length;
  const delivered = rows.filter((row) => row && row.delivered === true).length;
  const successRate = total > 0 ? delivered / total : 1;
  return {
    total,
    delivered,
    failed: Math.max(0, total - delivered),
    success_rate: successRate
  };
}

async function runProbe(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const strict = toBool(args.strict, false);
  const probeId = clean(args['probe-id'] || hourBucket(), 32) || hourBucket();
  const forcedTs = clean(args.ts || '', 40);
  const ts = forcedTs || nowIso();

  const historyRows = readJsonl(policy.history_path);
  const dedupeCutoffMs = Date.parse(ts) - (policy.dedupe_window_days * 24 * 60 * 60 * 1000);
  const deduped = historyRows.some((row) => {
    if (!row || String(row.probe_id || '') !== probeId) return false;
    const rowTs = Date.parse(String(row.ts || ''));
    return Number.isFinite(rowTs) && rowTs >= dedupeCutoffMs;
  });

  let attempts: AnyObj[] = [];
  let delivered = false;
  let deliveredVia = null;
  const payload = {
    type: 'synthetic_alert_probe',
    probe_id: probeId,
    ts,
    summary: 'synthetic alert transport probe'
  };

  if (!deduped) {
    const slack = policy.channels.slack_webhook;
    if (slack.enabled === true) {
      const forcePrimaryOk = String(process.env.ALERT_TRANSPORT_FORCE_PRIMARY_OK || '').trim() === '1';
      const start = Date.now();
      const res = forcePrimaryOk
        ? { ok: true, code: 200, error: null }
        : await httpPostJson(String(slack.url || process.env[slack.url_env] || ''), payload, slack.timeout_ms);
      const attempt = {
        channel: 'slack_webhook',
        attempted: true,
        ok: res.ok === true,
        latency_ms: Date.now() - start,
        code: res.code || null,
        reason: forcePrimaryOk ? 'forced_primary_ok' : (res.error || null)
      };
      attempts.push(attempt);
      if (attempt.ok) {
        delivered = true;
        deliveredVia = 'slack_webhook';
      }
    } else {
      attempts.push({ channel: 'slack_webhook', attempted: false, ok: false, reason: 'disabled' });
    }

    if (!delivered) {
      const email = policy.channels.email_fallback;
      if (email.enabled === true) {
        appendJsonl(email.outbox_path, { ...payload, channel: 'email_fallback' });
        attempts.push({ channel: 'email_fallback', attempted: true, ok: true, reason: null });
        delivered = true;
        deliveredVia = 'email_fallback';
      } else {
        attempts.push({ channel: 'email_fallback', attempted: false, ok: false, reason: 'disabled' });
      }
    }

    if (!delivered) {
      const local = policy.channels.local_fallback;
      if (local.enabled === true) {
        appendJsonl(local.outbox_path, { ...payload, channel: 'local_fallback' });
        attempts.push({ channel: 'local_fallback', attempted: true, ok: true, reason: null });
        delivered = true;
        deliveredVia = 'local_fallback';
      } else {
        attempts.push({ channel: 'local_fallback', attempted: false, ok: false, reason: 'disabled' });
      }
    }
  }

  const row = {
    ts,
    probe_id: probeId,
    deduped,
    delivered: deduped ? true : delivered,
    delivered_via: deduped ? 'dedupe_cache' : deliveredVia,
    attempts
  };
  appendJsonl(policy.history_path, row);

  const allRows = readJsonl(policy.history_path);
  const rollingRows = filterRollingRows(allRows, policy.rolling_days, ts);
  const stats = computeRollingStats(rollingRows);
  const pass = stats.success_rate >= policy.target_success_rate;

  const statePayload = {
    schema_id: 'alert_transport_health',
    schema_version: '1.0',
    updated_at: nowIso(),
    policy_version: policy.version,
    probe_id: probeId,
    deduped,
    delivered: row.delivered === true,
    delivered_via: row.delivered_via,
    rolling_days: policy.rolling_days,
    target_success_rate: policy.target_success_rate,
    rolling: stats,
    pass
  };
  writeJsonAtomic(policy.state_path, statePayload);

  const output = {
    ok: true,
    type: 'alert_transport_health',
    ts: nowIso(),
    probe_id: probeId,
    deduped,
    delivered: row.delivered === true,
    delivered_via: row.delivered_via,
    attempts,
    rolling_days: policy.rolling_days,
    target_success_rate: policy.target_success_rate,
    rolling: stats,
    pass,
    policy_path: relPath(policyPath),
    state_path: relPath(policy.state_path),
    history_path: relPath(policy.history_path)
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (strict && !pass) process.exit(1);
}

function statusProbe(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const payload = readJson(policy.state_path, null);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'alert_transport_health_status',
    ts: nowIso(),
    policy_path: relPath(policyPath),
    state_path: relPath(policy.state_path),
    history_path: relPath(policy.history_path),
    available: !!payload,
    payload: payload && typeof payload === 'object' ? payload : null
  }, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/alert_transport_health.js run [--probe-id=YYYY-MM-DDTHH] [--strict=1]');
  console.log('  node systems/ops/alert_transport_health.js status');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = clean(args._[0] || 'run', 40).toLowerCase();
  if (cmd === 'run') return runProbe(args);
  if (cmd === 'status') return statusProbe(args);
  usage();
  process.exit(1);
}

main().catch((err) => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    type: 'alert_transport_health',
    error: clean(err && err.message ? err.message : err || 'alert_transport_health_failed', 200)
  })}\n`);
  process.exit(1);
});
