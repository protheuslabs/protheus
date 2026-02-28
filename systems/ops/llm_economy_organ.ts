#!/usr/bin/env node
'use strict';
export {};

/**
 * llm_economy_organ.js
 *
 * V3-ECO-001: LLM Economy Organ (shadow-first)
 * - Builds provider library rankings from policy + live burn oracle telemetry.
 * - Generates governed purchase intents (low/medium auto lanes, high approval lane).
 * - Emits deterministic receipts/hints for router/weaver/strategy/capital/self-improvement lanes.
 *
 * Usage:
 *   node systems/ops/llm_economy_organ.js run [--policy=/abs/path.json] [--apply=1|0]
 *   node systems/ops/llm_economy_organ.js status [--policy=/abs/path.json]
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.LLM_ECONOMY_ORGAN_POLICY_PATH
  ? path.resolve(process.env.LLM_ECONOMY_ORGAN_POLICY_PATH)
  : path.join(ROOT, 'config', 'llm_economy_organ_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 260) {
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

function roundTo(v: unknown, digits = 6) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** Math.max(0, Math.min(8, digits));
  return Math.round(n * factor) / factor;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
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

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    allow_apply: false,
    governance: {
      low_risk_auto_execute: true,
      medium_risk_auto_execute: true,
      medium_risk_veto_minutes: 15,
      high_risk_requires_approval: true,
      high_risk_threshold_usd: 500
    },
    purchase: {
      target_runway_days: 14,
      min_balance_usd: 10,
      min_runway_days: 2,
      min_purchase_usd: 5,
      max_purchase_low_usd: 100,
      max_purchase_medium_usd: 500,
      max_purchase_high_usd: 5000
    },
    ranking: {
      weight_performance: 0.45,
      weight_reliability: 0.35,
      weight_cost_efficiency: 0.20
    },
    discovery: {
      enabled: true,
      include_policy_disabled_candidates: true,
      metric_override_weight: 0.35,
      sources: [
        {
          id: 'provider_onboarding_manifest',
          enabled: true,
          path: 'config/provider_onboarding_manifest.json',
          providers_path: 'providers'
        },
        {
          id: 'provider_market_feed',
          enabled: true,
          path: 'state/routing/provider_market_feed_latest.json',
          providers_path: 'providers'
        }
      ]
    },
    providers: {
      openai: {
        enabled: true,
        display_name: 'OpenAI',
        pricing_index: 0.55,
        performance_index: 0.92,
        reliability_index: 0.94,
        payment_route: 'x402_or_provider_billing'
      },
      anthropic: {
        enabled: true,
        display_name: 'Anthropic',
        pricing_index: 0.6,
        performance_index: 0.9,
        reliability_index: 0.93,
        payment_route: 'x402_or_provider_billing'
      },
      xai: {
        enabled: true,
        display_name: 'xAI',
        pricing_index: 0.65,
        performance_index: 0.88,
        reliability_index: 0.9,
        payment_route: 'x402_or_provider_billing'
      },
      groq: {
        enabled: true,
        display_name: 'Groq',
        pricing_index: 0.5,
        performance_index: 0.84,
        reliability_index: 0.87,
        payment_route: 'x402_or_provider_billing'
      }
    },
    sovereign_root_tithe: {
      require_before_spend: true,
      reason_code: 'sovereign_root_tithe_required'
    },
    paths: {
      burn_oracle_latest_path: 'state/ops/dynamic_burn_budget_oracle/latest.json',
      state_path: 'state/ops/llm_economy_organ/state.json',
      latest_path: 'state/ops/llm_economy_organ/latest.json',
      history_path: 'state/ops/llm_economy_organ/history.jsonl',
      receipts_path: 'state/ops/llm_economy_organ/receipts.jsonl',
      provider_library_path: 'state/routing/provider_library_latest.json',
      weaver_hint_path: 'state/autonomy/weaver/llm_economy_hints.jsonl',
      strategy_hint_path: 'state/autonomy/llm_economy_strategy_hints.jsonl',
      capital_hint_path: 'state/budget/llm_economy_capital_hints.jsonl',
      self_improvement_hint_path: 'state/autonomy/self_improvement/llm_economy_hints.jsonl',
      purchase_intents_path: 'state/blockchain/llm_purchase_intents.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const governance = raw.governance && typeof raw.governance === 'object' ? raw.governance : {};
  const purchase = raw.purchase && typeof raw.purchase === 'object' ? raw.purchase : {};
  const ranking = raw.ranking && typeof raw.ranking === 'object' ? raw.ranking : {};
  const discovery = raw.discovery && typeof raw.discovery === 'object' ? raw.discovery : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const tithe = raw.sovereign_root_tithe && typeof raw.sovereign_root_tithe === 'object' ? raw.sovereign_root_tithe : {};
  const providersRaw = raw.providers && typeof raw.providers === 'object' ? raw.providers : base.providers;
  const providers: AnyObj = {};
  for (const [idRaw, cfgRaw] of Object.entries(providersRaw || {})) {
    const id = normalizeToken(idRaw, 80);
    if (!id) continue;
    const cfg = cfgRaw && typeof cfgRaw === 'object' ? cfgRaw as AnyObj : {};
    providers[id] = {
      enabled: cfg.enabled !== false,
      display_name: cleanText(cfg.display_name || id, 120) || id,
      pricing_index: clampNumber(cfg.pricing_index, 0, 2, 0.5),
      performance_index: clampNumber(cfg.performance_index, 0, 2, 0.8),
      reliability_index: clampNumber(cfg.reliability_index, 0, 2, 0.8),
      payment_route: cleanText(cfg.payment_route || 'x402_or_provider_billing', 80) || 'x402_or_provider_billing'
    };
  }

  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    allow_apply: toBool(raw.allow_apply, base.allow_apply),
    governance: {
      low_risk_auto_execute: toBool(governance.low_risk_auto_execute, base.governance.low_risk_auto_execute),
      medium_risk_auto_execute: toBool(governance.medium_risk_auto_execute, base.governance.medium_risk_auto_execute),
      medium_risk_veto_minutes: clampInt(governance.medium_risk_veto_minutes, 1, 1440, base.governance.medium_risk_veto_minutes),
      high_risk_requires_approval: toBool(governance.high_risk_requires_approval, base.governance.high_risk_requires_approval),
      high_risk_threshold_usd: clampNumber(governance.high_risk_threshold_usd, 1, 1_000_000, base.governance.high_risk_threshold_usd)
    },
    purchase: {
      target_runway_days: clampNumber(purchase.target_runway_days, 0.1, 365, base.purchase.target_runway_days),
      min_balance_usd: clampNumber(purchase.min_balance_usd, 0, 1_000_000, base.purchase.min_balance_usd),
      min_runway_days: clampNumber(purchase.min_runway_days, 0.1, 365, base.purchase.min_runway_days),
      min_purchase_usd: clampNumber(purchase.min_purchase_usd, 0, 1_000_000, base.purchase.min_purchase_usd),
      max_purchase_low_usd: clampNumber(purchase.max_purchase_low_usd, 0, 1_000_000, base.purchase.max_purchase_low_usd),
      max_purchase_medium_usd: clampNumber(purchase.max_purchase_medium_usd, 0, 10_000_000, base.purchase.max_purchase_medium_usd),
      max_purchase_high_usd: clampNumber(purchase.max_purchase_high_usd, 0, 100_000_000, base.purchase.max_purchase_high_usd)
    },
    ranking: {
      weight_performance: clampNumber(ranking.weight_performance, 0, 1, base.ranking.weight_performance),
      weight_reliability: clampNumber(ranking.weight_reliability, 0, 1, base.ranking.weight_reliability),
      weight_cost_efficiency: clampNumber(ranking.weight_cost_efficiency, 0, 1, base.ranking.weight_cost_efficiency)
    },
    discovery: {
      enabled: toBool(discovery.enabled, base.discovery.enabled),
      include_policy_disabled_candidates: toBool(
        discovery.include_policy_disabled_candidates,
        base.discovery.include_policy_disabled_candidates
      ),
      metric_override_weight: clampNumber(
        discovery.metric_override_weight,
        0,
        1,
        base.discovery.metric_override_weight
      ),
      sources: (
        Array.isArray(discovery.sources) ? discovery.sources : base.discovery.sources
      )
        .map((row: unknown) => (row && typeof row === 'object' ? row as AnyObj : {}))
        .map((row: AnyObj) => ({
          id: normalizeToken(row.id || '', 120),
          enabled: row.enabled !== false,
          path: resolvePath(row.path || '', 'state/routing/provider_market_feed_latest.json'),
          providers_path: cleanText(row.providers_path || 'providers', 120)
        }))
        .filter((row: AnyObj) => Boolean(row.id && row.path))
    },
    providers,
    sovereign_root_tithe: {
      require_before_spend: toBool(tithe.require_before_spend, base.sovereign_root_tithe.require_before_spend),
      reason_code: normalizeToken(tithe.reason_code || base.sovereign_root_tithe.reason_code, 120) || base.sovereign_root_tithe.reason_code
    },
    paths: {
      burn_oracle_latest_path: resolvePath(paths.burn_oracle_latest_path || base.paths.burn_oracle_latest_path, base.paths.burn_oracle_latest_path),
      state_path: resolvePath(paths.state_path || base.paths.state_path, base.paths.state_path),
      latest_path: resolvePath(paths.latest_path || base.paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path || base.paths.history_path, base.paths.history_path),
      receipts_path: resolvePath(paths.receipts_path || base.paths.receipts_path, base.paths.receipts_path),
      provider_library_path: resolvePath(paths.provider_library_path || base.paths.provider_library_path, base.paths.provider_library_path),
      weaver_hint_path: resolvePath(paths.weaver_hint_path || base.paths.weaver_hint_path, base.paths.weaver_hint_path),
      strategy_hint_path: resolvePath(paths.strategy_hint_path || base.paths.strategy_hint_path, base.paths.strategy_hint_path),
      capital_hint_path: resolvePath(paths.capital_hint_path || base.paths.capital_hint_path, base.paths.capital_hint_path),
      self_improvement_hint_path: resolvePath(paths.self_improvement_hint_path || base.paths.self_improvement_hint_path, base.paths.self_improvement_hint_path),
      purchase_intents_path: resolvePath(paths.purchase_intents_path || base.paths.purchase_intents_path, base.paths.purchase_intents_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function asFinite(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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

function riskTierForAmount(amountUsd: number, policy: AnyObj) {
  if (amountUsd <= Number(policy.purchase.max_purchase_low_usd || 100)) return 'low';
  if (amountUsd <= Number(policy.purchase.max_purchase_medium_usd || 500)) return 'medium';
  return 'high';
}

function normalizeDiscoveryProvider(rowRaw: AnyObj, sourceId: string) {
  const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
  const providerId = normalizeToken(
    row.provider_id
    || row.providerId
    || row.id
    || row.provider
    || row.provider_key
    || '',
    120
  );
  if (!providerId) return null;
  return {
    provider_id: providerId,
    display_name: cleanText(row.display_name || row.name || providerId, 120) || providerId,
    pricing_index: clampNumber(
      row.pricing_index != null
        ? row.pricing_index
        : (row.cost_index != null ? row.cost_index : 0.6),
      0,
      2,
      0.6
    ),
    performance_index: clampNumber(row.performance_index, 0, 2, 0.82),
    reliability_index: clampNumber(row.reliability_index, 0, 2, 0.82),
    payment_route: cleanText(row.payment_route || 'x402_or_provider_billing', 80) || 'x402_or_provider_billing',
    source_id: normalizeToken(sourceId, 120) || 'unknown_source',
    discovered_at: cleanText(row.discovered_at || row.ts || nowIso(), 60) || nowIso(),
    metadata: {
      model_ids: Array.isArray(row.model_ids) ? row.model_ids.slice(0, 24).map((v: unknown) => cleanText(v, 120)).filter(Boolean) : [],
      notes: cleanText(row.notes || '', 260) || null
    }
  };
}

function readDiscoveryProvidersFromSource(src: AnyObj) {
  const payload = readJson(src.path, null);
  if (!payload || typeof payload !== 'object') return [];
  const raw = src.providers_path ? getByPath(payload, String(src.providers_path)) : payload;
  let rows: AnyObj[] = [];
  if (Array.isArray(raw)) rows = raw as AnyObj[];
  else if (raw && typeof raw === 'object') {
    rows = Object.entries(raw as AnyObj).map(([idRaw, valRaw]) => {
      const row = valRaw && typeof valRaw === 'object' ? valRaw as AnyObj : {};
      return { provider_id: idRaw, ...row };
    });
  }
  return rows
    .map((row) => normalizeDiscoveryProvider(row, src.id || 'unknown_source'))
    .filter(Boolean);
}

function readDiscoveryProviders(policy: AnyObj) {
  const discovery = policy.discovery && typeof policy.discovery === 'object' ? policy.discovery : {};
  if (discovery.enabled !== true) {
    return {
      providers_by_id: {},
      source_stats: []
    };
  }
  const byId: AnyObj = {};
  const sourceStats: AnyObj[] = [];
  for (const srcRaw of Array.isArray(discovery.sources) ? discovery.sources : []) {
    const src = srcRaw && typeof srcRaw === 'object' ? srcRaw as AnyObj : {};
    if (src.enabled !== true) continue;
    const rows = readDiscoveryProvidersFromSource(src);
    sourceStats.push({
      source_id: src.id || 'unknown_source',
      provider_count: rows.length,
      path: relPath(src.path || '')
    });
    for (const rowRaw of rows) {
      const row = rowRaw as AnyObj;
      const id = row.provider_id;
      if (!id) continue;
      const prev = byId[id];
      if (!prev) {
        byId[id] = row;
        continue;
      }
      // Keep the newest sample per provider to avoid stale overlays.
      const prevTs = Date.parse(String(prev.discovered_at || ''));
      const nextTs = Date.parse(String(row.discovered_at || ''));
      byId[id] = (Number.isFinite(nextTs) && (!Number.isFinite(prevTs) || nextTs >= prevTs)) ? row : prev;
    }
  }
  return {
    providers_by_id: byId,
    source_stats: sourceStats
  };
}

function blendMetric(baseValue: number, discoveredValue: unknown, overrideWeight: number) {
  const d = asFinite(discoveredValue);
  if (d == null) return baseValue;
  const w = clampNumber(overrideWeight, 0, 1, 0.35);
  return roundTo((baseValue * (1 - w)) + (d * w), 6);
}

function buildProviderLibrary(policy: AnyObj, burnOracle: AnyObj, discovery: AnyObj = {}) {
  const providerRows = Array.isArray(burnOracle && burnOracle.providers) ? burnOracle.providers : [];
  const providerMap: AnyObj = {};
  for (const row of providerRows) {
    const id = normalizeToken(row && row.provider_id || '', 80);
    if (!id) continue;
    providerMap[id] = row;
  }

  const discoveredById = discovery && discovery.providers_by_id && typeof discovery.providers_by_id === 'object'
    ? discovery.providers_by_id
    : {};
  const discoveryEnabled = policy.discovery && policy.discovery.enabled === true;
  const includeDiscoveryOnly = discoveryEnabled && policy.discovery.include_policy_disabled_candidates === true;
  const providerIds = new Set<string>(Object.keys(policy.providers || {}));
  if (includeDiscoveryOnly) {
    for (const providerId of Object.keys(discoveredById || {})) providerIds.add(providerId);
  }
  for (const providerId of Object.keys(providerMap || {})) providerIds.add(providerId);

  const rankings: AnyObj[] = [];
  const intents: AnyObj[] = [];
  const reasons: string[] = [];

  for (const providerId of providerIds) {
    const cfgRaw = (policy.providers && policy.providers[providerId]) || {};
    const cfg = cfgRaw && typeof cfgRaw === 'object' ? cfgRaw as AnyObj : {};
    const discovered = discoveredById && discoveredById[providerId] && typeof discoveredById[providerId] === 'object'
      ? discoveredById[providerId]
      : null;
    const enabled = cfg.enabled === true;
    if (!enabled && !discovered) continue;

    const burn = providerMap[providerId] || {};
    const available = burn.available !== false;
    const balanceUsd = asFinite(burn.balance_usd);
    const runwayDays = asFinite(burn.projected_runway_days_regime != null ? burn.projected_runway_days_regime : burn.projected_runway_days);
    const velocity = asFinite(burn.burn_velocity_usd_day);
    const performanceIndex = blendMetric(
      Number(cfg.performance_index || discovered?.performance_index || 0.82),
      discovered && discovered.performance_index,
      Number(policy.discovery && policy.discovery.metric_override_weight != null ? policy.discovery.metric_override_weight : 0.35)
    );
    const reliabilityIndex = blendMetric(
      Number(cfg.reliability_index || discovered?.reliability_index || 0.82),
      discovered && discovered.reliability_index,
      Number(policy.discovery && policy.discovery.metric_override_weight != null ? policy.discovery.metric_override_weight : 0.35)
    );
    const pricingIndex = blendMetric(
      Number(cfg.pricing_index || discovered?.pricing_index || 0.6),
      discovered && discovered.pricing_index,
      Number(policy.discovery && policy.discovery.metric_override_weight != null ? policy.discovery.metric_override_weight : 0.35)
    );
    const costEfficiency = roundTo(1 / Math.max(0.01, pricingIndex), 6);
    const score = roundTo(
      (Number(policy.ranking.weight_performance || 0.45) * performanceIndex)
      + (Number(policy.ranking.weight_reliability || 0.35) * reliabilityIndex)
      + (Number(policy.ranking.weight_cost_efficiency || 0.2) * costEfficiency),
      6
    );

    const row = {
      provider_id: providerId,
      enabled,
      display_name: cfg.display_name || (discovered && discovered.display_name) || providerId,
      payment_route: cfg.payment_route || (discovered && discovered.payment_route) || 'x402_or_provider_billing',
      rank_score: score,
      metrics: {
        performance_index: performanceIndex,
        reliability_index: reliabilityIndex,
        pricing_index: pricingIndex,
        cost_efficiency_index: costEfficiency
      },
      discovery: discovered
        ? {
          source_id: discovered.source_id || null,
          discovered_at: discovered.discovered_at || null,
          model_ids: discovered.metadata && Array.isArray(discovered.metadata.model_ids)
            ? discovered.metadata.model_ids
            : []
        }
        : null,
      burn_oracle: {
        available,
        balance_usd: balanceUsd,
        projected_runway_days: runwayDays,
        burn_velocity_usd_day: velocity,
        pressure: normalizeToken(burn.pressure || 'none', 32) || 'none'
      }
    };
    rankings.push(row);

    if (!enabled) continue;
    const lowBalance = balanceUsd != null && balanceUsd < Number(policy.purchase.min_balance_usd || 10);
    const lowRunway = runwayDays != null && runwayDays < Number(policy.purchase.min_runway_days || 2);
    if (!available || (!lowBalance && !lowRunway)) continue;

    const neededByRunway = (
      velocity != null
        ? roundTo(Math.max(0, Number(policy.purchase.target_runway_days || 14) * velocity - Number(balanceUsd || 0)), 6)
        : null
    );
    const suggested = roundTo(
      Math.max(
        Number(policy.purchase.min_purchase_usd || 5),
        Number(neededByRunway != null ? neededByRunway : policy.purchase.max_purchase_low_usd || 100)
      ),
      6
    );
    const capped = roundTo(
      Math.min(
        suggested,
        Number(policy.purchase.max_purchase_high_usd || 5000)
      ),
      6
    );

    const riskTier = riskTierForAmount(capped, policy);
    const autoExecutable = (
      (riskTier === 'low' && policy.governance.low_risk_auto_execute === true)
      || (riskTier === 'medium' && policy.governance.medium_risk_auto_execute === true)
    );
    const requiresApproval = riskTier === 'high' && policy.governance.high_risk_requires_approval === true;

    const reasonCodes = [];
    if (lowBalance) reasonCodes.push('balance_below_min');
    if (lowRunway) reasonCodes.push('runway_below_min');
    if (policy.sovereign_root_tithe.require_before_spend === true) {
      reasonCodes.push(policy.sovereign_root_tithe.reason_code);
    }

    intents.push({
      intent_id: normalizeToken(`pi_${providerId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, 140),
      provider_id: providerId,
      amount_usd: capped,
      currency: 'USD',
      risk_tier: riskTier,
      auto_executable: autoExecutable,
      requires_approval: requiresApproval,
      veto_window_minutes: riskTier === 'medium' ? Number(policy.governance.medium_risk_veto_minutes || 15) : 0,
      reason_codes: reasonCodes,
      payment_route: cfg.payment_route || (discovered && discovered.payment_route) || 'x402_or_provider_billing',
      tithe_applies_first: policy.sovereign_root_tithe.require_before_spend === true,
      projected_post_purchase_runway_days: (
        velocity != null && velocity > 0
          ? roundTo((Number(balanceUsd || 0) + capped) / velocity, 6)
          : null
      )
    });
  }

  rankings.sort((a, b) => Number(b.rank_score || 0) - Number(a.rank_score || 0));
  for (const intent of intents) {
    if (intent.requires_approval === true) reasons.push('high_risk_purchase_requires_approval');
    else if (intent.auto_executable === true) reasons.push('auto_purchase_lane_available');
    else reasons.push('purchase_requires_veto_window');
  }
  if (discoveryEnabled) reasons.push('provider_discovery_overlay_active');
  if (includeDiscoveryOnly && Object.keys(discoveredById || {}).length > 0) reasons.push('discovery_candidates_loaded');

  return {
    provider_library: rankings,
    purchase_intents: intents,
    reason_codes: Array.from(new Set(reasons)).slice(0, 24),
    discovery_summary: {
      enabled: discoveryEnabled,
      providers_discovered: Object.keys(discoveredById || {}).length,
      source_stats: Array.isArray(discovery.source_stats) ? discovery.source_stats : []
    }
  };
}

function loadState(policy: AnyObj) {
  const src = readJson(policy.paths.state_path, {});
  return {
    schema_id: 'llm_economy_organ_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 60) || nowIso(),
    runs: clampInt(src.runs, 0, 10_000_000, 0),
    last_run_id: cleanText(src.last_run_id || '', 140) || null
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.paths.state_path, {
    schema_id: 'llm_economy_organ_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    runs: clampInt(state.runs, 0, 10_000_000, 0),
    last_run_id: cleanText(state.last_run_id || '', 140) || null
  });
}

function runEconomy(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const ts = nowIso();
  const runId = normalizeToken(`lle_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, 120);

  if (policy.enabled !== true) {
    const out = {
      ok: false,
      type: 'llm_economy_organ_run',
      ts,
      run_id: runId,
      error: 'policy_disabled',
      policy_path: relPath(policy.policy_path)
    };
    writeJsonAtomic(policy.paths.latest_path, out);
    appendJsonl(policy.paths.history_path, out);
    appendJsonl(policy.paths.receipts_path, out);
    return out;
  }

  const applyRequested = toBool(args.apply, false);
  const applyExecuted = applyRequested && policy.allow_apply === true && policy.shadow_only !== true;
  const burnOracle = readJson(policy.paths.burn_oracle_latest_path, {});
  const discovery = readDiscoveryProviders(policy);

  const compiled = buildProviderLibrary(policy, burnOracle, discovery);
  const intents = Array.isArray(compiled.purchase_intents) ? compiled.purchase_intents : [];

  const executedIntents: AnyObj[] = [];
  const queuedIntents: AnyObj[] = [];
  for (const intent of intents) {
    const lane = intent.requires_approval === true
      ? 'approval_required'
      : (intent.auto_executable === true ? 'auto_execute' : 'veto_window');
    const payload = {
      ...intent,
      ts,
      run_id: runId,
      lane,
      status: applyExecuted
        ? (lane === 'auto_execute' ? 'queued_for_execution' : (lane === 'veto_window' ? 'queued_with_veto_window' : 'awaiting_approval'))
        : 'shadow_planned'
    };
    if (applyExecuted) {
      appendJsonl(policy.paths.purchase_intents_path, payload);
      queuedIntents.push(payload);
    } else {
      executedIntents.push(payload);
    }
  }

  const projection = burnOracle && burnOracle.projection && typeof burnOracle.projection === 'object'
    ? burnOracle.projection
    : {};

  const out = {
    ok: true,
    type: 'llm_economy_organ_run',
    ts,
    run_id: runId,
    shadow_only: policy.shadow_only === true || !applyExecuted,
    apply_requested: applyRequested,
    apply_executed: applyExecuted,
    policy: {
      version: policy.version,
      path: relPath(policy.policy_path)
    },
    projection: {
      pressure: normalizeToken(projection.pressure || 'none', 32) || 'none',
      projected_runway_days: asFinite(projection.projected_runway_days),
      providers_available: clampInt(projection.providers_available, 0, 100000, 0)
    },
    provider_library: compiled.provider_library,
    discovery_summary: compiled.discovery_summary,
    purchase_intents: applyExecuted ? queuedIntents : executedIntents,
    summary: {
      providers_ranked: compiled.provider_library.length,
      providers_discovered: Number(compiled.discovery_summary && compiled.discovery_summary.providers_discovered || 0),
      purchase_intents_total: intents.length,
      auto_executable: intents.filter((row: AnyObj) => row.auto_executable === true).length,
      approval_required: intents.filter((row: AnyObj) => row.requires_approval === true).length,
      tithe_required: policy.sovereign_root_tithe.require_before_spend === true
    },
    reason_codes: compiled.reason_codes,
    integration_hints: {
      weaver: {
        cost_pressure: normalizeToken(projection.pressure || 'none', 32) || 'none',
        provider_rank_top: compiled.provider_library.slice(0, 3).map((row: AnyObj) => row.provider_id)
      },
      routing: {
        provider_library_ref: relPath(policy.paths.provider_library_path),
        pressure: normalizeToken(projection.pressure || 'none', 32) || 'none',
        discovered_candidates: Number(compiled.discovery_summary && compiled.discovery_summary.providers_discovered || 0)
      },
      strategy: {
        recommendation: intents.some((row: AnyObj) => row.requires_approval === true)
          ? 'approval_hold_for_high_risk_purchases'
          : 'autonomous_provider_replenishment_ready'
      },
      capital_allocation: {
        purchase_intent_count: intents.length,
        projected_spend_usd: roundTo(intents.reduce((acc: number, row: AnyObj) => acc + Number(row.amount_usd || 0), 0), 6)
      },
      self_improvement: {
        hold_if_provider_shortage: intents.length > 0
      }
    },
    paths: {
      latest_path: relPath(policy.paths.latest_path),
      history_path: relPath(policy.paths.history_path),
      provider_library_path: relPath(policy.paths.provider_library_path),
      purchase_intents_path: relPath(policy.paths.purchase_intents_path)
    }
  };

  writeJsonAtomic(policy.paths.provider_library_path, {
    ts,
    run_id: runId,
    providers: out.provider_library,
    discovery_summary: out.discovery_summary,
    reason_codes: out.reason_codes
  });

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.history_path, out);
  appendJsonl(policy.paths.receipts_path, {
    ts,
    type: out.type,
    run_id: runId,
    summary: out.summary,
    reason_codes: out.reason_codes,
    projection: out.projection,
    discovery_summary: out.discovery_summary
  });

  const hint = {
    ts,
    type: 'llm_economy_hint',
    run_id: runId,
    projection: out.projection,
    provider_rank_top: out.integration_hints.weaver.provider_rank_top,
    purchase_intents: out.summary.purchase_intents_total,
    providers_discovered: out.summary.providers_discovered,
    reason_codes: out.reason_codes
  };
  appendJsonl(policy.paths.weaver_hint_path, hint);
  appendJsonl(policy.paths.strategy_hint_path, hint);
  appendJsonl(policy.paths.capital_hint_path, hint);
  appendJsonl(policy.paths.self_improvement_hint_path, hint);

  state.runs = Number(state.runs || 0) + 1;
  state.last_run_id = runId;
  saveState(policy, state);

  return out;
}

function status(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = readJson(policy.paths.latest_path, null);
  const state = loadState(policy);
  return {
    ok: true,
    type: 'llm_economy_organ_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      path: relPath(policy.policy_path),
      shadow_only: policy.shadow_only === true
    },
    state: {
      runs: Number(state.runs || 0),
      last_run_id: state.last_run_id || null
    },
    latest: latest && typeof latest === 'object'
      ? {
        ts: latest.ts || null,
        run_id: latest.run_id || null,
        providers_ranked: latest.summary ? Number(latest.summary.providers_ranked || 0) : 0,
        providers_discovered: latest.summary ? Number(latest.summary.providers_discovered || 0) : 0,
        purchase_intents_total: latest.summary ? Number(latest.summary.purchase_intents_total || 0) : 0,
        pressure: latest.projection ? latest.projection.pressure || 'none' : 'none'
      }
      : null,
    paths: {
      latest_path: relPath(policy.paths.latest_path),
      history_path: relPath(policy.paths.history_path),
      provider_library_path: relPath(policy.paths.provider_library_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/llm_economy_organ.js run [--policy=/abs/path.json] [--apply=1|0]');
  console.log('  node systems/ops/llm_economy_organ.js status [--policy=/abs/path.json]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || args.help) {
    usage();
    process.exit(0);
    return;
  }

  let out: AnyObj;
  if (cmd === 'run') out = runEconomy(args);
  else if (cmd === 'status') out = status(args);
  else {
    out = { ok: false, type: 'llm_economy_organ', error: `unknown_command:${cmd}` };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'llm_economy_organ',
      error: normalizeToken(err && (err as AnyObj).message ? (err as AnyObj).message : err || 'llm_economy_failed', 160)
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  runEconomy,
  status
};
