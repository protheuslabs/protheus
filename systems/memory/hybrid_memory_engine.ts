#!/usr/bin/env node
'use strict';
export {};

/**
 * V6 hybrid memory engine adapter.
 * Ebbinghaus and ingestion logic are authoritative in crates/memory.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const {
  ROOT,
  nowIso,
  parseArgs,
  normalizeToken,
  cleanText,
  clampNumber,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');
const { assertOperationAllowed } = require('../security/rust_security_gate');

const path = require('path');
const POLICY_PATH = process.env.HYBRID_MEMORY_ENGINE_POLICY_PATH
  ? path.resolve(process.env.HYBRID_MEMORY_ENGINE_POLICY_PATH)
  : path.join(ROOT, 'config', 'hybrid_memory_engine_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/hybrid_memory_engine.js ingest --objective=<id> --content=<text> [--tags=a,b]');
  console.log('  node systems/memory/hybrid_memory_engine.js consolidate [--aggressive=0|1]');
  console.log('  node systems/memory/hybrid_memory_engine.js status');
}

function policy() {
  const base = {
    enabled: true,
    forgetting_curve_lambda: 0.02,
    rust_bin_path: 'target/release/memory-cli',
    paths: {
      latest_path: 'state/memory/hybrid_engine/latest.json',
      receipts_path: 'state/memory/hybrid_engine/receipts.jsonl'
    }
  };
  const raw = readJson(POLICY_PATH, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    enabled: raw.enabled !== false,
    forgetting_curve_lambda: clampNumber(raw.forgetting_curve_lambda, 0.0001, 1, base.forgetting_curve_lambda),
    rust_bin_path: resolvePath(raw.rust_bin_path || base.rust_bin_path, base.rust_bin_path),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    }
  };
}

function parseJson(rawText: string) {
  const raw = String(rawText || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runRust(args: string[], p: any) {
  const started = Date.now();
  const operationDigest = crypto
    .createHash('sha256')
    .update(JSON.stringify(args || []), 'utf8')
    .digest('hex');

  assertOperationAllowed({
    operation_id: `hybrid_memory_${started}`,
    subsystem: 'memory',
    action: cleanText(args[0] || 'memory_op', 64),
    actor: 'systems/memory/hybrid_memory_engine',
    risk_class: 'high',
    payload_digest: `sha256:${operationDigest}`,
    tags: ['memory', 'hybrid', 'foundation_lock'],
    key_age_hours: 1,
    operator_quorum: 2
  }, {
    enforce: true,
    state_root: path.join(ROOT, 'state')
  });

  const preferredBin = cleanText(process.env.PROTHEUS_MEMORY_CORE_BIN || p.rust_bin_path || '', 520);
  const hasPreferredBin = !!(preferredBin && fs.existsSync(preferredBin));
  const command = hasPreferredBin
    ? [preferredBin, ...args]
    : ['cargo', 'run', '--quiet', '--manifest-path', 'crates/memory/Cargo.toml', '--bin', 'memory-cli', '--', ...args];
  const out = spawnSync(command[0], command.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000
  });
  const status = Number.isFinite(Number(out.status)) ? Number(out.status) : 1;
  return {
    ok: status === 0,
    status,
    duration_ms: Math.max(0, Date.now() - started),
    payload: parseJson(String(out.stdout || '')),
    stderr: cleanText(out.stderr || '', 500),
    transport: hasPreferredBin ? 'native_release_bin' : 'cargo_run'
  };
}

function writeReceipt(p: any, receipt: any) {
  writeJsonAtomic(p.paths.latest_path, receipt);
  appendJsonl(p.paths.receipts_path, receipt);
}

function ingest(args: any, p: any) {
  const objective = normalizeToken(args.objective || 'global', 80) || 'global';
  const content = cleanText(args.content || '', 2000);
  const tags = cleanText(args.tags || objective, 400);
  const repetitions = Number.isFinite(Number(args.repetitions)) ? Math.max(1, Number(args.repetitions)) : 1;
  const run = runRust([
    'ingest',
    `--id=memory://${objective}-${Date.now()}`,
    `--content=${content}`,
    `--tags=${tags}`,
    `--repetitions=${repetitions}`,
    `--lambda=${p.forgetting_curve_lambda}`
  ], p);
  const payload = run.payload || {};
  const receipt = {
    ts: nowIso(),
    type: 'hybrid_memory_ingest',
    ok: run.ok && payload && payload.ok === true,
    backend: 'rust_core_v6',
    transport: run.transport,
    objective,
    command_status: run.status,
    duration_ms: run.duration_ms,
    row: payload.row || null,
    error: payload.error || (run.ok ? null : (run.stderr || 'rust_command_failed'))
  };
  writeReceipt(p, receipt);
  return receipt;
}

function consolidate(args: any, p: any) {
  const aggressive = normalizeToken(args.aggressive || '0', 8) === '1';
  const run = runRust(['compress', `--aggressive=${aggressive ? '1' : '0'}`], p);
  const payload = run.payload || {};
  const receipt = {
    ts: nowIso(),
    type: 'hybrid_memory_consolidate',
    ok: run.ok && payload && payload.ok === true,
    backend: 'rust_core_v6',
    transport: run.transport,
    aggressive,
    command_status: run.status,
    duration_ms: run.duration_ms,
    compacted_rows: Number(payload.compacted_rows || 0),
    error: payload.error || (run.ok ? null : (run.stderr || 'rust_command_failed'))
  };
  writeReceipt(p, receipt);
  return receipt;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === '--help' || cmd === 'help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  const p = policy();
  if (!p.enabled) emit({ ok: false, error: 'hybrid_memory_engine_disabled' }, 1);
  if (cmd === 'ingest') emit(ingest(args, p), 0);
  if (cmd === 'consolidate') emit(consolidate(args, p), 0);
  if (cmd === 'status') emit({ ok: true, type: 'hybrid_memory_engine_status', latest: readJson(p.paths.latest_path, null) }, 0);
  emit({ ok: false, error: 'unsupported_command', cmd }, 1);
}

main();
