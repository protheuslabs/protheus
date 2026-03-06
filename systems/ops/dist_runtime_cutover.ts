#!/usr/bin/env node
'use strict';

/**
 * dist_runtime_cutover.js
 *
 * V2-003 helper for source<->dist runtime mode.
 *
 * Usage:
 *   node systems/ops/dist_runtime_cutover.js status
 *   node systems/ops/dist_runtime_cutover.js set-mode --mode=dist|source
 *   node systems/ops/dist_runtime_cutover.js verify [--build=1|0] [--strict=1|0]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MODE_STATE_PATH = process.env.PROTHEUS_RUNTIME_MODE_STATE_PATH
  ? path.resolve(process.env.PROTHEUS_RUNTIME_MODE_STATE_PATH)
  : path.join(ROOT, 'state', 'ops', 'runtime_mode.json');
const LEGACY_RECONCILIATION_POLICY_PATH = process.env.DIST_RUNTIME_RECONCILIATION_POLICY_PATH
  ? path.resolve(process.env.DIST_RUNTIME_RECONCILIATION_POLICY_PATH)
  : path.join(ROOT, 'config', 'dist_runtime_reconciliation_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function normalizeToken(v, maxLen = 32) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .slice(0, maxLen)
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function stableHash(input) {
  return crypto.createHash('sha256').update(String(input == null ? '' : input), 'utf8').digest('hex');
}

function defaultReconciliationPolicy() {
  return {
    schema_id: 'dist_runtime_reconciliation_policy',
    schema_version: '1.0',
    enabled: true,
    backlog_path: 'UPGRADE_BACKLOG.md',
    backlog_done_status: ['done'],
    backlog_reopen_target_ids: ['V2-001', 'V2-003', 'BL-014'],
    incident: {
      enabled: true,
      severity: 'high',
      state_path: 'state/ops/dist_runtime_cutover/legacy_pairs_state.json',
      incidents_path: 'state/ops/dist_runtime_cutover/legacy_pair_incidents.jsonl'
    }
  };
}

function resolvePath(raw, fallbackRel) {
  const txt = String(raw == null ? '' : raw).trim();
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function readReconciliationPolicy() {
  const base = defaultReconciliationPolicy();
  const raw = readJson(LEGACY_RECONCILIATION_POLICY_PATH, {});
  const incidentRaw = raw && typeof raw.incident === 'object' ? raw.incident : {};
  return {
    enabled: raw.enabled !== false,
    policy_path: LEGACY_RECONCILIATION_POLICY_PATH,
    backlog_path: process.env.DIST_RUNTIME_BACKLOG_PATH
      ? resolvePath(process.env.DIST_RUNTIME_BACKLOG_PATH, base.backlog_path)
      : resolvePath(raw.backlog_path, base.backlog_path),
    backlog_done_status: Array.isArray(raw.backlog_done_status)
      ? raw.backlog_done_status.map((v) => normalizeToken(v, 32)).filter(Boolean)
      : base.backlog_done_status,
    backlog_reopen_target_ids: Array.isArray(raw.backlog_reopen_target_ids)
      ? raw.backlog_reopen_target_ids.map((v) => String(v || '').trim().toUpperCase()).filter(Boolean)
      : base.backlog_reopen_target_ids,
    incident: {
      enabled: incidentRaw.enabled !== false,
      severity: normalizeToken(incidentRaw.severity || base.incident.severity, 32) || 'high',
      state_path: process.env.DIST_RUNTIME_LEGACY_STATE_PATH
        ? resolvePath(process.env.DIST_RUNTIME_LEGACY_STATE_PATH, base.incident.state_path)
        : resolvePath(incidentRaw.state_path, base.incident.state_path),
      incidents_path: process.env.DIST_RUNTIME_LEGACY_INCIDENTS_PATH
        ? resolvePath(process.env.DIST_RUNTIME_LEGACY_INCIDENTS_PATH, base.incident.incidents_path)
        : resolvePath(incidentRaw.incidents_path, base.incident.incidents_path)
    }
  };
}

function extractRowStatuses(line) {
  const cols = String(line || '')
    .split('|')
    .map((c) => String(c || '').trim())
    .filter(Boolean);
  if (cols.length < 2) return null;
  const id = String(cols[0] || '').trim().toUpperCase();
  const allowed = new Set(['queued', 'doing', 'done', 'blocked', 'todo', 'deferred', 'cancelled', 'in_progress', 'in-progress']);
  const statuses = [];
  for (let i = 1; i < Math.min(cols.length, 6); i += 1) {
    const token = normalizeToken(cols[i], 32);
    if (allowed.has(token)) statuses.push(token);
  }
  if (!id || statuses.length === 0) return null;
  return { id, statuses };
}

function readBacklogStatusMap(backlogPath, targetIds) {
  const wanted = new Set((targetIds || []).map((id) => String(id || '').trim().toUpperCase()).filter(Boolean));
  const out = {};
  for (const id of wanted) out[id] = [];
  if (!fs.existsSync(backlogPath)) {
    return { ok: false, reason: 'backlog_missing', statuses: out };
  }
  const lines = String(fs.readFileSync(backlogPath, 'utf8') || '').split('\n');
  for (const line of lines) {
    if (!String(line || '').startsWith('|')) continue;
    const row = extractRowStatuses(line);
    if (!row || !wanted.has(row.id)) continue;
    const prev = Array.isArray(out[row.id]) ? out[row.id] : [];
    out[row.id] = Array.from(new Set([...prev, ...row.statuses]));
  }
  return { ok: true, reason: 'ok', statuses: out };
}

function evaluateBacklogStatusGuard(policy, legacyPairs) {
  const statusesPayload = readBacklogStatusMap(policy.backlog_path, policy.backlog_reopen_target_ids);
  const doneSet = new Set((policy.backlog_done_status || []).map((v) => normalizeToken(v, 32)).filter(Boolean));
  const violations = [];
  if (legacyPairs.length > 0 && statusesPayload.ok) {
    for (const id of policy.backlog_reopen_target_ids) {
      const statuses = Array.isArray(statusesPayload.statuses[id]) ? statusesPayload.statuses[id] : [];
      if (statuses.some((s) => doneSet.has(normalizeToken(s, 32)))) violations.push(id);
    }
  }
  return {
    ok: statusesPayload.ok && violations.length === 0,
    backlog_exists: statusesPayload.ok,
    backlog_path: path.relative(ROOT, policy.backlog_path).replace(/\\/g, '/'),
    done_status_tokens: Array.from(doneSet),
    target_ids: policy.backlog_reopen_target_ids,
    target_statuses: statusesPayload.statuses,
    reopen_required_ids: violations,
    reason: statusesPayload.ok ? 'ok' : statusesPayload.reason
  };
}

function reconcileLegacyPairIncident(policy, legacyPairs, backlogGuard) {
  const incidentCfg = policy.incident || {};
  const state = readJson(incidentCfg.state_path, {}) || {};
  const prevCount = Number(state.last_pair_count || 0) || 0;
  const currentCount = legacyPairs.length;
  const signature = stableHash(legacyPairs.join('\n'));
  const prevSignature = String(state.last_signature || '');
  const pairDelta = currentCount - prevCount;
  const shouldOpenIncident = incidentCfg.enabled === true
    && currentCount > 0
    && (pairDelta !== 0 || signature !== prevSignature || (backlogGuard.reopen_required_ids || []).length > 0);
  let incidentId = null;
  if (shouldOpenIncident) {
    incidentId = `inc_runtime_legacy_pairs_${Date.now()}`;
    appendJsonl(incidentCfg.incidents_path, {
      schema_id: 'dist_runtime_legacy_pair_incident',
      schema_version: '1.0',
      ts: nowIso(),
      incident_id: incidentId,
      severity: incidentCfg.severity || 'high',
      pair_count: currentCount,
      pair_delta: pairDelta,
      legacy_pairs: legacyPairs.slice(0, 200),
      backlog_reopen_required_ids: backlogGuard.reopen_required_ids || [],
      reason: 'legacy_runtime_js_pairs_detected'
    });
  }
  writeJsonAtomic(incidentCfg.state_path, {
    schema_id: 'dist_runtime_legacy_pairs_state',
    schema_version: '1.0',
    ts: nowIso(),
    last_pair_count: currentCount,
    last_signature: signature,
    last_incident_id: incidentId || state.last_incident_id || null
  });
  return {
    pair_delta: pairDelta,
    incident_opened: shouldOpenIncident,
    incident_id: incidentId,
    incident_path: path.relative(ROOT, incidentCfg.incidents_path).replace(/\\/g, '/'),
    state_path: path.relative(ROOT, incidentCfg.state_path).replace(/\\/g, '/')
  };
}

function modeFromState() {
  const payload = readJson(MODE_STATE_PATH, null);
  const mode = normalizeToken(payload && payload.mode || 'source');
  return mode === 'dist' ? 'dist' : 'source';
}

function effectiveMode() {
  const envMode = normalizeToken(process.env.PROTHEUS_RUNTIME_MODE || '');
  if (envMode === 'dist' || envMode === 'source') return envMode;
  return modeFromState();
}

function runCmd(name, command, args, env = {}) {
  const r = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    }
  });
  return {
    name,
    ok: r.status === 0,
    status: Number(r.status || 0),
    stdout: String(r.stdout || '').trim(),
    stderr: String(r.stderr || '').trim(),
    command: [command, ...args].join(' ')
  };
}

function walkFiles(dirPath, out = []) {
  if (!fs.existsSync(dirPath)) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(dirPath, entry.name);
    if (entry.isDirectory()) walkFiles(abs, out);
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

function isTsBootstrapWrapper(jsAbsPath) {
  try {
    const text = fs.readFileSync(jsAbsPath, 'utf8');
    return /ts_bootstrap/.test(text) && /\.bootstrap\(__filename,\s*module\)/.test(text);
  } catch {
    return false;
  }
}

function legacyRuntimeJsPairs() {
  const roots = ['systems', 'lib'];
  const out = [];
  for (const relRoot of roots) {
    const absRoot = path.join(ROOT, relRoot);
    for (const absPath of walkFiles(absRoot, [])) {
      if (!absPath.endsWith('.js')) continue;
      const tsPath = absPath.slice(0, -3) + '.ts';
      if (!fs.existsSync(tsPath)) continue;
      if (isTsBootstrapWrapper(absPath)) continue;
      out.push(path.relative(ROOT, absPath).replace(/\\/g, '/'));
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function cmdLegacyPairs(args) {
  const strict = toBool(args.strict, false);
  const pairs = legacyRuntimeJsPairs();
  const policy = readReconciliationPolicy();
  const backlogGuard = evaluateBacklogStatusGuard(policy, pairs);
  const reconciliation = reconcileLegacyPairIncident(policy, pairs, backlogGuard);
  const out = {
    ok: policy.enabled !== false && pairs.length === 0 && backlogGuard.ok === true,
    type: 'dist_runtime_legacy_pairs',
    ts: nowIso(),
    policy_path: path.relative(ROOT, policy.policy_path).replace(/\\/g, '/'),
    legacy_pair_count: pairs.length,
    legacy_pairs: pairs,
    pair_delta: reconciliation.pair_delta,
    incident_opened: reconciliation.incident_opened,
    incident_id: reconciliation.incident_id,
    incident_path: reconciliation.incident_path,
    reconcile_state_path: reconciliation.state_path,
    backlog_status_guard: backlogGuard
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (strict && !out.ok) process.exit(1);
}

function cmdStatus() {
  const state = readJson(MODE_STATE_PATH, null);
  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'dist_runtime_status',
    ts: nowIso(),
    mode_state_path: path.relative(ROOT, MODE_STATE_PATH).replace(/\\/g, '/'),
    state_mode: modeFromState(),
    env_mode: normalizeToken(process.env.PROTHEUS_RUNTIME_MODE || '') || null,
    effective_mode: effectiveMode(),
    dist_exists: fs.existsSync(path.join(ROOT, 'dist')),
    state: state || null
  }) + '\n');
}

function cmdSetMode(args) {
  const mode = normalizeToken(args.mode || args['runtime-mode'] || '', 16);
  if (mode !== 'dist' && mode !== 'source') {
    process.stdout.write(JSON.stringify({ ok: false, error: 'mode_required_dist_or_source' }) + '\n');
    process.exit(2);
  }
  const payload = {
    schema_id: 'runtime_mode',
    schema_version: '1.0',
    ts: nowIso(),
    mode,
    source: 'dist_runtime_cutover'
  };
  writeJsonAtomic(MODE_STATE_PATH, payload);
  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'dist_runtime_set_mode',
    ts: nowIso(),
    mode,
    mode_state_path: path.relative(ROOT, MODE_STATE_PATH).replace(/\\/g, '/')
  }) + '\n');
}

function cmdVerify(args) {
  const strict = toBool(args.strict, true);
  const withBuild = toBool(args.build, true);
  const deepDist = toBool(
    args['deep-dist'] != null ? args['deep-dist'] : process.env.PROTHEUS_RUNTIME_VERIFY_DEEP_DIST,
    false
  );
  const checks = [];

  if (withBuild) {
    checks.push(runCmd('build_systems_verify', 'npm', ['run', 'build:systems:verify']));
  }
  checks.push(runCmd(
    deepDist ? 'contract_check_dist' : 'contract_check',
    'node',
    ['systems/spine/contract_check.js'],
    deepDist
      ? {
          PROTHEUS_RUNTIME_MODE: 'dist',
          PROTHEUS_RUNTIME_DIST_REQUIRED: '1'
        }
      : {}
  ));
  checks.push(runCmd(
    deepDist ? 'schema_contract_check_dist' : 'schema_contract_check',
    'node',
    ['systems/security/schema_contract_check.js', 'run'],
    deepDist
      ? {
          PROTHEUS_RUNTIME_MODE: 'dist',
          PROTHEUS_RUNTIME_DIST_REQUIRED: '1'
        }
      : {}
  ));
  const legacyPairs = legacyRuntimeJsPairs();
  checks.push({
    name: 'legacy_runtime_js_pairs',
    ok: legacyPairs.length === 0,
    status: legacyPairs.length === 0 ? 0 : 1,
    stdout: legacyPairs.join('\n'),
    stderr: '',
    command: 'internal:legacy_runtime_js_pairs'
  });

  const failed = checks.filter((c) => !c.ok);
  const out = {
    ok: failed.length === 0,
    type: 'dist_runtime_verify',
    ts: nowIso(),
    strict,
    deep_dist: deepDist,
    build_step: withBuild,
    legacy_pair_count: legacyPairs.length,
    legacy_pairs: legacyPairs,
    checks: checks.map((c) => ({ name: c.name, ok: c.ok, status: c.status, command: c.command })),
    failed: failed.map((c) => ({
      name: c.name,
      status: c.status,
      stdout: c.stdout.split('\n').slice(0, 30).join('\n'),
      stderr: c.stderr.split('\n').slice(0, 30).join('\n')
    }))
  };

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (strict && !out.ok) process.exit(1);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/dist_runtime_cutover.js status');
  console.log('  node systems/ops/dist_runtime_cutover.js set-mode --mode=dist|source');
  console.log('  node systems/ops/dist_runtime_cutover.js verify [--build=1|0] [--strict=1|0] [--deep-dist=1|0]');
  console.log('  node systems/ops/dist_runtime_cutover.js legacy-pairs [--strict=1|0]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0], 24);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'set-mode') return cmdSetMode(args);
  if (cmd === 'verify') return cmdVerify(args);
  if (cmd === 'legacy-pairs') return cmdLegacyPairs(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  modeFromState,
  effectiveMode
};
export {};
