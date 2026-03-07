#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parsePayload(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(root, 'systems', 'ops', 'system_visualizer_guard.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viz-guard-'));
  const port = 38000 + Math.floor(Math.random() * 1000);
  const pidFile = path.join(tmp, 'server.pid');
  const launcherScript = path.join(tmp, 'fake_visualizer_server.js');
  const policyPath = path.join(tmp, 'config', 'system_visualizer_guard_policy.json');
  const statePath = path.join(tmp, 'state', 'ops', 'system_visualizer_guard', 'latest.json');

  fs.writeFileSync(launcherScript, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    "const http = require('http');",
    "let port = 18787;",
    "let pidFile = '';",
    "for (const arg of process.argv.slice(2)) {",
    "  if (arg.startsWith('--port=')) port = Number(arg.slice('--port='.length));",
    "  if (arg.startsWith('--pid-file=')) pidFile = arg.slice('--pid-file='.length);",
    "}",
    "const server = http.createServer((req, res) => { res.statusCode = 200; res.end('ok'); });",
    "server.listen(port, '127.0.0.1', () => {",
    "  if (pidFile) { fs.mkdirSync(require('path').dirname(pidFile), { recursive: true }); fs.writeFileSync(pidFile, String(process.pid)); }",
    "});",
    "setInterval(() => {}, 1000);"
  ].join('\n'), 'utf8');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    health_url: `http://127.0.0.1:${port}/`,
    timeout_ms: 800,
    restart_wait_ms: 400,
    server_script: launcherScript,
    server_args: [`--port=${port}`, `--pid-file=${pidFile}`],
    state_path: statePath,
    history_path: path.join(tmp, 'state', 'ops', 'system_visualizer_guard', 'history.jsonl')
  });

  const checkBefore = spawnSync(process.execPath, [
    script,
    'check',
    `--policy=${policyPath}`
  ], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.strictEqual(checkBefore.status, 0, checkBefore.stderr || 'check before restart should return payload');
  const beforePayload = parsePayload(checkBefore.stdout);
  assert.ok(beforePayload && beforePayload.ok === true, 'non-strict check should be ok');
  assert.strictEqual(beforePayload.healthy, false, 'visualizer should be unhealthy before restart');

  const restart = spawnSync(process.execPath, [
    script,
    'restart',
    `--policy=${policyPath}`,
    '--strict=1'
  ], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.strictEqual(restart.status, 0, restart.stderr || 'restart strict should pass after spawn');
  const restartPayload = parsePayload(restart.stdout);
  assert.ok(restartPayload && restartPayload.healthy === true, 'visualizer should be healthy after restart');
  assert.ok(fs.existsSync(pidFile), 'fake server pid file should be created');

  const checkAfter = spawnSync(process.execPath, [
    script,
    'check',
    `--policy=${policyPath}`,
    '--strict=1'
  ], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.strictEqual(checkAfter.status, 0, checkAfter.stderr || 'strict check should pass after restart');
  const afterPayload = parsePayload(checkAfter.stdout);
  assert.ok(afterPayload && afterPayload.healthy === true, 'health should stay true');
  assert.ok(fs.existsSync(statePath), 'state snapshot should be written');

  // Cleanup spawned fake server if still running.
  try {
    const pid = Number(String(fs.readFileSync(pidFile, 'utf8') || '').trim());
    if (Number.isFinite(pid) && pid > 0) process.kill(pid, 'SIGTERM');
  } catch {
    // Best effort cleanup.
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('system_visualizer_guard.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`system_visualizer_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
