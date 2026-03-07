#!/usr/bin/env node
'use strict';
export {};

/**
 * RR-009
 * Data retention tiering and compaction gate
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.RR_009_POLICY_PATH
  ? path.resolve(process.env.RR_009_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config/rr-009_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/data_retention_tiering.js configure --owner=<owner_id> [--mode=default]');
  console.log('  node systems/ops/data_retention_tiering.js check --owner=<owner_id> [--risk-tier=2]');
  console.log('  node systems/ops/data_retention_tiering.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'RR-009',
  script_rel: 'systems/ops/data_retention_tiering.js',
  policy_path: POLICY_PATH,
  stream: 'ops.data_retention',
  paths: {
    memory_dir: 'memory/ops/rr-009',
    adaptive_index_path: 'adaptive/ops/rr-009/index.json',
    events_path: 'state/ops/rr-009/events.jsonl',
    latest_path: 'state/ops/rr-009/latest.json',
    receipts_path: 'state/ops/rr-009/receipts.jsonl'
  },
  usage,
  handlers: {
    check(policy, args, ctx) {
      const mode = normalizeToken(args.mode || 'strict', 80) || 'strict';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'data_retention_tiering_check',
        payload_json: JSON.stringify({
          rr_id: 'RR-009',
          mode,
          summary: 'Data retention tiering and compaction gate',
          ci_gate_ready: true,
          deterministic_receipt: true
        })
      });
    }
  }
});
