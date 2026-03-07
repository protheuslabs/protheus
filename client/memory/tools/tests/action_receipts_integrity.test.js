#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { writeContractReceipt } = require('../../../lib/action_receipts.js');

function mkDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function run() {
  const tmpRoot = path.join(__dirname, 'temp_action_receipts_integrity');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  const receiptPath = path.join(tmpRoot, 'receipts.jsonl');
  const chainPath = `${receiptPath}.chain.json`;

  const a = writeContractReceipt(receiptPath, { type: 'test_receipt', i: 1 }, { attempted: true, verified: true });
  const b = writeContractReceipt(receiptPath, { type: 'test_receipt', i: 2 }, { attempted: true, verified: false });

  assert.ok(a.receipt_contract && a.receipt_contract.integrity, 'first receipt should include integrity');
  assert.ok(b.receipt_contract && b.receipt_contract.integrity, 'second receipt should include integrity');
  assert.strictEqual(Number(a.receipt_contract.integrity.seq), 1);
  assert.strictEqual(Number(b.receipt_contract.integrity.seq), 2);
  assert.strictEqual(b.receipt_contract.integrity.prev_hash, a.receipt_contract.integrity.hash);
  assert.ok(typeof a.receipt_contract.integrity.payload_hash === 'string' && a.receipt_contract.integrity.payload_hash.length === 64);
  assert.ok(typeof b.receipt_contract.integrity.hash === 'string' && b.receipt_contract.integrity.hash.length === 64);

  const rows = readJsonl(receiptPath);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1].receipt_contract.integrity.prev_hash, rows[0].receipt_contract.integrity.hash);

  assert.ok(fs.existsSync(chainPath), 'chain state sidecar should exist');
  const chain = JSON.parse(fs.readFileSync(chainPath, 'utf8'));
  assert.strictEqual(Number(chain.seq), 2);
  assert.strictEqual(chain.hash, rows[1].receipt_contract.integrity.hash);

  console.log('action_receipts_integrity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`action_receipts_integrity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
