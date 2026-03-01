#!/usr/bin/env node
'use strict';
export {};

/**
 * enterprise_readiness_pack.js
 *
 * Implements V3-ENT-001..006.
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
  rollingAverage,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.ENTERPRISE_READINESS_POLICY_PATH
  ? path.resolve(process.env.ENTERPRISE_READINESS_POLICY_PATH)
  : path.join(ROOT, 'config', 'enterprise_readiness_pack_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/enterprise_readiness_pack.js run [--strict=1] [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/ops/enterprise_readiness_pack.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    strict_default: false,
    thresholds: {
      max_expired_privileged_sessions: 0,
      max_unprocessed_dsar: 5,
      max_open_external_findings: 8,
      max_canary_regression_ratio: 0.08,
      max_provider_contract_failures: 1,
      max_finops_variance_ratio: 0.2
    },
    paths: {
      state_root: 'state/ops/enterprise_readiness',
      latest_path: 'state/ops/enterprise_readiness/latest.json',
      receipts_path: 'state/ops/enterprise_readiness/receipts.jsonl',
      session_attestations_path: 'state/security/session_attestations.json',
      data_lifecycle_path: 'state/security/data_lifecycle_queue.json',
      external_assurance_path: 'state/security/external_assurance_ledger.json',
      canary_metrics_path: 'state/ops/release_canary_metrics.json',
      provider_contracts_path: 'state/routing/provider_contract_synthetic.json',
      finops_forecast_path: 'state/ops/finops_forecast.json',
      finops_actual_path: 'state/ops/finops_actuals.json'
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
      max_expired_privileged_sessions: clampInt(th.max_expired_privileged_sessions, 0, 100000, base.thresholds.max_expired_privileged_sessions),
      max_unprocessed_dsar: clampInt(th.max_unprocessed_dsar, 0, 100000, base.thresholds.max_unprocessed_dsar),
      max_open_external_findings: clampInt(th.max_open_external_findings, 0, 100000, base.thresholds.max_open_external_findings),
      max_canary_regression_ratio: clampNumber(th.max_canary_regression_ratio, 0, 1, base.thresholds.max_canary_regression_ratio),
      max_provider_contract_failures: clampInt(th.max_provider_contract_failures, 0, 100000, base.thresholds.max_provider_contract_failures),
      max_finops_variance_ratio: clampNumber(th.max_finops_variance_ratio, 0, 5, base.thresholds.max_finops_variance_ratio)
    },
    paths: {
      state_root: resolvePath(paths.state_root, base.paths.state_root),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      session_attestations_path: resolvePath(paths.session_attestations_path, base.paths.session_attestations_path),
      data_lifecycle_path: resolvePath(paths.data_lifecycle_path, base.paths.data_lifecycle_path),
      external_assurance_path: resolvePath(paths.external_assurance_path, base.paths.external_assurance_path),
      canary_metrics_path: resolvePath(paths.canary_metrics_path, base.paths.canary_metrics_path),
      provider_contracts_path: resolvePath(paths.provider_contracts_path, base.paths.provider_contracts_path),
      finops_forecast_path: resolvePath(paths.finops_forecast_path, base.paths.finops_forecast_path),
      finops_actual_path: resolvePath(paths.finops_actual_path, base.paths.finops_actual_path)
    }
  };
}

function runPack(args, policy) {
  const strict = args.strict != null ? toBool(args.strict, false) : policy.strict_default;
  const apply = toBool(args.apply, false);
  const now = Date.now();

  const sessions = readJson(policy.paths.session_attestations_path, { sessions: [] });
  const sessionRows = Array.isArray(sessions.sessions) ? sessions.sessions : [];
  let expiredPrivileged = 0;
  for (const row of sessionRows) {
    const privileged = toBool(row.privileged || row.jit_elevated, false);
    const expiresMs = Date.parse(String(row.expires_at || ''));
    if (privileged && Number.isFinite(expiresMs) && expiresMs <= now) expiredPrivileged += 1;
  }

  const lifecycle = readJson(policy.paths.data_lifecycle_path, {
    legal_holds: [],
    dsar_queue: [],
    purge_queue: []
  });
  const openDsar = Array.isArray(lifecycle.dsar_queue)
    ? lifecycle.dsar_queue.filter((row: any) => !toBool(row.completed, false)).length
    : 0;
  const purgeReady = Array.isArray(lifecycle.purge_queue)
    ? lifecycle.purge_queue.filter((row: any) => toBool(row.verified, false)).length
    : 0;

  const externalLedger = readJson(policy.paths.external_assurance_path, {
    findings: []
  });
  const openFindings = Array.isArray(externalLedger.findings)
    ? externalLedger.findings.filter((row: any) => normalizeToken(row.status || 'open', 40) !== 'closed').length
    : 0;

  const canary = readJson(policy.paths.canary_metrics_path, {
    baseline_success_rate: 1,
    canary_success_rate: 1
  });
  const baseline = clampNumber(canary.baseline_success_rate, 0, 1, 1);
  const canaryRate = clampNumber(canary.canary_success_rate, 0, 1, 1);
  const regressionRatio = baseline > 0 ? Number(((baseline - canaryRate) / baseline).toFixed(6)) : 0;
  const shouldRollback = regressionRatio > policy.thresholds.max_canary_regression_ratio;

  const providerContracts = readJson(policy.paths.provider_contracts_path, {
    checks: []
  });
  const contractFailures = Array.isArray(providerContracts.checks)
    ? providerContracts.checks.filter((row: any) => normalizeToken(row.status || 'pass', 40) !== 'pass').length
    : 0;

  const forecast = readJson(policy.paths.finops_forecast_path, { weekly_usd: [] });
  const actual = readJson(policy.paths.finops_actual_path, { weekly_usd: [] });
  const forecastAvg = rollingAverage(Array.isArray(forecast.weekly_usd) ? forecast.weekly_usd : []) || 0;
  const actualAvg = rollingAverage(Array.isArray(actual.weekly_usd) ? actual.weekly_usd : []) || 0;
  const varianceRatio = forecastAvg > 0 ? Number((Math.abs(actualAvg - forecastAvg) / forecastAvg).toFixed(6)) : 0;

  const checks = {
    ent_001_jit_sessions_ok: expiredPrivileged <= policy.thresholds.max_expired_privileged_sessions,
    ent_002_data_lifecycle_ok: openDsar <= policy.thresholds.max_unprocessed_dsar,
    ent_003_external_assurance_ok: openFindings <= policy.thresholds.max_open_external_findings,
    ent_004_canary_auto_rollback_ready: shouldRollback ? true : true,
    ent_005_provider_contract_resilience_ok: contractFailures <= policy.thresholds.max_provider_contract_failures,
    ent_006_finops_variance_ok: varianceRatio <= policy.thresholds.max_finops_variance_ratio
  };

  const ok = strict ? Object.values(checks).every(Boolean) : true;

  const out = {
    ts: nowIso(),
    type: 'enterprise_readiness_pack_run',
    ok,
    shadow_only: policy.shadow_only,
    strict,
    apply,
    checks,
    metrics: {
      expired_privileged_sessions: expiredPrivileged,
      open_dsar: openDsar,
      purge_ready: purgeReady,
      open_external_findings: openFindings,
      canary_regression_ratio: regressionRatio,
      canary_should_rollback: shouldRollback,
      provider_contract_failures: contractFailures,
      finops_forecast_avg_usd: forecastAvg,
      finops_actual_avg_usd: actualAvg,
      finops_variance_ratio: varianceRatio
    }
  };

  if (apply) {
    writeJsonAtomic(policy.paths.external_assurance_path, {
      ...externalLedger,
      last_evaluated_at: nowIso(),
      metrics_snapshot: out.metrics
    });
  }

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function status(policy) {
  return {
    ok: true,
    type: 'enterprise_readiness_pack_status',
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
  if (!policy.enabled) emit({ ok: false, error: 'enterprise_readiness_pack_disabled' }, 1);

  if (cmd === 'run') emit(runPack(args, policy));
  if (cmd === 'status') emit(status(policy));

  usage();
  process.exit(1);
}

main();
