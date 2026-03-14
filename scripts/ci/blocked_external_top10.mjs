#!/usr/bin/env node
/* eslint-disable no-console */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const PLAN_JSON = 'core/local/artifacts/blocked_external_unblock_plan_current.json';
const EVIDENCE_JSON = 'core/local/artifacts/blocked_external_evidence_status_current.json';
const OUT_JSON = 'core/local/artifacts/blocked_external_top10_current.json';
const OUT_MD = 'local/workspace/reports/BLOCKED_EXTERNAL_TOP10.md';

function read(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function classifyActionHint(upgrade = '') {
  const t = upgrade.toLowerCase();
  if (t.includes('audit') || t.includes('certification') || t.includes('soc2') || t.includes('iso')) return 'upload_audit_or_cert';
  if (t.includes('publish') || t.includes('announcement') || t.includes('report') || t.includes('case study')) return 'upload_publication_proof';
  if (t.includes('support') || t.includes('roster') || t.includes('sla')) return 'upload_support_contract';
  if (t.includes('compliance') || t.includes('legal') || t.includes('dpa') || t.includes('msa')) return 'upload_legal_packet';
  if (t.includes('validation') || t.includes('live') || t.includes('proof')) return 'upload_validation_evidence';
  return 'upload_decision_artifact';
}

function main() {
  const plan = read(PLAN_JSON);
  const evidence = read(EVIDENCE_JSON);
  const byId = new Map((evidence.rows ?? []).map((r) => [r.id, r]));

  const ranked = (plan.rows ?? [])
    .map((row) => {
      const e = byId.get(row.id) ?? {};
      return {
        id: row.id,
        impact: Number(row.impact ?? 0),
        layerMap: row.layerMap ?? '',
        upgrade: row.upgrade ?? '',
        section: row.section ?? '',
        evidenceStatus: e.evidenceStatus ?? 'missing',
        evidenceDir: e.evidenceDir ?? `docs/external/evidence/${row.id}`,
        actionHint: classifyActionHint(row.upgrade ?? ''),
      };
    })
    .sort((a, b) => {
      if (b.impact !== a.impact) return b.impact - a.impact;
      return a.id.localeCompare(b.id);
    });

  const top10 = ranked.slice(0, 10);
  const payload = {
    ok: true,
    type: 'blocked_external_top10',
    generatedAt: new Date().toISOString(),
    source: { plan: PLAN_JSON, evidence: EVIDENCE_JSON },
    totalBlocked: ranked.length,
    top10,
  };

  mkdirSync(dirname(resolve(OUT_JSON)), { recursive: true });
  mkdirSync(dirname(resolve(OUT_MD)), { recursive: true });
  writeFileSync(resolve(OUT_JSON), `${JSON.stringify(payload, null, 2)}\n`);

  const lines = [];
  lines.push('# Blocked External Top 10 (Priority)');
  lines.push('');
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push('');
  lines.push(`- blocked_total: ${payload.totalBlocked}`);
  lines.push('- ranking: impact DESC, then ID');
  lines.push('');
  lines.push('| Rank | ID | Impact | Layer | Evidence Status | Action Hint | Evidence Path |');
  lines.push('| ---: | --- | ---: | --- | --- | --- | --- |');
  top10.forEach((row, idx) => {
    lines.push(
      `| ${idx + 1} | ${row.id} | ${row.impact} | ${row.layerMap} | ${row.evidenceStatus} | ${row.actionHint} | ${row.evidenceDir} |`,
    );
  });
  lines.push('');
  writeFileSync(resolve(OUT_MD), `${lines.join('\n')}\n`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        type: payload.type,
        out_json: OUT_JSON,
        out_markdown: OUT_MD,
        total_blocked: payload.totalBlocked,
      },
      null,
      2,
    ),
  );
}

main();
