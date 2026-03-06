#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-273
 * ChromeOS/Fuchsia distribution + OTA adapter lane.
 */

const path = require('path');
const crypto = require('crypto');
const {
  ROOT,
  nowIso,
  cleanText,
  toBool,
  clampInt,
  parseArgs,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

type AnyObj = Record<string, any>;

const DEFAULT_POLICY_PATH = process.env.CHROMEOS_FUCHSIA_OTA_POLICY_PATH
  ? path.resolve(process.env.CHROMEOS_FUCHSIA_OTA_POLICY_PATH)
  : path.join(ROOT, 'config', 'chromeos_fuchsia_distribution_ota_adapter_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/chromeos_fuchsia_distribution_ota_adapter.js run [--channel=chromeos-stable] [--strict=1] [--policy=<path>]');
  console.log('  node systems/ops/chromeos_fuchsia_distribution_ota_adapter.js freeze-channel --channel=<name> --reason=<text> [--policy=<path>]');
  console.log('  node systems/ops/chromeos_fuchsia_distribution_ota_adapter.js restore-channel --channel=<name> [--policy=<path>]');
  console.log('  node systems/ops/chromeos_fuchsia_distribution_ota_adapter.js status [--policy=<path>]');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function signPackage(row: AnyObj, secret: string) {
  const h = crypto.createHmac('sha256', String(secret || ''));
  h.update(`${row.target}|${row.channel}|${row.build_rev}|${row.package_digest}|${row.ota_track}`);
  return h.digest('hex');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    signing_secret: 'chromeos_fuchsia_ota_secret',
    required_targets: ['chromeos', 'fuchsia'],
    required_channels: ['chromeos-stable', 'fuchsia-stable'],
    required_stage_plan: [5, 25, 50, 100],
    min_rollback_window_minutes: 60,
    paths: {
      manifest_path: 'state/ops/chromeos_fuchsia_distribution_ota_adapter/manifest.json',
      channel_state_path: 'state/ops/chromeos_fuchsia_distribution_ota_adapter/channel_state.json',
      latest_path: 'state/ops/chromeos_fuchsia_distribution_ota_adapter/latest.json',
      history_path: 'state/ops/chromeos_fuchsia_distribution_ota_adapter/history.jsonl'
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
    signing_secret: cleanText(raw.signing_secret || base.signing_secret, 240) || base.signing_secret,
    required_targets: Array.isArray(raw.required_targets) && raw.required_targets.length
      ? raw.required_targets.map((v: unknown) => cleanText(v, 80)).filter(Boolean)
      : base.required_targets,
    required_channels: Array.isArray(raw.required_channels) && raw.required_channels.length
      ? raw.required_channels.map((v: unknown) => cleanText(v, 80)).filter(Boolean)
      : base.required_channels,
    required_stage_plan: Array.isArray(raw.required_stage_plan) && raw.required_stage_plan.length
      ? raw.required_stage_plan.map((v: unknown) => clampInt(v, 1, 100, 1))
      : base.required_stage_plan,
    min_rollback_window_minutes: clampInt(raw.min_rollback_window_minutes, 1, 60 * 24 * 7, base.min_rollback_window_minutes),
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
    build_rev: cleanText(row.build_rev, 160),
    package_digest: cleanText(row.package_digest, 200),
    ota_track: cleanText(row.ota_track, 120),
    signature: cleanText(row.signature, 200)
  };
}

function validateStagePlan(required: number[], observed: number[]) {
  if (!observed.length) return { ok: false, reason: 'ota_stage_plan_missing' };
  const monotonic = observed.every((value, idx) => idx === 0 || value >= observed[idx - 1]);
  if (!monotonic) return { ok: false, reason: 'ota_stage_plan_non_monotonic' };
  if (observed[observed.length - 1] !== 100) return { ok: false, reason: 'ota_stage_plan_missing_100_percent' };

  const requiredMissing = required.filter((value: number) => !observed.includes(value));
  if (requiredMissing.length) return { ok: false, reason: 'ota_stage_plan_missing_required_steps', missing: requiredMissing };
  return { ok: true, reason: null };
}

function validateManifest(policy: AnyObj, manifest: AnyObj, channel: string) {
  const artifacts = Array.isArray(manifest.artifacts)
    ? manifest.artifacts.map((row: AnyObj, idx: number) => normalizeArtifact(row, idx, channel))
    : [];
  const errors: AnyObj[] = [];

  if (!policy.required_channels.includes(channel)) {
    errors.push({ kind: 'channel_not_allowed', channel });
  }

  const byTarget = new Map<string, AnyObj>();
  for (const artifact of artifacts) byTarget.set(artifact.target, artifact);
  for (const target of policy.required_targets) {
    if (!byTarget.has(target)) {
      errors.push({ kind: 'target_missing', target });
      continue;
    }
    const artifact = byTarget.get(target)!;
    if (artifact.channel !== channel) errors.push({ kind: 'channel_mismatch', target, channel: artifact.channel });
    const expectedSig = signPackage(artifact, policy.signing_secret);
    if (!artifact.signature || artifact.signature !== expectedSig) {
      errors.push({ kind: 'package_signature_invalid', target });
    }
    if (!artifact.package_digest) errors.push({ kind: 'package_digest_missing', target });
    if (!artifact.ota_track) errors.push({ kind: 'ota_track_missing', target });
  }

  const revisions = Array.from(new Set(artifacts.map((row: AnyObj) => row.build_rev).filter(Boolean)));
  if (revisions.length > 1) errors.push({ kind: 'build_revision_parity_mismatch', values: revisions });

  const otaContract = manifest && manifest.ota_contract && typeof manifest.ota_contract === 'object'
    ? manifest.ota_contract
    : {};
  const stagePlan = Array.isArray(otaContract.stages)
    ? otaContract.stages.map((v: unknown) => clampInt(v, 1, 100, 1))
    : [];
  const stagePlanCheck = validateStagePlan(policy.required_stage_plan, stagePlan);
  if (stagePlanCheck.ok !== true) {
    errors.push({ kind: stagePlanCheck.reason, missing: stagePlanCheck.missing || [] });
  }
  const rollbackWindow = clampInt(otaContract.rollback_window_minutes, 0, 60 * 24 * 7, 0);
  if (rollbackWindow < policy.min_rollback_window_minutes) {
    errors.push({
      kind: 'rollback_window_too_small',
      expected_min: policy.min_rollback_window_minutes,
      actual: rollbackWindow
    });
  }

  return {
    artifacts,
    errors,
    package_integrity_ok: errors.every((row: AnyObj) => !String(row.kind || '').includes('signature') && !String(row.kind || '').includes('digest')),
    ota_contract_ok: errors.every((row: AnyObj) => !String(row.kind || '').startsWith('ota_')),
    rollback_contract_ok: errors.every((row: AnyObj) => !String(row.kind || '').startsWith('rollback_')),
    parity_ok: errors.length === 0,
    build_revision: revisions.length === 1 ? revisions[0] : null,
    stage_plan: stagePlan
  };
}

function runAdapter(policy: AnyObj, channel: string) {
  if (policy.enabled !== true) {
    return {
      ok: true,
      type: 'chromeos_fuchsia_distribution_ota_adapter',
      ts: nowIso(),
      result: 'disabled_by_policy'
    };
  }

  const channelState = loadChannelState(policy.paths.channel_state_path);
  const frozen = channelState.frozen_channels[channel] || null;
  if (frozen) {
    return {
      ok: false,
      type: 'chromeos_fuchsia_distribution_ota_adapter',
      lane_id: 'V3-RACE-273',
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
    type: 'chromeos_fuchsia_distribution_ota_adapter',
    lane_id: 'V3-RACE-273',
    ts: nowIso(),
    channel,
    required_targets: policy.required_targets,
    build_revision: validation.build_revision,
    stage_plan: validation.stage_plan,
    package_count: validation.artifacts.length,
    package_integrity_ok: validation.package_integrity_ok,
    ota_contract_ok: validation.ota_contract_ok,
    rollback_contract_ok: validation.rollback_contract_ok,
    parity_ok: validation.parity_ok,
    errors: validation.errors,
    verification_receipt_id: `ota_cf_${stableHash(JSON.stringify(validation), 14)}`,
    rollback_procedure: {
      freeze: `node systems/ops/chromeos_fuchsia_distribution_ota_adapter.js freeze-channel --channel=${channel} --reason=<text>`,
      restore: `node systems/ops/chromeos_fuchsia_distribution_ota_adapter.js restore-channel --channel=${channel}`
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
  const channel = cleanText(args.channel || 'chromeos-stable', 80) || 'chromeos-stable';
  const out = runAdapter(policy, channel);
  persist(out, policy);
  return out;
}

function cmdFreeze(args: AnyObj, policy: AnyObj) {
  const channel = cleanText(args.channel || 'chromeos-stable', 80) || 'chromeos-stable';
  const reason = cleanText(args.reason || 'operator_freeze', 240) || 'operator_freeze';
  const state = loadChannelState(policy.paths.channel_state_path);
  state.frozen_channels[channel] = { reason, ts: nowIso() };
  saveChannelState(policy.paths.channel_state_path, state);
  return {
    ok: true,
    type: 'chromeos_fuchsia_distribution_ota_adapter_freeze',
    ts: nowIso(),
    channel,
    frozen: true,
    reason
  };
}

function cmdRestore(args: AnyObj, policy: AnyObj) {
  const channel = cleanText(args.channel || 'chromeos-stable', 80) || 'chromeos-stable';
  const state = loadChannelState(policy.paths.channel_state_path);
  if (state.frozen_channels[channel]) delete state.frozen_channels[channel];
  saveChannelState(policy.paths.channel_state_path, state);
  return {
    ok: true,
    type: 'chromeos_fuchsia_distribution_ota_adapter_restore',
    ts: nowIso(),
    channel,
    restored: true
  };
}

function cmdStatus(policy: AnyObj) {
  return {
    ok: true,
    type: 'chromeos_fuchsia_distribution_ota_adapter_status',
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
  signPackage
};
