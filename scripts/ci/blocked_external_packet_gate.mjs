#!/usr/bin/env node
/* eslint-disable no-console */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const SRS_PATH = resolve('docs/workspace/SRS.md');
const PLAN_PATH = resolve('core/local/artifacts/blocked_external_unblock_plan_current.json');
const EVIDENCE_PATH = resolve('core/local/artifacts/blocked_external_evidence_status_current.json');
const OUT_JSON = resolve('core/local/artifacts/blocked_external_packet_gate_current.json');
const OUT_MD = resolve('local/workspace/reports/BLOCKED_EXTERNAL_PACKET_GATE_CURRENT.md');

function parseSrsStatuses(markdown) {
  const map = new Map();
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue;
    const m = line.match(/^\|\s*(V[^|]+?)\s*\|\s*([^|]+?)\s*\|/);
    if (!m) continue;
    const id = m[1].trim();
    const status = m[2].trim();
    if (!id.startsWith('V')) continue;
    if (!map.has(id)) map.set(id, new Set());
    map.get(id).add(status);
  }
  return map;
}

function latestPacketPathFor(id) {
  const dir = resolve(`docs/external/evidence/${id}`);
  if (!existsSync(dir)) return null;
  const packets = readdirSync(dir)
    .filter((name) => /^external_execution_packet_.*\.md$/i.test(name))
    .sort();
  if (packets.length === 0) return null;
  return resolve(join(dir, packets[packets.length - 1]));
}

function main() {
  const plan = JSON.parse(readFileSync(PLAN_PATH, 'utf8'));
  const requiredIds = [...new Set((plan.rows ?? []).map((r) => r.id).filter(Boolean))].sort();
  const srs = readFileSync(SRS_PATH, 'utf8');
  const statuses = parseSrsStatuses(srs);
  const evidence = JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8'));
  const evidenceById = new Map((evidence.rows ?? []).map((r) => [r.id, r]));

  const rows = requiredIds.map((id) => {
    const evidenceRow = evidenceById.get(id);
    const packet = latestPacketPathFor(id);
    const manifest = resolve(`docs/external/evidence/${id}/packet_manifest.json`);
    const statusSet = statuses.get(id) ?? new Set();
    const statusList = [...statusSet];
    const status = statusList.join(',');
    const hasPreparedStatus = statusSet.has('blocked_external_prepared');
    const hasConflictingStatuses = statusSet.size > 1;
    const evidenceStatus = evidenceRow?.evidenceStatus ?? 'missing';
    const ok =
      hasPreparedStatus &&
      !hasConflictingStatuses &&
      ['partial_missing_external_proof', 'ready_for_reconcile'].includes(evidenceStatus) &&
      Boolean(packet) &&
      existsSync(manifest);
    const issues = [];
    if (!hasPreparedStatus) issues.push(`status=${status || 'missing'}`);
    if (hasConflictingStatuses) issues.push(`status_conflict=${status}`);
    if (!['partial_missing_external_proof', 'ready_for_reconcile'].includes(evidenceStatus)) {
      issues.push(`evidence=${evidenceStatus}`);
    }
    if (!packet) issues.push('packet_missing');
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
