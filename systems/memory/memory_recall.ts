#!/usr/bin/env node
'use strict';
export {};

/**
 * V6 memory recall adapter.
 * Delegates recall/get/cache-clear operations to crates/memory Rust core.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');
const { assertOperationAllowed } = require('../security/rust_security_gate');

const POLICY_PATH = process.env.MEMORY_RECALL_POLICY_PATH
  ? path.resolve(process.env.MEMORY_RECALL_POLICY_PATH)
  : path.join(ROOT, 'config', 'memory_recall_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/memory_recall.js query --q="..." [--top=5]');
  console.log('  node systems/memory/memory_recall.js get --id=<memory_id>');
  console.log('  node systems/memory/memory_recall.js clear-cache');
  console.log('  node systems/memory/memory_recall.js status');
}

function policy() {
  const base = {
    enabled: true,
    rust_manifest: 'crates/memory/Cargo.toml',
    rust_bin: 'memory-cli',
    rust_bin_path: 'target/release/memory-cli',
    paths: {
      latest_path: 'state/memory/runtime_audit/memory_recall_latest.json',
      receipts_path: 'state/memory/runtime_audit/memory_recall_receipts.jsonl'
    }
  };
  const raw = readJson(POLICY_PATH, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    enabled: raw.enabled !== false,
    rust_manifest: resolvePath(raw.rust_manifest || base.rust_manifest, base.rust_manifest),
    rust_bin: cleanText(raw.rust_bin || base.rust_bin, 120) || base.rust_bin,
    rust_bin_path: resolvePath(raw.rust_bin_path || base.rust_bin_path, base.rust_bin_path),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    }
  };
}

function parseJson(text: string) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runRust(args: string[], p: any, timeoutMs = 180000) {
  const started = Date.now();
  const operationDigest = crypto
    .createHash('sha256')
    .update(JSON.stringify(args || []), 'utf8')
    .digest('hex');

  assertOperationAllowed({
    operation_id: `memory_recall_${started}`,
    subsystem: 'memory',
    action: cleanText(args[0] || 'memory_op', 64),
    actor: 'systems/memory/memory_recall',
    risk_class: 'normal',
    payload_digest: `sha256:${operationDigest}`,
    tags: ['memory', 'recall', 'foundation_lock'],
    key_age_hours: 1,
    operator_quorum: 2
  }, {
    enforce: true,
    state_root: path.join(ROOT, 'state')
  });

  const preferredBin = cleanText(process.env.PROTHEUS_MEMORY_CORE_BIN || p.rust_bin_path || '', 520);
  const hasPreferredBin = !!(preferredBin && require('fs').existsSync(preferredBin));
  const cmd = hasPreferredBin
    ? [preferredBin, ...args]
    : [
      'cargo',
      'run',
      '--quiet',
      '--manifest-path',
      'crates/memory/Cargo.toml',
      '--bin',
      'memory-cli',
      '--',
      ...args
    ];
  const out = spawnSync(cmd[0], cmd.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: Math.max(1000, timeoutMs)
  });
  const status = Number.isFinite(Number(out.status)) ? Number(out.status) : 1;
  return {
    ok: status === 0,
    status,
    duration_ms: Math.max(0, Date.now() - started),
    stderr: cleanText(out.stderr || '', 500),
    payload: parseJson(String(out.stdout || '')),
    command: cmd,
    transport: hasPreferredBin ? 'native_release_bin' : 'cargo_run'
  };
}

function writeReceipt(p: any, receipt: any) {
  writeJsonAtomic(p.paths.latest_path, receipt);
  appendJsonl(p.paths.receipts_path, receipt);
}

function cmdQuery(args: any, p: any) {
  const q = cleanText(args.q || args.query || '', 400);
  const top = Number.isFinite(Number(args.top)) ? Math.max(1, Number(args.top)) : 5;
  const run = runRust([`recall`, `--query=${q}`, `--limit=${top}`], p);
  const payload = run.payload || {};
  const receipt = {
    ts: nowIso(),
    type: 'memory_recall_query',
    ok: run.ok && payload && payload.ok === true,
    backend: 'rust_core_v6',
    transport: run.transport,
    command_status: run.status,
    duration_ms: run.duration_ms,
    query: q,
    top,
    hit_count: Number(payload.hit_count || 0),
    hits: Array.isArray(payload.hits) ? payload.hits : [],
    error: payload.error || (run.ok ? null : (run.stderr || 'rust_command_failed'))
  };
  writeReceipt(p, receipt);
  return receipt;
}

function cmdGet(args: any, p: any) {
  const id = cleanText(args.id || args['node-id'] || args.uid || '', 200);
  const run = runRust([`get`, `--id=${id}`], p);
  const payload = run.payload || {};
  const receipt = {
    ts: nowIso(),
    type: 'memory_recall_get',
    ok: run.ok && payload && payload.ok === true,
    backend: 'rust_core_v6',
    transport: run.transport,
    command_status: run.status,
    duration_ms: run.duration_ms,
    id,
    row: payload.row || null,
    error: payload.error || (run.ok ? null : (run.stderr || 'rust_command_failed'))
  };
  writeReceipt(p, receipt);
  return receipt;
}

function cmdClearCache(p: any) {
  const run = runRust(['clear-cache'], p);
  const payload = run.payload || {};
  const receipt = {
    ts: nowIso(),
    type: 'memory_recall_clear_cache',
    ok: run.ok && payload && payload.ok === true,
    backend: 'rust_core_v6',
    transport: run.transport,
    command_status: run.status,
    duration_ms: run.duration_ms,
    cleared: Number(payload.cleared || 0),
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
  if (!p.enabled) emit({ ok: false, error: 'memory_recall_disabled' }, 1);

  if (cmd === 'query') emit(cmdQuery(args, p), 0);
  if (cmd === 'get') emit(cmdGet(args, p), 0);
  if (cmd === 'clear-cache') emit(cmdClearCache(p), 0);
  if (cmd === 'status') emit({ ok: true, type: 'memory_recall_status', latest: readJson(p.paths.latest_path, null) }, 0);

  emit({ ok: false, error: 'unsupported_command', cmd }, 1);
}

main();
