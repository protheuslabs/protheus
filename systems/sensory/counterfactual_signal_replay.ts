#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-082
 * Counterfactual signal replay harness.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.COUNTERFACTUAL_SIGNAL_REPLAY_POLICY_PATH
  ? path.resolve(process.env.COUNTERFACTUAL_SIGNAL_REPLAY_POLICY_PATH)
  : path.join(ROOT, 'config', 'counterfactual_signal_replay_policy.json');

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

function normalizeList(v: unknown, maxLen = 160) {
  if (Array.isArray(v)) return v.map((row) => cleanText(row, maxLen)).filter(Boolean);
  const raw = cleanText(v || '', 4000);
  if (!raw) return [];
  return raw.split(',').map((row) => cleanText(row, maxLen)).filter(Boolean);
}

function stableHash(v: unknown, len = 18) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    offset_days: 180,
    thresholds: {
      min_confidence: 60,
      min_probability: 0.6,
      min_support_events: 3,
      min_precision_uplift: 0.0,
      min_recall_uplift: 0.0
    },
    paths: {
      hypotheses_dir: 'state/sensory/cross_signal/hypotheses',
      output_dir: 'state/sensory/analysis/counterfactual_replay',
      latest_path: 'state/sensory/analysis/counterfactual_replay/latest.json',
      receipts_path: 'state/sensory/analysis/counterfactual_replay/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const thresholds = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    offset_days: clampNumber(raw.offset_days, 1, 3650, base.offset_days),
    thresholds: {
      min_confidence: clampNumber(thresholds.min_confidence, 1, 100, base.thresholds.min_confidence),
      min_probability: clampNumber(thresholds.min_probability, 0, 1, base.thresholds.min_probability),
      min_support_events: clampNumber(thresholds.min_support_events, 1, 1000, base.thresholds.min_support_events),
      min_precision_uplift: clampNumber(thresholds.min_precision_uplift, -1, 1, base.thresholds.min_precision_uplift),
      min_recall_uplift: clampNumber(thresholds.min_recall_uplift, -1, 1, base.thresholds.min_recall_uplift)
    },
    paths: {
      hypotheses_dir: resolvePath(paths.hypotheses_dir, base.paths.hypotheses_dir),
      output_dir: resolvePath(paths.output_dir, base.paths.output_dir),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function dateShift(dateStr: string, days: number) {
  const ms = Date.parse(`${dateStr}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return dateStr;
  return new Date(ms - (days * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
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

function scoreWindow(hypotheses: Record<string, any>[], thresholds: Record<string, any>) {
  const rows = Array.isArray(hypotheses) ? hypotheses : [];
  const predicted = rows.filter((row) =>
    Number(row.confidence || 0) >= Number(thresholds.min_confidence || 60)
    && Number(row.probability || 0) >= Number(thresholds.min_probability || 0.6));
  const realized = predicted.filter((row) => Number(row.support_events || 0) >= Number(thresholds.min_support_events || 3));
  const candidateRealized = rows.filter((row) => Number(row.support_events || 0) >= Number(thresholds.min_support_events || 3));
  const precision = predicted.length > 0 ? Number((realized.length / predicted.length).toFixed(6)) : 0;
  const recall = candidateRealized.length > 0 ? Number((realized.length / candidateRealized.length).toFixed(6)) : 0;
  return {
    hypothesis_count: rows.length,
    predicted_count: predicted.length,
    realized_count: realized.length,
    candidate_realized_count: candidateRealized.length,
    precision,
    recall
  };
}

function run(dateStr: string, policy: Record<string, any>, strict = false) {
  const counterfactualDate = dateShift(dateStr, Number(policy.offset_days || 180));
  const currentWindow = loadHypotheses(policy, dateStr);
  const counterfactualWindow = loadHypotheses(policy, counterfactualDate);
  const currentScore = scoreWindow(currentWindow.hypotheses, policy.thresholds);
  const counterfactualScore = scoreWindow(counterfactualWindow.hypotheses, policy.thresholds);
  const precisionUplift = Number((currentScore.precision - counterfactualScore.precision).toFixed(6));
  const recallUplift = Number((currentScore.recall - counterfactualScore.recall).toFixed(6));
  const negativeUplift = (
    precisionUplift < Number(policy.thresholds.min_precision_uplift || 0)
    || recallUplift < Number(policy.thresholds.min_recall_uplift || 0)
  );

  const out = {
    ok: !negativeUplift,
    type: 'counterfactual_signal_replay',
    ts: nowIso(),
    date: dateStr,
    counterfactual_date: counterfactualDate,
    offset_days: Number(policy.offset_days || 180),
    current_window: {
      file_path: currentWindow.file_path,
      ...currentScore
    },
    counterfactual_window: {
      file_path: counterfactualWindow.file_path,
      ...counterfactualScore
    },
    deltas: {
      precision_uplift: precisionUplift,
      recall_uplift: recallUplift
    },
    promotion_blocked: negativeUplift,
    receipt_id: `cfr_${stableHash(`${dateStr}|${counterfactualDate}|${precisionUplift}|${recallUplift}`, 20)}`
  };

  ensureDir(policy.paths.output_dir);
  writeJsonAtomic(path.join(policy.paths.output_dir, `${dateStr}.json`), out);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, {
    ts: nowIso(),
    type: 'counterfactual_signal_replay_receipt',
    date: dateStr,
    counterfactual_date: counterfactualDate,
    deltas: out.deltas,
    promotion_blocked: out.promotion_blocked
  });
  if (strict && out.promotion_blocked) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function status(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.output_dir, `${dateStr}.json`);
  const payload = readJson(fp, {
    ok: true,
    type: 'counterfactual_signal_replay_status',
    date: dateStr,
    promotion_blocked: false
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usageAndExit(code = 0) {
  console.log('Usage:');
  console.log('  node systems/sensory/counterfactual_signal_replay.js run [YYYY-MM-DD] [--strict=1] [--policy=<path>]');
  console.log('  node systems/sensory/counterfactual_signal_replay.js status [YYYY-MM-DD] [--policy=<path>]');
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
