#!/usr/bin/env node
'use strict';
export {};

/**
 * post_launch_migration_readiness.js
 *
 * Implements PLM-001..010 as a deterministic readiness gate pack.
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
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.POST_LAUNCH_MIGRATION_READINESS_POLICY_PATH
  ? path.resolve(process.env.POST_LAUNCH_MIGRATION_READINESS_POLICY_PATH)
  : path.join(ROOT, 'config', 'post_launch_migration_readiness_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/post_launch_migration_readiness.js run [--strict=1|0] [--apply=1|0] [--policy=<path>]');
  console.log('  node systems/ops/post_launch_migration_readiness.js final-review --decision=go|no-go --signed-by=<id> --approval-note="..." [--policy=<path>]');
  console.log('  node systems/ops/post_launch_migration_readiness.js status [--strict=1|0] [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    strict_default: false,
    thresholds: {
      stability_days_required: 30,
      guardrail_days_required: 30,
      primitive_coverage_ratio: 0.9,
      parity_days_required: 14,
      max_open_p0: 0,
      max_profile_compat_failures: 0,
      max_js_strict_violations: 0,
      min_workflow_closure_days: 7,
      min_ci_streak_days: 7
    },
    paths: {
      latest_path: 'state/ops/post_launch_migration_readiness/latest.json',
      receipts_path: 'state/ops/post_launch_migration_readiness/receipts.jsonl',
      final_review_path: 'state/ops/post_launch_migration_readiness/final_review.json',
      execution_reliability_path: 'state/ops/execution_reliability_slo.json',
      ci_guard_path: 'state/ops/ci_baseline_guard.json',
      workflow_closure_path: 'state/ops/workflow_execution_closure.json',
      js_holdout_path: 'state/ops/js_holdout_audit/latest.json',
      adapter_defrag_path: 'state/actuation/adapter_defragmentation/latest.json',
      state_kernel_cutover_path: 'state/ops/state_kernel_cutover/latest.json',
      parity_harness_path: 'state/ops/narrow_agent_parity_harness.json',
      profile_compatibility_path: 'state/ops/profile_compatibility_gate/latest.json',
      deployment_packaging_path: 'state/ops/deployment_packaging/latest.json',
      self_hosted_bootstrap_path: 'state/ops/self_hosted_bootstrap/latest.json',
      secret_rotation_attestation_path: 'config/secret_rotation_attestation.json',
      remote_heartbeat_path: 'state/security/remote_tamper_heartbeat/latest.json',
      supply_chain_path: 'state/security/supply_chain/latest.json',
      docs_playbook_path: 'docs/POST_LAUNCH_MIGRATION_READINESS.md',
      rollback_template_path: 'docs/release/templates/rollback_plan.md'
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
      stability_days_required: clampInt(th.stability_days_required, 1, 3650, base.thresholds.stability_days_required),
      guardrail_days_required: clampInt(th.guardrail_days_required, 1, 3650, base.thresholds.guardrail_days_required),
      primitive_coverage_ratio: clampNumber(th.primitive_coverage_ratio, 0, 1, base.thresholds.primitive_coverage_ratio),
      parity_days_required: clampInt(th.parity_days_required, 1, 3650, base.thresholds.parity_days_required),
      max_open_p0: clampInt(th.max_open_p0, 0, 100000, base.thresholds.max_open_p0),
      max_profile_compat_failures: clampInt(th.max_profile_compat_failures, 0, 100000, base.thresholds.max_profile_compat_failures),
      max_js_strict_violations: clampInt(th.max_js_strict_violations, 0, 100000, base.thresholds.max_js_strict_violations),
      min_workflow_closure_days: clampInt(th.min_workflow_closure_days, 0, 3650, base.thresholds.min_workflow_closure_days),
      min_ci_streak_days: clampInt(th.min_ci_streak_days, 0, 3650, base.thresholds.min_ci_streak_days)
    },
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      final_review_path: resolvePath(paths.final_review_path, base.paths.final_review_path),
      execution_reliability_path: resolvePath(paths.execution_reliability_path, base.paths.execution_reliability_path),
      ci_guard_path: resolvePath(paths.ci_guard_path, base.paths.ci_guard_path),
      workflow_closure_path: resolvePath(paths.workflow_closure_path, base.paths.workflow_closure_path),
      js_holdout_path: resolvePath(paths.js_holdout_path, base.paths.js_holdout_path),
      adapter_defrag_path: resolvePath(paths.adapter_defrag_path, base.paths.adapter_defrag_path),
      state_kernel_cutover_path: resolvePath(paths.state_kernel_cutover_path, base.paths.state_kernel_cutover_path),
      parity_harness_path: resolvePath(paths.parity_harness_path, base.paths.parity_harness_path),
      profile_compatibility_path: resolvePath(paths.profile_compatibility_path, base.paths.profile_compatibility_path),
      deployment_packaging_path: resolvePath(paths.deployment_packaging_path, base.paths.deployment_packaging_path),
      self_hosted_bootstrap_path: resolvePath(paths.self_hosted_bootstrap_path, base.paths.self_hosted_bootstrap_path),
      secret_rotation_attestation_path: resolvePath(paths.secret_rotation_attestation_path, base.paths.secret_rotation_attestation_path),
      remote_heartbeat_path: resolvePath(paths.remote_heartbeat_path, base.paths.remote_heartbeat_path),
      supply_chain_path: resolvePath(paths.supply_chain_path, base.paths.supply_chain_path),
      docs_playbook_path: resolvePath(paths.docs_playbook_path, base.paths.docs_playbook_path),
      rollback_template_path: resolvePath(paths.rollback_template_path, base.paths.rollback_template_path)
    }
  };
}

function dateDiffDays(tsRaw, nowMsRaw = Date.parse(nowIso())) {
  const ts = Date.parse(String(tsRaw || ''));
  if (!Number.isFinite(ts)) return null;
  const nowMs = Number.isFinite(nowMsRaw) ? nowMsRaw : Date.parse(nowIso());
  return Number(((nowMs - ts) / (24 * 60 * 60 * 1000)).toFixed(6));
}

function existsReadable(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function evaluate(policy) {
  const nowMs = Date.parse(nowIso());
  const exec = readJson(policy.paths.execution_reliability_path, {});
  const ci = readJson(policy.paths.ci_guard_path, {});
  const closure = readJson(policy.paths.workflow_closure_path, {});
  const jsHoldout = readJson(policy.paths.js_holdout_path, {});
  const defrag = readJson(policy.paths.adapter_defrag_path, {});
  const cutover = readJson(policy.paths.state_kernel_cutover_path, {});
  const parity = readJson(policy.paths.parity_harness_path, {});
  const profileCompat = readJson(policy.paths.profile_compatibility_path, {});
  const packaging = readJson(policy.paths.deployment_packaging_path, {});
  const bootstrap = readJson(policy.paths.self_hosted_bootstrap_path, {});
  const secretRotation = readJson(policy.paths.secret_rotation_attestation_path, {});
  const remoteHeartbeat = readJson(policy.paths.remote_heartbeat_path, {});
  const supplyChain = readJson(policy.paths.supply_chain_path, {});

  const openP0 = clampInt(exec.open_p0_incidents, 0, 100000, 0);
  const stabilityDaysObserved = clampInt(exec.window_days, 0, 3650, 0);
  const workflowClosureDays = clampInt(closure.consecutive_days_passed, 0, 3650, 0);
  const ciStreak = clampInt(ci.streak, 0, 3650, 0);
  const jsStrictViolations = Array.isArray(jsHoldout.strict_violations) ? jsHoldout.strict_violations.length : 0;
  const primitiveCoverage = clampNumber(defrag.profile_ratio, 0, 1, 0);
  const parityAgeDays = dateDiffDays(parity.updated_at || parity.ts, nowMs);
  const profileCompatFailures = Array.isArray(profileCompat.failures) ? profileCompat.failures.length : 0;
  const packagingPass = String(packaging.verdict || '').toLowerCase() === 'pass' || packaging.ok === true;
  const bootstrapVerified = bootstrap && typeof bootstrap === 'object'
    ? (bootstrap.ok === true || bootstrap.verdict === 'pass' || !!bootstrap.active_build_id || !!bootstrap.build_id)
    : false;
  const secretFlags = secretRotation && secretRotation.flags && typeof secretRotation.flags === 'object'
    ? secretRotation.flags
    : {};
  const secretProof = secretFlags.active_keys_rotated === true
    && secretFlags.history_scrub_verified === true
    && secretFlags.secret_manager_migrated === true;
  const heartbeatHealthy = remoteHeartbeat && remoteHeartbeat.anomaly !== true;
  const supplyChainHealthy = supplyChain && (supplyChain.ok === true || supplyChain.strict_ok === true);
  const cutoverParityOk = !!(cutover.evaluation && cutover.evaluation.validation && cutover.evaluation.validation.parity_ok === true);
  const cutoverReplayOk = !!(cutover.evaluation && cutover.evaluation.validation && cutover.evaluation.validation.replay_deterministic === true);
  const cutoverShadowDays = clampInt(cutover.evaluation && cutover.evaluation.shadow_days_elapsed, 0, 3650, 0);
  const playbookExists = existsReadable(policy.paths.docs_playbook_path);
  const rollbackTemplateExists = existsReadable(policy.paths.rollback_template_path);

  const checks = {
    plm_001_operational_stability: exec.pass === true
      && openP0 <= policy.thresholds.max_open_p0
      && stabilityDaysObserved >= policy.thresholds.stability_days_required
      && workflowClosureDays >= policy.thresholds.min_workflow_closure_days,
    plm_002_runtime_guardrails: ci.pass === true
      && ciStreak >= policy.thresholds.min_ci_streak_days,
    plm_003_js_exception_floor: jsStrictViolations <= policy.thresholds.max_js_strict_violations,
    plm_004_primitive_coverage: primitiveCoverage >= policy.thresholds.primitive_coverage_ratio,
    plm_005_state_portability: cutoverParityOk && cutoverReplayOk,
    plm_006_dual_run_parity: parity.parity_pass === true
      && (parityAgeDays != null && parityAgeDays <= policy.thresholds.parity_days_required)
      && profileCompatFailures <= policy.thresholds.max_profile_compat_failures,
    plm_007_cutover_rollback_playbook: playbookExists && rollbackTemplateExists,
    plm_008_bootstrap_packaging_readiness: packagingPass && bootstrapVerified,
    plm_009_security_secrets_migration: secretProof && heartbeatHealthy && supplyChainHealthy,
    plm_010_final_review_present: existsReadable(policy.paths.final_review_path)
  };

  return {
    ts: nowIso(),
    type: 'post_launch_migration_readiness_run',
    shadow_only: policy.shadow_only,
    checks,
    metrics: {
      open_p0_incidents: openP0,
      stability_days_observed: stabilityDaysObserved,
      workflow_closure_days: workflowClosureDays,
      ci_streak_days: ciStreak,
      js_strict_violations: jsStrictViolations,
      primitive_coverage_ratio: primitiveCoverage,
      parity_age_days: parityAgeDays,
      profile_compat_failures: profileCompatFailures,
      state_cutover_shadow_days_elapsed: cutoverShadowDays,
      state_cutover_parity_ok: cutoverParityOk,
      state_cutover_replay_ok: cutoverReplayOk,
      packaging_pass: packagingPass,
      bootstrap_verified: bootstrapVerified,
      secret_flags_ok: secretProof,
      heartbeat_healthy: heartbeatHealthy,
      supply_chain_healthy: supplyChainHealthy,
      playbook_exists: playbookExists,
      rollback_template_exists: rollbackTemplateExists
    },
    paths: {
      execution_reliability_path: path.relative(ROOT, policy.paths.execution_reliability_path).replace(/\\/g, '/'),
      ci_guard_path: path.relative(ROOT, policy.paths.ci_guard_path).replace(/\\/g, '/'),
      workflow_closure_path: path.relative(ROOT, policy.paths.workflow_closure_path).replace(/\\/g, '/'),
      js_holdout_path: path.relative(ROOT, policy.paths.js_holdout_path).replace(/\\/g, '/'),
      adapter_defrag_path: path.relative(ROOT, policy.paths.adapter_defrag_path).replace(/\\/g, '/'),
      state_kernel_cutover_path: path.relative(ROOT, policy.paths.state_kernel_cutover_path).replace(/\\/g, '/'),
      parity_harness_path: path.relative(ROOT, policy.paths.parity_harness_path).replace(/\\/g, '/'),
      profile_compatibility_path: path.relative(ROOT, policy.paths.profile_compatibility_path).replace(/\\/g, '/'),
      deployment_packaging_path: path.relative(ROOT, policy.paths.deployment_packaging_path).replace(/\\/g, '/'),
      self_hosted_bootstrap_path: path.relative(ROOT, policy.paths.self_hosted_bootstrap_path).replace(/\\/g, '/'),
      final_review_path: path.relative(ROOT, policy.paths.final_review_path).replace(/\\/g, '/')
    }
  };
}

function runPack(args, policy) {
  const strict = args.strict != null ? toBool(args.strict, false) : policy.strict_default;
  const apply = toBool(args.apply, false);
  const out = evaluate(policy);
  out.strict = strict;
  out.apply = apply;
  out.ok = strict ? Object.values(out.checks).every(Boolean) : true;
  out.ready = Object.values(out.checks).every(Boolean);

  if (apply) {
    writeJsonAtomic(policy.paths.latest_path, out);
  } else {
    writeJsonAtomic(policy.paths.latest_path, out);
  }
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function finalReview(args, policy) {
  const decisionRaw = normalizeToken(args.decision || '', 16);
  const decision = decisionRaw === 'go' ? 'go' : 'no-go';
  const signedBy = cleanText(args['signed-by'] || args.signed_by || '', 80);
  const approvalNote = cleanText(args['approval-note'] || args.approval_note || '', 400);
  if (!signedBy || !approvalNote) {
    return {
      ok: false,
      type: 'post_launch_migration_final_review',
      error: 'signed_by_and_approval_note_required'
    };
  }

  const evalPayload = evaluate(policy);
  const review = {
    ts: nowIso(),
    type: 'post_launch_migration_final_review',
    decision,
    signed_by: signedBy,
    approval_note: approvalNote,
    checks: evalPayload.checks,
    metrics: evalPayload.metrics,
    go_recommended: Object.values(evalPayload.checks).every(Boolean)
  };
  writeJsonAtomic(policy.paths.final_review_path, review);
  appendJsonl(policy.paths.receipts_path, review);
  writeJsonAtomic(policy.paths.latest_path, {
    ...evalPayload,
    type: 'post_launch_migration_readiness_run',
    strict: false,
    apply: false,
    ok: true,
    ready: Object.values(evalPayload.checks).every(Boolean),
    final_review: {
      decision: review.decision,
      signed_by: review.signed_by,
      ts: review.ts
    }
  });
  return {
    ok: true,
    ...review,
    final_review_path: path.relative(ROOT, policy.paths.final_review_path).replace(/\\/g, '/')
  };
}

function status(args, policy) {
  const strict = args.strict != null ? toBool(args.strict, false) : policy.strict_default;
  const latest = readJson(policy.paths.latest_path, {});
  const finalReviewPayload = readJson(policy.paths.final_review_path, null);
  const payload = {
    ok: true,
    type: 'post_launch_migration_readiness_status',
    shadow_only: policy.shadow_only,
    strict,
    latest,
    final_review: finalReviewPayload
  };
  if (strict && latest && latest.checks && typeof latest.checks === 'object') {
    const pass = Object.values(latest.checks).every(Boolean);
    if (!pass) {
      payload.ok = false;
      payload.error = 'post_launch_migration_checks_failed';
    }
  }
  return payload;
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
  if (!policy.enabled) emit({ ok: false, error: 'post_launch_migration_readiness_disabled' }, 1);

  if (cmd === 'run') emit(runPack(args, policy));
  if (cmd === 'final-review') emit(finalReview(args, policy));
  if (cmd === 'status') {
    const payload = status(args, policy);
    if (payload.ok !== true) emit(payload, 1);
    emit(payload);
  }

  usage();
  process.exit(1);
}

main();
