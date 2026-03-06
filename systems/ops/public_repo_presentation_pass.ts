#!/usr/bin/env node
'use strict';
export {};

/**
 * V4-CLEAN-005
 * Public repo presentation pass (non-destructive).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
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

const DEFAULT_POLICY_PATH = process.env.PUBLIC_REPO_PRESENTATION_POLICY_PATH
  ? path.resolve(process.env.PUBLIC_REPO_PRESENTATION_POLICY_PATH)
  : path.join(ROOT, 'config', 'public_repo_presentation_pass_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/public_repo_presentation_pass.js verify [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/public_repo_presentation_pass.js status [--policy=<path>]');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    checklist_path: 'docs/PUBLIC_REPO_PRESENTATION_CHECKLIST.md',
    gitattributes_path: '.gitattributes',
    root_contract_script: 'systems/ops/root_surface_contract.js',
    docs_contract_script: 'systems/ops/docs_surface_contract.js',
    readme_path: 'README.md',
    readme_required_links: [
      'docs/README.md',
      'docs/PUBLIC_OPERATOR_PROFILE.md',
      'docs/ONBOARDING_PLAYBOOK.md'
    ],
    forbidden_history_rewrite_tokens: ['commit --amend', 'push --force', 'reset --hard'],
    paths: {
      latest_path: 'state/ops/public_repo_presentation_pass/latest.json',
      history_path: 'state/ops/public_repo_presentation_pass/history.jsonl',
      verification_bundle_path: 'state/ops/public_repo_presentation_pass/verification_bundle.json'
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
    checklist_path: resolvePath(raw.checklist_path, base.checklist_path),
    gitattributes_path: resolvePath(raw.gitattributes_path, base.gitattributes_path),
    root_contract_script: resolvePath(raw.root_contract_script, base.root_contract_script),
    docs_contract_script: resolvePath(raw.docs_contract_script, base.docs_contract_script),
    readme_path: resolvePath(raw.readme_path, base.readme_path),
    readme_required_links: Array.isArray(raw.readme_required_links) && raw.readme_required_links.length
      ? raw.readme_required_links.map((v: unknown) => cleanText(v, 260)).filter(Boolean)
      : base.readme_required_links,
    forbidden_history_rewrite_tokens: Array.isArray(raw.forbidden_history_rewrite_tokens) && raw.forbidden_history_rewrite_tokens.length
      ? raw.forbidden_history_rewrite_tokens.map((v: unknown) => cleanText(v, 120).toLowerCase()).filter(Boolean)
      : base.forbidden_history_rewrite_tokens,
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path),
      verification_bundle_path: resolvePath(paths.verification_bundle_path, base.paths.verification_bundle_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function runContract(scriptPath: string) {
  if (!fs.existsSync(scriptPath)) return { ok: false, status: 1, reason: 'script_missing' };
  const proc = spawnSync(process.execPath, [scriptPath, 'check', '--strict=1'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    ok: Number(proc.status || 0) === 0,
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1
  };
}

function verify(policy: AnyObj) {
  if (policy.enabled !== true) {
    return {
      ok: true,
      type: 'public_repo_presentation_pass',
      ts: nowIso(),
      result: 'disabled_by_policy'
    };
  }

  const checklistText = fs.existsSync(policy.checklist_path)
    ? String(fs.readFileSync(policy.checklist_path, 'utf8') || '')
    : '';
  const gitattributesText = fs.existsSync(policy.gitattributes_path)
    ? String(fs.readFileSync(policy.gitattributes_path, 'utf8') || '')
    : '';
  const readmeText = fs.existsSync(policy.readme_path)
    ? String(fs.readFileSync(policy.readme_path, 'utf8') || '')
    : '';

  const rootContract = runContract(policy.root_contract_script);
  const docsContract = runContract(policy.docs_contract_script);

  const missingReadmeLinks = policy.readme_required_links.filter((target: string) => !readmeText.includes(target));
  const linguistRulesPresent = gitattributesText.toLowerCase().includes('linguist');

  const lowerChecklist = checklistText.toLowerCase();
  const missingNonRewriteClauses = policy.forbidden_history_rewrite_tokens
    .filter((token: string) => !lowerChecklist.includes(token));

  const checks = {
    checklist_present: checklistText.length > 0,
    linguist_rules_present: linguistRulesPresent,
    readme_links_present: missingReadmeLinks.length === 0,
    root_surface_contract_pass: rootContract.ok,
    docs_surface_contract_pass: docsContract.ok,
    non_rewrite_policy_documented: missingNonRewriteClauses.length === 0
  };

  const blockingChecks = Object.entries(checks).filter(([, ok]) => ok !== true).map(([id]) => id);
  const pass = blockingChecks.length === 0;

  const bundle = {
    ts: nowIso(),
    lane_id: 'V4-CLEAN-005',
    checks,
    missing_readme_links: missingReadmeLinks,
    missing_non_rewrite_clauses: missingNonRewriteClauses,
    contracts: {
      root_contract: rootContract,
      docs_contract: docsContract
    },
    artifacts: {
      checklist_path: rel(policy.checklist_path),
      gitattributes_path: rel(policy.gitattributes_path),
      readme_path: rel(policy.readme_path)
    }
  };
  writeJsonAtomic(policy.paths.verification_bundle_path, bundle);

  return {
    ok: pass,
    pass,
    type: 'public_repo_presentation_pass',
    lane_id: 'V4-CLEAN-005',
    ts: bundle.ts,
    checks,
    blocking_checks: blockingChecks,
    missing_readme_links: missingReadmeLinks,
    missing_non_rewrite_clauses: missingNonRewriteClauses,
    verification_bundle_path: rel(policy.paths.verification_bundle_path),
    verification_receipt_id: `repo_presentation_${stableHash(JSON.stringify(bundle), 14)}`
  };
}

function cmdVerify(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const strict = toBool(args.strict, true);
  const out = verify(policy);

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.history_path, {
    ts: out.ts,
    type: out.type,
    ok: out.ok,
    blocking_checks: out.blocking_checks
  });

  emit({
    ...out,
    policy_path: rel(policy.policy_path),
    latest_path: rel(policy.paths.latest_path)
  }, out.ok || !strict ? 0 : 1);
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  emit({
    ok: true,
    type: 'public_repo_presentation_pass_status',
    ts: nowIso(),
    latest: readJson(policy.paths.latest_path, null),
    policy_path: rel(policy.policy_path),
    latest_path: rel(policy.paths.latest_path),
    verification_bundle_path: rel(policy.paths.verification_bundle_path)
  }, 0);
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
