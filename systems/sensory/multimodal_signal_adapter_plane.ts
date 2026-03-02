#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-085
 * Multimodal Signal Adapter Plane (non-text features).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.MULTIMODAL_SIGNAL_ADAPTER_POLICY_PATH
  ? path.resolve(process.env.MULTIMODAL_SIGNAL_ADAPTER_POLICY_PATH)
  : path.join(ROOT, 'config', 'multimodal_signal_adapter_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseArgs(argv: string[]) {
  const out: Record<string, any> = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function stableHash(v: unknown, len = 18) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    max_feature_weight: 0.35,
    default_source_weight: 0.2,
    source_weights: {
      repo_activity: 0.24,
      image_signal: 0.18,
      market_micro: 0.22
    },
    required_sources: ['repo_activity'],
    paths: {
      repo_activity_dir: 'state/sensory/non_text/repo_activity',
      image_signal_dir: 'state/sensory/non_text/image_signal',
      market_micro_dir: 'state/sensory/non_text/market_micro',
      output_dir: 'state/sensory/analysis/multimodal_adapter',
      latest_path: 'state/sensory/analysis/multimodal_adapter/latest.json',
      receipts_path: 'state/sensory/analysis/multimodal_adapter/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const weights = raw.source_weights && typeof raw.source_weights === 'object' ? raw.source_weights : {};
  const sourceWeights = {
    repo_activity: clampNumber(weights.repo_activity, 0, 1, base.source_weights.repo_activity),
    image_signal: clampNumber(weights.image_signal, 0, 1, base.source_weights.image_signal),
    market_micro: clampNumber(weights.market_micro, 0, 1, base.source_weights.market_micro)
  };
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    max_feature_weight: clampNumber(raw.max_feature_weight, 0.01, 1, base.max_feature_weight),
    default_source_weight: clampNumber(raw.default_source_weight, 0, 1, base.default_source_weight),
    source_weights: sourceWeights,
    required_sources: Array.isArray(raw.required_sources)
      ? raw.required_sources.map((row: any) => normalizeToken(row, 80)).filter(Boolean)
      : base.required_sources,
    paths: {
      repo_activity_dir: resolvePath(paths.repo_activity_dir, base.paths.repo_activity_dir),
      image_signal_dir: resolvePath(paths.image_signal_dir, base.paths.image_signal_dir),
      market_micro_dir: resolvePath(paths.market_micro_dir, base.paths.market_micro_dir),
      output_dir: resolvePath(paths.output_dir, base.paths.output_dir),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function readSource(dirPath: string, dateStr: string, fallbackType: string) {
  const fp = path.join(dirPath, `${dateStr}.json`);
  const payload = readJson(fp, null);
  const features = payload && Array.isArray(payload.features) ? payload.features : [];
  return {
    file_path: fp,
    source_type: cleanText(payload && payload.source_type || fallbackType, 80) || fallbackType,
    source_id: cleanText(payload && payload.source_id || fallbackType, 120) || fallbackType,
    features: features.filter((row: any) => row && typeof row === 'object')
  };
}

function adaptRows(source: Record<string, any>, sourceWeight: number, maxFeatureWeight: number) {
  const rows = [];
  for (const feature of source.features || []) {
    const key = normalizeToken(feature && feature.key || feature && feature.feature || '', 120);
    if (!key) continue;
    const signal = clampNumber(feature && feature.signal, -1, 1, 0);
    const confidence = clampNumber(feature && feature.confidence, 0, 1, 0.5);
    const weight = clampNumber(feature && feature.weight, 0, maxFeatureWeight, sourceWeight);
    const boundedInfluence = clampNumber(signal * confidence * weight, -maxFeatureWeight, maxFeatureWeight, 0);
    rows.push({
      feature_id: `mmf_${stableHash(`${source.source_id}|${key}|${signal}|${confidence}`, 20)}`,
      source_type: cleanText(source.source_type, 80),
      source_id: cleanText(source.source_id, 120),
      key,
      signal: Number(signal.toFixed(6)),
      confidence: Number(confidence.toFixed(6)),
      weight: Number(weight.toFixed(6)),
      bounded_influence: Number(boundedInfluence.toFixed(6)),
      observed_at: cleanText(feature && (feature.observed_at || feature.ts || feature.date) || nowIso(), 80)
    });
  }
  return rows;
}

function run(dateStr: string, policy: Record<string, any>, strict = false) {
  const repo = readSource(policy.paths.repo_activity_dir, dateStr, 'repo_activity');
  const image = readSource(policy.paths.image_signal_dir, dateStr, 'image_signal');
  const market = readSource(policy.paths.market_micro_dir, dateStr, 'market_micro');

  const rows = [
    ...adaptRows(repo, Number(policy.source_weights.repo_activity || policy.default_source_weight), Number(policy.max_feature_weight || 0.35)),
    ...adaptRows(image, Number(policy.source_weights.image_signal || policy.default_source_weight), Number(policy.max_feature_weight || 0.35)),
    ...adaptRows(market, Number(policy.source_weights.market_micro || policy.default_source_weight), Number(policy.max_feature_weight || 0.35))
  ];

  const bySource = rows.reduce((acc: Record<string, number>, row: Record<string, any>) => {
    const key = cleanText(row.source_type || 'unknown', 80) || 'unknown';
    acc[key] = Number(acc[key] || 0) + 1;
    return acc;
  }, {});

  const presentSources = new Set(Object.keys(bySource));
  const missingRequired = (policy.required_sources || []).filter((src: string) => !presentSources.has(cleanText(src, 80)));
  const influenceAbs = rows.reduce((sum: number, row: Record<string, any>) => sum + Math.abs(Number(row.bounded_influence || 0)), 0);
  const influenceAvg = rows.length > 0 ? influenceAbs / rows.length : 0;

  const out = {
    ok: missingRequired.length === 0,
    type: 'multimodal_signal_adapter_plane',
    ts: nowIso(),
    date: dateStr,
    source_inputs: {
      repo_activity_path: repo.file_path,
      image_signal_path: image.file_path,
      market_micro_path: market.file_path
    },
    feature_count: rows.length,
    source_counts: bySource,
    bounded_influence_abs_avg: Number(influenceAvg.toFixed(6)),
    missing_required_sources: missingRequired,
    adapters: rows
  };

  ensureDir(policy.paths.output_dir);
  writeJsonAtomic(path.join(policy.paths.output_dir, `${dateStr}.json`), out);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, {
    ts: nowIso(),
    type: 'multimodal_signal_adapter_receipt',
    date: dateStr,
    feature_count: rows.length,
    source_counts: bySource,
    bounded_influence_abs_avg: out.bounded_influence_abs_avg,
    missing_required_sources: missingRequired
  });

  if (strict && !out.ok) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function status(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.output_dir, `${dateStr}.json`);
  const payload = readJson(fp, {
    ok: true,
    type: 'multimodal_signal_adapter_plane_status',
    date: dateStr,
    feature_count: 0
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usageAndExit(code = 0) {
  console.log('Usage:');
  console.log('  node systems/sensory/multimodal_signal_adapter_plane.js run [YYYY-MM-DD] [--strict=1] [--policy=<path>]');
  console.log('  node systems/sensory/multimodal_signal_adapter_plane.js status [YYYY-MM-DD] [--policy=<path>]');
  process.exit(code);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'status', 40).toLowerCase() || 'status';
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(args._[1] || '')) ? String(args._[1]) : todayStr();
  const strict = toBool(args.strict, false);
  const policy = loadPolicy(args.policy ? String(args.policy) : undefined);
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'policy_disabled' }, null, 2)}\n`);
    process.exit(2);
  }
  if (cmd === 'run') return run(dateStr, policy, strict);
  if (cmd === 'status') return status(policy, dateStr);
  return usageAndExit(2);
}

module.exports = {
  run
};

if (require.main === module) {
  main();
}
