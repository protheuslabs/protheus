#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = process.env.V1_HARDENING_CHECKPOINT_DIR
  ? path.resolve(process.env.V1_HARDENING_CHECKPOINT_DIR)
  : path.join(REPO_ROOT, 'state', 'ops');
const STATE_PATH = process.env.V1_HARDENING_CHECKPOINT_STATE_PATH
  ? path.resolve(process.env.V1_HARDENING_CHECKPOINT_STATE_PATH)
  : path.join(REPO_ROOT, 'state', 'ops', 'v1_hardening_checkpoint_state.json');
const RUNS_DIR = path.join(REPO_ROOT, 'state', 'autonomy', 'runs');
const HEALTH_REPORTS_DIR = path.join(REPO_ROOT, 'state', 'autonomy', 'health_reports');
const QUEUE_HYGIENE_STATE_PATH = path.join(REPO_ROOT, 'state', 'ops', 'queue_hygiene_state.json');

function nowIso() {
  return new Date().toISOString();
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

function normalizeDate(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return nowIso().slice(0, 10);
}

function toPositiveInt(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, body) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, body, 'utf8');
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function asMs(ts) {
  const ms = Date.parse(String(ts || ''));
  return Number.isFinite(ms) ? ms : null;
}

function daysBack(dateStr, days) {
  const base = Date.parse(`${dateStr}T23:59:59.999Z`);
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(base - (i * 24 * 60 * 60 * 1000));
    out.push(d.toISOString().slice(0, 10));
  }
  return out.sort();
}

function loadHealthReport(dateStr) {
  const fp = path.join(HEALTH_REPORTS_DIR, `${dateStr}.daily.json`);
  const direct = readJson(fp, null);
  const useCachedOnly = String(process.env.V1_HARDENING_USE_CACHED_HEALTH || '0') === '1';
  if (useCachedOnly && direct && typeof direct === 'object') return direct;
  const cmd = spawnSync('node', ['systems/autonomy/health_status.js', dateStr, '--write=0', '--alerts=0'], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });
  if (cmd.status === 0) {
    try {
      const live = JSON.parse(String(cmd.stdout || '{}'));
      if (live && typeof live === 'object') return live;
    } catch {}
  }
  if (direct && typeof direct === 'object') return direct;
  return null;
}

function loadQueueHygieneSummary() {
  const state = readJson(QUEUE_HYGIENE_STATE_PATH, null);
  const outputFile = state && state.output_file ? String(state.output_file) : '';
  if (!outputFile) return null;
  return readJson(outputFile, null);
}

function computeOutcomeWindow(dateStr, windowDays) {
  const dates = daysBack(dateStr, windowDays);
  let attempted = 0;
  let executed = 0;
  let shipped = 0;
  let noChange = 0;
  let reverted = 0;
  for (const d of dates) {
    const rows = readJsonl(path.join(RUNS_DIR, `${d}.jsonl`));
    for (const row of rows) {
      if (!row || row.type !== 'autonomy_run') continue;
      attempted += 1;
      const result = String(row.result || '');
      if (result === 'executed') {
        executed += 1;
        const outcome = String(row.outcome || '').toLowerCase();
        if (outcome === 'shipped') shipped += 1;
        else if (outcome === 'no_change') noChange += 1;
        else if (outcome === 'reverted') reverted += 1;
      }
    }
  }
  const shippedRate = executed > 0 ? shipped / executed : 0;
  return {
    window_days: windowDays,
    attempted,
    executed,
    shipped,
    no_change: noChange,
    reverted,
    shipped_rate: Number(shippedRate.toFixed(3))
  };
}

function bool(v) {
  return v === true;
}

function buildCriteria(health, queueHygiene, outcomes) {
  const checks = health && health.slo && health.slo.checks && typeof health.slo.checks === 'object'
    ? health.slo.checks
    : {};
  const readiness = health && health.strategy_readiness && health.strategy_readiness.readiness
    ? health.strategy_readiness.readiness
    : {};
  const budgetAutopauseActive = bool(health && health.gates && health.gates.budget_autopause_active);
  const queueTotals = queueHygiene && queueHygiene.summary && queueHygiene.summary.totals
    ? queueHygiene.summary.totals
    : null;

  const criteria = [
    {
      id: 'security_integrity',
      weight: 3,
      pass: bool(health && health.integrity_kernel && health.integrity_kernel.ok)
        && bool(health && health.architecture_guard && health.architecture_guard.ok),
      detail: 'integrity_kernel + architecture_guard'
    },
    {
      id: 'startup_attestation',
      weight: 2,
      pass: bool(checks.startup_attestation && checks.startup_attestation.ok),
      detail: checks.startup_attestation ? String(checks.startup_attestation.reason || '') : 'missing'
    },
    {
      id: 'routing_health',
      weight: 2,
      pass: bool(checks.routing_degraded && checks.routing_degraded.ok),
      detail: checks.routing_degraded ? String(checks.routing_degraded.reason || '') : 'missing'
    },
    {
      id: 'sensory_continuity',
      weight: 2,
      pass: bool(checks.dark_eyes && checks.dark_eyes.ok)
        && bool(checks.queue_backlog && checks.queue_backlog.ok)
        && bool(checks.proposal_starvation && checks.proposal_starvation.ok),
      detail: 'dark_eyes + queue_backlog + proposal_starvation'
    },
    {
      id: 'drift_control',
      weight: 2,
      pass: bool(checks.drift && checks.drift.ok),
      detail: checks.drift ? String(checks.drift.reason || '') : 'missing'
    },
    {
      id: 'budget_governor',
      weight: 2,
      pass: budgetAutopauseActive !== true,
      detail: budgetAutopauseActive ? 'budget_autopause_active' : 'budget_guard_clear'
    },
    {
      id: 'execute_readiness',
      weight: 2,
      pass: bool(readiness.ready_for_execute),
      detail: bool(readiness.ready_for_execute) ? 'ready_for_execute' : 'not_ready'
    },
    {
      id: 'queue_hygiene',
      weight: 1,
      pass: !!queueTotals && Number(queueTotals.stale_open || 0) <= 0,
      detail: queueTotals ? `open=${Number(queueTotals.open || 0)} stale_open=${Number(queueTotals.stale_open || 0)}` : 'missing_queue_hygiene_summary'
    },
    {
      id: 'outcome_throughput',
      weight: 2,
      pass: Number(outcomes.executed || 0) >= 3 && Number(outcomes.shipped_rate || 0) >= 0.2,
      detail: `executed=${Number(outcomes.executed || 0)} shipped_rate=${Number(outcomes.shipped_rate || 0)}`
    }
  ];
  return criteria;
}

function scoreCriteria(criteria) {
  let weightTotal = 0;
  let weightPass = 0;
  const failed = [];
  for (const row of criteria) {
    const w = Math.max(1, Number(row.weight || 1));
    weightTotal += w;
    if (row.pass === true) weightPass += w;
    else failed.push(row.id);
  }
  const score = weightTotal > 0 ? weightPass / weightTotal : 0;
  return {
    score: Number(score.toFixed(3)),
    pass: score >= 0.75 && failed.length <= 2,
    failed
  };
}

function recommendActions(criteria, health, outcomes) {
  const failed = new Set(Array.isArray(criteria)
    ? criteria.filter((row) => row && row.pass !== true).map((row) => String(row.id || ''))
    : []);
  const actions = [];
  if (failed.has('security_integrity')) {
    actions.push('Reseal integrity policy and re-issue startup attestation before next spine run.');
  }
  if (failed.has('startup_attestation')) {
    actions.push('Issue startup attestation after integrity seal and verify signature/hash drift is clean.');
  }
  if (failed.has('budget_governor')) {
    actions.push('Clear or expire budget autopause, then re-run autonomy preview to verify executable path.');
  }
  if (failed.has('routing_health')) {
    actions.push('Run router doctor/probes and demote high-latency local models until escalation clears.');
  }
  if (failed.has('sensory_continuity')) {
    actions.push('Run queue hygiene + dark-eye remediation so proposal flow stays continuous.');
  }
  if (failed.has('drift_control')) {
    actions.push('Review drift report and lock unstable rules before next autonomous cycle.');
  }
  if (failed.has('execute_readiness')) {
    actions.push('Resolve readiness blockers and keep strategy mode in score_only until checks pass.');
  }
  if (failed.has('outcome_throughput') && Number(outcomes && outcomes.executed || 0) < 3) {
    actions.push('Run low-risk canary executions to raise executed sample size for outcome learning.');
  }
  if (!actions.length) {
    const integrityOk = !!(health && health.integrity_kernel && health.integrity_kernel.ok);
    actions.push(integrityOk
      ? 'Hold current policies and continue periodic checkpoint audits.'
      : 'Fix security/integrity drift before scaling autonomy.');
  }
  return actions.slice(0, 6);
}

function renderMarkdown(dateStr, checkpoint) {
  const lines = [];
  lines.push(`# V1 Hardening Checkpoint (${dateStr})`);
  lines.push('');
  lines.push(`Generated: ${checkpoint.generated_at}`);
  lines.push(`Window days: ${checkpoint.outcomes.window_days}`);
  lines.push('');
  lines.push('## Score');
  lines.push('');
  lines.push(`- Weighted score: **${checkpoint.score.score}**`);
  lines.push(`- Verdict: **${checkpoint.score.pass ? 'PASS' : 'HOLD'}**`);
  lines.push(`- Failed criteria: ${checkpoint.score.failed.length ? checkpoint.score.failed.join(', ') : 'none'}`);
  lines.push('');
  lines.push('## Criteria');
  lines.push('');
  lines.push('| Criterion | Pass | Weight | Detail |');
  lines.push('|---|---:|---:|---|');
  for (const row of checkpoint.criteria) {
    lines.push(`| ${row.id} | ${row.pass ? 'yes' : 'no'} | ${row.weight} | ${String(row.detail || '').replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  lines.push('## Outcome Window');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(checkpoint.outcomes, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- This checkpoint is for unattended-6-month V1 hardening readiness.');
  lines.push('- `budget_governor` must stay clear in unattended mode.');
  lines.push('- Re-run after major routing/security/autonomy policy changes.');
  lines.push('');
  lines.push('## Next Steps');
  lines.push('');
  for (const step of (Array.isArray(checkpoint.next_steps) ? checkpoint.next_steps : [])) {
    lines.push(`- ${step}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function shouldSkip(dateStr, intervalDays) {
  const state = readJson(STATE_PATH, {});
  const last = asMs(state && state.last_run_ts);
  if (last == null) return { skip: false, state };
  const nowMs = Date.parse(`${dateStr}T23:59:59.999Z`);
  const minGapMs = Math.max(1, intervalDays) * 24 * 60 * 60 * 1000;
  const ageMs = nowMs - last;
  if (ageMs < minGapMs) {
    return {
      skip: true,
      state,
      age_hours: Number((ageMs / 3600000).toFixed(2)),
      min_gap_hours: Number((minGapMs / 3600000).toFixed(2))
    };
  }
  return { skip: false, state };
}

function cmdRun(args) {
  const date = normalizeDate(args._[1]);
  const windowDays = toPositiveInt(args['window-days'], toPositiveInt(args.window_days, 14));
  const intervalDays = toPositiveInt(args['interval-days'], toPositiveInt(args.interval_days, 7));
  const force = String(args.force || '0') === '1';

  if (!force) {
    const gate = shouldSkip(date, intervalDays);
    if (gate.skip) {
      return {
        ok: true,
        result: 'skip_recent_run',
        date,
        interval_days: intervalDays,
        age_hours: gate.age_hours,
        min_gap_hours: gate.min_gap_hours,
        output_file: gate.state && gate.state.output_file ? String(gate.state.output_file) : null
      };
    }
  }

  const health = loadHealthReport(date);
  if (!health) {
    return { ok: false, error: 'health_report_unavailable', date };
  }
  const queueHygiene = loadQueueHygieneSummary();
  const outcomes = computeOutcomeWindow(date, windowDays);
  const criteria = buildCriteria(health, queueHygiene, outcomes);
  const score = scoreCriteria(criteria);
  const nextSteps = recommendActions(criteria, health, outcomes);
  const checkpoint = {
    ok: true,
    generated_at: nowIso(),
    date,
    outcomes,
    criteria,
    score,
    next_steps: nextSteps,
    health_report_ts: health.ts || null,
    queue_hygiene_summary_ts: queueHygiene && queueHygiene.ts ? String(queueHygiene.ts) : null
  };

  const outJson = path.join(OUT_DIR, `v1_hardening_checkpoint_${date}.json`);
  const outMd = path.join(OUT_DIR, `v1_hardening_checkpoint_${date}.md`);
  writeJson(outJson, checkpoint);
  writeText(outMd, renderMarkdown(date, checkpoint));
  writeJson(STATE_PATH, {
    version: '1.0',
    last_run_ts: nowIso(),
    last_date: date,
    output_file: outMd,
    output_json: outJson
  });

  return {
    ok: true,
    result: 'v1_hardening_checkpoint_written',
    date,
    score: checkpoint.score.score,
    pass: checkpoint.score.pass,
    failed: checkpoint.score.failed,
    next_steps: nextSteps,
    output_file: outMd,
    output_json: outJson
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/v1_hardening_checkpoint.js run [YYYY-MM-DD] [--window-days=14] [--interval-days=7] [--force=1]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  let out;
  if (cmd === 'run') out = cmdRun(args);
  else {
    usage();
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (!out || out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: String(err && err.message ? err.message : err || 'v1_hardening_checkpoint_failed')
    })}\n`);
    process.exit(1);
  }
}
