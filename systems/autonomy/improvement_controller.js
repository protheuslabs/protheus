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
 *   node systems/autonomy/improvement_controller.js start-validated [YYYY-MM-DD] --commit=<sha> [--trial-days=N] [--scorecard-days=N] [--auto-revert=1] [--verify-steps=contract,schema] [--note=...]
 *   node systems/autonomy/improvement_controller.js evaluate [YYYY-MM-DD] [--id=<trial_id>] [--force=1] [--auto-revert=1]
 *   node systems/autonomy/improvement_controller.js status [--id=<trial_id>]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeContractReceipt } = require('../../lib/action_receipts.js');
const { beginChange, completeChange, recoverIfInterrupted, writeAtomicJson } = require('./self_change_failsafe');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AUTONOMY_CONTROLLER_PATH = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const POLICY_ROOT_SCRIPT = path.join(REPO_ROOT, 'systems', 'security', 'policy_rootd.js');

const IMPROVEMENT_DIR = path.join(REPO_ROOT, 'state', 'autonomy', 'improvements');
const TRIALS_PATH = path.join(IMPROVEMENT_DIR, 'trials.json');
const EVENTS_PATH = path.join(IMPROVEMENT_DIR, 'events.jsonl');
const REVERT_TX_PATH = path.join(IMPROVEMENT_DIR, 'revert_tx.json');
const PHASE_RECEIPTS_DIR = path.join(IMPROVEMENT_DIR, 'phase_receipts');

const DEFAULT_TRIAL_DAYS = Number(process.env.IMPROVEMENT_DEFAULT_TRIAL_DAYS || 3);
const DEFAULT_SCORECARD_DAYS = Number(process.env.IMPROVEMENT_SCORECARD_DAYS || 7);
const DEFAULT_MIN_ATTEMPTS = Number(process.env.IMPROVEMENT_MIN_ATTEMPTS || 3);
const DEFAULT_MAX_REVERTED_RATE = Number(process.env.IMPROVEMENT_MAX_REVERTED_RATE || 0.15);
const DEFAULT_MAX_SHIP_RATE_REGRESSION = Number(process.env.IMPROVEMENT_MAX_SHIP_RATE_REGRESSION || 0.05);
const DEFAULT_MAX_NO_PROGRESS_DELTA = Number(process.env.IMPROVEMENT_MAX_NO_PROGRESS_DELTA || 0.1);
const IMPROVEMENT_VERIFY_STEP_TIMEOUT_MS = Number(process.env.IMPROVEMENT_VERIFY_STEP_TIMEOUT_MS || 120000);
const IMPROVEMENT_VERIFY_STDOUT_MAX = Number(process.env.IMPROVEMENT_VERIFY_STDOUT_MAX || 300);
const IMPROVEMENT_VERIFY_STDERR_MAX = Number(process.env.IMPROVEMENT_VERIFY_STDERR_MAX || 300);
const IMPROVEMENT_DEFAULT_VERIFY_STEPS = String(process.env.IMPROVEMENT_DEFAULT_VERIFY_STEPS || 'contract,schema');
const IMPROVEMENT_REQUIRE_POLICY_ROOT = String(process.env.IMPROVEMENT_REQUIRE_POLICY_ROOT || '1') !== '0';
const IMPROVEMENT_POLICY_ROOT_SCOPE = String(process.env.IMPROVEMENT_POLICY_ROOT_SCOPE || 'autonomy_self_change_apply').trim() || 'autonomy_self_change_apply';

const VERIFY_STEP_LIBRARY = Object.freeze({
  contract: {
    id: 'contract_check',
    command: [process.execPath, path.join(REPO_ROOT, 'systems', 'spine', 'contract_check.js')]
  },
  schema: {
    id: 'schema_contract_check',
    command: [process.execPath, path.join(REPO_ROOT, 'systems', 'security', 'schema_contract_check.js'), 'run']
  },
  adaptive: {
    id: 'adaptive_layer_guard_strict',
    command: [process.execPath, path.join(REPO_ROOT, 'systems', 'sensory', 'adaptive_layer_guard.js'), 'run', '--strict']
  }
});

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

function compactText(v, maxLen) {
  const n = Number(maxLen);
  const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 240;
  return String(v == null ? '' : v)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function phaseReceiptPath(dateStr) {
  const day = isDateStr(dateStr) ? dateStr : todayStr();
  ensureDir(PHASE_RECEIPTS_DIR);
  return path.join(PHASE_RECEIPTS_DIR, `${day}.jsonl`);
}

function parseVerifyStepNames(raw) {
  const src = String(raw == null ? IMPROVEMENT_DEFAULT_VERIFY_STEPS : raw);
  return src
    .split(',')
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean);
}

function resolveVerifyStep(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  const def = VERIFY_STEP_LIBRARY[key];
  if (!def || !Array.isArray(def.command) || def.command.length < 1) return null;
  return {
    key,
    id: String(def.id || key),
    command: def.command.slice(0)
  };
}

function defaultVerifyPlan() {
  const names = parseVerifyStepNames(IMPROVEMENT_DEFAULT_VERIFY_STEPS);
  const seen = new Set();
  const out = [];
  for (const name of names) {
    const step = resolveVerifyStep(name);
    if (!step) continue;
    if (seen.has(step.id)) continue;
    seen.add(step.id);
    out.push(step);
  }
  if (out.length > 0) return out;
  return [resolveVerifyStep('contract'), resolveVerifyStep('schema')].filter(Boolean);
}

function verifyPlanFromCli() {
  const raw = String(optValue('verify-steps', IMPROVEMENT_DEFAULT_VERIFY_STEPS) || '');
  const names = parseVerifyStepNames(raw);
  if (!names.length) return defaultVerifyPlan();
  const seen = new Set();
  const out = [];
  for (const name of names) {
    const step = resolveVerifyStep(name);
    if (!step) continue;
    if (seen.has(step.id)) continue;
    seen.add(step.id);
    out.push(step);
  }
  return out.length > 0 ? out : defaultVerifyPlan();
}

function rootCauseFromVerification(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const failed = list.find((row) => row && row.ok !== true);
  if (!failed) return null;
  if (failed.error) return `verify_step_error:${String(failed.id || 'unknown')}`;
  return `verify_step_failed:${String(failed.id || 'unknown')}:exit_${Number(failed.exit_code || 1)}`;
}

function runVerificationPlan(steps, opts = {}) {
  const rows = Array.isArray(steps) ? steps : [];
  const runner = typeof opts.runner === 'function'
    ? opts.runner
    : (cmd, args) => spawnSync(cmd, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: IMPROVEMENT_VERIFY_STEP_TIMEOUT_MS
    });
  const stdoutMax = Number(opts.stdout_max || IMPROVEMENT_VERIFY_STDOUT_MAX);
  const stderrMax = Number(opts.stderr_max || IMPROVEMENT_VERIFY_STDERR_MAX);
  const results = [];
  for (const step of rows) {
    if (!step || !Array.isArray(step.command) || step.command.length < 1) continue;
    const cmd = String(step.command[0]);
    const args = step.command.slice(1).map((a) => String(a));
    const started = Date.now();
    const r = runner(cmd, args, step) || {};
    const exitCode = Number.isFinite(Number(r.status)) ? Number(r.status) : 1;
    const row = {
      id: String(step.id || 'unknown'),
      key: String(step.key || ''),
      command: [cmd, ...args].join(' '),
      exit_code: exitCode,
      ok: exitCode === 0,
      duration_ms: Math.max(0, Date.now() - started),
      stdout: compactText(r.stdout, stdoutMax),
      stderr: compactText(r.stderr, stderrMax),
      error: r.error ? compactText(r.error && r.error.message ? r.error.message : String(r.error), stderrMax) : null
    };
    results.push(row);
    if (!row.ok) break;
  }
  return {
    ok: results.length > 0 && results.every((row) => row.ok === true),
    steps: results,
    root_cause: rootCauseFromVerification(results)
  };
}

function runPolicyRootAuthorize({ scope, target, leaseToken, approvalNote, source }) {
  const args = [
    POLICY_ROOT_SCRIPT,
    'authorize',
    `--scope=${String(scope || '').trim()}`,
    `--target=${String(target || '').trim()}`,
    `--approval-note=${String(approvalNote || '').trim()}`
  ];
  if (leaseToken) args.push(`--lease-token=${String(leaseToken).trim()}`);
  if (source) args.push(`--source=${String(source).trim()}`);
  const r = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });
  const stdout = String(r.stdout || '').trim();
  const stderr = String(r.stderr || '').trim();
  let payload = null;
  if (stdout) {
    try { payload = JSON.parse(stdout); } catch {}
  }
  return {
    ok: r.status === 0 && payload && payload.ok === true && payload.decision === 'ALLOW',
    code: Number(r.status || 0),
    payload,
    stdout,
    stderr
  };
}

function policyRootDecision(input = {}, runner = runPolicyRootAuthorize) {
  const required = IMPROVEMENT_REQUIRE_POLICY_ROOT === true;
  const scope = compactText(input.scope || IMPROVEMENT_POLICY_ROOT_SCOPE, 120) || 'autonomy_self_change_apply';
  const target = compactText(input.target || '', 240) || null;
  const leaseToken = compactText(input.lease_token || input.leaseToken || '', 8192);
  const approvalNote = compactText(input.approval_note || input.approvalNote || '', 320);
  const source = compactText(input.source || 'improvement_controller:start-validated', 120);

  if (!required) {
    return {
      required: false,
      ok: true,
      scope,
      target,
      reason: 'policy_root_disabled',
      payload: null
    };
  }

  const auth = runner({
    scope,
    target,
    leaseToken,
    approvalNote,
    source
  }) || {};
  const payload = auth && auth.payload && typeof auth.payload === 'object'
    ? auth.payload
    : null;
  const reason = payload && payload.reason
    ? String(payload.reason)
    : compactText(auth.stderr || auth.stdout || `policy_root_exit_${Number(auth.code || 1)}`, 180);
  return {
    required: true,
    ok: auth.ok === true,
    scope,
    target,
    lease_provided: leaseToken.length > 0,
    reason,
    payload
  };
}

function markRevertTx(payload) {
  saveJson(REVERT_TX_PATH, {
    active: true,
    ts: nowIso(),
    ...payload
  });
}

function clearRevertTx(extra = {}) {
  saveJson(REVERT_TX_PATH, {
    active: false,
    cleared_ts: nowIso(),
    ...extra
  });
}

function loadRevertTx() {
  const tx = loadJson(REVERT_TX_PATH, null);
  if (!tx || typeof tx !== 'object') return null;
  return tx;
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

function isCommitOnHead(commit) {
  const r = runGit(['merge-base', '--is-ancestor', commit, 'HEAD']);
  return r.status === 0;
}

function trialsStore() {
  const raw = loadJson(TRIALS_PATH, { trials: [] });
  if (!raw || !Array.isArray(raw.trials)) return { trials: [] };
  return raw;
}

function saveTrialsStore(store) {
  const snapshot = `${TRIALS_PATH}.bak-${Date.now()}`;
  if (fs.existsSync(TRIALS_PATH)) fs.copyFileSync(TRIALS_PATH, snapshot);
  else fs.writeFileSync(snapshot, JSON.stringify({ trials: [] }, null, 2) + '\n', 'utf8');
  const changeId = `improvement_trials:${Date.now()}`;
  beginChange({
    id: changeId,
    kind: 'improvement_trials_write',
    target_path: TRIALS_PATH,
    snapshot_path: fs.existsSync(snapshot) ? snapshot : TRIALS_PATH,
    note: 'save_trials_store'
  });
  try {
    writeAtomicJson(TRIALS_PATH, store);
    completeChange(changeId, { file: 'trials.json' });
  } catch (err) {
    try {
      if (fs.existsSync(snapshot)) fs.copyFileSync(snapshot, TRIALS_PATH);
      completeChange(changeId, { file: 'trials.json', reverted: true, reason: 'write_error' });
    } catch {}
    throw err;
  } finally {
    try { if (fs.existsSync(snapshot)) fs.unlinkSync(snapshot); } catch {}
  }
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
  markRevertTx({ commit, phase: 'preflight' });
  const status = runGit(['status', '--porcelain']);
  if (status.status !== 0) {
    clearRevertTx({ commit, result: 'status_failed' });
    return { ok: false, reason: 'git_status_failed', detail: String(status.stderr || '').trim() };
  }
  if (String(status.stdout || '').trim()) {
    clearRevertTx({ commit, result: 'working_tree_dirty' });
    return { ok: false, reason: 'working_tree_dirty' };
  }

  markRevertTx({ commit, phase: 'revert_running' });
  const rev = runGit(['revert', '--no-edit', commit]);
  if (rev.status !== 0) {
    clearRevertTx({ commit, result: 'revert_failed' });
    return {
      ok: false,
      reason: 'git_revert_failed',
      detail: String(rev.stderr || rev.stdout || '').trim().slice(0, 400)
    };
  }
  const head = runGit(['rev-parse', '--short', 'HEAD']);
  clearRevertTx({ commit, result: head.status === 0 ? 'reverted' : 'reverted_unknown_head' });
  return {
    ok: head.status === 0,
    reason: head.status === 0 ? 'reverted' : 'reverted_unknown_head',
    revert_commit: String(head.stdout || '').trim() || null
  };
}

function recoverInterruptedRevert() {
  const tx = loadRevertTx();
  if (!tx || tx.active !== true) return { recovered: false, reason: 'no_active_revert_tx' };

  const abort = runGit(['revert', '--abort']);
  if (abort.status === 0) {
    clearRevertTx({ recovered: true, result: 'revert_abort_ok', commit: tx.commit || null });
    appendJsonl(EVENTS_PATH, {
      ts: nowIso(),
      type: 'improvement_revert_recovered',
      method: 'git_revert_abort',
      commit: tx.commit || null
    });
    return { recovered: true, method: 'git_revert_abort', commit: tx.commit || null };
  }

  const errText = String(abort.stderr || abort.stdout || '').toLowerCase();
  if (errText.includes('no revert in progress') || errText.includes('revert is not possible')) {
    clearRevertTx({ recovered: true, result: 'no_revert_in_progress', commit: tx.commit || null });
    appendJsonl(EVENTS_PATH, {
      ts: nowIso(),
      type: 'improvement_revert_recovered',
      method: 'no_revert_in_progress',
      commit: tx.commit || null
    });
    return { recovered: true, method: 'no_revert_in_progress', commit: tx.commit || null };
  }

  appendJsonl(EVENTS_PATH, {
    ts: nowIso(),
    type: 'improvement_revert_recovery_failed',
    commit: tx.commit || null,
    detail: String(abort.stderr || abort.stdout || '').trim().slice(0, 400)
  });
  return {
    recovered: false,
    reason: 'revert_abort_failed',
    detail: String(abort.stderr || abort.stdout || '').trim().slice(0, 400),
    commit: tx.commit || null
  };
}

function createTrialRecord(store, dateStr, options) {
  const trialDays = clampNumber(Number(options && options.trial_days), 1, 30);
  const scorecardDays = clampNumber(Number(options && options.scorecard_days), 1, 30);
  const autoRevert = options && options.auto_revert === true;
  const commit = String(options && options.commit || '').trim();
  const note = compactText(options && options.note || '', 240);
  const thresholds = options && options.thresholds ? options.thresholds : trialThresholds();
  const baseline = scorecard(dateStr, scorecardDays);
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
  return trial;
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
  const autoRevert = optEnabled('auto-revert', false);
  const note = compactText(optValue('note', ''), 240);
  const thresholds = trialThresholds();
  const trial = createTrialRecord(store, dateStr, {
    commit,
    trial_days: trialDays,
    scorecard_days: scorecardDays,
    auto_revert: autoRevert,
    note,
    thresholds
  });

  process.stdout.write(JSON.stringify({
    ok: true,
    result: 'trial_started',
    trial,
    ts: nowIso()
  }) + '\n');
}

function writeTwoPhaseReceipt(dateStr, payload, verified) {
  const record = {
    ts: nowIso(),
    type: 'improvement_two_phase_execution',
    ...payload
  };
  writeContractReceipt(phaseReceiptPath(dateStr), record, {
    attempted: true,
    verified: verified === true
  });
}

function startValidatedCmd(dateStr) {
  const store = trialsStore();
  const existing = store.trials.find(t => t && t.status === 'running');
  if (existing) {
    const rootCause = 'running_trial_exists';
    const out = {
      ok: false,
      error: rootCause,
      running_trial_id: existing.id,
      ts: nowIso()
    };
    writeTwoPhaseReceipt(dateStr, {
      verdict: 'fail',
      root_cause: rootCause,
      phases: {
        plan: { ok: false, reason: rootCause },
        apply: { ok: false, skipped: true },
        verify: { ok: false, skipped: true },
        commit: { ok: false, skipped: true }
      }
    }, false);
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(2);
  }

  const commit = resolveCommit(optValue('commit', ''));
  if (!verifyCommitExists(commit)) {
    const rootCause = `unknown_commit:${commit}`;
    const out = {
      ok: false,
      error: rootCause,
      ts: nowIso()
    };
    writeTwoPhaseReceipt(dateStr, {
      verdict: 'fail',
      commit,
      root_cause: rootCause,
      phases: {
        plan: { ok: false, reason: rootCause },
        apply: { ok: false, skipped: true },
        verify: { ok: false, skipped: true },
        commit: { ok: false, skipped: true }
      }
    }, false);
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(2);
  }

  const trialDays = clampNumber(Number(optValue('trial-days', DEFAULT_TRIAL_DAYS)), 1, 30);
  const scorecardDays = clampNumber(Number(optValue('scorecard-days', DEFAULT_SCORECARD_DAYS)), 1, 30);
  const autoRevert = optEnabled('auto-revert', true);
  const note = compactText(optValue('note', ''), 240);
  const approvalNote = compactText(
    optValue('approval-note', note || `approve start-validated ${commit}`),
    320
  ) || `approve start-validated ${commit}`;
  const leaseToken = compactText(
    optValue('lease-token', process.env.CAPABILITY_LEASE_TOKEN || ''),
    8192
  );
  const thresholds = trialThresholds();
  const verifySteps = verifyPlanFromCli();
  const policyRoot = policyRootDecision({
    scope: IMPROVEMENT_POLICY_ROOT_SCOPE,
    target: `commit:${commit}`,
    leaseToken,
    approvalNote,
    source: 'improvement_controller:start-validated'
  });

  const phases = {
    plan: {
      ok: true,
      commit,
      trial_days: trialDays,
      scorecard_days: scorecardDays,
      verify_steps: verifySteps.map((s) => s.id),
      auto_revert: autoRevert,
      policy_root_scope: policyRoot.scope
    },
    policy_root: {
      required: policyRoot.required === true,
      ok: policyRoot.ok === true,
      scope: policyRoot.scope,
      target: policyRoot.target,
      reason: policyRoot.reason || null,
      lease_provided: policyRoot.lease_provided === true
    },
    apply: {
      ok: false,
      commit_exists: true,
      commit_on_head: false,
      skipped: false
    },
    verify: {
      ok: false,
      skipped: true,
      steps: []
    },
    commit: {
      ok: false,
      action: null
    }
  };

  let rootCause = null;
  if (policyRoot.required && !policyRoot.ok) {
    phases.apply.skipped = true;
    phases.apply.ok = false;
    rootCause = `policy_root_denied:${String(policyRoot.reason || 'denied')}`;
  } else {
    phases.apply.commit_on_head = isCommitOnHead(commit);
    phases.apply.ok = phases.apply.commit_exists && phases.apply.commit_on_head;

    if (!phases.apply.ok) {
      rootCause = phases.apply.commit_on_head ? 'apply_failed' : 'apply_commit_not_on_head';
    } else {
      const verify = runVerificationPlan(verifySteps);
      phases.verify = {
        ok: verify.ok,
        skipped: false,
        steps: verify.steps
      };
      if (!verify.ok) rootCause = verify.root_cause || 'verify_failed';
    }
  }

  let revertResult = null;
  let trial = null;

  if (!rootCause) {
    trial = createTrialRecord(store, dateStr, {
      commit,
      trial_days: trialDays,
      scorecard_days: scorecardDays,
      auto_revert: autoRevert,
      note,
      thresholds
    });
    phases.commit = {
      ok: true,
      action: 'trial_started',
      trial_id: trial.id
    };
  } else if (autoRevert && phases.apply.ok) {
    revertResult = gitRevert(commit);
    phases.commit = {
      ok: revertResult.ok === true,
      action: 'auto_revert',
      revert: revertResult
    };
    if (revertResult.ok !== true) {
      rootCause = `rollback_failed:${String(revertResult.reason || 'unknown')}`;
    }
  } else {
    phases.commit = {
      ok: false,
      action: 'blocked_no_revert'
    };
  }

  appendJsonl(EVENTS_PATH, {
    ts: nowIso(),
    type: 'improvement_two_phase_executed',
    commit,
    ok: !rootCause,
    policy_root: {
      required: policyRoot.required === true,
      ok: policyRoot.ok === true,
      reason: policyRoot.reason || null,
      scope: policyRoot.scope
    },
    root_cause: rootCause,
    auto_revert: autoRevert,
    trial_id: trial ? trial.id : null,
    revert: revertResult
  });

  const success = !rootCause && trial != null;
  writeTwoPhaseReceipt(dateStr, {
    verdict: success ? 'pass' : 'fail',
    commit,
    root_cause: rootCause,
    auto_revert: autoRevert,
    trial_id: trial ? trial.id : null,
    phases,
    revert: revertResult
  }, success);

  if (!success) {
    process.stdout.write(JSON.stringify({
      ok: false,
      result: 'start_validated_failed',
      commit,
      root_cause: rootCause,
      policy_root: phases.policy_root,
      auto_revert: autoRevert,
      phases,
      revert: revertResult,
      ts: nowIso()
    }) + '\n');
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    result: 'trial_started_validated',
    commit,
    trial,
    policy_root: phases.policy_root,
    phases,
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
  console.log('  node systems/autonomy/improvement_controller.js start-validated [YYYY-MM-DD] --commit=<sha> [--trial-days=N] [--scorecard-days=N] [--auto-revert=1] [--verify-steps=contract,schema] [--note=...]');
  console.log('  node systems/autonomy/improvement_controller.js evaluate [YYYY-MM-DD] [--id=<trial_id>] [--force=1] [--auto-revert=1]');
  console.log('  node systems/autonomy/improvement_controller.js status [--id=<trial_id>]');
}

function main() {
  ensureState();
  // Startup recovery: revert any interrupted transactional self-change before proceeding.
  recoverIfInterrupted();
  recoverInterruptedRevert();
  const cmd = process.argv[2] || '';
  const dateStr = isDateStr(process.argv[3]) ? process.argv[3] : todayStr();

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    process.exit(0);
  }

  if (cmd === 'start') return startCmd(dateStr);
  if (cmd === 'start-validated') return startValidatedCmd(dateStr);
  if (cmd === 'evaluate') return evaluateCmd(dateStr);
  if (cmd === 'status') return statusCmd();

  usage();
  process.exit(2);
}

if (require.main === module) main();
module.exports = {
  evaluateMetrics,
  elapsedDaysInclusive,
  addDays,
  defaultVerifyPlan,
  runVerificationPlan,
  rootCauseFromVerification,
  runPolicyRootAuthorize,
  policyRootDecision
};
