#!/usr/bin/env node
/* eslint-disable no-console */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const PLAN_JSON = 'core/local/artifacts/blocked_external_unblock_plan_current.json';
const EVIDENCE_ROOT = 'docs/external/evidence';
const OUT_JSON = 'core/local/artifacts/blocked_external_evidence_status_current.json';
const OUT_MD = 'local/workspace/reports/BLOCKED_EXTERNAL_EVIDENCE_STATUS.md';

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
  const hasPacketManifest = files.some((f) => f.toLowerCase().endsWith('/packet_manifest.json'));
  const hasPacketMarkdown = files.some((f) =>
    /\/external_execution_packet_.*\.md$/i.test(f.replaceAll('\\', '/')),
  );
  const hasExternalProof = files.some(
    (f) =>
      /(\/external_proof|\/signed_|\/third_party|\/attestation|\/certificate|\/audit_report|\/publication_link)/i.test(
        f.replaceAll('\\', '/'),
      ) && !f.toLowerCase().endsWith('/readme.md'),
  );

  let evidenceStatus = 'missing';
  if (dirExists && !hasReadme) evidenceStatus = 'partial_missing_readme';
  if (dirExists && hasReadme && (!hasPacketManifest || !hasPacketMarkdown)) {
    evidenceStatus = 'partial_missing_packet';
  }
  if (dirExists && hasReadme && hasPacketManifest && hasPacketMarkdown && !hasExternalProof) {
    evidenceStatus = 'partial_missing_external_proof';
  }
  if (dirExists && hasReadme && hasPacketManifest && hasPacketMarkdown && hasExternalProof) {
    evidenceStatus = 'ready_for_reconcile';
  }

  return {
    ...row,
    evidenceDir: `${EVIDENCE_ROOT}/${row.id}`,
    evidenceStatus,
    hasReadme,
    hasPacketManifest,
    hasPacketMarkdown,
    hasExternalProof,
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
  lines.push(`- partial_missing_packet: ${payload.summary.partial_missing_packet}`);
  lines.push(`- partial_missing_external_proof: ${payload.summary.partial_missing_external_proof}`);
  lines.push(`- partial_missing_artifact: ${payload.summary.partial_missing_artifact}`);
  lines.push(`- missing: ${payload.summary.missing}`);
  lines.push('');
  lines.push('## Evidence Contract');
  lines.push('- One directory per blocked ID: `docs/external/evidence/<ID>/`');
  lines.push('- Required file 1: `README.md` describing the external decision/evidence and date');
  lines.push('- Required file 2: `packet_manifest.json`');
  lines.push('- Required file 3: `external_execution_packet_YYYY-MM-DD.md`');
  lines.push(
    '- Required file 4+: at least one true external proof artifact (e.g., `external_proof_*.md/.json`, `signed_*`, `third_party_*`, `attestation_*`, `certificate_*`, `audit_report_*`, `publication_link_*`).',
  );
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
    partial_missing_packet: rows.filter((r) => r.evidenceStatus === 'partial_missing_packet').length,
    partial_missing_external_proof: rows.filter(
      (r) => r.evidenceStatus === 'partial_missing_external_proof',
    ).length,
    partial_missing_artifact: 0,
    missing: rows.filter((r) => r.evidenceStatus === 'missing').length,
  };
  summary.partial_missing_artifact =
    summary.partial_missing_packet + summary.partial_missing_external_proof;
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
