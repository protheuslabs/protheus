#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.COLLECTIVE_REASONING_ROOT
  ? path.resolve(process.env.COLLECTIVE_REASONING_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.COLLECTIVE_REASONING_POLICY_PATH
  ? path.resolve(process.env.COLLECTIVE_REASONING_POLICY_PATH)
  : path.join(ROOT, 'config', 'collective_reasoning_primitive_policy.json');

function nowIso() {
  return new Date().toISOString();
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
    if (!String(token || '').startsWith('--')) {
      out._.push(String(token || ''));
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[String(token).slice(2)] = true;
    else out[String(token).slice(2, idx)] = String(token).slice(idx + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/assimilation/collective_reasoning_primitive.js run --input-json="{...}" [--policy=<path>] [--apply=1|0]');
  console.log('  node systems/assimilation/collective_reasoning_primitive.js status [--policy=<path>]');
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

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw || fallbackRel, 500);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function parseJsonArg(raw: unknown, fallback: any = {}) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function defaultPolicy() {
  return {
    schema_id: 'collective_reasoning_primitive_policy',
    schema_version: '1.0',
    enabled: true,
    shadow_only: true,
    quorum: {
      min_agents: 3,
      decision_threshold: 0.58
    },
    trust: {
      default_score: 0.6,
      min_score: 0.05,
      max_score: 0.99,
      positive_delta: 0.03,
      negative_delta: 0.06
    },
    delegation: {
      max_assignees: 4,
      preferred_lanes: ['autonomous_micro_agent', 'storm_human_lane', 'mirror_lane']
    },
    state: {
      latest_path: 'state/assimilation/collective_reasoning/latest.json',
      history_path: 'state/assimilation/collective_reasoning/history.jsonl',
      trust_ledger_path: 'state/assimilation/collective_reasoning/trust_ledger.json',
      receipts_path: 'state/assimilation/collective_reasoning/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const quorum = raw.quorum && typeof raw.quorum === 'object' ? raw.quorum : {};
  const trust = raw.trust && typeof raw.trust === 'object' ? raw.trust : {};
  const delegation = raw.delegation && typeof raw.delegation === 'object' ? raw.delegation : {};
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  return {
    schema_id: base.schema_id,
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    quorum: {
      min_agents: clampInt(quorum.min_agents, 1, 64, base.quorum.min_agents),
      decision_threshold: clampNumber(quorum.decision_threshold, 0, 1, base.quorum.decision_threshold)
    },
    trust: {
      default_score: clampNumber(trust.default_score, 0, 1, base.trust.default_score),
      min_score: clampNumber(trust.min_score, 0, 1, base.trust.min_score),
      max_score: clampNumber(trust.max_score, 0, 1, base.trust.max_score),
      positive_delta: clampNumber(trust.positive_delta, 0, 1, base.trust.positive_delta),
      negative_delta: clampNumber(trust.negative_delta, 0, 1, base.trust.negative_delta)
    },
    delegation: {
      max_assignees: clampInt(delegation.max_assignees, 1, 32, base.delegation.max_assignees),
      preferred_lanes: Array.isArray(delegation.preferred_lanes)
        ? delegation.preferred_lanes.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean)
        : base.delegation.preferred_lanes.slice(0)
    },
    state: {
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      history_path: resolvePath(state.history_path || base.state.history_path, base.state.history_path),
      trust_ledger_path: resolvePath(state.trust_ledger_path || base.state.trust_ledger_path, base.state.trust_ledger_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadTrustLedger(filePath: string, policy: AnyObj) {
  const payload = readJson(filePath, null);
  if (!payload || typeof payload !== 'object') {
    return {
      schema_id: 'collective_reasoning_trust_ledger',
      schema_version: '1.0',
      updated_at: null,
      agents: {}
    };
  }
  const agents = payload.agents && typeof payload.agents === 'object' ? payload.agents : {};
  for (const key of Object.keys(agents)) {
    const row = agents[key];
    agents[key] = {
      trust_score: clampNumber(
        row && row.trust_score,
        policy.trust.min_score,
        policy.trust.max_score,
        policy.trust.default_score
      ),
      wins: clampInt(row && row.wins, 0, 1000000, 0),
      losses: clampInt(row && row.losses, 0, 1000000, 0),
      updated_at: cleanText(row && row.updated_at || '', 64) || null
    };
  }
  return {
    schema_id: 'collective_reasoning_trust_ledger',
    schema_version: '1.0',
    updated_at: payload.updated_at ? String(payload.updated_at) : null,
    agents
  };
}

function evaluateCollectiveReasoning(inputRaw: AnyObj = {}, opts: AnyObj = {}) {
  const policy = opts.policy && typeof opts.policy === 'object'
    ? opts.policy
    : loadPolicy(opts.policyPath || opts.policy_path || DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    return {
      ok: false,
      type: 'collective_reasoning_primitive',
      error: 'policy_disabled'
    };
  }

  const ts = nowIso();
  const apply = toBool(opts.apply, false);
  const capabilityId = normalizeToken(inputRaw.capability_id || '', 160) || 'unknown_capability';

  const lanes = Array.isArray(inputRaw.lanes)
    ? inputRaw.lanes
        .map((row: AnyObj) => ({
          agent_id: normalizeToken(row && row.agent_id || '', 80),
          lane: normalizeToken(row && row.lane || '', 80) || 'autonomous_micro_agent',
          recommendation: normalizeToken(row && row.recommendation || '', 80) || 'defer',
          confidence: clampNumber(row && row.confidence, 0, 1, 0.5),
          evidence_strength: clampNumber(row && row.evidence_strength, 0, 1, 0.5)
        }))
        .filter((row: AnyObj) => row.agent_id)
    : [];

  const trustLedger = loadTrustLedger(policy.state.trust_ledger_path, policy);
  const weightedVotes: Record<string, number> = {};
  const agentsUsed: AnyObj[] = [];

  for (const lane of lanes) {
    if (!trustLedger.agents[lane.agent_id]) {
      trustLedger.agents[lane.agent_id] = {
        trust_score: policy.trust.default_score,
        wins: 0,
        losses: 0,
        updated_at: null
      };
    }
    const trust = clampNumber(
      trustLedger.agents[lane.agent_id].trust_score,
      policy.trust.min_score,
      policy.trust.max_score,
      policy.trust.default_score
    );
    const weight = Number((trust * lane.confidence * lane.evidence_strength).toFixed(6));
    weightedVotes[lane.recommendation] = Number((Number(weightedVotes[lane.recommendation] || 0) + weight).toFixed(6));
    agentsUsed.push({
      agent_id: lane.agent_id,
      lane: lane.lane,
      recommendation: lane.recommendation,
      trust_score: trust,
      vote_weight: weight
    });
  }

  const ranked = Object.entries(weightedVotes)
    .map(([recommendation, score]) => ({ recommendation, score: Number(score || 0) }))
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  const top = ranked[0] || { recommendation: 'defer', score: 0 };
  const totalWeight = ranked.reduce((acc, row) => acc + Number(row.score || 0), 0);
  const topShare = totalWeight > 0 ? Number((top.score / totalWeight).toFixed(6)) : 0;
  const quorumMet = lanes.length >= Number(policy.quorum.min_agents || 3);
  const consensus = quorumMet && topShare >= Number(policy.quorum.decision_threshold || 0.58);

  const finalRecommendation = consensus ? top.recommendation : 'defer';

  const preferred = Array.isArray(policy.delegation.preferred_lanes)
    ? policy.delegation.preferred_lanes
    : [];
  const delegationProfile = agentsUsed
    .slice(0)
    .sort((a, b) => Number(b.vote_weight || 0) - Number(a.vote_weight || 0))
    .filter((row) => preferred.includes(row.lane))
    .slice(0, Number(policy.delegation.max_assignees || 4))
    .map((row, idx) => ({
      assignee_rank: idx + 1,
      agent_id: row.agent_id,
      lane: row.lane,
      trust_score: Number(row.trust_score || 0),
      recommendation: row.recommendation
    }));

  if (inputRaw.observed_outcome) {
    const observed = normalizeToken(inputRaw.observed_outcome, 80);
    for (const lane of lanes) {
      const row = trustLedger.agents[lane.agent_id];
      if (!row) continue;
      if (lane.recommendation === observed) {
        row.trust_score = clampNumber(row.trust_score + Number(policy.trust.positive_delta || 0.03), policy.trust.min_score, policy.trust.max_score, row.trust_score);
        row.wins = Number(row.wins || 0) + 1;
      } else {
        row.trust_score = clampNumber(row.trust_score - Number(policy.trust.negative_delta || 0.06), policy.trust.min_score, policy.trust.max_score, row.trust_score);
        row.losses = Number(row.losses || 0) + 1;
      }
      row.updated_at = ts;
    }
  }

  trustLedger.updated_at = ts;
  writeJsonAtomic(policy.state.trust_ledger_path, trustLedger);

  const out = {
    ok: true,
    type: 'collective_reasoning_primitive',
    ts,
    shadow_only: policy.shadow_only === true,
    apply_requested: apply,
    capability_id: capabilityId,
    quorum_met: quorumMet,
    consensus,
    consensus_share: topShare,
    final_recommendation: finalRecommendation,
    ranked_recommendations: ranked,
    agents: agentsUsed,
    delegation_profile: delegationProfile,
    reason_codes: consensus ? ['collective_consensus_reached'] : ['collective_consensus_not_reached'],
    policy: {
      path: rel(policy.policy_path || DEFAULT_POLICY_PATH),
      version: policy.schema_version
    }
  };

  writeJsonAtomic(policy.state.latest_path, out);
  appendJsonl(policy.state.history_path, out);
  appendJsonl(policy.state.receipts_path, out);
  return out;
}

function status(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const trust = loadTrustLedger(policy.state.trust_ledger_path, policy);
  return {
    ok: true,
    type: 'collective_reasoning_status',
    latest: readJson(policy.state.latest_path, null),
    tracked_agents: Object.keys(trust.agents || {}).length
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'run', 32) || 'run';
  try {
    if (cmd === 'status') {
      process.stdout.write(`${JSON.stringify(status(args))}\n`);
      return;
    }
    if (cmd === 'run') {
      const input = parseJsonArg(args['input-json'] || args.input_json || '{}', {});
      const out = evaluateCollectiveReasoning(input, {
        policyPath: args.policy,
        apply: args.apply
      });
      process.stdout.write(`${JSON.stringify(out)}\n`);
      process.exit(out && out.ok === true ? 0 : 1);
      return;
    }
    if (cmd === 'help') {
      usage();
      return;
    }
    throw new Error(`unknown_command:${cmd}`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'collective_reasoning_primitive',
      error: cleanText(err && (err as AnyObj).message ? (err as AnyObj).message : err || 'collective_reasoning_failed', 220)
    })}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  loadPolicy,
  evaluateCollectiveReasoning
};
