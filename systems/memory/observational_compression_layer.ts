#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-164 / V6-RUST50-001
 * Observational compression adapter delegated to Rust memory core.
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
  clampInt,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { assertOperationAllowed } = require('../security/rust_security_gate');

const POLICY_PATH = process.env.V3_RACE_164_POLICY_PATH
  ? path.resolve(process.env.V3_RACE_164_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'observational_compression_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/observational_compression_layer.js configure --owner=<owner_id> [--profile=default]');
  console.log('  node systems/memory/observational_compression_layer.js execute --owner=<owner_id> [--task=default] [--risk-tier=2]');
  console.log('  node systems/memory/observational_compression_layer.js status [--owner=<owner_id>]');
}

function policy() {
  const base = {
    enabled: true,
    strict_default: true,
    risk: {
      default_tier: 2,
      require_explicit_approval_tier: 3
    },
    rust_manifest: 'crates/memory/Cargo.toml',
    rust_bin: 'memory-cli',
    rust_bin_path: 'target/release/memory-cli',
    paths: {
      memory_dir: 'memory/observations',
      adaptive_index_path: 'adaptive/observations/index.json',
      events_path: 'state/memory/observational_compression/events.jsonl',
      latest_path: 'state/memory/observational_compression/latest.json',
      receipts_path: 'state/memory/observational_compression/receipts.jsonl'
    }
  };
  const raw = readJson(POLICY_PATH, {});
  const risk = raw.risk && typeof raw.risk === 'object' ? raw.risk : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    enabled: toBool(raw.enabled, base.enabled),
    strict_default: toBool(raw.strict_default, base.strict_default),
    risk: {
      default_tier: clampInt(risk.default_tier, 1, 4, base.risk.default_tier),
      require_explicit_approval_tier: clampInt(
        risk.require_explicit_approval_tier,
        1,
        4,
        base.risk.require_explicit_approval_tier
      )
    },
    rust_manifest: resolvePath(raw.rust_manifest || base.rust_manifest, base.rust_manifest),
    rust_bin: cleanText(raw.rust_bin || base.rust_bin, 120) || base.rust_bin,
    rust_bin_path: resolvePath(raw.rust_bin_path || base.rust_bin_path, base.rust_bin_path),
    paths: {
      memory_dir: resolvePath(paths.memory_dir, base.paths.memory_dir),
      adaptive_index_path: resolvePath(paths.adaptive_index_path, base.paths.adaptive_index_path),
      events_path: resolvePath(paths.events_path, base.paths.events_path),
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

function runRust(args: string[], p: any, timeoutMs = 180000) {
  const started = Date.now();
  const operationDigest = crypto
    .createHash('sha256')
    .update(JSON.stringify(args || []), 'utf8')
    .digest('hex');

  assertOperationAllowed({
    operation_id: `observational_compression_${started}`,
    subsystem: 'memory',
    action: cleanText(args[0] || 'memory_op', 64),
    actor: 'systems/memory/observational_compression_layer',
    risk_class: 'high',
    payload_digest: `sha256:${operationDigest}`,
    tags: ['memory', 'compression', 'foundation_lock'],
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

function writeReceipt(p: any, receipt: any) {
  writeJsonAtomic(p.paths.latest_path, receipt);
  appendJsonl(p.paths.receipts_path, receipt);
  appendJsonl(p.paths.events_path, {
    ts: receipt.ts,
    event: receipt.type,
    owner: receipt.owner || null,
    ok: receipt.ok,
    command_status: receipt.command_status,
    compacted_rows: receipt.compacted_rows || 0
  });
}

function loadProfiles(p: any) {
  const state = readJson(p.paths.adaptive_index_path, { schema_version: '1.0', owners: {} });
  state.schema_version = '1.0';
  state.owners = state.owners && typeof state.owners === 'object' ? state.owners : {};
  return state;
}

function saveProfiles(p: any, state: any) {
  writeJsonAtomic(p.paths.adaptive_index_path, state);
}

function configure(args: any, p: any) {
  const owner = normalizeToken(args.owner || 'global', 120) || 'global';
  const profile = normalizeToken(args.profile || 'default', 120) || 'default';
  const state = loadProfiles(p);
  state.owners[owner] = {
    owner,
    profile,
    configured_at: nowIso()
  };
  saveProfiles(p, state);
  const receipt = {
    ts: nowIso(),
    type: 'observational_compression_configure',
    ok: true,
    owner,
    profile,
    backend: 'rust_core_v6'
  };
  writeReceipt(p, receipt);
  return receipt;
}

function execute(args: any, p: any) {
  const owner = normalizeToken(args.owner || 'global', 120) || 'global';
  const task = normalizeToken(args.task || args.mode || 'default', 120) || 'default';
  const riskTier = clampInt(args['risk-tier'], 1, 4, p.risk.default_tier);
  const aggressive = riskTier >= p.risk.require_explicit_approval_tier
    || task.includes('aggressive')
    || normalizeToken(args.aggressive || '0', 8) === '1';
  const run = runRust(['compress', `--aggressive=${aggressive ? '1' : '0'}`], p);
  const payload = run.payload || {};
  const receipt = {
    ts: nowIso(),
    type: 'observational_compression_execute',
    ok: run.ok && payload && payload.ok === true,
    owner,
    task,
    risk_tier: riskTier,
    aggressive,
    backend: 'rust_core_v6',
    transport: run.transport,
    command_status: run.status,
    duration_ms: run.duration_ms,
    compacted_rows: Number(payload.compacted_rows || 0),
    error: payload.error || (run.ok ? null : (run.stderr || 'rust_command_failed'))
  };
  writeReceipt(p, receipt);
  return receipt;
}

function status(args: any, p: any) {
  const owner = normalizeToken(args.owner || '', 120);
  const profiles = loadProfiles(p);
  return {
    ok: true,
    type: 'observational_compression_status',
    backend: 'rust_core_v6',
    latest: readJson(p.paths.latest_path, null),
    owner_profile: owner ? (profiles.owners[owner] || null) : null
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 120) || 'status';
  if (cmd === '--help' || cmd === 'help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  const p = policy();
  if (!p.enabled) emit({ ok: false, error: 'observational_compression_disabled' }, 1);
  if (cmd === 'configure') emit(configure(args, p), 0);
  if (cmd === 'execute') emit(execute(args, p), 0);
  if (cmd === 'status') emit(status(args, p), 0);
  emit({ ok: false, error: 'unsupported_command', cmd }, 1);
}

main();
