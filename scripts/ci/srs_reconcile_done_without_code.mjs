#!/usr/bin/env node
/* eslint-disable no-console */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REGRESSION_PATH = process.argv[2] || 'core/local/artifacts/srs_full_regression_current.json';
const TARGETS = ['docs/workspace/SRS.md', 'docs/workspace/UPGRADE_BACKLOG.md'];

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function collectIds(report) {
  const ids = new Set();
  for (const row of report.rows || []) {
    if (!row || String(row.status || '').trim().toLowerCase() !== 'done') continue;
    const findings = Array.isArray(row?.regression?.findings) ? row.regression.findings : [];
    if (
      findings.includes('done_without_non_backlog_evidence') ||
      findings.includes('done_without_code_or_test_evidence')
    ) {
      ids.add(String(row.id || '').trim());
    }
  }
  return ids;
}

function patchMarkdown(markdown, ids) {
  let changed = 0;
  const out = String(markdown || '')
    .split('\n')
    .map((line) => {
      if (!line.startsWith('|')) return line;
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
      if (cells.length < 2) return line;
      const id = String(cells[0] || '').trim();
      const status = String(cells[1] || '').trim().toLowerCase();
      if (!ids.has(id) || status !== 'done') return line;
      cells[1] = 'in_progress';
      changed += 1;
      return `| ${cells.join(' | ')} |`;
    });
  return { changed, markdown: `${out.join('\n')}\n` };
}

function main() {
  const report = readJson(REGRESSION_PATH);
  const ids = collectIds(report);
  const files = [];
  for (const rel of TARGETS) {
    const abs = resolve(rel);
    const before = readFileSync(abs, 'utf8');
    const result = patchMarkdown(before, ids);
    if (result.changed > 0) writeFileSync(abs, result.markdown);
    files.push({ file: rel, changed: result.changed });
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        type: 'srs_reconcile_done_without_code',
        source: REGRESSION_PATH,
        ids_reconciled: ids.size,
        files,
      },
      null,
      2,
    ),
  );
}

main();
