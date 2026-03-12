#!/usr/bin/env node
/* eslint-disable no-console */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const REQUIRED_IDS = [
  'V7-META-016',
  'V7-META-017',
  'V7-META-018',
  'V7-TOP1-009',
  'V7-TOP1-010',
  'V6-SUBSTRATE-002.4',
  'V6-F100-022',
  'V6-F100-023',
  'V6-F100-024',
  'V6-F100-025',
  'V6-F100-034',
  'V6-F100-043',
  'V6-F100-044',
  'V6-F100-045',
  'V6-F100-A-008',
  'V6-F100-A-009',
  'V6-F100-A-010',
  'V6-F100-A-011',
  'V6-EDGE-005',
  'V6-COMP-005',
  'V6-SBOX-006',
  'V6-FLUX-007',
  'V6-TOOLS-005',
  'V6-PAY-007',
  'V2-012',
  'V6-RUST50-CONF-004',
  'V6-GAP-006',
];

const SRS_PATH = resolve('docs/workspace/SRS.md');
const EVIDENCE_PATH = resolve('artifacts/blocked_external_evidence_status_current.json');
const OUT_JSON = resolve('artifacts/blocked_external_packet_gate_current.json');
const OUT_MD = resolve('docs/workspace/BLOCKED_EXTERNAL_PACKET_GATE_CURRENT.md');

function parseSrsStatuses(markdown) {
  const map = new Map();
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue;
    const m = line.match(/^\|\s*(V[^|]+?)\s*\|\s*([^|]+?)\s*\|/);
    if (!m) continue;
    const id = m[1].trim();
    const status = m[2].trim();
    if (!id.startsWith('V')) continue;
    if (!map.has(id)) map.set(id, status);
  }
  return map;
}

function main() {
  const srs = readFileSync(SRS_PATH, 'utf8');
  const statuses = parseSrsStatuses(srs);
  const evidence = JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8'));
  const evidenceById = new Map((evidence.rows ?? []).map((r) => [r.id, r]));

  const rows = REQUIRED_IDS.map((id) => {
    const evidenceRow = evidenceById.get(id);
    const packet = resolve(`evidence/external/${id}/external_execution_packet_2026-03-12.md`);
    const manifest = resolve(`evidence/external/${id}/packet_manifest.json`);
    const status = statuses.get(id) ?? 'missing';
    const evidenceStatus = evidenceRow?.evidenceStatus ?? 'missing';
    const ok =
      status === 'existing-coverage-validated' &&
      evidenceStatus === 'ready_for_reconcile' &&
      existsSync(packet) &&
      existsSync(manifest);
    const issues = [];
    if (status !== 'existing-coverage-validated') issues.push(`status=${status}`);
    if (evidenceStatus !== 'ready_for_reconcile') issues.push(`evidence=${evidenceStatus}`);
    if (!existsSync(packet)) issues.push('packet_missing');
    if (!existsSync(manifest)) issues.push('manifest_missing');
    return { id, status, evidenceStatus, packet, manifest, ok, issues };
  });

  const summary = {
    total: rows.length,
    pass: rows.filter((r) => r.ok).length,
    fail: rows.filter((r) => !r.ok).length,
  };

  const payload = {
    ok: summary.fail === 0,
    type: 'blocked_external_packet_gate',
    generatedAt: new Date().toISOString(),
    summary,
    rows,
  };

  mkdirSync(dirname(OUT_JSON), { recursive: true });
  mkdirSync(dirname(OUT_MD), { recursive: true });
  writeFileSync(OUT_JSON, `${JSON.stringify(payload, null, 2)}\n`);

  const md = [];
  md.push('# Blocked External Packet Gate');
  md.push('');
  md.push(`Generated: ${payload.generatedAt}`);
  md.push('');
  md.push(`- total: ${summary.total}`);
  md.push(`- pass: ${summary.pass}`);
  md.push(`- fail: ${summary.fail}`);
  md.push('');
  md.push('| ID | SRS Status | Evidence Status | Packet | Manifest | Result |');
  md.push('| --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    md.push(`| ${row.id} | ${row.status} | ${row.evidenceStatus} | ${row.packet} | ${row.manifest} | ${row.ok ? 'pass' : `fail (${row.issues.join(', ')})`} |`);
  }
  md.push('');
  writeFileSync(OUT_MD, `${md.join('\n')}\n`);

  console.log(
    JSON.stringify(
      {
        ok: payload.ok,
        type: payload.type,
        out_json: OUT_JSON.replace(`${resolve('')}/`, ''),
        out_markdown: OUT_MD.replace(`${resolve('')}/`, ''),
        summary,
      },
      null,
      2,
    ),
  );

  if (!payload.ok) process.exit(1);
}

main();
