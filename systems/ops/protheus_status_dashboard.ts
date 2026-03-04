#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = process.env.OPENCLAW_WORKSPACE
  ? path.resolve(process.env.OPENCLAW_WORKSPACE)
  : path.resolve(__dirname, '..', '..');
const DRIFT_PATH = path.join(ROOT, 'state', 'autonomy', 'drift_target_governor_state.json');
const HEARTBEAT_STATE_PATH = path.join(ROOT, 'memory', 'heartbeat-state.json');
const SHADOW_STATE_PATH = path.join(ROOT, 'state', 'personas', 'shadow_cli', 'state.json');
const PERSONA_TELEMETRY_PATH = path.join(ROOT, 'personas', 'organization', 'telemetry.jsonl');
const CONTROL_PLANE_SCRIPT = path.join(ROOT, 'systems', 'ops', 'protheus_control_plane.js');

function cleanText(v: unknown, maxLen = 400) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  const raw = cleanText(v, 20).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string, limit = 200) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function parseJsonText(raw: string) {
  const txt = String(raw || '').trim();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {}
  const lines = txt.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

function nowIso() {
  return new Date().toISOString();
}

function ageSecondsFromIso(ts: string | null | undefined) {
  const ms = Date.parse(String(ts || ''));
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 1000));
}

function countLines(filePath: string) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw) return 0;
    let lines = 1;
    for (let i = 0; i < raw.length; i += 1) {
      if (raw.charCodeAt(i) === 10) lines += 1;
    }
    return lines;
  } catch {
    return 0;
  }
}

function rustSummary() {
  const run = spawnSync('git', ['ls-files', '*.rs', '*.ts'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (!Number.isFinite(run.status) || Number(run.status) !== 0) {
    return {
      tracked_rs_lines: 0,
      tracked_ts_lines: 0,
      rust_percent: 0,
      source: 'git_ls_files_failed'
    };
  }

  const files = String(run.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  let rs = 0;
  let ts = 0;
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    if (rel.endsWith('.rs')) rs += countLines(abs);
    else if (rel.endsWith('.ts')) ts += countLines(abs);
  }

  const total = rs + ts;
  const pct = total > 0 ? Number(((rs / total) * 100).toFixed(3)) : 0;
  return {
    tracked_rs_lines: rs,
    tracked_ts_lines: ts,
    rust_percent: pct,
    source: 'tracked_source_files'
  };
}

function driftSummary() {
  const drift = readJson(DRIFT_PATH, {});
  const rate = Number(drift && drift.last_decision && drift.last_decision.drift_rate || 0);
  const target = Number(drift && drift.current_target_rate || 0.02);
  const threshold = 0.02;
  const level = rate > threshold ? 'high' : rate > (threshold / 2) ? 'elevated' : 'low';
  return {
    drift_rate: Number(rate.toFixed(6)),
    drift_target_rate: Number(target.toFixed(6)),
    drift_threshold: threshold,
    drift_level: level,
    source: path.relative(ROOT, DRIFT_PATH).replace(/\\/g, '/')
  };
}

function shadowSummary() {
  const state = readJson(SHADOW_STATE_PATH, null);
  const active = state && state.active && typeof state.active === 'object' ? state.active : {};
  const paused = state && state.paused && typeof state.paused === 'object' ? state.paused : {};
  const activeList = Object.keys(active).filter((id) => active[id] === true && paused[id] !== true);
  const pausedList = Object.keys(paused).filter((id) => paused[id] === true);

  const telemetryRows = readJsonl(PERSONA_TELEMETRY_PATH, 120);
  const shadowEvents = telemetryRows.filter((row: AnyObj) => String(row.kind || '').toLowerCase().includes('shadow'));
  const lastShadow = shadowEvents.length ? shadowEvents[shadowEvents.length - 1] : null;

  return {
    active_shadows: activeList.length,
    paused_shadows: pausedList.length,
    active_ids: activeList,
    paused_ids: pausedList,
    last_shadow_event_at: lastShadow ? cleanText(lastShadow.ts, 40) : null,
    state_path: path.relative(ROOT, SHADOW_STATE_PATH).replace(/\\/g, '/')
  };
}

function heartbeatSummary() {
  const state = readJson(HEARTBEAT_STATE_PATH, {});
  const checks = state && state.lastChecks && typeof state.lastChecks === 'object' ? state.lastChecks : {};
  const values = Object.values(checks)
    .map((value) => Number(value || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  const latestSec = values.length ? Math.max(...values) : 0;
  const latestIso = latestSec > 0 ? new Date(latestSec * 1000).toISOString() : null;
  return {
    last_check_at: latestIso,
    last_check_age_seconds: ageSecondsFromIso(latestIso),
    checks,
    source: path.relative(ROOT, HEARTBEAT_STATE_PATH).replace(/\\/g, '/')
  };
}

function controlPlaneStatus() {
  if (!fs.existsSync(CONTROL_PLANE_SCRIPT)) return null;
  const run = spawnSync(process.execPath, [CONTROL_PLANE_SCRIPT, 'status'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const payload = parseJsonText(run.stdout) || parseJsonText(run.stderr);
  if (!Number.isFinite(run.status) || Number(run.status) !== 0) {
    return {
      ok: false,
      status: Number.isFinite(run.status) ? Number(run.status) : 1,
      error: cleanText(run.stderr || run.stdout || 'control_plane_status_failed', 260)
    };
  }
  return {
    ok: true,
    payload
  };
}

function usage() {
  console.log('Usage:');
  console.log('  protheus status');
  console.log('  protheus status raw');
  console.log('  protheus status --json');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sub = normalizeToken(args._[0] || '', 40);
  if (args.help || sub === 'help' || sub === '--help' || sub === '-h') {
    usage();
    process.exit(0);
  }

  const rawOnly = sub === 'raw';
  const control = controlPlaneStatus();
  if (rawOnly && control && control.ok && control.payload) {
    process.stdout.write(`${JSON.stringify(control.payload, null, 2)}\n`);
    return;
  }

  const payload = {
    ok: true,
    type: 'protheus_status_dashboard',
    ts: nowIso(),
    rust: rustSummary(),
    drift: driftSummary(),
    shadows: shadowSummary(),
    heartbeat: heartbeatSummary(),
    control_plane: control
  };

  const asJson = toBool(args.json ?? process.env.PROTHEUS_GLOBAL_JSON, false);
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  process.stdout.write('Protheus Status\n\n');
  process.stdout.write(`Rust: ${payload.rust.rust_percent}% (rs=${payload.rust.tracked_rs_lines}, ts=${payload.rust.tracked_ts_lines})\n`);
  process.stdout.write(`Drift: ${payload.drift.drift_level} (rate=${payload.drift.drift_rate}, target=${payload.drift.drift_target_rate})\n`);
  process.stdout.write(`Shadows: active=${payload.shadows.active_shadows}, paused=${payload.shadows.paused_shadows}\n`);
  process.stdout.write(`Heartbeat: last=${payload.heartbeat.last_check_at || 'n/a'}, age_s=${payload.heartbeat.last_check_age_seconds ?? 'n/a'}\n`);
  if (payload.control_plane && payload.control_plane.ok) {
    const cp = payload.control_plane.payload || {};
    process.stdout.write(`Control plane: running=${cp.daemon && cp.daemon.running === true ? 'yes' : 'no'}, queue_depth=${cp.queue_depth ?? 'n/a'}\n`);
  } else {
    process.stdout.write('Control plane: unavailable\n');
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  rustSummary,
  driftSummary,
  shadowSummary,
  heartbeatSummary,
  controlPlaneStatus
};
