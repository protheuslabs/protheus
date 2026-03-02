#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-084
 * Multi-hop objective chain mapper.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.MULTI_HOP_OBJECTIVE_CHAIN_POLICY_PATH
  ? path.resolve(process.env.MULTI_HOP_OBJECTIVE_CHAIN_POLICY_PATH)
  : path.join(ROOT, 'config', 'multi_hop_objective_chain_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
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

function parseArgs(argv: string[]) {
  const out: Record<string, any> = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
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

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function stableHash(v: unknown, len = 18) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function normalizeList(v: unknown, maxLen = 160) {
  if (Array.isArray(v)) return v.map((row) => normalizeToken(row, maxLen)).filter(Boolean);
  const raw = cleanText(v || '', 5000);
  if (!raw) return [];
  return raw
    .split(',')
    .map((row) => normalizeToken(row, maxLen))
    .filter(Boolean);
}

function tokenSet(v: unknown, maxLen = 800) {
  const txt = normalizeToken(v, maxLen);
  if (!txt) return new Set();
  return new Set(txt.split(/[_:/.-]+/g).map((row) => row.trim()).filter(Boolean));
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    min_path_confidence: 0.58,
    max_paths_per_objective: 24,
    max_paths_total: 300,
    objective_weights: {
      T1_make_jay_billionaire_v1: 1,
      T1_generational_wealth_v1: 0.9
    },
    objective_hints: {
      T1_make_jay_billionaire_v1: ['revenue', 'pricing', 'sales', 'growth', 'infrastructure', 'automation'],
      T1_generational_wealth_v1: ['wealth', 'compounding', 'portfolio', 'equity', 'cashflow', 'revenue']
    },
    paths: {
      hypotheses_dir: 'state/sensory/cross_signal/hypotheses',
      latent_intent_dir: 'state/sensory/analysis/latent_intent',
      output_dir: 'state/sensory/analysis/objective_chain_mapper',
      latest_path: 'state/sensory/analysis/objective_chain_mapper/latest.json',
      receipts_path: 'state/sensory/analysis/objective_chain_mapper/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const objectiveWeights = raw.objective_weights && typeof raw.objective_weights === 'object'
    ? raw.objective_weights
    : base.objective_weights;
  const objectiveHints = raw.objective_hints && typeof raw.objective_hints === 'object'
    ? raw.objective_hints
    : base.objective_hints;

  const normalizedWeights = Object.entries(objectiveWeights)
    .map(([objectiveId, score]) => [cleanText(objectiveId, 120), clampNumber(score, 0.01, 5, 1)])
    .filter(([objectiveId]) => Boolean(objectiveId));

  const normalizedHints = {} as Record<string, string[]>;
  for (const [objectiveId, rawHints] of Object.entries(objectiveHints)) {
    const normalizedId = cleanText(objectiveId, 120);
    if (!normalizedId) continue;
    normalizedHints[normalizedId] = normalizeList(rawHints, 80);
  }

  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    min_path_confidence: clampNumber(raw.min_path_confidence, 0, 1, base.min_path_confidence),
    max_paths_per_objective: clampNumber(raw.max_paths_per_objective, 1, 200, base.max_paths_per_objective),
    max_paths_total: clampNumber(raw.max_paths_total, 1, 5000, base.max_paths_total),
    objective_weights: Object.fromEntries(normalizedWeights.length > 0 ? normalizedWeights : Object.entries(base.objective_weights)),
    objective_hints: Object.keys(normalizedHints).length > 0 ? normalizedHints : base.objective_hints,
    paths: {
      hypotheses_dir: resolvePath(paths.hypotheses_dir, base.paths.hypotheses_dir),
      latent_intent_dir: resolvePath(paths.latent_intent_dir, base.paths.latent_intent_dir),
      output_dir: resolvePath(paths.output_dir, base.paths.output_dir),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadHypotheses(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.hypotheses_dir, `${dateStr}.json`);
  const src = readJson(fp, null);
  const hypotheses = src && Array.isArray(src.hypotheses) ? src.hypotheses : [];
  return {
    file_path: fp,
    hypotheses: hypotheses.filter((row: any) => row && typeof row === 'object')
  };
}

function loadLatentEdges(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.latent_intent_dir, `${dateStr}.json`);
  const src = readJson(fp, null);
  const edges = src && Array.isArray(src.edges) ? src.edges : [];
  return {
    file_path: fp,
    edges: edges.filter((row: any) => row && typeof row === 'object')
  };
}

function hypothesisMap(hypotheses: Record<string, any>[]) {
  const out = new Map();
  for (const row of hypotheses || []) {
    const id = cleanText(row && row.id || '', 160);
    if (!id) continue;
    out.set(id, row);
  }
  return out;
}

function collectEyes(edge: Record<string, any>, sourceHypothesis: Record<string, any> | null) {
  const out = new Set();
  const edgeEvidence = Array.isArray(edge && edge.evidence_spans) ? edge.evidence_spans : [];
  const sourceEvidence = sourceHypothesis && Array.isArray(sourceHypothesis.evidence) ? sourceHypothesis.evidence : [];
  for (const row of [...edgeEvidence, ...sourceEvidence]) {
    const eyeId = cleanText(row && row.eye_id || '', 120);
    if (eyeId) out.add(eyeId);
  }
  if (out.size === 0) out.add('unknown_eye');
  return Array.from(out);
}

function objectiveCandidates(policy: Record<string, any>, topic: string, implication: string) {
  const signalTokens = tokenSet(`${topic}_${implication}`, 800);
  const rows = [];
  for (const [objectiveId, baseWeightRaw] of Object.entries(policy.objective_weights || {})) {
    const baseWeight = clampNumber(baseWeightRaw, 0.01, 5, 1);
    const hints = Array.isArray(policy.objective_hints && policy.objective_hints[objectiveId])
      ? policy.objective_hints[objectiveId]
      : [];
    let matched = 0;
    for (const hint of hints) {
      if (signalTokens.has(normalizeToken(hint, 80))) matched += 1;
    }
    const hintCoverage = hints.length > 0 ? matched / hints.length : 0;
    const matchScore = clampNumber((hintCoverage * 0.7) + (matched > 0 ? 0.3 : 0), 0, 1, 0);
    const objectiveScore = clampNumber(baseWeight * (0.45 + (0.55 * matchScore)), 0, 1, 0.45);
    rows.push({
      objective_id: cleanText(objectiveId, 120),
      base_weight: Number(baseWeight.toFixed(4)),
      match_score: Number(matchScore.toFixed(4)),
      objective_score: Number(objectiveScore.toFixed(6))
    });
  }
  return rows.sort((a, b) => b.objective_score - a.objective_score);
}

function buildChains(policy: Record<string, any>, dateStr: string, hypotheses: Record<string, any>[], latentEdges: Record<string, any>[]) {
  const byId = hypothesisMap(hypotheses);
  const maxPerObjective = Number(policy.max_paths_per_objective || 24);
  const maxTotal = Number(policy.max_paths_total || 300);
  const minPath = Number(policy.min_path_confidence || 0.58);
  const objectiveCounts = new Map();
  const chains = [];

  for (const edge of latentEdges || []) {
    const sourceId = cleanText(edge && edge.source_hypothesis_id || '', 160);
    const source = sourceId ? (byId.get(sourceId) || null) : null;
    const topic = normalizeToken(edge && edge.topic || source && source.topic || 'unknown_topic', 120);
    const implication = normalizeToken(edge && edge.implied_need || 'unknown_implication', 120);
    const sourceConfidence = clampNumber(edge && edge.source_confidence, 0, 100, clampNumber(source && source.confidence, 0, 100, 0));
    const sourceProbability = clampNumber(edge && edge.source_probability, 0, 1, clampNumber(source && source.probability, 0, 1, 0.5));
    const implicationProbability = clampNumber(edge && edge.probability, 0, 1, sourceProbability);

    const eyes = collectEyes(edge, source);
    const objectives = objectiveCandidates(policy, topic, implication);

    for (const objective of objectives) {
      const objectiveId = cleanText(objective.objective_id, 120);
      if (!objectiveId) continue;
      const existingCount = Number(objectiveCounts.get(objectiveId) || 0);
      if (existingCount >= maxPerObjective) continue;

      for (const eyeIdRaw of eyes) {
        const eyeId = cleanText(eyeIdRaw, 120) || 'unknown_eye';
        const eyeWeight = eyeId === 'unknown_eye' ? 0.55 : 1;
        const pathConfidence = clampNumber(
          (sourceConfidence / 100) * 0.24
            + implicationProbability * 0.33
            + objective.objective_score * 0.27
            + objective.match_score * 0.1
            + eyeWeight * 0.06,
          0,
          1,
          0
        );
        if (pathConfidence < minPath) continue;

        const chain = {
          path_id: `och_${stableHash(`${dateStr}|${sourceId}|${topic}|${implication}|${objectiveId}|${eyeId}`, 20)}`,
          source_hypothesis_id: sourceId || null,
          eye_id: eyeId,
          topic,
          implication,
          objective_id: objectiveId,
          path_confidence: Number(pathConfidence.toFixed(6)),
          score_components: {
            source_confidence: Number(sourceConfidence.toFixed(4)),
            source_probability: Number(sourceProbability.toFixed(4)),
            implication_probability: Number(implicationProbability.toFixed(4)),
            objective_base_weight: objective.base_weight,
            objective_match_score: objective.match_score,
            objective_score: objective.objective_score,
            eye_weight: Number(eyeWeight.toFixed(4))
          },
          hops: [
            { index: 1, kind: 'eye', value: eyeId },
            { index: 2, kind: 'topic', value: topic },
            { index: 3, kind: 'implication', value: implication },
            { index: 4, kind: 'objective', value: objectiveId }
          ],
          generated_at: nowIso()
        };

        chains.push(chain);
        objectiveCounts.set(objectiveId, existingCount + 1);
        if (chains.length >= maxTotal) break;
      }
      if (chains.length >= maxTotal) break;
    }
    if (chains.length >= maxTotal) break;
  }

  return chains.sort((a, b) => b.path_confidence - a.path_confidence);
}

function summarizeByObjective(chains: Record<string, any>[]) {
  const byObjective = new Map();
  for (const row of chains || []) {
    const objectiveId = cleanText(row && row.objective_id || '', 120) || 'unknown_objective';
    const bucket = byObjective.get(objectiveId) || [];
    bucket.push(row);
    byObjective.set(objectiveId, bucket);
  }

  return Array.from(byObjective.entries())
    .map(([objectiveId, rows]) => {
      const confidences = rows.map((row: any) => Number(row.path_confidence || 0));
      const maxConfidence = confidences.length > 0 ? Math.max(...confidences) : 0;
      const avgConfidence = confidences.length > 0
        ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
        : 0;
      return {
        objective_id: objectiveId,
        path_count: rows.length,
        max_path_confidence: Number(maxConfidence.toFixed(6)),
        avg_path_confidence: Number(avgConfidence.toFixed(6)),
        top_path_ids: rows.slice(0, 5).map((row: any) => row.path_id)
      };
    })
    .sort((a, b) => b.max_path_confidence - a.max_path_confidence);
}

function run(dateStr: string, policy: Record<string, any>, strict = false) {
  const sourceHypotheses = loadHypotheses(policy, dateStr);
  const sourceLatent = loadLatentEdges(policy, dateStr);
  const chains = buildChains(policy, dateStr, sourceHypotheses.hypotheses, sourceLatent.edges);
  const objectiveSummary = summarizeByObjective(chains);
  const blocked = chains.length === 0;

  const out = {
    ok: !blocked,
    type: 'multi_hop_objective_chain_mapper',
    ts: nowIso(),
    date: dateStr,
    source_hypotheses_path: sourceHypotheses.file_path,
    source_latent_intent_path: sourceLatent.file_path,
    source_hypothesis_count: sourceHypotheses.hypotheses.length,
    source_latent_edge_count: sourceLatent.edges.length,
    chain_count: chains.length,
    min_path_confidence: Number(policy.min_path_confidence || 0),
    ranking_receipt: {
      top_path_confidence: chains.length > 0 ? Number(chains[0].path_confidence || 0) : 0,
      admitted_count: chains.length,
      blocked
    },
    objective_summary: objectiveSummary,
    chains
  };

  ensureDir(policy.paths.output_dir);
  writeJsonAtomic(path.join(policy.paths.output_dir, `${dateStr}.json`), out);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, {
    ts: nowIso(),
    type: 'multi_hop_objective_chain_mapper_receipt',
    date: dateStr,
    chain_count: chains.length,
    blocked,
    top_path_confidence: out.ranking_receipt.top_path_confidence,
    objective_summary: objectiveSummary.slice(0, 5)
  });

  if (strict && blocked) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function status(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.output_dir, `${dateStr}.json`);
  const payload = readJson(fp, {
    ok: true,
    type: 'multi_hop_objective_chain_mapper_status',
    date: dateStr,
    chain_count: 0
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usageAndExit(code = 0) {
  console.log('Usage:');
  console.log('  node systems/sensory/multi_hop_objective_chain_mapper.js run [YYYY-MM-DD] [--strict=1] [--policy=<path>]');
  console.log('  node systems/sensory/multi_hop_objective_chain_mapper.js status [YYYY-MM-DD] [--policy=<path>]');
  process.exit(code);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'status', 40).toLowerCase() || 'status';
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(args._[1] || '')) ? String(args._[1]) : todayStr();
  const strict = toBool(args.strict, false);
  const policy = loadPolicy(args.policy ? String(args.policy) : undefined);
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'policy_disabled' }, null, 2)}\n`);
    process.exit(2);
  }
  if (cmd === 'run') return run(dateStr, policy, strict);
  if (cmd === 'status') return status(policy, dateStr);
  return usageAndExit(2);
}

module.exports = {
  buildChains,
  run
};

if (require.main === module) {
  main();
}
