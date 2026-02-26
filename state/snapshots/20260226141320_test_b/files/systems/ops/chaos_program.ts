#!/usr/bin/env node
'use strict';

/**
 * chaos_program.js
 *
 * Scheduled chaos scenarios for adaptive/orchestration lanes.
 *
 * Usage:
 *   node systems/ops/chaos_program.js run [--scenario=<id>|all] [--strict=1|0]
 *   node systems/ops/chaos_program.js status
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.CHAOS_PROGRAM_POLICY_PATH
  ? path.resolve(process.env.CHAOS_PROGRAM_POLICY_PATH)
  : path.join(ROOT, 'config', 'chaos_program_policy.json');
const RECEIPTS_PATH = process.env.CHAOS_PROGRAM_RECEIPTS_PATH
  ? path.resolve(process.env.CHAOS_PROGRAM_RECEIPTS_PATH)
  : path.join(ROOT, 'state', 'ops', 'chaos_program_receipts.jsonl');

function nowIso() {
  return new Date().toISOString();
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/chaos_program.js run [--scenario=<id>|all] [--strict=1|0]');
  console.log('  node systems/ops/chaos_program.js status');
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

function appendJsonl(filePath, row) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function defaultPolicy() {
  return {
    version: '1.0',
    strict_default: true,
    integrity_command: 'node systems/security/integrity_kernel.js run',
    scenarios: [
      {
        id: 'collector_fault',
        lane: 'sensory',
        fault: 'collector_timeout_simulation',
        recovery_command: 'node systems/sensory/adaptive_layer_guard.js run --strict',
        timeout_ms: 30000
      },
      {
        id: 'routing_fault',
        lane: 'routing',
        fault: 'model_health_degraded_simulation',
        recovery_command: 'node systems/routing/route_probe.js',
        timeout_ms: 30000
      },
      {
        id: 'actuation_fault',
        lane: 'actuation',
        fault: 'actuation_adapter_failure_simulation',
        recovery_command: 'node systems/security/guard.js run --strict',
        timeout_ms: 30000
      },
      {
        id: 'state_fault',
        lane: 'state',
        fault: 'state_write_contention_simulation',
        recovery_command: 'node systems/memory/memory_layer_guard.js run --strict',
        timeout_ms: 30000
      }
    ]
  };
}

function normalizeScenario(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const id = normalizeText(src.id || '', 120)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!id) return null;
  return {
    id,
    lane: normalizeText(src.lane || 'unknown', 80) || 'unknown',
    fault: normalizeText(src.fault || 'synthetic_fault', 180) || 'synthetic_fault',
    recovery_command: normalizeText(src.recovery_command || '', 400) || '',
    timeout_ms: Math.max(1000, Number(src.timeout_ms || 30000))
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  const scenariosRaw = Array.isArray(src.scenarios) ? src.scenarios : base.scenarios;
  const scenarios = scenariosRaw.map(normalizeScenario).filter(Boolean);
  return {
    version: normalizeText(src.version || base.version, 32) || '1.0',
    strict_default: src.strict_default !== false,
    integrity_command: normalizeText(src.integrity_command || base.integrity_command, 400) || base.integrity_command,
    scenarios
  };
}

function runCommand(commandText, timeoutMs = 30000) {
  const cmd = normalizeText(commandText || '', 4000);
  if (!cmd) {
    return {
      ok: true,
      status: 0,
      command: null,
      stdout: '',
      stderr: '',
      duration_ms: 0
    };
  }
  const started = Date.now();
  const r = spawnSync(cmd, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
    timeout: timeoutMs
  });
  return {
    ok: r.status === 0,
    status: Number(r.status || 0),
    command: cmd,
    stdout: String(r.stdout || '').trim().split('\n').slice(0, 40).join('\n'),
    stderr: String(r.stderr || '').trim().split('\n').slice(0, 40).join('\n'),
    duration_ms: Date.now() - started
  };
}

function runScenario(scenario, policy) {
  const injectedAt = nowIso();
  const recovery = runCommand(scenario.recovery_command, scenario.timeout_ms);
  const integrity = runCommand(policy.integrity_command, Math.max(5000, Number(scenario.timeout_ms || 30000)));
  const recovered = recovery.ok === true;
  const integrity_ok = integrity.ok === true;
  return {
    scenario_id: scenario.id,
    lane: scenario.lane,
    fault: scenario.fault,
    injected_at: injectedAt,
    recovery,
    integrity,
    recovered,
    integrity_ok,
    pass: recovered && integrity_ok
  };
}

function cmdRun(args) {
  const policy = loadPolicy();
  const strict = toBool(args.strict, policy.strict_default);
  const selector = normalizeText(args.scenario || 'all', 120).toLowerCase();
  const scenarios = selector === 'all'
    ? policy.scenarios
    : policy.scenarios.filter((row) => row.id === selector);

  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'scenario_not_found', scenario: selector }) + '\n');
    process.exit(2);
  }

  const started = Date.now();
  const rows = scenarios.map((scenario) => runScenario(scenario, policy));
  const failed = rows.filter((row) => row.pass !== true);
  const out = {
    ok: failed.length === 0,
    type: 'chaos_program_run',
    ts: nowIso(),
    strict,
    policy_version: policy.version,
    selector,
    scenario_count: rows.length,
    failed_count: failed.length,
    duration_ms: Date.now() - started,
    rows
  };

  appendJsonl(RECEIPTS_PATH, out);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (strict && out.ok !== true) process.exit(1);
}

function cmdStatus() {
  const policy = loadPolicy();
  const rows = readJsonl(RECEIPTS_PATH)
    .filter((row) => row && row.type === 'chaos_program_run')
    .slice(-20);
  const failures = rows.filter((row) => row.ok !== true).length;
  const out = {
    ok: true,
    type: 'chaos_program_status',
    ts: nowIso(),
    policy_version: policy.version,
    receipts_path: path.relative(ROOT, RECEIPTS_PATH),
    scenario_catalog: policy.scenarios.map((row) => ({
      id: row.id,
      lane: row.lane,
      fault: row.fault,
      timeout_ms: row.timeout_ms
    })),
    recent_runs: rows.length,
    recent_failures: failures,
    pass_rate: rows.length > 0 ? Number(((rows.length - failures) / rows.length).toFixed(4)) : null
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
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
  runScenario
};
export {};
