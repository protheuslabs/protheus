#!/usr/bin/env node
'use strict';
export {};

/**
 * V4-FORT-007 helper
 * Deterministic code-format guard for TS/JS/Rust/Markdown/Shell surfaces.
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

const DEFAULT_POLICY_PATH = process.env.ORG_CODE_FORMAT_GUARD_POLICY_PATH
  ? path.resolve(process.env.ORG_CODE_FORMAT_GUARD_POLICY_PATH)
  : path.join(ROOT, 'config', 'org_code_format_guard_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/org_code_format_guard.js check [--strict=1|0] [--scope=all|staged] [--policy=<path>]');
  console.log('  node systems/ops/org_code_format_guard.js check-staged [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/org_code_format_guard.js status [--policy=<path>]');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    include_roots: [
      'README.md',
      'CONTRIBUTING.md',
      'docs/README.md',
      'docs/ORG_CODE_FORMAT_STANDARD.md',
      'docs/PERCEPTION_AUDIT_PROGRAM.md',
      'docs/EMPTY_FORT_INTEGRITY_CHECKLIST.md',
      '.github/workflows/ci.yml',
      '.github/pull_request_template.md',
      '.github/ISSUE_TEMPLATE',
      '.githooks',
      'config/org_code_format_guard_policy.json',
      'config/polish_perception_program_policy.json',
      'systems/ops/org_code_format_guard.ts',
      'systems/ops/polish_perception_program.ts'
    ],
    include_ext: ['.ts', '.js', '.md', '.sh', '.rs'],
    exclude_dirs: ['.git', 'node_modules', 'state', 'dist', '.internal'],
    max_findings: 2000,
    rules: {
      no_trailing_whitespace: true,
      eof_newline: true,
      no_crlf: true,
      no_tabs_for: ['.ts', '.js', '.md', '.sh', '.rs']
    },
    paths: {
      latest_path: 'state/ops/org_code_format_guard/latest.json',
      history_path: 'state/ops/org_code_format_guard/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const rules = raw.rules && typeof raw.rules === 'object' ? raw.rules : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    include_roots: Array.isArray(raw.include_roots) && raw.include_roots.length
      ? raw.include_roots.map((v: unknown) => cleanText(v, 260)).filter(Boolean)
      : base.include_roots,
    include_ext: Array.isArray(raw.include_ext) && raw.include_ext.length
      ? raw.include_ext.map((v: unknown) => cleanText(v, 16).toLowerCase()).filter(Boolean)
      : base.include_ext,
    exclude_dirs: Array.isArray(raw.exclude_dirs) && raw.exclude_dirs.length
      ? raw.exclude_dirs.map((v: unknown) => cleanText(v, 120)).filter(Boolean)
      : base.exclude_dirs,
    max_findings: Number.isFinite(Number(raw.max_findings)) ? Math.max(1, Math.floor(Number(raw.max_findings))) : base.max_findings,
    rules: {
      no_trailing_whitespace: rules.no_trailing_whitespace !== false,
      eof_newline: rules.eof_newline !== false,
      no_crlf: rules.no_crlf !== false,
      no_tabs_for: Array.isArray(rules.no_tabs_for) && rules.no_tabs_for.length
        ? rules.no_tabs_for.map((v: unknown) => cleanText(v, 16).toLowerCase()).filter(Boolean)
        : base.rules.no_tabs_for
    },
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function shouldExclude(relPath: string, policy: AnyObj) {
  const normalized = relPath.replace(/\\/g, '/');
  return policy.exclude_dirs.some((dir: string) => {
    const token = `${String(dir).replace(/\/+$/, '')}/`;
    return normalized.startsWith(token) || normalized.includes(`/${token}`);
  });
}

function collectFiles(policy: AnyObj) {
  const out: string[] = [];
  const stack: string[] = [];
  const includeRoots = Array.isArray(policy.include_roots) ? policy.include_roots : [];
  if (includeRoots.length) {
    for (const rootToken of includeRoots) {
      const abs = path.isAbsolute(rootToken) ? rootToken : path.join(ROOT, rootToken);
      if (!fs.existsSync(abs)) continue;
      stack.push(abs);
    }
  } else {
    stack.push(ROOT);
  }

  while (stack.length) {
    const current = stack.pop()!;
    const currentStat = fs.statSync(current);
    if (!currentStat.isDirectory()) {
      const relPath = rel(current);
      if (!shouldExclude(relPath, policy)) {
        const ext = path.extname(current).toLowerCase();
        if (policy.include_ext.includes(ext)) out.push(current);
      }
      continue;
    }
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const relPath = rel(abs);
      if (shouldExclude(relPath, policy)) continue;
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (policy.include_ext.includes(ext)) out.push(abs);
    }
  }
  out.sort((a, b) => rel(a).localeCompare(rel(b)));
  return out;
}

function collectStagedFiles(policy: AnyObj) {
  const proc = spawnSync('git', ['-C', ROOT, 'diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    encoding: 'utf8'
  });
  const status = Number.isFinite(proc.status) ? Number(proc.status) : 1;
  if (status !== 0) {
    return {
      files: [],
      error: cleanText(proc.stderr || proc.stdout || 'git_diff_cached_failed', 240) || 'git_diff_cached_failed'
    };
  }
  const files: string[] = [];
  const rows = String(proc.stdout || '')
    .split('\n')
    .map((row) => cleanText(row, 400))
    .filter(Boolean);
  for (const relPathRaw of rows) {
    const relPath = String(relPathRaw).replace(/\\/g, '/').replace(/^\.\//, '');
    if (!relPath || shouldExclude(relPath, policy)) continue;
    const abs = path.join(ROOT, relPath);
    if (!fs.existsSync(abs)) continue;
    const stat = fs.statSync(abs);
    if (!stat.isFile()) continue;
    const ext = path.extname(abs).toLowerCase();
    if (!policy.include_ext.includes(ext)) continue;
    files.push(abs);
  }
  files.sort((a, b) => rel(a).localeCompare(rel(b)));
  return { files, error: null };
}

function scanFile(filePath: string, policy: AnyObj, findings: AnyObj[]) {
  if (findings.length >= policy.max_findings) return;
  let text = '';
  try {
    text = String(fs.readFileSync(filePath, 'utf8') || '');
  } catch {
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const lines = text.split('\n');
  const maxAllowed = policy.max_findings;

  if (policy.rules.no_crlf === true) {
    lines.forEach((line: string, idx: number) => {
      if (findings.length >= maxAllowed) return;
      if (line.includes('\r')) {
        findings.push({
          file: rel(filePath),
          line: idx + 1,
          rule: 'no_crlf_line_endings',
          preview: cleanText(line.replace(/\r/g, '\\r'), 180)
        });
      }
    });
  }

  if (policy.rules.no_trailing_whitespace === true) {
    lines.forEach((line: string, idx: number) => {
      if (findings.length >= maxAllowed) return;
      if (/[ \t]+$/.test(line)) {
        findings.push({
          file: rel(filePath),
          line: idx + 1,
          rule: 'no_trailing_whitespace',
          preview: cleanText(line, 180)
        });
      }
    });
  }

  if (policy.rules.no_tabs_for.includes(ext)) {
    lines.forEach((line: string, idx: number) => {
      if (findings.length >= maxAllowed) return;
      if (line.includes('\t')) {
        findings.push({
          file: rel(filePath),
          line: idx + 1,
          rule: 'no_tabs',
          preview: cleanText(line, 180)
        });
      }
    });
  }

  if (policy.rules.eof_newline === true && text.length > 0 && !text.endsWith('\n')) {
    findings.push({
      file: rel(filePath),
      line: lines.length,
      rule: 'eof_newline_missing',
      preview: null
    });
  }
}

function check(policy: AnyObj, options: AnyObj = {}) {
  if (policy.enabled !== true) {
    return { ok: true, type: 'org_code_format_guard', ts: nowIso(), result: 'disabled_by_policy' };
  }

  const scope = cleanText(options.scope || 'all', 24).toLowerCase() === 'staged' ? 'staged' : 'all';
  let files: string[] = [];
  if (scope === 'staged') {
    const staged = collectStagedFiles(policy);
    if (staged.error) {
      return {
        ok: false,
        pass: false,
        type: 'org_code_format_guard',
        ts: nowIso(),
        scope,
        scanned_files: 0,
        findings_count: 1,
        findings: [
          {
            file: null,
            line: null,
            rule: 'staged_scope_unavailable',
            preview: staged.error
          }
        ],
        verification_receipt_id: `fmt_guard_${stableHash(staged.error, 14)}`
      };
    }
    files = staged.files;
  } else {
    files = collectFiles(policy);
  }
  const findings: AnyObj[] = [];
  for (const filePath of files) {
    scanFile(filePath, policy, findings);
    if (findings.length >= policy.max_findings) break;
  }

  const out = {
    ok: findings.length === 0,
    pass: findings.length === 0,
    type: 'org_code_format_guard',
    ts: nowIso(),
    scope,
    scanned_files: files.length,
    findings_count: findings.length,
    findings,
    verification_receipt_id: `fmt_guard_${stableHash(JSON.stringify({
      scanned_files: files.length,
      findings_count: findings.length,
      sample: findings.slice(0, 50)
    }), 14)}`
  };
  return out;
}

function cmdCheck(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const strict = toBool(args.strict, true);
  const scopeArg = cleanText(args.scope || '', 24).toLowerCase();
  const scope = scopeArg === 'staged' || toBool(args.staged, false) ? 'staged' : 'all';
  const out = check(policy, { scope });
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.history_path, {
    ts: out.ts,
    type: out.type,
    ok: out.ok,
    scope: out.scope || scope,
    scanned_files: out.scanned_files,
    findings_count: out.findings_count
  });
  emit({ ...out, policy_path: rel(policy.policy_path), latest_path: rel(policy.paths.latest_path) }, out.ok || !strict ? 0 : 1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  emit({
    ok: true,
    type: 'org_code_format_guard_status',
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
  if (cmd === 'check-staged') return cmdCheck({ ...args, scope: 'staged' });
  if (cmd === 'check' || cmd === 'run') return cmdCheck(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  emit({ ok: false, error: `unknown_command:${cmd}` }, 2);
}

main();
