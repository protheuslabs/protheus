#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, value) {
  write(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function run(script, cwd, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
  return {
    status: Number(r.status || 0),
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    payload: parseJson(r.stdout)
  };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(repoRoot, 'systems', 'finance', 'economic_entity_manager.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'economic-entity-'));
  const policyPath = path.join(tmp, 'config', 'economic_entity_management_policy.json');

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    shadow_only: false,
    currency: 'USD',
    tax_classification_map: {
      saas_income: 'business_income',
      compute: 'cost_of_goods',
      tools: 'operating_expense',
      payout: 'distribution'
    },
    high_risk_filing: {
      amount_usd_threshold: 5000,
      categories: ['tax_filing', 'external_contract_signing', 'capital_transfer'],
      require_human_approval: true,
      min_approval_note_chars: 12
    },
    payout: {
      require_eye_gate: true,
      require_approval_note_for_amount_usd: 1000
    },
    contracts: {
      require_terms_digest: true,
      require_counterparty: true
    },
    paths: {
      state: path.join(tmp, 'state', 'finance', 'economic_entity', 'state.json'),
      latest: path.join(tmp, 'state', 'finance', 'economic_entity', 'latest.json'),
      ledger: path.join(tmp, 'state', 'finance', 'economic_entity', 'ledger.jsonl'),
      receipts: path.join(tmp, 'state', 'finance', 'economic_entity', 'receipts.jsonl'),
      tax_reports: path.join(tmp, 'state', 'finance', 'economic_entity', 'tax_reports')
    }
  });

  const env = {
    ...process.env,
    ECONOMIC_ENTITY_POLICY_PATH: policyPath,
    EEM_MOCK_EYE_DECISION: 'allow',
    EEM_MOCK_PAYMENT_DECISION: 'execute'
  };

  const ledger = run(script, repoRoot, [
    'ledger-entry',
    '--kind=income',
    '--amount-usd=1200',
    '--category=saas_income',
    '--source=stripe',
    '--objective-id=obj_1',
    '--apply=1',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(ledger.status, 0, ledger.stderr || 'ledger entry should pass');
  assert.ok(ledger.payload && ledger.payload.ok === true, 'ledger payload should be ok');
  const entryId = String(ledger.payload.entry && ledger.payload.entry.entry_id || '');
  assert.ok(entryId, 'entry id expected');

  const classify = run(script, repoRoot, [
    'classify-tax',
    `--entry-id=${entryId}`,
    '--apply=1',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(classify.status, 0, classify.stderr || 'classify should pass');
  assert.strictEqual(String(classify.payload.tax_classification || ''), 'business_income');

  const signBlocked = run(script, repoRoot, [
    'contract-sign',
    '--contract-id=msa_high',
    '--counterparty=client_abc',
    '--value-usd=7000',
    '--terms=Master service agreement terms',
    '--risk=high',
    '--apply=1',
    `--policy=${policyPath}`
  ], env);
  assert.notStrictEqual(signBlocked.status, 0, 'high-risk contract without approval should fail');
  assert.strictEqual(String(signBlocked.payload.error || ''), 'high_risk_missing_approval_note');

  const signOk = run(script, repoRoot, [
    'contract-sign',
    '--contract-id=msa_high',
    '--counterparty=client_abc',
    '--value-usd=7000',
    '--terms=Master service agreement terms',
    '--risk=high',
    '--apply=1',
    '--approval-note=approved_by_operator_after_review',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(signOk.status, 0, signOk.stderr || 'high-risk contract with approval should pass');
  assert.ok(signOk.payload && signOk.payload.ok === true, 'contract sign payload should pass');

  const verify = run(script, repoRoot, [
    'contract-verify',
    '--contract-id=msa_high',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(verify.status, 0, verify.stderr || 'contract verify should pass');
  assert.ok(verify.payload && verify.payload.ok === true, 'contract verify payload should pass');

  const payoutBlocked = run(script, repoRoot, [
    'payout-route',
    '--provider=stripe',
    '--recipient=acct_123',
    '--amount-usd=1200',
    '--apply=1',
    `--policy=${policyPath}`
  ], env);
  assert.notStrictEqual(payoutBlocked.status, 0, 'high amount payout without approval note should fail');
  assert.strictEqual(String(payoutBlocked.payload.error || ''), 'approval_note_required_for_high_amount');

  const payoutOk = run(script, repoRoot, [
    'payout-route',
    '--provider=stripe',
    '--recipient=acct_123',
    '--amount-usd=1200',
    '--apply=1',
    '--approval-note=approved_after_manual_review',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(payoutOk.status, 0, payoutOk.stderr || 'payout route with approval should pass');
  assert.ok(payoutOk.payload && payoutOk.payload.ok === true, 'payout route payload should pass');
  assert.strictEqual(String(payoutOk.payload.decision || ''), 'execute', 'decision should be execute');

  const month = new Date().toISOString().slice(0, 7);
  const taxReport = run(script, repoRoot, [
    'tax-report',
    `--month=${month}`,
    '--apply=1',
    '--approval-note=approved_tax_report_generation',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(taxReport.status, 0, taxReport.stderr || 'tax report should pass');
  assert.ok(taxReport.payload && taxReport.payload.ok === true, 'tax report payload should pass');
  assert.ok(Array.isArray(taxReport.payload.report.totals), 'tax totals should be present');

  const status = run(script, repoRoot, ['status', `--month=${month}`, `--policy=${policyPath}`], env);
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  assert.ok(status.payload && status.payload.ok === true, 'status payload should pass');
  assert.ok(Number(status.payload.counts.entries_total || 0) >= 1, 'entries should be tracked');
  assert.ok(Number(status.payload.counts.contracts_total || 0) >= 1, 'contracts should be tracked');
  assert.ok(Number(status.payload.counts.payouts_total || 0) >= 1, 'payouts should be tracked');

  const receiptsPath = path.join(tmp, 'state', 'finance', 'economic_entity', 'receipts.jsonl');
  const receiptRows = fs.existsSync(receiptsPath)
    ? fs.readFileSync(receiptsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  assert.ok(receiptRows.length >= 6, 'immutable receipt rows should be written');
  assert.ok(receiptRows.every((row) => typeof row.hash === 'string' && row.hash.length > 10), 'receipt hashes should be present');

  console.log('economic_entity_manager.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`economic_entity_manager.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
