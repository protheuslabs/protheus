#!/usr/bin/env node
'use strict';
export {};

/**
 * V4-FORT-001
 * UI surface maturity pack (inventory + design token + accessibility contract).
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

const DEFAULT_POLICY_PATH = process.env.UI_SURFACE_MATURITY_PACK_POLICY_PATH
  ? path.resolve(process.env.UI_SURFACE_MATURITY_PACK_POLICY_PATH)
  : path.join(ROOT, 'config', 'ui_surface_maturity_pack_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/ui_surface_maturity_pack.js verify [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/ui_surface_maturity_pack.js status [--policy=<path>]');
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
      'docs/UI_SURFACE_MATURITY_MATRIX.md',
      'docs/UI_SURFACE_INVENTORY.md',
      'docs/UI_DESIGN_TOKEN_STANDARD.md',
      'docs/UI_ACCESSIBILITY_INTERACTION_CONTRACT.md'
    ],
    readme_path: 'README.md',
    readme_required_links: [
      'docs/UI_SURFACE_MATURITY_MATRIX.md',
      'docs/UI_SURFACE_INVENTORY.md',
      'docs/UI_ACCESSIBILITY_INTERACTION_CONTRACT.md'
    ],
    required_terms: ['keyboard', 'focus', 'contrast', 'command palette', 'responsive'],
    paths: {
      latest_path: 'state/ops/ui_surface_maturity_pack/latest.json',
      history_path: 'state/ops/ui_surface_maturity_pack/history.jsonl'
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
    readme_path: resolvePath(raw.readme_path, base.readme_path),
    readme_required_links: Array.isArray(raw.readme_required_links) && raw.readme_required_links.length
      ? raw.readme_required_links.map((v: unknown) => cleanText(v, 260)).filter(Boolean)
      : base.readme_required_links,
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
    return {
      ok: true,
      type: 'ui_surface_maturity_pack',
      ts: nowIso(),
      result: 'disabled_by_policy'
    };
  }

  const missingDocs = policy.required_docs
    .map((docRel: string) => ({ rel: docRel, abs: path.join(ROOT, docRel) }))
    .filter((row: AnyObj) => !fs.existsSync(row.abs))
    .map((row: AnyObj) => row.rel);

  const readmeText = readText(policy.readme_path);
  const missingLinks = policy.readme_required_links
    .filter((target: string) => !readmeText.includes(target));

  const combined = policy.required_docs
    .map((docRel: string) => readText(path.join(ROOT, docRel)).toLowerCase())
    .join('\n');
  const missingTerms = policy.required_terms
    .filter((term: string) => !combined.includes(term));

  const checks = {
    required_docs_present: missingDocs.length === 0,
    readme_links_present: missingLinks.length === 0,
    accessibility_terms_present: missingTerms.length === 0
  };
  const blockingChecks = Object.entries(checks).filter(([, ok]) => ok !== true).map(([id]) => id);
  const pass = blockingChecks.length === 0;

  return {
    ok: pass,
    pass,
    type: 'ui_surface_maturity_pack',
    lane_id: 'V4-FORT-001',
    ts: nowIso(),
    checks,
    blocking_checks: blockingChecks,
    missing_docs: missingDocs,
    missing_links: missingLinks,
    missing_terms: missingTerms,
    verification_receipt_id: `ui_fort_${stableHash(JSON.stringify({ missingDocs, missingLinks, missingTerms }), 14)}`
  };
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
  emit({ ok: true, type: 'ui_surface_maturity_pack_status', ts: nowIso(), latest: readJson(policy.paths.latest_path, null), policy_path: rel(policy.policy_path) }, 0);
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
