#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.SCHEMA_EVOLUTION_ROOT
  ? path.resolve(process.env.SCHEMA_EVOLUTION_ROOT)
  : path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.SCHEMA_EVOLUTION_POLICY_PATH
  ? path.resolve(process.env.SCHEMA_EVOLUTION_POLICY_PATH)
  : path.join(ROOT, 'config', 'schema_evolution_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
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

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!String(token || '').startsWith('--')) {
      out._.push(String(token || ''));
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[String(token).slice(2)] = true;
    else out[String(token).slice(2, idx)] = String(token).slice(idx + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/schema_evolution_contract.js run [--strict=1|0] [--apply=1|0] [--policy=<path>]');
  console.log('  node systems/ops/schema_evolution_contract.js status [--policy=<path>]');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(v: unknown) {
  const text = cleanText(v || '', 320);
  if (!text) return ROOT;
  return path.isAbsolute(text) ? text : path.join(ROOT, text);
}

function parseVersion(raw: unknown) {
  const text = cleanText(raw || '', 24);
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  return {
    raw: m[0],
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3] || 0)
  };
}

function readJsonPathValue(obj: AnyObj, jsonPath: string) {
  const parts = String(jsonPath || '').split('.').filter(Boolean);
  let cur: any = obj;
  for (const part of parts) {
    if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return null;
    cur = cur[part];
  }
  return cur;
}

function defaultPolicy() {
  return {
    schema_id: 'schema_evolution_policy',
    schema_version: '1.0',
    enabled: true,
    mode: 'enforce',
    default_n_minus_minor: 2,
    auto_migrate_minor_drift: true,
    max_auto_migrate_minor_delta: 6,
    latest_path: 'state/ops/schema_evolution/latest.json',
    receipts_path: 'state/ops/schema_evolution/receipts.jsonl',
    lanes: []
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const src = readJson(policyPath, {});
  const lanes = Array.isArray(src.lanes) ? src.lanes : base.lanes;
  return {
    schema_id: 'schema_evolution_policy',
    schema_version: cleanText(src.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: src.enabled !== false,
    mode: normalizeToken(src.mode || base.mode, 24) === 'advisory' ? 'advisory' : 'enforce',
    default_n_minus_minor: clampInt(src.default_n_minus_minor, 0, 12, base.default_n_minus_minor),
    auto_migrate_minor_drift: src.auto_migrate_minor_drift !== false,
    max_auto_migrate_minor_delta: clampInt(src.max_auto_migrate_minor_delta, 0, 24, base.max_auto_migrate_minor_delta),
    latest_path: resolvePath(src.latest_path || base.latest_path),
    receipts_path: resolvePath(src.receipts_path || base.receipts_path),
    lanes,
    policy_path: path.resolve(policyPath)
  };
}

function resolveTargetVersion(lane: AnyObj) {
  const fixed = cleanText(lane.target_version || '', 24);
  if (fixed) return fixed;
  const ref = lane.target_version_ref && typeof lane.target_version_ref === 'object'
    ? lane.target_version_ref
    : null;
  if (!ref) return '';
  const fp = resolvePath(ref.path || '');
  const doc = readJson(fp, {});
  const value = readJsonPathValue(doc, String(ref.json_path || 'schema_version'));
  return cleanText(value || '', 24);
}

function listLaneTargets(lane: AnyObj) {
  const roots = Array.isArray(lane.target_paths)
    ? lane.target_paths.map((row: unknown) => resolvePath(row)).filter(Boolean)
    : [];
  const format = normalizeToken(lane.format || 'json', 16) || 'json';
  if (format === 'jsonl') return roots.filter((fp: string) => fs.existsSync(fp));

  const out: string[] = [];
  const maxDepth = clampInt(lane.max_depth, 0, 8, 3);
  const scan = (dirPath: string, depth: number) => {
    if (!fs.existsSync(dirPath)) return;
    const st = fs.statSync(dirPath);
    if (st.isFile()) {
      if (dirPath.toLowerCase().endsWith('.json')) out.push(dirPath);
      return;
    }
    if (!st.isDirectory() || depth > maxDepth) return;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        scan(abs, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        out.push(abs);
      }
    }
  };

  for (const root of roots) scan(root, 0);
  return out.sort((a, b) => relPath(a).localeCompare(relPath(b)));
}

function withinWindow(ver: AnyObj, current: AnyObj, nMinus: number) {
  if (!ver || !current) return false;
  if (ver.major !== current.major) return false;
  if (ver.minor > current.minor) return false;
  return (current.minor - ver.minor) <= nMinus;
}

function canAutoMigrate(ver: AnyObj, current: AnyObj, policy: AnyObj) {
  if (policy.auto_migrate_minor_drift !== true) return false;
  if (!ver || !current) return false;
  if (ver.major !== current.major) return false;
  if (ver.minor > current.minor) return false;
  const delta = current.minor - ver.minor;
  return delta > 0 && delta <= policy.max_auto_migrate_minor_delta;
}

function migrateJsonFile(filePath: string, fieldPath: string, targetVersion: string) {
  const doc = readJson(filePath, null);
  if (!doc || typeof doc !== 'object') return { ok: false, reason: 'json_parse_failed' };
  const parts = String(fieldPath || '').split('.').filter(Boolean);
  if (!parts.length) return { ok: false, reason: 'version_field_missing' };
  let cur: any = doc;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== 'object') return { ok: false, reason: 'version_field_path_missing' };
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = targetVersion;
  writeJsonAtomic(filePath, doc);
  return { ok: true };
}

function migrateJsonlFile(filePath: string, versionField: string, targetVersion: string) {
  const rows = readJsonl(filePath);
  if (!rows.length) return { ok: true, migrated: 0 };
  let migrated = 0;
  const nextRows = rows.map((row: AnyObj) => {
    if (!row || typeof row !== 'object') return row;
    const currentVersion = cleanText(row[versionField] || '', 24);
    if (!currentVersion || currentVersion === targetVersion) return row;
    migrated += 1;
    return {
      ...row,
      [versionField]: targetVersion
    };
  });
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${nextRows.map((row: AnyObj) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
  return { ok: true, migrated };
}

function evaluateLane(laneRaw: AnyObj, policy: AnyObj, apply: boolean, ts: string, receipts: AnyObj[]) {
  const lane = laneRaw && typeof laneRaw === 'object' ? laneRaw : {};
  const laneId = normalizeToken(lane.id || lane.name || 'lane', 80) || 'lane';
  const format = normalizeToken(lane.format || 'json', 16) || 'json';
  const versionField = cleanText(lane.version_field || 'schema_version', 120) || 'schema_version';
  const nMinus = clampInt(lane.n_minus_minor, 0, 12, policy.default_n_minus_minor);
  const targetVersionRaw = resolveTargetVersion(lane);
  const targetVersion = parseVersion(targetVersionRaw);
  const targetPaths = listLaneTargets(lane);
  const allowMissing = lane.allow_missing_targets === true;

  const failures: AnyObj[] = [];
  const migrations: AnyObj[] = [];
  const scanned: AnyObj[] = [];

  if (!targetVersion) {
    failures.push({ type: 'target_version_invalid', lane_id: laneId, value: targetVersionRaw || null });
  }
  if (!targetPaths.length && !allowMissing) {
    failures.push({ type: 'target_paths_missing', lane_id: laneId });
  }

  for (const fp of targetPaths) {
    if (format === 'jsonl') {
      const rows = readJsonl(fp);
      if (!rows.length) {
        scanned.push({ path: relPath(fp), records: 0, compatible: true, migrations: 0 });
        continue;
      }
      let laneMigrated = 0;
      let compatible = true;
      const migrationNeeded = [] as AnyObj[];
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i] && typeof rows[i] === 'object' ? rows[i] : {};
        const raw = cleanText(row[versionField] || '', 24);
        const ver = parseVersion(raw);
        const isCompat = !!(targetVersion && ver && withinWindow(ver, targetVersion, nMinus));
        if (!isCompat) {
          compatible = false;
          if (targetVersion && ver && canAutoMigrate(ver, targetVersion, policy)) {
            migrationNeeded.push({ line: i + 1, from: raw, to: targetVersion.raw });
          } else {
            failures.push({
              type: 'version_out_of_window',
              lane_id: laneId,
              path: relPath(fp),
              line: i + 1,
              version: raw || null,
              target_version: targetVersion ? targetVersion.raw : null,
              n_minus_minor: nMinus
            });
          }
        }
      }
      if (apply && migrationNeeded.length) {
        const migrated = migrateJsonlFile(fp, versionField, targetVersion!.raw);
        if (migrated.ok) {
          laneMigrated += Number(migrated.migrated || migrationNeeded.length);
          for (const row of migrationNeeded) {
            const receipt = {
              ts,
              type: 'schema_evolution_migration',
              lane_id: laneId,
              path: relPath(fp),
              line: row.line,
              from_version: row.from,
              to_version: row.to,
              format,
              mode: 'auto'
            };
            receipts.push(receipt);
            migrations.push(receipt);
          }
          compatible = true;
        }
      }
      scanned.push({ path: relPath(fp), records: rows.length, compatible, migrations: laneMigrated });
      continue;
    }

    const doc = readJson(fp, null);
    const raw = doc && typeof doc === 'object'
      ? cleanText(readJsonPathValue(doc, versionField) || '', 24)
      : '';
    const ver = parseVersion(raw);
    const isCompat = !!(targetVersion && ver && withinWindow(ver, targetVersion, nMinus));
    let compatible = isCompat;
    let migrated = false;
    if (!isCompat) {
      if (targetVersion && ver && canAutoMigrate(ver, targetVersion, policy) && apply) {
        const m = migrateJsonFile(fp, versionField, targetVersion.raw);
        if (m.ok) {
          migrated = true;
          compatible = true;
          const receipt = {
            ts,
            type: 'schema_evolution_migration',
            lane_id: laneId,
            path: relPath(fp),
            from_version: raw || null,
            to_version: targetVersion.raw,
            format,
            mode: 'auto'
          };
          receipts.push(receipt);
          migrations.push(receipt);
        }
      }
      if (!compatible) {
        failures.push({
          type: 'version_out_of_window',
          lane_id: laneId,
          path: relPath(fp),
          version: raw || null,
          target_version: targetVersion ? targetVersion.raw : null,
          n_minus_minor: nMinus
        });
      }
    }
    scanned.push({ path: relPath(fp), version: raw || null, compatible, migrated });
  }

  return {
    lane_id: laneId,
    format,
    target_version: targetVersion ? targetVersion.raw : null,
    n_minus_minor: nMinus,
    scanned_count: scanned.length,
    migration_count: migrations.length,
    failure_count: failures.length,
    scanned,
    failures,
    migrations
  };
}

function runEvolution(args: AnyObj = {}) {
  const ts = nowIso();
  const strict = toBool(args.strict, false);
  const apply = toBool(args.apply, false);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);

  const lanes = Array.isArray(policy.lanes) ? policy.lanes : [];
  const receipts: AnyObj[] = [];
  const laneResults = lanes.map((lane) => evaluateLane(lane, policy, apply, ts, receipts));
  const failures = laneResults.flatMap((lane) => lane.failures || []);
  const migrationCount = laneResults.reduce((sum, lane) => sum + Number(lane.migration_count || 0), 0);

  const enforce = policy.mode === 'enforce';
  const ok = policy.enabled !== false
    ? (enforce ? failures.length === 0 : true)
    : true;

  const payload = {
    ok,
    type: 'schema_evolution_contract',
    ts,
    strict,
    apply,
    mode: policy.mode,
    policy_version: policy.schema_version,
    policy_path: relPath(policy.policy_path),
    lane_count: laneResults.length,
    failure_count: failures.length,
    migration_count: migrationCount,
    lanes: laneResults,
    failures
  };

  writeJsonAtomic(policy.latest_path, payload);
  for (const row of receipts) {
    appendJsonl(policy.receipts_path, row);
  }
  appendJsonl(policy.receipts_path, {
    ts,
    type: 'schema_evolution_run',
    ok: payload.ok,
    apply,
    mode: policy.mode,
    lane_count: payload.lane_count,
    failure_count: payload.failure_count,
    migration_count: payload.migration_count
  });

  return payload;
}

function cmdRun(args: AnyObj) {
  const payload = runEvolution(args);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if ((payload.strict || payload.mode === 'enforce') && payload.ok !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = readJson(policy.latest_path, {});
  const receipts = readJsonl(policy.receipts_path);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'schema_evolution_status',
    latest,
    recent_receipts: receipts.slice(-20),
    policy_version: policy.schema_version,
    policy_path: relPath(policy.policy_path)
  }, null, 2)}\n`);
}

function main(argv: string[]) {
  const args = parseArgs(argv);
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  runEvolution
};
