#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-189 package contract.
 * Lightweight API surface for mobile edge runtime + wrappers + benchmark matrix.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const EDGE_PACKAGE_DIR = __dirname;

function runNodeScript(relScript: string, args: string[] = [], timeoutMs = 120000) {
  const script = path.join(ROOT, relScript);
  const proc = spawnSync('node', [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: Math.max(1000, Number(timeoutMs || 120000))
  });
  const stdout = String(proc.stdout || '');
  const payload = parseJson(stdout);
  return {
    ok: Number(proc.status || 0) === 0,
    status: Number(proc.status || 0),
    stdout,
    stderr: String(proc.stderr || ''),
    payload
  };
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

function toFlags(options: Record<string, any> = {}) {
  const out: string[] = [];
  for (const [k, v] of Object.entries(options || {})) {
    if (v == null) continue;
    const key = String(k).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    out.push(`--${key}=${String(v)}`);
  }
  return out;
}

function edgeRuntime(command: string, options: Record<string, any> = {}) {
  return runNodeScript('systems/edge/protheus_edge_runtime.js', [command, ...toFlags(options)]);
}

function edgeLifecycle(command: string, options: Record<string, any> = {}) {
  return runNodeScript('systems/edge/mobile_lifecycle_resilience.js', [command, ...toFlags(options)]);
}

function edgeSwarm(command: string, options: Record<string, any> = {}) {
  return runNodeScript('systems/spawn/mobile_edge_swarm_bridge.js', [command, ...toFlags(options)]);
}

function edgeWrapper(command: string, options: Record<string, any> = {}) {
  return runNodeScript('systems/ops/mobile_wrapper_distribution_pack.js', [command, ...toFlags(options)]);
}

function edgeBenchmark(command: string, options: Record<string, any> = {}) {
  return runNodeScript('systems/ops/mobile_competitive_benchmark_matrix.js', [command, ...toFlags(options)]);
}

function mobileTop(options: Record<string, any> = {}) {
  return runNodeScript('systems/edge/mobile_ops_top.js', ['status', ...toFlags(options)]);
}

function folderSizeBytes(dirPath: string) {
  if (!fs.existsSync(dirPath)) return 0;
  const stack = [dirPath];
  let total = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const stat = fs.statSync(current);
    if (stat.isFile()) {
      total += Number(stat.size || 0);
      continue;
    }
    const names = fs.readdirSync(current);
    for (const name of names) stack.push(path.join(current, name));
  }
  return total;
}

function edgeStatusBundle(options: Record<string, any> = {}) {
  return {
    ok: true,
    edge: edgeRuntime('status', options),
    lifecycle: edgeLifecycle('status', options),
    swarm: edgeSwarm('status', options),
    wrappers: edgeWrapper('status', options),
    benchmark: edgeBenchmark('status', options),
    top: mobileTop(options)
  };
}

function edgeContract(options: Record<string, any> = {}) {
  const packageBytes = folderSizeBytes(EDGE_PACKAGE_DIR);
  const budgetMb = Number(options.max_mb || options.maxMb || 5);
  const budgetMs = Number(options.max_ms || options.maxMs || 200);
  const started = process.hrtime.bigint();
  const run = edgeRuntime('status', options);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  return {
    ok: run.ok === true && (packageBytes / (1024 * 1024)) <= budgetMb && elapsedMs <= budgetMs,
    package_size_bytes: packageBytes,
    package_size_mb: Number((packageBytes / (1024 * 1024)).toFixed(6)),
    cold_start_ms: Number(elapsedMs.toFixed(3)),
    budgets: {
      max_mb: budgetMb,
      max_ms: budgetMs
    },
    run
  };
}

module.exports = {
  edgeRuntime,
  edgeLifecycle,
  edgeSwarm,
  edgeWrapper,
  edgeBenchmark,
  mobileTop,
  edgeStatusBundle,
  edgeContract
};
