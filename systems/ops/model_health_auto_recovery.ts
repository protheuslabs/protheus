#!/usr/bin/env node
'use strict';
export {};

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.MODEL_HEALTH_AUTORECOVERY_POLICY_PATH
  ? path.resolve(process.env.MODEL_HEALTH_AUTORECOVERY_POLICY_PATH)
  : path.join(ROOT, 'config', 'model_health_auto_recovery_policy.json');
const DEFAULT_STATE_DIR = process.env.MODEL_HEALTH_AUTORECOVERY_STATE_DIR
  ? path.resolve(process.env.MODEL_HEALTH_AUTORECOVERY_STATE_DIR)
  : path.join(ROOT, 'state', 'routing', 'model_health_auto_recovery');
const DEFAULT_LATEST_PATH = path.join(DEFAULT_STATE_DIR, 'latest.json');
const DEFAULT_HISTORY_PATH = path.join(DEFAULT_STATE_DIR, 'history.jsonl');
const DEFAULT_ROUTING_CONFIG_PATH = process.env.MODEL_HEALTH_AUTORECOVERY_ROUTING_CONFIG_PATH
  ? path.resolve(process.env.MODEL_HEALTH_AUTORECOVERY_ROUTING_CONFIG_PATH)
  : path.join(ROOT, 'config', 'agent_routing_rules.json');
const DEFAULT_PROVIDER_SCRIPT = process.env.MODEL_HEALTH_AUTORECOVERY_PROVIDER_SCRIPT
  ? path.resolve(process.env.MODEL_HEALTH_AUTORECOVERY_PROVIDER_SCRIPT)
  : path.join(ROOT, 'systems', 'routing', 'provider_readiness.js');
const DEFAULT_ROUTER_SCRIPT = process.env.MODEL_HEALTH_AUTORECOVERY_ROUTER_SCRIPT
  ? path.resolve(process.env.MODEL_HEALTH_AUTORECOVERY_ROUTER_SCRIPT)
  : path.join(ROOT, 'systems', 'routing', 'model_router.js');
const DEFAULT_BANS_PATH = process.env.MODEL_HEALTH_AUTORECOVERY_BANS_PATH
  ? path.resolve(process.env.MODEL_HEALTH_AUTORECOVERY_BANS_PATH)
  : path.join(ROOT, 'state', 'routing', 'banned_models.json');
const DEFAULT_DECISIONS_PATH = process.env.MODEL_HEALTH_AUTORECOVERY_DECISIONS_PATH
  ? path.resolve(process.env.MODEL_HEALTH_AUTORECOVERY_DECISIONS_PATH)
  : path.join(ROOT, 'state', 'routing', 'routing_decisions.jsonl');

function nowIso(): string {
  return new Date().toISOString();
}

function isDate(v: unknown): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim());
}

function todayStr(): string {
  return nowIso().slice(0, 10);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}): AnyObj {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, value: AnyObj): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath: string, value: AnyObj): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (const tok of argv) {
    const raw = String(tok || '').trim();
    if (!raw) continue;
    if (!raw.startsWith('--')) {
      positional.push(raw);
      continue;
    }
    const idx = raw.indexOf('=');
    if (idx === -1) {
      flags[raw.slice(2)] = '1';
    } else {
      flags[raw.slice(2, idx)] = raw.slice(idx + 1);
    }
  }
  return { positional, flags };
}

function normalizeList(v: unknown): string[] {
  if (Array.isArray(v)) {
    return Array.from(new Set(v.map((x) => String(x || '').trim()).filter(Boolean)));
  }
  const raw = String(v || '').trim();
  if (!raw) return [];
  return Array.from(new Set(raw.split(',').map((x) => String(x || '').trim()).filter(Boolean)));
}

function cleanText(v: unknown, maxLen = 200): string {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function sleepMs(ms: number): void {
  const waitMs = Math.max(0, Number(ms || 0));
  if (waitMs <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const arr = new Int32Array(sab);
  Atomics.wait(arr, 0, 0, waitMs);
}

function readRoutingAllowlist(configPath: string): string[] {
  const raw = readJson(configPath, {});
  const routing = raw && raw.routing && typeof raw.routing === 'object' ? raw.routing : {};
  const allow = Array.isArray(routing.spawn_model_allowlist) ? routing.spawn_model_allowlist : [];
  return Array.from(new Set(allow.map((x: unknown) => String(x || '').trim()).filter(Boolean)));
}

function modelMatchesProvider(provider: string, modelId: string): boolean {
  const p = String(provider || '').trim().toLowerCase();
  const m = String(modelId || '').trim().toLowerCase();
  if (!p || !m) return false;
  if (p === 'ollama') return m.startsWith('ollama/') && !m.includes(':cloud');
  return m.startsWith(`${p}/`) || m.includes(`${p}:`);
}

function localProviderModels(provider: string, allowlist: string[]): string[] {
  return allowlist.filter((model) => modelMatchesProvider(provider, model));
}

function runJson(scriptPath: string, args: string[], timeoutMs = 120000): AnyObj {
  const res = spawnSync('node', [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  const stdout = String(res.stdout || '').trim();
  let payload: AnyObj = {};
  if (stdout) {
    try {
      payload = JSON.parse(stdout);
    } catch {
      const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          payload = JSON.parse(lines[i]);
          break;
        } catch {
          // continue
        }
      }
    }
  }
  return {
    ok: Number(res.status || 0) === 0,
    code: Number(res.status || 0),
    payload,
    stdout,
    stderr: String(res.stderr || '').trim()
  };
}

function loadBans(bansPath: string): AnyObj {
  const raw = readJson(bansPath, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function saveBans(bansPath: string, bans: AnyObj): void {
  writeJson(bansPath, bans || {});
}

function applyAutoBans(
  bansPath: string,
  models: string[],
  reasonPrefix: string,
  ttlMinutes: number,
  decisionsPath: string,
  dateStr: string
): number {
  const bans = loadBans(bansPath);
  const now = Date.now();
  const expiresMs = now + (Math.max(1, ttlMinutes) * 60 * 1000);
  let changed = 0;
  for (const model of models) {
    const reason = `${reasonPrefix}:${dateStr}`;
    const current = bans[model] && typeof bans[model] === 'object' ? bans[model] : null;
    if (current && String(current.reason || '').startsWith(reasonPrefix)) {
      bans[model] = {
        ...current,
        ts: nowIso(),
        expires_ms: expiresMs,
        expires_at: new Date(expiresMs).toISOString(),
        reason
      };
      changed += 1;
      continue;
    }
    bans[model] = {
      ts: nowIso(),
      expires_ms: expiresMs,
      expires_at: new Date(expiresMs).toISOString(),
      reason
    };
    changed += 1;
    appendJsonl(decisionsPath, {
      ts: nowIso(),
      type: 'ban',
      model,
      source: 'model_health_auto_recovery',
      reason
    });
  }
  saveBans(bansPath, bans);
  return changed;
}

function clearAutoBans(
  bansPath: string,
  provider: string,
  reasonPrefix: string,
  decisionsPath: string
): number {
  const bans = loadBans(bansPath);
  let changed = 0;
  for (const [model, row] of Object.entries(bans)) {
    const entry = row && typeof row === 'object' ? row as AnyObj : {};
    const reason = String(entry.reason || '');
    if (!reason.startsWith(reasonPrefix)) continue;
    if (!modelMatchesProvider(provider, model)) continue;
    delete bans[model];
    changed += 1;
    appendJsonl(decisionsPath, {
      ts: nowIso(),
      type: 'unban',
      model,
      source: 'model_health_auto_recovery',
      reason: 'provider_recovered'
    });
  }
  if (changed > 0) saveBans(bansPath, bans);
  return changed;
}

function defaultPolicy(): AnyObj {
  return {
    version: '1.0',
    enabled: true,
    providers: ['ollama'],
    max_retries_per_provider: 3,
    retry_backoff_ms: [0, 1200, 3200],
    ban_ttl_minutes: 120,
    warmup_on_failure: true,
    warmup_max_probes: 2,
    failover_route: {
      enabled: true,
      risk: 'low',
      complexity: 'low',
      intent_template: 'model_health_auto_recovery_{provider}',
      task_template: 'provider_{provider}_unavailable'
    }
  };
}

function loadPolicy(policyPath: string): AnyObj {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const route = raw && raw.failover_route && typeof raw.failover_route === 'object'
    ? raw.failover_route
    : {};
  return {
    version: cleanText(raw && raw.version ? raw.version : base.version, 40) || '1.0',
    enabled: raw && raw.enabled === false ? false : true,
    providers: normalizeList(raw && raw.providers).length > 0
      ? normalizeList(raw && raw.providers)
      : base.providers,
    max_retries_per_provider: clampInt(raw && raw.max_retries_per_provider, 1, 8, base.max_retries_per_provider),
    retry_backoff_ms: normalizeList(raw && raw.retry_backoff_ms).map((n) => clampInt(n, 0, 10 * 60 * 1000, 0)).slice(0, 8),
    ban_ttl_minutes: clampInt(raw && raw.ban_ttl_minutes, 1, 24 * 60, base.ban_ttl_minutes),
    warmup_on_failure: raw && raw.warmup_on_failure === false ? false : true,
    warmup_max_probes: clampInt(raw && raw.warmup_max_probes, 1, 6, base.warmup_max_probes),
    failover_route: {
      enabled: route && route.enabled === false ? false : true,
      risk: ['low', 'medium', 'high'].includes(String(route.risk || '').trim().toLowerCase())
        ? String(route.risk).trim().toLowerCase()
        : base.failover_route.risk,
      complexity: ['low', 'medium', 'high'].includes(String(route.complexity || '').trim().toLowerCase())
        ? String(route.complexity).trim().toLowerCase()
        : base.failover_route.complexity,
      intent_template: cleanText(route.intent_template || base.failover_route.intent_template, 120) || base.failover_route.intent_template,
      task_template: cleanText(route.task_template || base.failover_route.task_template, 120) || base.failover_route.task_template
    }
  };
}

function renderTemplate(template: string, provider: string): string {
  return String(template || '')
    .replace(/\{provider\}/g, provider)
    .trim();
}

function runForDate(dateStr: string, policyPath: string): void {
  const policy = loadPolicy(policyPath);
  ensureDir(DEFAULT_STATE_DIR);
  if (policy.enabled === false) {
    const out = {
      ok: true,
      type: 'model_health_auto_recovery',
      ts: nowIso(),
      date: dateStr,
      skipped: true,
      reason: 'disabled',
      policy_path: path.relative(ROOT, policyPath)
    };
    writeJson(DEFAULT_LATEST_PATH, out);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }

  const allowlist = readRoutingAllowlist(DEFAULT_ROUTING_CONFIG_PATH);
  const providers = policy.providers.length > 0 ? policy.providers : ['ollama'];
  const providerRows: AnyObj[] = [];

  for (const provider of providers) {
    const backoffs = Array.isArray(policy.retry_backoff_ms) && policy.retry_backoff_ms.length > 0
      ? policy.retry_backoff_ms
      : [0, 1200, 3200];
    let finalCheck: AnyObj = null;
    const attempts: AnyObj[] = [];
    for (let attempt = 1; attempt <= Number(policy.max_retries_per_provider || 1); attempt += 1) {
      const check = runJson(DEFAULT_PROVIDER_SCRIPT, ['check', `--provider=${provider}`, '--force=1'], 120000);
      const payload = check.payload && typeof check.payload === 'object' ? check.payload : {};
      const available = payload.available === true;
      attempts.push({
        attempt,
        ts: nowIso(),
        ok: check.ok && payload && payload.ok === true,
        available,
        reason: cleanText(payload.reason || payload.error || check.stderr || check.stdout || 'provider_check_failed', 180),
        circuit_open: payload.circuit_open === true,
        circuit_open_until_ts: payload.circuit_open_until_ts || null
      });
      finalCheck = { check, payload };
      if (available) break;
      const backoffMs = clampInt(backoffs[Math.min(attempt - 1, backoffs.length - 1)], 0, 10 * 60 * 1000, 0);
      if (attempt < Number(policy.max_retries_per_provider || 1) && backoffMs > 0) sleepMs(backoffMs);
    }

    const finalPayload = finalCheck && finalCheck.payload && typeof finalCheck.payload === 'object'
      ? finalCheck.payload
      : {};
    const healthy = finalPayload.available === true;
    const reasonPrefix = `provider_${provider}_down_auto_recovery`;
    let warmup: AnyObj = null;
    let fallback: AnyObj = null;
    let bannedCount = 0;
    let unbannedCount = 0;

    if (!healthy) {
      const providerModels = localProviderModels(provider, allowlist);
      bannedCount = applyAutoBans(
        DEFAULT_BANS_PATH,
        providerModels,
        reasonPrefix,
        Number(policy.ban_ttl_minutes || 120),
        DEFAULT_DECISIONS_PATH,
        dateStr
      );
      if (policy.warmup_on_failure === true) {
        warmup = runJson(
          DEFAULT_ROUTER_SCRIPT,
          ['warmup', '--force=1', `--max-probes=${Number(policy.warmup_max_probes || 2)}`],
          120000
        );
      }
      if (policy.failover_route && policy.failover_route.enabled === true) {
        const intent = renderTemplate(String(policy.failover_route.intent_template || ''), provider);
        const task = renderTemplate(String(policy.failover_route.task_template || ''), provider);
        fallback = runJson(
          DEFAULT_ROUTER_SCRIPT,
          [
            'route',
            `--risk=${String(policy.failover_route.risk || 'low')}`,
            `--complexity=${String(policy.failover_route.complexity || 'low')}`,
            `--intent=${intent}`,
            `--task=${task}`
          ],
          120000
        );
      }
    } else {
      unbannedCount = clearAutoBans(DEFAULT_BANS_PATH, provider, reasonPrefix, DEFAULT_DECISIONS_PATH);
    }

    const fallbackPayload = fallback && fallback.payload && typeof fallback.payload === 'object'
      ? fallback.payload
      : {};
    const selectedFallbackModel = String(fallbackPayload.selected_model || '').trim() || null;
    const failoverApplied = !healthy
      ? !!selectedFallbackModel && !modelMatchesProvider(provider, selectedFallbackModel)
      : false;
    providerRows.push({
      provider,
      healthy,
      attempts: attempts.length,
      checks: attempts,
      final_reason: cleanText(finalPayload.reason || 'unknown', 160) || 'unknown',
      final_status: cleanText(finalPayload.status || 'unknown', 30) || 'unknown',
      warmup: warmup && warmup.payload && typeof warmup.payload === 'object'
        ? {
            ok: warmup.ok && warmup.payload.ok === true,
            warmed_count: Number(warmup.payload.warmed_count || 0),
            recovered_count: Number(warmup.payload.recovered_count || 0),
            skipped_reason: warmup.payload.skipped_reason || null
          }
        : null,
      failover: {
        attempted: !!fallback,
        applied: failoverApplied,
        selected_model: selectedFallbackModel,
        route_reason: fallbackPayload.reason || null
      },
      auto_bans_applied: bannedCount,
      auto_bans_cleared: unbannedCount
    });
  }

  const providersTotal = providerRows.length;
  const providersHealthy = providerRows.filter((row) => row.healthy === true).length;
  const passRate = providersTotal > 0 ? Number((providersHealthy / providersTotal).toFixed(4)) : 1;
  const out = {
    ok: true,
    type: 'model_health_auto_recovery',
    ts: nowIso(),
    date: dateStr,
    policy_path: path.relative(ROOT, policyPath),
    providers_total: providersTotal,
    providers_healthy: providersHealthy,
    provider_health_pass_rate: passRate,
    providers: providerRows
  };
  writeJson(DEFAULT_LATEST_PATH, out);
  appendJsonl(DEFAULT_HISTORY_PATH, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function statusCmd(): void {
  const latest = readJson(DEFAULT_LATEST_PATH, {});
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'model_health_auto_recovery_status',
    ts: nowIso(),
    latest
  })}\n`);
}

function usage(): void {
  console.log('Usage:');
  console.log('  node systems/ops/model_health_auto_recovery.js run [YYYY-MM-DD] [--policy=/abs/path.json]');
  console.log('  node systems/ops/model_health_auto_recovery.js status');
}

function main(): void {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = String(positional[0] || '').trim().toLowerCase();
  const policyPath = flags.policy ? path.resolve(flags.policy) : DEFAULT_POLICY_PATH;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'run') {
    const dateStr = isDate(positional[1]) ? String(positional[1]) : todayStr();
    runForDate(dateStr, policyPath);
    return;
  }
  if (cmd === 'status') {
    statusCmd();
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) main();
