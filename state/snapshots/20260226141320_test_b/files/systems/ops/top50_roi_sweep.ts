#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

type Action = {
  id: string;
  command: string;
  roi_rank: number;
};

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'state', 'ops', 'roi_sweeps');
const DEFAULT_POLICY_PATH = process.env.TOP50_ROI_POLICY_PATH
  ? path.resolve(process.env.TOP50_ROI_POLICY_PATH)
  : path.join(ROOT, 'config', 'top50_roi_policy.json');
const DEFAULT_LOCK_PATH = path.join(OUT_DIR, '.top50.lock');
const DEFAULT_LOCK_TIMEOUT_MS = 12000;
const DEFAULT_LOCK_STALE_MS = 12 * 60 * 60 * 1000;

type SweepPolicy = {
  defaults: {
    timeout_ms: number;
    retries: number;
    retry_backoff_ms: number;
    commit_on_fail: boolean;
    commit_mode: 'all' | 'code_only';
    commit_include_prefixes: string[];
  };
  actions: Record<string, AnyObj>;
};

type ActionRuntimeConfig = {
  timeout_ms: number;
  retries: number;
  retry_backoff_ms: number;
  commit_on_fail: boolean;
  commit_mode: 'all' | 'code_only';
  commit_include_prefixes: string[];
};

function nowIso() {
  return new Date().toISOString();
}

function dateStamp() {
  return nowIso().slice(0, 10);
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureParent(filePath: string) {
  ensureDir(path.dirname(filePath));
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok).startsWith('--')) {
      out._.push(String(tok));
      continue;
    }
    const eq = String(tok).indexOf('=');
    if (eq === -1) out[String(tok).slice(2)] = true;
    else out[String(tok).slice(2, eq)] = String(tok).slice(eq + 1);
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

function toInt(v: unknown, fallback: number, lo = 0, hi = Number.MAX_SAFE_INTEGER) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function readJson(filePath: string, fallback: AnyObj) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return raw && typeof raw === 'object' ? raw : fallback;
  } catch {
    return fallback;
  }
}

function normalizeToken(v: unknown, maxLen = 160) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .slice(0, maxLen)
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeCommitMode(v: unknown): 'all' | 'code_only' {
  const t = normalizeToken(v, 40);
  if (t === 'all' || t === 'full') return 'all';
  return 'code_only';
}

function normalizePrefixList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const raw of v) {
    const s = String(raw == null ? '' : raw).trim().replace(/\\/g, '/');
    if (!s) continue;
    out.push(s);
  }
  return Array.from(new Set(out)).slice(0, 200);
}

function defaultPolicy(): SweepPolicy {
  return {
    defaults: {
      timeout_ms: 10 * 60 * 1000,
      retries: 0,
      retry_backoff_ms: 2500,
      commit_on_fail: false,
      commit_mode: 'code_only',
      commit_include_prefixes: [
        'systems',
        'lib',
        'config',
        'memory/tools/tests',
        'types',
        'package.json',
        'tsconfig.systems.json',
        'tsconfig.systems.build.json'
      ]
    },
    actions: {}
  };
}

function loadPolicy(policyPathRaw: unknown): SweepPolicy {
  const base = defaultPolicy();
  const policyPath = path.resolve(String(policyPathRaw || DEFAULT_POLICY_PATH));
  const raw = readJson(policyPath, {});
  const defaultsRaw = raw && typeof raw.defaults === 'object' ? raw.defaults : {};
  const actionsRaw = raw && typeof raw.actions === 'object' ? raw.actions : {};
  return {
    defaults: {
      timeout_ms: toInt(defaultsRaw.timeout_ms, base.defaults.timeout_ms, 1000, 60 * 60 * 1000),
      retries: toInt(defaultsRaw.retries, base.defaults.retries, 0, 5),
      retry_backoff_ms: toInt(defaultsRaw.retry_backoff_ms, base.defaults.retry_backoff_ms, 0, 5 * 60 * 1000),
      commit_on_fail: toBool(defaultsRaw.commit_on_fail, base.defaults.commit_on_fail),
      commit_mode: normalizeCommitMode(defaultsRaw.commit_mode || base.defaults.commit_mode),
      commit_include_prefixes: normalizePrefixList(defaultsRaw.commit_include_prefixes).length
        ? normalizePrefixList(defaultsRaw.commit_include_prefixes)
        : base.defaults.commit_include_prefixes
    },
    actions: actionsRaw && typeof actionsRaw === 'object' ? actionsRaw : {}
  };
}

function sleepMs(ms: number) {
  const waitMs = Math.max(0, Number(ms || 0));
  if (waitMs <= 0) return;
  const buf = new SharedArrayBuffer(4);
  const view = new Int32Array(buf);
  Atomics.wait(view, 0, 0, waitMs);
}

function acquireLock(lockPath: string, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS, staleMs = DEFAULT_LOCK_STALE_MS) {
  ensureParent(lockPath);
  const started = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      const payload = JSON.stringify({
        pid: process.pid,
        ts: nowIso(),
        cwd: ROOT
      });
      fs.writeFileSync(fd, `${payload}\n`, 'utf8');
      return { fd, lock_path: lockPath };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      let stale = false;
      try {
        const st = fs.statSync(lockPath);
        stale = (Date.now() - Number(st.mtimeMs || 0)) > staleMs;
      } catch {
        stale = false;
      }
      if (stale) {
        try {
          fs.rmSync(lockPath, { force: true });
          continue;
        } catch {}
      }
      if ((Date.now() - started) >= timeoutMs) {
        throw new Error(`top50_lock_timeout:${lockPath}`);
      }
      sleepMs(120);
    }
  }
}

function releaseLock(lock: AnyObj) {
  if (!lock || typeof lock !== 'object') return;
  try {
    if (Number.isInteger(lock.fd)) fs.closeSync(lock.fd);
  } catch {}
  try {
    if (lock.lock_path) fs.rmSync(String(lock.lock_path), { force: true });
  } catch {}
}

function runShell(command: string, opts: AnyObj = {}) {
  const startedAt = Date.now();
  const proc = spawnSync('zsh', ['-lc', command], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: toInt(opts.max_buffer, 32 * 1024 * 1024, 1024, 512 * 1024 * 1024),
    timeout: toInt(opts.timeout_ms, 0, 0, 24 * 60 * 60 * 1000) || undefined
  });
  const endedAt = Date.now();
  const timedOut = !!(proc.error && String(proc.error.message || '').includes('ETIMEDOUT'));
  return {
    ok: proc.status === 0 && !timedOut,
    code: proc.status,
    signal: proc.signal || null,
    timed_out: timedOut,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    duration_ms: endedAt - startedAt
  };
}

function sanitizeCommitText(input: string, maxLen = 80) {
  const v = String(input || '')
    .replace(/[^a-zA-Z0-9_.:/ -]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!v) return 'roi_action';
  return v.slice(0, maxLen);
}

function gitAddCommandForMode(commitMode: 'all' | 'code_only', includePrefixes: string[]) {
  if (commitMode === 'all') return 'git add -A';
  const candidates = [];
  for (const p of Array.isArray(includePrefixes) ? includePrefixes : []) {
    const clean = String(p || '').trim();
    if (!clean) continue;
    const abs = path.resolve(ROOT, clean);
    if (!abs.startsWith(ROOT)) continue;
    if (!fs.existsSync(abs)) continue;
    candidates.push(clean.replace(/\\/g, '/'));
  }
  if (!candidates.length) return 'git add -A';
  const escaped = candidates.map((s) => `"${s.replace(/"/g, '\\"')}"`);
  return `git add -A -- ${escaped.join(' ')}`;
}

function commitIfDirty(stepLabel: string, opts: ActionRuntimeConfig) {
  const add = runShell(gitAddCommandForMode(opts.commit_mode, opts.commit_include_prefixes), { timeout_ms: 120000 });
  if (!add.ok) {
    return {
      committed: false,
      ok: false,
      reason: 'git_add_failed',
      details: add.stderr || add.stdout || `exit_${String(add.code)}`
    };
  }
  const staged = runShell('git diff --cached --quiet', { timeout_ms: 120000 });
  // `git diff --cached --quiet` returns 0 when no staged changes, 1 when there are staged changes.
  if (staged.code === 0) {
    return { committed: false, ok: true, reason: 'no_changes', commit_sha: null };
  }
  if (staged.code !== 1) {
    return {
      committed: false,
      ok: false,
      reason: 'git_diff_cached_failed',
      details: staged.stderr || staged.stdout || `exit_${String(staged.code)}`
    };
  }
  const safe = sanitizeCommitText(stepLabel, 72);
  const commit = runShell(`git commit -m "ROI: ${safe}"`, { timeout_ms: 120000 });
  if (!commit.ok) {
    return {
      committed: false,
      ok: false,
      reason: 'git_commit_failed',
      details: commit.stderr || commit.stdout || `exit_${String(commit.code)}`
    };
  }
  const sha = runShell('git rev-parse --short HEAD', { timeout_ms: 120000 });
  return {
    committed: true,
    ok: true,
    reason: 'committed',
    commit_sha: String(sha.stdout || '').trim() || null
  };
}

function actionsForToday(): Action[] {
  const d = dateStamp();
  return [
    { roi_rank: 1, id: 'typecheck_systems', command: 'npm run typecheck:systems' },
    { roi_rank: 2, id: 'ci_suite', command: 'npm run test:ci' },
    { roi_rank: 3, id: 'runtime_legacy_pairs', command: 'npm run runtime:dist:legacy' },
    { roi_rank: 4, id: 'runtime_verify', command: 'npm run runtime:dist:verify' },
    { roi_rank: 5, id: 'integrity_kernel_run', command: 'node systems/security/integrity_kernel.js run' },
    { roi_rank: 6, id: 'integrity_reseal_check', command: 'npm run integrity:check' },
    { roi_rank: 7, id: 'anti_sabotage_verify', command: 'npm run anti-sabotage:snapshot && npm run anti-sabotage:verify' },
    { roi_rank: 8, id: 'log_redaction_check', command: 'npm run security:logs:redaction:check' },
    { roi_rank: 9, id: 'model_health_recover', command: 'npm run ops:model-health:recover' },
    { roi_rank: 10, id: 'config_registry_run', command: 'npm run ops:config-registry' },
    { roi_rank: 11, id: 'workflow_closure', command: 'npm run ops:workflow-closure' },
    { roi_rank: 12, id: 'signal_deadlock_breaker', command: `node systems/ops/signal_slo_deadlock_breaker.js run ${d}` },
    { roi_rank: 13, id: 'external_eyes_slo', command: `node habits/scripts/external_eyes.js slo ${d}` },
    { roi_rank: 14, id: 'external_eyes_preflight', command: 'node habits/scripts/external_eyes.js preflight --strict' },
    { roi_rank: 15, id: 'autotest_sync', command: 'npm run autotest:sync' },
    { roi_rank: 16, id: 'autotest_run_changed', command: 'npm run autotest:run -- --run-timeout-ms=240000' },
    { roi_rank: 17, id: 'autotest_report_latest', command: 'npm run autotest:report' },
    { roi_rank: 18, id: 'autotest_pulse', command: 'npm run autotest:pulse -- --run-timeout-ms=120000' },
    { roi_rank: 19, id: 'autotest_status', command: 'npm run autotest:status' },
    { roi_rank: 20, id: 'organ_atrophy_scan', command: 'npm run organ:atrophy:scan' },
    { roi_rank: 21, id: 'organ_atrophy_status', command: 'npm run organ:atrophy:status' },
    { roi_rank: 22, id: 'cryonics_status', command: 'npm run cryonics:status' },
    { roi_rank: 23, id: 'cryonics_verify', command: 'npm run cryonics:verify' },
    { roi_rank: 24, id: 'cryonics_run', command: 'npm run cryonics:run' },
    { roi_rank: 25, id: 'autophagy_baseline_capture', command: 'npm run autophagy:baseline:capture' },
    { roi_rank: 26, id: 'autophagy_baseline_check', command: 'npm run autophagy:baseline:check' },
    { roi_rank: 27, id: 'autophagy_harvest', command: 'npm run autophagy:harvest' },
    { roi_rank: 28, id: 'autophagy_replay', command: 'npm run autophagy:replay' },
    { roi_rank: 29, id: 'autophagy_enqueue', command: 'npm run autophagy:enqueue' },
    { roi_rank: 30, id: 'autophagy_cycle', command: 'npm run autophagy:cycle' },
    { roi_rank: 31, id: 'autophagy_trial_status', command: 'npm run autophagy:trial:status' },
    { roi_rank: 32, id: 'physiology_map', command: 'npm run autonomy:physiology:map' },
    { roi_rank: 33, id: 'strategy_principles', command: 'npm run strategy:principles' },
    { roi_rank: 34, id: 'dual_brain_status', command: 'npm run dual-brain:status' },
    { roi_rank: 35, id: 'dual_brain_route', command: 'npm run dual-brain:route' },
    { roi_rank: 36, id: 'polyglot_status', command: 'npm run polyglot:status' },
    { roi_rank: 37, id: 'compliance_posture_strict', command: 'npm run compliance:posture:strict' },
    { roi_rank: 38, id: 'compliance_posture_status', command: 'npm run compliance:posture:status' },
    { roi_rank: 39, id: 'deploy_package_strict', command: 'npm run deploy:package' },
    { roi_rank: 40, id: 'deploy_package_status', command: 'npm run deploy:package:status' },
    { roi_rank: 41, id: 'merge_guard_fast', command: 'npm run guard:merge:fast' },
    { roi_rank: 42, id: 'docs_coverage_gate', command: 'npm run docs:coverage' },
    { roi_rank: 43, id: 'handoff_pack', command: 'npm run handoff:pack' },
    { roi_rank: 44, id: 'handoff_simulate', command: 'npm run handoff:simulate' },
    { roi_rank: 45, id: 'dr_gameday_status', command: 'npm run dr:gameday:status' },
    { roi_rank: 46, id: 'workflow_generate', command: 'npm run workflow:generate' },
    { roi_rank: 47, id: 'workflow_orchestron_run', command: 'npm run workflow:run' },
    { roi_rank: 48, id: 'workflow_execute', command: 'npm run workflow:execute' },
    { roi_rank: 49, id: 'simulation_30d', command: 'node systems/autonomy/autonomy_simulation_harness.js run --days=30 --write=1' },
    { roi_rank: 50, id: 'simulation_180d', command: 'node systems/autonomy/autonomy_simulation_harness.js run --days=180 --write=1' }
  ];
}

function runtimeConfigForAction(action: Action, args: AnyObj, policy: SweepPolicy): ActionRuntimeConfig {
  const override = policy && policy.actions && policy.actions[action.id] && typeof policy.actions[action.id] === 'object'
    ? policy.actions[action.id]
    : {};
  const defaults = policy.defaults;
  const commitModeRaw = args['commit-mode'] != null
    ? args['commit-mode']
    : (override.commit_mode != null ? override.commit_mode : defaults.commit_mode);
  const commitPrefixesRaw = Array.isArray(override.commit_include_prefixes)
    ? override.commit_include_prefixes
    : defaults.commit_include_prefixes;
  return {
    timeout_ms: toInt(
      args['timeout-ms'] != null ? args['timeout-ms'] : (override.timeout_ms != null ? override.timeout_ms : defaults.timeout_ms),
      defaults.timeout_ms,
      1000,
      24 * 60 * 60 * 1000
    ),
    retries: toInt(
      args.retries != null ? args.retries : (override.retries != null ? override.retries : defaults.retries),
      defaults.retries,
      0,
      8
    ),
    retry_backoff_ms: toInt(
      args['retry-backoff-ms'] != null ? args['retry-backoff-ms'] : (override.retry_backoff_ms != null ? override.retry_backoff_ms : defaults.retry_backoff_ms),
      defaults.retry_backoff_ms,
      0,
      10 * 60 * 1000
    ),
    commit_on_fail: toBool(
      args['commit-on-fail'] != null ? args['commit-on-fail'] : (override.commit_on_fail != null ? override.commit_on_fail : defaults.commit_on_fail),
      defaults.commit_on_fail
    ),
    commit_mode: normalizeCommitMode(commitModeRaw),
    commit_include_prefixes: normalizePrefixList(commitPrefixesRaw).length
      ? normalizePrefixList(commitPrefixesRaw)
      : defaults.commit_include_prefixes
  };
}

function runActionWithRetries(action: Action, runtimeCfg: ActionRuntimeConfig) {
  const attempts = [];
  for (let attempt = 1; attempt <= (runtimeCfg.retries + 1); attempt += 1) {
    const res = runShell(action.command, { timeout_ms: runtimeCfg.timeout_ms });
    attempts.push({
      attempt,
      ok: res.ok,
      code: res.code,
      signal: res.signal,
      timed_out: res.timed_out === true,
      duration_ms: res.duration_ms,
      stdout_tail: String(res.stdout || '').slice(-600),
      stderr_tail: String(res.stderr || '').slice(-600)
    });
    if (res.ok) {
      return {
        ...res,
        attempt_count: attempt,
        attempts
      };
    }
    if (attempt <= runtimeCfg.retries && runtimeCfg.retry_backoff_ms > 0) {
      sleepMs(runtimeCfg.retry_backoff_ms);
    }
  }
  const last = attempts[attempts.length - 1] || {};
  return {
    ok: false,
    code: last.code || 1,
    signal: last.signal || null,
    timed_out: last.timed_out === true,
    stdout: String(last.stdout_tail || ''),
    stderr: String(last.stderr_tail || ''),
    duration_ms: attempts.reduce((sum, row) => sum + Number(row.duration_ms || 0), 0),
    attempt_count: attempts.length,
    attempts
  };
}

function parseRankBound(v: unknown, fallback: number) {
  return toInt(v, fallback, 1, 50);
}

function writeJson(filePath: string, payload: AnyObj) {
  ensureParent(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = loadPolicy(args.policy || DEFAULT_POLICY_PATH);
  const continueOnFail = toBool(args['continue-on-fail'], true);
  const commitEach = toBool(args['commit-each'], true);
  const pushEnd = toBool(args['push-end'], true);
  const ephemeral = toBool(args.ephemeral, false);
  const startRank = parseRankBound(args['start-rank'], 1);
  const endRank = parseRankBound(args['end-rank'], 50);
  const maxActions = Number.isFinite(Number(args.max))
    ? Math.max(1, Math.min(50, Math.floor(Number(args.max))))
    : 50;
  const actions = actionsForToday()
    .filter((a) => a.roi_rank >= Math.min(startRank, endRank) && a.roi_rank <= Math.max(startRank, endRank))
    .slice(0, maxActions);
  ensureDir(OUT_DIR);
  const runId = `roi50_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const logPath = path.join(OUT_DIR, `${runId}.jsonl`);
  const summaryPath = path.join(OUT_DIR, `${runId}.json`);

  const rows: AnyObj[] = [];
  let failed = 0;
  const lock = acquireLock(path.resolve(String(args.lock_path || DEFAULT_LOCK_PATH)));

  try {
    for (const action of actions) {
      const runtimeCfg = runtimeConfigForAction(action, args, policy);
      const startedAt = nowIso();
      const res = runActionWithRetries(action, runtimeCfg);
      const endedAt = nowIso();
      const row: AnyObj = {
        run_id: runId,
        ts: endedAt,
        roi_rank: action.roi_rank,
        id: action.id,
        command: action.command,
        ok: res.ok,
        code: res.code,
        signal: res.signal,
        timed_out: res.timed_out === true,
        duration_ms: res.duration_ms,
        started_at: startedAt,
        ended_at: endedAt,
        timeout_ms: runtimeCfg.timeout_ms,
        retries: runtimeCfg.retries,
        retry_backoff_ms: runtimeCfg.retry_backoff_ms,
        attempt_count: Number(res.attempt_count || 1),
        attempts: Array.isArray(res.attempts) ? res.attempts : [],
        stdout_tail: String(res.stdout || '').slice(-600),
        stderr_tail: String(res.stderr || '').slice(-600),
        commit: null
      };
      if (commitEach) {
        if (res.ok || runtimeCfg.commit_on_fail) {
          const commitRes = commitIfDirty(`${String(action.roi_rank).padStart(2, '0')} ${action.id}`, runtimeCfg);
          row.commit = commitRes;
        } else {
          row.commit = {
            committed: false,
            ok: true,
            reason: 'skipped_failed_action',
            commit_sha: null
          };
        }
      }
      fs.appendFileSync(logPath, `${JSON.stringify(row)}\n`, 'utf8');
      rows.push(row);
      if (!res.ok) {
        failed += 1;
        if (!continueOnFail) break;
      }
      process.stdout.write(
        `[${String(action.roi_rank).padStart(2, '0')}/50] ${action.id} ok=${res.ok ? 'yes' : 'no'} ` +
        `dur=${res.duration_ms}ms` +
        `${res.timed_out ? ' timeout=1' : ''}` +
        `${res.attempt_count > 1 ? ` attempts=${res.attempt_count}` : ''}` +
        `${row.commit && row.commit.committed ? ` commit=${String(row.commit.commit_sha || '')}` : ''}\n`
      );
    }
  } finally {
    releaseLock(lock);
  }

  let push = null;
  if (pushEnd) {
    push = runShell('git push origin main', { timeout_ms: 5 * 60 * 1000 });
  }

  const summary = {
    ok: failed === 0,
    type: 'top50_roi_sweep',
    ts: nowIso(),
    run_id: runId,
    action_count: actions.length,
    rank_window: {
      start: startRank,
      end: endRank
    },
    passed: rows.filter((r) => r.ok === true).length,
    failed,
    failed_ids: rows.filter((r) => r.ok !== true).map((r) => r.id),
    commit_each: commitEach,
    continue_on_fail: continueOnFail,
    policy_path: path.relative(ROOT, String(args.policy || DEFAULT_POLICY_PATH)).replace(/\\/g, '/'),
    pushed: !!(push && push.ok),
    push_code: push ? push.code : null,
    push_stdout_tail: push ? String(push.stdout || '').slice(-600) : '',
    push_stderr_tail: push ? String(push.stderr || '').slice(-600) : '',
    log_path: path.relative(ROOT, logPath).replace(/\\/g, '/'),
    rows: rows.map((r) => ({
      roi_rank: r.roi_rank,
      id: r.id,
      ok: r.ok,
      code: r.code,
      timed_out: r.timed_out === true,
      duration_ms: r.duration_ms,
      attempts: Number(r.attempt_count || 1),
      commit_sha: r.commit && r.commit.commit_sha ? r.commit.commit_sha : null
    }))
  };
  writeJson(summaryPath, summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (ephemeral) {
    try { fs.rmSync(logPath, { force: true }); } catch {}
    try { fs.rmSync(summaryPath, { force: true }); } catch {}
  }
  if (summary.ok) process.exit(0);
  process.exit(1);
}

main();
