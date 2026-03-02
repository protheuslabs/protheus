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

const DEFAULT_POLICY_PATH = process.env.ROOT_SURFACE_CONTRACT_POLICY_PATH
  ? path.resolve(process.env.ROOT_SURFACE_CONTRACT_POLICY_PATH)
  : path.join(ROOT, 'config', 'root_surface_contract.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/root_surface_contract.js check [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/root_surface_contract.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    allowed_root_files: [],
    allowed_root_dirs: [],
    deprecated_root_entries: [],
    paths: {
      latest_path: 'state/ops/root_surface_contract/latest.json',
      receipts_path: 'state/ops/root_surface_contract/receipts.jsonl'
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
    allowed_root_files: Array.isArray(raw.allowed_root_files) ? raw.allowed_root_files : base.allowed_root_files,
    allowed_root_dirs: Array.isArray(raw.allowed_root_dirs) ? raw.allowed_root_dirs : base.allowed_root_dirs,
    deprecated_root_entries: Array.isArray(raw.deprecated_root_entries) ? raw.deprecated_root_entries : base.deprecated_root_entries,
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    }
  };
}

function runCheck(policy: any, strict: boolean) {
  const rows = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((row: any) => row.name !== '.git')
    .map((row: any) => ({
      name: row.name,
      kind: row.isDirectory() ? 'dir' : 'file'
    }));

  const files = rows.filter((r: any) => r.kind === 'file').map((r: any) => r.name);
  const dirs = rows.filter((r: any) => r.kind === 'dir').map((r: any) => r.name);

  const unapprovedFiles = files.filter((name: string) => !policy.allowed_root_files.includes(name));
  const unapprovedDirs = dirs.filter((name: string) => !policy.allowed_root_dirs.includes(name));
  const deprecatedPresent = policy.deprecated_root_entries.filter((name: string) => rows.some((r: any) => r.name === name));

  const checks = {
    root_files_curated: unapprovedFiles.length === 0,
    root_dirs_curated: unapprovedDirs.length === 0,
    deprecated_root_entries_removed: deprecatedPresent.length === 0
  };

  const blocking = Object.entries(checks).filter(([, ok]) => ok !== true).map(([k]) => k);
  const pass = blocking.length === 0;
  const ok = strict ? pass : true;

  const out = {
    ok,
    pass,
    strict,
    type: 'root_surface_contract',
    ts: nowIso(),
    checks,
    blocking_checks: blocking,
    unapproved_files: unapprovedFiles,
    unapproved_dirs: unapprovedDirs,
    deprecated_present: deprecatedPresent,
    counts: {
      root_files: files.length,
      root_dirs: dirs.length
    }
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
      type: 'root_surface_contract',
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
