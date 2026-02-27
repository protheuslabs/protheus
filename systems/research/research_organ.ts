#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runResearchProbe } = require('../assimilation/research_probe.js');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.RESEARCH_ORGAN_POLICY_PATH
  ? path.resolve(process.env.RESEARCH_ORGAN_POLICY_PATH)
  : path.join(ROOT, 'config', 'research_organ_policy.json');
const RUN_DIR = process.env.RESEARCH_ORGAN_RUN_DIR
  ? path.resolve(process.env.RESEARCH_ORGAN_RUN_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'research_organ', 'runs');
const RECEIPTS_PATH = process.env.RESEARCH_ORGAN_RECEIPTS_PATH
  ? path.resolve(process.env.RESEARCH_ORGAN_RECEIPTS_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'research_organ', 'receipts.jsonl');
const LATEST_PATH = process.env.RESEARCH_ORGAN_LATEST_PATH
  ? path.resolve(process.env.RESEARCH_ORGAN_LATEST_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'research_organ', 'latest.json');

function nowIso() {
  return new Date().toISOString();
}

function dateOnly(ts: string) {
  return String(ts || nowIso()).slice(0, 10);
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

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  return Math.floor(clampNumber(v, lo, hi, fallback));
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
    proposal_only: true,
    budget: {
      max_depth: 6,
      max_steps: 36,
      max_external_calls: 8
    },
    synthesis: {
      min_confidence_for_proposal: 0.55,
      max_proposals: 4
    },
    uncertainty_scaling: {
      enabled: true,
      min_depth: 2,
      uncertainty_weight: 0.6,
      value_weight: 0.4
    },
    adapters: {
      allowed_sources: ['internal_memory', 'research_probe', 'simulation'],
      blocked_sources: []
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const budget = raw.budget && typeof raw.budget === 'object' ? raw.budget : {};
  const synthesis = raw.synthesis && typeof raw.synthesis === 'object' ? raw.synthesis : {};
  const scaling = raw.uncertainty_scaling && typeof raw.uncertainty_scaling === 'object' ? raw.uncertainty_scaling : {};
  const adapters = raw.adapters && typeof raw.adapters === 'object' ? raw.adapters : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    proposal_only: raw.proposal_only !== false,
    budget: {
      max_depth: clampInt(budget.max_depth, 1, 32, base.budget.max_depth),
      max_steps: clampInt(budget.max_steps, 1, 256, base.budget.max_steps),
      max_external_calls: clampInt(budget.max_external_calls, 0, 64, base.budget.max_external_calls)
    },
    synthesis: {
      min_confidence_for_proposal: clampNumber(
        synthesis.min_confidence_for_proposal,
        0,
        1,
        base.synthesis.min_confidence_for_proposal
      ),
      max_proposals: clampInt(synthesis.max_proposals, 1, 64, base.synthesis.max_proposals)
    },
    uncertainty_scaling: {
      enabled: scaling.enabled !== false,
      min_depth: clampInt(scaling.min_depth, 1, 16, base.uncertainty_scaling.min_depth),
      uncertainty_weight: clampNumber(scaling.uncertainty_weight, 0, 1, base.uncertainty_scaling.uncertainty_weight),
      value_weight: clampNumber(scaling.value_weight, 0, 1, base.uncertainty_scaling.value_weight)
    },
    adapters: {
      allowed_sources: Array.from(
        new Set((Array.isArray(adapters.allowed_sources) ? adapters.allowed_sources : base.adapters.allowed_sources)
          .map((v) => normalizeToken(v, 80))
          .filter(Boolean))
      ),
      blocked_sources: Array.from(
        new Set((Array.isArray(adapters.blocked_sources) ? adapters.blocked_sources : base.adapters.blocked_sources)
          .map((v) => normalizeToken(v, 80))
          .filter(Boolean))
      )
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/research/research_organ.js run [--objective=...] [--uncertainty=0.7] [--value-priority=0.6] [--capability-id=...] [--metadata-json={...}]');
  console.log('  node systems/research/research_organ.js status [latest|YYYY-MM-DD]');
}

function planDepth(policy: AnyObj, uncertainty: number, valuePriority: number) {
  if (policy.uncertainty_scaling.enabled !== true) {
    return clampInt(policy.uncertainty_scaling.min_depth, 1, policy.budget.max_depth, 2);
  }
  const u = clampNumber(uncertainty, 0, 1, 0.5);
  const v = clampNumber(valuePriority, 0, 1, 0.5);
  const weighted = (u * Number(policy.uncertainty_scaling.uncertainty_weight || 0))
    + (v * Number(policy.uncertainty_scaling.value_weight || 0));
  const scaled = Math.round(policy.uncertainty_scaling.min_depth + (policy.budget.max_depth - policy.uncertainty_scaling.min_depth) * weighted);
  return clampInt(scaled, policy.uncertainty_scaling.min_depth, policy.budget.max_depth, policy.uncertainty_scaling.min_depth);
}

function parseJsonArg(raw: unknown) {
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function cmdRun(args: AnyObj) {
  const ts = nowIso();
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (policy.enabled !== true) {
    const out = { ok: false, type: 'organ_run', organ: 'research', error: 'research_organ_disabled' };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(1);
  }

  const objective = cleanText(args.objective || 'unknown_objective', 280) || 'unknown_objective';
  const uncertainty = clampNumber(args.uncertainty, 0, 1, 0.5);
  const valuePriority = clampNumber(args.value_priority || args['value-priority'], 0, 1, 0.5);
  const depth = planDepth(policy, uncertainty, valuePriority);
  const maxSteps = policy.budget.max_steps;
  const metadata = parseJsonArg(args.metadata_json || args['metadata-json']);
  const capabilityId = normalizeToken(args.capability_id || args['capability-id'] || metadata.capability_id || objective, 160);

  const loops: AnyObj[] = [];
  let stepsUsed = 0;
  for (let i = 0; i < depth; i += 1) {
    if (stepsUsed + 6 > maxSteps) break;
    const hop = i + 1;
    const hypothesis = `h${hop}:${cleanText(objective, 120)}`;
    const method = `m${hop}:${uncertainty >= 0.6 ? 'stress_test' : 'targeted_probe'}`;
    const experimentScore = clampNumber((0.5 + (uncertainty * 0.2) + (valuePriority * 0.2) - (i * 0.04)), 0, 1, 0.5);
    const critique = experimentScore < 0.55 ? 'weak_signal' : 'usable_signal';
    const synthesisConfidence = clampNumber(experimentScore + 0.08, 0, 1, 0.5);
    loops.push({
      hop,
      hypothesis,
      method_plan: method,
      experiment: {
        score: Number(experimentScore.toFixed(6)),
        notes: critique === 'weak_signal' ? 'expand sampling breadth' : 'sufficient for bounded proposal'
      },
      critique,
      synthesis: {
        confidence: Number(synthesisConfidence.toFixed(6)),
        claim: `bounded_claim_${hop}_${normalizeToken(objective, 36)}`
      }
    });
    stepsUsed += 6;
  }

  const probe = runResearchProbe({
    capability_id: capabilityId,
    source_type: 'research_organ',
    metadata
  }, { research_probe: { min_confidence: policy.synthesis.min_confidence_for_proposal } });

  const proposals: AnyObj[] = [];
  const blocked: AnyObj[] = [];
  const confidenceFloor = policy.synthesis.min_confidence_for_proposal;
  for (const loop of loops) {
    if (proposals.length >= policy.synthesis.max_proposals) break;
    const confidence = Number(loop && loop.synthesis && loop.synthesis.confidence || 0);
    const proposalId = `rprop_${hash12(`${objective}|${loop.hop}|${loop.synthesis.claim}`)}`;
    if (confidence >= confidenceFloor) {
      proposals.push({
        id: proposalId,
        type: 'research_synthesis_proposal',
        objective,
        confidence,
        claim: loop.synthesis.claim,
        proposal_only: true,
        promotion_gate: 'nursery_and_governance'
      });
    } else {
      blocked.push({
        id: proposalId,
        reason: 'confidence_below_floor',
        confidence,
        floor: confidenceFloor
      });
    }
  }

  if (probe && probe.fit !== 'sufficient') {
    blocked.push({
      id: `probe_${hash12(capabilityId)}`,
      reason: 'research_probe_insufficient',
      confidence: Number(probe.confidence || 0)
    });
  }

  const runId = `research_${hash12(`${ts}|${objective}|${capabilityId}`)}`;
  const payload = {
    ok: true,
    type: 'organ_run',
    organ: 'research',
    schema_version: '1.0',
    run_id: runId,
    ts,
    inputs: {
      objective,
      uncertainty,
      value_priority: valuePriority,
      capability_id: capabilityId
    },
    scores: {
      depth,
      steps_used: stepsUsed,
      loop_count: loops.length,
      probe_confidence: Number(probe.confidence || 0)
    },
    loops,
    probe,
    proposals,
    blocked,
    proposal_only: policy.proposal_only === true
  };

  const runPath = path.join(RUN_DIR, `${dateOnly(ts)}.json`);
  writeJsonAtomic(runPath, payload);
  writeJsonAtomic(LATEST_PATH, payload);
  appendJsonl(RECEIPTS_PATH, {
    ts,
    type: 'research_organ_run',
    run_id: runId,
    objective,
    depth,
    proposals: proposals.length,
    blocked: blocked.length,
    probe_confidence: Number(probe.confidence || 0)
  });

  process.stdout.write(`${JSON.stringify({ ...payload, runs_path: path.relative(ROOT, runPath).replace(/\\/g, '/'), receipts_path: path.relative(ROOT, RECEIPTS_PATH).replace(/\\/g, '/') })}\n`);
}

function cmdStatus(args: AnyObj) {
  const key = cleanText(args._[1] || args.date || 'latest', 32);
  const payload = key === 'latest'
    ? readJson(LATEST_PATH, null)
    : readJson(path.join(RUN_DIR, `${key}.json`), null);
  if (!payload) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'research_organ_status', error: 'status_not_found', key })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'research_organ_status', key, payload })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 32);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

