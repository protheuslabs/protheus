#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  toBool,
  clampInt,
  readJson,
  writeJsonAtomic,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');
const { loadPolicyRuntime } = require('../../lib/policy_runtime');
const { writeArtifactSet } = require('../../lib/state_artifact_contract');

const DEFAULT_POLICY_PATH = process.env.RUST_MEMORY_DAEMON_SUPERVISOR_POLICY_PATH
  ? path.resolve(process.env.RUST_MEMORY_DAEMON_SUPERVISOR_POLICY_PATH)
  : path.join(ROOT, 'config', 'rust_memory_daemon_supervisor_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/rust_memory_daemon_supervisor.js start [--policy=<path>]');
  console.log('  node systems/memory/rust_memory_daemon_supervisor.js stop [--policy=<path>]');
  console.log('  node systems/memory/rust_memory_daemon_supervisor.js restart [--policy=<path>]');
  console.log('  node systems/memory/rust_memory_daemon_supervisor.js status [--policy=<path>]');
  console.log('  node systems/memory/rust_memory_daemon_supervisor.js healthcheck [--policy=<path>]');
  console.log('  node systems/memory/rust_memory_daemon_supervisor.js reap-stale [--policy=<path>]');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    host: '127.0.0.1',
    port: 43117,
    startup_timeout_ms: 20000,
    ping_timeout_ms: 500,
    backoff: {
      enabled: true,
      min_restart_interval_ms: 1500
    },
    daemon: {
      command: [
        'cargo',
        'run',
        '--release',
        '--quiet',
        '--manifest-path=${root}/systems/memory/rust/Cargo.toml',
        '--',
        'daemon',
        '--host=${host}',
        '--port=${port}',
        '--root=${root}'
      ],
      cwd: '.',
      env: {}
    },
    paths: {
      pid_path: 'state/memory/rust_transition/memory_daemon.pid',
      log_path: 'state/memory/rust_transition/memory_daemon.log',
      stale_socket_path: 'state/memory/rust_transition/memory_daemon.sock',
      latest_path: 'state/memory/rust_transition/daemon_supervisor/latest.json',
      receipts_path: 'state/memory/rust_transition/daemon_supervisor/receipts.jsonl',
      state_path: 'state/memory/rust_transition/daemon_supervisor/state.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const loaded = loadPolicyRuntime({
    policyPath,
    defaults: base
  });
  const raw = loaded.raw;
  const backoff = raw.backoff && typeof raw.backoff === 'object' ? raw.backoff : {};
  const daemon = raw.daemon && typeof raw.daemon === 'object' ? raw.daemon : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: toBool(raw.enabled, true),
    host: cleanText(raw.host || base.host, 120) || base.host,
    port: clampInt(raw.port, 1, 65535, base.port),
    startup_timeout_ms: clampInt(raw.startup_timeout_ms, 200, 120000, base.startup_timeout_ms),
    ping_timeout_ms: clampInt(raw.ping_timeout_ms, 100, 10000, base.ping_timeout_ms),
    backoff: {
      enabled: toBool(backoff.enabled, base.backoff.enabled),
      min_restart_interval_ms: clampInt(
        backoff.min_restart_interval_ms,
        0,
        24 * 60 * 60 * 1000,
        base.backoff.min_restart_interval_ms
      )
    },
    daemon: {
      command: Array.isArray(daemon.command) && daemon.command.length > 0
        ? daemon.command.map((row: unknown) => cleanText(row, 320)).filter(Boolean)
        : base.daemon.command,
      cwd: resolvePath(daemon.cwd, base.daemon.cwd),
      env: daemon.env && typeof daemon.env === 'object' ? daemon.env : {}
    },
    paths: {
      pid_path: resolvePath(paths.pid_path, base.paths.pid_path),
      log_path: resolvePath(paths.log_path, base.paths.log_path),
      stale_socket_path: resolvePath(paths.stale_socket_path, base.paths.stale_socket_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      state_path: resolvePath(paths.state_path, base.paths.state_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function readSupervisorState(policy: any) {
  const state = readJson(policy.paths.state_path, null);
  if (!state || typeof state !== 'object') {
    return {
      schema_id: 'rust_memory_daemon_supervisor_state',
      schema_version: '1.0',
      last_started_at: null,
      last_stopped_at: null,
      last_restart_at: null,
      restart_count: 0
    };
  }
  return {
    schema_id: 'rust_memory_daemon_supervisor_state',
    schema_version: '1.0',
    last_started_at: state.last_started_at || null,
    last_stopped_at: state.last_stopped_at || null,
    last_restart_at: state.last_restart_at || null,
    restart_count: clampInt(state.restart_count, 0, 1000000, 0)
  };
}

function writeSupervisorState(policy: any, state: any) {
  writeJsonAtomic(policy.paths.state_path, {
    schema_id: 'rust_memory_daemon_supervisor_state',
    schema_version: '1.0',
    last_started_at: state.last_started_at || null,
    last_stopped_at: state.last_stopped_at || null,
    last_restart_at: state.last_restart_at || null,
    restart_count: clampInt(state.restart_count, 0, 1000000, 0)
  });
}

function readPid(policy: any) {
  try {
    if (!fs.existsSync(policy.paths.pid_path)) return null;
    const parsed = JSON.parse(fs.readFileSync(policy.paths.pid_path, 'utf8'));
    const pid = clampInt(parsed && parsed.pid, 0, 10_000_000, 0);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writePid(policy: any, pid: number) {
  fs.mkdirSync(path.dirname(policy.paths.pid_path), { recursive: true });
  writeJsonAtomic(policy.paths.pid_path, {
    pid: clampInt(pid, 1, 10_000_000, 1),
    started_ts: nowIso(),
    host: policy.host,
    port: policy.port
  });
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sendPing(policy: any): Promise<any> {
  return new Promise((resolve) => {
    let done = false;
    const socket = net.createConnection({
      host: policy.host,
      port: policy.port
    });
    const finish = (payload: any) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(payload);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'ping_timeout' }), policy.ping_timeout_ms);

    socket.on('connect', () => {
      try {
        socket.write(`${JSON.stringify({ cmd: 'ping' })}\n`);
      } catch {
        clearTimeout(timer);
        finish({ ok: false, error: 'ping_write_failed' });
      }
    });
    socket.on('data', (chunk) => {
      clearTimeout(timer);
      const raw = String(chunk || '').split('\n')[0].trim();
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch {}
      finish({ ok: !!(parsed && parsed.ok === true), payload: parsed });
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: cleanText(err && (err.code || err.message) ? (err.code || err.message) : 'ping_error', 120) });
    });
  });
}

function writeReceipt(policy: any, payload: any) {
  return writeArtifactSet(
    {
      latestPath: policy.paths.latest_path,
      receiptsPath: policy.paths.receipts_path
    },
    {
      ts: nowIso(),
      ...payload
    },
    {
      schemaId: 'rust_memory_daemon_supervisor_receipt',
      schemaVersion: '1.0',
      artifactType: 'receipt'
    }
  );
}

function resolveDaemonCommand(policy: any) {
  const ctx = {
    host: policy.host,
    port: String(policy.port),
    root: ROOT
  };
  const cmd = policy.daemon.command.map((token: string) => String(token)
    .replace(/\$\{host\}/g, ctx.host)
    .replace(/\$\{port\}/g, ctx.port)
    .replace(/\$\{root\}/g, ctx.root));
  return {
    command: cmd[0],
    args: cmd.slice(1),
    cwd: policy.daemon.cwd,
    env: { ...process.env, ...(policy.daemon.env || {}) }
  };
}

async function reapStale(policy: any) {
  const pid = readPid(policy);
  let stalePidReaped = false;
  if (pid && !processAlive(pid)) {
    try { fs.unlinkSync(policy.paths.pid_path); } catch {}
    stalePidReaped = true;
  }
  let staleSocketReaped = false;
  if (policy.paths.stale_socket_path && fs.existsSync(policy.paths.stale_socket_path)) {
    try {
      fs.unlinkSync(policy.paths.stale_socket_path);
      staleSocketReaped = true;
    } catch {}
  }
  return writeReceipt(policy, {
    ok: true,
    type: 'rust_memory_daemon_reap_stale',
    stale_pid_reaped: stalePidReaped,
    stale_socket_reaped: staleSocketReaped
  });
}

async function startDaemon(policy: any) {
  const pre = await reapStale(policy);
  const ping = await sendPing(policy);
  if (ping.ok) {
    return writeReceipt(policy, {
      ok: true,
      type: 'rust_memory_daemon_start',
      reused_existing: true,
      stale_pid_reaped: pre.stale_pid_reaped === true,
      stale_socket_reaped: pre.stale_socket_reaped === true
    });
  }

  const state = readSupervisorState(policy);
  const now = Date.now();
  const lastStartedMs = Date.parse(String(state.last_started_at || '')) || 0;
  if (policy.backoff.enabled && lastStartedMs > 0 && (now - lastStartedMs) < policy.backoff.min_restart_interval_ms) {
    return writeReceipt(policy, {
      ok: false,
      type: 'rust_memory_daemon_start',
      error: 'restart_backoff_active',
      min_restart_interval_ms: policy.backoff.min_restart_interval_ms
    });
  }

  fs.mkdirSync(path.dirname(policy.paths.log_path), { recursive: true });
  const fd = fs.openSync(policy.paths.log_path, 'a');
  const cmd = resolveDaemonCommand(policy);
  const child = spawn(cmd.command, cmd.args, {
    cwd: cmd.cwd,
    env: cmd.env,
    detached: true,
    stdio: ['ignore', fd, fd]
  });
  child.unref();
  if (!Number.isFinite(child.pid) || child.pid <= 0) {
    return writeReceipt(policy, {
      ok: false,
      type: 'rust_memory_daemon_start',
      error: 'spawn_failed'
    });
  }

  writePid(policy, child.pid);
  const deadline = Date.now() + policy.startup_timeout_ms;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    const check = await sendPing(policy);
    if (check.ok) {
      state.last_started_at = nowIso();
      state.restart_count = clampInt(state.restart_count, 0, 1000000, 0) + 1;
      writeSupervisorState(policy, state);
      return writeReceipt(policy, {
        ok: true,
        type: 'rust_memory_daemon_start',
        reused_existing: false,
        pid: child.pid,
        stale_pid_reaped: pre.stale_pid_reaped === true,
        stale_socket_reaped: pre.stale_socket_reaped === true
      });
    }
  }

  return writeReceipt(policy, {
    ok: false,
    type: 'rust_memory_daemon_start',
    error: 'startup_timeout',
    pid: child.pid
  });
}

async function stopDaemon(policy: any) {
  const pid = readPid(policy);
  let stopped = false;
  if (pid && processAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      stopped = true;
    } catch {}
  }
  try {
    if (fs.existsSync(policy.paths.pid_path)) fs.unlinkSync(policy.paths.pid_path);
  } catch {}

  const state = readSupervisorState(policy);
  state.last_stopped_at = nowIso();
  writeSupervisorState(policy, state);
  return writeReceipt(policy, {
    ok: true,
    type: 'rust_memory_daemon_stop',
    pid: pid || null,
    stopped
  });
}

async function restartDaemon(policy: any) {
  const stopped = await stopDaemon(policy);
  const started = await startDaemon(policy);
  const state = readSupervisorState(policy);
  state.last_restart_at = nowIso();
  writeSupervisorState(policy, state);
  return writeReceipt(policy, {
    ok: started.ok === true,
    type: 'rust_memory_daemon_restart',
    stop_ok: stopped.ok === true,
    start_ok: started.ok === true
  });
}

async function healthcheck(policy: any) {
  const ping = await sendPing(policy);
  return writeReceipt(policy, {
    ok: ping.ok === true,
    type: 'rust_memory_daemon_healthcheck',
    ping_ok: ping.ok === true,
    ping_error: ping.ok ? null : ping.error || 'ping_failed'
  });
}

async function status(policy: any) {
  const ping = await sendPing(policy);
  const pid = readPid(policy);
  return {
    ok: true,
    type: 'rust_memory_daemon_status',
    ts: nowIso(),
    running: ping.ok === true,
    pid: pid || null,
    policy: {
      version: policy.version,
      host: policy.host,
      port: policy.port,
      policy_path: rel(policy.policy_path)
    },
    latest: readJson(policy.paths.latest_path, null),
    state: readJson(policy.paths.state_path, null)
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || '', 80).toLowerCase();
  if (!cmd || args.help) {
    usage();
    process.exit(cmd ? 0 : 1);
  }

  const policy = loadPolicy(args.policy || DEFAULT_POLICY_PATH);
  if (!policy.enabled) emit({ ok: false, error: 'rust_memory_daemon_supervisor_disabled' }, 1);

  if (cmd === 'reap-stale') emit(await reapStale(policy));
  if (cmd === 'start') emit(await startDaemon(policy));
  if (cmd === 'stop') emit(await stopDaemon(policy));
  if (cmd === 'restart') emit(await restartDaemon(policy));
  if (cmd === 'healthcheck') emit(await healthcheck(policy));
  if (cmd === 'status') emit(await status(policy));

  usage();
  process.exit(1);
}

main();
