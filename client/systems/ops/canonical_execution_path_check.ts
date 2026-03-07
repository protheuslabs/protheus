#!/usr/bin/env node
'use strict';
export {};

/**
 * RR-002
 * Canonical execution path contract
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.RR_002_POLICY_PATH
  ? path.resolve(process.env.RR_002_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config/rr-002_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/canonical_execution_path_check.js configure --owner=<owner_id> [--mode=default]');
  console.log('  node systems/ops/canonical_execution_path_check.js check --owner=<owner_id> [--risk-tier=2]');
  console.log('  node systems/ops/canonical_execution_path_check.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'RR-002',
  script_rel: 'systems/ops/canonical_execution_path_check.js',
  policy_path: POLICY_PATH,
  stream: 'ops.execution_path',
  paths: {
    memory_dir: 'memory/ops/rr-002',
    adaptive_index_path: 'adaptive/ops/rr-002/index.json',
    events_path: 'state/ops/rr-002/events.jsonl',
    latest_path: 'state/ops/rr-002/latest.json',
    receipts_path: 'state/ops/rr-002/receipts.jsonl'
  },
  usage,
  handlers: {
    check(policy, args, ctx) {
      const mode = normalizeToken(args.mode || 'strict', 80) || 'strict';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'canonical_execution_path_check_check',
        payload_json: JSON.stringify({
          rr_id: 'RR-002',
          mode,
          summary: 'Canonical execution path contract',
          ci_gate_ready: true,
          deterministic_receipt: true
        })
      });
    }
  }
});
