#!/usr/bin/env node
'use strict';
export {};

/** V3-RACE-007 */
const path = require('path');
const {
  ROOT, nowIso, parseArgs, normalizeToken, toBool, readJson,
  writeJsonAtomic, appendJsonl, resolvePath, stableHash, emit
} = require('../../lib/queued_backlog_runtime');

const POLICY_PATH = process.env.CROSS_CELL_EXCHANGE_POLICY_PATH
  ? path.resolve(process.env.CROSS_CELL_EXCHANGE_POLICY_PATH)
  : path.join(ROOT, 'config', 'cross_cell_exchange_plane_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/cross_cell_exchange_plane.js exchange --from=<id> --to=<id> --payload=<json>');
  console.log('  node systems/memory/cross_cell_exchange_plane.js status');
}

function policy() {
  const base = {
    enabled: true,
    shadow_only: true,
    exchange_model: 'hereditary_master_reviewed',
    peer_to_peer_network_effect: false,
    paths: {
      latest_path: 'state/memory/cross_cell_exchange/latest.json',
      receipts_path: 'state/memory/cross_cell_exchange/receipts.jsonl',
      exchange_path: 'state/memory/cross_cell_exchange/exchanges.json'
    }
  };
  const raw = readJson(POLICY_PATH, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    enabled: toBool(raw.enabled, base.enabled),
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    exchange_model: normalizeToken(raw.exchange_model || base.exchange_model, 80) || base.exchange_model,
    peer_to_peer_network_effect: toBool(raw.peer_to_peer_network_effect, base.peer_to_peer_network_effect),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      exchange_path: resolvePath(paths.exchange_path, base.paths.exchange_path)
    }
  };
}

function exchange(args: any, p: any) {
  const from = normalizeToken(args.from || 'cell_a', 80);
  const to = normalizeToken(args.to || 'master', 80);
  const payloadHash = stableHash(String(args.payload || '{}'), 20);
  const exchanges = readJson(p.paths.exchange_path, { schema_version: '1.0', rows: [] });
  exchanges.rows = Array.isArray(exchanges.rows) ? exchanges.rows : [];
  const row = {
    ts: nowIso(),
    from,
    to,
    payload_hash: payloadHash,
    model: p.exchange_model,
    peer_to_peer_network_effect: p.peer_to_peer_network_effect
  };
  exchanges.rows.push(row);
  exchanges.updated_at = nowIso();
  writeJsonAtomic(p.paths.exchange_path, exchanges);

  const out = { ts: nowIso(), type: 'cross_cell_exchange', ok: true, shadow_only: p.shadow_only, ...row };
  writeJsonAtomic(p.paths.latest_path, out);
  appendJsonl(p.paths.receipts_path, out);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === '--help' || cmd === 'help' || cmd === '-h') {
    usage();
    return;
  }
  const p = policy();
  if (!p.enabled) emit({ ok: false, error: 'cross_cell_exchange_disabled' }, 1);
  if (cmd === 'exchange') emit(exchange(args, p));
  if (cmd === 'status') emit({ ok: true, type: 'cross_cell_exchange_status', latest: readJson(p.paths.latest_path, {}) });
  emit({ ok: false, error: 'unsupported_command', cmd }, 1);
}

main();
