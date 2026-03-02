#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-156
 * sovereign_model_rollout_ladder lane.
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.V3_RACE_156_POLICY_PATH
  ? path.resolve(process.env.V3_RACE_156_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'sovereign_model_rollout_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/training/sovereign_model_rollout_ladder.js configure --owner=<owner_id> [--profile=default]');
  console.log('  node systems/training/sovereign_model_rollout_ladder.js execute --owner=<owner_id> [--task=default] [--risk-tier=2]');
  console.log('  node systems/training/sovereign_model_rollout_ladder.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-156',
  script_rel: 'systems/training/sovereign_model_rollout_ladder.js',
  policy_path: POLICY_PATH,
  stream: 'training.sovereign_rollout',
  paths: {
    memory_dir: 'memory/training/rollout_preferences',
    adaptive_index_path: 'adaptive/training/rollout/index.json',
    events_path: 'state/training\/sovereign_rollout/events.jsonl',
    latest_path: 'state/training\/sovereign_rollout/latest.json',
    receipts_path: 'state/training\/sovereign_rollout/receipts.jsonl'
  },
  usage,
  handlers: {
    execute(policy, args, ctx) {
      const task = normalizeToken(args.task || args.mode || 'default', 120) || 'default';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'sovereign_model_rollout_ladder_execute',
        payload_json: JSON.stringify({
          lane_id: 'V3-RACE-156',
          task,
          guarded_execution: true,
          bounded_risk_tier: true,
          deterministic_receipts: true
        })
      });
    }
  }
});
