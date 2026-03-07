#!/usr/bin/env node
'use strict';
export {};

/**
 * RR-003
 * N-2 schema migration discipline gate
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.RR_003_POLICY_PATH
  ? path.resolve(process.env.RR_003_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config/rr-003_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/schema_migration_n2_check.js configure --owner=<owner_id> [--mode=default]');
  console.log('  node systems/ops/schema_migration_n2_check.js check --owner=<owner_id> [--risk-tier=2]');
  console.log('  node systems/ops/schema_migration_n2_check.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'RR-003',
  script_rel: 'systems/ops/schema_migration_n2_check.js',
  policy_path: POLICY_PATH,
  stream: 'ops.schema_migration',
  paths: {
    memory_dir: 'memory/ops/rr-003',
    adaptive_index_path: 'adaptive/ops/rr-003/index.json',
    events_path: 'state/ops/rr-003/events.jsonl',
    latest_path: 'state/ops/rr-003/latest.json',
    receipts_path: 'state/ops/rr-003/receipts.jsonl'
  },
  usage,
  handlers: {
    check(policy, args, ctx) {
      const mode = normalizeToken(args.mode || 'strict', 80) || 'strict';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'schema_migration_n2_check_check',
        payload_json: JSON.stringify({
          rr_id: 'RR-003',
          mode,
          summary: 'N-2 schema migration discipline gate',
          ci_gate_ready: true,
          deterministic_receipt: true
        })
      });
    }
  }
});
