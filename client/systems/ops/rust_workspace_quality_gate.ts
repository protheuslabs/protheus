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

const POLICY_PATH = process.env.RUST_WORKSPACE_QUALITY_GATE_POLICY_PATH
  ? path.resolve(process.env.RUST_WORKSPACE_QUALITY_GATE_POLICY_PATH)
  : path.join(ROOT, 'config', 'rust_workspace_quality_gate_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/rust_workspace_quality_gate.js run [--strict=1|0] [--apply=1|0] [--policy=<path>]');
  console.log('  node systems/ops/rust_workspace_quality_gate.js status [--policy=<path>]');
}

function workspaceRoot() {
  const raw = cleanText(process.env.OPENCLAW_WORKSPACE || '', 520);
  if (raw) return path.resolve(raw);
  return ROOT;
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function runCmd(bin: string, args: string[]) {
  const out = spawnSync(bin, args, { cwd: workspaceRoot(), encoding: 'utf8' });
  return {
    ok: Number(out.status) === 0,
    exit_code: Number(out.status),
    stdout: cleanText(out.stdout || '', 2000),
    stderr: cleanText(out.stderr || '', 2000)
  };
}

function loadPolicy(policyPath: string) {
  const raw = readJson(policyPath, {});
  const base = {
    version: '1.0',
    enabled: true,
    strict_default: true,
    cargo_bin: 'cargo',
    checks: {
      enforce_workspace_manifest: true,
      enforce_toolchain_manifest: true,
      enforce_docs_generated: true,
      enforce_cargo_metadata: true,
      enforce_cargo_fmt: false,
      enforce_cargo_clippy: false,
      enforce_cargo_test: false
    },
    docs_required: [
      'docs/generated/TS_LANE_TYPE_REFERENCE.md',
      'docs/generated/RUST_LANE_TYPE_REFERENCE.md'
    ],
    commands: {
      metadata: ['metadata', '--format-version', '1', '--no-deps'],
      fmt: ['fmt', '--all', '--', '--check'],
      clippy: ['clippy', '--workspace', '--all-targets', '--all-features', '--', '-D', 'warnings'],
      test: ['test', '--workspace']
    },
    paths: {
      latest_path: 'state/ops/rust_workspace_quality_gate/latest.json',
      receipts_path: 'state/ops/rust_workspace_quality_gate/receipts.jsonl'
    }
  };
  const merged = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };
  const outPaths = merged.paths && typeof merged.paths === 'object' ? merged.paths : {};
  return {
    ...merged,
    docs_required: Array.isArray(merged.docs_required)
      ? merged.docs_required.map((row: unknown) => path.resolve(workspaceRoot(), cleanText(row, 260))).filter(Boolean)
      : [],
    paths: {
      latest_path: resolvePath(outPaths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(outPaths.receipts_path, base.paths.receipts_path)
    },
    policy_path: path.resolve(policyPath)
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
    emit({ ok: true, type: 'rust_workspace_quality_gate_help' }, 0);
  }
  const policyPath = args.policy ? path.resolve(String(args.policy)) : POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const strict = toBool(args.strict, policy.strict_default);
  const apply = toBool(args.apply, true);
  if (policy.enabled === false) {
    emit({ ok: false, type: 'rust_workspace_quality_gate_error', error: 'lane_disabled' }, 2);
  }

  if (cmd === 'status') {
    emit({
      ok: true,
      type: 'rust_workspace_quality_gate_status',
      ts: nowIso(),
      latest: readJson(policy.paths.latest_path, {}),
      policy_path: rel(policy.policy_path)
    }, 0);
  }

  if (cmd !== 'run') {
    emit({ ok: false, type: 'rust_workspace_quality_gate_error', error: 'unsupported_command', cmd }, 2);
  }

  const checks: any[] = [];
  const ws = workspaceRoot();

  if (policy.checks.enforce_workspace_manifest) {
    checks.push({
      id: 'workspace_manifest',
      pass: fs.existsSync(path.join(ws, 'Cargo.toml')),
      reason: 'Cargo.toml must exist at workspace root'
    });
  }
  if (policy.checks.enforce_toolchain_manifest) {
    checks.push({
      id: 'toolchain_manifest',
      pass: fs.existsSync(path.join(ws, 'rust-toolchain.toml')),
      reason: 'rust-toolchain.toml must exist at workspace root'
    });
  }
  if (policy.checks.enforce_docs_generated) {
    const missingDocs = (policy.docs_required || []).filter((docPath: string) => !fs.existsSync(docPath));
    checks.push({
      id: 'generated_docs',
      pass: missingDocs.length === 0,
      reason: missingDocs.length ? `missing_docs:${missingDocs.map((row: string) => path.relative(ws, row)).join(',')}` : 'ok'
    });
  }

  const cmdResults: any = {};
  function runPolicyCommand(key: string) {
    const row = policy.commands && policy.commands[key];
    if (!Array.isArray(row) || row.length === 0) {
      cmdResults[key] = { ok: false, exit_code: 1, stderr: 'missing_command' };
      checks.push({ id: `cargo_${key}`, pass: false, reason: 'missing_command' });
      return;
    }
    cmdResults[key] = runCmd(String(policy.cargo_bin || 'cargo'), row.map((v: unknown) => String(v)));
    checks.push({
      id: `cargo_${key}`,
      pass: cmdResults[key].ok,
      reason: cmdResults[key].ok ? 'ok' : `exit_${cmdResults[key].exit_code}`
    });
  }

  if (policy.checks.enforce_cargo_metadata) runPolicyCommand('metadata');
  if (policy.checks.enforce_cargo_fmt) runPolicyCommand('fmt');
  if (policy.checks.enforce_cargo_clippy) runPolicyCommand('clippy');
  if (policy.checks.enforce_cargo_test) runPolicyCommand('test');

  const pass = checks.every((row) => row.pass === true);
  const row = {
    ok: pass,
    pass,
    type: 'rust_workspace_quality_gate',
    ts: nowIso(),
    strict,
    apply,
    checks,
    command_results: cmdResults,
    policy_path: rel(policy.policy_path)
  };
  persist(policy, row, apply);
  emit(row, row.pass || !strict ? 0 : 1);
}

main();
