#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  nowIso,
  parseArgs,
  toBool,
  cleanText,
  writeJsonAtomic,
  appendJsonl,
  emit,
  resolvePath
} = require('../../lib/queued_backlog_runtime');

function usage() {
  console.log('Usage:');
  console.log('  node client/systems/ops/runtime_state_surface_guard.js check [--strict=1|0]');
  console.log('  node client/systems/ops/runtime_state_surface_guard.js status');
}

function defaultPolicy() {
  return {
    version: '1.0',
    strict_default: true,
    expected_links: [
      { path: 'client/state', target: 'local/state' },
      { path: 'state', target: 'client/local/state' }
    ],
    outputs: {
      latest_path: 'client/local/state/ops/runtime_state_surface_guard/latest.json',
      receipts_path: 'client/local/state/ops/runtime_state_surface_guard/receipts.jsonl'
    }
  };
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function trackedPaths(prefix: string) {
  const run = spawnSync('git', ['ls-files', '--', prefix], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (run.status !== 0) return [];
  return String(run.stdout || '')
    .split('\n')
    .map((row) => cleanText(row, 520).replace(/\\/g, '/'))
    .filter(Boolean);
}

function linkCheck(relPath: string, expectedTarget: string) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) {
    return { path: relPath, ok: false, reason: 'missing' };
  }
  let stat: any = null;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return { path: relPath, ok: false, reason: 'stat_failed' };
  }
  if (!stat.isSymbolicLink()) {
    return { path: relPath, ok: false, reason: 'not_symlink' };
  }
  let actualTarget = '';
  try {
    actualTarget = fs.readlinkSync(abs);
  } catch {
    return { path: relPath, ok: false, reason: 'readlink_failed' };
  }
  const actualResolved = path.resolve(path.dirname(abs), actualTarget);
  const expectedResolved = path.resolve(path.dirname(abs), expectedTarget);
  if (actualResolved !== expectedResolved) {
    return {
      path: relPath,
      ok: false,
      reason: 'target_mismatch',
      actual_target: actualTarget,
      expected_target: expectedTarget
    };
  }
  return {
    path: relPath,
    ok: true,
    target: expectedTarget,
    resolved_target: rel(actualResolved)
  };
}

function runCheck(strict: boolean) {
  const policy = defaultPolicy();
  const linkResults = policy.expected_links.map((row) => linkCheck(row.path, row.target));
  const trackedClientState = trackedPaths('client/state');
  const trackedRootState = trackedPaths('state');

  const illegalTrackedClientState = trackedClientState
    .filter((row) => row !== 'client/state');
  const illegalTrackedRootState = trackedRootState
    .filter((row) => row !== 'state');

  const checks = {
    client_state_symlink: linkResults.find((row) => row.path === 'client/state')?.ok === true,
    root_state_symlink: linkResults.find((row) => row.path === 'state')?.ok === true,
    no_tracked_runtime_under_client_state: illegalTrackedClientState.length === 0,
    no_tracked_runtime_under_root_state: illegalTrackedRootState.length === 0
  };

  const blocking = Object.entries(checks)
    .filter(([, ok]) => ok !== true)
    .map(([name]) => name);

  const pass = blocking.length === 0;
  const out = {
    ok: strict ? pass : true,
    pass,
    strict,
    type: 'runtime_state_surface_guard',
    ts: nowIso(),
    checks,
    blocking_checks: blocking,
    link_results: linkResults,
    tracked: {
      client_state: trackedClientState,
      root_state: trackedRootState,
      illegal_client_state_entries: illegalTrackedClientState,
      illegal_root_state_entries: illegalTrackedRootState
    }
  };
  const latestPath = resolvePath(policy.outputs.latest_path, policy.outputs.latest_path);
  const receiptsPath = resolvePath(policy.outputs.receipts_path, policy.outputs.receipts_path);
  writeJsonAtomic(latestPath, out);
  appendJsonl(receiptsPath, out);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'check', 40).toLowerCase();
  if (args.help || cmd === '--help' || cmd === 'help' || cmd === '-h') {
    usage();
    return emit({ ok: true, help: true }, 0);
  }
  if (cmd === 'status') {
    const policy = defaultPolicy();
    const latestPath = resolvePath(policy.outputs.latest_path, policy.outputs.latest_path);
    let latest = null;
    try {
      latest = fs.existsSync(latestPath) ? JSON.parse(fs.readFileSync(latestPath, 'utf8')) : null;
    } catch {
      latest = null;
    }
    return emit({
      ok: true,
      type: 'runtime_state_surface_guard_status',
      ts: nowIso(),
      latest
    }, 0);
  }
  if (cmd !== 'check') {
    usage();
    return emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
  }
  const strict = toBool(args.strict, defaultPolicy().strict_default);
  const out = runCheck(strict);
  return emit(out, out.ok ? 0 : 1);
}

main();

