#!/usr/bin/env node
'use strict';
export {};

/**
 * WASI2 target adapter.
 * Produces normalized probe envelopes for JS vs WASI2 lanes.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  parseArgs,
  nowIso,
  cleanText,
  normalizeToken,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/wasi2_lane_adapter.js probe --lane=<id> --engine=js|wasi2 [--owner=<id>]');
}

function parseJson(stdout: string) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runCommand(command: string[], timeoutMs = 120000) {
  const started = Date.now();
  const run = spawnSync(command[0], command.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  return {
    ok: Number(run.status || 0) === 0,
    code: Number.isFinite(run.status) ? Number(run.status) : 1,
    payload: parseJson(String(run.stdout || '')),
    stderr: cleanText(run.stderr || '', 320),
    duration_ms: Math.max(0, Date.now() - started)
  };
}

function probeJs(lane: string) {
  const cmd = [
    'node',
    'systems/rust/control_plane_component_shim.js',
    'run',
    `--component=${lane}`,
    '--engine=js'
  ];
  const run = runCommand(cmd);
  return {
    ...run,
    normalized: {
      ok: run.ok,
      type: 'wasi2_lane_probe',
      lane,
      engine: 'js',
      contract_version: '1.0',
      health: run.ok ? 'green' : 'red',
      adapter_ref: 'systems/rust/control_plane_component_shim.js'
    }
  };
}

function probeWasi2(lane: string, owner: string) {
  const manifestHash = stableHash(`wasi2:${lane}`, 16);
  const cmd = [
    'node',
    'systems/wasm/component_runtime.js',
    'load',
    `--owner=${owner}`,
    `--module=${lane}`,
    `--manifest-hash=${manifestHash}`
  ];
  const run = runCommand(cmd);
  return {
    ...run,
    normalized: {
      ok: run.ok,
      type: 'wasi2_lane_probe',
      lane,
      engine: 'wasi2',
      contract_version: '1.0',
      health: run.ok ? 'green' : 'red',
      adapter_ref: 'systems/wasm/component_runtime.js',
      capability_manifest_id: run.payload && run.payload.payload && run.payload.payload.capability_manifest_id
        ? run.payload.payload.capability_manifest_id
        : null
    }
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'probe', 40) || 'probe';
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    return;
  }

  if (cmd !== 'probe') emit({ ok: false, error: 'unsupported_command', command: cmd }, 1);

  const lane = normalizeToken(args.lane || args.component || '', 120);
  const engine = normalizeToken(args.engine || '', 20);
  const owner = normalizeToken(args.owner || args.owner_id || 'wasi2_gate', 120) || 'wasi2_gate';
  if (!lane) emit({ ok: false, error: 'lane_required' }, 1);
  if (!engine || !['js', 'wasi2'].includes(engine)) emit({ ok: false, error: 'engine_must_be_js_or_wasi2' }, 1);

  const probe = engine === 'js' ? probeJs(lane) : probeWasi2(lane, owner);
  emit({
    ok: probe.ok,
    type: 'wasi2_lane_adapter_probe',
    ts: nowIso(),
    lane,
    engine,
    duration_ms: probe.duration_ms,
    status_code: probe.code,
    stderr: probe.stderr || null,
    payload: probe.payload,
    normalized: probe.normalized
  }, probe.ok ? 0 : 1);
}

main();
