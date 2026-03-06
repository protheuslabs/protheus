#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-018
 *
 * Trace -> Habit autogenesis lane:
 * - derive candidate preventive habits from failed traces + postmortems
 * - gate through propose -> trial -> report -> promote
 * - require measurable failure-class regression reduction before promotion
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  clampNumber,
  readJson,
  readJsonl,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

const POLICY_PATH = process.env.TRACE_HABIT_AUTOGENESIS_POLICY_PATH
  ? path.resolve(process.env.TRACE_HABIT_AUTOGENESIS_POLICY_PATH)
  : path.join(ROOT, 'config', 'trace_habit_autogenesis_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/trace_habit_autogenesis.js propose [--policy=<path>]');
  console.log('  node systems/ops/trace_habit_autogenesis.js trial [--candidate-id=<id>|--all=1] [--policy=<path>]');
  console.log('  node systems/ops/trace_habit_autogenesis.js report [--candidate-id=<id>|--all=1] [--policy=<path>]');
  console.log('  node systems/ops/trace_habit_autogenesis.js promote --candidate-id=<id> [--policy=<path>]');
  console.log('  node systems/ops/trace_habit_autogenesis.js status [--policy=<path>]');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    min_failure_events_per_class: 3,
    min_window_events: 4,
    min_regression_reduction: 0.2,
    failure_outcomes: ['error', 'fail', 'timeout', 'blocked'],
    paths: {
      trace_path: 'state/observability/thought_action_trace.jsonl',
      postmortem_dir: 'state/ops/postmortems',
      queue_path: 'state/ops/trace_habit_autogenesis/queue.json',
      latest_path: 'state/ops/trace_habit_autogenesis/latest.json',
      receipts_path: 'state/ops/trace_habit_autogenesis/receipts.jsonl',
      reports_dir: 'state/ops/trace_habit_autogenesis/reports'
    }
  };
}

function normalizeList(v: unknown) {
  if (Array.isArray(v)) return v.map((row) => normalizeToken(row, 80)).filter(Boolean);
  const raw = cleanText(v || '', 2000);
  if (!raw) return [];
  return raw.split(',').map((row) => normalizeToken(row, 80)).filter(Boolean);
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    min_failure_events_per_class: clampInt(
      raw.min_failure_events_per_class,
      1,
      10000,
      base.min_failure_events_per_class
    ),
    min_window_events: clampInt(raw.min_window_events, 2, 100000, base.min_window_events),
    min_regression_reduction: clampNumber(
      raw.min_regression_reduction,
      0,
      1,
      base.min_regression_reduction
    ),
    failure_outcomes: normalizeList(raw.failure_outcomes || base.failure_outcomes),
    paths: {
      trace_path: resolvePath(paths.trace_path, base.paths.trace_path),
      postmortem_dir: resolvePath(paths.postmortem_dir, base.paths.postmortem_dir),
      queue_path: resolvePath(paths.queue_path, base.paths.queue_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      reports_dir: resolvePath(paths.reports_dir, base.paths.reports_dir)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadQueue(policy: any) {
  const src = readJson(policy.paths.queue_path, null);
  if (!src || typeof src !== 'object') {
    return {
      schema_id: 'trace_habit_autogenesis_queue',
      schema_version: '1.0',
      updated_at: nowIso(),
      candidates: []
    };
  }
  return {
    schema_id: 'trace_habit_autogenesis_queue',
    schema_version: '1.0',
    updated_at: src.updated_at || nowIso(),
    candidates: Array.isArray(src.candidates) ? src.candidates : []
  };
}

function saveQueue(policy: any, queue: any) {
  writeJsonAtomic(policy.paths.queue_path, {
    schema_id: 'trace_habit_autogenesis_queue',
    schema_version: '1.0',
    updated_at: nowIso(),
    candidates: Array.isArray(queue.candidates) ? queue.candidates : []
  });
}

function readPostmortems(policy: any) {
  const out = [];
  if (!fs.existsSync(policy.paths.postmortem_dir)) return out;
  const names = fs.readdirSync(policy.paths.postmortem_dir).filter((name) => name.endsWith('.json')).sort();
  for (const name of names) {
    const abs = path.join(policy.paths.postmortem_dir, name);
    const row = readJson(abs, null);
    if (row && typeof row === 'object') out.push(row);
  }
  return out;
}

function parseTraceRows(policy: any) {
  const rows = readJsonl(policy.paths.trace_path).filter((row: any) => row && typeof row === 'object');
  rows.sort((a: any, b: any) => {
    const aMs = Date.parse(String(a.ts || ''));
    const bMs = Date.parse(String(b.ts || ''));
    if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) return aMs - bMs;
    return String(a.trace_id || '').localeCompare(String(b.trace_id || ''));
  });
  return rows;
}

function collectTraceClasses(policy: any, traceRows: any[]) {
  const byClass: Record<string, any> = {};
  for (const row of traceRows) {
    const stage = normalizeToken(row.stage || 'unknown', 80) || 'unknown';
    const outcome = normalizeToken(row.outcome || 'unknown', 80) || 'unknown';
    const cls = `trace:${stage}:${outcome}`;
    if (!byClass[cls]) {
      byClass[cls] = {
        failure_class: cls,
        stage,
        outcome,
        total_events: 0,
        failure_events: 0
      };
    }
    byClass[cls].total_events += 1;
    if (policy.failure_outcomes.includes(outcome)) {
      byClass[cls].failure_events += 1;
    }
  }
  return byClass;
}

function postmortemClasses(postmortems: any[]) {
  const out = [];
  for (const row of postmortems) {
    const incidentId = normalizeToken(row && row.incident_id || '', 80);
    const actions = Array.isArray(row && row.actions) ? row.actions : [];
    for (const action of actions) {
      if (normalizeToken(action && action.type || '', 32) !== 'preventive') continue;
      const actionId = normalizeToken(action && action.action_id || '', 40) || 'a0';
      out.push({
        failure_class: `postmortem:${incidentId || 'unknown'}:${actionId}`,
        incident_id: incidentId || null,
        action_id: actionId,
        preventive: true
      });
    }
  }
  return out;
}

function findCandidate(queue: any, candidateId: string) {
  const rows = Array.isArray(queue.candidates) ? queue.candidates : [];
  const id = normalizeToken(candidateId, 120);
  return rows.find((row: any) => normalizeToken(row && row.candidate_id || '', 120) === id) || null;
}

function cmdPropose(args: any, policy: any) {
  const queue = loadQueue(policy);
  const traces = parseTraceRows(policy);
  const classes = collectTraceClasses(policy, traces);
  const postmortems = readPostmortems(policy);
  const pmClasses = postmortemClasses(postmortems);
  const existing = new Map(
    (queue.candidates || []).map((row: any) => [String(row.failure_class || ''), row])
  );

  const created = [];
  const updated = [];

  for (const row of Object.values(classes) as any[]) {
    if (Number(row.failure_events || 0) < policy.min_failure_events_per_class) continue;
    const failureClass = String(row.failure_class || '');
    const candidateId = `tha_${stableHash(failureClass, 12)}`;
    const proposal = {
      ts: nowIso(),
      objective: `reduce_${normalizeToken(failureClass, 100)}`,
      summary: `Autogenerated preventive habit candidate for ${failureClass}`,
      failure_class: failureClass
    };

    if (!existing.has(failureClass)) {
      const candidate = {
        candidate_id: candidateId,
        failure_class: failureClass,
        source_type: 'trace',
        source_trace_failures: Number(row.failure_events || 0),
        source_postmortems: 0,
        status: 'proposed',
        gates: {
          proposed: true,
          trial_passed: false,
          report_promotable: false,
          promoted: false
        },
        proposal,
        trial: null,
        report: null,
        promotion: null,
        created_at: nowIso(),
        updated_at: nowIso()
      };
      queue.candidates.push(candidate);
      created.push(candidate);
      continue;
    }

    const candidate = existing.get(failureClass);
    candidate.source_trace_failures = Number(row.failure_events || 0);
    candidate.proposal = proposal;
    candidate.updated_at = nowIso();
    updated.push(candidate);
  }

  for (const row of pmClasses) {
    const failureClass = String(row.failure_class || '');
    if (!failureClass || existing.has(failureClass)) continue;
    const candidate = {
      candidate_id: `tha_${stableHash(failureClass, 12)}`,
      failure_class: failureClass,
      source_type: 'postmortem',
      source_trace_failures: 0,
      source_postmortems: 1,
      status: 'proposed',
      gates: {
        proposed: true,
        trial_passed: false,
        report_promotable: false,
        promoted: false
      },
      proposal: {
        ts: nowIso(),
        objective: `reduce_${normalizeToken(failureClass, 100)}`,
        summary: `Autogenerated preventive habit candidate from postmortem ${row.incident_id || 'unknown'}`,
        failure_class: failureClass
      },
      trial: null,
      report: null,
      promotion: null,
      created_at: nowIso(),
      updated_at: nowIso()
    };
    queue.candidates.push(candidate);
    created.push(candidate);
  }

  saveQueue(policy, queue);
  const out = {
    ok: true,
    type: 'trace_habit_autogenesis_propose',
    ts: nowIso(),
    shadow_only: policy.shadow_only,
    created_count: created.length,
    updated_count: updated.length,
    created: created.map((row: any) => ({
      candidate_id: row.candidate_id,
      failure_class: row.failure_class,
      source_type: row.source_type
    })),
    queue_size: queue.candidates.length
  };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  emit(out);
}

function trialMetricsForClass(policy: any, traces: any[], failureClass: string) {
  const parts = String(failureClass || '').split(':');
  if (parts.length < 3 || parts[0] !== 'trace') {
    return {
      measurable: false,
      reason: 'trace_failure_class_required_for_trial',
      baseline_events: 0,
      trial_events: 0,
      baseline_failures: 0,
      trial_failures: 0,
      baseline_rate: null,
      trial_rate: null,
      regression_reduction: null
    };
  }
  const stage = normalizeToken(parts[1], 80);
  const outcome = normalizeToken(parts[2], 80);
  const stageRows = traces.filter((row: any) => normalizeToken(row.stage || 'unknown', 80) === stage);
  if (stageRows.length < policy.min_window_events * 2) {
    return {
      measurable: false,
      reason: 'insufficient_stage_window_events',
      baseline_events: 0,
      trial_events: 0,
      baseline_failures: 0,
      trial_failures: 0,
      baseline_rate: null,
      trial_rate: null,
      regression_reduction: null
    };
  }

  const mid = Math.floor(stageRows.length / 2);
  const baseline = stageRows.slice(0, mid);
  const trial = stageRows.slice(mid);
  const baselineFailures = baseline.filter((row: any) => normalizeToken(row.outcome || 'unknown', 80) === outcome).length;
  const trialFailures = trial.filter((row: any) => normalizeToken(row.outcome || 'unknown', 80) === outcome).length;
  const baselineRate = baselineFailures / Math.max(1, baseline.length);
  const trialRate = trialFailures / Math.max(1, trial.length);
  const reduction = baselineRate > 0 ? (baselineRate - trialRate) / baselineRate : 0;

  return {
    measurable: baseline.length >= policy.min_window_events && trial.length >= policy.min_window_events,
    reason: null,
    baseline_events: baseline.length,
    trial_events: trial.length,
    baseline_failures: baselineFailures,
    trial_failures: trialFailures,
    baseline_rate: Number(baselineRate.toFixed(6)),
    trial_rate: Number(trialRate.toFixed(6)),
    regression_reduction: Number(reduction.toFixed(6))
  };
}

function candidateSelection(queue: any, args: any) {
  if (toBool(args.all, false)) return Array.isArray(queue.candidates) ? queue.candidates : [];
  const candidateId = normalizeToken(args['candidate-id'] || args.candidate_id || '', 120);
  if (!candidateId) return [];
  const row = findCandidate(queue, candidateId);
  return row ? [row] : [];
}

function cmdTrial(args: any, policy: any) {
  const queue = loadQueue(policy);
  const traces = parseTraceRows(policy);
  const selected = candidateSelection(queue, args)
    .filter((row: any) => ['proposed', 'trialed', 'reported'].includes(String(row.status || '')));
  if (!selected.length) emit({ ok: false, type: 'trace_habit_autogenesis_trial', error: 'candidate_not_found' }, 1);

  let passed = 0;
  let failed = 0;
  for (const row of selected) {
    const metrics = trialMetricsForClass(policy, traces, row.failure_class);
    const pass = metrics.measurable
      && Number(metrics.regression_reduction || 0) >= Number(policy.min_regression_reduction || 0);
    row.trial = {
      ts: nowIso(),
      ...metrics,
      pass
    };
    row.status = 'trialed';
    row.gates = row.gates || {};
    row.gates.trial_passed = pass === true;
    row.updated_at = nowIso();
    if (pass) passed += 1;
    else failed += 1;
  }

  saveQueue(policy, queue);
  const out = {
    ok: true,
    type: 'trace_habit_autogenesis_trial',
    ts: nowIso(),
    selected_count: selected.length,
    passed_count: passed,
    failed_count: failed,
    min_regression_reduction: policy.min_regression_reduction
  };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  emit(out);
}

function reportText(candidate: any) {
  const trial = candidate && candidate.trial && typeof candidate.trial === 'object' ? candidate.trial : {};
  return [
    `# Trace Habit Autogenesis Report: ${candidate.candidate_id}`,
    '',
    `- Failure class: ${candidate.failure_class}`,
    `- Status: ${candidate.status}`,
    `- Baseline events: ${Number(trial.baseline_events || 0)}`,
    `- Trial events: ${Number(trial.trial_events || 0)}`,
    `- Baseline failures: ${Number(trial.baseline_failures || 0)}`,
    `- Trial failures: ${Number(trial.trial_failures || 0)}`,
    `- Baseline rate: ${trial.baseline_rate == null ? 'n/a' : Number(trial.baseline_rate).toFixed(6)}`,
    `- Trial rate: ${trial.trial_rate == null ? 'n/a' : Number(trial.trial_rate).toFixed(6)}`,
    `- Regression reduction: ${trial.regression_reduction == null ? 'n/a' : Number(trial.regression_reduction).toFixed(6)}`,
    `- Trial pass: ${trial.pass === true ? 'yes' : 'no'}`,
    ''
  ].join('\n');
}

function cmdReport(args: any, policy: any) {
  const queue = loadQueue(policy);
  const selected = candidateSelection(queue, args)
    .filter((row: any) => ['trialed', 'reported'].includes(String(row.status || '')));
  if (!selected.length) emit({ ok: false, type: 'trace_habit_autogenesis_report', error: 'candidate_not_found' }, 1);

  fs.mkdirSync(policy.paths.reports_dir, { recursive: true });

  let promotable = 0;
  for (const row of selected) {
    const trial = row && row.trial && typeof row.trial === 'object' ? row.trial : null;
    const canPromote = !!(trial
      && trial.pass === true
      && trial.measurable === true
      && Number(trial.regression_reduction || 0) >= Number(policy.min_regression_reduction || 0));
    const reportPath = path.join(policy.paths.reports_dir, `${row.candidate_id}.md`);
    fs.writeFileSync(reportPath, reportText(row), 'utf8');
    row.report = {
      ts: nowIso(),
      promotable: canPromote,
      report_path: rel(reportPath)
    };
    row.status = 'reported';
    row.gates = row.gates || {};
    row.gates.report_promotable = canPromote;
    row.updated_at = nowIso();
    if (canPromote) promotable += 1;
  }

  saveQueue(policy, queue);
  const out = {
    ok: true,
    type: 'trace_habit_autogenesis_report',
    ts: nowIso(),
    selected_count: selected.length,
    promotable_count: promotable,
    reports_dir: rel(policy.paths.reports_dir)
  };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  emit(out);
}

function cmdPromote(args: any, policy: any) {
  const queue = loadQueue(policy);
  const candidateId = normalizeToken(args['candidate-id'] || args.candidate_id || '', 120);
  if (!candidateId) emit({ ok: false, type: 'trace_habit_autogenesis_promote', error: 'candidate_id_required' }, 1);
  const row = findCandidate(queue, candidateId);
  if (!row) emit({ ok: false, type: 'trace_habit_autogenesis_promote', error: 'candidate_not_found' }, 1);

  const promotable = !!(row.report && row.report.promotable === true);
  if (!promotable) {
    emit({
      ok: false,
      type: 'trace_habit_autogenesis_promote',
      error: 'regression_reduction_threshold_not_met',
      candidate_id: row.candidate_id,
      failure_class: row.failure_class
    }, 1);
  }

  row.promotion = {
    ts: nowIso(),
    promoted: true,
    gate: 'failure_class_regression_reduction_passed',
    recommended_sync_command: 'node systems/adaptive/habits/habit_runtime_sync.js run',
    deterministic_reversion: `disable_candidate:${row.candidate_id}`
  };
  row.status = 'promoted';
  row.gates = row.gates || {};
  row.gates.promoted = true;
  row.updated_at = nowIso();
  saveQueue(policy, queue);

  const out = {
    ok: true,
    type: 'trace_habit_autogenesis_promote',
    ts: nowIso(),
    candidate_id: row.candidate_id,
    failure_class: row.failure_class,
    promotion: row.promotion
  };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  emit(out);
}

function cmdStatus(policy: any) {
  const queue = loadQueue(policy);
  const rows = Array.isArray(queue.candidates) ? queue.candidates : [];
  const counts = {
    proposed: rows.filter((row: any) => row.status === 'proposed').length,
    trialed: rows.filter((row: any) => row.status === 'trialed').length,
    reported: rows.filter((row: any) => row.status === 'reported').length,
    promoted: rows.filter((row: any) => row.status === 'promoted').length
  };
  emit({
    ok: true,
    type: 'trace_habit_autogenesis_status',
    ts: nowIso(),
    queue_size: rows.length,
    counts,
    latest: readJson(policy.paths.latest_path, null),
    paths: {
      queue_path: rel(policy.paths.queue_path),
      latest_path: rel(policy.paths.latest_path),
      receipts_path: rel(policy.paths.receipts_path),
      reports_dir: rel(policy.paths.reports_dir)
    }
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (!policy.enabled) emit({ ok: false, error: 'trace_habit_autogenesis_disabled' }, 1);

  if (cmd === 'propose') return cmdPropose(args, policy);
  if (cmd === 'trial') return cmdTrial(args, policy);
  if (cmd === 'report') return cmdReport(args, policy);
  if (cmd === 'promote') return cmdPromote(args, policy);
  if (cmd === 'status') return cmdStatus(policy);
  usage();
  process.exit(1);
}

main();
