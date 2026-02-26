#!/usr/bin/env node
'use strict';

/**
 * Generic actuation executor with pluggable adapters.
 * This is action-layer infrastructure, not sensory.
 *
 * Usage:
 *   node systems/actuation/actuation_executor.js list
 *   node systems/actuation/actuation_executor.js run --kind=<adapter_id> [--params=<json>] [--context=<json>] [--dry-run]
 *   node systems/actuation/actuation_executor.js --help
 */

const fs = require('fs');
const path = require('path');
const { writeContractReceipt } = require('../../lib/action_receipts');
const { isEmergencyStopEngaged } = require('../../lib/emergency_stop');
const { evaluateClawDecision } = require('./claw_registry');

const ROOT = path.resolve(__dirname, '..', '..');
const RECEIPTS_DIR = process.env.ACTUATION_RECEIPTS_DIR
  ? path.resolve(process.env.ACTUATION_RECEIPTS_DIR)
  : path.join(ROOT, 'state', 'actuation', 'receipts');
const ADAPTERS_CONFIG = process.env.ACTUATION_ADAPTERS_CONFIG
  ? path.resolve(process.env.ACTUATION_ADAPTERS_CONFIG)
  : path.join(ROOT, 'config', 'actuation_adapters.json');
const ACTUATION_MUTATION_EXECUTION_GUARD_ENABLED = String(process.env.ACTUATION_MUTATION_EXECUTION_GUARD_ENABLED || '1') !== '0';
const ADAPTIVE_MUTATION_TYPE_RE = /\b(adaptive|mutation|topology|genome|fractal|morph|self[_-]?(?:improv|mutation|modify)|branch[_-]?(?:spawn|rewire|prune)|spawn[_-]?(?:broker|agent|cell)|organism)\b/i;
const ADAPTIVE_MUTATION_SIGNAL_RE = /\b(topology|genome|fractal|mutation|morph|rewire|prune|spawn|self[_-]?improv)\b/i;

function nowIso() { return new Date().toISOString(); }
function dayStr() { return nowIso().slice(0, 10); }

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
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
  console.log('  node systems/actuation/actuation_executor.js run --kind=<adapter_id> [--params=<json>] [--context=<json>] [--dry-run]');
  console.log('  node systems/actuation/actuation_executor.js --help');
}

function parseParams(raw) {
  if (!raw) return {};
  try { return JSON.parse(String(raw)); } catch { return null; }
}

function adaptiveMutationExecutionGate(kind, params, context) {
  if (!ACTUATION_MUTATION_EXECUTION_GUARD_ENABLED) {
    return { enabled: false, applies: false, pass: true, reason: null, reasons: [] };
  }
  const ctx = context && typeof context === 'object' ? context : {};
  const mutationGuard = ctx.mutation_guard && typeof ctx.mutation_guard === 'object' ? ctx.mutation_guard : {};
  const blob = [
    String(kind || ''),
    params && typeof params === 'object' ? JSON.stringify(params) : '',
    ctx && typeof ctx === 'object' ? JSON.stringify(ctx) : ''
  ].join(' ');
  const applies = mutationGuard.applies === true
    || ADAPTIVE_MUTATION_TYPE_RE.test(blob)
    || ADAPTIVE_MUTATION_SIGNAL_RE.test(blob);
  if (!applies) {
    return { enabled: true, applies: false, pass: true, reason: null, reasons: [] };
  }
  const reasons = [];
  if (mutationGuard.applies !== true) reasons.push('adaptive_mutation_guard_metadata_missing');
  if (mutationGuard.pass === false) reasons.push(String(mutationGuard.reason || 'adaptive_mutation_guard_failed').trim() || 'adaptive_mutation_guard_failed');
  const controls = mutationGuard.controls && typeof mutationGuard.controls === 'object' ? mutationGuard.controls : {};
  const safetyAttestation = String(
    controls.safety_attestation
    || ctx.safety_attestation_id
    || ctx.safety_attestation
    || ''
  ).trim();
  const rollbackReceipt = String(
    controls.rollback_receipt
    || ctx.rollback_receipt_id
    || ctx.rollback_receipt
    || ''
  ).trim();
  const guardReceipt = String(
    controls.guard_receipt_id
    || ctx.adaptive_mutation_guard_receipt_id
    || ctx.mutation_guard_receipt_id
    || ''
  ).trim();
  if (!safetyAttestation) reasons.push('adaptive_mutation_missing_safety_attestation');
  if (!rollbackReceipt) reasons.push('adaptive_mutation_missing_rollback_receipt');
  if (!guardReceipt) reasons.push('adaptive_mutation_missing_execution_guard_receipt');
  if (controls.mutation_kernel_applies === true && controls.mutation_kernel_pass === false) {
    reasons.push('adaptive_mutation_kernel_failed');
  }
  const uniqReasons = Array.from(new Set(reasons.filter(Boolean)));
  return {
    enabled: true,
    applies: true,
    pass: uniqReasons.length === 0,
    reason: uniqReasons[0] || null,
    reasons: uniqReasons,
    controls: {
      safety_attestation: safetyAttestation || null,
      rollback_receipt: rollbackReceipt || null,
      guard_receipt_id: guardReceipt || null
    }
  };
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
  const context = parseParams(args.context);
  if (context == null) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'invalid --context JSON' }) + '\n');
    process.exit(2);
  }
  const dryRun = args['dry-run'] === true;
  const clawDecision = evaluateClawDecision({
    kind,
    dry_run: dryRun,
    context
  });
  if (!clawDecision || clawDecision.allowed !== true) {
    const summary = {
      decision: 'ACTUATE',
      gate_decision: 'DENY',
      executable: false,
      adapter: kind,
      verified: false,
      reason: clawDecision && clawDecision.reason
        ? String(clawDecision.reason)
        : 'claw_registry_denied',
      claw_decision: clawDecision || null
    };
    const record = {
      ts: nowIso(),
      type: 'actuation_execution',
      adapter: kind,
      dry_run: dryRun,
      params_hash: require('crypto').createHash('sha256').update(JSON.stringify(params || {})).digest('hex').slice(0, 16),
      ok: false,
      code: 5,
      duration_ms: 0,
      summary,
      error: summary.reason
    };
    writeContractReceipt(receiptPath(), record, { attempted: false, verified: false });
    process.stdout.write(JSON.stringify({ ok: false, error: record.error, summary, code: 5 }) + '\n');
    process.exit(5);
  }
  const mutationGate = adaptiveMutationExecutionGate(kind, params, context);
  if (mutationGate.applies && !mutationGate.pass) {
    const summary = {
      decision: 'ACTUATE',
      gate_decision: 'DENY',
      executable: false,
      adapter: kind,
      verified: false,
      reason: mutationGate.reason || 'adaptive_mutation_execution_guard_blocked',
      mutation_guard: mutationGate
    };
    const record = {
      ts: nowIso(),
      type: 'actuation_execution',
      adapter: kind,
      dry_run: dryRun,
      params_hash: require('crypto').createHash('sha256').update(JSON.stringify(params || {})).digest('hex').slice(0, 16),
      ok: false,
      code: 4,
      duration_ms: 0,
      summary,
      error: mutationGate.reason || 'adaptive_mutation_execution_guard_blocked'
    };
    writeContractReceipt(receiptPath(), record, { attempted: false, verified: false });
    process.stdout.write(JSON.stringify({ ok: false, error: record.error, summary, code: 4 }) + '\n');
    process.exit(4);
  }

  const started = Date.now();
  let res;
  let err = null;
  try {
    res = await adapter.execute({ params, context, dryRun, kind });
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
  summary.claw_decision = clawDecision || null;
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
export {};
