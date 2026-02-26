#!/usr/bin/env node
'use strict';

/**
 * cleanup_orchestrator.js
 *
 * Central cleanup control plane for runtime churn:
 * - stale state cleanup
 * - OpenClaw backup retention
 * - optional cryonics compression tier
 *
 * Usage:
 *   node systems/ops/cleanup_orchestrator.js run [--profile=<id>] [--policy=<path>] [--apply=1|0] [--dry-run=1|0]
 *   node systems/ops/cleanup_orchestrator.js status
 *   node systems/ops/cleanup_orchestrator.js profiles [--policy=<path>]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(process.env.CLEANUP_ORCHESTRATOR_ROOT || path.join(__dirname, '..', '..'));
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'cleanup_orchestrator_policy.json');
const OUT_DIR = path.join(ROOT, 'state', 'ops', 'cleanup');
const LATEST_PATH = path.join(OUT_DIR, 'latest.json');
const HISTORY_PATH = path.join(OUT_DIR, 'history.jsonl');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/cleanup_orchestrator.js run [--profile=<id>] [--policy=<path>] [--apply=1|0] [--dry-run=1|0]');
  console.log('  node systems/ops/cleanup_orchestrator.js status');
  console.log('  node systems/ops/cleanup_orchestrator.js profiles [--policy=<path>]');
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

function boolFlag(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function boolOptional(v: unknown) {
  if (v == null) return null;
  return boolFlag(v, false);
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function cleanText(v: unknown, maxLen = 160) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return payload == null ? fallback : payload;
  } catch {
    return fallback;
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
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`);
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function parsePayload(stdout: string) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return null;
}

function runJson(command: string, args: string[], env: AnyObj = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      ...env
    },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  });
  const duration = Date.now() - started;
  const stdout = String(result && result.stdout || '').trim();
  const stderr = String(result && result.stderr || '').trim();
  const code = Number.isInteger(result && result.status) ? Number(result.status) : null;
  const payload = parsePayload(stdout);
  const ok = code === 0 && !!payload && payload.ok === true;
  return {
    ok,
    code,
    stdout,
    stderr,
    payload,
    duration_ms: duration
  };
}

function defaultPolicy() {
  return {
    version: '1.0',
    default_profile: 'spine_default',
    profiles: {
      spine_default: {
        description: 'Default spine cleanup profile (safe runtime churn control).',
        max_tasks_per_run: 8,
        stop_on_failure: false,
        tasks: [
          {
            id: 'state_cleanup',
            enabled: true,
            critical: false,
            apply: true,
            dry_run: false,
            params: {
              profile: 'runtime_churn',
              max_delete: 200
            }
          },
          {
            id: 'openclaw_backup_retention',
            enabled: true,
            critical: false,
            apply: true,
            dry_run: false,
            params: {
              keep: 20
            }
          },
          {
            id: 'cryonics_tier',
            enabled: false,
            critical: false,
            apply: false,
            dry_run: true,
            params: {
              profile: 'state_phase1',
              max_files: 400
            }
          }
        ]
      }
    }
  };
}

function loadPolicy(policyPathRaw: string | undefined, profileArg: string | undefined) {
  const policyPath = path.resolve(String(policyPathRaw || process.env.CLEANUP_ORCHESTRATOR_POLICY_PATH || DEFAULT_POLICY_PATH));
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const profiles = raw && raw.profiles && typeof raw.profiles === 'object'
    ? raw.profiles
    : base.profiles;
  const profileId = String(profileArg || raw.default_profile || base.default_profile).trim() || base.default_profile;
  const profile = profiles[profileId];
  if (!profile || typeof profile !== 'object') {
    throw new Error(`cleanup_profile_missing:${profileId}`);
  }
  const tasks = Array.isArray(profile.tasks) ? profile.tasks : [];
  const normalizedTasks = tasks
    .map((row) => ({
      id: cleanText(row && row.id || '', 60),
      enabled: row && row.enabled !== false,
      critical: row && row.critical === true,
      apply: row && row.apply !== false,
      dry_run: row && row.dry_run === true,
      params: row && row.params && typeof row.params === 'object' ? row.params : {}
    }))
    .filter((row) => row.id);
  return {
    path: policyPath,
    version: cleanText(raw.version || base.version, 24) || '1.0',
    profile: {
      id: profileId,
      description: cleanText(profile.description || '', 200),
      max_tasks_per_run: clampInt(profile.max_tasks_per_run, 1, 128, 8),
      stop_on_failure: profile.stop_on_failure === true,
      tasks: normalizedTasks
    }
  };
}

function applyTaskOverrides(task: AnyObj, globalRun: AnyObj) {
  const out = {
    ...task,
    params: {
      ...(task.params && typeof task.params === 'object' ? task.params : {})
    }
  };
  const forceDryRun = globalRun.force_dry_run === true;
  const applyOverride = globalRun.apply_override;
  const dryRunOverride = globalRun.dry_run_override;
  if (applyOverride != null) out.apply = applyOverride === true;
  if (dryRunOverride != null) out.dry_run = dryRunOverride === true;
  if (forceDryRun) {
    out.apply = false;
    out.dry_run = true;
  }

  if (out.id === 'state_cleanup') {
    out.enabled = out.enabled !== false && String(process.env.SPINE_STATE_CLEANUP_ENABLED || '1') !== '0';
    if (String(process.env.SPINE_STATE_CLEANUP_PROFILE || '').trim()) {
      out.params.profile = String(process.env.SPINE_STATE_CLEANUP_PROFILE).trim();
    }
    if (String(process.env.SPINE_STATE_CLEANUP_MAX_DELETE || '').trim()) {
      out.params.max_delete = Number(process.env.SPINE_STATE_CLEANUP_MAX_DELETE);
    }
    if (String(process.env.SPINE_STATE_CLEANUP_APPLY || '').trim()) {
      out.apply = boolFlag(process.env.SPINE_STATE_CLEANUP_APPLY, out.apply === true);
    }
    if (String(process.env.SPINE_STATE_CLEANUP_DRY_RUN || '').trim()) {
      out.dry_run = boolFlag(process.env.SPINE_STATE_CLEANUP_DRY_RUN, out.dry_run === true);
    }
  }

  if (out.id === 'openclaw_backup_retention') {
    out.enabled = out.enabled !== false && String(process.env.SPINE_OPENCLAW_BACKUP_RETENTION || '1') !== '0';
    if (String(process.env.OPENCLAW_BACKUP_ROOT || '').trim()) {
      out.params.root = String(process.env.OPENCLAW_BACKUP_ROOT).trim();
    }
    if (String(process.env.OPENCLAW_BACKUP_KEEP || '').trim()) {
      out.params.keep = Number(process.env.OPENCLAW_BACKUP_KEEP);
    }
    if (String(process.env.OPENCLAW_BACKUP_DRY_RUN || '').trim()) {
      out.dry_run = boolFlag(process.env.OPENCLAW_BACKUP_DRY_RUN, out.dry_run === true);
    }
  }

  if (out.id === 'cryonics_tier') {
    if (String(process.env.SPINE_CRYONICS_TIER_ENABLED || '').trim()) {
      out.enabled = out.enabled !== false && boolFlag(process.env.SPINE_CRYONICS_TIER_ENABLED, false);
    }
    if (String(process.env.SPINE_CRYONICS_TIER_PROFILE || '').trim()) {
      out.params.profile = String(process.env.SPINE_CRYONICS_TIER_PROFILE).trim();
    }
    if (String(process.env.SPINE_CRYONICS_TIER_MAX_FILES || '').trim()) {
      out.params.max_files = Number(process.env.SPINE_CRYONICS_TIER_MAX_FILES);
    }
    if (String(process.env.SPINE_CRYONICS_TIER_APPLY || '').trim()) {
      out.apply = boolFlag(process.env.SPINE_CRYONICS_TIER_APPLY, out.apply === true);
    }
    if (String(process.env.SPINE_CRYONICS_TIER_DRY_RUN || '').trim()) {
      out.dry_run = boolFlag(process.env.SPINE_CRYONICS_TIER_DRY_RUN, out.dry_run === true);
    }
  }

  if (out.dry_run === true) out.apply = false;
  if (forceDryRun) out.dry_run = true;
  return out;
}

function runStateCleanupTask(task: AnyObj) {
  const args = ['systems/ops/state_cleanup.js', 'run'];
  const profile = cleanText(task.params && task.params.profile || 'runtime_churn', 80) || 'runtime_churn';
  const maxDelete = clampInt(task.params && task.params.max_delete, 1, 50000, 200);
  args.push(`--profile=${profile}`);
  args.push(`--max-delete=${maxDelete}`);
  if (task.dry_run === true || task.apply !== true) args.push('--dry-run');
  else args.push('--apply');
  const r = runJson('node', args);
  return {
    id: task.id,
    ok: r.ok,
    code: r.code,
    duration_ms: r.duration_ms,
    apply: task.apply === true,
    dry_run: task.dry_run === true || task.apply !== true,
    args,
    payload: r.payload,
    stderr: cleanText(r.stderr || '', 240),
    stdout: cleanText(r.stdout || '', 240),
    summary: {
      candidates: Number(r.payload && r.payload.totals ? r.payload.totals.candidates || 0 : 0),
      selected: Number(r.payload && r.payload.totals ? r.payload.totals.selected || 0 : 0),
      deleted: Number(r.payload && r.payload.totals ? r.payload.totals.deleted || 0 : 0),
      protected_tracked: Number(r.payload && r.payload.totals ? r.payload.totals.protected_tracked || 0 : 0)
    }
  };
}

function runOpenclawRetentionTask(task: AnyObj) {
  const args = ['systems/ops/openclaw_backup_retention.js', 'run'];
  const keep = clampInt(task.params && task.params.keep, 1, 500, 20);
  const root = cleanText(task.params && task.params.root || '', 260);
  if (root) args.push(`--root=${root}`);
  args.push(`--keep=${keep}`);
  if (task.dry_run === true || task.apply !== true) args.push('--dry-run');
  const r = runJson('node', args);
  return {
    id: task.id,
    ok: r.ok,
    code: r.code,
    duration_ms: r.duration_ms,
    apply: task.apply === true,
    dry_run: task.dry_run === true || task.apply !== true,
    args,
    payload: r.payload,
    stderr: cleanText(r.stderr || '', 240),
    stdout: cleanText(r.stdout || '', 240),
    summary: {
      total_backups: Number(r.payload ? r.payload.total_backups || 0 : 0),
      retained_count: Number(r.payload ? r.payload.retained_count || 0 : 0),
      moved_count: Number(r.payload ? r.payload.moved_count || 0 : 0)
    }
  };
}

function runCryonicsTierTask(task: AnyObj) {
  const args = ['systems/memory/cryonics_tier.js', 'run'];
  const profile = cleanText(task.params && task.params.profile || 'state_phase1', 80) || 'state_phase1';
  const maxFiles = clampInt(task.params && task.params.max_files, 1, 100000, 400);
  args.push(`--profile=${profile}`);
  args.push(`--max-files=${maxFiles}`);
  if (task.dry_run === true || task.apply !== true) args.push('--dry-run');
  const r = runJson('node', args);
  return {
    id: task.id,
    ok: r.ok,
    code: r.code,
    duration_ms: r.duration_ms,
    apply: task.apply === true,
    dry_run: task.dry_run === true || task.apply !== true,
    args,
    payload: r.payload,
    stderr: cleanText(r.stderr || '', 240),
    stdout: cleanText(r.stdout || '', 240),
    summary: {
      scanned_candidates: Number(r.payload ? r.payload.scanned_candidates || 0 : 0),
      archived_count: Number(r.payload ? r.payload.archived_count || 0 : 0),
      source_deleted_count: Number(r.payload ? r.payload.source_deleted_count || 0 : 0)
    }
  };
}

function runTask(task: AnyObj) {
  if (task.id === 'state_cleanup') return runStateCleanupTask(task);
  if (task.id === 'openclaw_backup_retention') return runOpenclawRetentionTask(task);
  if (task.id === 'cryonics_tier') return runCryonicsTierTask(task);
  return {
    id: task.id,
    ok: false,
    code: null,
    duration_ms: 0,
    apply: task.apply === true,
    dry_run: task.dry_run === true || task.apply !== true,
    args: [],
    payload: null,
    stderr: '',
    stdout: '',
    summary: {},
    error: `unsupported_cleanup_task:${task.id}`
  };
}

function cmdRun(args: AnyObj) {
  const policy = loadPolicy(args.policy, args.profile);
  const globalRun = {
    apply_override: boolOptional(args.apply),
    dry_run_override: boolOptional(args['dry-run']),
    force_dry_run: boolFlag(args['dry-run'], false) || boolOptional(args.apply) === false
  };
  const tasksRaw = Array.isArray(policy.profile.tasks) ? policy.profile.tasks : [];
  const maxTasks = clampInt(policy.profile.max_tasks_per_run, 1, 128, 8);
  const tasks = tasksRaw.slice(0, maxTasks).map((row) => applyTaskOverrides(row, globalRun));
  const started = Date.now();
  const taskRuns = [];
  let failures = 0;
  let criticalFailures = 0;
  for (const task of tasks) {
    if (task.enabled !== true) {
      taskRuns.push({
        id: task.id,
        ok: true,
        skipped: true,
        reason: 'task_disabled',
        apply: task.apply === true,
        dry_run: task.dry_run === true || task.apply !== true
      });
      continue;
    }
    const taskResult = runTask(task);
    taskRuns.push({
      ...taskResult,
      skipped: false,
      critical: task.critical === true
    });
    if (taskResult.ok !== true) {
      failures += 1;
      if (task.critical === true) criticalFailures += 1;
      if (policy.profile.stop_on_failure === true) break;
    }
  }

  const summary = {
    tasks_configured: tasksRaw.length,
    tasks_considered: tasks.length,
    tasks_executed: taskRuns.filter((x) => x && x.skipped !== true).length,
    tasks_skipped: taskRuns.filter((x) => x && x.skipped === true).length,
    tasks_failed: failures,
    critical_failures: criticalFailures,
    state_deleted: taskRuns
      .filter((x) => x && x.id === 'state_cleanup')
      .reduce((sum, x) => sum + Number(x && x.summary ? x.summary.deleted || 0 : 0), 0),
    backups_moved: taskRuns
      .filter((x) => x && x.id === 'openclaw_backup_retention')
      .reduce((sum, x) => sum + Number(x && x.summary ? x.summary.moved_count || 0 : 0), 0),
    cryonics_archived: taskRuns
      .filter((x) => x && x.id === 'cryonics_tier')
      .reduce((sum, x) => sum + Number(x && x.summary ? x.summary.archived_count || 0 : 0), 0)
  };
  const ended = Date.now();
  const payload = {
    ok: criticalFailures === 0,
    type: 'cleanup_orchestrator_run',
    ts: nowIso(),
    profile: policy.profile.id,
    policy_version: policy.version,
    policy_path: relPath(policy.path),
    duration_ms: ended - started,
    stop_on_failure: policy.profile.stop_on_failure === true,
    forced_dry_run: globalRun.force_dry_run === true,
    tasks: taskRuns,
    summary
  };

  ensureDir(OUT_DIR);
  writeJsonAtomic(LATEST_PATH, payload);
  appendJsonl(HISTORY_PATH, {
    ts: payload.ts,
    type: payload.type,
    ok: payload.ok === true,
    profile: payload.profile,
    duration_ms: payload.duration_ms,
    summary: payload.summary
  });

  process.stdout.write(`${JSON.stringify({
    ok: payload.ok === true,
    type: payload.type,
    profile: payload.profile,
    forced_dry_run: payload.forced_dry_run === true,
    duration_ms: payload.duration_ms,
    tasks_executed: payload.summary.tasks_executed,
    tasks_failed: payload.summary.tasks_failed,
    critical_failures: payload.summary.critical_failures,
    state_deleted: payload.summary.state_deleted,
    backups_moved: payload.summary.backups_moved,
    cryonics_archived: payload.summary.cryonics_archived,
    latest_path: relPath(LATEST_PATH),
    history_path: relPath(HISTORY_PATH)
  })}\n`);
  if (payload.ok !== true) process.exitCode = 1;
}

function cmdStatus() {
  const payload = readJson(LATEST_PATH, null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'cleanup_orchestrator_status',
      error: 'cleanup_snapshot_missing'
    })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'cleanup_orchestrator_status',
    ts: payload.ts || null,
    profile: payload.profile || null,
    duration_ms: Number(payload.duration_ms || 0),
    forced_dry_run: payload.forced_dry_run === true,
    tasks_executed: Number(payload.summary && payload.summary.tasks_executed || 0),
    tasks_failed: Number(payload.summary && payload.summary.tasks_failed || 0),
    critical_failures: Number(payload.summary && payload.summary.critical_failures || 0),
    state_deleted: Number(payload.summary && payload.summary.state_deleted || 0),
    backups_moved: Number(payload.summary && payload.summary.backups_moved || 0),
    cryonics_archived: Number(payload.summary && payload.summary.cryonics_archived || 0),
    latest_path: relPath(LATEST_PATH)
  })}\n`);
}

function cmdProfiles(args: AnyObj) {
  const policy = loadPolicy(args.policy, args.profile);
  const raw = readJson(policy.path, {});
  const profiles = raw && raw.profiles && typeof raw.profiles === 'object'
    ? raw.profiles
    : defaultPolicy().profiles;
  const rows = Object.keys(profiles).sort().map((id) => {
    const p = profiles[id] || {};
    return {
      id,
      description: cleanText(p.description || '', 200),
      task_count: Array.isArray(p.tasks) ? p.tasks.length : 0,
      max_tasks_per_run: clampInt(p.max_tasks_per_run, 1, 128, 8),
      stop_on_failure: p.stop_on_failure === true
    };
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'cleanup_orchestrator_profiles',
    policy_path: relPath(policy.path),
    selected_profile: policy.profile.id,
    profiles: rows
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'profiles') return cmdProfiles(args);
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'cleanup_orchestrator',
      error: String(err && err.message ? err.message : err || 'cleanup_orchestrator_failed')
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  applyTaskOverrides,
  runTask,
  main
};

