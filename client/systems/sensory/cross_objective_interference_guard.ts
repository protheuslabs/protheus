#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-105
 * Cross-objective interference guard.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.CROSS_OBJECTIVE_GUARD_POLICY_PATH
  ? path.resolve(process.env.CROSS_OBJECTIVE_GUARD_POLICY_PATH)
  : path.join(ROOT, 'config', 'cross_objective_interference_guard_policy.json');

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
    default_max_negative_delta: 0.03,
    objective_interference_budget: {
      T1_make_jay_billionaire_v1: 0.02,
      T1_generational_wealth_v1: 0.03
    },
    paths: {
      input_dir: 'state/sensory/analysis/objective_interference',
      output_dir: 'state/sensory/analysis/objective_interference_guard',
      latest_path: 'state/sensory/analysis/objective_interference_guard/latest.json',
      receipts_path: 'state/sensory/analysis/objective_interference_guard/receipts.jsonl'
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
    default_max_negative_delta: clampNumber(raw.default_max_negative_delta, 0, 1, base.default_max_negative_delta),
    objective_interference_budget: raw.objective_interference_budget && typeof raw.objective_interference_budget === 'object'
      ? raw.objective_interference_budget
      : base.objective_interference_budget,
    paths: {
      input_dir: resolvePath(paths.input_dir, base.paths.input_dir),
      output_dir: resolvePath(paths.output_dir, base.paths.output_dir),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function run(dateStr: string, policy: Record<string, any>, strict = false) {
  const inputPath = path.join(policy.paths.input_dir, `${dateStr}.json`);
  const src = readJson(inputPath, { objectives: [], candidate_id: null });
  const objectives = Array.isArray(src.objectives) ? src.objectives : [];

  const matrix = [];
  const blocked = [];

  for (const row of objectives) {
    const objectiveId = cleanText(row && row.objective_id || '', 120) || 'unknown_objective';
    const before = clampNumber(row && row.before_metric, -1, 1, 0);
    const after = clampNumber(row && row.after_metric, -1, 1, 0);
    const delta = Number((after - before).toFixed(6));
    const budget = clampNumber(
      policy.objective_interference_budget && policy.objective_interference_budget[objectiveId],
      0,
      1,
      Number(policy.default_max_negative_delta || 0.03)
    );
    const withinBudget = delta >= -budget;

    const entry = {
      objective_id: objectiveId,
      before_metric: Number(before.toFixed(6)),
      after_metric: Number(after.toFixed(6)),
      delta,
      max_negative_delta_budget: Number(budget.toFixed(6)),
      within_budget: withinBudget
    };

    matrix.push(entry);
    if (!withinBudget) blocked.push(entry);
  }

  const out = {
    ok: blocked.length === 0,
    type: 'cross_objective_interference_guard',
    ts: nowIso(),
    date: dateStr,
    candidate_id: cleanText(src.candidate_id || '', 120) || null,
    source_path: inputPath,
    objective_matrix: matrix,
    blocked_objectives: blocked,
    promotion_blocked: blocked.length > 0,
    guard_receipt_id: `coi_${stableHash(`${dateStr}|${src.candidate_id}|${blocked.length}`, 20)}`
  };

  ensureDir(policy.paths.output_dir);
  writeJsonAtomic(path.join(policy.paths.output_dir, `${dateStr}.json`), out);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, {
    ts: nowIso(),
    type: 'cross_objective_interference_receipt',
    date: dateStr,
    candidate_id: out.candidate_id,
    blocked_objective_count: blocked.length,
    promotion_blocked: out.promotion_blocked,
    guard_receipt_id: out.guard_receipt_id
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
    type: 'cross_objective_interference_guard_status',
    date: dateStr,
    promotion_blocked: false
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usageAndExit(code = 0) {
  console.log('Usage:');
  console.log('  node systems/sensory/cross_objective_interference_guard.js run [YYYY-MM-DD] [--strict=1] [--policy=<path>]');
  console.log('  node systems/sensory/cross_objective_interference_guard.js status [YYYY-MM-DD] [--policy=<path>]');
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
