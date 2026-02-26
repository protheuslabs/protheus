#!/usr/bin/env node
'use strict';

/**
 * polyglot_service_adapter.js
 *
 * V2-002 pilot polyglot adapter:
 * - Strict JSON stdin/stdout worker contract
 * - Deterministic fallback baseline path
 * - Simple benchmark + rollback-safe status
 *
 * Usage:
 *   node systems/polyglot/polyglot_service_adapter.js run --task-type=security_review --signals='{"urgency":0.9,"confidence":0.8,"risk":0.2}'
 *   node systems/polyglot/polyglot_service_adapter.js benchmark [--runs=40]
 *   node systems/polyglot/polyglot_service_adapter.js status
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.POLYGLOT_SERVICE_POLICY_PATH
  ? path.resolve(process.env.POLYGLOT_SERVICE_POLICY_PATH)
  : path.join(ROOT, 'config', 'polyglot_service_policy.json');

function nowIso() {
  return new Date().toISOString();
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

function normalizeToken(v, maxLen = 64) {
  return normalizeText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    contract_version: '1.0',
    allow_fallback_baseline: true,
    worker: {
      runtime: 'python3',
      script: 'systems/polyglot/pilot_task_classifier.py',
      timeout_ms: 2500
    },
    benchmark: {
      default_runs: 40,
      max_runs: 500
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  const workerSrc = src.worker && typeof src.worker === 'object' ? src.worker : {};
  const benchSrc = src.benchmark && typeof src.benchmark === 'object' ? src.benchmark : {};
  return {
    version: normalizeText(src.version || base.version, 32) || '1.0',
    enabled: src.enabled !== false,
    contract_version: normalizeText(src.contract_version || base.contract_version, 24) || '1.0',
    allow_fallback_baseline: src.allow_fallback_baseline !== false,
    worker: {
      runtime: normalizeToken(workerSrc.runtime || base.worker.runtime, 32) || base.worker.runtime,
      script: normalizeText(workerSrc.script || base.worker.script, 260) || base.worker.script,
      timeout_ms: clampInt(workerSrc.timeout_ms, 100, 120000, base.worker.timeout_ms)
    },
    benchmark: {
      default_runs: clampInt(benchSrc.default_runs, 1, 10000, base.benchmark.default_runs),
      max_runs: clampInt(benchSrc.max_runs, 1, 20000, base.benchmark.max_runs)
    }
  };
}

function parseSignals(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  const text = normalizeText(raw, 1000);
  if (!text) return {};
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      return {};
    }
  }
  const out = {};
  for (const part of text.split(',')) {
    const [kRaw, vRaw] = String(part || '').split(':');
    const key = normalizeToken(kRaw, 32);
    if (!key) continue;
    const n = Number(String(vRaw || '').trim());
    if (!Number.isFinite(n)) continue;
    out[key] = n;
  }
  return out;
}

function baselineClassify(taskType, signals) {
  const t = normalizeToken(taskType, 64) || 'unknown';
  const s = signals && typeof signals === 'object' ? signals : {};
  const urgency = clampNumber(s.urgency, 0, 1, 0.5);
  const confidence = clampNumber(s.confidence, 0, 1, 0.5);
  const risk = clampNumber(s.risk, 0, 1, 0.3);
  let score = clampNumber((confidence * 0.55) + (urgency * 0.35) - (risk * 0.2), 0, 1, 0.5);
  let lane = score >= 0.72 ? 'priority' : (score <= 0.36 ? 'defer' : 'standard');
  if (t.startsWith('security') || t.startsWith('integrity')) {
    lane = 'priority';
    score = Math.max(score, 0.78);
  }
  return {
    task_type: t,
    score: Number(score.toFixed(4)),
    recommended_lane: lane
  };
}

function runtimeAvailable(runtime) {
  const r = spawnSync(runtime, ['--version'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 1500
  });
  return r.status === 0;
}

function validateWorkerResponse(parsed, expectedContract) {
  const out = parsed && typeof parsed === 'object' ? parsed : null;
  if (!out) return 'worker_response_not_object';
  if (out.ok !== true) return 'worker_response_not_ok';
  if (normalizeText(out.contract_version, 24) !== normalizeText(expectedContract, 24)) {
    return 'worker_contract_version_mismatch';
  }
  if (!out.result || typeof out.result !== 'object' || Array.isArray(out.result)) {
    return 'worker_result_missing';
  }
  if (!out.receipt || typeof out.receipt !== 'object' || Array.isArray(out.receipt)) {
    return 'worker_receipt_missing';
  }
  return null;
}

function invokeWorker(input, policy) {
  const runtime = policy.worker.runtime;
  const workerScript = path.resolve(ROOT, policy.worker.script);
  const started = Date.now();
  const worker = spawnSync(runtime, [workerScript], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify(input),
    timeout: policy.worker.timeout_ms
  });

  const elapsed = Date.now() - started;
  if (worker.error) {
    return {
      ok: false,
      error: `worker_spawn_error:${normalizeText(worker.error && worker.error.code || worker.error && worker.error.message, 120)}`,
      latency_ms: elapsed,
      stderr: normalizeText(worker.stderr, 240)
    };
  }
  if (worker.status !== 0) {
    return {
      ok: false,
      error: `worker_exit_${Number(worker.status || 1)}`,
      latency_ms: elapsed,
      stderr: normalizeText(worker.stderr, 240)
    };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(String(worker.stdout || '{}'));
  } catch {
    return {
      ok: false,
      error: 'worker_invalid_json',
      latency_ms: elapsed,
      stdout: normalizeText(worker.stdout, 240)
    };
  }

  const contractError = validateWorkerResponse(parsed, policy.contract_version);
  if (contractError) {
    return {
      ok: false,
      error: contractError,
      latency_ms: elapsed,
      payload: parsed
    };
  }

  return {
    ok: true,
    latency_ms: elapsed,
    payload: parsed
  };
}

function runAdapter(payload, policy) {
  const enabledByEnv = String(process.env.POLYGLOT_SERVICE_ENABLED || '1') !== '0';
  const enabled = policy.enabled === true && enabledByEnv;
  const taskType = normalizeToken(payload.task_type || payload.taskType || 'unknown', 64) || 'unknown';
  const signals = parseSignals(payload.signals);
  const rollbackToken = normalizeText(payload.rollback_token || payload.rollbackToken || '', 128) || null;

  const baseline = baselineClassify(taskType, signals);
  if (!enabled) {
    return {
      ok: true,
      mode: 'fallback_baseline',
      reason: 'polyglot_disabled',
      contract_version: policy.contract_version,
      result: baseline,
      receipt: {
        runtime: 'node',
        latency_ms: 0,
        rollback_token: rollbackToken
      }
    };
  }

  if (!runtimeAvailable(policy.worker.runtime)) {
    return {
      ok: true,
      mode: 'fallback_baseline',
      reason: 'worker_runtime_unavailable',
      contract_version: policy.contract_version,
      result: baseline,
      receipt: {
        runtime: 'node',
        latency_ms: 0,
        rollback_token: rollbackToken
      }
    };
  }

  const workerResp = invokeWorker({
    schema_version: '1.0',
    task_type: taskType,
    signals,
    rollback_token: rollbackToken
  }, policy);

  if (!workerResp.ok) {
    if (policy.allow_fallback_baseline !== true) {
      return {
        ok: false,
        mode: 'worker_error',
        reason: workerResp.error,
        detail: workerResp
      };
    }
    return {
      ok: true,
      mode: 'fallback_baseline',
      reason: workerResp.error,
      contract_version: policy.contract_version,
      result: baseline,
      receipt: {
        runtime: 'node',
        latency_ms: Number(workerResp.latency_ms || 0),
        rollback_token: rollbackToken
      }
    };
  }

  return {
    ok: true,
    mode: 'worker',
    contract_version: policy.contract_version,
    result: workerResp.payload.result,
    receipt: {
      ...(workerResp.payload.receipt || {}),
      runtime: normalizeText(workerResp.payload.receipt && workerResp.payload.receipt.runtime || policy.worker.runtime, 32),
      latency_ms: Number(workerResp.payload.receipt && workerResp.payload.receipt.latency_ms || workerResp.latency_ms || 0)
    },
    worker_module: normalizeText(workerResp.payload.module, 80)
  };
}

function percentile(values, pct) {
  const arr = (Array.isArray(values) ? values : []).map((v) => Number(v)).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!arr.length) return null;
  const i = Math.max(0, Math.min(arr.length - 1, Math.ceil((pct / 100) * arr.length) - 1));
  return Number(arr[i].toFixed(3));
}

function cmdRun(args) {
  const policy = loadPolicy();
  const out = runAdapter({
    task_type: args['task-type'] || args.task_type || 'unknown',
    signals: args.signals,
    rollback_token: args['rollback-token'] || args.rollback_token || null
  }, policy);
  process.stdout.write(JSON.stringify({
    ok: out.ok === true,
    type: 'polyglot_service_run',
    ts: nowIso(),
    policy_version: policy.version,
    ...out
  }) + '\n');
  if (out.ok !== true) process.exit(1);
}

function cmdBenchmark(args) {
  const policy = loadPolicy();
  const maxRuns = Number(policy.benchmark.max_runs || 500);
  const runs = clampInt(args.runs, 1, maxRuns, Number(policy.benchmark.default_runs || 40));
  const workerLat = [];
  const baselineLat = [];
  let workerSuccess = 0;
  let fallbackCount = 0;

  for (let i = 0; i < runs; i += 1) {
    const taskType = i % 3 === 0 ? 'security_review' : (i % 3 === 1 ? 'delivery_task' : 'revenue_probe');
    const signals = {
      urgency: Number(((i % 10) / 10).toFixed(2)),
      confidence: Number((0.45 + ((i % 7) * 0.07)).toFixed(2)),
      risk: Number((0.1 + ((i % 5) * 0.08)).toFixed(2))
    };

    const baselineStart = Date.now();
    baselineClassify(taskType, signals);
    baselineLat.push(Date.now() - baselineStart);

    const result = runAdapter({
      task_type: taskType,
      signals,
      rollback_token: `bench_${i}`
    }, policy);

    if (result.mode === 'worker') {
      workerSuccess += 1;
      workerLat.push(Number(result.receipt && result.receipt.latency_ms || 0));
    } else {
      fallbackCount += 1;
      workerLat.push(Number(result.receipt && result.receipt.latency_ms || 0));
    }
  }

  const out = {
    ok: true,
    type: 'polyglot_service_benchmark',
    ts: nowIso(),
    runs,
    worker_success: workerSuccess,
    fallback_count: fallbackCount,
    worker_latency_ms: {
      p50: percentile(workerLat, 50),
      p95: percentile(workerLat, 95)
    },
    baseline_latency_ms: {
      p50: percentile(baselineLat, 50),
      p95: percentile(baselineLat, 95)
    },
    rollback_path: {
      available: true,
      mode: 'fallback_baseline'
    }
  };

  process.stdout.write(JSON.stringify(out) + '\n');
}

function cmdStatus() {
  const policy = loadPolicy();
  const enabledByEnv = String(process.env.POLYGLOT_SERVICE_ENABLED || '1') !== '0';
  const runtimeOk = runtimeAvailable(policy.worker.runtime);
  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'polyglot_service_status',
    ts: nowIso(),
    policy_path: path.relative(ROOT, POLICY_PATH).replace(/\\/g, '/'),
    policy_version: policy.version,
    enabled: policy.enabled === true && enabledByEnv,
    contract_version: policy.contract_version,
    worker: {
      runtime: policy.worker.runtime,
      script: policy.worker.script,
      timeout_ms: policy.worker.timeout_ms,
      runtime_available: runtimeOk
    },
    rollback_path: {
      allow_fallback_baseline: policy.allow_fallback_baseline === true
    }
  }) + '\n');
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/polyglot/polyglot_service_adapter.js run --task-type=<id> --signals={"urgency":0.8,"confidence":0.7,"risk":0.2} [--rollback-token=<id>]');
  console.log('  node systems/polyglot/polyglot_service_adapter.js benchmark [--runs=40]');
  console.log('  node systems/polyglot/polyglot_service_adapter.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0], 32);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'benchmark') return cmdBenchmark(args);
  if (cmd === 'status') return cmdStatus();
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  baselineClassify,
  runAdapter,
  parseSignals
};
export {};
