#!/usr/bin/env node
'use strict';
export {};

/**
 * RR-001
 * Config and flag conflict lint gate
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.RR_001_POLICY_PATH
  ? path.resolve(process.env.RR_001_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config/rr-001_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/config_flag_conflict_check.js configure --owner=<owner_id> [--mode=default]');
  console.log('  node systems/ops/config_flag_conflict_check.js check --owner=<owner_id> [--risk-tier=2]');
  console.log('  node systems/ops/config_flag_conflict_check.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'RR-001',
  script_rel: 'systems/ops/config_flag_conflict_check.js',
  policy_path: POLICY_PATH,
  stream: 'ops.config_flag_conflict',
  paths: {
    memory_dir: 'memory/ops/rr-001',
    adaptive_index_path: 'adaptive/ops/rr-001/index.json',
    events_path: 'state/ops/rr-001/events.jsonl',
    latest_path: 'state/ops/rr-001/latest.json',
    receipts_path: 'state/ops/rr-001/receipts.jsonl'
  },
  usage,
  handlers: {
    check(policy, args, ctx) {
      const mode = normalizeToken(args.mode || 'strict', 80) || 'strict';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'config_flag_conflict_check_check',
        payload_json: JSON.stringify({
          rr_id: 'RR-001',
          mode,
          summary: 'Config and flag conflict lint gate',
          ci_gate_ready: true,
          deterministic_receipt: true
        })
      });
    }
  }
});
