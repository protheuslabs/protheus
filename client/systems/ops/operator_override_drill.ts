#!/usr/bin/env node
'use strict';
export {};

/**
 * RR-010
 * Operator override ergonomics drill
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.RR_010_POLICY_PATH
  ? path.resolve(process.env.RR_010_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config/rr-010_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/operator_override_drill.js configure --owner=<owner_id> [--mode=default]');
  console.log('  node systems/ops/operator_override_drill.js check --owner=<owner_id> [--risk-tier=2]');
  console.log('  node systems/ops/operator_override_drill.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'RR-010',
  script_rel: 'systems/ops/operator_override_drill.js',
  policy_path: POLICY_PATH,
  stream: 'ops.operator_override',
  paths: {
    memory_dir: 'memory/ops/rr-010',
    adaptive_index_path: 'adaptive/ops/rr-010/index.json',
    events_path: 'state/ops/rr-010/events.jsonl',
    latest_path: 'state/ops/rr-010/latest.json',
    receipts_path: 'state/ops/rr-010/receipts.jsonl'
  },
  usage,
  handlers: {
    check(policy, args, ctx) {
      const mode = normalizeToken(args.mode || 'strict', 80) || 'strict';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'operator_override_drill_check',
        payload_json: JSON.stringify({
          rr_id: 'RR-010',
          mode,
          summary: 'Operator override ergonomics drill',
          ci_gate_ready: true,
          deterministic_receipt: true
        })
      });
    }
  }
});
