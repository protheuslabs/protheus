#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-094
 * Ensemble disagreement escalation lane.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.ENSEMBLE_DISAGREEMENT_POLICY_PATH
  ? path.resolve(process.env.ENSEMBLE_DISAGREEMENT_POLICY_PATH)
  : path.join(ROOT, 'config', 'ensemble_disagreement_escalation_policy.json');

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
    disagreement_threshold: 0.32,
    min_models: 3,
    high_risk_disagreement_threshold: 0.24,
    paths: {
      ensemble_pack_dir: 'state/sensory/eval/ensemble',
      output_dir: 'state/sensory/analysis/ensemble_disagreement',
      latest_path: 'state/sensory/analysis/ensemble_disagreement/latest.json',
      receipts_path: 'state/sensory/analysis/ensemble_disagreement/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    disagreement_threshold: clampNumber(raw.disagreement_threshold, 0, 1, base.disagreement_threshold),
    min_models: clampNumber(raw.min_models, 2, 20, base.min_models),
    high_risk_disagreement_threshold: clampNumber(raw.high_risk_disagreement_threshold, 0, 1, base.high_risk_disagreement_threshold),
    paths: {
      ensemble_pack_dir: resolvePath(paths.ensemble_pack_dir, base.paths.ensemble_pack_dir),
      output_dir: resolvePath(paths.output_dir, base.paths.output_dir),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadPack(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.ensemble_pack_dir, `${dateStr}.json`);
  const src = readJson(fp, null);
  const items = src && Array.isArray(src.items) ? src.items : [];
  return {
    file_path: fp,
    items: items.filter((row: any) => row && typeof row === 'object')
  };
}

function disagreementStats(scores: number[]) {
  if (!Array.isArray(scores) || scores.length === 0) {
    return { mean: 0, stddev: 0, range: 0 };
  }
  const mean = scores.reduce((sum, row) => sum + row, 0) / scores.length;
  const variance = scores.reduce((sum, row) => sum + ((row - mean) ** 2), 0) / scores.length;
  const stddev = Math.sqrt(variance);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  return {
    mean,
    stddev,
    range: max - min
  };
}

function run(dateStr: string, policy: Record<string, any>, strict = false) {
  const pack = loadPack(policy, dateStr);
  const adjudication = [];
  const scored = [];

  for (const row of pack.items) {
    const scoresObj = row && row.model_scores && typeof row.model_scores === 'object' ? row.model_scores : {};
    const values = Object.values(scoresObj).map((v) => clampNumber(v, 0, 1, 0)).filter((v) => Number.isFinite(v));
    if (values.length < Number(policy.min_models || 3)) continue;

    const stats = disagreementStats(values as number[]);
    const risk = cleanText(row && row.risk_tier || 'normal', 40);
    const threshold = risk === 'high'
      ? Number(policy.high_risk_disagreement_threshold || 0.24)
      : Number(policy.disagreement_threshold || 0.32);

    const disagree = Number(stats.stddev || 0) >= threshold || Number(stats.range || 0) >= threshold;

    const itemOut = {
      item_id: cleanText(row && row.id || `item_${stableHash(JSON.stringify(row), 10)}`, 120),
      risk_tier: risk,
      model_count: values.length,
      mean_score: Number(stats.mean.toFixed(6)),
      disagreement_stddev: Number(stats.stddev.toFixed(6)),
      disagreement_range: Number(stats.range.toFixed(6)),
      threshold: Number(threshold.toFixed(6)),
      action: disagree ? 'escalate' : 'accept',
      adjudication_required: disagree
    };

    scored.push(itemOut);
    if (disagree) {
      adjudication.push({
        adjudication_id: `ens_${stableHash(`${dateStr}|${itemOut.item_id}|${itemOut.disagreement_stddev}|${itemOut.disagreement_range}`, 20)}`,
        item_id: itemOut.item_id,
        reason: 'high_ensemble_divergence',
        risk_tier: itemOut.risk_tier,
        disagreement_stddev: itemOut.disagreement_stddev,
        disagreement_range: itemOut.disagreement_range,
        route: 'human_or_champion_review_queue'
      });
    }
  }

  const out = {
    ok: true,
    type: 'ensemble_disagreement_escalation_lane',
    ts: nowIso(),
    date: dateStr,
    source_pack_path: pack.file_path,
    scored_count: scored.length,
    escalated_count: adjudication.length,
    scored,
    adjudication_queue: adjudication
  };

  ensureDir(policy.paths.output_dir);
  writeJsonAtomic(path.join(policy.paths.output_dir, `${dateStr}.json`), out);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, {
    ts: nowIso(),
    type: 'ensemble_disagreement_receipt',
    date: dateStr,
    scored_count: scored.length,
    escalated_count: adjudication.length,
    top_escalation: adjudication[0] ? adjudication[0].adjudication_id : null
  });

  if (strict && adjudication.length === 0) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function status(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.output_dir, `${dateStr}.json`);
  const payload = readJson(fp, {
    ok: true,
    type: 'ensemble_disagreement_escalation_lane_status',
    date: dateStr,
    escalated_count: 0
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usageAndExit(code = 0) {
  console.log('Usage:');
  console.log('  node systems/sensory/ensemble_disagreement_escalation_lane.js run [YYYY-MM-DD] [--strict=1] [--policy=<path>]');
  console.log('  node systems/sensory/ensemble_disagreement_escalation_lane.js status [YYYY-MM-DD] [--policy=<path>]');
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
