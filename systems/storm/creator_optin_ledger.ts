#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/storm/creator_optin_ledger.js
 *
 * V3-ATTR-003: Creator Opt-In & Public Assimilation Ledger
 * - Manages creator opt-in/out signals and payout preferences.
 * - Maintains privacy-preserving public ledger projections.
 * - Computes creator badges and partnership tier.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { appendAction } = require('../security/agent_passport.js');
const { writeContractReceipt } = require('../../lib/action_receipts.js');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.CREATOR_OPTIN_LEDGER_POLICY_PATH
  ? path.resolve(process.env.CREATOR_OPTIN_LEDGER_POLICY_PATH)
  : path.join(ROOT, 'config', 'creator_optin_ledger_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/storm/creator_optin_ledger.js opt-in --creator-id=<id> [--alias=<alias>] [--public-name=<name>] [--mode=royalty|donation|hybrid] [--donation-target=<id>] [--policy=path]');
  console.log('  node systems/storm/creator_optin_ledger.js opt-out --creator-id=<id> [--policy=path]');
  console.log('  node systems/storm/creator_optin_ledger.js record-contribution --creator-id=<id> [--influence=<0..1>] [--weight=<n>] [--source-id=<id>] [--policy=path]');
  console.log('  node systems/storm/creator_optin_ledger.js publish [--creator-id=<id>] [--policy=path]');
  console.log('  node systems/storm/creator_optin_ledger.js status [--creator-id=<id>] [--policy=path]');
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

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
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

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    allow_apply: false,
    privacy: {
      hash_salt_env: 'STORM_LEDGER_SALT',
      expose_public_name: false
    },
    partnership: {
      tiers: [
        { id: 'seed', min_influence: 0 },
        { id: 'bronze', min_influence: 3 },
        { id: 'silver', min_influence: 10 },
        { id: 'gold', min_influence: 25 },
        { id: 'platinum', min_influence: 60 }
      ],
      badges: {
        first_optin: { min_events: 1 },
        contributor: { min_events: 5 },
        catalyst: { min_events: 15 },
        steward: { min_events: 40 }
      }
    },
    state: {
      root: 'state/storm/creator_optin',
      index_path: 'state/storm/creator_optin/index.json',
      latest_path: 'state/storm/creator_optin/latest.json',
      history_path: 'state/storm/creator_optin/history.jsonl',
      public_ledger_path: 'state/storm/creator_optin/public_ledger.jsonl',
      receipts_path: 'state/storm/creator_optin/receipts.jsonl'
    },
    passport: {
      enabled: true,
      source: 'creator_optin_ledger'
    }
  };
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const text = cleanText(raw, 500);
  if (!text) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(text) ? text : path.join(ROOT, text);
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const privacy = raw.privacy && typeof raw.privacy === 'object' ? raw.privacy : {};
  const partnership = raw.partnership && typeof raw.partnership === 'object' ? raw.partnership : {};
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  const passport = raw.passport && typeof raw.passport === 'object' ? raw.passport : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    allow_apply: toBool(raw.allow_apply, base.allow_apply),
    privacy: {
      hash_salt_env: cleanText(privacy.hash_salt_env || base.privacy.hash_salt_env, 80) || base.privacy.hash_salt_env,
      expose_public_name: toBool(privacy.expose_public_name, base.privacy.expose_public_name)
    },
    partnership: {
      tiers: Array.isArray(partnership.tiers) && partnership.tiers.length
        ? partnership.tiers.map((row: AnyObj) => ({
          id: normalizeToken(row && row.id || '', 60) || 'seed',
          min_influence: clampNumber(row && row.min_influence, 0, 1_000_000, 0)
        })).sort((a: AnyObj, b: AnyObj) => Number(a.min_influence || 0) - Number(b.min_influence || 0))
        : base.partnership.tiers,
      badges: partnership.badges && typeof partnership.badges === 'object'
        ? partnership.badges
        : base.partnership.badges
    },
    state: {
      root: resolvePath(state.root || base.state.root, base.state.root),
      index_path: resolvePath(state.index_path || base.state.index_path, base.state.index_path),
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      history_path: resolvePath(state.history_path || base.state.history_path, base.state.history_path),
      public_ledger_path: resolvePath(state.public_ledger_path || base.state.public_ledger_path, base.state.public_ledger_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path)
    },
    passport: {
      enabled: toBool(passport.enabled, base.passport.enabled),
      source: normalizeToken(passport.source || base.passport.source, 120) || base.passport.source
    }
  };
}

function hashCreator(creatorId: string, policy: AnyObj) {
  const salt = cleanText(process.env[policy.privacy.hash_salt_env] || '', 1024) || 'storm_public_default_salt';
  return crypto.createHash('sha256').update(`${salt}:${creatorId}`, 'utf8').digest('hex').slice(0, 24);
}

function loadIndex(policy: AnyObj) {
  const base = {
    schema_id: 'creator_optin_index',
    schema_version: '1.0',
    updated_at: null,
    creators: {}
  };
  const src = readJson(policy.state.index_path, base);
  if (!src || typeof src !== 'object') return base;
  if (!src.creators || typeof src.creators !== 'object') src.creators = {};
  return src;
}

function saveIndex(policy: AnyObj, index: AnyObj) {
  index.updated_at = nowIso();
  writeJsonAtomic(policy.state.index_path, index);
}

function computeBadgesAndTier(creator: AnyObj, policy: AnyObj) {
  const influenceTotal = Number(creator && creator.metrics && creator.metrics.influence_total || 0);
  const events = Number(creator && creator.metrics && creator.metrics.contribution_events || 0);

  const badges: string[] = [];
  const badgeRules = policy.partnership.badges && typeof policy.partnership.badges === 'object'
    ? policy.partnership.badges
    : {};
  for (const [badge, ruleRaw] of Object.entries(badgeRules)) {
    const rule = ruleRaw as AnyObj;
    const minEvents = clampInt(rule && rule.min_events, 1, 1_000_000, 1);
    if (events >= minEvents) badges.push(normalizeToken(badge, 60));
  }

  const tiers = Array.isArray(policy.partnership.tiers) ? policy.partnership.tiers : [];
  let tierId = 'seed';
  for (const tier of tiers) {
    if (influenceTotal >= Number(tier && tier.min_influence || 0)) {
      tierId = normalizeToken(tier && tier.id || 'seed', 60) || 'seed';
    }
  }

  return {
    badges,
    partnership_tier: tierId
  };
}

function emitReceipt(policy: AnyObj, payload: AnyObj) {
  const receipt = writeContractReceipt(policy.state.receipts_path, payload, {
    attempted: true,
    verified: policy.shadow_only !== true
  });
  let passportLink = null;
  if (policy.passport.enabled === true) {
    const linked = appendAction({
      source: policy.passport.source,
      action: {
        action_type: normalizeToken(payload.type || 'creator_optin_event', 120) || 'creator_optin_event',
        objective_id: normalizeToken(payload.objective_id || '', 180) || null,
        target: normalizeToken(payload.creator_id || payload.public_creator_ref || '', 180) || null,
        status: policy.shadow_only === true ? 'shadow_only' : 'recorded',
        attempted: true,
        verified: policy.shadow_only !== true,
        metadata: {
          payload_type: payload.type || null,
          creator_id: payload.creator_id || null,
          mode: payload.mode || null
        }
      }
    });
    if (linked && linked.ok === true) {
      passportLink = {
        action_id: linked.action_id || null,
        seq: linked.seq || null,
        hash: linked.hash || null,
        passport_id: linked.passport_id || null
      };
    }
  }
  return {
    receipt,
    passport_link: passportLink
  };
}

function ensureCreator(index: AnyObj, creatorId: string) {
  if (!index.creators[creatorId]) {
    index.creators[creatorId] = {
      creator_id: creatorId,
      alias: null,
      public_name: null,
      opted_in: false,
      payout_mode: 'royalty',
      donation_target: null,
      created_at: nowIso(),
      updated_at: nowIso(),
      metrics: {
        influence_total: 0,
        contribution_events: 0,
        last_source_id: null,
        last_event_ts: null
      },
      partnership: {
        badges: [],
        partnership_tier: 'seed'
      }
    };
  }
  return index.creators[creatorId];
}

function setOptIn(inputRaw: AnyObj = {}, opts: AnyObj = {}) {
  const policyPath = opts.policy
    ? resolvePath(opts.policy, 'config/creator_optin_ledger_policy.json')
    : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (policy.enabled !== true) {
    return { ok: false, type: 'creator_optin', error: 'policy_disabled' };
  }
  const creatorId = normalizeToken(inputRaw.creator_id || '', 180);
  if (!creatorId) {
    return { ok: false, type: 'creator_optin', error: 'creator_id_required' };
  }

  const index = loadIndex(policy);
  const creator = ensureCreator(index, creatorId);
  creator.alias = cleanText(inputRaw.alias || creator.alias || '', 120) || null;
  creator.public_name = cleanText(inputRaw.public_name || creator.public_name || '', 120) || null;
  creator.opted_in = true;
  creator.payout_mode = normalizeToken(inputRaw.mode || creator.payout_mode || 'royalty', 40) || 'royalty';
  creator.donation_target = cleanText(inputRaw.donation_target || creator.donation_target || '', 240) || null;
  creator.updated_at = nowIso();

  creator.partnership = computeBadgesAndTier(creator, policy);
  saveIndex(policy, index);

  const event = {
    ts: nowIso(),
    type: 'creator_optin',
    creator_id: creatorId,
    mode: creator.payout_mode,
    shadow_only: policy.shadow_only === true
  };
  appendJsonl(policy.state.history_path, event);
  writeJsonAtomic(policy.state.latest_path, event);
  const receipt = emitReceipt(policy, event);

  return {
    ok: true,
    type: 'creator_optin',
    creator_id: creatorId,
    opted_in: true,
    mode: creator.payout_mode,
    partnership: creator.partnership,
    shadow_only: policy.shadow_only === true,
    passport_link: receipt.passport_link
  };
}

function setOptOut(inputRaw: AnyObj = {}, opts: AnyObj = {}) {
  const policyPath = opts.policy
    ? resolvePath(opts.policy, 'config/creator_optin_ledger_policy.json')
    : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (policy.enabled !== true) {
    return { ok: false, type: 'creator_optout', error: 'policy_disabled' };
  }
  const creatorId = normalizeToken(inputRaw.creator_id || '', 180);
  if (!creatorId) {
    return { ok: false, type: 'creator_optout', error: 'creator_id_required' };
  }

  const index = loadIndex(policy);
  const creator = ensureCreator(index, creatorId);
  creator.opted_in = false;
  creator.updated_at = nowIso();
  saveIndex(policy, index);

  const event = {
    ts: nowIso(),
    type: 'creator_optout',
    creator_id: creatorId,
    shadow_only: policy.shadow_only === true
  };
  appendJsonl(policy.state.history_path, event);
  writeJsonAtomic(policy.state.latest_path, event);
  const receipt = emitReceipt(policy, event);

  return {
    ok: true,
    type: 'creator_optout',
    creator_id: creatorId,
    opted_in: false,
    shadow_only: policy.shadow_only === true,
    passport_link: receipt.passport_link
  };
}

function recordContribution(inputRaw: AnyObj = {}, opts: AnyObj = {}) {
  const policyPath = opts.policy
    ? resolvePath(opts.policy, 'config/creator_optin_ledger_policy.json')
    : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (policy.enabled !== true) {
    return { ok: false, type: 'creator_contribution', error: 'policy_disabled' };
  }

  const creatorId = normalizeToken(inputRaw.creator_id || '', 180);
  if (!creatorId) {
    return { ok: false, type: 'creator_contribution', error: 'creator_id_required' };
  }

  const influence = clampNumber(inputRaw.influence, 0, 1, 0);
  const weight = clampNumber(inputRaw.weight, 0, 1000, 1);
  const contribution = Number((influence * weight).toFixed(6));

  const index = loadIndex(policy);
  const creator = ensureCreator(index, creatorId);
  creator.metrics.influence_total = Number((Number(creator.metrics.influence_total || 0) + contribution).toFixed(6));
  creator.metrics.contribution_events = Number(creator.metrics.contribution_events || 0) + 1;
  creator.metrics.last_source_id = normalizeToken(inputRaw.source_id || '', 180) || creator.metrics.last_source_id || null;
  creator.metrics.last_event_ts = nowIso();
  creator.updated_at = nowIso();
  creator.partnership = computeBadgesAndTier(creator, policy);
  saveIndex(policy, index);

  const event = {
    ts: nowIso(),
    type: 'creator_contribution',
    creator_id: creatorId,
    contribution,
    influence,
    weight,
    source_id: creator.metrics.last_source_id,
    partnership: creator.partnership,
    shadow_only: policy.shadow_only === true
  };
  appendJsonl(policy.state.history_path, event);
  writeJsonAtomic(policy.state.latest_path, event);
  const receipt = emitReceipt(policy, event);

  return {
    ok: true,
    type: 'creator_contribution',
    creator_id: creatorId,
    contribution,
    partnership: creator.partnership,
    shadow_only: policy.shadow_only === true,
    passport_link: receipt.passport_link
  };
}

function publishPublicEntries(inputRaw: AnyObj = {}, opts: AnyObj = {}) {
  const policyPath = opts.policy
    ? resolvePath(opts.policy, 'config/creator_optin_ledger_policy.json')
    : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (policy.enabled !== true) {
    return { ok: false, type: 'creator_public_publish', error: 'policy_disabled' };
  }

  const creatorFilter = normalizeToken(inputRaw.creator_id || '', 180) || null;
  const index = loadIndex(policy);
  const creators = Object.values(index.creators || {}) as AnyObj[];
  const rows: AnyObj[] = [];

  for (const creator of creators) {
    const creatorId = normalizeToken(creator && creator.creator_id || '', 180);
    if (!creatorId) continue;
    if (creatorFilter && creatorFilter !== creatorId) continue;
    if (creator.opted_in !== true) continue;

    const publicRef = hashCreator(creatorId, policy);
    const partnership = computeBadgesAndTier(creator, policy);
    const row = {
      ts: nowIso(),
      type: 'creator_public_projection',
      public_creator_ref: publicRef,
      public_name: policy.privacy.expose_public_name === true
        ? (cleanText(creator.public_name || creator.alias || '', 120) || null)
        : null,
      opted_in: creator.opted_in === true,
      payout_mode: normalizeToken(creator.payout_mode || 'royalty', 40) || 'royalty',
      badges: partnership.badges,
      partnership_tier: partnership.partnership_tier,
      influence_total: Number(creator.metrics && creator.metrics.influence_total || 0),
      contribution_events: Number(creator.metrics && creator.metrics.contribution_events || 0),
      shadow_only: policy.shadow_only === true
    };
    rows.push(row);
    appendJsonl(policy.state.public_ledger_path, row);
    const receipt = emitReceipt(policy, {
      ...row,
      creator_id: creatorId
    });
    row.passport_link = receipt.passport_link;
  }

  const event = {
    ts: nowIso(),
    type: 'creator_public_publish',
    count: rows.length,
    creator_filter: creatorFilter,
    shadow_only: policy.shadow_only === true
  };
  appendJsonl(policy.state.history_path, event);
  writeJsonAtomic(policy.state.latest_path, event);

  return {
    ok: true,
    type: 'creator_public_publish',
    count: rows.length,
    rows,
    public_ledger_path: relPath(policy.state.public_ledger_path),
    shadow_only: policy.shadow_only === true
  };
}

function status(inputRaw: AnyObj = {}, opts: AnyObj = {}) {
  const policyPath = opts.policy
    ? resolvePath(opts.policy, 'config/creator_optin_ledger_policy.json')
    : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const creatorFilter = normalizeToken(inputRaw.creator_id || '', 180) || null;
  const index = loadIndex(policy);
  const creators = Object.values(index.creators || {}) as AnyObj[];
  const selected = creatorFilter
    ? creators.filter((row) => normalizeToken(row && row.creator_id || '', 180) === creatorFilter)
    : creators;

  const projected = selected.map((row) => ({
    creator_id: normalizeToken(row && row.creator_id || '', 180),
    opted_in: row && row.opted_in === true,
    payout_mode: normalizeToken(row && row.payout_mode || 'royalty', 40) || 'royalty',
    partnership: computeBadgesAndTier(row, policy),
    influence_total: Number(row && row.metrics && row.metrics.influence_total || 0),
    contribution_events: Number(row && row.metrics && row.metrics.contribution_events || 0)
  }));

  return {
    ok: true,
    type: 'creator_optin_status',
    creators_total: creators.length,
    selected_total: projected.length,
    opted_in_total: creators.filter((row) => row && row.opted_in === true).length,
    creators: projected,
    shadow_only: policy.shadow_only === true,
    index_path: relPath(policy.state.index_path),
    public_ledger_path: relPath(policy.state.public_ledger_path)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help === true) {
    usage();
    return;
  }

  let out: AnyObj;
  if (cmd === 'opt-in') {
    out = setOptIn({
      creator_id: args.creator_id || args['creator-id'],
      alias: args.alias,
      public_name: args.public_name || args['public-name'],
      mode: args.mode,
      donation_target: args.donation_target || args['donation-target']
    }, { policy: args.policy });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(out.ok ? 0 : 1);
    return;
  }
  if (cmd === 'opt-out') {
    out = setOptOut({ creator_id: args.creator_id || args['creator-id'] }, { policy: args.policy });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(out.ok ? 0 : 1);
    return;
  }
  if (cmd === 'record-contribution') {
    out = recordContribution({
      creator_id: args.creator_id || args['creator-id'],
      influence: args.influence,
      weight: args.weight,
      source_id: args.source_id || args['source-id']
    }, { policy: args.policy });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(out.ok ? 0 : 1);
    return;
  }
  if (cmd === 'publish') {
    out = publishPublicEntries({ creator_id: args.creator_id || args['creator-id'] }, { policy: args.policy });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(out.ok ? 0 : 1);
    return;
  }
  if (cmd === 'status') {
    out = status({ creator_id: args.creator_id || args['creator-id'] }, { policy: args.policy });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }

  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  main();
}

module.exports = {
  defaultPolicy,
  loadPolicy,
  setOptIn,
  setOptOut,
  recordContribution,
  publishPublicEntries,
  status,
  computeBadgesAndTier,
  loadIndex,
  saveIndex
};
