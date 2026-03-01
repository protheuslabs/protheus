#!/usr/bin/env node
'use strict';
export {};

/**
 * memory_efficiency_plane.js
 *
 * Implements:
 * - V3-MEM-001..008
 * - V3-RACE-009/010 foundational contracts
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  clampNumber,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  readJsonl,
  resolvePath,
  stableHash,
  median,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.MEMORY_EFFICIENCY_PLANE_POLICY_PATH
  ? path.resolve(process.env.MEMORY_EFFICIENCY_PLANE_POLICY_PATH)
  : path.join(ROOT, 'config', 'memory_efficiency_plane_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/memory_efficiency_plane.js run [--policy=<path>] [--apply=0|1]');
  console.log('  node systems/memory/memory_efficiency_plane.js query --q="text" [--objective=<id>] [--policy=<path>]');
  console.log('  node systems/memory/memory_efficiency_plane.js memoize --kind=<id> --input="..." --output="..." [--policy=<path>]');
  console.log('  node systems/memory/memory_efficiency_plane.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    retrieval: {
      metadata_confidence_threshold: 0.78,
      max_metadata_hits: 12,
      max_full_fetch: 5
    },
    objective_shards: {
      default_objective: 'global',
      max_overlay_nodes: 10
    },
    prompt_cache: {
      ttl_hours: 24,
      max_blocks: 512
    },
    transform_memoization: {
      ttl_hours: 168,
      max_entries: 4096
    },
    receipt_tiers: {
      compact_max_bytes: 1800
    },
    probe_cadence: {
      min_minutes: 5,
      max_minutes: 60,
      degraded_multiplier: 1.6
    },
    paths: {
      memory_index_path: 'MEMORY_INDEX.md',
      state_root: 'state/memory/efficiency_plane',
      content_store_path: 'state/memory/efficiency_plane/content_store.json',
      metadata_index_path: 'state/memory/efficiency_plane/metadata_index.json',
      shard_index_path: 'state/memory/efficiency_plane/objective_shards.json',
      distilled_views_path: 'state/memory/efficiency_plane/distilled_views.json',
      prompt_block_cache_path: 'state/memory/efficiency_plane/prompt_block_cache.json',
      transform_memo_path: 'state/memory/efficiency_plane/transform_memo.json',
      receipt_views_path: 'state/memory/efficiency_plane/receipt_views.json',
      probe_cadence_path: 'state/memory/efficiency_plane/probe_cadence.json',
      latest_path: 'state/memory/efficiency_plane/latest.json',
      receipts_path: 'state/memory/efficiency_plane/receipts.jsonl',
      model_health_history_path: 'state/routing/model_health_auto_recovery/history.jsonl',
      full_receipts_path: 'state/security/black_box_ledger.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const retrieval = raw.retrieval && typeof raw.retrieval === 'object' ? raw.retrieval : {};
  const shards = raw.objective_shards && typeof raw.objective_shards === 'object' ? raw.objective_shards : {};
  const promptCache = raw.prompt_cache && typeof raw.prompt_cache === 'object' ? raw.prompt_cache : {};
  const memo = raw.transform_memoization && typeof raw.transform_memoization === 'object' ? raw.transform_memoization : {};
  const tiers = raw.receipt_tiers && typeof raw.receipt_tiers === 'object' ? raw.receipt_tiers : {};
  const cadence = raw.probe_cadence && typeof raw.probe_cadence === 'object' ? raw.probe_cadence : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    retrieval: {
      metadata_confidence_threshold: clampNumber(retrieval.metadata_confidence_threshold, 0, 1, base.retrieval.metadata_confidence_threshold),
      max_metadata_hits: clampInt(retrieval.max_metadata_hits, 1, 200, base.retrieval.max_metadata_hits),
      max_full_fetch: clampInt(retrieval.max_full_fetch, 1, 100, base.retrieval.max_full_fetch)
    },
    objective_shards: {
      default_objective: normalizeToken(shards.default_objective || base.objective_shards.default_objective, 80) || base.objective_shards.default_objective,
      max_overlay_nodes: clampInt(shards.max_overlay_nodes, 0, 200, base.objective_shards.max_overlay_nodes)
    },
    prompt_cache: {
      ttl_hours: clampInt(promptCache.ttl_hours, 1, 24 * 365, base.prompt_cache.ttl_hours),
      max_blocks: clampInt(promptCache.max_blocks, 1, 100000, base.prompt_cache.max_blocks)
    },
    transform_memoization: {
      ttl_hours: clampInt(memo.ttl_hours, 1, 24 * 365, base.transform_memoization.ttl_hours),
      max_entries: clampInt(memo.max_entries, 1, 100000, base.transform_memoization.max_entries)
    },
    receipt_tiers: {
      compact_max_bytes: clampInt(tiers.compact_max_bytes, 200, 100000, base.receipt_tiers.compact_max_bytes)
    },
    probe_cadence: {
      min_minutes: clampInt(cadence.min_minutes, 1, 120, base.probe_cadence.min_minutes),
      max_minutes: clampInt(cadence.max_minutes, 1, 24 * 60, base.probe_cadence.max_minutes),
      degraded_multiplier: clampNumber(cadence.degraded_multiplier, 1, 20, base.probe_cadence.degraded_multiplier)
    },
    paths: {
      memory_index_path: resolvePath(paths.memory_index_path, base.paths.memory_index_path),
      state_root: resolvePath(paths.state_root, base.paths.state_root),
      content_store_path: resolvePath(paths.content_store_path, base.paths.content_store_path),
      metadata_index_path: resolvePath(paths.metadata_index_path, base.paths.metadata_index_path),
      shard_index_path: resolvePath(paths.shard_index_path, base.paths.shard_index_path),
      distilled_views_path: resolvePath(paths.distilled_views_path, base.paths.distilled_views_path),
      prompt_block_cache_path: resolvePath(paths.prompt_block_cache_path, base.paths.prompt_block_cache_path),
      transform_memo_path: resolvePath(paths.transform_memo_path, base.paths.transform_memo_path),
      receipt_views_path: resolvePath(paths.receipt_views_path, base.paths.receipt_views_path),
      probe_cadence_path: resolvePath(paths.probe_cadence_path, base.paths.probe_cadence_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      model_health_history_path: resolvePath(paths.model_health_history_path, base.paths.model_health_history_path),
      full_receipts_path: resolvePath(paths.full_receipts_path, base.paths.full_receipts_path)
    }
  };
}

function parseMemoryIndex(memoryIndexPath: string) {
  if (!fs.existsSync(memoryIndexPath)) return [];
  const rows = String(fs.readFileSync(memoryIndexPath, 'utf8') || '').split(/\r?\n/);
  const out: any[] = [];
  for (const row of rows) {
    if (!row.startsWith('| `')) continue;
    const cells = row.split('|').slice(1, -1).map((v) => cleanText(v, 200));
    if (cells.length < 3) continue;
    const nodeId = cleanText(cells[0].replace(/`/g, ''), 120);
    const title = cleanText(cells[1].replace(/`/g, ''), 200);
    const file = cleanText(cells[2].replace(/`/g, ''), 260);
    if (!nodeId || !file) continue;
    out.push({ node_id: nodeId, title, file: path.isAbsolute(file) ? file : path.join(ROOT, file) });
  }
  return out;
}

function extractNodeBody(filePath: string, nodeId: string) {
  if (!fs.existsSync(filePath)) return '';
  const text = String(fs.readFileSync(filePath, 'utf8') || '');
  const marker = `node_id: ${nodeId}`;
  const idx = text.indexOf(marker);
  if (idx < 0) return '';

  const prior = text.lastIndexOf('---', idx);
  if (prior < 0) return '';
  const bodyStart = text.indexOf('\n---', idx);
  if (bodyStart < 0) return '';
  const contentStart = bodyStart + 4;

  let nextMarker = text.indexOf('\n---\n', contentStart + 1);
  while (nextMarker >= 0) {
    const future = text.slice(nextMarker + 5, nextMarker + 140);
    if (future.includes('node_id:')) break;
    nextMarker = text.indexOf('\n---\n', nextMarker + 5);
  }
  const end = nextMarker >= 0 ? nextMarker : text.length;
  return text.slice(contentStart, end).trim();
}

function inferObjective(meta: any) {
  const t = `${meta.title || ''} ${meta.node_id || ''}`.toLowerCase();
  if (t.includes('molt') || t.includes('income') || t.includes('revenue')) return 'revenue';
  if (t.includes('security') || t.includes('integrity')) return 'security';
  if (t.includes('memory') || t.includes('index')) return 'memory';
  if (t.includes('x-') || t.includes('moltbook') || t.includes('social')) return 'distribution';
  return 'global';
}

function runPlane(args: any, policy: any) {
  const apply = toBool(args.apply, false);
  const nodes = parseMemoryIndex(policy.paths.memory_index_path);

  const contentStore: any = {
    schema_version: '1.0',
    generated_at: nowIso(),
    by_hash: {}
  };

  const metadataRows: any[] = [];
  const shardRows: Record<string, string[]> = {};
  const distilledRows: any[] = [];

  for (const meta of nodes) {
    const body = extractNodeBody(meta.file, meta.node_id);
    const canonical = cleanText(body, 100000);
    const hash = stableHash(canonical, 32);
    if (!contentStore.by_hash[hash]) {
      contentStore.by_hash[hash] = {
        hash,
        body: canonical,
        size_bytes: Buffer.byteLength(canonical, 'utf8'),
        provenance: []
      };
    }
    contentStore.by_hash[hash].provenance.push({ node_id: meta.node_id, file: path.relative(ROOT, meta.file).replace(/\\/g, '/') });

    const objective = inferObjective(meta);
    metadataRows.push({
      node_id: meta.node_id,
      title: meta.title,
      file: path.relative(ROOT, meta.file).replace(/\\/g, '/'),
      content_hash: hash,
      objective,
      summary: cleanText(canonical, 220)
    });

    shardRows[objective] = shardRows[objective] || [];
    shardRows[objective].push(meta.node_id);

    distilledRows.push({
      node_id: meta.node_id,
      objective,
      digest: cleanText(canonical, 400),
      source_hash: hash
    });
  }

  const metadataIndex = {
    schema_version: '1.0',
    generated_at: nowIso(),
    rows: metadataRows
  };

  const shardIndex = {
    schema_version: '1.0',
    generated_at: nowIso(),
    default_objective: policy.objective_shards.default_objective,
    shards: shardRows
  };

  const distilledViews = {
    schema_version: '1.0',
    generated_at: nowIso(),
    views: distilledRows
  };

  const promptBlockCache = readJson(policy.paths.prompt_block_cache_path, {
    schema_version: '1.0',
    updated_at: null,
    blocks: {}
  });
  promptBlockCache.blocks = promptBlockCache.blocks && typeof promptBlockCache.blocks === 'object' ? promptBlockCache.blocks : {};

  const baseBlocks = {
    constitution: cleanText(readJson(path.join(ROOT, 'AGENT-CONSTITUTION.md'), ''), 4000),
    identity: cleanText(readJson(path.join(ROOT, 'IDENTITY.md'), ''), 4000),
    soul: cleanText(readJson(path.join(ROOT, 'SOUL.md'), ''), 4000)
  };
  for (const [k, v] of Object.entries(baseBlocks)) {
    const hash = stableHash(v, 24);
    promptBlockCache.blocks[k] = {
      hash,
      text: v,
      updated_at: nowIso(),
      expires_at: new Date(Date.now() + policy.prompt_cache.ttl_hours * 60 * 60 * 1000).toISOString()
    };
  }

  const transformMemo = readJson(policy.paths.transform_memo_path, {
    schema_version: '1.0',
    updated_at: null,
    rows: {}
  });
  transformMemo.rows = transformMemo.rows && typeof transformMemo.rows === 'object' ? transformMemo.rows : {};

  const fullReceipts = readJsonl(policy.paths.full_receipts_path);
  const compact = fullReceipts.slice(-200).map((row: any) => {
    const text = JSON.stringify(row);
    const clipped = text.length > policy.receipt_tiers.compact_max_bytes
      ? `${text.slice(0, policy.receipt_tiers.compact_max_bytes)}...`
      : text;
    return {
      ts: row.ts || null,
      type: cleanText(row.type || row.event || 'unknown', 80),
      compact: clipped,
      source_hash: stableHash(text, 16)
    };
  });
  const receiptViews = {
    schema_version: '1.0',
    generated_at: nowIso(),
    compact
  };

  const modelHealth = readJsonl(policy.paths.model_health_history_path);
  const recentDegraded = modelHealth.slice(-50).filter((row: any) => String(row.status || row.outcome || '').toLowerCase().includes('degrad')).length;
  const cadenceMinutes = recentDegraded > 5
    ? clampInt(Math.round(policy.probe_cadence.min_minutes * policy.probe_cadence.degraded_multiplier), policy.probe_cadence.min_minutes, policy.probe_cadence.max_minutes, policy.probe_cadence.min_minutes)
    : policy.probe_cadence.max_minutes;
  const probeCadence = {
    schema_version: '1.0',
    generated_at: nowIso(),
    recent_degraded_events: recentDegraded,
    recommended_minutes: cadenceMinutes
  };

  if (apply) {
    writeJsonAtomic(policy.paths.content_store_path, contentStore);
    writeJsonAtomic(policy.paths.metadata_index_path, metadataIndex);
    writeJsonAtomic(policy.paths.shard_index_path, shardIndex);
    writeJsonAtomic(policy.paths.distilled_views_path, distilledViews);
    writeJsonAtomic(policy.paths.prompt_block_cache_path, promptBlockCache);
    writeJsonAtomic(policy.paths.transform_memo_path, transformMemo);
    writeJsonAtomic(policy.paths.receipt_views_path, receiptViews);
    writeJsonAtomic(policy.paths.probe_cadence_path, probeCadence);
  }

  const totalPayloadBytes = Object.values(contentStore.by_hash).reduce((acc: number, row: any) => acc + Number(row.size_bytes || 0), 0);
  const uniqueBodies = Object.keys(contentStore.by_hash).length;
  const totalNodes = metadataRows.length;
  const dedupeRatio = totalNodes > 0 ? Number((1 - uniqueBodies / totalNodes).toFixed(6)) : 0;

  const receipt = {
    ts: nowIso(),
    type: 'memory_efficiency_plane_run',
    ok: true,
    shadow_only: policy.shadow_only,
    apply,
    metrics: {
      total_nodes: totalNodes,
      unique_bodies: uniqueBodies,
      dedupe_ratio: dedupeRatio,
      total_payload_bytes: totalPayloadBytes,
      median_summary_length: median(metadataRows.map((r) => String(r.summary || '').length)) || 0,
      compact_receipts: compact.length,
      recommended_probe_cadence_minutes: cadenceMinutes
    }
  };

  writeJsonAtomic(policy.paths.latest_path, receipt);
  appendJsonl(policy.paths.receipts_path, receipt);
  return receipt;
}

function query(args: any, policy: any) {
  const q = cleanText(args.q || args.query || '', 240).toLowerCase();
  if (!q) return { ok: false, error: 'missing_query' };

  const objective = normalizeToken(args.objective || policy.objective_shards.default_objective, 80) || policy.objective_shards.default_objective;
  const metadataIndex = readJson(policy.paths.metadata_index_path, { rows: [] });
  const contentStore = readJson(policy.paths.content_store_path, { by_hash: {} });
  const shardIndex = readJson(policy.paths.shard_index_path, { shards: {} });

  const objectiveNodes = new Set<string>((shardIndex.shards && shardIndex.shards[objective]) || []);
  const overlayNodes: string[] = (shardIndex.shards && shardIndex.shards.global) || [];
  const allowed = new Set<string>([...objectiveNodes, ...overlayNodes.slice(0, policy.objective_shards.max_overlay_nodes)]);

  const rows = Array.isArray(metadataIndex.rows) ? metadataIndex.rows : [];
  const scored = rows
    .filter((row: any) => allowed.size === 0 || allowed.has(row.node_id))
    .map((row: any) => {
      const hay = `${String(row.title || '').toLowerCase()} ${String(row.summary || '').toLowerCase()} ${String(row.node_id || '').toLowerCase()}`;
      const matchCount = q.split(/\s+/).filter(Boolean).filter((tok) => hay.includes(tok)).length;
      const confidence = clampNumber(matchCount / Math.max(1, q.split(/\s+/).filter(Boolean).length), 0, 1, 0);
      return { ...row, confidence };
    })
    .filter((row: any) => row.confidence > 0)
    .sort((a: any, b: any) => b.confidence - a.confidence)
    .slice(0, policy.retrieval.max_metadata_hits);

  const shouldFetchFull = scored.length === 0 || scored[0].confidence < policy.retrieval.metadata_confidence_threshold;
  const full = shouldFetchFull
    ? scored.slice(0, policy.retrieval.max_full_fetch).map((row: any) => {
        const body = contentStore.by_hash && contentStore.by_hash[row.content_hash] ? contentStore.by_hash[row.content_hash].body : '';
        return {
          node_id: row.node_id,
          title: row.title,
          confidence: row.confidence,
          body: cleanText(body, 1200)
        };
      })
    : [];

  const receipt = {
    ts: nowIso(),
    type: 'memory_efficiency_plane_query',
    ok: true,
    query: q,
    objective,
    metadata_hits: scored.length,
    full_fetch_count: full.length,
    full_fetch_triggered: shouldFetchFull,
    top_confidence: scored[0] ? scored[0].confidence : 0
  };
  writeJsonAtomic(policy.paths.latest_path, receipt);
  appendJsonl(policy.paths.receipts_path, receipt);

  return {
    ok: true,
    ...receipt,
    metadata: scored,
    full
  };
}

function memoize(args: any, policy: any) {
  const kind = normalizeToken(args.kind || 'generic_transform', 80) || 'generic_transform';
  const input = cleanText(args.input || '', 10000);
  const output = cleanText(args.output || '', 10000);
  if (!input || !output) return { ok: false, error: 'missing_input_or_output' };

  const memo = readJson(policy.paths.transform_memo_path, {
    schema_version: '1.0',
    updated_at: null,
    rows: {}
  });
  memo.rows = memo.rows && typeof memo.rows === 'object' ? memo.rows : {};

  const key = stableHash(`${kind}|${input}`, 24);
  memo.rows[key] = {
    key,
    kind,
    input_hash: stableHash(input, 24),
    output,
    updated_at: nowIso(),
    expires_at: new Date(Date.now() + policy.transform_memoization.ttl_hours * 60 * 60 * 1000).toISOString()
  };

  const keys = Object.keys(memo.rows);
  if (keys.length > policy.transform_memoization.max_entries) {
    keys.sort((a, b) => String(memo.rows[a].updated_at || '').localeCompare(String(memo.rows[b].updated_at || '')));
    const drop = keys.length - policy.transform_memoization.max_entries;
    for (let i = 0; i < drop; i += 1) delete memo.rows[keys[i]];
  }

  writeJsonAtomic(policy.paths.transform_memo_path, memo);
  const receipt = {
    ts: nowIso(),
    type: 'memory_efficiency_plane_memoize',
    ok: true,
    key,
    kind,
    total_entries: Object.keys(memo.rows).length
  };
  writeJsonAtomic(policy.paths.latest_path, receipt);
  appendJsonl(policy.paths.receipts_path, receipt);
  return receipt;
}

function status(policy: any) {
  const latest = readJson(policy.paths.latest_path, {});
  const contentStore = readJson(policy.paths.content_store_path, { by_hash: {} });
  const metadataIndex = readJson(policy.paths.metadata_index_path, { rows: [] });
  const probeCadence = readJson(policy.paths.probe_cadence_path, {});
  return {
    ok: true,
    type: 'memory_efficiency_plane_status',
    shadow_only: policy.shadow_only,
    latest,
    unique_bodies: Object.keys(contentStore.by_hash || {}).length,
    indexed_nodes: Array.isArray(metadataIndex.rows) ? metadataIndex.rows.length : 0,
    recommended_probe_cadence_minutes: clampInt(probeCadence.recommended_minutes, 1, 10000, policy.probe_cadence.max_minutes)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) emit({ ok: false, error: 'memory_efficiency_plane_disabled' }, 1);

  if (cmd === 'run') emit(runPlane(args, policy));
  if (cmd === 'query') emit(query(args, policy));
  if (cmd === 'memoize') emit(memoize(args, policy));
  if (cmd === 'status') emit(status(policy));

  usage();
  process.exit(1);
}

main();
