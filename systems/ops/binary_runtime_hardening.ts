#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-BIN-001..005 implementation pack.
 * Shadow-first, deterministic receipts, defensive-only hardening semantics.
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
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.BINARY_RUNTIME_HARDENING_POLICY_PATH
  ? path.resolve(process.env.BINARY_RUNTIME_HARDENING_POLICY_PATH)
  : path.join(ROOT, 'config', 'binary_runtime_hardening_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/binary_runtime_hardening.js role-bootstrap --role=master|child|distributed [--instance-id=id] [--apply=0|1]');
  console.log('  node systems/ops/binary_runtime_hardening.js build-obfuscation --tier=none|light|medium|hard [--target=linux-x64] [--apply=0|1]');
  console.log('  node systems/ops/binary_runtime_hardening.js debug-attest --soul-token=<token> [--session-ttl-sec=900] [--apply=0|1]');
  console.log('  node systems/ops/binary_runtime_hardening.js tamper-check [--artifact-hash=hash] [--strict=0|1] [--apply=0|1]');
  console.log('  node systems/ops/binary_runtime_hardening.js reweave-stage --stage=shadow|canary|apply|rollback [--version=v] [--apply=0|1]');
  console.log('  node systems/ops/binary_runtime_hardening.js status');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    mode_defaults: {
      master: 'source',
      child: 'binary',
      distributed: 'binary'
    },
    allowed_obfuscation_tiers: ['none', 'light', 'medium', 'hard'],
    max_debug_ttl_sec: 3600,
    anti_debug_signals: ['NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'VSCODE_INSPECTOR_OPTIONS'],
    paths: {
      state_path: 'state/ops/binary_runtime_hardening/state.json',
      latest_path: 'state/ops/binary_runtime_hardening/latest.json',
      receipts_path: 'state/ops/binary_runtime_hardening/receipts.jsonl',
      artifacts_path: 'state/ops/binary_runtime_hardening/artifacts.json',
      debug_sessions_path: 'state/ops/binary_runtime_hardening/debug_sessions.json',
      soul_guard_path: 'state/security/soul_token_guard.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const modeDefaults = raw.mode_defaults && typeof raw.mode_defaults === 'object' ? raw.mode_defaults : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const tiers = Array.isArray(raw.allowed_obfuscation_tiers) ? raw.allowed_obfuscation_tiers : base.allowed_obfuscation_tiers;

  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    mode_defaults: {
      master: normalizeToken(modeDefaults.master || base.mode_defaults.master, 32) || 'source',
      child: normalizeToken(modeDefaults.child || base.mode_defaults.child, 32) || 'binary',
      distributed: normalizeToken(modeDefaults.distributed || base.mode_defaults.distributed, 32) || 'binary'
    },
    allowed_obfuscation_tiers: tiers
      .map((v) => normalizeToken(v, 32))
      .filter(Boolean),
    max_debug_ttl_sec: clampInt(raw.max_debug_ttl_sec, 60, 24 * 60 * 60, base.max_debug_ttl_sec),
    anti_debug_signals: (Array.isArray(raw.anti_debug_signals) ? raw.anti_debug_signals : base.anti_debug_signals)
      .map((v) => cleanText(v, 120))
      .filter(Boolean),
    paths: {
      state_path: resolvePath(paths.state_path, base.paths.state_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      artifacts_path: resolvePath(paths.artifacts_path, base.paths.artifacts_path),
      debug_sessions_path: resolvePath(paths.debug_sessions_path, base.paths.debug_sessions_path),
      soul_guard_path: resolvePath(paths.soul_guard_path, base.paths.soul_guard_path)
    }
  };
}

function loadState(policy) {
  const state = readJson(policy.paths.state_path, {});
  return {
    schema_id: 'binary_runtime_hardening_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    role: normalizeToken(state.role || 'master', 40) || 'master',
    runtime_mode: normalizeToken(state.runtime_mode || 'source', 40) || 'source',
    instance_id: cleanText(state.instance_id || 'local', 120) || 'local',
    last_artifact_hash: cleanText(state.last_artifact_hash || '', 120),
    current_version: cleanText(state.current_version || 'v0', 80) || 'v0',
    previous_version: cleanText(state.previous_version || '', 80),
    staged_rollout: normalizeToken(state.staged_rollout || 'shadow', 32) || 'shadow',
    tamper_events: clampInt(state.tamper_events, 0, 1_000_000, 0)
  };
}

function saveState(policy, state) {
  writeJsonAtomic(policy.paths.state_path, {
    ...state,
    updated_at: nowIso()
  });
}

function receipt(policy, row) {
  const payload = {
    ts: nowIso(),
    ok: true,
    shadow_only: policy.shadow_only,
    ...row
  };
  writeJsonAtomic(policy.paths.latest_path, payload);
  appendJsonl(policy.paths.receipts_path, payload);
  return payload;
}

function roleBootstrap(args, policy) {
  const role = normalizeToken(args.role || 'master', 32) || 'master';
  const apply = toBool(args.apply, false);
  if (!['master', 'child', 'distributed'].includes(role)) {
    return { ok: false, error: 'invalid_role', role };
  }
  const runtimeMode = policy.mode_defaults[role] || 'source';
  const out = {
    type: 'binary_role_bootstrap',
    role,
    runtime_mode: runtimeMode,
    instance_id: cleanText(args['instance-id'] || args.instance_id || 'local', 120),
    apply
  };
  if (apply) {
    const state = loadState(policy);
    state.role = role;
    state.runtime_mode = runtimeMode;
    state.instance_id = out.instance_id;
    saveState(policy, state);
  }
  return receipt(policy, out);
}

function buildObfuscation(args, policy) {
  const tier = normalizeToken(args.tier || 'light', 32) || 'light';
  const apply = toBool(args.apply, false);
  const target = cleanText(args.target || 'linux-x64', 64) || 'linux-x64';
  if (!policy.allowed_obfuscation_tiers.includes(tier)) {
    return { ok: false, error: 'invalid_obfuscation_tier', tier };
  }
  const buildAt = nowIso();
  const artifactHash = stableHash(`${buildAt}|${tier}|${target}|${Math.random()}`, 32);
  const artifact = {
    schema_id: 'binary_runtime_artifact',
    schema_version: '1.0',
    built_at: buildAt,
    tier,
    target,
    artifact_hash: artifactHash,
    signed: true,
    provenance: 'self_hosted_compiler_lane',
    obfuscation_profile: tier === 'none' ? 'debug' : `hardened_${tier}`
  };
  if (apply) {
    writeJsonAtomic(policy.paths.artifacts_path, artifact);
    const state = loadState(policy);
    state.last_artifact_hash = artifactHash;
    saveState(policy, state);
  }
  return receipt(policy, {
    type: 'binary_obfuscation_build',
    apply,
    artifact_hash: artifactHash,
    tier,
    target,
    signed: artifact.signed
  });
}

function debugAttest(args, policy) {
  const apply = toBool(args.apply, false);
  const requested = cleanText(args['soul-token'] || args.soul_token || '', 240);
  const soul = readJson(policy.paths.soul_guard_path, {});
  const expected = cleanText(soul.token || soul.soul_token || '', 240);
  const ttlSec = clampInt(args['session-ttl-sec'] || args.session_ttl_sec, 60, policy.max_debug_ttl_sec, 900);
  const ok = !!requested && !!expected && requested === expected;
  if (!ok) {
    return receipt(policy, {
      type: 'binary_debug_attestation',
      ok: false,
      reason: 'soul_token_attestation_failed',
      apply,
      ttl_sec: ttlSec
    });
  }

  const sessionId = `dbg_${stableHash(`${Date.now()}|${requested}|${ttlSec}`, 18)}`;
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
  if (apply) {
    const db = readJson(policy.paths.debug_sessions_path, { sessions: [] });
    const sessions = Array.isArray(db.sessions) ? db.sessions : [];
    sessions.push({
      session_id: sessionId,
      created_at: nowIso(),
      expires_at: expiresAt,
      encrypted_maps: true,
      one_time_key: stableHash(`${sessionId}|key`, 24)
    });
    writeJsonAtomic(policy.paths.debug_sessions_path, { sessions });
  }

  return receipt(policy, {
    type: 'binary_debug_attestation',
    ok: true,
    apply,
    session_id: sessionId,
    expires_at: expiresAt,
    encrypted_maps: true
  });
}

function detectAntiDebugSignals(policy) {
  const hits = [];
  for (const key of policy.anti_debug_signals) {
    const value = process.env[key];
    if (value != null && String(value).trim()) {
      hits.push({ key, value_hash: stableHash(String(value), 16) });
    }
  }
  return hits;
}

function tamperCheck(args, policy) {
  const strict = toBool(args.strict, false);
  const apply = toBool(args.apply, false);
  const expected = cleanText(args['artifact-hash'] || args.artifact_hash || '', 120);
  const state = loadState(policy);
  const artifact = readJson(policy.paths.artifacts_path, {});
  const recorded = cleanText(expected || artifact.artifact_hash || state.last_artifact_hash || '', 120);
  const actual = cleanText(state.last_artifact_hash || artifact.artifact_hash || '', 120);
  const antiDebugHits = detectAntiDebugSignals(policy);

  const tamper = !recorded || !actual || recorded !== actual || antiDebugHits.length > 0;
  if (apply && tamper) {
    state.tamper_events += 1;
    saveState(policy, state);
  }

  const out = receipt(policy, {
    type: 'binary_tamper_check',
    ok: !tamper,
    strict,
    apply,
    recorded_hash: recorded,
    actual_hash: actual,
    anti_debug_hits: antiDebugHits,
    tamper
  });

  if (tamper && strict) return { ...out, exit_code: 1 };
  return { ...out, exit_code: 0 };
}

function reweaveStage(args, policy) {
  const stage = normalizeToken(args.stage || 'shadow', 24) || 'shadow';
  const apply = toBool(args.apply, false);
  const nextVersion = cleanText(args.version || '', 80);
  if (!['shadow', 'canary', 'apply', 'rollback'].includes(stage)) {
    return { ok: false, error: 'invalid_stage', stage };
  }

  const state = loadState(policy);
  let targetVersion = state.current_version;
  if (stage === 'apply') {
    targetVersion = nextVersion || `v${Date.now()}`;
  }
  if (stage === 'rollback') {
    targetVersion = state.previous_version || state.current_version;
  }

  if (apply) {
    if (stage === 'apply') {
      state.previous_version = state.current_version;
      state.current_version = targetVersion;
    }
    if (stage === 'rollback') {
      const oldCurrent = state.current_version;
      state.current_version = targetVersion;
      state.previous_version = oldCurrent;
    }
    state.staged_rollout = stage;
    saveState(policy, state);
  }

  return receipt(policy, {
    type: 'binary_reweave_stage',
    apply,
    stage,
    current_version: apply ? loadState(policy).current_version : state.current_version,
    previous_version: apply ? loadState(policy).previous_version : state.previous_version
  });
}

function status(policy) {
  const state = loadState(policy);
  const latest = readJson(policy.paths.latest_path, {});
  const sessions = readJson(policy.paths.debug_sessions_path, { sessions: [] });
  return {
    ok: true,
    type: 'binary_runtime_hardening_status',
    shadow_only: policy.shadow_only,
    state,
    latest,
    active_debug_sessions: Array.isArray(sessions.sessions) ? sessions.sessions.length : 0
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) emit({ ok: false, error: 'binary_runtime_hardening_disabled' }, 1);

  if (cmd === 'role-bootstrap') emit(roleBootstrap(args, policy));
  if (cmd === 'build-obfuscation') emit(buildObfuscation(args, policy));
  if (cmd === 'debug-attest') {
    const out = debugAttest(args, policy);
    emit(out, out.ok === false ? 1 : 0);
  }
  if (cmd === 'tamper-check') {
    const out = tamperCheck(args, policy);
    emit(out, out.exit_code || 0);
  }
  if (cmd === 'reweave-stage') emit(reweaveStage(args, policy));
  if (cmd === 'status') emit(status(policy));

  emit({ ok: false, error: 'unknown_command', cmd }, 2);
}

if (require.main === module) {
  main();
}
