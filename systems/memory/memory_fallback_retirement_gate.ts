#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-026
 * JS fallback retirement gate (emergency-only by policy).
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
  readJson,
  writeJsonAtomic,
  appendJsonl,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

const POLICY_ROOT = process.env.MEMORY_RECALL_ROOT
  ? path.resolve(String(process.env.MEMORY_RECALL_ROOT))
  : ROOT;
const DEFAULT_POLICY_PATH = process.env.MEMORY_FALLBACK_RETIREMENT_POLICY_PATH
  ? path.resolve(process.env.MEMORY_FALLBACK_RETIREMENT_POLICY_PATH)
  : path.join(POLICY_ROOT, 'config', 'memory_fallback_retirement_policy.json');

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: false,
    allow_js_fallback: true,
    paths: {
      emergency_toggle_path: 'state/memory/rust_transition/emergency_js_fallback_toggle.json',
      latest_path: 'state/memory/rust_transition/js_fallback_gate/latest.json',
      receipts_path: 'state/memory/rust_transition/js_fallback_gate/receipts.jsonl'
    }
  };
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const resolveLocalPath = (value: unknown, fallbackRel: string) => {
    const txt = cleanText(value || '', 520);
    if (!txt) return path.join(POLICY_ROOT, fallbackRel);
    return path.isAbsolute(txt) ? txt : path.join(POLICY_ROOT, txt);
  };
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: toBool(raw.enabled, base.enabled),
    allow_js_fallback: toBool(raw.allow_js_fallback, base.allow_js_fallback),
    paths: {
      emergency_toggle_path: resolveLocalPath(paths.emergency_toggle_path, base.paths.emergency_toggle_path),
      latest_path: resolveLocalPath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolveLocalPath(paths.receipts_path, base.paths.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadEmergencyToggle(togglePath: string) {
  const raw = readJson(togglePath, null);
  if (!raw || typeof raw !== 'object') {
    return {
      active: false,
      reason: null,
      updated_at: null
    };
  }
  return {
    active: raw.active === true,
    reason: raw.reason ? cleanText(raw.reason, 240) : null,
    updated_at: raw.updated_at ? String(raw.updated_at) : null
  };
}

function writeEmergencyToggle(togglePath: string, payload: any) {
  writeJsonAtomic(togglePath, {
    schema_id: 'memory_fallback_emergency_toggle',
    schema_version: '1.0',
    active: payload.active === true,
    reason: payload.reason ? cleanText(payload.reason, 240) : null,
    updated_at: nowIso()
  });
}

function evaluateJsFallbackGate(input: any = {}, policyPath = DEFAULT_POLICY_PATH) {
  const policy = loadPolicy(policyPath);
  const toggle = loadEmergencyToggle(policy.paths.emergency_toggle_path);
  const fallbackReason = cleanText(input.fallback_reason || '', 160) || null;
  const operation = normalizeToken(input.operation || 'query', 40) || 'query';
  const requestedBackend = normalizeToken(input.backend_requested || 'rust', 20) || 'rust';

  let allow = true;
  let decisionReason = 'policy_disabled';
  if (policy.enabled === true) {
    if (policy.allow_js_fallback === true) {
      allow = true;
      decisionReason = 'policy_allow_js_fallback';
    } else if (toggle.active === true) {
      allow = true;
      decisionReason = 'emergency_toggle_active';
    } else {
      allow = false;
      decisionReason = 'js_fallback_retired';
    }
  }

  const incidentId = `mem_fb_${stableHash(`${nowIso()}|${operation}|${fallbackReason || ''}|${decisionReason}`, 16)}`;
  const receipt = {
    schema_id: 'memory_fallback_retirement_receipt',
    schema_version: '1.0',
    ts: nowIso(),
    incident_id: incidentId,
    allow,
    decision_reason: decisionReason,
    fallback_reason: fallbackReason,
    operation,
    backend_requested: requestedBackend,
    emergency_toggle_active: toggle.active === true,
    emergency_toggle_reason: toggle.reason || null,
    policy_path: rel(policy.policy_path),
    emergency_toggle_path: rel(policy.paths.emergency_toggle_path)
  };

  writeJsonAtomic(policy.paths.latest_path, receipt);
  appendJsonl(policy.paths.receipts_path, receipt);
  return receipt;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/memory_fallback_retirement_gate.js status [--policy=<path>]');
  console.log('  node systems/memory/memory_fallback_retirement_gate.js evaluate --operation=query|get --backend_requested=rust --fallback_reason=<reason> [--policy=<path>]');
  console.log('  node systems/memory/memory_fallback_retirement_gate.js enable-emergency --reason=<text> [--policy=<path>]');
  console.log('  node systems/memory/memory_fallback_retirement_gate.js disable-emergency [--policy=<path>]');
}

function cmdStatus(policyPath = DEFAULT_POLICY_PATH) {
  const policy = loadPolicy(policyPath);
  const toggle = loadEmergencyToggle(policy.paths.emergency_toggle_path);
  const latest = readJson(policy.paths.latest_path, null);
  emit({
    ok: true,
    type: 'memory_fallback_retirement_gate',
    ts: nowIso(),
    policy: {
      version: policy.version,
      enabled: policy.enabled,
      allow_js_fallback: policy.allow_js_fallback,
      policy_path: rel(policy.policy_path)
    },
    emergency_toggle: toggle,
    latest
  }, 0);
}

function cmdEvaluate(args: any, policyPath = DEFAULT_POLICY_PATH) {
  const receipt = evaluateJsFallbackGate({
    operation: args.operation || args.op || 'query',
    backend_requested: args.backend_requested || args.backend || 'rust',
    fallback_reason: args.fallback_reason || args.reason || ''
  }, policyPath);
  emit({
    ok: receipt.allow === true,
    type: 'memory_fallback_retirement_gate',
    action: 'evaluate',
    ...receipt
  }, receipt.allow ? 0 : 2);
}

function cmdEnableEmergency(args: any, policyPath = DEFAULT_POLICY_PATH) {
  const policy = loadPolicy(policyPath);
  writeEmergencyToggle(policy.paths.emergency_toggle_path, {
    active: true,
    reason: args.reason || 'manual_emergency_toggle'
  });
  cmdStatus(policyPath);
}

function cmdDisableEmergency(policyPath = DEFAULT_POLICY_PATH) {
  const policy = loadPolicy(policyPath);
  writeEmergencyToggle(policy.paths.emergency_toggle_path, {
    active: false,
    reason: 'manual_disable'
  });
  cmdStatus(policyPath);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 60) || 'status';
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  if (cmd === '--help' || args.help) {
    usage();
    return;
  }
  if (cmd === 'status') return cmdStatus(policyPath);
  if (cmd === 'evaluate') return cmdEvaluate(args, policyPath);
  if (cmd === 'enable-emergency') return cmdEnableEmergency(args, policyPath);
  if (cmd === 'disable-emergency') return cmdDisableEmergency(policyPath);
  usage();
  emit({ ok: false, error: 'unknown_command', command: cmd }, 2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  loadEmergencyToggle,
  evaluateJsFallbackGate
};
