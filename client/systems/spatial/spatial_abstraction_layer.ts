#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-150
 * spatial_abstraction_layer lane.
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.V3_RACE_150_POLICY_PATH
  ? path.resolve(process.env.V3_RACE_150_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'spatial_abstraction_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/spatial/spatial_abstraction_layer.js configure --owner=<owner_id> [--profile=default]');
  console.log('  node systems/spatial/spatial_abstraction_layer.js execute --owner=<owner_id> [--task=default] [--risk-tier=2]');
  console.log('  node systems/spatial/spatial_abstraction_layer.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-150',
  script_rel: 'systems/spatial/spatial_abstraction_layer.js',
  policy_path: POLICY_PATH,
  stream: 'spatial.abstraction',
  paths: {
    memory_dir: 'memory/spatial',
    adaptive_index_path: 'adaptive/spatial/index.json',
    events_path: 'state/spatial\/abstraction/events.jsonl',
    latest_path: 'state/spatial\/abstraction/latest.json',
    receipts_path: 'state/spatial\/abstraction/receipts.jsonl'
  },
  usage,
  handlers: {
    execute(policy, args, ctx) {
      const task = normalizeToken(args.task || args.mode || 'default', 120) || 'default';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'spatial_abstraction_layer_execute',
        payload_json: JSON.stringify({
          lane_id: 'V3-RACE-150',
          task,
          guarded_execution: true,
          bounded_risk_tier: true,
          deterministic_receipts: true
        })
      });
    }
  }
});
