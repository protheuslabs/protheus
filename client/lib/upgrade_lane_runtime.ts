#!/usr/bin/env node
'use strict';
export {};

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
  ensureDir,
  resolvePath,
  stableHash,
  emit
} = require('./queued_backlog_runtime');

type AnyObj = Record<string, any>;

function rel(filePath: string) {
  return path.relative(ROOT, String(filePath || '')).replace(/\\/g, '/');
}

function parseJsonLoose(raw: unknown) {
  const txt = cleanText(raw || '', 120000);
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function stripArgsMeta(args: AnyObj) {
  const out: AnyObj = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (key === '_') continue;
    out[key] = value;
  }
  return out;
}

function defaultLaneType(scriptRel: string, laneId: string) {
  const fromScript = normalizeToken(path.basename(String(scriptRel || ''), '.js'), 120);
  if (fromScript) return fromScript;
  return normalizeToken(laneId || 'upgrade_lane', 120) || 'upgrade_lane';
}

function normalizePolicy(opts: AnyObj, policyPath: string, rawPolicy: AnyObj) {
  const basePaths = opts.paths && typeof opts.paths === 'object' ? opts.paths : {};
  const pathsRaw = rawPolicy.paths && typeof rawPolicy.paths === 'object' ? rawPolicy.paths : {};
  const defaultPaths = {
    memory_dir: 'memory/ops/lanes',
    adaptive_index_path: 'adaptive/ops/lanes/index.json',
    events_path: 'state/ops/lanes/events.jsonl',
    latest_path: 'state/ops/lanes/latest.json',
    receipts_path: 'state/ops/lanes/receipts.jsonl'
  };
  const resolvedPaths: AnyObj = {};
  const pathKeys = new Set<string>([
    ...Object.keys(defaultPaths),
    ...Object.keys(basePaths),
    ...Object.keys(pathsRaw)
  ]);
  for (const key of pathKeys) {
    const rawValue = Object.prototype.hasOwnProperty.call(pathsRaw, key) ? pathsRaw[key] : undefined;
    const baseValue = Object.prototype.hasOwnProperty.call(basePaths, key) ? basePaths[key] : undefined;
    const fallback = Object.prototype.hasOwnProperty.call(defaultPaths, key)
      ? (defaultPaths as AnyObj)[key]
      : null;
    const selected = rawValue != null ? rawValue : (baseValue != null ? baseValue : fallback);
    if (selected == null) continue;
    resolvedPaths[key] = resolvePath(selected, String(selected));
  }
  return {
    version: cleanText(rawPolicy.version || '1.0', 32) || '1.0',
    enabled: rawPolicy.enabled !== false,
    strict_default: toBool(rawPolicy.strict_default, true),
    owner_id: normalizeToken(rawPolicy.owner_id || '', 120),
    event_stream: {
      enabled: toBool(rawPolicy.event_stream && rawPolicy.event_stream.enabled, true),
      publish: toBool(rawPolicy.event_stream && rawPolicy.event_stream.publish, true),
      stream: cleanText(
        (rawPolicy.event_stream && rawPolicy.event_stream.stream) || opts.stream || '',
        180
      )
    },
    paths: resolvedPaths,
    policy_path: path.resolve(policyPath)
  };
}

function persistAdaptiveIndex(policy: AnyObj, row: AnyObj) {
  const prev = readJson(policy.paths.adaptive_index_path, null);
  const next = prev && typeof prev === 'object' ? { ...prev } : {};
  next.schema_id = next.schema_id || 'upgrade_lane_runtime_adaptive_index';
  next.schema_version = next.schema_version || '1.0';
  next.updated_at = row.ts;
  next.latest = {
    lane_id: row.lane_id,
    event: row.event || null,
    action: row.action || null,
    ok: row.ok === true,
    receipt_hash: row.receipt_hash || null
  };
  writeJsonAtomic(policy.paths.adaptive_index_path, next);
}

function persistRow(policy: AnyObj, row: AnyObj) {
  writeJsonAtomic(policy.paths.latest_path, row);
  appendJsonl(policy.paths.receipts_path, row);
  appendJsonl(policy.paths.events_path, row);
  ensureDir(policy.paths.memory_dir);
  persistAdaptiveIndex(policy, row);
}

function defaultConfigureRecord(opts: AnyObj, laneType: string, laneId: string, args: AnyObj, policy: AnyObj, ctx: AnyObj) {
  return ctx.cmdRecord(policy, {
    ...stripArgsMeta(args),
    action: 'configure',
    event: `${laneType}_configure`,
    payload_json: JSON.stringify({
      lane_id: laneId,
      configured: true,
      strict_default: policy.strict_default,
      stream: policy.event_stream.stream || null
    })
  });
}

function runStandardLane(opts: AnyObj) {
  const args = parseArgs(process.argv.slice(2));
  const laneId = cleanText(opts.lane_id || 'UNKNOWN-LANE', 120) || 'UNKNOWN-LANE';
  const laneType = defaultLaneType(opts.script_rel || '', laneId);
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';

  if (args.help || cmd === 'help') {
    if (typeof opts.usage === 'function') {
      opts.usage();
    }
    emit({ ok: true, lane_id: laneId, type: `${laneType}_help`, action: 'help', ts: nowIso() }, 0);
  }

  const policyPath = args.policy
    ? path.resolve(String(args.policy))
    : path.resolve(String(opts.policy_path || ''));
  const rawPolicy = readJson(policyPath, {});
  const policy = normalizePolicy(opts, policyPath, rawPolicy);
  const strict = toBool(args.strict, policy.strict_default);
  const apply = toBool(args.apply, true);

  if (policy.enabled === false) {
    emit({
      ok: false,
      lane_id: laneId,
      type: `${laneType}_disabled`,
      action: cmd,
      ts: nowIso(),
      error: 'lane_disabled',
      policy_path: rel(policy.policy_path)
    }, 2);
  }

  function cmdRecord(recordPolicy: AnyObj, recordArgs: AnyObj) {
    const ts = nowIso();
    const owner = normalizeToken(
      recordArgs.owner || args.owner || recordPolicy.owner_id || 'system',
      120
    ) || 'system';
    const riskTier = clampInt(recordArgs['risk-tier'] || recordArgs.risk_tier || args['risk-tier'] || args.risk_tier || 2, 0, 5, 2);
    const event = normalizeToken(recordArgs.event || `${laneType}_${cmd}`, 160) || `${laneType}_${cmd}`;
    const parsedPayload = parseJsonLoose(recordArgs.payload_json);
    const payload = parsedPayload && typeof parsedPayload === 'object'
      ? parsedPayload
      : (parsedPayload == null ? {} : { value: parsedPayload });
    const out: AnyObj = {
      ok: true,
      lane_id: laneId,
      type: cleanText(recordArgs.type || laneType, 120) || laneType,
      action: cleanText(recordArgs.action || 'record', 80) || 'record',
      event,
      ts,
      owner,
      risk_tier: riskTier,
      strict,
      apply,
      stream: recordPolicy.event_stream.stream || null,
      policy_path: rel(recordPolicy.policy_path),
      script: cleanText(opts.script_rel || '', 260) || null,
      payload
    };
    out.receipt_hash = stableHash(JSON.stringify({
      lane_id: out.lane_id,
      event: out.event,
      ts: out.ts,
      owner: out.owner,
      payload: out.payload
    }), 32);
    if (apply) {
      persistRow(recordPolicy, out);
    }
    return out;
  }

  function cmdStatus(recordPolicy: AnyObj, _statusArgs: AnyObj) {
    return {
      ok: true,
      lane_id: laneId,
      type: `${laneType}_status`,
      action: 'status',
      ts: nowIso(),
      latest: readJson(recordPolicy.paths.latest_path, {}),
      policy_path: rel(recordPolicy.policy_path),
      artifacts: {
        memory_dir: rel(recordPolicy.paths.memory_dir),
        adaptive_index_path: rel(recordPolicy.paths.adaptive_index_path),
        events_path: rel(recordPolicy.paths.events_path),
        latest_path: rel(recordPolicy.paths.latest_path),
        receipts_path: rel(recordPolicy.paths.receipts_path)
      }
    };
  }

  const ctx = {
    cmdRecord,
    cmdStatus,
    ROOT,
    args,
    lane_id: laneId,
    lane_type: laneType,
    strict,
    apply
  };

  let result: AnyObj;
  if (cmd === 'status' && opts.handlers && typeof opts.handlers.status === 'function') {
    result = opts.handlers.status(policy, args, ctx);
  } else if (cmd === 'status') {
    emit(cmdStatus(policy, args), 0);
  } else if (cmd === 'configure') {
    result = defaultConfigureRecord(opts, laneType, laneId, args, policy, ctx);
  } else if (opts.handlers && typeof opts.handlers[cmd] === 'function') {
    result = opts.handlers[cmd](policy, args, ctx);
  } else {
    emit({
      ok: false,
      lane_id: laneId,
      type: `${laneType}_error`,
      action: cmd,
      ts: nowIso(),
      error: 'unsupported_command'
    }, 2);
  }

  if (result && typeof result.then === 'function') {
    result.then((resolved: AnyObj) => {
      const row = resolved && typeof resolved === 'object' ? resolved : { ok: false, error: 'handler_return_invalid' };
      const ok = row.ok !== false;
      emit(row, ok || !strict ? 0 : 1);
    }).catch((err: any) => {
      emit({
        ok: false,
        lane_id: laneId,
        type: `${laneType}_error`,
        action: cmd,
        ts: nowIso(),
        error: cleanText(err && err.message ? err.message : err, 260) || 'handler_failed'
      }, 1);
    });
    return;
  }

  const row = result && typeof result === 'object' ? result : { ok: false, error: 'handler_return_invalid' };
  const ok = row.ok !== false;
  emit(row, ok || !strict ? 0 : 1);
}

module.exports = {
  runStandardLane
};
