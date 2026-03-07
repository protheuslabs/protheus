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
const { runSpineCommand } = require('../../lib/spine_conduit_bridge');

const ROOT = path.resolve(__dirname, '..', '..');
const TS_ENTRYPOINT = path.join(ROOT, 'lib', 'ts_entrypoint.js');
const RUNS_DIR = path.join(ROOT, 'local', 'state', 'spine', 'runs');
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
  console.log('  node systems/spine/heartbeat_trigger.js status');
  console.log('  node systems/spine/heartbeat_trigger.js --help');
}

function parseArg(name, fallback = null) {
  const pref = `--${name}=`;
  const a = process.argv.find(x => x.startsWith(pref));
  return a ? a.slice(pref.length) : fallback;
}

function parseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function parseGateUntil(reason) {
  const raw = String(reason || '').trim();
  const marker = 'conduit_runtime_gate_active_until:';
  if (!raw.startsWith(marker)) return null;
  const iso = raw.slice(marker.length).trim();
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return {
    until_iso: new Date(ms).toISOString(),
    remaining_ms: Math.max(0, ms - Date.now())
  };
}

function resolveScriptInvocation(scriptRelPath: string) {
  const scriptAbs = path.join(ROOT, scriptRelPath);
  if (fs.existsSync(scriptAbs)) {
    return [scriptRelPath];
  }
  if (scriptRelPath.endsWith('.js')) {
    const tsRel = scriptRelPath.slice(0, -3) + '.ts';
    const tsAbs = path.join(ROOT, tsRel);
    if (fs.existsSync(tsAbs)) {
      return [TS_ENTRYPOINT, tsAbs];
    }
  }
  if (scriptRelPath.endsWith('.ts')) {
    const jsRel = scriptRelPath.slice(0, -3) + '.js';
    const jsAbs = path.join(ROOT, jsRel);
    if (fs.existsSync(jsAbs)) {
      return [jsRel];
    }
  }
  return [scriptRelPath];
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
  const launcherRel = path.join('systems', 'spine', 'spine_safe_launcher.js');
  const args = [...resolveScriptInvocation(launcherRel), 'run', mode, dateStr];
  if (maxEyes != null && maxEyes !== '') args.push(`--max-eyes=${maxEyes}`);
  const envForFlags = opts.env && typeof opts.env === 'object'
    ? { ...process.env, ...opts.env }
    : process.env;
  if (String(envForFlags.SPINE_HEARTBEAT_APPLY_RESEAL || '').trim() === '1') {
    args.push('--apply-reseal=1');
  }
  if (String(envForFlags.SPINE_HEARTBEAT_ALLOW_RISKY_ENV || '').trim() === '1') {
    args.push('--allow-risky-env=1');
  }
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
  const idleRel = path.join('systems', 'memory', 'idle_dream_cycle.js');
  const args = [...resolveScriptInvocation(idleRel), 'run', dateStr];
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

function fallbackHeartbeatHours() {
  return Math.max(1, Number(parseArg('min-hours', process.env.SPINE_HEARTBEAT_MIN_HOURS || 4)) || 4);
}

async function runSpineStatus(mode, dateStr, runContext = null) {
  const statusTimeoutMs = Math.max(
    1000,
    Number(process.env.SPINE_HEARTBEAT_STATUS_TIMEOUT_MS || process.env.PROTHEUS_CONDUIT_BRIDGE_TIMEOUT_MS || 120000) || 120000
  );
  const args = ['status'];
  if (mode) args.push(`--mode=${mode}`);
  if (dateStr) args.push(`--date=${dateStr}`);
  const out = await runSpineCommand(args, {
    cwdHint: ROOT,
    timeoutMs: statusTimeoutMs,
    runContext: runContext || null
  });
  return {
    ok: out.ok,
    status: Number.isFinite(out.status) ? Number(out.status) : 1,
    stdout: out.payload ? JSON.stringify(out.payload) : String(out.stdout || ''),
    stderr: String(out.stderr || ''),
    payload: out.payload && typeof out.payload === 'object' ? out.payload : parseJson(String(out.stdout || ''))
  };
}

async function cmdStatus() {
  const mode = parseArg('mode', '');
  const date = parseArg('date', '');
  const runContext = String(process.env.SPINE_RUN_CONTEXT || '').trim() || 'manual';
  const r = await runSpineStatus(mode, date, runContext);
  if (r && r.payload && r.payload.gate_active === true) {
    const gate = parseGateUntil(r.payload.reason || r.stderr || '');
    process.stdout.write(JSON.stringify({
      ok: true,
      type: 'spine_heartbeat_status',
      result: 'runtime_gate_active',
      gate_active: true,
      gate_reason: String(r.payload.reason || '').slice(0, 240),
      gate_until: gate ? gate.until_iso : null,
      gate_remaining_ms: gate ? gate.remaining_ms : Number(r.payload.gate_remaining_ms || 0) || null,
      ts: nowIso()
    }) + '\n');
    process.exit(0);
  }
  if (r.stdout) process.stdout.write(String(r.stdout));
  if (r.stderr) process.stderr.write(String(r.stderr));
  if (r.status !== 0) {
    process.exit(r.status);
  }
}

async function cmdRun() {
  const mode = String(parseArg('mode', 'daily') || 'daily');
  if (mode !== 'daily' && mode !== 'eyes') {
    process.stdout.write(JSON.stringify({ ok: false, error: 'invalid --mode (daily|eyes)' }) + '\n');
    process.exit(2);
  }

  const dateStr = todayStr();
  const rustStatus = await runSpineStatus(mode, dateStr, 'heartbeat');
  if (rustStatus && rustStatus.payload && rustStatus.payload.gate_active === true) {
    const gate = parseGateUntil(rustStatus.payload.reason || rustStatus.stderr || '');
    process.stdout.write(JSON.stringify({
      ok: true,
      result: 'skipped_runtime_gate_active',
      mode,
      date: dateStr,
      gate_active: true,
      gate_reason: String(rustStatus.payload.reason || '').slice(0, 240),
      gate_until: gate ? gate.until_iso : null,
      gate_remaining_ms: gate ? gate.remaining_ms : Number(rustStatus.payload.gate_remaining_ms || 0) || null,
      ts: nowIso()
    }) + '\n');
    return;
  }
  const minHours = rustStatus.ok && rustStatus.payload && Number(rustStatus.payload.heartbeat_hours || 0) > 0
    ? Number(rustStatus.payload.heartbeat_hours)
    : fallbackHeartbeatHours();
  const maxEyes = parseArg('max-eyes', '');
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
    env: {
      SPINE_RUN_CONTEXT: 'heartbeat'
    },
    timeout_ms: SPINE_HEARTBEAT_RUN_TIMEOUT_MS
  });
  let retry = null;
  if (!r.ok && r.timed_out === true && SPINE_HEARTBEAT_RETRY_WITHOUT_DREAM) {
    retry = runSpine(mode, dateStr, maxEyes, {
      timeout_ms: SPINE_HEARTBEAT_RETRY_TIMEOUT_MS,
      env: {
        SPINE_RUN_CONTEXT: 'heartbeat',
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

async function main() {
  const cmd = process.argv[2] || '';
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    process.exit(0);
  }
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'run') return cmdRun();
  usage();
  process.exit(2);
}

main().catch((err: any) => {
  process.stderr.write(`spine_heartbeat_trigger_error:${String(err && err.message ? err.message : err)}\n`);
  process.exit(1);
});
export {};
