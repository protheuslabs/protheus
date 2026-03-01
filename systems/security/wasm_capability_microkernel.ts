#!/usr/bin/env node
'use strict';
export {};

/** V3-RACE-002 */
const path = require('path');
const {
  ROOT, nowIso, parseArgs, cleanText, normalizeToken, toBool,
  clampInt, readJson, writeJsonAtomic, appendJsonl, resolvePath, emit
} = require('../../lib/queued_backlog_runtime');

const POLICY_PATH = process.env.WASM_CAPABILITY_MICROKERNEL_POLICY_PATH
  ? path.resolve(process.env.WASM_CAPABILITY_MICROKERNEL_POLICY_PATH)
  : path.join(ROOT, 'config', 'wasm_capability_microkernel_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/wasm_capability_microkernel.js run --module=<id> [--fuel=500000] [--timeout_ms=5000]');
  console.log('  node systems/security/wasm_capability_microkernel.js status');
}

function policy() {
  const base = {
    enabled: true,
    shadow_only: true,
    fuel_default: 500000,
    timeout_ms: 5000,
    io_caps: ['fs_read_limited', 'net_none', 'env_none'],
    paths: {
      latest_path: 'state/security/wasm_microkernel/latest.json',
      receipts_path: 'state/security/wasm_microkernel/receipts.jsonl'
    }
  };
  const raw = readJson(POLICY_PATH, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    enabled: toBool(raw.enabled, base.enabled),
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    fuel_default: clampInt(raw.fuel_default, 1000, 100000000, base.fuel_default),
    timeout_ms: clampInt(raw.timeout_ms, 10, 120000, base.timeout_ms),
    io_caps: Array.isArray(raw.io_caps) ? raw.io_caps.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean) : base.io_caps,
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    }
  };
}

function runSandbox(args: any, p: any) {
  const moduleId = normalizeToken(args.module || 'unknown_module', 120) || 'unknown_module';
  const fuel = clampInt(args.fuel, 1, 100000000, p.fuel_default);
  const timeoutMs = clampInt(args.timeout_ms, 1, 120000, p.timeout_ms);
  const out = {
    ts: nowIso(),
    type: 'wasm_capability_microkernel_run',
    ok: true,
    shadow_only: p.shadow_only,
    module_id: moduleId,
    fuel,
    timeout_ms: timeoutMs,
    io_caps: p.io_caps,
    termination_reason: 'simulated_success',
    deterministic_receipt: true
  };
  writeJsonAtomic(p.paths.latest_path, out);
  appendJsonl(p.paths.receipts_path, out);
  return out;
}

function status(p: any) {
  return { ok: true, type: 'wasm_capability_microkernel_status', latest: readJson(p.paths.latest_path, {}), shadow_only: p.shadow_only };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === '--help' || cmd === 'help' || cmd === '-h') {
    usage();
    return;
  }
  const p = policy();
  if (!p.enabled) emit({ ok: false, error: 'wasm_microkernel_disabled' }, 1);
  if (cmd === 'run') emit(runSandbox(args, p));
  if (cmd === 'status') emit(status(p));
  emit({ ok: false, error: 'unsupported_command', cmd }, 1);
}

main();
