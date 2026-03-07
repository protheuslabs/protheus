#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-113
 * TS-first compatibility-tail retirement guard.
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  readJson,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');
const { loadPolicyRuntime } = require('../../lib/policy_runtime');
const { writeArtifactSet } = require('../../lib/state_artifact_contract');

const DEFAULT_POLICY_PATH = process.env.COMPATIBILITY_TAIL_RETIREMENT_POLICY_PATH
  ? path.resolve(process.env.COMPATIBILITY_TAIL_RETIREMENT_POLICY_PATH)
  : path.join(ROOT, 'config', 'compatibility_tail_retirement_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/compatibility_tail_retirement.js run [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/compatibility_tail_retirement.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: true,
    scan_roots: ['systems'],
    approved_non_wrapper_js: [],
    wrapper_patterns: [
      "ts_bootstrap').bootstrap(__filename, module);"
    ],
    paths: {
      latest_path: 'state/ops/compatibility_tail_retirement/latest.json',
      receipts_path: 'state/ops/compatibility_tail_retirement/receipts.jsonl'
    }
  };
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function normalizeRelPath(raw: unknown) {
  const cleaned = cleanText(raw || '', 520).replace(/\\/g, '/').replace(/^\.\/+/, '');
  return cleaned.replace(/^\/+/, '');
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const loaded = loadPolicyRuntime({
    policyPath,
    defaults: base
  });
  const raw = loaded.raw;
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const scanRoots = Array.isArray(raw.scan_roots)
    ? raw.scan_roots.map((row: unknown) => cleanText(row, 320)).filter(Boolean)
    : base.scan_roots;
  const allowlist = Array.isArray(raw.approved_non_wrapper_js)
    ? raw.approved_non_wrapper_js.map((row: unknown) => normalizeRelPath(row)).filter(Boolean)
    : base.approved_non_wrapper_js;
  const wrapperPatterns = Array.isArray(raw.wrapper_patterns)
    ? raw.wrapper_patterns.map((row: unknown) => cleanText(row, 260)).filter(Boolean)
    : base.wrapper_patterns;

  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: toBool(raw.enabled, true),
    strict_default: toBool(raw.strict_default, true),
    scan_roots: scanRoots,
    approved_non_wrapper_js: allowlist,
    wrapper_patterns: wrapperPatterns,
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function scanDir(absRoot: string, out: string[]) {
  if (!fs.existsSync(absRoot)) return;
  for (const entry of fs.readdirSync(absRoot, { withFileTypes: true })) {
    const abs = path.join(absRoot, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      scanDir(abs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!abs.endsWith('.js')) continue;
    const tsPair = `${abs.slice(0, -3)}.ts`;
    if (!fs.existsSync(tsPair)) continue;
    out.push(abs);
  }
}

function isWrapperContent(content: string, patterns: string[]) {
  const body = String(content || '');
  for (const pattern of patterns) {
    if (pattern && body.includes(pattern)) return true;
  }
  return false;
}

function evaluate(policy: any) {
  const absRoots = policy.scan_roots.map((raw: string) => {
    const txt = cleanText(raw || '', 320);
    return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
  });
  const candidates: string[] = [];
  for (const rootPath of absRoots) scanDir(rootPath, candidates);

  const allowset = new Set(policy.approved_non_wrapper_js || []);
  const rows: any[] = [];
  let wrapperPairs = 0;
  let allowlistedPairs = 0;
  let violatingPairs = 0;

  for (const filePath of candidates) {
    const relPath = rel(filePath);
    let scanRelative = relPath;
    for (const rootPath of absRoots) {
      const normalizedRoot = `${rootPath}${path.sep}`;
      if (!filePath.startsWith(normalizedRoot)) continue;
      scanRelative = normalizeRelPath(path.relative(path.dirname(rootPath), filePath));
      break;
    }
    const tsRel = rel(`${filePath.slice(0, -3)}.ts`);
    const allowlisted = allowset.has(relPath) || allowset.has(scanRelative);
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf8'); } catch {}
    const wrapper = isWrapperContent(content, policy.wrapper_patterns);
    if (wrapper) wrapperPairs += 1;
    else if (allowlisted) allowlistedPairs += 1;
    else violatingPairs += 1;
    rows.push({
      js_path: scanRelative || relPath,
      ts_path: tsRel,
      wrapper,
      allowlisted,
      status: wrapper ? 'wrapper' : (allowlisted ? 'allowlisted' : 'violation')
    });
  }

  return {
    ok: violatingPairs === 0,
    ts_js_pairs: candidates.length,
    wrapper_pairs: wrapperPairs,
    allowlisted_pairs: allowlistedPairs,
    violating_pairs: violatingPairs,
    violations: rows.filter((row) => row.status === 'violation').map((row) => row.js_path),
    rows
  };
}

function cmdRun(args: any, policy: any) {
  const strict = toBool(args.strict, policy.strict_default);
  const evalResult = evaluate(policy);
  const out = writeArtifactSet(
    {
      latestPath: policy.paths.latest_path,
      receiptsPath: policy.paths.receipts_path
    },
    {
      ok: evalResult.ok,
      type: 'compatibility_tail_retirement',
      action: 'run',
      ts: nowIso(),
      strict,
      policy_path: rel(policy.policy_path),
      ts_js_pairs: evalResult.ts_js_pairs,
      wrapper_pairs: evalResult.wrapper_pairs,
      allowlisted_pairs: evalResult.allowlisted_pairs,
      violating_pairs: evalResult.violating_pairs,
      violations: evalResult.violations
    },
    {
      schemaId: 'compatibility_tail_retirement_receipt',
      schemaVersion: '1.0',
      artifactType: 'receipt'
    }
  );
  emit(out, evalResult.ok || !strict ? 0 : 2);
}

function cmdStatus(policy: any) {
  const latest = readJson(policy.paths.latest_path, null);
  emit(
    {
      ok: !!latest,
      type: 'compatibility_tail_retirement',
      action: 'status',
      ts: nowIso(),
      latest
    },
    0
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 60) || 'status';
  if (cmd === '--help' || args.help) {
    usage();
    return;
  }

  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    emit({
      ok: false,
      type: 'compatibility_tail_retirement',
      ts: nowIso(),
      error: 'policy_disabled'
    }, 2);
  }

  if (cmd === 'run') return cmdRun(args, policy);
  if (cmd === 'status') return cmdStatus(policy);
  usage();
  emit({ ok: false, error: 'unknown_command', command: cmd }, 2);
}

if (require.main === module) {
  main();
}
