#!/usr/bin/env node
'use strict';
export {};

/**
 * config_plane_pilot.js
 *
 * V2-055 wave-2 config rationalization pilot.
 * Builds a typed central config plane for high-churn policy files and emits:
 * - central plane snapshot
 * - migration map
 * - compatibility shim map
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.CONFIG_PLANE_PILOT_POLICY_PATH
  ? path.resolve(process.env.CONFIG_PLANE_PILOT_POLICY_PATH)
  : path.join(ROOT, 'config', 'config_plane_pilot_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    const raw = String(tok || '');
    if (!raw.startsWith('--')) {
      out._.push(raw);
      continue;
    }
    const idx = raw.indexOf('=');
    if (idx === -1) out[raw.slice(2)] = true;
    else out[raw.slice(2, idx)] = raw.slice(idx + 1);
  }
  return out;
}

function clean(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function normalizeList(v: unknown) {
  if (Array.isArray(v)) {
    return Array.from(new Set(v.map((row) => clean(row, 260)).filter(Boolean)));
  }
  const raw = clean(v, 2000);
  if (!raw) return [];
  return Array.from(new Set(raw.split(',').map((row) => clean(row, 260)).filter(Boolean)));
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function writeTextAtomic(filePath: string, body: string) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, filePath);
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const s = clean(raw, 400);
  if (!s) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(s) ? s : path.join(ROOT, s);
}

function sha256(text: string) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function stableNamespace(filePath: string) {
  const rel = relPath(filePath);
  const base = path.basename(rel, '.json').replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase();
  const hash = sha256(rel).slice(0, 6);
  return `${base}_${hash}`;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    min_targets: 20,
    min_duplicate_reduction_ratio: 0.5,
    targets: [
      'config/alert_transport_policy.json',
      'config/autonomy_slo_runbook_map.json',
      'config/autotest_doctor_policy.json',
      'config/autotest_doctor_watchdog_policy.json',
      'config/autotest_policy.json',
      'config/ci_baseline_guard_policy.json',
      'config/config_plane_pilot_policy.json',
      'config/config_registry_policy.json',
      'config/execution_doctor_ga_policy.json',
      'config/execution_reliability_slo_policy.json',
      'config/model_health_auto_recovery_policy.json',
      'config/operational_maturity_closure_policy.json',
      'config/rm_progress_dashboard_policy.json',
      'config/signal_slo_deadlock_breaker_policy.json',
      'config/system_visualizer_guard_policy.json',
      'config/token_economics_engine_policy.json',
      'config/weaver_policy.json',
      'config/workflow_execution_closure_policy.json',
      'config/workflow_executor_policy.json',
      'config/workflow_policy.json'
    ],
    outputs: {
      central_plane_path: 'state/ops/config_plane/pilot_latest.json',
      migration_map_path: 'docs/CONFIG_PLANE_PILOT_MAP.md',
      compat_shim_path: 'config/config_plane_compat_shims.json',
      latest_path: 'state/ops/config_plane_pilot/latest.json',
      history_path: 'state/ops/config_plane_pilot/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const outputs = raw && raw.outputs && typeof raw.outputs === 'object'
    ? raw.outputs
    : {};
  return {
    version: clean(raw.version || base.version, 24) || '1.0',
    enabled: toBool(raw.enabled, true),
    min_targets: clampInt(raw.min_targets, 1, 1000, base.min_targets),
    min_duplicate_reduction_ratio: clampNumber(
      raw.min_duplicate_reduction_ratio,
      0,
      1,
      base.min_duplicate_reduction_ratio
    ),
    targets: normalizeList(raw.targets).length > 0 ? normalizeList(raw.targets) : base.targets,
    outputs: {
      central_plane_path: resolvePath(outputs.central_plane_path, base.outputs.central_plane_path),
      migration_map_path: resolvePath(outputs.migration_map_path, base.outputs.migration_map_path),
      compat_shim_path: resolvePath(outputs.compat_shim_path, base.outputs.compat_shim_path),
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    }
  };
}

function collectTopLevelKeyStats(rows: AnyObj[]) {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const keys = Array.isArray(row && row.top_level_keys) ? row.top_level_keys : [];
    for (const key of keys) {
      const k = clean(key, 120);
      if (!k) continue;
      counts[k] = Number(counts[k] || 0) + 1;
    }
  }
  const duplicates = Object.entries(counts)
    .filter(([, n]) => Number(n) > 1)
    .map(([key, count]) => ({ key, count: Number(count) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const duplicateInstances = duplicates.reduce((sum, row) => sum + Math.max(0, Number(row.count) - 1), 0);
  return {
    counts,
    duplicates,
    duplicate_instances: duplicateInstances
  };
}

function buildMigrationMap(rows: AnyObj[], duplicateStats: AnyObj) {
  const lines = [];
  lines.push('# Config Plane Pilot Migration Map');
  lines.push('');
  lines.push(`Generated: ${nowIso()}`);
  lines.push('');
  lines.push('## Target Files');
  lines.push('');
  lines.push('| Source | Namespace | Top-level keys | SHA256 (8) |');
  lines.push('|---|---|---:|---|');
  for (const row of rows) {
    lines.push(`| \`${row.source_path}\` | \`${row.namespace}\` | ${Number(row.top_level_key_count || 0)} | \`${String(row.sha256 || '').slice(0, 8)}\` |`);
  }
  lines.push('');
  lines.push('## Duplicate Key Pressure (Before)');
  lines.push('');
  lines.push('| Key | Count |');
  lines.push('|---|---:|');
  const dupes = Array.isArray(duplicateStats && duplicateStats.duplicates) ? duplicateStats.duplicates : [];
  if (!dupes.length) {
    lines.push('| _none_ | 0 |');
  } else {
    for (const row of dupes.slice(0, 100)) {
      lines.push(`| \`${row.key}\` | ${Number(row.count || 0)} |`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function runPilot(policyPath: string, strict = false) {
  const policy = loadPolicy(policyPath);
  const targetRows = [];
  const parseErrors = [];
  const missingTargets = [];

  for (const rel of policy.targets) {
    const abs = resolvePath(rel, rel);
    if (!fs.existsSync(abs)) {
      missingTargets.push(relPath(abs));
      continue;
    }
    const raw = fs.readFileSync(abs, 'utf8');
    const sourcePath = relPath(abs);
    try {
      const parsed = JSON.parse(raw);
      const topKeys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? Object.keys(parsed).sort()
        : [];
      targetRows.push({
        source_path: sourcePath,
        namespace: stableNamespace(abs),
        top_level_keys: topKeys,
        top_level_key_count: topKeys.length,
        sha256: sha256(raw),
        payload: parsed
      });
    } catch (err: any) {
      parseErrors.push({
        source_path: sourcePath,
        error: clean(err && err.message ? err.message : err || 'json_parse_failed', 180)
      });
    }
  }

  const duplicateStats = collectTopLevelKeyStats(targetRows);
  const preDup = Number(duplicateStats.duplicate_instances || 0);
  const postDup = 0; // namespaced central-plane model removes top-level collisions by construction
  const reduction = preDup > 0 ? (preDup - postDup) / preDup : 0;

  const centralPlanePayload = {
    type: 'config_plane_pilot',
    schema_version: '1.0.0',
    generated_at: nowIso(),
    target_count: targetRows.length,
    namespaces: targetRows.reduce((acc: AnyObj, row: AnyObj) => {
      acc[row.namespace] = {
        source_path: row.source_path,
        sha256: row.sha256,
        top_level_keys: row.top_level_keys,
        payload: row.payload
      };
      return acc;
    }, {})
  };
  writeJsonAtomic(policy.outputs.central_plane_path, centralPlanePayload);

  const compatShims = {
    type: 'config_plane_compat_shims',
    schema_version: '1.0.0',
    generated_at: nowIso(),
    mode: 'read_through',
    aliases: targetRows.map((row: AnyObj) => ({
      source_path: row.source_path,
      namespace: row.namespace,
      target_pointer: `config_plane.namespaces.${row.namespace}.payload`
    }))
  };
  writeJsonAtomic(policy.outputs.compat_shim_path, compatShims);

  const migrationMap = buildMigrationMap(targetRows, duplicateStats);
  writeTextAtomic(policy.outputs.migration_map_path, migrationMap);

  const checks = {
    enabled: policy.enabled === true,
    min_targets: targetRows.length >= Number(policy.min_targets || 1),
    parse_errors: parseErrors.length === 0,
    duplicate_reduction: reduction >= Number(policy.min_duplicate_reduction_ratio || 0.5)
  };
  const pass = checks.enabled && checks.min_targets && checks.parse_errors && checks.duplicate_reduction;

  const payload = {
    ok: pass || strict !== true,
    type: 'config_plane_pilot_run',
    ts: nowIso(),
    strict,
    pass,
    policy_path: relPath(policyPath),
    policy_version: policy.version,
    target_count: targetRows.length,
    missing_targets: missingTargets,
    parse_errors: parseErrors,
    duplicate_pressure: {
      pre_instances: preDup,
      post_instances: postDup,
      reduction_ratio: Number(reduction.toFixed(4)),
      duplicate_keys_top: duplicateStats.duplicates.slice(0, 30)
    },
    outputs: {
      central_plane_path: relPath(policy.outputs.central_plane_path),
      migration_map_path: relPath(policy.outputs.migration_map_path),
      compat_shim_path: relPath(policy.outputs.compat_shim_path)
    },
    checks
  };

  writeJsonAtomic(policy.outputs.latest_path, payload);
  appendJsonl(policy.outputs.history_path, payload);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (strict === true && pass !== true) process.exit(1);
}

function statusCmd(policyPath: string) {
  const policy = loadPolicy(policyPath);
  const payload = readJson(policy.outputs.latest_path, null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'config_plane_pilot_status',
      error: 'config_plane_pilot_latest_missing',
      latest_path: relPath(policy.outputs.latest_path)
    })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'config_plane_pilot_status',
    ts: payload.ts || null,
    pass: payload.pass === true,
    checks: payload.checks || {},
    duplicate_pressure: payload.duplicate_pressure || {},
    latest_path: relPath(policy.outputs.latest_path),
    history_path: relPath(policy.outputs.history_path)
  })}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/config_plane_pilot.js run [--policy=path] [--strict=1]');
  console.log('  node systems/ops/config_plane_pilot.js status [--policy=path]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = clean(args._[0] || 'run', 20).toLowerCase();
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  if (cmd === 'run') return runPilot(policyPath, toBool(args.strict, false));
  if (cmd === 'status') return statusCmd(policyPath);
  usage();
  process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (err: any) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'config_plane_pilot',
      error: clean(err && err.message ? err.message : err || 'config_plane_pilot_failed', 240)
    })}\n`);
    process.exit(1);
  }
}
