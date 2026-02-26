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

function nowIso() {
  return new Date().toISOString();
}

function dateStamp() {
  return nowIso().slice(0, 10);
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
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

function runShell(command: string) {
  const startedAt = Date.now();
  const proc = spawnSync('zsh', ['-lc', command], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
  const endedAt = Date.now();
  return {
    ok: proc.status === 0,
    code: proc.status,
    signal: proc.signal || null,
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

function commitIfDirty(stepLabel: string) {
  const add = runShell('git add -A');
  if (!add.ok) {
    return {
      committed: false,
      ok: false,
      reason: 'git_add_failed',
      details: add.stderr || add.stdout || `exit_${String(add.code)}`
    };
  }
  const staged = runShell('git diff --cached --quiet');
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
  const commit = runShell(`git commit -m "ROI: ${safe}"`);
  if (!commit.ok) {
    return {
      committed: false,
      ok: false,
      reason: 'git_commit_failed',
      details: commit.stderr || commit.stdout || `exit_${String(commit.code)}`
    };
  }
  const sha = runShell('git rev-parse --short HEAD');
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
    { roi_rank: 7, id: 'anti_sabotage_verify', command: 'npm run anti-sabotage:verify' },
    { roi_rank: 8, id: 'log_redaction_check', command: 'npm run security:logs:redaction:check' },
    { roi_rank: 9, id: 'model_health_recover', command: 'npm run ops:model-health:recover' },
    { roi_rank: 10, id: 'config_registry_run', command: 'npm run ops:config-registry' },
    { roi_rank: 11, id: 'workflow_closure', command: 'npm run ops:workflow-closure' },
    { roi_rank: 12, id: 'signal_deadlock_breaker', command: `node systems/ops/signal_slo_deadlock_breaker.js run ${d}` },
    { roi_rank: 13, id: 'external_eyes_slo', command: `node habits/scripts/external_eyes.js slo ${d}` },
    { roi_rank: 14, id: 'external_eyes_preflight', command: 'node habits/scripts/external_eyes.js preflight --strict' },
    { roi_rank: 15, id: 'autotest_sync', command: 'npm run autotest:sync' },
    { roi_rank: 16, id: 'autotest_run_changed', command: 'npm run autotest:run' },
    { roi_rank: 17, id: 'autotest_report_latest', command: 'npm run autotest:report' },
    { roi_rank: 18, id: 'autotest_pulse', command: 'npm run autotest:pulse' },
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

function writeJson(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const continueOnFail = toBool(args['continue-on-fail'], true);
  const commitEach = toBool(args['commit-each'], true);
  const pushEnd = toBool(args['push-end'], true);
  const maxActions = Number.isFinite(Number(args.max))
    ? Math.max(1, Math.min(50, Math.floor(Number(args.max))))
    : 50;
  const actions = actionsForToday().slice(0, maxActions);
  ensureDir(OUT_DIR);
  const runId = `roi50_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const logPath = path.join(OUT_DIR, `${runId}.jsonl`);
  const summaryPath = path.join(OUT_DIR, `${runId}.json`);

  const rows: AnyObj[] = [];
  let failed = 0;

  for (const action of actions) {
    const startedAt = nowIso();
    const res = runShell(action.command);
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
      duration_ms: res.duration_ms,
      started_at: startedAt,
      ended_at: endedAt,
      stdout_tail: String(res.stdout || '').slice(-600),
      stderr_tail: String(res.stderr || '').slice(-600),
      commit: null
    };
    if (commitEach) {
      const commitRes = commitIfDirty(`${String(action.roi_rank).padStart(2, '0')} ${action.id}`);
      row.commit = commitRes;
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
      `${row.commit && row.commit.committed ? ` commit=${String(row.commit.commit_sha || '')}` : ''}\n`
    );
  }

  let push = null;
  if (pushEnd) {
    push = runShell('git push origin main');
  }

  const summary = {
    ok: failed === 0,
    type: 'top50_roi_sweep',
    ts: nowIso(),
    run_id: runId,
    action_count: actions.length,
    passed: rows.filter((r) => r.ok === true).length,
    failed,
    commit_each: commitEach,
    continue_on_fail: continueOnFail,
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
      duration_ms: r.duration_ms,
      commit_sha: r.commit && r.commit.commit_sha ? r.commit.commit_sha : null
    }))
  };
  writeJson(summaryPath, summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.ok) process.exit(0);
  process.exit(1);
}

main();
