#!/usr/bin/env node
'use strict';

/**
 * scale_benchmark.js
 *
 * Reproducible scale/performance benchmarking harness.
 *
 * Usage:
 *   node systems/ops/scale_benchmark.js run [--tier=all|smoke|baseline|stress] [--strict=1|0]
 *   node systems/ops/scale_benchmark.js status
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.SCALE_BENCHMARK_POLICY_PATH
  ? path.resolve(process.env.SCALE_BENCHMARK_POLICY_PATH)
  : path.join(ROOT, 'config', 'scale_benchmark_policy.json');
const REPORT_DIR = process.env.SCALE_BENCHMARK_REPORT_DIR
  ? path.resolve(process.env.SCALE_BENCHMARK_REPORT_DIR)
  : path.join(ROOT, 'state', 'ops', 'scale_benchmark');
const HISTORY_PATH = process.env.SCALE_BENCHMARK_HISTORY_PATH
  ? path.resolve(process.env.SCALE_BENCHMARK_HISTORY_PATH)
  : path.join(REPORT_DIR, 'history.jsonl');

function nowIso() {
  return new Date().toISOString();
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/scale_benchmark.js run [--tier=all|smoke|baseline|stress] [--strict=1|0]');
  console.log('  node systems/ops/scale_benchmark.js status');
}

function parseArgs(argv) {
  const out = { _: [] };
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

function normalizeText(v, maxLen = 240) {
  return String(v == null ? '' : v).trim().slice(0, maxLen);
}

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  const s = normalizeText(v, 24).toLowerCase();
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
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  ensureDir(filePath);
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, row) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    strict_default: true,
    tiers: [
      {
        id: 'smoke',
        operations: 200,
        synthetic_tokens_per_op: 600,
        max_error_rate: 0.02,
        max_p95_latency_ms: 6,
        min_throughput_ops_sec: 800
      },
      {
        id: 'baseline',
        operations: 1500,
        synthetic_tokens_per_op: 900,
        max_error_rate: 0.03,
        max_p95_latency_ms: 8,
        min_throughput_ops_sec: 650
      },
      {
        id: 'stress',
        operations: 3000,
        synthetic_tokens_per_op: 1200,
        max_error_rate: 0.04,
        max_p95_latency_ms: 10,
        min_throughput_ops_sec: 500
      }
    ]
  };
}

function normalizeTier(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const id = normalizeText(src.id || '', 80)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!id) return null;
  return {
    id,
    operations: Math.max(10, Number(src.operations || 100)),
    synthetic_tokens_per_op: Math.max(1, Number(src.synthetic_tokens_per_op || 500)),
    max_error_rate: Math.max(0, Math.min(1, Number(src.max_error_rate == null ? 0.05 : src.max_error_rate))),
    max_p95_latency_ms: Math.max(1, Number(src.max_p95_latency_ms || 10)),
    min_throughput_ops_sec: Math.max(1, Number(src.min_throughput_ops_sec || 200))
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  const tiersRaw = Array.isArray(src.tiers) && src.tiers.length ? src.tiers : base.tiers;
  const tiers = tiersRaw.map(normalizeTier).filter(Boolean);
  return {
    version: normalizeText(src.version || base.version, 32) || '1.0',
    strict_default: src.strict_default !== false,
    tiers
  };
}

function percentile(values, q) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const arr = values.slice().sort((a, b) => a - b);
  const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil(q * arr.length) - 1));
  return Number(arr[idx].toFixed(6));
}

function syntheticWork(tierId, index) {
  // Deterministic CPU-only workload.
  const seed = `${tierId}:${index}:scale-benchmark`;
  let payload = seed;
  for (let i = 0; i < 8; i += 1) {
    payload = crypto.createHash('sha256').update(payload).digest('hex');
  }
  const byte0 = parseInt(payload.slice(0, 2), 16);
  const byte1 = parseInt(payload.slice(2, 4), 16);
  const success = byte0 > 2; // ~98.8% synthetic success rate.
  const tokenFactor = Math.max(1, byte1);
  return {
    success,
    token_factor: tokenFactor / 255,
    checksum: payload.slice(0, 12)
  };
}

function runTier(tier) {
  const latencies = [];
  let failures = 0;
  let tokenTotal = 0;
  const started = Date.now();
  for (let i = 0; i < tier.operations; i += 1) {
    const opStart = process.hrtime.bigint();
    const out = syntheticWork(tier.id, i);
    const opEnd = process.hrtime.bigint();
    const latencyMs = Number(opEnd - opStart) / 1e6;
    latencies.push(latencyMs);
    if (!out.success) failures += 1;
    tokenTotal += Math.round(tier.synthetic_tokens_per_op * out.token_factor);
  }
  const durationMs = Math.max(1, Date.now() - started);
  const throughput = Number((tier.operations / (durationMs / 1000)).toFixed(4));
  const errorRate = Number((failures / tier.operations).toFixed(6));
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  const tokenEfficiency = Number((tokenTotal / Math.max(1, durationMs)).toFixed(4)); // tokens/ms

  const checks = {
    error_rate_ok: errorRate <= tier.max_error_rate,
    p95_latency_ok: p95 != null && p95 <= tier.max_p95_latency_ms,
    throughput_ok: throughput >= tier.min_throughput_ops_sec
  };
  const pass = checks.error_rate_ok && checks.p95_latency_ok && checks.throughput_ok;
  const bottlenecks = [];
  if (!checks.error_rate_ok) bottlenecks.push('error_budget_exceeded');
  if (!checks.p95_latency_ok) bottlenecks.push('latency_budget_exceeded');
  if (!checks.throughput_ok) bottlenecks.push('throughput_below_floor');

  return {
    tier: tier.id,
    pass,
    operations: tier.operations,
    duration_ms: durationMs,
    latency_ms: {
      p50,
      p95
    },
    throughput_ops_sec: throughput,
    error_rate: errorRate,
    synthetic_tokens_total: tokenTotal,
    token_efficiency_tokens_per_ms: tokenEfficiency,
    thresholds: {
      max_error_rate: tier.max_error_rate,
      max_p95_latency_ms: tier.max_p95_latency_ms,
      min_throughput_ops_sec: tier.min_throughput_ops_sec
    },
    checks,
    bottlenecks
  };
}

function cmdRun(args) {
  const policy = loadPolicy();
  const strict = toBool(args.strict, policy.strict_default);
  const selector = normalizeText(args.tier || 'all', 80).toLowerCase();
  const tiers = selector === 'all'
    ? policy.tiers
    : policy.tiers.filter((row) => row.id === selector);
  if (!tiers.length) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'tier_not_found', tier: selector }) + '\n');
    process.exit(2);
  }

  const started = Date.now();
  const rows = tiers.map((tier) => runTier(tier));
  const failed = rows.filter((row) => row.pass !== true);
  const out = {
    ok: failed.length === 0,
    type: 'scale_benchmark_run',
    ts: nowIso(),
    strict,
    policy_version: policy.version,
    selector,
    tiers_run: rows.map((row) => row.tier),
    duration_ms: Date.now() - started,
    rows
  };

  const reportPath = path.join(REPORT_DIR, `${nowIso().slice(0, 10)}__${Date.now()}.json`);
  writeJsonAtomic(reportPath, out);
  appendJsonl(HISTORY_PATH, {
    ts: nowIso(),
    type: 'scale_benchmark_summary',
    ok: out.ok,
    selector,
    tiers_run: out.tiers_run,
    failed_tiers: failed.map((row) => row.tier),
    report_path: relPath(reportPath)
  });

  process.stdout.write(JSON.stringify({ ...out, report_path: relPath(reportPath) }, null, 2) + '\n');
  if (strict && out.ok !== true) process.exit(1);
}

function cmdStatus() {
  const history = readJsonl(HISTORY_PATH)
    .filter((row) => row && row.type === 'scale_benchmark_summary')
    .slice(-20);
  const fail = history.filter((row) => row.ok !== true).length;
  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'scale_benchmark_status',
    ts: nowIso(),
    history_path: relPath(HISTORY_PATH),
    recent_runs: history.length,
    recent_failures: fail,
    pass_rate: history.length > 0 ? Number(((history.length - fail) / history.length).toFixed(4)) : null,
    last: history.length > 0 ? history[history.length - 1] : null
  }, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeText(args._[0], 64).toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus();
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  runTier
};
export {};
