#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.AGENT_SETTLEMENT_EXTENSION_POLICY_PATH
  ? path.resolve(process.env.AGENT_SETTLEMENT_EXTENSION_POLICY_PATH)
  : path.join(ROOT, 'config', 'agent_settlement_extension_policy.json');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 280) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen); }
function normalizeToken(v: unknown, maxLen = 180) { return cleanText(v, maxLen).toLowerCase().replace(/[^a-z0-9_.:/-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, ''); }
function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }
function readJson(filePath: string, fallback: any) { try { if (!fs.existsSync(filePath)) return fallback; const p = JSON.parse(fs.readFileSync(filePath, 'utf8')); return p == null ? fallback : p; } catch { return fallback; } }
function writeJsonAtomic(filePath: string, value: AnyObj) { ensureDir(path.dirname(filePath)); const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); fs.renameSync(tmp, filePath); }
function appendJsonl(filePath: string, row: AnyObj) { ensureDir(path.dirname(filePath)); fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8'); }
function relPath(filePath: string) { return path.relative(ROOT, filePath).replace(/\\/g, '/'); }
function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) { out._.push(tok); continue; }
    const idx = tok.indexOf('=');
    if (idx >= 0) { out[tok.slice(2, idx)] = tok.slice(idx + 1); continue; }
    const key = tok.slice(2); const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) { out[key] = String(next); i += 1; continue; }
    out[key] = true;
  }
  return out;
}
function resolvePath(raw: unknown, fallbackRel: string) { const txt = cleanText(raw || '', 520); if (!txt) return path.join(ROOT, fallbackRel); return path.isAbsolute(txt) ? txt : path.join(ROOT, txt); }

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    escrow_required_threshold_usd: 100,
    max_fee_rate: 0.05,
    receipts_path: 'state/finance/agent_settlement_extension/receipts.jsonl',
    ledger_path: 'state/finance/agent_settlement_extension/ledger.json',
    latest_path: 'state/finance/agent_settlement_extension/latest.json'
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  return {
    version: cleanText(src.version || base.version, 40) || base.version,
    enabled: src.enabled !== false,
    escrow_required_threshold_usd: Number(src.escrow_required_threshold_usd != null ? src.escrow_required_threshold_usd : base.escrow_required_threshold_usd) || base.escrow_required_threshold_usd,
    max_fee_rate: Number(src.max_fee_rate != null ? src.max_fee_rate : base.max_fee_rate) || base.max_fee_rate,
    receipts_path: resolvePath(src.receipts_path || base.receipts_path, base.receipts_path),
    ledger_path: resolvePath(src.ledger_path || base.ledger_path, base.ledger_path),
    latest_path: resolvePath(src.latest_path || base.latest_path, base.latest_path)
  };
}

function settle(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (policy.enabled !== true) return { ok: false, type: 'agent_settlement_extension_settle', error: 'policy_disabled' };

  const settlementId = normalizeToken(args['settlement-id'] || args.settlement_id || `settle_${Date.now()}`, 180);
  const amountUsd = Number(args['amount-usd'] != null ? args['amount-usd'] : args.amount_usd);
  const feeRate = Number(args['fee-rate'] != null ? args['fee-rate'] : args.fee_rate || 0.01);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return { ok: false, type: 'agent_settlement_extension_settle', error: 'amount_usd_invalid' };
  }
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate > Number(policy.max_fee_rate || 0.05)) {
    return { ok: false, type: 'agent_settlement_extension_settle', error: 'fee_rate_invalid', max_fee_rate: policy.max_fee_rate };
  }

  const ledger = readJson(policy.ledger_path, {
    schema_id: 'agent_settlement_ledger',
    schema_version: '1.0',
    entries: {}
  });
  if (!ledger.entries || typeof ledger.entries !== 'object') ledger.entries = {};

  const escrowRequired = amountUsd >= Number(policy.escrow_required_threshold_usd || 100);
  const feeUsd = Number((amountUsd * feeRate).toFixed(2));
  const netUsd = Number((amountUsd - feeUsd).toFixed(2));
  const row = {
    settlement_id: settlementId,
    ts: nowIso(),
    amount_usd: Number(amountUsd.toFixed(2)),
    fee_rate: Number(feeRate.toFixed(4)),
    fee_usd: feeUsd,
    net_usd: netUsd,
    escrow_required: escrowRequired,
    status: escrowRequired ? 'held_in_escrow' : 'settled',
    counterparty: normalizeToken(args.counterparty || 'unknown', 120) || 'unknown',
    reversible_until: new Date(Date.now() + (24 * 3600 * 1000)).toISOString()
  };
  ledger.updated_at = row.ts;
  ledger.entries[settlementId] = row;
  writeJsonAtomic(policy.ledger_path, ledger);

  const out = {
    ok: true,
    type: 'agent_settlement_extension_settle',
    ts: nowIso(),
    settlement: row,
    ledger_path: relPath(policy.ledger_path)
  };
  appendJsonl(policy.receipts_path, out);
  writeJsonAtomic(policy.latest_path, out);
  return out;
}

function status(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const ledger = readJson(policy.ledger_path, { entries: {} });
  const entries = ledger && ledger.entries && typeof ledger.entries === 'object' ? Object.values(ledger.entries) : [];
  const latest = readJson(policy.latest_path, null);
  return {
    ok: true,
    type: 'agent_settlement_extension_status',
    ts: nowIso(),
    totals: {
      entries: entries.length,
      held_in_escrow: entries.filter((row: AnyObj) => row && row.status === 'held_in_escrow').length,
      settled: entries.filter((row: AnyObj) => row && row.status === 'settled').length
    },
    latest: latest && typeof latest === 'object'
      ? {
        ts: latest.ts || null,
        settlement_id: latest.settlement && latest.settlement.settlement_id || null,
        status: latest.settlement && latest.settlement.status || null
      }
      : null,
    paths: {
      ledger_path: relPath(policy.ledger_path),
      receipts_path: relPath(policy.receipts_path),
      latest_path: relPath(policy.latest_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/finance/agent_settlement_extension.js settle --settlement-id=<id> --amount-usd=<amount> [--fee-rate=0.01] [--counterparty=<id>]');
  console.log('  node systems/finance/agent_settlement_extension.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  let out: AnyObj;
  if (cmd === 'help' || args.help) { usage(); process.exit(0); }
  if (cmd === 'settle') out = settle(args);
  else if (cmd === 'status') out = status(args);
  else out = { ok: false, type: 'agent_settlement_extension', error: `unknown_command:${cmd}` };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  settle,
  status
};
