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
const IDLE_DREAM_SKIP_TIMEOUT_MS = Math.max(5000, Math.min(
  15 * 60 * 1000,
  Number(process.env.SPINE_HEARTBEAT_IDLE_DREAM_TIMEOUT_MS || 120000) || 120000
));
const SPINE_HEARTBEAT_RUN_TIMEOUT_MS = Math.max(30000, Math.min(
  60 * 60 * 1000,
  Number(process.env.SPINE_HEARTBEAT_RUN_TIMEOUT_MS || 300000) || 300000
));
const SPINE_HEARTBEAT_RETRY_WITHOUT_DREAM = String(process.env.SPINE_HEARTBEAT_RETRY_WITHOUT_DREAM || '1') !== '0';
const SPINE_HEARTBEAT_RETRY_TIMEOUT_MS = Math.max(30000, Math.min(
  60 * 60 * 1000,
  Number(process.env.SPINE_HEARTBEAT_RETRY_TIMEOUT_MS || 180000) || 180000
));

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

type HeartbeatRunSpineOpts = {
  env?: Record<string, string | undefined>,
  timeout_ms?: number
};

function runSpine(mode, dateStr, maxEyes, opts: HeartbeatRunSpineOpts = {}) {
  const args = [path.join('systems', 'spine', 'spine.js'), mode, dateStr];
  if (maxEyes != null && maxEyes !== '') args.push(`--max-eyes=${maxEyes}`);
  const runEnv = opts.env && typeof opts.env === 'object'
    ? { ...process.env, ...opts.env }
    : process.env;
  const timeoutMs = Math.max(1000, Number(opts.timeout_ms || SPINE_HEARTBEAT_RUN_TIMEOUT_MS));
  const r = spawnSync('node', args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: runEnv,
    timeout: timeoutMs
  });
  const spawnError = r.error ? String(r.error && r.error.message ? r.error.message : r.error) : '';
  const timedOut = /\bETIMEDOUT\b/i.test(spawnError);
  return {
    ok: r.status === 0,
    code: r.status == null ? 1 : r.status,
    timed_out: timedOut,
    timeout_ms: timeoutMs,
    error: spawnError || null
  };
}

function runIdleDreamCycle(dateStr) {
  const args = [path.join('systems', 'memory', 'idle_dream_cycle.js'), 'run', dateStr];
  const r = spawnSync('node', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: IDLE_DREAM_SKIP_TIMEOUT_MS
  });
  const stdout = String(r.stdout || '').trim();
  const spawnError = r.error ? String(r.error && r.error.message ? r.error.message : r.error) : '';
  const timedOut = /\bETIMEDOUT\b/i.test(spawnError);
  const stderr = [String(r.stderr || '').trim(), timedOut ? 'process_timeout' : '', spawnError]
    .filter(Boolean)
    .join('\n')
    .trim();
  let payload = null;
  if (stdout) {
    try { payload = JSON.parse(stdout); } catch {}
  }
  return {
    ok: r.status === 0 && !!payload && payload.ok === true,
    code: r.status == null ? 1 : r.status,
    payload,
    timed_out: timedOut,
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
            timeout_ms: IDLE_DREAM_SKIP_TIMEOUT_MS,
            reason: idle && !idle.ok
              ? String(
                idle.timed_out === true
                  ? `idle_dream_timeout_${IDLE_DREAM_SKIP_TIMEOUT_MS}ms`
                  : (idle.stderr || (idle.payload && idle.payload.reason) || 'idle_dream_failed')
              ).slice(0, 180)
              : null
          }
        : { attempted: false, reason: 'feature_flag_disabled' },
      ts: nowIso()
    }) + '\n');
    return;
  }

  let r = runSpine(mode, dateStr, maxEyes, {
    timeout_ms: SPINE_HEARTBEAT_RUN_TIMEOUT_MS
  });
  let retry = null;
  if (!r.ok && r.timed_out === true && SPINE_HEARTBEAT_RETRY_WITHOUT_DREAM) {
    retry = runSpine(mode, dateStr, maxEyes, {
      timeout_ms: SPINE_HEARTBEAT_RETRY_TIMEOUT_MS,
      env: {
        IDLE_DREAM_CYCLE_ENABLED: '0'
      }
    });
    if (retry.ok === true) r = retry;
  }
  process.stdout.write(JSON.stringify({
    ok: r.ok,
    result: r.ok
      ? (retry && retry.ok === true ? 'triggered_retry_without_dream' : 'triggered')
      : 'spine_failed',
    mode,
    date: dateStr,
    min_hours: minHours,
    timeout_ms: Number(r.timeout_ms || SPINE_HEARTBEAT_RUN_TIMEOUT_MS),
    timed_out: r.timed_out === true,
    error: r.error || null,
    retry_without_dream: retry
      ? {
          attempted: true,
          ok: retry.ok === true,
          timeout_ms: Number(retry.timeout_ms || SPINE_HEARTBEAT_RETRY_TIMEOUT_MS),
          timed_out: retry.timed_out === true,
          error: retry.error || null
        }
      : { attempted: false },
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
