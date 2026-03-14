#!/usr/bin/env node
/* eslint-disable no-console */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const EVIDENCE_JSON = 'core/local/artifacts/blocked_external_evidence_status_current.json';
const OUT_JSON = 'core/local/artifacts/blocked_external_packet_audit_current.json';
const OUT_MD = 'local/workspace/reports/BLOCKED_EXTERNAL_PACKET_AUDIT.md';

function read(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function listFilesRecursive(dir) {
  const root = resolve(dir);
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out.push(full.replace(`${root}/`, ''));
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

function isTemplateReadme(readmeText = '') {
  const checks = [
    '- Date:',
    '- Decision/Result:',
    '- External system/contact:',
    '- Notes:',
    '- [ ] At least one concrete artifact file is present in this folder',
  ];
  return checks.every((c) => readmeText.includes(c));
}

function main() {
  const src = read(EVIDENCE_JSON);
  const rows = (src.rows ?? []).map((row) => {
    const dir = resolve(row.evidenceDir);
    const readmePath = join(dir, 'README.md');
    const readmeExists = existsSync(readmePath);
    const readmeText = readmeExists ? readFileSync(readmePath, 'utf8') : '';
    const files = listFilesRecursive(dir);
    const artifactFiles = files.filter((f) => f.toLowerCase() !== 'readme.md');
    const templateReadme = readmeExists ? isTemplateReadme(readmeText) : true;
    let packetStatus = 'missing';
    if (readmeExists && artifactFiles.length === 0 && templateReadme) packetStatus = 'template_only';
    else if (readmeExists && artifactFiles.length === 0) packetStatus = 'readme_only';
    else if (readmeExists && artifactFiles.length > 0 && templateReadme) packetStatus = 'artifact_present_readme_unfilled';
    else if (readmeExists && artifactFiles.length > 0 && !templateReadme) packetStatus = 'ready_for_reconcile';

    return {
      id: row.id,
      evidenceDir: row.evidenceDir,
      packetStatus,
      readmeExists,
      templateReadme,
      artifactCount: artifactFiles.length,
      artifactFiles,
    };
  });

  const summary = {
    total: rows.length,
    ready_for_reconcile: rows.filter((r) => r.packetStatus === 'ready_for_reconcile').length,
    template_only: rows.filter((r) => r.packetStatus === 'template_only').length,
    readme_only: rows.filter((r) => r.packetStatus === 'readme_only').length,
    artifact_present_readme_unfilled: rows.filter((r) => r.packetStatus === 'artifact_present_readme_unfilled').length,
    missing: rows.filter((r) => r.packetStatus === 'missing').length,
  };

  const payload = {
    ok: true,
    type: 'blocked_external_packet_audit',
    generatedAt: new Date().toISOString(),
    source: EVIDENCE_JSON,
    summary,
    rows,
  };

  mkdirSync(dirname(resolve(OUT_JSON)), { recursive: true });
  mkdirSync(dirname(resolve(OUT_MD)), { recursive: true });
  writeFileSync(resolve(OUT_JSON), `${JSON.stringify(payload, null, 2)}\n`);

  const lines = [];
  lines.push('# Blocked External Packet Audit');
  lines.push('');
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push('');
  lines.push('## Summary');
  for (const [k, v] of Object.entries(summary)) {
    lines.push(`- ${k}: ${v}`);
  }
  lines.push('');
  lines.push('| ID | Packet Status | Artifact Count | Evidence Path |');
  lines.push('| --- | --- | ---: | --- |');
  for (const row of rows) {
    lines.push(`| ${row.id} | ${row.packetStatus} | ${row.artifactCount} | ${row.evidenceDir} |`);
  }
  lines.push('');
  writeFileSync(resolve(OUT_MD), `${lines.join('\n')}\n`);

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
