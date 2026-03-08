#!/usr/bin/env node
'use strict';

/**
 * Lightweight compatibility wrapper.
 *
 * This script intentionally avoids TS bootstrap to keep manual CLI
 * triggers stable in constrained environments. All authority remains in
 * spine_safe_launcher.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SAFE_LAUNCHER = path.join(ROOT, 'systems', 'spine', 'spine_safe_launcher.js');
const DEFAULT_TIMEOUT_MS = Math.max(
  5000,
  Math.min(10 * 60 * 1000, Number(process.env.SPINE_HEARTBEAT_TRIGGER_TIMEOUT_MS || 30000) || 30000)
);
const DEFAULT_MAX_OLD_SPACE_MB = Math.max(
  96,
  Math.min(1024, Number(process.env.SPINE_HEARTBEAT_TRIGGER_MAX_OLD_SPACE_MB || 192) || 192)
);

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function toNumber(v, fallback, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function parseArg(name, fallback = null) {
  const pref = `--${name}=`;
  const arg = process.argv.find((token) => String(token).startsWith(pref));
  return arg ? String(arg).slice(pref.length) : fallback;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function lastSpineRunStarted(mode, dateStr) {
  const fp = path.join(ROOT, 'local', 'state', 'spine', 'runs', `${dateStr}.jsonl`);
  const accepted = new Set(['spine_run_started', 'spine_run_complete', 'spine_benchmark_noop']);
  const events = readJsonl(fp)
    .filter((row) => row && accepted.has(String(row.type || '')) && String(row.mode || '') === mode)
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return events.length > 0 ? events[events.length - 1] : null;
}

function buildDelegatedArgs() {
  const cmd = String(process.argv[2] || '').trim().toLowerCase();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') return ['--help'];
  if (cmd === 'status') {
    const mode = String(parseArg('mode', 'daily') || 'daily') === 'eyes' ? 'eyes' : 'daily';
    const date = String(parseArg('date', todayStr()) || todayStr()).slice(0, 20);
    return ['status', `--mode=${mode}`, `--date=${date}`];
  }
  if (cmd === 'run') {
    const mode = String(parseArg('mode', 'daily') || 'daily') === 'eyes' ? 'eyes' : 'daily';
    const date = todayStr();
    const maxEyes = parseArg('max-eyes', '');
    const delegated = ['run', mode, date];
    if (maxEyes) delegated.push(`--max-eyes=${String(maxEyes).slice(0, 16)}`);
    return delegated;
  }
  return ['--help'];
}

function main() {
  const cmd = String(process.argv[2] || '').trim().toLowerCase();
  const delegatedArgs = buildDelegatedArgs();
  const timeoutMs = DEFAULT_TIMEOUT_MS;
  const maxOldSpaceMb = DEFAULT_MAX_OLD_SPACE_MB;
  if (cmd === 'run') {
    const mode = String(parseArg('mode', 'daily') || 'daily') === 'eyes' ? 'eyes' : 'daily';
    const date = todayStr();
    const minHours = toNumber(parseArg('min-hours', process.env.SPINE_HEARTBEAT_MIN_HOURS || '4'), 4, 0, 168);
    const last = lastSpineRunStarted(mode, date);
    if (last) {
      const lastMs = Date.parse(String(last.ts || ''));
      if (Number.isFinite(lastMs)) {
        const hoursSince = (Date.now() - lastMs) / (1000 * 60 * 60);
        if (hoursSince < minHours) {
          process.stdout.write(
            `${JSON.stringify({
              ok: true,
              type: 'heartbeat_trigger_compat',
              compatibility_shell: true,
              authority: 'rust_spine',
              delegated_to: 'spine_safe_launcher',
              result: 'skipped_recent_run',
              mode,
              date,
              min_hours: minHours,
              hours_since_last: Number(hoursSince.toFixed(3)),
              last_run_ts: String(last.ts || ''),
              ts: new Date().toISOString()
            })}\n`
          );
          process.exit(0);
        }
      }
    }
  }

  const child = spawnSync(
    process.execPath,
    [`--max-old-space-size=${Math.floor(maxOldSpaceMb)}`, SAFE_LAUNCHER, ...delegatedArgs],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
      env: {
        ...process.env,
        SPINE_RUN_CONTEXT: process.env.SPINE_RUN_CONTEXT || 'heartbeat_cli',
        SPINE_HEARTBEAT_COMPAT_SHELL: '1'
      }
    }
  );

  if (child.stdout) process.stdout.write(String(child.stdout));
  if (child.stderr) process.stderr.write(String(child.stderr));
  if (child.error && String(child.error.code || '') === 'ETIMEDOUT') {
    process.stderr.write('heartbeat_trigger_timeout: delegated launcher exceeded timeout\n');
    process.exit(124);
  }
  if (!Number.isFinite(child.status)) {
    process.stderr.write(`heartbeat_trigger_failed: signal=${String(child.signal || 'unknown')}\n`);
    process.exit(1);
  }
  process.exit(Number(child.status));
}

main();
