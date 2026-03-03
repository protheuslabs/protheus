#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-007 / V6-RUST50-001
 * Cross-cell exchange adapter delegated to Rust CRDT core.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
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
const { assertOperationAllowed } = require('../security/rust_security_gate');

const POLICY_PATH = process.env.CROSS_CELL_EXCHANGE_POLICY_PATH
  ? path.resolve(process.env.CROSS_CELL_EXCHANGE_POLICY_PATH)
  : path.join(ROOT, 'config', 'cross_cell_exchange_plane_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/cross_cell_exchange_plane.js exchange --from=<id> --to=<id> --payload=<json>');
  console.log('  node systems/memory/cross_cell_exchange_plane.js status');
}

function policy() {
  const base = {
    enabled: true,
    shadow_only: true,
    exchange_model: 'hereditary_master_reviewed',
    peer_to_peer_network_effect: false,
    rust_manifest: 'crates/memory/Cargo.toml',
    rust_bin: 'memory-cli',
    rust_bin_path: 'target/release/memory-cli',
    paths: {
      latest_path: 'state/memory/cross_cell_exchange/latest.json',
      receipts_path: 'state/memory/cross_cell_exchange/receipts.jsonl',
      exchange_path: 'state/memory/cross_cell_exchange/exchanges.json'
    }
  };
  const raw = readJson(POLICY_PATH, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    enabled: toBool(raw.enabled, base.enabled),
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    exchange_model: normalizeToken(raw.exchange_model || base.exchange_model, 80) || base.exchange_model,
    peer_to_peer_network_effect: toBool(raw.peer_to_peer_network_effect, base.peer_to_peer_network_effect),
    rust_manifest: resolvePath(raw.rust_manifest || base.rust_manifest, base.rust_manifest),
    rust_bin: cleanText(raw.rust_bin || base.rust_bin, 120) || base.rust_bin,
    rust_bin_path: resolvePath(raw.rust_bin_path || base.rust_bin_path, base.rust_bin_path),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      exchange_path: resolvePath(paths.exchange_path, base.paths.exchange_path)
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

function toCrdtMap(raw: any, fallbackNode = 'legacy_cell') {
  const out: Record<string, { value: string, clock: number, node: string }> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      const k = normalizeToken(key, 120);
      if (!k) continue;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const cellAny: any = value;
        const node = normalizeToken(cellAny.node || fallbackNode, 80) || fallbackNode;
        const clockRaw = Number(cellAny.clock);
        const clock = Number.isFinite(clockRaw) && clockRaw >= 0 ? Math.floor(clockRaw) : 1;
        out[k] = {
          value: cleanText(cellAny.value == null ? '' : cellAny.value, 2000),
          clock,
          node
        };
        continue;
      }
      out[k] = {
        value: cleanText(value == null ? '' : value, 2000),
        clock: 1,
        node: fallbackNode
      };
    }
  }
  return out;
}

function parsePayload(args: any, from: string, to: string) {
  const payloadRaw = String(args.payload || '{}').trim();
  let parsed: any = {};
  try {
    parsed = JSON.parse(payloadRaw || '{}');
  } catch {
    throw new Error('invalid_payload_json');
  }
  const baseLeft = parsed && typeof parsed === 'object' && parsed.left && typeof parsed.left === 'object'
    ? parsed.left
    : parsed;
  const baseRight = parsed && typeof parsed === 'object' && parsed.right && typeof parsed.right === 'object'
    ? parsed.right
    : {};
  return {
    left: toCrdtMap(baseLeft, from || 'cell_a'),
    right: toCrdtMap(baseRight, to || 'master')
  };
}

function runRust(args: string[], p: any, timeoutMs = 180000) {
  const started = Date.now();
  const operationDigest = crypto
    .createHash('sha256')
    .update(JSON.stringify(args || []), 'utf8')
    .digest('hex');

  assertOperationAllowed({
    operation_id: `cross_cell_exchange_${started}`,
    subsystem: 'memory',
    action: cleanText(args[0] || 'memory_op', 64),
    actor: 'systems/memory/cross_cell_exchange_plane',
    risk_class: 'high',
    payload_digest: `sha256:${operationDigest}`,
    tags: ['memory', 'crdt', 'foundation_lock'],
    key_age_hours: 1,
    operator_quorum: 2
  }, {
    enforce: true,
    state_root: path.join(ROOT, 'state')
  });

  const possibleBins = [
    cleanText(process.env.PROTHEUS_MEMORY_CORE_BIN || '', 520),
    cleanText(process.env.PROTHEUS_MEMORY_RUST_BIN || '', 520),
    cleanText(p && p.rust_bin_path || '', 520)
  ].filter(Boolean);
  let selectedBin = '';
  for (const bin of possibleBins) {
    if (fs.existsSync(bin)) {
      selectedBin = bin;
      break;
    }
  }
  const command = selectedBin
    ? [selectedBin, ...args]
    : ['cargo', 'run', '--quiet', '--manifest-path', 'crates/memory/Cargo.toml', '--bin', 'memory-cli', '--', ...args];
  const out = spawnSync(command[0], command.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: Math.max(1000, timeoutMs)
  });
  const status = Number.isFinite(Number(out.status)) ? Number(out.status) : 1;
  return {
    ok: status === 0,
    status,
    duration_ms: Math.max(0, Date.now() - started),
    payload: parseJson(String(out.stdout || '')),
    stderr: cleanText(out.stderr || '', 500),
    transport: selectedBin ? 'native_release_bin' : 'cargo_run'
  };
}

function exchange(args: any, p: any) {
  const from = normalizeToken(args.from || 'cell_a', 80) || 'cell_a';
  const to = normalizeToken(args.to || 'master', 80) || 'master';
  let crdtPayload: any = {};
  try {
    crdtPayload = parsePayload(args, from, to);
  } catch (err: any) {
    const out = {
      ts: nowIso(),
      type: 'cross_cell_exchange',
      ok: false,
      error: cleanText(err && err.message || 'invalid_payload', 120)
    };
    writeJsonAtomic(p.paths.latest_path, out);
    appendJsonl(p.paths.receipts_path, out);
    return out;
  }

  const payloadJson = JSON.stringify(crdtPayload);
  const payloadHash = stableHash(payloadJson, 24);
  const run = runRust(['crdt-exchange', `--payload=${payloadJson}`], p);
  const response = run.payload || {};
  const merged = response && typeof response.merged === 'object' ? response.merged : {};
  const mergedHash = stableHash(JSON.stringify(merged), 24);

  const exchanges = readJson(p.paths.exchange_path, { schema_version: '1.1', rows: [] });
  exchanges.schema_version = '1.1';
  exchanges.rows = Array.isArray(exchanges.rows) ? exchanges.rows : [];
  const row = {
    ts: nowIso(),
    from,
    to,
    payload_hash: payloadHash,
    merged_hash: mergedHash,
    merged_cells: Object.keys(merged).length,
    model: p.exchange_model,
    peer_to_peer_network_effect: p.peer_to_peer_network_effect,
    backend: 'rust_core_v6'
  };
  exchanges.rows.push(row);
  if (exchanges.rows.length > 5000) exchanges.rows = exchanges.rows.slice(-5000);
  exchanges.updated_at = nowIso();
  writeJsonAtomic(p.paths.exchange_path, exchanges);

  const out = {
    ts: nowIso(),
    type: 'cross_cell_exchange',
    ok: run.ok && response && response.ok === true,
    shadow_only: p.shadow_only,
    backend: 'rust_core_v6',
    transport: run.transport,
    command_status: run.status,
    duration_ms: run.duration_ms,
    from,
    to,
    payload_hash: payloadHash,
    merged_hash: mergedHash,
    merged_cells: Object.keys(merged).length,
    merged,
    model: p.exchange_model,
    peer_to_peer_network_effect: p.peer_to_peer_network_effect,
    error: response.error || (run.ok ? null : (run.stderr || 'rust_command_failed'))
  };
  writeJsonAtomic(p.paths.latest_path, out);
  appendJsonl(p.paths.receipts_path, out);
  return out;
}

function status(p: any) {
  const latest = readJson(p.paths.latest_path, null);
  const exchanges = readJson(p.paths.exchange_path, { rows: [] });
  const rows = Array.isArray(exchanges.rows) ? exchanges.rows : [];
  return {
    ok: true,
    type: 'cross_cell_exchange_status',
    backend: 'rust_core_v6',
    latest,
    exchange_rows: rows.length
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === '--help' || cmd === 'help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  const p = policy();
  if (!p.enabled) emit({ ok: false, error: 'cross_cell_exchange_disabled' }, 1);
  if (cmd === 'exchange') emit(exchange(args, p), 0);
  if (cmd === 'status') emit(status(p), 0);
  emit({ ok: false, error: 'unsupported_command', cmd }, 1);
}

main();
