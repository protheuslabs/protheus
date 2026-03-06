#!/usr/bin/env node
'use strict';
export {};

/**
 * system_visualizer_guard.js
 *
 * Lightweight health + restart guard for the holo visualizer sidecar.
 *
 * Usage:
 *   node systems/ops/system_visualizer_guard.js check [--policy=path] [--strict=1]
 *   node systems/ops/system_visualizer_guard.js restart [--policy=path] [--strict=1]
 *   node systems/ops/system_visualizer_guard.js status [--policy=path]
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.VISUALIZER_GUARD_POLICY_PATH
  ? path.resolve(process.env.VISUALIZER_GUARD_POLICY_PATH)
  : path.join(ROOT, 'config', 'system_visualizer_guard_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    const raw = String(tok || '');
    if (!raw.startsWith('--')) {
      out._.push(raw);
      continue;
    }
    const idx = raw.indexOf('=');
    if (idx === -1) out[raw.slice(2)] = true;
    else out[raw.slice(2, idx)] = raw.slice(idx + 1);
  }
  return out;
}

function clean(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    health_url: 'http://127.0.0.1:8787/',
    timeout_ms: 2000,
    restart_wait_ms: 900,
    server_script: 'systems/ops/system_visualizer_server.js',
    server_args: ['--host=127.0.0.1', '--port=8787', '--hours=24'],
    state_path: 'state/ops/system_visualizer_guard/latest.json',
    history_path: 'state/ops/system_visualizer_guard/history.jsonl'
  };
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(s) ? s : path.join(ROOT, s);
}

function normalizeArgList(v: unknown, fallback: string[]) {
  if (!Array.isArray(v)) return fallback.slice(0);
  const out = v.map((row) => clean(row, 220)).filter(Boolean);
  return out.length ? out : fallback.slice(0);
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  return {
    version: clean(raw.version || base.version, 24) || '1.0',
    enabled: toBool(raw.enabled, true),
    health_url: clean(raw.health_url || base.health_url, 600) || base.health_url,
    timeout_ms: clampInt(raw.timeout_ms, 200, 30000, base.timeout_ms),
    restart_wait_ms: clampInt(raw.restart_wait_ms, 0, 120000, base.restart_wait_ms),
    server_script: resolvePath(raw.server_script, base.server_script),
    server_args: normalizeArgList(raw.server_args, base.server_args),
    state_path: resolvePath(raw.state_path, base.state_path),
    history_path: resolvePath(raw.history_path, base.history_path)
  };
}

function waitMs(ms: number) {
  const n = Math.max(0, Number(ms || 0));
  if (n <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const arr = new Int32Array(sab);
  Atomics.wait(arr, 0, 0, n);
}

function httpProbe(urlText: string, timeoutMs: number): Promise<AnyObj> {
  return new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(String(urlText || '').trim());
    } catch {
      resolve({ ok: false, status: null, error: 'invalid_url' });
      return;
    }
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request({
      method: 'GET',
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname || '/'}${target.search || ''}`,
      timeout: timeoutMs
    }, (res: AnyObj) => {
      const status = Number(res && res.statusCode || 0);
      res.resume();
      resolve({
        ok: status >= 200 && status < 500,
        status: status || null,
        error: status > 0 ? null : 'no_status'
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err: AnyObj) => resolve({
      ok: false,
      status: null,
      error: clean(err && err.message ? err.message : 'probe_error', 120) || 'probe_error'
    }));
    req.end();
  });
}

function spawnServerDetached(policy: AnyObj) {
  if (!fs.existsSync(policy.server_script)) {
    return {
      ok: false,
      reason: 'server_script_missing',
      server_script: relPath(policy.server_script)
    };
  }
  try {
    const child = spawn(process.execPath, [policy.server_script, ...policy.server_args], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return {
      ok: true,
      pid: child.pid || null
    };
  } catch (err: any) {
    return {
      ok: false,
      reason: clean(err && err.message ? err.message : err || 'spawn_failed', 180) || 'spawn_failed'
    };
  }
}

async function runCheck(policyPath: string, mode: 'check' | 'restart', strict = false) {
  const policy = loadPolicy(policyPath);
  const probeBefore = await httpProbe(policy.health_url, policy.timeout_ms);
  let restart = null as AnyObj | null;
  let probeAfter = probeBefore;

  if (mode === 'restart' && probeBefore.ok !== true && policy.enabled === true) {
    restart = spawnServerDetached(policy);
    waitMs(policy.restart_wait_ms);
    probeAfter = await httpProbe(policy.health_url, policy.timeout_ms);
  }

  const healthy = probeAfter.ok === true;
  const payload = {
    ok: healthy || strict !== true,
    type: 'system_visualizer_guard',
    ts: nowIso(),
    mode,
    healthy,
    strict,
    policy_path: relPath(policyPath),
    health_url: policy.health_url,
    probe_before: probeBefore,
    restart,
    probe_after: probeAfter,
    state_path: relPath(policy.state_path),
    history_path: relPath(policy.history_path)
  };
  writeJsonAtomic(policy.state_path, payload);
  appendJsonl(policy.history_path, payload);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (strict === true && healthy !== true) process.exit(1);
}

function statusCmd(policyPath: string) {
  const policy = loadPolicy(policyPath);
  const payload = readJson(policy.state_path, null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'system_visualizer_guard_status',
      error: 'system_visualizer_guard_state_missing',
      state_path: relPath(policy.state_path)
    })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'system_visualizer_guard_status',
    healthy: payload.healthy === true,
    ts: payload.ts || null,
    state_path: relPath(policy.state_path),
    history_path: relPath(policy.history_path)
  })}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/system_visualizer_guard.js check [--policy=path] [--strict=1]');
  console.log('  node systems/ops/system_visualizer_guard.js restart [--policy=path] [--strict=1]');
  console.log('  node systems/ops/system_visualizer_guard.js status [--policy=path]');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = clean(args._[0] || 'check', 20).toLowerCase();
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  if (cmd === 'check') return runCheck(policyPath, 'check', toBool(args.strict, false));
  if (cmd === 'restart') return runCheck(policyPath, 'restart', toBool(args.strict, false));
  if (cmd === 'status') return statusCmd(policyPath);
  usage();
  process.exit(2);
}

main().catch((err: any) => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    type: 'system_visualizer_guard',
    error: clean(err && err.message ? err.message : err || 'system_visualizer_guard_failed', 240)
  })}\n`);
  process.exit(1);
});

