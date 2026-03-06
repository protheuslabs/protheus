#!/usr/bin/env node
'use strict';
export {};

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = process.env.CONTINUOUS_CHAOS_ROOT
  ? path.resolve(process.env.CONTINUOUS_CHAOS_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.CONTINUOUS_CHAOS_POLICY_PATH
  ? path.resolve(process.env.CONTINUOUS_CHAOS_POLICY_PATH)
  : path.join(ROOT, 'config', 'continuous_chaos_resilience_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function parseIsoMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!String(token || '').startsWith('--')) {
      out._.push(String(token || ''));
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[String(token).slice(2)] = true;
    else out[String(token).slice(2, idx)] = String(token).slice(idx + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/continuous_chaos_resilience.js tick [--apply=1|0] [--strict=1|0] [--max-scenarios=N]');
  console.log('  node systems/ops/continuous_chaos_resilience.js gate [--strict=1|0]');
  console.log('  node systems/ops/continuous_chaos_resilience.js status');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown) {
  const token = cleanText(raw || '', 500);
  if (!token) return ROOT;
  return path.isAbsolute(token) ? token : path.join(ROOT, token);
}

function sha16(seed: string) {
  return crypto.createHash('sha256').update(String(seed || ''), 'utf8').digest('hex').slice(0, 16);
}

function parseJsonPayload(text: unknown) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function defaultPolicy() {
  return {
    schema_id: 'continuous_chaos_resilience_policy',
    schema_version: '1.0',
    enabled: true,
    shadow_only: false,
    strict_default: true,
    chaos_program_script: 'systems/ops/chaos_program.js',
    chaos_program_policy: 'config/chaos_program_policy.json',
    max_scenarios_per_tick: 4,
    scenario_cadence_minutes: {
      collector_fault: 60,
      routing_fault: 60,
      actuation_fault: 120,
      state_fault: 120
    },
    gate: {
      window_runs: 12,
      min_samples: 4,
      required_pass_rate: 0.85,
      max_failed_runs: 2,
      max_recovery_p95_ms: 45000
    },
    outputs: {
      state_path: 'state/ops/continuous_chaos_resilience/state.json',
      latest_path: 'state/ops/continuous_chaos_resilience/latest.json',
      receipts_path: 'state/ops/continuous_chaos_resilience/receipts.jsonl',
      gate_receipts_path: 'state/ops/continuous_chaos_resilience/gate_receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const cadRaw = raw.scenario_cadence_minutes && typeof raw.scenario_cadence_minutes === 'object'
    ? raw.scenario_cadence_minutes
    : {};
  const gateRaw = raw.gate && typeof raw.gate === 'object' ? raw.gate : {};
  const outputsRaw = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const cadence: Record<string, number> = {};
  const mergedCadence = {
    ...base.scenario_cadence_minutes,
    ...cadRaw
  };
  for (const [id, val] of Object.entries(mergedCadence)) {
    const key = normalizeToken(id, 120);
    if (!key) continue;
    cadence[key] = clampInt(val, 1, 24 * 60, 60);
  }
  return {
    schema_id: 'continuous_chaos_resilience_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    strict_default: raw.strict_default !== false,
    chaos_program_script: resolvePath(raw.chaos_program_script || base.chaos_program_script),
    chaos_program_policy: resolvePath(raw.chaos_program_policy || base.chaos_program_policy),
    max_scenarios_per_tick: clampInt(raw.max_scenarios_per_tick, 1, 1000, base.max_scenarios_per_tick),
    scenario_cadence_minutes: cadence,
    gate: {
      window_runs: clampInt(gateRaw.window_runs, 1, 10000, base.gate.window_runs),
      min_samples: clampInt(gateRaw.min_samples, 1, 10000, base.gate.min_samples),
      required_pass_rate: clampNumber(gateRaw.required_pass_rate, 0, 1, base.gate.required_pass_rate),
      max_failed_runs: clampInt(gateRaw.max_failed_runs, 0, 10000, base.gate.max_failed_runs),
      max_recovery_p95_ms: clampInt(gateRaw.max_recovery_p95_ms, 1000, 24 * 60 * 60 * 1000, base.gate.max_recovery_p95_ms)
    },
    outputs: {
      state_path: resolvePath(outputsRaw.state_path || base.outputs.state_path),
      latest_path: resolvePath(outputsRaw.latest_path || base.outputs.latest_path),
      receipts_path: resolvePath(outputsRaw.receipts_path || base.outputs.receipts_path),
      gate_receipts_path: resolvePath(outputsRaw.gate_receipts_path || base.outputs.gate_receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadChaosScenarioCatalog(policy: AnyObj) {
  const chaosPolicy = readJson(policy.chaos_program_policy, {});
  const scenarios = Array.isArray(chaosPolicy.scenarios) ? chaosPolicy.scenarios : [];
  return scenarios.map((row: AnyObj) => ({
    scenario_id: normalizeToken(row && row.id || '', 120),
    lane: cleanText(row && row.lane || '', 80) || 'unknown',
    fault: cleanText(row && row.fault || '', 180) || 'synthetic_fault',
    runbook_action: cleanText(row && row.recovery_command || '', 360) || null,
    timeout_ms: clampInt(row && row.timeout_ms, 1000, 24 * 60 * 60 * 1000, 30000)
  })).filter((row: AnyObj) => !!row.scenario_id);
}

function initState() {
  return {
    schema_id: 'continuous_chaos_resilience_state',
    schema_version: '1.0',
    created_at: nowIso(),
    updated_at: nowIso(),
    scenarios: {}
  };
}

function loadState(policy: AnyObj) {
  const raw = readJson(policy.outputs.state_path, null);
  if (!raw || typeof raw !== 'object') return initState();
  return {
    schema_id: 'continuous_chaos_resilience_state',
    schema_version: '1.0',
    created_at: cleanText(raw.created_at || nowIso(), 40) || nowIso(),
    updated_at: cleanText(raw.updated_at || nowIso(), 40) || nowIso(),
    scenarios: raw.scenarios && typeof raw.scenarios === 'object' ? raw.scenarios : {}
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.outputs.state_path, {
    ...state,
    updated_at: nowIso()
  });
}

function runChaosScenario(policy: AnyObj, scenarioId: string) {
  const args = [
    policy.chaos_program_script,
    'run',
    `--scenario=${scenarioId}`,
    '--strict=0'
  ];
  const started = Date.now();
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const payload = parseJsonPayload(r.stdout);
  const rows = payload && Array.isArray(payload.rows) ? payload.rows : [];
  const scenarioRow = rows.find((row: AnyObj) => normalizeToken(row && row.scenario_id || '', 120) === scenarioId) || null;

  return {
    ok: r.status === 0 && payload && payload.ok === true && scenarioRow && scenarioRow.pass === true,
    process_ok: r.status === 0,
    status: Number(r.status || 0),
    duration_ms: Date.now() - started,
    payload,
    scenario_row: scenarioRow,
    stderr: cleanText(r.stderr || '', 1200)
  };
}

function dueScenarios(policy: AnyObj, state: AnyObj, catalog: AnyObj[]) {
  const now = Date.now();
  const due: AnyObj[] = [];
  for (const scenario of catalog) {
    const cadenceMin = Number(policy.scenario_cadence_minutes[scenario.scenario_id] || 60);
    const lastTs = parseIsoMs(state && state.scenarios && state.scenarios[scenario.scenario_id] && state.scenarios[scenario.scenario_id].last_run_at || '');
    const elapsedMin = lastTs == null ? Number.POSITIVE_INFINITY : (now - lastTs) / (60 * 1000);
    if (elapsedMin >= cadenceMin) {
      due.push({ ...scenario, cadence_minutes: cadenceMin, elapsed_minutes: elapsedMin });
    }
  }
  due.sort((a, b) => Number(b.elapsed_minutes || 0) - Number(a.elapsed_minutes || 0));
  return due;
}

function p95(values: number[]) {
  const rows = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!rows.length) return null;
  const idx = Math.min(rows.length - 1, Math.max(0, Math.ceil(0.95 * rows.length) - 1));
  return rows[idx];
}

function evaluateGate(policy: AnyObj) {
  const receipts = readJsonl(policy.outputs.receipts_path)
    .filter((row: AnyObj) => row && row.type === 'continuous_chaos_tick')
    .slice(-policy.gate.window_runs);
  const samples = receipts.length;
  const failedRuns = receipts.filter((row: AnyObj) => row.ok !== true).length;
  const passRate = samples > 0 ? Number(((samples - failedRuns) / samples).toFixed(4)) : 1;

  const recoveryDurations: number[] = [];
  for (const row of receipts) {
    const executed = Array.isArray(row.executed) ? row.executed : [];
    for (const e of executed) {
      const scenarioDuration = Number(e && e.recovery_duration_ms);
      if (Number.isFinite(scenarioDuration)) recoveryDurations.push(scenarioDuration);
    }
  }
  const recoveryP95 = p95(recoveryDurations);

  const enoughSamples = samples >= policy.gate.min_samples;
  const reasons = [];
  if (!enoughSamples) reasons.push('insufficient_samples');
  if (enoughSamples && passRate < policy.gate.required_pass_rate) reasons.push('pass_rate_regressed');
  if (enoughSamples && failedRuns > policy.gate.max_failed_runs) reasons.push('failed_run_budget_exceeded');
  if (enoughSamples && recoveryP95 != null && recoveryP95 > policy.gate.max_recovery_p95_ms) reasons.push('recovery_p95_regressed');

  return {
    ok: reasons.length === 0,
    enough_samples: enoughSamples,
    samples,
    pass_rate: passRate,
    failed_runs: failedRuns,
    recovery_p95_ms: recoveryP95,
    reasons,
    promotion_blocked: reasons.length > 0
  };
}

function cmdTick(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'continuous_chaos_tick', error: 'policy_disabled' })}\n`);
    process.exit(1);
  }

  const strict = toBool(args.strict, policy.strict_default);
  const apply = toBool(args.apply, true);
  const maxScenarios = clampInt(args['max-scenarios'] || args.max_scenarios, 1, 10000, policy.max_scenarios_per_tick);

  const catalog = loadChaosScenarioCatalog(policy);
  const state = loadState(policy);
  const due = dueScenarios(policy, state, catalog).slice(0, maxScenarios);

  const executed: AnyObj[] = [];
  for (const scenario of due) {
    const run = runChaosScenario(policy, scenario.scenario_id);
    const scenarioReceipt = {
      receipt_id: `ccr_${sha16(`${scenario.scenario_id}|${nowIso()}|${run.ok ? '1' : '0'}`)}`,
      scenario_id: scenario.scenario_id,
      lane: scenario.lane,
      fault: scenario.fault,
      runbook_action: scenario.runbook_action,
      cadence_minutes: scenario.cadence_minutes,
      recovery_duration_ms: Number(run && run.scenario_row && run.scenario_row.recovery && run.scenario_row.recovery.duration_ms || run.duration_ms || 0),
      integrity_ok: !!(run && run.scenario_row && run.scenario_row.integrity_ok === true),
      recovered: !!(run && run.scenario_row && run.scenario_row.recovered === true),
      ok: run.ok === true,
      status: run.status,
      stderr: run.stderr || null
    };
    executed.push(scenarioReceipt);
    if (apply && policy.shadow_only !== true) {
      state.scenarios[scenario.scenario_id] = {
        last_run_at: nowIso(),
        last_ok: scenarioReceipt.ok,
        last_receipt_id: scenarioReceipt.receipt_id,
        last_recovery_duration_ms: scenarioReceipt.recovery_duration_ms
      };
    }
  }

  if (apply && policy.shadow_only !== true) saveState(policy, state);

  const allOk = executed.every((row: AnyObj) => row.ok === true);
  const gate = evaluateGate(policy);
  const out = {
    ok: allOk,
    type: 'continuous_chaos_tick',
    ts: nowIso(),
    strict,
    apply,
    shadow_only: policy.shadow_only === true,
    catalog_size: catalog.length,
    due_count: due.length,
    executed_count: executed.length,
    executed,
    gate_snapshot: gate,
    policy_path: rel(policy.policy_path)
  };

  appendJsonl(policy.outputs.receipts_path, out);
  writeJsonAtomic(policy.outputs.latest_path, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (strict && (out.ok !== true || gate.ok !== true)) process.exit(1);
}

function cmdGate(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const strict = toBool(args.strict, policy.strict_default);
  const gate = evaluateGate(policy);

  const out = {
    ok: gate.ok,
    type: 'continuous_chaos_gate',
    ts: nowIso(),
    strict,
    evaluation: gate,
    policy_path: rel(policy.policy_path)
  };

  appendJsonl(policy.outputs.gate_receipts_path, out);
  writeJsonAtomic(policy.outputs.latest_path, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (strict && out.ok !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const gate = evaluateGate(policy);
  const latest = readJson(policy.outputs.latest_path, null);
  const catalog = loadChaosScenarioCatalog(policy);
  const due = dueScenarios(policy, state, catalog);

  const out = {
    ok: true,
    type: 'continuous_chaos_status',
    ts: nowIso(),
    policy: {
      path: rel(policy.policy_path),
      enabled: policy.enabled === true,
      shadow_only: policy.shadow_only === true,
      max_scenarios_per_tick: policy.max_scenarios_per_tick,
      strict_default: policy.strict_default === true
    },
    gate,
    catalog_size: catalog.length,
    due_count: due.length,
    latest,
    paths: {
      state_path: rel(policy.outputs.state_path),
      receipts_path: rel(policy.outputs.receipts_path),
      gate_receipts_path: rel(policy.outputs.gate_receipts_path)
    }
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 64);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'tick') return cmdTick(args);
  if (cmd === 'gate') return cmdGate(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  evaluateGate,
  cmdTick,
  cmdGate,
  cmdStatus
};
