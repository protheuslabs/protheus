#!/usr/bin/env node
'use strict';
export {};

/**
 * symbiosis_coherence_gate.js
 *
 * Computes real-time symbiosis coherence and recursion-depth gate posture.
 *
 * Usage:
 *   node systems/symbiosis/symbiosis_coherence_gate.js evaluate [--policy=/abs/path.json] [--persist=1|0]
 *   node systems/symbiosis/symbiosis_coherence_gate.js status [--policy=/abs/path.json] [--refresh=1|0]
 */

const path = require('path');
const {
  loadSymbiosisCoherencePolicy,
  evaluateSymbiosisCoherenceSignal,
  loadSymbiosisCoherenceSignal
} = require('../../lib/symbiosis_coherence_signal');

type AnyObj = Record<string, any>;

const DEFAULT_POLICY_PATH = process.env.SYMBIOSIS_COHERENCE_POLICY_PATH
  ? path.resolve(process.env.SYMBIOSIS_COHERENCE_POLICY_PATH)
  : path.join(path.resolve(__dirname, '..', '..'), 'config', 'symbiosis_coherence_policy.json');

function normalizeToken(v: unknown, maxLen = 120) {
  return String(v == null ? '' : v)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/symbiosis/symbiosis_coherence_gate.js evaluate [--policy=/abs/path.json] [--persist=1|0]');
  console.log('  node systems/symbiosis/symbiosis_coherence_gate.js status [--policy=/abs/path.json] [--refresh=1|0]');
}

function cmdEvaluate(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadSymbiosisCoherencePolicy(policyPath);
  const out = evaluateSymbiosisCoherenceSignal({
    policy,
    persist: toBool(args.persist, true)
  });
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out && out.ok === false) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadSymbiosisCoherencePolicy(policyPath);
  const out = loadSymbiosisCoherenceSignal({
    policy,
    refresh: toBool(args.refresh, false),
    persist: toBool(args.persist, true)
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'symbiosis_coherence_status',
    ts: out.ts || null,
    policy_version: policy.version,
    policy_path: policy.policy_path,
    shadow_only: out.shadow_only === true,
    coherence_score: out.coherence_score != null ? Number(out.coherence_score) : null,
    coherence_tier: out.coherence_tier || null,
    recursion_gate: out.recursion_gate || null,
    component_scores: out.component_scores || null,
    source_paths: out.source_paths || null,
    latest_path: out.latest_path_rel || null
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
    return;
  }
  if (cmd === 'evaluate') return cmdEvaluate(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  cmdEvaluate,
  cmdStatus
};
