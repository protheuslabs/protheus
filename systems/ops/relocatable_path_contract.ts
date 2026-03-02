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

const DEFAULT_POLICY_PATH = process.env.RELOCATABLE_PATH_CONTRACT_POLICY_PATH
  ? path.resolve(process.env.RELOCATABLE_PATH_CONTRACT_POLICY_PATH)
  : path.join(ROOT, 'config', 'relocatable_path_contract_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/relocatable_path_contract.js check [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/relocatable_path_contract.js status [--policy=<path>]');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: true,
    scan: {
      include: ['systems', 'lib', 'config', 'bin', '.github', 'package.json'],
      ext: ['.ts', '.js', '.json', '.md', '.yml', '.yaml'],
      forbidden_patterns: ['/Users/', '\\\\Users\\\\', '/home/'],
      allowlist: ['memory/', 'state/', 'docs/backlog_views/', 'UPGRADE_BACKLOG.md']
    },
    paths: {
      latest_path: 'state/ops/relocatable_path_contract/latest.json',
      receipts_path: 'state/ops/relocatable_path_contract/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const scan = raw.scan && typeof raw.scan === 'object' ? raw.scan : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: toBool(raw.enabled, true),
    strict_default: toBool(raw.strict_default, true),
    scan: {
      include: Array.isArray(scan.include) ? scan.include : base.scan.include,
      ext: Array.isArray(scan.ext) ? scan.ext : base.scan.ext,
      forbidden_patterns: Array.isArray(scan.forbidden_patterns) ? scan.forbidden_patterns : base.scan.forbidden_patterns,
      allowlist: Array.isArray(scan.allowlist) ? scan.allowlist : base.scan.allowlist
    },
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    }
  };
}

function walk(absPath: string, exts: string[], out: string[]) {
  if (!fs.existsSync(absPath)) return;
  const stat = fs.statSync(absPath);
  if (stat.isFile()) {
    if (!exts.includes(path.extname(absPath)) && path.basename(absPath) !== 'package.json') return;
    out.push(absPath);
    return;
  }
  const entries = fs.readdirSync(absPath, { withFileTypes: true });
  for (const row of entries) {
    if (row.name === 'node_modules' || row.name === 'dist') continue;
    walk(path.join(absPath, row.name), exts, out);
  }
}

function runCheck(policy: any, strict: boolean) {
  const files: string[] = [];
  for (const item of policy.scan.include) {
    walk(path.join(ROOT, String(item)), policy.scan.ext, files);
  }

  const findings: any[] = [];
  for (const fileAbs of files) {
    const relPath = rel(fileAbs);
    if (policy.scan.allowlist.some((prefix: string) => relPath.startsWith(String(prefix)))) continue;
    const raw = fs.readFileSync(fileAbs, 'utf8');
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.includes('forbidden_patterns')) continue;
      for (const pattern of policy.scan.forbidden_patterns) {
        if (!String(pattern)) continue;
        if (!line.includes(String(pattern))) continue;
        findings.push({
          file: relPath,
          line: i + 1,
          pattern: String(pattern),
          snippet: cleanText(line, 240)
        });
      }
    }
  }

  const checks = {
    no_forbidden_absolute_paths: findings.length === 0,
    workspace_root_defined: !!ROOT
  };
  const blocking = Object.entries(checks).filter(([, ok]) => ok !== true).map(([k]) => k);
  const pass = blocking.length === 0;
  const ok = strict ? pass : true;

  const out = {
    ok,
    pass,
    strict,
    type: 'relocatable_path_contract',
    ts: nowIso(),
    checks,
    blocking_checks: blocking,
    counts: {
      files_scanned: files.length,
      findings: findings.length
    },
    findings: findings.slice(0, 500),
    workspace_root: rel(ROOT)
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
      type: 'relocatable_path_contract',
      status: 'no_status'
    }), 0);
  }

  if (cmd !== 'check') {
    usage();
    return emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
  }

  const strict = toBool(args.strict, policy.strict_default);
  const out = runCheck(policy, strict);
  return emit(out, out.ok ? 0 : 1);
}

main();
