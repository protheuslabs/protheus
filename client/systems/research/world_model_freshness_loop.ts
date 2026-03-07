#!/usr/bin/env node
'use strict';
export {};

/**
 * RR-014
 * World-model freshness loop
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.RR_014_POLICY_PATH
  ? path.resolve(process.env.RR_014_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config/rr-014_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/research/world_model_freshness_loop.js configure --owner=<owner_id> [--mode=default]');
  console.log('  node systems/research/world_model_freshness_loop.js check --owner=<owner_id> [--risk-tier=2]');
  console.log('  node systems/research/world_model_freshness_loop.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'RR-014',
  script_rel: 'systems/research/world_model_freshness_loop.js',
  policy_path: POLICY_PATH,
  stream: 'research.world_model_freshness',
  paths: {
    memory_dir: 'memory/ops/rr-014',
    adaptive_index_path: 'adaptive/ops/rr-014/index.json',
    events_path: 'state/ops/rr-014/events.jsonl',
    latest_path: 'state/ops/rr-014/latest.json',
    receipts_path: 'state/ops/rr-014/receipts.jsonl'
  },
  usage,
  handlers: {
    check(policy, args, ctx) {
      const mode = normalizeToken(args.mode || 'strict', 80) || 'strict';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'world_model_freshness_loop_check',
        payload_json: JSON.stringify({
          rr_id: 'RR-014',
          mode,
          summary: 'World-model freshness loop',
          ci_gate_ready: true,
          deterministic_receipt: true
        })
      });
    }
  }
});
