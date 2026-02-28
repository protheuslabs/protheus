#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/storm/storm_value_distribution.js
 *
 * V3-ATTR-002: Storm Value Distribution Layer
 * - Consumes attribution records + creator opt-in preferences.
 * - Produces auditable, reversible payout plans (royalty/donation/hybrid).
 * - Constitution-governed and shadow-first by default.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { evaluateTask: evaluateDirectiveTask } = require('../security/directive_gate.js');
const { appendAction } = require('../security/agent_passport.js');
const { writeContractReceipt } = require('../../lib/action_receipts.js');
const { loadIndex: loadCreatorIndex, recordContribution } = require('./creator_optin_ledger.js');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.STORM_VALUE_DISTRIBUTION_POLICY_PATH
  ? path.resolve(process.env.STORM_VALUE_DISTRIBUTION_POLICY_PATH)
  : path.join(ROOT, 'config', 'storm_value_distribution_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/storm/storm_value_distribution.js plan [--run-id=<id>] [--objective-id=<id>] [--days=N] [--pool-usd=N] [--apply=1|0] [--policy=path]');
  console.log('  node systems/storm/storm_value_distribution.js reverse --distribution-id=<id> [--reason="..."] [--policy=path]');
  console.log('  node systems/storm/storm_value_distribution.js status [latest|<distribution_id>] [--policy=path]');
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

function cleanText(v: unknown, maxLen = 260) {
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

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function roundTo(n: unknown, digits = 6) {
  const value = Number(n);
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** Math.max(0, Math.min(8, digits));
  return Math.round(value * factor) / factor;
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

function sha16(seed: string) {
  return crypto.createHash('sha256').update(String(seed || ''), 'utf8').digest('hex').slice(0, 16);
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const text = cleanText(raw, 500);
  if (!text) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(text) ? text : path.join(ROOT, text);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    allow_apply: false,
    governance: {
      constitution_gate_enabled: true,
      block_on_constitution_deny: true
    },
    inputs: {
      attribution_records_path: 'state/assimilation/value_attribution/records.jsonl',
      creator_index_policy_path: 'config/creator_optin_ledger_policy.json'
    },
    distribution: {
      default_pool_usd: 100,
      min_payout_usd: 0.01,
      max_creators_per_plan: 1000,
      allowed_modes: ['royalty', 'donation', 'hybrid']
    },
    sovereign_root_tithe: {
      enabled: true,
      tithe_bps: 1000,
      root_creator_id: 'jay_sovereign_root',
      root_wallet_alias: 'jay_root_wallet',
      root_payout_mode: 'royalty',
      enforce_from_attribution: true,
      fail_closed_on_mismatch: true
    },
    state: {
      root: 'state/storm/value_distribution',
      plans_dir: 'state/storm/value_distribution/plans',
      latest_path: 'state/storm/value_distribution/latest.json',
      history_path: 'state/storm/value_distribution/history.jsonl',
      reversals_path: 'state/storm/value_distribution/reversals.jsonl',
      receipts_path: 'state/storm/value_distribution/receipts.jsonl'
    },
    passport: {
      enabled: true,
      source: 'storm_value_distribution'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const governance = raw.governance && typeof raw.governance === 'object' ? raw.governance : {};
  const inputs = raw.inputs && typeof raw.inputs === 'object' ? raw.inputs : {};
  const distribution = raw.distribution && typeof raw.distribution === 'object' ? raw.distribution : {};
  const sovereignRootTithe = raw.sovereign_root_tithe && typeof raw.sovereign_root_tithe === 'object'
    ? raw.sovereign_root_tithe
    : {};
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  const passport = raw.passport && typeof raw.passport === 'object' ? raw.passport : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    allow_apply: toBool(raw.allow_apply, base.allow_apply),
    governance: {
      constitution_gate_enabled: toBool(governance.constitution_gate_enabled, base.governance.constitution_gate_enabled),
      block_on_constitution_deny: toBool(governance.block_on_constitution_deny, base.governance.block_on_constitution_deny)
    },
    inputs: {
      attribution_records_path: resolvePath(inputs.attribution_records_path || base.inputs.attribution_records_path, base.inputs.attribution_records_path),
      creator_index_policy_path: resolvePath(inputs.creator_index_policy_path || base.inputs.creator_index_policy_path, base.inputs.creator_index_policy_path)
    },
    distribution: {
      default_pool_usd: clampNumber(distribution.default_pool_usd, 0, 1_000_000_000, base.distribution.default_pool_usd),
      min_payout_usd: clampNumber(distribution.min_payout_usd, 0, 1_000_000, base.distribution.min_payout_usd),
      max_creators_per_plan: clampInt(distribution.max_creators_per_plan, 1, 100000, base.distribution.max_creators_per_plan),
      allowed_modes: Array.isArray(distribution.allowed_modes)
        ? distribution.allowed_modes.map((row: unknown) => normalizeToken(row, 40)).filter(Boolean)
        : base.distribution.allowed_modes
    },
    sovereign_root_tithe: {
      enabled: toBool(sovereignRootTithe.enabled, base.sovereign_root_tithe.enabled),
      tithe_bps: clampInt(sovereignRootTithe.tithe_bps, 0, 10000, base.sovereign_root_tithe.tithe_bps),
      root_creator_id: normalizeToken(
        sovereignRootTithe.root_creator_id || base.sovereign_root_tithe.root_creator_id,
        180
      ) || base.sovereign_root_tithe.root_creator_id,
      root_wallet_alias: cleanText(
        sovereignRootTithe.root_wallet_alias || base.sovereign_root_tithe.root_wallet_alias,
        160
      ) || base.sovereign_root_tithe.root_wallet_alias,
      root_payout_mode: normalizeToken(
        sovereignRootTithe.root_payout_mode || base.sovereign_root_tithe.root_payout_mode,
        40
      ) || base.sovereign_root_tithe.root_payout_mode,
      enforce_from_attribution: toBool(
        sovereignRootTithe.enforce_from_attribution,
        base.sovereign_root_tithe.enforce_from_attribution
      ),
      fail_closed_on_mismatch: toBool(
        sovereignRootTithe.fail_closed_on_mismatch,
        base.sovereign_root_tithe.fail_closed_on_mismatch
      )
    },
    state: {
      root: resolvePath(state.root || base.state.root, base.state.root),
      plans_dir: resolvePath(state.plans_dir || base.state.plans_dir, base.state.plans_dir),
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      history_path: resolvePath(state.history_path || base.state.history_path, base.state.history_path),
      reversals_path: resolvePath(state.reversals_path || base.state.reversals_path, base.state.reversals_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path)
    },
    passport: {
      enabled: toBool(passport.enabled, base.passport.enabled),
      source: normalizeToken(passport.source || base.passport.source, 120) || base.passport.source
    }
  };
}

function evaluateConstitutionGate(policy: AnyObj, details: AnyObj = {}) {
  if (policy.governance.constitution_gate_enabled !== true) {
    return { decision: 'ALLOW', risk: 'low', reasons: ['constitution_gate_disabled'] };
  }
  const task = `storm value distribution for objective ${cleanText(details.objective_id || 'none', 120)} pool ${cleanText(details.pool_usd || '0', 32)}`;
  try {
    const out = evaluateDirectiveTask(task);
    return out && typeof out === 'object'
      ? out
      : { decision: 'ALLOW', risk: 'low', reasons: ['constitution_gate_unavailable'] };
  } catch {
    return { decision: 'ALLOW', risk: 'low', reasons: ['constitution_gate_error'] };
  }
}

function loadCreatorMap(policy: AnyObj) {
  const creatorPolicy = readJson(policy.inputs.creator_index_policy_path, {});
  const creatorIndexPath = creatorPolicy && creatorPolicy.state && creatorPolicy.state.index_path
    ? resolvePath(creatorPolicy.state.index_path, 'state/storm/creator_optin/index.json')
    : path.join(ROOT, 'state', 'storm', 'creator_optin', 'index.json');
  const index = readJson(creatorIndexPath, { creators: {} });
  const creators = index && index.creators && typeof index.creators === 'object' ? index.creators : {};
  return creators;
}

function buildPlan(args: AnyObj = {}, opts: AnyObj = {}) {
  const policyPath = opts.policy
    ? resolvePath(opts.policy, 'config/storm_value_distribution_policy.json')
    : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (policy.enabled !== true) {
    return { ok: false, type: 'storm_value_distribution_plan', error: 'policy_disabled' };
  }

  const applyRequested = toBool(opts.apply != null ? opts.apply : args.apply, false);
  const applyExecuted = applyRequested && policy.allow_apply === true && policy.shadow_only !== true;
  const shadowOnly = policy.shadow_only === true || !applyExecuted;

  const poolUsd = clampNumber(args.pool_usd != null ? args.pool_usd : policy.distribution.default_pool_usd, 0, 1_000_000_000, policy.distribution.default_pool_usd);
  const days = clampInt(args.days, 1, 3650, 30);
  const sinceTs = Date.now() - days * 24 * 60 * 60 * 1000;
  const runFilter = normalizeToken(args.run_id || '', 160) || null;
  const objectiveFilter = normalizeToken(args.objective_id || '', 180) || null;

  const constitution = evaluateConstitutionGate(policy, {
    objective_id: objectiveFilter,
    pool_usd: poolUsd
  });
  const constitutionBlocked = policy.governance.block_on_constitution_deny === true && constitution.decision === 'DENY';

  const attributionRows = readJsonl(policy.inputs.attribution_records_path)
    .filter((row: AnyObj) => {
      const ts = Date.parse(String(row && row.ts || ''));
      if (Number.isFinite(ts) && ts < sinceTs) return false;
      const runId = normalizeToken(row && row.provenance && row.provenance.context && row.provenance.context.run_id || '', 160) || null;
      const objectiveId = normalizeToken(row && row.provenance && row.provenance.context && row.provenance.context.objective_id || '', 180) || null;
      if (runFilter && runFilter !== runId) return false;
      if (objectiveFilter && objectiveFilter !== objectiveId) return false;
      return true;
    });

  const rootConfig = policy.sovereign_root_tithe || {};
  const rootCreatorId = normalizeToken(rootConfig.root_creator_id || 'jay_sovereign_root', 180) || 'jay_sovereign_root';
  const rootWalletAlias = cleanText(rootConfig.root_wallet_alias || 'jay_root_wallet', 160) || 'jay_root_wallet';
  const rootMode = policy.distribution.allowed_modes.includes(String(rootConfig.root_payout_mode || 'royalty'))
    ? String(rootConfig.root_payout_mode)
    : 'royalty';
  const rootTitheViolations: string[] = [];
  const observedTitheBpsSet = new Set<number>();
  for (const row of attributionRows) {
    const rowTithe = row && row.provenance && row.provenance.economic && row.provenance.economic.sovereign_root_tithe
      ? row.provenance.economic.sovereign_root_tithe
      : (row && row.sovereign_root_tithe ? row.sovereign_root_tithe : null);
    if (!rowTithe || typeof rowTithe !== 'object') continue;
    if (toBool(rowTithe.enabled, false) !== true) continue;
    const rowBps = clampInt(rowTithe.tithe_bps, 0, 10000, -1);
    if (rowBps >= 0) observedTitheBpsSet.add(rowBps);
  }

  const observedTitheBps = observedTitheBpsSet.size === 1 ? Array.from(observedTitheBpsSet)[0] : null;
  if (rootConfig.enforce_from_attribution === true && observedTitheBpsSet.size > 1) {
    rootTitheViolations.push('root_tithe_bps_mismatch_across_attribution_records');
  }
  if (rootConfig.enabled !== true && observedTitheBpsSet.size > 0) {
    rootTitheViolations.push('root_tithe_disabled_but_required_by_attribution');
  }

  const effectiveTitheBps = rootConfig.enabled === true
    ? (observedTitheBps != null && rootConfig.enforce_from_attribution === true
      ? observedTitheBps
      : clampInt(rootConfig.tithe_bps, 0, 10000, 1000))
    : 0;
  if (rootConfig.enabled === true && observedTitheBps != null && observedTitheBps !== effectiveTitheBps) {
    rootTitheViolations.push('root_tithe_bps_policy_mismatch');
  }

  const rootTitheUsd = rootConfig.enabled === true
    ? roundTo((poolUsd * effectiveTitheBps) / 10000, 6)
    : 0;
  const creatorPoolUsd = roundTo(Math.max(0, poolUsd - rootTitheUsd), 6);
  if (rootConfig.enabled === true && rootTitheUsd <= 0 && poolUsd > 0) {
    rootTitheViolations.push('root_tithe_zero_for_positive_pool');
  }
  if (creatorPoolUsd < 0 || rootTitheUsd > poolUsd) {
    rootTitheViolations.push('root_tithe_exceeds_pool');
  }

  const creators = loadCreatorMap(policy);
  const aggregate: Record<string, AnyObj> = {};
  for (const row of attributionRows) {
    const creatorId = normalizeToken(row && row.provenance && row.provenance.creator && row.provenance.creator.creator_id || '', 180) || null;
    if (!creatorId) continue;
    if (creatorId === rootCreatorId) continue; // Root tithe is enforced separately; do not double-count.
    const creator = creators[creatorId] || null;
    if (!creator || creator.opted_in !== true) continue;

    const influence = clampNumber(row && row.provenance && row.provenance.valuation && row.provenance.valuation.influence_score, 0, 1, 0);
    const weight = clampNumber(row && row.provenance && row.provenance.valuation && row.provenance.valuation.weight, 0, 1000, 1);
    const score = Number((influence * weight).toFixed(6));
    if (score <= 0) continue;

    if (!aggregate[creatorId]) {
      aggregate[creatorId] = {
        creator_id: creatorId,
        payout_mode: normalizeToken(creator.payout_mode || 'royalty', 40) || 'royalty',
        donation_target: cleanText(creator.donation_target || '', 240) || null,
        score: 0,
        attribution_ids: [],
        objective_ids: new Set<string>(),
        run_ids: new Set<string>()
      };
    }
    aggregate[creatorId].score = Number((aggregate[creatorId].score + score).toFixed(6));
    aggregate[creatorId].attribution_ids.push(String(row.attribution_id || ''));
    const objectiveId = normalizeToken(row && row.provenance && row.provenance.context && row.provenance.context.objective_id || '', 180);
    if (objectiveId) aggregate[creatorId].objective_ids.add(objectiveId);
    const runId = normalizeToken(row && row.provenance && row.provenance.context && row.provenance.context.run_id || '', 160);
    if (runId) aggregate[creatorId].run_ids.add(runId);
  }

  const creatorRows = Object.values(aggregate)
    .sort((a: AnyObj, b: AnyObj) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, policy.distribution.max_creators_per_plan);
  const totalScore = creatorRows.reduce((sum: number, row: AnyObj) => sum + Number(row.score || 0), 0);

  const payouts: AnyObj[] = [];
  for (const row of creatorRows) {
    const share = totalScore > 0 ? Number(row.score || 0) / totalScore : 0;
    const amount = roundTo(creatorPoolUsd * share, 6);
    if (amount < Number(policy.distribution.min_payout_usd || 0)) continue;
    const mode = policy.distribution.allowed_modes.includes(String(row.payout_mode || ''))
      ? String(row.payout_mode)
      : 'royalty';
    payouts.push({
      creator_id: row.creator_id,
      mode,
      donation_target: row.donation_target,
      amount_usd: amount,
      share: Number(share.toFixed(6)),
      score: Number(row.score || 0),
      attribution_ids: row.attribution_ids.slice(0, 2048),
      objective_ids: Array.from(row.objective_ids),
      run_ids: Array.from(row.run_ids)
    });
  }

  if (rootConfig.enabled === true) {
    payouts.unshift({
      creator_id: rootCreatorId,
      mode: rootMode,
      donation_target: null,
      amount_usd: rootTitheUsd,
      share: poolUsd > 0 ? roundTo(rootTitheUsd / poolUsd, 6) : 0,
      score: null,
      attribution_ids: [],
      objective_ids: objectiveFilter ? [objectiveFilter] : [],
      run_ids: runFilter ? [runFilter] : [],
      is_sovereign_root_tithe: true,
      wallet_alias: rootWalletAlias,
      effective_tithe_bps: effectiveTitheBps
    });
  }

  const allocatedCreatorPoolUsd = roundTo(
    payouts
      .filter((row: AnyObj) => !(row && row.is_sovereign_root_tithe === true))
      .reduce((sum: number, row: AnyObj) => sum + Number(row && row.amount_usd || 0), 0),
    6
  );
  const creatorPoolResidualUsd = roundTo(Math.max(0, creatorPoolUsd - allocatedCreatorPoolUsd), 6);
  if (creatorPoolResidualUsd > Number(policy.distribution.min_payout_usd || 0.01)) {
    payouts.push({
      creator_id: rootCreatorId,
      mode: rootMode,
      donation_target: null,
      amount_usd: creatorPoolResidualUsd,
      share: poolUsd > 0 ? roundTo(creatorPoolResidualUsd / poolUsd, 6) : 0,
      score: null,
      attribution_ids: [],
      objective_ids: objectiveFilter ? [objectiveFilter] : [],
      run_ids: runFilter ? [runFilter] : [],
      is_creator_pool_residual: true,
      wallet_alias: rootWalletAlias
    });
  }

  const payoutTotalUsd = roundTo(
    payouts.reduce((sum: number, row: AnyObj) => sum + Number(row && row.amount_usd || 0), 0),
    6
  );
  const payoutDeltaUsd = roundTo(poolUsd - payoutTotalUsd, 6);
  if (Math.abs(payoutDeltaUsd) > 0.01) {
    rootTitheViolations.push('payout_sum_mismatch');
  }

  const rootTitheBlocked = rootConfig.fail_closed_on_mismatch === true && rootTitheViolations.length > 0;
  const planBlocked = constitutionBlocked || rootTitheBlocked;

  const distributionId = normalizeToken(args.distribution_id || '', 180)
    || `svd_${sha16(`${nowIso()}|${runFilter || 'all'}|${objectiveFilter || 'all'}|${poolUsd}`)}`;
  const plan = {
    ok: true,
    type: 'storm_value_distribution_plan',
    ts: nowIso(),
    distribution_id: distributionId,
    policy_version: policy.version,
    policy_path: relPath(policyPath),
    shadow_only: shadowOnly,
    apply_requested: applyRequested,
    apply_executed: applyExecuted,
    constitution,
    constitution_blocked: constitutionBlocked,
    root_tithe: {
      enabled: rootConfig.enabled === true,
      blocked: rootTitheBlocked,
      reason_codes: rootTitheViolations,
      root_creator_id: rootCreatorId,
      root_wallet_alias: rootWalletAlias,
      effective_tithe_bps: effectiveTitheBps,
      root_tithe_usd: rootTitheUsd,
      creator_pool_usd: creatorPoolUsd,
      creator_pool_allocated_usd: allocatedCreatorPoolUsd,
      creator_pool_residual_usd: creatorPoolResidualUsd,
      observed_tithe_bps: observedTitheBps,
      observed_tithe_bps_count: observedTitheBpsSet.size
    },
    scope: {
      days,
      run_id: runFilter,
      objective_id: objectiveFilter
    },
    pool_usd: poolUsd,
    payout_total_usd: payoutTotalUsd,
    payout_delta_usd: payoutDeltaUsd,
    attribution_records_considered: attributionRows.length,
    creators_considered: creatorRows.length,
    payouts,
    status: planBlocked ? 'blocked' : (shadowOnly ? 'shadow_only' : 'applied')
  };

  const planPath = path.join(policy.state.plans_dir, `${distributionId}.json`);
  writeJsonAtomic(planPath, plan);
  writeJsonAtomic(policy.state.latest_path, plan);
  appendJsonl(policy.state.history_path, plan);

  const receipt = writeContractReceipt(policy.state.receipts_path, {
    ts: plan.ts,
    type: 'storm_value_distribution_plan',
    objective_id: objectiveFilter,
    status: plan.status,
    summary: `distribution=${distributionId};payouts=${payouts.length};pool=${poolUsd}`,
    distribution_id: distributionId,
    creator_count: payouts.length,
    pool_usd: poolUsd,
    constitution_decision: constitution.decision,
    root_tithe_bps: effectiveTitheBps,
    root_tithe_usd: rootTitheUsd,
    root_tithe_blocked: rootTitheBlocked
  }, {
    attempted: true,
    verified: shadowOnly !== true && planBlocked !== true
  });

  let passportLink = null;
  if (policy.passport.enabled === true) {
    const linked = appendAction({
      source: policy.passport.source,
      action: {
        action_type: 'storm_value_distribution_plan',
        objective_id: objectiveFilter,
        target: distributionId,
        status: plan.status,
        attempted: true,
        verified: shadowOnly !== true && planBlocked !== true,
        metadata: {
          payout_count: payouts.length,
          pool_usd: poolUsd,
          constitution_decision: constitution.decision,
          root_tithe_bps: effectiveTitheBps,
          root_tithe_usd: rootTitheUsd,
          root_tithe_blocked: rootTitheBlocked
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

  // Feed contribution maturity back into creator ledger.
  for (const payout of payouts) {
    if (payout && (payout.is_sovereign_root_tithe === true || payout.is_creator_pool_residual === true)) continue;
    recordContribution({
      creator_id: payout.creator_id,
      influence: clampNumber(payout.share, 0, 1, 0),
      weight: clampNumber(payout.score, 0, 1000, 0),
      source_id: distributionId
    }, {
      policy: policy.inputs.creator_index_policy_path
    });
  }

  return {
    ...plan,
    plan_path: relPath(planPath),
    latest_path: relPath(policy.state.latest_path),
    receipt_integrity: receipt && receipt.receipt_contract && receipt.receipt_contract.integrity
      ? receipt.receipt_contract.integrity
      : null,
    passport_link: passportLink
  };
}

function reversePlan(args: AnyObj = {}, opts: AnyObj = {}) {
  const policyPath = opts.policy
    ? resolvePath(opts.policy, 'config/storm_value_distribution_policy.json')
    : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const distributionId = normalizeToken(args.distribution_id || '', 180);
  if (!distributionId) {
    return { ok: false, type: 'storm_value_distribution_reverse', error: 'distribution_id_required' };
  }

  const planPath = path.join(policy.state.plans_dir, `${distributionId}.json`);
  const plan = readJson(planPath, null);
  if (!plan || typeof plan !== 'object') {
    return { ok: false, type: 'storm_value_distribution_reverse', error: 'distribution_not_found', distribution_id: distributionId };
  }

  if (plan.status === 'reversed') {
    return { ok: true, type: 'storm_value_distribution_reverse', distribution_id: distributionId, already_reversed: true };
  }

  const reversal = {
    ts: nowIso(),
    type: 'storm_value_distribution_reversal',
    distribution_id: distributionId,
    reason: cleanText(args.reason || 'manual_reversal', 280) || 'manual_reversal',
    prior_status: String(plan.status || 'unknown'),
    shadow_only: policy.shadow_only === true
  };
  appendJsonl(policy.state.reversals_path, reversal);
  appendJsonl(policy.state.history_path, reversal);

  plan.status = 'reversed';
  plan.reversal = reversal;
  writeJsonAtomic(planPath, plan);
  writeJsonAtomic(policy.state.latest_path, plan);

  const receipt = writeContractReceipt(policy.state.receipts_path, {
    ts: reversal.ts,
    type: 'storm_value_distribution_reversal',
    status: 'reversed',
    summary: `distribution=${distributionId};reason=${reversal.reason}`,
    distribution_id: distributionId,
    reason: reversal.reason
  }, {
    attempted: true,
    verified: policy.shadow_only !== true
  });

  let passportLink = null;
  if (policy.passport.enabled === true) {
    const linked = appendAction({
      source: policy.passport.source,
      action: {
        action_type: 'storm_value_distribution_reversal',
        target: distributionId,
        status: 'reversed',
        attempted: true,
        verified: policy.shadow_only !== true,
        metadata: {
          reason: reversal.reason
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
    ok: true,
    type: 'storm_value_distribution_reverse',
    distribution_id: distributionId,
    reversal,
    shadow_only: policy.shadow_only === true,
    receipt_integrity: receipt && receipt.receipt_contract && receipt.receipt_contract.integrity
      ? receipt.receipt_contract.integrity
      : null,
    passport_link: passportLink
  };
}

function status(args: AnyObj = {}, opts: AnyObj = {}) {
  const policyPath = opts.policy
    ? resolvePath(opts.policy, 'config/storm_value_distribution_policy.json')
    : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const target = normalizeToken(args.target || '', 180) || 'latest';
  const payload = target === 'latest'
    ? readJson(policy.state.latest_path, null)
    : readJson(path.join(policy.state.plans_dir, `${target}.json`), null);

  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      type: 'storm_value_distribution_status',
      error: 'status_missing',
      target
    };
  }

  return {
    ok: true,
    type: 'storm_value_distribution_status',
    distribution_id: payload.distribution_id || null,
    status: payload.status || null,
    shadow_only: payload.shadow_only === true,
    payouts: Array.isArray(payload.payouts) ? payload.payouts.length : 0,
    pool_usd: Number(payload.pool_usd || 0),
    attribution_records_considered: Number(payload.attribution_records_considered || 0),
    latest_path: relPath(policy.state.latest_path)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help === true) {
    usage();
    return;
  }

  if (cmd === 'plan') {
    const out = buildPlan({
      run_id: args.run_id || args['run-id'],
      objective_id: args.objective_id || args['objective-id'],
      days: args.days,
      pool_usd: args.pool_usd || args['pool-usd'],
      apply: args.apply
    }, { policy: args.policy, apply: args.apply });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(out.ok ? 0 : 1);
    return;
  }

  if (cmd === 'reverse') {
    const out = reversePlan({
      distribution_id: args.distribution_id || args['distribution-id'],
      reason: args.reason
    }, { policy: args.policy });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(out.ok ? 0 : 1);
    return;
  }

  if (cmd === 'status') {
    const out = status({ target: args._[1] || 'latest' }, { policy: args.policy });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(out.ok ? 0 : 1);
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
  buildPlan,
  reversePlan,
  status
};
