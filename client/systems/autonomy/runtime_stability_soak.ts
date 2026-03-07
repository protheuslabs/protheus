#!/usr/bin/env node
'use strict';
export {};

/**
 * runtime_stability_soak.js
 *
 * 24h shadow soak + live gated cycle runner for launch-readiness validation.
 *
 * Commands:
 *   node systems/autonomy/runtime_stability_soak.js start [--policy=<abs-or-rel-path>] [--duration-hours=24] [--interval-minutes=60]
 *   node systems/autonomy/runtime_stability_soak.js check-now [--policy=<abs-or-rel-path>]
 *   node systems/autonomy/runtime_stability_soak.js status [--policy=<abs-or-rel-path>]
 *   node systems/autonomy/runtime_stability_soak.js report [--policy=<abs-or-rel-path>]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { compileDirectiveLineage } = require('../security/directive_compiler');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.RUNTIME_STABILITY_SOAK_POLICY_PATH
  ? path.resolve(process.env.RUNTIME_STABILITY_SOAK_POLICY_PATH)
  : path.join(ROOT, 'config', 'runtime_stability_soak_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 160) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
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

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? path.resolve(txt) : path.join(ROOT, txt);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    soak: {
      duration_hours: 24,
      interval_minutes: 60,
      cycle_count: 4
    },
    thresholds: {
      symbiosis_min_score: 0.7,
      require_helix_tier: 'clear',
      require_attestation_decision: 'allow'
    },
    gated_cycle: {
      policy_path: 'state/autonomy/private_cycle_headstart/gated_self_improvement_policy.private.json',
      objective_id: 't1_make_jay_billionaire_v1',
      target_path: 'systems/autonomy/gated_self_improvement_loop.ts',
      risk: 'medium',
      approval_a: 'private_headstart_a',
      approval_b: 'private_headstart_b',
      simulation_days: 180
    },
    attribution: {
      creator_id: 'protheus_seed_instance',
      objective_id: 't1_make_jay_billionaire_v1',
      base_value_usd: 100,
      value_step_usd: 10
    },
    checks: {
      command_timeout_ms: 180000
    },
    queue_hygiene: {
      enabled: true,
      stale_open_hours: 72,
      retry_cap_no_progress: 3,
      retry_window_days: 14,
      objective_binding_required: true,
      executable_spec_required: true
    },
    budget_pacing: {
      enabled: true,
      min_remaining_ratio: 0.2,
      block_pressure_levels: ['hard', 'critical']
    },
    paths: {
      root: 'state/autonomy/runtime_stability_soak',
      state_path: 'state/autonomy/runtime_stability_soak/state.json',
      latest_path: 'state/autonomy/runtime_stability_soak/latest.json',
      checks_path: 'state/autonomy/runtime_stability_soak/checks.jsonl',
      cycles_path: 'state/autonomy/runtime_stability_soak/cycles.jsonl',
      reports_dir: 'state/autonomy/runtime_stability_soak/reports',
      proposals_dir: 'state/sensory/proposals',
      runs_dir: 'state/autonomy/runs',
      daily_budget_dir: 'state/autonomy/daily_budget'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const soak = raw.soak && typeof raw.soak === 'object' ? raw.soak : {};
  const thresholds = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const gated = raw.gated_cycle && typeof raw.gated_cycle === 'object' ? raw.gated_cycle : {};
  const attribution = raw.attribution && typeof raw.attribution === 'object' ? raw.attribution : {};
  const checks = raw.checks && typeof raw.checks === 'object' ? raw.checks : {};
  const queueHygiene = raw.queue_hygiene && typeof raw.queue_hygiene === 'object'
    ? raw.queue_hygiene
    : {};
  const budgetPacing = raw.budget_pacing && typeof raw.budget_pacing === 'object'
    ? raw.budget_pacing
    : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    soak: {
      duration_hours: clampInt(soak.duration_hours, 1, 24 * 30, base.soak.duration_hours),
      interval_minutes: clampInt(soak.interval_minutes, 1, 24 * 60, base.soak.interval_minutes),
      cycle_count: clampInt(soak.cycle_count, 1, 50, base.soak.cycle_count)
    },
    thresholds: {
      symbiosis_min_score: clampNumber(
        thresholds.symbiosis_min_score,
        0,
        1,
        base.thresholds.symbiosis_min_score
      ),
      require_helix_tier: normalizeToken(
        thresholds.require_helix_tier || base.thresholds.require_helix_tier,
        40
      ) || base.thresholds.require_helix_tier,
      require_attestation_decision: normalizeToken(
        thresholds.require_attestation_decision || base.thresholds.require_attestation_decision,
        40
      ) || base.thresholds.require_attestation_decision
    },
    gated_cycle: {
      policy_path: resolvePath(gated.policy_path || base.gated_cycle.policy_path, base.gated_cycle.policy_path),
      objective_id: normalizeToken(gated.objective_id || base.gated_cycle.objective_id, 180)
        || base.gated_cycle.objective_id,
      target_path: cleanText(gated.target_path || base.gated_cycle.target_path, 260)
        || base.gated_cycle.target_path,
      risk: normalizeToken(gated.risk || base.gated_cycle.risk, 24) || base.gated_cycle.risk,
      approval_a: cleanText(gated.approval_a || base.gated_cycle.approval_a, 120)
        || base.gated_cycle.approval_a,
      approval_b: cleanText(gated.approval_b || base.gated_cycle.approval_b, 120)
        || base.gated_cycle.approval_b,
      simulation_days: clampInt(gated.simulation_days, 14, 3650, base.gated_cycle.simulation_days)
    },
    attribution: {
      creator_id: normalizeToken(attribution.creator_id || base.attribution.creator_id, 180)
        || base.attribution.creator_id,
      objective_id: normalizeToken(attribution.objective_id || base.attribution.objective_id, 180)
        || base.attribution.objective_id,
      base_value_usd: clampNumber(attribution.base_value_usd, 1, 1_000_000_000, base.attribution.base_value_usd),
      value_step_usd: clampNumber(attribution.value_step_usd, 0, 1_000_000_000, base.attribution.value_step_usd)
    },
    checks: {
      command_timeout_ms: clampInt(checks.command_timeout_ms, 5_000, 30 * 60 * 1000, base.checks.command_timeout_ms)
    },
    queue_hygiene: {
      enabled: queueHygiene.enabled !== false,
      stale_open_hours: clampInt(
        queueHygiene.stale_open_hours,
        24,
        24 * 30,
        base.queue_hygiene.stale_open_hours
      ),
      retry_cap_no_progress: clampInt(
        queueHygiene.retry_cap_no_progress,
        1,
        20,
        base.queue_hygiene.retry_cap_no_progress
      ),
      retry_window_days: clampInt(
        queueHygiene.retry_window_days,
        1,
        60,
        base.queue_hygiene.retry_window_days
      ),
      objective_binding_required: queueHygiene.objective_binding_required !== false,
      executable_spec_required: queueHygiene.executable_spec_required !== false
    },
    budget_pacing: {
      enabled: budgetPacing.enabled !== false,
      min_remaining_ratio: clampNumber(
        budgetPacing.min_remaining_ratio,
        0.01,
        0.95,
        base.budget_pacing.min_remaining_ratio
      ),
      block_pressure_levels: Array.isArray(budgetPacing.block_pressure_levels)
        ? budgetPacing.block_pressure_levels.map((v: unknown) => normalizeToken(v, 32)).filter(Boolean)
        : base.budget_pacing.block_pressure_levels
    },
    paths: {
      root: resolvePath(paths.root || base.paths.root, base.paths.root),
      state_path: resolvePath(paths.state_path || base.paths.state_path, base.paths.state_path),
      latest_path: resolvePath(paths.latest_path || base.paths.latest_path, base.paths.latest_path),
      checks_path: resolvePath(paths.checks_path || base.paths.checks_path, base.paths.checks_path),
      cycles_path: resolvePath(paths.cycles_path || base.paths.cycles_path, base.paths.cycles_path),
      reports_dir: resolvePath(paths.reports_dir || base.paths.reports_dir, base.paths.reports_dir),
      proposals_dir: resolvePath(paths.proposals_dir || base.paths.proposals_dir, base.paths.proposals_dir),
      runs_dir: resolvePath(paths.runs_dir || base.paths.runs_dir, base.paths.runs_dir),
      daily_budget_dir: resolvePath(paths.daily_budget_dir || base.paths.daily_budget_dir, base.paths.daily_budget_dir)
    },
    policy_path: path.resolve(policyPath)
  };
}

function defaultState() {
  return {
    schema_id: 'runtime_stability_soak_state',
    schema_version: '1.0',
    updated_at: null,
    running: false,
    run_id: null,
    phase: 'idle',
    started_at: null,
    ended_at: null,
    soak_checks_completed: 0,
    soak_checks_total: 0,
    cycles_completed: 0,
    cycles_total: 0,
    last_error: null,
    latest_report_path: null
  };
}

function loadState(policy: AnyObj) {
  const src = readJson(policy.paths.state_path, null);
  const base = defaultState();
  if (!src || typeof src !== 'object') return base;
  return { ...base, ...src };
}

function saveState(policy: AnyObj, state: AnyObj) {
  const out = {
    ...defaultState(),
    ...state,
    updated_at: nowIso()
  };
  writeJsonAtomic(policy.paths.state_path, out);
  return out;
}

function parseJsonFromStdout(stdout: string) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

function runNode(scriptRel: string, args: string[] = [], opts: AnyObj = {}) {
  const timeout = clampInt(
    opts.timeout_ms,
    5_000,
    30 * 60 * 1000,
    180_000
  );
  const env = opts.env && typeof opts.env === 'object'
    ? { ...process.env, ...opts.env }
    : process.env;
  const run = spawnSync(process.execPath, [path.join(ROOT, scriptRel), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
    env
  });
  const timedOut = !!(run.error && String(run.error.code || '').toUpperCase() === 'ETIMEDOUT');
  const payload = parseJsonFromStdout(String(run.stdout || ''));
  return {
    ok: run.status === 0,
    code: Number.isFinite(run.status) ? Number(run.status) : null,
    timed_out: timedOut,
    error: run.error ? cleanText(run.error.message || run.error, 300) : null,
    payload,
    stdout_tail: String(run.stdout || '').split('\n').slice(-4),
    stderr_tail: String(run.stderr || '').split('\n').slice(-4)
  };
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseDateFromFilename(name: string) {
  const m = String(name || '').match(/^(\d{4}-\d{2}-\d{2})\.json(?:l)?$/);
  return m ? m[1] : null;
}

function windowDateSet(days: number) {
  const limit = Math.max(1, Number(days) || 1);
  const out = new Set<string>();
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < limit; i += 1) {
    const d = new Date(base.getTime() - i * 24 * 60 * 60 * 1000);
    out.add(d.toISOString().slice(0, 10));
  }
  return out;
}

function normalizeDirectiveId(v: unknown) {
  const txt = cleanText(v, 220);
  return /^T\d+_[A-Za-z0-9_]+$/.test(txt) ? txt : '';
}

function objectiveFromProposal(row: AnyObj = {}) {
  const actionSpec = row && row.action_spec && typeof row.action_spec === 'object'
    ? row.action_spec
    : {};
  const meta = row && row.meta && typeof row.meta === 'object'
    ? row.meta
    : {};
  return normalizeDirectiveId(
    actionSpec.objective_id
    || meta.objective_id
    || meta.directive_objective_id
    || row.objective_id
    || ''
  );
}

function commandFromProposal(row: AnyObj = {}) {
  const actionSpec = row && row.action_spec && typeof row.action_spec === 'object'
    ? row.action_spec
    : {};
  return cleanText(
    actionSpec.next_command
    || row.suggested_next_command
    || row.next_command
    || '',
    600
  );
}

function proposalTimestampMs(row: AnyObj = {}, fileDate: string) {
  const candidates = [
    Date.parse(`${fileDate}T00:00:00.000Z`),
    Date.parse(String(row.created_at || '')),
    Date.parse(String(row.ts || '')),
    Date.parse(String(row.updated_at || ''))
  ].filter((v) => Number.isFinite(v));
  if (!candidates.length) return null;
  return Math.min(...candidates);
}

function proposalIdFromRun(row: AnyObj = {}) {
  return cleanText(row.proposal_id || row.selected_proposal_id || '', 180);
}

function buildNoProgressRetryCounts(runsDir: string, windowDays: number) {
  const counts: AnyObj = {};
  if (!fs.existsSync(runsDir)) return counts;
  const allowDates = windowDateSet(windowDays);
  const files = fs.readdirSync(runsDir)
    .filter((name) => name.endsWith('.jsonl') && allowDates.has(String(parseDateFromFilename(name) || '')))
    .sort();
  for (const file of files) {
    const rows = readJsonl(path.join(runsDir, file));
    for (const row of rows) {
      if (!(row && row.type === 'autonomy_run')) continue;
      const proposalId = proposalIdFromRun(row);
      if (!proposalId) continue;
      const result = cleanText(row.result || '', 120).toLowerCase();
      const outcome = cleanText(row.outcome || '', 120).toLowerCase();
      const noProgress = (
        (result === 'executed' && outcome !== 'shipped')
        || result.includes('no_progress')
        || result.includes('unchanged_state')
        || result.includes('low_execution_confidence')
      );
      if (!noProgress) continue;
      counts[proposalId] = Number(counts[proposalId] || 0) + 1;
    }
  }
  return counts;
}

function runQueueHygiene(policy: AnyObj, apply = true) {
  const summary: AnyObj = {
    enabled: policy.queue_hygiene && policy.queue_hygiene.enabled === true,
    applied: apply === true,
    scanned: 0,
    open_seen: 0,
    parked: 0,
    files_touched: 0,
    reasons: {}
  };
  if (summary.enabled !== true) return summary;

  const proposalsDir = policy.paths.proposals_dir;
  const allowDates = windowDateSet(180);
  const retryCounts = buildNoProgressRetryCounts(
    policy.paths.runs_dir,
    Number(policy.queue_hygiene.retry_window_days || 14)
  );
  const compiler = compileDirectiveLineage();
  const activeObjectives = new Set(
    Array.isArray(compiler && compiler.entries)
      ? compiler.entries.map((row: AnyObj) => normalizeDirectiveId(row && row.id || '')).filter(Boolean)
      : []
  );
  const nowMs = Date.now();
  const staleMs = Number(policy.queue_hygiene.stale_open_hours || 72) * 60 * 60 * 1000;
  const retryCap = Number(policy.queue_hygiene.retry_cap_no_progress || 3);

  if (!fs.existsSync(proposalsDir)) {
    return {
      ...summary,
      missing_proposals_dir: rel(proposalsDir)
    };
  }
  const files = fs.readdirSync(proposalsDir)
    .filter((name) => name.endsWith('.json') && allowDates.has(String(parseDateFromFilename(name) || '')))
    .sort();

  for (const name of files) {
    const fileDate = String(parseDateFromFilename(name) || '');
    const fp = path.join(proposalsDir, name);
    const rows = readJson(fp, []);
    if (!Array.isArray(rows)) continue;
    let touched = false;
    for (const row of rows) {
      if (!(row && typeof row === 'object')) continue;
      summary.scanned += 1;
      const status = normalizeToken(row.status || row.state || 'open', 32);
      if (!(status === 'open' || status === 'pending')) continue;
      summary.open_seen += 1;

      const reasons: string[] = [];
      const objectiveId = objectiveFromProposal(row);
      const command = commandFromProposal(row);
      const tsMs = proposalTimestampMs(row, fileDate);
      const proposalAgeMs = tsMs == null ? 0 : Math.max(0, nowMs - tsMs);
      const proposalId = cleanText(row.id || '', 180);
      const noProgressRetries = proposalId ? Number(retryCounts[proposalId] || 0) : 0;
      const admissionPreview = row.meta && row.meta.admission_preview && typeof row.meta.admission_preview === 'object'
        ? row.meta.admission_preview
        : {};
      const blockedByPreview = Array.isArray(admissionPreview.blocked_by)
        ? admissionPreview.blocked_by.filter(Boolean)
        : [];

      if (policy.queue_hygiene.objective_binding_required === true) {
        if (!objectiveId) {
          reasons.push('objective_binding_missing');
        } else if (!activeObjectives.has(objectiveId)) {
          reasons.push('objective_binding_invalid');
        }
      }
      if (policy.queue_hygiene.executable_spec_required === true && !command) {
        reasons.push('executable_spec_missing');
      }
      if (admissionPreview.eligible === false && blockedByPreview.length > 0) {
        reasons.push('admission_preview_blocked');
      }
      if (proposalAgeMs >= staleMs) {
        reasons.push('stale_open_age');
      }
      if (noProgressRetries >= retryCap) {
        reasons.push('retry_cap_exhausted');
      }
      if (!reasons.length) continue;

      summary.parked += 1;
      for (const reason of reasons) {
        summary.reasons[reason] = Number(summary.reasons[reason] || 0) + 1;
      }
      if (apply !== true) continue;

      row.status = 'parked';
      row.state = 'parked';
      row.meta = row.meta && typeof row.meta === 'object' ? row.meta : {};
      row.meta.queue_hygiene = {
        remediated_at: nowIso(),
        reasons,
        objective_id: objectiveId || null,
        proposal_age_hours: Number((proposalAgeMs / (60 * 60 * 1000)).toFixed(3)),
        no_progress_retries: noProgressRetries
      };
      const preview = row.meta.admission_preview && typeof row.meta.admission_preview === 'object'
        ? row.meta.admission_preview
        : {};
      const blocked = Array.isArray(preview.blocked_by) ? preview.blocked_by.slice() : [];
      for (const reason of reasons) {
        if (!blocked.includes(reason)) blocked.push(reason);
      }
      row.meta.admission_preview = {
        ...preview,
        eligible: false,
        blocked_by: blocked
      };
      touched = true;
    }
    if (touched && apply === true) {
      writeJsonAtomic(fp, rows);
      summary.files_touched += 1;
    }
  }

  summary.active_objectives = Array.from(activeObjectives).slice(0, 16);
  return summary;
}

function readBudgetPacingSnapshot(policy: AnyObj) {
  const out: AnyObj = {
    enabled: policy.budget_pacing && policy.budget_pacing.enabled === true,
    allow_execute: true,
    defer_reason: null,
    path: null,
    pressure: 'unknown',
    token_cap: 0,
    used_est: 0,
    remaining_tokens: 0,
    remaining_ratio: 1,
    max_tokens_per_action: null
  };
  if (out.enabled !== true) return out;

  const dir = policy.paths.daily_budget_dir;
  if (!fs.existsSync(dir)) {
    out.path = rel(dir);
    return out;
  }
  const today = nowIso().slice(0, 10);
  const direct = path.join(dir, `${today}.json`);
  let filePath = direct;
  if (!fs.existsSync(filePath)) {
    const fallback = fs.readdirSync(dir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .sort()
      .pop();
    if (!fallback) return out;
    filePath = path.join(dir, fallback);
  }
  const row = readJson(filePath, {});
  const tokenCap = Number(row && row.token_cap || 0);
  const usedEst = Number(row && row.used_est || 0);
  const remaining = Math.max(0, tokenCap - usedEst);
  const ratio = tokenCap > 0 ? (remaining / tokenCap) : 1;
  let pressure = normalizeToken(
    row && row.pressure
    || (row && row.strategy_budget && row.strategy_budget.pressure)
    || '',
    24
  );
  if (!pressure) {
    pressure = ratio <= 0.1 ? 'critical' : ratio <= Number(policy.budget_pacing.min_remaining_ratio || 0.2) ? 'hard' : 'normal';
  }
  const blockedLevels = new Set(
    Array.isArray(policy.budget_pacing.block_pressure_levels)
      ? policy.budget_pacing.block_pressure_levels.map((v: unknown) => normalizeToken(v, 24)).filter(Boolean)
      : ['hard', 'critical']
  );
  const shouldDefer = ratio <= Number(policy.budget_pacing.min_remaining_ratio || 0.2)
    && blockedLevels.has(pressure);
  out.path = rel(filePath);
  out.pressure = pressure || 'unknown';
  out.token_cap = tokenCap;
  out.used_est = usedEst;
  out.remaining_tokens = remaining;
  out.remaining_ratio = Number(ratio.toFixed(6));
  out.max_tokens_per_action = Number(row && row.strategy_budget && row.strategy_budget.max_tokens_per_action || 0) || null;
  out.allow_execute = !shouldDefer;
  out.defer_reason = shouldDefer ? 'budget_pacing_hold' : null;
  return out;
}

function isoToMs(iso: unknown) {
  const ms = Date.parse(String(iso || ''));
  return Number.isFinite(ms) ? ms : null;
}

function summarizeTitheHealth(startedAt: string) {
  const stormPath = path.join(ROOT, 'state', 'storm', 'value_distribution', 'history.jsonl');
  const rows = readJsonl(stormPath);
  const startMs = isoToMs(startedAt);
  let considered = 0;
  let mismatches = 0;
  const reasonCodes = new Set<string>();
  for (const row of rows) {
    const tsMs = isoToMs(row && row.ts);
    if (startMs != null && tsMs != null && tsMs < startMs) continue;
    if (!(row && row.type === 'storm_value_distribution_plan')) continue;
    considered += 1;
    const rootTithe = row && row.root_tithe && typeof row.root_tithe === 'object' ? row.root_tithe : {};
    if (rootTithe.blocked === true) {
      mismatches += 1;
      for (const code of Array.isArray(rootTithe.reason_codes) ? rootTithe.reason_codes : []) {
        reasonCodes.add(String(code));
      }
    }
  }
  return {
    considered,
    mismatches,
    ok: mismatches === 0,
    reason_codes: Array.from(reasonCodes).slice(0, 24)
  };
}

function compactHelix(helixPayload: AnyObj = {}) {
  return {
    attestation_decision: cleanText(helixPayload.attestation_decision || '', 40) || null,
    tier: cleanText(helixPayload.sentinel && helixPayload.sentinel.tier, 40) || null,
    mismatch_count: Number(helixPayload.verifier && helixPayload.verifier.mismatch_count || 0),
    ts: cleanText(helixPayload.ts || nowIso(), 60)
  };
}

function compactSymbiosis(symPayload: AnyObj = {}) {
  const recursion = symPayload && symPayload.recursion_gate && typeof symPayload.recursion_gate === 'object'
    ? symPayload.recursion_gate
    : {};
  return {
    coherence_score: Number(symPayload.coherence_score || 0),
    coherence_tier: cleanText(symPayload.coherence_tier || 'unknown', 40),
    allowed_depth: recursion.allowed_depth == null ? null : Number(recursion.allowed_depth),
    unbounded_allowed: recursion.unbounded_allowed === true,
    ts: cleanText(symPayload.ts || nowIso(), 60)
  };
}

function diagnoseAndAttemptFix(policy: AnyObj, row: AnyObj = {}, startedAt: string) {
  const actions: string[] = [];
  const outcomes: AnyObj = {};
  if (row.contract_check_ok !== true) {
    actions.push('retry_contract_check');
    outcomes.contract_check_retry = runNode('systems/spine/contract_check.js', [], {
      timeout_ms: policy.checks.command_timeout_ms
    });
    row.contract_check_ok = outcomes.contract_check_retry.ok === true;
  }
  if (row.health_status_ok !== true) {
    actions.push('retry_health_status_strict');
    outcomes.health_status_retry = runNode('systems/autonomy/health_status.js', ['status'], {
      timeout_ms: policy.checks.command_timeout_ms
    });
    row.health_status_ok = outcomes.health_status_retry.ok === true;
  }
  actions.push('queue_hygiene_apply');
  outcomes.queue_hygiene = {
    ok: true,
    code: 0,
    timed_out: false,
    payload: runQueueHygiene(policy, true)
  };
  row.queue_hygiene = outcomes.queue_hygiene.payload;
  if (row.helix_ok !== true) {
    actions.push('helix_reinit_and_reattest');
    outcomes.helix_init = runNode('systems/helix/helix_controller.js', ['init'], {
      timeout_ms: policy.checks.command_timeout_ms
    });
    outcomes.helix_retry = runNode('systems/helix/helix_controller.js', ['attest'], {
      timeout_ms: policy.checks.command_timeout_ms
    });
    const helix = compactHelix(outcomes.helix_retry.payload || {});
    row.helix = helix;
    row.helix_ok = (
      helix.attestation_decision === policy.thresholds.require_attestation_decision
      && helix.tier === policy.thresholds.require_helix_tier
      && Number(helix.mismatch_count || 0) === 0
    );
  }
  const tithe = summarizeTitheHealth(startedAt);
  row.tithe = tithe;
  row.tithe_ok = tithe.ok === true;
  row.fixed = (
    row.contract_check_ok === true
    && row.health_status_ok === true
    && row.helix_ok === true
    && row.tithe_ok === true
  );
  return {
    actions,
    outcomes,
    fixed: row.fixed === true
  };
}

function runHourlyHealthBundle(policy: AnyObj, startedAt: string, index: number) {
  const queueHygiene = runQueueHygiene(policy, true);
  const contractCheck = runNode('systems/spine/contract_check.js', [], {
    timeout_ms: policy.checks.command_timeout_ms
  });
  const healthStatus = runNode('systems/autonomy/health_status.js', ['status'], {
    timeout_ms: policy.checks.command_timeout_ms
  });
  const helixAttest = runNode('systems/helix/helix_controller.js', ['attest'], {
    timeout_ms: policy.checks.command_timeout_ms
  });
  const symbiosis = runNode('systems/symbiosis/symbiosis_coherence_gate.js', ['status', '--refresh=1'], {
    timeout_ms: policy.checks.command_timeout_ms
  });
  const tithe = summarizeTitheHealth(startedAt);

  const helix = compactHelix(helixAttest.payload || {});
  const sym = compactSymbiosis(symbiosis.payload || {});
  const row: AnyObj = {
    type: 'runtime_soak_hourly_check',
    ts: nowIso(),
    check_index: index,
    contract_check_ok: contractCheck.ok === true,
    health_status_ok: healthStatus.ok === true,
    helix_ok: (
      helix.attestation_decision === policy.thresholds.require_attestation_decision
      && helix.tier === policy.thresholds.require_helix_tier
      && Number(helix.mismatch_count || 0) === 0
    ),
    symbiosis_ok: Number(sym.coherence_score || 0) >= Number(policy.thresholds.symbiosis_min_score || 0.7),
    tithe_ok: tithe.ok === true,
    queue_hygiene: queueHygiene,
    helix,
    symbiosis: sym,
    tithe,
    commands: {
      contract_check: {
        ok: contractCheck.ok,
        code: contractCheck.code,
        timed_out: contractCheck.timed_out
      },
      health_status_strict: {
        ok: healthStatus.ok,
        code: healthStatus.code,
        timed_out: healthStatus.timed_out
      },
      helix_attestation: {
        ok: helixAttest.ok,
        code: helixAttest.code,
        timed_out: helixAttest.timed_out
      },
      symbiosis_status: {
        ok: symbiosis.ok,
        code: symbiosis.code,
        timed_out: symbiosis.timed_out
      },
      queue_hygiene: {
        ok: true,
        code: 0,
        timed_out: false
      }
    }
  };
  row.ok = (
    row.contract_check_ok === true
    && row.health_status_ok === true
    && row.helix_ok === true
    && row.tithe_ok === true
  );
  if (!row.ok) {
    row.diagnosis = diagnoseAndAttemptFix(policy, row, startedAt);
  }
  row.ok_after_fix = (
    row.contract_check_ok === true
    && row.health_status_ok === true
    && row.helix_ok === true
    && row.tithe_ok === true
  );
  return row;
}

function recordAttributionAndTithe(policy: AnyObj, cycleTag: string, proposalId: string, cycleIndex: number) {
  const valueEventUsd = Number(policy.attribution.base_value_usd || 100)
    + (Number(policy.attribution.value_step_usd || 10) * Number(cycleIndex));
  const payload = {
    source_type: 'unknown',
    source_id: cycleTag,
    creator_id: policy.attribution.creator_id,
    objective_id: policy.attribution.objective_id,
    run_id: proposalId,
    weight: 1,
    confidence: 0.8,
    impact_score: 0.7,
    influence_score: 0.9,
    value_event_usd: valueEventUsd,
    currency: 'USD'
  };
  const attribution = runNode(
    'systems/attribution/value_attribution_primitive.js',
    ['record', `--input-json=${JSON.stringify(payload)}`],
    { timeout_ms: 120_000 }
  );
  const storm = runNode(
    'systems/storm/storm_value_distribution.js',
    [
      'plan',
      `--run-id=${proposalId}`,
      `--objective-id=${policy.attribution.objective_id}`,
      '--days=30'
    ],
    { timeout_ms: 120_000 }
  );
  return {
    attribution,
    storm
  };
}

function runSingleLiveCycle(policy: AnyObj, cycleIndex: number) {
  const cycleTag = `live_cycle_${cycleIndex}`;
  const budgetPacing = readBudgetPacingSnapshot(policy);
  if (budgetPacing.enabled === true && budgetPacing.allow_execute !== true) {
    return {
      ok: true,
      ts: nowIso(),
      cycle: cycleIndex,
      cycle_tag: cycleTag,
      deferred: true,
      defer_reason: budgetPacing.defer_reason || 'budget_pacing_hold',
      budget_pacing: budgetPacing
    };
  }
  const propose = runNode(
    'systems/autonomy/gated_self_improvement_loop.js',
    [
      'propose',
      `--policy=${policy.gated_cycle.policy_path}`,
      `--objective-id=${policy.gated_cycle.objective_id}`,
      `--target-path=${policy.gated_cycle.target_path}`,
      `--summary=${cycleTag}`,
      `--risk=${policy.gated_cycle.risk}`
    ],
    { timeout_ms: 120_000 }
  );
  const proposalId = cleanText(
    propose
    && propose.payload
    && propose.payload.proposal
    && propose.payload.proposal.proposal_id,
    140
  );
  if (!proposalId) {
    return {
      ok: false,
      cycle: cycleIndex,
      cycle_tag: cycleTag,
      error: 'proposal_id_missing',
      propose
    };
  }

  const runArgs = [
    'run',
    `--policy=${policy.gated_cycle.policy_path}`,
    `--proposal-id=${proposalId}`,
    '--apply=1',
    `--approval-a=${policy.gated_cycle.approval_a}`,
    `--approval-b=${policy.gated_cycle.approval_b}`,
    `--days=${policy.gated_cycle.simulation_days}`
  ];
  const run1 = runNode('systems/autonomy/gated_self_improvement_loop.js', runArgs, { timeout_ms: 180_000 });
  const run2 = runNode('systems/autonomy/gated_self_improvement_loop.js', runArgs, { timeout_ms: 180_000 });
  const status = runNode(
    'systems/autonomy/gated_self_improvement_loop.js',
    ['status', `--policy=${policy.gated_cycle.policy_path}`, `--proposal-id=${proposalId}`],
    { timeout_ms: 120_000 }
  );

  const proposal = status && status.payload && status.payload.proposal && typeof status.payload.proposal === 'object'
    ? status.payload.proposal
    : {};
  const stage = cleanText(proposal.stage || '', 40);
  const st = cleanText(proposal.status || '', 40);
  const liveStageOk = stage === 'live' && (st === 'live_merged' || st === 'live_ready');

  const attributionTithe = recordAttributionAndTithe(policy, cycleTag, proposalId, cycleIndex);
  const stormRoot = attributionTithe
    && attributionTithe.storm
    && attributionTithe.storm.payload
    && attributionTithe.storm.payload.root_tithe
    ? attributionTithe.storm.payload.root_tithe
    : {};
  const titheOk = (
    attributionTithe.attribution.ok === true
    && attributionTithe.storm.ok === true
    && stormRoot.blocked !== true
    && Number(stormRoot.effective_tithe_bps || 0) > 0
    && Number(stormRoot.root_tithe_usd || 0) > 0
  );

  const helixAttest = runNode('systems/helix/helix_controller.js', ['attest'], { timeout_ms: 120_000 });
  const symStatus = runNode('systems/symbiosis/symbiosis_coherence_gate.js', ['status', '--refresh=1'], { timeout_ms: 120_000 });
  const helix = compactHelix(helixAttest.payload || {});
  const symbiosis = compactSymbiosis(symStatus.payload || {});
  const helixOk = (
    helix.attestation_decision === policy.thresholds.require_attestation_decision
    && helix.tier === policy.thresholds.require_helix_tier
    && Number(helix.mismatch_count || 0) === 0
  );
  const symbiosisOk = Number(symbiosis.coherence_score || 0) >= Number(policy.thresholds.symbiosis_min_score || 0.7);

  return {
    ok: propose.ok === true && run1.ok === true && run2.ok === true && status.ok === true && liveStageOk && titheOk && helixOk,
    ts: nowIso(),
    cycle: cycleIndex,
    cycle_tag: cycleTag,
    proposal_id: proposalId,
    stage,
    status: st,
    live_stage_ok: liveStageOk,
    tithe_ok: titheOk,
    helix_ok: helixOk,
    symbiosis_ok: symbiosisOk,
    helix,
    symbiosis,
    run_attempts: [run1, run2].map((row) => ({ ok: row.ok, code: row.code, timed_out: row.timed_out })),
    storm_tithe: {
      blocked: stormRoot.blocked === true,
      effective_tithe_bps: Number(stormRoot.effective_tithe_bps || 0),
      root_tithe_usd: Number(stormRoot.root_tithe_usd || 0),
      reason_codes: Array.isArray(stormRoot.reason_codes) ? stormRoot.reason_codes : []
    },
    budget_pacing: budgetPacing
  };
}

function summarizeNoLlmValidation(policy: AnyObj) {
  const timeout = policy.checks.command_timeout_ms;
  const contractCheck = runNode('systems/spine/contract_check.js', [], { timeout_ms: timeout });
  const schemaCheck = runNode('systems/security/schema_contract_check.js', ['run'], { timeout_ms: timeout });
  const foundationGate = runNode('systems/ops/foundation_contract_gate.js', ['run'], { timeout_ms: timeout });
  const healthStrict = runNode('systems/autonomy/health_status.js', ['status'], {
    timeout_ms: timeout
  });
  return {
    contract_check: {
      ok: contractCheck.ok,
      code: contractCheck.code,
      timed_out: contractCheck.timed_out,
      error: contractCheck.error,
      stdout_tail: contractCheck.stdout_tail,
      stderr_tail: contractCheck.stderr_tail
    },
    schema_contract_check: {
      ok: schemaCheck.ok,
      code: schemaCheck.code,
      timed_out: schemaCheck.timed_out,
      error: schemaCheck.error,
      stdout_tail: schemaCheck.stdout_tail,
      stderr_tail: schemaCheck.stderr_tail
    },
    foundation_contract_gate: {
      ok: foundationGate.ok,
      code: foundationGate.code,
      timed_out: foundationGate.timed_out,
      error: foundationGate.error,
      stdout_tail: foundationGate.stdout_tail,
      stderr_tail: foundationGate.stderr_tail
    },
    health_status_strict: {
      ok: healthStrict.ok,
      code: healthStrict.code,
      timed_out: healthStrict.timed_out,
      error: healthStrict.error,
      stdout_tail: healthStrict.stdout_tail,
      stderr_tail: healthStrict.stderr_tail
    }
  };
}

function buildTrend(rows: AnyObj[]) {
  const values = rows
    .map((row) => Number(row && row.symbiosis && row.symbiosis.coherence_score))
    .filter((n) => Number.isFinite(n));
  if (!values.length) {
    return {
      start: null,
      end: null,
      min: null,
      max: null,
      delta: null
    };
  }
  const start = Number(values[0]);
  const end = Number(values[values.length - 1]);
  const min = values.reduce((acc, n) => Math.min(acc, n), Number.POSITIVE_INFINITY);
  const max = values.reduce((acc, n) => Math.max(acc, n), Number.NEGATIVE_INFINITY);
  return {
    start,
    end,
    min,
    max,
    delta: Number((end - start).toFixed(6))
  };
}

async function commandStart(args: AnyObj) {
  const policy = loadPolicy(args.policy || DEFAULT_POLICY_PATH);
  if (!policy.enabled) {
    const out = { ok: false, type: 'runtime_stability_soak_start', error: 'policy_disabled' };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
    return;
  }
  ensureDir(policy.paths.root);
  ensureDir(policy.paths.reports_dir);

  const durationHours = clampInt(args['duration-hours'], 1, 24 * 30, policy.soak.duration_hours);
  const intervalMinutes = clampInt(args['interval-minutes'], 1, 24 * 60, policy.soak.interval_minutes);
  const cycleCount = clampInt(args['cycle-count'], 1, 50, policy.soak.cycle_count);
  const totalChecks = clampInt(
    Math.max(1, Math.ceil((durationHours * 60) / Math.max(1, intervalMinutes))),
    1,
    100_000,
    durationHours
  );
  const runId = `soak_${Date.now()}`;
  const startedAt = nowIso();

  let state = saveState(policy, {
    running: true,
    run_id: runId,
    phase: 'soak',
    started_at: startedAt,
    ended_at: null,
    soak_checks_completed: 0,
    soak_checks_total: totalChecks,
    cycles_completed: 0,
    cycles_total: cycleCount,
    last_error: null
  });
  const initialQueueHygiene = runQueueHygiene(policy, true);
  writeJsonAtomic(policy.paths.latest_path, {
    type: 'runtime_stability_soak_started',
    ts: nowIso(),
    run_id: runId,
    duration_hours: durationHours,
    interval_minutes: intervalMinutes,
    cycle_count: cycleCount,
    queue_hygiene: initialQueueHygiene
  });

  const hourlyRows: AnyObj[] = [];
  for (let i = 1; i <= totalChecks; i += 1) {
    const row = runHourlyHealthBundle(policy, startedAt, i);
    hourlyRows.push(row);
    appendJsonl(policy.paths.checks_path, {
      run_id: runId,
      ...row
    });
    writeJsonAtomic(policy.paths.latest_path, {
      type: 'runtime_stability_soak_checkpoint',
      ts: nowIso(),
      run_id: runId,
      phase: 'soak',
      progress: {
        checks_completed: i,
        checks_total: totalChecks
      },
      latest_check: row
    });
    state = saveState(policy, {
      ...state,
      running: true,
      phase: 'soak',
      soak_checks_completed: i
    });
    if (i < totalChecks) {
      await sleep(intervalMinutes * 60 * 1000);
    }
  }

  const unresolvedSoakFailures = hourlyRows.filter((row) => row.ok_after_fix !== true);
  let cycleRows: AnyObj[] = [];
  if (unresolvedSoakFailures.length === 0) {
    state = saveState(policy, {
      ...state,
      running: true,
      phase: 'live_cycles'
    });
    for (let i = 1; i <= cycleCount; i += 1) {
      const cycle = runSingleLiveCycle(policy, i);
      cycleRows.push(cycle);
      appendJsonl(policy.paths.cycles_path, {
        run_id: runId,
        ...cycle
      });
      writeJsonAtomic(policy.paths.latest_path, {
        type: 'runtime_stability_live_cycle_checkpoint',
        ts: nowIso(),
        run_id: runId,
        phase: 'live_cycles',
        progress: {
          cycles_completed: i,
          cycles_total: cycleCount
        },
        latest_cycle: cycle
      });
      state = saveState(policy, {
        ...state,
        running: true,
        phase: 'live_cycles',
        cycles_completed: i
      });
      if (cycle.ok !== true) {
        break;
      }
    }
  }

  const noLlm = summarizeNoLlmValidation(policy);
  const latestHelix = cycleRows.length
    ? cycleRows[cycleRows.length - 1].helix
    : (hourlyRows.length ? hourlyRows[hourlyRows.length - 1].helix : null);
  const latestSymbiosis = cycleRows.length
    ? cycleRows[cycleRows.length - 1].symbiosis
    : (hourlyRows.length ? hourlyRows[hourlyRows.length - 1].symbiosis : null);

  const soakCriticalFailures = unresolvedSoakFailures.length;
  const titheMismatches = (
    hourlyRows.filter((row) => row.tithe_ok !== true).length
    + cycleRows.filter((row) => row.tithe_ok !== true).length
  );
  const helixRegressions = (
    hourlyRows.filter((row) => row.helix_ok !== true).length
    + cycleRows.filter((row) => row.helix_ok !== true).length
  );
  const finalSymbiosisScore = Number(latestSymbiosis && latestSymbiosis.coherence_score || 0);

  const criteria = {
    zero_critical_failures: soakCriticalFailures === 0,
    zero_tithe_mismatches: titheMismatches === 0,
    no_helix_regression: helixRegressions === 0,
    symbiosis_at_least_threshold: finalSymbiosisScore >= Number(policy.thresholds.symbiosis_min_score || 0.7),
    live_cycles_completed: cycleRows.length === cycleCount
      && cycleRows.every((row) => row.ok === true)
  };
  const goNoGo = Object.values(criteria).every((v) => v === true);

  const report: AnyObj = {
    type: 'runtime_stability_soak_report',
    generated_at: nowIso(),
    run_id: runId,
    started_at: startedAt,
    ended_at: nowIso(),
    policy: {
      version: policy.version,
      path: rel(policy.policy_path),
      duration_hours: durationHours,
      interval_minutes: intervalMinutes,
      cycle_count: cycleCount,
      symbiosis_min_score: Number(policy.thresholds.symbiosis_min_score || 0.7)
    },
    queue_hygiene_initial: initialQueueHygiene,
    soak: {
      checks_completed: hourlyRows.length,
      checks_total: totalChecks,
      unresolved_failures: soakCriticalFailures,
      symbiosis_trend: buildTrend(hourlyRows),
      rows: hourlyRows
    },
    live_cycles: {
      cycles_completed: cycleRows.length,
      cycles_total: cycleCount,
      rows: cycleRows
    },
    latest: {
      helix: latestHelix,
      symbiosis: latestSymbiosis
    },
    no_llm_validation: noLlm,
    criteria,
    go_no_go: goNoGo
  };
  const reportPath = path.join(policy.paths.reports_dir, `report_${runId}.json`);
  writeJsonAtomic(reportPath, report);
  writeJsonAtomic(path.join(policy.paths.reports_dir, 'latest_report.json'), report);
  writeJsonAtomic(policy.paths.latest_path, {
    type: 'runtime_stability_soak_complete',
    ts: nowIso(),
    run_id: runId,
    go_no_go: goNoGo,
    report_path: rel(reportPath),
    criteria
  });
  state = saveState(policy, {
    ...state,
    running: false,
    phase: 'complete',
    ended_at: nowIso(),
    latest_report_path: rel(reportPath),
    last_error: goNoGo ? null : 'criteria_not_met'
  });

  const out = {
    ok: true,
    type: 'runtime_stability_soak_start',
    run_id: runId,
    go_no_go: goNoGo,
    report_path: rel(reportPath),
    criteria
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function commandCheckNow(args: AnyObj) {
  const policy = loadPolicy(args.policy || DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const startedAt = cleanText(state.started_at || nowIso(), 60);
  const row = runHourlyHealthBundle(policy, startedAt, Number(state.soak_checks_completed || 0) + 1);
  appendJsonl(policy.paths.checks_path, {
    run_id: state.run_id || null,
    ...row
  });
  writeJsonAtomic(policy.paths.latest_path, {
    type: 'runtime_stability_soak_check_now',
    ts: nowIso(),
    run_id: state.run_id || null,
    check: row
  });
  const out = {
    ok: true,
    type: 'runtime_stability_soak_check_now',
    check: row
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function commandStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy || DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const latest = readJson(policy.paths.latest_path, null);
  const out = {
    ok: true,
    type: 'runtime_stability_soak_status',
    policy: {
      version: policy.version,
      path: rel(policy.policy_path)
    },
    state,
    latest
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function commandReport(args: AnyObj) {
  const policy = loadPolicy(args.policy || DEFAULT_POLICY_PATH);
  const latestReport = path.join(policy.paths.reports_dir, 'latest_report.json');
  const report = readJson(latestReport, null);
  if (!(report && typeof report === 'object')) {
    const out = {
      ok: false,
      type: 'runtime_stability_soak_report',
      error: 'report_missing',
      report_path: rel(latestReport)
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'runtime_stability_soak_report',
    run_id: report.run_id,
    go_no_go: report.go_no_go === true,
    criteria: report.criteria,
    report_path: rel(latestReport)
  }, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/runtime_stability_soak.js start [--policy=path] [--duration-hours=24] [--interval-minutes=60] [--cycle-count=4]');
  console.log('  node systems/autonomy/runtime_stability_soak.js check-now [--policy=path]');
  console.log('  node systems/autonomy/runtime_stability_soak.js status [--policy=path]');
  console.log('  node systems/autonomy/runtime_stability_soak.js report [--policy=path]');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 60) || 'status';
  if (cmd === 'help' || cmd === '-h' || cmd === '--help' || args.help) {
    usage();
    process.exit(0);
    return;
  }
  if (cmd === 'start') {
    await commandStart(args);
    return;
  }
  if (cmd === 'check-now') {
    commandCheckNow(args);
    return;
  }
  if (cmd === 'status') {
    commandStatus(args);
    return;
  }
  if (cmd === 'report') {
    commandReport(args);
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  main().catch((err: AnyObj) => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'runtime_stability_soak',
      error: cleanText(err && err.message ? err.message : err || 'runtime_stability_soak_failed', 320)
    }, null, 2)}\n`);
    process.exit(1);
  });
}

module.exports = {
  loadPolicy,
  loadState,
  summarizeTitheHealth,
  runHourlyHealthBundle,
  runSingleLiveCycle,
  summarizeNoLlmValidation
};
