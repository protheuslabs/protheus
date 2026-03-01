#!/usr/bin/env node
'use strict';
export {};

/** V3-RACE-009/010 */
const path = require('path');
const {
  ROOT, nowIso, parseArgs, normalizeToken, toBool,
  clampNumber, readJson, writeJsonAtomic, appendJsonl, resolvePath, emit
} = require('../../lib/queued_backlog_runtime');

const POLICY_PATH = process.env.HYBRID_MEMORY_ENGINE_POLICY_PATH
  ? path.resolve(process.env.HYBRID_MEMORY_ENGINE_POLICY_PATH)
  : path.join(ROOT, 'config', 'hybrid_memory_engine_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/hybrid_memory_engine.js ingest --objective=<id> --content=<text>');
  console.log('  node systems/memory/hybrid_memory_engine.js consolidate');
  console.log('  node systems/memory/hybrid_memory_engine.js status');
}

function policy() {
  const base = {
    enabled: true,
    shadow_only: true,
    forgetting_curve_lambda: 0.02,
    paths: {
      latest_path: 'state/memory/hybrid_engine/latest.json',
      receipts_path: 'state/memory/hybrid_engine/receipts.jsonl',
      store_path: 'state/memory/hybrid_engine/store.json'
    }
  };
  const raw = readJson(POLICY_PATH, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    enabled: toBool(raw.enabled, base.enabled),
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    forgetting_curve_lambda: clampNumber(raw.forgetting_curve_lambda, 0.0001, 1, base.forgetting_curve_lambda),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      store_path: resolvePath(paths.store_path, base.paths.store_path)
    }
  };
}

function ingest(args: any, p: any) {
  const objective = normalizeToken(args.objective || 'global', 80) || 'global';
  const content = String(args.content || '');
  const store = readJson(p.paths.store_path, { schema_version: '1.0', rows: [] });
  store.rows = Array.isArray(store.rows) ? store.rows : [];
  const row = {
    ts: nowIso(),
    objective,
    vector: [content.length % 97, content.length % 41, content.length % 19],
    graph_edges: [],
    temporal_rank: Date.now()
  };
  store.rows.push(row);
  writeJsonAtomic(p.paths.store_path, store);
  const out = { ts: nowIso(), type: 'hybrid_memory_ingest', ok: true, shadow_only: p.shadow_only, objective, rows: store.rows.length };
  writeJsonAtomic(p.paths.latest_path, out);
  appendJsonl(p.paths.receipts_path, out);
  return out;
}

function consolidate(p: any) {
  const store = readJson(p.paths.store_path, { rows: [] });
  const rows = Array.isArray(store.rows) ? store.rows : [];
  const now = Date.now();
  const kept = rows.filter((row: any) => {
    const ts = Date.parse(String(row.ts || ''));
    if (!Number.isFinite(ts)) return true;
    const ageDays = (now - ts) / (24 * 60 * 60 * 1000);
    const score = Math.exp(-p.forgetting_curve_lambda * ageDays);
    return score >= 0.12;
  });
  store.rows = kept;
  store.updated_at = nowIso();
  writeJsonAtomic(p.paths.store_path, store);
  const out = { ts: nowIso(), type: 'hybrid_memory_consolidate', ok: true, shadow_only: p.shadow_only, kept: kept.length };
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
  if (!p.enabled) emit({ ok: false, error: 'hybrid_memory_engine_disabled' }, 1);
  if (cmd === 'ingest') emit(ingest(args, p));
  if (cmd === 'consolidate') emit(consolidate(p));
  if (cmd === 'status') emit({ ok: true, type: 'hybrid_memory_engine_status', latest: readJson(p.paths.latest_path, {}) });
  emit({ ok: false, error: 'unsupported_command', cmd }, 1);
}

main();
