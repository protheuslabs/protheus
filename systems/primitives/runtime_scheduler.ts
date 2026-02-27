#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { appendCanonicalEvent } = require('./canonical_event_log.js');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.RUNTIME_SCHEDULER_POLICY_PATH
  ? path.resolve(process.env.RUNTIME_SCHEDULER_POLICY_PATH)
  : path.join(ROOT, 'config', 'runtime_scheduler_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
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
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[token.slice(2)] = true;
    else out[token.slice(2, idx)] = token.slice(idx + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/primitives/runtime_scheduler.js status');
  console.log('  node systems/primitives/runtime_scheduler.js switch --mode=<operational|dream|inversion> [--reason=<text>] [--apply=1|0]');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function defaultPolicy() {
  return {
    schema_id: 'runtime_scheduler_policy',
    schema_version: '1.0',
    enabled: true,
    default_mode: 'operational',
    modes: ['operational', 'dream', 'inversion'],
    allowed_transitions: {
      operational: ['operational', 'dream', 'inversion'],
      dream: ['dream', 'operational'],
      inversion: ['inversion', 'operational']
    },
    state_path: 'state/runtime/scheduler_mode/latest.json',
    receipts_path: 'state/runtime/scheduler_mode/receipts.jsonl'
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  const modes = Array.isArray(src.modes) ? src.modes : base.modes;
  const normalizedModes = Array.from(new Set(modes.map((row: unknown) => normalizeToken(row, 40)).filter(Boolean)));
  const allowedRaw = src.allowed_transitions && typeof src.allowed_transitions === 'object'
    ? src.allowed_transitions
    : base.allowed_transitions;
  const allowedTransitions: Record<string, string[]> = {};
  for (const mode of normalizedModes) {
    const list = Array.isArray((allowedRaw as AnyObj)[mode])
      ? (allowedRaw as AnyObj)[mode]
      : Array.isArray((base.allowed_transitions as AnyObj)[mode])
        ? (base.allowed_transitions as AnyObj)[mode]
        : [mode];
    const normalized = Array.from(new Set(list.map((row: unknown) => normalizeToken(row, 40)).filter(Boolean)));
    allowedTransitions[mode] = normalized.length ? normalized : [mode];
  }
  const defaultMode = normalizeToken(src.default_mode || base.default_mode, 40) || 'operational';
  return {
    schema_id: 'runtime_scheduler_policy',
    schema_version: cleanText(src.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: src.enabled !== false,
    default_mode: normalizedModes.includes(defaultMode) ? defaultMode : normalizedModes[0] || 'operational',
    modes: normalizedModes.length ? normalizedModes : base.modes.slice(0),
    allowed_transitions: allowedTransitions,
    state_path: path.resolve(ROOT, cleanText(src.state_path || base.state_path, 320)),
    receipts_path: path.resolve(ROOT, cleanText(src.receipts_path || base.receipts_path, 320))
  };
}

function loadState(policy: AnyObj) {
  const src = readJson(policy.state_path, {});
  const mode = normalizeToken(src.mode || policy.default_mode, 40) || policy.default_mode;
  return {
    schema_id: 'runtime_scheduler_state',
    schema_version: '1.0',
    mode: policy.modes.includes(mode) ? mode : policy.default_mode,
    updated_at: cleanText(src.updated_at || nowIso(), 40) || nowIso(),
    reason: cleanText(src.reason || 'default', 240) || 'default'
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.state_path, {
    schema_id: 'runtime_scheduler_state',
    schema_version: '1.0',
    mode: normalizeToken(state.mode || policy.default_mode, 40) || policy.default_mode,
    updated_at: nowIso(),
    reason: cleanText(state.reason || 'unspecified', 240) || 'unspecified'
  });
}

function emitReceipt(policy: AnyObj, row: AnyObj) {
  appendJsonl(policy.receipts_path, {
    ts: nowIso(),
    ...row
  });
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState(policy);
  const allowedNext = policy.allowed_transitions[state.mode] || [];
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'runtime_scheduler_status',
    mode: state.mode,
    reason: state.reason,
    updated_at: state.updated_at,
    allowed_next_modes: allowedNext,
    policy_version: policy.schema_version
  })}\n`);
}

function cmdSwitch(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (!policy.enabled) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'runtime_scheduler_switch', error: 'policy_disabled' })}\n`);
    process.exit(1);
  }
  const targetMode = normalizeToken(args.mode || '', 40);
  if (!targetMode || !policy.modes.includes(targetMode)) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'runtime_scheduler_switch',
      error: 'mode_not_allowed',
      mode: targetMode || null,
      allowed_modes: policy.modes
    })}\n`);
    process.exit(1);
  }
  const apply = toBool(args.apply, true);
  const reason = cleanText(args.reason || 'manual_switch', 240) || 'manual_switch';
  const state = loadState(policy);
  const currentMode = normalizeToken(state.mode || policy.default_mode, 40) || policy.default_mode;
  const allowedNext = policy.allowed_transitions[currentMode] || [currentMode];
  if (!allowedNext.includes(targetMode)) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'runtime_scheduler_switch',
      error: 'transition_not_allowed',
      from_mode: currentMode,
      to_mode: targetMode,
      allowed_next_modes: allowedNext
    })}\n`);
    process.exit(1);
  }

  const preview = {
    ok: true,
    type: 'runtime_scheduler_switch',
    apply,
    from_mode: currentMode,
    to_mode: targetMode,
    reason
  };
  if (apply) {
    saveState(policy, {
      mode: targetMode,
      reason
    });
    emitReceipt(policy, {
      type: 'runtime_scheduler_mode_switch',
      apply: true,
      from_mode: currentMode,
      to_mode: targetMode,
      reason
    });
  } else {
    emitReceipt(policy, {
      type: 'runtime_scheduler_mode_switch_preview',
      apply: false,
      from_mode: currentMode,
      to_mode: targetMode,
      reason
    });
  }
  appendCanonicalEvent({
    type: 'runtime_scheduler_mode_switch',
    phase: 'switch',
    opcode: 'FLOW_GATE',
    effect: 'governance',
    ok: true,
    payload: {
      apply,
      from_mode: currentMode,
      to_mode: targetMode,
      reason
    }
  });
  process.stdout.write(`${JSON.stringify(preview)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'status') return cmdStatus(args);
  if (cmd === 'switch') return cmdSwitch(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
