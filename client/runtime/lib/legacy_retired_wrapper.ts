#!/usr/bin/env node
'use strict';

const { createOpsLaneBridge } = require('./rust_lane_bridge.ts');

function normalizeLaneId(raw, fallback = 'RUNTIME-LEGACY-RETIRED') {
  const v = String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return v || fallback;
}

function laneIdFromRuntimePath(filePath) {
  const path = require('path');
  const runtimeRoot = path.resolve(__dirname, '..');
  const rel = path
    .relative(runtimeRoot, filePath)
    .replace(/\\/g, '/')
    .replace(/\.[^.]+$/, '');
  return normalizeLaneId(`RUNTIME-${rel}`);
}

function mapArgs(args = []) {
  const cmd = String((Array.isArray(args) && args[0]) || '').trim().toLowerCase();
  if (!cmd || cmd === 'run') return ['run'];
  if (cmd === 'status' || cmd === 'verify') return ['status'];
  return args.map((v) => String(v));
}

function createLegacyRetiredModule(scriptDir, scriptName, laneId) {
  const bridge = createOpsLaneBridge(scriptDir, scriptName, 'runtime-systems');
  const normalized = normalizeLaneId(laneId);

  function run(args = []) {
    const pass = mapArgs(Array.isArray(args) ? args : []);
    const out = bridge.run([`--lane-id=${normalized}`].concat(pass));
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
  process.exit(Number.isFinite(Number(out && out.status)) ? Number(out.status) : 1);
}

function createLegacyRetiredModuleForFile(filePath) {
  const path = require('path');
  const laneId = laneIdFromRuntimePath(filePath);
  return createLegacyRetiredModule(path.dirname(filePath), path.basename(filePath), laneId);
}

function bindLegacyRetiredModule(filePath, currentModule, argv = process.argv.slice(2)) {
  const mod = createLegacyRetiredModuleForFile(filePath);
  if (currentModule && require.main === currentModule) runAsMain(mod, argv);
  return mod;
}

module.exports = {
  bindLegacyRetiredModule,
  createLegacyRetiredModuleForFile,
  createLegacyRetiredModule,
  laneIdFromRuntimePath,
  normalizeLaneId,
  runAsMain
};
