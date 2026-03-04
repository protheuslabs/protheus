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
const PERSONAS_DIR = process.env.PROTHEUS_PERSONA_DIR
  ? path.resolve(process.env.PROTHEUS_PERSONA_DIR)
  : path.join(ROOT, 'personas');
const STATE_PATH = process.env.PROTHEUS_SHADOW_STATE_PATH
  ? path.resolve(process.env.PROTHEUS_SHADOW_STATE_PATH)
  : path.join(ROOT, 'state', 'personas', 'shadow_cli', 'state.json');
const TELEMETRY_PATH = process.env.PROTHEUS_PERSONA_TELEMETRY_PATH
  ? path.resolve(process.env.PROTHEUS_PERSONA_TELEMETRY_PATH)
  : path.join(ROOT, 'personas', 'organization', 'telemetry.jsonl');
const ORCHESTRATION_SCRIPT = path.join(ROOT, 'systems', 'personas', 'orchestration.js');

function nowIso() {
  return new Date().toISOString();
}

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
    const token = String(argv[i] || '');
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx >= 0) {
      out[token.slice(2, idx)] = token.slice(idx + 1);
      continue;
    }
    const key = token.slice(2);
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

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(String(fs.readFileSync(filePath, 'utf8') || ''));
  } catch {
    return fallback;
  }
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
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

function defaultState() {
  return {
    schema_id: 'protheus_shadow_cli_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    active: {},
    paused: {},
    review_queue: []
  };
}

function loadState() {
  const src = readJson(STATE_PATH, defaultState()) || defaultState();
  return {
    schema_id: 'protheus_shadow_cli_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 60) || nowIso(),
    active: src.active && typeof src.active === 'object' ? src.active : {},
    paused: src.paused && typeof src.paused === 'object' ? src.paused : {},
    review_queue: Array.isArray(src.review_queue) ? src.review_queue.slice(-200) : []
  };
}

function saveState(state: AnyObj) {
  const next = {
    ...state,
    updated_at: nowIso()
  };
  writeJsonAtomic(STATE_PATH, next);
  return next;
}

function listAvailablePersonas() {
  try {
    return fs.readdirSync(PERSONAS_DIR, { withFileTypes: true })
      .filter((entry: any) => entry && entry.isDirectory && entry.isDirectory())
      .map((entry: any) => String(entry.name || ''))
      .filter((name: string) => fs.existsSync(path.join(PERSONAS_DIR, name, 'profile.md')))
      .sort((a: string, b: string) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function personaExists(persona: string) {
  const token = cleanText(persona, 120);
  if (!token) return false;
  return fs.existsSync(path.join(PERSONAS_DIR, token, 'profile.md'));
}

function activeAndPaused(state: AnyObj) {
  const activeMap = state.active && typeof state.active === 'object' ? state.active : {};
  const pausedMap = state.paused && typeof state.paused === 'object' ? state.paused : {};
  const activeIds = Object.keys(activeMap)
    .filter((id) => activeMap[id] === true && pausedMap[id] !== true)
    .sort((a, b) => a.localeCompare(b));
  const pausedIds = Object.keys(pausedMap)
    .filter((id) => pausedMap[id] === true)
    .sort((a, b) => a.localeCompare(b));
  return { activeIds, pausedIds };
}

function recordTelemetry(kind: string, payload: AnyObj = {}) {
  appendJsonl(TELEMETRY_PATH, {
    ts: nowIso(),
    kind: cleanText(kind, 80),
    source: 'shadow_cli',
    ...payload
  });
}

function enforceMutatingGate(action: string, persona: string | null) {
  if (toBool(process.env.PROTHEUS_SHADOW_SKIP_SECURITY_GATE, false) || toBool(process.env.PROTHEUS_SECURITY_GATE_BYPASS, false)) {
    return {
      ok: true,
      bypassed: true
    };
  }
  const request = {
    operation_id: `shadow_${normalizeToken(action, 40)}_${Date.now()}`,
    subsystem: 'personas',
    action: cleanText(action, 80),
    actor: 'systems/personas/shadow_cli',
    risk_class: 'normal',
    payload_digest: `sha256:${normalizeToken(persona || 'none', 80) || 'none'}`,
    tags: ['shadow', 'operator_cli', cleanText(action, 40)],
    covenant_violation: false,
    tamper_signal: false,
    key_age_hours: 1,
    operator_quorum: 2,
    audit_receipt_nonce: `shadow-${Date.now()}`,
    zk_proof: 'zk-shadow-operator',
    ciphertext_digest: `sha256:${normalizeToken(persona || 'none', 80) || 'none'}`
  };
  const verdict = evaluateSecurityGate(request, { enforce: false });
  if (!verdict || verdict.ok !== true) {
    throw new Error(`security_gate_execution_failed:${cleanText(verdict && verdict.error || 'unknown', 220)}`);
  }
  const payload = verdict.payload && typeof verdict.payload === 'object' ? verdict.payload : {};
  const decision = payload.decision && typeof payload.decision === 'object' ? payload.decision : {};
  if (decision.ok !== true || decision.fail_closed === true) {
    const reason = Array.isArray(decision.reasons) && decision.reasons.length
      ? cleanText(decision.reasons[0], 220)
      : 'fail_closed';
    throw new Error(`security_gate_blocked:${reason}`);
  }
  return {
    ok: true,
    bypassed: false
  };
}

function orchestrationStatus() {
  if (!fs.existsSync(ORCHESTRATION_SCRIPT)) return null;
  const out = spawnSync(process.execPath, [ORCHESTRATION_SCRIPT, 'status'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const payload = parseJsonText(out.stdout) || parseJsonText(out.stderr);
  return {
    ok: Number(out.status) === 0,
    payload
  };
}

function statusPayload(state: AnyObj) {
  const lanes = activeAndPaused(state);
  const governance = orchestrationStatus();
  return {
    ok: true,
    type: 'shadow_cli_status',
    ts: nowIso(),
    state_path: path.relative(ROOT, STATE_PATH).replace(/\\/g, '/'),
    telemetry_path: path.relative(ROOT, TELEMETRY_PATH).replace(/\\/g, '/'),
    active_shadows: lanes.activeIds.length,
    paused_shadows: lanes.pausedIds.length,
    active_ids: lanes.activeIds,
    paused_ids: lanes.pausedIds,
    reviews_pending: Array.isArray(state.review_queue) ? state.review_queue.length : 0,
    governance: governance && governance.payload ? {
      ok: governance.ok === true,
      orchestration_ok: governance.payload.ok === true,
      shadow_mode_active: governance.payload.shadow_mode && governance.payload.shadow_mode.meeting
        ? governance.payload.shadow_mode.meeting.shadow_active === true
        : null
    } : null
  };
}

function usage() {
  console.log('Usage:');
  console.log('  protheus shadow status');
  console.log('  protheus shadow list');
  console.log('  protheus shadow arise <persona> [--reason="..."]');
  console.log('  protheus shadow pause <persona> [--reason="..."]');
  console.log('  protheus shadow review [persona] [--note="..."]');
}

function output(payload: AnyObj, asJson: boolean) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (payload.type === 'shadow_cli_status' || payload.type === 'shadow_cli_list') {
    process.stdout.write('Shadow Operator Status\n\n');
    process.stdout.write(`Active: ${payload.active_shadows}\n`);
    process.stdout.write(`Paused: ${payload.paused_shadows}\n`);
    process.stdout.write(`Reviews pending: ${payload.reviews_pending}\n`);
    if (Array.isArray(payload.active_ids) && payload.active_ids.length) {
      process.stdout.write(`Active IDs: ${payload.active_ids.join(', ')}\n`);
    }
    if (Array.isArray(payload.paused_ids) && payload.paused_ids.length) {
      process.stdout.write(`Paused IDs: ${payload.paused_ids.join(', ')}\n`);
    }
    if (Array.isArray(payload.available_personas)) {
      process.stdout.write(`Available personas: ${payload.available_personas.length}\n`);
    }
    return;
  }
  process.stdout.write(`${cleanText(payload.message || 'ok', 400)}\n`);
}

function cmdList(args: AnyObj) {
  const state = loadState();
  const base = statusPayload(state);
  return {
    ...base,
    type: 'shadow_cli_list',
    available_personas: listAvailablePersonas()
  };
}

function cmdArise(args: AnyObj) {
  const persona = cleanText(args._[1] || args.persona || '', 120);
  if (!persona) {
    throw new Error('persona_required');
  }
  if (!personaExists(persona)) {
    throw new Error(`persona_not_found:${persona}`);
  }
  enforceMutatingGate('shadow_arise', persona);
  const state = loadState();
  state.active[persona] = true;
  delete state.paused[persona];
  const next = saveState(state);
  const reason = cleanText(args.reason || '', 240) || null;
  recordTelemetry('shadow_arise', { persona, reason });
  return {
    ok: true,
    type: 'shadow_cli_arise',
    ts: nowIso(),
    persona,
    reason,
    ...statusPayload(next),
    message: `Shadow arose for ${persona}`
  };
}

function cmdPause(args: AnyObj) {
  const persona = cleanText(args._[1] || args.persona || '', 120);
  if (!persona) {
    throw new Error('persona_required');
  }
  if (!personaExists(persona)) {
    throw new Error(`persona_not_found:${persona}`);
  }
  enforceMutatingGate('shadow_pause', persona);
  const state = loadState();
  state.active[persona] = false;
  state.paused[persona] = true;
  const next = saveState(state);
  const reason = cleanText(args.reason || '', 240) || null;
  recordTelemetry('shadow_pause', { persona, reason });
  return {
    ok: true,
    type: 'shadow_cli_pause',
    ts: nowIso(),
    persona,
    reason,
    ...statusPayload(next),
    message: `Shadow paused for ${persona}`
  };
}

function cmdReview(args: AnyObj) {
  const persona = cleanText(args._[1] || args.persona || '', 120);
  if (persona && !personaExists(persona)) {
    throw new Error(`persona_not_found:${persona}`);
  }
  enforceMutatingGate('shadow_review', persona || null);
  const state = loadState();
  const note = cleanText(args.note || '', 500) || null;
  const target = persona || null;
  const entry = {
    ts: nowIso(),
    persona: target,
    note,
    reviewer: 'operator',
    state_snapshot: activeAndPaused(state)
  };
  state.review_queue = Array.isArray(state.review_queue) ? state.review_queue : [];
  state.review_queue.push(entry);
  state.review_queue = state.review_queue.slice(-200);
  const next = saveState(state);
  recordTelemetry('shadow_review', { persona: target, note });
  return {
    ok: true,
    type: 'shadow_cli_review',
    ts: nowIso(),
    review: entry,
    ...statusPayload(next),
    message: target
      ? `Review queued for ${target}`
      : 'Review queued for active shadows'
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 40) || 'status';
  if (args.help || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  const asJson = toBool(args.json ?? process.env.PROTHEUS_GLOBAL_JSON, false);
  try {
    let payload: AnyObj;
    if (cmd === 'status') {
      payload = statusPayload(loadState());
      output(payload, asJson);
      process.exit(0);
    }
    if (cmd === 'list') {
      payload = cmdList(args);
      output(payload, asJson);
      process.exit(0);
    }
    if (cmd === 'arise') {
      payload = cmdArise(args);
      output(payload, asJson);
      process.exit(0);
    }
    if (cmd === 'pause') {
      payload = cmdPause(args);
      output(payload, asJson);
      process.exit(0);
    }
    if (cmd === 'review') {
      payload = cmdReview(args);
      output(payload, asJson);
      process.exit(0);
    }
    usage();
    process.exit(2);
  } catch (err: any) {
    process.stderr.write(`${cleanText(err && err.message || 'shadow_cli_failed', 500)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadState,
  saveState,
  listAvailablePersonas,
  statusPayload,
  cmdList,
  cmdArise,
  cmdPause,
  cmdReview
};
