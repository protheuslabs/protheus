#!/usr/bin/env node
'use strict';

/**
 * merge_guard.js
 *
 * Non-bypass local merge guard for required checks.
 *
 * Usage:
 *   node systems/security/merge_guard.js run [--skip-tests]
 *   node systems/security/merge_guard.js --help
 */

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/merge_guard.js run [--skip-tests]');
  console.log('  node systems/security/merge_guard.js --help');
}

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

function runCmd(name, command, args) {
  const r = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const ok = r.status === 0;
  return {
    name,
    ok,
    status: Number(r.status || 0),
    command: [command, ...args].join(' '),
    stdout: String(r.stdout || '').trim(),
    stderr: String(r.stderr || '').trim()
  };
}

function runGuard(opts = {}) {
  const options = (opts && typeof opts === 'object' ? opts : {}) as Record<string, any>;
  const checks = [];
  checks.push(runCmd('contract_check', 'node', ['systems/spine/contract_check.js']));
  checks.push(runCmd('integrity_kernel_check', 'node', ['systems/security/integrity_kernel.js', 'run']));
  checks.push(runCmd('schema_contract_check', 'node', ['systems/security/schema_contract_check.js', 'run']));
  checks.push(runCmd('adaptive_layer_guard_strict', 'node', ['systems/sensory/adaptive_layer_guard.js', 'run', '--strict']));
  checks.push(runCmd('memory_layer_guard_strict', 'node', ['systems/memory/memory_layer_guard.js', 'run', '--strict']));
  checks.push(runCmd('workspace_dump_guard_strict', 'node', ['systems/security/workspace_dump_guard.js', 'run', '--strict']));
  checks.push(runCmd('repo_hygiene_guard_strict', 'node', ['systems/security/repo_hygiene_guard.js', 'run', '--strict', '--staged']));
  checks.push(runCmd('formal_invariant_engine', 'node', ['systems/security/formal_invariant_engine.js', 'run', '--strict=1']));
  checks.push(runCmd('supply_chain_trust_plane', 'node', ['systems/security/supply_chain_trust_plane.js', 'run', '--strict=1', '--verify-only=1']));
  checks.push(runCmd('key_lifecycle_verify', 'node', ['systems/security/key_lifecycle_governor.js', 'verify', '--strict=1']));
  checks.push(runCmd('docs_coverage_gate', 'node', ['systems/ops/docs_coverage_gate.js', 'run', '--strict=1']));
  checks.push(runCmd('dr_gameday_gate', 'node', ['systems/ops/dr_gameday_gate.js', 'run', '--strict=1']));
  checks.push(runCmd('simplicity_budget_gate', 'node', ['systems/ops/simplicity_budget_gate.js', 'run', '--strict=1']));
  checks.push(runCmd('causal_temporal_graph_build', 'node', ['systems/memory/causal_temporal_graph.js', 'build', '--strict=1']));
  checks.push(runCmd('emergent_primitive_synthesis_status', 'node', ['systems/primitives/emergent_primitive_synthesis.js', 'status']));
  checks.push(runCmd('hardware_embodiment_parity', 'node', ['systems/hardware/embodiment_layer.js', 'verify-parity', '--profiles=phone,desktop,cluster', '--strict=1']));
  checks.push(runCmd('resurrection_protocol_status', 'node', ['systems/continuity/resurrection_protocol.js', 'status']));
  checks.push(runCmd('value_anchor_renewal_status', 'node', ['systems/echo/value_anchor_renewal.js', 'status']));
  checks.push(runCmd('explanation_primitive_status', 'node', ['systems/primitives/explanation_primitive.js', 'status']));
  checks.push(runCmd('delegated_authority_status', 'node', ['systems/security/delegated_authority_branching.js', 'status']));
  checks.push(runCmd('world_model_freshness_status', 'node', ['systems/assimilation/world_model_freshness.js', 'status']));
  checks.push(runCmd('continuous_chaos_resilience_status', 'node', ['systems/ops/continuous_chaos_resilience.js', 'status']));
  checks.push(runCmd('self_hosted_bootstrap_status', 'node', ['systems/ops/self_hosted_bootstrap_compiler.js', 'status']));
  checks.push(runCmd('surface_budget_controller_status', 'node', ['systems/hardware/surface_budget_controller.js', 'status']));
  checks.push(runCmd('compression_transfer_plane_status', 'node', ['systems/hardware/compression_transfer_plane.js', 'status']));
  checks.push(runCmd('phone_seed_profile_status', 'node', ['systems/ops/phone_seed_profile.js', 'status']));
  checks.push(runCmd('profile_compatibility_gate', 'node', ['systems/ops/profile_compatibility_gate.js', 'run', '--strict=1']));
  checks.push(runCmd('schema_evolution_contract', 'node', ['systems/ops/schema_evolution_contract.js', 'run', '--strict=1', '--apply=0']));
  if (!options.skipTests) {
    checks.push(runCmd('test_ci', 'npm', ['run', 'test:ci']));
  }
  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    ts: new Date().toISOString(),
    checks: checks.map((c) => ({
      name: c.name,
      ok: c.ok,
      status: c.status,
      command: c.command
    })),
    failed: failed.map((c) => ({
      name: c.name,
      status: c.status,
      stdout: c.stdout.split('\n').slice(0, 20).join('\n'),
      stderr: c.stderr.split('\n').slice(0, 20).join('\n')
    }))
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '');
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd !== 'run') {
    usage();
    process.exit(2);
  }

  const out = runGuard({ skipTests: args['skip-tests'] === true });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (!out.ok) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  runGuard
};
export {};
