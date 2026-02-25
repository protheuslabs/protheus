#!/usr/bin/env node
'use strict';
export {};

/**
 * claw_registry.js
 *
 * Governance registry for high-power actuation lanes ("claws").
 *
 * Usage:
 *   node systems/actuation/claw_registry.js status
 *   node systems/actuation/claw_registry.js evaluate --kind=<adapter_kind> [--dry-run] [--context=<json>]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.ACTUATION_CLAWS_POLICY_PATH
  ? path.resolve(process.env.ACTUATION_CLAWS_POLICY_PATH)
  : path.join(ROOT, 'config', 'actuation_claws_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/actuation/claw_registry.js status [--policy=path]');
  console.log('  node systems/actuation/claw_registry.js evaluate --kind=<adapter_kind> [--dry-run] [--context=<json>] [--policy=path]');
}

function parseArgs(argv) {
  const out = { _: [] };
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

function nowIso() {
  return new Date().toISOString();
}

function normalizeToken(v, maxLen = 80) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .slice(0, maxLen)
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function boolFlag(v, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    default_lane: 'api',
    adapter_lane_map: {},
    lanes: {
      api: { mode: 'active', require_human_approval: false },
      browser: { mode: 'shadow_only', require_human_approval: true },
      computer_use: { mode: 'shadow_only', require_human_approval: true },
      payment: { mode: 'disabled', require_human_approval: true }
    }
  };
}

function normalizeLane(rawLane, fallbackMode = 'shadow_only') {
  const src = rawLane && typeof rawLane === 'object' ? rawLane : {};
  const modeRaw = normalizeToken(src.mode || fallbackMode, 40);
  const mode = modeRaw === 'active' || modeRaw === 'disabled' ? modeRaw : 'shadow_only';
  return {
    mode,
    require_human_approval: src.require_human_approval !== false
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const laneSrc = raw.lanes && typeof raw.lanes === 'object' ? raw.lanes : {};
  const lanes = {};
  for (const [laneName, laneRaw] of Object.entries({ ...base.lanes, ...laneSrc })) {
    const key = normalizeToken(laneName, 40);
    if (!key) continue;
    lanes[key] = normalizeLane(laneRaw, base.lanes[key] ? base.lanes[key].mode : 'shadow_only');
  }
  const mapSrc = raw.adapter_lane_map && typeof raw.adapter_lane_map === 'object' ? raw.adapter_lane_map : {};
  const adapterLaneMap = {};
  for (const [adapter, lane] of Object.entries(mapSrc)) {
    const a = normalizeToken(adapter, 80);
    const l = normalizeToken(lane, 40);
    if (!a || !l) continue;
    adapterLaneMap[a] = lanes[l] ? l : normalizeToken(base.default_lane, 40);
  }
  const defaultLane = normalizeToken(raw.default_lane || base.default_lane, 40) || 'api';
  return {
    version: String(raw.version || base.version),
    enabled: raw.enabled !== false,
    default_lane: lanes[defaultLane] ? defaultLane : 'api',
    adapter_lane_map: adapterLaneMap,
    lanes
  };
}

function laneForAdapter(policy, kind, context = {}) {
  const p = policy && typeof policy === 'object' ? policy : defaultPolicy();
  const k = normalizeToken(kind, 80);
  const ctxLane = normalizeToken(context && context.lane || '', 40);
  if (ctxLane && p.lanes && p.lanes[ctxLane]) return ctxLane;
  if (k && p.adapter_lane_map && p.adapter_lane_map[k]) return p.adapter_lane_map[k];
  return normalizeToken(p.default_lane || 'api', 40) || 'api';
}

function evaluateClawDecision(opts = {}) {
  const policy = opts.policy && typeof opts.policy === 'object' ? opts.policy : loadPolicy(opts.policyPath || POLICY_PATH);
  const kind = normalizeToken(opts.kind || '', 80);
  const dryRun = opts.dry_run === true;
  const context = opts.context && typeof opts.context === 'object' ? opts.context : {};
  const lane = laneForAdapter(policy, kind, context);
  const laneCfg = policy.lanes && policy.lanes[lane] ? policy.lanes[lane] : { mode: 'shadow_only', require_human_approval: true };
  const mode = normalizeToken(laneCfg.mode || 'shadow_only', 40) || 'shadow_only';
  const approved = boolFlag(context && (context.human_approved || context.approved || context.approval), false);

  const out = {
    ok: true,
    enabled: policy.enabled === true,
    kind: kind || null,
    lane,
    lane_mode: mode,
    dry_run: dryRun,
    allowed: true,
    reason: null,
    require_human_approval: laneCfg.require_human_approval === true,
    approved: approved === true
  };

  if (policy.enabled !== true) {
    out.allowed = true;
    out.reason = 'policy_disabled';
    return out;
  }

  if (mode === 'disabled') {
    out.allowed = false;
    out.reason = `lane_disabled:${lane}`;
    return out;
  }
  if (mode === 'shadow_only' && dryRun !== true) {
    out.allowed = false;
    out.reason = `lane_shadow_only:${lane}`;
    return out;
  }
  if (laneCfg.require_human_approval === true && approved !== true && mode !== 'shadow_only') {
    out.allowed = false;
    out.reason = `lane_requires_human_approval:${lane}`;
    return out;
  }
  out.allowed = true;
  out.reason = mode === 'shadow_only' ? `lane_shadow_allowed_dry_run:${lane}` : `lane_allowed:${lane}`;
  return out;
}

function cmdStatus(args) {
  const policyPath = path.resolve(String(args.policy || process.env.ACTUATION_CLAWS_POLICY_PATH || POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const lanes = Object.entries(policy.lanes || {})
    .map(([lane, cfg]) => ({
      lane,
      mode: String(cfg && cfg.mode || 'shadow_only'),
      require_human_approval: cfg && cfg.require_human_approval === true
    }))
    .sort((a, b) => a.lane.localeCompare(b.lane));
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'claw_registry_status',
    ts: nowIso(),
    policy_path: path.relative(ROOT, policyPath).replace(/\\/g, '/'),
    enabled: policy.enabled === true,
    default_lane: policy.default_lane,
    lane_count: lanes.length,
    lanes
  })}\n`);
}

function parseJsonArg(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return null;
  }
}

function cmdEvaluate(args) {
  const kind = String(args.kind || '').trim();
  if (!kind) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'kind_required' })}\n`);
    process.exit(2);
  }
  const context = parseJsonArg(args.context);
  if (context == null) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'invalid_context_json' })}\n`);
    process.exit(2);
  }
  const decision = evaluateClawDecision({
    kind,
    dry_run: args['dry-run'] === true || boolFlag(args.dry_run, false),
    context,
    policyPath: args.policy || process.env.ACTUATION_CLAWS_POLICY_PATH || POLICY_PATH
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'claw_registry_evaluate',
    ts: nowIso(),
    ...decision
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'status') return cmdStatus(args);
  if (cmd === 'evaluate') return cmdEvaluate(args);
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'claw_registry',
      error: String(err && err.message ? err.message : err || 'claw_registry_failed')
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  evaluateClawDecision,
  laneForAdapter
};
