#!/usr/bin/env node
'use strict';
export {};

const { clampNumber } = require('./_shared');

function normalizeTiers(policy: Record<string, any>) {
  const tiers = Array.isArray(policy && policy.discount_tiers) ? policy.discount_tiers : [];
  return tiers
    .map((row) => ({
      min_gpu_hours: clampNumber(row && row.min_gpu_hours, 0, 1_000_000_000, 0),
      discount_rate: clampNumber(row && row.discount_rate, 0, 1, 0)
    }))
    .sort((a, b) => Number(a.min_gpu_hours) - Number(b.min_gpu_hours));
}

function discountForContribution(gpuHours: number, policy: Record<string, any>) {
  const hours = clampNumber(gpuHours, 0, 1000000, 0);
  const tiers = normalizeTiers(policy);
  if (tiers.length > 0) {
    let chosen = tiers[0];
    for (const row of tiers) {
      if (hours >= Number(row.min_gpu_hours || 0)) chosen = row;
      else break;
    }
    return clampNumber(chosen.discount_rate, 0, Number(policy.max_discount_rate || 0.85), 0);
  }
  const discountRate = clampNumber(hours * Number(policy.discount_per_gpu_hour || 0), 0, Number(policy.max_discount_rate || 0.85), 0);
  return Number(discountRate.toFixed(6));
}

function effectiveTitheRate(baseRate: number, discountRate: number, policy: Record<string, any>) {
  const base = clampNumber(baseRate, 0, 1, Number(policy.base_tithe_rate || 0.1));
  const discount = clampNumber(discountRate, 0, 1, 0);
  const minRate = clampNumber(policy.min_tithe_rate, 0, 1, 0.01);
  return Number(Math.max(minRate, base * (1 - discount)).toFixed(6));
}

module.exports = {
  discountForContribution,
  effectiveTitheRate
};
