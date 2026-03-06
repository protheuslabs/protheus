#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-168
 * Hash chain ledger for non-bypass audit integrity.
 */

const path = require('path');
const crypto = require('crypto');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  toBool,
  readJson,
  readJsonl,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.HASH_CHAIN_LEDGER_POLICY_PATH
  ? path.resolve(process.env.HASH_CHAIN_LEDGER_POLICY_PATH)
  : path.join(ROOT, 'config', 'hash_chain_ledger_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/audit/hash_chain_ledger.js append --event=<id> [--payload_json={}]');
  console.log('  node systems/audit/hash_chain_ledger.js verify [--strict=1|0]');
  console.log('  node systems/audit/hash_chain_ledger.js status');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    rollback: {
      enabled: true,
      require_apply_flag: true
    },
    paths: {
      chain_path: 'state/audit/hash_chain_ledger/chain.jsonl',
      latest_path: 'state/audit/hash_chain_ledger/latest.json',
      receipts_path: 'state/audit/hash_chain_ledger/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const rollback = raw.rollback && typeof raw.rollback === 'object' ? raw.rollback : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    rollback: {
      enabled: rollback.enabled !== false,
      require_apply_flag: rollback.require_apply_flag !== false
    },
    paths: {
      chain_path: resolvePath(paths.chain_path, base.paths.chain_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    }
  };
}

function hash(value: any) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function parsePayload(raw: any) {
  if (!raw) return {};
  try { return JSON.parse(String(raw)); } catch { return { raw: String(raw).slice(0, 5000) }; }
}

function appendEvent(policy: any, args: any) {
  const event = cleanText(args.event || 'event', 120) || 'event';
  const payload = parsePayload(args.payload_json);
  const chain = readJsonl(policy.paths.chain_path);
  const prev = chain.length > 0 ? chain[chain.length - 1] : null;
  const prevHash = prev && prev.row_hash ? String(prev.row_hash) : 'GENESIS';
  const ts = nowIso();
  const row = {
    ts,
    event,
    payload,
    prev_hash: prevHash
  };
  const rowHash = hash(`${row.ts}|${row.event}|${JSON.stringify(row.payload)}|${row.prev_hash}`);
  const outRow = { ...row, row_hash: rowHash };
  appendJsonl(policy.paths.chain_path, outRow);
  const out = {
    ok: true,
    type: 'hash_chain_ledger_append',
    ts,
    event,
    row_hash: rowHash,
    prev_hash: prevHash,
    chain_length: chain.length + 1
  };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function verifyChain(policy: any, strict: boolean) {
  const chain = readJsonl(policy.paths.chain_path);
  let ok = true;
  const issues: any[] = [];
  let expectedPrev = 'GENESIS';
  for (let i = 0; i < chain.length; i += 1) {
    const row = chain[i];
    const computed = hash(`${row.ts}|${row.event}|${JSON.stringify(row.payload || {})}|${row.prev_hash}`);
    if (String(row.prev_hash || '') !== expectedPrev) {
      ok = false;
      issues.push({ index: i, type: 'prev_hash_mismatch', expected_prev_hash: expectedPrev, actual_prev_hash: row.prev_hash });
    }
    if (String(row.row_hash || '') !== computed) {
      ok = false;
      issues.push({ index: i, type: 'row_hash_mismatch', expected_row_hash: computed, actual_row_hash: row.row_hash });
    }
    expectedPrev = String(row.row_hash || expectedPrev);
  }
  const out = {
    ok: strict ? ok : true,
    pass: ok,
    strict,
    type: 'hash_chain_ledger_verify',
    ts: nowIso(),
    chain_length: chain.length,
    issues
  };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function status(policy: any) {
  const latest = readJson(policy.paths.latest_path, {
    ok: true,
    type: 'hash_chain_ledger',
    status: 'no_status'
  });
  return {
    ...latest,
    chain_length: readJsonl(policy.paths.chain_path).length
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'status').toLowerCase();
  if (args.help || cmd === '--help' || cmd === 'help') {
    usage();
    return emit({ ok: true, help: true }, 0);
  }
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (cmd === 'append') return emit(appendEvent(policy, args), 0);
  if (cmd === 'verify') {
    const out = verifyChain(policy, toBool(args.strict, true));
    return emit(out, out.ok ? 0 : 1);
  }
  if (cmd === 'status') return emit(status(policy), 0);
  usage();
  return emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
}

main();
