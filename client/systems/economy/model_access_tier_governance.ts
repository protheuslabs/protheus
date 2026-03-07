#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-159
 * model_access_tier_governance lane.
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.V3_RACE_159_POLICY_PATH
  ? path.resolve(process.env.V3_RACE_159_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'model_access_tier_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/economy/model_access_tier_governance.js configure --owner=<owner_id> [--profile=default]');
  console.log('  node systems/economy/model_access_tier_governance.js execute --owner=<owner_id> [--task=default] [--risk-tier=2]');
  console.log('  node systems/economy/model_access_tier_governance.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-159',
  script_rel: 'systems/economy/model_access_tier_governance.js',
  policy_path: POLICY_PATH,
  stream: 'economy.model_access_tiers',
  paths: {
    memory_dir: 'memory/economy/model_access',
    adaptive_index_path: 'adaptive/economy/model_access/index.json',
    events_path: 'state/economy\/model_access_tiers/events.jsonl',
    latest_path: 'state/economy\/model_access_tiers/latest.json',
    receipts_path: 'state/economy\/model_access_tiers/receipts.jsonl'
  },
  usage,
  handlers: {
    execute(policy, args, ctx) {
      const task = normalizeToken(args.task || args.mode || 'default', 120) || 'default';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'model_access_tier_governance_execute',
        payload_json: JSON.stringify({
          lane_id: 'V3-RACE-159',
          task,
          guarded_execution: true,
          bounded_risk_tier: true,
          deterministic_receipts: true
        })
      });
    }
  }
});
