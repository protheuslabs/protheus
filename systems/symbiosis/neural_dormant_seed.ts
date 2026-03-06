#!/usr/bin/env node
'use strict';
export {};

/**
 * neural_dormant_seed.js
 *
 * V3-023: pre-neural dormant seed (research-only, locked).
 *
 * Commands:
 *   node systems/symbiosis/neural_dormant_seed.js status [--profile=prod|dev|sim]
 *   node systems/symbiosis/neural_dormant_seed.js check [--strict=1|0] [--profile=prod|dev|sim]
 *   node systems/symbiosis/neural_dormant_seed.js request-sim --purpose="..."
 *   node systems/symbiosis/neural_dormant_seed.js request-live --purpose="..." [--approval-note="..."]
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.NEURAL_DORMANT_SEED_POLICY_PATH
  ? path.resolve(String(process.env.NEURAL_DORMANT_SEED_POLICY_PATH))
  : path.join(ROOT, 'config', 'neural_dormant_seed_policy.json');

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

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
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
    locked: true,
    allow_simulated_prototypes: true,
    allow_non_simulated_prototypes: false,
    blocked_runtime_profiles: ['prod', 'default', 'phone_seed', 'live'],
    required_governance_checks: [
      'ethics_review',
      'security_review',
      'consent_model_review',
      'rollback_plan_review',
      'human_signoff'
    ],
    paths: {
      research_spec: 'research/neural_dormant_seed/README.md',
      governance_checklist: 'research/neural_dormant_seed/governance_checklist.md',
      state: 'state/symbiosis/neural_dormant_seed/latest.json',
      history: 'state/symbiosis/neural_dormant_seed/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const pathsRaw = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const blocked = Array.isArray(raw.blocked_runtime_profiles)
    ? raw.blocked_runtime_profiles.map((v: unknown) => normalizeToken(v, 60)).filter(Boolean)
    : base.blocked_runtime_profiles;
  const required = Array.isArray(raw.required_governance_checks)
    ? raw.required_governance_checks.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean)
    : base.required_governance_checks;
  return {
    version: clean(raw.version || base.version, 24) || '1.0',
    enabled: raw.enabled !== false,
    locked: raw.locked !== false,
    allow_simulated_prototypes: raw.allow_simulated_prototypes !== false,
    allow_non_simulated_prototypes: raw.allow_non_simulated_prototypes === true,
    blocked_runtime_profiles: blocked.length ? blocked : base.blocked_runtime_profiles,
    required_governance_checks: required.length ? required : base.required_governance_checks,
    paths: {
      research_spec: resolvePath(pathsRaw.research_spec, base.paths.research_spec),
      governance_checklist: resolvePath(pathsRaw.governance_checklist, base.paths.governance_checklist),
      state: resolvePath(pathsRaw.state, base.paths.state),
      history: resolvePath(pathsRaw.history, base.paths.history)
    },
    policy_path: path.resolve(policyPath)
  };
}

function deriveStatus(policy: AnyObj, profileRaw: unknown) {
  const profile = normalizeToken(profileRaw || process.env.PROTHEUS_PROFILE || 'prod', 40) || 'prod';
  const profileBlocked = policy.blocked_runtime_profiles.includes(profile);
  const specExists = fs.existsSync(policy.paths.research_spec);
  const checklistExists = fs.existsSync(policy.paths.governance_checklist);
  const noRuntimeActivationPath = policy.locked === true || profileBlocked || policy.allow_non_simulated_prototypes !== true;
  const activationAllowed = policy.enabled === true
    && policy.locked !== true
    && profileBlocked !== true
    && policy.allow_non_simulated_prototypes === true;

  return {
    ok: true,
    type: 'neural_dormant_seed_status',
    ts: nowIso(),
    profile,
    locked: policy.locked === true,
    profile_blocked: profileBlocked,
    no_runtime_activation_path: noRuntimeActivationPath,
    activation_allowed: activationAllowed,
    research_artifacts_ready: specExists && checklistExists,
    checklist_required: policy.required_governance_checks,
    paths: {
      policy_path: rel(policy.policy_path),
      research_spec: rel(policy.paths.research_spec),
      governance_checklist: rel(policy.paths.governance_checklist),
      state_path: rel(policy.paths.state),
      history_path: rel(policy.paths.history)
    }
  };
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const status = deriveStatus(policy, args.profile);
  writeJsonAtomic(policy.paths.state, status);
  appendJsonl(policy.paths.history, status);
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
}

function cmdCheck(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const status = deriveStatus(policy, args.profile);
  const strict = toBool(args.strict, false);
  const pass = status.locked === true
    && status.no_runtime_activation_path === true
    && status.research_artifacts_ready === true
    && status.checklist_required.length >= 3;
  const payload = {
    ...status,
    type: 'neural_dormant_seed_check',
    pass,
    reasons: pass ? [] : [
      ...(status.locked === true ? [] : ['policy_not_locked']),
      ...(status.no_runtime_activation_path === true ? [] : ['runtime_activation_path_present']),
      ...(status.research_artifacts_ready === true ? [] : ['research_artifacts_missing']),
      ...(status.checklist_required.length >= 3 ? [] : ['governance_checklist_too_shallow'])
    ]
  };
  writeJsonAtomic(policy.paths.state, payload);
  appendJsonl(policy.paths.history, payload);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (strict && payload.pass !== true) process.exit(1);
}

function cmdRequestSim(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const purpose = clean(args.purpose || '', 320);
  if (!purpose) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'neural_dormant_seed_request_sim', error: 'missing_purpose', required: ['--purpose'] }, null, 2)}\n`);
    process.exit(2);
  }
  const allowed = policy.enabled === true && policy.allow_simulated_prototypes === true;
  const payload = {
    ok: allowed,
    type: 'neural_dormant_seed_request_sim',
    ts: nowIso(),
    purpose,
    allowed,
    mode: 'simulation_only',
    reason: allowed ? 'simulation_allowed' : 'simulation_disabled_by_policy'
  };
  appendJsonl(policy.paths.history, payload);
  writeJsonAtomic(policy.paths.state, payload);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (!allowed) process.exit(1);
}

function cmdRequestLive(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const purpose = clean(args.purpose || '', 320);
  const approvalNote = clean(args['approval-note'] || args.approval_note || '', 320);
  const status = deriveStatus(policy, args.profile);
  const allowed = status.activation_allowed === true;
  const payload = {
    ok: allowed,
    type: 'neural_dormant_seed_request_live',
    ts: nowIso(),
    purpose,
    approval_note: approvalNote,
    allowed,
    reason: allowed ? 'live_allowed' : 'live_denied_policy_locked_or_profile_blocked',
    status
  };
  appendJsonl(policy.paths.history, payload);
  writeJsonAtomic(policy.paths.state, payload);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (!allowed) process.exit(1);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/symbiosis/neural_dormant_seed.js status [--profile=prod|dev|sim]');
  console.log('  node systems/symbiosis/neural_dormant_seed.js check [--strict=1|0] [--profile=prod|dev|sim]');
  console.log('  node systems/symbiosis/neural_dormant_seed.js request-sim --purpose="..."');
  console.log('  node systems/symbiosis/neural_dormant_seed.js request-live --purpose="..." [--approval-note="..."]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'status') return cmdStatus(args);
  if (cmd === 'check') return cmdCheck(args);
  if (cmd === 'request-sim') return cmdRequestSim(args);
  if (cmd === 'request-live') return cmdRequestLive(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
