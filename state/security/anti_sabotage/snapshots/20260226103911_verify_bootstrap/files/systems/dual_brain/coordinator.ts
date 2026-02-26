#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/dual_brain/coordinator.js
 *
 * Resource-aware dual-brain routing coordinator.
 * - Left brain (standard/autoregressive) is always the live default.
 * - Right brain (creative/diffusion lane) is opportunistic and gated.
 * - Shadow mode keeps right-brain decisions observable without altering
 *   critical execution paths.
 *
 * Usage:
 *   node systems/dual_brain/coordinator.js status [--policy=path]
 *   node systems/dual_brain/coordinator.js route --context=<ctx> [--task-class=<class>] [--desired-lane=auto|left|right] [--trit=-1|0|1] [--persist=1|0] [--policy=path]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'dual_brain_policy.json');
const DEFAULT_STATE_DIR = path.join(ROOT, 'state', 'dual_brain');
const DEFAULT_LATEST_PATH = path.join(DEFAULT_STATE_DIR, 'latest.json');
const DEFAULT_RUNS_DIR = path.join(DEFAULT_STATE_DIR, 'runs');
const DEFAULT_EVENTS_DIR = path.join(DEFAULT_STATE_DIR, 'events');
const DEFAULT_HISTORY_PATH = path.join(DEFAULT_STATE_DIR, 'history.jsonl');
const DEFAULT_CONTINUUM_LATEST_PATH = path.join(ROOT, 'state', 'autonomy', 'continuum', 'latest.json');
const DEFAULT_BUDGET_STATE_DIR = path.join(ROOT, 'state', 'autonomy', 'daily_budget');
const DEFAULT_BUDGET_AUTOPAUSE_PATH = path.join(ROOT, 'state', 'autonomy', 'budget_autopause.json');
const DEFAULT_INTEGRITY_LOG_PATH = path.join(ROOT, 'state', 'security', 'integrity_violations.jsonl');
const DEFAULT_SPINE_RUNS_DIR = path.join(ROOT, 'state', 'spine', 'runs');

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

function cleanText(v: unknown, maxLen = 180) {
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

function readJsonlRows(filePath: string) {
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

function readJsonlTail(filePath: string, maxRows = 400) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const rows = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const tail = rows.slice(Math.max(0, rows.length - Math.max(1, maxRows)));
    return tail
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

function parseTsMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = String(tok).indexOf('=');
    if (idx >= 0) {
      out[String(tok).slice(2, idx)] = String(tok).slice(idx + 1);
    } else {
      out[String(tok).slice(2)] = true;
    }
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/dual_brain/coordinator.js status [--policy=path]');
  console.log('  node systems/dual_brain/coordinator.js route --context=<ctx> [--task-class=<class>] [--desired-lane=auto|left|right] [--trit=-1|0|1] [--persist=1|0] [--policy=path]');
}

function normalizeTokenList(v: unknown, maxLen = 80) {
  return (Array.isArray(v) ? v : [])
    .map((row) => normalizeToken(row, maxLen))
    .filter(Boolean);
}

function matchesAny(haystack: string, needles: string[]) {
  const target = normalizeToken(haystack, 240);
  for (const needle of needles) {
    const n = normalizeToken(needle, 120);
    if (!n) continue;
    if (target.includes(n)) return true;
  }
  return false;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_mode: true,
    left_brain: {
      id: 'left_standard',
      model: 'qwen3:4b',
      force_context_contains: [
        'identity',
        'governance',
        'contract',
        'security',
        'execution',
        'spine'
      ],
      force_task_classes: [
        'identity',
        'governance',
        'contract',
        'security',
        'execution',
        'spine',
        'critical'
      ]
    },
    right_brain: {
      enabled: true,
      id: 'right_creative',
      model: 'qwen3:4b',
      opportunistic_only: true,
      allowed_context_contains: [
        'dream',
        'creative',
        'orchestron',
        'workflow_generation',
        'hyper_creative',
        'incubation'
      ],
      allowed_task_classes: [
        'creative',
        'dream',
        'workflow_generation',
        'incubation',
        'training'
      ]
    },
    trit: {
      require_non_pain_for_right: true,
      min_right_trit: 0
    },
    thresholds: {
      hardware: {
        min_cpu_count: 4,
        max_load_per_cpu: 0.68,
        min_free_mem_mb: 1200,
        max_process_rss_mb: 1800,
        max_process_heap_mb: 900
      },
      budget: {
        require_budget_data: true,
        min_token_headroom_ratio: 0.2,
        max_burn_pct: 85,
        deny_when_autopause_active: true
      },
      stability: {
        max_effective_drift_rate: 0.035,
        max_policy_hold_rate: 0.5,
        max_autotest_failed_last: 0,
        max_autotest_guard_blocked_last: 0
      },
      safety: {
        block_on_integrity_alert_within_hours: 24,
        block_on_spine_critical: true
      }
    },
    training_gate: {
      enabled: true,
      max_load_per_cpu: 0.55,
      min_free_mem_mb: 1800,
      min_token_headroom_ratio: 0.3
    },
    telemetry: {
      emit_events: true,
      max_reasons: 8
    }
  };
}

function loadPolicy(policyPath: string) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const leftRaw = raw && raw.left_brain && typeof raw.left_brain === 'object' ? raw.left_brain : {};
  const rightRaw = raw && raw.right_brain && typeof raw.right_brain === 'object' ? raw.right_brain : {};
  const tritRaw = raw && raw.trit && typeof raw.trit === 'object' ? raw.trit : {};
  const thRaw = raw && raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const hwRaw = thRaw.hardware && typeof thRaw.hardware === 'object' ? thRaw.hardware : {};
  const budgetRaw = thRaw.budget && typeof thRaw.budget === 'object' ? thRaw.budget : {};
  const stabilityRaw = thRaw.stability && typeof thRaw.stability === 'object' ? thRaw.stability : {};
  const safetyRaw = thRaw.safety && typeof thRaw.safety === 'object' ? thRaw.safety : {};
  const trainingRaw = raw && raw.training_gate && typeof raw.training_gate === 'object' ? raw.training_gate : {};
  const telemetryRaw = raw && raw.telemetry && typeof raw.telemetry === 'object' ? raw.telemetry : {};
  return {
    version: cleanText(raw.version || base.version, 24) || '1.0',
    enabled: toBool(raw.enabled, base.enabled),
    shadow_mode: toBool(raw.shadow_mode, base.shadow_mode),
    left_brain: {
      id: normalizeToken(leftRaw.id || base.left_brain.id, 64) || base.left_brain.id,
      model: cleanText(leftRaw.model || base.left_brain.model, 120) || base.left_brain.model,
      force_context_contains: normalizeTokenList(leftRaw.force_context_contains || base.left_brain.force_context_contains, 120),
      force_task_classes: normalizeTokenList(leftRaw.force_task_classes || base.left_brain.force_task_classes, 120)
    },
    right_brain: {
      enabled: toBool(rightRaw.enabled, base.right_brain.enabled),
      id: normalizeToken(rightRaw.id || base.right_brain.id, 64) || base.right_brain.id,
      model: cleanText(rightRaw.model || base.right_brain.model, 120) || base.right_brain.model,
      opportunistic_only: toBool(rightRaw.opportunistic_only, base.right_brain.opportunistic_only),
      allowed_context_contains: normalizeTokenList(rightRaw.allowed_context_contains || base.right_brain.allowed_context_contains, 120),
      allowed_task_classes: normalizeTokenList(rightRaw.allowed_task_classes || base.right_brain.allowed_task_classes, 120)
    },
    trit: {
      require_non_pain_for_right: toBool(tritRaw.require_non_pain_for_right, base.trit.require_non_pain_for_right),
      min_right_trit: clampInt(tritRaw.min_right_trit, -1, 1, base.trit.min_right_trit)
    },
    thresholds: {
      hardware: {
        min_cpu_count: clampInt(hwRaw.min_cpu_count, 1, 256, base.thresholds.hardware.min_cpu_count),
        max_load_per_cpu: clampNumber(hwRaw.max_load_per_cpu, 0.05, 8, base.thresholds.hardware.max_load_per_cpu),
        min_free_mem_mb: clampInt(hwRaw.min_free_mem_mb, 64, 1024 * 1024, base.thresholds.hardware.min_free_mem_mb),
        max_process_rss_mb: clampInt(hwRaw.max_process_rss_mb, 64, 1024 * 1024, base.thresholds.hardware.max_process_rss_mb),
        max_process_heap_mb: clampInt(hwRaw.max_process_heap_mb, 64, 1024 * 1024, base.thresholds.hardware.max_process_heap_mb)
      },
      budget: {
        require_budget_data: toBool(budgetRaw.require_budget_data, base.thresholds.budget.require_budget_data),
        min_token_headroom_ratio: clampNumber(
          budgetRaw.min_token_headroom_ratio,
          0,
          1,
          base.thresholds.budget.min_token_headroom_ratio
        ),
        max_burn_pct: clampNumber(budgetRaw.max_burn_pct, 0, 100, base.thresholds.budget.max_burn_pct),
        deny_when_autopause_active: toBool(
          budgetRaw.deny_when_autopause_active,
          base.thresholds.budget.deny_when_autopause_active
        )
      },
      stability: {
        max_effective_drift_rate: clampNumber(
          stabilityRaw.max_effective_drift_rate,
          0,
          1,
          base.thresholds.stability.max_effective_drift_rate
        ),
        max_policy_hold_rate: clampNumber(
          stabilityRaw.max_policy_hold_rate,
          0,
          1,
          base.thresholds.stability.max_policy_hold_rate
        ),
        max_autotest_failed_last: clampInt(
          stabilityRaw.max_autotest_failed_last,
          0,
          10000,
          base.thresholds.stability.max_autotest_failed_last
        ),
        max_autotest_guard_blocked_last: clampInt(
          stabilityRaw.max_autotest_guard_blocked_last,
          0,
          10000,
          base.thresholds.stability.max_autotest_guard_blocked_last
        )
      },
      safety: {
        block_on_integrity_alert_within_hours: clampInt(
          safetyRaw.block_on_integrity_alert_within_hours,
          0,
          24 * 365,
          base.thresholds.safety.block_on_integrity_alert_within_hours
        ),
        block_on_spine_critical: toBool(
          safetyRaw.block_on_spine_critical,
          base.thresholds.safety.block_on_spine_critical
        )
      }
    },
    training_gate: {
      enabled: toBool(trainingRaw.enabled, base.training_gate.enabled),
      max_load_per_cpu: clampNumber(
        trainingRaw.max_load_per_cpu,
        0.05,
        8,
        base.training_gate.max_load_per_cpu
      ),
      min_free_mem_mb: clampInt(
        trainingRaw.min_free_mem_mb,
        64,
        1024 * 1024,
        base.training_gate.min_free_mem_mb
      ),
      min_token_headroom_ratio: clampNumber(
        trainingRaw.min_token_headroom_ratio,
        0,
        1,
        base.training_gate.min_token_headroom_ratio
      )
    },
    telemetry: {
      emit_events: toBool(telemetryRaw.emit_events, base.telemetry.emit_events),
      max_reasons: clampInt(telemetryRaw.max_reasons, 1, 64, base.telemetry.max_reasons)
    }
  };
}

function runtimePaths(policyPath: string) {
  const stateDir = process.env.DUAL_BRAIN_STATE_DIR
    ? path.resolve(process.env.DUAL_BRAIN_STATE_DIR)
    : DEFAULT_STATE_DIR;
  return {
    policy_path: policyPath,
    state_dir: stateDir,
    latest_path: process.env.DUAL_BRAIN_LATEST_PATH
      ? path.resolve(process.env.DUAL_BRAIN_LATEST_PATH)
      : path.join(stateDir, 'latest.json'),
    runs_dir: process.env.DUAL_BRAIN_RUNS_DIR
      ? path.resolve(process.env.DUAL_BRAIN_RUNS_DIR)
      : path.join(stateDir, 'runs'),
    events_dir: process.env.DUAL_BRAIN_EVENTS_DIR
      ? path.resolve(process.env.DUAL_BRAIN_EVENTS_DIR)
      : path.join(stateDir, 'events'),
    history_path: process.env.DUAL_BRAIN_HISTORY_PATH
      ? path.resolve(process.env.DUAL_BRAIN_HISTORY_PATH)
      : path.join(stateDir, 'history.jsonl'),
    continuum_latest_path: process.env.DUAL_BRAIN_CONTINUUM_LATEST_PATH
      ? path.resolve(process.env.DUAL_BRAIN_CONTINUUM_LATEST_PATH)
      : DEFAULT_CONTINUUM_LATEST_PATH,
    budget_state_dir: process.env.DUAL_BRAIN_BUDGET_STATE_DIR
      ? path.resolve(process.env.DUAL_BRAIN_BUDGET_STATE_DIR)
      : DEFAULT_BUDGET_STATE_DIR,
    budget_autopause_path: process.env.DUAL_BRAIN_BUDGET_AUTOPAUSE_PATH
      ? path.resolve(process.env.DUAL_BRAIN_BUDGET_AUTOPAUSE_PATH)
      : DEFAULT_BUDGET_AUTOPAUSE_PATH,
    integrity_log_path: process.env.DUAL_BRAIN_INTEGRITY_LOG_PATH
      ? path.resolve(process.env.DUAL_BRAIN_INTEGRITY_LOG_PATH)
      : DEFAULT_INTEGRITY_LOG_PATH,
    spine_runs_dir: process.env.DUAL_BRAIN_SPINE_RUNS_DIR
      ? path.resolve(process.env.DUAL_BRAIN_SPINE_RUNS_DIR)
      : DEFAULT_SPINE_RUNS_DIR
  };
}

function resourceSnapshot(policy: AnyObj) {
  const cpus = Math.max(1, os.cpus().length || 1);
  const load1 = Number(os.loadavg()[0] || 0);
  const loadPerCpu = cpus > 0 ? load1 / cpus : load1;
  const mem = process.memoryUsage();
  const rssMb = Number(mem.rss || 0) / (1024 * 1024);
  const heapMb = Number(mem.heapUsed || 0) / (1024 * 1024);
  const freeMemMb = Number(os.freemem() || 0) / (1024 * 1024);
  const totalMemMb = Number(os.totalmem() || 0) / (1024 * 1024);
  const hw = policy && policy.thresholds && policy.thresholds.hardware
    ? policy.thresholds.hardware
    : {};
  const ok = cpus >= Number(hw.min_cpu_count || 1)
    && loadPerCpu <= Number(hw.max_load_per_cpu || 0.68)
    && freeMemMb >= Number(hw.min_free_mem_mb || 0)
    && rssMb <= Number(hw.max_process_rss_mb || Number.MAX_SAFE_INTEGER)
    && heapMb <= Number(hw.max_process_heap_mb || Number.MAX_SAFE_INTEGER);
  return {
    cpu_count: cpus,
    load_1m: Number(load1.toFixed(4)),
    load_per_cpu: Number(loadPerCpu.toFixed(4)),
    rss_mb: Number(rssMb.toFixed(2)),
    heap_used_mb: Number(heapMb.toFixed(2)),
    free_mem_mb: Number(freeMemMb.toFixed(2)),
    total_mem_mb: Number(totalMemMb.toFixed(2)),
    ok
  };
}

function budgetSnapshot(dateStr: string, paths: AnyObj) {
  const dailyPath = path.join(paths.budget_state_dir, `${toDate(dateStr)}.json`);
  const daily = readJson(dailyPath, null);
  const src = daily && typeof daily === 'object' ? daily : {};
  const cap = Number(src.token_cap || 0);
  const used = Number(src.used_est || 0);
  const burnPct = cap > 0 ? (used / cap) * 100 : null;
  const headroomRatio = cap > 0 ? Math.max(0, (cap - used) / cap) : null;
  const autopauseRaw = readJson(paths.budget_autopause_path, null);
  const autopause = autopauseRaw && typeof autopauseRaw === 'object' ? autopauseRaw : {};
  return {
    available: !!daily && cap > 0,
    token_cap: Number.isFinite(cap) ? cap : 0,
    used_est: Number.isFinite(used) ? used : 0,
    burn_pct: Number.isFinite(Number(burnPct)) ? Number(Number(burnPct).toFixed(4)) : null,
    token_headroom_ratio: Number.isFinite(Number(headroomRatio)) ? Number(Number(headroomRatio).toFixed(6)) : null,
    autopause_active: autopause.active === true,
    strategy_id: cleanText(src.strategy_id || '', 80) || null,
    path: fs.existsSync(dailyPath) ? relPath(dailyPath) : relPath(dailyPath)
  };
}

function continuumSnapshot(paths: AnyObj) {
  const latest = readJson(paths.continuum_latest_path, null);
  const src = latest && typeof latest === 'object' ? latest : {};
  const actions = Array.isArray(src.actions) ? src.actions : [];
  let autotestFailed = null;
  let autotestBlocked = null;
  for (const row of actions) {
    if (String(row && row.id || '') !== 'autotest_validation') continue;
    const metrics = row && row.metrics && typeof row.metrics === 'object' ? row.metrics : {};
    autotestFailed = Number(metrics.failed || 0);
    autotestBlocked = Number(metrics.guard_blocked || 0);
  }
  return {
    available: !!latest,
    ts: String(src.ts || ''),
    trit: Number.isFinite(Number(src && src.trit && src.trit.value)) ? Number(src.trit.value) : null,
    trit_label: cleanText(src && src.trit && src.trit.label || '', 24),
    effective_drift_rate: Number.isFinite(Number(src && src.simulation && src.simulation.drift_rate))
      ? Number(src.simulation.drift_rate)
      : null,
    policy_hold_rate: Number.isFinite(Number(src && src.autonomy && src.autonomy.hold_rate))
      ? Number(src.autonomy.hold_rate)
      : null,
    autotest_failed_last: Number.isFinite(Number(autotestFailed)) ? Number(autotestFailed) : 0,
    autotest_guard_blocked_last: Number.isFinite(Number(autotestBlocked)) ? Number(autotestBlocked) : 0,
    queue_pressure: cleanText(src.queue_pressure || '', 32).toLowerCase() || 'unknown'
  };
}

function integritySnapshot(paths: AnyObj, lookbackHours: number) {
  const rows = readJsonlTail(paths.integrity_log_path, 700);
  let latestBlock: AnyObj = null;
  let latestTsMs = 0;
  for (const row of rows) {
    if (!row || String(row.type || '') !== 'integrity_violation_block') continue;
    const tsMs = parseTsMs(row.ts);
    if (!Number.isFinite(tsMs) || Number(tsMs) <= latestTsMs) continue;
    latestTsMs = Number(tsMs);
    latestBlock = row;
  }
  if (!latestBlock) {
    return {
      active_alert: false,
      latest_block_ts: null,
      age_hours: null,
      violation_total: 0
    };
  }
  const ageHours = Math.max(0, (Date.now() - latestTsMs) / (1000 * 60 * 60));
  const violationMap = latestBlock.violation_counts && typeof latestBlock.violation_counts === 'object'
    ? latestBlock.violation_counts
    : {};
  let total = 0;
  for (const v of Object.values(violationMap)) total += Number(v || 0);
  return {
    active_alert: ageHours <= Math.max(0, Number(lookbackHours || 0)),
    latest_block_ts: String(latestBlock.ts || ''),
    age_hours: Number(ageHours.toFixed(3)),
    violation_total: total
  };
}

function spineHealthSnapshot(dateStr: string, paths: AnyObj) {
  const dayA = toDate(dateStr);
  const dayB = shiftDate(dayA, -1);
  const files = [
    path.join(paths.spine_runs_dir, `${dayA}.jsonl`),
    path.join(paths.spine_runs_dir, `${dayB}.jsonl`)
  ];
  let best: AnyObj = null;
  let bestMs = 0;
  for (const filePath of files) {
    const rows = readJsonlRows(filePath);
    for (const row of rows) {
      if (String(row && row.type || '') !== 'spine_autonomy_health') continue;
      const tsMs = parseTsMs(row && row.ts);
      if (!Number.isFinite(tsMs) || Number(tsMs) <= bestMs) continue;
      bestMs = Number(tsMs);
      best = row;
    }
  }
  if (!best) {
    return {
      available: false,
      ts: null,
      slo_level: 'unknown',
      critical_count: 0,
      warn_count: 0,
      failed_checks: [],
      critical: false
    };
  }
  const level = cleanText(best.slo_level || '', 24).toLowerCase() || 'unknown';
  const criticalCount = Number(best.critical_count || 0);
  const failedChecks = Array.isArray(best.failed_checks) ? best.failed_checks.slice(0, 10) : [];
  return {
    available: true,
    ts: String(best.ts || ''),
    slo_level: level,
    critical_count: criticalCount,
    warn_count: Number(best.warn_count || 0),
    failed_checks: failedChecks,
    critical: level === 'critical' || criticalCount > 0
  };
}

function collectSignals(dateStr: string, policy: AnyObj, paths: AnyObj) {
  return {
    resource: resourceSnapshot(policy),
    budget: budgetSnapshot(dateStr, paths),
    continuum: continuumSnapshot(paths),
    integrity: integritySnapshot(
      paths,
      Number(policy && policy.thresholds && policy.thresholds.safety && policy.thresholds.safety.block_on_integrity_alert_within_hours || 0)
    ),
    spine: spineHealthSnapshot(dateStr, paths)
  };
}

function desiredLane(input: AnyObj) {
  const raw = normalizeToken(input && input.desired_lane || 'auto', 24);
  if (raw === 'left' || raw === 'right' || raw === 'auto') return raw;
  return 'auto';
}

function isTrainingTask(taskClass: string, context: string) {
  return taskClass.includes('training') || context.includes('training');
}

function evaluateDecision(policy: AnyObj, input: AnyObj, signals: AnyObj) {
  const context = normalizeToken(input && input.context || 'general', 160) || 'general';
  const taskClass = normalizeToken(input && input.task_class || 'general', 120) || 'general';
  const laneRequest = desiredLane(input);
  const tritInput = input && input.trit != null ? clampInt(input.trit, -1, 1, 0) : null;
  const trit = tritInput != null
    ? tritInput
    : (Number.isFinite(Number(signals && signals.continuum && signals.continuum.trit))
      ? clampInt(signals.continuum.trit, -1, 1, 0)
      : null);
  const left = policy.left_brain || {};
  const right = policy.right_brain || {};

  const forcedLeft = matchesAny(context, left.force_context_contains || [])
    || matchesAny(taskClass, left.force_task_classes || []);

  const rightEligibleByContext = matchesAny(context, right.allowed_context_contains || [])
    || matchesAny(taskClass, right.allowed_task_classes || []);
  const wantsRight = laneRequest === 'right' || (laneRequest === 'auto' && rightEligibleByContext);

  const reasons: string[] = [];
  const checks: AnyObj = {
    policy_enabled: policy.enabled === true,
    right_enabled: right.enabled === true,
    forced_left: forcedLeft,
    right_context_match: rightEligibleByContext,
    wants_right: wantsRight
  };
  if (policy.enabled !== true) reasons.push('policy_disabled');
  if (right.enabled !== true) reasons.push('right_brain_disabled');
  if (forcedLeft) reasons.push('left_priority_context');
  if (wantsRight && !rightEligibleByContext) reasons.push('right_context_not_allowed');

  let gateHardware = true;
  let gateBudget = true;
  let gateStability = true;
  let gateSafety = true;
  let gateTrit = true;
  let gateTraining = true;

  if (wantsRight && !forcedLeft) {
    const hw = policy.thresholds && policy.thresholds.hardware ? policy.thresholds.hardware : {};
    const resource = signals.resource || {};
    gateHardware = resource.cpu_count >= Number(hw.min_cpu_count || 1)
      && Number(resource.load_per_cpu || 0) <= Number(hw.max_load_per_cpu || 0.68)
      && Number(resource.free_mem_mb || 0) >= Number(hw.min_free_mem_mb || 0)
      && Number(resource.rss_mb || 0) <= Number(hw.max_process_rss_mb || Number.MAX_SAFE_INTEGER)
      && Number(resource.heap_used_mb || 0) <= Number(hw.max_process_heap_mb || Number.MAX_SAFE_INTEGER);
    if (!gateHardware) reasons.push('hardware_gate');

    const budgetPolicy = policy.thresholds && policy.thresholds.budget ? policy.thresholds.budget : {};
    const budget = signals.budget || {};
    if (budgetPolicy.require_budget_data === true && budget.available !== true) {
      gateBudget = false;
      reasons.push('budget_data_missing');
    } else {
      const headroom = Number(budget.token_headroom_ratio);
      const burnPct = Number(budget.burn_pct);
      if (Number.isFinite(headroom) && headroom < Number(budgetPolicy.min_token_headroom_ratio || 0)) {
        gateBudget = false;
        reasons.push('budget_headroom_low');
      }
      if (Number.isFinite(burnPct) && burnPct > Number(budgetPolicy.max_burn_pct || 100)) {
        gateBudget = false;
        reasons.push('budget_burn_high');
      }
      if (budgetPolicy.deny_when_autopause_active === true && budget.autopause_active === true) {
        gateBudget = false;
        reasons.push('budget_autopause_active');
      }
    }

    const stPolicy = policy.thresholds && policy.thresholds.stability ? policy.thresholds.stability : {};
    const continuum = signals.continuum || {};
    const drift = Number(continuum.effective_drift_rate);
    const holdRate = Number(continuum.policy_hold_rate);
    const autotestFailed = Number(continuum.autotest_failed_last || 0);
    const autotestBlocked = Number(continuum.autotest_guard_blocked_last || 0);
    if (Number.isFinite(drift) && drift > Number(stPolicy.max_effective_drift_rate || 1)) {
      gateStability = false;
      reasons.push('stability_drift_high');
    }
    if (Number.isFinite(holdRate) && holdRate > Number(stPolicy.max_policy_hold_rate || 1)) {
      gateStability = false;
      reasons.push('stability_policy_hold_high');
    }
    if (autotestFailed > Number(stPolicy.max_autotest_failed_last || 0)) {
      gateStability = false;
      reasons.push('stability_autotest_failed');
    }
    if (autotestBlocked > Number(stPolicy.max_autotest_guard_blocked_last || 0)) {
      gateStability = false;
      reasons.push('stability_autotest_guard_blocked');
    }

    const safPolicy = policy.thresholds && policy.thresholds.safety ? policy.thresholds.safety : {};
    const integrity = signals.integrity || {};
    const spine = signals.spine || {};
    if (Number(safPolicy.block_on_integrity_alert_within_hours || 0) > 0 && integrity.active_alert === true) {
      gateSafety = false;
      reasons.push('safety_integrity_alert');
    }
    if (safPolicy.block_on_spine_critical === true && spine.critical === true) {
      gateSafety = false;
      reasons.push('safety_spine_critical');
    }

    const tritPolicy = policy.trit || {};
    if (tritPolicy.require_non_pain_for_right === true) {
      if (trit == null || trit < Number(tritPolicy.min_right_trit || 0)) {
        gateTrit = false;
        reasons.push('trit_gate');
      }
    }

    if (isTrainingTask(taskClass, context)) {
      const training = policy.training_gate || {};
      if (training.enabled !== true) {
        gateTraining = false;
        reasons.push('training_disabled');
      } else {
        if (Number(signals.resource && signals.resource.load_per_cpu || 0) > Number(training.max_load_per_cpu || 0.55)) {
          gateTraining = false;
          reasons.push('training_load_high');
        }
        if (Number(signals.resource && signals.resource.free_mem_mb || 0) < Number(training.min_free_mem_mb || 0)) {
          gateTraining = false;
          reasons.push('training_memory_low');
        }
        if (
          Number.isFinite(Number(signals.budget && signals.budget.token_headroom_ratio))
          && Number(signals.budget.token_headroom_ratio || 0) < Number(training.min_token_headroom_ratio || 0)
        ) {
          gateTraining = false;
          reasons.push('training_budget_low');
        }
      }
    }
  }

  const rightPermitted = wantsRight
    && !forcedLeft
    && policy.enabled === true
    && right.enabled === true
    && gateHardware
    && gateBudget
    && gateStability
    && gateSafety
    && gateTrit
    && gateTraining;

  const shadowMode = policy.shadow_mode === true;
  let mode = 'left_only';
  if (rightPermitted) {
    mode = shadowMode ? 'left_live_right_shadow' : 'right_live';
  }
  const selectedLiveBrain = mode === 'right_live' ? 'right' : 'left';
  const rightShadow = mode === 'left_live_right_shadow';
  const rightLive = mode === 'right_live';

  checks.gate_hardware = gateHardware;
  checks.gate_budget = gateBudget;
  checks.gate_stability = gateStability;
  checks.gate_safety = gateSafety;
  checks.gate_trit = gateTrit;
  checks.gate_training = gateTraining;

  return {
    ok: true,
    type: 'dual_brain_decision',
    ts: nowIso(),
    context,
    task_class: taskClass,
    desired_lane: laneRequest,
    shadow_mode_active: shadowMode,
    mode,
    selected_live_brain: selectedLiveBrain,
    left: {
      id: String(left.id || 'left_standard'),
      model: String(left.model || '')
    },
    right: {
      id: String(right.id || 'right_creative'),
      model: String(right.model || ''),
      requested: wantsRight,
      permitted: rightPermitted,
      shadow: rightShadow,
      live: rightLive
    },
    checks,
    trit: trit,
    reasons: Array.from(new Set(reasons)).slice(0, clampInt(policy.telemetry && policy.telemetry.max_reasons, 1, 64, 8)),
    signals: {
      resource: signals.resource || {},
      budget: signals.budget || {},
      stability: {
        effective_drift_rate: signals.continuum && signals.continuum.effective_drift_rate != null
          ? Number(signals.continuum.effective_drift_rate)
          : null,
        policy_hold_rate: signals.continuum && signals.continuum.policy_hold_rate != null
          ? Number(signals.continuum.policy_hold_rate)
          : null,
        autotest_failed_last: Number(signals.continuum && signals.continuum.autotest_failed_last || 0),
        autotest_guard_blocked_last: Number(signals.continuum && signals.continuum.autotest_guard_blocked_last || 0)
      },
      safety: {
        integrity_active_alert: signals.integrity && signals.integrity.active_alert === true,
        integrity_violation_total: Number(signals.integrity && signals.integrity.violation_total || 0),
        spine_critical: signals.spine && signals.spine.critical === true,
        spine_slo_level: String(signals.spine && signals.spine.slo_level || 'unknown')
      }
    }
  };
}

function persistDecision(paths: AnyObj, policy: AnyObj, dateStr: string, decision: AnyObj) {
  ensureDir(paths.state_dir);
  ensureDir(paths.runs_dir);
  ensureDir(paths.events_dir);
  writeJsonAtomic(paths.latest_path, {
    ...decision,
    policy_version: policy.version,
    policy_path: relPath(paths.policy_path)
  });
  appendJsonl(path.join(paths.runs_dir, `${toDate(dateStr)}.jsonl`), {
    ts: decision.ts,
    type: 'dual_brain_decision',
    context: decision.context,
    task_class: decision.task_class,
    desired_lane: decision.desired_lane,
    mode: decision.mode,
    selected_live_brain: decision.selected_live_brain,
    right_requested: decision.right && decision.right.requested === true,
    right_permitted: decision.right && decision.right.permitted === true,
    right_shadow: decision.right && decision.right.shadow === true,
    reasons: Array.isArray(decision.reasons) ? decision.reasons : []
  });
  appendJsonl(paths.history_path, {
    ts: decision.ts,
    type: 'dual_brain_decision',
    mode: decision.mode,
    context: decision.context,
    task_class: decision.task_class,
    right_permitted: decision.right && decision.right.permitted === true
  });
  if (policy.telemetry && policy.telemetry.emit_events === true) {
    appendJsonl(path.join(paths.events_dir, `${toDate(dateStr)}.jsonl`), {
      ts: decision.ts,
      type: 'dual_brain_event',
      stage: decision.context,
      mode: decision.mode,
      right_requested: decision.right && decision.right.requested === true,
      right_permitted: decision.right && decision.right.permitted === true,
      reasons: Array.isArray(decision.reasons) ? decision.reasons : []
    });
  }
}

function decideBrainRoute(input: AnyObj = {}, opts: AnyObj = {}) {
  const policyPath = path.resolve(String(
    opts.policy_path
    || input.policy_path
    || process.env.DUAL_BRAIN_POLICY_PATH
    || DEFAULT_POLICY_PATH
  ));
  const policy = opts.policy && typeof opts.policy === 'object'
    ? opts.policy
    : loadPolicy(policyPath);
  const paths = opts.paths && typeof opts.paths === 'object'
    ? opts.paths
    : runtimePaths(policyPath);
  const dateStr = toDate(input.date || nowIso());
  const signals = opts.signals && typeof opts.signals === 'object'
    ? opts.signals
    : collectSignals(dateStr, policy, paths);
  const decision = evaluateDecision(policy, input, signals);
  const persist = toBool(input.persist, true);
  if (persist) persistDecision(paths, policy, dateStr, decision);
  return {
    ...decision,
    policy_version: policy.version,
    policy_path: relPath(policyPath)
  };
}

function status(input: AnyObj = {}, opts: AnyObj = {}) {
  const policyPath = path.resolve(String(
    opts.policy_path
    || input.policy_path
    || process.env.DUAL_BRAIN_POLICY_PATH
    || DEFAULT_POLICY_PATH
  ));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath);
  const dateStr = toDate(input.date || nowIso());
  const signals = collectSignals(dateStr, policy, paths);
  const latest = readJson(paths.latest_path, null);
  return {
    ok: true,
    type: 'dual_brain_status',
    ts: nowIso(),
    date: dateStr,
    policy_version: policy.version,
    policy_path: relPath(policyPath),
    shadow_mode: policy.shadow_mode === true,
    latest: latest && typeof latest === 'object'
      ? {
          ts: String(latest.ts || ''),
          mode: String(latest.mode || ''),
          context: String(latest.context || ''),
          task_class: String(latest.task_class || ''),
          selected_live_brain: String(latest.selected_live_brain || ''),
          right_permitted: !!(latest.right && latest.right.permitted === true)
        }
      : null,
    signals
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || args.help === true || cmd === 'h') {
    usage();
    return;
  }

  if (cmd === 'status') {
    const out = status({
      policy_path: args.policy,
      date: args._[1]
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }

  if (cmd === 'route' || cmd === 'decide') {
    const out = decideBrainRoute({
      policy_path: args.policy,
      date: args.date || args._[1],
      context: args.context,
      task_class: args['task-class'] != null ? args['task-class'] : args.task_class,
      desired_lane: args['desired-lane'] != null ? args['desired-lane'] : args.desired_lane,
      trit: args.trit != null ? args.trit : null,
      persist: toBool(args.persist, true)
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
      type: 'dual_brain',
      error: cleanText(err && err.message ? err.message : err || 'dual_brain_failed', 220)
    })}\n`);
    process.exit(1);
  });
}

module.exports = {
  defaultPolicy,
  loadPolicy,
  runtimePaths,
  collectSignals,
  evaluateDecision,
  decideBrainRoute,
  status
};
