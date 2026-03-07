#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'black_box_ledger.js');

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function runCmd(args, env) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}'));
}

function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'black-box-attestation-test-'));
  const ledgerDir = path.join(tmp, 'ledger');
  const spineDir = path.join(tmp, 'spine', 'runs');
  const autonomyDir = path.join(tmp, 'autonomy', 'runs');
  const attestationDir = path.join(ledgerDir, 'attestations');
  const dateStr = '2026-02-25';

  writeJsonl(path.join(spineDir, `${dateStr}.jsonl`), [
    { ts: `${dateStr}T01:00:00.000Z`, type: 'spine_run_started' }
  ]);
  writeJsonl(path.join(autonomyDir, `${dateStr}.jsonl`), [
    { ts: `${dateStr}T01:05:00.000Z`, type: 'autonomy_run', proposal_id: 'P1', result: 'executed', objective_id: 'T1_OBJ' }
  ]);
  writeJsonl(path.join(attestationDir, `${dateStr}.jsonl`), [
    {
      ts: `${dateStr}T01:06:00.000Z`,
      type: 'cross_runtime_attestation',
      system: 'external_scanner',
      boundary: 'cloud_executor',
      chain_hash: 'abc123deadbeef',
      signature: 'sig_001',
      signer: 'scanner_key_1',
      ok: true
    }
  ]);

  const env = {
    BLACK_BOX_LEDGER_DIR: ledgerDir,
    BLACK_BOX_SPINE_RUNS_DIR: spineDir,
    BLACK_BOX_AUTONOMY_RUNS_DIR: autonomyDir,
    BLACK_BOX_EXTERNAL_ATTESTATION_DIR: attestationDir
  };

  let r = runCmd(['rollup', dateStr, '--mode=daily'], env);
  assert.strictEqual(r.status, 0, `rollup should pass: ${r.stderr}`);
  let out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true, 'rollup should report ok');
  assert.strictEqual(Number(out.spine_events || 0), 1, 'rollup should include spine events');
  assert.strictEqual(Number(out.autonomy_events || 0), 1, 'rollup should include autonomy events');
  assert.strictEqual(Number(out.external_events || 0), 1, 'rollup should include external attestation events');
  assert.strictEqual(Number(out.total_events || 0), 3, 'rollup should include all event classes');

  const detailRows = fs.readFileSync(path.join(ledgerDir, `${dateStr}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const external = detailRows.find((row) => String(row && row.event && row.event.source || '') === 'boundary_attestation');
  assert.ok(external, 'detail ledger should include compacted boundary attestation event');
  assert.strictEqual(
    String(external.event.external_attestation && external.event.external_attestation.system || ''),
    'external_scanner',
    'external event should preserve attestor system'
  );

  r = runCmd(['verify'], env);
  assert.strictEqual(r.status, 0, `verify should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true, 'verify should report ok');
  assert.strictEqual(out.valid, true, 'verify should confirm chain validity');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('black_box_ledger_attestation.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`black_box_ledger_attestation.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
