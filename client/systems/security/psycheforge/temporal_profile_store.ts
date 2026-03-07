#!/usr/bin/env node
'use strict';
export {};

const { spawnSync } = require('child_process');
const memorySurface = require('../../memory/index.js');
const {
  ROOT,
  nowIso,
  cleanText,
  readJson,
  writeJsonAtomic,
  resolveEncryptionKey,
  encryptJson
} = require('./_shared');

function parseJsonFromStdout(stdout: string) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function loadState(policy: Record<string, any>) {
  const src = readJson(policy.paths.profiles_path, {});
  const profiles = src && src.profiles && typeof src.profiles === 'object' ? src.profiles : {};
  return {
    schema_id: 'psycheforge_temporal_profiles',
    schema_version: '1.0',
    updated_at: src && src.updated_at ? String(src.updated_at) : nowIso(),
    profiles
  };
}

function saveState(policy: Record<string, any>, state: Record<string, any>) {
  writeJsonAtomic(policy.paths.profiles_path, {
    schema_id: 'psycheforge_temporal_profiles',
    schema_version: '1.0',
    updated_at: nowIso(),
    profiles: state.profiles && typeof state.profiles === 'object' ? state.profiles : {}
  });
}

function runRustHotStateSet(policy: Record<string, any>, key: string, profile: Record<string, any>) {
  const rustCfg = policy && policy.rust_memory && typeof policy.rust_memory === 'object' ? policy.rust_memory : {};
  if (rustCfg.enabled !== true) return { ok: false, skipped: true, reason: 'rust_memory_disabled' };
  const transport = cleanText(rustCfg.transport || 'memory_surface_ambient', 80) || 'memory_surface_ambient';

  if (transport !== 'legacy_cli') {
    const surface = memorySurface && typeof memorySurface.runMemoryCli === 'function'
      ? memorySurface.runMemoryCli('set-hot-state', [
          `--root=${cleanText(rustCfg.root || '.', 260) || '.'}`,
          `--key=${key}`,
          `--value_json=${JSON.stringify(profile)}`
        ], 45_000, {
          run_context: 'psycheforge_temporal_profile_store',
          ambient_mode: true
        })
      : null;
    const payload = surface && surface.payload && typeof surface.payload === 'object'
      ? surface.payload
      : null;
    const ok = Boolean(surface && surface.ok === true && payload && payload.ok === true);
    if (ok || rustCfg.allow_legacy_cli_fallback !== true) {
      return {
        ok,
        skipped: false,
        mode: 'memory_surface_ambient',
        status: Number.isFinite(Number(surface && surface.status)) ? Number(surface && surface.status) : (ok ? 0 : 1),
        payload,
        stderr: cleanText(surface && (surface.error || surface.stderr) || '', 280),
        engine: cleanText(surface && surface.engine || '', 120) || 'memory_surface_ambient'
      };
    }
  }

  const commandBase = Array.isArray(rustCfg.command_base) ? rustCfg.command_base.slice(0) : [];
  if (commandBase.length < 1) return { ok: false, skipped: true, reason: 'rust_command_base_missing' };

  const args = commandBase.concat([
    'set-hot-state',
    `--root=${cleanText(rustCfg.root || '.', 260) || '.'}`,
    `--key=${key}`,
    `--value_json=${JSON.stringify(profile)}`
  ]);
  if (cleanText(rustCfg.db_path || '', 520)) {
    args.push(`--db-path=${cleanText(rustCfg.db_path, 520)}`);
  }

  const proc = spawnSync(args[0], args.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 45_000
  });
  const payload = parseJsonFromStdout(proc.stdout);
  const ok = Number(proc.status || 0) === 0 && payload && payload.ok === true;
  return {
    ok,
    skipped: false,
    mode: 'legacy_cli_compat',
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    payload: payload && typeof payload === 'object' ? payload : null,
    stderr: cleanText(proc.stderr || '', 280)
  };
}

function persistProfile(policy: Record<string, any>, profile: Record<string, any>) {
  const actorId = cleanText(profile && profile.actor_id ? profile.actor_id : 'unknown_actor', 120) || 'unknown_actor';
  const state = loadState(policy);
  const keyInfo = resolveEncryptionKey(policy);
  const envelope = encryptJson(profile, keyInfo.key);
  const row = {
    profile_id: cleanText(profile.profile_id || '', 120),
    actor_id: actorId,
    behavior_class: cleanText(profile.behavior_class || '', 80),
    behavior_confidence: Number(profile.behavior_confidence || 0),
    stored_at: nowIso(),
    envelope
  };
  const prior = Array.isArray(state.profiles[actorId]) ? state.profiles[actorId] : [];
  state.profiles[actorId] = prior.concat([row]).slice(-60);
  saveState(policy, state);

  const rustKeyPrefix = cleanText(policy && policy.rust_memory && policy.rust_memory.key_prefix || 'psycheforge.profile', 120)
    || 'psycheforge.profile';
  const rustKey = `${rustKeyPrefix}:${actorId}`;
  const rustResult = runRustHotStateSet(policy, rustKey, {
    schema_id: 'psycheforge_profile_record',
    schema_version: '1.0',
    profile
  });

  return {
    ok: true,
    actor_id: actorId,
    profile_id: row.profile_id,
    local_persisted: true,
    rust_hot_state: rustResult
  };
}

function latestProfile(policy: Record<string, any>, actorIdRaw: unknown) {
  const actorId = cleanText(actorIdRaw || '', 120);
  if (!actorId) return null;
  const state = loadState(policy);
  const rows = Array.isArray(state.profiles[actorId]) ? state.profiles[actorId] : [];
  if (rows.length < 1) return null;
  return rows[rows.length - 1];
}

module.exports = {
  loadState,
  persistProfile,
  latestProfile
};
