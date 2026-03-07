#!/usr/bin/env node
'use strict';

/**
 * dr_gameday_gate.js
 *
 * Release gate for disaster-recovery game-day quality.
 * Fails closed only when sufficient sample volume exists and regressions breach policy.
 *
 * Usage:
 *   node systems/ops/dr_gameday_gate.js run [--limit=N] [--strict=1|0]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.DR_GAMEDAY_POLICY_PATH
  ? path.resolve(process.env.DR_GAMEDAY_POLICY_PATH)
  : path.join(ROOT, 'config', 'dr_gameday_policy.json');
const RECEIPTS_PATH = process.env.DR_GAMEDAY_RECEIPTS_PATH
  ? path.resolve(process.env.DR_GAMEDAY_RECEIPTS_PATH)
  : path.join(ROOT, 'state', 'ops', 'dr_gameday_receipts.jsonl');
const GATE_RECEIPTS_PATH = process.env.DR_GAMEDAY_GATE_RECEIPTS_PATH
  ? path.resolve(process.env.DR_GAMEDAY_GATE_RECEIPTS_PATH)
  : path.join(ROOT, 'state', 'ops', 'dr_gameday_gate_receipts.jsonl');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/dr_gameday_gate.js run [--limit=N] [--strict=1|0]');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function toBool(v, fallback) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

function median(values) {
  const clean = values
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  if (clean.length % 2 === 0) return Number(((clean[mid - 1] + clean[mid]) / 2).toFixed(6));
  return Number(clean[mid].toFixed(6));
}

function safeRatio(cur, base) {
  const c = Number(cur);
  const b = Number(base);
  if (!Number.isFinite(c) || !Number.isFinite(b) || b <= 0) return null;
  return Number(((c - b) / b).toFixed(6));
}

function loadPolicy() {
  const raw = readJson(POLICY_PATH, {});
  const gate = raw && raw.release_gate && typeof raw.release_gate === 'object'
    ? raw.release_gate
    : {};
  return {
    version: String(raw.version || '1.0'),
    gate_window: Math.max(1, Number(gate.window || 6)),
    gate_min_samples: Math.max(1, Number(gate.min_samples || 3)),
    required_pass_rate: Math.max(0, Math.min(1, Number(gate.required_pass_rate == null ? 1 : gate.required_pass_rate))),
    max_rto_regression_ratio: Math.max(0, Number(gate.max_rto_regression_ratio == null ? 0.15 : gate.max_rto_regression_ratio)),
    max_rpo_regression_ratio: Math.max(0, Number(gate.max_rpo_regression_ratio == null ? 0.15 : gate.max_rpo_regression_ratio)),
    strict_default: toBool(gate.strict_default, true)
  };
}

function pickRows(limit) {
  const rows = readJsonl(RECEIPTS_PATH)
    .filter((row) => row && String(row.type || '') === 'dr_gameday');
  const lim = Math.max(1, Number(limit || 6));
  if (rows.length <= lim) return rows;
  return rows.slice(-lim);
}

function evaluate(rows, policy) {
  const latest = rows.slice(-Math.max(1, Number(policy.gate_window || 6)));
  const older = rows.slice(0, Math.max(0, rows.length - latest.length));
  const passCount = latest.filter((row) => row && row.ok === true).length;
  const passRate = latest.length > 0 ? Number((passCount / latest.length).toFixed(6)) : 0;

  const latestRto = median(latest.map((row) => row && row.metrics && row.metrics.rto_minutes));
  const latestRpo = median(latest.map((row) => row && row.metrics && row.metrics.rpo_hours));
  const olderRto = median(older.map((row) => row && row.metrics && row.metrics.rto_minutes));
  const olderRpo = median(older.map((row) => row && row.metrics && row.metrics.rpo_hours));
  const rtoRegression = safeRatio(latestRto, olderRto);
  const rpoRegression = safeRatio(latestRpo, olderRpo);

  const enoughSamples = latest.length >= Number(policy.gate_min_samples || 3);
  const enoughBaseline = older.length >= Math.max(2, Number(policy.gate_min_samples || 3));

  const passRateOk = !enoughSamples || passRate >= Number(policy.required_pass_rate || 1);
  const rtoOk = !enoughSamples || !enoughBaseline || rtoRegression == null
    || rtoRegression <= Number(policy.max_rto_regression_ratio || 0.15);
  const rpoOk = !enoughSamples || !enoughBaseline || rpoRegression == null
    || rpoRegression <= Number(policy.max_rpo_regression_ratio || 0.15);

  const reasons = [] as string[];
  if (enoughSamples && !passRateOk) reasons.push('pass_rate_below_target');
  if (enoughSamples && enoughBaseline && !rtoOk) reasons.push('rto_regressed');
  if (enoughSamples && enoughBaseline && !rpoOk) reasons.push('rpo_regressed');
  if (!enoughSamples) reasons.push('insufficient_recent_samples');
  else if (!enoughBaseline) reasons.push('insufficient_baseline_samples');

  return {
    ok: passRateOk && rtoOk && rpoOk,
    pass_rate: passRate,
    enough_samples: enoughSamples,
    enough_baseline: enoughBaseline,
    latest_count: latest.length,
    older_count: older.length,
    latest_medians: {
      rto_minutes: latestRto,
      rpo_hours: latestRpo
    },
    baseline_medians: {
      rto_minutes: olderRto,
      rpo_hours: olderRpo
    },
    regressions: {
      rto_ratio: rtoRegression,
      rpo_ratio: rpoRegression
    },
    reasons
  };
}

function cmdRun(args) {
  const policy = loadPolicy();
  const strict = toBool(args.strict, policy.strict_default);
  const rows = pickRows(Number(args.limit || Math.max(policy.gate_window * 2, 8)));
  const evalOut = evaluate(rows, policy);

  const out = {
    ok: evalOut.ok,
    type: 'dr_gameday_gate',
    ts: nowIso(),
    strict,
    receipts_path: path.relative(ROOT, RECEIPTS_PATH),
    policy: {
      version: policy.version,
      gate_window: policy.gate_window,
      gate_min_samples: policy.gate_min_samples,
      required_pass_rate: policy.required_pass_rate,
      max_rto_regression_ratio: policy.max_rto_regression_ratio,
      max_rpo_regression_ratio: policy.max_rpo_regression_ratio
    },
    evaluation: evalOut
  };

  appendJsonl(GATE_RECEIPTS_PATH, out);
  process.stdout.write(JSON.stringify(out) + '\n');
  if (strict && out.ok !== true) process.exitCode = 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    return;
  }
  if (cmd === 'run') return cmdRun(args);
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: String(err && err.message || err || 'dr_gameday_gate_failed')
    }) + '\n');
    process.exit(1);
  }
}

module.exports = {
  evaluate,
  loadPolicy,
  parseArgs
};
export {};
