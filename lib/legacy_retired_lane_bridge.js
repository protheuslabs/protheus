'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

function parseJsonPayload(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

function findRepoRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  while (true) {
    const cargo = path.join(dir, 'Cargo.toml');
    const cratesOps = path.join(dir, 'crates', 'ops', 'Cargo.toml');
    if (require('fs').existsSync(cargo) && require('fs').existsSync(cratesOps)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

function runRustLane(laneId, cwdHint) {
  const ROOT = findRepoRoot(cwdHint || process.cwd());
  const workerScript = `
const path = require('path');
const ROOT = process.cwd();
function loadConduitClient() {
  try {
    return require(path.join(ROOT, 'systems', 'conduit', 'conduit-client.js'));
  } catch {
    return require(path.join(ROOT, 'systems', 'conduit', 'conduit-client.ts'));
  }
}

function daemonCommand() {
  return process.env.PROTHEUS_CONDUIT_DAEMON_COMMAND || 'cargo';
}

function daemonArgs() {
  const raw = process.env.PROTHEUS_CONDUIT_DAEMON_ARGS;
  if (raw && String(raw).trim()) {
    return String(raw).trim().split(/\\s+/).filter(Boolean);
  }
  return ['run', '--quiet', '-p', 'conduit', '--bin', 'conduit_daemon'];
}

(async () => {
  const laneId = String(process.argv[1] || '').trim();
  const { ConduitClient } = loadConduitClient();
  const client = ConduitClient.overStdio(daemonCommand(), daemonArgs(), ROOT);
  try {
    const response = await client.send(
      { type: 'start_agent', agent_id: \`lane:\${laneId}\` },
      \`lane-\${laneId}-\${Date.now()}\`,
    );
    const laneReceipt = response
      && response.event
      && response.event.type === 'system_feedback'
      && response.event.detail
      && typeof response.event.detail === 'object'
      ? response.event.detail.lane_receipt
      : null;

    if (laneReceipt && typeof laneReceipt === 'object') {
      process.stdout.write(JSON.stringify(laneReceipt) + '\\n');
      return;
    }
    process.stdout.write(JSON.stringify({
      ok: false,
      type: 'conduit_lane_bridge_error',
      lane_id: laneId,
      error: 'lane_receipt_missing',
      conduit_response: response
    }) + '\\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      type: 'conduit_lane_bridge_error',
      lane_id: laneId,
      error: String(err && err.message ? err.message : err)
    }) + '\\n');
  } finally {
    await client.close().catch(() => {});
  }
})().catch((err) => {
  process.stdout.write(JSON.stringify({
    ok: false,
    type: 'conduit_lane_bridge_error',
    lane_id: String(process.argv[1] || '').trim(),
    error: String(err && err.message ? err.message : err)
  }) + '\\n');
});
`;

  const out = spawnSync(process.execPath, ['-e', workerScript, laneId], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      PROTHEUS_NODE_BINARY: process.execPath || 'node'
    }
  });

  const payload = parseJsonPayload(out.stdout);
  if (Number(out.status) === 0 && payload && payload.ok === true) {
    return payload;
  }

  return {
    ok: false,
    type: 'legacy_retired_lane_bridge_error',
    lane_id: laneId,
    error: String((payload && payload.error) || out.stderr || out.stdout || 'legacy_retired_lane_failed')
      .trim()
      .slice(0, 260)
  };
}

function createLaneModule(laneId, cwdHint) {
  const normalized = String(laneId || '').trim().toUpperCase();
  function buildLaneReceipt() {
    return runRustLane(normalized, cwdHint);
  }
  function verifyLaneReceipt() {
    const row = buildLaneReceipt();
    return row && row.ok === true && String(row.lane_id || '') === normalized;
  }
  return {
    LANE_ID: normalized,
    buildLaneReceipt,
    verifyLaneReceipt
  };
}

module.exports = {
  createLaneModule,
  runRustLane
};
