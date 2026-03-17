#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT } = require('./run_protheus_ops.js');
const {
  buildInventory,
  hasAuthorityMarker,
  isExtensionSurface,
  isThinBridge
} = require('./rust_hotpath_inventory.ts');

const HOTPATH_CSV = path.join(ROOT, 'docs', 'client', 'generated', 'RUST60_TS_HOTPATHS_RANKED_FULL.csv');
const HOTPATH_MD = path.join(ROOT, 'docs', 'client', 'generated', 'RUST60_TS_HOTPATHS_RANKED_FULL.md');
const QUEUE_JSON = path.join(ROOT, 'docs', 'client', 'generated', 'RUST60_EXECUTION_QUEUE_261.json');
const QUEUE_MD = path.join(ROOT, 'docs', 'client', 'generated', 'RUST60_EXECUTION_QUEUE_261.md');

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

function parseIntFlag(argv, key, fallback) {
  const raw = Number(parseFlag(argv, key, fallback));
  return Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : fallback;
}

function routeWeight(relPath) {
  const weighted = [
    ['client/runtime/systems/autonomy/', 4.3],
    ['client/runtime/systems/security/', 4.3],
    ['client/runtime/systems/ops/', 4.3],
    ['client/runtime/systems/memory/', 4.3],
    ['client/runtime/systems/sensory/', 4.3],
    ['client/runtime/systems/assimilation/', 4.3],
    ['client/runtime/systems/routing/', 3.6],
    ['client/runtime/systems/workflow/', 3.4],
    ['client/runtime/systems/spine/', 3.4],
    ['client/runtime/systems/personas/', 3.2],
    ['client/runtime/lib/', 2.8],
    ['client/lib/', 2.2],
    ['adapters/', 2.1],
  ];
  for (const [prefix, weight] of weighted) {
    if (relPath.startsWith(prefix)) return weight;
  }
  return 1.5;
}

function shouldExclude(record) {
  const relPath = record.path;
  const base = path.posix.basename(relPath);
  if (!relPath.endsWith('.ts')) return true;
  if (relPath.startsWith('tests/')) return true;
  if ((base.includes('benchmark') || relPath.includes('/benchmarks/')) && !hasAuthorityMarker(record)) return true;
  if (relPath.startsWith('client/runtime/systems/ui/')) return true;
  if (isExtensionSurface(record) && !hasAuthorityMarker(record)) return true;
  if (relPath === 'client/runtime/systems/conduit/conduit-client.ts') return true;
  if (relPath === 'client/runtime/lib/rust_lane_bridge.ts') return true;
  if (relPath === 'client/runtime/lib/spine_conduit_bridge.ts') return true;
  if (relPath === 'client/runtime/lib/ts_bootstrap.ts') return true;
  if (relPath === 'client/runtime/lib/exec_compacted.ts') return true;
  if (relPath === 'client/runtime/lib/backlog_lane_cli.ts') return true;
  if (base.endsWith('_bridge.ts')) return true;
  if (base.endsWith('_client.ts')) return true;
  if (base.endsWith('_cli.ts')) return true;
  if (relPath.includes('/habits/')) return true;
  if (relPath.includes('/reflexes/')) return true;
  if (relPath.includes('/eyes/')) return true;
  return isThinBridge(record);
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeText(filePath, text) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, text);
}

function toCsv(rows) {
  const header = ['rank', 'path', 'loc', 'weight', 'impact_score', 'cumulative_migrated_ts_lines', 'projected_rust_percent_after_lane'];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push([
      row.rank,
      row.path,
      row.loc,
      row.weight,
      row.impact_score,
      row.cumulative_migrated_ts_lines,
      row.projected_rust_percent_after_lane,
    ].join(','));
  }
  return `${lines.join('\n')}\n`;
}

function toMd(title, rows) {
  const lines = [
    `# ${title}`,
    '',
    `Generated: ${nowIso()}`,
    '',
    '| Rank | Path | LOC | Impact | Cumulative TS Migrated | Projected Rust % |',
    '|---:|---|---:|---:|---:|---:|',
  ];
  for (const row of rows) {
    lines.push(`| ${row.rank} | ${row.path} | ${row.loc} | ${row.impact_score} | ${row.cumulative_migrated_ts_lines} | ${row.projected_rust_percent_after_lane} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function buildQueue(argv = []) {
  const max = parseIntFlag(argv, 'max', 100);
  const { payload } = buildInventory([]);
  const trackedFiles = require('child_process')
    .spawnSync('git', ['ls-files', '*.ts'], { cwd: ROOT, encoding: 'utf8' })
    .stdout.split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const records = trackedFiles.map((relPath) => {
    const abs = path.join(ROOT, relPath);
    const text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    return {
      path: relPath,
      lines: text ? String(text).split('\n').length : 0,
      text,
    };
  });
  const candidates = records
    .filter((record) => !shouldExclude({ path: record.path, lines: record.lines, text: record.text, ext: '.ts' }))
    .map((record) => ({
      path: record.path,
      loc: record.lines,
      weight: routeWeight(record.path),
      impact_score: Number((record.lines * routeWeight(record.path)).toFixed(1)),
    }))
    .sort((a, b) => b.impact_score - a.impact_score || b.loc - a.loc || a.path.localeCompare(b.path));

  const extensionSurfaceExcluded = records.filter((record) =>
    record.path.endsWith('.ts') &&
    isExtensionSurface(record) &&
    !hasAuthorityMarker(record)
  ).length;

  let cumulative = 0;
  const lanes = candidates.map((candidate, index) => {
    cumulative += candidate.loc;
    const projected = ((payload.tracked_rs_lines + cumulative) / Math.max(1, payload.tracked_rs_lines + payload.tracked_ts_lines)) * 100;
    return {
      lane_id: `R60-${String(index + 1).padStart(4, '0')}`,
      rank: index + 1,
      path: candidate.path,
      loc: candidate.loc,
      weight: candidate.weight,
      impact_score: candidate.impact_score,
      cumulative_migrated_ts_lines: cumulative,
      projected_rust_percent_after_lane: Number(projected.toFixed(3)),
      status: 'queued',
    };
  });

  return {
    ok: true,
    type: 'roi_top_queue',
    ts: nowIso(),
    target_rust_percent: 60,
    rust_percent: payload.rust_percent,
    current_rust_percent: payload.rust_percent,
    target_already_met: payload.rust_percent >= 60,
    queue_size: lanes.length,
    bridge_wrappers_excluded: payload.runtime_scope.bridge_wrappers_excluded_from_queue,
    extension_surfaces_excluded: extensionSurfaceExcluded,
    stale_reference_repair: true,
    queue: lanes,
    lanes,
    top_candidates: lanes.slice(0, max),
    top: lanes.slice(0, max),
  };
}

function run(argv = process.argv.slice(2)) {
  const queue = buildQueue(argv);
  const hotpaths = queue.lanes.map((lane) => ({
    rank: lane.rank,
    path: lane.path,
    loc: lane.loc,
    impact_score: lane.impact_score,
    cumulative_migrated_ts_lines: lane.cumulative_migrated_ts_lines,
    projected_rust_percent_after_lane: lane.projected_rust_percent_after_lane,
  }));

  writeText(HOTPATH_CSV, toCsv(hotpaths));
  writeText(HOTPATH_MD, toMd('RUST60 Live TS Hotpaths', hotpaths));
  writeText(QUEUE_JSON, `${JSON.stringify(queue, null, 2)}\n`);
  writeText(QUEUE_MD, toMd('RUST60 Live Execution Queue', queue.lanes));

  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'top50_roi_sweep',
    ts: queue.ts,
    current_rust_percent: queue.current_rust_percent,
    target_already_met: queue.target_already_met,
    queue_size: queue.queue_size,
    bridge_wrappers_excluded: queue.bridge_wrappers_excluded,
    extension_surfaces_excluded: queue.extension_surfaces_excluded,
    top_count: queue.top.length,
    output_files: {
      hotpath_csv: path.relative(ROOT, HOTPATH_CSV),
      hotpath_md: path.relative(ROOT, HOTPATH_MD),
      queue_json: path.relative(ROOT, QUEUE_JSON),
      queue_md: path.relative(ROOT, QUEUE_MD),
    },
  })}\n`);
  return 0;
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = {
  buildQueue,
  routeWeight,
  run,
  shouldExclude,
};
