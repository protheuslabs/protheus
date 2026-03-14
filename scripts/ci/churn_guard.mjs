#!/usr/bin/env node
/* eslint-disable no-console */
// TODO(rkapoor): Add threshold validation for weekly churn % - Q2 2026
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT_JSON = 'core/local/artifacts/churn_guard_current.json';
const OUT_MD = 'local/workspace/reports/CHURN_GUARD_CURRENT.md';

function parseArgs(argv) {
  return {
    strict: argv.includes('--strict=1') || argv.includes('--strict'),
  };
}

function classifyPath(path) {
  if (
    path.startsWith('local/') ||
    path.startsWith('simulated-commits/') ||
    path === 'config/rohan_github_credentials.md'
  ) {
    return 'local_simulation_churn';
  }
  if (
    path.startsWith('packages/lensmap/') ||
    path.startsWith('tests/fixtures/lensmap_') ||
    path === 'core/layer0/ops/src/bin/lensmap.rs'
  ) {
    return 'lensmap_churn';
  }
  if (
    /^core\/local\/artifacts\/.*_current\.json$/i.test(path) ||
    (/^docs\/workspace\/SRS_.*CURRENT\.md$/i.test(path) || /^local\/workspace\/reports\/SRS_.*CURRENT\.md$/i.test(path)) ||
    path === 'docs/workspace/BLOCKED_EXTERNAL_EVIDENCE_STATUS.md' ||
    path === 'local/workspace/reports/BLOCKED_EXTERNAL_EVIDENCE_STATUS.md' ||
    path === 'docs/workspace/BLOCKED_EXTERNAL_RECONCILE_CANDIDATES.md' ||
    path === 'local/workspace/reports/BLOCKED_EXTERNAL_RECONCILE_CANDIDATES.md' ||
    path === 'docs/workspace/BLOCKED_EXTERNAL_UNBLOCK_PLAN.md' ||
    path === 'local/workspace/reports/BLOCKED_EXTERNAL_UNBLOCK_PLAN.md' ||
    path === 'docs/workspace/BLOCKED_EXTERNAL_PACKET_AUDIT.md' ||
    path === 'local/workspace/reports/BLOCKED_EXTERNAL_PACKET_AUDIT.md' ||
    path === 'docs/workspace/BLOCKED_EXTERNAL_TOP10.md' ||
    path === 'local/workspace/reports/BLOCKED_EXTERNAL_TOP10.md'
  ) {
    return 'generated_report_churn';
  }
  return 'other';
}

function parseStatus() {
  const raw = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
  if (!raw) return [];
  return raw
    .split('\n')
    .map((line) => line.trimEnd())
    .map((line) => {
      const status = line.slice(0, 2).trim();
      const path = line.slice(3).trim();
      return { status, path, category: classifyPath(path) };
    });
}

function toMarkdown(payload) {
  const lines = [];
  lines.push('# Churn Guard (Current)');
  lines.push('');
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- strict: ${payload.summary.strict}`);
  lines.push(`- total_dirty_entries: ${payload.summary.total}`);
  lines.push(`- local_simulation_churn: ${payload.summary.local_simulation_churn}`);
  lines.push(`- lensmap_churn: ${payload.summary.lensmap_churn}`);
  lines.push(`- generated_report_churn: ${payload.summary.generated_report_churn}`);
  lines.push(`- other: ${payload.summary.other}`);
  lines.push(`- pass: ${payload.summary.pass}`);
  lines.push('');
  if (payload.rows.length > 0) {
    lines.push('| Status | Category | Path |');
    lines.push('| --- | --- | --- |');
    for (const row of payload.rows) {
      lines.push(`| ${row.status} | ${row.category} | ${row.path} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = parseStatus();
  const summary = {
    strict: args.strict,
    total: rows.length,
    local_simulation_churn: rows.filter((r) => r.category === 'local_simulation_churn').length,
    lensmap_churn: rows.filter((r) => r.category === 'lensmap_churn').length,
    generated_report_churn: rows.filter((r) => r.category === 'generated_report_churn').length,
    other: rows.filter((r) => r.category === 'other').length,
  };
  summary.pass =
    summary.local_simulation_churn === 0 &&
    summary.lensmap_churn === 0 &&
    summary.other === 0;

  const payload = {
    ok: true,
    type: 'churn_guard',
    generatedAt: new Date().toISOString(),
    summary,
    rows,
  };

  mkdirSync(resolve('core/local/artifacts'), { recursive: true });
  mkdirSync(resolve('local/workspace/reports'), { recursive: true });
  writeFileSync(resolve(OUT_JSON), `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(resolve(OUT_MD), toMarkdown(payload));

  if (args.strict && !summary.pass) {
    console.error(
      JSON.stringify(
        { ok: false, type: 'churn_guard', out_json: OUT_JSON, out_markdown: OUT_MD, summary },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      { ok: true, type: 'churn_guard', out_json: OUT_JSON, out_markdown: OUT_MD, summary },
      null,
      2,
    ),
  );
}

main();
