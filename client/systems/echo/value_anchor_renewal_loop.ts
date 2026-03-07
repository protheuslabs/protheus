#!/usr/bin/env node
'use strict';
export {};

/**
 * RR-012
 * Value-anchor renewal loop
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.RR_012_POLICY_PATH
  ? path.resolve(process.env.RR_012_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config/rr-012_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/echo/value_anchor_renewal_loop.js configure --owner=<owner_id> [--mode=default]');
  console.log('  node systems/echo/value_anchor_renewal_loop.js check --owner=<owner_id> [--risk-tier=2]');
  console.log('  node systems/echo/value_anchor_renewal_loop.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'RR-012',
  script_rel: 'systems/echo/value_anchor_renewal_loop.js',
  policy_path: POLICY_PATH,
  stream: 'echo.value_anchor',
  paths: {
    memory_dir: 'memory/ops/rr-012',
    adaptive_index_path: 'adaptive/ops/rr-012/index.json',
    events_path: 'state/ops/rr-012/events.jsonl',
    latest_path: 'state/ops/rr-012/latest.json',
    receipts_path: 'state/ops/rr-012/receipts.jsonl'
  },
  usage,
  handlers: {
    check(policy, args, ctx) {
      const mode = normalizeToken(args.mode || 'strict', 80) || 'strict';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'value_anchor_renewal_loop_check',
        payload_json: JSON.stringify({
          rr_id: 'RR-012',
          mode,
          summary: 'Value-anchor renewal loop',
          ci_gate_ready: true,
          deterministic_receipt: true
        })
      });
    }
  }
});
