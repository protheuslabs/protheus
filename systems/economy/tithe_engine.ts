#!/usr/bin/env node
'use strict';
export {};

const {
  nowIso,
  parseArgs,
  readJson,
  writeJsonAtomic,
  loadPolicy,
  rel,
  emit,
  clampNumber
} = require('./_shared');
const { discountForContribution, effectiveTitheRate } = require('./discount_policy');
const { appendLedger } = require('./tithe_ledger');
const { mintTitheReceipt } = require('./smart_contract_bridge');

function constitutionCheckForContribution(input: Record<string, any>, riskTier: number) {
  const donorId = String(input && input.donor_id ? input.donor_id : '').toLowerCase();
  const proofRef = String(input && input.proof_ref ? input.proof_ref : '').toLowerCase();
  const blockedTokens = ['rm -rf', 'bypass_gate', 'disable_guard', 'exfiltrate'];
  const joined = `${donorId} ${proofRef}`;
  const hits = blockedTokens.filter((tok) => joined.includes(tok));
  return {
    pass: hits.length === 0 && riskTier <= 2,
    checks: {
      blocked_tokens_clear: hits.length === 0,
      risk_tier_safe: riskTier <= 2
    },
    blocked_token_hits: hits
  };
}

function loadDonorState(policy: Record<string, any>) {
  const raw = readJson(policy.paths.donor_state_path, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function saveDonorState(policy: Record<string, any>, state: Record<string, any>) {
  writeJsonAtomic(policy.paths.donor_state_path, state);
}

function getBaseTitheRate(policy: Record<string, any>) {
  return clampNumber(policy && policy.base_tithe_rate, 0, 1, 0.1);
}

function riskTierForContribution(policy: Record<string, any>, input: Record<string, any>) {
  const requested = clampNumber(input && input.risk_tier, 1, 4, Number(policy.risk_tier_default || 2));
  return Math.round(requested);
}

function calculateEffectiveTithe(policy: Record<string, any>, totalGpuHours: number) {
  const baseRate = getBaseTitheRate(policy);
  const discountRate = discountForContribution(totalGpuHours, policy);
  const effectiveRate = effectiveTitheRate(baseRate, discountRate, policy);
  return {
    base_tithe_rate: baseRate,
    discount_rate: discountRate,
    effective_tithe_rate: effectiveRate
  };
}

function previewNextActuation(policy: Record<string, any>, donorState: Record<string, any>, riskTier = 2) {
  const donorId = String(donorState && donorState.donor_id ? donorState.donor_id : '').trim() || 'anonymous';
  const discountRate = clampNumber(donorState && donorState.discount_rate, 0, 1, 0);
  const effectiveRate = clampNumber(donorState && donorState.effective_tithe_rate, 0, 1, getBaseTitheRate(policy));
  const heavyTask = discountRate >= 0.05;
  return {
    donor_id: donorId,
    risk_tier: Math.max(1, Math.min(4, Math.round(Number(riskTier || 2)))),
    effective_tithe_rate: effectiveRate,
    preferred_queue: heavyTask ? 'donor_priority' : 'standard',
    preferred_model_class: heavyTask ? 'high_throughput' : 'balanced',
    route_hint: heavyTask ? 'donor_compute_first' : 'local_bounded_fallback'
  };
}

function writeIntegrationHints(policy: Record<string, any>, donorId: string, payload: Record<string, any>) {
  const actuationPreview = previewNextActuation(policy, {
    donor_id: donorId,
    discount_rate: payload.discount_rate,
    effective_tithe_rate: payload.effective_tithe_rate
  }, payload.risk_tier);

  writeJsonAtomic(policy.paths.guard_hint_path, {
    ts: nowIso(),
    type: 'effective_tithe_hint',
    donor_id: donorId,
    effective_tithe_rate: payload.effective_tithe_rate,
    risk_tier: payload.risk_tier
  });
  writeJsonAtomic(policy.paths.fractal_hint_path, {
    ts: nowIso(),
    type: 'fractal_donor_priority_hint',
    donor_id: donorId,
    priority_boost: Number((payload.discount_rate * 100).toFixed(3)),
    preferred_queue: actuationPreview.preferred_queue
  });
  writeJsonAtomic(policy.paths.routing_hint_path, {
    ts: nowIso(),
    type: 'routing_donor_priority_hint',
    donor_id: donorId,
    discount_rate: payload.discount_rate,
    effective_tithe_rate: payload.effective_tithe_rate
  });
  writeJsonAtomic(policy.paths.model_hint_path, {
    ts: nowIso(),
    type: 'model_catalog_donor_hint',
    donor_id: donorId,
    preferred_model_class: actuationPreview.preferred_model_class,
    route_hint: actuationPreview.route_hint
  });
  writeJsonAtomic(policy.paths.risk_hint_path, {
    ts: nowIso(),
    type: 'risk_router_donor_hint',
    donor_id: donorId,
    risk_tier: payload.risk_tier,
    effective_tithe_rate: payload.effective_tithe_rate,
    tier3_plus_requires_second_gate: policy.enforce_second_gate_tier3_plus !== false
  });

  const soul = readJson(policy.paths.soul_marker_path, { gpu_patrons: [] });
  const patrons = Array.isArray(soul.gpu_patrons) ? soul.gpu_patrons.slice(0) : [];
  if (!patrons.includes(donorId)) patrons.push(donorId);
  writeJsonAtomic(policy.paths.soul_marker_path, {
    schema_id: 'gpu_patron_markers',
    schema_version: '1.0',
    updated_at: nowIso(),
    gpu_patrons: patrons.slice(0, 2000)
  });

  return actuationPreview;
}

function applyDiscountAndRecord(policy: Record<string, any>, input: Record<string, any>) {
  const donorId = String(input.donor_id || '').trim() || 'anonymous';
  const contributionId = String(input.contribution_id || '').trim() || 'unknown';
  const gpuHours = Math.max(0, Number(input.validated_gpu_hours || 0));
  const riskTier = riskTierForContribution(policy, input);
  const secondGateApproved = input.second_gate_approved === true;

  if (policy.enforce_second_gate_tier3_plus !== false && riskTier > 2 && !secondGateApproved) {
    return {
      ok: false,
      error: 'second_gate_required_for_tier3_plus',
      donor_id: donorId,
      contribution_id: contributionId,
      risk_tier: riskTier
    };
  }

  if (policy.require_constitution_pass !== false) {
    const constitution = constitutionCheckForContribution(input, riskTier);
    if (!constitution.pass) {
      return {
        ok: false,
        error: 'constitution_blocked',
        donor_id: donorId,
        contribution_id: contributionId,
        risk_tier: riskTier,
        constitution
      };
    }
  }

  const state = loadDonorState(policy);
  const prev = state[donorId] && typeof state[donorId] === 'object' ? state[donorId] : {
    donor_id: donorId,
    total_validated_gpu_hours: 0,
    discount_rate: 0,
    effective_tithe_rate: getBaseTitheRate(policy)
  };
  const totalHours = Number(prev.total_validated_gpu_hours || 0) + gpuHours;
  const calculated = calculateEffectiveTithe(policy, totalHours);
  const next = {
    donor_id: donorId,
    total_validated_gpu_hours: Number(totalHours.toFixed(6)),
    discount_rate: calculated.discount_rate,
    effective_tithe_rate: calculated.effective_tithe_rate,
    updated_at: nowIso()
  };
  state[donorId] = next;
  saveDonorState(policy, state);

  const eventPayload = {
    donor_id: donorId,
    contribution_id: contributionId,
    validated_gpu_hours: gpuHours,
    total_validated_gpu_hours: next.total_validated_gpu_hours,
    discount_rate: calculated.discount_rate,
    effective_tithe_rate: calculated.effective_tithe_rate,
    risk_tier: riskTier
  };
  const ledgerRow = appendLedger(policy, 'compute_tithe_applied', eventPayload);
  const chainReceipt = mintTitheReceipt(policy, eventPayload);
  const nextActuation = writeIntegrationHints(policy, donorId, eventPayload);
  return {
    ok: true,
    ledger_event_id: ledgerRow.event_id,
    chain_receipt_id: chainReceipt.receipt_id,
    next_actuation: nextActuation,
    ...eventPayload
  };
}

function applyValidatedContribution(policy: Record<string, any>, input: Record<string, any>) {
  return applyDiscountAndRecord(policy, input);
}

function cmdStatus(policy: Record<string, any>, args: Record<string, any>) {
  const donorId = String(args.donor_id || args.donor || '').trim();
  const state = loadDonorState(policy);
  if (donorId) {
    emit({
      ok: true,
      type: 'compute_tithe_status',
      donor_id: donorId,
      donor_state: state[donorId] || null
    }, 0);
  }
  emit({
    ok: true,
    type: 'compute_tithe_status',
    donor_count: Object.keys(state).length,
    donor_state: state
  }, 0);
}

function cmdApply(policy: Record<string, any>, args: Record<string, any>) {
  const donorId = String(args.donor_id || args.donor || '').trim() || 'anonymous';
  const contributionId = String(args.contribution_id || args.contribution || '').trim() || 'manual';
  const validatedGpuHours = Math.max(0, Number(args.validated_gpu_hours || args.gpu_hours || 0));
  const out = applyDiscountAndRecord(policy, {
    donor_id: donorId,
    contribution_id: contributionId,
    validated_gpu_hours: validatedGpuHours,
    risk_tier: args.risk_tier,
    second_gate_approved: args.second_gate_approved === true || String(args.second_gate_approved || '') === '1'
  });
  emit({ type: 'compute_tithe_apply', ...out }, out && out.ok === true ? 0 : 2);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'status').trim().toLowerCase();
  const policy = loadPolicy(args.policy ? String(args.policy) : undefined);
  if (policy.enabled !== true) {
    emit({ ok: false, type: 'compute_tithe', error: 'policy_disabled', policy_path: rel(policy.policy_path) }, 2);
  }
  if (cmd === 'status') return cmdStatus(policy, args);
  if (cmd === 'apply') return cmdApply(policy, args);
  emit({ ok: false, error: 'unknown_command', command: cmd }, 2);
}

module.exports = {
  loadDonorState,
  getBaseTitheRate,
  calculateEffectiveTithe,
  applyDiscountAndRecord,
  applyValidatedContribution,
  previewNextActuation
};

if (require.main === module) {
  main();
}
