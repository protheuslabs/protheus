#!/usr/bin/env node
// @ts-nocheck
'use strict';

/**
 * Generic actuation executor with pluggable adapters.
 * This is action-layer infrastructure, not sensory.
 *
 * Usage:
 *   node systems/actuation/actuation_executor.js list
 *   node systems/actuation/actuation_executor.js run --kind=<adapter_id> [--params=<json>] [--dry-run]
 *   node systems/actuation/actuation_executor.js --help
 */

const fs = require('fs');
const path = require('path');
const { writeContractReceipt } = require('../../lib/action_receipts');
const { isEmergencyStopEngaged } = require('../../lib/emergency_stop.js');

const ROOT = path.resolve(__dirname, '..', '..');
const RECEIPTS_DIR = process.env.ACTUATION_RECEIPTS_DIR
  ? path.resolve(process.env.ACTUATION_RECEIPTS_DIR)
  : path.join(ROOT, 'state', 'actuation', 'receipts');
const ADAPTERS_CONFIG = process.env.ACTUATION_ADAPTERS_CONFIG
  ? path.resolve(process.env.ACTUATION_ADAPTERS_CONFIG)
  : path.join(ROOT, 'config', 'actuation_adapters.json');

function nowIso() { return new Date().toISOString(); }
function dayStr() { return nowIso().slice(0, 10); }

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const i = a.indexOf('=');
    if (i === -1) out[a.slice(2)] = true;
    else out[a.slice(2, i)] = a.slice(i + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/actuation/actuation_executor.js list');
  console.log('  node systems/actuation/actuation_executor.js run --kind=<adapter_id> [--params=<json>] [--dry-run]');
  console.log('  node systems/actuation/actuation_executor.js --help');
}

function parseParams(raw) {
  if (!raw) return {};
  try { return JSON.parse(String(raw)); } catch { return null; }
}

function receiptPath() {
  fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
  return path.join(RECEIPTS_DIR, `${dayStr()}.jsonl`);
}

function loadAdapterConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(ADAPTERS_CONFIG, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.adapters || typeof raw.adapters !== 'object') {
      return {};
    }
    return raw.adapters;
  } catch {
    return {};
  }
}

function resolveAdapter(kind) {
  const adapters = loadAdapterConfig();
  const ent = adapters[kind];
  if (!ent || typeof ent !== 'object') return null;
  const moduleRel = String(ent.module || '').trim();
  if (!moduleRel) return null;
  const moduleAbs = path.resolve(ROOT, moduleRel);
  // Keep adapter loading workspace-local/deterministic.
  if (!moduleAbs.startsWith(ROOT + path.sep) && moduleAbs !== ROOT) return null;
  if (!fs.existsSync(moduleAbs)) return null;
  try {
    const mod = require(moduleAbs);
    if (!mod || typeof mod.execute !== 'function') return null;
    return { id: kind, description: String(ent.description || mod.description || ''), execute: mod.execute };
  } catch {
    return null;
  }
}

function cmdList() {
  const cfg = loadAdapterConfig();
  const adapters = Object.keys(cfg).sort().map((id) => {
    const a = resolveAdapter(id);
    return { id, description: a ? (a.description || '') : String((cfg[id] && cfg[id].description) || '') };
  });
  process.stdout.write(JSON.stringify({ ok: true, adapters }) + '\n');
}

async function cmdRun(args) {
  const emergency = isEmergencyStopEngaged('actuation');
  if (emergency.engaged) {
    const summary = {
      decision: 'ACTUATE',
      gate_decision: 'DENY',
      executable: false,
      adapter: null,
      verified: false,
      reason: 'emergency_stop_engaged',
      emergency_stop: emergency.state || null
    };
    const record = {
      ts: nowIso(),
      type: 'actuation_execution',
      adapter: null,
      dry_run: args['dry-run'] === true,
      params_hash: null,
      ok: false,
      code: 3,
      duration_ms: 0,
      summary,
      error: 'emergency_stop_engaged'
    };
    writeContractReceipt(receiptPath(), record, { attempted: false, verified: false });
    process.stdout.write(JSON.stringify({ ok: false, error: 'emergency_stop_engaged', summary, code: 3 }) + '\n');
    process.exit(3);
  }

  const kind = String(args.kind || '').trim();
  if (!kind) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing --kind' }) + '\n');
    process.exit(2);
  }
  const adapter = resolveAdapter(kind);
  if (!adapter) {
    process.stdout.write(JSON.stringify({ ok: false, error: `unknown kind: ${kind}` }) + '\n');
    process.exit(2);
  }

  const params = parseParams(args.params);
  if (params == null) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'invalid --params JSON' }) + '\n');
    process.exit(2);
  }
  const dryRun = args['dry-run'] === true;

  const started = Date.now();
  let res;
  let err = null;
  try {
    res = await adapter.execute({ params, dryRun });
  } catch (e) {
    err = e;
  }
  const durationMs = Date.now() - started;

  const ok = !err && res && res.ok === true;
  const summary = ok ? (res.summary || {}) : {
    decision: 'ACTUATE',
    gate_decision: 'DENY',
    executable: false,
    adapter: kind,
    verified: false
  };
  summary.dry_run = dryRun;
  const record = {
    ts: nowIso(),
    type: 'actuation_execution',
    adapter: kind,
    dry_run: dryRun,
    params_hash: require('crypto').createHash('sha256').update(JSON.stringify(params || {})).digest('hex').slice(0, 16),
    ok,
    code: ok ? Number(res.code || 0) : 1,
    duration_ms: durationMs,
    summary,
    error: err ? String(err && err.message ? err.message : err).slice(0, 240) : null
  };
  writeContractReceipt(receiptPath(), record, {
    attempted: dryRun ? false : true,
    verified: dryRun ? false : (summary.verified === true)
  });

  if (!ok) {
    process.stdout.write(JSON.stringify({ ok: false, error: record.error || 'adapter_failed', summary, code: record.code }) + '\n');
    process.exit(record.code || 1);
  }
  process.stdout.write(JSON.stringify({ ok: true, summary, code: record.code, duration_ms: durationMs, details: res.details || null }) + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || '';
  if (!cmd || cmd === 'help' || cmd === '--help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'list') return cmdList();
  if (cmd === 'run') return cmdRun(args);
  usage();
  process.exit(2);
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }) + '\n');
  process.exit(1);
});
