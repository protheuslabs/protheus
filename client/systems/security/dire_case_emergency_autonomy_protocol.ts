#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.DIRE_CASE_EMERGENCY_AUTONOMY_PROTOCOL_POLICY_PATH
  ? path.resolve(process.env.DIRE_CASE_EMERGENCY_AUTONOMY_PROTOCOL_POLICY_PATH)
  : path.join(ROOT, 'config', 'dire_case_emergency_autonomy_protocol_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/dire_case_emergency_autonomy_protocol.js trigger --evidence-a=<id> --evidence-b=<id> [--evidence-c=<id>] [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/security/dire_case_emergency_autonomy_protocol.js release --token=<id> [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/security/dire_case_emergency_autonomy_protocol.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    min_independent_evidence: 2,
    protocol_ttl_minutes: 90,
    human_override_always_available: true,
    paths: {
      latest_path: 'state/security/dire_case_emergency_autonomy_protocol/latest.json',
      receipts_path: 'state/security/dire_case_emergency_autonomy_protocol/receipts.jsonl',
      ledger_path: 'state/security/dire_case_emergency_autonomy_protocol/ledger.jsonl',
      state_path: 'state/security/dire_case_emergency_autonomy_protocol/state.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    min_independent_evidence: clampInt(raw.min_independent_evidence, 2, 5, base.min_independent_evidence),
    protocol_ttl_minutes: clampInt(raw.protocol_ttl_minutes, 5, 24 * 60, base.protocol_ttl_minutes),
    human_override_always_available: toBool(raw.human_override_always_available, true),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      ledger_path: resolvePath(paths.ledger_path, base.paths.ledger_path),
      state_path: resolvePath(paths.state_path, base.paths.state_path)
    }
  };
}

function loadState(policy) {
  const raw = readJson(policy.paths.state_path, {});
  return {
    protocol_active: toBool(raw.protocol_active, false),
    activation_token: cleanText(raw.activation_token || '', 120),
    activated_at: cleanText(raw.activated_at || '', 64),
    expires_at: cleanText(raw.expires_at || '', 64),
    evidence: Array.isArray(raw.evidence) ? raw.evidence : []
  };
}

function saveState(policy, state) {
  writeJsonAtomic(policy.paths.state_path, state);
  return state;
}

function writeReceipt(policy, row) {
  const out = { ts: nowIso(), ok: true, shadow_only: policy.shadow_only, ...row };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function trigger(args, policy) {
  const apply = toBool(args.apply, false);
  const evidence = Array.from(new Set([
    cleanText(args['evidence-a'] || '', 80),
    cleanText(args['evidence-b'] || '', 80),
    cleanText(args['evidence-c'] || '', 80)
  ].filter(Boolean)));

  if (evidence.length < policy.min_independent_evidence) {
    return { ok: false, type: 'dire_case_emergency_trigger', error: 'insufficient_independent_evidence', min_required: policy.min_independent_evidence };
  }

  const activatedAt = nowIso();
  const expiresAt = new Date(Date.parse(activatedAt) + (policy.protocol_ttl_minutes * 60 * 1000)).toISOString();
  const token = `emg_${stableHash(`${activatedAt}|${evidence.join('|')}`, 18)}`;

  const nextState = {
    protocol_active: true,
    activation_token: token,
    activated_at: activatedAt,
    expires_at: expiresAt,
    evidence
  };

  if (apply) {
    saveState(policy, nextState);
    appendJsonl(policy.paths.ledger_path, {
      ts: activatedAt,
      type: 'dire_case_emergency_trigger',
      token,
      evidence,
      ttl_minutes: policy.protocol_ttl_minutes,
      human_override_always_available: policy.human_override_always_available
    });
  }

  return writeReceipt(policy, {
    type: 'dire_case_emergency_trigger',
    apply,
    protocol_active: true,
    activation_token: token,
    ttl_minutes: policy.protocol_ttl_minutes,
    evidence_count: evidence.length,
    human_override_always_available: policy.human_override_always_available
  });
}

function release(args, policy) {
  const apply = toBool(args.apply, false);
  const token = cleanText(args.token || '', 120);
  const state = loadState(policy);
  if (!state.protocol_active) return { ok: false, type: 'dire_case_emergency_release', error: 'protocol_not_active' };
  if (!token || token !== state.activation_token) return { ok: false, type: 'dire_case_emergency_release', error: 'invalid_token' };

  const nextState = {
    protocol_active: false,
    activation_token: '',
    activated_at: '',
    expires_at: '',
    evidence: []
  };
  if (apply) {
    saveState(policy, nextState);
    appendJsonl(policy.paths.ledger_path, {
      ts: nowIso(),
      type: 'dire_case_emergency_release',
      token,
      released_by: 'human_override'
    });
  }
  return writeReceipt(policy, {
    type: 'dire_case_emergency_release',
    apply,
    protocol_active: false,
    human_override_always_available: policy.human_override_always_available
  });
}

function status(policy) {
  const state = loadState(policy);
  return {
    ok: true,
    type: 'dire_case_emergency_status',
    shadow_only: policy.shadow_only,
    protocol_active: state.protocol_active,
    activation_token: state.activation_token,
    expires_at: state.expires_at,
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
  if (!policy.enabled) emit({ ok: false, error: 'dire_case_emergency_autonomy_protocol_disabled' }, 1);

  if (cmd === 'trigger') emit(trigger(args, policy));
  if (cmd === 'release') emit(release(args, policy));
  if (cmd === 'status') emit(status(policy));

  emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
}

main();
