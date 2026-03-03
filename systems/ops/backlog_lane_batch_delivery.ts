#!/usr/bin/env node
'use strict';
export {};

/**
 * Backlog lane batch delivery runtime.
 *
 * Provides deterministic run/status/list commands for backlog IDs that now
 * have implementation coverage but previously lacked dedicated lane scripts.
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
  resolvePath,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  emit
} = require('../../lib/queued_backlog_runtime');

type AnyObj = Record<string, any>;

const DEFAULT_POLICY_PATH = process.env.BACKLOG_LANE_BATCH_DELIVERY_POLICY_PATH
  ? path.resolve(process.env.BACKLOG_LANE_BATCH_DELIVERY_POLICY_PATH)
  : path.join(ROOT, 'config', 'backlog_lane_batch_delivery_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/backlog_lane_batch_delivery.js list [--policy=<path>]');
  console.log('  node systems/ops/backlog_lane_batch_delivery.js run --id=<ID> [--apply=1|0] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/backlog_lane_batch_delivery.js status [--id=<ID>] [--policy=<path>]');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function normalizeId(v: unknown) {
  const id = cleanText(v || '', 120).replace(/`/g, '').toUpperCase();
  return /^[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(id) ? id : '';
}

function asList(v: unknown, maxLen = 120) {
  if (Array.isArray(v)) {
    return v.map((row) => cleanText(row, maxLen)).filter(Boolean);
  }
  const txt = cleanText(v || '', 4000);
  if (!txt) return [];
  return txt.split(',').map((row) => cleanText(row, maxLen)).filter(Boolean);
}

function normalizeTarget(id: string, src: AnyObj = {}) {
  return {
    id,
    require_dependency_closed: toBool(src.require_dependency_closed, true),
    verify_signals_required: toBool(src.verify_signals_required, true),
    rollback_signals_required: toBool(src.rollback_signals_required, true),
    notes: cleanText(src.notes || '', 400)
  };
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: true,
    source_registry_path: 'config/backlog_registry.json',
    done_statuses: ['done'],
    targets: {},
    outputs: {
      state_dir: 'state/ops/backlog_lane_batch_delivery',
      latest_path: 'state/ops/backlog_lane_batch_delivery/latest.json',
      receipts_path: 'state/ops/backlog_lane_batch_delivery/receipts.jsonl',
      history_path: 'state/ops/backlog_lane_batch_delivery/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const targetsRaw = raw.targets && typeof raw.targets === 'object' ? raw.targets : {};
  const targets: Record<string, AnyObj> = {};
  Object.keys(targetsRaw).forEach((key) => {
    const id = normalizeId(key);
    if (!id) return;
    targets[id] = normalizeTarget(id, targetsRaw[key] && typeof targetsRaw[key] === 'object' ? targetsRaw[key] : {});
  });

  return {
    version: cleanText(raw.version || base.version, 24) || '1.0',
    enabled: toBool(raw.enabled, true),
    strict_default: toBool(raw.strict_default, base.strict_default),
    source_registry_path: resolvePath(raw.source_registry_path, base.source_registry_path),
    done_statuses: asList(raw.done_statuses || base.done_statuses, 40)
      .map((v) => normalizeToken(v, 40))
      .filter(Boolean),
    targets,
    outputs: {
      state_dir: resolvePath(raw.outputs && raw.outputs.state_dir, base.outputs.state_dir),
      latest_path: resolvePath(raw.outputs && raw.outputs.latest_path, base.outputs.latest_path),
      receipts_path: resolvePath(raw.outputs && raw.outputs.receipts_path, base.outputs.receipts_path),
      history_path: resolvePath(raw.outputs && raw.outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadRegistry(policy: AnyObj) {
  const reg = readJson(policy.source_registry_path, null);
  if (!reg || typeof reg !== 'object' || !Array.isArray(reg.rows)) {
    return {
      ok: false,
      error: 'source_registry_missing_or_invalid',
      source_registry_path: rel(policy.source_registry_path),
      rows: []
    };
  }
  const rows = reg.rows;
  const byId = new Map<string, AnyObj>();
  for (const row of rows) {
    const id = normalizeId(row && row.id || '');
    if (!id) continue;
    byId.set(id, row);
  }
  return { ok: true, rows, byId, registry: reg };
}

function parseDeps(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const dep of raw) {
    const id = normalizeId(dep);
    if (!id) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function hasAnySignal(text: string, signals: string[]) {
  const lower = String(text || '').toLowerCase();
  return signals.some((s) => lower.includes(String(s || '').toLowerCase()));
}

function listTargets(policy: AnyObj) {
  const ids = Object.keys(policy.targets || {}).sort((a, b) => a.localeCompare(b));
  return {
    ok: true,
    type: 'backlog_lane_batch_delivery',
    action: 'list',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    target_count: ids.length,
    targets: ids.map((id) => ({ id, ...policy.targets[id] }))
  };
}

function runTarget(policy: AnyObj, args: AnyObj) {
  const id = normalizeId(args.id || '');
  if (!id) {
    return {
      ok: false,
      type: 'backlog_lane_batch_delivery',
      action: 'run',
      ts: nowIso(),
      error: 'id_required'
    };
  }

  const target = policy.targets[id];
  if (!target) {
    return {
      ok: false,
      type: 'backlog_lane_batch_delivery',
      action: 'run',
      ts: nowIso(),
      id,
      error: 'target_not_allowed'
    };
  }

  const load = loadRegistry(policy);
  if (!load.ok) {
    return {
      ok: false,
      type: 'backlog_lane_batch_delivery',
      action: 'run',
      ts: nowIso(),
      id,
      error: load.error,
      source_registry_path: load.source_registry_path
    };
  }

  const byId = load.byId as Map<string, AnyObj>;
  const row = byId.get(id);
  if (!row) {
    return {
      ok: false,
      type: 'backlog_lane_batch_delivery',
      action: 'run',
      ts: nowIso(),
      id,
      error: 'target_missing_in_registry'
    };
  }

  const doneStatuses = new Set((policy.done_statuses || []).map((v: string) => normalizeToken(v, 40)).filter(Boolean));
  const dependencies = parseDeps(row.dependencies);
  const dependencyStatus = dependencies.map((depId) => {
    const depRow = byId.get(depId) || null;
    const status = normalizeToken(depRow && depRow.status || 'missing', 40) || 'missing';
    return {
      id: depId,
      status,
      done: doneStatuses.has(status),
      exists: !!depRow
    };
  });
  const openDependencies = dependencyStatus.filter((d) => !d.done).map((d) => d.id);

  const acceptance = cleanText(row.acceptance || '', 16000);
  const verifySignals = ['verify', 'test', 'receipt', 'check', 'assert'];
  const rollbackSignals = ['rollback', 'revert', 'fallback', 'undo'];

  const checks = [
    {
      id: 'registry_row_present',
      required: true,
      pass: true,
      reason: 'ok'
    },
    {
      id: 'dependencies_closed',
      required: !!target.require_dependency_closed,
      pass: target.require_dependency_closed ? openDependencies.length === 0 : true,
      reason: openDependencies.length === 0 ? 'ok' : `open_dependencies:${openDependencies.join(',')}`
    },
    {
      id: 'acceptance_verify_signal',
      required: !!target.verify_signals_required,
      pass: target.verify_signals_required ? hasAnySignal(acceptance, verifySignals) : true,
      reason: hasAnySignal(acceptance, verifySignals) ? 'ok' : 'verify_signal_missing'
    },
    {
      id: 'acceptance_rollback_signal',
      required: !!target.rollback_signals_required,
      pass: target.rollback_signals_required ? hasAnySignal(acceptance, rollbackSignals) : true,
      reason: hasAnySignal(acceptance, rollbackSignals) ? 'ok' : 'rollback_signal_missing'
    }
  ];

  const failedRequired = checks.filter((check) => check.required && !check.pass);
  const ok = failedRequired.length === 0;
  const apply = toBool(args.apply, true);

  const receipt = {
    schema_id: 'backlog_lane_batch_delivery_receipt',
    schema_version: '1.0',
    artifact_type: 'receipt',
    ok,
    type: 'backlog_lane_batch_delivery',
    action: 'run',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    source_registry_path: rel(policy.source_registry_path),
    id,
    class: cleanText(row.class || '', 80),
    wave: cleanText(row.wave || '', 40),
    title: cleanText(row.title || '', 500),
    target,
    status_before: normalizeToken(row.status || 'queued', 40) || 'queued',
    dependencies,
    dependency_status: dependencyStatus,
    open_dependencies: openDependencies,
    checks,
    failed_required_checks: failedRequired.map((check) => check.id),
    apply,
    strict: toBool(args.strict, policy.strict_default)
  };

  if (apply) {
    fs.mkdirSync(path.dirname(policy.outputs.latest_path), { recursive: true });
    fs.mkdirSync(path.dirname(policy.outputs.receipts_path), { recursive: true });
    fs.mkdirSync(path.dirname(policy.outputs.history_path), { recursive: true });

    writeJsonAtomic(path.join(policy.outputs.state_dir, `${id}.json`), receipt);
    writeJsonAtomic(policy.outputs.latest_path, receipt);
    appendJsonl(policy.outputs.receipts_path, receipt);
    appendJsonl(policy.outputs.history_path, receipt);
  }

  return receipt;
}

function status(policy: AnyObj, args: AnyObj) {
  const id = normalizeId(args.id || '');
  if (id) {
    const statePath = path.join(policy.outputs.state_dir, `${id}.json`);
    return {
      ok: true,
      type: 'backlog_lane_batch_delivery',
      action: 'status',
      ts: nowIso(),
      id,
      policy_path: rel(policy.policy_path),
      state_path: rel(statePath),
      state: readJson(statePath, null)
    };
  }

  return {
    ok: true,
    type: 'backlog_lane_batch_delivery',
    action: 'status',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    latest: readJson(policy.outputs.latest_path, null)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 40) || 'status';
  if (args.help || cmd === 'help' || cmd === '--help') {
    usage();
    process.exit(0);
  }

  const policyPath = args.policy
    ? (path.isAbsolute(String(args.policy)) ? String(args.policy) : path.join(ROOT, String(args.policy)))
    : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) emit({ ok: false, error: 'backlog_lane_batch_delivery_disabled' }, 1);

  if (cmd === 'list') emit(listTargets(policy), 0);
  if (cmd === 'run') {
    const out = runTarget(policy, args);
    const strict = toBool(args.strict, policy.strict_default);
    emit(out, strict && out.ok !== true ? 1 : 0);
  }
  if (cmd === 'status') emit(status(policy, args), 0);

  usage();
  process.exit(1);
}

main();
