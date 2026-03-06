#!/usr/bin/env node
'use strict';
export {};

/**
 * V4-FORT-005
 * Public collaboration surface verification pack.
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

const DEFAULT_POLICY_PATH = process.env.PUBLIC_COLLABORATION_SURFACE_PACK_POLICY_PATH
  ? path.resolve(process.env.PUBLIC_COLLABORATION_SURFACE_PACK_POLICY_PATH)
  : path.join(ROOT, 'config', 'public_collaboration_surface_pack_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/public_collaboration_surface_pack.js verify [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/public_collaboration_surface_pack.js status [--policy=<path>]');
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
    required_files: [
      '.github/ISSUE_TEMPLATE/bug_report.md',
      '.github/ISSUE_TEMPLATE/feature_request.md',
      '.github/ISSUE_TEMPLATE/security_report.md',
      '.github/ISSUE_TEMPLATE/config.yml',
      'docs/PUBLIC_COLLABORATION_TRIAGE.md',
      'docs/PUBLIC_COLLABORATION_SURFACE.md'
    ],
    triage_doc: 'docs/PUBLIC_COLLABORATION_TRIAGE.md',
    contributing_doc: 'CONTRIBUTING.md',
    required_labels: [
      'type:bug',
      'type:feature',
      'type:security',
      'state:needs-repro',
      'state:needs-design',
      'priority:p0',
      'priority:p1',
      'priority:p2'
    ],
    required_sla_terms: [
      '2 business days',
      '5 business days',
      '10 business days'
    ],
    required_template_links: [
      '.github/ISSUE_TEMPLATE/bug_report.md',
      '.github/ISSUE_TEMPLATE/feature_request.md',
      '.github/ISSUE_TEMPLATE/security_report.md'
    ],
    required_governance_links: [
      'docs/PUBLIC_COLLABORATION_TRIAGE.md',
      'docs/CLAIM_EVIDENCE_POLICY.md',
      'docs/DOCUMENTATION_PROGRAM_GOVERNANCE.md'
    ],
    paths: {
      latest_path: 'state/ops/public_collaboration_surface_pack/latest.json',
      history_path: 'state/ops/public_collaboration_surface_pack/history.jsonl'
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
    required_files: Array.isArray(raw.required_files) && raw.required_files.length
      ? raw.required_files.map((v: unknown) => cleanText(v, 260)).filter(Boolean)
      : base.required_files,
    triage_doc: resolvePath(raw.triage_doc, base.triage_doc),
    contributing_doc: resolvePath(raw.contributing_doc, base.contributing_doc),
    required_labels: Array.isArray(raw.required_labels) && raw.required_labels.length
      ? raw.required_labels.map((v: unknown) => cleanText(v, 120)).filter(Boolean)
      : base.required_labels,
    required_sla_terms: Array.isArray(raw.required_sla_terms) && raw.required_sla_terms.length
      ? raw.required_sla_terms.map((v: unknown) => cleanText(v, 120).toLowerCase()).filter(Boolean)
      : base.required_sla_terms,
    required_template_links: Array.isArray(raw.required_template_links) && raw.required_template_links.length
      ? raw.required_template_links.map((v: unknown) => cleanText(v, 260)).filter(Boolean)
      : base.required_template_links,
    required_governance_links: Array.isArray(raw.required_governance_links) && raw.required_governance_links.length
      ? raw.required_governance_links.map((v: unknown) => cleanText(v, 260)).filter(Boolean)
      : base.required_governance_links,
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function verify(policy: AnyObj) {
  if (policy.enabled !== true) {
    return { ok: true, type: 'public_collaboration_surface_pack', ts: nowIso(), result: 'disabled_by_policy' };
  }

  const missingFiles = policy.required_files
    .map((relPath: string) => ({ rel: relPath, abs: path.join(ROOT, relPath) }))
    .filter((row: AnyObj) => !fs.existsSync(row.abs))
    .map((row: AnyObj) => row.rel);

  const templateText = policy.required_template_links
    .map((relPath: string) => readText(path.join(ROOT, relPath)).toLowerCase())
    .join('\n');
  const triageText = readText(policy.triage_doc).toLowerCase();
  const contributingText = readText(policy.contributing_doc);
  const configText = readText(path.join(ROOT, '.github/ISSUE_TEMPLATE/config.yml')).toLowerCase();

  const missingLabels = policy.required_labels.filter((label: string) => {
    const key = label.toLowerCase();
    return !templateText.includes(key) && !triageText.includes(key);
  });
  const missingSlaTerms = policy.required_sla_terms.filter((term: string) => !triageText.includes(term));
  const missingTemplateLinks = policy.required_template_links.filter((target: string) => !contributingText.includes(target));
  const missingGovernanceLinks = policy.required_governance_links.filter((target: string) => !contributingText.includes(target));
  const configHasNoBlankIssues = configText.includes('blank_issues_enabled: false');

  const checks = {
    required_files_present: missingFiles.length === 0,
    triage_labels_present: missingLabels.length === 0,
    triage_sla_terms_present: missingSlaTerms.length === 0,
    contributing_template_links_present: missingTemplateLinks.length === 0,
    contributing_governance_links_present: missingGovernanceLinks.length === 0,
    issue_config_hardening_present: configHasNoBlankIssues
  };
  const blockingChecks = Object.entries(checks).filter(([, ok]) => ok !== true).map(([id]) => id);
  const pass = blockingChecks.length === 0;

  return {
    ok: pass,
    pass,
    type: 'public_collaboration_surface_pack',
    lane_id: 'V4-FORT-005',
    ts: nowIso(),
    checks,
    blocking_checks: blockingChecks,
    missing_files: missingFiles,
    missing_labels: missingLabels,
    missing_sla_terms: missingSlaTerms,
    missing_template_links: missingTemplateLinks,
    missing_governance_links: missingGovernanceLinks,
    verification_receipt_id: `public_collab_${stableHash(JSON.stringify({
      missingFiles,
      missingLabels,
      missingSlaTerms,
      missingTemplateLinks,
      missingGovernanceLinks,
      configHasNoBlankIssues
    }), 14)}`
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
  emit({
    ok: true,
    type: 'public_collaboration_surface_pack_status',
    ts: nowIso(),
    latest: readJson(policy.paths.latest_path, null),
    policy_path: rel(policy.policy_path)
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
