#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-228
 * Reproducible distribution artifact pack (Nix flake + signed provenance).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = process.env.REPRO_DISTRIBUTION_ROOT
  ? path.resolve(process.env.REPRO_DISTRIBUTION_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.REPRO_DISTRIBUTION_POLICY_PATH
  ? path.resolve(process.env.REPRO_DISTRIBUTION_POLICY_PATH)
  : path.join(ROOT, 'config', 'reproducible_distribution_artifact_pack_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 320) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tokRaw of argv) {
    const tok = String(tokRaw || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[tok.slice(2)] = true;
    else out[tok.slice(2, idx)] = tok.slice(idx + 1);
  }
  return out;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
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
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function stableHash(v: unknown, len = 18) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function signArtifact(row: AnyObj, secret: string) {
  const h = crypto.createHmac('sha256', String(secret || ''));
  h.update(`${row.target}|${row.source_rev}|${row.digest}|${row.flake_lock_hash}|${row.build_system}`);
  return h.digest('hex');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    provenance_secret: 'reproducible_distribution_secret',
    required_build_system: 'nix_flake',
    required_targets: ['container', 'vm', 'marketplace'],
    paths: {
      manifest_path: 'state/ops/reproducible_distribution_artifact_pack/manifest.json',
      channel_state_path: 'state/ops/reproducible_distribution_artifact_pack/channel_state.json',
      latest_path: 'state/ops/reproducible_distribution_artifact_pack/latest.json',
      history_path: 'state/ops/reproducible_distribution_artifact_pack/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, base);
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    provenance_secret: cleanText(raw.provenance_secret || base.provenance_secret, 240) || base.provenance_secret,
    required_build_system: cleanText(raw.required_build_system || base.required_build_system, 120) || base.required_build_system,
    required_targets: Array.isArray(raw.required_targets) && raw.required_targets.length
      ? raw.required_targets.map((v: unknown) => cleanText(v, 120)).filter(Boolean)
      : base.required_targets,
    paths: {
      manifest_path: resolvePath(paths.manifest_path, base.paths.manifest_path),
      channel_state_path: resolvePath(paths.channel_state_path, base.paths.channel_state_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadChannelState(channelStatePath: string) {
  const state = readJson(channelStatePath, {});
  return {
    revoked_channels: state.revoked_channels && typeof state.revoked_channels === 'object' ? state.revoked_channels : {}
  };
}

function saveChannelState(channelStatePath: string, state: AnyObj) {
  writeJsonAtomic(channelStatePath, {
    revoked_channels: state.revoked_channels && typeof state.revoked_channels === 'object' ? state.revoked_channels : {}
  });
}

function normalizeArtifact(row: AnyObj, idx: number) {
  return {
    target: cleanText(row.target, 80) || `target_${idx + 1}`,
    build_system: cleanText(row.build_system, 80),
    source_rev: cleanText(row.source_rev, 160),
    flake_lock_hash: cleanText(row.flake_lock_hash, 160),
    digest: cleanText(row.digest, 200),
    provenance_sig: cleanText(row.provenance_sig, 200)
  };
}

function validateArtifacts(policy: AnyObj, manifest: AnyObj) {
  const artifacts = Array.isArray(manifest.artifacts)
    ? manifest.artifacts.map((row: AnyObj, idx: number) => normalizeArtifact(row, idx))
    : [];

  const errors: AnyObj[] = [];
  const byTarget = new Map<string, AnyObj>();
  for (const artifact of artifacts) {
    byTarget.set(artifact.target, artifact);
  }

  for (const target of policy.required_targets) {
    if (!byTarget.has(target)) {
      errors.push({ kind: 'target_missing', target });
      continue;
    }
    const artifact = byTarget.get(target)!;
    if (artifact.build_system !== policy.required_build_system) {
      errors.push({ kind: 'build_system_mismatch', target, expected: policy.required_build_system, actual: artifact.build_system });
    }
    const expectedSig = signArtifact(artifact, policy.provenance_secret);
    if (!artifact.provenance_sig || artifact.provenance_sig !== expectedSig) {
      errors.push({ kind: 'provenance_signature_invalid', target });
    }
  }

  const sourceRevs = Array.from(new Set(artifacts.map((a: AnyObj) => a.source_rev).filter(Boolean)));
  const flakeHashes = Array.from(new Set(artifacts.map((a: AnyObj) => a.flake_lock_hash).filter(Boolean)));
  if (sourceRevs.length > 1) errors.push({ kind: 'source_rev_parity_mismatch', values: sourceRevs });
  if (flakeHashes.length > 1) errors.push({ kind: 'flake_lock_parity_mismatch', values: flakeHashes });

  return {
    artifacts,
    errors,
    parity_ok: errors.length === 0,
    source_rev: sourceRevs.length === 1 ? sourceRevs[0] : null,
    flake_lock_hash: flakeHashes.length === 1 ? flakeHashes[0] : null
  };
}

function runPack(policy: AnyObj, channel: string) {
  if (policy.enabled !== true) {
    return {
      ok: true,
      ts: nowIso(),
      type: 'reproducible_distribution_artifact_pack',
      result: 'disabled_by_policy'
    };
  }

  const channelState = loadChannelState(policy.paths.channel_state_path);
  const revoked = channelState.revoked_channels && channelState.revoked_channels[channel]
    ? channelState.revoked_channels[channel]
    : null;
  if (revoked) {
    return {
      ok: false,
      ts: nowIso(),
      type: 'reproducible_distribution_artifact_pack',
      lane_id: 'V3-RACE-228',
      channel,
      error: 'channel_revoked',
      revoked_reason: cleanText(revoked.reason, 240) || 'revoked',
      rollback_procedure: 'node systems/ops/reproducible_distribution_artifact_pack.js restore-channel --channel=' + channel
    };
  }

  const manifest = readJson(policy.paths.manifest_path, {});
  const validation = validateArtifacts(policy, manifest);
  return {
    ok: validation.parity_ok,
    ts: nowIso(),
    type: 'reproducible_distribution_artifact_pack',
    lane_id: 'V3-RACE-228',
    channel,
    required_targets: policy.required_targets,
    required_build_system: policy.required_build_system,
    source_rev: validation.source_rev,
    flake_lock_hash: validation.flake_lock_hash,
    artifact_count: validation.artifacts.length,
    parity_ok: validation.parity_ok,
    errors: validation.errors,
    signed_provenance_receipt_id: `repro_dist_${stableHash(JSON.stringify(validation), 14)}`,
    rollback_procedure: {
      revoke: `node systems/ops/reproducible_distribution_artifact_pack.js revoke-channel --channel=${channel} --reason=<text>`,
      restore: `node systems/ops/reproducible_distribution_artifact_pack.js restore-channel --channel=${channel}`
    }
  };
}

function persist(out: AnyObj, policy: AnyObj) {
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.history_path, {
    ts: out.ts,
    type: out.type,
    ok: out.ok,
    channel: out.channel,
    error_count: Array.isArray(out.errors) ? out.errors.length : 0,
    receipt_id: out.signed_provenance_receipt_id || null
  });
}

function cmdRun(args: AnyObj, policy: AnyObj) {
  const channel = cleanText(args.channel || 'stable', 80) || 'stable';
  const out = runPack(policy, channel);
  persist(out, policy);
  return out;
}

function cmdRevoke(args: AnyObj, policy: AnyObj) {
  const channel = cleanText(args.channel || 'stable', 80) || 'stable';
  const reason = cleanText(args.reason, 240) || 'operator_revoke';
  const state = loadChannelState(policy.paths.channel_state_path);
  state.revoked_channels[channel] = {
    reason,
    ts: nowIso()
  };
  saveChannelState(policy.paths.channel_state_path, state);
  return {
    ok: true,
    ts: nowIso(),
    type: 'reproducible_distribution_artifact_pack_revoke',
    channel,
    revoked: true,
    reason
  };
}

function cmdRestore(args: AnyObj, policy: AnyObj) {
  const channel = cleanText(args.channel || 'stable', 80) || 'stable';
  const state = loadChannelState(policy.paths.channel_state_path);
  if (state.revoked_channels && state.revoked_channels[channel]) {
    delete state.revoked_channels[channel];
  }
  saveChannelState(policy.paths.channel_state_path, state);
  return {
    ok: true,
    ts: nowIso(),
    type: 'reproducible_distribution_artifact_pack_restore',
    channel,
    restored: true
  };
}

function cmdStatus(policy: AnyObj) {
  return {
    ok: true,
    ts: nowIso(),
    type: 'reproducible_distribution_artifact_pack_status',
    latest: readJson(policy.paths.latest_path, null),
    channel_state: loadChannelState(policy.paths.channel_state_path),
    latest_path: rel(policy.paths.latest_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/reproducible_distribution_artifact_pack.js run [--channel=stable] [--strict=1] [--policy=<path>]');
  console.log('  node systems/ops/reproducible_distribution_artifact_pack.js revoke-channel --channel=stable --reason=<text> [--policy=<path>]');
  console.log('  node systems/ops/reproducible_distribution_artifact_pack.js restore-channel --channel=stable [--policy=<path>]');
  console.log('  node systems/ops/reproducible_distribution_artifact_pack.js status [--policy=<path>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'status', 80).toLowerCase();
  if (args.help || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }

  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);

  const out = cmd === 'run'
    ? cmdRun(args, policy)
    : cmd === 'revoke-channel'
      ? cmdRevoke(args, policy)
      : cmd === 'restore-channel'
        ? cmdRestore(args, policy)
        : cmd === 'status'
          ? cmdStatus(policy)
          : null;

  if (!out) {
    usage();
    process.exit(2);
  }

  process.stdout.write(`${JSON.stringify({ ...out, policy_path: rel(policy.policy_path) }, null, 2)}\n`);
  if (cmd === 'run' && toBool(args.strict, false) && out.ok !== true) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  signArtifact,
  validateArtifacts,
  runPack,
  cmdRun,
  cmdRevoke,
  cmdRestore,
  cmdStatus
};
