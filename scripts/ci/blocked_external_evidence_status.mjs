#!/usr/bin/env node
/* eslint-disable no-console */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const PLAN_JSON = 'artifacts/blocked_external_unblock_plan_current.json';
const EVIDENCE_ROOT = 'evidence/external';
const OUT_JSON = 'artifacts/blocked_external_evidence_status_current.json';
const OUT_MD = 'docs/workspace/BLOCKED_EXTERNAL_EVIDENCE_STATUS.md';

function read(path) {
  return readFileSync(resolve(path), 'utf8');
}

function listFilesRecursive(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const rel = full.replace(`${resolve(EVIDENCE_ROOT)}/`, '');
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else {
        out.push(rel);
      }
    }
  };
  walk(resolve(dir));
  return out.sort();
}

function classifyRow(row) {
  const evidenceDir = resolve(EVIDENCE_ROOT, row.id);
  const dirExists = existsSync(evidenceDir);
  const files = dirExists ? listFilesRecursive(evidenceDir) : [];
  const hasReadme = files.some((f) => f.toLowerCase() === `${row.id.toLowerCase()}/readme.md`);
  const hasArtifact = files.some(
    (f) => !f.toLowerCase().endsWith('/readme.md') && !f.toLowerCase().endsWith('/.ds_store'),
  );

  let evidenceStatus = 'missing';
  if (dirExists && !hasReadme) evidenceStatus = 'partial_missing_readme';
  if (dirExists && hasReadme && !hasArtifact) evidenceStatus = 'partial_missing_artifact';
  if (dirExists && hasReadme && hasArtifact) evidenceStatus = 'ready_for_reconcile';

  return {
    ...row,
    evidenceDir: `${EVIDENCE_ROOT}/${row.id}`,
    evidenceStatus,
    hasReadme,
    hasArtifact,
    files,
  };
}

function toMarkdown(payload) {
  const lines = [];
  lines.push('# Blocked External Evidence Status');
  lines.push('');
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- blocked_external_total: ${payload.summary.total}`);
  lines.push(`- ready_for_reconcile: ${payload.summary.ready_for_reconcile}`);
  lines.push(`- partial_missing_readme: ${payload.summary.partial_missing_readme}`);
  lines.push(`- partial_missing_artifact: ${payload.summary.partial_missing_artifact}`);
  lines.push(`- missing: ${payload.summary.missing}`);
  lines.push('');
  lines.push('## Evidence Contract');
  lines.push('- One directory per blocked ID: `evidence/external/<ID>/`');
  lines.push('- Required file 1: `README.md` describing the external decision/evidence and date');
  lines.push('- Required file 2+: at least one concrete evidence artifact (report/cert/screenshot/log/export)');
  lines.push('');
  lines.push('| ID | Impact | Layer | Evidence Status | Evidence Path | Upgrade Theme |');
  lines.push('| --- | ---: | --- | --- | --- | --- |');
  for (const row of payload.rows) {
    lines.push(
      `| ${row.id} | ${row.impact ?? ''} | ${row.layerMap ?? ''} | ${row.evidenceStatus} | ${row.evidenceDir} | ${(row.upgrade ?? '').replaceAll('|', '\\|')} |`,
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main() {
  const plan = JSON.parse(read(PLAN_JSON));
  const rows = (plan.rows ?? []).map(classifyRow);
  const summary = {
    total: rows.length,
    ready_for_reconcile: rows.filter((r) => r.evidenceStatus === 'ready_for_reconcile').length,
    partial_missing_readme: rows.filter((r) => r.evidenceStatus === 'partial_missing_readme').length,
    partial_missing_artifact: rows.filter((r) => r.evidenceStatus === 'partial_missing_artifact').length,
    missing: rows.filter((r) => r.evidenceStatus === 'missing').length,
  };
  const payload = {
    ok: true,
    type: 'blocked_external_evidence_status',
    generatedAt: new Date().toISOString(),
    sourcePlan: PLAN_JSON,
    evidenceRoot: EVIDENCE_ROOT,
    summary,
    rows,
  };

  mkdirSync(dirname(resolve(OUT_JSON)), { recursive: true });
  mkdirSync(dirname(resolve(OUT_MD)), { recursive: true });
  mkdirSync(resolve(EVIDENCE_ROOT), { recursive: true });
  writeFileSync(resolve(OUT_JSON), `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(resolve(OUT_MD), toMarkdown(payload));

  console.log(
    JSON.stringify(
      {
        ok: true,
        type: payload.type,
        out_json: OUT_JSON,
        out_markdown: OUT_MD,
        summary,
      },
      null,
      2,
    ),
  );
}

main();
