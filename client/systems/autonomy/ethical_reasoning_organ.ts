#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/autonomy/ethical_reasoning_organ.js
 *
 * V2-061: Deep ethical reasoning + value evolution layer.
 * Integrates with Weaver + Mirror outputs to produce auditable tradeoff receipts,
 * monoculture correction suggestions, and maturity-gated value-prior updates.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.ETHICAL_REASONING_POLICY_PATH
  ? path.resolve(process.env.ETHICAL_REASONING_POLICY_PATH)
  : path.join(ROOT, 'config', 'ethical_reasoning_policy.json');

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
    const raw = String(token || '');
    if (!raw.startsWith('--')) {
      out._.push(raw);
      continue;
    }
    const idx = raw.indexOf('=');
    if (idx < 0) out[raw.slice(2)] = true;
    else out[raw.slice(2, idx)] = raw.slice(idx + 1);
  }
  return out;
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

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function sha10(seed: string) {
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 10);
}

function runtimePaths(policyPath: string, policy: AnyObj) {
  const stateDir = process.env.ETHICAL_REASONING_STATE_DIR
    ? path.resolve(process.env.ETHICAL_REASONING_STATE_DIR)
    : path.join(ROOT, 'state', 'autonomy', 'ethical_reasoning');
  const integration = policy && policy.integration && typeof policy.integration === 'object'
    ? policy.integration
    : {};
  const resolvePath = (raw: unknown, fallback: string) => {
    const txt = cleanText(raw || fallback, 320);
    if (path.isAbsolute(txt)) return txt;
    return path.join(ROOT, txt);
  };
  return {
    policy_path: policyPath,
    state_dir: stateDir,
    latest_path: path.join(stateDir, 'latest.json'),
    history_path: path.join(stateDir, 'history.jsonl'),
    receipts_path: path.join(stateDir, 'tradeoff_receipts.jsonl'),
    priors_state_path: path.join(stateDir, 'value_priors.json'),
    weaver_latest_path: resolvePath(integration.weaver_latest_path, 'state/autonomy/weaver/latest.json'),
    mirror_latest_path: resolvePath(integration.mirror_latest_path, 'state/autonomy/mirror_organ/latest.json')
  };
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    thresholds: {
      monoculture_warn_share: 0.68,
      high_impact_share: 0.72,
      maturity_min_for_prior_updates: 0.65,
      mirror_pressure_warn: 0.55
    },
    value_priors: {
      adaptive_value: 0.2,
      user_value: 0.2,
      quality: 0.2,
      learning: 0.2,
      delivery: 0.2
    },
    max_prior_delta_per_run: 0.03,
    integration: {
      weaver_latest_path: 'state/autonomy/weaver/latest.json',
      mirror_latest_path: 'state/autonomy/mirror_organ/latest.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const thresholds = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const priorsRaw = raw.value_priors && typeof raw.value_priors === 'object' ? raw.value_priors : {};
  const priors: AnyObj = {};
  for (const [kRaw, vRaw] of Object.entries(priorsRaw)) {
    const key = normalizeToken(kRaw, 80);
    if (!key) continue;
    priors[key] = clampNumber(vRaw, 0, 1, 0);
  }
  const integration = raw.integration && typeof raw.integration === 'object' ? raw.integration : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    thresholds: {
      monoculture_warn_share: clampNumber(
        thresholds.monoculture_warn_share,
        0.3,
        0.99,
        base.thresholds.monoculture_warn_share
      ),
      high_impact_share: clampNumber(
        thresholds.high_impact_share,
        0.3,
        0.99,
        base.thresholds.high_impact_share
      ),
      maturity_min_for_prior_updates: clampNumber(
        thresholds.maturity_min_for_prior_updates,
        0,
        1,
        base.thresholds.maturity_min_for_prior_updates
      ),
      mirror_pressure_warn: clampNumber(
        thresholds.mirror_pressure_warn,
        0,
        1,
        base.thresholds.mirror_pressure_warn
      )
    },
    value_priors: Object.keys(priors).length ? priors : { ...base.value_priors },
    max_prior_delta_per_run: clampNumber(
      raw.max_prior_delta_per_run,
      0.001,
      0.2,
      base.max_prior_delta_per_run
    ),
    integration: {
      weaver_latest_path: cleanText(integration.weaver_latest_path || base.integration.weaver_latest_path, 320),
      mirror_latest_path: cleanText(integration.mirror_latest_path || base.integration.mirror_latest_path, 320)
    }
  };
}

function normalizeAllocations(rows: unknown) {
  const out: AnyObj[] = [];
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = raw && typeof raw === 'object' ? raw as AnyObj : {};
    const metricId = normalizeToken(row.metric_id || '', 80);
    if (!metricId) continue;
    out.push({
      metric_id: metricId,
      value_currency: normalizeToken(row.value_currency || '', 80) || 'adaptive_value',
      share: clampNumber(row.share, 0, 1, 0),
      raw_score: clampNumber(row.raw_score, -10, 10, 0)
    });
  }
  return out.sort((a, b) => Number(b.share || 0) - Number(a.share || 0));
}

function loadPriors(filePath: string, fallback: AnyObj) {
  const src = readJson(filePath, null);
  if (!src || typeof src !== 'object' || !src.priors || typeof src.priors !== 'object') {
    return { ...fallback };
  }
  const out: AnyObj = {};
  for (const [kRaw, vRaw] of Object.entries(src.priors)) {
    const key = normalizeToken(kRaw, 80);
    if (!key) continue;
    out[key] = clampNumber(vRaw, 0, 1, 0);
  }
  return Object.keys(out).length ? out : { ...fallback };
}

function normalizePriors(priors: AnyObj) {
  const keys = Object.keys(priors || {});
  if (!keys.length) return {};
  const sum = keys.reduce((acc, key) => acc + clampNumber(priors[key], 0, 1, 0), 0);
  if (sum <= 0) {
    const even = Number((1 / keys.length).toFixed(6));
    const out: AnyObj = {};
    for (const key of keys) out[key] = even;
    return out;
  }
  const out: AnyObj = {};
  for (const key of keys) {
    out[key] = Number((clampNumber(priors[key], 0, 1, 0) / sum).toFixed(6));
  }
  return out;
}

function evaluateEthics(input: AnyObj, policy: AnyObj, priorState: AnyObj) {
  const allocations = normalizeAllocations(
    input
    && input.weaver_payload
    && input.weaver_payload.value_context
    && input.weaver_payload.value_context.allocations
  );
  const top = allocations[0] || null;
  const topShare = clampNumber(top && top.share, 0, 1, 0);
  const mirrorPressure = clampNumber(
    input
    && input.mirror_payload
    && input.mirror_payload.pressure_score,
    0,
    1,
    0
  );
  const maturityScore = clampNumber(
    input && input.maturity_score,
    0,
    1,
    0.5
  );
  const reasons: string[] = [];
  const correctionActions: AnyObj[] = [];

  if (topShare >= Number(policy.thresholds.monoculture_warn_share || 0.68)) {
    reasons.push('ethical_monoculture_warning');
    correctionActions.push({
      action: 'rebalance_value_allocations',
      reason: 'top_metric_share_exceeded',
      top_metric_id: top ? top.metric_id : null,
      top_share: Number(topShare.toFixed(6))
    });
  }
  if (mirrorPressure >= Number(policy.thresholds.mirror_pressure_warn || 0.55)) {
    reasons.push('ethical_mirror_pressure_warning');
    correctionActions.push({
      action: 'increase_reflection_weight',
      reason: 'mirror_pressure_high',
      mirror_pressure: Number(mirrorPressure.toFixed(6))
    });
  }

  const tradeoffReceipts: AnyObj[] = [];
  if (top && topShare >= Number(policy.thresholds.high_impact_share || 0.72)) {
    const alternatives = allocations.slice(1, 4).map((row) => ({
      metric_id: row.metric_id,
      share: Number(row.share || 0)
    }));
    tradeoffReceipts.push({
      receipt_id: `ethrcpt_${sha10(`${input.run_id || 'run'}|${top.metric_id}|${topShare}`)}`,
      ts: nowIso(),
      objective_id: cleanText(input.objective_id || '', 120) || null,
      selected_metric_id: top.metric_id,
      selected_share: Number(topShare.toFixed(6)),
      alternatives,
      ethical_basis: [
        'constitution_sovereignty_preserved',
        'monoculture_checked',
        'mirror_pressure_considered'
      ],
      high_impact: true
    });
  }

  const nextPriors = { ...(priorState || {}) };
  let priorsUpdated = false;
  if (maturityScore >= Number(policy.thresholds.maturity_min_for_prior_updates || 0.65) && allocations.length) {
    const deltaCap = Number(policy.max_prior_delta_per_run || 0.03);
    for (const row of allocations) {
      const key = normalizeToken(row.metric_id, 80);
      if (!key) continue;
      const current = clampNumber(nextPriors[key], 0, 1, 0);
      const target = clampNumber(row.share, 0, 1, 0);
      const delta = clampNumber(target - current, -deltaCap, deltaCap, 0);
      nextPriors[key] = Number((current + delta).toFixed(6));
      if (Math.abs(delta) > 0.0005) priorsUpdated = true;
    }
  } else {
    reasons.push('ethical_prior_update_maturity_gate');
  }

  const normalizedPriors = normalizePriors(nextPriors);
  const summary = {
    top_metric_id: top ? top.metric_id : null,
    top_share: Number(topShare.toFixed(6)),
    mirror_pressure: Number(mirrorPressure.toFixed(6)),
    maturity_score: Number(maturityScore.toFixed(6)),
    monoculture_warning: topShare >= Number(policy.thresholds.monoculture_warn_share || 0.68),
    priors_updated: priorsUpdated
  };
  return {
    reasons,
    correction_actions: correctionActions,
    tradeoff_receipts: tradeoffReceipts,
    value_priors: normalizedPriors,
    summary
  };
}

function runEthicalReasoning(input: AnyObj = {}, opts: AnyObj = {}) {
  const policyPath = path.resolve(String(opts.policy_path || process.env.ETHICAL_REASONING_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath, policy);
  const ts = cleanText(input.ts || nowIso(), 64) || nowIso();
  const runId = normalizeToken(input.run_id || `eth_${sha10(`${ts}|${Math.random()}`)}`, 120);

  if (policy.enabled !== true) {
    return {
      ok: false,
      type: 'ethical_reasoning_run',
      ts,
      run_id: runId,
      error: 'policy_disabled'
    };
  }

  const weaverPayload = input.weaver_payload && typeof input.weaver_payload === 'object'
    ? input.weaver_payload
    : readJson(paths.weaver_latest_path, {});
  const mirrorPayload = input.mirror_payload && typeof input.mirror_payload === 'object'
    ? input.mirror_payload
    : readJson(paths.mirror_latest_path, {});
  const priorState = loadPriors(paths.priors_state_path, policy.value_priors);
  const evaluated = evaluateEthics({
    ...input,
    weaver_payload: weaverPayload,
    mirror_payload: mirrorPayload
  }, policy, priorState);

  const payload = {
    ok: true,
    type: 'ethical_reasoning_run',
    ts,
    run_id: runId,
    policy: {
      version: policy.version,
      path: relPath(policyPath),
      shadow_only: policy.shadow_only === true
    },
    objective_id: cleanText(input.objective_id || weaverPayload.objective_id || '', 120) || null,
    summary: evaluated.summary,
    reason_codes: evaluated.reasons,
    correction_actions: evaluated.correction_actions.slice(0, 12),
    tradeoff_receipts: evaluated.tradeoff_receipts,
    value_priors: evaluated.value_priors
  };

  if (opts.persist !== false) {
    writeJsonAtomic(paths.latest_path, payload);
    appendJsonl(paths.history_path, {
      ts,
      type: 'ethical_reasoning_history',
      run_id: runId,
      objective_id: payload.objective_id,
      reason_codes: payload.reason_codes,
      top_metric_id: payload.summary.top_metric_id,
      top_share: payload.summary.top_share,
      priors_updated: payload.summary.priors_updated
    });
    for (const receipt of payload.tradeoff_receipts) {
      appendJsonl(paths.receipts_path, {
        ts,
        run_id: runId,
        ...receipt
      });
    }
    if (payload.summary.priors_updated === true) {
      writeJsonAtomic(paths.priors_state_path, {
        schema_id: 'ethical_value_priors',
        schema_version: '1.0',
        ts,
        run_id: runId,
        priors: payload.value_priors
      });
    }
  }

  return payload;
}

function cmdRun(args: AnyObj) {
  return runEthicalReasoning({
    ts: nowIso(),
    run_id: args['run-id'] || args.run_id || null,
    objective_id: args['objective-id'] || args.objective_id || null,
    maturity_score: clampNumber(args['maturity-score'] || args.maturity_score, 0, 1, 0.5)
  }, {
    policy_path: args.policy,
    persist: toBool(args.persist, true)
  });
}

function cmdStatus(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.ETHICAL_REASONING_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath, policy);
  const latest = readJson(paths.latest_path, null);
  const priors = readJson(paths.priors_state_path, null);
  return {
    ok: true,
    type: 'ethical_reasoning_status',
    ts: nowIso(),
    latest,
    priors: priors && priors.priors ? priors.priors : policy.value_priors,
    paths: {
      latest_path: relPath(paths.latest_path),
      history_path: relPath(paths.history_path),
      receipts_path: relPath(paths.receipts_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/ethical_reasoning_organ.js run [--objective-id=<id>] [--maturity-score=0..1]');
  console.log('  node systems/autonomy/ethical_reasoning_organ.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  let out: AnyObj;
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') out = cmdRun(args);
  else if (cmd === 'status') out = cmdStatus(args);
  else {
    usage();
    process.exit(2);
    return;
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  runEthicalReasoning
};

