#!/usr/bin/env node
'use strict';

/**
 * systems/spine/heartbeat_trigger.js
 *
 * Deterministic heartbeat entrypoint for spine.
 * - Throttles runs by min-hours window
 * - Calls spine.js with today's date
 *
 * Usage:
 *   node systems/spine/heartbeat_trigger.js run [--mode=eyes|daily] [--min-hours=N] [--max-eyes=N]
 *   node systems/spine/heartbeat_trigger.js --help
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = path.join(ROOT, 'state', 'spine', 'runs');

function nowIso() { return new Date().toISOString(); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

function usage() {
  console.log('Usage:');
  console.log('  node systems/spine/heartbeat_trigger.js run [--mode=eyes|daily] [--min-hours=N] [--max-eyes=N]');
  console.log('  node systems/spine/heartbeat_trigger.js --help');
}

function parseArg(name, fallback = null) {
  const pref = `--${name}=`;
  const a = process.argv.find(x => x.startsWith(pref));
  return a ? a.slice(pref.length) : fallback;
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

function lastSpineRunStarted(mode, dateStr) {
  const fp = path.join(RUNS_DIR, `${dateStr}.jsonl`);
  const events = readJsonl(fp)
    .filter(e => e && e.type === 'spine_run_started' && String(e.mode || '') === mode)
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return events.length ? events[events.length - 1] : null;
}

function runSpine(mode, dateStr, maxEyes) {
  const args = [path.join('systems', 'spine', 'spine.js'), mode, dateStr];
  if (maxEyes != null && maxEyes !== '') args.push(`--max-eyes=${maxEyes}`);
  const r = spawnSync('node', args, { cwd: ROOT, stdio: 'inherit' });
  return { ok: r.status === 0, code: r.status == null ? 1 : r.status };
}

function runIdleDreamCycle(dateStr) {
  const args = [path.join('systems', 'memory', 'idle_dream_cycle.js'), 'run', dateStr];
  const r = spawnSync('node', args, { cwd: ROOT, encoding: 'utf8' });
  const stdout = String(r.stdout || '').trim();
  const stderr = String(r.stderr || '').trim();
  let payload = null;
  if (stdout) {
    try { payload = JSON.parse(stdout); } catch {}
  }
  return {
    ok: r.status === 0 && !!payload && payload.ok === true,
    code: r.status == null ? 1 : r.status,
    payload,
    stderr: stderr || null
  };
}

function cmdRun() {
  const mode = String(parseArg('mode', 'daily') || 'daily');
  if (mode !== 'daily' && mode !== 'eyes') {
    process.stdout.write(JSON.stringify({ ok: false, error: 'invalid --mode (daily|eyes)' }) + '\n');
    process.exit(2);
  }

  const minHours = Number(parseArg('min-hours', process.env.SPINE_HEARTBEAT_MIN_HOURS || 4));
  const maxEyes = parseArg('max-eyes', '');
  const dateStr = todayStr();
  const last = lastSpineRunStarted(mode, dateStr);
  const nowMs = Date.now();
  const lastMs = last ? new Date(String(last.ts || '')).getTime() : 0;
  const hoursSince = last ? ((nowMs - lastMs) / (1000 * 60 * 60)) : null;

  if (last && Number.isFinite(hoursSince) && hoursSince < minHours) {
    const idleEnabled = String(process.env.IDLE_DREAM_ON_HEARTBEAT_SKIP || '1') !== '0';
    const idle = idleEnabled ? runIdleDreamCycle(dateStr) : null;
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'skipped_recent_run',
      mode,
      date: dateStr,
      min_hours: minHours,
      hours_since_last: Number(hoursSince.toFixed(3)),
      last_run_ts: last.ts,
      idle_dream: idleEnabled
        ? {
            attempted: true,
            ok: !!(idle && idle.ok),
            code: idle ? idle.code : null,
            result: idle && idle.payload ? idle.payload : null,
            reason: idle && !idle.ok
              ? String(idle.stderr || (idle.payload && idle.payload.reason) || 'idle_dream_failed').slice(0, 180)
              : null
          }
        : { attempted: false, reason: 'feature_flag_disabled' },
      ts: nowIso()
    }) + '\n');
    return;
  }

  const r = runSpine(mode, dateStr, maxEyes);
  process.stdout.write(JSON.stringify({
    ok: r.ok,
    result: r.ok ? 'triggered' : 'spine_failed',
    mode,
    date: dateStr,
    min_hours: minHours,
    ts: nowIso()
  }) + '\n');
  if (!r.ok) process.exit(r.code || 1);
}

function main() {
  const cmd = process.argv[2] || '';
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun();
  usage();
  process.exit(2);
}

main();
export {};
