#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  toBool,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.DOCS_SURFACE_CONTRACT_POLICY_PATH
  ? path.resolve(process.env.DOCS_SURFACE_CONTRACT_POLICY_PATH)
  : path.join(ROOT, 'config', 'docs_surface_contract_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/docs_surface_contract.js check [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/docs_surface_contract.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    required_operator_docs: ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'docs/README.md', 'docs/OPERATOR_RUNBOOK.md'],
    required_public_docs: ['docs/PUBLIC_OPERATOR_PROFILE.md'],
    readme_required_links: ['docs/PUBLIC_OPERATOR_PROFILE.md'],
    readme_forbidden_root_internal_links: ['AGENT-CONSTITUTION.md', 'SOUL.md', 'USER.md', 'MEMORY.md', 'codex.helix'],
    required_internal_namespace: ['docs/internal/README.md', 'docs/internal/persona/AGENT-CONSTITUTION.md', 'docs/internal/persona/IDENTITY.md'],
    internal_aliases: {
      'AGENT-CONSTITUTION.md': 'docs/internal/persona/AGENT-CONSTITUTION.md',
      'IDENTITY.md': 'docs/internal/persona/IDENTITY.md',
      'SOUL.md': 'docs/internal/persona/SOUL.md',
      'USER.md': 'docs/internal/persona/USER.md',
      'MEMORY.md': 'docs/internal/persona/MEMORY.md',
      'codex.helix': 'docs/internal/persona/CODEX_HELIX.md'
    },
    paths: {
      latest_path: 'state/ops/docs_surface_contract/latest.json',
      receipts_path: 'state/ops/docs_surface_contract/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: toBool(raw.enabled, true),
    required_operator_docs: Array.isArray(raw.required_operator_docs) ? raw.required_operator_docs : base.required_operator_docs,
    required_public_docs: Array.isArray(raw.required_public_docs) ? raw.required_public_docs : base.required_public_docs,
    readme_required_links: Array.isArray(raw.readme_required_links) ? raw.readme_required_links : base.readme_required_links,
    readme_forbidden_root_internal_links: Array.isArray(raw.readme_forbidden_root_internal_links)
      ? raw.readme_forbidden_root_internal_links
      : base.readme_forbidden_root_internal_links,
    required_internal_namespace: Array.isArray(raw.required_internal_namespace) ? raw.required_internal_namespace : base.required_internal_namespace,
    internal_aliases: raw.internal_aliases && typeof raw.internal_aliases === 'object'
      ? raw.internal_aliases
      : base.internal_aliases,
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    }
  };
}

function runCheck(policy: any, strict: boolean) {
  const missingOperator = policy.required_operator_docs.filter((p: string) => !fs.existsSync(path.join(ROOT, p)));
  const missingPublic = policy.required_public_docs.filter((p: string) => !fs.existsSync(path.join(ROOT, p)));
  const missingInternal = policy.required_internal_namespace.filter((p: string) => !fs.existsSync(path.join(ROOT, p)));

  const readmePath = path.join(ROOT, 'README.md');
  const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : '';
  const badReadmeTerms = ['soul-token-bound', 'pre-neuralink', 'organ-state-encryption', 'autophagy harvest', 'resurrection drills']
    .filter((term) => readme.toLowerCase().includes(term.toLowerCase()));
  const missingReadmeLinks = policy.readme_required_links
    .filter((target: string) => !readme.includes(target));
  const readmeInternalLinks = policy.readme_forbidden_root_internal_links
    .filter((target: string) => readme.includes(`(${target})`) || readme.includes(`](${target})`));

  const aliasRows = Object.entries(policy.internal_aliases || {}).map(([source, target]) => ({
    source,
    target,
    source_exists: fs.existsSync(path.join(ROOT, String(source))),
    target_exists: fs.existsSync(path.join(ROOT, String(target)))
  }));
  const aliasMissing = aliasRows.filter((row: any) => row.source_exists !== true || row.target_exists !== true);

  const checks = {
    operator_docs_present: missingOperator.length === 0,
    public_docs_present: missingPublic.length === 0,
    internal_namespace_present: missingInternal.length === 0,
    readme_operator_language: badReadmeTerms.length === 0,
    readme_required_links_present: missingReadmeLinks.length === 0,
    readme_avoids_internal_root_links: readmeInternalLinks.length === 0,
    internal_alias_targets_present: aliasMissing.length === 0
  };

  const blocking = Object.entries(checks).filter(([, ok]) => ok !== true).map(([k]) => k);
  const pass = blocking.length === 0;
  const ok = strict ? pass : true;

  const out = {
    ok,
    pass,
    strict,
    type: 'docs_surface_contract',
    ts: nowIso(),
    checks,
    blocking_checks: blocking,
    missing_operator_docs: missingOperator,
    missing_public_docs: missingPublic,
    missing_internal_docs: missingInternal,
    bad_readme_terms: badReadmeTerms,
    missing_readme_links: missingReadmeLinks,
    readme_internal_root_links: readmeInternalLinks,
    alias_missing: aliasMissing
  };

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'check').toLowerCase();
  if (args.help || cmd === 'help' || cmd === '--help') {
    usage();
    return emit({ ok: true, help: true }, 0);
  }

  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);

  if (cmd === 'status') {
    return emit(readJson(policy.paths.latest_path, {
      ok: true,
      type: 'docs_surface_contract',
      status: 'no_status'
    }), 0);
  }

  if (cmd !== 'check') {
    usage();
    return emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
  }

  const strict = toBool(args.strict, true);
  const out = runCheck(policy, strict);
  return emit(out, out.ok ? 0 : 1);
}

main();
