#!/usr/bin/env node
'use strict';
export {};

/** V3-RACE-004 */
const path = require('path');
const {
  ROOT, nowIso, parseArgs, cleanText, normalizeToken, toBool,
  clampNumber, readJson, writeJsonAtomic, appendJsonl, resolvePath, emit
} = require('../../lib/queued_backlog_runtime');

const POLICY_PATH = process.env.MODEL_CATALOG_SERVICE_POLICY_PATH
  ? path.resolve(process.env.MODEL_CATALOG_SERVICE_POLICY_PATH)
  : path.join(ROOT, 'config', 'model_catalog_service_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/routing/model_catalog_service.js upsert --provider=<id> --model=<id> --latency_ms=<n> --cost_per_1k=<n> --quality=<0..1> --reliability=<0..1>');
  console.log('  node systems/routing/model_catalog_service.js select [--min_quality=<0..1>] [--max_cost_per_1k=<n>]');
  console.log('  node systems/routing/model_catalog_service.js status');
}

function policy() {
  const base = {
    enabled: true,
    shadow_only: true,
    paths: {
      catalog_path: 'state/routing/model_catalog/catalog.json',
      latest_path: 'state/routing/model_catalog/latest.json',
      receipts_path: 'state/routing/model_catalog/receipts.jsonl'
    }
  };
  const raw = readJson(POLICY_PATH, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    enabled: toBool(raw.enabled, base.enabled),
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    paths: {
      catalog_path: resolvePath(paths.catalog_path, base.paths.catalog_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    }
  };
}

function upsert(args: any, p: any) {
  const provider = normalizeToken(args.provider || 'unknown', 80) || 'unknown';
  const model = normalizeToken(args.model || 'unknown_model', 120) || 'unknown_model';
  const latency = clampNumber(args.latency_ms, 1, 100000, 9999);
  const cost = clampNumber(args.cost_per_1k, 0, 1000, 1);
  const quality = clampNumber(args.quality, 0, 1, 0.5);
  const reliability = clampNumber(args.reliability, 0, 1, 0.5);
  const score = Number((quality * 0.45 + reliability * 0.35 + (1 / Math.max(1, latency)) * 50 - cost * 0.05).toFixed(6));

  const cat = readJson(p.paths.catalog_path, { schema_version: '1.0', rows: [] });
  cat.rows = Array.isArray(cat.rows) ? cat.rows : [];
  const key = `${provider}/${model}`;
  const row = { key, provider, model, latency_ms: latency, cost_per_1k: cost, quality, reliability, score, updated_at: nowIso() };
  const idx = cat.rows.findIndex((r: any) => r.key === key);
  if (idx >= 0) cat.rows[idx] = row;
  else cat.rows.push(row);
  cat.rows.sort((a: any, b: any) => Number(b.score || 0) - Number(a.score || 0));
  cat.updated_at = nowIso();
  writeJsonAtomic(p.paths.catalog_path, cat);

  const receipt = { ts: nowIso(), type: 'model_catalog_upsert', ok: true, shadow_only: p.shadow_only, key, score, rank: cat.rows.findIndex((r: any) => r.key === key) + 1 };
  writeJsonAtomic(p.paths.latest_path, receipt);
  appendJsonl(p.paths.receipts_path, receipt);
  return receipt;
}

function select(args: any, p: any) {
  const minQuality = clampNumber(args.min_quality, 0, 1, 0);
  const maxCost = clampNumber(args.max_cost_per_1k, 0, 1000, 1000);
  const cat = readJson(p.paths.catalog_path, { rows: [] });
  const rows = (Array.isArray(cat.rows) ? cat.rows : []).filter((r: any) => Number(r.quality || 0) >= minQuality && Number(r.cost_per_1k || 0) <= maxCost);
  return {
    ok: true,
    type: 'model_catalog_select',
    count: rows.length,
    selected: rows.slice(0, 5),
    shadow_only: p.shadow_only
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === '--help' || cmd === 'help' || cmd === '-h') {
    usage();
    return;
  }
  const p = policy();
  if (!p.enabled) emit({ ok: false, error: 'model_catalog_service_disabled' }, 1);
  if (cmd === 'upsert') emit(upsert(args, p));
  if (cmd === 'select') emit(select(args, p));
  if (cmd === 'status') emit({ ok: true, type: 'model_catalog_status', latest: readJson(p.paths.latest_path, {}) });
  emit({ ok: false, error: 'unsupported_command', cmd }, 1);
}

main();
