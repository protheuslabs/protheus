#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-079
 * Latent intent inference graph with validator contracts.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.LATENT_INTENT_INFERENCE_POLICY_PATH
  ? path.resolve(process.env.LATENT_INTENT_INFERENCE_POLICY_PATH)
  : path.join(ROOT, 'config', 'latent_intent_inference_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
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

function stableHash(value: unknown, len = 18) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value), 'utf8').digest('hex').slice(0, len);
}

function normalizeList(v: unknown, maxLen = 160) {
  if (Array.isArray(v)) return v.map((row) => cleanText(row, maxLen)).filter(Boolean);
  const raw = cleanText(v || '', 4000);
  if (!raw) return [];
  return raw.split(',').map((row) => cleanText(row, maxLen)).filter(Boolean);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    min_source_confidence: 55,
    max_edges_per_topic: 3,
    validator: {
      false_positive_ceiling: 0.22,
      min_support_events: 3
    },
    rules: [
      { topic_contains: 'revenue', implied_need: 'pricing_experiment_plan', weight: 0.84 },
      { topic_contains: 'agents', implied_need: 'agent_orchestration_template', weight: 0.78 },
      { topic_contains: 'infrastructure', implied_need: 'resilience_upgrade_backlog', weight: 0.74 },
      { topic_contains: 'automation', implied_need: 'workflow_auto_apply_candidate', weight: 0.76 },
      { topic_contains: 'generational_wealth', implied_need: 'wealth_compounding_offer_design', weight: 0.82 }
    ],
    paths: {
      hypotheses_dir: 'state/sensory/cross_signal/hypotheses',
      output_dir: 'state/sensory/analysis/latent_intent',
      latest_path: 'state/sensory/analysis/latent_intent/latest.json',
      receipts_path: 'state/sensory/analysis/latent_intent/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const validator = raw.validator && typeof raw.validator === 'object' ? raw.validator : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const rulesRaw = Array.isArray(raw.rules) ? raw.rules : base.rules;
  const rules = rulesRaw
    .map((row: any) => ({
      topic_contains: normalizeToken(row && row.topic_contains || '', 120),
      implied_need: normalizeToken(row && row.implied_need || '', 120),
      weight: clampNumber(row && row.weight, 0, 1, 0.5)
    }))
    .filter((row: any) => row.topic_contains && row.implied_need);
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    min_source_confidence: clampNumber(raw.min_source_confidence, 1, 100, base.min_source_confidence),
    max_edges_per_topic: clampNumber(raw.max_edges_per_topic, 1, 20, base.max_edges_per_topic),
    validator: {
      false_positive_ceiling: clampNumber(validator.false_positive_ceiling, 0, 1, base.validator.false_positive_ceiling),
      min_support_events: clampNumber(validator.min_support_events, 1, 1000, base.validator.min_support_events)
    },
    rules: rules.length > 0 ? rules : base.rules,
    paths: {
      hypotheses_dir: resolvePath(paths.hypotheses_dir, base.paths.hypotheses_dir),
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
  if (!src || !Array.isArray(src.hypotheses)) return { hypotheses: [], file_path: fp };
  return {
    hypotheses: src.hypotheses.filter((row: any) => row && typeof row === 'object'),
    file_path: fp
  };
}

function evidenceSpans(hypothesis: Record<string, any>) {
  const rows = Array.isArray(hypothesis && hypothesis.evidence) ? hypothesis.evidence : [];
  return rows.slice(0, 6).map((row: any, idx: number) => ({
    index: idx,
    eye_id: cleanText(row && row.eye_id || '', 120) || null,
    title: cleanText(row && row.title || row && row.summary || '', 160) || null,
    ts: cleanText(row && row.ts || row && row.first_ts || row && row.first_seen_ts || '', 60) || null
  }));
}

function inferEdges(policy: Record<string, any>, hypotheses: Record<string, any>[], dateStr: string) {
  const perTopic = new Map();
  const edges = [];
  for (const h of hypotheses) {
    const confidence = clampNumber(h && h.confidence, 0, 100, 0);
    if (confidence < Number(policy.min_source_confidence || 55)) continue;
    const topic = normalizeToken(h && h.topic || '', 120);
    if (!topic) continue;
    for (const rule of policy.rules || []) {
      if (!topic.includes(String(rule.topic_contains || ''))) continue;
      const key = `${topic}|${rule.implied_need}`;
      const count = Number(perTopic.get(key) || 0);
      if (count >= Number(policy.max_edges_per_topic || 3)) continue;
      perTopic.set(key, count + 1);
      const probability = clampNumber((Number(h.probability || 0) * 0.7) + (Number(rule.weight || 0) * 0.3), 0.01, 0.99, 0.5);
      edges.push({
        edge_id: `imp_${stableHash(`${topic}|${rule.implied_need}|${h.id}|${dateStr}`, 20)}`,
        type: 'implied_need',
        topic,
        implied_need: String(rule.implied_need),
        source_hypothesis_id: cleanText(h.id || '', 160) || null,
        confidence: Number(confidence.toFixed(3)),
        probability: Number(probability.toFixed(4)),
        support_events: Number(h.support_events || 0),
        evidence_spans: evidenceSpans(h),
        generated_at: nowIso()
      });
    }
  }
  return edges;
}

function validateEdges(policy: Record<string, any>, edges: Record<string, any>[]) {
  const rows = Array.isArray(edges) ? edges : [];
  const minSupport = Number(policy.validator.min_support_events || 3);
  const lowSupport = rows.filter((row) => Number(row.support_events || 0) < minSupport).length;
  const estimatedFalsePositiveRate = rows.length > 0 ? Number((lowSupport / rows.length).toFixed(6)) : 0;
  const ceiling = Number(policy.validator.false_positive_ceiling || 0.22);
  return {
    false_positive_ceiling: ceiling,
    estimated_false_positive_rate: estimatedFalsePositiveRate,
    pass: estimatedFalsePositiveRate <= ceiling,
    low_support_edges: lowSupport,
    min_support_events: minSupport
  };
}

function run(dateStr: string, policy: Record<string, any>, strict = false) {
  const source = loadHypotheses(policy, dateStr);
  const edges = inferEdges(policy, source.hypotheses, dateStr);
  const validator = validateEdges(policy, edges);
  const out = {
    ok: validator.pass === true,
    type: 'latent_intent_inference_graph',
    ts: nowIso(),
    date: dateStr,
    source_hypotheses_path: source.file_path,
    source_hypothesis_count: source.hypotheses.length,
    edge_count: edges.length,
    validator,
    edges
  };
  ensureDir(policy.paths.output_dir);
  writeJsonAtomic(path.join(policy.paths.output_dir, `${dateStr}.json`), out);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, {
    ts: nowIso(),
    type: 'latent_intent_inference_receipt',
    date: dateStr,
    edge_count: edges.length,
    validator
  });
  if (strict && !validator.pass) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function status(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.output_dir, `${dateStr}.json`);
  const payload = readJson(fp, { ok: true, type: 'latent_intent_inference_graph_status', date: dateStr, edge_count: 0 });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
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
  usage();
  process.exit(2);
}

module.exports = {
  run
};

if (require.main === module) {
  main();
}
