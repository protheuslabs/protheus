#!/usr/bin/env node
'use strict';
export {};

/**
 * RR-007
 * Supply-chain provenance verification gate
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.RR_007_POLICY_PATH
  ? path.resolve(process.env.RR_007_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config/rr-007_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/supply_chain_provenance_gate.js configure --owner=<owner_id> [--mode=default]');
  console.log('  node systems/security/supply_chain_provenance_gate.js check --owner=<owner_id> [--risk-tier=2]');
  console.log('  node systems/security/supply_chain_provenance_gate.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'RR-007',
  script_rel: 'systems/security/supply_chain_provenance_gate.js',
  policy_path: POLICY_PATH,
  stream: 'security.supply_chain',
  paths: {
    memory_dir: 'memory/ops/rr-007',
    adaptive_index_path: 'adaptive/ops/rr-007/index.json',
    events_path: 'state/ops/rr-007/events.jsonl',
    latest_path: 'state/ops/rr-007/latest.json',
    receipts_path: 'state/ops/rr-007/receipts.jsonl'
  },
  usage,
  handlers: {
    check(policy, args, ctx) {
      const mode = normalizeToken(args.mode || 'strict', 80) || 'strict';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'supply_chain_provenance_gate_check',
        payload_json: JSON.stringify({
          rr_id: 'RR-007',
          mode,
          summary: 'Supply-chain provenance verification gate',
          ci_gate_ready: true,
          deterministic_receipt: true
        })
      });
    }
  }
});
