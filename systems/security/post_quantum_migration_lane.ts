#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-QPROOF-001
 *
 * Post-Quantum hash/signing migration lane.
 *
 * Shadow-first governance primitive that:
 * - inventories critical hash/signature surface
 * - validates key-lifecycle + crypto-agility tracks against PQ targets
 * - emits deterministic migration/verification receipts
 * - maintains a 72-hour live soak plan contract
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  clampNumber,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const POLICY_PATH = process.env.POST_QUANTUM_MIGRATION_POLICY_PATH
  ? path.resolve(process.env.POST_QUANTUM_MIGRATION_POLICY_PATH)
  : path.join(ROOT, 'config', 'post_quantum_migration_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/post_quantum_migration_lane.js run [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/security/post_quantum_migration_lane.js verify [--strict=0|1] [--policy=<path>]');
  console.log('  node systems/security/post_quantum_migration_lane.js status [--policy=<path>]');
}

function normalizeList(v: unknown) {
  if (Array.isArray(v)) return v.map((row) => cleanText(row, 320)).filter(Boolean);
  const raw = cleanText(v || '', 8000);
  if (!raw) return [];
  return raw.split(',').map((row) => cleanText(row, 320)).filter(Boolean);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    defensive_only: true,
    minimum_coverage_ratio: 0.9,
    soak_hours: 72,
    algorithms: {
      signing_targets: ['pq-sphincs+-sha2-192f-robust', 'pq-dilithium3'],
      hashing_targets: ['blake3', 'kangarootwelve']
    },
    hash_pattern_tokens: ['sha256', 'sha-256', 'createhash(\'sha256\')', 'createhash("sha256")'],
    pq_marker_tokens: ['post_quantum', 'pq-', 'blake3', 'kangarootwelve', 'shake256'],
    paths: {
      key_lifecycle_policy_path: 'config/key_lifecycle_policy.json',
      crypto_agility_contract_path: 'config/crypto_agility_contract.json',
      state_path: 'state/security/post_quantum_migration/state.json',
      latest_path: 'state/security/post_quantum_migration/latest.json',
      receipts_path: 'state/security/post_quantum_migration/receipts.jsonl',
      surface_manifest_path: 'state/security/post_quantum_migration/surface_manifest.json'
    },
    critical_paths: [
      'systems/security',
      'systems/ops/foundation_contract_gate.ts',
      'systems/observability',
      'config/key_lifecycle_policy.json',
      'config/crypto_agility_contract.json'
    ],
    scan_extensions: ['.ts', '.js', '.json', '.md'],
    scan_excludes: ['/node_modules/', '/dist/', '/.git/']
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const algorithms = raw.algorithms && typeof raw.algorithms === 'object' ? raw.algorithms : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    defensive_only: toBool(raw.defensive_only, true),
    minimum_coverage_ratio: clampNumber(raw.minimum_coverage_ratio, 0, 1, base.minimum_coverage_ratio),
    soak_hours: clampInt(raw.soak_hours, 24, 24 * 14, base.soak_hours),
    algorithms: {
      signing_targets: normalizeList(algorithms.signing_targets || base.algorithms.signing_targets)
        .map((row) => normalizeToken(row, 120)).filter(Boolean),
      hashing_targets: normalizeList(algorithms.hashing_targets || base.algorithms.hashing_targets)
        .map((row) => normalizeToken(row, 120)).filter(Boolean)
    },
    hash_pattern_tokens: normalizeList(raw.hash_pattern_tokens || base.hash_pattern_tokens)
      .map((row) => row.toLowerCase()),
    pq_marker_tokens: normalizeList(raw.pq_marker_tokens || base.pq_marker_tokens)
      .map((row) => row.toLowerCase()),
    paths: {
      key_lifecycle_policy_path: resolvePath(paths.key_lifecycle_policy_path || base.paths.key_lifecycle_policy_path, base.paths.key_lifecycle_policy_path),
      crypto_agility_contract_path: resolvePath(paths.crypto_agility_contract_path || base.paths.crypto_agility_contract_path, base.paths.crypto_agility_contract_path),
      state_path: resolvePath(paths.state_path || base.paths.state_path, base.paths.state_path),
      latest_path: resolvePath(paths.latest_path || base.paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path || base.paths.receipts_path, base.paths.receipts_path),
      surface_manifest_path: resolvePath(paths.surface_manifest_path || base.paths.surface_manifest_path, base.paths.surface_manifest_path)
    },
    critical_paths: normalizeList(raw.critical_paths || base.critical_paths),
    scan_extensions: normalizeList(raw.scan_extensions || base.scan_extensions)
      .map((row) => String(row || '').toLowerCase()).filter(Boolean),
    scan_excludes: normalizeList(raw.scan_excludes || base.scan_excludes),
    policy_path: path.resolve(policyPath)
  };
}

function listFilesFromRoots(policy: any) {
  const out = [];
  const seen = new Set();
  const extensions = new Set((policy.scan_extensions || []).map((row: string) => String(row || '').toLowerCase()));

  function visit(absPath: string) {
    if (!absPath || seen.has(absPath)) return;
    seen.add(absPath);
    if (!fs.existsSync(absPath)) return;

    const posix = absPath.replace(/\\/g, '/');
    if ((policy.scan_excludes || []).some((needle: string) => needle && posix.includes(String(needle)))) return;

    const st = fs.statSync(absPath);
    if (st.isDirectory()) {
      const names = fs.readdirSync(absPath);
      for (const name of names) visit(path.join(absPath, name));
      return;
    }
    if (!st.isFile()) return;
    if (extensions.size > 0) {
      const ext = path.extname(absPath).toLowerCase();
      if (!extensions.has(ext)) return;
    }
    out.push(absPath);
  }

  for (const rootPath of policy.critical_paths || []) {
    const abs = path.isAbsolute(rootPath) ? path.resolve(rootPath) : path.join(ROOT, rootPath);
    visit(abs);
  }

  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function analyzeSurface(policy: any) {
  const files = listFilesFromRoots(policy);
  const rows = [];

  for (const abs of files) {
    let body = '';
    try {
      body = String(fs.readFileSync(abs, 'utf8') || '');
    } catch {
      continue;
    }
    const lower = body.toLowerCase();
    const legacyHits = (policy.hash_pattern_tokens || [])
      .map((token: string) => ({ token, hits: (lower.match(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length }))
      .filter((row: any) => row.hits > 0);
    const pqMarkerHits = (policy.pq_marker_tokens || [])
      .map((token: string) => ({ token, hits: (lower.match(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length }))
      .filter((row: any) => row.hits > 0);

    const legacyTotal = legacyHits.reduce((acc: number, row: any) => acc + Number(row.hits || 0), 0);
    const pqTotal = pqMarkerHits.reduce((acc: number, row: any) => acc + Number(row.hits || 0), 0);

    let classification = 'neutral';
    if (legacyTotal > 0 && pqTotal > 0) classification = 'hybrid';
    else if (legacyTotal > 0) classification = 'requires_migration';
    else if (pqTotal > 0) classification = 'pq_ready';

    rows.push({
      path: path.relative(ROOT, abs).replace(/\\/g, '/'),
      bytes: Buffer.byteLength(body, 'utf8'),
      legacy_hits: legacyTotal,
      pq_marker_hits: pqTotal,
      classification,
      legacy_tokens: legacyHits.map((row: any) => row.token),
      pq_tokens: pqMarkerHits.map((row: any) => row.token)
    });
  }

  const requires = rows.filter((row: any) => row.classification === 'requires_migration');
  const hybrids = rows.filter((row: any) => row.classification === 'hybrid');
  const pqReady = rows.filter((row: any) => row.classification === 'pq_ready');
  const legacyOrHybrid = rows.filter((row: any) => row.legacy_hits > 0);
  const coveredLegacy = rows.filter((row: any) => row.legacy_hits > 0 && row.pq_marker_hits > 0);

  const denom = Math.max(1, legacyOrHybrid.length);
  const coverage = Number((coveredLegacy.length / denom).toFixed(6));

  return {
    schema_id: 'post_quantum_surface_manifest',
    schema_version: '1.0',
    ts: nowIso(),
    files_scanned: rows.length,
    files_requires_migration: requires.length,
    files_hybrid: hybrids.length,
    files_pq_ready: pqReady.length,
    files_legacy_referenced: legacyOrHybrid.length,
    files_legacy_covered_by_pq_markers: coveredLegacy.length,
    coverage_ratio: coverage,
    unresolved_paths: requires.slice(0, 80).map((row: any) => row.path),
    rows
  };
}

function ensureListContains(baseRows: string[], requiredRows: string[]) {
  const set = new Set((baseRows || []).map((row) => normalizeToken(row, 120)).filter(Boolean));
  const missing = [];
  for (const required of requiredRows || []) {
    const token = normalizeToken(required, 120);
    if (!token) continue;
    if (!set.has(token)) missing.push(token);
  }
  return missing;
}

function updateKeyLifecyclePolicy(policy: any, applyAllowed: boolean) {
  const keyPolicy = readJson(policy.paths.key_lifecycle_policy_path, {});
  const allowed = Array.isArray(keyPolicy.allowed_algorithms)
    ? keyPolicy.allowed_algorithms.map((row: unknown) => normalizeToken(row, 120)).filter(Boolean)
    : [];
  const missingSigningTargets = ensureListContains(allowed, policy.algorithms.signing_targets || []);
  let applied = false;
  if (applyAllowed && missingSigningTargets.length > 0) {
    const nextAllowed = Array.from(new Set(allowed.concat(missingSigningTargets))).sort();
    keyPolicy.allowed_algorithms = nextAllowed;
    writeJsonAtomic(policy.paths.key_lifecycle_policy_path, keyPolicy);
    applied = true;
    return {
      missing_signing_targets: [],
      apply_written: applied,
      allowed_algorithms: nextAllowed
    };
  }
  return {
    missing_signing_targets: missingSigningTargets,
    apply_written: applied,
    allowed_algorithms: Array.isArray(keyPolicy.allowed_algorithms) ? keyPolicy.allowed_algorithms : allowed
  };
}

function updateCryptoAgilityContract(policy: any, applyAllowed: boolean) {
  const contract = readJson(policy.paths.crypto_agility_contract_path, {});
  const tracks = contract.migration_tracks && typeof contract.migration_tracks === 'object'
    ? contract.migration_tracks
    : {};

  const targetSigning = normalizeToken(policy.algorithms.signing_targets && policy.algorithms.signing_targets[0] || 'pq-sphincs+-sha2-192f-robust', 120)
    || 'pq-sphincs+-sha2-192f-robust';
  const requiredTracks = {
    ed25519: { target: targetSigning, status: 'planned' },
    'rsa-4096': { target: targetSigning, status: 'planned' },
    ecdsa: { target: targetSigning, status: 'planned' },
    'pq-dilithium3': { target: 'pq-dilithium3', status: 'active' },
    [targetSigning]: { target: targetSigning, status: 'active' }
  };

  const missing = [];
  for (const [id, expected] of Object.entries(requiredTracks)) {
    const current = tracks[id] && typeof tracks[id] === 'object' ? tracks[id] : null;
    if (!current) {
      missing.push(id);
      continue;
    }
    const currentTarget = normalizeToken(current.target || '', 120);
    const expectedTarget = normalizeToken((expected as any).target || '', 120);
    if (currentTarget !== expectedTarget) missing.push(id);
  }

  let applied = false;
  if (applyAllowed && missing.length > 0) {
    contract.migration_tracks = {
      ...tracks,
      ...requiredTracks
    };
    writeJsonAtomic(policy.paths.crypto_agility_contract_path, contract);
    applied = true;
    return {
      missing_tracks: [],
      apply_written: applied,
      migration_tracks: contract.migration_tracks
    };
  }

  return {
    missing_tracks: missing,
    apply_written: applied,
    migration_tracks: contract.migration_tracks && typeof contract.migration_tracks === 'object'
      ? contract.migration_tracks
      : tracks
  };
}

function loadState(policy: any) {
  const src = readJson(policy.paths.state_path, null);
  if (!src || typeof src !== 'object') {
    return {
      schema_id: 'post_quantum_migration_state',
      schema_version: '1.0',
      updated_at: nowIso(),
      runs: 0,
      applies: 0,
      last_run_at: null,
      last_verify_at: null,
      last_coverage_ratio: null,
      last_soak_plan_hours: Number(policy.soak_hours || 72)
    };
  }
  return {
    schema_id: 'post_quantum_migration_state',
    schema_version: '1.0',
    updated_at: src.updated_at || nowIso(),
    runs: Math.max(0, Number(src.runs || 0)),
    applies: Math.max(0, Number(src.applies || 0)),
    last_run_at: src.last_run_at || null,
    last_verify_at: src.last_verify_at || null,
    last_coverage_ratio: src.last_coverage_ratio != null ? Number(src.last_coverage_ratio) : null,
    last_soak_plan_hours: Math.max(1, Number(src.last_soak_plan_hours || policy.soak_hours || 72))
  };
}

function saveState(policy: any, state: any) {
  writeJsonAtomic(policy.paths.state_path, {
    schema_id: 'post_quantum_migration_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    runs: Math.max(0, Number(state.runs || 0)),
    applies: Math.max(0, Number(state.applies || 0)),
    last_run_at: state.last_run_at || null,
    last_verify_at: state.last_verify_at || null,
    last_coverage_ratio: state.last_coverage_ratio != null ? Number(state.last_coverage_ratio) : null,
    last_soak_plan_hours: Math.max(1, Number(state.last_soak_plan_hours || policy.soak_hours || 72))
  });
}

function soakPlan(policy: any) {
  return {
    required_hours: Number(policy.soak_hours || 72),
    cadence_hours: 6,
    checks: [
      'contract_check',
      'foundation_contract_gate',
      'venom_containment_layer',
      'key_lifecycle_governor_verify'
    ],
    success_condition: 'zero_failures'
  };
}

function cmdRun(args: any, policy: any) {
  const applyRequested = toBool(args.apply, false);
  const applyAllowed = applyRequested && policy.shadow_only !== true;

  const surface = analyzeSurface(policy);
  writeJsonAtomic(policy.paths.surface_manifest_path, surface);

  const keyUpdate = updateKeyLifecyclePolicy(policy, applyAllowed);
  const contractUpdate = updateCryptoAgilityContract(policy, applyAllowed);

  const missingTotal = Number(keyUpdate.missing_signing_targets.length || 0)
    + Number(contractUpdate.missing_tracks.length || 0)
    + Number(surface.files_requires_migration || 0);

  const state = loadState(policy);
  state.runs += 1;
  state.last_run_at = nowIso();
  state.last_coverage_ratio = Number(surface.coverage_ratio || 0);
  state.last_soak_plan_hours = Number(policy.soak_hours || 72);
  if (keyUpdate.apply_written || contractUpdate.apply_written) {
    state.applies += 1;
  }
  saveState(policy, state);

  const out = {
    ok: true,
    type: 'post_quantum_migration_run',
    ts: nowIso(),
    shadow_only: policy.shadow_only === true,
    defensive_only: policy.defensive_only === true,
    apply_requested: applyRequested,
    apply_allowed: applyAllowed,
    apply_written: keyUpdate.apply_written || contractUpdate.apply_written,
    policy_version: policy.version,
    policy_path: policy.policy_path,
    coverage_ratio: Number(surface.coverage_ratio || 0),
    minimum_coverage_ratio: Number(policy.minimum_coverage_ratio || 0),
    unresolved_surface_paths: Number(surface.files_requires_migration || 0),
    key_policy_missing_signing_targets: keyUpdate.missing_signing_targets,
    crypto_contract_missing_tracks: contractUpdate.missing_tracks,
    soak_plan: soakPlan(policy),
    strict_ready: missingTotal === 0 && Number(surface.coverage_ratio || 0) >= Number(policy.minimum_coverage_ratio || 0),
    paths: {
      latest_path: path.relative(ROOT, policy.paths.latest_path).replace(/\\/g, '/'),
      receipts_path: path.relative(ROOT, policy.paths.receipts_path).replace(/\\/g, '/'),
      surface_manifest_path: path.relative(ROOT, policy.paths.surface_manifest_path).replace(/\\/g, '/')
    }
  };

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function cmdVerify(args: any, policy: any) {
  const strict = toBool(args.strict, false);
  const latest = readJson(policy.paths.latest_path, null);
  if (!latest || typeof latest !== 'object') {
    const out = { ok: false, type: 'post_quantum_migration_verify', error: 'latest_missing' };
    if (strict) emit(out, 1);
    return out;
  }

  const checks = {
    defensive_only: policy.defensive_only === true,
    soak_plan_present: Number(latest.soak_plan && latest.soak_plan.required_hours || 0) >= 72,
    key_targets_present: Array.isArray(latest.key_policy_missing_signing_targets)
      ? latest.key_policy_missing_signing_targets.length === 0
      : false,
    crypto_tracks_present: Array.isArray(latest.crypto_contract_missing_tracks)
      ? latest.crypto_contract_missing_tracks.length === 0
      : false,
    coverage_ratio_ok: Number(latest.coverage_ratio || 0) >= Number(policy.minimum_coverage_ratio || 0)
  };
  const pass = Object.values(checks).every(Boolean);

  const state = loadState(policy);
  state.last_verify_at = nowIso();
  saveState(policy, state);

  const out = {
    ok: pass,
    type: 'post_quantum_migration_verify',
    ts: nowIso(),
    strict,
    checks,
    coverage_ratio: Number(latest.coverage_ratio || 0),
    minimum_coverage_ratio: Number(policy.minimum_coverage_ratio || 0),
    latest
  };

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  if (strict && !pass) emit(out, 1);
  return out;
}

function cmdStatus(policy: any) {
  return {
    ok: true,
    type: 'post_quantum_migration_status',
    ts: nowIso(),
    latest: readJson(policy.paths.latest_path, null),
    state: loadState(policy),
    surface_manifest: readJson(policy.paths.surface_manifest_path, null)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    return;
  }

  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (policy.enabled !== true) emit({ ok: false, error: 'post_quantum_migration_disabled' }, 1);

  if (cmd === 'run') emit(cmdRun(args, policy));
  if (cmd === 'verify') emit(cmdVerify(args, policy));
  if (cmd === 'status') emit(cmdStatus(policy));

  emit({ ok: false, error: 'unsupported_command', cmd }, 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  analyzeSurface,
  loadPolicy,
  cmdRun,
  cmdVerify,
  cmdStatus
};
