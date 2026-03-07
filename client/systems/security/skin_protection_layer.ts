#!/usr/bin/env node
'use strict';
export {};

/**
 * skin_protection_layer.js
 *
 * Selective Copying Hardening (SKIN) orchestration lane:
 * - Contract-coupled defense mesh verification for critical lanes.
 * - Runtime tamper attestation checks (integrity + heartbeat posture).
 * - Binary hardening profile and anti-RE telemetry posture checks.
 * - Deterministic stasis/containment state transitions.
 *
 * Usage:
 *   node systems/security/skin_protection_layer.js verify [--lane=global] [--context-json='{}'] [--strict=1]
 *   node systems/security/skin_protection_layer.js enforce [--lane=execution_primitive] [--context-json='{}'] [--strict=1]
 *   node systems/security/skin_protection_layer.js status
 *   node systems/security/skin_protection_layer.js clear-stasis [--reason=manual_release]
 */

const fs = require('fs');
const path = require('path');
const {
  verifyIntegrity,
  DEFAULT_POLICY_PATH: DEFAULT_INTEGRITY_POLICY_PATH
} = require('../../lib/security_integrity');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.SKIN_PROTECTION_POLICY_PATH
  ? path.resolve(process.env.SKIN_PROTECTION_POLICY_PATH)
  : path.join(ROOT, 'config', 'skin_protection_policy.json');

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

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function parseIsoMs(v: unknown): number | null {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function parseJsonArg(raw: unknown, fallback: AnyObj = {}) {
  if (raw == null || raw === '') return fallback;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    auto_stasis_on_fail: true,
    contract_mesh: {
      required_by_lane: {
        global: [],
        state_kernel: ['integrity_attestation_id', 'helix_tier', 'sentinel_tier'],
        proposal_gating: ['soul_token_attestation', 'startup_attestation', 'risk_receipt_id'],
        execution_primitive: ['safety_attestation', 'rollback_receipt', 'guard_receipt_id'],
        memory_traversal: ['memory_policy_receipt', 'directive_hash', 'query_scope']
      }
    },
    runtime_attestation: {
      enabled: true,
      integrity_policy_path: DEFAULT_INTEGRITY_POLICY_PATH,
      heartbeat_latest_path: 'state/security/remote_tamper_heartbeat/latest.json',
      heartbeat_quarantine_path: 'state/security/remote_tamper_heartbeat/quarantine.json',
      max_heartbeat_age_sec: 180,
      require_heartbeat_quarantine_alignment: true
    },
    binary_hardening: {
      enabled: true,
      require_hardened_artifact: true,
      min_obfuscation_tier: 'light',
      allowed_tiers: ['light', 'medium', 'hard'],
      binary_artifacts_path: 'state/ops/binary_runtime_hardening/artifacts.json',
      binary_receipts_path: 'state/ops/binary_runtime_hardening/receipts.jsonl',
      max_anti_debug_false_positives_per_day: 24
    },
    paths: {
      latest_path: 'state/security/skin_protection/latest.json',
      history_path: 'state/security/skin_protection/history.jsonl',
      stasis_state_path: 'state/security/skin_protection/stasis_state.json'
    }
  };
}

function normalizeRequiredByLane(raw: AnyObj, base: AnyObj) {
  const out: AnyObj = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  const allLanes = new Set([
    ...Object.keys(base || {}),
    ...Object.keys(src || {})
  ]);
  for (const lane of allLanes) {
    const normalizedLane = normalizeToken(lane, 80) || lane;
    const list = Array.isArray(src[lane]) ? src[lane] : (Array.isArray(base[lane]) ? base[lane] : []);
    out[normalizedLane] = list.map((v: unknown) => normalizeToken(v, 120)).filter(Boolean);
  }
  if (!out.global) out.global = [];
  return out;
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const rawContract = raw.contract_mesh && typeof raw.contract_mesh === 'object' ? raw.contract_mesh : {};
  const rawRuntime = raw.runtime_attestation && typeof raw.runtime_attestation === 'object' ? raw.runtime_attestation : {};
  const rawBinary = raw.binary_hardening && typeof raw.binary_hardening === 'object' ? raw.binary_hardening : {};
  const rawPaths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};

  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: toBool(raw.enabled, base.enabled),
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    auto_stasis_on_fail: toBool(raw.auto_stasis_on_fail, base.auto_stasis_on_fail),
    contract_mesh: {
      required_by_lane: normalizeRequiredByLane(rawContract.required_by_lane, base.contract_mesh.required_by_lane)
    },
    runtime_attestation: {
      enabled: toBool(rawRuntime.enabled, base.runtime_attestation.enabled),
      integrity_policy_path: resolvePath(rawRuntime.integrity_policy_path, String(base.runtime_attestation.integrity_policy_path)),
      heartbeat_latest_path: resolvePath(rawRuntime.heartbeat_latest_path, base.runtime_attestation.heartbeat_latest_path),
      heartbeat_quarantine_path: resolvePath(rawRuntime.heartbeat_quarantine_path, base.runtime_attestation.heartbeat_quarantine_path),
      max_heartbeat_age_sec: clampInt(rawRuntime.max_heartbeat_age_sec, 10, 24 * 60 * 60, base.runtime_attestation.max_heartbeat_age_sec),
      require_heartbeat_quarantine_alignment: toBool(
        rawRuntime.require_heartbeat_quarantine_alignment,
        base.runtime_attestation.require_heartbeat_quarantine_alignment
      )
    },
    binary_hardening: {
      enabled: toBool(rawBinary.enabled, base.binary_hardening.enabled),
      require_hardened_artifact: toBool(rawBinary.require_hardened_artifact, base.binary_hardening.require_hardened_artifact),
      min_obfuscation_tier: normalizeToken(rawBinary.min_obfuscation_tier || base.binary_hardening.min_obfuscation_tier, 24)
        || base.binary_hardening.min_obfuscation_tier,
      allowed_tiers: (
        Array.isArray(rawBinary.allowed_tiers) && rawBinary.allowed_tiers.length
          ? rawBinary.allowed_tiers
          : base.binary_hardening.allowed_tiers
      ).map((v: unknown) => normalizeToken(v, 24)).filter(Boolean),
      binary_artifacts_path: resolvePath(rawBinary.binary_artifacts_path, base.binary_hardening.binary_artifacts_path),
      binary_receipts_path: resolvePath(rawBinary.binary_receipts_path, base.binary_hardening.binary_receipts_path),
      max_anti_debug_false_positives_per_day: clampInt(
        rawBinary.max_anti_debug_false_positives_per_day,
        0,
        5000,
        base.binary_hardening.max_anti_debug_false_positives_per_day
      )
    },
    paths: {
      latest_path: resolvePath(rawPaths.latest_path, base.paths.latest_path),
      history_path: resolvePath(rawPaths.history_path, base.paths.history_path),
      stasis_state_path: resolvePath(rawPaths.stasis_state_path, base.paths.stasis_state_path)
    },
    policy_path: resolvePath(policyPath, DEFAULT_POLICY_PATH)
  };
}

function loadStasisState(policy: AnyObj) {
  const fallback = {
    schema_id: 'skin_protection_stasis_state',
    schema_version: '1.0',
    active: false,
    reason: null,
    activated_at: null,
    released_at: null,
    source: null
  };
  return readJson(policy.paths.stasis_state_path, fallback) || fallback;
}

function saveStasisState(policy: AnyObj, patch: AnyObj = {}) {
  const prior = loadStasisState(policy);
  const next = {
    ...prior,
    ...patch,
    schema_id: 'skin_protection_stasis_state',
    schema_version: '1.0',
    updated_at: nowIso()
  };
  writeJsonAtomic(policy.paths.stasis_state_path, next);
  return next;
}

function evaluateContractMesh(policy: AnyObj, laneRaw: unknown, contextRaw: AnyObj = {}) {
  const lane = normalizeToken(laneRaw || 'global', 80) || 'global';
  const requiredByLane = policy.contract_mesh && policy.contract_mesh.required_by_lane
    ? policy.contract_mesh.required_by_lane
    : {};
  const required = Array.isArray(requiredByLane[lane])
    ? requiredByLane[lane]
    : (Array.isArray(requiredByLane.global) ? requiredByLane.global : []);
  const context = contextRaw && typeof contextRaw === 'object' ? contextRaw : {};
  const missing = [];
  for (const key of required) {
    const val = cleanText(context[key], 260);
    if (!val) missing.push(key);
  }
  return {
    enabled: true,
    lane,
    required,
    missing,
    pass: missing.length === 0
  };
}

function evaluateRuntimeAttestation(policy: AnyObj) {
  const rt = policy.runtime_attestation || {};
  if (rt.enabled !== true) {
    return {
      enabled: false,
      pass: true,
      reasons: []
    };
  }

  const reasons = [];
  let integrityResult: AnyObj = { ok: true, violation_counts: {} };
  try {
    integrityResult = verifyIntegrity(rt.integrity_policy_path);
  } catch {
    integrityResult = { ok: false, violation_counts: { integrity_probe_exception: 1 } };
  }
  if (integrityResult.ok !== true) reasons.push('integrity_probe_failed');

  const latest = readJson(rt.heartbeat_latest_path, null);
  const quarantine = readJson(rt.heartbeat_quarantine_path, { active: false }) || { active: false };
  if (!latest || typeof latest !== 'object') reasons.push('heartbeat_missing');

  let heartbeatAgeSec: number | null = null;
  if (latest && latest.ts) {
    const tsMs = parseIsoMs(latest.ts);
    if (tsMs != null) heartbeatAgeSec = Math.max(0, Math.floor((Date.now() - tsMs) / 1000));
  }
  if (heartbeatAgeSec != null && heartbeatAgeSec > Number(rt.max_heartbeat_age_sec || 180)) {
    reasons.push('heartbeat_stale');
  }
  if (latest && latest.integrity_ok === false) reasons.push('heartbeat_integrity_flag_failed');
  if (latest && latest.anomaly === true && rt.require_heartbeat_quarantine_alignment === true && quarantine.active !== true) {
    reasons.push('heartbeat_anomaly_without_quarantine');
  }

  return {
    enabled: true,
    pass: reasons.length === 0,
    reasons,
    heartbeat_age_sec: heartbeatAgeSec,
    latest_heartbeat_id: latest && latest.heartbeat_id ? cleanText(latest.heartbeat_id, 120) : null,
    quarantine_active: quarantine.active === true,
    integrity_ok: integrityResult.ok === true,
    integrity_violation_counts: integrityResult.violation_counts || {}
  };
}

function parseTier(rawTier: unknown, fallback = 'none') {
  const token = normalizeToken(rawTier, 32) || '';
  if (['none', 'light', 'medium', 'hard'].includes(token)) return token;
  if (token.startsWith('hardened_')) {
    const suffix = token.slice('hardened_'.length);
    if (['none', 'light', 'medium', 'hard'].includes(suffix)) return suffix;
  }
  return fallback;
}

function tierRank(tier: string) {
  if (tier === 'hard') return 3;
  if (tier === 'medium') return 2;
  if (tier === 'light') return 1;
  return 0;
}

function evaluateBinaryHardening(policy: AnyObj) {
  const bh = policy.binary_hardening || {};
  if (bh.enabled !== true) {
    return {
      enabled: false,
      pass: true,
      reasons: []
    };
  }

  const reasons = [];
  const artifacts = readJson(bh.binary_artifacts_path, {}) || {};
  const activeTier = parseTier(artifacts.tier || artifacts.obfuscation_profile, 'none');
  const minTier = parseTier(bh.min_obfuscation_tier || 'light', 'light');
  const allowed = Array.isArray(bh.allowed_tiers) ? bh.allowed_tiers : ['light', 'medium', 'hard'];
  const allowedSet = new Set(allowed.map((v: unknown) => parseTier(v, 'none')));

  if (bh.require_hardened_artifact === true) {
    if (!allowedSet.has(activeTier) || tierRank(activeTier) < tierRank(minTier)) {
      reasons.push('obfuscation_tier_below_minimum');
    }
  }

  const dayCutoff = Date.now() - (24 * 60 * 60 * 1000);
  const receipts = readJsonl(bh.binary_receipts_path).slice(-2000);
  let antiDebugHits24h = 0;
  for (const row of receipts) {
    const tsMs = parseIsoMs(row && row.ts);
    if (tsMs == null || tsMs < dayCutoff) continue;
    if (String(row && row.type || '') !== 'binary_tamper_check') continue;
    const hits = Array.isArray(row.anti_debug_hits) ? row.anti_debug_hits : [];
    if (hits.length > 0) antiDebugHits24h += 1;
  }
  const maxBudget = clampInt(bh.max_anti_debug_false_positives_per_day, 0, 5000, 24);
  if (antiDebugHits24h > maxBudget) reasons.push('anti_debug_false_positive_budget_exceeded');

  return {
    enabled: true,
    pass: reasons.length === 0,
    reasons,
    active_obfuscation_tier: activeTier,
    minimum_obfuscation_tier: minTier,
    anti_debug_events_24h: antiDebugHits24h,
    anti_debug_budget_24h: maxBudget
  };
}

function verifySkinProtection(input: AnyObj = {}, opts: AnyObj = {}) {
  const policy = opts.policy || loadPolicy(opts.policyPath || DEFAULT_POLICY_PATH);
  const ts = nowIso();
  if (policy.enabled !== true) {
    return {
      ok: true,
      blocked: false,
      type: 'skin_protection_verify',
      ts,
      enabled: false,
      reason: 'skin_protection_disabled'
    };
  }

  const lane = normalizeToken(input.lane || 'global', 80) || 'global';
  const context = input.context && typeof input.context === 'object' ? input.context : {};
  const stasis = loadStasisState(policy);
  const contract = evaluateContractMesh(policy, lane, context);
  const runtime = evaluateRuntimeAttestation(policy);
  const binary = evaluateBinaryHardening(policy);

  const failReasons = [];
  if (stasis.active === true) failReasons.push('stasis_active');
  if (!contract.pass) failReasons.push('contract_mesh_failed');
  if (!runtime.pass) failReasons.push('runtime_attestation_failed');
  if (!binary.pass) failReasons.push('binary_hardening_failed');

  const applyContainmentRequested = toBool(opts.applyContainment, false);
  const allowAutoContainment = toBool(opts.allowAutoContainment, true);
  const shouldApplyContainment = failReasons.length > 0
    && stasis.active !== true
    && (
      applyContainmentRequested
      || (allowAutoContainment && policy.auto_stasis_on_fail === true && policy.shadow_only !== true)
    );
  let containmentApplied = false;
  let nextStasis = stasis;
  if (shouldApplyContainment) {
    nextStasis = saveStasisState(policy, {
      active: true,
      reason: failReasons.join('|') || 'skin_check_failed',
      activated_at: nowIso(),
      released_at: null,
      source: cleanText(input.source || input.lane || 'skin_verify', 120)
    });
    containmentApplied = true;
  }

  const blocked = nextStasis.active === true || (failReasons.length > 0 && policy.shadow_only !== true);
  const result = {
    ok: !blocked,
    blocked,
    type: 'skin_protection_verify',
    ts,
    enabled: true,
    shadow_only: policy.shadow_only === true,
    lane,
    fail_reasons: Array.from(new Set(failReasons)),
    checks: {
      contract_mesh: contract,
      runtime_attestation: runtime,
      binary_hardening: binary
    },
    stasis: {
      active: nextStasis.active === true,
      reason: nextStasis.reason || null,
      activated_at: nextStasis.activated_at || null,
      containment_applied: containmentApplied
    },
    policy_path: relPath(opts.policyPath || DEFAULT_POLICY_PATH)
  };

  const persist = opts.persist !== false;
  if (persist) {
    writeJsonAtomic(policy.paths.latest_path, result);
    appendJsonl(policy.paths.history_path, result);
  }

  return result;
}

function statusSkin(policyPath?: string) {
  const policy = loadPolicy(policyPath || DEFAULT_POLICY_PATH);
  const latest = readJson(policy.paths.latest_path, null);
  const stasis = loadStasisState(policy);
  return {
    ok: true,
    type: 'skin_protection_status',
    ts: nowIso(),
    enabled: policy.enabled === true,
    shadow_only: policy.shadow_only === true,
    stasis,
    latest,
    paths: {
      latest_path: relPath(policy.paths.latest_path),
      history_path: relPath(policy.paths.history_path),
      stasis_state_path: relPath(policy.paths.stasis_state_path)
    }
  };
}

function clearStasis(policyPath: string, reason: unknown) {
  const policy = loadPolicy(policyPath || DEFAULT_POLICY_PATH);
  const next = saveStasisState(policy, {
    active: false,
    reason: cleanText(reason || 'manual_release', 180) || 'manual_release',
    released_at: nowIso()
  });
  const out = {
    ok: true,
    type: 'skin_protection_clear_stasis',
    ts: nowIso(),
    stasis: next
  };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.history_path, out);
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/skin_protection_layer.js verify [--lane=global] [--context-json=\'{}\'] [--strict=1]');
  console.log('  node systems/security/skin_protection_layer.js enforce [--lane=execution_primitive] [--context-json=\'{}\'] [--strict=1]');
  console.log('  node systems/security/skin_protection_layer.js status');
  console.log('  node systems/security/skin_protection_layer.js clear-stasis [--reason=manual_release]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  const policyPath = args.policy || process.env.SKIN_PROTECTION_POLICY_PATH || DEFAULT_POLICY_PATH;
  const strict = toBool(args.strict, false);

  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    return;
  }

  if (cmd === 'verify' || cmd === 'enforce') {
    const out = verifySkinProtection({
      lane: args.lane || 'global',
      context: parseJsonArg(args['context-json'] || args.context_json, {}),
      source: cmd
    }, {
      policyPath,
      persist: true,
      applyContainment: cmd === 'enforce',
      allowAutoContainment: cmd === 'enforce'
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    if (strict && out.ok !== true) process.exitCode = 1;
    return;
  }

  if (cmd === 'status') {
    process.stdout.write(`${JSON.stringify(statusSkin(policyPath))}\n`);
    return;
  }

  if (cmd === 'clear-stasis') {
    process.stdout.write(`${JSON.stringify(clearStasis(policyPath, args.reason))}\n`);
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
      type: 'skin_protection_layer',
      error: cleanText(err && (err as AnyObj).message ? (err as AnyObj).message : err || 'skin_protection_failed', 260)
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  loadStasisState,
  verifySkinProtection,
  statusSkin
};
