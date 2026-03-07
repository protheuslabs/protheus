#!/usr/bin/env node
'use strict';
export {};

/**
 * RR-011
 * Deterministic resurrection protocol lane
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.RR_011_POLICY_PATH
  ? path.resolve(process.env.RR_011_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config/rr-011_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/resurrection_protocol.js configure --owner=<owner_id> [--mode=default]');
  console.log('  node systems/ops/resurrection_protocol.js check --owner=<owner_id> [--risk-tier=2]');
  console.log('  node systems/ops/resurrection_protocol.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'RR-011',
  script_rel: 'systems/ops/resurrection_protocol.js',
  policy_path: POLICY_PATH,
  stream: 'ops.resurrection',
  paths: {
    memory_dir: 'memory/ops/rr-011',
    adaptive_index_path: 'adaptive/ops/rr-011/index.json',
    events_path: 'state/ops/rr-011/events.jsonl',
    latest_path: 'state/ops/rr-011/latest.json',
    receipts_path: 'state/ops/rr-011/receipts.jsonl'
  },
  usage,
  handlers: {
    check(policy, args, ctx) {
      const mode = normalizeToken(args.mode || 'strict', 80) || 'strict';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'resurrection_protocol_check',
        payload_json: JSON.stringify({
          rr_id: 'RR-011',
          mode,
          summary: 'Deterministic resurrection protocol lane',
          ci_gate_ready: true,
          deterministic_receipt: true
        })
      });
    }
  }
});
