#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-154
 * training_contribution_contracts lane.
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.V3_RACE_154_POLICY_PATH
  ? path.resolve(process.env.V3_RACE_154_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'training_contribution_contract_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/training/training_contribution_contracts.js configure --owner=<owner_id> [--profile=default]');
  console.log('  node systems/training/training_contribution_contracts.js execute --owner=<owner_id> [--task=default] [--risk-tier=2]');
  console.log('  node systems/training/training_contribution_contracts.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-154',
  script_rel: 'systems/training/training_contribution_contracts.js',
  policy_path: POLICY_PATH,
  stream: 'training.contribution_contracts',
  paths: {
    memory_dir: 'memory/training/contracts',
    adaptive_index_path: 'adaptive/training/contracts/index.json',
    events_path: 'state/training\/contribution_contracts/events.jsonl',
    latest_path: 'state/training\/contribution_contracts/latest.json',
    receipts_path: 'state/training\/contribution_contracts/receipts.jsonl'
  },
  usage,
  handlers: {
    execute(policy, args, ctx) {
      const task = normalizeToken(args.task || args.mode || 'default', 120) || 'default';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'training_contribution_contracts_execute',
        payload_json: JSON.stringify({
          lane_id: 'V3-RACE-154',
          task,
          guarded_execution: true,
          bounded_risk_tier: true,
          deterministic_receipts: true
        })
      });
    }
  }
});
