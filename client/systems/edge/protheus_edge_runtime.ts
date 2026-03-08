#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-189
 * Lightweight edge/mobile runtime lane.
 *
 * Usage:
 *   node systems/edge/protheus_edge_runtime.js configure --owner=<owner_id> [--remote-spine=<url>] [--cache-mode=memfs_cached]
 *   node systems/edge/protheus_edge_runtime.js start --owner=<owner_id> [--remote-spine=<url>] [--online=1] [--apply=1]
 *   node systems/edge/protheus_edge_runtime.js sync --owner=<owner_id> [--online=1] [--apply=1]
 *   node systems/edge/protheus_edge_runtime.js stop --owner=<owner_id> [--reason=<text>] [--apply=1]
 *   node systems/edge/protheus_edge_runtime.js rollback --owner=<owner_id> [--target-profile=offline_cache] [--apply=1]
 *   node systems/edge/protheus_edge_runtime.js status [--owner=<owner_id>]
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  cleanText,
  normalizeToken,
  toBool,
  readJson,
  writeJsonAtomic,
  stableHash
} = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.PROTHEUS_EDGE_POLICY_PATH
  ? path.resolve(process.env.PROTHEUS_EDGE_POLICY_PATH)
  : path.join(ROOT, 'config', 'protheus_edge_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/edge/protheus_edge_runtime.js configure --owner=<owner_id> [--remote-spine=<url>] [--cache-mode=memfs_cached]');
  console.log('  node systems/edge/protheus_edge_runtime.js start --owner=<owner_id> [--remote-spine=<url>] [--online=1] [--apply=1]');
  console.log('  node systems/edge/protheus_edge_runtime.js sync --owner=<owner_id> [--online=1] [--apply=1]');
  console.log('  node systems/edge/protheus_edge_runtime.js stop --owner=<owner_id> [--reason=<text>] [--apply=1]');
  console.log('  node systems/edge/protheus_edge_runtime.js rollback --owner=<owner_id> [--target-profile=offline_cache] [--apply=1]');
  console.log('  node systems/edge/protheus_edge_runtime.js status [--owner=<owner_id>]');
}

function ensureDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readState(policy: any) {
  return readJson(policy.paths.session_state_path, {
    schema_id: 'protheus_edge_session_state',
    schema_version: '1.0',
    active: false,
    owner_id: null,
    profile: 'offline_cache',
    cache_mode: 'memfs_cached',
    online: false,
    remote_spine: null,
    reflex_enabled: true,
    contract_lane_verified: false,
    last_sync_at: null,
    last_cache_snapshot_id: null,
    rollback_count: 0,
    updated_at: null
  });
}

function writeState(policy: any, state: any) {
  ensureDir(policy.paths.session_state_path);
  writeJsonAtomic(policy.paths.session_state_path, state);
}

function readCacheIndex(policy: any) {
  return readJson(policy.paths.cache_index_path, {
    schema_id: 'protheus_edge_cache_index',
    schema_version: '1.0',
    snapshots: []
  });
}

function writeCacheIndex(policy: any, indexRow: any) {
  ensureDir(policy.paths.cache_index_path);
  writeJsonAtomic(policy.paths.cache_index_path, indexRow);
}

function snapshotCache(policy: any, ownerId: string, profile: string, cacheMode: string) {
  const ts = nowIso();
  const snapshotId = `edge_cache_${stableHash(`${ownerId}|${profile}|${cacheMode}|${ts}`, 16)}`;
  const indexRow = readCacheIndex(policy);
  const snapshots = Array.isArray(indexRow.snapshots) ? indexRow.snapshots : [];
  snapshots.push({
    snapshot_id: snapshotId,
    owner_id: ownerId,
    profile,
    cache_mode: cacheMode,
    ts
  });
  const maxSnapshots = Math.max(10, Math.min(2000, Number(
    policy.edge_runtime && policy.edge_runtime.max_cache_snapshots != null
      ? policy.edge_runtime.max_cache_snapshots
      : 200
  )));
  while (snapshots.length > maxSnapshots) snapshots.shift();
  indexRow.snapshots = snapshots;
  writeCacheIndex(policy, indexRow);
  return snapshotId;
}

runStandardLane({
  lane_id: 'V3-RACE-189',
  script_rel: 'systems/edge/protheus_edge_runtime.js',
  policy_path: POLICY_PATH,
  stream: 'edge.runtime',
  paths: {
    memory_dir: 'memory/edge/protheus_edge',
    adaptive_index_path: 'adaptive/edge/protheus_edge/index.json',
    events_path: 'state/edge/protheus_edge/events.jsonl',
    latest_path: 'state/edge/protheus_edge/latest.json',
    receipts_path: 'state/edge/protheus_edge/receipts.jsonl',
    session_state_path: 'state/edge/protheus_edge/session_state.json',
    cache_index_path: 'state/edge/protheus_edge/cache_index.json'
  },
  usage,
  handlers: {
    start(policy: any, args: any, ctx: any) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      if (!ownerId) return { ok: false, error: 'missing_owner' };
      const apply = toBool(args.apply, true);
      const profile = normalizeToken(args.profile || 'mobile_seed', 80) || 'mobile_seed';
      const cacheMode = normalizeToken(args['cache-mode'] || args.cache_mode || 'memfs_cached', 80) || 'memfs_cached';
      const remoteSpine = cleanText(args['remote-spine'] || args.remote_spine || '', 260) || null;
      const online = toBool(args.online, !!remoteSpine);
      const reflexEnabled = toBool(args.reflex != null ? args.reflex : args.reflex_enabled, true);
      const contractLaneVerified = toBool(args['contract-lane-verified'] != null ? args['contract-lane-verified'] : args.contract_lane_verified, true);
      const fallbackMode = !online || !remoteSpine ? 'offline_cache' : 'remote_sync';
      const allowProfiles = Array.isArray(policy.edge_runtime && policy.edge_runtime.allow_profiles)
        ? policy.edge_runtime.allow_profiles.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
        : [];
      if (allowProfiles.length > 0 && !allowProfiles.includes(profile)) {
        return { ok: false, error: 'profile_not_allowed', profile, allow_profiles: allowProfiles };
      }
      const requireContractLane = policy.edge_runtime && policy.edge_runtime.require_contract_lane_verified === true;
      if (requireContractLane && !contractLaneVerified) {
        return { ok: false, error: 'contract_lane_verification_required', owner_id: ownerId, profile };
      }
      const signedSyncToken = stableHash(`${ownerId}|${remoteSpine || 'offline'}|${profile}|${cacheMode}`, 24);

      let snapshotId = null;
      if (apply) snapshotId = snapshotCache(policy, ownerId, profile, cacheMode);

      const state = readState(policy);
      const nextState = {
        ...state,
        active: apply,
        owner_id: ownerId,
        profile,
        cache_mode: cacheMode,
        online,
        remote_spine: remoteSpine,
        reflex_enabled: reflexEnabled,
        contract_lane_verified: contractLaneVerified,
        last_sync_at: online ? nowIso() : state.last_sync_at,
        last_cache_snapshot_id: snapshotId || state.last_cache_snapshot_id,
        updated_at: nowIso()
      };
      if (apply) writeState(policy, nextState);

      return ctx.cmdRecord(policy, {
        ...args,
        event: 'edge_start',
        apply,
        payload_json: JSON.stringify({
          owner_id: ownerId,
          profile,
          cache_mode: cacheMode,
          online,
          fallback_mode: fallbackMode,
          remote_spine: remoteSpine,
          reflex_enabled: reflexEnabled,
          contract_lane_verified: contractLaneVerified,
          signed_sync_token_hash: signedSyncToken,
          cache_snapshot_id: snapshotId,
          session_state_path: path.relative(ROOT, policy.paths.session_state_path).replace(/\\/g, '/'),
          cache_index_path: path.relative(ROOT, policy.paths.cache_index_path).replace(/\\/g, '/')
        })
      });
    },

    sync(policy: any, args: any, ctx: any) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      if (!ownerId) return { ok: false, error: 'missing_owner' };
      const apply = toBool(args.apply, true);
      const state = readState(policy);
      if (!state.active) {
        return {
          ok: false,
          error: 'edge_session_not_active',
          owner_id: ownerId,
          session_state_path: path.relative(ROOT, policy.paths.session_state_path).replace(/\\/g, '/')
        };
      }
      const online = toBool(args.online, state.online === true);
      const remoteSpine = cleanText(args['remote-spine'] || args.remote_spine || state.remote_spine || '', 260) || null;
      const offlineFallback = !online || !remoteSpine;
      const event = offlineFallback ? 'edge_sync_offline_fallback' : 'edge_sync_remote';
      const syncHash = stableHash(`${ownerId}|${remoteSpine || 'offline'}|${state.profile}|${nowIso()}`, 24);
      const snapshotId = apply ? snapshotCache(policy, ownerId, String(state.profile || 'mobile_seed'), String(state.cache_mode || 'memfs_cached')) : null;

      const nextState = {
        ...state,
        owner_id: ownerId,
        online,
        remote_spine: remoteSpine,
        last_sync_at: nowIso(),
        last_cache_snapshot_id: snapshotId || state.last_cache_snapshot_id,
        updated_at: nowIso()
      };
      if (apply) writeState(policy, nextState);

      return ctx.cmdRecord(policy, {
        ...args,
        event,
        apply,
        payload_json: JSON.stringify({
          owner_id: ownerId,
          online,
          remote_spine: remoteSpine,
          offline_fallback: offlineFallback,
          fallback_reason: offlineFallback ? 'remote_unavailable' : null,
          signed_sync_token_hash: syncHash,
          cache_snapshot_id: snapshotId || state.last_cache_snapshot_id,
          session_state_path: path.relative(ROOT, policy.paths.session_state_path).replace(/\\/g, '/')
        })
      });
    },

    stop(policy: any, args: any, ctx: any) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      if (!ownerId) return { ok: false, error: 'missing_owner' };
      const apply = toBool(args.apply, true);
      const reason = cleanText(args.reason || 'operator_stop', 240) || 'operator_stop';
      const state = readState(policy);
      const nextState = {
        ...state,
        active: false,
        owner_id: ownerId,
        updated_at: nowIso()
      };
      if (apply) writeState(policy, nextState);
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'edge_stop',
        apply,
        payload_json: JSON.stringify({
          owner_id: ownerId,
          reason,
          session_state_path: path.relative(ROOT, policy.paths.session_state_path).replace(/\\/g, '/')
        })
      });
    },

    rollback(policy: any, args: any, ctx: any) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      if (!ownerId) return { ok: false, error: 'missing_owner' };
      const apply = toBool(args.apply, true);
      const targetProfile = normalizeToken(args['target-profile'] || args.target_profile || 'offline_cache', 80) || 'offline_cache';
      const state = readState(policy);
      const nextState = {
        ...state,
        owner_id: ownerId,
        profile: targetProfile,
        active: false,
        online: false,
        rollback_count: Number(state.rollback_count || 0) + (apply ? 1 : 0),
        updated_at: nowIso()
      };
      if (apply) writeState(policy, nextState);
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'edge_profile_rollback',
        apply,
        payload_json: JSON.stringify({
          owner_id: ownerId,
          target_profile: targetProfile,
          rollback_count: nextState.rollback_count,
          session_state_path: path.relative(ROOT, policy.paths.session_state_path).replace(/\\/g, '/')
        })
      });
    },

    status(policy: any, args: any, ctx: any) {
      const base = ctx.cmdStatus(policy, args);
      const session = readState(policy);
      const cacheIndex = readCacheIndex(policy);
      return {
        ...base,
        edge_session: {
          active: session.active === true,
          owner_id: session.owner_id || null,
          profile: session.profile || null,
          cache_mode: session.cache_mode || null,
          online: session.online === true,
          remote_spine: session.remote_spine || null,
          reflex_enabled: session.reflex_enabled !== false,
          contract_lane_verified: session.contract_lane_verified === true,
          last_sync_at: session.last_sync_at || null,
          rollback_count: Number(session.rollback_count || 0),
          updated_at: session.updated_at || null
        },
        cache_snapshots: Array.isArray(cacheIndex.snapshots) ? cacheIndex.snapshots.length : 0,
        artifacts: {
          ...base.artifacts,
          session_state_path: path.relative(ROOT, policy.paths.session_state_path).replace(/\\/g, '/'),
          cache_index_path: path.relative(ROOT, policy.paths.cache_index_path).replace(/\\/g, '/')
        }
      };
    }
  }
});
