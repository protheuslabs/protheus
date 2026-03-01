#!/usr/bin/env node
'use strict';
export {};

/**
 * venom_containment_layer.js
 *
 * V3-VENOM-000..007 defensive-only containment primitive.
 * - Detects unauthorized trust drift using soul-token + startup attestation signals.
 * - Applies staged containment ramps (tease -> challenge -> degrade -> lockout).
 * - Emits bounded friction + decoy guidance and forensic evidence bundles.
 * - Never performs offensive behavior; all effects are local, bounded, and auditable.
 *
 * Usage:
 *   node systems/security/venom_containment_layer.js evaluate [--session-id=id] [--source=local] [--action=run] [--risk=low] [--runtime-class=desktop] [--unauthorized=0|1] [--apply=0|1]
 *   node systems/security/venom_containment_layer.js decoy --level=low --prompt="text"
 *   node systems/security/venom_containment_layer.js evolve
 *   node systems/security/venom_containment_layer.js status
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.VENOM_CONTAINMENT_POLICY_PATH
  ? path.resolve(process.env.VENOM_CONTAINMENT_POLICY_PATH)
  : path.join(ROOT, 'config', 'venom_containment_policy.json');

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

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
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

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function hash16(value: unknown) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value), 'utf8').digest('hex').slice(0, 16);
}

function parseIsoMs(v: unknown): number | null {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    defensive_only_invariant: true,
    offensive_behaviors_forbidden: ['external_attack', 'malware_payload', 'unbounded_compute', 'destructive_payload'],
    trusted_sources: ['local', 'cli', 'daemon', 'spine'],
    high_value_actions: ['apply', 'deploy', 'exfil', 'spend', 'self_modify', 'root_change', 'provider_buy'],
    runtime_fingerprint_classes: ['unknown', 'desktop', 'cloud_vm', 'gpu_heavy', 'containerized'],
    timed_lease: {
      stealth_window_enabled: false,
      stealth_window_hours: 0,
      high_value_bypass: true
    },
    staged_ramp: {
      tease_actions: 2,
      challenge_actions: 4,
      degrade_actions: 6,
      lockout_actions: 8,
      lockout_cooldown_minutes: 720
    },
    bounds: {
      max_friction_delay_ms: 1800,
      max_challenge_score: 0.95,
      max_lease_decay_rate: 0.8,
      max_containment_children: 4
    },
    enforcement: {
      challenge_threshold: 0.45,
      min_challenge_difficulty_bits: 10,
      max_challenge_difficulty_bits: 20,
      challenge_ttl_seconds: 300,
      challenge_stages: ['challenge', 'degrade', 'lockout'],
      decoy_from_stage: 'challenge'
    },
    adaptive_integration: {
      enabled: true,
      runtime_bias_weight: 1,
      cost_profiles_path: 'state/security/red_team/adaptive_defense/cost_profiles.json'
    },
    forensics: {
      enabled: true,
      include_watermark: true,
      master_conduit_mirror: true,
      evidence_dir: 'state/security/venom_containment/evidence',
      events_path: 'state/security/venom_containment/forensic_events.jsonl'
    },
    paths: {
      state_root: 'state/security/venom_containment',
      sessions_path: 'state/security/venom_containment/sessions.json',
      latest_path: 'state/security/venom_containment/latest.json',
      history_path: 'state/security/venom_containment/history.jsonl',
      profiles_path: 'state/security/venom_containment/profiles.json',
      startup_attestation_path: 'state/security/startup_attestation.json',
      soul_token_guard_path: 'state/security/soul_token_guard.json',
      lease_state_path: 'state/security/capability_leases.json',
      master_queue_path: 'state/workflow/learning_conduit/master_training_queue.jsonl'
    },
    decoy: {
      low: { prefix: '[contained-low]', quality_factor: 0.45, watermark_tag: 'decoy_low' },
      medium: { prefix: '[contained-medium]', quality_factor: 0.3, watermark_tag: 'decoy_medium' },
      high: { prefix: '[contained-high]', quality_factor: 0.12, watermark_tag: 'decoy_high' },
      distillation_guard: {
        enabled: true,
        noise_token_count: 4,
        contradiction_markers: true,
        max_extra_chars: 180
      }
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const timedLease = raw.timed_lease && typeof raw.timed_lease === 'object' ? raw.timed_lease : {};
  const staged = raw.staged_ramp && typeof raw.staged_ramp === 'object' ? raw.staged_ramp : {};
  const bounds = raw.bounds && typeof raw.bounds === 'object' ? raw.bounds : {};
  const enforcement = raw.enforcement && typeof raw.enforcement === 'object' ? raw.enforcement : {};
  const adaptive = raw.adaptive_integration && typeof raw.adaptive_integration === 'object' ? raw.adaptive_integration : {};
  const forensics = raw.forensics && typeof raw.forensics === 'object' ? raw.forensics : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const decoy = raw.decoy && typeof raw.decoy === 'object' ? raw.decoy : {};
  const decLow = decoy.low && typeof decoy.low === 'object' ? decoy.low : {};
  const decMed = decoy.medium && typeof decoy.medium === 'object' ? decoy.medium : {};
  const decHigh = decoy.high && typeof decoy.high === 'object' ? decoy.high : {};
  const decGuard = decoy.distillation_guard && typeof decoy.distillation_guard === 'object' ? decoy.distillation_guard : {};

  const trustedSources = Array.isArray(raw.trusted_sources)
    ? raw.trusted_sources.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean)
    : base.trusted_sources;
  const highValueActions = Array.isArray(raw.high_value_actions)
    ? raw.high_value_actions.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean)
    : base.high_value_actions;
  const runtimeClasses = Array.isArray(raw.runtime_fingerprint_classes)
    ? raw.runtime_fingerprint_classes.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean)
    : base.runtime_fingerprint_classes;

  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    defensive_only_invariant: toBool(raw.defensive_only_invariant, true),
    offensive_behaviors_forbidden: Array.isArray(raw.offensive_behaviors_forbidden)
      ? raw.offensive_behaviors_forbidden.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean)
      : base.offensive_behaviors_forbidden,
    trusted_sources: trustedSources.length ? trustedSources : base.trusted_sources,
    high_value_actions: highValueActions.length ? highValueActions : base.high_value_actions,
    runtime_fingerprint_classes: runtimeClasses.length ? runtimeClasses : base.runtime_fingerprint_classes,
    timed_lease: {
      stealth_window_enabled: toBool(timedLease.stealth_window_enabled, base.timed_lease.stealth_window_enabled),
      stealth_window_hours: Number(clampNumber(timedLease.stealth_window_hours, 0, 24 * 14, base.timed_lease.stealth_window_hours).toFixed(4)),
      high_value_bypass: toBool(timedLease.high_value_bypass, base.timed_lease.high_value_bypass)
    },
    staged_ramp: {
      tease_actions: clampInt(staged.tease_actions, 1, 1000, base.staged_ramp.tease_actions),
      challenge_actions: clampInt(staged.challenge_actions, 1, 1000, base.staged_ramp.challenge_actions),
      degrade_actions: clampInt(staged.degrade_actions, 1, 1000, base.staged_ramp.degrade_actions),
      lockout_actions: clampInt(staged.lockout_actions, 1, 1000, base.staged_ramp.lockout_actions),
      lockout_cooldown_minutes: clampInt(staged.lockout_cooldown_minutes, 1, 60 * 24 * 30, base.staged_ramp.lockout_cooldown_minutes)
    },
    bounds: {
      max_friction_delay_ms: clampInt(bounds.max_friction_delay_ms, 0, 20000, base.bounds.max_friction_delay_ms),
      max_challenge_score: clampNumber(bounds.max_challenge_score, 0, 1, base.bounds.max_challenge_score),
      max_lease_decay_rate: clampNumber(bounds.max_lease_decay_rate, 0, 1, base.bounds.max_lease_decay_rate),
      max_containment_children: clampInt(bounds.max_containment_children, 0, 100, base.bounds.max_containment_children)
    },
    enforcement: {
      challenge_threshold: clampNumber(
        enforcement.challenge_threshold,
        0,
        1,
        base.enforcement.challenge_threshold
      ),
      min_challenge_difficulty_bits: clampInt(
        enforcement.min_challenge_difficulty_bits,
        4,
        26,
        base.enforcement.min_challenge_difficulty_bits
      ),
      max_challenge_difficulty_bits: clampInt(
        enforcement.max_challenge_difficulty_bits,
        4,
        26,
        base.enforcement.max_challenge_difficulty_bits
      ),
      challenge_ttl_seconds: clampInt(
        enforcement.challenge_ttl_seconds,
        30,
        60 * 60,
        base.enforcement.challenge_ttl_seconds
      ),
      challenge_stages: Array.isArray(enforcement.challenge_stages)
        ? enforcement.challenge_stages.map((v: unknown) => normalizeToken(v, 40)).filter(Boolean)
        : base.enforcement.challenge_stages,
      decoy_from_stage: normalizeToken(
        enforcement.decoy_from_stage || base.enforcement.decoy_from_stage,
        40
      ) || base.enforcement.decoy_from_stage
    },
    adaptive_integration: {
      enabled: toBool(adaptive.enabled, base.adaptive_integration.enabled),
      runtime_bias_weight: clampNumber(
        adaptive.runtime_bias_weight,
        0,
        3,
        base.adaptive_integration.runtime_bias_weight
      ),
      cost_profiles_path: resolvePath(
        adaptive.cost_profiles_path,
        base.adaptive_integration.cost_profiles_path
      )
    },
    forensics: {
      enabled: toBool(forensics.enabled, base.forensics.enabled),
      include_watermark: toBool(forensics.include_watermark, base.forensics.include_watermark),
      master_conduit_mirror: toBool(forensics.master_conduit_mirror, base.forensics.master_conduit_mirror),
      evidence_dir: resolvePath(forensics.evidence_dir, base.forensics.evidence_dir),
      events_path: resolvePath(forensics.events_path, base.forensics.events_path)
    },
    paths: {
      state_root: resolvePath(paths.state_root, base.paths.state_root),
      sessions_path: resolvePath(paths.sessions_path, base.paths.sessions_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path),
      profiles_path: resolvePath(paths.profiles_path, base.paths.profiles_path),
      startup_attestation_path: resolvePath(paths.startup_attestation_path, base.paths.startup_attestation_path),
      soul_token_guard_path: resolvePath(paths.soul_token_guard_path, base.paths.soul_token_guard_path),
      lease_state_path: resolvePath(paths.lease_state_path, base.paths.lease_state_path),
      master_queue_path: resolvePath(paths.master_queue_path, base.paths.master_queue_path)
    },
    decoy: {
      low: {
        prefix: cleanText(decLow.prefix || base.decoy.low.prefix, 40) || base.decoy.low.prefix,
        quality_factor: clampNumber(decLow.quality_factor, 0.01, 1, base.decoy.low.quality_factor),
        watermark_tag: normalizeToken(decLow.watermark_tag || base.decoy.low.watermark_tag, 80) || base.decoy.low.watermark_tag
      },
      medium: {
        prefix: cleanText(decMed.prefix || base.decoy.medium.prefix, 40) || base.decoy.medium.prefix,
        quality_factor: clampNumber(decMed.quality_factor, 0.01, 1, base.decoy.medium.quality_factor),
        watermark_tag: normalizeToken(decMed.watermark_tag || base.decoy.medium.watermark_tag, 80) || base.decoy.medium.watermark_tag
      },
      high: {
        prefix: cleanText(decHigh.prefix || base.decoy.high.prefix, 40) || base.decoy.high.prefix,
        quality_factor: clampNumber(decHigh.quality_factor, 0.01, 1, base.decoy.high.quality_factor),
        watermark_tag: normalizeToken(decHigh.watermark_tag || base.decoy.high.watermark_tag, 80) || base.decoy.high.watermark_tag
      },
      distillation_guard: {
        enabled: toBool(decGuard.enabled, base.decoy.distillation_guard.enabled),
        noise_token_count: clampInt(decGuard.noise_token_count, 0, 20, base.decoy.distillation_guard.noise_token_count),
        contradiction_markers: toBool(decGuard.contradiction_markers, base.decoy.distillation_guard.contradiction_markers),
        max_extra_chars: clampInt(decGuard.max_extra_chars, 0, 1000, base.decoy.distillation_guard.max_extra_chars)
      }
    }
  };
}

function loadSessions(policy: AnyObj) {
  const payload = readJson(policy.paths.sessions_path, { sessions: {} }) || { sessions: {} };
  return payload && typeof payload === 'object' ? payload : { sessions: {} };
}

function saveSessions(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.paths.sessions_path, state || { sessions: {} });
}

function computeTrustSignals(policy: AnyObj) {
  const attestation = readJson(policy.paths.startup_attestation_path, {}) || {};
  const soul = readJson(policy.paths.soul_token_guard_path, {}) || {};
  const leaseState = readJson(policy.paths.lease_state_path, {}) || {};

  const expiresMs = parseIsoMs(attestation.expires_at);
  const signature = cleanText(attestation.signature || '', 300);
  const attestationOk = !!signature && (expiresMs == null || expiresMs > Date.now());

  const soulFingerprint = cleanText(soul.fingerprint || soul.instance_fingerprint || '', 200);
  const soulToken = cleanText(soul.token || soul.soul_token || soul.instance_token || '', 300);
  const soulOk = !!(soulFingerprint || soulToken);

  const activeLeases = Array.isArray(leaseState.active)
    ? leaseState.active
    : (leaseState.leases && typeof leaseState.leases === 'object' ? Object.values(leaseState.leases) : []);

  return {
    attestation_ok: attestationOk,
    soul_token_ok: soulOk,
    lease_count: Array.isArray(activeLeases) ? activeLeases.length : 0,
    soul_fingerprint: soulFingerprint || null,
    attestation_expires_at: attestation.expires_at || null
  };
}

function defensiveInvariantStatus(policy: AnyObj) {
  const forbidden = Array.isArray(policy.offensive_behaviors_forbidden)
    ? policy.offensive_behaviors_forbidden.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean)
    : [];
  const requires = ['external_attack', 'malware_payload', 'unbounded_compute', 'destructive_payload'];
  const missing = requires.filter((id) => !forbidden.includes(id));
  return {
    ok: policy.defensive_only_invariant === true && missing.length === 0,
    missing
  };
}

function classifyRuntime(runtimeClass: unknown, policy: AnyObj) {
  const token = normalizeToken(runtimeClass || 'unknown', 80) || 'unknown';
  const known = new Set((policy.runtime_fingerprint_classes || []).map((v: unknown) => normalizeToken(v, 80)));
  return known.has(token) ? token : 'unknown';
}

function determineUnauthorized(input: AnyObj, trust: AnyObj, policy: AnyObj) {
  if (toBool(input.unauthorized, false)) {
    return { unauthorized: true, reason: 'explicit_unauthorized_flag' };
  }
  const source = normalizeToken(input.source || 'unknown', 80) || 'unknown';
  const trusted = new Set((policy.trusted_sources || []).map((v: unknown) => normalizeToken(v, 80)));
  const action = normalizeToken(input.action || 'run', 80) || 'run';
  const highValueSet = new Set((policy.high_value_actions || []).map((v: unknown) => normalizeToken(v, 80)));
  const highValue = highValueSet.has(action);

  if (!trust.soul_token_ok || !trust.attestation_ok) {
    if (!trusted.has(source) || highValue) {
      return {
        unauthorized: true,
        reason: !trust.soul_token_ok ? 'soul_token_missing_or_invalid' : 'startup_attestation_invalid'
      };
    }
  }

  if (!trusted.has(source) && highValue) {
    return { unauthorized: true, reason: 'untrusted_source_high_value_action' };
  }

  return { unauthorized: false, reason: 'trusted_or_low_risk' };
}

function stageFromHits(hits: number, policy: AnyObj) {
  const ramp = policy.staged_ramp || {};
  if (hits >= Number(ramp.lockout_actions || 8)) return 'lockout';
  if (hits >= Number(ramp.degrade_actions || 6)) return 'degrade';
  if (hits >= Number(ramp.challenge_actions || 4)) return 'challenge';
  if (hits >= 1) return 'tease';
  return 'none';
}

function stageRank(stage: string) {
  const order: Record<string, number> = {
    none: 0,
    tease: 1,
    challenge: 2,
    degrade: 3,
    lockout: 4
  };
  return order[String(stage || 'none')] || 0;
}

function selectDecoyLevel(stage: string) {
  if (stage === 'lockout' || stage === 'degrade') return 'high';
  if (stage === 'challenge') return 'medium';
  if (stage === 'tease') return 'low';
  return 'low';
}

function applyDecoyIntensity(level: string, intensity: number) {
  if (intensity >= 1.55) return 'high';
  if (intensity >= 1.2 && level === 'low') return 'medium';
  return level;
}

function loadAdaptiveCostProfile(policy: AnyObj, runtimeClass: string) {
  const fallback = {
    challenge_multiplier: 1,
    friction_multiplier: 1,
    decoy_intensity: 1,
    source: null as string | null
  };
  if (!policy.adaptive_integration || policy.adaptive_integration.enabled !== true) return fallback;
  const payload = readJson(policy.adaptive_integration.cost_profiles_path, {});
  const fp = payload && payload.fingerprint_profiles && typeof payload.fingerprint_profiles === 'object'
    ? payload.fingerprint_profiles
    : {};
  const profile = (fp[runtimeClass] || fp.unknown || {}) as AnyObj;
  return {
    challenge_multiplier: clampNumber(profile.challenge_multiplier, 0.5, 4, 1),
    friction_multiplier: clampNumber(profile.friction_multiplier, 0.5, 4, 1),
    decoy_intensity: clampNumber(profile.decoy_intensity, 0.5, 3, 1),
    source: cleanText(policy.adaptive_integration.cost_profiles_path, 520) || null
  };
}

function computeStageProfile(stage: string, runtimeClass: string, policy: AnyObj, modifiers: AnyObj = {}) {
  const bounds = policy.bounds || {};
  const maxDelay = Number(bounds.max_friction_delay_ms || 1800);
  const maxChallenge = Number(bounds.max_challenge_score || 0.95);
  const maxDecay = Number(bounds.max_lease_decay_rate || 0.8);

  const runtimeMultiplier = runtimeClass === 'gpu_heavy'
    ? 1.25
    : runtimeClass === 'cloud_vm'
      ? 1.15
      : runtimeClass === 'containerized'
        ? 1.1
        : 1;
  const frictionMult = clampNumber(modifiers.friction_multiplier, 0.5, 4, 1);
  const challengeMult = clampNumber(modifiers.challenge_multiplier, 0.5, 4, 1);
  const decoyIntensity = clampNumber(modifiers.decoy_intensity, 0.5, 3, 1);

  if (stage === 'none') {
    return {
      stage,
      allow_exec: true,
      lockout: false,
      friction_delay_ms: 0,
      challenge_score: 0,
      lease_decay_rate: 0,
      decoy_level: 'low'
    };
  }

  if (stage === 'tease') {
    return {
      stage,
      allow_exec: true,
      lockout: false,
      friction_delay_ms: Math.round(Math.min(maxDelay, 220 * runtimeMultiplier * frictionMult)),
      challenge_score: Number(Math.min(maxChallenge, 0.2 * runtimeMultiplier * challengeMult).toFixed(4)),
      lease_decay_rate: Number(Math.min(maxDecay, 0.08 * runtimeMultiplier).toFixed(4)),
      decoy_level: applyDecoyIntensity('low', decoyIntensity)
    };
  }

  if (stage === 'challenge') {
    return {
      stage,
      allow_exec: true,
      lockout: false,
      friction_delay_ms: Math.round(Math.min(maxDelay, 700 * runtimeMultiplier * frictionMult)),
      challenge_score: Number(Math.min(maxChallenge, 0.48 * runtimeMultiplier * challengeMult).toFixed(4)),
      lease_decay_rate: Number(Math.min(maxDecay, 0.25 * runtimeMultiplier).toFixed(4)),
      decoy_level: applyDecoyIntensity('medium', decoyIntensity)
    };
  }

  if (stage === 'degrade') {
    return {
      stage,
      allow_exec: false,
      lockout: false,
      friction_delay_ms: Math.round(Math.min(maxDelay, 1200 * runtimeMultiplier * frictionMult)),
      challenge_score: Number(Math.min(maxChallenge, 0.72 * runtimeMultiplier * challengeMult).toFixed(4)),
      lease_decay_rate: Number(Math.min(maxDecay, 0.55 * runtimeMultiplier).toFixed(4)),
      decoy_level: applyDecoyIntensity('high', decoyIntensity)
    };
  }

  return {
    stage,
    allow_exec: false,
    lockout: true,
    friction_delay_ms: Math.round(Math.min(maxDelay, 1600 * runtimeMultiplier * frictionMult)),
    challenge_score: Number(Math.min(maxChallenge, 0.9 * runtimeMultiplier * challengeMult).toFixed(4)),
    lease_decay_rate: Number(Math.min(maxDecay, 0.8 * runtimeMultiplier).toFixed(4)),
    decoy_level: applyDecoyIntensity('high', decoyIntensity)
  };
}

function leadingZeroBits(hexDigest: string) {
  let bits = 0;
  for (let i = 0; i < hexDigest.length; i += 1) {
    const n = parseInt(hexDigest[i], 16);
    if (!Number.isFinite(n)) break;
    if (n === 0) {
      bits += 4;
      continue;
    }
    if ((n & 8) === 0) bits += 1; else return bits;
    if ((n & 4) === 0) bits += 1; else return bits;
    if ((n & 2) === 0) bits += 1; else return bits;
    if ((n & 1) === 0) bits += 1;
    return bits;
  }
  return bits;
}

function shouldRequireChallenge(stage: string, score: number, policy: AnyObj) {
  const cfg = policy.enforcement || {};
  const allowedStages = Array.isArray(cfg.challenge_stages)
    ? new Set(cfg.challenge_stages.map((v: unknown) => normalizeToken(v, 40)))
    : new Set(['challenge', 'degrade', 'lockout']);
  return allowedStages.has(stage) && score >= Number(cfg.challenge_threshold || 0.45);
}

function buildVerificationChallenge(input: AnyObj, policy: AnyObj) {
  const cfg = policy.enforcement || {};
  const stage = normalizeToken(input.stage || 'none', 40) || 'none';
  const challengeScore = clampNumber(input.challenge_score, 0, 1, 0);
  if (!input.unauthorized || !shouldRequireChallenge(stage, challengeScore, policy)) {
    return {
      required: false,
      nonce: null,
      difficulty_bits: 0,
      expires_at: null,
      algo: 'sha256_leading_zero_bits',
      proof_hint: null
    };
  }
  const minBits = clampInt(cfg.min_challenge_difficulty_bits, 4, 26, 10);
  const maxBitsRaw = clampInt(cfg.max_challenge_difficulty_bits, 4, 26, 20);
  const maxBits = Math.max(minBits, maxBitsRaw);
  const targetBits = clampInt(
    Math.round(minBits + (maxBits - minBits) * challengeScore),
    minBits,
    maxBits,
    minBits
  );
  const ttlSeconds = clampInt(cfg.challenge_ttl_seconds, 30, 60 * 60, 300);
  const nonceSeed = `${input.session_id}|${stage}|${input.unauthorized_hits}|${input.action}|${targetBits}`;
  const nonce = `vc_${hash16(nonceSeed)}${hash16(`${nonceSeed}|salt`)}`;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  return {
    required: true,
    nonce,
    difficulty_bits: targetBits,
    expires_at: expiresAt,
    algo: 'sha256_leading_zero_bits',
    proof_hint: `sha256("${nonce}:<proof>") must have >= ${targetBits} leading zero bits`
  };
}

function verifyChallengeProof(challenge: AnyObj, proofRaw: unknown) {
  if (!challenge || challenge.required !== true) {
    return { ok: true, reason: 'not_required', bits: 0, difficulty_bits: 0 };
  }
  const proof = cleanText(proofRaw || '', 120);
  if (!proof) return { ok: false, reason: 'missing_proof', bits: 0, difficulty_bits: Number(challenge.difficulty_bits || 0) };
  const expiresMs = parseIsoMs(challenge.expires_at);
  if (expiresMs != null && expiresMs <= Date.now()) {
    return { ok: false, reason: 'challenge_expired', bits: 0, difficulty_bits: Number(challenge.difficulty_bits || 0) };
  }
  const digest = crypto.createHash('sha256').update(`${challenge.nonce}:${proof}`, 'utf8').digest('hex');
  const bits = leadingZeroBits(digest);
  const difficulty = clampInt(challenge.difficulty_bits, 1, 40, 1);
  if (bits < difficulty) {
    return { ok: false, reason: 'insufficient_difficulty', bits, difficulty_bits: difficulty, digest };
  }
  return { ok: true, reason: 'ok', bits, difficulty_bits: difficulty, digest };
}

function solveChallengeProof(challenge: AnyObj, opts: AnyObj = {}) {
  const maxIterations = clampInt(opts.max_iterations || opts.maxIterations, 1, 8_000_000, 400_000);
  const start = clampInt(opts.start, 0, Number.MAX_SAFE_INTEGER, 0);
  for (let i = 0; i < maxIterations; i += 1) {
    const proof = String(start + i);
    const checked = verifyChallengeProof(challenge, proof);
    if (checked.ok) {
      return {
        ok: true,
        proof,
        iterations: i + 1,
        bits: checked.bits,
        difficulty_bits: checked.difficulty_bits,
        digest: checked.digest
      };
    }
  }
  return {
    ok: false,
    error: 'proof_not_found_within_iteration_budget',
    iterations: maxIterations
  };
}

function decoyPolicyForLevel(level: string, policy: AnyObj) {
  if (level === 'high') return policy.decoy.high;
  if (level === 'medium') return policy.decoy.medium;
  return policy.decoy.low;
}

function applyDistillationGuard(response: string, prompt: string, level: string, policy: AnyObj) {
  const guard = policy
    && policy.decoy
    && policy.decoy.distillation_guard
    && typeof policy.decoy.distillation_guard === 'object'
    ? policy.decoy.distillation_guard
    : null;
  if (!guard || guard.enabled !== true) return response;

  const noiseCount = clampInt(guard.noise_token_count, 0, 20, 4);
  const maxExtraChars = clampInt(guard.max_extra_chars, 0, 1000, 180);
  if (noiseCount <= 0 || maxExtraChars <= 0) return response;

  const digest = crypto.createHash('sha256').update(`${level}|${prompt}`, 'utf8').digest('hex');
  const noiseTokens = [];
  for (let i = 0; i < noiseCount; i += 1) {
    const offset = (i * 4) % 60;
    noiseTokens.push(`dn_${digest.slice(offset, offset + 4)}`);
  }
  const contradiction = guard.contradiction_markers === true
    ? ` contradictory_hints=${digest.slice(16, 20)}:${digest.slice(20, 24)}`
    : '';
  const guardSuffix = (` guard_noise=${noiseTokens.join(',')}${contradiction}`).slice(0, maxExtraChars);
  return `${response}${guardSuffix}`;
}

function generateDecoyResponse(level: string, prompt: string, policy: AnyObj) {
  const cfg = decoyPolicyForLevel(level, policy);
  const basePrompt = cleanText(prompt || 'request', 600);
  const truncated = basePrompt.slice(0, Math.max(24, Math.round(basePrompt.length * Number(cfg.quality_factor || 0.3))));
  const watermark = `${cfg.watermark_tag}_${hash16(basePrompt)}`;
  const baseResponse = `${cfg.prefix} non-authorized lane: limited fidelity response. summary=${truncated || 'n/a'} watermark=${watermark}`;
  return {
    level,
    response: applyDistillationGuard(baseResponse, basePrompt, level, policy),
    watermark
  };
}

function writeForensicEvidence(policy: AnyObj, event: AnyObj) {
  if (!policy.forensics || policy.forensics.enabled !== true) return null;
  const eventId = `venom_evt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const evidence = {
    type: 'venom_forensic_bundle',
    schema_version: '1.0',
    ts: nowIso(),
    event_id: eventId,
    event,
    containment_watermark: `venom_${hash16(JSON.stringify(event))}`,
    legal_evidence_ready: true
  };

  const fp = path.join(policy.forensics.evidence_dir, `${eventId}.json`);
  writeJsonAtomic(fp, evidence);
  appendJsonl(policy.forensics.events_path, evidence);

  if (policy.forensics.master_conduit_mirror === true) {
    appendJsonl(policy.paths.master_queue_path, {
      ts: evidence.ts,
      type: 'master_training_conduit_ingest',
      lane: 'venom_forensics',
      source: 'venom_containment_layer',
      payload: {
        event_id: eventId,
        watermark: evidence.containment_watermark,
        unauthorized: event.unauthorized === true,
        stage: event.stage || 'none',
        runtime_class: event.runtime_class || 'unknown'
      }
    });
  }

  return {
    event_id: eventId,
    evidence_path: fp
  };
}

function loadProfiles(policy: AnyObj) {
  const fallback = {
    schema_version: '1.0',
    updated_at: null,
    runtime_bias: {
      unknown: 1,
      desktop: 1,
      cloud_vm: 1,
      gpu_heavy: 1,
      containerized: 1
    },
    last_uplift: 0
  };
  return readJson(policy.paths.profiles_path, fallback) || fallback;
}

function evolveProfiles(policy: AnyObj) {
  const history = readJsonl(policy.paths.history_path)
    .filter((row) => row && row.type === 'venom_containment_evaluation' && row.unauthorized === true)
    .slice(-400);

  const counts: Record<string, number> = {
    unknown: 0,
    desktop: 0,
    cloud_vm: 0,
    gpu_heavy: 0,
    containerized: 0
  };

  let total = 0;
  for (const row of history) {
    const klass = classifyRuntime(row.runtime_class || 'unknown', policy);
    counts[klass] = (counts[klass] || 0) + 1;
    total += 1;
  }

  const profiles = loadProfiles(policy);
  const runtimeBias = { ...profiles.runtime_bias };
  for (const key of Object.keys(counts)) {
    const ratio = total > 0 ? counts[key] / total : 0;
    const next = 1 + Math.min(0.85, ratio * 0.9);
    runtimeBias[key] = Number(next.toFixed(4));
  }

  const uplift = total > 0
    ? Number((history.filter((row) => row.stage === 'lockout' || row.stage === 'degrade').length / total).toFixed(4))
    : 0;

  const out = {
    schema_version: '1.0',
    updated_at: nowIso(),
    sample_size: total,
    runtime_bias: runtimeBias,
    last_uplift: uplift
  };
  writeJsonAtomic(policy.paths.profiles_path, out);
  return out;
}

function evaluateContainment(input: AnyObj = {}, opts: AnyObj = {}) {
  const policy = opts.policy || loadPolicy(opts.policyPath || DEFAULT_POLICY_PATH);
  const ts = nowIso();

  const invariant = defensiveInvariantStatus(policy);
  if (!invariant.ok) {
    return {
      ok: false,
      type: 'venom_containment_evaluation',
      ts,
      error: 'defensive_only_invariant_violation',
      missing_invariants: invariant.missing
    };
  }

  if (policy.enabled !== true) {
    return {
      ok: true,
      type: 'venom_containment_evaluation',
      ts,
      enabled: false,
      reason: 'venom_disabled',
      allow_exec: true,
      contained: false,
      stage: 'none'
    };
  }

  const trust = computeTrustSignals(policy);
  const unauthorizedEval = determineUnauthorized(input, trust, policy);
  const runtimeClass = classifyRuntime(input.runtime_class || input.runtimeClass || 'unknown', policy);
  const evolvedProfiles = loadProfiles(policy);
  const rawRuntimeBias = Number(
    evolvedProfiles
      && evolvedProfiles.runtime_bias
      && typeof evolvedProfiles.runtime_bias === 'object'
      ? evolvedProfiles.runtime_bias[runtimeClass]
      : 1
  );
  const runtimeBias = clampNumber(rawRuntimeBias, 0.5, 2.5, 1);
  const adaptiveWeight = clampNumber(
    policy.adaptive_integration && policy.adaptive_integration.runtime_bias_weight,
    0,
    3,
    1
  );
  const adaptiveCost = loadAdaptiveCostProfile(policy, runtimeClass);
  const frictionMultiplier = clampNumber(runtimeBias * adaptiveWeight * Number(adaptiveCost.friction_multiplier || 1), 0.5, 6, 1);
  const challengeMultiplier = clampNumber(runtimeBias * adaptiveWeight * Number(adaptiveCost.challenge_multiplier || 1), 0.5, 6, 1);
  const decoyIntensity = clampNumber(Number(adaptiveCost.decoy_intensity || 1), 0.5, 3, 1);
  const action = normalizeToken(input.action || 'run', 80) || 'run';
  const riskTier = normalizeToken(input.risk || input.risk_tier || 'low', 40) || 'low';
  const sessionId = normalizeToken(input.session_id || input.session || input.request_id || `anon_${hash16(`${Date.now()}_${Math.random()}`)}`, 160) || `anon_${hash16(`${Date.now()}_${Math.random()}`)}`;
  const source = normalizeToken(input.source || 'unknown', 80) || 'unknown';

  const sessions = loadSessions(policy);
  const prior = sessions.sessions && typeof sessions.sessions === 'object'
    ? (sessions.sessions[sessionId] || null)
    : null;

  const highValueSet = new Set((policy.high_value_actions || []).map((v: unknown) => normalizeToken(v, 80)));
  const isHighValue = highValueSet.has(action);

  const lockoutUntilMs = prior && prior.lockout_until_ts ? parseIsoMs(prior.lockout_until_ts) : null;
  const lockoutActive = lockoutUntilMs != null && lockoutUntilMs > Date.now();

  const timedLease = policy.timed_lease || {};
  const stealthWindowMs = Math.max(0, Number(timedLease.stealth_window_hours || 0) * 60 * 60 * 1000);
  const priorFirstUnauthorizedMs = prior && prior.first_unauthorized_ts ? parseIsoMs(prior.first_unauthorized_ts) : null;
  const firstUnauthorizedMs = unauthorizedEval.unauthorized
    ? (priorFirstUnauthorizedMs != null ? priorFirstUnauthorizedMs : Date.now())
    : priorFirstUnauthorizedMs;
  const stealthWindowEnabled = timedLease.stealth_window_enabled === true && stealthWindowMs > 0;
  const stealthWindowUntilMs = firstUnauthorizedMs != null && stealthWindowEnabled
    ? firstUnauthorizedMs + stealthWindowMs
    : null;
  const stealthWindowActive = unauthorizedEval.unauthorized
    && !lockoutActive
    && stealthWindowUntilMs != null
    && stealthWindowUntilMs > Date.now()
    && !(isHighValue && timedLease.high_value_bypass === true);

  const unauthorizedHits = (prior && Number(prior.unauthorized_hits || 0))
    + (unauthorizedEval.unauthorized && !stealthWindowActive ? 1 : 0);
  const highValueHits = (prior && Number(prior.high_value_hits || 0))
    + (unauthorizedEval.unauthorized && isHighValue && !stealthWindowActive ? 1 : 0);

  let stage = lockoutActive ? 'lockout' : stageFromHits(unauthorizedHits, policy);
  if (stealthWindowActive && !lockoutActive) stage = 'tease';
  const profile = computeStageProfile(stealthWindowActive ? 'none' : stage, runtimeClass, policy, {
    friction_multiplier: frictionMultiplier,
    challenge_multiplier: challengeMultiplier,
    decoy_intensity: decoyIntensity
  });

  const finalAllowExec = unauthorizedEval.unauthorized
    ? (profile.allow_exec === true && !lockoutActive && !(isHighValue && stage !== 'tease'))
    : true;

  const lockout = lockoutActive || profile.lockout === true;
  const ramp = policy.staged_ramp || {};
  const lockoutUntilTs = lockout
    ? new Date(Date.now() + Number(ramp.lockout_cooldown_minutes || 720) * 60 * 1000).toISOString()
    : null;

  const decoyLevel = profile.decoy_level || selectDecoyLevel(stage);
  const decoy = generateDecoyResponse(decoyLevel, cleanText(input.prompt || input.summary || action, 600), policy);
  const challenge = buildVerificationChallenge({
    unauthorized: unauthorizedEval.unauthorized,
    stage,
    challenge_score: profile.challenge_score,
    session_id: sessionId,
    unauthorized_hits: unauthorizedHits,
    action
  }, policy);
  const decoyFromStage = normalizeToken(policy.enforcement && policy.enforcement.decoy_from_stage || 'challenge', 40) || 'challenge';
  const outputMode = unauthorizedEval.unauthorized && stageRank(stage) >= stageRank(decoyFromStage)
    ? 'decoy_only'
    : 'passthrough';

  const result = {
    ok: true,
    type: 'venom_containment_evaluation',
    ts,
    session_id: sessionId,
    source,
    action,
    risk_tier: riskTier,
    runtime_class: runtimeClass,
    enabled: true,
    shadow_only: policy.shadow_only === true,
    unauthorized: unauthorizedEval.unauthorized,
    unauthorized_reason: unauthorizedEval.reason,
    trust,
    stage,
    contained: unauthorizedEval.unauthorized,
    allow_exec: finalAllowExec,
    lockout,
    friction_delay_ms: Number(profile.friction_delay_ms || 0),
    enforced_friction_delay_ms: unauthorizedEval.unauthorized ? Number(profile.friction_delay_ms || 0) : 0,
    challenge_score: Number(profile.challenge_score || 0),
    lease_decay_rate: Number(profile.lease_decay_rate || 0),
    decoy_level: decoyLevel,
    decoy_response: decoy.response,
    decoy_watermark: decoy.watermark,
    enforce_output_mode: outputMode,
    verification_challenge: challenge,
    timed_lease_stealth_active: stealthWindowActive,
    timed_lease_stealth_until_ts: stealthWindowUntilMs != null ? new Date(stealthWindowUntilMs).toISOString() : null,
    unauthorized_hits: unauthorizedHits,
    high_value_hits: highValueHits,
    adaptive_runtime_bias: Number(runtimeBias.toFixed(4)),
    adaptive_runtime_bias_weight: Number(adaptiveWeight.toFixed(4)),
    adaptive_cost_profile: {
      challenge_multiplier: Number(clampNumber(adaptiveCost.challenge_multiplier, 0.5, 4, 1).toFixed(4)),
      friction_multiplier: Number(clampNumber(adaptiveCost.friction_multiplier, 0.5, 4, 1).toFixed(4)),
      decoy_intensity: Number(clampNumber(adaptiveCost.decoy_intensity, 0.5, 3, 1).toFixed(4)),
      source: adaptiveCost.source || null
    },
    policy_path: relPath(opts.policyPath || DEFAULT_POLICY_PATH)
  };

  const persist = opts.persist !== false;
  if (persist) {
    const nextSession = {
      session_id: sessionId,
      first_seen_ts: prior && prior.first_seen_ts ? prior.first_seen_ts : ts,
      last_seen_ts: ts,
      source,
      runtime_class: runtimeClass,
      unauthorized_hits: unauthorizedHits,
      high_value_hits: highValueHits,
      first_unauthorized_ts: firstUnauthorizedMs != null ? new Date(firstUnauthorizedMs).toISOString() : null,
      stealth_window_until_ts: stealthWindowUntilMs != null ? new Date(stealthWindowUntilMs).toISOString() : null,
      stage,
      lockout_until_ts: lockoutUntilTs,
      children_spawned: Number(prior && prior.children_spawned || 0)
    };
    if (!sessions.sessions || typeof sessions.sessions !== 'object') sessions.sessions = {};
    sessions.sessions[sessionId] = nextSession;
    saveSessions(policy, sessions);

    appendJsonl(policy.paths.history_path, result);
    writeJsonAtomic(policy.paths.latest_path, result);

    if (unauthorizedEval.unauthorized) {
      const evidenceMeta = writeForensicEvidence(policy, result);
      if (evidenceMeta) {
        result.forensic_event_id = evidenceMeta.event_id;
        result.forensic_evidence_path = relPath(evidenceMeta.evidence_path);
        writeJsonAtomic(policy.paths.latest_path, result);
      }
    }
  }

  return result;
}

function statusVenom(policyPath?: string) {
  const policy = loadPolicy(policyPath || DEFAULT_POLICY_PATH);
  const latest = readJson(policy.paths.latest_path, null);
  const sessions = loadSessions(policy);
  const profiles = loadProfiles(policy);
  const sessionRows = sessions.sessions && typeof sessions.sessions === 'object'
    ? Object.values(sessions.sessions)
    : [];
  const activeLockouts = sessionRows.filter((row: any) => {
    const ms = parseIsoMs(row && row.lockout_until_ts);
    return ms != null && ms > Date.now();
  }).length;

  return {
    ok: true,
    type: 'venom_containment_status',
    ts: nowIso(),
    enabled: policy.enabled === true,
    shadow_only: policy.shadow_only === true,
    defensive_only_invariant: defensiveInvariantStatus(policy),
    tracked_sessions: sessionRows.length,
    active_lockouts: activeLockouts,
    last_stage: latest && latest.stage ? latest.stage : 'none',
    last_unauthorized: latest && latest.unauthorized === true,
    profiles,
    latest_path: relPath(policy.paths.latest_path),
    history_path: relPath(policy.paths.history_path),
    events_path: relPath(policy.forensics.events_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/venom_containment_layer.js evaluate [--session-id=id] [--source=local] [--action=run] [--risk=low] [--runtime-class=desktop] [--unauthorized=0|1] [--apply=0|1] [--prompt=text]');
  console.log('  node systems/security/venom_containment_layer.js decoy --level=low --prompt="text"');
  console.log('  node systems/security/venom_containment_layer.js solve-challenge --nonce=<token> --difficulty-bits=<n> [--max-iterations=<n>] [--start=<n>]');
  console.log('  node systems/security/venom_containment_layer.js evolve');
  console.log('  node systems/security/venom_containment_layer.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  const policyPath = args.policy || process.env.VENOM_CONTAINMENT_POLICY_PATH || DEFAULT_POLICY_PATH;

  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    return;
  }

  if (cmd === 'evaluate') {
    const out = evaluateContainment({
      session_id: args['session-id'] || args.session_id,
      source: args.source || 'unknown',
      action: args.action || 'run',
      risk: args.risk || args['risk-tier'] || args.risk_tier,
      runtime_class: args['runtime-class'] || args.runtime_class || 'unknown',
      unauthorized: args.unauthorized,
      prompt: args.prompt || args.summary || ''
    }, {
      policyPath,
      persist: true
    });

    process.stdout.write(`${JSON.stringify(out)}\n`);
    const apply = toBool(args.apply, false);
    if (apply && out.ok && out.shadow_only !== true && out.allow_exec !== true) {
      process.exitCode = 3;
    }
    return;
  }

  if (cmd === 'decoy') {
    const policy = loadPolicy(policyPath);
    const level = normalizeToken(args.level || 'low', 20) || 'low';
    const out = {
      ok: true,
      type: 'venom_decoy_preview',
      ts: nowIso(),
      ...generateDecoyResponse(level, cleanText(args.prompt || 'request', 600), policy)
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }

  if (cmd === 'solve-challenge') {
    const challenge = {
      required: true,
      nonce: cleanText(args.nonce || '', 120),
      difficulty_bits: clampInt(args['difficulty-bits'] || args.difficulty_bits, 1, 40, 1),
      expires_at: args.expires_at ? cleanText(args.expires_at, 80) : null
    };
    if (!challenge.nonce) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        type: 'venom_solve_challenge',
        error: 'missing_nonce'
      })}\n`);
      process.exitCode = 2;
      return;
    }
    const solved = solveChallengeProof(challenge, {
      max_iterations: args['max-iterations'] || args.max_iterations,
      start: args.start
    });
    process.stdout.write(`${JSON.stringify({
      type: 'venom_solve_challenge',
      nonce: challenge.nonce,
      difficulty_bits: challenge.difficulty_bits,
      ...solved
    })}\n`);
    if (!solved.ok) process.exitCode = 1;
    return;
  }

  if (cmd === 'evolve') {
    const policy = loadPolicy(policyPath);
    const evolved = evolveProfiles(policy);
    const out = {
      ok: true,
      type: 'venom_containment_evolve',
      ts: nowIso(),
      policy_path: relPath(policyPath),
      evolved
    };
    appendJsonl(policy.paths.history_path, {
      ts: out.ts,
      type: out.type,
      evolved_sample_size: Number(evolved.sample_size || 0),
      last_uplift: Number(evolved.last_uplift || 0)
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }

  if (cmd === 'status') {
    process.stdout.write(`${JSON.stringify(statusVenom(policyPath))}\n`);
    return;
  }

  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'venom_containment_layer',
      error: cleanText(err && (err as AnyObj).message ? (err as AnyObj).message : err || 'venom_containment_failed', 260)
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  evaluateContainment,
  generateDecoyResponse,
  verifyChallengeProof,
  solveChallengeProof,
  evolveProfiles,
  statusVenom
};
