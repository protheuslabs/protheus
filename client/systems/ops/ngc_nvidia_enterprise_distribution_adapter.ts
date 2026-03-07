#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-278
 * NGC + NVIDIA AI Enterprise distribution adapter.
 */

const path = require('path');
const crypto = require('crypto');
const {
  ROOT,
  nowIso,
  cleanText,
  toBool,
  parseArgs,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

type AnyObj = Record<string, any>;

const DEFAULT_POLICY_PATH = process.env.NGC_NVIDIA_DISTRIBUTION_POLICY_PATH
  ? path.resolve(process.env.NGC_NVIDIA_DISTRIBUTION_POLICY_PATH)
  : path.join(ROOT, 'config', 'ngc_nvidia_enterprise_distribution_adapter_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/ngc_nvidia_enterprise_distribution_adapter.js run [--channel=stable] [--strict=1] [--policy=<path>]');
  console.log('  node systems/ops/ngc_nvidia_enterprise_distribution_adapter.js freeze-channel --channel=<name> --reason=<text> [--policy=<path>]');
  console.log('  node systems/ops/ngc_nvidia_enterprise_distribution_adapter.js restore-channel --channel=<name> [--policy=<path>]');
  console.log('  node systems/ops/ngc_nvidia_enterprise_distribution_adapter.js status [--policy=<path>]');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function signArtifact(row: AnyObj, secret: string) {
  const h = crypto.createHmac('sha256', String(secret || ''));
  h.update(`${row.target}|${row.channel}|${row.registry}|${row.source_rev}|${row.flake_lock_hash}|${row.digest}|${row.ai_enterprise_profile}`);
  return h.digest('hex');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    provenance_secret: 'ngc_nvidia_distribution_secret',
    required_targets: ['seed_image', 'lane_container'],
    required_registry_prefix: 'nvcr.io',
    required_profiles: ['production-certified', 'support-lts'],
    paths: {
      manifest_path: 'state/ops/ngc_nvidia_enterprise_distribution_adapter/manifest.json',
      channel_state_path: 'state/ops/ngc_nvidia_enterprise_distribution_adapter/channel_state.json',
      latest_path: 'state/ops/ngc_nvidia_enterprise_distribution_adapter/latest.json',
      history_path: 'state/ops/ngc_nvidia_enterprise_distribution_adapter/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    provenance_secret: cleanText(raw.provenance_secret || base.provenance_secret, 240) || base.provenance_secret,
    required_targets: Array.isArray(raw.required_targets) && raw.required_targets.length
      ? raw.required_targets.map((v: unknown) => cleanText(v, 80)).filter(Boolean)
      : base.required_targets,
    required_registry_prefix: cleanText(raw.required_registry_prefix || base.required_registry_prefix, 120) || base.required_registry_prefix,
    required_profiles: Array.isArray(raw.required_profiles) && raw.required_profiles.length
      ? raw.required_profiles.map((v: unknown) => cleanText(v, 120)).filter(Boolean)
      : base.required_profiles,
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
  const row = readJson(channelStatePath, {});
  return {
    frozen_channels: row.frozen_channels && typeof row.frozen_channels === 'object' ? row.frozen_channels : {}
  };
}

function saveChannelState(channelStatePath: string, state: AnyObj) {
  writeJsonAtomic(channelStatePath, {
    frozen_channels: state.frozen_channels && typeof state.frozen_channels === 'object' ? state.frozen_channels : {}
  });
}

function normalizeArtifact(row: AnyObj, idx: number, fallbackChannel: string) {
  return {
    target: cleanText(row.target, 80) || `target_${idx + 1}`,
    channel: cleanText(row.channel || fallbackChannel, 80) || fallbackChannel,
    registry: cleanText(row.registry, 200),
    source_rev: cleanText(row.source_rev, 160),
    flake_lock_hash: cleanText(row.flake_lock_hash, 160),
    digest: cleanText(row.digest, 200),
    ai_enterprise_profile: cleanText(row.ai_enterprise_profile, 120),
    signature: cleanText(row.signature, 200)
  };
}

function validateManifest(policy: AnyObj, manifest: AnyObj, channel: string) {
  const artifacts = Array.isArray(manifest.artifacts)
    ? manifest.artifacts.map((row: AnyObj, idx: number) => normalizeArtifact(row, idx, channel))
    : [];

  const errors: AnyObj[] = [];
  const byTarget = new Map<string, AnyObj>();
  for (const artifact of artifacts) byTarget.set(artifact.target, artifact);

  for (const target of policy.required_targets) {
    if (!byTarget.has(target)) {
      errors.push({ kind: 'target_missing', target });
      continue;
    }
    const artifact = byTarget.get(target)!;
    if (artifact.channel !== channel) errors.push({ kind: 'channel_mismatch', target, channel: artifact.channel });
    if (!artifact.registry.startsWith(policy.required_registry_prefix)) {
      errors.push({ kind: 'registry_prefix_mismatch', target, expected: policy.required_registry_prefix, actual: artifact.registry });
    }
    if (!policy.required_profiles.includes(artifact.ai_enterprise_profile)) {
      errors.push({
        kind: 'ai_enterprise_profile_invalid',
        target,
        expected_one_of: policy.required_profiles,
        actual: artifact.ai_enterprise_profile
      });
    }
    const expectedSig = signArtifact(artifact, policy.provenance_secret);
    if (!artifact.signature || artifact.signature !== expectedSig) {
      errors.push({ kind: 'provenance_signature_invalid', target });
    }
  }

  const sourceRevs = Array.from(new Set(artifacts.map((row: AnyObj) => row.source_rev).filter(Boolean)));
  const flakeHashes = Array.from(new Set(artifacts.map((row: AnyObj) => row.flake_lock_hash).filter(Boolean)));
  if (sourceRevs.length > 1) errors.push({ kind: 'source_rev_parity_mismatch', values: sourceRevs });
  if (flakeHashes.length > 1) errors.push({ kind: 'flake_lock_parity_mismatch', values: flakeHashes });

  return {
    artifacts,
    errors,
    signature_ok: errors.every((row: AnyObj) => !String(row.kind || '').includes('signature')),
    provenance_ok: errors.every((row: AnyObj) => !String(row.kind || '').includes('parity') && !String(row.kind || '').includes('prefix')),
    profile_ok: errors.every((row: AnyObj) => !String(row.kind || '').includes('profile')),
    parity_ok: errors.length === 0,
    source_rev: sourceRevs.length === 1 ? sourceRevs[0] : null,
    flake_lock_hash: flakeHashes.length === 1 ? flakeHashes[0] : null
  };
}

function runAdapter(policy: AnyObj, channel: string) {
  if (policy.enabled !== true) {
    return {
      ok: true,
      type: 'ngc_nvidia_enterprise_distribution_adapter',
      ts: nowIso(),
      result: 'disabled_by_policy'
    };
  }

  const channelState = loadChannelState(policy.paths.channel_state_path);
  const frozen = channelState.frozen_channels[channel] || null;
  if (frozen) {
    return {
      ok: false,
      type: 'ngc_nvidia_enterprise_distribution_adapter',
      lane_id: 'V3-RACE-278',
      ts: nowIso(),
      channel,
      error: 'channel_frozen',
      frozen_reason: cleanText(frozen.reason, 240) || 'frozen'
    };
  }

  const manifest = readJson(policy.paths.manifest_path, {});
  const validation = validateManifest(policy, manifest, channel);
  return {
    ok: validation.parity_ok,
    type: 'ngc_nvidia_enterprise_distribution_adapter',
    lane_id: 'V3-RACE-278',
    ts: nowIso(),
    channel,
    required_targets: policy.required_targets,
    source_rev: validation.source_rev,
    flake_lock_hash: validation.flake_lock_hash,
    artifact_count: validation.artifacts.length,
    signature_ok: validation.signature_ok,
    provenance_ok: validation.provenance_ok,
    profile_ok: validation.profile_ok,
    parity_ok: validation.parity_ok,
    errors: validation.errors,
    verification_receipt_id: `ngc_dist_${stableHash(JSON.stringify(validation), 14)}`,
    rollback_procedure: {
      freeze: `node systems/ops/ngc_nvidia_enterprise_distribution_adapter.js freeze-channel --channel=${channel} --reason=<text>`,
      restore: `node systems/ops/ngc_nvidia_enterprise_distribution_adapter.js restore-channel --channel=${channel}`
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
    receipt_id: out.verification_receipt_id || null
  });
}

function cmdRun(args: AnyObj, policy: AnyObj) {
  const channel = cleanText(args.channel || 'stable', 80) || 'stable';
  const out = runAdapter(policy, channel);
  persist(out, policy);
  return out;
}

function cmdFreeze(args: AnyObj, policy: AnyObj) {
  const channel = cleanText(args.channel || 'stable', 80) || 'stable';
  const reason = cleanText(args.reason || 'operator_freeze', 240) || 'operator_freeze';
  const state = loadChannelState(policy.paths.channel_state_path);
  state.frozen_channels[channel] = { reason, ts: nowIso() };
  saveChannelState(policy.paths.channel_state_path, state);
  return {
    ok: true,
    type: 'ngc_nvidia_enterprise_distribution_adapter_freeze',
    ts: nowIso(),
    channel,
    frozen: true,
    reason
  };
}

function cmdRestore(args: AnyObj, policy: AnyObj) {
  const channel = cleanText(args.channel || 'stable', 80) || 'stable';
  const state = loadChannelState(policy.paths.channel_state_path);
  if (state.frozen_channels[channel]) delete state.frozen_channels[channel];
  saveChannelState(policy.paths.channel_state_path, state);
  return {
    ok: true,
    type: 'ngc_nvidia_enterprise_distribution_adapter_restore',
    ts: nowIso(),
    channel,
    restored: true
  };
}

function cmdStatus(policy: AnyObj) {
  return {
    ok: true,
    type: 'ngc_nvidia_enterprise_distribution_adapter_status',
    ts: nowIso(),
    latest: readJson(policy.paths.latest_path, null),
    frozen_channels: loadChannelState(policy.paths.channel_state_path).frozen_channels,
    policy_path: rel(policy.policy_path),
    latest_path: rel(policy.paths.latest_path)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'status', 80).toLowerCase();
  if (args.help || ['help', '--help', '-h'].includes(cmd)) {
    usage();
    process.exit(0);
  }

  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const strict = toBool(args.strict, false);

  const out = cmd === 'run'
    ? cmdRun(args, policy)
    : cmd === 'freeze-channel'
      ? cmdFreeze(args, policy)
      : cmd === 'restore-channel'
        ? cmdRestore(args, policy)
        : cmd === 'status'
          ? cmdStatus(policy)
          : null;
  if (!out) {
    usage();
    emit({ ok: false, error: `unknown_command:${cmd}` }, 2);
    return;
  }
  emit({ ...out, policy_path: rel(policy.policy_path) }, out.ok || !strict ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  runAdapter,
  cmdRun,
  cmdFreeze,
  cmdRestore,
  cmdStatus,
  signArtifact
};
