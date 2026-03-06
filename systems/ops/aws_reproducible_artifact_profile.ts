#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-244
 * AWS reproducible artifact profile (AMI/ECR/Serverless via Nix + Image Builder).
 */

const fs = require('fs');
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

const DEFAULT_POLICY_PATH = process.env.AWS_REPRO_ARTIFACT_POLICY_PATH
  ? path.resolve(process.env.AWS_REPRO_ARTIFACT_POLICY_PATH)
  : path.join(ROOT, 'config', 'aws_reproducible_artifact_profile_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/aws_reproducible_artifact_profile.js run [--channel=stable] [--strict=1] [--policy=<path>]');
  console.log('  node systems/ops/aws_reproducible_artifact_profile.js revoke-channel --channel=<name> --reason=<text> [--policy=<path>]');
  console.log('  node systems/ops/aws_reproducible_artifact_profile.js restore-channel --channel=<name> [--policy=<path>]');
  console.log('  node systems/ops/aws_reproducible_artifact_profile.js status [--policy=<path>]');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function signArtifact(row: AnyObj, secret: string) {
  const h = crypto.createHmac('sha256', String(secret || ''));
  h.update(`${row.target}|${row.build_track}|${row.source_rev}|${row.nix_lock_hash}|${row.digest}|${row.bottlerocket_profile}`);
  return h.digest('hex');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    provenance_secret: 'aws_repro_artifact_secret',
    required_targets: ['ami', 'ecr', 'serverless'],
    required_build_tracks: {
      ami: 'nix+image_builder',
      ecr: 'nix',
      serverless: 'nix'
    },
    require_bottlerocket_profile: true,
    paths: {
      manifest_path: 'state/ops/aws_reproducible_artifact_profile/manifest.json',
      channel_state_path: 'state/ops/aws_reproducible_artifact_profile/channel_state.json',
      latest_path: 'state/ops/aws_reproducible_artifact_profile/latest.json',
      history_path: 'state/ops/aws_reproducible_artifact_profile/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const tracks = raw.required_build_tracks && typeof raw.required_build_tracks === 'object' ? raw.required_build_tracks : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    provenance_secret: cleanText(raw.provenance_secret || base.provenance_secret, 240) || base.provenance_secret,
    required_targets: Array.isArray(raw.required_targets) && raw.required_targets.length
      ? raw.required_targets.map((v: unknown) => cleanText(v, 80)).filter(Boolean)
      : base.required_targets,
    required_build_tracks: {
      ami: cleanText(tracks.ami || base.required_build_tracks.ami, 120),
      ecr: cleanText(tracks.ecr || base.required_build_tracks.ecr, 120),
      serverless: cleanText(tracks.serverless || base.required_build_tracks.serverless, 120)
    },
    require_bottlerocket_profile: toBool(raw.require_bottlerocket_profile, base.require_bottlerocket_profile),
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
    revoked_channels: row.revoked_channels && typeof row.revoked_channels === 'object' ? row.revoked_channels : {}
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
    build_track: cleanText(row.build_track, 120),
    source_rev: cleanText(row.source_rev, 160),
    nix_lock_hash: cleanText(row.nix_lock_hash, 160),
    digest: cleanText(row.digest, 200),
    bottlerocket_profile: cleanText(row.bottlerocket_profile, 120),
    provenance_sig: cleanText(row.provenance_sig, 200)
  };
}

function validateManifest(policy: AnyObj, manifest: AnyObj) {
  const artifacts = Array.isArray(manifest.artifacts)
    ? manifest.artifacts.map((row: AnyObj, idx: number) => normalizeArtifact(row, idx))
    : [];

  const byTarget = new Map<string, AnyObj>();
  for (const artifact of artifacts) byTarget.set(artifact.target, artifact);

  const errors: AnyObj[] = [];

  for (const target of policy.required_targets) {
    if (!byTarget.has(target)) {
      errors.push({ kind: 'target_missing', target });
      continue;
    }
    const artifact = byTarget.get(target)!;
    const expectedTrack = cleanText(policy.required_build_tracks[target], 120);
    if (artifact.build_track !== expectedTrack) {
      errors.push({ kind: 'build_track_mismatch', target, expected: expectedTrack, actual: artifact.build_track });
    }

    if (policy.require_bottlerocket_profile && !artifact.bottlerocket_profile) {
      errors.push({ kind: 'bottlerocket_profile_missing', target });
    }

    const expectedSig = signArtifact(artifact, policy.provenance_secret);
    if (!artifact.provenance_sig || artifact.provenance_sig !== expectedSig) {
      errors.push({ kind: 'provenance_signature_invalid', target });
    }
  }

  const sourceRevs = Array.from(new Set(artifacts.map((a: AnyObj) => a.source_rev).filter(Boolean)));
  const nixHashes = Array.from(new Set(artifacts.map((a: AnyObj) => a.nix_lock_hash).filter(Boolean)));
  if (sourceRevs.length > 1) errors.push({ kind: 'source_rev_parity_mismatch', values: sourceRevs });
  if (nixHashes.length > 1) errors.push({ kind: 'nix_lock_parity_mismatch', values: nixHashes });

  return {
    artifacts,
    errors,
    parity_ok: errors.length === 0,
    source_rev: sourceRevs.length === 1 ? sourceRevs[0] : null,
    nix_lock_hash: nixHashes.length === 1 ? nixHashes[0] : null
  };
}

function runProfile(policy: AnyObj, channel: string) {
  if (policy.enabled !== true) {
    return {
      ok: true,
      type: 'aws_reproducible_artifact_profile',
      ts: nowIso(),
      result: 'disabled_by_policy'
    };
  }

  const channelState = loadChannelState(policy.paths.channel_state_path);
  const revoked = channelState.revoked_channels[channel] || null;
  if (revoked) {
    return {
      ok: false,
      type: 'aws_reproducible_artifact_profile',
      lane_id: 'V3-RACE-244',
      ts: nowIso(),
      channel,
      error: 'channel_revoked',
      revoked_reason: cleanText(revoked.reason, 240) || 'revoked'
    };
  }

  const manifest = readJson(policy.paths.manifest_path, {});
  const validation = validateManifest(policy, manifest);

  return {
    ok: validation.parity_ok,
    type: 'aws_reproducible_artifact_profile',
    lane_id: 'V3-RACE-244',
    ts: nowIso(),
    channel,
    required_targets: policy.required_targets,
    source_rev: validation.source_rev,
    nix_lock_hash: validation.nix_lock_hash,
    artifact_count: validation.artifacts.length,
    parity_ok: validation.parity_ok,
    errors: validation.errors,
    provenance_receipt_id: `aws_repro_${stableHash(JSON.stringify(validation), 14)}`,
    rollback_procedure: {
      revoke: `node systems/ops/aws_reproducible_artifact_profile.js revoke-channel --channel=${channel} --reason=<text>`,
      restore: `node systems/ops/aws_reproducible_artifact_profile.js restore-channel --channel=${channel}`
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
    receipt_id: out.provenance_receipt_id || null
  });
}

function cmdRun(args: AnyObj, policy: AnyObj) {
  const channel = cleanText(args.channel || 'stable', 80) || 'stable';
  const out = runProfile(policy, channel);
  persist(out, policy);
  return out;
}

function cmdRevoke(args: AnyObj, policy: AnyObj) {
  const channel = cleanText(args.channel || 'stable', 80) || 'stable';
  const reason = cleanText(args.reason || 'operator_revoke', 240) || 'operator_revoke';
  const state = loadChannelState(policy.paths.channel_state_path);
  state.revoked_channels[channel] = { reason, ts: nowIso() };
  saveChannelState(policy.paths.channel_state_path, state);
  return {
    ok: true,
    type: 'aws_reproducible_artifact_profile_revoke',
    ts: nowIso(),
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
    type: 'aws_reproducible_artifact_profile_restore',
    ts: nowIso(),
    channel,
    restored: true
  };
}

function cmdStatus(policy: AnyObj) {
  return {
    ok: true,
    type: 'aws_reproducible_artifact_profile_status',
    ts: nowIso(),
    latest: readJson(policy.paths.latest_path, null),
    channel_state: loadChannelState(policy.paths.channel_state_path),
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
    emit({ ok: false, error: `unknown_command:${cmd}` }, 2);
  }

  emit({
    ...out,
    policy_path: rel(policy.policy_path)
  }, (cmd === 'run' && toBool(args.strict, false) && out.ok !== true) ? 1 : 0);
}

main();
