#!/usr/bin/env node
'use strict';
export {};

/**
 * V4-FORT-002
 * Enterprise onboarding pack verification.
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  cleanText,
  toBool,
  parseArgs,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

type AnyObj = Record<string, any>;

const DEFAULT_POLICY_PATH = process.env.ENTERPRISE_ONBOARDING_PACK_POLICY_PATH
  ? path.resolve(process.env.ENTERPRISE_ONBOARDING_PACK_POLICY_PATH)
  : path.join(ROOT, 'config', 'enterprise_onboarding_pack_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/enterprise_onboarding_pack.js verify [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/enterprise_onboarding_pack.js status [--policy=<path>]');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function readText(filePath: string) {
  try {
    return fs.existsSync(filePath) ? String(fs.readFileSync(filePath, 'utf8') || '') : '';
  } catch {
    return '';
  }
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    onboarding_docs: ['docs/ONBOARDING_PLAYBOOK.md', 'docs/ENTERPRISE_ONBOARDING_PACK.md'],
    required_roles: ['Operator', 'Platform Engineer', 'External Contributor'],
    required_milestones: ['Day 0', 'Day 7', 'Day 30'],
    required_terms: ['prerequisites', 'safety gates', 'success criteria', 'bootstrap', 'ci', 'escalation'],
    paths: {
      latest_path: 'state/ops/enterprise_onboarding_pack/latest.json',
      history_path: 'state/ops/enterprise_onboarding_pack/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    onboarding_docs: Array.isArray(raw.onboarding_docs) && raw.onboarding_docs.length
      ? raw.onboarding_docs.map((v: unknown) => cleanText(v, 260)).filter(Boolean)
      : base.onboarding_docs,
    required_roles: Array.isArray(raw.required_roles) && raw.required_roles.length
      ? raw.required_roles.map((v: unknown) => cleanText(v, 120)).filter(Boolean)
      : base.required_roles,
    required_milestones: Array.isArray(raw.required_milestones) && raw.required_milestones.length
      ? raw.required_milestones.map((v: unknown) => cleanText(v, 80)).filter(Boolean)
      : base.required_milestones,
    required_terms: Array.isArray(raw.required_terms) && raw.required_terms.length
      ? raw.required_terms.map((v: unknown) => cleanText(v, 120).toLowerCase()).filter(Boolean)
      : base.required_terms,
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function verify(policy: AnyObj) {
  if (policy.enabled !== true) {
    return { ok: true, type: 'enterprise_onboarding_pack', ts: nowIso(), result: 'disabled_by_policy' };
  }

  const missingDocs = policy.onboarding_docs
    .map((docRel: string) => ({ rel: docRel, abs: path.join(ROOT, docRel) }))
    .filter((row: AnyObj) => !fs.existsSync(row.abs))
    .map((row: AnyObj) => row.rel);

  const combined = policy.onboarding_docs
    .map((docRel: string) => readText(path.join(ROOT, docRel)).toLowerCase())
    .join('\n');

  const missingRoles = policy.required_roles.filter((role: string) => !combined.includes(role.toLowerCase()));
  const missingMilestones = policy.required_milestones.filter((ms: string) => !combined.includes(ms.toLowerCase()));
  const missingTerms = policy.required_terms.filter((term: string) => !combined.includes(term.toLowerCase()));

  const checks = {
    onboarding_docs_present: missingDocs.length === 0,
    roles_present: missingRoles.length === 0,
    milestones_present: missingMilestones.length === 0,
    onboarding_terms_present: missingTerms.length === 0
  };
  const blockingChecks = Object.entries(checks).filter(([, ok]) => ok !== true).map(([id]) => id);
  const pass = blockingChecks.length === 0;

  return {
    ok: pass,
    pass,
    type: 'enterprise_onboarding_pack',
    lane_id: 'V4-FORT-002',
    ts: nowIso(),
    checks,
    blocking_checks: blockingChecks,
    missing_docs: missingDocs,
    missing_roles: missingRoles,
    missing_milestones: missingMilestones,
    missing_terms: missingTerms,
    verification_receipt_id: `onboarding_pack_${stableHash(JSON.stringify({ missingDocs, missingRoles, missingMilestones, missingTerms }), 14)}`
  };
}

function cmdVerify(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const strict = toBool(args.strict, true);
  const out = verify(policy);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.history_path, { ts: out.ts, type: out.type, ok: out.ok, blocking_checks: out.blocking_checks });
  emit({ ...out, policy_path: rel(policy.policy_path), latest_path: rel(policy.paths.latest_path) }, out.ok || !strict ? 0 : 1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  emit({ ok: true, type: 'enterprise_onboarding_pack_status', ts: nowIso(), latest: readJson(policy.paths.latest_path, null), policy_path: rel(policy.policy_path) }, 0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'status', 80).toLowerCase();
  if (args.help || ['help', '--help', '-h'].includes(cmd)) {
    usage();
    process.exit(0);
  }
  if (cmd === 'verify' || cmd === 'run') return cmdVerify(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  emit({ ok: false, error: `unknown_command:${cmd}` }, 2);
}

main();
