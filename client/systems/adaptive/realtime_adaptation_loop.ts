#!/usr/bin/env node
'use strict';
export {};

/**
 * V6-ADAPT-001 / REQ-19-001
 * V6-ADAPT-002 / REQ-19-002
 * V6-ADAPT-003 / REQ-19-003
 */

const os = require('os');
const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  clampInt,
  toBool,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.REALTIME_ADAPTATION_LOOP_POLICY_PATH
  ? path.resolve(process.env.REALTIME_ADAPTATION_LOOP_POLICY_PATH)
  : path.join(ROOT, 'client', 'config', 'realtime_adaptation_loop_policy.json');

type AnyObj = Record<string, any>;

function usage() {
  console.log('Usage:');
  console.log('  node systems/adaptive/realtime_adaptation_loop.js cycle [--trigger=interaction|heartbeat] [--profile=default|low_power] [--interaction-id=<id>] [--heartbeat-id=<id>] [--cpu-ms=<n>] [--tokens=<n>] [--memory-mb=<n>] [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/adaptive/realtime_adaptation_loop.js verify-continuity [--policy=<path>]');
  console.log('  node systems/adaptive/realtime_adaptation_loop.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    min_cycle_interval_ms: 30000,
    resource_ceilings: {
      max_cpu_ms: 250,
      max_tokens: 4096,
      max_memory_mb: 512
    },
    profiles: {
      default: {
        cadence_multiplier: 1,
        cpu_multiplier: 1,
        tokens_multiplier: 1,
        memory_multiplier: 1
      },
      low_power: {
        cadence_multiplier: 2,
        cpu_multiplier: 0.6,
        tokens_multiplier: 0.65,
        memory_multiplier: 0.75
      }
    },
    paths: {
      state_path: 'state/adaptive/realtime_adaptation_loop/state.json',
      latest_path: 'state/adaptive/realtime_adaptation_loop/latest.json',
      receipts_path: 'state/adaptive/realtime_adaptation_loop/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const ceilings = raw.resource_ceilings && typeof raw.resource_ceilings === 'object'
    ? raw.resource_ceilings
    : {};
  const profiles = raw.profiles && typeof raw.profiles === 'object' ? raw.profiles : {};
  const baseProfiles = base.profiles || {};
  const defaultProfile = profiles.default && typeof profiles.default === 'object' ? profiles.default : {};
  const lowPowerProfile = profiles.low_power && typeof profiles.low_power === 'object' ? profiles.low_power : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 24) || '1.0',
    enabled: toBool(raw.enabled, true),
    min_cycle_interval_ms: clampInt(raw.min_cycle_interval_ms, 1000, 3600000, base.min_cycle_interval_ms),
    resource_ceilings: {
      max_cpu_ms: clampInt(ceilings.max_cpu_ms, 10, 10000, base.resource_ceilings.max_cpu_ms),
      max_tokens: clampInt(ceilings.max_tokens, 64, 1000000, base.resource_ceilings.max_tokens),
      max_memory_mb: clampInt(ceilings.max_memory_mb, 32, 16384, base.resource_ceilings.max_memory_mb)
    },
    profiles: {
      default: {
        cadence_multiplier: Number(defaultProfile.cadence_multiplier ?? baseProfiles.default.cadence_multiplier) || 1,
        cpu_multiplier: Number(defaultProfile.cpu_multiplier ?? baseProfiles.default.cpu_multiplier) || 1,
        tokens_multiplier: Number(defaultProfile.tokens_multiplier ?? baseProfiles.default.tokens_multiplier) || 1,
        memory_multiplier: Number(defaultProfile.memory_multiplier ?? baseProfiles.default.memory_multiplier) || 1
      },
      low_power: {
        cadence_multiplier: Number(lowPowerProfile.cadence_multiplier ?? baseProfiles.low_power.cadence_multiplier) || 2,
        cpu_multiplier: Number(lowPowerProfile.cpu_multiplier ?? baseProfiles.low_power.cpu_multiplier) || 0.6,
        tokens_multiplier: Number(lowPowerProfile.tokens_multiplier ?? baseProfiles.low_power.tokens_multiplier) || 0.65,
        memory_multiplier: Number(lowPowerProfile.memory_multiplier ?? baseProfiles.low_power.memory_multiplier) || 0.75
      }
    },
    paths: {
      state_path: resolvePath(paths.state_path, base.paths.state_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    }
  };
}

function statePayloadForHash(state: AnyObj) {
  return {
    cycle_count: clampInt(state.cycle_count, 0, 100000000, 0),
    last_cycle_at: cleanText(state.last_cycle_at || '', 80) || null,
    last_trigger: normalizeToken(state.last_trigger || '', 40) || null,
    last_receipt_id: cleanText(state.last_receipt_id || '', 120) || null,
    continuity_hash: cleanText(state.continuity_hash || '', 120) || null
  };
}

function stateIntegrityHash(state: AnyObj) {
  return stableHash(JSON.stringify(statePayloadForHash(state)), 24);
}

function continuityCheck(state: AnyObj) {
  const payload = statePayloadForHash(state);
  const expectedHash = stateIntegrityHash(state);
  const actualHash = cleanText(state.state_integrity_hash || '', 120) || null;
  const bootstrap = payload.cycle_count === 0 && !payload.last_cycle_at && !actualHash;
  const legacyUnsealed = !bootstrap && !actualHash;
  return {
    ok: bootstrap || legacyUnsealed || (actualHash != null && actualHash === expectedHash),
    bootstrap,
    legacy_unsealed: legacyUnsealed,
    expected_hash: expectedHash,
    actual_hash: actualHash
  };
}

function loadState(policy: AnyObj) {
  const raw = readJson(policy.paths.state_path, {});
  return {
    schema_id: 'realtime_adaptation_loop_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    cycle_count: clampInt(raw.cycle_count, 0, 100000000, 0),
    last_cycle_at: cleanText(raw.last_cycle_at || '', 80) || null,
    last_trigger: normalizeToken(raw.last_trigger || '', 40) || null,
    last_receipt_id: cleanText(raw.last_receipt_id || '', 120) || null,
    continuity_hash: cleanText(raw.continuity_hash || '', 120) || null,
    state_integrity_hash: cleanText(raw.state_integrity_hash || '', 120) || null
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  const next = { ...state, updated_at: nowIso() };
  next.state_integrity_hash = stateIntegrityHash(next);
  writeJsonAtomic(policy.paths.state_path, next);
  return next;
}

function parseTrigger(raw: unknown) {
  const trigger = normalizeToken(raw || 'interaction', 40) || 'interaction';
  return trigger === 'heartbeat' ? 'heartbeat' : 'interaction';
}

function parseMetrics(args: AnyObj) {
  return {
    cpu_ms: clampInt(args['cpu-ms'] ?? args.cpu_ms, 0, 1000000, 0),
    tokens: clampInt(args.tokens, 0, 100000000, 0),
    memory_mb: clampInt(args['memory-mb'] ?? args.memory_mb, 0, 1000000, 0)
  };
}

function parseProfile(raw: unknown) {
  const profile = normalizeToken(raw || 'default', 40) || 'default';
  return profile === 'low_power' ? 'low_power' : 'default';
}

function resolveProfileBudgets(policy: AnyObj, profile: string) {
  const selected = profile === 'low_power' ? policy.profiles.low_power : policy.profiles.default;
  const cadenceMul = Number(selected.cadence_multiplier) > 0 ? Number(selected.cadence_multiplier) : 1;
  const cpuMul = Number(selected.cpu_multiplier) > 0 ? Number(selected.cpu_multiplier) : 1;
  const tokenMul = Number(selected.tokens_multiplier) > 0 ? Number(selected.tokens_multiplier) : 1;
  const memMul = Number(selected.memory_multiplier) > 0 ? Number(selected.memory_multiplier) : 1;
  return {
    profile,
    profile_multipliers: {
      cadence_multiplier: cadenceMul,
      cpu_multiplier: cpuMul,
      tokens_multiplier: tokenMul,
      memory_multiplier: memMul
    },
    min_cycle_interval_ms: Math.max(1000, Math.floor(policy.min_cycle_interval_ms * cadenceMul)),
    resource_ceilings: {
      max_cpu_ms: Math.max(1, Math.floor(policy.resource_ceilings.max_cpu_ms * cpuMul)),
      max_tokens: Math.max(1, Math.floor(policy.resource_ceilings.max_tokens * tokenMul)),
      max_memory_mb: Math.max(1, Math.floor(policy.resource_ceilings.max_memory_mb * memMul))
    }
  };
}

function detectHardwareProfile(args: AnyObj) {
  const cpuCount = Array.isArray(os.cpus()) ? os.cpus().length : 1;
  const arch = cleanText(args.arch || process.arch, 40) || process.arch;
  const platform = cleanText(args.platform || process.platform, 40) || process.platform;
  const normalizedArch = normalizeToken(arch, 40);
  return {
    platform,
    arch,
    cpu_count: clampInt(args['cpu-count'] ?? args.cpu_count, 1, 4096, cpuCount),
    low_power_class: normalizedArch === 'arm64' || normalizedArch === 'arm' || normalizedArch === 'aarch64'
  };
}

function cycle(args: AnyObj, policy: AnyObj) {
  const apply = toBool(args.apply, true);
  const trigger = parseTrigger(args.trigger);
  const profile = parseProfile(args.profile);
  const budgets = resolveProfileBudgets(policy, profile);
  const interactionId = cleanText(args['interaction-id'] || args.interaction_id || '', 120) || null;
  const heartbeatId = cleanText(args['heartbeat-id'] || args.heartbeat_id || '', 120) || null;
  const hardwareProfile = detectHardwareProfile(args);
  const metrics = parseMetrics(args);
  const state = loadState(policy);
  const integrity = continuityCheck(state);
  const ts = nowIso();
  const nowMs = Date.parse(ts);
  const lastMs = state.last_cycle_at ? Date.parse(String(state.last_cycle_at)) : NaN;
  const elapsedMs = Number.isFinite(lastMs) ? Math.max(0, nowMs - lastMs) : null;

  const reasons: string[] = [];
  if (!integrity.ok) reasons.push('continuity_integrity_violation');
  if (elapsedMs != null && elapsedMs < budgets.min_cycle_interval_ms) reasons.push('cadence_throttle');
  if (metrics.cpu_ms > budgets.resource_ceilings.max_cpu_ms) reasons.push('cpu_ceiling_exceeded');
  if (metrics.tokens > budgets.resource_ceilings.max_tokens) reasons.push('token_ceiling_exceeded');
  if (metrics.memory_mb > budgets.resource_ceilings.max_memory_mb) reasons.push('memory_ceiling_exceeded');

  const allowed = reasons.length === 0;
  const nextCycle = allowed ? Number(state.cycle_count || 0) + 1 : Number(state.cycle_count || 0);
  const receiptId = stableHash([
    'realtime_adaptation_cycle',
    trigger,
    interactionId || '',
    heartbeatId || '',
    String(nextCycle),
    ts
  ].join('|'), 24);

  const receipt = {
    schema_id: 'realtime_adaptation_cycle_receipt',
    schema_version: '1.0',
    artifact_type: 'receipt',
    type: 'realtime_adaptation_cycle',
    ok: allowed,
    ts,
    receipt_id: receiptId,
    trigger,
    profile,
    interaction_id: interactionId,
    heartbeat_id: heartbeatId,
    cycle_count_before: Number(state.cycle_count || 0),
    cycle_count_after: nextCycle,
    hardware_profile: hardwareProfile,
    cadence: {
      min_cycle_interval_ms: budgets.min_cycle_interval_ms,
      elapsed_ms: elapsedMs
    },
    resource_ceilings: budgets.resource_ceilings,
    profile_multipliers: budgets.profile_multipliers,
    observed_metrics: metrics,
    continuity: integrity,
    blocked_reasons: reasons,
    apply
  };

  if (allowed && apply) {
    const continuityHash = stableHash(JSON.stringify({
      cycle_count: nextCycle,
      trigger,
      resource_ceilings: policy.resource_ceilings,
      observed_metrics: metrics
    }), 24);
    const nextState = saveState(policy, {
      ...state,
      cycle_count: nextCycle,
      last_cycle_at: ts,
      last_trigger: trigger,
      last_receipt_id: receiptId,
      continuity_hash: continuityHash
    });
    receipt.state_path = path.relative(ROOT, policy.paths.state_path).replace(/\\/g, '/');
    receipt.continuity_hash = nextState.continuity_hash;
  }

  writeJsonAtomic(policy.paths.latest_path, receipt);
  appendJsonl(policy.paths.receipts_path, receipt);
  return receipt;
}

function status(policy: AnyObj) {
  const state = loadState(policy);
  const integrity = continuityCheck(state);
  return {
    ok: true,
    type: 'realtime_adaptation_loop_status',
    policy: {
      version: policy.version,
      min_cycle_interval_ms: policy.min_cycle_interval_ms,
      resource_ceilings: policy.resource_ceilings,
      profiles: policy.profiles
    },
    state,
    continuity: integrity,
    latest: readJson(policy.paths.latest_path, null)
  };
}

function verifyContinuity(policy: AnyObj) {
  const state = loadState(policy);
  const integrity = continuityCheck(state);
  return {
    ok: integrity.ok,
    type: 'realtime_adaptation_continuity_verification',
    state,
    continuity: integrity
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 40) || 'status';
  if (cmd === 'help' || args.help) {
    usage();
    return;
  }
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) emit({ ok: false, error: 'realtime_adaptation_loop_disabled' }, 1);
  if (cmd === 'cycle') emit(cycle(args, policy), 0);
  if (cmd === 'verify-continuity') {
    const verification = verifyContinuity(policy);
    emit(verification, verification.ok ? 0 : 1);
  }
  if (cmd === 'status') emit(status(policy), 0);
  emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
}

main();
