#!/usr/bin/env node
'use strict';
export {};

const {
  nowIso,
  stableHash,
  appendJsonl
} = require('./_shared');

function mintTitheReceipt(policy: Record<string, any>, payload: Record<string, any>) {
  const receipt = {
    ts: nowIso(),
    type: 'tithe_chain_receipt',
    receipt_id: `chain_${stableHash(JSON.stringify(payload), 18)}`,
    donor_id: payload.donor_id,
    contribution_id: payload.contribution_id,
    effective_tithe_rate: payload.effective_tithe_rate,
    discount_rate: payload.discount_rate,
    gpu_hours: payload.validated_gpu_hours,
    chain: 'sovereign_bridge_stub'
  };
  appendJsonl(policy.paths.chain_receipts_path, receipt);
  return receipt;
}

module.exports = {
  mintTitheReceipt
};
