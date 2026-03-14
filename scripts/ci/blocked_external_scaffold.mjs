#!/usr/bin/env node
/* eslint-disable no-console */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PLAN_JSON = 'core/local/artifacts/blocked_external_unblock_plan_current.json';
const EVIDENCE_ROOT = 'docs/external/evidence';

function read(path) {
  return readFileSync(resolve(path), 'utf8');
}

function main() {
  const plan = JSON.parse(read(PLAN_JSON));
  const rows = plan.rows ?? [];
  const created = [];
  const skipped = [];
  mkdirSync(resolve(EVIDENCE_ROOT), { recursive: true });

  for (const row of rows) {
    const dir = resolve(EVIDENCE_ROOT, row.id);
    const readme = resolve(dir, 'README.md');
    mkdirSync(dir, { recursive: true });
    if (existsSync(readme)) {
      skipped.push({ id: row.id, readme: `${EVIDENCE_ROOT}/${row.id}/README.md` });
      continue;
    }
    const template = [
      `# ${row.id} External Evidence`,
      '',
      `- ID: \`${row.id}\``,
      `- Impact: \`${row.impact ?? ''}\``,
      `- Layer: \`${row.layerMap ?? ''}\``,
      `- Unblock owner: \`human_external\``,
      `- Source section: ${row.section ?? ''}`,
      '',
      '## Upgrade Theme',
      '',
      `${row.upgrade ?? ''}`,
      '',
      '## Evidence Summary',
      '',
      '- Date:',
      '- Decision/Result:',
      '- External system/contact:',
      '- Notes:',
      '',
      '## Required Artifact Checklist',
      '',
      '- [ ] At least one concrete artifact file is present in this folder (report/certificate/export/log/screenshot).',
      '- [ ] Artifact is non-secret or redacted for repo storage.',
      '- [ ] Artifact links back to this ID and decision date.',
      '',
    ].join('\n');
    writeFileSync(readme, `${template}\n`);
    created.push({ id: row.id, readme: `${EVIDENCE_ROOT}/${row.id}/README.md` });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        type: 'blocked_external_scaffold',
        source_plan: PLAN_JSON,
        evidence_root: EVIDENCE_ROOT,
        total: rows.length,
        created_count: created.length,
        skipped_count: skipped.length,
        created,
        skipped,
      },
      null,
      2,
    ),
  );
}

main();
