#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
    'utf8'
  );
}

function parsePayload(stdout) {
  const raw = String(stdout || '').trim();
  assert.ok(raw, 'expected stdout');
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  throw new Error('unable to parse json payload');
}

function runCli(scriptPath, args, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8'
  });
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'ops', 'broken_piece_lab.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'broken-piece-lab-'));
  const queuePath = path.join(tmp, 'state', 'ops', 'autotest_doctor', 'broken_lab_queue.jsonl');
  const clustersPath = path.join(tmp, 'state', 'ops', 'autotest_doctor', 'broken_lab_clusters.json');
  const proposalsDir = path.join(tmp, 'research', 'autotest_doctor', 'proposals');

  writeJsonl(queuePath, [
    {
      ts: '2026-02-27T03:00:00.000Z',
      kind: 'assertion_failed',
      signature_id: 'sig_abc',
      test_id: 'tst_1',
      rollback_reason: 'repair_step_failed',
      broken_piece_path: 'state/ops/autotest_doctor/broken_pieces/2026-02-27/a.json'
    },
    {
      ts: '2026-02-27T03:01:00.000Z',
      kind: 'assertion_failed',
      signature_id: 'sig_abc',
      test_id: 'tst_1',
      rollback_reason: 'repair_step_failed',
      broken_piece_path: 'state/ops/autotest_doctor/broken_pieces/2026-02-27/b.json'
    }
  ]);

  const r = runCli(
    scriptPath,
    ['run', `--queue=${queuePath}`, `--clusters=${clustersPath}`, `--proposals-dir=${proposalsDir}`],
    root
  );
  assert.strictEqual(r.status, 0, `lab run should pass: ${r.stderr}`);
  const out = parsePayload(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.cluster_count, 1, 'rows should cluster into one signature');
  assert.ok(fs.existsSync(clustersPath), 'clusters file should exist');

  const proposalsJson = path.join(proposalsDir, '2026-02-27.json');
  const proposalsMd = path.join(proposalsDir, '2026-02-27.md');
  assert.ok(fs.existsSync(proposalsJson), 'proposal json should exist');
  assert.ok(fs.existsSync(proposalsMd), 'proposal markdown should exist');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('broken_piece_lab.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`broken_piece_lab.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

