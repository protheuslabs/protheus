#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'contracts', 'soul_contracts.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, env = {}) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-contracts-'));
  const memoryDir = path.join(tmp, 'memory', 'contracts');
  const adaptivePath = path.join(tmp, 'adaptive', 'contracts', 'index.json');
  const latestPath = path.join(tmp, 'state', 'contracts', 'soul_contracts', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'contracts', 'soul_contracts', 'history.jsonl');
  const receiptsPath = path.join(tmp, 'state', 'contracts', 'soul_contracts', 'receipts.jsonl');
  const policyPath = path.join(tmp, 'config', 'soul_contracts_policy.json');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    encryption: {
      key_env: 'SOUL_CONTRACTS_KEY',
      allow_dev_key: true,
      dev_key: 'test_dev_key',
      algorithm: 'aes-256-gcm'
    },
    paths: {
      memory_contracts_dir: memoryDir,
      adaptive_index_path: adaptivePath,
      latest_path: latestPath,
      history_path: historyPath,
      receipts_path: receiptsPath
    }
  });

  let out = run([
    'create',
    '--owner=jay',
    '--id=founder_pact',
    '--title=Founder Pact',
    '--terms=Build and split outcomes fairly',
    '--risk-tier=2',
    '--tags=founder,profit',
    '--strict=1',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'create should succeed');
  assert.strictEqual(out.payload.contract_id, 'founder_pact');

  const ownerFile = path.join(memoryDir, 'jay.json');
  const ownerPayload = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
  const contract = ownerPayload.contracts.find((row) => row.contract_id === 'founder_pact');
  assert.ok(contract, 'contract should be stored for owner');
  assert.ok(contract.terms_encrypted && contract.terms_encrypted.cipher_b64, 'terms should be encrypted');
  assert.ok(!contract.terms_plain, 'plaintext terms should not be stored');

  out = run([
    'amend',
    '--owner=jay',
    '--id=founder_pact',
    '--terms=Updated terms',
    '--tier=2',
    '--approve-a=sig_a',
    '--approve-b=sig_b',
    '--strict=1',
    `--policy=${policyPath}`
  ]);
  assert.notStrictEqual(out.status, 0, 'tier-2 amendment should fail under strict mode');
  assert.ok(out.payload && out.payload.error === 'tier_too_low_for_amendment', 'should require tier-3+');

  out = run([
    'amend',
    '--owner=jay',
    '--id=founder_pact',
    '--terms=Updated terms',
    '--tier=3',
    '--approve-a=sig_a',
    '--approve-b=sig_a',
    '--strict=1',
    `--policy=${policyPath}`
  ]);
  assert.notStrictEqual(out.status, 0, 'same signer amendment should fail');
  assert.ok(out.payload && out.payload.error === 'dual_signature_required', 'should require distinct signatures');

  out = run([
    'amend',
    '--owner=jay',
    '--id=founder_pact',
    '--terms=Updated terms v2',
    '--tier=3',
    '--approve-a=sig_a',
    '--approve-b=sig_b',
    '--strict=1',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'tier-3 dual-sign amendment should pass');
  assert.strictEqual(out.payload.version, 2, 'version should increment');

  out = run([
    'evaluate',
    '--owner=jay',
    '--id=founder_pact',
    '--action=apply',
    '--risk-tier=2',
    '--strict=1',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.allow === true, 'active contract should allow evaluation path');

  out = run([
    'status',
    '--owner=jay',
    '--strict=1',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.contract_count === 1, 'status should report one contract');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('soul_contracts.test.js: OK');
} catch (err) {
  console.error(`soul_contracts.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
