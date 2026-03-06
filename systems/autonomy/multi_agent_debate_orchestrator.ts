#!/usr/bin/env node
'use strict';
export {};

/**
 * multi_agent_debate_orchestrator.js
 *
 * V3-MAC-001:
 * - Runs bounded specialist debate rounds before final arbitration.
 * - Advisory-first output for Weaver and related policy engines.
 *
 * Usage:
 *   node systems/autonomy/multi_agent_debate_orchestrator.js run --input-json="{...}" [--apply=1|0]
 *   node systems/autonomy/multi_agent_debate_orchestrator.js status [latest|YYYY-MM-DD]
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.MULTI_AGENT_DEBATE_POLICY_PATH
  ? path.resolve(process.env.MULTI_AGENT_DEBATE_POLICY_PATH)
  : path.join(ROOT, 'config', 'multi_agent_debate_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function toDate(v: unknown) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
}

function cleanText(v: unknown, maxLen = 320) {
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

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/multi_agent_debate_orchestrator.js run --input-json="{...}" [--apply=1|0]');
  console.log('  node systems/autonomy/multi_agent_debate_orchestrator.js status [latest|YYYY-MM-DD]');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw || fallbackRel, 520);
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
    version: '1.0',
    enabled: true,
    shadow_only: true,
    rounds: {
      max_rounds: 2,
      min_agents: 3,
      consensus_threshold: 0.62
    },
    debate_resolution: {
      confidence_floor: 0.58,
      disagreement_gap_threshold: 0.08,
      runoff_enabled: true,
      max_runoff_rounds: 1,
      runoff_consensus_threshold: 0.57,
      require_distinct_roles_for_quorum: true
    },
    agent_roles: {
      soldier_guard: { weight: 1.1, bias: 'safety' },
      creative_probe: { weight: 1.0, bias: 'growth' },
      orderly_executor: { weight: 1.15, bias: 'delivery' }
    },
    outputs: {
      latest_path: 'state/autonomy/multi_agent_debate/latest.json',
      history_path: 'state/autonomy/multi_agent_debate/history.jsonl',
      receipts_path: 'state/autonomy/multi_agent_debate/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const rounds = raw.rounds && typeof raw.rounds === 'object' ? raw.rounds : {};
  const resolution = raw.debate_resolution && typeof raw.debate_resolution === 'object'
    ? raw.debate_resolution
    : {};
  const roles = raw.agent_roles && typeof raw.agent_roles === 'object' ? raw.agent_roles : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const roleMap: AnyObj = {};
  for (const key of Object.keys(base.agent_roles)) {
    const src = roles[key] && typeof roles[key] === 'object' ? roles[key] : {};
    roleMap[key] = {
      weight: clampNumber(src.weight, 0.2, 5, base.agent_roles[key].weight),
      bias: normalizeToken(src.bias || base.agent_roles[key].bias, 40) || base.agent_roles[key].bias
    };
  }
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    rounds: {
      max_rounds: clampInt(rounds.max_rounds, 1, 8, base.rounds.max_rounds),
      min_agents: clampInt(rounds.min_agents, 1, 16, base.rounds.min_agents),
      consensus_threshold: clampNumber(rounds.consensus_threshold, 0, 1, base.rounds.consensus_threshold)
    },
    debate_resolution: {
      confidence_floor: clampNumber(
        resolution.confidence_floor,
        0,
        1,
        base.debate_resolution.confidence_floor
      ),
      disagreement_gap_threshold: clampNumber(
        resolution.disagreement_gap_threshold,
        0,
        1,
        base.debate_resolution.disagreement_gap_threshold
      ),
      runoff_enabled: toBool(resolution.runoff_enabled, base.debate_resolution.runoff_enabled),
      max_runoff_rounds: clampInt(
        resolution.max_runoff_rounds,
        0,
        3,
        base.debate_resolution.max_runoff_rounds
      ),
      runoff_consensus_threshold: clampNumber(
        resolution.runoff_consensus_threshold,
        0,
        1,
        base.debate_resolution.runoff_consensus_threshold
      ),
      require_distinct_roles_for_quorum: toBool(
        resolution.require_distinct_roles_for_quorum,
        base.debate_resolution.require_distinct_roles_for_quorum
      )
    },
    agent_roles: roleMap,
    outputs: {
      latest_path: resolvePath(outputs.latest_path || base.outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path || base.outputs.history_path, base.outputs.history_path),
      receipts_path: resolvePath(outputs.receipts_path || base.outputs.receipts_path, base.outputs.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function normalizeCandidates(input: AnyObj = {}) {
  const rows = Array.isArray(input.candidates) ? input.candidates : [];
  return rows
    .map((row: AnyObj, idx: number) => ({
      candidate_id: normalizeToken(row && row.candidate_id || row && row.metric_id || `candidate_${idx + 1}`, 120),
      score: clampNumber(row && row.score, 0, 1, 0.5),
      confidence: clampNumber(row && row.confidence, 0, 1, 0.5),
      risk: normalizeToken(row && row.risk || 'medium', 32) || 'medium'
    }))
    .filter((row: AnyObj) => !!row.candidate_id);
}

function buildAgents(policy: AnyObj, input: AnyObj) {
  const explicit = Array.isArray(input.agents) ? input.agents : [];
  if (explicit.length) {
    return explicit
      .map((row: AnyObj, idx: number) => ({
        agent_id: normalizeToken(row && row.agent_id || `agent_${idx + 1}`, 120),
        role: normalizeToken(row && row.role || 'orderly_executor', 80) || 'orderly_executor'
      }))
      .filter((row: AnyObj) => !!row.agent_id);
  }
  return Object.keys(policy.agent_roles).map((role) => ({
    agent_id: role,
    role
  }));
}

function scoreCandidateForRole(role: string, roleCfg: AnyObj, candidate: AnyObj) {
  const bias = normalizeToken(roleCfg && roleCfg.bias || '', 40);
  const weight = Number(roleCfg && roleCfg.weight || 1);
  const base = Number(candidate.score || 0) * Number(candidate.confidence || 0.5);
  let biasBoost = 0;
  const risk = normalizeToken(candidate.risk || 'medium', 32);
  if (bias === 'safety') biasBoost = risk === 'low' ? 0.25 : (risk === 'medium' ? 0.08 : -0.15);
  else if (bias === 'growth') biasBoost = risk === 'high' ? 0.18 : (risk === 'medium' ? 0.1 : 0.02);
  else if (bias === 'delivery') biasBoost = risk === 'medium' ? 0.14 : (risk === 'low' ? 0.1 : -0.08);
  return Number(clampNumber((base + biasBoost) * weight, 0, 1, 0).toFixed(6));
}

function runMultiAgentDebate(inputRaw: AnyObj = {}, opts: AnyObj = {}) {
  const policy = opts.policy && typeof opts.policy === 'object'
    ? opts.policy
    : loadPolicy(opts.policyPath || opts.policy_path || DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    return {
      ok: false,
      type: 'multi_agent_debate_orchestrator',
      error: 'policy_disabled'
    };
  }

  const ts = nowIso();
  const date = toDate(opts.date || inputRaw.date || ts.slice(0, 10));
  const objectiveId = normalizeToken(inputRaw.objective_id || inputRaw.objectiveId || 'generic_objective', 120) || 'generic_objective';
  const objectiveText = cleanText(inputRaw.objective || inputRaw.objective_text || objectiveId, 300) || objectiveId;
  const candidates = normalizeCandidates(inputRaw);
  const agents = buildAgents(policy, inputRaw);
  const rounds = Number(policy.rounds.max_rounds || 2);
  const transcript: AnyObj[] = [];
  const voteTotals: Record<string, number> = {};
  const distinctRoles = new Set<string>();
  const disagreementGap = Number(policy.debate_resolution && policy.debate_resolution.disagreement_gap_threshold || 0.08);
  let disagreementVotes = 0;
  let totalVotes = 0;

  for (let round = 1; round <= rounds; round += 1) {
    for (const agent of agents) {
      const role = normalizeToken(agent.role || 'orderly_executor', 80) || 'orderly_executor';
      const roleCfg = policy.agent_roles[role] || { weight: 1, bias: 'delivery' };
      distinctRoles.add(role);
      const scored = candidates
        .map((candidate: AnyObj) => ({
          candidate_id: candidate.candidate_id,
          score: scoreCandidateForRole(role, roleCfg, candidate)
        }))
        .sort((a: AnyObj, b: AnyObj) => Number(b.score || 0) - Number(a.score || 0));
      const top = scored[0] || null;
      if (!top) continue;
      const runnerUp = scored[1] || null;
      const gap = runnerUp ? Number((Number(top.score || 0) - Number(runnerUp.score || 0)).toFixed(6)) : 1;
      const contested = gap <= disagreementGap;
      const certainty = Number(clampNumber(Math.max(0.05, gap + 0.45), 0, 1, 0.5).toFixed(6));
      if (contested) disagreementVotes += 1;
      totalVotes += 1;
      voteTotals[top.candidate_id] = Number(voteTotals[top.candidate_id] || 0) + Number((Number(top.score || 0) * certainty).toFixed(6));
      transcript.push({
        round,
        agent_id: agent.agent_id,
        role,
        selected_candidate_id: top.candidate_id,
        vote_score: Number(top.score || 0),
        certainty,
        contested,
        gap_to_runner_up: gap,
        runner_up_candidate_id: runnerUp ? runnerUp.candidate_id : null
      });
    }
  }

  const ranked = Object.entries(voteTotals)
    .map(([candidate_id, score]) => ({ candidate_id, score: Number(score || 0) }))
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  const top = ranked[0] || null;
  const totalScore = ranked.reduce((acc, row) => acc + Number(row.score || 0), 0);
  const consensusShare = totalScore > 0 && top
    ? Number((Number(top.score || 0) / totalScore).toFixed(6))
    : 0;
  const disagreementIndex = totalVotes > 0
    ? Number((disagreementVotes / totalVotes).toFixed(6))
    : 0;
  const minAgents = Number(policy.rounds.min_agents || 1);
  const requireDistinctRoles = policy.debate_resolution
    && policy.debate_resolution.require_distinct_roles_for_quorum === true;
  const quorumMet = agents.length >= minAgents
    && (!requireDistinctRoles || distinctRoles.size >= Math.min(3, minAgents));
  const confidenceFloor = Number(policy.debate_resolution && policy.debate_resolution.confidence_floor || 0.58);
  const confidenceScore = Number(
    clampNumber(consensusShare * (1 - (disagreementIndex * 0.5)), 0, 1, 0).toFixed(6)
  );
  let consensus = quorumMet
    && consensusShare >= Number(policy.rounds.consensus_threshold || 0.62)
    && confidenceScore >= confidenceFloor;
  let recommendedCandidateId = consensus && top ? top.candidate_id : null;
  let runoffExecuted = false;
  let runoffConsensus = false;
  let runoffRecommendedCandidateId = null;
  const runoffRounds = clampInt(
    policy.debate_resolution && policy.debate_resolution.max_runoff_rounds,
    0,
    3,
    1
  );
  if (
    consensus !== true
    && policy.debate_resolution
    && policy.debate_resolution.runoff_enabled === true
    && runoffRounds > 0
    && ranked.length >= 2
  ) {
    runoffExecuted = true;
    const candidatesTop2 = ranked.slice(0, 2).map((row: AnyObj) => row.candidate_id);
    const runoffTotals: Record<string, number> = {};
    for (let round = 1; round <= runoffRounds; round += 1) {
      for (const agent of agents) {
        const role = normalizeToken(agent.role || 'orderly_executor', 80) || 'orderly_executor';
        const roleCfg = policy.agent_roles[role] || { weight: 1, bias: 'delivery' };
        const scored = candidatesTop2
          .map((candidateId: string) => {
            const source = candidates.find((row: AnyObj) => row.candidate_id === candidateId) || { score: 0.5, confidence: 0.5, risk: 'medium' };
            return {
              candidate_id: candidateId,
              score: scoreCandidateForRole(role, roleCfg, source)
            };
          })
          .sort((a: AnyObj, b: AnyObj) => Number(b.score || 0) - Number(a.score || 0));
        const pick = scored[0] || null;
        if (!pick) continue;
        runoffTotals[pick.candidate_id] = Number(runoffTotals[pick.candidate_id] || 0) + Number(pick.score || 0);
        transcript.push({
          round: rounds + round,
          phase: 'runoff',
          agent_id: agent.agent_id,
          role,
          selected_candidate_id: pick.candidate_id,
          vote_score: Number(pick.score || 0),
          runoff_candidates: candidatesTop2
        });
      }
    }
    const runoffRanked = Object.entries(runoffTotals)
      .map(([candidate_id, score]) => ({ candidate_id, score: Number(score || 0) }))
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    const runoffTop = runoffRanked[0] || null;
    const runoffTotal = runoffRanked.reduce((acc: number, row: AnyObj) => acc + Number(row.score || 0), 0);
    const runoffShare = runoffTop && runoffTotal > 0
      ? Number((Number(runoffTop.score || 0) / runoffTotal).toFixed(6))
      : 0;
    const runoffThreshold = Number(policy.debate_resolution.runoff_consensus_threshold || 0.57);
    const runoffConfidence = Number(clampNumber(runoffShare * (1 - (disagreementIndex * 0.35)), 0, 1, 0).toFixed(6));
    runoffConsensus = quorumMet && runoffShare >= runoffThreshold && runoffConfidence >= confidenceFloor;
    if (runoffConsensus && runoffTop) {
      consensus = true;
      recommendedCandidateId = runoffTop.candidate_id;
      runoffRecommendedCandidateId = runoffTop.candidate_id;
    }
  }

  const out = {
    ok: true,
    type: 'multi_agent_debate_orchestrator',
    ts,
    date,
    shadow_only: policy.shadow_only === true,
    objective_id: objectiveId,
    objective_text: objectiveText,
    rounds_executed: rounds,
    quorum_met: quorumMet,
    quorum_rule: {
      min_agents: minAgents,
      require_distinct_roles_for_quorum: requireDistinctRoles,
      distinct_roles: Array.from(distinctRoles).sort()
    },
    consensus,
    confidence_score: confidenceScore,
    confidence_floor: confidenceFloor,
    consensus_share: consensusShare,
    disagreement_index: disagreementIndex,
    disagreement_votes: disagreementVotes,
    total_votes: totalVotes,
    recommended_candidate_id: recommendedCandidateId,
    debate_resolution: {
      runoff_executed: runoffExecuted,
      runoff_consensus: runoffConsensus,
      runoff_rounds: runoffExecuted ? runoffRounds : 0,
      runoff_recommended_candidate_id: runoffRecommendedCandidateId
    },
    ranked_candidates: ranked,
    debate_transcript: transcript,
    reason_codes: consensus
      ? [
        runoffExecuted && runoffConsensus ? 'multi_agent_consensus_reached_after_runoff' : 'multi_agent_consensus_reached',
        `confidence_score_${confidenceScore.toFixed(3)}`
      ]
      : ['multi_agent_consensus_not_reached', `confidence_score_${confidenceScore.toFixed(3)}`]
  };

  if (opts.persist !== false) {
    writeJsonAtomic(policy.outputs.latest_path, out);
    appendJsonl(policy.outputs.history_path, out);
    appendJsonl(policy.outputs.receipts_path, out);
  }
  return out;
}

function cmdRun(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const out = runMultiAgentDebate(parseJsonArg(args['input-json'] || args.input_json || '{}', {}), {
    policyPath,
    persist: true,
    date: args._[1] || args.date
  });
  process.stdout.write(`${JSON.stringify({
    ...out,
    policy: {
      path: path.relative(ROOT, policyPath).replace(/\\/g, '/'),
      version: loadPolicy(policyPath).version
    }
  })}\n`);
  if (out.ok !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const key = cleanText(args._[1] || args.date || 'latest', 40);
  let payload = null;
  if (key === 'latest') payload = readJson(policy.outputs.latest_path, null);
  else {
    const day = toDate(key);
    const rows = readJsonl(policy.outputs.history_path).filter((row: AnyObj) => String(row && row.date || '') === day);
    payload = rows.length ? rows[rows.length - 1] : null;
  }
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'multi_agent_debate_status',
      error: 'snapshot_missing',
      date: key
    })}\n`);
    process.exit(1);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'multi_agent_debate_status',
    ts: payload.ts || null,
    date: payload.date || null,
    objective_id: payload.objective_id || null,
    consensus: payload.consensus === true,
    confidence_score: Number(payload.confidence_score || 0),
    consensus_share: Number(payload.consensus_share || 0),
    disagreement_index: Number(payload.disagreement_index || 0),
    recommended_candidate_id: payload.recommended_candidate_id || null,
    rounds_executed: Number(payload.rounds_executed || 0),
    shadow_only: payload.shadow_only === true
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
    return;
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  runMultiAgentDebate
};
