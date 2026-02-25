#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/continuum/continuum_core.js
 *
 * Continuum Organ (Dream Organ / Background Mind):
 * - Low-priority pulse runner for background consolidation + anticipation.
 * - Bounded, policy-governed, proposal-first orchestration.
 *
 * Usage:
 *   node systems/continuum/continuum_core.js pulse [YYYY-MM-DD] [--policy=path] [--profile=spine|daemon|manual] [--reason=txt] [--dry-run=1|0] [--force=1|0]
 *   node systems/continuum/continuum_core.js daemon [--policy=path] [--interval-sec=N] [--max-cycles=N] [--dry-run=1|0]
 *   node systems/continuum/continuum_core.js status [YYYY-MM-DD|latest]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  TRIT_PAIN,
  TRIT_UNKNOWN,
  TRIT_OK,
  tritLabel,
  majorityTrit
} = require('../../lib/trit');
let decideBrainRoute = null;
try {
  ({ decideBrainRoute } = require('../dual_brain/coordinator.js'));
} catch {
  decideBrainRoute = null;
}

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'continuum_policy.json');
const DEFAULT_STATE_DIR = path.join(ROOT, 'state', 'autonomy', 'continuum');
const DEFAULT_RUNS_DIR = path.join(DEFAULT_STATE_DIR, 'runs');
const DEFAULT_EVENTS_DIR = path.join(DEFAULT_STATE_DIR, 'events');
const DEFAULT_HISTORY_PATH = path.join(DEFAULT_STATE_DIR, 'history.jsonl');
const DEFAULT_LATEST_PATH = path.join(DEFAULT_STATE_DIR, 'latest.json');
const DEFAULT_RUNTIME_STATE_PATH = path.join(DEFAULT_STATE_DIR, 'runtime_state.json');
const DEFAULT_TRAINING_QUEUE_PATH = path.join(ROOT, 'state', 'nursery', 'training', 'continuum_queue.jsonl');
const DEFAULT_AUTONOMY_RUNS_DIR = path.join(ROOT, 'state', 'autonomy', 'runs');
const DEFAULT_SIM_DIR = path.join(ROOT, 'state', 'autonomy', 'simulations');
const DEFAULT_FRACTAL_INTROSPECTION_DIR = path.join(ROOT, 'state', 'autonomy', 'fractal', 'introspection');
const DEFAULT_SPINE_RUNS_DIR = path.join(ROOT, 'state', 'spine', 'runs');

const SCRIPT_MEMORY_DREAM = 'systems/memory/memory_dream.js';
const SCRIPT_IDLE_DREAM = 'systems/memory/idle_dream_cycle.js';
const SCRIPT_CREATIVE_LINKS = 'systems/memory/creative_links.js';
const SCRIPT_WORKFLOW_CONTROLLER = 'systems/workflow/workflow_controller.js';
const SCRIPT_OBSERVER_MIRROR = 'systems/autonomy/observer_mirror.js';
const SCRIPT_FRACTAL_INTROSPECTION = 'systems/fractal/introspection_map.js';
const SCRIPT_RED_TEAM = 'systems/autonomy/red_team_harness.js';
const SCRIPT_AUTOTEST = 'systems/ops/autotest_controller.js';
const SCRIPT_ORGAN_ATROPHY = 'systems/ops/organ_atrophy_controller.js';

const ALLOWED_SCRIPTS = new Set([
  SCRIPT_MEMORY_DREAM,
  SCRIPT_IDLE_DREAM,
  SCRIPT_CREATIVE_LINKS,
  SCRIPT_WORKFLOW_CONTROLLER,
  SCRIPT_OBSERVER_MIRROR,
  SCRIPT_FRACTAL_INTROSPECTION,
  SCRIPT_RED_TEAM,
  SCRIPT_AUTOTEST,
  SCRIPT_ORGAN_ATROPHY
]);

function usage() {
  console.log('Usage:');
  console.log('  node systems/continuum/continuum_core.js pulse [YYYY-MM-DD] [--policy=path] [--profile=spine|daemon|manual] [--reason=txt] [--dry-run=1|0] [--force=1|0]');
  console.log('  node systems/continuum/continuum_core.js daemon [--policy=path] [--interval-sec=N] [--max-cycles=N] [--dry-run=1|0]');
  console.log('  node systems/continuum/continuum_core.js status [YYYY-MM-DD|latest]');
}

function parseArgs(argv: string[]): AnyObj {
  const out: AnyObj = { _: [] };
  for (const arg of argv) {
    if (!String(arg || '').startsWith('--')) {
      out._.push(String(arg || ''));
      continue;
    }
    const idx = arg.indexOf('=');
    if (idx === -1) out[String(arg || '').slice(2)] = true;
    else out[String(arg || '').slice(2, idx)] = String(arg || '').slice(idx + 1);
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function toDate(v: unknown) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
}

function shiftDate(dateStr: string, deltaDays: number) {
  const base = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return dateStr;
  base.setUTCDate(base.getUTCDate() + Number(deltaDays || 0));
  return base.toISOString().slice(0, 10);
}

function windowDates(dateStr: string, days: number) {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) out.push(shiftDate(dateStr, -i));
  return out;
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

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 80) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const row = JSON.parse(line);
          return row && typeof row === 'object' ? row : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function sleepMs(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.floor(ms))));
}

function parseJsonFromOutput(raw: string) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    low_priority_nice: 10,
    daemon: {
      interval_sec: 900,
      max_cycles: 0,
      jitter_sec: 20
    },
    runtime_guard: {
      max_load_per_cpu: 0.65,
      max_rss_mb: 900,
      max_heap_used_mb: 450,
      spine_hot_window_sec: 75
    },
    signals: {
      max_drift_rate: 0.03,
      max_policy_hold_rate: 0.4,
      elevated_policy_hold_rate: 0.25
    },
    trit_weights: {
      drift: 1.4,
      queue_pressure: 1.1,
      hold_rate: 1.0,
      resource_load: 1.2,
      spine_hot: 1.4
    },
    cooldown_sec: {
      dream_consolidation: 45 * 60,
      anticipation: 30 * 60,
      self_improvement: 25 * 60,
      creative_incubation: 60 * 60,
      security_vigilance: 35 * 60,
      autotest_validation: 90 * 60,
      organ_atrophy_shadow: 6 * 60 * 60
    },
    tasks: {
      dream_consolidation: {
        enabled: true,
        timeout_ms: 18000,
        days: 3,
        top: 8,
        include_idle_cycle: false,
        min_trit: -1,
        max_trit: 1
      },
      anticipation: {
        enabled: true,
        timeout_ms: 20000,
        days: 14,
        max: 6,
        intent: 'prepare likely upcoming high-value workflow opportunities',
        value_currency: 'adaptive_value',
        objective_id: 'continuum_anticipation',
        min_trit: 0,
        max_trit: 1
      },
      self_improvement: {
        enabled: true,
        timeout_ms: 15000,
        mirror_days: 1,
        include_fractal_introspection: true,
        min_trit: 0,
        max_trit: 1
      },
      creative_incubation: {
        enabled: true,
        timeout_ms: 18000,
        days: 7,
        top: 12,
        max_promotions: 1,
        min_trit: 0,
        max_trit: 1
      },
      security_vigilance: {
        enabled: true,
        timeout_ms: 22000,
        max_cases: 1,
        strict: false,
        min_trit: -1,
        max_trit: 1
      },
      autotest_validation: {
        enabled: true,
        timeout_ms: 180000,
        scope: 'changed',
        max_tests: 12,
        sleep_only: true,
        strict: false,
        min_trit: -1,
        max_trit: 1
      },
      organ_atrophy_shadow: {
        enabled: true,
        timeout_ms: 16000,
        window_days: 30,
        max_candidates: 8,
        write_endpoints: true,
        min_trit: -1,
        max_trit: 1
      }
    },
    training_queue: {
      enabled: true,
      path: relPath(DEFAULT_TRAINING_QUEUE_PATH),
      max_rows_per_pulse: 6
    },
    telemetry: {
      emit_events: true,
      max_event_note_chars: 220
    }
  };
}

function normalizeTaskGate(src: AnyObj, fallback: AnyObj) {
  const task = src && typeof src === 'object' ? src : {};
  const scopeRaw = normalizeToken(task.scope || fallback.scope || 'changed', 24);
  const scope = ['changed', 'critical', 'all'].includes(scopeRaw) ? scopeRaw : 'changed';
  return {
    ...fallback,
    enabled: toBool(task.enabled, fallback.enabled !== false),
    timeout_ms: clampInt(task.timeout_ms, 1000, 120000, Number(fallback.timeout_ms || 12000)),
    min_trit: clampInt(task.min_trit, -1, 1, Number(fallback.min_trit || -1)),
    max_trit: clampInt(task.max_trit, -1, 1, Number(fallback.max_trit || 1)),
    days: clampInt(task.days, 1, 90, Number(fallback.days || 7)),
    top: clampInt(task.top, 1, 64, Number(fallback.top || 8)),
    max: clampInt(task.max, 1, 64, Number(fallback.max || 6)),
    mirror_days: clampInt(task.mirror_days, 1, 30, Number(fallback.mirror_days || 1)),
    max_promotions: clampInt(task.max_promotions, 1, 20, Number(fallback.max_promotions || 1)),
    max_cases: clampInt(task.max_cases, 1, 64, Number(fallback.max_cases || 1)),
    max_tests: clampInt(task.max_tests, 1, 256, Number(fallback.max_tests || 12)),
    window_days: clampInt(task.window_days, 1, 365, Number(fallback.window_days || 30)),
    max_candidates: clampInt(task.max_candidates, 1, 128, Number(fallback.max_candidates || 8)),
    include_idle_cycle: toBool(task.include_idle_cycle, fallback.include_idle_cycle === true),
    include_fractal_introspection: toBool(task.include_fractal_introspection, fallback.include_fractal_introspection === true),
    sleep_only: toBool(task.sleep_only, fallback.sleep_only === true),
    write_endpoints: toBool(task.write_endpoints, fallback.write_endpoints !== false),
    intent: cleanText(task.intent || fallback.intent || '', 220),
    scope,
    value_currency: normalizeToken(task.value_currency || fallback.value_currency || 'adaptive_value', 64) || 'adaptive_value',
    objective_id: normalizeToken(task.objective_id || fallback.objective_id || 'continuum_anticipation', 120) || 'continuum_anticipation',
    strict: toBool(task.strict, fallback.strict === true)
  };
}

function loadPolicy(policyPath: string) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const daemon = raw && raw.daemon && typeof raw.daemon === 'object' ? raw.daemon : {};
  const runtimeGuard = raw && raw.runtime_guard && typeof raw.runtime_guard === 'object' ? raw.runtime_guard : {};
  const signals = raw && raw.signals && typeof raw.signals === 'object' ? raw.signals : {};
  const tritWeights = raw && raw.trit_weights && typeof raw.trit_weights === 'object' ? raw.trit_weights : {};
  const cooldownSec = raw && raw.cooldown_sec && typeof raw.cooldown_sec === 'object' ? raw.cooldown_sec : {};
  const tasks = raw && raw.tasks && typeof raw.tasks === 'object' ? raw.tasks : {};
  const trainingQueue = raw && raw.training_queue && typeof raw.training_queue === 'object' ? raw.training_queue : {};
  const telemetry = raw && raw.telemetry && typeof raw.telemetry === 'object' ? raw.telemetry : {};
  return {
    version: cleanText(raw.version || base.version, 24) || '1.0',
    enabled: toBool(raw.enabled, true),
    low_priority_nice: clampInt(raw.low_priority_nice, -20, 19, base.low_priority_nice),
    daemon: {
      interval_sec: clampInt(daemon.interval_sec, 20, 24 * 60 * 60, base.daemon.interval_sec),
      max_cycles: clampInt(daemon.max_cycles, 0, 1000000, base.daemon.max_cycles),
      jitter_sec: clampInt(daemon.jitter_sec, 0, 600, base.daemon.jitter_sec)
    },
    runtime_guard: {
      max_load_per_cpu: clampNumber(runtimeGuard.max_load_per_cpu, 0.05, 8, base.runtime_guard.max_load_per_cpu),
      max_rss_mb: clampInt(runtimeGuard.max_rss_mb, 128, 128000, base.runtime_guard.max_rss_mb),
      max_heap_used_mb: clampInt(runtimeGuard.max_heap_used_mb, 64, 128000, base.runtime_guard.max_heap_used_mb),
      spine_hot_window_sec: clampInt(runtimeGuard.spine_hot_window_sec, 5, 3600, base.runtime_guard.spine_hot_window_sec)
    },
    signals: {
      max_drift_rate: clampNumber(signals.max_drift_rate, 0, 1, base.signals.max_drift_rate),
      max_policy_hold_rate: clampNumber(signals.max_policy_hold_rate, 0, 1, base.signals.max_policy_hold_rate),
      elevated_policy_hold_rate: clampNumber(signals.elevated_policy_hold_rate, 0, 1, base.signals.elevated_policy_hold_rate)
    },
    trit_weights: {
      drift: clampNumber(tritWeights.drift, 0.05, 10, base.trit_weights.drift),
      queue_pressure: clampNumber(tritWeights.queue_pressure, 0.05, 10, base.trit_weights.queue_pressure),
      hold_rate: clampNumber(tritWeights.hold_rate, 0.05, 10, base.trit_weights.hold_rate),
      resource_load: clampNumber(tritWeights.resource_load, 0.05, 10, base.trit_weights.resource_load),
      spine_hot: clampNumber(tritWeights.spine_hot, 0.05, 10, base.trit_weights.spine_hot)
    },
    cooldown_sec: {
      dream_consolidation: clampInt(cooldownSec.dream_consolidation, 0, 24 * 60 * 60, base.cooldown_sec.dream_consolidation),
      anticipation: clampInt(cooldownSec.anticipation, 0, 24 * 60 * 60, base.cooldown_sec.anticipation),
      self_improvement: clampInt(cooldownSec.self_improvement, 0, 24 * 60 * 60, base.cooldown_sec.self_improvement),
      creative_incubation: clampInt(cooldownSec.creative_incubation, 0, 24 * 60 * 60, base.cooldown_sec.creative_incubation),
      security_vigilance: clampInt(cooldownSec.security_vigilance, 0, 24 * 60 * 60, base.cooldown_sec.security_vigilance),
      autotest_validation: clampInt(cooldownSec.autotest_validation, 0, 24 * 60 * 60, base.cooldown_sec.autotest_validation),
      organ_atrophy_shadow: clampInt(cooldownSec.organ_atrophy_shadow, 0, 24 * 60 * 60, base.cooldown_sec.organ_atrophy_shadow)
    },
    tasks: {
      dream_consolidation: normalizeTaskGate(tasks.dream_consolidation, base.tasks.dream_consolidation),
      anticipation: normalizeTaskGate(tasks.anticipation, base.tasks.anticipation),
      self_improvement: normalizeTaskGate(tasks.self_improvement, base.tasks.self_improvement),
      creative_incubation: normalizeTaskGate(tasks.creative_incubation, base.tasks.creative_incubation),
      security_vigilance: normalizeTaskGate(tasks.security_vigilance, base.tasks.security_vigilance),
      autotest_validation: normalizeTaskGate(tasks.autotest_validation, base.tasks.autotest_validation),
      organ_atrophy_shadow: normalizeTaskGate(tasks.organ_atrophy_shadow, base.tasks.organ_atrophy_shadow)
    },
    training_queue: {
      enabled: toBool(trainingQueue.enabled, base.training_queue.enabled),
      path: cleanText(trainingQueue.path || base.training_queue.path, 260) || relPath(DEFAULT_TRAINING_QUEUE_PATH),
      max_rows_per_pulse: clampInt(trainingQueue.max_rows_per_pulse, 1, 128, base.training_queue.max_rows_per_pulse)
    },
    telemetry: {
      emit_events: toBool(telemetry.emit_events, base.telemetry.emit_events),
      max_event_note_chars: clampInt(telemetry.max_event_note_chars, 32, 2048, base.telemetry.max_event_note_chars)
    }
  };
}

function runtimePaths(policyPath: string) {
  const stateDir = process.env.CONTINUUM_STATE_DIR
    ? path.resolve(process.env.CONTINUUM_STATE_DIR)
    : DEFAULT_STATE_DIR;
  return {
    policy_path: policyPath,
    state_dir: stateDir,
    runs_dir: process.env.CONTINUUM_RUNS_DIR ? path.resolve(process.env.CONTINUUM_RUNS_DIR) : path.join(stateDir, 'runs'),
    events_dir: process.env.CONTINUUM_EVENTS_DIR ? path.resolve(process.env.CONTINUUM_EVENTS_DIR) : path.join(stateDir, 'events'),
    latest_path: process.env.CONTINUUM_LATEST_PATH ? path.resolve(process.env.CONTINUUM_LATEST_PATH) : path.join(stateDir, 'latest.json'),
    history_path: process.env.CONTINUUM_HISTORY_PATH ? path.resolve(process.env.CONTINUUM_HISTORY_PATH) : path.join(stateDir, 'history.jsonl'),
    runtime_state_path: process.env.CONTINUUM_RUNTIME_STATE_PATH ? path.resolve(process.env.CONTINUUM_RUNTIME_STATE_PATH) : path.join(stateDir, 'runtime_state.json'),
    training_queue_path: process.env.CONTINUUM_TRAINING_QUEUE_PATH
      ? path.resolve(process.env.CONTINUUM_TRAINING_QUEUE_PATH)
      : DEFAULT_TRAINING_QUEUE_PATH,
    autonomy_runs_dir: process.env.CONTINUUM_AUTONOMY_RUNS_DIR
      ? path.resolve(process.env.CONTINUUM_AUTONOMY_RUNS_DIR)
      : DEFAULT_AUTONOMY_RUNS_DIR,
    simulation_dir: process.env.CONTINUUM_SIM_DIR
      ? path.resolve(process.env.CONTINUUM_SIM_DIR)
      : DEFAULT_SIM_DIR,
    introspection_dir: process.env.CONTINUUM_INTROSPECTION_DIR
      ? path.resolve(process.env.CONTINUUM_INTROSPECTION_DIR)
      : DEFAULT_FRACTAL_INTROSPECTION_DIR,
    spine_runs_dir: process.env.CONTINUUM_SPINE_RUNS_DIR
      ? path.resolve(process.env.CONTINUUM_SPINE_RUNS_DIR)
      : DEFAULT_SPINE_RUNS_DIR
  };
}

function defaultRuntimeState() {
  return {
    version: '1.0',
    updated_at: null,
    last_pulse_ts: null,
    last_task_ts: {},
    daemon: {
      cycles: 0,
      last_cycle_ts: null
    }
  };
}

function loadRuntimeState(runtimeStatePath: string) {
  const state = readJson(runtimeStatePath, defaultRuntimeState());
  if (!state || typeof state !== 'object') return defaultRuntimeState();
  const out = {
    version: cleanText(state.version || '1.0', 24) || '1.0',
    updated_at: state.updated_at ? String(state.updated_at) : null,
    last_pulse_ts: state.last_pulse_ts ? String(state.last_pulse_ts) : null,
    last_task_ts: state.last_task_ts && typeof state.last_task_ts === 'object' ? state.last_task_ts : {},
    daemon: state.daemon && typeof state.daemon === 'object'
      ? state.daemon
      : { cycles: 0, last_cycle_ts: null }
  };
  return out;
}

function saveRuntimeState(runtimeStatePath: string, state: AnyObj) {
  const next = state && typeof state === 'object' ? state : defaultRuntimeState();
  next.version = '1.0';
  next.updated_at = nowIso();
  writeJsonAtomic(runtimeStatePath, next);
  return next;
}

function isPolicyHoldResult(result: unknown) {
  const normalized = String(result || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized === 'policy_hold'
    || normalized.startsWith('no_candidates_policy_')
    || normalized.startsWith('stop_init_gate_')
    || normalized.startsWith('stop_repeat_gate_');
}

function autonomyStats(dateStr: string, runsDir: string, days = 3) {
  const counts = {
    runs: 0,
    executed: 0,
    shipped: 0,
    no_change: 0,
    reverted: 0,
    policy_holds: 0
  };
  for (const day of windowDates(dateStr, Math.max(1, Math.min(14, days)))) {
    const rows = readJsonl(path.join(runsDir, `${day}.jsonl`));
    for (const row of rows) {
      if (!row || row.type !== 'autonomy_run') continue;
      counts.runs += 1;
      const result = String(row.result || '').trim().toLowerCase();
      const outcome = String(row.outcome || '').trim().toLowerCase();
      if (result === 'executed') counts.executed += 1;
      if (outcome === 'shipped') counts.shipped += 1;
      else if (outcome === 'no_change') counts.no_change += 1;
      else if (outcome === 'reverted') counts.reverted += 1;
      if (isPolicyHoldResult(result)) counts.policy_holds += 1;
    }
  }
  const holdRate = counts.runs > 0 ? counts.policy_holds / counts.runs : 0;
  const yieldRate = counts.executed > 0 ? counts.shipped / counts.executed : 0;
  const driftProxy = counts.executed > 0 ? counts.no_change / counts.executed : 0;
  return {
    ...counts,
    hold_rate: Number(holdRate.toFixed(6)),
    yield_rate: Number(yieldRate.toFixed(6)),
    drift_proxy: Number(driftProxy.toFixed(6))
  };
}

function simulationSignals(dateStr: string, simulationDir: string) {
  const payload = readJson(path.join(simulationDir, `${dateStr}.json`), {});
  const checks = payload && payload.checks_effective && typeof payload.checks_effective === 'object'
    ? payload.checks_effective
    : (payload && payload.checks && typeof payload.checks === 'object' ? payload.checks : {});
  const drift = Number(checks && checks.drift_rate && checks.drift_rate.value);
  const yieldRate = Number(checks && checks.yield_rate && checks.yield_rate.value);
  return {
    drift_rate: Number.isFinite(drift) ? Number(drift.toFixed(6)) : null,
    yield_rate: Number.isFinite(yieldRate) ? Number(yieldRate.toFixed(6)) : null
  };
}

function introspectionQueuePressure(dateStr: string, introspectionDir: string) {
  const payload = readJson(path.join(introspectionDir, `${dateStr}.json`), {});
  const snap = payload && payload.snapshot && typeof payload.snapshot === 'object'
    ? payload.snapshot
    : {};
  const queuePressure = cleanText(snap && snap.queue && snap.queue.pressure || 'unknown', 32).toLowerCase() || 'unknown';
  return queuePressure;
}

function latestMtimeMs(targetDir: string) {
  if (!fs.existsSync(targetDir)) return null;
  const ents = fs.readdirSync(targetDir, { withFileTypes: true });
  let maxMs = null;
  for (const ent of ents) {
    if (!ent || !ent.isFile()) continue;
    const abs = path.join(targetDir, ent.name);
    try {
      const st = fs.statSync(abs);
      if (!Number.isFinite(st.mtimeMs)) continue;
      maxMs = maxMs == null ? st.mtimeMs : Math.max(maxMs, st.mtimeMs);
    } catch {
      // ignore stat failures
    }
  }
  return maxMs;
}

function isSpineHot(spineRunsDir: string, windowSec: number) {
  const latestMs = latestMtimeMs(spineRunsDir);
  if (!Number.isFinite(Number(latestMs))) {
    return { hot: false, latest_ts: null, age_sec: null };
  }
  const ageSec = Math.max(0, (Date.now() - Number(latestMs)) / 1000);
  return {
    hot: ageSec <= Math.max(1, Number(windowSec || 0)),
    latest_ts: new Date(Number(latestMs)).toISOString(),
    age_sec: Number(ageSec.toFixed(2))
  };
}

function resourceSnapshot(policy: AnyObj) {
  const cpus = Math.max(1, os.cpus().length || 1);
  const load1 = Number(os.loadavg()[0] || 0);
  const loadPerCpu = cpus > 0 ? load1 / cpus : load1;
  const mem = process.memoryUsage();
  const rssMb = Number(mem.rss || 0) / (1024 * 1024);
  const heapUsedMb = Number(mem.heapUsed || 0) / (1024 * 1024);
  const guard = policy && policy.runtime_guard && typeof policy.runtime_guard === 'object'
    ? policy.runtime_guard
    : {};
  const within = loadPerCpu <= Number(guard.max_load_per_cpu || 0.65)
    && rssMb <= Number(guard.max_rss_mb || 900)
    && heapUsedMb <= Number(guard.max_heap_used_mb || 450);
  return {
    cpu_count: cpus,
    load_1m: Number(load1.toFixed(4)),
    load_per_cpu: Number(loadPerCpu.toFixed(4)),
    rss_mb: Number(rssMb.toFixed(2)),
    heap_used_mb: Number(heapUsedMb.toFixed(2)),
    within_limits: within
  };
}

function tritSignals(dateStr: string, policy: AnyObj, stats: AnyObj, sim: AnyObj, queuePressure: string, resource: AnyObj, spineHot: AnyObj) {
  const signalCfg = policy && policy.signals && typeof policy.signals === 'object'
    ? policy.signals
    : {};
  const weights = policy && policy.trit_weights && typeof policy.trit_weights === 'object'
    ? policy.trit_weights
    : {};

  const driftRate = Number(sim && sim.drift_rate);
  let driftTrit = TRIT_UNKNOWN;
  if (Number.isFinite(driftRate)) {
    driftTrit = driftRate <= Number(signalCfg.max_drift_rate || 0.03) ? TRIT_OK : TRIT_PAIN;
  }

  let queueTrit = TRIT_UNKNOWN;
  if (queuePressure === 'critical' || queuePressure === 'high') queueTrit = TRIT_PAIN;
  else if (queuePressure === 'elevated') queueTrit = TRIT_UNKNOWN;
  else if (queuePressure === 'normal' || queuePressure === 'low') queueTrit = TRIT_OK;

  const holdRate = Number(stats && stats.hold_rate || 0);
  let holdTrit = TRIT_UNKNOWN;
  if (Number(stats && stats.runs || 0) >= 10) {
    if (holdRate > Number(signalCfg.max_policy_hold_rate || 0.4)) holdTrit = TRIT_PAIN;
    else if (holdRate > Number(signalCfg.elevated_policy_hold_rate || 0.25)) holdTrit = TRIT_UNKNOWN;
    else holdTrit = TRIT_OK;
  }

  const resourceTrit = resource && resource.within_limits === true ? TRIT_OK : TRIT_PAIN;
  const spineHotTrit = spineHot && spineHot.hot === true ? TRIT_PAIN : TRIT_OK;

  const rows = [
    {
      name: 'drift',
      trit: driftTrit,
      label: tritLabel(driftTrit),
      value: Number.isFinite(driftRate) ? Number(driftRate.toFixed(6)) : null,
      weight: clampNumber(weights.drift, 0.01, 10, 1.4)
    },
    {
      name: 'queue_pressure',
      trit: queueTrit,
      label: tritLabel(queueTrit),
      value: queuePressure,
      weight: clampNumber(weights.queue_pressure, 0.01, 10, 1.1)
    },
    {
      name: 'policy_hold_rate',
      trit: holdTrit,
      label: tritLabel(holdTrit),
      value: Number(holdRate.toFixed(6)),
      weight: clampNumber(weights.hold_rate, 0.01, 10, 1)
    },
    {
      name: 'resource_load',
      trit: resourceTrit,
      label: tritLabel(resourceTrit),
      value: {
        load_per_cpu: Number(resource && resource.load_per_cpu || 0),
        rss_mb: Number(resource && resource.rss_mb || 0),
        heap_used_mb: Number(resource && resource.heap_used_mb || 0)
      },
      weight: clampNumber(weights.resource_load, 0.01, 10, 1.2)
    },
    {
      name: 'spine_activity',
      trit: spineHotTrit,
      label: tritLabel(spineHotTrit),
      value: spineHot && spineHot.age_sec != null ? Number(spineHot.age_sec) : null,
      weight: clampNumber(weights.spine_hot, 0.01, 10, 1.4)
    }
  ];

  const trit = majorityTrit(
    rows.map((row) => row.trit),
    {
      weights: rows.map((row) => row.weight),
      tie_breaker: 'unknown'
    }
  );
  return {
    trit,
    label: tritLabel(trit),
    signals: rows
  };
}

function applyLowPriority(niceValue: number) {
  try {
    os.setPriority(0, clampInt(niceValue, -20, 19, 10));
    return { ok: true, nice: clampInt(niceValue, -20, 19, 10), reason: null };
  } catch (err) {
    return {
      ok: false,
      nice: null,
      reason: cleanText(err && err.message ? err.message : err || 'set_priority_failed', 160)
    };
  }
}

function withinTaskTritGate(taskCfg: AnyObj, trit: number) {
  const minTrit = clampInt(taskCfg && taskCfg.min_trit, -1, 1, -1);
  const maxTrit = clampInt(taskCfg && taskCfg.max_trit, -1, 1, 1);
  return trit >= minTrit && trit <= maxTrit;
}

function cooldownRemainingSec(state: AnyObj, taskId: string, cooldownSec: number) {
  const map = state && state.last_task_ts && typeof state.last_task_ts === 'object'
    ? state.last_task_ts
    : {};
  const ts = String(map[taskId] || '').trim();
  if (!ts) return 0;
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return 0;
  const elapsedSec = Math.max(0, (Date.now() - ms) / 1000);
  const rem = Math.max(0, Number(cooldownSec || 0) - elapsedSec);
  return Number(rem.toFixed(2));
}

function runNodeJson(scriptRel: string, args: string[], opts: AnyObj) {
  if (!ALLOWED_SCRIPTS.has(scriptRel)) {
    return {
      ok: false,
      code: 2,
      payload: null,
      timed_out: false,
      stdout: '',
      stderr: `script_not_allowed:${scriptRel}`,
      duration_ms: 0
    };
  }
  const cleanArgs = Array.isArray(args) ? args.map((arg) => String(arg || '')) : [];
  if (opts && opts.dry_run === true) {
    return {
      ok: true,
      code: 0,
      payload: {
        ok: true,
        type: 'continuum_dry_run',
        script: scriptRel,
        args: cleanArgs
      },
      timed_out: false,
      stdout: '',
      stderr: '',
      dry_run: true,
      duration_ms: 0
    };
  }
  const timeoutMs = clampInt(opts && opts.timeout_ms, 1000, 180000, 15000);
  const started = Date.now();
  const run = spawnSync('node', [scriptRel, ...cleanArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  const durationMs = Date.now() - started;
  const spawnError = run.error ? cleanText(run.error && run.error.message ? run.error.message : run.error, 180) : '';
  const timedOut = run.error && String(run.error.code || '').toLowerCase() === 'etimedout';
  const stdout = cleanText(run.stdout, 1200);
  const stderr = cleanText([run.stderr, spawnError, timedOut ? 'process_timeout' : ''].filter(Boolean).join(' '), 1200);
  const payload = parseJsonFromOutput(String(run.stdout || ''));
  return {
    ok: run.status === 0,
    code: run.status == null ? 1 : run.status,
    payload,
    timed_out: !!timedOut,
    stdout,
    stderr,
    duration_ms: durationMs
  };
}

function summarizeRun(label: string, run: AnyObj, extra: AnyObj = {}) {
  const payload = run && run.payload && typeof run.payload === 'object' ? run.payload : {};
  return {
    label,
    ok: run && run.ok === true && (payload.ok !== false),
    code: Number(run && run.code || 0),
    duration_ms: Number(run && run.duration_ms || 0),
    timed_out: run && run.timed_out === true,
    reason: run && run.ok === true && payload.ok !== false
      ? null
      : cleanText(run && (run.stderr || run.stdout) || '', 180),
    payload,
    ...extra
  };
}

function emitContinuumEvent(paths: AnyObj, policy: AnyObj, dateStr: string, stage: string, row: AnyObj) {
  if (!(policy && policy.telemetry && policy.telemetry.emit_events === true)) return null;
  const out = {
    ts: nowIso(),
    type: 'continuum_event',
    date: dateStr,
    stage: normalizeToken(stage, 64) || 'unknown',
    ...row
  };
  appendJsonl(path.join(paths.events_dir, `${dateStr}.jsonl`), out);
  return out;
}

function runDreamConsolidation(dateStr: string, taskCfg: AnyObj, dryRun: boolean) {
  const dreamRun = runNodeJson(SCRIPT_MEMORY_DREAM, [
    'run',
    dateStr,
    `--days=${clampInt(taskCfg.days, 1, 14, 3)}`,
    `--top=${clampInt(taskCfg.top, 1, 32, 8)}`
  ], {
    timeout_ms: taskCfg.timeout_ms,
    dry_run: dryRun
  });
  let idleRun = null;
  if (taskCfg.include_idle_cycle === true) {
    idleRun = runNodeJson(SCRIPT_IDLE_DREAM, ['run', dateStr], {
      timeout_ms: taskCfg.timeout_ms,
      dry_run: dryRun
    });
  }
  const dreamSummary = summarizeRun('memory_dream', dreamRun);
  const idleSummary = idleRun ? summarizeRun('idle_dream_cycle', idleRun) : null;
  const themes = Number(dreamSummary.payload && dreamSummary.payload.themes || 0);
  const pointerRows = Number(dreamSummary.payload && dreamSummary.payload.pointer_rows || 0);
  const ok = dreamSummary.ok && (!idleSummary || idleSummary.ok);
  return {
    ok,
    themes,
    pointer_rows: pointerRows,
    memory_dream: dreamSummary,
    idle_dream_cycle: idleSummary
  };
}

function runAnticipation(dateStr: string, taskCfg: AnyObj, dryRun: boolean) {
  const run = runNodeJson(SCRIPT_WORKFLOW_CONTROLLER, [
    'run',
    dateStr,
    `--days=${clampInt(taskCfg.days, 1, 90, 14)}`,
    `--max=${clampInt(taskCfg.max, 1, 32, 6)}`,
    '--apply=0',
    '--orchestron=1',
    '--orchestron-apply=0',
    '--orchestron-auto=0',
    `--intent=${cleanText(taskCfg.intent || '', 180)}`,
    `--value-currency=${normalizeToken(taskCfg.value_currency || 'adaptive_value', 64) || 'adaptive_value'}`,
    `--objective-id=${normalizeToken(taskCfg.objective_id || 'continuum_anticipation', 120) || 'continuum_anticipation'}`
  ], {
    timeout_ms: taskCfg.timeout_ms,
    dry_run: dryRun
  });
  const summary = summarizeRun('workflow_controller', run);
  return {
    ok: summary.ok,
    drafts: Number(summary.payload && summary.payload.orchestron_drafts || 0),
    promotable_drafts: Number(summary.payload && summary.payload.orchestron_promotable_drafts || 0),
    candidates: Number(summary.payload && summary.payload.orchestron_candidates || 0),
    workflow_controller: summary
  };
}

function runSelfImprovement(dateStr: string, taskCfg: AnyObj, dryRun: boolean) {
  const mirrorRun = runNodeJson(SCRIPT_OBSERVER_MIRROR, [
    'run',
    dateStr,
    `--days=${clampInt(taskCfg.mirror_days, 1, 14, 1)}`
  ], {
    timeout_ms: taskCfg.timeout_ms,
    dry_run: dryRun
  });
  let introspectionRun = null;
  if (taskCfg.include_fractal_introspection !== false) {
    introspectionRun = runNodeJson(SCRIPT_FRACTAL_INTROSPECTION, [
      'run',
      dateStr
    ], {
      timeout_ms: taskCfg.timeout_ms,
      dry_run: dryRun
    });
  }
  const mirrorSummary = summarizeRun('observer_mirror', mirrorRun);
  const introspectionSummary = introspectionRun ? summarizeRun('fractal_introspection', introspectionRun) : null;
  return {
    ok: mirrorSummary.ok && (!introspectionSummary || introspectionSummary.ok),
    mood: cleanText(mirrorSummary.payload && mirrorSummary.payload.mood || '', 32),
    restructure_candidates: Number(introspectionSummary && introspectionSummary.payload && introspectionSummary.payload.restructure_candidates || 0),
    observer_mirror: mirrorSummary,
    fractal_introspection: introspectionSummary
  };
}

function runCreativeIncubation(dateStr: string, taskCfg: AnyObj, dryRun: boolean) {
  const run = runNodeJson(SCRIPT_CREATIVE_LINKS, [
    'run',
    dateStr,
    `--days=${clampInt(taskCfg.days, 1, 30, 7)}`,
    `--top=${clampInt(taskCfg.top, 1, 40, 12)}`,
    `--max-promotions=${clampInt(taskCfg.max_promotions, 1, 10, 1)}`
  ], {
    timeout_ms: taskCfg.timeout_ms,
    dry_run: dryRun
  });
  const summary = summarizeRun('creative_links', run);
  return {
    ok: summary.ok,
    promoted_count: Number(summary.payload && summary.payload.promoted_count || 0),
    ranked_count: Number(summary.payload && summary.payload.ranked_count || 0),
    creative_links: summary
  };
}

function runSecurityVigilance(dateStr: string, taskCfg: AnyObj, dryRun: boolean) {
  const args = [
    'run',
    dateStr,
    `--max-cases=${clampInt(taskCfg.max_cases, 1, 64, 1)}`
  ];
  if (taskCfg.strict === true) args.push('--strict');
  const run = runNodeJson(SCRIPT_RED_TEAM, args, {
    timeout_ms: taskCfg.timeout_ms,
    dry_run: dryRun
  });
  const summary = summarizeRun('red_team_harness', run);
  return {
    ok: summary.ok,
    executed_cases: Number(summary.payload && summary.payload.executed_cases || 0),
    critical_fail_cases: Number(summary.payload && summary.payload.critical_fail_cases || 0),
    red_team_harness: summary
  };
}

function runAutotestValidation(taskCfg: AnyObj, dryRun: boolean) {
  const scope = ['changed', 'critical', 'all'].includes(String(taskCfg && taskCfg.scope || ''))
    ? String(taskCfg.scope)
    : 'changed';
  const args = [
    'pulse',
    `--scope=${scope}`,
    `--max-tests=${clampInt(taskCfg && taskCfg.max_tests, 1, 256, 12)}`,
    `--sleep-only=${taskCfg && taskCfg.sleep_only === false ? '0' : '1'}`,
    `--strict=${taskCfg && taskCfg.strict === true ? '1' : '0'}`
  ];
  const run = runNodeJson(SCRIPT_AUTOTEST, args, {
    timeout_ms: taskCfg && taskCfg.timeout_ms,
    dry_run: dryRun
  });
  const summary = summarizeRun('autotest_controller', run);
  const payload = summary.payload && typeof summary.payload === 'object' ? summary.payload : {};
  const runPayload = payload.run && typeof payload.run === 'object' ? payload.run : {};
  const reportPayload = payload.report && typeof payload.report === 'object' ? payload.report : {};
  return {
    ok: summary.ok,
    selected_tests: Number(runPayload.selected_tests || 0),
    failed: Number(runPayload.failed || 0),
    guard_blocked: Number(runPayload.guard_blocked || 0),
    untested_modules: Number(runPayload.untested_modules || 0),
    report_failed_tests: Number(reportPayload.failed_tests || 0),
    report_untested_modules: Number(reportPayload.untested_modules || 0),
    autotest_controller: summary
  };
}

function runOrganAtrophyShadow(dateStr: string, taskCfg: AnyObj, dryRun: boolean) {
  const args = [
    'scan',
    dateStr,
    `--window-days=${clampInt(taskCfg && taskCfg.window_days, 1, 365, 30)}`,
    `--max-candidates=${clampInt(taskCfg && taskCfg.max_candidates, 1, 128, 8)}`,
    `--persist=${dryRun ? '0' : '1'}`,
    `--write-endpoints=${taskCfg && taskCfg.write_endpoints === false ? '0' : '1'}`
  ];
  const run = runNodeJson(SCRIPT_ORGAN_ATROPHY, args, {
    timeout_ms: taskCfg && taskCfg.timeout_ms,
    dry_run: dryRun
  });
  const summary = summarizeRun('organ_atrophy_controller', run);
  const payload = summary.payload && typeof summary.payload === 'object' ? summary.payload : {};
  return {
    ok: summary.ok,
    scanned_organs: Number(payload.scanned_organs || 0),
    candidates_count: Number(payload.candidates_count || 0),
    endpoints_written: Number(payload.endpoints_written || 0),
    organ_atrophy_controller: summary
  };
}

function dualBrainLaneForTask(taskId: string) {
  const id = normalizeToken(taskId || '', 64);
  if (id === 'dream_consolidation') return 'right';
  if (id === 'creative_incubation') return 'right';
  if (id === 'anticipation') return 'right';
  if (id === 'organ_atrophy_shadow') return 'left';
  return 'left';
}

function dualBrainTaskClassForTask(taskId: string) {
  const id = normalizeToken(taskId || '', 64);
  if (id === 'dream_consolidation') return 'dream';
  if (id === 'creative_incubation') return 'creative';
  if (id === 'anticipation') return 'workflow_generation';
  if (id === 'autotest_validation') return 'governance';
  if (id === 'organ_atrophy_shadow') return 'governance';
  if (id === 'security_vigilance') return 'security';
  if (id === 'self_improvement') return 'identity';
  return 'general';
}

function resolveTrainingQueuePath(paths: AnyObj, policy: AnyObj) {
  const configured = cleanText(policy && policy.training_queue && policy.training_queue.path || '', 260);
  if (!configured) return paths.training_queue_path;
  if (path.isAbsolute(configured)) return path.resolve(configured);
  return path.resolve(ROOT, configured);
}

function appendTrainingQueue(paths: AnyObj, policy: AnyObj, pulse: AnyObj, maxRows: number) {
  if (!(policy && policy.training_queue && policy.training_queue.enabled === true)) {
    return { enabled: false, appended: 0, path: null };
  }
  const queuePath = resolveTrainingQueuePath(paths, policy);
  const rows = [];
  const base = {
    ts: nowIso(),
    type: 'continuum_training_signal',
    date: pulse.date,
    run_id: pulse.run_id,
    profile: pulse.profile,
    trit: pulse.trit && Number(pulse.trit.value || 0),
    trit_label: pulse.trit && String(pulse.trit.label || 'unknown')
  };
  const signals = Array.isArray(pulse.trit && pulse.trit.signals) ? pulse.trit.signals : [];
  for (const signal of signals) {
    rows.push({
      ...base,
      lane: 'signal',
      signal: cleanText(signal && signal.name || 'unknown', 60),
      value: signal && Object.prototype.hasOwnProperty.call(signal, 'value') ? signal.value : null,
      signal_trit: Number(signal && signal.trit || 0),
      signal_label: cleanText(signal && signal.label || 'unknown', 24)
    });
  }
  for (const action of Array.isArray(pulse.actions) ? pulse.actions : []) {
    rows.push({
      ...base,
      lane: 'action',
      action: cleanText(action && action.id || 'unknown', 80),
      ok: action && action.ok === true,
      skipped: action && action.skipped === true,
      reason: cleanText(action && action.reason || '', 180),
      metrics: action && action.metrics && typeof action.metrics === 'object'
        ? action.metrics
        : {}
    });
  }
  const capped = rows.slice(0, Math.max(1, Math.min(256, maxRows)));
  for (const row of capped) appendJsonl(queuePath, row);
  return {
    enabled: true,
    appended: capped.length,
    path: relPath(queuePath)
  };
}

function pulse(dateStr: string, opts: AnyObj = {}) {
  const policyPath = path.resolve(String(opts.policy_path || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath);
  ensureDir(paths.runs_dir);
  ensureDir(paths.events_dir);
  ensureDir(path.dirname(paths.latest_path));
  ensureDir(path.dirname(paths.history_path));
  ensureDir(path.dirname(paths.runtime_state_path));
  ensureDir(path.dirname(paths.training_queue_path));

  const profile = normalizeToken(opts.profile || 'manual', 24) || 'manual';
  const reason = cleanText(opts.reason || `continuum_${profile}_pulse`, 180) || `continuum_${profile}_pulse`;
  const dryRun = opts.dry_run === true;
  const force = opts.force === true;
  const runId = `cont_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();

  const runtimeState = loadRuntimeState(paths.runtime_state_path);
  const priority = applyLowPriority(policy.low_priority_nice);
  const resource = resourceSnapshot(policy);
  const spineHot = isSpineHot(paths.spine_runs_dir, Number(policy.runtime_guard && policy.runtime_guard.spine_hot_window_sec || 60));
  const autonomy = autonomyStats(dateStr, paths.autonomy_runs_dir, 3);
  const simulation = simulationSignals(dateStr, paths.simulation_dir);
  const queuePressure = introspectionQueuePressure(dateStr, paths.introspection_dir);
  const trit = tritSignals(dateStr, policy, autonomy, simulation, queuePressure, resource, spineHot);

  const skipReasons = [];
  if (policy.enabled !== true) skipReasons.push('continuum_disabled');
  if (!resource.within_limits) skipReasons.push('resource_guard');
  if (spineHot.hot === true) skipReasons.push('spine_hot');
  const skipped = skipReasons.length > 0 && force !== true;

  const actions = [];
  const taskEvents = {
    dream: 0,
    anticipation: 0,
    self_improvement: 0,
    creative: 0,
    security: 0,
    autotest: 0,
    atrophy: 0
  };
  const recordTask = (taskId: string, stage: string, result: AnyObj, metrics: AnyObj = {}, skippedTask = false) => {
    const entry = {
      id: taskId,
      stage,
      ok: result && result.ok === true,
      skipped: skippedTask === true,
      reason: skippedTask === true ? cleanText(result && result.reason || 'skipped', 120) : null,
      metrics
    };
    actions.push(entry);
    emitContinuumEvent(paths, policy, dateStr, stage, {
      run_id: runId,
      profile,
      reason,
      ok: entry.ok,
      skipped: entry.skipped,
      trit: trit.trit,
      trit_label: trit.label,
      metrics
    });
    return entry;
  };

  const taskCfg = policy.tasks && typeof policy.tasks === 'object' ? policy.tasks : {};
  const cooldownCfg = policy.cooldown_sec && typeof policy.cooldown_sec === 'object' ? policy.cooldown_sec : {};

  if (!skipped) {
    const runTask = (taskId: string, stage: string, fn: () => AnyObj) => {
      const cfg = taskCfg[taskId] && typeof taskCfg[taskId] === 'object' ? taskCfg[taskId] : null;
      if (!cfg || cfg.enabled !== true) {
        return recordTask(taskId, stage, { ok: true, reason: 'task_disabled' }, {}, true);
      }
      if (!withinTaskTritGate(cfg, trit.trit)) {
        return recordTask(taskId, stage, { ok: true, reason: 'trit_gate_skip' }, { trit_gate: `${cfg.min_trit}:${cfg.max_trit}` }, true);
      }
      const cooldownRem = cooldownRemainingSec(runtimeState, taskId, Number(cooldownCfg[taskId] || 0));
      if (cooldownRem > 0 && force !== true) {
        return recordTask(taskId, stage, { ok: true, reason: `cooldown_${cooldownRem}s` }, { cooldown_remaining_sec: cooldownRem }, true);
      }
      let dualBrain = null;
      if (typeof decideBrainRoute === 'function') {
        try {
          dualBrain = decideBrainRoute({
            context: `continuum.${stage}`,
            task_class: dualBrainTaskClassForTask(taskId),
            desired_lane: dualBrainLaneForTask(taskId),
            trit: trit.trit,
            date: dateStr,
            persist: dryRun !== true
          });
        } catch (err) {
          dualBrain = {
            ok: false,
            error: cleanText(err && err.message ? err.message : err || 'dual_brain_route_failed', 180)
          };
        }
      }
      const started = Date.now();
      const out = fn();
      const elapsedMs = Date.now() - started;
      if (!runtimeState.last_task_ts || typeof runtimeState.last_task_ts !== 'object') runtimeState.last_task_ts = {};
      runtimeState.last_task_ts[taskId] = nowIso();
      const metrics = {
        duration_ms: elapsedMs,
        dual_brain: dualBrain && typeof dualBrain === 'object'
          ? {
              mode: cleanText(dualBrain.mode || '', 48),
              selected_live_brain: cleanText(dualBrain.selected_live_brain || '', 24),
              right_permitted: !!(dualBrain.right && dualBrain.right.permitted === true),
              right_shadow: !!(dualBrain.right && dualBrain.right.shadow === true),
              reasons: Array.isArray(dualBrain.reasons) ? dualBrain.reasons.slice(0, 6) : []
            }
          : null,
        ...(out && typeof out === 'object' ? out : {})
      };
      delete metrics.memory_dream;
      delete metrics.idle_dream_cycle;
      delete metrics.workflow_controller;
      delete metrics.observer_mirror;
      delete metrics.fractal_introspection;
      delete metrics.creative_links;
      delete metrics.red_team_harness;
      delete metrics.autotest_controller;
      delete metrics.organ_atrophy_controller;
      return recordTask(taskId, stage, out, metrics, false);
    };

    const dreamOut = runTask('dream_consolidation', 'dream_consolidation', () => runDreamConsolidation(dateStr, taskCfg.dream_consolidation, dryRun));
    if (dreamOut.skipped !== true) taskEvents.dream += 1;
    const anticipationOut = runTask('anticipation', 'anticipation', () => runAnticipation(dateStr, taskCfg.anticipation, dryRun));
    if (anticipationOut.skipped !== true) taskEvents.anticipation += 1;
    const selfImproveOut = runTask('self_improvement', 'self_improvement', () => runSelfImprovement(dateStr, taskCfg.self_improvement, dryRun));
    if (selfImproveOut.skipped !== true) taskEvents.self_improvement += 1;
    const creativeOut = runTask('creative_incubation', 'creative_incubation', () => runCreativeIncubation(dateStr, taskCfg.creative_incubation, dryRun));
    if (creativeOut.skipped !== true) taskEvents.creative += 1;
    const securityOut = runTask('security_vigilance', 'security_vigilance', () => runSecurityVigilance(dateStr, taskCfg.security_vigilance, dryRun));
    if (securityOut.skipped !== true) taskEvents.security += 1;
    const autotestOut = runTask('autotest_validation', 'autotest_validation', () => runAutotestValidation(taskCfg.autotest_validation, dryRun));
    if (autotestOut.skipped !== true) taskEvents.autotest += 1;
    const atrophyOut = runTask('organ_atrophy_shadow', 'organ_atrophy_shadow', () => runOrganAtrophyShadow(dateStr, taskCfg.organ_atrophy_shadow, dryRun));
    if (atrophyOut.skipped !== true) taskEvents.atrophy += 1;
  }

  runtimeState.last_pulse_ts = nowIso();
  saveRuntimeState(paths.runtime_state_path, runtimeState);

  const pulsePayload = {
    ok: true,
    type: 'continuum_pulse',
    ts: nowIso(),
    run_id: runId,
    date: dateStr,
    profile,
    reason,
    dry_run: dryRun,
    force,
    skipped,
    skip_reasons: skipReasons,
    policy: {
      version: policy.version,
      path: relPath(policyPath)
    },
    priority,
    resource,
    spine_hot: spineHot,
    autonomy,
    simulation,
    queue_pressure: queuePressure,
    trit: {
      value: Number(trit.trit || 0),
      label: trit.label,
      signals: trit.signals
    },
    tasks_executed: actions.filter((row) => row && row.skipped !== true).length,
    task_events: taskEvents,
    actions,
    duration_ms: Date.now() - startedAt
  };

  const queueResult = appendTrainingQueue(
    paths,
    policy,
    pulsePayload,
    Number(policy.training_queue && policy.training_queue.max_rows_per_pulse || 6)
  );
  pulsePayload.training_queue = queueResult;
  emitContinuumEvent(paths, policy, dateStr, 'consolidation', {
    run_id: runId,
    profile,
    reason,
    trit: pulsePayload.trit.value,
    trit_label: pulsePayload.trit.label,
    skipped: pulsePayload.skipped === true,
    task_events: taskEvents,
    training_queue_rows: Number(queueResult && queueResult.appended || 0)
  });

  const runPath = path.join(paths.runs_dir, `${dateStr}.json`);
  writeJsonAtomic(runPath, pulsePayload);
  writeJsonAtomic(paths.latest_path, pulsePayload);
  appendJsonl(paths.history_path, {
    ts: pulsePayload.ts,
    type: pulsePayload.type,
    run_id: pulsePayload.run_id,
    date: pulsePayload.date,
    profile: pulsePayload.profile,
    skipped: pulsePayload.skipped === true,
    trit: pulsePayload.trit.value,
    trit_label: pulsePayload.trit.label,
    tasks_executed: pulsePayload.tasks_executed,
    training_queue_rows: Number(queueResult && queueResult.appended || 0),
    duration_ms: pulsePayload.duration_ms
  });
  pulsePayload.run_path = relPath(runPath);
  pulsePayload.latest_path = relPath(paths.latest_path);
  pulsePayload.history_path = relPath(paths.history_path);
  return pulsePayload;
}

function status(dateArg: string, opts: AnyObj = {}) {
  const policyPath = path.resolve(String(opts.policy_path || DEFAULT_POLICY_PATH));
  const paths = runtimePaths(policyPath);
  const key = String(dateArg || 'latest').trim().toLowerCase();
  const payload = key === 'latest'
    ? readJson(paths.latest_path, null)
    : readJson(path.join(paths.runs_dir, `${toDate(key)}.json`), null);
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      type: 'continuum_status',
      error: 'continuum_snapshot_missing',
      date: key === 'latest' ? 'latest' : toDate(key)
    };
  }
  return {
    ok: true,
    type: 'continuum_status',
    ts: payload.ts || null,
    run_id: payload.run_id || null,
    date: payload.date || null,
    profile: payload.profile || null,
    skipped: payload.skipped === true,
    trit: payload.trit && Number(payload.trit.value || 0),
    trit_label: payload.trit && payload.trit.label ? payload.trit.label : 'unknown',
    tasks_executed: Number(payload.tasks_executed || 0),
    training_queue_rows: Number(payload.training_queue && payload.training_queue.appended || 0),
    run_path: payload.run_path || relPath(path.join(paths.runs_dir, `${payload.date || toDate(nowIso())}.json`)),
    latest_path: relPath(paths.latest_path)
  };
}

async function daemon(opts: AnyObj = {}) {
  const policyPath = path.resolve(String(opts.policy_path || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath);
  ensureDir(path.dirname(paths.runtime_state_path));

  const intervalSec = clampInt(
    opts.interval_sec != null ? opts.interval_sec : policy.daemon.interval_sec,
    20,
    24 * 60 * 60,
    policy.daemon.interval_sec
  );
  const maxCycles = clampInt(
    opts.max_cycles != null ? opts.max_cycles : policy.daemon.max_cycles,
    0,
    1000000,
    policy.daemon.max_cycles
  );
  const dryRun = opts.dry_run === true;
  const profile = normalizeToken(opts.profile || 'daemon', 24) || 'daemon';
  const jitterSec = clampInt(policy.daemon && policy.daemon.jitter_sec, 0, 600, 0);
  const startedTs = nowIso();
  let cycles = 0;
  const startedMs = Date.now();
  let lastPulse = null;

  while (true) {
    const dateStr = toDate(nowIso());
    lastPulse = pulse(dateStr, {
      policy_path: policyPath,
      profile,
      reason: `continuum_daemon_cycle_${cycles + 1}`,
      dry_run: dryRun,
      force: false
    });
    cycles += 1;

    const runtimeState = loadRuntimeState(paths.runtime_state_path);
    if (!runtimeState.daemon || typeof runtimeState.daemon !== 'object') runtimeState.daemon = {};
    runtimeState.daemon.cycles = Number(runtimeState.daemon.cycles || 0) + 1;
    runtimeState.daemon.last_cycle_ts = nowIso();
    saveRuntimeState(paths.runtime_state_path, runtimeState);

    if (maxCycles > 0 && cycles >= maxCycles) break;
    const jitter = jitterSec > 0
      ? Math.floor(Math.random() * ((jitterSec * 2) + 1)) - jitterSec
      : 0;
    await sleepMs(Math.max(1000, (intervalSec + jitter) * 1000));
  }

  return {
    ok: true,
    type: 'continuum_daemon',
    ts: nowIso(),
    started_at: startedTs,
    completed_at: nowIso(),
    profile,
    dry_run: dryRun,
    interval_sec: intervalSec,
    max_cycles: maxCycles,
    cycles_completed: cycles,
    duration_ms: Date.now() - startedMs,
    last_pulse: lastPulse
      ? {
          run_id: lastPulse.run_id,
          date: lastPulse.date,
          trit: lastPulse.trit && lastPulse.trit.value,
          trit_label: lastPulse.trit && lastPulse.trit.label,
          skipped: lastPulse.skipped === true
        }
      : null
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || args.help === true || cmd === 'h') {
    usage();
    return;
  }
  const policyPath = path.resolve(String(args.policy || process.env.CONTINUUM_POLICY_PATH || DEFAULT_POLICY_PATH));
  const profile = normalizeToken(args.profile || '', 24);
  const dryRun = toBool(args['dry-run'], false);
  const force = toBool(args.force, false);

  if (cmd === 'pulse' || cmd === 'run') {
    const dateStr = toDate(args._[1]);
    const out = pulse(dateStr, {
      policy_path: policyPath,
      profile: profile || 'manual',
      reason: args.reason,
      dry_run: dryRun,
      force
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }

  if (cmd === 'status') {
    const out = status(String(args._[1] || 'latest'), {
      policy_path: policyPath
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    if (out.ok !== true) process.exitCode = 1;
    return;
  }

  if (cmd === 'daemon') {
    const out = await daemon({
      policy_path: policyPath,
      profile: profile || 'daemon',
      interval_sec: args['interval-sec'] != null ? args['interval-sec'] : args.interval_sec,
      max_cycles: args['max-cycles'] != null ? args['max-cycles'] : args.max_cycles,
      dry_run: dryRun
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }

  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  main().catch((err) => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'continuum_core',
      error: cleanText(err && err.message ? err.message : err || 'continuum_failed', 220)
    })}\n`);
    process.exit(1);
  });
}

module.exports = {
  defaultPolicy,
  loadPolicy,
  pulse,
  status,
  daemon,
  runtimePaths,
  tritSignals,
  autonomyStats,
  simulationSignals,
  introspectionQueuePressure,
  resourceSnapshot,
  isSpineHot
};
