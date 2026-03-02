#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-087
 * Champion/challenger detector promotion pipeline.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.CHAMPION_CHALLENGER_POLICY_PATH
  ? path.resolve(process.env.CHAMPION_CHALLENGER_POLICY_PATH)
  : path.join(ROOT, 'config', 'champion_challenger_detector_policy.json');

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
    decision_threshold: 0.5,
    uplift_policy: {
      min_f1_uplift: 0.01,
      min_precision_delta: -0.01,
      min_recall_delta: -0.01,
      max_brier_regression: 0.01
    },
    paths: {
      eval_pack_dir: 'state/sensory/eval/champion_challenger',
      output_dir: 'state/sensory/analysis/champion_challenger',
      latest_path: 'state/sensory/analysis/champion_challenger/latest.json',
      receipts_path: 'state/sensory/analysis/champion_challenger/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const uplift = raw.uplift_policy && typeof raw.uplift_policy === 'object' ? raw.uplift_policy : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    decision_threshold: clampNumber(raw.decision_threshold, 0, 1, base.decision_threshold),
    uplift_policy: {
      min_f1_uplift: clampNumber(uplift.min_f1_uplift, -1, 1, base.uplift_policy.min_f1_uplift),
      min_precision_delta: clampNumber(uplift.min_precision_delta, -1, 1, base.uplift_policy.min_precision_delta),
      min_recall_delta: clampNumber(uplift.min_recall_delta, -1, 1, base.uplift_policy.min_recall_delta),
      max_brier_regression: clampNumber(uplift.max_brier_regression, -1, 1, base.uplift_policy.max_brier_regression)
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

function loadPack(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.eval_pack_dir, `${dateStr}.json`);
  const src = readJson(fp, null);
  const items = src && Array.isArray(src.items) ? src.items : [];
  return {
    file_path: fp,
    corpus_id: cleanText(src && src.corpus_id || `cc_eval_${dateStr}`, 120),
    champion_id: cleanText(src && src.champion_id || 'champion', 120),
    challenger_id: cleanText(src && src.challenger_id || 'challenger', 120),
    items: items.filter((row: any) => row && typeof row === 'object')
  };
}

function score(items: Record<string, any>[], probabilityKey: string, threshold: number) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let brier = 0;
  for (const row of items || []) {
    const truth = Number(row.truth || 0) >= 0.5 ? 1 : 0;
    const prob = clampNumber(row[probabilityKey], 0, 1, 0);
    const pred = prob >= threshold ? 1 : 0;
    if (pred === 1 && truth === 1) tp += 1;
    else if (pred === 1 && truth === 0) fp += 1;
    else if (pred === 0 && truth === 0) tn += 1;
    else if (pred === 0 && truth === 1) fn += 1;
    brier += ((prob - truth) ** 2);
  }
  const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
  const recall = (tp + fn) > 0 ? tp / (tp + fn) : 0;
  const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const sampleCount = items.length;
  const brierScore = sampleCount > 0 ? brier / sampleCount : 0;
  return {
    sample_count: sampleCount,
    confusion: { tp, fp, tn, fn },
    precision: Number(precision.toFixed(6)),
    recall: Number(recall.toFixed(6)),
    f1: Number(f1.toFixed(6)),
    brier: Number(brierScore.toFixed(6))
  };
}

function compareMetrics(champion: Record<string, any>, challenger: Record<string, any>, policy: Record<string, any>) {
  const deltas = {
    precision: Number((Number(challenger.precision || 0) - Number(champion.precision || 0)).toFixed(6)),
    recall: Number((Number(challenger.recall || 0) - Number(champion.recall || 0)).toFixed(6)),
    f1: Number((Number(challenger.f1 || 0) - Number(champion.f1 || 0)).toFixed(6)),
    brier: Number((Number(challenger.brier || 0) - Number(champion.brier || 0)).toFixed(6))
  };
  const up = policy.uplift_policy || {};
  const reasons = [];
  if (deltas.f1 < Number(up.min_f1_uplift || 0)) reasons.push('f1_uplift_below_policy');
  if (deltas.precision < Number(up.min_precision_delta || -0.01)) reasons.push('precision_regression_exceeds_policy');
  if (deltas.recall < Number(up.min_recall_delta || -0.01)) reasons.push('recall_regression_exceeds_policy');
  if (deltas.brier > Number(up.max_brier_regression || 0.01)) reasons.push('brier_regression_exceeds_policy');
  return {
    deltas,
    pass: reasons.length === 0,
    reasons,
    policy: up
  };
}

function run(dateStr: string, policy: Record<string, any>, strict = false) {
  const pack = loadPack(policy, dateStr);
  const champion = score(pack.items, 'champion_probability', Number(policy.decision_threshold || 0.5));
  const challenger = score(pack.items, 'challenger_probability', Number(policy.decision_threshold || 0.5));
  const promotion = compareMetrics(champion, challenger, policy);

  const out = {
    ok: promotion.pass,
    type: 'champion_challenger_detector_promotion',
    ts: nowIso(),
    date: dateStr,
    eval_pack_path: pack.file_path,
    corpus_id: pack.corpus_id,
    champion_id: pack.champion_id,
    challenger_id: pack.challenger_id,
    metrics: {
      champion,
      challenger
    },
    promotion,
    promotion_receipt_id: `ccp_${stableHash(`${dateStr}|${pack.corpus_id}|${promotion.deltas.f1}|${promotion.pass}`, 20)}`
  };

  ensureDir(policy.paths.output_dir);
  writeJsonAtomic(path.join(policy.paths.output_dir, `${dateStr}.json`), out);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, {
    ts: nowIso(),
    type: 'champion_challenger_promotion_receipt',
    date: dateStr,
    corpus_id: pack.corpus_id,
    champion_id: pack.champion_id,
    challenger_id: pack.challenger_id,
    promotion: out.promotion,
    promotion_receipt_id: out.promotion_receipt_id
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
    type: 'champion_challenger_detector_promotion_status',
    date: dateStr,
    promotion: { pass: false, reasons: ['no_run_artifact'] }
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usageAndExit(code = 0) {
  console.log('Usage:');
  console.log('  node systems/sensory/champion_challenger_detector_promotion.js run [YYYY-MM-DD] [--strict=1] [--policy=<path>]');
  console.log('  node systems/sensory/champion_challenger_detector_promotion.js status [YYYY-MM-DD] [--policy=<path>]');
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
