#!/usr/bin/env node
'use strict';
export {};

/**
 * seed_boot_probe.js
 *
 * Minimal desktop-seed boot probe used by runtime efficiency gates.
 * Loads governance/value primitives and reports startup latency + rss.
 *
 * Usage:
 *   node systems/ops/seed_boot_probe.js run
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function nowIso() {
  return new Date().toISOString();
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function loadModule(absPath: string) {
  try {
    require(absPath);
    return { ok: true, path: relPath(absPath) };
  } catch (err: any) {
    return {
      ok: false,
      path: relPath(absPath),
      error: String(err && err.message ? err.message : err || 'module_load_failed').slice(0, 200)
    };
  }
}

function loadFile(absPath: string) {
  try {
    const body = fs.readFileSync(absPath, 'utf8');
    return {
      ok: true,
      path: relPath(absPath),
      bytes: Buffer.byteLength(body || '', 'utf8')
    };
  } catch (err: any) {
    return {
      ok: false,
      path: relPath(absPath),
      error: String(err && err.message ? err.message : err || 'file_load_failed').slice(0, 200)
    };
  }
}

function runProbe() {
  const t0 = process.hrtime.bigint();

  const moduleRows = [
    loadModule(path.join(ROOT, 'lib', 'trit.js')),
    loadModule(path.join(ROOT, 'lib', 'ternary_belief_engine.js')),
    loadModule(path.join(ROOT, 'lib', 'strategy_resolver.js')),
    loadModule(path.join(ROOT, 'lib', 'outcome_fitness.js'))
  ];

  const fileRows = [
    loadFile(path.join(ROOT, 'config', 'agent_routing_rules.json')),
    loadFile(path.join(ROOT, 'config', 'capability_switchboard_policy.json')),
    loadFile(path.join(ROOT, 'config', 'workflow_executor_policy.json'))
  ];

  const t1 = process.hrtime.bigint();
  const bootMs = Number(t1 - t0) / 1e6;
  const rssMb = Number((process.memoryUsage().rss / 1024 / 1024).toFixed(3));
  const modulesOk = moduleRows.every((row) => row && row.ok === true);
  const filesOk = fileRows.every((row) => row && row.ok === true);

  process.stdout.write(`${JSON.stringify({
    ok: modulesOk && filesOk,
    type: 'seed_boot_probe',
    ts: nowIso(),
    boot_ms: Number(bootMs.toFixed(3)),
    rss_mb: rssMb,
    modules_ok: modulesOk,
    files_ok: filesOk,
    modules: moduleRows,
    files: fileRows
  })}\n`);
}

function main() {
  runProbe();
}

main();
