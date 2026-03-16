#!/usr/bin/env node
'use strict';

// Thin benchmark gate bridge. Measurements remain in core benchmark-matrix lane.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const POLICY_PATH = path.join(
  ROOT,
  'client',
  'runtime',
  'config',
  'benchmark_autonomy_gate_policy.json'
);
const OPS_WRAPPER = path.join(
  ROOT,
  'client',
  'runtime',
  'systems',
  'ops',
  'run_protheus_ops.js'
);
const LATEST_PATH = path.join(ROOT, 'local', 'state', 'ops', 'benchmark_autonomy_gate', 'latest.json');
const RECEIPTS_PATH = path.join(ROOT, 'local', 'state', 'ops', 'benchmark_autonomy_gate', 'receipts.jsonl');

const DEFAULT_GATES = {
  cold_start_ms_max: 250,
  idle_memory_mb_max: 64,
  install_size_mb_max: 128,
  tasks_per_sec_min: 3000,
};

function parseArgs(argv) {
  const out = { command: String(argv[0] || 'run').toLowerCase(), strict: true };
  for (const token of argv.slice(1)) {
    if (token.startsWith('--strict=')) {
      const raw = token.slice('--strict='.length).trim().toLowerCase();
      out.strict = ['1', 'true', 'yes', 'on'].includes(raw);
    }
  }
  return out;
}

function normalizeGates(rawGates) {
  const gates = { ...DEFAULT_GATES };
  if (!rawGates || typeof rawGates !== 'object') return gates;

  const maybe = (key) => {
    const value = Number(rawGates[key]);
    return Number.isFinite(value) ? value : gates[key];
  };

  gates.cold_start_ms_max = maybe('cold_start_ms_max');
  gates.idle_memory_mb_max = maybe('idle_memory_mb_max');
  gates.install_size_mb_max = maybe('install_size_mb_max');
  gates.tasks_per_sec_min = maybe('tasks_per_sec_min');
  return gates;
}

function readPolicy() {
  const defaults = { enabled: true, strict_default: true, gates: { ...DEFAULT_GATES } };
  try {
    const parsed = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
    return {
      ...defaults,
      ...parsed,
      gates: normalizeGates(parsed && parsed.gates),
    };
  } catch {
    return defaults;
  }
}

function parseLastJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {}

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = raw.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!(line.startsWith('{') && line.endsWith('}'))) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
}

function runOpsCapture(args) {
  const run = spawnSync(process.execPath, [OPS_WRAPPER].concat(args), {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  const status = Number.isFinite(Number(run.status)) ? Number(run.status) : 1;
  const stdout = String(run.stdout || '');
  const stderr = String(run.stderr || '');
  return {
    status,
    stdout,
    stderr,
    payload: parseLastJson(stdout),
  };
}

function writeArtifacts(payload) {
  fs.mkdirSync(path.dirname(LATEST_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(RECEIPTS_PATH), { recursive: true });
  fs.writeFileSync(LATEST_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.appendFileSync(RECEIPTS_PATH, `${JSON.stringify(payload)}\n`, 'utf8');
}

function evaluateGate(payload, gates) {
  const measured = payload && payload.openclaw_measured ? payload.openclaw_measured : {};
  const metrics = {
    cold_start_ms: Number(measured.cold_start_ms || 0),
    idle_memory_mb: Number(measured.idle_memory_mb || 0),
    install_size_mb: Number(measured.install_size_mb || 0),
    tasks_per_sec: Number(measured.tasks_per_sec || 0),
  };

  const checks = [
    {
      id: 'cold_start_ms_max',
      ok: metrics.cold_start_ms > 0 && metrics.cold_start_ms <= gates.cold_start_ms_max,
      value: metrics.cold_start_ms,
      gate: gates.cold_start_ms_max,
    },
    {
      id: 'idle_memory_mb_max',
      ok: metrics.idle_memory_mb > 0 && metrics.idle_memory_mb <= gates.idle_memory_mb_max,
      value: metrics.idle_memory_mb,
      gate: gates.idle_memory_mb_max,
    },
    {
      id: 'install_size_mb_max',
      ok: metrics.install_size_mb > 0 && metrics.install_size_mb <= gates.install_size_mb_max,
      value: metrics.install_size_mb,
      gate: gates.install_size_mb_max,
    },
    {
      id: 'tasks_per_sec_min',
      ok: metrics.tasks_per_sec >= gates.tasks_per_sec_min,
      value: metrics.tasks_per_sec,
      gate: gates.tasks_per_sec_min,
    },
  ];

  return {
    metrics,
    checks,
    failed: checks.filter((row) => !row.ok).map((row) => row.id),
  };
}

function runGate(gates) {
  const run = runOpsCapture(['benchmark-matrix', 'run', '--refresh-runtime=1']);
  if (run.status !== 0 || !run.payload || run.payload.ok !== true) {
    return {
      ok: false,
      type: 'benchmark_autonomy_gate',
      generated_at: new Date().toISOString(),
      error: 'benchmark_matrix_run_failed',
      status_code: run.status,
      stderr_tail: run.stderr.slice(-320),
    };
  }
  const evaluated = evaluateGate(run.payload, gates);
  return {
    ok: evaluated.failed.length === 0,
    type: 'benchmark_autonomy_gate',
    generated_at: new Date().toISOString(),
    gates,
    metrics: evaluated.metrics,
    checks: evaluated.checks,
    failed: evaluated.failed,
    benchmark_receipt_hash: run.payload.receipt_hash || null,
  };
}

function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const policy = readPolicy();
  const strict = parsed.strict && policy.strict_default !== false;
  if (!policy.enabled) {
    const out = {
      ok: false,
      type: 'benchmark_autonomy_gate',
      generated_at: new Date().toISOString(),
      error: 'lane_disabled_by_policy',
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return 1;
  }

  if (parsed.command === 'status') {
    if (!fs.existsSync(LATEST_PATH)) {
      const out = {
        ok: false,
        type: 'benchmark_autonomy_gate_status',
        generated_at: new Date().toISOString(),
        error: 'missing_latest_benchmark_autonomy_gate',
      };
      process.stdout.write(`${JSON.stringify(out)}\n`);
      return 1;
    }
    process.stdout.write(`${fs.readFileSync(LATEST_PATH, 'utf8').trim()}\n`);
    return 0;
  }

  const out = runGate(policy.gates);
  out.strict = strict;
  writeArtifacts(out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return out.ok || !strict ? 0 : 2;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, runGate, evaluateGate };
