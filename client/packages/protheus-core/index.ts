#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-169
 * Public modular API for spine/reflex/gates.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const CORE_PACKAGE_DIR = __dirname;

function runNodeScript(relScript: string, args: string[] = [], timeoutMs = 120000) {
  const script = path.join(ROOT, relScript);
  const proc = spawnSync('node', [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: Math.max(1000, Number(timeoutMs || 120000))
  });
  return {
    ok: Number(proc.status || 0) === 0,
    status: Number(proc.status || 0),
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || '')
  };
}

function spineStatus(extraArgs: string[] = []) {
  return runNodeScript('systems/spine/spine.js', ['status', ...extraArgs]);
}

function reflexStatus(extraArgs: string[] = []) {
  return runNodeScript('habits/scripts/reflex_habit_bridge.js', ['status', ...extraArgs]);
}

function gateStatus(extraArgs: string[] = []) {
  return runNodeScript('systems/security/guard.js', ['status', ...extraArgs]);
}

function toBoolOption(v: unknown, fallback = true) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function coreStatus(options: Record<string, any> = {}) {
  const includeSpine = toBoolOption(options.spine, true);
  const includeReflex = toBoolOption(options.reflex, true);
  const includeGates = toBoolOption(options.gates, true);
  const timeoutMs = Math.max(1000, Number(options.timeout_ms || options.timeoutMs || 120000));
  const out: Record<string, any> = {
    ok: true,
    starter: 'protheus-core-lite',
    flags: {
      spine: includeSpine,
      reflex: includeReflex,
      gates: includeGates
    }
  };
  if (includeSpine) out.spine = runNodeScript('systems/spine/spine.js', ['status'], timeoutMs);
  if (includeReflex) out.reflex = runNodeScript('habits/scripts/reflex_habit_bridge.js', ['status'], timeoutMs);
  if (includeGates) out.gates = runNodeScript('systems/security/guard.js', ['status'], timeoutMs);
  out.ok = ['spine', 'reflex', 'gates']
    .filter((key) => Object.prototype.hasOwnProperty.call(out, key))
    .every((key) => out[key] && out[key].ok === true);
  return out;
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
    for (const name of names) {
      stack.push(path.join(current, name));
    }
  }
  return total;
}

function coldStartContract(options: Record<string, any> = {}) {
  const packageBytes = folderSizeBytes(CORE_PACKAGE_DIR);
  const budgetMb = Number(options.max_mb || options.maxMb || 5);
  const budgetMs = Number(options.max_ms || options.maxMs || 200);
  const started = process.hrtime.bigint();
  const boot = coreStatus(options);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const out = {
    ok: boot.ok === true && (packageBytes / (1024 * 1024)) <= budgetMb && elapsedMs <= budgetMs,
    package_size_bytes: packageBytes,
    package_size_mb: Number((packageBytes / (1024 * 1024)).toFixed(6)),
    cold_start_ms: Number(elapsedMs.toFixed(3)),
    budgets: {
      max_mb: budgetMb,
      max_ms: budgetMs
    },
    boot
  };
  return out;
}

module.exports = {
  spineStatus,
  reflexStatus,
  gateStatus,
  coreStatus,
  coldStartContract
};
