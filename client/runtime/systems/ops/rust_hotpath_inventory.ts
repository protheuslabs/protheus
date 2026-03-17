#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT } = require('./run_protheus_ops.js');

const DEFAULT_POLICY = path.join(ROOT, 'client', 'runtime', 'config', 'rust_hotpath_inventory_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function parseFlag(argv, key, fallback = null) {
  const prefix = `--${key}=`;
  for (const arg of argv || []) {
    const raw = String(arg || '').trim();
    if (raw.startsWith(prefix)) return raw.slice(prefix.length);
    if (raw === `--${key}`) return '1';
  }
  return fallback;
}

function parseBool(argv, key, fallback = false) {
  const raw = parseFlag(argv, key, null);
  if (raw == null) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function appendJsonl(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function gitTrackedFiles() {
  const proc = spawnSync('git', ['ls-files', '*.ts', '*.rs'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (proc.status !== 0) {
    throw new Error(`git_ls_files_failed:${String(proc.stderr || proc.stdout || '').trim()}`);
  }
  return String(proc.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function countLines(text) {
  if (!text) return 0;
  return String(text).split('\n').length;
}

function statSourceLineCounts(files) {
  let trackedTsLines = 0;
  let trackedRsLines = 0;
  const records = [];
  for (const relPath of files) {
    const absPath = path.join(ROOT, relPath);
    if (!fs.existsSync(absPath)) continue;
    const text = fs.readFileSync(absPath, 'utf8');
    const lines = countLines(text);
    if (relPath.endsWith('.ts')) trackedTsLines += lines;
    if (relPath.endsWith('.rs')) trackedRsLines += lines;
    records.push({
      path: relPath,
      lines,
      ext: path.extname(relPath).toLowerCase(),
      text,
    });
  }
  return { trackedTsLines, trackedRsLines, records };
}

function relRuntimePath(relPath) {
  return relPath.startsWith('client/runtime/') ? relPath.slice('client/runtime/'.length) : relPath;
}

function inScanRoots(relPath, roots) {
  const runtimePath = relRuntimePath(relPath);
  return roots.some((root) => runtimePath === root || runtimePath.startsWith(`${root}/`));
}

function directoryBuckets(records, limit) {
  const buckets = new Map();
  for (const record of records) {
    const relDir = path.posix.dirname(record.path);
    buckets.set(relDir, (buckets.get(relDir) || 0) + record.lines);
  }
  return [...buckets.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([dir, lines]) => ({ path: dir, lines }));
}

function fileBuckets(records, limit) {
  return records
    .map((record) => ({ path: record.path, lines: record.lines }))
    .sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path))
    .slice(0, limit);
}

function rustMilestones(trackedRsLines, trackedTsLines, milestones) {
  const total = trackedRsLines + trackedTsLines;
  return milestones.map((targetPct) => {
    const pct = Number(targetPct);
    const needed = Math.max(0, Math.ceil((pct / 100) * total - trackedRsLines));
    return {
      target_percent: pct,
      additional_rs_lines_needed: needed,
    };
  });
}

function isThinBridge(record) {
  if (record.ext !== '.ts') return false;
  const text = record.text;
  const normalized = String(text || '');
  return (
    normalized.includes('createOpsLaneBridge') ||
    normalized.includes("runProtheusOps(args") ||
    normalized.includes("runProtheusOps(['") ||
    normalized.includes("require('./run_protheus_ops.js')") ||
    normalized.includes('Thin TypeScript wrapper only') ||
    normalized.includes('thin CLI bridge') ||
    normalized.includes('compatibility shim only') ||
    normalized.includes('Layer ownership: core/layer0/ops') && (
      normalized.includes('runProtheusOps(') ||
      normalized.includes('createOpsLaneBridge(')
    )
  );
}

function buildInventory(argv = []) {
  const policyPath = path.resolve(ROOT, parseFlag(argv, 'policy', DEFAULT_POLICY));
  const policy = readJson(policyPath);
  const trackedFiles = gitTrackedFiles();
  const { trackedTsLines, trackedRsLines, records } = statSourceLineCounts(trackedFiles);
  const runtimeRecords = records.filter((record) => inScanRoots(record.path, policy.scan.roots || []));
  const topDirectories = directoryBuckets(
    runtimeRecords.filter((record) => record.ext === '.ts'),
    Number(policy.report.top_directories || 15)
  );
  const topFiles = fileBuckets(
    runtimeRecords.filter((record) => record.ext === '.ts'),
    Number(policy.report.top_files || 30)
  );
  const bridgeWrapperCount = runtimeRecords.filter(isThinBridge).length;
  const payload = {
    ok: true,
    type: 'rust_hotpath_inventory',
    ts: nowIso(),
    policy_path: path.relative(ROOT, policyPath),
    tracked_ts_lines: trackedTsLines,
    tracked_rs_lines: trackedRsLines,
    rust_percent: Number(((trackedRsLines / Math.max(1, trackedRsLines + trackedTsLines)) * 100).toFixed(2)),
    runtime_scope: {
      roots: policy.scan.roots || [],
      ts_files: runtimeRecords.filter((record) => record.ext === '.ts').length,
      rs_files: runtimeRecords.filter((record) => record.ext === '.rs').length,
      bridge_wrappers_excluded_from_queue: bridgeWrapperCount,
    },
    top_directories: topDirectories,
    top_files: topFiles,
    milestones: rustMilestones(trackedRsLines, trackedTsLines, policy.report.milestones || []),
  };
  return { payload, policy };
}

function run(argv = process.argv.slice(2)) {
  const command = String(argv[0] || 'status').trim().toLowerCase();
  const rest = argv.slice(1);
  const { payload, policy } = buildInventory(rest);
  const latestPath = path.join(ROOT, policy.paths.latest_path);
  const historyPath = path.join(ROOT, policy.paths.history_path);
  if (command === 'status') {
    if (fs.existsSync(latestPath)) {
      process.stdout.write(`${fs.readFileSync(latestPath, 'utf8').trim()}\n`);
      return 0;
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return 0;
  }
  if (command !== 'run') {
    process.stderr.write('Usage: node client/runtime/systems/ops/rust_hotpath_inventory.ts <run|status> [--policy=<path>]\n');
    return 2;
  }
  writeJson(latestPath, payload);
  appendJsonl(historyPath, payload);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  return 0;
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = {
  buildInventory,
  isThinBridge,
  run,
};
