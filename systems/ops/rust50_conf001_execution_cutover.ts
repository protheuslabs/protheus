#!/usr/bin/env node
'use strict';
export {};

/**
 * V6-RUST50-CONF-001
 *
 * Execution crate public-language-bar conformance gate.
 * Verifies real Rust ownership and proof bundle requirements before completion.
 */

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
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

type AnyObj = Record<string, any>;

const DEFAULT_POLICY_PATH = process.env.RUST50_CONF001_POLICY_PATH
  ? path.resolve(process.env.RUST50_CONF001_POLICY_PATH)
  : path.join(ROOT, 'config', 'rust50_conf001_execution_cutover_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/rust50_conf001_execution_cutover.js run [--strict=1|0] [--apply=1|0] [--enforcer-active=1|0] [--preamble-text="..."] [--approval-recorded=1|0] [--policy=<path>]');
  console.log('  node systems/ops/rust50_conf001_execution_cutover.js status [--policy=<path>]');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function runCommand(command: string[], timeoutMs = 300000) {
  const started = Date.now();
  const out = spawnSync(command[0], command.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: Math.max(1000, timeoutMs),
    maxBuffer: 16 * 1024 * 1024
  });
  const status = Number.isFinite(Number(out.status)) ? Number(out.status) : 1;
  return {
    ok: status === 0,
    status,
    duration_ms: Math.max(0, Date.now() - started),
    command,
    stdout: String(out.stdout || ''),
    stderr: cleanText(out.stderr || '', 1000)
  };
}

function normalizeList(v: unknown, maxLen = 260) {
  if (!Array.isArray(v)) return [];
  return v.map((row) => cleanText(row, maxLen)).filter(Boolean);
}

function countTrackedLines(glob: string) {
  const out = runCommand(['bash', '-lc', `git ls-files '${glob}' | xargs wc -l | tail -n1 | awk '{print $1}'`], 120000);
  if (!out.ok) return null;
  const n = Number(String(out.stdout || '').trim());
  return Number.isFinite(n) ? n : null;
}

function parseJsonPayload(raw: unknown) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: true,
    lane_id: 'V6-RUST50-CONF-001',
    accepted_preamble: 'ENFORCER RULES ACTIVE — READ codex_enforcer.md FIRST.',
    required_refs: [
      'codex_enforcer.md',
      'crates/execution/Cargo.toml',
      'crates/execution/src/lib.rs',
      'crates/execution/src/main.rs',
      'systems/execution/index.ts',
      'memory/tools/tests/execution_phase2_rust_parity.test.js',
      'memory/tools/tests/execution_security_gate_integration.test.js'
    ],
    checks: {
      wasm_build_cmd: ['cargo', 'build', '--manifest-path', 'crates/execution/Cargo.toml', '--target', 'wasm32-unknown-unknown', '--release'],
      parity_test_cmd: ['node', 'memory/tools/tests/execution_phase2_rust_parity.test.js'],
      sovereignty_test_cmd: ['node', 'memory/tools/tests/execution_security_gate_integration.test.js']
    },
    outputs: {
      latest_path: 'state/ops/rust50_conf001/latest.json',
      history_path: 'state/ops/rust50_conf001/history.jsonl',
      artifacts_dir: 'state/ops/rust50_conf001/artifacts'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const checks = raw.checks && typeof raw.checks === 'object' ? raw.checks : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};

  const requiredRefs = normalizeList(raw.required_refs || base.required_refs, 320)
    .map((p: string) => path.isAbsolute(p) ? p : path.join(ROOT, p));

  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: toBool(raw.enabled, true),
    strict_default: toBool(raw.strict_default, base.strict_default),
    lane_id: cleanText(raw.lane_id || base.lane_id, 80) || base.lane_id,
    accepted_preamble: cleanText(raw.accepted_preamble || base.accepted_preamble, 220) || base.accepted_preamble,
    required_refs: requiredRefs,
    checks: {
      wasm_build_cmd: Array.isArray(checks.wasm_build_cmd) ? checks.wasm_build_cmd : base.checks.wasm_build_cmd,
      parity_test_cmd: Array.isArray(checks.parity_test_cmd) ? checks.parity_test_cmd : base.checks.parity_test_cmd,
      sovereignty_test_cmd: Array.isArray(checks.sovereignty_test_cmd) ? checks.sovereignty_test_cmd : base.checks.sovereignty_test_cmd
    },
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path),
      artifacts_dir: resolvePath(outputs.artifacts_dir, base.outputs.artifacts_dir)
    },
    policy_path: path.resolve(policyPath)
  };
}

function requiredRefsReport(policy: AnyObj) {
  const present: AnyObj[] = [];
  const missing: string[] = [];
  for (const absPath of policy.required_refs || []) {
    if (!fs.existsSync(absPath)) {
      missing.push(rel(absPath));
      continue;
    }
    const stat = fs.statSync(absPath);
    present.push({
      path: rel(absPath),
      bytes: Number(stat.size || 0),
      sha256: stableHash(fs.readFileSync(absPath), 64)
    });
  }
  return {
    required_count: Number((policy.required_refs || []).length),
    present_count: present.length,
    missing_count: missing.length,
    present,
    missing,
    ok: missing.length === 0
  };
}

function inspectExecutionSurface() {
  const cargoTomlPath = path.join(ROOT, 'crates/execution/Cargo.toml');
  const libPath = path.join(ROOT, 'crates/execution/src/lib.rs');
  const wrapperPath = path.join(ROOT, 'systems/execution/index.ts');

  const cargoToml = fs.existsSync(cargoTomlPath) ? fs.readFileSync(cargoTomlPath, 'utf8') : '';
  const libSource = fs.existsSync(libPath) ? fs.readFileSync(libPath, 'utf8') : '';
  const wrapperSource = fs.existsSync(wrapperPath) ? fs.readFileSync(wrapperPath, 'utf8') : '';

  return {
    cargo_has_cdylib: /crate-type\s*=\s*\[[^\]]*"cdylib"/m.test(cargoToml),
    cargo_has_wasm_target: /target\.'cfg\(target_arch\s*=\s*"wasm32"\)'/m.test(cargoToml) || /wasm32-unknown-unknown/m.test(cargoToml),
    rust_run_workflow_signature: /pub\s+fn\s+run_workflow\s*\(\s*yaml:\s*&str\s*\)\s*->\s*ExecutionReceipt/m.test(libSource),
    rust_ffi_signature: /pub\s+extern\s+"C"\s+fn\s+run_workflow_ffi\s*\(/m.test(libSource),
    ts_wrapper_rust_bin_bridge: /runViaRustBinary\s*\(/m.test(wrapperSource),
    ts_wrapper_rust_cargo_bridge: /runViaCargo\s*\(/m.test(wrapperSource)
  };
}

function runLane(policy: AnyObj, strict: boolean, apply: boolean, args: AnyObj) {
  const enforcerActive = toBool(args['enforcer-active'] ?? args.enforcer_active, false);
  const preambleText = cleanText(args['preamble-text'] || args.preamble_text || '', 220);
  const approvalRecorded = toBool(args['approval-recorded'] ?? args.approval_recorded, false);

  const refs = requiredRefsReport(policy);
  const surface = inspectExecutionSurface();

  const wasmBuild = runCommand(policy.checks.wasm_build_cmd, 900000);
  const parity = runCommand(policy.checks.parity_test_cmd, 900000);
  const sovereignty = runCommand(policy.checks.sovereignty_test_cmd, 900000);

  const rsNow = countTrackedLines('*.rs');
  const tsNow = countTrackedLines('*.ts');
  const latest = readJson(policy.outputs.latest_path, null);
  const prev = latest && latest.line_counts && typeof latest.line_counts === 'object'
    ? latest.line_counts
    : {};
  const rsPrev = Number.isFinite(Number(prev.rs_now)) ? Number(prev.rs_now) : rsNow;
  const tsPrev = Number.isFinite(Number(prev.ts_now)) ? Number(prev.ts_now) : tsNow;

  const checks = {
    enforcer_preamble_ack: enforcerActive && preambleText === policy.accepted_preamble,
    approval_recorded: approvalRecorded,
    required_refs_ok: refs.ok,
    cargo_has_cdylib: surface.cargo_has_cdylib === true,
    cargo_has_wasm_target: surface.cargo_has_wasm_target === true,
    rust_run_workflow_signature: surface.rust_run_workflow_signature === true,
    rust_ffi_signature: surface.rust_ffi_signature === true,
    ts_wrapper_rust_bin_bridge: surface.ts_wrapper_rust_bin_bridge === true,
    ts_wrapper_rust_cargo_bridge: surface.ts_wrapper_rust_cargo_bridge === true,
    wasm_build_ok: wasmBuild.ok,
    parity_test_ok: parity.ok,
    sovereignty_test_ok: sovereignty.ok,
    rs_lines_non_decreasing: rsNow == null || rsPrev == null ? false : rsNow >= rsPrev,
    ts_lines_non_increasing: tsNow == null || tsPrev == null ? false : tsNow <= tsPrev
  };

  const violations = Object.entries(checks).filter(([, ok]) => ok !== true).map(([k]) => k);
  const ok = violations.length === 0;

  const rsShare = rsNow == null || tsNow == null || (rsNow + tsNow) === 0
    ? null
    : Number(((100 * rsNow) / (rsNow + tsNow)).toFixed(3));

  const out = {
    schema_id: 'rust50_conf001_receipt',
    schema_version: '1.0',
    artifact_type: 'receipt',
    type: 'rust50_conf001_execution_cutover',
    lane_id: policy.lane_id,
    ts: nowIso(),
    ok,
    strict,
    apply,
    policy_path: rel(policy.policy_path),
    checks,
    violations,
    enforcer: {
      active: enforcerActive,
      expected: policy.accepted_preamble,
      provided: preambleText,
      approval_recorded: approvalRecorded
    },
    surface,
    refs,
    commands: {
      wasm_build: {
        ok: wasmBuild.ok,
        status: wasmBuild.status,
        duration_ms: wasmBuild.duration_ms,
        stderr: wasmBuild.stderr
      },
      parity_test: {
        ok: parity.ok,
        status: parity.status,
        duration_ms: parity.duration_ms,
        stderr: parity.stderr
      },
      sovereignty_test: {
        ok: sovereignty.ok,
        status: sovereignty.status,
        duration_ms: sovereignty.duration_ms,
        stderr: sovereignty.stderr
      }
    },
    line_counts: {
      rs_prev: rsPrev,
      rs_now: rsNow,
      ts_prev: tsPrev,
      ts_now: tsNow,
      rs_delta: rsNow == null || rsPrev == null ? null : rsNow - rsPrev,
      ts_delta: tsNow == null || tsPrev == null ? null : tsNow - tsPrev,
      rust_share_pct_now: rsShare
    }
  };

  if (apply) {
    fs.mkdirSync(path.dirname(policy.outputs.latest_path), { recursive: true });
    fs.mkdirSync(path.dirname(policy.outputs.history_path), { recursive: true });
    fs.mkdirSync(policy.outputs.artifacts_dir, { recursive: true });
    writeJsonAtomic(policy.outputs.latest_path, out);
    appendJsonl(policy.outputs.history_path, out);
    const artifactPath = path.join(policy.outputs.artifacts_dir, `conf001_${Date.now()}.json`);
    writeJsonAtomic(artifactPath, out);
    out['artifact_path'] = rel(artifactPath);
  }

  return out;
}

function cmdStatus(policy: AnyObj) {
  return {
    ok: true,
    type: 'rust50_conf001_execution_cutover_status',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    latest: readJson(policy.outputs.latest_path, null)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 40) || 'status';
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    process.exit(0);
  }

  const policyPath = args.policy
    ? (path.isAbsolute(String(args.policy)) ? String(args.policy) : path.join(ROOT, String(args.policy)))
    : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) emit({ ok: false, error: 'rust50_conf001_execution_cutover_disabled' }, 1);

  if (cmd === 'status') emit(cmdStatus(policy), 0);
  if (cmd === 'run') {
    const strict = args.strict != null ? toBool(args.strict, policy.strict_default) : policy.strict_default;
    const apply = toBool(args.apply, true);
    const out = runLane(policy, strict, apply, args);
    emit(out, strict && out.ok !== true ? 1 : 0);
  }

  usage();
  process.exit(1);
}

main();
