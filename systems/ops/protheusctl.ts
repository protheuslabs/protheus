#!/usr/bin/env node
'use strict';
export {};

/**
 * protheusctl
 * Typed control client façade over protheus_control_plane.
 */

const path = require('path');
const { spawnSync } = require('child_process');

function usage() {
  console.log('Usage: protheusctl <command> [flags]');
  console.log('Examples:');
  console.log('  protheus status');
  console.log('  protheus health');
  console.log('  protheusctl job-submit --kind=reconcile');
  console.log('  protheusctl rsi bootstrap --owner=jay');
  console.log('  protheusctl rsi step --owner=jay --target-path=systems/strategy/strategy_learner.ts');
  console.log('  protheusctl contract-lane status --owner=jay');
  console.log('  protheusctl edge start --owner=jay --profile=mobile_seed --remote-spine=https://host');
  console.log('  protheusctl edge lifecycle run --owner=jay --battery=62 --thermal=39');
  console.log('  protheusctl edge swarm enroll --owner=jay --device-id=phone_01 --provenance-attested=1');
  console.log('  protheusctl edge wrapper build --owner=jay --target=android_termux --version=0.1.0');
  console.log('  protheusctl edge benchmark run --owner=jay --scenario=ci_mobile_android --target=android');
  console.log('  protheusctl approve --rsi --owner=jay --approver=<you>');
}

function runScript(script: string, args: string[] = []) {
  const r = spawnSync('node', [script, ...args], { encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(Number.isFinite(r.status) ? r.status : 1);
}

function parseJson(text: string) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runScriptCapture(script: string, args: string[] = []) {
  const r = spawnSync('node', [script, ...args], { encoding: 'utf8' });
  return {
    status: Number.isFinite(r.status) ? Number(r.status) : 1,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    payload: parseJson(String(r.stdout || ''))
  };
}

function hasHumanFlag(args: string[]) {
  return args.some((arg) => arg === '--human' || arg === '--human=1' || arg === '--format=human');
}

function printEdgeHuman(payload: any, scope: string) {
  if (!payload || typeof payload !== 'object') return false;
  if (scope === 'runtime' && payload.edge_session) {
    const s = payload.edge_session;
    console.log(`edge active=${s.active ? 'yes' : 'no'} owner=${s.owner_id || 'none'} profile=${s.profile || 'none'} online=${s.online ? 'yes' : 'no'}`);
    console.log(`sync=${s.last_sync_at || 'never'} rollback_count=${Number(s.rollback_count || 0)} cache_snapshots=${Number(payload.cache_snapshots || 0)}`);
    return true;
  }
  if (scope === 'lifecycle' && payload.lifecycle) {
    const s = payload.lifecycle;
    console.log(`lifecycle action=${s.action || 'unknown'} mode=${s.mode || 'unknown'} battery=${s.battery_pct != null ? s.battery_pct : 'n/a'} thermal=${s.thermal_c != null ? s.thermal_c : 'n/a'}`);
    console.log(`doze=${s.doze_mode ? 'yes' : 'no'} background_kills=${Number(s.background_kills || 0)} survives_72h=${s.survives_72h_target ? 'yes' : 'no'}`);
    return true;
  }
  if (scope === 'swarm' && typeof payload.enrolled_nodes !== 'undefined') {
    console.log(`swarm enrolled=${Number(payload.enrolled_nodes || 0)} active=${Number(payload.active_nodes || 0)} quarantined=${Number(payload.quarantined_nodes || 0)} evicted=${Number(payload.evicted_nodes || 0)}`);
    return true;
  }
  return false;
}

function routeEdge(rest: string[]) {
  const subcmd = String(rest[0] || 'status').trim().toLowerCase();
  const human = hasHumanFlag(rest);
  const stripHuman = (argv: string[]) => argv.filter((arg) => arg !== '--human' && arg !== '--human=1' && arg !== '--format=human');

  let script = path.join(__dirname, '..', 'edge', 'protheus_edge_runtime.js');
  let args = [subcmd, ...rest.slice(1)];
  let scope = 'runtime';

  if (subcmd === 'lifecycle') {
    script = path.join(__dirname, '..', 'edge', 'mobile_lifecycle_resilience.js');
    const action = String(rest[1] || 'status').trim().toLowerCase() || 'status';
    args = [action, ...rest.slice(2)];
    scope = 'lifecycle';
  } else if (subcmd === 'swarm') {
    script = path.join(__dirname, '..', 'spawn', 'mobile_edge_swarm_bridge.js');
    const action = String(rest[1] || 'status').trim().toLowerCase() || 'status';
    args = [action, ...rest.slice(2)];
    scope = 'swarm';
  } else if (subcmd === 'wrapper') {
    script = path.join(__dirname, 'mobile_wrapper_distribution_pack.js');
    const action = String(rest[1] || 'status').trim().toLowerCase() || 'status';
    args = [action, ...rest.slice(2)];
    scope = 'wrapper';
  } else if (subcmd === 'benchmark') {
    script = path.join(__dirname, 'mobile_competitive_benchmark_matrix.js');
    const action = String(rest[1] || 'status').trim().toLowerCase() || 'status';
    args = [action, ...rest.slice(2)];
    scope = 'benchmark';
  } else if (subcmd === 'top') {
    script = path.join(__dirname, '..', 'edge', 'mobile_ops_top.js');
    args = ['status', ...rest.slice(1)];
    scope = 'top';
  }

  const cleanArgs = stripHuman(args);
  if (!human) {
    runScript(script, cleanArgs);
    return;
  }
  const result = runScriptCapture(script, cleanArgs);
  if (result.stderr) process.stderr.write(result.stderr);
  const printed = printEdgeHuman(result.payload, scope);
  if (!printed && result.stdout) process.stdout.write(result.stdout);
  process.exit(result.status);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = String(argv[0] || 'status');
  const rest = argv.slice(1);
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  if (cmd === 'skills' && String(rest[0] || '') === 'discover') {
    const discoverScript = path.join(__dirname, 'protheusctl_skills_discover.js');
    runScript(discoverScript, rest.slice(1));
    return;
  }

  if (cmd === 'edge') {
    routeEdge(rest);
    return;
  }

  if (cmd === 'rsi') {
    const rsiScript = path.join(__dirname, '..', '..', 'adaptive', 'rsi', 'rsi_bootstrap.js');
    const subcmd = String(rest[0] || 'status');
    runScript(rsiScript, [subcmd, ...rest.slice(1)]);
    return;
  }

  if (cmd === 'contract-lane' && String(rest[0] || '') === 'status') {
    const rsiScript = path.join(__dirname, '..', '..', 'adaptive', 'rsi', 'rsi_bootstrap.js');
    runScript(rsiScript, ['contract-lane-status', ...rest.slice(1)]);
    return;
  }

  if (cmd === 'approve' && rest.includes('--rsi')) {
    const rsiScript = path.join(__dirname, '..', '..', 'adaptive', 'rsi', 'rsi_bootstrap.js');
    runScript(rsiScript, ['approve', ...rest.filter((arg) => arg !== '--rsi')]);
    return;
  }

  const script = path.join(__dirname, 'protheus_control_plane.js');
  runScript(script, [cmd, ...rest]);
}

main();
