#!/usr/bin/env node
'use strict';

/**
 * habit_cell_pool.js
 *
 * Optional bounded habit executor using spawn-broker cell allocations.
 *
 * Usage:
 *   node systems/habits/habit_cell_pool.js status
 *   node systems/habits/habit_cell_pool.js run --ids=id1,id2 [--max-workers=N] [--json='{}'] [--apply=1] [--dry-run]
 *   node systems/habits/habit_cell_pool.js --help
 */

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.HABIT_CELL_POOL_POLICY_PATH
  ? path.resolve(process.env.HABIT_CELL_POOL_POLICY_PATH)
  : path.join(ROOT, 'config', 'habit_cell_pool_policy.json');
const SPAWN_BROKER_SCRIPT = process.env.HABIT_CELL_POOL_SPAWN_BROKER
  ? path.resolve(process.env.HABIT_CELL_POOL_SPAWN_BROKER)
  : path.join(ROOT, 'systems', 'spawn', 'spawn_broker.js');
const RUN_HABIT_SCRIPT = process.env.HABIT_CELL_POOL_RUN_HABIT
  ? path.resolve(process.env.HABIT_CELL_POOL_RUN_HABIT)
  : path.join(ROOT, 'habits', 'scripts', 'run_habit.js');

function usage() {
  console.log('Usage:');
  console.log('  node systems/habits/habit_cell_pool.js status');
  console.log('  node systems/habits/habit_cell_pool.js run --ids=id1,id2 [--max-workers=N] [--json=\'{}\'] [--apply=1] [--dry-run]');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
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

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function toBool(v, fallback) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function loadPolicy() {
  const raw = readJsonSafe(POLICY_PATH, {});
  return {
    enabled: raw.enabled === true,
    default_max_workers: Math.max(1, Number(raw.default_max_workers || 2)),
    max_workers: Math.max(1, Number(raw.max_workers || 4)),
    spawn_module: String(raw.spawn_module || 'habits').trim() || 'habits',
    request_tokens_per_habit: Math.max(50, Number(raw.request_tokens_per_habit || 240)),
    lease_sec: Math.max(30, Number(raw.lease_sec || 300))
  };
}

function parseIds(v) {
  return String(v || '').split(',').map((x) => String(x || '').trim()).filter(Boolean);
}

function requestCells(policy, requestedWorkers, apply) {
  const requested = Math.max(1, requestedWorkers);
  const args = [
    SPAWN_BROKER_SCRIPT,
    'request',
    `--module=${policy.spawn_module}`,
    `--requested_cells=${requested}`,
    `--request_tokens_est=${requested * policy.request_tokens_per_habit}`,
    '--reason=habit_cell_pool',
    `--lease_sec=${policy.lease_sec}`,
    `--apply=${apply ? 1 : 0}`
  ];
  const r = spawnSync('node', args, { cwd: ROOT, encoding: 'utf8' });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout || '').trim()); } catch {}
  return { ok: r.status === 0, status: r.status || 0, payload, stderr: String(r.stderr || '').trim() };
}

function releaseCells(policy) {
  const r = spawnSync('node', [
    SPAWN_BROKER_SCRIPT,
    'release',
    `--module=${policy.spawn_module}`,
    '--reason=habit_cell_pool_release'
  ], { cwd: ROOT, encoding: 'utf8' });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout || '').trim()); } catch {}
  return { ok: r.status === 0, status: r.status || 0, payload, stderr: String(r.stderr || '').trim() };
}

function runOneHabit(id, jsonInput) {
  return new Promise((resolve) => {
    const child = spawn('node', [RUN_HABIT_SCRIPT, '--id', id, '--json', jsonInput], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk || ''); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk || ''); });
    child.on('close', (code) => {
      resolve({
        habit_id: id,
        exit_code: Number(code || 0),
        ok: Number(code || 0) === 0,
        stdout: stdout.slice(0, 1200),
        stderr: stderr.slice(0, 600)
      });
    });
  });
}

async function runPool(ids, workers, jsonInput) {
  const queue = ids.slice();
  const results = [];
  const active = new Set();

  async function launchNext() {
    if (!queue.length) return;
    const id = queue.shift();
    const p = runOneHabit(id, jsonInput).then((result) => {
      results.push(result);
      active.delete(p);
    });
    active.add(p);
  }

  const width = Math.max(1, workers);
  for (let i = 0; i < width && queue.length; i++) await launchNext();

  while (active.size) {
    await Promise.race(Array.from(active));
    while (active.size < width && queue.length) {
      await launchNext();
    }
  }

  return results.sort((a, b) => String(a.habit_id).localeCompare(String(b.habit_id)));
}

function cmdStatus() {
  const policy = loadPolicy();
  const spawn = spawnSync('node', [SPAWN_BROKER_SCRIPT, 'status', `--module=${policy.spawn_module}`], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  let payload = null;
  try { payload = JSON.parse(String(spawn.stdout || '').trim()); } catch {}
  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    policy,
    spawn_status: payload || null
  }) + '\n');
}

async function cmdRun(args) {
  const policy = loadPolicy();
  const apply = toBool(args.apply, true);
  const dryRun = args['dry-run'] === true || args.dry_run === true;
  const ids = parseIds(args.ids || args.id || '');
  if (!ids.length) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing_ids' }) + '\n');
    process.exit(2);
    return;
  }

  if (!policy.enabled && !toBool(args.force, false)) {
    process.stdout.write(JSON.stringify({
      ok: true,
      ts: nowIso(),
      result: 'disabled_by_policy',
      policy_enabled: false,
      ids
    }) + '\n');
    return;
  }

  const maxWorkersRaw = Number(args['max-workers'] || args.max_workers || policy.default_max_workers);
  const maxWorkers = Math.max(1, Math.min(policy.max_workers, Number.isFinite(maxWorkersRaw) ? Math.round(maxWorkersRaw) : policy.default_max_workers));
  const payload = String(args.json || '{}');

  const alloc = requestCells(policy, Math.min(ids.length, maxWorkers), apply && !dryRun);
  if (!alloc.ok || !alloc.payload || alloc.payload.ok !== true) {
    process.stdout.write(JSON.stringify({
      ok: false,
      ts: nowIso(),
      error: 'spawn_allocation_failed',
      detail: alloc.stderr || null
    }) + '\n');
    process.exit(1);
    return;
  }

  const workers = Math.max(1, Math.min(Number(alloc.payload.granted_cells || 1), maxWorkers));
  if (dryRun) {
    process.stdout.write(JSON.stringify({
      ok: true,
      ts: nowIso(),
      type: 'habit_cell_pool',
      dry_run: true,
      workers,
      ids,
      commands: ids.map((id) => ['node', RUN_HABIT_SCRIPT, '--id', id, '--json', payload])
    }) + '\n');
    if (apply) releaseCells(policy);
    return;
  }

  let results = [];
  let release = null;
  try {
    results = await runPool(ids, workers, payload);
  } finally {
    if (apply) release = releaseCells(policy);
  }

  const failures = results.filter((r) => !r.ok).length;
  process.stdout.write(JSON.stringify({
    ok: failures === 0,
    ts: nowIso(),
    type: 'habit_cell_pool',
    workers,
    ids,
    results,
    failures,
    release: release ? { ok: release.ok, status: release.status } : null
  }) + '\n');
  if (failures > 0) process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help === true) {
    usage();
    return;
  }
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'run') return cmdRun(args);
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  main().catch((err) => {
    process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err || 'habit_cell_pool_failed') }) + '\n');
    process.exit(1);
  });
}
export {};
