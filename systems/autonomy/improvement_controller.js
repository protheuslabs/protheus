#!/usr/bin/env node
/**
 * improvement_controller.js — bounded self-improvement trial manager
 *
 * Purpose:
 * - Run changes through a fixed trial period before promotion
 * - Evaluate trial outcomes against autonomy KPI baseline
 * - Revert bad upgrades via git when trial fails (opt-in)
 *
 * Usage:
 *   node systems/autonomy/improvement_controller.js start [YYYY-MM-DD] --commit=<sha> [--trial-days=N] [--scorecard-days=N] [--auto-revert=1] [--note=...]
 *   node systems/autonomy/improvement_controller.js evaluate [YYYY-MM-DD] [--id=<trial_id>] [--force=1] [--auto-revert=1]
 *   node systems/autonomy/improvement_controller.js status [--id=<trial_id>]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AUTONOMY_CONTROLLER_PATH = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');

const IMPROVEMENT_DIR = path.join(REPO_ROOT, 'state', 'autonomy', 'improvements');
const TRIALS_PATH = path.join(IMPROVEMENT_DIR, 'trials.json');
const EVENTS_PATH = path.join(IMPROVEMENT_DIR, 'events.jsonl');

const DEFAULT_TRIAL_DAYS = Number(process.env.IMPROVEMENT_DEFAULT_TRIAL_DAYS || 3);
const DEFAULT_SCORECARD_DAYS = Number(process.env.IMPROVEMENT_SCORECARD_DAYS || 7);
const DEFAULT_MIN_ATTEMPTS = Number(process.env.IMPROVEMENT_MIN_ATTEMPTS || 3);
const DEFAULT_MAX_REVERTED_RATE = Number(process.env.IMPROVEMENT_MAX_REVERTED_RATE || 0.15);
const DEFAULT_MAX_SHIP_RATE_REGRESSION = Number(process.env.IMPROVEMENT_MAX_SHIP_RATE_REGRESSION || 0.05);
const DEFAULT_MAX_NO_PROGRESS_DELTA = Number(process.env.IMPROVEMENT_MAX_NO_PROGRESS_DELTA || 0.1);

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function isDateStr(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

function clampNumber(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ensureState() {
  ensureDir(IMPROVEMENT_DIR);
}

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

function appendJsonl(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function optValue(name, fallback = null) {
  const pref = `--${name}=`;
  const fromEq = process.argv.find(a => a.startsWith(pref));
  if (fromEq) return fromEq.slice(pref.length);

  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    const nxt = process.argv[idx + 1];
    if (!String(nxt).startsWith('--')) return nxt;
    return '';
  }
  return fallback;
}

function optEnabled(name, fallback = false) {
  const v = optValue(name, null);
  if (v == null) return process.argv.includes(`--${name}`) ? true : fallback;
  if (v === '') return true;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function runNodeJson(absScript, args) {
  const r = spawnSync(process.execPath, [absScript, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`node ${path.relative(REPO_ROOT, absScript)} ${args.join(' ')} failed: ${String(r.stderr || '').trim()}`);
  }
  const out = String(r.stdout || '').trim();
  if (!out) throw new Error(`no stdout from ${path.relative(REPO_ROOT, absScript)}`);
  return JSON.parse(out);
}

function scorecard(dateStr, days) {
  return runNodeJson(AUTONOMY_CONTROLLER_PATH, ['scorecard', dateStr, `--days=${days}`]);
}

function runGit(args) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

function resolveCommit(commitArg) {
  const commit = String(commitArg || '').trim();
  if (commit) return commit;
  const r = runGit(['rev-parse', '--short', 'HEAD']);
  if (r.status !== 0) throw new Error(`git rev-parse failed: ${String(r.stderr || '').trim()}`);
  return String(r.stdout || '').trim();
}

function verifyCommitExists(commit) {
  const r = runGit(['cat-file', '-e', `${commit}^{commit}`]);
  return r.status === 0;
}

function trialsStore() {
  const raw = loadJson(TRIALS_PATH, { trials: [] });
  if (!raw || !Array.isArray(raw.trials)) return { trials: [] };
  return raw;
}

function saveTrialsStore(store) {
  saveJson(TRIALS_PATH, store);
}

function addDays(dateStr, plusDays) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  if (isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + Number(plusDays || 0));
  return d.toISOString().slice(0, 10);
}

function elapsedDaysInclusive(startDate, endDate) {
  const s = new Date(`${startDate}T00:00:00.000Z`);
  const e = new Date(`${endDate}T00:00:00.000Z`);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return 0;
  const days = Math.floor((e.getTime() - s.getTime()) / (24 * 60 * 60 * 1000));
  return days + 1;
}

function findTrial(store, id) {
  if (!id) {
    const running = store.trials.filter(t => t && t.status === 'running');
    if (running.length) return running[running.length - 1];
    return store.trials.length ? store.trials[store.trials.length - 1] : null;
  }
  return store.trials.find(t => t && t.id === id) || null;
}

function replaceTrial(store, trial) {
  const idx = store.trials.findIndex(t => t && t.id === trial.id);
  if (idx < 0) store.trials.push(trial);
  else store.trials[idx] = trial;
}

function trialThresholds() {
  return {
    min_attempts: clampNumber(Number(optValue('min-attempts', DEFAULT_MIN_ATTEMPTS)), 1, 100),
    max_reverted_rate: clampNumber(Number(optValue('max-reverted-rate', DEFAULT_MAX_REVERTED_RATE)), 0, 1),
    max_ship_rate_regression: clampNumber(Number(optValue('max-ship-rate-regression', DEFAULT_MAX_SHIP_RATE_REGRESSION)), 0, 1),
    max_no_progress_delta: clampNumber(Number(optValue('max-no-progress-delta', DEFAULT_MAX_NO_PROGRESS_DELTA)), 0, 1)
  };
}

function evaluateMetrics(base, cur, thresholds) {
  const baseline = base && base.kpis ? base.kpis : {};
  const current = cur && cur.kpis ? cur.kpis : {};
  const sample = cur && cur.sample_size ? cur.sample_size : {};
  const reasons = [];

  const attempts = Number(sample.attempts || 0);
  const shipRateBase = Number(baseline.attempt_to_ship_rate || 0);
  const shipRateCur = Number(current.attempt_to_ship_rate || 0);
  const revRateCur = Number(current.reverted_rate || 0);
  const noProgBase = Number(baseline.no_progress_attempt_rate || 0);
  const noProgCur = Number(current.no_progress_attempt_rate || 0);

  if (attempts < Number(thresholds.min_attempts || 0)) reasons.push(`attempts_below_min:${attempts}<${thresholds.min_attempts}`);
  if (revRateCur > Number(thresholds.max_reverted_rate || 0)) reasons.push(`reverted_rate_high:${revRateCur.toFixed(3)}>${thresholds.max_reverted_rate}`);
  if (shipRateCur < (shipRateBase - Number(thresholds.max_ship_rate_regression || 0))) {
    reasons.push(`ship_rate_regressed:${shipRateCur.toFixed(3)}<${(shipRateBase - thresholds.max_ship_rate_regression).toFixed(3)}`);
  }
  if (noProgCur > (noProgBase + Number(thresholds.max_no_progress_delta || 0))) {
    reasons.push(`no_progress_worse:${noProgCur.toFixed(3)}>${(noProgBase + thresholds.max_no_progress_delta).toFixed(3)}`);
  }

  return {
    passed: reasons.length === 0,
    reasons,
    comparisons: {
      attempt_to_ship_rate: {
        baseline: Number(shipRateBase.toFixed(3)),
        current: Number(shipRateCur.toFixed(3)),
        delta: Number((shipRateCur - shipRateBase).toFixed(3))
      },
      reverted_rate: {
        baseline: Number(Number(baseline.reverted_rate || 0).toFixed(3)),
        current: Number(revRateCur.toFixed(3)),
        delta: Number((revRateCur - Number(baseline.reverted_rate || 0)).toFixed(3))
      },
      no_progress_attempt_rate: {
        baseline: Number(noProgBase.toFixed(3)),
        current: Number(noProgCur.toFixed(3)),
        delta: Number((noProgCur - noProgBase).toFixed(3))
      }
    }
  };
}

function gitRevert(commit) {
  const status = runGit(['status', '--porcelain']);
  if (status.status !== 0) {
    return { ok: false, reason: 'git_status_failed', detail: String(status.stderr || '').trim() };
  }
  if (String(status.stdout || '').trim()) {
    return { ok: false, reason: 'working_tree_dirty' };
  }

  const rev = runGit(['revert', '--no-edit', commit]);
  if (rev.status !== 0) {
    return {
      ok: false,
      reason: 'git_revert_failed',
      detail: String(rev.stderr || rev.stdout || '').trim().slice(0, 400)
    };
  }
  const head = runGit(['rev-parse', '--short', 'HEAD']);
  return {
    ok: head.status === 0,
    reason: head.status === 0 ? 'reverted' : 'reverted_unknown_head',
    revert_commit: String(head.stdout || '').trim() || null
  };
}

function startCmd(dateStr) {
  const store = trialsStore();
  const existing = store.trials.find(t => t && t.status === 'running');
  if (existing) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'running_trial_exists',
      running_trial_id: existing.id,
      ts: nowIso()
    }) + '\n');
    process.exit(2);
  }

  const commit = resolveCommit(optValue('commit', ''));
  if (!verifyCommitExists(commit)) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: `unknown_commit:${commit}`,
      ts: nowIso()
    }) + '\n');
    process.exit(2);
  }

  const trialDays = clampNumber(Number(optValue('trial-days', DEFAULT_TRIAL_DAYS)), 1, 30);
  const scorecardDays = clampNumber(Number(optValue('scorecard-days', DEFAULT_SCORECARD_DAYS)), 1, 30);
  const baseline = scorecard(dateStr, scorecardDays);
  const autoRevert = optEnabled('auto-revert', false);
  const note = String(optValue('note', '') || '').slice(0, 240);
  const thresholds = trialThresholds();

  const id = `trial_${Date.now()}_${String(commit).slice(0, 7)}`;
  const trial = {
    id,
    status: 'running',
    created_ts: nowIso(),
    start_date: dateStr,
    end_date: addDays(dateStr, trialDays - 1),
    trial_days: trialDays,
    scorecard_days: scorecardDays,
    commit,
    auto_revert: autoRevert,
    note,
    thresholds,
    baseline: {
      ts: baseline.ts,
      date: baseline.date,
      sample_size: baseline.sample_size,
      kpis: baseline.kpis,
      dominant_bottleneck: baseline.dominant_bottleneck || null
    },
    last_evaluation: null,
    outcome: null
  };

  store.trials.push(trial);
  saveTrialsStore(store);
  appendJsonl(EVENTS_PATH, {
    ts: nowIso(),
    type: 'improvement_trial_started',
    trial_id: id,
    commit,
    start_date: dateStr,
    end_date: trial.end_date,
    trial_days: trialDays,
    scorecard_days: scorecardDays,
    auto_revert: autoRevert
  });

  process.stdout.write(JSON.stringify({
    ok: true,
    result: 'trial_started',
    trial,
    ts: nowIso()
  }) + '\n');
}

function evaluateCmd(dateStr) {
  const store = trialsStore();
  const id = String(optValue('id', '') || '').trim();
  const force = optEnabled('force', false);
  const trial = findTrial(store, id);
  if (!trial) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'trial_not_found',
      requested_id: id || null,
      ts: nowIso()
    }) + '\n');
    process.exit(2);
  }

  const elapsed = elapsedDaysInclusive(trial.start_date, dateStr);
  const ready = elapsed >= Number(trial.trial_days || 0);
  const cur = scorecard(dateStr, Number(trial.scorecard_days || DEFAULT_SCORECARD_DAYS));
  const evalRes = evaluateMetrics(trial.baseline, cur, trial.thresholds || trialThresholds());

  const shouldAutoRevert = optEnabled('auto-revert', trial.auto_revert === true);
  let revertResult = null;
  let finalStatus = trial.status;

  if (!ready && !force) {
    trial.last_evaluation = {
      ts: nowIso(),
      date: dateStr,
      elapsed_days: elapsed,
      ready: false,
      force: false,
      passed_if_finalized: evalRes.passed,
      reasons: evalRes.reasons,
      comparisons: evalRes.comparisons
    };
    replaceTrial(store, trial);
    saveTrialsStore(store);
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'trial_in_progress',
      trial_id: trial.id,
      elapsed_days: elapsed,
      trial_days: trial.trial_days,
      days_remaining: Math.max(0, trial.trial_days - elapsed),
      passed_if_finalized: evalRes.passed,
      reasons: evalRes.reasons,
      comparisons: evalRes.comparisons,
      ts: nowIso()
    }) + '\n');
    return;
  }

  if (evalRes.passed) {
    finalStatus = 'promoted';
  } else if (shouldAutoRevert) {
    revertResult = gitRevert(trial.commit);
    finalStatus = revertResult.ok ? 'reverted' : 'failed_revert_pending';
  } else {
    finalStatus = 'failed';
  }

  trial.status = finalStatus;
  trial.last_evaluation = {
    ts: nowIso(),
    date: dateStr,
    elapsed_days: elapsed,
    ready: true,
    force: force === true,
    passed: evalRes.passed,
    reasons: evalRes.reasons,
    comparisons: evalRes.comparisons,
    should_auto_revert: shouldAutoRevert,
    revert: revertResult
  };
  trial.outcome = {
    ts: nowIso(),
    status: finalStatus,
    passed: evalRes.passed
  };
  if (finalStatus !== 'running') trial.completed_ts = nowIso();

  replaceTrial(store, trial);
  saveTrialsStore(store);
  appendJsonl(EVENTS_PATH, {
    ts: nowIso(),
    type: 'improvement_trial_evaluated',
    trial_id: trial.id,
    status: finalStatus,
    passed: evalRes.passed,
    reasons: evalRes.reasons,
    auto_revert: shouldAutoRevert,
    revert: revertResult
  });

  process.stdout.write(JSON.stringify({
    ok: true,
    result: 'trial_evaluated',
    trial_id: trial.id,
    status: finalStatus,
    passed: evalRes.passed,
    reasons: evalRes.reasons,
    comparisons: evalRes.comparisons,
    auto_revert: shouldAutoRevert,
    revert: revertResult,
    ts: nowIso()
  }) + '\n');
}

function statusCmd() {
  const store = trialsStore();
  const id = String(optValue('id', '') || '').trim();
  const trial = findTrial(store, id);
  const running = store.trials.filter(t => t && t.status === 'running').length;
  const recent = store.trials.slice(-5).map(t => ({
    id: t.id,
    status: t.status,
    commit: t.commit,
    start_date: t.start_date,
    end_date: t.end_date,
    completed_ts: t.completed_ts || null
  }));

  if (id && !trial) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'trial_not_found',
      requested_id: id,
      ts: nowIso()
    }) + '\n');
    process.exit(2);
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    running_trials: running,
    total_trials: store.trials.length,
    selected: trial,
    recent,
    ts: nowIso()
  }, null, 2) + '\n');
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/improvement_controller.js start [YYYY-MM-DD] --commit=<sha> [--trial-days=N] [--scorecard-days=N] [--auto-revert=1] [--note=...]');
  console.log('  node systems/autonomy/improvement_controller.js evaluate [YYYY-MM-DD] [--id=<trial_id>] [--force=1] [--auto-revert=1]');
  console.log('  node systems/autonomy/improvement_controller.js status [--id=<trial_id>]');
}

function main() {
  ensureState();
  const cmd = process.argv[2] || '';
  const dateStr = isDateStr(process.argv[3]) ? process.argv[3] : todayStr();

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    process.exit(0);
  }

  if (cmd === 'start') return startCmd(dateStr);
  if (cmd === 'evaluate') return evaluateCmd(dateStr);
  if (cmd === 'status') return statusCmd();

  usage();
  process.exit(2);
}

if (require.main === module) main();
module.exports = {
  evaluateMetrics,
  elapsedDaysInclusive,
  addDays
};

