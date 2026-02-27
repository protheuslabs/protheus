#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/memory/memory_federation_plane.js
 *
 * V2-062:
 * - Long-horizon memory compaction/distillation with deterministic replay hash.
 * - Policy-bound stale pruning.
 * - Opt-in attested cross-instance archetype exchange with local fallback.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.MEMORY_FEDERATION_POLICY_PATH
  ? path.resolve(process.env.MEMORY_FEDERATION_POLICY_PATH)
  : path.join(ROOT, 'config', 'memory_federation_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    const raw = String(token || '');
    if (!raw.startsWith('--')) {
      out._.push(raw);
      continue;
    }
    const idx = raw.indexOf('=');
    if (idx < 0) out[raw.slice(2)] = true;
    else out[raw.slice(2, idx)] = raw.slice(idx + 1);
  }
  return out;
}

function cleanText(v: unknown, maxLen = 280) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: any) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const row = JSON.parse(line);
          return row && typeof row === 'object' ? row : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function stableStringify(value: unknown): string {
  if (value == null) return 'null';
  if (Array.isArray(value)) return `[${value.map((row) => stableStringify(row)).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value);
  const obj = value as AnyObj;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function sha16(seed: string) {
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

function parseIsoMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function runtimePaths(policyPath: string) {
  const stateDir = process.env.MEMORY_FEDERATION_STATE_DIR
    ? path.resolve(process.env.MEMORY_FEDERATION_STATE_DIR)
    : path.join(ROOT, 'state', 'memory', 'federation');
  return {
    policy_path: policyPath,
    state_dir: stateDir,
    latest_path: path.join(stateDir, 'latest.json'),
    state_path: path.join(stateDir, 'state.json'),
    distilled_latest_path: path.join(stateDir, 'distilled_latest.json'),
    history_path: path.join(stateDir, 'history.jsonl'),
    replay_log_path: path.join(stateDir, 'replay_log.jsonl'),
    exports_path: path.join(stateDir, 'archetype_exports.jsonl'),
    imports_path: path.join(stateDir, 'archetype_imports.jsonl'),
    exchange_dir: path.join(stateDir, 'exchange')
  };
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    compaction: {
      source_paths: [
        'state/autonomy/weaver/history.jsonl',
        'state/autonomy/mirror_organ/history.jsonl',
        'state/workflow/learning_conduit/receipts.jsonl'
      ],
      max_source_rows_per_path: 5000
    },
    stale_pruning: {
      enabled: true,
      max_age_days: 180,
      min_hits_keep: 2
    },
    federation: {
      enabled: true,
      opt_in_required: true,
      attestation_required: true,
      local_instance_id: 'local_instance'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const compaction = raw.compaction && typeof raw.compaction === 'object' ? raw.compaction : {};
  const pruning = raw.stale_pruning && typeof raw.stale_pruning === 'object' ? raw.stale_pruning : {};
  const federation = raw.federation && typeof raw.federation === 'object' ? raw.federation : {};
  const sourcePaths = Array.isArray(compaction.source_paths)
    ? compaction.source_paths.map((row: unknown) => cleanText(row, 320)).filter(Boolean)
    : base.compaction.source_paths;
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    compaction: {
      source_paths: sourcePaths.length ? sourcePaths : base.compaction.source_paths,
      max_source_rows_per_path: clampInt(
        compaction.max_source_rows_per_path,
        10,
        200000,
        base.compaction.max_source_rows_per_path
      )
    },
    stale_pruning: {
      enabled: pruning.enabled !== false,
      max_age_days: clampInt(pruning.max_age_days, 1, 3650, base.stale_pruning.max_age_days),
      min_hits_keep: clampInt(pruning.min_hits_keep, 1, 500, base.stale_pruning.min_hits_keep)
    },
    federation: {
      enabled: federation.enabled !== false,
      opt_in_required: federation.opt_in_required !== false,
      attestation_required: federation.attestation_required !== false,
      local_instance_id: normalizeToken(
        federation.local_instance_id || base.federation.local_instance_id,
        120
      ) || base.federation.local_instance_id
    }
  };
}

function resolveSourcePath(raw: string) {
  const txt = cleanText(raw, 320);
  if (!txt) return null;
  if (path.isAbsolute(txt)) return txt;
  return path.join(ROOT, txt);
}

function loadSourceRows(filePath: string, maxRows: number) {
  if (!fs.existsSync(filePath)) return [];
  if (filePath.endsWith('.jsonl')) {
    return readJsonl(filePath).slice(-maxRows);
  }
  const payload = readJson(filePath, null);
  if (Array.isArray(payload)) return payload.slice(-maxRows);
  if (payload && typeof payload === 'object') return [payload];
  return [];
}

function rowToArchetype(raw: AnyObj, sourcePath: string) {
  const ts = cleanText(raw.ts || nowIso(), 64) || nowIso();
  const metricId = normalizeToken(raw.primary_metric_id || raw.metric_id || '', 120) || null;
  const objectiveId = normalizeToken(raw.objective_id || '', 160) || null;
  const valueCurrency = normalizeToken(raw.value_currency || '', 120) || null;
  const reason = cleanText(
    (Array.isArray(raw.reason_codes) ? raw.reason_codes.join(',') : raw.reason_codes)
    || raw.reason
    || raw.type
    || 'signal',
    280
  ) || 'signal';
  const score = clampNumber(
    raw.top_share != null ? raw.top_share : (raw.share != null ? raw.share : raw.mirror_pressure),
    -1,
    1,
    0
  );
  const keyBase = `${objectiveId || 'none'}|${metricId || 'none'}|${valueCurrency || 'none'}|${reason}`;
  return {
    archetype_id: `arc_${sha16(keyBase)}`,
    ts,
    objective_id: objectiveId,
    metric_id: metricId,
    value_currency: valueCurrency,
    reason,
    score: Number(score.toFixed(6)),
    source_path: relPath(sourcePath)
  };
}

function buildDistilledArchetypes(policy: AnyObj) {
  const rows: AnyObj[] = [];
  for (const source of policy.compaction.source_paths) {
    const abs = resolveSourcePath(source);
    if (!abs || !fs.existsSync(abs)) continue;
    const loaded = loadSourceRows(abs, Number(policy.compaction.max_source_rows_per_path || 5000));
    for (const row of loaded) {
      if (!row || typeof row !== 'object') continue;
      rows.push(rowToArchetype(row, abs));
    }
  }
  const byId: Record<string, AnyObj> = {};
  for (const row of rows) {
    const id = String(row.archetype_id || '');
    if (!id) continue;
    const prev = byId[id];
    if (!prev) {
      byId[id] = {
        ...row,
        hits: 1,
        last_seen_ts: row.ts
      };
      continue;
    }
    const prevTs = parseIsoMs(prev.last_seen_ts || prev.ts) || 0;
    const nextTs = parseIsoMs(row.ts) || 0;
    byId[id] = {
      ...prev,
      hits: Number(prev.hits || 1) + 1,
      score: Number((((Number(prev.score || 0) * Number(prev.hits || 1)) + Number(row.score || 0))
        / (Number(prev.hits || 1) + 1)).toFixed(6)),
      last_seen_ts: nextTs >= prevTs ? row.ts : prev.last_seen_ts
    };
  }
  return Object.values(byId).sort((a, b) => {
    const tsA = parseIsoMs(a.last_seen_ts || a.ts) || 0;
    const tsB = parseIsoMs(b.last_seen_ts || b.ts) || 0;
    if (tsA !== tsB) return tsB - tsA;
    return String(a.archetype_id || '').localeCompare(String(b.archetype_id || ''));
  });
}

function pruneStale(entries: AnyObj[], policy: AnyObj, nowMs = Date.now()) {
  if (!(policy.stale_pruning && policy.stale_pruning.enabled === true)) {
    return {
      kept: entries,
      pruned: []
    };
  }
  const cutoff = nowMs - (Number(policy.stale_pruning.max_age_days || 180) * 24 * 60 * 60 * 1000);
  const minHits = Number(policy.stale_pruning.min_hits_keep || 2);
  const kept: AnyObj[] = [];
  const pruned: AnyObj[] = [];
  for (const row of entries) {
    const seen = parseIsoMs(row.last_seen_ts || row.ts) || 0;
    const hits = Number(row.hits || 0);
    if (seen < cutoff && hits < minHits) pruned.push(row);
    else kept.push(row);
  }
  return { kept, pruned };
}

function loadState(filePath: string) {
  const src = readJson(filePath, null);
  if (!src || typeof src !== 'object') {
    return {
      schema_id: 'memory_federation_state',
      schema_version: '1.0',
      updated_at: nowIso(),
      local_archetypes: [],
      imported_archetypes: []
    };
  }
  return {
    schema_id: 'memory_federation_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 64),
    local_archetypes: Array.isArray(src.local_archetypes) ? src.local_archetypes : [],
    imported_archetypes: Array.isArray(src.imported_archetypes) ? src.imported_archetypes : []
  };
}

function saveState(filePath: string, state: AnyObj) {
  writeJsonAtomic(filePath, {
    schema_id: 'memory_federation_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    local_archetypes: Array.isArray(state.local_archetypes) ? state.local_archetypes : [],
    imported_archetypes: Array.isArray(state.imported_archetypes) ? state.imported_archetypes : []
  });
}

function cmdDistill(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.MEMORY_FEDERATION_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath);
  if (policy.enabled !== true) {
    return {
      ok: false,
      type: 'memory_federation_distill',
      error: 'policy_disabled'
    };
  }
  const apply = toBool(args.apply, true);
  const runId = `mfd_${sha16(`${nowIso()}|${Math.random()}`)}`;
  const built = buildDistilledArchetypes(policy);
  const pruned = pruneStale(built, policy, Date.now());
  const replayHash = sha16(stableStringify(pruned.kept));
  const payload = {
    ok: true,
    type: 'memory_federation_distill',
    ts: nowIso(),
    run_id: runId,
    apply,
    replay_hash: replayHash,
    built_count: built.length,
    kept_count: pruned.kept.length,
    pruned_count: pruned.pruned.length,
    deterministic_replay: true,
    stale_pruning: {
      enabled: policy.stale_pruning.enabled === true,
      max_age_days: Number(policy.stale_pruning.max_age_days || 0),
      min_hits_keep: Number(policy.stale_pruning.min_hits_keep || 0)
    }
  };
  if (apply) {
    const state = loadState(paths.state_path);
    state.local_archetypes = pruned.kept;
    saveState(paths.state_path, state);
    writeJsonAtomic(paths.distilled_latest_path, {
      ts: payload.ts,
      run_id: runId,
      replay_hash: replayHash,
      archetypes: pruned.kept
    });
    appendJsonl(paths.history_path, payload);
    appendJsonl(paths.replay_log_path, {
      ts: payload.ts,
      run_id: runId,
      replay_hash: replayHash,
      archetype_ids: pruned.kept.map((row: AnyObj) => row.archetype_id).slice(0, 500)
    });
  }
  writeJsonAtomic(paths.latest_path, payload);
  return payload;
}

function loadExchangePackage(filePath: string) {
  const payload = readJson(filePath, null);
  if (!payload || typeof payload !== 'object') return null;
  const archetypes = Array.isArray(payload.archetypes) ? payload.archetypes : [];
  return {
    schema_id: cleanText(payload.schema_id || '', 80),
    instance_id: normalizeToken(payload.instance_id || '', 120),
    attestation: cleanText(payload.attestation || '', 200),
    replay_hash: cleanText(payload.replay_hash || '', 80),
    archetypes
  };
}

function cmdExport(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.MEMORY_FEDERATION_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath);
  const state = loadState(paths.state_path);
  const optIn = toBool(args['opt-in'] || args.opt_in, false);
  if (policy.federation.enabled !== true) {
    return { ok: false, type: 'memory_federation_export', error: 'federation_disabled' };
  }
  if (policy.federation.opt_in_required === true && optIn !== true) {
    return { ok: false, type: 'memory_federation_export', error: 'opt_in_required' };
  }
  const instanceId = normalizeToken(args['instance-id'] || args.instance_id || policy.federation.local_instance_id, 120)
    || policy.federation.local_instance_id;
  const archetypes = Array.isArray(state.local_archetypes) ? state.local_archetypes.slice(0, 500) : [];
  const replayHash = sha16(stableStringify(archetypes));
  const attestation = cleanText(args.attestation || '', 200) || `att_${sha16(`${instanceId}|${replayHash}`)}`;
  const payload = {
    schema_id: 'memory_federation_exchange',
    schema_version: '1.0',
    ts: nowIso(),
    instance_id: instanceId,
    replay_hash: replayHash,
    attestation,
    archetypes
  };
  ensureDir(paths.exchange_dir);
  const outPath = path.join(paths.exchange_dir, `${instanceId}-${Date.now()}.json`);
  writeJsonAtomic(outPath, payload);
  appendJsonl(paths.exports_path, {
    ts: nowIso(),
    type: 'memory_federation_export',
    instance_id: instanceId,
    replay_hash: replayHash,
    attestation,
    path: relPath(outPath),
    archetypes_count: archetypes.length
  });
  writeJsonAtomic(paths.latest_path, {
    ok: true,
    type: 'memory_federation_export',
    ts: nowIso(),
    instance_id: instanceId,
    replay_hash: replayHash,
    path: relPath(outPath),
    archetypes_count: archetypes.length
  });
  return {
    ok: true,
    type: 'memory_federation_export',
    path: relPath(outPath),
    replay_hash: replayHash,
    archetypes_count: archetypes.length
  };
}

function cmdImport(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.MEMORY_FEDERATION_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath);
  const optIn = toBool(args['opt-in'] || args.opt_in, false);
  if (policy.federation.enabled !== true) {
    return { ok: false, type: 'memory_federation_import', error: 'federation_disabled' };
  }
  if (policy.federation.opt_in_required === true && optIn !== true) {
    return {
      ok: true,
      type: 'memory_federation_import',
      imported: 0,
      fallback_local_only: true,
      reason: 'opt_in_required'
    };
  }
  const filePathRaw = cleanText(args.file || '', 360);
  if (!filePathRaw) {
    return { ok: false, type: 'memory_federation_import', error: 'file_required' };
  }
  const filePath = path.isAbsolute(filePathRaw) ? filePathRaw : path.join(ROOT, filePathRaw);
  const pkg = loadExchangePackage(filePath);
  if (!pkg) {
    return { ok: false, type: 'memory_federation_import', error: 'invalid_package' };
  }
  const expectedReplayHash = sha16(stableStringify(pkg.archetypes));
  const attestationInput = cleanText(args.attestation || pkg.attestation || '', 200);
  const attestationOk = policy.federation.attestation_required !== true
    ? true
    : (attestationInput.length > 0 && attestationInput === pkg.attestation && expectedReplayHash === pkg.replay_hash);
  if (!attestationOk) {
    appendJsonl(paths.imports_path, {
      ts: nowIso(),
      type: 'memory_federation_import',
      path: relPath(filePath),
      imported: 0,
      fallback_local_only: true,
      reason: 'attestation_failed'
    });
    return {
      ok: true,
      type: 'memory_federation_import',
      imported: 0,
      fallback_local_only: true,
      reason: 'attestation_failed'
    };
  }
  const state = loadState(paths.state_path);
  const existing = new Set((Array.isArray(state.imported_archetypes) ? state.imported_archetypes : [])
    .map((row: AnyObj) => String(row.archetype_id || '')));
  const imported: AnyObj[] = [];
  for (const row of pkg.archetypes) {
    const archetype = row && typeof row === 'object' ? row : {};
    const id = normalizeToken(archetype.archetype_id || '', 120);
    if (!id || existing.has(id)) continue;
    existing.add(id);
    imported.push({
      ...archetype,
      imported_ts: nowIso(),
      source_instance_id: pkg.instance_id
    });
  }
  state.imported_archetypes = (Array.isArray(state.imported_archetypes) ? state.imported_archetypes : []).concat(imported);
  saveState(paths.state_path, state);
  appendJsonl(paths.imports_path, {
    ts: nowIso(),
    type: 'memory_federation_import',
    path: relPath(filePath),
    source_instance_id: pkg.instance_id,
    imported: imported.length,
    replay_hash: pkg.replay_hash
  });
  writeJsonAtomic(paths.latest_path, {
    ok: true,
    type: 'memory_federation_import',
    ts: nowIso(),
    source_instance_id: pkg.instance_id,
    imported: imported.length,
    fallback_local_only: false
  });
  return {
    ok: true,
    type: 'memory_federation_import',
    imported: imported.length,
    fallback_local_only: false
  };
}

function cmdStatus(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.MEMORY_FEDERATION_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath);
  const state = loadState(paths.state_path);
  return {
    ok: true,
    type: 'memory_federation_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      path: relPath(policyPath)
    },
    counts: {
      local_archetypes: Array.isArray(state.local_archetypes) ? state.local_archetypes.length : 0,
      imported_archetypes: Array.isArray(state.imported_archetypes) ? state.imported_archetypes.length : 0
    },
    paths: {
      latest_path: relPath(paths.latest_path),
      state_path: relPath(paths.state_path),
      history_path: relPath(paths.history_path),
      exchange_dir: relPath(paths.exchange_dir)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/memory_federation_plane.js distill [--apply=1|0]');
  console.log('  node systems/memory/memory_federation_plane.js export --instance-id=<id> --opt-in=1 [--attestation=<token>]');
  console.log('  node systems/memory/memory_federation_plane.js import --file=<path> --opt-in=1 [--attestation=<token>]');
  console.log('  node systems/memory/memory_federation_plane.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  let out: AnyObj;
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'distill') out = cmdDistill(args);
  else if (cmd === 'export') out = cmdExport(args);
  else if (cmd === 'import') out = cmdImport(args);
  else if (cmd === 'status') out = cmdStatus(args);
  else {
    usage();
    process.exit(2);
    return;
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  cmdDistill,
  cmdExport,
  cmdImport,
  cmdStatus
};

