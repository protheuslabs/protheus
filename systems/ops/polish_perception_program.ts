#!/usr/bin/env node
'use strict';
export {};

/**
 * V4-FORT-007
 * Polish/perception program verifier + monthly perception audit receipts.
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  cleanText,
  toBool,
  parseArgs,
  parseIsoMs,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

type AnyObj = Record<string, any>;

const DEFAULT_POLICY_PATH = process.env.POLISH_PERCEPTION_PROGRAM_POLICY_PATH
  ? path.resolve(process.env.POLISH_PERCEPTION_PROGRAM_POLICY_PATH)
  : path.join(ROOT, 'config', 'polish_perception_program_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/polish_perception_program.js audit [--policy=<path>]');
  console.log('  node systems/ops/polish_perception_program.js verify [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/polish_perception_program.js status [--policy=<path>]');
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
    required_docs: [
      'docs/ORG_CODE_FORMAT_STANDARD.md',
      'docs/PERCEPTION_AUDIT_PROGRAM.md',
      'docs/EMPTY_FORT_INTEGRITY_CHECKLIST.md'
    ],
    package_json_path: 'package.json',
    required_package_scripts: ['ops:format:check', 'lint'],
    ci_workflow_path: '.github/workflows/ci.yml',
    ci_required_commands: ['npm run ops:format:check', 'npm run lint'],
    pre_commit_path: '.githooks/pre-commit',
    pre_commit_required_commands: ['npm run ops:format:check', 'npm run lint'],
    templates: {
      '.github/pull_request_template.md': ['summary', 'roadmap', 'validation', 'risk'],
      '.github/ISSUE_TEMPLATE/bug_report.md': ['summary', 'reproduction steps', 'impact'],
      '.github/ISSUE_TEMPLATE/feature_request.md': ['problem statement', 'acceptance criteria', 'risks and tradeoffs'],
      'docs/release/templates/release_plan.md': ['scope', 'risk', 'rollback', 'claim-evidence matrix']
    },
    audit: {
      max_age_days: 31,
      min_score: 0.8
    },
    paths: {
      latest_path: 'state/ops/polish_perception_program/latest.json',
      history_path: 'state/ops/polish_perception_program/history.jsonl',
      audit_latest_path: 'state/ops/polish_perception_program/audit_latest.json',
      audit_history_path: 'state/ops/polish_perception_program/audit_history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const audit = raw.audit && typeof raw.audit === 'object' ? raw.audit : {};
  const templates = raw.templates && typeof raw.templates === 'object' ? raw.templates : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    required_docs: Array.isArray(raw.required_docs) && raw.required_docs.length
      ? raw.required_docs.map((v: unknown) => cleanText(v, 260)).filter(Boolean)
      : base.required_docs,
    package_json_path: resolvePath(raw.package_json_path, base.package_json_path),
    required_package_scripts: Array.isArray(raw.required_package_scripts) && raw.required_package_scripts.length
      ? raw.required_package_scripts.map((v: unknown) => cleanText(v, 120)).filter(Boolean)
      : base.required_package_scripts,
    ci_workflow_path: resolvePath(raw.ci_workflow_path, base.ci_workflow_path),
    ci_required_commands: Array.isArray(raw.ci_required_commands) && raw.ci_required_commands.length
      ? raw.ci_required_commands.map((v: unknown) => cleanText(v, 120)).filter(Boolean)
      : base.ci_required_commands,
    pre_commit_path: resolvePath(raw.pre_commit_path, base.pre_commit_path),
    pre_commit_required_commands: Array.isArray(raw.pre_commit_required_commands) && raw.pre_commit_required_commands.length
      ? raw.pre_commit_required_commands.map((v: unknown) => cleanText(v, 120)).filter(Boolean)
      : base.pre_commit_required_commands,
    templates: Object.keys(templates).length
      ? templates
      : base.templates,
    audit: {
      max_age_days: Number.isFinite(Number(audit.max_age_days)) ? Math.max(1, Math.floor(Number(audit.max_age_days))) : base.audit.max_age_days,
      min_score: Number.isFinite(Number(audit.min_score)) ? Math.max(0, Math.min(1, Number(audit.min_score))) : base.audit.min_score
    },
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path),
      audit_latest_path: resolvePath(paths.audit_latest_path, base.paths.audit_latest_path),
      audit_history_path: resolvePath(paths.audit_history_path, base.paths.audit_history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function runAudit(policy: AnyObj) {
  const readme = readText(path.join(ROOT, 'README.md'));
  const docsHub = readText(path.join(ROOT, 'docs/README.md'));
  const contributing = readText(path.join(ROOT, 'CONTRIBUTING.md'));
  const ciText = readText(policy.ci_workflow_path);
  const preCommitText = readText(policy.pre_commit_path);

  const checks = [
    { id: 'readme_links_style_guide', pass: readme.includes('docs/ORG_CODE_FORMAT_STANDARD.md') },
    { id: 'docs_hub_links_style_guide', pass: docsHub.includes('ORG_CODE_FORMAT_STANDARD.md') },
    { id: 'contributing_links_style_guide', pass: contributing.includes('docs/ORG_CODE_FORMAT_STANDARD.md') },
    { id: 'ci_has_format_guard', pass: ciText.includes('npm run ops:format:check') },
    { id: 'pre_commit_has_format_guard', pass: preCommitText.includes('npm run ops:format:check') },
    { id: 'pre_commit_has_lint', pass: preCommitText.includes('npm run lint') }
  ];
  const passed = checks.filter((row) => row.pass === true).length;
  const score = checks.length ? Number((passed / checks.length).toFixed(4)) : 1;
  const findings = checks.filter((row) => row.pass !== true).map((row) => ({
    id: row.id,
    severity: row.id.includes('ci') || row.id.includes('pre_commit') ? 'high' : 'medium',
    remediation: `address_${row.id}`
  }));

  const out = {
    ok: true,
    type: 'polish_perception_audit',
    ts: nowIso(),
    score,
    checks,
    findings,
    remediation_count: findings.length,
    audit_receipt_id: `perception_audit_${stableHash(JSON.stringify({ score, checks }), 14)}`
  };
  writeJsonAtomic(policy.paths.audit_latest_path, out);
  appendJsonl(policy.paths.audit_history_path, out);
  return out;
}

function verifyTemplates(policy: AnyObj) {
  const missing: AnyObj[] = [];
  const templates = policy.templates && typeof policy.templates === 'object' ? policy.templates : {};
  for (const templatePath of Object.keys(templates)) {
    const abs = path.join(ROOT, templatePath);
    const text = readText(abs).toLowerCase();
    if (!text) {
      missing.push({ file: templatePath, missing_terms: ['file_missing'] });
      continue;
    }
    const requiredTerms = Array.isArray(templates[templatePath]) ? templates[templatePath] : [];
    const missingTerms = requiredTerms
      .map((term: unknown) => cleanText(term, 120).toLowerCase())
      .filter(Boolean)
      .filter((term: string) => !text.includes(term));
    if (missingTerms.length) missing.push({ file: templatePath, missing_terms: missingTerms });
  }
  return missing;
}

function verify(policy: AnyObj) {
  if (policy.enabled !== true) return { ok: true, type: 'polish_perception_program', ts: nowIso(), result: 'disabled_by_policy' };

  const missingDocs = policy.required_docs
    .map((relPath: string) => ({ rel: relPath, abs: path.join(ROOT, relPath) }))
    .filter((row: AnyObj) => !fs.existsSync(row.abs))
    .map((row: AnyObj) => row.rel);

  const pkg = readJson(policy.package_json_path, {});
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const missingScripts = policy.required_package_scripts.filter((id: string) => !scripts[id]);

  const ciText = readText(policy.ci_workflow_path);
  const missingCiCommands = policy.ci_required_commands.filter((cmd: string) => !ciText.includes(cmd));

  const preCommitText = readText(policy.pre_commit_path);
  const missingPreCommitCommands = policy.pre_commit_required_commands.filter((cmd: string) => !preCommitText.includes(cmd));
  const templateFindings = verifyTemplates(policy);

  const auditLatest = readJson(policy.paths.audit_latest_path, null);
  const auditTsMs = auditLatest ? parseIsoMs(auditLatest.ts) : null;
  const maxAgeMs = policy.audit.max_age_days * 24 * 60 * 60 * 1000;
  const auditFresh = Number.isFinite(auditTsMs) ? (Date.now() - Number(auditTsMs)) <= maxAgeMs : false;
  const auditScore = auditLatest && Number.isFinite(Number(auditLatest.score)) ? Number(auditLatest.score) : null;
  const auditScorePass = auditScore == null ? false : auditScore >= policy.audit.min_score;

  const checks = {
    required_docs_present: missingDocs.length === 0,
    format_and_lint_scripts_present: missingScripts.length === 0,
    ci_gates_present: missingCiCommands.length === 0,
    pre_commit_gates_present: missingPreCommitCommands.length === 0,
    template_metadata_quality_present: templateFindings.length === 0,
    perception_audit_fresh: auditFresh,
    perception_audit_score_pass: auditScorePass
  };
  const blockingChecks = Object.entries(checks).filter(([, ok]) => ok !== true).map(([id]) => id);
  const pass = blockingChecks.length === 0;

  return {
    ok: pass,
    pass,
    type: 'polish_perception_program',
    lane_id: 'V4-FORT-007',
    ts: nowIso(),
    checks,
    blocking_checks: blockingChecks,
    missing_docs: missingDocs,
    missing_scripts: missingScripts,
    missing_ci_commands: missingCiCommands,
    missing_pre_commit_commands: missingPreCommitCommands,
    template_findings: templateFindings,
    latest_audit: auditLatest ? {
      ts: auditLatest.ts,
      score: auditLatest.score,
      receipt_id: auditLatest.audit_receipt_id || null
    } : null,
    verification_receipt_id: `polish_perception_${stableHash(JSON.stringify({
      missingDocs,
      missingScripts,
      missingCiCommands,
      missingPreCommitCommands,
      templateFindings,
      auditFresh,
      auditScore
    }), 14)}`
  };
}

function cmdAudit(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const out = runAudit(policy);
  emit({
    ...out,
    policy_path: rel(policy.policy_path),
    audit_latest_path: rel(policy.paths.audit_latest_path)
  }, 0);
}

function cmdVerify(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const strict = toBool(args.strict, true);
  const out = verify(policy);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.history_path, {
    ts: out.ts,
    type: out.type,
    ok: out.ok,
    blocking_checks: out.blocking_checks
  });
  emit({ ...out, policy_path: rel(policy.policy_path), latest_path: rel(policy.paths.latest_path) }, out.ok || !strict ? 0 : 1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  emit({
    ok: true,
    type: 'polish_perception_program_status',
    ts: nowIso(),
    latest: readJson(policy.paths.latest_path, null),
    latest_audit: readJson(policy.paths.audit_latest_path, null),
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
  if (cmd === 'audit') return cmdAudit(args);
  if (cmd === 'verify' || cmd === 'run') return cmdVerify(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  emit({ ok: false, error: `unknown_command:${cmd}` }, 2);
}

main();
