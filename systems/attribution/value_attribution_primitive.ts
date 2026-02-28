#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/attribution/value_attribution_primitive.js
 *
 * V3-ATTR-001: Lightweight Value Attribution Primitive
 * - Records provenance and influence for assimilated or generated capabilities.
 * - Logs to passport chain + helix event stream.
 * - Provides read-only query/status API for downstream lanes.
 * - Shadow-first by policy.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { appendAction } = require('../security/agent_passport.js');
const { writeContractReceipt } = require('../../lib/action_receipts.js');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.VALUE_ATTRIBUTION_POLICY_PATH
  ? path.resolve(process.env.VALUE_ATTRIBUTION_POLICY_PATH)
  : path.join(ROOT, 'config', 'value_attribution_primitive_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/attribution/value_attribution_primitive.js record --input-json="{...}" [--policy=path] [--apply=1|0]');
  console.log('  node systems/attribution/value_attribution_primitive.js query [--creator-id=<id>] [--source-id=<id>] [--objective-id=<id>] [--run-id=<id>] [--limit=N] [--policy=path]');
  console.log('  node systems/attribution/value_attribution_primitive.js status [--policy=path]');
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

function cleanText(v: unknown, maxLen = 280) {
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

function parseJsonArg(raw: unknown, fallback: any) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return fallback;
  const payload = text.startsWith('@')
    ? String(fs.readFileSync(path.resolve(ROOT, text.slice(1)), 'utf8') || '')
    : text;
  try {
    return JSON.parse(payload);
  } catch {
    return fallback;
  }
}

function sha16(seed: string) {
  return crypto.createHash('sha256').update(String(seed || ''), 'utf8').digest('hex').slice(0, 16);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    allow_apply: false,
    scoring: {
      default_weight: 1,
      default_confidence: 0.8,
      default_impact: 0.7,
      min_influence_score: 0,
      max_influence_score: 1
    },
    passport: {
      enabled: true,
      source: 'value_attribution_primitive'
    },
    helix: {
      enabled: true,
      events_path: 'state/helix/events.jsonl'
    },
    state: {
      root: 'state/assimilation/value_attribution',
      records_path: 'state/assimilation/value_attribution/records.jsonl',
      latest_path: 'state/assimilation/value_attribution/latest.json',
      history_path: 'state/assimilation/value_attribution/history.jsonl',
      receipts_path: 'state/assimilation/value_attribution/receipts.jsonl'
    },
    read_api: {
      default_limit: 100,
      max_limit: 500
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
  const scoring = raw.scoring && typeof raw.scoring === 'object' ? raw.scoring : {};
  const passport = raw.passport && typeof raw.passport === 'object' ? raw.passport : {};
  const helix = raw.helix && typeof raw.helix === 'object' ? raw.helix : {};
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  const readApi = raw.read_api && typeof raw.read_api === 'object' ? raw.read_api : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    allow_apply: toBool(raw.allow_apply, base.allow_apply),
    scoring: {
      default_weight: clampNumber(scoring.default_weight, 0, 100, base.scoring.default_weight),
      default_confidence: clampNumber(scoring.default_confidence, 0, 1, base.scoring.default_confidence),
      default_impact: clampNumber(scoring.default_impact, 0, 1, base.scoring.default_impact),
      min_influence_score: clampNumber(scoring.min_influence_score, 0, 1, base.scoring.min_influence_score),
      max_influence_score: clampNumber(scoring.max_influence_score, 0, 1, base.scoring.max_influence_score)
    },
    passport: {
      enabled: toBool(passport.enabled, base.passport.enabled),
      source: normalizeToken(passport.source || base.passport.source, 120) || base.passport.source
    },
    helix: {
      enabled: toBool(helix.enabled, base.helix.enabled),
      events_path: resolvePath(helix.events_path || base.helix.events_path, base.helix.events_path)
    },
    state: {
      root: resolvePath(state.root || base.state.root, base.state.root),
      records_path: resolvePath(state.records_path || base.state.records_path, base.state.records_path),
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      history_path: resolvePath(state.history_path || base.state.history_path, base.state.history_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path)
    },
    read_api: {
      default_limit: clampInt(readApi.default_limit, 1, 5000, base.read_api.default_limit),
      max_limit: clampInt(readApi.max_limit, 1, 5000, base.read_api.max_limit)
    }
  };
}

function normalizeRecordInput(inputRaw: AnyObj = {}, policy: AnyObj) {
  const sourceType = normalizeToken(inputRaw.source_type || inputRaw.source && inputRaw.source.source_type || '', 80) || 'unknown';
  const sourceId = normalizeToken(inputRaw.source_id || inputRaw.source && inputRaw.source.source_id || '', 180) || null;
  const sourceUrl = cleanText(inputRaw.source_url || inputRaw.source && inputRaw.source.source_url || '', 500) || null;

  const creatorId = normalizeToken(inputRaw.creator_id || inputRaw.creator && inputRaw.creator.creator_id || '', 180) || 'unknown_creator';
  const creatorAlias = cleanText(inputRaw.creator_alias || inputRaw.creator && inputRaw.creator.alias || '', 120) || null;
  const creatorOptIn = toBool(
    inputRaw.creator_opt_in != null ? inputRaw.creator_opt_in : (inputRaw.creator && inputRaw.creator.opt_in),
    false
  );

  const licenseId = normalizeToken(inputRaw.license || inputRaw.license_id || '', 80) || 'unknown';
  const weight = clampNumber(inputRaw.weight, 0, 100, policy.scoring.default_weight);
  const confidence = clampNumber(inputRaw.confidence, 0, 1, policy.scoring.default_confidence);
  const impact = clampNumber(inputRaw.impact_score, 0, 1, policy.scoring.default_impact);
  const baseInfluence = clampNumber(inputRaw.influence_score, 0, 1, weight * confidence * impact);
  const influenceScore = clampNumber(
    baseInfluence,
    policy.scoring.min_influence_score,
    policy.scoring.max_influence_score,
    baseInfluence
  );

  const objectiveId = normalizeToken(inputRaw.objective_id || '', 180) || null;
  const capabilityId = normalizeToken(inputRaw.capability_id || '', 180) || null;
  const taskId = normalizeToken(inputRaw.task_id || '', 180) || null;
  const runId = normalizeToken(inputRaw.run_id || '', 160) || null;
  const lane = normalizeToken(inputRaw.lane || '', 80) || null;

  const provenance = {
    source: {
      source_type: sourceType,
      source_id: sourceId,
      source_url: sourceUrl
    },
    creator: {
      creator_id: creatorId,
      alias: creatorAlias,
      opt_in: creatorOptIn
    },
    license: {
      license_id: licenseId
    },
    valuation: {
      weight,
      confidence,
      impact_score: impact,
      influence_score: influenceScore
    },
    context: {
      objective_id: objectiveId,
      capability_id: capabilityId,
      task_id: taskId,
      run_id: runId,
      lane
    }
  };

  const attributionId = normalizeToken(inputRaw.attribution_id || '', 160)
    || `attr_${sha16(`${creatorId}|${sourceType}|${sourceId || ''}|${taskId || capabilityId || runId || nowIso()}`)}`;

  return {
    schema_id: 'value_attribution_record',
    schema_version: '1.0',
    ts: nowIso(),
    attribution_id: attributionId,
    provenance
  };
}

function recordAttribution(inputRaw: AnyObj = {}, opts: AnyObj = {}) {
  const policyPath = opts.policy
    ? resolvePath(opts.policy, 'config/value_attribution_primitive_policy.json')
    : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (policy.enabled !== true) {
    return { ok: false, type: 'value_attribution_record', error: 'policy_disabled' };
  }

  const applyRequested = toBool(opts.apply != null ? opts.apply : inputRaw.apply, false);
  const applyExecuted = applyRequested && policy.allow_apply === true && policy.shadow_only !== true;
  const shadowOnly = policy.shadow_only === true || !applyExecuted;

  const record = normalizeRecordInput(inputRaw, policy);
  const payload = {
    ...record,
    shadow_only: shadowOnly,
    apply_requested: applyRequested,
    apply_executed: applyExecuted,
    policy_version: policy.version
  };

  appendJsonl(policy.state.records_path, payload);
  appendJsonl(policy.state.history_path, payload);
  writeJsonAtomic(policy.state.latest_path, payload);

  const receipt = writeContractReceipt(policy.state.receipts_path, {
    ts: payload.ts,
    type: 'value_attribution_record',
    objective_id: payload.provenance.context.objective_id,
    status: shadowOnly ? 'shadow_only' : 'applied',
    summary: `creator=${payload.provenance.creator.creator_id};influence=${payload.provenance.valuation.influence_score}`,
    attribution_id: payload.attribution_id,
    creator_id: payload.provenance.creator.creator_id,
    source_type: payload.provenance.source.source_type,
    source_id: payload.provenance.source.source_id,
    lane: payload.provenance.context.lane || 'unknown'
  }, {
    attempted: true,
    verified: shadowOnly !== true
  });

  let passportLink = null;
  if (policy.passport.enabled === true) {
    const linked = appendAction({
      source: policy.passport.source,
      action: {
        action_type: 'value_attribution_recorded',
        objective_id: payload.provenance.context.objective_id,
        target: payload.attribution_id,
        status: shadowOnly ? 'shadow_only' : 'recorded',
        attempted: true,
        verified: shadowOnly !== true,
        metadata: {
          creator_id: payload.provenance.creator.creator_id,
          source_type: payload.provenance.source.source_type,
          source_id: payload.provenance.source.source_id,
          influence_score: payload.provenance.valuation.influence_score
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

  let helixEvent = null;
  if (policy.helix.enabled === true) {
    helixEvent = {
      ts: nowIso(),
      type: 'value_attribution_recorded',
      attribution_id: payload.attribution_id,
      creator_id: payload.provenance.creator.creator_id,
      source: payload.provenance.source,
      valuation: payload.provenance.valuation,
      objective_id: payload.provenance.context.objective_id,
      run_id: payload.provenance.context.run_id,
      shadow_only: shadowOnly
    };
    appendJsonl(policy.helix.events_path, helixEvent);
  }

  return {
    ok: true,
    type: 'value_attribution_record',
    attribution_id: payload.attribution_id,
    creator_id: payload.provenance.creator.creator_id,
    source_id: payload.provenance.source.source_id,
    source_type: payload.provenance.source.source_type,
    influence_score: payload.provenance.valuation.influence_score,
    shadow_only: shadowOnly,
    apply_executed: applyExecuted,
    paths: {
      latest_path: relPath(policy.state.latest_path),
      records_path: relPath(policy.state.records_path),
      receipts_path: relPath(policy.state.receipts_path)
    },
    receipt_integrity: receipt && receipt.receipt_contract && receipt.receipt_contract.integrity
      ? receipt.receipt_contract.integrity
      : null,
    passport_link: passportLink,
    helix_event: helixEvent
  };
}

function queryRecords(filtersRaw: AnyObj = {}, opts: AnyObj = {}) {
  const policyPath = opts.policy
    ? resolvePath(opts.policy, 'config/value_attribution_primitive_policy.json')
    : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const creatorFilter = normalizeToken(filtersRaw.creator_id || '', 180) || null;
  const sourceFilter = normalizeToken(filtersRaw.source_id || '', 180) || null;
  const objectiveFilter = normalizeToken(filtersRaw.objective_id || '', 180) || null;
  const runFilter = normalizeToken(filtersRaw.run_id || '', 160) || null;
  const limit = clampInt(filtersRaw.limit, 1, policy.read_api.max_limit, policy.read_api.default_limit);

  const rows = readJsonl(policy.state.records_path);
  const filtered = rows.filter((row: AnyObj) => {
    const creatorId = normalizeToken(row && row.provenance && row.provenance.creator && row.provenance.creator.creator_id || '', 180) || null;
    const sourceId = normalizeToken(row && row.provenance && row.provenance.source && row.provenance.source.source_id || '', 180) || null;
    const objectiveId = normalizeToken(row && row.provenance && row.provenance.context && row.provenance.context.objective_id || '', 180) || null;
    const runId = normalizeToken(row && row.provenance && row.provenance.context && row.provenance.context.run_id || '', 160) || null;
    if (creatorFilter && creatorFilter !== creatorId) return false;
    if (sourceFilter && sourceFilter !== sourceId) return false;
    if (objectiveFilter && objectiveFilter !== objectiveId) return false;
    if (runFilter && runFilter !== runId) return false;
    return true;
  }).slice(-limit);

  return {
    ok: true,
    type: 'value_attribution_query',
    count: filtered.length,
    records: filtered,
    shadow_only: policy.shadow_only === true,
    records_path: relPath(policy.state.records_path)
  };
}

function status(opts: AnyObj = {}) {
  const policyPath = opts.policy
    ? resolvePath(opts.policy, 'config/value_attribution_primitive_policy.json')
    : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const rows = readJsonl(policy.state.records_path);
  const latest = readJson(policy.state.latest_path, null);
  const uniqueCreators = new Set(rows.map((row: AnyObj) => normalizeToken(row && row.provenance && row.provenance.creator && row.provenance.creator.creator_id || '', 180)).filter(Boolean));

  return {
    ok: true,
    type: 'value_attribution_status',
    policy_version: policy.version,
    shadow_only: policy.shadow_only === true,
    records_total: rows.length,
    creators_total: uniqueCreators.size,
    latest_attribution_id: latest && latest.attribution_id ? String(latest.attribution_id) : null,
    records_path: relPath(policy.state.records_path),
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

  if (cmd === 'record') {
    const payload = parseJsonArg(args.input_json || args['input-json'] || '', {}) || {};
    const merged = {
      ...payload,
      creator_id: args.creator_id || payload.creator_id,
      source_id: args.source_id || payload.source_id,
      source_type: args.source_type || payload.source_type,
      objective_id: args.objective_id || payload.objective_id,
      run_id: args.run_id || payload.run_id,
      lane: args.lane || payload.lane,
      weight: args.weight != null ? args.weight : payload.weight,
      confidence: args.confidence != null ? args.confidence : payload.confidence,
      impact_score: args.impact_score != null ? args.impact_score : payload.impact_score,
      influence_score: args.influence_score != null ? args.influence_score : payload.influence_score,
      license: args.license || payload.license
    };
    const out = recordAttribution(merged, {
      policy: args.policy,
      apply: args.apply
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(out.ok ? 0 : 1);
    return;
  }

  if (cmd === 'query') {
    const out = queryRecords({
      creator_id: args.creator_id || args['creator-id'],
      source_id: args.source_id || args['source-id'],
      objective_id: args.objective_id || args['objective-id'],
      run_id: args.run_id || args['run-id'],
      limit: args.limit
    }, {
      policy: args.policy
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }

  if (cmd === 'status') {
    const out = status({ policy: args.policy });
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
  recordAttribution,
  queryRecords,
  status
};
