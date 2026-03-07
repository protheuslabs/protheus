#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'memory', 'rust_memory_daemon_supervisor.js');

function run(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  let payload = null;
  try { payload = JSON.parse(String(proc.stdout || '').trim()); } catch {}
  return {
    status: Number.isFinite(proc.status) ? proc.status : 1,
    payload,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || '')
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-memory-supervisor-'));
  const stateDir = path.join(tmp, 'state');
  const fakeDaemon = path.join(tmp, 'fake_memory_daemon.js');
  const policyPath = path.join(tmp, 'policy.json');
  const port = 43191;
  const pidPath = path.join(stateDir, 'memory_daemon.pid');
  const socketPath = path.join(stateDir, 'memory_daemon.sock');

  writeText(fakeDaemon, `#!/usr/bin/env node
'use strict';
const net = require('net');
function arg(name, fallback) {
  const found = process.argv.find((row) => String(row).startsWith(name + '='));
  return found ? found.slice(name.length + 1) : fallback;
}
const host = arg('--host', '127.0.0.1');
const port = Number(arg('--port', '43117'));
const server = net.createServer((socket) => {
  let buf = '';
  socket.on('data', (chunk) => {
    buf += String(chunk || '');
    const idx = buf.indexOf('\\n');
    if (idx < 0) return;
    const line = buf.slice(0, idx).trim();
    buf = '';
    let req = {};
    try { req = line ? JSON.parse(line) : {}; } catch {}
    if (req && req.cmd === 'ping') {
      socket.write(JSON.stringify({ ok: true, type: 'memory_daemon_pong' }) + '\\n');
      return;
    }
    socket.write(JSON.stringify({ ok: true, type: 'memory_daemon_ok' }) + '\\n');
  });
});
server.listen(port, host);
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
`);
  fs.chmodSync(fakeDaemon, 0o755);

  writeJson(pidPath, { pid: 999999, started_ts: '2026-03-01T00:00:00.000Z' });
  writeJson(policyPath, {
    enabled: true,
    host: '127.0.0.1',
    port,
    startup_timeout_ms: 5000,
    ping_timeout_ms: 300,
    backoff: {
      enabled: true,
      min_restart_interval_ms: 0
    },
    daemon: {
      command: [process.execPath, fakeDaemon, '--host=${host}', '--port=${port}'],
      cwd: tmp,
      env: {}
    },
    paths: {
      pid_path: pidPath,
      log_path: path.join(stateDir, 'memory_daemon.log'),
      stale_socket_path: socketPath,
      latest_path: path.join(stateDir, 'daemon_supervisor', 'latest.json'),
      receipts_path: path.join(stateDir, 'daemon_supervisor', 'receipts.jsonl'),
      state_path: path.join(stateDir, 'daemon_supervisor', 'state.json')
    }
  });

  let out = run(['start', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'start should pass');
  assert.strictEqual(out.payload.stale_pid_reaped, true, 'stale pid should be reaped before start');

  out = run(['healthcheck', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ping_ok === true, 'healthcheck should pass');

  out = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.running === true, 'status should report running daemon');
  assert.ok(Number(out.payload.pid || 0) > 0, 'status should expose daemon pid');

  out = run(['restart', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'restart should pass');

  writeText(socketPath, 'stale');
  out = run(['reap-stale', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.stale_socket_reaped === true, 'stale socket should be reaped');

  out = run(['stop', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'stop should pass');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('rust_memory_daemon_supervisor.test.js: OK');
} catch (err) {
  console.error(`rust_memory_daemon_supervisor.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
