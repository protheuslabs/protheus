#!/usr/bin/env node
'use strict';
export {};

/**
 * RM-123: narrow-agent parity benchmark harness.
 *
 * Produces standardized scorecards comparing Protheus against baseline
 * narrow-agent patterns across reliability, latency, and cost pressure.
 *
 * Usage:
 *   node systems/ops/narrow_agent_parity_harness.js run [YYYY-MM-DD] [--strict=1|0] [--days=N]
 *   node systems/ops/narrow_agent_parity_harness.js status [latest|YYYY-MM-DD]
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.NARROW_AGENT_PARITY_POLICY_PATH
  ? path.resolve(String(process.env.NARROW_AGENT_PARITY_POLICY_PATH))
  : path.join(ROOT, 'config', 'narrow_agent_parity_harness_policy.json');
const DEFAULT_STATE_PATH = process.env.NARROW_AGENT_PARITY_STATE_PATH
  ? path.resolve(String(process.env.NARROW_AGENT_PARITY_STATE_PATH))
  : path.join(ROOT, 'state', 'ops', 'narrow_agent_parity_harness.json');
const DEFAULT_HISTORY_PATH = process.env.NARROW_AGENT_PARITY_HISTORY_PATH
  ? path.resolve(String(process.env.NARROW_AGENT_PARITY_HISTORY_PATH))
  : path.join(ROOT, 'state', 'ops', 'narrow_agent_parity_harness_history.jsonl');

function nowIso() {
  return new Date().toISOString();
}

function todayUtc() {
  return nowIso().slice(0, 10);
}

function toDate(raw: unknown) {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return todayUtc();
}

function addUtcDays(dateStr: string, deltaDays: number) {
  const ts = Date.parse(`${String(dateStr)}T00:00:00.000Z`);
  if (!Number.isFinite(ts)) return todayUtc();
  return new Date(ts + (deltaDays * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function mondayUtc(dateStr: string) {
  const ts = Date.parse(`${String(dateStr)}T00:00:00.000Z`);
  if (!Number.isFinite(ts)) return dateStr;
  const d = new Date(ts);
  const dow = d.getUTCDay();
  const delta = dow === 0 ? -6 : (1 - dow);
  return addUtcDays(dateStr, delta);
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    const raw = String(tok || '');
    if (!raw.startsWith('--')) {
      out._.push(raw);
      continue;
    }
    const idx = raw.indexOf('=');
    if (idx === -1) {
      out[raw.slice(2)] = true;
      continue;
    }
    out[raw.slice(2, idx)] = raw.slice(idx + 1);
  }
  return out;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
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

function clampNum(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
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
    const out = [];
    const lines = String(fs.readFileSync(filePath, 'utf8') || '').split('\n');
    for (const line of lines) {
      const trimmed = String(line || '').trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed);
        if (row && typeof row === 'object') out.push(row);
      } catch {
        // Ignore malformed lines.
      }
    }
    return out;
  } catch {
    return [];
  }
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
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

function trimHistory(historyPath: string, maxRows: number) {
  if (!fs.existsSync(historyPath)) return;
  const lines = String(fs.readFileSync(historyPath, 'utf8') || '')
    .split('\n')
    .filter(Boolean);
  if (lines.length <= maxRows) return;
  fs.writeFileSync(historyPath, `${lines.slice(lines.length - maxRows).join('\n')}\n`, 'utf8');
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function dateDistanceDaysUtc(olderDate: string, newerDate: string) {
  const t0 = Date.parse(`${String(olderDate)}T00:00:00.000Z`);
  const t1 = Date.parse(`${String(newerDate)}T00:00:00.000Z`);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  return Math.floor((t1 - t0) / (24 * 60 * 60 * 1000));
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(value) ? path.resolve(value) : path.join(ROOT, value);
}

function numOr(v: unknown, fallback: number | null = null) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function ratioOr(numerator: unknown, denominator: unknown, fallback: number) {
  const n = Number(numerator);
  const d = Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return fallback;
  return n / d;
}

function defaultPolicy() {
  return {
    version: '1.0',
    strict_default: false,
    baseline_profile: 'narrow-agent-v1',
    window_days: 7,
    min_live_runs: 5,
    max_history_rows: 520,
    aggregate_gates: {
      min_scenarios_passed: 2,
      min_pass_ratio: 0.66,
      min_weighted_score: 0.85
    },
    scenarios: [
      {
        id: 'governed_execution',
        name: 'Governed execution lane',
        metrics: {
          reliability: 'execution_success_rate',
          latency_ms: 'execution_latency_ms',
          cost_pressure: 'budget_used_ratio_avg'
        },
        baselines: {
          reliability_min: 0.97,
          latency_ms_max: 120000,
          cost_pressure_max: 0.95
        },
        weights: {
          reliability: 0.5,
          latency: 0.3,
          cost: 0.2
        }
      },
      {
        id: 'startup_responsiveness',
        name: 'Startup responsiveness lane',
        metrics: {
          reliability: 'runtime_pass_ratio',
          latency_ms: 'boot_latency_ms',
          cost_pressure: 'budget_used_ratio_avg'
        },
        baselines: {
          reliability_min: 0.95,
          latency_ms_max: 800,
          cost_pressure_max: 0.98
        },
        weights: {
          reliability: 0.3,
          latency: 0.5,
          cost: 0.2
        }
      },
      {
        id: 'sustained_autonomy',
        name: 'Sustained autonomy lane',
        metrics: {
          reliability: 'closure_pass_ratio',
          latency_ms: 'blended_latency_ms',
          cost_pressure: 'budget_autopause_deny_ratio'
        },
        baselines: {
          reliability_min: 0.9,
          latency_ms_max: 60000,
          cost_pressure_max: 0.35
        },
        weights: {
          reliability: 0.45,
          latency: 0.2,
          cost: 0.35
        }
      }
    ],
    sources: {
      execution_reliability_slo_path: 'state/ops/execution_reliability_slo.json',
      runtime_efficiency_floor_path: 'state/ops/runtime_efficiency_floor.json',
      workflow_execution_closure_path: 'state/ops/workflow_execution_closure.json',
      daily_budget_dir: 'state/autonomy/daily_budget',
      budget_events_path: 'state/autonomy/budget_events.jsonl'
    },
    state_path: 'state/ops/narrow_agent_parity_harness.json',
    history_path: 'state/ops/narrow_agent_parity_harness_history.jsonl',
    weekly_receipts_dir: 'state/ops/parity_scorecards'
  };
}

function normalizeScenario(raw: AnyObj, index: number) {
  const id = String(raw && raw.id || '').trim() || `scenario_${index + 1}`;
  const name = String(raw && raw.name || id).trim();
  const metrics = raw && raw.metrics && typeof raw.metrics === 'object'
    ? raw.metrics
    : {};
  const baselines = raw && raw.baselines && typeof raw.baselines === 'object'
    ? raw.baselines
    : {};
  const weights = raw && raw.weights && typeof raw.weights === 'object'
    ? raw.weights
    : {};
  return {
    id,
    name,
    metrics: {
      reliability: String(metrics.reliability || 'composite_reliability'),
      latency_ms: String(metrics.latency_ms || 'blended_latency_ms'),
      cost_pressure: String(metrics.cost_pressure || 'cost_pressure')
    },
    baselines: {
      reliability_min: clampNum(baselines.reliability_min, 0, 1, 0.95),
      latency_ms_max: clampNum(baselines.latency_ms_max, 1, 24 * 60 * 60 * 1000, 120000),
      cost_pressure_max: clampNum(baselines.cost_pressure_max, 0.01, 10, 1)
    },
    weights: {
      reliability: clampNum(weights.reliability, 0, 1000, 0.4),
      latency: clampNum(weights.latency, 0, 1000, 0.3),
      cost: clampNum(weights.cost, 0, 1000, 0.3)
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const scenariosRaw = Array.isArray(raw && raw.scenarios) ? raw.scenarios : base.scenarios;
  const sourcesRaw = raw && raw.sources && typeof raw.sources === 'object'
    ? raw.sources
    : {};
  const gatesRaw = raw && raw.aggregate_gates && typeof raw.aggregate_gates === 'object'
    ? raw.aggregate_gates
    : {};
  return {
    version: String(raw && raw.version || base.version),
    strict_default: toBool(raw && raw.strict_default, base.strict_default),
    baseline_profile: String(raw && raw.baseline_profile || base.baseline_profile),
    window_days: clampInt(raw && raw.window_days, 1, 90, base.window_days),
    min_live_runs: clampInt(raw && raw.min_live_runs, 1, 200, base.min_live_runs),
    max_history_rows: clampInt(raw && raw.max_history_rows, 50, 5000, base.max_history_rows),
    aggregate_gates: {
      min_scenarios_passed: clampInt(
        gatesRaw.min_scenarios_passed,
        1,
        50,
        base.aggregate_gates.min_scenarios_passed
      ),
      min_pass_ratio: clampNum(gatesRaw.min_pass_ratio, 0, 1, base.aggregate_gates.min_pass_ratio),
      min_weighted_score: clampNum(
        gatesRaw.min_weighted_score,
        0,
        2,
        base.aggregate_gates.min_weighted_score
      )
    },
    scenarios: scenariosRaw.map((row: AnyObj, idx: number) => normalizeScenario(row, idx)),
    sources: {
      execution_reliability_slo_path: resolvePath(
        sourcesRaw.execution_reliability_slo_path,
        base.sources.execution_reliability_slo_path
      ),
      runtime_efficiency_floor_path: resolvePath(
        sourcesRaw.runtime_efficiency_floor_path,
        base.sources.runtime_efficiency_floor_path
      ),
      workflow_execution_closure_path: resolvePath(
        sourcesRaw.workflow_execution_closure_path,
        base.sources.workflow_execution_closure_path
      ),
      daily_budget_dir: resolvePath(
        sourcesRaw.daily_budget_dir,
        base.sources.daily_budget_dir
      ),
      budget_events_path: resolvePath(
        sourcesRaw.budget_events_path,
        base.sources.budget_events_path
      )
    },
    state_path: resolvePath(raw && raw.state_path, base.state_path),
    history_path: resolvePath(raw && raw.history_path, base.history_path),
    weekly_receipts_dir: resolvePath(raw && raw.weekly_receipts_dir, base.weekly_receipts_dir)
  };
}

function collectBudgetWindow(dailyBudgetDir: string, date: string, windowDays: number) {
  const rows: AnyObj[] = [];
  for (let i = 0; i < windowDays; i += 1) {
    const day = addUtcDays(date, -i);
    const filePath = path.join(dailyBudgetDir, `${day}.json`);
    if (!fs.existsSync(filePath)) continue;
    const payload = readJson(filePath, null);
    if (!payload || typeof payload !== 'object') continue;
    const usedEst = numOr(payload.used_est, null);
    const tokenCap = numOr(payload.token_cap, null);
    const usedRatio = usedEst != null && tokenCap != null && tokenCap > 0
      ? usedEst / tokenCap
      : null;
    rows.push({
      date: day,
      path: filePath,
      used_est: usedEst,
      token_cap: tokenCap,
      used_ratio: usedRatio
    });
  }
  const ratios = rows
    .map((row) => numOr(row.used_ratio, null))
    .filter((v) => v != null) as number[];
  const avgUsedRatio = ratios.length > 0
    ? ratios.reduce((sum, n) => sum + n, 0) / ratios.length
    : null;
  const maxUsedRatio = ratios.length > 0
    ? Math.max(...ratios)
    : null;
  return {
    rows,
    samples: ratios.length,
    avg_used_ratio: avgUsedRatio,
    max_used_ratio: maxUsedRatio
  };
}

function collectBudgetEvents(budgetEventsPath: string, date: string, windowDays: number) {
  const rows = readJsonl(budgetEventsPath);
  const windowStart = addUtcDays(date, -(windowDays - 1));
  let totalDecisions = 0;
  let denies = 0;
  let autopauseDenies = 0;
  for (const row of rows) {
    const rowDate = toDate(row && row.date);
    if (dateDistanceDaysUtc(windowStart, rowDate) == null || dateDistanceDaysUtc(windowStart, rowDate)! < 0) continue;
    if (dateDistanceDaysUtc(rowDate, date) == null || dateDistanceDaysUtc(rowDate, date)! < 0) continue;
    const decision = String(row && row.decision || '').trim().toLowerCase();
    if (!decision) continue;
    totalDecisions += 1;
    if (decision === 'deny') {
      denies += 1;
      const reason = String(row && row.reason || '').trim().toLowerCase();
      if (reason.includes('autopause') || reason.includes('burn_rate')) {
        autopauseDenies += 1;
      }
    }
  }
  return {
    total_decisions: totalDecisions,
    deny_count: denies,
    autopause_deny_count: autopauseDenies,
    deny_ratio: ratioOr(denies, totalDecisions, 0),
    autopause_deny_ratio: ratioOr(autopauseDenies, totalDecisions, 0)
  };
}

function collectClosureMetrics(closure: AnyObj, date: string, windowDays: number) {
  const rows = Array.isArray(closure && closure.evidence && closure.evidence.rows)
    ? closure.evidence.rows
    : [];
  const windowStart = addUtcDays(date, -(windowDays - 1));
  let totalDays = 0;
  let passDays = 0;
  for (const row of rows) {
    const rowDate = toDate(row && row.date);
    const ds = dateDistanceDaysUtc(windowStart, rowDate);
    const de = dateDistanceDaysUtc(rowDate, date);
    if (ds == null || de == null || ds < 0 || de < 0) continue;
    totalDays += 1;
    if (row && row.pass === true) passDays += 1;
  }
  return {
    rows_considered: totalDays,
    pass_days: passDays,
    pass_ratio: ratioOr(passDays, totalDays, 0),
    latest_day_pass: !!(closure && closure.latest_day && closure.latest_day.pass === true)
  };
}

function deriveMetrics(policy: AnyObj, date: string, windowDays: number) {
  const execution = readJson(policy.sources.execution_reliability_slo_path, {});
  const runtime = readJson(policy.sources.runtime_efficiency_floor_path, {});
  const closure = readJson(policy.sources.workflow_execution_closure_path, {});
  const budgetWindow = collectBudgetWindow(policy.sources.daily_budget_dir, date, windowDays);
  const budgetEvents = collectBudgetEvents(policy.sources.budget_events_path, date, windowDays);
  const closureMetrics = collectClosureMetrics(closure, date, windowDays);

  const executionSuccess = clampNum(
    numOr(execution && execution.measured && execution.measured.execution_success_rate, 0),
    0,
    1,
    0
  );
  const queueDrain = clampNum(
    numOr(execution && execution.measured && execution.measured.queue_drain_rate, 0),
    0,
    1,
    0
  );
  const executionLatencyMs = numOr(
    execution && execution.measured && execution.measured.time_to_first_execution_p95_ms,
    null
  );
  const bootLatencyMs = numOr(
    runtime && runtime.metrics && runtime.metrics.cold_start_p95_ms,
    null
  );
  const blendedLatencyMs = executionLatencyMs != null && bootLatencyMs != null
    ? Number((executionLatencyMs * 0.7) + (bootLatencyMs * 0.3))
    : (executionLatencyMs != null ? executionLatencyMs : (bootLatencyMs != null ? bootLatencyMs : null));

  const runtimePassRatio = runtime && runtime.pass === true ? 1 : 0;
  const liveRuns = clampInt(execution && execution.live_runs, 0, 100000, 0);
  const sufficientData = !!(execution && execution.checks && execution.checks.sufficient_data === true)
    && liveRuns >= policy.min_live_runs;
  const reliabilityBase = (executionSuccess * 0.6) + (closureMetrics.pass_ratio * 0.25) + (runtimePassRatio * 0.15);
  const compositeReliability = clampNum(
    reliabilityBase * (sufficientData ? 1 : 0.85) * (closureMetrics.latest_day_pass ? 1 : 0.95),
    0,
    1,
    0
  );

  const budgetUsedRatioAvg = budgetWindow.avg_used_ratio == null
    ? 1
    : Number(budgetWindow.avg_used_ratio);
  const budgetUsedRatioMax = budgetWindow.max_used_ratio == null
    ? budgetUsedRatioAvg
    : Number(budgetWindow.max_used_ratio);
  const budgetAutopauseDenyRatio = Number(budgetEvents.autopause_deny_ratio || 0);
  const costPressure = clampNum(
    (budgetUsedRatioAvg * 0.8) + (budgetAutopauseDenyRatio * 0.2),
    0,
    5,
    1
  );

  const metricCatalog = {
    execution_success_rate: executionSuccess,
    queue_drain_rate: queueDrain,
    runtime_pass_ratio: runtimePassRatio,
    closure_pass_ratio: clampNum(closureMetrics.pass_ratio, 0, 1, 0),
    composite_reliability: compositeReliability,
    execution_latency_ms: executionLatencyMs,
    boot_latency_ms: bootLatencyMs,
    blended_latency_ms: blendedLatencyMs,
    budget_used_ratio_avg: budgetUsedRatioAvg,
    budget_used_ratio_max: budgetUsedRatioMax,
    budget_autopause_deny_ratio: budgetAutopauseDenyRatio,
    cost_pressure: costPressure
  };

  return {
    metric_catalog: metricCatalog,
    dimensions: {
      reliability: compositeReliability,
      latency_ms: blendedLatencyMs,
      cost_pressure: costPressure
    },
    source_summary: {
      execution_reliability: {
        live_runs: liveRuns,
        sufficient_data: sufficientData,
        pass: execution && execution.pass === true
      },
      runtime_efficiency: {
        pass: runtime && runtime.pass === true
      },
      workflow_closure: {
        pass_ratio: closureMetrics.pass_ratio,
        rows_considered: closureMetrics.rows_considered,
        latest_day_pass: closureMetrics.latest_day_pass
      },
      budget_window: {
        samples: budgetWindow.samples,
        avg_used_ratio: budgetUsedRatioAvg,
        max_used_ratio: budgetUsedRatioMax
      },
      budget_events: {
        total_decisions: budgetEvents.total_decisions,
        deny_ratio: budgetEvents.deny_ratio,
        autopause_deny_ratio: budgetAutopauseDenyRatio
      }
    }
  };
}

function scoreReliability(value: number | null, threshold: number) {
  if (value == null) return { score: 0, pass: false };
  const ratio = threshold <= 0 ? 1 : value / threshold;
  return {
    score: clampNum(ratio, 0, 1, 0),
    pass: value >= threshold
  };
}

function scoreLowerBetter(value: number | null, maxAllowed: number) {
  if (value == null || value <= 0) return { score: 0, pass: false };
  const ratio = maxAllowed / value;
  return {
    score: clampNum(ratio, 0, 1, 0),
    pass: value <= maxAllowed
  };
}

function evaluateScenario(scenario: AnyObj, metrics: AnyObj) {
  const reliabilityKey = String(scenario.metrics.reliability || 'composite_reliability');
  const latencyKey = String(scenario.metrics.latency_ms || 'blended_latency_ms');
  const costKey = String(scenario.metrics.cost_pressure || 'cost_pressure');

  const reliabilityValue = numOr(metrics[reliabilityKey], null);
  const latencyValue = numOr(metrics[latencyKey], null);
  const costValue = numOr(metrics[costKey], null);

  const reliability = scoreReliability(reliabilityValue, scenario.baselines.reliability_min);
  const latency = scoreLowerBetter(latencyValue, scenario.baselines.latency_ms_max);
  const cost = scoreLowerBetter(costValue, scenario.baselines.cost_pressure_max);

  const wRel = clampNum(scenario.weights.reliability, 0, 1000, 0.4);
  const wLat = clampNum(scenario.weights.latency, 0, 1000, 0.3);
  const wCost = clampNum(scenario.weights.cost, 0, 1000, 0.3);
  const weightTotal = Math.max(0.000001, wRel + wLat + wCost);
  const weightedScore = ((reliability.score * wRel) + (latency.score * wLat) + (cost.score * wCost)) / weightTotal;

  const notes = [];
  if (reliabilityValue == null) notes.push(`missing_metric:${reliabilityKey}`);
  if (latencyValue == null) notes.push(`missing_metric:${latencyKey}`);
  if (costValue == null) notes.push(`missing_metric:${costKey}`);

  return {
    id: scenario.id,
    name: scenario.name,
    metrics: {
      reliability: { key: reliabilityKey, value: reliabilityValue },
      latency_ms: { key: latencyKey, value: latencyValue },
      cost_pressure: { key: costKey, value: costValue }
    },
    baselines: scenario.baselines,
    weights: scenario.weights,
    checks: {
      reliability: reliability.pass,
      latency_ms: latency.pass,
      cost_pressure: cost.pass
    },
    scores: {
      reliability: Number(reliability.score.toFixed(4)),
      latency: Number(latency.score.toFixed(4)),
      cost: Number(cost.score.toFixed(4)),
      weighted: Number(weightedScore.toFixed(4))
    },
    pass: reliability.pass && latency.pass && cost.pass,
    notes
  };
}

function aggregateScenarios(policy: AnyObj, rows: AnyObj[]) {
  const total = rows.length;
  const passed = rows.filter((row) => row.pass === true).length;
  const passRatio = total > 0 ? passed / total : 0;
  const weightedAvg = total > 0
    ? rows.reduce((sum, row) => sum + Number(row && row.scores && row.scores.weighted || 0), 0) / total
    : 0;
  const gates = policy.aggregate_gates || {};
  const minScenariosPassed = clampInt(gates.min_scenarios_passed, 1, 100, 2);
  const minPassRatio = clampNum(gates.min_pass_ratio, 0, 1, 0.67);
  const minWeightedScore = clampNum(gates.min_weighted_score, 0, 2, 0.85);
  const parityPass = (
    passed >= minScenariosPassed
    && passRatio >= minPassRatio
    && weightedAvg >= minWeightedScore
  );
  return {
    parity_pass: parityPass,
    scenarios_total: total,
    scenarios_passed: passed,
    pass_ratio: Number(passRatio.toFixed(4)),
    weighted_score_avg: Number(weightedAvg.toFixed(4)),
    gates: {
      min_scenarios_passed: minScenariosPassed,
      min_pass_ratio: minPassRatio,
      min_weighted_score: minWeightedScore
    }
  };
}

function runHarness(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const date = toDate(args._[1] || args.date);
  const windowDays = clampInt(args.days ?? args['window-days'], 1, 90, policy.window_days);
  const strict = toBool(args.strict, policy.strict_default);
  const statePath = args['state-path'] ? path.resolve(String(args['state-path'])) : policy.state_path || DEFAULT_STATE_PATH;
  const historyPath = args['history-path'] ? path.resolve(String(args['history-path'])) : policy.history_path || DEFAULT_HISTORY_PATH;
  const weeklyDir = args['weekly-dir']
    ? path.resolve(String(args['weekly-dir']))
    : policy.weekly_receipts_dir;

  const derived = deriveMetrics(policy, date, windowDays);
  const scenarios = policy.scenarios.map((scenario: AnyObj) => evaluateScenario(scenario, derived.metric_catalog));
  const aggregate = aggregateScenarios(policy, scenarios);

  const weekStart = mondayUtc(date);
  const weekEnd = addUtcDays(weekStart, 6);
  const weeklyPath = path.join(weeklyDir, `${weekStart}.json`);
  const ts = nowIso();

  const payload = {
    ok: true,
    type: 'narrow_agent_parity_harness',
    ts,
    date,
    week: {
      start: weekStart,
      end: weekEnd,
      id: weekStart
    },
    policy_version: policy.version,
    policy_path: relPath(policyPath),
    baseline_profile: policy.baseline_profile,
    strict,
    window_days: windowDays,
    parity_pass: aggregate.parity_pass,
    dimensions: derived.dimensions,
    metric_catalog: derived.metric_catalog,
    source_summary: derived.source_summary,
    scenarios,
    aggregate,
    source_paths: {
      execution_reliability_slo_path: relPath(policy.sources.execution_reliability_slo_path),
      runtime_efficiency_floor_path: relPath(policy.sources.runtime_efficiency_floor_path),
      workflow_execution_closure_path: relPath(policy.sources.workflow_execution_closure_path),
      daily_budget_dir: relPath(policy.sources.daily_budget_dir),
      budget_events_path: relPath(policy.sources.budget_events_path)
    },
    state_path: relPath(statePath),
    history_path: relPath(historyPath),
    weekly_receipt_path: relPath(weeklyPath)
  };

  writeJsonAtomic(statePath, {
    schema_id: 'narrow_agent_parity_harness',
    schema_version: '1.0',
    updated_at: ts,
    date,
    week: payload.week,
    policy_version: payload.policy_version,
    baseline_profile: payload.baseline_profile,
    parity_pass: payload.parity_pass,
    dimensions: payload.dimensions,
    aggregate: payload.aggregate,
    scenarios: payload.scenarios
  });
  appendJsonl(historyPath, {
    ts,
    date,
    week_start: weekStart,
    parity_pass: payload.parity_pass,
    dimensions: payload.dimensions,
    aggregate: payload.aggregate
  });
  trimHistory(historyPath, policy.max_history_rows);
  writeJsonAtomic(weeklyPath, payload);

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (strict && !payload.parity_pass) return 2;
  return 0;
}

function runStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const statePath = args['state-path'] ? path.resolve(String(args['state-path'])) : policy.state_path || DEFAULT_STATE_PATH;
  const weeklyDir = args['weekly-dir']
    ? path.resolve(String(args['weekly-dir']))
    : policy.weekly_receipts_dir;
  const token = String(args._[1] || args.date || 'latest').trim().toLowerCase();

  let payload = null;
  let source = 'state';
  if (token === 'latest') {
    payload = readJson(statePath, null);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(token)) {
    const weekPath = path.join(weeklyDir, `${mondayUtc(token)}.json`);
    payload = readJson(weekPath, null);
    source = 'weekly';
    if (!payload) {
      payload = readJson(statePath, null);
      source = 'state_fallback';
    }
  } else {
    payload = readJson(statePath, null);
    source = 'state_fallback';
  }

  const out = {
    ok: true,
    type: 'narrow_agent_parity_harness_status',
    available: !!payload,
    source,
    state_path: relPath(statePath),
    weekly_receipts_dir: relPath(weeklyDir),
    payload
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return 0;
}

function usage() {
  const lines = [
    'Usage:',
    '  node systems/ops/narrow_agent_parity_harness.js run [YYYY-MM-DD] [--strict=1|0] [--days=N]',
    '  node systems/ops/narrow_agent_parity_harness.js status [latest|YYYY-MM-DD]'
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'run').trim().toLowerCase();
  if (cmd === 'run') {
    process.exitCode = runHarness(args);
    return;
  }
  if (cmd === 'status') {
    process.exitCode = runStatus(args);
    return;
  }
  usage();
  process.exitCode = cmd === 'help' || cmd === '--help' ? 0 : 1;
}

main();
