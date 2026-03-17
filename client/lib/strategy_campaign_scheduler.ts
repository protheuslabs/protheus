#!/usr/bin/env node
'use strict';
export {};

// Layer ownership: core/layer0/ops (authoritative)
// Thin TypeScript wrapper only.

const path = require('path');
const { createOpsLaneBridge } = require('../runtime/lib/rust_lane_bridge.ts');

process.env.PROTHEUS_OPS_USE_PREBUILT = process.env.PROTHEUS_OPS_USE_PREBUILT || '0';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '120000';
const bridge = createOpsLaneBridge(__dirname, 'strategy_campaign_scheduler', 'strategy-campaign-scheduler-kernel');

function encodeBase64(value) {
  return Buffer.from(String(value == null ? '' : value), 'utf8').toString('base64');
}

function invoke(command, payload = {}, opts = {}) {
  const out = bridge.run([
    command,
    `--payload-base64=${encodeBase64(JSON.stringify(payload || {}))}`
  ]);
  const receipt = out && out.payload && typeof out.payload === 'object' ? out.payload : null;
  const payloadOut = receipt && receipt.payload && typeof receipt.payload === 'object'
    ? receipt.payload
    : receipt;
  if (out.status !== 0) {
    const message = payloadOut && typeof payloadOut.error === 'string'
      ? payloadOut.error
      : (out && out.stderr ? String(out.stderr).trim() : `strategy_campaign_scheduler_kernel_${command}_failed`);
    if (opts.throwOnError !== false) throw new Error(message || `strategy_campaign_scheduler_kernel_${command}_failed`);
    return { ok: false, error: message || `strategy_campaign_scheduler_kernel_${command}_failed` };
  }
  if (!payloadOut || typeof payloadOut !== 'object') {
    const message = out && out.stderr
      ? String(out.stderr).trim() || `strategy_campaign_scheduler_kernel_${command}_bridge_failed`
      : `strategy_campaign_scheduler_kernel_${command}_bridge_failed`;
    if (opts.throwOnError !== false) throw new Error(message);
    return { ok: false, error: message };
  }
  return payloadOut;
}

function normalizeCampaigns(strategy) {
  const out = invoke('normalize-campaigns', {
    strategy: strategy && typeof strategy === 'object' ? strategy : {}
  });
  return Array.isArray(out.campaigns) ? out.campaigns : [];
}

function annotateCampaignPriority(candidates, strategy) {
  const out = invoke('annotate-priority', {
    candidates: Array.isArray(candidates) ? candidates : [],
    strategy: strategy && typeof strategy === 'object' ? strategy : {}
  });
  const annotated = Array.isArray(out.candidates) ? out.candidates : [];
  if (Array.isArray(candidates)) {
    for (let i = 0; i < candidates.length; i += 1) {
      const next = annotated[i];
      if (!next || typeof next !== 'object' || typeof candidates[i] !== 'object' || !candidates[i]) continue;
      Object.assign(candidates[i], next);
    }
  }
  return out.summary || {
    enabled: false,
    campaign_count: 0,
    matched_count: 0
  };
}

function buildCampaignDecompositionPlans(proposals, strategy, opts = {}) {
  const out = invoke('build-decomposition-plans', {
    proposals: Array.isArray(proposals) ? proposals : [],
    strategy: strategy && typeof strategy === 'object' ? strategy : {},
    opts: opts && typeof opts === 'object' ? opts : {}
  });
  return out.plan || {
    enabled: false,
    additions: [],
    campaign_count: 0,
    min_open_per_type: 1,
    max_additions: 0
  };
}

module.exports = {
  normalizeCampaigns,
  annotateCampaignPriority,
  buildCampaignDecompositionPlans
};
