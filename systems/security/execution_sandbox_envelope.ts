#!/usr/bin/env node
'use strict';
export {};

/**
 * execution_sandbox_envelope.js
 *
 * V3-024: policy-selected sandbox envelope for workflow + actuation execution.
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.EXECUTION_SANDBOX_ENVELOPE_POLICY_PATH
  ? path.resolve(String(process.env.EXECUTION_SANDBOX_ENVELOPE_POLICY_PATH))
  : path.join(ROOT, 'config', 'execution_sandbox_envelope_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function clean(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return clean(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok || '').slice(2)] = true;
    else out[String(tok || '').slice(2, idx)] = String(tok || '').slice(idx + 1);
  }
  return out;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function resolvePath(v: unknown, fallbackRel: string) {
  const text = clean(v || fallbackRel, 320);
  return path.isAbsolute(text) ? path.resolve(text) : path.join(ROOT, text);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    mode: 'enforce',
    default_host_fs_access: false,
    default_network_access: false,
    profiles: {
      workflow_container_strict: {
        runtime: 'container',
        isolation: ['seccomp', 'apparmor'],
        host_fs_access: false,
        network_access: false,
        capability_manifest: ['exec:bounded', 'fs:workspace_read', 'fs:workspace_write_ephemeral', 'net:none']
      },
      actuation_container_strict: {
        runtime: 'container',
        isolation: ['seccomp', 'apparmor'],
        host_fs_access: false,
        network_access: false,
        capability_manifest: ['exec:adapter_only', 'fs:workspace_read', 'fs:workspace_write_ephemeral', 'net:deny_default']
      },
      simulation_sandbox: {
        runtime: 'container',
        isolation: ['seccomp', 'apparmor'],
        host_fs_access: false,
        network_access: false,
        capability_manifest: ['exec:simulation_only', 'fs:none', 'net:none']
      }
    },
    workflow_profile_map: {
      command: 'workflow_container_strict',
      receipt: 'simulation_sandbox'
    },
    actuation_profile: 'actuation_container_strict',
    blocked_command_tokens: [
      'sudo',
      '--privileged',
      'mount ',
      'chroot',
      'nsenter',
      'rm -rf /',
      '/etc/',
      '/root/',
      '/proc/',
      '/sys/',
      '/dev/',
      'iptables',
      'nft ',
      'docker run'
    ],
    high_risk_actuation_classes: ['payments', 'auth', 'filesystem', 'shell', 'network-control'],
    require_approval_for_high_risk_actuation: true,
    paths: {
      latest_path: 'state/security/execution_sandbox_envelope/latest.json',
      audit_path: 'state/security/execution_sandbox_envelope/audit.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const profilesRaw = raw.profiles && typeof raw.profiles === 'object' ? raw.profiles : base.profiles;
  const profiles: Record<string, AnyObj> = {};
  for (const [idRaw, rowRaw] of Object.entries(profilesRaw)) {
    const id = normalizeToken(idRaw, 80);
    if (!id) continue;
    const row = rowRaw && typeof rowRaw === 'object' ? rowRaw as AnyObj : {};
    profiles[id] = {
      runtime: clean(row.runtime || 'container', 40) || 'container',
      isolation: Array.isArray(row.isolation)
        ? row.isolation.map((v: unknown) => clean(v, 40)).filter(Boolean)
        : ['seccomp', 'apparmor'],
      host_fs_access: row.host_fs_access === true,
      network_access: row.network_access === true,
      capability_manifest: Array.isArray(row.capability_manifest)
        ? row.capability_manifest.map((v: unknown) => clean(v, 120)).filter(Boolean)
        : []
    };
  }
  const pathsRaw = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: clean(raw.version || base.version, 24) || '1.0',
    enabled: raw.enabled !== false,
    mode: ['enforce', 'advisory'].includes(normalizeToken(raw.mode || '', 20))
      ? normalizeToken(raw.mode || '', 20)
      : base.mode,
    default_host_fs_access: raw.default_host_fs_access === true,
    default_network_access: raw.default_network_access === true,
    profiles,
    workflow_profile_map: raw.workflow_profile_map && typeof raw.workflow_profile_map === 'object'
      ? raw.workflow_profile_map
      : base.workflow_profile_map,
    actuation_profile: normalizeToken(raw.actuation_profile || base.actuation_profile, 80) || base.actuation_profile,
    blocked_command_tokens: Array.isArray(raw.blocked_command_tokens)
      ? raw.blocked_command_tokens.map((v: unknown) => String(v || '').toLowerCase().trim()).filter(Boolean)
      : base.blocked_command_tokens,
    high_risk_actuation_classes: Array.isArray(raw.high_risk_actuation_classes)
      ? raw.high_risk_actuation_classes.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean)
      : base.high_risk_actuation_classes,
    require_approval_for_high_risk_actuation: raw.require_approval_for_high_risk_actuation !== false,
    paths: {
      latest_path: resolvePath(pathsRaw.latest_path, base.paths.latest_path),
      audit_path: resolvePath(pathsRaw.audit_path, base.paths.audit_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function chooseWorkflowProfile(policy: AnyObj, step: AnyObj, dryRun: boolean) {
  if (dryRun) return 'simulation_sandbox';
  const type = normalizeToken(step && step.type ? step.type : 'command', 40) || 'command';
  const mapped = normalizeToken(policy.workflow_profile_map && policy.workflow_profile_map[type], 80);
  return mapped || 'workflow_container_strict';
}

function escapeRegex(text: string) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenMatches(lowerText: string, blockedToken: string) {
  const token = String(blockedToken || '').toLowerCase();
  if (!token) return false;
  // Plain alpha-numeric tokens are matched on word-ish boundaries
  // to avoid false positives like "amount" matching "mount".
  if (/^[a-z0-9_-]+$/.test(token)) {
    const re = new RegExp(`(?:^|[^a-z0-9_-])${escapeRegex(token)}(?:$|[^a-z0-9_-])`, 'i');
    return re.test(lowerText);
  }
  return lowerText.includes(token);
}

function detectEscapeAttempt(command: string, blockedTokens: string[]) {
  const lower = String(command || '').toLowerCase();
  const hits = blockedTokens.filter((t) => tokenMatches(lower, String(t || '').toLowerCase()));
  return {
    blocked: hits.length > 0,
    tokens: hits
  };
}

function baseDecision(policy: AnyObj, profileId: string, actionType: string, commandText = '') {
  const profile = policy.profiles && policy.profiles[profileId] ? policy.profiles[profileId] : null;
  const denyReasons: string[] = [];
  if (!profile) denyReasons.push('sandbox_profile_missing');
  const escape = detectEscapeAttempt(commandText, policy.blocked_command_tokens || []);
  if (escape.blocked) denyReasons.push(`sandbox_escape_attempt_denied:${escape.tokens.join(',')}`);
  if (profile && profile.host_fs_access === true && policy.default_host_fs_access !== true) {
    denyReasons.push('host_fs_access_denied_by_default');
  }
  if (profile && profile.network_access === true && policy.default_network_access !== true) {
    denyReasons.push('network_access_denied_by_default');
  }
  const allowed = denyReasons.length === 0;
  return {
    ok: allowed,
    allowed,
    mode: clean(policy.mode || 'enforce', 20) || 'enforce',
    action_type: actionType,
    profile_id: profileId,
    profile: profile || null,
    capability_manifest: profile && Array.isArray(profile.capability_manifest) ? profile.capability_manifest : [],
    deny_reasons: denyReasons,
    runtime: profile ? clean(profile.runtime || 'container', 40) : 'unknown',
    isolation: profile && Array.isArray(profile.isolation) ? profile.isolation : []
  };
}

function auditDecision(policy: AnyObj, row: AnyObj) {
  const out = {
    ts: nowIso(),
    type: 'execution_sandbox_envelope',
    policy_version: policy.version,
    ...row
  };
  appendJsonl(policy.paths.audit_path, out);
  ensureDir(path.dirname(policy.paths.latest_path));
  fs.writeFileSync(policy.paths.latest_path, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
}

function evaluateWorkflowSandbox(input: AnyObj, opts: AnyObj = {}) {
  const policy = loadPolicy(opts.policy_path ? path.resolve(String(opts.policy_path)) : DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    return {
      ok: true,
      allowed: true,
      mode: 'disabled',
      action_type: 'workflow_step',
      profile_id: null,
      capability_manifest: [],
      deny_reasons: []
    };
  }
  const step = input && typeof input === 'object' ? (input.step || {}) : {};
  const command = clean(input && input.command || '', 1000);
  const dryRun = input && input.dry_run === true;
  const profileId = chooseWorkflowProfile(policy, step, dryRun);
  const decision = baseDecision(policy, profileId, 'workflow_step', command);
  const enforceDeny = policy.mode === 'enforce' && decision.allowed !== true;
  const out = {
    ...decision,
    denied: enforceDeny,
    step_id: clean(step && step.id || '', 80) || null,
    command_sample: clean(command, 180)
  };
  auditDecision(policy, out);
  return out;
}

function evaluateActuationSandbox(input: AnyObj, opts: AnyObj = {}) {
  const policy = loadPolicy(opts.policy_path ? path.resolve(String(opts.policy_path)) : DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    return {
      ok: true,
      allowed: true,
      mode: 'disabled',
      action_type: 'actuation',
      profile_id: null,
      capability_manifest: [],
      deny_reasons: []
    };
  }
  const kind = normalizeToken(input && input.kind || '', 120);
  const context = input && typeof input.context === 'object' ? input.context : {};
  const dryRun = input && input.dry_run === true;
  const profileId = dryRun ? 'simulation_sandbox' : policy.actuation_profile;
  const decision = baseDecision(policy, profileId, 'actuation', JSON.stringify({ kind, params: input && input.params || {} }));

  const riskClass = normalizeToken(context && context.risk_class || context && context.class || '', 80);
  const highRisk = policy.high_risk_actuation_classes.includes(riskClass);
  if (highRisk && policy.require_approval_for_high_risk_actuation === true) {
    const approved = context && context.sandbox_approval === true;
    if (!approved) decision.deny_reasons.push('high_risk_actuation_requires_sandbox_approval');
  }

  decision.allowed = decision.deny_reasons.length === 0;
  decision.ok = decision.allowed;
  const enforceDeny = policy.mode === 'enforce' && decision.allowed !== true;
  const out = {
    ...decision,
    denied: enforceDeny,
    kind,
    risk_class: riskClass || null
  };
  auditDecision(policy, out);
  return out;
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = readJson(policy.paths.latest_path, null);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'execution_sandbox_envelope_status',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    enabled: policy.enabled,
    mode: policy.mode,
    profile_count: Object.keys(policy.profiles || {}).length,
    latest,
    paths: {
      latest_path: rel(policy.paths.latest_path),
      audit_path: rel(policy.paths.audit_path)
    }
  }, null, 2)}\n`);
}

function cmdEvalWorkflow(args: AnyObj) {
  const out = evaluateWorkflowSandbox({
    step: {
      id: clean(args['step-id'] || '', 80),
      type: clean(args['step-type'] || 'command', 40)
    },
    command: clean(args.command || '', 1000),
    dry_run: toBool(args['dry-run'], false)
  }, {
    policy_path: args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH
  });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (out.denied === true) process.exit(1);
}

function cmdEvalActuation(args: AnyObj) {
  let context = {};
  if (args.context) {
    try { context = JSON.parse(String(args.context)); } catch { context = {}; }
  }
  const out = evaluateActuationSandbox({
    kind: clean(args.kind || '', 120),
    params: {},
    context,
    dry_run: toBool(args['dry-run'], false)
  }, {
    policy_path: args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH
  });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (out.denied === true) process.exit(1);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/execution_sandbox_envelope.js status');
  console.log('  node systems/security/execution_sandbox_envelope.js evaluate-workflow --step-id=<id> --step-type=command|receipt --command="..." [--dry-run=1|0]');
  console.log('  node systems/security/execution_sandbox_envelope.js evaluate-actuation --kind=<adapter> [--context=<json>] [--dry-run=1|0]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'status') return cmdStatus(args);
  if (cmd === 'evaluate-workflow') return cmdEvalWorkflow(args);
  if (cmd === 'evaluate-actuation') return cmdEvalActuation(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  evaluateWorkflowSandbox,
  evaluateActuationSandbox
};
