#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { evaluateSecurityGate } = require('../security/rust_security_gate.js');

type AnyObj = Record<string, any>;

const ROOT = process.env.OPENCLAW_WORKSPACE
  ? path.resolve(process.env.OPENCLAW_WORKSPACE)
  : path.resolve(__dirname, '..', '..');

const STATUS_SCRIPT = path.join(ROOT, 'systems', 'ops', 'protheus_status_dashboard.js');
const PARITY_CONTINUOUS_SCRIPT = path.join(ROOT, 'systems', 'ops', 'continuous_parity_maintainer.js');
const PARITY_NARROW_SCRIPT = path.join(ROOT, 'systems', 'ops', 'narrow_agent_parity_harness.js');
const FORMAL_SCRIPT = path.join(ROOT, 'systems', 'security', 'formal_mind_sovereignty_verification.js');
const COVENANT_SCRIPT = path.join(ROOT, 'systems', 'security', 'irrevocable_geas_covenant.js');
const RESEAL_SCRIPT = path.join(ROOT, 'systems', 'security', 'integrity_reseal_assistant.js');

const PERSONA_TELEMETRY_PATH = path.join(ROOT, 'personas', 'organization', 'telemetry.jsonl');
const CONTROL_PLANE_RECEIPTS_PATH = path.join(ROOT, 'state', 'ops', 'protheus_control_plane', 'receipts.jsonl');
const SECURITY_LEDGER_PATH = path.join(ROOT, 'state', 'security', 'black_box_ledger.jsonl');

function cleanText(v: unknown, maxLen = 400) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  const raw = cleanText(v, 20).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function parseJsonText(raw: string) {
  const txt = String(raw || '').trim();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {}
  const lines = txt.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

function runScriptJson(scriptPath: string, args: string[] = []) {
  if (!fs.existsSync(scriptPath)) {
    return {
      ok: false,
      status: 1,
      error: `script_missing:${path.relative(ROOT, scriptPath).replace(/\\/g, '/')}`
    };
  }
  const out = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const payload = parseJsonText(out.stdout) || parseJsonText(out.stderr);
  return {
    ok: Number(out.status) === 0,
    status: Number.isFinite(out.status) ? Number(out.status) : 1,
    payload,
    stderr: cleanText(out.stderr, 500),
    stdout: cleanText(out.stdout, 500),
    script: path.relative(ROOT, scriptPath).replace(/\\/g, '/')
  };
}

function readJsonlTail(filePath: string, limit = 20) {
  try {
    if (!fs.existsSync(filePath)) {
      return {
        rows: [],
        count: 0,
        path: path.relative(ROOT, filePath).replace(/\\/g, '/')
      };
    }
    const rows = String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: cleanText(line, 500) };
        }
      });
    return {
      rows,
      count: rows.length,
      path: path.relative(ROOT, filePath).replace(/\\/g, '/')
    };
  } catch (err: any) {
    return {
      rows: [],
      count: 0,
      path: path.relative(ROOT, filePath).replace(/\\/g, '/'),
      error: cleanText(err && err.message || 'read_failed', 240)
    };
  }
}

function summarizeTail(tail: AnyObj) {
  const rows = Array.isArray(tail.rows) ? tail.rows : [];
  const last = rows.length ? rows[rows.length - 1] : null;
  const lastTs = last ? cleanText(last.ts || last.timestamp || '', 60) : '';
  return {
    path: tail.path,
    rows: Number(tail.count || 0),
    last_ts: lastTs || null
  };
}

function runDispatchProbe() {
  const request = {
    operation_id: `debug_probe_${Date.now()}`,
    subsystem: 'ops',
    action: 'debug_diagnostics_probe',
    actor: 'systems/ops/protheus_debug_diagnostics',
    risk_class: 'normal',
    payload_digest: 'sha256:debug',
    tags: ['debug', 'diagnostics', 'probe'],
    covenant_violation: false,
    tamper_signal: false,
    key_age_hours: 1,
    operator_quorum: 2,
    audit_receipt_nonce: `diag-${Date.now()}`,
    zk_proof: 'zk-debug-probe',
    ciphertext_digest: 'sha256:debug-probe'
  };

  const verdict = evaluateSecurityGate(request, { enforce: false });
  const payload = verdict && verdict.payload && typeof verdict.payload === 'object'
    ? verdict.payload
    : {};
  const decision = payload && payload.decision && typeof payload.decision === 'object'
    ? payload.decision
    : {};

  return {
    ok: verdict && verdict.ok === true,
    engine: cleanText(verdict && verdict.engine || '', 80) || null,
    decision_ok: decision.ok === true && decision.fail_closed !== true,
    fail_closed: decision.fail_closed === true,
    reason: Array.isArray(decision.reasons) && decision.reasons.length
      ? cleanText(decision.reasons[0], 240)
      : null
  };
}

function usage() {
  console.log('Usage:');
  console.log('  protheus debug');
  console.log('  protheus debug --deep=1');
  console.log('  protheus debug --json=1');
}

function buildSummary(payload: AnyObj) {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const dispatchProbe = payload.security && payload.security.dispatch_probe
    ? payload.security.dispatch_probe
    : {};
  if (dispatchProbe.ok !== true || dispatchProbe.decision_ok !== true) {
    blockers.push('dispatch_security_probe_failed');
  }

  const parity = payload.parity || {};
  if (!(parity.continuous && parity.continuous.ok === true)) {
    warnings.push('continuous_parity_status_unavailable');
  }
  if (parity.narrow && parity.narrow.ok === true) {
    const pass = parity.narrow.parity_pass;
    if (pass === false) blockers.push('narrow_parity_failed');
  }

  const reseal = payload.security && payload.security.integrity_reseal
    ? payload.security.integrity_reseal
    : {};
  if (reseal.reseal_required === true) {
    warnings.push('integrity_reseal_required');
  }

  return {
    healthy: blockers.length === 0,
    blockers,
    warnings
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sub = normalizeToken(args._[0] || '', 40);
  if (args.help || sub === 'help' || sub === '--help' || sub === '-h') {
    usage();
    process.exit(0);
  }

  const deep = toBool(args.deep, false);
  const statusSnapshot = runScriptJson(STATUS_SCRIPT, ['--json=1']);

  const parityContinuous = runScriptJson(PARITY_CONTINUOUS_SCRIPT, ['status']);
  const parityNarrow = runScriptJson(PARITY_NARROW_SCRIPT, ['status', 'latest']);
  const dispatchProbe = runDispatchProbe();

  const formal = runScriptJson(FORMAL_SCRIPT, ['status']);
  const covenant = runScriptJson(COVENANT_SCRIPT, ['status']);
  const reseal = runScriptJson(RESEAL_SCRIPT, ['status']);

  const personaTelemetryTail = readJsonlTail(PERSONA_TELEMETRY_PATH, 12);
  const controlPlaneReceiptsTail = readJsonlTail(CONTROL_PLANE_RECEIPTS_PATH, 12);
  const securityLedgerTail = readJsonlTail(SECURITY_LEDGER_PATH, 12);

  const payload: AnyObj = {
    ok: true,
    type: 'protheus_debug_diagnostics',
    ts: nowIso(),
    deep,
    status_snapshot: {
      ok: statusSnapshot.ok === true,
      type: statusSnapshot.payload && statusSnapshot.payload.type
        ? cleanText(statusSnapshot.payload.type, 80)
        : null
    },
    parity: {
      continuous: {
        ok: parityContinuous.ok === true,
        shadow_only: parityContinuous.payload && parityContinuous.payload.shadow_only === true,
        latest_ok: parityContinuous.payload && parityContinuous.payload.latest
          ? parityContinuous.payload.latest.ok === true
          : null
      },
      narrow: {
        ok: parityNarrow.ok === true,
        parity_pass: parityNarrow.payload && parityNarrow.payload.payload
          ? parityNarrow.payload.payload.parity_pass === true
          : null
      }
    },
    security: {
      dispatch_probe: dispatchProbe,
      sovereignty_formal: {
        ok: formal.ok === true,
        lane_ok: formal.payload ? formal.payload.ok === true : null
      },
      covenant_lane: {
        ok: covenant.ok === true,
        lane_ok: covenant.payload ? covenant.payload.ok === true : null
      },
      integrity_reseal: {
        ok: reseal.ok === true,
        reseal_required: reseal.payload ? reseal.payload.reseal_required === true : null
      }
    },
    logs: {
      persona_telemetry: summarizeTail(personaTelemetryTail),
      control_plane_receipts: summarizeTail(controlPlaneReceiptsTail),
      security_ledger: summarizeTail(securityLedgerTail)
    },
    checks: {
      status_script: statusSnapshot,
      parity_continuous_script: parityContinuous,
      parity_narrow_script: parityNarrow,
      sovereignty_formal_script: formal,
      covenant_script: covenant,
      integrity_reseal_script: reseal
    }
  };

  if (deep) {
    payload.deep_checks = {
      orchestration_status: runScriptJson(path.join(ROOT, 'systems', 'personas', 'orchestration.js'), ['status'])
    };
  }

  payload.summary = buildSummary(payload);
  payload.ok = payload.summary.healthy === true;

  const asJson = toBool(args.json ?? process.env.PROTHEUS_GLOBAL_JSON, false);
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(payload.ok ? 0 : 1);
  }

  process.stdout.write('Protheus Debug\n\n');
  process.stdout.write(`Status snapshot: ${payload.status_snapshot.ok ? 'ok' : 'degraded'}\n`);
  process.stdout.write(`Parity: continuous=${payload.parity.continuous.ok ? 'ok' : 'fail'} narrow=${payload.parity.narrow.parity_pass === true ? 'pass' : 'unknown'}\n`);
  process.stdout.write(`Security: dispatch=${payload.security.dispatch_probe.decision_ok ? 'ok' : 'blocked'} formal=${payload.security.sovereignty_formal.ok ? 'ok' : 'fail'} covenant=${payload.security.covenant_lane.ok ? 'ok' : 'fail'}\n`);
  process.stdout.write(`Integrity reseal required: ${payload.security.integrity_reseal.reseal_required === true ? 'yes' : 'no'}\n`);
  process.stdout.write(`Logs: personas=${payload.logs.persona_telemetry.rows} control_plane=${payload.logs.control_plane_receipts.rows} security=${payload.logs.security_ledger.rows}\n`);
  if (payload.summary.blockers.length) {
    process.stdout.write(`Blockers: ${payload.summary.blockers.join(', ')}\n`);
  }
  if (payload.summary.warnings.length) {
    process.stdout.write(`Warnings: ${payload.summary.warnings.join(', ')}\n`);
  }
  process.exit(payload.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  runScriptJson,
  runDispatchProbe,
  buildSummary
};
