#!/usr/bin/env node
'use strict';

/**
 * metrics_exporter.js
 *
 * Emits a Prometheus-friendly snapshot from core runtime health artifacts.
 *
 * Usage:
 *   node systems/observability/metrics_exporter.js run [YYYY-MM-DD] [--window=daily] [--policy=/abs/path.json] [--write=1|0]
 *   node systems/observability/metrics_exporter.js prom [YYYY-MM-DD] [--window=daily] [--policy=/abs/path.json] [--write=1|0]
 *   node systems/observability/metrics_exporter.js status [--policy=/abs/path.json]
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;
type Metric = {
  name: string,
  help: string,
  type: 'gauge' | 'counter',
  value: number,
  labels?: Record<string, string>
};

const ROOT = path.resolve(process.env.OBSERVABILITY_ROOT || path.join(__dirname, '..', '..'));
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'observability_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/observability/metrics_exporter.js run [YYYY-MM-DD] [--window=daily] [--policy=/abs/path.json] [--write=1|0]');
  console.log('  node systems/observability/metrics_exporter.js prom [YYYY-MM-DD] [--window=daily] [--policy=/abs/path.json] [--write=1|0]');
  console.log('  node systems/observability/metrics_exporter.js status [--policy=/abs/path.json]');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const arg of argv) {
    if (!String(arg || '').startsWith('--')) {
      out._.push(String(arg || ''));
      continue;
    }
    const idx = String(arg || '').indexOf('=');
    if (idx === -1) out[String(arg || '').slice(2)] = true;
    else out[String(arg || '').slice(2, idx)] = String(arg || '').slice(idx + 1);
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return nowIso().slice(0, 10);
}

function cleanText(v: unknown, maxLen = 160) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function boolFlag(v: unknown, fallback = false) {
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

function asNumber(v: unknown, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asRatio(v: unknown) {
  const n = asNumber(v, 0);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function writeTextAtomic(filePath: string, value: string) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, value, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
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

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(value: unknown, fallbackRel: string) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
}

function defaultPolicy() {
  return {
    version: '1.0',
    metrics: {
      enabled: true,
      write_prometheus: true,
      write_snapshot: true,
      health_reports_dir: 'state/autonomy/health_reports',
      workflow_executor_latest_path: 'state/adaptive/workflows/executor/latest.json',
      workflow_executor_latest_live_path: 'state/adaptive/workflows/executor/latest_live.json',
      ci_baseline_streak_path: 'state/ops/ci_baseline_streak.json',
      output_prometheus_path: 'state/observability/prometheus/current.prom',
      output_snapshot_path: 'state/observability/metrics/latest.json',
      output_history_jsonl_path: 'state/observability/metrics/history.jsonl'
    }
  };
}

function loadPolicy(policyPathRaw: unknown) {
  const policyPath = resolvePath(
    policyPathRaw || process.env.OBSERVABILITY_POLICY_PATH || DEFAULT_POLICY_PATH,
    'config/observability_policy.json'
  );
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const src = raw && raw.metrics && typeof raw.metrics === 'object' ? raw.metrics : {};

  return {
    path: policyPath,
    version: cleanText(raw && raw.version ? raw.version : base.version, 24) || '1.0',
    metrics: {
      enabled: src.enabled !== false,
      write_prometheus: src.write_prometheus !== false,
      write_snapshot: src.write_snapshot !== false,
      health_reports_dir: resolvePath(src.health_reports_dir, base.metrics.health_reports_dir),
      workflow_executor_latest_path: resolvePath(src.workflow_executor_latest_path, base.metrics.workflow_executor_latest_path),
      workflow_executor_latest_live_path: resolvePath(src.workflow_executor_latest_live_path, base.metrics.workflow_executor_latest_live_path),
      ci_baseline_streak_path: resolvePath(src.ci_baseline_streak_path, base.metrics.ci_baseline_streak_path),
      output_prometheus_path: resolvePath(src.output_prometheus_path, base.metrics.output_prometheus_path),
      output_snapshot_path: resolvePath(src.output_snapshot_path, base.metrics.output_snapshot_path),
      output_history_jsonl_path: resolvePath(src.output_history_jsonl_path, base.metrics.output_history_jsonl_path)
    }
  };
}

function resolveHealthReportPath(dirPath: string, dateStr: string, window: string) {
  const explicit = path.join(dirPath, `${dateStr}.${window}.json`);
  if (fs.existsSync(explicit)) return explicit;
  if (!fs.existsSync(dirPath)) return null;
  const suffix = `.${window}.json`;
  const candidates = fs.readdirSync(dirPath)
    .filter((entry) => entry.endsWith(suffix))
    .map((entry) => path.join(dirPath, entry));
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const ma = fs.statSync(a).mtimeMs;
    const mb = fs.statSync(b).mtimeMs;
    return mb - ma;
  });
  return candidates[0];
}

function alertLevelCode(level: string) {
  const norm = String(level || '').trim().toLowerCase();
  if (norm === 'critical') return 2;
  if (norm === 'warn' || norm === 'warning') return 1;
  if (norm === 'ok') return 0;
  return -1;
}

function formatLabels(labels: Record<string, string> | undefined) {
  if (!labels || typeof labels !== 'object' || !Object.keys(labels).length) return '';
  const items = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k] || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `{${items.join(',')}}`;
}

function toPrometheus(metrics: Metric[]) {
  const lines: string[] = [];
  const seenHelp = new Set<string>();
  const seenType = new Set<string>();
  for (const metric of metrics) {
    if (!seenHelp.has(metric.name)) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      seenHelp.add(metric.name);
    }
    if (!seenType.has(metric.name)) {
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
      seenType.add(metric.name);
    }
    lines.push(`${metric.name}${formatLabels(metric.labels)} ${Number(metric.value)}`);
  }
  return `${lines.join('\n')}\n`;
}

function buildMetrics(dateStr: string, window: string, health: AnyObj, workflowLatest: AnyObj, ciStreak: AnyObj) {
  const slo = health && health.slo && typeof health.slo === 'object' ? health.slo : {};
  const verification = slo.checks && slo.checks.verification_pass_rate && slo.checks.verification_pass_rate.metrics
    ? slo.checks.verification_pass_rate.metrics
    : {};
  const branch = health && health.branch_health && typeof health.branch_health === 'object'
    ? health.branch_health
    : {};
  const branchQueue = branch && branch.queue && typeof branch.queue === 'object' ? branch.queue : {};
  const branchHolds = branch && branch.policy_holds && typeof branch.policy_holds === 'object' ? branch.policy_holds : {};
  const observed = health && health.observed && typeof health.observed === 'object' ? health.observed : {};
  const wfSlo = workflowLatest && workflowLatest.slo && typeof workflowLatest.slo === 'object'
    ? workflowLatest.slo
    : {};
  const wfMeasured = wfSlo && wfSlo.measured && typeof wfSlo.measured === 'object' ? wfSlo.measured : {};
  const ciTarget = asNumber(ciStreak && ciStreak.target_days, 7);
  const ciCurrent = asNumber(ciStreak && ciStreak.consecutive_daily_green_runs, 0);

  const labels = { window };

  const metrics: Metric[] = [
    {
      name: 'protheus_health_slo_level',
      help: 'SLO alert level (ok=0,warn=1,critical=2,unknown=-1).',
      type: 'gauge',
      value: alertLevelCode(String(slo.level || 'unknown')),
      labels
    },
    {
      name: 'protheus_health_slo_warn_count',
      help: 'Count of SLO checks at warn level.',
      type: 'gauge',
      value: asNumber(slo.warn_count, 0),
      labels
    },
    {
      name: 'protheus_health_slo_critical_count',
      help: 'Count of SLO checks at critical level.',
      type: 'gauge',
      value: asNumber(slo.critical_count, 0),
      labels
    },
    {
      name: 'protheus_health_slo_failed_checks_total',
      help: 'Count of failed SLO checks in selected window.',
      type: 'gauge',
      value: Array.isArray(slo.failed_checks) ? slo.failed_checks.length : 0,
      labels
    },
    {
      name: 'protheus_health_verification_pass_rate',
      help: 'Receipt verification pass rate from autonomy health checks.',
      type: 'gauge',
      value: asRatio(verification.verified_rate),
      labels
    },
    {
      name: 'protheus_branch_queue_open_count',
      help: 'Current queue open count from branch health snapshot.',
      type: 'gauge',
      value: asNumber(branchQueue.open_count, 0),
      labels
    },
    {
      name: 'protheus_branch_policy_holds_count',
      help: 'Current policy hold count from branch health snapshot.',
      type: 'gauge',
      value: asNumber(branchHolds.count, 0),
      labels
    },
    {
      name: 'protheus_observed_autonomy_runs',
      help: 'Observed autonomy runs in selected health window.',
      type: 'gauge',
      value: asNumber(observed.autonomy_runs, 0),
      labels
    },
    {
      name: 'protheus_workflow_executor_slo_pass',
      help: 'Workflow executor SLO pass flag (1=pass,0=fail).',
      type: 'gauge',
      value: wfSlo.pass === true ? 1 : 0
    },
    {
      name: 'protheus_workflow_executor_execution_success_rate',
      help: 'Workflow executor measured execution success rate.',
      type: 'gauge',
      value: asRatio(wfMeasured.execution_success_rate)
    },
    {
      name: 'protheus_workflow_executor_queue_drain_rate',
      help: 'Workflow executor measured queue drain rate.',
      type: 'gauge',
      value: asRatio(wfMeasured.queue_drain_rate)
    },
    {
      name: 'protheus_ci_baseline_streak_days',
      help: 'Current consecutive daily green CI streak.',
      type: 'gauge',
      value: ciCurrent
    },
    {
      name: 'protheus_ci_baseline_target_days',
      help: 'Target daily green CI streak length.',
      type: 'gauge',
      value: ciTarget
    },
    {
      name: 'protheus_ci_baseline_streak_ratio',
      help: 'CI streak ratio against target streak.',
      type: 'gauge',
      value: ciTarget > 0 ? Math.min(1, Math.max(0, ciCurrent / ciTarget)) : 0
    },
    {
      name: 'protheus_observability_snapshot_timestamp_seconds',
      help: 'Unix timestamp of observability metrics snapshot.',
      type: 'gauge',
      value: Math.floor(Date.now() / 1000),
      labels: { date: dateStr, window }
    }
  ];

  return metrics;
}

function runSnapshot(policy: AnyObj, dateStr: string, window: string, writeEnabled: boolean) {
  const healthPath = resolveHealthReportPath(policy.metrics.health_reports_dir, dateStr, window);
  const health = healthPath ? readJson(healthPath, {}) : {};
  const workflowLatestPath = fs.existsSync(policy.metrics.workflow_executor_latest_live_path)
    ? policy.metrics.workflow_executor_latest_live_path
    : policy.metrics.workflow_executor_latest_path;
  const workflowLatest = readJson(workflowLatestPath, {});
  const ciStreak = readJson(policy.metrics.ci_baseline_streak_path, {});
  const metrics = buildMetrics(dateStr, window, health, workflowLatest, ciStreak);
  const promText = toPrometheus(metrics);

  const out = {
    ok: true,
    type: 'observability_metrics_exporter',
    ts: nowIso(),
    date: dateStr,
    window,
    policy_path: policy.path,
    policy_version: policy.version,
    write_enabled: writeEnabled,
    health_report_found: !!healthPath,
    health_report_path: healthPath ? relPath(healthPath) : null,
    workflow_executor_path: relPath(workflowLatestPath),
    ci_baseline_path: relPath(policy.metrics.ci_baseline_streak_path),
    metrics_count: metrics.length,
    output: {
      prometheus_path: relPath(policy.metrics.output_prometheus_path),
      snapshot_path: relPath(policy.metrics.output_snapshot_path),
      history_path: relPath(policy.metrics.output_history_jsonl_path)
    },
    metrics_preview: metrics.slice(0, 8).map((m) => ({
      name: m.name,
      value: Number(m.value),
      labels: m.labels || {}
    })),
    warnings: [] as string[]
  };

  if (!healthPath) out.warnings.push('health_report_missing');
  if (!fs.existsSync(workflowLatestPath)) out.warnings.push('workflow_executor_snapshot_missing');
  if (!fs.existsSync(policy.metrics.ci_baseline_streak_path)) out.warnings.push('ci_baseline_streak_missing');

  if (writeEnabled) {
    if (policy.metrics.write_prometheus) {
      writeTextAtomic(policy.metrics.output_prometheus_path, promText);
    }
    if (policy.metrics.write_snapshot) {
      writeJsonAtomic(policy.metrics.output_snapshot_path, {
        ...out,
        metrics
      });
    }
    appendJsonl(policy.metrics.output_history_jsonl_path, {
      ts: out.ts,
      type: out.type,
      date: out.date,
      window: out.window,
      metrics_count: out.metrics_count,
      health_report_found: out.health_report_found,
      warnings: out.warnings
    });
  }

  return { out, metrics, promText };
}

function cmdRun(args: AnyObj, printProm: boolean) {
  const dateStr = cleanText(args._[1] || todayStr(), 10) || todayStr();
  const window = String(args.window || 'daily').trim().toLowerCase() === 'weekly' ? 'weekly' : 'daily';
  const policy = loadPolicy(args.policy);
  if (!policy.metrics.enabled) {
    process.stdout.write(JSON.stringify({
      ok: true,
      type: 'observability_metrics_exporter',
      ts: nowIso(),
      date: dateStr,
      window,
      skipped: true,
      reason: 'metrics_disabled',
      policy_path: policy.path
    }) + '\n');
    return;
  }
  const writeEnabled = boolFlag(args.write, true);
  const result = runSnapshot(policy, dateStr, window, writeEnabled);
  if (printProm) {
    process.stdout.write(result.promText);
    return;
  }
  process.stdout.write(`${JSON.stringify(result.out)}\n`);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy);
  const latest = readJson(policy.metrics.output_snapshot_path, null);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'observability_metrics_exporter_status',
    ts: nowIso(),
    policy_path: policy.path,
    policy_version: policy.version,
    metrics_enabled: policy.metrics.enabled,
    output_prometheus_path: relPath(policy.metrics.output_prometheus_path),
    output_snapshot_path: relPath(policy.metrics.output_snapshot_path),
    output_history_jsonl_path: relPath(policy.metrics.output_history_jsonl_path),
    latest_snapshot_ts: latest && latest.ts ? latest.ts : null,
    latest_snapshot_date: latest && latest.date ? latest.date : null,
    latest_metrics_count: latest && Number.isFinite(Number(latest.metrics_count))
      ? Number(latest.metrics_count)
      : null
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawCmd = String(args._[0] || '').trim().toLowerCase();
  if (args.help || !rawCmd || rawCmd === 'help' || rawCmd === '--help' || rawCmd === '-h') {
    usage();
    return;
  }
  const cmd = rawCmd;
  if (cmd === 'run') {
    cmdRun(args, false);
    return;
  }
  if (cmd === 'prom') {
    cmdRun(args, true);
    return;
  }
  if (cmd === 'status') {
    cmdStatus(args);
    return;
  }
  usage();
  process.exit(2);
}

try {
  main();
} catch (err: any) {
  process.stderr.write(`metrics_exporter.js: FAIL: ${String(err && err.message || err || 'unknown_error')}\n`);
  process.exit(1);
}

export {};
