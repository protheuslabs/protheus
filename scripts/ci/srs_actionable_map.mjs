#!/usr/bin/env node
/* eslint-disable no-console */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SRS_PATH = 'docs/workspace/SRS.md';
const OUT_JSON = 'core/local/artifacts/srs_actionable_map_current.json';
const OUT_MD = 'local/workspace/reports/SRS_ACTIONABLE_MAP_CURRENT.md';

function read(path) {
  return readFileSync(resolve(path), 'utf8');
}

function parseSrsRows(markdown) {
  const rows = [];
  const lines = markdown.split('\n');
  let section = 'Uncategorized';
  for (const line of lines) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      section = h[1].trim();
      continue;
    }
    if (!line.startsWith('|')) continue;
    const statusMatch = line.match(
      /^\|\s*(V[^|]+?)\s*\|\s*(queued|in_progress|blocked|blocked_external_prepared|done|existing-coverage-validated)\s*\|/i,
    );
    if (!statusMatch) continue;
    const id = statusMatch[1].trim();
    const status = statusMatch[2].toLowerCase();
    if (id === 'ID' || id.startsWith('---')) continue;
    if (!/^V[0-9A-Z._-]+$/i.test(id)) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    rows.push({
      id,
      status,
      upgrade: cells[2] ?? '',
      impact: cells[5] ?? '',
      layerMap: cells[6] ?? '',
      section,
    });
  }
  return rows;
}

function loadScripts() {
  const pkg = JSON.parse(read('package.json'));
  return pkg.scripts ?? {};
}

function firstCmdSegment(cmd) {
  return (cmd.split('&&')[0] ?? cmd).split('||')[0].trim();
}

function detectMissingNodeEntrypoint(cmd) {
  const seg = firstCmdSegment(cmd);
  const parts = seg.split(/\s+/).filter(Boolean);
  if (parts[0] !== 'node') return null;
  let i = 1;
  while (i < parts.length && parts[i].startsWith('-')) i += 1;
  const entry = String(parts[i] ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
  if (!entry || entry.startsWith('$')) return null;
  return existsSync(entry) ? null : entry;
}

function parseNestedNpmRun(cmd) {
  const seg = firstCmdSegment(cmd);
  const parts = seg.split(/\s+/).filter(Boolean);
  if (parts[0] !== 'npm' || parts[1] !== 'run') return null;
  for (let i = 2; i < parts.length; i += 1) {
    const token = parts[i];
    if (token === '--' || token.startsWith('-')) continue;
    return token;
  }
  return null;
}

function resolveMissingEntrypoint(scriptName, scripts, seen = new Set(), depth = 0) {
  if (depth > 6) return null;
  if (seen.has(scriptName)) return null;
  seen.add(scriptName);
  const cmd = scripts[scriptName];
  if (!cmd) return `SCRIPT_MISSING:${scriptName}`;

  const directMissing = detectMissingNodeEntrypoint(cmd);
  if (directMissing) return directMissing;

  const nested = parseNestedNpmRun(cmd);
  if (!nested) return null;
  return resolveMissingEntrypoint(nested, scripts, seen, depth + 1);
}

function laneNameForId(id) {
  return `lane:${id.toLowerCase().replace(/_/g, '-')}:run`;
}

function hasDynamicLegacyFallback() {
  return existsSync('client/runtime/systems/compat/legacy_alias_adapter.ts');
}

function classify(row, scripts) {
  if (row.status === 'blocked') {
    return {
      todoBucket: 'blocked_external',
      hasLaneScript: false,
      laneRunnable: false,
      laneScript: null,
      missingEntrypoint: null,
      unblock: 'requires external/human dependency resolution',
    };
  }
  if (row.status === 'blocked_external_prepared') {
    return {
      todoBucket: 'blocked_external_prepared',
      hasLaneScript: false,
      laneRunnable: false,
      laneScript: null,
      missingEntrypoint: null,
      unblock: 'external dependency packet prepared; awaiting human/third-party authority artifacts',
    };
  }
  const actionable = row.status === 'queued' || row.status === 'in_progress';
  if (!actionable) {
    return {
      todoBucket: 'already_done',
      hasLaneScript: false,
      laneRunnable: false,
      laneScript: null,
      missingEntrypoint: null,
      unblock: '',
    };
  }

  const laneScript = laneNameForId(row.id);
  const hasLaneScript = Object.prototype.hasOwnProperty.call(scripts, laneScript);
  if (!hasLaneScript) {
    const hasLegacyDynamic = hasDynamicLegacyFallback();
    return {
      todoBucket: hasLegacyDynamic ? 'repair_lane' : 'design_required',
      hasLaneScript,
      laneRunnable: false,
      laneScript: hasLegacyDynamic ? `dynamic:legacy_alias_adapter:${row.id}` : laneScript,
      missingEntrypoint: null,
      unblock: hasLegacyDynamic
        ? 'legacy dynamic fallback is disallowed for completion; add a concrete lane script + tests'
        : 'no executable lane script; requires implementation lane definition',
    };
  }

  const missingEntrypoint = resolveMissingEntrypoint(laneScript, scripts);
  if (missingEntrypoint) {
    return {
      todoBucket: 'repair_lane',
      hasLaneScript,
      laneRunnable: false,
      laneScript,
      missingEntrypoint,
      unblock: 'lane script references missing entrypoint and needs bridge/remap',
    };
  }

  return {
    todoBucket: 'execute_now',
    hasLaneScript,
    laneRunnable: true,
    laneScript,
    missingEntrypoint: null,
    unblock: '',
  };
}

function toMarkdown(summary, rows) {
  const lines = [];
  lines.push('# SRS Actionable Map (Current)');
  lines.push('');
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- actionable_total: ${summary.actionable_total}`);
  lines.push(`- queued: ${summary.queued}`);
  lines.push(`- in_progress: ${summary.in_progress}`);
  lines.push(`- blocked: ${summary.blocked}`);
  lines.push(`- blocked_external_prepared: ${summary.blocked_external_prepared}`);
  lines.push(`- existing_coverage_validated: ${summary.existing_coverage_validated}`);
  lines.push(`- execute_now: ${summary.execute_now}`);
  lines.push(`- repair_lane: ${summary.repair_lane}`);
  lines.push(`- design_required: ${summary.design_required}`);
  lines.push(`- blocked_external: ${summary.blocked_external}`);
  lines.push('');
  lines.push('| ID | Status | Bucket | Impact | Layer | Lane | Runnable | Missing Entrypoint | Section |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    lines.push(
      `| ${r.id} | ${r.status} | ${r.todoBucket} | ${r.impact || ''} | ${r.layerMap || ''} | ${r.laneScript || ''} | ${r.laneRunnable ? 'yes' : 'no'} | ${r.missingEntrypoint || ''} | ${r.section} |`,
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main() {
  const srs = parseSrsRows(read(SRS_PATH));
  const scripts = loadScripts();

  const statusPriority = {
    blocked: 4,
    in_progress: 3,
    queued: 2,
    blocked_external_prepared: 1,
  };

  const dedup = new Map();
  for (const row of srs
    .filter((r) => ['queued', 'in_progress', 'blocked', 'blocked_external_prepared'].includes(r.status))
    .map((r) => ({ ...r, ...classify(r, scripts) }))) {
    const existing = dedup.get(row.id);
    if (!existing) {
      dedup.set(row.id, row);
      continue;
    }
    const currentScore = statusPriority[row.status] ?? 0;
    const existingScore = statusPriority[existing.status] ?? 0;
    if (currentScore > existingScore) dedup.set(row.id, row);
  }
  const rows = [...dedup.values()].sort((a, b) => a.id.localeCompare(b.id));

  const queued = rows.filter((r) => r.status === 'queued').length;
  const inProgress = rows.filter((r) => r.status === 'in_progress').length;
  const blocked = rows.filter((r) => r.status === 'blocked').length;
  const blockedPrepared = rows.filter((r) => r.status === 'blocked_external_prepared').length;
  const summary = {
    generatedAt: new Date().toISOString(),
    actionable_total: queued + inProgress + blocked,
    queued,
    in_progress: inProgress,
    blocked,
    blocked_external_prepared: blockedPrepared,
    existing_coverage_validated: srs.filter((r) => r.status === 'existing-coverage-validated').length,
    execute_now: rows.filter((r) => r.todoBucket === 'execute_now').length,
    repair_lane: rows.filter((r) => r.todoBucket === 'repair_lane').length,
    design_required: rows.filter((r) => r.todoBucket === 'design_required').length,
    blocked_external: rows.filter((r) => r.todoBucket === 'blocked_external').length,
  };

  const out = { ok: true, type: 'srs_actionable_map', summary, rows };
  mkdirSync(dirname(resolve(OUT_JSON)), { recursive: true });
  mkdirSync(dirname(resolve(OUT_MD)), { recursive: true });
  writeFileSync(resolve(OUT_JSON), JSON.stringify(out, null, 2) + '\n');
  writeFileSync(resolve(OUT_MD), toMarkdown(summary, rows));
  console.log(JSON.stringify({ ok: true, type: out.type, out_json: OUT_JSON, out_md: OUT_MD, summary }, null, 2));
}

main();
