#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

type AnyObj = Record<string, any>;

const POLICY_PATH = process.env.RUST_AUTHORITATIVE_MICROKERNEL_ACCELERATION_POLICY_PATH
  ? path.resolve(process.env.RUST_AUTHORITATIVE_MICROKERNEL_ACCELERATION_POLICY_PATH)
  : path.join(ROOT, 'config', 'rust_authoritative_microkernel_acceleration_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/rust_authoritative_microkernel_acceleration.js run [--strict=1|0] [--apply=1|0] [--policy=<path>]');
  console.log('  node systems/ops/rust_authoritative_microkernel_acceleration.js report [--policy=<path>]');
  console.log('  node systems/ops/rust_authoritative_microkernel_acceleration.js status [--policy=<path>]');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function workspaceRoot() {
  const raw = cleanText(process.env.OPENCLAW_WORKSPACE || '', 520);
  if (raw) return path.resolve(raw);
  return ROOT;
}

function walk(rootDir: string, out: string[] = []) {
  if (!fs.existsSync(rootDir)) return out;
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(rootDir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

function loadPolicy(policyPath: string) {
  const raw = readJson(policyPath, {});
  const base = {
    version: '1.0',
    enabled: true,
    strict_default: true,
    targets: {
      rust_share_min_pct: 55,
      rust_share_max_pct: 65,
      enforce_target_during_cutover: false
    },
    scan: {
      include_extensions: ['.rs', '.ts', '.js'],
      ignore_roots: ['node_modules', 'dist', 'state', 'tmp', 'coverage']
    },
    commands: {},
    paths: {
      latest_path: 'state/ops/rust_authoritative_microkernel_acceleration/latest.json',
      receipts_path: 'state/ops/rust_authoritative_microkernel_acceleration/receipts.jsonl',
      language_report_path: 'state/ops/rust_authoritative_microkernel_acceleration/language_report.json'
    }
  };
  const merged = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };
  const outPaths = merged.paths && typeof merged.paths === 'object' ? merged.paths : {};
  return {
    ...merged,
    scan: {
      include_extensions: Array.isArray(merged.scan && merged.scan.include_extensions)
        ? merged.scan.include_extensions.map((row: unknown) => cleanText(row, 12)).filter(Boolean)
        : base.scan.include_extensions,
      ignore_roots: Array.isArray(merged.scan && merged.scan.ignore_roots)
        ? merged.scan.ignore_roots.map((row: unknown) => cleanText(row, 120)).filter(Boolean)
        : base.scan.ignore_roots
    },
    paths: {
      latest_path: resolvePath(outPaths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(outPaths.receipts_path, base.paths.receipts_path),
      language_report_path: resolvePath(outPaths.language_report_path, base.paths.language_report_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function scanLanguageReport(policy: any) {
  const ws = workspaceRoot();
  const include = new Set((policy.scan.include_extensions || []).map((row: string) => row.toLowerCase()));
  const ignore = (policy.scan.ignore_roots || []).map((row: string) => row.toLowerCase());
  const bytes = { rs: 0, ts: 0, js: 0 };
  for (const abs of walk(ws)) {
    const relPath = path.relative(ws, abs).replace(/\\/g, '/').toLowerCase();
    if (ignore.some((prefix: string) => relPath === prefix || relPath.startsWith(`${prefix}/`))) continue;
    const ext = path.extname(abs).toLowerCase();
    if (!include.has(ext)) continue;
    const size = Number(fs.statSync(abs).size || 0);
    if (ext === '.rs') bytes.rs += size;
    if (ext === '.ts') bytes.ts += size;
    if (ext === '.js') bytes.js += size;
  }
  const total = bytes.rs + bytes.ts + bytes.js;
  const rustSharePct = total > 0 ? Number(((bytes.rs / total) * 100).toFixed(6)) : 0;
  return {
    schema_id: 'rust_authoritative_microkernel_language_report',
    schema_version: '1.0',
    ts: nowIso(),
    workspace_root: ws,
    bytes,
    total_bytes: total,
    rust_share_pct: rustSharePct,
    targets: policy.targets
  };
}

function runCommand(commandRow: unknown) {
  if (!Array.isArray(commandRow) || commandRow.length === 0) {
    return { ok: false, error: 'invalid_command_spec', exit_code: 1 };
  }
  const [bin, ...args] = commandRow.map((row: unknown) => String(row));
  const out = spawnSync(bin, args, {
    cwd: workspaceRoot(),
    encoding: 'utf8'
  });
  return {
    ok: Number(out.status) === 0,
    exit_code: Number(out.status),
    stdout: cleanText(out.stdout || '', 4000),
    stderr: cleanText(out.stderr || '', 4000),
    command: [bin, ...args]
  };
}

function persist(policy: any, row: any, apply: boolean) {
  if (!apply) return;
  writeJsonAtomic(policy.paths.latest_path, row);
  appendJsonl(policy.paths.receipts_path, row);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (args.help || cmd === 'help') {
    usage();
    emit({ ok: true, type: 'rust_authoritative_microkernel_acceleration_help' }, 0);
  }
  const policyPath = args.policy ? path.resolve(String(args.policy)) : POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const strict = toBool(args.strict, policy.strict_default);
  const apply = toBool(args.apply, true);
  if (policy.enabled === false) {
    emit({ ok: false, type: 'rust_authoritative_microkernel_acceleration_error', error: 'lane_disabled' }, 2);
  }

  if (cmd === 'status') {
    emit({
      ok: true,
      type: 'rust_authoritative_microkernel_acceleration_status',
      ts: nowIso(),
      latest: readJson(policy.paths.latest_path, {}),
      policy_path: rel(policy.policy_path)
    }, 0);
  }

  if (cmd === 'report') {
    const report = scanLanguageReport(policy);
    writeJsonAtomic(policy.paths.language_report_path, report);
    emit({ ok: true, type: 'rust_authoritative_microkernel_acceleration_report', report }, 0);
  }

  if (cmd !== 'run') {
    emit({ ok: false, type: 'rust_authoritative_microkernel_acceleration_error', error: 'unsupported_command', cmd }, 2);
  }

  const commandResults: AnyObj = {};
  let passRequiredChecks = true;
  for (const [name, row] of Object.entries(policy.commands || {})) {
    const result = runCommand(row);
    commandResults[name] = result;
    if (!result.ok) passRequiredChecks = false;
  }

  const languageReport = scanLanguageReport(policy);
  writeJsonAtomic(policy.paths.language_report_path, languageReport);
  const rustShare = Number(languageReport.rust_share_pct || 0);
  const targetMin = Number(policy.targets && policy.targets.rust_share_min_pct) || 0;
  const targetMax = Number(policy.targets && policy.targets.rust_share_max_pct) || 100;
  const withinTarget = rustShare >= targetMin && rustShare <= targetMax;
  const pass = passRequiredChecks && (!policy.targets.enforce_target_during_cutover || withinTarget);

  const row = {
    ok: pass,
    type: 'rust_authoritative_microkernel_acceleration',
    ts: nowIso(),
    strict,
    apply,
    pass_required_checks: passRequiredChecks,
    rust_share_pct: rustShare,
    within_target_window: withinTarget,
    target_window: { min_pct: targetMin, max_pct: targetMax },
    command_results: commandResults,
    policy_path: rel(policy.policy_path)
  };
  persist(policy, row, apply);
  emit(row, row.ok || !strict ? 0 : 1);
}

main();
