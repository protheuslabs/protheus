#!/usr/bin/env node
/* eslint-disable no-console */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const EVIDENCE_JSON = 'core/local/artifacts/blocked_external_evidence_status_current.json';
const SRS_PATH = 'docs/workspace/SRS.md';
const BACKLOG_PATH = 'docs/workspace/UPGRADE_BACKLOG.md';
const OUT_JSON = 'core/local/artifacts/blocked_external_reconcile_candidates_current.json';
const OUT_MD = 'local/workspace/reports/BLOCKED_EXTERNAL_RECONCILE_CANDIDATES.md';

function read(path) {
  return readFileSync(resolve(path), 'utf8');
}

function write(path, data) {
  writeFileSync(resolve(path), data);
}

function parseArgs(argv) {
  return {
    apply: argv.includes('--apply=1') || argv.includes('--apply'),
  };
}

function updateStatuses(markdown, ids, fromStatuses, toStatus) {
  let updated = markdown;
  let changes = 0;
  const from = Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses];
  for (const id of ids) {
    for (const fromStatus of from) {
      const pattern = new RegExp(
        `(\\|\\s*${id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*\\|\\s*)${fromStatus}(\\s*\\|)`,
        'g',
      );
      const before = updated;
      updated = updated.replace(pattern, `$1${toStatus}$2`);
      if (updated !== before) changes += 1;
    }
  }
  return { updated, changes };
}

function toMarkdown(payload) {
  const lines = [];
  lines.push('# Blocked External Reconcile Candidates');
  lines.push('');
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- blocked_total: ${payload.summary.blocked_total}`);
  lines.push(`- ready_for_reconcile: ${payload.summary.ready_for_reconcile}`);
  lines.push(`- pending_external_artifact: ${payload.summary.pending_external_artifact}`);
  lines.push(`- apply_mode: ${payload.summary.apply_mode ? 'yes' : 'no'}`);
  lines.push(`- srs_rows_updated: ${payload.summary.srs_rows_updated}`);
  lines.push(`- backlog_rows_updated: ${payload.summary.backlog_rows_updated}`);
  lines.push('');
  lines.push('| ID | Evidence Status | Candidate | Evidence Path |');
  lines.push('| --- | --- | --- | --- |');
  for (const row of payload.rows) {
    lines.push(
      `| ${row.id} | ${row.evidenceStatus} | ${row.candidate ? 'yes' : 'no'} | ${row.evidenceDir} |`,
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const evidence = JSON.parse(read(EVIDENCE_JSON));
  const rows = (evidence.rows ?? []).map((row) => ({
    id: row.id,
    evidenceStatus: row.evidenceStatus,
    evidenceDir: row.evidenceDir,
    candidate: row.evidenceStatus === 'ready_for_reconcile',
  }));
  const candidateIds = rows.filter((r) => r.candidate).map((r) => r.id);

  let srsRowsUpdated = 0;
  let backlogRowsUpdated = 0;
  if (args.apply && candidateIds.length > 0) {
    const srs = read(SRS_PATH);
    const backlog = read(BACKLOG_PATH);
    const fromStatuses = ['blocked', 'blocked_external_prepared'];
    const srsRes = updateStatuses(srs, candidateIds, fromStatuses, 'existing-coverage-validated');
    const backlogRes = updateStatuses(backlog, candidateIds, fromStatuses, 'existing-coverage-validated');
    srsRowsUpdated = srsRes.changes;
    backlogRowsUpdated = backlogRes.changes;
    if (srsRowsUpdated > 0) write(SRS_PATH, srsRes.updated);
    if (backlogRowsUpdated > 0) write(BACKLOG_PATH, backlogRes.updated);
  }

  const payload = {
    ok: true,
    type: 'blocked_external_reconcile_candidates',
    generatedAt: new Date().toISOString(),
    source: EVIDENCE_JSON,
    summary: {
      blocked_total: rows.length,
      ready_for_reconcile: candidateIds.length,
      pending_external_artifact: rows.length - candidateIds.length,
      apply_mode: args.apply,
      srs_rows_updated: srsRowsUpdated,
      backlog_rows_updated: backlogRowsUpdated,
    },
    rows,
    candidateIds,
  };

  mkdirSync(dirname(resolve(OUT_JSON)), { recursive: true });
  mkdirSync(dirname(resolve(OUT_MD)), { recursive: true });
  write(OUT_JSON, `${JSON.stringify(payload, null, 2)}\n`);
  write(OUT_MD, toMarkdown(payload));
  console.log(
    JSON.stringify(
      {
        ok: true,
        type: payload.type,
        out_json: OUT_JSON,
        out_markdown: OUT_MD,
        summary: payload.summary,
      },
      null,
      2,
    ),
  );
}

main();
