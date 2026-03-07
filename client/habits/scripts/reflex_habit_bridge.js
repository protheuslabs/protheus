#!/usr/bin/env node
'use strict';

/**
 * reflex_habit_bridge.js
 *
 * Promote high-frequency tiny habits into reflex routines and degrade stale reflexes.
 *
 * Usage:
 *   node client/habits/scripts/reflex_habit_bridge.js sync [--apply=1]
 *   node client/habits/scripts/reflex_habit_bridge.js gc [--apply=1]
 *   node client/habits/scripts/reflex_habit_bridge.js status
 *   node client/habits/scripts/reflex_habit_bridge.js --help
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(ROOT, 'habits', 'registry.json');
const POLICY_PATH = path.join(ROOT, 'habits', 'reflexes', 'policy.json');
const REFLEX_SCRIPT = path.join(ROOT, 'systems', 'reflex', 'reflex_dispatcher.js');
const REFLEX_ROUTINES_PATH = process.env.REFLEX_ROUTINES_PATH
  ? path.resolve(process.env.REFLEX_ROUTINES_PATH)
  : path.join(ROOT, 'state', 'adaptive', 'reflex', 'routines.json');

function usage() {
  console.log('Usage:');
  console.log('  node client/habits/scripts/reflex_habit_bridge.js sync [--apply=1]');
  console.log('  node client/habits/scripts/reflex_habit_bridge.js gc [--apply=1]');
  console.log('  node client/habits/scripts/reflex_habit_bridge.js status');
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

function daysSince(ts) {
  const n = Date.parse(String(ts || ''));
  if (!Number.isFinite(n)) return null;
  return (Date.now() - n) / 86400000;
}

function loadPolicy() {
  const raw = readJsonSafe(POLICY_PATH, {});
  const promotion = raw && raw.promotion && typeof raw.promotion === 'object' ? raw.promotion : {};
  const degradation = raw && raw.degradation && typeof raw.degradation === 'object' ? raw.degradation : {};
  return {
    enabled: raw.enabled !== false,
    promotion: {
      min_uses_30d: Math.max(1, Number(promotion.min_uses_30d || 3)),
      max_avg_duration_ms: Math.max(200, Number(promotion.max_avg_duration_ms || 2500)),
      max_tokens_est: Math.max(50, Number(promotion.max_tokens_est || 420))
    },
    degradation: {
      disable_if_uses_30d_below: Math.max(0, Number(degradation.disable_if_uses_30d_below || 1)),
      disable_if_idle_days: Math.max(1, Number(degradation.disable_if_idle_days || 21)),
      dispose_if_idle_days: Math.max(1, Number(degradation.dispose_if_idle_days || 45))
    }
  };
}

function loadHabits() {
  const raw = readJsonSafe(REGISTRY_PATH, {});
  return Array.isArray(raw && raw.habits) ? raw.habits : [];
}

function loadReflexRoutines() {
  const raw = readJsonSafe(REFLEX_ROUTINES_PATH, {});
  return raw && raw.routines && typeof raw.routines === 'object' ? raw.routines : {};
}

function reflexIdForHabit(habitId) {
  return `hfx_${String(habitId || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)}`;
}

function averageDurationMs(habit) {
  const rolling = habit && habit.metrics && habit.metrics.rolling && typeof habit.metrics.rolling === 'object'
    ? habit.metrics.rolling
    : {};
  const direct = Number(rolling.avg_duration_ms_30d);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const runs = Array.isArray(rolling.window_runs) ? rolling.window_runs : [];
  const durations = runs.map((r) => Number(r && r.duration_ms)).filter((n) => Number.isFinite(n) && n > 0);
  if (!durations.length) return null;
  return durations.reduce((a, b) => a + b, 0) / durations.length;
}

function syncPlan(policy, habits, reflexRoutines) {
  const plan = [];
  for (const habit of habits) {
    if (!habit || String(habit.status || '').toLowerCase() !== 'active') continue;
    const uses = Number(habit.uses_30d || 0);
    const avgMs = averageDurationMs(habit);
    const qualifiesUse = uses >= policy.promotion.min_uses_30d;
    const qualifiesSpeed = avgMs == null || avgMs <= policy.promotion.max_avg_duration_ms;
    if (!qualifiesUse || !qualifiesSpeed) continue;

    const rid = reflexIdForHabit(habit.id);
    const exists = !!reflexRoutines[rid];
    plan.push({
      action: exists ? 'update' : 'create',
      reflex_id: rid,
      habit_id: String(habit.id || ''),
      task: `Run habit ${habit.id} via low-latency reflex path`,
      intent: String(habit.id || ''),
      tokens_est: policy.promotion.max_tokens_est,
      tags: ['habit_reflex', String(habit.id || '').slice(0, 48)]
    });
  }
  return plan;
}

function gcPlan(policy, habits, reflexRoutines) {
  const habitIds = new Set(habits.map((h) => String(h && h.id || '')).filter(Boolean));
  const plan = [];
  for (const routine of Object.values(reflexRoutines)) {
    const rid = String(routine && routine.id || '').trim();
    if (!rid.startsWith('hfx_')) continue;

    const tags = Array.isArray(routine.tags) ? routine.tags.map((t) => String(t || '')) : [];
    const mappedHabit = tags.find((t) => t && t !== 'habit_reflex') || '';
    const hasHabit = mappedHabit ? habitIds.has(mappedHabit) : false;
    const uses = Number(routine.use_count || 0);
    const idleDays = daysSince(routine.last_run_at || routine.updated_at || routine.created_at);

    if (!hasHabit) {
      plan.push({ action: 'dispose', reflex_id: rid, reason: 'source_habit_missing' });
      continue;
    }

    if (Number.isFinite(idleDays) && idleDays >= policy.degradation.dispose_if_idle_days) {
      plan.push({ action: 'dispose', reflex_id: rid, reason: 'idle_too_long' });
      continue;
    }
    if ((uses < policy.degradation.disable_if_uses_30d_below)
      || (Number.isFinite(idleDays) && idleDays >= policy.degradation.disable_if_idle_days)) {
      plan.push({ action: 'disable', reflex_id: rid, reason: 'low_use_or_idle' });
    }
  }
  return plan;
}

function runReflexCli(args) {
  const r = spawnSync('node', [REFLEX_SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  const out = String(r.stdout || '').trim();
  let payload = null;
  try { payload = JSON.parse(out); } catch {}
  return { ok: r.status === 0, status: r.status || 0, payload, stderr: String(r.stderr || '').trim() };
}

function applySync(plan) {
  const receipts = [];
  for (const row of plan) {
    const args = [
      'routine-create',
      `--id=${row.reflex_id}`,
      `--task=${row.task}`,
      `--intent=${row.intent}`,
      `--tokens_est=${row.tokens_est}`,
      `--tags=${row.tags.join(',')}`,
      '--upsert=1'
    ];
    const r = runReflexCli(args);
    receipts.push({ action: row.action, reflex_id: row.reflex_id, ok: r.ok, status: r.status, error: r.ok ? null : r.stderr || 'routine_create_failed' });
  }
  return receipts;
}

function applyGc(plan) {
  const receipts = [];
  for (const row of plan) {
    const cmd = row.action === 'dispose' ? 'routine-dispose' : 'routine-disable';
    const r = runReflexCli([cmd, `--id=${row.reflex_id}`]);
    receipts.push({ action: row.action, reflex_id: row.reflex_id, ok: r.ok, status: r.status, error: r.ok ? null : r.stderr || `${cmd}_failed` });
  }
  return receipts;
}

function cmdStatus() {
  const policy = loadPolicy();
  const habits = loadHabits();
  const reflex = loadReflexRoutines();
  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    policy_enabled: policy.enabled === true,
    habits: habits.length,
    reflex_routines: Object.keys(reflex).length,
    reflex_habit_routines: Object.values(reflex).filter((r) => String(r && r.id || '').startsWith('hfx_')).length
  }) + '\n');
}

function cmdSync(args) {
  const policy = loadPolicy();
  const apply = toBool(args.apply, false);
  if (!policy.enabled) {
    process.stdout.write(JSON.stringify({ ok: true, ts: nowIso(), result: 'disabled_by_policy' }) + '\n');
    return;
  }
  const plan = syncPlan(policy, loadHabits(), loadReflexRoutines());
  const receipts = apply ? applySync(plan) : [];
  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    type: 'reflex_habit_bridge_sync',
    apply,
    plan_count: plan.length,
    plan,
    receipts
  }) + '\n');
}

function cmdGc(args) {
  const policy = loadPolicy();
  const apply = toBool(args.apply, false);
  const plan = gcPlan(policy, loadHabits(), loadReflexRoutines());
  const receipts = apply ? applyGc(plan) : [];
  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    type: 'reflex_habit_bridge_gc',
    apply,
    plan_count: plan.length,
    plan,
    receipts
  }) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help === true) {
    usage();
    return;
  }
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'sync') return cmdSync(args);
  if (cmd === 'gc') return cmdGc(args);
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err || 'reflex_habit_bridge_failed') }) + '\n');
    process.exit(1);
  }
}
