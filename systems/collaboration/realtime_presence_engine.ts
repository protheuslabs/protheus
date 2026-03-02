#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-149
 * realtime_presence_engine lane.
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.V3_RACE_149_POLICY_PATH
  ? path.resolve(process.env.V3_RACE_149_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'realtime_presence_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/collaboration/realtime_presence_engine.js configure --owner=<owner_id> [--profile=default]');
  console.log('  node systems/collaboration/realtime_presence_engine.js execute --owner=<owner_id> [--task=default] [--risk-tier=2]');
  console.log('  node systems/collaboration/realtime_presence_engine.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-149',
  script_rel: 'systems/collaboration/realtime_presence_engine.js',
  policy_path: POLICY_PATH,
  stream: 'collaboration.realtime_presence',
  paths: {
    memory_dir: 'memory/collaboration',
    adaptive_index_path: 'adaptive/collaboration/index.json',
    events_path: 'state/collaboration\/realtime_presence/events.jsonl',
    latest_path: 'state/collaboration\/realtime_presence/latest.json',
    receipts_path: 'state/collaboration\/realtime_presence/receipts.jsonl'
  },
  usage,
  handlers: {
    execute(policy, args, ctx) {
      const task = normalizeToken(args.task || args.mode || 'default', 120) || 'default';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'realtime_presence_engine_execute',
        payload_json: JSON.stringify({
          lane_id: 'V3-RACE-149',
          task,
          guarded_execution: true,
          bounded_risk_tier: true,
          deterministic_receipts: true
        })
      });
    }
  }
});
