#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/ops/autotest_doctor.js
 *
 * Deterministic, non-LLM repair plane for autotest-detected failures.
 *
 * Safety model:
 * - Reads only structured autotest artifacts.
 * - Uses static allowlisted repair steps (no freeform shell from logs).
 * - Supports shadow mode by default.
 * - Auto kill-switch engages on suspicious or potentially gamed conditions.
 * - On rollback, stores "broken piece" forensic bundles for later safe reimplementation.
 * - Mirrors rollback bundles into a research area for deferred human/system analysis.
 *
 * Usage:
 *   node systems/ops/autotest_doctor.js run [YYYY-MM-DD|latest] [--policy=path] [--apply=1|0] [--max-actions=N] [--force=1|0] [--reset-kill-switch=1]
 *   node systems/ops/autotest_doctor.js status [latest|YYYY-MM-DD] [--policy=path]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
let evaluateTernaryBelief: null | ((signals: AnyObj[], opts?: AnyObj) => AnyObj) = null;
let serializeBeliefResult: null | ((belief: AnyObj) => AnyObj) = null;
try {
  ({ evaluateTernaryBelief, serializeBeliefResult } = require('../../lib/ternary_belief_engine.js'));
} catch {
  evaluateTernaryBelief = null;
  serializeBeliefResult = null;
}

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'autotest_doctor_policy.json');
const DEFAULT_AUTOTEST_RUNS_DIR = path.join(ROOT, 'state', 'ops', 'autotest', 'runs');
const DEFAULT_AUTOTEST_LATEST_PATH = path.join(ROOT, 'state', 'ops', 'autotest', 'latest.json');
const DEFAULT_AUTOTEST_STATUS_PATH = path.join(ROOT, 'state', 'ops', 'autotest', 'status.json');
const DEFAULT_AUTOTEST_REGISTRY_PATH = path.join(ROOT, 'state', 'ops', 'autotest', 'registry.json');
const DEFAULT_SYSTEM_HEALTH_PATH = path.join(ROOT, 'state', 'ops', 'system_health', 'events.jsonl');
const DEFAULT_INVERSION_MATURITY_PATH = path.join(ROOT, 'state', 'autonomy', 'inversion', 'maturity.json');
const DEFAULT_TRIT_SHADOW_REPORTS_HISTORY_PATH = path.join(ROOT, 'state', 'autonomy', 'trit_shadow_reports', 'history.jsonl');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/autotest_doctor.js run [YYYY-MM-DD|latest] [--policy=path] [--apply=1|0] [--max-actions=N] [--force=1|0] [--reset-kill-switch=1]');
  console.log('  node systems/ops/autotest_doctor.js status [latest|YYYY-MM-DD] [--policy=path]');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
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

function nowIso() {
  return new Date().toISOString();
}

function parseIsoMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function toDate(v: unknown) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
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

function normalizeToken(v: unknown, maxLen = 120) {
  return String(v == null ? '' : v)
    .toLowerCase()
    .trim()
    .slice(0, maxLen)
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
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

function sha16(seed: string) {
  return crypto.createHash('sha256').update(String(seed || '')).digest('hex').slice(0, 16);
}

function stableId(prefix: string, seed: string) {
  return `${prefix}_${sha16(seed)}`;
}

function parseJsonFromOutput(raw: unknown) {
  const text = String(raw == null ? '' : raw).trim();
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
    shadow_mode: true,
    sleep_window_local: {
      enabled: true,
      start_hour: 0,
      end_hour: 7
    },
    gating: {
      min_consecutive_failures: 2,
      max_actions_per_run: 2,
      cooldown_sec_per_signature: 1800,
      max_repairs_per_signature_per_day: 3
    },
    kill_switch: {
      enabled: true,
      window_hours: 24,
      max_unknown_signatures_per_window: 4,
      max_suspicious_signatures_per_window: 2,
      max_repairs_per_window: 12,
      max_rollbacks_per_window: 3,
      max_same_signature_repairs_per_window: 4,
      auto_reset_hours: 12
    },
    execution: {
      step_timeout_ms: 120000,
      autotest_max_tests: 6
    },
    recipes: [
      {
        id: 'retest_then_pulse',
        enabled: true,
        applies_to: ['assertion_failed', 'timeout', 'exit_nonzero', 'flaky'],
        steps: ['retest_failed_test', 'autotest_run_changed']
      },
      {
        id: 'guard_recover',
        enabled: true,
        applies_to: ['guard_blocked'],
        steps: ['autotest_sync', 'autotest_run_changed']
      }
    ],
    rollback: {
      enabled: true,
      mode: 'autotest_sync',
      snapshot_files: [
        'state/ops/autotest/latest.json',
        'state/ops/autotest/status.json',
        'state/ops/autotest/registry.json'
      ],
      store_broken_pieces: true,
      max_excerpt_files: 10,
      max_excerpt_chars: 3000
    },
    safety_override: {
      enabled: true,
      require_human_approval_for_destructive_reimplementation: true,
      destructive_tokens: [
        'harm_human',
        'disable_guard',
        'disable_integrity',
        'self_terminate',
        'data_loss',
        'destructive'
      ],
      min_approval_note_chars: 12
    },
    first_principles: {
      enabled: true,
      auto_extract_on_rollback: true,
      auto_extract_on_success: true,
      max_statement_chars: 320,
      emit_trit_shadow_signal: true
    },
    research_quarantine: {
      enabled: true,
      maturity_state_path: 'state/autonomy/inversion/maturity.json',
      default_maturity_band: 'developing',
      min_days: 1,
      max_days: 120,
      severity_days: {
        low: 2,
        medium: 7,
        high: 14,
        critical: 30
      },
      maturity_multiplier: {
        novice: 1.5,
        developing: 1.25,
        mature: 1.0,
        seasoned: 0.85,
        legendary: 0.65
      }
    },
    telemetry: {
      emit_system_health: true,
      max_history_events: 5000
    }
  };
}

function normalizeTokenList(v: unknown, maxLen = 120) {
  return (Array.isArray(v) ? v : [])
    .map((row) => normalizeToken(row, maxLen))
    .filter(Boolean);
}

function normalizeRecipe(row: AnyObj, fallback: AnyObj) {
  const raw = row && typeof row === 'object' ? row : {};
  const id = normalizeToken(raw.id || fallback.id || '', 80) || fallback.id;
  const appliesTo = normalizeTokenList(raw.applies_to, 48);
  const steps = normalizeTokenList(raw.steps, 64)
    .filter((step) => ['retest_failed_test', 'autotest_sync', 'autotest_run_changed'].includes(step));
  return {
    id,
    enabled: toBool(raw.enabled, fallback.enabled !== false),
    applies_to: appliesTo.length ? appliesTo : fallback.applies_to,
    steps: steps.length ? steps : fallback.steps
  };
}

function loadPolicy(policyPath: string) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const sleep = raw && raw.sleep_window_local && typeof raw.sleep_window_local === 'object'
    ? raw.sleep_window_local
    : {};
  const gating = raw && raw.gating && typeof raw.gating === 'object' ? raw.gating : {};
  const kill = raw && raw.kill_switch && typeof raw.kill_switch === 'object' ? raw.kill_switch : {};
  const execution = raw && raw.execution && typeof raw.execution === 'object' ? raw.execution : {};
  const rollback = raw && raw.rollback && typeof raw.rollback === 'object' ? raw.rollback : {};
  const safetyOverride = raw && raw.safety_override && typeof raw.safety_override === 'object' ? raw.safety_override : {};
  const firstPrinciples = raw && raw.first_principles && typeof raw.first_principles === 'object' ? raw.first_principles : {};
  const quarantine = raw && raw.research_quarantine && typeof raw.research_quarantine === 'object' ? raw.research_quarantine : {};
  const quarantineSeverity = quarantine && quarantine.severity_days && typeof quarantine.severity_days === 'object'
    ? quarantine.severity_days
    : {};
  const quarantineMaturity = quarantine && quarantine.maturity_multiplier && typeof quarantine.maturity_multiplier === 'object'
    ? quarantine.maturity_multiplier
    : {};
  const telemetry = raw && raw.telemetry && typeof raw.telemetry === 'object' ? raw.telemetry : {};

  const fallbackRecipes = (Array.isArray(base.recipes) ? base.recipes : []).map((row) => normalizeRecipe(row, row));
  const recipes = Array.isArray(raw.recipes)
    ? raw.recipes.map((row, idx) => normalizeRecipe(row, fallbackRecipes[idx] || fallbackRecipes[0]))
      .filter((row) => row && row.id && Array.isArray(row.steps) && row.steps.length)
    : fallbackRecipes;

  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: toBool(raw.enabled, base.enabled),
    shadow_mode: toBool(raw.shadow_mode, base.shadow_mode),
    sleep_window_local: {
      enabled: toBool(sleep.enabled, base.sleep_window_local.enabled),
      start_hour: clampInt(sleep.start_hour, 0, 23, base.sleep_window_local.start_hour),
      end_hour: clampInt(sleep.end_hour, 0, 23, base.sleep_window_local.end_hour)
    },
    gating: {
      min_consecutive_failures: clampInt(gating.min_consecutive_failures, 1, 20, base.gating.min_consecutive_failures),
      max_actions_per_run: clampInt(gating.max_actions_per_run, 1, 100, base.gating.max_actions_per_run),
      cooldown_sec_per_signature: clampInt(gating.cooldown_sec_per_signature, 0, 7 * 24 * 60 * 60, base.gating.cooldown_sec_per_signature),
      max_repairs_per_signature_per_day: clampInt(gating.max_repairs_per_signature_per_day, 1, 100, base.gating.max_repairs_per_signature_per_day)
    },
    kill_switch: {
      enabled: toBool(kill.enabled, base.kill_switch.enabled),
      window_hours: clampInt(kill.window_hours, 1, 24 * 30, base.kill_switch.window_hours),
      max_unknown_signatures_per_window: clampInt(kill.max_unknown_signatures_per_window, 0, 10000, base.kill_switch.max_unknown_signatures_per_window),
      max_suspicious_signatures_per_window: clampInt(kill.max_suspicious_signatures_per_window, 0, 10000, base.kill_switch.max_suspicious_signatures_per_window),
      max_repairs_per_window: clampInt(kill.max_repairs_per_window, 1, 10000, base.kill_switch.max_repairs_per_window),
      max_rollbacks_per_window: clampInt(kill.max_rollbacks_per_window, 0, 10000, base.kill_switch.max_rollbacks_per_window),
      max_same_signature_repairs_per_window: clampInt(kill.max_same_signature_repairs_per_window, 1, 1000, base.kill_switch.max_same_signature_repairs_per_window),
      auto_reset_hours: clampInt(kill.auto_reset_hours, 0, 24 * 14, base.kill_switch.auto_reset_hours)
    },
    execution: {
      step_timeout_ms: clampInt(execution.step_timeout_ms, 1000, 15 * 60 * 1000, base.execution.step_timeout_ms),
      autotest_max_tests: clampInt(execution.autotest_max_tests, 1, 128, base.execution.autotest_max_tests)
    },
    recipes,
    rollback: {
      enabled: toBool(rollback.enabled, base.rollback.enabled),
      mode: normalizeToken(rollback.mode || base.rollback.mode, 64) || 'autotest_sync',
      snapshot_files: (Array.isArray(rollback.snapshot_files) ? rollback.snapshot_files : base.rollback.snapshot_files)
        .map((row) => cleanText(row, 260))
        .filter(Boolean),
      store_broken_pieces: toBool(rollback.store_broken_pieces, base.rollback.store_broken_pieces),
      max_excerpt_files: clampInt(rollback.max_excerpt_files, 1, 100, base.rollback.max_excerpt_files),
      max_excerpt_chars: clampInt(rollback.max_excerpt_chars, 200, 20000, base.rollback.max_excerpt_chars)
    },
    safety_override: {
      enabled: toBool(safetyOverride.enabled, base.safety_override.enabled),
      require_human_approval_for_destructive_reimplementation: toBool(
        safetyOverride.require_human_approval_for_destructive_reimplementation,
        base.safety_override.require_human_approval_for_destructive_reimplementation
      ),
      destructive_tokens: normalizeTokenList(
        Array.isArray(safetyOverride.destructive_tokens)
          ? safetyOverride.destructive_tokens
          : base.safety_override.destructive_tokens,
        120
      ),
      min_approval_note_chars: clampInt(
        safetyOverride.min_approval_note_chars,
        4,
        400,
        base.safety_override.min_approval_note_chars
      )
    },
    first_principles: {
      enabled: toBool(firstPrinciples.enabled, base.first_principles.enabled),
      auto_extract_on_rollback: toBool(
        firstPrinciples.auto_extract_on_rollback,
        base.first_principles.auto_extract_on_rollback
      ),
      auto_extract_on_success: toBool(
        firstPrinciples.auto_extract_on_success,
        base.first_principles.auto_extract_on_success
      ),
      max_statement_chars: clampInt(
        firstPrinciples.max_statement_chars,
        80,
        1200,
        base.first_principles.max_statement_chars
      ),
      emit_trit_shadow_signal: toBool(
        firstPrinciples.emit_trit_shadow_signal,
        base.first_principles.emit_trit_shadow_signal
      )
    },
    research_quarantine: {
      enabled: toBool(quarantine.enabled, base.research_quarantine.enabled),
      maturity_state_path: cleanText(
        quarantine.maturity_state_path || base.research_quarantine.maturity_state_path,
        260
      ) || base.research_quarantine.maturity_state_path,
      default_maturity_band: normalizeToken(
        quarantine.default_maturity_band || base.research_quarantine.default_maturity_band,
        24
      ) || base.research_quarantine.default_maturity_band,
      min_days: clampInt(
        quarantine.min_days,
        1,
        3650,
        base.research_quarantine.min_days
      ),
      max_days: clampInt(
        quarantine.max_days,
        1,
        3650,
        base.research_quarantine.max_days
      ),
      severity_days: {
        low: clampInt(quarantineSeverity.low, 1, 3650, base.research_quarantine.severity_days.low),
        medium: clampInt(quarantineSeverity.medium, 1, 3650, base.research_quarantine.severity_days.medium),
        high: clampInt(quarantineSeverity.high, 1, 3650, base.research_quarantine.severity_days.high),
        critical: clampInt(quarantineSeverity.critical, 1, 3650, base.research_quarantine.severity_days.critical)
      },
      maturity_multiplier: {
        novice: clampNumber(quarantineMaturity.novice, 0.1, 8, base.research_quarantine.maturity_multiplier.novice),
        developing: clampNumber(quarantineMaturity.developing, 0.1, 8, base.research_quarantine.maturity_multiplier.developing),
        mature: clampNumber(quarantineMaturity.mature, 0.1, 8, base.research_quarantine.maturity_multiplier.mature),
        seasoned: clampNumber(quarantineMaturity.seasoned, 0.1, 8, base.research_quarantine.maturity_multiplier.seasoned),
        legendary: clampNumber(quarantineMaturity.legendary, 0.1, 8, base.research_quarantine.maturity_multiplier.legendary)
      }
    },
    telemetry: {
      emit_system_health: toBool(telemetry.emit_system_health, base.telemetry.emit_system_health),
      max_history_events: clampInt(telemetry.max_history_events, 100, 200000, base.telemetry.max_history_events)
    }
  };
}

function runtimePaths(policyPath: string) {
  const stateDir = process.env.AUTOTEST_DOCTOR_STATE_DIR
    ? path.resolve(process.env.AUTOTEST_DOCTOR_STATE_DIR)
    : path.join(ROOT, 'state', 'ops', 'autotest_doctor');
  const researchDir = process.env.AUTOTEST_DOCTOR_RESEARCH_DIR
    ? path.resolve(process.env.AUTOTEST_DOCTOR_RESEARCH_DIR)
    : path.join(ROOT, 'research', 'autotest_doctor');
  return {
    policy_path: process.env.AUTOTEST_DOCTOR_POLICY_PATH
      ? path.resolve(process.env.AUTOTEST_DOCTOR_POLICY_PATH)
      : policyPath,
    state_dir: stateDir,
    runs_dir: path.join(stateDir, 'runs'),
    latest_path: path.join(stateDir, 'latest.json'),
    history_path: path.join(stateDir, 'history.jsonl'),
    events_path: path.join(stateDir, 'events.jsonl'),
    state_path: path.join(stateDir, 'state.json'),
    rollback_dir: path.join(stateDir, 'rollback'),
    broken_dir: path.join(stateDir, 'broken_pieces'),
    autotest_runs_dir: process.env.AUTOTEST_DOCTOR_AUTOTEST_RUNS_DIR
      ? path.resolve(process.env.AUTOTEST_DOCTOR_AUTOTEST_RUNS_DIR)
      : DEFAULT_AUTOTEST_RUNS_DIR,
    autotest_latest_path: process.env.AUTOTEST_DOCTOR_AUTOTEST_LATEST_PATH
      ? path.resolve(process.env.AUTOTEST_DOCTOR_AUTOTEST_LATEST_PATH)
      : DEFAULT_AUTOTEST_LATEST_PATH,
    autotest_status_path: process.env.AUTOTEST_DOCTOR_AUTOTEST_STATUS_PATH
      ? path.resolve(process.env.AUTOTEST_DOCTOR_AUTOTEST_STATUS_PATH)
      : DEFAULT_AUTOTEST_STATUS_PATH,
    autotest_registry_path: process.env.AUTOTEST_DOCTOR_AUTOTEST_REGISTRY_PATH
      ? path.resolve(process.env.AUTOTEST_DOCTOR_AUTOTEST_REGISTRY_PATH)
      : DEFAULT_AUTOTEST_REGISTRY_PATH,
    system_health_path: process.env.SYSTEM_HEALTH_EVENTS_PATH
      ? path.resolve(process.env.SYSTEM_HEALTH_EVENTS_PATH)
      : DEFAULT_SYSTEM_HEALTH_PATH,
    research_dir: researchDir,
    research_index_path: path.join(researchDir, 'index.jsonl'),
    research_broken_dir: path.join(researchDir, 'broken_pieces'),
    maturity_state_path: process.env.AUTOTEST_DOCTOR_MATURITY_PATH
      ? path.resolve(process.env.AUTOTEST_DOCTOR_MATURITY_PATH)
      : DEFAULT_INVERSION_MATURITY_PATH,
    first_principles_dir: path.join(stateDir, 'first_principles'),
    first_principles_latest_path: path.join(stateDir, 'first_principles', 'latest.json'),
    first_principles_history_path: path.join(stateDir, 'first_principles', 'history.jsonl'),
    trit_beliefs_dir: path.join(stateDir, 'trit_beliefs'),
    trit_beliefs_latest_path: path.join(stateDir, 'trit_beliefs', 'latest.json'),
    trit_beliefs_history_path: path.join(stateDir, 'trit_beliefs', 'history.jsonl'),
    trit_shadow_reports_history_path: process.env.AUTOTEST_DOCTOR_TRIT_SHADOW_HISTORY_PATH
      ? path.resolve(process.env.AUTOTEST_DOCTOR_TRIT_SHADOW_HISTORY_PATH)
      : DEFAULT_TRIT_SHADOW_REPORTS_HISTORY_PATH
  };
}

function appendSystemHealthEvent(paths: AnyObj, policy: AnyObj, row: AnyObj) {
  if (!(policy && policy.telemetry && policy.telemetry.emit_system_health === true)) return;
  try {
    ensureDir(path.dirname(paths.system_health_path));
    const evt = {
      ts: nowIso(),
      type: 'system_health_event',
      source: 'autotest_doctor',
      subsystem: 'ops.autotest_doctor',
      severity: 'medium',
      risk: 'medium',
      code: 'autotest_doctor_event',
      summary: 'autotest doctor event',
      ...(row && typeof row === 'object' ? row : {})
    };
    fs.appendFileSync(paths.system_health_path, `${JSON.stringify(evt)}\n`, 'utf8');
  } catch {
    // Non-blocking telemetry.
  }
}

function defaultDoctorState() {
  return {
    version: '1.0',
    updated_at: null,
    kill_switch: {
      engaged: false,
      reason: null,
      engaged_at: null,
      auto_release_at: null,
      last_trip_meta: null
    },
    signatures: {},
    destructive_signatures: {},
    history: []
  };
}

function loadDoctorState(paths: AnyObj) {
  const raw = readJson(paths.state_path, {});
  const base = defaultDoctorState();
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    updated_at: cleanText(raw.updated_at || '', 64) || null,
    kill_switch: {
      engaged: !!(raw.kill_switch && raw.kill_switch.engaged === true),
      reason: cleanText(raw.kill_switch && raw.kill_switch.reason || '', 180) || null,
      engaged_at: cleanText(raw.kill_switch && raw.kill_switch.engaged_at || '', 64) || null,
      auto_release_at: cleanText(raw.kill_switch && raw.kill_switch.auto_release_at || '', 64) || null,
      last_trip_meta: raw.kill_switch && typeof raw.kill_switch.last_trip_meta === 'object'
        ? raw.kill_switch.last_trip_meta
        : null
    },
    signatures: raw.signatures && typeof raw.signatures === 'object' ? raw.signatures : {},
    destructive_signatures: raw.destructive_signatures && typeof raw.destructive_signatures === 'object'
      ? raw.destructive_signatures
      : {},
    history: Array.isArray(raw.history) ? raw.history : []
  };
}

function pruneHistory(state: AnyObj, windowHours: number, maxEvents: number) {
  const nowMs = Date.now();
  const winMs = Math.max(1, Number(windowHours || 24)) * 60 * 60 * 1000;
  const kept = (Array.isArray(state.history) ? state.history : [])
    .filter((row) => {
      const ms = parseIsoMs(row && row.ts);
      return Number.isFinite(ms) && (nowMs - Number(ms)) <= winMs;
    })
    .slice(-Math.max(100, Number(maxEvents || 5000)));
  state.history = kept;
}

function countHistory(state: AnyObj, type: string, signatureId = '') {
  const sig = String(signatureId || '').trim();
  return (Array.isArray(state.history) ? state.history : [])
    .filter((row) => String(row && row.type || '') === type)
    .filter((row) => !sig || String(row && row.signature_id || '') === sig)
    .length;
}

function recordHistoryEvent(state: AnyObj, type: string, payload: AnyObj = {}) {
  if (!Array.isArray(state.history)) state.history = [];
  state.history.push({
    ts: nowIso(),
    type: normalizeToken(type, 64) || 'event',
    ...(payload && typeof payload === 'object' ? payload : {})
  });
}

function normalizeMaturityBand(v: unknown, fallback = 'developing') {
  const raw = normalizeToken(v, 24);
  if (['novice', 'developing', 'mature', 'seasoned', 'legendary'].includes(raw)) return raw;
  return normalizeToken(fallback, 24) || 'developing';
}

function loadMaturityBand(paths: AnyObj, policy: AnyObj) {
  const cfg = policy && policy.research_quarantine && typeof policy.research_quarantine === 'object'
    ? policy.research_quarantine
    : {};
  const fallback = normalizeMaturityBand(cfg.default_maturity_band || 'developing', 'developing');
  const configuredPath = cleanText(cfg.maturity_state_path || '', 260);
  const pathFromPolicy = configuredPath
    ? path.resolve(ROOT, configuredPath)
    : paths.maturity_state_path;
  const src = readJson(pathFromPolicy, null)
    || readJson(paths.maturity_state_path, null);
  if (!src || typeof src !== 'object') return fallback;
  return normalizeMaturityBand(src.band || src.maturity_band || fallback, fallback);
}

function classifySeverity(policy: AnyObj, signature: AnyObj, context: AnyObj = {}) {
  const s = signature && typeof signature === 'object' ? signature : {};
  const ctx = context && typeof context === 'object' ? context : {};
  const blob = [
    s.kind,
    s.guard_reason,
    s.stderr_excerpt,
    s.stdout_excerpt,
    s.command,
    s.test_id,
    ctx.reason,
    ctx.rollback && ctx.rollback.reason
  ].map((row) => String(row || '').toLowerCase()).join(' ');
  const destructiveTokens = Array.isArray(policy && policy.safety_override && policy.safety_override.destructive_tokens)
    ? policy.safety_override.destructive_tokens
    : [];
  const destructiveHit = destructiveTokens.find((tok: unknown) => {
    const t = normalizeToken(tok, 120);
    if (!t) return false;
    return blob.includes(t);
  });
  if (destructiveHit) return { severity: 'critical', destructive_token: destructiveHit };
  if (ctx.regression === true) return { severity: 'high', destructive_token: null };
  const kind = normalizeToken(s.kind || '', 64);
  if (kind === 'guard_blocked' || kind === 'timeout') return { severity: 'medium', destructive_token: null };
  if (kind === 'exit_nonzero') return { severity: 'medium', destructive_token: null };
  return { severity: 'low', destructive_token: null };
}

function computeQuarantinePlan(paths: AnyObj, policy: AnyObj, signature: AnyObj, context: AnyObj = {}) {
  const cfg = policy && policy.research_quarantine && typeof policy.research_quarantine === 'object'
    ? policy.research_quarantine
    : {};
  const enabled = cfg.enabled !== false;
  const maturityBand = loadMaturityBand(paths, policy);
  const severityInfo = classifySeverity(policy, signature, context);
  const severity = normalizeToken(severityInfo.severity || 'medium', 24) || 'medium';
  const severityDays = cfg.severity_days && typeof cfg.severity_days === 'object'
    ? cfg.severity_days
    : {};
  const maturityMul = cfg.maturity_multiplier && typeof cfg.maturity_multiplier === 'object'
    ? cfg.maturity_multiplier
    : {};
  const baseDays = Number(severityDays[severity] || severityDays.medium || 7);
  const multiplier = Number(maturityMul[maturityBand] || maturityMul.developing || 1);
  const rawDays = Math.max(1, Math.round(baseDays * Math.max(0.1, multiplier)));
  const minDays = clampInt(cfg.min_days, 1, 3650, 1);
  const maxDays = clampInt(cfg.max_days, minDays, 3650, 120);
  const durationDays = clampInt(rawDays, minDays, maxDays, rawDays);
  const startTs = nowIso();
  const releaseAt = new Date(Date.now() + (durationDays * 24 * 60 * 60 * 1000)).toISOString();
  return {
    enabled,
    status: enabled ? 'quarantine' : 'active',
    severity,
    destructive_token: severityInfo.destructive_token || null,
    maturity_band: maturityBand,
    duration_days: durationDays,
    start_ts: startTs,
    release_at: releaseAt
  };
}

function isDestructiveSignature(policy: AnyObj, signature: AnyObj, context: AnyObj = {}) {
  const severityInfo = classifySeverity(policy, signature, context);
  return {
    destructive: severityInfo.severity === 'critical',
    severity: severityInfo.severity,
    token: severityInfo.destructive_token || null
  };
}

function getApprovalSignal(args: AnyObj, policy: AnyObj) {
  const cfg = policy && policy.safety_override && typeof policy.safety_override === 'object'
    ? policy.safety_override
    : {};
  if (!(cfg.enabled === true && cfg.require_human_approval_for_destructive_reimplementation === true)) {
    return {
      required: false,
      approved: true,
      reason: 'approval_not_required',
      approver_id: null,
      approval_note: null
    };
  }
  const approverId = cleanText(args.approver_id || args['approver-id'] || '', 120) || null;
  const approvalNote = cleanText(args.approval_note || args['approval-note'] || '', 500) || null;
  const explicit = toBool(args.approve_destructive || args['approve-destructive'], false);
  const minChars = clampInt(cfg.min_approval_note_chars, 4, 400, 12);
  const approved = !!approverId && !!approvalNote && approvalNote.length >= minChars && (explicit || true);
  return {
    required: true,
    approved,
    reason: approved ? 'approval_present' : 'approval_missing_or_insufficient',
    approver_id: approverId,
    approval_note: approvalNote
  };
}

function updateDestructiveSignatureState(state: AnyObj, signature: AnyObj, destructiveInfo: AnyObj) {
  if (!(destructiveInfo && destructiveInfo.destructive === true)) return;
  if (!state.destructive_signatures || typeof state.destructive_signatures !== 'object') {
    state.destructive_signatures = {};
  }
  const sigId = String(signature && signature.signature_id || '');
  if (!sigId) return;
  const prev = state.destructive_signatures[sigId] && typeof state.destructive_signatures[sigId] === 'object'
    ? state.destructive_signatures[sigId]
    : {
      signature_id: sigId,
      first_seen_ts: nowIso(),
      count: 0
    };
  prev.last_seen_ts = nowIso();
  prev.count = Number(prev.count || 0) + 1;
  prev.last_reason = cleanText(signature && (signature.guard_reason || signature.stderr_excerpt || signature.stdout_excerpt) || '', 220) || null;
  prev.last_token = cleanText(destructiveInfo.token || '', 120) || null;
  state.destructive_signatures[sigId] = prev;
}

function buildDoctorBelief(policy: AnyObj, signature: AnyObj, context: AnyObj = {}) {
  if (!evaluateTernaryBelief || !serializeBeliefResult) return null;
  const ctx = context && typeof context === 'object' ? context : {};
  const severity = String(ctx.severity || 'medium');
  const severityTrit = severity === 'critical'
    ? -1
    : (severity === 'high' ? -1 : (severity === 'medium' ? 0 : 1));
  const signals = [
    {
      source: 'doctor_outcome',
      trit: ctx.status === 'applied' ? 1 : -1,
      weight: 3,
      confidence: 1
    },
    {
      source: 'doctor_regression',
      trit: ctx.regression === true ? -1 : 1,
      weight: 2,
      confidence: 0.8
    },
    {
      source: 'doctor_severity',
      trit: severityTrit,
      weight: 2,
      confidence: 0.7
    },
    {
      source: 'doctor_destructive',
      trit: ctx.destructive === true ? -1 : 0,
      weight: 3,
      confidence: 1
    }
  ];
  const belief = evaluateTernaryBelief(signals, {
    label: 'autotest_doctor',
    positive_threshold: 0.22,
    negative_threshold: -0.22
  });
  const serialized = serializeBeliefResult(belief);
  return {
    belief,
    serialized,
    signals
  };
}

function persistDoctorBelief(paths: AnyObj, payload: AnyObj) {
  if (!payload || typeof payload !== 'object') return null;
  ensureDir(paths.trit_beliefs_dir);
  writeJsonAtomic(paths.trit_beliefs_latest_path, payload);
  appendJsonl(paths.trit_beliefs_history_path, payload);
  return payload;
}

function maybePersistFirstPrinciple(paths: AnyObj, policy: AnyObj, signature: AnyObj, context: AnyObj, beliefPack: AnyObj) {
  const cfg = policy && policy.first_principles && typeof policy.first_principles === 'object'
    ? policy.first_principles
    : {};
  if (cfg.enabled !== true) return null;
  const status = String(context && context.status || '');
  if (status === 'rolled_back' && cfg.auto_extract_on_rollback !== true) return null;
  if (status === 'applied' && cfg.auto_extract_on_success !== true) return null;
  if (status !== 'rolled_back' && status !== 'applied') return null;

  const maxStatementChars = clampInt(cfg.max_statement_chars, 80, 1200, 320);
  const testRef = cleanText(signature && (signature.test_id || signature.test_path || signature.signature_id) || '', 180) || 'unknown_test';
  const guardReason = cleanText(signature && signature.guard_reason || '', 180) || null;
  const severity = cleanText(context && context.severity || 'medium', 24) || 'medium';
  const statement = status === 'rolled_back'
    ? cleanText(
      `For ${testRef}, do not reuse the same repair pattern without a materially different guard condition and verified rollback path. Severity=${severity}${guardReason ? `, guard=${guardReason}` : ''}.`,
      maxStatementChars
    )
    : cleanText(
      `For ${testRef}, the bounded sequence (targeted retest plus changed-scope autotest) restored health without regression; prefer this pattern for similar failures.`,
      maxStatementChars
    );
  const beliefSer = beliefPack && beliefPack.serialized && typeof beliefPack.serialized === 'object'
    ? beliefPack.serialized
    : {};
  const confidence = clampNumber(
    beliefSer.confidence != null
      ? beliefSer.confidence
      : (status === 'applied' ? 0.62 : 0.55),
    0,
    1,
    status === 'applied' ? 0.62 : 0.55
  );
  const polarity = Number(beliefSer.trit || (status === 'applied' ? 1 : -1));
  const principle = {
    id: stableId(`doctor|${String(signature && signature.signature_id || '')}|${status}|${Date.now()}`, 'dfp'),
    ts: nowIso(),
    source: 'autotest_doctor',
    statement,
    target: 'tactical',
    confidence: Number(confidence.toFixed(6)),
    polarity,
    strategy_feedback: {
      enabled: true,
      suggested_bonus: status === 'applied'
        ? Number(Math.max(0, Math.min(0.04, confidence * 0.04)).toFixed(6))
        : 0
    },
    signature_id: String(signature && signature.signature_id || ''),
    test_id: cleanText(signature && signature.test_id || '', 120) || null,
    status
  };

  ensureDir(paths.first_principles_dir);
  writeJsonAtomic(paths.first_principles_latest_path, principle);
  appendJsonl(paths.first_principles_history_path, principle);

  if (cfg.emit_trit_shadow_signal === true) {
    appendJsonl(paths.trit_shadow_reports_history_path, {
      ts: principle.ts,
      type: 'trit_shadow_doctor_signal',
      ok: true,
      source: 'autotest_doctor',
      signature_id: principle.signature_id,
      principle_id: principle.id,
      principle_status: status,
      trit_shadow: {
        belief: beliefSer
      }
    });
  }
  return principle;
}

function maybeAutoReleaseKillSwitch(state: AnyObj, policy: AnyObj) {
  if (!(state && state.kill_switch && state.kill_switch.engaged === true)) return false;
  const hrs = Number(policy && policy.kill_switch && policy.kill_switch.auto_reset_hours || 0);
  if (!(hrs > 0)) return false;
  const engagedMs = parseIsoMs(state.kill_switch.engaged_at);
  if (!Number.isFinite(engagedMs)) return false;
  const releaseMs = Number(engagedMs) + (hrs * 60 * 60 * 1000);
  if (Date.now() < releaseMs) {
    state.kill_switch.auto_release_at = new Date(releaseMs).toISOString();
    return false;
  }
  state.kill_switch = {
    engaged: false,
    reason: null,
    engaged_at: null,
    auto_release_at: null,
    last_trip_meta: state.kill_switch.last_trip_meta || null
  };
  recordHistoryEvent(state, 'kill_switch_auto_release');
  return true;
}

function engageKillSwitch(state: AnyObj, reason: string, meta: AnyObj = {}) {
  state.kill_switch = {
    engaged: true,
    reason: cleanText(reason || 'kill_switch_engaged', 180) || 'kill_switch_engaged',
    engaged_at: nowIso(),
    auto_release_at: null,
    last_trip_meta: meta && typeof meta === 'object' ? meta : null
  };
  recordHistoryEvent(state, 'kill_switch_trip', {
    reason: state.kill_switch.reason,
    meta: state.kill_switch.last_trip_meta
  });
}

function readAutotestLatest(paths: AnyObj) {
  const row = readJson(paths.autotest_latest_path, {});
  if (!row || typeof row !== 'object') return {};
  return {
    ts: cleanText(row.ts || '', 64) || null,
    failed_tests: Number(row.failed_tests || 0),
    modules_red: Number(row.modules_red || 0),
    modules_changed: Number(row.modules_changed || 0),
    untested_modules: Number(row.untested_modules || 0)
  };
}

function listRunFiles(runsDir: string) {
  try {
    if (!fs.existsSync(runsDir)) return [];
    return fs.readdirSync(runsDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

function loadLatestAutotestRun(paths: AnyObj, dateArg: string) {
  const key = String(dateArg || 'latest').trim().toLowerCase();
  const files = listRunFiles(paths.autotest_runs_dir);
  const targetFiles = key === 'latest'
    ? files.slice().reverse()
    : [`${toDate(key)}.jsonl`];

  for (const name of targetFiles) {
    const fp = path.join(paths.autotest_runs_dir, name);
    const rows = readJsonl(fp);
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (String(row && row.type || '') !== 'autotest_run') continue;
      return {
        file_path: fp,
        file_date: name.replace(/\.jsonl$/, ''),
        row
      };
    }
  }
  return null;
}

function classifyFailureKind(result: AnyObj) {
  if (result && result.guard_ok === false) return 'guard_blocked';
  if (result && result.flaky === true) return 'flaky';
  const errBlob = [
    String(result && result.stderr_excerpt || ''),
    String(result && result.stdout_excerpt || ''),
    String(result && result.guard_reason || '')
  ].join(' ').toLowerCase();
  if (/etimedout|timeout|process_timeout|timed out/.test(errBlob)) return 'timeout';
  const exitCode = Number(result && result.exit_code);
  if (Number.isFinite(exitCode) && exitCode !== 0) return 'exit_nonzero';
  return 'assertion_failed';
}

function extractTrustedTestPath(command: unknown) {
  const cmd = String(command || '').trim();
  if (!cmd) return { path: null, trusted: false, reason: 'missing_command' };
  if (/\||&&|;|\$\(|`|>|<|\n/.test(cmd)) {
    return { path: null, trusted: false, reason: 'shell_meta_detected' };
  }
  const m = cmd.match(/^node\s+([^\s]+\.test\.js)\b/i);
  if (!m) return { path: null, trusted: false, reason: 'non_node_test_command' };
  const raw = String(m[1] || '').replace(/^['"]|['"]$/g, '');
  const norm = raw.replace(/\\/g, '/');
  if (!norm.startsWith('memory/tools/tests/')) {
    return { path: null, trusted: false, reason: 'path_outside_allowlist' };
  }
  if (norm.includes('..')) {
    return { path: null, trusted: false, reason: 'path_traversal' };
  }
  return { path: norm, trusted: true, reason: null };
}

function collectFailures(runRow: AnyObj) {
  const out = [] as AnyObj[];
  const results = Array.isArray(runRow && runRow.results) ? runRow.results : [];
  for (const result of results) {
    if (!result || typeof result !== 'object') continue;
    const failed = result.ok !== true || result.guard_ok === false;
    if (!failed) continue;
    const kind = classifyFailureKind(result);
    const testMeta = extractTrustedTestPath(result.command);
    const guardFiles = Array.isArray(result.guard_files)
      ? result.guard_files.map((row) => cleanText(row, 260)).filter(Boolean)
      : [];
    const seed = [
      String(result.id || ''),
      kind,
      String(testMeta.path || ''),
      String(result.guard_reason || ''),
      String(result.exit_code || '')
    ].join('|');
    const signatureId = stableId('sig', seed);
    out.push({
      signature_id: signatureId,
      kind,
      test_id: cleanText(result.id || '', 120) || null,
      command: cleanText(result.command || '', 260) || null,
      test_path: testMeta.path,
      trusted_test_command: testMeta.trusted === true,
      untrusted_reason: testMeta.trusted === true ? null : testMeta.reason,
      exit_code: Number.isFinite(Number(result.exit_code)) ? Number(result.exit_code) : null,
      guard_ok: result.guard_ok === true,
      guard_reason: cleanText(result.guard_reason || '', 180) || null,
      stderr_excerpt: cleanText(result.stderr_excerpt || '', 600) || null,
      stdout_excerpt: cleanText(result.stdout_excerpt || '', 600) || null,
      guard_files: guardFiles,
      flakey: result.flaky === true
    });
  }
  return out;
}

function ensureSignatureState(state: AnyObj, signatureId: string) {
  if (!state.signatures || typeof state.signatures !== 'object') state.signatures = {};
  if (!state.signatures[signatureId] || typeof state.signatures[signatureId] !== 'object') {
    state.signatures[signatureId] = {
      consecutive_failures: 0,
      total_failures: 0,
      total_repairs: 0,
      total_rollbacks: 0,
      last_fail_ts: null,
      last_repair_ts: null,
      last_recipe_id: null,
      last_outcome: null
    };
  }
  return state.signatures[signatureId];
}

function selectRecipe(policy: AnyObj, kind: string) {
  const recipes = Array.isArray(policy && policy.recipes) ? policy.recipes : [];
  const k = normalizeToken(kind, 48);
  for (const row of recipes) {
    if (!row || row.enabled !== true) continue;
    const applies = Array.isArray(row.applies_to) ? row.applies_to : [];
    if (!applies.includes(k)) continue;
    const steps = Array.isArray(row.steps) ? row.steps : [];
    if (!steps.length) continue;
    return row;
  }
  return null;
}

function runProcess(scriptArgs: string[], timeoutMs: number) {
  const result = spawnSync(process.execPath, scriptArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: clampInt(timeoutMs, 1000, 15 * 60 * 1000, 120000)
  });
  const payload = parseJsonFromOutput(result && result.stdout);
  const err = result && result.error ? String(result.error.message || result.error) : '';
  const timedOut = /ETIMEDOUT/i.test(err);
  return {
    ok: Number(result && result.status) === 0,
    exit_code: Number.isInteger(result && result.status) ? Number(result.status) : 1,
    timed_out: timedOut,
    payload,
    stdout_excerpt: cleanText(result && result.stdout || '', 600),
    stderr_excerpt: cleanText([result && result.stderr || '', err].filter(Boolean).join(' '), 600)
  };
}

function executeStep(stepId: string, signature: AnyObj, policy: AnyObj) {
  const timeoutMs = Number(policy && policy.execution && policy.execution.step_timeout_ms || 120000);
  if (stepId === 'retest_failed_test') {
    if (signature.trusted_test_command !== true || !signature.test_path) {
      return {
        ok: false,
        step_id: stepId,
        reason: signature.untrusted_reason || 'untrusted_test_command',
        exit_code: 1,
        payload: null,
        stdout_excerpt: '',
        stderr_excerpt: ''
      };
    }
    return {
      ...runProcess([signature.test_path], timeoutMs),
      step_id: stepId
    };
  }
  if (stepId === 'autotest_sync') {
    return {
      ...runProcess(['systems/ops/autotest_controller.js', 'sync'], timeoutMs),
      step_id: stepId
    };
  }
  if (stepId === 'autotest_run_changed') {
    const maxTests = clampInt(policy && policy.execution && policy.execution.autotest_max_tests, 1, 128, 6);
    return {
      ...runProcess([
        'systems/ops/autotest_controller.js',
        'run',
        '--scope=changed',
        `--max-tests=${maxTests}`,
        '--sleep-only=0',
        '--strict=0'
      ], timeoutMs),
      step_id: stepId
    };
  }
  return {
    ok: false,
    step_id: stepId,
    reason: 'unknown_step',
    exit_code: 1,
    payload: null,
    stdout_excerpt: '',
    stderr_excerpt: ''
  };
}

function captureRollbackSnapshot(paths: AnyObj, policy: AnyObj, runId: string, signatureId: string) {
  const files = Array.isArray(policy && policy.rollback && policy.rollback.snapshot_files)
    ? policy.rollback.snapshot_files
    : [];
  const entries = [] as AnyObj[];
  for (const rel of files) {
    const relClean = cleanText(rel, 260);
    if (!relClean) continue;
    const abs = path.resolve(ROOT, relClean);
    const exists = fs.existsSync(abs);
    let content = null;
    if (exists) {
      try {
        content = fs.readFileSync(abs, 'utf8');
      } catch {
        content = null;
      }
    }
    entries.push({
      path: relPath(abs),
      existed: exists,
      content
    });
  }
  const snapshot = {
    ts: nowIso(),
    run_id: runId,
    signature_id: signatureId,
    entries
  };
  const snapPath = path.join(paths.rollback_dir, runId, `${signatureId}.snapshot.json`);
  writeJsonAtomic(snapPath, snapshot);
  return {
    snapshot,
    snapshot_path: relPath(snapPath)
  };
}

function restoreRollbackSnapshot(snapshot: AnyObj) {
  const entries = Array.isArray(snapshot && snapshot.entries) ? snapshot.entries : [];
  let restored = 0;
  for (const row of entries) {
    const rel = cleanText(row && row.path || '', 260);
    if (!rel) continue;
    const abs = path.resolve(ROOT, rel);
    if (row && row.existed === true) {
      try {
        ensureDir(path.dirname(abs));
        fs.writeFileSync(abs, String(row.content == null ? '' : row.content), 'utf8');
        restored += 1;
      } catch {
        // Continue restoring remaining entries.
      }
      continue;
    }
    try {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
      restored += 1;
    } catch {
      // Continue restoring remaining entries.
    }
  }
  return { ok: true, restored_entries: restored };
}

function runRollbackMode(mode: string, policy: AnyObj) {
  const normalized = normalizeToken(mode || 'none', 64);
  if (!normalized || normalized === 'none') {
    return { ok: true, mode: normalized || 'none', skipped: true };
  }
  const timeoutMs = Number(policy && policy.execution && policy.execution.step_timeout_ms || 120000);
  if (normalized === 'autotest_sync') {
    const out = runProcess(['systems/ops/autotest_controller.js', 'sync'], timeoutMs);
    return {
      ok: out.ok === true,
      mode: normalized,
      skipped: false,
      exit_code: out.exit_code,
      stdout_excerpt: out.stdout_excerpt,
      stderr_excerpt: out.stderr_excerpt
    };
  }
  return {
    ok: false,
    mode: normalized,
    skipped: false,
    reason: 'unknown_rollback_mode'
  };
}

function collectFileExcerpts(relFiles: string[], maxFiles: number, maxChars: number) {
  const seen = new Set<string>();
  const out = [] as AnyObj[];
  const lim = Math.max(1, Math.min(100, Number(maxFiles || 10)));
  for (const rel of relFiles) {
    if (out.length >= lim) break;
    const clean = cleanText(rel, 260);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    const abs = path.resolve(ROOT, clean);
    if (!fs.existsSync(abs)) continue;
    if (!fs.statSync(abs).isFile()) continue;
    try {
      const raw = fs.readFileSync(abs, 'utf8');
      out.push({
        path: clean,
        excerpt: raw.slice(0, Math.max(400, Number(maxChars || 3000))),
        sha16: sha16(raw)
      });
    } catch {
      // Ignore unreadable file.
    }
  }
  return out;
}

function writeResearchMirrorItem(
  paths: AnyObj,
  policy: AnyObj,
  dateStr: string,
  signature: AnyObj,
  context: AnyObj,
  brokenPiecePath: string
) {
  const dir = path.join(paths.research_broken_dir, dateStr);
  ensureDir(dir);
  const file = path.join(dir, `${String(signature.signature_id || 'unknown')}_${Date.now()}.json`);
  const rollbackReason = cleanText(
    context && context.rollback && context.rollback.reason
      ? context.rollback.reason
      : context && context.reason,
    220
  ) || null;
  const summary = cleanText([
    `signature=${String(signature.signature_id || 'unknown')}`,
    `kind=${String(signature.kind || 'unknown')}`,
    rollbackReason ? `rollback_reason=${rollbackReason}` : null
  ].filter(Boolean).join(' '), 260);
  const quarantine = computeQuarantinePlan(paths, policy, signature, context);
  const payload = {
    ts: nowIso(),
    schema_id: 'autotest_research_item',
    schema_version: '1.0.0',
    source: 'autotest_doctor',
    category: 'broken_piece',
    date: dateStr,
    signature_id: String(signature.signature_id || ''),
    kind: String(signature.kind || ''),
    test_id: cleanText(signature.test_id || '', 120) || null,
    test_path: cleanText(signature.test_path || '', 260) || null,
    summary: summary || null,
    rollback_reason: rollbackReason,
    broken_piece_path: brokenPiecePath,
    quarantine,
    context: {
      run_id: cleanText(context && context.run_id || '', 120) || null,
      recipe_id: cleanText(context && context.recipe_id || '', 120) || null
    }
  };
  writeJsonAtomic(file, payload);
  const researchPath = relPath(file);
  appendJsonl(paths.research_index_path, {
    ts: payload.ts,
    type: 'autotest_doctor_broken_piece',
    date: dateStr,
    signature_id: payload.signature_id,
    kind: payload.kind,
    rollback_reason: payload.rollback_reason,
    broken_piece_path: brokenPiecePath,
    research_item_path: researchPath,
    quarantine: payload.quarantine
  });
  return researchPath;
}

function writeBrokenPieceBundle(
  paths: AnyObj,
  policy: AnyObj,
  dateStr: string,
  signature: AnyObj,
  context: AnyObj
) {
  const dir = path.join(paths.broken_dir, dateStr);
  ensureDir(dir);
  const file = path.join(dir, `${String(signature.signature_id || 'unknown')}_${Date.now()}.json`);
  const relatedFiles = [
    ...(Array.isArray(signature.guard_files) ? signature.guard_files : []),
    signature.test_path
  ].filter(Boolean).map((row) => cleanText(row, 260));
  const excerpts = collectFileExcerpts(
    relatedFiles,
    Number(policy && policy.rollback && policy.rollback.max_excerpt_files || 10),
    Number(policy && policy.rollback && policy.rollback.max_excerpt_chars || 3000)
  );
  const payload = {
    ts: nowIso(),
    schema_id: 'autotest_broken_piece_bundle',
    schema_version: '1.0.0',
    date: dateStr,
    signature,
    related_file_excerpts: excerpts,
    context: context && typeof context === 'object' ? context : {}
  };
  writeJsonAtomic(file, payload);
  const brokenPiecePath = relPath(file);
  const researchItemPath = writeResearchMirrorItem(
    paths,
    policy,
    dateStr,
    signature,
    context,
    brokenPiecePath
  );
  return {
    broken_piece_path: brokenPiecePath,
    research_item_path: researchItemPath
  };
}

function withinSleepWindow(cfg: AnyObj, now = new Date()) {
  if (!(cfg && cfg.enabled === true)) return true;
  const start = clampInt(cfg.start_hour, 0, 23, 0);
  const end = clampInt(cfg.end_hour, 0, 23, 7);
  const h = now.getHours();
  if (start === end) return true;
  if (start < end) return h >= start && h < end;
  return h >= start || h < end;
}

function evaluateKillSwitch(state: AnyObj, policy: AnyObj) {
  if (!(policy && policy.kill_switch && policy.kill_switch.enabled === true)) {
    return { tripped: false, reason: null };
  }
  const ks = policy.kill_switch;
  const unknownCount = countHistory(state, 'unknown_signature');
  const suspiciousCount = countHistory(state, 'suspicious_signature');
  const repairCount = countHistory(state, 'repair_attempt');
  const rollbackCount = countHistory(state, 'repair_rollback');

  if (unknownCount > Number(ks.max_unknown_signatures_per_window || 0)) {
    return { tripped: true, reason: 'kill_unknown_signature_spike', meta: { unknown_count: unknownCount } };
  }
  if (suspiciousCount > Number(ks.max_suspicious_signatures_per_window || 0)) {
    return { tripped: true, reason: 'kill_suspicious_signature_spike', meta: { suspicious_count: suspiciousCount } };
  }
  if (repairCount > Number(ks.max_repairs_per_window || 0)) {
    return { tripped: true, reason: 'kill_repair_volume_spike', meta: { repair_count: repairCount } };
  }
  if (rollbackCount > Number(ks.max_rollbacks_per_window || 0)) {
    return { tripped: true, reason: 'kill_rollback_spike', meta: { rollback_count: rollbackCount } };
  }

  return {
    tripped: false,
    reason: null,
    meta: {
      unknown_count: unknownCount,
      suspicious_count: suspiciousCount,
      repair_count: repairCount,
      rollback_count: rollbackCount
    }
  };
}

function runDoctor(dateArg: string, args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.AUTOTEST_DOCTOR_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath);
  ensureDir(paths.state_dir);
  ensureDir(paths.runs_dir);
  ensureDir(path.dirname(paths.latest_path));
  ensureDir(path.dirname(paths.history_path));
  ensureDir(path.dirname(paths.events_path));
  ensureDir(path.dirname(paths.state_path));
  ensureDir(paths.rollback_dir);
  ensureDir(paths.broken_dir);
  ensureDir(paths.research_dir);
  ensureDir(paths.research_broken_dir);
  ensureDir(path.dirname(paths.research_index_path));
  ensureDir(paths.first_principles_dir);
  ensureDir(paths.trit_beliefs_dir);
  ensureDir(path.dirname(paths.trit_shadow_reports_history_path));

  const runId = `doctor_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const dateStr = String(dateArg || 'latest').toLowerCase() === 'latest'
    ? nowIso().slice(0, 10)
    : toDate(dateArg);
  const startedMs = Date.now();

  const state = loadDoctorState(paths);
  maybeAutoReleaseKillSwitch(state, policy);
  pruneHistory(state, Number(policy.kill_switch.window_hours || 24), Number(policy.telemetry.max_history_events || 5000));

  const applyRequested = toBool(args.apply, false);
  const apply = applyRequested && policy.shadow_mode !== true;
  const force = toBool(args.force, false);
  const resetKillSwitch = toBool(args['reset-kill-switch'], false);
  const maxActions = clampInt(args['max-actions'], 1, 100, Number(policy.gating.max_actions_per_run || 2));

  if (resetKillSwitch) {
    state.kill_switch = {
      engaged: false,
      reason: null,
      engaged_at: null,
      auto_release_at: null,
      last_trip_meta: state.kill_switch && state.kill_switch.last_trip_meta ? state.kill_switch.last_trip_meta : null
    };
    recordHistoryEvent(state, 'kill_switch_manual_reset');
  }

  const sleepOk = withinSleepWindow(policy.sleep_window_local, new Date());
  const skipReasons = [] as string[];
  if (policy.enabled !== true) skipReasons.push('doctor_disabled');
  if (!sleepOk && force !== true) skipReasons.push('outside_sleep_window');
  if (state.kill_switch && state.kill_switch.engaged === true && force !== true) skipReasons.push('kill_switch_engaged');

  const latestAutotest = readAutotestLatest(paths);
  const runObj = loadLatestAutotestRun(paths, dateArg || 'latest');
  const runRow = runObj && runObj.row && typeof runObj.row === 'object' ? runObj.row : null;
  const failures = collectFailures(runRow);

  const observedIds = new Set(failures.map((row) => String(row.signature_id || '')));
  for (const [sigId, sigState] of Object.entries(state.signatures || {})) {
    if (observedIds.has(String(sigId))) continue;
    if (!sigState || typeof sigState !== 'object') continue;
    sigState.consecutive_failures = 0;
    sigState.last_outcome = sigState.last_outcome || 'idle';
  }

  for (const failure of failures) {
    const sigState = ensureSignatureState(state, String(failure.signature_id || ''));
    sigState.consecutive_failures = Number(sigState.consecutive_failures || 0) + 1;
    sigState.total_failures = Number(sigState.total_failures || 0) + 1;
    sigState.last_fail_ts = nowIso();
    const destructiveInfo = isDestructiveSignature(policy, failure, {});
    updateDestructiveSignatureState(state, failure, destructiveInfo);
    if (destructiveInfo.destructive === true) {
      recordHistoryEvent(state, 'destructive_signature', {
        signature_id: failure.signature_id,
        reason: cleanText(failure.guard_reason || failure.stderr_excerpt || '', 180) || null,
        token: destructiveInfo.token || null
      });
      appendSystemHealthEvent(paths, policy, {
        severity: 'high',
        risk: 'high',
        code: 'autotest_doctor_wounded_module',
        summary: `autotest doctor marked wounded module signature=${String(failure.signature_id || '').slice(0, 40)}`,
        signature_id: failure.signature_id,
        module: cleanText((Array.isArray(failure.guard_files) ? failure.guard_files[0] : '') || failure.test_path || '', 220) || null,
        viz_state: 'wounded',
        viz_color: 'red'
      });
    }
    if (failure.trusted_test_command !== true) {
      recordHistoryEvent(state, 'suspicious_signature', {
        signature_id: failure.signature_id,
        reason: failure.untrusted_reason || 'untrusted_test_command',
        kind: failure.kind
      });
    }
  }

  pruneHistory(state, Number(policy.kill_switch.window_hours || 24), Number(policy.telemetry.max_history_events || 5000));
  const killEvalPre = evaluateKillSwitch(state, policy);
  if (killEvalPre.tripped === true && !(state.kill_switch && state.kill_switch.engaged === true)) {
    engageKillSwitch(state, killEvalPre.reason || 'kill_switch_policy_trip', killEvalPre.meta || {});
    appendSystemHealthEvent(paths, policy, {
      severity: 'high',
      risk: 'high',
      code: 'autotest_doctor_kill_switch',
      summary: `autotest doctor kill-switch engaged (${String(killEvalPre.reason || 'policy_trip').slice(0, 120)})`,
      reason: killEvalPre.reason || null,
      meta: killEvalPre.meta || {}
    });
    if (force !== true) {
      if (!skipReasons.includes('kill_switch_engaged')) skipReasons.push('kill_switch_engaged');
    }
  }

  const actions = [] as AnyObj[];
  let actionsPlanned = 0;
  let actionsApplied = 0;
  let rollbacks = 0;
  let destructiveBlocked = 0;
  const brokenPieces = [] as string[];
  const researchItems = [] as string[];
  const firstPrinciples = [] as string[];
  const approvalSignal = getApprovalSignal(args, policy);

  if (!skipReasons.length || force === true) {
    for (const failure of failures) {
      if (actionsPlanned >= maxActions) break;
      const sigId = String(failure.signature_id || '');
      const sigState = ensureSignatureState(state, sigId);
      const destructiveRec = state.destructive_signatures && typeof state.destructive_signatures === 'object'
        ? state.destructive_signatures[sigId]
        : null;
      const requiresDestructiveApproval = !!(destructiveRec && typeof destructiveRec === 'object')
        && policy.safety_override
        && policy.safety_override.enabled === true
        && policy.safety_override.require_human_approval_for_destructive_reimplementation === true;
      if (apply && requiresDestructiveApproval && approvalSignal.approved !== true) {
        destructiveBlocked += 1;
        actions.push({
          signature_id: sigId,
          kind: failure.kind,
          status: 'blocked',
          reason: 'destructive_signature_requires_human_approval',
          approval: {
            required: true,
            approved: false,
            approver_id: approvalSignal.approver_id
          }
        });
        appendSystemHealthEvent(paths, policy, {
          severity: 'high',
          risk: 'high',
          code: 'autotest_doctor_destructive_repair_blocked',
          summary: `autotest doctor blocked destructive reimplementation for signature=${sigId}`,
          signature_id: sigId,
          viz_state: 'wounded',
          viz_color: 'red'
        });
        continue;
      }

      const recipe = selectRecipe(policy, String(failure.kind || ''));
      if (!recipe) {
        recordHistoryEvent(state, 'unknown_signature', {
          signature_id: sigId,
          kind: failure.kind || null,
          test_id: failure.test_id || null
        });
        actions.push({
          signature_id: sigId,
          kind: failure.kind,
          status: 'skipped',
          reason: 'no_recipe'
        });
        continue;
      }

      const minFailures = Number(policy.gating.min_consecutive_failures || 2);
      if (Number(sigState.consecutive_failures || 0) < minFailures) {
        actions.push({
          signature_id: sigId,
          kind: failure.kind,
          recipe_id: recipe.id,
          status: 'skipped',
          reason: 'below_consecutive_failure_threshold',
          consecutive_failures: Number(sigState.consecutive_failures || 0),
          threshold: minFailures
        });
        continue;
      }

      const lastRepairMs = parseIsoMs(sigState.last_repair_ts);
      const cooldownSec = Number(policy.gating.cooldown_sec_per_signature || 0);
      if (cooldownSec > 0 && Number.isFinite(lastRepairMs) && (Date.now() - Number(lastRepairMs)) < (cooldownSec * 1000)) {
        actions.push({
          signature_id: sigId,
          kind: failure.kind,
          recipe_id: recipe.id,
          status: 'skipped',
          reason: 'cooldown_active',
          cooldown_sec: cooldownSec
        });
        continue;
      }

      const sameSigAttempts = countHistory(state, 'repair_attempt', sigId);
      const maxSigAttempts = Number(policy.kill_switch.max_same_signature_repairs_per_window || 4);
      if (sameSigAttempts >= maxSigAttempts) {
        engageKillSwitch(state, 'kill_same_signature_repair_spike', {
          signature_id: sigId,
          attempts: sameSigAttempts,
          threshold: maxSigAttempts
        });
        appendSystemHealthEvent(paths, policy, {
          severity: 'high',
          risk: 'high',
          code: 'autotest_doctor_kill_same_signature',
          summary: `autotest doctor kill-switch engaged on signature ${sigId}`,
          signature_id: sigId,
          attempts: sameSigAttempts,
          threshold: maxSigAttempts
        });
        actions.push({
          signature_id: sigId,
          kind: failure.kind,
          recipe_id: recipe.id,
          status: 'blocked',
          reason: 'kill_switch_same_signature_limit'
        });
        break;
      }

      const maxPerDay = Number(policy.gating.max_repairs_per_signature_per_day || 3);
      const sameSigRepairs = countHistory(state, 'repair_attempt', sigId);
      if (sameSigRepairs >= maxPerDay) {
        actions.push({
          signature_id: sigId,
          kind: failure.kind,
          recipe_id: recipe.id,
          status: 'skipped',
          reason: 'max_repairs_per_signature_window',
          repairs_window: sameSigRepairs,
          limit: maxPerDay
        });
        continue;
      }

      actionsPlanned += 1;
      const preHealth = readAutotestLatest(paths);
      const snapshotInfo = captureRollbackSnapshot(paths, policy, runId, sigId);
      const stepResults = [] as AnyObj[];
      let recipeOk = true;
      let recipeFailureReason = null as string | null;

      if (apply) {
        appendSystemHealthEvent(paths, policy, {
          severity: 'medium',
          risk: 'medium',
          code: 'autotest_doctor_healing_attempt',
          summary: `autotest doctor healing attempt signature=${sigId}`,
          signature_id: sigId,
          recipe_id: recipe.id,
          viz_state: 'healing',
          viz_color: 'white'
        });
        for (const step of recipe.steps) {
          const result = executeStep(step, failure, policy);
          stepResults.push(result);
          if (result.ok !== true) {
            recipeOk = false;
            recipeFailureReason = cleanText(result.reason || result.stderr_excerpt || 'step_failed', 180) || 'step_failed';
            break;
          }
        }
      }

      const postHealth = readAutotestLatest(paths);
      const regression = apply && (
        Number(postHealth.failed_tests || 0) > Number(preHealth.failed_tests || 0)
        || Number(postHealth.modules_red || 0) > Number(preHealth.modules_red || 0)
      );

      let rollbackResult = null as AnyObj | null;
      let brokenPiecePath = null as string | null;
      let researchItemPath = null as string | null;
      let principleId = null as string | null;
      let status = 'shadow_planned';
      let reason = 'shadow_mode';

      if (apply) {
        recordHistoryEvent(state, 'repair_attempt', {
          signature_id: sigId,
          recipe_id: recipe.id,
          kind: failure.kind
        });
        actionsApplied += 1;
        sigState.total_repairs = Number(sigState.total_repairs || 0) + 1;
        sigState.last_repair_ts = nowIso();
        sigState.last_recipe_id = recipe.id;

        const needsRollback = recipeOk !== true || regression;
        if (needsRollback) {
          const restored = restoreRollbackSnapshot(snapshotInfo.snapshot);
          const rollbackMode = policy && policy.rollback ? policy.rollback.mode : 'none';
          const rollbackCommand = runRollbackMode(String(rollbackMode || 'none'), policy);
          rollbackResult = {
            restored,
            rollback_command: rollbackCommand,
            reason: regression ? 'post_repair_regression' : (recipeFailureReason || 'repair_step_failed')
          };
          status = 'rolled_back';
          reason = rollbackResult.reason;
          rollbacks += 1;
          sigState.total_rollbacks = Number(sigState.total_rollbacks || 0) + 1;
          sigState.last_outcome = 'rolled_back';
          recordHistoryEvent(state, 'repair_rollback', {
            signature_id: sigId,
            recipe_id: recipe.id,
            reason
          });

          if (policy.rollback && policy.rollback.store_broken_pieces === true) {
            const bundle = writeBrokenPieceBundle(paths, policy, dateStr, failure, {
              run_id: runId,
              recipe_id: recipe.id,
              pre_health: preHealth,
              post_health: postHealth,
              step_results: stepResults,
              rollback: rollbackResult,
              snapshot_path: snapshotInfo.snapshot_path
            });
            brokenPiecePath = String(bundle && bundle.broken_piece_path || '');
            researchItemPath = String(bundle && bundle.research_item_path || '');
            if (brokenPiecePath) brokenPieces.push(brokenPiecePath);
            if (researchItemPath) researchItems.push(researchItemPath);
          }
          appendSystemHealthEvent(paths, policy, {
            severity: 'high',
            risk: 'high',
            code: 'autotest_doctor_rollback_cut',
            summary: `autotest doctor rollback cut signature=${sigId}`,
            signature_id: sigId,
            rollback_reason: reason,
            viz_state: 'rollback_cut',
            viz_color: 'red'
          });
        } else {
          status = 'applied';
          reason = 'recipe_applied';
          sigState.last_outcome = 'applied';
          sigState.consecutive_failures = 0;
          appendSystemHealthEvent(paths, policy, {
            severity: 'low',
            risk: 'low',
            code: 'autotest_doctor_regrowth',
            summary: `autotest doctor regrowth success signature=${sigId}`,
            signature_id: sigId,
            recipe_id: recipe.id,
            viz_state: 'regrowth',
            viz_color: 'green'
          });
        }
        const severityInfo = classifySeverity(policy, failure, {
          reason,
          rollback: rollbackResult,
          regression
        });
        const beliefPack = buildDoctorBelief(policy, failure, {
          status,
          regression,
          destructive: severityInfo.severity === 'critical',
          severity: severityInfo.severity
        });
        if (beliefPack && beliefPack.serialized) {
          persistDoctorBelief(paths, {
            ts: nowIso(),
            type: 'autotest_doctor_trit_belief',
            signature_id: sigId,
            status,
            severity: severityInfo.severity,
            belief: beliefPack.serialized,
            signals: beliefPack.signals
          });
        }
        const principle = maybePersistFirstPrinciple(paths, policy, failure, {
          status,
          reason,
          severity: severityInfo.severity
        }, beliefPack);
        if (principle && principle.id) {
          principleId = String(principle.id);
          firstPrinciples.push(principleId);
        }
      } else {
        sigState.last_outcome = 'shadow_planned';
      }

      actions.push({
        signature_id: sigId,
        kind: failure.kind,
        recipe_id: recipe.id,
        status,
        reason,
        apply,
        steps: recipe.steps,
        step_results: stepResults,
        pre_health: preHealth,
        post_health: postHealth,
        regression: !!regression,
        rollback: rollbackResult,
        rollback_snapshot_path: snapshotInfo.snapshot_path,
        broken_piece_path: brokenPiecePath,
        research_item_path: researchItemPath,
        first_principle_id: principleId
      });
    }
  }

  pruneHistory(state, Number(policy.kill_switch.window_hours || 24), Number(policy.telemetry.max_history_events || 5000));
  const killEvalPost = evaluateKillSwitch(state, policy);
  if (killEvalPost.tripped === true && !(state.kill_switch && state.kill_switch.engaged === true)) {
    engageKillSwitch(state, killEvalPost.reason || 'kill_switch_policy_trip', killEvalPost.meta || {});
    appendSystemHealthEvent(paths, policy, {
      severity: 'high',
      risk: 'high',
      code: 'autotest_doctor_kill_switch',
      summary: `autotest doctor kill-switch engaged (${String(killEvalPost.reason || 'policy_trip').slice(0, 120)})`,
      reason: killEvalPost.reason || null,
      meta: killEvalPost.meta || {}
    });
  }

  state.updated_at = nowIso();
  writeJsonAtomic(paths.state_path, state);

  const payload = {
    ok: true,
    type: 'autotest_doctor_run',
    ts: nowIso(),
    run_id: runId,
    date: dateStr,
    apply,
    apply_requested: applyRequested,
    shadow_mode_policy: policy.shadow_mode === true,
    force,
    sleep_window_ok: sleepOk,
    skipped: skipReasons.length > 0 && force !== true,
    skip_reasons: skipReasons,
    policy: {
      version: policy.version,
      path: relPath(policyPath)
    },
    autotest_source: runObj
      ? {
          file: relPath(runObj.file_path),
          file_date: runObj.file_date,
          run_ts: cleanText(runRow && runRow.ts || '', 64) || null,
          selected_tests: Number(runRow && runRow.selected_tests || 0),
          failed: Number(runRow && runRow.failed || 0),
          guard_blocked: Number(runRow && runRow.guard_blocked || 0)
        }
      : null,
    failures_observed: failures.length,
    actions_planned: actionsPlanned,
    actions_applied: actionsApplied,
    rollbacks,
    destructive_repair_blocks: destructiveBlocked,
    broken_pieces_stored: brokenPieces.length,
    broken_piece_paths: brokenPieces,
    research_items_stored: researchItems.length,
    research_item_paths: researchItems,
    first_principles_generated: firstPrinciples.length,
    first_principle_ids: firstPrinciples,
    destructive_approval: approvalSignal,
    kill_switch: state.kill_switch,
    latest_autotest_health: latestAutotest,
    actions,
    duration_ms: Date.now() - startedMs
  };

  const runPath = path.join(paths.runs_dir, `${dateStr}.json`);
  writeJsonAtomic(runPath, payload);
  writeJsonAtomic(paths.latest_path, payload);
  appendJsonl(paths.history_path, {
    ts: payload.ts,
    type: payload.type,
    run_id: payload.run_id,
    date: payload.date,
    apply: payload.apply,
    skipped: payload.skipped,
    failures_observed: payload.failures_observed,
    actions_planned: payload.actions_planned,
    actions_applied: payload.actions_applied,
    rollbacks: payload.rollbacks,
    destructive_repair_blocks: payload.destructive_repair_blocks,
    broken_pieces_stored: payload.broken_pieces_stored,
    research_items_stored: payload.research_items_stored,
    kill_switch_engaged: payload.kill_switch && payload.kill_switch.engaged === true
  });

  appendJsonl(paths.events_path, {
    ts: payload.ts,
    type: 'autotest_doctor_event',
    run_id: payload.run_id,
    date: payload.date,
    apply: payload.apply,
    skipped: payload.skipped,
    failures_observed: payload.failures_observed,
    actions_applied: payload.actions_applied,
    rollbacks: payload.rollbacks,
    kill_switch: payload.kill_switch
  });

  if (payload.rollbacks > 0) {
    appendSystemHealthEvent(paths, policy, {
      severity: 'high',
      risk: 'high',
      code: 'autotest_doctor_rollbacks',
      summary: `autotest doctor executed rollbacks=${payload.rollbacks}`,
      run_id: runId,
      rollbacks: payload.rollbacks,
      broken_pieces_stored: payload.broken_pieces_stored
    });
  }

  if (payload.actions_applied > 0 && payload.rollbacks === 0) {
    appendSystemHealthEvent(paths, policy, {
      severity: 'medium',
      risk: 'medium',
      code: 'autotest_doctor_repairs_applied',
      summary: `autotest doctor applied repairs=${payload.actions_applied}`,
      run_id: runId,
      actions_applied: payload.actions_applied
    });
  }

  payload.run_path = relPath(runPath);
  payload.latest_path = relPath(paths.latest_path);
  payload.state_path = relPath(paths.state_path);
  return payload;
}

function statusCmd(dateArg: string, args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.AUTOTEST_DOCTOR_POLICY_PATH || DEFAULT_POLICY_PATH));
  const paths = runtimePaths(policyPath);
  const key = String(dateArg || 'latest').trim().toLowerCase();
  const payload = key === 'latest'
    ? readJson(paths.latest_path, null)
    : readJson(path.join(paths.runs_dir, `${toDate(key)}.json`), null);
  const state = loadDoctorState(paths);
  pruneHistory(state, 24, 200000);
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      type: 'autotest_doctor_status',
      error: 'autotest_doctor_snapshot_missing',
      kill_switch: state.kill_switch,
      state_path: relPath(paths.state_path)
    };
  }
  return {
    ok: true,
    type: 'autotest_doctor_status',
    ts: payload.ts || null,
    run_id: payload.run_id || null,
    date: payload.date || null,
    apply: payload.apply === true,
    skipped: payload.skipped === true,
    failures_observed: Number(payload.failures_observed || 0),
    actions_planned: Number(payload.actions_planned || 0),
    actions_applied: Number(payload.actions_applied || 0),
    rollbacks: Number(payload.rollbacks || 0),
    destructive_repair_blocks: Number(payload.destructive_repair_blocks || 0),
    broken_pieces_stored: Number(payload.broken_pieces_stored || 0),
    research_items_stored: Number(payload.research_items_stored || 0),
    kill_switch: state.kill_switch,
    recent_repair_attempts_24h: countHistory(state, 'repair_attempt'),
    recent_rollbacks_24h: countHistory(state, 'repair_rollback'),
    recent_unknown_signatures_24h: countHistory(state, 'unknown_signature'),
    recent_suspicious_signatures_24h: countHistory(state, 'suspicious_signature'),
    run_path: payload.run_path || null,
    latest_path: relPath(paths.latest_path),
    state_path: relPath(paths.state_path)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') {
    const payload = runDoctor(args._[1] || 'latest', args);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  if (cmd === 'status') {
    const payload = statusCmd(args._[1] || 'latest', args);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    if (payload.ok !== true) process.exitCode = 1;
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'autotest_doctor',
      error: String(err && err.message ? err.message : err || 'autotest_doctor_failed')
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  collectFailures,
  classifyFailureKind,
  extractTrustedTestPath,
  loadPolicy,
  runDoctor,
  statusCmd
};
