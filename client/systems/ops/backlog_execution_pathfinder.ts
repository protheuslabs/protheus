#!/usr/bin/env node
'use strict';
export {};

/**
 * Backlog execution pathfinder.
 *
 * Purpose:
 * - Determine what queued backlog rows are truly executable now.
 * - Separate rows with runnable lane commands from rows that still need implementation lanes.
 * - Surface top dependency blockers to prioritize cut-through work.
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
  clampInt,
  readJson,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');
const { writeArtifactSet } = require('../../lib/state_artifact_contract');

type AnyObj = Record<string, any>;

type QueueBucket = {
  id: string,
  class: string,
  wave: string,
  title: string,
  has_lane_run: boolean,
  lane_command: string | null,
  dependencies: string[],
  open_dependencies: string[],
  missing_dependency_rows: string[]
};

const DEFAULT_POLICY_PATH = process.env.BACKLOG_EXECUTION_PATHFINDER_POLICY_PATH
  ? path.resolve(process.env.BACKLOG_EXECUTION_PATHFINDER_POLICY_PATH)
  : path.join(ROOT, 'config', 'backlog_execution_pathfinder_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/backlog_execution_pathfinder.js run [--strict=1|0] [--limit=<n>] [--policy=<path>]');
  console.log('  node systems/ops/backlog_execution_pathfinder.js status [--policy=<path>]');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function normalizeId(v: unknown) {
  const id = cleanText(v || '', 120).replace(/`/g, '').toUpperCase();
  return /^[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(id) ? id : '';
}

function asList(v: unknown, maxLen = 160) {
  if (Array.isArray(v)) {
    return v.map((row) => cleanText(row, maxLen)).filter(Boolean);
  }
  const txt = cleanText(v || '', 8000);
  if (!txt) return [];
  return txt.split(',').map((row) => cleanText(row, maxLen)).filter(Boolean);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: false,
    source_registry_path: 'config/backlog_registry.json',
    package_json_path: 'package.json',
    statuses: {
      done: ['done'],
      queued: ['queued', 'proposed'],
      blocked: ['blocked']
    },
    limits: {
      sample_rows: 40,
      blocker_rows: 40
    },
    outputs: {
      latest_path: 'state/ops/backlog_execution_pathfinder/latest.json',
      history_path: 'state/ops/backlog_execution_pathfinder/history.jsonl',
      report_path: 'state/ops/backlog_execution_pathfinder/report.json',
      report_md_path: 'docs/backlog_views/execution_path.md'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const statuses = raw.statuses && typeof raw.statuses === 'object' ? raw.statuses : {};
  const limits = raw.limits && typeof raw.limits === 'object' ? raw.limits : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  return {
    version: cleanText(raw.version || base.version, 32) || '1.0',
    enabled: toBool(raw.enabled, true),
    strict_default: toBool(raw.strict_default, base.strict_default),
    source_registry_path: resolvePath(raw.source_registry_path, base.source_registry_path),
    package_json_path: resolvePath(raw.package_json_path, base.package_json_path),
    statuses: {
      done: asList(statuses.done || base.statuses.done, 40).map((v) => normalizeToken(v, 40)).filter(Boolean),
      queued: asList(statuses.queued || base.statuses.queued, 40).map((v) => normalizeToken(v, 40)).filter(Boolean),
      blocked: asList(statuses.blocked || base.statuses.blocked, 40).map((v) => normalizeToken(v, 40)).filter(Boolean)
    },
    limits: {
      sample_rows: clampInt(limits.sample_rows, 1, 500, base.limits.sample_rows),
      blocker_rows: clampInt(limits.blocker_rows, 1, 500, base.limits.blocker_rows)
    },
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path),
      report_path: resolvePath(outputs.report_path, base.outputs.report_path),
      report_md_path: resolvePath(outputs.report_md_path, base.outputs.report_md_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadRegistryRows(policy: AnyObj) {
  const registry = readJson(policy.source_registry_path, null);
  if (!registry || typeof registry !== 'object' || !Array.isArray(registry.rows)) {
    return {
      ok: false,
      error: 'source_registry_missing_or_invalid',
      source_registry_path: rel(policy.source_registry_path),
      rows: []
    };
  }
  return {
    ok: true,
    rows: registry.rows,
    registry
  };
}

function loadLaneRunMap(policy: AnyObj) {
  const pkg = readJson(policy.package_json_path, {});
  const scripts = pkg && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const map: Record<string, string> = {};
  for (const key of Object.keys(scripts)) {
    const m = key.match(/^lane:([^:]+):run$/i);
    if (!m) continue;
    const id = normalizeId(m[1]);
    if (!id) continue;
    map[id] = cleanText(scripts[key], 2000);
  }
  return {
    ok: true,
    package_json_path: rel(policy.package_json_path),
    lane_run_count: Object.keys(map).length,
    map
  };
}

function normalizeDeps(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const dep of raw) {
    const id = normalizeId(dep);
    if (!id) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function summarizeBlockers(rows: QueueBucket[], limit: number) {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    for (const dep of row.open_dependencies) {
      counts[dep] = Number(counts[dep] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .map(([dependency, blocked_rows]) => ({ dependency, blocked_rows }))
    .sort((a, b) => {
      if (b.blocked_rows !== a.blocked_rows) return b.blocked_rows - a.blocked_rows;
      return a.dependency.localeCompare(b.dependency);
    })
    .slice(0, limit);
}

function renderRowTable(rows: QueueBucket[]) {
  const out: string[] = [];
  out.push('| ID | Wave | Class | Lane | Open Dependencies | Title |');
  out.push('|---|---|---|---|---|---|');
  for (const row of rows) {
    out.push(`| ${row.id} | ${row.wave || ''} | ${row.class || ''} | ${row.has_lane_run ? 'yes' : 'no'} | ${row.open_dependencies.join(', ')} | ${row.title || ''} |`);
  }
  return out;
}

function renderReportMarkdown(report: AnyObj) {
  const lines: string[] = [];
  lines.push('# Backlog Execution Path');
  lines.push('');
  lines.push(`Generated: ${report.ts}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Queued rows: ${report.queued_total}`);
  lines.push(`- Lane run commands discovered: ${report.lane_run_count}`);
  lines.push(`- Lane coverage (queued rows with lane): ${report.lane_coverage_pct}%`);
  lines.push(`- Runnable now (lane + deps closed): ${report.buckets.runnable_ready_count}`);
  lines.push(`- Runnable but blocked by deps: ${report.buckets.runnable_blocked_count}`);
  lines.push(`- Ready but no lane implementation: ${report.buckets.spec_ready_count}`);
  lines.push(`- Blocked + no lane implementation: ${report.buckets.spec_blocked_count}`);
  lines.push('');

  lines.push('## Recommended Next Actions');
  lines.push('');
  for (const rec of report.recommended_actions || []) {
    lines.push(`- ${rec}`);
  }
  lines.push('');

  lines.push('## Runnable Now');
  lines.push('');
  lines.push(...renderRowTable(report.samples.runnable_ready || []));
  lines.push('');

  lines.push('## Ready But Missing Lane Implementation');
  lines.push('');
  lines.push(...renderRowTable(report.samples.spec_ready || []));
  lines.push('');

  lines.push('## Top Dependency Blockers');
  lines.push('');
  lines.push('| Dependency | Blocked Rows |');
  lines.push('|---|---|');
  for (const row of report.top_dependency_blockers || []) {
    lines.push(`| ${row.dependency} | ${row.blocked_rows} |`);
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function analyze(policy: AnyObj, args: AnyObj) {
  const load = loadRegistryRows(policy);
  if (!load.ok) return load;

  const rows = load.rows;
  const byId = new Map<string, AnyObj>();
  for (const row of rows) {
    const id = normalizeId(row && row.id || '');
    if (!id) continue;
    byId.set(id, row);
  }

  const doneSet = new Set((policy.statuses.done || []).map((v: string) => normalizeToken(v, 40)).filter(Boolean));
  const queuedSet = new Set((policy.statuses.queued || []).map((v: string) => normalizeToken(v, 40)).filter(Boolean));

  const doneIds = new Set<string>();
  const queuedRows: AnyObj[] = [];
  for (const row of rows) {
    const id = normalizeId(row && row.id || '');
    if (!id) continue;
    const status = normalizeToken(row && row.status || 'queued', 40) || 'queued';
    if (doneSet.has(status)) doneIds.add(id);
    if (queuedSet.has(status)) queuedRows.push(row);
  }

  const lane = loadLaneRunMap(policy);
  const laneMap = lane.map || {};

  const runnableReady: QueueBucket[] = [];
  const runnableBlocked: QueueBucket[] = [];
  const specReady: QueueBucket[] = [];
  const specBlocked: QueueBucket[] = [];

  for (const row of queuedRows) {
    const id = normalizeId(row.id || '');
    if (!id) continue;
    const deps = normalizeDeps(row.dependencies);
    const openDeps = deps.filter((dep) => !doneIds.has(dep));
    const missingDepRows = deps.filter((dep) => !byId.has(dep));
    const hasLane = !!laneMap[id];

    const normalized: QueueBucket = {
      id,
      class: cleanText(row.class || '', 80),
      wave: cleanText(row.wave || '', 40),
      title: cleanText(row.title || '', 360),
      has_lane_run: hasLane,
      lane_command: hasLane ? laneMap[id] : null,
      dependencies: deps,
      open_dependencies: openDeps,
      missing_dependency_rows: missingDepRows
    };

    if (hasLane && openDeps.length === 0) runnableReady.push(normalized);
    else if (hasLane) runnableBlocked.push(normalized);
    else if (openDeps.length === 0) specReady.push(normalized);
    else specBlocked.push(normalized);
  }

  const queuedTotal = queuedRows.length;
  const laneCoveragePct = queuedTotal > 0
    ? Number(((100 * (runnableReady.length + runnableBlocked.length)) / queuedTotal).toFixed(2))
    : 0;

  const limitOverride = clampInt(args.limit, 1, 500, policy.limits.sample_rows);
  const blockerLimit = clampInt(args['blocker-limit'], 1, 500, policy.limits.blocker_rows);
  const blockers = summarizeBlockers([...runnableBlocked, ...specBlocked], blockerLimit);

  const report = {
    schema_id: 'backlog_execution_path_report',
    schema_version: '1.0',
    artifact_type: 'report',
    ok: true,
    type: 'backlog_execution_pathfinder',
    action: 'run',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    source_registry_path: rel(policy.source_registry_path),
    package_json_path: rel(policy.package_json_path),
    queued_total: queuedTotal,
    lane_run_count: Number(lane.lane_run_count || 0),
    lane_coverage_pct: laneCoveragePct,
    buckets: {
      runnable_ready_count: runnableReady.length,
      runnable_blocked_count: runnableBlocked.length,
      spec_ready_count: specReady.length,
      spec_blocked_count: specBlocked.length
    },
    top_dependency_blockers: blockers,
    samples: {
      runnable_ready: runnableReady.slice(0, limitOverride),
      runnable_blocked: runnableBlocked.slice(0, limitOverride),
      spec_ready: specReady.slice(0, limitOverride),
      spec_blocked: specBlocked.slice(0, limitOverride)
    },
    recommended_actions: [
      `Execute ${runnableReady.length} runnable rows with existing lane commands first (lane:<id>:run + corresponding test:lane:<id>).`,
      `For ${specReady.length} dependency-ready rows without lanes, add runtime lane + test artifacts before marking done.`,
      `Prioritize blocker dependencies (${blockers.slice(0, 10).map((b: AnyObj) => `${b.dependency}:${b.blocked_rows}`).join(', ') || 'none'}) to unlock blocked rows fastest.`
    ]
  };

  writeArtifactSet(
    {
      latestPath: policy.outputs.latest_path,
      historyPath: policy.outputs.history_path
    },
    report,
    {
      schemaId: 'backlog_execution_pathfinder_receipt',
      schemaVersion: '1.0',
      artifactType: 'receipt'
    }
  );

  const reportPath = policy.outputs.report_path;
  const mdPath = policy.outputs.report_md_path;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, renderReportMarkdown(report), 'utf8');

  return {
    ...report,
    report_path: rel(reportPath),
    report_md_path: rel(mdPath)
  };
}

function status(policy: AnyObj) {
  const latest = readJson(policy.outputs.latest_path, null);
  const report = readJson(policy.outputs.report_path, null);
  return {
    ok: true,
    type: 'backlog_execution_pathfinder',
    action: 'status',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    latest,
    report_summary: report
      ? {
        queued_total: Number(report.queued_total || 0),
        lane_coverage_pct: Number(report.lane_coverage_pct || 0),
        runnable_ready_count: Number(report.buckets && report.buckets.runnable_ready_count || 0),
        spec_ready_count: Number(report.buckets && report.buckets.spec_ready_count || 0),
        top_dependency_blockers: Array.isArray(report.top_dependency_blockers)
          ? report.top_dependency_blockers.slice(0, 10)
          : []
      }
      : null
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

  if (!policy.enabled) emit({ ok: false, error: 'backlog_execution_pathfinder_disabled' }, 1);

  if (cmd === 'run') {
    const strict = toBool(args.strict, policy.strict_default);
    const out = analyze(policy, args);
    if (strict && out.ok !== true) emit(out, 1);
    emit(out, 0);
  }

  if (cmd === 'status') {
    emit(status(policy), 0);
  }

  usage();
  process.exit(1);
}

main();
