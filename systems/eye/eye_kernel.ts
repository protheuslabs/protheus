#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(REPO_ROOT, 'config', 'eye_kernel_policy.json');
const DEFAULT_STATE_PATH = path.join(REPO_ROOT, 'state', 'eye', 'control_plane_state.json');
const DEFAULT_AUDIT_PATH = path.join(REPO_ROOT, 'state', 'eye', 'audit', 'command_bus.jsonl');
const DEFAULT_LATEST_PATH = path.join(REPO_ROOT, 'state', 'eye', 'latest.json');
let capabilityEnvelopeMod: AnyObj = null;
try {
  capabilityEnvelopeMod = require('../security/capability_envelope_guard.js');
} catch {
  capabilityEnvelopeMod = null;
}
let stateKernelDualWriteMod: AnyObj = null;
try {
  stateKernelDualWriteMod = require('../ops/state_kernel_dual_write.js');
} catch {
  stateKernelDualWriteMod = null;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/eye/eye_kernel.js route --lane=<organ|vassal|external> --target=<id> --action=<name> [--risk=<low|medium|high|critical>] [--clearance=<L0|L1|L2|L3>] [--estimated-tokens=N] [--apply=1|0] [--reason=...] [--request-id=<id>] [--policy=/abs/path.json] [--state=/abs/path.json] [--audit=/abs/path.jsonl] [--latest=/abs/path.json]');
  console.log('  node systems/eye/eye_kernel.js status [--policy=/abs/path.json] [--state=/abs/path.json]');
  console.log('  node systems/eye/eye_kernel.js --help');
}

function nowIso() {
  return new Date().toISOString();
}

function dateStr(v: unknown) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const arg of argv) {
    if (!String(arg || '').startsWith('--')) {
      out._.push(String(arg || ''));
      continue;
    }
    const idx = arg.indexOf('=');
    if (idx === -1) out[String(arg || '').slice(2)] = true;
    else out[String(arg || '').slice(2, idx)] = String(arg || '').slice(idx + 1);
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

function cleanText(v: unknown, maxLen = 200) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toList(v: unknown) {
  return Array.isArray(v)
    ? v.map((row) => String(row == null ? '' : row).trim().toLowerCase()).filter(Boolean)
    : [];
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function defaultPolicy() {
  return {
    version: '1.0',
    default_decision: 'deny',
    clearance_levels: ['L0', 'L1', 'L2', 'L3'],
    risk: {
      escalate: ['medium'],
      deny: ['high', 'critical']
    },
    budgets: {
      global_daily_tokens: 25000
    },
    lanes: {
      organ: {
        enabled: true,
        min_clearance: 'L1',
        daily_tokens: 12000,
        actions: ['observe', 'plan', 'route', 'execute'],
        targets: ['spine', 'workflow', 'autonomy', 'memory', 'sensory', 'actuation']
      },
      vassal: {
        enabled: true,
        min_clearance: 'L2',
        daily_tokens: 9000,
        actions: ['route', 'execute'],
        targets: ['openai', 'anthropic', 'google', 'ollama', 'local']
      },
      external: {
        enabled: false,
        min_clearance: 'L3',
        daily_tokens: 4000,
        actions: ['execute'],
        targets: ['web', 'browser', 'payment', 'email']
      }
    },
    helix_attestation: {
      enabled: false,
      mode: 'shadow_advisory',
      latest_path: 'state/helix/latest.json',
      max_staleness_sec: 600
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const clearanceLevels = Array.isArray(raw.clearance_levels) && raw.clearance_levels.length
    ? raw.clearance_levels.map((row) => String(row || '').trim().toUpperCase()).filter(Boolean)
    : base.clearance_levels.slice(0);
  const laneNames = Array.from(new Set([
    ...Object.keys(base.lanes || {}),
    ...Object.keys(raw.lanes && typeof raw.lanes === 'object' ? raw.lanes : {})
  ]));
  const helix = raw.helix_attestation && typeof raw.helix_attestation === 'object'
    ? raw.helix_attestation
    : {};
  const lanes: AnyObj = {};
  for (const name of laneNames) {
    const baseLane = base.lanes && base.lanes[name] ? base.lanes[name] : {};
    const srcLane = raw.lanes && raw.lanes[name] && typeof raw.lanes[name] === 'object'
      ? raw.lanes[name]
      : {};
    lanes[name] = {
      enabled: srcLane.enabled !== false,
      min_clearance: String(srcLane.min_clearance || baseLane.min_clearance || 'L0').trim().toUpperCase(),
      daily_tokens: clampInt(srcLane.daily_tokens, 0, 10_000_000, Number(baseLane.daily_tokens || 0)),
      actions: toList(Array.isArray(srcLane.actions) ? srcLane.actions : baseLane.actions),
      targets: toList(Array.isArray(srcLane.targets) ? srcLane.targets : baseLane.targets)
    };
  }
  return {
    version: cleanText(raw.version || base.version, 40) || '1.0',
    default_decision: String(raw.default_decision || base.default_decision).trim().toLowerCase() || 'deny',
    clearance_levels: clearanceLevels,
    risk: {
      escalate: toList(raw.risk && raw.risk.escalate ? raw.risk.escalate : base.risk.escalate),
      deny: toList(raw.risk && raw.risk.deny ? raw.risk.deny : base.risk.deny)
    },
    budgets: {
      global_daily_tokens: clampInt(
        raw.budgets && raw.budgets.global_daily_tokens,
        0,
        10_000_000,
        base.budgets.global_daily_tokens
      )
    },
    lanes,
    helix_attestation: {
      enabled: helix.enabled === true,
      mode: normalizeToken(helix.mode || base.helix_attestation.mode, 40) || base.helix_attestation.mode,
      latest_path: cleanText(helix.latest_path || base.helix_attestation.latest_path, 260)
        || base.helix_attestation.latest_path,
      max_staleness_sec: clampInt(
        helix.max_staleness_sec,
        1,
        24 * 60 * 60,
        base.helix_attestation.max_staleness_sec
      )
    }
  };
}

function evaluateHelixGate(policy: AnyObj) {
  const cfg = policy && policy.helix_attestation && typeof policy.helix_attestation === 'object'
    ? policy.helix_attestation
    : {};
  const enabled = cfg.enabled === true;
  const mode = String(cfg.mode || 'shadow_advisory').trim().toLowerCase();
  if (!enabled) {
    return {
      enabled: false,
      mode,
      enforced_block: false,
      decision: 'allow',
      reason_codes: []
    };
  }
  const latestPathRaw = cleanText(cfg.latest_path || 'state/helix/latest.json', 260) || 'state/helix/latest.json';
  const latestPath = path.isAbsolute(latestPathRaw)
    ? latestPathRaw
    : path.join(REPO_ROOT, latestPathRaw);
  const maxStalenessSec = clampInt(cfg.max_staleness_sec, 1, 24 * 60 * 60, 600);
  const snapshot = readJson(latestPath, null);
  if (!snapshot || typeof snapshot !== 'object') {
    const deny = mode === 'enforced';
    return {
      enabled: true,
      mode,
      enforced_block: deny,
      decision: deny ? 'deny' : 'allow',
      reason_codes: [deny ? 'helix_snapshot_missing_enforced' : 'helix_snapshot_missing_advisory'],
      latest_path: latestPath
    };
  }
  const tsMs = Date.parse(String(snapshot.ts || snapshot.updated_at || ''));
  const stale = Number.isFinite(tsMs)
    ? ((Date.now() - Number(tsMs)) / 1000) > maxStalenessSec
    : true;
  const tier = String(
    (snapshot.sentinel && snapshot.sentinel.tier)
    || snapshot.tier
    || 'unknown'
  ).trim().toLowerCase();
  const attestationDecision = String(snapshot.attestation_decision || 'unknown').trim().toLowerCase();
  const reasons: string[] = [];
  if (stale) reasons.push('helix_attestation_stale');
  if (tier && tier !== 'clear') reasons.push(`helix_tier_${tier}`);
  if (attestationDecision && attestationDecision !== 'allow') reasons.push(`helix_decision_${attestationDecision}`);
  const critical = reasons.length > 0;
  const deny = critical && mode === 'enforced';
  return {
    enabled: true,
    mode,
    enforced_block: deny,
    decision: deny ? 'deny' : 'allow',
    reason_codes: reasons,
    latest_path: latestPath,
    tier,
    attestation_decision: attestationDecision,
    stale
  };
}

function defaultState(policy: AnyObj) {
  const lanes = {};
  for (const lane of Object.keys(policy && policy.lanes ? policy.lanes : {})) {
    lanes[lane] = {
      requests: 0,
      allow: 0,
      deny: 0,
      escalate: 0,
      tokens_used: 0
    };
  }
  return {
    schema_id: 'eye_kernel_state',
    schema_version: '1.0',
    updated_at: null,
    days: {},
    _lane_template: lanes
  };
}

function loadState(statePath: string, policy: AnyObj) {
  const fallback = defaultState(policy);
  const raw = readJson(statePath, fallback);
  const out: AnyObj = {
    schema_id: 'eye_kernel_state',
    schema_version: '1.0',
    updated_at: String(raw.updated_at || '') || null,
    days: raw.days && typeof raw.days === 'object' ? raw.days : {}
  };
  return out;
}

function ensureDayState(state: AnyObj, policy: AnyObj, day: string) {
  if (!state.days || typeof state.days !== 'object') state.days = {};
  if (!state.days[day] || typeof state.days[day] !== 'object') {
    state.days[day] = {
      global_tokens_used: 0,
      lanes: {}
    };
  }
  if (!state.days[day].lanes || typeof state.days[day].lanes !== 'object') {
    state.days[day].lanes = {};
  }
  for (const lane of Object.keys(policy && policy.lanes ? policy.lanes : {})) {
    if (!state.days[day].lanes[lane] || typeof state.days[day].lanes[lane] !== 'object') {
      state.days[day].lanes[lane] = {
        requests: 0,
        allow: 0,
        deny: 0,
        escalate: 0,
        tokens_used: 0
      };
    }
  }
  return state.days[day];
}

function clearanceRank(level: string, policy: AnyObj) {
  const levels = Array.isArray(policy && policy.clearance_levels) ? policy.clearance_levels : [];
  const idx = levels.indexOf(String(level || '').trim().toUpperCase());
  return idx >= 0 ? idx : -1;
}

function evaluateRoute(request: AnyObj, policy: AnyObj, state: AnyObj, opts: AnyObj = {}) {
  const lane = String(request.lane || 'organ').trim().toLowerCase();
  const action = String(request.action || '').trim().toLowerCase();
  const target = String(request.target || '').trim().toLowerCase();
  const risk = String(request.risk || 'low').trim().toLowerCase();
  const clearance = String(request.clearance || 'L0').trim().toUpperCase();
  const estimatedTokens = clampInt(request.estimated_tokens, 0, 10_000_000, 0);
  const apply = opts.apply === true;
  const day = dateStr(opts.date || nowIso());
  const reasons: string[] = [];

  const lanePolicy = policy && policy.lanes && policy.lanes[lane] ? policy.lanes[lane] : null;
  if (!lanePolicy) reasons.push('lane_unknown');
  if (lanePolicy && lanePolicy.enabled !== true) reasons.push('lane_disabled');
  if (!action) reasons.push('action_required');
  if (!target) reasons.push('target_required');
  if (lanePolicy && Array.isArray(lanePolicy.actions) && lanePolicy.actions.length && !lanePolicy.actions.includes(action)) {
    reasons.push('action_not_allowlisted');
  }
  if (lanePolicy && Array.isArray(lanePolicy.targets) && lanePolicy.targets.length && !lanePolicy.targets.includes(target)) {
    reasons.push('target_not_allowlisted');
  }
  if (lanePolicy) {
    const minRank = clearanceRank(String(lanePolicy.min_clearance || 'L0'), policy);
    const currentRank = clearanceRank(clearance, policy);
    if (currentRank < minRank) reasons.push('clearance_below_minimum');
  }
  if (Array.isArray(policy && policy.risk && policy.risk.deny) && policy.risk.deny.includes(risk)) {
    reasons.push('risk_denied');
  }

  const dayState = ensureDayState(state, policy, day);
  const laneState = dayState.lanes && dayState.lanes[lane] ? dayState.lanes[lane] : {
    requests: 0, allow: 0, deny: 0, escalate: 0, tokens_used: 0
  };

  if (lanePolicy && lanePolicy.daily_tokens > 0 && (Number(laneState.tokens_used || 0) + estimatedTokens) > Number(lanePolicy.daily_tokens || 0)) {
    reasons.push('lane_daily_budget_exceeded');
  }
  if (policy && policy.budgets && Number(policy.budgets.global_daily_tokens || 0) > 0) {
    if ((Number(dayState.global_tokens_used || 0) + estimatedTokens) > Number(policy.budgets.global_daily_tokens || 0)) {
      reasons.push('global_daily_budget_exceeded');
    }
  }
  const envelopeDecision = opts && opts.envelope_decision && typeof opts.envelope_decision === 'object'
    ? opts.envelope_decision
    : null;
  if (envelopeDecision && envelopeDecision.allowed !== true) {
    const envelopeReasons = Array.isArray(envelopeDecision.reasons)
      ? envelopeDecision.reasons.map((row: unknown) => `capability_envelope_${String(row || '').toLowerCase()}`)
      : ['capability_envelope_blocked'];
    reasons.push(...envelopeReasons);
  }

  let decision = 'allow';
  if (reasons.length) decision = 'deny';
  else if (Array.isArray(policy && policy.risk && policy.risk.escalate) && policy.risk.escalate.includes(risk)) {
    decision = 'escalate';
    reasons.push('risk_requires_escalation');
  } else if (String(policy && policy.default_decision || 'deny').toLowerCase() === 'escalate') {
    decision = 'escalate';
    reasons.push('default_escalation_policy');
  }

  if (apply) {
    dayState.lanes[lane] = laneState;
    laneState.requests = Number(laneState.requests || 0) + 1;
    laneState[decision] = Number(laneState[decision] || 0) + 1;
    if (decision === 'allow') {
      laneState.tokens_used = Number(laneState.tokens_used || 0) + estimatedTokens;
      dayState.global_tokens_used = Number(dayState.global_tokens_used || 0) + estimatedTokens;
    }
    state.updated_at = nowIso();
  }

  return {
    decision,
    reasons: Array.from(new Set(reasons)),
    lane,
    action,
    target,
    risk,
    clearance,
    estimated_tokens: estimatedTokens,
    day,
    day_state: dayState,
    capability_envelope: envelopeDecision
  };
}

function cmdRoute(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  const statePath = path.resolve(String(args.state || DEFAULT_STATE_PATH));
  const auditPath = path.resolve(String(args.audit || DEFAULT_AUDIT_PATH));
  const latestPath = path.resolve(String(args.latest || DEFAULT_LATEST_PATH));
  const apply = boolFlag(args.apply, true);
  const policy = loadPolicy(policyPath);
  const state = loadState(statePath, policy);
  const helixGate = evaluateHelixGate(policy);
  let envelopeDecision: AnyObj = null;
  let envelopeState: AnyObj = null;
  if (capabilityEnvelopeMod && typeof capabilityEnvelopeMod.loadPolicy === 'function' && typeof capabilityEnvelopeMod.evaluateEnvelope === 'function') {
    try {
      const envelopePolicy = capabilityEnvelopeMod.loadPolicy();
      envelopeState = typeof capabilityEnvelopeMod.loadState === 'function'
        ? capabilityEnvelopeMod.loadState()
        : { by_day: {} };
      envelopeDecision = capabilityEnvelopeMod.evaluateEnvelope(envelopePolicy, envelopeState, {
        lane: args.lane || 'organ',
        action: args.action || '',
        risk: args.risk || 'low',
        estimated_tokens: args['estimated-tokens'] || args.estimated_tokens || 0,
        apply
      });
      if (apply && envelopeDecision && envelopeDecision.allowed === true && typeof capabilityEnvelopeMod.saveState === 'function') {
        capabilityEnvelopeMod.saveState(envelopeState);
      }
    } catch {
      envelopeDecision = {
        allowed: false,
        reasons: ['capability_envelope_runtime_error']
      };
    }
  }
  const request = {
    lane: args.lane || 'organ',
    target: args.target || '',
    action: args.action || '',
    risk: args.risk || 'low',
    clearance: args.clearance || 'L0',
    estimated_tokens: args['estimated-tokens'] || args.estimated_tokens || 0
  };
  if (helixGate.enforced_block === true) {
    request.risk = 'critical';
  }
  const evaluated = evaluateRoute(request, policy, state, {
    apply,
    date: args.date,
    envelope_decision: envelopeDecision
  });
  let decision = evaluated.decision;
  if (helixGate.enforced_block === true) {
    decision = 'deny';
  }
  const combinedReasons = Array.from(new Set([
    ...(Array.isArray(evaluated.reasons) ? evaluated.reasons : []),
    ...(Array.isArray(helixGate.reason_codes) ? helixGate.reason_codes : [])
  ]));
  const requestId = cleanText(args['request-id'] || args.request_id, 64)
    || `eye_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const row = {
    ts: nowIso(),
    type: 'eye_kernel_route',
    request_id: requestId,
    lane: evaluated.lane,
    target: evaluated.target,
    action: evaluated.action,
    risk: evaluated.risk,
    clearance: evaluated.clearance,
    estimated_tokens: evaluated.estimated_tokens,
    decision,
    reasons: combinedReasons,
    policy_version: policy.version,
    apply,
    reason_note: cleanText(args.reason || '', 220) || null,
    day: evaluated.day,
    helix_gate: helixGate,
    capability_envelope: envelopeDecision
  };
  if (apply) writeJsonAtomic(statePath, state);
  appendJsonl(auditPath, row);
  writeJsonAtomic(latestPath, row);
  if (stateKernelDualWriteMod && typeof stateKernelDualWriteMod.writeMirror === 'function') {
    try {
      stateKernelDualWriteMod.writeMirror({
        'organ-id': 'eye_kernel',
        'fs-path': statePath,
        'payload-json': JSON.stringify(state)
      });
    } catch {
      // state-kernel mirror must not block eye kernel routing
    }
  }
  if (stateKernelDualWriteMod && typeof stateKernelDualWriteMod.enqueueMirror === 'function') {
    try {
      stateKernelDualWriteMod.enqueueMirror({
        'queue-name': 'eye_kernel_route',
        'payload-json': JSON.stringify(row)
      });
    } catch {
      // state-kernel queue mirror must not block eye kernel routing
    }
  }

  const out = {
    ok: decision !== 'deny',
    type: 'eye_kernel_route',
    request_id: requestId,
    decision,
    reasons: combinedReasons,
    lane: evaluated.lane,
    target: evaluated.target,
    action: evaluated.action,
    risk: evaluated.risk,
    clearance: evaluated.clearance,
    estimated_tokens: evaluated.estimated_tokens,
    apply,
    policy_path: policyPath,
    state_path: statePath,
    audit_path: auditPath,
    latest_path: latestPath,
    day: evaluated.day,
    helix_gate: helixGate,
    capability_envelope: envelopeDecision
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(decision === 'deny' ? 1 : 0);
}

function cmdStatus(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  const statePath = path.resolve(String(args.state || DEFAULT_STATE_PATH));
  const policy = loadPolicy(policyPath);
  const state = loadState(statePath, policy);
  const helixGate = evaluateHelixGate(policy);
  const day = dateStr(args.date || nowIso());
  const dayState = ensureDayState(state, policy, day);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'eye_kernel_status',
    policy_path: policyPath,
    state_path: statePath,
    policy_version: policy.version,
    day,
    day_state: dayState,
    helix_gate: helixGate
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    return;
  }
  if (cmd === 'route') return cmdRoute(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'eye_kernel',
      error: String(err && err.message ? err.message : err || 'eye_kernel_failed')
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  loadState,
  evaluateRoute,
  main
};
