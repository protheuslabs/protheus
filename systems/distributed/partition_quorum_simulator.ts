#!/usr/bin/env node
'use strict';
export {};

/**
 * RR-008
 * Partition quorum simulation lane
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.RR_008_POLICY_PATH
  ? path.resolve(process.env.RR_008_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config/rr-008_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/distributed/partition_quorum_simulator.js configure --owner=<owner_id> [--mode=default]');
  console.log('  node systems/distributed/partition_quorum_simulator.js check --owner=<owner_id> [--risk-tier=2]');
  console.log('  node systems/distributed/partition_quorum_simulator.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'RR-008',
  script_rel: 'systems/distributed/partition_quorum_simulator.js',
  policy_path: POLICY_PATH,
  stream: 'distributed.partition_quorum',
  paths: {
    memory_dir: 'memory/ops/rr-008',
    adaptive_index_path: 'adaptive/ops/rr-008/index.json',
    events_path: 'state/ops/rr-008/events.jsonl',
    latest_path: 'state/ops/rr-008/latest.json',
    receipts_path: 'state/ops/rr-008/receipts.jsonl'
  },
  usage,
  handlers: {
    check(policy, args, ctx) {
      const mode = normalizeToken(args.mode || 'strict', 80) || 'strict';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'partition_quorum_simulator_check',
        payload_json: JSON.stringify({
          rr_id: 'RR-008',
          mode,
          summary: 'Partition quorum simulation lane',
          ci_gate_ready: true,
          deterministic_receipt: true
        })
      });
    }
  }
});
