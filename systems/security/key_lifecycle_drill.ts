#!/usr/bin/env node
'use strict';
export {};

/**
 * RR-006
 * Key rotate/revoke/recover drill lane
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.RR_006_POLICY_PATH
  ? path.resolve(process.env.RR_006_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config/rr-006_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/key_lifecycle_drill.js configure --owner=<owner_id> [--mode=default]');
  console.log('  node systems/security/key_lifecycle_drill.js check --owner=<owner_id> [--risk-tier=2]');
  console.log('  node systems/security/key_lifecycle_drill.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'RR-006',
  script_rel: 'systems/security/key_lifecycle_drill.js',
  policy_path: POLICY_PATH,
  stream: 'security.key_lifecycle',
  paths: {
    memory_dir: 'memory/ops/rr-006',
    adaptive_index_path: 'adaptive/ops/rr-006/index.json',
    events_path: 'state/ops/rr-006/events.jsonl',
    latest_path: 'state/ops/rr-006/latest.json',
    receipts_path: 'state/ops/rr-006/receipts.jsonl'
  },
  usage,
  handlers: {
    check(policy, args, ctx) {
      const mode = normalizeToken(args.mode || 'strict', 80) || 'strict';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'key_lifecycle_drill_check',
        payload_json: JSON.stringify({
          rr_id: 'RR-006',
          mode,
          summary: 'Key rotate/revoke/recover drill lane',
          ci_gate_ready: true,
          deterministic_receipt: true
        })
      });
    }
  }
});
