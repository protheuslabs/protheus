#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-111
 * Canonical backlog registry + generated views.
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
  readJson,
  writeJsonAtomic,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');
const { loadPolicyRuntime } = require('../../lib/policy_runtime');
const { writeArtifactSet } = require('../../lib/state_artifact_contract');

const DEFAULT_POLICY_PATH = process.env.BACKLOG_REGISTRY_POLICY_PATH
  ? path.resolve(process.env.BACKLOG_REGISTRY_POLICY_PATH)
  : path.join(ROOT, 'config', 'backlog_registry_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/backlog_registry.js sync [--policy=<path>]');
  console.log('  node systems/ops/backlog_registry.js check [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/backlog_registry.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: true,
    active_statuses: ['queued', 'in_progress', 'blocked', 'proposed'],
    archive_statuses: ['done', 'dropped', 'archived', 'obsolete'],
    paths: {
      backlog_path: 'UPGRADE_BACKLOG.md',
      registry_path: 'config/backlog_registry.json',
      active_view_path: 'docs/backlog_views/active.md',
      archive_view_path: 'docs/backlog_views/archive.md',
      latest_path: 'state/ops/backlog_registry/latest.json',
      receipts_path: 'state/ops/backlog_registry/receipts.jsonl'
    }
  };
}

function normalizeId(raw: any) {
  const id = cleanText(raw || '', 120).replace(/`/g, '');
  return /^[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(id) ? id : '';
}

function parseStatus(raw: any) {
  return normalizeToken(raw || 'queued', 80) || 'queued';
}

function parseDeps(raw: any) {
  const parts = String(raw || '')
    .split(',')
    .map((row) => cleanText(row, 120).replace(/`/g, ''))
    .filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    if (!out.includes(part)) out.push(part);
  }
  return out;
}

function parseBacklogRows(markdown: string) {
  const rowsById = new Map();
  for (const lineRaw of String(markdown || '').split(/\r?\n/)) {
    const line = String(lineRaw || '').trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cleanText(cell, 3000));
    if (cells.length < 8) continue;
    const id = normalizeId(cells[0]);
    if (!id) continue;
    if (rowsById.has(id)) continue;
    rowsById.set(id, {
      id,
      class: normalizeToken(cells[1], 80),
      wave: cleanText(cells[2], 48),
      status: parseStatus(cells[3]),
      title: cleanText(cells[4], 500),
      problem: cleanText(cells[5], 1500),
      acceptance: cleanText(cells[6], 1800),
      dependencies: parseDeps(cells[7])
    });
  }
  return Array.from(rowsById.values());
}

function renderView(title: string, rows: any[], generatedAt: string) {
  const body: string[] = [];
  body.push(`# ${title}`);
  body.push('');
  body.push(`Generated: ${generatedAt}`);
  body.push('');
  body.push('| ID | Class | Wave | Status | Title | Dependencies |');
  body.push('|---|---|---|---|---|---|');
  for (const row of rows) {
    body.push(`| ${row.id} | ${row.class || ''} | ${row.wave || ''} | ${row.status || ''} | ${row.title || ''} | ${(row.dependencies || []).join(', ')} |`);
  }
  body.push('');
  return `${body.join('\n')}\n`;
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const loaded = loadPolicyRuntime({
    policyPath,
    defaults: base
  });
  const raw = loaded.raw;
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: toBool(raw.enabled, true),
    strict_default: toBool(raw.strict_default, base.strict_default),
    active_statuses: Array.isArray(raw.active_statuses)
      ? raw.active_statuses.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
      : base.active_statuses,
    archive_statuses: Array.isArray(raw.archive_statuses)
      ? raw.archive_statuses.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
      : base.archive_statuses,
    paths: {
      backlog_path: resolvePath(paths.backlog_path, base.paths.backlog_path),
      registry_path: resolvePath(paths.registry_path, base.paths.registry_path),
      active_view_path: resolvePath(paths.active_view_path, base.paths.active_view_path),
      archive_view_path: resolvePath(paths.archive_view_path, base.paths.archive_view_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function buildArtifacts(policy: any) {
  if (!fs.existsSync(policy.paths.backlog_path)) {
    return {
      ok: false,
      error: 'backlog_missing',
      backlog_path: path.relative(ROOT, policy.paths.backlog_path).replace(/\\/g, '/')
    };
  }
  let generatedAt = nowIso();
  try {
    generatedAt = new Date(fs.statSync(policy.paths.backlog_path).mtimeMs).toISOString();
  } catch {}
  const markdown = fs.readFileSync(policy.paths.backlog_path, 'utf8');
  const sourceHash = stableHash(markdown, 24);
  const rows = parseBacklogRows(markdown);
  const activeSet = new Set(policy.active_statuses || []);
  const archiveSet = new Set(policy.archive_statuses || []);
  const activeRows = rows.filter((row) => activeSet.has(row.status));
  const archiveRows = rows.filter((row) => archiveSet.has(row.status));

  const registry = {
    schema_id: 'backlog_registry_v1',
    schema_version: '1.0',
    generated_at: generatedAt,
    source_hash: sourceHash,
    row_count: rows.length,
    active_count: activeRows.length,
    archive_count: archiveRows.length,
    rows
  };
  const activeView = renderView('Backlog Active View', activeRows, generatedAt);
  const archiveView = renderView('Backlog Archive View', archiveRows, generatedAt);

  return {
    ok: true,
    generated_at: generatedAt,
    registry,
    active_view: activeView,
    archive_view: archiveView,
    hashes: {
      registry_hash: stableHash(JSON.stringify(registry), 24),
      active_view_hash: stableHash(activeView, 24),
      archive_view_hash: stableHash(archiveView, 24),
      source_hash: sourceHash
    }
  };
}

function cmdSync(policy: any) {
  const built = buildArtifacts(policy);
  if (!built.ok) {
    const out = {
      ok: false,
      type: 'backlog_registry',
      action: 'sync',
      ts: nowIso(),
      error: built.error || 'sync_failed'
    };
    writeArtifactSet(
      { latestPath: policy.paths.latest_path, receiptsPath: policy.paths.receipts_path },
      out,
      { schemaId: 'backlog_registry_receipt', schemaVersion: '1.0', artifactType: 'receipt' }
    );
    emit(out, 2);
  }

  writeJsonAtomic(policy.paths.registry_path, built.registry);
  fs.mkdirSync(path.dirname(policy.paths.active_view_path), { recursive: true });
  fs.writeFileSync(policy.paths.active_view_path, built.active_view, 'utf8');
  fs.mkdirSync(path.dirname(policy.paths.archive_view_path), { recursive: true });
  fs.writeFileSync(policy.paths.archive_view_path, built.archive_view, 'utf8');

  const out = writeArtifactSet(
    { latestPath: policy.paths.latest_path, receiptsPath: policy.paths.receipts_path },
    {
      ok: true,
      type: 'backlog_registry',
      action: 'sync',
      ts: nowIso(),
      row_count: built.registry.row_count,
      active_count: built.registry.active_count,
      archive_count: built.registry.archive_count,
      registry_path: path.relative(ROOT, policy.paths.registry_path).replace(/\\/g, '/'),
      active_view_path: path.relative(ROOT, policy.paths.active_view_path).replace(/\\/g, '/'),
      archive_view_path: path.relative(ROOT, policy.paths.archive_view_path).replace(/\\/g, '/'),
      ...built.hashes
    },
    { schemaId: 'backlog_registry_receipt', schemaVersion: '1.0', artifactType: 'receipt' }
  );
  emit(out, 0);
}

function cmdCheck(args: any, policy: any) {
  const strict = toBool(args.strict, policy.strict_default);
  const built = buildArtifacts(policy);
  if (!built.ok) {
    emit(
      {
        ok: false,
        type: 'backlog_registry',
        action: 'check',
        ts: nowIso(),
        strict,
        error: built.error || 'check_failed'
      },
      strict ? 2 : 0
    );
  }

  const currentRegistry = readJson(policy.paths.registry_path, {});
  const currentActive = fs.existsSync(policy.paths.active_view_path)
    ? fs.readFileSync(policy.paths.active_view_path, 'utf8')
    : '';
  const currentArchive = fs.existsSync(policy.paths.archive_view_path)
    ? fs.readFileSync(policy.paths.archive_view_path, 'utf8')
    : '';

  const expectedHashes = built.hashes;
  const currentHashes = {
    registry_hash: stableHash(JSON.stringify(currentRegistry || {}), 24),
    active_view_hash: stableHash(currentActive || '', 24),
    archive_view_hash: stableHash(currentArchive || '', 24)
  };
  const drift = {
    registry: currentHashes.registry_hash !== expectedHashes.registry_hash,
    active_view: currentHashes.active_view_hash !== expectedHashes.active_view_hash,
    archive_view: currentHashes.archive_view_hash !== expectedHashes.archive_view_hash
  };
  const driftCount = [drift.registry, drift.active_view, drift.archive_view].filter(Boolean).length;
  const ok = driftCount === 0;

  const out = writeArtifactSet(
    { latestPath: policy.paths.latest_path, receiptsPath: policy.paths.receipts_path },
    {
      ok,
      type: 'backlog_registry',
      action: 'check',
      ts: nowIso(),
      strict,
      drift_count: driftCount,
      drift,
      expected_hashes: expectedHashes,
      current_hashes: currentHashes
    },
    { schemaId: 'backlog_registry_receipt', schemaVersion: '1.0', artifactType: 'receipt' }
  );
  emit(out, ok || !strict ? 0 : 2);
}

function cmdStatus(policy: any) {
  const latest = readJson(policy.paths.latest_path, null);
  emit(
    {
      ok: !!latest,
      type: 'backlog_registry',
      action: 'status',
      ts: nowIso(),
      policy_path: path.relative(ROOT, policy.policy_path).replace(/\\/g, '/'),
      latest
    },
    0
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 60) || 'status';
  if (cmd === '--help' || args.help) {
    usage();
    return;
  }
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    emit({
      ok: false,
      type: 'backlog_registry',
      ts: nowIso(),
      error: 'policy_disabled'
    }, 2);
  }
  if (cmd === 'sync') return cmdSync(policy);
  if (cmd === 'check') return cmdCheck(args, policy);
  if (cmd === 'status') return cmdStatus(policy);
  usage();
  emit({ ok: false, error: 'unknown_command', command: cmd }, 2);
}

if (require.main === module) {
  main();
}
