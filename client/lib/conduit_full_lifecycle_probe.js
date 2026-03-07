'use strict';

const fs = require('fs');
const path = require('path');

function findRepoRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(dir, 'Cargo.toml')) && fs.existsSync(path.join(dir, 'crates', 'ops', 'Cargo.toml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

const ROOT = findRepoRoot(__dirname);

function loadConduitClient() {
  try {
    return require(path.join(ROOT, 'systems', 'conduit', 'conduit-client.js'));
  } catch {
    return require(path.join(ROOT, 'systems', 'conduit', 'conduit-client.ts'));
  }
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

async function run() {
  const { ConduitClient } = loadConduitClient();
  const command = daemonCommand();
  const client = ConduitClient.overStdio(command, daemonArgs(command), ROOT);
  const probeAgent = `lifecycle-probe-${Date.now()}`;

  try {
    await client.send({ type: 'start_agent', agent_id: probeAgent }, `probe-start-${probeAgent}`);
    const stopped = await client.send({ type: 'stop_agent', agent_id: probeAgent }, `probe-stop-${probeAgent}`);
    const ok = !!(stopped && stopped.validation && stopped.validation.ok);
    if (!ok) {
      process.stderr.write(`probe_failed:${JSON.stringify(stopped)}\n`);
      process.exit(1);
    }
    process.stdout.write('ok\n');
  } catch (err) {
    process.stderr.write(`probe_error:${String(err && err.message ? err.message : err)}\n`);
    process.exit(1);
  } finally {
    await client.close().catch(() => {});
  }
}

if (require.main === module) {
  run();
}
