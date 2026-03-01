#!/usr/bin/env node
'use strict';
export {};

/**
 * benchmark_autonomy_gate.js
 *
 * Implements V3-AEX-001..004 benchmark-gated autonomous execution policy.
 */

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
  readJsonl,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  rollingAverage,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.BENCHMARK_AUTONOMY_POLICY_PATH
  ? path.resolve(process.env.BENCHMARK_AUTONOMY_POLICY_PATH)
  : path.join(ROOT, 'config', 'benchmark_autonomy_gate_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/benchmark_autonomy_gate.js run [--strict=1] [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/ops/benchmark_autonomy_gate.js evaluate --id=<backlog_id> [--policy=<path>]');
  console.log('  node systems/ops/benchmark_autonomy_gate.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    strict_default: true,
    thresholds: {
      min_window_samples: 10,
      min_window_days: 7,
      min_quality_score: 0.9,
      max_regressions: 0,
      min_integrity_coverage: 0.98
    },
    paths: {
      state_root: 'state/ops/benchmark_autonomy_gate',
      latest_path: 'state/ops/benchmark_autonomy_gate/latest.json',
      receipts_path: 'state/ops/benchmark_autonomy_gate/receipts.jsonl',
      benchmark_history_path: 'state/ops/public_benchmark_pack/results.jsonl',
      autonomy_queue_path: 'state/ops/benchmark_autonomy_gate/backlog_queue.json',
      metadata_contract_path: 'state/ops/benchmark_autonomy_gate/backlog_metadata.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const th = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    strict_default: toBool(raw.strict_default, base.strict_default),
    thresholds: {
      min_window_samples: clampInt(th.min_window_samples, 1, 100000, base.thresholds.min_window_samples),
      min_window_days: clampInt(th.min_window_days, 1, 365, base.thresholds.min_window_days),
      min_quality_score: clampNumber(th.min_quality_score, 0, 1, base.thresholds.min_quality_score),
      max_regressions: clampInt(th.max_regressions, 0, 100000, base.thresholds.max_regressions),
      min_integrity_coverage: clampNumber(th.min_integrity_coverage, 0, 1, base.thresholds.min_integrity_coverage)
    },
    paths: {
      state_root: resolvePath(paths.state_root, base.paths.state_root),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      benchmark_history_path: resolvePath(paths.benchmark_history_path, base.paths.benchmark_history_path),
      autonomy_queue_path: resolvePath(paths.autonomy_queue_path, base.paths.autonomy_queue_path),
      metadata_contract_path: resolvePath(paths.metadata_contract_path, base.paths.metadata_contract_path)
    }
  };
}

function evaluateEligibility(id, policy) {
  const rows = readJsonl(policy.paths.benchmark_history_path);
  const cutoff = Date.now() - policy.thresholds.min_window_days * 24 * 60 * 60 * 1000;
  const window = rows.filter((row: any) => {
    const ts = Date.parse(String(row.ts || row.time || ''));
    return Number.isFinite(ts) && ts >= cutoff;
  });

  const qualityScores = window.map((row: any) => clampNumber(row.quality_score || row.score || 0, 0, 1, 0));
  const avgQuality = rollingAverage(qualityScores) || 0;
  const regressions = window.filter((row: any) => toBool(row.regression, false)).length;

  const integrityHits = window.filter((row: any) => {
    const expected = stableHash(JSON.stringify(row.metrics || row.result || {}), 16);
    return cleanText(row.signature || '', 80).startsWith(expected);
  }).length;
  const integrityCoverage = window.length > 0 ? Number((integrityHits / window.length).toFixed(6)) : 0;

  const metadata = readJson(policy.paths.metadata_contract_path, { items: {} });
  const item = metadata.items && metadata.items[id] ? metadata.items[id] : null;
  const hasMetadata = !!(item && item.id && item.owner && item.risk_tier && item.exit_criteria);

  const eligible = window.length >= policy.thresholds.min_window_samples
    && avgQuality >= policy.thresholds.min_quality_score
    && regressions <= policy.thresholds.max_regressions
    && integrityCoverage >= policy.thresholds.min_integrity_coverage
    && hasMetadata;

  return {
    backlog_id: id,
    eligible,
    window_samples: window.length,
    avg_quality_score: avgQuality,
    regressions,
    integrity_coverage: integrityCoverage,
    has_metadata_contract: hasMetadata,
    reason_code: eligible ? 'stable_window_pass' : 'stable_window_block'
  };
}

function runGate(args, policy) {
  const strict = args.strict != null ? toBool(args.strict, false) : policy.strict_default;
  const apply = toBool(args.apply, false);

  const queue = readJson(policy.paths.autonomy_queue_path, { ids: [] });
  const ids = Array.isArray(queue.ids) ? queue.ids.map((v: unknown) => cleanText(v, 80)).filter(Boolean) : [];
  const evaluations = ids.map((id: string) => evaluateEligibility(id, policy));

  const eligible = evaluations.filter((row: any) => row.eligible).map((row: any) => row.backlog_id);
  const blocked = evaluations.filter((row: any) => !row.eligible).map((row: any) => row.backlog_id);

  if (apply) {
    writeJsonAtomic(policy.paths.autonomy_queue_path, {
      schema_version: '1.0',
      updated_at: nowIso(),
      ids: blocked,
      executed_ids: eligible
    });
  }

  const out = {
    ts: nowIso(),
    type: 'benchmark_autonomy_gate_run',
    ok: strict ? blocked.length === 0 : true,
    strict,
    shadow_only: policy.shadow_only,
    apply,
    eligible_count: eligible.length,
    blocked_count: blocked.length,
    eligible,
    blocked,
    evaluations
  };

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function evaluateSingle(args, policy) {
  const id = cleanText(args.id || '', 80);
  if (!id) return { ok: false, error: 'missing_backlog_id' };
  const out = {
    ts: nowIso(),
    type: 'benchmark_autonomy_gate_evaluate',
    ok: true,
    shadow_only: policy.shadow_only,
    ...evaluateEligibility(id, policy)
  };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function status(policy) {
  return {
    ok: true,
    type: 'benchmark_autonomy_gate_status',
    latest: readJson(policy.paths.latest_path, {}),
    shadow_only: policy.shadow_only
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
  if (!policy.enabled) emit({ ok: false, error: 'benchmark_autonomy_gate_disabled' }, 1);

  if (cmd === 'run') emit(runGate(args, policy));
  if (cmd === 'evaluate') emit(evaluateSingle(args, policy));
  if (cmd === 'status') emit(status(policy));

  usage();
  process.exit(1);
}

main();
