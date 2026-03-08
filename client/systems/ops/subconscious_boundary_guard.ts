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

type AnyObj = Record<string, any>;

const DEFAULT_POLICY_PATH = process.env.SUBCONSCIOUS_BOUNDARY_GUARD_POLICY_PATH
  ? path.resolve(process.env.SUBCONSCIOUS_BOUNDARY_GUARD_POLICY_PATH)
  : (
    fs.existsSync(path.join(ROOT, 'client', 'config', 'subconscious_boundary_guard_policy.json'))
      ? path.join(ROOT, 'client', 'config', 'subconscious_boundary_guard_policy.json')
      : path.join(ROOT, 'config', 'subconscious_boundary_guard_policy.json')
  );

function usage() {
  console.log('Usage:');
  console.log('  node client/systems/ops/subconscious_boundary_guard.js check [--strict=1|0] [--policy=<path>]');
  console.log('  node client/systems/ops/subconscious_boundary_guard.js status [--policy=<path>]');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    schema_id: 'subconscious_boundary_guard_policy',
    schema_version: '1.0.0',
    enabled: true,
    strict_default: true,
    scan_roots: ['client/systems', 'client/lib'],
    file_extensions: ['.ts', '.js'],
    skip_path_contains: [
      '/memory/tools/tests/',
      '/dist/',
      '/node_modules/',
      '/systems/ops/subconscious_boundary_guard.'
    ],
    forbidden_patterns: [
      { id: 'importance_infer_function', pattern: '\\binfer_from_event\\s*\\(' },
      { id: 'importance_band_function', pattern: '\\bband_for_score\\s*\\(' },
      { id: 'importance_internal_json_export', pattern: '\\bimportance_to_json\\b' },
      { id: 'importance_queue_front_flag', pattern: '\\bqueue_front\\b' },
      { id: 'initiative_threshold_actions', pattern: '\\b(persistent_until_ack|triple_escalation|double_message|single_message)\\b' },
      { id: 'importance_core_floor', pattern: '\\bcore_floor\\b' }
    ],
    paths: {
      latest_path: 'client/local/state/ops/subconscious_boundary_guard/latest.json',
      receipts_path: 'client/local/state/ops/subconscious_boundary_guard/receipts.jsonl'
    }
  };
}

function toArrayStrings(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return [...fallback];
  return value
    .map((v: unknown) => cleanText(v, 320))
    .filter(Boolean);
}

function compilePatterns(rawPatterns: AnyObj[]) {
  const out: AnyObj[] = [];
  for (const row of rawPatterns || []) {
    const id = cleanText(row && row.id, 80);
    const pattern = cleanText(row && row.pattern, 320);
    if (!id || !pattern) continue;
    try {
      out.push({
        id,
        pattern,
        regex: new RegExp(pattern, 'm')
      });
    } catch (_err) {
      out.push({
        id,
        pattern,
        regex: null
      });
    }
  }
  return out;
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const merged: AnyObj = {
    schema_id: cleanText(raw.schema_id || base.schema_id, 80) || base.schema_id,
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: toBool(raw.enabled, true),
    strict_default: toBool(raw.strict_default, true),
    scan_roots: toArrayStrings(raw.scan_roots, base.scan_roots),
    file_extensions: toArrayStrings(raw.file_extensions, base.file_extensions),
    skip_path_contains: toArrayStrings(raw.skip_path_contains, base.skip_path_contains),
    forbidden_patterns: compilePatterns(Array.isArray(raw.forbidden_patterns) ? raw.forbidden_patterns : base.forbidden_patterns),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    }
  };
  return merged;
}

function walkFiles(absDir: string, out: string[]) {
  if (!fs.existsSync(absDir)) return;
  const rows = fs.readdirSync(absDir, { withFileTypes: true });
  for (const row of rows) {
    const abs = path.join(absDir, row.name);
    if (row.isDirectory()) {
      walkFiles(abs, out);
      continue;
    }
    if (row.isFile()) out.push(abs);
  }
}

function lineOf(text: string, idx: number) {
  if (idx < 0) return 1;
  return text.slice(0, idx).split('\n').length;
}

function runCheck(policy: AnyObj, strict: boolean) {
  if (policy.enabled !== true) {
    const disabled = {
      ok: true,
      pass: true,
      strict,
      type: 'subconscious_boundary_guard',
      ts: nowIso(),
      result: 'disabled_by_policy'
    };
    writeJsonAtomic(policy.paths.latest_path, disabled);
    appendJsonl(policy.paths.receipts_path, disabled);
    return disabled;
  }

  const rootsMissing = (policy.scan_roots || [])
    .filter((scanRoot: string) => !fs.existsSync(path.join(ROOT, scanRoot)));
  const extensions = new Set(
    (policy.file_extensions || [])
      .map((ext: string) => String(ext || '').trim().toLowerCase())
      .filter(Boolean)
  );
  const skipPathContains = (policy.skip_path_contains || [])
    .map((token: string) => cleanText(token, 260))
    .filter(Boolean);

  const violations: AnyObj[] = [];
  let scannedCount = 0;
  for (const scanRoot of (policy.scan_roots || [])) {
    const absScanRoot = path.join(ROOT, scanRoot);
    const files: string[] = [];
    walkFiles(absScanRoot, files);
    for (const absFile of files) {
      const relFile = rel(absFile);
      if (skipPathContains.some((needle: string) => relFile.includes(needle))) continue;
      const ext = path.extname(absFile).toLowerCase();
      if (!extensions.has(ext)) continue;
      scannedCount += 1;
      const body = String(fs.readFileSync(absFile, 'utf8') || '');
      for (const row of (policy.forbidden_patterns || [])) {
        if (!row || !row.regex) continue;
        const match = body.match(row.regex);
        if (!match || typeof match.index !== 'number') continue;
        const snippet = cleanText(body.slice(match.index, match.index + 140), 140);
        violations.push({
          file: relFile,
          pattern_id: row.id,
          pattern: row.pattern,
          line: lineOf(body, match.index),
          snippet
        });
      }
    }
  }

  const checks = {
    scan_roots_exist: rootsMissing.length === 0,
    no_subconscious_authority_patterns_in_client: violations.length === 0
  };
  const blockingChecks = Object.entries(checks)
    .filter(([, ok]) => ok !== true)
    .map(([k]) => k);
  const pass = blockingChecks.length === 0;
  const out = {
    ok: strict ? pass : true,
    pass,
    strict,
    type: 'subconscious_boundary_guard',
    ts: nowIso(),
    checks,
    blocking_checks: blockingChecks,
    counts: {
      scanned_files: scannedCount,
      roots_missing: rootsMissing.length,
      violations: violations.length
    },
    roots_missing: rootsMissing,
    violations: violations.slice(0, 500)
  };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'check').toLowerCase();
  if (args.help || cmd === '--help' || cmd === 'help') {
    usage();
    return emit({ ok: true, help: true }, 0);
  }

  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);

  if (cmd === 'status') {
    return emit(readJson(policy.paths.latest_path, {
      ok: true,
      type: 'subconscious_boundary_guard',
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
