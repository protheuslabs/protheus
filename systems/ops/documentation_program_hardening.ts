#!/usr/bin/env node
'use strict';
export {};

/**
 * V4-FORT-003
 * Documentation program hardening verification.
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

const DEFAULT_POLICY_PATH = process.env.DOC_PROGRAM_HARDENING_POLICY_PATH
  ? path.resolve(process.env.DOC_PROGRAM_HARDENING_POLICY_PATH)
  : path.join(ROOT, 'config', 'documentation_program_hardening_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/documentation_program_hardening.js verify [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/documentation_program_hardening.js status [--policy=<path>]');
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
    governance_doc: 'docs/DOCUMENTATION_PROGRAM_GOVERNANCE.md',
    required_files: ['docs/adr/README.md', 'docs/adr/TEMPLATE.md', 'docs/adr/INDEX.md'],
    required_sections: ['ownership model', 'review cadence', 'artifact tiers', 'adr', 'freshness process', 'backlog + release linkage'],
    paths: {
      latest_path: 'state/ops/documentation_program_hardening/latest.json',
      history_path: 'state/ops/documentation_program_hardening/history.jsonl'
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
    governance_doc: resolvePath(raw.governance_doc, base.governance_doc),
    required_files: Array.isArray(raw.required_files) && raw.required_files.length
      ? raw.required_files.map((v: unknown) => cleanText(v, 260)).filter(Boolean)
      : base.required_files,
    required_sections: Array.isArray(raw.required_sections) && raw.required_sections.length
      ? raw.required_sections.map((v: unknown) => cleanText(v, 120).toLowerCase()).filter(Boolean)
      : base.required_sections,
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function verify(policy: AnyObj) {
  if (policy.enabled !== true) return { ok: true, type: 'documentation_program_hardening', ts: nowIso(), result: 'disabled_by_policy' };

  const missingFiles = policy.required_files
    .map((relPath: string) => ({ rel: relPath, abs: path.join(ROOT, relPath) }))
    .filter((row: AnyObj) => !fs.existsSync(row.abs))
    .map((row: AnyObj) => row.rel);

  const govText = readText(policy.governance_doc).toLowerCase();
  const missingSections = policy.required_sections
    .filter((term: string) => !govText.includes(term.toLowerCase()));

  const checks = {
    governance_doc_present: fs.existsSync(policy.governance_doc),
    adr_assets_present: missingFiles.length === 0,
    governance_sections_present: missingSections.length === 0
  };
  const blockingChecks = Object.entries(checks).filter(([, ok]) => ok !== true).map(([id]) => id);
  const pass = blockingChecks.length === 0;

  return {
    ok: pass,
    pass,
    type: 'documentation_program_hardening',
    lane_id: 'V4-FORT-003',
    ts: nowIso(),
    checks,
    blocking_checks: blockingChecks,
    missing_files: missingFiles,
    missing_sections: missingSections,
    verification_receipt_id: `docs_harden_${stableHash(JSON.stringify({ missingFiles, missingSections }), 14)}`
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
  emit({ ok: true, type: 'documentation_program_hardening_status', ts: nowIso(), latest: readJson(policy.paths.latest_path, null), policy_path: rel(policy.policy_path) }, 0);
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
