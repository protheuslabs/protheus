#!/usr/bin/env node
'use strict';
export {};

/**
 * V6-RUST50-CONF-003
 * Sprint 1 visible Rust migration batch proof runner.
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
  emit
} = require('../../lib/queued_backlog_runtime');

type AnyObj = Record<string, any>;

const DEFAULT_POLICY_PATH = process.env.RUST50_SPRINT1_BATCH_POLICY_PATH
  ? path.resolve(process.env.RUST50_SPRINT1_BATCH_POLICY_PATH)
  : path.join(ROOT, 'config', 'rust50_sprint1_batch_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/rust50_sprint1_batch.js run [--strict=1|0] [--apply=1|0] [--enforcer-active=1|0] [--preamble-text=\"...\"] [--policy=<path>]');
  console.log('  node systems/ops/rust50_sprint1_batch.js status [--policy=<path>]');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function runCommand(command: string[], timeoutMs = 240000) {
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
    stderr: cleanText(out.stderr || '', 800)
  };
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

function countTrackedLines(glob: string) {
  const out = runCommand(['bash', '-lc', `git ls-files '${glob}' | xargs wc -l | tail -n1 | awk '{print $1}'`], 120000);
  if (!out.ok) return null;
  const n = Number(String(out.stdout || '').trim());
  return Number.isFinite(n) ? n : null;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: true,
    lane_id: 'V6-RUST50-CONF-003',
    accepted_preamble: 'ENFORCER RULES ACTIVE — READ codex_enforcer.md FIRST.',
    crates: [
      { id: 'execution', manifest: 'crates/execution/Cargo.toml' },
      { id: 'pinnacle', manifest: 'crates/pinnacle/Cargo.toml' },
      { id: 'vault', manifest: 'crates/vault/Cargo.toml' },
      { id: 'red_legion', manifest: 'crates/red_legion/Cargo.toml' }
    ],
    regression_tests: [
      ['node', 'memory/tools/tests/execution_phase2_rust_parity.test.js'],
      ['node', 'memory/tools/tests/pinnacle_phase2_rust_parity.test.js'],
      ['node', 'memory/tools/tests/vault_phase3_rust_parity.test.js'],
      ['node', 'memory/tools/tests/red_legion_phase2_rust_parity.test.js']
    ],
    sovereignty_tests: [
      ['node', 'memory/tools/tests/execution_security_gate_integration.test.js'],
      ['node', 'memory/tools/tests/vault_sovereignty_fail_closed.test.js']
    ],
    mobile_status_cmd: ['node', 'systems/hybrid/mobile/protheus_mobile_adapter.js', 'status', '--strict=0', '--apply=0'],
    battery_max_pct_24h: 5,
    rust_share_min_pct: null,
    outputs: {
      latest_path: 'state/ops/rust50_sprint1_batch/latest.json',
      history_path: 'state/ops/rust50_sprint1_batch/history.jsonl',
      artifacts_dir: 'state/ops/rust50_sprint1_batch/artifacts'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const cratesRaw = Array.isArray(raw.crates) ? raw.crates : base.crates;
  const crates = cratesRaw
    .map((row: AnyObj) => ({
      id: normalizeToken(row && row.id || '', 80),
      manifest: resolvePath(row && row.manifest, 'crates/execution/Cargo.toml')
    }))
    .filter((row: AnyObj) => row.id && fs.existsSync(row.manifest));
  const regressionTests = Array.isArray(raw.regression_tests) ? raw.regression_tests : base.regression_tests;
  const sovereigntyTests = Array.isArray(raw.sovereignty_tests) ? raw.sovereignty_tests : base.sovereignty_tests;

  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: toBool(raw.enabled, true),
    strict_default: toBool(raw.strict_default, base.strict_default),
    lane_id: cleanText(raw.lane_id || base.lane_id, 80) || base.lane_id,
    accepted_preamble: cleanText(raw.accepted_preamble || base.accepted_preamble, 220) || base.accepted_preamble,
    crates,
    regression_tests: regressionTests,
    sovereignty_tests: sovereigntyTests,
    mobile_status_cmd: Array.isArray(raw.mobile_status_cmd) ? raw.mobile_status_cmd : base.mobile_status_cmd,
    battery_max_pct_24h: Number.isFinite(Number(raw.battery_max_pct_24h))
      ? Number(raw.battery_max_pct_24h)
      : base.battery_max_pct_24h,
    rust_share_min_pct: raw.rust_share_min_pct == null
      ? null
      : (Number.isFinite(Number(raw.rust_share_min_pct)) ? Number(raw.rust_share_min_pct) : null),
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path),
      artifacts_dir: resolvePath(outputs.artifacts_dir, base.outputs.artifacts_dir)
    },
    policy_path: path.resolve(policyPath)
  };
}

function runBatch(policy: AnyObj, strict: boolean, apply: boolean, args: AnyObj) {
  const enforcerActive = toBool(args['enforcer-active'] ?? args.enforcer_active, false);
  const preambleText = cleanText(args['preamble-text'] || args.preamble_text || '', 220);
  const enforcerOk = enforcerActive && preambleText === policy.accepted_preamble;

  const rsBefore = countTrackedLines('*.rs');
  const tsBefore = countTrackedLines('*.ts');

  const buildRows = policy.crates.map((row: AnyObj) => {
    const relManifest = rel(row.manifest);
    const out = runCommand([
      'cargo',
      'build',
      '--manifest-path',
      relManifest,
      '--target',
      'wasm32-unknown-unknown',
      '--release'
    ], 900000);
    return {
      crate: row.id,
      manifest: relManifest,
      ok: out.ok,
      status: out.status,
      duration_ms: out.duration_ms,
      stderr: out.stderr
    };
  });

  const regressionRows = (policy.regression_tests || []).map((cmd: string[]) => {
    const out = runCommand(cmd, 900000);
    return {
      command: cmd,
      ok: out.ok,
      status: out.status,
      duration_ms: out.duration_ms,
      stderr: out.stderr
    };
  });

  const sovereigntyRows = (policy.sovereignty_tests || []).map((cmd: string[]) => {
    const out = runCommand(cmd, 900000);
    return {
      command: cmd,
      ok: out.ok,
      status: out.status,
      duration_ms: out.duration_ms,
      stderr: out.stderr
    };
  });

  const mobile = runCommand(policy.mobile_status_cmd || [], 180000);
  const mobilePayload = parseJsonPayload(mobile.stdout) || {};
  const mobileState = mobilePayload && mobilePayload.state && typeof mobilePayload.state === 'object'
    ? mobilePayload.state
    : {};
  const mobileSummary = mobileState && mobileState.summary && typeof mobileState.summary === 'object'
    ? mobileState.summary
    : {};
  const batteryPct = Number(mobileSummary.background_battery_pct_24h);

  const rsAfter = countTrackedLines('*.rs');
  const tsAfter = countTrackedLines('*.ts');
  const rustShareBefore = rsBefore == null || tsBefore == null || (rsBefore + tsBefore) === 0
    ? null
    : Number(((rsBefore / (rsBefore + tsBefore)) * 100).toFixed(3));
  const rustShareAfter = rsAfter == null || tsAfter == null || (rsAfter + tsAfter) === 0
    ? null
    : Number(((rsAfter / (rsAfter + tsAfter)) * 100).toFixed(3));

  const checks = {
    enforcer_preamble_ack: enforcerOk,
    wasm_builds_ok: buildRows.length > 0 && buildRows.every((row: AnyObj) => row.ok === true),
    regression_tests_ok: regressionRows.length > 0 && regressionRows.every((row: AnyObj) => row.ok === true),
    sovereignty_tests_ok: sovereigntyRows.length > 0 && sovereigntyRows.every((row: AnyObj) => row.ok === true),
    battery_guard_ok: Number.isFinite(batteryPct) && batteryPct <= Number(policy.battery_max_pct_24h),
    rust_lines_non_decreasing: rsBefore == null || rsAfter == null ? false : rsAfter >= rsBefore,
    ts_lines_non_increasing: tsBefore == null || tsAfter == null ? false : tsAfter <= tsBefore,
    rust_share_min_ok: policy.rust_share_min_pct == null
      ? true
      : (rustShareAfter != null && rustShareAfter >= Number(policy.rust_share_min_pct))
  };

  const violations = Object.entries(checks).filter(([, ok]) => ok !== true).map(([k]) => k);
  const ok = violations.length === 0;

  const out = {
    schema_id: 'rust50_sprint1_batch_receipt',
    schema_version: '1.0',
    type: 'rust50_sprint1_batch',
    ts: nowIso(),
    lane_id: policy.lane_id,
    ok,
    strict,
    apply,
    policy_path: rel(policy.policy_path),
    enforcer: {
      active: enforcerActive,
      expected: policy.accepted_preamble,
      provided: preambleText
    },
    checks,
    violations,
    build_matrix: buildRows,
    regression_tests: regressionRows,
    sovereignty_tests: sovereigntyRows,
    mobile_summary: {
      ok: mobile.ok,
      status: mobile.status,
      battery_pct_24h: Number.isFinite(batteryPct) ? batteryPct : null,
      battery_max_pct_24h: policy.battery_max_pct_24h
    },
    policy_targets: {
      rust_share_min_pct: policy.rust_share_min_pct
    },
    line_counts: {
      rs_before: rsBefore,
      rs_after: rsAfter,
      ts_before: tsBefore,
      ts_after: tsAfter,
      rust_share_pct_before: rustShareBefore,
      rust_share_pct_after: rustShareAfter,
      rs_delta: rsBefore == null || rsAfter == null ? null : (rsAfter - rsBefore),
      ts_delta: tsBefore == null || tsAfter == null ? null : (tsAfter - tsBefore)
    }
  };

  if (apply) {
    fs.mkdirSync(path.dirname(policy.outputs.latest_path), { recursive: true });
    fs.mkdirSync(path.dirname(policy.outputs.history_path), { recursive: true });
    fs.mkdirSync(policy.outputs.artifacts_dir, { recursive: true });
    writeJsonAtomic(policy.outputs.latest_path, out);
    appendJsonl(policy.outputs.history_path, out);
    const artifactPath = path.join(policy.outputs.artifacts_dir, `sprint1_${Date.now()}.json`);
    writeJsonAtomic(artifactPath, out);
    out['artifact_path'] = rel(artifactPath);
  }

  return out;
}

function cmdStatus(policy: AnyObj) {
  return {
    ok: true,
    type: 'rust50_sprint1_batch_status',
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
  if (!policy.enabled) emit({ ok: false, error: 'rust50_sprint1_batch_disabled' }, 1);

  if (cmd === 'status') emit(cmdStatus(policy), 0);
  if (cmd === 'run') {
    const strict = args.strict != null ? toBool(args.strict, policy.strict_default) : policy.strict_default;
    const apply = toBool(args.apply, true);
    const out = runBatch(policy, strict, apply, args);
    emit(out, strict && out.ok !== true ? 1 : 0);
  }

  usage();
  process.exit(1);
}

main();
