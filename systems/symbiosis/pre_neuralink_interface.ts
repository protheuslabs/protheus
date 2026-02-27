#!/usr/bin/env node
'use strict';
export {};

/**
 * pre_neuralink_interface.js
 *
 * V3-028:
 * Non-invasive "just think" layer using voice/attention/haptic signals.
 * - local-first by default
 * - explicit consent states
 * - policy-gated routing through Eye kernel
 * - handoff contract artifact for future neural interfaces
 *
 * Commands:
 *   node systems/symbiosis/pre_neuralink_interface.js ingest --channel=voice|attention|haptic --signal="..." [--confidence=0.0..1.0] [--consent-state=granted|paused|revoked]
 *   node systems/symbiosis/pre_neuralink_interface.js route [--signal-id=<id>] [--apply=1|0] [--objective-id=<id>] [--risk=low|medium|high|critical]
 *   node systems/symbiosis/pre_neuralink_interface.js handoff-contract [--write=1|0]
 *   node systems/symbiosis/pre_neuralink_interface.js status
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.PRE_NEURALINK_POLICY_PATH
  ? path.resolve(String(process.env.PRE_NEURALINK_POLICY_PATH))
  : path.join(ROOT, 'config', 'pre_neuralink_interface_policy.json');
const EYE_KERNEL_SCRIPT = path.join(ROOT, 'systems', 'eye', 'eye_kernel.js');

function nowIso() {
  return new Date().toISOString();
}

function clean(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return clean(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(absPath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(absPath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(absPath: string, payload: AnyObj) {
  ensureDir(path.dirname(absPath));
  const tmp = `${absPath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, absPath);
}

function appendJsonl(absPath: string, row: AnyObj) {
  ensureDir(path.dirname(absPath));
  fs.appendFileSync(absPath, `${JSON.stringify(row)}\n`, 'utf8');
}

function readJsonl(absPath: string) {
  try {
    if (!fs.existsSync(absPath)) return [];
    return fs.readFileSync(absPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((row) => row && typeof row === 'object');
  } catch {
    return [];
  }
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function resolvePath(v: unknown, fallbackRel: string) {
  const text = clean(v || fallbackRel, 360);
  return path.isAbsolute(text) ? path.resolve(text) : path.join(ROOT, text);
}

function stableId(prefix: string, seed: string) {
  const h = crypto.createHash('sha256').update(String(seed || ''), 'utf8').digest('hex').slice(0, 12);
  return `${prefix}_${h}`;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    local_first: true,
    require_explicit_consent: true,
    channels: ['voice', 'attention', 'haptic'],
    consent: {
      default_state: 'paused',
      allowed_states: ['granted', 'paused', 'revoked'],
      route_allowed_states: ['granted'],
      min_signal_confidence: 0.45
    },
    routing: {
      lane: 'organ',
      target: 'symbiosis',
      action_by_intent: {
        execute: 'execute',
        plan: 'plan',
        reflect: 'observe',
        support: 'observe'
      },
      risk_by_intent: {
        execute: 'medium',
        plan: 'low',
        reflect: 'low',
        support: 'low'
      },
      default_estimated_tokens: 220
    },
    handoff_contract: {
      version: '1.0',
      modality_family: 'non_invasive',
      compatible_future_interfaces: ['bci', 'neural_link'],
      path: 'state/symbiosis/pre_neuralink_interface/handoff_contract.json'
    },
    paths: {
      state: 'state/symbiosis/pre_neuralink_interface/state.json',
      latest: 'state/symbiosis/pre_neuralink_interface/latest.json',
      signals: 'state/symbiosis/pre_neuralink_interface/signals.jsonl',
      routes: 'state/symbiosis/pre_neuralink_interface/routes.jsonl',
      receipts: 'state/symbiosis/pre_neuralink_interface/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const consent = raw.consent && typeof raw.consent === 'object' ? raw.consent : {};
  const routing = raw.routing && typeof raw.routing === 'object' ? raw.routing : {};
  const handoff = raw.handoff_contract && typeof raw.handoff_contract === 'object' ? raw.handoff_contract : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: clean(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    local_first: raw.local_first !== false,
    require_explicit_consent: raw.require_explicit_consent !== false,
    channels: Array.from(new Set(
      (Array.isArray(raw.channels) ? raw.channels : base.channels)
        .map((row: unknown) => normalizeToken(row, 40))
        .filter(Boolean)
    )),
    consent: {
      default_state: normalizeToken(consent.default_state || base.consent.default_state, 40) || base.consent.default_state,
      allowed_states: Array.from(new Set(
        (Array.isArray(consent.allowed_states) ? consent.allowed_states : base.consent.allowed_states)
          .map((row: unknown) => normalizeToken(row, 40))
          .filter(Boolean)
      )),
      route_allowed_states: Array.from(new Set(
        (Array.isArray(consent.route_allowed_states) ? consent.route_allowed_states : base.consent.route_allowed_states)
          .map((row: unknown) => normalizeToken(row, 40))
          .filter(Boolean)
      )),
      min_signal_confidence: clampNumber(
        consent.min_signal_confidence,
        0,
        1,
        base.consent.min_signal_confidence
      )
    },
    routing: {
      lane: normalizeToken(routing.lane || base.routing.lane, 40) || base.routing.lane,
      target: normalizeToken(routing.target || base.routing.target, 80) || base.routing.target,
      action_by_intent: routing.action_by_intent && typeof routing.action_by_intent === 'object'
        ? routing.action_by_intent
        : base.routing.action_by_intent,
      risk_by_intent: routing.risk_by_intent && typeof routing.risk_by_intent === 'object'
        ? routing.risk_by_intent
        : base.routing.risk_by_intent,
      default_estimated_tokens: Math.max(0, Number(routing.default_estimated_tokens || base.routing.default_estimated_tokens) || base.routing.default_estimated_tokens)
    },
    handoff_contract: {
      version: clean(handoff.version || base.handoff_contract.version, 24) || base.handoff_contract.version,
      modality_family: normalizeToken(handoff.modality_family || base.handoff_contract.modality_family, 80) || base.handoff_contract.modality_family,
      compatible_future_interfaces: Array.from(new Set(
        (Array.isArray(handoff.compatible_future_interfaces) ? handoff.compatible_future_interfaces : base.handoff_contract.compatible_future_interfaces)
          .map((row: unknown) => normalizeToken(row, 80))
          .filter(Boolean)
      )),
      path: resolvePath(handoff.path || base.handoff_contract.path, base.handoff_contract.path)
    },
    paths: {
      state: resolvePath(paths.state || base.paths.state, base.paths.state),
      latest: resolvePath(paths.latest || base.paths.latest, base.paths.latest),
      signals: resolvePath(paths.signals || base.paths.signals, base.paths.signals),
      routes: resolvePath(paths.routes || base.paths.routes, base.paths.routes),
      receipts: resolvePath(paths.receipts || base.paths.receipts, base.paths.receipts)
    },
    policy_path: path.resolve(policyPath)
  };
}

function defaultState(policy: AnyObj) {
  const defaultConsent = policy.consent.allowed_states.includes(policy.consent.default_state)
    ? policy.consent.default_state
    : policy.consent.allowed_states[0] || 'paused';
  return {
    schema_id: 'pre_neuralink_interface_state',
    schema_version: '1.0',
    updated_at: null,
    consent_state: defaultConsent,
    signals_total: 0,
    routed_total: 0,
    blocked_total: 0,
    last_signal_id: null,
    last_route_id: null
  };
}

function loadState(policy: AnyObj) {
  const src = readJson(policy.paths.state, null);
  if (!src || typeof src !== 'object') return defaultState(policy);
  const base = defaultState(policy);
  const consent = normalizeToken(src.consent_state || base.consent_state, 40) || base.consent_state;
  return {
    ...base,
    ...src,
    consent_state: policy.consent.allowed_states.includes(consent) ? consent : base.consent_state,
    signals_total: Math.max(0, Number(src.signals_total || 0) || 0),
    routed_total: Math.max(0, Number(src.routed_total || 0) || 0),
    blocked_total: Math.max(0, Number(src.blocked_total || 0) || 0)
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  state.updated_at = nowIso();
  writeJsonAtomic(policy.paths.state, state);
}

function parseJsonOutput(raw: unknown) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        return JSON.parse(lines[i]);
      } catch {}
    }
  }
  return null;
}

function runNodeJson(scriptPath: string, args: string[]) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const payload = parseJsonOutput(r.stdout);
  return {
    ok: r.status === 0,
    code: Number(r.status || 0),
    payload,
    stdout: String(r.stdout || '').trim(),
    stderr: String(r.stderr || '').trim()
  };
}

function classifySignal(signalText: string, channel: string) {
  const text = clean(signalText, 1200).toLowerCase();
  const loweredChannel = normalizeToken(channel, 40);
  let intent = 'reflect';
  if (/\b(do|run|execute|ship|send|deploy)\b/.test(text)) intent = 'execute';
  else if (/\b(plan|outline|roadmap|next|decide)\b/.test(text)) intent = 'plan';
  else if (/\bhelp|stuck|blocked|support\b/.test(text)) intent = 'support';
  const confidenceBase = intent === 'execute' ? 0.7 : intent === 'plan' ? 0.66 : 0.62;
  const channelBoost = loweredChannel === 'voice' ? 0.06 : loweredChannel === 'attention' ? 0.03 : 0.02;
  const confidence = clampNumber(confidenceBase + channelBoost, 0, 1, 0.6);
  return { intent, confidence };
}

function writeLatest(policy: AnyObj, payload: AnyObj) {
  writeJsonAtomic(policy.paths.latest, payload);
}

function buildReceipt(policy: AnyObj, type: string, body: AnyObj) {
  const row = {
    ts: nowIso(),
    type: normalizeToken(type, 80),
    body
  };
  appendJsonl(policy.paths.receipts, row);
}

function cmdIngest(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const channel = normalizeToken(args.channel || '', 40);
  const signal = clean(args.signal || '', 1000);
  const consentArg = normalizeToken(args['consent-state'] || args.consent_state || '', 40);
  if (!channel || !policy.channels.includes(channel)) {
    const payload = { ok: false, type: 'pre_neuralink_ingest', error: 'invalid_channel', allowed_channels: policy.channels };
    writeLatest(policy, payload);
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(2);
  }
  if (!signal) {
    const payload = { ok: false, type: 'pre_neuralink_ingest', error: 'missing_signal' };
    writeLatest(policy, payload);
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(2);
  }

  if (consentArg) {
    if (!policy.consent.allowed_states.includes(consentArg)) {
      const payload = {
        ok: false,
        type: 'pre_neuralink_ingest',
        error: 'invalid_consent_state',
        allowed_states: policy.consent.allowed_states
      };
      writeLatest(policy, payload);
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      process.exit(2);
    }
    state.consent_state = consentArg;
  }

  const parsed = classifySignal(signal, channel);
  const signalConfidence = clampNumber(args.confidence, 0, 1, parsed.confidence);
  const signalId = stableId('jtk', `${nowIso()}|${channel}|${signal}|${signalConfidence}`);
  const row = {
    ts: nowIso(),
    signal_id: signalId,
    channel,
    signal,
    intent: parsed.intent,
    confidence: signalConfidence,
    consent_state: state.consent_state
  };
  appendJsonl(policy.paths.signals, row);
  state.signals_total += 1;
  state.last_signal_id = signalId;
  saveState(policy, state);

  const payload = {
    ok: true,
    type: 'pre_neuralink_ingest',
    signal_id: signalId,
    channel,
    intent: parsed.intent,
    confidence: signalConfidence,
    consent_state: state.consent_state,
    local_first: policy.local_first === true,
    shadow_only: policy.shadow_only === true
  };
  writeLatest(policy, payload);
  buildReceipt(policy, 'pre_neuralink_ingest', payload);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function resolveSignal(policy: AnyObj, signalIdRaw: unknown) {
  const signalId = normalizeToken(signalIdRaw || '', 80);
  const rows = readJsonl(policy.paths.signals);
  if (!rows.length) return null;
  if (!signalId) return rows[rows.length - 1];
  return rows.find((row: AnyObj) => normalizeToken(row && row.signal_id || '', 80) === signalId) || null;
}

function routeThroughEye(policy: AnyObj, request: AnyObj, apply: boolean) {
  const mock = normalizeToken(process.env.PRE_NEURALINK_MOCK_EYE_DECISION || '', 40);
  if (mock) {
    const decision = ['allow', 'deny', 'escalate'].includes(mock) ? mock : 'deny';
    return {
      ok: decision !== 'deny',
      code: decision === 'deny' ? 1 : 0,
      payload: {
        ok: decision !== 'deny',
        type: 'eye_kernel_route',
        decision,
        reasons: decision === 'allow' ? [] : ['mock_eye_decision'],
        lane: request.lane,
        target: request.target,
        action: request.action
      },
      stdout: '',
      stderr: ''
    };
  }
  const args = [
    'route',
    `--lane=${request.lane}`,
    `--target=${request.target}`,
    `--action=${request.action}`,
    `--risk=${request.risk}`,
    `--clearance=${request.clearance}`,
    `--estimated-tokens=${request.estimated_tokens}`,
    `--apply=${apply ? 1 : 0}`,
    `--reason=pre_neuralink_interface`,
    `--request-id=${request.request_id}`
  ];
  return runNodeJson(EYE_KERNEL_SCRIPT, args);
}

function cmdRoute(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  if (policy.enabled !== true) {
    const payload = { ok: false, type: 'pre_neuralink_route', error: 'interface_disabled' };
    writeLatest(policy, payload);
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(1);
  }
  const signal = resolveSignal(policy, args['signal-id'] || args.signal_id);
  if (!signal) {
    const payload = { ok: false, type: 'pre_neuralink_route', error: 'signal_not_found' };
    writeLatest(policy, payload);
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(1);
  }

  const routeId = stableId('nif', `${signal.signal_id}|${nowIso()}`);
  const routeAllowedByConsent = !policy.require_explicit_consent
    || policy.consent.route_allowed_states.includes(normalizeToken(state.consent_state, 40));
  const confidenceOk = Number(signal.confidence || 0) >= Number(policy.consent.min_signal_confidence || 0);

  const intent = normalizeToken(signal.intent || 'reflect', 40) || 'reflect';
  const action = normalizeToken(policy.routing.action_by_intent[intent] || 'observe', 40) || 'observe';
  const risk = normalizeToken(args.risk || policy.routing.risk_by_intent[intent] || 'low', 20) || 'low';
  const request = {
    lane: policy.routing.lane,
    target: policy.routing.target,
    action,
    risk,
    clearance: 'L2',
    estimated_tokens: Math.max(0, Number(policy.routing.default_estimated_tokens || 220) || 220),
    request_id: routeId
  };

  const apply = toBool(args.apply, false);
  const blockedReasons: string[] = [];
  if (!routeAllowedByConsent) blockedReasons.push('consent_not_granted');
  if (!confidenceOk) blockedReasons.push('signal_confidence_below_threshold');
  if (policy.local_first === true && request.lane !== 'organ') blockedReasons.push('local_first_lane_violation');

  let eyeResult: AnyObj = null;
  let decision = 'deny';
  if (blockedReasons.length === 0) {
    eyeResult = routeThroughEye(policy, request, apply && policy.shadow_only !== true);
    decision = normalizeToken(eyeResult && eyeResult.payload && eyeResult.payload.decision || '', 20) || (eyeResult.ok ? 'allow' : 'deny');
  }

  if (blockedReasons.length > 0 || decision === 'deny') state.blocked_total += 1;
  if (decision === 'allow') state.routed_total += 1;
  state.last_route_id = routeId;
  saveState(policy, state);

  const payload = {
    ok: blockedReasons.length === 0 && decision !== 'deny',
    type: 'pre_neuralink_route',
    route_id: routeId,
    signal_id: signal.signal_id,
    consent_state: state.consent_state,
    route_allowed_by_consent: routeAllowedByConsent,
    confidence_ok: confidenceOk,
    shadow_only: policy.shadow_only === true,
    local_first: policy.local_first === true,
    decision,
    blocked_reasons: blockedReasons,
    eye_result: eyeResult && eyeResult.payload ? eyeResult.payload : null,
    request
  };
  appendJsonl(policy.paths.routes, payload);
  writeLatest(policy, payload);
  buildReceipt(policy, 'pre_neuralink_route', payload);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (!payload.ok) process.exit(1);
}

function buildHandoffContract(policy: AnyObj) {
  return {
    schema_id: 'pre_neuralink_handoff_contract',
    schema_version: '1.0',
    ts: nowIso(),
    interface_version: policy.handoff_contract.version,
    modality_family: policy.handoff_contract.modality_family,
    compatible_future_interfaces: policy.handoff_contract.compatible_future_interfaces,
    input_channels: policy.channels,
    consent_states: policy.consent.allowed_states,
    route_allowed_states: policy.consent.route_allowed_states,
    envelope: {
      local_first: policy.local_first === true,
      require_explicit_consent: policy.require_explicit_consent === true,
      shadow_only: policy.shadow_only === true
    },
    routing_contract: {
      lane: policy.routing.lane,
      target: policy.routing.target,
      action_by_intent: policy.routing.action_by_intent,
      risk_by_intent: policy.routing.risk_by_intent
    }
  };
}

function cmdHandoffContract(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const payload = buildHandoffContract(policy);
  if (toBool(args.write, true)) {
    writeJsonAtomic(policy.handoff_contract.path, payload);
  }
  writeLatest(policy, {
    ok: true,
    type: 'pre_neuralink_handoff_contract',
    path: rel(policy.handoff_contract.path),
    schema_id: payload.schema_id
  });
  buildReceipt(policy, 'pre_neuralink_handoff_contract', payload);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'pre_neuralink_handoff_contract',
    path: rel(policy.handoff_contract.path),
    contract: payload
  }, null, 2)}\n`);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const payload = {
    ok: true,
    type: 'pre_neuralink_interface_status',
    ts: nowIso(),
    enabled: policy.enabled === true,
    local_first: policy.local_first === true,
    shadow_only: policy.shadow_only === true,
    require_explicit_consent: policy.require_explicit_consent === true,
    channels: policy.channels,
    consent_state: state.consent_state,
    route_allowed_states: policy.consent.route_allowed_states,
    counts: {
      signals_total: state.signals_total,
      routed_total: state.routed_total,
      blocked_total: state.blocked_total
    },
    handoff_contract_path: rel(policy.handoff_contract.path),
    paths: {
      policy_path: rel(policy.policy_path),
      state_path: rel(policy.paths.state),
      latest_path: rel(policy.paths.latest),
      signals_path: rel(policy.paths.signals),
      routes_path: rel(policy.paths.routes),
      receipts_path: rel(policy.paths.receipts)
    }
  };
  writeLatest(policy, payload);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/symbiosis/pre_neuralink_interface.js ingest --channel=voice|attention|haptic --signal="..." [--confidence=0.0..1.0] [--consent-state=granted|paused|revoked]');
  console.log('  node systems/symbiosis/pre_neuralink_interface.js route [--signal-id=<id>] [--apply=1|0] [--objective-id=<id>] [--risk=low|medium|high|critical]');
  console.log('  node systems/symbiosis/pre_neuralink_interface.js handoff-contract [--write=1|0]');
  console.log('  node systems/symbiosis/pre_neuralink_interface.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'ingest') return cmdIngest(args);
  if (cmd === 'route') return cmdRoute(args);
  if (cmd === 'handoff-contract' || cmd === 'handoff_contract') return cmdHandoffContract(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  loadState,
  buildHandoffContract,
  classifySignal
};
