#!/usr/bin/env node
'use strict';
export {};

/**
 * V2-BRG-002
 * Governed payment bridge (Stripe/PayPal/Mercury) with dry-run/live gates,
 * hold semantics, and immutable receipts.
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.PAYMENT_SKILLS_BRIDGE_POLICY_PATH
  ? path.resolve(process.env.PAYMENT_SKILLS_BRIDGE_POLICY_PATH)
  : path.join(ROOT, 'config', 'payment_skills_bridge_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    const raw = String(tok || '');
    if (!raw.startsWith('--')) {
      out._.push(raw);
      continue;
    }
    const idx = raw.indexOf('=');
    if (idx === -1) out[raw.slice(2)] = true;
    else out[raw.slice(2, idx)] = raw.slice(idx + 1);
  }
  return out;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clean(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 80) {
  return clean(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    require_approval_note_for_live: true,
    max_single_payout_usd: 2500,
    providers: {
      stripe: { enabled: true },
      paypal: { enabled: true },
      mercury: { enabled: true }
    },
    negotiation: {
      enabled: true,
      default_profile: 'balanced',
      profiles: {
        balanced: {
          min_accept_ratio: 0.9,
          auto_accept_ratio: 0.98,
          max_discount_ratio: 0.15,
          max_rounds: 3
        },
        hardline: {
          min_accept_ratio: 0.95,
          auto_accept_ratio: 1,
          max_discount_ratio: 0.08,
          max_rounds: 2
        },
        flexible: {
          min_accept_ratio: 0.82,
          auto_accept_ratio: 0.94,
          max_discount_ratio: 0.22,
          max_rounds: 4
        }
      }
    },
    paths: {
      state: 'state/workflow/payment_bridge/latest.json',
      history: 'state/workflow/payment_bridge/history.jsonl',
      holds: 'state/workflow/payment_bridge/holds.json',
      negotiations: 'state/workflow/payment_bridge/negotiations.json'
    }
  };
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const text = clean(raw, 500);
  if (!text) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(text) ? text : path.join(ROOT, text);
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const providers = raw && raw.providers && typeof raw.providers === 'object'
    ? raw.providers
    : {};
  const negotiation = raw && raw.negotiation && typeof raw.negotiation === 'object'
    ? raw.negotiation
    : {};
  const pathsCfg = raw && raw.paths && typeof raw.paths === 'object'
    ? raw.paths
    : {};
  const normalizeProvider = (id: string) => ({
    enabled: !(providers[id] && providers[id].enabled === false)
  });
  return {
    version: clean(raw && raw.version || base.version, 32) || '1.0',
    enabled: raw && raw.enabled !== false,
    shadow_only: raw && raw.shadow_only !== false,
    require_approval_note_for_live: toBool(
      raw && raw.require_approval_note_for_live,
      base.require_approval_note_for_live
    ),
    max_single_payout_usd: clampNumber(
      raw && raw.max_single_payout_usd,
      1,
      1_000_000,
      base.max_single_payout_usd
    ),
    providers: {
      stripe: normalizeProvider('stripe'),
      paypal: normalizeProvider('paypal'),
      mercury: normalizeProvider('mercury')
    },
    negotiation: {
      enabled: negotiation.enabled !== false,
      default_profile: normalizeToken(
        negotiation.default_profile || base.negotiation.default_profile,
        40
      ) || base.negotiation.default_profile,
      profiles: (() => {
        const baseProfiles = base.negotiation.profiles || {};
        const rawProfiles = negotiation.profiles && typeof negotiation.profiles === 'object'
          ? negotiation.profiles
          : {};
        const outProfiles: AnyObj = {};
        const profileIds = Array.from(new Set([
          ...Object.keys(baseProfiles),
          ...Object.keys(rawProfiles)
        ]));
        for (const idRaw of profileIds) {
          const id = normalizeToken(idRaw, 40);
          if (!id) continue;
          const baseRow = baseProfiles[idRaw] || baseProfiles[id] || baseProfiles.balanced || {};
          const row = rawProfiles[idRaw] || rawProfiles[id] || {};
          outProfiles[id] = {
            min_accept_ratio: clampNumber(row.min_accept_ratio, 0, 1, baseRow.min_accept_ratio || 0.9),
            auto_accept_ratio: clampNumber(row.auto_accept_ratio, 0, 1, baseRow.auto_accept_ratio || 0.98),
            max_discount_ratio: clampNumber(row.max_discount_ratio, 0, 1, baseRow.max_discount_ratio || 0.15),
            max_rounds: Math.max(1, Math.min(12, Number(row.max_rounds || baseRow.max_rounds || 3) || 3))
          };
        }
        return outProfiles;
      })()
    },
    paths: {
      state: resolvePath(pathsCfg.state, base.paths.state),
      history: resolvePath(pathsCfg.history, base.paths.history),
      holds: resolvePath(pathsCfg.holds, base.paths.holds),
      negotiations: resolvePath(pathsCfg.negotiations, base.paths.negotiations)
    }
  };
}

function loadHolds(holdsPath: string) {
  const payload = readJson(holdsPath, {});
  const holds = payload && payload.holds && typeof payload.holds === 'object'
    ? payload.holds
    : {};
  return {
    schema_id: 'payment_bridge_holds',
    schema_version: '1.0',
    updated_at: payload && payload.updated_at ? String(payload.updated_at) : null,
    holds
  };
}

function persistHolds(holdsPath: string, holds: AnyObj) {
  writeJsonAtomic(holdsPath, {
    schema_id: 'payment_bridge_holds',
    schema_version: '1.0',
    updated_at: nowIso(),
    holds
  });
}

function loadNegotiations(filePath: string) {
  const payload = readJson(filePath, {});
  const negotiations = payload && payload.negotiations && typeof payload.negotiations === 'object'
    ? payload.negotiations
    : {};
  return {
    schema_id: 'payment_bridge_negotiations',
    schema_version: '1.0',
    updated_at: payload && payload.updated_at ? String(payload.updated_at) : null,
    negotiations
  };
}

function persistNegotiations(filePath: string, negotiations: AnyObj) {
  writeJsonAtomic(filePath, {
    schema_id: 'payment_bridge_negotiations',
    schema_version: '1.0',
    updated_at: nowIso(),
    negotiations
  });
}

function makeReceiptBase(policyPath: string, policy: AnyObj, args: AnyObj) {
  const provider = normalizeToken(args.provider || args.gateway || '', 32);
  const amountUsd = Number(clampNumber(args['amount-usd'] ?? args.amount_usd, 0, 1_000_000_000, 0).toFixed(2));
  const recipient = clean(args.recipient || args.destination || '', 160) || null;
  const payoutId = clean(args['payout-id'] || args.payout_id || `payout_${Date.now().toString(36)}`, 120);
  const applyRequested = toBool(args.apply, false);
  const approvalNote = clean(args['approval-note'] || args.approval_note || '', 240) || null;
  return {
    provider,
    amount_usd: amountUsd,
    recipient,
    payout_id: payoutId,
    apply_requested: applyRequested,
    approval_note: approvalNote,
    policy_path: relPath(policyPath),
    policy_version: policy.version
  };
}

function runPayout(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const strict = toBool(args.strict, false);
  const base = makeReceiptBase(policyPath, policy, args);
  const ts = nowIso();
  const blockers: string[] = [];
  const holdsState = loadHolds(policy.paths.holds);
  const holds = holdsState.holds && typeof holdsState.holds === 'object' ? holdsState.holds : {};

  if (policy.enabled !== true) blockers.push('policy_disabled');
  if (!base.provider || !policy.providers[base.provider] || policy.providers[base.provider].enabled !== true) {
    blockers.push('provider_disabled_or_unknown');
  }
  if (base.amount_usd <= 0) blockers.push('invalid_amount');
  if (base.amount_usd > Number(policy.max_single_payout_usd || 2500)) blockers.push('amount_exceeds_cap');

  let decision = 'dry_run';
  let result = 'ok';
  if (base.apply_requested !== true) {
    decision = 'dry_run';
  } else if (policy.shadow_only === true) {
    decision = 'hold';
    blockers.push('shadow_only_live_blocked');
  } else if (policy.require_approval_note_for_live === true && !base.approval_note) {
    decision = 'hold';
    blockers.push('missing_live_approval_note');
  } else if (blockers.length) {
    decision = 'deny';
    result = 'blocked';
  } else {
    decision = 'execute';
  }

  const reversibleToken = decision === 'execute'
    ? `rvk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    : null;

  if (decision === 'hold') {
    holds[base.payout_id] = {
      provider: base.provider,
      amount_usd: base.amount_usd,
      recipient: base.recipient,
      approval_note: base.approval_note,
      blockers: blockers.slice(0),
      created_at: ts
    };
    persistHolds(policy.paths.holds, holds);
  }

  const payload = {
    ok: decision !== 'deny' || strict !== true,
    type: 'payment_skills_bridge',
    ts,
    ...base,
    decision,
    result,
    blockers,
    shadow_only: policy.shadow_only === true,
    require_approval_note_for_live: policy.require_approval_note_for_live === true,
    reversible_token: reversibleToken,
    holds_count: Object.keys(holds).length,
    state_path: relPath(policy.paths.state),
    history_path: relPath(policy.paths.history),
    holds_path: relPath(policy.paths.holds)
  };

  writeJsonAtomic(policy.paths.state, {
    schema_id: 'payment_skills_bridge',
    schema_version: '1.0',
    updated_at: ts,
    provider: base.provider,
    amount_usd: base.amount_usd,
    payout_id: base.payout_id,
    decision,
    result,
    blockers,
    reversible_token: reversibleToken,
    holds_count: Object.keys(holds).length
  });
  appendJsonl(policy.paths.history, payload);

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (strict && payload.ok !== true) process.exit(1);
}

function releaseHold(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const strict = toBool(args.strict, false);
  const payoutId = clean(args['payout-id'] || args.payout_id || args._[1] || '', 120);
  const approvalNote = clean(args['approval-note'] || args.approval_note || '', 240) || null;
  const holdsState = loadHolds(policy.paths.holds);
  const holds = holdsState.holds && typeof holdsState.holds === 'object' ? holdsState.holds : {};
  const held = payoutId ? holds[payoutId] : null;
  const blockers: string[] = [];
  if (!payoutId) blockers.push('missing_payout_id');
  if (!held) blockers.push('hold_not_found');
  if (policy.require_approval_note_for_live === true && !approvalNote) blockers.push('missing_live_approval_note');

  const decision = blockers.length ? 'deny' : 'execute';
  const reversibleToken = decision === 'execute'
    ? `rvk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    : null;
  if (decision === 'execute' && payoutId) {
    delete holds[payoutId];
    persistHolds(policy.paths.holds, holds);
  }

  const payload = {
    ok: decision === 'execute' || strict !== true,
    type: 'payment_skills_bridge_release',
    ts: nowIso(),
    payout_id: payoutId || null,
    decision,
    blockers,
    reversible_token: reversibleToken,
    approval_note: approvalNote,
    holds_count: Object.keys(holds).length,
    holds_path: relPath(policy.paths.holds)
  };
  appendJsonl(policy.paths.history, payload);
  writeJsonAtomic(policy.paths.state, {
    schema_id: 'payment_skills_bridge',
    schema_version: '1.0',
    updated_at: payload.ts,
    payout_id: payload.payout_id,
    decision: payload.decision,
    blockers: payload.blockers,
    reversible_token: payload.reversible_token,
    holds_count: payload.holds_count
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (strict && payload.ok !== true) process.exit(1);
}

function runNegotiation(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const strict = toBool(args.strict, false);
  const negotiationsState = loadNegotiations(policy.paths.negotiations);
  const negotiations = negotiationsState.negotiations && typeof negotiationsState.negotiations === 'object'
    ? negotiationsState.negotiations
    : {};
  if (policy.negotiation.enabled !== true) {
    const out = {
      ok: false,
      type: 'payment_skills_bridge_negotiate',
      error: 'negotiation_disabled'
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (strict) process.exit(1);
    return;
  }

  const dealId = clean(args['deal-id'] || args.deal_id || `deal_${Date.now().toString(36)}`, 120);
  const counterparty = clean(args.counterparty || '', 160) || null;
  const baseAmountUsd = Number(clampNumber(args['base-amount-usd'] ?? args.base_amount_usd, 0.01, 1_000_000_000, 0).toFixed(2));
  const offerAmountUsd = Number(clampNumber(args['offer-amount-usd'] ?? args.offer_amount_usd, 0.01, 1_000_000_000, 0).toFixed(2));
  const requestedProfile = normalizeToken(args.profile || policy.negotiation.default_profile, 40) || 'balanced';
  const profile = policy.negotiation.profiles[requestedProfile]
    || policy.negotiation.profiles[policy.negotiation.default_profile]
    || policy.negotiation.profiles.balanced;
  const round = Math.max(1, Math.min(12, Number(args.round || 1) || 1));
  const applyRequested = toBool(args.apply, false);
  const approvalNote = clean(args['approval-note'] || args.approval_note || '', 240) || null;

  const blockers = [];
  if (!dealId) blockers.push('deal_id_required');
  if (!counterparty) blockers.push('counterparty_required');
  if (baseAmountUsd <= 0 || offerAmountUsd <= 0) blockers.push('amount_required');
  if (!profile || typeof profile !== 'object') blockers.push('profile_not_found');

  let mode = 'shadow';
  if (applyRequested && policy.shadow_only === true) {
    blockers.push('shadow_only_live_blocked');
  } else if (applyRequested) {
    mode = 'live';
  }
  if (mode === 'live' && policy.require_approval_note_for_live === true && !approvalNote) {
    blockers.push('missing_live_approval_note');
  }

  const ratio = baseAmountUsd > 0 ? (offerAmountUsd / baseAmountUsd) : 0;
  const discountRatio = baseAmountUsd > 0 ? ((baseAmountUsd - offerAmountUsd) / baseAmountUsd) : 1;
  let decision = 'counter_offer';
  let recommendationUsd = baseAmountUsd;
  if (round > Number(profile.max_rounds || 3)) {
    decision = 'reject';
  } else if (ratio >= Number(profile.auto_accept_ratio || 1)) {
    decision = 'accept';
    recommendationUsd = offerAmountUsd;
  } else if (ratio >= Number(profile.min_accept_ratio || 0.9)) {
    decision = 'accept';
    recommendationUsd = offerAmountUsd;
  } else if (discountRatio > Number(profile.max_discount_ratio || 0.15)) {
    decision = 'reject';
  } else {
    decision = 'counter_offer';
    const floor = baseAmountUsd * (1 - Number(profile.max_discount_ratio || 0.15));
    recommendationUsd = Number((((offerAmountUsd + floor) / 2)).toFixed(2));
  }
  if (blockers.length) decision = 'hold';

  const out = {
    ok: decision !== 'hold' && decision !== 'reject' || strict !== true,
    type: 'payment_skills_bridge_negotiate',
    ts: nowIso(),
    deal_id: dealId,
    counterparty,
    profile: requestedProfile,
    round,
    base_amount_usd: baseAmountUsd,
    offer_amount_usd: offerAmountUsd,
    ratio: Number(ratio.toFixed(6)),
    discount_ratio: Number(discountRatio.toFixed(6)),
    recommendation_amount_usd: Number(recommendationUsd.toFixed(2)),
    decision,
    mode,
    blockers,
    approval_note: approvalNote,
    apply_requested: applyRequested
  };

  if (!negotiations[dealId] || typeof negotiations[dealId] !== 'object') {
    negotiations[dealId] = {
      deal_id: dealId,
      counterparty,
      profile: requestedProfile,
      rounds: []
    };
  }
  negotiations[dealId].counterparty = counterparty;
  negotiations[dealId].profile = requestedProfile;
  negotiations[dealId].last_decision = decision;
  negotiations[dealId].last_round = round;
  negotiations[dealId].updated_at = out.ts;
  const rounds = Array.isArray(negotiations[dealId].rounds) ? negotiations[dealId].rounds : [];
  rounds.push({
    ts: out.ts,
    round,
    offer_amount_usd: offerAmountUsd,
    ratio: out.ratio,
    decision,
    recommendation_amount_usd: out.recommendation_amount_usd,
    mode,
    blockers
  });
  negotiations[dealId].rounds = rounds.slice(-24);
  persistNegotiations(policy.paths.negotiations, negotiations);

  appendJsonl(policy.paths.history, {
    ...out,
    negotiations_path: relPath(policy.paths.negotiations)
  });
  writeJsonAtomic(policy.paths.state, {
    schema_id: 'payment_skills_bridge',
    schema_version: '1.0',
    updated_at: out.ts,
    deal_id: dealId,
    decision,
    round,
    profile: requestedProfile,
    recommendation_amount_usd: out.recommendation_amount_usd,
    blockers,
    negotiations_count: Object.keys(negotiations).length
  });
  process.stdout.write(`${JSON.stringify({
    ...out,
    negotiations_count: Object.keys(negotiations).length,
    negotiations_path: relPath(policy.paths.negotiations),
    state_path: relPath(policy.paths.state)
  }, null, 2)}\n`);
  if (strict && out.ok !== true) process.exit(1);
}

function statusBridge(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const payload = readJson(policy.paths.state, null);
  const holds = loadHolds(policy.paths.holds);
  const negotiations = loadNegotiations(policy.paths.negotiations);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'payment_skills_bridge_status',
    ts: nowIso(),
    available: !!payload,
    policy_path: relPath(policyPath),
    state_path: relPath(policy.paths.state),
    history_path: relPath(policy.paths.history),
    holds_path: relPath(policy.paths.holds),
    negotiations_path: relPath(policy.paths.negotiations),
    holds_count: Object.keys(holds.holds || {}).length,
    negotiations_count: Object.keys(negotiations.negotiations || {}).length,
    payload: payload && typeof payload === 'object' ? payload : null
  }, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/workflow/payment_skills_bridge.js payout --provider=stripe --amount-usd=10 --recipient=user_123 [--apply=1] [--approval-note=\"...\"]');
  console.log('  node systems/workflow/payment_skills_bridge.js release --payout-id=<id> --approval-note=\"...\"');
  console.log('  node systems/workflow/payment_skills_bridge.js negotiate --deal-id=<id> --counterparty=<id> --base-amount-usd=<n> --offer-amount-usd=<n> [--profile=<id>] [--round=<n>] [--apply=1] [--approval-note=\"...\"]');
  console.log('  node systems/workflow/payment_skills_bridge.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'payout', 24) || 'payout';
  if (cmd === 'payout' || cmd === 'run') {
    runPayout(args);
    return;
  }
  if (cmd === 'release') {
    releaseHold(args);
    return;
  }
  if (cmd === 'negotiate') {
    runNegotiation(args);
    return;
  }
  if (cmd === 'status' || cmd === 'latest') {
    statusBridge(args);
    return;
  }
  usage();
  process.exit(2);
}

main();
