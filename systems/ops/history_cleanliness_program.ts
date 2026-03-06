#!/usr/bin/env node
'use strict';
export {};

/**
 * V4-FORT-004
 * History cleanliness program verification.
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

const DEFAULT_POLICY_PATH = process.env.HISTORY_CLEANLINESS_PROGRAM_POLICY_PATH
  ? path.resolve(process.env.HISTORY_CLEANLINESS_PROGRAM_POLICY_PATH)
  : path.join(ROOT, 'config', 'history_cleanliness_program_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/history_cleanliness_program.js verify [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/history_cleanliness_program.js status [--policy=<path>]');
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
    required_docs: ['docs/HISTORY_CLEANLINESS.md', 'docs/RELEASE_DISCIPLINE_POLICY.md', 'CHANGELOG.md', '.github/pull_request_template.md'],
    history_required_terms: ['append-only', 'no force-push', 'changelog'],
    pr_template_required_terms: ['summary', 'validation', 'changelog'],
    paths: {
      latest_path: 'state/ops/history_cleanliness_program/latest.json',
      history_path: 'state/ops/history_cleanliness_program/history.jsonl'
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
    required_docs: Array.isArray(raw.required_docs) && raw.required_docs.length
      ? raw.required_docs.map((v: unknown) => cleanText(v, 260)).filter(Boolean)
      : base.required_docs,
    history_required_terms: Array.isArray(raw.history_required_terms) && raw.history_required_terms.length
      ? raw.history_required_terms.map((v: unknown) => cleanText(v, 120).toLowerCase()).filter(Boolean)
      : base.history_required_terms,
    pr_template_required_terms: Array.isArray(raw.pr_template_required_terms) && raw.pr_template_required_terms.length
      ? raw.pr_template_required_terms.map((v: unknown) => cleanText(v, 120).toLowerCase()).filter(Boolean)
      : base.pr_template_required_terms,
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function verify(policy: AnyObj) {
  if (policy.enabled !== true) return { ok: true, type: 'history_cleanliness_program', ts: nowIso(), result: 'disabled_by_policy' };

  const missingDocs = policy.required_docs
    .map((docRel: string) => ({ rel: docRel, abs: path.join(ROOT, docRel) }))
    .filter((row: AnyObj) => !fs.existsSync(row.abs))
    .map((row: AnyObj) => row.rel);

  const historyDoc = readText(path.join(ROOT, 'docs/HISTORY_CLEANLINESS.md')).toLowerCase();
  const prTemplate = readText(path.join(ROOT, '.github/pull_request_template.md')).toLowerCase();

  const missingHistoryTerms = policy.history_required_terms.filter((term: string) => !historyDoc.includes(term));
  const missingPrTerms = policy.pr_template_required_terms.filter((term: string) => !prTemplate.includes(term));

  const checks = {
    required_docs_present: missingDocs.length === 0,
    history_terms_present: missingHistoryTerms.length === 0,
    pr_template_terms_present: missingPrTerms.length === 0
  };
  const blockingChecks = Object.entries(checks).filter(([, ok]) => ok !== true).map(([id]) => id);
  const pass = blockingChecks.length === 0;

  return {
    ok: pass,
    pass,
    type: 'history_cleanliness_program',
    lane_id: 'V4-FORT-004',
    ts: nowIso(),
    checks,
    blocking_checks: blockingChecks,
    missing_docs: missingDocs,
    missing_history_terms: missingHistoryTerms,
    missing_pr_template_terms: missingPrTerms,
    verification_receipt_id: `history_clean_${stableHash(JSON.stringify({ missingDocs, missingHistoryTerms, missingPrTerms }), 14)}`
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
  emit({ ok: true, type: 'history_cleanliness_program_status', ts: nowIso(), latest: readJson(policy.paths.latest_path, null), policy_path: rel(policy.policy_path) }, 0);
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
