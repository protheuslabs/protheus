#!/usr/bin/env node
'use strict';
export {};

// Layer ownership: core/layer2/autonomy (authoritative)
// Thin TypeScript wrapper only.

const { createConduitLaneModule } = require('./direct_conduit_lane_bridge.js');
const __directConduitLane = createConduitLaneModule('LIB_DUALITY_SEED');
void __directConduitLane;

const { createOpsLaneBridge } = require('./rust_lane_bridge.ts');

type AnyObj = Record<string, any>;

const bridge = createOpsLaneBridge(__dirname, 'duality_seed', 'duality-seed');

function invokeDuality(op: string, args: AnyObj = {}): AnyObj {
  const payload = JSON.stringify({ op, args: args && typeof args === 'object' ? args : {} });
  const out = bridge.run(['invoke', `--payload=${payload}`]);
  if (!out || out.ok !== true || !out.payload || out.payload.ok !== true) {
    const reason = out && out.payload && (out.payload.error || out.payload.reason)
      ? String(out.payload.error || out.payload.reason)
      : 'duality_seed_bridge_failed';
    throw new Error(reason);
  }
  return out.payload;
}

function loadDualityPolicy(policyPath?: string) {
  const args: AnyObj = {};
  if (policyPath && String(policyPath).trim()) args.policy_path = String(policyPath).trim();
  const result = invokeDuality('loadDualityPolicy', args).result;
  return result && typeof result === 'object' ? result : {};
}

function loadDualityCodex(policyPath?: string) {
  const args: AnyObj = {};
  if (policyPath && String(policyPath).trim()) args.policy_path = String(policyPath).trim();
  const result = invokeDuality('loadDualityCodex', args).result;
  return result && typeof result === 'object' ? result : {};
}

function loadDualityState(policyPath?: string) {
  const args: AnyObj = {};
  if (policyPath && String(policyPath).trim()) args.policy_path = String(policyPath).trim();
  const result = invokeDuality('loadDualityState', args).result;
  return result && typeof result === 'object' ? result : {};
}

function parseDualityCodexText(text: string) {
  const result = invokeDuality('parseDualityCodexText', { text: String(text == null ? '' : text) }).result;
  return result && typeof result === 'object' ? result : {};
}

function evaluateDualitySignal(contextRaw: AnyObj = {}, opts: AnyObj = {}) {
  const args: AnyObj = {
    context: contextRaw && typeof contextRaw === 'object' ? contextRaw : {},
    opts: opts && typeof opts === 'object' ? opts : {}
  };
  if (args.opts.policy_path || args.opts.policyPath) {
    args.policy_path = String(args.opts.policy_path || args.opts.policyPath || '').trim();
  }
  const result = invokeDuality('evaluateDualitySignal', args).result;
  return result && typeof result === 'object' ? result : {};
}

function registerDualityObservation(inputRaw: AnyObj = {}, opts: AnyObj = {}) {
  const args: AnyObj = {
    input: inputRaw && typeof inputRaw === 'object' ? inputRaw : {}
  };
  if (opts && typeof opts === 'object') {
    if (opts.policy_path || opts.policyPath) {
      args.policy_path = String(opts.policy_path || opts.policyPath || '').trim();
    }
    if (opts.lane && !args.input.lane) args.input.lane = opts.lane;
    if (opts.run_id && !args.input.run_id) args.input.run_id = opts.run_id;
    if (opts.source && !args.input.source) args.input.source = opts.source;
  }
  const result = invokeDuality('registerDualityObservation', args).result;
  return result && typeof result === 'object' ? result : {};
}

function duality_evaluate(balanceContext: AnyObj = {}, opts: AnyObj = {}) {
  const args: AnyObj = {
    context: balanceContext && typeof balanceContext === 'object' ? balanceContext : {},
    opts: opts && typeof opts === 'object' ? opts : {}
  };
  if (args.opts.policy_path || args.opts.policyPath) {
    args.policy_path = String(args.opts.policy_path || args.opts.policyPath || '').trim();
  }
  const result = invokeDuality('duality_evaluate', args).result;
  return result && typeof result === 'object' ? result : {};
}

function quarantineDualitySeed(inputRaw: AnyObj = {}, opts: AnyObj = {}) {
  const args: AnyObj = {
    input: inputRaw && typeof inputRaw === 'object' ? inputRaw : {}
  };
  if (opts && typeof opts === 'object' && (opts.policy_path || opts.policyPath)) {
    args.policy_path = String(opts.policy_path || opts.policyPath || '').trim();
  }
  const result = invokeDuality('quarantineDualitySeed', args).result;
  return result && typeof result === 'object' ? result : {};
}

function maybeRunSelfValidation(policyPath?: string) {
  const args: AnyObj = {};
  if (policyPath && String(policyPath).trim()) args.policy_path = String(policyPath).trim();
  const result = invokeDuality('maybeRunSelfValidation', args).result;
  return result && typeof result === 'object' ? result : {};
}

module.exports = {
  loadDualityPolicy,
  loadDualityCodex,
  loadDualityState,
  parseDualityCodexText,
  evaluateDualitySignal,
  registerDualityObservation,
  duality_evaluate,
  quarantineDualitySeed,
  maybeRunSelfValidation
};
