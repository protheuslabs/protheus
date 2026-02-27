#!/usr/bin/env node
'use strict';
export {};

/**
 * confirmed_malice_quarantine.js
 *
 * V3-033: permanent quarantine lane for confirmed hostile copies.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.HELIX_CONFIRMED_MALICE_POLICY_PATH
  ? path.resolve(String(process.env.HELIX_CONFIRMED_MALICE_POLICY_PATH))
  : path.join(ROOT, 'config', 'confirmed_malice_quarantine_policy.json');

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

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[String(tok || '').slice(2, idx)] = String(tok || '').slice(idx + 1);
      continue;
    }
    const key = String(tok || '').slice(2);
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

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(baseRoot: string, raw: unknown, fallback: string) {
  const text = cleanText(raw || fallback, 320) || fallback;
  return path.isAbsolute(text) ? path.resolve(text) : path.join(baseRoot, text);
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: false,
    require_sentinel_confirmed_malice: true,
    require_hunter_isolation_signal: true,
    release_requires_human: true,
    thresholds: {
      min_independent_signals_for_permanent_quarantine: 2,
      min_confidence_for_permanent_quarantine: 0.95
    },
    paths: {
      state_path: 'permanent_quarantine_state.json',
      latest_path: 'permanent_quarantine_latest.json',
      events_path: 'permanent_quarantine_events.jsonl',
      forensic_dir: 'forensics'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH, opts: AnyObj = {}) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const thresholds = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const stateRoot = path.resolve(String(opts.state_root || process.env.HELIX_STATE_DIR || path.join(ROOT, 'state', 'helix')));
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only === true,
    require_sentinel_confirmed_malice: raw.require_sentinel_confirmed_malice !== false,
    require_hunter_isolation_signal: raw.require_hunter_isolation_signal !== false,
    release_requires_human: raw.release_requires_human !== false,
    thresholds: {
      min_independent_signals_for_permanent_quarantine: clampInt(
        thresholds.min_independent_signals_for_permanent_quarantine,
        1,
        12,
        base.thresholds.min_independent_signals_for_permanent_quarantine
      ),
      min_confidence_for_permanent_quarantine: clampNumber(
        thresholds.min_confidence_for_permanent_quarantine,
        0,
        1,
        base.thresholds.min_confidence_for_permanent_quarantine
      )
    },
    paths: {
      state_path: resolvePath(stateRoot, paths.state_path, base.paths.state_path),
      latest_path: resolvePath(stateRoot, paths.latest_path, base.paths.latest_path),
      events_path: resolvePath(stateRoot, paths.events_path, base.paths.events_path),
      forensic_dir: resolvePath(stateRoot, paths.forensic_dir, base.paths.forensic_dir)
    },
    state_root: stateRoot,
    policy_path: path.resolve(policyPath)
  };
}

function collectIndependentSignals(input: AnyObj = {}) {
  const sentinel = input.sentinel && typeof input.sentinel === 'object' ? input.sentinel : {};
  const verifier = input.verifier && typeof input.verifier === 'object' ? input.verifier : {};
  const codexVerification = input.codex_verification && typeof input.codex_verification === 'object'
    ? input.codex_verification
    : {};
  const hunter = input.hunter && typeof input.hunter === 'object' ? input.hunter : {};

  const sentinelReasons = new Set(
    (Array.isArray(sentinel.reason_codes) ? sentinel.reason_codes : [])
      .map((v: unknown) => normalizeToken(v, 120))
      .filter(Boolean)
  );
  const codexReasons = new Set(
    (Array.isArray(codexVerification.reason_codes) ? codexVerification.reason_codes : [])
      .map((v: unknown) => normalizeToken(v, 120))
      .filter(Boolean)
  );
  const hunterActions = new Set(
    (Array.isArray(hunter.actions) ? hunter.actions : [])
      .map((row: unknown) => row && typeof row === 'object' ? normalizeToken((row as AnyObj).action, 120) : '')
      .filter(Boolean)
  );

  const signals = {
    strand_mismatch: Number(verifier.mismatch_count || 0) > 0 || sentinelReasons.has('sentinel_strand_mismatch'),
    codex_failed: codexVerification.ok === false || sentinelReasons.has('sentinel_codex_verification_failed'),
    codex_signature_mismatch: codexReasons.has('codex_signature_mismatch') || sentinelReasons.has('sentinel_codex_signature_mismatch'),
    hunter_isolation_ready: hunterActions.has('isolate_instance_perimeter') || hunterActions.has('freeze_all_actuation')
  };
  const independentCount = Object.values(signals).filter(Boolean).length;
  return {
    signals,
    independent_count: independentCount
  };
}

function computeConfidence(input: AnyObj = {}) {
  const explicit = Number(input.confidence);
  if (Number.isFinite(explicit)) return clampNumber(explicit, 0, 1, 0);
  const sentinel = input.sentinel && typeof input.sentinel === 'object' ? input.sentinel : {};
  const threshold = clampNumber(input.confirmed_malice_score_threshold, 0.0001, 1000, 3);
  const score = clampNumber(sentinel.score, 0, 1000, 0);
  return clampNumber(score / threshold, 0, 1, 0);
}

function evaluatePermanentQuarantine(input: AnyObj = {}, policy: AnyObj) {
  const sentinel = input.sentinel && typeof input.sentinel === 'object' ? input.sentinel : {};
  const tier = normalizeToken(sentinel.tier || 'clear', 80) || 'clear';
  const applyRequested = input.apply_requested !== false;
  const forcedMalice = Array.isArray(sentinel.reason_codes)
    && sentinel.reason_codes.map((v: unknown) => normalizeToken(v, 120)).includes('sentinel_force_confirmed_malice');
  const signalInfo = collectIndependentSignals(input);
  const confidence = computeConfidence(input);

  const reasonCodes: string[] = [];
  if (!policy.enabled) reasonCodes.push('policy_disabled');
  if (policy.require_sentinel_confirmed_malice && tier !== 'confirmed_malice') reasonCodes.push('tier_not_confirmed_malice');
  if (
    signalInfo.independent_count < policy.thresholds.min_independent_signals_for_permanent_quarantine
  ) reasonCodes.push('insufficient_independent_signals');
  if (
    confidence < policy.thresholds.min_confidence_for_permanent_quarantine
  ) reasonCodes.push('confidence_below_threshold');
  if (policy.require_hunter_isolation_signal && !signalInfo.signals.hunter_isolation_ready) {
    reasonCodes.push('hunter_isolation_missing');
  }
  if (forcedMalice) reasonCodes.push('forced_malice_signal');
  if (policy.shadow_only) reasonCodes.push('shadow_only_policy');
  if (!applyRequested) reasonCodes.push('apply_not_requested');

  const eligible = reasonCodes.filter((row) => !['forced_malice_signal', 'shadow_only_policy', 'apply_not_requested'].includes(row)).length === 0
    || (
      policy.enabled
      && (!policy.require_sentinel_confirmed_malice || tier === 'confirmed_malice')
      && signalInfo.independent_count >= policy.thresholds.min_independent_signals_for_permanent_quarantine
      && confidence >= policy.thresholds.min_confidence_for_permanent_quarantine
      && (!policy.require_hunter_isolation_signal || signalInfo.signals.hunter_isolation_ready)
    );
  const applyExecutable = eligible && applyRequested && policy.shadow_only !== true;

  return {
    ok: true,
    tier,
    eligible,
    active: eligible,
    apply_requested: applyRequested,
    apply_executed: applyExecutable,
    mode: !eligible
      ? 'idle'
      : (applyExecutable ? 'permanent_quarantine' : 'shadow_permanent_quarantine'),
    independent_signals: signalInfo.signals,
    independent_signal_count: signalInfo.independent_count,
    confidence: Number(confidence.toFixed(6)),
    reason_codes: reasonCodes
  };
}

function applyPermanentQuarantine(input: AnyObj = {}, opts: AnyObj = {}) {
  const policy = loadPolicy(String(opts.policy_path || DEFAULT_POLICY_PATH), {
    state_root: opts.state_root
  });
  const result = evaluatePermanentQuarantine(input, policy);
  const prev = readJson(policy.paths.state_path, {});
  const now = nowIso();

  let forensicPath = null;
  if (result.active) {
    ensureDir(policy.paths.forensic_dir);
    const forensicId = `malice_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const absPath = path.join(policy.paths.forensic_dir, `${forensicId}.json`);
    writeJsonAtomic(absPath, {
      schema_id: 'helix_confirmed_malice_forensic',
      schema_version: '1.0',
      generated_at: now,
      sentinel: input.sentinel || {},
      verifier: input.verifier || {},
      codex_verification: input.codex_verification || {},
      hunter: input.hunter || {},
      evaluation: result
    });
    forensicPath = absPath;
  }

  const state = {
    schema_id: 'helix_permanent_quarantine_state',
    schema_version: '1.0',
    updated_at: now,
    entered_at: result.active
      ? (prev && prev.active ? cleanText(prev.entered_at || now, 60) || now : now)
      : null,
    active: result.active,
    mode: result.mode,
    release_requires_human: policy.release_requires_human === true,
    tier: result.tier,
    independent_signal_count: result.independent_signal_count,
    confidence: result.confidence,
    reason_codes: result.reason_codes,
    forensic_path: forensicPath ? rel(forensicPath) : null,
    previous_mode: cleanText(prev && prev.mode || 'idle', 80) || 'idle'
  };
  writeJsonAtomic(policy.paths.state_path, state);

  const eventRow = {
    ts: now,
    type: 'helix_permanent_quarantine',
    active: state.active,
    mode: state.mode,
    tier: state.tier,
    independent_signal_count: state.independent_signal_count,
    confidence: state.confidence,
    reason_codes: state.reason_codes,
    forensic_path: state.forensic_path
  };
  appendJsonl(policy.paths.events_path, eventRow);
  writeJsonAtomic(policy.paths.latest_path, {
    ok: true,
    type: 'helix_permanent_quarantine_latest',
    ts: now,
    state,
    policy: {
      path: rel(policy.policy_path),
      version: policy.version,
      shadow_only: policy.shadow_only
    }
  });
  return {
    ok: true,
    type: 'helix_permanent_quarantine',
    ts: now,
    state,
    event: eventRow,
    policy: {
      path: rel(policy.policy_path),
      version: policy.version,
      shadow_only: policy.shadow_only
    }
  };
}

function status(opts: AnyObj = {}) {
  const policy = loadPolicy(String(opts.policy_path || DEFAULT_POLICY_PATH), {
    state_root: opts.state_root
  });
  const state = readJson(policy.paths.state_path, {
    schema_id: 'helix_permanent_quarantine_state',
    schema_version: '1.0',
    updated_at: null,
    active: false,
    mode: 'idle'
  });
  return {
    ok: true,
    type: 'helix_permanent_quarantine_status',
    ts: nowIso(),
    active: state.active === true,
    mode: cleanText(state.mode || 'idle', 80) || 'idle',
    tier: cleanText(state.tier || 'clear', 80) || 'clear',
    state,
    thresholds: policy.thresholds,
    release_requires_human: policy.release_requires_human === true
  };
}

function release(opts: AnyObj = {}) {
  const policy = loadPolicy(String(opts.policy_path || DEFAULT_POLICY_PATH), {
    state_root: opts.state_root
  });
  const humanApproved = toBool(opts['human-approved'] || opts.human_approved, false);
  if (policy.release_requires_human && !humanApproved) {
    return {
      ok: false,
      type: 'helix_permanent_quarantine_release',
      ts: nowIso(),
      reason_codes: ['human_approval_required']
    };
  }
  const now = nowIso();
  const state = {
    schema_id: 'helix_permanent_quarantine_state',
    schema_version: '1.0',
    updated_at: now,
    entered_at: null,
    active: false,
    mode: 'idle',
    release_requires_human: policy.release_requires_human === true,
    tier: 'clear',
    independent_signal_count: 0,
    confidence: 0,
    reason_codes: ['manual_release'],
    forensic_path: null
  };
  writeJsonAtomic(policy.paths.state_path, state);
  const eventRow = {
    ts: now,
    type: 'helix_permanent_quarantine_release',
    active: false,
    mode: 'idle',
    reason_codes: ['manual_release']
  };
  appendJsonl(policy.paths.events_path, eventRow);
  return {
    ok: true,
    type: 'helix_permanent_quarantine_release',
    ts: now,
    state
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/helix/confirmed_malice_quarantine.js evaluate --input-json=<json> [--policy=path] [--state-root=path] [--apply=1|0]');
  console.log('  node systems/helix/confirmed_malice_quarantine.js status [--policy=path] [--state-root=path]');
  console.log('  node systems/helix/confirmed_malice_quarantine.js release --human-approved=1 [--policy=path] [--state-root=path]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  const baseOpts = {
    policy_path: args.policy || process.env.HELIX_CONFIRMED_MALICE_POLICY_PATH,
    state_root: args['state-root'] || process.env.HELIX_STATE_DIR
  };
  if (cmd === 'status') {
    process.stdout.write(`${JSON.stringify(status(baseOpts), null, 2)}\n`);
    return;
  }
  if (cmd === 'release') {
    const out = release({
      ...baseOpts,
      'human-approved': args['human-approved'] || args.human_approved
    });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(out.ok ? 0 : 1);
    return;
  }
  if (cmd === 'evaluate') {
    let payload: AnyObj = {};
    try {
      payload = args['input-json'] ? JSON.parse(String(args['input-json'])) : {};
    } catch {
      process.stdout.write(`${JSON.stringify({ ok: false, type: 'helix_permanent_quarantine', reason_codes: ['invalid_input_json'] }, null, 2)}\n`);
      process.exit(1);
      return;
    }
    payload.apply_requested = toBool(args.apply, true);
    const out = applyPermanentQuarantine(payload, baseOpts);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(0);
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  evaluatePermanentQuarantine,
  applyPermanentQuarantine,
  status,
  release
};
