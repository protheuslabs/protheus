#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-146
 * solid_pod_bridge lane.
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.V3_RACE_146_POLICY_PATH
  ? path.resolve(process.env.V3_RACE_146_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'solid_pod_bridge_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/federation/solid_pod_bridge.js configure --owner=<owner_id> [--profile=default]');
  console.log('  node systems/federation/solid_pod_bridge.js execute --owner=<owner_id> [--task=default] [--risk-tier=2]');
  console.log('  node systems/federation/solid_pod_bridge.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-146',
  script_rel: 'systems/federation/solid_pod_bridge.js',
  policy_path: POLICY_PATH,
  stream: 'federation.solid_pod',
  paths: {
    memory_dir: 'memory/federation/solid',
    adaptive_index_path: 'adaptive/federation/solid/index.json',
    events_path: 'state/federation\/solid_pod/events.jsonl',
    latest_path: 'state/federation\/solid_pod/latest.json',
    receipts_path: 'state/federation\/solid_pod/receipts.jsonl'
  },
  usage,
  handlers: {
    execute(policy, args, ctx) {
      const task = normalizeToken(args.task || args.mode || 'default', 120) || 'default';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'solid_pod_bridge_execute',
        payload_json: JSON.stringify({
          lane_id: 'V3-RACE-146',
          task,
          guarded_execution: true,
          bounded_risk_tier: true,
          deterministic_receipts: true
        })
      });
    }
  }
});
