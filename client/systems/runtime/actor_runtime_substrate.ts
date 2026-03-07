#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-145
 * actor_runtime_substrate lane.
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.V3_RACE_145_POLICY_PATH
  ? path.resolve(process.env.V3_RACE_145_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'actor_runtime_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/runtime/actor_runtime_substrate.js configure --owner=<owner_id> [--profile=default]');
  console.log('  node systems/runtime/actor_runtime_substrate.js execute --owner=<owner_id> [--task=default] [--risk-tier=2]');
  console.log('  node systems/runtime/actor_runtime_substrate.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-145',
  script_rel: 'systems/runtime/actor_runtime_substrate.js',
  policy_path: POLICY_PATH,
  stream: 'runtime.actor_substrate',
  paths: {
    memory_dir: 'memory/runtime/actors',
    adaptive_index_path: 'adaptive/runtime/actors/index.json',
    events_path: 'state/runtime\/actor_substrate/events.jsonl',
    latest_path: 'state/runtime\/actor_substrate/latest.json',
    receipts_path: 'state/runtime\/actor_substrate/receipts.jsonl'
  },
  usage,
  handlers: {
    execute(policy, args, ctx) {
      const task = normalizeToken(args.task || args.mode || 'default', 120) || 'default';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'actor_runtime_substrate_execute',
        payload_json: JSON.stringify({
          lane_id: 'V3-RACE-145',
          task,
          guarded_execution: true,
          bounded_risk_tier: true,
          deterministic_receipts: true
        })
      });
    }
  }
});
