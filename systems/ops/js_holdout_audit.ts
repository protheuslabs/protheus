#!/usr/bin/env node
'use strict';

/**
 * js_holdout_audit.js
 *
 * V2-068:
 * - Audits JS holdouts in runtime lanes.
 * - Requires TS pairing or explicit exception registry entry.
 * - Fails strict mode when unapproved JS appears in strict roots.
 *
 * Usage:
 *   node systems/ops/js_holdout_audit.js run [--registry=<path>] [--strict=1]
 *   node systems/ops/js_holdout_audit.js status [--registry=<path>]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.env.JS_HOLDOUT_ROOT
  ? path.resolve(process.env.JS_HOLDOUT_ROOT)
  : path.resolve(__dirname, '..', '..');
const DEFAULT_REGISTRY_PATH = process.env.JS_EXCEPTION_REGISTRY_PATH
  ? path.resolve(process.env.JS_EXCEPTION_REGISTRY_PATH)
  : path.join(ROOT, 'config', 'js_exception_registry.json');
const DEFAULT_STATE_PATH = path.join(ROOT, 'state', 'ops', 'js_holdout_audit', 'latest.json');
const DEFAULT_WAVE_STATE_PATH = path.join(ROOT, 'state', 'ops', 'js_holdout_audit', 'wave_latest.json');
const DEFAULT_EXCEPTION_SNAPSHOT_PATH = path.join(ROOT, 'state', 'ops', 'js_holdout_audit', 'exception_registry_snapshot.json');

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const out = { _: [] } as any;
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function cleanText(v, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function rel(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readRegistry(registryPath) {
  const src = readJson(registryPath, {});
  const strictRoots = Array.isArray(src.strict_roots) ? src.strict_roots.map((v) => cleanText(v, 240)).filter(Boolean) : ['systems', 'lib'];
  const advisoryRoots = Array.isArray(src.advisory_roots) ? src.advisory_roots.map((v) => cleanText(v, 240)).filter(Boolean) : [];
  const exceptions = Array.isArray(src.exceptions) ? src.exceptions : [];
  const map = new Map();
  for (const row of exceptions) {
    const p = cleanText(row && row.path || '', 300).replace(/^\/+/, '');
    if (!p) continue;
    map.set(p, {
      path: p,
      owner: cleanText(row.owner || 'unknown', 120) || 'unknown',
      reason: cleanText(row.reason || '', 240) || null,
      benchmark_evidence: cleanText(row.benchmark_evidence || '', 240) || null,
      expires_at: cleanText(row.expires_at || '', 80) || null
    });
  }
  return { strictRoots, advisoryRoots, exceptionMap: map };
}

function serializeExceptionMap(map) {
  const out = {};
  for (const [key, value] of map.entries()) {
    out[key] = {
      owner: cleanText(value.owner || 'unknown', 120) || 'unknown',
      reason: cleanText(value.reason || '', 240) || null,
      benchmark_evidence: cleanText(value.benchmark_evidence || '', 240) || null,
      expires_at: cleanText(value.expires_at || '', 80) || null
    };
  }
  return out;
}

function computeExceptionDiff(previousSnap, currentMap) {
  const prev = previousSnap && previousSnap.exceptions && typeof previousSnap.exceptions === 'object'
    ? previousSnap.exceptions
    : {};
  const curr = serializeExceptionMap(currentMap);
  const added = [];
  const removed = [];
  const changed = [];
  for (const key of Object.keys(curr)) {
    if (!Object.prototype.hasOwnProperty.call(prev, key)) {
      added.push(key);
      continue;
    }
    if (JSON.stringify(prev[key]) !== JSON.stringify(curr[key])) {
      changed.push(key);
    }
  }
  for (const key of Object.keys(prev)) {
    if (!Object.prototype.hasOwnProperty.call(curr, key)) removed.push(key);
  }
  added.sort();
  removed.sort();
  changed.sort();
  return {
    added,
    removed,
    changed,
    added_count: added.length,
    removed_count: removed.length,
    changed_count: changed.length
  };
}

function clampInt(v, min, max, fallback = min) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function gitChurnMap(days) {
  const windowDays = clampInt(days, 1, 365, 30);
  const proc = spawnSync(
    'git',
    ['-C', ROOT, 'log', `--since=${windowDays}.days`, '--name-only', '--pretty=format:'],
    { encoding: 'utf8', timeout: 30000 }
  );
  if (Number(proc.status || 0) !== 0) return {};
  const out = {};
  const lines = String(proc.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith('.')) continue;
    const relPath = String(line).replace(/\\/g, '/');
    out[relPath] = Number(out[relPath] || 0) + 1;
  }
  return out;
}

function isExpired(expiresAt) {
  const ms = Date.parse(String(expiresAt || ''));
  if (!Number.isFinite(ms)) return false;
  return ms <= Date.now();
}

function listJsFiles(rootRel) {
  const out = [];
  const abs = path.resolve(ROOT, rootRel);
  if (!fs.existsSync(abs)) return out;
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fp);
        continue;
      }
      if (!entry.isFile() || !fp.endsWith('.js')) continue;
      out.push(fp);
    }
  }
  walk(abs);
  return out;
}

function inspectFile(filePath, exceptionMap) {
  const relPath = rel(filePath);
  const tsPeer = filePath.slice(0, -3) + '.ts';
  const hasTsPeer = fs.existsSync(tsPeer);
  const exception = exceptionMap.get(relPath) || null;
  if (hasTsPeer) {
    return {
      path: relPath,
      status: 'paired_ts',
      has_ts_peer: true
    };
  }
  if (exception) {
    return {
      path: relPath,
      status: isExpired(exception.expires_at) ? 'exception_expired' : 'exception_allowed',
      has_ts_peer: false,
      exception
    };
  }
  return {
    path: relPath,
    status: 'unapproved_unpaired_js',
    has_ts_peer: false
  };
}

function audit(registryPath) {
  const registry = readRegistry(registryPath);
  const strictRows = [];
  const advisoryRows = [];

  for (const rootRel of registry.strictRoots) {
    for (const fp of listJsFiles(rootRel)) {
      strictRows.push(inspectFile(fp, registry.exceptionMap));
    }
  }
  for (const rootRel of registry.advisoryRoots) {
    for (const fp of listJsFiles(rootRel)) {
      advisoryRows.push(inspectFile(fp, registry.exceptionMap));
    }
  }

  const strictViolations = strictRows.filter((row) => row.status === 'unapproved_unpaired_js' || row.status === 'exception_expired');
  const advisoryViolations = advisoryRows.filter((row) => row.status === 'unapproved_unpaired_js' || row.status === 'exception_expired');

  const statusCounts = (rows) => rows.reduce((acc, row) => {
    const key = String(row.status || 'unknown');
    acc[key] = Number(acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    strict_rows: strictRows,
    advisory_rows: advisoryRows,
    strict_violations: strictViolations,
    advisory_violations: advisoryViolations,
    strict_counts: statusCounts(strictRows),
    advisory_counts: statusCounts(advisoryRows),
    strict_roots: registry.strictRoots,
    advisory_roots: registry.advisoryRoots
  };
}

function runAudit(args, mode) {
  const registryPath = args.registry
    ? path.resolve(String(args.registry))
    : DEFAULT_REGISTRY_PATH;
  const strict = mode === 'run' ? toBool(args.strict, false) : false;
  const out = audit(registryPath);
  const payload = {
    ok: out.strict_violations.length === 0,
    type: 'js_holdout_audit',
    script: 'js_holdout_audit.js',
    ts: nowIso(),
    strict,
    supported_flags: ['--registry', '--strict'],
    registry_path: rel(registryPath),
    strict_roots: out.strict_roots,
    advisory_roots: out.advisory_roots,
    strict_total: out.strict_rows.length,
    advisory_total: out.advisory_rows.length,
    strict_counts: out.strict_counts,
    advisory_counts: out.advisory_counts,
    strict_violations: out.strict_violations.slice(0, 200),
    advisory_violations: out.advisory_violations.slice(0, 200)
  };
  writeJsonAtomic(DEFAULT_STATE_PATH, payload);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (mode === 'run' && strict && payload.ok !== true) process.exit(1);
}

function wavePlan(args) {
  const registryPath = args.registry
    ? path.resolve(String(args.registry))
    : DEFAULT_REGISTRY_PATH;
  const waveSize = clampInt(args['wave-size'] != null ? args['wave-size'] : args.wave_size, 1, 200, 25);
  const churnDays = clampInt(args['churn-days'] != null ? args['churn-days'] : args.churn_days, 1, 365, 30);
  const registry = readRegistry(registryPath);
  const out = audit(registryPath);
  const churn = gitChurnMap(churnDays);
  const candidates = out.strict_rows.concat(out.advisory_rows)
    .filter((row) => row && row.has_ts_peer !== true)
    .map((row) => {
      const relPath = cleanText(row.path || '', 300).replace(/^\/+/, '');
      const churnCount = clampInt(churn[relPath], 0, 100000, 0);
      const status = String(row.status || '');
      const priority = status === 'unapproved_unpaired_js'
        ? 0
        : (status === 'exception_expired' ? 1 : 2);
      return {
        path: relPath,
        status,
        churn_count_30d: churnCount,
        priority,
        owner: row.exception ? cleanText(row.exception.owner || 'unknown', 120) : null,
        expires_at: row.exception ? cleanText(row.exception.expires_at || '', 80) || null : null
      };
    });
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (b.churn_count_30d !== a.churn_count_30d) return b.churn_count_30d - a.churn_count_30d;
    return String(a.path || '').localeCompare(String(b.path || ''));
  });

  const previousSnapshot = readJson(DEFAULT_EXCEPTION_SNAPSHOT_PATH, {});
  const exceptionDiff = computeExceptionDiff(previousSnapshot, registry.exceptionMap);
  const payload = {
    ok: true,
    type: 'js_holdout_wave_plan',
    script: 'js_holdout_audit.js',
    ts: nowIso(),
    registry_path: rel(registryPath),
    churn_window_days: churnDays,
    wave_size: waveSize,
    strict_total: out.strict_rows.length,
    advisory_total: out.advisory_rows.length,
    unpaired_total: candidates.length,
    wave_candidates: candidates.slice(0, waveSize),
    exception_registry_diff: exceptionDiff
  };
  writeJsonAtomic(DEFAULT_WAVE_STATE_PATH, payload);
  writeJsonAtomic(DEFAULT_EXCEPTION_SNAPSHOT_PATH, {
    ts: nowIso(),
    registry_path: rel(registryPath),
    exceptions: serializeExceptionMap(registry.exceptionMap)
  });
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmdRaw = String(args._[0] || '').trim().toLowerCase();
  if (args.help === true || cmdRaw === '--help' || cmdRaw === 'help' || cmdRaw === '-h') {
    process.stdout.write(JSON.stringify({
      ok: true,
      type: 'js_holdout_audit_help',
      script: 'js_holdout_audit.js',
      usage: [
        'js_holdout_audit.js run [--registry=<path>] [--strict=1]',
        'js_holdout_audit.js status [--registry=<path>]',
        'js_holdout_audit.js wave-plan [--registry=<path>] [--wave-size=25] [--churn-days=30]'
      ]
    }) + '\n');
    return;
  }
  const cmd = cmdRaw || 'run';
  if (cmd === 'run' || cmd === 'status') {
    runAudit(args, cmd);
    return;
  }
  if (cmd === 'wave-plan') {
    wavePlan(args);
    return;
  }
  throw new Error(`unknown_command:${cmd}`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`js_holdout_audit.js: FAIL: ${err.message}\n`);
  process.exit(1);
}
