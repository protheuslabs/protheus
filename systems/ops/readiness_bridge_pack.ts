#!/usr/bin/env node
'use strict';
export {};

/**
 * readiness_bridge_pack.js
 *
 * Implements:
 * - V3-REL-001
 * - V3-OBS-002
 * - V3-BENCH-002
 * - V3-VAL-001
 * - V3-SEC-004
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
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.READINESS_BRIDGE_POLICY_PATH
  ? path.resolve(process.env.READINESS_BRIDGE_POLICY_PATH)
  : path.join(ROOT, 'config', 'readiness_bridge_pack_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/readiness_bridge_pack.js run [--strict=1] [--policy=<path>]');
  console.log('  node systems/ops/readiness_bridge_pack.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    strict_default: true,
    thresholds: {
      min_reliability_days: 90,
      min_trace_coverage: 0.95,
      min_benchmark_signature_coverage: 0.95,
      min_outcome_score: 0.7,
      max_external_security_scan_age_days: 14
    },
    paths: {
      state_root: 'state/ops/readiness_bridge',
      latest_path: 'state/ops/readiness_bridge/latest.json',
      receipts_path: 'state/ops/readiness_bridge/receipts.jsonl',
      health_history_path: 'state/adaptive/autonomy/health_status_history.jsonl',
      thought_trace_path: 'state/observability/thought_action_trace.jsonl',
      benchmark_results_path: 'state/ops/public_benchmark_pack/results.jsonl',
      outcome_scorecard_path: 'state/ops/outcome_scorecard.json',
      external_security_program_path: 'state/security/external_security_program.json'
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
      min_reliability_days: clampInt(th.min_reliability_days, 1, 3650, base.thresholds.min_reliability_days),
      min_trace_coverage: clampNumber(th.min_trace_coverage, 0, 1, base.thresholds.min_trace_coverage),
      min_benchmark_signature_coverage: clampNumber(th.min_benchmark_signature_coverage, 0, 1, base.thresholds.min_benchmark_signature_coverage),
      min_outcome_score: clampNumber(th.min_outcome_score, 0, 1, base.thresholds.min_outcome_score),
      max_external_security_scan_age_days: clampInt(th.max_external_security_scan_age_days, 1, 365, base.thresholds.max_external_security_scan_age_days)
    },
    paths: {
      state_root: resolvePath(paths.state_root, base.paths.state_root),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      health_history_path: resolvePath(paths.health_history_path, base.paths.health_history_path),
      thought_trace_path: resolvePath(paths.thought_trace_path, base.paths.thought_trace_path),
      benchmark_results_path: resolvePath(paths.benchmark_results_path, base.paths.benchmark_results_path),
      outcome_scorecard_path: resolvePath(paths.outcome_scorecard_path, base.paths.outcome_scorecard_path),
      external_security_program_path: resolvePath(paths.external_security_program_path, base.paths.external_security_program_path)
    }
  };
}

function runPack(args, policy) {
  const strict = args.strict != null ? toBool(args.strict, false) : policy.strict_default;

  const healthRows = readJsonl(policy.paths.health_history_path);
  const cutoffMs = Date.now() - policy.thresholds.min_reliability_days * 24 * 60 * 60 * 1000;
  const healthWindow = healthRows.filter((row: any) => {
    const ts = Date.parse(String(row.ts || row.time || ''));
    return Number.isFinite(ts) && ts >= cutoffMs;
  });
  const criticalFailures = healthWindow.filter((row: any) => toBool(row.critical_failure, false)).length;
  const reliabilityOk = healthWindow.length > 0 && criticalFailures === 0;

  const traces = readJsonl(policy.paths.thought_trace_path);
  const traceRows = traces.slice(-2000);
  const traceCoverage = traceRows.length > 0
    ? Number((traceRows.filter((row: any) => row.trace_id && row.request_id && row.run_id).length / traceRows.length).toFixed(6))
    : 0;

  const benchmarkRows = readJsonl(policy.paths.benchmark_results_path).slice(-500);
  const signed = benchmarkRows.filter((row: any) => {
    const expected = stableHash(JSON.stringify(row.result || row.metrics || {}), 16);
    return cleanText(row.signature || '', 64).startsWith(expected);
  }).length;
  const signatureCoverage = benchmarkRows.length > 0 ? Number((signed / benchmarkRows.length).toFixed(6)) : 0;

  const scorecard = readJson(policy.paths.outcome_scorecard_path, {
    score: 0,
    categories: {}
  });
  const outcomeScore = clampNumber(scorecard.score, 0, 1, 0);

  const extSec = readJson(policy.paths.external_security_program_path, {
    last_scan_at: null,
    open_critical_findings: 0
  });
  const lastScanMs = Date.parse(String(extSec.last_scan_at || ''));
  const scanAgeDays = Number.isFinite(lastScanMs)
    ? Number(((Date.now() - lastScanMs) / (24 * 60 * 60 * 1000)).toFixed(6))
    : 9999;
  const externalSecurityFresh = scanAgeDays <= policy.thresholds.max_external_security_scan_age_days;

  const checks = {
    rel_001_reliability_cert_ok: reliabilityOk,
    obs_002_trace_contract_ok: traceCoverage >= policy.thresholds.min_trace_coverage,
    bench_002_independent_verify_ok: signatureCoverage >= policy.thresholds.min_benchmark_signature_coverage,
    val_001_outcome_gate_ok: outcomeScore >= policy.thresholds.min_outcome_score,
    sec_004_external_security_program_ok: externalSecurityFresh && clampInt(extSec.open_critical_findings, 0, 100000, 0) === 0
  };

  const out = {
    ts: nowIso(),
    type: 'readiness_bridge_pack_run',
    ok: strict ? Object.values(checks).every(Boolean) : true,
    strict,
    shadow_only: policy.shadow_only,
    checks,
    metrics: {
      reliability_window_events: healthWindow.length,
      critical_failures: criticalFailures,
      trace_coverage: traceCoverage,
      benchmark_signature_coverage: signatureCoverage,
      outcome_score: outcomeScore,
      external_security_scan_age_days: scanAgeDays,
      open_critical_findings: clampInt(extSec.open_critical_findings, 0, 100000, 0)
    }
  };

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function status(policy) {
  return {
    ok: true,
    type: 'readiness_bridge_pack_status',
    shadow_only: policy.shadow_only,
    latest: readJson(policy.paths.latest_path, {})
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
  if (!policy.enabled) emit({ ok: false, error: 'readiness_bridge_pack_disabled' }, 1);

  if (cmd === 'run') emit(runPack(args, policy));
  if (cmd === 'status') emit(status(policy));

  usage();
  process.exit(1);
}

main();
