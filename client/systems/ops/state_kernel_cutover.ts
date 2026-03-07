#!/usr/bin/env node
'use strict';
export {};

/**
 * state_kernel_cutover.js
 *
 * V3-SK-007 phased cutover controller:
 * dual_write -> read_cutover -> legacy_retired
 */

const fs = require('fs');
const path = require('path');

const stateKernel = require('./state_kernel');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.STATE_KERNEL_CUTOVER_POLICY_PATH
  ? path.resolve(process.env.STATE_KERNEL_CUTOVER_POLICY_PATH)
  : path.join(ROOT, 'config', 'state_kernel_cutover_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 80) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok).slice(2)] = true;
    else out[String(tok).slice(2, idx)] = String(tok).slice(idx + 1);
  }
  return out;
}

function boolFlag(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw || '', 500);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function parseIsoMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: true,
    phases: ['dual_write', 'read_cutover', 'legacy_retired'],
    default_mode: 'dual_write',
    shadow_validation_days: 7,
    require_parity_ok: true,
    state_path: 'state/ops/state_kernel_cutover/state.json',
    history_path: 'state/ops/state_kernel_cutover/history.jsonl',
    latest_path: 'state/ops/state_kernel_cutover/latest.json'
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    strict_default: boolFlag(raw.strict_default, base.strict_default),
    phases: Array.isArray(raw.phases) && raw.phases.length
      ? raw.phases.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean)
      : base.phases.slice(0),
    default_mode: normalizeToken(raw.default_mode || base.default_mode, 80) || base.default_mode,
    shadow_validation_days: clampInt(raw.shadow_validation_days, 1, 365, base.shadow_validation_days),
    require_parity_ok: boolFlag(raw.require_parity_ok, base.require_parity_ok),
    state_path: resolvePath(raw.state_path, base.state_path),
    history_path: resolvePath(raw.history_path, base.history_path),
    latest_path: resolvePath(raw.latest_path, base.latest_path),
    policy_path: path.resolve(policyPath)
  };
}

function defaultState(policy: AnyObj) {
  return {
    schema_id: 'state_kernel_cutover_state',
    schema_version: '1.0',
    mode: policy.default_mode,
    entered_at: nowIso(),
    first_read_cutover_at: null,
    legacy_retired_at: null,
    validation: {
      parity_ok: null,
      last_parity_ts: null,
      replay_deterministic: null,
      last_replay_ts: null
    }
  };
}

function loadState(policy: AnyObj) {
  const src = readJson(policy.state_path, null);
  if (!src || typeof src !== 'object') return defaultState(policy);
  const mode = normalizeToken(src.mode || policy.default_mode, 80) || policy.default_mode;
  return {
    schema_id: 'state_kernel_cutover_state',
    schema_version: '1.0',
    mode,
    entered_at: cleanText(src.entered_at || nowIso(), 60),
    first_read_cutover_at: src.first_read_cutover_at ? cleanText(src.first_read_cutover_at, 60) : null,
    legacy_retired_at: src.legacy_retired_at ? cleanText(src.legacy_retired_at, 60) : null,
    validation: src.validation && typeof src.validation === 'object'
      ? {
        parity_ok: src.validation.parity_ok === null ? null : src.validation.parity_ok === true,
        last_parity_ts: src.validation.last_parity_ts ? cleanText(src.validation.last_parity_ts, 60) : null,
        replay_deterministic: src.validation.replay_deterministic === null ? null : src.validation.replay_deterministic === true,
        last_replay_ts: src.validation.last_replay_ts ? cleanText(src.validation.last_replay_ts, 60) : null
      }
      : defaultState(policy).validation
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.state_path, state);
}

function cutoverAgeDays(state: AnyObj) {
  const ts = parseIsoMs(state && state.first_read_cutover_at);
  if (ts == null) return 0;
  return Math.max(0, (Date.now() - ts) / (1000 * 60 * 60 * 24));
}

function evaluateReadiness(policy: AnyObj, state: AnyObj) {
  const kernelPolicy = stateKernel.loadPolicy(stateKernel.DEFAULT_POLICY_PATH);
  const parity = stateKernel.verifyParity(kernelPolicy);
  const replay = stateKernel.replayVerify(kernelPolicy, { profiles: 'phone,desktop,cluster' });

  const validation = {
    parity_ok: parity && parity.parity ? parity.parity.ok === true : null,
    last_parity_ts: parity && parity.parity ? parity.parity.ts : nowIso(),
    replay_deterministic: replay && replay.deterministic === true,
    last_replay_ts: replay && replay.ts ? replay.ts : nowIso()
  };

  const days = cutoverAgeDays(state);
  const windowMet = days >= Number(policy.shadow_validation_days || 7);
  const parityGate = policy.require_parity_ok !== true || validation.parity_ok === true;
  const replayGate = validation.replay_deterministic === true;
  const canRetire = parityGate && replayGate && windowMet;

  return {
    validation,
    can_retire: canRetire,
    checks: {
      parity_gate: parityGate,
      replay_gate: replayGate,
      shadow_window_met: windowMet
    },
    shadow_days_elapsed: Number(days.toFixed(3)),
    shadow_days_required: Number(policy.shadow_validation_days || 7)
  };
}

function record(policy: AnyObj, row: AnyObj) {
  appendJsonl(policy.history_path, row);
  writeJsonAtomic(policy.latest_path, row);
}

function cmdSetMode(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) throw new Error('cutover_policy_disabled');
  const requested = normalizeToken(args.mode || '', 80);
  if (!requested || !policy.phases.includes(requested)) {
    throw new Error(`invalid_mode:${requested || 'missing'}`);
  }

  const state = loadState(policy);
  const prev = String(state.mode || policy.default_mode);
  const now = nowIso();
  state.mode = requested;
  state.entered_at = now;
  if (requested === 'read_cutover' && !state.first_read_cutover_at) state.first_read_cutover_at = now;
  if (requested === 'legacy_retired') state.legacy_retired_at = now;
  saveState(policy, state);

  const out = {
    ok: true,
    type: 'state_kernel_cutover_set_mode',
    ts: now,
    previous_mode: prev,
    mode: requested,
    policy_path: rel(policy.policy_path),
    state_path: rel(policy.state_path)
  };
  record(policy, out);
  return out;
}

function cmdTick(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const evalOut = evaluateReadiness(policy, state);
  state.validation = evalOut.validation;

  const applyRetire = boolFlag(args['apply-retire'] || args.apply_retire, false);
  if (applyRetire && evalOut.can_retire === true && String(state.mode) === 'read_cutover') {
    state.mode = 'legacy_retired';
    state.legacy_retired_at = nowIso();
    state.entered_at = state.legacy_retired_at;
  }
  saveState(policy, state);

  const out = {
    ok: true,
    type: 'state_kernel_cutover_tick',
    ts: nowIso(),
    mode: state.mode,
    evaluation: evalOut,
    state_path: rel(policy.state_path)
  };
  record(policy, out);
  return out;
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const evalOut = evaluateReadiness(policy, state);
  const out = {
    ok: true,
    type: 'state_kernel_cutover_status',
    ts: nowIso(),
    policy: {
      path: rel(policy.policy_path),
      version: policy.version,
      phases: policy.phases,
      shadow_validation_days: policy.shadow_validation_days
    },
    state,
    evaluation: evalOut,
    paths: {
      state_path: rel(policy.state_path),
      history_path: rel(policy.history_path),
      latest_path: rel(policy.latest_path)
    }
  };
  record(policy, out);
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/state_kernel_cutover.js status [--policy=path]');
  console.log('  node systems/ops/state_kernel_cutover.js set-mode --mode=dual_write|read_cutover|legacy_retired [--policy=path]');
  console.log('  node systems/ops/state_kernel_cutover.js tick [--apply-retire=1|0] [--policy=path]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }

  let out: AnyObj;
  try {
    if (cmd === 'set-mode') out = cmdSetMode(args);
    else if (cmd === 'tick') out = cmdTick(args);
    else if (cmd === 'status') out = cmdStatus(args);
    else out = { ok: false, type: 'state_kernel_cutover', error: `unknown_command:${cmd}` };
  } catch (err) {
    out = {
      ok: false,
      type: 'state_kernel_cutover',
      error: cleanText(err && (err as AnyObj).message ? (err as AnyObj).message : err || 'state_kernel_cutover_failed', 260)
    };
  }

  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  loadState,
  evaluateReadiness,
  cmdSetMode,
  cmdTick,
  cmdStatus
};
