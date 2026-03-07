#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-158
 * training_contributor_incentive_engine lane.
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.V3_RACE_158_POLICY_PATH
  ? path.resolve(process.env.V3_RACE_158_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'training_contributor_incentive_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/economy/training_contributor_incentive_engine.js configure --owner=<owner_id> [--profile=default]');
  console.log('  node systems/economy/training_contributor_incentive_engine.js execute --owner=<owner_id> [--task=default] [--risk-tier=2]');
  console.log('  node systems/economy/training_contributor_incentive_engine.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-158',
  script_rel: 'systems/economy/training_contributor_incentive_engine.js',
  policy_path: POLICY_PATH,
  stream: 'economy.training_incentives',
  paths: {
    memory_dir: 'memory/economy/training_rewards',
    adaptive_index_path: 'adaptive/economy/training_rewards/index.json',
    events_path: 'state/economy\/training_incentives/events.jsonl',
    latest_path: 'state/economy\/training_incentives/latest.json',
    receipts_path: 'state/economy\/training_incentives/receipts.jsonl'
  },
  usage,
  handlers: {
    execute(policy, args, ctx) {
      const task = normalizeToken(args.task || args.mode || 'default', 120) || 'default';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'training_contributor_incentive_engine_execute',
        payload_json: JSON.stringify({
          lane_id: 'V3-RACE-158',
          task,
          guarded_execution: true,
          bounded_risk_tier: true,
          deterministic_receipts: true
        })
      });
    }
  }
});
