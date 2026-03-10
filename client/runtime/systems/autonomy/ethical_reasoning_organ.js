#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer2/autonomy + core/layer0/ops::autonomy-controller (authoritative)
const { createOpsLaneBridge } = require('../../lib/rust_lane_bridge');

process.env.PROTHEUS_CONDUIT_STARTUP_PROBE = '0';
process.env.PROTHEUS_CONDUIT_COMPAT_FALLBACK = '0';
process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS =
  process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS || '20000';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS =
  process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '25000';

const bridge = createOpsLaneBridge(__dirname, 'ethical_reasoning_organ', 'autonomy-controller');

function cleanText(v, maxLen = 320) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv) {
  const out = { _: [] };
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

function parsePayloadFromOutput(out, type = 'ethical_reasoning_run') {
  if (out && out.payload && typeof out.payload === 'object') return out.payload;
  const lines = String(out && out.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  return {
    ok: false,
    type,
    error: 'core_lane_no_payload',
    stderr: cleanText(out && out.stderr, 220)
  };
}

function runEthicalReasoning(input = {}, opts = {}) {
  const payload = input && typeof input === 'object' ? input : {};
  const args = [
    'ethical-reasoning',
    'run',
    `--input-base64=${Buffer.from(JSON.stringify(payload)).toString('base64')}`
  ];
  if (opts.policyPath || opts.policy_path) args.push(`--policy=${String(opts.policyPath || opts.policy_path)}`);
  if (opts.stateDir || opts.state_dir) args.push(`--state-dir=${String(opts.stateDir || opts.state_dir)}`);
  if (opts.persist === false) args.push('--persist=0');

  const out = bridge.run(args);
  return parsePayloadFromOutput(out, 'ethical_reasoning_run');
}

function getEthicalReasoningStatus(opts = {}) {
  const args = ['ethical-reasoning', 'status'];
  if (opts.policyPath || opts.policy_path) args.push(`--policy=${String(opts.policyPath || opts.policy_path)}`);
  if (opts.stateDir || opts.state_dir) args.push(`--state-dir=${String(opts.stateDir || opts.state_dir)}`);
  const out = bridge.run(args);
  return parsePayloadFromOutput(out, 'ethical_reasoning_status');
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/ethical_reasoning_organ.js run [--objective-id=<id>] [--maturity-score=0..1] [--policy=<path>] [--state-dir=<path>]');
  console.log('  node systems/autonomy/ethical_reasoning_organ.js status [--policy=<path>] [--state-dir=<path>]');
}

function cmdRun(args) {
  const out = runEthicalReasoning({
    ts: new Date().toISOString(),
    run_id: args['run-id'] || args.run_id || null,
    objective_id: args['objective-id'] || args.objective_id || null,
    maturity_score: Number.isFinite(Number(args['maturity-score'] || args.maturity_score))
      ? Number(args['maturity-score'] || args.maturity_score)
      : 0.5
  }, {
    policyPath: args.policy,
    stateDir: args['state-dir'] || args.state_dir,
    persist: args.persist == null ? true : toBool(args.persist, true)
  });
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exit(1);
}

function cmdStatus(args) {
  const out = getEthicalReasoningStatus({
    policyPath: args.policy,
    stateDir: args['state-dir'] || args.state_dir
  });
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'status', 40).toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  runEthicalReasoning,
  getEthicalReasoningStatus
};
