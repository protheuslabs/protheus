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
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const POLICY_PATH = process.env.EXECUTION_SANDBOX_ENVELOPE_POLICY_PATH
  ? path.resolve(process.env.EXECUTION_SANDBOX_ENVELOPE_POLICY_PATH)
  : path.join(ROOT, 'config', 'execution_sandbox_envelope_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/execution_sandbox_envelope.js evaluate-workflow --step-id=<id> --step-type=<command|receipt> --command="<cmd>" [--apply=1|0]');
  console.log('  node systems/security/execution_sandbox_envelope.js evaluate-actuation --kind=<id> --context=\'{"risk_class":"shell"}\' [--apply=1|0]');
  console.log('  node systems/security/execution_sandbox_envelope.js status');
}

function loadPolicy() {
  const raw = readJson(POLICY_PATH, {});
  const base = {
    version: '1.0',
    enabled: true,
    mode: 'enforce',
    default_host_fs_access: false,
    default_network_access: false,
    profiles: {},
    workflow_profile_map: {},
    actuation_profile: '',
    blocked_command_tokens: [],
    high_risk_actuation_classes: ['shell'],
    require_approval_for_high_risk_actuation: true,
    paths: {
      latest_path: 'state/security/execution_sandbox_envelope/latest.json',
      audit_path: 'state/security/execution_sandbox_envelope/audit.jsonl'
    }
  };
  const merged = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };
  const paths = merged.paths && typeof merged.paths === 'object' ? merged.paths : {};
  return {
    ...merged,
    blocked_command_tokens: Array.isArray(merged.blocked_command_tokens)
      ? merged.blocked_command_tokens.map((row: unknown) => cleanText(row, 120).toLowerCase()).filter(Boolean)
      : [],
    high_risk_actuation_classes: Array.isArray(merged.high_risk_actuation_classes)
      ? merged.high_risk_actuation_classes.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
      : ['shell'],
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      audit_path: resolvePath(paths.audit_path, base.paths.audit_path)
    }
  };
}

function parseContext(raw: unknown) {
  const txt = String(raw || '').trim();
  if (!txt) return {};
  try {
    const parsed = JSON.parse(txt);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeDecision(policy: any, row: any, apply: boolean) {
  if (!apply) return;
  writeJsonAtomic(policy.paths.latest_path, row);
  appendJsonl(policy.paths.audit_path, row);
}

function decideWorkflow(policy: any, args: any, apply: boolean) {
  const stepId = normalizeToken(args['step-id'] || args.step_id || 'step', 120) || 'step';
  const stepType = normalizeToken(args['step-type'] || args.step_type || 'command', 80) || 'command';
  const cmd = String(args.command || '').toLowerCase();
  const profileId = normalizeToken(policy.workflow_profile_map && policy.workflow_profile_map[stepType], 120)
    || normalizeToken(policy.workflow_profile_map && policy.workflow_profile_map.command, 120)
    || '';
  const profile = profileId && policy.profiles && policy.profiles[profileId]
    ? policy.profiles[profileId]
    : null;
  const blockedToken = policy.blocked_command_tokens.find((token: string) => token && cmd.includes(token));
  const allowed = !blockedToken;
  const row = {
    ok: true,
    type: 'execution_sandbox_envelope_workflow',
    ts: nowIso(),
    mode: cleanText(policy.mode || 'enforce', 40) || 'enforce',
    step_id: stepId,
    step_type: stepType,
    command: cleanText(args.command || '', 500),
    profile_id: profileId || null,
    profile: profile || null,
    allowed,
    reason: allowed ? 'ok' : 'blocked_command_token',
    blocked_token: blockedToken || null
  };
  writeDecision(policy, row, apply);
  return row;
}

function decideActuation(policy: any, args: any, apply: boolean) {
  const kind = normalizeToken(args.kind || 'unknown', 120) || 'unknown';
  const context = parseContext(args.context || args.context_json);
  const riskClass = normalizeToken(context.risk_class || context.riskClass || 'normal', 80) || 'normal';
  const highRisk = policy.high_risk_actuation_classes.includes(riskClass);
  const approved = context.sandbox_approval === true || context.approval === true;
  const deniedByRiskGate = highRisk && policy.require_approval_for_high_risk_actuation && !approved;
  const profileId = normalizeToken(policy.actuation_profile || '', 120) || null;
  const profile = profileId && policy.profiles && policy.profiles[profileId]
    ? policy.profiles[profileId]
    : null;
  const row = {
    ok: true,
    type: 'execution_sandbox_envelope_actuation',
    ts: nowIso(),
    mode: cleanText(policy.mode || 'enforce', 40) || 'enforce',
    kind,
    risk_class: riskClass,
    profile_id: profileId,
    profile,
    allowed: !deniedByRiskGate,
    reason: deniedByRiskGate ? 'high_risk_approval_required' : 'ok',
    context
  };
  writeDecision(policy, row, apply);
  return row;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (args.help || cmd === 'help') {
    usage();
    emit({ ok: true, type: 'execution_sandbox_envelope_help' }, 0);
  }

  const policy = loadPolicy();
  if (policy.enabled === false) {
    emit({ ok: false, type: 'execution_sandbox_envelope_error', error: 'lane_disabled' }, 2);
  }
  const apply = toBool(args.apply, true);

  if (cmd === 'evaluate-workflow') {
    const row = decideWorkflow(policy, args, apply);
    emit(row, row.allowed ? 0 : 1);
  }

  if (cmd === 'evaluate-actuation') {
    const row = decideActuation(policy, args, apply);
    emit(row, row.allowed ? 0 : 1);
  }

  if (cmd === 'status') {
    const latest = readJson(policy.paths.latest_path, {});
    emit({
      ok: true,
      type: 'execution_sandbox_envelope_status',
      ts: nowIso(),
      latest
    }, 0);
  }

  emit({ ok: false, type: 'execution_sandbox_envelope_error', error: 'unsupported_command', cmd }, 2);
}

main();
