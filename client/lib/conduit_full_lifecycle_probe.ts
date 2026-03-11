'use strict';

const fs = require('fs');
const path = require('path');

function findRepoRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  while (true) {
    const cargo = path.join(dir, 'Cargo.toml');
    const conduitLayer2 = path.join(dir, 'core', 'layer2', 'conduit', 'Cargo.toml');
    const conduitLegacy = path.join(dir, 'crates', 'conduit', 'Cargo.toml');
    if (fs.existsSync(cargo) && (fs.existsSync(conduitLayer2) || fs.existsSync(conduitLegacy))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir || process.cwd());
    dir = parent;
  }
}

const ROOT = findRepoRoot(__dirname);

function loadConduitClient() {
  const jsCandidates = [
    path.join(ROOT, 'client', 'runtime', 'systems', 'conduit', 'conduit-client.js'),
    path.join(ROOT, 'systems', 'conduit', 'conduit-client.js')
  ];
  for (const candidate of jsCandidates) {
    if (fs.existsSync(candidate)) {
      return require(candidate);
    }
  }
  throw new Error('conduit_client_missing');
}

function daemonCommand() {
  if (process.env.PROTHEUS_CONDUIT_DAEMON_COMMAND) {
    return process.env.PROTHEUS_CONDUIT_DAEMON_COMMAND;
  }
  const releaseBin = path.join(ROOT, 'target', 'release', 'conduit_daemon');
  if (fs.existsSync(releaseBin)) return releaseBin;
  const debugBin = path.join(ROOT, 'target', 'debug', 'conduit_daemon');
  return fs.existsSync(debugBin) ? debugBin : 'cargo';
}

function daemonArgs(command) {
  const raw = process.env.PROTHEUS_CONDUIT_DAEMON_ARGS;
  if (raw && String(raw).trim()) {
    return String(raw).trim().split(/\s+/).filter(Boolean);
  }
  return command === 'cargo'
    ? ['run', '--quiet', '-p', 'conduit', '--bin', 'conduit_daemon']
    : [];
}

function resolveProbeTimeoutMs() {
  const configured = Number(process.env.PROTHEUS_CONDUIT_PROBE_TIMEOUT_MS || 15000);
  if (!Number.isFinite(configured) || configured <= 0) {
    return 15000;
  }
  return Math.floor(configured);
}

function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`probe_step_timeout:${label}:${ms}`));
      }, ms);
    })
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

async function run() {
  const timeoutMs = resolveProbeTimeoutMs();
  if (!process.env.PROTHEUS_CONDUIT_STDIO_TIMEOUT_MS) {
    process.env.PROTHEUS_CONDUIT_STDIO_TIMEOUT_MS = String(timeoutMs);
  }
  const { ConduitClient } = loadConduitClient();
  const command = daemonCommand();
  const client = ConduitClient.overStdio(command, daemonArgs(command), ROOT);
  const probeAgent = `lifecycle-probe-${Date.now()}`;

  try {
    const started = await withTimeout(
      client.send({ type: 'start_agent', agent_id: probeAgent }, `probe-start-${probeAgent}`),
      timeoutMs,
      'start_agent'
    );
    const stopped = await withTimeout(
      client.send({ type: 'stop_agent', agent_id: probeAgent }, `probe-stop-${probeAgent}`),
      timeoutMs,
      'stop_agent'
    );
    const ok = !!(
      started && started.validation && started.validation.ok
      && stopped && stopped.validation && stopped.validation.ok
    );
    if (!ok) {
      process.stderr.write(`probe_failed:${JSON.stringify({ started, stopped })}\n`);
      process.exit(1);
    }
    process.stdout.write('ok\n');
  } catch (err) {
    process.stderr.write(`probe_error:${String(err && err.message ? err.message : err)}\n`);
    process.exit(1);
  } finally {
    await withTimeout(client.close().catch(() => {}), Math.max(1000, Math.min(timeoutMs, 10000)), 'client_close')
      .catch(() => {});
  }
}

if (require.main === module) {
  run();
}
