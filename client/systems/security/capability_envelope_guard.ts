#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.CAPABILITY_ENVELOPE_POLICY_PATH
  ? path.resolve(process.env.CAPABILITY_ENVELOPE_POLICY_PATH)
  : path.join(ROOT, 'config', 'capability_envelope_policy.json');
const STATE_PATH = process.env.CAPABILITY_ENVELOPE_STATE_PATH
  ? path.resolve(process.env.CAPABILITY_ENVELOPE_STATE_PATH)
  : path.join(ROOT, 'state', 'security', 'capability_envelope_state.json');
const AUDIT_PATH = process.env.CAPABILITY_ENVELOPE_AUDIT_PATH
  ? path.resolve(process.env.CAPABILITY_ENVELOPE_AUDIT_PATH)
  : path.join(ROOT, 'state', 'security', 'capability_envelope_audit.jsonl');

type AnyObj = Record<string, any>;

function nowIso() {
  return new Date().toISOString();
}

function dayKey(ts = nowIso()) {
  return String(ts || nowIso()).slice(0, 10);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/capability_envelope_guard.js evaluate --lane=<organ|vassal|external> --action=<id> --risk=<low|medium|high|critical> --estimated-tokens=<n> [--apply=1|0]');
  console.log('  node systems/security/capability_envelope_guard.js status');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq < 0) out[token.slice(2)] = true;
    else out[token.slice(2, eq)] = token.slice(eq + 1);
  }
  return out;
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 64) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
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
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, payload: any) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: any) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function defaultPolicy() {
  return {
    version: '1.0',
    strict_mode: true,
    lane_envelopes: {
      organ: {
        max_estimated_tokens: 12000,
        max_daily_actions: 400,
        blocked_risks: [],
        blocked_actions: []
      },
      vassal: {
        max_estimated_tokens: 8000,
        max_daily_actions: 250,
        blocked_risks: ['critical'],
        blocked_actions: []
      },
      external: {
        max_estimated_tokens: 5000,
        max_daily_actions: 120,
        blocked_risks: ['critical'],
        blocked_actions: ['filesystem_write_raw', 'shell_execute_unbounded']
      }
    }
  };
}

function normalizeEnvelope(raw: AnyObj, base: AnyObj) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    max_estimated_tokens: clampInt(src.max_estimated_tokens, 1, 1000000, base.max_estimated_tokens),
    max_daily_actions: clampInt(src.max_daily_actions, 1, 1000000, base.max_daily_actions),
    blocked_risks: Array.from(new Set((Array.isArray(src.blocked_risks) ? src.blocked_risks : base.blocked_risks)
      .map((v: unknown) => normalizeToken(v, 24))
      .filter(Boolean))),
    blocked_actions: Array.from(new Set((Array.isArray(src.blocked_actions) ? src.blocked_actions : base.blocked_actions)
      .map((v: unknown) => normalizeToken(v, 120))
      .filter(Boolean)))
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const src = raw && typeof raw === 'object' ? raw : {};
  const laneRaw = src.lane_envelopes && typeof src.lane_envelopes === 'object' ? src.lane_envelopes : {};
  return {
    version: cleanText(src.version || base.version, 32) || '1.0',
    strict_mode: src.strict_mode !== false,
    lane_envelopes: {
      organ: normalizeEnvelope(laneRaw.organ, base.lane_envelopes.organ),
      vassal: normalizeEnvelope(laneRaw.vassal, base.lane_envelopes.vassal),
      external: normalizeEnvelope(laneRaw.external, base.lane_envelopes.external)
    }
  };
}

function defaultState() {
  return {
    schema_id: 'capability_envelope_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    by_day: {}
  };
}

function loadState(statePath = STATE_PATH) {
  const src = readJson(statePath, null);
  if (!src || typeof src !== 'object') return defaultState();
  return {
    schema_id: 'capability_envelope_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 64),
    by_day: src.by_day && typeof src.by_day === 'object' ? src.by_day : {}
  };
}

function saveState(state: AnyObj, statePath = STATE_PATH) {
  writeJsonAtomic(statePath, {
    schema_id: 'capability_envelope_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    by_day: state && state.by_day && typeof state.by_day === 'object' ? state.by_day : {}
  });
}

function ensureDayLaneState(state: AnyObj, day: string, lane: string) {
  if (!state.by_day || typeof state.by_day !== 'object') state.by_day = {};
  if (!state.by_day[day] || typeof state.by_day[day] !== 'object') state.by_day[day] = {};
  if (!state.by_day[day][lane] || typeof state.by_day[day][lane] !== 'object') {
    state.by_day[day][lane] = {
      actions: 0,
      estimated_tokens: 0
    };
  }
  return state.by_day[day][lane];
}

function evaluateEnvelope(policy: AnyObj, state: AnyObj, input: AnyObj = {}) {
  const lane = normalizeToken(input.lane || 'organ', 32);
  const action = normalizeToken(input.action || '', 120);
  const risk = normalizeToken(input.risk || 'medium', 24);
  const estimatedTokens = clampInt(input.estimated_tokens, 0, 100000000, 0);
  const apply = toBool(input.apply, false);
  const day = dayKey(input.ts || nowIso());
  const lanePolicy = policy.lane_envelopes && policy.lane_envelopes[lane]
    ? policy.lane_envelopes[lane]
    : null;

  const reasons: string[] = [];
  if (!lanePolicy) reasons.push('lane_unknown');
  if (lanePolicy && estimatedTokens > Number(lanePolicy.max_estimated_tokens || 0)) reasons.push('lane_token_ceiling_exceeded');
  if (lanePolicy && lanePolicy.blocked_risks.includes(risk)) reasons.push('lane_risk_blocked');
  if (lanePolicy && action && lanePolicy.blocked_actions.includes(action)) reasons.push('lane_action_blocked');

  let laneState = null;
  if (lanePolicy) {
    laneState = ensureDayLaneState(state, day, lane);
    if ((Number(laneState.actions || 0) + 1) > Number(lanePolicy.max_daily_actions || 0)) {
      reasons.push('lane_daily_action_cap_exceeded');
    }
  }

  const allowed = reasons.length === 0;
  if (apply && allowed && laneState) {
    laneState.actions = Number(laneState.actions || 0) + 1;
    laneState.estimated_tokens = Number(laneState.estimated_tokens || 0) + estimatedTokens;
  }

  return {
    allowed,
    reasons,
    lane,
    action,
    risk,
    day,
    estimated_tokens: estimatedTokens,
    lane_state: laneState,
    lane_policy: lanePolicy || null
  };
}

function cmdEvaluate(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const state = loadState();
  const result = evaluateEnvelope(policy, state, {
    lane: args.lane,
    action: args.action,
    risk: args.risk,
    estimated_tokens: args.estimated_tokens || args['estimated-tokens'],
    apply: args.apply
  });
  if (toBool(args.apply, false) && result.allowed) {
    saveState(state);
  }
  const payload = {
    ts: nowIso(),
    type: 'capability_envelope_evaluate',
    policy_version: policy.version,
    ...result
  };
  appendJsonl(AUDIT_PATH, payload);
  process.stdout.write(`${JSON.stringify({ ok: true, ...payload })}\n`);
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const state = loadState();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'capability_envelope_status',
    ts: nowIso(),
    policy_version: policy.version,
    state
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'evaluate') return cmdEvaluate(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluateEnvelope,
  loadPolicy,
  loadState,
  saveState
};
