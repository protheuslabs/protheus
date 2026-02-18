#!/usr/bin/env node
/**
 * route_execute.js — route_task executor with optional model routing consumption
 *
 * Purpose:
 * - Run route_task
 * - Execute suggested command when decision is executable
 * - If route.selected_model is present, inject it into execution env automatically
 *
 * Usage:
 *   node systems/routing/route_execute.js --task "..." [--tokens_est N] [--repeats_14d N] [--errors_30d N] [--skip-habit-id ID] [--dry-run]
 *
 * Notes:
 * - ROUTER_ENABLED=1 enables route_task model selection.
 * - This script does not change route_task decision logic; it only executes returned executor payload.
 */

const { spawnSync } = require('child_process');
const path = require('path');

function getArg(name, def = null) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  if (i === -1) return def;
  const v = args[i + 1];
  return (v === undefined || String(v).startsWith('--')) ? def : v;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/routing/route_execute.js --task "..." [--tokens_est N] [--repeats_14d N] [--errors_30d N] [--skip-habit-id ID] [--dry-run]');
}

function repoRoot() {
  return path.resolve(__dirname, '..', '..');
}

function runRouteTask({ task, tokensEst, repeats14d, errors30d, skipHabitId }) {
  const script = path.join(repoRoot(), 'systems', 'routing', 'route_task.js');
  const args = [
    script,
    '--task', task,
    '--tokens_est', String(tokensEst),
    '--repeats_14d', String(repeats14d),
    '--errors_30d', String(errors30d)
  ];
  if (skipHabitId) args.push('--skip_habit_id', String(skipHabitId));
  const r = spawnSync('node', args, {
    cwd: repoRoot(),
    encoding: 'utf8',
    env: process.env
  });
  return r;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function modelEnv(baseEnv, modelId) {
  if (!modelId) return baseEnv;
  return {
    ...baseEnv,
    ROUTED_MODEL: modelId,
    OPENCLAW_MODEL: modelId,
    SPAWN_MODEL: modelId,
    MODEL_OVERRIDE: modelId
  };
}

function isExecutableDecision(d) {
  return d === 'RUN_HABIT' || d === 'RUN_CANDIDATE_FOR_VERIFICATION' || d === 'PROPOSE_HABIT';
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || hasFlag('--help') || hasFlag('-h') || hasFlag('help')) {
    usage();
    process.exit(0);
  }

  const task = getArg('--task', '');
  const tokensEst = Number(getArg('--tokens_est', '0')) || 0;
  const repeats14d = Number(getArg('--repeats_14d', '0')) || 0;
  const errors30d = Number(getArg('--errors_30d', '0')) || 0;
  const skipHabitId = getArg('--skip-habit-id', '') || getArg('--skip_habit_id', '');
  const dryRun = hasFlag('--dry-run');

  if (!task) {
    usage();
    process.exit(2);
  }

  const routed = runRouteTask({ task, tokensEst, repeats14d, errors30d, skipHabitId });
  if (routed.stderr) process.stderr.write(routed.stderr);
  if (!routed.stdout) {
    console.error('route_execute: route_task returned no stdout');
    process.exit(routed.status || 1);
  }

  const out = parseJson(routed.stdout);
  if (!out) {
    console.error('route_execute: failed to parse route_task JSON output');
    process.stdout.write(routed.stdout);
    process.exit(routed.status || 1);
  }

  const selectedModel = out?.route?.selected_model || null;
  const execSpec = out.executor;
  const canExec = isExecutableDecision(out.decision) && execSpec && execSpec.cmd && Array.isArray(execSpec.args);

  const summary = {
    decision: out.decision,
    reason: out.reason,
    suggested_habit_id: out.suggested_habit_id || null,
    gate_decision: out.gate_decision || null,
    gate_risk: out.gate_risk || null,
    selected_model: selectedModel,
    executable: !!canExec,
    dry_run: !!dryRun
  };
  process.stdout.write(JSON.stringify(summary) + '\n');

  if (!canExec) {
    process.exit(routed.status || 0);
  }

  if (dryRun) {
    process.stdout.write(JSON.stringify({ exec: { cmd: execSpec.cmd, args: execSpec.args } }) + '\n');
    process.exit(0);
  }

  const env = modelEnv(process.env, selectedModel);
  const child = spawnSync(execSpec.cmd, execSpec.args, {
    cwd: repoRoot(),
    stdio: 'inherit',
    env
  });

  process.exit(child.status || 0);
}

if (require.main === module) main();
module.exports = { runRouteTask, modelEnv };
