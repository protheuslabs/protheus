#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildForgeReplica } = require('../assimilation/forge_replica.js');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.FORGE_ORGAN_POLICY_PATH
  ? path.resolve(process.env.FORGE_ORGAN_POLICY_PATH)
  : path.join(ROOT, 'config', 'forge_organ_policy.json');
const STATE_PATH = process.env.FORGE_ORGAN_STATE_PATH
  ? path.resolve(process.env.FORGE_ORGAN_STATE_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'forge_organ', 'state.json');
const RUNS_PATH = process.env.FORGE_ORGAN_RUNS_PATH
  ? path.resolve(process.env.FORGE_ORGAN_RUNS_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'forge_organ', 'runs', `${new Date().toISOString().slice(0, 10)}.jsonl`);
const PROMOTIONS_PATH = process.env.FORGE_ORGAN_PROMOTIONS_PATH
  ? path.resolve(process.env.FORGE_ORGAN_PROMOTIONS_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'forge_organ', 'promotions', `${new Date().toISOString().slice(0, 10)}.jsonl`);
const LATEST_PATH = process.env.FORGE_ORGAN_LATEST_PATH
  ? path.resolve(process.env.FORGE_ORGAN_LATEST_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'forge_organ', 'latest.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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

function writeJsonAtomic(filePath: string, value: any) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
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

function hash12(seed: string) {
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    max_active_forged_organs: 16,
    default_ttl_hours: 24,
    max_ttl_hours: 168,
    containment: {
      sandbox_profile: 'strict_isolated',
      require_nursery_pass_for_promotion: true,
      require_policy_approval_for_promotion: true
    },
    hardware_classes: {
      tiny: ['io_bridge'],
      small: ['io_bridge', 'parser'],
      medium: ['io_bridge', 'parser', 'planner'],
      large: ['io_bridge', 'parser', 'planner', 'research_assist']
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const containment = raw.containment && typeof raw.containment === 'object' ? raw.containment : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    max_active_forged_organs: clampInt(raw.max_active_forged_organs, 1, 128, base.max_active_forged_organs),
    default_ttl_hours: clampInt(raw.default_ttl_hours, 1, 24 * 30, base.default_ttl_hours),
    max_ttl_hours: clampInt(raw.max_ttl_hours, 1, 24 * 180, base.max_ttl_hours),
    containment: {
      sandbox_profile: normalizeToken(containment.sandbox_profile || base.containment.sandbox_profile, 120) || base.containment.sandbox_profile,
      require_nursery_pass_for_promotion: containment.require_nursery_pass_for_promotion !== false,
      require_policy_approval_for_promotion: containment.require_policy_approval_for_promotion !== false
    },
    hardware_classes: raw.hardware_classes && typeof raw.hardware_classes === 'object'
      ? raw.hardware_classes
      : base.hardware_classes
  };
}

function defaultState() {
  return {
    schema_id: 'forge_organ_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    active: {},
    history: []
  };
}

function loadState() {
  const src = readJson(STATE_PATH, null);
  if (!src || typeof src !== 'object') return defaultState();
  return {
    schema_id: 'forge_organ_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 64),
    active: src.active && typeof src.active === 'object' ? src.active : {},
    history: Array.isArray(src.history) ? src.history.slice(-200) : []
  };
}

function saveState(state: AnyObj) {
  writeJsonAtomic(STATE_PATH, {
    schema_id: 'forge_organ_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    active: state && state.active && typeof state.active === 'object' ? state.active : {},
    history: Array.isArray(state && state.history) ? state.history.slice(-200) : []
  });
}

function parseJsonArg(raw: unknown) {
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/forge/forge_organ.js run --capability-id=<id> [--hardware-class=medium] [--ttl-hours=24] [--risk-class=general] [--mode=shadow]');
  console.log('  node systems/forge/forge_organ.js dissolve --forge-id=<id> [--reason=...]');
  console.log('  node systems/forge/forge_organ.js promote --forge-id=<id> [--nursery-pass=1] [--policy-approval=1]');
  console.log('  node systems/forge/forge_organ.js status [--forge-id=<id>]');
}

function cmdRun(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState();
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'forge_organ_run', error: 'forge_organ_disabled' })}\n`);
    process.exit(1);
  }

  const activeCount = Object.keys(state.active || {}).length;
  if (activeCount >= policy.max_active_forged_organs) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'forge_organ_run', error: 'max_active_forged_organs_reached', max: policy.max_active_forged_organs })}\n`);
    process.exit(1);
  }

  const ts = nowIso();
  const capabilityId = normalizeToken(args.capability_id || args['capability-id'] || '', 180);
  if (!capabilityId) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'forge_organ_run', error: 'capability_id_required' })}\n`);
    process.exit(1);
  }

  const hardwareClass = normalizeToken(args.hardware_class || args['hardware-class'] || 'medium', 60) || 'medium';
  const riskClass = normalizeToken(args.risk_class || args['risk-class'] || 'general', 60) || 'general';
  const mode = normalizeToken(args.mode || (policy.shadow_only ? 'shadow' : 'live'), 40) || 'shadow';
  const ttlHours = clampInt(args.ttl_hours || args['ttl-hours'], 1, policy.max_ttl_hours, policy.default_ttl_hours);
  const meta = parseJsonArg(args.metadata_json || args['metadata-json']);
  const forgeId = `forge_${hash12(`${capabilityId}|${ts}|${hardwareClass}`)}`;
  const allowedPacks = Array.isArray(policy.hardware_classes[hardwareClass])
    ? policy.hardware_classes[hardwareClass]
    : (Array.isArray(policy.hardware_classes.medium) ? policy.hardware_classes.medium : []);

  const replica = buildForgeReplica({
    capability_id: capabilityId,
    source_type: 'forge_organ',
    risk_class: riskClass,
    mode,
    now_ts: ts
  }, {
    forge: {
      sandbox_profile: policy.containment.sandbox_profile,
      max_build_steps: 8
    }
  });

  const record = {
    forge_id: forgeId,
    ts,
    capability_id: capabilityId,
    risk_class: riskClass,
    hardware_class: hardwareClass,
    capability_packs: allowedPacks,
    mode,
    ttl_hours: ttlHours,
    expires_at: new Date(Date.parse(ts) + ttlHours * 60 * 60 * 1000).toISOString(),
    containment: {
      sandbox_profile: policy.containment.sandbox_profile,
      proposal_only: policy.shadow_only === true || mode !== 'live'
    },
    replica,
    promotion_recommendation: 'dissolve',
    metadata: meta
  };

  state.active[forgeId] = record;
  state.history.push({ ts, event: 'forged', forge_id: forgeId, capability_id: capabilityId });
  saveState(state);
  appendJsonl(RUNS_PATH, { ts, type: 'forge_organ_run', ok: true, forge_id: forgeId, capability_id: capabilityId, hardware_class: hardwareClass, ttl_hours: ttlHours });
  writeJsonAtomic(LATEST_PATH, { ok: true, type: 'forge_organ_run', record });

  process.stdout.write(`${JSON.stringify({ ok: true, type: 'forge_organ_run', record, runs_path: path.relative(ROOT, RUNS_PATH).replace(/\\/g, '/') })}\n`);
}

function cmdDissolve(args: AnyObj) {
  const state = loadState();
  const forgeId = normalizeToken(args.forge_id || args['forge-id'] || '', 160);
  const row = forgeId ? state.active[forgeId] : null;
  if (!row) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'forge_organ_dissolve', error: 'forge_id_not_found' })}\n`);
    process.exit(1);
  }
  const reason = cleanText(args.reason || 'ttl_or_manual_dissolve', 220) || 'ttl_or_manual_dissolve';
  delete state.active[forgeId];
  state.history.push({ ts: nowIso(), event: 'dissolved', forge_id: forgeId, reason });
  saveState(state);
  appendJsonl(RUNS_PATH, { ts: nowIso(), type: 'forge_organ_dissolve', ok: true, forge_id: forgeId, reason });
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'forge_organ_dissolve', forge_id: forgeId, reason })}\n`);
}

function cmdPromote(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState();
  const forgeId = normalizeToken(args.forge_id || args['forge-id'] || '', 160);
  const row = forgeId ? state.active[forgeId] : null;
  if (!row) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'forge_organ_promote', error: 'forge_id_not_found' })}\n`);
    process.exit(1);
  }

  const nurseryRaw = args.nursery_pass != null ? args.nursery_pass : args['nursery-pass'];
  const approvalRaw = args.policy_approval != null ? args.policy_approval : args['policy-approval'];
  const nurseryPass = nurseryRaw == null ? false : ['1', 'true', 'yes', 'on'].includes(String(nurseryRaw).toLowerCase());
  const policyApproval = approvalRaw == null ? false : ['1', 'true', 'yes', 'on'].includes(String(approvalRaw).toLowerCase());
  const blocked: string[] = [];
  if (policy.containment.require_nursery_pass_for_promotion && !nurseryPass) blocked.push('nursery_pass_required');
  if (policy.containment.require_policy_approval_for_promotion && !policyApproval) blocked.push('policy_approval_required');

  const ts = nowIso();
  const promotion = {
    ts,
    forge_id: forgeId,
    capability_id: row.capability_id,
    nursery_pass: nurseryPass,
    policy_approval: policyApproval,
    blocked,
    decision: blocked.length ? 'retry' : 'promote'
  };
  appendJsonl(PROMOTIONS_PATH, { type: 'forge_organ_promotion', ...promotion });
  if (!blocked.length) {
    row.promotion_recommendation = 'promote';
    row.promoted_at = ts;
    state.active[forgeId] = row;
    state.history.push({ ts, event: 'promoted', forge_id: forgeId });
    saveState(state);
  }
  process.stdout.write(`${JSON.stringify({ ok: blocked.length === 0, type: 'forge_organ_promote', promotion })}\n`);
  if (blocked.length) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const state = loadState();
  const forgeId = normalizeToken(args.forge_id || args['forge-id'] || '', 160);
  const out = {
    ok: true,
    type: 'forge_organ_status',
    ts: nowIso(),
    forge_id: forgeId || null,
    record: forgeId ? (state.active[forgeId] || null) : null,
    active: forgeId ? undefined : state.active,
    history: forgeId ? undefined : state.history
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'dissolve') return cmdDissolve(args);
  if (cmd === 'promote') return cmdPromote(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
