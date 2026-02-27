#!/usr/bin/env node
'use strict';
export {};

/**
 * capital_allocation_organ.js
 *
 * V3-BRG-002: controlled capital allocation + reinvestment loop.
 *
 * Usage:
 *   node systems/budget/capital_allocation_organ.js seed --balance=1000
 *   node systems/budget/capital_allocation_organ.js simulate --bucket=compute --amount=50 --expected-return=0.15 --risk-score=0.3
 *   node systems/budget/capital_allocation_organ.js allocate --bucket=compute --amount=50 --simulation-id=<id> [--strict=1|0]
 *   node systems/budget/capital_allocation_organ.js settle --allocation-id=<id> --actual-return=0.08
 *   node systems/budget/capital_allocation_organ.js evaluate [--days=30] [--strict=1|0]
 *   node systems/budget/capital_allocation_organ.js status [--days=30]
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.CAPITAL_ALLOCATION_POLICY_PATH
  ? path.resolve(String(process.env.CAPITAL_ALLOCATION_POLICY_PATH))
  : path.join(ROOT, 'config', 'capital_allocation_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function clean(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return clean(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok || '').slice(2)] = true;
    else out[String(tok || '').slice(2, idx)] = String(tok || '').slice(idx + 1);
  }
  return out;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: false,
    min_simulation_score: 0.6,
    min_risk_adjusted_return: 0,
    buckets: {
      compute: { max_share: 0.5, drawdown_stop_pct: 0.3 },
      tools: { max_share: 0.25, drawdown_stop_pct: 0.25 },
      ads: { max_share: 0.2, drawdown_stop_pct: 0.35 },
      float: { max_share: 0.25, drawdown_stop_pct: 0.2 }
    },
    state_path: 'state/budget/capital_allocation/state.json',
    latest_path: 'state/budget/capital_allocation/latest.json',
    receipts_path: 'state/budget/capital_allocation/receipts.jsonl'
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const bucketsRaw = raw.buckets && typeof raw.buckets === 'object' ? raw.buckets : base.buckets;
  const buckets: Record<string, AnyObj> = {};
  for (const [bucketIdRaw, cfgRaw] of Object.entries(bucketsRaw)) {
    const bucketId = normalizeToken(bucketIdRaw, 80);
    if (!bucketId) continue;
    const cfg = cfgRaw && typeof cfgRaw === 'object' ? cfgRaw as AnyObj : {};
    buckets[bucketId] = {
      max_share: clampNum(cfg.max_share, 0, 1, 0.2),
      drawdown_stop_pct: clampNum(cfg.drawdown_stop_pct, 0, 1, 0.3)
    };
  }
  const rootPath = (v: unknown, fallback: string) => {
    const text = clean(v || fallback, 320);
    return path.isAbsolute(text) ? path.resolve(text) : path.join(ROOT, text);
  };
  return {
    version: clean(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    strict_default: toBool(raw.strict_default, base.strict_default),
    min_simulation_score: clampNum(raw.min_simulation_score, 0, 1, base.min_simulation_score),
    min_risk_adjusted_return: clampNum(raw.min_risk_adjusted_return, -10, 10, base.min_risk_adjusted_return),
    buckets,
    state_path: rootPath(raw.state_path, base.state_path),
    latest_path: rootPath(raw.latest_path, base.latest_path),
    receipts_path: rootPath(raw.receipts_path, base.receipts_path),
    policy_path: path.resolve(policyPath)
  };
}

function defaultState(policy: AnyObj) {
  const bucketState: Record<string, AnyObj> = {};
  for (const bucketId of Object.keys(policy.buckets || {})) {
    bucketState[bucketId] = {
      allocated: 0,
      realized_return: 0,
      peak_equity: 0
    };
  }
  return {
    schema_id: 'capital_allocation_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    cash_balance: 0,
    buckets: bucketState,
    simulations: {},
    allocations: {}
  };
}

function loadState(policy: AnyObj) {
  const state = readJson(policy.state_path, defaultState(policy));
  const base = defaultState(policy);
  return {
    schema_id: 'capital_allocation_state',
    schema_version: '1.0',
    updated_at: clean(state.updated_at || nowIso(), 40) || nowIso(),
    cash_balance: clampNum(state.cash_balance, -1e12, 1e12, 0),
    buckets: state.buckets && typeof state.buckets === 'object' ? state.buckets : base.buckets,
    simulations: state.simulations && typeof state.simulations === 'object' ? state.simulations : {},
    allocations: state.allocations && typeof state.allocations === 'object' ? state.allocations : {}
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.state_path, {
    ...state,
    updated_at: nowIso()
  });
}

function ensureBucket(state: AnyObj, bucketId: string) {
  if (!state.buckets[bucketId]) {
    state.buckets[bucketId] = {
      allocated: 0,
      realized_return: 0,
      peak_equity: 0
    };
  }
  return state.buckets[bucketId];
}

function bucketEquity(bucket: AnyObj) {
  return Number(bucket.allocated || 0) + Number(bucket.realized_return || 0);
}

function cmdSeed(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const balance = clampNum(args.balance, 0, 1e12, 0);
  state.cash_balance = balance;
  for (const bucketId of Object.keys(policy.buckets || {})) {
    const bucket = ensureBucket(state, bucketId);
    bucket.peak_equity = Math.max(Number(bucket.peak_equity || 0), bucketEquity(bucket));
  }
  saveState(policy, state);
  const out = {
    ok: true,
    type: 'capital_allocation_seed',
    ts: nowIso(),
    cash_balance: state.cash_balance,
    policy_path: rel(policy.policy_path)
  };
  writeJsonAtomic(policy.latest_path, out);
  appendJsonl(policy.receipts_path, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function cmdSimulate(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const bucketId = normalizeToken(args.bucket || '', 80);
  if (!bucketId || !policy.buckets[bucketId]) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'capital_allocation_simulate', error: 'invalid_bucket', bucket: bucketId || null, allowed: Object.keys(policy.buckets || {}) })}\n`);
    process.exit(1);
  }
  const amount = clampNum(args.amount, 0.01, 1e12, 0);
  const expectedReturn = clampNum(args['expected-return'] || args.expected_return, -1, 10, 0);
  const riskScore = clampNum(args['risk-score'] || args.risk_score, 0, 1, 0.5);
  const simulationScore = Number((Math.max(0, expectedReturn) * (1 - riskScore)).toFixed(4));
  const simId = `${bucketId}_${Date.now()}`;
  state.simulations[simId] = {
    simulation_id: simId,
    bucket_id: bucketId,
    amount,
    expected_return: expectedReturn,
    risk_score: riskScore,
    score: simulationScore,
    passed: simulationScore >= policy.min_simulation_score,
    ts: nowIso()
  };
  saveState(policy, state);
  const out = {
    ok: true,
    type: 'capital_allocation_simulate',
    ts: nowIso(),
    simulation: state.simulations[simId],
    policy_path: rel(policy.policy_path)
  };
  writeJsonAtomic(policy.latest_path, out);
  appendJsonl(policy.receipts_path, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function cmdAllocate(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const strict = toBool(args.strict, policy.strict_default === true);
  const state = loadState(policy);
  const bucketId = normalizeToken(args.bucket || '', 80);
  const simId = normalizeToken(args['simulation-id'] || args.simulation_id || '', 120);
  if (!bucketId || !policy.buckets[bucketId]) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'capital_allocation_allocate', error: 'invalid_bucket', bucket: bucketId || null })}\n`);
    process.exit(1);
  }
  if (!simId || !state.simulations[simId]) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'capital_allocation_allocate', error: 'simulation_not_found', simulation_id: simId || null })}\n`);
    process.exit(1);
  }
  const simulation = state.simulations[simId];
  if (simulation.passed !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'capital_allocation_allocate', error: 'simulation_failed', simulation_id: simId, score: simulation.score, min_simulation_score: policy.min_simulation_score })}\n`);
    process.exit(1);
  }
  const amount = clampNum(args.amount != null ? args.amount : simulation.amount, 0.01, 1e12, simulation.amount || 0);
  if (amount > state.cash_balance) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'capital_allocation_allocate', error: 'insufficient_cash_balance', cash_balance: state.cash_balance, amount })}\n`);
    process.exit(1);
  }
  const bucket = ensureBucket(state, bucketId);
  const cfg = policy.buckets[bucketId];
  const currentAllocated = clampNum(bucket.allocated, 0, 1e12, 0);
  const nextAllocated = currentAllocated + amount;
  const maxAllowed = clampNum(cfg.max_share, 0, 1, 1) * clampNum(state.cash_balance + Object.values(state.buckets).reduce((acc: number, row: AnyObj) => acc + clampNum(row.allocated, 0, 1e12, 0), 0), 0, 1e12, 0);
  if (nextAllocated > maxAllowed) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'capital_allocation_allocate', error: 'bucket_share_cap_exceeded', bucket_id: bucketId, requested_allocated: nextAllocated, max_allowed: Number(maxAllowed.toFixed(4)) })}\n`);
    process.exit(1);
  }
  const equity = bucketEquity(bucket);
  const peak = Math.max(Number(bucket.peak_equity || 0), equity);
  const drawdown = peak <= 0 ? 0 : Math.max(0, (peak - equity) / peak);
  if (drawdown >= clampNum(cfg.drawdown_stop_pct, 0, 1, 1)) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'capital_allocation_allocate', error: 'drawdown_stop_triggered', bucket_id: bucketId, drawdown: Number(drawdown.toFixed(4)), drawdown_stop_pct: cfg.drawdown_stop_pct })}\n`);
    process.exit(1);
  }
  const allocationId = `${bucketId}_${Date.now()}`;
  state.cash_balance = Number((state.cash_balance - amount).toFixed(4));
  bucket.allocated = Number((currentAllocated + amount).toFixed(4));
  bucket.peak_equity = Math.max(peak, bucketEquity(bucket));
  state.allocations[allocationId] = {
    allocation_id: allocationId,
    bucket_id: bucketId,
    amount,
    simulation_id: simId,
    status: 'open',
    allocated_at: nowIso(),
    expected_return: simulation.expected_return,
    risk_score: simulation.risk_score
  };
  saveState(policy, state);
  const out = {
    ok: true,
    type: 'capital_allocation_allocate',
    ts: nowIso(),
    allocation: state.allocations[allocationId],
    cash_balance: state.cash_balance,
    bucket_state: bucket,
    policy_path: rel(policy.policy_path)
  };
  writeJsonAtomic(policy.latest_path, out);
  appendJsonl(policy.receipts_path, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (strict && out.ok !== true) process.exit(1);
}

function cmdSettle(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const allocationId = normalizeToken(args['allocation-id'] || args.allocation_id || '', 160);
  const actualReturn = clampNum(args['actual-return'] || args.actual_return, -1, 10, 0);
  if (!allocationId || !state.allocations[allocationId]) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'capital_allocation_settle', error: 'allocation_not_found', allocation_id: allocationId || null })}\n`);
    process.exit(1);
  }
  const allocation = state.allocations[allocationId];
  if (allocation.status !== 'open') {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'capital_allocation_settle', error: 'allocation_not_open', allocation_id: allocationId, status: allocation.status })}\n`);
    process.exit(1);
  }
  const bucket = ensureBucket(state, allocation.bucket_id);
  const pnl = Number((Number(allocation.amount || 0) * actualReturn).toFixed(4));
  bucket.allocated = Number((Number(bucket.allocated || 0) - Number(allocation.amount || 0)).toFixed(4));
  bucket.realized_return = Number((Number(bucket.realized_return || 0) + pnl).toFixed(4));
  bucket.peak_equity = Math.max(Number(bucket.peak_equity || 0), bucketEquity(bucket));
  state.cash_balance = Number((state.cash_balance + Number(allocation.amount || 0) + pnl).toFixed(4));
  allocation.status = 'settled';
  allocation.settled_at = nowIso();
  allocation.actual_return = actualReturn;
  allocation.pnl = pnl;
  saveState(policy, state);
  const out = {
    ok: true,
    type: 'capital_allocation_settle',
    ts: nowIso(),
    allocation,
    cash_balance: state.cash_balance,
    bucket_state: bucket,
    policy_path: rel(policy.policy_path)
  };
  writeJsonAtomic(policy.latest_path, out);
  appendJsonl(policy.receipts_path, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function evaluateWindow(policy: AnyObj, days: number) {
  const state = loadState(policy);
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const settled = Object.values(state.allocations || {})
    .filter((row: AnyObj) => row && row.status === 'settled')
    .filter((row: AnyObj) => {
      const ts = Date.parse(clean(row.settled_at || '', 40));
      return Number.isFinite(ts) && ts >= cutoffMs;
    });
  const returns = settled.map((row: AnyObj) => Number(row.actual_return || 0));
  const mean = returns.length ? returns.reduce((a: number, b: number) => a + b, 0) / returns.length : 0;
  const variance = returns.length
    ? returns.reduce((acc: number, r: number) => acc + ((r - mean) ** 2), 0) / returns.length
    : 0;
  const volatility = Math.sqrt(Math.max(0, variance));
  const riskAdjusted = volatility > 0 ? mean / volatility : mean;
  return {
    settled_count: settled.length,
    mean_return: Number(mean.toFixed(6)),
    volatility: Number(volatility.toFixed(6)),
    risk_adjusted_return: Number(riskAdjusted.toFixed(6)),
    target: Number(policy.min_risk_adjusted_return || 0),
    target_ok: riskAdjusted >= Number(policy.min_risk_adjusted_return || 0)
  };
}

function cmdEvaluate(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const strict = toBool(args.strict, policy.strict_default === true);
  const days = clampInt(args.days, 1, 365, 30);
  const metrics = evaluateWindow(policy, days);
  const out = {
    ok: metrics.target_ok,
    type: 'capital_allocation_evaluate',
    ts: nowIso(),
    days,
    metrics,
    policy_path: rel(policy.policy_path)
  };
  writeJsonAtomic(policy.latest_path, out);
  appendJsonl(policy.receipts_path, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (strict && out.ok !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const days = clampInt(args.days, 1, 365, 30);
  const state = loadState(policy);
  const metrics = evaluateWindow(policy, days);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'capital_allocation_status',
    ts: nowIso(),
    days,
    cash_balance: state.cash_balance,
    bucket_ids: Object.keys(state.buckets || {}),
    open_allocations: Object.values(state.allocations || {}).filter((row: AnyObj) => row && row.status === 'open').length,
    simulations: Object.keys(state.simulations || {}).length,
    metrics,
    policy: {
      path: rel(policy.policy_path),
      min_simulation_score: policy.min_simulation_score,
      min_risk_adjusted_return: policy.min_risk_adjusted_return
    },
    paths: {
      state_path: rel(policy.state_path),
      latest_path: rel(policy.latest_path),
      receipts_path: rel(policy.receipts_path)
    }
  }, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/budget/capital_allocation_organ.js seed --balance=1000');
  console.log('  node systems/budget/capital_allocation_organ.js simulate --bucket=compute --amount=50 --expected-return=0.15 --risk-score=0.3');
  console.log('  node systems/budget/capital_allocation_organ.js allocate --bucket=compute --amount=50 --simulation-id=<id> [--strict=1|0]');
  console.log('  node systems/budget/capital_allocation_organ.js settle --allocation-id=<id> --actual-return=0.08');
  console.log('  node systems/budget/capital_allocation_organ.js evaluate [--days=30] [--strict=1|0]');
  console.log('  node systems/budget/capital_allocation_organ.js status [--days=30]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'seed') return cmdSeed(args);
  if (cmd === 'simulate') return cmdSimulate(args);
  if (cmd === 'allocate') return cmdAllocate(args);
  if (cmd === 'settle') return cmdSettle(args);
  if (cmd === 'evaluate') return cmdEvaluate(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
