#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-096
 * Analysis quality SLO contract.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.ANALYSIS_QUALITY_SLO_POLICY_PATH
  ? path.resolve(process.env.ANALYSIS_QUALITY_SLO_POLICY_PATH)
  : path.join(ROOT, 'config', 'analysis_quality_slo_contract_policy.json');

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
    slo: {
      min_precision: 0.62,
      min_recall: 0.55,
      min_f1: 0.58,
      max_brier: 0.28,
      max_abstain_rate: 0.45
    },
    paths: {
      gold_eval_dir: 'state/sensory/analysis/gold_eval_blind',
      abstain_dir: 'state/sensory/analysis/abstain_uncertainty',
      execution_slo_latest: 'state/ops/execution_slo/latest.json',
      output_dir: 'state/sensory/analysis/quality_slo',
      latest_path: 'state/sensory/analysis/quality_slo/latest.json',
      receipts_path: 'state/sensory/analysis/quality_slo/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const slo = raw.slo && typeof raw.slo === 'object' ? raw.slo : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    slo: {
      min_precision: clampNumber(slo.min_precision, 0, 1, base.slo.min_precision),
      min_recall: clampNumber(slo.min_recall, 0, 1, base.slo.min_recall),
      min_f1: clampNumber(slo.min_f1, 0, 1, base.slo.min_f1),
      max_brier: clampNumber(slo.max_brier, 0, 1, base.slo.max_brier),
      max_abstain_rate: clampNumber(slo.max_abstain_rate, 0, 1, base.slo.max_abstain_rate)
    },
    paths: {
      gold_eval_dir: resolvePath(paths.gold_eval_dir, base.paths.gold_eval_dir),
      abstain_dir: resolvePath(paths.abstain_dir, base.paths.abstain_dir),
      execution_slo_latest: resolvePath(paths.execution_slo_latest, base.paths.execution_slo_latest),
      output_dir: resolvePath(paths.output_dir, base.paths.output_dir),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function run(dateStr: string, policy: Record<string, any>, strict = false) {
  const goldPath = path.join(policy.paths.gold_eval_dir, `${dateStr}.json`);
  const abstainPath = path.join(policy.paths.abstain_dir, `${dateStr}.json`);
  const gold = readJson(goldPath, null) || {};
  const abstain = readJson(abstainPath, null) || {};
  const execution = readJson(policy.paths.execution_slo_latest, { ok: true, execution_green: true });

  const metrics = {
    precision: clampNumber(gold.metrics && gold.metrics.precision, 0, 1, 0),
    recall: clampNumber(gold.metrics && gold.metrics.recall, 0, 1, 0),
    f1: clampNumber(gold.metrics && gold.metrics.f1, 0, 1, 0),
    brier: clampNumber(gold.metrics && gold.metrics.brier, 0, 1, 1),
    abstain_rate: clampNumber(
      Number(abstain.abstain_count || 0) / Math.max(1, Number(abstain.source_hypothesis_count || 0)),
      0,
      1,
      0
    )
  };

  const reasons = [];
  if (metrics.precision < Number(policy.slo.min_precision || 0.62)) reasons.push('precision_below_slo');
  if (metrics.recall < Number(policy.slo.min_recall || 0.55)) reasons.push('recall_below_slo');
  if (metrics.f1 < Number(policy.slo.min_f1 || 0.58)) reasons.push('f1_below_slo');
  if (metrics.brier > Number(policy.slo.max_brier || 0.28)) reasons.push('brier_above_slo');
  if (metrics.abstain_rate > Number(policy.slo.max_abstain_rate || 0.45)) reasons.push('abstain_rate_above_slo');

  const analysisPass = reasons.length === 0;
  const executionGreen = execution && (execution.execution_green !== false);

  const out = {
    ok: analysisPass,
    type: 'analysis_quality_slo_contract',
    ts: nowIso(),
    date: dateStr,
    source_paths: {
      gold_eval: goldPath,
      abstain: abstainPath,
      execution_slo: policy.paths.execution_slo_latest
    },
    analysis_metrics: metrics,
    slo: policy.slo,
    analysis_pass: analysisPass,
    execution_green: executionGreen,
    promotion_gate_pass: analysisPass,
    reasons,
    slo_receipt_id: `aslo_${stableHash(`${dateStr}|${metrics.f1}|${metrics.brier}|${analysisPass}`, 20)}`
  };

  ensureDir(policy.paths.output_dir);
  writeJsonAtomic(path.join(policy.paths.output_dir, `${dateStr}.json`), out);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, {
    ts: nowIso(),
    type: 'analysis_quality_slo_receipt',
    date: dateStr,
    analysis_pass: analysisPass,
    execution_green: executionGreen,
    promotion_gate_pass: out.promotion_gate_pass,
    reasons,
    slo_receipt_id: out.slo_receipt_id
  });

  if (strict && !analysisPass) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function status(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.output_dir, `${dateStr}.json`);
  const payload = readJson(fp, {
    ok: true,
    type: 'analysis_quality_slo_contract_status',
    date: dateStr,
    analysis_pass: true,
    promotion_gate_pass: true
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usageAndExit(code = 0) {
  console.log('Usage:');
  console.log('  node systems/sensory/analysis_quality_slo_contract.js run [YYYY-MM-DD] [--strict=1] [--policy=<path>]');
  console.log('  node systems/sensory/analysis_quality_slo_contract.js status [YYYY-MM-DD] [--policy=<path>]');
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
