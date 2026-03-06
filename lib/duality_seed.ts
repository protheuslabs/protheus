#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'duality_seed_policy.json');
const DEFAULT_CODEX_PATH = path.join(ROOT, 'config', 'duality_codex.txt');
const DEFAULT_LATEST_PATH = path.join(ROOT, 'state', 'autonomy', 'duality', 'latest.json');
const DEFAULT_HISTORY_PATH = path.join(ROOT, 'state', 'autonomy', 'duality', 'history.jsonl');

const TRIT_PAIN = -1;
const TRIT_UNKNOWN = 0;
const TRIT_OK = 1;

type FluxPair = {
  yin: string;
  yang: string;
  yin_attrs: string[];
  yang_attrs: string[];
};

type DualityCodex = {
  version: string;
  flux_pairs: FluxPair[];
  flow_values: string[];
  balance_rules: Record<string, string>;
  asymptote: Record<string, string>;
  warnings: string[];
};

let cachedPolicyPath = '';
let cachedPolicyMtime = 0;
let cachedPolicy: AnyObj | null = null;

let cachedCodexPath = '';
let cachedCodexMtime = 0;
let cachedCodex: DualityCodex | null = null;

let cachedStatePath = '';
let cachedStateMtime = 0;
let cachedState: AnyObj | null = null;

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 600) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeWord(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
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

function tritLabel(v: number) {
  if (v > 0) return 'ok';
  if (v < 0) return 'pain';
  return 'unknown';
}

function normalizeTrit(v: unknown) {
  const n = Number(v);
  if (!Number.isFinite(n)) return TRIT_UNKNOWN;
  if (n > 0) return TRIT_OK;
  if (n < 0) return TRIT_PAIN;
  return TRIT_UNKNOWN;
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

function readText(filePath: string, fallback = '') {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return String(fs.readFileSync(filePath, 'utf8') || '');
  } catch {
    return fallback;
  }
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

function safeMtimeMs(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return 0;
    const stat = fs.statSync(filePath);
    return Number(stat.mtimeMs || 0);
  } catch {
    return 0;
  }
}

function defaultCodex(): DualityCodex {
  return {
    version: '1.0',
    flux_pairs: [
      {
        yin: 'order',
        yang: 'chaos',
        yin_attrs: ['structure', 'stability', 'planning', 'precision', 'discipline'],
        yang_attrs: ['energy', 'variation', 'exploration', 'adaptation', 'novelty']
      },
      {
        yin: 'logic',
        yang: 'intuition',
        yin_attrs: ['analysis', 'proof', 'verification', 'determinism'],
        yang_attrs: ['insight', 'creativity', 'synthesis', 'leap']
      },
      {
        yin: 'preservation',
        yang: 'transformation',
        yin_attrs: ['safety', 'containment', 'resilience'],
        yang_attrs: ['mutation', 'inversion', 'breakthrough']
      }
    ],
    flow_values: [
      'life/death',
      'progression/degression',
      'creation/decay',
      'integration/fragmentation'
    ],
    balance_rules: {
      positive_balance: 'creates_energy',
      negative_balance: 'destroys',
      extreme_yin: 'stagnation',
      extreme_yang: 'unraveling'
    },
    asymptote: {
      zero_point: 'opposites_flow_into_each_other',
      harmony: 'balanced_interplay_enables_impossible'
    },
    warnings: [
      'single_pole_optimization_causes_debt',
      'long_extremes_trigger_snapback',
      'protect_constitution_and_user_sovereignty'
    ]
  };
}

function parseAttrs(blob: string) {
  return Array.from(new Set(
    String(blob || '')
      .split(',')
      .map((row) => normalizeWord(row, 60))
      .filter(Boolean)
  )).slice(0, 64);
}

function parseDualityCodexText(text: string) {
  const base = defaultCodex();
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'));
  if (!lines.length) return base;

  let section = '';
  const fluxPairs: FluxPair[] = [];
  const flowValues: string[] = [];
  const balanceRules: Record<string, string> = {};
  const asymptote: Record<string, string> = {};
  const warnings: string[] = [];
  let version = base.version;

  for (const raw of lines) {
    const heading = raw.match(/^\[([a-z0-9_ -]+)\]$/i);
    if (heading) {
      section = normalizeWord(heading[1], 80);
      continue;
    }
    if (section === 'meta') {
      const kv = raw.split('=');
      if (kv.length >= 2 && normalizeWord(kv[0], 40) === 'version') {
        version = cleanText(kv.slice(1).join('='), 40) || version;
      }
      continue;
    }
    if (section === 'flux_pairs') {
      const parts = raw.split('|').map((row) => cleanText(row, 160));
      if (parts.length >= 2) {
        const yin = normalizeWord(parts[0], 40);
        const yang = normalizeWord(parts[1], 40);
        if (!yin || !yang) continue;
        const pair: FluxPair = {
          yin,
          yang,
          yin_attrs: [],
          yang_attrs: []
        };
        for (const part of parts.slice(2)) {
          const kv = part.split('=');
          if (kv.length < 2) continue;
          const key = normalizeWord(kv[0], 40);
          const value = kv.slice(1).join('=');
          if (key === 'yin_attrs' || key === 'yin' || key === 'yinattr' || key === 'yinattrs') {
            pair.yin_attrs = parseAttrs(value);
          } else if (key === 'yang_attrs' || key === 'yang' || key === 'yangattr' || key === 'yangattrs') {
            pair.yang_attrs = parseAttrs(value);
          }
        }
        fluxPairs.push(pair);
      } else if (raw.includes('<->')) {
        const pairParts = raw.split('<->').map((row) => normalizeWord(row, 40)).filter(Boolean);
        if (pairParts.length >= 2) {
          fluxPairs.push({
            yin: pairParts[0],
            yang: pairParts[1],
            yin_attrs: [],
            yang_attrs: []
          });
        }
      }
      continue;
    }
    if (section === 'flow_values') {
      if (raw.includes('/')) {
        flowValues.push(cleanText(raw, 120));
      }
      continue;
    }
    if (section === 'balance_rules' || section === 'asymptote') {
      const chunks = raw.includes('=') ? raw.split('=') : raw.split(':');
      if (chunks.length >= 2) {
        const key = normalizeWord(chunks[0], 64);
        const value = normalizeWord(chunks.slice(1).join('='), 120);
        if (!key || !value) continue;
        if (section === 'balance_rules') balanceRules[key] = value;
        else asymptote[key] = value;
      }
      continue;
    }
    if (section === 'warnings') {
      const token = normalizeWord(raw, 120);
      if (token) warnings.push(token);
      continue;
    }
  }

  const out: DualityCodex = {
    version,
    flux_pairs: fluxPairs.length ? fluxPairs : base.flux_pairs,
    flow_values: flowValues.length ? flowValues : base.flow_values,
    balance_rules: Object.keys(balanceRules).length ? balanceRules : base.balance_rules,
    asymptote: Object.keys(asymptote).length ? asymptote : base.asymptote,
    warnings: warnings.length ? Array.from(new Set(warnings)).slice(0, 96) : base.warnings
  };
  return out;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    advisory_only: true,
    advisory_weight: 0.35,
    positive_threshold: 0.3,
    negative_threshold: -0.2,
    minimum_seed_confidence: 0.25,
    contradiction_decay_step: 0.04,
    support_recovery_step: 0.01,
    max_observation_window: 200,
    self_validation_interval_minutes: 360,
    codex_path: DEFAULT_CODEX_PATH,
    state: {
      latest_path: DEFAULT_LATEST_PATH,
      history_path: DEFAULT_HISTORY_PATH
    },
    integration: {
      belief_formation: true,
      inversion_trigger: true,
      assimilation_candidacy: true,
      task_decomposition: true,
      weaver_arbitration: true,
      heroic_echo_filtering: true
    },
    outputs: {
      persist_shadow_receipts: true,
      persist_observations: true
    }
  };
}

function laneConfigKey(laneRaw: unknown) {
  const lane = normalizeToken(laneRaw, 120);
  if (lane === 'belief_formation') return 'belief_formation';
  if (lane === 'inversion_trigger') return 'inversion_trigger';
  if (lane === 'assimilation_candidacy') return 'assimilation_candidacy';
  if (lane === 'task_decomposition') return 'task_decomposition';
  if (lane === 'weaver_arbitration') return 'weaver_arbitration';
  if (lane === 'heroic_echo_filtering') return 'heroic_echo_filtering';
  return null;
}

function laneEnabled(policy: AnyObj, laneRaw: unknown) {
  const key = laneConfigKey(laneRaw);
  if (!key) return true;
  const integration = policy && policy.integration && typeof policy.integration === 'object'
    ? policy.integration
    : {};
  if (!Object.prototype.hasOwnProperty.call(integration, key)) return true;
  return toBool(integration[key], true);
}

function resolvePathFromRoot(input: unknown, fallbackAbs: string) {
  const raw = cleanText(input, 360);
  if (!raw) return fallbackAbs;
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return path.resolve(ROOT, raw);
}

function loadDualityPolicy(policyPath?: string) {
  const target = path.resolve(String(policyPath || process.env.DUALITY_SEED_POLICY_PATH || DEFAULT_POLICY_PATH));
  const mtime = safeMtimeMs(target);
  if (cachedPolicy && cachedPolicyPath === target && cachedPolicyMtime === mtime) return cachedPolicy;

  const src = readJson(target, {});
  const base = defaultPolicy();
  const state = src.state && typeof src.state === 'object' ? src.state : {};
  const integration = src.integration && typeof src.integration === 'object' ? src.integration : {};
  const outputs = src.outputs && typeof src.outputs === 'object' ? src.outputs : {};
  const out = {
    version: cleanText(src.version || base.version, 32) || base.version,
    enabled: toBool(src.enabled, base.enabled),
    shadow_only: toBool(src.shadow_only, base.shadow_only),
    advisory_only: toBool(src.advisory_only, base.advisory_only),
    advisory_weight: clampNumber(src.advisory_weight, 0, 1, base.advisory_weight),
    positive_threshold: clampNumber(src.positive_threshold, -1, 1, base.positive_threshold),
    negative_threshold: clampNumber(src.negative_threshold, -1, 1, base.negative_threshold),
    minimum_seed_confidence: clampNumber(src.minimum_seed_confidence, 0, 1, base.minimum_seed_confidence),
    contradiction_decay_step: clampNumber(src.contradiction_decay_step, 0.0001, 1, base.contradiction_decay_step),
    support_recovery_step: clampNumber(src.support_recovery_step, 0.0001, 1, base.support_recovery_step),
    max_observation_window: clampInt(src.max_observation_window, 10, 20000, base.max_observation_window),
    self_validation_interval_minutes: clampInt(
      src.self_validation_interval_minutes,
      5,
      24 * 60,
      base.self_validation_interval_minutes
    ),
    codex_path: resolvePathFromRoot(src.codex_path || base.codex_path, DEFAULT_CODEX_PATH),
    state: {
      latest_path: resolvePathFromRoot(state.latest_path || base.state.latest_path, DEFAULT_LATEST_PATH),
      history_path: resolvePathFromRoot(state.history_path || base.state.history_path, DEFAULT_HISTORY_PATH)
    },
    integration: {
      belief_formation: toBool(integration.belief_formation, base.integration.belief_formation),
      inversion_trigger: toBool(integration.inversion_trigger, base.integration.inversion_trigger),
      assimilation_candidacy: toBool(integration.assimilation_candidacy, base.integration.assimilation_candidacy),
      task_decomposition: toBool(integration.task_decomposition, base.integration.task_decomposition),
      weaver_arbitration: toBool(integration.weaver_arbitration, base.integration.weaver_arbitration),
      heroic_echo_filtering: toBool(integration.heroic_echo_filtering, base.integration.heroic_echo_filtering)
    },
    outputs: {
      persist_shadow_receipts: toBool(outputs.persist_shadow_receipts, base.outputs.persist_shadow_receipts),
      persist_observations: toBool(outputs.persist_observations, base.outputs.persist_observations)
    }
  };

  cachedPolicyPath = target;
  cachedPolicyMtime = mtime;
  cachedPolicy = out;
  return out;
}

function loadDualityCodex(policyPath?: string) {
  const policy = loadDualityPolicy(policyPath);
  const codexPath = policy.codex_path;
  const mtime = safeMtimeMs(codexPath);
  if (cachedCodex && cachedCodexPath === codexPath && cachedCodexMtime === mtime) return cachedCodex;
  const raw = readText(codexPath, '');
  const parsed = parseDualityCodexText(raw);
  cachedCodexPath = codexPath;
  cachedCodexMtime = mtime;
  cachedCodex = parsed;
  return parsed;
}

function defaultState() {
  return {
    schema_id: 'duality_seed_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    seed_confidence: 1,
    observations_total: 0,
    contradictions_total: 0,
    supports_total: 0,
    neutral_total: 0,
    consecutive_contradictions: 0,
    consecutive_supports: 0,
    observation_window: [],
    self_validation: {
      last_run_ts: null,
      confidence: 0,
      scenario_count: 0
    }
  };
}

function loadDualityState(policyPath?: string) {
  const policy = loadDualityPolicy(policyPath);
  const statePath = policy.state.latest_path;
  const mtime = safeMtimeMs(statePath);
  if (cachedState && cachedStatePath === statePath && cachedStateMtime === mtime) return cachedState;
  const src = readJson(statePath, {});
  const base = defaultState();
  const out = {
    ...base,
    ...src,
    seed_confidence: clampNumber(src.seed_confidence, 0, 1, base.seed_confidence),
    observations_total: clampInt(src.observations_total, 0, 100000000, base.observations_total),
    contradictions_total: clampInt(src.contradictions_total, 0, 100000000, base.contradictions_total),
    supports_total: clampInt(src.supports_total, 0, 100000000, base.supports_total),
    neutral_total: clampInt(src.neutral_total, 0, 100000000, base.neutral_total),
    consecutive_contradictions: clampInt(src.consecutive_contradictions, 0, 100000000, base.consecutive_contradictions),
    consecutive_supports: clampInt(src.consecutive_supports, 0, 100000000, base.consecutive_supports),
    observation_window: Array.isArray(src.observation_window)
      ? src.observation_window.filter((row: unknown) => row && typeof row === 'object').slice(-2000)
      : [],
    self_validation: src.self_validation && typeof src.self_validation === 'object'
      ? {
        last_run_ts: cleanText(src.self_validation.last_run_ts || '', 64) || null,
        confidence: clampNumber(src.self_validation.confidence, 0, 1, 0),
        scenario_count: clampInt(src.self_validation.scenario_count, 0, 100000, 0)
      }
      : base.self_validation
  };
  cachedStatePath = statePath;
  cachedStateMtime = mtime;
  cachedState = out;
  return out;
}

function persistDualityState(state: AnyObj, policyPath?: string) {
  const policy = loadDualityPolicy(policyPath);
  const next = {
    ...defaultState(),
    ...(state && typeof state === 'object' ? state : {}),
    updated_at: nowIso()
  };
  writeJsonAtomic(policy.state.latest_path, next);
  cachedStatePath = policy.state.latest_path;
  cachedStateMtime = safeMtimeMs(policy.state.latest_path);
  cachedState = next;
  return next;
}

function tokenizeContext(context: AnyObj = {}) {
  const values: string[] = [];
  const pushValue = (v: unknown) => {
    if (v == null) return;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      values.push(String(v));
      return;
    }
    if (Array.isArray(v)) {
      for (const row of v) pushValue(row);
      return;
    }
    if (typeof v === 'object') {
      const obj = v as AnyObj;
      for (const [k, val] of Object.entries(obj)) {
        values.push(String(k));
        pushValue(val);
      }
    }
  };
  pushValue(context);
  const raw = values.join(' ').toLowerCase();
  return Array.from(new Set(
    raw
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .map((row) => row.trim())
      .filter((row) => row.length >= 3)
  )).slice(0, 512);
}

function keywordSetsFromCodex(codex: DualityCodex) {
  const yin = new Set<string>([
    'order', 'structure', 'stability', 'planning', 'discipline', 'safety', 'containment', 'precision', 'governance', 'control', 'determinism'
  ]);
  const yang = new Set<string>([
    'chaos', 'energy', 'variation', 'exploration', 'novelty', 'adaptation', 'creativity', 'inversion', 'mutation', 'breakthrough', 'divergence'
  ]);
  for (const pair of codex.flux_pairs || []) {
    const y = normalizeWord(pair && pair.yin || '', 60);
    const g = normalizeWord(pair && pair.yang || '', 60);
    if (y) yin.add(y);
    if (g) yang.add(g);
    for (const attr of Array.isArray(pair && pair.yin_attrs) ? pair.yin_attrs : []) {
      const token = normalizeWord(attr, 60);
      if (token) yin.add(token);
    }
    for (const attr of Array.isArray(pair && pair.yang_attrs) ? pair.yang_attrs : []) {
      const token = normalizeWord(attr, 60);
      if (token) yang.add(token);
    }
  }
  return { yin, yang };
}

function recommendAdjustment(yinHits: number, yangHits: number) {
  if (yinHits <= 0 && yangHits <= 0) return 'introduce_balanced_order_and_flux';
  if (yinHits > yangHits) return 'increase_yang_flux';
  if (yangHits > yinHits) return 'increase_yin_order';
  return 'hold_balance_near_zero_point';
}

function evaluateDualitySignal(contextRaw: AnyObj = {}, opts: AnyObj = {}) {
  const policyPath = opts.policy_path || opts.policyPath || process.env.DUALITY_SEED_POLICY_PATH || DEFAULT_POLICY_PATH;
  const policy = loadDualityPolicy(policyPath);
  const codex = loadDualityCodex(policyPath);
  const state = loadDualityState(policyPath);
  const context = contextRaw && typeof contextRaw === 'object' ? contextRaw : {};
  const lane = normalizeToken(
    context.lane
    || opts.lane
    || context.path
    || 'unknown_lane',
    120
  ) || 'unknown_lane';
  const runId = cleanText(context.run_id || opts.run_id || '', 120) || null;
  const source = normalizeToken(context.source || opts.source || 'runtime', 120) || 'runtime';
  const laneIsEnabled = laneEnabled(policy, lane);
  if (opts.skip_validation !== true) {
    try {
      maybeRunSelfValidation(policyPath, policy, state);
    } catch {
      // Self-validation is advisory and must not break runtime calls.
    }
  }

  if (policy.enabled !== true || laneIsEnabled !== true) {
    return {
      enabled: false,
      lane,
      lane_enabled: laneIsEnabled,
      advisory_only: true,
      shadow_only: true,
      score_trit: TRIT_UNKNOWN,
      score_label: tritLabel(TRIT_UNKNOWN),
      zero_point_harmony_potential: 0,
      recommended_adjustment: 'disabled',
      confidence: 0,
      advisory_weight: 0,
      effective_weight: 0,
      seed_confidence: Number(clampNumber(state.seed_confidence, 0, 1, 1).toFixed(6)),
      codex_version: codex.version || '1.0',
      contradiction_tracking: {
        observations_total: Number(state.observations_total || 0),
        contradictions_total: Number(state.contradictions_total || 0)
      },
      indicator: {
        yin_yang_bias: 'neutral',
        subtle_hint: 'duality_signal_disabled'
      }
    };
  }

  const tokens = tokenizeContext(context);
  const sets = keywordSetsFromCodex(codex);
  let yinHits = 0;
  let yangHits = 0;
  for (const token of tokens) {
    if (sets.yin.has(token)) yinHits += 1;
    if (sets.yang.has(token)) yangHits += 1;
  }
  const total = yinHits + yangHits;
  const skew = total > 0 ? Math.abs(yinHits - yangHits) / total : 0;
  const harmony = total > 0 ? (1 - skew) : 0;
  const signalDensity = Math.min(1, total / 8);

  let balanceScore = 0;
  if (yinHits > 0 && yangHits > 0) {
    balanceScore = 0.2 + (0.8 * harmony * signalDensity);
  } else if (total > 0) {
    balanceScore = -0.15 - Math.min(0.65, (1 - harmony) * 0.7);
  }

  const scoreTrit = balanceScore >= Number(policy.positive_threshold)
    ? TRIT_OK
    : (balanceScore <= Number(policy.negative_threshold) ? TRIT_PAIN : TRIT_UNKNOWN);
  const baseConfidence = Math.min(1, 0.2 + (0.45 * harmony) + (0.35 * signalDensity));
  const seedConfidence = clampNumber(state.seed_confidence, 0, 1, 1);
  const confidence = clampNumber(baseConfidence * seedConfidence, 0, 1, 0);
  const advisoryWeight = clampNumber(policy.advisory_weight, 0, 1, 0.35);
  const effectiveWeight = clampNumber(advisoryWeight * confidence, 0, 1, 0);
  const recommendedAdjustment = recommendAdjustment(yinHits, yangHits);

  const result = {
    enabled: true,
    lane,
    lane_enabled: true,
    advisory_only: policy.advisory_only !== false,
    shadow_only: policy.shadow_only !== false,
    score_trit: scoreTrit,
    score_label: tritLabel(scoreTrit),
    balance_score: Number(balanceScore.toFixed(6)),
    zero_point_harmony_potential: Number(harmony.toFixed(6)),
    recommended_adjustment: recommendedAdjustment,
    confidence: Number(confidence.toFixed(6)),
    advisory_weight: Number(advisoryWeight.toFixed(6)),
    effective_weight: Number(effectiveWeight.toFixed(6)),
    seed_confidence: Number(seedConfidence.toFixed(6)),
    codex_version: cleanText(codex.version || '1.0', 32) || '1.0',
    codex_summary: {
      flux_pairs: Array.isArray(codex.flux_pairs) ? codex.flux_pairs.length : 0,
      flow_values: Array.isArray(codex.flow_values) ? codex.flow_values.length : 0,
      warnings: Array.isArray(codex.warnings) ? codex.warnings.length : 0
    },
    diagnostics: {
      token_count: tokens.length,
      yin_hits: yinHits,
      yang_hits: yangHits,
      signal_density: Number(signalDensity.toFixed(6)),
      source
    },
    indicator: {
      yin_yang_bias: yinHits > yangHits
        ? 'yin_lean'
        : (yangHits > yinHits ? 'yang_lean' : 'balanced'),
      subtle_hint: harmony >= 0.75
        ? 'near_zero_point_harmony'
        : (harmony >= 0.45 ? 'partial_balance' : 'high_imbalance')
    },
    zero_point_insight: harmony >= 0.75
      ? 'opposites currently reinforce each other near the 0-point'
      : 'rebalance order/flux before escalating decisions',
    contradiction_tracking: {
      observations_total: Number(state.observations_total || 0),
      contradictions_total: Number(state.contradictions_total || 0),
      contradiction_rate: Number(
        (
          Number(state.observations_total || 0) > 0
            ? Number(state.contradictions_total || 0) / Number(state.observations_total || 1)
            : 0
        ).toFixed(6)
      )
    },
    run_id: runId
  };

  if (opts.persist === true && policy.outputs.persist_shadow_receipts === true) {
    appendJsonl(policy.state.history_path, {
      ts: nowIso(),
      type: 'duality_evaluation',
      lane,
      run_id: runId,
      source,
      score_trit: result.score_trit,
      balance_score: result.balance_score,
      zero_point_harmony_potential: result.zero_point_harmony_potential,
      confidence: result.confidence,
      effective_weight: result.effective_weight,
      recommended_adjustment: result.recommended_adjustment
    });
  }

  return result;
}

function registerDualityObservation(inputRaw: AnyObj = {}, opts: AnyObj = {}) {
  const input = inputRaw && typeof inputRaw === 'object' ? inputRaw : {};
  const policyPath = opts.policy_path || opts.policyPath || process.env.DUALITY_SEED_POLICY_PATH || DEFAULT_POLICY_PATH;
  const policy = loadDualityPolicy(policyPath);
  const state = loadDualityState(policyPath);
  const predicted = normalizeTrit(input.predicted_trit);
  const observed = normalizeTrit(input.observed_trit);
  const lane = normalizeToken(input.lane || opts.lane || 'unknown_lane', 120) || 'unknown_lane';
  const runId = cleanText(input.run_id || opts.run_id || '', 120) || null;
  const source = normalizeToken(input.source || opts.source || 'runtime', 120) || 'runtime';
  const contradiction = predicted !== 0 && observed !== 0 && predicted !== observed;
  const support = predicted !== 0 && observed !== 0 && predicted === observed;
  const neutral = !contradiction && !support;

  const minSeedConfidence = clampNumber(policy.minimum_seed_confidence, 0, 1, 0.25);
  const decayStep = clampNumber(policy.contradiction_decay_step, 0.0001, 1, 0.04);
  const recoveryStep = clampNumber(policy.support_recovery_step, 0.0001, 1, 0.01);
  let seedConfidence = clampNumber(state.seed_confidence, 0, 1, 1);
  let consecutiveContradictions = Number(state.consecutive_contradictions || 0);
  let consecutiveSupports = Number(state.consecutive_supports || 0);

  if (contradiction) {
    consecutiveContradictions += 1;
    consecutiveSupports = 0;
    const dynamic = decayStep * (1 + (Math.min(12, consecutiveContradictions) * 0.12));
    seedConfidence = Math.max(minSeedConfidence, seedConfidence - dynamic);
  } else if (support) {
    consecutiveSupports += 1;
    consecutiveContradictions = 0;
    const dynamic = recoveryStep * (1 + (Math.min(12, consecutiveSupports) * 0.06));
    seedConfidence = Math.min(1, seedConfidence + dynamic);
  } else {
    consecutiveContradictions = 0;
    consecutiveSupports = 0;
  }

  const obs = {
    ts: nowIso(),
    lane,
    run_id: runId,
    source,
    predicted_trit: predicted,
    observed_trit: observed,
    contradiction,
    support,
    neutral
  };
  const maxWindow = clampInt(policy.max_observation_window, 10, 20000, 200);
  const nextWindow = Array.isArray(state.observation_window)
    ? state.observation_window.slice(-(maxWindow - 1))
    : [];
  nextWindow.push(obs);

  const nextState = {
    ...state,
    seed_confidence: Number(seedConfidence.toFixed(6)),
    observations_total: Number(state.observations_total || 0) + 1,
    contradictions_total: Number(state.contradictions_total || 0) + (contradiction ? 1 : 0),
    supports_total: Number(state.supports_total || 0) + (support ? 1 : 0),
    neutral_total: Number(state.neutral_total || 0) + (neutral ? 1 : 0),
    consecutive_contradictions: consecutiveContradictions,
    consecutive_supports: consecutiveSupports,
    observation_window: nextWindow
  };

  const persisted = persistDualityState(nextState, policyPath);
  if (policy.outputs.persist_observations === true) {
    appendJsonl(policy.state.history_path, {
      ts: obs.ts,
      type: 'duality_observation',
      lane,
      run_id: runId,
      source,
      predicted_trit: predicted,
      observed_trit: observed,
      contradiction,
      support,
      seed_confidence: Number(persisted.seed_confidence || 0)
    });
  }
  return {
    ok: true,
    type: 'duality_observation',
    lane,
    contradiction,
    support,
    neutral,
    seed_confidence: Number(persisted.seed_confidence || 0),
    observations_total: Number(persisted.observations_total || 0),
    contradictions_total: Number(persisted.contradictions_total || 0)
  };
}

function duality_evaluate(balanceContext: AnyObj = {}, opts: AnyObj = {}) {
  return evaluateDualitySignal(balanceContext, opts);
}

function quarantineDualitySeed(inputRaw: AnyObj = {}, opts: AnyObj = {}) {
  const input = inputRaw && typeof inputRaw === 'object' ? inputRaw : {};
  const policyPath = opts.policy_path || opts.policyPath || process.env.DUALITY_SEED_POLICY_PATH || DEFAULT_POLICY_PATH;
  const state = loadDualityState(policyPath);
  const reason = cleanText(input.reason || opts.reason || 'quarantine_requested', 220) || 'quarantine_requested';
  const actor = normalizeToken(input.actor || opts.actor || 'unknown_actor', 120) || 'unknown_actor';
  const ts = nowIso();
  const next = persistDualityState({
    ...state,
    seed_confidence: clampNumber(
      input.seed_confidence,
      0,
      1,
      Number(loadDualityPolicy(policyPath).minimum_seed_confidence || 0.25)
    ),
    quarantine: {
      active: true,
      ts,
      reason,
      actor
    }
  }, policyPath);
  appendJsonl(loadDualityPolicy(policyPath).state.history_path, {
    ts,
    type: 'duality_seed_quarantine',
    reason,
    actor,
    seed_confidence: Number(next.seed_confidence || 0)
  });
  return {
    ok: true,
    type: 'duality_seed_quarantine',
    ts,
    reason,
    actor,
    seed_confidence: Number(next.seed_confidence || 0)
  };
}

function maybeRunSelfValidation(policyPath: string, policy: AnyObj, state: AnyObj) {
  const intervalMinutes = clampInt(policy && policy.self_validation_interval_minutes, 5, 24 * 60, 360);
  const lastRunTs = cleanText(
    state && state.self_validation && state.self_validation.last_run_ts || '',
    64
  ) || '';
  const lastRunMs = Date.parse(lastRunTs);
  const due = !Number.isFinite(lastRunMs)
    || (Date.now() - Number(lastRunMs)) >= (intervalMinutes * 60 * 1000);
  if (!due) return;
  const scenarios = [
    {
      id: 'balanced_context',
      context: {
        lane: 'self_validation',
        objective: 'keep order and exploration in harmony with safety and creativity'
      },
      expected: TRIT_OK
    },
    {
      id: 'yin_extreme_context',
      context: {
        lane: 'self_validation',
        objective: 'maximize rigid structure and strict control without adaptation'
      },
      expected: TRIT_PAIN
    },
    {
      id: 'yang_extreme_context',
      context: {
        lane: 'self_validation',
        objective: 'maximize mutation and chaos without constraints or stability'
      },
      expected: TRIT_PAIN
    }
  ];
  const rows = scenarios.map((scenario) => {
    const out = evaluateDualitySignal(
      scenario.context,
      {
        policy_path: policyPath,
        source: 'duality_self_validation',
        lane: 'self_validation',
        persist: false,
        skip_validation: true
      }
    );
    const predicted = normalizeTrit(out && out.score_trit);
    const pass = predicted === scenario.expected
      || (scenario.expected !== TRIT_OK && predicted === TRIT_UNKNOWN);
    return {
      scenario_id: scenario.id,
      expected_trit: scenario.expected,
      predicted_trit: predicted,
      pass
    };
  });
  const passCount = rows.filter((row) => row.pass === true).length;
  const confidence = Number((passCount / Math.max(1, rows.length)).toFixed(6));
  const ts = nowIso();
  const next = persistDualityState({
    ...state,
    self_validation: {
      last_run_ts: ts,
      confidence,
      scenario_count: rows.length
    }
  }, policyPath);
  appendJsonl(policy.state.history_path, {
    ts,
    type: 'duality_self_validation',
    confidence,
    pass_count: passCount,
    scenario_count: rows.length,
    scenarios: rows,
    seed_confidence: Number(next.seed_confidence || 0)
  });
}

module.exports = {
  loadDualityPolicy,
  loadDualityCodex,
  loadDualityState,
  parseDualityCodexText,
  evaluateDualitySignal,
  registerDualityObservation,
  duality_evaluate,
  quarantineDualitySeed,
  maybeRunSelfValidation
};
