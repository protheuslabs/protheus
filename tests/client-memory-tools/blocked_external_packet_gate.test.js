#!/usr/bin/env node
/* eslint-disable no-console */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const OUT_JSON = path.join(ROOT, 'core/local/artifacts/blocked_external_packet_gate_current.json');

function run(cmd) {
  execSync(cmd, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function main() {
  run('node tests/tooling/scripts/ci/srs_actionable_map.mjs');
  run('node tests/tooling/scripts/ci/blocked_external_unblock_plan.mjs');
  run('node tests/tooling/scripts/ci/blocked_external_evidence_status.mjs');
  run('node tests/tooling/scripts/ci/blocked_external_packet_gate.mjs');

  assert(fs.existsSync(OUT_JSON), `missing gate artifact: ${OUT_JSON}`);
  const payload = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));

  assert(payload.ok === true, 'packet gate returned non-ok');
  assert(payload.summary && payload.summary.fail === 0, 'packet gate has failing rows');
  assert(Array.isArray(payload.rows) && payload.rows.length > 0, 'packet gate has zero rows');

  const invalid = payload.rows.filter((row) => {
    if (!String(row.status || '').split(',').includes('blocked_external_prepared')) return true;
    return !['partial_missing_external_proof', 'ready_for_reconcile'].includes(row.evidenceStatus);
  });
  assert(invalid.length === 0, `invalid packet-gate rows: ${JSON.stringify(invalid.slice(0, 3))}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        type: 'blocked_external_packet_gate_test',
        rows_scanned: payload.rows.length,
      },
      null,
      2,
    ),
  );
}

main();
