#!/usr/bin/env node
'use strict';

const path = require('path');
const { createOpsLaneBridge } = require('./rust_lane_bridge');

function mapArgs(args = [], laneId) {
  const cmd = String((Array.isArray(args) && args[0]) || '').trim().toLowerCase();
  if (cmd === 'status' || cmd === 'verify') {
    return ['verify', `--lane-id=${laneId}`];
  }
  return ['build', `--lane-id=${laneId}`];
}

function createLegacyRetiredModule(scriptDir, scriptName, laneId) {
  process.env.PROTHEUS_CONDUIT_STARTUP_PROBE = '0';
  process.env.PROTHEUS_CONDUIT_COMPAT_FALLBACK = '0';
  process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS =
    process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS || '15000';
  process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS =
    process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '20000';
  // Retired lanes should use the existing core binary in this host profile
  // instead of triggering fresh cargo builds during wrapper execution.
  process.env.PROTHEUS_OPS_USE_PREBUILT =
    process.env.PROTHEUS_OPS_USE_PREBUILT || '1';
  process.env.PROTHEUS_OPS_DEFER_ON_HOST_STALL =
    process.env.PROTHEUS_OPS_DEFER_ON_HOST_STALL || '0';

  const bridge = createOpsLaneBridge(scriptDir, scriptName, 'legacy-retired-lane');

  function run(args = []) {
    const out = bridge.run(mapArgs(args, laneId));
    if (out && out.stdout) process.stdout.write(out.stdout);
    if (out && out.stderr) process.stderr.write(out.stderr);
    if (out && out.payload && !out.stdout) {
      process.stdout.write(`${JSON.stringify(out.payload)}\n`);
    }
    return out;
  }

  return {
    lane: bridge.lane,
    run
  };
}

function runAsMain(mod, argv = []) {
  const out = mod.run(argv);
  process.exit(Number.isFinite(out && out.status) ? Number(out.status) : 1);
}

function normalizeLaneId(raw, fallback = 'RUNTIME-LEGACY-RETIRED') {
  const v = String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return v || fallback;
}

function laneIdFromRuntimePath(filePath) {
  const runtimeRoot = path.resolve(__dirname, '..');
  const rel = path
    .relative(runtimeRoot, filePath)
    .replace(/\\/g, '/')
    .replace(/\.[^.]+$/, '');
  return normalizeLaneId(`RUNTIME-${rel}`);
}

module.exports = {
  createLegacyRetiredModule,
  laneIdFromRuntimePath,
  normalizeLaneId,
  runAsMain
};
