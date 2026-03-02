#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const artifacts = require(path.join(ROOT, 'lib', 'state_artifact_contract.js'));

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return String(fs.readFileSync(filePath, 'utf8') || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'state-artifact-test-'));
  const latestPath = path.join(tmp, 'latest.json');
  const receiptsPath = path.join(tmp, 'receipts.jsonl');
  const historyPath = path.join(tmp, 'history.jsonl');

  const row = artifacts.writeArtifactSet(
    { latestPath, receiptsPath },
    { type: 'sample', ok: true },
    { schemaId: 'state_artifact_contract_test', schemaVersion: '1.0', artifactType: 'receipt' }
  );
  assert.strictEqual(row.schema_id, 'state_artifact_contract_test');
  assert.strictEqual(row.artifact_type, 'receipt');
  assert.ok(fs.existsSync(latestPath), 'latest should be written');
  assert.ok(fs.existsSync(receiptsPath), 'receipts should be written');

  const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  assert.strictEqual(latest.type, 'sample');
  const receipts = readJsonl(receiptsPath);
  assert.strictEqual(receipts.length, 1);

  artifacts.appendArtifactHistory(
    historyPath,
    { type: 'history_sample', ok: true },
    { schemaId: 'state_artifact_contract_history_test', schemaVersion: '1.0', artifactType: 'history' }
  );
  const history = readJsonl(historyPath);
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].artifact_type, 'history');

  const transitionSrc = fs.readFileSync(path.join(ROOT, 'systems', 'memory', 'rust_memory_transition_lane.ts'), 'utf8');
  const supervisorSrc = fs.readFileSync(path.join(ROOT, 'systems', 'memory', 'rust_memory_daemon_supervisor.ts'), 'utf8');
  const freshnessSrc = fs.readFileSync(path.join(ROOT, 'systems', 'memory', 'memory_index_freshness_gate.ts'), 'utf8');
  assert.ok(transitionSrc.includes('writeTransitionReceipt'), 'transition lane should use shared artifact helper');
  assert.ok(supervisorSrc.includes('writeArtifactSet'), 'daemon supervisor should use shared artifact helper');
  assert.ok(freshnessSrc.includes('appendArtifactHistory'), 'freshness gate should use shared history helper');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('state_artifact_contract.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`state_artifact_contract.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
