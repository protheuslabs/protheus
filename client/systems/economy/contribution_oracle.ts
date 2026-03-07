#!/usr/bin/env node
'use strict';
export {};

const { cleanText, stableHash, nowIso } = require('./_shared');

function validateContribution(input: Record<string, any>) {
  const donorId = cleanText(input && input.donor_id ? input.donor_id : '', 120);
  const proofRef = cleanText(input && input.proof_ref ? input.proof_ref : '', 320);
  const gpuHours = Number(input && input.gpu_hours != null ? input.gpu_hours : 0);
  const errors = [];
  if (!donorId) errors.push('missing_donor_id');
  if (!proofRef) errors.push('missing_proof_ref');
  if (!Number.isFinite(gpuHours) || gpuHours <= 0) errors.push('invalid_gpu_hours');
  if (gpuHours > 100000) errors.push('gpu_hours_out_of_bounds');
  const pass = errors.length === 0;
  return {
    ok: pass,
    validated: pass,
    validation_id: `val_${stableHash(`${donorId}|${proofRef}|${gpuHours}|${nowIso()}`, 16)}`,
    donor_id: donorId,
    validated_gpu_hours: pass ? Number(gpuHours.toFixed(6)) : 0,
    errors
  };
}

module.exports = {
  validateContribution
};
