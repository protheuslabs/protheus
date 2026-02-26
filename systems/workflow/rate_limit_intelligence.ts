#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/workflow/rate_limit_intelligence.js
 *
 * Adaptive lane-aware rate limit controller for outbound workflow steps.
 * BRG-004 implementation.
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'rate_limit_intelligence_policy.json');
const DEFAULT_STATE_PATH = path.join(ROOT, 'state', 'adaptive', 'workflows', 'rate_limit_intelligence', 'state.json');
const DEFAULT_EVENTS_PATH = path.join(ROOT, 'state', 'adaptive', 'workflows', 'rate_limit_intelligence', 'events.jsonl');

function nowIso() {
  return new Date().toISOString();
}

function parseIsoMs(value: unknown) {
  const ts = Date.parse(String(value == null ? '' : value));
  return Number.isFinite(ts) ? ts : null;
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

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 80) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    apply_in_dry_run: false,
    channels: {
      default: {
        hard_limit_per_hour: 18,
        min_interval_sec: 20,
        base_cooldown_sec: 300,
        max_cooldown_sec: 3 * 60 * 60
      },
      email: {
        hard_limit_per_hour: 12,
        min_interval_sec: 75,
        base_cooldown_sec: 15 * 60,
        max_cooldown_sec: 6 * 60 * 60
      },
      discord: {
        hard_limit_per_hour: 28,
        min_interval_sec: 8,
        base_cooldown_sec: 120,
        max_cooldown_sec: 60 * 60
      },
      upwork: {
        hard_limit_per_hour: 8,
        min_interval_sec: 120,
        base_cooldown_sec: 20 * 60,
        max_cooldown_sec: 8 * 60 * 60
      }
    },
    high_trust_fast_path: {
      enabled: true,
      min_trust_score: 0.78,
      min_quality_score: 0.72,
      max_drift_risk: 0.28,
      max_interval_reduction: 0.6
    },
    drift_penalty: {
      enabled: true,
      max_interval_multiplier: 2.8
    },
    learning: {
      ema_alpha: 0.2,
      deny_streak_cooldown_threshold: 3
    }
  };
}

function normalizeChannelPolicy(raw: AnyObj, fallback: AnyObj) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    hard_limit_per_hour: clampInt(src.hard_limit_per_hour, 1, 5000, fallback.hard_limit_per_hour),
    min_interval_sec: clampInt(src.min_interval_sec, 0, 24 * 60 * 60, fallback.min_interval_sec),
    base_cooldown_sec: clampInt(src.base_cooldown_sec, 0, 24 * 60 * 60, fallback.base_cooldown_sec),
    max_cooldown_sec: clampInt(src.max_cooldown_sec, 1, 7 * 24 * 60 * 60, fallback.max_cooldown_sec)
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const channelsRaw = raw && raw.channels && typeof raw.channels === 'object' ? raw.channels : {};
  const channels: AnyObj = {};
  const known = ['default', 'email', 'discord', 'upwork'];
  for (const key of known) {
    channels[key] = normalizeChannelPolicy(channelsRaw[key], base.channels[key] || base.channels.default);
  }
  return {
    version: cleanText(raw.version || base.version, 32) || '1.0',
    enabled: raw.enabled !== false,
    apply_in_dry_run: raw.apply_in_dry_run === true,
    channels,
    high_trust_fast_path: {
      enabled: !raw.high_trust_fast_path || raw.high_trust_fast_path.enabled !== false,
      min_trust_score: clampNumber(
        raw.high_trust_fast_path && raw.high_trust_fast_path.min_trust_score,
        0,
        1,
        base.high_trust_fast_path.min_trust_score
      ),
      min_quality_score: clampNumber(
        raw.high_trust_fast_path && raw.high_trust_fast_path.min_quality_score,
        0,
        1,
        base.high_trust_fast_path.min_quality_score
      ),
      max_drift_risk: clampNumber(
        raw.high_trust_fast_path && raw.high_trust_fast_path.max_drift_risk,
        0,
        1,
        base.high_trust_fast_path.max_drift_risk
      ),
      max_interval_reduction: clampNumber(
        raw.high_trust_fast_path && raw.high_trust_fast_path.max_interval_reduction,
        0,
        0.95,
        base.high_trust_fast_path.max_interval_reduction
      )
    },
    drift_penalty: {
      enabled: !raw.drift_penalty || raw.drift_penalty.enabled !== false,
      max_interval_multiplier: clampNumber(
        raw.drift_penalty && raw.drift_penalty.max_interval_multiplier,
        1,
        8,
        base.drift_penalty.max_interval_multiplier
      )
    },
    learning: {
      ema_alpha: clampNumber(raw.learning && raw.learning.ema_alpha, 0.01, 1, base.learning.ema_alpha),
      deny_streak_cooldown_threshold: clampInt(
        raw.learning && raw.learning.deny_streak_cooldown_threshold,
        1,
        50,
        base.learning.deny_streak_cooldown_threshold
      )
    }
  };
}

function defaultState() {
  return {
    version: '1.0',
    updated_at: null,
    lanes: {}
  };
}

function loadState(statePath = DEFAULT_STATE_PATH) {
  const payload = readJson(statePath, defaultState());
  const lanes = payload && payload.lanes && typeof payload.lanes === 'object' ? payload.lanes : {};
  return {
    version: cleanText(payload.version || '1.0', 24) || '1.0',
    updated_at: payload.updated_at ? String(payload.updated_at) : null,
    lanes
  };
}

function saveState(statePath: string, state: AnyObj) {
  const payload = {
    version: '1.0',
    updated_at: nowIso(),
    lanes: state && state.lanes && typeof state.lanes === 'object' ? state.lanes : {}
  };
  writeJsonAtomic(statePath, payload);
  return payload;
}

function classifyChannel(input: AnyObj = {}) {
  const adapter = normalizeToken(input.adapter || '', 80);
  const provider = normalizeToken(input.provider || '', 80);
  const objective = normalizeToken(input.objective || input.objective_id || '', 140);
  const hint = normalizeToken(input.channel || '', 40);
  const blob = `${hint} ${adapter} ${provider} ${objective}`;
  if (/\bupwork\b/.test(blob)) return 'upwork';
  if (/\bdiscord\b/.test(blob)) return 'discord';
  if (adapter.includes('slack')) return 'discord';
  if (/\bemail\b/.test(blob)) return 'email';
  if (adapter.includes('email')) return 'email';
  return 'default';
}

function laneKey(channel: string, provider: string) {
  return `${normalizeToken(channel || 'default', 40) || 'default'}|${normalizeToken(provider || 'default', 80) || 'default'}`;
}

function ensureLaneState(state: AnyObj, key: string) {
  if (!state.lanes[key] || typeof state.lanes[key] !== 'object') {
    state.lanes[key] = {
      lane_key: key,
      last_sent_at: null,
      window_started_at: null,
      sent_in_window: 0,
      quality_ema: 0.55,
      drift_ema: 0.3,
      trust_ema: 0.55,
      deny_streak: 0,
      allow_streak: 0,
      cooldown_until: null
    };
  }
  return state.lanes[key];
}

function resolvePaths(opts: AnyObj = {}) {
  const policyPath = path.resolve(String(opts.policyPath || opts.policy_path || process.env.RATE_LIMIT_INTELLIGENCE_POLICY_PATH || DEFAULT_POLICY_PATH));
  const statePath = path.resolve(String(opts.statePath || opts.state_path || process.env.RATE_LIMIT_INTELLIGENCE_STATE_PATH || DEFAULT_STATE_PATH));
  const eventsPath = path.resolve(String(opts.eventsPath || opts.events_path || process.env.RATE_LIMIT_INTELLIGENCE_EVENTS_PATH || DEFAULT_EVENTS_PATH));
  return {
    policy_path: policyPath,
    state_path: statePath,
    events_path: eventsPath
  };
}

function emitEvent(eventsPath: string, row: AnyObj) {
  appendJsonl(eventsPath, {
    ts: nowIso(),
    type: 'rate_limit_intelligence',
    ...row
  });
}

function evaluateRateLimitDecision(input: AnyObj = {}, opts: AnyObj = {}) {
  const paths = resolvePaths(opts);
  const policy = opts.policy && typeof opts.policy === 'object' ? opts.policy : loadPolicy(paths.policy_path);
  const nowMs = Number.isFinite(Number(input.now_ms)) ? Number(input.now_ms) : Date.now();
  const now = new Date(nowMs).toISOString();
  const dryRun = input.dry_run === true;

  if (policy.enabled !== true) {
    return {
      ok: true,
      applicable: false,
      reason: 'rate_limit_policy_disabled',
      policy_path: relPath(paths.policy_path)
    };
  }

  const channel = classifyChannel(input);
  const provider = normalizeToken(input.provider || 'default', 80) || 'default';
  const key = laneKey(channel, provider);
  const chCfg = policy.channels[channel] || policy.channels.default;
  const state = loadState(paths.state_path);
  const lane = ensureLaneState(state, key);

  const qualityScore = clampNumber(
    input.quality_score,
    0,
    1,
    clampNumber(lane.quality_ema, 0, 1, 0.55)
  );
  const driftRisk = clampNumber(
    input.drift_risk,
    0,
    1,
    clampNumber(lane.drift_ema, 0, 1, 0.3)
  );
  const trustScore = clampNumber(
    input.trust_score,
    0,
    1,
    clampNumber(lane.trust_ema, 0, 1, 0.55)
  );

  const winStart = parseIsoMs(lane.window_started_at);
  if (!winStart || (nowMs - winStart) >= 60 * 60 * 1000) {
    lane.window_started_at = now;
    lane.sent_in_window = 0;
  }

  const baseInterval = Number(chCfg.min_interval_sec || 0);
  const driftMultiplier = policy.drift_penalty.enabled === true
    ? (1 + (driftRisk * (Number(policy.drift_penalty.max_interval_multiplier || 2.8) - 1)))
    : 1;
  const fastPathEnabled = policy.high_trust_fast_path.enabled === true
    && trustScore >= Number(policy.high_trust_fast_path.min_trust_score || 0.78)
    && qualityScore >= Number(policy.high_trust_fast_path.min_quality_score || 0.72)
    && driftRisk <= Number(policy.high_trust_fast_path.max_drift_risk || 0.28);
  const fastPathReduction = fastPathEnabled
    ? Number(policy.high_trust_fast_path.max_interval_reduction || 0.6)
    : 0;
  const dynamicInterval = Math.max(
    0,
    Math.round(baseInterval * driftMultiplier * (1 - fastPathReduction))
  );

  const lastSentMs = parseIsoMs(lane.last_sent_at);
  const cooldownUntilMs = parseIsoMs(lane.cooldown_until);
  let allow = true;
  let reason = 'allow';
  let retryAfterSec = 0;

  if (cooldownUntilMs && cooldownUntilMs > nowMs) {
    allow = false;
    reason = 'cooldown_active';
    retryAfterSec = Math.max(1, Math.ceil((cooldownUntilMs - nowMs) / 1000));
  }
  if (allow && Number(lane.sent_in_window || 0) >= Number(chCfg.hard_limit_per_hour || 1)) {
    allow = false;
    reason = 'provider_hourly_hard_limit';
    retryAfterSec = Math.max(1, Math.ceil(((60 * 60 * 1000) - (nowMs - parseIsoMs(lane.window_started_at))) / 1000));
  }
  if (allow && lastSentMs != null && dynamicInterval > 0) {
    const elapsedSec = Math.max(0, Math.floor((nowMs - lastSentMs) / 1000));
    if (elapsedSec < dynamicInterval) {
      allow = false;
      reason = 'adaptive_interval_guard';
      retryAfterSec = dynamicInterval - elapsedSec;
    }
  }

  const apply = opts.apply !== false && (dryRun !== true || policy.apply_in_dry_run === true);
  if (apply) {
    if (allow) {
      lane.last_sent_at = now;
      lane.sent_in_window = Number(lane.sent_in_window || 0) + 1;
      lane.allow_streak = Number(lane.allow_streak || 0) + 1;
      lane.deny_streak = 0;
      lane.cooldown_until = null;
    } else {
      lane.allow_streak = 0;
      lane.deny_streak = Number(lane.deny_streak || 0) + 1;
      if (reason === 'provider_hourly_hard_limit') {
        const cdSec = clampInt(
          Number(chCfg.base_cooldown_sec || 300) * 2,
          1,
          Number(chCfg.max_cooldown_sec || 3 * 60 * 60),
          Number(chCfg.base_cooldown_sec || 300)
        );
        lane.cooldown_until = new Date(nowMs + (cdSec * 1000)).toISOString();
      } else if (Number(lane.deny_streak || 0) >= Number(policy.learning.deny_streak_cooldown_threshold || 3)) {
        const exponent = Math.max(0, Number(lane.deny_streak || 0) - Number(policy.learning.deny_streak_cooldown_threshold || 3));
        const cdSec = clampInt(
          Math.round(Number(chCfg.base_cooldown_sec || 300) * Math.pow(1.6, exponent)),
          1,
          Number(chCfg.max_cooldown_sec || 3 * 60 * 60),
          Number(chCfg.base_cooldown_sec || 300)
        );
        lane.cooldown_until = new Date(nowMs + (cdSec * 1000)).toISOString();
      }
    }
    saveState(paths.state_path, state);
  }

  const payload = {
    ok: allow,
    applicable: true,
    decision: allow ? 'allow' : 'defer',
    reason,
    retry_after_sec: allow ? 0 : retryAfterSec,
    channel,
    provider,
    lane_key: key,
    quality_score: Number(qualityScore.toFixed(4)),
    drift_risk: Number(driftRisk.toFixed(4)),
    trust_score: Number(trustScore.toFixed(4)),
    hard_limit_per_hour: Number(chCfg.hard_limit_per_hour || 0),
    sent_in_window: Number(lane.sent_in_window || 0),
    dynamic_min_interval_sec: dynamicInterval,
    fast_path: fastPathEnabled,
    cooldown_until: lane.cooldown_until || null,
    policy_path: relPath(paths.policy_path),
    state_path: relPath(paths.state_path)
  };

  emitEvent(paths.events_path, {
    stage: 'decision',
    dry_run: dryRun === true,
    apply,
    workflow_id: cleanText(input.workflow_id || '', 120) || null,
    objective_id: cleanText(input.objective_id || '', 120) || null,
    ...payload
  });

  return payload;
}

function updateEma(current: unknown, sample: number, alpha: number, fallback: number) {
  const prev = clampNumber(current, 0, 1, fallback);
  return Number(((alpha * sample) + ((1 - alpha) * prev)).toFixed(6));
}

function recordRateLimitOutcome(input: AnyObj = {}, opts: AnyObj = {}) {
  const paths = resolvePaths(opts);
  const policy = opts.policy && typeof opts.policy === 'object' ? opts.policy : loadPolicy(paths.policy_path);
  const state = loadState(paths.state_path);
  const channel = classifyChannel(input);
  const provider = normalizeToken(input.provider || 'default', 80) || 'default';
  const key = laneKey(channel, provider);
  const lane = ensureLaneState(state, key);
  const alpha = Number(policy.learning && policy.learning.ema_alpha || 0.2);
  const ok = input.ok === true;
  const reason = cleanText(input.failure_reason || input.reason || '', 140).toLowerCase();

  const qualitySample = ok ? 0.9 : (reason.includes('criteria') ? 0.35 : 0.2);
  const driftSample = ok ? clampNumber(input.drift_risk, 0, 1, 0.25) : clampNumber(input.drift_risk, 0, 1, 0.55);
  let trustSample = ok ? 0.8 : 0.3;
  if (!ok && /429|rate.?limit|cooldown/.test(reason)) trustSample = 0.22;

  lane.quality_ema = updateEma(lane.quality_ema, qualitySample, alpha, 0.55);
  lane.drift_ema = updateEma(lane.drift_ema, driftSample, alpha, 0.3);
  lane.trust_ema = updateEma(lane.trust_ema, trustSample, alpha, 0.55);

  if (!ok && /429|rate.?limit/.test(reason)) {
    const chCfg = policy.channels[channel] || policy.channels.default;
    const base = Number(chCfg.base_cooldown_sec || 300);
    const max = Number(chCfg.max_cooldown_sec || 3 * 60 * 60);
    const cdSec = clampInt(base * 2, 1, max, base);
    lane.cooldown_until = new Date(Date.now() + (cdSec * 1000)).toISOString();
  }

  saveState(paths.state_path, state);
  emitEvent(paths.events_path, {
    stage: 'outcome',
    workflow_id: cleanText(input.workflow_id || '', 120) || null,
    objective_id: cleanText(input.objective_id || '', 120) || null,
    channel,
    provider,
    lane_key: key,
    ok,
    failure_reason: reason || null,
    quality_ema: lane.quality_ema,
    drift_ema: lane.drift_ema,
    trust_ema: lane.trust_ema,
    cooldown_until: lane.cooldown_until || null,
    policy_path: relPath(paths.policy_path),
    state_path: relPath(paths.state_path)
  });

  return {
    ok: true,
    channel,
    provider,
    lane_key: key,
    quality_ema: lane.quality_ema,
    drift_ema: lane.drift_ema,
    trust_ema: lane.trust_ema,
    cooldown_until: lane.cooldown_until || null
  };
}

module.exports = {
  classifyChannel,
  loadPolicy,
  loadState,
  evaluateRateLimitDecision,
  recordRateLimitOutcome
};
