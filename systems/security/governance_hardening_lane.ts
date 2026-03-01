#!/usr/bin/env node
'use strict';
export {};

/**
 * governance_hardening_lane.js
 *
 * Implements:
 * - V3-GOV-001 Behavior-Based Abuse Containment Envelope
 * - V3-GOV-002 Signed Inherited Policy Chain (Managed Mode)
 */

const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  clampNumber,
  clampInt,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.GOVERNANCE_HARDENING_POLICY_PATH
  ? path.resolve(process.env.GOVERNANCE_HARDENING_POLICY_PATH)
  : path.join(ROOT, 'config', 'governance_hardening_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/governance_hardening_lane.js evaluate --actor=<id> [--evasion=0] [--chains=0] [--anomaly=0] [--trusted=0|1] [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/security/governance_hardening_lane.js bootstrap-child --child=<id> --parent-policy=<path> --parent-signature=<sig> [--policy=<path>]');
  console.log('  node systems/security/governance_hardening_lane.js verify-child --child=<id> [--policy=<path>]');
  console.log('  node systems/security/governance_hardening_lane.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    managed_mode_visible: true,
    trust_tiers: {
      trusted: { min_score: 0.75, envelope: 'normal' },
      watch: { min_score: 0.5, envelope: 'read_only' },
      constrained: { min_score: 0.3, envelope: 'sandbox_only' },
      quarantined: { min_score: 0.0, envelope: 'external_actuation_deny' }
    },
    scoring_weights: {
      evasion_attempts: 0.24,
      high_risk_chains: 0.22,
      anomaly_bursts: 0.2,
      payout_anomalies: 0.14,
      mirror_flags: 0.2
    },
    thresholds: {
      recovery_bonus: 0.08,
      burn_pressure_penalty: 0.06,
      maximum_penalty: 0.75
    },
    paths: {
      state_root: 'state/security/governance_hardening',
      actors_path: 'state/security/governance_hardening/actors.json',
      policy_chain_path: 'state/security/governance_hardening/policy_chain.json',
      latest_path: 'state/security/governance_hardening/latest.json',
      receipts_path: 'state/security/governance_hardening/receipts.jsonl',
      burn_latest_path: 'state/ops/dynamic_burn_budget_oracle/latest.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const scoring = raw.scoring_weights && typeof raw.scoring_weights === 'object' ? raw.scoring_weights : {};
  const tiers = raw.trust_tiers && typeof raw.trust_tiers === 'object' ? raw.trust_tiers : {};
  const th = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    managed_mode_visible: toBool(raw.managed_mode_visible, true),
    trust_tiers: {
      trusted: {
        min_score: clampNumber(tiers.trusted && tiers.trusted.min_score, 0, 1, base.trust_tiers.trusted.min_score),
        envelope: normalizeToken(tiers.trusted && tiers.trusted.envelope, 60) || base.trust_tiers.trusted.envelope
      },
      watch: {
        min_score: clampNumber(tiers.watch && tiers.watch.min_score, 0, 1, base.trust_tiers.watch.min_score),
        envelope: normalizeToken(tiers.watch && tiers.watch.envelope, 60) || base.trust_tiers.watch.envelope
      },
      constrained: {
        min_score: clampNumber(tiers.constrained && tiers.constrained.min_score, 0, 1, base.trust_tiers.constrained.min_score),
        envelope: normalizeToken(tiers.constrained && tiers.constrained.envelope, 60) || base.trust_tiers.constrained.envelope
      },
      quarantined: {
        min_score: clampNumber(tiers.quarantined && tiers.quarantined.min_score, 0, 1, base.trust_tiers.quarantined.min_score),
        envelope: normalizeToken(tiers.quarantined && tiers.quarantined.envelope, 60) || base.trust_tiers.quarantined.envelope
      }
    },
    scoring_weights: {
      evasion_attempts: clampNumber(scoring.evasion_attempts, 0, 1, base.scoring_weights.evasion_attempts),
      high_risk_chains: clampNumber(scoring.high_risk_chains, 0, 1, base.scoring_weights.high_risk_chains),
      anomaly_bursts: clampNumber(scoring.anomaly_bursts, 0, 1, base.scoring_weights.anomaly_bursts),
      payout_anomalies: clampNumber(scoring.payout_anomalies, 0, 1, base.scoring_weights.payout_anomalies),
      mirror_flags: clampNumber(scoring.mirror_flags, 0, 1, base.scoring_weights.mirror_flags)
    },
    thresholds: {
      recovery_bonus: clampNumber(th.recovery_bonus, 0, 1, base.thresholds.recovery_bonus),
      burn_pressure_penalty: clampNumber(th.burn_pressure_penalty, 0, 1, base.thresholds.burn_pressure_penalty),
      maximum_penalty: clampNumber(th.maximum_penalty, 0, 1, base.thresholds.maximum_penalty)
    },
    paths: {
      state_root: resolvePath(paths.state_root, base.paths.state_root),
      actors_path: resolvePath(paths.actors_path, base.paths.actors_path),
      policy_chain_path: resolvePath(paths.policy_chain_path, base.paths.policy_chain_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      burn_latest_path: resolvePath(paths.burn_latest_path, base.paths.burn_latest_path)
    }
  };
}

function readBurnPressure(policy) {
  const payload = readJson(policy.paths.burn_latest_path, {});
  const pressure = normalizeToken(payload.cost_pressure || payload.recommended_pressure || 'none', 24) || 'none';
  return pressure;
}

function pressurePenalty(pressure, policy) {
  const p = normalizeToken(pressure, 24);
  const base = Number(policy.thresholds.burn_pressure_penalty || 0.06);
  if (p === 'critical') return base;
  if (p === 'high') return Number((base * 0.7).toFixed(6));
  if (p === 'medium') return Number((base * 0.45).toFixed(6));
  if (p === 'low') return Number((base * 0.2).toFixed(6));
  return 0;
}

function computeScore(input, burnPressure, policy) {
  const w = policy.scoring_weights;
  const evasion = clampNumber(input.evasion_attempts, 0, 1000, 0);
  const chains = clampNumber(input.high_risk_chains, 0, 1000, 0);
  const anomaly = clampNumber(input.anomaly_bursts, 0, 1000, 0);
  const payout = clampNumber(input.payout_anomalies, 0, 1000, 0);
  const mirror = clampNumber(input.mirror_flags, 0, 1000, 0);
  const trustedRecovery = toBool(input.trusted_recovery, false);

  const penaltyRaw =
    Math.min(1, evasion / 10) * w.evasion_attempts +
    Math.min(1, chains / 8) * w.high_risk_chains +
    Math.min(1, anomaly / 10) * w.anomaly_bursts +
    Math.min(1, payout / 6) * w.payout_anomalies +
    Math.min(1, mirror / 12) * w.mirror_flags +
    pressurePenalty(burnPressure, policy);

  const penalty = Math.min(policy.thresholds.maximum_penalty, penaltyRaw);
  const recovery = trustedRecovery ? Number(policy.thresholds.recovery_bonus || 0) : 0;
  const score = clampNumber(1 - penalty + recovery, 0, 1, 0);

  return {
    score: Number(score.toFixed(6)),
    penalty: Number(penalty.toFixed(6)),
    recovery: Number(recovery.toFixed(6))
  };
}

function resolveTier(score, policy) {
  const tiers = [
    { id: 'trusted', min: policy.trust_tiers.trusted.min_score, envelope: policy.trust_tiers.trusted.envelope },
    { id: 'watch', min: policy.trust_tiers.watch.min_score, envelope: policy.trust_tiers.watch.envelope },
    { id: 'constrained', min: policy.trust_tiers.constrained.min_score, envelope: policy.trust_tiers.constrained.envelope },
    { id: 'quarantined', min: policy.trust_tiers.quarantined.min_score, envelope: policy.trust_tiers.quarantined.envelope }
  ].sort((a, b) => b.min - a.min);
  for (const t of tiers) {
    if (score >= t.min) return t;
  }
  return tiers[tiers.length - 1];
}

function evaluate(args, policy) {
  const actor = normalizeToken(args.actor || args.instance || 'unknown_actor', 120) || 'unknown_actor';
  const input = {
    evasion_attempts: clampInt(args.evasion, 0, 1000, 0),
    high_risk_chains: clampInt(args.chains, 0, 1000, 0),
    anomaly_bursts: clampInt(args.anomaly, 0, 1000, 0),
    payout_anomalies: clampInt(args.payout, 0, 1000, 0),
    mirror_flags: clampInt(args.mirror, 0, 1000, 0),
    trusted_recovery: toBool(args.trusted, false)
  };

  const burnPressure = readBurnPressure(policy);
  const score = computeScore(input, burnPressure, policy);
  const tier = resolveTier(score.score, policy);

  const actors = readJson(policy.paths.actors_path, { schema_version: '1.0', actors: {} });
  const prev = actors.actors && actors.actors[actor] ? actors.actors[actor] : {};
  const updated = {
    actor,
    trust_score: score.score,
    trust_tier: tier.id,
    capability_envelope: tier.envelope,
    burn_pressure: burnPressure,
    last_eval_at: nowIso(),
    trajectory: {
      ...input,
      penalty: score.penalty,
      recovery: score.recovery
    }
  };

  const apply = toBool(args.apply, false);
  if (apply) {
    actors.actors = actors.actors && typeof actors.actors === 'object' ? actors.actors : {};
    actors.actors[actor] = updated;
    actors.updated_at = nowIso();
    writeJsonAtomic(policy.paths.actors_path, actors);
  }

  const receipt = {
    ts: nowIso(),
    type: 'governance_hardening_evaluate',
    ok: true,
    shadow_only: policy.shadow_only,
    apply,
    actor,
    previous_tier: cleanText(prev.trust_tier || '', 40) || null,
    trust_tier: tier.id,
    capability_envelope: tier.envelope,
    trust_score: score.score,
    false_positive_rate: null,
    containment_bypass_rate: null,
    trusted_recovery_rate: input.trusted_recovery ? 1 : 0,
    managed_mode_visible: policy.managed_mode_visible,
    reason_code: `tier_${tier.id}`
  };

  writeJsonAtomic(policy.paths.latest_path, receipt);
  appendJsonl(policy.paths.receipts_path, receipt);

  return receipt;
}

function bootstrapChild(args, policy) {
  const child = normalizeToken(args.child || args.instance || '', 120);
  if (!child) return { ok: false, error: 'missing_child' };

  const parentPolicyPath = resolvePath(args['parent-policy'], 'config/governance_hardening_policy.json');
  const parentPayload = readJson(parentPolicyPath, null);
  if (!parentPayload) return { ok: false, error: 'missing_parent_policy' };

  const parentPolicyHash = stableHash(JSON.stringify(parentPayload));
  const parentSignature = cleanText(args['parent-signature'] || args.signature || '', 180);
  if (!parentSignature) return { ok: false, error: 'missing_parent_signature' };

  const chain = readJson(policy.paths.policy_chain_path, { schema_version: '1.0', children: {} });
  chain.children = chain.children && typeof chain.children === 'object' ? chain.children : {};
  const prior = chain.children[child] || null;
  const row = {
    child,
    managed_mode: true,
    parent_policy_hash: parentPolicyHash,
    parent_signature: parentSignature,
    chain_id: stableHash(`${child}|${parentPolicyHash}|${parentSignature}|${Date.now()}`, 20),
    previous_chain_id: prior ? cleanText(prior.chain_id || '', 40) : null,
    updated_at: nowIso()
  };
  chain.children[child] = row;
  chain.updated_at = nowIso();

  writeJsonAtomic(policy.paths.policy_chain_path, chain);

  const receipt = {
    ts: nowIso(),
    type: 'governance_policy_chain_bootstrap',
    ok: true,
    child,
    managed_mode_visible: policy.managed_mode_visible,
    parent_policy_hash: parentPolicyHash,
    chain_id: row.chain_id,
    rollback_receipt_ref: prior ? prior.chain_id : null
  };
  writeJsonAtomic(policy.paths.latest_path, receipt);
  appendJsonl(policy.paths.receipts_path, receipt);
  return receipt;
}

function verifyChild(args, policy) {
  const child = normalizeToken(args.child || args.instance || '', 120);
  if (!child) return { ok: false, error: 'missing_child' };
  const chain = readJson(policy.paths.policy_chain_path, { children: {} });
  const row = chain.children && chain.children[child] ? chain.children[child] : null;
  const ok = !!(row && row.parent_policy_hash && row.parent_signature && row.chain_id);
  const receipt = {
    ts: nowIso(),
    type: 'governance_policy_chain_verify',
    ok,
    child,
    managed_mode_visible: policy.managed_mode_visible,
    managed_mode: ok,
    reason_code: ok ? 'managed_chain_ok' : 'managed_chain_missing'
  };
  writeJsonAtomic(policy.paths.latest_path, receipt);
  appendJsonl(policy.paths.receipts_path, receipt);
  return receipt;
}

function status(policy) {
  const actors = readJson(policy.paths.actors_path, { actors: {} });
  const chain = readJson(policy.paths.policy_chain_path, { children: {} });
  const latest = readJson(policy.paths.latest_path, {});
  const actorCount = actors.actors && typeof actors.actors === 'object' ? Object.keys(actors.actors).length : 0;
  const childCount = chain.children && typeof chain.children === 'object' ? Object.keys(chain.children).length : 0;
  return {
    ok: true,
    type: 'governance_hardening_status',
    shadow_only: policy.shadow_only,
    managed_mode_visible: policy.managed_mode_visible,
    actors: actorCount,
    child_policy_bindings: childCount,
    latest
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

  if (!policy.enabled) {
    emit({ ok: false, error: 'governance_hardening_disabled' }, 1);
  }

  if (cmd === 'evaluate') emit(evaluate(args, policy));
  if (cmd === 'bootstrap-child') emit(bootstrapChild(args, policy), 0);
  if (cmd === 'verify-child') emit(verifyChild(args, policy), 0);
  if (cmd === 'status') emit(status(policy));

  usage();
  process.exit(1);
}

main();
