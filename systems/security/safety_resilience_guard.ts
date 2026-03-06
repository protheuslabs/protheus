#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.SAFETY_RESILIENCE_POLICY_PATH
  ? path.resolve(process.env.SAFETY_RESILIENCE_POLICY_PATH)
  : path.join(ROOT, 'config', 'safety_resilience_policy.json');

function nowIso() {
  return new Date().toISOString();
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
  console.log('  node systems/security/safety_resilience_guard.js evaluate --sentinel-json=<json> [--signals-json=<json>] [--apply=1|0] [--policy=<path>]');
  console.log('  node systems/security/safety_resilience_guard.js status [--policy=<path>]');
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

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseJsonArg(raw: unknown, fallback: AnyObj = {}) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return fallback;
  const payload = text.startsWith('@')
    ? fs.readFileSync(path.resolve(text.slice(1)), 'utf8')
    : text;
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeTier(raw: unknown) {
  const t = normalizeToken(raw, 80);
  if (['clear', 'stasis', 'confirmed_malice'].includes(t)) return t;
  return 'clear';
}

function defaultPolicy() {
  return {
    schema_id: 'safety_resilience_policy',
    schema_version: '1.0',
    enabled: true,
    anti_spam: {
      window_minutes: 15,
      max_alerts_per_window: 6,
      max_identical_reason_burst: 4,
      cooldown_minutes: 20
    },
    consensus: {
      min_independent_signals_for_confirmed_malice: 2,
      signal_keys: ['strand_mismatch', 'codex_failure', 'codex_signature_mismatch']
    },
    false_positive: {
      max_daily_downgrades: 32,
      enforce_budget_guard: true,
      extra_signals_when_budget_exhausted: 1
    },
    state_path: 'state/security/safety_resilience/state.json',
    receipts_path: 'state/security/safety_resilience/receipts.jsonl'
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const src = readJson(policyPath, {});
  const antiSpam = src.anti_spam && typeof src.anti_spam === 'object' ? src.anti_spam : {};
  const consensus = src.consensus && typeof src.consensus === 'object' ? src.consensus : {};
  const fp = src.false_positive && typeof src.false_positive === 'object' ? src.false_positive : {};
  return {
    schema_id: 'safety_resilience_policy',
    schema_version: cleanText(src.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: src.enabled !== false,
    anti_spam: {
      window_minutes: clampInt(antiSpam.window_minutes, 1, 24 * 60, base.anti_spam.window_minutes),
      max_alerts_per_window: clampInt(antiSpam.max_alerts_per_window, 1, 10000, base.anti_spam.max_alerts_per_window),
      max_identical_reason_burst: clampInt(antiSpam.max_identical_reason_burst, 1, 10000, base.anti_spam.max_identical_reason_burst),
      cooldown_minutes: clampInt(antiSpam.cooldown_minutes, 1, 24 * 60, base.anti_spam.cooldown_minutes)
    },
    consensus: {
      min_independent_signals_for_confirmed_malice: clampInt(
        consensus.min_independent_signals_for_confirmed_malice,
        1,
        8,
        base.consensus.min_independent_signals_for_confirmed_malice
      ),
      signal_keys: Array.isArray(consensus.signal_keys)
        ? consensus.signal_keys.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean).slice(0, 32)
        : base.consensus.signal_keys.slice(0)
    },
    false_positive: {
      max_daily_downgrades: clampInt(fp.max_daily_downgrades, 1, 100000, base.false_positive.max_daily_downgrades),
      enforce_budget_guard: fp.enforce_budget_guard !== false,
      extra_signals_when_budget_exhausted: clampInt(
        fp.extra_signals_when_budget_exhausted,
        0,
        8,
        base.false_positive.extra_signals_when_budget_exhausted
      )
    },
    state_path: path.resolve(ROOT, cleanText(src.state_path || base.state_path, 320)),
    receipts_path: path.resolve(ROOT, cleanText(src.receipts_path || base.receipts_path, 320)),
    policy_path: path.resolve(policyPath)
  };
}

function loadState(policy: AnyObj) {
  const raw = readJson(policy.state_path, {});
  const history = Array.isArray(raw.history) ? raw.history : [];
  const daily = raw.daily && typeof raw.daily === 'object' ? raw.daily : {};
  return {
    schema_id: 'safety_resilience_state',
    schema_version: '1.0',
    updated_at: cleanText(raw.updated_at || nowIso(), 40) || nowIso(),
    cooldown_until: cleanText(raw.cooldown_until || '', 40) || null,
    history: history.slice(-2000),
    daily: {
      date: cleanText(daily.date || nowIso().slice(0, 10), 10) || nowIso().slice(0, 10),
      downgrades: clampInt(daily.downgrades, 0, 1_000_000, 0)
    }
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.state_path, {
    schema_id: 'safety_resilience_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    cooldown_until: state.cooldown_until || null,
    history: Array.isArray(state.history) ? state.history.slice(-2000) : [],
    daily: state.daily && typeof state.daily === 'object'
      ? {
          date: cleanText(state.daily.date || nowIso().slice(0, 10), 10) || nowIso().slice(0, 10),
          downgrades: clampInt(state.daily.downgrades, 0, 1_000_000, 0)
        }
      : {
          date: nowIso().slice(0, 10),
          downgrades: 0
        }
  });
}

function reasonHash(reasonCodes: unknown) {
  const rows = Array.isArray(reasonCodes)
    ? reasonCodes.map((row) => normalizeToken(row, 80)).filter(Boolean).sort()
    : [];
  return crypto.createHash('sha1').update(rows.join('|'), 'utf8').digest('hex');
}

function evaluateSafetyResilience(input: AnyObj = {}, opts: AnyObj = {}) {
  const policy = loadPolicy(opts.policy_path ? path.resolve(String(opts.policy_path)) : DEFAULT_POLICY_PATH);
  const apply = opts.apply !== false;
  const ts = nowIso();
  const day = ts.slice(0, 10);

  const sentinel = input.sentinel && typeof input.sentinel === 'object' ? input.sentinel : {};
  const sourceSignals = input.signals && typeof input.signals === 'object' ? input.signals : {};
  const tier = normalizeTier(sentinel.tier || 'clear');
  const score = clampNumber(sentinel.score, 0, 100, 0);
  const reasonCodes = Array.isArray(sentinel.reason_codes)
    ? sentinel.reason_codes.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
    : [];
  const forcedMalice = reasonCodes.includes('sentinel_force_confirmed_malice');

  const state = loadState(policy);
  if (state.daily.date !== day) {
    state.daily = { date: day, downgrades: 0 };
  }

  const windowMs = policy.anti_spam.window_minutes * 60_000;
  const nowMs = Date.now();
  const trimmedHistory = (Array.isArray(state.history) ? state.history : []).filter((row: AnyObj) => {
    const tsMs = Date.parse(String(row && row.ts || ''));
    return Number.isFinite(tsMs) && (nowMs - tsMs) <= windowMs;
  });
  state.history = trimmedHistory;

  const curReasonHash = reasonHash(reasonCodes);
  const alertBurst = trimmedHistory.length + 1;
  const identicalBurst = trimmedHistory.filter((row: AnyObj) => String(row && row.reason_hash || '') === curReasonHash).length + 1;

  const signalKeys = Array.isArray(policy.consensus.signal_keys) ? policy.consensus.signal_keys : [];
  const independentSignals = signalKeys.filter((key: string) => sourceSignals[key] === true).length;
  const baseSignalFloor = Number(policy.consensus.min_independent_signals_for_confirmed_malice || 2);
  const budgetExhausted = state.daily.downgrades >= Number(policy.false_positive.max_daily_downgrades || 0);
  const signalFloor = baseSignalFloor + (budgetExhausted ? Number(policy.false_positive.extra_signals_when_budget_exhausted || 0) : 0);

  const cooldownUntilMs = state.cooldown_until ? Date.parse(String(state.cooldown_until)) : NaN;
  const inCooldown = Number.isFinite(cooldownUntilMs) && cooldownUntilMs > nowMs;
  const suspectedSpam = alertBurst > Number(policy.anti_spam.max_alerts_per_window || 0)
    || identicalBurst > Number(policy.anti_spam.max_identical_reason_burst || 0)
    || inCooldown;

  let adjustedTier = tier;
  let adjustedScore = score;
  const guardReasons: string[] = [];

  if (!forcedMalice && tier === 'confirmed_malice' && independentSignals < signalFloor) {
    adjustedTier = 'stasis';
    adjustedScore = Math.max(0, Math.min(adjustedScore, 2.99));
    guardReasons.push('consensus_not_met_for_malice');
    if (budgetExhausted) guardReasons.push('false_positive_budget_guard');
  }

  if (!forcedMalice && adjustedTier === 'confirmed_malice' && suspectedSpam) {
    adjustedTier = 'stasis';
    adjustedScore = Math.max(0, Math.min(adjustedScore, 2.99));
    guardReasons.push('anti_spam_dampened');
  }

  if (
    !forcedMalice
    && policy.false_positive.enforce_budget_guard === true
    && budgetExhausted
    && adjustedTier === 'confirmed_malice'
  ) {
    adjustedTier = 'stasis';
    adjustedScore = Math.max(0, Math.min(adjustedScore, 2.99));
    guardReasons.push('false_positive_budget_guard');
  }

  const downgraded = adjustedTier !== tier;
  if (downgraded) {
    state.daily.downgrades = Number(state.daily.downgrades || 0) + 1;
    state.cooldown_until = new Date(nowMs + policy.anti_spam.cooldown_minutes * 60_000).toISOString();
  }

  state.history.push({
    ts,
    tier,
    adjusted_tier: adjustedTier,
    score,
    adjusted_score: adjustedScore,
    reason_hash: curReasonHash,
    independent_signals: independentSignals,
    suspected_spam: suspectedSpam,
    downgraded
  });

  if (apply && policy.enabled === true) {
    saveState(policy, state);
    appendJsonl(policy.receipts_path, {
      ts,
      type: 'safety_resilience_evaluation',
      source: cleanText(input.source || 'unknown', 120) || 'unknown',
      tier_before: tier,
      tier_after: adjustedTier,
      score_before: score,
      score_after: adjustedScore,
      independent_signals: independentSignals,
      signal_floor: signalFloor,
      alert_burst: alertBurst,
      identical_reason_burst: identicalBurst,
      suspected_spam: suspectedSpam,
      budget_exhausted: budgetExhausted,
      downgraded,
      guard_reasons: guardReasons
    });
  }

  const adjustedSentinel = {
    ...sentinel,
    tier: adjustedTier,
    score: Number(adjustedScore.toFixed(6)),
    reason_codes: Array.from(new Set([...(reasonCodes || []), ...guardReasons]))
  };

  return {
    ok: true,
    type: 'safety_resilience_evaluation',
    ts,
    policy_version: policy.schema_version,
    policy_path: path.relative(ROOT, policy.policy_path) || policy.policy_path,
    apply,
    source: cleanText(input.source || 'unknown', 120) || 'unknown',
    tier_before: tier,
    tier_after: adjustedTier,
    score_before: Number(score.toFixed(6)),
    score_after: Number(adjustedScore.toFixed(6)),
    independent_signals: independentSignals,
    signal_floor: signalFloor,
    alert_burst: alertBurst,
    identical_reason_burst: identicalBurst,
    suspected_spam: suspectedSpam,
    budget_exhausted: budgetExhausted,
    downgraded,
    guard_reasons: guardReasons,
    adjusted_sentinel: adjustedSentinel
  };
}

function cmdEvaluate(args: AnyObj) {
  const payload = evaluateSafetyResilience({
    sentinel: parseJsonArg(args.sentinel_json || args['sentinel-json'], {}),
    signals: parseJsonArg(args.signals_json || args['signals-json'], {}),
    source: cleanText(args.source || 'cli', 120) || 'cli'
  }, {
    policy_path: args.policy ? path.resolve(String(args.policy)) : undefined,
    apply: toBool(args.apply, true)
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const receipts = readJsonl(policy.receipts_path);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'safety_resilience_status',
    state,
    recent_receipts: receipts.slice(-20),
    policy_version: policy.schema_version,
    policy_path: path.relative(ROOT, policy.policy_path) || policy.policy_path
  }, null, 2)}\n`);
}

function main(argv: string[]) {
  const args = parseArgs(argv);
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === '--help' || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'evaluate') return cmdEvaluate(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  evaluateSafetyResilience
};
