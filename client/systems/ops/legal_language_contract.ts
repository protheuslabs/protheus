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

const DEFAULT_POLICY_PATH = process.env.LEGAL_LANGUAGE_CONTRACT_POLICY_PATH
  ? path.resolve(process.env.LEGAL_LANGUAGE_CONTRACT_POLICY_PATH)
  : path.join(ROOT, 'config', 'legal_language_contract_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/legal_language_contract.js check [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/legal_language_contract.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    files: ['LICENSE', 'EULA.md', 'TERMS_OF_SERVICE.md', 'CONTRIBUTING_TERMS.md', 'README.md'],
    discouraged_terms: ['soul-token-bound', 'bite at your own risk', 'venom', 'cute on the outside'],
    paths: {
      latest_path: 'state/ops/legal_language_contract/latest.json',
      receipts_path: 'state/ops/legal_language_contract/receipts.jsonl'
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
    files: Array.isArray(raw.files) ? raw.files : base.files,
    discouraged_terms: Array.isArray(raw.discouraged_terms) ? raw.discouraged_terms : base.discouraged_terms,
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    }
  };
}

function runCheck(policy: any, strict: boolean) {
  const findings: any[] = [];
  const missingFiles: string[] = [];

  for (const relPath of policy.files) {
    const abs = path.join(ROOT, String(relPath));
    if (!fs.existsSync(abs)) {
      missingFiles.push(String(relPath));
      continue;
    }
    const txt = fs.readFileSync(abs, 'utf8');
    for (const term of policy.discouraged_terms) {
      const needle = String(term || '').toLowerCase();
      if (!needle) continue;
      if (!txt.toLowerCase().includes(needle)) continue;
      findings.push({
        file: String(relPath),
        term: String(term)
      });
    }
  }

  const checks = {
    required_legal_files_present: missingFiles.length === 0,
    no_discouraged_legal_terms: findings.length === 0
  };

  const blocking = Object.entries(checks).filter(([, ok]) => ok !== true).map(([k]) => k);
  const pass = blocking.length === 0;
  const ok = strict ? pass : true;

  const out = {
    ok,
    pass,
    strict,
    type: 'legal_language_contract',
    ts: nowIso(),
    checks,
    blocking_checks: blocking,
    missing_files: missingFiles,
    findings
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
      type: 'legal_language_contract',
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
