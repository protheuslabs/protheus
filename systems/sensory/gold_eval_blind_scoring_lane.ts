#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-086
 * Gold eval corpus + blind detector scoring lane.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.GOLD_EVAL_BLIND_SCORING_POLICY_PATH
  ? path.resolve(process.env.GOLD_EVAL_BLIND_SCORING_POLICY_PATH)
  : path.join(ROOT, 'config', 'gold_eval_blind_scoring_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
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

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    prediction_key: 'candidate_probability',
    truth_key: 'truth',
    decision_threshold: 0.5,
    blind_salt: 'gold_eval_blind_lane_v1',
    thresholds: {
      min_precision: 0.62,
      min_recall: 0.55,
      min_f1: 0.58,
      max_brier: 0.28
    },
    paths: {
      eval_pack_dir: 'state/sensory/eval/gold',
      output_dir: 'state/sensory/analysis/gold_eval_blind',
      latest_path: 'state/sensory/analysis/gold_eval_blind/latest.json',
      receipts_path: 'state/sensory/analysis/gold_eval_blind/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const thresholds = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    prediction_key: cleanText(raw.prediction_key || base.prediction_key, 80) || base.prediction_key,
    truth_key: cleanText(raw.truth_key || base.truth_key, 80) || base.truth_key,
    decision_threshold: clampNumber(raw.decision_threshold, 0, 1, base.decision_threshold),
    blind_salt: cleanText(raw.blind_salt || base.blind_salt, 120) || base.blind_salt,
    thresholds: {
      min_precision: clampNumber(thresholds.min_precision, 0, 1, base.thresholds.min_precision),
      min_recall: clampNumber(thresholds.min_recall, 0, 1, base.thresholds.min_recall),
      min_f1: clampNumber(thresholds.min_f1, 0, 1, base.thresholds.min_f1),
      max_brier: clampNumber(thresholds.max_brier, 0, 1, base.thresholds.max_brier)
    },
    paths: {
      eval_pack_dir: resolvePath(paths.eval_pack_dir, base.paths.eval_pack_dir),
      output_dir: resolvePath(paths.output_dir, base.paths.output_dir),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadEvalPack(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.eval_pack_dir, `${dateStr}.json`);
  const src = readJson(fp, null);
  const items = src && Array.isArray(src.items) ? src.items : [];
  return {
    file_path: fp,
    corpus_id: cleanText(src && src.corpus_id || `gold_eval_${dateStr}`, 120) || `gold_eval_${dateStr}`,
    detector_id: cleanText(src && src.detector_id || 'candidate', 120) || 'candidate',
    items: items.filter((row: any) => row && typeof row === 'object')
  };
}

function blindOrder(policy: Record<string, any>, rows: Record<string, any>[]) {
  return rows
    .map((row, idx) => {
      const rowId = cleanText(row && row.id || `row_${idx}`, 120) || `row_${idx}`;
      const blindKey = stableHash(`${policy.blind_salt}|${rowId}|${idx}`, 24);
      return {
        id: rowId,
        blind_key: blindKey,
        row
      };
    })
    .sort((a, b) => String(a.blind_key).localeCompare(String(b.blind_key)));
}

function scoreMetrics(policy: Record<string, any>, orderedRows: Record<string, any>[]) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let brier = 0;

  const threshold = Number(policy.decision_threshold || 0.5);
  const predictionKey = String(policy.prediction_key || 'candidate_probability');
  const truthKey = String(policy.truth_key || 'truth');

  const blindedScored = orderedRows.map((row: Record<string, any>) => {
    const truthRaw = Number(row.row && row.row[truthKey]);
    const truth = truthRaw >= 0.5 ? 1 : 0;
    const prob = clampNumber(row.row && row.row[predictionKey], 0, 1, 0);
    const pred = prob >= threshold ? 1 : 0;
    if (pred === 1 && truth === 1) tp += 1;
    else if (pred === 1 && truth === 0) fp += 1;
    else if (pred === 0 && truth === 0) tn += 1;
    else if (pred === 0 && truth === 1) fn += 1;
    brier += ((prob - truth) ** 2);
    return {
      id: row.id,
      blind_key: row.blind_key,
      prediction_probability: Number(prob.toFixed(6)),
      predicted_label: pred,
      truth_label: truth
    };
  });

  const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
  const recall = (tp + fn) > 0 ? tp / (tp + fn) : 0;
  const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const sampleCount = orderedRows.length;
  const brierScore = sampleCount > 0 ? brier / sampleCount : 0;

  return {
    sample_count: sampleCount,
    confusion: { tp, fp, tn, fn },
    precision: Number(precision.toFixed(6)),
    recall: Number(recall.toFixed(6)),
    f1: Number(f1.toFixed(6)),
    brier: Number(brierScore.toFixed(6)),
    scored_rows: blindedScored
  };
}

function passGate(policy: Record<string, any>, metrics: Record<string, any>) {
  const t = policy.thresholds || {};
  const reasons = [];
  if (Number(metrics.precision || 0) < Number(t.min_precision || 0.62)) reasons.push('precision_below_threshold');
  if (Number(metrics.recall || 0) < Number(t.min_recall || 0.55)) reasons.push('recall_below_threshold');
  if (Number(metrics.f1 || 0) < Number(t.min_f1 || 0.58)) reasons.push('f1_below_threshold');
  if (Number(metrics.brier || 1) > Number(t.max_brier || 0.28)) reasons.push('brier_above_threshold');
  return {
    pass: reasons.length === 0,
    reasons,
    thresholds: t
  };
}

function run(dateStr: string, policy: Record<string, any>, strict = false) {
  const pack = loadEvalPack(policy, dateStr);
  const ordered = blindOrder(policy, pack.items);
  const metrics = scoreMetrics(policy, ordered);
  const gate = passGate(policy, metrics);

  const blindCommitment = stableHash(JSON.stringify(ordered.map((row: any) => ({ id: row.id, blind_key: row.blind_key }))), 24);

  const out = {
    ok: gate.pass,
    type: 'gold_eval_blind_scoring_lane',
    ts: nowIso(),
    date: dateStr,
    eval_pack_path: pack.file_path,
    corpus_id: pack.corpus_id,
    detector_id: pack.detector_id,
    blind_commitment: blindCommitment,
    metrics: {
      sample_count: metrics.sample_count,
      confusion: metrics.confusion,
      precision: metrics.precision,
      recall: metrics.recall,
      f1: metrics.f1,
      brier: metrics.brier
    },
    promotion_gate: gate,
    scored_rows: metrics.scored_rows
  };

  ensureDir(policy.paths.output_dir);
  writeJsonAtomic(path.join(policy.paths.output_dir, `${dateStr}.json`), out);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, {
    ts: nowIso(),
    type: 'gold_eval_blind_scoring_receipt',
    date: dateStr,
    corpus_id: out.corpus_id,
    detector_id: out.detector_id,
    blind_commitment: out.blind_commitment,
    metrics: out.metrics,
    promotion_gate: out.promotion_gate
  });

  if (strict && !out.ok) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function status(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.output_dir, `${dateStr}.json`);
  const payload = readJson(fp, {
    ok: true,
    type: 'gold_eval_blind_scoring_lane_status',
    date: dateStr,
    metrics: {
      sample_count: 0,
      precision: 0,
      recall: 0,
      f1: 0,
      brier: 0
    }
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usageAndExit(code = 0) {
  console.log('Usage:');
  console.log('  node systems/sensory/gold_eval_blind_scoring_lane.js run [YYYY-MM-DD] [--strict=1] [--policy=<path>]');
  console.log('  node systems/sensory/gold_eval_blind_scoring_lane.js status [YYYY-MM-DD] [--policy=<path>]');
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
  run
};

if (require.main === module) {
  main();
}
