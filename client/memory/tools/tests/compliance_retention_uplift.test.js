#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'compliance_retention_uplift.js');

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function run(args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || '')
  };
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '').trim());
}

function setAgeDays(filePath, days) {
  const now = Date.now();
  const ts = new Date(now - (Number(days) * 24 * 60 * 60 * 1000));
  fs.utimesSync(filePath, ts, ts);
}

try {
  const tmpRoot = path.join(ROOT, 'tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'compliance-retention-'));
  const scopeRoot = path.join(tmp, 'state', 'observability');
  const hotFile = path.join(scopeRoot, 'hot.jsonl');
  const warmFile = path.join(scopeRoot, 'warm.jsonl');
  const coldFile = path.join(scopeRoot, 'cold.log');
  const archiveFile = path.join(scopeRoot, 'archive.prom');
  writeFile(hotFile, '{"ok":true}\n');
  writeFile(warmFile, '{"ok":true}\n');
  writeFile(coldFile, 'warn line\n');
  writeFile(archiveFile, 'metric 1\n');
  setAgeDays(hotFile, 10);
  setAgeDays(warmFile, 120);
  setAgeDays(coldFile, 250);
  setAgeDays(archiveFile, 500);

  const policyPath = path.join(tmp, 'config', 'compliance_retention_policy.json');
  const archiveRoot = path.join(tmp, 'state', '_retention');
  const indexPath = path.join(tmp, 'state', 'ops', 'compliance_retention_index.json');
  const statePath = path.join(tmp, 'state', 'ops', 'compliance_retention_uplift.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'compliance_retention_uplift_history.jsonl');
  const attestationDir = path.join(tmp, 'state', 'ops', 'compliance_retention_attestations');

  writeJson(policyPath, {
    version: '1.0-test',
    tiers: {
      hot_days: 90,
      warm_days: 180,
      cold_days: 365
    },
    archive_root: archiveRoot,
    index_path: indexPath,
    state_path: statePath,
    history_path: historyPath,
    attestation_dir: attestationDir,
    include_extensions: ['.jsonl', '.log', '.prom'],
    scopes: [scopeRoot],
    exclude_contains: ['/state/_retention/']
  });

  const first = run(['run', '--apply=1', `--policy=${policyPath}`, '--strict=1']);
  assert.strictEqual(first.status, 0, `run failed: ${first.stderr || first.stdout}`);
  const firstPayload = parseJson(first.stdout);
  assert.strictEqual(firstPayload.ok, true, 'run payload should be ok');
  assert.strictEqual(firstPayload.moved.warm, 1, 'warm move expected');
  assert.strictEqual(firstPayload.moved.cold, 1, 'cold move expected');
  assert.strictEqual(firstPayload.moved.archive, 1, 'archive move expected');

  assert.ok(fs.existsSync(hotFile), 'hot file should remain in place');
  assert.ok(!fs.existsSync(warmFile), 'warm file should be moved');
  assert.ok(!fs.existsSync(coldFile), 'cold file should be moved');
  assert.ok(!fs.existsSync(archiveFile), 'archive file should be moved');

  const warmGz = path.join(archiveRoot, 'warm', path.relative(ROOT, warmFile) + '.gz');
  const coldGz = path.join(archiveRoot, 'cold', path.relative(ROOT, coldFile) + '.gz');
  const archiveGz = path.join(archiveRoot, 'archive', path.relative(ROOT, archiveFile) + '.gz');
  assert.ok(fs.existsSync(warmGz), 'warm gzip file expected');
  assert.ok(fs.existsSync(coldGz), 'cold gzip file expected');
  assert.ok(fs.existsSync(archiveGz), 'archive gzip file expected');

  const index = readJson(indexPath);
  assert.ok(Array.isArray(index.entries), 'index entries expected');
  assert.ok(index.entries.some((e) => e.tier === 'hot'), 'hot index entry expected');
  assert.ok(index.entries.some((e) => e.tier === 'warm'), 'warm index entry expected');
  assert.ok(index.entries.some((e) => e.tier === 'cold'), 'cold index entry expected');
  assert.ok(index.entries.some((e) => e.tier === 'archive'), 'archive index entry expected');

  const attest = run(['attest', '--date=2026-02-01', `--policy=${policyPath}`]);
  assert.strictEqual(attest.status, 0, `attest failed: ${attest.stderr || attest.stdout}`);
  const attestPayload = parseJson(attest.stdout);
  assert.strictEqual(attestPayload.ok, true, 'attest payload should be ok');
  const attestationPath = path.join(attestationDir, '2026-02.json');
  assert.ok(fs.existsSync(attestationPath), 'attestation file should exist');

  const status = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(status.status, 0, `status failed: ${status.stderr || status.stdout}`);
  const statusPayload = parseJson(status.stdout);
  assert.strictEqual(statusPayload.ok, true, 'status payload should be ok');
  assert.strictEqual(statusPayload.available, true, 'status should detect state');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('compliance_retention_uplift.test.js: OK');
} catch (err) {
  console.error(`compliance_retention_uplift.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
