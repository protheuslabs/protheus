#!/usr/bin/env node
/* eslint-disable no-console */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SRS_PATH = 'docs/workspace/SRS.md';
const ACTIONABLE_PATH = 'core/local/artifacts/srs_actionable_map_current.json';
const OUT_MD = 'local/workspace/reports/BLOCKED_EXTERNAL_UNBLOCK_PLAN.md';
const OUT_JSON = 'core/local/artifacts/blocked_external_unblock_plan_current.json';

function read(path) {
  return readFileSync(resolve(path), 'utf8');
}

function parseSrsRows(markdown) {
  const rows = new Map();
  const lines = markdown.split('\n');
  let section = 'Uncategorized';
  for (const line of lines) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      section = h[1].trim();
      continue;
    }
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 5) continue;
    if (cells[0] === 'ID' || cells[0] === '---') continue;
    const id = cells[0];
    if (!/^V[0-9A-Z]+-/.test(id)) continue;
    const status = (cells[1] ?? '').toLowerCase();
    const upgrade = cells[2] ?? '';
    const why = cells[3] ?? '';
    // Some rows contain literal `|` in exit criteria. Rebuild using trailing Impact/Layer columns.
    const impact = cells.length >= 6 ? cells[cells.length - 2] : '';
    const layerMap = cells.length >= 7 ? cells[cells.length - 1] : '';
    const exitCriteria =
      cells.length > 6 ? cells.slice(4, cells.length - 2).join(' | ') : (cells[4] ?? '');
    rows.set(id, {
      id,
      status,
      upgrade,
      why,
      exitCriteria,
      impact,
      layerMap,
      section,
    });
  }
  return rows;
}

function main() {
  const srsRows = parseSrsRows(read(SRS_PATH));
  const actionable = JSON.parse(read(ACTIONABLE_PATH));
  const blockedRows = (actionable.rows ?? []).filter((r) =>
    ['blocked_external', 'blocked_external_prepared'].includes(r.todoBucket),
  );
  const uniqueById = new Map();
  for (const row of blockedRows) {
    if (!uniqueById.has(row.id)) uniqueById.set(row.id, row);
  }
  const rows = [...uniqueById.values()].map((row) => {
    const srs = srsRows.get(row.id) ?? {};
    return {
      id: row.id,
      impact: row.impact,
      layerMap: row.layerMap,
      section: row.section,
      status: row.status,
      upgrade: srs.upgrade ?? '',
      unblockOwner: 'human_external',
      unblockRef: `SRS:${row.id}`,
    };
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    source: { srs: SRS_PATH, actionable: ACTIONABLE_PATH },
    blockedExternalCount: rows.length,
    rows,
  };

  mkdirSync(dirname(resolve(OUT_JSON)), { recursive: true });
  writeFileSync(resolve(OUT_JSON), `${JSON.stringify(payload, null, 2)}\n`);

  const md = [];
  md.push('# Blocked External Unblock Plan');
  md.push('');
  md.push(`Generated: ${payload.generatedAt}`);
  md.push('');
  md.push(`- blocked_external_count: **${rows.length}**`);
  md.push('- owner model: **human_external**');
  md.push('');
  md.push('| ID | Impact | Layer | Unblock Owner | Unblock Reference | Upgrade / Dependency Theme | Source Section |');
  md.push('| --- | ---: | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    md.push(
      `| ${row.id} | ${row.impact ?? ''} | ${row.layerMap ?? ''} | ${row.unblockOwner} | ${row.unblockRef} | ${row.upgrade.replaceAll('|', '\\|')} | ${row.section.replaceAll('|', '\\|')} |`,
    );
  }
  md.push('');
  writeFileSync(resolve(OUT_MD), `${md.join('\n')}\n`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        type: 'blocked_external_unblock_plan',
        out_json: OUT_JSON,
        out_markdown: OUT_MD,
        blocked_external_count: rows.length,
      },
      null,
      2,
    ),
  );
}

main();
