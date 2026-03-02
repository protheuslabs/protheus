#!/usr/bin/env node
'use strict';
export {};

/**
 * Generic runtime helper for backlog lanes that need:
 * - strict memory/adaptive/system data-scope boundaries
 * - deterministic receipts
 * - optional JetStream mirror publication via event_sourced_control_plane
 */

const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  nowIso,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  parseArgs,
  emit
} = require('./queued_backlog_runtime');

const CONTROL_PLANE_CMD = process.env.EVENT_STREAM_CONTROL_PLANE_CMD
  ? path.resolve(process.env.EVENT_STREAM_CONTROL_PLANE_CMD)
  : path.join(ROOT, 'systems', 'ops', 'event_sourced_control_plane.js');

function defaultPolicy(paths: any, stream = 'upgrade.lane') {
  return {
    version: '1.0',
    enabled: true,
    strict_default: true,
    risk: {
      default_tier: 2,
      require_explicit_approval_tier: 3
    },
    event_stream: {
      enabled: true,
      publish: true,
      stream
    },
    paths: {
      memory_dir: paths.memory_dir,
      adaptive_index_path: paths.adaptive_index_path,
      events_path: paths.events_path,
      latest_path: paths.latest_path,
      receipts_path: paths.receipts_path
    }
  };
}

function loadPolicy(policyPath: string, defaults: any) {
  const raw = readJson(policyPath, {});
  const base = {
    ...defaults
  };
  const merged = {
    ...base,
    ...(raw && typeof raw === 'object' ? raw : {})
  };
  const risk = raw.risk && typeof raw.risk === 'object' ? raw.risk : {};
  const eventStream = raw.event_stream && typeof raw.event_stream === 'object' ? raw.event_stream : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    ...merged,
    version: cleanText(raw.version || base.version || '1.0', 32) || '1.0',
    enabled: raw.enabled !== false,
    strict_default: toBool(raw.strict_default, base.strict_default !== false),
    risk: {
      default_tier: clampInt(risk.default_tier, 1, 4, (base.risk && base.risk.default_tier) || 2),
      require_explicit_approval_tier: clampInt(
        risk.require_explicit_approval_tier,
        1,
        4,
        (base.risk && base.risk.require_explicit_approval_tier) || 3
      )
    },
    event_stream: {
      enabled: toBool(eventStream.enabled, base.event_stream ? base.event_stream.enabled !== false : true),
      publish: toBool(eventStream.publish, base.event_stream ? base.event_stream.publish !== false : true),
      stream: normalizeToken(
        eventStream.stream || (base.event_stream && base.event_stream.stream) || 'upgrade.lane',
        120
      ) || 'upgrade.lane'
    },
    paths: {
      memory_dir: resolvePath(paths.memory_dir, base.paths.memory_dir),
      adaptive_index_path: resolvePath(paths.adaptive_index_path, base.paths.adaptive_index_path),
      events_path: resolvePath(paths.events_path, base.paths.events_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function parseJson(raw: unknown, fallback: any = {}) {
  const txt = cleanText(raw || '', 20000);
  if (!txt) return fallback;
  try {
    const payload = JSON.parse(txt);
    if (payload && typeof payload === 'object') return payload;
    return fallback;
  } catch {
    return fallback;
  }
}

function ownerPath(policy: any, ownerId: string) {
  return path.join(policy.paths.memory_dir, `${ownerId}.json`);
}

function loadOwner(policy: any, ownerId: string) {
  const fallback = {
    owner_id: ownerId,
    preferences: {},
    updated_at: null
  };
  const row = readJson(ownerPath(policy, ownerId), fallback);
  return {
    owner_id: ownerId,
    preferences: row && row.preferences && typeof row.preferences === 'object' ? row.preferences : {},
    updated_at: row && row.updated_at ? String(row.updated_at) : null
  };
}

function saveOwner(policy: any, row: any) {
  writeJsonAtomic(ownerPath(policy, row.owner_id), row);
}

function loadAdaptive(policy: any) {
  const row = readJson(policy.paths.adaptive_index_path, { owners: [] });
  return {
    owners: Array.isArray(row && row.owners) ? row.owners : []
  };
}

function saveAdaptive(policy: any, row: any) {
  writeJsonAtomic(policy.paths.adaptive_index_path, row);
}

function appendReceipt(policy: any, payload: any) {
  writeJsonAtomic(policy.paths.latest_path, payload);
  appendJsonl(policy.paths.receipts_path, payload);
}

function publishEvent(policy: any, laneId: string, eventName: string, payload: any) {
  if (!policy.event_stream.enabled || !policy.event_stream.publish) {
    return { attempted: false, reason: 'event_stream_disabled' };
  }
  const payloadJson = JSON.stringify({
    lane_id: laneId,
    ts: nowIso(),
    ...payload
  });
  const proc = spawnSync('node', [
    CONTROL_PLANE_CMD,
    'append',
    `--stream=${policy.event_stream.stream}`,
    `--event=${normalizeToken(eventName, 120) || 'lane_event'}`,
    `--payload_json=${payloadJson}`
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10000
  });
  return {
    attempted: true,
    ok: Number(proc.status || 0) === 0,
    status: Number(proc.status || 0),
    stderr: cleanText(proc.stderr || '', 300)
  };
}

function commandPayload(args: any, reservedKeys: string[]) {
  const reserved = new Set(reservedKeys.concat([
    '_', 'help', 'policy', 'strict', 'apply', 'payload_json', 'prefs_json',
    'owner', 'owner_id', 'event', 'event_name', 'risk-tier', 'risk_tier',
    'approved', 'approval'
  ]));
  const payload: Record<string, any> = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (reserved.has(String(key))) continue;
    payload[String(key)] = value;
  }
  return payload;
}

function cmdConfigure(policy: any, args: any, laneId: string, reservedKeys: string[]) {
  const ownerId = normalizeToken(args.owner || args.owner_id, 120);
  if (!ownerId) return { ok: false, error: 'missing_owner' };

  const owner = loadOwner(policy, ownerId);
  const inputPrefs = parseJson(args.prefs_json, {});
  const inlinePrefs = commandPayload(args, reservedKeys);
  const prefs = {
    ...(owner.preferences || {}),
    ...(inputPrefs || {}),
    ...(inlinePrefs || {})
  };
  const ts = nowIso();
  saveOwner(policy, {
    owner_id: ownerId,
    preferences: prefs,
    updated_at: ts
  });

  const adaptive = loadAdaptive(policy);
  const nextOwners = adaptive.owners.filter((row: any) => String(row.owner_id) !== ownerId);
  nextOwners.push({
    owner_id: ownerId,
    preference_keys: Object.keys(prefs).sort(),
    preference_key_count: Object.keys(prefs).length,
    updated_at: ts
  });
  adaptive.owners = nextOwners.sort((a: any, b: any) => String(a.owner_id).localeCompare(String(b.owner_id)));
  saveAdaptive(policy, adaptive);

  return {
    ok: true,
    action: 'configure',
    lane_id: laneId,
    ts,
    owner_id: ownerId,
    preference_key_count: Object.keys(prefs).length,
    artifacts: {
      memory_owner_path: rel(ownerPath(policy, ownerId)),
      adaptive_index_path: rel(policy.paths.adaptive_index_path),
      policy_path: rel(policy.policy_path)
    }
  };
}

function cmdRecord(policy: any, args: any, laneId: string, reservedKeys: string[]) {
  const ownerId = normalizeToken(args.owner || args.owner_id, 120) || null;
  const eventName = normalizeToken(args.event || args.event_name || 'event', 120) || 'event';
  const apply = toBool(args.apply, true);
  const approved = toBool(args.approved != null ? args.approved : args.approval, false);
  const riskTier = clampInt(args['risk-tier'] != null ? args['risk-tier'] : args.risk_tier, 1, 4, policy.risk.default_tier);
  if (riskTier >= policy.risk.require_explicit_approval_tier && !approved) {
    return {
      ok: false,
      action: 'record',
      lane_id: laneId,
      error: 'approval_required_for_risk_tier',
      risk_tier: riskTier,
      require_explicit_approval_tier: policy.risk.require_explicit_approval_tier
    };
  }
  const payload = {
    ...parseJson(args.payload_json, {}),
    ...commandPayload(args, reservedKeys)
  };
  const row = {
    ts: nowIso(),
    type: `${normalizeToken(laneId, 64)}_event`,
    lane_id: laneId,
    event_id: `evt_${stableHash(`${laneId}|${eventName}|${Date.now()}`, 18)}`,
    owner_id: ownerId,
    event: eventName,
    risk_tier: riskTier,
    apply,
    approved,
    payload
  };
  if (apply) {
    appendJsonl(policy.paths.events_path, row);
  }
  const stream = publishEvent(policy, laneId, eventName, {
    owner_id: ownerId,
    event_id: row.event_id,
    risk_tier: riskTier,
    apply,
    approved,
    payload
  });
  return {
    ok: true,
    action: 'record',
    ...row,
    event_stream: stream,
    artifacts: {
      events_path: rel(policy.paths.events_path),
      receipts_path: rel(policy.paths.receipts_path),
      policy_path: rel(policy.policy_path)
    }
  };
}

function cmdStatus(policy: any, args: any, laneId: string) {
  const ownerId = normalizeToken(args.owner || args.owner_id, 120);
  const adaptive = loadAdaptive(policy);
  if (ownerId) {
    const owner = loadOwner(policy, ownerId);
    return {
      ok: true,
      action: 'status',
      lane_id: laneId,
      ts: nowIso(),
      owner_id: ownerId,
      preferences: owner.preferences,
      artifacts: {
        memory_owner_path: rel(ownerPath(policy, ownerId)),
        adaptive_index_path: rel(policy.paths.adaptive_index_path),
        policy_path: rel(policy.policy_path)
      }
    };
  }
  return {
    ok: true,
    action: 'status',
    lane_id: laneId,
    ts: nowIso(),
    owner_count: adaptive.owners.length,
    owners: adaptive.owners,
    artifacts: {
      adaptive_index_path: rel(policy.paths.adaptive_index_path),
      events_path: rel(policy.paths.events_path),
      policy_path: rel(policy.policy_path)
    }
  };
}

function runStandardLane(spec: any) {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  const command = cmd || 'status';
  const policyPath = args.policy
    ? path.resolve(String(args.policy))
    : spec.policy_path;
  const defaults = defaultPolicy(spec.paths, spec.event_stream || spec.stream || normalizeToken(spec.lane_id, 120));
  const policy = loadPolicy(policyPath, defaults);
  const laneId = String(spec.lane_id || 'UPGRADE-LANE');
  const reservedKeys = Array.isArray(spec.reserved_keys) ? spec.reserved_keys : [];
  let out;

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help) {
    if (typeof spec.usage === 'function') spec.usage();
    else {
      console.log(`Usage: node ${spec.script_rel} <configure|record|status> [flags]`);
    }
    process.exit(0);
    return;
  }

  if (spec.handlers && typeof spec.handlers[command] === 'function') {
    out = spec.handlers[command](policy, args, {
      lane_id: laneId,
      reserved_keys: reservedKeys,
      cmdRecord: (p: any, a: any) => cmdRecord(p, a, laneId, reservedKeys),
      cmdConfigure: (p: any, a: any) => cmdConfigure(p, a, laneId, reservedKeys),
      cmdStatus: (p: any, a: any) => cmdStatus(p, a, laneId)
    });
  } else if (['configure', 'set', 'set-pref', 'setpref'].includes(command)) {
    out = cmdConfigure(policy, args, laneId, reservedKeys);
  } else if (['record', 'run', 'propose', 'plan', 'allocate', 'vote', 'sync', 'scan', 'evaluate', 'publish'].includes(command)) {
    out = cmdRecord(policy, args, laneId, reservedKeys);
  } else if (command === 'status') {
    out = cmdStatus(policy, args, laneId);
  } else {
    if (typeof spec.usage === 'function') spec.usage();
    else console.log(`Unknown command: ${command}`);
    process.exit(2);
    return;
  }

  appendReceipt(policy, out);
  emit(out, out && out.ok ? 0 : 2);
}

module.exports = {
  runStandardLane,
  loadPolicy
};
