#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { evaluateLocalProviderGate } = require('../routing/provider_readiness');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ROUTER_SCRIPT = process.env.REFLEX_ROUTER_SCRIPT
  ? path.resolve(process.env.REFLEX_ROUTER_SCRIPT)
  : path.join(REPO_ROOT, 'systems', 'routing', 'model_router.js');

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/reflex/reflex_worker.js once --task="..." [--intent=..] [--tokens_est=N] [--worker-id=id]');
  console.log('  node systems/reflex/reflex_worker.js --help');
}

function safeJson(stdout) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    const lines = txt.split('\n').reverse();
    for (const line of lines) {
      const s = String(line || '').trim();
      if (!s.startsWith('{')) continue;
      try { return JSON.parse(s); } catch {}
    }
    return null;
  }
}

function once(args) {
  const task = String(args.task || '').trim();
  const intent = String(args.intent || '').trim();
  const workerId = String(args['worker-id'] || args.worker_id || 'cell-1').trim();
  const tokensEst = Math.max(50, Math.min(12000, Math.round(Number(args.tokens_est || args['tokens-est'] || 220) || 220)));

  if (!task) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing_task', worker_id: workerId }) + '\n');
    process.exit(2);
  }

  const routeArgs = [
    ROUTER_SCRIPT,
    'route',
    '--risk=low',
    '--complexity=low',
    `--intent=${intent || 'reflex_task'}`,
    `--task=${task}`,
    '--mode=normal',
    '--capability=reflex_micro',
    '--role=reflex',
    '--route_class=reflex',
    `--tokens_est=${tokensEst}`
  ];
  const providerGate = evaluateLocalProviderGate('ollama/smallthinker', {
    source: 'reflex_worker'
  });
  const providerDown = providerGate.applicable === true && providerGate.available !== true;
  const childEnv = providerDown
    ? { ...process.env, ROUTER_T1_LOCAL_FIRST: '0' }
    : process.env;
  const r = spawnSync('node', routeArgs, { cwd: REPO_ROOT, encoding: 'utf8', env: childEnv });
  const decision = safeJson(r.stdout);

  process.stdout.write(JSON.stringify({
    ok: r.status === 0,
    worker_id: workerId,
    task: task.slice(0, 160),
    tokens_est: tokensEst,
    local_provider_gate: providerGate && providerGate.applicable === true
      ? {
          provider: providerGate.provider || 'ollama',
          available: providerGate.available === true,
          reason: providerGate.reason || null,
          source: providerGate.source || null,
          circuit_open: providerGate.circuit_open === true,
          circuit_open_until_ts: providerGate.circuit_open_until_ts || null
        }
      : null,
    local_provider_forced_cloud_bias: providerDown,
    route: decision,
    stderr: String(r.stderr || '').trim().slice(0, 240)
  }) + '\n');

  if (r.status !== 0) process.exit(r.status || 1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'once') return once(args);
  usage();
  process.exit(2);
}

main();
export {};
