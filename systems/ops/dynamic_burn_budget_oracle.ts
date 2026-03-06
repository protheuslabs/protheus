#!/usr/bin/env node
'use strict';
export {};

/**
 * dynamic_burn_budget_oracle.js
 *
 * V3-BUD-001: Real-time burn budget oracle.
 *
 * Polls provider usage/credit endpoints via secret broker + egress gateway,
 * computes runway projections, emits deterministic receipts, and provides
 * advisory signals to routing/strategy/weaver/capital/self-improvement lanes.
 *
 * Usage:
 *   node systems/ops/dynamic_burn_budget_oracle.js run [--policy=/abs/path.json] [--mock-file=/abs/mock.json] [--mock-json='{"providers":{...}}']
 *   node systems/ops/dynamic_burn_budget_oracle.js status [--policy=/abs/path.json]
 */

const fs = require('fs');
const path = require('path');
const { issueSecretHandle, resolveSecretHandle } = require('../../lib/secret_broker');
const { egressFetchText, EgressGatewayError } = require('../../lib/egress_gateway');
const { mapPressureToCostPressure } = require('../../lib/dynamic_burn_budget_signal');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.DYNAMIC_BURN_BUDGET_ORACLE_POLICY_PATH
  ? path.resolve(process.env.DYNAMIC_BURN_BUDGET_ORACLE_POLICY_PATH)
  : path.join(ROOT, 'config', 'dynamic_burn_budget_oracle_policy.json');

function nowIso() {
  return new Date().toISOString();
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

function cleanText(v: unknown, maxLen = 240) {
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

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
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

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function asFinite(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizePressure(v: unknown): 'none' | 'low' | 'medium' | 'high' | 'critical' {
  const key = normalizeToken(v, 32);
  if (key === 'critical') return 'critical';
  if (key === 'high') return 'high';
  if (key === 'medium') return 'medium';
  if (key === 'low') return 'low';
  return 'none';
}

function pressureRank(v: unknown) {
  const p = normalizePressure(v);
  if (p === 'critical') return 4;
  if (p === 'high') return 3;
  if (p === 'medium') return 2;
  if (p === 'low') return 1;
  return 0;
}

function parseMaybeJson(v: unknown) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const text = cleanText(raw, 520);
  if (!text) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(text) ? text : path.join(ROOT, text);
}

function getByPath(src: AnyObj, dottedPath: string) {
  const pathText = cleanText(dottedPath, 240);
  if (!pathText) return undefined;
  const parts = pathText.split('.').map((x) => x.trim()).filter(Boolean);
  let cur: any = src;
  for (const part of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function extractFirstNumber(src: AnyObj, paths: string[]) {
  for (const p of Array.isArray(paths) ? paths : []) {
    const raw = getByPath(src, String(p || ''));
    const n = asFinite(raw);
    if (n != null) return Number(n);
  }
  return null;
}

function parseIsoMs(v: unknown): number | null {
  const ts = Date.parse(String(v || ''));
  return Number.isFinite(ts) ? ts : null;
}

function computeNextResetDays(cfg: AnyObj, nowMs: number) {
  const cycle = normalizeToken(cfg.reset_cycle || '', 32);
  const explicitReset = parseIsoMs(cfg.reset_at_utc || cfg.reset_at || null);
  if (explicitReset != null) {
    const d = Math.max(0, (explicitReset - nowMs) / (24 * 60 * 60 * 1000));
    return Number(d.toFixed(4));
  }

  const now = new Date(nowMs);
  if (cycle === 'weekly') {
    const weekday = clampInt(cfg.reset_weekday_utc, 0, 6, 1); // Monday default.
    const hour = clampInt(cfg.reset_hour_utc, 0, 23, 0);
    const min = clampInt(cfg.reset_minute_utc, 0, 59, 0);
    const candidate = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hour,
      min,
      0,
      0
    ));
    const dayDelta = (weekday - candidate.getUTCDay() + 7) % 7;
    candidate.setUTCDate(candidate.getUTCDate() + dayDelta);
    if (candidate.getTime() <= nowMs) candidate.setUTCDate(candidate.getUTCDate() + 7);
    return Number(Math.max(0, (candidate.getTime() - nowMs) / (24 * 60 * 60 * 1000)).toFixed(4));
  }

  if (cycle === 'monthly') {
    const day = clampInt(cfg.reset_day_utc, 1, 28, 1);
    const hour = clampInt(cfg.reset_hour_utc, 0, 23, 0);
    const min = clampInt(cfg.reset_minute_utc, 0, 59, 0);
    const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day, hour, min, 0, 0));
    if (candidate.getTime() <= nowMs) {
      candidate.setUTCMonth(candidate.getUTCMonth() + 1);
      candidate.setUTCDate(day);
    }
    return Number(Math.max(0, (candidate.getTime() - nowMs) / (24 * 60 * 60 * 1000)).toFixed(4));
  }

  return null;
}

function average(values: number[]) {
  const rows = values.filter((n) => Number.isFinite(n));
  if (!rows.length) return null;
  return Number((rows.reduce((acc, n) => acc + n, 0) / rows.length).toFixed(6));
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    poll_timeout_ms: 12000,
    cadence: {
      default_minutes: 15,
      high_burn_minutes: 5,
      low_burn_minutes: 30,
      burn_spike_multiplier: 1.35
    },
    thresholds: {
      critical_runway_days: 2,
      high_runway_days: 5,
      medium_runway_days: 10,
      min_runway_days_for_capital_allocation: 3,
      min_runway_days_for_execute_escalation: 2
    },
    regime_burn_multipliers: {
      constrained_budget: 0.85,
      exploit: 1.0,
      maintain: 0.95,
      explore: 1.15,
      unknown: 1.0
    },
    providers: {
      openai: {
        enabled: true,
        secret_id: 'openai_admin_key',
        secret_scope: 'ops.dynamic_burn_budget_oracle',
        egress_scope: 'ops.dynamic_burn_budget_oracle',
        runtime_allowlist: ['api.openai.com'],
        auth_header: 'Authorization',
        auth_prefix: 'Bearer ',
        reset_cycle: 'monthly',
        reset_day_utc: 1,
        endpoints: {
          costs: { method: 'GET', url: 'https://api.openai.com/organization/costs' },
          credits: { method: 'GET', url: 'https://api.openai.com/v1/dashboard/billing/credit_grants' }
        },
        parse: {
          cost_24h_paths: ['total_cost_usd', 'costs.total_usd'],
          balance_paths: ['total_available', 'credit_grants.total_available', 'available', 'balance_usd'],
          reset_at_paths: ['reset_at', 'next_reset_at', 'credit_grants.next_reset_at']
        }
      },
      anthropic: {
        enabled: true,
        secret_id: 'anthropic_admin_key',
        secret_scope: 'ops.dynamic_burn_budget_oracle',
        egress_scope: 'ops.dynamic_burn_budget_oracle',
        runtime_allowlist: ['api.anthropic.com'],
        auth_header: 'x-api-key',
        auth_prefix: '',
        reset_cycle: 'monthly',
        reset_day_utc: 1,
        endpoints: {
          usage: { method: 'GET', url: 'https://api.anthropic.com/v1/organizations/usage_report/messages' },
          costs: { method: 'GET', url: 'https://api.anthropic.com/v1/organizations/cost_report' }
        },
        parse: {
          cost_24h_paths: ['total_cost_usd', 'cost_usd_24h', 'usage.total_cost_usd'],
          balance_paths: ['balance_usd', 'remaining_credit_usd', 'total_available'],
          reset_at_paths: ['reset_at', 'next_reset_at']
        }
      },
      xai: {
        enabled: true,
        secret_id: 'xai_admin_key',
        secret_scope: 'ops.dynamic_burn_budget_oracle',
        egress_scope: 'ops.dynamic_burn_budget_oracle',
        runtime_allowlist: ['api.x.ai', 'console.x.ai'],
        auth_header: 'Authorization',
        auth_prefix: 'Bearer ',
        reset_cycle: 'weekly',
        reset_weekday_utc: 1,
        endpoints: {
          usage: { method: 'GET', url: 'https://api.x.ai/v1/usage' },
          credits: { method: 'GET', url: 'https://api.x.ai/v1/credits' }
        },
        parse: {
          cost_24h_paths: ['total_cost_usd', 'usage.cost_usd_24h', 'cost_usd_24h'],
          balance_paths: ['available', 'credits.available', 'remaining_credit_usd', 'balance_usd'],
          reset_at_paths: ['reset_at', 'next_reset_at']
        }
      }
    },
    state: {
      state_path: 'state/ops/dynamic_burn_budget_oracle/state.json',
      latest_path: 'state/ops/dynamic_burn_budget_oracle/latest.json',
      history_path: 'state/ops/dynamic_burn_budget_oracle/history.jsonl',
      receipts_path: 'state/ops/dynamic_burn_budget_oracle/receipts.jsonl',
      weaver_hint_path: 'state/autonomy/weaver/budget_oracle_hints.jsonl',
      routing_hint_path: 'state/routing/budget_oracle_hints.jsonl',
      regime_latest_path: 'state/autonomy/fractal/regime/latest.json'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  const cadence = src.cadence && typeof src.cadence === 'object' ? src.cadence : {};
  const thresholds = src.thresholds && typeof src.thresholds === 'object' ? src.thresholds : {};
  const stateRaw = src.state && typeof src.state === 'object' ? src.state : {};
  const providersRaw = src.providers && typeof src.providers === 'object' ? src.providers : base.providers;
  const providers: AnyObj = {};

  for (const [providerIdRaw, providerCfgRaw] of Object.entries(providersRaw || {})) {
    const providerId = normalizeToken(providerIdRaw, 80);
    if (!providerId) continue;
    const cfg = providerCfgRaw && typeof providerCfgRaw === 'object' ? providerCfgRaw as AnyObj : {};
    const parseCfg = cfg.parse && typeof cfg.parse === 'object' ? cfg.parse : {};
    const endpointsRaw = cfg.endpoints && typeof cfg.endpoints === 'object' ? cfg.endpoints : {};
    const endpoints: AnyObj = {};
    for (const [endpointIdRaw, endpointCfgRaw] of Object.entries(endpointsRaw)) {
      const endpointId = normalizeToken(endpointIdRaw, 80);
      if (!endpointId) continue;
      const endpointCfg = endpointCfgRaw && typeof endpointCfgRaw === 'object' ? endpointCfgRaw as AnyObj : {};
      const url = cleanText(endpointCfg.url || '', 600);
      if (!url) continue;
      endpoints[endpointId] = {
        method: cleanText(endpointCfg.method || 'GET', 10).toUpperCase() || 'GET',
        url
      };
    }
    providers[providerId] = {
      enabled: cfg.enabled !== false,
      secret_id: cleanText(cfg.secret_id || '', 160),
      secret_scope: cleanText(cfg.secret_scope || 'ops.dynamic_burn_budget_oracle', 200),
      egress_scope: cleanText(cfg.egress_scope || 'ops.dynamic_burn_budget_oracle', 200),
      runtime_allowlist: Array.isArray(cfg.runtime_allowlist)
        ? cfg.runtime_allowlist.map((v: unknown) => cleanText(v, 255)).filter(Boolean)
        : [],
      auth_header: cleanText(cfg.auth_header || 'Authorization', 80),
      auth_prefix: cleanText(cfg.auth_prefix || '', 80),
      reset_cycle: normalizeToken(cfg.reset_cycle || 'monthly', 32),
      reset_day_utc: clampInt(cfg.reset_day_utc, 1, 28, 1),
      reset_weekday_utc: clampInt(cfg.reset_weekday_utc, 0, 6, 1),
      reset_hour_utc: clampInt(cfg.reset_hour_utc, 0, 23, 0),
      reset_minute_utc: clampInt(cfg.reset_minute_utc, 0, 59, 0),
      endpoints,
      parse: {
        cost_24h_paths: Array.isArray(parseCfg.cost_24h_paths) ? parseCfg.cost_24h_paths.map((v: unknown) => cleanText(v, 240)).filter(Boolean) : [],
        balance_paths: Array.isArray(parseCfg.balance_paths) ? parseCfg.balance_paths.map((v: unknown) => cleanText(v, 240)).filter(Boolean) : [],
        reset_at_paths: Array.isArray(parseCfg.reset_at_paths) ? parseCfg.reset_at_paths.map((v: unknown) => cleanText(v, 240)).filter(Boolean) : []
      }
    };
  }

  return {
    version: cleanText(src.version || base.version, 40) || base.version,
    enabled: src.enabled !== false,
    shadow_only: src.shadow_only !== false,
    poll_timeout_ms: clampInt(src.poll_timeout_ms, 1000, 120000, base.poll_timeout_ms),
    cadence: {
      default_minutes: clampInt(cadence.default_minutes, 1, 180, base.cadence.default_minutes),
      high_burn_minutes: clampInt(cadence.high_burn_minutes, 1, 180, base.cadence.high_burn_minutes),
      low_burn_minutes: clampInt(cadence.low_burn_minutes, 1, 240, base.cadence.low_burn_minutes),
      burn_spike_multiplier: clampNumber(cadence.burn_spike_multiplier, 1, 10, base.cadence.burn_spike_multiplier)
    },
    thresholds: {
      critical_runway_days: clampNumber(thresholds.critical_runway_days, 0.1, 365, base.thresholds.critical_runway_days),
      high_runway_days: clampNumber(thresholds.high_runway_days, 0.2, 730, base.thresholds.high_runway_days),
      medium_runway_days: clampNumber(thresholds.medium_runway_days, 0.2, 1095, base.thresholds.medium_runway_days),
      min_runway_days_for_capital_allocation: clampNumber(
        thresholds.min_runway_days_for_capital_allocation,
        0.1,
        365,
        base.thresholds.min_runway_days_for_capital_allocation
      ),
      min_runway_days_for_execute_escalation: clampNumber(
        thresholds.min_runway_days_for_execute_escalation,
        0.1,
        365,
        base.thresholds.min_runway_days_for_execute_escalation
      )
    },
    regime_burn_multipliers: {
      ...(base.regime_burn_multipliers || {}),
      ...(src.regime_burn_multipliers && typeof src.regime_burn_multipliers === 'object' ? src.regime_burn_multipliers : {})
    },
    providers,
    state: {
      state_path: resolvePath(stateRaw.state_path || base.state.state_path, base.state.state_path),
      latest_path: resolvePath(stateRaw.latest_path || base.state.latest_path, base.state.latest_path),
      history_path: resolvePath(stateRaw.history_path || base.state.history_path, base.state.history_path),
      receipts_path: resolvePath(stateRaw.receipts_path || base.state.receipts_path, base.state.receipts_path),
      weaver_hint_path: resolvePath(stateRaw.weaver_hint_path || base.state.weaver_hint_path, base.state.weaver_hint_path),
      routing_hint_path: resolvePath(stateRaw.routing_hint_path || base.state.routing_hint_path, base.state.routing_hint_path),
      regime_latest_path: resolvePath(stateRaw.regime_latest_path || base.state.regime_latest_path, base.state.regime_latest_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function defaultState() {
  return {
    schema_id: 'dynamic_burn_budget_oracle_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    providers: {}
  };
}

function loadState(policy: AnyObj) {
  const payload = readJson(policy.state.state_path, null);
  if (!payload || typeof payload !== 'object') return defaultState();
  return {
    schema_id: 'dynamic_burn_budget_oracle_state',
    schema_version: '1.0',
    updated_at: cleanText(payload.updated_at || nowIso(), 60) || nowIso(),
    providers: payload.providers && typeof payload.providers === 'object' ? payload.providers : {}
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.state.state_path, {
    schema_id: 'dynamic_burn_budget_oracle_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    providers: state && state.providers && typeof state.providers === 'object' ? state.providers : {}
  });
}

function inferHeuristicCost(obj: AnyObj) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj.data)) {
    let total = 0;
    let saw = false;
    for (const row of obj.data) {
      const direct = asFinite(row && (row.cost_usd ?? row.total_cost_usd ?? row.cost));
      if (direct != null) {
        total += direct;
        saw = true;
        continue;
      }
      const amount = asFinite(row && row.amount && row.amount.value);
      if (amount != null) {
        total += amount;
        saw = true;
      }
    }
    if (saw) return Number(total.toFixed(6));
  }
  const direct = asFinite(
    obj.total_cost_usd
    ?? obj.cost_usd_24h
    ?? obj.cost_usd
    ?? obj.daily_cost_usd
    ?? obj.spend_usd_24h
  );
  return direct != null ? Number(direct.toFixed(6)) : null;
}

function inferHeuristicBalance(obj: AnyObj) {
  if (!obj || typeof obj !== 'object') return null;
  const direct = asFinite(
    obj.total_available
    ?? obj.available
    ?? obj.balance_usd
    ?? obj.remaining_credit_usd
    ?? (obj.credit_grants && obj.credit_grants.total_available)
    ?? (obj.credits && obj.credits.available)
  );
  return direct != null ? Number(direct.toFixed(6)) : null;
}

function extractProviderMetrics(providerId: string, providerCfg: AnyObj, endpointPayloads: AnyObj = {}) {
  const parseCfg = providerCfg.parse && typeof providerCfg.parse === 'object' ? providerCfg.parse : {};
  const allPayloads = Object.values(endpointPayloads || {})
    .filter((row: unknown) => row && typeof row === 'object') as AnyObj[];

  let cost24h = null;
  for (const payload of allPayloads) {
    const pathHit = extractFirstNumber(payload, parseCfg.cost_24h_paths || []);
    if (pathHit != null) {
      cost24h = Number(pathHit.toFixed(6));
      break;
    }
  }
  if (cost24h == null) {
    for (const payload of allPayloads) {
      const inferred = inferHeuristicCost(payload);
      if (inferred != null) {
        cost24h = inferred;
        break;
      }
    }
  }

  let balance = null;
  for (const payload of allPayloads) {
    const pathHit = extractFirstNumber(payload, parseCfg.balance_paths || []);
    if (pathHit != null) {
      balance = Number(pathHit.toFixed(6));
      break;
    }
  }
  if (balance == null) {
    for (const payload of allPayloads) {
      const inferred = inferHeuristicBalance(payload);
      if (inferred != null) {
        balance = inferred;
        break;
      }
    }
  }

  let resetAt = null;
  for (const payload of allPayloads) {
    for (const p of Array.isArray(parseCfg.reset_at_paths) ? parseCfg.reset_at_paths : []) {
      const raw = getByPath(payload, String(p || ''));
      const ts = parseIsoMs(raw);
      if (ts != null) {
        resetAt = new Date(ts).toISOString();
        break;
      }
    }
    if (resetAt) break;
  }

  return {
    provider_id: providerId,
    balance_usd: balance,
    cost_24h_usd: cost24h,
    reset_at_utc: resetAt
  };
}

function classifyPressure(runwayDays: number | null, thresholds: AnyObj) {
  if (!(runwayDays != null && Number.isFinite(Number(runwayDays)))) return 'none';
  const d = Number(runwayDays);
  if (d <= Number(thresholds.critical_runway_days || 2)) return 'critical';
  if (d <= Number(thresholds.high_runway_days || 5)) return 'high';
  if (d <= Number(thresholds.medium_runway_days || 10)) return 'medium';
  return 'low';
}

function loadRegimeName(policy: AnyObj) {
  const regime = readJson(policy.state.regime_latest_path, {});
  const name = normalizeToken(regime && regime.selected_regime || '', 80);
  return name || 'unknown';
}

function regimeMultiplier(policy: AnyObj, regimeName: string) {
  const multipliers = policy.regime_burn_multipliers && typeof policy.regime_burn_multipliers === 'object'
    ? policy.regime_burn_multipliers
    : {};
  const direct = asFinite(multipliers[regimeName]);
  if (direct != null && direct > 0) return Number(direct);
  const fallback = asFinite(multipliers.unknown);
  return fallback != null && fallback > 0 ? Number(fallback) : 1;
}

async function fetchProviderLive(providerId: string, providerCfg: AnyObj, policy: AnyObj) {
  const result: AnyObj = {
    provider_id: providerId,
    ok: false,
    available: false,
    reason_codes: [],
    endpoint_payloads: {},
    endpoint_status: {}
  };

  if (!providerCfg.secret_id) {
    result.reason_codes.push('secret_id_missing');
    return result;
  }

  const issued = issueSecretHandle({
    secret_id: providerCfg.secret_id,
    scope: providerCfg.secret_scope || 'ops.dynamic_burn_budget_oracle',
    caller: 'dynamic_burn_budget_oracle',
    reason: `provider_usage_poll_${providerId}`,
    ttl_sec: 120
  });
  if (!issued || issued.ok !== true || !issued.handle) {
    result.reason_codes.push('secret_issue_failed');
    result.secret_issue = issued || null;
    return result;
  }

  const resolved = resolveSecretHandle(issued.handle, {
    scope: providerCfg.secret_scope || 'ops.dynamic_burn_budget_oracle',
    caller: 'dynamic_burn_budget_oracle'
  });
  if (!resolved || resolved.ok !== true || !resolved.value) {
    result.reason_codes.push('secret_resolve_failed');
    result.secret_resolve = resolved || null;
    return result;
  }

  const authHeader = cleanText(providerCfg.auth_header || 'Authorization', 80) || 'Authorization';
  const authPrefix = cleanText(providerCfg.auth_prefix || '', 80);
  const authValue = `${authPrefix}${String(resolved.value || '')}`;

  let anyOk = false;
  for (const [endpointId, endpointCfgRaw] of Object.entries(providerCfg.endpoints || {})) {
    const endpointCfg = endpointCfgRaw && typeof endpointCfgRaw === 'object' ? endpointCfgRaw as AnyObj : {};
    const method = cleanText(endpointCfg.method || 'GET', 10).toUpperCase() || 'GET';
    const url = cleanText(endpointCfg.url || '', 600);
    if (!url) continue;
    try {
      const res = await egressFetchText(
        url,
        {
          method,
          headers: {
            [authHeader]: authValue,
            'content-type': 'application/json'
          }
        },
        {
          scope: providerCfg.egress_scope || 'ops.dynamic_burn_budget_oracle',
          caller: `dynamic_burn_budget_oracle:${providerId}`,
          runtime_allowlist: Array.isArray(providerCfg.runtime_allowlist)
            ? providerCfg.runtime_allowlist
            : [],
          timeout_ms: policy.poll_timeout_ms,
          apply: true,
          meta: {
            provider_id: providerId,
            endpoint_id: endpointId
          }
        }
      );
      result.endpoint_status[endpointId] = {
        ok: res.ok === true,
        status: Number(res.status || 0)
      };
      if (res.ok === true) {
        let parsed = null;
        try {
          parsed = JSON.parse(String(res.text || '{}'));
        } catch {
          parsed = null;
        }
        if (parsed && typeof parsed === 'object') {
          result.endpoint_payloads[endpointId] = parsed;
          anyOk = true;
        } else {
          result.reason_codes.push(`endpoint_non_json:${endpointId}`);
        }
      } else {
        result.reason_codes.push(`endpoint_http_${Number(res.status || 0)}:${endpointId}`);
      }
    } catch (err) {
      const code = err instanceof EgressGatewayError
        ? normalizeToken(err && err.details && (err.details as AnyObj).code || 'egress_error', 60)
        : normalizeToken(err && (err as AnyObj).name || 'fetch_error', 60);
      result.reason_codes.push(`${code || 'fetch_error'}:${endpointId}`);
      result.endpoint_status[endpointId] = {
        ok: false,
        status: null
      };
    }
  }

  result.ok = anyOk;
  result.available = anyOk;
  if (!anyOk && result.reason_codes.length === 0) {
    result.reason_codes.push('provider_unavailable');
  }
  return result;
}

function updateProviderStateRow(state: AnyObj, providerId: string, sample: AnyObj) {
  if (!state.providers[providerId] || typeof state.providers[providerId] !== 'object') {
    state.providers[providerId] = {
      samples: []
    };
  }
  const row = state.providers[providerId];
  const samples = Array.isArray(row.samples) ? row.samples : [];
  samples.push({
    ts: sample.ts,
    cost_24h_usd: sample.cost_24h_usd,
    balance_usd: sample.balance_usd,
    projected_runway_days: sample.projected_runway_days
  });
  row.samples = samples.slice(-240);
}

function providerVelocity(row: AnyObj, currentCost24h: number | null) {
  const samples = row && Array.isArray(row.samples) ? row.samples : [];
  const prevCosts = samples
    .map((s: AnyObj) => asFinite(s && s.cost_24h_usd))
    .filter((n: number | null) => n != null) as number[];
  const baseline = average(prevCosts.slice(-14));
  const velocity = asFinite(currentCost24h) != null
    ? Number(asFinite(currentCost24h))
    : (baseline != null ? Number(baseline) : null);

  const prior = average(prevCosts.slice(-8, -1));
  const spikeRatio = (
    velocity != null
    && prior != null
    && prior > 0
  )
    ? Number((velocity / prior).toFixed(6))
    : null;
  return {
    velocity_usd_day: velocity != null ? Number(Number(velocity).toFixed(6)) : null,
    baseline_usd_day: baseline != null ? Number(Number(baseline).toFixed(6)) : null,
    spike_ratio: spikeRatio
  };
}

async function runOracle(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState(policy);
  const ts = nowIso();
  const runId = normalizeToken(`dbo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, 120);

  if (policy.enabled !== true) {
    const out = {
      ok: false,
      type: 'dynamic_burn_budget_oracle_run',
      ts,
      run_id: runId,
      error: 'policy_disabled',
      policy: {
        version: policy.version,
        path: relPath(policy.policy_path),
        shadow_only: policy.shadow_only === true
      }
    };
    writeJsonAtomic(policy.state.latest_path, out);
    appendJsonl(policy.state.history_path, out);
    appendJsonl(policy.state.receipts_path, out);
    return out;
  }

  const mockPayload = (() => {
    const inline = parseMaybeJson(args['mock-json'] || args.mock_json);
    if (inline && typeof inline === 'object') return inline;
    const mockFile = cleanText(args['mock-file'] || args.mock_file || '', 520);
    if (!mockFile) return null;
    const abs = path.isAbsolute(mockFile) ? mockFile : path.join(ROOT, mockFile);
    const parsed = readJson(abs, null);
    return parsed && typeof parsed === 'object' ? parsed : null;
  })();

  const regimeName = loadRegimeName(policy);
  const regimeBurnMultiplier = regimeMultiplier(policy, regimeName);

  const providerRows: AnyObj[] = [];
  const providerReasonCodes: string[] = [];
  let burnSpikeDetected = false;

  for (const [providerId, providerCfgRaw] of Object.entries(policy.providers || {})) {
    const providerCfg = providerCfgRaw && typeof providerCfgRaw === 'object' ? providerCfgRaw as AnyObj : {};
    if (providerCfg.enabled !== true) {
      providerRows.push({
        provider_id: providerId,
        available: false,
        enabled: false,
        reason_codes: ['provider_disabled']
      });
      continue;
    }

    const mockProvider = mockPayload
      && mockPayload.providers
      && typeof mockPayload.providers === 'object'
      ? mockPayload.providers[providerId]
      : null;

    const live = mockProvider && typeof mockProvider === 'object'
      ? {
        ok: true,
        available: true,
        endpoint_payloads: {
          mock: mockProvider
        },
        reason_codes: ['mock_provider']
      }
      : await fetchProviderLive(providerId, providerCfg, policy);

    const metrics = extractProviderMetrics(providerId, providerCfg, live.endpoint_payloads || {});
    const providerStateRow = state.providers[providerId] && typeof state.providers[providerId] === 'object'
      ? state.providers[providerId]
      : { samples: [] };
    const velocity = providerVelocity(providerStateRow, metrics.cost_24h_usd);
    const spike = velocity.spike_ratio != null && velocity.spike_ratio >= Number(policy.cadence.burn_spike_multiplier || 1.35);
    if (spike) burnSpikeDetected = true;

    const resetDays = computeNextResetDays({
      ...providerCfg,
      reset_at_utc: metrics.reset_at_utc
    }, Date.now());

    const runway = (
      metrics.balance_usd != null
      && velocity.velocity_usd_day != null
      && velocity.velocity_usd_day > 0
    )
      ? Number((metrics.balance_usd / velocity.velocity_usd_day).toFixed(6))
      : null;
    const runwayRegime = runway != null
      ? Number((runway / Math.max(0.05, Number(regimeBurnMultiplier || 1))).toFixed(6))
      : null;

    const pressure = classifyPressure(runwayRegime != null ? runwayRegime : runway, policy.thresholds);
    const reasonCodes = []
      .concat(Array.isArray(live.reason_codes) ? live.reason_codes : [])
      .concat(
        metrics.balance_usd == null ? ['balance_unknown'] : [],
        metrics.cost_24h_usd == null && velocity.velocity_usd_day == null ? ['burn_unknown'] : [],
        spike ? ['burn_spike_detected'] : [],
        pressure !== 'none' ? [`runway_pressure_${pressure}`] : []
      )
      .map((v: unknown) => normalizeToken(v, 80))
      .filter(Boolean)
      .slice(0, 24);

    updateProviderStateRow(state, providerId, {
      ts,
      cost_24h_usd: metrics.cost_24h_usd,
      balance_usd: metrics.balance_usd,
      projected_runway_days: runwayRegime != null ? runwayRegime : runway
    });

    providerRows.push({
      provider_id: providerId,
      enabled: true,
      available: live.available === true,
      balance_usd: metrics.balance_usd,
      cost_24h_usd: metrics.cost_24h_usd,
      burn_velocity_usd_day: velocity.velocity_usd_day,
      burn_velocity_baseline_usd_day: velocity.baseline_usd_day,
      burn_spike_ratio: velocity.spike_ratio,
      days_to_reset: resetDays,
      projected_runway_days: runway,
      projected_runway_days_regime: runwayRegime,
      pressure,
      reason_codes: reasonCodes,
      endpoint_status: live.endpoint_status || {}
    });
    providerReasonCodes.push(...reasonCodes);
  }

  saveState(policy, state);

  const activeProviders = providerRows.filter((row) => row.available === true);
  const runwayValues = activeProviders
    .map((row) => asFinite(row.projected_runway_days_regime != null ? row.projected_runway_days_regime : row.projected_runway_days))
    .filter((n: number | null) => n != null) as number[];
  const resetValues = activeProviders
    .map((row) => asFinite(row.days_to_reset))
    .filter((n: number | null) => n != null) as number[];
  const totalBalance = activeProviders
    .map((row) => asFinite(row.balance_usd) || 0)
    .reduce((acc, n) => acc + n, 0);
  const totalVelocity = activeProviders
    .map((row) => asFinite(row.burn_velocity_usd_day) || 0)
    .reduce((acc, n) => acc + n, 0);

  const projectedRunway = runwayValues.length ? Number(Math.min(...runwayValues).toFixed(6)) : null;
  const projectedDaysToReset = resetValues.length ? Number(Math.min(...resetValues).toFixed(6)) : null;

  let projectionPressure: 'none' | 'low' | 'medium' | 'high' | 'critical' = 'none';
  for (const row of activeProviders) {
    if (pressureRank(row.pressure) > pressureRank(projectionPressure)) {
      projectionPressure = normalizePressure(row.pressure);
    }
  }

  const projectionReasonCodes = []
    .concat(activeProviders.length === 0 ? ['providers_unavailable'] : [])
    .concat(projectionPressure !== 'none' ? [`projection_pressure_${projectionPressure}`] : [])
    .concat(burnSpikeDetected ? ['projection_burn_spike_detected'] : [])
    .concat(providerReasonCodes)
    .map((v: unknown) => normalizeToken(v, 80))
    .filter(Boolean)
    .slice(0, 40);

  const cadenceMinutes = (
    pressureRank(projectionPressure) >= pressureRank('high') || burnSpikeDetected
  )
    ? Number(policy.cadence.high_burn_minutes || 5)
    : (
      activeProviders.length > 0
        ? Number(policy.cadence.default_minutes || 15)
        : Number(policy.cadence.low_burn_minutes || 30)
    );
  const nextPollAtMs = Date.now() + Math.max(1, cadenceMinutes) * 60 * 1000;

  const decisions = {
    router_budget_pressure: projectionPressure === 'critical'
      ? 'hard'
      : (projectionPressure === 'high' ? 'hard' : (projectionPressure === 'medium' ? 'soft' : 'none')),
    optimization_budget_pressure: projectionPressure === 'none' ? 'low' : projectionPressure,
    weaver_cost_pressure: Number(mapPressureToCostPressure(projectionPressure)),
    strategy_mode_recommendation: pressureRank(projectionPressure) >= pressureRank('critical')
      ? 'score_only'
      : (pressureRank(projectionPressure) >= pressureRank('high') ? 'canary_execute' : 'execute'),
    capital_allocation_hold: !!(
      pressureRank(projectionPressure) >= pressureRank('critical')
      || (
        projectedRunway != null
        && projectedRunway < Number(policy.thresholds.min_runway_days_for_capital_allocation || 3)
      )
    ),
    self_improvement_hold: !!(
      pressureRank(projectionPressure) >= pressureRank('high')
      || (
        projectedRunway != null
        && projectedRunway < Number(policy.thresholds.min_runway_days_for_execute_escalation || 2)
      )
    )
  };

  const out = {
    ok: true,
    type: 'dynamic_burn_budget_oracle_run',
    ts,
    run_id: runId,
    policy: {
      version: policy.version,
      path: relPath(policy.policy_path),
      shadow_only: policy.shadow_only === true
    },
    regime: {
      selected_regime: regimeName,
      burn_multiplier: Number(Number(regimeBurnMultiplier || 1).toFixed(6))
    },
    providers: providerRows,
    projection: {
      providers_total: providerRows.length,
      providers_available: activeProviders.length,
      total_balance_usd: Number(totalBalance.toFixed(6)),
      total_burn_velocity_usd_day: Number(totalVelocity.toFixed(6)),
      projected_runway_days: projectedRunway,
      projected_days_to_reset: projectedDaysToReset,
      pressure: projectionPressure,
      reason_codes: projectionReasonCodes
    },
    decisions,
    cadence: {
      minutes: cadenceMinutes,
      next_poll_at: new Date(nextPollAtMs).toISOString(),
      reason_codes: [
        pressureRank(projectionPressure) >= pressureRank('high')
          ? 'cadence_high_pressure'
          : (burnSpikeDetected ? 'cadence_burn_spike' : 'cadence_default')
      ]
    },
    paths: {
      state_path: relPath(policy.state.state_path),
      latest_path: relPath(policy.state.latest_path),
      history_path: relPath(policy.state.history_path),
      receipts_path: relPath(policy.state.receipts_path),
      weaver_hint_path: relPath(policy.state.weaver_hint_path),
      routing_hint_path: relPath(policy.state.routing_hint_path)
    }
  };

  writeJsonAtomic(policy.state.latest_path, out);
  appendJsonl(policy.state.history_path, out);
  appendJsonl(policy.state.receipts_path, out);

  const hint = {
    ts,
    type: 'dynamic_burn_budget_oracle_hint',
    projection: out.projection,
    decisions: out.decisions,
    cadence: out.cadence,
    source_path: relPath(policy.state.latest_path)
  };
  appendJsonl(policy.state.weaver_hint_path, hint);
  appendJsonl(policy.state.routing_hint_path, hint);

  return out;
}

function status(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const latest = readJson(policy.state.latest_path, null);
  const historyCount = fs.existsSync(policy.state.history_path)
    ? String(fs.readFileSync(policy.state.history_path, 'utf8') || '').split('\n').filter(Boolean).length
    : 0;
  return {
    ok: true,
    type: 'dynamic_burn_budget_oracle_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      path: relPath(policy.policy_path),
      shadow_only: policy.shadow_only === true,
      cadence: policy.cadence,
      thresholds: policy.thresholds,
      providers: Object.keys(policy.providers || {})
    },
    history_count: historyCount,
    latest: latest && typeof latest === 'object'
      ? {
        ts: latest.ts || null,
        pressure: latest.projection ? latest.projection.pressure || 'none' : null,
        projected_runway_days: latest.projection ? latest.projection.projected_runway_days || null : null,
        providers_available: latest.projection ? Number(latest.projection.providers_available || 0) : 0,
        cadence_minutes: latest.cadence ? Number(latest.cadence.minutes || 0) : null,
        next_poll_at: latest.cadence ? latest.cadence.next_poll_at || null : null
      }
      : null,
    paths: {
      state_path: relPath(policy.state.state_path),
      latest_path: relPath(policy.state.latest_path),
      history_path: relPath(policy.state.history_path),
      receipts_path: relPath(policy.state.receipts_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/dynamic_burn_budget_oracle.js run [--policy=/abs/path.json] [--mock-file=/abs/mock.json] [--mock-json={...}]');
  console.log('  node systems/ops/dynamic_burn_budget_oracle.js status [--policy=/abs/path.json]');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  let out: AnyObj;
  if (cmd === 'help' || args.help) {
    usage();
    process.exit(0);
    return;
  }
  if (cmd === 'run') {
    out = await runOracle(args);
  } else if (cmd === 'status') {
    out = status(args);
  } else {
    out = { ok: false, type: 'dynamic_burn_budget_oracle', error: `unknown_command:${cmd}` };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true && toBool(args.strict, false)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    const out = {
      ok: false,
      type: 'dynamic_burn_budget_oracle',
      ts: nowIso(),
      error: normalizeToken(err && err.message ? err.message : err || 'oracle_failed', 160)
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(1);
  });
}

module.exports = {
  loadPolicy,
  runOracle,
  status,
  normalizePressure,
  pressureRank,
  classifyPressure
};
