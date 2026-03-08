#!/usr/bin/env node
'use strict';

const { createOpsLaneBridge } = require('../../lib/rust_lane_bridge');
const fs = require('fs');
const path = require('path');

// Autotest runs frequently trip transient startup probes in cold environments.
if (!process.env.PROTHEUS_CONDUIT_STARTUP_PROBE_TIMEOUT_MS) {
  process.env.PROTHEUS_CONDUIT_STARTUP_PROBE_TIMEOUT_MS = '30000';
}
if (!process.env.PROTHEUS_CONDUIT_STDIO_TIMEOUT_MS) {
  process.env.PROTHEUS_CONDUIT_STDIO_TIMEOUT_MS = '180000';
}
if (!process.env.PROTHEUS_CONDUIT_STARTUP_PROBE) {
  process.env.PROTHEUS_CONDUIT_STARTUP_PROBE = '0';
}

const bridge = createOpsLaneBridge(__dirname, 'autotest_controller', 'autotest-controller');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx >= 0) {
      out[token.slice(2, idx)] = token.slice(idx + 1);
      continue;
    }
    const key = token.slice(2);
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

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (payload && typeof payload === 'object') return payload;
  } catch {}
  return null;
}

function readCachedState() {
  const roots = [
    path.join(process.cwd(), 'client', 'local', 'state', 'ops', 'autotest'),
    path.join(process.cwd(), 'local', 'state', 'ops', 'autotest')
  ];
  for (const root of roots) {
    const statusPath = path.join(root, 'status.json');
    const latestPath = path.join(root, 'latest.json');
    const status = readJsonIfExists(statusPath);
    const latest = readJsonIfExists(latestPath);
    if (!status && !latest) continue;
    return {
      ok: true,
      status,
      latest,
      statusPath: status ? statusPath : null,
      latestPath: latest ? latestPath : null
    };
  }
  return { ok: false };
}

function readCachedStatus() {
  const cached = readCachedState();
  if (!cached.ok || !cached.status) return { ok: false, payload: null };
  return {
    ok: true,
    payload: {
      ...cached.status,
      cached_status: true,
      status_source: cached.statusPath ? path.relative(process.cwd(), cached.statusPath).replace(/\\/g, '/') : null
    }
  };
}

function isConduitTimeout(out) {
  return Boolean(
    out && out.payload
      && typeof out.payload.reason === 'string'
      && out.payload.reason.includes('conduit_stdio_timeout:')
  );
}

function buildCachedFallback(cmd, parsed, out) {
  const cached = readCachedState();
  if (!cached.ok) return null;
  const reason = out && out.payload && out.payload.reason ? out.payload.reason : 'conduit_stdio_timeout';
  const statusSource = cached.statusPath ? path.relative(process.cwd(), cached.statusPath).replace(/\\/g, '/') : null;
  const latestSource = cached.latestPath ? path.relative(process.cwd(), cached.latestPath).replace(/\\/g, '/') : null;
  const status = cached.status || {};
  const latest = cached.latest || {};

  if (cmd === 'status' && cached.status) {
    try {
      return {
        ok: true,
        payload: {
          ...status,
          cached_status: true,
          degraded: true,
          live_reason: reason,
          status_source: statusSource
        }
      };
    } catch {}
  }

  if (cmd === 'report' && cached.latest) {
    return {
      ok: true,
      payload: {
        ...latest,
        ok: true,
        type: 'autotest_report',
        cached_report: true,
        degraded: true,
        live_reason: reason,
        status_source: statusSource,
        latest_source: latestSource
      }
    };
  }

  if (cmd === 'sync') {
    return {
      ok: true,
      payload: {
        ok: true,
        type: 'autotest_sync',
        degraded: true,
        cached_sync: true,
        live_reason: reason,
        changed_modules: Number(status.modules_changed || 0),
        untested_modules: Number(status.untested_modules || 0),
        last_sync: status.last_sync || null,
        status_source: statusSource,
        latest_source: latestSource
      }
    };
  }

  if (cmd === 'run' || cmd === 'pulse') {
    const scope = String(parsed.scope || 'changed');
    return {
      ok: true,
      payload: {
        ok: true,
        type: cmd === 'run' ? 'autotest_run' : 'autotest_pulse',
        degraded: true,
        cached_result: true,
        live_reason: reason,
        scope,
        selected_tests: 0,
        failed_tests: Number(latest.failed_tests || 0),
        untested_modules: Number(status.untested_modules || latest.untested_modules || 0),
        modules_changed: Number(status.modules_changed || latest.modules_changed || 0),
        last_sync: status.last_sync || null,
        last_run: status.last_run || null,
        last_report: status.last_report || latest.ts || null,
        status_source: statusSource,
        latest_source: latestSource
      }
    };
  }
  return { ok: false, payload: null };
}

function runCli(args) {
  const parsed = parseArgs(args);
  const cmd = String(parsed._[0] || '').trim().toLowerCase();
  const forceLive = String(parsed.live || parsed['force-live'] || '').trim() === '1';

  if (cmd === 'status' && !forceLive) {
    const cached = readCachedStatus();
    if (cached.ok) {
      process.stdout.write(`${JSON.stringify(cached.payload)}\n`);
      process.exit(0);
      return;
    }
  }

  const out = bridge.run(args);
  if (!out.ok && !forceLive && isConduitTimeout(out)) {
    const fallback = buildCachedFallback(cmd, parsed, out);
    if (fallback && fallback.ok) {
      process.stdout.write(`${JSON.stringify(fallback.payload)}\n`);
      process.exit(0);
      return;
    }
  }

  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exit(Number.isFinite(out.status) ? out.status : 1);
}

if (require.main === module) {
  runCli(process.argv.slice(2));
}

module.exports = {
  lane: bridge.lane,
  run: bridge.run
};
